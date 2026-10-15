'use strict';
/*
 * Sig shorthand.
 *
 * Directions get dictated fast, so the sig box takes the codes a pharmacy
 * already writes them in — "1 tab po bid prn pain" — and spells each one out
 * the moment the word is finished (a space, comma, semicolon or new line), the
 * way the pharmacy system does: "Take 1 tablet by mouth twice daily as needed
 * pain". What's in the box is what prints, so there is never a code on the
 * slip that someone has to decode later.
 *
 * Backspace straight after an expansion puts the code back as typed, for the
 * odd time a word was meant literally.
 *
 * Left out on purpose: codes that are also English words ("as", "ad", "am"),
 * "top", and the eye/ear codes and "U" that the ISMP lists as error-prone (OD is read
 * as "once daily", U as a zero). Those get said in words on the phone anyway.
 */
var Sig = (function () {
  const CODES = {
    // How
    po: 'by mouth', sl: 'under the tongue', pr: 'rectally', pv: 'vaginally',
    ou: 'in both eyes', neb: 'by nebulizer', inh: 'by inhalation',
    sq: 'subcutaneously', subq: 'subcutaneously', sc: 'subcutaneously', im: 'into the muscle',
    // When
    qd: 'once daily', bid: 'twice daily', tid: 'three times daily', qid: 'four times daily',
    qhs: 'at bedtime', hs: 'at bedtime', qam: 'every morning', qpm: 'every evening',
    qod: 'every other day', qw: 'once weekly', qwk: 'once weekly',
    biw: 'twice weekly', tiw: 'three times weekly', qh: 'every hour',
    prn: 'as needed', ac: 'before meals', pc: 'after meals', ud: 'as directed',
    wf: 'with food', wm: 'with meals', aa: 'to the affected area',
    // What for
    sob: 'shortness of breath', 'n/v': 'nausea and vomiting', ha: 'headache',
  };

  /*
   * Units read singular or plural from the number in front of them, and carry
   * the verb a sig that opens with that number needs: "1 gtt" is instilled.
   */
  const UNITS = {
    tab: ['tablet', 'tablets', 'Take'], tabs: ['tablets', 'tablets', 'Take'],
    cap: ['capsule', 'capsules', 'Take'], caps: ['capsules', 'capsules', 'Take'],
    gtt: ['drop', 'drops', 'Instill'], gtts: ['drops', 'drops', 'Instill'],
    supp: ['suppository', 'suppositories', 'Insert'], pkt: ['packet', 'packets', 'Take'],
    tsp: ['teaspoonful', 'teaspoonfuls', 'Take'], tbsp: ['tablespoonful', 'tablespoonfuls', 'Take'],
    ml: ['mL', 'mL', 'Take'], puff: ['puff', 'puffs', 'Inhale'], puffs: ['puffs', 'puffs', 'Inhale'],
    spr: ['spray', 'sprays', 'Use'],
  };

  /* What a sig says a drug is for. After "as needed" these take a "for". */
  const REASONS = new Set(['sob', 'n/v', 'ha']);
  const NOT_A_REASON = new Set(['for', 'to', 'if', 'when', 'with', 'up', 'until', 'and', 'or', 'not',
    'max', 'maximum', 'do', 'daily', 'every', 'at', 'in', 'before', 'after', 'may', 'then', 'as', 'by']);

  /* Only as the first word: the verb the sig starts with. */
  const VERBS = { t: 'Take', tk: 'Take', inst: 'Instill', inh: 'Inhale', aaa: 'Apply to the affected area' };

  const NUMBER = /^(\d+(\.\d+)?|\d+\/\d+|\d+-\d+|½|¼|one|two|three|four|five|six|seven|eight|nine|ten)$/i;
  const NUM_WORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

  /** How many a number word stands for, for singular vs plural. A range is plural. */
  function count(word) {
    if (!word) return null;
    if (!NUMBER.test(word)) return null;
    if (/-/.test(word)) return 2;
    if (/^[½¼]$|\//.test(word)) return 0.5;
    return NUM_WORD[word.toLowerCase()] || Number(word);
  }

  /**
   * One word spelled out, or null when it isn't shorthand.
   * `before` is the sig up to the word, so the word can see where it sits.
   */
  function word(token, before = '') {
    const m = token.match(/^(.*?)([,;:]*)$/);
    const body = m[1];
    const tail = m[2];
    if (!body || NUMBER.test(body)) return null;
    const key = body.toLowerCase().replace(/\./g, '');
    const prev = (before.trim().split(/\s+/).pop()) || '';
    const atStart = !before.trim();

    // "prn pain" → "as needed for pain".
    if (/\bas needed\s+$/i.test(before) && /^[a-z/]+$/.test(key) &&
        (REASONS.has(key) || (!CODES[key] && !UNITS[key] && !NOT_A_REASON.has(key) && !/^[qx]\d/.test(key)))) {
      return { text: `for ${CODES[key] || body}${tail}`, lead: '' };
    }

    let out = null;
    let r;
    let verb = 'Take';
    if (atStart && VERBS[key]) out = VERBS[key];
    else if (UNITS[key]) { out = UNITS[key][count(prev) > 1 ? 1 : 0]; verb = UNITS[key][2]; }
    else if (CODES[key]) out = CODES[key];
    else if ((r = key.match(/^q(\d+)(?:-(\d+))?h(rs?)?$/))) {
      out = r[2] ? `every ${r[1]} to ${r[2]} hours` : r[1] === '1' ? 'every hour' : `every ${r[1]} hours`;
    } else if ((r = key.match(/^q(\d+)d(ays?)?$/))) out = `every ${r[1]} days`;
    else if ((r = key.match(/^q(\d+)wks?$/))) out = `every ${r[1]} weeks`;
    else if ((r = key.match(/^x(\d+)(d|days?|wks?|weeks?)$/))) {
      const n = r[1];
      const unit = r[2][0] === 'd' ? 'day' : 'week';
      out = `for ${n} ${unit}${n === '1' ? '' : 's'}`;
    }
    if (out == null) return null;

    // "1 po qd" — a sig that opens with a number needs its verb.
    if (/^\s*\S+\s*$/.test(before) && count(prev) != null) return { text: out + tail, lead: `${verb} ` };
    return { text: out + tail, lead: '' };
  }

  /** The sig with its first letter capitalised. */
  const capital = (s) => s.replace(/^(\s*)([a-z])/, (_, sp, c) => sp + c.toUpperCase());

  /** A whole sig spelled out, word by word. (For tests and pasted text.) */
  function expand(text) {
    let out = '';
    for (const part of text.split(/(\s+)/)) {
      if (!part || /^\s+$/.test(part)) { out += part; continue; }
      const hit = word(part, out);
      if (!hit) { out += part; continue; }
      if (hit.lead) out = out.replace(/^(\s*)/, `$1${hit.lead}`);
      out += hit.text;
    }
    return capital(out);
  }

  /**
   * Make a textarea expand shorthand as it's typed. `changed` is called after
   * the box is rewritten, since setting .value fires no input event.
   */
  function attach(el, changed = () => {}) {
    let undo = null;   // { value, caret, after } — the box just before the last expansion

    /** Spell out the word ending at `end`. → true when the box changed. */
    function expandAt(end, keepCaret) {
      const v = el.value;
      const start = v.slice(0, end).search(/\S+$/);
      if (start < 0) return false;
      const hit = word(v.slice(start, end), v.slice(0, start));
      if (!hit) return false;
      let head = v.slice(0, start);
      if (hit.lead) head = head.replace(/^(\s*)/, `$1${hit.lead}`);
      const next = capital(head + hit.text + v.slice(end));
      const caret = keepCaret + (next.length - v.length);
      undo = { value: v, caret: keepCaret, after: next };
      el.value = next;
      el.setSelectionRange(caret, caret);
      return true;
    }

    el.addEventListener('input', (e) => {
      undo = null;
      const typed = e.inputType === 'insertLineBreak' ? '\n' : e.data;
      if (e.inputType !== 'insertLineBreak' && e.inputType !== 'insertText') return;
      if (!typed || !/^[\s,;]$/.test(typed)) return;
      const caret = el.selectionStart;
      if (caret !== el.selectionEnd) return;
      if (expandAt(caret - 1, caret)) changed();
    });

    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Backspace' || !undo) return;
      if (el.value !== undo.after || el.selectionStart !== el.selectionEnd) { undo = null; return; }
      e.preventDefault();
      el.value = undo.value;
      el.setSelectionRange(undo.caret, undo.caret);
      undo = null;
      changed();
    });

    // Tabbing out straight after a code still spells it out.
    el.addEventListener('blur', () => {
      const v = el.value;
      const end = v.replace(/\s+$/, '').length;
      const changedHere = end > 0 && expandAt(end, end);
      undo = null;
      const cap = capital(el.value);
      if (cap !== el.value) el.value = cap;
      if (changedHere || el.value !== v) changed();
    });
  }

  return { word, expand, attach, CODES, UNITS };
})();

if (typeof module !== 'undefined') module.exports = Sig;
