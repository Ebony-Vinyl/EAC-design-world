// Merged epic film: 上篇山水（用户 dlog 山水森林.MOV）+ 下篇园林（Dlog 芙蓉园仿古楼.MP4），
// 融为一支音乐卡点样片。所有源片段窗口互不重叠、只用一次（用户要求不重复播放同一段落）。
// 上篇沿用《山水之间》验证过的暖蓝绿调色（clip 级整体替换），下篇沿用《大唐芙蓉园》浓艳通透调色（项目 look）。
//   node scripts/demo-merged.mjs setup-film   双素材导入 + 节拍卡点剪辑（变速/运镜）+ 字幕
//   node scripts/demo-merged.mjs preview      全片调色对比 + 护栏
//   node scripts/demo-merged.mjs render       渲染 + 质检
//   node scripts/demo-merged.mjs export       导出剪映/XML/SRT/LUT
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROOT } from '../src/catalog.mjs';

const stateFile = resolve(ROOT, 'artifacts', 'demo-merged.json');
const mountainFootage = process.env.EAC_DEMO_MOUNTAIN;
const parkFootage = process.env.EAC_DEMO_PARK;
const music = process.env.EAC_DEMO_MUSIC;
const fps = 30;
// 音乐 55s 起为蓄力→副歌段（能量抬升），55→110s 全部落在实测节拍网格内。
const MUSIC_FROM = 55.0;
const BEAT = 1.1626; // 51.7BPM 实测均值，仅用于窗口余量估算；剪辑点仍取实测节拍。

// 源窗口池：全部唯一，一次一用。mountain 8 个（素材 51.96s），park 22 个（素材 145s）。
const MOUNTAIN_SHOTS = [0.8, 7.0, 13.5, 20.0, 26.5, 33.0, 39.5, 45.5];
const PARK_SHOTS = [2, 5.5, 11, 15.5, 21, 25.5, 33, 40, 44.5, 49, 53.5, 58, 62, 66, 70.5, 74, 80, 88, 96, 105, 112, 120, 128, 136, 142];
const PARK_DURATION = 145;

// 结构：上篇山水（慢摇）→ 转场蓄力 → 下篇园林开场 → 副歌高潮（密切+变速）→ 尾声收束。
const SECTIONS = [
  { name: '山水', cuts: 6, beatsPerCut: 2, speed: 1, footage: 'mountain', motion: ['pan-right', 'zoom-in', 'pan-left', 'pan-right', 'zoom-in', 'pan-left'], amount: 0.08 },
  { name: '转场', cuts: 2, beatsPerCut: 2, speed: 1, footage: 'park', motion: ['zoom-out', 'zoom-in'], amount: 0.1 },
  { name: '园林', cuts: 6, beatsPerCut: 2, speed: 1.2, footage: 'park', motion: ['pan-right', 'zoom-in', 'pan-left', 'zoom-in', 'pan-right', 'zoom-in'], amount: 0.12 },
  { name: '副歌', cuts: 14, beatsPerCut: 1, speed: 1.5, footage: 'park', motion: ['zoom-in', 'pan-left', 'zoom-in', 'pan-right', 'zoom-in', 'pan-down', 'zoom-in', 'pan-left', 'zoom-in', 'pan-right', 'zoom-in', 'pan-up', 'zoom-in', 'zoom-out'], amount: 0.18 },
  { name: '尾声', cuts: 2, beatsPerCut: 2, speed: 0.7, footage: 'mountain', motion: ['zoom-out', 'zoom-out'], amount: 0.08 },
];
const captions = [
  { start: 1.0, end: 5.0, text: '雾从山脊漫过来，山把自己交给天空' },
  { start: 8.5, end: 12.5, text: '风穿过林梢，绿色一层层醒着' },
  { start: 15.5, end: 19.5, text: '水声在谷底，把时间磨得很慢' },
  { start: 23.5, end: 27.5, text: '翻过那道山，长安就在眼前' },
  { start: 31.0, end: 35.0, text: '一园藏尽长安梦' },
  { start: 39.0, end: 43.0, text: '登楼远眺 云影千年' },
  { start: 45.5, end: 48.5, text: '当鼓点落下 盛唐醒来' },
  { start: 50.8, end: 52.6, text: '山河入梦 · 盛世园林' },
  { start: 52.9, end: 55.4, text: 'EAC design world · AI 全流程制作' },
];
const subtitleStyle = { fontFamily: 'Source Han Sans CN', fontSize: 58, color: '#FFFFFF', position: 'bottom' };
// 剪映参数方向落地：色温+23 → temperature 0.2；色调-21 → tint -0.12（石材广场防绿偏，按素材适配减弱）；
// 自然饱和+8 → vibrance 0.08；亮度+2 → exposure 0.02；对比+5 → contrast 0.1（Eastman 基底已有对比，取轻）；
// 高光-17 → zones.highlights.exposure -0.14；阴影-2 → zones.shadows.exposure -0.02；
// 光感-25 → gain 0.96-0.97 + gamma 微抬（中间调变浓）；柔光适中 → glow 0.4。
// 蓝天：高光分区 gain 偏蓝（r 0.95 / b 1.07）+ 天空限定器（205°±65°，压亮加饱和）——暖中间调配冷高光，天空读蓝、林读绿。
const polish = { fadeIn: 0.8, fadeOut: 1.8, sharpen: 0.5, vignette: 0.12, glow: 0.4 };
const EASTMAN_LUT = process.env.EAC_DEMO_LOOK_LUT;

// 项目 look：Eastman 胶片基底（外挂 LUT）+ 上表参数 + 蓝天分区。
// 蓝天关键：hueVsSat 在 160-180°（绿青雾）压饱和、220-240°（蓝）加饱和；高光 gain 偏蓝；
// 曲线底部 y=0.02 抬黑，抵消 Eastman+对比叠加的暗部触底。
const PARK_LOOK = {
  exposure: 0.02, contrast: 0.06, saturation: 0.1, vibrance: 0.1,
  temperature: 0.2, tint: -0.02,
  lift: { r: 0.004, g: 0.005, b: 0.01 }, gamma: { r: 1, g: 1, b: 0.99 }, gain: { r: 1, g: 1, b: 0.97 },
  curves: { master: [[0, 0.02], [0.25, 0.25], [0.5, 0.5], [0.75, 0.78], [1, 1]] },
  hueVsSat: [[150, -0.3], [185, 0], [225, 0.35]],
  zones: {
    shadows: { exposure: -0.02 }, highlights: { exposure: -0.14, gain: { r: 0.94, g: 0.985, b: 1.09 } },
    shadowRange: 0.28, highlightRange: 0.7,
  },
  secondaries: [
    { qualifier: { hue: 215, hueWidth: 60, satMin: 0.04, lumaMin: 0.5, softness: 0.15 },
      adjustments: { saturation: 0.4, exposure: -0.03, gain: { b: 1.04, g: 0.98 } } },
    { qualifier: { hue: 8, hueWidth: 40, satMin: 0.15, softness: 0.12 },
      adjustments: { saturation: 0.25, exposure: 0.03 } },
  ],
};
// 上篇山水：同一 Eastman 基底，绿林增饱和、同款蓝天分区（整体替换项目 look）。
const MOUNTAIN_GRADE = {
  exposure: 0.02, contrast: 0.06, saturation: 0.1, vibrance: 0.14,
  temperature: 0.16, tint: -0.02,
  lift: { r: 0.004, g: 0.006, b: 0.012 }, gamma: { r: 1, g: 1, b: 0.98 }, gain: { r: 1, g: 1, b: 0.96 },
  curves: { master: [[0, 0.02], [0.25, 0.25], [0.5, 0.5], [0.75, 0.78], [1, 1]] },
  hueVsSat: [[150, -0.3], [185, 0], [225, 0.35]],
  zones: {
    shadows: { exposure: -0.02 }, highlights: { exposure: -0.14, gain: { r: 0.94, g: 0.985, b: 1.09 } },
    shadowRange: 0.28, highlightRange: 0.7,
  },
  secondaries: [
    { qualifier: { hue: 215, hueWidth: 60, satMin: 0.04, lumaMin: 0.5, softness: 0.15 },
      adjustments: { saturation: 0.4, exposure: -0.03, gain: { b: 1.04, g: 0.98 } } },
    { qualifier: { hue: 100, hueWidth: 50, satMin: 0.15, softness: 0.12 },
      adjustments: { saturation: 0.28 } },
  ],
};

const { createEngine } = await import('../src/engine.mjs');
const engine = await createEngine();
const args = process.argv.slice(2);
const command = args[0] || 'help';

async function loadState() {
  try { return JSON.parse(await readFile(stateFile, 'utf8')); } catch { return {}; }
}
async function saveState(state) {
  await mkdir(resolve(ROOT, 'artifacts'), { recursive: true });
  await writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8');
}
async function awaitJob(jobId) {
  for (;;) {
    const job = await engine.handle('job_status', { jobId });
    if (['completed', 'failed', 'cancelled'].includes(job.status)) {
      if (job.status !== 'completed') throw new Error(`任务 ${job.type} ${job.status}：${job.error}`);
      return job.result;
    }
    await new Promise((done) => setTimeout(done, 1500));
  }
}
const submit = async (type, params) => awaitJob((await engine.handle('job_submit', { projectId: (await loadState()).projectId, type, params })).id);

function buildCutPlan(beats) {
  const grid = [];
  for (const section of SECTIONS) {
    for (let cut = 0; cut < section.cuts; cut++) grid.push({ beats: section.beatsPerCut, section, cut });
  }
  const start = beats.findIndex((time) => time >= MUSIC_FROM);
  if (start < 0) throw new Error('节拍网格里找不到配乐入点');
  const avg = (beats[beats.length - 1] - beats[0]) / (beats.length - 1);
  const beatAt = (index) => index < beats.length ? beats[index] : beats[beats.length - 1] + (index - (beats.length - 1)) * avg;
  let beatIndex = start;
  let cursor = 0;
  const plan = [];
  const counters = { mountain: 0, park: 0 };
  for (const entry of grid) {
    let spacing = beatAt(beatIndex + entry.beats) - beatAt(beatIndex);
    if (!(spacing > 0.2)) throw new Error('节拍间距异常');
    // 时长对齐帧网格：overlay 合成窗口与中间片帧数完全一致，消除切点黑帧抽搐。
    spacing = Math.round(spacing * fps) / fps;
    const section = entry.section;
    // 尾声最后一刀的实测节拍可能越出 120s 分析窗，间距用均值兜底（beatAt 已处理）。
    const speed = section.name === '副歌' ? (entry.cut % 3 === 2 ? 2.6 : entry.cut % 3 === 1 ? 2 : 1.5) : section.speed;
    const motionType = section.motion[entry.cut % section.motion.length];
    let sourceIn;
    if (section.footage === 'mountain') {
      sourceIn = MOUNTAIN_SHOTS[counters.mountain++];
      if (sourceIn === undefined) throw new Error('山水窗口池耗尽');
      if (sourceIn + spacing * speed > 51.5) throw new Error(`山水窗口 ${sourceIn}s 越界`);
    } else {
      sourceIn = PARK_SHOTS[counters.park++];
      if (sourceIn === undefined) throw new Error('园林窗口池耗尽');
      sourceIn = Math.min(sourceIn, PARK_DURATION - spacing * speed - 0.4);
    }
    plan.push({ start: Number(cursor.toFixed(3)), duration: Number(spacing.toFixed(3)),
      sourceIn: Number(sourceIn.toFixed(2)), speed, footage: section.footage,
      motion: { type: motionType, amount: section.amount } });
    cursor += spacing;
    beatIndex += entry.beats;
  }
  return { plan, timelineSeconds: Number(cursor.toFixed(3)) };
}

async function setupFilm() {
  for (const name of ["EAC_DEMO_MOUNTAIN","EAC_DEMO_PARK","EAC_DEMO_MUSIC","EAC_DEMO_LOOK_LUT"]) {
    if (!process.env[name]) throw new Error(`Set ${name} to a local, authorized media file before running setup-film`);
  }
  const project = await engine.handle('project_create', {
    title: '山河入梦 · 盛世园林',
    brief: '两支样片融合：上篇山水（dlog 山水森林，暖蓝绿调色）+ 下篇园林（Dlog 芙蓉园，浓艳通透调色），统一音乐卡点、变速递进、数字运镜，全部源片段唯一不重复。1080p30，约 53 秒。',
    width: 1920, height: 1080, fps,
  });
  await saveState({ projectId: project.id });
  const imported = await engine.handle('asset_import', { projectId: project.id, path: mountainFootage });
  const afterMountain = await engine.handle('asset_import', { projectId: project.id, path: parkFootage });
  const mountainAsset = imported.assets.find((item) => item.path === mountainFootage);
  const parkAsset = afterMountain.assets.find((item) => item.path === parkFootage);
  if (!mountainAsset || !parkAsset) throw new Error('素材导入失败');

  const { analyzeBeats } = await import('../src/media/index.mjs');
  const beatAnalysis = await analyzeBeats(music);
  if (!beatAnalysis.beats.length) throw new Error('配乐节拍分析失败');
  const { plan, timelineSeconds } = buildCutPlan(beatAnalysis.beats);
  const mountainCuts = plan.filter((entry) => entry.footage === 'mountain').length;
  console.log(`节拍：bpm≈${beatAnalysis.bpm} · 样片 ${plan.length} 刀（山水 ${mountainCuts} + 园林 ${plan.length - mountainCuts}）· ${timelineSeconds.toFixed(1)}s · 源窗口零复用`);

  const clips = plan.map((entry) => ({
    assetId: entry.footage === 'mountain' ? mountainAsset.id : parkAsset.id,
    path: entry.footage === 'mountain' ? mountainAsset.path : parkAsset.path,
    kind: 'video', start: entry.start, duration: entry.duration, sourceIn: entry.sourceIn,
    speed: entry.speed, motion: entry.motion, volume: 0, track: 0,
    // Eastman 胶片基底 LUT（先于参数调色）；山水片段整体替换为山地 look，园林跟随项目 look。
    lut: EASTMAN_LUT,
    grading: entry.footage === 'mountain' ? MOUNTAIN_GRADE : null,
  }));
  const latest = await engine.handle('project_get', { projectId: project.id });
  const updated = await engine.handle('timeline_update', { projectId: project.id, revision: latest.revision,
    clips, captions, subtitleStyle, musicPath: music,
    musicStart: Number(beatAnalysis.beats.find((time) => time >= MUSIC_FROM).toFixed(3)), ...polish,
    look: PARK_LOOK });
  console.log(`项目就绪：${project.id} · revision ${updated.revision}`);
  await saveState({ ...(await loadState()), projectId: updated.id, timelineSeconds, plan });
}

async function preview() {
  const result = await submit('grade-preview', { framesPerClip: 2 });
  console.log(`对比表：${result.path}`);
  console.log(`护栏：${result.warnings.length ? '' : '无'}`);
  for (const warning of result.warnings) console.log(`  ${warning}`);
  await saveState({ ...(await loadState()), lastPreview: result.path });
}

async function render() {
  const result = await submit('render', {});
  console.log(`成片：${result.path}`);
  console.log(`质检：${result.qa?.ok ? '通过' : '失败'} · 时长 ${result.qa?.duration?.toFixed?.(2)}s · 抽帧 ${result.review?.path}`);
  for (const warning of result.qa?.warnings || []) console.log(`警告：${warning}`);
  await saveState({ ...(await loadState()), lastRender: result.path });
}

async function exportAll() {
  const result = await submit('export', {});
  console.log(`导出完成：${result.files?.length ?? 0} 个文件`);
  for (const file of result.files || []) console.log(`  ${file}`);
  if (result.jianYingDraftInstalled) console.log(`剪映草稿已安装：${result.jianYingDraftInstalled}`);
}

try {
  if (command === 'setup-film') await setupFilm();
  else if (command === 'preview') await preview();
  else if (command === 'render') await render();
  else if (command === 'export') await exportAll();
  else console.log('用法：node scripts/demo-merged.mjs <setup-film|preview|render|export>');
} finally {
  await engine.close();
}
