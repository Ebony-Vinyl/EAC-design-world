import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as packaging from '../scripts/pack-npm-runtime.mjs';

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));

test('published runtime does not require an install lifecycle script to restore assets', () => {
  assert.equal(typeof packaging.npmRuntimeManifest, 'function');
  const original = {
    name: 'eac-design-world', version: '0.5.0', scripts: {
      postinstall: 'node src/npm-assets-restore.mjs', start: 'node src/server.mjs', build: 'vite build',
    }, files: ['src', 'dist'],
  };
  const runtime = packaging.npmRuntimeManifest(original);
  assert.equal(runtime.scripts.postinstall, undefined);
  assert.equal(runtime.scripts.start, original.scripts.start);
  assert.equal(runtime.scripts.build, 'node src/npm-assets-restore.mjs && vite build');
  assert.ok(runtime.files.includes('npm-asset-map.json'));
  assert.equal(original.scripts.postinstall, 'node src/npm-assets-restore.mjs');
  assert.deepEqual(packaging.npmRuntimeManifest(runtime), runtime);
  assert.throws(() => packaging.npmRuntimeManifest({ scripts: { postinstall: 'custom-install-step' } }), /postinstall/);
});

test('repository install metadata does not trigger pnpm build approval for EAC', async () => {
  const manifest = await readJson('../package.json');
  const lock = await readJson('../package-lock.json');
  for (const hook of ['preinstall', 'install', 'postinstall']) assert.equal(manifest.scripts[hook], undefined, hook);
  assert.equal(lock.packages[''].hasInstallScript, undefined);
});
