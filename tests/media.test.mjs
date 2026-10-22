import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import {
  probeMedia, analyzeMedia, analyzeBeats, recordBrowser, recordDesktop,
  synthesizeVoice, composeMusic, renderTimeline, qualityCheck,
  cleanupStaging, encodingTimeout, decodeTimeout, filterScriptOption, randomGenerator,
} from '../src/media/index.mjs';

let directory;
let red;
let blue;
let image;
let tone;
let mixedDurations;

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
  // CI runners have no interactive desktop and share the CPU, so terminating the
  // SAPI/desktop process tree takes longer than on a developer machine. The hard part of
  // this assertion — every captured pid has exited — is unchanged; only the wait budget grows.
  const cancelDeadlineMs = Number(process.env.EAC_CANCEL_DEADLINE_MS) || (process.env.EAC_CI ? 20_000 : 5_000);
  try {
    await assert.rejects(operation(controller.signal), { name: 'AbortError' });
    if (readinessFailure) throw readinessFailure;
    assert.ok(abortedAt, 'the requested OS process actually started before cancellation');
    assert.ok(performance.now() - abortedAt < cancelDeadlineMs, `cancellation should finish within ${cancelDeadlineMs} ms`);
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
  // A 2 s picture track inside a 10 s container: no -shortest, so the audio
  // stream keeps running long after the picture ends.
  mixedDurations = join(directory, 'mixed durations.mp4');
  await fixture(['-f', 'lavfi', '-i', 'color=c=red:s=96x64:r=10:d=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=10',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', mixedDurations]);
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

test('clip bounds follow the stream a clip reads, not the container duration', async () => {
  const mixed = await probeMedia(mixedDurations);
  // The container reports the audio length; the picture track ends at 2 s.
  assert.ok(Math.abs(mixed.duration - 10) < 0.3, `container duration was ${mixed.duration}`);
  assert.ok(Math.abs(mixed.videoDuration - 2) < 0.3, `video duration was ${mixed.videoDuration}`);
  assert.ok(Math.abs(mixed.audioDuration - 10) < 0.3, `audio duration was ${mixed.audioDuration}`);

  // Seeking past the end of the picture track used to render one black second
  // and still pass quality check (black frames were a warning, not an error).
  await assert.rejects(renderTimeline({
    project: { width: 96, height: 64, fps: 10, clips: [
      { path: mixedDurations, kind: 'video', start: 0, sourceIn: 6, duration: 1 },
    ] }, outputPath: join(directory, 'past-video-end.mp4'),
  }), /exceeds source duration \(video stream/);

  // The same offset is legitimate for the audio track, which really is 10 s long.
  const audioOnly = await renderTimeline({
    project: { width: 96, height: 64, fps: 10, clips: [
      { path: mixedDurations, kind: 'audio', start: 0, sourceIn: 6, duration: 1 },
    ] }, outputPath: join(directory, 'audio-tail.mp4'),
  });
  assert.ok(Math.abs(audioOnly.duration - 1) < 0.2, `audio clip duration was ${audioOnly.duration}`);
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

test('Windows desktop and SAPI cancellation terminate their OS processes', { skip: process.platform !== 'win32' }, async (t) => {
  if (process.env.EAC_CI) {
    // GitHub's Windows runners have no interactive desktop, so ffmpeg's gdigrab input cannot
    // start (or terminate) there; the same applies to SAPI, which blocks the PowerShell host
    // for far longer than any cancellation budget. Neither failure says anything about the
    // cancellation code, which is covered on an interactive Windows machine.
    t.skip('CI runner 没有交互桌面：桌面录制与 SAPI 取消无法在此验证');
    return;
  }
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
    await waitUntil(() => nestedFile(outputDir, (name) => name === 'frame-00001.jpg'), 20_000);
    const pids = process.platform === 'win32' ? await windowsProcessTree(outputDir) : [];
    if (process.platform === 'win32') assert.ok(pids.length >= 2, 'real worker and browser processes should exist');
    const started = performance.now();
    controller.abort();
    const error = await outcome;
    assert.equal(error?.name, 'AbortError', error?.stack);
    assert.ok(performance.now() - started < 5000, 'capture stops promptly during an outstanding wait');
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

// ---------------------------------------------------------------------------
// Regression tests for the media fixes. Each one fails without its fix.
// ---------------------------------------------------------------------------

// A real "file is in use" lock. Node's own handles are opened with
// FILE_SHARE_DELETE and never block deletion, so PowerShell holds the file with
// FileShare.None - what a still-running ffmpeg/Edge does to a staging file.
// POSIX needs no lock: an unlink inside a directory without write permission
// fails with EACCES, which the cleanup loop retries exactly the same way.
// The block ends on a timer in the holder process, not on a marker file: a
// failed recursive rm still unlinks the files it can reach, so a marker inside
// the staging tree could disappear before anyone observes it.
async function blockRemoval(directory, { holdMs = 300 } = {}) {
  const inner = join(directory, 'inner');
  await mkdir(inner, { recursive: true });
  const busy = join(inner, 'busy.bin');
  await writeFile(busy, 'locked');
  if (process.platform !== 'win32') {
    await chmod(inner, 0o500);
    const timer = setTimeout(() => { chmod(inner, 0o700).catch(() => {}); }, holdMs);
    timer.unref();
    return { stop: async () => { clearTimeout(timer); await chmod(inner, 0o700).catch(() => {}); } };
  }
  const ready = `${directory}.ready.marker`;
  const quote = (value) => value.replaceAll("'", "''");
  const script = [
    `$handle = [System.IO.File]::Open('${quote(busy)}', 'Open', 'Read', 'None')`,
    `Set-Content -LiteralPath '${quote(ready)}' -Value 'locked'`,
    `Start-Sleep -Milliseconds ${holdMs}`,
    '$handle.Close()',
  ].join('; ');
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { shell: false, windowsHide: true, stdio: 'ignore' });
  await waitUntil(() => stat(ready).then(() => true, () => false), 20_000);
  return { stop: async () => { child.kill(); await delay(200); } };
}

test('staging cleanup retries a transient lock instead of leaving the directory behind', async () => {
  const staging = join(directory, '.eac-media-locked profile');
  // Blocked for 300 ms: the first attempt lands while the file is still open, so
  // only a retrying cleanup can remove the directory. Without the retry loop
  // .eac-media-* survives, and a browser profile (hundreds of MB) leaks.
  const lock = await blockRemoval(staging, { holdMs: 300 });
  const failures = [];
  try {
    const started = performance.now();
    await cleanupStaging(staging, { onFailure: (error) => failures.push(error.code) });
    assert.ok(performance.now() - started < 5000, 'cleanup must finish inside its retry budget');
    assert.deepEqual(failures, []);
    await assert.rejects(stat(staging), { code: 'ENOENT' });
  } finally {
    await lock.stop().catch(() => {});
  }
});

test('a cleanup failure is reported without replacing the error that ended the operation', async () => {
  const staging = join(directory, '.eac-media-stuck profile');
  // Held for far longer than the retry budget, so the removal cannot succeed.
  const lock = await blockRemoval(staging, { holdMs: 10_000 });
  const failures = [];
  try {
    const started = performance.now();
    await assert.rejects((async () => {
      try {
        throw Object.assign(new Error('Media operation aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
      } finally {
        // Exactly how every entry point cleans up. A throw here would surface as
        // EBUSY/EPERM and hide that the caller's operation was cancelled.
        await cleanupStaging(staging, { onFailure: (error) => failures.push(error) });
      }
    })(), { name: 'AbortError' });
    const elapsed = performance.now() - started;
    assert.equal(failures.length, 1, 'the removal failure must still be reported');
    assert.ok(['EBUSY', 'EPERM', 'EACCES'].includes(failures[0].code), failures[0].code);
    assert.ok(elapsed < 5000, `a stuck staging directory must not stall the operation (${Math.round(elapsed)} ms)`);
  } finally {
    await lock.stop().catch(() => {});
  }
});

test('every entry point shares the retrying cleanup and the scaled encode budget', async () => {
  const source = await readFile(new URL('../src/media/index.mjs', import.meta.url), 'utf8');
  // README: "Cleanup retries transient Windows file locks for up to 750 ms".
  // Only recordBrowser used to retry; desktop, SAPI, music and render used a
  // bare rm in `finally`, which could replace the real error.
  assert.ok(!/rm\(\s*job\.temporary/.test(source), 'staging removal must go through cleanupStaging');
  const sites = source.match(/cleanupStaging\(job\.temporary\)/g) ?? [];
  assert.ok(sites.length >= 5, `browser, desktop, voice, music and render must all retry cleanup (found ${sites.length})`);
  assert.ok(source.includes('timeout: encodingTimeout(timeline)'), 'render must use the scaled encode budget');
});

test('the encode budget scales with pixels and seconds instead of a fixed 15 minutes', () => {
  const hourHdProduction = encodingTimeout({ width: 1920, height: 1080, duration: 3600, quality: 'production' });
  const hourHdDraft = encodingTimeout({ width: 1920, height: 1080, duration: 3600 });
  // MAX_DURATION promises 3600 s timelines; a flat 900 s cap killed the legal
  // long render and then deleted its staged output in `finally`.
  assert.ok(hourHdProduction > 900_000, `1 h of 1080p production was allowed only ${hourHdProduction} ms`);
  assert.ok(hourHdDraft > 900_000, `1 h of 1080p draft was allowed only ${hourHdDraft} ms`);
  assert.ok(encodingTimeout({ width: 1920, height: 1080, duration: 600 }) < hourHdDraft, 'budget grows with duration');
  const hourUhdProduction = encodingTimeout({ width: 3840, height: 2160, duration: 3600, quality: 'production' });
  assert.ok(hourUhdProduction >= hourHdProduction, '4K needs at least as much time as 1080p');
  // Still bounded, so a hung encoder cannot hold a job queue slot forever.
  assert.ok(hourUhdProduction <= 8 * 3_600_000, `encode budget is unbounded: ${hourUhdProduction} ms`);
  // Short renders keep a tight budget.
  const shortHd = encodingTimeout({ width: 1920, height: 1080, duration: 5 });
  assert.ok(shortHd < hourHdDraft);
  assert.ok(shortHd <= 900_000, `a 5 s render inherited ${shortHd} ms`);
});

test('an unusable "0/0" average frame rate falls back to r_frame_rate', async () => {
  // Mixed-rate MKV: ffprobe reports avg_frame_rate "0/0", which is truthy, so
  // `avg_frame_rate || r_frame_rate` kept fps 0 - and qualityCheck then widened
  // its frame tolerance with `2 / (fps || 30)`, silently assuming 30 fps.
  const variable = join(directory, 'variable rate.mkv');
  await fixture(['-f', 'lavfi', '-i', 'color=c=red:s=64x48:r=20:d=1',
    '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:r=30:d=1',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', variable]);
  const media = await probeMedia(variable);
  const video = media.streams.find((stream) => stream.codec_type === 'video');
  assert.equal(video.avg_frame_rate, '0/0', 'fixture no longer reports an unusable average frame rate');
  const [numerator, denominator] = video.r_frame_rate.split('/').map(Number);
  assert.ok(numerator > 0 && denominator > 0, `r_frame_rate was ${video.r_frame_rate}`);
  assert.equal(media.fps, numerator / denominator);
  assert.ok(media.fps > 0, 'fps must fall back to r_frame_rate');

  // Legal fractional rates keep their exact value.
  const ntsc = join(directory, 'ntsc rate.mp4');
  await fixture(['-f', 'lavfi', '-i', 'testsrc2=s=64x48:r=30000/1001:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ntsc]);
  assert.ok(Math.abs((await probeMedia(ntsc)).fps - 30000 / 1001) < 1e-9);
});

test('the music generator keeps 32-bit state past 2^53 samples', () => {
  // The contract: the same generator with uint32 state. Without `>>> 0` the
  // running sum passes 2^53 at sample 4,917,757 (~111.5 s at 44.1 kHz) and float
  // rounding eats the low bits, so every later sample diverges from this.
  const reference = (seed) => {
    let state = 2166136261;
    for (const char of String(seed)) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
    return () => {
      state = (state + 0x6D2B79F5) >>> 0;
      let value = Math.imul(state ^ (state >>> 15), 1 | state);
      value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  };
  const actual = randomGenerator('overflow');
  const expected = reference('overflow');
  // 5 M samples covers the break point and the tail of a 600 s track.
  for (let index = 0; index < 5_000_000; index++) {
    if (actual() !== expected()) assert.fail(`generator diverged from 32-bit state at sample ${index}`);
  }
});

// ---------------------------------------------------------------------------
// S2: per-stream lengths, the decode budget and the filter-script probe.
// ---------------------------------------------------------------------------

test('a matroska picture track keeps its own length instead of the container total', async () => {
  // ffprobe reports `duration: N/A` for every matroska stream; the only per-track
  // number is the Matroska DURATION tag (2.000 s here), while the container holds
  // the 10 s audio track. Falling back to the container let a clip seek to 6 s in
  // a 2 s picture track, encode pure black and still pass qualityCheck.
  const mixed = join(directory, 'mixed tracks.mkv');
  await fixture(['-f', 'lavfi', '-i', 'color=c=red:s=96x64:r=10:d=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=10',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', mixed]);
  const media = await probeMedia(mixed);
  const video = media.streams.find((stream) => stream.codec_type === 'video');
  assert.ok(video.duration === undefined || video.duration === 'N/A',
    `fixture now reports a stream duration (${video.duration}), so it no longer reproduces the bug`);
  assert.ok(Math.abs(media.duration - 10.02) < 0.3, `container duration was ${media.duration}`);
  assert.ok(Math.abs(media.videoDuration - 2) < 0.2, `video duration was ${media.videoDuration}`);
  assert.equal(media.videoDurationKnown, true, 'the per-track tag is a measured length');
  assert.ok(Math.abs(media.audioDuration - 10.02) < 0.3, `audio duration was ${media.audioDuration}`);
  await assert.rejects(renderTimeline({
    project: { width: 96, height: 64, fps: 10, clips: [
      { path: mixed, kind: 'video', start: 0, sourceIn: 6, duration: 1 },
    ] }, outputPath: join(directory, 'past mkv video end.mp4'),
  }), /exceeds source duration \(video stream is 2(?:\.\d+)?s\)/);
});

test('a stream that states no length at all is measured instead of skipping the bound', async () => {
  // Raw H.264: no container duration, no stream duration, no tags - the old
  // `limit > 0` guard skipped validation entirely for such a file.
  const raw = join(directory, 'elementary.h264');
  await fixture(['-f', 'lavfi', '-i', 'testsrc2=s=96x64:r=20:d=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'h264', raw]);
  const media = await probeMedia(raw);
  assert.equal(media.videoDurationKnown, true, 'packet count x frame rate bounds the stream');
  assert.ok(media.videoDuration > 1 && media.videoDuration < 2.6, `raw stream length was ${media.videoDuration}`);
  await assert.rejects(renderTimeline({
    project: { width: 96, height: 64, fps: 10, clips: [
      { path: raw, kind: 'video', start: 0, sourceIn: 6, duration: 1 },
    ] }, outputPath: join(directory, 'past raw end.mp4'),
  }), /exceeds source duration \(video stream is [\d.]+s\)/);
});

test('validation decoding shares the encode budget scale instead of a flat 15 minutes', async () => {
  // A 1 h 4K production render may legitimately take hours; the decoder gate was
  // capped at 15 minutes and reported that legal output as "Decode failed".
  const hourHd = decodeTimeout({ width: 1920, height: 1080, duration: 3600 });
  const hourUhd = decodeTimeout({ width: 3840, height: 2160, duration: 3600 });
  assert.ok(hourHd > 900_000, `1 h of 1080p validation was allowed only ${hourHd} ms`);
  assert.ok(hourUhd >= hourHd, '4K validation needs at least as much time as 1080p');
  assert.ok(hourUhd <= 6 * 3_600_000, `decode budget is unbounded: ${hourUhd} ms`);
  assert.ok(decodeTimeout({ width: 1920, height: 1080, duration: 5 }) < hourHd, 'budget grows with duration');
  // Audio-only media has no pixels to decode.
  assert.ok(decodeTimeout({ width: null, height: null, duration: 3600 }) > 900_000);
  const source = await readFile(new URL('../src/media/index.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('timeout: decodeTimeout(media)'), 'qualityCheck must use the scaled decode budget');
  assert.ok(!source.includes('Math.min(900_000'), 'the flat 15 minute decode gate must be gone');
});

test('the filter-script option is decided by the help text, without a real ffmpeg', async () => {
  // ffmpeg 8: the option exists and must be used. ffmpeg 9: it was removed and its
  // help does not advertise a replacement (`-h full` only lists -filter_complex),
  // so absence selects the `-/filter_complex` spelling. Both branches are
  // unreachable on a real 9.x build, where the fallback happens to be correct.
  const legacy = '-filter_complex <graph>\n-filter_complex_script <file>  set the filtergraph script file\n';
  assert.equal(filterScriptOption(legacy), '-filter_complex_script');
  const modern = '-filter_complex <graph>\n-filter_complex_threads  number of threads\n-/filter_complex <file>\n';
  assert.equal(filterScriptOption(modern), '-/filter_complex');
  assert.equal(filterScriptOption(''), '-/filter_complex', 'an empty probe must not pick the removed option');
  // Deciding this must not spawn a process: the probe is text matching.
  const spawned = [];
  const listener = ({ process: child }) => spawned.push(child.spawnfile);
  channel('child_process').subscribe(listener);
  try {
    filterScriptOption(legacy);
    filterScriptOption(modern);
  } finally { channel('child_process').unsubscribe(listener); }
  assert.deepEqual(spawned, [], 'filterScriptOption must not run ffmpeg');
  const source = await readFile(new URL('../src/media/index.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('filterScriptOptionName = filterScriptOption('),
    'the cached probe must go through filterScriptOption');
});

test('a truncated picture track is bounded by its real data, and a truncation on a packet boundary is still caught', async () => {
  // Believing a container's own duration let a clip seek past the end of the picture data and render
  // pure black, which was then published as a success (qualityCheck only warns about black frames).
  // A faststart MP4 keeps an intact moov when the download is cut, so the file still claims 4 s.
  const whole = join(directory, 'truncation source.mp4');
  await fixture(['-f', 'lavfi', '-i', 'color=c=orange:s=96x64:r=30:d=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', whole]);
  const size = (await stat(whole)).size;

  // A plain cut leaves decaying NAL units, which the demuxer reports.
  const cut = join(directory, 'truncated mid.mp4');
  await writeFile(cut, (await readFile(whole)).subarray(0, Math.floor(size * 0.55)));
  const mid = await probeMedia(cut);
  assert.equal(mid.videoDurationKnown, true);
  assert.ok(mid.videoDuration < 3, `a cut file was still bounded by its claim: ${mid.videoDuration}`);

  // A cut landing exactly on a packet boundary reads without any demuxer complaint, so the length
  // must be decided by the gap between the last packet and the claim — not by stderr alone.
  let packets = [];
  {
    const out = await command('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'packet=pos,size', '-of', 'csv=p=0', whole]);
    packets = out.toString('utf8').trim().split('\n').map((line) => {
      const [pos, packetSize] = line.split(',').map(Number);
      return { end: pos + packetSize };
    });
  }
  const boundary = join(directory, 'truncated on packet boundary.mp4');
  await writeFile(boundary, (await readFile(whole)).subarray(0, packets[Math.floor(packets.length * 0.6)].end));
  const onBoundary = await probeMedia(boundary);
  assert.equal(onBoundary.videoDurationKnown, true);
  assert.ok(onBoundary.videoDuration < 3,
    `a packet-aligned cut was still bounded by its claim: ${onBoundary.videoDuration}`);
  await assert.rejects(renderTimeline({
    project: { width: 96, height: 64, fps: 10, clips: [
      { path: boundary, kind: 'video', start: 0, sourceIn: 3.2, duration: 0.7 },
    ] }, outputPath: join(directory, 'past truncated end.mp4'),
  }), /exceeds source duration \(video stream is [\d.]+s\)/);

  // The whole file is untouched by the measurement.
  const intact = await probeMedia(whole);
  assert.ok(Math.abs(intact.videoDuration - 4) < 0.2, `intact length moved: ${intact.videoDuration}`);
});

test('an absolute timeline is normalised, so a pipe-written track is not inflated', async () => {
  // A Matroska written through a pipe (live capture, an interrupted recording) starts its PTS at an
  // arbitrary offset - measured 100 s for a 4 s track - and reports no duration. Using the last
  // timestamp as the length turned 4 s into 104 s, so every seek inside the real content was allowed
  // and rendered black.
  const piped = join(directory, 'absolute timeline.mkv');
  await fixture(['-f', 'lavfi', '-i', 'color=c=teal:s=96x64:r=30:d=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-output_ts_offset', '100', '-f', 'matroska', piped]);
  const media = await probeMedia(piped);
  assert.ok(Math.abs(media.videoDuration - 4) < 0.5,
    `an offset timeline inflated the bound to ${media.videoDuration}`);
  await assert.rejects(renderTimeline({
    project: { width: 96, height: 64, fps: 10, clips: [
      { path: piped, kind: 'video', start: 0, sourceIn: 50, duration: 1 },
    ] }, outputPath: join(directory, 'past absolute end.mp4'),
  }), /exceeds source duration/);
});

test('a variable frame rate tail keeps its declared length instead of being measured short', async () => {
  // The opposite mistake to truncation: the file is complete, but its last frame lasts a second, so
  // the last PTS sits well before the declared end. Taking the shorter number refused clips that
  // really exist in the 2.0-3.0 s tail.
  const vfr = join(directory, 'variable tail.mkv');
  await fixture(['-f', 'lavfi', '-i', 'color=c=purple:s=96x64:r=10:d=1',
    '-f', 'lavfi', '-i', 'color=c=olive:s=96x64:r=1:d=2',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-fps_mode', 'vfr', vfr]);
  const media = await probeMedia(vfr);
  assert.ok(media.videoDuration >= 2.8,
    `a complete VFR track was measured short: ${media.videoDuration}`);
  await assert.doesNotReject(renderTimeline({
    project: { width: 96, height: 64, fps: 10, clips: [
      { path: vfr, kind: 'video', start: 0, sourceIn: 2.5, duration: 0.5 },
    ] }, outputPath: join(directory, 'legit vfr tail.mp4'),
  }));
});
