'use strict';
/*
 * NDC handling for the Bottle Label tab.
 *
 * Ported from the R & J manual's Invoice Builder (lib/invoicing/ndc.ts and
 * openfda.ts), so both tools read a code the same way. The one addition is
 * resolve(): a bottle's 2D barcode carries the 10-digit NDC exactly as the
 * manufacturer assigned it, so we need to know which 10 digits those are —
 * something the invoice never had to care about.
 *
 * PRIVACY: lookup() is the only network call on this tab, and the only thing
 * it sends is the NDC — a manufacturer's product code printed on the bottle.
 * Lot, expiration and serial never leave this computer.
 */
var NDC = (function () {
  const digitsOf = (raw) => String(raw == null ? '' : raw).replace(/\D/g, '');
  const pad = (s, width) => s.padStart(width, '0');

  /** The three segments, when the typed text carried hyphens to mark them. */
  function hyphenSegments(raw) {
    const parts = String(raw).trim().split('-').filter(Boolean);
    if (parts.length !== 3 || !parts.every((p) => /^\d+$/.test(p))) return null;
    return parts;
  }

  /**
   * A 12-digit UPC-A or 13-digit EAN-13 drug barcode carries the 10-digit NDC
   * between a leading number-system digit (3 = drug) and a check digit. GS1
   * zero-pads that to a 14-digit GTIN, and a GS1-128 payload prefixes the GTIN
   * with its (01) application identifier. Reduce all of them back to NDC-10.
   */
  function embeddedNdc10(digits) {
    switch (digits.length) {
      case 10: return digits;
      case 12: return digits.startsWith('3') ? digits.slice(1, -1) : null;
      case 13: return digits.startsWith('03') ? digits.slice(2, -1) : null;
      case 14: return digits.startsWith('003') ? digits.slice(3, -1) : null;
      case 16: return digits.startsWith('01003') ? digits.slice(5, -1) : null;
      default: return null;
    }
  }

  /** Every 11-digit (5-4-2) form this text could canonicalize to. */
  function canonicalForms(raw) {
    const digits = digitsOf(raw);
    if (digits.length === 11) return [digits];

    const seg = hyphenSegments(raw);
    if (seg && seg.join('').length === 10) {
      return [pad(seg[0], 5) + pad(seg[1], 4) + pad(seg[2], 2)];
    }

    // A bare 10-digit code has unknown segmentation, so offer all three of the
    // standard 10→11 promotions (4-4-2, 5-3-2 and 5-4-1 all become 5-4-2).
    const ten = embeddedNdc10(digits);
    if (ten && ten.length === 10) {
      return [
        '0' + ten,
        ten.slice(0, 5) + '0' + ten.slice(5),
        ten.slice(0, 9) + '0' + ten.slice(9),
      ];
    }
    return [];
  }

  const trimmed = (s) => (s.startsWith('0') ? s.slice(1) : null);
  const variants = (segment) => {
    const short = trimmed(segment);
    return short ? [segment, short] : [segment];
  };

  /** Hyphenated forms to search the FDA directory with (it drops leading zeros). */
  function packageNdcCandidates(raw) {
    const out = new Set();
    for (const form of canonicalForms(raw)) {
      const [l, p, k] = [form.slice(0, 5), form.slice(5, 9), form.slice(9, 11)];
      for (const a of variants(l))
        for (const b of variants(p))
          for (const c of variants(k)) out.add(`${a}-${b}-${c}`);
    }
    return [...out];
  }

  function productNdcCandidates(raw) {
    const out = new Set();
    for (const form of canonicalForms(raw)) {
      const [l, p] = [form.slice(0, 5), form.slice(5, 9)];
      for (const a of variants(l))
        for (const b of variants(p)) out.add(`${a}-${b}`);
    }
    return [...out];
  }

  const format11 = (l, p, k) => `${pad(l, 5)}-${pad(p, 4)}-${pad(k, 2)}`;

  /**
   * What we can say about a typed code without the network.
   *
   *   ndc10    the 10 digits the barcode needs, or null when we can't tell
   *   display  the hyphenated 10-digit form as printed on the bottle, or null
   *            when the segmentation is unknown
   *   ndc11    5-4-2 billing form, when known
   *   error    set when the text can't be an NDC at all
   *
   * An 11-digit code is the hard case: it was made by padding ONE segment of
   * the real 10-digit code with a zero, and only the segment that starts with
   * a zero can have been padded. When more than one does, only the FDA can say
   * which — and guessing would print a barcode for a different product.
   */
  function resolve(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return null;
    const digits = digitsOf(text);
    const seg = hyphenSegments(text);

    if (seg) {
      const joined = seg.join('');
      if (joined.length === 10) {
        return { ndc10: joined, display: seg.join('-'), ndc11: format11(...seg) };
      }
      if (joined.length === 11 && seg[0].length === 5 && seg[1].length === 4 && seg[2].length === 2) {
        return from11(joined);
      }
      return { error: 'An NDC is 10 digits (or 11 in 5-4-2 form).' };
    }

    if (digits.length === 11) return from11(digits);
    const ten = embeddedNdc10(digits);
    if (ten) return { ndc10: ten, display: null, ndc11: null };
    if (digits.length < 10) return { error: 'Keep typing — an NDC is 10 or 11 digits.' };
    return { error: "That doesn't read as an NDC." };
  }

  function from11(d) {
    const l = d.slice(0, 5), p = d.slice(5, 9), k = d.slice(9, 11);
    const options = [];
    if (l[0] === '0') options.push([l.slice(1), p, k]);
    if (p[0] === '0') options.push([l, p.slice(1), k]);
    if (k[0] === '0') options.push([l, p, k.slice(1)]);
    const ndc11 = `${l}-${p}-${k}`;
    if (!options.length) {
      return { error: 'Not a valid 11-digit NDC — one segment should start with a padding zero.' };
    }
    if (options.length === 1) {
      return { ndc10: options[0].join(''), display: options[0].join('-'), ndc11 };
    }
    return { ndc10: null, display: null, ndc11, options: options.map((o) => o.join('-')) };
  }

  /** Resolve from the FDA's own spelling, e.g. "0093-7180-56". */
  function fromPackageNdc(packageNdc) {
    const seg = hyphenSegments(packageNdc || '');
    if (!seg || seg.join('').length !== 10) return null;
    return { ndc10: seg.join(''), display: seg.join('-'), ndc11: format11(...seg) };
  }

  const isSearchable = (raw) => packageNdcCandidates(raw).length > 0;

  // -------------------------------------------------------------------------
  // openFDA lookup
  // -------------------------------------------------------------------------

  const TIMEOUT_MS = 8000;
  const BASE = 'https://api.fda.gov/drug/ndc.json';

  /**
   * Resolves to { status: 'found', facts } | { status: 'not-found' } |
   * { status: 'error' }. Tries the exact package first (that's what gives the
   * bottle size and the real 10-digit spelling), then the product.
   */
  async function lookup(raw, signal) {
    const packages = packageNdcCandidates(raw);
    const products = productNdcCandidates(raw);
    if (!packages.length) return { status: 'not-found' };

    const byPackage = await search('packaging.package_ndc', packages, signal);
    if (byPackage.status === 'error') return { status: 'error' };
    if (byPackage.record) return { status: 'found', facts: toFacts(byPackage.record, packages) };

    const byProduct = await search('product_ndc', products, signal);
    if (byProduct.status === 'error') return { status: 'error' };
    if (byProduct.record) return { status: 'found', facts: toFacts(byProduct.record, packages) };
    return { status: 'not-found' };
  }

  async function search(field, candidates, signal) {
    // Space-separated terms are OR'd, so any one candidate matching is a hit.
    const query = candidates.map((c) => `${field}:"${c}"`).join(' ');
    const url = `${BASE}?search=${encodeURIComponent(query)}&limit=1`;
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(), TIMEOUT_MS);
    const onAbort = () => timer.abort();
    if (signal) signal.addEventListener('abort', onAbort);
    try {
      const response = await fetch(url, { signal: timer.signal });
      // 404 is the directory's way of saying "no such code", not a failure.
      if (response.status === 404) return { status: 'not-found' };
      if (!response.ok) return { status: 'error' };
      const body = await response.json();
      const record = body.results && body.results[0];
      return record ? { status: 'ok', record } : { status: 'not-found' };
    } catch {
      return { status: signal && signal.aborted ? 'not-found' : 'error' };
    } finally {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  function toFacts(record, packageCandidates) {
    const wanted = new Set(packageCandidates);
    const pack = (record.packaging || []).find((p) => p.package_ndc && wanted.has(p.package_ndc));
    const brand = tidy(record.brand_name);
    const generic = tidy(record.generic_name);
    return {
      packageNdc: pack ? pack.package_ndc : undefined,
      productNdc: record.product_ndc,
      name: brand || generic || '',
      // Only worth a line of its own when it says something the name doesn't.
      generic: brand && generic && brand.toLowerCase() !== generic.toLowerCase() ? generic : '',
      strength: strengthSummary(record.active_ingredients || []),
      dosageForm: tidy(record.dosage_form) || '',
      size: packageSize(pack && pack.description),
      schedule: (record.dea_schedule || '').trim(),
      labeler: (record.labeler_name || '').trim(),
      packageDescription: pack && pack.description ? pack.description.replace(/\s+/g, ' ').trim() : '',
    };
  }

  /** ALL CAPS and all-lowercase become Title Case; deliberate mixed case stays. */
  function tidy(value) {
    const text = (value || '').trim();
    if (!text) return '';
    const letters = text.replace(/[^a-zA-Z]/g, '');
    if (!letters) return text;
    const uniform = letters === letters.toUpperCase() || letters === letters.toLowerCase();
    if (!uniform) return text;
    return text
      .toLowerCase()
      .replace(/\b[a-z]/g, (c) => c.toUpperCase())
      .replace(/\bMl\b/g, 'mL')
      .replace(/\bMg\b/g, 'mg')
      .replace(/\bMcg\b/g, 'mcg');
  }

  /** "500 mg/1" is 500 mg per tablet; "100 [iU]/mL" carries UCUM brackets. */
  function cleanStrength(raw) {
    return raw.trim().replace(/\[|\]/g, '').replace(/\/1$/, '').replace(/(^|\s)\.(\d)/g, '$10.$2');
  }

  function strengthSummary(ingredients) {
    const parts = ingredients.filter((i) => i.strength && i.strength.trim());
    if (!parts.length) return '';
    if (parts.length === 1) return cleanStrength(parts[0].strength);
    return parts.map((i) => `${tidy(i.name)} ${cleanStrength(i.strength)}`.trim()).join(' / ');
  }

  const CONTAINERS = new Set([
    'VIAL', 'BOTTLE', 'CARTON', 'BOX', 'BLISTER PACK', 'PACKAGE', 'TUBE',
    'SYRINGE', 'AMPULE', 'AMPOULE', 'CAN', 'JAR', 'BAG', 'DRUM', 'CONTAINER',
    'PACKET', 'CUP', 'KIT', 'TRAY', 'POUCH', 'INHALER', 'PEN', 'CYLINDER',
    'BLISTER', 'STRIP', 'WRAPPER', 'DOSE PACK',
  ]);
  const MEASURES = /^(m?[lL]|[munk]?g|kg|mL|L|iU|IU|%|mEq|mmol)$/;
  const baseWord = (s) => s.split(',')[0].trim().toUpperCase();
  const plural = (word, count) => (count === 1 || /s$/i.test(word) ? word : `${word}s`);

  /** The amount the FDA lists for a package: { amount, unit, container } or null. */
  function packageParts(description) {
    if (!description) return null;
    const parsed = description
      .replace(/\([\d-]+\)/g, '')
      .split('/')
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .map((segment) => /^([\d.]+)\s+(.+?)\s+in\s+\d+\s+(.+)$/.exec(segment))
      .filter(Boolean)
      .map((m) => ({ amount: m[1], unit: m[2], container: m[3] }));
    if (!parsed.length) return null;
    return parsed.find((p) => !CONTAINERS.has(baseWord(p.unit))) || parsed[parsed.length - 1];
  }

  /**
   * What a full package holds, for the Quantity box: { count, label }, where
   * count is a whole number of tablets (or mL). Null when the FDA's wording
   * doesn't come down to one — a kit, say, or a fractional amount.
   */
  function packageCount(description) {
    const chosen = packageParts(description);
    if (!chosen) return null;
    const count = Number(chosen.amount);
    if (!Number.isInteger(count) || count <= 0 || count > 99999999) return null;
    const measure = MEASURES.test(chosen.unit.trim());
    const unit = measure ? chosen.unit.trim() : plural(tidy(baseWord(chosen.unit)).toLowerCase(), count);
    return { count: String(count), label: `${count} ${unit}` };
  }

  /** "90 TABLET in 1 BOTTLE" → "Bottle of 90 tablets"; "10 mL in 1 VIAL" → "10 mL vial". */
  function packageSize(description) {
    const chosen = packageParts(description);
    if (!chosen) return '';
    const container = tidy(baseWord(chosen.container)).toLowerCase();
    const count = Number(chosen.amount);
    if (MEASURES.test(chosen.unit.trim())) {
      return `${chosen.amount} ${chosen.unit.trim()} ${container}`.trim();
    }
    const form = plural(tidy(baseWord(chosen.unit)).toLowerCase(), count);
    const head = container ? container[0].toUpperCase() + container.slice(1) : '';
    return head ? `${head} of ${chosen.amount} ${form}` : `${chosen.amount} ${form}`;
  }

  return { resolve, fromPackageNdc, isSearchable, lookup, packageSize, packageCount, embeddedNdc10 };
})();

if (typeof module !== 'undefined') module.exports = NDC;
