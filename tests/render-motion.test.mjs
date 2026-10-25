import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { renderTimeline, gradePreview, createScopes, probeMedia, qualityCheck } from '../src/media/index.mjs';
import { writeCubeLut } from '../src/media/grading.mjs';

async function fixture(args, path) {
  const child = spawn('ffmpeg', ['-hide_banner', '-y', '-loglevel', 'error', ...args, path], { windowsHide: true });
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
}
async function colorClip(path, color, { size = '160x90', rate = 12, duration = 2 } = {}) {
  await fixture(['-f', 'lavfi', '-i', `color=c=${color}:s=${size}:r=${rate}:d=${duration}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p'], path);
}
async function motionClip(path, duration = 2) {
  await fixture(['-f', 'lavfi', '-i', `testsrc2=s=160x90:r=12:d=${duration}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p'], path);
}
async function toneBed(path, duration = 2) {
  await fixture(['-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}`], path);
}
async function rawFrame(path, at, width, height) {
  const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(at), '-i', path,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true });
  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  const buffer = Buffer.concat(chunks);
  assert.ok(buffer.length >= width * height * 3, 'expected a full decodable frame');
  return buffer;
}
function pixelAt(buffer, width, x, y) {
  const offset = (y * width + x) * 3;
  return { r: buffer[offset], g: buffer[offset + 1], b: buffer[offset + 2] };
}

// Validation runs before any media probing, so these projects never touch the filesystem.
const dummyClip = (extra = {}) => ({ path: 'dummy.mp4', kind: 'video', start: 0, sourceIn: 0, duration: 1, ...extra });
const rejected = (project, directory) =>
  assert.rejects(renderTimeline({ project, outputPath: join(directory, 'out.mp4') }), TypeError);

test('renderTimeline rejects invalid speed values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-speed-invalid-'));
  try {
    for (const speed of [0.2, 5, 'fast', null]) {
      await rejected({ width: 96, height: 64, fps: 12, clips: [dummyClip({ speed })] }, directory);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('renderTimeline rejects invalid motion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-motion-invalid-'));
  try {
    for (const motion of [{ type: 'spin' }, { type: 'zoom-in', amount: 1.5 }, { type: 'zoom-in', amount: 'x' }, 'zoom-in']) {
      await rejected({ width: 96, height: 64, fps: 12, clips: [dummyClip({ motion })] }, directory);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('renderTimeline rejects invalid power windows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-window-invalid-'));
  try {
    const cases = [
      Array.from({ length: 5 }, () => ({ shape: 'circle', grading: {} })),
      [{ shape: 'oval', grading: {} }],
      [{ shape: 'circle' }],
      [{ shape: 'circle', grading: { exposure: 99 } }],
      [{ shape: 'circle', grading: {}, feather: 0.9 }],
      [{ shape: 'circle', grading: {}, radius: 0.01 }],
      [{ shape: 'rect', grading: {}, width: 5 }],
      'not-an-array',
    ];
    for (const windows of cases) {
      await rejected({ width: 96, height: 64, fps: 12, clips: [dummyClip({ windows })] }, directory);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('renderTimeline rejects invalid project polish controls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-polish-invalid-'));
  try {
    for (const extra of [{ fadeIn: 6 }, { fadeOut: 5.5 }, { musicStart: -1 }, { sharpen: 3 }, { vignette: 1.5 }]) {
      await rejected({ width: 96, height: 64, fps: 12, clips: [dummyClip()], ...extra }, directory);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('speed ramps change rendered duration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-speed-render-'));
  try {
    const clip = join(directory, 'gray.mp4');
    await colorClip(clip, '0x808080', { size: '96x64', duration: 2 });
    // speed 2 consumes 2s of source into a 1s slot; speed 0.5 slow-mo consumes 0.5s.
    for (const [speed, expected] of [[2, 1], [0.5, 1]]) {
      const project = { width: 96, height: 64, fps: 12, clips: [
        { path: clip, kind: 'video', start: 0, sourceIn: 0, duration: 1, volume: 0, track: 0, speed }] };
      const out = join(directory, `speed${speed}.mp4`);
      await renderTimeline({ project, outputPath: out });
      const media = await probeMedia(out);
      assert.ok(media.hasVideo);
      assert.ok(Math.abs(media.duration - expected) <= 0.2, `speed ${speed}: ${media.duration}s != ${expected}s`);
    }
    // A speed 2 clip demanding 2x the remaining source must be rejected.
    await assert.rejects(renderTimeline({ project: { width: 96, height: 64, fps: 12, clips: [
      { path: clip, kind: 'video', start: 1, sourceIn: 1.5, duration: 1, volume: 0, track: 0, speed: 2 }] },
      outputPath: join(directory, 'overrun.mp4') }), /exceeds source duration/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('zoom-in motion renders a decodable clip', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-motion-render-'));
  try {
    const clip = join(directory, 'motion-src.mp4');
    await motionClip(clip);
    const project = { width: 160, height: 90, fps: 12, clips: [
      { path: clip, kind: 'video', start: 0, sourceIn: 0, duration: 2, volume: 0, track: 0,
        motion: { type: 'zoom-in', amount: 0.25 } }] };
    const out = join(directory, 'zoom.mp4');
    await renderTimeline({ project, outputPath: out });
    const media = await probeMedia(out);
    assert.equal(media.width, 160);
    assert.equal(media.height, 90);
    const check = await qualityCheck({ path: out, expectedDuration: 2 });
    assert.equal(check.ok, true, check.errors.join('; '));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('pan motion renders a decodable clip', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-pan-render-'));
  try {
    const clip = join(directory, 'pan-src.mp4');
    await motionClip(clip);
    const project = { width: 160, height: 90, fps: 12, clips: [
      { path: clip, kind: 'video', start: 0, sourceIn: 0, duration: 2, volume: 0, track: 0,
        motion: { type: 'pan-left', amount: 0.2 } }] };
    const out = join(directory, 'pan.mp4');
    await renderTimeline({ project, outputPath: out });
    const check = await qualityCheck({ path: out, expectedDuration: 2 });
    assert.equal(check.ok, true, check.errors.join('; '));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('circle power window brightens only its region', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-window-render-'));
  try {
    const clip = join(directory, 'gray.mp4');
    await colorClip(clip, '0x404040', { duration: 2 });
    const project = { width: 160, height: 90, fps: 12, clips: [
      { path: clip, kind: 'video', start: 0, sourceIn: 0, duration: 1, volume: 0, track: 0,
        windows: [{ shape: 'circle', x: 0.5, y: 0.5, radius: 0.4, feather: 0.1, opacity: 1,
          grading: { exposure: 2 } }] }] };
    const out = join(directory, 'window.mp4');
    await renderTimeline({ project, outputPath: out });
    const check = await qualityCheck({ path: out });
    assert.equal(check.ok, true, check.errors.join('; '));
    // The window grade ships as its own grade0w0.cube; the pixel split below is the proof it
    // entered the graph (a global grade would lift the corners too).
    const frame = await rawFrame(out, 0.5, 160, 90);
    const center = pixelAt(frame, 160, 80, 45);
    const corner = pixelAt(frame, 160, 5, 5);
    assert.ok(center.r > 240, `expected the window center clipped bright, got ${center.r}`);
    assert.ok(Math.abs(corner.r - 64) < 12, `expected the corner untouched at ~64, got ${corner.r}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('chained rect and linear windows render', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-windows-chain-'));
  try {
    const clip = join(directory, 'motion-src.mp4');
    await motionClip(clip);
    const project = { width: 160, height: 90, fps: 12, clips: [
      { path: clip, kind: 'video', start: 0, sourceIn: 0, duration: 1, volume: 0, track: 0,
        windows: [
          { shape: 'rect', x: 0.3, y: 0.5, width: 0.5, height: 0.8, grading: { exposure: 1 } },
          { shape: 'linear', x: 0.5, y: 0.5, angle: 90, grading: { exposure: -0.5 } },
        ] }] };
    const out = join(directory, 'windows.mp4');
    await renderTimeline({ project, outputPath: out });
    const check = await qualityCheck({ path: out, expectedDuration: 1 });
    assert.equal(check.ok, true, check.errors.join('; '));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('fadeIn, fadeOut, musicStart, sharpen and vignette smoke render', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-polish-render-'));
  try {
    const clip = join(directory, 'motion-src.mp4');
    await motionClip(clip);
    const bed = join(directory, 'bed.wav');
    await toneBed(bed);
    const project = { width: 160, height: 90, fps: 12,
      fadeIn: 0.2, fadeOut: 0.4, musicStart: 0.5, sharpen: 0.8, vignette: 0.4,
      musicPath: bed,
      clips: [{ path: clip, kind: 'video', start: 0, sourceIn: 0, duration: 1.5, volume: 0, track: 0 }] };
    const out = join(directory, 'polish.mp4');
    await renderTimeline({ project, outputPath: out });
    const media = await probeMedia(out);
    assert.ok(media.hasVideo && media.hasAudio);
    assert.ok(Math.abs(media.duration - 1.5) <= 0.2, `duration ${media.duration}s != 1.5s`);
    const check = await qualityCheck({ path: out, expectedDuration: 1.5 });
    assert.equal(check.ok, true, check.errors.join('; '));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('createScopes writes a waveform/vectorscope sheet', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-scopes-'));
  try {
    const clip = join(directory, 'motion-src.mp4');
    await motionClip(clip);
    const out = join(directory, 'scopes.png');
    const result = await createScopes({ path: clip, outputPath: out });
    assert.equal(result.path, out);
    assert.match(result.layout.top, /Waveform/);
    assert.match(result.layout.bottom, /Vectorscope/);
    const size = (await stat(out)).size;
    assert.ok(size > 10000, `scopes png too small: ${size} bytes`);
    await assert.rejects(createScopes({ path: clip, outputPath: join(directory, 'scopes.jpg') }), TypeError);
    await assert.rejects(createScopes({ path: join(directory, 'missing.mp4'), outputPath: out }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('gradePreview samples speed ramps and skips night grades', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-night-preview-'));
  try {
    const clip = join(directory, 'gray.mp4');
    await colorClip(clip, '0x808080', { size: '96x64', duration: 2 });
    const project = { width: 96, height: 64, fps: 12, clips: [
      { path: clip, kind: 'video', start: 0, sourceIn: 0, duration: 1, volume: 0, track: 0, speed: 2 }] };
    const preview = await gradePreview({ project, outputPath: join(directory, 'speed.png'), framesPerClip: 2 });
    assert.equal(preview.frames.length, 2);
    // Sampling must multiply by speed: the second take probes 1.5s, not 0.75s.
    assert.equal(preview.frames[1].sourceTime, 1.5);

    const dark = join(directory, 'dark.mp4');
    await colorClip(dark, '0x202020', { duration: 2 });
    const nightProject = (grading) => ({ width: 96, height: 64, fps: 12, clips: [
      { path: dark, kind: 'video', start: 0, sourceIn: 0, duration: 1, volume: 0, track: 0, grading }] });
    const day = await gradePreview({ project: nightProject(null), outputPath: join(directory, 'day.png'), framesPerClip: 1 });
    assert.ok(day.warnings.some((warning) => warning.includes('偏暗')), 'expected the 偏暗 warning on a dark clip');
    const night = await gradePreview({
      project: nightProject({ exposure: -0.5 }), outputPath: join(directory, 'night.png'), framesPerClip: 1 });
    assert.equal(night.frames[0].mergedExposure, -0.5);
    assert.ok(!night.warnings.some((warning) => warning.includes('偏暗')), 'intentional night grade must not trip 偏暗');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
// --- Regression tests for the camera-input LUT, window/LUT interaction, preview parity
// and high-precision (16-bit) grade chain. Added before the implementation; the assertions
// below describe the intended contract.

async function previewPixels(path) {
  const probe = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path], { windowsHide: true });
  const probeChunks = [];
  probe.stdout.on('data', (chunk) => probeChunks.push(chunk));
  const [probeCode] = await once(probe, 'close');
  assert.equal(probeCode, 0);
  const [width, height] = Buffer.concat(probeChunks).toString('utf8').trim().split(',').map(Number);
  const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true });
  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  return { buffer: Buffer.concat(chunks), width, height };
}

test('clip.lut survives when the clip also has power windows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-window-lut-'));
  try {
    const clip = join(directory, 'gray.mp4');
    await colorClip(clip, '0x404040', { duration: 2 });
    // A red-gain look LUT: every pixel keeps its luma but red is pushed up.
    const lut = join(directory, 'red.cube');
    await writeCubeLut({ gain: { r: 1.6 } }, lut, { size: 17 });
    const project = { width: 160, height: 90, fps: 12, clips: [
      { path: clip, kind: 'video', start: 0, sourceIn: 0, duration: 1, volume: 0, track: 0, lut,
        windows: [{ shape: 'circle', x: 0.5, y: 0.5, radius: 0.4, feather: 0.1, opacity: 1,
          grading: { exposure: 2 } }] }] };
    const out = join(directory, 'window-lut.mp4');
    await renderTimeline({ project, outputPath: out });
    const frame = await rawFrame(out, 0.5, 160, 90);
    const center = pixelAt(frame, 160, 80, 45);
    const corner = pixelAt(frame, 160, 5, 5);
    // Base pixel 64 * 1.6 = 102 red: the corner proves clip.lut still runs in the window branch.
    assert.ok(corner.r > 88, `expected the look LUT red gain outside the window, got ${corner.r}`);
    assert.ok(Math.abs(corner.g - 64) < 12, `expected green untouched outside the window, got ${corner.g}`);
    assert.ok(center.r > 240, `expected the window center clipped bright, got ${center.r}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('gradePreview applies power windows exactly like the render', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-window-preview-'));
  try {
    const clip = join(directory, 'gray.mp4');
    await colorClip(clip, '0x404040', { duration: 2 });
    const project = { width: 160, height: 90, fps: 12, clips: [
      { path: clip, kind: 'video', start: 0, sourceIn: 0, duration: 1, volume: 0, track: 0, id: 'clip-window',
        windows: [{ shape: 'circle', x: 0.5, y: 0.5, radius: 0.4, feather: 0.1, opacity: 1,
          grading: { exposure: 2 } }] }] };
    const preview = await gradePreview({ project, outputPath: join(directory, 'preview.png'), framesPerClip: 1 });
    const sheet = await previewPixels(preview.path);
    // tile=2x1:padding=6:margin=6 => cells start at 6, the right column starts at 6+480+6.
    const left = 6 + 480 + 6;
    const top = 6;
    const center = pixelAt(sheet.buffer, sheet.width, left + 240, top + 135);
    const corner = pixelAt(sheet.buffer, sheet.width, left + 460, top + 10);
    assert.ok(center.r > 200, `expected the preview window center bright, got ${center.r}`);
    assert.ok(Math.abs(corner.r - 64) < 16, `expected the preview corner untouched at ~64, got ${corner.r}`);

    const out = join(directory, 'render.mp4');
    await renderTimeline({ project, outputPath: out });
    const frame = await rawFrame(out, 0.5, 160, 90);
    const rendered = pixelAt(frame, 160, 80, 45);
    assert.ok(Math.abs(rendered.r - center.r) < 40,
      `preview center ${center.r} should match render center ${rendered.r}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('clip.inputLut is applied before clip.lut and the parameter grade', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-inputlut-order-'));
  try {
    const clip = join(directory, 'gray.mp4');
    await colorClip(clip, '0x404040', { duration: 2 });
    // Camera input transform: crush red to zero. Legacy look LUT: red becomes full.
    const inputLut = join(directory, 'camera-input.cube');
    await writeCubeLut({ curves: { r: [[0, 0], [1, 0]] } }, inputLut, { size: 17 });
    const lookLut = join(directory, 'look.cube');
    await writeCubeLut({ curves: { r: [[0, 1], [1, 1]] } }, lookLut, { size: 17 });
    const project = { width: 96, height: 64, fps: 12, clips: [
      { path: clip, kind: 'video', start: 0, sourceIn: 0, duration: 1, volume: 0, track: 0,
        inputLut, lut: lookLut, grading: { offset: 0.2 } }] };
    const out = join(directory, 'inputlut.mp4');
    await renderTimeline({ project, outputPath: out });
    const frame = await rawFrame(out, 0.5, 96, 64);
    const pixel = pixelAt(frame, 96, 48, 32);
    // inputLut first zeroes red, the look LUT then lifts red to full, and the grade offset clamps it.
    // The reverse order would leave red near 0.2 * 255 = 51 instead of 255.
    assert.ok(pixel.r > 240, `expected red driven to full by the LUT order, got ${pixel.r}`);
    assert.ok(pixel.g > 100 && pixel.g < 130, `expected green offset to ~115, got ${pixel.g}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('clip.inputLut and clip.lut are validated as local .cube files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-inputlut-invalid-'));
  try {
    for (const key of ['inputLut', 'lut']) {
      for (const value of [42, 'missing.cube', join(directory, 'not-a-lut.txt')]) {
        await rejected({ width: 96, height: 64, fps: 12, clips: [dummyClip({ [key]: value })] }, directory);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('gradePreview frames carry a stable clipId next to clipIndex', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-preview-clipid-'));
  try {
    const clip = join(directory, 'gray.mp4');
    await colorClip(clip, '0x808080', { duration: 2 });
    const project = { width: 96, height: 64, fps: 12, clips: [
      { path: clip, kind: 'video', start: 0, sourceIn: 0, duration: 1, volume: 0, track: 0, id: 'shot-a' },
      { path: clip, kind: 'video', start: 1, sourceIn: 1, duration: 1, volume: 0, track: 0 }] };
    const preview = await gradePreview({ project, outputPath: join(directory, 'ids.png'), framesPerClip: 1 });
    assert.equal(preview.frames[0].clipId, 'shot-a');
    assert.equal(preview.frames[1].clipId, '1', 'clips without an id fall back to their stable index');
    assert.equal(preview.frames[0].clipIndex, 0);
    assert.equal(preview.frames[1].clipIndex, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('grading a 10-bit source keeps more than 8-bit input precision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-10bit-grade-'));
  try {
    const clip = join(directory, 'ramp10.mp4');
    // 100 distinct 10-bit luma codes; only ~25 distinct 8-bit codes, so an 8-bit input to a
    // steep curve bands visibly while a 16-bit input keeps the ramp smooth.
    await fixture(['-f', 'lavfi', '-i', 'nullsrc=s=256x16:r=5:d=1,format=yuv420p10le,' +
      "geq=lum='250+100*X/255':cb=512:cr=512", '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv420p10le'], clip);
    const project = { width: 256, height: 16, fps: 5, clips: [
      { path: clip, kind: 'video', start: 0, sourceIn: 0, duration: 0.8, volume: 0, track: 0,
        grading: { curves: { master: [[0, 0], [0.2, 0.02], [0.3, 0.95], [1, 1]] } } }] };
    const out = join(directory, 'graded.mp4');
    await renderTimeline({ project, outputPath: out });
    const frame = await rawFrame(out, 0.4, 256, 16);
    const levels = new Set();
    for (let x = 0; x < 256; x++) levels.add(pixelAt(frame, 256, x, 8).r);
    assert.ok(levels.size >= 60,
      `expected a smooth 16-bit-graded ramp (>=60 levels), got ${levels.size} levels`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
