import './npm-assets-restore.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { motionTemplates } from './motion-libraries.mjs';
import { getShotcraftTemplate, shotcraftTemplates } from './shotcraft-library.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const styles = [
  ['05-cel-boil', '逐帧手绘', '手绘', '线条沸腾、逐帧形变与手绘节奏'],
  ['03-isometric', '等距城市', '空间', '等距 2.5D 城市生长与空间叙事'],
  ['01-flat-vector', '扁平矢量', '图形', '弹性图形、鲜明色块与品牌叙事'],
  ['02-line-art', '线条艺术', '手绘', '连续线条、留白与精细轮廓'],
  ['04-3d-render', '柔感三维', '空间', 'Blender 实物渲染与柔软材质'],
  ['08-morph', '形态变换', '图形', '连续形态变换与图形转场'],
  ['19-paperclip', '贴纸解说', '叙事', '拼贴贴纸与信息解说'],
  ['22-hud', '未来仪表', '科技', 'HUD 信息层与精密扫描动效'],
  ['06-collage', '杂志拼贴', '叙事', '剪纸纹理与杂志编排'],
  ['12-aurora-glass', '极光玻璃', '科技', '玻璃材质、折射与光影'],
  ['09-bauhaus', '几何包豪斯', '图形', '几何构成与强节拍排版'],
  ['10-synthwave', '复古合成波', '复古', 'VHS 质感与合成波空间'],
  ['20-pixel', '像素世界', '复古', '像素角色、关卡与游戏节奏'],
  ['07-liquid', '流体运动', '图形', '流体变化与连续曲线运动'],
  ['18-hanazi', '综艺花字', '叙事', '竖屏综艺字幕与情绪节奏']
];

export const templates = [
  ...styles.map(([id, name, category, description]) => ({
    id, name, category, description, source: 'mg-styles-15', license: 'MIT',
    thumbnail: `/vendor/mg-styles-15/docs/readme/films/${id}.webp`,
    entry: `vendor/mg-styles-15/demos/${id}/index.html`,
    prompt: `vendor/mg-styles-15/prompts/${id}.md`,
    width: id === '18-hanazi' ? 1080 : 1920,
    height: id === '18-hanazi' ? 1920 : 1080,
    duration: 10,
    status: id === '04-3d-render' ? 'requires-blender-assets' : id === '18-hanazi' ? 'requires-douyin-font' : 'source-ready'
  })),
  {
    id: 'motion-promo-film', name: '产品宣传片 · 经典', category: '产品',
    description: '确定性时间线、真实产品录制、字幕与配乐工作流',
    source: 'local-skill', entry: 'vendor/motion-promo-film/templates/film-template.html',
    prompt: 'vendor/motion-promo-film/SKILL.md', width: 1920, height: 1080, duration: 12,
    status: 'source-ready', license: 'local-skill-see-notices'
  },
  {
    id: 'motion-promo-film-v2', name: '产品宣传片 · 电影舞台', category: '产品',
    description: '悬浮窗口、锚点光标、左右交替字幕与原创音乐',
    source: 'local-skill', entry: 'vendor/motion-promo-film-v2/references/example-film.html',
    prompt: 'vendor/motion-promo-film-v2/SKILL.md', width: 1920, height: 1080, duration: 65,
    status: 'source-ready', license: 'local-skill-see-notices'
  }
];

export function getTemplates() {
  return [...templates, ...motionTemplates(), ...shotcraftTemplates()];
}

export function getTemplate(id) {
  const template = typeof id === 'string' && id.startsWith('sc-') ? getShotcraftTemplate(id)
    : [...templates, ...motionTemplates()].find((item) => item.id === id);
  if (!template) throw new Error(`Unknown template: ${id}`);
  return { ...template, available: Boolean(template.entry) && existsSync(resolve(ROOT, template.entry)) };
}

// OpenDesign library is owned by src/open-design-library.mjs (content agent). It is loaded
// lazily so transient edits to the module do not require a restart, but import failures are
// surfaced instead of silently degrading to an empty library.
const libraryExports = ['openDesignTemplates', 'designSystems', 'creationModes', 'readLibraryItem'];
let libraryPromise;
export function loadLibrary() {
  return libraryPromise ??= import('./open-design-library.mjs').then((module) => {
    const missing = libraryExports.filter((key) => !(key in module));
    if (missing.length) throw new Error(`src/open-design-library.mjs 缺少导出：${missing.join('、')}`);
    return {
      openDesignTemplates: module.openDesignTemplates || [],
      designSystems: module.designSystems || [],
      creationModes: module.creationModes || [],
      libraryStats: module.libraryStats,
      libraryProvenance: module.libraryProvenance,
      librarySkills: module.librarySkills || [], libraryPrompts: module.libraryPrompts || [],
      libraryAtoms: module.libraryAtoms || [], libraryScenarios: module.libraryScenarios || [],
      readLibraryItem: module.readLibraryItem,
    };
  });
}

// Only source entries with a real HTML/SVG file can be rendered. Prompt-only, example-only and
// external-generation/reference items are indexed for search but must never masquerade as
// renderable. The content module may expose `sourceReady`/`requiresExternalGeneration` booleans
// (preferred) or a `status`/`runtime` string; both vocabularies are honored.
const renderableStatuses = new Set(['source-ready', 'requires-blender-assets', 'requires-douyin-font', 'requires-dependencies']);
const nonRenderableStatuses = new Set(['external-generation-required', 'reference-only', 'prompt-only', 'example-only']);
const motionReadiness = new Map();
function motionSourceRequirements(entry) {
  if (!entry) return [];
  if (motionReadiness.has(entry)) return motionReadiness.get(entry);
  const requirements = [];
  try {
    const html = readFileSync(resolve(ROOT, entry), 'utf8');
    if (/__[A-Z][A-Z0-9_]+__/.test(html)) requirements.push('需要填写素材与时长占位符');
    if (/data-composition-src\s*=/.test(html)) requirements.push('需要 HyperFrames 子合成运行时');
  } catch { requirements.push('源文件不可用'); }
  motionReadiness.set(entry, requirements);
  return requirements;
}
export function libraryCatalogEntry(item) {
  const entry = typeof item.entry === 'string' ? item.entry : item.entry?.path || null;
  const prompt = typeof item.prompt === 'string' ? item.prompt : item.prompt?.path || item.promptPath || null;
  const preview = typeof item.preview === 'string' ? item.preview : item.preview?.video || null;
  const requirements = item.kind === 'motion' ? motionSourceRequirements(entry) : [];
  const status = requirements.length ? 'requires-dependencies' : item.status || item.runtime || null;
  const renderable = requirements.length === 0 && Boolean(entry) && !['prompt', 'example'].includes(item.kind)
    && item.sourceReady !== false
    && item.requiresExternalGeneration !== true
    && !nonRenderableStatuses.has(status)
    && (!status || renderableStatuses.has(status));
  return {
    ...item,
    source: item.source || 'open-design',
    name: item.titleI18n?.['zh-CN'] || item.name || item.title || item.id,
    status, requirements, entry, prompt, preview,
    previewSource: typeof item.preview === 'object' ? item.preview : null,
    width: item.width || 1920, height: item.height || 1080,
    duration: item.duration || 10,
    renderable,
  };
}

// Resolve a template ID across the built-in catalog and the OpenDesign library.
export async function resolveTemplate(id) {
  if (!id) throw new Error('请提供模板 ID');
  const local = typeof id === 'string' && id.startsWith('sc-') ? getShotcraftTemplate(id)
    : [...templates, ...motionTemplates()].find((item) => item.id === id);
  if (local) return { ...local, available: Boolean(local.entry) && existsSync(resolve(ROOT, local.entry)), renderable: local.renderable !== false };
  // Only OpenDesign IDs (od- prefix) consult the library; unknown local IDs fail fast without
  // importing the content module, so a missing module never masks an unknown-template error.
  if (!id.startsWith('od-')) throw new Error(`Unknown template: ${id}`);
  const { openDesignTemplates } = await loadLibrary();
  const item = openDesignTemplates.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`Unknown template: ${id}`);
  const resolved = libraryCatalogEntry(item);
  resolved.available = Boolean(resolved.entry) && existsSync(resolve(ROOT, resolved.entry));
  return resolved;
}

export const workflowRecipes = [
  { id: 'product', name: '产品宣传片', stages: ['brief', 'shot-plan', 'capture', 'script', 'voice', 'music', 'edit', 'review', 'deliver'] },
  { id: 'talking-head', name: '口播精剪', stages: ['ingest', 'transcribe', 'remove-retakes', 'captions', 'mix', 'review', 'deliver'] },
  { id: 'landscape', name: '风景叙事', stages: ['ingest', 'scene-analysis', 'music', 'beat-edit', 'grade', 'review', 'deliver'] },
  { id: 'anime', name: '动漫 / 混剪', stages: ['ingest', 'scene-analysis', 'beat-edit', 'captions', 'mix', 'review', 'deliver'] },
  { id: 'batch', name: '批量版本', stages: ['data', 'template', 'variants', 'render', 'review', 'deliver'] },
  { id: 'explainer', name: '知识动画', stages: ['script', 'storyboard', 'animation', 'voice', 'mix', 'review', 'deliver'] }
];
