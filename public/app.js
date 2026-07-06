'use strict';

// ---- Label geometry (configurable; default stock: 3" x 2" @ 203 dpi, item 300200) ----
let LABEL_W = 609; // width in dots
let LABEL_H = 406; // height in dots

const $ = (sel) => document.querySelector(sel);
const labelEl = $('#label');
const propsEl = $('#props');
const statusEl = $('#status');

let zoom = 2;
let elements = [];
let selectedId = null;
let nextId = 1;
let snapEnabled = true;
let gridSize = 10; // dots
let editingId = null;   // id of the text element currently being edited inline
let clipboard = null;   // a cloned element for copy/paste

function snapVal(v) {
  return snapEnabled ? Math.round(v / gridSize) * gridSize : Math.round(v);
}

// ---- Connection persistence ----
const ipEl = $('#ip'), portEl = $('#port');
ipEl.value = localStorage.getItem('zebra_ip') || '';
portEl.value = localStorage.getItem('zebra_port') || '9100';
ipEl.addEventListener('input', () => localStorage.setItem('zebra_ip', ipEl.value));
portEl.addEventListener('input', () => localStorage.setItem('zebra_port', portEl.value));

// ---- Label size configuration ----
const labelWEl = $('#labelW'), labelHEl = $('#labelH'), dpiEl = $('#dpi');
labelWEl.value = localStorage.getItem('zebra_label_w') || '3';
labelHEl.value = localStorage.getItem('zebra_label_h') || '2';
dpiEl.value = localStorage.getItem('zebra_dpi') || '203';

function applyLabelSize() {
  const dpi = Number(dpiEl.value) || 203;
  const wIn = Math.max(0.25, Number(labelWEl.value) || 3);
  const hIn = Math.max(0.25, Number(labelHEl.value) || 2);
  LABEL_W = Math.round(wIn * dpi);
  LABEL_H = Math.round(hIn * dpi);
  localStorage.setItem('zebra_label_w', labelWEl.value);
  localStorage.setItem('zebra_label_h', labelHEl.value);
  localStorage.setItem('zebra_dpi', dpiEl.value);
  $('#dotsInfo').textContent =
    `Printable area: ${LABEL_W} × ${LABEL_H} dots at ${dpi} dpi. ` +
    `Keep elements inside this area or they will be cut off.`;
  // Pull any elements that now fall outside the (possibly smaller) label back in.
  for (const el of elements) {
    el.x = clamp(el.x, 0, LABEL_W - 5);
    el.y = clamp(el.y, 0, LABEL_H - 5);
  }
  render();
  fitZoom();
}
[labelWEl, labelHEl, dpiEl].forEach((el) => el.addEventListener('input', applyLabelSize));

// ---- Element factory ----
function addElement(type) {
  const base = { id: nextId++, type, x: 20, y: 20 };
  let el;
  if (type === 'text') el = { ...base, text: 'Text', fontSize: 30 };
  else if (type === 'barcode') el = { ...base, data: '12345678', height: 70, moduleWidth: 2, showText: true };
  else if (type === 'qr') el = { ...base, data: 'https://example.com', mag: 4 };
  elements.push(el);
  selectedId = el.id;
  render();
}

// ---- Templates ----
function applyTemplate(name) {
  if (name === 'item-4up') applyItemLabel4Up();
}

// Item Label: four independent barcode+name units laid out 2×2 to fill the label,
// so one print produces four small item labels. Positions are derived from the
// current label size, so it adapts if the stock dimensions change.
function applyItemLabel4Up() {
  if (elements.length && !confirm('Replace the current label with the Item Label (4-up) template?')) return;
  elements = [];
  selectedId = null;

  const margin = 20, gutter = 20;
  const cellW = Math.floor((LABEL_W - 2 * margin - gutter) / 2);
  const cellH = Math.floor((LABEL_H - 2 * margin - gutter) / 2);
  const nameSize = clamp(Math.floor(cellH * 0.18), 16, 30);
  const bcHeight = clamp(cellH - nameSize - 24, 30, 80);

  let n = 1;
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 2; c++) {
      const x = margin + c * (cellW + gutter);
      const y = margin + r * (cellH + gutter);
      elements.push({ id: nextId++, type: 'text', x, y, text: 'Item ' + n, fontSize: nameSize });
      elements.push({
        id: nextId++, type: 'barcode', x, y: y + nameSize + 8,
        data: String(n).padStart(8, '0'), height: bcHeight, moduleWidth: 2, showText: true,
      });
      n++;
    }
  }
  render();
}

// ---- Rendering ----
function render() {
  renderLabel();
  renderProps();
  renderZpl();
  $('#deleteBtn').disabled = selectedId === null;
  $('#dupBtn').disabled = selectedId === null;
}

function renderLabel() {
  labelEl.style.width = LABEL_W * zoom + 'px';
  labelEl.style.height = LABEL_H * zoom + 'px';
  // Faint grid overlay when snapping is on, sized to the grid increment.
  if (snapEnabled) {
    const g = gridSize * zoom;
    labelEl.style.backgroundImage =
      'linear-gradient(to right, #eef0f3 1px, transparent 1px),' +
      'linear-gradient(to bottom, #eef0f3 1px, transparent 1px)';
    labelEl.style.backgroundSize = `${g}px ${g}px`;
  } else {
    labelEl.style.backgroundImage = 'none';
  }
  labelEl.innerHTML = '';

  for (const el of elements) {
    const node = document.createElement('div');
    node.className = 'el el-' + el.type + (el.id === selectedId ? ' selected' : '');
    node.style.left = el.x * zoom + 'px';
    node.style.top = el.y * zoom + 'px';
    node.dataset.id = el.id;

    if (el.type === 'text') {
      node.classList.add('el-text');
      node.style.fontSize = el.fontSize * zoom + 'px';
      node.textContent = el.text || ' ';
      node.addEventListener('dblclick', (e) => { e.stopPropagation(); startEditing(node, el); });
    } else if (el.type === 'barcode') {
      const w = estimateBarcodeWidth(el) * zoom;
      node.style.width = w + 'px';
      node.style.height = el.height * zoom + 'px';
      const bars = document.createElement('div');
      bars.className = 'bars';
      node.appendChild(bars);
      if (el.showText) {
        const t = document.createElement('div');
        t.className = 'bc-text';
        t.style.fontSize = 11 * zoom + 'px';
        t.textContent = el.data;
        node.appendChild(t);
      }
    } else if (el.type === 'qr') {
      const size = qrPixelSize(el) * zoom;
      node.style.width = size + 'px';
      node.style.height = size + 'px';
      node.appendChild(renderQrCanvas(el));
    }

    attachDrag(node, el);
    labelEl.appendChild(node);
  }
}

// Rough on-screen size estimates (preview only — printer renders the real thing).
function estimateBarcodeWidth(el) {
  return Math.max(60, String(el.data).length * el.moduleWidth * 11);
}
// Real QR module matrix for this element's data, memoized per element+data so a
// single render() doesn't encode twice. Uses error-correction level M to match
// the printer (^BQ ... ^FDMA — M = medium ECC, A = automatic input mode).
const qrCache = new WeakMap();
function qrMatrix(el) {
  const data = String(el.data == null ? '' : el.data);
  const hit = qrCache.get(el);
  if (hit && hit.data === data) return hit.m;
  let m;
  try { m = QR.encode(data, 'M'); }
  catch (e) { m = null; } // data too long for any QR version
  qrCache.set(el, { data, m });
  return m;
}

// Preview size in label dots = modules × magnification, matching how the printer
// scales each module by the ^BQ magnification factor.
function qrPixelSize(el) {
  const m = qrMatrix(el);
  const modules = m ? m.length : 21;
  return modules * Math.max(1, el.mag);
}

// Draw the actual QR pattern to a pixel-perfect canvas (one canvas pixel per
// module) and let CSS scale it up crisply.
function renderQrCanvas(el) {
  const canvas = document.createElement('canvas');
  canvas.className = 'qr-canvas';
  const m = qrMatrix(el);
  if (!m) { canvas.width = canvas.height = 1; return canvas; }
  const n = m.length;
  canvas.width = n;
  canvas.height = n;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, n, n);
  ctx.fillStyle = '#111';
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      if (m[y][x]) ctx.fillRect(x, y, 1, 1);
  return canvas;
}

// ---- Dragging ----
function attachDrag(node, el) {
  node.addEventListener('pointerdown', (e) => {
    if (node.isContentEditable) return; // let the caret place itself while editing
    e.preventDefault();
    selectedId = el.id;
    render();
    const startX = e.clientX, startY = e.clientY;
    const origX = el.x, origY = el.y;

    function move(ev) {
      const dx = (ev.clientX - startX) / zoom;
      const dy = (ev.clientY - startY) / zoom;
      el.x = clamp(snapVal(origX + dx), 0, LABEL_W - 5);
      el.y = clamp(snapVal(origY + dy), 0, LABEL_H - 5);
      renderLabel();
      syncPosFields(el);
    }
    function up() {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      renderProps();
      renderZpl();
    }
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// ---- Inline text editing ----
function startEditing(node, el) {
  editingId = el.id;
  selectedId = el.id;
  node.classList.add('editing');
  node.contentEditable = 'true';
  node.focus();
  // Select all existing text so typing replaces it.
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  let done = false;
  const finish = (commit) => {
    if (done) return; // Escape + blur can both fire; only run once
    done = true;
    if (commit) el.text = node.textContent.replace(/\n/g, ' ').trim() || 'Text';
    node.contentEditable = 'false';
    editingId = null;
    render();
  };
  node.addEventListener('blur', () => finish(true), { once: true });
  node.addEventListener('keydown', (e) => {
    e.stopPropagation(); // don't trigger global delete / copy shortcuts
    if (e.key === 'Enter') { e.preventDefault(); node.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
}

// ---- Copy / paste / duplicate ----
function pasteElement(src) {
  if (!src) return;
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = nextId++;
  copy.x = clamp(copy.x + 15, 0, LABEL_W - 5);
  copy.y = clamp(copy.y + 15, 0, LABEL_H - 5);
  elements.push(copy);
  selectedId = copy.id;
  render();
}

function isTyping() {
  const a = document.activeElement;
  return !!a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
}

// ---- Properties panel ----
function selected() { return elements.find((e) => e.id === selectedId); }

function renderProps() {
  const el = selected();
  if (!el) {
    propsEl.innerHTML = '<h2 style="margin-bottom:12px;">Properties</h2><div class="prop-empty">Select an element to edit it, or add one from the left.</div>';
    return;
  }
  let html = '<h2 style="margin-bottom:12px;">Properties</h2>';
  if (el.type === 'text') {
    html += field('Text', `<input data-prop="text" value="${esc(el.text)}" />`);
    html += field('Font size (dots)', `<input data-prop="fontSize" type="number" min="6" max="200" value="${el.fontSize}" />`);
  } else if (el.type === 'barcode') {
    html += field('Data (Code 128)', `<input data-prop="data" value="${esc(el.data)}" />`);
    html += field('Height (dots)', `<input data-prop="height" type="number" min="20" max="240" value="${el.height}" />`);
    html += field('Module width', `<input data-prop="moduleWidth" type="number" min="1" max="6" value="${el.moduleWidth}" />`);
    html += `<div class="checkbox-row"><input id="showText" type="checkbox" data-prop="showText" ${el.showText ? 'checked' : ''} /><label for="showText">Show text under barcode</label></div>`;
  } else if (el.type === 'qr') {
    html += field('Data', `<input data-prop="data" value="${esc(el.data)}" />`);
    html += field('Magnification (1-10)', `<input data-prop="mag" type="number" min="1" max="10" value="${el.mag}" />`);
  }
  html += `<div class="row" style="margin-top:14px;"><div>${field('X', `<input data-prop="x" type="number" value="${el.x}" />`)}</div><div>${field('Y', `<input data-prop="y" type="number" value="${el.y}" />`)}</div></div>`;
  propsEl.innerHTML = html;

  propsEl.querySelectorAll('[data-prop]').forEach((input) => {
    const evt = input.type === 'checkbox' ? 'change' : 'input';
    input.addEventListener(evt, () => {
      const prop = input.dataset.prop;
      let val;
      if (input.type === 'checkbox') val = input.checked;
      else if (input.type === 'number') val = Number(input.value);
      else val = input.value;
      el[prop] = val;
      renderLabel();
      renderZpl();
    });
  });
}

function field(label, control) {
  return `<label>${label}</label>${control}`;
}
function syncPosFields(el) {
  const x = propsEl.querySelector('[data-prop="x"]');
  const y = propsEl.querySelector('[data-prop="y"]');
  if (x) x.value = el.x;
  if (y) y.value = el.y;
}

// ---- ZPL generation ----
function zplSanitize(s) {
  // ^ and ~ are ZPL control prefixes; strip them from user data.
  return String(s).replace(/[\^~]/g, ' ');
}

function generateZpl() {
  let z = '^XA\n';
  z += `^PW${LABEL_W}\n^LL${LABEL_H}\n`;
  for (const el of elements) {
    if (el.type === 'text') {
      z += `^FO${el.x},${el.y}^A0N,${el.fontSize},${el.fontSize}^FD${zplSanitize(el.text)}^FS\n`;
    } else if (el.type === 'barcode') {
      z += `^FO${el.x},${el.y}^BY${el.moduleWidth}^BCN,${el.height},${el.showText ? 'Y' : 'N'},N,N^FD${zplSanitize(el.data)}^FS\n`;
    } else if (el.type === 'qr') {
      z += `^FO${el.x},${el.y}^BQN,2,${el.mag}^FDMA,${zplSanitize(el.data)}^FS\n`;
    }
  }
  z += '^XZ';
  return z;
}

function renderZpl() {
  $('#zpl').value = generateZpl();
}

// Prints an outline around the entire configured label so you can see exactly
// how the printable area maps onto the physical stock (diagnoses cutoff / size).
function generateBorderZpl() {
  const w = LABEL_W, h = LABEL_H;
  return [
    '^XA',
    `^PW${w}`,
    `^LL${h}`,
    '^LH0,0',
    `^FO0,0^GB${w - 1},${h - 1},3^FS`,        // full-perimeter rectangle
    `^FO10,10^A0N,28,28^FDTL ${w}x${h}^FS`,   // top-left marker + dot size
    `^FO0,${Math.round(h / 2)}^GB${w},3,3^FS`, // horizontal center line
    '^XZ',
  ].join('\n');
}

// ---- Printing ----
function showStatus(ok, msg) {
  statusEl.className = 'status show ' + (ok ? 'ok' : 'err');
  statusEl.textContent = msg;
}

// Recall the printer's last saved configuration. This is what the "Restore
// Printer Defaults" button sends, and what we append after every label so the
// printer is left in the state other software expects.
const RESTORE_ZPL = '^XA^JUR^XZ';

// Wrap a label so it prints correctly no matter what state other software left
// the printer in, then restore that state afterward — all as one job so nothing
// can slip in between:
//   1. ^LH0,0  — reset Label Home to the origin. Other software can leave a
//      non-zero Label Home offset in the printer, which shifts our labels to the
//      right (the border test already sets ^LH0,0, which is why it prints fine).
//   2. the label itself.
//   3. ^JUR    — reload the printer's saved config so other software keeps working.
function withPrintSettings(zpl) {
  // Inject ^LH0,0 immediately after the opening ^XA so positioning is forced to
  // the origin regardless of leftover printer state. (A redundant ^LH0,0 later
  // in the format, as in the border test, is harmless.)
  const prepared = zpl.replace('^XA', '^XA\n^LH0,0');
  return `${prepared}\n${RESTORE_ZPL}`;
}

// Print an actual label: apply correct settings, print, then restore. Use this
// for every label print. (The manual "Restore Printer Defaults" button calls
// sendZpl directly, since it isn't printing a label.)
function printLabel(zpl, btn) {
  return sendZpl(withPrintSettings(zpl), btn);
}

async function sendZpl(zpl, btn) {
  const ip = ipEl.value.trim();
  if (!ip) { showStatus(false, 'Enter the printer IP address first.'); return; }
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const r = await fetch('/api/print', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, port: portEl.value.trim() || '9100', zpl }),
    });
    const j = await r.json();
    showStatus(j.ok, (j.ok ? '✓ ' : '✗ ') + (j.message || j.error));
  } catch (e) {
    showStatus(false, '✗ ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ---- Events ----
document.querySelectorAll('[data-add]').forEach((b) =>
  b.addEventListener('click', () => addElement(b.dataset.add))
);
document.querySelectorAll('[data-template]').forEach((b) =>
  b.addEventListener('click', () => applyTemplate(b.dataset.template))
);
$('#deleteBtn').addEventListener('click', () => {
  elements = elements.filter((e) => e.id !== selectedId);
  selectedId = null;
  render();
});
$('#clearBtn').addEventListener('click', () => {
  if (elements.length && !confirm('Remove all elements?')) return;
  elements = [];
  selectedId = null;
  render();
});
$('#zoomIn').addEventListener('click', () => setZoom(zoom + 0.25));
$('#zoomOut').addEventListener('click', () => setZoom(zoom - 0.25));
$('#zoomFit').addEventListener('click', fitZoom);
function setZoom(z) {
  zoom = clamp(z, 0.5, 5);
  $('#zoomVal').textContent = Math.round(zoom * 100) + '%';
  renderLabel();
}

// Size the label so it fits the available canvas width (with a little breathing room).
function fitZoom() {
  const stage = document.querySelector('.canvas-stage');
  const avail = stage.clientWidth - 48; // account for stage padding
  if (avail <= 0) return;
  setZoom(avail / LABEL_W);
}

// Re-fit on window resize so it always fits the current viewport.
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(fitZoom, 120);
});

$('#testBtn').addEventListener('click', (e) => sendTest(e.target));
async function sendTest(btn) {
  // Use the server's built-in test label (independent of the designer).
  const r = await fetch('/api/test-zpl');
  const { zpl } = await r.json();
  printLabel(zpl, btn);
}

$('#printBtn').addEventListener('click', (e) => {
  if (!elements.length) { showStatus(false, 'Add at least one element to the label first.'); return; }
  printLabel(generateZpl(), e.target);
});
$('#borderBtn').addEventListener('click', (e) => printLabel(generateBorderZpl(), e.target));
$('#restoreBtn').addEventListener('click', (e) => sendZpl('^XA^JUR^XZ', e.target));

$('#snap').addEventListener('change', (e) => { snapEnabled = e.target.checked; renderLabel(); });
$('#gridSize').addEventListener('change', (e) => { gridSize = Number(e.target.value); renderLabel(); });
$('#toggleZpl').addEventListener('click', () => {
  const card = $('#zplCard');
  const show = card.style.display === 'none';
  card.style.display = show ? 'block' : 'none';
  $('#toggleZpl').textContent = show ? 'Hide ZPL' : 'Show ZPL';
});

// Deselect when clicking empty label area.
labelEl.addEventListener('pointerdown', (e) => {
  if (e.target === labelEl) { selectedId = null; render(); }
});
// Keyboard: delete, copy, paste, duplicate (ignored while typing in a field).
document.addEventListener('keydown', (e) => {
  if (isTyping()) return;
  const mod = e.metaKey || e.ctrlKey;

  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId !== null) {
    e.preventDefault();
    elements = elements.filter((x) => x.id !== selectedId);
    selectedId = null;
    render();
  } else if (mod && e.key.toLowerCase() === 'c' && selectedId !== null) {
    clipboard = JSON.parse(JSON.stringify(selected()));
  } else if (mod && e.key.toLowerCase() === 'v' && clipboard) {
    e.preventDefault();
    pasteElement(clipboard);
  } else if (mod && e.key.toLowerCase() === 'd' && selectedId !== null) {
    e.preventDefault();
    pasteElement(selected());
  }
});

$('#dupBtn').addEventListener('click', () => pasteElement(selected()));

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---- Boot with a blank label ----
applyLabelSize();
