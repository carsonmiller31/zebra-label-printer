# Zebra Label Printer

A desktop app to print pharmacy bottle labels and staff name tags — and to
design custom labels — on a Zebra GX420d (or compatible) printer over the
network. It ships as a **standalone Windows
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

Then pick a tab: **Bottle Label** for a drug bottle, **Name Tag** for a staff
tag, or **Label Designer** to lay out your own and click **Print This Label**.

## Bottle labels

The **Bottle Label** tab prints a replacement label for a drug bottle:

1. Type the NDC and press Enter, or scan the bottle's square barcode into
   that box. The drug name, strength, form, package, manufacturer and DEA
   schedule fill in from the FDA's public NDC directory (api.fda.gov). Only the
   NDC is sent to the FDA. Lot, expiration and serial stay on this computer.
2. Type the lot, expiration (`03/2027`, `03/31/2027`, `MAR 2027`…) and serial
   number if the bottle has one. Enter moves to the next box, and Enter in the
   serial box prints.
3. After a print with a serial, the serial box clears for the next bottle.

The label carries a **GS1 DataMatrix**, the same square code manufacturers
print on bottles: (01) GTIN from the NDC, (17) expiration, (10) lot and
(21) serial. It uses the stock size set under Label Setup. 3" × 2" is the main
layout, and anything under 1.4" tall gets a compact one.

Notes for changing it:
- `public/bottle/layout.js` lays the label out once as a list of elements, and
  `public/labelcore.js` draws that one list as both the on-screen preview (SVG)
  and the ZPL. Text uses the printer font `^A0`; its character widths are
  measured into a table in `labelcore.js` so every line is shrunk or wrapped
  before it's sent, because ZPL would just run it off the edge.
- The barcode is encoded by `bwip-js` (served from `node_modules` at
  `/vendor/bwip-js.js`) and printed as a `^GF` bitmap, so the preview and
  the printout come from the same bits.
- An 11-digit NDC is ambiguous (any segment starting with 0 could be the
  padded one). When more than one could be, the FDA lookup decides. If the
  lookup can't, the tab asks for the code with hyphens as printed on the
  bottle. It won't guess, because a wrong guess encodes a different product.

## Name tags

The **Name Tag** tab prints a staff name tag: the pharmacy mark on the left,
the person's name beside it, and their title underneath.

1. Type the name.
2. Pick the title — Pharmacist, Pharmacy Technician and so on, or
   **Something else…** to type your own. It prints in capitals.
3. Press Enter (or **Print Name Tag**).

A name tag is **3" × 1"**, which is smaller than the 3" × 2" stock the printer
is usually loaded with, so the tag prints in the middle of the label with
dashed lines around it to cut along. Change the finished size under **Finished
tag size** if the tags you use are different; when it matches the stock exactly
there is nothing to cut and no lines are printed.

Notes for changing it:
- The mark is `public/nametag/logo.svg`. Swap that file to change the logo —
  crop it to the artwork, since the layout positions it by its own edges.
- The printer takes a bitmap, not an SVG, so `public/nametag/logo.js` draws the
  mark into a canvas at exactly the size it will print and keeps every pixel at
  least half covered. Those same dots are handed to the preview as a PNG, so the
  preview is the printout rather than an approximation of it.
- `public/nametag/layout.js` places the tag and sizes the name and title. The
  name sets the scale; if the pair won't clear the tag's height the whole stack
  is tried a step smaller until it does.

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

The installer lands in `release\Zebra-Label-Printer-Setup-<version>.exe`.

> Building the Windows installer on macOS/Linux is **not** supported here — the
> NSIS target needs Wine, which is unreliable on Apple-Silicon macOS. Use one of
> the options above.

## Shipping updates (auto-update)

Installed copies update themselves. On launch (and every 6 hours), the app
checks this repo's **GitHub Releases** via `electron-updater`, downloads any
newer version in the background, and prompts the user to **Restart now** (or it
installs on next quit). No reinstalling by hand.

To publish an update:

```bash
npm run release:patch   # 0.2.0 -> 0.2.1 : bumps package.json, commits, tags, pushes
# or: npm run release:minor for 0.2.0 -> 0.3.0
```

Pushing the `v*` tag triggers the workflow, which builds the installer and
publishes a GitHub Release containing the `.exe`, its `.blockmap`, and
`latest.yml` (the manifest the updater reads). Existing installs pick it up
automatically within a few hours — or immediately on their next launch.

**One-time bootstrap:** auto-update only works for copies that already contain
the updater (v0.2.0+). Install the **v0.2.0** build on each PC once, by hand;
every version after that arrives automatically.

Notes:
- The version in a release **must be higher** than what's installed, or nothing
  happens. The `release:*` scripts handle the bump for you.
- Because the app is unsigned, the silent updater still applies cleanly, but the
  very first manual install shows the SmartScreen "Run anyway" prompt.

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
| `electron/main.js`                    | Electron main process — server, window, auto-update |
| `server.js`                           | Label server: static files, `/api/print`, ZPL test |
| `public/`                             | The label-designer UI (HTML/CSS/JS)                |
| `public/labelcore.js`                 | Font metrics + elements → SVG preview and ZPL      |
| `public/bottle/`                      | Bottle Label tab: NDC/FDA lookup, GS1, layout, UI  |
| `public/nametag/`                     | Name Tag tab: logo bitmap, layout, UI              |
| `scripts/make-icon.js`                | Generates the app icon (no dependencies)           |
| `.github/workflows/build-windows.yml` | CI that builds the Windows installer               |

## Notes

- The `npm audit` warnings are all in **electron-builder's dev-only
  dependencies**. They are used only when building the installer and are never
  shipped inside the app.
- To change the printer defaults, label stock, or ZPL output, edit the files in
  `public/` — no build step is needed for UI changes during development.
