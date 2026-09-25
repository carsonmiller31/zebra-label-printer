'use strict';
/*
 * Price sticker layout.
 *
 * Six little stickers to a label, dashed lines between them to cut along.
 * Each carries the drug, the price — as a Charleston code by default, or as
 * the plain price when the tab is switched to it — the vendor and the date it
 * was printed:
 *
 *   +---------------------+---------------------+
 *   | Atorvastatin 40 mg  |  Lisinopril 10 mg   |
 *   |        CHOO         |         RLN         |
 *   | CARDINAL   09/23/26 | AUBURN     09/23/26 |
 *   + - - - - - - - - - - + - - - - - - - - - - +   <- cut here
 *   |        ...          |                     |   <- a short last label
 *   +---------------------+---------------------+      leaves cells blank
 *
 * The drug hangs from the top of the sticker and the vendor/date line sits on
 * the bottom, so a sheet of them lines up; the code is centred between.
 *
 * The six are arranged 2 across x 3 down or 3 across x 2 down, whichever
 * makes the stickers wider on the stock that's loaded (2 x 3 on the usual
 * 3" x 2", each sticker 1.5" x 0.67").
 * The code and the bottom line use one type size across the whole print job
 * so the stickers look like a set; a long drug name shrinks (then wraps to a
 * second line) on its own sticker only.
 *
 * Elements come out in printer dots and are drawn by LabelCore, so the preview
 * and the print job are the same drawing.
 */
var LabelCore = typeof LabelCore !== 'undefined' ? LabelCore : require('../labelcore.js');

var PriceLayout = (function () {
  const { CAP, DESC, LEAD, advance, measure, blockHeight, fit, textLine } = LabelCore;

  const PER_LABEL = 6;
  const VENDORS = ['Cardinal', 'Auburn'];
  const GRIDS = [{ cols: 2, rows: 3 }, { cols: 3, rows: 2 }];

  // -------------------------------------------------------------------------
  // Prices
  // -------------------------------------------------------------------------

  /**
   * "12.5", "$12.50", "1,234", ".99" → whole cents, or null if it isn't a
   * price. More than two decimal places is refused rather than rounded: a
   * third digit is more likely a typo than a price in tenths of a cent.
   */
  function parsePrice(s) {
    const t = String(s == null ? '' : s).trim().replace(/^\$\s*/, '').replace(/,/g, '');
    const m = /^(\d*)(?:\.(\d{0,2}))?$/.exec(t);
    if (!m || (!m[1] && !m[2])) return null;
    const cents = Number(m[1] || 0) * 100 + Number((m[2] || '').padEnd(2, '0'));
    return Number.isSafeInteger(cents) ? cents : null;
  }

  /** 123456 → "$1,234.56" */
  function formatPrice(cents) {
    const dollars = Math.floor(cents / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `$${dollars}.${String(cents % 100).padStart(2, '0')}`;
  }

  // -------------------------------------------------------------------------
  // The Charleston code
  // -------------------------------------------------------------------------

  // A ten-letter word with no letter twice stands for the ten digits, so the
  // shelf can see the cost and the customer can't. With CHARLESTON and the
  // first letter standing for 1: C=1 H=2 A=3 R=4 L=5 E=6 S=7 T=8 O=9 N=0.
  const CODE_WORD = 'CHARLESTON';

  /** Why a code word can't be used, or '' when it can. */
  function checkCodeWord(word) {
    const w = String(word || '').trim().toUpperCase();
    if (!/^[A-Z]{10}$/.test(w)) return 'The code word has to be exactly 10 letters.';
    if (new Set(w).size !== 10) return 'The code word can\u2019t use any letter twice.';
    return '';
  }

  /**
   * Whole cents → the code: every digit of the dollars and both digits of the
   * cents, no $ and no point — the last two letters are always the cents.
   * $12.99 → CHOO, $4.50 → RLN, $0.99 → NOO (with CHARLESTON from 1).
   * start: the digit the word's first letter stands for, 1 or 0.
   */
  function priceCode(cents, word = CODE_WORD, start = 1) {
    const w = String(word).trim().toUpperCase();
    const digits = `${Math.floor(cents / 100)}${String(cents % 100).padStart(2, '0')}`;
    return [...digits].map((d) => w[(Number(d) - start + 10) % 10]).join('');
  }

  /** Today (or `d`) as the stickers print it: 09/23/26. */
  function dateText(d = new Date()) {
    const two = (n) => String(n).padStart(2, '0');
    return `${two(d.getMonth() + 1)}/${two(d.getDate())}/${two(d.getFullYear() % 100)}`;
  }

  /**
   * [{ vendor, cents, qty, drug }] → one entry per physical sticker, in order,
   * as the text it prints: { drug, code, vendor }. `code` is the big middle
   * line — the Charleston code, or with show = 'price' the price itself
   * ("$12.99"); the layout sizes whichever it is the same way.
   */
  function expand(entries, word = CODE_WORD, start = 1, show = 'code') {
    const out = [];
    for (const e of entries) {
      const code = show === 'price' ? formatPrice(e.cents) : priceCode(e.cents, word, start);
      const s = { drug: e.drug || '', code, vendor: e.vendor };
      for (let i = 0; i < e.qty; i++) out.push(s);
    }
    return out;
  }

  /** Stickers → labels of up to six. */
  function paginate(stickers) {
    const pages = [];
    for (let i = 0; i < stickers.length; i += PER_LABEL) pages.push(stickers.slice(i, i + PER_LABEL));
    return pages;
  }

  // -------------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------------

  /** Cell c,r of a cols x rows grid, edges rounded so cells tile exactly. */
  function cell(spec, grid, c, r) {
    const x0 = Math.round((c * spec.W) / grid.cols);
    const x1 = Math.round(((c + 1) * spec.W) / grid.cols);
    const y0 = Math.round((r * spec.H) / grid.rows);
    const y1 = Math.round(((r + 1) * spec.H) / grid.rows);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // Clear space inside each cut line, so a cut a little off the line (or a
  // printer that drifts a millimetre) doesn't clip anything. Kept tight: a
  // sticker this small needs every dot it has.
  const margin = (w, h) => Math.max(7, Math.round(Math.min(w, h) * 0.075));

  /** The space a sticker's type has to live in, inside the cut lines. */
  function inner(spec, grid) {
    const w = Math.floor(spec.W / grid.cols);
    const h = Math.floor(spec.H / grid.rows);
    const m = margin(w, h);
    return { w: w - 2 * m, h: h - 2 * m, cellH: h };
  }

  // Type sizes as a share of the sticker's height, before scaling to fit.
  const DRUG_SHARE = 0.15;
  const CODE_SHARE = 0.34;
  const FOOT_SHARE = 0.15;
  const GAP_SHARE = 0.04;
  const DRUG_MIN = 14;  // ~0.07" — as small as ^A0 stays readable at 203 dpi
  const FOOT_MIN = 13;

  const lineH = (h) => Math.round((CAP + DESC) * h);

  /**
   * The drug on one line if it will go at all (shrinking to DRUG_MIN), and
   * only then on two — "Eliquis 5 mg" small on one line beats "Eliquis 5 /
   * mg" big on two.
   */
  function fitDrug(text, w, hMax) {
    const one = fit(text, w, 1, hMax, DRUG_MIN);
    return one && !one.truncated ? one : fit(text, w, 2, hMax, DRUG_MIN);
  }
  const uniq = (list) => [...new Set(list)];

  /** The largest h (hMax → hMin) at which `left` and `right` share one line. */
  function fitPair(left, right, w, hMax, hMin) {
    for (let h = Math.floor(hMax); h >= hMin; h--) {
      if (measure(left, h) + measure(right, h) + Math.round(h * 0.8) <= w) return h;
    }
    return null;
  }

  /**
   * Type sizes for the job on one grid: the largest scale at which the
   * longest code, the widest vendor/date line and the longest drug name all
   * fit their sticker. Null when the sticker is too small for any of it.
   */
  function sizesFor(stickers, spec, grid, date) {
    const box = inner(spec, grid);
    if (box.w < 30 || box.h < 30) return null;
    const codes = uniq(stickers.map((s) => s.code).filter(Boolean));
    const vendors = uniq(stickers.map((s) => s.vendor.toUpperCase()));
    const drugs = uniq(stickers.map((s) => s.drug).filter(Boolean));
    if (!codes.length) codes.push('CHOO');
    if (!vendors.length) vendors.push(VENDORS[0].toUpperCase());

    for (let k = 1; k >= 0.35; k -= 0.05) {
      const last = k - 0.05 < 0.35;
      let drugH = Math.max(DRUG_MIN, Math.round(box.cellH * DRUG_SHARE * k));
      const gap = Math.max(2, Math.round(box.cellH * GAP_SHARE * k));

      let codeH = Infinity;
      for (const c of codes) {
        const f = fit(c, box.w, 1, box.cellH * CODE_SHARE * k, 12);
        if (!f) return null;
        codeH = Math.min(codeH, f.h);
      }

      let footH = Infinity;
      for (const v of vendors) {
        const h = fitPair(v, date, box.w, Math.max(FOOT_MIN, box.cellH * FOOT_SHARE * k), FOOT_MIN);
        if (h == null) { footH = null; break; }
        footH = Math.min(footH, h);
      }
      if (footH == null) { if (last) return null; continue; }

      // One size for every drug name in the job — the size the longest
      // one-line name needs — so the sheet reads as a set. A name too long
      // for one line even at the smallest size wraps on its own sticker
      // rather than dragging every other one down with it.
      let drugLines = 0;
      let shortened = false;
      const fitted = drugs.map((d) => fitDrug(d, box.w, drugH));
      if (fitted.some((f) => !f)) return null;
      for (const f of fitted) if (f.lines.length === 1) drugH = Math.min(drugH, f.h);
      for (const f of fitted) {
        drugLines = Math.max(drugLines, f.lines.length);
        shortened = shortened || f.truncated;
      }

      const total = (drugLines ? blockHeight(drugLines, drugH) + gap : 0) + lineH(codeH) + gap + lineH(footH);
      if (total <= box.h || last) {
        return { drugH, codeH, footH, gap, fits: total <= box.h, shortened };
      }
    }
    return null;
  }

  /**
   * The arrangement of six for this stock, and the type sizes on it.
   * stickers: [{ drug, code, vendor }]   date: the text printed on each
   * → { grid, sizes, date } or null when six won't fit at all.
   *
   * The grid depends on the stock alone — the one whose stickers are widest
   * for their height, since a drug name is a long line — never on what's
   * being printed, so the cuts fall in the same place every time.
   */
  function plan(stickers, spec, date) {
    const aspect = (g) => (spec.W / g.cols) / (spec.H / g.rows);
    const grids = [...GRIDS].sort((a, b) => aspect(b) - aspect(a));
    let fallback = null;
    for (const grid of grids) {
      const sizes = sizesFor(stickers, spec, grid, date);
      if (!sizes) continue;
      if (sizes.fits) return { grid, sizes, date };
      fallback = fallback || { grid, sizes, date };
    }
    return fallback;
  }

  /** Dashed rules along the inside edges between stickers, the full label across. */
  function cutLines(els, spec, grid) {
    const t = Math.max(1, Math.round(spec.dpi / 120));  // ~2 dots at 203 dpi
    const dash = Math.round(spec.dpi * 0.055);
    const gap = Math.round(spec.dpi * 0.04);
    const period = dash + gap;
    const dashes = (span) => {
      const n = Math.max(1, Math.floor((span + gap) / period));
      const start = Math.round((span - (n * period - gap)) / 2);
      return Array.from({ length: n }, (_, i) => start + i * period);
    };
    for (let c = 1; c < grid.cols; c++) {
      const x = Math.round((c * spec.W) / grid.cols) - Math.floor(t / 2);
      for (const y of dashes(spec.H)) els.push({ kind: 'box', x, y, w: t, h: dash, t });
    }
    for (let r = 1; r < grid.rows; r++) {
      const y = Math.round((r * spec.H) / grid.rows) - Math.floor(t / 2);
      for (const x of dashes(spec.W)) els.push({ kind: 'box', x, y, w: dash, h: t, t });
    }
  }

  /** One sticker, inside the margins of its cell. */
  function sticker(els, s, cellBox, p) {
    const { drugH, codeH, footH, gap } = p.sizes;
    const m = margin(cellBox.w, cellBox.h);
    const x0 = cellBox.x + m;
    const w = cellBox.w - 2 * m;
    const top = cellBox.y + m;
    const bottom = cellBox.y + cellBox.h - m;
    const centreX = (text, h) => x0 + (w - advance(text, h)) / 2;

    // The drug, from the top, shrinking and then wrapping only if it has to.
    let y = top;
    if (s.drug) {
      const f = fitDrug(s.drug, w, drugH);
      if (f) {
        f.lines.forEach((line, i) =>
          textLine(els, centreX(line, f.h), y + CAP * f.h + i * LEAD * f.h, f.h, line));
        y += blockHeight(f.lines.length, f.h) + gap;
      }
    }

    // Vendor and date along the bottom.
    const footBase = bottom - DESC * footH;
    const vendor = s.vendor.toUpperCase();
    textLine(els, x0, footBase, footH, vendor);
    textLine(els, x0 + w - advance(p.date, footH), footBase, footH, p.date);

    // The code, centred in what's left between them.
    const room = bottom - lineH(footH) - gap - y;
    const code = fit(s.code, w, 1, codeH, 10);
    if (code) {
      const codeTop = y + Math.max(0, (room - lineH(code.h)) / 2);
      textLine(els, centreX(code.lines[0], code.h), codeTop + CAP * code.h, code.h, code.lines[0]);
    }
  }

  /**
   * One label: up to six stickers, placed row by row.
   * p: from plan() — the grid, type sizes and date for the whole job.
   */
  function page(stickers, spec, p) {
    const els = [];
    cutLines(els, spec, p.grid);
    stickers.slice(0, PER_LABEL).forEach((s, i) =>
      sticker(els, s, cell(spec, p.grid, i % p.grid.cols, Math.floor(i / p.grid.cols)), p));
    return { elements: els };
  }

  return {
    PER_LABEL, VENDORS, CODE_WORD,
    parsePrice, formatPrice, checkCodeWord, priceCode, dateText, expand, paginate, plan, page,
    toSVG: LabelCore.toSVG, toZPL: LabelCore.toZPL,
  };
})();

if (typeof module !== 'undefined') module.exports = PriceLayout;
