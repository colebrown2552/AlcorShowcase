/**
 * Checks that switching to another project while an import job runs selects the new project and keeps the old job state correct.
 *
 * Serves the checked-in ui/ assets from a throwaway loopback server with synthetic API
 * responses (no real server or project needed). Off-origin and non-read requests are
 * blocked.
 *
 * Usage:
 *
 *   node import_switch_acceptance.mjs --playwright-module /path/to/playwright/index.mjs \
 *     [--browser-path CHROME]
 *
 * --playwright-module defaults to PLAYWRIGHT_MODULE; --browser-path to ALCORDESIGN_CHROME.
 * Both must be absolute paths. Prints a JSON result and exits non-zero on failure.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : process.argv[i + 1];
};
const modulePath = option('--playwright-module') || process.env.PLAYWRIGHT_MODULE;
if (!modulePath || !path.isAbsolute(modulePath))
  throw new Error('Provide an absolute --playwright-module');
const browserPath = option('--browser-path') || process.env.ALCORDESIGN_CHROME;
if (browserPath && !path.isAbsolute(browserPath))
  throw new Error('--browser-path must be absolute');
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
async function run(scenario) {
  const active = scenario.startsWith('active-');
  const kind = active ? scenario.slice(7) : scenario;
  const page = await browser.newPage();
  let nProjectA = 0,
    nPageA = 0,
    nProjects = 0,
    release,
    entered;
  const waiting = new Promise((r) => (entered = r));
  const gate = new Promise((r) => (release = r));
  const a = {
    id: 'A',
    name: 'Alpha',
    pages:
      kind === 'page'
        ? [
            {
              id: 'p',
              title: 'Alpha page',
              screenshot: '/files/a.png',
              revision: 1,
              status: 'ready',
            },
          ]
        : [],
  };
  const b = { id: 'B', name: 'Beta', pages: [] };
  const respond = (route, obj) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.origin !== origin || !['GET', 'HEAD'].includes(route.request().method()))
      return route.abort();
    if (u.pathname === '/api/projects') {
      nProjects++;
      if (kind === 'terminal' && nProjects === 2) {
        entered();
        await gate;
      }
      return respond(route, { projects: [a, b] });
    }
    if (u.pathname === '/api/project/A') {
      nProjectA++;
      if (kind === 'project' && nProjectA === 2) {
        entered();
        await gate;
      }
      return respond(route, {
        ...a,
        pages: a.pages.map((p) => ({ ...p, revision: nProjectA > 1 ? 2 : 1 })),
      });
    }
    if (u.pathname === '/api/project/B') return respond(route, b);
    if (u.pathname === '/api/page/A/p') {
      nPageA++;
      if (kind === 'page' && nPageA === 2) {
        entered();
        await gate;
      }
      return respond(route, {
        ...a.pages[0],
        revision: nPageA > 1 ? 2 : 1,
        nodes: [],
        viewport: { width: 800, height: 600 },
      });
    }
    if (u.pathname === '/api/jobs/jobA') {
      if (kind === 'error') {
        entered();
        await gate;
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'revision conflict' }),
        });
      }
      return respond(route, {
        status: kind === 'terminal' ? 'done' : 'running',
        completed: 1,
        total: 2,
      });
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
    await page.waitForFunction(() => window.AlcorDesignUI?.state.project?.id === 'A');
    if (kind === 'page')
      await page.waitForFunction(() => window.AlcorDesignUI.state.page?.id === 'p');
    await page.evaluate(() => window.AlcorDesignUI.trackJob('jobA', 'A'));
    await Promise.race([
      waiting,
      new Promise((_, rej) => setTimeout(() => rej(Error('held request not reached')), 10000)),
    ]);
    if (!active) {
      await page.selectOption('#projectSelect', 'B');
      await page.waitForFunction(() => window.AlcorDesignUI.state.project?.id === 'B');
    }
    release();
    await page.waitForTimeout(400);
    const value = await page.evaluate(() => ({
      project: window.AlcorDesignUI.state.project?.id,
      page: window.AlcorDesignUI.state.page?.id || null,
      revision: window.AlcorDesignUI.state.page?.revision || null,
      selected: document.querySelector('#projectSelect').value,
      jobHidden: document.querySelector('#jobBar').hidden,
      finished: window.AlcorDesignUI.state.finishedJobs.has('jobA'),
      status: document.querySelector('#pageStatus').textContent,
    }));
    const passed = active
      ? value.project === 'A' &&
        value.selected === 'A' &&
        (kind !== 'page' || value.revision === 2) &&
        (kind !== 'terminal' || (value.finished && value.jobHidden))
      : value.project === 'B' &&
        value.page === null &&
        value.selected === 'B' &&
        value.jobHidden &&
        (kind !== 'error' || value.status !== 'Action could not be completed');
    results.push({ scenario, passed, value });
  } finally {
    release?.();
    await page.close();
  }
}
try {
  for (const kind of [
    'project',
    'page',
    'terminal',
    'error',
    'active-project',
    'active-page',
    'active-terminal',
  ])
    await run(kind);
  console.log(JSON.stringify({ results }, null, 2));
  if (results.some((x) => !x.passed)) process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
