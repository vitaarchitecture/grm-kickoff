// GRM Pipeline date sync — runs on a schedule via GitHub Actions.
// Finds every Pipeline row with a linked project board, reads the current
// Project Enquiry / Stage 4 Handover to GRM dates, and writes them into
// the Pipeline's Start Date / End Date columns if they've changed.
//
// It also mirrors that range into the "Project Duration" timeline column,
// which is what the Project Timeline Gantt view plots — monday's Gantt needs
// a single timeline column and cannot read the two separate date columns.
// That column is resolved by title at runtime rather than hard-coded: it has
// been deleted and recreated before (which changes its id), and a stale
// hard-coded id would silently empty the Gantt again.

const TOKEN = process.env.MONDAY_TOKEN;
const PIPELINE_BOARD_ID = 18419311248;
const PROJECT_BOARD_LINK_COL = "link_mm5j5v2k";
const START_DATE_COL = "date_mm5nbqe9";
const END_DATE_COL = "date_mm5n5v74";
const DURATION_COL_TITLE = "Project Duration";

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

  // Locate the Gantt's timeline column: prefer the titled one, else fall back
  // to the board's only timeline column.
  const pipelineCols = await mondayCall(
    `query($boardId: ID!) { boards(ids: [$boardId]) { columns { id title type } } }`,
    { boardId: PIPELINE_BOARD_ID });
  const timelineCols = pipelineCols.boards[0].columns.filter(c => c.type === 'timeline');
  const durationCol = timelineCols.find(c => c.title === DURATION_COL_TITLE)
    || (timelineCols.length === 1 ? timelineCols[0] : null);

  if (!durationCol) {
    console.warn(`WARNING: no "${DURATION_COL_TITLE}" timeline column on the Pipeline board ` +
      `(found ${timelineCols.length} timeline column(s)). The Gantt view will stay empty. ` +
      `Recreate it and this job will start filling it again.`);
  } else {
    console.log(`Gantt timeline column: "${durationCol.title}" (${durationCol.id})`);
  }

  const wantedCols = [PROJECT_BOARD_LINK_COL, START_DATE_COL, END_DATE_COL]
    .concat(durationCol ? [durationCol.id] : []);

  console.log('Fetching Pipeline items...');
  const pipelineData = await mondayCall(`
    query($boardId: ID!) {
      boards(ids: [$boardId]) {
        items_page(limit: 100) {
          items {
            id
            name
            column_values(ids: [${wantedCols.map(c => `"${c}"`).join(', ')}]) { id text }
          }
        }
      }
    }`, { boardId: PIPELINE_BOARD_ID });

  const items = pipelineData.boards[0].items_page.items;
  let syncedCount = 0;

  for (const item of items) {
    const currentStart = (item.column_values.find(c => c.id === START_DATE_COL) || {}).text;
    const currentEnd = (item.column_values.find(c => c.id === END_DATE_COL) || {}).text;
    // The range we end up with: freshly synced where available, else whatever
    // is already on the row (e.g. dates typed in by hand).
    let effStart = currentStart, effEnd = currentEnd;

    const linkVal = item.column_values.find(c => c.id === PROJECT_BOARD_LINK_COL);
    const linkText = linkVal && linkVal.text;
    const match = linkText && linkText.match(/boards\/(\d+)/);

    if (match) {
      const targetBoardId = match[1];
      try {
        const colData = await mondayCall(`{ boards(ids: [${targetBoardId}]) { columns { id type } } }`);
        const board = colData.boards[0];
        const tlCol = board && board.columns.find(c => c.type === 'timeline');

        if (tlCol) {
          const itemsData = await mondayCall(`{ boards(ids: [${targetBoardId}]) { items_page(limit: 500) { items { name column_values(ids: ["${tlCol.id}"]) { text } } } } }`);
          const targetItems = itemsData.boards[0].items_page.items;
          const enquiry = targetItems.find(i => i.name === 'Project Enquiry');
          const handover = targetItems.find(i => i.name === 'Stage 4 Handover to GRM');

          const newStart = enquiry && enquiry.column_values[0] && enquiry.column_values[0].text
            ? enquiry.column_values[0].text.split(' - ')[0] : null;
          const newEnd = handover && handover.column_values[0] && handover.column_values[0].text
            ? handover.column_values[0].text.split(' - ')[1] : null;

          if (newStart && newStart !== currentStart) {
            await mondayCall(`
              mutation($val: JSON!) {
                change_column_value(board_id: ${PIPELINE_BOARD_ID}, item_id: ${item.id}, column_id: "${START_DATE_COL}", value: $val) { id }
              }`, { val: JSON.stringify({ date: newStart }) });
            console.log(`  Updated Start Date for "${item.name}": ${currentStart} -> ${newStart}`);
            effStart = newStart;
            syncedCount++;
          }

          if (newEnd && newEnd !== currentEnd) {
            await mondayCall(`
              mutation($val: JSON!) {
                change_column_value(board_id: ${PIPELINE_BOARD_ID}, item_id: ${item.id}, column_id: "${END_DATE_COL}", value: $val) { id }
              }`, { val: JSON.stringify({ date: newEnd }) });
            console.log(`  Updated End Date for "${item.name}": ${currentEnd} -> ${newEnd}`);
            effEnd = newEnd;
            syncedCount++;
          }
        }
      } catch (e) {
        console.warn(`  Skipped "${item.name}" due to error: ${e.message}`);
      }
    }

    // Mirror the range into the Gantt's timeline column. Deliberately outside
    // the block above so rows with no linked project board — hand-entered or
    // newly added ones — still show up on the Gantt.
    if (durationCol && effStart && effEnd) {
      const currentRange = (item.column_values.find(c => c.id === durationCol.id) || {}).text;
      const desiredRange = `${effStart} - ${effEnd}`;
      if (desiredRange !== currentRange) {
        try {
          await mondayCall(`
            mutation($val: JSON!) {
              change_column_value(board_id: ${PIPELINE_BOARD_ID}, item_id: ${item.id}, column_id: "${durationCol.id}", value: $val) { id }
            }`, { val: JSON.stringify({ from: effStart, to: effEnd }) });
          console.log(`  Updated ${DURATION_COL_TITLE} for "${item.name}": ${currentRange || '(empty)'} -> ${desiredRange}`);
          syncedCount++;
        } catch (e) {
          console.warn(`  Could not set ${DURATION_COL_TITLE} for "${item.name}": ${e.message}`);
        }
      }
    }
  }

  console.log(`Done. ${syncedCount} field(s) updated.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
