import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

test('the shipped lock runtime works without installing any new dependency', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-lock-runtime-'));
  let release;
  try {
    const isolated = join(directory, 'lock.cjs');
    await copyFile(new URL('../vendor/eac-runtime/proper-lockfile.cjs', import.meta.url), isolated);
    const lockfile = createRequire(import.meta.url)(isolated);
    const options = { lockfilePath: join(directory, '.writer.lock'), stale: 120000, update: 15000, retries: 0 };
    release = await lockfile.lock(directory, options);
    await assert.rejects(lockfile.lock(directory, options), { code: 'ELOCKED' });
    await release();
    release = await lockfile.lock(directory, options);
    await release();
    release = null;
  } finally {
    await release?.();
    await rm(directory, { recursive: true, force: true });
  }
});
