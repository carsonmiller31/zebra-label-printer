'use strict';
/*
 * The printed call-in form.
 *
 * This module owns everything about the piece of paper: it turns the fields on
 * the tab into one self-contained HTML document, styled for a US Letter sheet.
 * The same document is what the preview shows and what goes to the printer, so
 * the preview is not an approximation of the printout — it is the printout.
 *
 * The form is 8.5" x 5.5": the top half of the sheet. The bottom half is left
 * blank (a dashed line marks the fold so the slip can be torn off). Copies are
 * repeated as extra pages rather than asking the printer for copies, so the
 * browser fall-back and the Electron path behave identically.
 *
 * Nothing here is stored anywhere. See paper/ui.js — patient details are never
 * written to localStorage.
 */
var CallInForm = (function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  /* Letter paper, in real inches; type in points so it keeps its size whatever
     the page scale.

     One family throughout — the system UI face (Segoe UI on the pharmacy PCs,
     -apple-system here) — because a form built from one clean grotesque reads
     as a document rather than a template. The hierarchy is carried by weight,
     size and letterspacing instead of by mixing faces: hairline-ruled fields,
     small letterspaced caps for the labels, and tabular figures so every
     number, date and phone column lines up. */
  const CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; color: #000; }
body {
  font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue",
               Helvetica, Arial, sans-serif;
  font-variant-numeric: tabular-nums lining-nums;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
  text-rendering: geometricPrecision;
}
@page { size: 8.5in 11in; margin: 0; }

/* One slip = the top half of a sheet. Copies break onto further pages. */
.sheet {
  position: relative; overflow: hidden;
  width: 8.5in; height: 5.5in;
  padding: 0.4in 0.5in 0.18in;
  display: flex; flex-direction: column;
  page-break-after: always; break-after: page;
}
.sheet:last-child { page-break-after: auto; break-after: auto; }

.hd { display: flex; align-items: flex-end; justify-content: space-between; gap: 0.3in; }
.hd h1 {
  margin: 0; font-size: 13.5pt; font-weight: 600;
  letter-spacing: 0.185em; text-transform: uppercase; line-height: 1.05;
}
.hd .org {
  margin: 4pt 0 0; font-size: 7pt; font-weight: 500; letter-spacing: 0.2em;
  text-transform: uppercase; color: #5a5a5a;
}
.hd .when { flex: none; text-align: right; }
.hd .when .k {
  font-size: 6.2pt; font-weight: 600; letter-spacing: 0.18em;
  text-transform: uppercase; color: #5a5a5a;
}
.hd .when .t { font-size: 10.5pt; font-weight: 600; line-height: 1.3; white-space: nowrap; }

.rule { border-top: 1.75pt solid #000; margin-top: 6pt; }

.body {
  flex: 1; display: flex; flex-direction: column;
  justify-content: space-between; gap: 9pt; padding-top: 12pt;
}
.r { display: flex; gap: 0.32in; }
.f { flex: 1; min-width: 0; }
.f .k {
  font-size: 6.2pt; font-weight: 600; letter-spacing: 0.17em;
  text-transform: uppercase; color: #5a5a5a;
  margin-bottom: 3pt; white-space: nowrap;
}
.f .k em { font-style: normal; font-weight: 400; color: #8a8a8a; letter-spacing: 0.1em; }
.f .v {
  font-size: 11.5pt; font-weight: 400; line-height: 1.3;
  min-height: 18pt; padding-bottom: 3pt;
  border-bottom: 0.6pt solid #222;
  white-space: pre-wrap; word-break: break-word;
}
.f.lead .v { font-size: 13pt; font-weight: 500; min-height: 20pt; }
.f.tall .v { min-height: 34pt; }
/* Numbers read as data, not prose: a touch of tracking, nothing more. */
.f .v.mono { letter-spacing: 0.06em; }

.ft {
  display: flex; align-items: flex-end; justify-content: space-between; gap: 0.3in;
  border-top: 0.6pt solid #222; padding-top: 8pt; margin-top: 10pt;
}
.ini { display: flex; align-items: center; gap: 9pt; }
.ini .k {
  font-size: 6.2pt; font-weight: 600; letter-spacing: 0.17em;
  text-transform: uppercase; color: #5a5a5a;
}
.ini .box {
  min-width: 0.62in; height: 0.3in; padding: 0 6pt;
  border: 0.75pt solid #000;
  display: flex; align-items: center; justify-content: center;
  font-size: 13pt; font-weight: 600; line-height: 1; letter-spacing: 0.12em;
}
.ft .cap {
  font-size: 6.2pt; font-weight: 500; letter-spacing: 0.17em;
  text-transform: uppercase; color: #8a8a8a; text-align: right; padding-bottom: 2pt;
}

.cut { position: absolute; left: 0; right: 0; bottom: 0; border-top: 0.5pt dashed #9a9a9a; }
`;

  /** "Sep 22, 2026" / "2:14 PM" — the moment the call was written down. */
  function stamp(date) {
    const d = date instanceof Date ? date : new Date();
    return {
      date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      time: d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
    };
  }

  /** One labelled line. An empty value leaves a ruled blank to write on. */
  function field(label, value, { cls = '', note = '', mono = false } = {}) {
    const k = esc(label) + (note ? ` <em>${esc(note)}</em>` : '');
    return `<div class="f ${cls}"><div class="k">${k}</div>` +
           `<div class="v${mono ? ' mono' : ''}">${esc(value) || '&nbsp;'}</div></div>`;
  }

  /** The slip itself. `d` is the plain form data; `at` is the Date it was taken. */
  function sheet(d, { at, cutLine = true } = {}) {
    const t = stamp(at);
    const org = (d.org || '').trim();

    return `<div class="sheet">
  <div class="hd">
    <div>
      <h1>Telephone Prescription</h1>
      <div class="org">${org ? esc(org) + ' &middot; ' : ''}Call-in record</div>
    </div>
    <div class="when">
      <div class="k">Received</div>
      <div class="t">${esc(t.date)}</div>
      <div class="t">${esc(t.time)}</div>
    </div>
  </div>
  <div class="rule"></div>

  <div class="body">
    <div class="r">
      <div style="flex:2;">${field('Patient', d.patient, { cls: 'lead' })}</div>
      <div style="flex:1;">${field('Date of birth', d.dob, { mono: true })}</div>
    </div>

    <div class="r">
      <div style="flex:3;">${field('Drug, strength & form', d.drug, { cls: 'lead' })}</div>
      <div style="flex:1;">${field('Quantity', d.qty)}</div>
      <div style="flex:1;">${field('Refills', d.refills)}</div>
    </div>

    <div class="r">
      <div style="flex:1;">${field('Directions', d.sig, { cls: 'tall', note: '— sig' })}</div>
    </div>

    <div class="r">
      <div style="flex:2;">${field('Prescriber', d.prescriber)}</div>
      <div style="flex:1;">${field('NPI / DEA', d.npi, { mono: true })}</div>
    </div>

    <div class="r">
      <div style="flex:2;">${field('Called in by', d.caller, { note: '— name & office' })}</div>
      <div style="flex:1;">${field('Call-back phone', d.phone, { mono: true })}</div>
    </div>
  </div>

  <div class="ft">
    <div class="ini">
      <div class="k">Taken by</div>
      <div class="box">${esc((d.initials || '').toUpperCase()) || '&nbsp;'}</div>
    </div>
    <div class="cap">Verbal prescription received by telephone</div>
  </div>
  ${cutLine ? '<div class="cut"></div>' : ''}
</div>`;
  }

  function wrap(title, inner) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
           `<title>${esc(title)}</title><style>${CSS}</style></head>` +
           `<body>${inner}</body></html>`;
  }

  /** The full document to send to the printer: one page per copy. */
  function doc(d, { at = new Date(), copies = 1, cutLine = true } = {}) {
    const n = Math.max(1, Math.min(20, Math.floor(copies) || 1));
    const pages = [];
    for (let i = 0; i < n; i++) pages.push(sheet(d, { at, cutLine }));
    const who = (d.patient || '').trim();
    return wrap(who ? `Call-in — ${who}` : 'Call-in prescription', pages.join('\n'));
  }

  /** The same slip, for the on-screen preview iframe. */
  function previewDoc(d, opts) {
    return wrap('Preview', sheet(d, opts));
  }

  return { doc, previewDoc, sheet, stamp };
})();
