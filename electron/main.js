'use strict';

// Electron main process. It boots the existing label server on a private
// loopback port, then loads that URL in a native window — so all of the
// current HTML/CSS/JS and the /api/print TCP-to-printer logic run unchanged.

const { app, BrowserWindow, shell, dialog, Menu } = require('electron');
const path = require('path');
const { start } = require('../server.js');

// A single instance is plenty for a desktop label tool; focus the existing
// window if the user launches it again.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let server = null;
  let mainWindow = null;

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  async function createWindow() {
    // Port 0 => OS assigns a free loopback port; nothing is exposed to the LAN.
    server = await start(0, '127.0.0.1');
    const { port } = server.address();

    mainWindow = new BrowserWindow({
      width: 1280,
      height: 900,
      minWidth: 940,
      minHeight: 620,
      title: 'Zebra Label Printer',
      backgroundColor: '#0f1115',
      show: false,
      icon: path.join(__dirname, '..', 'build', 'icon.png'),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // End users don't need the default application menu / dev tooling.
    Menu.setApplicationMenu(null);
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('closed', () => { mainWindow = null; });

    // Any target="_blank" / external link opens in the system browser.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });

    await mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  }

  app.whenReady()
    .then(createWindow)
    .catch((err) => {
      dialog.showErrorBox(
        'Could not start Zebra Label Printer',
        String((err && err.stack) || err)
      );
      app.quit();
    });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('quit', () => {
    try { server && server.close(); } catch { /* ignore */ }
  });
}
