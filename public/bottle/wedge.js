'use strict';
/*
 * Barcode scanners as keyboards.
 *
 * A counter scanner is a keyboard: it types the barcode wherever the cursor
 * happens to be and presses Enter. That only helps if the cursor was already
 * in the right box, so this watches the whole tab instead — a scan anywhere,
 * even with nothing focused, is caught, the characters it typed into whatever
 * field had the cursor are put back, and the code is handed over whole.
 *
 * A burst is a scan when the characters arrive together (one keystroke every
 * few milliseconds, far faster than hands) and the result reads like a
 * barcode. Anything else is left alone, so ordinary typing still works.
 */
var Wedge = (function () {
  const GAP = 90;    // ms between keystrokes that still counts as one burst
  const IDLE = 150;  // ms of quiet that ends a burst the scanner didn't end
  const MIN = 8;     // shortest burst worth reading
  const FAST = 35;   // ms per character: above this it's hands, not a scanner

  // Keys that shouldn't interrupt a burst, but aren't part of it either.
  const HARMLESS = new Set([
    'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'NumLock',
    'Unidentified', 'Dead', 'Process',
  ]);

  /**
   * capture({ active, isScan, onScan })
   *   active — should we be listening right now (is this tab showing)?
   *   isScan — (text, { fast }) → does this burst read like a barcode?
   *   onScan — (text) → the burst was a scan; take it from here.
   */
  function capture({ active, isScan, onScan }) {
    let buf = '';
    let first = 0;     // when the burst started
    let last = 0;      // when its last character arrived
    let field = null;  // the box the scanner typed into
    let before = '';   // what was in that box before it did
    let timer = null;

    function reset() {
      buf = '';
      field = null;
      before = '';
      if (timer) { clearTimeout(timer); timer = null; }
    }

    /** Hand the burst over if it reads like a scan. Returns true if it did. */
    function deliver(event) {
      const text = buf;
      const chars = text.length;
      if (chars < MIN) return false;
      const fast = chars < 2 || (last - first) / (chars - 1) <= FAST;
      if (!isScan(text, { fast })) return false;

      // Undo the characters the scanner typed into whatever had the cursor.
      const box = field, restore = before;
      reset();
      if (box && typeof box.value === 'string' && box.isConnected) box.value = restore;
      if (event) { event.preventDefault(); event.stopPropagation(); }
      onScan(text);
      return true;
    }

    function add(ch, event) {
      if (!buf) {
        // Caught before the browser inserts anything, so this is the box as
        // the scan found it.
        const el = document.activeElement;
        field = el && typeof el.value === 'string' ? el : null;
        before = field ? field.value : '';
        first = last;
      }
      buf += ch;
      if (event && event.key !== ch) event.preventDefault(); // control characters
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; deliver(null); reset(); }, IDLE);
    }

    document.addEventListener('keydown', (e) => {
      if (!active()) { reset(); return; }

      // The event's own clock, so a busy page can't look like slow hands.
      const now = e.timeStamp || performance.now();
      if (buf && now - last > GAP) reset(); // too slow to be the same burst
      last = now;

      // Scanners often send the GS separator between fields as Ctrl+].
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === ']') { add('\x1d', e); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) { reset(); return; }

      if (e.key === 'Enter' || e.key === 'Tab') {
        const scanned = deliver(e);
        reset();
        if (!scanned) return; // an ordinary Enter: let the page have it
        return;
      }
      if (e.key.length === 1) { add(e.key, null); return; }
      if (!HARMLESS.has(e.key)) reset(); // arrows, Escape, Backspace…
    }, true);
  }

  return { capture, FAST, MIN };
})();

if (typeof module !== 'undefined') module.exports = Wedge;
