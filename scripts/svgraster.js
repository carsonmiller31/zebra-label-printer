'use strict';
/*
 * A very small SVG rasterizer: enough to turn the pharmacy mark into pixels,
 * and no more.
 *
 * Why not a library. scripts/make-icon.js has always had zero dependencies —
 * it hand-rolls its own PNG encoder — and that is worth keeping: the icon is
 * built in CI on a Windows runner as the first step of `npm run dist:win`, and
 * a native-binary image library (sharp, resvg, canvas) is the kind of thing
 * that breaks a release build on a platform nobody tested. The mark is flat
 * single-colour paths, so the general case never comes up.
 *
 * What it handles: <path> elements, the M/L/H/V/C/S/Q/T/Z command set in both
 * cases, the viewBox, and a real transform stack over nested <g> elements
 * (translate/scale/rotate/matrix/skew). Fill rule is nonzero, which is what
 * makes the counters inside the mark (the swirl gaps) come out as holes rather
 * than filling in.
 *
 * The transform stack is not over-engineering. This very logo has TWO groups —
 * twelve traced paths under `translate(0,1024) scale(0.1,-0.1)` and a
 * thirteenth under a plain <g> whose coordinates are already in viewBox units.
 * An earlier version took the first transform it found and applied it to every
 * path, which threw the thirteenth (a stroke along the bowl's rim) off-canvas.
 * It cost about 1% of the artwork and was invisible until the output was
 * diffed against Chrome's renderer pixel by pixel.
 *
 * What it does NOT handle, and refuses loudly rather than guessing: elliptical
 * arcs (A/a), strokes, gradients, opacity, clip paths, and every drawable
 * element that isn't <path> (<rect>, <circle>, <polygon>…). If a future logo
 * uses any of them this throws, which is the right outcome — a silently
 * mis-drawn icon would ship.
 *
 * Coverage is computed by 4x4 supersampling: the shape is scanline-filled at
 * four times the output resolution and boxed back down, which gives clean
 * enough edges for an icon without needing real analytic anti-aliasing.
 */

const SS = 4; // supersampling factor per axis

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

// ---- Affine transforms: [a, b, c, d, e, f], (x,y) -> (ax+cy+e, bx+dy+f) ----

const IDENTITY = [1, 0, 0, 1, 0, 0];

/** m1 applied to the result of m2 — SVG's left-to-right reading order. */
function compose(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

const applyMatrix = (m, x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

/** One `transform` attribute → a single matrix. */
function parseTransform(spec) {
  let m = IDENTITY;
  const re = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let hit;
  while ((hit = re.exec(spec))) {
    const name = hit[1];
    const n = hit[2].trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (n.some((v) => !Number.isFinite(v))) {
      throw new Error(`svgraster: bad numbers in transform "${hit[0]}"`);
    }
    let step;
    switch (name) {
      case 'translate': step = [1, 0, 0, 1, n[0] || 0, n[1] || 0]; break;
      case 'scale': step = [n[0], 0, 0, n.length > 1 ? n[1] : n[0], 0, 0]; break;
      case 'matrix': step = n.slice(0, 6); break;
      case 'rotate': {
        const r = ((n[0] || 0) * Math.PI) / 180;
        const cos = Math.cos(r), sin = Math.sin(r);
        step = [cos, sin, -sin, cos, 0, 0];
        // rotate(a, cx, cy) == translate(cx,cy) rotate(a) translate(-cx,-cy)
        if (n.length >= 3) {
          step = compose(compose([1, 0, 0, 1, n[1], n[2]], step), [1, 0, 0, 1, -n[1], -n[2]]);
        }
        break;
      }
      case 'skewX': step = [1, 0, Math.tan(((n[0] || 0) * Math.PI) / 180), 1, 0, 0]; break;
      case 'skewY': step = [1, Math.tan(((n[0] || 0) * Math.PI) / 180), 0, 1, 0, 0]; break;
      default:
        throw new Error(`svgraster: unsupported transform function "${name}()"`);
    }
    m = compose(m, step);
  }
  const leftover = spec.replace(/[a-zA-Z]+\s*\([^)]*\)|[\s,]+/g, '');
  if (leftover) throw new Error(`svgraster: could not parse transform "${spec}"`);
  return m;
}

/** Drawable SVG elements this cannot render — better to stop than to skip one. */
const UNSUPPORTED = /<(rect|circle|ellipse|line|polyline|polygon|text|image|use)\b/i;

/**
 * Pull the viewBox and every path — each paired with the transform in scope
 * where it appears — out of the SVG.
 */
function parseSvg(text) {
  const viewBox = /viewBox\s*=\s*"([^"]+)"/.exec(text);
  if (!viewBox) throw new Error('svgraster: the SVG has no viewBox');
  const [vx, vy, vw, vh] = viewBox[1].trim().split(/[\s,]+/).map(Number);
  if (!(vw > 0 && vh > 0)) throw new Error(`svgraster: bad viewBox "${viewBox[1]}"`);

  const stray = UNSUPPORTED.exec(text);
  if (stray) {
    throw new Error(
      `svgraster: <${stray[1]}> is not supported — convert shapes to paths first ` +
      `(Illustrator: Object > Path > Outline Stroke, then Object > Compound Path > Make)`,
    );
  }

  /* Walk the tags in order, keeping a stack of the transforms in scope, so a
     path is drawn with the transforms of every group that encloses it — and,
     equally, WITHOUT the transform of a sibling group it is not inside. */
  const paths = [];
  const stack = [IDENTITY];
  const tag = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  let t;
  while ((t = tag.exec(text))) {
    const closing = t[1], name = t[2], attrs = t[3], selfClosing = t[4];
    if (name !== 'g' && name !== 'path') continue;

    if (closing) {
      if (name === 'g' && stack.length > 1) stack.pop();
      continue;
    }

    const xf = /\stransform\s*=\s*"([^"]*)"/.exec(attrs);
    const top = stack[stack.length - 1];
    const here = xf ? compose(top, parseTransform(xf[1])) : top;

    if (name === 'g') {
      if (!selfClosing) stack.push(here); // a self-closing <g/> opens nothing
      continue;
    }

    const d = /\sd\s*=\s*"([^"]*)"/.exec(attrs);
    if (d && d[1].trim()) paths.push({ d: d[1], matrix: here });
  }

  if (!paths.length) throw new Error('svgraster: the SVG has no <path> elements');
  return { vx, vy, vw, vh, paths };
}

/** Path data → a list of closed polygons (arrays of {x, y}) in user space. */
function flatten(d) {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtZzAa]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g) || [];
  const polys = [];
  let poly = null;
  let cx = 0, cy = 0;      // current point
  let sx = 0, sy = 0;      // start of the current subpath
  let px = null, py = null; // previous cubic control, for S/s
  let qx = null, qy = null; // previous quadratic control, for T/t
  let cmd = null;
  let i = 0;

  const num = () => {
    const v = Number(tokens[i++]);
    if (!Number.isFinite(v)) throw new Error(`svgraster: bad number in path data near "${tokens[i - 1]}"`);
    return v;
  };
  const open = () => { poly = [{ x: cx, y: cy }]; polys.push(poly); };
  const lineTo = (x, y) => { if (!poly) open(); poly.push({ x, y }); cx = x; cy = y; };

  /* Fixed subdivision. The mark's curves are short trace segments, and at 4x
     supersampling of a 512px icon a 16-segment flattening is far below one
     output pixel of error. */
  const STEPS = 16;
  const cubic = (x1, y1, x2, y2, x, y) => {
    const x0 = cx, y0 = cy;
    for (let s = 1; s <= STEPS; s++) {
      const t = s / STEPS, u = 1 - t;
      const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, e = t * t * t;
      if (!poly) open();
      poly.push({ x: a * x0 + b * x1 + c * x2 + e * x, y: a * y0 + b * y1 + c * y2 + e * y });
    }
    px = x2; py = y2; qx = qy = null;
    cx = x; cy = y;
  };
  const quad = (x1, y1, x, y) => {
    // Raise to a cubic rather than writing a second flattener.
    const c1x = cx + (2 / 3) * (x1 - cx), c1y = cy + (2 / 3) * (y1 - cy);
    const c2x = x + (2 / 3) * (x1 - x), c2y = y + (2 / 3) * (y1 - y);
    cubic(c1x, c1y, c2x, c2y, x, y);
    px = py = null; qx = x1; qy = y1;
  };

  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++];
    else if (cmd === 'M') cmd = 'L';        // repeated coords after M are lineto
    else if (cmd === 'm') cmd = 'l';
    if (cmd === 'A' || cmd === 'a') {
      throw new Error('svgraster: elliptical arcs (A/a) are not supported — flatten them in the drawing app');
    }

    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? cx : 0, oy = rel ? cy : 0;

    switch (cmd.toUpperCase()) {
      case 'M': {
        cx = ox + num(); cy = oy + num();
        sx = cx; sy = cy;
        open();
        px = py = qx = qy = null;
        break;
      }
      case 'L': { const x = ox + num(), y = oy + num(); lineTo(x, y); px = py = qx = qy = null; break; }
      case 'H': { const x = ox + num(); lineTo(x, cy); px = py = qx = qy = null; break; }
      case 'V': { const y = oy + num(); lineTo(cx, y); px = py = qx = qy = null; break; }
      case 'C': {
        const x1 = ox + num(), y1 = oy + num(), x2 = ox + num(), y2 = oy + num();
        cubic(x1, y1, x2, y2, ox + num(), oy + num());
        break;
      }
      case 'S': {
        // The first control point mirrors the previous curve's second one.
        const x1 = px == null ? cx : 2 * cx - px;
        const y1 = py == null ? cy : 2 * cy - py;
        const x2 = ox + num(), y2 = oy + num();
        cubic(x1, y1, x2, y2, ox + num(), oy + num());
        break;
      }
      case 'Q': { const x1 = ox + num(), y1 = oy + num(); quad(x1, y1, ox + num(), oy + num()); break; }
      case 'T': {
        const x1 = qx == null ? cx : 2 * cx - qx;
        const y1 = qy == null ? cy : 2 * cy - qy;
        quad(x1, y1, ox + num(), oy + num());
        break;
      }
      case 'Z': {
        if (poly && poly.length > 1) poly.push({ x: sx, y: sy });
        cx = sx; cy = sy;
        poly = null;
        px = py = qx = qy = null;
        break;
      }
      default:
        throw new Error(`svgraster: unsupported path command "${cmd}"`);
    }
  }

  return polys.filter((p) => p.length > 2);
}

// ---------------------------------------------------------------------------
// Filling
// ---------------------------------------------------------------------------

/**
 * Scanline-fill one path's polygons into `mask` using the nonzero winding rule.
 * `mask` is one byte per supersample; a covered sample is set to 1. Paths are
 * OR'd together because the mark is one flat colour — at the sample level,
 * painting an opaque shape over another of the same colour IS a union.
 */
function fillPath(mask, W, H, polys) {
  const edges = [];
  let minY = Infinity, maxY = -Infinity;
  for (const poly of polys) {
    for (let k = 0; k < poly.length - 1; k++) {
      const a = poly[k], b = poly[k + 1];
      if (a.y === b.y) continue; // horizontal edges contribute no crossings
      edges.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y, dir: b.y > a.y ? 1 : -1 });
      minY = Math.min(minY, a.y, b.y);
      maxY = Math.max(maxY, a.y, b.y);
    }
  }
  if (!edges.length) return;

  const yStart = Math.max(0, Math.floor(minY));
  const yEnd = Math.min(H - 1, Math.ceil(maxY));
  const xs = [];

  for (let y = yStart; y <= yEnd; y++) {
    const sy = y + 0.5; // sample at the row's centre
    xs.length = 0;
    for (const e of edges) {
      const lo = Math.min(e.y0, e.y1), hi = Math.max(e.y0, e.y1);
      if (sy < lo || sy >= hi) continue;
      xs.push({ x: e.x0 + ((sy - e.y0) / (e.y1 - e.y0)) * (e.x1 - e.x0), dir: e.dir });
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a.x - b.x);

    let winding = 0;
    const row = y * W;
    for (let k = 0; k < xs.length - 1; k++) {
      winding += xs[k].dir;
      if (winding === 0) continue; // outside the shape between these crossings
      const from = Math.max(0, Math.ceil(xs[k].x - 0.5));
      const to = Math.min(W - 1, Math.floor(xs[k + 1].x - 0.5));
      for (let x = from; x <= to; x++) mask[row + x] = 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Rasterize an SVG's paths into an alpha coverage map.
 *
 * The artwork is fitted into `width` x `height` preserving its aspect ratio and
 * centred, so the caller can hand over a padded content box and not think about
 * the drawing's proportions.
 *
 * → { alpha: Uint8Array(width*height), box: {x, y, w, h} } — box is where the
 *   artwork actually landed, which is what a caller needs to place anything
 *   else relative to it.
 */
function rasterize(svgText, width, height) {
  const { vx, vy, vw, vh, paths } = parseSvg(svgText);

  // Fit the viewBox into the target box, preserving aspect (SVG's "meet").
  const scale = Math.min(width / vw, height / vh);
  const drawW = vw * scale, drawH = vh * scale;
  const offX = (width - drawW) / 2, offY = (height - drawH) / 2;

  const W = width * SS, H = height * SS;
  const mask = new Uint8Array(W * H);

  // user space → the transforms in scope → viewBox origin → fitted box → samples
  const toDevice = (m) => (p) => {
    const q = applyMatrix(m, p.x, p.y);
    return { x: (offX + (q.x - vx) * scale) * SS, y: (offY + (q.y - vy) * scale) * SS };
  };

  for (const entry of paths) {
    fillPath(mask, W, H, flatten(entry.d).map((poly) => poly.map(toDevice(entry.matrix))));
  }

  // Box-downsample the supersamples into 0-255 coverage.
  const alpha = new Uint8Array(width * height);
  const total = SS * SS;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        const row = (y * SS + sy) * W + x * SS;
        for (let sx = 0; sx < SS; sx++) hits += mask[row + sx];
      }
      alpha[y * width + x] = Math.round((hits / total) * 255);
    }
  }

  return { alpha, box: { x: offX, y: offY, w: drawW, h: drawH } };
}

module.exports = { rasterize, parseSvg, flatten, parseTransform, compose };
