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
//
// Finally it exports grm-data.json for the GitHub Pages map. The browser
// cannot call monday's API directly (monday sends no CORS headers), so this
// job bakes the pipeline into a static JSON served from the same origin as
// map.html. Site coordinates are resolved here too: the Plus Code locality is
// geocoded via Nominatim, then the short Plus Code is recovered to lat/lng.

const fs = require('fs');

const TOKEN = process.env.MONDAY_TOKEN;
const PIPELINE_BOARD_ID = 18419311248;
const PROJECT_BOARD_LINK_COL = "link_mm5j5v2k";
const START_DATE_COL = "date_mm5nbqe9";
const END_DATE_COL = "date_mm5n5v74";
const DURATION_COL_TITLE = "Project Duration";

// Map export columns
const PLUS_CODE_COL = "text_mm4n4axw";
const PRIORITY_COL = "formula_mm5yktnh";
const GRM_STATUS_COL = "color_mm4nqnfp";
const CLIENT_COL = "color_mm4nnk8x";
const PROJECT_STATUS_COL = "color_mm4nmy4d";
const ADDED_DATE_COL = "date_mm5h8tt4";
const DASHBOARD_LINK_COL = "link_mm5nzw32";
const SITE_REVIEW_COL = "file_mm5y18mn";

// Plus Code decoder (open-location-code). Loaded defensively so a packaging
// quirk degrades to "no coordinates" rather than killing the date sync.
let olc = null;
try {
  const olcMod = require('open-location-code');
  const OLC = olcMod.OpenLocationCode || olcMod;
  olc = typeof OLC === 'function' ? new OLC() : OLC;
} catch (e) {
  console.warn('open-location-code not available — map coordinates will be skipped.');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

// --- Geocoding (Nominatim, cached per locality, rate-limited) --------------

const geoCache = {};

async function geocodeLocality(locality) {
  if (geoCache[locality]) return geoCache[locality];
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q='
    + encodeURIComponent(locality + ', United Kingdom');
  const res = await fetch(url, {
    headers: { 'User-Agent': 'grm-kickoff-map-sync (vitaarchitecture.github.io)' }
  });
  if (!res.ok) throw new Error(`Geocode HTTP ${res.status}`);
  const results = await res.json();
  await sleep(1100); // Nominatim usage policy: max 1 request/second
  if (!results.length) throw new Error(`No geocode result for "${locality}"`);
  const hit = { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
  geoCache[locality] = hit;
  return hit;
}

function extractUrl(text) {
  const m = text && text.match(/https?:\/\/\S+/);
  return m ? m[0] : null;
}

// --- Map data export -------------------------------------------------------

async function buildMapData() {
  const colIds = [PLUS_CODE_COL, PRIORITY_COL, GRM_STATUS_COL, CLIENT_COL,
    PROJECT_STATUS_COL, ADDED_DATE_COL, START_DATE_COL, END_DATE_COL,
    PROJECT_BOARD_LINK_COL, DASHBOARD_LINK_COL, SITE_REVIEW_COL];

  const data = await mondayCall(`
    query($boardId: ID!) {
      boards(ids: [$boardId]) {
        items_page(limit: 100) {
          items {
            id
            name
            column_values(ids: [${colIds.map(c => `"${c}"`).join(', ')}]) {
              id
              text
              ... on FormulaValue { display_value }
            }
          }
        }
      }
    }`, { boardId: PIPELINE_BOARD_ID });

  const items = [];
  for (const item of data.boards[0].items_page.items) {
    const col = id => {
      const c = item.column_values.find(v => v.id === id);
      if (!c) return null;
      if (c.display_value != null && c.display_value !== '') return c.display_value;
      return c.text;
    };

    // Resolve "GX5R+5C Oldbury" -> lat/lng
    const plusText = col(PLUS_CODE_COL) || '';
    const m = plusText.match(/^(\S+\+\S+)\s+(.+)$/);
    let plusCode = null, locality = null, lat = null, lng = null;
    if (m && olc) {
      plusCode = m[1];
      locality = m[2];
      try {
        const ref = await geocodeLocality(locality);
        const fullCode = olc.recoverNearest(plusCode, ref.lat, ref.lng);
        const area = olc.decode(fullCode);
        lat = area.latitudeCenter;
        lng = area.longitudeCenter;
      } catch (e) {
        console.warn(`  Could not resolve location for "${item.name}": ${e.message}`);
      }
    }

    const priorityRaw = col(PRIORITY_COL);
    const priority = (priorityRaw != null && priorityRaw !== '' && !isNaN(Number(priorityRaw)))
      ? Number(priorityRaw) : null;

    items.push({
      id: item.id,
      name: item.name,
      plus_code: plusCode,
      locality: locality,
      lat: lat,
      lng: lng,
      priority: priority,
      grm_status: col(GRM_STATUS_COL),
      client: col(CLIENT_COL),
      project_status: col(PROJECT_STATUS_COL),
      added: col(ADDED_DATE_COL),
      start_date: col(START_DATE_COL),
      end_date: col(END_DATE_COL),
      board_url: extractUrl(col(PROJECT_BOARD_LINK_COL)),
      dashboard_url: extractUrl(col(DASHBOARD_LINK_COL)),
      site_review_url: extractUrl(col(SITE_REVIEW_COL))
    });
  }

  fs.writeFileSync('grm-data.json', JSON.stringify({
    generated_at: new Date().toISOString(),
    board_id: PIPELINE_BOARD_ID,
    items: items
  }, null, 2));
  console.log(`Wrote grm-data.json with ${items.length} item(s).`);
}

// --- Date sync -------------------------------------------------------------

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

  // Map data export runs after the date sync so a geocoding hiccup can never
  // block the dates. It logs loudly but does not fail the job.
  try {
    console.log('Building map data...');
    await buildMapData();
  } catch (e) {
    console.warn(`Map data export failed (date sync itself succeeded): ${e.message}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
