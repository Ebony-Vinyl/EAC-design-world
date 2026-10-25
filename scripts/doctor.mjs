import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, templates } from '../src/catalog.mjs';
import { browserLaunchOptions } from '../src/browser.mjs';
import { chromium } from 'playwright';

let browser;
try { browser = { ok: true, detail: browserLaunchOptions(chromium).executablePath }; }
catch (error) { browser = { ok: false, detail: error.message }; }

const command = (name, args) => spawnSync(name, args, { encoding: 'utf8', windowsHide: true, timeout: 8000 });
const filters = command('ffmpeg', ['-hide_banner', '-filters']);
const lut3d = (filters.stdout || '').includes('lut3d');
const state = await readFile(join(ROOT, '.eac', 'state.json'), 'utf8').then(JSON.parse).catch(() => ({ settings: {} }));
const settings = state.settings || {};
const keyCheck = (label, value, docs) => ({ name: label, ok: Boolean(value), detail: value ? '已配置' : `未配置 · ${docs}` });
const draftsRoot = settings.jianyingDraftRoot
  || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft') : '');

const checks = [
  { name: 'Node >= 22', ok: Number(process.versions.node.split('.')[0]) >= 22, detail: process.version },
  ...['ffmpeg', 'ffprobe', process.env.EAC_PYTHON || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')].map((name, index) => {
    const result = spawnSync(name, [index === 2 ? '--version' : '-version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return { name, ok: result.status === 0, detail: String(result.stdout || result.stderr || result.error?.message).split('\n')[0] };
  }),
  { name: 'ffmpeg lut3d（调色渲染）', ok: lut3d, detail: lut3d ? '可用' : '当前 ffmpeg 构建缺少 lut3d 滤镜' },
  keyCheck('Pexels API Key', settings.pexelsApiKey, 'pexels.com/api 免费注册；不配则用 commons 维基共享'),
  keyCheck('Pixabay API Key', settings.pixabayApiKey, 'pixabay.com/api/docs 免费注册'),
  keyCheck('Jamendo Client ID', settings.jamendoClientId, 'devportal.jamendo.com 免费注册（CC 配乐）'),
  { name: '剪映草稿目录', ok: existsSync(draftsRoot), detail: draftsRoot || '未检测到（Windows 需安装剪映专业版）' },
  { name: 'Chromium browser', ...browser },
  ...templates.map((template) => ({ name: template.name, ok: existsSync(join(ROOT, template.entry)), detail: template.status }))
];
for (const check of checks) console.log(`${check.ok ? 'OK' : 'MISSING'}  ${check.name}: ${check.detail}`);
console.log('Note: template sources can require separately licensed fonts or pre-rendered Blender assets.');
console.log('Note: commons（维基共享）素材源无需任何 Key；未配置 Pexels/Pixabay 时风景素材走 commons。');
if (checks.slice(0, 4).some((check) => !check.ok) || !lut3d) process.exitCode = 1;
