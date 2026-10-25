import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createEngine } from '../src/engine.mjs';
import { startServer } from '../src/server.mjs';


async function setup(fn, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'eac-engine-'));
  const engine = await createEngine({ dataDir: directory, ...options });
  try { return await fn(engine, directory); }
  finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
}
async function fixture(path) {
  const child = spawn('ffmpeg', ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'testsrc2=s=160x90:r=12:d=1.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path], { windowsHide: true });
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
}
async function finished(engine, id) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const job = await engine.handle('job_status', { jobId: id });
    if (!['queued', 'running'].includes(job.status)) return job;
    await new Promise((done) => setTimeout(done, 40));
  }
  throw new Error('Job deadline exceeded');
}

test('compact state polling preserves project data and leaves the catalog to the library endpoint', () => setup(async engine => {
  const project = await engine.handle('project_create', { title: 'Compact state' });
  const compact = await engine.state({ includeTemplates: false });
  assert.deepEqual(compact.templates, []);
  assert.equal(compact.projects[0].id, project.id);
  assert.ok(compact.capabilities.length > 0);
  const app = await startServer({ engine, port: 0 });
  try {
    const response = await fetch(`${app.url}/api/state?templates=0`);
    assert.deepEqual((await response.json()).templates, []);
    const full = await fetch(`${app.url}/api/state`);
    assert.ok((await full.json()).templates.length >= 17);
    assert.ok((await engine.library()).templates.length >= 17);
  } finally { await app.close(); }
}));

test('project edits reject stale revisions and preserve the previous cut', () => setup(async (engine, dir) => {
  const path = join(dir, 'source.mp4');
  await fixture(path);
  const p = await engine.handle('project_create', { title: 'Revision proof', width: 160, height: 90, fps: 12 });
  const imported = await engine.handle('asset_import', { projectId: p.id, path });
  const planned = await engine.handle('timeline_plan', { projectId: p.id, duration: 1 });
  assert.equal(imported.assets.length, 1);
  assert.equal(planned.clips.length, 1);
  const edited = await engine.handle('timeline_update', { projectId: p.id, revision: planned.revision, clips: [{ ...planned.clips[0], duration: 0.5 }] });
  await assert.rejects(engine.handle('timeline_update', { projectId: p.id, revision: planned.revision, clips: [] }), /修改/);
  assert.equal(edited.clips[0].duration, 0.5);
  assert.equal(edited.history.at(-1).clips[0].duration, 1);
  await assert.rejects(engine.handle('timeline_update', { projectId: p.id, revision: edited.revision, clips: [{ ...edited.clips[0], sourceIn: 1.4, duration: 1 }] }), /时长/);
}));

test('real queued production imports, composes, renders and validates a playable file', () => setup(async (engine, dir) => {
  const path = join(dir, 'input 中文.mp4');
  await fixture(path);
  const p = await engine.handle('project_create', { title: '真实流水线', width: 160, height: 90, fps: 12 });
  const queued = await engine.handle('job_submit', { projectId: p.id, type: 'produce', params: { paths: [path], duration: 1.2, bpm: 100 } });
  const job = await finished(engine, queued.id);
  assert.equal(job.status, 'completed', job.error);
  assert.equal(job.result.qa.ok, true);
  assert.equal(job.result.qa.hasAudio, true);
  assert.ok((await readFile(job.result.path)).length > 1000);
  assert.ok((await readFile(job.result.review.path)).length > 1000);
  const project = await engine.handle('project_get', { projectId: p.id });
  assert.ok(project.lastOutput.revision);
  assert.equal(project.assets.length, 1);
}));

test('closing with a second queued task waits for the active worker to cancel', () => setup(async (engine) => {
  const p = await engine.handle('project_create', { title: 'Shutdown lifecycle', width: 160, height: 90, fps: 12 });
  const first = await engine.handle('job_submit', { projectId: p.id, type: 'record-browser', params: {
    url: 'data:text/html,<h1>Cancellation</h1>', actions: [{ type: 'wait', ms: 20000 }]
  }});
  const deadline = Date.now() + 3000;
  while ((await engine.handle('job_status', { jobId: first.id })).status === 'queued' && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 10));
  }
  await engine.handle('job_submit', { projectId: p.id, type: 'compose', params: { duration: 1 } });
  await new Promise((done) => setTimeout(done, 30));
  await engine.close();
  assert.equal((await engine.handle('job_status', { jobId: first.id })).status, 'cancelled');
}));

test('a background rough cut preserves a timeline manually edited during transcription', async () => {
  const started = Promise.withResolvers();
  const resume = Promise.withResolvers();
  await setup(async (engine, dir) => {
    const source = join(dir, 'talking.mp4');
    await fixture(source);
    const p = await engine.handle('project_create', { title: 'Human cut protection', width: 160, height: 90, fps: 12 });
    const imported = await engine.handle('asset_import', { projectId: p.id, path: source });
    const planned = await engine.handle('timeline_plan', { projectId: p.id, duration: 1 });
    const job = await engine.handle('job_submit', { projectId: p.id, type: 'rough-cut', params: { assetId: imported.assets[0].id, language: 'en' } });
    await started.promise;
    const manual = { ...planned.clips[0], id: 'human-cut', duration: 0.5 };
    try {
      const current = await engine.handle('project_get', { projectId: p.id });
      await engine.handle('timeline_update', { projectId: p.id, revision: current.revision, clips: [manual] });
    } finally { resume.resolve(); }
    const result = await finished(engine, job.id);
    assert.equal(result.status, 'failed');
    assert.match(result.error, /人工修改/);
    const preserved = await engine.handle('project_get', { projectId: p.id });
    assert.equal(preserved.clips[0].id, 'human-cut');
    assert.ok(preserved.assets[0].transcript.srtPath);
    const captionJob = await engine.handle('job_submit', { projectId: p.id, type: 'captions', params: { assetId: imported.assets[0].id } });
    const captionResult = await finished(engine, captionJob.id);
    assert.equal(captionResult.status, 'completed', captionResult.error);
    assert.ok(captionResult.result.count > 0);
    const captioned = await engine.handle('project_get', { projectId: p.id });
    assert.ok(captioned.captions.every((row) => row.start >= 0 && row.end <= manual.duration + 0.001));
    const renderJob = await engine.handle('job_submit', { projectId: p.id, type: 'render' });
    const rendered = await finished(engine, renderJob.id);
    assert.equal(rendered.status, 'completed', rendered.error);
    assert.equal(rendered.result.qa.ok, true);
  }, { transcribeMedia: async ({ outputDir }) => {
    started.resolve();
    await resume.promise;
    await mkdir(outputDir, { recursive: true });
    const srtPath = join(outputDir, 'fixture.srt');
    await writeFile(srtPath, '1\n00:00:00,000 --> 00:00:01,000\nFixture speech\n');
    return { srtPath, segments: [{ start: 0, end: 1, text: 'Fixture speech' }] };
  } });
});

test('missing input fails a job without discarding project state', () => setup(async (engine) => {
  const p = await engine.handle('project_create', { title: 'Failure recovery' });
  const queued = await engine.handle('job_submit', { projectId: p.id, type: 'render' });
  const job = await finished(engine, queued.id);
  assert.equal(job.status, 'failed');
  assert.ok(job.error);
  assert.equal((await engine.handle('project_get', { projectId: p.id })).title, 'Failure recovery');
}));

test('storage persists projects and only accepts production settings', () => setup(async (engine) => {
  await engine.handle('project_create', { title: 'Persistent' });
  await engine.settingsUpdate({ quality: 'draft', ttsVoice: '' });
  const state = await engine.state();
  assert.equal(state.templates.filter(item => !['motion-web', 'onetake', 'video-shotcraft'].includes(item.source)).length, 17);
  assert.deepEqual(Object.keys(state.settings).sort(), ['outputRoot', 'quality', 'ttsVoice']);
  const disk = JSON.parse(await readFile(engine.store.file, 'utf8'));
  assert.equal(disk.projects[0].title, 'Persistent');
  assert.equal(disk.settings.quality, 'draft');
  await assert.rejects(engine.settingsUpdate({ quality: 'invalid' }), /画质|质量/);
}));

test('HTTP rejects remote origins and arbitrary files; serves byte ranges only for approved media', () => setup(async (engine, dir) => {
  const app = await startServer({ engine, port: 0 });
  try {
    const blocked = await fetch(`${app.url}/api/projects`, { method: 'POST', headers: { origin: 'https://malicious.example', 'content-type': 'application/json' }, body: '{"title":"blocked"}' });
    assert.equal(blocked.status, 403);
    assert.equal((await fetch(`${app.url}/api/files?path=${encodeURIComponent(engine.store.file)}`)).status, 403);
    const removed = await fetch(`${app.url}/api/concat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(removed.status, 404);
    const p = await engine.handle('project_create', { title: 'Range' });
    const path = join(dir, 'range.mp4');
    await fixture(path);
    await engine.handle('asset_import', { projectId: p.id, path });
    const response = await fetch(`${app.url}/api/files?path=${encodeURIComponent(path)}`, { headers: { range: 'bytes=0-31' } });
    assert.equal(response.status, 206);
    assert.equal((await response.arrayBuffer()).byteLength, 32);
    const invalid = await fetch(`${app.url}/api/files?path=${encodeURIComponent(path)}`, { headers: { range: 'bytes=99999999-' } });
    assert.equal(invalid.status, 416);
  } finally { await app.close(); }
}));
