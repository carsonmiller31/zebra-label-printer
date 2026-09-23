'use strict';
/*
 * The pharmacy mark, turned into printer dots.
 *
 * The printer has no notion of an SVG: it takes a bitmap. So the mark is drawn
 * into a canvas at exactly the size it will be printed, and every pixel that is
 * at least half covered becomes one black dot. Those same dots are handed back
 * as a PNG for the on-screen preview, so the preview isn't an approximation of
 * the printout — it is the printout.
 *
 * Swap public/logo.svg to change the mark. Crop the file to the artwork (no
 * surrounding padding); the layout positions it by its own edges, and
 * scripts/make-icon.js centres the app icon on the same bounds.
 */
var NameTagLogo = (function () {
  /* One file, three places: this tag, the header of the app, and the Windows
     app icon (scripts/make-icon.js rasterizes it at build time). */
  const SRC = '/logo.svg';
  const INK = 128;      // alpha (0-255) at which a pixel becomes a dot
  const CACHE_MAX = 8;  // a handful of sizes: one per stock/tag/dpi combination

  let loading = null;
  const cache = new Map();

  /** Load the mark once, as an <img> we can draw at any size. */
  function load() {
    if (loading) return loading;
    loading = (async () => {
      const res = await fetch(SRC);
      if (!res.ok) throw new Error(`logo.svg: HTTP ${res.status}`);
      const url = URL.createObjectURL(new Blob([await res.text()], { type: 'image/svg+xml' }));
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const w = img.naturalWidth || 1;
        const h = img.naturalHeight || 1;
        // Keep the object URL alive: revoking it can blank the image on later
        // draws in some Chromium builds.
        return { img, aspect: w / h };
      } catch (e) {
        URL.revokeObjectURL(url);
        throw e;
      }
    })();
    loading = loading.catch((e) => { loading = null; throw e; });
    return loading;
  }

  /**
   * The mark, as large as it can be inside `maxW` x `maxH` dots.
   * → { w, h, rows (boolean[][]), png (data URL) }
   */
  async function bitmap(maxW, maxH) {
    const { img, aspect } = await load();
    let h = Math.max(8, Math.round(maxH));
    let w = Math.max(8, Math.round(h * aspect));
    if (w > maxW) {
      w = Math.max(8, Math.round(maxW));
      h = Math.max(8, Math.round(w / aspect));
    }
    const key = `${w}x${h}`;
    const hit = cache.get(key);
    if (hit) return hit;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    const data = ctx.getImageData(0, 0, w, h);
    const px = data.data;
    const rows = [];
    for (let y = 0; y < h; y++) {
      const row = new Array(w);
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const on = px[i + 3] >= INK;
        row[x] = on;
        // Repaint as the 1-bit image: solid black dots, everything else clear.
        px[i] = px[i + 1] = px[i + 2] = 0;
        px[i + 3] = on ? 255 : 0;
      }
      rows.push(row);
    }
    ctx.putImageData(data, 0, 0);

    const out = { w, h, rows, png: canvas.toDataURL('image/png') };
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, out);
    return out;
  }

  return { bitmap };
})();
