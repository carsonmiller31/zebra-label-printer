'use strict';
/*
 * The Name Tag tab.
 *
 * Type a name, pick a title, print. The tag is laid out 3" x 1" in the middle
 * of whatever stock is loaded, with dashed lines to cut along (optional).
 *
 * Uses from app.js: LABEL_W, LABEL_H, dpiEl, ipEl, postPrint(),
 * withPrintSettings(), askConfirm().
 */
(function () {
  const $ = (sel) => document.querySelector(sel);
  const f = {
    name: $('#nName'), title: $('#nTitle'), titleOther: $('#nTitleOther'),
    tagW: $('#nTagW'), tagH: $('#nTagH'), copies: $('#nCopies'), cutLines: $('#nCutLines'),
  };
  const ui = {
    preview: $('#nPreview'), sizeInfo: $('#nSizeInfo'), cutHint: $('#nCutHint'),
    notes: $('#nNotes'), print: $('#nPrint'), clear: $('#nClear'),
    status: $('#nStatus'), zpl: $('#nZpl'),
  };

  // ---- Saved settings -----------------------------------------------------

  f.tagW.value = localStorage.getItem('zebra_tag_w') || String(NameTagLayout.TAG_W_IN);
  f.tagH.value = localStorage.getItem('zebra_tag_h') || String(NameTagLayout.TAG_H_IN);
  f.titleOther.value = localStorage.getItem('zebra_tag_title_custom') || '';
  f.cutLines.checked = localStorage.getItem('zebra_tag_cutlines') !== 'off';
  const savedTitle = localStorage.getItem('zebra_tag_title');
  if (savedTitle && [...f.title.options].some((o) => o.value === savedTitle)) {
    f.title.value = savedTitle;
  }

  function saveSettings() {
    localStorage.setItem('zebra_tag_w', f.tagW.value);
    localStorage.setItem('zebra_tag_h', f.tagH.value);
    localStorage.setItem('zebra_tag_title', f.title.value);
    localStorage.setItem('zebra_tag_title_custom', f.titleOther.value);
    localStorage.setItem('zebra_tag_cutlines', f.cutLines.checked ? 'on' : 'off');
  }

  /** The title as it will print, or '' for none. */
  function title() {
    if (f.title.value === '__none') return '';
    if (f.title.value === '__other') return f.titleOther.value.trim();
    return f.title.options[f.title.selectedIndex].textContent.trim();
  }

  function syncTitleOther(focus) {
    const other = f.title.value === '__other';
    f.titleOther.hidden = !other;
    if (other && focus) f.titleOther.focus();
  }
  syncTitleOther(false); // restoring a saved title shouldn't grab the cursor

  // ---- Model --------------------------------------------------------------

  const spec = () => ({ W: LABEL_W, H: LABEL_H, dpi: Number(dpiEl.value) || 203 });
  const tagSize = () => ({
    wIn: Math.max(0.5, Number(f.tagW.value) || NameTagLayout.TAG_W_IN),
    hIn: Math.max(0.5, Number(f.tagH.value) || NameTagLayout.TAG_H_IN),
  });

  let logoError = '';

  /** The layout for what's on the form, with the mark rasterised to match. */
  async function current() {
    const s = spec();
    const tag = tagSize();
    let logo = null;
    try {
      const { maxW, maxH } = NameTagLayout.logoBox(s, tag);
      logo = await NameTagLogo.bitmap(maxW, maxH);
      logoError = '';
    } catch (e) {
      logoError = e.message;
    }
    const layout = NameTagLayout.build(
      { name: f.name.value.trim(), title: title(), logo, cutLines: f.cutLines.checked }, s, tag,
    );
    return { layout, spec: s, tag };
  }

  // ---- Render -------------------------------------------------------------

  let queued = false;
  let generation = 0;

  function render() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      draw();
    });
  }

  async function draw() {
    const mine = ++generation;
    const c = await current();
    if (mine !== generation) return; // a newer render is already on its way

    const { W, H, dpi } = c.spec;
    ui.preview.innerHTML = NameTagLayout.toSVG(c.layout, c.spec);
    ui.preview.style.aspectRatio = `${W} / ${H}`;

    const box = c.layout.box;
    ui.sizeInfo.textContent =
      `${fmtIn(box.w / dpi)}" × ${fmtIn(box.h / dpi)}" tag on ${fmtIn(W / dpi)}" × ${fmtIn(H / dpi)}" ` +
      `stock at ${dpi} dpi — change the stock under Label Setup.`;
    ui.cutHint.textContent = !c.layout.cut
      ? 'The tag fills the whole label, so there is nothing to cut off.'
      : f.cutLines.checked
        ? 'The tag prints in the middle of the label; cut along the dashed lines.'
        : 'The tag prints in the middle of the label, with no lines around it.';

    const notes = [];
    if (!f.name.value.trim()) notes.push({ text: 'Enter the name.', tone: 'err' });
    if (logoError) {
      notes.push({ text: `The logo couldn't be loaded (${logoError}) — the tag will print without it.`, tone: 'err' });
    }
    if (f.title.value === '__other' && !title()) {
      notes.push({ text: 'Type the title, or pick one from the list.', tone: 'warn' });
    }
    for (const n of c.layout.notes) notes.push({ text: n, tone: 'warn' });
    ui.notes.replaceChildren(...notes.map((n) => {
      const li = document.createElement('li');
      li.className = `tone-${n.tone}`;
      li.textContent = n.text;
      return li;
    }));

    ui.zpl.value = NameTagLayout.toZPL(c.layout, c.spec, f.copies.value);
    ui.print.disabled = printing;
  }

  const fmtIn = (v) => String(Math.round(v * 100) / 100);

  // ---- Print --------------------------------------------------------------

  let printing = false;

  function showStatus(ok, msg) {
    ui.status.className = `status show ${ok ? 'ok' : 'err'}`;
    ui.status.textContent = msg;
  }

  async function print() {
    if (printing) return;
    printing = true;
    ui.print.disabled = true;
    try {
      await printNow();
    } finally {
      printing = false;
      ui.print.disabled = false;
      ui.print.textContent = 'Print Name Tag';
      render();
    }
  }

  async function printNow() {
    if (!f.name.value.trim()) {
      showStatus(false, '✗ Enter the name first.');
      f.name.focus();
      return;
    }
    if (!ipEl.value.trim()) {
      showStatus(false, '✗ Set the printer IP address under Printer Connection first.');
      return;
    }

    const c = await current();
    const doubts = [];
    if (logoError) doubts.push("The logo couldn't be loaded, so the tag will print without it.");
    if (f.title.value !== '__none' && !title()) {
      doubts.push('There is no title under the name.');
    }
    for (const n of c.layout.notes) doubts.push(n);
    if (doubts.length && !(await askConfirm('Print this tag anyway?', { ok: 'Print anyway', detail: doubts }))) {
      return;
    }

    const copies = Math.max(1, Math.min(99, Math.floor(Number(f.copies.value) || 1)));
    ui.print.textContent = 'Printing…';
    try {
      const j = await postPrint(withPrintSettings(NameTagLayout.toZPL(c.layout, c.spec, copies)));
      if (!j.ok) {
        showStatus(false, `✗ ${j.message || j.error}`);
        return;
      }
      showStatus(true, `✓ Printed ${copies} name tag${copies === 1 ? '' : 's'} for ${f.name.value.trim()}.`);
    } catch (e) {
      showStatus(false, `✗ ${e.message}`);
    }
  }

  function newTag() {
    f.name.value = '';
    ui.status.className = 'status';
    render();
    f.name.focus();
  }

  // ---- Events -------------------------------------------------------------

  f.name.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    print();
  });
  f.titleOther.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); print(); }
  });
  f.title.addEventListener('change', () => {
    syncTitleOther(true);
    saveSettings();
    render();
  });
  for (const el of [f.name, f.titleOther, f.tagW, f.tagH, f.copies]) {
    el.addEventListener('input', () => {
      if (el === f.tagW || el === f.tagH || el === f.titleOther) saveSettings();
      render();
    });
  }
  f.cutLines.addEventListener('change', () => { saveSettings(); render(); });
  ui.print.addEventListener('click', print);
  ui.clear.addEventListener('click', newTag);
  document.addEventListener('labelsize', render);
  document.addEventListener('tabchange', (e) => { if (e.detail === 'nametag') render(); });
})();
