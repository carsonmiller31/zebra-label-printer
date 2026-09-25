'use strict';

// Electron main process. It boots the existing label server on a private
// loopback port, then loads that URL in a native window — so all of the
// current HTML/CSS/JS and the /api/print TCP-to-printer logic run unchanged.

const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const path = require('path');
const { start } = require('../server.js');

// A single instance is plenty for a desktop tool; focus the existing
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

  // Prefer a stable loopback port so the page always loads from the same origin
  // (e.g. http://127.0.0.1:47929). localStorage is scoped per origin, so a
  // fixed port is what lets the app remember the saved IP/port and other
  // settings across restarts. If a candidate is already taken we try the next;
  // OS-assigned (0) is only a last resort.
  const PREFERRED_PORTS = [47929, 47930, 47931, 47932, 0];
  async function startOnStablePort() {
    for (const p of PREFERRED_PORTS) {
      try {
        return await start(p, '127.0.0.1');
      } catch (err) {
        if (err && err.code === 'EADDRINUSE') continue;
        throw err;
      }
    }
    // Every fixed candidate was busy; fall back to an OS-assigned port.
    return start(0, '127.0.0.1');
  }

  async function createWindow() {
    // Loopback-only binding; nothing is exposed to the LAN.
    server = await startOnStablePort();
    const { port } = server.address();

    mainWindow = new BrowserWindow({
      width: 1280,
      height: 900,
      minWidth: 940,
      minHeight: 620,
      title: 'Pharmacy Tools',
      backgroundColor: '#0f1115',
      show: false,
      // On Windows the .ico, so the title bar and taskbar pick the size drawn
      // for them instead of shrinking the 512px PNG (see scripts/make-icon.js).
      icon: path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        // The paper-printing bridge (printer list + print job). Nothing else
        // crosses from the page into Node.
        preload: path.join(__dirname, 'preload.js'),
      },
    });

    // End users don't need the default application menu / dev tooling.
    Menu.setApplicationMenu(null);
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('closed', () => { mainWindow = null; });
    // Electron on Windows can leave the page without keyboard focus after a
    // native dialog (typing silently goes nowhere). The page no longer opens
    // any, but hand focus back to it whenever the window is focused anyway.
    mainWindow.on('focus', () => {
      if (mainWindow && !mainWindow.webContents.isFocused()) mainWindow.webContents.focus();
    });

    // Any target="_blank" / external link opens in the system browser.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });

    await mainWindow.loadURL(`http://127.0.0.1:${port}/`);

    setupAutoUpdater();
  }

  // --- Paper printing --------------------------------------------------------
  // Zebra labels go out as raw ZPL over TCP (server.js). Ordinary sheets of
  // paper go through Chromium's printer instead: the page hands over a
  // finished HTML document, we render it in a hidden window and print that.

  ipcMain.handle('paper:printers', async () => {
    if (!mainWindow) return [];
    const list = await mainWindow.webContents.getPrintersAsync();
    return list.map((p) => ({
      name: p.name,
      displayName: p.displayName || p.name,
      isDefault: !!p.isDefault,
      status: p.status,
    }));
  });

  ipcMain.handle('paper:print', async (_event, { html, deviceName } = {}) => {
    if (typeof html !== 'string' || !html.trim()) {
      return { ok: false, error: 'Nothing to print', message: 'Nothing to print.' };
    }

    // A throwaway window holding just the form. It never shows; it exists so
    // Chromium has something laid out to print. Scripting is off — the
    // document is ours and is pure markup.
    const sheet = new BrowserWindow({
      parent: mainWindow || undefined,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        javascript: false,
      },
    });

    try {
      await sheet.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

      const opts = {
        // With a chosen printer we print straight away; without one, let the
        // user pick in the system dialog.
        silent: !!deviceName,
        printBackground: true,
        margins: { marginType: 'none' },
        pageSize: 'Letter',
        copies: 1, // copies are extra pages in the document itself
      };
      if (deviceName) opts.deviceName = deviceName;

      const result = await new Promise((resolve) => {
        sheet.webContents.print(opts, (success, failureReason) =>
          resolve({ success, failureReason })
        );
      });

      if (result.success) {
        return {
          ok: true,
          message: deviceName ? `Sent to ${deviceName}.` : 'Sent to the printer.',
        };
      }
      const reason = String(result.failureReason || '');
      if (/cancel/i.test(reason)) {
        return { ok: false, cancelled: true, message: 'Printing was cancelled.' };
      }
      return { ok: false, error: reason, message: reason || 'The printer refused the job.' };
    } catch (err) {
      const message = String((err && err.message) || err);
      return { ok: false, error: message, message };
    } finally {
      // The callback fires once the job is handed over, but tearing the window
      // down in the same tick has been known to truncate a spooling job on
      // Windows. A moment's grace costs nothing — the window is invisible.
      setTimeout(() => { if (!sheet.isDestroyed()) sheet.destroy(); }, 2000);
    }
  });

  // --- Auto-update (GitHub Releases via electron-updater) ---------------------
  // Checks the project's GitHub Releases for a newer version, downloads it in
  // the background, and offers to restart to install. The update feed is the
  // `latest.yml` published alongside each release by the build workflow.
  // The app is called Pharmacy Tools now, but the repo, the release feed and
  // the NSIS appId are deliberately unchanged: electron-updater finds the
  // installed copy by appId, so renaming those would turn every update into a
  // second, parallel installation instead of an upgrade in place.
  const UPDATE_OWNER = 'carsonmiller31';
  const UPDATE_REPO = 'zebra-label-printer';

  function setupAutoUpdater() {
    // electron-updater only works from a packaged build (it compares against the
    // installed app version); skip it during `npm start` dev runs.
    if (!app.isPackaged) return;

    let autoUpdater;
    try {
      ({ autoUpdater } = require('electron-updater'));
    } catch (err) {
      console.log('electron-updater unavailable:', err);
      return;
    }

    autoUpdater.autoDownload = true;          // fetch the update in the background
    autoUpdater.autoInstallOnAppQuit = true;  // if user picks "Later", install on next quit
    autoUpdater.allowDowngrade = false;
    autoUpdater.setFeedURL({ provider: 'github', owner: UPDATE_OWNER, repo: UPDATE_REPO });

    autoUpdater.on('error', (err) => console.log('Auto-update error:', err));
    autoUpdater.on('update-available', (info) => console.log('Update available:', info && info.version));
    autoUpdater.on('update-not-available', () => console.log('No update available.'));

    let promptShown = false;
    autoUpdater.on('update-downloaded', async (info) => {
      if (promptShown) return; // only ask once per run
      promptShown = true;
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update ready',
        message: `Pharmacy Tools ${info && info.version ? info.version : ''} is ready to install.`,
        detail: 'Restart now and the app closes, updates and reopens by itself in a few seconds. If you choose Later, it updates the next time you close the app.',
      });
      // Silent, then relaunch: no installer wizard to click through (the
      // installer keeps the existing install folder when run this way), and
      // the app comes back on its own instead of leaving you to find the icon.
      if (response === 0) autoUpdater.quitAndInstall(true, true);
    });

    const check = () =>
      autoUpdater.checkForUpdates().catch((err) => console.log('Update check failed:', err));
    setTimeout(check, 4000);                    // shortly after launch
    setInterval(check, 6 * 60 * 60 * 1000);     // and every 6 hours while running
  }

  app.whenReady()
    .then(createWindow)
    .catch((err) => {
      dialog.showErrorBox(
        'Could not start Pharmacy Tools',
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
