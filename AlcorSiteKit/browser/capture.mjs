/**
 * Cold-read capture with a real browser: for each page, what a stranger sees in the first
 * viewport (the 5-second read, as a JPEG) and the page's visible text (the 30-second read), on a
 * desktop and a phone viewport.
 *
 *   node browser/capture.mjs <base-url> <out-dir> [--pages /,/menu/]
 *
 * Writes <out-dir>/manifest.json in the format `sitekit coldread` reads. Exit code 2 means
 * Playwright is unavailable (see playwright.mjs). Without a browser, `sitekit coldread` captures
 * text only.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchBrowser } from './playwright.mjs';

const args = process.argv.slice(2);
const base = (args[0] || '').replace(/\/$/, '');
const out = args[1];
if (!/^https?:/.test(base) || !out) {
  console.error('usage: capture.mjs <base-url> <out-dir> [--pages /,/menu/]');
  process.exit(2);
}
const pagesAt = args.indexOf('--pages');
const PAGES = (pagesAt > -1 ? args[pagesAt + 1] || '' : '/').split(',').filter(Boolean);
if (!PAGES.length) {
  console.error('capture.mjs: --pages must name at least one page, e.g. /,/menu/');
  process.exit(2);
}
const VIEWS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844, mobile: true },
];

// Launch first: when the browser tools are unavailable nothing should be left behind on disk.
const browser = await launchBrowser();
mkdirSync(out, { recursive: true });
const entries = [];
for (const view of VIEWS) {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    isMobile: Boolean(view.mobile),
    deviceScaleFactor: 1,
  });
  for (const route of PAGES) {
    const page = await context.newPage();
    const slug = route === '/' ? 'home' : route.replace(/^\/|\/$/g, '').replace(/\//g, '_');
    await page.goto(base + route, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(1500);
    const shot = `${slug}-${view.name}.jpg`;
    const textFile = `${slug}-${view.name}.txt`;
    await page.screenshot({ path: path.join(out, shot), type: 'jpeg', quality: 70 });
    const text = await page.evaluate(() =>
      (document.querySelector('main') || document.body).innerText.replace(/\n{3,}/g, '\n\n').trim(),
    );
    writeFileSync(path.join(out, textFile), text.slice(0, 12000));
    entries.push({ path: route, view: view.name, shot, text: textFile, chars: text.length });
    await page.close();
  }
  await context.close();
}
await browser.close();
const manifest = { captured: new Date().toISOString(), mode: 'browser', pages: entries };
writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`captured ${entries.length} views into ${path.basename(out)}`);
