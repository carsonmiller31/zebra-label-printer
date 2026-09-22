'use strict';
/*
 * The Paper Forms side of the app: the Call-In Script tab and its Settings.
 *
 * Someone from a prescriber's office is on the phone. You type what they say,
 * press Print, and a half-sheet comes out of the ordinary office printer with
 * the time it was taken and your initials on it.
 *
 * What is saved and what is not
 * -----------------------------
 * Settings — the chosen printer, your initials, the pharmacy name, the cut
 * line — live in localStorage. The call itself never does: patient name, date
 * of birth, drug, prescriber and phone number are held in the form and in
 * nothing else, and go away when the form is cleared or the app is closed.
 *
 * Uses from app.js: askConfirm(). Uses paper/form.js and paper/print.js.
 */
(function () {
  const $ = (sel) => document.querySelector(sel);

  const f = {
    patient: $('#cPatient'), dob: $('#cDob'),
    drug: $('#cDrug'), qty: $('#cQty'), refills: $('#cRefills'), sig: $('#cSig'),
    prescriber: $('#cPrescriber'), npi: $('#cNpi'),
    caller: $('#cCaller'), phone: $('#cPhone'), initials: $('#cInitials'),
    copies: $('#cCopies'),
  };
  const drugUi = {
    list: $('#cDrugList'), ndc: $('#cNdc'), ndcBtn: $('#cNdcBtn'), ndcStatus: $('#cNdcStatus'),
  };
  const ui = {
    preview: $('#cPreview'), sheetInfo: $('#cSheetInfo'), notes: $('#cNotes'),
    stamp: $('#cStamp'), print: $('#cPrint'), clear: $('#cClear'), status: $('#cStatus'),
  };
  const s = {
    printer: $('#sPrinter'), refresh: $('#sRefresh'), printerHint: $('#sPrinterHint'),
    initials: $('#sInitials'), org: $('#sOrg'), cut: $('#sCut'),
    test: $('#sTest'), status: $('#sStatus'),
  };

  const KEY = {
    printer: 'paper_printer', initials: 'paper_initials',
    org: 'paper_org', cut: 'paper_cutline', tab: 'paper_tab',
  };

  // ---- Settings -----------------------------------------------------------

  const settings = {
    printer: localStorage.getItem(KEY.printer) || '',
    initials: localStorage.getItem(KEY.initials) || '',
    org: localStorage.getItem(KEY.org) || '',
    cut: localStorage.getItem(KEY.cut) !== 'off',
  };

  s.initials.value = settings.initials;
  s.org.value = settings.org;
  s.cut.checked = settings.cut;
  f.initials.value = settings.initials;

  function saveSetting(key, value) {
    settings[key] = value;
    localStorage.setItem(KEY[key], value === true ? 'on' : value === false ? 'off' : value);
  }

  /** The printers this machine has, with the saved one selected. */
  let printers = [];
  let printersError = '';

  async function loadPrinters() {
    if (!PaperPrint.isNative) {
      printers = [];
      s.printer.innerHTML = '<option value="">Browser print dialog</option>';
      s.printer.disabled = true;
      s.printerHint.textContent =
        'Running in a browser, so printing goes through the browser’s own print dialog. ' +
        'In the installed app you can pick a printer here and printing is one click.';
      renderSheetInfo();
      return;
    }
    s.printer.disabled = true;
    s.printer.innerHTML = '<option>Loading…</option>';
    try {
      printers = await PaperPrint.listPrinters();
      printersError = '';
    } catch (e) {
      printers = [];
      printersError = e.message;
    }

    // Nothing saved yet? Start on whatever this machine prints to by default.
    if (!settings.printer) {
      const def = printers.find((p) => p.isDefault);
      if (def) saveSetting('printer', def.name);
    }

    const opts = ['<option value="">Ask me every time (system print dialog)</option>'];
    for (const p of printers) {
      const sel = p.name === settings.printer ? ' selected' : '';
      const tag = p.isDefault ? ' — system default' : '';
      opts.push(`<option value="${escAttr(p.name)}"${sel}>${escText(p.label + tag)}</option>`);
    }
    // A printer that has since been unplugged or renamed shouldn't silently
    // become "ask me every time".
    const missing = settings.printer && !printers.some((p) => p.name === settings.printer);
    if (missing) {
      opts.push(`<option value="${escAttr(settings.printer)}" selected>${escText(settings.printer)} — not found</option>`);
    }
    s.printer.innerHTML = opts.join('');
    s.printer.disabled = false;

    if (printersError) {
      s.printerHint.textContent = `The printer list couldn’t be read (${printersError}).`;
    } else if (missing) {
      s.printerHint.textContent =
        `“${settings.printer}” isn’t on this computer any more. Pick another one.`;
    } else if (!printers.length) {
      s.printerHint.textContent = 'No printers are installed on this computer.';
    } else if (settings.printer) {
      s.printerHint.textContent = 'Forms print straight to this printer — no dialog.';
    } else {
      s.printerHint.textContent = 'The system print dialog opens each time so you can choose.';
    }
    renderSheetInfo();
  }

  const escText = (v) => String(v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const escAttr = (v) => escText(v).replace(/"/g, '&quot;');

  /** The printer's friendly name, for status lines. */
  function printerLabel() {
    const hit = printers.find((p) => p.name === settings.printer);
    return hit ? hit.label : settings.printer;
  }

  // ---- The call on the form ----------------------------------------------

  const val = (el) => el.value.trim();

  function data() {
    return {
      patient: val(f.patient), dob: val(f.dob),
      drug: val(f.drug), qty: val(f.qty), refills: val(f.refills), sig: val(f.sig),
      prescriber: val(f.prescriber), npi: val(f.npi),
      caller: val(f.caller), phone: val(f.phone),
      initials: val(f.initials).toUpperCase(),
      org: settings.org.trim(),
    };
  }

  /** The things a finished slip should never be missing. */
  const REQUIRED = ['patient', 'drug', 'qty', 'prescriber', 'caller', 'phone', 'initials'];
  const REQUIRED_NAME = {
    patient: 'The patient’s name', drug: 'The drug', qty: 'The quantity',
    prescriber: 'The prescriber', caller: 'Who called it in',
    phone: 'The call-back number', initials: 'The initials box',
  };

  /** What is missing, worst first. `tone: 'err'` blocks nothing but is asked about. */
  function problems(d) {
    const out = [];
    const missing = REQUIRED.filter((k) => !d[k]).map((k) => REQUIRED_NAME[k]);
    for (const m of missing) out.push({ text: `${m} is blank — it prints as a line to write on.`, tone: 'err' });
    if (!d.sig) out.push({ text: 'No directions (sig).', tone: 'warn' });
    if (!d.dob) out.push({ text: 'No date of birth.', tone: 'warn' });
    if (!d.refills) out.push({ text: 'No refill count.', tone: 'warn' });
    if (!d.npi) out.push({ text: 'No NPI or DEA number for the prescriber.', tone: 'warn' });
    return out;
  }

  // ---- Preview ------------------------------------------------------------
  // The iframe holds the real printed document. After the first load we only
  // swap the slip's markup, so nothing flickers as you type.

  let frameReady = false;
  let pending = null;

  ui.preview.addEventListener('load', () => {
    frameReady = true;
    if (pending) { paint(pending); pending = null; }
  });
  ui.preview.srcdoc = CallInForm.previewDoc(data(), { at: new Date(), cutLine: settings.cut });

  function paint(html) {
    const doc = ui.preview.contentDocument;
    if (!doc || !doc.body) return;
    doc.body.innerHTML = html;
  }

  // The slip is rendered at its true size (816 x 528 css px = 8.5" x 5.5")
  // and scaled down to whatever room the column has, so the preview is the
  // printout at a smaller size rather than a different layout.
  const sheetBox = ui.preview.parentElement;
  function fitPreview() {
    const w = sheetBox.clientWidth;
    if (w) ui.preview.style.transform = `scale(${w / 816})`;
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(fitPreview).observe(sheetBox);
  fitPreview();

  let queued = false;
  function render() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; draw(); });
  }

  let shownStamp = '';

  function draw() {
    const d = data();
    const at = new Date();
    const t = CallInForm.stamp(at);
    shownStamp = `${t.date} ${t.time}`;
    ui.stamp.textContent = `${t.date} at ${t.time}`;

    const html = CallInForm.sheet(d, { at, cutLine: settings.cut });
    if (frameReady) paint(html); else pending = html;
    fitPreview();

    const list = problems(d);
    ui.notes.replaceChildren(...list.map((n) => {
      const li = document.createElement('li');
      li.className = `tone-${n.tone}`;
      li.textContent = n.text;
      return li;
    }));

    renderSheetInfo();
  }

  function renderSheetInfo() {
    const copies = clampCopies(f.copies.value);
    const where = !PaperPrint.isNative
      ? 'the browser print dialog'
      : settings.printer ? `“${printerLabel()}”` : 'the printer you pick in the dialog';
    ui.sheetInfo.textContent =
      `8.5" × 5.5" — the top half of a Letter sheet; the bottom half comes out blank. ` +
      `${copies === 1 ? 'One page' : `${copies} pages`} to ${where}.`;
  }

  const clampCopies = (v) => Math.max(1, Math.min(20, Math.floor(Number(v) || 1)));

  // Keep the printed time honest while the form sits open during a long call.
  setInterval(() => {
    const t = CallInForm.stamp(new Date());
    if (`${t.date} ${t.time}` !== shownStamp) render();
  }, 10000);

  // ---- Printing -----------------------------------------------------------

  let printing = false;

  function showStatus(el, ok, msg) {
    el.className = `status show ${ok ? 'ok' : 'err'}`;
    el.textContent = msg;
  }

  async function send(doc, statusEl, what) {
    const res = await PaperPrint.printDoc(doc, { deviceName: settings.printer });
    if (res && res.ok) {
      showStatus(statusEl, true, `✓ ${what} ${res.message || ''}`.trim());
      return true;
    }
    if (res && res.cancelled) {
      showStatus(statusEl, false, '✗ Printing was cancelled.');
      return false;
    }
    showStatus(statusEl, false, `✗ ${(res && (res.message || res.error)) || 'The form could not be printed.'}`);
    return false;
  }

  async function print() {
    if (printing) return;
    const d = data();
    const list = problems(d);
    const blocking = list.filter((n) => n.tone === 'err');

    // Everything blank is almost certainly a slip of the finger, not a blank
    // form on purpose — but a blank form on purpose is legitimate, so ask.
    if (blocking.length && !(await askConfirm(
      blocking.length === REQUIRED.length ? 'Print a blank call-in form?' : 'Print this form anyway?',
      { ok: 'Print anyway', detail: list.map((n) => n.text) },
    ))) return;

    printing = true;
    ui.print.disabled = true;
    const label = ui.print.textContent;
    ui.print.textContent = 'Printing…';
    try {
      const copies = clampCopies(f.copies.value);
      const doc = CallInForm.doc(d, { at: new Date(), copies, cutLine: settings.cut });
      await send(doc, ui.status, `Printed ${copies === 1 ? 'the form' : `${copies} copies`}.`);
    } catch (e) {
      showStatus(ui.status, false, `✗ ${e.message}`);
    } finally {
      printing = false;
      ui.print.disabled = false;
      ui.print.textContent = label;
      render();
    }
  }

  async function printTest() {
    s.test.disabled = true;
    const label = s.test.textContent;
    s.test.textContent = 'Printing…';
    try {
      const doc = CallInForm.doc({
        patient: 'Test, Patient A.', dob: '01/01/1970',
        drug: 'Amoxicillin 500 mg capsule', qty: '30', refills: '1',
        sig: 'Take 1 capsule by mouth three times daily for 10 days',
        prescriber: 'Dr. Test Prescriber', npi: '1234567890',
        caller: 'Sample Office', phone: '(555) 555-0100',
        initials: (settings.initials || 'XX').toUpperCase(),
        org: settings.org.trim(),
      }, { at: new Date(), copies: 1, cutLine: settings.cut });
      await send(doc, s.status, 'Printed a test form.');
    } catch (e) {
      showStatus(s.status, false, `✗ ${e.message}`);
    } finally {
      s.test.disabled = false;
      s.test.textContent = label;
    }
  }

  // ---- New call -----------------------------------------------------------

  async function newCall() {
    const touched = [f.patient, f.dob, f.drug, f.qty, f.refills, f.sig,
      f.prescriber, f.npi, f.caller, f.phone].some((el) => el.value.trim());
    if (touched && !(await askConfirm('Clear this call and start a new one?', { ok: 'Clear' }))) return;
    for (const el of [f.patient, f.dob, f.drug, f.qty, f.refills, f.sig,
      f.prescriber, f.npi, f.caller, f.phone]) el.value = '';
    drugUi.ndc.value = '';
    ndcNote('');
    closeSuggest();
    f.initials.value = settings.initials;   // your own initials stay put
    delete f.initials.dataset.typed;        // …and follow Settings again
    f.copies.value = '1';
    ui.status.className = 'status';
    render();
    f.patient.focus();
  }

  // ---- Small typing courtesies -------------------------------------------

  /** 5551234567 → (555) 123-4567. Anything else is left exactly as typed. */
  function tidyPhone(v) {
    const digits = v.replace(/\D/g, '');
    if (/[a-z]/i.test(v)) return v;
    if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    if (digits.length === 11 && digits[0] === '1') {
      return `1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    }
    return v;
  }

  /*
   * Dates get typed every way there is — "03 31 03", "3-31-03", "03312003",
   * "3/31/2003". Slashes go in as you type, and on leaving the box the parts
   * are padded and a two-digit year is opened out.
   */

  /**
   * Slashes in, as the digits arrive. Nothing is padded or guessed yet.
   *
   * Digits are poured into month / day / year and overflow into the next part
   * rather than being dropped — otherwise the slash this function inserts
   * after "0411" would cap the day at two digits and swallow the year as the
   * rest of "04111958" is typed. A separator the user typed themselves still
   * ends a part early, so "3-31-03" keeps its one-digit month.
   */
  const DATE_CAPS = [2, 2, 4];

  function liveDate(raw) {
    const groups = raw.match(/\d+/g) || [];
    if (!groups.length) return '';

    const parts = [];
    let carry = '';
    for (let i = 0; i < groups.length && parts.length < 3; i++) {
      let g = carry + groups[i];
      carry = '';
      const cap = DATE_CAPS[parts.length];
      if (g.length > cap) { carry = g.slice(cap); g = g.slice(0, cap); }
      parts.push(g);
    }
    while (carry && parts.length < 3) {
      const cap = DATE_CAPS[parts.length];
      parts.push(carry.slice(0, cap));
      carry = carry.slice(cap);
    }

    let out = parts.join('/');
    // A separator just typed means "next part" — keep the slash showing.
    if (/\D$/.test(raw) && parts.length < 3 && !out.endsWith('/')) out += '/';
    return out;
  }

  /**
   * "3/31/03" → "03/31/2003" when the box is left. A two-digit year at or
   * below this year is read as 2000s, above it as 1900s — so 03 is 2003 and
   * 58 is 1958. Anything that isn't three sane parts is left exactly as typed.
   */
  function tidyDate(v) {
    if (/[a-z]/i.test(v)) return v;
    const g = v.match(/\d+/g) || [];
    if (g.length !== 3) return v;
    const [m, d, y] = g;
    if (m.length > 2 || d.length > 2 || (y.length !== 2 && y.length !== 4)) return v;
    if (+m < 1 || +m > 12 || +d < 1 || +d > 31) return v;
    let year = y;
    if (y.length === 2) {
      const pivot = new Date().getFullYear() % 100;
      year = String(+y <= pivot ? 2000 + +y : 1900 + +y);
    }
    return `${m.padStart(2, '0')}/${d.padStart(2, '0')}/${year}`;
  }

  // ---- Finding the drug ---------------------------------------------------
  /*
   * Two ways in, because a call gives you one or the other.
   *
   * The office says a name: DrugSearch matches it against a list held in
   * memory, so options appear on the second keystroke with no network in the
   * way — and it forgives the spelling, because whoever is typing is also
   * listening. Few drugs match → its strengths are the list, because that is
   * the choice left. Many match → one row each, and picking one narrows to
   * its strengths.
   *
   * They read out an NDC instead: that goes to the FDA directory through the
   * same NDC module the Bottle Label tab uses, and fills the drug line (and
   * the quantity, if the package says one) from what comes back.
   */

  let matches = [];
  let active = -1;
  let ignoreNextInput = false;   // set when we filled the box ourselves

  function closeSuggest() {
    matches = [];
    active = -1;
    drugUi.list.hidden = true;
    drugUi.list.replaceChildren();
    f.drug.setAttribute('aria-expanded', 'false');
    f.drug.removeAttribute('aria-activedescendant');
  }

  function openSuggest() {
    const q = f.drug.value;
    matches = DrugSearch.suggest(q);
    if (!matches.length) { closeSuggest(); return; }
    active = -1;
    drugUi.list.replaceChildren(...matches.map((m, i) => {
      const li = document.createElement('li');
      li.id = `cDrugOpt${i}`;
      li.className = 'suggest-item';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      const main = document.createElement('span');
      main.className = 'si-name';
      main.textContent = m.text;
      li.append(main);
      // The other name it gets called by, so a brand-name call still lands.
      if (m.sub && !new RegExp(`\\b${m.sub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(m.text)) {
        const sub = document.createElement('span');
        sub.className = 'si-sub';
        sub.textContent = m.sub;
        li.append(sub);
      }
      // pointerdown, not click: it beats the input's blur.
      li.addEventListener('pointerdown', (e) => { e.preventDefault(); accept(i); });
      li.addEventListener('pointerenter', () => highlight(i));
      return li;
    }));
    drugUi.list.hidden = false;
    f.drug.setAttribute('aria-expanded', 'true');
  }

  function highlight(i) {
    active = i;
    [...drugUi.list.children].forEach((li, n) => {
      const on = n === i;
      li.classList.toggle('on', on);
      li.setAttribute('aria-selected', String(on));
      if (on) li.scrollIntoView({ block: 'nearest' });
    });
    if (i >= 0) f.drug.setAttribute('aria-activedescendant', `cDrugOpt${i}`);
    else f.drug.removeAttribute('aria-activedescendant');
  }

  function accept(i) {
    const m = matches[i];
    if (!m) return;
    ignoreNextInput = true;
    f.drug.value = m.text;
    closeSuggest();
    render();
    // Picking a drug with no strength on it means the strength is still to
    // come, so stay put; a complete line moves on to the quantity.
    if (m.strength) f.qty.focus(); else f.drug.focus();
  }

  f.drug.addEventListener('input', () => {
    if (ignoreNextInput) { ignoreNextInput = false; return; }
    openSuggest();
  });
  f.drug.addEventListener('focus', () => { if (f.drug.value.trim()) openSuggest(); });
  f.drug.addEventListener('blur', () => setTimeout(closeSuggest, 0));
  f.drug.addEventListener('keydown', (e) => {
    if (drugUi.list.hidden) {
      if (e.key === 'ArrowDown' && f.drug.value.trim()) { e.preventDefault(); openSuggest(); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight((active + 1) % matches.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight((active - 1 + matches.length) % matches.length); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); accept(active); }
    else if (e.key === 'Escape') { e.preventDefault(); closeSuggest(); }
    else if (e.key === 'Tab' && active >= 0) { accept(active); }
  });

  // --- By NDC --------------------------------------------------------------

  let ndcRun = null;   // aborts the lookup still in flight

  function ndcNote(text, tone) {
    drugUi.ndcStatus.textContent = text;
    drugUi.ndcStatus.className = `lookup${tone ? ` tone-${tone}` : ''}`;
  }

  async function lookupNdc() {
    const raw = drugUi.ndc.value.trim();
    if (!raw) { ndcNote(''); return; }

    const parsed = NDC.resolve(raw);
    if (parsed.error) { ndcNote(parsed.error, 'err'); return; }
    if (!NDC.isSearchable(raw)) { ndcNote("That doesn't read as an NDC.", 'err'); return; }

    if (ndcRun) ndcRun.abort();
    ndcRun = new AbortController();
    const mine = ndcRun;
    drugUi.ndcBtn.disabled = true;
    ndcNote('Looking it up…');
    try {
      const res = await NDC.lookup(raw, mine.signal);
      if (mine !== ndcRun) return;           // a newer lookup took over
      if (res.status === 'error') {
        ndcNote('The FDA directory could not be reached — type the drug in instead.', 'warn');
        return;
      }
      if (res.status !== 'found') {
        ndcNote('No drug in the FDA directory has that NDC.', 'warn');
        return;
      }
      fillFromFacts(res.facts, parsed.display || raw);
    } catch (e) {
      if (mine === ndcRun) ndcNote(e.message, 'err');
    } finally {
      if (mine === ndcRun) { drugUi.ndcBtn.disabled = false; ndcRun = null; }
    }
  }

  /*
   * The FDA spells dosage forms out in full — "TABLET, FILM COATED". On a
   * call-in slip the coating is noise, but "extended release" is the
   * prescription, so qualifiers that change how the drug behaves are kept and
   * the merely cosmetic ones are dropped.
   */
  const FORM_KEEP = /release|chewable|disintegrating|sublingual|buccal|effervescent|orally/i;

  function tidyForm(raw) {
    const parts = String(raw || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
    if (!parts.length) return '';
    const base = parts[0];
    const kept = parts.slice(1).filter((q) => FORM_KEEP.test(q));
    return kept.length ? `${base}, ${kept.join(', ')}` : base;
  }

  /** What came back from the FDA, written onto the form. */
  function fillFromFacts(facts, shown) {
    const line = [facts.name, facts.strength, tidyForm(facts.dosageForm)]
      .map((p) => (p || '').trim()).filter(Boolean).join(' ');
    if (line) f.drug.value = line;

    const filled = [];
    if (line) filled.push('the drug');

    // The full package is a good guess at the quantity, never an override.
    const count = NDC.packageCount(facts.packageDescription);
    if (count && !f.qty.value.trim()) {
      f.qty.value = count.count;
      filled.push(`quantity ${count.label}`);
    }

    closeSuggest();
    render();
    const extra = facts.generic ? ` (${facts.generic})` : '';
    ndcNote(
      filled.length
        ? `${shown} — filled in ${filled.join(' and ')}.${extra}`
        : `${shown} found, but the entry had no drug name to use.`,
      filled.length ? 'ok' : 'warn',
    );
  }

  drugUi.ndcBtn.addEventListener('click', lookupNdc);
  drugUi.ndc.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    lookupNdc();
  });

  // ---- Events -------------------------------------------------------------

  for (const el of Object.values(f)) el.addEventListener('input', render);

  f.initials.addEventListener('input', () => {
    const pos = f.initials.selectionStart;
    f.initials.value = f.initials.value.toUpperCase();
    f.initials.setSelectionRange(pos, pos);
  });
  f.phone.addEventListener('blur', () => {
    const tidy = tidyPhone(f.phone.value.trim());
    if (tidy !== f.phone.value) { f.phone.value = tidy; render(); }
  });
  f.dob.addEventListener('input', () => {
    // Only reformat while typing forward; editing mid-string is left alone.
    if (f.dob.selectionStart !== f.dob.value.length) return;
    const live = liveDate(f.dob.value);
    if (live !== f.dob.value) {
      f.dob.value = live;
      f.dob.setSelectionRange(live.length, live.length);
    }
  });
  f.dob.addEventListener('blur', () => {
    const tidy = tidyDate(f.dob.value.trim());
    if (tidy !== f.dob.value) { f.dob.value = tidy; render(); }
  });

  ui.print.addEventListener('click', print);
  ui.clear.addEventListener('click', newCall);

  s.printer.addEventListener('change', () => {
    saveSetting('printer', s.printer.value);
    loadPrinters();
  });
  s.refresh.addEventListener('click', loadPrinters);
  s.initials.addEventListener('input', () => {
    const pos = s.initials.selectionStart;
    s.initials.value = s.initials.value.toUpperCase();
    s.initials.setSelectionRange(pos, pos);
    saveSetting('initials', s.initials.value.trim());
    // An untouched box on the form follows along; one you typed over doesn't.
    if (f.initials.dataset.typed !== '1') {
      f.initials.value = settings.initials;
      render();
    }
  });
  f.initials.addEventListener('input', () => { f.initials.dataset.typed = '1'; });
  s.org.addEventListener('input', () => { saveSetting('org', s.org.value); render(); });
  s.cut.addEventListener('change', () => { saveSetting('cut', s.cut.checked); render(); });
  s.test.addEventListener('click', printTest);

  // ---- Paper tabs ---------------------------------------------------------

  const ptabs = [...document.querySelectorAll('#paperTabs .ptab')];
  function showPaperTab(name) {
    if (!ptabs.some((t) => t.dataset.ptab === name)) name = ptabs[0].dataset.ptab;
    for (const t of ptabs) {
      const on = t.dataset.ptab === name;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(`panel-${t.dataset.ptab}`).hidden = !on;
    }
    localStorage.setItem(KEY.tab, name);
    if (name === 'callin') render();
  }
  ptabs.forEach((t, i) => {
    t.addEventListener('click', () => showPaperTab(t.dataset.ptab));
    t.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = ptabs[(i + (e.key === 'ArrowRight' ? 1 : ptabs.length - 1)) % ptabs.length];
      next.focus();
      showPaperTab(next.dataset.ptab);
    });
  });
  showPaperTab(localStorage.getItem(KEY.tab) || 'callin');

  document.addEventListener('modechange', (e) => { if (e.detail === 'paper') render(); });

  // Browsers restore what was typed into a form when the page is reloaded.
  // A call-in slip is the one thing that must not come back: start empty, so a
  // reload (or an app update restarting the window) never resurrects a patient.
  for (const el of [f.patient, f.dob, f.drug, f.qty, f.refills, f.sig,
    f.prescriber, f.npi, f.caller, f.phone]) el.value = '';
  drugUi.ndc.value = '';
  f.initials.value = settings.initials;
  f.copies.value = '1';

  loadPrinters();
  render();
})();
