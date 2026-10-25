import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { localVoiceConfiguration, localVoiceCapability } from '../src/local-voice.mjs';
import { synthesizeVoice } from '../src/media/index.mjs';

const worker = fileURLToPath(new URL('../scripts/gpt-sovits-worker.py', import.meta.url));
function python() {
  for (const command of [process.env.EAC_TEST_PYTHON, 'python3', 'python'].filter(Boolean)) {
    const found = spawnSync(command, ['-X', 'utf8', '-c', 'import sys; print(sys.executable) if sys.version_info >= (3, 11) else sys.exit(2)'], { encoding: 'utf8', windowsHide: true });
    if (found.status === 0) return found.stdout.trim();
  }
  throw new Error('Local voice tests require Python 3.11+');
}
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'eac-voice-中文 '));
  const before = process.env.EAC_GPT_SOVITS_CONFIG;
  try {
    const engineRoot = join(root, 'engine');
    const configPath = join(root, 'local-voice.json');
    process.env.EAC_GPT_SOVITS_CONFIG = configPath;
    await mkdir(join(engineRoot, 'GPT_SoVITS/TTS_infer_pack'), { recursive: true });
    await writeFile(join(engineRoot, 'GPT_SoVITS/TTS_infer_pack/TTS.py'), '');
    const paths = ['models/manbo-e10.ckpt', 'models/manbo_e8_s168.pth', 'models/refer.wav',
      'models/chinese-roberta-wwm-ext-large/pytorch_model.bin', 'models/chinese-roberta-wwm-ext-large/config.json',
      'models/chinese-roberta-wwm-ext-large/tokenizer.json', 'models/chinese-hubert-base/pytorch_model.bin',
      'models/chinese-hubert-base/config.json', 'models/chinese-hubert-base/preprocessor_config.json',
      'engine/GPT_SoVITS/text/chinese2.py'];
    const entries = [];
    for (const path of paths) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), 'fixture');
      entries.push({ path, sha256: createHash('sha256').update('fixture').digest('hex') });
    }
    const profilePath = join(root, 'profile.json');
    const profile = { schema_version: 1, selection: 'user_confirmed_sample', voice_id: 'mambo-gpt-sovits-v1',
      engine: { name: 'GPT-SoVITS', version: 'v2' }, models_and_frontend: entries,
      reference: { audio: 'models/refer.wav', text: '参考文本', language: 'all_zh' }, inference: { seed: 1234, is_g2pw: false } };
    await writeFile(profilePath, JSON.stringify(profile));
    const config = { pythonExecutable: python(), engineRoot, voiceRoot: root, profilePath, profileSha256: createHash('sha256').update(JSON.stringify(profile)).digest('hex') };
    await writeFile(configPath, JSON.stringify(config));
    return await fn({ root, config, configPath, profile, profilePath });
  } finally {
    if (before === undefined) delete process.env.EAC_GPT_SOVITS_CONFIG;
    else process.env.EAC_GPT_SOVITS_CONFIG = before;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
async function waitFor(fn, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 30)); }
  throw new Error('Condition timeout');
}

test('local voice detects configured paths and fails closed for a missing selected model', () => fixture(async ({ config, configPath, root }) => {
  assert.equal((await localVoiceConfiguration()).profileId, 'mambo-gpt-sovits-v1');
  assert.equal((await localVoiceCapability('mambo-zh')).available, true);
  await rm(join(root, 'models/refer.wav'));
  const unavailable = await localVoiceCapability('mambo-zh');
  assert.equal(unavailable.available, false);
  assert.match(unavailable.detail, /模型文件不存在/);
  await assert.rejects(synthesizeVoice({ text: '你好', voice: 'mambo-zh', outputPath: join(root, 'missing.wav') }), /模型文件不存在/);
  await writeFile(configPath, JSON.stringify({ ...config, pythonExecutable: 'python' }));
  await assert.rejects(localVoiceConfiguration(), /绝对路径/);
}));

test('unconfirmed profiles and paths outside the voice root are rejected', () => fixture(async ({ profile, profilePath, config, configPath }) => {
  await writeFile(profilePath, JSON.stringify({ ...profile, selection: 'unconfirmed' }));
  await writeFile(configPath, JSON.stringify({ ...config, profileSha256: createHash('sha256').update(await readFile(profilePath)).digest('hex') }));
  await assert.rejects(localVoiceConfiguration(), /已确认/);
  await writeFile(profilePath, JSON.stringify({ ...profile, models_and_frontend: [{ path: '../outside.pth', sha256: 'a'.repeat(64) }] }));
  await writeFile(configPath, JSON.stringify({ ...config, profileSha256: createHash('sha256').update(await readFile(profilePath)).digest('hex') }));
  await assert.rejects(localVoiceConfiguration(), /校验清单/);
}));

test('changed model bytes fail before importing inference or publishing an output', () => fixture(async ({ root }) => {
  await writeFile(join(root, 'models/manbo-e10.ckpt'), 'changed');
  const outputPath = join(root, 'failed.wav');
  await assert.rejects(synthesizeVoice({ text: '你好', voice: 'mambo-zh', outputPath }), /SHA-256 不匹配/);
  await assert.rejects(stat(outputPath), { code: 'ENOENT' });
  assert.ok(!(await readdir(root)).some(name => name.startsWith('.eac-media-')));
}));

test('cancelling local synthesis kills the worker tree and removes staging files', { timeout: 20000 }, () => fixture(async ({ root, config }) => {
  const marker = join(config.engineRoot, 'worker-pids.json');
  await writeFile(join(config.engineRoot, 'numpy.py'), `import os,sys,time,json,subprocess\nfrom pathlib import Path\nchild=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])\nPath(__file__).with_name('worker-pids.json').write_text(json.dumps({'parent':os.getpid(),'child':child.pid}))\ntime.sleep(60)\n`);
  const controller = new AbortController();
  const task = synthesizeVoice({ text: '取消测试', voice: 'mambo-zh', outputPath: join(root, 'cancelled.wav'), signal: controller.signal });
  const failed = assert.rejects(task, /aborted/);
  const pids = await waitFor(async () => readFile(marker, 'utf8').then(JSON.parse).catch(() => null));
  controller.abort();
  await failed;
  for (const pid of [pids.parent, pids.child]) {
    await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  }
  await assert.rejects(stat(join(root, 'cancelled.wav')), { code: 'ENOENT' });
  assert.ok(!(await readdir(root)).some(name => name.startsWith('.eac-media-')));
}));

test('long narration is segmented without dropping punctuation or any input characters', () => {
  const text = '你好呀！' + '这是一段很长的中文旁白。'.repeat(40) + '最后一句。';
  const source = `import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location('voice_worker',sys.argv[1])\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\ns=json.loads(sys.argv[2]);print(json.dumps(list(m.split_text(s)),ensure_ascii=False))`;
  const child = spawnSync(python(), ['-X', 'utf8', '-c', source, worker, JSON.stringify(text)], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  const parts = JSON.parse(child.stdout);
  assert.equal(parts.join(''), text);
  assert.ok(parts.length > 1 && parts.every(part => part.length <= 100));
});

test('a changed seed or reference text cannot retain the accepted profile identity', () => fixture(async ({ profile, profilePath }) => {
  await writeFile(profilePath, JSON.stringify({ ...profile, inference: { ...profile.inference, seed: 99 } }));
  await assert.rejects(localVoiceConfiguration(), /profileSha256 不匹配/);
}));
