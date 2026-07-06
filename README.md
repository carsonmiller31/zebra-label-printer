# Zebra Label Printer

A desktop app to design custom labels and print them to a Zebra GX420d (or
compatible) printer over the network. It ships as a **standalone Windows
installer** — the target PC needs nothing else installed (no Node, no browser
setup). Electron bundles its own runtime.

The app opens a normal window, runs a private label server on `127.0.0.1` only
(nothing is exposed to the network, so there is no Windows Firewall prompt), and
sends ZPL to the printer over raw TCP port 9100 — exactly as before.

## For the end user (non-technical)

1. Double-click **`Zebra Label Printer Setup <version>.exe`**.
2. Follow the installer (you can pick the install folder; it adds Start-menu and
   desktop shortcuts).
3. Launch **Zebra Label Printer**.
4. Enter the printer's **IP address** (hold the printer's feed button to print a
   config label that shows it), leave the port at `9100`, and click
   **Print Test Label** to confirm the connection.

Design labels on the canvas and click **Print This Label**.

## Getting the installer built

electron-builder produces the Windows `.exe`, and a Windows `.exe` can only be
built reliably **on Windows**. Pick whichever fits:

### Option A — GitHub Actions (no Windows PC required) — recommended

A workflow is included at `.github/workflows/build-windows.yml`.

1. Push this project to a GitHub repo.
2. The workflow builds the installer on a Windows runner automatically (on push
   to `main`, on any `v*` tag, or via **Actions ▸ Build Windows installer ▸ Run
   workflow**).
3. Download the installer from the run's **Artifacts**
   (`zebra-label-printer-windows`). Pushing a tag like `v0.1.0` also publishes a
   GitHub Release with the installer attached.

### Option B — build locally on any Windows machine

```bat
npm install
npm run dist:win
```

The installer lands in `release\Zebra Label Printer Setup <version>.exe`.

> Building the Windows installer on macOS/Linux is **not** supported here — the
> NSIS target needs Wine, which is unreliable on Apple-Silicon macOS. Use one of
> the options above.

## Development

```bash
npm install
npm start          # launch the Electron app
npm run server     # run just the label server (browser at the printed URL)
npm run make-icon  # regenerate build/icon.png
```

## Project layout

| Path                                  | Purpose                                            |
| ------------------------------------- | -------------------------------------------------- |
| `electron/main.js`                    | Electron main process — boots the server + window  |
| `server.js`                           | Label server: static files, `/api/print`, ZPL test |
| `public/`                             | The label-designer UI (HTML/CSS/JS)                |
| `scripts/make-icon.js`                | Generates the app icon (no dependencies)           |
| `.github/workflows/build-windows.yml` | CI that builds the Windows installer               |

## Notes

- The `npm audit` warnings are all in **electron-builder's dev-only
  dependencies**. They are used only when building the installer and are never
  shipped inside the app.
- To change the printer defaults, label stock, or ZPL output, edit the files in
  `public/` — no build step is needed for UI changes during development.
