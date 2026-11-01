// preview-families.js — a quick look at how models would group into families
// Usage:   node preview-families.js MAKE YEAR
// Example: node preview-families.js LEXUS 2024
// This only READS the raw file. It changes nothing and publishes nothing.
// VERSION 3: adds "See also" suggestions between related families

const fs = require('fs');
const readline = require('readline');

const RAW_FILE = 'raw/FLAT_RCL_POST_2010.txt';

// Read the make and year you typed after the command
const [, , makeArg, yearArg] = process.argv;
if (!makeArg || !yearArg) {
  console.log('Usage: node preview-families.js MAKE YEAR   (example: node preview-families.js LEXUS 2024)');
  process.exit(1);
}
const MAKE = makeArg.toUpperCase();
const YEAR = String(yearArg);

function clean(text) {
  return (text || '').trim().toUpperCase();
}

// VERSION WORDS — describe a version of a car (powertrain or package), not a different car.
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

// THE FAMILY RULE
// 1. Strip version words from the end.
// 2. If what's left is ONE word of letters glued to a number (NX250),
//    AND those letters exist on their own as a family (NX), use just the letters.
function familyOf(model, baseNames) {
  const base = stripVersion(model);
  const glued = base.match(/^([A-Z]+)\d+[A-Z+]*$/);
  if (glued && baseNames.has(glued[1])) return glued[1];
  return base;
}

// NEW: "SEE ALSO" — which other families in the same make + year are related?
// Rule A: one name extends the other     ("BRONCO" <-> "BRONCO SPORT", "VENZA" <-> "REDUNDANT VENZA")
// Rule B: BMW-style series                ("3 SERIES" <-> "330I", "330E")
function seriesDigit(name) {
  const m = name.match(/^(\d) SERIES$/);
  return m ? m[1] : null;
}
function relatedFamilies(name, allFamilies) {
  const related = [];
  for (const other of allFamilies) {
    if (other === name) continue;

    const extends1 = other.startsWith(name + ' ') || other.endsWith(' ' + name);
    const extends2 = name.startsWith(other + ' ') || name.endsWith(' ' + other);

    const mySeries = seriesDigit(name);
    const theirSeries = seriesDigit(other);
    const seriesMatch =
      (mySeries && /^\d/.test(other) && other[0] === mySeries) ||
      (theirSeries && /^\d/.test(name) && name[0] === theirSeries);

    if (extends1 || extends2 || seriesMatch) related.push(other);
  }
  return related.sort();
}

async function main() {
  // Collect every model name for this make + year, and the recalls filed under each
  const models = new Map();   // model -> Set of recall numbers
  const reader = readline.createInterface({
    input: fs.createReadStream(RAW_FILE),
    crlfDelay: Infinity,
  });

  for await (const line of reader) {
    const cols = line.split('\t');
    if (cols[10] !== 'V') continue;                       // vehicles only
    if (clean(cols[2]) !== MAKE) continue;                // this make only
    if ((cols[4] || '').trim() !== YEAR) continue;        // this year only
    const model = clean(cols[3]);
    if (!model) continue;
    if (!models.has(model)) models.set(model, new Set());
    models.get(model).add((cols[1] || '').trim());
  }

  if (models.size === 0) {
    console.log(`No recalls found for ${YEAR} ${MAKE}. Check the spelling (use NHTSA's spelling, e.g. MERCEDES-BENZ).`);
    return;
  }

  // Group the models into families
  const baseNames = new Set([...models.keys()].map(stripVersion));
  const families = new Map();       // family -> Map(model -> recall count)
  const familyRecalls = new Map();  // family -> Set of unique recall numbers

  for (const [model, recalls] of models) {
    const family = familyOf(model, baseNames);
    if (!families.has(family)) {
      families.set(family, new Map());
      familyRecalls.set(family, new Set());
    }
    families.get(family).set(model, recalls.size);
    recalls.forEach((r) => familyRecalls.get(family).add(r));
  }

  // Print the result
  const allFamilies = [...families.keys()].sort();
  let linkedCount = 0;

  console.log(`\n${YEAR} ${MAKE}: ${models.size} model names → ${families.size} families\n`);
  for (const family of allFamilies) {
    const members = families.get(family);
    console.log(`${family}  (${familyRecalls.get(family).size} unique recalls)`);
    for (const [model, count] of [...members].sort()) {
      console.log(`   ${model.padEnd(28, '.')} ${count}`);
    }
    const seeAlso = relatedFamilies(family, allFamilies);
    if (seeAlso.length > 0) {
      linkedCount += 1;
      console.log(`   → See also: ${seeAlso.join(', ')}`);
    }
    console.log('');
  }
  console.log(`${linkedCount} of ${families.size} families have a "See also" suggestion.\n`);
}

main();