'use strict';
/*
 * The invoice's two faces, inlined into the print document.
 *
 * The printed sheet goes to Chromium as a `data:` URL (electron/main.js), and
 * a data: document has an opaque origin — a webfont fetched from the local
 * label server would be a cross-origin font load and would be refused. Even
 * served with CORS it would be a race: the print job is handed over on the
 * load event, and a font still in flight would silently print the slip in a
 * fallback face.
 *
 * So the faces are read once, base64'd, and carried inside the document
 * itself. ~90 KB of woff2, which is nothing next to being sure that an invoice
 * printed here is the same document as one printed from the manual.
 *
 * The files come from @fontsource via `npm run vendor`; see scripts/vendor.js.
 */
var InvoiceFonts = (function () {
  const FACES = [
    ['Nunito', 700, 'nunito-latin-700-normal.woff2'],
    ['Nunito', 800, 'nunito-latin-800-normal.woff2'],
    ['Nunito', 900, 'nunito-latin-900-normal.woff2'],
    ['Nunito Sans', 400, 'nunito-sans-latin-400-normal.woff2'],
    ['Nunito Sans', 600, 'nunito-sans-latin-600-normal.woff2'],
    ['Nunito Sans', 700, 'nunito-sans-latin-700-normal.woff2'],
  ];

  let ready = null;

  async function asDataUri(file) {
    const res = await fetch(`/invoices/fonts/${file}`);
    if (!res.ok) throw new Error(`${file}: ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    // String.fromCharCode(...buf) overflows the argument list on a 16 KB font.
    for (let i = 0; i < buf.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    }
    return `data:font/woff2;base64,${btoa(bin)}`;
  }

  /**
   * The @font-face block for the print document. Cached after the first call,
   * and resolves to "" if the files can't be read — a slip in the fallback
   * face still beats no slip at all, so this never blocks a print.
   */
  function css() {
    if (!ready) {
      ready = Promise.all(FACES.map(async ([family, weight, file]) =>
        `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};` +
        `font-display:block;src:url(${await asDataUri(file)}) format("woff2");}`))
        .then((parts) => parts.join(''))
        .catch(() => '');
    }
    return ready;
  }

  /* Warm the cache while the shop is quiet, so the first Save & Print isn't
     the thing that waits on six font files. */
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => css());
  else setTimeout(() => css(), 2000);

  return { css };
})();
