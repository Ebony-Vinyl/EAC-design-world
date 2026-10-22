import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { DesignStore } from '../src/design-store.mjs';

// Regression coverage for the storage layer's cross-process write protection. Two engines on one
// data directory used to overwrite each other silently (each wrote its whole in-memory snapshot
// back), so a second instance must now be refused, while a lock left by a dead process must be
// taken over instead of blocking every future start.

const temporaryDirectory = () => mkdtemp(join(tmpdir(), 'eac-store-'));

function projectRecord(title) {
  const now = new Date().toISOString();
  return { id: randomUUID(), title, revision: 1, assets: [], clips: [], createdAt: now, updatedAt: now };
}

const locked = (error) => error.code === 'EAC_LOCKED' && /另一个运行中的 EAC 实例/.test(error.message);

test('a second instance on the same data directory is refused instead of overwriting the first', async () => {
  const directory = await temporaryDirectory();
  const first = await new Store(directory).init();
  try {
    first.state.projects.push(projectRecord('A-项目一'), projectRecord('A-项目二'));
    await first.save();
    // The old code let this instance start, load an empty snapshot and erase both projects.
    await assert.rejects(new Store(directory).init(), locked);
    const onDisk = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
    assert.deepEqual(onDisk.projects.map((project) => project.title), ['A-项目一', 'A-项目二']);
    assert.equal(existsSync(join(directory, 'LOCK')), true);
    // Closing releases the directory: the next instance sees everything the first one wrote.
    await first.release();
    const second = await new Store(directory).init();
    assert.deepEqual(second.state.projects.map((project) => project.title), ['A-项目一', 'A-项目二']);
    await second.release();
  } finally {
    await first.release().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('a second design store on the same directory is refused too', async () => {
  const directory = await temporaryDirectory();
  const first = await new DesignStore(directory).init();
  try {
    await first.createProject({ title: 'A-设计', kind: 'website' });
    await assert.rejects(new DesignStore(directory).init(), locked);
    const onDisk = JSON.parse(await readFile(join(directory, 'projects.json'), 'utf8'));
    assert.deepEqual(onDisk.projects.map((project) => project.title), ['A-设计']);
  } finally {
    await first.release().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('the engine layout shares one lock, and only an explicit release frees the directory', async () => {
  const data = await temporaryDirectory();
  const store = await new Store(data).init();
  const design = await new DesignStore(join(data, 'design')).init();
  try {
    // Same data tree: the design sub-store joins the parent lock instead of fighting it, but a
    // separate engine is still refused.
    await assert.rejects(new Store(data).init(), locked);
    assert.equal(existsSync(join(data, 'LOCK')), true);
    // flush() only waits for pending writes. A checkpoint must not hand the directory to a
    // successor while this engine is still running, so the lock has to survive it.
    await design.flush();
    assert.equal(existsSync(join(data, 'LOCK')), true);
    await assert.rejects(new Store(data).init(), locked);
    // engine.close() releases explicitly, and that is what lets a successor start.
    await design.release();
    const successor = await new Store(data).init();
    await successor.release();
  } finally {
    await store.release().catch(() => {});
    await design.release().catch(() => {});
    await rm(data, { recursive: true, force: true });
  }
});

test('a lock left by a dead process is taken over', async () => {
  const directory = await temporaryDirectory();
  await mkdir(directory, { recursive: true });
  // A pid that certainly is not running any more: a child that printed its pid and exited.
  const child = spawn(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  });
  let printed = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { printed += chunk; });
  await once(child, 'exit');
  const deadPid = Number(printed.trim());
  assert.ok(Number.isInteger(deadPid) && deadPid > 0, `child pid must be printable, got ${printed}`);
  await writeFile(join(directory, 'LOCK'), JSON.stringify({
    tool: 'eac-design-world', pid: deadPid, hostname: 'gone', token: 'stale-token',
    startedAt: new Date(Date.now() - 60_000).toISOString(),
  }), 'utf8');
  const store = await new Store(directory).init();
  try {
    const lock = JSON.parse(await readFile(join(directory, 'LOCK'), 'utf8'));
    assert.equal(lock.pid, process.pid);
    assert.notEqual(lock.token, 'stale-token');
  } finally {
    await store.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a half-written lock file is reclaimed', async () => {
  const directory = await temporaryDirectory();
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'LOCK'), '{"pid":', 'utf8'); // crash between create and write
  const store = await new Store(directory).init();
  try {
    const lock = JSON.parse(await readFile(join(directory, 'LOCK'), 'utf8'));
    assert.equal(lock.pid, process.pid);
  } finally {
    await store.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a lock held by another live process is refused, then taken over after that process dies', async () => {
  const directory = await temporaryDirectory();
  const storeUrl = new URL('../src/store.mjs', import.meta.url).href;
  const script = `
    import { Store } from ${JSON.stringify(storeUrl)};
    await new Store(${JSON.stringify(directory)}).init();
    console.log('READY');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { errors += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child never became ready: ${output}${errors}`)), 30_000);
      const check = () => {
        if (!output.includes('READY')) return;
        clearTimeout(timer);
        resolve();
      };
      child.stdout.on('data', check);
      child.on('exit', () => {
        clearTimeout(timer);
        reject(new Error(`child exited early: ${output}${errors}`));
      });
      check();
    });
    const refusal = await new Store(directory).init().then(() => null, (error) => error);
    assert.ok(refusal, 'a live foreign lock must refuse the new instance');
    assert.equal(refusal.code, 'EAC_LOCKED');
    assert.match(refusal.message, new RegExp(`pid ${child.pid}\\b`));
    // Kill it hard: no exit cleanup runs, so the lock file survives with a dead pid.
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    assert.equal(existsSync(join(directory, 'LOCK')), true);
    const takeover = await new Store(directory).init();
    await takeover.release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});
