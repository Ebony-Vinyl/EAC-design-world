import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { localDataDirectory } from './local-runtime.mjs';

export const MAMBO_VOICE_ID = 'mambo-zh';
export const MAMBO_VOICE_NAME = '曼波中文';

function absolute(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || !isAbsolute(value)) {
    throw new Error(`曼波本地配置 ${name} 必须是绝对路径`);
  }
  return resolve(value);
}

/** Machine-local configuration; never accepted from a browser job payload. */
export async function localVoiceConfiguration({ configPath = process.env.EAC_GPT_SOVITS_CONFIG
  || join(localDataDirectory(), 'voice', 'gpt-sovits.json') } = {}) {
  let config;
  try { config = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('曼波中文尚未配置本地 GPT-SoVITS，请按本地配音文档安装');
    throw new Error(`曼波本地配置无法读取：${error.message}`);
  }
  const pythonExecutable = absolute(config.pythonExecutable, 'pythonExecutable');
  const engineRoot = absolute(config.engineRoot, 'engineRoot');
  const voiceRoot = absolute(config.voiceRoot, 'voiceRoot');
  const profilePath = absolute(config.profilePath, 'profilePath');
  const rel = relative(voiceRoot, profilePath);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('曼波音色配置必须位于 voiceRoot 内');
  for (const path of [pythonExecutable, join(engineRoot, 'GPT_SoVITS', 'TTS_infer_pack', 'TTS.py'), profilePath]) {
    if (!(await stat(path).catch(() => null))?.isFile()) throw new Error(`曼波本地文件不存在：${path}`);
  }
  const profileBytes = await readFile(profilePath);
  const profileSha256 = createHash('sha256').update(profileBytes).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(config.profileSha256) || config.profileSha256 !== profileSha256) {
    throw new Error('曼波音色基准配置已改变，profileSha256 不匹配');
  }
  const profile = JSON.parse(profileBytes.toString('utf8'));
  if (profile.schema_version !== 1 || profile.selection !== 'user_confirmed_sample'
    || profile.voice_id !== 'mambo-gpt-sovits-v1' || profile.engine?.name !== 'GPT-SoVITS'
    || profile.engine?.version !== 'v2' || !Array.isArray(profile.models_and_frontend)) {
    throw new Error('曼波音色配置不是已确认的 GPT-SoVITS v2 基准');
  }
  for (const file of profile.models_and_frontend) {
    if (typeof file.path !== 'string' || isAbsolute(file.path) || relative(voiceRoot, resolve(voiceRoot, file.path)).startsWith('..')
      || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('曼波音色文件校验清单无效');
    if (!(await stat(resolve(voiceRoot, file.path)).catch(() => null))?.isFile()) throw new Error(`曼波模型文件不存在：${file.path}`);
  }
  return { pythonExecutable, engineRoot, voiceRoot, profilePath, profileSha256, profileId: profile.voice_id };
}

export async function localVoiceCapability(selectedVoice) {
  let mambo;
  try {
    const config = await localVoiceConfiguration();
    mambo = { id: MAMBO_VOICE_ID, name: MAMBO_VOICE_NAME, available: true, profileId: config.profileId,
      detail: '本地 GPT-SoVITS · 已锚定音色，生成时校验模型' };
  } catch (error) { mambo = { id: MAMBO_VOICE_ID, name: MAMBO_VOICE_NAME, available: false, detail: error.message }; }
  const systemAvailable = ['win32', 'darwin'].includes(process.platform);
  const systemDetail = process.platform === 'darwin' ? 'macOS say' : 'Windows SAPI';
  return { id: 'voice', name: '本地旁白', available: selectedVoice === MAMBO_VOICE_ID ? mambo.available : systemAvailable,
    selectedVoice: selectedVoice || '',
    detail: selectedVoice === MAMBO_VOICE_ID ? `${MAMBO_VOICE_NAME} · ${mambo.detail}` : systemDetail,
    voices: [{ id: '', name: '系统默认', available: systemAvailable }, mambo] };
}
