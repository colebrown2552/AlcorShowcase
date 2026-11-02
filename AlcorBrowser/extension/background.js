/**
 * AlcorBrowser service worker entry point.
 *
 * Loads, in order: config.js (per-install settings), page.js (the function injected into pages) and
 * agents.js (the worker itself). `importScripts` is synchronous, so each file sees the globals
 * defined by the files before it.
 */
importScripts('config.js', 'page.js', 'agents.js');
