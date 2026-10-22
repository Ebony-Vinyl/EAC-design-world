import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
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

/** A pid that certainly is not running any more: a child that printed its pid and exited. */
async function deadProcessId() {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  });
  let printed = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { printed += chunk; });
  await once(child, 'exit');
  const pid = Number(printed.trim());
  assert.ok(Number.isInteger(pid) && pid > 0, `child pid must be printable, got ${printed}`);
  return pid;
}

/**
 * Starts `count` engine processes that all call init() on the same directory at the very same
 * instant (a busy-wait on a shared wall-clock deadline, so process start-up jitter cannot stagger
 * them), each holding the directory for 400 ms after winning. Returns what every process printed.
 */
async function simultaneousStarts(directory, count = 4) {
  const storeUrl = new URL('../src/store.mjs', import.meta.url).href;
  const script = `
    import { Store } from ${JSON.stringify(storeUrl)};
    const startAt = Number(process.env.EAC_TEST_START);
    while (Date.now() < startAt) { /* line every process up on the same instant */ }
    let store;
    try {
      store = await new Store(${JSON.stringify(directory)}).init();
    } catch (error) {
      console.log('RESULT LOCKED ' + error.code);
      process.exit(0);
    }
    store.state.projects.push({
      id: process.env.EAC_TEST_ID, title: 'only-one-writer', revision: 1, assets: [], clips: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await store.save();
    console.log('RESULT ACQUIRED ' + process.env.EAC_TEST_ID);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await store.release();
    process.exit(0);
  `;
  const ids = Array.from({ length: count }, () => randomUUID());
  const startAt = String(Date.now() + 1500);
  const children = ids.map((id) => spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, EAC_TEST_START: startAt, EAC_TEST_ID: id },
  }));
  const collected = Promise.all(children.map((child) => new Promise((resolve) => {
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('exit', () => resolve({ out, err }));
  })));
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('concurrent engine processes did not finish in time')), 40_000).unref();
  });
  const results = await Promise.race([collected, timeout]);
  return results.map((result) => ({
    ...result,
    acquired: result.out.includes('RESULT ACQUIRED'),
    id: result.out.trim().split(/\s+/)[2] ?? null,
  }));
}

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
  // Same host, dead pid: this machine can prove the owner is gone, so the lock is a crash leftover.
  // (A lock naming another host is a different case, covered by the hostname tests below.)
  const deadPid = await deadProcessId();
  await writeFile(join(directory, 'LOCK'), JSON.stringify({
    tool: 'eac-design-world', pid: deadPid, hostname: hostname(), token: 'stale-token',
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

test('a fresh half-written lock is waited for; only one past the grace is reclaimed', async () => {
  // Regression for the P0 double hold. open(LOCK,'wx') leaves 0 bytes (or a partially written
  // record) behind before the owner lands; reading that as "no pid therefore stale" let a
  // competitor move the lock aside and take it over, after which two instances both held the data
  // directory and each silently erased the other's projects. A fresh owner-less lock is a writer
  // in flight: wait for it.
  for (const [label, content] of [['0 bytes, as open(wx) leaves it', ''], ['truncated JSON', '{"pid":']]) {
    const directory = await temporaryDirectory();
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'LOCK'), content, 'utf8');
    try {
      let acquired = null;
      const pending = new Store(directory).init().then((store) => { acquired = store; return store; });
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(acquired, null, `a fresh half-written lock (${label}) must not be reclaimed`);
      assert.equal(await readFile(join(directory, 'LOCK'), 'utf8'), content,
        `the in-flight lock (${label}) must be left untouched, not moved aside`);
      // Past the grace it is provably a crash leftover, and only then may it be replaced.
      const store = await pending;
      try {
        const lock = JSON.parse(await readFile(join(directory, 'LOCK'), 'utf8'));
        assert.equal(lock.pid, process.pid);
        assert.equal(lock.hostname, hostname());
        assert.equal(existsSync(join(directory, 'LOCK.reclaim')), false, 'the reclaim guard must be cleaned up');
      } finally {
        await store.release();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('a fresh lock from another host is treated as live, even with a pid that is dead here', async () => {
  const directory = await temporaryDirectory();
  await mkdir(directory, { recursive: true });
  const deadPid = await deadProcessId();
  await writeFile(join(directory, 'LOCK'), JSON.stringify({
    tool: 'eac-design-world', pid: deadPid, hostname: 'another-machine', token: 'foreign-token',
    startedAt: new Date().toISOString(), acquiredAt: new Date().toISOString(),
  }), 'utf8');
  try {
    // That pid means nothing on this machine, so it cannot prove the owner is gone: the lock has to
    // count as live. Stealing it here is what produced two instances on a shared/network directory.
    const refusal = await new Store(directory).init().then(() => null, (error) => error);
    assert.ok(refusal, 'a fresh lock from another host must refuse this instance');
    assert.equal(refusal.code, 'EAC_LOCKED');
    assert.match(refusal.message, /another-machine/);
    const onDisk = JSON.parse(await readFile(join(directory, 'LOCK'), 'utf8'));
    assert.equal(onDisk.token, 'foreign-token', 'the foreign lock must be left in place');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a lock from another host is reclaimed once it is past the takeover TTL', async () => {
  const directory = await temporaryDirectory();
  await mkdir(directory, { recursive: true });
  const deadPid = await deadProcessId();
  const lockPath = join(directory, 'LOCK');
  await writeFile(lockPath, JSON.stringify({
    tool: 'eac-design-world', pid: deadPid, hostname: 'another-machine', token: 'foreign-token',
    startedAt: new Date(Date.now() - 31 * 60_000).toISOString(),
  }), 'utf8');
  const longAgo = new Date(Date.now() - 31 * 60_000);
  await utimes(lockPath, longAgo, longAgo);
  const store = await new Store(directory).init();
  try {
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    assert.equal(lock.pid, process.pid);
    assert.equal(lock.hostname, hostname());
    assert.notEqual(lock.token, 'foreign-token');
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

test('simultaneous starts on a fresh directory never produce two holders', async () => {
  const directory = await temporaryDirectory();
  try {
    // Four processes, same wall-clock instant, empty data directory. Before the fix the first one
    // published a 0-byte LOCK, the others read "no pid therefore stale", moved it aside and started
    // too; both then wrote their whole snapshot back, so one winner's projects vanished (last
    // writer wins). One acquisition is the only correct outcome.
    const results = await simultaneousStarts(directory);
    const silent = results.filter((result) => !result.out.includes('RESULT'));
    assert.equal(silent.length, 0, `every process must report a decision: ${JSON.stringify(results)}`);
    const winners = results.filter((result) => result.acquired);
    assert.ok(winners.length <= 1, `two instances held the same data directory: ${winners.length} acquisitions`);
    assert.equal(winners.length, 1, `exactly one instance must win, got ${winners.length}`);
    const onDisk = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
    // The winner's project must survive on disk; a second holder would have overwritten it.
    assert.deepEqual(onDisk.projects.map((project) => project.id), [winners[0].id],
      'the winning instance\'s project must be the one on disk');
    const leftovers = (await readdir(directory)).filter((name) => name.includes('.tmp'));
    assert.deepEqual(leftovers, [], 'temporary lock files must be cleaned up');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('simultaneous starts on a leftover crash lock never produce two holders', async () => {
  const directory = await temporaryDirectory();
  await mkdir(directory, { recursive: true });
  const deadPid = await deadProcessId();
  await writeFile(join(directory, 'LOCK'), JSON.stringify({
    tool: 'eac-design-world', pid: deadPid, hostname: hostname(), token: 'crashed-token',
    startedAt: new Date(Date.now() - 60_000).toISOString(),
  }), 'utf8');
  try {
    // Same instant, but now everyone must reclaim a crash leftover first. Two reclaimers that both
    // judged the same file stale must not move each other's fresh LOCK aside (rename() cannot tell
    // "the file I judged" from a successor's lock), or they end up as two holders again.
    const results = await simultaneousStarts(directory);
    const winners = results.filter((result) => result.acquired);
    assert.ok(winners.length <= 1, `two instances held the same data directory: ${winners.length} acquisitions`);
    assert.equal(winners.length, 1, `exactly one instance must win, got ${winners.length}`);
    const onDisk = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
    assert.deepEqual(onDisk.projects.map((project) => project.id), [winners[0].id]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('state and lock writes are fsynced before the rename publishes them', async () => {
  // A rename only orders the directory entry, not the bytes behind the temporary file. Without the
  // fsync a power loss leaves a 0-byte or half-written state.json behind — every project gone. The
  // only observable proof of durability is the fsync call, so count it on the shared FileHandle
  // prototype (restored in finally; tests in one file run sequentially).
  const directory = await temporaryDirectory();
  const probe = await open(join(directory, 'probe.txt'), 'w');
  const FileHandle = probe.constructor;
  await probe.close();
  const original = FileHandle.prototype.sync;
  const syncs = [];
  FileHandle.prototype.sync = async function counted() {
    syncs.push(this.fd);
    return original.call(this);
  };
  try {
    const store = await new Store(directory).init();
    const afterInit = syncs.length;
    // One for the published LOCK, one for the first state.json: neither may reach the disk unsynced.
    assert.ok(afterInit >= 2, `init() must fsync the lock and the state file, saw ${afterInit} fsyncs`);
    store.state.projects.push(projectRecord('fsync-项目'));
    await store.save();
    assert.equal(syncs.length - afterInit, 1, 'save() must fsync the state file before renaming it');
    const onDisk = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
    assert.deepEqual(onDisk.projects.map((project) => project.title), ['fsync-项目']);
    await store.release();
  } finally {
    FileHandle.prototype.sync = original;
    await rm(directory, { recursive: true, force: true });
  }
});
