'use strict';
/*
 * The Bottle Label tab.
 *
 * Flow at the counter: scan the bottle (or type the NDC) → the FDA fills in
 * the drug → check the lot, expiration, quantity and serial → Print. Enter
 * moves to the next field, and Enter in the serial box prints, so a run of
 * bottles is: scan/type the serial, Enter, next.
 *
 * A scan is caught anywhere on this tab, whichever box the cursor is in — see
 * wedge.js — and fills every field the barcode carries at once.
 *
 * Uses from app.js: LABEL_W, LABEL_H, dpiEl, ipEl, postPrint(),
 * withPrintSettings(), askConfirm().
 */
(function () {
  const $ = (sel) => document.querySelector(sel);
  const f = {
    ndc: $('#bNdc'), lot: $('#bLot'), exp: $('#bExp'), qty: $('#bQty'), serial: $('#bSerial'),
    name: $('#bName'), generic: $('#bGeneric'), strength: $('#bStrength'),
    form: $('#bForm'), size: $('#bSize'), schedule: $('#bSchedule'),
    labeler: $('#bLabeler'), copies: $('#bCopies'),
  };
  const ui = {
    panel: $('#panel-bottle'), ndcStatus: $('#bNdcStatus'), lookupBtn: $('#bLookup'),
    scanNote: $('#bScanNote'),
    lotHint: $('#bLotHint'), expHint: $('#bExpHint'), serialHint: $('#bSerialHint'),
    qtyHint: $('#bQtyHint'), qtySuggest: $('#bQtySuggest'),
    preview: $('#bPreview'), sizeInfo: $('#bSizeInfo'), encoded: $('#bEncoded'),
    notes: $('#bNotes'), print: $('#bPrint'), clear: $('#bClear'),
    status: $('#bStatus'), zpl: $('#bZpl'),
  };
  const DRUG_FIELDS = ['name', 'generic', 'strength', 'form', 'size', 'schedule', 'labeler'];

  // ---- FDA lookup ---------------------------------------------------------

  let facts = null;       // FDA facts for `lookedUp`
  let lookedUp = '';      // the NDC text those facts belong to
  let lookupState = 'idle';
  let inFlight = null;
  let pending = null;     // promise for the lookup in flight
  let scanWarning = '';

  function clearDrug() {
    for (const k of DRUG_FIELDS) f[k].value = '';
  }

  function fillDrug(x) {
    f.name.value = x.name || '';
    f.generic.value = x.generic || '';
    f.strength.value = x.strength || '';
    f.form.value = x.dosageForm || '';
    f.size.value = x.size || '';
    f.labeler.value = x.labeler || '';
    const schedule = (x.schedule || '').toUpperCase().replace(/N$/, '');
    f.schedule.value = [...f.schedule.options].some((o) => o.value === schedule) ? schedule : '';
  }

  async function lookup(force) {
    const raw = f.ndc.value.trim();
    const resolved = raw ? NDC.resolve(raw) : null;
    if (!resolved || resolved.error || !NDC.isSearchable(raw)) {
      render();
      return;
    }
    if (!force && raw === lookedUp) return;

    // A different bottle: never leave the last drug's details behind.
    if (raw !== lookedUp) clearDrug();
    if (inFlight) inFlight.abort();
    const mine = new AbortController();
    inFlight = mine;
    lookedUp = raw;
    facts = null;
    lookupState = 'loading';
    render();

    const request = NDC.lookup(raw, mine.signal);
    pending = request;
    const result = await request;
    if (pending === request) pending = null;
    if (inFlight !== mine) return; // superseded
    inFlight = null;
    if (result.status === 'found') {
      facts = result.facts;
      fillDrug(facts);
    } else if (result.status === 'error') {
      lookedUp = ''; // let the next attempt try again
    }
    lookupState = result.status;
    render();
  }

  // ---- Scanning -----------------------------------------------------------

  let scanNote = '';   // what the last scan filled in, shown under the NDC

  /**
   * Does this text come off a barcode rather than a keyboard? A bottle's
   * square code says so in its own structure. Its plain linear barcode is
   * only digits — and so is many a lot number — so that one is trusted only
   * when the characters arrived at scanner speed.
   */
  function isScan(text, { fast = true } = {}) {
    if (GS1.looksLikeScan(text)) return true;
    return fast && /^\d{10,16}$/.test(text) && !!NDC.embeddedNdc10(text);
  }

  /** Draw the eye to a box a scan just filled. */
  function flash(el) {
    el.classList.remove('flash');
    void el.offsetWidth; // let the animation start over
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1100);
  }

  /**
   * Fill the form from a scan. Returns the list of what it filled (empty when
   * the barcode held nothing usable), or null when it wasn't a barcode.
   */
  function applyScan(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!isScan(text)) return null;

    const filled = [];
    const set = (el, value, label) => {
      if (!value) return;
      el.value = value;
      filled.push(label);
      flash(el);
    };

    // A linear barcode: the NDC and nothing else.
    if (!GS1.looksLikeScan(text)) {
      scanWarning = '';
      set(f.ndc, NDC.embeddedNdc10(text), 'NDC');
      return filled;
    }

    const scan = GS1.parseScan(text);
    const ndc10 = scan.gtin && NDC.embeddedNdc10(scan.gtin);
    if (!ndc10 || !GS1.validGtin(scan.gtin)) {
      scanNote = '';
      showStatus(false, "That barcode doesn't hold an NDC — type the NDC instead.");
      return [];
    }
    set(f.ndc, ndc10, 'NDC');
    set(f.lot, scan.lot, 'lot');
    set(f.exp, scan.ai17 ? GS1.expiryFromAi17(scan.ai17) || '' : '', 'expiration');
    set(f.serial, scan.serial, 'serial');
    set(f.qty, scan.qty, 'quantity');
    scanWarning = scan.warning;
    return filled;
  }

  /** A scan caught anywhere on the tab. */
  function onScan(text) {
    const filled = applyScan(text);
    if (!filled) return;
    if (filled.length) {
      scanNote = `Scanned — ${filled.join(', ')} filled in.`;
      ui.status.className = 'status';
      lookup(false);
      nextEmpty().focus();
    }
    render();
  }

  // ---- Model --------------------------------------------------------------

  function spec() {
    return { W: LABEL_W, H: LABEL_H, dpi: Number(dpiEl.value) || 203 };
  }

  /** Everything the label and the checks need, derived from the form. */
  function current() {
    const raw = f.ndc.value.trim();
    let ndc = raw ? NDC.resolve(raw) : null;
    // The FDA's spelling settles which 10 digits an 11-digit code came from.
    const confirmed = facts && lookedUp === raw && facts.packageNdc
      ? NDC.fromPackageNdc(facts.packageNdc)
      : null;
    if (confirmed) ndc = confirmed;

    const lot = f.lot.value.trim();
    const serial = f.serial.value.trim();
    const qty = GS1.stripZeros(f.qty.value.trim());
    const exp = GS1.parseExpiry(f.exp.value);
    const lotError = GS1.checkText(lot, 'Lot');
    const serialError = GS1.checkText(serial, 'Serial number');
    const qtyError = GS1.checkQuantity(f.qty.value.trim());
    const blockers = [];

    let gtin = null;
    if (!raw) blockers.push('Enter the NDC.');
    else if (ndc && ndc.error) blockers.push(ndc.error);
    else if (ndc && ndc.ndc10) gtin = GS1.gtinFromNdc10(ndc.ndc10);
    else if (ndc && ndc.options) {
      blockers.push(
        lookupState === 'loading'
          ? 'Waiting for the FDA to confirm which NDC this is.'
          : `This 11-digit NDC could be ${ndc.options.join(' or ')}. Type it with hyphens exactly as printed on the bottle.`,
      );
    }
    if (lotError) blockers.push(lotError);
    if (serialError) blockers.push(serialError);
    if (qtyError) blockers.push(qtyError);
    if (exp && exp.error) blockers.push(`Expiration: ${exp.error}`);

    let code = null;
    let cells = null;
    if (gtin && !lotError && !serialError && !qtyError && !(exp && exp.error)) {
      code = GS1.elementString({ gtin, ai17: exp ? exp.ai17 : '', lot, serial, qty });
      try {
        cells = BottleLayout.encodeMatrix(bwipjs, code.data);
      } catch (e) {
        blockers.push(`Couldn't build the barcode: ${e.message}`);
      }
    }

    const s = spec();
    const layout = BottleLayout.build({
      name: f.name.value.trim(),
      generic: f.generic.value.trim(),
      strength: f.strength.value.trim(),
      dosageForm: f.form.value.trim(),
      size: f.size.value.trim(),
      labeler: f.labeler.value.trim(),
      schedule: f.schedule.value,
      ndc: ndc && !ndc.error ? ndc.display || ndc.ndc10 || ndc.ndc11 : raw,
      qty: qtyError ? '' : qty,
      lot,
      exp: exp && !exp.error ? exp.display : '',
      serial,
      cells,
    }, s);

    return {
      raw, ndc, confirmed, lot, serial, qty, exp,
      lotError, serialError, qtyError, blockers, code, cells, layout, spec: s,
    };
  }

  // ---- Render -------------------------------------------------------------

  let queued = false;
  function render() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      draw();
    });
  }

  function setLine(el, text, tone) {
    el.textContent = text || '';
    el.className = el.className.replace(/\s*tone-\w+/g, '') + (tone ? ` tone-${tone}` : '');
  }

  function draw() {
    const c = current();

    // NDC status
    const st = ui.ndcStatus;
    st.replaceChildren();
    st.className = 'lookup';
    if (c.raw && c.ndc && c.ndc.error) {
      st.textContent = c.ndc.error;
    } else if (lookupState === 'loading' && lookedUp === c.raw) {
      st.textContent = 'Looking it up in the FDA directory…';
    } else if (lookupState === 'found' && facts && lookedUp === c.raw) {
      st.classList.add('tone-ok');
      const head = document.createElement('div');
      head.textContent = `✓ ${[facts.name, facts.strength].filter(Boolean).join(' ')}` +
        (c.confirmed ? ` — NDC ${c.confirmed.display}` : '');
      st.append(head);
      const detail = document.createElement('div');
      detail.className = 'lookup-detail';
      detail.textContent = facts.packageDescription
        ? `FDA package: ${facts.packageDescription}`
        : "The FDA lists this product but not this package size — check the package line.";
      st.append(detail);
    } else if (lookupState === 'not-found' && lookedUp === c.raw) {
      st.classList.add('tone-warn');
      st.textContent = 'Not in the FDA directory. Type the drug details below.';
    } else if (lookupState === 'error' && !lookedUp && c.raw) {
      st.classList.add('tone-err');
      st.textContent = "Couldn't reach the FDA directory. Type the drug details below, or press Look up to try again.";
    }

    // What the last scan filled in
    ui.scanNote.textContent = scanNote;
    ui.scanNote.hidden = !scanNote;

    // Field hints
    setLine(ui.lotHint, c.lotError);
    setLine(ui.serialHint, c.serialError);
    setLine(ui.qtyHint, c.qtyError);

    // The full-package count from the FDA, offered while the box is empty.
    const suggestion = lookupState === 'found' && facts && lookedUp === c.raw && !c.qty
      ? NDC.packageCount(facts.packageDescription)
      : null;
    ui.qtySuggest.hidden = !suggestion;
    if (suggestion) {
      ui.qtySuggest.textContent = `Full package: ${suggestion.label}`;
      ui.qtySuggest.dataset.count = suggestion.count;
    }
    if (c.exp && c.exp.error) setLine(ui.expHint, c.exp.error, 'err');
    else if (c.exp) setLine(ui.expHint, c.exp.expired ? `${c.exp.long} — already expired` : c.exp.long, c.exp.expired ? 'err' : '');
    else setLine(ui.expHint, '');

    // Preview
    const { W, H, dpi } = c.spec;
    ui.preview.innerHTML = BottleLayout.toSVG(c.layout, c.spec);
    ui.preview.style.aspectRatio = `${W} / ${H}`;
    ui.sizeInfo.textContent =
      `${fmtIn(W / dpi)}" × ${fmtIn(H / dpi)}" label at ${dpi} dpi — change the stock under Label Setup.`;

    ui.encoded.replaceChildren();
    if (c.code) {
      const label = document.createElement('span');
      label.textContent = 'In the barcode: ';
      const code = document.createElement('code');
      code.textContent = c.code.hri;
      ui.encoded.append(label, code);
    }

    // Notes: things that stop printing, then things worth a second look.
    const notes = [];
    for (const b of c.blockers) notes.push({ text: b, tone: 'err' });
    if (c.cells) {
      if (!c.lot) notes.push({ text: 'No lot number — the barcode will only carry the NDC and expiration.', tone: 'warn' });
      if (!c.exp) notes.push({ text: 'No expiration date entered.', tone: 'warn' });
    }
    if (c.exp && c.exp.expired) notes.push({ text: 'This expiration date has already passed.', tone: 'err' });
    // "Bottle of 100 tablets" over "QTY 30" is two answers to the same question.
    const packCount = (f.size.value.match(/\d+/) || [])[0];
    if (c.qty && packCount && Number(packCount) !== Number(c.qty)) {
      notes.push({
        text: `The package line still says ${packCount} — clear it if this bottle holds ${c.qty}.`,
        tone: 'warn',
      });
    }
    if (scanWarning) notes.push({ text: scanWarning, tone: 'warn' });
    if (c.raw && !f.name.value.trim() && lookupState !== 'loading') {
      notes.push({ text: 'No drug name yet.', tone: 'warn' });
    }
    for (const n of c.layout.notes) notes.push({ text: n, tone: 'warn' });
    ui.notes.replaceChildren(...notes.map((n) => {
      const li = document.createElement('li');
      li.className = `tone-${n.tone}`;
      li.textContent = n.text;
      return li;
    }));

    ui.zpl.value = BottleLayout.toZPL(c.layout, c.spec, f.copies.value);
    ui.print.disabled = printing;
  }

  const fmtIn = (v) => String(Math.round(v * 100) / 100);

  // ---- Print --------------------------------------------------------------

  let printing = false;

  function showStatus(ok, msg) {
    ui.status.className = `status show ${ok ? 'ok' : 'err'}`;
    ui.status.textContent = msg;
  }

  async function print() {
    if (printing) return;
    // Held for the whole attempt, including the confirm dialog, so a second
    // Enter can't start a second print.
    printing = true;
    try {
      await printNow();
    } finally {
      printing = false;
      ui.print.disabled = false;
      ui.print.textContent = 'Print Label';
      render();
    }
  }

  async function printNow() {
    ui.print.disabled = true;
    // A scan and Enter can beat the FDA; don't print a label without its drug.
    if (pending) {
      ui.print.textContent = 'Looking up…';
      try { await pending; } catch { /* reported by lookup() */ }
    }
    const c = current();
    if (!c.cells) {
      showStatus(false, `✗ ${c.blockers[0] || 'Enter the NDC first.'}`);
      return;
    }
    if (!ipEl.value.trim()) {
      showStatus(false, '✗ Set the printer IP address under Printer Connection first.');
      return;
    }

    const doubts = [];
    if (!f.name.value.trim()) doubts.push('There is no drug name.');
    if (c.exp && c.exp.expired) doubts.push('The expiration date has already passed.');
    if (!c.lot && !c.exp) doubts.push('There is no lot number or expiration date.');
    else if (!c.lot) doubts.push('There is no lot number.');
    else if (!c.exp) doubts.push('There is no expiration date.');
    if (doubts.length) {
      ui.print.textContent = 'Print Label';
      const go = await askConfirm('Print this label anyway?', { ok: 'Print anyway', detail: doubts });
      if (!go) return;
    }

    const copies = Math.max(1, Math.min(99, Math.floor(Number(f.copies.value) || 1)));
    ui.print.textContent = 'Printing…';
    try {
      const j = await postPrint(withPrintSettings(BottleLayout.toZPL(c.layout, c.spec, copies)));
      if (!j.ok) {
        showStatus(false, `✗ ${j.message || j.error}`);
        return;
      }
      const what = `${copies} label${copies === 1 ? '' : 's'}`;
      if (c.serial) {
        // Every bottle has its own serial; the rest usually stays the same.
        f.serial.value = '';
        f.serial.focus();
        showStatus(true, `✓ Printed ${what} for SN ${c.serial}. Enter the next bottle's serial, or New Bottle.`);
      } else {
        showStatus(true, `✓ Printed ${what}.`);
      }
      scanWarning = '';
    } catch (e) {
      showStatus(false, `✗ ${e.message}`);
    }
  }

  function newBottle() {
    if (inFlight) inFlight.abort();
    inFlight = null;
    pending = null;
    for (const k of Object.keys(f)) if (k !== 'copies') f[k].value = '';
    facts = null;
    lookedUp = '';
    lookupState = 'idle';
    scanWarning = '';
    scanNote = '';
    ui.status.className = 'status';
    render();
    f.ndc.focus();
  }

  // ---- Events -------------------------------------------------------------

  const nextEmpty = () => [f.lot, f.exp, f.qty, f.serial].find((el) => !el.value.trim()) || ui.print;

  // A scan anywhere on the tab — whichever box the cursor was in, or none.
  Wedge.capture({
    active: () => !ui.panel.hidden && !document.querySelector('.modal-overlay:not([hidden])'),
    isScan,
    onScan,
  });

  /** A barcode that went into the NDC box itself, or was pasted there. */
  function scanFromBox() {
    const filled = applyScan(f.ndc.value);
    if (filled && filled.length) scanNote = `Scanned — ${filled.join(', ')} filled in.`;
    return !!filled;
  }

  f.ndc.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const scanned = scanFromBox();
    lookup(false);
    (scanned ? nextEmpty() : f.lot).focus();
  });
  f.ndc.addEventListener('change', () => {
    scanFromBox();
    lookup(false);
  });
  f.ndc.addEventListener('input', () => {
    scanWarning = '';
    scanNote = '';
    render();
  });
  ui.lookupBtn.addEventListener('click', () => {
    scanFromBox();
    lookup(true);
  });

  f.lot.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); f.exp.focus(); }
  });
  f.exp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); f.qty.focus(); }
  });
  f.qty.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); f.serial.focus(); }
  });
  f.serial.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); print(); }
  });

  ui.qtySuggest.addEventListener('click', () => {
    f.qty.value = ui.qtySuggest.dataset.count || '';
    flash(f.qty);
    render();
  });

  for (const el of Object.values(f)) {
    if (el !== f.ndc) el.addEventListener('input', render);
  }
  ui.print.addEventListener('click', print);
  ui.clear.addEventListener('click', newBottle);
  document.addEventListener('labelsize', render);
  document.addEventListener('tabchange', (e) => { if (e.detail === 'bottle') render(); });
})();
