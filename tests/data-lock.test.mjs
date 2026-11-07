import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createEngine } from '../src/engine.mjs';

test('a second process cannot recover or overwrite an active store; an owner that died is taken over', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-lock-'));
  const entry = new URL('../src/engine.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const {createEngine}=await import(${JSON.stringify(entry)});
    const engine=await createEngine({dataDir:process.argv[1]});
    await engine.handle('project_create',{title:'Preserved project'});
    const keep=setInterval(()=>{},1000);
    process.on('SIGTERM',async()=>{clearInterval(keep);await engine.close();process.exit(0)});
    console.log('ready');
  `, directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  let reopened;
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('owner failed to start'); })]);
    await assert.rejects(createEngine({ dataDir: directory }), /数据目录已被/);
    const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit;
    // Windows terminates the process without running its SIGTERM handler, so the lock directory
    // outlives its owner. The recorded owner pid is gone, so the next host may take it over at once
    // instead of waiting for the lock to age out.
    reopened = await createEngine({ dataDir: directory });
    assert.equal(reopened.store.state.projects[0].title, 'Preserved project');
    await reopened.close(); await reopened.close();
    await assert.rejects(reopened.handle('project_create', { title: 'After close' }), /已关闭/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
    await reopened?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a lock whose recorded owner is gone is taken over without waiting for it to go stale', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-lock-dead-'));
  try {
    const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await once(gone, 'exit');
    await mkdir(join(directory, '.writer.lock'), { recursive: true });
    await writeFile(join(directory, '.writer.pid'), String(gone.pid));
    const engine = await createEngine({ dataDir: directory });
    await engine.close();
    await assert.rejects(stat(join(directory, '.writer.lock')), { code: 'ENOENT' });
    await assert.rejects(stat(join(directory, '.writer.pid')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a lock with no recorded owner still fails closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-lock-unknown-'));
  try {
    await mkdir(join(directory, '.writer.lock'), { recursive: true });
    await assert.rejects(createEngine({ dataDir: directory }), /数据目录已被/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('failed initialization releases the lock for a repaired state file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-lock-init-'));
  try {
    await writeFile(join(directory, 'state.json'), '{broken');
    await assert.rejects(createEngine({ dataDir: directory }), /State file/);
    await rm(join(directory, 'state.json'));
    const engine = await createEngine({ dataDir: directory });
    await engine.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
