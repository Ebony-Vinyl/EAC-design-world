import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createEngine } from '../src/engine.mjs';
import { renderTimeline, gradePreview } from '../src/media/index.mjs';

async function setup(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'eac-landscape-'));
  const engine = await createEngine({ dataDir: directory });
  try { return await fn(engine, directory); }
  finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
}
async function fixture(args, path) {
  const child = spawn('ffmpeg', ['-hide_banner', '-y', '-loglevel', 'error', ...args, path], { windowsHide: true });
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
}
async function grayClip(path) {
  await fixture(['-f', 'lavfi', '-i', 'color=c=0x808080:s=96x64:r=12:d=1.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'], path);
}
async function rawFrame(path, at = 0.5) {
  const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(at), '-i', path,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true });
  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  return Buffer.concat(chunks);
}
async function finished(engine, id) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const job = await engine.handle('job_status', { jobId: id });
    if (!['queued', 'running'].includes(job.status)) return job;
    await new Promise((done) => setTimeout(done, 40));
  }
  throw new Error('Job deadline exceeded');
}

test('renderTimeline bakes grading into the output pixels', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-grade-render-'));
  try {
    const clip = join(directory, 'gray.mp4');
    await grayClip(clip);
    const base = { width: 96, height: 64, fps: 12, clips: [{ path: clip, kind: 'video', start: 0, sourceIn: 0, duration: 1, volume: 0, track: 0 }] };
    const plain = join(directory, 'plain.mp4');
    const warm = join(directory, 'warm.mp4');
    await renderTimeline({ project: base, outputPath: plain });
    await renderTimeline({ project: { ...base, look: { preset: 'clean-landscape', temperature: 0.5, exposure: 0 } }, outputPath: warm });
    const plainFrame = rawFrameSync(await rawFrame(plain));
    const warmFrame = rawFrameSync(await rawFrame(warm));
    // A warm grade on neutral gray must raise red and lower blue measurably.
    assert.ok(warmFrame.r > plainFrame.r + 4, `expected red to rise: ${plainFrame.r} -> ${warmFrame.r}`);
    assert.ok(warmFrame.b < plainFrame.b - 2, `expected blue to drop: ${plainFrame.b} -> ${warmFrame.b}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function rawFrameSync(buffer) {
  let r = 0, g = 0, b = 0;
  const pixels = buffer.length / 3;
  for (let i = 0; i < buffer.length; i += 3) { r += buffer[i]; g += buffer[i + 1]; b += buffer[i + 2]; }
  return { r: r / pixels, g: g / pixels, b: b / pixels };
}

test('renderTimeline rejects out-of-range grading parameters', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-grade-invalid-'));
  try {
    const clip = join(directory, 'gray.mp4');
    await grayClip(clip);
    const project = { width: 96, height: 64, fps: 12, clips: [{ path: clip, kind: 'video', start: 0, sourceIn: 0, duration: 1, volume: 0, track: 0, grading: { exposure: 5 } }] };
    await assert.rejects(renderTimeline({ project, outputPath: join(directory, 'out.mp4') }), /exposure|调色|参数/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('gradePreview emits a real comparison sheet with guardrail stats', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-grade-preview-'));
  try {
    const clip = join(directory, 'gray.mp4');
    await grayClip(clip);
    const project = { width: 96, height: 64, fps: 12, clips: [
      { path: clip, kind: 'video', start: 0, sourceIn: 0, duration: 1, volume: 0, track: 0, grading: { preset: 'golden-hour', saturation: -1 } }] };
    const sheet = join(directory, 'grade.png');
    const result = await gradePreview({ project, outputPath: sheet, framesPerClip: 2 });
    assert.equal(result.path, sheet);
    assert.equal(result.layout.columns, 2);
    assert.equal(result.gradedApplied, true);
    assert.ok(result.frames.length >= 2);
    const frame = result.frames[0];
    for (const side of ['original', 'graded']) {
      assert.ok(Number.isFinite(frame[side].lumaAvg));
      assert.ok(frame[side].lumaMin <= frame[side].lumaMax);
      assert.ok(frame[side].saturationAvg >= 0 && frame[side].saturationAvg <= 1);
    }
    // A desaturated grade must measure lower saturation than the original gray clip decode.
    assert.ok(frame.graded.saturationAvg <= frame.original.saturationAvg + 0.02);
    assert.ok(Array.isArray(result.warnings));
    const plain = await gradePreview({ project: { ...project, clips: [{ ...project.clips[0], grading: null }] }, outputPath: join(directory, 'plain.png'), framesPerClip: 1 });
    assert.equal(plain.gradedApplied, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('timeline_update persists look and per-clip grading and rejects invalid values', () => setup(async (engine, dir) => {
  const path = join(dir, 'source.mp4');
  await fixture(['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=12:d=1.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'], path);
  const project = await engine.handle('project_create', { title: 'Grading flow', width: 160, height: 90, fps: 12 });
  await engine.handle('asset_import', { projectId: project.id, path });
  const planned = await engine.handle('timeline_plan', { projectId: project.id, duration: 1 });
  const graded = await engine.handle('timeline_update', {
    projectId: project.id, revision: planned.revision,
    clips: [{ ...planned.clips[0], grading: { preset: 'teal-orange', exposure: 0.2 } }],
    look: { preset: 'clean-landscape' },
  });
  assert.equal(graded.look.preset, 'clean-landscape');
  assert.equal(graded.clips[0].grading.preset, 'teal-orange');
  await assert.rejects(engine.handle('timeline_update', {
    projectId: project.id, revision: graded.revision,
    clips: [{ ...graded.clips[0], grading: { exposure: 9 } }],
  }), /调色参数无效/);
  await assert.rejects(engine.handle('timeline_update', {
    projectId: project.id, revision: graded.revision,
    clips: graded.clips, look: { saturation: 42 },
  }), /look 无效/);
}));

test('grade-preview job stores the review sheet on the project', () => setup(async (engine, dir) => {
  const path = join(dir, 'source.mp4');
  await fixture(['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=12:d=1.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'], path);
  const project = await engine.handle('project_create', { title: 'Preview job', width: 160, height: 90, fps: 12 });
  await engine.handle('asset_import', { projectId: project.id, path });
  await engine.handle('timeline_plan', { projectId: project.id, duration: 1 });
  const submitted = await engine.handle('job_submit', { projectId: project.id, type: 'grade-preview', params: { framesPerClip: 2 } });
  const job = await finished(engine, submitted.id);
  assert.equal(job.status, 'completed', job.error);
  assert.ok(job.result.path.endsWith('.png'));
  assert.ok(job.result.frames.length >= 2);
  const stored = await engine.handle('project_get', { projectId: project.id });
  assert.equal(stored.lastGradePreview.path, job.result.path);
  assert.ok(Array.isArray(stored.lastGradePreview.warnings));
}));
