// build.js — turns NHTSA's giant recall file into tidy files for the app
// LESSON 8, STEP 7c VERSION: skips the work if NHTSA's file hasn't changed

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const AdmZip = require('adm-zip');

// Where NHTSA publishes the file, and where we keep our copy
const ZIP_URL = 'https://static.nhtsa.gov/odi/ffdd/rcl/FLAT_RCL_POST_2010.zip';
const ZIP_FILE = 'raw/FLAT_RCL_POST_2010.zip';
const RAW_FILE = 'raw/FLAT_RCL_POST_2010.txt';
const OUT = 'output';

// Our own published "front page" — the robot's memory of last time
const PUBLISHED_META_URL = 'https://stubenvolld.github.io/recall-data/meta.json';

// SAFETY LIMITS — if the new data breaks any of these, we refuse to publish
const MIN_RECALLS = 10000;          // we normally see ~13,600
const MAX_DROP = 0.98;              // must keep at least 98% of last time's recalls
const MAX_SKIPPED_SHARE = 0.01;     // junk rows must stay under 1%
const MAX_REFEREE_MISSING = 0.25;   // fail if we're missing over 25% of the live API's recalls

// REFEREE CARS — well-known cars we compare against NHTSA's live API
const REFEREE_CARS = [
  { year: 2024, make: 'LEXUS', model: 'NX HYBRID' },
  { year: 2021, make: 'HONDA', model: 'CR-V' },
  { year: 2024, make: 'FORD', model: 'F-150' },
  { year: 2024, make: 'TOYOTA', model: 'TACOMA' },
  { year: 2024, make: 'FORD', model: 'EXPLORER' },
];

// Column numbers from Lesson 6 (JavaScript counts from 0, so subtract 1)
const COL = {
  campaign: 1,       // column 2:  recall number
  make: 2,           // column 3
  model: 3,          // column 4
  year: 4,           // column 5
  component: 6,      // column 7:  part affected
  buildStart: 8,     // column 9:  first build date (sometimes blank)
  buildEnd: 9,       // column 10: last build date (sometimes blank)
  type: 10,          // column 11: V = vehicle
  affected: 11,      // column 12: vehicles affected
  description: 19,   // column 20
  consequence: 20,   // column 21
  remedy: 21,        // column 22
};

const NEWEST_YEAR = new Date().getFullYear() + 2;

// Trims spaces and makes capitals consistent
function clean(text) {
  return (text || '').trim().toUpperCase();
}

// Turns a name into a safe file name: "ROYAL TRUCK & EQUIPMENT" -> "royal-truck-equipment"
function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Saves data as a JSON file, creating folders as needed, and tracks totals
let fileCount = 0;
let totalBytes = 0;
function writeJson(filePath, data) {
  const text = JSON.stringify(data);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
  fileCount += 1;
  totalBytes += Buffer.byteLength(text);
}

// ---------- READ LAST TIME'S NUMBERS FROM OUR OWN PUBLISHED SITE ----------
async function getPublishedMeta() {
  try {
    const response = await fetch(PUBLISHED_META_URL);
    if (!response.ok) return null;            // e.g. the very first run, nothing published yet
    return await response.json();
  } catch (err) {
    return null;                              // can't reach it — skip the comparison, don't crash
  }
}

// ---------- NEW: ASK NHTSA FOR THE FILE'S STAMP (WITHOUT DOWNLOADING IT) ----------
async function getSourceStamp() {
  try {
    const response = await fetch(ZIP_URL, { method: 'HEAD' });   // HEAD = "just the label, not the file"
    if (!response.ok) return null;
    return response.headers.get('etag') || response.headers.get('last-modified') || null;
  } catch (err) {
    return null;                              // can't get a stamp — we'll just build to be safe
  }
}

// ---------- NEW: TELL GITHUB ACTIONS WHETHER ANYTHING CHANGED ----------
function reportChanged(changed) {
  // GITHUB_OUTPUT only exists on GitHub's computer. On your Mac, this does nothing.
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
  }
}

// ---------- DOWNLOAD AND UNZIP ----------
async function downloadAndUnzip() {
  fs.mkdirSync('raw', { recursive: true });

  console.log('Downloading NHTSA recall file…');
  const response = await fetch(ZIP_URL);
  if (!response.ok) {
    throw new Error(`Download failed: NHTSA answered with code ${response.status}`);
  }
  const zipData = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(ZIP_FILE, zipData);
  console.log(`Downloaded:          ${(zipData.length / 1024 / 1024).toFixed(1)} MB`);

  console.log('Unzipping…');
  new AdmZip(ZIP_FILE).extractAllTo('raw', true);   // true = replace the old copy

  if (!fs.existsSync(RAW_FILE)) {
    throw new Error(`Unzipped, but ${RAW_FILE} was not inside. NHTSA may have renamed it.`);
  }
  console.log('Unzipped.\n');
}

// ---------- SANITY CHECKS ----------
function sanityCheck({ recallCount, vehicleRows, skippedRows }, previous) {
  console.log('Running safety checks…');

  // Check 1: a floor — far fewer recalls than normal means a broken download
  if (recallCount < MIN_RECALLS) {
    throw new Error(`Only ${recallCount} recalls found (minimum is ${MIN_RECALLS}). The download may be broken.`);
  }
  console.log(`  ✓ Recall count ${recallCount.toLocaleString()} is above the ${MIN_RECALLS.toLocaleString()} minimum`);

  // Check 2: no sudden drop compared to what we published last time
  if (previous && previous.recallCount) {
    const lowestAllowed = Math.floor(previous.recallCount * MAX_DROP);
    if (recallCount < lowestAllowed) {
      throw new Error(`Recalls dropped from ${previous.recallCount} to ${recallCount}. Refusing to publish.`);
    }
    const change = recallCount - previous.recallCount;
    console.log(`  ✓ Compared to last publish: ${previous.recallCount.toLocaleString()} → ${recallCount.toLocaleString()} (${change >= 0 ? '+' : ''}${change})`);
  } else {
    console.log('  – No previous publish found to compare against (fine on a first run)');
  }

  // Check 3: junk rows stay rare — a jump means NHTSA may have changed the columns
  const skippedShare = skippedRows / vehicleRows;
  if (skippedShare > MAX_SKIPPED_SHARE) {
    throw new Error(`${(skippedShare * 100).toFixed(1)}% of rows were unreadable. NHTSA may have changed the file layout.`);
  }
  console.log(`  ✓ Unreadable rows: ${(skippedShare * 100).toFixed(2)}% (limit ${MAX_SKIPPED_SHARE * 100}%)`);

  console.log('All safety checks passed.\n');
}

// ---------- THE REFEREE ----------
async function refereeCheck(vehicles) {
  console.log('Running referee check against NHTSA live API…');

  let liveTotal = 0;      // recalls the live API knows about, across all referee cars
  let missingTotal = 0;   // of those, how many our files DON'T have
  let carsChecked = 0;

  for (const car of REFEREE_CARS) {
    const label = `${car.year} ${car.make} ${car.model}`;
    const ours = vehicles.get(car.year)?.get(car.make)?.get(car.model) || new Set();

    // Ask the live API about this one car
    let live;
    try {
      const url = `https://api.nhtsa.gov/recalls/recallsByVehicle?make=${encodeURIComponent(car.make)}&model=${encodeURIComponent(car.model)}&modelYear=${car.year}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`code ${response.status}`);
      const data = await response.json();
      live = new Set((data.results || []).map((r) => r.NHTSACampaignNumber));
    } catch (err) {
      console.log(`  – ${label}: couldn't reach the live API (${err.message}), skipping`);
      continue;
    }

    carsChecked += 1;
    const missing = [...live].filter((c) => !ours.has(c));
    liveTotal += live.size;
    missingTotal += missing.length;

    if (missing.length === 0) {
      console.log(`  ✓ ${label}: ours ${ours.size}, live ${live.size}`);
    } else {
      console.log(`  ⚠ ${label}: ours ${ours.size}, live ${live.size} — missing ${missing.join(', ')}`);
    }
  }

  // Judge the overall result
  if (carsChecked === 0) {
    console.log('Referee skipped: live API unreachable. Publishing anyway (other checks passed).\n');
    return;
  }
  const missingShare = liveTotal === 0 ? 0 : missingTotal / liveTotal;
  if (missingShare > MAX_REFEREE_MISSING) {
    throw new Error(`Referee failed: our files are missing ${missingTotal} of ${liveTotal} recalls the live API reports.`);
  }
  console.log(`Referee passed: missing ${missingTotal} of ${liveTotal} live recalls (limit ${MAX_REFEREE_MISSING * 100}%).\n`);
}

// ---------- BUILD: read, organize, check, write ----------
async function build(previous, sourceStamp) {
  // TABLE 1 — recalls: one entry per recall number, holding its details
  const recalls = new Map();

  // TABLE 2 — recall_vehicles as a filing cabinet: year -> make -> model -> recall numbers
  const vehicles = new Map();

  // TABLE 3 — the reverse direction: recall number -> every car it affects
  const recallVehicles = new Map();

  let vehicleRows = 0;
  let skippedRows = 0;

  const reader = readline.createInterface({
    input: fs.createReadStream(RAW_FILE),
    crlfDelay: Infinity,
  });

  for await (const line of reader) {
    const cols = line.split('\t');
    if (cols[COL.type] !== 'V') continue;            // vehicles only
    vehicleRows += 1;

    const campaign = (cols[COL.campaign] || '').trim();
    const make = clean(cols[COL.make]);
    const model = clean(cols[COL.model]);
    const year = Number(cols[COL.year]);

    // Skip broken rows: missing pieces, or fake years like 9999
    if (!campaign || !make || !model || !(year >= 1949 && year <= NEWEST_YEAR)) {
      skippedRows += 1;
      continue;
    }

    // TABLE 1: save the recall's details the first time we see it
    if (!recalls.has(campaign)) {
      recalls.set(campaign, {
        campaign,
        components: new Set(),
        description: (cols[COL.description] || '').trim(),
        consequence: (cols[COL.consequence] || '').trim(),
        remedy: (cols[COL.remedy] || '').trim(),
        affected: Number(cols[COL.affected]) || null,
        buildStart: (cols[COL.buildStart] || '').trim() || null,
        buildEnd: (cols[COL.buildEnd] || '').trim() || null,
      });
    }
    const component = (cols[COL.component] || '').trim();
    if (component) recalls.get(campaign).components.add(component);

    // TABLE 2: file this recall under year -> make -> model
    if (!vehicles.has(year)) vehicles.set(year, new Map());
    const makes = vehicles.get(year);
    if (!makes.has(make)) makes.set(make, new Map());
    const models = makes.get(make);
    if (!models.has(model)) models.set(model, new Set());
    models.get(model).add(campaign);

    // TABLE 3: remember which cars this recall touches
    if (!recallVehicles.has(campaign)) recallVehicles.set(campaign, new Set());
    recallVehicles.get(campaign).add(`${year}|${make}|${model}`);
  }

  // Check the numbers BEFORE writing anything
  sanityCheck({ recallCount: recalls.size, vehicleRows, skippedRows }, previous);
  await refereeCheck(vehicles);

  // ---------- WRITE THE TIDY FILES ----------

  // Start fresh each time so old files never linger
  fs.rmSync(OUT, { recursive: true, force: true });

  const years = [...vehicles.keys()].sort((a, b) => b - a);   // newest first

  // FILE 1: meta.json — the "front page" (and the robot's memory for next time)
  writeJson(`${OUT}/meta.json`, {
    builtAt: new Date().toISOString(),
    sourceStamp,                 // NEW: NHTSA's file stamp, so next time we can tell if it changed
    recallCount: recalls.size,
    vehicleRows,
    years,
  });

  // FILES 2 & 3: one file per year (makes), one file per year+make (models)
  for (const year of years) {
    const makes = vehicles.get(year);
    const makeList = [];

    for (const [make, models] of makes) {
      const makeCampaigns = new Set();
      const modelList = [];

      for (const [model, campaigns] of models) {
        campaigns.forEach((c) => makeCampaigns.add(c));
        modelList.push({
          model,
          recallCount: campaigns.size,
          recalls: [...campaigns].sort().map((c) => ({
            campaign: c,
            title: [...recalls.get(c).components][0] || 'Unknown part',
          })),
        });
      }

      modelList.sort((a, b) => a.model.localeCompare(b.model));
      const makeSlug = slug(make);
      writeJson(`${OUT}/years/${year}/${makeSlug}.json`, { year, make, models: modelList });

      makeList.push({
        make,
        slug: makeSlug,
        recallCount: makeCampaigns.size,
        modelCount: models.size,
      });
    }

    makeList.sort((a, b) => a.make.localeCompare(b.make));
    writeJson(`${OUT}/years/${year}.json`, { year, makes: makeList });
  }

  // FILE 4: one file per recall — full details + every car it affects
  for (const [campaign, r] of recalls) {
    const affectedCars = [...recallVehicles.get(campaign)].sort().map((v) => {
      const [year, make, model] = v.split('|');
      return { year: Number(year), make, model };
    });
    writeJson(`${OUT}/recalls/${campaign}.json`, {
      ...r,
      components: [...r.components],
      vehicleCount: affectedCars.length,
      vehicles: affectedCars,
    });
  }

  // ---------- REPORT ----------
  console.log(`Vehicle rows read:   ${vehicleRows.toLocaleString()}`);
  console.log(`Rows skipped:        ${skippedRows.toLocaleString()}`);
  console.log(`Unique recalls:      ${recalls.size.toLocaleString()}`);
  console.log(`Model years:         ${years.length} (${years[years.length - 1]}–${years[0]})`);
  console.log(`Files written:       ${fileCount.toLocaleString()}`);
  console.log(`Total size:          ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
}

// ---------- RUN EVERYTHING, IN ORDER ----------
async function main() {
  const previous = await getPublishedMeta();
  const sourceStamp = await getSourceStamp();
  const forced = process.env.FORCE_BUILD === 'true';

  console.log(`NHTSA file stamp now:     ${sourceStamp || 'unknown'}`);
  console.log(`Stamp at last publish:    ${(previous && previous.sourceStamp) || 'none'}`);
  console.log(`Forced rebuild:           ${forced ? 'yes' : 'no'}\n`);

  // NEW: skip everything if NHTSA's file is exactly the one we already published
  if (!forced && sourceStamp && previous && previous.sourceStamp === sourceStamp) {
    console.log('NHTSA file unchanged since last publish. Skipping build; current files stay live.');
    reportChanged(false);
    console.log('\nNOTHING TO DO');
    return;
  }

  await downloadAndUnzip();
  await build(previous, sourceStamp);
  reportChanged(true);
  console.log('\nBUILD SUCCEEDED');
}

main().catch((err) => {
  console.error(`\nBUILD FAILED: ${err.message}`);
  process.exit(1);
});