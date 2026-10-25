import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('..', import.meta.url));
async function installation(run) {
  const directory = await mkdtemp(join(tmpdir(), 'eac-startup-'));
  const modules = join(directory, 'node_modules');
  await mkdir(modules);
  const linked = join(modules, 'eac-design-world');
  await symlink(root, linked, process.platform === 'win32' ? 'junction' : 'dir');
  try { await run({ directory, linked }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

async function starts(entry, directory, extra = []) {
  const child = spawn(process.execPath, [...extra, entry], {
    cwd: directory, windowsHide: true,
    env: { ...process.env, EAC_DATA_DIR: join(directory, `state-${randomUUID()}`), EAC_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  let stdout = '', stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    const url = await new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(new Error(`Startup did not announce a listening server: ${stdout}\n${stderr}`)), 15000);
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        const match = /EAC design world: (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
        if (match) { clearTimeout(timer); accept(match[1]); }
      });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited before listening (code ${code}): ${stdout}\n${stderr}`)); });
    });
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    const health = await response.json();
    assert.equal(health.ok, true);
    assert.equal(health.name, 'EAC design world');
    assert.ok(health.version);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await closed;
  }
}

test('standalone server starts through a pnpm-style package directory link', { timeout: 30000 }, () => installation(async ({ directory, linked }) => {
  await starts(join(linked, 'src', 'server.mjs'), directory);
}));

test('standalone server starts from a real path and with preserve-symlinks-main', { timeout: 60000 }, () => installation(async ({ directory, linked }) => {
  await starts(resolve(root, 'src', 'server.mjs'), directory);
  await starts(join(linked, 'src', 'server.mjs'), directory, ['--preserve-symlinks-main']);
}));

test('importing the linked server module never starts a standalone listener', { timeout: 30000 }, () => installation(async ({ directory, linked }) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(linked, 'src', 'server.mjs')).href)}); console.log('import-only');`], {
    cwd: directory, windowsHide: true,
    env: { ...process.env, EAC_DATA_DIR: join(directory, `state-${randomUUID()}`), EAC_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGTERM'), 20000);
  try {
    const [code] = await once(child, 'close');
    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), 'import-only');
  } finally { clearTimeout(timer); }
}));
