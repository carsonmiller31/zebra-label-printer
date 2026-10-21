'use strict';
/*
 * The printed phone-script forms: a call-in from a prescriber's office, and a
 * transfer in from another pharmacy. `d.kind` picks which ('transfer', or the
 * call-in by default).
 *
 * This module owns everything about the piece of paper: it turns the fields on
 * the tab into one self-contained HTML document, styled for a US Letter sheet.
 * The same document is what the preview shows and what goes to the printer, so
 * the preview is not an approximation of the printout — it is the printout.
 *
 * A slip is 8.5" x 5.5": half a Letter sheet. A call-in prints one slip per
 * medication, because each one becomes its own prescription with its own Rx
 * number (and a controlled one is filed apart from the rest). Slips go two to
 * a sheet, top half first, with a dashed line across the fold so they can be
 * cut apart; a call with one drug leaves the bottom half blank. Copies repeat
 * the whole set rather than asking the printer for copies, so the browser
 * fall-back and the Electron path behave identically.
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

/* A Letter page holds two slips, top half first. */
.page {
  width: 8.5in; height: 11in; overflow: hidden;
  page-break-after: always; break-after: page;
}
.page:last-child { page-break-after: auto; break-after: auto; }
.sheet {
  position: relative; overflow: hidden;
  width: 8.5in; height: 5.5in;
  padding: 0.4in 0.5in 0.18in;
  display: flex; flex-direction: column;
}

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
/* "Rx 2 of 3": which of the call's prescriptions this slip is. */
.hd .of {
  display: inline-block; margin-left: 8pt; padding: 1.5pt 5pt 1pt;
  border: 0.75pt solid #000; border-radius: 2pt;
  font-size: 7pt; font-weight: 600; letter-spacing: 0.14em; color: #000;
  vertical-align: 1pt;
}

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
/* The transfer slip carries two more rows in the same half sheet. */
.body.dense { gap: 6pt; padding-top: 9pt; }
.body.dense .f .v { min-height: 16pt; padding-bottom: 2pt; }
.body.dense .f.lead .v { min-height: 18pt; }
.body.dense .f.tall .v { min-height: 26pt; }
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

  const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];

  /** One labelled line. An empty value leaves a ruled blank to write on. */
  function field(label, value, { cls = '', note = '', mono = false } = {}) {
    const k = esc(label) + (note ? ` <em>${esc(note)}</em>` : '');
    return `<div class="f ${cls}"><div class="k">${k}</div>` +
           `<div class="v${mono ? ' mono' : ''}">${esc(value) || '&nbsp;'}</div></div>`;
  }

  /** The top of a slip: its title, the pharmacy, and when it was taken. */
  function head(title, what, d, at, n = 1, of = 1) {
    const t = stamp(at);
    const org = (d.org || '').trim();
    const count = of > 1 ? `<span class="of">RX ${n} OF ${of}</span>` : '';
    return `<div class="hd">
    <div>
      <h1>${esc(title)}</h1>
      <div class="org">${org ? esc(org) + ' &middot; ' : ''}${esc(what)}${count}</div>
    </div>
    <div class="when">
      <div class="k">Received</div>
      <div class="t">${esc(t.date)}</div>
      <div class="t">${esc(t.time)}</div>
    </div>
  </div>
  <div class="rule"></div>`;
  }

  /** The bottom of a slip: the initials box and what the slip is. */
  function foot(who, cap, d, cutLine) {
    return `<div class="ft">
    <div class="ini">
      <div class="k">${esc(who)}</div>
      <div class="box">${esc((d.initials || '').toUpperCase()) || '&nbsp;'}</div>
    </div>
    <div class="cap">${esc(cap)}</div>
  </div>
  ${cutLine ? '<div class="cut"></div>' : ''}`;
  }

  /** The DAW code, with what it means, short enough for its box. */
  const DAW = { 0: '0 · Sub OK', 1: '1 · No sub' };
  const daw = (v) => DAW[v] || v;

  const drugNote = (d) => (d.schedule ? `— Schedule ${ROMAN[d.schedule]}` : '');

  /*
   * The prescriptions on a form, each as the flat data one slip prints. A
   * call-in carries its drugs in `d.meds`, and the patient, prescriber and
   * caller are repeated on every slip. A transfer is always one.
   */
  function slips(d) {
    if (d.kind === 'transfer' || !Array.isArray(d.meds)) return [d];
    const meds = d.meds.length ? d.meds : [{}];
    return meds.map((m) => ({ ...d, ...m }));
  }

  /**
   * One slip. `d` is the plain form data; `at` is the Date it was taken. For a
   * call-in, `index` picks which of its medications.
   */
  function sheet(d, { index = 0, ...opts } = {}) {
    if (d.kind === 'transfer') return transferSheet(d, opts);
    const all = slips(d);
    const i = Math.max(0, Math.min(all.length - 1, index));
    return callInSheet(all[i], { ...opts, n: i + 1, of: all.length });
  }

  function callInSheet(d, { at, cutLine = true, n = 1, of = 1 } = {}) {
    return `<div class="sheet">
  ${head('Telephone Prescription', 'Call-in record', d, at, n, of)}

  <div class="body">
    <div class="r">
      <div style="flex:2;">${field('Patient', d.patient, { cls: 'lead' })}</div>
      <div style="flex:1;">${field('Date of birth', d.dob, { mono: true })}</div>
    </div>

    <div class="r">
      <div style="flex:3;">${field('Drug, strength & form', d.drug, {
        cls: 'lead', note: drugNote(d),
      })}</div>
      <div style="flex:1;">${field('Quantity', d.qty)}</div>
      <div style="flex:1;">${field('Refills', d.refills)}</div>
      <div style="flex:1;">${field('DAW', daw(d.daw))}</div>
    </div>

    <div class="r">
      <div style="flex:1;">${field('Directions', d.sig, { cls: 'tall', note: '— sig' })}</div>
    </div>

    <div class="r">
      <div style="flex:2;">${field('Prescriber', d.prescriber)}</div>
      <div style="flex:1;">${field('NPI', d.npi, { mono: true })}</div>
      <div style="flex:1;">${field('DEA', d.dea, { mono: true })}</div>
    </div>

    <div class="r">
      <div style="flex:2;">${field('Called in by', d.caller, { note: '— name & office' })}</div>
      <div style="flex:1;">${field('Call-back phone', d.phone, { mono: true })}</div>
    </div>
  </div>

  ${foot('Taken by', 'Verbal prescription received by telephone', d, cutLine)}
</div>`;
  }

  /*
   * A prescription transferred in from another pharmacy. Besides the
   * prescription, it records what the federal rule for a controlled transfer
   * (21 CFR 1306.25) asks for — the other pharmacy's name, address and DEA
   * number, its Rx number, the pharmacist who gave it, when it was written and
   * first filled, the last fill and the refills left — so one slip does for
   * every drug.
   */
  function transferSheet(d, { at, cutLine = true } = {}) {
    return `<div class="sheet">
  ${head('Prescription Transfer', 'Transfer-in record', d, at)}

  <div class="body dense">
    <div class="r">
      <div style="flex:2;">${field('Patient', d.patient, { cls: 'lead' })}</div>
      <div style="flex:1;">${field('Date of birth', d.dob, { mono: true })}</div>
    </div>

    <div class="r">
      <div style="flex:3;">${field('Drug, strength & form', d.drug, { cls: 'lead', note: drugNote(d) })}</div>
      <div style="flex:1;">${field('Quantity', d.qty)}</div>
      <div style="flex:1;">${field('Refills left', d.refills)}</div>
    </div>

    <div class="r">
      <div style="flex:1;">${field('Directions', d.sig, { cls: 'tall', note: '— sig' })}</div>
    </div>

    <div class="r">
      <div style="flex:2;">${field('Prescriber', d.prescriber)}</div>
      <div style="flex:1;">${field('NPI', d.npi, { mono: true })}</div>
      <div style="flex:1;">${field('DEA', d.dea, { mono: true })}</div>
    </div>

    <div class="r">
      <div style="flex:1;">${field('Their Rx #', d.rxNum, { mono: true })}</div>
      <div style="flex:1;">${field('Written', d.written, { mono: true })}</div>
      <div style="flex:1;">${field('First filled', d.firstFill, { mono: true })}</div>
      <div style="flex:1;">${field('Last filled', d.lastFill, { mono: true })}</div>
    </div>

    <div class="r">
      <div style="flex:2;">${field('Transferred from', d.pharmacy, { note: '— pharmacy' })}</div>
      <div style="flex:1;">${field('Phone', d.pharmPhone, { mono: true })}</div>
      <div style="flex:1;">${field('Pharmacy DEA', d.pharmDea, { mono: true })}</div>
    </div>

    <div class="r">
      <div style="flex:2;">${field('Pharmacy address', d.pharmAddr)}</div>
      <div style="flex:2;">${field('Transferring pharmacist', d.pharmacist)}</div>
    </div>
  </div>

  ${foot('Received by', 'Prescription transferred in by telephone', d, cutLine)}
</div>`;
  }

  function wrap(title, inner) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
           `<title>${esc(title)}</title><style>${CSS}</style></head>` +
           `<body>${inner}</body></html>`;
  }

  /**
   * The full document to send to the printer: every slip, two to a page, once
   * per copy. The cut line goes under a top-half slip only; the bottom one
   * ends at the edge of the paper.
   */
  function doc(d, { at = new Date(), copies = 1, cutLine = true } = {}) {
    const n = Math.max(1, Math.min(20, Math.floor(copies) || 1));
    const set = slips(d);
    const all = [];
    for (let c = 0; c < n; c++) set.forEach((_, i) => all.push(i));
    const pages = [];
    for (let p = 0; p < all.length; p += 2) {
      const pair = all.slice(p, p + 2).map((i, k) => sheet(d, { at, index: i, cutLine: cutLine && k === 0 }));
      pages.push(`<div class="page">${pair.join('\n')}</div>`);
    }
    const who = (d.patient || '').trim();
    const what = d.kind === 'transfer' ? 'Transfer' : 'Call-in';
    return wrap(who ? `${what} — ${who}` : `${what} prescription`, pages.join('\n'));
  }

  /** The same slip, for the on-screen preview iframe. */
  function previewDoc(d, opts) {
    return wrap('Preview', sheet(d, opts));
  }

  /** How many slips (half sheets) the form prints, per copy. */
  const count = (d) => slips(d).length;

  return { doc, previewDoc, sheet, stamp, count };
})();
