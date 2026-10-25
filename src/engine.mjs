import lockfile from 'proper-lockfile';
import { browserLaunchOptions } from './browser.mjs';
import { mkdir, readFile, writeFile, realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, extname, basename, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Store } from './store.mjs';
import { DesignStore } from './design-store.mjs';
import { ROOT, getTemplates, resolveTemplate, loadLibrary, libraryCatalogEntry, workflowRecipes } from './catalog.mjs';
import { motionSkills, readMotionLibraryItem } from './motion-libraries.mjs';
import { readShotcraftLibraryItem, resolveShotcraftPath, shotcraftLibraryInfo } from './shotcraft-library.mjs';
import { productionInstructions } from './tools.mjs';

const jobTypes = new Set(['record-browser', 'record-desktop', 'analyze', 'beats', 'transcribe', 'rough-cut', 'captions', 'voice', 'compose', 'render', 'render-template', 'produce']);
const finite = (n, fallback, min, max) => {
  const value = n === undefined ? fallback : Number(n);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`数值必须在 ${min} 与 ${max} 之间`);
  return value;
};
const childOf = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..`) && !isAbsolute(rel));
};
function safeOutputName(value) {
  return String(value || 'film').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 80);
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
      { id: 'semantic-review', name: '视觉与叙事审片', available: false, detail: '由宿主有视觉能力的 AI 检查抽帧；机器检查仅覆盖技术指标' }
    ];
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
        await store.updateProject(project.id, (p) => { p.musicPath = outputPath; });
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
          await store.updateProject(project.id, (p) => { p.musicPath = path; });
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
      return { ...state, templates: includeTemplates ? getTemplates() : [], recipes: workflowRecipes, capabilities: await capabilities() };
    },
    async settingsUpdate(input) {
      if (closed) throw new Error('EAC 服务已关闭');
      const allowed = ['outputRoot', 'ttsVoice', 'quality'];
      for (const key of allowed) {
        if (input[key] === undefined) continue;
        if (typeof input[key] !== 'string') throw new Error(`无效设置：${key}`);
        if (key === 'quality' && !['draft', 'production'].includes(input[key])) throw new Error('无效质量档位');
        store.state.settings[key] = input[key];
      }
      await store.save();
      return (await engine.state()).settings;
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
        }
        case 'timeline_plan': return plan(args.projectId, args);
        case 'timeline_update': {
          if (!Array.isArray(args.clips) || args.clips.length > 128 || !Number.isInteger(args.revision)) throw new Error('请提供最多 128 个 clips 与当前 revision');
          const project = store.project(args.projectId);
          const clips = args.clips.map((clip) => {
            const asset = project.assets.find((a) => a.path === clip.path || a.id === clip.assetId);
            if (!asset) throw new Error('时间线只能引用项目内素材');
            const duration = finite(clip.duration, undefined, 0.01, 3600);
            const sourceIn = finite(clip.sourceIn, 0, 0, 3600);
            if (asset.kind !== 'image' && duration + sourceIn > asset.duration + 0.1) throw new Error('片段超出源素材时长');
            return { ...clip, id: clip.id || randomUUID(), assetId: asset.id, path: asset.path, kind: asset.kind,
              duration, sourceIn, start: finite(clip.start, 0, 0, 3600), volume: finite(clip.volume, 1, 0, 4), track: finite(clip.track, 0, 0, 100) };
          });
          if (args.captions || args.subtitleStyle) {
            const { createCaptionScript } = await import('./media/captions.mjs');
            createCaptionScript({ captions: args.captions || [], subtitleStyle: args.subtitleStyle,
              width: project.width, height: project.height, duration: Math.max(0, ...clips.map((c) => c.start + c.duration)) });
          }
          return store.updateProject(args.projectId, (p) => {
            p.history.push({ revision: p.revision, clips: p.clips, beatSheet: p.beatSheet, at: new Date().toISOString() });
            p.clips = clips;
            p.captions = structuredClone(args.captions || []);
            delete p.captionSource;
            if (args.subtitleStyle) p.subtitleStyle = structuredClone(args.subtitleStyle);
            if (args.beatSheet) p.beatSheet = args.beatSheet;
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
