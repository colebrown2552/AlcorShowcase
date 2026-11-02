/**
 * Checks that the UI returns to the current page and hides the job panel when an import job finishes.
 *
 * Serves the checked-in ui/ assets from a throwaway loopback server with synthetic API
 * responses (no real server or project needed). Off-origin and non-read requests are
 * blocked.
 *
 * Usage:
 *
 *   node import_return_acceptance.mjs --playwright-module /path/to/playwright/index.mjs \
 *     [--browser-path CHROME]
 *
 * --playwright-module defaults to PLAYWRIGHT_MODULE; --browser-path to ALCORDESIGN_CHROME.
 * Both must be absolute paths. Prints a JSON result and exits non-zero on failure.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : process.argv[i + 1];
};
const modulePath = option('--playwright-module') || process.env.PLAYWRIGHT_MODULE;
if (!modulePath || !path.isAbsolute(modulePath))
  throw Error('Provide an absolute --playwright-module');
const browserPath = option('--browser-path') || process.env.ALCORDESIGN_CHROME;
if (browserPath && !path.isAbsolute(browserPath)) throw Error('--browser-path must be absolute');
const ui = fileURLToPath(new URL('../ui/', import.meta.url));
const { chromium } = await import(pathToFileURL(modulePath).href);
const server = http.createServer(async (req, res) => {
  try {
    const name = new URL(req.url, 'http://127.0.0.1').pathname.slice(1) || 'index.html';
    if (name.includes('/') || name.includes('..')) throw Error('bad path');
    const data = await readFile(path.join(ui, name));
    res.writeHead(200, {
      'content-type': name.endsWith('.js')
        ? 'text/javascript'
        : name.endsWith('.css')
          ? 'text/css'
          : 'text/html',
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch(
    browserPath
      ? { executablePath: browserPath, headless: true }
      : { channel: 'chrome', headless: true },
  );
} catch (error) {
  await new Promise((r) => server.close(r));
  throw error;
}
const results = [];
async function run(kind) {
  const page = await browser.newPage();
  let release,
    entered,
    releaseB,
    enteredB,
    jobCount = 0;
  const waiting = new Promise((r) => (entered = r));
  const gate = new Promise((r) => (release = r));
  const waitingB = new Promise((r) => (enteredB = r));
  const gateB = new Promise((r) => (releaseB = r));
  const waitForHold = () =>
    Promise.race([
      waiting,
      new Promise((_, reject) =>
        setTimeout(() => reject(Error('held request not reached')), 10000),
      ),
    ]);
  const pages = ['p', 'q'].map((id) => ({
    id,
    title: id,
    screenshot: '/files/a.png',
    revision: 1,
    status: 'ready',
  }));
  const project = { id: 'A', name: 'Alpha', pages };
  const response = (route, obj) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.origin !== origin || !['GET', 'HEAD'].includes(route.request().method()))
      return route.abort();
    if (u.pathname === '/api/projects')
      return response(route, { projects: [project, { id: 'B', name: 'Beta', pages: [] }] });
    if (u.pathname === '/api/project/A') return response(route, project);
    if (u.pathname === '/api/project/B') {
      enteredB();
      await gateB;
      return response(route, { id: 'B', name: 'Beta', pages: [] });
    }
    if (u.pathname === '/api/page/A/p' || u.pathname === '/api/page/A/q') {
      const id = u.pathname.endsWith('/p') ? 'p' : 'q';
      if (kind === 'page-overview' && id === 'q') {
        entered();
        await gate;
      }
      return response(route, {
        ...pages.find((p) => p.id === id),
        nodes: [],
        viewport: { width: 800, height: 600 },
      });
    }
    if (u.pathname === '/api/jobs/jobA') {
      jobCount++;
      if (jobCount === 2) {
        entered();
        await gate;
        return response(route, { status: 'done', completed: 2, total: 2 });
      }
      return response(route, { status: 'running', completed: 1, total: 2 });
    }
    if (u.pathname.startsWith('/files/'))
      return route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: Buffer.from(
          [
            'iVBORw0KGgoAAAAN',
            'SUhEUgAAAAEAAAAB',
            'CAQAAAC1HAwCAAAA',
            'C0lEQVR42mP8/x8A',
            'AwMCAO+a7WQAAAAA',
            'SUVORK5CYII=',
          ].join(''),
          'base64',
        ),
      });
    return route.continue();
  });
  try {
    await page.goto(origin + '/?project=A');
    await page.waitForFunction(() => window.AlcorDesignUI?.state.page?.id === 'p');
    if (kind === 'terminal-return') {
      await page.evaluate(() => window.AlcorDesignUI.trackJob('jobA', 'A'));
      await page.waitForFunction(() => !document.querySelector('#jobBar').hidden);
      await waitForHold();
      await page.selectOption('#projectSelect', 'B');
      await Promise.race([
        waitingB,
        new Promise((_, reject) => setTimeout(() => reject(Error('B request not reached')), 10000)),
      ]);
      await page.selectOption('#projectSelect', 'A');
      await page.waitForFunction(() => window.AlcorDesignUI.state.projectTarget === 'A');
    } else {
      await page.evaluate(() => {
        window.AlcorDesignUI.selectPage('q');
      });
      await waitForHold();
      await page.click('#overviewButton');
    }
    release();
    await page.waitForTimeout(400);
    const value = await page.evaluate(() => ({
      page: window.AlcorDesignUI.state.page?.id,
      overview: window.AlcorDesignUI.state.overview,
      overviewHidden: document.querySelector('#overview').hidden,
      jobHidden: document.querySelector('#jobBar').hidden,
      finished: window.AlcorDesignUI.state.finishedJobs.has('jobA'),
    }));
    const passed = value.page === 'p' && value.jobHidden && value.finished;
    results.push({ kind, passed, value });
  } finally {
    release?.();
    releaseB?.();
    await page.close();
  }
}
try {
  await run('terminal-return');
  console.log(JSON.stringify({ results }, null, 2));
  if (results.some((x) => !x.passed)) process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
