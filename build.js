// build.js — turns NHTSA's giant recall file into tidy files for the app
// LESSON 14 VERSION (B): last 20 model years, PLUS urgent recalls for older vehicles
// LESSON 17: adds NHTSA crash-test ratings (2011+), attached to families that match by name

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

// NEW (Lesson 17): NHTSA's 5-Star crash-test ratings
const RATINGS_URL = 'https://static.nhtsa.gov/nhtsa/downloads/Safercar/Safercar_data.csv';
const RATINGS_FIRST_YEAR = 2011;   // NHTSA's current crash tests began with 2011 models
const MIN_RATING_ROWS = 5000;      // fewer than this means the download is probably broken
// A "known answer": if we read this car wrong, our column reading is broken
const RATING_REFEREE = { year: 2024, make: 'LEXUS', model: 'NX 350H', front: 4, side: 5 };

// MODEL-YEAR WINDOW — the app shows all recalls for recent model years.
// Older vehicles appear ONLY if they have an urgent recall (Do Not Drive / Park Outside).
const YEARS_TO_PUBLISH = 20;
const NEWEST_YEAR = new Date().getFullYear() + 2;
const OLDEST_YEAR = new Date().getFullYear() - (YEARS_TO_PUBLISH - 1);   // e.g. 2007

// SAFETY LIMITS (these measure NHTSA's WHOLE file, so trimming years doesn't trip them)
const MIN_RECALLS = 10000;
const MAX_DROP = 0.98;
const MAX_SKIPPED_SHARE = 0.01;
const MAX_REFEREE_MISSING = 0.25;

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
  campaign: 1, make: 2, model: 3, year: 4, component: 6,
  buildStart: 8, buildEnd: 9, type: 10, affected: 11,
  description: 19, consequence: 20, remedy: 21,
  doNotDrive: 27,    // column 28: "Do Not Drive" (text: Yes/No)
  parkOutside: 28,   // column 29: "Park Outside" (text: Yes/No)
};

function clean(text) {
  return (text || '').trim().toUpperCase();
}

function isYes(text) {
  return clean(text) === 'YES';
}

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---------- CSV READING AND RATING MATCHING (NEW in Lesson 17) ----------
// Reads the WHOLE file one letter at a time, so commas and Enter keys
// inside "quotes" stay part of the value.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let current = '';
  let insideQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (insideQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { current += '"'; i++; }
        else insideQuotes = false;
      } else current += ch;
    } else if (ch === '"') insideQuotes = true;
    else if (ch === ',') { row.push(current); current = ''; }
    else if (ch === '\n') { row.push(current); rows.push(row); row = []; current = ''; }
    else if (ch !== '\r') current += ch;
  }
  if (current !== '' || row.length > 0) { row.push(current); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

// Spaces and hyphens don't count when comparing names (NX 250 = NX250, S-CLASS = S CLASS)
function squashName(name) {
  return name.replace(/[\s-]+/g, '');
}

// Rule A: same as one of the family's members, ignoring spaces and hyphens
// Rule B: the LONGEST family name the rating name starts with (GRAND CHEROKEE L -> GRAND CHEROKEE L)
// No match -> null. We show no rating rather than guess.
function matchFamily(ratingModel, families) {
  const target = squashName(ratingModel);
  for (const f of families) {
    if (f.members.some((m) => squashName(m) === target)) return f.family;
  }
  let best = null;
  for (const f of families) {
    const name = f.family;
    if (ratingModel === name || ratingModel.startsWith(name + ' ')) {
      if (!best || name.length > best.length) best = name;
    }
  }
  return best;
}

// A star rating is a whole number from 1 to 5. Anything else (blank, "Not Rated") -> null.
function stars(text) {
  const n = Number((text || '').trim());
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

// ---------- ONE NAME PER MAKE ----------
const makeNames = new Map();
const mergedMakes = new Map();
function canonicalMake(make) {
  if (!make) return make;
  const key = slug(make);
  if (!makeNames.has(key)) makeNames.set(key, make);
  const kept = makeNames.get(key);
  if (kept !== make) mergedMakes.set(make, kept);
  return kept;
}

// ---------- FAMILIES ----------
const VERSION_WORDS = [
  'PLUG-IN HYBRID', 'INCOMPLETE CHASSIS', 'HYBRID', 'PHEV', 'BEV', 'PRIME', 'SD', 'CHASSIS',
];

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
    const xdrive = name.match(/^(.*) XDRIVE\d*$/);
    if (xdrive) {
      name = xdrive[1];
      changed = true;
    }
  }
  return name;
}

function familyOf(model, baseNames) {
  const base = stripVersion(model);
  const glued = base.match(/^([A-Z]+)\d+[A-Z+]*$/);
  if (glued && baseNames.has(glued[1])) return glued[1];
  return base;
}

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

// ---------- FILE WRITING ----------
let fileCount = 0;
let totalBytes = 0;
function writeJson(filePath, data) {
  const text = JSON.stringify(data);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
  fileCount += 1;
  totalBytes += Buffer.byteLength(text);
}

// ---------- ROBOT MEMORY / STAMP / GITHUB OUTPUT ----------
async function getPublishedMeta() {
  try {
    const response = await fetch(PUBLISHED_META_URL);
    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    return null;
  }
}

// CHANGED (Lesson 17): works for any file, so we can stamp both recalls and ratings
async function getStamp(url) {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    if (!response.ok) return null;
    return response.headers.get('etag') || response.headers.get('last-modified') || null;
  } catch (err) {
    return null;
  }
}

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

// ---------- SANITY CHECKS (whole file) ----------
function sanityCheck({ fileRecallCount, vehicleRows, skippedRows }, previous) {
  console.log('Running safety checks…');
  if (fileRecallCount < MIN_RECALLS) {
    throw new Error(`Only ${fileRecallCount} recalls in NHTSA's file (minimum is ${MIN_RECALLS}). The download may be broken.`);
  }
  console.log(`  ✓ NHTSA's file has ${fileRecallCount.toLocaleString()} recalls (minimum ${MIN_RECALLS.toLocaleString()})`);

  const previousFileCount = previous && (previous.fileRecallCount || previous.recallCount);
  if (previousFileCount) {
    const lowestAllowed = Math.floor(previousFileCount * MAX_DROP);
    if (fileRecallCount < lowestAllowed) {
      throw new Error(`NHTSA's file dropped from ${previousFileCount} to ${fileRecallCount} recalls. Refusing to publish.`);
    }
    const change = fileRecallCount - previousFileCount;
    console.log(`  ✓ Compared to last publish: ${previousFileCount.toLocaleString()} → ${fileRecallCount.toLocaleString()} (${change >= 0 ? '+' : ''}${change})`);
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

// ---------- CRASH-TEST RATINGS (NEW in Lesson 17) ----------
// Recalls are the safety-critical part, so a ratings problem never blocks them:
// if anything here looks wrong, we skip ratings for this run and keep going.
async function loadRatings() {
  console.log('Loading crash-test ratings…');
  try {
    const response = await fetch(RATINGS_URL);
    if (!response.ok) throw new Error(`NHTSA answered with code ${response.status}`);
    const all = parseCsv(await response.text());

    const header = all[0].map((h) => h.trim());
    const col = (name) => {
      const i = header.indexOf(name);
      if (i === -1) throw new Error(`column ${name} is missing`);
      return i;
    };
    const C = {
      make: col('MAKE'), model: col('MODEL'), year: col('MODEL_YR'), drive: col('DRIVE_TRAIN'),
      overall: col('OVERALL_STARS'), front: col('OVERALL_FRNT_STARS'),
      side: col('OVERALL_SIDE_STARS'), rollover: col('ROLLOVER_STARS'),
    };

    const byYearMake = new Map();   // "2024|lexus" -> list of rated versions
    const names = new Set();
    let rows = 0;
    let badRows = 0;
    for (const v of all.slice(1)) {
      if (v.length !== header.length) { badRows += 1; continue; }
      const year = Number(v[C.year].trim());
      if (!(year >= RATINGS_FIRST_YEAR && year <= NEWEST_YEAR)) continue;
      const make = clean(v[C.make]);
      const model = clean(v[C.model]);
      if (!make || !model) continue;
      rows += 1;
      names.add(`${year}|${slug(make)}|${model}`);
      const key = `${year}|${slug(make)}`;
      if (!byYearMake.has(key)) byYearMake.set(key, []);
      byYearMake.get(key).push({
        model,
        drive: clean(v[C.drive]) || null,
        overall: stars(v[C.overall]),
        front: stars(v[C.front]),
        side: stars(v[C.side]),
        rollover: stars(v[C.rollover]),
      });
    }

    if (rows < MIN_RATING_ROWS) {
      throw new Error(`only ${rows} rated rows for ${RATINGS_FIRST_YEAR}+ (minimum ${MIN_RATING_ROWS})`);
    }
    if (badRows / (all.length - 1) > MAX_SKIPPED_SHARE) {
      throw new Error(`${badRows} rows had the wrong number of columns`);
    }

    // The control test: read a car whose answer we already know
    const ref = RATING_REFEREE;
    const refRow = (byYearMake.get(`${ref.year}|${slug(ref.make)}`) || []).find((r) => r.model === ref.model);
    if (!refRow || refRow.front !== ref.front || refRow.side !== ref.side) {
      throw new Error(`known-answer check failed for ${ref.year} ${ref.make} ${ref.model}`);
    }

    console.log(`  ✓ ${rows.toLocaleString()} rated rows for ${RATINGS_FIRST_YEAR}+, ${badRows} bad rows`);
    console.log(`  ✓ Known-answer check: ${ref.year} ${ref.make} ${ref.model} front ${refRow.front}★, side ${refRow.side}★\n`);
    return { byYearMake, nameCount: names.size };
  } catch (err) {
    console.log(`  ⚠ Ratings skipped this run: ${err.message}. Recalls will still publish.\n`);
    return null;
  }
}

// ---------- BUILD ----------
async function build(previous, sourceStamp) {
  const recalls = new Map();          // recall number -> details
  const vehicles = new Map();         // year -> make -> model -> recall numbers
  const recallVehicles = new Map();   // recall number -> every car it affects
  const fileCampaigns = new Set();    // every recall in NHTSA's file (for safety checks)
  const urgentCampaigns = new Set();  // NEW: recalls with Do Not Drive / Park Outside on ANY row
  const olderRows = [];               // NEW: the "maybe" pile — rows older than the window

  let vehicleRows = 0;
  let skippedRows = 0;

  // NEW: one place that adds a row to the three tables (used for normal rows AND kept older rows)
  function addRow(cols, campaign, make, model, year) {
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

    fileCampaigns.add(campaign);
    if (isYes(cols[COL.doNotDrive]) || isYes(cols[COL.parkOutside])) {
      urgentCampaigns.add(campaign);
    }

    if (year < OLDEST_YEAR) {
      olderRows.push({ cols, campaign, make, model, year });   // decide later, with the full picture
      continue;
    }
    addRow(cols, campaign, make, model, year);
  }

  // NEW: from the "maybe" pile, keep only rows whose recall is urgent
  let olderKept = 0;
  for (const r of olderRows) {
    if (urgentCampaigns.has(r.campaign)) {
      addRow(r.cols, r.campaign, r.make, r.model, r.year);
      olderKept += 1;
    }
  }

  if (mergedMakes.size > 0) {
    console.log('Merged make spellings:');
    for (const [from, to] of mergedMakes) console.log(`  "${from}" → "${to}"`);
    console.log('');
  }

  sanityCheck({ fileRecallCount: fileCampaigns.size, vehicleRows, skippedRows }, previous);
  await refereeCheck(vehicles);
  const ratings = await loadRatings();          // NEW: null if ratings were skipped
  const ratedNamesMatched = new Set();          // NEW: for the report
  let familiesWithRatings = 0;

  // ---------- WRITE ----------
  fs.rmSync(OUT, { recursive: true, force: true });

  const years = [...vehicles.keys()].sort((a, b) => b - a);
  const olderYears = years.filter((y) => y < OLDEST_YEAR);

  writeJson(`${OUT}/meta.json`, {
    builtAt: new Date().toISOString(),
    sourceStamp,
    fileRecallCount: fileCampaigns.size,
    recallCount: recalls.size,
    oldestYear: OLDEST_YEAR,
    urgentOnlyBefore: OLDEST_YEAR,   // years below this show urgent recalls only
    ratingsFrom: RATINGS_FIRST_YEAR, // NEW: years below this show the "2011 and newer" note
    ratingsAvailable: ratings !== null,
    vehicleRows,
    years,
  });

  function recallSummary(c) {
    const r = recalls.get(c);
    return {
      campaign: c,
      title: [...r.components][0] || 'Unknown part',
      doNotDrive: r.doNotDrive,
      parkOutside: r.parkOutside,
    };
  }

  let totalFamilies = 0;
  let totalSeeAlso = 0;

  for (const year of years) {
    const makes = vehicles.get(year);
    const makeList = [];

    for (const [make, models] of makes) {
      const makeCampaigns = new Set();
      for (const campaigns of models.values()) {
        campaigns.forEach((c) => makeCampaigns.add(c));
      }

      const baseNames = new Set([...models.keys()].map(stripVersion));
      const familyMap = new Map();
      for (const [model, campaigns] of models) {
        const fam = familyOf(model, baseNames);
        if (!familyMap.has(fam)) familyMap.set(fam, { members: new Set(), campaigns: new Set() });
        familyMap.get(fam).members.add(model);
        campaigns.forEach((c) => familyMap.get(fam).campaigns.add(c));
      }

      const familyNames = [...familyMap.keys()].sort();

      // NEW: attach crash-test ratings that match one of these families by name
      const familyRatings = new Map();
      const rated = (ratings && ratings.byYearMake.get(`${year}|${slug(make)}`)) || [];
      if (rated.length > 0) {
        const famObjs = familyNames.map((f) => ({ family: f, members: [...familyMap.get(f).members] }));
        for (const r of rated) {
          const fam = matchFamily(r.model, famObjs);
          if (!fam) continue;   // no match: show no rating rather than guess
          if (!familyRatings.has(fam)) familyRatings.set(fam, []);
          familyRatings.get(fam).push(r);
          ratedNamesMatched.add(`${year}|${make}|${r.model}`);
        }
      }
      const familyList = familyNames.map((fam) => {
        const { members, campaigns } = familyMap.get(fam);
        const memberList = [...members].sort();
        const recallList = [...campaigns].sort().map((c) => ({
          ...recallSummary(c),
          filedAs: memberList.filter((m) => models.get(m).has(c)),
        }));
        const seeAlso = relatedFamilies(fam, familyNames);
        if (seeAlso.length > 0) totalSeeAlso += 1;
        if (familyRatings.has(fam)) familiesWithRatings += 1;
        return {
          family: fam,
          members: memberList,
          recallCount: campaigns.size,
          warningCount: recallList.filter((r) => r.doNotDrive || r.parkOutside).length,
          seeAlso,
          // NEW: one entry per rated version and drive; empty if none matched
          ratings: (familyRatings.get(fam) || []).sort(
            (a, b) => a.model.localeCompare(b.model) || (a.drive || '').localeCompare(b.drive || '')
          ),
          recalls: recallList,
        };
      });

      totalFamilies += familyList.length;

      const makeSlug = slug(make);
      writeJson(`${OUT}/years/${year}/${makeSlug}.json`, { year, make, families: familyList });

      makeList.push({
        make,
        slug: makeSlug,
        recallCount: makeCampaigns.size,
        modelCount: models.size,
        familyCount: familyList.length,
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

  console.log(`Model-year window:   ${OLDEST_YEAR}–${years[0]} (all recalls)`);
  console.log(`Older years kept:    ${olderYears.length ? `${olderYears[olderYears.length - 1]}–${olderYears[0]}` : 'none'} (urgent recalls only)`);
  console.log(`Older rows:          ${olderRows.length.toLocaleString()} set aside, ${olderKept.toLocaleString()} kept as urgent`);
  console.log(`Recalls in file:     ${fileCampaigns.size.toLocaleString()}`);
  console.log(`Recalls published:   ${recalls.size.toLocaleString()}`);
  console.log(`Model years:         ${years.length}`);
  console.log(`Do Not Drive only:   ${dndOnly.length}`);
  console.log(`Park Outside only:   ${parkOnly.length}`);
  console.log(`Both warnings:       ${both.length}`);
  console.log(`Families:            ${totalFamilies.toLocaleString()}`);
  console.log(`Families w/ See also: ${totalSeeAlso.toLocaleString()}`);
  if (ratings) {
    const share = ((ratedNamesMatched.size / ratings.nameCount) * 100).toFixed(1);
    console.log(`Rated names matched: ${ratedNamesMatched.size.toLocaleString()} of ${ratings.nameCount.toLocaleString()} (${share}%)`);
    console.log(`Families w/ ratings: ${familiesWithRatings.toLocaleString()}`);
  } else {
    console.log('Crash ratings:       skipped this run');
  }
  console.log(`Files written:       ${fileCount.toLocaleString()}`);
  console.log(`Total size:          ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
}

// ---------- RUN EVERYTHING, IN ORDER ----------
async function main() {
  const previous = await getPublishedMeta();
  // CHANGED (Lesson 17): rebuild if EITHER file changed
  const recallStamp = await getStamp(ZIP_URL);
  const ratingsStamp = await getStamp(RATINGS_URL);
  const sourceStamp = recallStamp && ratingsStamp ? `${recallStamp} + ${ratingsStamp}` : null;
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
