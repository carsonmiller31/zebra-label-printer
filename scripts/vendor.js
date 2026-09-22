'use strict';
/*
 * Copies the third-party browser files the Invoices page needs out of
 * node_modules and into public/, where the label server can serve them.
 *
 * Why copy rather than serve straight from node_modules the way /vendor/bwip-js.js
 * does: `firebase` is a 150 MB package (every product, every build target) and
 * electron-builder packages production dependencies wholesale. Three files out
 * of it are ~700 KB; the whole package would be most of the installer. So
 * firebase and @fontsource are devDependencies, the handful of files we
 * actually ship are copied here, and the copies are committed.
 *
 * Run `npm run vendor` after bumping either package, and commit what changes.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const req = (p) => path.join(ROOT, 'node_modules', p);

/* The Firebase compat bundles: plain <script> files that hang a `firebase`
   global off window, so the page needs no bundler. The modular SDK is ESM with
   bare specifiers and would. */
const FIREBASE = ['firebase-app-compat.js', 'firebase-auth-compat.js', 'firebase-firestore-compat.js'];

/* The invoice's two faces, latin subset. Only the weights the sheet uses.
   These are inlined into the print document as data URIs (see sheet.js), so a
   printed invoice can't come out in a fallback face because a font was still
   loading when the job was handed over. */
const FONTS = [
  ['@fontsource/nunito/files/nunito-latin-{w}-normal.woff2', ['700', '800', '900']],
  ['@fontsource/nunito-sans/files/nunito-sans-latin-{w}-normal.woff2', ['400', '600', '700']],
];

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log(`${path.relative(ROOT, to)}  (${(fs.statSync(to).size / 1024).toFixed(0)} KB)`);
}

for (const file of FIREBASE) {
  copy(req(path.join('firebase', file)), path.join(ROOT, 'public', 'vendor', file));
}

for (const [pattern, weights] of FONTS) {
  for (const w of weights) {
    const rel = pattern.replace('{w}', w);
    copy(req(rel), path.join(ROOT, 'public', 'invoices', 'fonts', path.basename(rel)));
  }
}
