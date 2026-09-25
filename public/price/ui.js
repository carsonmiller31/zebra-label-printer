'use strict';
/*
 * The Price Stickers tab.
 *
 * Scan the drug, pick the vendor, type the price and how many, press Enter —
 * over and over — then Print. The stickers go out six to a label with dashed
 * lines to cut along. Each one carries the drug's name and strength, the
 * price as a Charleston code (or, switched under "Price prints as", the plain
 * price), the vendor and today's date.
 *
 * Quick entry: a scan anywhere on the tab fills in the drug from the FDA's
 * NDC directory and puts the cursor in the price box. Enter there adds the
 * line; typing C or A there switches the vendor. Adding the same drug, vendor
 * and price again adds to that line's count instead of making a second line.
 *
 * The list is kept in localStorage, so closing the app doesn't lose it. It is
 * cleared once every label in it has printed.
 *
 * PRIVACY: the only thing that leaves this computer is the NDC sent to the
 * FDA for the drug's name — the same lookup the Bottle Label tab makes.
 *
 * Uses from app.js: LABEL_W, LABEL_H, dpiEl, ipEl, postPrint(),
 * withPrintSettings(), askConfirm(). From bottle/: Wedge, NDC, GS1.
 */
(function () {
  const $ = (sel) => document.querySelector(sel);
  const f = {
    drug: $('#pDrug'),
    vendors: [...document.querySelectorAll('input[name="pVendor"]')],
    price: $('#pPrice'), qty: $('#pQty'),
    show: [...document.querySelectorAll('input[name="pShow"]')],
    codeWord: $('#pCodeWord'), codeStart: $('#pCodeStart'),
  };
  const ui = {
    panel: $('#panel-price'),
    drugStatus: $('#pDrugStatus'), priceHint: $('#pPriceHint'), codeKey: $('#pCodeKey'),
    priceOpt: $('#pPriceOpt'),
    codeError: $('#pCodeError'),
    add: $('#pAdd'), list: $('#pList'), summary: $('#pSummary'),
    preview: $('#pPreview'), prev: $('#pPrev'), next: $('#pNext'), pageInfo: $('#pPageInfo'),
    sizeInfo: $('#pSizeInfo'), notes: $('#pNotes'),
    print: $('#pPrint'), clear: $('#pClear'), status: $('#pStatus'), zpl: $('#pZpl'),
  };

  const MAX_QTY = 999;
  const LIST_KEY = 'zebra_price_list';
  const VENDOR_KEY = 'zebra_price_vendor';
  const WORD_KEY = 'zebra_price_code_word';
  const START_KEY = 'zebra_price_code_start';
  const SHOW_KEY = 'zebra_price_show';

  // ---- State --------------------------------------------------------------

  /** [{ drug, vendor, cents, qty }] in the order they were added. */
  let entries = load();
  let pageIndex = 0;

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(LIST_KEY) || '[]');
      return Array.isArray(raw)
        ? raw.filter((e) => e && PriceLayout.VENDORS.includes(e.vendor)
            && Number.isSafeInteger(e.cents) && e.cents > 0
            && Number.isInteger(e.qty) && e.qty >= 1)
          .map((e) => ({
            drug: typeof e.drug === 'string' ? e.drug : '',
            vendor: e.vendor, cents: e.cents, qty: Math.min(MAX_QTY, e.qty),
          }))
        : [];
    } catch {
      return [];
    }
  }
  const save = () => localStorage.setItem(LIST_KEY, JSON.stringify(entries));

  const savedVendor = localStorage.getItem(VENDOR_KEY);
  for (const r of f.vendors) r.checked = r.value === (savedVendor || PriceLayout.VENDORS[0]);

  const vendor = () => (f.vendors.find((r) => r.checked) || f.vendors[0]).value;
  function setVendor(v) {
    for (const r of f.vendors) r.checked = r.value === v;
    localStorage.setItem(VENDOR_KEY, v);
    renderLabels();
  }

  const qtyOf = (s) => {
    const n = Math.floor(Number(s));
    return Number.isFinite(n) && n >= 1 ? Math.min(MAX_QTY, n) : null;
  };

  // ---- The code -----------------------------------------------------------

  f.codeWord.value = localStorage.getItem(WORD_KEY) || PriceLayout.CODE_WORD;
  f.codeStart.value = localStorage.getItem(START_KEY) === '0' ? '0' : '1';

  const codeWord = () => f.codeWord.value.trim().toUpperCase();
  const codeStart = () => (f.codeStart.value === '0' ? 0 : 1);
  const codeError = () => PriceLayout.checkCodeWord(codeWord());
  const codeOf = (cents) => PriceLayout.priceCode(cents, codeWord(), codeStart());

  // What the big middle line prints: the Charleston code, or the price itself.
  // One setting for the whole print job, remembered between runs.
  const savedShow = localStorage.getItem(SHOW_KEY) === 'price' ? 'price' : 'code';
  for (const r of f.show) r.checked = r.value === savedShow;
  const showPrice = () => f.show.some((r) => r.checked && r.value === 'price');
  /** The code word's problem, but only when the code is what's printing. */
  const blockingError = () => (showPrice() ? '' : codeError());
  /** What a price prints as on the sticker. */
  const printedAs = (cents) => (showPrice() ? PriceLayout.formatPrice(cents) : codeOf(cents));

  /** "C=1 H=2 A=3 … N=0", the key for whoever's reading the stickers. */
  function renderCodeKey() {
    const err = codeError();
    ui.codeError.textContent = err;
    if (err) { ui.codeKey.textContent = ''; return; }
    const w = codeWord();
    ui.codeKey.textContent = [...w].map((ch, i) => `${ch}=${(i + codeStart()) % 10}`).join('  ');
  }

  // ---- The drug: scanned, looked up, or typed -----------------------------

  let lookupCtl = null;    // AbortController for the lookup in flight
  let lookupRun = null;    // its promise, so Add can wait for it

  function drugStatus(text, tone) {
    ui.drugStatus.className = `lookup${tone ? ` tone-${tone}` : ''}`;
    ui.drugStatus.textContent = text;
  }

  /** "Brand" or "Generic", then the strength — what fits on the sticker. */
  function drugText(facts) {
    // A combination's strength names every ingredient again ("Amlodipine
    // 5 mg / Benazepril 10 mg"); the name already said them, so keep the
    // numbers.
    const strength = (facts.strength || '').split(' / ')
      .map((part) => (part.match(/\d[\d.,]*\s*\S.*$/) || [part])[0].trim())
      .join(' / ');
    return `${facts.name || ''} ${strength}`.replace(/\s+/g, ' ').trim();
  }

  /** Look up an NDC and put the drug in the box. */
  function lookupDrug(ndc) {
    cancelLookup();
    const ctl = new AbortController();
    lookupCtl = ctl;
    let shown = ndc;  // where the dashes go is the FDA's to say
    drugStatus(`Looking up NDC ${shown}…`);
    const run = (async () => {
      let result;
      try { result = await NDC.lookup(ndc, ctl.signal); } catch { result = { status: 'error' }; }
      // Whatever happened while we waited — a new scan, Add, Clear, typing in
      // the box — this answer is only wanted if nobody has moved on.
      if (lookupCtl !== ctl) return;
      lookupCtl = null;
      if (result.status === 'found') {
        if (result.facts.packageNdc) shown = result.facts.packageNdc;
        f.drug.value = drugText(result.facts);
        flash(f.drug);
        drugStatus(`NDC ${shown} — ${result.facts.labeler || 'found'}.`, 'ok');
      } else if (result.status === 'not-found') {
        f.drug.value = '';
        drugStatus(`NDC ${shown} isn’t in the FDA’s directory — type the drug and strength.`, 'warn');
        f.drug.focus();
      } else {
        drugStatus('Couldn’t reach the FDA — type the drug and strength, or scan again.', 'err');
      }
      renderLabels();
    })();
    lookupRun = run;
    run.finally(() => { if (lookupRun === run) lookupRun = null; });
    return run;
  }

  function cancelLookup() {
    if (lookupCtl) lookupCtl.abort();
    lookupCtl = null;
    lookupRun = null;
  }

  function flash(el) {
    el.classList.remove('flash');
    void el.offsetWidth; // let the animation start over
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1100);
  }

  /** The NDC in a barcode, or '' — a bottle's 2D code or its linear one. */
  function ndcFromScan(text) {
    if (GS1.looksLikeScan(text)) {
      const scan = GS1.parseScan(text);
      return scan.gtin && GS1.validGtin(scan.gtin) ? NDC.embeddedNdc10(scan.gtin) || '' : '';
    }
    return NDC.embeddedNdc10(text) || '';
  }

  /** Same test as the Bottle Label tab: its structure, or digits at scanner speed. */
  function isScan(text, { fast = true } = {}) {
    if (GS1.looksLikeScan(text)) return true;
    return fast && /^\d{10,16}$/.test(text) && !!NDC.embeddedNdc10(text);
  }

  function onScan(text) {
    const ndc = ndcFromScan(text.trim());
    if (!ndc) {
      drugStatus('That barcode doesn’t hold an NDC — type the drug and strength instead.', 'err');
      return;
    }
    f.drug.value = '';
    lookupDrug(ndc);
    f.price.focus();
    f.price.select();
  }

  // ---- What's typed, and the list -----------------------------------------

  /**
   * What's typed in the boxes but not added yet, as an entry — or null, with
   * the reason when there is something typed that isn't a usable price.
   */
  function pending() {
    const text = f.price.value.trim();
    if (!text) return { entry: null, error: '' };
    const cents = PriceLayout.parsePrice(text);
    if (cents == null) {
      return { entry: null, error: /\.\d{3,}/.test(text) ? 'Only two places after the decimal point.' : 'That isn’t a price.' };
    }
    if (cents === 0) return { entry: null, error: 'The price can’t be $0.00.' };
    const qty = qtyOf(f.qty.value);
    if (qty == null) return { entry: null, error: 'The quantity has to be 1 or more.' };
    return { entry: { drug: f.drug.value.trim(), vendor: vendor(), cents, qty }, error: '' };
  }

  /** The list plus anything typed but not added — what Print would print. */
  function toPrint() {
    const p = pending().entry;
    return p ? [...entries, p] : entries;
  }

  let adding = false;

  async function add() {
    if (adding) return false;
    adding = true;
    try {
      // A scan's name may still be on its way; the sticker should have it.
      if (lookupRun) {
        ui.priceHint.textContent = 'Waiting for the drug name…';
        await lookupRun;
        ui.priceHint.textContent = '';
      }
      const p = pending();
      if (!p.entry) {
        ui.priceHint.textContent = p.error || 'Type the price first.';
        f.price.focus();
        return false;
      }
      const same = entries.find((e) =>
        e.vendor === p.entry.vendor && e.cents === p.entry.cents && e.drug === p.entry.drug);
      if (same) same.qty = Math.min(MAX_QTY, same.qty + p.entry.qty);
      else entries.push(p.entry);
      save();
      cancelLookup();
      f.drug.value = '';
      f.price.value = '';
      f.qty.value = '1';
      ui.priceHint.textContent = '';
      drugStatus('');
      pageIndex = Infinity; // show the label the new stickers landed on
      render();
      f.price.focus();
      return true;
    } finally {
      adding = false;
    }
  }

  function renderList() {
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'batch-empty';
      empty.textContent = 'Nothing on the list yet. Scan a drug, type its price and press Enter.';
      ui.list.replaceChildren(empty);
      return;
    }
    ui.list.replaceChildren(...entries.map((e, i) => {
      const row = document.createElement('div');
      row.className = 'batch-item price-item';

      // The drug can be fixed right here — a name the FDA spells long, or one
      // that was typed wrong.
      const drug = document.createElement('input');
      drug.className = 'pi-drug';
      drug.value = e.drug;
      drug.placeholder = '(no drug)';
      drug.setAttribute('aria-label', 'Drug and strength');
      drug.addEventListener('input', () => {
        e.drug = drug.value.trim();
        save();
        renderLabels();
      });

      const who = document.createElement('span');
      who.className = 'pi-vendor';
      who.textContent = e.vendor;

      const price = document.createElement('span');
      price.className = 'pi-price mono';
      price.textContent = PriceLayout.formatPrice(e.cents);
      const code = document.createElement('span');
      code.className = 'pi-code mono';
      // The code alongside the price — nothing to add when the price is what prints.
      code.textContent = codeError() || showPrice() ? '' : codeOf(e.cents);
      price.append(code);

      const qty = document.createElement('input');
      qty.type = 'number';
      qty.min = '1';
      qty.max = String(MAX_QTY);
      qty.className = 'pi-qty mono';
      qty.value = String(e.qty);
      qty.setAttribute('aria-label', 'How many stickers');
      // Update the model only while typing, so the box keeps focus; a blank or
      // zero box snaps back to what it was when you leave it.
      qty.addEventListener('input', () => {
        const n = qtyOf(qty.value);
        if (n == null) return;
        e.qty = n;
        save();
        renderLabels();
      });
      qty.addEventListener('change', () => { qty.value = String(e.qty); });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'bi-del';
      del.title = 'Remove';
      del.setAttribute('aria-label', `Remove ${e.drug || e.vendor} ${PriceLayout.formatPrice(e.cents)}`);
      del.textContent = '×';
      del.addEventListener('click', () => {
        entries.splice(i, 1);
        save();
        render();
        f.price.focus();
      });

      const top = document.createElement('div');
      top.className = 'pi-top';
      top.append(drug, del);
      const bottom = document.createElement('div');
      bottom.className = 'pi-bottom';
      const times = document.createElement('span');
      times.className = 'pi-times';
      times.textContent = '×';
      bottom.append(who, price, times, qty);
      row.append(top, bottom);
      return row;
    }));
  }

  // ---- Render -------------------------------------------------------------

  const spec = () => ({ W: LABEL_W, H: LABEL_H, dpi: Number(dpiEl.value) || 203 });
  const fmtIn = (v) => String(Math.round(v * 100) / 100);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  /** Everything a print needs, worked out from the list, the stock and today. */
  function job() {
    const s = spec();
    const date = PriceLayout.dateText();
    const stickers = blockingError() ? []
      : PriceLayout.expand(toPrint(), codeWord(), codeStart(), showPrice() ? 'price' : 'code');
    const pages = PriceLayout.paginate(stickers);
    const plan = PriceLayout.plan(stickers, s, date);
    return { spec: s, date, stickers, pages, plan };
  }

  function render() {
    renderCodeKey();
    renderList();
    renderLabels();
  }

  /** The preview, the counts and the notes — everything but the list itself. */
  function renderLabels() {
    const j = job();
    const { W, H, dpi } = j.spec;
    const n = j.stickers.length;

    const p = pending();
    ui.priceHint.className = `hint${p.error ? ' tone-err' : ''}`;
    ui.priceOpt.textContent = showPrice() ? '— prints as the price' : '— prints as its code';
    if (p.entry && !blockingError()) ui.priceHint.textContent = `Prints as ${printedAs(p.entry.cents)}`;
    else if (p.error) ui.priceHint.textContent = p.error;
    else if (!adding) ui.priceHint.textContent = '';

    ui.summary.textContent = n
      ? `${plural(n, 'sticker', 'stickers')} → ${plural(j.pages.length, 'label', 'labels')} (6 per label).`
      : '';

    const count = Math.max(1, j.pages.length);
    pageIndex = Math.max(0, Math.min(count - 1, pageIndex));
    ui.pageInfo.textContent = j.pages.length ? `Label ${pageIndex + 1} of ${j.pages.length}` : 'Preview';
    ui.prev.disabled = pageIndex === 0;
    ui.next.disabled = pageIndex >= count - 1;

    const notes = [];
    if (blockingError()) {
      notes.push({ text: `${blockingError()} Fix it under Price code, or print the actual price.`, tone: 'err' });
    }
    if (!j.plan) {
      ui.preview.innerHTML = '';
      ui.zpl.value = '';
      ui.sizeInfo.textContent = '';
      notes.push({ text: 'Six stickers won’t fit on a label this small — change the stock under Label Setup.', tone: 'err' });
    } else {
      const layout = PriceLayout.page(j.pages[pageIndex] || [], j.spec, j.plan);
      ui.preview.innerHTML = PriceLayout.toSVG(layout, j.spec);
      ui.zpl.value = PriceLayout.toZPL(layout, j.spec, 1);
      const { cols, rows } = j.plan.grid;
      ui.sizeInfo.textContent =
        `${cols} across × ${rows} down, each about ${fmtIn(W / cols / dpi)}" × ${fmtIn(H / rows / dpi)}", ` +
        `on ${fmtIn(W / dpi)}" × ${fmtIn(H / dpi)}" stock at ${dpi} dpi — change the stock under Label Setup.`;
      if (!j.plan.sizes.fits) {
        notes.push({ text: 'Everything doesn’t fit on a sticker this size — check the preview.', tone: 'warn' });
      }
      if (j.plan.sizes.shortened) {
        notes.push({ text: 'A drug name was too long and got cut short — you can shorten it in the list.', tone: 'warn' });
      }
    }
    ui.preview.style.aspectRatio = `${W} / ${H}`;

    if (p.entry && entries.length) {
      notes.push({ text: 'The price you’ve typed isn’t on the list yet — it will print too. Press Enter to add it.', tone: 'warn' });
    }
    const missing = toPrint().filter((e) => !e.drug).length;
    if (missing) {
      notes.push({ text: `${plural(missing, 'line has', 'lines have')} no drug — ${missing === 1 ? 'that sticker prints' : 'those stickers print'} without a name.`, tone: 'muted' });
    }
    const spare = j.pages.length ? j.pages.length * 6 - n : 0;
    if (spare) notes.push({ text: `The last label has ${plural(spare, 'blank spot', 'blank spots')}.`, tone: 'muted' });
    ui.notes.replaceChildren(...notes.map((x) => {
      const li = document.createElement('li');
      li.className = `tone-${x.tone}`;
      li.textContent = x.text;
      return li;
    }));

    if (!printing) ui.print.textContent = n ? `Print ${plural(j.pages.length, 'Label', 'Labels')}` : 'Print';
    ui.print.disabled = printing;
  }

  // ---- Print --------------------------------------------------------------

  let printing = false;

  function showStatus(ok, msg) {
    ui.status.className = `status show ${ok ? 'ok' : 'err'}`;
    ui.status.textContent = msg;
  }

  async function print() {
    if (printing) return;
    printing = true;
    ui.print.disabled = true;
    try {
      await printNow();
    } finally {
      printing = false;
      render();
    }
  }

  async function printNow() {
    if (blockingError()) {
      showStatus(false, `✗ ${blockingError()} Fix it under Price code.`);
      return;
    }
    const p = pending();
    if (p.error) {
      showStatus(false, `✗ ${p.error} Fix the price, or clear the box.`);
      f.price.focus();
      return;
    }
    // What's typed in the boxes goes onto the list first (waiting for a
    // scanned drug's name if need be), so a failure part-way doesn't lose it
    // and the list matches what was sent.
    if (p.entry && !(await add())) return;

    const j = job();
    if (!j.stickers.length) {
      showStatus(false, '✗ Add a price to the list first.');
      f.price.focus();
      return;
    }
    if (!j.plan) {
      showStatus(false, '✗ Six stickers won’t fit on a label this small — change the stock under Label Setup.');
      return;
    }
    if (!ipEl.value.trim()) {
      showStatus(false, '✗ Set the printer IP address under Printer Connection first.');
      return;
    }
    const doubts = [];
    if (!j.plan.sizes.fits) doubts.push('Everything doesn’t fit on a sticker this size.');
    if (j.plan.sizes.shortened) doubts.push('A drug name will be cut short.');
    if (doubts.length && !(await askConfirm('Print these stickers anyway?', { ok: 'Print anyway', detail: doubts }))) {
      return;
    }

    for (let i = 0; i < j.pages.length; i++) {
      ui.print.textContent = `Printing ${i + 1}/${j.pages.length}…`;
      const partly = i ? ` (labels 1–${i} printed). The list is kept.` : '';
      try {
        const layout = PriceLayout.page(j.pages[i], j.spec, j.plan);
        const r = await postPrint(withPrintSettings(PriceLayout.toZPL(layout, j.spec, 1)));
        if (!r.ok) {
          showStatus(false, `✗ Label ${i + 1} of ${j.pages.length}: ${r.message || r.error}${partly}`);
          return;
        }
      } catch (e) {
        showStatus(false, `✗ Label ${i + 1} of ${j.pages.length}: ${e.message}${partly}`);
        return;
      }
    }
    showStatus(true, `✓ Printed ${plural(j.stickers.length, 'price sticker', 'price stickers')} on ${plural(j.pages.length, 'label', 'labels')}.`);
    entries = [];
    save();
    pageIndex = 0;
    f.price.focus();
  }

  async function clearList() {
    if (entries.length && !(await askConfirm('Clear the whole list?', { ok: 'Clear list' }))) return;
    entries = [];
    save();
    cancelLookup();
    f.drug.value = '';
    f.price.value = '';
    f.qty.value = '1';
    drugStatus('');
    ui.status.className = 'status';
    pageIndex = 0;
    render();
    f.price.focus();
  }

  // ---- Events -------------------------------------------------------------

  // A scan anywhere on the tab — whichever box the cursor was in, or none.
  // Only while this tab is showing, so it never swallows keys meant for the
  // Bottle Label tab's own scanner, or for the other modes.
  Wedge.capture({
    active: () => !ui.panel.closest('[hidden]') && !document.querySelector('.modal-overlay:not([hidden])'),
    isScan,
    onScan,
  });

  // When the previous key went down — to tell hands from a scanner below.
  let prevKeyAt = 0, keyAt = 0;
  document.addEventListener('keydown', (e) => { prevKeyAt = keyAt; keyAt = e.timeStamp; }, true);

  f.price.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // Enter on an empty box with a list waiting means "that's everything".
      if (!f.price.value.trim() && entries.length) print();
      else add();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // A letter arriving hard on the heels of the last key is a scanner typing
    // a lot number into this box, not someone switching vendor; the scanner
    // wedge will take those characters back out.
    if (e.timeStamp - prevKeyAt < Wedge.FAST * 1.5) return;
    const k = e.key.toLowerCase();
    const v = PriceLayout.VENDORS.find((name) => name[0].toLowerCase() === k);
    if (v) { e.preventDefault(); setVendor(v); }
  });
  f.price.addEventListener('input', renderLabels);
  f.qty.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); add(); }
  });
  f.qty.addEventListener('focus', () => f.qty.select());
  f.qty.addEventListener('input', renderLabels);

  f.drug.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    // An NDC typed by hand: look it up. Anything else is the drug's name.
    const raw = f.drug.value.trim();
    const r = /^[\d\s-]{10,14}$/.test(raw) ? NDC.resolve(raw) : null;
    if (r && r.ndc10) {
      f.drug.value = '';
      lookupDrug(r.ndc10);
    } else if (r && r.options) {
      drugStatus('That 11-digit NDC could be more than one product — scan the bottle, or type it with dashes.', 'warn');
      return;
    }
    f.price.focus();
  });
  f.drug.addEventListener('input', () => {
    // Typing over a lookup that hasn't answered: the typing wins.
    if (lookupCtl) { cancelLookup(); drugStatus(''); }
    renderLabels();
  });

  for (const r of f.vendors) r.addEventListener('change', () => setVendor(r.value));
  for (const r of f.show) {
    r.addEventListener('change', () => {
      localStorage.setItem(SHOW_KEY, r.value);
      render();
    });
  }
  f.codeWord.addEventListener('input', () => {
    if (!codeError()) localStorage.setItem(WORD_KEY, codeWord());
    render();
  });
  f.codeStart.addEventListener('change', () => {
    localStorage.setItem(START_KEY, f.codeStart.value);
    render();
  });

  ui.add.addEventListener('click', add);
  ui.print.addEventListener('click', print);
  ui.clear.addEventListener('click', clearList);
  ui.prev.addEventListener('click', () => { pageIndex--; renderLabels(); });
  ui.next.addEventListener('click', () => { pageIndex++; renderLabels(); });
  document.addEventListener('labelsize', renderLabels);
  document.addEventListener('tabchange', (e) => { if (e.detail === 'price') render(); });
  render();
})();
