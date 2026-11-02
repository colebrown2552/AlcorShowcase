# AlcorTranslate in-browser engine: licenses and sources

AlcorTranslate uses the browser's built-in Translator API where it exists (Chrome, Edge). In every
other browser it runs the engine and models below on the visitor's device, in a Web Worker
(`assets/js/alcor-translate-worker.js`). Both are open-licensed and allow commercial use.
Licenses were confirmed on the official source pages on 2026-10-29.

## Engine: bergamot-translator 0.4.9 (WebAssembly build)

- Files here: `bergamot-translator-worker.js`, `bergamot-translator-worker.wasm`, unmodified from the npm
  package `@browsermt/bergamot-translator@0.4.9`
  (https://registry.npmjs.org/@browsermt/bergamot-translator/-/bergamot-translator-0.4.9.tgz,
  sha1 224cd32c6e89c92a0d4945dc0fceb4400dcb2ae4; build string `v0.4.5+4917c11`).
- Source: https://github.com/browsermt/bergamot-translator
- License: Mozilla Public License 2.0, confirmed in the repository's LICENSE
  (https://github.com/browsermt/bergamot-translator/blob/main/LICENSE) and the npm package metadata
  (`"license": "MPL-2.0"`). Full text: `LICENSE.txt` in this folder.
- `assets/js/alcor-translate-worker.js` follows the package's `worker/translator-worker.js` to load and call
  the engine, so it carries the MPL-2.0 header. MPL-2.0 is file-level: it covers those files only.
- Source availability (MPL-2.0 section 3.2): the source of the engine is at the repository above.

## Models: Firefox Translations models (Mozilla)

- Owner and source: Mozilla, https://github.com/mozilla/translations
- License: Mozilla Public License 2.0. Confirmed in that repository's README ("The model files are
  distributed under the MPL 2.0 license") and LICENSE
  (https://github.com/mozilla/translations/blob/main/LICENSE), and in the LICENSE of the earlier model
  repository https://github.com/mozilla/firefox-translations-models (MPL-2.0, archived 2025-12-15).
- Official files: Mozilla's model registry,
  https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/db/models.json
- Not used: NLLB (CC-BY-NC, no commercial use).

### Where the browser downloads them from

This site. The files are too large for this repository (14 to 50 MB per direction, compressed; 1.73 GB
for all 74), so they are not in git: `deploy/sync_translate_models.py` places them in
`wp-content/uploads/alcor-translate-models/<version>/` on the server, outside the deployed theme, and
`models.json`'s `base` points there (same origin; the app's CSP allows `connect-src 'self'` only). The
browser never contacts a third party for them. A pair is offered only once the sync has verified its files
and listed it in that directory's `READY.json`; otherwise the app says the files aren't available.

Source of the hosted copy (`upstream` in `models.json`; the sync step downloads from it, never the browser):
Mozilla's bucket does not allow cross-site downloads, so the pinned set was taken from a public Hugging Face
mirror of Mozilla's files, pinned to one commit:

- https://huggingface.co/mukowaty/firefox-translations, commit `e43e74a227e023469fb1d1c0e560dd69c0408410`
  (repository license tag: `mpl-2.0`). That commit is the `<version>` directory name on this site.

Each file listed in `models.json` was downloaded from Mozilla's bucket (the path in the mirror's
`model.json`, copied from Mozilla's registry) and compared to the mirror's file: every listed file is
byte-identical (same SHA-256 and size). The sync step checks every file against that size and SHA-256
where it downloads it and again on the server before moving it into place, and the worker checks each
download again before use and discards anything that differs. The files are redistributed here unmodified
under MPL-2.0; this file and Mozilla's repository above are their license and source notice.

### Coverage

`models.json` has an English-to-X and X-to-English model for every language AlcorTranslate lists except
Marathi (no Mozilla model): 74 models. Pairs without English go through English (two models). Marathi works
only where the browser has a built-in translator for it; elsewhere the app says that pair can't be translated.
A language with English downloads 30 to 97 MB for both directions (English and Spanish: 25 + 26 MB), once.
