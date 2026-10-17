import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

export async function createReviewSheet({ path, outputPath, duration, signal }) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) throw new Error('Review sheet requires a valid duration.');
  const source = resolve(path), output = resolve(outputPath);
  if (source === output) throw new Error('Review sheet must not replace source media.');
  signal?.throwIfAborted();
  await mkdir(dirname(output), { recursive: true });
  const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', source,
    '-vf', `fps=${12 / duration}:start_time=0,scale=480:-2,tile=4x3:padding=4:margin=4:color=white`,
    '-frames:v', '1', output], { windowsHide: true, signal, timeout: 120000 });
  let message = '';
  child.stderr.on('data', (data) => { message = (message + data).slice(-4000); });
  const [code] = await once(child, 'close');
  if (code !== 0) throw new Error(`成片抽帧失败：${message}`);
  return { path: output, sampleCount: 12, columns: 4, rows: 3, duration, reviewRequired: true };
}
