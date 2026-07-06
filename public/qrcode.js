'use strict';
/*
 * Minimal, self-contained QR Code generator (byte mode).
 * Based on the algorithm of Nayuki's "QR Code generator library" (MIT-licensed,
 * public reference). Trimmed to what the label designer's preview needs:
 * encode a string and return a 2D boolean matrix of modules.
 *
 * Usage:  const cells = QR.encode('https://example.com', 'M'); // cells[y][x] === true when dark
 * Throws if the data is too long for the largest supported QR version (40).
 */
var QR = (function () {
  var MIN_VERSION = 1, MAX_VERSION = 40;

  // Error-correction level: format bits + table index (ordinal).
  var ECC = {
    L: { ordinal: 0, formatBits: 1 },
    M: { ordinal: 1, formatBits: 0 },
    Q: { ordinal: 2, formatBits: 3 },
    H: { ordinal: 3, formatBits: 2 },
  };

  // Number of error-correction codewords per block, indexed [ecl.ordinal][version].
  var ECC_CODEWORDS_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  ];
  // Number of error-correction blocks, indexed [ecl.ordinal][version].
  var NUM_ERROR_CORRECTION_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
  ];

  // ---- Reed-Solomon over GF(256) with the QR-standard primitive 0x11D ----
  function reedSolomonComputeDivisor(degree) {
    var result = [];
    for (var i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);
    var root = 1;
    for (var j = 0; j < degree; j++) {
      for (var k = 0; k < result.length; k++) {
        result[k] = reedSolomonMultiply(result[k], root);
        if (k + 1 < result.length) result[k] ^= result[k + 1];
      }
      root = reedSolomonMultiply(root, 0x02);
    }
    return result;
  }
  function reedSolomonComputeRemainder(data, divisor) {
    var result = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var factor = b ^ result.shift();
      result.push(0);
      divisor.forEach(function (coef, i) {
        result[i] ^= reedSolomonMultiply(coef, factor);
      });
    });
    return result;
  }
  function reedSolomonMultiply(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }

  // ---- Bit buffer ----
  function appendBits(val, len, bb) {
    for (var i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1);
  }

  function getNumRawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }
  function getNumDataCodewords(ver, ecl) {
    return Math.floor(getNumRawDataModules(ver) / 8)
      - ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
  }

  // ---- Encode text as a byte-mode segment, pick the smallest version ----
  function encodeToCodewords(text, ecl) {
    var bytes = toUtf8(text);
    // Byte-mode character-count field is 8 bits (v1-9) or 16 bits (v10+).
    var version = -1, dataCapacityBits = 0, ccBits = 0;
    for (var v = MIN_VERSION; v <= MAX_VERSION; v++) {
      ccBits = v < 10 ? 8 : 16;
      dataCapacityBits = getNumDataCodewords(v, ecl) * 8;
      var usedBits = 4 + ccBits + bytes.length * 8;
      if (usedBits <= dataCapacityBits) { version = v; break; }
    }
    if (version === -1) throw new Error('Data too long for a QR code');

    var bb = [];
    appendBits(0x4, 4, bb);            // byte mode indicator
    appendBits(bytes.length, ccBits, bb);
    bytes.forEach(function (b) { appendBits(b, 8, bb); });

    // Terminator + bit/byte padding, then alternating pad bytes.
    appendBits(0, Math.min(4, dataCapacityBits - bb.length), bb);
    appendBits(0, (8 - bb.length % 8) % 8, bb);
    for (var padByte = 0xEC; bb.length < dataCapacityBits; padByte ^= 0xEC ^ 0x11)
      appendBits(padByte, 8, bb);

    var dataCodewords = [];
    for (var i = 0; i < bb.length; i += 8) {
      var byte = 0;
      for (var j = 0; j < 8; j++) byte = (byte << 1) | bb[i + j];
      dataCodewords.push(byte);
    }
    return { version: version, ecl: ecl, dataCodewords: dataCodewords };
  }

  // ---- Interleave data + ECC codewords across blocks ----
  function addEccAndInterleave(ver, ecl, data) {
    var numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
    var blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver];
    var rawCodewords = Math.floor(getNumRawDataModules(ver) / 8);
    var numShortBlocks = numBlocks - rawCodewords % numBlocks;
    var shortBlockLen = Math.floor(rawCodewords / numBlocks);

    var blocks = [];
    var rsDiv = reedSolomonComputeDivisor(blockEccLen);
    for (var i = 0, k = 0; i < numBlocks; i++) {
      var datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
      var dat = data.slice(k, k + datLen);
      k += datLen;
      var ecc = reedSolomonComputeRemainder(dat, rsDiv);
      if (i < numShortBlocks) dat.push(0); // pad short blocks to align interleaving
      blocks.push(dat.concat(ecc));
    }

    var result = [];
    for (var col = 0; col < blocks[0].length; col++) {
      for (var b = 0; b < blocks.length; b++) {
        // Skip the padding cell in short blocks' data region.
        if (col !== shortBlockLen - blockEccLen || b >= numShortBlocks)
          result.push(blocks[b][col]);
      }
    }
    return result;
  }

  // ---- Draw the module matrix ----
  function QrCode(version, ecl, dataCodewords) {
    this.size = version * 4 + 17;
    this.modules = [];
    this.isFunction = [];
    for (var i = 0; i < this.size; i++) {
      this.modules.push(new Array(this.size).fill(false));
      this.isFunction.push(new Array(this.size).fill(false));
    }
    this.drawFunctionPatterns(version, ecl);
    var allCodewords = addEccAndInterleave(version, ecl, dataCodewords);
    this.drawCodewords(allCodewords);

    // Try all 8 masks, keep the lowest-penalty one.
    var minPenalty = Infinity, bestMask = 0, bestModules = null;
    for (var m = 0; m < 8; m++) {
      this.applyMask(m);
      this.drawFormatBits(ecl, m);
      var penalty = this.getPenaltyScore();
      if (penalty < minPenalty) {
        minPenalty = penalty;
        bestMask = m;
        bestModules = this.modules.map(function (row) { return row.slice(); });
      }
      this.applyMask(m); // undo (XOR is its own inverse)
    }
    this.mask = bestMask;
    this.modules = bestModules;
    this.drawFormatBits(ecl, bestMask);
  }

  QrCode.prototype.setFunctionModule = function (x, y, isDark) {
    this.modules[y][x] = isDark;
    this.isFunction[y][x] = true;
  };

  QrCode.prototype.drawFunctionPatterns = function (version, ecl) {
    var size = this.size, i;
    // Timing patterns.
    for (i = 0; i < size; i++) {
      this.setFunctionModule(6, i, i % 2 === 0);
      this.setFunctionModule(i, 6, i % 2 === 0);
    }
    // Finder patterns (3 corners).
    this.drawFinderPattern(3, 3);
    this.drawFinderPattern(size - 4, 3);
    this.drawFinderPattern(3, size - 4);

    // Alignment patterns.
    var alignPos = this.getAlignmentPatternPositions(version);
    var n = alignPos.length;
    for (i = 0; i < n; i++) {
      for (var j = 0; j < n; j++) {
        if (!((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)))
          this.drawAlignmentPattern(alignPos[i], alignPos[j]);
      }
    }

    // Format + version info are reserved here; filled with real data later.
    this.drawFormatBits(ecl, 0);
    this.drawVersion(version);
  };

  QrCode.prototype.drawFinderPattern = function (x, y) {
    for (var dy = -4; dy <= 4; dy++) {
      for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy));
        var xx = x + dx, yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size)
          this.setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  };

  QrCode.prototype.drawAlignmentPattern = function (x, y) {
    for (var dy = -2; dy <= 2; dy++)
      for (var dx = -2; dx <= 2; dx++)
        this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  };

  QrCode.prototype.getAlignmentPatternPositions = function (version) {
    if (version === 1) return [];
    var numAlign = Math.floor(version / 7) + 2;
    var step = Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
    var result = [6];
    for (var pos = this.size - 7; result.length < numAlign; pos -= step)
      result.splice(1, 0, pos);
    return result;
  };

  QrCode.prototype.drawFormatBits = function (ecl, mask) {
    var data = (ecl.formatBits << 3) | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412;

    var j;
    for (j = 0; j <= 5; j++) this.setFunctionModule(8, j, getBit(bits, j));
    this.setFunctionModule(8, 7, getBit(bits, 6));
    this.setFunctionModule(8, 8, getBit(bits, 7));
    this.setFunctionModule(7, 8, getBit(bits, 8));
    for (j = 9; j < 15; j++) this.setFunctionModule(14 - j, 8, getBit(bits, j));

    var size = this.size;
    for (j = 0; j < 8; j++) this.setFunctionModule(size - 1 - j, 8, getBit(bits, j));
    for (j = 8; j < 15; j++) this.setFunctionModule(8, size - 15 + j, getBit(bits, j));
    this.setFunctionModule(8, size - 8, true); // always-dark module
  };

  QrCode.prototype.drawVersion = function (version) {
    if (version < 7) return;
    var rem = version;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    var bits = (version << 12) | rem;
    var size = this.size;
    for (var j = 0; j < 18; j++) {
      var bit = getBit(bits, j);
      var a = size - 11 + j % 3, b = Math.floor(j / 3);
      this.setFunctionModule(a, b, bit);
      this.setFunctionModule(b, a, bit);
    }
  };

  QrCode.prototype.drawCodewords = function (data) {
    var size = this.size, i = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // skip vertical timing column
      for (var vert = 0; vert < size; vert++) {
        for (var k = 0; k < 2; k++) {
          var x = right - k;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  };

  QrCode.prototype.applyMask = function (mask) {
    for (var y = 0; y < this.size; y++) {
      for (var x = 0; x < this.size; x++) {
        if (this.isFunction[y][x]) continue;
        var invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = (x * y) % 2 + (x * y) % 3 === 0; break;
          case 6: invert = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
          case 7: invert = ((x + y) % 2 + (x * y) % 3) % 2 === 0; break;
        }
        if (invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
  };

  QrCode.prototype.getPenaltyScore = function () {
    var size = this.size, result = 0, x, y;
    var mods = this.modules;

    // Adjacent same-color runs in rows and columns.
    for (y = 0; y < size; y++) {
      var runColor = false, runX = 0, runHistoryR = [0, 0, 0, 0, 0, 0, 0];
      for (x = 0; x < size; x++) {
        if (mods[y][x] === runColor) {
          runX++;
          if (runX === 5) result += 3;
          else if (runX > 5) result++;
        } else {
          finderPenalty(runHistoryR, runX, size); // shift
          if (!runColor) result += finderPenaltyCount(runHistoryR) * 40;
          runColor = mods[y][x]; runX = 1;
        }
      }
      result += finderPenaltyTerminate(runHistoryR, runColor, runX, size) * 40;
    }
    for (x = 0; x < size; x++) {
      var runColorC = false, runY = 0, runHistoryC = [0, 0, 0, 0, 0, 0, 0];
      for (y = 0; y < size; y++) {
        if (mods[y][x] === runColorC) {
          runY++;
          if (runY === 5) result += 3;
          else if (runY > 5) result++;
        } else {
          finderPenalty(runHistoryC, runY, size);
          if (!runColorC) result += finderPenaltyCount(runHistoryC) * 40;
          runColorC = mods[y][x]; runY = 1;
        }
      }
      result += finderPenaltyTerminate(runHistoryC, runColorC, runY, size) * 40;
    }

    // 2x2 blocks of one color.
    for (y = 0; y < size - 1; y++) {
      for (x = 0; x < size - 1; x++) {
        var c = mods[y][x];
        if (c === mods[y][x + 1] && c === mods[y + 1][x] && c === mods[y + 1][x + 1])
          result += 3;
      }
    }

    // Balance of dark/light.
    var dark = 0;
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (mods[y][x]) dark++;
    var total = size * size;
    var k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * 10;
    return result;
  };

  // Finder-like pattern penalty helpers (operate on a 7-entry run-length history).
  function finderPenalty(runHistory, currentRunLength, size) {
    if (runHistory[0] === 0) currentRunLength += size; // add light border to first run
    runHistory.pop();
    runHistory.unshift(currentRunLength);
  }
  function finderPenaltyCount(runHistory) {
    var n = runHistory[1];
    var core = n > 0 && runHistory[2] === n && runHistory[3] === n * 3
      && runHistory[4] === n && runHistory[5] === n;
    return (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0)
      + (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0);
  }
  function finderPenaltyTerminate(runHistory, currentRunColor, currentRunLength, size) {
    if (currentRunColor) { // add light border and terminate
      finderPenalty(runHistory, currentRunLength, size);
      currentRunLength = 0;
    }
    currentRunLength += size;
    finderPenalty(runHistory, currentRunLength, size);
    return finderPenaltyCount(runHistory);
  }

  function getBit(x, i) { return ((x >>> i) & 1) !== 0; }

  function toUtf8(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F)); }
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
        var c2 = str.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      } else { out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F)); }
    }
    return out;
  }

  // Public: return the module matrix (rows of booleans) for the given text.
  function encode(text, eclKey) {
    var ecl = ECC[eclKey] || ECC.M;
    var enc = encodeToCodewords(String(text), ecl);
    var qr = new QrCode(enc.version, enc.ecl, enc.dataCodewords);
    return qr.modules;
  }

  return { encode: encode };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = QR;
