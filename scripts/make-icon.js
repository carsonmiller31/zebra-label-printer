'use strict';

// Generates build/icon.png (512x512, RGBA) with no third-party dependencies.
// electron-builder auto-converts this PNG into a multi-resolution .ico for the
// Windows installer and app. Design: a dark rounded tile with a barcode motif
// and a teal baseline — matches the app's dark UI.

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const SIZE = 512;
const RADIUS = 96;

const BG = [15, 17, 21, 255];       // #0f1115
const BAR = [237, 240, 245, 255];   // near-white barcode bars
const ACCENT = [45, 212, 191, 255]; // teal baseline (#2dd4bf)

// RGBA pixel buffer.
const px = Buffer.alloc(SIZE * SIZE * 4);

function set(x, y, [r, g, b, a]) {
  const i = (y * SIZE + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}

// Rounded-rectangle mask: is (x,y) inside the tile?
function inside(x, y) {
  const rx = Math.min(x, SIZE - 1 - x);
  const ry = Math.min(y, SIZE - 1 - y);
  if (rx >= RADIUS || ry >= RADIUS) return true;
  const dx = RADIUS - rx;
  const dy = RADIUS - ry;
  return dx * dx + dy * dy <= RADIUS * RADIUS;
}

// 1) Fill: rounded tile in BG, transparent outside.
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    set(x, y, inside(x, y) ? BG : [0, 0, 0, 0]);
  }
}

// 2) Barcode: variable-width vertical bars filling the middle band edge to edge.
const widths = [6, 3, 10, 4, 7, 3, 5, 12, 4, 6, 3, 8, 5, 4, 10, 3, 7, 4, 6, 3, 9, 5];
const barTop = 150;
const barBottom = 344;
const barLeft = 108;
const barRight = SIZE - 108; // 404
let x = barLeft;
let draw = true;
let i = 0;
while (x < barRight) {
  const w = widths[i % widths.length];
  if (draw) {
    for (let bx = x; bx < x + w && bx < barRight; bx++) {
      for (let by = barTop; by <= barBottom; by++) {
        if (inside(bx, by)) set(bx, by, BAR);
      }
    }
  }
  x += w;
  draw = !draw;
  i++;
}

// 3) Teal baseline under the barcode.
for (let by = 372; by <= 392; by++) {
  for (let bx = 108; bx <= SIZE - 108; bx++) {
    if (inside(bx, by)) set(bx, by, ACCENT);
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
console.log(`Wrote ${outPath} (${png.length} bytes, ${SIZE}x${SIZE})`);
