// build.js — turns NHTSA's giant recall file into tidy files for the app
// LESSON 8, STEP 1 VERSION: downloads the file itself, then builds

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const AdmZip = require('adm-zip');

// Where NHTSA publishes the file, and where we keep our copy
const ZIP_URL = 'https://static.nhtsa.gov/odi/ffdd/rcl/FLAT_RCL_POST_2010.zip';
const ZIP_FILE = 'raw/FLAT_RCL_POST_2010.zip';
const RAW_FILE = 'raw/FLAT_RCL_POST_2010.txt';
const OUT = 'output';

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

// ---------- NEW: DOWNLOAD AND UNZIP ----------
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

// ---------- BUILD: read, organize, write ----------
async function build() {
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

  // ---------- WRITE THE TIDY FILES ----------

  // Start fresh each time so old files never linger
  fs.rmSync(OUT, { recursive: true, force: true });

  const years = [...vehicles.keys()].sort((a, b) => b - a);   // newest first

  // FILE 1: meta.json — the "front page"
  writeJson(`${OUT}/meta.json`, {
    builtAt: new Date().toISOString(),
    recallCount: recalls.size,
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
  await downloadAndUnzip();
  await build();
  console.log('\nBUILD SUCCEEDED');
}

main().catch((err) => {
  console.error(`\nBUILD FAILED: ${err.message}`);
  process.exit(1);
});