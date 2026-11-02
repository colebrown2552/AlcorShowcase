/**
 * Exercises a running AlcorDesign server and the Chromium renderer through the editor UI (set ALCORDESIGN_URL). Creates one clearly named synthetic document.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const playwrightPath = process.env.ALCORDESIGN_PLAYWRIGHT || '';
const { chromium } = await import(playwrightPath ? pathToFileURL(playwrightPath) : 'playwright');
const BASE_URL =
  process.env.ALCORDESIGN_URL ||
  (() => {
    throw new Error('Set ALCORDESIGN_URL to the running server.');
  })();
const output = path.join(
  process.env.LOCALAPPDATA || '/tmp',
  'AlcorDesign',
  'alcor-design',
  'native-ui-acceptance',
);
await fs.mkdir(output, { recursive: true });
const html = `<!doctype html><html><head><meta charset="utf-8"><title>AlcorDesign acceptance</title><style>*{box-sizing:border-box}body{margin:0;background:#101b22;color:#ecf5f2;font-family:Arial,sans-serif}header{padding:30px 80px;border-bottom:1px solid #355047;font-size:16px}main{padding:76px 80px 100px;max-width:1000px}small{color:#96dfc3;letter-spacing:3px}h1{font-size:64px;line-height:1.05;max-width:700px;font-weight:500;margin:25px 0}p{font-size:20px;color:#b3c6c2;max-width:620px;line-height:1.6}.card{background:#243e38;padding:30px;border-radius:20px;margin-top:40px}button{border:0;background:#9ce7cc;color:#103b2a;border-radius:8px;padding:15px 22px;font:16px Arial}@media(max-width:600px){header{padding:22px}main{padding:40px 22px}h1{font-size:42px}}</style></head><body><header>ALCOR DESIGN</header><main><small>DESIGN IN YOUR OWN SPACE</small><h1 id="headline">A canvas for every idea.</h1><p>Real HTML, real layout, and a local Rust workspace. This is a synthetic acceptance document.</p><button>Make something</button><div class="card"><p>Inspect every layer. Refine every detail.</p></div></main></body></html>`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
});
const tab = await ctx.newPage();
const errors = [],
  checks = [];
tab.on('pageerror', (e) => errors.push(e.message));
tab.setDefaultTimeout(90000);
let projectId, pageId;
const read = (pathname) =>
  tab.evaluate(async (pathname) => {
    const r = await fetch(pathname);
    return await r.json();
  }, pathname);
const getPage = () => read(`/api/page/${projectId}/${pageId}`);
const untilIdle = () =>
  tab.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 180000 });
async function check(name, fn) {
  await fn();
  checks.push(name);
  console.log(`PASS ${name}`);
}
try {
  await tab.goto(BASE_URL);
  await check('Native Rust HTML import via editor', async () => {
    await tab.locator('#importButton').click();
    await tab.locator('[data-import-tab="html"]').click();
    await tab.locator('#importHtml').fill(html);
    await tab.locator('#importName').fill(`UI acceptance ${new Date().toISOString()}`);
    const response = tab.waitForResponse(
      (r) =>
        r.url().endsWith('/api/tools') && r.request().postData()?.includes('design_import_html'),
    );
    await tab.locator('#startImport').click();
    const result = await (await response).json();
    assert.ok(result.project_id, JSON.stringify(result));
    projectId = result.project_id;
    await fs.writeFile(
      path.join(output, 'pending-project.json'),
      JSON.stringify({ project_id: projectId, job_id: result.job_id }),
    );
    for (let i = 0; i < 90; i++) {
      const p = await read(`/api/project/${projectId}`);
      if (p.pages?.some((p) => p.status === 'ready')) {
        pageId = p.pages.find((p) => p.status === 'ready').id;
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    assert.ok(pageId, 'Native renderer did not produce a page');
    await tab.locator('#pagesTab').click();
    await tab.locator(`.page-item[data-page-id="${pageId}"]`).click();
    await tab.locator('#pageImage').waitFor({ state: 'visible' });
    assert.ok((await getPage()).nodes.length > 5);
  });
  await check('Native text and style editing produces new capture', async () => {
    const p = await getPage();
    const node = p.nodes.find((n) => n.tag === 'h1');
    await tab.locator('#layersTab').click();
    await tab.locator(`[data-node-id="${node.id}"]`).click();
    await tab.locator('#propText').fill('Designed locally. Built to last.');
    await tab.locator('#propColor').fill('#8ce8cd');
    await tab.locator('#applyButton').click();
    await untilIdle();
    const updated = await getPage();
    assert.notEqual(updated.screenshot, p.screenshot);
    assert.equal(
      updated.nodes.find((n) => n.tag === 'h1').text,
      'Designed locally. Built to last.',
    );
    assert.equal(updated.nodes.find((n) => n.tag === 'h1').styles.color, 'rgb(140, 232, 205)');
  });
  await check('Native undo and redo restore HTML', async () => {
    await tab.locator('#undoButton').click();
    await untilIdle();
    assert.equal(
      (await getPage()).nodes.find((n) => n.tag === 'h1').text,
      'A canvas for every idea.',
    );
    await tab.locator('#redoButton').click();
    await untilIdle();
    assert.equal(
      (await getPage()).nodes.find((n) => n.tag === 'h1').text,
      'Designed locally. Built to last.',
    );
  });
  await check('Native drag updates geometry', async () => {
    const before = (await getPage()).nodes.find((n) => n.tag === 'h1');
    const box = await tab.locator('#selectionBox').boundingBox();
    await tab.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await tab.mouse.down();
    await tab.mouse.move(box.x + box.width / 2 + 18, box.y + box.height / 2 + 10, { steps: 4 });
    await tab.mouse.up();
    await untilIdle();
    const after = (await getPage()).nodes.find((n) => n.tag === 'h1');
    assert.ok(after.x > before.x);
    assert.ok(after.y > before.y);
  });
  await check('Native responsive render at mobile width', async () => {
    await tab.locator('#viewportSelect').selectOption('390');
    await untilIdle();
    assert.equal((await getPage()).viewport.width, 390);
    assert.equal((await getPage()).nodes.find((n) => n.tag === 'h1').styles['font-size'], '42px');
    await tab.locator('#viewportSelect').selectOption('1440');
    await untilIdle();
  });
  await check('Native insert and remove with undo history', async () => {
    const main = (await getPage()).nodes.find((n) => n.tag === 'main');
    await tab.locator(`[data-node-id="${main.id}"]`).click();
    const before = (await getPage()).nodes.length;
    await tab.locator('#insertRectangle').click();
    await untilIdle();
    const inserted = await getPage();
    assert.ok(inserted.nodes.length > before);
    const rectangle = inserted.nodes.find(
      (n) => n.styles['background-color'] === 'rgb(89, 216, 205)',
    );
    assert.ok(rectangle);
    await tab.locator(`[data-node-id="${rectangle.id}"]`).click();
    await tab.locator('#removeNode').click();
    await untilIdle();
    assert.equal((await getPage()).nodes.length, before);
  });
  const status = await tab.evaluate(async () => {
    const r = await fetch('/api/tools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'design_status', arguments: {} }),
    });
    return r.json();
  });
  if (!status.github_repository) {
    console.log('SKIP Repository source browser (no ALCORDESIGN_GITHUB_REPO configured)');
  } else
    await check('Repository source parsed from GitHub checkout', async () => {
      await tab.locator('#sourceButton').click();
      await tab.locator('#sourceSearch').fill('.php');
      await tab.locator('.source-file').filter({ hasText: '.php' }).first().click();
      await tab.waitForFunction(() =>
        document.querySelector('#sourceContent').textContent.includes('<?php'),
      );
      assert.match(await tab.locator('#sourceContent').textContent(), /php/i);
      await tab.locator('[data-close="sourceDialog"]').click();
    });
  await check('Native HTML export download', async () => {
    await tab.locator('#exportButton').click();
    const download = tab.waitForEvent('download');
    await tab.locator('[data-format="html"]').click();
    const file = await download;
    assert.match(file.suggestedFilename(), /\.zip$/);
    assert.equal(await file.failure(), null);
  });
  await check('Reload preserves the design', async () => {
    await tab.reload();
    await tab.locator('#pageImage').waitFor({ state: 'visible' });
    assert.equal(await tab.locator('#projectSelect').inputValue(), projectId);
    const node = (await getPage()).nodes.find((n) => n.tag === 'h1');
    await tab.locator('#layersTab').click();
    await tab.locator(`[data-node-id="${node.id}"]`).click();
    assert.equal(await tab.locator('#propText').inputValue(), 'Designed locally. Built to last.');
  });
  await check('Native editor visual layouts', async () => {
    for (const width of [1440, 1100]) {
      await tab.setViewportSize({ width, height: 1000 });
      await tab.locator('#zoomValue').click();
      await tab.evaluate(() => document.querySelector('#toastArea').replaceChildren());
      await tab.screenshot({ path: path.join(output, `native-editor-${width}.png`) });
      assert.equal(
        await tab.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      assert.equal(
        await tab.locator('.canvas-toolbar').evaluate((e) => e.scrollWidth > e.clientWidth),
        false,
      );
    }
  });
  assert.deepEqual(errors, []);
  checks.push('No runtime errors');
  const result = { ok: true, project_id: projectId, page_id: pageId, checks, output };
  await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
