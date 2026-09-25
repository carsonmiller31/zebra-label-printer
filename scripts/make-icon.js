'use strict';

// Generates the app icon with no third-party dependencies:
//
//   build/icon.ico — Windows: the exe, installer, shortcuts, taskbar, title bar
//   build/icon.png — 512x512, the window icon on other platforms
//
// WHY THE .ICO IS BUILT HERE. Handed a PNG, electron-builder writes an .ico
// holding ONE 256x256 image, and Windows shrinks that on the fly to 16/24/32/48
// for the title bar, taskbar and desktop with a cheap filter. That was the
// pixelated, stringy icon: the logo's hairline swirls, resampled by Windows,
// broke into threads. Every size in this .ico is instead rendered directly from
// vectors at its own pixel size.
//
// TWO DRAWINGS, ONE MARK.
//   * 64 px and up: the pharmacy's own logo, public/logo.svg — the same file the
//     name tags print and the app header shows — in cream on the maroon tile.
//   * 48 px and down: scripts/icon-glyph.js, a hand-simplified mortar and pestle
//     in the same proportions. The logo's swirls are sub-pixel at these sizes
//     and no amount of anti-aliasing makes them read.
//
// THE TILE IS MAROON with the mark knocked out in cream. The mark's swirls are
// negative space, so the background is part of the drawing; cream-on-maroon
// keeps them, and a solid maroon tile holds up on both a light and a dark
// taskbar, where the old cream tile faded into light mode.
//
// This runs first in the CI release build on a Windows runner, which is why it
// hand-rolls its PNG/ICO encoding and uses scripts/svgraster.js rather than a
// native image library — that is the kind of dependency that breaks a release.

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { rasterize } = require('./svgraster.js');
const { glyphLayers, layerSvg } = require('./icon-glyph.js');

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const PNG_SIZE = 512;
const GLYPH_MAX = 48;      // sizes at or below this use the simplified glyph

const TILE_TOP = [140, 36, 66];     // the pharmacy maroon (#771933), lit from above…
const TILE_BOTTOM = [104, 20, 44];  // …and a shade deeper at the foot
const MARK = [251, 247, 239];       // cream (#fbf7ef) — the invoice paper's stock
const RADIUS = 0.19;                // corner radius, as a fraction of the size
const LOGO_PAD = 0.1;               // logo inset from the tile edge, same

const logoSvg = fs.readFileSync(path.join(__dirname, '..', 'public', 'logo.svg'), 'utf8');

/** Straight (non-premultiplied) RGBA floats, 0..255 colour and 0..1 alpha. */
function renderIcon(S) {
  const px = new Float32Array(S * S * 4);
  const r = RADIUS * S;

  // 1) The tile: a rounded square with a gentle vertical gradient, its corners
  //    anti-aliased by 4x4 supersampling.
  for (let y = 0; y < S; y++) {
    const t = (y + 0.5) / S;
    const col = TILE_TOP.map((c, k) => c + (TILE_BOTTOM[k] - c) * t);
    for (let x = 0; x < S; x++) {
      let cov = 0;
      for (let a = 0; a < 4; a++) {
        for (let b = 0; b < 4; b++) {
          const X = x + (a + 0.5) / 4, Y = y + (b + 0.5) / 4;
          const rx = Math.min(X, S - X), ry = Math.min(Y, S - Y);
          if (rx >= r || ry >= r || Math.hypot(r - rx, r - ry) <= r) cov++;
        }
      }
      const i = (y * S + x) * 4;
      px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2]; px[i + 3] = cov / 16;
    }
  }

  // 2) The mark, painted over the tile. Only the tile's colour matters where a
  //    'bg' layer knocks out — the tile's alpha is never reduced.
  const paint = (alpha, n, ox, oy, colourAt) => {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const a = alpha[y * n + x] / 255;
        if (!a) continue;
        const i = ((y + oy) * S + (x + ox)) * 4;
        const c = colourAt(y + oy);
        for (let k = 0; k < 3; k++) px[i + k] += (c[k] - px[i + k]) * a;
      }
    }
  };
  const tileAt = (y) => {
    const t = (y + 0.5) / S;
    return TILE_TOP.map((c, k) => c + (TILE_BOTTOM[k] - c) * t);
  };

  if (S <= GLYPH_MAX) {
    const ss = Math.max(8, Math.ceil(256 / S)); // plenty of samples per pixel
    for (const layer of glyphLayers(S)) {
      const { alpha } = rasterize(layerSvg(layer.d), S, S, { supersample: ss });
      paint(alpha, S, 0, 0, layer.ink === 'fg' ? () => MARK : tileAt);
    }
  } else {
    const pad = Math.round(LOGO_PAD * S), n = S - pad * 2;
    const { alpha } = rasterize(logoSvg, n, n, { supersample: S >= 256 ? 4 : 8 });
    paint(alpha, n, pad, pad, () => MARK);
  }
  return px;
}

/** Float RGBA → 8-bit RGBA. */
function toBytes(px) {
  const out = Buffer.alloc(px.length);
  for (let i = 0; i < px.length; i += 4) {
    out[i] = Math.round(px[i]);
    out[i + 1] = Math.round(px[i + 1]);
    out[i + 2] = Math.round(px[i + 2]);
    out[i + 3] = Math.round(px[i + 3] * 255);
  }
  return out;
}

// ---- Minimal PNG encoder (RGBA, no filtering) ----

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

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, S) {
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- ICO encoder ----
// Sizes under 256 are stored as classic 32-bit BMPs (bottom-up BGRA plus an
// all-zero AND mask), the form every part of Windows reads; 256 is stored as a
// PNG, which is what Windows expects at that size and keeps the file small.

function encodeBmpEntry(rgba, S) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);        // header size
  header.writeInt32LE(S, 4);          // width
  header.writeInt32LE(S * 2, 8);      // height: XOR image + AND mask
  header.writeUInt16LE(1, 12);        // planes
  header.writeUInt16LE(32, 14);       // bits per pixel
  const xor = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const src = (y * S + x) * 4, dst = ((S - 1 - y) * S + x) * 4;
      xor[dst] = rgba[src + 2];
      xor[dst + 1] = rgba[src + 1];
      xor[dst + 2] = rgba[src];
      xor[dst + 3] = rgba[src + 3];
    }
  }
  const maskRow = Math.ceil(S / 32) * 4;
  return Buffer.concat([header, xor, Buffer.alloc(maskRow * S)]);
}

function encodeIco(images) {
  const dir = Buffer.alloc(6 + images.length * 16);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);            // type: icon
  dir.writeUInt16LE(images.length, 4);
  let offset = dir.length;
  images.forEach(({ size, data }, k) => {
    const e = 6 + k * 16;
    dir[e] = size >= 256 ? 0 : size;  // 0 means 256
    dir[e + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, e + 4);      // planes
    dir.writeUInt16LE(32, e + 6);     // bits per pixel
    dir.writeUInt32LE(data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([dir, ...images.map((i) => i.data)]);
}

// ---- Build ----

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });

const ico = encodeIco(ICO_SIZES.map((size) => {
  const rgba = toBytes(renderIcon(size));
  return { size, data: size >= 256 ? encodePng(rgba, size) : encodeBmpEntry(rgba, size) };
}));
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);

const png = encodePng(toBytes(renderIcon(PNG_SIZE)), PNG_SIZE);
fs.writeFileSync(path.join(outDir, 'icon.png'), png);

console.log(
  `Wrote build/icon.ico (${ICO_SIZES.join(', ')} px; ${ico.length} bytes) ` +
  `and build/icon.png (${PNG_SIZE}px; ${png.length} bytes)`,
);
