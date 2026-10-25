import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { VERSION } from '../src/version.mjs';
import { RELEASE_PUBLIC_KEY } from '../src/maintenance-key.mjs';
import { createPublicKey } from 'node:crypto';

test('release metadata agrees on the version and preserves the existing update trust root', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, VERSION);
  assert.equal(lock.version, VERSION);
  assert.equal(lock.packages[''].version, VERSION);
  assert.equal(createPublicKey({ key: Buffer.from(RELEASE_PUBLIC_KEY, 'base64'), format: 'der', type: 'spki' }).asymmetricKeyType, 'ed25519');
  assert.equal(RELEASE_PUBLIC_KEY, 'MCowBQYDK2VwAyEAMjXwBSNcXLJzJnOHsx8uV52CTW8EgommII5Qr41fecY=');
  for (const key of ['preinstall', 'install', 'postinstall']) assert.equal(pkg.scripts[key], undefined);
});

test('publishable sample scripts accept media inputs without developer-specific paths', async () => {
  for (const name of ['landscape', 'showcase', 'merged']) {
    const source = await readFile(new URL(`../scripts/demo-${name}.mjs`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /[A-Z]:\\\\(?:BaiduNetdiskDownload|密码)/);
    assert.match(source, /process\.env\.EAC_DEMO_/);
  }
});
