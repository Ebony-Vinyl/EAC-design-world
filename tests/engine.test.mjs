import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createEngine, templateReadPath } from '../src/engine.mjs';
import { ROOT, loadLibrary } from '../src/catalog.mjs';
import { resolveLibraryPath } from '../src/open-design-library.mjs';
import { startServer } from '../src/server.mjs';
import { synthesizeVoice, probeMedia } from '../src/media/index.mjs';
import { transcriptCapabilities } from '../src/transcript.mjs';

async function setup(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'eac-engine-'));
  const engine = await createEngine({ dataDir: directory });
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

test('a background rough cut preserves a timeline manually edited during transcription', { skip: process.platform !== 'win32' }, (t) => setup(async (engine, dir) => {
  const capabilities = await transcriptCapabilities();
  if (!capabilities.available) {
    t.skip(`本地 Whisper 模型不可用：${capabilities.detail}`);
    return;
  }
  const voice = join(dir, 'spoken.wav');
  await synthesizeVoice({ text: 'Welcome to this local speech transcription test. These words should remain in the edited video.', outputPath: voice });
  const duration = (await probeMedia(voice)).duration;
  const source = join(dir, 'talking.mp4');
  const child = spawn('ffmpeg', ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi',
    '-i', `testsrc2=s=160x90:r=12:d=${duration}`, '-i', voice,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source], { windowsHide: true });
  assert.equal((await once(child, 'close'))[0], 0);
  const p = await engine.handle('project_create', { title: 'Human cut protection', width: 160, height: 90, fps: 12 });
  const imported = await engine.handle('asset_import', { projectId: p.id, path: source });
  const planned = await engine.handle('timeline_plan', { projectId: p.id, duration: 1 });
  const job = await engine.handle('job_submit', { projectId: p.id, type: 'rough-cut', params: { assetId: imported.assets[0].id, language: 'en' } });
  while ((await engine.handle('job_status', { jobId: job.id })).status === 'queued') {
    await new Promise((done) => setTimeout(done, 10));
  }
  await new Promise((done) => setTimeout(done, 150));
  const current = await engine.handle('project_get', { projectId: p.id });
  const manual = { ...planned.clips[0], id: 'human-cut', duration: 0.5 };
  await engine.handle('timeline_update', { projectId: p.id, revision: current.revision, clips: [manual] });
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
}));

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

// `od-*` entries come from vendor/open-design/catalog.json, so template_read has to gate them
// like library_read. Mutating one already-loaded catalog item is exactly what a tampered data
// file hands to resolveTemplate, and the mutation is restored so later tests see real data.
async function readableLibraryTemplate() {
  const library = await loadLibrary();
  const item = library.openDesignTemplates.find((candidate) => {
    if (candidate.kind === 'motion') return false;
    const entry = typeof candidate.entry === 'string' ? candidate.entry : candidate.entry?.path;
    const abs = typeof entry === 'string' ? resolveLibraryPath(entry) : null;
    return Boolean(abs && existsSync(abs));
  });
  assert.ok(item, 'the OpenDesign catalog needs one readable template entry for this test');
  return item;
}

test('template_read refuses a catalog path that escapes vendor/open-design', () => setup(async (engine) => {
  const victim = await readableLibraryTemplate();
  const escaping = 'vendor/open-design/../../package.json'; // stays a real file, but outside the library
  // Baseline: the untouched data file reads normally through the same call, so the gate below
  // cannot pass by breaking library reads.
  const baseline = await engine.handle('template_read', { templateId: victim.id, source: true });
  assert.ok(baseline.content.length > 0);
  assert.ok(!relative(join(ROOT, 'vendor', 'open-design'), baseline.path).startsWith('..'));
  // The prompt/description branch of a real library item is readable too, so the gate is not
  // only proven against the source-file branch.
  const withPrompt = (await loadLibrary()).openDesignTemplates.find((candidate) => {
    const prompt = typeof candidate.prompt === 'string' ? candidate.prompt : candidate.prompt?.path || candidate.promptPath;
    const abs = typeof prompt === 'string' ? resolveLibraryPath(prompt) : null;
    return candidate.kind !== 'motion' && Boolean(abs && existsSync(abs));
  });
  assert.ok(withPrompt, 'the OpenDesign catalog needs one readable prompt for this test');
  const described = await engine.handle('template_read', { templateId: withPrompt.id });
  assert.ok(described.content.length > 0);
  assert.ok(!relative(join(ROOT, 'vendor', 'open-design'), described.path).startsWith('..'));
  const originalEntry = victim.entry;
  const originalPrompt = victim.prompt;
  try {
    victim.entry = escaping;
    await assert.rejects(engine.handle('template_read', { templateId: victim.id, source: true }), /越界/);
    victim.entry = { path: escaping }; // catalog entries are also allowed to be { path } objects
    await assert.rejects(engine.handle('template_read', { templateId: victim.id, source: true }), /越界/);
    victim.prompt = escaping; // the prompt/description branch must be gated too
    await assert.rejects(engine.handle('template_read', { templateId: victim.id }), /越界/);
  } finally {
    victim.entry = originalEntry;
    victim.prompt = originalPrompt;
  }
  // Restoring the catalog restores the read: no refusal is cached against the template.
  const restored = await engine.handle('template_read', { templateId: victim.id, source: true });
  assert.equal(restored.content, baseline.content);
}));

test('template_read still serves built-in templates after the containment gate', () => setup(async (engine) => {
  const prompt = await engine.handle('template_read', { templateId: 'motion-promo-film-v2' });
  assert.match(prompt.path.replace(/\\/g, '/'), /vendor\/motion-promo-film-v2\/SKILL\.md$/);
  assert.ok(prompt.content.length > 0);
  const source = await engine.handle('template_read', { templateId: '05-cel-boil', source: true });
  assert.match(source.path.replace(/\\/g, '/'), /vendor\/mg-styles-15\/demos\/05-cel-boil\/index\.html$/);
  assert.ok(source.content.length > 0);
}));

test('templateReadPath refuses traversal while accepting every legitimate template root', async () => {
  assert.ok(await templateReadPath({ id: 'od-article-magazine' }, 'vendor/open-design/catalog.json'));
  assert.ok(await templateReadPath({ id: 'od-article-magazine' }, '/vendor/open-design/catalog.json'));
  assert.equal(await templateReadPath({ id: 'od-article-magazine' }, '../../package.json'), null);
  assert.equal(await templateReadPath({ id: 'od-article-magazine' }, 'vendor/open-design/../../package.json'), null);
  assert.equal(await templateReadPath({ id: 'od-article-magazine' }, 'vendor\\open-design\\..\\..\\package.json'), null);
  assert.equal(await templateReadPath({ id: 'od-article-magazine' }, '/etc/passwd'), null);
  // A data file must not loosen the gate by spoofing `source`: od- ids are always library paths.
  assert.equal(await templateReadPath({ id: 'od-article-magazine', source: 'mg-styles-15' }, '../../package.json'), null);
  // Built-in templates are code constants and stay readable, but only inside the repository.
  assert.ok(await templateReadPath({ id: '05-cel-boil', source: 'mg-styles-15' }, 'vendor/mg-styles-15/prompts/05-cel-boil.md'));
  assert.equal(await templateReadPath({ id: '05-cel-boil', source: 'mg-styles-15' }, '../../package.json'), null);
  if (process.platform === 'win32') {
    assert.equal(await templateReadPath({ id: 'od-article-magazine' }, 'C:\\Windows\\win.ini'), null);
    assert.equal(await templateReadPath({ id: 'od-article-magazine' }, 'C:/Users/Public'), null);
    assert.equal(await templateReadPath({ id: 'od-article-magazine' }, '\\\\server\\share\\secret.md'), null);
    assert.equal(await templateReadPath({ id: '05-cel-boil', source: 'mg-styles-15' }, 'D:\\Windows\\win.ini'), null);
  }
});
