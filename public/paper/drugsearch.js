'use strict';
/*
 * Finding a drug while someone is talking.
 *
 * Whoever is typing is listening at the same time, holding a phone, and going
 * fast. They will spell it wrong. "sertaline", "amoxicilin", "hydrochlorothiazde",
 * "atorvsatatin" — all of those have to land on the right drug, because the
 * alternative is asking the prescriber's office to spell it, which is slow and
 * looks bad.
 *
 * So matching runs in tiers, cheapest and most certain first:
 *
 *   exact      the whole name, typed out
 *   prefix     what has been typed so far starts the name        "atorva"
 *   word       it starts one *word* of the name                  "clav" → Amoxicillin/Clavulanate
 *   contains   it appears somewhere inside                       "codone" → Hydrocodone
 *   typo       it is within a few edits of the name              "sertaline"
 *   scatter    its letters appear in order, with gaps            "amxcln" → Amoxicillin
 *
 * A tier is only tried when the ones above it haven't filled the list, so a
 * clean prefix is never pushed down the list by a clever fuzzy match.
 *
 * Typos are measured with an optimal string alignment distance — insertions,
 * deletions, substitutions and the swapped pair of neighbours that fast typing
 * produces — against the best *prefix* of the name, so a half-typed word with
 * a slip in it still scores well.
 *
 * Uses CommonDrugs.LIST (paper/drugs.js) — data only, generated from RxNorm.
 */
var DrugSearch = (function () {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  // How wrong a word may be before we stop believing it. Short words get no
  // latitude — at three letters, one edit is a different drug.
  function tolerance(len) {
    if (len <= 3) return 0;
    if (len <= 5) return 1;
    if (len <= 9) return 2;
    return 3;
  }

  /*
   * The smallest number of edits turning `q` into any prefix of `s`, giving up
   * once that exceeds `max`. Counting against a prefix rather than the whole
   * word is what lets "atorvastat" match "atorvastatin" for nothing, while
   * still charging one edit for "atorvsatat".
   *
   * Two rows of the matrix are enough for insert/delete/substitute; the third
   * is kept because a transposition needs to look back two characters.
   */
  const rowA = new Int32Array(64);
  const rowB = new Int32Array(64);
  const rowC = new Int32Array(64);

  function editsToPrefix(q, s, max) {
    const n = q.length;
    if (n === 0) return 0;
    // Nothing past this point in `s` can be reached within the budget.
    const lim = Math.min(s.length, n + max);
    if (lim + 1 > rowA.length) return q === s.slice(0, q.length) ? 0 : max + 1;

    let prev2 = rowA;
    let prev = rowB;
    let cur = rowC;
    for (let j = 0; j <= lim; j++) prev[j] = j;   // deleting j characters of s

    for (let i = 1; i <= n; i++) {
      cur[0] = i;
      let rowBest = i;
      const qi = q.charCodeAt(i - 1);
      for (let j = 1; j <= lim; j++) {
        const cost = qi === s.charCodeAt(j - 1) ? 0 : 1;
        let v = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        // …and the neighbours typed the wrong way round.
        if (i > 1 && j > 1
          && qi === s.charCodeAt(j - 2)
          && q.charCodeAt(i - 2) === s.charCodeAt(j - 1)) {
          v = Math.min(v, prev2[j - 2] + 1);
        }
        cur[j] = v;
        if (v < rowBest) rowBest = v;
      }
      if (rowBest > max) return max + 1;         // no prefix is reachable now
      const spent = prev2; prev2 = prev; prev = cur; cur = spent;
    }

    let best = max + 1;
    for (let j = 0; j <= lim; j++) if (prev[j] < best) best = prev[j];
    return best;
  }

  /** Do `q`'s letters appear in `s`, in order, allowing gaps? */
  function scattered(q, s) {
    let i = 0;
    for (let j = 0; j < s.length && i < q.length; j++) {
      if (q.charCodeAt(i) === s.charCodeAt(j)) i++;
    }
    return i === q.length;
  }

  // Tier bases. Everything inside a tier is separated by penalties smaller
  // than the gap between tiers, so a better tier always wins outright.
  const EXACT = 0, PREFIX = 10, WORD = 20, CONTAINS = 30, TYPO = 40, SCATTER = 60;
  const NO_MATCH = Infinity;

  /*
   * Among equally good matches, prefer the name closest in length to what was
   * typed. This is what keeps a plain drug ahead of a combination containing
   * it: "metfromin" is a typo for Metformin, not for Glyburide/Metformin,
   * even though both contain the word.
   */
  const lengthPenalty = (q, name) =>
    0.45 * Math.min(1, Math.max(0, name.length - q.length) / 12);

  /*
   * …and among those, prefer the drug more of the market actually makes.
   * `p` is how many distinct products RxNorm lists, which is a stand-in for
   * how often a drug is dispensed: "amox" is Amoxicillin (13 products), not
   * Amoxapine (4); "levo" is Levothyroxine (69), not Levodopa (23). It only
   * ever breaks a tie — both penalties together stay under 1, and the tiers
   * are 10 apart.
   *
   * The two weights are equal and the length scale runs to 12 characters
   * because that is what satisfies both of the awkward cases at once:
   *
   *   "amox"  Amoxicillin (11 long, 13 products) must beat Amoxapine
   *           (9 long, 4 products) — so popularity has to outweigh two
   *           characters of extra length.
   *   "met"   Metformin (9 long, 19 products) must beat Methylphenidate
   *           (15 long, 105 products) — so six characters of extra length
   *           have to outweigh popularity.
   *
   * Capping the length scale at 9, as an earlier version did, made the second
   * case unwinnable: both names hit the cap and the length signal vanished.
   */
  const POP_CEILING = Math.log(150);
  const popPenalty = (p) =>
    0.45 * (1 - Math.min(1, Math.log(1 + (p || 0)) / POP_CEILING));

  /*
   * When two names are the same number of edits away, the one that agrees
   * with what was typed for longer is the better guess: "prednisolne" is one
   * edit from both Prednisone and Prednisolone, but it matches Prednisolone
   * for nine letters before diverging and Prednisone for only eight.
   *
   * Worth at most 2, so it can reorder names within an edit count but never
   * promote a two-typo match above a one-typo one, which costs 5.
   */
  function agreementBonus(q, name) {
    let i = 0;
    const lim = Math.min(q.length, name.length);
    while (i < lim && q.charCodeAt(i) === name.charCodeAt(i)) i++;
    return 2 * (i / q.length);
  }

  /**
   * How well one typed word matches one name. Lower is better.
   * `deep` turns on the expensive tiers — only worth it once the cheap ones
   * have come up short.
   */
  function scoreWord(q, name, words, deep) {
    if (name === q) return EXACT;
    if (name.startsWith(q)) return PREFIX + lengthPenalty(q, name);

    let best = NO_MATCH;
    for (const w of words) {
      if (w === q) best = Math.min(best, WORD);
      else if (w.startsWith(q)) best = Math.min(best, WORD + lengthPenalty(q, name));
    }
    if (best !== NO_MATCH) return best;

    if (name.includes(q)) return CONTAINS + lengthPenalty(q, name);
    if (!deep || q.length < 4) return NO_MATCH;

    const max = tolerance(q.length);
    if (max > 0) {
      let d = editsToPrefix(q, name, max);
      if (d > max) {
        // A slip in a later word ("amox clavulinate") only needs that word checked.
        for (const w of words) {
          const wd = editsToPrefix(q, w, max);
          if (wd < d) d = wd;
          if (d === 0) break;
        }
      }
      // Each edit costs more than any tie-break, so one typo always beats two.
      if (d <= max) {
        return TYPO + d * 5 - agreementBonus(q, name)
          + lengthPenalty(q, name) + (q.length <= 5 ? 2 : 0);
      }
    }

    if (q.length >= 5 && scattered(q, name)) return SCATTER + lengthPenalty(q, name);
    return NO_MATCH;
  }

  // ---- Index ---------------------------------------------------------------
  // Built once. Every searchable name for an entry — the generic, the brand
  // shown, and the brands that aren't — each split into words so a query can
  // match any part of a combination.

  let INDEX = null;

  function build() {
    INDEX = (CommonDrugs.LIST || []).map((d) => {
      const names = [];
      // `bias` breaks ties between a generic and a brand that match equally
      // well. Without it "ator" lands on the Atorvaliq brand of atorvastatin
      // (a shorter word, so a tighter prefix) instead of on Atorvastatin, and
      // "met" lands on Metadate rather than Metformin.
      const push = (text, brand, bias) => {
        const n = norm(text);
        if (n) names.push({ n, w: n.split(' '), brand, bias });
      };
      push(d.g, d.b, 0);
      if (d.b) push(d.b, d.b, 1);
      for (const alt of d.x || []) push(alt, alt, 1);
      // Abbreviations find the drug but are not its name: matching "HCTZ"
      // should not caption the row "Hydrochlorothiazide [HCTZ]".
      for (const abbr of d.a || []) push(abbr, d.b, 1);
      return { d, names, pop: popPenalty(d.p) };
    });
  }

  /** The best score for this entry, and which name earned it. */
  function scoreEntry(entry, tokens, deep, cache) {
    let total = 0;
    let bestOverall = NO_MATCH;
    let brand = entry.d.b;

    for (const token of tokens) {
      let best = NO_MATCH;
      let bestBrand = null;
      for (const name of entry.names) {
        const key = token + '\u0000' + name.n + (deep ? '\u0001' : '');
        let s = cache.get(key);
        if (s === undefined) {
          s = scoreWord(token, name.n, name.w, deep);
          cache.set(key, s);
        }
        const withBias = s === NO_MATCH ? s : s + name.bias + entry.pop;
        if (withBias < best) { best = withBias; bestBrand = name.brand; }
      }
      // Every word typed has to find something, or this isn't the drug.
      if (best === NO_MATCH) return null;
      // The name that matched best is the one worth showing back: asking for
      // "Synthroid" should answer with Synthroid.
      if (best < bestOverall) { bestOverall = best; if (bestBrand) brand = bestBrand; }
      total += best;
    }
    return { score: total / tokens.length, brand };
  }

  /**
   * Suggestions for what has been typed so far.
   *
   * Few drugs match → every strength is offered, because that is the choice
   * left to make. Many match → one row each, so the list stays readable and
   * picking one narrows it to that drug's strengths on the next keystroke.
   *
   * → [{ text, sub, drug, strength }]
   */
  function suggest(query, limit = 9) {
    if (!INDEX) build();
    const q = norm(query);
    if (q.length < 2) return [];

    // A strength already typed ("atorva 40") filters the strengths offered
    // rather than being matched against the name.
    const words = q.split(' ');
    const tokens = words.filter((w) => !/^\d/.test(w));
    const numPart = words.filter((w) => /^\d/.test(w)).join(' ');
    if (!tokens.length) return [];

    const cache = new Map();
    let hits = collect(tokens, false, cache);

    // Nothing clean came back — now spend the effort on typos.
    if (hits.length < limit) {
      const deep = collect(tokens, true, cache);
      if (deep.length > hits.length) hits = deep;
    }
    if (!hits.length) return [];

    hits.sort((a, b) => a.score - b.score || a.entry.d.g.localeCompare(b.entry.d.g));

    const picked = hits.slice(0, limit);
    const expand = picked.length <= 3 || !!numPart;

    const out = [];
    for (const hit of picked) {
      const d = hit.entry.d;
      if (!expand) {
        out.push({ text: `${d.g} ${d.f}`, sub: hit.brand, drug: d, strength: '' });
        if (out.length >= limit) break;
        continue;
      }
      const flat = (s) => norm(s).replace(/ /g, '');
      const matching = numPart
        ? d.s.filter((s) => flat(s).startsWith(flat(numPart)))
        : d.s;
      for (const s of (matching.length ? matching : d.s)) {
        out.push({ text: `${d.g} ${s} ${d.f}`, sub: hit.brand, drug: d, strength: s });
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  }

  function collect(tokens, deep, cache) {
    const hits = [];
    for (const entry of INDEX) {
      const hit = scoreEntry(entry, tokens, deep, cache);
      if (hit) hits.push({ entry, ...hit });
    }
    return hits;
  }

  return { suggest, scoreWord, editsToPrefix, norm };
})();

if (typeof module !== 'undefined') module.exports = DrugSearch;
