'use strict';
/*
 * Builds public/paper/drugs.js from RxNorm.
 *
 * Which drugs belong on the list is a judgement call — what actually gets
 * phoned in to a community pharmacy — and that judgement lives in
 * scripts/drug-names.txt, one name per line, edited by hand.
 *
 * Every *fact* about those drugs comes from RxNorm's Current Prescribable
 * Content — human drugs currently marketed in the US, as published by the US
 * National Library of Medicine: the strengths that exist, the dose forms they
 * come in, and the brand each is sold under. Nothing here is written from
 * memory, so the list can be re-checked by re-running:
 *
 *     node scripts/build-drug-list.js
 *
 * Responses are cached under scripts/.rxnorm-cache/ so a re-run is fast and
 * offline. Delete that folder to refresh against RxNorm.
 *
 * The DEA schedule comes from somewhere else: RxNorm doesn't carry it, but the
 * FDA's National Drug Code Directory does, on every listed product. The whole
 * directory is downloaded once into scripts/.openfda-cache/ (delete it to
 * refresh) and each entry takes the schedule its products are listed under.
 */

const fs = require('fs');
const path = require('path');

/** Drugs RxNorm only files under an ester or salt name. */
const ALIAS = {
  'Dabigatran': 'dabigatran etexilate',
  'Loteprednol': 'loteprednol etabonate',
  'Amphetamine Salts': 'amphetamine',
  'Insulin Human NPH': 'insulin isophane',
  'Betamethasone Dipropionate': 'betamethasone',
  'Betamethasone Valerate': 'betamethasone',
  'Hydrocortisone Valerate': 'hydrocortisone',
  'Triamcinolone Acetonide': 'triamcinolone',
  'Fluocinolone Acetonide': 'fluocinolone',
  'Clobetasol Propionate': 'clobetasol',
  'Mometasone Furoate': 'mometasone',
  'Fluticasone Propionate': 'fluticasone',
  'Fluticasone Furoate': 'fluticasone',
  'Doxycycline Hyclate': 'doxycycline',
  'Diclofenac Sodium': 'diclofenac',
  'Diclofenac Potassium': 'diclofenac',
  'Naproxen Sodium': 'naproxen',
  'Morphine Sulfate': 'morphine',
  'Albuterol Sulfate': 'albuterol',
  'Hydroxyzine HCl': 'hydroxyzine',
  'Testosterone Cypionate': 'testosterone',
  'Lithium Carbonate': 'lithium',
  'Estrogens Conjugated': 'conjugated estrogens',
  'Vitamin D (Ergocalciferol)': 'ergocalciferol',
  'Phytonadione (Vitamin K)': 'phytonadione',
  'Vitamin E': 'alpha-tocopherol',
  'Tenofovir Disoproxil': 'tenofovir disoproxil fumarate',
  'Polyethylene Glycol 3350': 'polyethylene glycol 3350',
  'Sulfamethoxazole/Trimethoprim': 'sulfamethoxazole',
  'Divalproex': 'divalproex sodium',
  'Fluorouracil Topical': 'fluorouracil',
};
const { parse, conventional, unifyUnits, byDose } = require('./rxnorm.js');

const ROOT = path.join(__dirname, '..');
const NAMES = path.join(__dirname, 'drug-names.txt');
const ALIASES = path.join(__dirname, 'brand-aliases.txt');
const OUT = path.join(ROOT, 'public', 'paper', 'drugs.js');
const CACHE = path.join(__dirname, '.rxnorm-cache');
const FDA_CACHE = path.join(__dirname, '.openfda-cache');
const FDA_ZIP = 'https://download.open.fda.gov/drug/ndc/drug-ndc-0001-of-0001.json.zip';

// The Current Prescribable Content subset: human drugs currently marketed in
// the US. Plain /REST/drugs.json also carries veterinary and withdrawn
// products — it will happily offer "Amoxi-tabs 150 mg", which is for dogs.
const API = 'https://rxnav.nlm.nih.gov/REST/Prescribe/drugs.json?name=';
const CONCURRENCY = 6;      // RxNav asks for a light touch
const MIN_STRENGTHS = 1;
const MAX_STRENGTHS = 12;   // a suggestion list, not a formulary
const MAX_BRANDS = 6;       // enough to catch what an office might say

fs.mkdirSync(CACHE, { recursive: true });

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

async function fetchDrug(name) {
  // RxNorm searches on the ingredient, so a combination is looked up by its
  // first ingredient and filtered afterwards by ingredient count. A handful
  // are only filed under their ester or salt.
  const term = ALIAS[name] || name.split('/')[0].trim();

  // Cache on the term, not the display name: two entries that share an
  // ingredient share a response, and changing an alias invalidates the right
  // file instead of replaying the old lookup's failure.
  const file = path.join(CACHE, `${slug(term)}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const res = await fetch(API + encodeURIComponent(term));
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const body = await res.json();
  fs.writeFileSync(file, JSON.stringify(body));
  await new Promise((r) => setTimeout(r, 60));
  return body;
}

function conceptsOf(body, tty) {
  const groups = (body.drugGroup && body.drugGroup.conceptGroup) || [];
  const hit = groups.find((g) => g.tty === tty);
  return (hit && hit.conceptProperties) || [];
}

/*
 * RxNorm names the salt, we name the drug: alendronate is filed as "alendronic
 * acid", divalproex as "valproic acid". Matching on a stem rather than the
 * whole word lets those through without letting anything unrelated in.
 */
const stem = (w) => w.toLowerCase().replace(/[^a-z]/g, '').slice(0, 6);

/** Every strength/form RxNorm lists for this drug, grouped by dose form. */
function shapesFor(name, body) {
  const ingredients = name.split('/').length;
  const wanted = name.toLowerCase().split('/').map((p) => stem(p.trim().split(' ')[0]));

  const byForm = new Map();
  const brandFor = new Map();   // form → Map(brand → how many strengths carry it)
  let products = 0;             // how many distinct products RxNorm lists

  const add = (concept, brand) => {
    const parsed = conventional(parse(concept.name, { ingredients }), name);
    if (!parsed) return;
    // For a combination every ingredient must appear, so "Amoxicillin" never
    // collects "Amoxicillin/Clavulanate" products and vice versa. A single
    // ingredient needs no such check — parse() has already thrown out any name
    // carrying more than one — and checking would only fight RxNorm's salts.
    if (ingredients > 1) {
      const lower = concept.name.toLowerCase();
      if (!wanted.every((w) => lower.includes(w))) return;
    }

    products++;
    if (!byForm.has(parsed.form)) byForm.set(parsed.form, new Set());
    byForm.get(parsed.form).add(parsed.strength);

    // Keep every brand, not the first one RxNorm happened to list. A drug is
    // called in by whichever name the office uses — "Norco", "Synthroid" —
    // and the first alphabetically is usually not that one.
    if (brand) {
      if (!brandFor.has(parsed.form)) brandFor.set(parsed.form, new Map());
      const counts = brandFor.get(parsed.form);
      counts.set(brand, (counts.get(brand) || 0) + 1);
    }
  };

  for (const c of conceptsOf(body, 'SCD')) add(c, null);
  for (const c of conceptsOf(body, 'SBD')) {
    const m = /\[([^\]]+)\]\s*$/.exec(c.name);
    add(c, m ? m[1] : null);
  }

  return [...byForm.entries()]
    .map(([form, set]) => {
      // The brand carrying the widest range of strengths is the established
      // one; the single-strength newcomers come after it.
      const brands = [...(brandFor.get(form) || new Map())]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([b]) => b);
      return {
        form,
        strengths: unifyUnits([...set], name).sort(byDose).slice(0, MAX_STRENGTHS),
        brand: brands[0] || '',
        alsoBrands: brands.slice(1, MAX_BRANDS),
        products,
      };
    })
    .filter((s) => s.strengths.length >= MIN_STRENGTHS)
    // Tablets and capsules before creams before injections: the common case first.
    .sort((a, b) => rankForm(a.form) - rankForm(b.form) || b.strengths.length - a.strengths.length);
}

const FORM_ORDER = ['tablet', 'capsule', 'solution', 'suspension', 'cream', 'ointment', 'gel', 'patch', 'inhaler'];

/*
 * Which form to offer first. Swallowed before applied, and a plain form before
 * a qualified one — a call for aspirin means a plain tablet far more often
 * than a delayed-release one, so "tablet" outranks "tablet, delayed release".
 */
function rankForm(f) {
  const i = FORM_ORDER.findIndex((x) => f.startsWith(x));
  const base = i === -1 ? FORM_ORDER.length : i;
  return base * 2 + (f.includes(',') ? 1 : 0);
}

// ---- DEA schedules, from the FDA's NDC directory -------------------------

/** Every human drug product the FDA lists: its ingredients, form and schedule. */
async function fdaProducts() {
  fs.mkdirSync(FDA_CACHE, { recursive: true });
  const json = path.join(FDA_CACHE, 'drug-ndc-0001-of-0001.json');
  if (!fs.existsSync(json)) {
    process.stdout.write('Downloading the FDA NDC directory…\n');
    const res = await fetch(FDA_ZIP);
    if (!res.ok) throw new Error(`FDA NDC directory: HTTP ${res.status}`);
    const zip = path.join(FDA_CACHE, 'ndc.json.zip');
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    // bsdtar reads zips, and ships with both macOS and Windows 10+.
    require('child_process').execFileSync('tar', ['-xf', zip, '-C', FDA_CACHE]);
    fs.unlinkSync(zip);
  }
  return JSON.parse(fs.readFileSync(json, 'utf8')).results
    .filter((r) => /^HUMAN/.test(r.product_type || '') && r.active_ingredients)
    .map((r) => ({
      ingredients: r.active_ingredients.map((a) => a.name.toLowerCase()),
      form: firstWord(r.dosage_form),
      schedule: SCHEDULE[r.dea_schedule] || 0,
    }));
}

const SCHEDULE = { CI: 1, CII: 2, CIII: 3, CIV: 4, CV: 5 };
const firstWord = (s) => String(s || '').toLowerCase().split(/[ ,]/)[0];

/*
 * One of our ingredients names one of the FDA's when every word of ours is in
 * it: "Morphine Sulfate" is "MORPHINE SULFATE", "Testosterone Cypionate" is
 * not plain "TESTOSTERONE". Mixed amphetamine salts are four FDA ingredients,
 * each with "amphetamine" in it — hence a substring, and "salts" dropped.
 */
const ingredientWords = (s) => s.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/)
  .filter((w) => w && w !== 'salts');
const isNamed = (ours, fda) => ingredientWords(ours).every((w) => fda.includes(w));

/*
 * The schedule for one entry: from the FDA products with exactly its
 * ingredients — every one of ours present, nothing else besides — in its dose
 * form when any are listed in it (dronabinol capsules are CIII, the solution
 * CII), otherwise in any form. 0 means not controlled.
 *
 * Where listings disagree, the most common answer wins, and a tie goes to the
 * stricter. Not the strictest outright: a labeler or two lists Tylenol #3 as
 * CII, and one bad listing shouldn't stop every call-in of it. Disagreements
 * are printed at the end of the build so they get a look.
 */
function scheduleFor(entry, products) {
  const ours = entry.g.split('/');
  const same = products.filter((p) =>
    p.ingredients.every((fi) => ours.some((o) => isNamed(o, fi)))
    && ours.every((o) => p.ingredients.some((fi) => isNamed(o, fi))));
  const inForm = same.filter((p) => p.form === firstWord(entry.f));
  const votes = new Map();
  for (const p of inForm.length ? inForm : same) votes.set(p.schedule, (votes.get(p.schedule) || 0) + 1);
  const ranked = [...votes].sort((a, b) => b[1] - a[1] || strictness(a[0]) - strictness(b[0]));
  return { schedule: ranked.length ? ranked[0][0] : 0, votes };
}

/** CII is the strictest; not controlled at all is the least. */
const strictness = (c) => c || 9;
const label = (c) => (c ? `C${['', 'I', 'II', 'III', 'IV', 'V'][c]}` : 'none');

async function pool(items, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await worker(items[i], i); }
      catch (e) { out[i] = { error: e.message }; }
    }
  }));
  return out;
}

const js = (v) => JSON.stringify(v);

function render(entries) {
  const lines = entries.map((e) => {
    const extra = (e.c ? `, c: ${e.c}` : '') +
      (e.x ? `, x: ${js(e.x)}` : '') + (e.a ? `, a: ${js(e.a)}` : '');
    return `    { g: ${js(e.g)}, b: ${js(e.b)}, f: ${js(e.f)}, p: ${e.p}, s: ${js(e.s)}${extra} },`;
  });
  return `'use strict';
/*
 * The drugs that actually come in over the phone — data only.
 *
 * GENERATED FILE — do not edit by hand. Searching it lives next door in
 * paper/drugsearch.js; this file is nothing but the list.
 *
 *   Which drugs are here is a judgement call about what a community pharmacy
 *   actually gets phoned, and it lives in scripts/drug-names.txt.
 *
 *   Every fact about them — the strengths that exist, the dose forms, the
 *   brand each is sold under — comes from RxNorm's Current Prescribable
 *   Content, the US National Library of Medicine's list of what can be
 *   dispensed today. The DEA schedule comes from the FDA's National Drug Code
 *   Directory. None of it is written from memory.
 *
 * To add a drug, put its name in scripts/drug-names.txt and re-run:
 *
 *     node scripts/build-drug-list.js
 *
 * Built ${new Date().toISOString().slice(0, 10)} — ${entries.length} products across ${new Set(entries.map((e) => e.g)).size} drugs.
 *
 *   g — generic name          b — the brand it is usually called by
 *   f — dosage form           s — the strengths RxNorm lists
 *   x — the drug's other brands; searchable, shown when one is what matched
 *   a — abbreviations it gets typed under; searchable, never shown
 *   p — how many products RxNorm lists; a rough stand-in for how often the
 *       drug is dispensed, used only to break ties between equal matches
 *   c — the federal DEA schedule, 2–5 (CII–CV); absent when not controlled
 */
var CommonDrugs = (function () {
  const LIST = [
${lines.join('\n')}
  ];

  return { LIST };
})();

if (typeof module !== 'undefined') module.exports = CommonDrugs;
`;
}

(async () => {
  const names = fs.readFileSync(NAMES, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  process.stdout.write(`Looking up ${names.length} drugs in RxNorm…\n`);

  const bodies = await pool(names, fetchDrug);
  const products = await fdaProducts();

  const entries = [];
  const missing = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const body = bodies[i];
    if (!body || body.error) { missing.push(`${name} (${body && body.error})`); continue; }
    const shapes = shapesFor(name, body);
    if (!shapes.length) { missing.push(name); continue; }
    // The main form, plus any other form that is genuinely dispensed.
    for (const sh of shapes.slice(0, 3)) {
      const entry = { g: name, b: sh.brand, f: sh.form, s: sh.strengths, p: sh.products };
      if (sh.alsoBrands.length) entry.x = sh.alsoBrands;
      entries.push(entry);
    }
  }

  // Retired brands people still say. These only ever add a searchable word to
  // an entry RxNorm already supplied — never a strength, form or fact.
  // "Brand = Generic" is a name worth showing back; "Abbrev ~ Generic" is one
  // worth finding by but never displaying.
  const spoken = new Map();
  for (const line of fs.readFileSync(ALIASES, 'utf8').split('\n')) {
    const text = line.replace(/#.*$/, '').trim();
    if (!text) continue;
    const shown = text.includes('=');
    const [alias, generic] = text.split(shown ? '=' : '~').map((x) => x.trim());
    if (!alias || !generic) continue;
    if (!spoken.has(generic)) spoken.set(generic, { brands: [], abbrevs: [] });
    spoken.get(generic)[shown ? 'brands' : 'abbrevs'].push(alias);
  }
  let aliased = 0;
  const unmatched = [];
  for (const [generic, { brands, abbrevs }] of spoken) {
    const hits = entries.filter((e) => e.g === generic);
    if (!hits.length) {
      unmatched.push(`${[...brands, ...abbrevs].join('/')} → ${generic}`);
      continue;
    }
    for (const e of hits) {
      if (brands.length) e.x = [...new Set([...(e.x || []), ...brands])];
      if (abbrevs.length) e.a = [...new Set([...(e.a || []), ...abbrevs])];
      aliased++;
    }
  }

  let controlled = 0;
  const disputed = [];
  for (const e of entries) {
    const { schedule, votes } = scheduleFor(e, products);
    if (schedule) { e.c = schedule; controlled++; }
    if (votes.size > 1) {
      const tally = [...votes].map(([c, n]) => `${label(c)} ×${n}`).join(', ');
      disputed.push(`${e.g} ${e.f}: ${label(schedule)} (${tally})`);
    }
  }

  entries.sort((a, b) => a.g.localeCompare(b.g) || rankForm(a.f) - rankForm(b.f));
  fs.writeFileSync(OUT, render(entries));

  process.stdout.write(`Wrote ${entries.length} entries for ${names.length - missing.length} drugs.\n`);
  process.stdout.write(`Retired brand names added to ${aliased} entries.\n`);
  process.stdout.write(`DEA schedule on ${controlled} entries.\n`);
  if (disputed.length) {
    process.stdout.write(`\nFDA listings disagree on the schedule (${disputed.length}) — check these:\n`);
    for (const d of disputed) process.stdout.write(`  ${d}\n`);
  }
  if (unmatched.length) {
    process.stdout.write(`\nAliases with no matching drug (${unmatched.length}):\n`);
    for (const u of unmatched) process.stdout.write(`  ${u}\n`);
  }
  if (missing.length) {
    process.stdout.write(`\nNot found in RxNorm (${missing.length}) — check the spelling:\n`);
    for (const m of missing) process.stdout.write(`  ${m}\n`);
  }
})();
