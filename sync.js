// GRM Pipeline date sync — runs on a schedule via GitHub Actions.
// Finds every Pipeline row with a linked project board, reads the current
// Project Enquiry / Stage 4 Handover to GRM dates, and writes them into
// the Pipeline's Start Date / End Date columns if they've changed.

const TOKEN = process.env.MONDAY_TOKEN;
const PIPELINE_BOARD_ID = 18419311248;
const PROJECT_BOARD_LINK_COL = "link_mm5j5v2k";
const START_DATE_COL = "date_mm5nbqe9";
const END_DATE_COL = "date_mm5n5v74";

async function mondayCall(query, variables) {
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': TOKEN },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function main() {
  if (!TOKEN) throw new Error('MONDAY_TOKEN secret is not set');

  console.log('Fetching Pipeline items...');
  const pipelineData = await mondayCall(`
    query($boardId: ID!) {
      boards(ids: [$boardId]) {
        items_page(limit: 100) {
          items {
            id
            name
            column_values(ids: ["${PROJECT_BOARD_LINK_COL}", "${START_DATE_COL}", "${END_DATE_COL}"]) { id text }
          }
        }
      }
    }`, { boardId: PIPELINE_BOARD_ID });

  const items = pipelineData.boards[0].items_page.items;
  let syncedCount = 0;

  for (const item of items) {
    const linkVal = item.column_values.find(c => c.id === PROJECT_BOARD_LINK_COL);
    const linkText = linkVal && linkVal.text;
    const match = linkText && linkText.match(/boards\/(\d+)/);
    if (!match) continue;
    const targetBoardId = match[1];

    try {
      const colData = await mondayCall(`{ boards(ids: [${targetBoardId}]) { columns { id type } } }`);
      const board = colData.boards[0];
      if (!board) continue;
      const tlCol = board.columns.find(c => c.type === 'timeline');
      if (!tlCol) continue;

      const itemsData = await mondayCall(`{ boards(ids: [${targetBoardId}]) { items_page(limit: 500) { items { name column_values(ids: ["${tlCol.id}"]) { text } } } } }`);
      const targetItems = itemsData.boards[0].items_page.items;
      const enquiry = targetItems.find(i => i.name === 'Project Enquiry');
      const handover = targetItems.find(i => i.name === 'Stage 4 Handover to GRM');

      const newStart = enquiry && enquiry.column_values[0] && enquiry.column_values[0].text
        ? enquiry.column_values[0].text.split(' - ')[0] : null;
      const newEnd = handover && handover.column_values[0] && handover.column_values[0].text
        ? handover.column_values[0].text.split(' - ')[1] : null;

      const currentStart = (item.column_values.find(c => c.id === START_DATE_COL) || {}).text;
      const currentEnd = (item.column_values.find(c => c.id === END_DATE_COL) || {}).text;

      if (newStart && newStart !== currentStart) {
        await mondayCall(`
          mutation($val: JSON!) {
            change_column_value(board_id: ${PIPELINE_BOARD_ID}, item_id: ${item.id}, column_id: "${START_DATE_COL}", value: $val) { id }
          }`, { val: JSON.stringify({ date: newStart }) });
        console.log(`  Updated Start Date for "${item.name}": ${currentStart} -> ${newStart}`);
        syncedCount++;
      }

      if (newEnd && newEnd !== currentEnd) {
        await mondayCall(`
          mutation($val: JSON!) {
            change_column_value(board_id: ${PIPELINE_BOARD_ID}, item_id: ${item.id}, column_id: "${END_DATE_COL}", value: $val) { id }
          }`, { val: JSON.stringify({ date: newEnd }) });
        console.log(`  Updated End Date for "${item.name}": ${currentEnd} -> ${newEnd}`);
        syncedCount++;
      }
    } catch (e) {
      console.warn(`  Skipped "${item.name}" due to error: ${e.message}`);
    }
  }

  console.log(`Done. ${syncedCount} field(s) updated.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
