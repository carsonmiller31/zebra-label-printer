'use strict';

// Generates build/icon.png (512x512, RGBA) with no third-party dependencies.
// electron-builder auto-converts this PNG into a multi-resolution .ico for the
// Windows installer and app.
//
// The icon is the pharmacy's own mark — the mortar and pestle in public/logo.svg,
// the same file the name tags print and the app header shows. It is rasterized
// here at build time by scripts/svgraster.js rather than checked in as a PNG, so
// replacing the logo is replacing one SVG.
//
// Design notes, both of which are about the artwork rather than taste:
//
//   * The tile is CREAM, not white and not dark. The mark's swirls are cut out
//     of the shape as negative space, so whatever is behind it becomes part of
//     the drawing — on a dark tile the mark collapses into a maroon blob. Cream
//     rather than pure white so the icon still reads as a tile against the white
//     of Explorer and the installer.
//   * The mark is inset well away from the corners. Windows renders this at
//     16px in the taskbar and title bar, where the fine swirls disappear
//     entirely and all that survives is the silhouette; crowding the edges would
//     turn that silhouette into a smudge.

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { rasterize } = require('./svgraster.js');

const SIZE = 512;
const RADIUS = 96;
const PADDING = 62; // space between the tile edge and the mark's bounding box

const TILE = [251, 247, 239, 255];  // cream (#fbf7ef) — the invoice paper's stock
const MARK = [119, 25, 51, 255];    // the pharmacy maroon (#771933)
const EDGE = [232, 223, 206, 255];  // a hairline so the tile reads on white

// RGBA pixel buffer.
const px = Buffer.alloc(SIZE * SIZE * 4);

function set(x, y, [r, g, b, a]) {
  const i = (y * SIZE + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}

/** Coverage of the rounded tile at (x,y), 0..1, softened at the corners. */
function tileCoverage(x, y) {
  const rx = Math.min(x + 0.5, SIZE - 0.5 - x);
  const ry = Math.min(y + 0.5, SIZE - 0.5 - y);
  if (rx >= RADIUS || ry >= RADIUS) return 1;
  const dx = RADIUS - rx;
  const dy = RADIUS - ry;
  const d = Math.sqrt(dx * dx + dy * dy);
  // One pixel of feathering, so the corners aren't stair-stepped.
  return Math.min(1, Math.max(0, RADIUS + 0.5 - d));
}

const blend = (under, over, a) => Math.round(under + (over - under) * a);

// 1) The tile: cream inside, transparent outside, with a hairline edge.
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const cov = tileCoverage(x, y);
    if (cov <= 0) { set(x, y, [0, 0, 0, 0]); continue; }
    // The outermost ~1.5px of the tile takes the edge colour.
    const inner = tileCoverage(x, y) === 1 &&
      x > 1.5 && y > 1.5 && x < SIZE - 2.5 && y < SIZE - 2.5 &&
      tileCoverage(x - 2, y) === 1 && tileCoverage(x + 2, y) === 1 &&
      tileCoverage(x, y - 2) === 1 && tileCoverage(x, y + 2) === 1;
    const c = inner ? TILE : EDGE;
    set(x, y, [c[0], c[1], c[2], Math.round(255 * cov)]);
  }
}

// 2) The mark, fitted into the tile less its padding and composited on top.
const svg = fs.readFileSync(path.join(__dirname, '..', 'public', 'logo.svg'), 'utf8');
const inner = SIZE - PADDING * 2;
const { alpha, box } = rasterize(svg, inner, inner);

for (let y = 0; y < inner; y++) {
  for (let x = 0; x < inner; x++) {
    const a = alpha[y * inner + x] / 255;
    if (!a) continue;
    const ox = x + PADDING, oy = y + PADDING;
    const i = (oy * SIZE + ox) * 4;
    px[i] = blend(px[i], MARK[0], a);
    px[i + 1] = blend(px[i + 1], MARK[1], a);
    px[i + 2] = blend(px[i + 2], MARK[2], a);
    px[i + 3] = Math.max(px[i + 3], Math.round(255 * a));
  }
}

// ---- Minimal PNG encoder (RGBA, no filtering) ----
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Prepend the per-scanline filter byte (0 = none).
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // color type: RGBA
ihdr[10] = 0;  // compression
ihdr[11] = 0;  // filter
ihdr[12] = 0;  // interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'icon.png');
fs.writeFileSync(outPath, png);
console.log(
  `Wrote ${outPath} (${png.length} bytes, ${SIZE}x${SIZE}) — mark at ` +
  `${Math.round(box.w)}x${Math.round(box.h)} inset ${PADDING}px`,
);
