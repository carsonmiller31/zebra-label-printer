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

    setupAutoUpdater();
  }

  // --- Auto-update (GitHub Releases via electron-updater) ---------------------
  // Checks the project's GitHub Releases for a newer version, downloads it in
  // the background, and offers to restart to install. The update feed is the
  // `latest.yml` published alongside each release by the build workflow.
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
        message: `Zebra Label Printer ${info && info.version ? info.version : ''} is ready to install.`,
        detail: 'Restart now to finish updating. If you choose Later, it installs automatically the next time you close the app.',
      });
      if (response === 0) autoUpdater.quitAndInstall();
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
