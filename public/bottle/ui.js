'use strict';
/*
 * The Bottle Label tab.
 *
 * Flow at the counter: type (or scan) the NDC → the FDA fills in the drug →
 * type the lot, expiration and serial → Print. Enter moves to the next field,
 * and Enter in the serial box prints, so a run of bottles is: scan/type the
 * serial, Enter, next.
 *
 * Uses from app.js: LABEL_W, LABEL_H, dpiEl, labelWEl, labelHEl, ipEl,
 * postPrint(), withPrintSettings(), fitZoom().
 */
(function () {
  const $ = (sel) => document.querySelector(sel);
  const f = {
    ndc: $('#bNdc'), lot: $('#bLot'), exp: $('#bExp'), serial: $('#bSerial'),
    name: $('#bName'), generic: $('#bGeneric'), strength: $('#bStrength'),
    form: $('#bForm'), size: $('#bSize'), schedule: $('#bSchedule'),
    labeler: $('#bLabeler'), copies: $('#bCopies'),
  };
  const ui = {
    ndcStatus: $('#bNdcStatus'), lookupBtn: $('#bLookup'),
    lotHint: $('#bLotHint'), expHint: $('#bExpHint'), serialHint: $('#bSerialHint'),
    preview: $('#bPreview'), sizeInfo: $('#bSizeInfo'), encoded: $('#bEncoded'),
    notes: $('#bNotes'), print: $('#bPrint'), clear: $('#bClear'),
    status: $('#bStatus'), zpl: $('#bZpl'),
  };
  const DRUG_FIELDS = ['name', 'generic', 'strength', 'form', 'size', 'schedule', 'labeler'];

  // ---- Tabs ---------------------------------------------------------------

  const tabs = [...document.querySelectorAll('.tab')];
  function showTab(name) {
    for (const t of tabs) {
      const on = t.dataset.tab === name;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(`panel-${t.dataset.tab}`).hidden = !on;
    }
    localStorage.setItem('zebra_tab', name);
    if (name === 'designer') fitZoom(); // it can't measure itself while hidden
    else render();
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => showTab(t.dataset.tab));
    t.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      showTab(next.dataset.tab);
    });
  });

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

  /** Fill everything from a bottle's 2D code. Returns false if it wasn't one. */
  function applyScan(raw) {
    if (!GS1.looksLikeScan(raw)) return false;
    const scan = GS1.parseScan(raw);
    const ndc10 = scan.gtin && NDC.embeddedNdc10(scan.gtin);
    if (!ndc10 || !GS1.validGtin(scan.gtin)) {
      showStatus(false, "That barcode doesn't hold an NDC — type the NDC instead.");
      return true;
    }
    f.ndc.value = ndc10;
    if (scan.lot) f.lot.value = scan.lot;
    if (scan.ai17) f.exp.value = GS1.expiryFromAi17(scan.ai17) || '';
    if (scan.serial) f.serial.value = scan.serial;
    scanWarning = scan.warning;
    return true;
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
    const exp = GS1.parseExpiry(f.exp.value);
    const lotError = GS1.checkText(lot, 'Lot');
    const serialError = GS1.checkText(serial, 'Serial number');
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
    if (exp && exp.error) blockers.push(`Expiration: ${exp.error}`);

    let code = null;
    let cells = null;
    if (gtin && !lotError && !serialError && !(exp && exp.error)) {
      code = GS1.elementString({ gtin, ai17: exp ? exp.ai17 : '', lot, serial });
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
      lot,
      exp: exp && !exp.error ? exp.display : '',
      serial,
      cells,
    }, s);

    return { raw, ndc, confirmed, lot, serial, exp, lotError, serialError, blockers, code, cells, layout, spec: s };
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

    // Field hints
    setLine(ui.lotHint, c.lotError);
    setLine(ui.serialHint, c.serialError);
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
    // A scan and Enter can beat the FDA; don't print a label without its drug.
    if (pending) {
      ui.print.textContent = 'Looking up…';
      try { await pending; } catch { /* reported by lookup() */ }
      ui.print.textContent = 'Print Label';
    }
    const c = current();
    if (!c.cells) {
      showStatus(false, `✗ ${c.blockers[0] || 'Enter the NDC first.'}`);
      return;
    }
    if (!f.name.value.trim() && !confirm('There is no drug name on this label. Print it anyway?')) return;
    if (c.exp && c.exp.expired && !confirm('This expiration date has already passed. Print anyway?')) return;
    if ((!c.lot || !c.exp) && !confirm(`This label has no ${!c.lot && !c.exp ? 'lot or expiration' : !c.lot ? 'lot number' : 'expiration date'}. Print anyway?`)) return;
    if (!ipEl.value.trim()) {
      showStatus(false, '✗ Set the printer IP address under Printer Connection first.');
      return;
    }

    const copies = Math.max(1, Math.min(99, Math.floor(Number(f.copies.value) || 1)));
    printing = true;
    const original = ui.print.textContent;
    ui.print.disabled = true;
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
    } finally {
      printing = false;
      ui.print.textContent = original;
      render();
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
    ui.status.className = 'status';
    render();
    f.ndc.focus();
  }

  // ---- Events -------------------------------------------------------------

  const nextEmpty = () => [f.lot, f.exp, f.serial].find((el) => !el.value.trim()) || ui.print;

  f.ndc.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const scanned = applyScan(f.ndc.value);
    lookup(false);
    (scanned ? nextEmpty() : f.lot).focus();
  });
  f.ndc.addEventListener('change', () => {
    applyScan(f.ndc.value);
    lookup(false);
  });
  f.ndc.addEventListener('input', () => {
    scanWarning = '';
    render();
  });
  ui.lookupBtn.addEventListener('click', () => {
    applyScan(f.ndc.value);
    lookup(true);
  });

  f.lot.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); f.exp.focus(); }
  });
  f.exp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); f.serial.focus(); }
  });
  f.serial.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); print(); }
  });

  for (const el of Object.values(f)) {
    if (el !== f.ndc) el.addEventListener('input', render);
  }
  ui.print.addEventListener('click', print);
  ui.clear.addEventListener('click', newBottle);
  document.addEventListener('labelsize', render);

  showTab(localStorage.getItem('zebra_tab') === 'designer' ? 'designer' : 'bottle');
})();
