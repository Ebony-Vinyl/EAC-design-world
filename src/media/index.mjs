import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldTask } from 'node:timers/promises';
import { createCaptionScript } from './captions.mjs';

export { remapTranscriptToTimeline } from './captions.mjs';

const MAX_DURATION = 3600;
const ANALYSIS_SECONDS = 120;
const SAMPLE_RATE = 8000;
const FFMPEG = 'ffmpeg';
const FFPROBE = 'ffprobe';

function abortError() {
  return Object.assign(new Error('Media operation aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}

async function checkpoint(signal) {
  checkAbort(signal);
  await yieldTask();
  checkAbort(signal);
}

function number(value, name, min, max, fallback) {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isFinite(result) || result < min || result > max) {
    throw new TypeError(`${name} must be a finite number between ${min} and ${max}`);
  }
  return result;
}

function integer(value, name, min, max, fallback) {
  const result = number(value, name, min, max, fallback);
  if (!Number.isInteger(result)) throw new TypeError(`${name} must be an integer`);
  return result;
}

function filePath(value, name = 'path') {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new TypeError(`${name} must be a nonempty filesystem path`);
  }
  return resolve(value);
}

function run(command, args, { signal, timeout = 120_000, maxBytes = 2 ** 20, onStdout, processTree = false, cwd } = {}) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false, windowsHide: true, stdio: processTree ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
      detached: processTree && process.platform !== 'win32',
    });
    const chunks = [];
    let bytes = 0;
    let stderr = '';
    let failure;
    let terminating;
    if (processTree) {
      child.on('message', (message) => {
        if (message === 'ready' && failure && child.connected) child.send('abort', () => {});
      });
    }
    const forceStop = () => {
      if (processTree && child.pid && process.platform === 'win32') {
        // Playwright owns a browser process tree; killing just its Node host leaks Edge.
        return new Promise((finished) => {
          const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
          const limit = setTimeout(() => { killer.kill('SIGKILL'); child.kill('SIGKILL'); }, 10_000);
          killer.on('error', () => child.kill('SIGKILL'));
          killer.on('close', (code) => {
            clearTimeout(limit);
            if (code !== 0) child.kill('SIGKILL');
            finished();
          });
        });
      } else {
        if (processTree && child.pid && process.platform !== 'win32') {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        } else child.kill('SIGKILL');
        return Promise.resolve();
      }
    };
    const stop = (error) => {
      failure ??= error;
      if (terminating) return;
      if (processTree && child.connected) {
        terminating = new Promise((finished) => {
          let forcing = false;
          const grace = setTimeout(() => { forcing = true; void forceStop().then(finished); }, 1000);
          child.once('close', () => { clearTimeout(grace); if (!forcing) finished(); });
          // Let Edge flush/close its profile first; force termination bounds unresponsive launch/capture.
          child.send('abort', () => {});
        });
      } else terminating = forceStop();
    };
    const abort = () => stop(abortError());
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => stop(new Error(`${command} timed out after ${timeout}ms`)), timeout);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) return stop(new Error(`${command} exceeded output limit`));
      chunks.push(chunk);
      try { onStdout?.(chunk.toString('utf8')); } catch (error) { stop(error); }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-65536); });
    child.on('error', (error) => { failure ??= error; });
    child.on('close', async (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      await terminating;
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
      else resolveRun({ stdout: Buffer.concat(chunks), stderr });
    });
  });
}

function ffmpeg(args, options) {
  return run(FFMPEG, ['-hide_banner', '-nostdin', '-y', ...args], options);
}

async function workspace(outputPath) {
  const output = filePath(outputPath, 'outputPath');
  await mkdir(dirname(output), { recursive: true });
  const temporary = await mkdtemp(join(dirname(output), '.eac-media-'));
  return { output, temporary, staged: join(temporary, `result${extname(output) || '.mp4'}`) };
}

async function publish(job, signal) {
  const metadata = await probeMedia(job.staged, { signal });
  checkAbort(signal);
  await rename(job.staged, job.output);
  return { ...metadata, path: job.output };
}

function hasStream(media, type) {
  return media.streams.some((stream) => stream.codec_type === type);
}

/** Normalized properties plus the complete ffprobe streams and format objects. */
export async function probeMedia(path, { signal } = {}) {
  checkAbort(signal);
  path = filePath(path);
  await access(path);
  const { stdout } = await run(FFPROBE, [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path,
  ], { signal, timeout: 30_000, maxBytes: 4 * 2 ** 20 });
  checkAbort(signal);
  const { streams = [], format = {} } = JSON.parse(stdout.toString('utf8'));
  if (!streams.length) throw new Error(`No media streams in ${path}`);
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const [numerator, denominator] = (video?.avg_frame_rate || video?.r_frame_rate || '0/1').split('/').map(Number);
  const durations = [format.duration, ...streams.map((stream) => stream.duration)]
    .map(Number).filter(Number.isFinite);
  return {
    path, duration: Math.max(0, ...durations), width: video?.width ?? null,
    height: video?.height ?? null, fps: denominator ? numerator / denominator : 0,
    hasVideo: Boolean(video), hasAudio: Boolean(audio),
    size: Number(format.size) || 0, streams, format,
  };
}

function intervals(log, name) {
  const result = [];
  const regex = new RegExp(`${name}_start:\\s*([\\d.]+)|${name}_end:\\s*([\\d.]+)`, 'g');
  let start;
  for (const match of log.matchAll(regex)) {
    if (match[1] !== undefined) start = Number(match[1]);
    else if (start !== undefined) {
      result.push({ start, end: Number(match[2]), duration: Number(match[2]) - start });
      start = undefined;
    }
  }
  return { intervals: result, openStart: start ?? null };
}

/** Decode the first two minutes and measure actual picture/audio content. */
export async function analyzeMedia(path, { signal } = {}) {
  checkAbort(signal);
  const media = await probeMedia(path, { signal });
  const args = ['-v', 'info', '-i', media.path, '-t', String(ANALYSIS_SECONDS)];
  if (media.hasVideo) args.push('-map', '0:v:0', '-vf', 'blackdetect=d=0.25:pix_th=0.10,freezedetect=n=-50dB:d=1');
  if (media.hasAudio) args.push('-map', '0:a:0', '-af', 'volumedetect');
  args.push('-f', 'null', '-');
  const { stderr } = await ffmpeg(args, { signal, timeout: 180_000 });
  checkAbort(signal);
  const db = (key) => {
    const match = stderr.match(new RegExp(`${key}:\\s*(-?inf|[-\\d.]+) dB`));
    return match ? (match[1] === '-inf' ? -Infinity : Number(match[1])) : null;
  };
  const black = intervals(stderr, 'black');
  const freeze = intervals(stderr, 'freeze');
  return {
    ...media, analyzedDuration: Math.min(media.duration || ANALYSIS_SECONDS, ANALYSIS_SECONDS),
    blackSegments: black.intervals, blackOpenStart: black.openStart,
    frozenSegments: freeze.intervals, frozenOpenStart: freeze.openStart,
    audio: media.hasAudio ? { meanDb: db('mean_volume'), peakDb: db('max_volume') } : null,
  };
}

/** Onset-envelope autocorrelation; supplied BPM locks the tempo but still measures phase. */
export async function analyzeBeats(path, { bpm, signal } = {}) {
  checkAbort(signal);
  if (bpm !== undefined) number(bpm, 'bpm', 30, 300);
  const media = await probeMedia(path, { signal });
  if (!media.hasAudio) throw new Error(`No audio stream in ${media.path}`);
  const { stdout } = await ffmpeg([
    '-v', 'error', '-i', media.path, '-t', String(ANALYSIS_SECONDS),
    '-map', '0:a:0', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-',
  ], { signal, timeout: 90_000, maxBytes: SAMPLE_RATE * ANALYSIS_SECONDS * 4 + 65536 });
  const hop = 160;
  const energies = [];
  for (let offset = 0; offset + hop * 4 <= stdout.length; offset += hop * 4) {
    let energy = 0;
    for (let index = 0; index < hop; index++) energy += stdout.readFloatLE(offset + index * 4) ** 2;
    energies.push(Math.sqrt(energy / hop));
    if (energies.length % 128 === 0) await checkpoint(signal);
  }
  const envelope = energies.map((energy, index) => Math.max(0, energy - (energies[index - 1] || 0)));
  const power = envelope.reduce((sum, value) => sum + value * value, 0);
  if (power < 1e-9 || envelope.length < 8) {
    return { path: media.path, duration: media.duration, analyzedDuration: stdout.length / 4 / SAMPLE_RATE, bpm: bpm ?? null, beats: [], confidence: 0 };
  }
  let lag = bpm ? 60 * SAMPLE_RATE / hop / bpm : 0;
  let best = -Infinity;
  if (!bpm) {
    for (let candidate = 15; candidate <= 60 && candidate < envelope.length / 2; candidate++) {
      await checkpoint(signal);
      let score = 0;
      for (let index = candidate; index < envelope.length; index++) score += envelope[index] * envelope[index - candidate];
      if (score > best) { best = score; lag = candidate; }
    }
  }
  if (!lag) return { path: media.path, duration: media.duration, analyzedDuration: stdout.length / 4 / SAMPLE_RATE, bpm: null, beats: [], confidence: 0 };
  let phase = 0;
  let phaseScore = -Infinity;
  for (let candidate = 0; candidate < Math.ceil(lag); candidate++) {
    await checkpoint(signal);
    let score = 0;
    for (let index = candidate; index < envelope.length; index += lag) score += envelope[Math.round(index)] || 0;
    if (score > phaseScore) { phaseScore = score; phase = candidate; }
  }
  const beats = [];
  for (let index = phase; index < envelope.length; index += lag) beats.push(Number((index * hop / SAMPLE_RATE).toFixed(4)));
  let correlation = 0;
  for (let index = Math.ceil(lag); index < envelope.length; index++) correlation += envelope[index] * (envelope[Math.round(index - lag)] || 0);
  checkAbort(signal);
  return {
    path: media.path, duration: media.duration, analyzedDuration: stdout.length / 4 / SAMPLE_RATE,
    bpm: bpm ?? Number((60 * SAMPLE_RATE / hop / lag).toFixed(2)), beats,
    confidence: Math.max(0, Math.min(1, correlation / power)),
  };
}

function videoEncoding(quality = 'draft') {
  return ['-c:v', 'libx264', '-preset', quality === 'production' ? 'medium' : 'fast',
    '-crf', quality === 'production' ? '17' : '20', '-pix_fmt', 'yuv420p'];
}

/** Capture real browser frames without requiring Playwright's bundled FFmpeg. */
export async function recordBrowser({ url, actions = [], outputDir, width = 1280, height = 720, signal } = {}) {
  checkAbort(signal);
  integer(width, 'width', 16, 3840);
  integer(height, 'height', 16, 3840);
  if (typeof url !== 'string' || !/^(https?:|file:|data:)/i.test(url)) throw new TypeError('url must be an http, https, file, or data URL');
  if (!Array.isArray(actions) || actions.length > 100) throw new TypeError('actions must contain at most 100 actions');
  let waits = 0;
  for (const action of actions) {
    if (!action || !['click', 'fill', 'wait', 'scroll', 'move', 'wheel'].includes(action.type)) throw new TypeError('Unsupported browser action');
    if (['click', 'fill'].includes(action.type) && (typeof action.selector !== 'string' || !action.selector)) throw new TypeError('click/fill requires selector');
    if (action.type === 'fill' && typeof action.text !== 'string') throw new TypeError('fill requires text');
    if (action.type === 'wait') waits += number(action.ms, 'action.ms', 0, 30_000, 1000);
    if (['scroll', 'wheel'].includes(action.type)) number(action.deltaY, 'action.deltaY', -100000, 100000, 600);
    if (action.type === 'wheel') number(action.deltaX, 'action.deltaX', -100000, 100000, 0);
    if (action.type === 'move') {
      number(action.x, 'action.x', 0, width - 1);
      number(action.y, 'action.y', 0, height - 1);
      integer(action.steps, 'action.steps', 1, 120, 1);
    }
  }
  if (waits > 90_000) throw new RangeError('Total browser waits must not exceed 90 seconds');
  const directory = filePath(outputDir, 'outputDir');
  const job = await workspace(join(directory, `browser-${randomUUID()}.mp4`));
  try {
    const request = join(job.temporary, 'capture.json');
    await writeFile(request, JSON.stringify({ url, actions, width, height, directory: job.temporary }), { encoding: 'utf8', signal });
    await run(process.execPath, [fileURLToPath(new URL('./browser-worker.mjs', import.meta.url)), request],
      { signal, processTree: true, timeout: 150_000 });
    const list = join(job.temporary, 'frames.txt');
    await ffmpeg(['-v', 'error', '-f', 'concat', '-safe', '1', '-i', list,
      '-vf', 'fps=30,pad=ceil(iw/2)*2:ceil(ih/2)*2', ...videoEncoding(), '-movflags', '+faststart', job.staged], { signal });
    return await publish(job, signal);
  } finally {
    await rm(job.temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

export async function recordDesktop({ outputPath, duration, fps = 30, signal } = {}) {
  checkAbort(signal);
  if (process.platform !== 'win32') throw new Error('Desktop recording currently requires Windows gdigrab');
  number(duration, 'duration', 0.1, 600);
  integer(fps, 'fps', 1, 60);
  const job = await workspace(outputPath);
  try {
    await ffmpeg(['-v', 'error', '-f', 'gdigrab', '-framerate', String(fps), '-i', 'desktop',
      '-t', String(duration), '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-an',
      ...videoEncoding(), job.staged], { signal, timeout: duration * 1000 + 60_000 });
    return await publish(job, signal);
  } finally { await rm(job.temporary, { recursive: true, force: true }); }
}

export async function synthesizeVoice({ text, outputPath, voice, rate = 0, signal } = {}) {
  checkAbort(signal);
  if (process.platform !== 'win32') throw new Error('Voice synthesis currently requires Windows SAPI');
  if (typeof text !== 'string' || !text.trim() || text.length > 20_000) throw new TypeError('text must contain 1 to 20000 characters');
  if (voice !== undefined && (typeof voice !== 'string' || !voice.trim())) throw new TypeError('voice must be an installed SAPI voice name');
  integer(rate, 'rate', -10, 10);
  const job = await workspace(outputPath);
  try {
    const textPath = join(job.temporary, 'speech.txt');
    const wavePath = join(job.temporary, 'speech.wav');
    await writeFile(textPath, text, { encoding: 'utf8', signal });
    const script = fileURLToPath(new URL('../../scripts/voice.ps1', import.meta.url));
    const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-TextPath', textPath, '-OutputPath', wavePath, '-Rate', String(rate)];
    if (voice !== undefined) args.push('-Voice', voice);
    await run(powershell, args, { signal, timeout: 300_000 });
    await ffmpeg(['-v', 'error', '-i', wavePath, '-vn', job.staged], { signal });
    return await publish(job, signal);
  } finally { await rm(job.temporary, { recursive: true, force: true }); }
}

function randomGenerator(seed) {
  let state = 2166136261;
  for (const char of String(seed)) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Original deterministic stereo PCM: drums, bass, chord progression and melody. */
export async function composeMusic({ outputPath, duration, bpm = 112, seed = 1, signal } = {}) {
  checkAbort(signal);
  number(duration, 'duration', 0.1, 600);
  number(bpm, 'bpm', 30, 300);
  if (!['number', 'string'].includes(typeof seed)) throw new TypeError('seed must be a number or string');
  const job = await workspace(outputPath);
  let stream;
  try {
    const sampleRate = 44100;
    const sampleCount = Math.round(duration * sampleRate);
    const wave = join(job.temporary, 'music.wav');
    stream = createWriteStream(wave, { signal });
    // Keep a rejection handler attached while backpressure temporarily yields control.
    let streamFailure;
    stream.on('error', (error) => { streamFailure = error; });
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(36 + sampleCount * 4, 4);
    header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
    header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 4, 28);
    header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
    header.write('data', 36); header.writeUInt32LE(sampleCount * 4, 40);
    stream.write(header);
    const random = randomGenerator(seed);
    const beatSeconds = 60 / bpm;
    const roots = [45, 41, 48, 43];
    const melody = Array.from({ length: 32 }, () => [0, 3, 5, 7, 10, 12][Math.floor(random() * 6)]);
    const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
    for (let offset = 0; offset < sampleCount; offset += 8192) {
      await checkpoint(signal);
      const count = Math.min(8192, sampleCount - offset);
      const chunk = Buffer.allocUnsafe(count * 4);
      for (let index = 0; index < count; index++) {
        const t = (offset + index) / sampleRate;
        const beat = t / beatSeconds;
        const beatIndex = Math.floor(beat);
        const within = (beat - beatIndex) * beatSeconds;
        const half = (beat * 2 % 1) * beatSeconds / 2;
        const root = roots[Math.floor(beat / 16) % roots.length];
        const noise = random() * 2 - 1;
        const kick = Math.sin(2 * Math.PI * (48 * within + 6 * (1 - Math.exp(-within * 35)))) * Math.exp(-within * 18) * 0.62;
        const snare = beatIndex % 4 === 1 || beatIndex % 4 === 3 ? noise * Math.exp(-within * 28) * 0.23 : 0;
        const hat = noise * Math.exp(-half * 95) * 0.10;
        const bass = Math.sin(2 * Math.PI * hz(root) * t) * Math.exp(-within * 5) * 0.19;
        const chord = [12, 15, 19].reduce((sum, interval) => sum + Math.sin(2 * Math.PI * hz(root + interval) * t), 0) * 0.036;
        const leadFrequency = hz(root + 24 + melody[Math.floor(beat * 2) % melody.length]);
        const lead = Math.sin(2 * Math.PI * leadFrequency * t) * Math.exp(-half * 12) * 0.065;
        const fade = Math.min(1, t / 0.015, (duration - t) / 0.15);
        const center = kick + snare + hat + bass;
        const left = Math.tanh(center + chord + lead) * fade * 0.87;
        const right = Math.tanh(center + chord * 0.85 + lead * 0.7) * fade * 0.87;
        chunk.writeInt16LE(Math.round(left * 32767), index * 4);
        chunk.writeInt16LE(Math.round(right * 32767), index * 4 + 2);
      }
      if (streamFailure) throw streamFailure;
      if (!stream.write(chunk)) await once(stream, 'drain', { signal });
    }
    const finished = once(stream, 'finish', { signal });
    stream.end();
    await finished;
    if (extname(job.staged).toLowerCase() === '.wav') await rename(wave, job.staged);
    else await ffmpeg(['-v', 'error', '-i', wave, '-vn', job.staged], { signal });
    return await publish(job, signal);
  } finally {
    if (stream && !stream.closed) {
      const closed = once(stream, 'close').catch(() => {});
      stream.destroy();
      await closed;
    }
    await rm(job.temporary, { recursive: true, force: true });
  }
}

function validateProject(project) {
  if (!project || typeof project !== 'object') throw new TypeError('project is required');
  const width = integer(project.width, 'width', 16, 3840, 1280);
  const height = integer(project.height, 'height', 16, 3840, 720);
  const fps = integer(project.fps, 'fps', 1, 60, 30);
  const quality = project.quality ?? 'draft';
  if (!['draft', 'production'].includes(quality)) throw new TypeError('quality must be draft or production');
  if (width % 2 || height % 2) throw new TypeError('width and height must be even for H.264');
  if (!Array.isArray(project.clips) || !project.clips.length || project.clips.length > 128) throw new TypeError('project requires 1 to 128 clips');
  const clips = project.clips.map((clip, index) => {
    if (!clip || !['video', 'image', 'audio'].includes(clip.kind)) throw new TypeError(`Invalid kind for clip ${index}`);
    const start = number(clip.start, 'clip.start', 0, MAX_DURATION, 0);
    const duration = number(clip.duration, 'clip.duration', 0.01, MAX_DURATION);
    return {
      ...clip, path: filePath(clip.path, `clip ${index} path`), start, duration,
      sourceIn: number(clip.sourceIn, 'clip.sourceIn', 0, MAX_DURATION, 0),
      volume: number(clip.volume, 'clip.volume', 0, 8, 1),
      track: integer(clip.track, 'clip.track', 0, 127, 0), index,
    };
  });
  const duration = Math.max(...clips.map((clip) => clip.start + clip.duration));
  if (duration > MAX_DURATION) throw new RangeError('Timeline exceeds 3600 seconds');
  const captionScript = createCaptionScript({
    captions: project.captions, subtitleStyle: project.subtitleStyle, width, height, duration,
  });
  return { width, height, fps, quality, clips, duration, captionScript };
}

/** Composite visuals by ascending track/index; mix original, clip, music and voice audio. */
export async function renderTimeline({ project, outputPath, onProgress, signal } = {}) {
  if (signal?.aborted) throw abortError();
  if (onProgress !== undefined && typeof onProgress !== 'function') throw new TypeError('onProgress must be a function');
  const timeline = validateProject(project);
  const output = filePath(outputPath, 'outputPath');
  if (!['.mp4', '.mov', '.mkv'].includes(extname(output).toLowerCase())) throw new TypeError('Timeline output must be .mp4, .mov, or .mkv');
  const media = new Map();
  const external = [];
  for (const [key, gain] of [['musicPath', 0.22], ['voicePath', 1]]) {
    if (project[key] !== undefined && project[key] !== null) external.push({ path: filePath(project[key], key), gain, key });
  }
  for (const path of [...timeline.clips, ...external].map((item) => item.path)) {
    const samePath = process.platform === 'win32' ? path.toLowerCase() === output.toLowerCase() : path === output;
    if (samePath) throw new Error('Output must differ from every input path');
    if (signal?.aborted) throw abortError();
    if (!media.has(path)) media.set(path, await probeMedia(path, { signal }));
  }
  for (const clip of timeline.clips) {
    const info = media.get(clip.path);
    if (!hasStream(info, clip.kind === 'audio' ? 'audio' : 'video')) throw new Error(`Clip ${clip.id ?? clip.index} lacks a ${clip.kind === 'audio' ? 'audio' : 'video'} stream`);
    if (clip.kind === 'image' && clip.sourceIn !== 0) throw new Error('Image sourceIn must be zero');
    if (clip.kind !== 'image' && info.duration && clip.sourceIn + clip.duration > info.duration + 1 / timeline.fps) {
      throw new Error(`Clip ${clip.id ?? clip.index} exceeds source duration`);
    }
  }
  for (const bed of external) if (!media.get(bed.path).hasAudio) throw new Error(`${bed.key} has no audio stream`);
  const job = await workspace(output);
  try {
    const args = ['-v', 'error', '-filter_complex_threads', '1'];
    for (const clip of timeline.clips) {
      if (clip.kind === 'image') args.push('-loop', '1', '-framerate', String(timeline.fps));
      else args.push('-ss', String(clip.sourceIn));
      args.push('-t', String(clip.duration), '-i', clip.path);
    }
    for (const bed of external) {
      if (bed.key === 'musicPath') args.push('-stream_loop', '-1');
      args.push('-t', String(timeline.duration), '-i', bed.path);
    }
    const filters = [
      `color=c=black:s=${timeline.width}x${timeline.height}:r=${timeline.fps}:d=${timeline.duration},format=yuv420p[base]`,
    ];
    let previous = 'base';
    const visuals = timeline.clips.filter((clip) => clip.kind !== 'audio')
      .sort((a, b) => a.track - b.track || a.index - b.index);
    for (const clip of visuals) {
      const label = `v${clip.index}`;
      filters.push(`[${clip.index}:v:0]trim=duration=${clip.duration},setpts=PTS-STARTPTS,` +
        `scale=${timeline.width}:${timeline.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
        `pad=${timeline.width}:${timeline.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${timeline.fps},` +
        `format=yuv420p,setpts=PTS+${clip.start}/TB[${label}]`);
      const next = `composite${clip.index}`;
      filters.push(`[${previous}][${label}]overlay=eof_action=pass:repeatlast=0:enable='gte(t,${clip.start})*lt(t,${clip.start + clip.duration})'[${next}]`);
      previous = next;
    }
    if (timeline.captionScript) {
      await writeFile(join(job.temporary, 'captions.ass'), timeline.captionScript, { encoding: 'utf8', signal });
      // Only a fixed relative filename enters the graph; Windows paths stay in spawn's cwd.
      filters.push(`[${previous}]ass=filename=captions.ass[captioned]`);
      previous = 'captioned';
    }
    const audioLabels = [];
    for (const clip of timeline.clips) {
      if (clip.kind === 'image' || !media.get(clip.path).hasAudio) continue;
      const label = `a${clip.index}`;
      filters.push(`[${clip.index}:a:0]atrim=duration=${clip.duration},asetpts=PTS-STARTPTS,` +
        `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${clip.volume},` +
        `adelay=${Math.round(clip.start * 48000)}S:all=1[${label}]`);
      audioLabels.push(`[${label}]`);
    }
    const externalLabels = new Map();
    for (const [index, bed] of external.entries()) {
      const label = `bed${index}`;
      filters.push(`[${timeline.clips.length + index}:a:0]atrim=duration=${timeline.duration},asetpts=PTS-STARTPTS,` +
        `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${bed.gain},` +
        `apad,atrim=duration=${timeline.duration}[${label}]`);
      externalLabels.set(bed.key, label);
    }
    const musicLabel = externalLabels.get('musicPath');
    const voiceLabel = externalLabels.get('voicePath');
    if (musicLabel && voiceLabel) {
      filters.push(`[${voiceLabel}]asplit=2[voiceMix][voiceControl]`);
      filters.push(`[${musicLabel}][voiceControl]sidechaincompress=threshold=0.02:ratio=8:attack=10:release=250:link=maximum[duckedMusic]`);
      audioLabels.push('[duckedMusic]', '[voiceMix]');
    } else {
      for (const label of externalLabels.values()) audioLabels.push(`[${label}]`);
    }
    if (audioLabels.length) {
      filters.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0:dropout_transition=0,` +
        `apad,atrim=duration=${timeline.duration},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[audio]`);
    }
    const script = join(job.temporary, 'filters.txt');
    await writeFile(script, filters.join(';\n'), { encoding: 'utf8', signal });
    args.push('-filter_complex_script', script, '-map', `[${previous}]`);
    if (audioLabels.length) args.push('-map', '[audio]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
    else args.push('-an');
    args.push(...videoEncoding(timeline.quality), '-r', String(timeline.fps), '-t', String(timeline.duration));
    if (['.mp4', '.mov'].includes(extname(output).toLowerCase())) args.push('-movflags', '+faststart');
    args.push('-progress', 'pipe:1', '-nostats', job.staged);
    let pending = '';
    let last = 0;
    onProgress?.(0);
    await ffmpeg(args, {
      cwd: timeline.captionScript ? job.temporary : undefined,
      signal, timeout: Math.min(900_000, 60_000 + timeline.duration * 5000),
      onStdout: (chunk) => {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('out_time_us=')) continue;
          const seconds = Number(line.slice('out_time_us='.length)) / 1e6;
          if (!Number.isFinite(seconds)) continue;
          const fraction = Math.max(last, Math.min(0.999, seconds / timeline.duration));
          if (fraction > last) { last = fraction; onProgress?.(fraction); }
        }
      },
    });
    if (signal?.aborted) throw abortError();
    const result = await publish(job, signal);
    // Completion callbacks run only after the output has been published.
    onProgress?.(1);
    return result;
  } finally { await rm(job.temporary, { recursive: true, force: true }); }
}

/** Decode validation plus duration/stream checks; content warnings are not hard failures. */
export async function qualityCheck({ path, expectedDuration, signal } = {}) {
  checkAbort(signal);
  if (expectedDuration !== undefined) number(expectedDuration, 'expectedDuration', 0.01, MAX_DURATION);
  const media = await probeMedia(path, { signal });
  if (media.duration > MAX_DURATION) throw new RangeError('Quality check supports media up to 3600 seconds');
  const errors = [];
  const warnings = [];
  try {
    await ffmpeg(['-v', 'error', '-xerror', '-i', media.path, '-map', '0:v?', '-map', '0:a?', '-f', 'null', '-'],
      { signal, timeout: Math.min(900_000, 30_000 + media.duration * 3000) });
  } catch (error) {
    checkAbort(signal);
    errors.push(`Decode failed: ${error.message}`);
  }
  const tolerance = Math.max(0.15, 2 / (media.fps || 30));
  if (expectedDuration !== undefined && Math.abs(media.duration - expectedDuration) > tolerance) errors.push(`Duration ${media.duration}s differs from expected ${expectedDuration}s`);
  if (!media.duration) errors.push('Media has no measurable duration');
  let analysis;
  try { analysis = await analyzeMedia(media.path, { signal }); } catch (error) {
    checkAbort(signal);
    errors.push(`Content analysis failed: ${error.message}`);
    return { ok: false, errors, warnings, ...media, analysis: null };
  }
  if (analysis.blackSegments.length || analysis.blackOpenStart !== null) warnings.push('Black video detected');
  if (analysis.frozenSegments.length || analysis.frozenOpenStart !== null) warnings.push('Static/frozen video detected');
  if (analysis.audio && (analysis.audio.peakDb === -Infinity || analysis.audio.peakDb < -60)) warnings.push('Audio is silent or nearly silent');
  if (analysis.audio?.peakDb >= -0.1) warnings.push('Audio approaches full scale');
  return { ok: errors.length === 0, errors, warnings, ...analysis };
}
