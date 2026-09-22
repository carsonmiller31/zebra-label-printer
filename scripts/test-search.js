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

// A call-in is typed fast; the list has to keep up with the keystrokes.
const t0 = Date.now();
for (let i = 0; i < 300; i++) DrugSearch.suggest('sertaline');
const perWorst = (Date.now() - t0) / 300;
const t1 = Date.now();
for (let i = 0; i < 300; i++) DrugSearch.suggest('ator');
const perBest = (Date.now() - t1) / 300;
process.stdout.write(`typo search ${perWorst.toFixed(2)} ms, clean prefix ${perBest.toFixed(2)} ms\n`);

process.exit(failures.length ? 1 : 0);
