/**
 * Checks that screenshot dimension validation reads only the PNG header and rejects bad files.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { validateScreenshotDimensions } from './worker.mjs';

test('screenshot validation reads a bounded header and rejects invalid dimensions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'alcor-png-header-'));
  const file = path.join(dir, 'test.png');
  try {
    const header = Buffer.alloc(24);
    header.write('PNG', 1, 'ascii');
    header.writeUInt32BE(1440, 16);
    header.writeUInt32BE(24000, 20);
    await writeFile(file, header);
    const handle = await open(file, 'r+');
    try {
      await handle.truncate(16 * 1024 * 1024);
    } finally {
      await handle.close();
    }
    await validateScreenshotDimensions(file, 1440, 24000);
    await assert.rejects(validateScreenshotDimensions(file, 1440, 23999), /dimensions/);
    header.write('BAD', 1, 'ascii');
    await writeFile(file, header);
    await assert.rejects(validateScreenshotDimensions(file, 1440, 24000), /dimensions/);
    await writeFile(file, Buffer.alloc(23));
    await assert.rejects(validateScreenshotDimensions(file, 1440, 24000), /dimensions/);
    // Removal also verifies no validation handle remains open on Windows.
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
