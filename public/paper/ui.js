'use strict';
/*
 * The Phone Scripts side of the app: the Phone Script and Transfer tabs and
 * their shared Settings.
 *
 * Phone Script: someone from a prescriber's office is on the phone. You type
 * what they say, press Print, and a half-sheet comes out of the ordinary
 * office printer with the time it was taken and your initials on it.
 *
 * Transfer: another pharmacy is reading you a prescription to transfer in.
 * Same form, same drug search and printing, plus the transferring pharmacy,
 * its Rx number and the fill history. Both tabs are built by makeForm() below.
 *
 * What is saved and what is not
 * -----------------------------
 * Settings — the chosen printer, your initials, the pharmacy name, the cut
 * line — live in localStorage. The call itself never does: patient name, date
 * of birth, drug, prescriber and phone number are held in the form and in
 * nothing else, and go away when the form is cleared or the app is closed.
 *
 * Controlled substances
 * ---------------------
 * A Schedule II drug can't be taken over the phone at all: it has to come as
 * an e-script or a written prescription, so the form won't print one. A
 * CIII–CV can, but only with the prescriber's DEA number, and that number has
 * to pass the DEA's own check digit. A transferred CIII–CV also needs the
 * transferring pharmacy's DEA number, and can only be transferred once. The
 * schedule comes from the drug list (paper/drugs.js, from the FDA's NDC
 * directory) or, after an NDC lookup, from the FDA directly. These are
 * federal schedules.
 *
 * Uses from app.js: askConfirm(). Uses paper/form.js, paper/print.js and
 * paper/sig.js.
 */
(function () {
  const $ = (sel) => document.querySelector(sel);

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

  function saveSetting(key, value) {
    settings[key] = value;
    localStorage.setItem(KEY[key], value === true ? 'on' : value === false ? 'off' : value);
  }

  /** The printers this machine has, with the saved one selected. */
  let printers = [];
  let printersError = '';
  let forms = [];   // the Phone Script and Transfer tabs, once built

  const renderSheetInfo = () => forms.forEach((x) => x.renderSheetInfo());

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

  // ---- Controlled substances ---------------------------------------------

  const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];
  const FDA_SCHEDULE = { CI: 1, CII: 2, CIII: 3, CIV: 4, CV: 5 };

  /*
   * A DEA number is two letters and seven digits, the last a check digit:
   * add the 1st, 3rd and 5th digits, add twice the 2nd, 4th and 6th, and the
   * last digit of the total is the 7th. A misheard digit almost never passes.
   * (The second letter may be a 9 for some business registrants.)
   */
  function deaProblem(raw) {
    const dea = raw.replace(/[\s-]/g, '').toUpperCase();
    if (!/^[A-Z][A-Z9]\d{7}$/.test(dea)) return 'isn’t two letters and seven digits';
    const n = [...dea.slice(2)].map(Number);
    const sum = n[0] + n[2] + n[4] + 2 * (n[1] + n[3] + n[5]);
    if (sum % 10 !== n[6]) return 'fails the DEA check digit';
    return '';
  }

  const upperFirst = (t) => t.charAt(0).toUpperCase() + t.slice(1);

  // ---- The two kinds of form ---------------------------------------------
  /*
   * Everything that differs between a call-in and a transfer. Field keys map
   * to element ids by prefix: 'refills' on the Transfer tab is #tRefills.
   *
   *   fields   — the boxes holding the call (cleared on New, never saved)
   *   dates    — reformatted as a date as they're typed
   *   phones   — tidied to (555) 123-4567 on leaving
   *   deas     — DEA numbers checked against a controlled drug, with their names
   *   required — what a finished slip should never be missing
   *   more     — the warnings only this kind has
   */
  const CALLIN = {
    tab: 'callin', prefix: 'c', what: 'call',
    fields: ['patient', 'dob', 'drug', 'qty', 'refills', 'daw', 'sig', 'prescriber', 'npi', 'dea', 'caller', 'phone'],
    dates: ['dob'], phones: ['phone'],
    deas: [['dea', 'the prescriber’s DEA number']],
    readBack: 'Read it back to the office.',
    required: ['patient', 'drug', 'qty', 'prescriber', 'caller', 'phone', 'initials'],
    requiredName: {
      patient: 'The patient’s name', drug: 'The drug', qty: 'The quantity',
      prescriber: 'The prescriber', caller: 'Who called it in',
      phone: 'The call-back number', initials: 'The initials box',
    },
    blankTitle: 'Print a blank call-in form?',
    cii: (drug) => `${drug} is Schedule II. A CII can’t be taken over the phone — ` +
      'it has to come as an e-script or a written prescription. Ask the office to send it electronically.',
    stopTitle: (cii) => (cii ? 'A Schedule II can’t be called in' : 'This needs a valid DEA number'),
    more(d, hit, out) {
      if (!d.sig) out.push({ text: 'No directions (sig).', tone: 'warn' });
      if (!d.dob) out.push({ text: 'No date of birth.', tone: 'warn' });
      if (!d.refills) out.push({ text: 'No refill count.', tone: 'warn' });
      if (!d.daw) out.push({ text: 'DAW isn’t marked. Ask if substitution is allowed.', tone: 'warn' });
      if (!d.npi && !d.dea) out.push({ text: 'No NPI or DEA number for the prescriber.', tone: 'warn' });
    },
  };

  const TRANSFER = {
    tab: 'transfer', prefix: 't', what: 'transfer',
    fields: ['patient', 'dob', 'drug', 'qty', 'refills', 'sig', 'rxNum', 'written', 'firstFill', 'lastFill',
      'prescriber', 'npi', 'dea', 'pharmacy', 'pharmPhone', 'pharmAddr', 'pharmDea', 'pharmacist'],
    dates: ['dob', 'written', 'firstFill', 'lastFill'], phones: ['pharmPhone'],
    deas: [['dea', 'the prescriber’s DEA number'], ['pharmDea', 'the transferring pharmacy’s DEA number']],
    readBack: 'Read it back to the pharmacist.',
    required: ['patient', 'drug', 'qty', 'refills', 'prescriber', 'rxNum',
      'pharmacy', 'pharmPhone', 'pharmacist', 'initials'],
    requiredName: {
      patient: 'The patient’s name', drug: 'The drug', qty: 'The quantity',
      refills: 'Refills left', prescriber: 'The prescriber', rxNum: 'Their Rx number',
      pharmacy: 'The transferring pharmacy', pharmPhone: 'The pharmacy’s phone',
      pharmacist: 'The transferring pharmacist', initials: 'The initials box',
    },
    blankTitle: 'Print a blank transfer form?',
    cii: (drug) => `${drug} is Schedule II. A CII can’t be transferred over the phone — the only ` +
      'CII transfer allowed is a one-time electronic transfer of an unfilled e-script, pharmacy to pharmacy.',
    stopTitle: (cii) => (cii ? 'A Schedule II can’t be transferred by phone' : 'This needs valid DEA numbers'),
    more(d, hit, out) {
      if (/^(0+|none|no)$/i.test(d.refills)) {
        out.push({ text: 'Refills left is 0, so there’s nothing here to fill.', tone: 'err' });
      }
      // A controlled transfer has to record all of this (21 CFR 1306.25).
      const history = { pharmAddr: 'The pharmacy’s address', written: 'The date written',
        firstFill: 'The first fill date', lastFill: 'The last fill date' };
      if (hit && hit.schedule >= 3) {
        out.push({
          text: `A Schedule ${ROMAN[hit.schedule]} can be transferred only once, unless both pharmacies ` +
            'share a real-time online database. Check this isn’t one they received by transfer.',
          tone: 'warn',
        });
        for (const [k, name] of Object.entries(history)) {
          if (!d[k]) out.push({ text: `${name} is blank, and a controlled transfer has to record it.`, tone: 'err' });
        }
      } else {
        if (!d.written) out.push({ text: 'No date written.', tone: 'warn' });
        if (!d.firstFill || !d.lastFill) out.push({ text: 'The fill dates aren’t both filled in.', tone: 'warn' });
      }
      if (!d.sig) out.push({ text: 'No directions (sig).', tone: 'warn' });
      if (!d.dob) out.push({ text: 'No date of birth.', tone: 'warn' });
      if (!d.npi && !d.dea) out.push({ text: 'No NPI or DEA number for the prescriber.', tone: 'warn' });
    },
  };

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

  /*
   * The FDA spells dosage forms out in full — "TABLET, FILM COATED". On a
   * phone slip the coating is noise, but "extended release" is the
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

  // ---- Printing -----------------------------------------------------------

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

  const clampCopies = (v) => Math.max(1, Math.min(20, Math.floor(Number(v) || 1)));

  // ---- One form tab -------------------------------------------------------

  function makeForm(K) {
    const byId = (name) => document.getElementById(K.prefix + name);
    const idOf = (key) => key.charAt(0).toUpperCase() + key.slice(1);

    const f = {};
    for (const k of K.fields) f[k] = byId(idOf(k));
    f.initials = byId('Initials');
    f.copies = byId('Copies');
    const callFields = K.fields.map((k) => f[k]);
    const upper = [...K.deas.map(([k]) => k), 'initials'];

    const deaNeed = K.deas.map(([k]) => [k, byId(`${idOf(k)}Need`)]);
    const drugUi = {
      list: byId('DrugList'), ndc: byId('Ndc'), ndcBtn: byId('NdcBtn'), ndcStatus: byId('NdcStatus'),
    };
    const ui = {
      preview: byId('Preview'), sheetInfo: byId('SheetInfo'), notes: byId('Notes'),
      stamp: byId('Stamp'), print: byId('Print'), clear: byId('Clear'), status: byId('Status'),
    };

    f.initials.value = settings.initials;

    // ---- The call on the form --------------------------------------------

    const val = (el) => el.value.trim();

    function data() {
      const d = { kind: K.tab };
      for (const k of K.fields) d[k] = upper.includes(k) ? val(f[k]).toUpperCase() : val(f[k]);
      d.initials = val(f.initials).toUpperCase();
      d.org = settings.org.trim();
      d.schedule = (controlled() || {}).schedule || 0;
      return d;
    }

    /*
     * The schedule of whatever is on the drug line. A row picked from the list
     * or an NDC lookup knows exactly what it is, so that answer is kept for as
     * long as the line is left as it was filled; anything typed is read by
     * DrugSearch.schedule().
     */
    let known = null;   // { text, hit } — the line as we filled it, and its schedule

    function controlled() {
      const text = f.drug.value.trim();
      if (!text) return null;
      if (known && known.text === text) return known.hit;
      return DrugSearch.schedule(text);
    }

    /*
     * What is wrong or missing, worst first.
     *   stop — won't print: a CII, or a CIII–CV without good DEA numbers
     *   err  — prints, but is asked about first
     *   warn — just noted
     */
    function problems(d) {
      const out = [];
      const hit = controlled();
      if (hit && hit.schedule <= 2) {
        out.push({ text: K.cii(hit.drug), tone: 'stop', focus: f.drug });
      } else if (hit) {
        const sched = `Schedule ${ROMAN[hit.schedule]}`;
        for (const [k, name] of K.deas) {
          const bad = d[k] ? deaProblem(d[k]) : '';
          if (!d[k]) {
            out.push({ text: `${hit.drug} is ${sched}, so ${name} is required.`, tone: 'stop', focus: f[k] });
          } else if (bad) {
            out.push({ text: `${hit.drug} is ${sched}, and ${name} ${bad}. ${K.readBack}`, tone: 'stop', focus: f[k] });
          }
        }
      } else {
        for (const [k, name] of K.deas) {
          const bad = d[k] ? deaProblem(d[k]) : '';
          if (bad) out.push({ text: `${upperFirst(name)} ${bad}.`, tone: 'warn' });
        }
      }
      const missing = K.required.filter((k) => !d[k]).map((k) => K.requiredName[k]);
      for (const m of missing) out.push({ text: `${m} is blank — it prints as a line to write on.`, tone: 'err' });
      K.more(d, hit, out);
      return out;
    }

    // ---- Preview ----------------------------------------------------------
    // The iframe holds the real printed document. After the first load we
    // only swap the slip's markup, so nothing flickers as you type.

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
      const needDea = d.schedule >= 3;
      for (const [, el] of deaNeed) {
        el.textContent = needDea ? `— required, Schedule ${ROMAN[d.schedule]}` : '— for controlled';
        el.className = needDea ? 'opt tone-err' : 'opt';
      }
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

    // Keep the printed time honest while the form sits open during a long call.
    setInterval(() => {
      const t = CallInForm.stamp(new Date());
      if (`${t.date} ${t.time}` !== shownStamp) render();
    }, 10000);

    // ---- Printing ---------------------------------------------------------

    let printing = false;

    async function print() {
      if (printing) return;
      const d = data();
      const list = problems(d);

      const stops = list.filter((n) => n.tone === 'stop');
      if (stops.length) {
        await askConfirm(
          K.stopTitle(d.schedule <= 2),
          { ok: 'OK', cancel: null, detail: stops.map((n) => n.text) },
        );
        stops[0].focus.focus();
        return;
      }

      const blocking = list.filter((n) => n.tone === 'err');

      // Everything blank is almost certainly a slip of the finger, not a
      // blank form on purpose — but a blank form on purpose is legitimate, so ask.
      const allBlank = K.required.every((k) => !d[k]);
      if (blocking.length && !(await askConfirm(
        allBlank ? K.blankTitle : 'Print this form anyway?',
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

    // ---- New call ---------------------------------------------------------

    function clearCall() {
      for (const el of callFields) el.value = '';
      drugUi.ndc.value = '';
      known = null;
    }

    async function newCall() {
      const touched = callFields.some((el) => el.value.trim());
      if (touched && !(await askConfirm(`Clear this ${K.what} and start a new one?`, { ok: 'Clear' }))) return;
      clearCall();
      ndcNote('');
      closeSuggest();
      f.initials.value = settings.initials;   // your own initials stay put
      delete f.initials.dataset.typed;        // …and follow Settings again
      f.copies.value = '1';
      ui.status.className = 'status';
      render();
      f.patient.focus();
    }

    // ---- Finding the drug -------------------------------------------------
    /*
     * Two ways in, because a call gives you one or the other.
     *
     * The caller says a name: DrugSearch matches it against a list held in
     * memory, so options appear on the second keystroke with no network in
     * the way — and it forgives the spelling, because whoever is typing is
     * also listening. Few drugs match → its strengths are the list, because
     * that is the choice left. Many match → one row each, and picking one
     * narrows to its strengths.
     *
     * They read out an NDC instead: that goes to the FDA directory through
     * the same NDC module the Bottle Label tab uses, and fills the drug line
     * (and the quantity, if the package says one) from what comes back.
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
        li.id = `${K.prefix}DrugOpt${i}`;
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
      if (i >= 0) f.drug.setAttribute('aria-activedescendant', `${K.prefix}DrugOpt${i}`);
      else f.drug.removeAttribute('aria-activedescendant');
    }

    function accept(i) {
      const m = matches[i];
      if (!m) return;
      ignoreNextInput = true;
      f.drug.value = m.text;
      known = { text: m.text, hit: m.drug.c ? { schedule: m.drug.c, drug: m.drug.g } : null };
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

    // --- By NDC ------------------------------------------------------------

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

    /** What came back from the FDA, written onto the form. */
    function fillFromFacts(facts, shown) {
      const line = [facts.name, facts.strength, tidyForm(facts.dosageForm)]
        .map((p) => (p || '').trim()).filter(Boolean).join(' ');
      if (line) {
        f.drug.value = line;
        // The FDA lists the schedule on the product itself — better than a guess.
        const c = FDA_SCHEDULE[facts.schedule] || 0;
        known = { text: line, hit: c ? { schedule: c, drug: facts.generic || facts.name || line } : null };
      }

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

    // ---- Events -----------------------------------------------------------

    for (const el of Object.values(f)) el.addEventListener('input', render);

    for (const k of upper) {
      const el = f[k];
      el.addEventListener('input', () => {
        const pos = el.selectionStart;
        el.value = el.value.toUpperCase();
        el.setSelectionRange(pos, pos);
      });
    }
    for (const k of K.phones) {
      const el = f[k];
      el.addEventListener('blur', () => {
        const tidy = tidyPhone(el.value.trim());
        if (tidy !== el.value) { el.value = tidy; render(); }
      });
    }
    for (const k of K.dates) {
      const el = f[k];
      el.addEventListener('input', () => {
        // Only reformat while typing forward; editing mid-string is left alone.
        if (el.selectionStart !== el.value.length) return;
        const live = liveDate(el.value);
        if (live !== el.value) {
          el.value = live;
          el.setSelectionRange(live.length, live.length);
        }
      });
      el.addEventListener('blur', () => {
        const tidy = tidyDate(el.value.trim());
        if (tidy !== el.value) { el.value = tidy; render(); }
      });
    }
    Sig.attach(f.sig, render);

    ui.print.addEventListener('click', print);
    ui.clear.addEventListener('click', newCall);
    f.initials.addEventListener('input', () => { f.initials.dataset.typed = '1'; });

    /** Settings' initials changed: an untouched box follows; one you typed over doesn't. */
    function followInitials() {
      if (f.initials.dataset.typed === '1') return;
      f.initials.value = settings.initials;
      render();
    }

    // Browsers restore what was typed into a form when the page is reloaded.
    // A phone slip is the one thing that must not come back: start empty, so a
    // reload (or an app update restarting the window) never resurrects a patient.
    clearCall();
    f.initials.value = settings.initials;
    f.copies.value = '1';

    return { tab: K.tab, render, renderSheetInfo, followInitials };
  }

  forms = [makeForm(CALLIN), makeForm(TRANSFER)];

  async function printTest() {
    s.test.disabled = true;
    const label = s.test.textContent;
    s.test.textContent = 'Printing…';
    try {
      const doc = CallInForm.doc({
        patient: 'Test, Patient A.', dob: '01/01/1970',
        drug: 'Amoxicillin 500 mg capsule', qty: '30', refills: '1', daw: '0',
        sig: 'Take 1 capsule by mouth three times daily for 10 days',
        prescriber: 'Dr. Test Prescriber', npi: '1234567890', dea: '',
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

  // ---- Settings events ----------------------------------------------------

  const renderAll = () => forms.forEach((x) => x.render());

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
    forms.forEach((x) => x.followInitials());
  });
  s.org.addEventListener('input', () => { saveSetting('org', s.org.value); renderAll(); });
  s.cut.addEventListener('change', () => { saveSetting('cut', s.cut.checked); renderAll(); });
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
    const form = forms.find((x) => x.tab === name);
    if (form) form.render();
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

  document.addEventListener('modechange', (e) => { if (e.detail === 'paper') renderAll(); });

  loadPrinters();
  renderAll();
})();
