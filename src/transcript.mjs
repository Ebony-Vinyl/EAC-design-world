import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/transcribe.py', import.meta.url));
const UNCONFIGURED_MODEL = 'EAC_WHISPER_MODEL_UNCONFIGURED';
const MAX_JSON_BYTES = 16 * 1024 * 1024;

function abortError() {
  return Object.assign(new Error('Transcription aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
}

// There is no bundled or machine-specific default: a model that was never configured must never be
// guessed from someone's disk layout. The distinct code lets callers tell "not configured" apart
// from "configured but unusable" (a missing directory surfaces as the worker's own ValueError).
function unconfiguredModelError() {
  return Object.assign(new Error(
    'No local Whisper model is configured: set EAC_WHISPER_MODEL_PATH to a local faster-whisper model directory',
  ), { code: UNCONFIGURED_MODEL });
}

function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}

function filePath(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new TypeError(`${name} must be a nonempty local filesystem path`);
  }
  return resolve(value);
}

function selectedModel(modelPath) {
  if (modelPath !== undefined && modelPath !== null) return filePath(modelPath, 'modelPath');
  // An absent variable means "not configured"; a present but blank one stays an invalid-path
  // TypeError, so the two failures remain distinguishable.
  const configured = process.env.EAC_WHISPER_MODEL_PATH;
  if (configured === undefined) throw unconfiguredModelError();
  return filePath(configured, 'EAC_WHISPER_MODEL_PATH');
}

function runPython(args, { signal, timeout = 900_000 } = {}) {
  checkAbort(signal);
  return new Promise((complete, reject) => {
    const executable = process.env.EAC_PYTHON || process.env.PYTHON || 'python';
    const child = spawn(executable, ['-X', 'utf8', SCRIPT, ...args], {
      shell: false, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
    });
    let stderr = '';
    const stdoutChunks = [];
    let bytes = 0;
    let failure;
    let termination;
    const stop = (error) => {
      failure ??= error;
      if (termination) return;
      if (!child.pid) return;
      if (process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        termination = Promise.resolve();
        return;
      }
      termination = new Promise((done) => {
        const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'],
          { shell: false, windowsHide: true, stdio: 'ignore' });
        const limit = setTimeout(() => {
          killer.kill('SIGKILL');
          child.kill('SIGKILL');
        }, 5000);
        killer.once('error', () => child.kill('SIGKILL'));
        killer.once('close', (code) => {
          clearTimeout(limit);
          if (code !== 0) child.kill('SIGKILL');
          done();
        });
      });
    };
    const abort = () => stop(abortError());
    const timer = setTimeout(() => stop(new Error(`Transcription timed out after ${timeout}ms`)), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    child.once('spawn', () => { if (failure || signal?.aborted) stop(failure ?? abortError()); });
    if (signal?.aborted) abort();
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) stop(new Error('Transcription exceeded its process output limit'));
      else stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      bytes += chunk.length;
      stderr = (stderr + chunk.toString('utf8')).slice(-65536);
      if (bytes > 1024 * 1024) stop(new Error('Transcription exceeded its process output limit'));
    });
    child.once('error', (error) => { failure ??= error; });
    child.once('close', async (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      await termination;
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Local transcription exited with code ${code}: ${stderr.trim()}`));
      else {
        try { complete(JSON.parse(Buffer.concat(stdoutChunks).toString('utf8'))); } catch {
          reject(new Error('Local transcription returned invalid JSON'));
        }
      }
    });
  });
}

/** Checks the local CPU/int8 model and dependencies without downloading anything. */
export async function transcriptCapabilities() {
  let modelPath;
  try {
    modelPath = selectedModel();
    const result = await runPython(['--capabilities', '--model-path', modelPath], { timeout: 30_000 });
    return { available: result.available === true, detail: result.detail, modelPath };
  } catch (error) {
    return { available: false, detail: error.message, modelPath: modelPath ?? null };
  }
}

/** Local ASR; at most 30 minutes of decoded audio and 15 minutes of worker time. */
export async function transcribeMedia({ path, outputDir, modelPath, language, signal } = {}) {
  checkAbort(signal);
  path = filePath(path, 'path');
  outputDir = filePath(outputDir, 'outputDir');
  modelPath = selectedModel(modelPath);
  if (language !== undefined && (typeof language !== 'string' || !/^[a-z]{2,3}$/.test(language))) {
    throw new TypeError('language must be a two or three letter lowercase Whisper language code');
  }
  const source = await stat(path);
  if (!source.isFile() || source.size === 0 || source.size > 2 * 1024 ** 3) {
    throw new Error('Transcription input must be a nonempty file of at most 2 GiB');
  }
  checkAbort(signal);
  await mkdir(outputDir, { recursive: true });
  const temporary = await mkdtemp(join(outputDir, '.eac-transcript-'));
  const stem = `transcript-${randomUUID()}`;
  const srtPath = join(outputDir, `${stem}.srt`);
  const jsonPath = join(outputDir, `${stem}.json`);
  let publishedSrt = false;
  let publishedJson = false;
  let success = false;
  try {
    const args = ['--input', path, '--output-dir', temporary, '--model-path', modelPath];
    if (language !== undefined) args.push('--language', language);
    await runPython(args, { signal });
    checkAbort(signal);
    const stagedJson = join(temporary, 'transcript.json');
    if ((await stat(stagedJson)).size > MAX_JSON_BYTES) throw new Error('Transcript exceeds 16 MiB');
    const result = JSON.parse(await readFile(stagedJson, 'utf8'));
    if (!Array.isArray(result.segments) || typeof result.language !== 'string' || result.modelPath !== modelPath) {
      throw new Error('Invalid local transcript result');
    }
    validateSegments(result.segments);
    for (const segment of result.segments) {
      if (!Array.isArray(segment.words)) throw new Error('Transcript is missing word timestamps');
      for (const word of segment.words) {
        if (!Number.isFinite(word.probability) || word.probability < 0 || word.probability > 1) {
          throw new Error('Invalid word probability');
        }
      }
    }
    checkAbort(signal);
    await rename(join(temporary, 'transcript.srt'), srtPath);
    publishedSrt = true;
    checkAbort(signal);
    await rename(stagedJson, jsonPath);
    publishedJson = true;
    checkAbort(signal);
    success = true;
    return { segments: result.segments, language: result.language, srtPath, jsonPath, modelPath };
  } finally {
    if (!success) {
      if (publishedSrt) await rm(srtPath, { force: true });
      if (publishedJson) await rm(jsonPath, { force: true });
    }
    await rm(temporary, { recursive: true, force: true });
  }
}

function validInterval(value) {
  return value && Number.isFinite(value.start) && Number.isFinite(value.end)
    && value.start >= 0 && value.end > value.start;
}

function validateSegments(segments) {
  if (!Array.isArray(segments) || segments.length > 100_000) {
    throw new TypeError('segments must be an array of at most 100000 timestamped segments');
  }
  let wordCount = 0;
  for (const segment of segments) {
    if (!validInterval(segment) || typeof segment.text !== 'string') {
      throw new TypeError('Each segment needs finite nonnegative start, end > start, and text');
    }
    if (segment.words !== undefined) {
      if (!Array.isArray(segment.words)) throw new TypeError('words must be an array');
      wordCount += segment.words.length;
      if (wordCount > 500_000) throw new TypeError('Too many word timestamps');
      for (const word of segment.words) {
        // Whisper can emit zero-duration punctuation; it cannot define a speech interval.
        if (!word || !Number.isFinite(word.start) || !Number.isFinite(word.end)
          || word.start < segment.start - 0.001 || word.end > segment.end + 0.001
          || word.end < word.start || typeof word.word !== 'string') {
          throw new TypeError('Word timestamps must lie within their segment');
        }
      }
    }
  }
}

function mergeRanges(ranges, gap = 0, barriers = []) {
  const merged = [];
  let barrier = 0;
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous) {
      while (barrier < barriers.length && barriers[barrier].end <= previous.end) barrier++;
      const blocked = barriers[barrier]?.start < range.start;
      if (range.start <= previous.end || (!blocked && range.start - previous.end < gap)) {
        previous.end = Math.max(previous.end, range.end);
        continue;
      }
    }
    merged.push({ start: range.start, end: range.end });
  }
  return merged;
}

const readable = (text) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const filler = (text) => /^(?:um+|uh+|erm+)$/.test(readable(text));

/**
 * Deterministic timestamp proposals, never semantic duplicate removal.
 * Defaults: minGap=0.6s, padding=0.12s, removeFillers=false.
 * Only aligned "um", "uh", and "erm" tokens are eligible for optional removal.
 * Missing/incomplete word alignment preserves the complete readable segment.
 * Padding stays within [0, latest segment end]; callers may clamp to media duration.
 */
export function generateKeepRanges(segments, { minGap = 0.6, padding = 0.12, removeFillers = false } = {}) {
  validateSegments(segments);
  for (const [name, value] of Object.entries({ minGap, padding })) {
    if (!Number.isFinite(value) || value < 0 || value > 60) {
      throw new TypeError(`${name} must be a finite number between 0 and 60 seconds`);
    }
  }
  if (typeof removeFillers !== 'boolean') throw new TypeError('removeFillers must be boolean');
  const speech = [];
  const removed = [];
  let duration = 0;
  for (const segment of segments) {
    duration = Math.max(duration, segment.end);
    if (!segment.text.trim()) continue;
    const words = segment.words?.filter((word) => word.word.trim());
    const aligned = words?.length && words.every(validInterval)
      && readable(words.map((word) => word.word).join('')) === readable(segment.text);
    if (!aligned) {
      speech.push({ start: segment.start, end: segment.end });
      continue;
    }
    for (const word of words) {
      (removeFillers && filler(word.word) ? removed : speech).push({ start: word.start, end: word.end });
    }
  }
  const ordered = (a, b) => a.start - b.start || a.end - b.end;
  speech.sort(ordered);
  removed.sort(ordered);
  const protectedSpeech = mergeRanges(speech);
  // An overlapping segment can protect speech inside an apparent filler interval.
  let cursor = 0;
  const barriers = mergeRanges(removed.filter((range) => {
    while (cursor < protectedSpeech.length && protectedSpeech[cursor].end <= range.start) cursor++;
    return !protectedSpeech[cursor] || protectedSpeech[cursor].start >= range.end;
  }));
  const ranges = mergeRanges(protectedSpeech, minGap, barriers);
  cursor = 0;
  for (const range of ranges) {
    while (cursor < barriers.length && barriers[cursor].end <= range.start) cursor++;
    const lower = cursor > 0 ? barriers[cursor - 1].end : 0;
    const upper = cursor < barriers.length ? barriers[cursor].start : duration;
    range.start = Math.max(lower, 0, range.start - padding);
    range.end = Math.min(upper, duration, range.end + padding);
  }
  return mergeRanges(ranges);
}
