// End-to-end showcase demo: beat-synced cutting, speed ramps, digital camera moves,
// professional grading iteration (curves / HSL secondaries / zones / windows), captions,
// music offset, render, QC, scopes and NLE export. Phases run separately so the AI
// operator can iterate the grade between previews:
//   node scripts/demo-showcase.mjs setup-film   节拍对齐剪辑（变速/运镜）+ 用户配乐 + 字幕
//   node scripts/demo-showcase.mjs preview      调色前后对比帧 + 统计护栏
//   node scripts/demo-showcase.mjs look <presetId|json>   项目级调色（覆盖式）
//   node scripts/demo-showcase.mjs clip <index> <presetId|json>  单片段调色
//   node scripts/demo-showcase.mjs render       渲染 + 质检
//   node scripts/demo-showcase.mjs scopes       波形 + 矢量示波器
//   node scripts/demo-showcase.mjs export       导出剪映/XML/SRT/LUT
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROOT } from '../src/catalog.mjs';

const stateFile = resolve(ROOT, 'artifacts', 'demo-showcase.json');
const footage = process.env.EAC_DEMO_FOOTAGE;
const music = process.env.EAC_DEMO_MUSIC;
const fps = 30;
// 音乐 63.7s 起进入副歌蓄力段（能量 -11.6dB → -9dB → -7.6dB），节拍网格由 analyzeBeats 实测对齐。
const MUSIC_FROM = 63.5;

// 镜头池：按源素材内容手选的可用窗口（sourceIn 秒，见 artifacts/showcase-inspect/source-sheet.jpg）。
const SHOTS = [2, 11, 21, 33, 40, 49, 58, 66, 74, 80, 88, 96, 104, 112, 120, 128, 136, 142];
// 结构（beat = 51.7BPM 慢网格 1.16s；speed 为该镜头恒定变速，motion 为数字运镜）：
const SECTIONS = [
  { name: '开场', cuts: 4, beatsPerCut: 2, speed: 1, motion: ['pan-right', 'zoom-in', 'pan-left', 'zoom-in'], amount: 0.1 },
  { name: '蓄力', cuts: 6, beatsPerCut: 2, speed: 1.2, motion: ['zoom-in', 'pan-right', 'pan-up', 'zoom-out', 'pan-left', 'zoom-in'], amount: 0.12 },
  { name: '副歌前', cuts: 10, beatsPerCut: 1, speed: 1.5, motion: ['zoom-in', 'pan-left', 'zoom-in', 'pan-right', 'zoom-in', 'pan-down', 'zoom-in', 'pan-left', 'zoom-in', 'zoom-out'], amount: 0.16 },
  { name: '高潮', cuts: 12, beatsPerCut: 1, speed: 2, motion: ['zoom-in', 'pan-right', 'zoom-in', 'pan-left', 'zoom-in', 'pan-right', 'zoom-in', 'pan-left', 'zoom-in', 'pan-right', 'zoom-in', 'zoom-in'], amount: 0.2 },
  { name: '收束', cuts: 3, beatsPerCut: 2, speed: 0.7, motion: ['zoom-out', 'pan-right', 'zoom-out'], amount: 0.1 },
];
const captions = [
  { start: 1.0, end: 5.0, text: '一园藏尽长安梦' },
  { start: 9.5, end: 13.5, text: '登楼远眺 云影千年' },
  { start: 18.0, end: 22.0, text: '檐角之上 风起水榭' },
  { start: 24.5, end: 28.0, text: '当鼓点落下 盛唐醒来' },
  { start: 36.0, end: 39.5, text: '万家灯火 川流不息' },
  { start: 49.0, end: 52.0, text: '大唐芙蓉园 · 震撼开园' },
  { start: 52.4, end: 55.2, text: 'EAC design world · AI 全流程制作' },
];
const subtitleStyle = { fontFamily: 'Source Han Sans CN', fontSize: 60, color: '#FFFFFF', position: 'bottom' };
const polish = { fadeIn: 0.8, fadeOut: 1.6, sharpen: 0.6, vignette: 0.15 };

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

function buildCutPlan(beats, maxSource = 145) {
  const grid = [];
  for (const section of SECTIONS) {
    for (let cut = 0; cut < section.cuts; cut++) grid.push({ beats: section.beatsPerCut, section });
  }
  // 从 MUSIC_FROM 之后的第一个实测节拍开始铺镜头，剪辑点全部落在节拍上。
  const start = beats.findIndex((time) => time >= MUSIC_FROM);
  if (start < 0) throw new Error('节拍网格里找不到配乐入点');
  // analyzeBeats 只分析前 120s；超出实测网格的节拍用平均间距外推兜底。
  const avg = (beats[beats.length - 1] - beats[0]) / (beats.length - 1);
  const beatAt = (index) => index < beats.length ? beats[index] : beats[beats.length - 1] + (index - (beats.length - 1)) * avg;
  let beatIndex = start;
  let cursor = 0;
  const plan = [];
  let shotCursor = 0;
  for (const entry of grid) {
    const spacing = beatAt(beatIndex + entry.beats) - beatAt(beatIndex);
    if (!(spacing > 0.2)) throw new Error('节拍间距异常');
    const section = entry.section;
    const motionType = section.motion[plan.length % section.motion.length];
    const speed = section.name === '高潮' ? (plan.length % 3 === 2 ? 2.6 : section.speed) : section.speed;
    // 镜头池循环复用（复用时后移 1.5s），并防变速后的源消耗越出素材末尾。
    const rawSourceIn = SHOTS[shotCursor % SHOTS.length] + Math.floor(shotCursor / SHOTS.length) * 1.5;
    const sourceIn = Math.min(rawSourceIn, maxSource - spacing * speed - 0.4);
    if (sourceIn < 0) throw new Error('素材时长不足以承载该卡点结构');
    shotCursor += 1;
    plan.push({ start: Number(cursor.toFixed(3)), duration: Number(spacing.toFixed(3)), sourceIn: Number(sourceIn.toFixed(2)),
      speed, motion: { type: motionType, amount: section.amount } });
    cursor += spacing;
    beatIndex += entry.beats;
  }
  return { plan, timelineSeconds: Number(cursor.toFixed(3)), startBeat: beats[start] };
}

async function setupFilm() {
  for (const name of ["EAC_DEMO_FOOTAGE","EAC_DEMO_MUSIC"]) {
    if (!process.env[name]) throw new Error(`Set ${name} to a local, authorized media file before running setup-film`);
  }
  const project = await engine.handle('project_create', {
    title: '大唐芙蓉园 · 震撼样片',
    brief: '用户 4K D-Log 航拍古建素材：音乐卡点剪辑（副歌密度递进）、变速递进模拟速度渐变、数字运镜（zoom/pan）、专业参数化调色（曲线/HSL 二级/分区）、中文字幕、片尾淡出。1080p30，约 56 秒。',
    width: 1920, height: 1080, fps,
  });
  await saveState({ projectId: project.id, footage, music });
  const imported = await engine.handle('asset_import', { projectId: project.id, path: footage });
  const asset = imported.assets.find((item) => item.path === footage) || imported.assets[0];

  const { analyzeBeats } = await import('../src/media/index.mjs');
  const beatAnalysis = await analyzeBeats(music);
  if (!beatAnalysis.beats.length) throw new Error('配乐节拍分析失败');
  const { plan, timelineSeconds } = buildCutPlan(beatAnalysis.beats);
  console.log(`节拍：bpm≈${beatAnalysis.bpm} · 置信度 ${beatAnalysis.confidence.toFixed(2)} · 样片 ${plan.length} 个镜头 · ${timelineSeconds.toFixed(1)}s`);

  const clips = plan.map((entry) => ({ assetId: asset.id, path: asset.path, kind: asset.kind,
    start: entry.start, duration: entry.duration, sourceIn: entry.sourceIn, speed: entry.speed,
    motion: entry.motion, volume: 0, track: 0 }));
  const latest = await engine.handle('project_get', { projectId: project.id });
  const updated = await engine.handle('timeline_update', { projectId: project.id, revision: latest.revision,
    clips, captions, subtitleStyle, musicPath: music, musicStart: beats_offset(beatAnalysis, plan), ...polish,
    look: { preset: 'showcase-vivid', exposure: 0.1 } });
  console.log(`项目就绪：${project.id} · revision ${updated.revision}`);
  await saveState({ ...(await loadState()), projectId: updated.id, timelineSeconds, plan });
}

// 配乐入点：样片 0s 对齐到第 startBeat 个实测节拍。
function beats_offset(analysis, plan) {
  void plan;
  const start = analysis.beats.findIndex((time) => time >= MUSIC_FROM);
  return Number(analysis.beats[start].toFixed(3));
}

async function preview() {
  const result = await submit('grade-preview', { framesPerClip: 3 });
  console.log(`对比表：${result.path}`);
  console.log(`调色已应用：${result.gradedApplied ? '是' : '否（当前无 look/grading）'}`);
  const byClip = new Map();
  for (const frame of result.frames) {
    if (!byClip.has(frame.clipIndex)) byClip.set(frame.clipIndex, []);
    byClip.get(frame.clipIndex).push(frame);
  }
  for (const [clipIndex, frames] of byClip) {
    const first = frames[0];
    const line = frames.map((f) => `Y${f.graded.lumaAvg.toFixed(0)}`).join('/');
    const sat = frames.map((f) => f.graded.saturationAvg.toFixed(2)).join('/');
    console.log(`  片段${clipIndex} ${first.grade || '未调色'} · 平均亮度 ${line} · 饱和 ${sat} · 原片 Y${first.original.lumaAvg.toFixed(0)} 饱和 ${first.original.saturationAvg.toFixed(2)} · 裁切 ${frames.map((f) => `${(f.graded.highlightClip * 100).toFixed(1)}%/${(f.graded.shadowCrush * 100).toFixed(1)}%`).join(' ')}`);
  }
  for (const warning of result.warnings) console.log(`护栏：${warning}`);
  await saveState({ ...(await loadState()), lastPreview: result.path });
}

function parseLook(value) {
  if (!value) return null;
  if (value.trim().startsWith('{')) return JSON.parse(value);
  return { preset: value };
}

async function look() {
  const state = await loadState();
  const project = await engine.handle('project_get', { projectId: state.projectId });
  const next = parseLook(args[1]);
  const updated = await engine.handle('timeline_update', { projectId: project.id, revision: project.revision,
    clips: project.clips, captions: project.captions || [], subtitleStyle: project.subtitleStyle, look: next });
  console.log(`look 已更新（revision ${updated.revision}）：${JSON.stringify(next)}`);
}

async function clip() {
  const state = await loadState();
  const project = await engine.handle('project_get', { projectId: state.projectId });
  const index = Number(args[1]);
  const grading = parseLook(args[2]);
  const clips = project.clips.map((item, i) => i === index ? { ...item, grading } : item);
  const updated = await engine.handle('timeline_update', { projectId: project.id, revision: project.revision,
    clips, captions: project.captions || [], subtitleStyle: project.subtitleStyle, look: project.look ?? null });
  console.log(`片段 ${index} 调色已更新（revision ${updated.revision}）：${JSON.stringify(grading)}`);
}

async function subset() {
  const indexes = args[1].split(',').map(Number);
  const frames = Number(args[2] || 2);
  const state = await loadState();
  const project = await engine.handle('project_get', { projectId: state.projectId });
  const { gradePreview } = await import('../src/media/index.mjs');
  const clips = indexes.map((index, position) => {
    const clip = structuredClone(project.clips[index]);
    if (!clip) throw new Error(`片段 ${index} 不存在`);
    return { ...clip, start: position * clip.duration, track: 0 };
  });
  const result = await gradePreview({ project: { ...structuredClone(project), clips },
    outputPath: resolve(ROOT, 'artifacts', 'showcase-inspect', 'subset-preview.png'), framesPerClip: frames });
  console.log(`代表镜头对比表：${result.path}`);
  for (const [position, frame] of result.frames.entries()) {
    if (frame.graded === undefined) continue;
  }
  for (const frame of result.frames) {
    console.log(`  源${frame.sourceTime}s ${frame.grade || '未调色'} · 原片 Y${frame.original.lumaAvg.toFixed(0)}/S${frame.original.saturationAvg.toFixed(2)} → 调后 Y${frame.graded.lumaAvg.toFixed(0)}/S${frame.graded.saturationAvg.toFixed(2)} · 高光裁切 ${(frame.graded.highlightClip * 100).toFixed(2)}% 暗部触底 ${(frame.graded.shadowCrush * 100).toFixed(2)}%`);
  }
  for (const warning of result.warnings) console.log(`护栏：${warning}`);
}

async function render() {
  const result = await submit('render', {});
  console.log(`成片：${result.path}`);
  console.log(`质检：${result.qa?.ok ? '通过' : '失败'} · 时长 ${result.qa?.duration?.toFixed?.(2)}s · 抽帧 ${result.review?.path}`);
  for (const warning of result.qa?.warnings || []) console.log(`警告：${warning}`);
  await saveState({ ...(await loadState()), lastRender: result.path });
}

async function scopes() {
  const result = await submit('scopes', {});
  console.log(`示波器：${result.path}\n${result.layout.top} / ${result.layout.bottom}`);
}

async function exportAll() {
  const result = await submit('export', {});
  console.log(`导出完成：${result.files?.length ?? 0} 个文件`);
  for (const file of result.files || []) console.log(`  ${file}`);
  if (result.jianYingDraftInstalled) console.log(`剪映草稿已安装：${result.jianYingDraftInstalled}`);
  for (const note of result.notes || []) console.log(`说明：${note}`);
}

try {
  if (command === 'setup-film') await setupFilm();
  else if (command === 'preview') await preview();
  else if (command === 'subset') await subset();
  else if (command === 'look') await look();
  else if (command === 'clip') await clip();
  else if (command === 'render') await render();
  else if (command === 'scopes') await scopes();
  else if (command === 'export') await exportAll();
  else {
    console.log('用法：node scripts/demo-showcase.mjs <setup-film|preview|look|clip|render|scopes|export>');
    const state = await loadState();
    if (state.projectId) console.log(`当前项目：${state.projectId}`);
  }
} finally {
  await engine.close();
}
