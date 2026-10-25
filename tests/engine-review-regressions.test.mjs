import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../src/engine.mjs';
import { startServer } from '../src/server.mjs';

const SECRETS = { pexelsApiKey: 'pexels-secret-value', pixabayApiKey: 'pixabay-secret-value', jamendoClientId: 'jamendo-secret-value' };
const RAW = Object.keys(SECRETS);
const FLAGS = ['pexelsApiKeyConfigured', 'pixabayApiKeyConfigured', 'jamendoClientIdConfigured'];

async function setup(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'eac-review-'));
  const engine = await createEngine({ dataDir: dir });
  try { return await fn(engine, dir); }
  finally { await engine.close(); await rm(dir, { recursive: true, force: true }); }
}

// A tiny real media fixture keeps the flow realistic without any provider network calls.
async function fixture(dir, name, kind = 'audio') {
  const path = join(dir, name);
  const { spawnSync } = await import('node:child_process');
  const args = kind === 'audio'
    ? ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'pcm_s16le']
    : ['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=12:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'];
  const run = spawnSync('ffmpeg', ['-hide_banner', '-y', '-loglevel', 'error', ...args, path], { windowsHide: true });
  assert.equal(run.status, 0, run.stderr?.toString());
  return path;
}

function assertNoSecrets(value, label) {
  if (typeof value === 'string') {
    // Parsed JSON bodies arrive as text; only a quoted secret key/value is a leak, since the
    // *Configured flags legitimately contain the raw key name as a prefix.
    for (const key of RAW) assert.ok(!value.includes(`"${key}"`), `${label} leaked raw property ${key}`);
    for (const secret of Object.values(SECRETS)) assert.ok(!value.includes(secret), `${label} leaked secret value`);
    return;
  }
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      assert.ok(!RAW.includes(key), `${label} leaked raw property ${path}${key}`);
      walk(child, `${path}${key}.`);
    }
  };
  walk(value, '');
  for (const secret of Object.values(SECRETS)) assert.ok(!JSON.stringify(value).includes(secret), `${label} leaked secret value`);
}

test('public state and settings replace raw provider credentials with booleans', () => setup(async (engine) => {
  await engine.settingsUpdate(SECRETS);
  const state = await engine.state();
  assertNoSecrets(state, 'engine.state');
  assertNoSecrets(state.settings, 'engine.state.settings');
  for (const flag of FLAGS) assert.equal(state.settings[flag], true, flag);
  const status = await engine.handle('status');
  assertNoSecrets(status, 'status');
  const saved = await engine.settingsUpdate({});
  assertNoSecrets(saved, 'settingsUpdate response');
  for (const flag of FLAGS) assert.equal(saved[flag], true, flag);
  // The store still holds the real credentials for provider calls.
  assert.equal(engine.store.state.settings.pexelsApiKey, SECRETS.pexelsApiKey);
  const disk = JSON.parse(await readFile(engine.store.file, 'utf8'));
  assert.equal(disk.settings.pexelsApiKey, SECRETS.pexelsApiKey);
}));

test('omitted secret settings stay unchanged while explicit empty values clear them', () => setup(async (engine) => {
  await engine.settingsUpdate(SECRETS);
  const unchanged = await engine.settingsUpdate({ quality: 'draft' });
  for (const flag of FLAGS) assert.equal(unchanged[flag], true, flag);
  assert.equal(engine.store.state.settings.pixabayApiKey, SECRETS.pixabayApiKey);
  const cleared = await engine.settingsUpdate({ pexelsApiKey: '', jamendoClientId: '   ' });
  assert.equal(cleared.pexelsApiKeyConfigured, false);
  assert.equal(cleared.jamendoClientIdConfigured, false);
  assert.equal(cleared.pixabayApiKeyConfigured, true);
  assert.equal(engine.store.state.settings.pexelsApiKey, '');
  assert.equal(engine.store.state.settings.jamendoClientId, '');
  assertNoSecrets(cleared, 'cleared settings');
}));

test('settings updates validate every field before mutating anything', () => setup(async (engine) => {
  await engine.settingsUpdate({ outputRoot: 'unchanged-root', quality: 'draft' });
  await assert.rejects(engine.settingsUpdate({ outputRoot: 'mutated-root', quality: 'invalid' }), /画质|质量/);
  assert.equal(engine.store.state.settings.outputRoot, 'unchanged-root');
  assert.equal(engine.store.state.settings.quality, 'draft');
  await assert.rejects(engine.settingsUpdate({ ttsVoice: 'ok', pexelsApiKey: 42 }), /无效设置/);
  assert.equal(engine.store.state.settings.ttsVoice, '');
}));

test('HTTP state, settings and status never expose raw credentials', () => setup(async (engine) => {
  await engine.settingsUpdate(SECRETS);
  const app = await startServer({ engine, port: 0 });
  try {
    for (const path of ['/api/state', '/api/state?templates=0']) {
      const body = await (await fetch(`${app.url}${path}`)).text();
      assertNoSecrets(body, path);
      const parsed = JSON.parse(body);
      for (const flag of FLAGS) assert.equal(parsed.settings[flag], true, flag);
    }
    const put = await fetch(`${app.url}/api/settings`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quality: 'production' }),
    });
    const text = await put.text();
    assertNoSecrets(text, 'PUT /api/settings');
    assert.equal(JSON.parse(text).pexelsApiKeyConfigured, true);
  } finally { await app.close(); }
}));

test('long Unicode titles keep a unique revision and job suffix in draft names', () => setup(async (engine, dir) => {
  const draftRoot = join(dir, 'drafts');
  await engine.settingsUpdate({ jianyingDraftRoot: draftRoot, ...SECRETS });
  const source = await fixture(dir, 'clip.mp4', 'video');
  const title = '城市夜景宣传片'.repeat(20) + '🎬🌃';
  const project = await engine.handle('project_create', { title, width: 160, height: 90, fps: 12 });
  await engine.handle('asset_import', { projectId: project.id, path: source });
  const planned = await engine.handle('timeline_plan', { projectId: project.id, duration: 0.5 });
  const exportOnce = async () => {
    const job = await engine.handle('job_submit', { projectId: planned.id, type: 'export', params: { targets: ['jianying', 'bundle'] } });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const state = await engine.handle('job_status', { jobId: job.id });
      if (state.status === 'completed') return { job, result: state.result };
      if (state.status === 'failed') assert.fail(state.error);
      await new Promise(done => setTimeout(done, 30));
    }
    assert.fail('Export did not finish');
  };
  const first = await exportOnce();
  const second = await exportOnce();
  assert.ok(first.result.draftName.length <= 60, first.result.draftName);
  assert.ok(second.result.draftName.length <= 60, second.result.draftName);
  const suffixOf = (job, result) => `-r${result.sourceRevision}-${job.id.slice(0, 8)}`;
  assert.ok(first.result.draftName.endsWith(suffixOf(first.job, first.result)), first.result.draftName);
  assert.ok(second.result.draftName.endsWith(suffixOf(second.job, second.result)), second.result.draftName);
  assert.match(first.result.draftName, /^EAC /);
  assert.match(first.result.draftName, /-r\d+-[0-9a-f]{8}$/);
  assert.notEqual(first.result.draftName, second.result.draftName);
  const contentId = JSON.parse(await readFile(join(first.result.draftFolder, 'draft_content.json'), 'utf8')).id;
  const metaId = JSON.parse(await readFile(join(first.result.draftFolder, 'draft_meta_info.json'), 'utf8')).draft_id;
  const secondContentId = JSON.parse(await readFile(join(second.result.draftFolder, 'draft_content.json'), 'utf8')).id;
  assert.notEqual(contentId, secondContentId, 'draft content id must stay unique per job');
  assert.equal(contentId.length, 32);
  assert.equal(metaId.length, 32);
  assert.ok(first.result.draftFolder.length > 0);
  // Export metadata must not carry provider credentials either.
  assertNoSecrets(first.result, 'export result');
  const manifestPath = join(first.result.draftFolder, '..', '..', 'manifest.json');
  const manifestText = await readFile(manifestPath, 'utf8');
  assert.ok(manifestText.length > 0);
  assertNoSecrets(manifestText, 'export manifest');
}));

test('replacing the music bed clears old auto music credits and offset across all paths', () => setup(async (engine, dir) => {
  const first = await fixture(dir, 'first.wav');
  const second = await fixture(dir, 'second.wav');
  const video = await fixture(dir, 'video.mp4', 'video');
  const project = await engine.handle('project_create', { title: 'Music replacement', width: 160, height: 90, fps: 12 });
  await engine.handle('asset_import', { projectId: project.id, path: video });
  await engine.handle('asset_import', { projectId: project.id, path: first });
  await engine.handle('asset_import', { projectId: project.id, path: second });
  const planned = await engine.handle('timeline_plan', { projectId: project.id, duration: 0.5 });
  const wait = async (job) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const state = await engine.handle('job_status', { jobId: job.id });
      if (state.status === 'completed') return state.result;
      if (state.status === 'failed') assert.fail(state.error);
      await new Promise(done => setTimeout(done, 30));
    }
    assert.fail('Job did not finish');
  };
  const seeded = async (musicPath) => {
    const current = await engine.handle('project_get', { projectId: project.id });
    await engine.store.updateProject(project.id, (p) => {
      p.musicPath = musicPath;
      p.musicStart = 7;
      p.credits = [
        { type: 'music', text: 'Old auto music credit' },
        { type: 'video', text: 'Video credit' },
        { type: 'photo', text: 'Photo credit' },
      ];
    });
    return current.revision;
  };

  // compose replaces the bed and drops only the old music credit.
  await seeded(first);
  const composed = await wait(await engine.handle('job_submit', { projectId: project.id, type: 'compose', params: { duration: 1 } }));
  const afterCompose = await engine.handle('project_get', { projectId: project.id });
  assert.equal(afterCompose.musicPath, composed.path || afterCompose.musicPath);
  assert.equal(afterCompose.musicStart, 0);
  assert.deepEqual(afterCompose.credits, [{ type: 'video', text: 'Video credit' }, { type: 'photo', text: 'Photo credit' }]);

  // produce with a supplied music path replaces it too, even though it re-plans the timeline.
  const revision = await seeded(second);
  const produced = await wait(await engine.handle('job_submit', {
    projectId: project.id, type: 'produce', params: { paths: [video], musicPath: second, duration: 0.5, bpm: 100 },
  }));
  assert.ok(produced.path);
  const afterProduce = await engine.handle('project_get', { projectId: project.id });
  assert.equal(afterProduce.musicPath, second);
  assert.equal(afterProduce.musicStart, 0);
  assert.deepEqual(afterProduce.credits, [{ type: 'video', text: 'Video credit' }, { type: 'photo', text: 'Photo credit' }]);

  // timeline_update with an explicit new path clears offset/credits; unrelated edits keep them.
  const timelineRevision = (await engine.handle('project_get', { projectId: project.id })).revision;
  await engine.store.updateProject(project.id, (p) => {
    p.musicStart = 3;
    p.credits = [{ type: 'music', text: 'Old auto music credit' }, { type: 'video', text: 'Video credit' }];
  });
  const current = await engine.handle('project_get', { projectId: project.id });
  const kept = await engine.handle('timeline_update', { projectId: project.id, revision: current.revision, clips: current.clips, look: { exposure: 0.1 } });
  assert.equal(kept.musicStart, 3);
  assert.deepEqual(kept.credits, [{ type: 'music', text: 'Old auto music credit' }, { type: 'video', text: 'Video credit' }]);
  const replaced = await engine.handle('timeline_update', { projectId: project.id, revision: kept.revision, clips: kept.clips, musicPath: first });
  assert.equal(replaced.musicPath, first);
  assert.equal(replaced.musicStart, 0);
  assert.deepEqual(replaced.credits, [{ type: 'video', text: 'Video credit' }]);
  void revision; void timelineRevision;
}));

test('repeated stock music downloads replace the credit instead of appending it', () => setup(async (engine, dir) => {
  const audio = await fixture(dir, 'stock.wav');
  const bytes = await readFile(audio);
  await engine.settingsUpdate({ jamendoClientId: 'dummy-jamendo-client' });
  const project = await engine.handle('project_create', { title: 'Stock music replacement', width: 160, height: 90, fps: 12 });
  const video = await fixture(dir, 'video.mp4', 'video');
  await engine.handle('asset_import', { projectId: project.id, path: video });
  await engine.handle('timeline_plan', { projectId: project.id, duration: 0.5 });
  const wait = async (job) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const state = await engine.handle('job_status', { jobId: job.id });
      if (state.status === 'completed') return state.result;
      if (state.status === 'failed') assert.fail(state.error);
      await new Promise(done => setTimeout(done, 30));
    }
    assert.fail('Stock download did not finish');
  };
  const original = globalThis.fetch;
  // Mocked providers only: jamendo search/resolve JSON plus the direct audio bytes. No network.
  globalThis.fetch = async (url) => {
    const text = String(url);
    if (text.includes('api.jamendo.com')) {
      const id = new URL(text).searchParams.get('id') || 'track-a';
      return new Response(JSON.stringify({ results: [{
        id, name: `Mock Track ${id}`, artist_name: `Mock Artist ${id}`, duration: 1,
        license_ccurl: 'CC BY 4.0', shareurl: `https://example.test/${id}`,
        audiodownload: `https://example.test/${id}.mp3`,
      }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
  };
  try {
    await engine.store.updateProject(project.id, (p) => {
      p.credits = [{ type: 'video', text: 'Video credit' }];
      p.musicStart = 5;
    });
    const first = await wait(await engine.handle('job_submit', {
      projectId: project.id, type: 'stock-download', params: { provider: 'jamendo', kind: 'music', id: 'track-a', setAsMusic: true },
    }));
    assert.equal(first.item.id, 'track-a');
    const afterFirst = await engine.handle('project_get', { projectId: project.id });
    assert.equal(afterFirst.credits.filter((credit) => credit.type === 'music').length, 1);
    assert.equal(afterFirst.musicStart, 0, 'a new stock track resets the old offset');
    assert.match(afterFirst.credits.find((credit) => credit.type === 'music').text, /Mock Track track-a/);
    assert.deepEqual(afterFirst.credits.filter((credit) => credit.type !== 'music'), [{ type: 'video', text: 'Video credit' }]);

    await engine.store.updateProject(project.id, (p) => { p.musicStart = 9; });
    const second = await wait(await engine.handle('job_submit', {
      projectId: project.id, type: 'stock-download', params: { provider: 'jamendo', kind: 'music', id: 'track-b', setAsMusic: true },
    }));
    assert.equal(second.item.id, 'track-b');
    const afterSecond = await engine.handle('project_get', { projectId: project.id });
    const musicCredits = afterSecond.credits.filter((credit) => credit.type === 'music');
    assert.equal(musicCredits.length, 1, 'the previous auto credit is replaced, not appended');
    assert.match(musicCredits[0].text, /Mock Track track-b/);
    assert.ok(!JSON.stringify(afterSecond.credits).includes('track-a'));
    assert.equal(afterSecond.musicStart, 0);
    assert.equal(afterSecond.musicPath, second.assetPath);
    assert.deepEqual(afterSecond.credits.filter((credit) => credit.type !== 'music'), [{ type: 'video', text: 'Video credit' }]);

    // A composed bed replaces the stock track and its credit as well.
    const composed = await wait(await engine.handle('job_submit', { projectId: project.id, type: 'compose', params: { duration: 1 } }));
    const afterCompose = await engine.handle('project_get', { projectId: project.id });
    assert.equal(afterCompose.musicPath, composed.path);
    assert.equal(afterCompose.credits.filter((credit) => credit.type === 'music').length, 0);
    assert.deepEqual(afterCompose.credits, [{ type: 'video', text: 'Video credit' }]);
  } finally { globalThis.fetch = original; }
}));
