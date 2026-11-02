# AlcorTranslate

![AlcorTranslate](../../screenshots/AlcorTranslate.png)

A two-person conversation translator: each person types or speaks in their own language and sees
the other side translated, with a transcript you can copy or download.

## How it works

1. Where the browser has a built-in translator (the `Translator` API in Chrome and Edge),
   AlcorTranslate uses it and translation happens on the device.
2. Everywhere else it runs Mozilla's Bergamot engine (WebAssembly) in a Web Worker
   (`alcor-translate-worker.js`), with the Firefox Translations models.
3. Speech input uses the browser's speech recognition, which may send audio to the browser
   vendor's service; the page says so next to the button.

## The hard parts

- **Two engines, one interface.** `alcor-translate-app.js` picks the engine per language pair
  and normalises languages so both paths behave the same.
- **Verified models.** The worker checks every model file against the SHA-256 in
  [`models.json`](../assets/lib/bergamot-translator/models.json) before use and keeps it in Cache
  Storage, so a language downloads once.
- **Never blocking the page.** Translation runs in the worker; the UI stays responsive.

The Bergamot models are large and are not included in this repository, so the fallback path
needs them added next to the engine. The Chrome/Edge path works as is.

## Run

Serve `AlcorApps/web` with any static server and open `AlcorTranslate/`.
