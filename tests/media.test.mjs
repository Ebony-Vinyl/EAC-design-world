import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import {
  probeMedia, analyzeMedia, analyzeBeats, recordBrowser, recordDesktop,
  synthesizeVoice, composeMusic, renderTimeline, qualityCheck,
} from '../src/media/index.mjs';

let directory;
let red;
let blue;
let image;
let tone;

function command(executable, args, { includeStderr = false } = {}) {
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
      else resolve(includeStderr ? { stdout: Buffer.concat(chunks), stderr: errors } : Buffer.concat(chunks));
    });
  });
}

async function waitUntil(predicate, timeout = 10_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error('Timed out waiting for active media work');
}

function assertExited(pid) {
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `Process ${pid} still exists after cancellation`);
}

async function cancelAtProcess(operation, predicate, ready) {
  const controller = new AbortController();
  const processes = [];
  let timer;
  let abortedAt;
  let readinessFailure;
  const started = ({ process: child }) => {
    child.once('spawn', () => {
      processes.push(child.pid);
      if (timer === undefined && predicate(child)) {
        timer = setTimeout(async () => {
          try { if (ready) await waitUntil(ready); } catch (error) {
            readinessFailure = error;
          } finally {
            abortedAt = performance.now();
            controller.abort();
          }
        }, 10);
      }
    });
  };
  const events = channel('child_process');
  events.subscribe(started);
  const safety = setTimeout(() => controller.abort(), 15_000);
  try {
    await assert.rejects(operation(controller.signal), { name: 'AbortError' });
    if (readinessFailure) throw readinessFailure;
    assert.ok(abortedAt, 'the requested OS process actually started before cancellation');
    assert.ok(performance.now() - abortedAt < 5000, 'cancellation should finish within 5 seconds');
    for (const pid of processes) assertExited(pid);
  } finally {
    clearTimeout(timer);
    clearTimeout(safety);
    events.unsubscribe(started);
  }
}

async function nestedFile(directory, predicate) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const result = await nestedFile(path, predicate);
      if (result) return result;
    } else if (predicate(entry.name) && (await stat(path)).size > 44) return path;
  }
  return null;
}

async function windowsProcessTree(root) {
  const script = `
    $root = '${root.replaceAll("'", "''")}'
    $all = @(Get-CimInstance Win32_Process)
    $ids = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($item in $all) {
      if ($item.CommandLine -and $item.CommandLine.Contains($root)) { [void]$ids.Add([int]$item.ProcessId) }
    }
    do {
      $changed = $false
      foreach ($item in $all) {
        if ($ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)) { $changed = $true }
      }
    } while ($changed)
    @($ids) | ConvertTo-Json -Compress
  `;
  const result = await command('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
  const parsed = JSON.parse(result.toString('utf8').trim() || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}

function fixture(args) {
  return command('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...args]);
}

async function pixel(path, time, x = 32, y = 32) {
  const buffer = await fixture(['-ss', String(time), '-i', path,
    '-vf', `crop=2:2:${x}:${y},scale=1:1`, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
  assert.equal(buffer.length, 3);
  return [...buffer];
}

async function pcm(path, start, duration = 0.2) {
  return fixture(['-ss', String(start), '-i', path, '-t', String(duration),
    '-map', '0:a:0', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-']);
}

function rms(buffer) {
  let sum = 0;
  for (let index = 0; index < buffer.length; index += 4) sum += buffer.readFloatLE(index) ** 2;
  return Math.sqrt(sum / (buffer.length / 4));
}

function frequencyPower(buffer, hz) {
  let real = 0;
  let imaginary = 0;
  const samples = buffer.length / 4;
  for (let index = 0; index < samples; index++) {
    const value = buffer.readFloatLE(index * 4);
    real += value * Math.cos(2 * Math.PI * hz * index / 8000);
    imaginary += value * Math.sin(2 * Math.PI * hz * index / 8000);
  }
  return Math.hypot(real, imaginary) / samples;
}

before(async () => {
  // Exercise Unicode, whitespace and an apostrophe without shell interpolation.
  directory = await mkdtemp(join(tmpdir(), "eac \u4e2d\u6587 ' media "));
  red = join(directory, '\u7ea2 scene.mp4');
  blue = join(directory, 'blue portrait.mp4');
  image = join(directory, 'still image.png');
  tone = join(directory, 'voice tone.wav');
  await fixture(['-f', 'lavfi', '-i', 'color=c=red:s=96x64:r=20:d=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', red]);
  await fixture(['-f', 'lavfi', '-i', 'color=c=blue:s=32x64:r=20:d=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', blue]);
  await fixture(['-f', 'lavfi', '-i', 'color=c=lime:s=64x32',
    '-frames:v', '1', '-update', '1', image]);
  await fixture(['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=0.35', tone]);
});

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('probe and actual decoded content analysis report video/audio properties', async () => {
  const media = await probeMedia(red);
  assert.equal(media.width, 96);
  assert.equal(media.height, 64);
  assert.equal(media.fps, 20);
  assert.equal(media.hasAudio, true);
  assert.equal(media.hasVideo, true);
  assert.ok(Math.abs(media.duration - 2) < 0.1);
  assert.ok(media.streams.some((stream) => stream.codec_name === 'h264'));
  const analysis = await analyzeMedia(red);
  assert.ok(analysis.audio.peakDb < -10 && analysis.audio.peakDb > -25);
  assert.equal(analysis.blackSegments.length, 0);
  assert.ok(analysis.frozenSegments.length || analysis.frozenOpenStart !== null);
});

test('black interval timestamps come from actual blackdetect logs', async () => {
  const source = join(directory, 'black then red.mp4');
  await fixture(['-f', 'lavfi', '-i', 'color=c=black:s=96x64:r=20:d=0.6',
    '-f', 'lavfi', '-i', 'color=c=red:s=96x64:r=20:d=0.6',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
  const result = await analyzeMedia(source);
  assert.equal(result.blackSegments.length, 1);
  assert.ok(result.blackSegments[0].start < 0.05);
  assert.ok(Math.abs(result.blackSegments[0].end - 0.6) < 0.06);
});

test('render actually trims, sequences, letterboxes and mixes original audio', async () => {
  const output = join(directory, '\u6210\u7247 sequence.mp4');
  const progress = [];
  const result = await renderTimeline({
    project: { width: 96, height: 64, fps: 20, clips: [
      { path: red, kind: 'video', start: 0, sourceIn: 0.25, duration: 0.5 },
      { path: blue, kind: 'video', start: 0.5, duration: 0.5 },
      { path: image, kind: 'image', start: 1, duration: 0.5 },
    ] },
    outputPath: output,
    onProgress: (value) => progress.push(value),
  });
  assert.equal(result.hasAudio, true);
  assert.equal(result.width, 96);
  assert.ok(Math.abs(result.duration - 1.5) < 0.1);
  assert.equal(progress[0], 0);
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.every((value, index) => index === 0 || value >= progress[index - 1]));
  const redPixel = await pixel(output, 0.2);
  assert.ok(redPixel[0] > 200 && redPixel[2] < 30);
  const bluePixel = await pixel(output, 0.7, 48, 32);
  assert.ok(bluePixel[2] > 200 && bluePixel[0] < 30);
  const letterbox = await pixel(output, 0.7, 4, 32);
  assert.ok(letterbox.every((channel) => channel < 20));
  const greenPixel = await pixel(output, 1.2, 48, 32);
  assert.ok(greenPixel[1] > 200 && greenPixel[0] < 30);
  assert.ok(rms(await pcm(output, 0.1)) > 0.02);
  assert.ok(rms(await pcm(output, 0.65)) < 0.005);
  assert.equal((await qualityCheck({ path: output, expectedDuration: 1.5 })).ok, true);
});

test('track ordering, explicit gaps and video-only output', async () => {
  const output = join(directory, 'layers.mp4');
  const result = await renderTimeline({
    project: { width: 96, height: 64, fps: 20, clips: [
      { path: image, kind: 'image', start: 0.25, duration: 0.75, track: 4 },
      { path: blue, kind: 'video', start: 0.25, duration: 0.75, track: 0 },
    ] }, outputPath: output,
  });
  assert.equal(result.hasAudio, false);
  assert.ok((await pixel(output, 0.05)).every((channel) => channel < 20));
  assert.ok((await pixel(output, 0.5, 48, 32))[1] > 200);
});

test('sourceIn trims real changing source content', async () => {
  const changing = join(directory, 'changing.mp4');
  await fixture(['-f', 'lavfi', '-i', 'color=c=red:s=96x64:r=20:d=0.5',
    '-f', 'lavfi', '-i', 'color=c=blue:s=96x64:r=20:d=0.5',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', changing]);
  const output = join(directory, 'trim.mp4');
  await renderTimeline({
    project: { width: 96, height: 64, fps: 20, clips: [
      { path: changing, kind: 'video', sourceIn: 0.5, start: 0, duration: 0.4 },
    ] }, outputPath: output,
  });
  assert.ok((await pixel(output, 0.1))[2] > 200);
});

test('external voice and looped bed mix with original audio; voice does not loop', async () => {
  const output = join(directory, 'mix.mp4');
  const bed = join(directory, 'bed.wav');
  await fixture(['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=0.25', bed]);
  await renderTimeline({
    project: { width: 96, height: 64, fps: 20, musicPath: bed, voicePath: tone,
      clips: [{ path: red, kind: 'video', start: 0, duration: 1, volume: 0.5 }] },
    outputPath: output,
  });
  const early = await pcm(output, 0.05);
  assert.ok(frequencyPower(early, 220) > 0.005, 'music present');
  assert.ok(frequencyPower(early, 440) > 0.01, 'original audio present');
  assert.ok(frequencyPower(early, 880) > 0.02, 'voice present');
  const late = await pcm(output, 0.65);
  assert.ok(frequencyPower(late, 220) > 0.005, 'short bed actually loops');
  assert.ok(frequencyPower(late, 880) < 0.002, 'voice finishes');
});

test('audio clips honor start, sourceIn and volume', async () => {
  const output = join(directory, 'audio timeline.mp4');
  await renderTimeline({
    project: { width: 96, height: 64, fps: 20, clips: [
      { path: tone, kind: 'audio', start: 0.3, sourceIn: 0.05, duration: 0.25, volume: 0.5 },
    ] }, outputPath: output,
  });
  assert.ok(rms(await pcm(output, 0, 0.15)) < 0.002);
  assert.ok(rms(await pcm(output, 0.32, 0.15)) > 0.02);
});

test('narration stays audible, music recovers, and encoded loudness meets the target', async (context) => {
  const voice = join(directory, 'controlled narration.wav');
  const music = join(directory, 'loud background.wav');
  const output = join(directory, 'audible narration.mp4');
  await fixture(['-f', 'lavfi', '-i',
    "aevalsrc='if(between(t,2,3.5),0.18*sin(2*PI*880*t),0)':s=48000:d=6", voice]);
  await fixture(['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=0.5',
    '-af', 'volume=4', music]);
  await renderTimeline({
    project: { width: 96, height: 64, fps: 20, musicPath: music, voicePath: voice,
      clips: [{ path: image, kind: 'image', duration: 6 }] },
    outputPath: output,
  });
  const before = await pcm(output, 0.8, 0.4);
  const during = await pcm(output, 2.5, 0.4);
  const after = await pcm(output, 5, 0.4);
  const baseline = frequencyPower(before, 220);
  const reduced = frequencyPower(during, 220);
  const narration = frequencyPower(during, 880);
  assert.ok(reduced < baseline * 0.5, 'background becomes quieter during narration');
  assert.ok(narration > reduced * 4, 'narration exceeds simultaneous music by at least 12 dB');
  assert.ok(frequencyPower(after, 220) > baseline * 0.7, 'music recovers after narration');
  assert.ok(frequencyPower(after, 880) < narration * 0.02, 'narration is not repeated');
  const { stderr } = await command('ffmpeg', ['-hide_banner', '-nostdin', '-i', output,
    '-map', '0:a:0', '-af', 'loudnorm=I=-16:TP=-1.5:print_format=json', '-f', 'null', '-'],
  { includeStderr: true });
  const measurement = JSON.parse(stderr.match(/\{\s*"input_i"[\s\S]*?\}/)[0]);
  assert.ok(Math.abs(Number(measurement.input_i) + 16) < 1.5, 'encoded mix is within 1.5 LU of -16 LUFS');
  assert.ok(Number(measurement.input_tp) <= -1.0, 'AAC true peak stays below -1 dBTP');
  context.diagnostic(`Encoded mix: ${measurement.input_i} LUFS, ${measurement.input_tp} dBTP; narration/music ${(20 * Math.log10(narration / reduced)).toFixed(1)} dB`);
});

test('production preserves more source detail than draft', async (context) => {
  const source = join(directory, 'moving reference.mkv');
  await fixture(['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=20:d=0.6', '-c:v', 'ffv1', source]);
  const frames = (path) => fixture(['-i', path, '-map', '0:v:0', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', '-']);
  const reference = await frames(source);
  const errors = {};
  for (const quality of ['draft', 'production']) {
    const output = join(directory, `${quality}.mp4`);
    await renderTimeline({
      project: { width: 160, height: 96, fps: 20, quality,
        clips: [{ path: source, kind: 'video', duration: 0.6 }] },
      outputPath: output,
    });
    const decoded = await frames(output);
    assert.equal(decoded.length, reference.length);
    let sum = 0;
    for (let index = 0; index < reference.length; index++) sum += (reference[index] - decoded[index]) ** 2;
    errors[quality] = sum / reference.length;
  }
  assert.ok(errors.production < errors.draft, 'production should reduce measured distortion');
  context.diagnostic(`Decoded pixel MSE: draft=${errors.draft.toFixed(3)}, production=${errors.production.toFixed(3)}`);
});

test('portrait 4K dimensions render and fractional frame rates are rejected', async () => {
  const output = join(directory, 'portrait 4K.mp4');
  const project = { width: 2160, height: 3840, fps: 10, quality: 'draft',
    clips: [{ path: image, kind: 'image', duration: 0.2 }] };
  const result = await renderTimeline({ project, outputPath: output });
  assert.equal(result.width, 2160);
  assert.equal(result.height, 3840);
  assert.equal(result.fps, 10);
  assert.ok((await pixel(output, 0, 1080, 1920))[1] > 200);
  await assert.rejects(renderTimeline({ project: { ...project, fps: 29.97 }, outputPath: output }), /integer/);
  await assert.rejects(renderTimeline({ project: { ...project, quality: 'unknown' }, outputPath: output }), /quality/);
});

test('music is actual non-silent deterministic stereo audio and beats are measured', async () => {
  const first = join(directory, 'music one.wav');
  const second = join(directory, 'music two.wav');
  const other = join(directory, 'music other.wav');
  const result = await composeMusic({ outputPath: first, duration: 4, bpm: 120, seed: 'demo' });
  await composeMusic({ outputPath: second, duration: 4, bpm: 120, seed: 'demo' });
  await composeMusic({ outputPath: other, duration: 4, bpm: 120, seed: 'different' });
  assert.equal(result.hasAudio, true);
  assert.equal(result.streams[0].channels, 2);
  assert.equal(result.duration, 4);
  assert.deepEqual(await readFile(first), await readFile(second));
  assert.notDeepEqual(await readFile(first), await readFile(other));
  assert.ok(rms(await pcm(first, 0.1)) > 0.03);
  const beats = await analyzeBeats(first, { bpm: 120 });
  assert.equal(beats.bpm, 120);
  assert.ok(beats.beats.length >= 7 && beats.beats.length <= 9);
  assert.ok(beats.confidence > 0.1);
  assert.ok(Math.abs(beats.beats[1] - beats.beats[0] - 0.5) < 0.021);
  const estimated = await analyzeBeats(first);
  assert.ok(estimated.bpm >= 50 && estimated.bpm <= 200);
  assert.ok(estimated.confidence > 0.1);
  const mp3 = await composeMusic({ outputPath: join(directory, 'encoded.mp3'), duration: 0.3 });
  assert.equal(mp3.streams[0].codec_name, 'mp3');
});

test('silence has no fabricated beats and quality checks flag silence and duration', async () => {
  const silent = join(directory, 'silent.wav');
  await fixture(['-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '0.5', silent]);
  const beats = await analyzeBeats(silent);
  assert.equal(beats.bpm, null);
  assert.deepEqual(beats.beats, []);
  assert.equal(beats.confidence, 0);
  const quality = await qualityCheck({ path: silent, expectedDuration: 1 });
  assert.equal(quality.ok, false);
  assert.ok(quality.errors.some((error) => error.includes('Duration')));
  assert.ok(quality.warnings.some((warning) => warning.includes('silent')));
  await assert.rejects(analyzeBeats(blue), /No audio/);
});

test('quality checks reject damaged audio packets even when metadata remains readable', async () => {
  const broken = join(directory, 'damaged.wav');
  const bytes = await readFile(tone);
  await writeFile(broken, bytes.subarray(0, bytes.length - 1));
  assert.equal((await probeMedia(broken)).hasAudio, true);
  const quality = await qualityCheck({ path: broken });
  assert.equal(quality.ok, false);
  assert.ok(quality.errors.some((error) => error.includes('Decode failed')));
});

test('bad inputs and missing media fail without replacing an existing output', async () => {
  const output = join(directory, 'preserve.mp4');
  const original = Buffer.from('existing user file');
  await writeFile(output, original);
  const project = { width: 96, height: 64, fps: 20, clips: [
    { path: red, kind: 'video', duration: 0.5 },
  ] };
  await assert.rejects(renderTimeline({ project: { ...project, musicPath: join(directory, 'missing.wav') }, outputPath: output }), /ENOENT/);
  await assert.rejects(renderTimeline({ project: { ...project, voicePath: blue }, outputPath: output }), /no audio/);
  await assert.rejects(renderTimeline({ project: { ...project, clips: [{ path: red, kind: 'video', duration: 20 }] }, outputPath: output }), /exceeds source/);
  await assert.rejects(renderTimeline({ project: { ...project, width: 95 }, outputPath: output }), /even/);
  await assert.rejects(renderTimeline({ project: { ...project, clips: [{ path: blue, kind: 'audio', duration: 0.5 }] }, outputPath: output }), /lacks/);
  await assert.rejects(renderTimeline({ project, outputPath: red }), /differ/);
  assert.deepEqual(await readFile(output), original);
  const invalid = join(directory, 'invalid media.mp4');
  await writeFile(invalid, 'not a video');
  await assert.rejects(probeMedia(invalid), /ffprobe exited/);
  await assert.rejects(qualityCheck({ path: invalid }), /ffprobe exited/);
  await assert.rejects(composeMusic({ outputPath: join(directory, 'bad.xyz'), duration: 0.1 }), /ffmpeg exited/);
  await assert.rejects(composeMusic({ outputPath: output, duration: Infinity }), /finite number/);
  await assert.rejects(recordBrowser({ url: 'https://example.com', outputDir: directory, actions: [{ type: 'execute' }] }), /Unsupported/);
  await assert.rejects(analyzeBeats(tone, { bpm: 0 }), /bpm/);
});

test('cancellation before and during encoding preserves output and removes staging', async () => {
  const output = join(directory, 'cancelled.mp4');
  const original = Buffer.from('keep me');
  await writeFile(output, original);
  const project = { width: 1280, height: 720, fps: 30,
    clips: [{ path: image, kind: 'image', start: 0, duration: 30 }] };
  const before = new AbortController();
  before.abort();
  await assert.rejects(renderTimeline({ project, outputPath: output, signal: before.signal }), { name: 'AbortError' });
  const during = new AbortController();
  let started = false;
  const timeout = setTimeout(() => during.abort(), 15_000);
  try {
    await assert.rejects(renderTimeline({
      project, outputPath: output, signal: during.signal,
      onProgress: (fraction) => { if (fraction > 0) { started = true; during.abort(); } },
    }), { name: 'AbortError' });
  } finally { clearTimeout(timeout); }
  assert.equal(started, true, 'encoder produced progress before cancellation');
  assert.deepEqual(await readFile(output), original);
  assert.ok(!(await readdir(directory)).some((name) => name.startsWith('.eac-media-')));
});

test('progress callback failures propagate and clean temporary output', async () => {
  const output = join(directory, 'callback.mp4');
  const original = Buffer.from('preserve after callback failure');
  await writeFile(output, original);
  await assert.rejects(renderTimeline({
    project: { width: 96, height: 64, clips: [{ path: image, kind: 'image', duration: 3 }] },
    outputPath: output,
    onProgress: (fraction) => { if (fraction > 0) throw new Error('consumer failed'); },
  }), /consumer failed/);
  assert.deepEqual(await readFile(output), original);
  assert.ok(!(await readdir(directory)).some((name) => name.startsWith('.eac-media-')));
});

test('all entry points reject an already aborted signal before creating work', async () => {
  const controller = new AbortController();
  controller.abort();
  const { signal } = controller;
  const absent = join(directory, 'pre-cancelled', 'output.mp4');
  const operations = [
    () => probeMedia(red, { signal }),
    () => analyzeMedia(red, { signal }),
    () => analyzeBeats(tone, { signal }),
    () => qualityCheck({ path: red, signal }),
    () => recordBrowser({ url: 'data:text/html,test', outputDir: join(directory, 'pre-cancelled'), signal }),
    () => recordDesktop({ outputPath: absent, duration: 60, signal }),
    () => synthesizeVoice({ text: 'Test', outputPath: absent, signal }),
    () => composeMusic({ outputPath: absent, duration: 600, signal }),
    () => renderTimeline({ signal }),
  ];
  for (const operation of operations) await assert.rejects(operation(), { name: 'AbortError' });
  await assert.rejects(stat(join(directory, 'pre-cancelled')), { code: 'ENOENT' });
});

test('probe, analysis, beats and QA cancellation stop their actual subprocesses', async () => {
  await cancelAtProcess((signal) => probeMedia(red, { signal }), (child) => /ffprobe(?:\.exe)?$/i.test(child.spawnfile));
  const decoder = (child) => /ffmpeg(?:\.exe)?$/i.test(child.spawnfile);
  await cancelAtProcess((signal) => analyzeMedia(red, { signal }), decoder);
  await cancelAtProcess((signal) => analyzeBeats(red, { signal }), decoder);
  await cancelAtProcess((signal) => qualityCheck({ path: red, signal }), decoder);
});

test('music cancellation interrupts PCM generation and conversion without replacing output', async () => {
  const output = join(directory, 'cancelled music.wav');
  const original = Buffer.from('keep original music');
  await writeFile(output, original);
  const controller = new AbortController();
  const outcome = composeMusic({ outputPath: output, duration: 600, signal: controller.signal })
    .then(() => null, (error) => error);
  try {
    await waitUntil(() => nestedFile(directory, (name) => name === 'music.wav'));
    const started = performance.now();
    controller.abort();
    const error = await outcome;
    assert.equal(error?.name, 'AbortError', error?.stack);
    assert.ok(performance.now() - started < 3000);
  } finally {
    controller.abort();
    await outcome;
  }
  assert.deepEqual(await readFile(output), original);
  await cancelAtProcess((signal) => composeMusic({
    outputPath: join(directory, 'cancel conversion.mp3'), duration: 0.5, signal,
  }), (child) => /ffmpeg(?:\.exe)?$/i.test(child.spawnfile));
  assert.ok(!(await readdir(directory)).some((name) => name.startsWith('.eac-media-')));
});

test('Windows desktop and SAPI cancellation terminate their OS processes', { skip: process.platform !== 'win32' }, async () => {
  const output = join(directory, 'cancel OS capture.wav');
  const original = Buffer.from('preserve this output');
  await writeFile(output, original);
  await cancelAtProcess((signal) => recordDesktop({
    outputPath: join(directory, 'cancel desktop.mp4'), duration: 60, fps: 10, signal,
  }), (child) => /ffmpeg(?:\.exe)?$/i.test(child.spawnfile),
  () => nestedFile(directory, (name) => name === 'result.mp4'));
  await cancelAtProcess((signal) => synthesizeVoice({
    text: 'A long speech recording must be cancellable. '.repeat(350), rate: -10, outputPath: output, signal,
  }), (child) => /powershell(?:\.exe)?$/i.test(child.spawnfile),
  () => nestedFile(directory, (name) => name === 'speech.wav'));
  assert.deepEqual(await readFile(output), original);
  assert.ok(!(await readdir(directory)).some((name) => name.startsWith('.eac-media-')));
});

test('browser cancellation stops active frames and leaves no worker or Edge descendants', async (context) => {
  try { await import('playwright'); } catch {
    context.skip('Root Playwright dependency has not been installed');
    return;
  }
  const outputDir = join(directory, 'cancel browser');
  await cancelAtProcess((signal) => recordBrowser({
    url: 'data:text/html,<body style="background:red">Launch cancellation</body>',
    outputDir, width: 320, height: 240, signal,
  }), (child) => child.spawnargs.some((arg) => arg.endsWith('browser-worker.mjs')));
  const controller = new AbortController();
  const outcome = recordBrowser({
    url: 'data:text/html,<body style="background:green">Active frame cancellation</body>',
    outputDir, width: 320, height: 240, actions: [{ type: 'wait', ms: 30_000 }], signal: controller.signal,
  }).then(() => null, (error) => error);
  try {
    await waitUntil(() => nestedFile(outputDir, (name) => name === 'frame-00001.jpg'), 60_000);
    const pids = process.platform === 'win32' ? await windowsProcessTree(outputDir) : [];
    if (process.platform === 'win32') assert.ok(pids.length >= 2, 'real worker and browser processes should exist');
    const started = performance.now();
    controller.abort();
    const error = await outcome;
    assert.equal(error?.name, 'AbortError', error?.stack);
    assert.ok(performance.now() - started < (process.platform === 'win32' ? 15000 : 5000),
      'capture stops within the process-tree termination deadline during an outstanding wait');
    for (const pid of pids) assertExited(pid);
    assert.deepEqual(await readdir(outputDir), []);
  } finally {
    controller.abort();
    await outcome;
  }
});

test('Windows SAPI produces audible speech and an unknown voice fails explicitly', {
  skip: process.platform !== 'win32',
}, async () => {
  const output = join(directory, '\u8bed\u97f3 speech.wav');
  const speech = await synthesizeVoice({ text: 'Media execution test. One, two, three.', outputPath: output });
  assert.ok(speech.duration > 0.2);
  assert.equal(speech.hasAudio, true);
  assert.ok((await analyzeMedia(output)).audio.peakDb > -45);
  await assert.rejects(synthesizeVoice({
    text: 'Test', outputPath: join(directory, 'bad voice.wav'), voice: 'EAC Voice That Does Not Exist',
  }), /powershell.*exited/i);
});

test('Playwright records real browser actions into nonblank footage', async (context) => {
  try { await import('playwright'); } catch {
    context.skip('Root Playwright dependency has not been installed');
    return;
  }
  const page = join(directory, 'browser fixture.html');
  await writeFile(page, '<!doctype html><html><body style="margin:0;background:#ff0000;height:1800px">' +
    '<input id="name"><button id="go" onclick="document.body.style.background=\'#00ff00\'">Change</button></body></html>');
  const result = await recordBrowser({
    url: pathToFileURL(page).href, width: 320, height: 240, outputDir: directory,
    actions: [
      { type: 'fill', selector: '#name', text: '\u4e2d\u6587 text' },
      { type: 'wait', ms: 200 },
      { type: 'click', selector: '#go' },
      { type: 'wait', ms: 300 },
      { type: 'scroll', deltaY: 100 },
    ],
  });
  assert.equal(result.hasVideo, true);
  assert.equal(result.width, 320);
  assert.ok(result.duration >= 0.5);
  const late = await pixel(result.path, Math.max(0, result.duration - 0.15), 160, 120);
  assert.ok(late[1] > 200 && late[0] < 30);
  await assert.rejects(recordBrowser({
    url: pathToFileURL(page).href, outputDir: directory, width: 320, height: 240,
    actions: [{ type: 'click', selector: '#missing-button' }],
  }), /Timeout/);
  assert.ok(!(await readdir(directory)).some((name) => name.startsWith('.eac-media-')));
});

test('Windows desktop capture produces actual frames', { skip: process.platform !== 'win32' }, async () => {
  const result = await recordDesktop({ outputPath: join(directory, 'desktop.mp4'), duration: 0.3, fps: 10 });
  assert.equal(result.hasVideo, true);
  assert.ok(result.width >= 320);
  assert.ok(result.duration >= 0.2 && result.duration < 2);
});
