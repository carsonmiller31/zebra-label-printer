'use strict';
/*
 * The invoice itself — and, when `edit` is on, the editor too.
 *
 * One function renders both so the paper on screen can't drift from the paper
 * in the tray: the only difference is whether a given spot comes out as a span
 * or as an input dressed to look exactly like that span. This is the same
 * trick the manual's InvoiceSheet.tsx plays, and the same reason for it.
 *
 * WHAT THEMES AND WHAT DOES NOT
 * The chrome around the sheet (toolbar, history, sign-in) follows the rest of
 * this app. The sheet does not, and must not. It is a controlled-substance
 * transfer record headed for a mono laser: every rule and badge is an outline,
 * never a fill, and the palette is a fixed set of literals. A dark-mode
 * invoice would be a different document.
 *
 * The px geometry is deliberate too — 816 x 1056 is US Letter at 96 dpi and
 * 720 x 960 is that page less its half-inch margins, so a millimetre on screen
 * is a millimetre on the slip. Don't convert these to rem.
 *
 * CSS lives here rather than in invoices.css because both consumers need it:
 * the page injects it into a <style> tag, and the print document carries a
 * copy inside a data: URL. One source, so the preview IS the printout.
 */
var InvoiceSheetHtml = (function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const I = Invoicing;

  // ===========================================================================
  // The paper's stylesheet
  // ===========================================================================
  //
  // Every selector is rooted at `.sheet`. That is not tidiness: on screen this
  // CSS sits in a page whose globals style bare `input`, `select`, `button`
  // and `table`, and a `.sheet x` selector (0-2-0) beats an element one
  // (0-0-1) without !important anywhere.

  const CSS = `
.sheet {
  --inv-display: "Nunito", ui-rounded, "Segoe UI", system-ui, sans-serif;
  --inv-body: "Nunito Sans", ui-sans-serif, system-ui, sans-serif;
  --inv-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --inv-green-deep: #235741;
  --inv-green-bright: #3f9268;
  --inv-ink: #26332c;
  --inv-ink-soft: #505f56;
  --inv-ink-mute: #5a685f;
  --inv-line: #e8dfce;

  width: 720px;
  min-height: 960px;
  background: #fff;
  color: #111;
  display: flex;
  flex-direction: column;
  font-family: var(--inv-body);
  font-size: 15px;
  line-height: 1.5;
  text-align: left;
}

/* ---- Reset ------------------------------------------------------------
   The manual's copy of these components ran under Tailwind's Preflight.
   There is no Preflight here, and the app around the sheet styles bare
   elements for its own forms, so both have to be undone inside the paper. */
.sheet *, .sheet *::before, .sheet *::after { box-sizing: border-box; }
.sheet div, .sheet p, .sheet h1, .sheet h2, .sheet ul, .sheet li { margin: 0; padding: 0; }
.sheet ul, .sheet li { list-style: none; }
.sheet button {
  background: none; border: 0; padding: 0; margin: 0;
  color: inherit; font: inherit; line-height: inherit; cursor: pointer;
  border-radius: 0; width: auto; transition: none;
}
.sheet input, .sheet select, .sheet textarea {
  font: inherit; color: inherit; background: none; border: 0; border-radius: 0;
  padding: 0; margin: 0; width: auto; box-shadow: none;
}
.sheet input:focus, .sheet select:focus, .sheet textarea:focus { outline: none; box-shadow: none; }
.sheet table { width: 100%; border-collapse: collapse; }
.sheet .font-bold { font-weight: 700; }
.sheet .font-semibold { font-weight: 600; }
.sheet .italic { font-style: italic; }

/* ---- Letterhead ---- */
.sheet .sheet-head {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 32px; padding-bottom: 12px;
}
.sheet .sheet-rule { border-bottom: 2px solid #111; }
.sheet .head-left { min-width: 0; }
.sheet .head-right { text-align: right; flex-shrink: 0; }
.sheet .wordmark {
  font-family: var(--inv-display); font-weight: 900;
  font-size: 27px; line-height: 1; color: #111;
}
.sheet .tagline { font-size: 11px; font-style: italic; margin-top: 3px; color: #111; }
.sheet .head-addr { font-size: 11px; margin-top: 7px; line-height: 1.45; color: #111; }
.sheet .doc-title {
  font-family: var(--inv-display); font-weight: 900; font-size: 15px;
  line-height: 1.15; letter-spacing: 0.08em; text-transform: uppercase; color: #111;
}
/* Which class of drug this sheet covers, under the document title. */
.sheet .doc-class {
  font-family: var(--inv-display); font-weight: 800; font-size: 10px;
  letter-spacing: 0.12em; text-transform: uppercase; color: #111;
  border: 1px solid #111; border-radius: 3px; padding: 2px 6px;
  display: inline-block; margin-top: 6px;
}
.sheet .head-meta { font-size: 11px; margin-top: 8px; line-height: 1.7; }
.sheet .head-meta .k { color: #111; }
.sheet .date-slot { width: 132px; text-align: right; font-weight: 700; }

/* ---- Who to whom ---- */
.sheet .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 16px; }
.sheet .party { border: 1px solid #999; border-radius: 4px; padding: 9px 12px 11px; position: relative; }
.sheet .party-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.sheet .party-name {
  font-family: var(--inv-display); font-weight: 800; font-size: 14px;
  min-height: 18px; color: #111;
}
.sheet .party-lines { font-size: 11px; line-height: 1.5; color: #111; }
.sheet .party-lines.fixed { min-height: 33px; }
.sheet .party-dea { font-size: 11px; margin-top: 4px; }
.sheet .party-dea .k { color: #111; }
.sheet .micro-heading {
  font-family: var(--inv-display); font-size: 9px; font-weight: 800;
  letter-spacing: 0.11em; text-transform: uppercase; color: #111;
}

/* ---- Items ---- */
.sheet .items { margin-top: 18px; }
.sheet th {
  font-family: var(--inv-display); font-size: 9px; font-weight: 800;
  letter-spacing: 0.09em; text-transform: uppercase; text-align: left; color: #111;
  padding: 5px 8px; border-top: 1px solid #111; border-bottom: 1px solid #111;
}
.sheet td { font-size: 12px; padding: 7px 8px; border-bottom: 1px solid #d4d4d4; vertical-align: top; }
.sheet .code { font-family: var(--inv-mono); font-size: 11px; }
.sheet .small { font-size: 11px; color: #111; }
.sheet .num { text-align: right; font-variant-numeric: tabular-nums; }
.sheet th.num { text-align: right; }
.sheet .desc-row { display: flex; align-items: baseline; }

/* The written-out half of a Schedule II quantity, under the figures. Small,
   but not so small it can't be read back against the numeral it corroborates. */
.sheet .qty-words {
  font-size: 9px; line-height: 1.2; margin-top: 1px; color: #111; text-align: right;
  font-variant-numeric: normal; overflow-wrap: break-word; hyphens: auto;
}

/* CIII and friends. An outline, not a fill — it has to survive a mono laser. */
.sheet .schedule {
  display: inline-block; font-family: var(--inv-mono); font-size: 9px; font-weight: 700;
  letter-spacing: 0.04em; line-height: 1; padding: 2px 4px;
  border: 1px solid #111; border-radius: 3px; vertical-align: 1px; margin-left: 5px;
}

/* ---- Totals ---- */
.sheet .totals-wrap { display: flex; justify-content: flex-end; margin-top: 10px; }
.sheet .totals { width: 250px; }
.sheet .total-cell { font-size: 12px; padding: 3px 8px; border-bottom: none; }
.sheet .total-label {
  font-family: var(--inv-display); font-weight: 900; font-size: 12px;
  letter-spacing: 0.07em; text-transform: uppercase;
  border-top: 1.5px solid #111; border-bottom: none; padding-top: 7px;
}
.sheet .total-value {
  font-size: 15px; font-weight: 700;
  border-top: 1.5px solid #111; border-bottom: none; padding-top: 7px;
}

/* ---- Notes & signatures ---- */
.sheet .notes { margin-top: 16px; }
.sheet .notes-text { font-size: 12px; margin-top: 4px; white-space: pre-wrap; }
.sheet .notes-input { font-size: 12px; margin-top: 4px; width: 100%; resize: none; min-height: 0; }
/* Pushed to the foot so the page always looks whole. */
.sheet .sigs { margin-top: auto; padding-top: 26px; }
.sheet .sig-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 26px; }
/* Tall enough to actually sign in, not just a rule under a name. */
.sheet .sig-line { border-bottom: 1px solid #111; height: 34px; }
.sheet .sig-name { font-size: 12px; margin-top: 3px; min-height: 16px; }
.sheet .sheet-foot {
  display: flex; align-items: center; justify-content: space-between;
  margin-top: 18px; padding-top: 8px; border-top: 1px solid #d4d4d4;
  font-size: 9.5px; letter-spacing: 0.06em; text-transform: uppercase; color: #111;
}

/* ---- Editing in place ---- */
/* An input that has been talked out of looking like one. It inherits the type
   of the spot it sits in, so switching between editing and printing changes
   nothing about the layout. */
.sheet .slot {
  font: inherit; color: inherit; letter-spacing: inherit;
  background: transparent; border: 0; border-radius: 2px;
  padding: 0 2px; margin: 0 -2px; min-width: 0; max-width: 100%;
}
.sheet .slot:hover { background: #f0f0f0; }
.sheet .slot:focus { background: #eaf2ec; outline: 1px solid var(--inv-green-bright); outline-offset: 0; }
.sheet .slot::placeholder { color: #b5b5b5; font-style: italic; font-weight: 400; letter-spacing: 0; }
.sheet .slot.block { display: block; width: 100%; }
.sheet .slot.right { text-align: right; }

/* An input that grows with its own text. The ::after mirror sits in the same
   grid cell, invisible, and its width is what the cell ends up being — so
   whatever follows the input sits right against the text, not at the far edge
   of the column. */
.sheet .autosize { display: inline-grid; max-width: 100%; vertical-align: top; }
.sheet .autosize::after {
  content: attr(data-value) " "; grid-area: 1 / 1; visibility: hidden;
  white-space: pre; padding: 0 2px;
}
.sheet .autosize > .slot { grid-area: 1 / 1; width: 100%; }

/* The letterhead doubles as the shop picker. */
.sheet .slot-wordmark {
  font-family: var(--inv-display); font-weight: 900; font-size: 27px;
  line-height: 1; color: #111; appearance: none; cursor: pointer; padding-right: 18px;
  background-image: linear-gradient(45deg, transparent 50%, #999 50%),
                    linear-gradient(135deg, #999 50%, transparent 50%);
  background-position: calc(100% - 9px) 60%, calc(100% - 4px) 60%;
  background-size: 5px 5px, 5px 5px; background-repeat: no-repeat;
}

.sheet .add-line {
  display: block; width: 100%; margin-top: 6px; padding: 5px;
  border: 1px dashed #bbb; border-radius: 4px;
  font-family: var(--inv-display); font-size: 11px; font-weight: 800; color: #777;
}
.sheet .add-line:hover { border-color: var(--inv-green-bright); color: var(--inv-green-deep); background: #f6faf7; }

/* Sits out in the paper's left margin so it never shifts the table. */
.sheet .qty-cell { position: relative; }
.sheet .row-remove {
  position: absolute; left: -26px; top: 5px; width: 18px; height: 18px;
  line-height: 1; border-radius: 999px; background: transparent; color: #c4c4c4;
  font-size: 15px; opacity: 0; transition: opacity 120ms ease; padding: 0;
}
.sheet tr:hover .row-remove, .sheet .row-remove:focus-visible { opacity: 1; }
.sheet .row-remove:hover { background: #fbeaea; color: #b42318; }

.sheet .lookup-row td { border-bottom: 1px solid #d4d4d4; padding-top: 0; }
.sheet .lookup-note { font-size: 10.5px; color: #777; }
.sheet .lookup-found { color: var(--inv-green-deep); }
.sheet .lookup-retry {
  font-size: 10.5px; font-weight: 700; color: var(--inv-green-deep); text-decoration: underline;
}

/* The schedule picker wears the printed badge's own styling when it's set, and
   shrinks to a faint dash when it isn't — so a line's class is readable at a
   glance without a control shouting on every row. */
.sheet .sched-select { appearance: none; cursor: pointer; background: transparent; flex: none; }
/* A <select> is as wide as its longest option, so both states get an explicit
   width. Equal widths also line the badges up down the column. */
.sheet .sched-select.schedule { padding: 2px 0; width: 38px; text-align: center; }
.sheet .sched-empty {
  border: 1px dashed #d8d8d8; border-radius: 3px; color: #c0c0c0; font-size: 9px;
  font-family: var(--inv-mono); line-height: 1; padding: 2px 0; margin-left: 5px;
  width: 38px; text-align: center;
}
.sheet tr:hover .sched-empty, .sheet .sched-empty:focus {
  border-color: var(--inv-green-bright); color: var(--inv-green-deep);
}

/* ---- The saved pharmacy directory ---- */
.sheet .client-picker { position: relative; }
/* Sits over the sheet rather than pushing it around, so picking a pharmacy
   doesn't make the paper jump. */
.sheet .client-list {
  position: absolute; z-index: 10; left: -4px; right: -4px; top: calc(100% + 3px);
  background: #fff; border: 1px solid var(--inv-line); border-radius: 8px;
  box-shadow: 0 8px 24px rgb(38 51 44 / 0.14); overflow: hidden;
}
.sheet .client-list button { display: block; width: 100%; text-align: left; padding: 6px 10px; font-size: 12px; }
.sheet .client-list button.is-active { background: #e9f1ea; }
.sheet .client-name { display: block; font-weight: 700; color: var(--inv-ink); }
.sheet .client-meta { display: block; font-size: 10.5px; color: var(--inv-ink-mute); }
.sheet .client-save, .sheet .client-saved {
  font-size: 9.5px; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase;
  white-space: nowrap;
}
.sheet .client-save { color: var(--inv-green-deep); text-decoration: underline; }
.sheet .client-save:disabled { opacity: 0.5; cursor: default; }
.sheet .client-saved { color: #9aa79f; }

/* How the job will be dealt onto separate sheets. Editor only. */
.sheet .split-note {
  margin-top: 10px; padding: 9px 12px; border: 1px solid var(--inv-line);
  border-radius: 6px; background: #fcfaf5; font-size: 11px; line-height: 1.5;
  color: var(--inv-ink-soft);
}
.sheet .split-note strong { color: var(--inv-ink); font-weight: 700; }
.sheet .split-note ul { margin-top: 5px; display: flex; flex-wrap: wrap; gap: 4px 16px; }
.sheet .split-label { font-weight: 700; color: var(--inv-ink); margin-right: 5px; }
.sheet .split-tax { margin-top: 4px; color: var(--inv-ink-mute); }
`;

  // ===========================================================================
  // Spots on the paper
  // ===========================================================================

  /** Keeps the table looking like a form rather than a receipt when it's short. */
  const MIN_ROWS = 6;

  const cls = (...parts) => parts.filter(Boolean).join(' ');

  /**
   * One spot: printed text, or an input dressed to look exactly like it.
   * `bind` is what the editor's delegated listener reads to know which field
   * this is; see editor.js.
   */
  function slot(edit, value, opts) {
    const o = opts || {};
    const classes = cls(o.code && 'code', o.bold && 'font-bold', o.small && 'small', o.className);

    if (!edit) {
      const text = value || (o.emptyRule ? '________' : '');
      return o.block
        ? `<div class="${esc(classes)}">${esc(text) || '&nbsp;'}</div>`
        : `<span class="${esc(classes)}">${esc(text)}</span>`;
    }

    const style = !o.block && !o.autosize && o.width ? ` style="width:${o.width}px"` : '';
    const input =
      `<input class="${esc(cls('slot', o.autosize ? '' : classes, o.block && 'block', o.align === 'right' && 'right'))}"` +
      `${style} value="${esc(value)}" placeholder="${esc(o.placeholder || '')}"` +
      ` data-bind="${esc(o.bind)}"${o.id ? ` data-id="${esc(o.id)}"` : ''}` +
      /* Autofill remembering a receiving pharmacy's DEA is exactly the
         leftover this tool exists to avoid. */
      ` autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true">`;

    if (!o.autosize) return input;
    /* The wrapper carries the type so its hidden mirror measures the same text
       the input renders, and `.slot` inherits it straight back. */
    return `<span class="${esc(cls('autosize', classes))}" data-value="${esc(value || o.placeholder || '')}">${input}</span>`;
  }

  const heading = (text) => `<div class="micro-heading">${esc(text)}</div>`;

  /** Our own half of the "who to whom" pair — fixed by the letterhead picker. */
  function partyBlock(title, name, lines, dea) {
    return `<div class="party">
      ${heading(title)}
      <div class="party-name" style="margin-top:4px">${esc(name)}</div>
      <div class="party-lines fixed">${lines.filter(Boolean).map((l) => `<div>${esc(l)}</div>`).join('')}</div>
      <div class="code party-dea"><span class="k">DEA </span><span class="font-bold">${esc(dea || '________')}</span></div>
    </div>`;
  }

  // ===========================================================================
  // The sheet
  // ===========================================================================

  /**
   * opts:
   *   edit        — render the editable version (inputs, pickers, add-line)
   *   copyLabel   — printed at the foot so two carbon-copy halves stay apart
   *   sheetLabel  — "Schedule II" etc., when this sheet covers one class
   *   sheetIndex / sheetCount — position within a split job
   *   clients     — { status, busy } for the save-to-directory affordance
   */
  function sheet(invoice, opts) {
    const o = opts || {};
    const edit = !!o.edit;
    const from = I.locationById(invoice.fromLocationId);
    const isPurchase = invoice.docType === 'purchase';
    // While editing, every line stays visible; on paper, the empty ones drop out.
    const rows = edit ? invoice.items : invoice.items.filter(I.hasContent);
    const padding = Math.max(0, MIN_ROWS - rows.length);
    /* A Schedule II line carries its quantity in words as well as figures,
       which needs a column wide enough to hold "twenty-eight". Sheets print
       one class of drug at a time, so this widens only the sheet with CIIs. */
    const spellQty = rows.some((item) => I.groupOf(item.schedule) === 'cii');
    const t = I.totals(invoice);

    const wordmark = edit
      ? `<select class="slot slot-wordmark" data-bind="fromLocationId" title="Which of our two shops this is from">` +
        I.ourLocations.map((l) =>
          `<option value="${esc(l.id)}"${l.id === invoice.fromLocationId ? ' selected' : ''}>${esc(l.name)}</option>`).join('') +
        `</select>`
      : `<div class="wordmark">${esc(from.name)}</div>`;

    const dateSpot = edit
      ? `<input type="date" class="slot date-slot" value="${esc(invoice.date)}" data-bind="date">`
      : `<span class="font-bold">${esc(I.longDate(invoice.date) || '—')}</span>`;

    return `<div class="sheet">
  <header class="sheet-head sheet-rule">
    <div class="head-left">
      ${wordmark}
      <div class="tagline">${esc(I.tagline)}</div>
      <div class="head-addr">
        ${esc([from.street, from.street2].filter(Boolean).join(', '))} &middot; ${esc(from.cityStateZip)}<br>
        Ph ${esc(from.phone)} &middot; Fax ${slot(edit, invoice.fromFax, { bind: 'fromFax', placeholder: 'our fax', code: true, width: 104 })}
        &middot; DEA ${slot(edit, invoice.fromDea, { bind: 'fromDea', placeholder: 'our DEA', code: true, width: 88 })}
      </div>
    </div>
    <div class="head-right">
      <div class="doc-title">Drug ${isPurchase ? 'Purchase' : 'Transfer'}<br>Invoice</div>
      ${o.sheetLabel ? `<div class="doc-class">${esc(o.sheetLabel)}</div>` : ''}
      <div class="head-meta">
        <div>
          <!-- Issued by the counter in Firestore, never typed: two slips
               sharing a number would defeat the point of numbering them. -->
          <span class="k">No. </span><span class="code font-bold" data-out="number">${esc(invoice.invoiceNumber || '—')}</span>
        </div>
        <div><span class="k">Date </span>${dateSpot}</div>
      </div>
    </div>
  </header>

  <section class="parties">
    ${partyBlock(
      isPurchase ? 'Purchaser' : 'Transferred from',
      from.name,
      [[from.street, from.street2].filter(Boolean).join(', '), from.cityStateZip,
        I.contactLine(from.phone, invoice.fromFax)],
      invoice.fromDea,
    )}
    ${toBlock(invoice, edit, isPurchase, o)}
  </section>

  <section class="items">
    <table>
      <colgroup>
        <col style="width:${spellQty ? 92 : 34}px">
        <col>
        <!-- Each code column is sized to its longest real value: a full 5-4-2
             NDC, a lot number, and an MM/YYYY expiry. -->
        <col style="width:116px"><col style="width:72px"><col style="width:64px">
        <col style="width:60px"><col style="width:68px">
      </colgroup>
      <thead>
        <tr>
          <th class="num">Qty</th><th>Drug / description</th><th>NDC</th>
          <th>Lot</th><th>Exp</th><th class="num">Price</th><th class="num">Amount</th>
        </tr>
      </thead>
      <tbody data-rows>
        ${rows.map((item, i) => (edit ? editableRow(item, i, invoice) : staticRow(item))).join('\n')}
        ${padRows(padding)}
      </tbody>
    </table>

    ${edit ? `<button type="button" class="add-line" data-act="add-line">+ Add a line</button>
    <div data-out="split">${splitNote(invoice)}</div>` : ''}

    <div class="totals-wrap">
      <table class="totals"><tbody>
        <tr><td class="total-cell">Subtotal</td><td class="total-cell num code" data-out="subtotal">${esc(I.money(t.subtotal))}</td></tr>
        ${edit || t.tax !== 0 ? `<tr><td class="total-cell">Tax</td><td class="total-cell num code">${
          edit ? slot(true, invoice.tax, { bind: 'tax', placeholder: '0.00', code: true, align: 'right', width: 70 })
               : esc(I.money(t.tax))}</td></tr>` : ''}
        <tr><td class="total-label">Total</td><td class="total-value num code" data-out="total">${esc(I.money(t.total))}</td></tr>
      </tbody></table>
    </div>
  </section>

  ${edit || invoice.notes ? `<section class="notes">
    ${heading('Notes')}
    ${edit
      ? `<textarea class="slot notes-input" rows="2" placeholder="Anything worth writing on the slip" data-bind="notes">${esc(invoice.notes)}</textarea>`
      : `<div class="notes-text">${esc(invoice.notes)}</div>`}
  </section>` : ''}

  <section class="sigs">
    <div class="sig-grid">
      <div>
        <div class="sig-line"></div>
        <div class="sig-name">${slot(edit, invoice.pharmacist, { bind: 'pharmacist', placeholder: 'Pharmacist', block: true })}</div>
        ${heading('Released by (pharmacist)')}
      </div>
      <div>
        <div class="sig-line"></div>
        <div class="sig-name">${slot(edit, invoice.pickedUpBy, { bind: 'pickedUpBy', placeholder: 'Who picked it up', block: true })}</div>
        ${heading('Received / picked up by')}
      </div>
    </div>
    <div class="sheet-foot">
      <span>Keep this slip for reference</span>
      ${o.sheetCount > 1 ? `<span>Sheet ${(o.sheetIndex || 0) + 1} of ${o.sheetCount}</span>` : ''}
      ${o.copyLabel ? `<span class="font-bold">${esc(o.copyLabel)}</span>` : ''}
    </div>
  </section>
</div>`;
  }

  /** The receiving pharmacy — the half that is typed, and can be looked up. */
  function toBlock(invoice, edit, isPurchase, o) {
    const to = invoice.to;
    const dir = (o && o.clients) || null;

    let saveBtn = '';
    if (edit && dir && to.name.trim()) {
      saveBtn = dir.status === 'saved'
        ? `<span class="client-saved">In directory</span>`
        : `<button type="button" class="client-save" data-act="save-client"${dir.busy ? ' disabled' : ''}>${
            dir.busy ? 'Saving…' : dir.status === 'changed' ? 'Update saved pharmacy' : 'Save to directory'}</button>`;
    }

    /* The pharmacy name doubles as a search box over the saved directory:
       typing a few letters and picking fills the whole block — address,
       phone, fax and DEA — which is the tedious half of writing one of these. */
    const nameSpot = edit && dir
      ? `<div class="client-picker">
           <input class="slot party-name block" value="${esc(to.name)}" placeholder="Pharmacy name"
                  data-bind="to.name" data-picker="1" autocomplete="off" spellcheck="false"
                  data-1p-ignore data-lpignore="true" role="combobox" aria-expanded="false"
                  aria-autocomplete="list" aria-label="Pharmacy name — type to search saved pharmacies">
           <div data-out="client-list"></div>
         </div>`
      : slot(edit, to.name, { bind: 'to.name', placeholder: 'Pharmacy name', className: 'party-name', block: true });

    const contact = edit
      ? `<div class="code">Ph ${slot(true, to.phone, { bind: 'to.phone', placeholder: 'phone', width: 100 })}
           &middot; Fax ${slot(true, to.fax, { bind: 'to.fax', placeholder: 'fax', width: 100 })}</div>`
      : `<div class="code">${esc(I.contactLine(to.phone, to.fax))}</div>`;

    return `<div class="party">
      <div class="party-head">${heading(isPurchase ? 'Vendor' : 'Transferred to')}${saveBtn}</div>
      <div style="margin-top:4px">${nameSpot}</div>
      <div class="party-lines">
        ${slot(edit, to.street, { bind: 'to.street', placeholder: 'Street address', block: true })}
        ${slot(edit, to.cityStateZip, { bind: 'to.cityStateZip', placeholder: 'City, state, ZIP', block: true })}
        ${contact}
      </div>
      <div class="party-dea"><span class="k">DEA </span>${
        slot(edit, to.dea, { bind: 'to.dea', placeholder: 'their DEA', code: true, bold: true, width: 92, emptyRule: true })}</div>
    </div>`;
  }

  const padRows = (n) => {
    let out = '';
    for (let i = 0; i < n; i++) out += '<tr><td colspan="7">&nbsp;</td></tr>';
    return out;
  };

  /** The printed line. Figures and words both, on a CII — see model.js. */
  function staticRow(item) {
    const words = I.groupOf(item.schedule) === 'cii' ? I.spellNumberCapitalized(item.qty) : '';
    return `<tr>
      <td class="num">${esc(item.qty)}${words ? `<div class="qty-words">(${esc(words)})</div>` : ''}</td>
      <td>
        <div class="font-semibold">${esc(item.description)}${
          item.schedule ? `<span class="schedule">${esc(item.schedule)}</span>` : ''}</div>
        ${item.strength ? `<div class="small">${esc(item.strength)}</div>` : ''}
      </td>
      <td class="code">${esc(item.ndc)}</td>
      <td class="code">${esc(item.lot)}</td>
      <td class="code">${esc(item.exp)}</td>
      <td class="num code">${item.price ? esc(I.money(I.toNumber(item.price))) : ''}</td>
      <td class="num code font-semibold">${item.price ? esc(I.money(I.lineTotal(item))) : ''}</td>
    </tr>`;
  }

  /** The same line, editable. One <tr>, plus a second for the NDC lookup note. */
  function editableRow(item, index, invoice) {
    const canRemove = invoice.items.length > 1;
    /* Shown under the qty box so the words that will print are visible while
       typing, not a surprise on paper. */
    const words = I.groupOf(item.schedule) === 'cii' ? I.spellNumberCapitalized(item.qty) : '';
    const id = item.id;

    return `<tr data-row="${esc(id)}">
      <td class="num qty-cell">
        ${canRemove ? `<button type="button" class="row-remove" data-act="remove-line" data-id="${esc(id)}"
              title="Remove line ${index + 1}" aria-label="Remove line ${index + 1}">&times;</button>` : ''}
        ${slot(true, item.qty, { bind: 'item.qty', id, placeholder: '1', align: 'right', block: true })}
        <div class="qty-words" data-out="qty-words" title="Schedule II quantities print in words as well as figures">${
          words ? `(${esc(words)})` : ''}</div>
      </td>
      <td>
        <div class="desc-row">
          ${slot(true, item.description, { bind: 'item.description', id, placeholder: 'Drug name', bold: true, autosize: true })}
          <!-- Which sheet this line prints on depends entirely on this, so it
               is always visible and always settable: the FDA lookup fills it
               in, but an unknown NDC must not silently mean "not controlled". -->
          <select class="sched-select ${item.schedule ? 'schedule' : 'sched-empty'}"
                  data-bind="item.schedule" data-id="${esc(id)}"
                  title="Controlled-substance schedule — decides which sheet this line prints on"
                  aria-label="Controlled-substance schedule">
            ${I.SCHEDULES.map((s) =>
              /* The badge is only as wide as "CIII", so the uncontrolled
                 option is a dash rather than a sentence. */
              `<option value="${esc(s)}"${s === item.schedule ? ' selected' : ''}>${esc(s || '—')}</option>`).join('')}
          </select>
        </div>
        ${slot(true, item.strength, { bind: 'item.strength', id, placeholder: 'Strength & size', small: true, block: true })}
      </td>
      <td>${slot(true, item.ndc, { bind: 'item.ndc', id, placeholder: 'NDC', code: true, block: true })}</td>
      <td>${slot(true, item.lot, { bind: 'item.lot', id, placeholder: 'Lot', code: true, block: true })}</td>
      <td>${slot(true, item.exp, { bind: 'item.exp', id, placeholder: 'Exp', code: true, block: true })}</td>
      <td>${slot(true, item.price, { bind: 'item.price', id, placeholder: '0.00', code: true, align: 'right', block: true })}</td>
      <td class="num code font-semibold" data-out="amount">${item.price ? esc(I.money(I.lineTotal(item))) : ''}</td>
    </tr>
    <tr class="lookup-row" data-lookup="${esc(id)}" hidden><td></td><td colspan="6"></td></tr>`;
  }

  /**
   * Shows how the lines above will be dealt out onto separate sheets. Editor
   * only — it explains the split without reordering anything while typing.
   */
  function splitNote(invoice) {
    const sheets = I.sheetsFor(invoice);
    if (sheets.length < 2) return '';
    const word = invoice.docType === 'purchase' ? 'purchase' : 'transfer';
    return `<div class="split-note">
      <strong>Prints as ${sheets.length} separate invoices</strong> — a Schedule II ${esc(word)}
      can't share paper with anything else, and controlled stock can't share with non-controlled.
      <ul>${sheets.map((s) => `<li><span class="split-label">${esc(s.label)}</span>${
        s.invoice.items.length} ${s.invoice.items.length === 1 ? 'line' : 'lines'} &middot; ${
        esc(I.money(s.subtotal + I.toNumber(s.invoice.tax)))}</li>`).join('')}</ul>
      ${I.toNumber(invoice.tax) !== 0
        ? `<div class="split-tax">Tax is split across the sheets in proportion to what each is worth.</div>` : ''}
    </div>`;
  }

  // ===========================================================================
  // The print document
  // ===========================================================================

  /* Letter at 96 dpi with the half-inch margins drawn as padding rather than
     as an `@page` margin. Electron prints with marginType "none", which zeroes
     the printer margins and can override a CSS @page margin — so the margin
     has to be part of the page box itself for the printout to match the
     screen. Same approach as the call-in form. */
  const PAGE_CSS = `
@page { size: 8.5in 11in; margin: 0; }
/* Not only tidiness: .page carries the half-inch margin as padding, and under
   the default content-box it would come out 9.5in wide and spill onto a second
   sheet. (.sheet resets its own descendants, but not its ancestors.) */
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page {
  width: 8.5in; height: 11in; padding: 0.5in; overflow: hidden;
  page-break-after: always; break-after: page;
  display: flex; flex-direction: column;
}
.page:last-child { page-break-after: auto; break-after: auto; }
/* 9.9in, not 10: the signature block still lands at the foot of the page, but
   the tenth-inch of slack keeps rounding from spilling a blank sheet. */
.page .sheet { width: 100%; min-height: 9.9in; flex: 1; }
`;

  /**
   * The whole job: every sheet the invoice splits into, once per copy.
   *
   * Our whole set prints first and theirs second, so the stack splits in half
   * at the counter rather than having to be interleaved by hand.
   *
   * `fontCss` is the @font-face block with the faces inlined as data URIs —
   * see fonts.js. Without it the slip would come out in whatever the machine
   * falls back to, which for a legal record printed twice in two apps is not
   * good enough.
   */
  function doc(invoice, opts) {
    const o = opts || {};
    const sheets = I.sheetsFor(invoice);
    const labels = invoice.twoCopies
      ? ['Pharmacy Shop copy', 'Receiving pharmacy copy']
      : [''];

    const pages = [];
    labels.forEach((copyLabel) => {
      sheets.forEach((s) => {
        pages.push(`<div class="page">${sheet(s.invoice, {
          copyLabel,
          sheetLabel: I.sheetLabelFor(s),
          sheetIndex: s.index,
          sheetCount: s.count,
        })}</div>`);
      });
    });

    const title = `Invoice ${invoice.invoiceNumber || ''} — ${invoice.to.name || 'Pharmacy Shop'}`.trim();
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<title>${esc(title)}</title>` +
      `<style>${o.fontCss || ''}${PAGE_CSS}${CSS}</style></head>` +
      `<body>${pages.join('\n')}</body></html>`;
  }

  /** How many pieces of paper `doc()` will produce. */
  const pageCount = (invoice) => I.sheetsFor(invoice).length * (invoice.twoCopies ? 2 : 1);

  return { CSS, sheet, doc, splitNote, editableRow, staticRow, pageCount, esc };
})();
