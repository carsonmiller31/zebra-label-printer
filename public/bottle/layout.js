'use strict';
/*
 * Bottle label layout.
 *
 * One function lays the label out as a flat list of elements (text lines,
 * rules, boxes, the 2D code) in printer dots. LabelCore draws that same list
 * as both the preview (SVG) and the print job (ZPL), and measures the printer
 * font so no line can run off the edge.
 */
var LabelCore = typeof LabelCore !== 'undefined' ? LabelCore : require('../labelcore.js');

var BottleLayout = (function () {
  const {
    CAP, DESC, LEAD,
    advance, measure, blockHeight, fit, fitName, textLine, placeBlock,
  } = LabelCore;

  const scheduleText = (s) => {
    const m = /^C?(I{1,3}V?|IV|V)N?$/i.exec(String(s || '').trim());
    return m ? `C${m[1].toUpperCase()}` : String(s || '').trim();
  };

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  /**
   * input: { name, generic, strength, dosageForm, size, labeler, schedule,
   *          ndc, lot, exp, serial, cells }   (cells = boolean[][] or null)
   * spec:  { W, H, dpi }   label size in dots
   * → { elements, notes }
   */
  function build(input, spec) {
    const compact = spec.H < 1.4 * spec.dpi;
    let best = null;
    // Start large and step down until everything fits. Small stock varies a
    // lot in height (1" vs 1.25"), so its text is allowed to start bigger and
    // use what's there.
    for (let k = compact ? 1.4 : 1; k >= 0.55; k -= 0.05) {
      const out = compact ? compactLayout(input, spec, k) : standardLayout(input, spec, k);
      best = out;
      if (out.fits) break;
    }
    if (!best.fits) best.notes.push("There's more text than fits on this label size — check the preview.");
    return best;
  }

  /**
   * Sizes below are designed in dots for 3" x 2" stock at 203 dpi. P() converts
   * them to this printer's dots, and — on stock bigger than 3" x 2" — grows
   * them with the label so a 4" x 3" isn't a small label in a big margin.
   */
  function context(spec) {
    const growth = Math.min(1.6, Math.max(1, Math.min(spec.W / (3 * spec.dpi), spec.H / (2 * spec.dpi))));
    const u = (spec.dpi / 203) * growth;
    const P = (v) => Math.max(1, Math.round(v * u));
    return { u, P, els: [], notes: [] };
  }

  /*
   * ^A0's hyphen is an en-dash-wide glyph, which turns "0093-7180-56" into
   * "0093 – 7180 – 56". Values (NDC, lot, serial) draw their hyphens as short
   * bars instead, so the code reads the way it's printed on the bottle.
   */
  const dashW = (h) => Math.round(h * 0.36);
  const valueWidth = (s, h) =>
    s.split('-').reduce((w, part) => w + measure(part, h), 0) + (s.split('-').length - 1) * dashW(h);

  function valueLine(els, x, baseline, h, s) {
    const parts = s.split('-');
    let cx = x;
    parts.forEach((part, i) => {
      if (part) textLine(els, cx, baseline, h, part);
      cx += advance(part, h);
      if (i < parts.length - 1) {
        const bar = Math.max(1, Math.round(h * 0.09));
        els.push({
          kind: 'box', x: Math.round(cx + h * 0.07), y: Math.round(baseline - h * 0.33),
          w: Math.round(h * 0.22), h: bar, t: bar,
        });
        cx += dashW(h);
      }
    });
  }

  function badge(ctx, xRight, top, h, label) {
    const pad = Math.round(h * 0.22);
    const w = measure(label, h) + pad * 2;
    const bh = Math.round(CAP * h) + pad * 2;
    const x = xRight - w;
    ctx.els.push({ kind: 'box', x, y: Math.round(top), w, h: bh, t: Math.min(w, bh) });
    textLine(ctx.els, x + pad, top + pad + CAP * h, h, label, { reverse: true });
    return { w, h: bh };
  }

  /** Largest whole-dot module size that keeps the code inside `maxSide`. */
  function codeGeometry(cells, maxSide, P) {
    if (!cells) return null;
    const n = cells.length;
    const mod = Math.min(P(6), Math.floor(maxSide / n));
    return { n, mod, side: n * mod, readable: mod >= 2 };
  }

  const subLine = (input) => [input.strength, input.dosageForm].filter(Boolean).join(' \u00b7 ');

  /** Key/value rows ("NDC  0093-7180-56") with a shared value size. */
  function fieldRows(input) {
    const rows = [['NDC', input.ndc || '—']];
    if (input.lot) rows.push(['LOT', input.lot]);
    if (input.exp) rows.push(['EXP', input.exp]);
    if (input.serial) rows.push(['SN', input.serial]);
    return rows;
  }

  function standardLayout(input, spec, k) {
    const ctx = context(spec);
    const { P, els, notes } = ctx;
    const { W, H } = spec;
    const m = P(14);
    const x0 = m, x1 = W - m, fullW = x1 - x0;
    let fits = true;
    let y = m;

    // --- Header: schedule badge, drug name, strength/form, package ---------
    let badgeBox = null;
    if (input.schedule) badgeBox = badge(ctx, x1, y, Math.round(P(30) * Math.max(k, 0.8)), scheduleText(input.schedule));
    const nameW = fullW - (badgeBox ? badgeBox.w + P(12) : 0);

    const name = fitName(input.name || 'Drug name', nameW, P(46) * k, P(24) * k);
    y = placeBlock(els, x0, y, name) + P(6);
    if (name.truncated) notes.push('The drug name was shortened to fit.');

    if (input.generic) {
      const g = fit(input.generic, nameW, 1, P(22) * k, P(15) * k);
      y = placeBlock(els, x0, y, g) + P(6);
    }
    const sub = subLine(input);
    if (sub) y = placeBlock(els, x0, y, fit(sub, fullW, 2, P(28) * k, P(17) * k)) + P(6);
    if (input.size) y = placeBlock(els, x0, y, fit(input.size, fullW, 1, P(22) * k, P(15) * k)) + P(4);
    if (badgeBox) y = Math.max(y, m + badgeBox.h + P(6));

    els.push({ kind: 'box', x: x0, y, w: fullW, h: P(3), t: P(3) });
    const bodyTop = y + P(3) + P(10);

    // --- Footer: manufacturer and Rx only ------------------------------------
    const fh = Math.round(P(19) * Math.max(k, 0.8));
    const footBase = H - m - Math.round(DESC * fh);
    const rx = 'Rx only';
    const rxW = measure(rx, fh);
    textLine(els, x1 - rxW, footBase, fh, rx);
    if (input.labeler) {
      const lab = fit(input.labeler, fullW - rxW - P(20), 1, fh, P(13));
      textLine(els, x0, footBase, lab.h, lab.lines[0]);
    }
    const footRule = Math.round(footBase - CAP * fh - P(9));
    els.push({ kind: 'box', x: x0, y: footRule, w: fullW, h: P(2), t: P(2) });
    const bodyBottom = footRule - P(10);
    const bodyH = bodyBottom - bodyTop;

    // --- Body: 2D code on the left, the fields on the right ----------------
    const code = codeGeometry(input.cells, Math.min(bodyH, P(200), Math.round(fullW * 0.38)), P);
    let fx = x0;
    if (code) {
      if (!code.readable) fits = false;
      const cy = bodyTop + Math.max(0, Math.round((bodyH - code.side) / 2));
      els.push({ kind: 'matrix', x: x0, y: cy, mod: code.mod, cells: input.cells });
      fx = x0 + code.side + P(20);
    }
    const rows = fieldRows(input);
    const kh = P(16);
    const keyW = Math.max(...rows.map(([key]) => measure(key, kh))) + P(12);
    const valueW = x1 - fx - keyW;

    // One size for every value: the largest that fits both across and down.
    const pitch = 1.24;
    const byHeight = Math.floor(bodyH / (CAP + (rows.length - 1) * pitch + DESC));
    let vh = Math.min(Math.round(P(34) * k), byHeight);
    const floor = P(17);
    while (vh > floor && rows.some(([, v]) => valueWidth(v, vh) > valueW)) vh--;
    if (vh < floor) { vh = floor; fits = false; }

    const blockH = (CAP + (rows.length - 1) * pitch) * vh;
    let base = bodyTop + Math.max(0, (bodyH - blockH - DESC * vh) / 2) + CAP * vh;
    for (const [key, value] of rows) {
      textLine(els, fx, base, kh, key);
      const v = valueWidth(value, vh) <= valueW ? { lines: [value] } : fit(value, valueW, 1, vh, vh);
      valueLine(els, fx + keyW, base, vh, v.lines[0]);
      if (v.truncated) notes.push(`The ${key === 'SN' ? 'serial number' : key.toLowerCase()} was cut off — it's too long for this label.`);
      base += pitch * vh;
    }

    if (bodyH < (code ? code.n * 2 : P(60))) fits = false;
    return { elements: els, notes, fits };
  }

  function compactLayout(input, spec, k) {
    const ctx = context(spec);
    const { P, els, notes } = ctx;
    const { W, H } = spec;
    const m = P(10);
    const x0 = m, x1 = W - m;
    let fits = true;

    const code = codeGeometry(input.cells, Math.min(H - 2 * m, Math.round((W - 2 * m) * 0.4)), P);
    let fx = x0;
    if (code) {
      if (!code.readable) fits = false;
      els.push({ kind: 'matrix', x: x0, y: Math.round((H - code.side) / 2), mod: code.mod, cells: input.cells });
      fx = x0 + code.side + P(12);
    }
    const colW = x1 - fx;
    const firstText = els.length;
    let y = m;

    let badgeBox = null;
    if (input.schedule) badgeBox = badge(ctx, x1, y, Math.round(P(20) * Math.max(k, 0.8)), scheduleText(input.schedule));
    const nameW = colW - (badgeBox ? badgeBox.w + P(8) : 0);
    const name = fitName(input.name || 'Drug name', nameW, P(30) * k, P(15) * k);
    y = placeBlock(els, fx, y, name) + P(4);
    if (name.truncated) { notes.push('The drug name was shortened to fit.'); fits = false; }

    const sub = subLine(input);
    if (sub) y = placeBlock(els, fx, y, fit(sub, colW, 1, P(20) * k, P(13) * k)) + P(4);
    if (badgeBox) y = Math.max(y, m + badgeBox.h + P(4));
    y += P(2);

    // Fields: key in small type, value bold, as many per line as fit.
    const kh = Math.round(P(13) * Math.max(k, 0.8));
    const vh = Math.round(P(20) * k);
    const gap = P(14);
    const rows = fieldRows(input);
    const segments = rows.map(([key, value]) => ({
      key, value, w: measure(key, kh) + P(6) + valueWidth(value, vh),
    }));
    const lines = [];
    for (const seg of segments) {
      const line = lines[lines.length - 1];
      const used = line ? line.reduce((sum, s) => sum + s.w + gap, 0) : Infinity;
      // NDC and serial get lines of their own; lot and expiry may share one.
      const shareable = line && line.every((s) => s.key === 'LOT') && seg.key === 'EXP';
      if (shareable && used + seg.w <= colW) line.push(seg);
      else lines.push([seg]);
    }
    for (const line of lines) {
      const base = y + CAP * vh;
      let x = fx;
      for (const seg of line) {
        textLine(els, x, base, kh, seg.key);
        const vx = x + measure(seg.key, kh) + P(6);
        const v = valueWidth(seg.value, vh) <= x1 - vx ? { lines: [seg.value] } : fit(seg.value, x1 - vx, 1, vh, vh);
        valueLine(els, vx, base, vh, v.lines[0]);
        if (v.truncated) {
          notes.push(`The ${seg.key === 'SN' ? 'serial number' : seg.key.toLowerCase()} was cut off.`);
          fits = false;
        }
        x += seg.w + gap;
      }
      y += LEAD * vh * 1.05;
    }
    y += DESC * vh - LEAD * vh * 0.05;

    if (y > H - m + 1) fits = false;
    // Centre the text column against the label's height.
    const shift = Math.floor((H - m - y) / 2);
    if (shift > 0) {
      for (const el of els.slice(firstText)) el.y += shift;
    }
    return { elements: els, notes, fits };
  }

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  /** bwip-js → boolean[][] for a GS1 DataMatrix. Throws if it can't encode. */
  function encodeMatrix(bwip, data) {
    const [sym] = bwip.raw({ bcid: 'datamatrix', text: data, parsefnc: true });
    const rows = [];
    for (let r = 0; r < sym.pixy; r++) {
      rows.push(Array.from(sym.pixs.slice(r * sym.pixx, (r + 1) * sym.pixx), (v) => v === 1));
    }
    return rows;
  }

  return {
    build, encodeMatrix, measure, scheduleText,
    toSVG: LabelCore.toSVG,
    toZPL: LabelCore.toZPL,
  };
})();

if (typeof module !== 'undefined') module.exports = BottleLayout;
