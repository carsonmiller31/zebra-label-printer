'use strict';
/*
 * Turning an RxNorm drug name into the parts the call-in form wants.
 *
 * RxNorm spells a clinical drug out in one string:
 *
 *   "atorvastatin 40 MG Oral Tablet"
 *   "metformin hydrochloride 500 MG Extended Release Oral Tablet"
 *   "amoxicillin 875 MG / clavulanate 125 MG Oral Tablet"
 *   "budesonide 0.25 MG/ML Inhalation Suspension"
 *
 * These pull it apart into { strength, form } without inventing anything: the
 * numbers and the dose form are RxNorm's, not ours.
 */

/** Units as RxNorm writes them → how a prescriber says them. */
const UNITS = {
  MG: 'mg', G: 'g', MCG: 'mcg', NG: 'ng', ML: 'mL', L: 'L',
  'MG/ML': 'mg/mL', 'MCG/ML': 'mcg/mL', 'MEQ': 'mEq', 'MMOL': 'mmol',
  'UNT': 'units', 'UNT/ML': 'units/mL', '%': '%', 'ACTUAT': 'actuation',
  // Metered inhalers and sprays are dosed per puff.
  'MG/ACTUAT': 'mg/actuation', 'MCG/ACTUAT': 'mcg/actuation',
  'UNT/ACTUAT': 'units/actuation', 'MG/HR': 'mg/hr', 'MCG/HR': 'mcg/hr',
  'MG/MG': 'mg/mg', 'MEQ/ML': 'mEq/mL',
};

/** RxNorm dose form → what goes on the slip. */
function form(raw) {
  let f = String(raw || '').toLowerCase();
  // "Injectable Solution" must not collapse to a bare "solution" — for a shot
  // the route *is* the form. Everything else implies its own route.
  if (/\binjectable\b/.test(f)) {
    if (/pen injector/.test(f)) return 'pen injector';
    if (/prefilled syringe|auto-?injector/.test(f)) return 'prefilled syringe';
    return /suspension/.test(f) ? 'injection, suspension' : 'injection';
  }
  f = f.replace(/\b(oral|topical|ophthalmic|otic|nasal|rectal|vaginal|inhalation|transdermal|sublingual|buccal|subcutaneous|intravenous|dry powder)\b/g, ' ');
  f = f.replace(/\s+/g, ' ').trim();

  // Release qualifiers change the prescription and have to survive.
  const rel = /extended release|delayed release|sustained release|controlled release|24 hr|12 hr/.exec(f);
  f = f.replace(/\b(extended|delayed|sustained|controlled) release\b/g, ' ')
       .replace(/\b\d+ hr\b/g, ' ')
       .replace(/\s+/g, ' ').trim();

  const base = f || 'product';
  if (!rel) return base;
  const qualifier = /24 hr|12 hr/.test(rel[0]) ? 'extended release' : rel[0];
  return `${base}, ${qualifier}`;
}

/** "40 MG" → "40 mg"; "0.25 MG/ML" → "0.25 mg/mL"; leaves oddities alone. */
function unit(value, u) {
  const key = String(u || '').toUpperCase();
  const pretty = UNITS[key] || u;
  const n = Number(value);
  // 50000 units reads better grouped; 1000 mg and 0.0125 mg do not. Group
  // only whole numbers of five digits or more, and never past a decimal point.
  const shown = Number.isFinite(n) && Number.isInteger(n) && n >= 10000
    ? String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    : (Number.isFinite(n) ? String(n) : value);
  return `${shown} ${pretty}`.replace(' %', '%');
}

/**
 * Pulls an RxNorm clinical-drug name apart into its ingredients.
 *
 * → { pairs: [{ ingredient, strength }], form, raw } | null
 *
 * Each " / " separated part is one ingredient. Within a part there may be
 * several numbers — a pack size in front ("3 ML insulin glargine 100 UNT/ML")
 * or a concentration written as a ratio ("40 MG/0.8ML"). Numbers joined by a
 * bare slash are one concentration; otherwise the *last* group in the part is
 * the strength, which is what throws away the pack size in front.
 */
function parse(name, { ingredients = 1 } = {}) {
  let text = String(name || '').replace(/\s*\[[^\]]*\]\s*/g, ' ').trim(); // drop [Brand]
  if (!text) return null;
  if (/\bPack\b|\bKit\b/i.test(text)) return null; // dose packs aren't a strength

  const parts = text.split(' / ');
  if (parts.length !== ingredients) return null;

  const pairs = [];
  let tail = '';

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const doses = [...part.matchAll(/(\d[\d.,]*)\s*(%|[A-Za-z]+(?:\/[A-Za-z]+)?)/g)]
      .filter((m) => UNITS[m[2].toUpperCase()] !== undefined || m[2] === '%');
    if (!doses.length) return null;

    // Runs of doses joined by a bare "/" are a single concentration.
    const groups = [];
    for (const m of doses) {
      const prev = groups.length && groups[groups.length - 1].slice(-1)[0];
      const between = prev ? part.slice(prev.index + prev[0].length, m.index).trim() : null;
      if (prev && between === '/') groups[groups.length - 1].push(m);
      else groups.push([m]);
    }

    const chosen = groups[groups.length - 1];
    const first = chosen[0];
    pairs.push({
      ingredient: part.slice(0, first.index).trim().toLowerCase(),
      strength: chosen.map((m) => unit(m[1].replace(/,/g, ''), m[2])).join('/'),
    });

    if (i === parts.length - 1) {
      const last = chosen[chosen.length - 1];
      tail = part.slice(last.index + last[0].length).trim();
    }
  }

  const f = form(tail);
  if (!f || f === 'product') return null;
  return { pairs, form: f, raw: tail };
}

/** Numeric sort so 5 mg comes before 40 mg, not after. */
function byDose(a, b) {
  const n = (s) => parseFloat(String(s).replace(/,/g, '')) || 0;
  return n(a) - n(b) || String(a).localeCompare(String(b));
}

/*
 * RxNorm is internally consistent; prescribers are conventional. Two places
 * they disagree, and the convention wins because the slip is read by people:
 *
 *  - Thyroid and a few others are dispensed in micrograms. RxNorm writes
 *    levothyroxine as "0.025 MG"; every prescriber says "25 mcg".
 *  - Topicals are prescribed as a percentage. RxNorm writes clobetasol as
 *    "0.5 MG/ML"; the script says "0.05%". They are the same number, ten
 *    times apart, because 1% is 10 mg/mL by definition.
 */
const PREFER_MCG = /levothyroxine|liothyronine|fentanyl|clonidine|misoprostol|desmopressin|ethinyl|digoxin|alprostadil|formoterol|salmeterol|tiotropium|budesonide|fluticasone|mometasone|beclomethasone|albuterol|levalbuterol|ipratropium/i;

const TOPICAL_FORM = /cream|ointment|gel|lotion|foam|shampoo|paste/i;

/**
 * Applies those two conventions, and puts the ingredients in the order the
 * drug is *named* in — RxNorm lists them alphabetically, so "acetaminophen
 * 325 MG / hydrocodone 5 MG" would otherwise print under the heading
 * "Hydrocodone/Acetaminophen" with its numbers the wrong way round. On a
 * prescription record that is not a cosmetic problem.
 *
 * → { strength, form } | null
 */
function conventional(parsed, displayName) {
  if (!parsed) return parsed;
  const { pairs, form: f, raw } = parsed;

  const ordered = orderLike(pairs, displayName);
  if (!ordered) return null;

  const topical = TOPICAL_FORM.test(f) || /\btopical\b/i.test(raw || '');
  const strength = ordered.map((pr) => {
    let v = pr.strength;
    if (topical) {
      v = v.replace(/([\d.]+) mg\/mL/g, (_, n) => `${Number((Number(n) / 10).toFixed(6))}%`);
    } else if (PREFER_MCG.test(displayName || '') || PREFER_MCG.test(pr.ingredient)) {
      v = v.replace(/([\d.]+) mg\b/g, (whole, n) => {
        const x = Number(n);
        if (!Number.isFinite(x) || x >= 1) return whole;
        return `${Number((x * 1000).toFixed(6))} mcg`;
      });
    }
    return v;
  }).join('-');

  return { strength, form: f };
}

const stem = (w) => String(w).toLowerCase().replace(/[^a-z]/g, '').slice(0, 6);

/**
 * Sorts the parsed ingredients into the order of the name we display, e.g.
 * "Hydrocodone/Acetaminophen". Returns null if they don't correspond, so a
 * mismatched product is dropped rather than printed in a misleading order.
 */
function orderLike(pairs, displayName) {
  if (pairs.length === 1) return pairs;
  const wanted = String(displayName || '').split('/').map((p) => stem(p.trim().split(' ')[0]));
  if (wanted.length !== pairs.length) return pairs;

  const pool = [...pairs];
  const out = [];
  for (const w of wanted) {
    const i = pool.findIndex((pr) => stem(pr.ingredient.split(' ').pop()) === w
      || pr.ingredient.split(/\s+/).some((word) => stem(word) === w));
    if (i === -1) return null;
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

/*
 * One drug, one unit. RxNorm files levothyroxine partly in milligrams and
 * partly in micrograms; a list that mixes them ("1 mg, 25 mcg, 88 mcg") reads
 * like an error. If any strength for a microgram-dosed drug came out in mcg,
 * the rest follow.
 */
function unifyUnits(strengths, ingredientName) {
  if (!PREFER_MCG.test(ingredientName || '')) return strengths;
  if (!strengths.some((s) => /\bmcg\b/.test(s))) return strengths;
  return strengths.map((s) => s.replace(/([\d.]+) mg\b/g, (whole, n) => {
    const v = Number(n);
    return Number.isFinite(v) ? `${Number((v * 1000).toFixed(6))} mcg` : whole;
  }));
}

module.exports = { parse, form, unit, byDose, conventional, unifyUnits, UNITS };
