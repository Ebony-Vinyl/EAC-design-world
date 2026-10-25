import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { restoreNpmAssets } from '../src/npm-assets-restore.mjs';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'eac-npm-assets-'));
  try {
    const bytes = Buffer.from([0, 1, 19, 128, 255, 0, 77]);
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.4.0' }));
    await writeFile(join(root, 'original.bin'), bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const map = assets => writeFile(join(root, 'npm-asset-map.json'), JSON.stringify({ version: 1, packageVersion: '0.4.0', assets }));
    await run({ root, bytes, sha256, map });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('npm assets restore exact bytes without downloading and preserve later customizations', () => fixture(async ({ root, bytes, sha256, map }) => {
  assert.deepEqual(restoreNpmAssets(root), { restored: 0 });
  await map([{ from: 'original.bin', to: 'nested/copy.bin', sha256 }]);
  assert.deepEqual(restoreNpmAssets(root), { restored: 1 });
  assert.deepEqual(await readFile(join(root, 'nested/copy.bin')), bytes);
  await writeFile(join(root, 'nested/copy.bin'), 'customized');
  assert.deepEqual(restoreNpmAssets(root), { restored: 0 });
  assert.equal(await readFile(join(root, 'nested/copy.bin'), 'utf8'), 'customized');
  assert.deepEqual(await readFile(join(root, 'original.bin')), bytes);
}));

test('first catalog import restores assets with lifecycle scripts disabled', () => fixture(async ({ root, bytes, sha256, map }) => {
  await mkdir(join(root, 'src'));
  for (const file of ['catalog.mjs', 'npm-assets-restore.mjs', 'motion-libraries.mjs', 'shotcraft-library.mjs']) {
    await copyFile(new URL(`../src/${file}`, import.meta.url), join(root, 'src', file));
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.4.0', type: 'module' }));
  await map([{ from: 'original.bin', to: 'vendor/restored.bin', sha256 }]);
  assert.equal(existsSync(join(root, 'vendor/restored.bin')), false);
  const catalog = pathToFileURL(join(root, 'src/catalog.mjs')).href;
  execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(catalog)});`], {
    cwd: root, windowsHide: true, env: { ...process.env, npm_config_ignore_scripts: 'true' },
  });
  assert.deepEqual(await readFile(join(root, 'vendor/restored.bin')), bytes);
}));

test('npm assets ignore a previous version map after a full managed update', () => fixture(async ({ root, sha256, map }) => {
  await map([{ from: 'original.bin', to: 'obsolete.bin', sha256 }]);
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.5.0' }));
  assert.deepEqual(restoreNpmAssets(root), { restored: 0 });
  await assert.rejects(readFile(join(root, 'obsolete.bin')), /ENOENT/);
}));

test('npm assets reject traversal and source content mismatches before copying', () => fixture(async ({ root, sha256, map }) => {
  await map([{ from: 'original.bin', to: '../outside.bin', sha256 }]);
  assert.throws(() => restoreNpmAssets(root), /escapes package/);
  await map([{ from: 'original.bin', to: 'copy.bin', sha256: '0'.repeat(64) }]);
  assert.throws(() => restoreNpmAssets(root), /content differs/);
  await map([{ from: '../outside.bin', to: 'copy.bin', sha256 }]);
  assert.throws(() => restoreNpmAssets(root), /escapes package/);
}));

test('npm assets refuse to write through a directory junction outside the package', () => fixture(async ({ root, sha256, map }) => {
  const outside = await mkdtemp(join(tmpdir(), 'eac-npm-outside-'));
  try {
    await mkdir(join(root, 'vendor'));
    await symlink(outside, join(root, 'vendor/escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await map([{ from: 'original.bin', to: 'vendor/escape/missing/copy.bin', sha256 }]);
    assert.throws(() => restoreNpmAssets(root), /directory escapes package/);
    await assert.rejects(readFile(join(outside, 'missing/copy.bin')), /ENOENT/);
  } finally { await rm(outside, { recursive: true, force: true }); }
}));
