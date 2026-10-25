import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { synthesizeVoice } from '../src/media/index.mjs';
import { generateKeepRanges, transcribeMedia, transcriptCapabilities, transcriptModelPath } from '../src/transcript.mjs';
import { localDataDirectory } from '../src/local-runtime.mjs';

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), "eac \u4e2d\u6587 ' transcript "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function command(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-65536); });
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${executable} exited ${code}: ${stderr}`));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

const word = (start, end, word) => ({ start, end, word, probability: 0.9 });
const segment = (start, end, text, words) => ({ start, end, text, ...(words ? { words } : {}) });

async function silence(path, duration = '1') {
  await command('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', duration, path]);
}

test('model selection uses portable local data and explicit configuration precedence', () => {
  const before = process.env.EAC_WHISPER_MODEL_PATH;
  try {
    delete process.env.EAC_WHISPER_MODEL_PATH;
    assert.equal(transcriptModelPath(), join(localDataDirectory(), 'models', 'faster-whisper-tiny'));
    process.env.EAC_WHISPER_MODEL_PATH = join(tmpdir(), 'configured model');
    assert.equal(transcriptModelPath(), process.env.EAC_WHISPER_MODEL_PATH);
    assert.equal(transcriptModelPath(join(tmpdir(), 'requested model')), join(tmpdir(), 'requested model'));
  } finally {
    if (before === undefined) delete process.env.EAC_WHISPER_MODEL_PATH;
    else process.env.EAC_WHISPER_MODEL_PATH = before;
  }
});

test('keep ranges preserve repeats, merge short pauses, and remove sufficiently long silence', () => {
  const segments = [
    segment(3, 4, 'Repeat this.'),
    segment(0.2, 1, 'Repeat this.'),
    segment(1.3, 2, 'Then continue.'),
  ];
  const before = structuredClone(segments);
  assert.deepEqual(generateKeepRanges(segments, { minGap: 0.5, padding: 0.1 }), [
    { start: 0.1, end: 2.1 }, { start: 2.9, end: 4 },
  ]);
  assert.deepEqual(segments, before, 'pure function must not mutate input');
  assert.deepEqual(generateKeepRanges([]), []);
});

test('aligned word timestamps permit pause cuts and only explicit opt-in fillers', () => {
  const segments = [segment(0, 3, 'Hello, um, hello again.', [
    word(0, 0.5, 'Hello,'), word(0.6, 0.9, ' um,'),
    word(1, 1.5, ' hello'), word(2.5, 3, ' again.'),
  ])];
  assert.deepEqual(generateKeepRanges(segments, { minGap: 0.6, padding: 0 }), [
    { start: 0, end: 1.5 }, { start: 2.5, end: 3 },
  ]);
  assert.deepEqual(generateKeepRanges(segments, { minGap: 0.6, padding: 0, removeFillers: true }), [
    { start: 0, end: 0.5 }, { start: 1, end: 1.5 }, { start: 2.5, end: 3 },
  ]);
  const padded = generateKeepRanges(segments, { padding: 1, removeFillers: true });
  assert.deepEqual(padded, [{ start: 0, end: 0.6 }, { start: 0.9, end: 3 }]);
  assert.deepEqual(generateKeepRanges([segment(0, 1, 'like you know')], { removeFillers: true }),
    [{ start: 0, end: 1 }]);
  assert.deepEqual(generateKeepRanges([segment(0, 1, 'um', [word(0, 1, 'um')])], { removeFillers: true }), []);
});

test('incomplete, absent, or zero-duration word alignment retains readable speech', () => {
  for (const words of [undefined, [], [word(0, 1, 'first')], [word(0, 0, 'first second')]]) {
    assert.deepEqual(generateKeepRanges([segment(0, 3, 'first second', words)], {
      minGap: 0, padding: 0, removeFillers: true,
    }), [{ start: 0, end: 3 }]);
  }
  const overlapping = [
    segment(0, 2, 'Keep the whole sentence'),
    segment(0.5, 1, 'um', [word(0.5, 1, 'um')]),
  ];
  assert.deepEqual(generateKeepRanges(overlapping, { removeFillers: true }), [{ start: 0, end: 2 }]);
  assert.deepEqual(generateKeepRanges([segment(0, 1, '   ')]), []);
});

test('keep ranges reject unsafe intervals and invalid options', () => {
  for (const bad of [
    null, {}, [segment(-1, 2, 'bad')], [segment(1, 1, 'bad')],
    [segment(0, Infinity, 'bad')], [segment(0, 1, 42)],
    [segment(0, 1, 'bad', [word(0, 2, 'bad')])],
  ]) assert.throws(() => generateKeepRanges(bad), TypeError);
  for (const options of [{ minGap: -1 }, { minGap: NaN }, { padding: Infinity }, { removeFillers: 'yes' }]) {
    assert.throws(() => generateKeepRanges([], options), TypeError);
  }
  const ranges = generateKeepRanges([segment(0, 1, 'one'), segment(0.8, 2, 'two'), segment(5, 6, 'three')]);
  assert.ok(ranges.every((range, i) => range.start >= 0 && range.end > range.start
    && (i === 0 || range.start > ranges[i - 1].end)));
});

test('SRT formats hour boundaries, millisecond carry, and Unicode without loading ASR', async () => {
  const script = fileURLToPath(new URL('../scripts/transcribe.py', import.meta.url));
  const source = [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("transcribe", sys.argv[1])',
    'worker = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(worker)',
    'print(json.dumps({"srt": worker.render_srt([{"start": 3599.9996, "end": 3601.2, "text": "\\u4f60\\u597d\\n\\nworld"}]), "long": worker.timestamp(360000.125)}, ensure_ascii=True))',
  ].join('\n');
  const result = JSON.parse(await command(process.env.EAC_PYTHON || process.env.PYTHON || 'python',
    ['-X', 'utf8', '-B', '-c', source, script]));
  assert.equal(result.srt, '1\n01:00:00,000 --> 01:00:01,200\n\u4f60\u597d world\n');
  assert.equal(result.long, '100:00:00,125');
});

test('real local tiny ASR transcribes synthesized English with word timestamps and caption files', {
  skip: !process.env.EAC_WHISPER_MODEL_PATH, timeout: 180_000,
}, async (t) => {
  const capabilities = await transcriptCapabilities();
  assert.equal(capabilities.available, true, capabilities.detail);
  assert.match(capabilities.detail, /tiny.*low quality/i);
  const directory = await workspace(t);
  const input = join(directory, '\u82f1\u6587 voice.wav');
  await synthesizeVoice({
    text: 'Welcome to this local speech transcription test. We are making a short video today. Please listen to this clear English sentence.',
    voice: process.platform === 'win32' ? 'Microsoft Zira Desktop' : undefined, outputPath: input,
  });
  const outputDir = join(directory, 'captions');
  const result = await transcribeMedia({ path: input, outputDir, language: 'en' });
  assert.equal(result.language, 'en');
  assert.equal(result.modelPath, capabilities.modelPath);
  assert.ok(result.segments.length > 0);
  const words = result.segments.flatMap((segment) => segment.words);
  assert.ok(result.segments.some((segment) => segment.text.trim()));
  assert.ok(words.some((word) => word.word.trim() && word.end > word.start));
  for (const segment of result.segments) {
    assert.ok(segment.start >= 0 && segment.end > segment.start);
    for (const word of segment.words) {
      assert.ok(word.start >= segment.start && word.end <= segment.end && word.end >= word.start);
      assert.ok(word.probability >= 0 && word.probability <= 1);
    }
  }
  const json = JSON.parse(await readFile(result.jsonPath, 'utf8'));
  assert.deepEqual(json.segments, result.segments);
  assert.equal(json.vad, true);
  assert.match(json.detail, /low quality/i);
  assert.match(await readFile(result.srtPath, 'utf8'), /00:\d{2}:\d{2},\d{3} --> 00:\d{2}:\d{2},\d{3}/);
  assert.deepEqual((await readdir(outputDir)).sort(), [
    result.jsonPath.slice(outputDir.length + 1), result.srtPath.slice(outputDir.length + 1),
  ].sort());
  t.diagnostic(`Actual tiny ASR: ${result.segments.length} segments, ${words.length} words; ${result.segments[0].text}`);
  const silent = join(directory, 'silent.wav');
  await silence(silent);
  const empty = await transcribeMedia({ path: silent, outputDir, language: 'en' });
  assert.deepEqual(empty.segments, [], 'real ASR must not invent speech for silence');
  assert.equal(await readFile(empty.srtPath, 'utf8'), '');
});

test('missing model and invalid input fail honestly without caption artifacts', { timeout: 60_000 }, async (t) => {
  const directory = await workspace(t);
  const input = join(directory, 'invalid audio.wav');
  await silence(input);
  const outputDir = join(directory, 'output');
  await assert.rejects(transcribeMedia({ path: input, outputDir, modelPath: join(directory, 'missing') }),
    /Local model directory does not exist/);
  assert.deepEqual(await readdir(outputDir), []);
  await writeFile(input, 'not an audio file');
  await assert.rejects(transcribeMedia({ path: input, outputDir }), /InvalidDataError|Invalid data/i);
  assert.deepEqual(await readdir(outputDir), []);
  await assert.rejects(transcribeMedia({ path: input, outputDir, language: '--bad' }), /language/);
});

test('empty worker output publishes captions; invalid media preserves them without starting ASR', {
  timeout: 60_000,
}, async (t) => {
  const directory = await workspace(t);
  const outputDir = join(directory, 'output');
  const silent = join(directory, 'silent.wav');
  const long = join(directory, 'over thirty minutes.flac');
  const video = join(directory, 'no audio.mp4');
  await silence(silent);
  let calls = 0;
  const runWorker = async args => {
    calls++;
    const destination = args[args.indexOf('--output-dir') + 1];
    const modelPath = args[args.indexOf('--model-path') + 1];
    await writeFile(join(destination, 'transcript.json'), JSON.stringify({ segments: [], language: 'en', modelPath }));
    await writeFile(join(destination, 'transcript.srt'), '');
  };
  const empty = await transcribeMedia({ path: silent, outputDir, language: 'en' }, { runWorker });
  assert.deepEqual(empty.segments, [], 'an empty transcript must stay empty at the API boundary');
  assert.equal(await readFile(empty.srtPath, 'utf8'), '');
  const retained = (await readdir(outputDir)).sort();
  await command('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=s=16x16:r=1', '-frames:v', '1', video]);
  await assert.rejects(transcribeMedia({ path: video, outputDir }, { runWorker }), /no audio stream/i);
  await command('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '1800.1', '-c:a', 'flac', long]);
  await assert.rejects(transcribeMedia({ path: long, outputDir }, { runWorker }), /1800-second transcription limit/);
  assert.equal(calls, 1, 'invalid inputs must not reach the ASR worker');
  assert.deepEqual((await readdir(outputDir)).sort(), retained, 'failures must preserve existing captions');
});

test('worker deadline kills Python and cleans staged captions', { timeout: 15_000 }, async (t) => {
  const directory = await workspace(t);
  const input = join(directory, 'input.wav');
  const outputDir = join(directory, 'output');
  await silence(input);
  const events = channel('child_process');
  let pid;
  let started;
  const spawned = new Promise((resolve) => { started = resolve; });
  const listener = ({ process: child }) => {
    child.once('spawn', () => {
      if (!child.spawnargs.includes(fileURLToPath(new URL('../scripts/transcribe.py', import.meta.url)))) return;
      pid = child.pid;
      started();
    });
  };
  events.subscribe(listener);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const operation = transcribeMedia({ path: input, outputDir });
    const rejected = assert.rejects(operation, /timed out after 900000ms/);
    await spawned;
    t.mock.timers.tick(900_000);
    await rejected;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.deepEqual(await readdir(outputDir), []);
  } finally {
    t.mock.timers.reset();
    events.unsubscribe(listener);
  }
});

test('pre-abort creates no output and active abort terminates Python before rejecting', { timeout: 30_000 }, async (t) => {
  const directory = await workspace(t);
  const input = join(directory, 'input.wav');
  await silence(input);
  const outputDir = join(directory, 'output');
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(transcribeMedia({ path: input, outputDir, signal: pre.signal }), { name: 'AbortError' });
  assert.deepEqual(await readdir(directory), ['input.wav']);
  const controller = new AbortController();
  let pid;
  const events = channel('child_process');
  const listener = ({ process: child }) => {
    child.once('spawn', () => {
      if (!child.spawnargs.includes(fileURLToPath(new URL('../scripts/transcribe.py', import.meta.url)))) return;
      pid = child.pid;
      controller.abort();
    });
  };
  events.subscribe(listener);
  try {
    await assert.rejects(transcribeMedia({ path: input, outputDir, signal: controller.signal }), { name: 'AbortError' });
    assert.ok(pid, 'a real Python process must have started');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.deepEqual(await readdir(outputDir), []);
  } finally {
    events.unsubscribe(listener);
    controller.abort();
  }
});
