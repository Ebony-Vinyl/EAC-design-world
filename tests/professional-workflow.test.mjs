import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createEngine } from '../src/engine.mjs';
import { startServer } from '../src/server.mjs';

const cube = 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';
async function setup(fn, source = 'testsrc2=s=160x90:r=12:d=2') {
  const dir = await mkdtemp(join(tmpdir(), 'eac-professional-'));
  const engine = await createEngine({ dataDir: dir });
  try {
    const path = join(dir, 'source.mp4');
    const fixture = spawnSync('ffmpeg', ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', source, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path], { windowsHide: true });
    assert.equal(fixture.status, 0, fixture.stderr?.toString());
    const project = await engine.handle('project_create', { title: 'Professional workflow', width: 160, height: 90, fps: 12 });
    await engine.handle('asset_import', { projectId: project.id, path });
    const planned = await engine.handle('timeline_plan', { projectId: project.id, duration: 1 });
    return await fn({ engine, dir, planned });
  } finally { await engine.close(); await rm(dir, { recursive: true, force: true }); }
}

test('timeline validates camera and creative LUT files before saving any changes', () => setup(async ({ engine, dir, planned }) => {
  const inputLut = join(dir, 'camera.cube');
  const lut = join(dir, 'creative.cube');
  await writeFile(inputLut, cube);
  await writeFile(lut, cube);
  const valid = await engine.handle('timeline_update', { projectId: planned.id, revision: planned.revision, clips: [{ ...planned.clips[0], inputLut, lut }] });
  assert.equal(valid.clips[0].inputLut, await realpath(inputLut));
  await writeFile(inputLut, 'LUT_3D_SIZE 2\n0 0 0\n');
  for (const patch of [{ inputLut }, { lut: join(dir, 'missing.cube') }]) {
    await assert.rejects(engine.handle('timeline_update', { projectId: valid.id, revision: valid.revision, clips: [{ ...planned.clips[0], ...patch }] }), /LUT|cube|不存在|ENOENT/i);
    assert.equal((await engine.handle('project_get', { projectId: valid.id })).revision, valid.revision);
  }
}));

test('timeline keeps captions for a grade-only edit and can explicitly remove the music bed', () => setup(async ({ engine, planned }) => {
  const captions = [{ start: 0, end: 0.5, text: 'Preserve the subtitle.' }];
  const captioned = await engine.handle('timeline_update', { projectId: planned.id, revision: planned.revision, clips: planned.clips, captions });
  await engine.store.updateProject(planned.id, (p) => { p.musicPath = '/old/music.wav'; p.musicStart = 10; p.credits = [{ type: 'music', text: 'Old song' }, { type: 'video', text: 'Video credit' }]; });
  const current = await engine.handle('project_get', { projectId: planned.id });
  const graded = await engine.handle('timeline_update', { projectId: planned.id, revision: current.revision, clips: captioned.clips, look: { exposure: 0.2 }, musicPath: null });
  assert.deepEqual(graded.captions, captions);
  assert.equal(graded.musicPath, undefined);
  assert.equal(graded.musicStart, 0);
  assert.deepEqual(graded.credits, [{ type: 'video', text: 'Video credit' }]);
}));

test('timeline rejects duplicate clip IDs and fractional tracks before saving', () => setup(async ({ engine, planned }) => {
  for (const clips of [
    [{ ...planned.clips[0], id: 'same' }, { ...planned.clips[0], id: 'same', start: 1 }],
    [{ ...planned.clips[0], track: 0.5 }],
  ]) await assert.rejects(engine.handle('timeline_update', { projectId: planned.id, revision: planned.revision, clips }), /ID|轨道|track/);
  assert.equal((await engine.handle('project_get', { projectId: planned.id })).revision, planned.revision);
}));

test('timeline rejects invalid window geometry without advancing the revision', () => setup(async ({ engine, planned }) => {
  for (const windows of ['invalid', [{ shape: 'circle', x: 2, grading: {} }], [{ shape: 'rect', width: -1, grading: {} }], [{ shape: 'linear', opacity: 3, grading: {} }]]) {
    await assert.rejects(engine.handle('timeline_update', { projectId: planned.id, revision: planned.revision, clips: [{ ...planned.clips[0], windows }] }), /蒙版|窗口/);
  }
  assert.equal((await engine.handle('project_get', { projectId: planned.id })).revision, planned.revision);
}));

test('AI color workflow saves and restores grades without changing the edit and rejects stale writes', () => setup(async ({ engine, planned }) => {
  const graded = await engine.handle('timeline_update', { projectId: planned.id, revision: planned.revision, clips: planned.clips, look: { exposure: 0.25 } });
  const saved = await engine.handle('color_workflow', { projectId: planned.id, revision: graded.revision, action: 'save-version', name: 'Balanced' });
  assert.equal(saved.gradeVersions.length, 1);
  assert.equal(saved.gradeVersions[0].name, 'Balanced');
  const changed = await engine.handle('timeline_update', { projectId: planned.id, revision: saved.revision, clips: [{ ...saved.clips[0], duration: 0.5 }], look: { exposure: -0.3 } });
  const restored = await engine.handle('color_workflow', { projectId: planned.id, revision: changed.revision, action: 'restore-version', versionId: saved.gradeVersions[0].id });
  assert.equal(restored.look.exposure, 0.25);
  assert.equal(restored.clips[0].duration, 0.5);
  await assert.rejects(engine.handle('color_workflow', { projectId: planned.id, revision: changed.revision, action: 'save-version', name: 'Stale' }), /修改|修订/);
  assert.equal((await engine.handle('project_get', { projectId: planned.id })).gradeVersions.length, 1);
  const app = await startServer({ engine, port: 0 });
  try {
    const response = await fetch(`${app.url}/api/projects/${planned.id}/color`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: restored.revision, action: 'save-version', name: 'From HTTP' }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).gradeVersions.length, 2);
  } finally { await app.close(); }
}));

test('repeated exports never replace a draft that a human has already edited', () => setup(async ({ engine, dir, planned }) => {
  const draftRoot = join(dir, 'drafts');
  await engine.settingsUpdate({ jianyingDraftRoot: draftRoot });
  const exported = async () => {
    const job = await engine.handle('job_submit', { projectId: planned.id, type: 'export', params: { targets: ['jianying'] } });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const state = await engine.handle('job_status', { jobId: job.id });
      if (state.status === 'completed') return state.result;
      if (state.status === 'failed') assert.fail(state.error);
      await new Promise((done) => setTimeout(done, 30));
    }
    assert.fail('Export did not finish');
  };
  const first = await exported();
  assert.ok(first.jianYingDraftInstalled);
  const path = join(first.jianYingDraftInstalled, 'draft_content.json');
  const firstDraftId = JSON.parse(await readFile(path, 'utf8')).id;
  await writeFile(path, '{"humanEdited":true}');
  const second = await exported();
  assert.ok(second.jianYingDraftInstalled);
  assert.notEqual(second.jianYingDraftInstalled, first.jianYingDraftInstalled);
  assert.notEqual(JSON.parse(await readFile(join(second.jianYingDraftInstalled, 'draft_content.json'), 'utf8')).id, firstDraftId);
  assert.equal(await readFile(path, 'utf8'), '{"humanEdited":true}');
}));

test('AI shot matching refuses absent or outdated grading previews', () => setup(async ({ engine, planned }) => {
  await assert.rejects(engine.handle('color_workflow', { projectId: planned.id, action: 'match-shots', referenceClipId: planned.clips[0].id }), /预览/);
  await engine.store.updateProject(planned.id, (p) => { p.lastGradePreview = { frames: [], signature: 'stale' }; });
  await assert.rejects(engine.handle('color_workflow', { projectId: planned.id, action: 'match-shots', referenceClipId: planned.clips[0].id }), /预览|过时/);
}));

test('fresh measured previews are usable by the AI matching tool and become stale after a grade edit', () => setup(async ({ engine, planned }) => {
  const submitted = await engine.handle('job_submit', { projectId: planned.id, type: 'grade-preview', params: { framesPerClip: 2 } });
  const deadline = Date.now() + 20000;
  let completed;
  while (Date.now() < deadline) {
    const state = await engine.handle('job_status', { jobId: submitted.id });
    if (state.status === 'completed') { completed = state; break; }
    if (state.status === 'failed') assert.fail(state.error);
    await new Promise((done) => setTimeout(done, 30));
  }
  assert.ok(completed, 'Grading preview should finish');
  assert.equal(completed.result.frames[0].clipId, planned.clips[0].id);
  const match = await engine.handle('color_workflow', { projectId: planned.id, action: 'match-shots', referenceClipId: planned.clips[0].id });
  assert.equal(match.method, 'measured-graded-luma');
  const current = await engine.handle('project_get', { projectId: planned.id });
  await engine.handle('timeline_update', { projectId: planned.id, revision: current.revision, clips: current.clips, look: { exposure: -0.1 } });
  await assert.rejects(engine.handle('color_workflow', { projectId: planned.id, action: 'match-shots', referenceClipId: planned.clips[0].id }), /预览.*过时/);
}, 'color=c=0x808080:s=160x90:r=12:d=2'));

test('approved export files support safe attachment downloads and HEAD requests', () => setup(async ({ engine }) => {
  const path = join(engine.store.state.settings.outputRoot, 'test', '续剪工程.xml');
  await mkdir(join(engine.store.state.settings.outputRoot, 'test'), { recursive: true });
  await writeFile(path, '<xmeml version="4"/>');
  const app = await startServer({ engine, port: 0 });
  try {
    const url = `${app.url}/api/files?path=${encodeURIComponent(path)}&download=1`;
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition') || '', /^attachment;/);
    assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''/);
    assert.equal(await response.text(), await readFile(path, 'utf8'));
    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const blocked = await fetch(`${app.url}/api/files?path=${encodeURIComponent(engine.store.file)}&download=1`);
    assert.equal(blocked.status, 403);
  } finally { await app.close(); }
}));
