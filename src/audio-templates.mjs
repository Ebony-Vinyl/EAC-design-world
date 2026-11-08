import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, isAbsolute, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import lockfile from '../vendor/eac-runtime/proper-lockfile.cjs';
import { localDataDirectory } from './local-runtime.mjs';
import { localVoiceConfiguration } from './local-voice.mjs';
import { runMediaProcess, synthesizeVoice, probeMedia } from './media/index.mjs';

export const MAMBO_PRESET = JSON.parse(readFileSync(new URL('./mambo-preset.json', import.meta.url), 'utf8'));
const INSTALL_SCRIPT = fileURLToPath(new URL('../scripts/install-mambo.py', import.meta.url));
const VOICE_SCRIPT = fileURLToPath(new URL('../scripts/gpt-sovits-worker.py', import.meta.url));
const REQUIREMENTS = fileURLToPath(new URL('../scripts/mambo-requirements.txt', import.meta.url));
const SAMPLE_TEXT = '你好呀！今天也要元气满满哦。这是本地生成的中文语音，曼波！';
const cancelled = () => Object.assign(new Error('已取消本地下载'), { name: 'AbortError' });
const check = signal => signal?.throwIfAborted();
const childPath = (root, value) => {
  const path = resolve(root, value), rel = relative(root, path);
  if (isAbsolute(value) || rel === '..' || rel.startsWith('..') || isAbsolute(rel)) throw new Error('音色安装路径无效');
  return path;
};
async function hashFile(path, signal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) { check(signal); hash.update(chunk); }
  return hash.digest('hex');
}

/** Verified cache and resumable transfers. No URL or path is taken from HTTP callers. */
export async function downloadVoiceAsset(asset, directory, { signal, fetchImpl = fetch, onProgress = () => {} } = {}) {
  signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30 * 60 * 1000)]);
  if (!/^[a-zA-Z0-9._-]+$/.test(asset.filename) || !/^[a-f0-9]{64}$/.test(asset.sha256)
    || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) throw new Error('音色下载清单无效');
  await mkdir(directory, { recursive: true });
  const path = join(directory, asset.filename), partial = `${path}.part`;
  if ((await stat(path).catch(() => null))?.size === asset.bytes && await hashFile(path, signal) === asset.sha256) {
    onProgress(asset.bytes, true); return path;
  }
  await rm(path, { force: true });
  let offset = (await stat(partial).catch(() => null))?.size || 0;
  if (offset === asset.bytes) {
    if (await hashFile(partial, signal) === asset.sha256) { await rename(partial, path); onProgress(asset.bytes, true); return path; }
    await rm(partial, { force: true }); offset = 0;
  }
  if (offset > asset.bytes) { await rm(partial, { force: true }); offset = 0; }
  check(signal);
  const response = await fetchImpl(asset.url, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal });
  if (!response.ok || !response.body) throw new Error(`${asset.label}下载失败：HTTP ${response.status}`);
  if (response.status === 206) {
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
    if (!range || Number(range[1]) !== offset || Number(range[3]) !== asset.bytes) throw new Error('断点续传范围不匹配');
  } else if (response.status === 200) offset = 0;
  else throw new Error('下载服务器返回了无效响应');
  let bytes = offset;
  onProgress(bytes, false);
  const counter = new Transform({ transform(chunk, encoding, done) {
    bytes += chunk.length;
    if (bytes > asset.bytes) return done(new Error('音色下载超过清单大小'));
    onProgress(bytes, false); done(null, chunk);
  } });
  await pipeline(response.body, counter, createWriteStream(partial, { flags: offset ? 'a' : 'w' }), { signal });
  if (bytes !== asset.bytes) throw new Error(`${asset.label}下载不完整，可重试续传`);
  if (await hashFile(partial, signal) !== asset.sha256) { await rm(partial, { force: true }); throw new Error(`${asset.label} SHA-256 校验失败`); }
  check(signal); await rename(partial, path); return path;
}

async function python312() {
  const candidates = process.env.EAC_GPT_SOVITS_PYTHON ? [[process.env.EAC_GPT_SOVITS_PYTHON]]
    : [['python3.12'], ['python3'], ['python'], ...(process.platform === 'win32' ? [['py', '-3.12']] : [])];
  for (const [command, ...prefix] of candidates) {
    try {
      const result = await runMediaProcess(command, [...prefix, '-X', 'utf8', '-c', 'import sys; print(sys.executable) if sys.version_info[:2] == (3,12) else sys.exit(2)'], { timeout: 5000 });
      const path = result.stdout.toString('utf8').trim();
      if (isAbsolute(path)) return path;
    } catch { /* try the next installed interpreter */ }
  }
  throw new Error('需要先安装 Python 3.12，再重试下载曼波；也可用 EAC_GPT_SOVITS_PYTHON 指定其路径');
}
async function bootstrapRuntime({ root, python, assets, preset, signal, phase }) {
  const requestPath = join(root, 'install-request.json');
  await writeFile(requestPath, JSON.stringify({ root, engineArchive: assets.engine, voiceArchive: assets.voice,
    assets: preset.assets.filter(a => a.target).map(a => ({ ...a, cached: assets[a.id] })), profile: preset.profile }));
  try {
    phase('extracting', '校验并安装音色文件');
    await runMediaProcess(python, ['-X', 'utf8', INSTALL_SCRIPT, requestPath], { signal, processTree: true, timeout: 180000 });
  } finally { await rm(requestPath, { force: true }); }
  const environment = join(root, 'runtime', '.venv-gpt');
  const executable = join(environment, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  phase('dependencies', '安装本地运行依赖，首次可能需要几分钟');
  const uv = spawnSync('uv', ['--version'], { windowsHide: true, timeout: 5000 }).status === 0;
  if (!existsSync(executable)) {
    if (uv) await runMediaProcess('uv', ['venv', '--python', python, environment], { signal, processTree: true, timeout: 120000 });
    else await runMediaProcess(python, ['-X', 'utf8', '-m', 'venv', environment], { signal, processTree: true, timeout: 120000 });
  }
  const cpuWheels = process.platform === 'darwin' ? [] : ['--extra-index-url', 'https://download.pytorch.org/whl/cpu', 'torch==2.6.0+cpu', 'torchaudio==2.6.0+cpu'];
  if (uv) await runMediaProcess('uv', ['pip', 'install', '--python', executable, '-r', REQUIREMENTS, ...cpuWheels], { signal, processTree: true, timeout: 1800000 });
  else await runMediaProcess(executable, ['-X', 'utf8', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-r', REQUIREMENTS, ...cpuWheels], { signal, processTree: true, timeout: 1800000 });
  const profilePath = join(root, 'voice-anchor/voice-profile.json');
  const profileSha256 = await hashFile(profilePath, signal);
  const config = { pythonExecutable: executable, engineRoot: join(root, 'runtime/GPT-SoVITS'), voiceRoot: root, profilePath, profileSha256 };
  phase('verifying', '首次生成试听，检查本地音色是否可运行');
  const smoke = join(root, 'verify-request.json');
  const sample = join(root, preset.profile.approved_sample.path);
  await writeFile(smoke, JSON.stringify({ ...config, text: SAMPLE_TEXT, rate: 0, outputPath: sample, metadataPath: join(root, 'voice-anchor/sample.json') }));
  try { await runMediaProcess(executable, ['-X', 'utf8', VOICE_SCRIPT, smoke], { signal, processTree: true, timeout: 900000 }); }
  finally { await rm(smoke, { force: true }); }
  const media = await probeMedia(sample, { signal });
  if (!media.hasAudio || media.duration < 1) throw new Error('本地曼波试听验证失败');
  return config;
}

export function createAudioTemplates({ dataDir = localDataDirectory(), fetchImpl = fetch, preset = MAMBO_PRESET,
  bootstrap = bootstrapRuntime, resolvePython = python312, configPath = process.env.EAC_GPT_SOVITS_CONFIG || join(dataDir, 'voice/gpt-sovits.json') } = {}) {
  configPath = resolve(configPath);
  const voiceDir = join(dataDir, 'voice'), root = join(voiceDir, 'mambo'), cache = join(voiceDir, 'downloads/mambo-v1');
  let operation = null, controller, task, closed = false;
  const previews = new Map(), previewTasks = new Map();
  const totalBytes = preset.assets.reduce((sum, asset) => sum + asset.bytes, 0);
  const configured = async () => localVoiceConfiguration({ configPath }).catch(() => null);
  const validId = id => { if (!['default', 'mambo-zh'].includes(id)) throw new Error('音频模板不存在'); };
  async function samplePath(id) {
    validId(id);
    const path = join(voiceDir, 'previews', `${id}.wav`);
    if ((await stat(path).catch(() => null))?.isFile()) return path;
    if (id === 'mambo-zh') {
      const config = await configured();
      if (config) {
        const profile = JSON.parse(await readFile(config.profilePath, 'utf8'));
        const sample = childPath(config.voiceRoot, profile.approved_sample.path);
        if ((await stat(sample).catch(() => null))?.isFile()) return sample;
      }
    }
    return null;
  }
  async function catalog(selectedVoice) {
    const config = await configured();
    const templates = [];
    for (const id of ['default', 'mambo-zh']) {
      const installed = id === 'default' ? ['darwin', 'win32'].includes(process.platform) : Boolean(config);
      const path = await samplePath(id);
      templates.push({ id, name: id === 'default' ? '默认音色' : '曼波中文', installed, available: installed,
        selected: id === 'default' ? selectedVoice !== 'mambo-zh' : selectedVoice === 'mambo-zh',
        downloadBytes: id === 'default' ? 0 : totalBytes,
        sampleUrl: path ? `/api/audio-templates/${id}/sample?v=${(await stat(path)).mtimeMs}` : null,
        preview: previews.get(id) || null });
    }
    return { templates, installation: operation ? { ...operation } : null };
  }
  async function install() {
    if (closed) throw new Error('工作台已关闭');
    if (task) throw new Error('曼波正在下载或安装');
    if (await configured()) return { status: 'completed', phase: 'ready', detail: '曼波已下载到本地' };
    if (task) throw new Error('曼波正在下载或安装');
    const activeController = new AbortController();
    controller = activeController;
    const signal = activeController.signal;
    operation = { id: randomUUID(), status: 'running', phase: 'preflight', detail: '检查本地安装环境', preparedBytes: 0, totalBytes, error: '' };
    const phase = (value, detail) => { operation.phase = value; operation.detail = detail; };
    task = (async () => {
      let release, verified;
      try {
        const python = await resolvePython();
        check(signal);
        await mkdir(voiceDir, { recursive: true });
        release = await lockfile.lock(voiceDir, { lockfilePath: join(voiceDir, '.mambo-install.lock'), retries: 0, stale: 120000, update: 15000,
          onCompromised: error => activeController.abort(error) });
        const marker = join(root, '.mambo-package.json');
        if (existsSync(root) && !existsSync(marker) && (await readdir(root)).length) throw new Error('已有手动安装目录，请保留原文件并修复本地配置后重试');
        await mkdir(root, { recursive: true });
        await writeFile(marker, JSON.stringify({ id: preset.id }));
        phase('downloading', '下载音色模型到本地');
        const queue = [...preset.assets], progress = new Map(), assets = {};
        const workers = Array.from({ length: 2 }, async () => {
          try {
            while (queue.length) {
              check(signal); const asset = queue.shift();
              assets[asset.id] = await downloadVoiceAsset(asset, cache, { signal, fetchImpl, onProgress: bytes => {
                progress.set(asset.id, bytes); operation.preparedBytes = [...progress.values()].reduce((a, b) => a + b, 0);
              } });
            }
          } catch (error) { if (!signal.aborted) activeController.abort(error); throw error; }
        });
        const results = await Promise.allSettled(workers);
        const failure = results.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
        check(signal);
        const config = await bootstrap({ root, python, assets, preset, signal, phase });
        verified = join(dirname(configPath), `.gpt-sovits-${randomUUID()}.tmp`);
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(verified, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
        await localVoiceConfiguration({ configPath: verified });
        check(signal);
        if (existsSync(configPath)) await copyFile(configPath, `${configPath}.previous`);
        await mkdir(resolve(configPath, '..'), { recursive: true });
        await rename(verified, configPath);
        operation.status = 'completed'; phase('ready', '曼波已下载到本地，可设为默认音色');
      } catch (error) {
        const reason = signal.aborted ? signal.reason : error;
        operation.status = reason?.name === 'AbortError' ? 'cancelled' : 'failed';
        operation.error = operation.status === 'cancelled' ? '' : reason?.message || error.message;
        operation.detail = operation.status === 'cancelled' ? '已取消，已下载的资源可在重试时复用' : '下载或安装未完成，可重试';
      } finally {
        if (verified) await rm(verified, { force: true }).catch(() => {});
        try { await release?.(); } catch { /* the abort handler already reported a compromised lock */ }
        task = null; controller = null;
      }
    })();
    return { ...operation };
  }
  async function preview(id) {
    validId(id);
    if (closed) throw new Error('工作台已关闭');
    if (id === 'mambo-zh' && !await configured()) throw new Error('请先下载曼波音色到本地');
    if (await samplePath(id)) return;
    if (previewTasks.has(id)) return;
    const abort = new AbortController();
    previews.set(id, { status: 'running', error: '' });
    const promise = (async () => {
      try {
        const path = join(voiceDir, 'previews', `${id}.wav`);
        await synthesizeVoice({ text: id === 'default' ? '你好，这里是默认配音，欢迎开始新的创作。' : SAMPLE_TEXT,
          voice: id === 'default' ? undefined : id, outputPath: path, signal: abort.signal });
        previews.set(id, { status: 'completed', error: '' });
      } catch (error) { previews.set(id, { status: 'failed', error: error.message }); }
      finally { previewTasks.delete(id); }
    })();
    previewTasks.set(id, { abort, promise });
  }
  return { catalog, install, preview, samplePath,
    async assertAvailable(id) { validId(id); const state = await catalog(''); if (!state.templates.find(t => t.id === id).available) throw new Error('该音色尚未在本机安装完成'); },
    cancel() { controller?.abort(cancelled()); },
    async close() { closed = true; controller?.abort(cancelled()); for (const p of previewTasks.values()) p.abort.abort(cancelled()); await Promise.allSettled([task, ...[...previewTasks.values()].map(p => p.promise)].filter(Boolean)); }
  };
}
