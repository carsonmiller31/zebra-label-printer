'use strict';
/*
 * Shared label drawing core.
 *
 * A label is laid out as a flat list of elements in printer dots:
 *
 *   { kind: 'text',   x, y (baseline), h, s, reverse? }
 *   { kind: 'box',    x, y, w, h, t }                      // t = border thickness
 *   { kind: 'matrix', x, y, mod, cells }                   // boolean[][]
 *   { kind: 'image',  x, y, w, h, rows, png? }             // rows = boolean[][]
 *
 * An image is drawn at w x h dots whatever resolution `rows` holds, so a
 * bitmap rasterised for one label size still prints (a little rougher) on
 * another.
 *
 * The preview (SVG) and the print job (ZPL) are both drawn from that one list,
 * so what's on screen is what comes out of the printer.
 *
 * Text uses the printer's built-in scalable font (^A0). ZPL can't measure or
 * shrink text, and a line that runs long simply runs off the label, so the
 * layout measures every line here with a width table taken from the font and
 * shrinks or wraps it before it is ever sent.
 */
var LabelCore = (function () {
  // Advance width of each character as a fraction of the font height, measured
  // from ^A0 renders. Anything not listed is assumed wide, which errs toward
  // wrapping early rather than running off the edge.
  const A0 = {"0":0.479,"1":0.479,"2":0.479,"3":0.479,"4":0.479,"5":0.479,"6":0.479,"7":0.479,"8":0.479,"9":0.479," ":0.295,"!":0.295,"\"":0.479,"#":0.479,"$":0.479,"%":0.714,"&":0.608,"'":0.295,"(":0.295,")":0.295,"*":0.479,"+":0.714,",":0.295,"-":0.714,".":0.295,"/":0.295,":":0.295,";":0.295,"<":0.714,"=":0.714,">":0.714,"?":0.442,"@":0.714,"A":0.553,"B":0.553,"C":0.534,"D":0.59,"E":0.498,"F":0.498,"G":0.59,"H":0.608,"I":0.276,"J":0.442,"K":0.553,"L":0.479,"M":0.714,"N":0.608,"O":0.572,"P":0.553,"Q":0.572,"R":0.59,"S":0.534,"T":0.498,"U":0.608,"V":0.534,"W":0.714,"X":0.553,"Y":0.553,"Z":0.498,"[":0.295,"\\":0.479,"]":0.295,"^":0.498,"_":0.498,"`":0.295,"a":0.461,"b":0.498,"c":0.442,"d":0.498,"e":0.479,"f":0.276,"g":0.498,"h":0.498,"i":0.258,"j":0.258,"k":0.442,"l":0.258,"m":0.714,"n":0.498,"o":0.479,"p":0.498,"q":0.498,"r":0.332,"s":0.424,"t":0.276,"u":0.498,"v":0.442,"w":0.664,"x":0.442,"y":0.442,"z":0.387,"{":0.498,"|":0.498,"}":0.498,"~":0.714,"\u00b7":0.35};
  const UNKNOWN = 0.72;
  const SAFETY = 1.03; // a little slack for printer/emulator differences

  // Vertical metrics of ^A0, as a fraction of the font height.
  const CAP = 0.75;  // baseline -> top of capitals
  const DESC = 0.19; // baseline -> bottom of g/p/y
  const LEAD = 1.1;  // baseline -> next baseline

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
   * Largest font (hMax -> hMin) at which `text` fits maxW in maxLines. Prefers
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

  const textLine = (els, x, baseline, h, s, extra) =>
    els.push(Object.assign({ kind: 'text', x: Math.round(x), y: Math.round(baseline), h, s }, extra));

  /** Place a fitted block with its capitals starting at `top`. Returns its bottom. */
  function placeBlock(els, x, top, block) {
    block.lines.forEach((line, i) =>
      textLine(els, x, top + CAP * block.h + i * LEAD * block.h, block.h, line));
    return top + blockHeight(block.lines.length, block.h);
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
      } else if (el.kind === 'image') {
        // The same dots that go to the printer, drawn one PNG pixel per dot.
        if (el.png) {
          out.push(
            `<image x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" ` +
            `href="${xmlEscape(el.png)}" preserveAspectRatio="none" image-rendering="pixelated"/>`,
          );
        }
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

  /**
   * A ^GF bitmap: `width` x `height` dots, `on(x, y)` telling which are black.
   * Identical rows collapse to ':' (ZPL's "repeat the row above").
   */
  function bitmapGraphic(x, y, width, height, on) {
    const rowBytes = Math.ceil(width / 8);
    let hex = '';
    let prev = null;
    for (let row = 0; row < height; row++) {
      const bytes = new Uint8Array(rowBytes);
      for (let col = 0; col < width; col++) {
        if (on(col, row)) bytes[col >> 3] |= 0x80 >> (col & 7);
      }
      const line = Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
      hex += line === prev ? ':' : line;
      prev = line;
    }
    const total = rowBytes * height;
    return `^FO${Math.round(x)},${Math.round(y)}^GFA,${total},${total},${rowBytes},${hex}^FS`;
  }

  /** The 2D code as a ^GF bitmap, each module a solid mod x mod square of dots. */
  function matrixGraphic(el) {
    const side = el.cells.length * el.mod;
    return bitmapGraphic(el.x, el.y, side, side,
      (x, y) => el.cells[Math.floor(y / el.mod)][Math.floor(x / el.mod)]);
  }

  /** Reads an image element's dots at its printed size (nearest neighbour). */
  function imageSampler(el) {
    const rh = el.rows.length;
    const rw = rh ? el.rows[0].length : 0;
    if (!rh || !rw) return () => false;
    if (rw === el.w && rh === el.h) return (x, y) => el.rows[y][x];
    return (x, y) => el.rows[Math.min(rh - 1, Math.floor((y * rh) / el.h))]
                           [Math.min(rw - 1, Math.floor((x * rw) / el.w))];
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
      } else if (el.kind === 'image') {
        lines.push(bitmapGraphic(el.x, el.y, el.w, el.h, imageSampler(el)));
      }
    }
    const n = Math.max(1, Math.min(99, Math.floor(Number(copies) || 1)));
    if (n > 1) lines.push(`^PQ${n}`);
    lines.push('^XZ');
    return lines.join('\n');
  }

  return {
    CAP, DESC, LEAD,
    advance, measure, blockHeight, wrap, fit, fitName, textLine, placeBlock,
    toSVG, toZPL, zplText, xmlEscape, bitmapGraphic, imageSampler,
  };
})();

if (typeof module !== 'undefined') module.exports = LabelCore;
