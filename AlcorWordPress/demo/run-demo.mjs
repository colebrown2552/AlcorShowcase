#!/usr/bin/env node
/**
 * Entry point of the AlcorWordPress demo: boots a fresh WordPress, runs the end-to-end checks, prints the result.
 *
 *     node demo/run-demo.mjs
 *
 * It starts the WordPress Playground CLI (pinned in lib/playground.mjs) on a loopback port, with the plugins of
 * mu-plugins/ mounted into a new site and demo/blueprint.json applied. Passwords and keys are generated for this
 * run only, handed to WordPress through a private temporary folder, and deleted at the end.
 *
 * Exit code: 0 when every check passed, 1 when a check failed, 2 when the site could not be started.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runChecks } from './lib/checks.mjs';
import {
  PHP_VERSION,
  PLAYGROUND_CLI_VERSION,
  WORDPRESS_VERSION,
  findFreePort,
  startPlayground,
} from './lib/playground.mjs';

const componentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Node 20.18 is the oldest release the Playground CLI supports. */
const MIN_NODE = [20, 18];

/**
 * Makes a random hex string.
 * @param {number} bytes - Number of random bytes.
 * @returns {string} Hex text of twice that length.
 */
const randomHex = (bytes) => randomBytes(bytes).toString('hex');

/**
 * Runs the demo.
 * @returns {Promise<number>} The process exit code.
 */
async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    console.error(
      `Node ${MIN_NODE.join('.')} or newer is required; this is ${process.versions.node}.`,
    );
    return 2;
  }

  // A private folder for this run only: created with owner-only permissions, mounted into WordPress, removed at the end.
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alcor-wp-demo-'));
  const config = {
    admin_password: randomHex(24),
    client_password: randomHex(24),
    s2s_key: randomHex(32),
    indexnow_key: randomHex(16),
  };
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(config), { mode: 0o600 });

  let site = null;
  const cleanup = async () => {
    if (site) {
      await site.stop();
    }
    fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  };
  const interrupt = () => {
    cleanup().finally(() => process.exit(130));
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);

  try {
    const port = Number(process.env.ALCOR_DEMO_PORT) || (await findFreePort());
    console.log('Alcor WordPress demo');
    site = await startPlayground({
      componentDir,
      stateDir,
      port,
      log: (line) => console.log(`[playground] ${line}`),
    });
    const results = await runChecks({
      baseUrl: site.baseUrl,
      config,
      ready: site.ready,
      componentDir,
    });

    const count = (status) => results.filter((result) => result.status === status).length;
    const failed = count('fail');
    console.log(
      `\nResult: ${count('ok')} passed, ${count('skip')} skipped, ${failed} failed` +
        ` (WordPress ${site.ready.wordpress}, PHP ${site.ready.php}, Playground CLI ${PLAYGROUND_CLI_VERSION})`,
    );

    if (failed > 0) {
      // A PHP fatal error or notice shows up here even when the HTTP answer only says "500".
      console.log(`\nLast lines of the Playground log:\n${site.logTail()}`);
    }

    // A machine-readable copy for CI. It holds check names and outcomes only, never a credential.
    const outDir = path.join(componentDir, 'demo', 'out');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'results.json'),
      JSON.stringify(
        {
          wordpress: site.ready.wordpress,
          php: site.ready.php,
          playground_cli: PLAYGROUND_CLI_VERSION,
          requested: { wordpress: WORDPRESS_VERSION, php: PHP_VERSION },
          passed: count('ok'),
          skipped: count('skip'),
          failed,
          checks: results,
        },
        null,
        2,
      ),
    );
    return failed === 0 ? 0 : 1;
  } catch (error) {
    console.error(`\nThe demo could not run: ${error.message}`);
    return 2;
  } finally {
    await cleanup();
  }
}

process.exitCode = await main();
