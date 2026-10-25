import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream, existsSync } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldTask } from 'node:timers/promises';
import { createCaptionScript } from './captions.mjs';
import { localVoiceConfiguration, MAMBO_VOICE_ID } from '../local-voice.mjs';
import { describeGrading, mergeGrading, normalizeGrading, writeCubeLut } from './grading.mjs';

export { remapTranscriptToTimeline } from './captions.mjs';
export { run as runMediaProcess };

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
  if (typeof text !== 'string' || !text.trim() || text.length > 20_000) throw new TypeError('text must contain 1 to 20000 characters');
  if (voice !== undefined && (typeof voice !== 'string' || !voice.trim())) throw new TypeError('voice must be an installed system voice name');
  integer(rate, 'rate', -10, 10);
  if (voice === MAMBO_VOICE_ID) return synthesizeMambo({ text, outputPath, rate, signal });
  if (!['win32', 'darwin'].includes(process.platform)) throw new Error('Voice synthesis requires Windows SAPI or macOS say');
  const job = await workspace(outputPath);
  try {
    const textPath = join(job.temporary, 'speech.txt');
    const wavePath = join(job.temporary, 'speech.wav');
    await writeFile(textPath, text, { encoding: 'utf8', signal });
    if (process.platform === 'darwin') {
      const args = ['-f', textPath, '-o', wavePath, '--file-format=WAVE', '--data-format=LEI16@22050', '-r', String(Math.round(175 * 2 ** (rate / 10)))];
      if (voice !== undefined) {
        const voices = await run('/usr/bin/say', ['-v', '?'], { signal });
        const names = voices.stdout.toString('utf8').split('\n').map(line => line.split(/\s+[a-z]{2,3}[_-][A-Z]{2}\s/)[0].trim());
        if (!names.includes(voice)) throw new Error(`未安装 macOS 语音：${voice}`);
        args.push('-v', voice);
      }
      await run('/usr/bin/say', args, { signal, timeout: 300_000 });
    } else {
      const script = fileURLToPath(new URL('../../scripts/voice.ps1', import.meta.url));
      const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-TextPath', textPath, '-OutputPath', wavePath, '-Rate', String(rate)];
      if (voice !== undefined) args.push('-Voice', voice);
      await run(powershell, args, { signal, timeout: 300_000 });
    }
    await ffmpeg(['-v', 'error', '-i', wavePath, '-vn', job.staged], { signal });
    return await publish(job, signal);
  } finally { await rm(job.temporary, { recursive: true, force: true }); }
}

async function synthesizeMambo({ text, outputPath, rate, signal }) {
  const config = await localVoiceConfiguration();
  const job = await workspace(outputPath);
  try {
    const output = join(job.temporary, 'speech.wav');
    const metadataPath = join(job.temporary, 'voice.json');
    const request = join(job.temporary, 'speech-request.json');
    await writeFile(request, JSON.stringify({ ...config, text, rate, outputPath: output, metadataPath }), { encoding: 'utf8', signal });
    await run(config.pythonExecutable, ['-X', 'utf8', fileURLToPath(new URL('../../scripts/gpt-sovits-worker.py', import.meta.url)), request],
      { signal, timeout: 900_000, processTree: true, cwd: config.engineRoot });
    checkAbort(signal);
    const voice = JSON.parse(await readFile(metadataPath, 'utf8'));
    if (voice.id !== MAMBO_VOICE_ID || voice.profileId !== config.profileId || voice.profileSha256 !== config.profileSha256) throw new Error('曼波推理返回的音色与基准不一致');
    await ffmpeg(['-v', 'error', '-i', output, '-vn', job.staged], { signal });
    return { ...await publish(job, signal), voice };
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

const MOTION_TYPES = ['zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down'];
const WINDOW_SHAPES = ['circle', 'rect', 'linear'];

// Structured per-clip objects (motion, power windows) report in Chinese like the grading module;
// plain scalars keep the English number()/integer() messages used across validateProject.
function field(value, name, min, max, fallback) {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isFinite(result) || result < min || result > max) {
    throw new TypeError(`${name} 必须是 ${min} 到 ${max} 之间的有限数字`);
  }
  return result;
}

function validateMotion(motion, index) {
  if (motion === undefined || motion === null) return null;
  if (typeof motion !== 'object' || Array.isArray(motion)) {
    throw new TypeError(`片段 ${index} 的 motion 必须是对象或 null`);
  }
  if (!MOTION_TYPES.includes(motion.type)) {
    throw new TypeError(`片段 ${index} 的 motion.type 必须是 ${MOTION_TYPES.join('、')} 之一`);
  }
  return { type: motion.type, amount: field(motion.amount, `片段 ${index} 的 motion.amount`, 0, 0.5, 0.12) };
}

function validateWindows(windows, index) {
  if (windows === undefined || windows === null) return [];
  if (!Array.isArray(windows)) throw new TypeError(`片段 ${index} 的 windows 必须是数组`);
  if (windows.length > 4) throw new TypeError(`片段 ${index} 的 power window 数量不能超过 4 个`);
  return windows.map((window, windex) => {
    const name = `片段 ${index} 的第 ${windex + 1} 个 power window`;
    if (!window || typeof window !== 'object' || Array.isArray(window)) throw new TypeError(`${name} 必须是对象`);
    if (!WINDOW_SHAPES.includes(window.shape)) {
      throw new TypeError(`${name} 的 shape 必须是 ${WINDOW_SHAPES.join('、')} 之一`);
    }
    if (!window.grading || typeof window.grading !== 'object' || Array.isArray(window.grading)) {
      throw new TypeError(`${name} 缺少有效的 grading 调色对象`);
    }
    // Validate but keep the raw object: the window grading merges as a third partial layer.
    normalizeGrading(window.grading);
    const normalized = {
      shape: window.shape,
      x: field(window.x, `${name} 的 x`, 0, 1, 0.5),
      y: field(window.y, `${name} 的 y`, 0, 1, 0.5),
      feather: field(window.feather, `${name} 的 feather`, 0, 0.45, 0.15),
      opacity: field(window.opacity, `${name} 的 opacity`, 0, 1, 1),
      grading: window.grading,
    };
    if (window.angle !== undefined) field(window.angle, `${name} 的 angle`, -180, 180, 0);
    if (window.shape === 'circle') normalized.radius = field(window.radius, `${name} 的 radius`, 0.05, 1, 0.35);
    if (window.shape === 'rect') {
      normalized.width = field(window.width, `${name} 的 width`, 0.05, 2, 0.6);
      normalized.height = field(window.height, `${name} 的 height`, 0.05, 2, 0.6);
    }
    if (window.shape === 'linear') normalized.angle = field(window.angle, `${name} 的 angle`, -180, 180, 0);
    return normalized;
  });
}

/** Plain decimal string for filter expressions; avoids scientific notation and float noise. */
function exprNumber(value) {
  return value.toFixed(12);
}

/** atempo accepts 0.5..2 per instance; chain instances to cover the 0.25..4 speed range. */
function atempoFilters(speed) {
  const steps = [];
  let remaining = speed;
  while (remaining > 2) { steps.push('2'); remaining /= 2; }
  while (remaining < 0.5) { steps.push('0.5'); remaining *= 2; }
  if (remaining !== 1) steps.push(String(Number(remaining.toFixed(6))));
  return steps.map((step) => `atempo=${step}`).join(',');
}

/** Digital camera move at source resolution: zoompan zoom or an animated crop pan. */
function motionFilter(clip, info, timeline, { phase = 0 } = {}) {
  const motion = clip.motion;
  if (!motion) return '';
  const sourceWidth = info?.width || 0;
  const sourceHeight = info?.height || 0;
  // Without source geometry the move window cannot be sized; render the clip still.
  if (!sourceWidth || !sourceHeight) return '';
  // Resample to the project rate first so the ramp increment maps 1:1 onto output frames.
  const head = `,fps=${timeline.fps}`;
  // `phase` is the clip-local time of the first frame (0 for the render, the sampled time for a
  // preview still): the move is evaluated at that position so preview framing matches the film.
  if (motion.type === 'zoom-in' || motion.type === 'zoom-out') {
    // zoompan crops at integer pixels, which jitters at small increments; prescaling 2x halves
    // the quantization error and the project-size downscale smooths the rest.
    const prescale = sourceWidth < 2 * timeline.width;
    const width = prescale ? sourceWidth * 2 : sourceWidth;
    const height = prescale ? sourceHeight * 2 : sourceHeight;
    const increment = motion.amount / Math.max(1, clip.duration * timeline.fps);
    const zoomIn = motion.type === 'zoom-in';
    // zoompan counts output frames in `in`; shift the counter by the sampled phase.
    const frame = phase ? `(in+${exprNumber(phase * timeline.fps)})` : 'in';
    const zoom = `${zoomIn ? 'min' : 'max'}(${exprNumber(zoomIn ? 1 : 1 + motion.amount)}` +
      `${zoomIn ? '+' : '-'}${exprNumber(increment)}*${frame},${exprNumber(zoomIn ? 1 + motion.amount : 1)})`;
    return `${head}${prescale ? `,scale=${width}:${height}` : ''}` +
      `,zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1` +
      `:s=${width - width % 2}x${height - height % 2}:fps=${timeline.fps}`;
  }
  // Pan: fixed window sized (1-amount) of the source, sliding linearly over clip duration so the
  // move is total and smooth for any duration; cropping at source resolution stays subpixel-smooth
  // through the later downscale.
  const progress = `(t+${exprNumber(phase)})/${exprNumber(clip.duration)}`;
  const [xAxis, yAxis] = {
    'pan-left': [`(iw-ow)*(1-${progress})`, '(ih-oh)/2'],
    'pan-right': [`(iw-ow)*${progress}`, '(ih-oh)/2'],
    'pan-up': ['(iw-ow)/2', `(ih-oh)*(1-${progress})`],
    'pan-down': ['(iw-ow)/2', `(ih-oh)*${progress}`],
  }[motion.type];
  return `${head},crop=w='trunc(iw*(1-${motion.amount})/2)*2':h='trunc(ih*(1-${motion.amount})/2)*2'` +
    `:x='${xAxis}':y='${yAxis}'`;
}

/** geq luminance expression for one power window, evaluated in pixels at project resolution. */
function windowMaskExpression(window, width, height, peak = 255) {
  const minSide = Math.min(width, height);
  // feather 0 would divide by zero in geq; a 0.5px band reads as a hard edge.
  const feather = Math.max(window.feather * minSide, 0.5);
  const centerX = exprNumber(window.x * width);
  const centerY = exprNumber(window.y * height);
  let core;
  if (window.shape === 'circle') {
    // radius is a fraction of the frame short side; opaque inside radius, feather band inward.
    core = `(${exprNumber(window.radius * minSide)}-hypot(X-${centerX},Y-${centerY}))/${exprNumber(feather)}`;
  } else if (window.shape === 'rect') {
    const halfWidth = exprNumber(window.width * width / 2);
    const halfHeight = exprNumber(window.height * height / 2);
    core = `min(${halfWidth}-abs(X-${centerX}),${halfHeight}-abs(Y-${centerY}))/${exprNumber(feather)}`;
  } else {
    // Linear gradient: signed distance to a line through (x,y); angle runs clockwise on screen
    // (0 = opaque toward the right, 90 = downward), with the feather band centered on the line.
    const radians = window.angle * Math.PI / 180;
    const normalX = Number(Math.cos(radians).toFixed(6));
    const normalY = Number(Math.sin(radians).toFixed(6));
    core = `((${normalX}*(X-${centerX})+${normalY}*(Y-${centerY}))/${exprNumber(feather)}+0.5)`;
  }
  return `${peak}*clip(${core},0,1)*${window.opacity}`;
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
    // Validate but keep the raw object: mergeGrading layers partial clip overrides on top of
    // the project look, so normalizing here would turn omitted fields into hard defaults.
    if (clip.grading !== undefined && clip.grading !== null) normalizeGrading(clip.grading);
    return {
      ...clip, path: filePath(clip.path, `clip ${index} path`), start, duration,
      sourceIn: number(clip.sourceIn, 'clip.sourceIn', 0, MAX_DURATION, 0),
      volume: number(clip.volume, 'clip.volume', 0, 8, 1),
      track: integer(clip.track, 'clip.track', 0, 127, 0), index,
      grading: clip.grading ?? null,
      speed: number(clip.speed, 'clip.speed', 0.25, 4, 1),
      motion: validateMotion(clip.motion, index),
      windows: validateWindows(clip.windows, index),
      inputLut: validateExternalLut(clip.inputLut, index, 'inputLut'),
      lut: validateExternalLut(clip.lut, index),
    };
  });
  const duration = Math.max(...clips.map((clip) => clip.start + clip.duration));
  if (duration > MAX_DURATION) throw new RangeError('Timeline exceeds 3600 seconds');
  const captionScript = createCaptionScript({
    captions: project.captions, subtitleStyle: project.subtitleStyle, width, height, duration,
  });
  // Same for the project look: it is the base layer and must stay partial.
  if (project.look !== undefined && project.look !== null) normalizeGrading(project.look);
  const look = project.look ?? null;
  return { width, height, fps, quality, clips, duration, captionScript, look,
    fadeIn: number(project.fadeIn, 'fadeIn', 0, 5, 0),
    fadeOut: number(project.fadeOut, 'fadeOut', 0, 5, 0),
    musicStart: number(project.musicStart, 'musicStart', 0, 3600, 0),
    sharpen: number(project.sharpen, 'sharpen', 0, 2, 0),
    vignette: number(project.vignette, 'vignette', 0, 1, 0),
    glow: number(project.glow, 'glow', 0, 1, 0) };
}

/**
 * Optional per-clip LUT in .cube format. `inputLut` is the camera/vendor input transform
 * (log → display) and runs first, before the look LUT and the parameter grade; `lut` is a look
 * LUT (e.g. film emulation) that runs after `inputLut` and before the parameter grade.
 */
function validateExternalLut(lut, index, key = 'lut') {
  if (lut === undefined || lut === null || lut === '') return undefined;
  if (typeof lut !== 'string') throw new TypeError(`片段 ${index} 的 ${key} 必须是 .cube 文件路径`);
  const path = resolve(lut);
  if (extname(path).toLowerCase() !== '.cube') throw new TypeError(`片段 ${index} 的 ${key} 只支持 .cube 文件`);
  if (!existsSync(path)) throw new TypeError(`片段 ${index} 的 ${key} 文件不存在：${path}`);
  return path;
}

// Filtergraphs cannot reliably quote absolute paths containing spaces, so external LUTs are
// staged into the job directory under a generated name and referenced relatively.
async function stageExternalLut(lut, directory, cache, { signal } = {}) {
  checkAbort(signal);
  if (!cache.has(lut)) {
    const name = `extlut${cache.size}.cube`;
    await copyFile(lut, join(directory, name));
    cache.set(lut, name);
  }
  return cache.get(lut);
}

/**
 * Append the shared per-clip color chain to `filters`. This one function feeds the timeline
 * render and the grading preview, so both see the same order:
 *
 *   inputLut (camera/vendor input transform, e.g. log -> display)
 *   -> lut (optional look LUT, e.g. film emulation)
 *   -> generated grade cube (project look + clip grading, and + window grading inside a window)
 *   -> power windows blended back with a soft mask
 *
 * `inputLut` and `lut` are applied once, before any split, so a windowed clip keeps both; that
 * was previously dropped in the window branch. Window blending keeps the color branches in
 * 16-bit (`gbrp16le`), so a LUT result is not re-quantized to 8-bit before the merge; the mask
 * itself is 8-bit gray (see below), and the caller's `postSteps` decide the final pixel format
 * (the timeline still ends in yuv420p). Returns true when files (LUT copies or cubes) are
 * referenced, meaning the caller must run ffmpeg with this directory as cwd.
 */
async function appendColorChain({
  filters, inputLabel, outputLabel, clip, look, directory, cache, signal,
  cubePrefix, width, height, fps, duration, postSteps = [], writtenCubes,
}) {
  const windows = clip.windows ?? [];
  const writeCube = async (grade, name) => {
    if (writtenCubes?.has(name)) return;
    await writeCubeLut(grade, join(directory, name), { signal });
    writtenCubes?.add(name);
  };
  const pre = [];
  if (clip.inputLut) {
    pre.push(`lut3d=file=${await stageExternalLut(clip.inputLut, directory, cache, { signal })}`);
  }
  if (clip.lut) {
    pre.push(`lut3d=file=${await stageExternalLut(clip.lut, directory, cache, { signal })}`);
  }
  const baseGrade = mergeGrading(look, clip.grading);
  const baseCube = baseGrade ? `${cubePrefix}.cube` : null;
  if (baseCube) await writeCube(baseGrade, baseCube);
  // Every cube or staged LUT is referenced by a relative name, so the caller must run in `directory`.
  const files = pre.length > 0 || baseCube !== null || windows.length > 0;

  if (!windows.length) {
    const steps = [...pre];
    if (baseCube) steps.push(`lut3d=file=${baseCube}`);
    steps.push(...postSteps);
    filters.push(steps.length
      ? `[${inputLabel}]${steps.join(',')}[${outputLabel}]`
      : `[${inputLabel}]null[${outputLabel}]`);
    return files;
  }

  // Window branch. The pre-chain runs once on the shared stream, then each branch gets its own
  // merged grade; the mask is generated at the given resolution from the normalized window
  // geometry, so the preview's smaller mask is geometrically identical to the render's.
  const raw = `${cubePrefix}raw`;
  filters.push(`[${inputLabel}]format=gbrp16le${pre.length ? `,${pre.join(',')}` : ''}[${raw}]`);
  const names = ['b', ...windows.map((_, index) => `g${index}`)].map((suffix) => `${cubePrefix}${suffix}`);
  filters.push(`[${raw}]split=${windows.length + 1}${names.map((name) => `[${name}]`).join('')}`);
  filters.push(baseCube
    ? `[${names[0]}]lut3d=file=${baseCube}[${cubePrefix}base]`
    : `[${names[0]}]null[${cubePrefix}base]`);
  for (let index = 0; index < windows.length; index++) {
    const windowGrade = mergeGrading(look, clip.grading, windows[index].grading);
    const cube = `${cubePrefix}w${index}.cube`;
    await writeCube(windowGrade, cube);
    filters.push(`[${names[index + 1]}]lut3d=file=${cube}[${cubePrefix}wg${index}]`);
    // The mask stays 8-bit gray: ffmpeg negotiates geq's output depth from the graph, and a
    // 16-bit expression would silently clip to 255 (a full-frame mask). Feathering is spatial,
    // so 8-bit resolution is visually sufficient, while the color branches keep 16-bit precision.
    filters.push(`color=c=black:s=${width}x${height}:r=${fps}:d=${duration},` +
      `geq=lum='${windowMaskExpression(windows[index], width, height)}':cb=128:cr=128,` +
      `format=gray[${cubePrefix}m${index}]`);
  }
  let current = `${cubePrefix}base`;
  for (let index = 0; index < windows.length; index++) {
    const next = `${cubePrefix}mm${index}`;
    filters.push(`[${current}][${cubePrefix}wg${index}][${cubePrefix}m${index}]maskedmerge[${next}]`);
    current = next;
  }
  filters.push(postSteps.length
    ? `[${current}]${postSteps.join(',')}[${outputLabel}]`
    : `[${current}]null[${outputLabel}]`);
  return files;
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
    // Speed consumes duration*speed of source and compresses it back into clip.duration.
    if (clip.kind !== 'image' && info.duration && clip.sourceIn + clip.duration * clip.speed > info.duration + 1 / timeline.fps) {
      throw new Error(`Clip ${clip.id ?? clip.index} exceeds source duration`);
    }
  }
  for (const bed of external) if (!media.get(bed.path).hasAudio) throw new Error(`${bed.key} has no audio stream`);
  const job = await workspace(output);
  try {
    const lutCache = new Map();
    const visuals = timeline.clips.filter((clip) => clip.kind !== 'audio')
      .sort((a, b) => a.track - b.track || a.index - b.index);
    let usesRelativeFiles = Boolean(timeline.captionScript);

    const clipInputArgs = (clip) => {
      const input = [];
      if (clip.kind === 'image') input.push('-loop', '1', '-framerate', String(timeline.fps));
      else input.push('-ss', String(clip.sourceIn));
      input.push('-t', String(clip.kind === 'image' ? clip.duration : clip.duration * clip.speed), '-i', clip.path);
      return input;
    };

    // Shared per-clip visual chain: trim/speed → motion → scale/pad → shared color chain
    // (inputLut → lut → grade → power windows) → fps/format, optionally offset to the clip's
    // absolute timeline position. Pushes filter lines and returns the chain's output label.
    const clipVisualChain = async (clip, inputLabel, filters, { offset }) => {
      const info = media.get(clip.path);
      // Speed: -t consumed duration*speed of source, so trim at that length, then compress PTS
      // back to clip.duration. Images have no finite source and ignore speed.
      const trimDuration = clip.kind === 'image' ? clip.duration : clip.duration * clip.speed;
      let head = `[${inputLabel}]trim=duration=${trimDuration},setpts=PTS-STARTPTS`;
      if (clip.speed !== 1 && clip.kind !== 'image') head += `,setpts=PTS/${clip.speed}`;
      head += motionFilter(clip, info, timeline);
      head += `,scale=${timeline.width}:${timeline.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
        `pad=${timeline.width}:${timeline.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
      // Grade LUTs run at the decoded bit depth (10-bit sources keep their precision through
      // lut3d); the yuv420p conversion moves after the color chain, not before it.
      const post = [`fps=${timeline.fps}`, 'format=yuv420p'];
      if (offset) post.push(`setpts=PTS+${clip.start}/TB`);
      const label = offset ? `v${clip.index}` : `x${clip.index}`;
      const pre = `pre${clip.index}`;
      filters.push(`${head}[${pre}]`);
      if (await appendColorChain({
        filters, inputLabel: pre, outputLabel: label, clip, look: timeline.look,
        directory: job.temporary, cache: lutCache, signal, cubePrefix: `grade${clip.index}`,
        width: timeline.width, height: timeline.height, fps: timeline.fps,
        duration: clip.duration, postSteps: post,
      })) usesRelativeFiles = true;
      return label;
    };

    // Decode cost tracks source resolution, not just timeline duration: 4K HEVC 10-bit
    // sources need several times the budget of 1080p H.264 footage.
    const outputArea = Math.max(1, timeline.width * timeline.height);
    const sourceRatio = Math.max(1, ...timeline.clips.filter((clip) => clip.kind !== 'image').map((clip) => {
      const info = media.get(clip.path);
      return info?.width && info?.height ? (info.width * info.height) / outputArea : 1;
    }));
    // zoompan and geq masks are per-pixel CPU filters; give timelines using them 1.5x the budget.
    const motionHeavy = timeline.clips.some((clip) => clip.motion || clip.windows.length);

    // Timelines with many simultaneous 4K decoders exhaust memory in a single filter graph;
    // render clips to project-sized intermediates in small batches first, then composite the
    // cheap H.264 intermediates with audio, captions and polish in one final pass.
    const batched = visuals.length > 10;
    const intermediates = [];
    if (batched) {
      const batchSize = 6;
      for (let start = 0; start < visuals.length; start += batchSize) {
        checkAbort(signal);
        const batch = visuals.slice(start, start + batchSize);
        const batchArgs = ['-v', 'error', '-filter_complex_threads', '1'];
        const batchFilters = [];
        const outputs = [];
        for (const [position, clip] of batch.entries()) {
          batchArgs.push(...clipInputArgs(clip));
          const label = await clipVisualChain(clip, `${position}:v:0`, batchFilters, { offset: false });
          outputs.push({ label, name: `clip${clip.index}.mp4` });
        }
        await writeFile(join(job.temporary, `batch${start}.txt`), batchFilters.join(';\n'), { encoding: 'utf8', signal });
        // FFmpeg 8 deprecates -filter_complex_script in favour of the graph-file prefix.
        batchArgs.push('-/filter_complex', `batch${start}.txt`);
        for (const output of outputs) {
          batchArgs.push('-map', `[${output.label}]`, '-c:v', 'libx264', '-preset', 'fast', '-crf', '16',
            '-pix_fmt', 'yuv420p', '-r', String(timeline.fps), '-an', output.name);
        }
        usesRelativeFiles = true;
        const batchSeconds = batch.reduce((total, clip) => total + clip.duration * clip.speed, 0);
        const batchTimeout = Math.min(1_800_000,
          Math.round((180_000 + batchSeconds * 8000) * Math.min(3, sourceRatio) * (motionHeavy ? 1.5 : 1)));
        await ffmpeg(batchArgs, { cwd: job.temporary, signal, timeout: batchTimeout });
        intermediates.push(...outputs.map((output) => output.name));
        onProgress?.(Math.min(0.85, 0.85 * (start + batch.length) / visuals.length));
      }
    }

    const args = ['-v', 'error', '-filter_complex_threads', '1'];
    if (batched) for (const name of intermediates) args.push('-i', name);
    else for (const clip of timeline.clips) args.push(...clipInputArgs(clip));
    // Silent clip tracks (volume 0) add pure silence; skipping their inputs keeps the final
    // pass from re-opening heavy sources just to mix zeros.
    const audioClips = timeline.clips.filter((clip) => clip.kind !== 'image' && clip.volume > 0 && media.get(clip.path).hasAudio);
    const audioInputIndex = new Map();
    if (batched) {
      for (const [position, clip] of audioClips.entries()) {
        args.push('-ss', String(clip.sourceIn), '-t', String(clip.duration * clip.speed), '-i', clip.path);
        audioInputIndex.set(clip.index, visuals.length + position);
      }
    }
    for (const bed of external) {
      if (bed.key === 'musicPath') {
        args.push('-stream_loop', '-1');
        if (timeline.musicStart) {
          // The bed loops, so musicStart lands at the same audible position modulo the track
          // length; seeking there avoids past-EOF seek quirks on short beds.
          const info = media.get(bed.path);
          const offset = info.duration > 0 ? timeline.musicStart % info.duration : timeline.musicStart;
          args.push('-ss', offset.toFixed(3));
        }
      }
      args.push('-t', String(timeline.duration), '-i', bed.path);
    }
    const filters = [
      `color=c=black:s=${timeline.width}x${timeline.height}:r=${timeline.fps}:d=${timeline.duration},format=yuv420p[base]`,
    ];
    let previous = 'base';
    for (const [position, clip] of visuals.entries()) {
      const label = batched ? `v${clip.index}` : await clipVisualChain(clip, `${clip.index}:v:0`, filters, { offset: true });
      if (batched) filters.push(`[${position}:v:0]setpts=PTS+${clip.start}/TB[${label}]`);
      const next = `composite${clip.index}`;
      // repeatlast defaults to on: a clip whose intermediate ends a frame short of the enable
      // window holds its last frame instead of punching a black gap (the "flicker" at cuts).
      filters.push(`[${previous}][${label}]overlay=eof_action=pass:enable='gte(t,${clip.start})*lt(t,${clip.start + clip.duration})'[${next}]`);
      previous = next;
    }
    const polish = [];
    if (timeline.sharpen > 0) polish.push(`unsharp=5:5:${timeline.sharpen}`);
    if (timeline.vignette > 0) {
      // Map 0..1 onto a subtle-to-strong lens angle: PI/8 barely darkens, PI/2 crushes corners.
      polish.push(`vignette=angle=${(Math.PI / 8 + timeline.vignette * (Math.PI / 2 - Math.PI / 8)).toFixed(6)}`);
    }
    if (polish.length) {
      filters.push(`[${previous}]${polish.join(',')}[polished]`);
      previous = 'polished';
    }
    // Soft glow ("柔光"): blurred copy screen-blended back over the picture, before captions
    // so subtitles stay crisp. 适中 ≈ 0.4 → sigma 9.6, opacity 0.24.
    // Screen must run in RGB: on yuv420p the neutral chroma planes (128) are screened as if they
    // were signal, so a neutral gray Y=128 came out as RGB(168,126,175). RGB screen keeps
    // neutrals neutral; the picture returns to yuv420p for the caption/fade tail.
    if (timeline.glow > 0) {
      const sigma = (4 + 14 * timeline.glow).toFixed(2);
      const opacity = (0.12 + 0.3 * timeline.glow).toFixed(3);
      filters.push(`[${previous}]format=gbrp,split=2[glowBase][glowSrc];` +
        `[glowSrc]gblur=sigma=${sigma},format=gbrp[glowBlur];` +
        `[glowBase][glowBlur]blend=all_mode=screen:all_opacity=${opacity},format=yuv420p[glowed]`);
      previous = 'glowed';
    }
    if (timeline.captionScript) {
      await writeFile(join(job.temporary, 'captions.ass'), timeline.captionScript, { encoding: 'utf8', signal });
      // Only a fixed relative filename enters the graph; Windows paths stay in spawn's cwd.
      filters.push(`[${previous}]ass=filename=captions.ass[captioned]`);
      previous = 'captioned';
    }
    // Fades run last on the finished composite so captions and polish fade along with the picture.
    const fades = [];
    if (timeline.fadeIn) fades.push(`fade=t=in:st=0:d=${timeline.fadeIn}`);
    if (timeline.fadeOut) fades.push(`fade=t=out:st=${Math.max(0, timeline.duration - timeline.fadeOut)}:d=${timeline.fadeOut}`);
    if (fades.length) {
      filters.push(`[${previous}]${fades.join(',')}[faded]`);
      previous = 'faded';
    }
    const audioLabels = [];
    for (const clip of audioClips) {
      const inputIndex = batched ? audioInputIndex.get(clip.index) : clip.index;
      const label = `a${clip.index}`;
      // Match the video speed-up: trim the consumed source range, then compress tempo.
      const tempo = clip.speed !== 1 ? `${atempoFilters(clip.speed)},` : '';
      filters.push(`[${inputIndex}:a:0]atrim=duration=${clip.duration * clip.speed},asetpts=PTS-STARTPTS,${tempo}` +
        `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${clip.volume},` +
        `adelay=${Math.round(clip.start * 48000)}S:all=1[${label}]`);
      audioLabels.push(`[${label}]`);
    }
    const externalLabels = new Map();
    // In the batched final pass only intermediates + audible clip audio precede the beds.
    const bedBase = batched ? visuals.length + audioClips.length : timeline.clips.length;
    for (const [index, bed] of external.entries()) {
      const label = `bed${index}`;
      filters.push(`[${bedBase + index}:a:0]atrim=duration=${timeline.duration},asetpts=PTS-STARTPTS,` +
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
      let audioChain = `${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0:dropout_transition=0,` +
        `apad,atrim=duration=${timeline.duration},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000`;
      if (timeline.fadeIn) audioChain += `,afade=t=in:st=0:d=${timeline.fadeIn}`;
      if (timeline.fadeOut) audioChain += `,afade=t=out:st=${Math.max(0, timeline.duration - timeline.fadeOut)}:d=${timeline.fadeOut}`;
      filters.push(`${audioChain}[audio]`);
    }
    const script = join(job.temporary, 'filters.txt');
    await writeFile(script, filters.join(';\n'), { encoding: 'utf8', signal });
    // FFmpeg 8 deprecates -filter_complex_script; the graph file is passed as a plain argument.
    args.push('-/filter_complex', script, '-map', `[${previous}]`);
    if (audioLabels.length) args.push('-map', '[audio]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
    else args.push('-an');
    args.push(...videoEncoding(timeline.quality), '-r', String(timeline.fps), '-t', String(timeline.duration));
    if (['.mp4', '.mov'].includes(extname(output).toLowerCase())) args.push('-movflags', '+faststart');
    args.push('-progress', 'pipe:1', '-nostats', job.staged);
    let pending = '';
    let last = batched ? 0.85 : 0;
    onProgress?.(last);
    const timeout = batched
      ? Math.min(1_800_000, Math.round(180_000 + timeline.duration * 4000))
      : Math.min(1_800_000, Math.round((120_000 + timeline.duration * 5000) * Math.min(3, sourceRatio) *
        (motionHeavy ? 1.5 : 1)));
    await ffmpeg(args, {
      cwd: usesRelativeFiles ? job.temporary : undefined,
      signal, timeout,
      onStdout: (chunk) => {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('out_time_us=')) continue;
          const seconds = Number(line.slice('out_time_us='.length)) / 1e6;
          if (!Number.isFinite(seconds)) continue;
          const fraction = Math.max(last, Math.min(0.999,
            batched ? 0.85 + 0.15 * seconds / timeline.duration : seconds / timeline.duration));
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

/** Before/after grading comparison sheet plus quantitative guardrail stats for AI review. */
export async function gradePreview({ project, outputPath, framesPerClip = 3, signal, onProgress } = {}) {
  if (signal?.aborted) throw abortError();
  if (onProgress !== undefined && typeof onProgress !== 'function') throw new TypeError('onProgress must be a function');
  const timeline = validateProject(project);
  const output = filePath(outputPath, 'outputPath');
  if (!['.png', '.jpg', '.jpeg'].includes(extname(output).toLowerCase())) throw new TypeError('Grade preview output must be .png or .jpg');
  const samples = integer(framesPerClip, 'framesPerClip', 1, 8, 3);
  const visuals = timeline.clips.filter((clip) => clip.kind !== 'audio');
  if (!visuals.length) throw new Error('时间线没有视觉片段，无法生成调色预览');
  // renderTimeline creates its output directory; the preview sheet must do the same so a nested
  // outputPath works the same way.
  await mkdir(dirname(output), { recursive: true });
  const staging = await mkdtemp(join(dirname(output), '.eac-grade-'));
  const previewLutCache = new Map();
  // One cell size for both columns, fitted inside a bounded 480x270 box at the project aspect.
  // The render only changes pixel density, not shape, so window masks and motion framing line up.
  const previewWidth = timeline.width / timeline.height >= 16 / 9
    ? 480
    : Math.max(2, Math.round(270 * timeline.width / timeline.height / 2) * 2);
  const previewHeight = timeline.width / timeline.height >= 16 / 9
    ? Math.max(2, Math.round(480 * timeline.height / timeline.width / 2) * 2)
    : 270;
  // Motion needs the source geometry; only probe clips that actually move.
  const mediaCache = new Map();
  const sourceInfo = async (clip) => {
    if (!clip.motion) return null;
    if (!mediaCache.has(clip.path)) mediaCache.set(clip.path, await probeMedia(clip.path, { signal }));
    return mediaCache.get(clip.path);
  };
  try {
    const pairs = [];
    const stats = [];
    const writtenCubes = new Set();
    const planned = visuals.reduce((n, clip) => n + (clip.kind === 'image' ? 1 : samples), 0);
    let done = 0;
    for (const clip of visuals) {
      const takes = clip.kind === 'image' ? 1 : samples;
      const grade = mergeGrading(timeline.look, clip.grading);
      const colorWork = Boolean(grade) || Boolean(clip.inputLut) || Boolean(clip.lut)
        || (clip.windows ?? []).length > 0;
      for (let take = 0; take < takes; take++) {
        // Speed widens the consumed source range; sample inside duration*speed.
        const at = clip.kind === 'image' ? 0 : clip.sourceIn + (clip.duration * (take + 0.5) / takes) * clip.speed;
        // The render compresses source time by speed, so the clip-local position of this sample is
        // what the motion ramp must be evaluated at. Images are sampled at their start.
        const phase = clip.kind === 'image' ? 0 : Math.max(0, (at - clip.sourceIn) / clip.speed);
        const info = await sourceInfo(clip);
        const original = await extractPreviewFrame({
          at, staging, name: `f${clip.index}_${take}_o`, signal,
          width: previewWidth, height: previewHeight, clip, info, phase, fps: timeline.fps,
        });
        // The graded frame runs through the same color chain the render uses, including power
        // windows, so the comparison sheet shows what the film will actually look like.
        const gradedPath = colorWork
          ? await gradedPreviewFrame({
              clip, info, phase, fps: timeline.fps, look: timeline.look, at, staging,
              name: `f${clip.index}_${take}_g`, cache: previewLutCache, writtenCubes,
              width: previewWidth, height: previewHeight, signal,
            })
          : original;
        const originalStats = await frameStats(original, { signal });
        const gradedStats = gradedPath === original ? { ...originalStats } : await frameStats(gradedPath, { signal });
        pairs.push({ original, graded: gradedPath });
        stats.push({
          clipId: clip.id ?? String(clip.index), clipIndex: clip.index,
          sourceTime: Math.round(at * 100) / 100,
          grade: grade ? describeGrading(grade) : null,
          mergedPreset: grade ? grade.preset ?? null : null,
          mergedExposure: grade ? grade.exposure : null,
          inputLut: Boolean(clip.inputLut), lut: Boolean(clip.lut),
          windows: (clip.windows ?? []).length,
          original: originalStats, graded: gradedStats,
        });
        done++;
        onProgress?.((done / planned) * 0.85);
      }
    }
    const rows = pairs.length;
    // 140 个 -i 输入会撑爆 Windows 命令行长度上限；改走 concat 列表文件（单输入）。
    const list = join(staging, 'pairs.txt');
    const quote = (path) => `file '${path.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
    const entries = pairs.flatMap((pair) => [quote(pair.original), quote(pair.graded)]);
    await writeFile(list, `${entries.join('\n')}\n`, { encoding: 'utf8', signal });
    const args = ['-v', 'error', '-r', '25', '-f', 'concat', '-safe', '0', '-i', list];
    args.push('-vf', `tile=2x${rows}:padding=6:margin=6:color=white`, '-frames:v', '1', '-update', '1', output);
    await ffmpeg(args, { signal, timeout: 120_000 });
    onProgress?.(1);
    return {
      path: output,
      layout: { columns: 2, left: '原始画面', right: '当前调色', rows,
        reading: '每行同帧对比：左列原始、右列当前调色；行顺序为片段入点顺序，同一片段多行均匀取样' },
      gradedApplied: stats.some((item) => item.grade || item.inputLut || item.lut || item.windows > 0),
      frames: stats, warnings: gradingGuardrails(stats), reviewRequired: true,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Extract one comparison frame. Both columns share this framing: the render's motion move runs
 * before scale/pad, so the preview applies the same motion filter (evaluated at the sampled
 * clip-local phase) and then the same scale/pad into the shared cell size.
 * A still image is fed like the render does (`-loop 1`), so time-dependent motion has a clock.
 */
function previewInputArgs(clip, at, fps) {
  return clip.kind === 'image'
    ? ['-loop', '1', '-framerate', String(fps), '-i', clip.path]
    : ['-ss', String(Math.max(0, at)), '-i', clip.path];
}

async function extractPreviewFrame({ at, staging, name, signal, width, height, clip, info, phase, fps }) {
  const out = join(staging, `${name}.png`);
  const motion = motionFilter(clip, info, { fps, width, height }, { phase }).replace(/^,/, '');
  const filter = `${motion ? `${motion},` : ''}` +
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;
  await ffmpeg(['-v', 'error', ...previewInputArgs(clip, at, fps), '-frames:v', '1', '-vf', filter, '-update', '1', out],
    { cwd: staging, signal, timeout: 60_000 });
  return out;
}

/** Extract one preview frame through the render's shared color chain (inputLut → lut → grade → windows). */
async function gradedPreviewFrame({ clip, info, phase, fps, look, at, staging, name, cache, writtenCubes, width, height, signal }) {
  const out = join(staging, `${name}.png`);
  const filters = [];
  const motion = motionFilter(clip, info, { fps, width, height }, { phase }).replace(/^,/, '');
  filters.push(`[0:v]${motion ? `${motion},` : ''}scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[preview]`);
  await appendColorChain({
    filters, inputLabel: 'preview', outputLabel: 'graded', clip, look, directory: staging, cache, signal,
    cubePrefix: `preview${clip.index}`, width, height, fps, duration: 1, writtenCubes,
    // The sheet is assembled from both sides with the concat demuxer, which needs one pixel
    // format; the graded side is finalized to 8-bit exactly like the rendered film.
    postSteps: ['format=rgb24'],
  });
  await ffmpeg(['-v', 'error', ...previewInputArgs(clip, at, fps), '-frames:v', '1',
    '-filter_complex', filters.join(';'), '-map', '[graded]', '-update', '1', out],
    { cwd: staging, signal, timeout: 60_000 });
  return out;
}

/** RGB-space luma/saturation statistics from one still frame, used as grading guardrails. */
async function frameStats(path, { signal } = {}) {
  const { stdout } = await run(FFMPEG,
    ['-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { signal, timeout: 30_000, maxBytes: 64 * 2 ** 20 });
  const pixels = stdout.length / 3;
  if (!pixels) throw new Error('无法解码预览帧');
  let min = 255, max = 0, sum = 0, satSum = 0, bright = 0, dark = 0;
  for (let i = 0; i < stdout.length; i += 3) {
    const r = stdout[i], g = stdout[i + 1], b = stdout[i + 2];
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
    if (y < min) min = y;
    if (y > max) max = y;
    sum += y;
    satSum += hi === 0 ? 0 : (hi - lo) / hi;
    if (y >= 250) bright++;
    if (y <= 5) dark++;
  }
  const round = (value, digits = 2) => Number((value).toFixed(digits));
  return {
    lumaMin: round(min, 1), lumaMax: round(max, 1), lumaAvg: round(sum / pixels, 1),
    saturationAvg: round(satSum / pixels), highlightClip: round(bright / pixels, 3), shadowCrush: round(dark / pixels, 3),
  };
}

function gradingGuardrails(stats) {
  const warnings = [];
  const round = (value) => Math.round(value);
  // Clip guardrails are paired per frame: comparing the global worst original against the global
  // worst graded frame lets a frame that already clips (e.g. 9.8%) mask a different frame that
  // only starts clipping after grading (5%). Each frame is measured against its own original, and
  // the aggregate reports how much new clipping the grade adds across the whole timeline.
  const NEW_CLIP = 0.002;
  const paired = stats.map((item) => ({
    item,
    highlight: item.graded.highlightClip - item.original.highlightClip,
    shadow: item.graded.shadowCrush - item.original.shadowCrush,
  }));
  const clipped = paired.filter((row) => row.highlight > NEW_CLIP && row.item.graded.highlightClip > NEW_CLIP);
  if (clipped.length) {
    const worst = clipped.reduce((a, b) => (b.highlight > a.highlight ? b : a));
    const added = clipped.reduce((total, row) => total + row.highlight, 0) / stats.length;
    warnings.push(`调色后新增高光触顶（Y≥250）：${clipped.length}/${stats.length} 帧受影响，最严重一帧「${worst.item.clipId}」` +
      `由 ${(worst.item.original.highlightClip * 100).toFixed(1)}% 增至 ${(worst.item.graded.highlightClip * 100).toFixed(1)}%` +
      `（新增 ${(worst.highlight * 100).toFixed(1)}%），全片平均新增 ${(added * 100).toFixed(1)}%；` +
      '存在高光裁切风险，建议降曝光或高光 gain。');
  }
  const crushed = paired.filter((row) => row.shadow > NEW_CLIP && row.item.graded.shadowCrush > NEW_CLIP);
  if (crushed.length) {
    const worst = crushed.reduce((a, b) => (b.shadow > a.shadow ? b : a));
    const added = crushed.reduce((total, row) => total + row.shadow, 0) / stats.length;
    warnings.push(`调色后新增暗部触底（Y≤5）：${crushed.length}/${stats.length} 帧受影响，最严重一帧「${worst.item.clipId}」` +
      `由 ${(worst.item.original.shadowCrush * 100).toFixed(1)}% 增至 ${(worst.item.graded.shadowCrush * 100).toFixed(1)}%` +
      `（新增 ${(worst.shadow * 100).toFixed(1)}%），全片平均新增 ${(added * 100).toFixed(1)}%；` +
      '暗部可能死黑，建议提 lift 或降对比。');
  }
  const saturation = stats.reduce((n, item) => n + item.graded.saturationAvg, 0) / stats.length;
  if (saturation > 0.45) warnings.push(`平均饱和度 ${saturation.toFixed(2)} 偏高，警惕过艳失真。`);
  // 夜景 look（neon-night/lantern-night 预设或深度负曝光）是有意压暗，不参与偏暗统计；
  // 若整条时间线都是夜景 grade，则不触发偏暗警告。
  const night = (row) => row.mergedPreset === 'neon-night' || row.mergedPreset === 'lantern-night' ||
    (typeof row.mergedExposure === 'number' && row.mergedExposure <= -0.35);
  const daylight = stats.filter((row) => !night(row));
  if (daylight.length) {
    const dayLuma = daylight.reduce((n, item) => n + item.graded.lumaAvg, 0) / daylight.length;
    if (dayLuma < 102) warnings.push(`整体平均亮度 ${round(dayLuma)}/255 偏暗，风景片建议 102–191。`);
  }
  const luma = stats.reduce((n, item) => n + item.graded.lumaAvg, 0) / stats.length;
  if (luma > 191) warnings.push(`整体平均亮度 ${round(luma)}/255 偏亮，风景片建议 102–191。`);
  const lumaSpread = stats.map((item) => item.graded.lumaAvg);
  if (lumaSpread.length > 1 && Math.max(...lumaSpread) - Math.min(...lumaSpread) > 38) {
    warnings.push('片段间平均亮度差超过 38/255，多个镜头观感不一致；建议用统一 look 或对齐曝光。');
  }
  return warnings;
}

/** Decode validation plus duration/stream checks; content warnings are not hard failures. */
export async function qualityCheck({ path, expectedDuration, signal } = {}) {  checkAbort(signal);
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

/**
 * One-shot scopes sheet for a video or still: luminance waveform on top, color vectorscope below.
 * ffmpeg 8 removed the scope filters' size options, so both branches are scaled to 960x540
 * explicitly before stacking.
 */
export async function createScopes({ path, outputPath, signal } = {}) {
  checkAbort(signal);
  const source = filePath(path, 'path');
  await access(source);
  const output = filePath(outputPath, 'outputPath');
  if (extname(output).toLowerCase() !== '.png') throw new TypeError('Scopes output must be a .png file');
  await mkdir(dirname(output), { recursive: true });
  // Frame 0 of a film with fadeIn is pure black; sample a representative mid-film frame instead.
  let seek = [];
  try {
    const media = await probeMedia(source, { signal });
    if (media.duration > 1.5) seek = ['-ss', (media.duration * 0.4).toFixed(2)];
  } catch { /* probe failure falls back to the first frame */ }
  await ffmpeg([...seek, '-v', 'error', '-i', source, '-filter_complex',
    '[0:v]split[a][b];[a]scale=960:540,waveform[w0];[b]vectorscope=mode=color3[s0];' +
    '[w0]scale=960:540[w];[s0]scale=960:540[s];[w][s]vstack=2',
    '-frames:v', '1', '-update', '1', output], { signal, timeout: 120_000 });
  checkAbort(signal);
  return {
    path: output,
    layout: {
      top: '波形 Waveform（左暗右亮）',
      bottom: '矢量示波器 Vectorscope（角度=色相，离中心距离=饱和度）',
    },
  };
}
