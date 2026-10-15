'use strict';
/*
 * What the drug box has to get right.
 *
 * Each case is what someone actually types while a prescriber's office is
 * talking — abbreviations, half-words, and the spelling mistakes that come of
 * typing and listening at once — paired with the drug it has to land on.
 *
 *     node scripts/test-search.js
 */

global.CommonDrugs = require('../public/paper/drugs.js');
const DrugSearch = require('../public/paper/drugsearch.js');

const CASES = [
  // --- Typed in full, spelled right ---------------------------------------
  ['atorvastatin', 'Atorvastatin'], ['levothyroxine', 'Levothyroxine'],
  ['metformin', 'Metformin'],       ['amoxicillin', 'Amoxicillin'],
  ['prednisone', 'Prednisone'],     ['gabapentin', 'Gabapentin'],

  // --- Half typed ----------------------------------------------------------
  ['ator', 'Atorvastatin'],   ['amox', 'Amoxicillin'],   ['levo', 'Levothyroxine'],
  ['met', 'Metformin'],       ['pred', 'Prednis'],       ['omep', 'Omeprazole'],
  ['lisin', 'Lisinopril'],    ['gaba', 'Gabapentin'],    ['sertr', 'Sertraline'],
  ['hydroch', 'Hydrochlorothiazide'],

  // --- Misspelt ------------------------------------------------------------
  ['sertaline', 'Sertraline'],          ['amoxicilin', 'Amoxicillin'],
  ['atorvsatatin', 'Atorvastatin'],     ['hydrochlorothiazde', 'Hydrochlorothiazide'],
  ['levothyroxin', 'Levothyroxine'],    ['metfromin', 'Metformin'],
  ['lisnopril', 'Lisinopril'],          ['gabbapentin', 'Gabapentin'],
  ['omeprazol', 'Omeprazole'],          ['azithromyicin', 'Azithromycin'],
  ['prednisolne', 'Prednisolone'],      ['furosemied', 'Furosemide'],
  ['montelukst', 'Montelukast'],        ['escitalopam', 'Escitalopram'],
  ['pantoprazol', 'Pantoprazole'],      ['rosuvastatn', 'Rosuvastatin'],
  ['clopidogril', 'Clopidogrel'],       ['duloxetin', 'Duloxetine'],
  ['trazadone', 'Trazodone'],           ['carvedalol', 'Carvedilol'],
  ['tamsolusin', 'Tamsulosin'],         ['alprazolm', 'Alprazolam'],
  ['cyclobenzprine', 'Cyclobenzaprine'],['meloxicm', 'Meloxicam'],

  // --- By brand, current and retired --------------------------------------
  ['lipitor', 'Atorvastatin'],   ['synthroid', 'Levothyroxine'],
  ['norco', 'Hydrocodone'],      ['percocet', 'Oxycodone'],
  ['coumadin', 'Warfarin'],      ['vicodin', 'Hydrocodone'],
  ['zofran', 'Ondansetron'],     ['flexeril', 'Cyclobenzaprine'],
  ['lasix', 'Furosemide'],       ['zestril', 'Lisinopril'],
  ['glucophage', 'Metformin'],   ['klonopin', 'Clonazepam'],
  ['ativan', 'Lorazepam'],       ['prilosec', 'Omeprazole'],
  ['eliquis', 'Apixaban'],       ['augmentin', 'Amoxicillin/Clavulanate'],
  ['bactrim', 'Sulfamethoxazole'],

  // --- Abbreviations used at the counter -----------------------------------
  ['hctz', 'Hydrochlorothiazide'], ['apap', 'Acetaminophen'],
  ['asa', 'Aspirin'],              ['mtx', 'Methotrexate'],

  // --- Part of a combination ----------------------------------------------
  ['clav', 'Clavulanate'],        ['amox clav', 'Amoxicillin/Clavulanate'],
  ['carbidopa', 'Carbidopa'],     ['sulfameth', 'Sulfamethoxazole'],

  // --- With a strength -----------------------------------------------------
  ['atorva 40', 'Atorvastatin 40 mg'], ['metformin 500', 'Metformin 500 mg'],
  ['lisinopril 10', 'Lisinopril 10 mg'],
];

let pass = 0;
const failures = [];
for (const [query, want] of CASES) {
  const top = (DrugSearch.suggest(query)[0] || {}).text || '';
  if (top.toLowerCase().includes(want.toLowerCase())) pass++;
  else failures.push({ query, want, got: top || '— nothing —' });
}

for (const f of failures) {
  process.stdout.write(`  FAIL  ${f.query.padEnd(20)} want ${f.want.padEnd(24)} got ${f.got}\n`);
}
process.stdout.write(`\n${pass}/${CASES.length} passed\n`);

// --- DEA schedule of the drug line ------------------------------------------
// A CII stops the form; a CIII–CV needs a DEA number. Getting it wrong either
// way matters, so non-controlled lines that sit close to controlled ones are
// here too. 0 = not controlled.
const SCHEDULES = [
  ['Oxycodone 5 mg tablet', 2],   ['oxycodne 5mg', 2],           ['Norco 10/325', 2],
  ['percocet 5/325', 2],          ['Adderall 20', 2],            ['codeine 30 mg', 2],
  ['APAP w/ codeine 300/30', 3],  ['Tylenol with Codeine 300 mg-30 mg tablet', 3],
  ['Suboxone 8-2', 3],            ['dronabinol 5 mg capsule', 3], ['dronabinol 5 mg', 2],
  ['tramadol 50', 4],             ['Xanax 1mg', 4],              ['alprazolm 0.5', 4],
  ['Ambien 10', 4],               ['promethazine with codeine syrup', 5],
  ['Lyrica 75', 5],               ['Lomotil', 5],
  ['promethazine 25 mg', 0],      ['gabapentin 300', 0],         ['hydrochlorothiazide 25', 0],
  ['hydroxyzine 25', 0],          ['Acetaminophen 325', 0],      ['Atorvastatin 40 mg tablet', 0],
];
const schedFail = [];
for (const [line, want] of SCHEDULES) {
  const got = (DrugSearch.schedule(line) || {}).schedule || 0;
  if (got !== want) schedFail.push(`  FAIL  ${line.padEnd(42)} want ${want} got ${got}`);
}
for (const f of schedFail) process.stdout.write(`${f}\n`);
process.stdout.write(`${SCHEDULES.length - schedFail.length}/${SCHEDULES.length} schedules right\n`);

// A call-in is typed fast; the list has to keep up with the keystrokes.
const t0 = Date.now();
for (let i = 0; i < 300; i++) DrugSearch.suggest('sertaline');
const perWorst = (Date.now() - t0) / 300;
const t1 = Date.now();
for (let i = 0; i < 300; i++) DrugSearch.suggest('ator');
const perBest = (Date.now() - t1) / 300;
process.stdout.write(`typo search ${perWorst.toFixed(2)} ms, clean prefix ${perBest.toFixed(2)} ms\n`);

process.exit(failures.length || schedFail.length ? 1 : 0);
