# AlcorApps

![The nine AlcorApps](screenshots/AlcorApps-collage.png)

Nine free, local-first browser apps from [Alcor Industries](https://alcor-industries.com/platform/).
No account, no upload: files you open stay on your device. Plain JavaScript, HTML and CSS with no
framework and no build step.

| App | What it does | Hard part worth reading |
|---|---|---|
| [AlcorPhoto](web/AlcorPhoto) | Layered photo editor: masks, brushes, selections, filters, background removal. Opens PSD; exports PNG, JPEG, WebP, GIF, TIFF and more. | Copy-on-write tile storage for undo; codecs written from scratch |
| [AlcorVideo](web/AlcorVideo) | Multi-track video editor: 12 video and 12 audio tracks, keyframes, colour grading, titles. Exports MP4 or WebM. | Whole render and export pipeline in the browser |
| [AlcorMusic](web/AlcorMusic) | Piano roll, score preview and playback. Exports MIDI, MusicXML and WAV. | Synthesised instruments; MIDI and WAV written by hand |
| [AlcorQR](web/AlcorQR) | QR code designer with logo, colours and module styles. PNG up to 4096 px or SVG. | Contrast checks so codes still scan; untrusted SVG logos |
| [AlcorMap](web/AlcorMap) | Labelled markers, coordinate entry, share links, GeoJSON/CSV/PNG export (MapLibre GL). | Whole map encoded in a share link, no server |
| [AlcorFinance](web/AlcorFinance) | Opportunity cost, loan schedules and break-even analysis. | Strict number parsing and cent-exact rounding |
| [AlcorTranslate](web/AlcorTranslate) | Two-person conversation translator. | Browser translator with a WebAssembly fallback in a worker |
| [AlcorReconcile](web/AlcorReconcile) | Compares two CSV exports and flags matches, mismatches and missing records. | BigInt money maths; CSV-injection-safe export |
| [AlcorERP](web/AlcorERP) | Customers, quotes, orders, projects, stock and invoices as one record. | Stock as a movement ledger; derived dashboard |

Each app's folder has a README with how it works and the interesting code to read. Full-size
screenshots are in [`screenshots/`](screenshots).

## Run them

Any static file server works. From this folder:

```sh
python -m http.server --bind 127.0.0.1 --directory web
```

Open the address it prints, followed by an app folder, for example `/AlcorPhoto/`. (Opening
`index.html` straight from disk is not enough: browsers block modules and workers on `file://`.)

Check that every page's files are present (Python standard library only):

```sh
python tools/check_assets.py
```

## How they are built

- **Engines are split from UI.** Files named `*-core.js` hold pure logic (no DOM, storage or
  network) and also load under Node for tests; UI files wire them to the page.
- **One shared shell.** AlcorPhoto, AlcorVideo and AlcorMusic share the AlcorApps runtime
  ([`alcor-app.js`](web/assets/js/alcor-app.js)): title bar, app tabs, menus, keyboard routing and
  local project storage. The shell has no network authority; each app owns its own engine.
- **Heavy work off the main thread.** AlcorPhoto's pixel engine, MapLibre's renderer and the
  translation engine run in Web Workers.
- **Local persistence only.** Projects live in page memory, IndexedDB, `localStorage` or files you
  download.

These are the files the live site serves, taken from its source and adjusted to run from a plain
folder: asset links made relative, the Video editor's server-assembled bundles saved as static
files, and the site's page counter, contact details and search-engine metadata removed.

## Notes

- **AlcorMap** draws its basemap from OpenStreetMap tiles, so the background map needs a network
  connection. Markers, search and exports work offline.
- **AlcorTranslate** works out of the box in Chrome and Edge through their built-in translator. In
  other browsers it falls back to Bergamot, which also needs its language models (listed in
  [`models.json`](web/assets/lib/bergamot-translator/models.json)); they are large and not included.

## Naming

Product names are PascalCase (AlcorPhoto, AlcorERP). Source files are lowercase kebab-case with an
`alcor-` prefix (`alcor-photo-core.js`). Every first-party file starts with a header comment saying
what it is.

## Third-party code

- [MapLibre GL JS](web/assets/lib/maplibre-gl) (BSD-3-Clause), see its `LICENSE.txt`.
- [Bergamot translator](web/assets/lib/bergamot-translator) (MPL-2.0), see `LICENSE.txt` and `LICENSES.md`.
- QR engine in [`js/vendor`](web/assets/js/vendor) (MIT and Apache-2.0), see `THIRD_PARTY_NOTICES.md`.
