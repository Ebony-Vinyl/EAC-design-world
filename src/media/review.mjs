import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { dirname, extname, join, resolve } from 'node:path';
import { mkdir, rename, rm } from 'node:fs/promises';

const COLUMNS = 4;
const ROWS = 3;
const SAMPLES = COLUMNS * ROWS;

// Windows resolves `D:\A.png` and `d:\a.png` to the same file, so a case-sensitive
// string compare would let `-y` truncate the source media it is meant to protect.
function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function abortError() {
  return Object.assign(new Error('Media operation aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
}

/** Run ffmpeg the way the rest of the media layer does: no stdin, no shell, bounded output. */
async function ffmpeg(args, { signal, timeout = 120_000 } = {}) {
  if (signal?.aborted) throw abortError();
  const child = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args], {
    windowsHide: true, signal, timeout, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let failure;
  // A missing ffmpeg binary emits 'error'; without a listener that would be an
  // uncaught exception instead of a review-sheet failure.
  child.on('error', (error) => { failure ??= error; });
  child.stdout.on('data', (data) => { stdout = (stdout + data).slice(-8192); });
  child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-4000); });
  // events.once() rejects on 'error', so a spawn failure settles here as well.
  const [code] = await once(child, 'close').catch(() => [null]);
  if (signal?.aborted) throw abortError();
  if (failure) throw new Error(`成片抽帧失败：${failure.message}`);
  if (code !== 0) throw new Error(`成片抽帧失败：${stderr.trim() || `ffmpeg exited with code ${code}`}`);
  return { stdout, stderr };
}

/**
 * Count the frames the fps filter really emits. It stops at the end of the input,
 * so a short or thin video yields fewer than tile capacity -- ffmpeg still exits 0
 * with a partially empty sheet, which is why the count has to be measured here
 * instead of reported as a constant.
 */
async function availableFrames(source, rate, signal) {
  const { stdout } = await ffmpeg(['-i', source, '-map', '0:v:0', '-an',
    '-vf', `fps=${rate}:start_time=0,scale=16:-2`, '-nostats', '-progress', 'pipe:1', '-f', 'null', '-'], { signal });
  let count = null;
  for (const match of stdout.matchAll(/^frame=(\d+)$/gm)) count = Number(match[1]);
  if (count === null) throw new Error('成片抽帧失败：无法读取 ffmpeg 帧计数');
  return count;
}

export async function createReviewSheet({ path, outputPath, duration, signal }) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) throw new Error('Review sheet requires a valid duration.');
  const source = resolve(path), output = resolve(outputPath);
  if (samePath(source, output)) throw new Error('Review sheet must not replace source media.');
  signal?.throwIfAborted();
  await mkdir(dirname(output), { recursive: true });
  const rate = String(SAMPLES / duration);
  const sampleCount = Math.min(await availableFrames(source, rate, signal), SAMPLES);
  if (sampleCount < 1) throw new Error(`成片抽帧失败：${source} 没有可抽取的画面`);
  // Stage beside the target, then publish with rename: a failed render must not
  // truncate a sheet that was already delivered.
  const staged = join(dirname(output), `.eac-review-${randomUUID()}${extname(output).toLowerCase() || '.jpg'}`);
  try {
    await ffmpeg(['-i', source, '-map', '0:v:0', '-an', '-vf',
      `fps=${rate}:start_time=0,scale=480:-2,tile=${COLUMNS}x${ROWS}:padding=4:margin=4:color=white`,
      '-frames:v', '1', staged], { signal });
    await rename(staged, output);
  } finally {
    await rm(staged, { force: true, maxRetries: 5, retryDelay: 50 });
  }
  return {
    path: output, sampleCount, columns: COLUMNS, rows: ROWS,
    requestedSamples: SAMPLES, complete: sampleCount === SAMPLES,
    duration, reviewRequired: true,
  };
}
