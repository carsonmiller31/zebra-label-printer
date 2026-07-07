'use strict';

// Minimal Code 128 encoder that mirrors how the Zebra printer renders ^BCN in
// its default automatic mode: it starts in subset B (or C for a long run of
// digits) and switches to subset C to pack digit pairs, exactly like the
// printer. The point is a preview whose width matches the printed barcode —
// including the start, checksum, and stop symbols the printer always adds.
//
// Exposes window.Barcode128.encode(data) -> { bits: number[], modules: number }
//   bits    — 1 = bar, 0 = space, one entry per module, left to right
//   modules — bits.length (total module count, = printed width / module width)
(function () {
  // Bar/space width patterns for symbol values 0..106. Each string is six
  // widths (bar,space,bar,space,bar,space) summing to 11; the stop pattern
  // (106) is seven widths summing to 13.
  const PATTERNS = [
    '212222', '222122', '222221', '121223', '121322', '131222', '122213',
    '122312', '132212', '221213', '221312', '231212', '112232', '122132',
    '122231', '113222', '123122', '123221', '223211', '221132', '221231',
    '213212', '223112', '312131', '311222', '321122', '321221', '312212',
    '322112', '322211', '212123', '212321', '232121', '111323', '131123',
    '131321', '112313', '132113', '132311', '211313', '231113', '231311',
    '112133', '112331', '132131', '113123', '113321', '133121', '313121',
    '211331', '231131', '213113', '213311', '213131', '311123', '311321',
    '331121', '312113', '312311', '332111', '314111', '221411', '431111',
    '111224', '111422', '121124', '121421', '141122', '141221', '112214',
    '112412', '122114', '122411', '142112', '142211', '241211', '221114',
    '413111', '241112', '134111', '111242', '121142', '121241', '114212',
    '124112', '124211', '411212', '421112', '421211', '212141', '214121',
    '412121', '111143', '111341', '131141', '114113', '114311', '411113',
    '411311', '113141', '114131', '311141', '411131', '211412', '211214',
    '211232', '2331112',
  ];

  const START_B = 104, START_C = 105, CODE_B = 100, CODE_C = 99, STOP = 106;

  const isDigit = (c) => c >= '0' && c <= '9';

  // Subset-B value for a single character (printable ASCII 32..127 -> 0..95).
  function valB(ch) {
    const code = ch.charCodeAt(0);
    if (code >= 32 && code <= 127) return code - 32;
    return 0; // unsupported char -> space; ZPL data is sanitized upstream anyway
  }

  // Count consecutive digits starting at index i.
  function digitsFrom(str, i) {
    let n = 0;
    while (i + n < str.length && isDigit(str[i + n])) n++;
    return n;
  }

  function toCodes(text) {
    const len = text.length;
    const codes = [];
    let i = 0;
    let mode; // 'B' or 'C'

    const lead = digitsFrom(text, 0);
    if (len >= 2 && (lead >= 4 || lead === len)) {
      mode = 'C';
      codes.push(START_C);
    } else {
      mode = 'B';
      codes.push(START_B);
    }

    while (i < len) {
      if (mode === 'C') {
        if (isDigit(text[i]) && i + 1 < len && isDigit(text[i + 1])) {
          codes.push(Number(text.substr(i, 2)));
          i += 2;
        } else {
          mode = 'B';
          codes.push(CODE_B);
        }
      } else {
        const d = digitsFrom(text, i);
        // Switch to C for a run of 4+ digits, or a 2+ even run that ends the string.
        if (d >= 4 || (d >= 2 && i + d === len && d % 2 === 0)) {
          if (d % 2 === 1) { codes.push(valB(text[i])); i++; } // keep pairs even
          mode = 'C';
          codes.push(CODE_C);
        } else {
          codes.push(valB(text[i]));
          i++;
        }
      }
    }
    return codes;
  }

  function encode(data) {
    const text = String(data == null ? '' : data);
    const codes = toCodes(text);

    // Checksum: (start + sum(value * position)) mod 103, position from 1.
    let sum = codes[0];
    for (let p = 1; p < codes.length; p++) sum += codes[p] * p;
    codes.push(sum % 103);
    codes.push(STOP);

    const bits = [];
    for (const value of codes) {
      const pattern = PATTERNS[value];
      let bar = true;
      for (let k = 0; k < pattern.length; k++) {
        const w = pattern.charCodeAt(k) - 48;
        for (let j = 0; j < w; j++) bits.push(bar ? 1 : 0);
        bar = !bar;
      }
    }
    return { bits, modules: bits.length };
  }

  window.Barcode128 = { encode };
})();
