/**
 * Captures the wp-admin screenshots in screenshots/ from a real, throw-away WordPress.
 *
 * It boots the same Playground site as run-demo.mjs (same CLI pin, same mu-plugins, same blueprint and seed
 * users), then drives one headless Chrome over the DevTools protocol: sign in through wp-login.php with the demo's
 * own sample accounts, open an admin page, and save a 1440x900 PNG. Nothing is faked: the pages are what the ten
 * mu-plugins add to wp-admin.
 *
 *   screenshots/admin-fields.png   the AlcorFields client-editing screen, signed in as the sample client editor
 *   screenshots/admin-plugins.png  Plugins > Must-Use, listing all ten plugins, signed in as the sample admin
 *
 * Run: node demo/screenshots.mjs   (Node 22+ for the built-in WebSocket; Chrome or Edge installed)
 * Optional: CHROME_PATH to point at the browser binary, ALCOR_DEMO_PORT for the WordPress port.
 * The passwords are random per run and exist only in a temp folder that is deleted at the end.
 */
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findFreePort, startPlayground } from './lib/playground.mjs';

const componentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(componentDir, 'screenshots');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hex = (n) => randomBytes(n).toString('hex');

/** @returns {string} Path of an installed Chrome or Edge. */
function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  const found = candidates.find((p) => p && fs.existsSync(p));
  if (!found) throw new Error('No Chrome or Edge found; set CHROME_PATH.');
  return found;
}

/**
 * Minimal DevTools-protocol client for one page.
 * @param {string} wsUrl - The page's webSocketDebuggerUrl.
 * @returns {Promise<{send: Function, once: Function, close: Function}>} The client.
 */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  const waiters = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      for (const w of waiters.splice(0)) w.method === msg.method ? w.resolve(msg.params) : waiters.push(w);
    }
  };
  return {
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const n = ++id;
        pending.set(n, { resolve, reject });
        ws.send(JSON.stringify({ id: n, method, params }));
      }),
    once: (method) => new Promise((resolve) => waiters.push({ method, resolve })),
    close: () => ws.close(),
  };
}

/** Navigates and waits for the load event, then a short settle for fonts and admin scripts. */
async function go(page, url) {
  const loaded = page.once('Page.loadEventFired');
  await page.send('Page.navigate', { url });
  await loaded;
  await sleep(1500);
}

/** Signs in through the real login form. */
async function login(page, base, user, password) {
  await page.send('Network.clearBrowserCookies');
  await go(page, `${base}/wp-login.php`);
  const loaded = page.once('Page.loadEventFired');
  await page.send('Runtime.evaluate', {
    expression: `document.getElementById('user_login').value=${JSON.stringify(user)};
      document.getElementById('user_pass').value=${JSON.stringify(password)};
      document.getElementById('wp-submit').click();`,
  });
  await loaded;
  await sleep(1000);
}

/** Saves the viewport as a PNG. */
async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, name), Buffer.from(data, 'base64'));
  console.log(`wrote screenshots/${name}`);
}

async function main() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alcor-wp-shots-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'alcor-wp-chrome-'));
  const config = {
    admin_password: hex(24),
    client_password: hex(24),
    s2s_key: hex(32),
    indexnow_key: hex(16),
  };
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  let site = null;
  let chrome = null;
  try {
    const port = Number(process.env.ALCOR_DEMO_PORT) || (await findFreePort());
    site = await startPlayground({ componentDir, stateDir, port, log: (l) => console.log(`[playground] ${l}`) });
    const base = site.baseUrl;

    const debugPort = await findFreePort();
    chrome = spawn(
      findBrowser(),
      [
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
        `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, '--window-size=1440,900',
        'about:blank',
      ],
      { stdio: 'ignore', windowsHide: true },
    );
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(500);
      try {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
      } catch {
        /* Chrome is still starting. */
      }
    }
    if (!target) throw new Error('Chrome did not start.');
    const page = await connect(target.webSocketDebuggerUrl);
    await page.send('Page.enable');
    await page.send('Network.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    // The client editor's screen: the one document assigned to them, opened for editing.
    await login(page, base, 'demo-client', config.client_password);
    await go(page, `${base}/wp-admin/admin.php?page=alcor-fields&document=demo-landing`);
    await shot(page, 'admin-fields.png');

    // The administrator's Must-Use Plugins list.
    await login(page, base, 'demo-admin', config.admin_password);
    await go(page, `${base}/wp-admin/plugins.php?plugin_status=mustuse`);
    await shot(page, 'admin-plugins.png');
    page.close();
  } finally {
    if (chrome) spawnSync('taskkill', ['/pid', String(chrome.pid), '/t', '/f'], { stdio: 'ignore' });
    if (site) await site.stop();
    await sleep(500);
    for (const dir of [stateDir, profile]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

main().catch((error) => {
  console.error(`Screenshots failed: ${error.message}`);
  process.exitCode = 1;
});
