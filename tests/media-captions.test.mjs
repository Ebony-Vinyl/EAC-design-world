import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createCaptionScript } from '../src/media/captions.mjs';
import { remapTranscriptToTimeline, renderTimeline } from '../src/media/index.mjs';

const WIDTH = 640;
const HEIGHT = 240;
const FPS = 20;
let directory;
let source;
let still;
let baseline;
let referenceFrames;

function command(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...args],
      { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-65536); });
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`ffmpeg (${code}): ${stderr}`));
      else resolve(Buffer.concat(chunks));
    });
  });
}

const decodeFrames = (path) => command(['-i', path, '-map', '0:v:0', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
const decodeAudio = (path) => command(['-i', path, '-map', '0:a:0', '-f', 'f32le', '-']);
const project = (extras = {}) => ({
  width: WIDTH, height: HEIGHT, fps: FPS,
  clips: [{ assetId: 'source', path: source, kind: 'video', start: 0, duration: 3 }],
  ...extras,
});

function changedPixels(frames, seconds, yStart = 0, yEnd = HEIGHT, predicate = () => true) {
  const frameStart = Math.round(seconds * FPS) * WIDTH * HEIGHT * 3;
  assert.ok(frames.length >= frameStart + WIDTH * HEIGHT * 3);
  let changed = 0;
  for (let pixel = yStart * WIDTH; pixel < yEnd * WIDTH; pixel++) {
    const offset = frameStart + pixel * 3;
    const rgb = frames.subarray(offset, offset + 3);
    if (rgb.some((channel, index) => Math.abs(channel - referenceFrames[offset + index]) > 40)
      && predicate(rgb)) changed++;
  }
  return changed;
}

const script = (extras = {}) => createCaptionScript({
  width: WIDTH, height: HEIGHT, duration: 3,
  captions: [{ start: 0.5, end: 1, text: 'Caption' }], ...extras,
});

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "eac \u4e2d\u6587 ' [,]; captions "));
  source = join(directory, '\u539f\u7247 source.mp4');
  still = join(directory, 'still.png');
  baseline = join(directory, 'no captions.mp4');
  await command(['-f', 'lavfi', '-i', `color=c=0x384848:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=3`,
    '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source]);
  await command(['-i', source, '-frames:v', '1', '-update', '1', still]);
  await renderTimeline({ project: project(), outputPath: baseline });
  referenceFrames = await decodeFrames(baseline);
});

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('ASS defaults, color conversion, centisecond timing and literal text are safe', () => {
  const text = '\u4e2d\u6587\uff0c, "O\'Brien" {\\alpha&HFF&} \\N \\n \\h \\\\ \\{\n' +
    'Dialogue: 0,0:00:00.00,9:00:00.00,Default,,0,0,0,,injected';
  const result = script({ captions: [{ start: 0.501, end: 1.201, text }] });
  assert.match(result, /Style: Default,Microsoft YaHei,12,&H00FFFFFF,&H00FFFFFF,&H00000000/);
  assert.match(result, /Dialogue: 0,0:00:00\.51,0:00:01\.21/);
  assert.ok(result.includes('\u4e2d\u6587\uff0c, "O\'Brien"'));
  assert.ok(result.includes('\\{\\\u2060alpha&HFF&\\}'));
  for (const escape of ['N', 'n', 'h']) assert.ok(result.includes(`\\\u2060${escape}`));
  assert.ok(result.includes('\\\u2060\\{'));
  assert.equal(result.split('\n').filter((line) => line.startsWith('Dialogue:')).length, 1);
  assert.ok(result.includes('\\NDialogue:'));
  const custom = script({ subtitleStyle: { color: '#1234', background: '#10203080', position: 'top', fontSize: 24 } });
  assert.match(custom, /,&HBB332211,&HBB332211,&H7F302010,&H7F302010,/);
  assert.match(custom, /,3,1,0,8,26,26,12,1/);
  assert.equal(script({ captions: [] }), '');
  assert.equal(script({ captions: [{ start: 4, end: 5, text: 'outside' }] }), '');
  assert.match(script({ captions: [{ start: 2.5, end: 5, text: 'clamped' }] }), /0:00:02\.50,0:00:03\.00/);
});

test('invalid caption intervals and ASS style injection fail before changing output', async () => {
  const outputPath = join(directory, 'invalid preserved.mp4');
  const original = Buffer.from('existing video stays');
  await writeFile(outputPath, original);
  for (const row of [
    { start: -1, end: 1, text: 'bad' }, { start: 1, end: 1, text: 'bad' },
    { start: 2, end: 1, text: 'bad' }, { start: NaN, end: 1, text: 'bad' },
    { start: 0, end: Infinity, text: 'bad' }, { start: 0, end: 3601, text: 'bad' },
    { start: '0', end: 1, text: 'bad' }, { end: 1, text: 'bad' },
    { start: 0, end: 1, text: 123 }, null,
  ]) {
    await assert.rejects(renderTimeline({ project: project({ captions: [row] }), outputPath }), TypeError);
  }
  for (const subtitleStyle of [
    null, [], { position: 'middle' }, { fontSize: 0 }, { fontSize: NaN },
    { color: 'white,Style: injected' }, { background: 'url(file)' },
    { fontFamily: 'Arial,0,0\n[Events]' }, { fontFamily: '{\\alpha&HFF&}' },
  ]) {
    await assert.rejects(renderTimeline({ project: project({ subtitleStyle }), outputPath }), TypeError);
  }
  await assert.rejects(renderTimeline({ project: project({ captions: {} }), outputPath }), TypeError);
  assert.deepEqual(await readFile(outputPath), original);
  assert.ok(!(await readdir(directory)).some((name) => name.startsWith('.eac-media-')));
});

test('decoded pixels show captions only in their windows, with Chinese and literal ASS-like punctuation', async () => {
  const outputPath = join(directory, '\u5b57\u5e55 captioned.mp4');
  const result = await renderTimeline({
    project: project({ captions: [
      { start: 0.5, end: 1.2, text: '\u4e2d\u6587\uff0c, "O\'Brien" {\\alpha&HFF&}' },
      { start: 1.6, end: 2.2, text: '\u7b2c\u4e8c\u53e5\uff01Literal \\N \\n \\h \\{braces\\}' },
    ] }), outputPath,
  });
  const decoded = await decodeFrames(outputPath);
  assert.equal(decoded.length, referenceFrames.length);
  for (const seconds of [0, 0.2, 0.45, 1.2, 1.4, 1.55, 2.2, 2.7]) {
    assert.ok(changedPixels(decoded, seconds) < 10, `caption absent at ${seconds}s`);
  }
  for (const seconds of [0.5, 0.8, 1.15, 1.6, 1.9, 2.15]) {
    assert.ok(changedPixels(decoded, seconds, HEIGHT / 2) > 150, `caption visible at ${seconds}s`);
    assert.ok(changedPixels(decoded, seconds, 0, HEIGHT / 2) < 10, 'literal \\N does not create a top line');
    assert.ok(changedPixels(decoded, seconds, HEIGHT / 2, HEIGHT,
      (rgb) => rgb.every((channel) => channel > 180)) > 80, 'white text remains visible despite alpha override text');
  }
  assert.equal(result.hasAudio, true);
  const audio = result.streams.find((stream) => stream.codec_type === 'audio');
  assert.equal(audio.codec_name, 'aac');
  assert.equal(Number(audio.sample_rate), 48000);
  assert.equal(audio.channels, 2);
  const referenceAudio = await decodeAudio(baseline);
  assert.deepEqual(await decodeAudio(outputPath), referenceAudio, 'captions preserve the exact decoded audio mix');
  assert.ok(referenceAudio.some((value) => value !== 0), 'audio is not silent');
});

test('decoded pixels honor top positioning, font size, color and background', async () => {
  const outputPath = join(directory, 'styled captions.mp4');
  await renderTimeline({
    project: project({
      captions: [{ start: 0.5, end: 1.5, text: '\u9876\u90e8 Top caption' }],
      subtitleStyle: { fontFamily: 'Microsoft YaHei', fontSize: 30, color: '#ff0000', background: '#000000', position: 'top' },
    }), outputPath,
  });
  const decoded = await decodeFrames(outputPath);
  assert.ok(changedPixels(decoded, 0.8, 0, HEIGHT / 2) > 1000);
  assert.ok(changedPixels(decoded, 0.8, HEIGHT / 2) < 10);
  assert.ok(changedPixels(decoded, 0.8, 0, HEIGHT / 2,
    ([red, green, blue]) => red > 150 && green < 80 && blue < 80) > 150, 'red text');
  assert.ok(changedPixels(decoded, 0.8, 0, HEIGHT / 2,
    (rgb) => rgb.every((channel) => channel < 20)) > 150, 'black background');
  assert.ok(changedPixels(decoded, 1.5) < 10);
});

test('empty captions preserve the caption-free decoded video and audio', async () => {
  const outputPath = join(directory, 'empty captions.mp4');
  await renderTimeline({ project: project({ captions: [] }), outputPath });
  assert.deepEqual(await decodeFrames(outputPath), referenceFrames);
  assert.deepEqual(await decodeAudio(outputPath), await decodeAudio(baseline));
});

test('caption cancellation before work, after ASS staging and during encoding preserves existing output', async () => {
  const outputPath = join(directory, 'cancelled captions.mp4');
  const original = Buffer.from('keep existing file');
  await writeFile(outputPath, original);
  const renderProject = project({
    width: 1280, height: 720, fps: 30,
    clips: [{ path: still, kind: 'image', duration: 30 }],
    captions: [{ start: 0, end: 30, text: '\u4e0d\u8981\u8986\u76d6 Existing file' }],
  });
  for (const stage of ['before', 'staged', 'encoding']) {
    const controller = new AbortController();
    let reachedStage = stage === 'before';
    if (reachedStage) controller.abort();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      await assert.rejects(renderTimeline({
        project: renderProject, outputPath, signal: controller.signal,
        onProgress: (value) => {
          if ((stage === 'staged' && value === 0) || (stage === 'encoding' && value > 0 && value < 1)) {
            reachedStage = true;
            controller.abort();
          }
        },
      }), { name: 'AbortError' });
    } finally { clearTimeout(timer); }
    assert.equal(reachedStage, true, `reached ${stage}`);
    assert.deepEqual(await readFile(outputPath), original);
    assert.ok(!(await readdir(directory)).some((name) => name.startsWith('.eac-media-')));
  }
});

test('remapping intersects source cuts, reorders output and leaves inputs unchanged', () => {
  const input = {
    segments: [
      { start: 1, end: 4, text: '\u4e00\u6574\u53e5\uff0c\u4e0d\u76f2\u76ee\u622a\u5b57\u3002' },
      { start: 5, end: 6, text: 'Another sentence.' },
    ],
    clips: [
      { assetId: 'a', kind: 'video', start: 2, sourceIn: 1.5, duration: 1 },
      { assetId: 'a', kind: 'video', start: 0, sourceIn: 5, duration: 1 },
      { assetId: 'a', kind: 'video', start: 4, sourceIn: 3.5, duration: 1 },
      { assetId: 'b', kind: 'video', start: 0, sourceIn: 0, duration: 10 },
      { assetId: 'a', kind: 'image', start: 0, duration: 10 },
    ],
    assetId: 'a',
  };
  const original = structuredClone(input);
  assert.deepEqual(remapTranscriptToTimeline(input), [
    { start: 0, end: 1, text: 'Another sentence.' },
    { start: 2, end: 3, text: input.segments[0].text },
    { start: 4, end: 4.5, text: input.segments[0].text },
  ]);
  assert.deepEqual(input, original);
});

test('adjacent or overlapping intersections of one sentence merge without deleting real repetitions', () => {
  const segments = [{ start: 0, end: 3, text: 'Repeat me.' }, { start: 4, end: 5, text: 'Repeat me.' }];
  assert.deepEqual(remapTranscriptToTimeline({ assetId: 'a', segments, clips: [
    { assetId: 'a', start: 0, sourceIn: 0, duration: 1 },
    { assetId: 'a', start: 1, sourceIn: 2, duration: 1 },
    { assetId: 'a', start: 1, sourceIn: 2, duration: 1 },
    { assetId: 'a', start: 2, sourceIn: 4, duration: 1 },
    { assetId: 'a', start: 4, sourceIn: 0, duration: 1 },
  ] }), [
    { start: 0, end: 2, text: 'Repeat me.' },
    { start: 2, end: 3, text: 'Repeat me.' },
    { start: 4, end: 5, text: 'Repeat me.' },
  ]);
  assert.deepEqual(remapTranscriptToTimeline({ assetId: 'a', segments, clips: [
    { assetId: 'a', start: 0, sourceIn: 0, duration: 1 },
    { assetId: 'a', start: 1, sourceIn: 0, duration: 1 },
  ] }), [
    { start: 0, end: 1, text: 'Repeat me.' },
    { start: 1, end: 2, text: 'Repeat me.' },
  ]);
});

test('complete word alignment selects exact words and punctuation rather than slicing by time ratio', () => {
  const segments = [{ start: 0, end: 4, text: 'Hello, \u4e16\u754c\uff01 Again.', words: [
    { start: 0, end: 1, word: 'Hello,' },
    { start: 1.5, end: 2, word: ' \u4e16\u754c' },
    { start: 2, end: 2, word: '\uff01' },
    { start: 3, end: 4, word: ' Again.' },
  ] }];
  assert.deepEqual(remapTranscriptToTimeline({ assetId: 'a', segments, clips: [
    { assetId: 'a', start: 0, sourceIn: 1.7, duration: 0.3 },
    { assetId: 'a', start: 1, sourceIn: 2.1, duration: 0.5 },
    { assetId: 'a', start: 2, sourceIn: 3, duration: 1 },
  ] }), [
    { start: 0, end: 0.3, text: '\u4e16\u754c\uff01' },
    { start: 2, end: 3, text: 'Again.' },
  ]);
});

test('absent, incomplete or unusable alignment retains the whole bounded sentence', () => {
  const text = 'Do not truncate this sentence.';
  for (const words of [
    undefined, [], [{ start: 0, end: 1, word: 'Do' }],
    [{ start: 0, end: 0, word: text }], [{ start: 0, end: 5, word: text }],
  ]) {
    assert.deepEqual(remapTranscriptToTimeline({
      segments: [{ start: 0, end: 4, text, words }],
      clips: [{ assetId: 'a', start: 2, sourceIn: 1, duration: 0.5 }], assetId: 'a',
    }), [{ start: 2, end: 2.5, text }]);
  }
  assert.deepEqual(remapTranscriptToTimeline({ segments: [], clips: [], assetId: 'a' }), []);
  assert.deepEqual(remapTranscriptToTimeline({
    segments: [{ start: 0, end: 1, text: '  ' }], clips: [{ assetId: 'a', duration: 1 }], assetId: 'a',
  }), []);
});

test('remapping follows accelerated and slowed source time without drifting subtitles', () => {
  const segments = [{ start: 2, end: 3, text: 'Speech in the cut.' }];
  assert.deepEqual(remapTranscriptToTimeline({ assetId: 'a', segments, clips: [
    { assetId: 'a', start: 10, sourceIn: 1, duration: 1, speed: 2 },
    { assetId: 'a', start: 20, sourceIn: 2, duration: 2, speed: 0.5 },
  ] }), [
    { start: 10.5, end: 11, text: 'Speech in the cut.' },
    { start: 20, end: 22, text: 'Speech in the cut.' },
  ]);
  for (const speed of [0, -1, 5, NaN]) {
    assert.throws(() => remapTranscriptToTimeline({ assetId: 'a', segments, clips: [
      { assetId: 'a', start: 0, sourceIn: 0, duration: 1, speed },
    ] }), TypeError);
  }
});

test('remapping rejects invalid source and timeline intervals', () => {
  const input = {
    segments: [{ start: 0, end: 2, text: 'Hello' }],
    clips: [{ assetId: 'a', start: 0, sourceIn: 0, duration: 1 }], assetId: 'a',
  };
  for (const segment of [
    { start: -1, end: 1, text: 'bad' }, { start: 1, end: 1, text: 'bad' },
    { start: 0, end: NaN, text: 'bad' },
  ]) assert.throws(() => remapTranscriptToTimeline({ ...input, segments: [segment] }), TypeError);
  for (const patch of [
    { start: -1 }, { start: 3600 }, { sourceIn: Infinity }, { duration: 0 }, { duration: -1 },
  ]) {
    assert.throws(() => remapTranscriptToTimeline({ ...input, clips: [{ ...input.clips[0], ...patch }] }), TypeError);
  }
  assert.throws(() => remapTranscriptToTimeline({ ...input, assetId: '' }), TypeError);
  assert.throws(() => remapTranscriptToTimeline({ ...input, clips: null }), TypeError);
});
