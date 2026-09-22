'use strict';
/*
 * The shape of one transfer slip, and the arithmetic — a port of the
 * Instruction Manual's lib/invoicing/{pharmacy,invoice,words,sheets}.ts.
 *
 * This is the half of the Invoice Builder that has no opinion about Firestore
 * or the DOM: what a line item is, what a sheet of paper costs, which sheet a
 * controlled drug has to print on, and how to spell a quantity out. It is kept
 * deliberately close to the manual's TypeScript so the two can be diffed by
 * eye when one of them changes — the same invoice, opened in either app, must
 * come out of the printer identically.
 */
var Invoicing = (function () {
  // ---------------------------------------------------------------------------
  // Us. The only information this app ships with.
  // ---------------------------------------------------------------------------

  /* Kept byte-for-byte in step with lib/invoicing/pharmacy.ts in the manual.
     The two fax numbers and Pharmacy Shop Express's DEA are still outstanding —
     they are typed onto the sheet each time until they are filled in here. */
  const ourLocations = [
    {
      id: 'pine',
      name: 'Pharmacy Shop',
      shortName: 'N Pine St (main)',
      street: '69 N Pine St',
      street2: '',
      cityStateZip: 'Blackfoot, ID 83221',
      phone: '(208) 785-3510',
      fax: '',
      dea: 'BR9023362',
    },
    {
      id: 'parkway',
      name: 'Pharmacy Shop Express',
      shortName: 'Parkway Dr (clinic)',
      street: '1441 Parkway Dr',
      street2: 'Suite A',
      cityStateZip: 'Blackfoot, ID 83221',
      phone: '(208) 684-7011',
      fax: '',
      dea: '',
    },
  ];

  /** Whoever signs off most often — still just a default, always editable. */
  const defaultPharmacist = 'Allen Leavitt';
  const tagline = 'When you expect the best!';

  const locationById = (id) => ourLocations.find((l) => l.id === id) || ourLocations[0];

  // ---------------------------------------------------------------------------
  // The invoice
  // ---------------------------------------------------------------------------

  /* A counter rather than a random id. In the manual this was so a server
     render and a client hydration agreed; here it is simply the cheapest
     stable key, and it keeps the saved records identical in shape. */
  let seq = 0;
  function newLineItem() {
    return {
      id: `line-${++seq}`,
      qty: '1',
      description: '',
      strength: '',
      ndc: '',
      lot: '',
      exp: '',
      price: '',
      /** DEA schedule ("CII"…"CV") when the NDC lookup finds a controlled drug. */
      schedule: '',
    };
  }

  function blankInvoice() {
    return {
      invoiceNumber: '',
      date: '',
      fromLocationId: ourLocations[0].id,
      fromDea: ourLocations[0].dea,
      fromFax: ourLocations[0].fax,
      pharmacist: defaultPharmacist,
      to: { name: '', street: '', cityStateZip: '', phone: '', fax: '', dea: '' },
      items: [newLineItem()],
      tax: '',
      pickedUpBy: '',
      notes: '',
      twoCopies: true,
      /** Whether an NDC may be sent to the FDA's public directory to fill a line. */
      ndcLookup: true,
      /* Same paper, two vocabularies. "transfer" is the DEA drug-transfer slip
         this was built for; "purchase" relabels the two party blocks as
         Purchaser/Vendor. Invoices saved before this field existed were all
         transfers, so a missing value reads as one rather than needing a
         migration. */
      docType: 'transfer',
    };
  }

  /**
   * A saved invoice, back from Firestore, made safe to edit and print.
   * Anything the record predates gets its default.
   *
   * Every line is given a FRESH id rather than keeping the one in the record.
   * A line's id is a per-session key for the editor, nothing more — it means
   * nothing in the document — and keeping the stored one collides: a page that
   * has minted `line-1` and then duplicates an invoice whose lines are
   * `line-1`..`line-3` would hand the next new line `line-2`, and two rows
   * sharing an id means typing into one edits the other.
   */
  function reviveInvoice(raw) {
    const base = blankInvoice();
    const inv = Object.assign(base, raw || {});
    /* A FRESH `to`, not `base.to`. The Object.assign above has already replaced
       base.to with the reference out of `raw`, so assigning onto base.to would
       be assigning raw.to onto itself: the revived invoice would SHARE the
       receiving pharmacy with the record it came from. Editing a duplicate
       would then rewrite the history entry in place, and reprinting the
       original would print the new pharmacy's name, address and DEA.
       Starting from a blank block also defaults any field the record is
       missing to "" rather than leaving it undefined, which `.trim()` throws on. */
    inv.to = Object.assign(blankInvoice().to, (raw && raw.to) || {});
    inv.docType = inv.docType === 'purchase' ? 'purchase' : 'transfer';
    const items = Array.isArray(raw && raw.items) ? raw.items : [];
    inv.items = items.length
      ? items.map((i) => {
          const line = newLineItem();
          return Object.assign(line, i, { id: line.id });
        })
      : [newLineItem()];
    return inv;
  }

  /** Blank, "$", stray commas and spaces all mean the same thing here: zero. */
  function toNumber(raw) {
    const n = Number.parseFloat(String(raw == null ? '' : raw).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }

  const lineTotal = (item) => toNumber(item.qty || '1') * toNumber(item.price);

  const money = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  function totals(invoice) {
    const subtotal = invoice.items.reduce((sum, i) => sum + lineTotal(i), 0);
    const tax = toNumber(invoice.tax);
    return { subtotal, tax, total: subtotal + tax };
  }

  /** True once there is anything worth putting on paper. */
  const hasContent = (item) =>
    Boolean(item.description.trim() || item.strength.trim() || item.ndc.trim());

  /**
   * Formats digits into "(000) 000-0000" as they're typed. Reformats from the
   * raw digits every time rather than patching the previous string, so pasting
   * a whole number and backspacing through a formatted one both land on the
   * same shape. Digits past the tenth (an extension, a stray "1") are kept on
   * the end rather than cut off.
   */
  function formatPhone(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    const local = digits.slice(0, 10);
    const extra = digits.slice(10);
    let out = local;
    if (local.length > 6) out = `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`;
    else if (local.length > 3) out = `(${local.slice(0, 3)}) ${local.slice(3)}`;
    else if (local.length > 0) out = `(${local}`;
    return out + extra;
  }

  /** Aug 5 2026 → "August 5, 2026", but only once a date has actually been set. */
  function longDate(iso) {
    if (!iso) return '';
    const [y, m, d] = String(iso).split('-').map(Number);
    if (!y || !m || !d) return iso;
    return new Date(y, m - 1, d).toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric',
    });
  }

  /** `new Date().toISOString()` is UTC, which flips a day early in Idaho. */
  function todayLocalIso() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  /** "Ph 785-3510 · Fax 785-3511", dropping whichever half is missing. */
  const contactLine = (phone, fax) =>
    [phone && `Ph ${phone}`, fax && `Fax ${fax}`].filter(Boolean).join(' · ');

  // ---------------------------------------------------------------------------
  // Spelling a quantity out in words
  // ---------------------------------------------------------------------------
  //
  // A Schedule II transfer has to carry the quantity twice — once as a numeral
  // and once written out — so a "30" can't be turned into a "300" after the
  // fact with a pen. Everything else on the slip prints the numeral alone.
  //
  // The words are derived from the number, never typed: two fields that can
  // disagree are worse than one, and the whole point of the second copy is
  // that it corroborates the first.

  const ONES = [
    'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
    'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
    'sixteen', 'seventeen', 'eighteen', 'nineteen',
  ];
  const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

  /** Up to three digits: "four hundred seven". */
  function underThousand(n) {
    if (n < 20) return ONES[n];
    if (n < 100) {
      const rest = n % 10;
      return rest ? `${TENS[Math.floor(n / 10)]}-${ONES[rest]}` : TENS[n / 10];
    }
    const rest = n % 100;
    const head = `${ONES[Math.floor(n / 100)]} hundred`;
    return rest ? `${head} ${underThousand(rest)}` : head;
  }

  const SCALES = [[1000000, 'million'], [1000, 'thousand']];

  function whole(n) {
    if (n < 1000) return underThousand(n);
    for (const [size, name] of SCALES) {
      if (n >= size) {
        const rest = n % size;
        const head = `${whole(Math.floor(n / size))} ${name}`;
        return rest ? `${head} ${whole(rest)}` : head;
      }
    }
    return underThousand(n);
  }

  /** Bigger than anything a transfer slip carries — past this, don't guess. */
  const MAX = 999999999;

  /**
   * "30" → "thirty", "7.5" → "seven point five".
   *
   * Returns "" for anything that isn't a plain positive amount — a blank
   * field, a range like "30-60", a "1 bottle". A pharmacist who writes
   * something the parser doesn't recognise gets no words rather than wrong
   * ones, and can write the count in by hand.
   */
  function spellNumber(raw) {
    const text = String(raw || '').trim();
    if (!/^\d+(\.\d+)?$/.test(text)) return '';
    const [intPart, decPart] = text.split('.');
    const n = Number(intPart);
    if (!Number.isFinite(n) || n > MAX) return '';
    const head = whole(n);
    // Decimals go digit by digit — "point five", never "point fifty".
    const trimmed = decPart ? decPart.replace(/0+$/, '') : '';
    if (!trimmed) return head;
    return `${head} point ${[...trimmed].map((d) => ONES[Number(d)]).join(' ')}`;
  }

  /** Title case for the printed line: "Thirty", "Seven point five". */
  function spellNumberCapitalized(raw) {
    const words = spellNumber(raw);
    return words ? words[0].toUpperCase() + words.slice(1) : '';
  }

  // ---------------------------------------------------------------------------
  // Splitting one filled-in invoice into the sheets it has to print as
  // ---------------------------------------------------------------------------
  //
  // A Schedule II transfer can't share paper with anything else, Schedules III
  // through V can sit together, and non-controlled stock goes on its own sheet
  // away from the controlleds. So a single trip to the counter can produce
  // three distinct invoices, each with its own number, totals and signatures.
  //
  // This is a DEA constraint, not formatting. The editor stays one sheet —
  // lines are never reordered under the pharmacist's cursor — and the split
  // happens only on the way to the printer.

  /** Printing order: most restricted first. */
  const GROUP_ORDER = ['cii', 'ciii-v', 'plain'];
  const GROUP_LABEL = { cii: 'Schedule II', 'ciii-v': 'Schedules III–V', plain: 'Non-controlled' };

  /** The schedules offered on each line, in the order they appear in the menu. */
  const SCHEDULES = ['', 'CII', 'CIII', 'CIV', 'CV'];

  /**
   * Which sheet a line belongs on. Accepts the FDA's spelling ("CIII"), the
   * shorthand a pharmacist might type ("C3", "3"), and treats anything
   * unrecognised as non-controlled — the schedule is shown on every line, so a
   * blank one is a visible choice rather than a silent guess.
   */
  function groupOf(schedule) {
    const s = String(schedule || '').trim().toUpperCase().replace(/[\s.-]/g, '');
    if (/^C?(II|2|I|1)$/.test(s)) return 'cii';
    if (/^C?(III|IV|V|3|4|5)$/.test(s)) return 'ciii-v';
    return 'plain';
  }

  /**
   * Split a hand-typed tax amount across the sheets in proportion to what each
   * one is worth, so the parts still add up to what was entered. Whole cents,
   * with any rounding remainder landing on the first sheet.
   */
  function apportion(amount, weights) {
    const cents = Math.round(amount * 100);
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    if (!cents) return weights.map(() => 0);
    if (totalWeight <= 0) {
      // Nothing to weigh by — put it all on the first sheet rather than nowhere.
      return weights.map((_, i) => (i === 0 ? cents / 100 : 0));
    }
    const shares = weights.map((w) => Math.floor((cents * w) / totalWeight));
    shares[0] += cents - shares.reduce((a, b) => a + b, 0);
    return shares.map((c) => c / 100);
  }

  /**
   * The sheets this invoice prints as, in order. Lines with nothing on them
   * are dropped, and a group with no lines produces no sheet — so the common
   * case of one uncontrolled transfer is still exactly one piece of paper.
   */
  function sheetsFor(invoice) {
    const filled = invoice.items.filter(hasContent);
    const items = filled.length ? filled : invoice.items.slice(0, 1);

    const groups = GROUP_ORDER
      .map((key) => ({ key, items: items.filter((item) => groupOf(item.schedule) === key) }))
      .filter((g) => g.items.length > 0);
    if (!groups.length) return [];

    const subtotals = groups.map((g) =>
      g.items.reduce((sum, i) => sum + toNumber(i.qty || '1') * toNumber(i.price), 0));
    const taxes = apportion(toNumber(invoice.tax), subtotals);
    const count = groups.length;

    return groups.map((group, index) => ({
      key: group.key,
      label: GROUP_LABEL[group.key],
      index,
      count,
      subtotal: subtotals[index],
      invoice: Object.assign({}, invoice, {
        items: group.items,
        tax: taxes[index] ? taxes[index].toFixed(2) : '',
        /* Related but distinct documents: same base number, one suffix each,
           so a set can be traced back together without two invoices sharing
           an id. */
        invoiceNumber: count > 1 ? `${invoice.invoiceNumber}-${index + 1}` : invoice.invoiceNumber,
      }),
    }));
  }

  /** Whether a sheet's class is worth naming on the paper. */
  function sheetLabelFor(sheet) {
    if (sheet.key !== 'plain') return sheet.label;
    return sheet.count > 1 ? sheet.label : '';
  }

  /** A one-line summary of how the current invoice will come out of the printer. */
  function splitSummary(sheets, twoCopies) {
    const pages = sheets.length * (twoCopies ? 2 : 1);
    const sheetWord = sheets.length === 1 ? 'invoice' : 'separate invoices';
    const pageWord = pages === 1 ? 'page' : 'pages';
    return `${sheets.length} ${sheetWord} · ${pages} ${pageWord}`;
  }

  return {
    ourLocations, locationById, defaultPharmacist, tagline,
    newLineItem, blankInvoice, reviveInvoice,
    toNumber, lineTotal, money, totals, hasContent,
    formatPhone, longDate, todayLocalIso, contactLine,
    spellNumber, spellNumberCapitalized,
    SCHEDULES, groupOf, sheetsFor, sheetLabelFor, splitSummary,
  };
})();

if (typeof module !== 'undefined') module.exports = Invoicing;
