'use strict';
/*
 * GS1 pieces for the Bottle Label tab.
 *
 * The square code on a drug bottle is a GS1 DataMatrix (it looks like a QR
 * code, but pharmacy scanners and DSCSA systems expect DataMatrix). It holds
 * four "application identifiers":
 *
 *   (01) GTIN-14   "003" + the 10-digit NDC + a check digit
 *   (17) expiry    YYMMDD — DD of 00 means "end of that month"
 *   (10) lot       up to 20 characters
 *   (21) serial    up to 20 characters
 *   (30) quantity  how many are in the bottle, up to 8 digits
 *
 * Lot, serial and quantity are variable length, so a separator (FNC1) has to
 * follow any of them that isn't last. That is why the fixed-length fields go
 * first and the quantity goes last.
 */
var GS1 = (function () {
  /** GS1 mod-10 check digit for a string of digits (weights 3,1,3… from the right). */
  function checkDigit(body) {
    let sum = 0;
    for (let i = 0; i < body.length; i++) {
      const digit = Number(body[body.length - 1 - i]);
      sum += digit * (i % 2 === 0 ? 3 : 1);
    }
    return String((10 - (sum % 10)) % 10);
  }

  function gtinFromNdc10(ndc10) {
    if (!/^\d{10}$/.test(ndc10 || '')) return null;
    const body = '003' + ndc10;
    return body + checkDigit(body);
  }

  const validGtin = (gtin) =>
    /^\d{14}$/.test(gtin) && checkDigit(gtin.slice(0, 13)) === gtin[13];

  // ---- Expiration --------------------------------------------------------

  const MONTHS = {
    JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
    JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
  };
  const two = (n) => String(n).padStart(2, '0');
  const fullYear = (y) => (String(y).length === 2 ? 2000 + Number(y) : Number(y));
  const daysIn = (year, month) => new Date(year, month, 0).getDate();

  /**
   * Accepts what's printed on bottles: 03/2027, 03/27, 03/31/2027, 2027-03-31,
   * 2027-03, MAR 2027, 31 MAR 2027, MAR 31 2027. Returns null for empty text,
   * { error } when it can't tell, otherwise the pieces the label needs.
   */
  function parseExpiry(raw) {
    const text = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
    if (!text) return null;
    let y, m, d = 0, match;

    if ((match = /^(\d{1,2})[/\-. ](\d{4}|\d{2})$/.exec(text))) {
      [m, y] = [match[1], match[2]];
    } else if ((match = /^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{4}|\d{2})$/.exec(text))) {
      [m, d, y] = [match[1], match[2], match[3]];
    } else if ((match = /^(\d{4})[/\-.](\d{1,2})(?:[/\-.](\d{1,2}))?$/.exec(text))) {
      [y, m, d] = [match[1], match[2], match[3] || 0];
    } else if ((match = /^([A-Za-z]{3})[A-Za-z]*\.?[ \-/,]*(?:(\d{1,2})[ ,\-/]+)?(\d{4}|\d{2})$/.exec(text))) {
      m = MONTHS[match[1].toUpperCase()];
      [d, y] = [match[2] || 0, match[3]];
    } else if ((match = /^(\d{1,2})[ \-/]?([A-Za-z]{3})[A-Za-z]*\.?[ \-/,]*(\d{4}|\d{2})$/.exec(text))) {
      m = MONTHS[match[2].toUpperCase()];
      [d, y] = [match[1], match[3]];
    } else {
      return { error: 'Try a form like 03/2027 or 03/31/2027.' };
    }

    const year = fullYear(y);
    const month = Number(m);
    const day = Number(d);
    if (!month || month < 1 || month > 12) return { error: "That month doesn't exist." };
    if (year < 2000 || year > 2099) return { error: 'The year should be 2000–2099.' };
    if (day < 0 || day > daysIn(year, month)) return { error: "That day doesn't exist in that month." };

    const yy = two(year % 100);
    // The last moment the drug is good: end of the stated day, or of the month.
    const through = new Date(year, month - 1, day || daysIn(year, month), 23, 59, 59);
    return {
      ai17: yy + two(month) + two(day),
      display: day ? `${two(month)}/${two(day)}/${year}` : `${two(month)}/${year}`,
      long: day
        ? through.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
        : `${through.toLocaleDateString(undefined, { year: 'numeric', month: 'long' })} (end of month)`,
      expired: through.getTime() < Date.now(),
      through,
    };
  }

  /** "270331" → { ai17, display, … } — for values that came from a scan. */
  function expiryFromAi17(yymmdd) {
    if (!/^\d{6}$/.test(yymmdd)) return null;
    const [yy, mm, dd] = [yymmdd.slice(0, 2), yymmdd.slice(2, 4), yymmdd.slice(4, 6)];
    return Number(dd) ? `${mm}/${dd}/20${yy}` : `${mm}/20${yy}`;
  }

  // ---- Lot / serial ------------------------------------------------------

  /** GS1 "character set 82": the only characters allowed in a lot or serial. */
  const CSET82 = /^[!"%&'()*+,\-./0-9:;<=>?A-Z_a-z]*$/;

  /** Returns an error message, or '' when the value can go in the code. */
  function checkText(value, what) {
    if (!value) return '';
    if (value.length > 20) return `${what} is ${value.length} characters — the barcode allows 20.`;
    if (/\s/.test(value)) return `${what} can't contain spaces in the barcode.`;
    if (!CSET82.test(value)) {
      const bad = [...new Set(value.replace(/[!"%&'()*+,\-./0-9:;<=>?A-Z_a-z]/g, ''))].join(' ');
      return `${what} has characters the barcode can't hold: ${bad}`;
    }
    return '';
  }

  /**
   * Quantity — what's actually in the bottle. AI (30) counts whole items, so
   * that is all this takes: the unit ("tablets", "mL") is already on the label
   * in the dosage form. Returns an error message, or '' when it can go in.
   */
  function checkQuantity(value) {
    if (!value) return '';
    if (!/^\d+$/.test(value)) return 'Quantity should be a whole number, like 90.';
    if (Number(value) === 0) return 'Quantity should be more than zero.';
    if (stripZeros(value).length > 8) return 'Quantity is more digits than the barcode can hold.';
    return '';
  }

  /** "090" → "90"; what AI (30) and the label should both show. */
  const stripZeros = (value) =>
    /^\d+$/.test(value || '') ? String(Number(value)) : String(value || '').trim();

  // ---- Building the code -------------------------------------------------

  /**
   * Returns { data, hri } or null when there's no GTIN.
   *   data  — bwip-js "datamatrix" text with ^FNC1 markers (parsefnc on). A
   *           leading FNC1 is what makes the symbol GS1 DataMatrix.
   *   hri   — the human-readable "(01)…(17)…" form, for the screen.
   */
  function elementString({ gtin, ai17, lot, serial, qty }) {
    if (!gtin) return null;
    const fields = [['01', gtin]];
    if (ai17) fields.push(['17', ai17]);
    if (lot) fields.push(['10', lot]);
    if (serial) fields.push(['21', serial]);
    // Last, so its separator is the end of the code rather than an extra FNC1.
    if (qty) fields.push(['30', stripZeros(qty)]);

    let data = '^FNC1';
    fields.forEach(([ai, value], i) => {
      data += ai + value;
      const variable = ai === '10' || ai === '21' || ai === '30';
      if (variable && i < fields.length - 1) data += '^FNC1';
    });
    const hri = fields.map(([ai, value]) => `(${ai})${value}`).join('');
    return { data, hri };
  }

  // ---- Reading a scan ----------------------------------------------------

  const GS = '\x1d';
  const FIXED = { '01': 14, '02': 14, '11': 6, '12': 6, '13': 6, '15': 6, '16': 6, '17': 6, '20': 2 };
  const VARIABLE = { '10': 20, '21': 20, '22': 20, '30': 8, '37': 8, '240': 30, '241': 30, '710': 20, '711': 20, '712': 20, '713': 20, '714': 20 };

  /** Does this look like a bottle's 2D code rather than a typed NDC? */
  function looksLikeScan(raw) {
    const s = String(raw || '');
    return (
      /^\](d2|C1|Q3|e0)/.test(s) ||
      s.includes(GS) ||
      /^\(01\)\d{14}/.test(s) ||
      /^01\d{14}(1[0-7]|21|30)/.test(s)
    );
  }

  /**
   * Parse a GS1 element string from a keyboard-wedge scanner. Returns
   * { gtin, ai17, lot, serial, qty, warning }.
   *
   * Many scanners drop the invisible separator between variable fields, which
   * makes "lot then serial" impossible to split for certain. When that happens
   * we say so rather than guess quietly.
   */
  function parseScan(raw) {
    let s = String(raw || '').replace(/^\](d2|C1|Q3|e0)/, '').replace(/[\r\n]+$/, '');
    const out = {};

    if (s.startsWith('(')) {
      const re = /\((\d{2,4})\)([^(]*)/g;
      let m;
      while ((m = re.exec(s))) out[m[1]] = m[2].trim();
    } else {
      let i = 0;
      const sawSeparator = s.includes(GS);
      while (i < s.length) {
        if (s[i] === GS) { i++; continue; }
        const ai2 = s.slice(i, i + 2);
        const ai3 = s.slice(i, i + 3);
        let ai, fixed, max;
        if (FIXED[ai2]) [ai, fixed] = [ai2, FIXED[ai2]];
        else if (VARIABLE[ai2]) [ai, max] = [ai2, VARIABLE[ai2]];
        else if (VARIABLE[ai3]) [ai, max] = [ai3, VARIABLE[ai3]];
        else if (s.slice(i, i + 4) === '7003') [ai, fixed] = ['7003', 10];
        else break;
        i += ai.length;
        if (fixed) {
          out[ai] = s.slice(i, i + fixed);
          i += fixed;
        } else {
          let end = s.indexOf(GS, i);
          if (end < 0) end = s.length;
          // With no separators at all, a variable field might have swallowed
          // the next one. Cut at the field's maximum length at least.
          if (end - i > max) end = i + max;
          out[ai] = s.slice(i, end);
          if (!sawSeparator && end < s.length) out.warning = true;
          i = end;
        }
      }
      if (!sawSeparator && out['10'] && out['21'] === undefined && /21/.test(out['10'].slice(1))) {
        out.warning = true;
      }
    }

    return {
      gtin: out['01'] || '',
      ai17: out['17'] || '',
      lot: out['10'] || '',
      serial: out['21'] || '',
      qty: /^\d{1,8}$/.test(out['30'] || '') ? stripZeros(out['30']) : '',
      warning: out.warning
        ? "The scanner didn't send the separator between fields — check that the lot and serial split correctly."
        : '',
    };
  }

  return {
    checkDigit, gtinFromNdc10, validGtin,
    parseExpiry, expiryFromAi17,
    checkText, checkQuantity, stripZeros, elementString,
    looksLikeScan, parseScan,
  };
})();

if (typeof module !== 'undefined') module.exports = GS1;
