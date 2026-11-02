/**
 * Starts and stops a throw-away WordPress with the WordPress Playground CLI.
 *
 * Playground runs WordPress on PHP compiled to WebAssembly with SQLite as the database, so there is nothing to
 * install besides Node. The script mounts this repository's mu-plugins folder into a fresh site, applies
 * demo/blueprint.json, and waits for the seed script to write ready.json. The CLI version is pinned: an unpinned
 * `npx` would run whatever was published last.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/** Playground CLI release this demo was written against (published 2026-08-17). */
export const PLAYGROUND_CLI_VERSION = '3.1.50';
/** WordPress release the demo boots. */
export const WORDPRESS_VERSION = '7.1';
/** PHP release the demo boots. */
export const PHP_VERSION = '8.4';

/** First start downloads the CLI, WordPress and the PHP runtime, so allow a generous wait. */
const READY_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Pauses.
 * @param {number} ms - Milliseconds to wait.
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Asks the operating system for an unused loopback port.
 * @returns {Promise<number>} A port number that was free a moment ago.
 */
export function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {net.AddressInfo} */ (probe.address());
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Quotes one argument for the platform's shell.
 * @param {string} arg - Argument.
 * @returns {string} Argument that the shell passes through unchanged.
 */
function quote(arg) {
  if (process.platform === 'win32') {
    return /[\s"&|<>^%]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
  }
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Stops a process and everything it started (npx starts node, which starts the workers).
 * @param {import('node:child_process').ChildProcess} child - The process to stop.
 */
function killTree(child) {
  if (child.pid === undefined || child.exitCode !== null) {
    return;
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

/**
 * Boots the site.
 * @param {object} options - Launch options.
 * @param {string} options.componentDir - Absolute path of the AlcorWordPress folder.
 * @param {string} options.stateDir - Empty directory, private to this run, that holds config.json and ready.json.
 * @param {number} options.port - Loopback port to serve on.
 * @param {(line: string) => void} options.log - Receives progress lines.
 * @returns {Promise<{ baseUrl: string, ready: Record<string, any>, stop: () => Promise<void>, logTail: () => string }>}
 *   The running site; call stop() when done.
 */
export async function startPlayground({ componentDir, stateDir, port, log }) {
  const demoDir = path.join(componentDir, 'demo');
  const baseUrl = `http://127.0.0.1:${port}`;
  // Mount directories with the two-argument forms: the single-argument form splits on ":" and so cannot take a
  // Windows path such as C:\work\mu-plugins.
  const args = [
    '--yes',
    `@wp-playground/cli@${PLAYGROUND_CLI_VERSION}`,
    'server',
    `--wp=${WORDPRESS_VERSION}`,
    `--php=${PHP_VERSION}`,
    `--port=${port}`,
    '--workers=1',
    // Debug verbosity puts PHP errors in the log; the script prints its tail when a check fails.
    '--verbosity=debug',
    `--blueprint=${path.join(demoDir, 'blueprint.json')}`,
    '--mount-dir-before-install',
    path.join(componentDir, 'mu-plugins'),
    '/wordpress/wp-content/mu-plugins',
    '--mount-dir-before-install',
    stateDir,
    '/alcor-demo-state',
    '--mount-dir',
    path.join(demoDir, 'plugin', 'alcor-demo-fixtures'),
    '/wordpress/wp-content/plugins/alcor-demo-fixtures',
  ];
  // Quoted so the path survives NODE_OPTIONS parsing; forward slashes avoid its backslash escapes on Windows.
  const hook = path.join(demoDir, 'loopback-bind.cjs').replace(/\\/g, '/');
  const nodeOptions = [process.env.NODE_OPTIONS, `--require="${hook}"`].filter(Boolean).join(' ');

  log(
    `starting Playground CLI ${PLAYGROUND_CLI_VERSION} (WordPress ${WORDPRESS_VERSION}, PHP ${PHP_VERSION}) on ${baseUrl}`,
  );
  log('the first start downloads the CLI, WordPress and PHP; later starts reuse the cache');
  const commandLine = ['npx', ...args.map(quote)].join(' ');
  const child = spawn(commandLine, {
    shell: true,
    cwd: stateDir,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: nodeOptions },
  });

  const recent = [];
  const keep = (chunk) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.trim() !== '') {
        recent.push(line);
        if (recent.length > 60) {
          recent.shift();
        }
      }
    }
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });

  const stop = async () => {
    killTree(child);
    for (let i = 0; i < 50 && !exited; i++) {
      await sleep(100);
    }
  };
  const logTail = () => recent.slice(-25).join('\n');

  // The seed script (run by the blueprint) writes ready.json as its last act, so its appearance means that
  // WordPress is installed, the plugins are loaded and the users exist.
  const readyFile = path.join(stateDir, 'ready.json');
  const started = Date.now();
  let ready = null;
  let lastBeat = started;
  while (ready === null) {
    if (exited) {
      throw new Error(`Playground exited before the site was ready.\n${logTail()}`);
    }
    if (Date.now() - started > READY_TIMEOUT_MS) {
      await stop();
      throw new Error(
        `Playground was not ready after ${READY_TIMEOUT_MS / 60000} minutes.\n${logTail()}`,
      );
    }
    if (fs.existsSync(readyFile)) {
      try {
        ready = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
      } catch {
        // The seed script is still writing the file; read it again on the next pass.
      }
    }
    if (ready === null) {
      if (Date.now() - lastBeat > 20000) {
        lastBeat = Date.now();
        log(`still starting (${Math.round((Date.now() - started) / 1000)} s)`);
      }
      await sleep(1000);
    }
  }

  if (!(await waitForPort(port, 120000))) {
    await stop();
    throw new Error(`The site is prepared but port ${port} never opened.\n${logTail()}`);
  }
  return { baseUrl, ready, stop, logTail };
}

/**
 * Waits until something accepts TCP connections on a loopback port.
 * @param {number} port - Port to try.
 * @param {number} timeoutMs - How long to keep trying.
 * @returns {Promise<boolean>} True once a connection succeeded; false on timeout.
 */
async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
    });
    if (open) {
      return true;
    }
    await sleep(500);
  }
  return false;
}
