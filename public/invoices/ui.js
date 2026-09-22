'use strict';
/*
 * The Invoices tab: the gate, the editor, the history, and the print job.
 *
 * The paper is the editor. The sheet is rendered from the model by sheet.js
 * and dropped into the page; one delegated listener reads `data-bind` off
 * whatever was typed in and writes it back. Derived spots — a line's amount,
 * the totals, a Schedule II quantity in words, the split note — are patched in
 * place on every keystroke. The whole sheet is only rebuilt when its SHAPE
 * changes (a line added or removed, a shop picked, a pharmacy chosen from the
 * directory), and the caret is put back where it was when that happens.
 *
 * Printing does not go through window.print(). The sheet on screen is an
 * editor full of inputs; what goes to the printer is a second, read-only
 * rendering of the same model, built as a standalone document and handed to
 * Chromium through the same paper-printing bridge the call-in form uses. So
 * nothing has to be un-styled or stripped of inputs at print time, and the
 * printout cannot drift from the screen.
 *
 * Order of operations on Save & Print is deliberate and must stay this way:
 * claim a number, write the record, THEN print. Nothing leaves the printer
 * that isn't already on file.
 *
 * Uses from app.js: askConfirm(). Uses invoices/{model,store,sheet,fonts}.js,
 * bottle/ndc.js for the FDA lookup, and paper/print.js for the printer.
 */
(function () {
  const $ = (sel) => document.querySelector(sel);
  const I = Invoicing;
  const S = InvoiceStore;
  const H = InvoiceSheetHtml;

  const el = {
    gate: $('#invGate'), checking: $('#invChecking'),
    signIn: $('#invSignInForm'), email: $('#invEmail'), password: $('#invPassword'),
    signInBtn: $('#invSignInBtn'), resetBtn: $('#invResetBtn'), signInStatus: $('#invSignInStatus'),
    noAccess: $('#invNoAccess'), noAccessEmail: $('#invNoAccessEmail'), noAccessOut: $('#invNoAccessOut'),

    app: $('#invApp'), emailLabel: $('#invEmailLabel'), signOut: $('#invSignOut'),
    docType: $('#invDocType'), printer: $('#invPrinter'),
    twoCopies: $('#invTwoCopies'), ndcLookup: $('#invNdcLookup'),
    total: $('#invTotal'), status: $('#invStatus'), notice: $('#invNotice'),
    historyBtn: $('#invHistoryBtn'), clearBtn: $('#invClearBtn'), printBtn: $('#invPrintBtn'),
    sheet: $('#invSheet'), summary: $('#invSummary'),

    histModal: $('#invHistoryModal'), histList: $('#invHistoryList'),
    histClose: $('#invHistoryClose'), search: $('#invSearch'),
  };

  /* The chosen paper printer is one setting for the whole app, shared with the
     call-in form's Settings tab (paper/ui.js writes the same key). An invoice
     and a call-in slip come off the same machine; two pickers that disagreed
     would only ever be a bug. */
  const PRINTER_KEY = 'paper_printer';

  const state = {
    ready: false,
    user: null,
    uid: '',
    email: '',
    role: null,
    invoice: null,
    /** Set once the invoice has been written to Firestore — it stops being editable. */
    committed: false,
    saving: false,
    clients: [],
    /** The directory entry the block on the sheet came from, if any. */
    clientId: null,
    clientBusy: false,
    nextNumber: null,
    /** Which suggestion in the pharmacy dropdown is highlighted. */
    highlight: 0,
    pickerOpen: false,
    invoices: [],
    invoicesLoaded: false,
    invoicesError: '',
    openRecord: null,
    started: false,
  };

  /* The blank invoice exists before the auth subscription below, not after it.
     watchAuth normally calls back asynchronously, but it answers SYNCHRONOUSLY
     when Firebase failed to start — and that path reaches showGate() while the
     rest of this file has not run yet. */
  state.invoice = freshInvoice();

  let unsubClients = null, unsubCounter = null, unsubInvoices = null;

  // ===========================================================================
  // The gate
  // ===========================================================================

  function showGate() {
    const signedIn = !!state.user;
    const inside = signedIn && !!state.role;

    el.gate.hidden = inside;
    el.app.hidden = !inside;
    el.checking.hidden = state.ready;
    el.signIn.hidden = !state.ready || signedIn;
    el.noAccess.hidden = !state.ready || !signedIn || inside;

    if (signedIn) {
      el.noAccessEmail.textContent = state.email;
      el.emailLabel.textContent = state.email;
    }
    if (inside && !state.started) start();
    if (!inside && state.started) stop();
  }

  S.watchAuth((next) => {
    state.ready = next.ready;
    state.user = next.user;
    state.uid = next.uid || '';
    state.email = next.email || '';
    state.role = next.role;
    if (next.error) setStatus(el.signInStatus, false, `Firebase didn't start: ${next.error}`);
    showGate();
  });

  el.signIn.addEventListener('submit', async (e) => {
    e.preventDefault();
    el.signInBtn.disabled = true;
    const label = el.signInBtn.textContent;
    el.signInBtn.textContent = 'Signing in…';
    try {
      await S.signIn(el.email.value, el.password.value);
      el.password.value = '';
      el.signInStatus.className = 'status';
    } catch (err) {
      setStatus(el.signInStatus, false, S.readableAuthError(err));
    } finally {
      el.signInBtn.disabled = false;
      el.signInBtn.textContent = label;
    }
  });

  el.resetBtn.addEventListener('click', async () => {
    const address = el.email.value.trim();
    if (!address) {
      setStatus(el.signInStatus, false, 'Type your email address first.');
      el.email.focus();
      return;
    }
    try {
      await S.sendReset(address);
      /* Said the same way whether or not the address exists — this project has
         email enumeration protection on, and the screen shouldn't undo it. */
      setStatus(el.signInStatus, true, `If ${address} has an account, a reset link is on its way.`);
    } catch (err) {
      setStatus(el.signInStatus, false, S.readableAuthError(err));
    }
  });

  const signOutNow = () => S.signOut().catch(() => {});
  el.noAccessOut.addEventListener('click', signOutNow);
  el.signOut.addEventListener('click', signOutNow);

  // ===========================================================================
  // Starting and stopping
  // ===========================================================================
  //
  // Firestore listeners are only ever open while someone with a role is
  // looking at the tab. Signing out tears them down rather than leaving them
  // to fail against the rules.

  function start() {
    state.started = true;

    unsubClients = S.watchClients(
      (clients) => { state.clients = clients; if (state.pickerOpen) renderPicker(); },
      (msg) => notice(true, `Couldn't load the pharmacy directory — ${H.esc(msg)}`),
    );
    unsubCounter = S.watchNextNumber((next) => {
      state.nextNumber = next;
      if (!state.committed) refresh();
    });
    unsubInvoices = S.watchInvoices(
      (list) => { state.invoices = list; state.invoicesLoaded = true; renderHistory(); },
      (msg) => { state.invoicesError = msg; state.invoicesLoaded = true; renderHistory(); },
    );

    loadPrinters();
    /* The directory's "save to directory" affordance and the issued number
       both depend on what those listeners bring back, so the paper is redrawn
       once they're attached. It was already on screen — see the bottom of
       this file — so this is a correction, not the first paint. */
    renderSheet();
  }

  function stop() {
    state.started = false;
    [unsubClients, unsubCounter, unsubInvoices].forEach((f) => { try { f && f(); } catch {} });
    unsubClients = unsubCounter = unsubInvoices = null;
    state.invoices = [];
    state.invoicesLoaded = false;
    state.invoicesError = '';
    state.clients = [];
    state.nextNumber = null;
    /* Signing out clears the sheet. A half-written slip carries a receiving
       pharmacy's DEA number and what is being transferred to them; leaving it
       on screen for whoever signs in next would be exactly the leftover this
       tool exists to avoid — the same reason the call-in form starts empty. */
    startNew();
  }

  /* A new slip starts on today's date. The manual leaves the field empty and
     substitutes today at render time; filling it in is the same thing to the
     pharmacist and means the date on the paper can't quietly change under them
     if the app is left open past midnight. */
  function freshInvoice(from) {
    const inv = from
      // A duplicate keeps the content and gives up the old number.
      ? Object.assign(I.reviveInvoice(from), { invoiceNumber: '' })
      : I.blankInvoice();
    if (!inv.date) inv.date = I.todayLocalIso();
    return inv;
  }

  // ===========================================================================
  // The sheet
  // ===========================================================================

  /** The directory's state, as the sheet renderer wants it. */
  function directory() {
    const current = state.clients.find((c) => c.id === state.clientId) || null;
    return {
      status: !current ? 'none' : S.matchesClient(state.invoice.to, current) ? 'saved' : 'changed',
      busy: state.clientBusy,
    };
  }

  /** What the sheet shows for a number it hasn't been issued yet. */
  const shownNumber = () =>
    state.invoice.invoiceNumber || (state.nextNumber != null ? String(state.nextNumber) : '—');

  /** Rebuild the whole sheet, putting the caret back where it was. */
  function renderSheet(focusBind, focusId) {
    const active = document.activeElement;
    const keep = !focusBind && active && el.sheet.contains(active) && active.dataset.bind
      ? { bind: active.dataset.bind, id: active.dataset.id || '',
          start: selectionOf(active), end: selectionOf(active, true) }
      : null;

    el.sheet.innerHTML = H.sheet(state.invoice, { edit: !state.committed, clients: directory() });
    refresh();
    /* innerHTML threw away the lookup notes and any open suggestion list.
       Both are state, not decoration — a green "✓ found" under line 1 must not
       vanish because line 2 was looked up. */
    for (const id of lookupResults.keys()) paintLookupNote(id);
    if (state.pickerOpen) renderPicker();

    const want = focusBind ? { bind: focusBind, id: focusId || '' } : keep;
    if (!want) return;
    const node = el.sheet.querySelector(
      `[data-bind="${cssEscape(want.bind)}"]${want.id ? `[data-id="${cssEscape(want.id)}"]` : ''}`);
    if (!node) return;
    node.focus();
    if (want.start != null && typeof node.setSelectionRange === 'function') {
      try { node.setSelectionRange(want.start, want.end); } catch {}
    }
  }

  /* A date/number/select input throws on .selectionStart, and not every
     browser agrees about which. Asking inside a try is cheaper than a list. */
  function selectionOf(node, end) {
    try { return end ? node.selectionEnd : node.selectionStart; } catch { return null; }
  }
  const cssEscape = (s) => String(s).replace(/["\\]/g, '\\$&');

  /**
   * Patch every derived spot without touching what is being typed into.
   * Everything here is computed from the model, never read back off the page.
   */
  function refresh() {
    const inv = state.invoice;
    const t = I.totals(inv);

    const number = el.sheet.querySelector('[data-out="number"]');
    if (number) number.textContent = state.committed ? inv.invoiceNumber : shownNumber();

    for (const row of el.sheet.querySelectorAll('[data-row]')) {
      const item = inv.items.find((i) => i.id === row.dataset.row);
      if (!item) continue;
      const amount = row.querySelector('[data-out="amount"]');
      if (amount) amount.textContent = item.price ? I.money(I.lineTotal(item)) : '';
      const words = row.querySelector('[data-out="qty-words"]');
      if (words) {
        const spelled = I.groupOf(item.schedule) === 'cii' ? I.spellNumberCapitalized(item.qty) : '';
        words.textContent = spelled ? `(${spelled})` : '';
      }
      // The mirror an autosizing input measures itself against.
      const wrap = row.querySelector('.autosize');
      if (wrap) {
        const input = wrap.querySelector('.slot');
        wrap.dataset.value = input.value || input.placeholder || '';
      }
    }

    /* A CII line prints its quantity in words too, which needs a column wide
       enough to hold "twenty-eight". Only the sheet with CIIs on it widens. */
    const firstCol = el.sheet.querySelector('col');
    if (firstCol) {
      const spellQty = inv.items.some((i) => I.groupOf(i.schedule) === 'cii');
      firstCol.style.width = `${spellQty ? 92 : 34}px`;
    }

    setText('[data-out="subtotal"]', I.money(t.subtotal));
    setText('[data-out="total"]', I.money(t.total));
    const split = el.sheet.querySelector('[data-out="split"]');
    if (split) split.innerHTML = H.splitNote(inv);

    el.total.textContent = I.money(t.total);
    el.docType.value = inv.docType;
    el.docType.disabled = state.committed;
    el.twoCopies.checked = inv.twoCopies;
    el.ndcLookup.checked = inv.ndcLookup;
    renderSummary();
  }

  function setText(sel, text) {
    const node = el.sheet.querySelector(sel);
    if (node) node.textContent = text;
  }

  function renderSummary() {
    const inv = state.invoice;
    const sheets = I.sheetsFor(inv);
    const where = !PaperPrint.isNative
      ? 'the browser print dialog'
      : printerName() ? `“${printerLabel()}”` : 'the printer you pick in the dialog';
    el.summary.textContent =
      I.splitSummary(sheets, inv.twoCopies) +
      (inv.twoCopies ? ' — one set labelled for us, one for them' : '') +
      ` · to ${where}.`;
  }

  // ===========================================================================
  // Typing on the paper
  // ===========================================================================

  /**
   * Write one typed value into the model.
   * → { structural } — whether the sheet's SHAPE changed and it must be rebuilt.
   * The model is the authority: if it normalised what was typed (a phone
   * number takes its brackets and dash as it goes), the caller writes the
   * corrected text back into the box.
   */
  function apply(bind, id, value) {
    const inv = state.invoice;

    if (bind.startsWith('item.')) {
      const item = inv.items.find((i) => i.id === id);
      if (item) item[bind.slice(5)] = value;
      return { structural: false };
    }
    if (bind.startsWith('to.')) {
      const key = bind.slice(3);
      inv.to[key] = key === 'phone' ? I.formatPhone(value) : value;
      // Typing over a picked pharmacy's name means it's no longer that one.
      if (key === 'name') state.clientId = null;
      return { structural: false, corrected: inv.to[key] };
    }
    if (bind === 'fromLocationId') {
      const picked = I.locationById(value);
      inv.fromLocationId = picked.id;
      /* Switching shops brings that shop's DEA and fax with it — unless either
         has been hand-edited to something the list doesn't know about, in
         which case the typed value is the better guess. */
      const known = (field, current) =>
        !current || I.ourLocations.some((l) => l[field] === current);
      if (known('dea', inv.fromDea)) inv.fromDea = picked.dea;
      if (known('fax', inv.fromFax)) inv.fromFax = picked.fax;
      return { structural: true };
    }
    inv[bind] = value;
    return { structural: false };
  }

  el.sheet.addEventListener('input', (e) => {
    const node = e.target;
    if (!node.dataset || !node.dataset.bind) return;
    const result = apply(node.dataset.bind, node.dataset.id, node.value);
    if (result.structural) {
      renderSheet(node.dataset.bind, node.dataset.id);
      return;
    }
    if (result.corrected != null && result.corrected !== node.value) reformat(node, result.corrected);
    refresh();
    if (node.dataset.picker) openPicker();
  });

  /**
   * Put the model's own spelling of a value back in the box mid-typing.
   *
   * The caret is kept the same distance from the END of the text rather than
   * from the start: typing "8" into "(208) 785-351|" has to land after the new
   * digit even though two characters appeared behind it, and backspacing out
   * of a group has to stay put rather than jumping to the end of the number.
   */
  function reformat(node, value) {
    const fromEnd = node.value.length - (selectionOf(node) ?? node.value.length);
    node.value = value;
    const at = Math.max(0, value.length - fromEnd);
    try { node.setSelectionRange(at, at); } catch {}
  }

  el.sheet.addEventListener('change', (e) => {
    const node = e.target;
    if (!node.dataset || !node.dataset.bind) return;
    if (node.dataset.bind === 'item.schedule') {
      apply('item.schedule', node.dataset.id, node.value);
      // The badge wears the printed styling when set, a faint dash when not.
      node.className = `sched-select ${node.value ? 'schedule' : 'sched-empty'}`;
      refresh();
      return;
    }
    if (node.tagName === 'SELECT' && apply(node.dataset.bind, node.dataset.id, node.value).structural) {
      renderSheet(node.dataset.bind, node.dataset.id);
    }
  });

  el.sheet.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'add-line') {
      const line = I.newLineItem();
      state.invoice.items.push(line);
      renderSheet('item.description', line.id);
    } else if (act.dataset.act === 'remove-line') {
      abortLookups(act.dataset.id);
      lookupResults.delete(act.dataset.id);
      state.invoice.items = state.invoice.items.filter((i) => i.id !== act.dataset.id);
      renderSheet();
    } else if (act.dataset.act === 'save-client') {
      saveClient();
    } else if (act.dataset.act === 'ndc-retry') {
      const id = act.dataset.id;
      const item = state.invoice.items.find((i) => i.id === id);
      if (item) lookupLine(item, true);
    } else if (act.dataset.act === 'pick-client') {
      pickClient(act.dataset.id);
    }
  });

  // The FDA lookup fires when the pharmacist leaves the NDC box, so one
  // completed code is one request rather than a request per character.
  el.sheet.addEventListener('blur', (e) => {
    const node = e.target;
    if (node.dataset && node.dataset.bind === 'item.ndc') {
      const item = state.invoice.items.find((i) => i.id === node.dataset.id);
      if (item) lookupLine(item, false);
    }
    if (node.dataset && node.dataset.picker) {
      // A click on a suggestion fires blur first, so let it land.
      window.setTimeout(closePicker, 120);
    }
  }, true);

  el.sheet.addEventListener('keydown', (e) => {
    const node = e.target;
    if (!node.dataset) return;

    if (node.dataset.picker) { pickerKeys(e); if (e.defaultPrevented) return; }

    if (e.key === 'Enter' && node.dataset.bind === 'item.ndc') {
      e.preventDefault();
      const item = state.invoice.items.find((i) => i.id === node.dataset.id);
      if (item) lookupLine(item, true); // Enter re-asks for a code already tried
    }
  });

  el.sheet.addEventListener('focusin', (e) => {
    if (e.target.dataset && e.target.dataset.picker) openPicker();
  });

  // ===========================================================================
  // The NDC lookup
  // ===========================================================================
  //
  // The only outbound call this page makes besides Firebase, and it is a
  // toggle. Only the NDC is sent, never anything else off the slip.

  const lookups = new Map();       // item id → the request in flight
  const lookupResults = new Map(); // item id → what the last one said

  /** Drop every request in flight — on save, on clear, on sign-out. */
  function abortLookups(id) {
    for (const [key, entry] of lookups) {
      if (id != null && key !== id) continue;
      entry.controller.abort();
      lookups.delete(key);
    }
  }

  async function lookupLine(item, force) {
    if (!state.invoice.ndcLookup || state.committed) return;
    const raw = (item.ndc || '').trim();
    const prior = lookups.get(item.id);

    if (!raw || !NDC.isSearchable(raw)) {
      abortLookups(item.id);
      lookupNote(item.id, null);
      return;
    }
    /* The same code, already asked: a no-op. Checked BEFORE aborting, so
       tabbing out of the box and back in doesn't cancel the request that is
       already fetching the answer and start an identical one. */
    if (!force && prior && prior.query === raw) return;
    if (prior) prior.controller.abort();

    const controller = new AbortController();
    lookups.set(item.id, { controller, query: raw, done: false });
    lookupNote(item.id, { status: 'loading' });

    const result = await NDC.lookup(raw, controller.signal);
    if (controller.signal.aborted) return;
    /* Everything below writes to the line. Re-check what was true when the
       request went out and may not be now: the invoice may have been SAVED
       while the FDA was answering, and a written invoice must not change —
       filling in a schedule here would re-split the sheets and make "Print
       again" produce paper that doesn't match the filed record. The line may
       also have been removed, or the lookup switched off. */
    if (state.committed || !state.invoice.ndcLookup) return;
    if (!state.invoice.items.includes(item)) return;
    const entry = lookups.get(item.id);
    if (entry) entry.done = true;

    if (result.status !== 'found') {
      // A failed lookup shouldn't stick — let the next blur try again.
      if (result.status === 'error' && entry) entry.query = null;
      lookupNote(item.id, result);
      return;
    }

    /* Fill only what's still blank — a pharmacist who typed the drug name by
       hand shouldn't have it overwritten by the FDA's spelling of it. The DEA
       schedule is the exception: that's a fact about the drug, not a
       preference, so a fresh lookup always replaces it. */
    const facts = result.facts;
    const strength = [facts.strength, facts.size].filter(Boolean).join(' — ');
    /* Only rewrite the typed code when the FDA confirmed that exact package.
       A 10-digit code has three possible 11-digit readings, and printing the
       wrong one on a transfer slip is worse than leaving the typed text be. */
    if (facts.packageNdc && facts.packageNdc !== item.ndc) item.ndc = facts.packageNdc;
    if (facts.name && !item.description.trim()) item.description = facts.name;
    if (strength && !item.strength.trim()) item.strength = strength;
    item.schedule = facts.schedule || '';

    // Values changed under the row, so it has to be redrawn rather than patched.
    renderSheet();
    lookupNote(item.id, result);
  }

  /** Remember how a line's lookup went, and show it. */
  function lookupNote(id, result) {
    if (result) lookupResults.set(id, result);
    else lookupResults.delete(id);
    paintLookupNote(id);
  }

  /** The line under a row that says how its lookup went. */
  function paintLookupNote(id) {
    const result = lookupResults.get(id);
    const row = el.sheet.querySelector(`[data-lookup="${cssEscape(id)}"]`);
    if (!row) return;
    const cell = row.querySelector('td:last-child');
    if (!result || !state.invoice.ndcLookup) { row.hidden = true; cell.innerHTML = ''; return; }

    let html = '';
    if (result.status === 'loading') html = `<span class="lookup-note">Looking up NDC…</span>`;
    else if (result.status === 'not-found') {
      html = `<span class="lookup-note">No FDA record for that NDC — fill the line in by hand.</span>`;
    } else if (result.status === 'error') {
      html = `<span class="lookup-note">Couldn't reach the FDA directory. ` +
        `<button type="button" class="lookup-retry" data-act="ndc-retry" data-id="${H.esc(id)}">Try again</button></span>`;
    } else if (result.status === 'found') {
      const f = result.facts;
      const detail = [f.labeler, f.dosageForm].filter(Boolean).join(' · ');
      html = `<span class="lookup-note lookup-found">✓ ${H.esc(detail || 'Found in the FDA directory')}` +
        `${f.packageDescription ? ` — ${H.esc(f.packageDescription)}` : ''}</span>`;
    }
    cell.innerHTML = html;
    row.hidden = !html;
  }

  // ===========================================================================
  // The saved pharmacy directory
  // ===========================================================================

  const pickerInput = () => el.sheet.querySelector('[data-picker]');
  const pickerBox = () => el.sheet.querySelector('[data-out="client-list"]');

  function matches() {
    return S.searchClients(state.clients, state.invoice.to.name).slice(0, 6);
  }

  /* The list shrinks under the highlight whenever the typed name narrows it —
     or when another workstation edits the directory and a snapshot lands. Ask
     for the index rather than trusting the stored one. */
  const highlightIn = (list) =>
    Math.min(Math.max(0, state.highlight), Math.max(0, list.length - 1));

  function openPicker() {
    state.pickerOpen = true;
    renderPicker();
  }

  function closePicker() {
    if (!state.pickerOpen) return;
    state.pickerOpen = false;
    /* Reset, so reopening the list doesn't come back with the fourth pharmacy
       pre-selected and Enter quietly picking it. */
    state.highlight = 0;
    renderPicker();
  }

  function renderPicker() {
    const box = pickerBox();
    if (!box) return;
    const list = state.pickerOpen ? matches() : [];
    const input = pickerInput();
    if (input) input.setAttribute('aria-expanded', String(list.length > 0));
    if (!list.length) { box.innerHTML = ''; return; }
    state.highlight = highlightIn(list);
    box.innerHTML = `<ul class="client-list" role="listbox">${list.map((c, i) =>
      `<li><button type="button" data-act="pick-client" data-id="${H.esc(c.id)}"${
        i === state.highlight ? ' class="is-active"' : ''}>` +
      `<span class="client-name">${H.esc(c.name)}</span>` +
      `<span class="client-meta">${H.esc([c.cityStateZip, c.dea].filter(Boolean).join(' · '))}</span>` +
      `</button></li>`).join('')}</ul>`;
  }

  function pickerKeys(e) {
    if (!state.pickerOpen) return;
    const list = matches();
    if (!list.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      state.highlight = Math.min(highlightIn(list) + 1, list.length - 1);
      renderPicker();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      state.highlight = Math.max(highlightIn(list) - 1, 0);
      renderPicker();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pickClient(list[highlightIn(list)].id);
    } else if (e.key === 'Escape') {
      closePicker();
    }
  }

  function pickClient(id) {
    const client = state.clients.find((c) => c.id === id);
    if (!client) return;
    state.clientId = client.id;
    state.invoice.to = {
      name: client.name || '', street: client.street || '', cityStateZip: client.cityStateZip || '',
      phone: client.phone || '', fax: client.fax || '', dea: client.dea || '',
    };
    state.pickerOpen = false;
    state.highlight = 0;
    renderSheet('to.street');
  }

  async function saveClient() {
    const current = state.clients.find((c) => c.id === state.clientId) || null;
    state.clientBusy = true;
    renderSheet();
    try {
      if (current) await S.updateClient(current.id, state.invoice.to);
      else state.clientId = await S.createClient(state.invoice.to, state.uid);
    } catch (err) {
      notice(true, `Couldn't save that pharmacy — ${H.esc(err.message)}`);
    } finally {
      state.clientBusy = false;
      renderSheet();
    }
  }

  // ===========================================================================
  // The toolbar
  // ===========================================================================

  el.docType.addEventListener('change', () => {
    /* Transfer or purchase is a fact about what happened, and it is in the
       filed record — so once the invoice is written it stops being settable.
       (The manual's toolbar still allows this; flipping it after saving makes
       "Print again" produce a document the record doesn't describe.) */
    if (state.committed) { refresh(); return; }
    state.invoice.docType = el.docType.value === 'purchase' ? 'purchase' : 'transfer';
    renderSheet(); // both party headings change
  });
  el.twoCopies.addEventListener('change', () => {
    state.invoice.twoCopies = el.twoCopies.checked;
    renderSummary();
  });
  el.ndcLookup.addEventListener('change', () => {
    state.invoice.ndcLookup = el.ndcLookup.checked;
    if (!el.ndcLookup.checked) {
      abortLookups();
      lookupResults.clear();
      for (const row of el.sheet.querySelectorAll('[data-lookup]')) {
        row.hidden = true;
        row.querySelector('td:last-child').innerHTML = '';
      }
    }
  });

  el.clearBtn.addEventListener('click', async () => {
    if (state.committed) { startNew(); return; }
    if (!(await askConfirm('Clear this invoice and start a new one?', { ok: 'Clear' }))) return;
    startNew();
  });

  function startNew(from) {
    abortLookups();
    lookupResults.clear();
    state.invoice = freshInvoice(from);
    state.highlight = 0;
    state.committed = false;
    state.clientId = null;
    state.pickerOpen = false;
    el.status.className = 'status';
    el.clearBtn.textContent = 'Clear';
    el.printBtn.textContent = 'Save & Print';
    notice(false, '');
    closeHistory();
    renderSheet();
    window.scrollTo({ top: 0 });
  }

  // ===========================================================================
  // Save & print
  // ===========================================================================

  el.printBtn.addEventListener('click', async () => {
    if (state.saving) return;
    if (state.committed) { print(state.invoice, 'Printed again.'); return; }

    const sheets = I.sheetsFor(state.invoice);
    if (!sheets.length) {
      setStatus(el.status, false, 'There is nothing on this invoice to print.');
      return;
    }
    /* Writing the record is the point of the button, and it cannot be undone
       by editing afterwards — so the one confirmation on this screen is here. */
    const pages = H.pageCount(state.invoice);
    if (!(await askConfirm(`Save invoice ${shownNumber()} to the record and print it?`, {
      ok: 'Save & print',
      detail: [
        `${sheets.length === 1 ? 'One invoice' : `${sheets.length} separate invoices`}, ${pages} ${pages === 1 ? 'page' : 'pages'}.`,
        'A saved invoice can\u2019t be edited afterwards — a mistake is fixed by voiding it and writing a new one.',
      ],
    }))) return;

    state.saving = true;
    el.printBtn.disabled = true;
    el.printBtn.textContent = 'Saving…';
    try {
      // Claim a number, write the record, THEN print. In that order.
      const number = await S.claimInvoiceNumber();
      state.invoice.invoiceNumber = String(number);
      await S.saveInvoice(state.invoice, state.uid, state.email);
      /* The record is written, so the invoice is frozen. Anything still coming
         back from the FDA would be writing to a document that is already on
         file — drop it all before the sheet is redrawn read-only. */
      abortLookups();
      state.committed = true;
      el.clearBtn.textContent = 'New invoice';
      el.printBtn.textContent = 'Print again';
      notice(false,
        `<strong>Invoice ${H.esc(state.invoice.invoiceNumber)} is on file.</strong> A written invoice ` +
        `can’t be edited — to fix something, void it in the history and duplicate it as a new one.`);
      renderSheet();
      await print(state.invoice, `Invoice ${state.invoice.invoiceNumber} saved and printed.`);
    } catch (err) {
      setStatus(el.status, false, `Couldn't save that invoice — ${err.message}. Nothing was printed.`);
    } finally {
      state.saving = false;
      el.printBtn.disabled = false;
      if (!state.committed) el.printBtn.textContent = 'Save & Print';
    }
  });

  async function print(invoice, okMessage) {
    setStatus(el.status, true, 'Sending to the printer…');
    const fontCss = await InvoiceFonts.css();
    const res = await PaperPrint.printDoc(H.doc(invoice, { fontCss }), { deviceName: printerName() });
    if (res && res.ok) { setStatus(el.status, true, `✓ ${okMessage} ${res.message || ''}`.trim()); return true; }
    if (res && res.cancelled) {
      setStatus(el.status, false, '✗ Printing was cancelled. The invoice is still on file — use Print again.');
      return false;
    }
    setStatus(el.status, false,
      `✗ ${(res && (res.message || res.error)) || 'The invoice could not be printed.'} It is on file — use Print again.`);
    return false;
  }

  // ---- The printer ----------------------------------------------------------

  let printers = [];
  const printerName = () => localStorage.getItem(PRINTER_KEY) || '';
  function printerLabel() {
    const found = printers.find((p) => p.name === printerName());
    return found ? found.label : printerName();
  }

  async function loadPrinters() {
    if (!PaperPrint.isNative) {
      printers = [];
      el.printer.innerHTML = '<option value="">Browser print dialog</option>';
      el.printer.disabled = true;
      renderSummary();
      return;
    }
    try {
      printers = await PaperPrint.listPrinters();
    } catch {
      printers = [];
    }
    /* A printer that has been uninstalled would otherwise stay in
       localStorage, out of the dropdown but still passed to printDoc — which
       prints silently to a device Chromium will refuse, while the UI says it
       would show a dialog. Forget it instead. Shared with the call-in form:
       one setting, one machine. */
    if (printerName() && !printers.some((p) => p.name === printerName())) {
      localStorage.removeItem(PRINTER_KEY);
    }
    const saved = printerName();
    el.printer.disabled = false;
    el.printer.innerHTML =
      '<option value="">Ask me every time</option>' +
      printers.map((p) => `<option value="${H.esc(p.name)}"${p.name === saved ? ' selected' : ''}>${
        H.esc(p.label)}${p.isDefault ? ' (default)' : ''}</option>`).join('');
    renderSummary();
  }

  el.printer.addEventListener('change', () => {
    localStorage.setItem(PRINTER_KEY, el.printer.value);
    renderSummary();
  });

  // ===========================================================================
  // History
  // ===========================================================================

  el.historyBtn.addEventListener('click', () => {
    el.histModal.hidden = false;
    renderHistory();
    el.search.focus();
  });
  el.histClose.addEventListener('click', closeHistory);
  el.search.addEventListener('input', renderHistory);
  el.histModal.addEventListener('pointerdown', (e) => { if (e.target === el.histModal) closeHistory(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.histModal.hidden) closeHistory();
  });

  function closeHistory() {
    el.histModal.hidden = true;
    state.openRecord = null;
  }

  function renderHistory() {
    if (el.histModal.hidden) return;
    const term = el.search.value;
    const results = S.searchInvoices(state.invoices, term);

    const message = (text) => `<p class="inv-history-msg">${H.esc(text)}</p>`;
    let html = '';
    if (state.invoicesError) html += message(`Couldn't load history — ${state.invoicesError}`);
    else if (!state.invoicesLoaded) html += message('Loading…');
    else if (!state.invoices.length) html += message('No invoices saved yet. The first one you print will land here.');
    else if (!results.length) html += message(`Nothing matches “${term}”.`);

    html += results.map(record).join('');
    el.histList.innerHTML = html;
  }

  function record(r) {
    const open = state.openRecord === r.id;
    const inv = r.invoice || {};
    const head = `<button type="button" class="inv-rec-head" data-rec="${H.esc(r.id)}">
      <span class="inv-rec-num">${H.esc(String(r.number))}</span>
      ${r.voided ? '<span class="inv-void-tag">Void</span>' : ''}
      <span class="inv-rec-to">${H.esc(r.toName || '—')}</span>
      <span class="inv-rec-meta">${H.esc(r.date || '')}</span>
      ${r.sheetCount > 1 ? `<span class="inv-rec-meta">${r.sheetCount} sheets</span>` : ''}
      <span class="inv-rec-total">${H.esc(I.money(Number(r.total) || 0))}</span>
    </button>`;

    if (!open) return `<div class="inv-rec${r.voided ? ' is-void' : ''}">${head}</div>`;

    const lines = (inv.items || []).map((i) => `<tr>
      <td class="q">${H.esc(i.qty)}</td>
      <td><span style="font-weight:600">${H.esc(i.description)}</span>${
        i.schedule ? `<span class="inv-rec-tag">${H.esc(i.schedule)}</span>` : ''}
        <div class="sub">${H.esc(i.strength || '')}</div></td>
      <td class="c">${H.esc(i.ndc || '')}</td>
      <td class="c">${H.esc(i.lot || '')}</td>
      <td class="a">${H.esc(I.money(I.lineTotal(i)))}</td>
    </tr>`).join('');

    return `<div class="inv-rec${r.voided ? ' is-void' : ''}">${head}
      <div class="inv-rec-body">
        <table><tbody>${lines}</tbody></table>
        ${r.voidReason ? `<p class="inv-rec-note err">Voided — ${H.esc(r.voidReason)}</p>` : ''}
        <p class="inv-rec-note">Released by ${H.esc(inv.pharmacist || '—')} · picked up by ${
          H.esc(inv.pickedUpBy || '—')} · written by ${H.esc(r.createdByEmail || '—')}</p>
        <div class="btns">
          <button type="button" class="secondary" data-rec-act="reprint" data-id="${H.esc(r.id)}">Reprint</button>
          <button type="button" class="secondary" data-rec-act="duplicate" data-id="${H.esc(r.id)}">Duplicate as new</button>
          ${!r.voided ? `<button type="button" class="danger" style="margin-left:auto"
             data-rec-act="void" data-id="${H.esc(r.id)}">Void</button>` : ''}
        </div>
      </div>
    </div>`;
  }

  el.histList.addEventListener('click', async (e) => {
    const head = e.target.closest('[data-rec]');
    if (head) {
      state.openRecord = state.openRecord === head.dataset.rec ? null : head.dataset.rec;
      renderHistory();
      return;
    }
    const act = e.target.closest('[data-rec-act]');
    if (!act) return;
    const found = state.invoices.find((r) => r.id === act.dataset.id);
    if (!found) return;

    if (act.dataset.recAct === 'duplicate') {
      startNew(found.invoice);
    } else if (act.dataset.recAct === 'reprint') {
      // Printed exactly as it was written, including its original number.
      closeHistory();
      await print(I.reviveInvoice(found.invoice), `Invoice ${found.number} reprinted.`);
    } else if (act.dataset.recAct === 'void') {
      await voidRecord(found, act);
    }
  });

  async function voidRecord(found, button) {
    /* Voiding is the only change a written invoice will accept, and it only
       goes one way — so it asks, and the reason goes on the record. */
    const reason = await askReason(found.number);
    if (reason === null) return;
    button.disabled = true;
    button.textContent = 'Voiding…';
    try {
      await S.voidInvoice(found.id, reason);
    } catch (err) {
      notice(true, `Couldn't void invoice ${found.number} — ${H.esc(err.message)}`);
      button.disabled = false;
      button.textContent = 'Void';
    }
  }

  /**
   * "Why?", in the page. window.prompt() is out for the same reason
   * window.confirm() is — see askConfirm() in app.js: on Windows a native
   * dialog leaves the page deaf to the keyboard afterwards.
   */
  function askReason(number) {
    return new Promise((resolve) => {
      const returnFocus = document.activeElement;
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay confirm-overlay';
      overlay.innerHTML = `<div class="modal confirm" role="alertdialog" aria-modal="true">
        <h2>Void invoice ${H.esc(String(number))}?</h2>
        <p class="hint" style="margin-top:0">A voided invoice stays on the record — it is marked, not removed.</p>
        <label for="voidWhy">Reason</label>
        <input id="voidWhy" type="text" autocomplete="off" placeholder="Wrong pharmacy, miscount…">
        <div class="btns"><button type="button" data-ok>Void it</button>
        <button type="button" class="secondary" data-cancel>Cancel</button></div>
      </div>`;
      const input = overlay.querySelector('#voidWhy');
      const close = (answer) => {
        overlay.remove();
        document.removeEventListener('keydown', onKey, true);
        if (returnFocus && document.contains(returnFocus)) returnFocus.focus();
        resolve(answer);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
        else if (e.key === 'Enter' && e.target === input) { e.preventDefault(); close(input.value); }
      };
      overlay.querySelector('[data-ok]').addEventListener('click', () => close(input.value));
      overlay.querySelector('[data-cancel]').addEventListener('click', () => close(null));
      overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(null); });
      document.addEventListener('keydown', onKey, true);
      document.body.append(overlay);
      input.focus();
    });
  }

  // ===========================================================================
  // Odds and ends
  // ===========================================================================

  function setStatus(node, ok, message) {
    node.className = `status show ${ok ? 'ok' : 'err'}`;
    node.textContent = message;
  }

  /* Takes HTML, not text — the committed message carries a <strong>. Every
     caller interpolating a message from Firebase must run it through H.esc. */
  function notice(isError, html) {
    el.notice.innerHTML = html;
    el.notice.className = `inv-notice${isError ? ' err' : ''}`;
    el.notice.hidden = !html;
  }

  /* The sheet's stylesheet lives in sheet.js so the print document and the
     screen share one source; the screen's copy is injected here. */
  const style = document.createElement('style');
  style.id = 'invoice-sheet-css';
  style.textContent = H.CSS;
  document.head.append(style);

  /* The paper exists from the moment the app loads, behind the gate. Nothing
     about the editor needs Firestore — the sheet is a pure function of local
     state — so signing in reveals a finished sheet rather than a flash of
     empty white. (The invoice itself was built at the top of this file, before
     the auth subscription that can reach showGate().) */
  renderSheet();

  // A printer added or removed while the app was open shows up on the way in.
  document.addEventListener('modechange', (e) => {
    if (e.detail === 'invoices' && state.started) { loadPrinters(); renderSummary(); }
  });
})();
