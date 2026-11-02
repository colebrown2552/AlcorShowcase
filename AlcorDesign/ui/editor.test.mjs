/**
 * UI integration checks against a synthetic API server and headless Chromium. No real project or running app is touched.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const playwrightPath = process.env.ALCORDESIGN_PLAYWRIGHT || '';
const { chromium } = await import(playwrightPath ? pathToFileURL(playwrightPath) : 'playwright');
const output = path.join(
  process.env.LOCALAPPDATA || '/tmp',
  'AlcorDesign',
  'alcor-design',
  'ui-acceptance',
);
await fs.mkdir(output, { recursive: true });
const clone = (x) => structuredClone(x);
let page = {
  id: 'page1',
  title: 'Alcor test page | Example Site',
  url: 'https://www.example.com/',
  status: 'ready',
  revision: 1,
  screenshot: '/files/test.png',
  viewport: { width: 1440, height: 1000 },
  document_height: 1000,
  can_undo: false,
  can_redo: false,
  nodes: [
    {
      id: 'body',
      parent_id: null,
      selector: 'body',
      tag: 'body',
      name: 'Page',
      text: '',
      x: 0,
      y: 0,
      width: 1440,
      height: 1000,
      styles: { 'background-color': 'rgb(247, 250, 249)' },
    },
    {
      id: 'heading',
      parent_id: 'body',
      selector: '#heading',
      tag: 'h1',
      name: 'Hello Alcor',
      text: 'Hello Alcor',
      x: 100,
      y: 120,
      width: 450,
      height: 70,
      styles: {
        color: 'rgb(18, 55, 43)',
        'background-color': 'rgba(0, 0, 0, 0)',
        'font-size': '52px',
        'font-family': 'Arial',
        'font-weight': '700',
        'line-height': '62px',
        'letter-spacing': '0px',
        opacity: '1',
        translate: 'none',
      },
    },
  ],
};
const project = {
  id: 'test',
  name: 'Example Site',
  source: { url: page.url, repo: 'example-owner/example-repo' },
  pages: [page],
  revision: 1,
};
page.comments = [];
const history = [],
  redo = [],
  calls = [];
function before() {
  history.push(clone(page));
  redo.length = 0;
}
function sync() {
  page.can_undo = history.length > 0;
  page.can_redo = redo.length > 0;
  project.pages = [page];
}
function safe(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;');
}
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    function json(data, status = 200) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    }
    if (pathname === '/api/projects')
      return json({ projects: [{ id: project.id, name: project.name, page_count: 1 }] });
    if (pathname.startsWith('/api/project/')) return json(project);
    if (pathname.startsWith('/api/page/')) return json(page);
    if (pathname.startsWith('/api/jobs/'))
      return json({
        id: 'job1',
        status: 'complete',
        completed: 1,
        total: 1,
        message: 'Imported',
        project_id: 'test',
      });
    if (pathname === '/api/tools') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { name, arguments: a } = JSON.parse(raw);
      calls.push({ name, args: a });
      if (name === 'design_list_comments') return json({ comments: page.comments || [] });
      if (name === 'design_add_comment') {
        const comment = {
          id: 'comment1',
          x: a.x,
          y: a.y,
          body: a.body,
          author: a.author,
          created: 1793040000,
          resolved: false,
          replies: [],
        };
        page.comments = [...(page.comments || []), comment];
        return json({ comments: page.comments, comment });
      }
      if (name === 'design_reply_comment') {
        const comment = page.comments.find((c) => c.id === a.comment_id);
        comment.replies.push({ id: 'reply1', body: a.body, author: a.author, created: 1793040001 });
        return json({ comments: page.comments, comment });
      }
      if (name === 'design_resolve_comment') {
        const comment = page.comments.find((c) => c.id === a.comment_id);
        comment.resolved = a.resolved;
        return json({ comments: page.comments, comment });
      }
      if (name === 'design_delete_comment') {
        page.comments = page.comments.filter((c) => c.id !== a.comment_id);
        return json({ comments: page.comments });
      }
      if (name === 'design_update_node') {
        before();
        const n = page.nodes.find((x) => x.selector === a.selector);
        if (a.text !== undefined) {
          n.text = a.text;
          n.name = a.text;
        }
        Object.assign(n.styles, a.styles || {});
        if (a.styles?.translate) {
          const [x, y] = a.styles.translate.split(' ').map(parseFloat);
          n.x = 100 + x;
          n.y = 120 + y;
        }
        page.revision++;
        sync();
        return json(page);
      }
      if (name === 'design_undo') {
        redo.push(clone(page));
        page = history.pop();
        sync();
        return json(page);
      }
      if (name === 'design_redo') {
        history.push(clone(page));
        page = redo.pop();
        sync();
        return json(page);
      }
      if (name === 'design_render_page') {
        before();
        page.viewport = { width: a.width, height: a.height };
        page.revision++;
        sync();
        return json(page);
      }
      if (name === 'design_insert_node') {
        before();
        page.nodes.push({
          id: 'new',
          parent_id: 'body',
          selector: '#new',
          tag: a.kind === 'text' ? 'p' : 'div',
          name: 'New element',
          text: a.text || '',
          x: 100,
          y: 280,
          width: 240,
          height: 100,
          styles: {},
        });
        page.revision++;
        sync();
        return json(page);
      }
      if (name === 'design_remove_node') {
        before();
        page.nodes = page.nodes.filter((n) => n.selector !== a.selector);
        page.revision++;
        sync();
        return json(page);
      }
      if (name.startsWith('design_import_')) return json({ project_id: 'test', job_id: 'job1' });
      if (name === 'design_export')
        return json({ url: '/files/export.json', name: 'alcor-design.json' });
      if (name === 'design_repo_files')
        return json({
          repo: 'example-owner/example-repo',
          sha: 'abc123',
          files: [
            { path: 'site/index.php', kind: 'php' },
            { path: 'site/style.css', kind: 'css' },
          ].filter((f) => f.path.includes(a.query || '')),
        });
      if (name === 'design_read_source')
        return json({
          path: a.path,
          content: '<?php // Synthetic source fixture\n',
          sha: 'abc123',
        });
      return json({ error: 'Unknown tool' }, 400);
    }
    if (pathname === '/files/test.png') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      const heading = page.nodes.find((n) => n.id === 'heading');
      res.end(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${page.viewport.width}" height="1000"><rect width="100%" height="100%" fill="#f7faf9"/><text x="${heading?.x || 100}" y="${(heading?.y || 120) + 52}" font-family="Arial" font-size="52" fill="${heading?.styles.color || '#12372b'}">${safe(heading?.text || '')}</text><rect x="100" y="240" width="600" height="300" rx="10" fill="#d5eee5"/></svg>`,
      );
      return;
    }
    if (pathname === '/files/export.json') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="alcor-design.json"',
      });
      res.end(JSON.stringify(project));
      return;
    }
    const file = {
      '/': 'index.html',
      '/app.js': 'app.js',
      '/inspectors.js': 'inspectors.js',
      '/style.css': 'style.css',
    }[pathname];
    if (file) {
      res.writeHead(200, {
        'Content-Type': file.endsWith('css')
          ? 'text/css'
          : file.endsWith('js')
            ? 'text/javascript'
            : 'text/html',
      });
      res.end(await fs.readFile(path.join(root, file)));
      return;
    }
    res.writeHead(404);
    res.end();
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
});
const tab = await context.newPage();
const errors = [];
tab.on('pageerror', (error) => errors.push(error.message));
const checks = [];
async function check(name, fn) {
  await fn();
  checks.push(name);
}
try {
  await tab.goto(`http://127.0.0.1:${port}/`);
  await tab.locator('#pageImage').waitFor({ state: 'visible' });
  await tab.waitForFunction(() => document.querySelector('#pageImage').complete);
  await check('Document and real screenshot loaded', async () => {
    assert.equal(await tab.locator('#projectSelect').inputValue(), 'test');
    assert.equal(await tab.locator('#pageTitle').textContent(), 'Alcor test page');
  });
  await check('Layer selection and properties', async () => {
    await tab.locator('#layersTab').click();
    await tab.locator('[data-node-id="heading"]').click();
    assert.equal(await tab.locator('#propText').inputValue(), 'Hello Alcor');
    assert.equal(await tab.locator('#selectionBox').isVisible(), true);
  });
  await check('Text and CSS updates persist', async () => {
    await tab.locator('#propText').fill('Designed with Alcor');
    await tab.locator('#propColor').fill('#ba3366');
    await tab.locator('#applyButton').click();
    await tab.waitForFunction(() => !document.body.classList.contains('busy'));
    assert.equal(page.nodes[1].text, 'Designed with Alcor');
    assert.equal(page.nodes[1].styles.color, '#ba3366');
  });
  await check('Undo and redo', async () => {
    await tab.locator('#undoButton').click();
    await tab.waitForFunction(() => !document.body.classList.contains('busy'));
    assert.equal(page.nodes[1].text, 'Hello Alcor');
    await tab.locator('#redoButton').click();
    await tab.waitForFunction(() => !document.body.classList.contains('busy'));
    assert.equal(page.nodes[1].text, 'Designed with Alcor');
  });
  await check('Canvas drag persists CSS translation', async () => {
    const box = await tab.locator('#selectionBox').boundingBox();
    await tab.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await tab.mouse.down();
    await tab.mouse.move(box.x + box.width / 2 + 25, box.y + box.height / 2 + 12, { steps: 4 });
    await tab.mouse.up();
    await tab.waitForFunction(() => !document.body.classList.contains('busy'));
    assert.match(page.nodes[1].styles.translate, /px/);
    assert.ok(page.nodes[1].x > 100);
  });
  await check('Viewport rendering and fit', async () => {
    await tab.locator('#viewportSelect').selectOption('390');
    await tab.waitForFunction(() => !document.body.classList.contains('busy'));
    assert.equal(page.viewport.width, 390);
    assert.ok((await tab.locator('#zoomValue').textContent()).includes('%'));
  });
  await check('Insert and remove layer', async () => {
    await tab.locator('#insertRectangle').click();
    await tab.waitForFunction(() => !document.body.classList.contains('busy'));
    await tab.locator('[data-node-id="new"]').click();
    await tab.locator('#removeNode').click();
    await tab.waitForFunction(() => !document.body.classList.contains('busy'));
    assert.equal(
      page.nodes.some((n) => n.id === 'new'),
      false,
    );
  });
  await check('Overview and page navigation', async () => {
    await tab.locator('#overviewButton').click();
    await tab.locator('.overview-card').click();
    await tab.locator('#pageImage').waitFor({ state: 'visible' });
  });
  await check('Repository source browser', async () => {
    await tab.locator('#sourceButton').click();
    await tab.locator('.source-file').first().click();
    await tab.waitForFunction(() =>
      document.querySelector('#sourceContent').textContent.includes('Synthetic source fixture'),
    );
    assert.match(await tab.locator('#sourceContent').textContent(), /Synthetic source fixture/);
    await tab.locator('[data-close="sourceDialog"]').click();
  });
  await check('HTML import and job completion', async () => {
    await tab.locator('#importButton').click();
    await tab.locator('[data-import-tab="html"]').click();
    await tab.locator('#importHtml').fill('<h1>Test HTML</h1>');
    await tab.locator('#startImport').click();
    await tab.locator('#importDialog').waitFor({ state: 'hidden' });
    assert.equal(
      calls.findLast((c) => c.name === 'design_import_html').args.html,
      '<h1>Test HTML</h1>',
    );
  });
  await check('Export download', async () => {
    await tab.locator('#exportButton').click();
    const download = tab.waitForEvent('download');
    await tab.locator('[data-format="json"]').click();
    assert.equal((await download).suggestedFilename(), 'alcor-design.json');
  });
  await check('Comments pin, reply, resolve, reopen and delete', async () => {
    await tab.locator('#commentTool').click();
    const art = await tab.locator('#artboard').boundingBox();
    await tab.mouse.click(art.x + 130, art.y + 230);
    await tab.locator('#newCommentBody').fill('Please refine this area.');
    await tab.locator('#postComment').click();
    await tab.locator('.comment-pin:not(.draft)').waitFor();
    assert.equal(page.comments.length, 1);
    assert.equal(page.comments[0].x, 130);
    assert.equal(page.comments[0].y, 230);
    await tab.locator('#commentReplyBody').fill('I will update it.');
    await tab.locator('#postReply').click();
    await tab.waitForFunction(
      () => document.querySelectorAll('.comment-replies .comment-entry').length === 1,
    );
    assert.equal(page.comments[0].replies.length, 1);
    await tab.locator('#resolveComment').click();
    await tab.waitForFunction(() => document.querySelector('.comment-thread-resolved'));
    assert.equal(page.comments[0].resolved, true);
    await tab.locator('#showResolved').check();
    await tab.locator('.comment-pin.resolved').waitFor();
    await tab.locator('#resolveComment').click();
    await tab.waitForFunction(() => !document.querySelector('.comment-thread-resolved'));
    assert.equal(page.comments[0].resolved, false);
    await tab.locator('#deleteComment').click();
    await tab.waitForFunction(() => document.querySelectorAll('.comment-pin').length === 0);
    assert.equal(page.comments.length, 0);
    await tab.locator('#designPanelTab').click();
  });
  await check('Desktop and compact layouts', async () => {
    for (const width of [1440, 1100]) {
      await tab.setViewportSize({ width, height: 900 });
      await tab.screenshot({ path: path.join(output, `editor-${width}.png`) });
      const overflow = await tab.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false);
      const toolbar = await tab
        .locator('.canvas-toolbar')
        .evaluate((e) => e.scrollWidth <= e.clientWidth);
      assert.equal(toolbar, true, `toolbar overflow at ${width}`);
    }
  });
  assert.deepEqual(errors, []);
  checks.push('No JavaScript runtime errors');
  console.log(JSON.stringify({ ok: true, checks, output }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
