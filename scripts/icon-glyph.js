'use strict';
/*
 * The small-size app icon: a simplified mortar and pestle drawn for 16–48 px.
 *
 * Why the logo isn't used at these sizes. public/logo.svg is a traced drawing
 * whose swirls are hairlines a few hundredths of the mark wide. At 24–32 px
 * (the Windows taskbar) they come out as sub-pixel threads — faint, broken,
 * "stringy" — however well they are anti-aliased, and at 16 px (title bar) the
 * whole mark smears. Every serious icon set hand-draws its small sizes; this is
 * that, kept in the logo's proportions: a wide bowl on a short foot, the pestle
 * leaning out to the upper right, one swirl across the bowl's flank.
 *
 * Geometry is on a 32-unit grid covering the whole tile. It is expressed as
 * painter's-order layers — `fg` (the mark colour) and `bg` (the tile colour,
 * i.e. knock-outs) — because the rasterizer fills single-colour paths and the
 * pestle has to sit in front of the back rim but behind the front wall.
 */

const K = 0.5523; // cubic Bézier circle constant

const f = (v) => +v.toFixed(3);

/** A full ellipse as four cubics. */
function ellipse(cx, cy, rx, ry) {
  const kx = rx * K, ky = ry * K;
  return `M${f(cx + rx)},${f(cy)} ` +
    `C${f(cx + rx)},${f(cy + ky)} ${f(cx + kx)},${f(cy + ry)} ${f(cx)},${f(cy + ry)} ` +
    `C${f(cx - kx)},${f(cy + ry)} ${f(cx - rx)},${f(cy + ky)} ${f(cx - rx)},${f(cy)} ` +
    `C${f(cx - rx)},${f(cy - ky)} ${f(cx - kx)},${f(cy - ry)} ${f(cx)},${f(cy - ry)} ` +
    `C${f(cx + kx)},${f(cy - ry)} ${f(cx + rx)},${f(cy - ky)} ${f(cx + rx)},${f(cy)} Z`;
}

/**
 * The pestle: a club — a narrow round foot flaring to a round head — built as
 * the two end circles plus the quad along their outer tangents. `grow` fattens
 * it uniformly, which is how the knock-out halo around it is made.
 */
function pestle(foot, footR, head, headR, grow = 0) {
  const r0 = footR + grow, r1 = headR + grow;
  const L = Math.hypot(head[0] - foot[0], head[1] - foot[1]);
  const d = [(head[0] - foot[0]) / L, (head[1] - foot[1]) / L];
  const n = [-d[1], d[0]];
  const s = (r1 - r0) / L, c = Math.sqrt(1 - s * s);
  const side = (sg) => [-d[0] * s + sg * n[0] * c, -d[1] * s + sg * n[1] * c];
  const at = (C, r, w) => `${f(C[0] + w[0] * r)},${f(C[1] + w[1] * r)}`;
  const u = side(1), v = side(-1);
  return `M${at(foot, r0, u)} L${at(head, r1, u)} L${at(head, r1, v)} L${at(foot, r0, v)} Z ` +
    ellipse(head[0], head[1], r1, r1) + ' ' + ellipse(foot[0], foot[1], r0, r0);
}

/**
 * A tapered band along a cubic curve, thickest just past the middle and coming
 * to a point at both ends — the one swirl kept from the logo.
 */
function swirl(a, b, c, d, width) {
  const N = 32, pts = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, m = 1 - t;
    pts.push([
      m * m * m * a[0] + 3 * m * m * t * b[0] + 3 * m * t * t * c[0] + t * t * t * d[0],
      m * m * m * a[1] + 3 * m * m * t * b[1] + 3 * m * t * t * c[1] + t * t * t * d[1],
    ]);
  }
  const left = [], right = [];
  pts.forEach((p, i) => {
    const q0 = pts[Math.max(0, i - 1)], q1 = pts[Math.min(N, i + 1)];
    const len = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]);
    const tx = (q1[0] - q0[0]) / len, ty = (q1[1] - q0[1]) / len;
    const h = (width / 2) * Math.sin(Math.PI * Math.pow(i / N, 0.8));
    left.push([p[0] - ty * h, p[1] + tx * h]);
    right.push([p[0] + ty * h, p[1] - tx * h]);
  });
  const pt = (p) => `${f(p[0])},${f(p[1])}`;
  return 'M' + left.map(pt).join(' L') + ' L' + right.reverse().map(pt).join(' L') + ' Z';
}

/**
 * The glyph for a given pixel size, as [{ ink: 'fg'|'bg', d }] in paint order.
 * The swirl is dropped below 24 px, where it would be under a pixel wide.
 */
function glyphLayers(size) {
  const cx = 15.5, cy = 15;   // centre of the bowl's opening
  const rx = 11, ry = 3;      // the opening
  const lip = 1.5;            // rim thickness
  const bottom = 25.5;        // underside of the bowl
  const orx = rx + lip, ory = ry + lip * 0.9;
  const kx = orx * K, ky = ory * K, ix = rx * K, iy = ry * K;
  const drop = (bottom - cy) * 0.75;

  // Bowl sides, from the rim's right end round the bottom to its left end.
  const sides =
    `C${f(cx + orx)},${f(cy + drop)} ${f(cx + orx * 0.55)},${f(bottom)} ${f(cx)},${f(bottom)} ` +
    `C${f(cx - orx * 0.55)},${f(bottom)} ${f(cx - orx)},${f(cy + drop)} ${f(cx - orx)},${f(cy)} Z`;

  // The whole silhouette: back rim over the top, then the bowl.
  const body =
    `M${f(cx - orx)},${f(cy)} ` +
    `C${f(cx - orx)},${f(cy - ky)} ${f(cx - kx)},${f(cy - ory)} ${f(cx)},${f(cy - ory)} ` +
    `C${f(cx + kx)},${f(cy - ory)} ${f(cx + orx)},${f(cy - ky)} ${f(cx + orx)},${f(cy)} ` + sides;

  // The front wall: under the near half of the opening. Painted after the
  // pestle so the pestle's foot disappears into the bowl.
  const front =
    `M${f(cx - rx)},${f(cy)} ` +
    `C${f(cx - rx)},${f(cy + iy)} ${f(cx - ix)},${f(cy + ry)} ${f(cx)},${f(cy + ry)} ` +
    `C${f(cx + ix)},${f(cy + ry)} ${f(cx + rx)},${f(cy + iy)} ${f(cx + rx)},${f(cy)} ` +
    `L${f(cx + orx)},${f(cy)} ` + sides;

  const foot = [15, 15.5], head = [23.8, 6], footR = 1.35, headR = 2.6;

  // The mortar's pedestal, a short trapezoid with a gap under the bowl.
  const fy = bottom + 1, fh = 2, fw = 5, spread = 0.8;
  const base = `M${f(cx - fw)},${f(fy)} L${f(cx + fw)},${f(fy)} ` +
    `L${f(cx + fw + spread)},${f(fy + fh)} L${f(cx - fw - spread)},${f(fy + fh)} Z`;

  const layers = [
    { ink: 'fg', d: body },
    { ink: 'bg', d: ellipse(cx, cy, rx, ry) },                      // the opening
    { ink: 'bg', d: pestle(foot, footR, head, headR, 0.9) },        // halo
    { ink: 'fg', d: pestle(foot, footR, head, headR) },
    { ink: 'fg', d: front },
  ];
  if (size >= 24) {
    layers.push({ ink: 'bg', d: swirl([2.6, 17.4], [5, 21.5], [9, 23.6], [14.5, 24.2], 1.25) });
  }
  layers.push({ ink: 'fg', d: base });
  return layers;
}

/** One layer as a standalone SVG the rasterizer can take. */
const layerSvg = (d) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="${d}"/></svg>`;

module.exports = { glyphLayers, layerSvg };
