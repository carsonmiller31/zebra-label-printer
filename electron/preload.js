'use strict';

// The only bridge between the page and the main process.
//
// The page is loaded over http://127.0.0.1 with contextIsolation on, so it
// cannot reach Node. Paper printing needs two things it can't do itself:
// the list of installed printers, and a print job. Both are exposed here as
// narrow, promise-returning functions — nothing else crosses over.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zlNative', {
  /** → [{ name, displayName, isDefault, status }] */
  listPrinters: () => ipcRenderer.invoke('paper:printers'),

  /**
   * Print an HTML document to a normal printer.
   * { html, deviceName } — no deviceName means "show the system dialog".
   * → { ok, cancelled?, error?, message }
   */
  printHtml: ({ html, deviceName }) =>
    ipcRenderer.invoke('paper:print', { html, deviceName }),
});
