import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { cleanupStaging } from '../src/media/index.mjs';
import { createReviewSheet } from '../src/media/review.mjs';

const MARGIN = 4;
const PADDING = 4;

let directory;
let red;
let short;

function command(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let errors = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-65536); });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${executable} (${code}): ${errors}`));
      else resolve(Buffer.concat(chunks));
    });
  });
}

function fixture(args) {
  return command('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...args]);
}

async function imageSize(path) {
  const text = (await command('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path])).toString('utf8').trim();
  const [width, height] = text.split(',').map(Number);
  assert.ok(Number.isInteger(width) && Number.isInteger(height), `unexpected sheet size "${text}"`);
  return { width, height };
}

/**
 * Independent oracle: decode the sheet and count cells that are not the white
 * background. ffmpeg leaves unused cells blank, so this is the number of frames
 * that actually reached the picture.
 */
async function renderedCells(path) {
  const { width, height } = await imageSize(path);
  const cellWidth = (width - 2 * MARGIN - 3 * PADDING) / 4;
  const cellHeight = (height - 2 * MARGIN - 2 * PADDING) / 3;
  assert.ok(Number.isInteger(cellWidth) && Number.isInteger(cellHeight), `unexpected tile geometry ${width}x${height}`);
  const pixels = await command('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-i', path,
    '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
  assert.equal(pixels.length, width * height * 3);
  let filled = 0;
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 4; column++) {
      const x = Math.floor(MARGIN + column * (cellWidth + PADDING) + cellWidth / 2);
      const y = Math.floor(MARGIN + row * (cellHeight + PADDING) + cellHeight / 2);
      const [r, g, b] = [pixels[(y * width + x) * 3], pixels[(y * width + x) * 3 + 1], pixels[(y * width + x) * 3 + 2]];
      if (!(r > 240 && g > 240 && b > 240)) filled++;
    }
  }
  return filled;
}

async function stagedLeftovers() {
  return (await readdir(directory)).filter((name) => name.startsWith('.eac-review-'));
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'eac review sheet '));
  red = join(directory, 'red scene.mp4');
  short = join(directory, 'short scene.mp4');
  await fixture(['-f', 'lavfi', '-i', 'color=c=red:s=96x64:r=20:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', red]);
  // Half a second of picture: at fps=12/duration for duration=6 ffmpeg emits one
  // frame and still exits 0 with a mostly empty sheet.
  await fixture(['-f', 'lavfi', '-i', 'color=c=red:s=96x64:r=20:d=0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', short]);
});

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('a full-length source fills the 4x3 sheet and reports 12 real samples', async () => {
  const output = join(directory, 'review sheet.jpg');
  const result = await createReviewSheet({ path: red, outputPath: output, duration: 2 });
  assert.equal(result.path, output);
  assert.equal(result.columns, 4);
  assert.equal(result.rows, 3);
  assert.equal(result.reviewRequired, true);
  assert.equal(result.requestedSamples, 12);
  assert.equal(result.sampleCount, 12);
  assert.equal(result.complete, true);
  assert.ok((await stat(output)).size > 1000, 'sheet image should be written');
  assert.equal(await renderedCells(output), result.sampleCount, 'reported samples must match the picture');
  assert.deepEqual(await stagedLeftovers(), [], 'no staging file should survive a successful render');
});

test('too few usable frames are reported honestly instead of a hardcoded 12', async () => {
  const output = join(directory, 'short sheet.jpg');
  const result = await createReviewSheet({ path: short, outputPath: output, duration: 6 });
  assert.ok(result.sampleCount >= 1, `expected at least one sample, got ${result.sampleCount}`);
  assert.ok(result.sampleCount < 12, `expected fewer than 12 samples, got ${result.sampleCount}`);
  assert.notEqual(result.sampleCount, 12);
  assert.equal(result.requestedSamples, 12);
  assert.equal(result.complete, false);
  assert.equal(await renderedCells(output), result.sampleCount, 'reported samples must match the picture');
});

test('a failed render keeps the previously delivered sheet intact', async () => {
  const output = join(directory, 'existing sheet.jpg');
  const previous = Buffer.from('previous review sheet bytes');
  await writeFile(output, previous);
  await assert.rejects(
    createReviewSheet({ path: join(directory, 'missing source.mp4'), outputPath: output, duration: 2 }),
    /成片抽帧失败/,
  );
  assert.deepEqual(await readFile(output), previous, 'the old sheet must not be truncated or replaced');
  assert.deepEqual(await stagedLeftovers(), [], 'a failed render must remove its staging file');
});

test('the source file itself is always rejected as the output', async () => {
  const { size } = await stat(red);
  await assert.rejects(createReviewSheet({ path: red, outputPath: red, duration: 2 }), /must not replace source media/);
  assert.equal((await stat(red)).size, size, 'source media must be untouched');
});

test('a case variant of the source is rejected on Windows', {
  skip: process.platform === 'win32' ? false : 'case-insensitive paths are a Windows behaviour',
}, async () => {
  const { size } = await stat(red);
  await assert.rejects(
    createReviewSheet({ path: red, outputPath: red.toUpperCase(), duration: 2 }),
    /must not replace source media/,
  );
  assert.equal((await stat(red)).size, size, 'source media must be untouched');
});

/** Collect the argv of every ffmpeg process the module spawns while `operation` runs. */
async function ffmpegCalls(operation) {
  const events = channel('child_process');
  const calls = [];
  const collect = ({ process: child }) => {
    child.once('spawn', () => {
      if (child.spawnfile === 'ffmpeg') calls.push(child.spawnargs.slice(1));
    });
  };
  events.subscribe(collect);
  try {
    await operation();
  } finally {
    events.unsubscribe(collect);
  }
  return calls;
}

test('every ffmpeg invocation is guarded with -nostdin', async () => {
  const calls = await ffmpegCalls(() => createReviewSheet({
    path: red, outputPath: join(directory, 'nostdin.jpg'), duration: 2,
  }));
  assert.ok(calls.length >= 1, 'the sheet must be rendered by ffmpeg');
  for (const args of calls) assert.ok(args.includes('-nostdin'), `ffmpeg call without -nostdin: ${args.join(' ')}`);
});

test('the sheet is staged beside the target, never written straight to it', async () => {
  const output = join(directory, 'channel sheet.jpg');
  const calls = await ffmpegCalls(() => createReviewSheet({ path: red, outputPath: output, duration: 2 }));
  // A still image reaches disk in one packet, so a half-written sheet cannot be
  // provoked from outside: ffmpeg must never be pointed at the delivery path.
  const sheetCall = calls.find((args) => args.includes('-frames:v'));
  assert.ok(sheetCall, 'the tile has to be rendered by a one-frame ffmpeg call');
  const staged = sheetCall.at(-1);
  assert.notEqual(staged, output, 'ffmpeg must write a staging file, never the delivery path');
  assert.equal(dirname(staged), dirname(output), 'staging must sit beside the target so rename stays on one volume');
  assert.equal(await renderedCells(output), 12, 'the staged file still has to be published to the delivery path');
});

/**
 * The staging cleanup runs in a `finally`. Node's own `rm({ maxRetries: 5, retryDelay: 50 })` was
 * argued away in 250fd12 because its backoff overshoots the documented budget and it rejects,
 * which replaces the error that actually ended the render. This pins the shared contract review.mjs
 * now delegates to: while another process holds the file, the removal is retried, then reported --
 * it is never re-raised into the caller.
 */
test('staging cleanup retries a held file, reports it, and never rejects', {
  skip: process.platform !== 'win32' ? 'an exclusive file lock is only enforceable on Windows' : false,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'eac review lock '));
  const held = join(directory, 'staged.jpg');
  await writeFile(held, 'staged bytes');
  // FileShare.None: unlink is EBUSY and even the chmod Node's own rm retries with cannot run.
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$f=[IO.File]::Open('${held}','Open','ReadWrite','None'); Start-Sleep -Milliseconds 4000; $f.Dispose()`,
  ], { windowsHide: true, stdio: 'ignore' });
  const closed = new Promise((done) => holder.once('close', done));
  t.after(async () => {
    holder.kill('SIGKILL');
    await closed;
    await rm(directory, { recursive: true, force: true });
  });
  // Wait for the exclusive handle to exist; without it the removal would simply succeed.
  for (let attempt = 0; ; attempt++) {
    const locked = await open(held, 'r+').then(async (handle) => { await handle.close(); return false; }, () => true);
    if (locked) break;
    assert.ok(attempt < 100, 'the exclusive lock was never taken');
    await new Promise((done) => setTimeout(done, 50));
  }
  const failures = [];
  const started = performance.now();
  await cleanupStaging(held, { onFailure: (error, path) => failures.push({ code: error.code, path }) });
  const elapsed = performance.now() - started;
  assert.equal(failures.length, 1, 'a failed removal is reported through onFailure, not a rejection');
  assert.equal(failures[0].path, held);
  assert.match(String(failures[0].code), /^(EPERM|EBUSY|EACCES)$/);
  assert.ok(elapsed >= 400, `the retry budget has to be exercised, took ${Math.round(elapsed)}ms`);
  assert.ok(elapsed < 5000, `cleanup must stay near its ~750ms budget, took ${Math.round(elapsed)}ms`);
  // Only readable once the exclusive handle is gone -- which also proves cleanup did not remove it.
  holder.kill('SIGKILL');
  await closed;
  assert.equal(await readFile(held, 'utf8'), 'staged bytes', 'a failed cleanup must not damage the file it could not remove');
});

test('a cleanup that cannot remove its staging path never replaces the real error', async () => {
  const output = join(directory, 'sabotaged sheet.jpg');
  const events = channel('child_process');
  let sabotaged = 0;
  // Take the staging path before ffmpeg writes it: a directory sitting there makes the render
  // fail, and a plain rm() of a directory throws ERR_FS_EISDIR from the `finally` -- which would
  // replace the real 成片抽帧失败 error. cleanupStaging() reports it instead of raising.
  const listener = ({ process: child }) => {
    // spawnargs is only populated by the time 'spawn' fires, not when the channel publishes.
    child.once('spawn', () => {
      if (child.spawnfile !== 'ffmpeg') return;
      const staged = child.spawnargs.at(-1);
      if (!staged?.includes('.eac-review-')) return;
      try { mkdirSync(staged); sabotaged++; } catch { /* ffmpeg got there first */ }
    });
  };
  events.subscribe(listener);
  try {
    await assert.rejects(createReviewSheet({ path: red, outputPath: output, duration: 2 }), (error) => {
      assert.match(error.message, /成片抽帧失败/,
        `the ffmpeg error must survive the cleanup, got ${error.code}: ${error.message}`);
      return true;
    });
  } finally {
    events.unsubscribe(listener);
  }
  assert.equal(sabotaged, 1, 'the staging path must have been blocked by this test');
  assert.deepEqual(await stagedLeftovers(), [], 'the blocked staging path is still cleaned up');
});

test('a publish failure surfaces its own error and never a cleanup error', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'eac review publish '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // A non-empty directory where the sheet must land: ffmpeg renders fine, rename cannot replace it.
  const output = join(directory, 'occupied.jpg');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'keep.txt'), 'occupied');
  await assert.rejects(createReviewSheet({ path: red, outputPath: output, duration: 2 }), (error) => {
    assert.doesNotMatch(error.message, /EAC_CLEANUP|Could not remove staging/,
      'cleanup must not replace the error that ended the render');
    assert.match(String(error.code), /^(EPERM|EACCES|EISDIR|ENOTEMPTY|EEXIST|ENOTDIR)$/,
      `expected the rename failure, got ${error.code}: ${error.message}`);
    return true;
  });
  assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith('.eac-review-')), [],
    'the failed render must remove its staging file');
  assert.deepEqual(await readdir(output), ['keep.txt'], 'the occupied target must be untouched');
});
