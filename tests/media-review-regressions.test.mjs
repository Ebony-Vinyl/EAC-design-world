import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { renderTimeline, gradePreview } from '../src/media/index.mjs';

// Regression tests for the confirmed review findings: RGB (not YUV) glow blending, one preview
// aspect for both comparison columns, motion-aware preview sampling with identical framing on
// both sides, paired per-frame clipping guardrails, and output parent creation.
// Fixtures are tiny lavfi clips generated at test time; no binary assets are stored in the repo.

async function fixture(args, path) {
  const child = spawn('ffmpeg', ['-hide_banner', '-y', '-loglevel', 'error', ...args, path], { windowsHide: true });
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
}

// The source options belong to the color filter; extra drawbox filters follow it.
async function clip(path, { color = '0x808080', drawbox, size = '160x90', rate = 12, duration = 2 } = {}) {
  const graph = `color=c=${color}:s=${size}:r=${rate}:d=${duration}${drawbox ? `,drawbox=${drawbox}` : ''}`;
  await fixture(['-f', 'lavfi', '-i', graph, '-c:v', 'libx264', '-pix_fmt', 'yuv420p'], path);
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

async function pngPixels(path) {
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

function luma(buffer, width, x, y) {
  const offset = (y * width + x) * 3;
  return 0.2126 * buffer[offset] + 0.7152 * buffer[offset + 1] + 0.0722 * buffer[offset + 2];
}

// Horizontal centroid of bright pixels inside one tile cell (x offset relative to the cell).
function stripeCentroid(buffer, width, cellX, cellY, cellWidth, cellHeight, threshold = 200) {
  let sum = 0;
  let count = 0;
  for (let y = cellY + 10; y < cellY + cellHeight - 10; y += 2) {
    for (let x = cellX; x < cellX + cellWidth; x++) {
      if (luma(buffer, width, x, y) <= threshold) continue;
      sum += x - cellX;
      count++;
    }
  }
  return count ? sum / count : null;
}

test('glow blends in RGB so a neutral gray stays neutral', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-glow-neutral-'));
  try {
    const source = join(directory, 'gray.mp4');
    await clip(source);
    const project = { width: 160, height: 90, fps: 12, glow: 0.4, clips: [
      { path: source, kind: 'video', start: 0, sourceIn: 0, duration: 1, volume: 0, track: 0 }] };
    const out = join(directory, 'glow.mp4');
    await renderTimeline({ project, outputPath: out });
    const frame = await rawFrame(out, 0.5, 160, 90);
    const pixel = pixelAt(frame, 160, 80, 45);
    const spread = Math.max(pixel.r, pixel.g, pixel.b) - Math.min(pixel.r, pixel.g, pixel.b);
    // The YUV screen blend produced RGB ~168,126,175 (spread 49) on a neutral gray.
    assert.ok(spread <= 3, `glow tinted a neutral gray: rgb(${pixel.r},${pixel.g},${pixel.b})`);
    // RGB screen of 128 with its own blur at 0.24 opacity lands near 143, clearly above the input.
    assert.ok(pixel.r >= 132 && pixel.r <= 155, `unexpected RGB glow level ${pixel.r}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('gradePreview shares the project aspect and tile size between both columns', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-preview-aspect-'));
  try {
    // Landscape 16:9, 4:3 and portrait must all fit inside a bounded 480x270 cell box while
    // keeping the project aspect, so the original and graded columns have identical dimensions.
    for (const { size, expected } of [
      { size: '160x90', expected: [480, 270] },
      { size: '160x120', expected: [360, 270] },
      { size: '90x160', expected: [152, 270] },
    ]) {
      const [width, height] = size.split('x').map(Number);
      const source = join(directory, `gray-${size}.mp4`);
      await clip(source, { size, duration: 1 });
      const project = { width, height, fps: 12, clips: [
        { path: source, kind: 'video', start: 0, sourceIn: 0, duration: 0.8, volume: 0, track: 0,
          grading: { exposure: 0.2 } }] };
      const preview = await gradePreview({
        project, outputPath: join(directory, `aspect-${size}.png`), framesPerClip: 2 });
      const sheet = await pngPixels(preview.path);
      const [cellWidth, cellHeight] = expected;
      // tile=2x2:padding=6:margin=6.
      assert.equal(sheet.width, cellWidth * 2 + 18, `${size}: sheet width must use one shared cell size`);
      assert.equal(sheet.height, cellHeight * 2 + 18, `${size}: sheet height must use one shared cell size`);
      assert.ok(cellWidth <= 480 && cellHeight <= 270, `${size}: preview cells must stay bounded`);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('gradePreview applies motion at the sampled time with identical framing on both sides', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-preview-motion-'));
  try {
    // A bright vertical stripe near the left edge; pan-right moves it left inside the crop window.
    const source = join(directory, 'stripe.mp4');
    await clip(source, { drawbox: 'x=40:y=0:w=8:h=90:color=0xFFFFFF:t=fill', duration: 2 });
    const project = { width: 160, height: 90, fps: 12, clips: [
      { path: source, kind: 'video', start: 0, sourceIn: 0, duration: 2, volume: 0, track: 0,
        motion: { type: 'pan-right', amount: 0.2 }, grading: { exposure: 0.2 } }] };
    const preview = await gradePreview({
      project, outputPath: join(directory, 'motion.png'), framesPerClip: 3 });
    assert.equal(preview.frames[1].sourceTime, 1);
    const sheet = await pngPixels(preview.path);
    const cellWidth = 480;
    const cellHeight = 270;
    const leftX = 6;
    const rightX = 6 + cellWidth + 6;
    // Row 2 (frames[1]) is the t=1.0s sample.
    const top = 6 + cellHeight + 6;
    const original = stripeCentroid(sheet.buffer, sheet.width, leftX, top, cellWidth, cellHeight);
    const graded = stripeCentroid(sheet.buffer, sheet.width, rightX, top, cellWidth, cellHeight);
    assert.ok(original !== null && graded !== null, 'expected the stripe in both columns');
    assert.ok(Math.abs(original - graded) <= 4,
      `original and graded framing differ: ${original} vs ${graded}`);
    // At t=1.0s of a 2s pan-right, crop x=(160-128)*0.5=16, so the stripe lands near x=103.
    // Without motion (or at t=0) it would sit near x=130/163 instead.
    assert.ok(Math.abs(original - 103) <= 12,
      `preview did not apply the sampled motion phase: stripe at ${original}, expected ~103`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('gradePreview motion framing matches the rendered film at the same time', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-preview-render-parity-'));
  try {
    const source = join(directory, 'stripe.mp4');
    await clip(source, { drawbox: 'x=40:y=0:w=8:h=90:color=0xFFFFFF:t=fill', duration: 2 });
    const project = { width: 160, height: 90, fps: 12, clips: [
      { path: source, kind: 'video', start: 0, sourceIn: 0, duration: 2, volume: 0, track: 0,
        motion: { type: 'pan-right', amount: 0.2 }, grading: { exposure: 0.2 } }] };
    const out = join(directory, 'render.mp4');
    await renderTimeline({ project, outputPath: out });
    const frame = await rawFrame(out, 1, 160, 90);
    const rendered = stripeCentroid(frame, 160, 0, 0, 160, 90);
    assert.ok(rendered !== null, 'expected the stripe in the rendered frame');
    const preview = await gradePreview({
      project, outputPath: join(directory, 'preview.png'), framesPerClip: 3 });
    const sheet = await pngPixels(preview.path);
    const cellWidth = 480;
    const cellHeight = 270;
    const top = 6 + cellHeight + 6;
    const previewOriginal = stripeCentroid(sheet.buffer, sheet.width, 6, top, cellWidth, cellHeight);
    assert.ok(previewOriginal !== null, 'expected the stripe in the preview');
    // The preview cell is 3x the project width, so the same normalized framing scales by 3.
    assert.ok(Math.abs(previewOriginal - rendered * 3) <= 8,
      `preview framing ${previewOriginal} does not match the render ${rendered} x3 = ${rendered * 3}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('gradePreview applies pan motion to still images on both sides', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-preview-image-motion-'));
  try {
    const source = join(directory, 'stripe.png');
    await fixture(['-f', 'lavfi', '-i', 'color=c=0x808080:s=160x90,drawbox=x=40:y=0:w=8:h=90:color=0xFFFFFF:t=fill',
      '-frames:v', '1'], source);
    const project = { width: 160, height: 90, fps: 12, clips: [
      { path: source, kind: 'image', start: 0, sourceIn: 0, duration: 2, volume: 0, track: 0,
        motion: { type: 'pan-right', amount: 0.2 }, grading: { exposure: 0.2 } }] };
    const preview = await gradePreview({ project, outputPath: join(directory, 'image.png') });
    const sheet = await pngPixels(preview.path);
    const cellWidth = 480;
    const cellHeight = 270;
    const original = stripeCentroid(sheet.buffer, sheet.width, 6, 6, cellWidth, cellHeight);
    const graded = stripeCentroid(sheet.buffer, sheet.width, 6 + cellWidth + 6, 6, cellWidth, cellHeight);
    assert.ok(original !== null && graded !== null, 'expected the stripe in both columns');
    assert.ok(Math.abs(original - graded) <= 4,
      `image original and graded framing differ: ${original} vs ${graded}`);
    // Image samples represent the clip start (phase 0), where crop x=0 -> stripe near x=163;
    // with no motion it would be near x=130.
    assert.ok(Math.abs(original - 163) <= 12,
      `image preview skipped motion: stripe at ${original}, expected ~163`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('guardrails compare paired frames so an existing highlight cannot hide a new one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-guard-highlight-'));
  try {
    // Clip A already clips ~10% of its pixels in the original; its grade is absent, so its graded
    // frame clips the same 10%. Clip B starts clean but a 5% bright patch clips after +1 stop.
    const existing = join(directory, 'existing.mp4');
    await clip(existing, { drawbox: 'x=0:y=0:w=iw/5:h=ih/2:color=0xFFFFFF:t=fill', duration: 1 });
    const fresh = join(directory, 'fresh.mp4');
    await clip(fresh, { color: '0x707070', drawbox: 'x=0:y=0:w=iw/5:h=ih/4:color=0xB4B4B4:t=fill', duration: 1 });
    const project = { width: 160, height: 90, fps: 12, clips: [
      { path: existing, kind: 'video', start: 0, sourceIn: 0, duration: 0.8, volume: 0, track: 0, id: 'existing' },
      { path: fresh, kind: 'video', start: 0.8, sourceIn: 0, duration: 0.8, volume: 0, track: 0, id: 'fresh',
        grading: { exposure: 1 } }] };
    const preview = await gradePreview({ project, outputPath: join(directory, 'pair.png'), framesPerClip: 1 });
    const [a, b] = preview.frames;
    assert.ok(a.original.highlightClip > 0.08, `fixture A should already clip, got ${a.original.highlightClip}`);
    assert.ok(Math.abs(a.graded.highlightClip - a.original.highlightClip) < 0.01,
      'fixture A grade must leave its existing highlight unchanged');
    assert.ok(b.original.highlightClip < 0.005, `fixture B should start clean, got ${b.original.highlightClip}`);
    assert.ok(b.graded.highlightClip - b.original.highlightClip > 0.02,
      `fixture B should newly clip ~5%, got ${b.graded.highlightClip} - ${b.original.highlightClip}`);
    assert.ok(preview.warnings.some((warning) => warning.includes('高光') && warning.includes('新增')),
      `expected a paired highlight warning, got ${JSON.stringify(preview.warnings)}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('guardrails compare paired frames so an existing shadow crush cannot hide a new one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-guard-shadow-'));
  try {
    const existing = join(directory, 'existing.mp4');
    await clip(existing, { drawbox: 'x=0:y=0:w=iw/5:h=ih/2:color=0x000000:t=fill', duration: 1 });
    const fresh = join(directory, 'fresh.mp4');
    await clip(fresh, { color: '0x505050', drawbox: 'x=0:y=0:w=iw/5:h=ih/4:color=0x101010:t=fill', duration: 1 });
    const project = { width: 160, height: 90, fps: 12, clips: [
      { path: existing, kind: 'video', start: 0, sourceIn: 0, duration: 0.8, volume: 0, track: 0, id: 'existing' },
      { path: fresh, kind: 'video', start: 0.8, sourceIn: 0, duration: 0.8, volume: 0, track: 0, id: 'fresh',
        grading: { exposure: -2 } }] };
    const preview = await gradePreview({ project, outputPath: join(directory, 'pair.png'), framesPerClip: 1 });
    const [a, b] = preview.frames;
    assert.ok(a.original.shadowCrush > 0.08, `fixture A should already crush, got ${a.original.shadowCrush}`);
    assert.ok(b.graded.shadowCrush - b.original.shadowCrush > 0.02,
      `fixture B should newly crush ~5%, got ${b.graded.shadowCrush} - ${b.original.shadowCrush}`);
    assert.ok(preview.warnings.some((warning) => warning.includes('暗部') && warning.includes('新增')),
      `expected a paired shadow warning, got ${JSON.stringify(preview.warnings)}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('gradePreview creates the output parent directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-preview-parent-'));
  try {
    const source = join(directory, 'gray.mp4');
    await clip(source, { duration: 1 });
    const project = { width: 96, height: 64, fps: 12, clips: [
      { path: source, kind: 'video', start: 0, sourceIn: 0, duration: 0.8, volume: 0, track: 0,
        grading: { exposure: 0.2 } }] };
    const out = join(directory, 'nested', 'deeper', 'sheet.png');
    const preview = await gradePreview({ project, outputPath: out, framesPerClip: 1 });
    assert.equal(preview.path, out);
    assert.ok((await stat(out)).size > 1000);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
