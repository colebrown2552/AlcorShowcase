/**
 * Browser checks for the source inspectors and tree navigation against a synthetic server. No real repository or running app is modified.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const modulePath = process.env.ALCORDESIGN_PLAYWRIGHT || '';
const { chromium } = await import(modulePath ? pathToFileURL(modulePath) : 'playwright');
const output = path.join(
  process.env.LOCALAPPDATA || '/tmp',
  'AlcorDesign/alcor-design/inspector-ui-acceptance',
);
await fs.mkdir(output, { recursive: true });
const shaA = 'a111111111111111111111111111111111111111',
  shaB = 'b222222222222222222222222222222222222222';
const shaC = 'c333333333333333333333333333333333333333',
  branch = 'alcordesign/site',
  baseBranch = 'review-base';
const cssPath = 'site/wp-content/themes/example-theme/style.css';
const files = [
  { path: cssPath, kind: 'css' },
  { path: 'site/wp-content/themes/example-theme/page-contact.php', kind: 'php' },
  { path: 'site/wp-content/themes/example-theme/header.php', kind: 'php' },
  { path: 'site/examples/index.html', kind: 'html' },
];
const conflictPath = 'site/wp-content/themes/example-theme/page-conflict.php';
const largePath = 'site/wp-content/themes/example-theme/large-test.css';
const largeContent = Array.from({ length: 12000 }, (_, i) =>
  i === 2999 || i === 11998 ? `/* distant-match-marker ${i + 1} */` : `/* line ${i + 1} */`,
).join('\n');
const branchFiles = [
  ...files.filter((f) => f.kind === 'css' || f.kind === 'php'),
  { path: largePath, kind: 'css' },
  { path: 'site/wp-content/themes/example-theme/page-new.php', kind: 'php' },
  { path: 'site/wp-content/themes/example-theme/page-mixed.php', kind: 'php' },
  {
    path: conflictPath,
    kind: 'php',
    editable: false,
    conflict: true,
    conflict_reason:
      'Preview and review branches changed this file differently. Resolve the branch conflict.',
  },
];
const savedDrafts = new Map(),
  syncedContent = new Map(),
  operations = new Map();
let syncMode = 'success',
  saveMode = 'success',
  pendingSync = null,
  lastSync = null,
  syncCalls = 0,
  syncEffects = 0,
  saveEffects = 0,
  statusOffline = false;
const liveReceipts = new Map(),
  snapshots = new Map(),
  jobs = new Map();
let liveEffects = 0,
  liveMode = 'success',
  liveStatusOffline = false;
function snapshotPage(page, reason) {
  const id = `snapshot-${snapshots.size + 1}`;
  snapshots.set(id, { id, page: structuredClone(page), reason });
  return id;
}
const draftSetVersion = () =>
  createHash('sha256')
    .update(
      [...savedDrafts]
        .map(([p, d]) => `${p}=${d.version}`)
        .sort()
        .join('|'),
    )
    .digest('hex');
const branchContent = (p) =>
  syncedContent.get(p) ??
  (p === largePath
    ? largeContent
    : p.endsWith('.css')
      ? ':root {\n  --accent: #ffbbcc;\n}\n.hero { color: var(--accent); }\n'
      : p.endsWith('page-mixed.php')
        ? '<?php\r\n// current\nget_header();\r?>\n'
        : `<?php\r\n// current integration branch\r\nget_header();\r\n?><h1>${p}</h1>\r\n`);
function editable(path) {
  const current = savedDrafts.get(path);
  return {
    project_id: 'site',
    path,
    content: current?.content ?? branchContent(path),
    version: current?.version ?? (syncedContent.has(path) ? 'blob:synced' : 'blob:current'),
    base_sha: shaC,
    base_blob: 'current',
    branch,
    base_branch: baseBranch,
    dirty: !!current,
    provenance: {
      sha: shaC,
      basis: 'editing_branch',
      editing_ref: baseBranch,
      branches_diverged: true,
      integration_note:
        'Preview and review branches diverged; eventual promotion may need conflict resolution.',
    },
  };
}
function makePage(id, title, url, text) {
  return {
    id,
    title,
    url,
    status: 'ready',
    viewport: { width: 1440, height: 1200 },
    screenshot: `/files/${id}.svg`,
    revision: 1,
    node_count: 2,
    can_undo: false,
    can_redo: false,
    comments: [],
    nodes: [
      {
        id: `${id}-main`,
        parent_id: null,
        selector: 'main',
        tag: 'main',
        name: 'Main content',
        text: '',
        x: 80,
        y: 100,
        width: 1100,
        height: 700,
        styles: {},
        depth: 0,
        child_count: 1,
      },
      {
        id: `${id}-title`,
        parent_id: `${id}-main`,
        selector: 'h1',
        tag: 'h1',
        name: 'Page heading',
        text,
        x: 100,
        y: 140,
        width: 700,
        height: 80,
        styles: { color: 'rgb(140, 232, 205)', 'font-size': '64px', 'font-weight': '500' },
        depth: 1,
        child_count: 0,
      },
    ],
  };
}
const pages = [
  makePage('home', 'Example Site', 'https://www.example.com/', 'Websites for small businesses.'),
  makePage(
    'contact',
    'Contact Alcor',
    'https://www.example.com/contact/',
    'Email us about your next project.',
  ),
];
const project = {
  id: 'site',
  name: 'Example Site',
  source: {
    kind: 'github',
    url: 'https://www.example.com/',
    repository: 'https://github.com/example-owner/example-repo',
    sha: shaA,
  },
  pages,
  revision: 1,
};
const calls = [],
  errors = [];
let staleGate;
function provenance(id) {
  return {
    sha: id === 'contact' ? shaB : shaA,
    basis: 'page_capture_commit',
    capture_commit: id === 'contact' ? shaB : shaA,
    source_matches_capture: true,
  };
}
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    function json(data, status = 200) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    }
    if (pathname === '/api/projects')
      return json({ projects: [{ id: 'site', name: project.name, page_count: 2, created: 1 }] });
    if (pathname === '/api/project/site') return json(project);
    if (pathname.startsWith('/api/page/site/'))
      return json(pages.find((p) => p.id === pathname.split('/').pop()));
    if (pathname.startsWith('/api/jobs/'))
      return json(
        jobs.get(pathname.split('/').pop()) || { error: 'Job not found' },
        jobs.has(pathname.split('/').pop()) ? 200 : 404,
      );
    if (pathname === '/api/tools') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { name, arguments: a } = JSON.parse(raw);
      calls.push({ name, args: a });
      if (name === 'design_page_sources')
        return json({
          stylesheets: [
            {
              url: 'https://fonts.googleapis.com/css2?family=Example',
              source: 'linked-stylesheet',
              available: false,
            },
            {
              url: 'https://www.example.com/wp-content/plugins/alcoros/assets/demo.css',
              repo_path: 'site/wp-content/plugins/alcoros/assets/demo.css',
              sha: provenance(a.page_id).sha,
              available: true,
              source: 'linked-stylesheet',
            },
            {
              url: 'https://www.example.com/wp-content/themes/example-theme/assets/css/site.css?ver=1',
              repo_path: cssPath,
              sha: provenance(a.page_id).sha,
              available: true,
              source: 'linked-stylesheet',
            },
          ],
          inline_styles: [
            {
              index: 0,
              id: 'inline',
              content: '.inline-badge { color: #8ce8cd; }',
              bytes: 37,
              truncated: false,
            },
          ],
          provenance: provenance(a.page_id),
        });
      if (name === 'design_source_files')
        return json({
          project_id: 'site',
          branch,
          base_branch: baseBranch,
          editing_ref: baseBranch,
          sha: shaC,
          files: branchFiles.map((f) => ({
            ...f,
            editable: f.editable !== false,
            dirty: savedDrafts.has(f.path),
          })),
          total: branchFiles.length,
          truncated: false,
        });
      if (name === 'design_status')
        return json({
          github_repository: 'example-owner/example-repo',
          repo: 'https://github.com/example-owner/example-repo',
        });
      if (name === 'design_source_sync_status') {
        if (statusOffline) return json({ error: 'Status temporarily unavailable' }, 503);
        return json({
          project_id: 'site',
          branch,
          base_branch: baseBranch,
          dirty_count: savedDrafts.size,
          draft_set_version: draftSetVersion(),
          files: [...savedDrafts].map(([path, d]) => ({
            path,
            version: d.version,
            base_sha: shaC,
          })),
          pending_sync: pendingSync,
          last_sync: lastSync,
          compare_url: `https://github.com/example-owner/example-repo/compare/${baseBranch}...${branch}`,
        });
      }
      if (name === 'design_source_operation_status') {
        if (statusOffline) return json({ error: 'Status temporarily unavailable' }, 503);
        const op = operations.get(a.request_id),
          result =
            op?.type === 'save'
              ? Object.fromEntries(Object.entries(op.result).filter(([key]) => key !== 'content'))
              : op?.result;
        return json(
          op
            ? {
                request_id: a.request_id,
                operation_type: op.type,
                state: op.state,
                ...(op.state === 'completed' ? { result } : {}),
              }
            : { request_id: a.request_id, operation_type: null, state: 'not_found' },
        );
      }
      if (name === 'design_source_draft') return json(editable(a.path));
      if (name === 'design_save_source') {
        if (!a.request_id) return json({ error: 'request_id required' }, 400);
        let op = operations.get(a.request_id);
        if (!op) {
          const current = editable(a.path);
          if (a.expected_version !== current.version)
            return json(
              { error: 'Source changed since it was opened; your edit was not saved' },
              400,
            );
          saveEffects++;
          savedDrafts.set(a.path, { content: a.content, version: `draft:${Date.now()}` });
          op = {
            type: 'save',
            state: 'completed',
            result: { ...editable(a.path), saved: true, request_id: a.request_id },
          };
          operations.set(a.request_id, op);
        }
        if (saveMode === 'transport') {
          res.destroy();
          return;
        }
        return json(op.result);
      }
      if (name === 'design_sync_sources') {
        syncCalls++;
        if (!a.request_id || !a.draft_set_version)
          return json({ error: 'request_id and draft_set_version required' }, 400);
        let op = operations.get(a.request_id);
        const fingerprint = JSON.stringify({
          project_id: a.project_id,
          draft_set_version: a.draft_set_version,
        });
        if (op && op.fingerprint !== fingerprint)
          return json({ error: 'request_id reused for different sync' }, 400);
        if (!op) {
          if (syncMode === 'delayed') {
            res.destroy();
            return;
          }
          if (a.draft_set_version !== draftSetVersion())
            op = {
              type: 'sync',
              state: 'completed',
              result: {
                pushed: false,
                uncertain: false,
                request_id: a.request_id,
                message: 'Draft set changed; refresh status',
              },
            };
          else {
            syncEffects++;
            if (syncMode === 'transport' || syncMode === 'uncertain') {
              pendingSync = {
                state: 'uncertain',
                transaction_id: 'fixture-1',
                request_id: a.request_id,
              };
              op = {
                type: 'sync',
                state: 'pending',
                result: {
                  pushed: null,
                  uncertain: true,
                  request_id: a.request_id,
                  transaction_id: 'fixture-1',
                  pending_sync: pendingSync,
                },
              };
            } else if (syncMode === 'conflict') {
              op = {
                type: 'sync',
                state: 'completed',
                result: {
                  pushed: false,
                  uncertain: false,
                  request_id: a.request_id,
                  message: 'The repository changed; review the conflict',
                },
              };
            } else {
              for (const [path, draft] of savedDrafts) syncedContent.set(path, draft.content);
              savedDrafts.clear();
              lastSync = { state: 'pushed', commit: 'd444', request_id: a.request_id };
              op = {
                type: 'sync',
                state: 'completed',
                result: {
                  project_id: 'site',
                  request_id: a.request_id,
                  branch,
                  base_branch: baseBranch,
                  commit: 'd444',
                  pushed: true,
                  uncertain: false,
                  dirty_count: 0,
                  compare_url: `https://github.com/example-owner/example-repo/compare/${baseBranch}...${branch}`,
                },
              };
            }
          }
          op.fingerprint = fingerprint;
          operations.set(a.request_id, op);
        }
        if (syncMode === 'transport') {
          res.destroy();
          return;
        }
        return json(op.result);
      }
      if (name === 'design_refresh_operation_status') {
        if (liveStatusOffline) return json({ error: 'Refresh status unavailable' }, 503);
        const receipt = liveReceipts.get(a.request_id);
        return json(
          receipt || {
            project_id: 'site',
            request_id: a.request_id,
            state: 'not_found',
            result: null,
          },
        );
      }
      if (name === 'design_list_page_snapshots') {
        return json({
          project_id: 'site',
          page_id: a.page_id,
          snapshots: [...snapshots]
            .filter(([, s]) => s.page.id === a.page_id)
            .map(([snapshot_id, s]) => ({
              snapshot_id,
              revision: s.page.revision,
              reason: s.reason,
              comment_count: (s.page.comments || []).length,
              commit: shaA,
            })),
        });
      }
      if (name === 'design_refresh_live_page' || name === 'design_restore_page_snapshot') {
        if (liveReceipts.has(a.request_id)) {
          if (liveMode === 'transport') {
            res.destroy();
            return;
          }
          return json(liveReceipts.get(a.request_id));
        }
        const page = pages.find((p) => p.id === a.page_id),
          action = name === 'design_restore_page_snapshot' ? 'restore' : 'page';
        let result,
          state = 'completed';
        if (a.expected_revision !== page.revision) {
          state = 'conflict';
          result = {
            page_id: page.id,
            code: 'revision_conflict',
            message: 'Page changed; reload before refreshing.',
            backup_allowed: false,
          };
        } else if (action === 'page' && !a.keep_snapshot) {
          state = 'conflict';
          result = {
            page_id: page.id,
            code: 'local_or_legacy_conflict',
            message: 'This page has local or unverified edits. Create a backup to refresh.',
            backup_allowed: true,
          };
        } else if (action === 'restore') {
          const snapshot = snapshots.get(a.snapshot_id),
            comments = page.comments,
            revision = page.revision + 1;
          Object.assign(page, structuredClone(snapshot.page));
          page.comments = comments;
          page.revision = revision;
          liveEffects++;
          result = {
            page_id: page.id,
            revision,
            commit: shaA,
            restored_snapshot_id: a.snapshot_id,
            comments_preserved: true,
            warnings: [],
          };
        } else {
          const snapshot_id = snapshotPage(page, 'pre-refresh'),
            comments = page.comments;
          page.revision++;
          page.nodes[1].text = 'Updated preview page';
          page.comments = comments;
          liveEffects++;
          result = {
            page_id: page.id,
            revision: page.revision,
            commit: shaC,
            snapshot_id,
            comments_preserved: true,
            warnings: ['Comment pins may have shifted.'],
          };
        }
        const receipt = { project_id: 'site', request_id: a.request_id, action, state, result };
        liveReceipts.set(a.request_id, receipt);
        if (liveMode === 'transport') {
          res.destroy();
          return;
        }
        return json(receipt);
      }
      if (name === 'design_refresh_live_all') {
        if (liveReceipts.has(a.request_id)) return json(liveReceipts.get(a.request_id));
        const action = 'all',
          job_id = `live-job-${jobs.size + 1}`;
        let completed = 0,
          conflicts = 0;
        const results = [];
        for (const page of pages) {
          if (!a.keep_snapshot) {
            conflicts++;
            results.push({
              page_id: page.id,
              url: page.url,
              state: 'conflict',
              result: {
                code: 'local_or_legacy_conflict',
                message: 'Saved design needs a backup.',
                backup_allowed: true,
              },
            });
            continue;
          }
          snapshotPage(page, 'batch-pre-refresh');
          page.revision++;
          liveEffects++;
          completed++;
          results.push({ page_id: page.id, url: page.url, state: 'completed', result: {} });
        }
        const message = `Refreshed ${completed} pages; ${conflicts} skipped.`,
          job = {
            id: job_id,
            status: conflicts ? 'partial' : 'completed',
            total: pages.length,
            completed: results.length,
            conflicts,
            failed_pages: 0,
            results,
            message,
          };
        jobs.set(job_id, job);
        const pending = {
          project_id: 'site',
          request_id: a.request_id,
          action,
          state: 'pending',
          job_id,
          result: { ...job },
        };
        liveReceipts.set(a.request_id, { ...pending, state: job.status, result: { ...job } });
        return json(pending);
      }
      if (name === 'design_repo_files')
        return json({
          files: files.filter((f) => f.path.includes(a.query || '')),
          repo: 'https://github.com/example-owner/example-repo',
          sha: provenance(a.page_id).sha,
          provenance: provenance(a.page_id),
        });
      if (name === 'design_read_source') {
        if (a.path.endsWith('header.php') && staleGate) await staleGate;
        const content = a.path.endsWith('.css')
          ? `:root {\n  --accent: ${a.page_id === 'contact' ? '#bb99ff' : '#8ce8cd'};\n}\n.hero { color: var(--accent); }\n.hero p { max-width: 42rem; }\n`
          : `<?php\n// ${a.page_id} capture\nget_header();\n?><h1>Contact our studio</h1>\n`;
        return json({
          path: a.path,
          content,
          sha: provenance(a.page_id).sha,
          provenance: provenance(a.page_id),
        });
      }
      if (name === 'design_index') {
        const query = (a.query || '').toLowerCase();
        const found = pages.filter(
          (p) =>
            !query ||
            `${p.title} ${p.url} ${p.nodes.map((n) => n.text).join(' ')}`
              .toLowerCase()
              .includes(query),
        );
        return json({
          entries: found.map((p) => ({
            id: p.id,
            page_id: p.id,
            title: p.title,
            url: p.url,
            depth: p.id === 'contact' ? 1 : 0,
            parent_page_id: p.id === 'contact' ? 'home' : null,
            child_count: p.id === 'home' ? 1 : 0,
            discovery: { sitemap_status: p.id === 'home' ? 'listed' : 'not_listed' },
            matched_node_count: query
              ? p.nodes.filter((n) => n.text.toLowerCase().includes(query)).length
              : 0,
          })),
          total: found.length,
          next_offset: null,
          page_count: pages.length,
          sitemap_sync: { count: 1, complete: true },
        });
      }
      if (name === 'design_page_tree') {
        const p = pages.find((p) => p.id === a.page_id),
          query = (a.query || '').toLowerCase();
        const nodes = p.nodes.filter(
          (n) => !query || `${n.text} ${n.name} ${n.selector}`.toLowerCase().includes(query),
        );
        return json({
          nodes,
          total: nodes.length,
          next_offset: null,
          provenance: provenance(a.page_id),
        });
      }
      if (name === 'design_sync_sitemap')
        return json({ complete: true, captures_preserved: true, saved_page_count: pages.length });
      if (name === 'design_list_comments') return json({ comments: [] });
      return json({ error: `Unexpected tool ${name}` }, 400);
    }
    if (pathname.startsWith('/files/')) {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      const page = pages.find((p) => pathname.includes(p.id));
      res.end(
        `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="1200"><rect width="100%" height="100%" fill="#14232a"/><text x="100" y="200" font-family="Arial" font-size="64" fill="#8ce8cd">${page?.nodes[1].text || 'Alcor'}</text></svg>`,
      );
      return;
    }
    const staticFile = {
      '/': 'index.html',
      '/app.js': 'app.js',
      '/inspectors.js': 'inspectors.js',
      '/style.css': 'style.css',
    }[pathname];
    if (staticFile) {
      res.writeHead(200, {
        'Content-Type': staticFile.endsWith('.js')
          ? 'text/javascript'
          : staticFile.endsWith('.css')
            ? 'text/css'
            : 'text/html',
      });
      res.end(await fs.readFile(path.join(root, staticFile)));
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
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const tab = await context.newPage();
tab.on('pageerror', (e) => errors.push(e.message));
const checks = [];
async function check(name, fn) {
  console.log(`Checking ${name}`);
  await fn();
  checks.push(name);
}
try {
  await tab.goto(url);
  await tab.locator('#pageImage').waitFor({ state: 'visible' });
  await check('Stylesheet prefers main theme over plugin and external CSS', async () => {
    await tab.locator('#stylesheetPanelTab').click();
    await tab.waitForFunction(() =>
      document.querySelector('#stylesheetCode').textContent.includes('--accent'),
    );
    assert.match(await tab.locator('#stylesheetCode').textContent(), /#8ce8cd/);
    assert.match(await tab.locator('#stylesheetMeta').textContent(), /a11111111111/);
    const last = calls.findLast((c) => c.name === 'design_read_source');
    assert.equal(last.args.project_id, 'site');
    assert.equal(last.args.page_id, 'home');
    assert.equal(last.args.path, cssPath);
  });
  await check('CSS source search highlights and cycles matching lines', async () => {
    await tab.locator('#stylesheetFind').fill('.hero');
    assert.equal(await tab.locator('#stylesheetMatches').textContent(), '1/2');
    await tab.locator('#stylesheetNext').click();
    assert.equal(await tab.locator('#stylesheetMatches').textContent(), '2/2');
    assert.equal(await tab.locator('#stylesheetCode mark').count(), 2);
    await tab.locator('#wrapStylesheet').uncheck();
    assert.equal(
      await tab.locator('#stylesheetCode').evaluate((e) => e.classList.contains('wrap')),
      false,
    );
  });
  await check('Inline and external CSS are distinguished honestly', async () => {
    await tab.locator('#stylesheetSelect').selectOption('inline-0');
    await tab.waitForFunction(() =>
      document.querySelector('#stylesheetCode').textContent.includes('inline-badge'),
    );
    await tab.locator('#stylesheetSelect').selectOption('linked-0');
    await tab.waitForFunction(() =>
      document.querySelector('#stylesheetCode').textContent.includes('not present'),
    );
    assert.equal(
      await tab.locator('#stylesheetNotice a').getAttribute('href'),
      'https://fonts.googleapis.com/css2?family=Example',
    );
    await tab.locator('#stylesheetSelect').selectOption('linked-2');
    await tab.waitForFunction(() =>
      document.querySelector('#stylesheetCode').textContent.includes('--accent'),
    );
  });
  await check('Files tab filters PHP and reads current branch source', async () => {
    await tab.locator('#filesPanelTab').click();
    await tab.locator('#filesSearch').fill('page-contact.php');
    await tab.waitForFunction(
      () =>
        document.querySelectorAll('.repo-file-row').length === 1 &&
        document.querySelector('.repo-file-row').textContent.includes('page-contact.php'),
    );
    await tab.locator('.repo-file-row').click();
    await tab.waitForFunction(() =>
      document.querySelector('#filesCode').textContent.includes('get_header'),
    );
    assert.match(await tab.locator('#filesProvenance').textContent(), /c33333333333/);
    await tab.locator('#filesFind').fill('get_header');
    assert.equal(await tab.locator('#filesMatches').textContent(), '1/1');
  });
  await check('Conflicting files are flagged while saved drafts remain recoverable', async () => {
    await tab.locator('#filesSearch').fill('page-conflict.php');
    await tab.locator('.repo-file-row').click();
    assert.match(await tab.locator('#filesCode').textContent(), /Resolve the branch conflict/);
    assert.equal(await tab.locator('#filesEdit').isDisabled(), true);
    savedDrafts.set(conflictPath, {
      content: '<?php // Preserved draft\n',
      version: 'draft:preserved',
    });
    await tab.locator('#refreshFiles').click();
    await tab.locator('.repo-file-row').click();
    await tab.waitForFunction(() =>
      document.querySelector('#filesCode').textContent.includes('Preserved draft'),
    );
    assert.equal(await tab.locator('#filesEdit').isEnabled(), true);
    savedDrafts.delete(conflictPath);
    await tab.locator('#refreshFiles').click();
    await tab.locator('#filesSearch').fill('page-contact.php');
    await tab.locator('.repo-file-row').click();
  });
  await check('Changing selected page refreshes CSS provenance and bytes', async () => {
    await tab.locator('#stylesheetPanelTab').click();
    await tab.locator('.page-item[data-page-id="contact"]').click();
    await tab.waitForFunction(() =>
      document.querySelector('#stylesheetCode').textContent.includes('#bb99ff'),
    );
    assert.match(await tab.locator('#stylesheetMeta').textContent(), /b22222222222/);
    assert.ok(calls.some((c) => c.name === 'design_read_source' && c.args.page_id === 'contact'));
  });
  await check('Switching page clears old file contents', async () => {
    await tab.locator('#filesPanelTab').click();
    await tab.waitForFunction(() =>
      document.querySelector('#filesCode').textContent.includes('Select a file'),
    );
    assert.doesNotMatch(
      await tab.locator('#filesCode').textContent(),
      /current integration branch/,
    );
    await tab.locator('.repo-file-row').click();
    await tab.waitForFunction(() =>
      document.querySelector('#filesCode').textContent.includes('current integration branch'),
    );
  });
  await check('Project tree searches layer content across pages', async () => {
    await tab.locator('#treeTab').click();
    await tab.locator('.tree-page-row').first().waitFor();
    await tab.locator('#navSearch').fill('Email');
    await tab.waitForFunction(
      () =>
        document.querySelectorAll('.tree-page-row').length === 1 &&
        document.querySelector('.tree-page-row').dataset.pageId === 'contact',
    );
    await tab.locator('.tree-page-row').click();
    await tab.locator('.tree-node-row').waitFor();
    await tab.locator('.tree-node-row').click();
    assert.equal(await tab.locator('#propText').inputValue(), 'Email us about your next project.');
    assert.equal(await tab.locator('#designPanelTab').getAttribute('aria-selected'), 'true');
    assert.equal(await tab.locator('#selectionBox').isVisible(), true);
  });
  await check('Sitemap refresh preserves captures and shows membership', async () => {
    const before = pages.map((p) => ({ id: p.id, revision: p.revision, screenshot: p.screenshot }));
    await tab.locator('#refreshSitemap').click();
    await tab.waitForFunction(() => !document.querySelector('#refreshSitemap').disabled);
    assert.deepEqual(
      pages.map((p) => ({ id: p.id, revision: p.revision, screenshot: p.screenshot })),
      before,
    );
    assert.match(
      await tab.locator('.tree-sitemap-status').textContent(),
      /1 sitemap URLs · 2 captures/,
    );
    assert.equal(calls.filter((c) => c.name === 'design_sync_sitemap').length, 1);
    assert.match(await tab.locator('.tree-sitemap-badge').getAttribute('title'), /Not listed/);
  });
  await check('Design and Comments remain accessible', async () => {
    await tab.locator('#commentsPanelTab').click();
    assert.equal(await tab.locator('#commentsPanel').isVisible(), true);
    assert.equal(await tab.locator('#propertyForm').isVisible(), false);
    await tab.locator('#designPanelTab').click();
    assert.equal(await tab.locator('#propertyForm').isVisible(), true);
  });
  await check('Source tabs fit desktop and compact editor', async () => {
    for (const width of [1440, 1100]) {
      await tab.setViewportSize({ width, height: 1000 });
      await tab.locator('#stylesheetPanelTab').click();
      await tab.waitForFunction(() =>
        document.querySelector('#stylesheetCode').textContent.includes('#bb99ff'),
      );
      await tab.screenshot({ path: path.join(output, `stylesheets-${width}.png`) });
      assert.equal(
        await tab.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      assert.equal(
        await tab.locator('.canvas-toolbar').evaluate((e) => e.scrollWidth > e.clientWidth),
        false,
        `toolbar ${width}`,
      );
      await tab.locator('#filesPanelTab').click();
      await tab.screenshot({ path: path.join(output, `files-${width}.png`) });
      assert.equal(
        await tab.locator('.property-tabs').evaluate((e) => e.scrollWidth > e.clientWidth),
        false,
        `tabs ${width}`,
      );
    }
  });
  assert.deepEqual(errors, []);
  checks.push('No JavaScript errors');
  assert.equal(
    calls.some((c) =>
      /design_(update|insert|remove|import|render|add|reply|resolve|delete)/.test(c.name),
    ),
    false,
  );
  checks.push('Source reads plus metadata-only sitemap refresh');
  await check('Editing opens current branch source, not historical canvas source', async () => {
    await tab.locator('#pagesTab').click();
    await tab.locator('.page-item[data-page-id="home"]').click();
    await tab.locator('#stylesheetPanelTab').click();
    await tab.waitForFunction(() =>
      document.querySelector('#stylesheetCode').textContent.includes('#8ce8cd'),
    );
    await tab.locator('#stylesheetEdit').click();
    await tab.waitForFunction(() => !document.querySelector('#stylesheetEditor').hidden);
    assert.match(await tab.locator('#stylesheetEditor').inputValue(), /#ffbbcc/);
    assert.match(
      await tab.locator('#stylesheetEditStatus').textContent(),
      /review-base.*c33333333333.*captured revision/,
    );
    for (const width of [1100, 1440]) {
      await tab.setViewportSize({ width, height: 1000 });
      await tab.screenshot({ path: path.join(output, `source-editor-${width}.png`) });
      assert.equal(
        await tab.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      assert.equal(
        await tab
          .locator('#stylesheetPanel .source-edit-bar')
          .evaluate((e) => e.scrollWidth > e.clientWidth),
        false,
      );
    }
    await tab.locator('#stylesheetEditor').fill(':root { color: #123456; }\n');
    assert.equal(await tab.locator('#stylesheetSave').isEnabled(), true);
    assert.equal(await tab.locator('#stylesheetSync').isDisabled(), true);
  });
  await check('Find searches edited source rather than the captured viewer', async () => {
    await tab.locator('#stylesheetFind').fill('#123456');
    assert.equal(await tab.locator('#stylesheetMatches').textContent(), '1/1');
    await tab.locator('#stylesheetNext').click();
    assert.equal(
      await tab
        .locator('#stylesheetEditor')
        .evaluate((e) => e.value.slice(e.selectionStart, e.selectionEnd)),
      '#123456',
    );
  });
  await check('Branch divergence is visible while editing', async () => {
    assert.match(
      await tab.locator('#stylesheetEditStatus').textContent(),
      /promotion may need conflict resolution/,
    );
  });
  await check(
    'Other windows and earlier sessions retain independent recoverable copies',
    async () => {
      const second = await context.newPage();
      await second.goto(url);
      await second.locator('#pageImage').waitFor({ state: 'visible' });
      await second.locator('#stylesheetPanelTab').click();
      await second.locator('#stylesheetRecovery').waitFor({ state: 'visible' });
      await second.locator('#stylesheetRecovery summary').click();
      await second.locator('#stylesheetRecoveryList button').first().click();
      await second.locator('#stylesheetEdit').click();
      await second.waitForFunction(() => !document.querySelector('#stylesheetEditor').hidden);
      assert.match(await second.locator('#stylesheetEditor').inputValue(), /#123456/);
      await second.locator('#stylesheetEditor').fill(':root { color: #abcdef; }\n');
      const secondSlot = await second.evaluate(() =>
        sessionStorage.getItem('alcordesign-source-window'),
      );
      assert.match(await tab.locator('#stylesheetEditor').inputValue(), /#123456/);
      await second.close();
      const third = await context.newPage();
      await third.goto(url);
      await third.locator('#pageImage').waitFor({ state: 'visible' });
      await third.locator('#stylesheetPanelTab').click();
      await third.locator('#stylesheetRecovery').waitFor({ state: 'visible' });
      await third.locator('#stylesheetRecovery summary').click();
      await third.locator(`#stylesheetRecoveryList button[data-slot="${secondSlot}"]`).click();
      await third.locator('#stylesheetEdit').click();
      await third.waitForFunction(() => !document.querySelector('#stylesheetEditor').hidden);
      assert.match(await third.locator('#stylesheetEditor').inputValue(), /#abcdef/);
      const thirdSlot = await third.evaluate(() =>
        sessionStorage.getItem('alcordesign-source-window'),
      );
      assert.notEqual(secondSlot, thirdSlot);
      assert.equal(
        await third.evaluate(
          (slot) =>
            Object.keys(localStorage).some((k) =>
              k.startsWith('alcordesign-source-draft:site:' + slot + ':'),
            ),
          secondSlot,
        ),
        true,
      );
      await third.close();
      await tab.evaluate(
        (slots) => {
          for (const key of Object.keys(localStorage))
            if (slots.some((slot) => key.startsWith('alcordesign-source-draft:site:' + slot + ':')))
              localStorage.removeItem(key);
        },
        [secondSlot, thirdSlot],
      );
    },
  );
  await check('Unsaved source survives file and page changes and reload', async () => {
    await tab.locator('#filesPanelTab').click();
    await tab.locator('#filesSearch').fill('page-contact.php');
    await tab.locator('.repo-file-row').click();
    await tab.locator('.page-item[data-page-id="contact"]').click();
    await tab.locator('#stylesheetPanelTab').click();
    await tab.waitForFunction(() =>
      document.querySelector('#stylesheetCode').textContent.includes('#bb99ff'),
    );
    await tab.locator('#stylesheetEdit').click();
    await tab.waitForFunction(() => !document.querySelector('#stylesheetEditor').hidden);
    assert.match(await tab.locator('#stylesheetEditor').inputValue(), /#123456/);
    tab.once('dialog', (dialog) => dialog.accept());
    await tab.reload();
    await tab.locator('#pageImage').waitFor({ state: 'visible' });
    await tab.locator('#stylesheetPanelTab').click();
    await tab.waitForFunction(
      () =>
        document.querySelector('#stylesheetEdit') &&
        !document.querySelector('#stylesheetEdit').disabled,
    );
    await tab.locator('#stylesheetEdit').click();
    await tab.waitForFunction(() => !document.querySelector('#stylesheetEditor').hidden);
    assert.match(await tab.locator('#stylesheetEditor').inputValue(), /#123456/);
  });
  await check('Save draft and explicit sync show review branch', async () => {
    await tab.locator('#stylesheetSave').click();
    await tab.waitForFunction(
      () =>
        document.querySelector('#stylesheetSync') &&
        !document.querySelector('#stylesheetSync').disabled,
    );
    const save = calls.findLast((c) => c.name === 'design_save_source');
    assert.equal(save.args.expected_version, 'blob:current');
    assert.match(save.args.content, /#123456/);
    assert.equal(syncCalls, 0);
    await tab.locator('#stylesheetSync').click();
    await tab.waitForFunction(() =>
      document.querySelector('#stylesheetEditStatus').textContent.includes('Integrate the branch'),
    );
    assert.equal(syncCalls, 1);
    assert.match(await tab.locator('#stylesheetEditStatus').textContent(), /alcordesign\/site/);
    assert.equal(
      await tab.locator('#stylesheetEditStatus a').getAttribute('href'),
      `https://github.com/example-owner/example-repo/compare/${baseBranch}...${branch}`,
    );
  });
  await check('Lost save responses reuse one ID and reconcile the saved draft', async () => {
    await tab.locator('#stylesheetEditor').fill(':root { color: #654321; }\n');
    const start = calls.length,
      beforeEffects = saveEffects;
    saveMode = 'transport';
    statusOffline = true;
    await tab.locator('#stylesheetSave').click();
    await tab.waitForFunction(() => {
      const button = document.querySelector('#stylesheetCheckSave');
      return !button.hidden && !button.disabled;
    });
    assert.equal(await tab.locator('#stylesheetEditor').getAttribute('readonly'), '');
    const attempts = calls.slice(start).filter((c) => c.name === 'design_save_source');
    assert.ok(attempts.length >= 2, 'Chromium should retry a dropped connection in this fixture');
    assert.equal(new Set(attempts.map((c) => c.args.request_id)).size, 1);
    assert.equal(saveEffects, beforeEffects + 1);
    assert.equal(attempts[0].args.expected_version, 'blob:synced');
    assert.match(attempts[0].args.content, /#654321/);
    statusOffline = false;
    saveMode = 'success';
    await tab.locator('#stylesheetCheckSave').click();
    await tab.waitForFunction(() => document.querySelector('#stylesheetCheckSave').hidden);
    assert.equal(
      calls.slice(start).filter((c) => c.name === 'design_save_source').length,
      attempts.length,
    );
    assert.equal(await tab.locator('#stylesheetSync').isEnabled(), true);
  });
  await check('New branch PHP file is editable and preserves CRLF', async () => {
    await tab.locator('#filesPanelTab').click();
    await tab.locator('#filesSearch').fill('page-new.php');
    await tab.waitForFunction(() => document.querySelectorAll('.repo-file-row').length === 1);
    await tab.locator('.repo-file-row').click();
    await tab.waitForFunction(() =>
      document.querySelector('#filesCode').textContent.includes('current integration branch'),
    );
    await tab.locator('#filesEdit').click();
    await tab.waitForFunction(() => !document.querySelector('#filesEditor').hidden);
    const php = await tab.locator('#filesEditor').inputValue();
    await tab.locator('#filesEditor').fill(php + '// Edit\n');
    await tab.locator('#filesSave').click();
    await tab.waitForFunction(
      () => document.querySelector('#filesSync') && !document.querySelector('#filesSync').disabled,
    );
    const save = calls.findLast((c) => c.name === 'design_save_source');
    assert.equal(save.args.path, 'site/wp-content/themes/example-theme/page-new.php');
    assert.ok(save.args.content.includes('\r\n'));
    assert.equal(save.args.content.replaceAll('\r\n', '').includes('\n'), false);
  });
  await check('Mixed newline source keeps original separators on a text edit', async () => {
    await tab.locator('#filesSearch').fill('page-mixed.php');
    await tab.locator('.repo-file-row').click();
    await tab.locator('#filesEdit').click();
    await tab.waitForFunction(() => !document.querySelector('#filesEditor').hidden);
    const value = await tab.locator('#filesEditor').inputValue();
    await tab.locator('#filesEditor').fill(value.replace('current', 'updated'));
    await tab.locator('#filesSave').click();
    await tab.waitForFunction(
      () => document.querySelector('#filesSync') && !document.querySelector('#filesSync').disabled,
    );
    const save = calls.findLast((c) => c.name === 'design_save_source');
    assert.deepEqual(save.args.content.match(/\r\n|\r|\n/g), ['\r\n', '\n', '\r', '\n']);
  });
  await check('A lost sync response reuses one ID and status failure stays uncertain', async () => {
    syncMode = 'transport';
    statusOffline = true;
    const start = calls.length,
      beforeEffects = syncEffects;
    await tab.locator('#filesSync').click();
    await tab.waitForFunction(() => {
      const button = document.querySelector('#filesCheck');
      return !button.hidden && !button.disabled;
    });
    assert.match(await tab.locator('#filesEditStatus').textContent(), /unknown/i);
    assert.equal(await tab.locator('#filesSync').isDisabled(), true);
    const attempts = calls.slice(start).filter((c) => c.name === 'design_sync_sources');
    assert.ok(attempts.length >= 2, 'Chromium should retry a dropped connection in this fixture');
    assert.equal(new Set(attempts.map((c) => c.args.request_id)).size, 1);
    assert.equal(syncEffects, beforeEffects + 1);
    const requestId = attempts[0].args.request_id;
    statusOffline = false;
    await tab.locator('#filesCheck').click();
    await tab.waitForFunction(() =>
      document.querySelector('#filesEditStatus').textContent.includes('still pending'),
    );
    assert.equal(await tab.locator('#filesSync').isDisabled(), true);
    assert.equal(
      calls.slice(start).filter((c) => c.name === 'design_sync_sources').length,
      attempts.length,
    );
    operations.set(requestId, {
      type: 'sync',
      state: 'completed',
      result: {
        pushed: false,
        uncertain: false,
        request_id: requestId,
        message: 'The previous push was not accepted',
      },
    });
    pendingSync = null;
    await tab.locator('#filesCheck').click();
    await tab.waitForFunction(() => document.querySelector('#filesCheck').hidden);
    assert.equal(await tab.locator('#filesSync').isEnabled(), true);
  });
  await check('Conflict and uncertain delivery preserve draft without replay', async () => {
    syncMode = 'conflict';
    await tab.locator('#filesSync').click();
    await tab.waitForFunction(() =>
      document.querySelector('#filesEditStatus').textContent.includes('repository changed'),
    );
    assert.equal(savedDrafts.size, 3);
    syncMode = 'uncertain';
    const start = calls.length;
    await tab.locator('#filesSync').click();
    await tab.waitForFunction(() => {
      const button = document.querySelector('#filesCheck');
      return !button.hidden && !button.disabled;
    });
    const attempt = calls.slice(start).find((c) => c.name === 'design_sync_sources');
    assert.equal(await tab.locator('#filesSync').isDisabled(), true);
    operations.set(attempt.args.request_id, {
      type: 'sync',
      state: 'completed',
      result: {
        pushed: false,
        uncertain: false,
        request_id: attempt.args.request_id,
        message: 'The previous push was not accepted',
      },
    });
    pendingSync = null;
    await tab.locator('#filesCheck').click();
    await tab.waitForFunction(() => document.querySelector('#filesCheck').hidden);
    assert.equal(calls.slice(start).filter((c) => c.name === 'design_sync_sources').length, 1);
    assert.equal(await tab.locator('#filesSync').isEnabled(), true);
    syncMode = 'success';
    await tab.locator('#filesSync').click();
    await tab.waitForFunction(() =>
      document.querySelector('#filesEditStatus').textContent.includes('Integrate the branch'),
    );
    assert.equal(syncEffects, 5);
  });
  await check('Concurrent source change retains the unsaved edit', async () => {
    await tab.locator('#filesSearch').fill('page-new.php');
    await tab.locator('.repo-file-row').click();
    await tab.locator('#filesEdit').click();
    await tab.waitForFunction(() => !document.querySelector('#filesEditor').hidden);
    await tab.locator('#filesEditor').fill('<?php\n// My unsaved work\n');
    await tab.locator('#stylesheetPanelTab').click();
    savedDrafts.set('site/wp-content/themes/example-theme/page-new.php', {
      content: '<?php // Another edit\n',
      version: 'draft:other',
    });
    await tab.locator('#filesPanelTab').click();
    await tab.locator('#filesSearch').fill('page-contact.php');
    await tab.locator('.repo-file-row').click();
    await tab.locator('#filesSearch').fill('page-new.php');
    await tab.locator('.repo-file-row').click();
    await tab.locator('#filesEdit').click();
    await tab.waitForFunction(() => !document.querySelector('#filesEditor').hidden);
    assert.match(await tab.locator('#filesEditor').inputValue(), /My unsaved work/);
    assert.match(
      await tab.locator('#filesEditStatus').textContent(),
      /changed since your unsaved edit/,
    );
    assert.equal(await tab.locator('#filesSave').isDisabled(), true);
    tab.once('dialog', (dialog) => dialog.accept());
    await tab.locator('#filesDiscard').click();
    assert.equal(await tab.locator('#filesEditor').isHidden(), true);
  });
  await check(
    'Definitive save version conflict preserves editable text and exits pending state',
    async () => {
      await tab.locator('#filesEdit').click();
      await tab.waitForFunction(() => !document.querySelector('#filesEditor').hidden);
      await tab.locator('#filesEditor').fill('<?php\n// Save conflict recovery\n');
      savedDrafts.set('site/wp-content/themes/example-theme/page-new.php', {
        content: '<?php // Different saved version\n',
        version: 'draft:other-2',
      });
      await tab.locator('#filesSave').click();
      await tab.waitForFunction(() =>
        document
          .querySelector('#filesEditStatus')
          .textContent.includes('Source changed since it was opened'),
      );
      assert.match(await tab.locator('#filesEditor').inputValue(), /Save conflict recovery/);
      assert.equal(await tab.locator('#filesCheckSave').isHidden(), true);
      assert.equal(await tab.locator('#filesDiscard').isEnabled(), true);
      tab.once('dialog', (dialog) => dialog.accept());
      await tab.locator('#filesDiscard').click();
    },
  );
  await check(
    'A delayed original and same-ID retry are fenced across windows in either order',
    async () => {
      for (const order of ['original-first', 'retry-first']) {
        if (!savedDrafts.size)
          savedDrafts.set('site/wp-content/themes/example-theme/page-new.php', {
            content: '<?php // Waiting draft\n',
            version: `draft:${order}`,
          });
        await tab.reload();
        await tab.locator('#pageImage').waitFor({ state: 'visible' });
        await tab.locator('#filesPanelTab').click();
        await tab.waitForFunction(() => !document.querySelector('#filesSync').disabled);
        const start = calls.length,
          before = syncEffects;
        syncMode = 'delayed';
        await tab.locator('#filesSync').click();
        await tab.waitForFunction(() => {
          const button = document.querySelector('#filesRetrySync');
          return !button.hidden && !button.disabled;
        });
        const attempts = calls.slice(start).filter((c) => c.name === 'design_sync_sources');
        assert.ok(attempts.length >= 2);
        assert.equal(new Set(attempts.map((c) => JSON.stringify(c.args))).size, 1);
        assert.equal(syncEffects, before);
        assert.equal(await tab.locator('#filesSync').isDisabled(), true);
        const second = await context.newPage();
        await second.goto(url);
        await second.locator('#pageImage').waitFor({ state: 'visible' });
        await second.locator('#filesPanelTab').click();
        await second.waitForFunction(() => {
          const button = document.querySelector('#filesRetrySync');
          return !button.hidden && !button.disabled;
        });
        assert.equal(await second.locator('#filesSync').isDisabled(), true);
        syncMode = 'success';
        const deliverOriginal = async () =>
          tab.evaluate(async (args) => {
            const response = await fetch('/api/tools', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: 'design_sync_sources', arguments: args }),
            });
            return response.json();
          }, attempts[0].args);
        if (order === 'original-first') await deliverOriginal();
        await second.locator('#filesRetrySync').click();
        await second.waitForFunction(() =>
          document.querySelector('#filesEditStatus').textContent.includes('Integrate the branch'),
        );
        if (order === 'retry-first') await deliverOriginal();
        assert.equal(syncEffects, before + 1);
        assert.ok(
          calls
            .slice(start)
            .filter((c) => c.name === 'design_sync_sources')
            .every((c) => JSON.stringify(c.args) === JSON.stringify(attempts[0].args)),
        );
        await second.close();
      }
    },
  );
  await check('A delayed sync cannot include drafts saved after the original click', async () => {
    savedDrafts.set('site/wp-content/themes/example-theme/page-new.php', {
      content: '<?php // First draft\n',
      version: 'draft:first',
    });
    await tab.reload();
    await tab.locator('#pageImage').waitFor({ state: 'visible' });
    await tab.locator('#filesPanelTab').click();
    await tab.waitForFunction(() => !document.querySelector('#filesSync').disabled);
    const start = calls.length,
      before = syncEffects;
    syncMode = 'delayed';
    await tab.locator('#filesSync').click();
    await tab.waitForFunction(() => {
      const button = document.querySelector('#filesRetrySync');
      return !button.hidden && !button.disabled;
    });
    const original = calls.slice(start).find((c) => c.name === 'design_sync_sources').args;
    savedDrafts.set(cssPath, { content: ':root { color: red; }\n', version: 'draft:later' });
    syncMode = 'success';
    const rejected = await tab.evaluate(async (args) => {
      const response = await fetch('/api/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'design_sync_sources', arguments: args }),
      });
      return response.json();
    }, original);
    assert.equal(rejected.pushed, false);
    assert.equal(syncEffects, before);
    assert.equal(savedDrafts.size, 2);
    await tab.locator('#filesCheck').click();
    await tab.waitForFunction(() =>
      document.querySelector('#filesEditStatus').textContent.includes('Draft set changed'),
    );
    assert.equal(savedDrafts.size, 2);
  });
  await check(
    'Live page refresh blocks unsent comments and offers a backup on conflict',
    async () => {
      await tab.reload();
      await tab.locator('#pageImage').waitFor({ state: 'visible' });
      await tab.locator('#liveRefresh > summary').click();
      const start = calls.length,
        before = liveEffects;
      await tab.evaluate(() => {
        document.querySelector('#newCommentBody').value = 'Unposted comment';
      });
      await tab.locator('#liveRefreshPage').click();
      assert.match(
        await tab.locator('#liveRefreshStatus').textContent(),
        /Finish your current design edit or comment/,
      );
      assert.equal(
        calls.slice(start).filter((c) => c.name === 'design_refresh_live_page').length,
        0,
      );
      await tab.evaluate(() => {
        document.querySelector('#newCommentBody').value = '';
      });
      pages[0].comments = [
        {
          id: 'c1',
          x: 100,
          y: 140,
          body: 'Keep this comment',
          author: 'Owner',
          created: 1,
          resolved: false,
          replies: [],
        },
      ];
      await tab.locator('#liveRefreshPage').click();
      await tab.waitForFunction(() => !document.querySelector('#liveRefreshBackupPage').hidden);
      assert.equal(liveEffects, before);
      assert.match(await tab.locator('#liveRefreshStatus').textContent(), /Create a backup/);
      const backupStart = calls.length;
      liveMode = 'transport';
      liveStatusOffline = true;
      await tab.locator('#liveRefreshBackupPage').click();
      await tab.waitForFunction(() => {
        const button = document.querySelector('#liveRefreshCheck');
        return !button.hidden && !button.disabled;
      });
      const attempts = calls
        .slice(backupStart)
        .filter((c) => c.name === 'design_refresh_live_page');
      assert.ok(attempts.length >= 2);
      assert.equal(new Set(attempts.map((c) => JSON.stringify(c.args))).size, 1);
      assert.equal(liveEffects, before + 1);
      await tab.locator('#liveRefreshCheck').click();
      await tab.waitForFunction(
        () =>
          !document.querySelector('#liveRefreshCheck').disabled &&
          document
            .querySelector('#liveRefreshStatus')
            .textContent.includes('Refresh status unavailable'),
      );
      assert.equal(await tab.locator('#liveRefreshPage').isDisabled(), true);
      liveStatusOffline = false;
      liveMode = 'success';
      await tab.locator('#liveRefreshCheck').click();
      await tab.waitForFunction(() =>
        document.querySelector('#liveRefreshStatus').textContent.includes('Page refreshed'),
      );
      assert.equal(
        calls.slice(backupStart).filter((c) => c.name === 'design_refresh_live_page').length,
        attempts.length,
      );
      assert.equal(pages[0].comments[0].body, 'Keep this comment');
      assert.ok(snapshots.size >= 1);
      assert.match(await tab.locator('#liveRefreshStatus').textContent(), /pins may have shifted/i);
    },
  );
  await check('Page backup restores design and retains current comment threads', async () => {
    pages[0].comments.push({
      id: 'c2',
      x: 400,
      y: 240,
      body: 'Added after backup',
      author: 'Owner',
      created: 2,
      resolved: false,
      replies: [],
    });
    await tab.locator('#liveRefreshSnapshots').click();
    await tab.locator('#liveSnapshotList button').first().click();
    await tab.waitForFunction(() =>
      document.querySelector('#liveRefreshStatus').textContent.includes('Page backup restored'),
    );
    assert.deepEqual(
      pages[0].comments.map((c) => c.id),
      ['c1', 'c2'],
    );
    assert.match(pages[0].nodes[1].text, /Websites for small businesses/);
  });
  await check('Refresh safe pages skips unverified pages; backup-all is explicit', async () => {
    const before = liveEffects,
      beforeSnapshots = snapshots.size;
    await tab.locator('#liveRefreshSafeAll').click();
    await tab.waitForFunction(
      () => document.querySelector('#liveRefreshStatus').textContent.includes('2 skipped'),
      null,
      { timeout: 12000 },
    );
    assert.equal(liveEffects, before);
    assert.equal(snapshots.size, beforeSnapshots);
    assert.equal(await tab.locator('#liveRefreshResults').isVisible(), true);
    assert.match(
      await tab.locator('#liveRefreshResultsTitle').textContent(),
      /2 pages need attention/,
    );
    await tab.locator('#liveRefreshBackupAll').click();
    await tab.waitForFunction(
      () => document.querySelector('#liveRefreshStatus').textContent.includes('Refreshed 2 pages'),
      null,
      { timeout: 12000 },
    );
    assert.equal(liveEffects, before + 2);
    assert.equal(snapshots.size, beforeSnapshots + 2);
    assert.equal(await tab.locator('#liveRefreshResults').isHidden(), true);
    assert.deepEqual(
      pages[0].comments.map((c) => c.id),
      ['c1', 'c2'],
    );
  });
  await check('Overview image elements are released when changing views', async () => {
    await tab.locator('#overviewButton').click();
    assert.equal(await tab.locator('#pageImage').getAttribute('src'), null);
    assert.equal(await tab.locator('#overview img').count(), 2);
    await tab.locator('#overview .overview-card').first().click();
    await tab.waitForFunction(
      () =>
        !document.querySelector('#pageImage').hidden &&
        document.querySelector('#pageImage').hasAttribute('src'),
    );
    assert.equal(await tab.locator('#overview img').count(), 0);
  });
  await check('Large source is bounded but remains fully searchable and editable', async () => {
    await tab.locator('#filesPanelTab').click();
    await tab.locator('#filesSearch').fill('large-test.css');
    await tab.locator('.repo-file-row').click();
    await tab.waitForFunction(() =>
      document.querySelector('#filesCodePageLabel').textContent.includes('12000'),
    );
    assert.equal(await tab.locator('#filesCode > .source-code-line').count(), 300);
    assert.match(await tab.locator('#filesCodePageLabel').textContent(), /Lines 1–300 of 12000/);
    await tab.locator('#filesCodeNextPage').click();
    assert.match(await tab.locator('#filesCodePageLabel').textContent(), /Lines 301–600/);
    assert.equal(
      await tab.locator('#filesCode > .source-code-line').first().getAttribute('data-line'),
      '301',
    );
    await tab.locator('#filesFind').fill('distant-match-marker');
    assert.equal(await tab.locator('#filesMatches').textContent(), '1/2');
    assert.equal(await tab.locator('#filesCode .active-match').getAttribute('data-line'), '3000');
    await tab.locator('#filesNext').click();
    assert.equal(await tab.locator('#filesCode .active-match').getAttribute('data-line'), '11999');
    assert.equal(await tab.locator('#filesCode > .source-code-line').count(), 300);
    await tab.locator('#filesEdit').click();
    await tab.waitForFunction(() => !document.querySelector('#filesEditor').hidden);
    assert.equal(await tab.locator('#filesEditor').inputValue(), largeContent);
    assert.equal(await tab.locator('#filesCodePages').isHidden(), true);
  });
  assert.deepEqual(errors, []);
  const receipt = { ok: true, checks, output };
  await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
