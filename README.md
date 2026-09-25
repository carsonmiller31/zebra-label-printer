# Pharmacy Tools

A desktop app for the printing and paperwork a pharmacy counter does:

- **Zebra Labels** — bottle labels, staff name tags and custom label designs, on
  a Zebra GX420d (or compatible) over the network.
- **Paper Forms** — a call-in script written down during a phone call and
  printed on the top half of an ordinary 8.5" × 11" sheet.
- **Invoices** — a drug transfer (or purchase) invoice, saved to the pharmacy's
  record and printed. The same tool as the Instruction Manual's `/invoices`
  page, on the same Firestore data.

The switch at the top right picks which one you are working with, and it is
remembered between launches.

> It was called **Zebra Label Printer** until it grew past labels. The npm
> package name, the GitHub repo and the electron-builder `appId` are all still
> `zebra-label-printer` **on purpose**: electron-updater finds an installed copy
> by `appId`, so renaming those would turn every update into a second, parallel
> installation instead of an upgrade in place.

It ships as a **standalone Windows installer** — the target PC needs nothing
else installed (no Node, no browser setup). Electron bundles its own runtime.

The app opens a normal window, runs a private label server on `127.0.0.1` only
(nothing is exposed to the network, so there is no Windows Firewall prompt), and
sends ZPL to the Zebra over raw TCP port 9100 — exactly as before. Paper goes out
through the computer's own printer instead (see **Call-in scripts** below).

## For the end user (non-technical)

1. Double-click **`Pharmacy Tools Setup <version>.exe`**.
2. Follow the installer (you can pick the install folder; it adds Start-menu and
   desktop shortcuts).
3. Launch **Pharmacy Tools**.
4. Enter the printer's **IP address** (hold the printer's feed button to print a
   config label that shows it), leave the port at `9100`, and click
   **Print Test Label** to confirm the connection.

Then pick a tab: **Bottle Label** for a drug bottle, **Name Tag** for a staff
tag, or **Label Designer** to lay out your own and click **Print This Label**.

For a phoned-in prescription, switch to **Paper Forms** instead — see below.
For a drug transfer slip, switch to **Invoices** and sign in — see below.

## Bottle labels

The **Bottle Label** tab prints a replacement label for a drug bottle:

1. **Scan the bottle's square barcode.** It fills the NDC, lot, expiration,
   serial and quantity in one go, from wherever the cursor happens to be —
   there is no box to click into first. A scan of the plain linear barcode
   fills the NDC. Or type the NDC and press Enter.
2. The drug name, strength, form, package, manufacturer and DEA schedule fill
   in from the FDA's public NDC directory (api.fda.gov). Only the NDC is sent
   to the FDA. Lot, expiration, quantity and serial stay on this computer.
3. Fill in anything the barcode didn't carry: lot, expiration (`03/2027`,
   `03/31/2027`, `MAR 2027`…), **quantity** (how many are in this bottle) and
   serial number. Enter moves to the next box, and Enter in the serial box
   prints. Under Quantity, the full package count from the FDA is one click
   away when the box is empty.
4. After a print with a serial, the serial box clears for the next bottle.

The label carries a **GS1 DataMatrix**, the same square code manufacturers
print on bottles: (01) GTIN from the NDC, (17) expiration, (10) lot,
(21) serial and (30) quantity. Down the right edge there is also a plain
**Code 128 barcode of the NDC alone** — the ten digits as the manufacturer
assigned them — for anything that scans a bare NDC, including this tab. It
runs on its side so it costs the label width rather than its height, and it is
left off (with a note) when the stock is too short for bars a scanner could
read. Along the bottom is the date and time the label was printed.

It uses the stock size set under Label Setup. 3" × 2" is the main layout, and
anything under 1.4" tall gets a compact one.

Notes for changing it:
- `public/bottle/wedge.js` is what makes a scan work anywhere on the tab: a
  scanner is a keyboard, so it watches for characters arriving together faster
  than hands can type, puts back whatever they typed into the focused box, and
  hands the whole code over. Ordinary typing is left alone — a ten-digit lot
  number typed by hand stays a lot number.
- `public/bottle/layout.js` lays the label out once as a list of elements, and
  `public/labelcore.js` draws that one list as both the on-screen preview (SVG)
  and the ZPL. Text uses the printer font `^A0`; its character widths are
  measured into a table in `labelcore.js` so every line is shrunk or wrapped
  before it's sent, because ZPL would just run it off the edge.
- The DataMatrix is encoded by `bwip-js` (served from `node_modules` at
  `/vendor/bwip-js.js`) and the NDC stripe by `public/barcode128.js`. Both
  print as a `^GF` bitmap rather than `^BC`/`^BX`, so the preview and the
  printout come from the same bits — rotation and all.
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
there is nothing to cut and no lines are printed. To print the tag without the
lines, untick **Print dashed cut lines around the tag** (remembered between runs).

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

## Call-in scripts (Paper Forms)

Switch the top-right control to **Paper Forms** to take a prescription over the
phone. Type what the office dictates into the left-hand column — patient and
date of birth, the drug, quantity, refills, the sig, the prescriber and their
NPI or DEA number, who called and the number to call back — and press
**Print Form**.

The preview on the right is not a mock-up: it is the document that goes to the
printer, scaled down. The slip is **8.5" × 5.5"**, the top half of a Letter
sheet, with the time the call was taken printed at the top right and the initials
of whoever took it in a box at the bottom. The bottom half of the page comes out
blank; a dashed line across the fold marks where to cut (that line can be turned
off in Settings).

Any field left empty prints as a ruled blank line, so printing the form with
nothing filled in gives you a pad of blanks to write on by hand.

### Finding the drug

Two ways in, because a call gives you one or the other:

- **Type the name.** Suggestions appear from the second keystroke —
  `ator` offers atorvastatin's strengths, `lipitor` finds it by brand,
  `atorva 40` narrows to the one. When several drugs match you get one row
  each; when few do, their strengths *are* the list, because that is the
  choice left to make. Arrow keys and Enter, or click. Picking a complete
  line jumps the cursor to Quantity.

  **It forgives spelling.** Whoever is typing is also listening, holding a
  phone and going fast, so `sertaline`, `amoxicilin`, `atorvsatatin` and
  `hydroclorothiazde` all land on the right drug. It also takes counter
  abbreviations (`hctz`, `apap`, `mtx`) and half of a combination (`clav`,
  `amox clav`).

  Matching runs in tiers, cheapest and most certain first — exact, prefix,
  word-prefix, contains, typo, scattered letters — and a tier is only tried
  once the ones above it have failed to fill the list, so a clean prefix is
  never pushed down by a clever fuzzy match. Typos are measured as edit
  distance (including the swapped neighbours fast typing produces) against
  the best *prefix* of a name, so a half-typed word with a slip still scores
  well. Nonsense matches nothing: `zzzz` and `xylophone` return no rows.

  Ties are broken by length and then by how many products RxNorm lists for
  the drug — a rough stand-in for how often it is dispensed. That is what
  makes `amox` Amoxicillin rather than Amoxapine, and `levo` Levothyroxine
  rather than Levodopa. Worst case is about 1.6 ms across 1,450 products.

  The matcher is `public/paper/drugsearch.js`, kept separate from the
  generated data so it can be read and changed by hand. Its behaviour is
  pinned by a table of real queries:

  ```bash
  node scripts/test-search.js
  ```

  The list is **730 drugs / 1,450 products**, held in memory so it is instant
  and works with the internet down.

  `public/paper/drugs.js` is **generated, not written**. Which drugs are on it
  is a judgement call about what a community pharmacy actually gets phoned,
  and that lives in `scripts/drug-names.txt`. Every *fact* about them — the
  strengths that exist, the dose forms, the brands — comes from **RxNorm's
  Current Prescribable Content**, the US National Library of Medicine's list
  of what can be dispensed today. To add a drug, put its name in
  `scripts/drug-names.txt` and re-run:

  ```bash
  node scripts/build-drug-list.js
  ```

  Responses are cached under `scripts/.rxnorm-cache/`; delete it to re-check
  against RxNorm. Three things the generator is deliberate about:

  - It uses the *Prescribable* feed. Plain RxNorm also carries veterinary and
    withdrawn products, and will happily offer "Amoxi-tabs 150 mg" — which is
    for dogs.
  - It reorders combination ingredients to match the name shown. RxNorm lists
    them alphabetically, so "acetaminophen 325 MG / hydrocodone 5 MG" would
    otherwise print under "Hydrocodone/Acetaminophen" with its numbers the
    wrong way round.
  - It follows prescriber convention over RxNorm's internal one: levothyroxine
    in micrograms, topicals as a percentage.

  `scripts/brand-aliases.txt` is the one hand-written part — brands people
  still say that RxNorm no longer carries, like Coumadin and Vicodin. It only
  ever adds a searchable word to an entry; it never states a fact about a
  drug. Lines written with `=` are brands, shown beside a row when one is what
  matched; lines written with `~` are abbreviations, which find a drug but are
  never displayed, because a row reading "Hydrochlorothiazide [HCTZ]" tells
  nobody anything.

- **Type the NDC** off the bottle and press **Look up**. That goes to the FDA
  directory through the same `public/bottle/ndc.js` the Bottle Label tab uses,
  and fills the drug line — and the quantity, if the package comes to a whole
  number and you haven't typed one already. The FDA's dosage form is tidied on
  the way in: "TABLET, FILM COATED" becomes "tablet", but "extended release"
  and the like are kept, because those *are* the prescription.

### Dates

The date of birth takes whatever you type — `03 31 03`, `3-31-03`, `04111958`,
`12/25/1999`. Slashes go in as the digits arrive, and leaving the box pads the
month and day and opens out a two-digit year (at or below this year → 2000s,
above → 1900s, so `03` is 2003 and `58` is 1958). Anything that isn't three
sane parts is left exactly as typed rather than silently "corrected".

### Settings

The **Settings** tab holds what doesn't change call to call, and remembers it:

| Setting          | What it does                                                        |
| ---------------- | ------------------------------------------------------------------- |
| Paper printer    | Which installed printer forms go to. Pick one and printing is a single click, no dialog. Leave it on *Ask me every time* to get the system print dialog instead. |
| Your initials    | Filled into **Taken by** on every new call, and printed in the box.  |
| Pharmacy name    | Optional; prints small under the heading.                           |
| Cut line         | Whether the dashed fold line prints.                                 |

**Print a Test Form** sends a filled-in sample so you can check the printer and
the paper size before the phone rings.

### How paper printing works

Zebra stock is raw ZPL over a TCP socket; a sheet of paper is not. Paper goes
through Chromium's own printing instead:

- `public/paper/form.js` builds the whole slip as one self-contained HTML
  document — the same document the preview shows and the printer receives.
  Copies are extra pages in that document rather than a printer copy count, so
  every path behaves the same.
- `public/paper/print.js` picks a route. In the installed app `window.zlNative`
  (from `electron/preload.js`) is there, so the document is handed to the main
  process, rendered in a hidden window and printed silently to the saved
  printer. In a browser (`npm run server`) there is no bridge, so the same HTML
  is dropped into an off-screen iframe and given to the browser's print dialog.
- `electron/main.js` answers two IPC channels and nothing else:
  `paper:printers` (the installed printer list) and `paper:print`.

### What is saved and what is not

Settings live in `localStorage`. **The call does not.** Patient name, date of
birth, drug, prescriber and phone number are held in the form and nowhere else,
and the form is deliberately cleared on load — so reloading the window, or an
update restarting it, never brings a patient back.

## Invoices

A drug transfer slip: what left the shelf, where it went, who signed for it. It
replaces the handwritten carbon-copy pad.

**This is not a second copy of that tool — it is the same one.** The Instruction
Manual (`pharmacy-manual.vercel.app/invoices`) and this tab read and write the
same Firestore collections in the same Firebase project, `pharmacy-shop-c9488`:

| Collection         | What it holds                                           |
| ------------------ | ------------------------------------------------------- |
| `invoices`         | One document per slip, keyed by its number              |
| `counters/invoices`| The next number to issue — shared, so it can't collide  |
| `pharmacies`       | The directory of places we transfer to                  |

An invoice written here appears in the manual's history straight away, and vice
versa. The numbering is one sequence across both.

### Signing in

This is the only tab behind a sign-in, and it has to be: an invoice is a
controlled-substance transfer record.

Sign in with the same email and password you use for the Instruction Manual.
Being signed in is **not** enough on its own — public sign-up is open on this
Firebase project, so access is the manual's `manualRole` custom claim (`admin`,
`editor` or `viewer`), which only an admin can grant, through **People** in the
manual. An account without one gets the no-access screen here and is refused by
`firestore.rules` server-side. The sign-in is remembered across restarts.

### Writing one

The paper **is** the editor — click any spot on the sheet and type. The letterhead
doubles as the shop picker; the receiving pharmacy's name doubles as a search box
over the saved directory, so picking one fills in its address, phone, fax and DEA.

Typing an NDC and leaving the box looks the drug up in the FDA's public directory
and fills in what is still blank (never overwriting what you typed) — except the
DEA schedule, which is a fact about the drug and is always replaced. That lookup
is **the only outbound call besides Firebase**, it sends the NDC and nothing
else, and it is a toggle in the toolbar.

### Why one invoice can print as three

A Schedule II transfer cannot share paper with anything else, Schedules III–V
can sit together, and non-controlled stock goes on its own sheet away from the
controlleds. **That is a DEA constraint, not formatting** — do not "simplify" it
into one sheet. The editor stays a single sheet (lines are never reordered under
the pharmacist's cursor) and the split happens on the way to the printer, each
part getting its own suffixed number, its own share of the tax and its own
signature lines. A Schedule II line also prints its quantity in words as well as
figures, so a "30" can't become a "300" afterwards with a pen.

### Save, then print

**Save & Print** claims a number, writes the record, and only then prints — in
that order, so nothing leaves the printer that isn't already on file. A written
invoice **cannot be edited**; `firestore.rules` allows exactly one change, and
only one way: marking it void. A mistake is corrected the way it would be on
paper — void the slip and write a new one — which is what keeps the numbering
continuous.

### The printed sheet

The sheet is **black on white on purpose**: it goes to a mono laser, so every
rule and badge is an outline rather than a fill. It is US Letter with half-inch
margins, laid out in px against 96 dpi so a millimetre on screen is a millimetre
on the slip.

Printing does **not** go through `window.print()`. The sheet on screen is an
editor full of inputs; what goes to the printer is a second, read-only rendering
of the same model, built as a standalone HTML document and handed to Chromium
through the same bridge the call-in form uses. Nothing has to be un-styled or
stripped of inputs at print time, so the printout cannot drift from the screen.
Both faces (Nunito and Nunito Sans, the manual's) are carried **inside** that
document as data URIs — the print window is a `data:` URL and could neither
fetch them cross-origin nor be relied on to finish loading them before the job
was handed over.

The printer is the same one the Call-In Script tab uses: one setting, one
machine, changeable from either place.

### Third-party files

The Firebase SDK and the two fonts are **copied into `public/` by
`npm run vendor`** and committed, rather than served out of `node_modules` the
way `/vendor/bwip-js.js` is. `firebase` is a 150 MB package and electron-builder
ships production dependencies wholesale; three files out of it are ~700 KB. So
`firebase` and `@fontsource/*` are devDependencies and only the copies ship.
Run `npm run vendor` after bumping either, and commit what changes.

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
npm run make-icon  # regenerate build/icon.ico + build/icon.png
npm run vendor     # re-copy the Firebase SDK + invoice fonts into public/
```

The Invoices tab talks to the real Firebase project in development too — there
is no emulator wired up. Reads are harmless; **don't press Save & Print while
poking at it**, because the invoice counter only moves forward and a test slip
becomes a permanent record.

## Project layout

| Path                                  | Purpose                                            |
| ------------------------------------- | -------------------------------------------------- |
| `electron/main.js`                    | Electron main process — server, window, auto-update |
| `server.js`                           | Label server: static files, `/api/print`, ZPL test |
| `public/`                             | The label-designer UI (HTML/CSS/JS)                |
| `public/labelcore.js`                 | Font metrics + elements → SVG preview and ZPL      |
| `public/bottle/`                      | Bottle Label tab: NDC/FDA lookup, GS1, layout, UI  |
| `public/nametag/`                     | Name Tag tab: logo bitmap, layout, UI              |
| `public/logo.svg`                     | The pharmacy mark — name tags, header and app icon |
| `public/paper/`                       | Call-In Script tab: printed form, print bridge, UI |
| `public/invoices/`                    | Invoices tab: model, Firestore, the sheet, the UI  |
| `public/invoices/model.js`            | Invoice shape, totals, quantity-in-words, the split |
| `public/invoices/store.js`            | Firebase: sign-in, invoices, counter, pharmacies   |
| `public/invoices/sheet.js`            | The sheet's HTML + CSS — screen and printer alike  |
| `public/vendor/`, `public/invoices/fonts/` | Vendored by `npm run vendor`; do not hand-edit |
| `public/paper/drugs.js`               | The drug list itself — generated from RxNorm       |
| `public/paper/drugsearch.js`          | Typo-tolerant matching over that list              |
| `scripts/build-drug-list.js`          | Rebuilds the list; `scripts/test-search.js` checks it |
| `electron/preload.js`                 | The only page↔Node bridge: printer list + print job |
| `scripts/make-icon.js`                | Builds the app icon (`.ico` + `.png`) from `public/logo.svg` |
| `scripts/icon-glyph.js`               | The simplified mark the icon uses at 16–48 px      |
| `scripts/svgraster.js`                | A tiny SVG rasterizer, so that needs no dependency |
| `.github/workflows/build-windows.yml` | CI that builds the Windows installer               |

## Notes

- The `npm audit` warnings are all in **electron-builder's dev-only
  dependencies**. They are used only when building the installer and are never
  shipped inside the app.
- To change the printer defaults, label stock, or ZPL output, edit the files in
  `public/` — no build step is needed for UI changes during development.

## The logo

`public/logo.svg` is the pharmacy's mortar-and-pestle mark, and **one file
feeds three places**: the name tags print it as printer dots
(`public/nametag/logo.js`), the app header shows it, and the Windows app icon
is built from it (`scripts/make-icon.js` → `build/icon.ico` and
`build/icon.png`).

The `.ico` is built by the script, not by electron-builder: given a PNG,
electron-builder writes an `.ico` holding a single 256px image, and Windows
shrinking that to taskbar size is what made the old icon pixelated and
stringy. Each size is rendered from vectors at its own pixel size instead —
the logo itself from 64px up, and from 48px down a hand-simplified mortar and
pestle (`scripts/icon-glyph.js`), because the logo's hairline swirls are
narrower than a pixel there. Cream on a maroon tile, so it holds up on light
and dark taskbars alike.

To change it, replace that one file and run `npm run make-icon`. Two
requirements:

- **Crop it to the artwork**, with no surrounding padding. Both the name-tag
  layout and the icon position the mark by its own edges, so dead space inside
  the viewBox becomes dead space on the tag.
- **Everything must be a `<path>`.** `scripts/svgraster.js` is deliberately
  small — it handles paths, the viewBox and nested group transforms, and throws
  on anything else rather than quietly skipping it. In Illustrator that means
  *Object > Path > Outline Stroke* and *Object > Compound Path > Make* before
  exporting.

The icon is generated rather than committed so that swapping the logo is
swapping one SVG. It is checked against Chromium's own renderer, not eyeballed:
the mark is rasterized both ways at the same size and the alpha channels are
differenced. That test is what caught the bug where the mark's bottom rim went
missing — this SVG has two groups, only one of which carries the trace
transform, and an earlier parser applied the first transform it found to every
path.
