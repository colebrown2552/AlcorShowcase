/**
 * Acceptance checks for comments against a running AlcorDesign server (set ALCORDESIGN_URL). Uses a synthetic document, not an imported site.
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
  'AlcorDesign/alcor-design/native-ui-acceptance',
);
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const tab = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
tab.setDefaultTimeout(30000);
const errors = [],
  checks = [];
tab.on('pageerror', (e) => errors.push(e.message));
const read = (pathname) =>
  tab.evaluate(async (pathname) => {
    const r = await fetch(pathname);
    return r.json();
  }, pathname);
let projectId, pageId, commentId;
const comments = () =>
  tab.evaluate(
    async ({ project_id, page_id }) => {
      const r = await fetch('/api/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'design_list_comments', arguments: { project_id, page_id } }),
      });
      return r.json();
    },
    { project_id: projectId, page_id: pageId },
  );
async function check(name, fn) {
  await fn();
  checks.push(name);
  console.log(`PASS ${name}`);
}
try {
  await tab.goto(BASE_URL);
  const list = await read('/api/projects');
  const own = list.projects
    .filter((p) => p.name.startsWith('UI acceptance '))
    .sort((a, b) => b.created - a.created)[0];
  assert.ok(own, 'Run native-editor.test.mjs first to create the synthetic acceptance document.');
  projectId = own.id;
  await tab.goto(`${new URL(BASE_URL).origin}/?project=${projectId}`);
  await tab.locator('#pageImage').waitFor({ state: 'visible' });
  await tab.waitForFunction(
    () =>
      document.querySelector('#pageImage').complete &&
      document.querySelector('#pageImage').naturalWidth > 0,
  );
  const project = await read(`/api/project/${projectId}`);
  pageId = project.pages[0].id;
  await check('Native comment pin preserves document coordinates', async () => {
    const before = await read(`/api/page/${projectId}/${pageId}`);
    await tab.locator('#commentTool').click();
    await tab.locator('#commentAuthor').fill('UI acceptance');
    const art = await tab.locator('#artboard').boundingBox();
    const zoom = art.width / before.viewport.width;
    await tab.mouse.click(art.x + 300 * zoom, art.y + 240 * zoom);
    await tab
      .locator('#newCommentBody')
      .fill('Please align this heading with the card. <b>Plain text</b>');
    await tab.locator('#postComment').click();
    await tab.locator('#commentThread').waitFor({ state: 'visible' });
    const rows = (await comments()).comments;
    const comment = rows.find((c) => c.body.includes('Please align this heading'));
    assert.ok(comment);
    commentId = comment.id;
    assert.equal(comment.x, 300);
    assert.equal(comment.y, 240);
    assert.equal(comment.author, 'UI acceptance');
    assert.equal(await tab.locator('#commentThread b').count(), 0);
    const after = await read(`/api/page/${projectId}/${pageId}`);
    assert.deepEqual(after.nodes, before.nodes);
  });
  await check('Native comment replies persist', async () => {
    await tab
      .locator('#commentReplyBody')
      .fill('The card and heading should share the same left edge.');
    await tab.locator('#postReply').click();
    await tab.waitForFunction(
      () => document.querySelectorAll('.comment-replies .comment-entry').length === 1,
    );
    const c = (await comments()).comments.find((c) => c.id === commentId);
    assert.equal(c.replies.length, 1);
    assert.match(c.replies[0].body, /same left edge/);
  });
  await check('Pin remains screen-sized while canvas zooms', async () => {
    const selector = `.comment-pin[data-comment-id="${commentId}"]`;
    const before = await tab.locator(selector).boundingBox();
    await tab.locator('#zoomIn').click();
    const after = await tab.locator(selector).boundingBox();
    assert.ok(Math.abs(before.width - after.width) < 1);
    assert.ok(Math.abs(before.height - after.height) < 1);
    await tab.locator('#zoomValue').click();
  });
  await check('Comments and replies survive editor reload', async () => {
    await tab.reload();
    await tab.locator(`.comment-pin[data-comment-id="${commentId}"]`).click();
    assert.match(await tab.locator('#commentThread').textContent(), /same left edge/);
    await tab.evaluate(() => document.querySelector('#toastArea').replaceChildren());
    await tab.screenshot({ path: path.join(output, 'native-comments-1440.png') });
  });
  await check('Resolve filter and reopen update native storage', async () => {
    await tab.locator('#resolveComment').click();
    await tab.locator('.comment-thread-resolved').waitFor();
    assert.equal((await comments()).comments.find((c) => c.id === commentId).resolved, true);
    assert.equal(await tab.locator(`.comment-pin[data-comment-id="${commentId}"]`).count(), 0);
    await tab.locator('#showResolved').check();
    await tab.locator(`.comment-pin.resolved[data-comment-id="${commentId}"]`).waitFor();
    await tab.locator('#resolveComment').click();
    await tab.locator('.comment-thread-resolved').waitFor({ state: 'hidden' });
    assert.equal((await comments()).comments.find((c) => c.id === commentId).resolved, false);
  });
  await check('Comments fit compact editor layout', async () => {
    await tab.setViewportSize({ width: 1100, height: 1000 });
    await tab.locator('#zoomValue').click();
    await tab.screenshot({ path: path.join(output, 'native-comments-1100.png') });
    assert.equal(
      await tab.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    assert.equal(
      await tab.locator('.canvas-toolbar').evaluate((e) => e.scrollWidth > e.clientWidth),
      false,
    );
  });
  await check('Delete removes only the selected thread', async () => {
    await tab.locator('#deleteComment').click();
    await tab.locator(`#commentThread`).waitFor({ state: 'hidden' });
    assert.equal(
      (await comments()).comments.some((c) => c.id === commentId),
      false,
    );
  });
  assert.deepEqual(errors, []);
  checks.push('No runtime errors');
  const result = { ok: true, project_id: projectId, page_id: pageId, checks, output };
  await fs.writeFile(path.join(output, 'comments-receipt.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
