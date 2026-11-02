/**
 * Loads Playwright and launches Chromium for the browser tools, with one clear failure message.
 *
 * Playwright is optional: the Python side of sitekit never needs it, and the offline demo does not
 * use it. This module looks for it in the module named by SITEKIT_PLAYWRIGHT (a path to its
 * index.mjs) and otherwise through a normal `import('playwright')`, so `npm install` in the
 * sitekit folder is enough. To avoid downloading a browser, set SITEKIT_CHROME to an installed
 * Chrome or Chromium executable; otherwise run `npx playwright install chromium` once.
 *
 * Exit code 2 means "the tool could not run" and is kept apart from exit code 1, which means
 * "the tool ran and found a problem".
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HELP = [
  'Install Playwright once, in the sitekit folder (package.json lists it):',
  '  npm install',
  'then either download a browser:',
  '  npx playwright install chromium',
  'or point SITEKIT_CHROME at an installed Chrome / Chromium executable.',
  'A Playwright installed elsewhere can be named with SITEKIT_PLAYWRIGHT=<path to index.mjs>.',
].join('\n');

/**
 * Print why the browser tools cannot run and stop with exit code 2.
 * @param {string} reason - what went wrong, in one line.
 * @returns {never}
 */
function unavailable(reason) {
  console.error(`browser tools unavailable: ${reason}\n${HELP}`);
  process.exit(2);
}

/**
 * Launch a headless Chromium through Playwright.
 * @returns {Promise<import('playwright').Browser>} the running browser; the caller closes it.
 */
export async function launchBrowser() {
  let loaded;
  try {
    const explicit = process.env.SITEKIT_PLAYWRIGHT;
    loaded = await import(explicit ? pathToFileURL(path.resolve(explicit)).href : 'playwright');
  } catch (error) {
    unavailable(`cannot load Playwright (${error.code || error.message})`);
  }
  const chromium = loaded.chromium || (loaded.default && loaded.default.chromium);
  if (!chromium) unavailable('the loaded module has no chromium launcher');
  try {
    return await chromium.launch({ executablePath: process.env.SITEKIT_CHROME || undefined });
  } catch (error) {
    unavailable(`cannot launch the browser (${String(error.message).split('\n')[0]})`);
  }
}
