// GRM Pipeline sync — runs hourly via GitHub Actions. Three independent phases,
// each wrapped so one failing can never take down the others:
//   1. Date sync   — Pipeline Start/End/Duration from each project board.
//   2. Map export  — grm-data.json for the GitHub Pages map.
//   3. Action sync — outstanding project actions into the 05_Action Items board.
//
// monday's API is called through mondayCall(), which retries transient failures
// three times with backoff. A monday blip therefore degrades to "skip, the next
// hourly run picks it up" rather than corrupting the boards.

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

// --- Action sync target: 05_Action Items board -----------------------------
const ACTIONS_BOARD_ID = 18427620123;
const ACTIONS_PROJECT_NOTES_GROUP = "group_mm6ep3q6"; // synced actions live here
const ACTIONS_OWNER_COL = "multiple_person_mm6esrq";
const ACTIONS_PROJECT_COL = "text_mm6ep5h7";
const ACTIONS_STATUS_COL = "color_mm6e34na";
const ACTIONS_SOURCE_COL = "link_mm6ep7g9";
// On the project boards, an action = a phase (or subitem) with an owner set and
// status != Completed. These are the project-board column ids.
const PROJ_PHASE_OWNER_COL = "multiple_person_mm4nrqgg";
const PROJ_PHASE_STATUS_COL = "color_mm4n5jjx";
const COMPLETED_LABEL = "Completed";

// --- 06_Minutes source ------------------------------------------------------
// Minutes are a source board like the project boards: a row is an outstanding
// action when it has an "Action by" person set and Status != Done. These land
// in their own "From Minutes" group on 05, and are removed when Done/unassigned.
const MINUTES_BOARD_ID = 18429150281;
const MINUTES_OWNER_COL = "multiple_person_mm6sevgf";
const MINUTES_STATUS_COL = "color_mm6s5hzz";
const MINUTES_ITEM_COL = "text_mm6s1fds";
const MINUTES_DONE_LABEL = "Done";
const ACTIONS_FROM_MINUTES_GROUP = "group_mm6swcn4"; // synced minutes live here on 05

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

// mondayCall with retry. Transient failures (network, 5xx, rate limit) are
// retried up to 3 times with backoff. A GraphQL error in the response body is
// treated as permanent (bad query / bad token) and thrown immediately with a
// plain-English hint, because retrying it would just fail the same way.
async function mondayCall(query, variables, attempt = 1) {
  const MAX = 3;
  try {
    const res = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': TOKEN },
      body: JSON.stringify({ query, variables })
    });
    if (res.status === 429 || res.status >= 500) {
      throw new Error(`monday API HTTP ${res.status} (transient)`);
    }
    const json = await res.json();
    if (json.errors) {
      const msg = JSON.stringify(json.errors);
      if (/authentication|unauthorized|401/i.test(msg)) {
        throw new Error('PERMANENT: monday rejected the token — regenerate the '
          + 'MONDAY_TOKEN secret in GitHub (Settings > Secrets and variables > Actions).');
      }
      // Other GraphQL errors are permanent (bad column id, permissions, etc.)
      const e = new Error('PERMANENT: ' + msg);
      e.permanent = true;
      throw e;
    }
    return json.data;
  } catch (e) {
    if (e.permanent || /^PERMANENT:/.test(e.message) || attempt >= MAX) throw e;
    const wait = 500 * attempt;
    console.warn(`  monday call failed (attempt ${attempt}/${MAX}): ${e.message} — retrying in ${wait}ms`);
    await sleep(wait);
    return mondayCall(query, variables, attempt + 1);
  }
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

// Fetch every Pipeline item once, with its project-board link. Shared by the
// date sync, the map export, and the action sync so we hit the API once.
async function fetchPipelineItems(extraCols) {
  const cols = [PROJECT_BOARD_LINK_COL].concat(extraCols || []);
  const data = await mondayCall(`
    query($boardId: ID!) {
      boards(ids: [$boardId]) {
        items_page(limit: 100) {
          items {
            id
            name
            column_values(ids: [${cols.map(c => `"${c}"`).join(', ')}]) {
              id text
              ... on FormulaValue { display_value }
            }
          }
        }
      }
    }`, { boardId: PIPELINE_BOARD_ID });
  return data.boards[0].items_page.items;
}

function projectBoardIdFromLink(item) {
  const linkVal = item.column_values.find(c => c.id === PROJECT_BOARD_LINK_COL);
  const linkText = linkVal && linkVal.text;
  const m = linkText && linkText.match(/boards\/(\d+)/);
  return m ? m[1] : null;
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

async function runDateSync() {
  const pipelineCols = await mondayCall(
    `query($boardId: ID!) { boards(ids: [$boardId]) { columns { id title type } } }`,
    { boardId: PIPELINE_BOARD_ID });
  const timelineCols = pipelineCols.boards[0].columns.filter(c => c.type === 'timeline');
  const durationCol = timelineCols.find(c => c.title === DURATION_COL_TITLE)
    || (timelineCols.length === 1 ? timelineCols[0] : null);

  if (!durationCol) {
    console.warn(`WARNING: no "${DURATION_COL_TITLE}" timeline column on the Pipeline board ` +
      `(found ${timelineCols.length} timeline column(s)). The Gantt view will stay empty.`);
  } else {
    console.log(`Gantt timeline column: "${durationCol.title}" (${durationCol.id})`);
  }

  const wantedCols = [START_DATE_COL, END_DATE_COL].concat(durationCol ? [durationCol.id] : []);
  console.log('Fetching Pipeline items...');
  const items = await fetchPipelineItems(wantedCols);
  let syncedCount = 0;

  for (const item of items) {
    const currentStart = (item.column_values.find(c => c.id === START_DATE_COL) || {}).text;
    const currentEnd = (item.column_values.find(c => c.id === END_DATE_COL) || {}).text;
    let effStart = currentStart, effEnd = currentEnd;

    const targetBoardId = projectBoardIdFromLink(item);
    if (targetBoardId) {
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
  console.log(`Date sync done. ${syncedCount} field(s) updated.`);
}

// --- Action sync -----------------------------------------------------------
// Scans every project board for phases + subitems that have an owner assigned
// and are not Completed, and mirrors them into the Project Notes group of the
// 05_Action Items board. Safety rules:
//   * Only rows this job created are ever touched — matched by the Source link
//     back to the project-board item. Ad-hoc rows and anything in General To-Do
//     are invisible to this sync.
//   * A row is removed ONLY when its specific source item is positively seen as
//     Completed or un-owned. If a project board can't be read this run, its rows
//     are left untouched (no bulk delete on incomplete data).

async function fetchActionsOnBoard(boardId, boardName) {
  // Top-level phases with owner + status.
  const data = await mondayCall(`{
    boards(ids: [${boardId}]) {
      items_page(limit: 500) {
        items {
          id name
          column_values(ids: ["${PROJ_PHASE_OWNER_COL}", "${PROJ_PHASE_STATUS_COL}"]) {
            id text
            ... on PeopleValue { persons_and_teams { id kind } }
          }
          subitems {
            id name
            column_values {
              id text type
              ... on PeopleValue { persons_and_teams { id kind } }
              ... on StatusValue { label }
            }
          }
        }
      }
    }
  }`);
  const items = data.boards[0].items_page.items;
  const actions = [];

  const ownerIds = cv => (cv && cv.persons_and_teams
    ? cv.persons_and_teams.filter(p => p.kind === 'person').map(p => p.id) : []);

  for (const it of items) {
    const ownerCv = it.column_values.find(c => c.id === PROJ_PHASE_OWNER_COL);
    const statusCv = it.column_values.find(c => c.id === PROJ_PHASE_STATUS_COL);
    const owners = ownerIds(ownerCv);
    const status = statusCv ? statusCv.text : null;
    if (owners.length && status !== COMPLETED_LABEL) {
      actions.push({ srcId: it.id, name: it.name, owners, status, board: boardName, boardId });
    }
    // Subitems: only those carrying their own People + Status columns.
    for (const sub of (it.subitems || [])) {
      let subOwners = [], subStatus = null;
      for (const cv of sub.column_values) {
        if (cv.type === 'people') subOwners = ownerIds(cv);
        if (cv.type === 'color') subStatus = cv.label || cv.text;
      }
      if (subOwners.length && subStatus !== COMPLETED_LABEL) {
        actions.push({ srcId: sub.id, name: `${it.name} › ${sub.name}`,
          owners: subOwners, status: subStatus, board: boardName, boardId, subOf: it.id });
      }
    }
  }
  return actions;
}

async function runActionSync() {
  console.log('Action sync: scanning project boards...');
  const pipeline = await fetchPipelineItems([]);

  // 1. Gather desired actions across every project board. If any single board
  //    read fails, record it so we DON'T delete that board's existing rows.
  const desired = {};          // srcId -> action
  const scannedBoardIds = new Set();
  const failedBoardIds = new Set();

  for (const item of pipeline) {
    const boardId = projectBoardIdFromLink(item);
    if (!boardId) continue;
    try {
      const actions = await fetchActionsOnBoard(boardId, item.name);
      scannedBoardIds.add(String(boardId));
      for (const a of actions) desired[a.srcId] = a;
    } catch (e) {
      failedBoardIds.add(String(boardId));
      console.warn(`  Could not scan board ${boardId} ("${item.name}"): ${e.message} — its existing rows will be left untouched.`);
    }
  }

  // 2. Read existing synced rows in Project Notes (only ones we created — they
  //    carry a Source link back to the project item).
  const existingData = await mondayCall(`{
    boards(ids: [${ACTIONS_BOARD_ID}]) {
      groups(ids: ["${ACTIONS_PROJECT_NOTES_GROUP}"]) {
        items_page(limit: 500) {
          items {
            id name
            column_values(ids: ["${ACTIONS_SOURCE_COL}", "${ACTIONS_STATUS_COL}", "${ACTIONS_OWNER_COL}"]) {
              id text
              ... on PeopleValue { persons_and_teams { id kind } }
            }
          }
        }
      }
    }
  }`);
  const existing = {};   // srcId -> {itemId, name, ownerIds[], status, project}
  for (const it of existingData.boards[0].groups[0].items_page.items) {
    const src = it.column_values.find(c => c.id === ACTIONS_SOURCE_COL);
    const m = src && src.text && src.text.match(/pulses\/(\d+)/);
    if (!m) continue;
    const ownerCv = it.column_values.find(c => c.id === ACTIONS_OWNER_COL);
    const statusCv = it.column_values.find(c => c.id === ACTIONS_STATUS_COL);
    const projCv = it.column_values.find(c => c.id === ACTIONS_PROJECT_COL);
    existing[m[1]] = {
      itemId: it.id, name: it.name,
      ownerIds: (ownerCv && ownerCv.persons_and_teams ? ownerCv.persons_and_teams.filter(p => p.kind === 'person').map(p => String(p.id)).sort() : []),
      status: statusCv ? statusCv.text : null,
      project: projCv ? projCv.text : null
    };
  }

  let created = 0, removed = 0, updated = 0, kept = 0;

  // 3. Create rows for new actions; update in place when the source changed.
  for (const srcId of Object.keys(desired)) {
    const a = desired[srcId];
    const personsVal = { personsAndTeams: a.owners.map(id => ({ id: Number(id), kind: 'person' })) };
    if (existing[srcId]) {
      const ex = existing[srcId];
      const wantOwners = a.owners.map(String).sort();
      const nameDiff = ex.name !== a.name;
      const ownerDiff = ex.ownerIds.join(',') !== wantOwners.join(',');
      const statusDiff = (a.status || null) !== (ex.status || null);
      const projDiff = (a.board || null) !== (ex.project || null);
      if (nameDiff || ownerDiff || statusDiff || projDiff) {
        try {
          if (nameDiff) await mondayCall(`mutation { change_simple_column_value(board_id: ${ACTIONS_BOARD_ID}, item_id: ${ex.itemId}, column_id: "name", value: ${JSON.stringify(a.name)}) { id } }`);
          const ucols = {};
          if (ownerDiff) ucols[ACTIONS_OWNER_COL] = personsVal;
          if (projDiff) ucols[ACTIONS_PROJECT_COL] = a.board;
          if (statusDiff && a.status) ucols[ACTIONS_STATUS_COL] = { label: a.status };
          if (Object.keys(ucols).length) await mondayCall(`mutation($cols: JSON!) { change_multiple_column_values(board_id: ${ACTIONS_BOARD_ID}, item_id: ${ex.itemId}, column_values: $cols, create_labels_if_missing: true) { id } }`, { cols: JSON.stringify(ucols) });
          console.log(`  ~ Updated "${a.name}" (${a.board})`);
          updated++;
        } catch (e) { console.warn(`  Could not update "${a.name}": ${e.message}`); }
      } else { kept++; }
      continue;
    }
    const cols = {};
    cols[ACTIONS_OWNER_COL] = personsVal;
    cols[ACTIONS_PROJECT_COL] = a.board;
    cols[ACTIONS_SOURCE_COL] = {
      url: `https://vitaarchitecture.monday.com/boards/${a.boardId}/pulses/${a.srcId}`,
      text: 'Open on project board'
    };
    if (a.status) cols[ACTIONS_STATUS_COL] = { label: a.status };
    try {
      await mondayCall(`
        mutation($cols: JSON!) {
          create_item(board_id: ${ACTIONS_BOARD_ID}, group_id: "${ACTIONS_PROJECT_NOTES_GROUP}",
            item_name: ${JSON.stringify(a.name)}, column_values: $cols,
            create_labels_if_missing: true) { id }
        }`, { cols: JSON.stringify(cols) });
      console.log(`  + Added "${a.name}" (${a.board})`);
      created++;
    } catch (e) {
      console.warn(`  Could not add "${a.name}": ${e.message}`);
    }
  }

  // 4. Remove rows whose source is no longer a desired action — but ONLY if we
  //    successfully scanned that source's board this run. A board we failed to
  //    read is skipped entirely, so nothing is deleted on incomplete data.
  for (const srcId of Object.keys(existing)) {
    if (desired[srcId]) continue; // still outstanding
    const row = existing[srcId];
    if (failedBoardIds.size > 0) {
      console.log(`  ~ Keeping "${row.name}" this run (a project board failed to read; will re-evaluate next hour).`);
      continue;
    }
    try {
      await mondayCall(`mutation { delete_item(item_id: ${row.itemId}) { id } }`);
      console.log(`  - Removed "${row.name}" (source Completed or un-owned)`);
      removed++;
    } catch (e) {
      console.warn(`  Could not remove "${row.name}": ${e.message}`);
    }
  }

  console.log(`Action sync done. ${created} added, ${updated} updated, ${removed} removed, ${kept} already present.`);
}

// --- Minutes sync -----------------------------------------------------------
// Reads 06_Minutes as a source board and mirrors outstanding minute actions
// (Action by set AND Status != Done) into the "From Minutes" group on 05.
// Same safety model as runActionSync: only touches rows it created (matched by
// the Source link back to the minute), and removes a row only when its source
// minute is positively Done or unassigned. If 06 can't be read this run, no
// removals happen — nothing is deleted on incomplete data.
async function runMinutesSync() {
  console.log('Minutes sync: scanning 06_Minutes...');

  const ownerIds = cv => (cv && cv.persons_and_teams
    ? cv.persons_and_teams.filter(p => p.kind === 'person').map(p => p.id) : []);

  // 1. Read 06_Minutes. If this fails, we skip the whole phase (and therefore
  //    never delete existing minute rows on 05).
  let minutes;
  try {
    const data = await mondayCall(`{
      boards(ids: [${MINUTES_BOARD_ID}]) {
        items_page(limit: 500) {
          items {
            id name
            column_values(ids: ["${MINUTES_OWNER_COL}", "${MINUTES_STATUS_COL}", "${MINUTES_ITEM_COL}"]) {
              id text
              ... on PeopleValue { persons_and_teams { id kind } }
            }
          }
        }
      }
    }`);
    minutes = data.boards[0].items_page.items;
  } catch (e) {
    console.warn(`  Could not read 06_Minutes: ${e.message} — skipping minutes sync this run (nothing removed).`);
    return;
  }

  // Desired = minute rows with an owner and Status != Done.
  const desired = {};
  for (const it of minutes) {
    const ownerCv = it.column_values.find(c => c.id === MINUTES_OWNER_COL);
    const statusCv = it.column_values.find(c => c.id === MINUTES_STATUS_COL);
    const itemCv = it.column_values.find(c => c.id === MINUTES_ITEM_COL);
    const owners = ownerIds(ownerCv);
    const status = statusCv ? statusCv.text : null;
    if (owners.length && status !== MINUTES_DONE_LABEL) {
      desired[it.id] = { srcId: it.id, name: it.name, owners, status,
        itemNo: itemCv ? itemCv.text : null };
    }
  }

  // 2. Existing synced minute rows in the "From Minutes" group (ones we created).
  const existingData = await mondayCall(`{
    boards(ids: [${ACTIONS_BOARD_ID}]) {
      groups(ids: ["${ACTIONS_FROM_MINUTES_GROUP}"]) {
        items_page(limit: 500) {
          items {
            id name
            column_values(ids: ["${ACTIONS_SOURCE_COL}", "${ACTIONS_OWNER_COL}", "${ACTIONS_STATUS_COL}", "${ACTIONS_PROJECT_COL}"]) {
              id text
              ... on PeopleValue { persons_and_teams { id kind } }
            }
          }
        }
      }
    }
  }`);
  const existing = {};
  for (const it of existingData.boards[0].groups[0].items_page.items) {
    const src = it.column_values.find(c => c.id === ACTIONS_SOURCE_COL);
    const m = src && src.text && src.text.match(/pulses\/(\d+)/);
    if (!m) continue;
    const ownerCv = it.column_values.find(c => c.id === ACTIONS_OWNER_COL);
    const statusCv = it.column_values.find(c => c.id === ACTIONS_STATUS_COL);
    const projCv = it.column_values.find(c => c.id === ACTIONS_PROJECT_COL);
    existing[m[1]] = {
      itemId: it.id, name: it.name,
      ownerIds: (ownerCv && ownerCv.persons_and_teams ? ownerCv.persons_and_teams.filter(p => p.kind === 'person').map(p => String(p.id)).sort() : []),
      status: statusCv ? statusCv.text : null,
      project: projCv ? projCv.text : null
    };
  }

  let created = 0, removed = 0, updated = 0, kept = 0;

  // 3. Create new minutes; update in place when the source changed.
  for (const srcId of Object.keys(desired)) {
    const a = desired[srcId];
    const wantProject = a.itemNo ? `Minutes ${a.itemNo}` : 'Minutes';
    const personsVal = { personsAndTeams: a.owners.map(id => ({ id: Number(id), kind: 'person' })) };
    if (existing[srcId]) {
      const ex = existing[srcId];
      const wantOwners = a.owners.map(String).sort();
      const nameDiff = ex.name !== a.name;
      const ownerDiff = ex.ownerIds.join(',') !== wantOwners.join(',');
      const statusDiff = (a.status || null) !== (ex.status || null);
      const projDiff = wantProject !== (ex.project || null);
      if (nameDiff || ownerDiff || statusDiff || projDiff) {
        try {
          if (nameDiff) await mondayCall(`mutation { change_simple_column_value(board_id: ${ACTIONS_BOARD_ID}, item_id: ${ex.itemId}, column_id: "name", value: ${JSON.stringify(a.name)}) { id } }`);
          const ucols = {};
          if (ownerDiff) ucols[ACTIONS_OWNER_COL] = personsVal;
          if (projDiff) ucols[ACTIONS_PROJECT_COL] = wantProject;
          if (statusDiff && a.status) ucols[ACTIONS_STATUS_COL] = { label: a.status };
          if (Object.keys(ucols).length) await mondayCall(`mutation($cols: JSON!) { change_multiple_column_values(board_id: ${ACTIONS_BOARD_ID}, item_id: ${ex.itemId}, column_values: $cols, create_labels_if_missing: true) { id } }`, { cols: JSON.stringify(ucols) });
          console.log(`  ~ Updated minute "${a.name}"`);
          updated++;
        } catch (e) { console.warn(`  Could not update minute "${a.name}": ${e.message}`); }
      } else { kept++; }
      continue;
    }
    const cols = {};
    cols[ACTIONS_OWNER_COL] = personsVal;
    cols[ACTIONS_PROJECT_COL] = wantProject;
    cols[ACTIONS_SOURCE_COL] = {
      url: `https://vitaarchitecture.monday.com/boards/${MINUTES_BOARD_ID}/pulses/${a.srcId}`,
      text: 'Open in 06_Minutes'
    };
    if (a.status) cols[ACTIONS_STATUS_COL] = { label: a.status };
    try {
      await mondayCall(`
        mutation($cols: JSON!) {
          create_item(board_id: ${ACTIONS_BOARD_ID}, group_id: "${ACTIONS_FROM_MINUTES_GROUP}",
            item_name: ${JSON.stringify(a.name)}, column_values: $cols,
            create_labels_if_missing: true) { id }
        }`, { cols: JSON.stringify(cols) });
      console.log(`  + Added minute "${a.name}"`);
      created++;
    } catch (e) {
      console.warn(`  Could not add minute "${a.name}": ${e.message}`);
    }
  }

  // 4. Remove rows whose source minute is now Done or unassigned. 06 was read
  //    successfully (we returned early otherwise), so removal is safe here.
  for (const srcId of Object.keys(existing)) {
    if (desired[srcId]) continue;
    const row = existing[srcId];
    try {
      await mondayCall(`mutation { delete_item(item_id: ${row.itemId}) { id } }`);
      console.log(`  - Removed minute "${row.name}" (Done or unassigned)`);
      removed++;
    } catch (e) {
      console.warn(`  Could not remove minute "${row.name}": ${e.message}`);
    }
  }

  console.log(`Minutes sync done. ${created} added, ${updated} updated, ${removed} removed, ${kept} already present.`);
}

// --- Orchestration ---------------------------------------------------------
// Each phase is isolated: a failure in one is logged in plain English and does
// not stop the others. The job only exits non-zero on a total date-sync failure
// (the original core function), so a flaky action sync won't spam red emails.

async function main() {
  if (!TOKEN) throw new Error('MONDAY_TOKEN secret is not set');

  let hadCoreFailure = false;

  try {
    await runDateSync();
  } catch (e) {
    hadCoreFailure = true;
    console.error('Date sync FAILED: ' + e.message);
  }

  try {
    console.log('Building map data...');
    await buildMapData();
  } catch (e) {
    console.warn('Map export failed (non-fatal): ' + e.message);
  }

  try {
    await runActionSync();
  } catch (e) {
    console.warn('Action sync failed (non-fatal, self-corrects next hour): ' + e.message);
  }

  try {
    await runMinutesSync();
  } catch (e) {
    console.warn('Minutes sync failed (non-fatal, self-corrects next hour): ' + e.message);
  }

  if (hadCoreFailure) {
    throw new Error('Core date sync failed — see log above. This usually self-corrects next hour; '
      + 'if every run fails, check the MONDAY_TOKEN secret.');
  }
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
