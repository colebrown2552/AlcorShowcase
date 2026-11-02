#!/usr/bin/env node
/**
 * Browser check of the responsive panel switcher and keyboard behaviour.
 *
 * Start an AlcorDesign server with a disposable data directory, then run:
 *
 *   node mobile_workspace_acceptance.mjs --playwright-module /path/to/playwright/index.mjs \
 *     --url http://127.0.0.1:PORT/ [--browser-executable CHROME] [--expect-populated]
 *
 * PORT is the port in the server's runtime.json. --playwright-module defaults to
 * PLAYWRIGHT_MODULE, then ALCORDESIGN_PLAYWRIGHT; --browser-executable to
 * ALCORDESIGN_CHROME. Requests outside the given server, and writes, are blocked.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const modulePath =
  option('--playwright-module') ||
  process.env.PLAYWRIGHT_MODULE ||
  process.env.ALCORDESIGN_PLAYWRIGHT;
const url = option('--url');
const browserPath = option('--browser-executable') || process.env.ALCORDESIGN_CHROME;
const expectPopulated = process.argv.includes('--expect-populated');
if (!modulePath || !path.isAbsolute(modulePath) || !url)
  throw new Error('Provide an absolute --playwright-module and an isolated --url');
const origin = new URL(url);
if (
  origin.protocol !== 'http:' ||
  origin.hostname !== '127.0.0.1' ||
  origin.username ||
  origin.password
) {
  throw new Error('The acceptance test requires an isolated HTTP app on 127.0.0.1');
}
const { chromium } = await import(pathToFileURL(modulePath).href);
const browser = await chromium.launch(
  browserPath
    ? { executablePath: browserPath, headless: true }
    : { channel: 'chrome', headless: true },
);
const checks = [];
const pageErrors = [];
const blockedRequests = [];
function check(name, passed, detail = null) {
  checks.push({ name, passed: !!passed, detail });
}
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/*', (route) => {
    const request = route.request();
    const target = new URL(request.url());
    // design_status is a read-only tool the UI calls on load to learn the GitHub setting.
    let toolName = null;
    try {
      toolName = request.postDataJSON()?.name ?? null;
    } catch {
      toolName = null;
    }
    const statusRead =
      request.method() === 'POST' &&
      target.pathname === '/api/tools' &&
      toolName === 'design_status';
    const read = ['GET', 'HEAD'].includes(request.method()) || statusRead;
    if (target.origin !== origin.origin || !read) {
      blockedRequests.push({ origin: target.origin, method: request.method() });
      return route.abort();
    }
    return route.continue();
  });
  for (const width of [320, 390, 600, 700, 701, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.AlcorDesignUI);
    if (expectPopulated) {
      await page.waitForFunction(
        () => {
          const state = window.AlcorDesignUI.state,
            image = document.getElementById('pageImage');
          return (
            !!state.project &&
            !!state.page &&
            !!image.getAttribute('src') &&
            image.complete &&
            image.naturalWidth > 0 &&
            image.naturalHeight > 0
          );
        },
        null,
        { timeout: 20000 },
      );
      check(
        `${width}: rendered project loaded`,
        !(await page.locator('#canvasContent').isHidden()),
      );
    }
    const mobile = width <= 700;
    const controls = page.getByRole('navigation', { name: 'Workspace panels' });
    check(`${width}: switcher visibility`, (await controls.isVisible()) === mobile);
    if (mobile) {
      const editor = page.locator('.editor');
      const rect = await editor.boundingBox();
      check(
        `${width}: canvas occupies viewport`,
        (await editor.isVisible()) &&
          rect?.width >= width - 1 &&
          (await page.locator('#canvas').isVisible()),
        rect,
      );
      for (const [name, selector] of [
        ['Pages', '.left-sidebar'],
        ['Inspector', '.properties-sidebar'],
        ['Canvas', '.editor'],
      ]) {
        const button = controls.getByRole('button', { name, exact: true });
        await button.focus();
        await page.keyboard.press('Space');
        check(
          `${width}: ${name} keyboard selection`,
          (await page.locator(selector).isVisible()) &&
            (await button.getAttribute('aria-pressed')) === 'true' &&
            (await controls.locator('[aria-pressed=true]').count()) === 1,
        );
      }
      const toolbarLocator = page.locator('.canvas-toolbar');
      const initialToolbar = await toolbarLocator.evaluate((el) => {
        el.scrollLeft = 0;
        return {
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          overflowX: getComputedStyle(el).overflowX,
        };
      });
      if (initialToolbar.scrollWidth > initialToolbar.clientWidth) {
        await toolbarLocator.hover();
        await page.mouse.wheel(2000, 0);
        await page.waitForFunction(
          () => {
            const el = document.querySelector('.canvas-toolbar');
            return el.scrollLeft >= el.scrollWidth - el.clientWidth - 1;
          },
          null,
          { timeout: 5000 },
        );
      }
      const toolbar = await toolbarLocator.evaluate((el) => {
        const parent = el.getBoundingClientRect(),
          last = document.getElementById('zoomIn').getBoundingClientRect();
        return {
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          overflowX: getComputedStyle(el).overflowX,
          lastVisible: last.right <= parent.right + 1 && last.left >= parent.left - 1,
        };
      });
      check(
        `${width}: toolbar end reachable`,
        toolbar.lastVisible &&
          (toolbar.scrollWidth <= toolbar.clientWidth ||
            ['auto', 'scroll'].includes(toolbar.overflowX)),
        toolbar,
      );
    } else {
      check(
        `${width}: desktop panels visible`,
        (await page.locator('.left-sidebar').isVisible()) &&
          (await page.locator('.editor').isVisible()) &&
          (await page.locator('.properties-sidebar').isVisible()),
      );
    }
  }
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const nav = page.getByRole('navigation', { name: 'Workspace panels' });
  await nav.getByRole('button', { name: 'Pages', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  check(
    'resize to desktop exposes all panels',
    (await page.locator('.left-sidebar').isVisible()) &&
      (await page.locator('.editor').isVisible()) &&
      (await page.locator('.properties-sidebar').isVisible()),
  );
  await page.setViewportSize({ width: 390, height: 900 });
  check(
    'resize back preserves selected pane',
    (await page.locator('.left-sidebar').isVisible()) &&
      !(await page.locator('.editor').isVisible()),
  );
  check('no browser page errors', pageErrors.length === 0, pageErrors);
  check('no blocked external or write requests', blockedRequests.length === 0, blockedRequests);
} catch (error) {
  checks.push({ name: 'test execution', passed: false, detail: String(error.message || error) });
} finally {
  await browser.close();
}
const result = {
  schema: 'alcordesign.mobile-workspace.acceptance.v1',
  scope: 'isolated loopback app; responsive panels and keyboard behavior',
  checks,
};
console.log(JSON.stringify(result, null, 2));
if (checks.some((entry) => !entry.passed)) process.exitCode = 1;
