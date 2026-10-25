import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOfflineUpdate } from '../scripts/update-local.mjs';

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'eac-offline-update-'));
  const install = join(directory, 'install');
  const dataDir = join(directory, 'data');
  await mkdir(install);
  await mkdir(dataDir);
  await writeFile(join(install, 'package.json'), '{"name":"eac-design-world","version":"0.5.0","main":"./plugin/host.mjs"}');
  try { await run({ directory, install, dataDir }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('offline update requires the old service to be explicitly stopped before any write', () => fixture(async ({ install, dataDir }) => {
  const before = await readFile(join(install, 'package.json'), 'utf8');
  await assert.rejects(runOfflineUpdate({ installDir: install, dataDir }), /stopped|停止/);
  assert.equal(await readFile(join(install, 'package.json'), 'utf8'), before);
}));

test('offline update refuses a directory with an active writer lock', () => fixture(async ({ install, dataDir }) => {
  await mkdir(join(dataDir, '.writer.lock'));
  await assert.rejects(runOfflineUpdate({ installDir: install, dataDir, stopped: true, manifestPath: 'missing.json' }), /lock|锁/);
  assert.match(await readFile(join(install, 'package.json'), 'utf8'), /0\.5\.0/);
}));
