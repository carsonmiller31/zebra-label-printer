'use strict';
/*
 * Paper printing — the bridge to a normal (non-Zebra) printer.
 *
 * Zebra labels leave through /api/print as raw ZPL over TCP. A sheet of paper
 * is a different animal: it goes to whatever printer Windows/macOS has, through
 * Electron's own print pipeline.
 *
 * In the packaged app `window.zlNative` (electron/preload.js) is there, so we
 * can list the installed printers and print silently to the saved one — no
 * dialog, one click, paper comes out.
 *
 * In a browser (dev: `node server.js`) there is no such bridge, so the same
 * HTML is dropped into a hidden iframe and handed to the browser's own print
 * dialog. Identical output, one extra click.
 */
var PaperPrint = (function () {
  const native = (typeof window !== 'undefined' && window.zlNative) || null;

  /** True when we can print without a dialog. */
  const isNative = !!(native && native.printHtml);

  /**
   * The printers this machine knows about.
   * → [{ name, label, isDefault }]  (empty in the browser fall-back)
   */
  async function listPrinters() {
    if (!isNative) return [];
    try {
      const list = await native.listPrinters();
      return (list || []).map((p) => ({
        name: p.name,
        label: p.displayName || p.name,
        isDefault: !!p.isDefault,
      }));
    } catch (e) {
      throw new Error(e && e.message ? e.message : String(e));
    }
  }

  /**
   * Print an HTML document.
   *
   * deviceName — a printer from listPrinters(); when given, prints silently.
   *              Without one we fall back to the system print dialog.
   * → { ok, cancelled?, error?, message }
   */
  async function printDoc(html, { deviceName = '' } = {}) {
    if (isNative) return native.printHtml({ html, deviceName });
    return printViaIframe(html);
  }

  /** Browser fall-back: render off-screen, then ask the browser to print it. */
  function printViaIframe(html) {
    return new Promise((resolve) => {
      const frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      // Off-screen rather than display:none — a hidden frame has no layout and
      // some browsers then print an empty page.
      frame.style.cssText = 'position:fixed; left:-10000px; top:0; width:8.5in; height:11in; border:0;';
      frame.srcdoc = html;

      let settled = false;
      const done = (res) => {
        if (settled) return;
        settled = true;
        // Keep the frame alive briefly: removing it mid-print can cancel the job.
        setTimeout(() => frame.remove(), 3000);
        resolve(res);
      };

      frame.addEventListener('load', () => {
        try {
          const w = frame.contentWindow;
          w.focus();
          w.print();
          done({ ok: true, message: 'Sent to the browser print dialog.' });
        } catch (e) {
          done({ ok: false, error: e.message, message: e.message });
        }
      });
      frame.addEventListener('error', () => done({ ok: false, message: 'The form could not be rendered.' }));
      document.body.append(frame);
    });
  }

  return { isNative, listPrinters, printDoc };
})();
