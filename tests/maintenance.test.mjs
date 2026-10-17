import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEngine } from '../src/engine.mjs';
import { createMaintenance } from '../src/maintenance.mjs';

async function setup(run) {
  const root = await mkdtemp(join(tmpdir(), 'eac-maintenance-'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'eac-design-world', version: '0.3.0' }));
  const engine = await createEngine({ dataDir: join(root, 'data') });
  try { await run({ root, engine }); }
  finally { await engine.close(); await rm(root, { recursive: true, force: true }); }
}
const finished = async maintenance => {
  for (let i = 0; i < 150; i++) {
    const state = maintenance.status();
    if (state.operation?.status !== 'running') return state;
    await new Promise(done => setTimeout(done, 10));
  }
  throw new Error('Maintenance did not finish');
};

test('maintenance distinguishes installed/running versions and refuses fake standalone reload', () => setup(async ({ root, engine }) => {
  const maintenance = createMaintenance({ engine, root, runningVersion: '0.2.0', feedSources: [] });
  try {
    const state = maintenance.status();
    assert.equal(state.runningVersion, '0.2.0');
    assert.equal(state.installedVersion, '0.3.0');
    assert.equal(state.versionMismatch, true);
    assert.equal(state.reload.available, false);
    assert.throws(() => maintenance.start('reload'), /宿主|重载/);
    assert.equal(state.updates.signingConfigured, false);
  } finally { await maintenance.close(); }
}));

test('reload is an asynchronous real activation with durable state and blocks new media jobs', () => setup(async ({ root, engine }) => {
  let invoked = 0;
  const maintenance = createMaintenance({ engine, root, runningVersion: '0.3.0', mode: 'harness', feedSources: [], reload: async () => {
    invoked++;
    return { ok: true, version: '0.3.0', fibers: 1 };
  } });
  try {
    const project = await engine.handle('project_create', { title: 'Preserved' });
    const operation = maintenance.start('reload');
    assert.ok(operation.operationId);
    await assert.rejects(engine.handle('job_submit', { projectId: project.id, type: 'compose', params: { duration: 1 } }), /维护|更新|重载/);
    const state = await finished(maintenance);
    assert.equal(state.operation.status, 'completed');
    assert.equal(invoked, 1);
    assert.equal(state.operation.result.version, '0.3.0');
    assert.equal(engine.store.state.projects[0].title, 'Preserved');
    const disk = JSON.parse(await readFile(join(engine.store.root, 'maintenance/operation.json'), 'utf8'));
    assert.equal(disk.status, 'completed');
  } finally { await maintenance.close(); }
}));

test('active production jobs prevent maintenance without cancelling the work', () => setup(async ({ root, engine }) => {
  const maintenance = createMaintenance({ engine, root, runningVersion: '0.3.0', feedSources: [], reload: async () => ({ ok: true, version: '0.3.0' }) });
  try {
    engine.store.state.jobs.push({ id: 'active', status: 'running', type: 'render' });
    assert.throws(() => maintenance.start('reload'), /任务/);
    assert.equal(engine.store.state.jobs[0].status, 'running');
    engine.store.state.jobs = [];
  } finally { await maintenance.close(); }
}));

test('announcement acknowledgements persist and failed refresh keeps cached messages', () => setup(async ({ root, engine }) => {
  await mkdir(join(root, 'feed'));
  await writeFile(join(root, 'feed/announcements.json'), JSON.stringify({ announcements: [{ id: 'fix', title: '工具接口修复', html: '<p>修复严格 JSON 返回。</p>', level: 'update', createdAt: '2026-10-17T00:00:00Z' }] }));
  const maintenance = createMaintenance({ engine, root, runningVersion: '0.3.0', feedSources: [] });
  try {
    assert.equal(maintenance.status().announcements.unread, 1);
    await maintenance.acknowledge(['fix']);
    assert.equal(maintenance.status().announcements.unread, 0);
    await maintenance.refreshAnnouncements();
    assert.equal(maintenance.status().announcements.items.length, 1);
    await maintenance.settingsUpdate({ autoReloadWatch: false, updateCheckHours: 12, feedPollMinutes: 30 });
    assert.equal(maintenance.status().settings.updateCheckHours, 12);
  } finally { await maintenance.close(); }
}));
