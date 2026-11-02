/**
 * Unit and Chromium capture tests for the renderer worker: URL safety rules, output directory
 * confinement and real page capture. Run with `node --test renderer/`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { privateAddress, parseHttpUrl, pageUrl, outputDirectory, runWorker } from './worker.mjs';

// Private IPv4 fixtures are built at runtime so no address literal appears in source.
const v4 = (...octets) => octets.join('.');

// Mirrors the renderer's default data root when ALCORDESIGN_DATA_DIR is unset.
const dataParent = () =>
  process.env.ALCORDESIGN_DATA_DIR ||
  process.env.LOCALAPPDATA ||
  process.env.XDG_DATA_HOME ||
  path.join(os.homedir(), '.local', 'share');
test('rejects local, private, authentication and transaction URL imports', () => {
  for (const url of [
    'file:///etc/passwd',
    'http://localhost/',
    'http://127.0.0.1/',
    'http://[::ffff:7f00:1]/',
    `http://${v4(169, 254, 169, 254)}/`,
    `http://${v4(100, 64, 0, 1)}/`,
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://0.0.0.0/',
    'https://user:pass@example.com/',
    'https://example.com/wp-admin/',
    'https://example.com/checkout/',
  ])
    assert.throws(() => parseHttpUrl(url));
  assert.equal(
    parseHttpUrl('https://www.example.com/docs/#intro').href,
    'https://www.example.com/docs/',
  );
  for (const address of [
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:7f00:1',
    '127.0.0.1',
    '0.0.0.0',
    v4(192, 168, 1, 4),
    v4(172, 20, 0, 1),
    v4(100, 64, 0, 1),
    v4(10, 0, 0, 1),
  ])
    assert.equal(privateAddress(address), true);
  assert.equal(privateAddress(v4(8, 8, 8, 8)), false);
});

test('page discovery keeps same-origin pages and rejects actions/assets/search', () => {
  const base = 'https://www.example.com/';
  assert.equal(pageUrl('/docs/#intro', base), base + 'docs/');
  assert.equal(pageUrl('/gallery/index.html', base), base + 'gallery/index.html');
  for (const url of [
    '/asset.svg',
    '/asset.js',
    '/wp-json/wp/v2/pages',
    '/logout/',
    'https://evil.example/',
    '?s=anything',
  ])
    assert.equal(pageUrl(url, base), null);
});

test('private artifact output cannot target source or a parent directory', () => {
  assert.throws(() => outputDirectory(process.cwd()));
  assert.throws(() => outputDirectory('relative'));
});

test('output directory honours ALCORDESIGN_DATA_DIR and rejects paths outside it', () => {
  const saved = process.env.ALCORDESIGN_DATA_DIR;
  const root = path.join(os.tmpdir(), 'alcordesign-data-dir-test');
  try {
    process.env.ALCORDESIGN_DATA_DIR = root;
    assert.equal(outputDirectory(path.join(root, 'job-1')), path.join(root, 'job-1'));
    assert.throws(() => outputDirectory(root));
    assert.throws(() => outputDirectory(path.join(root, '..', 'elsewhere')));
    assert.throws(() => outputDirectory(path.join(os.tmpdir(), 'unrelated-output')));
  } finally {
    if (saved === undefined) delete process.env.ALCORDESIGN_DATA_DIR;
    else process.env.ALCORDESIGN_DATA_DIR = saved;
  }
});

test(
  'actual Chromium capture, layer selection, edits and snapshot sanitization',
  { timeout: 45000 },
  async () => {
    const parent = dataParent();
    const output = await mkdtemp(path.join(parent, 'AlcorDesign-renderer-test-'));
    const html = `<!doctype html><html><head><title>AlcorDesign fixture</title><style>body{margin:0;background:#10121b;color:#fff;font-family:Arial}main{width:600px;margin:40px}h1{font-size:48px;color:rgb(100,200,250)}.card{padding:24px;background:#202532;border-radius:16px}canvas{width:100px;height:30px}</style></head><body><main><h1 id="headline">Real editable heading</h1><div class="card"><p>Imported layers</p><button onclick="fetch('https://example.com/write',{method:'POST'})">Button</button><input type="password" value="synthetic-secret"><input type="hidden" name="nonce" value="synthetic-nonce"><textarea>synthetic-user-input</textarea></div><script>document.querySelector('h1').textContent='SCRIPT MUST NOT RUN'</script><iframe src="http://127.0.0.1/"></iframe></main></body></html>`;
    const original = await runWorker({
      mode: 'capture',
      html,
      width: 1200,
      height: 800,
      output_dir: output,
    });
    assert.equal(original.ok, true);
    assert.equal(original.title, 'AlcorDesign fixture');
    const heading = original.nodes.find((node) => node.attributes.id === 'headline');
    assert.ok(heading);
    assert.equal(heading.text, 'Real editable heading');
    assert.equal(heading.styles['font-size'], '48px');
    assert.equal(heading.x, 40);
    assert.match(heading.selector, /^\[data-alcor-design-id="ad-\d+"\]$/);
    assert.ok(!original.html.includes('<script'));
    assert.ok(!original.html.includes('<iframe'));
    assert.ok(!original.html.includes('onclick='));
    assert.ok(!original.html.includes('synthetic-secret'));
    assert.ok(original.html.includes('type="password"'));
    assert.ok(!original.html.includes('synthetic-nonce'));
    assert.ok(!original.html.includes('synthetic-user-input'));
    const png = await readFile(original.screenshot);
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 1200);
    const edited = await runWorker({
      mode: 'capture',
      html: original.html,
      width: 1200,
      height: 800,
      output_dir: output,
      edits: [
        {
          selector: heading.selector,
          text: 'Owner revision',
          styles: { 'font-size': '32px', color: '#ff8844' },
        },
      ],
    });
    const editedHeading = edited.nodes.find((node) => node.id === heading.id);
    assert.equal(editedHeading.text, 'Owner revision');
    assert.equal(editedHeading.styles['font-size'], '32px');
    assert.equal(editedHeading.styles.color, 'rgb(255, 136, 68)');
    assert.match(editedHeading.inline_style, /font-size: 32px !important/);
    assert.notDeepEqual(await readFile(edited.screenshot), png);
    assert.equal(edited.edits[0].applied, true);
    const mobile = await runWorker({
      mode: 'capture',
      html: edited.html,
      width: 390,
      height: 844,
      output_dir: output,
    });
    assert.equal(mobile.width, 390);
    assert.equal(mobile.nodes.find((node) => node.id === heading.id).text, 'Owner revision');
  },
);

test(
  'inserts new designed layers and removes them without executing HTML',
  { timeout: 30000 },
  async () => {
    const parent = dataParent();
    const output = await mkdtemp(path.join(parent, 'AlcorDesign-renderer-insert-'));
    const inserted = await runWorker({
      mode: 'capture',
      html: '<main id="board"><h1>Original</h1></main>',
      output_dir: output,
      edits: [
        {
          action: 'insert',
          selector: '#board',
          tag: 'p',
          text: '<script>Untrusted remains text</script>',
          styles: {
            background: '#8844ff',
            color: '#ffffff',
            translate: '20px 10px',
            'z-index': '5',
          },
        },
      ],
    });
    const layer = inserted.nodes.find((node) => node.tag === 'p');
    assert.equal(layer.text, '<script>Untrusted remains text</script>');
    assert.match(inserted.html, /&lt;script&gt;Untrusted remains text&lt;\/script&gt;/);
    assert.match(layer.inline_style, /translate: 20px 10px !important/);
    const removed = await runWorker({
      mode: 'capture',
      html: inserted.html,
      output_dir: output,
      edits: [{ action: 'remove', selector: layer.selector }],
    });
    assert.ok(!removed.nodes.some((node) => node.id === layer.id));
    assert.equal(removed.nodes.find((node) => node.tag === 'h1').text, 'Original');
  },
);

test('edits reject scriptable style values and missing selectors', { timeout: 30000 }, async () => {
  const parent = dataParent();
  const output = await mkdtemp(path.join(parent, 'AlcorDesign-renderer-reject-'));
  await assert.rejects(
    runWorker({
      mode: 'capture',
      html: '<h1>Hello</h1>',
      output_dir: output,
      edits: [{ selector: 'h1', styles: { color: 'url(http://127.0.0.1/)' } }],
    }),
    /Unsupported CSS value/,
  );
  await assert.rejects(
    runWorker({
      mode: 'capture',
      html: '<h1>Hello</h1>',
      output_dir: output,
      edits: [{ selector: '#missing', text: 'No' }],
    }),
    /not found/,
  );
});

test(
  'full-page PNG dimensions match tall document metadata and explicit height cap',
  { timeout: 45000 },
  async () => {
    const parent = dataParent();
    const output = await mkdtemp(path.join(parent, 'AlcorDesign-renderer-tall-'));
    for (const documentHeight of [3600, 25000]) {
      const html = `<!doctype html><html><head><style>html,body{margin:0}main{height:${documentHeight}px;background:linear-gradient(#ff0000,#0000ff);position:relative}footer{position:absolute;bottom:0;height:100px;color:white;background:#123456;width:100%}</style></head><body><main><h1 style="margin:0">Tall page</h1><footer>Actual bottom content</footer></main></body></html>`;
      const result = await runWorker({
        mode: 'capture',
        html,
        output_dir: output,
        width: 1200,
        height: 800,
      });
      const png = await readFile(result.screenshot);
      assert.equal(result.document_height, documentHeight);
      assert.equal(result.height, Math.min(documentHeight, 24000));
      assert.equal(png.readUInt32BE(16), result.width);
      assert.equal(
        png.readUInt32BE(20),
        result.height,
        'PNG height must include actual document beyond the viewport',
      );
      if (documentHeight > 24000)
        assert.ok(result.warnings.some((w) => w.includes('first 24000px')));
      else
        assert.ok(
          result.nodes.some((node) => node.tag === 'footer' && node.y === documentHeight - 100),
        );
    }
  },
);
