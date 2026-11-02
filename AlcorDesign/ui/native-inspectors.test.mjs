/**
 * Read-only acceptance against a running AlcorDesign instance (set ALCORDESIGN_URL). Uses its own headless context and blocks every mutation before it is sent.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const modulePath = process.env.ALCORDESIGN_PLAYWRIGHT || '';
const { chromium } = await import(modulePath ? pathToFileURL(modulePath) : 'playwright');
const BASE_URL =
  process.env.ALCORDESIGN_URL ||
  (() => {
    throw new Error('Set ALCORDESIGN_URL to the running server.');
  })();
const output = path.join(
  process.env.LOCALAPPDATA || '/tmp',
  'AlcorDesign/alcor-design/inspector-ui-acceptance',
);
await fs.mkdir(output, { recursive: true });
const readTools = new Set([
  'design_page_sources',
  'design_read_source',
  'design_repo_files',
  'design_index',
  'design_page_tree',
  'design_list_comments',
]);
const calls = [],
  errors = [],
  blocked = [],
  checks = [];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const tab = await context.newPage();
tab.setDefaultTimeout(45000);
tab.on('pageerror', (e) => errors.push(e.message));
await context.route('**/api/tools', async (route) => {
  const body = route.request().postDataJSON();
  if (!readTools.has(body.name)) {
    blocked.push(body.name);
    await route.abort('blockedbyclient');
    return;
  }
  calls.push(body.name);
  await route.continue();
});
const read = (pathname) =>
  tab.evaluate(async (pathname) => {
    const r = await fetch(pathname);
    if (!r.ok) throw new Error(`Read failed ${r.status}`);
    return r.json();
  }, pathname);
const tool = (name, args) =>
  tab.evaluate(
    async ({ name, args }) => {
      const r = await fetch('/api/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, arguments: args }),
      });
      const result = await r.json();
      if (!r.ok || result.error) throw new Error(result.error || `Tool failed ${r.status}`);
      return result;
    },
    { name, args },
  );
async function check(name, fn) {
  await fn();
  checks.push(name);
  console.log(`PASS ${name}`);
}
try {
  await tab.goto(BASE_URL);
  const projects = (await read('/api/projects')).projects;
  const projectId =
    process.env.ALCORDESIGN_PROJECT || projects.find((p) => p.source?.kind !== 'html')?.id;
  if (!projectId) {
    console.log('SKIP read-only inspection: import a site first or set ALCORDESIGN_PROJECT');
    await browser.close();
    process.exit(0);
  }
  const project = await read(`/api/project/${projectId}`);
  const home =
    project.pages.find((p) => p.status === 'ready' && new URL(p.url).pathname === '/') ||
    project.pages.find((p) => p.status === 'ready');
  assert.ok(home, 'Existing project has no rendered page');
  await tab.goto(`${new URL(BASE_URL).origin}/?project=${encodeURIComponent(projectId)}`);
  await tab.locator(`.page-item[data-page-id="${home.id}"]`).click();
  await tab.locator('#pageImage').waitFor({ state: 'visible' });
  const page = await read(`/api/page/${projectId}/${home.id}`),
    scope = { project_id: projectId, page_id: home.id };
  const sources = await tool('design_page_sources', scope);
  const availableCss = sources.stylesheets.filter((s) => s.repo_path && s.available !== false);
  const css =
    availableCss.find((s) => /\/themes\/example-theme\/style\.css$/i.test(s.repo_path)) ||
    availableCss.find((s) => /\/themes\/[^/]+\/style\.css$/i.test(s.repo_path)) ||
    availableCss.find((s) => /\/themes\//i.test(s.repo_path)) ||
    availableCss[0];
  assert.ok(css, 'Real rendered page has no readable linked repository CSS');
  await check('Native linked CSS source equals pinned Git source', async () => {
    await tab.locator('#stylesheetPanelTab').click();
    const key = `linked-${sources.stylesheets.indexOf(css)}`;
    await tab.locator(`#stylesheetSelect option[value="${key}"]`).waitFor({ state: 'attached' });
    assert.equal(
      await tab.locator('#stylesheetSelect').inputValue(),
      key,
      'Main theme should be the default source',
    );
    const expected = await tool('design_read_source', { ...scope, path: css.repo_path });
    await tab.waitForFunction(
      () => document.querySelectorAll('#stylesheetCode .source-code-line').length > 2,
    );
    const actual = await tab.locator('#stylesheetCode .source-code-line code').allTextContents();
    assert.equal(
      actual.join('\n').replace(/\r/g, ''),
      expected.content
        .split('\n')
        .map((line) => line || ' ')
        .join('\n')
        .replace(/\r/g, ''),
    );
    assert.match(
      await tab.locator('#stylesheetMeta').textContent(),
      new RegExp(expected.sha.slice(0, 12)),
    );
    assert.equal(expected.provenance?.sha, css.sha);
  });
  let phpPath;
  await check('Native Files tab reads PHP from recorded capture revision', async () => {
    const listing = await tool('design_repo_files', scope);
    const php = listing.files.find((f) => f.path.endsWith('.php'));
    assert.ok(php, 'Repository has no PHP source');
    phpPath = php.path;
    await tab.locator('#filesPanelTab').click();
    await tab.locator('#filesSearch').fill(php.path);
    const row = tab
      .locator('.repo-file-row')
      .filter({ hasText: path.posix.basename(php.path) })
      .first();
    await row.click();
    await tab.waitForFunction(() =>
      document.querySelector('#filesCode').textContent.includes('<?php'),
    );
    const expected = await tool('design_read_source', { ...scope, path: php.path });
    const actual = await tab.locator('#filesCode .source-code-line code').allTextContents();
    assert.equal(
      actual.join('\n').replace(/\r/g, ''),
      expected.content
        .split('\n')
        .map((line) => line || ' ')
        .join('\n')
        .replace(/\r/g, ''),
    );
    assert.match(
      await tab.locator('#filesProvenance').textContent(),
      new RegExp(expected.sha.slice(0, 12)),
    );
  });
  await check('Native project tree searches and selects a real rendered layer', async () => {
    const target =
      page.nodes.find((n) => n.tag === 'h1' && n.text?.trim().length > 5) ||
      page.nodes.find((n) => n.text?.trim().length > 12 && n.text.length < 100);
    assert.ok(target, 'No searchable rendered text');
    const query = target.text.trim().replace(/\s+/g, ' ').slice(0, 24);
    await tab.locator('#treeTab').click();
    await tab.locator('#navSearch').fill(query);
    const row = tab.locator(`.tree-page-row[data-page-id="${home.id}"]`);
    await row.waitFor();
    await row.click();
    const node = tab.locator(`.tree-node-row[data-node-id="${target.id}"]`);
    await node.waitFor();
    await node.click();
    assert.equal(await tab.locator('#propText').inputValue(), target.text);
    assert.equal(await tab.locator('#selectionBox').isVisible(), true);
  });
  await check('Native source layouts at desktop and compact widths', async () => {
    for (const width of [1440, 1100]) {
      await tab.setViewportSize({ width, height: 1000 });
      await tab.locator('#stylesheetPanelTab').click();
      await tab.locator('#stylesheetCode .source-code-line').first().waitFor();
      await tab.screenshot({ path: path.join(output, `native-stylesheets-${width}.png`) });
      assert.equal(
        await tab.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      assert.equal(
        await tab.locator('.canvas-toolbar').evaluate((e) => e.scrollWidth > e.clientWidth),
        false,
      );
      await tab.locator('#filesPanelTab').click();
      await tab.screenshot({ path: path.join(output, `native-files-${width}.png`) });
      assert.equal(
        await tab.locator('.property-tabs').evaluate((e) => e.scrollWidth > e.clientWidth),
        false,
      );
    }
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  checks.push('No runtime errors or mutation requests');
  const result = {
    ok: true,
    project_id: projectId,
    page_id: home.id,
    source_sha: sources.provenance.sha,
    stylesheet: css.repo_path,
    php: phpPath,
    checks,
    read_tool_calls: calls.length,
    output,
  };
  await fs.writeFile(path.join(output, 'native-receipt.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
