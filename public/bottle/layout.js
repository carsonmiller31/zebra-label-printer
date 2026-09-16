'use strict';
/*
 * Bottle label layout.
 *
 * One function lays the label out as a flat list of elements (text lines,
 * rules, boxes, the 2D code) in printer dots. The preview (SVG) and the print
 * job (ZPL) are both drawn from that same list, so what's on screen is what
 * comes out of the printer.
 *
 * Text uses the printer's built-in scalable font (^A0). ZPL can't measure or
 * shrink text, and a line that runs long simply runs off the label, so the
 * layout measures every line itself with a width table taken from the font
 * and shrinks or wraps it before it is ever sent.
 */
var BottleLayout = (function () {
  // Advance width of each character as a fraction of the font height, measured
  // from ^A0 renders. Anything not listed is assumed wide, which errs toward
  // wrapping early rather than running off the edge.
  const A0 = {"0":0.479,"1":0.479,"2":0.479,"3":0.479,"4":0.479,"5":0.479,"6":0.479,"7":0.479,"8":0.479,"9":0.479," ":0.295,"!":0.295,"\"":0.479,"#":0.479,"$":0.479,"%":0.714,"&":0.608,"'":0.295,"(":0.295,")":0.295,"*":0.479,"+":0.714,",":0.295,"-":0.714,".":0.295,"/":0.295,":":0.295,";":0.295,"<":0.714,"=":0.714,">":0.714,"?":0.442,"@":0.714,"A":0.553,"B":0.553,"C":0.534,"D":0.59,"E":0.498,"F":0.498,"G":0.59,"H":0.608,"I":0.276,"J":0.442,"K":0.553,"L":0.479,"M":0.714,"N":0.608,"O":0.572,"P":0.553,"Q":0.572,"R":0.59,"S":0.534,"T":0.498,"U":0.608,"V":0.534,"W":0.714,"X":0.553,"Y":0.553,"Z":0.498,"[":0.295,"\\":0.479,"]":0.295,"^":0.498,"_":0.498,"`":0.295,"a":0.461,"b":0.498,"c":0.442,"d":0.498,"e":0.479,"f":0.276,"g":0.498,"h":0.498,"i":0.258,"j":0.258,"k":0.442,"l":0.258,"m":0.714,"n":0.498,"o":0.479,"p":0.498,"q":0.498,"r":0.332,"s":0.424,"t":0.276,"u":0.498,"v":0.442,"w":0.664,"x":0.442,"y":0.442,"z":0.387,"{":0.498,"|":0.498,"}":0.498,"~":0.714,"\u00b7":0.35};
  const UNKNOWN = 0.72;
  const SAFETY = 1.03; // a little slack for printer/emulator differences

  // Vertical metrics of ^A0, as a fraction of the font height.
  const CAP = 0.75;  // baseline → top of capitals
  const DESC = 0.19; // baseline → bottom of g/p/y
  const LEAD = 1.1;  // baseline → next baseline

  const advance = (s, h) => {
    let w = 0;
    for (const ch of s) w += A0[ch] != null ? A0[ch] : UNKNOWN;
    return w * h;
  };
  const measure = (s, h) => Math.ceil(advance(s, h) * SAFETY);
  const blockHeight = (lines, h) => Math.round(CAP * h + (lines - 1) * LEAD * h + DESC * h);

  /** Greedy word wrap. Returns null when it can't fit in maxLines. */
  function wrap(text, h, maxW, maxLines, breakWords) {
    const words = text.split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const word of words) {
      const candidate = cur ? `${cur} ${word}` : word;
      if (measure(candidate, h) <= maxW) { cur = candidate; continue; }
      if (cur) lines.push(cur);
      cur = word;
      if (measure(word, h) > maxW) {
        if (!breakWords) return null;
        while (measure(cur, h) > maxW) {
          let n = cur.length - 1;
          while (n > 1 && measure(cur.slice(0, n), h) > maxW) n--;
          lines.push(cur.slice(0, n));
          cur = cur.slice(n);
        }
      }
      if (lines.length >= maxLines) return null;
    }
    if (cur) lines.push(cur);
    return lines.length <= maxLines ? lines : null;
  }

  /**
   * Largest font (hMax → hMin) at which `text` fits maxW in maxLines. Prefers
   * shrinking over breaking a word, and truncates only as a last resort.
   */
  function fit(text, maxW, maxLines, hMax, hMin) {
    text = String(text || '').trim().replace(/\s+/g, ' ');
    if (!text || maxW <= 0) return null;
    hMin = Math.max(8, Math.round(hMin));
    hMax = Math.max(hMin, Math.round(hMax));
    for (const breakWords of [false, true]) {
      for (let h = hMax; h >= hMin; h--) {
        const lines = wrap(text, h, maxW, maxLines, breakWords);
        if (lines) return { h, lines, truncated: false };
      }
    }
    const lines = wrap(text, hMin, maxW, Infinity, true).slice(0, maxLines);
    let last = lines[lines.length - 1];
    while (last.length > 1 && measure(`${last}...`, hMin) > maxW) last = last.slice(0, -1);
    lines[lines.length - 1] = `${last.trimEnd()}...`;
    return { h: hMin, lines, truncated: true };
  }

  /** Two lines only when one line would have to shrink past ~3/4 size. */
  function fitName(text, maxW, hMax, hMin) {
    const one = fit(text, maxW, 1, hMax, Math.max(hMin, hMax * 0.74));
    return one && !one.truncated ? one : fit(text, maxW, 2, hMax, hMin);
  }

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

  const textLine = (els, x, baseline, h, s, extra) =>
    els.push(Object.assign({ kind: 'text', x: Math.round(x), y: Math.round(baseline), h, s }, extra));

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

  /** Place a fitted block with its capitals starting at `top`. Returns its bottom. */
  function placeBlock(els, x, top, block) {
    block.lines.forEach((line, i) =>
      textLine(els, x, top + CAP * block.h + i * LEAD * block.h, block.h, line));
    return top + blockHeight(block.lines.length, block.h);
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

  const xmlEscape = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /** SVG preview in label dots; the caller sizes it with CSS. */
  function toSVG(layout, spec) {
    const { W, H } = spec;
    const out = [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">`,
      `<rect width="${W}" height="${H}" fill="#fff"/>`,
    ];
    for (const el of layout.elements) {
      if (el.kind === 'box') {
        out.push(`<rect x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" fill="#111"/>`);
      } else if (el.kind === 'text') {
        // ^A0 is a bold condensed face. Browsers won't have it, so the width
        // is pinned to the printer's measured width instead.
        out.push(
          `<text x="${el.x}" y="${el.y}" font-size="${(el.h * CAP / 0.716).toFixed(1)}" ` +
          `textLength="${advance(el.s, el.h).toFixed(1)}" lengthAdjust="spacingAndGlyphs" ` +
          `font-family="'Arial Narrow','Helvetica Neue',Arial,sans-serif" font-weight="700" ` +
          `fill="${el.reverse ? '#fff' : '#111'}">${xmlEscape(el.s)}</text>`,
        );
      } else if (el.kind === 'matrix') {
        let d = '';
        el.cells.forEach((row, r) => row.forEach((on, c) => {
          if (on) d += `M${el.x + c * el.mod} ${el.y + r * el.mod}h${el.mod}v${el.mod}h-${el.mod}z`;
        }));
        out.push(`<path d="${d}" fill="#111" shape-rendering="crispEdges"/>`);
      }
    }
    out.push('</svg>');
    return out.join('');
  }

  /** Plain characters pass through; anything else is hex-escaped for ^FH. */
  function zplText(s) {
    let out = '';
    for (const ch of s) {
      if (/[A-Za-z0-9 .,:;/()#*+=&%$@!?'"\-]/.test(ch)) out += ch;
      else for (const b of new TextEncoder().encode(ch)) out += '_' + b.toString(16).toUpperCase().padStart(2, '0');
    }
    return out;
  }

  /** The code as a ^GF bitmap, each module a solid mod × mod square of dots. */
  function matrixGraphic(el) {
    const side = el.cells.length * el.mod;
    const rowBytes = Math.ceil(side / 8);
    let hex = '';
    let prev = null;
    for (let y = 0; y < side; y++) {
      const row = el.cells[Math.floor(y / el.mod)];
      const bytes = new Uint8Array(rowBytes);
      for (let x = 0; x < side; x++) {
        if (row[Math.floor(x / el.mod)]) bytes[x >> 3] |= 0x80 >> (x & 7);
      }
      const line = Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
      // ':' repeats the previous row — each module row repeats `mod` times.
      hex += line === prev ? ':' : line;
      prev = line;
    }
    const total = rowBytes * side;
    return `^FO${el.x},${el.y}^GFA,${total},${total},${rowBytes},${hex}^FS`;
  }

  function toZPL(layout, spec, copies) {
    const lines = ['^XA', '^CI28', `^PW${spec.W}`, `^LL${spec.H}`, '^LH0,0'];
    for (const el of layout.elements) {
      if (el.kind === 'box') {
        lines.push(`^FO${el.x},${el.y}^GB${el.w},${el.h},${el.t},B,0^FS`);
      } else if (el.kind === 'text') {
        lines.push(`^FT${el.x},${el.y}^A0N,${el.h},${el.h}${el.reverse ? '^FR' : ''}^FH_^FD${zplText(el.s)}^FS`);
      } else if (el.kind === 'matrix') {
        lines.push(matrixGraphic(el));
      }
    }
    const n = Math.max(1, Math.min(99, Math.floor(Number(copies) || 1)));
    if (n > 1) lines.push(`^PQ${n}`);
    lines.push('^XZ');
    return lines.join('\n');
  }

  /** bwip-js → boolean[][] for a GS1 DataMatrix. Throws if it can't encode. */
  function encodeMatrix(bwip, data) {
    const [sym] = bwip.raw({ bcid: 'datamatrix', text: data, parsefnc: true });
    const rows = [];
    for (let r = 0; r < sym.pixy; r++) {
      rows.push(Array.from(sym.pixs.slice(r * sym.pixx, (r + 1) * sym.pixx), (v) => v === 1));
    }
    return rows;
  }

  return { build, toSVG, toZPL, encodeMatrix, measure, scheduleText };
})();

if (typeof module !== 'undefined') module.exports = BottleLayout;
