// Bundled lock runtime: in-place updates retain the old node_modules, so a bare
// 'proper-lockfile' import would break existing installs until a manual npm install.
import lockfile from '../vendor/eac-runtime/proper-lockfile.cjs';
import { browserLaunchOptions } from './browser.mjs';
import { mkdir, readFile, writeFile, realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, extname, basename, relative, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Store } from './store.mjs';
import { DesignStore } from './design-store.mjs';
import { ROOT, getTemplates, resolveTemplate, loadLibrary, libraryCatalogEntry, workflowRecipes } from './catalog.mjs';
import { motionSkills, readMotionLibraryItem } from './motion-libraries.mjs';
import { readShotcraftLibraryItem, resolveShotcraftPath, shotcraftLibraryInfo } from './shotcraft-library.mjs';
import { productionInstructions } from './tools.mjs';

const jobTypes = new Set(['record-browser', 'record-desktop', 'analyze', 'beats', 'transcribe', 'rough-cut', 'captions', 'voice', 'compose', 'render', 'render-template', 'produce', 'grade-preview', 'scopes', 'stock-download', 'export']);
const finite = (n, fallback, min, max) => {
  const value = n === undefined ? fallback : Number(n);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`数值必须在 ${min} 与 ${max} 之间`);
  return value;
};
const MOTION_TYPES = new Set(['zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down']);
const WINDOW_SHAPES = new Set(['circle', 'rect', 'linear']);
function validateMotion(motion) {
  if (!MOTION_TYPES.has(motion?.type)) throw new Error(`运镜类型无效：${motion?.type}；可用：zoom-in、zoom-out、pan-left、pan-right、pan-up、pan-down`);
  finite(motion.amount ?? 0.12, 0.12, 0, 0.5);
}
function validateWindows(windows) {
  if (!Array.isArray(windows) || windows.length > 4) throw new Error('蒙版窗口最多 4 个');
  for (const win of windows) {
    if (!WINDOW_SHAPES.has(win?.shape)) throw new Error(`蒙版形状无效：${win?.shape}；可用：circle、rect、linear`);
    if (win.grading === undefined || win.grading === null || typeof win.grading !== 'object' || Array.isArray(win.grading)) throw new Error('蒙版窗口需要 grading 调色参数（窗口内分区调色）');
    for (const [key, min, max] of [['x', 0, 1], ['y', 0, 1], ['radius', 0.05, 1], ['width', 0.05, 2], ['height', 0.05, 2], ['angle', -180, 180], ['feather', 0, 0.45], ['opacity', 0, 1]]) {
      if (win[key] !== undefined && (typeof win[key] !== 'number' || !Number.isFinite(win[key]) || win[key] < min || win[key] > max)) throw new Error(`蒙版窗口 ${key} 必须在 ${min} 与 ${max} 之间`);
    }
  }
}
const childOf = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..`) && !isAbsolute(rel));
};
function safeOutputName(value) {
  return String(value || 'film').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 80);
}
// Provider credentials never leave the process. Public state and settings responses expose
// only whether each credential is configured; the raw values stay in the store for providers.
const SECRET_SETTINGS = Object.freeze({
  pexelsApiKey: 'pexelsApiKeyConfigured',
  pixabayApiKey: 'pixabayApiKeyConfigured',
  jamendoClientId: 'jamendoClientIdConfigured'
});
const configured = (value) => typeof value === 'string' ? value.trim().length > 0 : Boolean(value);
function withoutSecrets(settings) {
  const { pexelsApiKey, pixabayApiKey, jamendoClientId, ...rest } = settings || {};
  return rest;
}
export function publicSettings(settings) {
  const safe = withoutSecrets(settings);
  for (const [secret, flag] of Object.entries(SECRET_SETTINGS)) safe[flag] = configured(settings?.[secret]);
  return safe;
}
// Draft names must stay unique after the exporter's own 60-character stem clamp. Reserve the
// revision/job suffix first, then fill the remaining room with a sanitized, bounded title.
const DRAFT_NAME_LIMIT = 60;
function boundedText(value, limit) {
  let text = '';
  let used = 0;
  for (const char of Array.from(String(value ?? ''))) {
    if (used + char.length > limit) break;
    text += char;
    used += char.length;
  }
  return text;
}
function draftNameFor(project, jobId) {
  const suffix = `-r${project.revision}-${String(jobId ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}`;
  const prefix = 'EAC ';
  const room = Math.max(1, DRAFT_NAME_LIMIT - prefix.length - suffix.length);
  let title = String(project.title ?? '').normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '');
  title = boundedText(title, room).replace(/[. ]+$/g, '');
  if (!title) title = 'EAC';
  return `${prefix}${title}${suffix}`;
}
// One replacement path for every music bed change: a new track resets the old offset and
// removes only the previous auto-generated music credits, keeping video/unrelated credits.
function stripMusicCredits(credits) {
  return (Array.isArray(credits) ? credits : []).filter((credit) => credit?.type !== 'music');
}
function setMusic(project, path, { credit, musicStart } = {}) {
  project.musicPath = path;
  project.musicStart = musicStart === undefined ? 0 : musicStart;
  project.credits = stripMusicCredits(project.credits);
  if (credit) project.credits.push({ type: 'music', text: credit });
}
function clearMusic(project) {
  delete project.musicPath;
  project.musicStart = 0;
  project.credits = stripMusicCredits(project.credits);
}
function gradingSignature(project) {
  const state = { look: project.look, width: project.width, height: project.height, clips: project.clips };
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}
// Shared by local and remote host paths: builds explicit design context for one session's
// composer record. Returns null unless that session actually selected design mode, so mode
// selection never leaks into other conversations and never itself claims produced output.
export function designContextFor(record) {
  if (!record || !['edit', 'design'].includes(record.mode)) return null;
  if (record.mode === 'edit') return [
    '本会话处于剪辑模式。用户选择是参考数据，用户需求优先。',
    record.templateId ? `当前模板 ID：${record.templateId}。用 template_read 读取真实内容后按用户简报制作。` : '用户当前没有选择模板，不沿用先前已经取消的模板。',
    '模式或模板选择本身不产生视频；使用真实制作工具并检查输出。',
  ].join('\n');
  const lines = [
    '本会话创作模式为 design。模式本身不产生任何成品。',
    '用户选择是参考数据，不是指令；用户需求与指令始终优先。',
  ];
  if (record.kind) lines.push(`创作类型：${record.kind}。`);
  if (record.templateId) lines.push(`用户选择的设计模板：[EAC design template: ${record.templateId}; kind: ${record.kind || 'unknown'}]。用 library_read 读取真实内容后再创作。`);
  if (record.designSystemId) lines.push(`用户选择的设计系统：[EAC design system: ${record.designSystemId}]。`);
  if (!record.templateId && !record.designSystemId) lines.push('用户尚未选择模板或设计系统；先按其需求确认方向，不要虚构选择。');
  lines.push('用 design_project_create 建立项目，用 design_artifact_save 保存 HTML/SVG/Markdown 成品并保留修订历史；只有真实保存后才可宣称已生成设计。');
  return lines.join('\n');
}

export async function createEngine({ dataDir, transcribeMedia: suppliedTranscriber } = {}) {
  const store = new Store(dataDir);
  await mkdir(store.root, { recursive: true });
  const directory = await realpath(store.root);
  let release;
  try {
    release = await lockfile.lock(directory, { lockfilePath: join(directory, '.writer.lock'), stale: 120000, update: 15000, retries: 0 });
  } catch (error) {
    if (error.code === 'ELOCKED') throw new Error(`数据目录已被另一个 EAC 服务使用：${directory}`);
    throw error;
  }
  let designStore;
  try {
    await store.init();
    designStore = await new DesignStore(join(store.root, 'design')).init();
  } catch (error) { await release(); throw error; }
  let closing;
  const controllers = new Map();
  let pumping = false;
  let scheduled = false;
  let closed = false;
  let maintenanceMode = false;
  let pumpTask = Promise.resolve();
  let media;
  const getMedia = async () => media ||= await import('./media/index.mjs');
  const capabilityCache = new Map();

  async function capabilities() {
    if (!capabilityCache.has('ffmpeg')) {
      for (const name of ['ffmpeg', 'ffprobe']) {
        capabilityCache.set(name, spawnSync(name, ['-version'], { windowsHide: true, timeout: 5000 }).status === 0);
      }
    }
    let browserPath, browserError;
    try { browserPath = browserLaunchOptions((await import('playwright')).chromium).executablePath; }
    catch (error) { browserError = error.message; }
    if (!capabilityCache.has('transcript')) {
      const { transcriptCapabilities } = await import('./transcript.mjs');
      capabilityCache.set('transcript', await transcriptCapabilities());
    }
    const transcript = capabilityCache.get('transcript');
    return [
      { id: 'ffmpeg', name: '剪辑与编码', available: capabilityCache.get('ffmpeg') && capabilityCache.get('ffprobe'), detail: 'FFmpeg / FFprobe 本地执行' },
      { id: 'browser', name: '真实网页录制', available: Boolean(browserPath), detail: browserPath || browserError },
      { id: 'desktop', name: '桌面录制', available: process.platform === 'win32' && capabilityCache.get('ffmpeg'), detail: 'Windows gdigrab，按任务时长录制' },
      { id: 'voice', name: '本地旁白', available: ['win32', 'darwin'].includes(process.platform), detail: process.platform === 'darwin' ? 'macOS say；声线质量取决于已安装语音' : 'Windows SAPI；声线质量取决于已安装语音' },
      { id: 'music', name: '原创器乐', available: true, detail: '共享节拍网格的本地合成器' },
      { id: 'captions', name: '时间线字幕', available: capabilityCache.get('ffmpeg'), detail: '时间戳映射、中文 ASS 字幕与成片烧录' },
      { id: 'transcription', name: '语音转录', available: transcript.available, detail: transcript.detail },
      { id: 'grading', name: '参数化调色工作台', available: capabilityCache.get('ffmpeg'), detail: '曲线/HSL 二级/分区轮/色相曲线可导出 .cube；局部蒙版参与原生渲染，NLE 需重建。含对比预览、统计护栏、示波器、调色版本和曝光匹配建议' },
      ...(await stockCapability()),
      { id: 'nle-export', name: '剪辑工程导出', available: true, detail: '剪映草稿 / Premiere FCP7 XML / SRT / .cube LUT（必剪为封闭格式，走 SRT+LUT 方案）' },
      { id: 'semantic-review', name: '视觉与叙事审片', available: false, detail: '由宿主有视觉能力的 AI 检查抽帧；机器检查仅覆盖技术指标' }
    ];
  }
  // Providers may be absent in stripped-down installs; capabilities degrade instead of failing.
  async function stockCapability() {
    try {
      const { providerStatus } = await import('./providers.mjs');
      const status = providerStatus(store.state.settings);
      const configured = status.filter((item) => item.configured);
      const names = configured.map((item) => item.id).join('、') || '无可用源';
      return [{ id: 'stock', name: '网络素材与配乐', available: configured.length > 0, detail: `已配置：${names}${status.some((i) => i.id === 'commons') ? '；commons 维基共享无需 Key' : ''}` }];
    } catch {
      return [{ id: 'stock', name: '网络素材与配乐', available: false, detail: '素材源模块不可用' }];
    }
  }

  async function projectInput(args) {
    const template = args.templateId ? await resolveTemplate(args.templateId) : undefined;
    if (template?.kind && template.kind !== 'motion') throw new Error('剪辑项目需要动效视频模板；网站、幻灯片和文档请在设计工作台创建');
    const width = finite(args.width, template?.width || 1920, 160, 3840);
    const height = finite(args.height, template?.height || 1080, 90, 3840);
    if (width % 2 || height % 2) throw new Error('视频宽高必须是偶数');
    const title = String(args.title || '').trim();
    if (!title || title.length > 160) throw new Error('请输入 1 至 160 字的项目名称');
    const fps = finite(args.fps, 30, 12, 60);
    if (!Number.isInteger(fps)) throw new Error('当前导出需要整数帧率');
    return {
      id: randomUUID(), title, brief: String(args.brief || ''),
      templateId: template?.id || 'motion-promo-film-v2', width, height,
      fps, revision: 1, assets: [], clips: [], history: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
  }
  async function importAsset(projectId, file) {
    const path = await realpath(resolve(file));
    if (!(await stat(path)).isFile()) throw new Error('素材不是文件');
    const probe = await (await getMedia()).probeMedia(path);
    const streams = probe.streams || [];
    const image = /\.(png|jpe?g|webp|bmp)$/i.test(path);
    const kind = image ? 'image' : streams.some((s) => s.codec_type === 'video') ? 'video' : 'audio';
    if (!streams.some((s) => ['video', 'audio'].includes(s.codec_type))) throw new Error('不支持的素材格式');
    const duration = Number(probe.format?.duration || streams.find((s) => s.duration)?.duration || 0);
    return store.updateProject(projectId, (p) => {
      if (!p.assets.some((asset) => asset.path === path)) {
        p.assets.push({ id: randomUUID(), path, name: basename(path), kind, duration, probe, importedAt: new Date().toISOString() });
      }
    });
  }
  async function plan(projectId, args = {}, expectedRevision) {
    const project = store.project(projectId);
    const sources = project.assets.filter((a) => a.kind !== 'audio');
    if (!sources.length) throw new Error('请先导入视频或图片，或执行真实录制');
    const bpm = finite(args.bpm, 100, 30, 240);
    const requested = finite(args.duration, Math.min(3600, sources.reduce((n, a) => n + (a.duration || 4), 0)), 0.1, 3600);
    const beat = 60 / bpm;
    const clips = [];
    let cursor = 0;
    for (const asset of sources) {
      if (cursor >= requested - 0.01) break;
      const available = asset.kind === 'image' ? 4 : asset.duration;
      if (available <= 0) continue;
      const desired = Math.min(available, requested - cursor);
      const snapped = Math.floor(desired / beat) * beat;
      const duration = snapped > 0.1 && cursor + desired < requested - 0.01 ? snapped : desired;
      clips.push({ id: randomUUID(), assetId: asset.id, path: asset.path, kind: asset.kind, start: cursor, sourceIn: 0, duration, volume: 1, track: 0 });
      cursor += duration;
    }
    if (!clips.length) throw new Error('素材时长不足以生成剪辑');
    const beatSheet = clips.map((clip, i) => ({
      shot: i + 1, start: clip.start, end: clip.start + clip.duration,
      asset: basename(clip.path), purpose: i === 0 ? '开场' : i === clips.length - 1 ? '收束' : '叙事',
      review: '需结合实际画面审查镜头选择与叙事'
    }));
    return store.updateProject(projectId, (p) => {
      p.history.push({ revision: p.revision, clips: p.clips, beatSheet: p.beatSheet, at: new Date().toISOString() });
      p.clips = clips;
      delete p.captions;
      delete p.captionSource;
      p.beatSheet = beatSheet;
      p.bpm = bpm;
      p.plan = { requestedDuration: requested, actualDuration: cursor, warning: cursor + 0.1 < requested ? '源素材不足目标时长，未自动复制或补造镜头' : null };
    }, expectedRevision);
  }
  async function jobOutput(job, filename) {
    const root = resolve(store.state.settings.outputRoot);
    const directory = join(root, job.projectId, job.id);
    await mkdir(directory, { recursive: true });
    return join(directory, filename);
  }
  async function updateProgress(job, progress, stage) {
    const current = store.state.jobs.find((item) => item.id === job.id) || job;
    current.progress = Math.min(0.99, Math.max(current.progress || 0, progress));
    current.stage = stage;
    await store.save();
  }
  async function runJob(job, signal) {
    const tools = await getMedia();
    const params = job.params || {};
    const project = store.project(job.projectId);
    const signalOptions = { signal };
    switch (job.type) {
      case 'record-browser': {
        const outputDir = await jobOutput(job, 'capture');
        const result = await tools.recordBrowser({ ...params, outputDir, width: project.width, height: project.height, ...signalOptions });
        const path = typeof result === 'string' ? result : result.path || result.outputPath || result.videoPath;
        if (!path) throw new Error('录制器没有返回文件路径');
        await importAsset(project.id, path);
        return result;
      }
      case 'record-desktop': {
        const outputPath = await jobOutput(job, 'desktop.mp4');
        const result = await tools.recordDesktop({ ...params, outputPath, ...signalOptions });
        await importAsset(project.id, outputPath);
        return result;
      }
      case 'analyze':
      case 'beats': {
        const asset = project.assets.find((a) => a.id === params.assetId || a.path === params.path);
        if (!asset) throw new Error('请提供项目内素材的 assetId');
        const analysis = job.type === 'beats' ? await tools.analyzeBeats(asset.path, { ...params, signal }) : await tools.analyzeMedia(asset.path, { signal });
        await store.updateProject(project.id, (p) => {
          p.assets.find((a) => a.id === asset.id)[job.type === 'beats' ? 'beats' : 'analysis'] = analysis;
        });
        return analysis;
      }
      case 'transcribe':
      case 'rough-cut': {
        const asset = project.assets.find((a) => a.id === params.assetId || a.path === params.path);
        if (!asset) throw new Error('请提供要转录素材的 assetId');
        const { transcribeMedia, generateKeepRanges } = await import('./transcript.mjs');
        const transcript = await (suppliedTranscriber || transcribeMedia)({ ...params, path: asset.path, outputDir: await jobOutput(job, 'transcript'), signal });
        signal.throwIfAborted();
        const ranges = generateKeepRanges(transcript.segments, params);
        const metadata = await store.updateProject(project.id, (p) => {
          const current = p.assets.find((a) => a.id === asset.id);
          current.transcript = transcript;
          current.keepRanges = ranges;
        });
        if (job.type === 'rough-cut') {
          if (metadata.revision !== project.revision + 1) throw new Error('转录期间项目已被人工修改；转录结果已保留，请审查后重新初剪');
          if (asset.kind !== 'video') throw new Error('口播初剪需要视频素材');
          let cursor = 0;
          const clips = ranges.map((range) => {
            const duration = Math.min(asset.duration, range.end) - range.start;
            const clip = { id: randomUUID(), assetId: asset.id, path: asset.path, kind: asset.kind,
              start: cursor, duration, sourceIn: range.start, volume: 1, track: 0 };
            cursor += duration;
            return clip;
          }).filter((clip) => clip.duration > 0.01);
          if (!clips.length) throw new Error('未识别到可保留的语音片段');
          await store.updateProject(project.id, (p) => {
            p.history.push({ revision: p.revision, clips: p.clips, at: new Date().toISOString() });
            p.clips = clips;
            delete p.captions;
            delete p.captionSource;
          }, metadata.revision);
        }
        return { ...transcript, keepRanges: ranges, reviewRequired: true };
      }
      case 'captions': {
        const asset = project.assets.find((a) => a.id === params.assetId);
        if (!asset?.transcript?.segments) throw new Error('请先转录所选素材，再生成时间线字幕');
        const captions = tools.remapTranscriptToTimeline({ segments: asset.transcript.segments, clips: project.clips, assetId: asset.id });
        if (!captions.length) throw new Error('所选素材的转录未覆盖当前时间线');
        signal.throwIfAborted();
        const updated = await store.updateProject(project.id, (p) => {
          p.captions = captions;
          if (params.subtitleStyle) p.subtitleStyle = params.subtitleStyle;
          p.captionSource = { assetId: asset.id, timelineRevision: project.revision };
        }, project.revision);
        return { captions: updated.captions, count: updated.captions.length, revision: updated.revision };
      }
      case 'voice': {
        const outputPath = await jobOutput(job, 'voice.wav');
        const result = await tools.synthesizeVoice({ ...params, voice: params.voice || store.state.settings.ttsVoice || undefined, outputPath, ...signalOptions });
        await store.updateProject(project.id, (p) => { p.voicePath = outputPath; });
        return result;
      }
      case 'compose': {
        const outputPath = await jobOutput(job, 'music.wav');
        const duration = params.duration || Math.max(1, ...project.clips.map((c) => c.start + c.duration));
        const result = await tools.composeMusic({ ...params, duration, outputPath, ...signalOptions });
        await store.updateProject(project.id, (p) => { setMusic(p, outputPath); });
        return result;
      }
      case 'render': {
        const outputPath = await jobOutput(job, `${safeOutputName(project.title)}.mp4`);
        const snapshot = { ...structuredClone(project), quality: store.state.settings.quality };
        const result = await tools.renderTimeline({ project: snapshot, outputPath, signal, onProgress: (n) => {
          void updateProgress(job, typeof n === 'number' ? n : n.progress || 0, '剪辑与混音');
        }});
        const qa = await tools.qualityCheck({ path: outputPath, expectedDuration: Math.max(...snapshot.clips.map((c) => c.start + c.duration)), signal });
        if (snapshot.voicePath) {
          const voice = await tools.probeMedia(snapshot.voicePath);
          if (voice.duration > qa.duration + 0.15) qa.warnings.push('旁白长于时间线，结尾会被截断；请延长画面或缩短旁白后交付。');
        }
        if (!qa.ok) throw new Error(`成片技术质检失败：${qa.errors.join('; ')}`);
        const { createReviewSheet } = await import('./media/review.mjs');
        const review = await createReviewSheet({ path: outputPath, outputPath: await jobOutput(job, 'review-sheet.jpg'), duration: qa.duration, signal });
        await writeFile(await jobOutput(job, 'project.json'), JSON.stringify(snapshot, null, 2));
        await writeFile(await jobOutput(job, 'qa.json'), JSON.stringify(qa, null, 2));
        await store.updateProject(project.id, (p) => { p.lastOutput = { path: outputPath, qa, review, revision: snapshot.revision }; });
        return { ...(typeof result === 'object' ? result : {}), path: outputPath, qa, review, sourceRevision: snapshot.revision };
      }
      case 'render-template': {
        const { renderTemplate } = await import('./render-template.mjs');
        return renderTemplate({ ...params, templateId: params.templateId || project.templateId, outputPath: await jobOutput(job, 'template-preview.mp4'), signal,
          onProgress: (n) => { void updateProgress(job, n, '逐帧渲染'); } });
      }
      case 'produce': {
        const startingClips = JSON.stringify(project.clips);
        const steps = [];
        const invoke = async (type, inputs, progress) => {
          signal.throwIfAborted();
          await updateProgress(job, progress, type);
          const result = await runJob({ ...job, type, params: inputs }, signal);
          steps.push({ type, result });
          return result;
        };
        if (params.url) await invoke('record-browser', { url: params.url, actions: params.actions || [] }, 0.05);
        for (const path of params.paths || []) { signal.throwIfAborted(); await importAsset(project.id, path); }
        let measuredBpm;
        if (params.musicPath) {
          const path = await realpath(resolve(params.musicPath));
          await importAsset(project.id, path);
          await store.updateProject(project.id, (p) => { setMusic(p, path); });
          measuredBpm = (await invoke('beats', { path }, 0.3)).bpm;
        }
        if (JSON.stringify(store.project(project.id).clips) !== startingClips) throw new Error('制作期间时间线已被人工修改，请审查素材后重新提交');
        const resolvedBpm = params.bpm || measuredBpm || 100;
        await plan(project.id, { duration: params.duration, bpm: resolvedBpm }, store.project(project.id).revision);
        if (!params.musicPath) await invoke('compose', { duration: params.duration, bpm: resolvedBpm }, 0.35);
        if (params.narration) await invoke('voice', { text: params.narration }, 0.55);
        const render = await invoke('render', {}, 0.65);
        return { path: render.path, steps, qa: render.qa, review: render.review, reviewRequired: true, reviewInstruction: '审查真实成片的抽帧、叙事和文字后决定交付，不能用技术质检代替艺术评价。' };
      }
      case 'grade-preview': {
        const outputPath = await jobOutput(job, 'grade-preview.png');
        const result = await tools.gradePreview({
          project: structuredClone(project), outputPath,
          framesPerClip: params.framesPerClip, signal,
          onProgress: (n) => { void updateProgress(job, n, '调色对比帧'); },
        });
        await store.updateProject(project.id, (p) => {
          p.lastGradePreview = { path: outputPath, warnings: result.warnings, frames: result.frames, gradedApplied: result.gradedApplied,
            signature: gradingSignature(project), revision: project.revision, at: new Date().toISOString() };
        });
        return result;
      }
      case 'scopes': {
        const path = params.path || project.lastOutput?.path;
        if (!path) throw new Error('没有可生成示波器的视频；请先渲染成片或提供 params.path');
        return tools.createScopes({ path, outputPath: await jobOutput(job, 'scopes.png'), signal });
      }
      case 'stock-download': {
        const { resolveStockItem, downloadStockFile, PROVIDER_IDS } = await import('./providers.mjs');
        const provider = String(params.provider || '');
        const kind = params.kind === 'music' ? 'music' : 'video';
        if (!PROVIDER_IDS.includes(provider)) throw new Error(`未知素材源：${provider || '(空)'}；可用：${PROVIDER_IDS.join('、')}`);
        await updateProgress(job, 0.08, '解析素材条目');
        const item = await resolveStockItem({ provider, kind, id: params.id, settings: store.state.settings, signal });
        const mime = String(item.mimeType || '').toLowerCase();
        const extension = kind === 'music'
          ? (mime.includes('flac') ? '.flac' : mime.includes('ogg') ? '.oga' : '.mp3')
          : (mime.includes('webm') ? '.webm' : '.mp4');
        const outputPath = await jobOutput(job, `stock-${provider}-${String(params.id).replace(/[^\w.-]+/g, '_').slice(0, 60)}${extension}`);
        await updateProgress(job, 0.2, '下载素材');
        await downloadStockFile({
          url: item.downloadUrl, outputPath, signal,
          onProgress: ({ received, total }) => { if (total) void updateProgress(job, 0.2 + 0.6 * Math.min(1, received / total), '下载素材'); },
        });
        await updateProgress(job, 0.85, '导入项目');
        await importAsset(project.id, outputPath);
        const updated = await store.updateProject(project.id, (p) => {
          const asset = p.assets.find((a) => a.path === outputPath) || p.assets.find((a) => a.name === basename(outputPath));
          if (asset) {
            asset.source = { provider, id: String(params.id), author: item.author, title: item.title, license: item.license,
              url: item.previewUrl, attribution: item.attribution || null, downloadedAt: new Date().toISOString() };
            if (kind === 'music' && params.setAsMusic) {
              setMusic(p, asset.path, { credit: `音乐：${item.author} - ${item.title}（${item.license}）来源 ${item.previewUrl}` });
            }
          }
        });
        return { path: outputPath, kind, item: { provider, id: String(params.id), title: item.title, author: item.author, license: item.license },
          assetPath: updated.assets.find((a) => a.name === basename(outputPath))?.path || outputPath, credit: item.attribution };
      }
      case 'export': {
        const { runExport, jianYingDefaultDraftRoot } = await import('./export-nle.mjs');
        const outputDir = await jobOutput(job, 'export');
        await updateProgress(job, 0.2, '生成剪辑工程');
        const result = await runExport({ project: structuredClone(project), outputDir, targets: params.targets,
          settings: { ...withoutSecrets(store.state.settings), draftName: draftNameFor(project, job.id) }, signal });
        await updateProgress(job, 0.8, '安装剪映草稿');
        const notes = [...(result.notes || [])];
        const draftRootSetting = String(store.state.settings.jianyingDraftRoot || '').trim();
        const draftRoot = draftRootSetting || jianYingDefaultDraftRoot();
        if (result.draftFolder && draftRoot) {
          try {
            let destination = join(resolve(draftRoot), result.draftName);
            if (existsSync(destination)) destination = join(resolve(draftRoot), `${result.draftName}-${job.id}`);
            await (await import('node:fs/promises')).cp(result.draftFolder, destination, { recursive: true, force: false, errorOnExist: true });
            result.jianYingDraftInstalled = destination;
          } catch (error) {
            notes.push(`剪映草稿目录写入失败（${error.message}）；草稿文件仍保留在导出目录，可手动复制。`);
          }
        }
        await store.updateProject(project.id, (p) => {
          p.exports ??= [];
          p.exports.push({ at: new Date().toISOString(), revision: project.revision, outputDir, files: result.files, draftName: result.draftName, installedTo: result.jianYingDraftInstalled || null });
        });
        return { ...result, notes, sourceRevision: project.revision };
      }
      default: throw new Error(`未知制作任务：${job.type}`);
    }
  }
  async function pump() {
    if (pumping || closed) return;
    pumping = true;
    try {
      let job;
      while (!closed && (job = store.state.jobs.findLast((item) => item.status === 'queued'))) {
        const controller = new AbortController();
        controllers.set(job.id, controller);
        job.status = 'running'; job.startedAt = new Date().toISOString();
        await store.save();
        try {
          const result = await runJob(job, controller.signal);
          controller.signal.throwIfAborted();
          job.result = result;
          job.status = 'completed'; job.progress = 1;
        } catch (error) {
          job.status = controller.signal.aborted ? 'cancelled' : 'failed';
          job.error = error.message;
        } finally {
          job.finishedAt = new Date().toISOString();
          controllers.delete(job.id);
          await store.save();
        }
      }
    } finally { pumping = false; }
  }
  function schedule() {
    if (pumping || scheduled || closed) return;
    scheduled = true;
    pumpTask = new Promise((done) => queueMicrotask(done)).then(() => {
      scheduled = false;
      return pump();
    }).catch((error) => { console.error('EAC queue:', error.message); });
  }
  // Session-scoped composer state: mode/template/kind selections are persisted per session so
  // the host can assemble design context for the correct conversation without cross-session leaks.
  const composerModes = new Set(['normal', 'edit', 'design']);
  const composerKinds = new Set(['website', 'deck', 'document', 'image', 'motion', 'prompt', 'example']);
  function composerKey(sessionId) {
    const key = sessionId === undefined || sessionId === null || sessionId === '' ? null : String(sessionId).slice(0, 200);
    if (!key) throw new Error('请提供会话 ID');
    return key;
  }
  function composerView(record) {
    if (!record) return { sessionId: null, mode: 'normal', kind: null, templateId: null, designSystemId: null, updatedAt: null };
    return structuredClone(record);
  }
  async function composerUpdate(args = {}) {
    const sessionId = composerKey(args.sessionId);
    if (!composerModes.has(args.mode)) throw new Error('创作模式必须是 normal、edit 或 design');
    if (args.kind !== undefined && args.kind !== null && !composerKinds.has(args.kind)) throw new Error('无效的创作类型');
    const templateId = args.templateId || null;
    const designSystemId = args.designSystemId || null;
    for (const id of [templateId, designSystemId]) {
      if (id !== null && (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id))) throw new Error('模板或设计体系 ID 无效');
    }
    const record = { sessionId, mode: args.mode, kind: args.kind ?? null, templateId, designSystemId, updatedAt: new Date().toISOString() };
    store.state.composer ??= {};
    store.state.composer[sessionId] = record;
    await store.save();
    return structuredClone(record);
  }
  function composerGet(sessionId) {
    const key = composerKey(sessionId);
    return composerView(store.state.composer?.[key]);
  }
  async function library() {
    const { openDesignTemplates, designSystems, creationModes, libraryStats, libraryProvenance,
      librarySkills, libraryPrompts, libraryAtoms, libraryScenarios } = await loadLibrary();
    const odTemplates = openDesignTemplates.map(libraryCatalogEntry);
    return {
      templates: [...getTemplates().map(item => ({ ...item, kind: 'motion' })), ...odTemplates],
      designSystems, creationModes, skills: [...librarySkills, ...motionSkills()], prompts: libraryPrompts,
      atoms: libraryAtoms, scenarios: libraryScenarios, stats: libraryStats,
      provenance: libraryProvenance,
      sourceLibraries: { 'video-shotcraft': shotcraftLibraryInfo() },
    };
  }
  const engine = {
    store, designStore, capabilities, library,
    setMaintenanceMode(value) { maintenanceMode = value; },
    async state({ includeTemplates = true } = {}) {
      const { composer, ...state } = store.snapshot();
      let gradingPresets = [];
      try { const { GRADING_PRESETS } = await import('./media/grading.mjs'); gradingPresets = GRADING_PRESETS; }
      catch { /* Grading module absent in stripped installs; the UI hides the panel. */ }
      return { ...state, settings: publicSettings(state.settings), templates: includeTemplates ? getTemplates() : [], recipes: workflowRecipes, capabilities: await capabilities(), gradingPresets };
    },
    async settingsUpdate(input) {
      if (closed) throw new Error('EAC 服务已关闭');
      const allowed = ['outputRoot', 'ttsVoice', 'quality', 'pexelsApiKey', 'pixabayApiKey', 'jamendoClientId', 'jianyingDraftRoot'];
      // Validate every provided value before touching the store so a rejected field can
      // never leave a partial settings mutation behind.
      const next = {};
      for (const key of allowed) {
        if (input[key] === undefined) continue;
        if (typeof input[key] !== 'string') throw new Error(`无效设置：${key}`);
        if (key === 'quality' && !['draft', 'production'].includes(input[key])) throw new Error('无效质量档位');
        // Secret fields keep their stored value unless explicitly changed; an empty string clears.
        next[key] = Object.hasOwn(SECRET_SETTINGS, key) ? input[key].trim() : input[key];
      }
      Object.assign(store.state.settings, next);
      await store.save();
      return publicSettings(store.state.settings);
    },
    async canServeFile(file) {
      try {
        const target = await realpath(resolve(file));
        const output = await realpath(resolve(store.state.settings.outputRoot)).catch(() => resolve(store.state.settings.outputRoot));
        return childOf(output, target) || store.state.projects.some((p) => p.assets.some((a) => a.path === target));
      } catch { return false; }
    },
    async handle(name, args = {}) {
      if (closed && !['status', 'project_get', 'job_status', 'template_read', 'library_read', 'library_list', 'library', 'design_state', 'composer_get'].includes(name)) throw new Error('EAC 服务已关闭');
      switch (name) {
        case 'status': return engine.state();
        case 'project_create': {
          const project = await projectInput(args);
          store.state.projects.unshift(project);
          await store.save();
          return structuredClone(project);
        }
        case 'project_get': return structuredClone(store.project(args.projectId));
        case 'asset_import': {
          const hasPath = args.path !== undefined;
          const hasTemplate = args.templateId !== undefined;
          if (hasPath === hasTemplate) throw new Error('请仅提供 path 或 templateId 中的一个');
          if (!hasTemplate) return importAsset(args.projectId, args.path);
          if (typeof args.templateId !== 'string' || !args.templateId.startsWith('sc-')) throw new Error('仅支持已注册的 Shotcraft 预览素材');
          const template = await resolveTemplate(args.templateId);
          if (template.source !== 'video-shotcraft' || typeof template.preview !== 'string') throw new Error('Shotcraft 预览素材不存在');
          const path = resolveShotcraftPath(template.preview.replace(/^\//, ''));
          if (!path || extname(path).toLowerCase() !== '.mp4') throw new Error('Shotcraft 本地 MP4 预览素材不存在');
          return importAsset(args.projectId, path);
        }        case 'timeline_plan': return plan(args.projectId, args);
        case 'color_workflow': {
          const project = store.project(args.projectId);
          if (args.action === 'match-shots') {
            const preview = project.lastGradePreview;
            if (!preview?.frames?.length || preview.signature !== gradingSignature(project)) throw new Error('调色预览缺失或已过时；请先重新生成 grade-preview');
            const { suggestShotMatch } = await import('./color-workflow.mjs');
            return suggestShotMatch(preview, { referenceClipId: args.referenceClipId });
          }
          if (!['save-version', 'restore-version'].includes(args.action)) throw new Error('未知调色工作流操作');
          if (!Number.isInteger(args.revision)) throw new Error('调色版本写入需要当前项目修订号 revision');
          if (args.revision !== project.revision) throw new Error('项目已被其他操作修改，请刷新后重试');
          const { saveGradeVersion, restoreGradeVersion } = await import('./color-workflow.mjs');
          const next = args.action === 'save-version'
            ? saveGradeVersion(project, { name: args.name })
            : restoreGradeVersion(project, args.versionId);
          return store.updateProject(project.id, (p) => { Object.assign(p, next); }, args.revision);
        }
        case 'stock_search': {
          const kind = args.kind === 'music' ? 'music' : args.kind === 'video' ? 'video' : null;
          if (!kind) throw new Error('kind 必须是 video 或 music');
          const query = String(args.query || '').trim();
          if (!query) throw new Error('请提供搜索关键词');
          const { searchStock } = await import('./providers.mjs');
          return searchStock({ kind, query, provider: args.provider, perPage: args.perPage, settings: store.state.settings });
        }
        case 'timeline_update': {
          if (!Array.isArray(args.clips) || args.clips.length > 128 || !Number.isInteger(args.revision)) throw new Error('请提供最多 128 个 clips 与当前 revision');
          const project = store.project(args.projectId);
          const clipIds = new Set();
          for (const clip of args.clips) {
            if (!clip || typeof clip !== 'object' || Array.isArray(clip)) throw new Error('片段必须是对象');
            if (clip.id !== undefined) {
              if (typeof clip.id !== 'string' || !clip.id.trim() || clipIds.has(clip.id)) throw new Error('片段 ID 必须是非空且唯一的字符串');
              clipIds.add(clip.id);
            }
            if (clip.track !== undefined && !Number.isInteger(clip.track)) throw new Error('轨道 track 必须是整数');
            if (clip.motion !== undefined && clip.motion !== null) validateMotion(clip.motion);
            if (clip.windows !== undefined && clip.windows !== null) validateWindows(clip.windows);
          }
          if (args.clips.some((clip) => clip.grading !== undefined || clip.windows !== undefined) || args.look !== undefined) {
            const { normalizeGrading } = await import('./media/grading.mjs');
            const checkGrading = (value, label) => {
              try { normalizeGrading(value ?? null); } catch (error) { throw new Error(`${label}无效：${error.message}`); }
            };
            for (const [index, clip] of args.clips.entries()) {
              if (clip.grading !== undefined) checkGrading(clip.grading, `片段 ${index} 调色参数`);
              (clip.windows ?? []).forEach((win, windowIndex) => checkGrading(win.grading, `片段 ${index} 蒙版 ${windowIndex} `));
            }
            if (args.look !== undefined) checkGrading(args.look, '项目 look ');
          }
          const validatedLuts = new Map();
          for (const clip of args.clips) {
            for (const key of ['inputLut', 'lut']) {
              if (clip[key] === undefined || clip[key] === null || clip[key] === '') continue;
              if (typeof clip[key] !== 'string') throw new Error(`${key} LUT 必须是本地 .cube 文件路径`);
              if (!validatedLuts.has(clip[key])) {
                const { validateCubeFile } = await import('./color-workflow.mjs');
                validatedLuts.set(clip[key], await validateCubeFile(clip[key]));
              }
            }
          }
          const clips = args.clips.map((clip) => {
          const asset = project.assets.find((a) => a.path === clip.path || a.id === clip.assetId);
          if (!asset) throw new Error('时间线只能引用项目内素材');
          const duration = finite(clip.duration, undefined, 0.01, 3600);
          const sourceIn = finite(clip.sourceIn, 0, 0, 3600);
          const speed = clip.speed === undefined || clip.speed === null ? 1 : finite(clip.speed, 1, 0.25, 4);
          if (asset.kind !== 'image' && duration * speed + sourceIn > asset.duration + 0.1) throw new Error('片段超出源素材时长（按变速后的源消耗计算）');
          return { ...clip, id: clip.id || randomUUID(), assetId: asset.id, path: asset.path, kind: asset.kind,
            duration, sourceIn, speed,
            ...(validatedLuts.has(clip.inputLut) ? { inputLut: validatedLuts.get(clip.inputLut).path } : {}),
            ...(validatedLuts.has(clip.lut) ? { lut: validatedLuts.get(clip.lut).path } : {}),
            start: finite(clip.start, 0, 0, 3600), volume: finite(clip.volume, 1, 0, 4), track: finite(clip.track, 0, 0, 100) };
        });
          if (args.captions !== undefined || args.subtitleStyle !== undefined) {
            const { createCaptionScript } = await import('./media/captions.mjs');
            createCaptionScript({ captions: args.captions ?? project.captions ?? [], subtitleStyle: args.subtitleStyle ?? project.subtitleStyle,
              width: project.width, height: project.height, duration: Math.max(0, ...clips.map((c) => c.start + c.duration)) });
          }
          let musicPath;
          let musicAsset;
          if (args.musicPath !== undefined && args.musicPath !== null && args.musicPath !== '') {
            if (typeof args.musicPath !== 'string') throw new Error('musicPath 必须是本地音频文件路径');
            musicPath = await realpath(resolve(args.musicPath));
            const probe = await (await getMedia()).probeMedia(musicPath);
            if (!(probe.streams || []).some((stream) => stream.codec_type === 'audio')) throw new Error('配乐文件没有音频流');
            musicAsset = { id: randomUUID(), path: musicPath, name: basename(musicPath), kind: 'audio',
              duration: Number(probe.format?.duration || 0), probe, importedAt: new Date().toISOString() };
          }
          return store.updateProject(args.projectId, (p) => {
            p.history.push({ revision: p.revision, clips: p.clips, beatSheet: p.beatSheet, at: new Date().toISOString() });
            p.clips = clips;
            if (args.captions !== undefined) {
              p.captions = structuredClone(args.captions);
              delete p.captionSource;
            }
            if (args.subtitleStyle) p.subtitleStyle = structuredClone(args.subtitleStyle);
            if (args.look !== undefined) p.look = structuredClone(args.look ?? null);
            if (args.musicStart !== undefined) p.musicStart = finite(args.musicStart, 0, 0, 3600);
            if (args.fadeIn !== undefined) p.fadeIn = finite(args.fadeIn, 0, 0, 5);
            if (args.fadeOut !== undefined) p.fadeOut = finite(args.fadeOut, 0, 0, 5);
            if (args.sharpen !== undefined) p.sharpen = finite(args.sharpen, 0, 0, 2);
            if (args.vignette !== undefined) p.vignette = finite(args.vignette, 0, 0, 1);
            if (args.glow !== undefined) p.glow = finite(args.glow, 0, 0, 1);
            if (args.beatSheet) p.beatSheet = args.beatSheet;
            if (args.musicPath === null || args.musicPath === '') {
              clearMusic(p);
            } else if (musicPath) {
              // Replacing the bed resets its offset unless this same call sets one explicitly;
              // only the previous track's auto music credits are dropped.
              setMusic(p, musicPath, { musicStart: args.musicStart !== undefined ? p.musicStart : 0 });
              if (!p.assets.some((asset) => asset.path === musicPath)) p.assets.push(musicAsset);
            }
          }, args.revision);
        }
        case 'job_submit': {
          if (typeof maintenanceMode === 'function' ? maintenanceMode() : maintenanceMode) throw new Error('插件正在更新或重载，完成维护后才能提交制作任务');
          store.project(args.projectId);
          if (!jobTypes.has(args.type)) throw new Error('未知任务类型');
          if (store.state.jobs.filter((j) => ['queued', 'running'].includes(j.status)).length >= 30) throw new Error('任务队列已满');
          const job = { id: randomUUID(), projectId: args.projectId, type: args.type, params: structuredClone(args.params || {}), status: 'queued', progress: 0, createdAt: new Date().toISOString() };
          store.state.jobs.unshift(job);
          await store.save();
          schedule();
          return structuredClone(job);
        }
        case 'job_status': {
          const job = store.state.jobs.find((j) => j.id === args.jobId);
          if (!job) throw new Error('任务不存在');
          return structuredClone(job);
        }
        case 'job_cancel': {
          const job = store.state.jobs.find((j) => j.id === args.jobId);
          if (!job) throw new Error('任务不存在');
          const controller = controllers.get(job.id);
          if (controller) controller.abort(new Error('用户取消了任务'));
          else if (job.status === 'queued') { job.status = 'cancelled'; job.finishedAt = new Date().toISOString(); await store.save(); }
          return structuredClone(job);
        }
        case 'template_read': {
          const template = await resolveTemplate(args.templateId);
          if (template.source === 'video-shotcraft') {
            const item = await readShotcraftLibraryItem({ kind: 'motion', id: template.id, includeEntry: args.source === true });
            const source = args.source ? item.sources?.[0] : { path: item.prompt, text: item.content };
            if (!source) throw new Error(`模板 ${template.id} 没有可读取的源文件`);
            return { template, path: join(ROOT, source.path), content: source.text,
              ...(args.source ? { sources: item.sources } : {}), resources: item.resources, instructions: productionInstructions };
          }
          const target = args.source ? template.entry : template.prompt;
          if (!target) throw new Error(`模板 ${template.id} 没有可读取的${args.source ? '源文件' : '说明'}，请改用 library_read`);
          const path = join(ROOT, target);
          if (!existsSync(path)) throw new Error(`模板文件不存在：${target}`);
          return { template, path, content: await readFile(path, 'utf8'), instructions: productionInstructions };
        }
        case 'library': return library();
        case 'library_list': {
          const data = await library();
          const collections = { template: data.templates, 'design-system': data.designSystems, skill: data.skills, atom: data.atoms, scenario: data.scenarios };
          const all = Object.values(collections).flat();
          const pool = args.kind && collections[args.kind] ? collections[args.kind] : args.kind ? all.filter(item => item.kind === args.kind) : all;
          const query = String(args.query || '').toLowerCase();
          const filtered = pool.filter(item => `${item.id} ${item.name || item.title} ${item.source || ''} ${item.description} ${item.category || ''} ${item.recipe || ''} ${item.use || ''} ${item.energy || ''} ${item.recommendedUse || ''} ${(item.tags || []).join(' ')}`.toLowerCase().includes(query));
          const limit = Number.isInteger(args.limit) ? Math.max(1, Math.min(200, args.limit)) : 50;
          return { total: filtered.length, items: filtered.slice(0, limit).map(item => ({ id: item.id, name: item.name || item.title, kind: item.kind || 'motion', description: item.description, runtime: item.status || item.runtime, license: item.license, source: item.source, renderable: item.renderable ?? null, requirements: item.requirements ?? [],
            category: item.category, recipe: item.recipe, recommended: item.recommended, recommendedUse: item.recommendedUse,
            energy: item.energy, use: item.use, duration: item.duration, preview: item.preview, thumbnail: item.thumbnail })) };
        }
        case 'library_read': {
          const shotcraftItem = await readShotcraftLibraryItem({ kind: args.kind, id: args.id, includeEntry: args.source === true, resource: args.resource });
          if (shotcraftItem) return shotcraftItem;
          const motionItem = await readMotionLibraryItem({ kind: args.kind, id: args.id, includeEntry: args.source === true, resource: args.resource });
          if (motionItem) return motionItem;
          if (args.resource !== undefined) throw new Error('resource 参数仅适用于可选 Motion Web / Onetake 条目');
          const local = getTemplates().find(item => item.id === args.id);
          if (local && ['template', 'motion'].includes(args.kind)) {
            return {
              ...local,
              content: local.prompt ? await readFile(join(ROOT, local.prompt), 'utf8') : '',
              entry: args.source ? { path: local.entry, text: await readFile(join(ROOT, local.entry), 'utf8') } : { path: local.entry },
            };
          }
          const { readLibraryItem } = await loadLibrary();
          if (typeof args.kind !== 'string' || !args.kind) throw new Error('kind 必须是 template、design-system 或 skill');
          if (typeof args.id !== 'string' || !args.id) throw new Error('请提供库条目 ID');
          const item = await readLibraryItem({ kind: args.kind, id: args.id, includeEntry: args.source === true });
          if (!item) {
            const error = new Error(`库条目不存在：${args.kind}/${args.id}`);
            error.code = 'ENOENT';
            throw error;
          }
          return item;
        }
        case 'design_project_create': return designStore.createProject(args);
        case 'design_artifact_save': return designStore.saveArtifact(args);
        case 'design_state': return designStore.state(args.sessionId);
        case 'composer_update': return composerUpdate(args);
        case 'composer_get': return composerGet(args.sessionId);
        default: throw new Error(`未知 EAC 工具：${name}`);
      }
    },
    close() {
      if (closing) return closing;
      closing = (async () => {
        closed = true;
        for (const job of store.state.jobs) {
          if (job.status === 'queued') {
            job.status = 'cancelled';
            job.finishedAt = new Date().toISOString();
          }
        }
        for (const controller of controllers.values()) controller.abort(new Error('服务关闭'));
        try {
          await pumpTask;
          await designStore.flush();
          await store.save();
        } finally { await release(); }
      })();
      return closing;
    }
  };
  return engine;
}
