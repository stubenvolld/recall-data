// build.js — turns NHTSA's giant recall file into tidy files for the app
// LESSON 12 VERSION: adds FAMILIES (with filed-as labels and See also) to each make file

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

// Column numbers from the data dictionary (JavaScript counts from 0, so subtract 1)
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
  doNotDrive: 27,    // column 28: NHTSA consumer advisory "Do Not Drive" (text: Yes/No)
  parkOutside: 28,   // column 29: NHTSA consumer advisory "Park Outside" (text: Yes/No)
};

const NEWEST_YEAR = new Date().getFullYear() + 2;

// Trims spaces and makes capitals consistent
function clean(text) {
  return (text || '').trim().toUpperCase();
}

// Is this text a "Yes"? Handles Yes, YES, yes, extra spaces, and blanks safely
function isYes(text) {
  return clean(text) === 'YES';
}

// Turns a name into a safe file name: "ROYAL TRUCK & EQUIPMENT" -> "royal-truck-equipment"
function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---------- ONE NAME PER MAKE ----------
const makeNames = new Map();     // file name (slug) -> the one spelling we use
const mergedMakes = new Map();   // spelling we folded in -> spelling we kept
function canonicalMake(make) {
  if (!make) return make;
  const key = slug(make);
  if (!makeNames.has(key)) makeNames.set(key, make);
  const kept = makeNames.get(key);
  if (kept !== make) mergedMakes.set(make, kept);
  return kept;
}

// ---------- NEW: FAMILIES (tested in preview-families.js) ----------

// Words that describe a VERSION of a car (powertrain or package), not a different car.
// Longer phrases come first, so "PLUG-IN HYBRID" is removed before "HYBRID" could be.
const VERSION_WORDS = [
  'PLUG-IN HYBRID',
  'INCOMPLETE CHASSIS',
  'HYBRID',
  'PHEV',
  'BEV',
  'PRIME',
  'SD',
  'CHASSIS',
];

// Removes version words from the END of a name, repeating until none are left
function stripVersion(model) {
  let name = model;
  let changed = true;
  while (changed) {
    changed = false;
    for (const word of VERSION_WORDS) {
      if (name.endsWith(' ' + word)) {
        name = name.slice(0, -(word.length + 1));
        changed = true;
      }
    }
    const xdrive = name.match(/^(.*) XDRIVE\d*$/);   // BMW: XDRIVE, XDRIVE60, ...
    if (xdrive) {
      name = xdrive[1];
      changed = true;
    }
  }
  return name;
}

// The family rule:
// 1. Strip version words from the end.
// 2. If what's left is ONE word of letters glued to a number (NX250),
//    AND those letters exist on their own as a family (NX), use just the letters.
function familyOf(model, baseNames) {
  const base = stripVersion(model);
  const glued = base.match(/^([A-Z]+)\d+[A-Z+]*$/);
  if (glued && baseNames.has(glued[1])) return glued[1];
  return base;
}

// "See also": which other families in the same make + year are related?
// Rule A: one name extends the other     ("BRONCO" <-> "BRONCO SPORT", "VENZA" <-> "REDUNDANT VENZA")
// Rule B: BMW-style series                ("3 SERIES" <-> "330I", "330E")
// Rule C: share the first two words, both 3+ words ("K 1600 GT" <-> "K 1600 GTL")
function seriesDigit(name) {
  const m = name.match(/^(\d) SERIES$/);
  return m ? m[1] : null;
}
function relatedFamilies(name, allFamilies) {
  const related = [];
  const myWords = name.split(' ');
  for (const other of allFamilies) {
    if (other === name) continue;
    const theirWords = other.split(' ');

    const ruleA =
      other.startsWith(name + ' ') || other.endsWith(' ' + name) ||
      name.startsWith(other + ' ') || name.endsWith(' ' + other);

    const mySeries = seriesDigit(name);
    const theirSeries = seriesDigit(other);
    const ruleB =
      (mySeries && /^\d/.test(other) && other[0] === mySeries) ||
      (theirSeries && /^\d/.test(name) && name[0] === theirSeries);

    const ruleC =
      myWords.length >= 3 && theirWords.length >= 3 &&
      myWords[0] === theirWords[0] && myWords[1] === theirWords[1];

    if (ruleA || ruleB || ruleC) related.push(other);
  }
  return related.sort();
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
    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    return null;
  }
}

// ---------- ASK NHTSA FOR THE FILE'S STAMP (WITHOUT DOWNLOADING IT) ----------
async function getSourceStamp() {
  try {
    const response = await fetch(ZIP_URL, { method: 'HEAD' });
    if (!response.ok) return null;
    return response.headers.get('etag') || response.headers.get('last-modified') || null;
  } catch (err) {
    return null;
  }
}

// ---------- TELL GITHUB ACTIONS WHETHER ANYTHING CHANGED ----------
function reportChanged(changed) {
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
  new AdmZip(ZIP_FILE).extractAllTo('raw', true);

  if (!fs.existsSync(RAW_FILE)) {
    throw new Error(`Unzipped, but ${RAW_FILE} was not inside. NHTSA may have renamed it.`);
  }
  console.log('Unzipped.\n');
}

// ---------- SANITY CHECKS ----------
function sanityCheck({ recallCount, vehicleRows, skippedRows }, previous) {
  console.log('Running safety checks…');

  if (recallCount < MIN_RECALLS) {
    throw new Error(`Only ${recallCount} recalls found (minimum is ${MIN_RECALLS}). The download may be broken.`);
  }
  console.log(`  ✓ Recall count ${recallCount.toLocaleString()} is above the ${MIN_RECALLS.toLocaleString()} minimum`);

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

  let liveTotal = 0;
  let missingTotal = 0;
  let carsChecked = 0;

  for (const car of REFEREE_CARS) {
    const label = `${car.year} ${car.make} ${car.model}`;
    const ours = vehicles.get(car.year)?.get(car.make)?.get(car.model) || new Set();

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
  const recalls = new Map();          // TABLE 1 — recall number -> details
  const vehicles = new Map();         // TABLE 2 — year -> make -> model -> recall numbers
  const recallVehicles = new Map();   // TABLE 3 — recall number -> every car it affects

  let vehicleRows = 0;
  let skippedRows = 0;

  const reader = readline.createInterface({
    input: fs.createReadStream(RAW_FILE),
    crlfDelay: Infinity,
  });

  for await (const line of reader) {
    const cols = line.split('\t');
    if (cols[COL.type] !== 'V') continue;
    vehicleRows += 1;

    const campaign = (cols[COL.campaign] || '').trim();
    const make = canonicalMake(clean(cols[COL.make]));
    const model = clean(cols[COL.model]);
    const year = Number(cols[COL.year]);

    if (!campaign || !make || !model || !(year >= 1949 && year <= NEWEST_YEAR)) {
      skippedRows += 1;
      continue;
    }

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
        doNotDrive: false,
        parkOutside: false,
      });
    }
    const recall = recalls.get(campaign);
    const component = (cols[COL.component] || '').trim();
    if (component) recall.components.add(component);
    if (isYes(cols[COL.doNotDrive])) recall.doNotDrive = true;
    if (isYes(cols[COL.parkOutside])) recall.parkOutside = true;

    if (!vehicles.has(year)) vehicles.set(year, new Map());
    const makes = vehicles.get(year);
    if (!makes.has(make)) makes.set(make, new Map());
    const models = makes.get(make);
    if (!models.has(model)) models.set(model, new Set());
    models.get(model).add(campaign);

    if (!recallVehicles.has(campaign)) recallVehicles.set(campaign, new Set());
    recallVehicles.get(campaign).add(`${year}|${make}|${model}`);
  }

  if (mergedMakes.size > 0) {
    console.log('Merged make spellings:');
    for (const [from, to] of mergedMakes) console.log(`  "${from}" → "${to}"`);
    console.log('');
  }

  sanityCheck({ recallCount: recalls.size, vehicleRows, skippedRows }, previous);
  await refereeCheck(vehicles);

  // ---------- WRITE THE TIDY FILES ----------
  fs.rmSync(OUT, { recursive: true, force: true });

  const years = [...vehicles.keys()].sort((a, b) => b - a);

  writeJson(`${OUT}/meta.json`, {
    builtAt: new Date().toISOString(),
    sourceStamp,
    recallCount: recalls.size,
    vehicleRows,
    years,
  });

  // A recall entry as it appears in lists (shared by models and families)
  function recallSummary(c) {
    const r = recalls.get(c);
    return {
      campaign: c,
      title: [...r.components][0] || 'Unknown part',
      doNotDrive: r.doNotDrive,
      parkOutside: r.parkOutside,
    };
  }

  let totalModels = 0;
  let totalFamilies = 0;
  let totalSeeAlso = 0;

  for (const year of years) {
    const makes = vehicles.get(year);
    const makeList = [];

    for (const [make, models] of makes) {
      const makeCampaigns = new Set();

      // ----- MODELS (unchanged, so today's app keeps working) -----
      const modelList = [];
      for (const [model, campaigns] of models) {
        campaigns.forEach((c) => makeCampaigns.add(c));
        const recallList = [...campaigns].sort().map(recallSummary);
        modelList.push({
          model,
          recallCount: campaigns.size,
          warningCount: recallList.filter((r) => r.doNotDrive || r.parkOutside).length,
          recalls: recallList,
        });
      }
      modelList.sort((a, b) => a.model.localeCompare(b.model));

      // ----- NEW: FAMILIES -----
      const baseNames = new Set([...models.keys()].map(stripVersion));
      const familyMap = new Map();   // family -> { members: Set, campaigns: Set }
      for (const [model, campaigns] of models) {
        const fam = familyOf(model, baseNames);
        if (!familyMap.has(fam)) familyMap.set(fam, { members: new Set(), campaigns: new Set() });
        familyMap.get(fam).members.add(model);
        campaigns.forEach((c) => familyMap.get(fam).campaigns.add(c));
      }

      const familyNames = [...familyMap.keys()].sort();
      const familyList = familyNames.map((fam) => {
        const { members, campaigns } = familyMap.get(fam);
        const memberList = [...members].sort();
        const recallList = [...campaigns].sort().map((c) => ({
          ...recallSummary(c),
          // Which of this family's names was this recall filed under?
          filedAs: memberList.filter((m) => models.get(m).has(c)),
        }));
        const seeAlso = relatedFamilies(fam, familyNames);
        if (seeAlso.length > 0) totalSeeAlso += 1;
        return {
          family: fam,
          members: memberList,
          recallCount: campaigns.size,
          warningCount: recallList.filter((r) => r.doNotDrive || r.parkOutside).length,
          seeAlso,
          recalls: recallList,
        };
      });

      totalModels += models.size;
      totalFamilies += familyList.length;

      const makeSlug = slug(make);
      writeJson(`${OUT}/years/${year}/${makeSlug}.json`, {
        year,
        make,
        models: modelList,       // old format — keep until the app is updated
        families: familyList,    // NEW format
      });

      makeList.push({
        make,
        slug: makeSlug,
        recallCount: makeCampaigns.size,
        modelCount: models.size,
        familyCount: familyList.length,   // NEW
      });
    }

    makeList.sort((a, b) => a.make.localeCompare(b.make));
    writeJson(`${OUT}/years/${year}.json`, { year, makes: makeList });
  }

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
  const all = [...recalls.values()];
  const dndOnly = all.filter((r) => r.doNotDrive && !r.parkOutside);
  const parkOnly = all.filter((r) => !r.doNotDrive && r.parkOutside);
  const both = all.filter((r) => r.doNotDrive && r.parkOutside);

  console.log(`Vehicle rows read:   ${vehicleRows.toLocaleString()}`);
  console.log(`Rows skipped:        ${skippedRows.toLocaleString()}`);
  console.log(`Unique recalls:      ${recalls.size.toLocaleString()}`);
  console.log(`Model years:         ${years.length} (${years[years.length - 1]}–${years[0]})`);
  console.log(`Makes merged:        ${mergedMakes.size}`);
  console.log(`Do Not Drive only:   ${dndOnly.length}`);
  console.log(`Park Outside only:   ${parkOnly.length}`);
  console.log(`Both warnings:       ${both.length}`);
  console.log(`Model names:         ${totalModels.toLocaleString()}`);
  console.log(`Families:            ${totalFamilies.toLocaleString()}`);
  console.log(`Families w/ See also: ${totalSeeAlso.toLocaleString()}`);
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
