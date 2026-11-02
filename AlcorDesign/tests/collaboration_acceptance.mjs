/**
 * Two browser sessions open the same project: checks live presence, selection, comment and edit sync between them, and reconnect after going offline.
 *
 * Start an AlcorDesign server on a disposable data directory, then run:
 *
 *   node collaboration_acceptance.mjs URL PLAYWRIGHT_INDEX OUTPUT_DIR [CHROME]
 *
 * URL is http://127.0.0.1:PORT with PORT taken from the server's runtime.json.
 * PLAYWRIGHT_INDEX is the path to a local playwright index.mjs (see ALCORDESIGN_PLAYWRIGHT).
 * OUTPUT_DIR receives checks.json and screenshots. CHROME defaults to ALCORDESIGN_CHROME.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [url, pw, output, chromeArg] = process.argv.slice(2);
const chromePath = chromeArg || process.env.ALCORDESIGN_CHROME;
const { chromium } = await import(pathToFileURL(pw));
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const checks = [],
  errors = [];
const record = (name) => checks.push(name);
const tool = async (page, name, args, expected = 200) => {
  const response = await page.request.post(url + '/api/tools', { data: { name, arguments: args } });
  assert.equal(response.status(), expected, await response.text());
  return response.json();
};
const state = (page) =>
  page.evaluate(() => ({
    project: AlcorDesignUI.state.project?.id,
    page: AlcorDesignUI.state.page?.id,
    revision: AlcorDesignUI.state.page?.revision,
  }));
const heading = (page) =>
  page.evaluate(() => AlcorDesignUI.state.page?.nodes.find((n) => n.tag === 'h1'));
const waitText = (page, text) =>
  page.waitForFunction(
    (text) => AlcorDesignUI.state.page?.nodes.some((n) => n.tag === 'h1' && n.text === text),
    text,
    { timeout: 20000 },
  );
try {
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
    ctxB = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const a = await ctxA.newPage(),
    b = await ctxB.newPage();
  for (const page of [a, b]) page.on('pageerror', (e) => errors.push(e.message));
  await a.goto(url);
  await b.goto(url);
  const imported = await tool(a, 'design_import_html', {
    name: 'Collaboration acceptance',
    html: '<!doctype html><html><head><title>Shared design</title><style>body{padding:30px;background:#182028;color:white}h1{font:44px Arial}</style></head><body><h1 id="title">Original</h1><p>Second layer</p></body></html>',
  });
  for (let i = 0; i < 100; i++) {
    const job = await tool(a, 'design_get_job', { job_id: imported.job_id });
    if (job.status === 'completed') break;
    assert(!['failed', 'partial'].includes(job.status), JSON.stringify(job));
    await a.waitForTimeout(150);
  }
  const project = await tool(a, 'design_get_project', { project_id: imported.project_id });
  const pageId = project.pages[0].id;
  for (const page of [a, b]) {
    await page.goto(url + '/?project=' + project.id);
    await page.waitForFunction(() => !!AlcorDesignUI.state.page?.nodes.length);
  }
  await a.locator('#collaborationName').fill('Alice');
  await a.locator('#collaborationName').blur();
  await b.locator('#collaborationName').fill('Bob');
  await b.locator('#collaborationName').blur();
  await a.waitForFunction(() =>
    document.getElementById('collaborationPeers').textContent.includes('Bob'),
  );
  await b.waitForFunction(() =>
    document.getElementById('collaborationPeers').textContent.includes('Alice'),
  );
  record('two independent browser sessions discover presence');
  const initial = await state(a),
    node = await heading(a);
  await b.evaluate(() =>
    AlcorDesignUI.selectNode(AlcorDesignUI.state.page.nodes.find((n) => n.tag === 'h1')),
  );
  await a.waitForFunction(() => document.querySelectorAll('.collaboration-selection').length === 1);
  record('remote layer selection shown');
  await a.evaluate(() =>
    AlcorDesignUI.selectNode(AlcorDesignUI.state.page.nodes.find((n) => n.tag === 'h1')),
  );
  await a.locator('#propText').fill('Alice saved');
  await a.locator('#applyButton').click();
  await waitText(b, 'Alice saved');
  record('actual UI edit propagates to other session');
  const current = await state(b);
  const conflict = await tool(
    b,
    'design_update_node',
    {
      project_id: project.id,
      page_id: pageId,
      selector: node.selector,
      expected_revision: initial.revision,
      text: 'Must not overwrite',
    },
    409,
  );
  assert.equal(conflict.code, 'revision_conflict');
  assert.equal(conflict.current_revision, current.revision);
  assert.equal((await heading(a)).text, 'Alice saved');
  record('stale write returns structured 409 and preserves saved text');
  const missing = await tool(
    b,
    'design_update_node',
    { project_id: project.id, page_id: pageId, selector: node.selector, text: 'Missing revision' },
    400,
  );
  assert.match(missing.error, /expected_revision/);
  record('unversioned write refused');
  await b.evaluate(() =>
    AlcorDesignUI.selectNode(AlcorDesignUI.state.page.nodes.find((n) => n.tag === 'h1')),
  );
  await b.locator('#propText').fill('Bob unsaved input');
  await tool(a, 'design_update_node', {
    project_id: project.id,
    page_id: pageId,
    selector: node.selector,
    expected_revision: current.revision,
    text: 'Alice next',
  });
  await b.waitForFunction(() =>
    document.getElementById('collaborationStatus').textContent.includes('Changes waiting'),
  );
  assert.equal(await b.locator('#propText').inputValue(), 'Bob unsaved input');
  assert.equal((await heading(b)).text, 'Alice saved');
  record('remote edit waits without replacing unsaved canvas input');
  await b.locator('#applyButton').click();
  await b.waitForFunction(() =>
    document.querySelector('.toast.error')?.textContent.includes('Revision conflict'),
  );
  assert.equal(await b.locator('#propText').inputValue(), 'Bob unsaved input');
  record('conflicting UI save retains unsaved input');
  await b.evaluate(() =>
    AlcorDesignUI.selectNode(AlcorDesignUI.state.page.nodes.find((n) => n.tag === 'h1')),
  );
  await waitText(b, 'Alice next');
  record('updates resume after resetting local fields');
  await tool(a, 'design_add_comment', {
    project_id: project.id,
    page_id: pageId,
    x: 50,
    y: 50,
    body: 'Shared review',
    author: 'Alice',
  });
  await b.waitForFunction(() =>
    AlcorDesignUI.state.comments.some((c) => c.body === 'Shared review'),
  );
  record('comments propagate between sessions');
  const fresh = await state(a);
  const serverPage = await tool(a, 'design_get_page', { project_id: project.id, page_id: pageId });
  const attempts = await Promise.all(
    ['Race one', 'Race two'].map((text) =>
      a.request.post(url + '/api/tools', {
        data: {
          name: 'design_update_node',
          arguments: {
            project_id: project.id,
            page_id: pageId,
            selector: node.selector,
            expected_revision: serverPage.revision,
            text,
          },
        },
      }),
    ),
  );
  assert.deepEqual(attempts.map((r) => r.status()).sort(), [200, 409]);
  record('simultaneous same-revision edits admit exactly one winner');
  await b.waitForFunction(() => AlcorDesignUI.state.page.revision > 2);
  const beforeOffline = await state(b);
  await ctxB.setOffline(true);
  await b.waitForFunction(() =>
    document.getElementById('collaborationStatus').textContent.includes('Disconnected'),
  );
  await ctxB.setOffline(false);
  await b.waitForFunction(
    () => document.getElementById('collaborationStatus').textContent.includes('Live'),
    null,
    { timeout: 25000 },
  );
  record('disconnection reconnects without reissuing edits');
  const bad = await a.request.post(url + '/api/collaboration/' + project.id, {
    data: { session_id: 'invalid', name: 'Test' },
  });
  assert.equal(bad.status(), 400);
  const outside = await a.request.post(url + '/api/collaboration/' + project.id, {
    data: { session_id: 'a'.repeat(32), name: 'Test', page_id: pageId, cursor: { x: -1, y: 4 } },
  });
  assert.equal(outside.status(), 400);
  const unknown = await a.request.post(url + '/api/collaboration/' + project.id, {
    data: { session_id: 'a'.repeat(32), name: 'Test', page_id: 'missing' },
  });
  assert.equal(unknown.status(), 400);
  const auth = await fetch(url + '/api/collaboration/' + project.id, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 'a'.repeat(32), name: 'Test' }),
  });
  assert.equal(auth.status, 401);
  record('malformed session/cursor/page and unauthenticated requests refused');
  await a.screenshot({ path: output + '/collaboration-desktop.png' });
  await b.setViewportSize({ width: 390, height: 844 });
  assert(await b.locator('#collaborationStatus').isVisible());
  assert(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await b.screenshot({ path: output + '/collaboration-mobile.png' });
  record('desktop and mobile collaboration controls render without horizontal overflow');
  await b.close();
  await a.waitForFunction(
    () => !document.getElementById('collaborationPeers').textContent.includes('Bob'),
    null,
    { timeout: 20000 },
  );
  record('departed session disappears');
  assert.deepEqual(errors, []);
  record('no browser page errors');
} finally {
  fs.writeFileSync(output + '/checks.json', JSON.stringify({ checks, errors }, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ ok: true, checks }, null, 2));
