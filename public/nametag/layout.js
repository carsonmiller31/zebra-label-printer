'use strict';
/*
 * Name tag layout.
 *
 * A name tag is 3" x 1", but the printer is loaded with bigger stock, so the
 * tag is laid out in the middle of whatever label is loaded and the waste
 * around it gets dashed lines to cut along. When the stock is exactly the tag
 * size, there is nothing to cut and no lines are drawn.
 *
 *   +--------------------------------+
 *   |  - - - - - - - - - - - - - -   |   <- cut here
 *   |  [mark]  Sarah Mitchell        |
 *   |          ------------          |
 *   |          PHARMACIST            |
 *   |  - - - - - - - - - - - - - -   |   <- cut here
 *   +--------------------------------+
 *
 * Elements come out in printer dots and are drawn by LabelCore, so the preview
 * and the print job are the same drawing.
 */
var LabelCore = typeof LabelCore !== 'undefined' ? LabelCore : require('../labelcore.js');

var NameTagLayout = (function () {
  const { CAP, DESC, blockHeight, measure, fit, fitName, textLine, placeBlock } = LabelCore;

  const TAG_W_IN = 3;  // the name tag stock they get cut down to
  const TAG_H_IN = 1;

  // How much of the tag the mark may take. The height cap is what shows on a
  // normal wide tag; the width cap is what stops it from eating the name's
  // column on a tag that is tall for its width.
  const LOGO_H_SHARE = 0.72;
  const LOGO_W_SHARE = 0.32;

  /** Where the tag sits on the loaded stock, and how much waste is around it. */
  function tagBox(spec, tag) {
    const wantW = Math.max(40, Math.round((tag && tag.wIn ? tag.wIn : TAG_W_IN) * spec.dpi));
    const wantH = Math.max(40, Math.round((tag && tag.hIn ? tag.hIn : TAG_H_IN) * spec.dpi));
    const w = Math.min(spec.W, wantW);
    const h = Math.min(spec.H, wantH);
    return {
      x: Math.round((spec.W - w) / 2),
      y: Math.round((spec.H - h) / 2),
      w, h,
      trimmed: w < wantW || h < wantH,
    };
  }

  /**
   * A dashed rule just outside one edge of the tag, so cutting along it leaves
   * the tag itself unmarked. Skipped when that edge is the edge of the stock.
   */
  function cutLine(els, spec, box, side) {
    const t = Math.max(1, Math.round(spec.dpi / 120));  // ~2 dots at 203 dpi
    const dash = Math.round(spec.dpi * 0.055);
    const gap = Math.round(spec.dpi * 0.04);
    const vertical = side === 'left' || side === 'right';
    const span = vertical ? box.h : box.w;
    const waste = side === 'top' ? box.y
      : side === 'bottom' ? spec.H - (box.y + box.h)
      : side === 'left' ? box.x
      : spec.W - (box.x + box.w);
    if (waste < t + 1) return false;  // flush with the stock: nothing to cut

    const at = side === 'top' ? box.y - t
      : side === 'bottom' ? box.y + box.h
      : side === 'left' ? box.x - t
      : box.x + box.w;
    // Whole dashes only, centred on the edge so both ends look the same.
    const period = dash + gap;
    const n = Math.max(1, Math.floor((span + gap) / period));
    let start = (vertical ? box.y : box.x) + Math.round((span - (n * period - gap)) / 2);
    for (let i = 0; i < n; i++) {
      const pos = start + i * period;
      els.push(vertical
        ? { kind: 'box', x: at, y: pos, w: t, h: dash, t }
        : { kind: 'box', x: pos, y: at, w: dash, h: t, t });
    }
    return true;
  }

  /**
   * The name, a short rule and the title, sized at `k` of full size. Returns
   * the pieces and the height the three of them need together.
   */
  function textStack(input, colW, box, k) {
    const unit = Math.min(box.w, box.h);
    const name = fitName(input.name || 'Name', colW, unit * 0.30 * k, unit * 0.13);
    const title = input.title
      ? fit(input.title.toUpperCase(), colW, 1, Math.min(name.h * 0.55, unit * 0.17 * k), unit * 0.085)
      : null;
    const nameH = blockHeight(name.lines.length, name.h);
    const ruleGapAbove = Math.round(unit * 0.05);
    const ruleT = Math.max(2, Math.round(unit * 0.015));
    const ruleGapBelow = Math.round(unit * 0.055);
    const titleH = title ? Math.round((CAP + DESC) * title.h) : 0;
    const h = nameH + (title ? ruleGapAbove + ruleT + ruleGapBelow + titleH : 0);
    return { name, title, nameH, ruleGapAbove, ruleT, ruleGapBelow, titleH, h };
  }

  /**
   * input: { name, title, logo, cutLines }
   *        logo = { w, h, rows, png } or null; cutLines false = no dashed guides
   * spec:  { W, H, dpi }           the loaded stock, in dots
   * tag:   { wIn, hIn }            the finished tag size, in inches
   * → { elements, notes, fits, box, cut }
   */
  function build(input, spec, tag) {
    const els = [];
    const notes = [];
    const box = tagBox(spec, tag);
    let fits = true;
    if (box.trimmed) {
      notes.push('The tag is bigger than the label that is loaded, so it was trimmed to the label.');
    }

    // Dashed cut guides around the tag, in the waste — unless turned off.
    // `cut` still reports whether there is waste to cut away, lines or not.
    let cut = false;
    const guides = input.cutLines === false ? [] : els;
    for (const side of ['top', 'bottom', 'left', 'right']) {
      if (cutLine(guides, spec, box, side)) cut = true;
    }

    const unit = Math.min(box.w, box.h); // the short side: what the type has to live within
    const m = Math.max(6, Math.round(unit * 0.09));
    const innerH = box.h - 2 * m;
    const left = box.x + m;
    const right = box.x + box.w - m;
    let x = left;

    // --- The mark, down the left, vertically centred -------------------------
    let mark = null;
    if (input.logo) {
      const scale = Math.min(
        1,
        (box.h * LOGO_H_SHARE) / input.logo.h,
        (box.w * LOGO_W_SHARE) / input.logo.w,
      );
      const lw = Math.max(1, Math.round(input.logo.w * scale));
      const lh = Math.max(1, Math.round(input.logo.h * scale));
      mark = {
        kind: 'image',
        x: Math.round(x),
        y: Math.round(box.y + (box.h - lh) / 2),
        w: lw, h: lh, rows: input.logo.rows, png: input.logo.png,
      };
      els.push(mark);
      x += lw + Math.round(unit * 0.1);
    }

    // --- Name, a short rule, then the title ----------------------------------
    let colW = right - x;
    if (mark && colW < unit * 0.6) {
      // Too narrow a tag to hold both. A name tag without the name is no use,
      // so the mark is the part that goes.
      els.splice(els.indexOf(mark), 1);
      notes.push('There is no room for the logo beside the name on a tag this shape, so the tag prints without it.');
      x = left;
      colW = right - x;
    }
    if (colW < unit * 0.35) {
      notes.push('The name does not fit on a tag this size — make it wider, or shorter.');
      return { elements: els, notes, fits: false, box, cut };
    }

    // The name sets the scale; the title and the rule follow it. Nothing here
    // can be measured against the tag's height until it is laid out, so the
    // whole stack is tried a step smaller until it clears the tag.
    let stack = null;
    for (let k = 1; k >= 0.5; k -= 0.05) {
      stack = textStack(input, colW, box, k);
      if (stack.h <= innerH) break;
    }
    if (stack.h > innerH) {
      notes.push("The name and title don't fit on a tag this size — check the preview.");
      fits = false;
    }
    const { name, title } = stack;
    if (name.truncated) {
      notes.push('The name was shortened to fit.');
      fits = false;
    }
    if (title && title.truncated) {
      notes.push('The title was shortened to fit.');
      fits = false;
    }

    let y = box.y + Math.round((box.h - stack.h) / 2);
    y = placeBlock(els, x, y, name);

    if (title) {
      const ruleW = Math.min(
        colW,
        Math.max(...name.lines.map((line) => measure(line, name.h)), measure(title.lines[0], title.h)),
      );
      y += stack.ruleGapAbove;
      els.push({ kind: 'box', x: Math.round(x), y: Math.round(y), w: Math.round(ruleW), h: stack.ruleT, t: stack.ruleT });
      y += stack.ruleT + stack.ruleGapBelow;
      textLine(els, x, y + CAP * title.h, title.h, title.lines[0]);
    }

    return { elements: els, notes, fits, box, cut };
  }

  /** The box, in dots, the mark has to be rasterised into for this stock. */
  function logoBox(spec, tag) {
    const box = tagBox(spec, tag);
    return {
      maxW: Math.max(8, Math.round(box.w * LOGO_W_SHARE)),
      maxH: Math.max(8, Math.round(box.h * LOGO_H_SHARE)),
    };
  }

  return { build, logoBox, tagBox, TAG_W_IN, TAG_H_IN, toSVG: LabelCore.toSVG, toZPL: LabelCore.toZPL };
})();

if (typeof module !== 'undefined') module.exports = NameTagLayout;
