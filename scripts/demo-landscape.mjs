// End-to-end landscape film demo: import real footage (user's D-Log aerial MOV),
// cut a montage, iterate AI color grading via grade-preview, caption, fetch online
// CC music (Commons, keyless), render, QC and export NLE projects. Phases run
// separately so the AI operator can iterate the grade between previews:
//   node scripts/demo-landscape.mjs setup-film     导入用户素材+分段剪辑+在线配乐（Commons）
//   node scripts/demo-landscape.mjs preview        生成调色前后对比帧（每行：左原始右调色）
//   node scripts/demo-landscape.mjs look <presetId|json>   设置项目级调色（覆盖式）
//   node scripts/demo-landscape.mjs clip <index> <presetId|json>  单片段调色
//   node scripts/demo-landscape.mjs captions       写入风景文案字幕
//   node scripts/demo-landscape.mjs render         渲染+质检
//   node scripts/demo-landscape.mjs export         导出剪映/XML/SRT/LUT
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROOT } from '../src/catalog.mjs';

const stateFile = resolve(ROOT, 'artifacts', 'demo-landscape.json');
const footage = process.env.EAC_DEMO_FOOTAGE;
const fps = 25;
// 手选分段：航拍前进弧线上的五个阶段（开场雾山 → 推进 → 森林腹地 → 山谷 → 收束）。
const segments = [
  { sourceIn: 0.8, duration: 7.6 },
  { sourceIn: 10.0, duration: 8.0 },
  { sourceIn: 19.5, duration: 8.0 },
  { sourceIn: 31.5, duration: 8.0 },
  { sourceIn: 43.5, duration: 7.8 },
];
const captions = [
  { start: 1.2, end: 5.2, text: '雾从山脊漫过来，山把自己交给天空' },
  { start: 8.4, end: 13.0, text: '风穿过林梢，绿色一层层醒着' },
  { start: 16.5, end: 21.0, text: '水声在谷底，把时间磨得很慢' },
  { start: 24.5, end: 29.0, text: '光落在身上的时候，山野也在看你' },
  { start: 32.5, end: 36.5, text: '走过山水之间 · EAC design world' },
];

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
    await new Promise((done) => setTimeout(done, 1200));
  }
}
const submit = async (type, params) => awaitJob((await engine.handle('job_submit', { projectId: (await loadState()).projectId, type, params })).id);

async function setupFilm() {
  for (const name of ["EAC_DEMO_FOOTAGE"]) {
    if (!process.env[name]) throw new Error(`Set ${name} to a local, authorized media file before running setup-film`);
  }
  const project = await engine.handle('project_create', {
    title: '山水之间 · 风景短片', brief: '用户 4K D-Log 航拍山水森林素材：AI 调色（D-Log 展开）、分段剪辑、在线 CC 配乐与字幕。1080p25，约 40 秒。',
    width: 1920, height: 1080, fps,
  });
  await saveState({ projectId: project.id, footage });
  const imported = await engine.handle('asset_import', { projectId: project.id, path: footage });
  const asset = imported.assets.find((item) => item.path === footage) || imported.assets[0];

  // 在线配乐：维基共享（免 Key，CC 授权）。挑一首环境钢琴；失败则回退本地作曲。
  let music = null;
  try {
    const found = await engine.handle('stock_search', { kind: 'music', query: 'ambient piano', perPage: 10 });
    const pick = found.results.find((item) => item.durationSec >= 45 && item.durationSec <= 400)
      || found.results.find((item) => item.durationSec >= 30);
    if (pick) {
      console.log(`配乐：${pick.provider}/${pick.id} · ${Math.round(pick.durationSec)}s · ${pick.license} · ${pick.author}`);
      const result = await submit('stock-download', { provider: pick.provider, kind: 'music', id: pick.id, setAsMusic: true });
      music = { path: result.path, author: pick.author, license: pick.license, title: pick.title };
    }
  } catch (error) {
    console.log(`在线配乐不可用（${error.message}），回退本地作曲。`);
  }
  if (!music) {
    const result = await submit('compose', { duration: 44, bpm: 72, seed: 'landscape-film' });
    music = { path: result.path, author: 'EAC 原创合成器', license: '原创' };
  }
  console.log(`配乐文件：${music.path}`);

  let cursor = 0;
  const clips = segments.map((segment, index) => {
    const clip = { assetId: asset.id, path: asset.path, kind: asset.kind,
      start: cursor, duration: segment.duration, sourceIn: segment.sourceIn, volume: 0, track: 0 };
    cursor += segment.duration;
    void index;
    return clip;
  });
  // asset_import 与配乐设置都会推进 revision，提交前取最新值。
  const latest = await engine.handle('project_get', { projectId: project.id });
  const updated = await engine.handle('timeline_update', { projectId: project.id, revision: latest.revision, clips });
  console.log(`项目就绪：${project.id} · ${clips.length} 段 · ${cursor.toFixed(1)}s`);
  await saveState({ ...(await loadState()), projectId: updated.id, music, timelineSeconds: cursor });
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

async function setMusic() {
  const state = await loadState();
  const project = await engine.handle('project_get', { projectId: state.projectId });
  const musicPath = args[1];
  if (!musicPath) throw new Error('请提供本地音频路径');
  const updated = await engine.handle('timeline_update', { projectId: project.id, revision: project.revision,
    clips: project.clips, captions: project.captions || [], subtitleStyle: project.subtitleStyle,
    look: project.look ?? null, musicPath });
  console.log(`配乐已切换：${musicPath}（revision ${updated.revision}）`);
}

async function setCaptions() {
  const state = await loadState();
  const project = await engine.handle('project_get', { projectId: state.projectId });
  await engine.handle('timeline_update', { projectId: project.id, revision: project.revision,
    clips: project.clips, captions, look: project.look ?? null,
    subtitleStyle: { fontFamily: 'Source Han Sans CN', fontSize: 56, color: '#FFFFFF', position: 'bottom' } });
  console.log(`字幕已写入：${captions.length} 段`);
}

async function render() {
  const result = await submit('render', {});
  console.log(`成片：${result.path}`);
  console.log(`质检：${result.qa?.ok ? '通过' : '失败'} · 时长 ${result.qa?.duration?.toFixed?.(2)}s · 抽帧 ${result.review?.path}`);
  for (const warning of result.qa?.warnings || []) console.log(`警告：${warning}`);
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
  else if (command === 'look') await look();
  else if (command === 'clip') await clip();
  else if (command === 'music') await setMusic();
  else if (command === 'captions') await setCaptions();
  else if (command === 'render') await render();
  else if (command === 'export') await exportAll();
  else {
    console.log('用法：node scripts/demo-landscape.mjs <setup-film|preview|look|clip|captions|render|export>');
    const state = await loadState();
    if (state.projectId) console.log(`当前项目：${state.projectId}`);
  }
} finally {
  await engine.close();
}
