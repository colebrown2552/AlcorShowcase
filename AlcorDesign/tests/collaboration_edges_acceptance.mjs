/**
 * Checks collaboration edge cases: cross-origin and malformed presence requests are refused, polling pauses while the page is hidden, and unsent comment drafts survive remote edits.
 *
 * Start an AlcorDesign server on a disposable data directory, then run:
 *
 *   node collaboration_edges_acceptance.mjs URL PLAYWRIGHT_INDEX OUTPUT_DIR [CHROME]
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
const checks = [];
const record = (name) => checks.push(name);
try {
  const context = await browser.newContext(),
    page = await context.newPage();
  await page.goto(url);
  const tool = async (name, args) => {
    const r = await page.request.post(url + '/api/tools', { data: { name, arguments: args } });
    assert.equal(r.status(), 200, await r.text());
    return r.json();
  };
  const imported = await tool('design_import_html', {
    html: '<html><body><h1>Before race</h1></body></html>',
    name: 'Collaboration edge checks',
  });
  for (let i = 0; i < 100; i++) {
    const job = await tool('design_get_job', { job_id: imported.job_id });
    if (job.status === 'completed') break;
    assert.equal(job.status, 'running');
    await page.waitForTimeout(200);
  }
  const project = await tool('design_get_project', { project_id: imported.project_id }),
    pageId = project.pages[0].id;
  await page.goto(url + '/?project=' + project.id);
  await page.waitForFunction(() => !!AlcorDesignUI.state.page?.nodes.length);
  const beat = async (body, projectId = project.id) =>
    page.request.post(url + '/api/collaboration/' + projectId, { data: body });
  const foreign = { session_id: 'f'.repeat(32), name: 'Ephemeral peer', page_id: pageId };
  let response = await beat({ ...foreign, cursor: { x: 7, y: 9 }, selector: 'h1' });
  assert.equal(response.status(), 200);
  assert((await response.json()).sessions.some((s) => s.name === 'Ephemeral peer'));
  await page.waitForFunction(() =>
    document.getElementById('collaborationPeers').textContent.includes('Ephemeral peer'),
  );
  await page.waitForFunction(
    () => !document.getElementById('collaborationPeers').textContent.includes('Ephemeral peer'),
    null,
    { timeout: 20000 },
  );
  record('ungraceful disappearance expires by server monotonic TTL');
  const unicode = { session_id: 'e'.repeat(32), name: '設計者'.repeat(13), page_id: pageId };
  assert.equal((await beat(unicode)).status(), 200);
  record('Unicode display names accepted');
  assert.equal((await beat({ ...foreign, name: '\n' })).status(), 400);
  assert.equal((await beat({ ...foreign, name: '' })).status(), 400);
  assert.equal((await beat({ ...foreign, unexpected: true })).status(), 422);
  record('empty, control and unknown input fields rejected');
  const origin = await page.request.post(url + '/api/collaboration/' + project.id, {
    headers: { Origin: 'https://example.com' },
    data: foreign,
  });
  assert.equal(origin.status(), 403);
  record('cross-origin presence access refused');
  for (const name of [
    'design_update_node',
    'design_insert_node',
    'design_remove_node',
    'design_render_page',
    'design_undo',
    'design_redo',
  ]) {
    const r = await page.request.post(url + '/api/tools', {
      data: {
        name,
        arguments: {
          project_id: project.id,
          page_id: pageId,
          selector: 'h1',
          kind: 'text',
          width: 390,
          height: 844,
          text: 'unversioned',
        },
      },
    });
    assert.equal(r.status(), 400);
    assert.match((await r.json()).error, /expected_revision/);
  }
  record('all six canvas mutation types require observed revision');
  let entered;
  const requestStarted = new Promise((resolve) => (entered = resolve));
  let resume;
  const paused = new Promise((resolve) => (resume = resolve));
  await page.route('**/api/project/' + project.id, async (route) => {
    entered();
    await paused;
    await route.continue();
  });
  const initial = await tool('design_get_page', { project_id: project.id, page_id: pageId });
  const node = initial.nodes.find((n) => n.tag === 'h1');
  await page.evaluate(() =>
    AlcorDesignUI.selectNode(AlcorDesignUI.state.page.nodes.find((n) => n.tag === 'h1')),
  );
  await tool('design_update_node', {
    project_id: project.id,
    page_id: pageId,
    selector: node.selector,
    expected_revision: initial.revision,
    text: 'Remote race update',
  });
  await requestStarted;
  await page.locator('#propText').fill('Typed while refresh was in flight');
  resume();
  await page.waitForFunction(() =>
    document.getElementById('collaborationStatus').textContent.includes('Changes waiting'),
  );
  assert.equal(await page.locator('#propText').inputValue(), 'Typed while refresh was in flight');
  assert.equal(
    await page.evaluate(() => AlcorDesignUI.state.page.nodes.find((n) => n.tag === 'h1').text),
    'Before race',
  );
  record('typing during in-flight refresh prevents late overwrite');
  await page.unroute('**/api/project/' + project.id);
  await page.locator('#resetProperties').click();
  await page.waitForFunction(
    () => AlcorDesignUI.state.page.nodes.find((n) => n.tag === 'h1').text === 'Remote race update',
  );
  record('explicit reset permits pending remote update');
  let heartbeats = 0;
  page.on('request', (r) => {
    if (r.url().includes('/api/collaboration/')) heartbeats++;
  });
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(500);
  const stoppedCount = heartbeats;
  await page.waitForTimeout(2600);
  assert.equal(heartbeats, stoppedCount);
  record('hidden document pauses polling (synthetic visibility event)');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() =>
    document.getElementById('collaborationStatus').textContent.includes('Live'),
  );
  record('visible document resumes polling');
  // This uses the real pagechange handler and preserves a dirty comment, not a mocked editor.
  await page.locator('#commentTool').click();
  await page.locator('#artboard').click({ position: { x: 50, y: 80 } });
  await page.locator('#newCommentForm').waitFor({ state: 'visible' });
  await page.locator('#newCommentBody').fill('Comment draft');
  const current = await tool('design_get_page', { project_id: project.id, page_id: pageId });
  await tool('design_update_node', {
    project_id: project.id,
    page_id: pageId,
    selector: node.selector,
    expected_revision: current.revision,
    text: 'Later update',
  });
  await page.waitForFunction(() =>
    document.getElementById('collaborationStatus').textContent.includes('Changes waiting'),
  );
  assert.equal(await page.locator('#newCommentBody').inputValue(), 'Comment draft');
  record('unsubmitted comment survives remote canvas edit');
} finally {
  fs.writeFileSync(output + '/checks.json', JSON.stringify({ checks }, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ ok: true, checks }, null, 2));
