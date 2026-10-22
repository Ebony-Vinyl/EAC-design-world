// OpenDesign content library index.
//
// This module is the single read surface for content vendored from the
// OpenDesign upstream snapshot under `vendor/open-design/`. The importer
// (`scripts/import-open-design.mjs`) writes `vendor/open-design/catalog.json`;
// this module loads that JSON index and exposes it as typed collections plus an
// async per-item reader. Nothing here reaches the network or the upstream app
// tree: every path it returns resolves inside `vendor/open-design/`.
//
// Stable exports (contract for HTTP + shared AI tools + UI):
//   openDesignTemplates  - creation template entries (website/deck/document/image/motion/example)
//   designSystems        - design-system metadata (name/category/colors/fonts/tokens/...)
//   creationModes        - creation mode descriptors used by the composer picker
//   readLibraryItem()    - async reader for a design-system/template/skill/prompt/atom/scenario
//   libraryStats         - real per-collection import counts
//   libraryProvenance    - pinned upstream revision + digest + license summary
//
// Every catalog entry is a plain object. IDs are `od-` prefixed and match the
// host safe-ID pattern /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/. `entry`/`prompt`
// paths are relative to the repository ROOT; `thumbnail` is a `/vendor/...`
// URL or null (never a fabricated image).

import { existsSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { resolve, join, relative, isAbsolute, extname } from 'node:path';
import { ROOT } from './catalog.mjs';

export const OPEN_DESIGN_ROOT = 'vendor/open-design';
export const OPEN_DESIGN_SOURCE = 'open-design';
export const LIBRARY_SOURCE = 'open-design';
export const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
export const CATALOG_PATH = join(ROOT, OPEN_DESIGN_ROOT, 'catalog.json');

const CONTENT_KINDS = new Set(['website', 'deck', 'document', 'image', 'motion', 'prompt', 'example']);
const LIBRARY_KINDS = new Set(['design-system', 'template', 'skill', 'atom', 'scenario', 'prompt', ...CONTENT_KINDS]);

// Runtime status vocabulary. `source-ready` means a real local HTML/entry exists
// and can be rendered or edited. `external-generation-required` means the item is
// a prompt for a generator (seedance/gpt-image/etc.) that EAC does not bundle.
// `reference-only` means there is readable material but no runnable entry.
export const RUNTIME = Object.freeze({
  SOURCE_READY: 'source-ready',
  EXTERNAL_GENERATION: 'external-generation-required',
  REFERENCE_ONLY: 'reference-only',
});

const DEFAULT_CREATION_MODES = [
  { id: 'website', name: '网站 / 原型', en: 'Website', kinds: ['website'], surfaces: ['web'], description: '可运行的单页网站、落地页与原型。' },
  { id: 'deck', name: '幻灯片', en: 'Slides', kinds: ['deck'], surfaces: ['web'], description: '演示稿、幻灯片与报告版面。' },
  { id: 'document', name: '文档', en: 'Document', kinds: ['document'], surfaces: ['web', 'markdown'], description: '长文、报告、说明书与文档页面。' },
  { id: 'image', name: '图片', en: 'Image', kinds: ['image'], surfaces: ['image'], description: '图片与海报提示词模板（需要外部图像生成）。' },
  { id: 'motion', name: '动效', en: 'Motion', kinds: ['motion'], surfaces: ['video', 'hyperframes'], description: '动效视频模板与视频提示词模板。' },
];

function emptyCatalog() {
  return {
    schemaVersion: 'eac-open-design-library/v1',
    source: null,
    stats: { designSystems: 0, templates: 0, skills: 0, prompts: 0, atoms: 0, scenarios: 0, total: 0 },
    creationModes: DEFAULT_CREATION_MODES,
    designSystems: [],
    templates: [],
    skills: [],
    prompts: [],
    atoms: [],
    scenarios: [],
  };
}

function loadCatalog() {
  try {
    const parsed = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return emptyCatalog();
    const base = emptyCatalog();
    return {
      ...base,
      ...parsed,
      stats: { ...base.stats, ...(parsed.stats || {}) },
      creationModes: Array.isArray(parsed.creationModes) && parsed.creationModes.length ? parsed.creationModes : base.creationModes,
      designSystems: Array.isArray(parsed.designSystems) ? parsed.designSystems : [],
      templates: Array.isArray(parsed.templates) ? parsed.templates : [],
      skills: Array.isArray(parsed.skills) ? parsed.skills : [],
      prompts: Array.isArray(parsed.prompts) ? parsed.prompts : [],
      atoms: Array.isArray(parsed.atoms) ? parsed.atoms : [],
      scenarios: Array.isArray(parsed.scenarios) ? parsed.scenarios : [],
    };
  } catch (error) {
    throw new Error(`OpenDesign 内容目录读取失败：${error.message}`);
  }
}

const catalog = loadCatalog();

export const openDesignTemplates = Object.freeze(catalog.templates);
export const designSystems = Object.freeze(catalog.designSystems);
export const creationModes = Object.freeze(catalog.creationModes);
export const librarySkills = Object.freeze(catalog.skills);
export const libraryPrompts = Object.freeze(catalog.prompts);
export const libraryAtoms = Object.freeze(catalog.atoms);
export const libraryScenarios = Object.freeze(catalog.scenarios);
export const libraryStats = Object.freeze({ ...catalog.stats });
export const libraryProvenance = Object.freeze(catalog.source || null);
export const librarySchemaVersion = catalog.schemaVersion;

export function isOpenDesignLibraryAvailable() {
  return catalog.designSystems.length > 0 || catalog.templates.length > 0 || catalog.skills.length > 0;
}

// Resolve a catalog-relative path to an absolute path, refusing anything that
// escapes `vendor/open-design`. Returns null when unsafe or non-existent.
//
// Containment is decided on the REAL path, not on the string that names it. `resolve()` only
// normalises `..` textually and never follows links, while every consumer here goes on to read the
// file with something that does follow them (`readTextFile`, `engine.template_read`, and
// render-template's entry containment). Since catalog.json and the vendor tree are third-party
// contribution, a single contributed symlink pointing outside was enough to turn this gate into an
// arbitrary file read. Symlinks that stay inside the tree are still accepted, which is what the
// vendor tree legitimately uses.
export function resolveLibraryPath(relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) return null;
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const candidate = resolve(ROOT, normalized.startsWith('/vendor/') ? `.${normalized}` : normalized);
  const libraryRoot = join(ROOT, OPEN_DESIGN_ROOT);
  const contained = (path) => {
    const rel = relative(libraryRoot, path);
    return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
  };
  if (!contained(candidate)) return null;
  // `fs.realpathSync` has no `throwIfNoEntry` option (that one belongs to statSync/lstatSync), so a
  // missing path throws instead of returning undefined. A file that is simply ABSENT must read as
  // "not there" (callers report exists:false and degrade) rather than crashing the whole
  // library_read. Any other resolution failure means containment cannot be proven — a link loop, an
  // unreadable directory — and that must be a refusal, not a silent pass.
  let real;
  try {
    real = realpathSync(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return candidate;
    return null;
  }
  // The root is resolved too, so a checkout reached through a symlinked directory is compared
  // against the real tree rather than against the symlinked spelling.
  const realRoot = (() => { try { return realpathSync(libraryRoot); } catch { return libraryRoot; } })();
  const rel = relative(realRoot, real);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? candidate : null;
}

export function libraryFileUrl(relPath) {
  if (typeof relPath !== 'string' || !relPath) return '';
  if (relPath.startsWith('/vendor/')) return relPath;
  return `/${relPath.replace(/\\/g, '/').replace(/^\.\//, '')}`;
}

function readTextFile(relPath) {
  const abs = resolveLibraryPath(relPath);
  if (!abs || !existsSync(abs)) return null;
  try {
    if (!statSync(abs).isFile()) return null;
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

const TEXT_EXT = new Set(['.md', '.markdown', '.json', '.txt', '.html', '.htm', '.css', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.svg', '.yml', '.yaml', '.csv', '.source']);

function isReadableText(relPath) {
  const abs = resolveLibraryPath(relPath);
  if (!abs || !existsSync(abs)) return false;
  const ext = extname(abs).toLowerCase();
  if (!TEXT_EXT.has(ext) && ext !== '') return false;
  const text = readTextFile(relPath);
  return typeof text === 'string';
}

// The catalog is small enough to index in memory. Build id/slug lookups once.
const index = new Map();
function addToIndex(collection, item) {
  if (!item || typeof item !== 'object' || !item.id) return;
  if (!index.has(item.id)) index.set(item.id, { collection, item });
}
for (const item of catalog.designSystems) addToIndex('designSystems', item);
for (const item of catalog.templates) addToIndex('templates', item);
for (const item of catalog.skills) addToIndex('skills', item);
for (const item of catalog.prompts) addToIndex('prompts', item);
for (const item of catalog.atoms) addToIndex('atoms', item);
for (const item of catalog.scenarios) addToIndex('scenarios', item);

function collectionForKind(kind) {
  if (!kind) return null;
  if (kind === 'design-system') return 'designSystems';
  if (kind === 'skill') return 'skills';
  if (kind === 'atom') return 'atoms';
  if (kind === 'scenario') return 'scenarios';
  if (kind === 'prompt') return 'prompts';
  if (kind === 'template') return 'templates';
  if (CONTENT_KINDS.has(kind)) return 'templates';
  return null;
}

function matchItem(collection, wanted) {
  const pool = catalog[collection] || [];
  for (const item of pool) {
    if (item.id === wanted) return item;
    if (item.slug === wanted) return item;
    if (item.id === `od-${wanted}`) return item;
    if (item.sourceSlug === wanted) return item;
    if (Array.isArray(item.aliases) && item.aliases.includes(wanted)) return item;
  }
  return null;
}

function findEntry({ kind, id, source }) {
  if (source && source !== LIBRARY_SOURCE) {
    throw new Error(`Unknown library source: ${source}. Only "${LIBRARY_SOURCE}" is available.`);
  }
  if (typeof id !== 'string' || !id.trim()) throw new TypeError('readLibraryItem requires a non-empty id');
  const wanted = id.trim();
  const collection = collectionForKind(kind);

  if (collection) {
    const item = matchItem(collection, wanted);
    if (item) return { collection, item };
    // content-kind requested but the id lives in another collection
    if (CONTENT_KINDS.has(kind) && wanted.startsWith('od-')) {
      const direct = index.get(wanted);
      if (direct && direct.collection === 'templates') return direct;
    }
    return null;
  }

  const direct = index.get(wanted);
  if (direct) return direct;
  // try the id with the od- prefix
  if (!wanted.startsWith('od-')) {
    const prefixed = index.get(`od-${wanted}`);
    if (prefixed) return prefixed;
  }
  // fall back to slug scan across every collection
  for (const name of ['designSystems', 'templates', 'skills', 'prompts', 'atoms', 'scenarios']) {
    const item = matchItem(name, wanted);
    if (item) return { collection: name, item };
  }
  return null;
}

function normalizeRel(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.path === 'string') return value.path;
  return null;
}

function resolvePrompt(item) {
  const candidates = [item.prompt, item.promptPath, item.skill, item.design, item.entry]
    .map(normalizeRel).filter(Boolean);
  for (const candidate of candidates) {
    if (isReadableText(candidate)) {
      return { path: candidate.replace(/\\/g, '/'), url: libraryFileUrl(candidate), text: readTextFile(candidate) };
    }
  }
  return null;
}

function resolveEntry(item, { includeEntry }) {
  const rel = normalizeRel(item.entry);
  if (!rel) return null;
  const abs = resolveLibraryPath(rel);
  const exists = Boolean(abs && existsSync(abs) && statSync(abs).isFile());
  const value = { path: rel.replace(/\\/g, '/'), url: libraryFileUrl(rel), exists };
  if (includeEntry && exists && isReadableText(rel)) value.text = readTextFile(rel);
  return value;
}

function resolveThumbnail(item) {
  if (!item.thumbnail) return null;
  if (item.thumbnail.startsWith('/vendor/')) return item.thumbnail;
  const abs = resolveLibraryPath(item.thumbnail);
  return abs && existsSync(abs) ? libraryFileUrl(item.thumbnail) : null;
}

/**
 * Read one library item by id (optionally filtered by kind/source).
 * @param {{kind?: string, id: string, source?: string, includeEntry?: boolean}} query
 * @returns {Promise<object|null>}
 */
export async function readLibraryItem({ kind, id, source, includeEntry = false } = {}) {
  if (kind !== undefined && kind !== null && typeof kind !== 'string') throw new TypeError('kind must be a string');
  if (kind && !LIBRARY_KINDS.has(kind)) throw new Error(`Unknown library kind: ${kind}`);
  const found = findEntry({ kind, id, source });
  if (!found) return null;
  const { collection, item } = found;

  const prompt = resolvePrompt(item);
  const entry = resolveEntry(item, { includeEntry });
  const thumbnail = resolveThumbnail(item);

  const result = {
    id: item.id,
    kind: item.kind,
    slug: item.slug ?? null,
    sourceSlug: item.sourceSlug ?? item.slug ?? null,
    collection,
    source: LIBRARY_SOURCE,
    title: item.title ?? null,
    titleI18n: item.titleI18n ?? null,
    description: item.description ?? null,
    category: item.category ?? null,
    tags: Array.isArray(item.tags) ? item.tags : [],
    license: item.license ?? null,
    licenseNote: item.licenseNote ?? null,
    redistributable: item.redistributable ?? null,
    author: item.author ?? null,
    sourceUrl: item.sourceUrl ?? item.homepage ?? null,
    homepage: item.homepage ?? null,
    provenance: item.provenance ?? null,
    runtime: item.runtime ?? null,
    sourceReady: item.sourceReady === true,
    requiresExternalGeneration: item.requiresExternalGeneration === true,
    surface: item.surface ?? null,
    mode: item.mode ?? null,
    width: item.width ?? null,
    height: item.height ?? null,
    aspect: item.aspect ?? null,
    fps: item.fps ?? null,
    duration: item.duration ?? null,
    entry,
    prompt,
    promptPath: item.prompt ?? null,
    thumbnail,
    preview: item.preview ?? null,
    path: item.path ?? null,
    files: Array.isArray(item.files) ? item.files : [],
  };

  if (collection === 'designSystems') {
    result.colors = Array.isArray(item.colors) ? item.colors : [];
    result.fonts = item.fonts ?? null;
    result.tokens = item.tokens ?? null;
    result.designPath = item.design ?? null;
    result.designText = item.design && isReadableText(item.design) ? readTextFile(item.design) : null;
  }
  if (collection === 'prompts') {
    result.promptText = prompt ? prompt.text : (typeof item.promptText === 'string' ? item.promptText : null);
    result.model = item.model ?? null;
  }
  return result;
}

export function listLibraryIds({ kind } = {}) {
  const collection = collectionForKind(kind);
  const collections = collection ? [collection] : ['designSystems', 'templates', 'skills', 'prompts', 'atoms', 'scenarios'];
  return collections.flatMap((name) => (catalog[name] || []).map((item) => item.id));
}

export function searchLibrary(query, { kind, limit = 50 } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return [];
  const collection = collectionForKind(kind);
  const collections = collection ? [collection] : ['designSystems', 'templates', 'skills', 'prompts', 'atoms', 'scenarios'];
  const scored = [];
  for (const name of collections) {
    for (const item of catalog[name] || []) {
      const haystack = [item.id, item.slug, item.title, item.description, item.category, ...(item.tags || [])]
        .filter(Boolean).join(' ').toLowerCase();
      if (haystack.includes(needle)) scored.push(item);
      if (scored.length >= limit) break;
    }
    if (scored.length >= limit) break;
  }
  return scored;
}

export const openDesignLibrary = Object.freeze({
  source: LIBRARY_SOURCE,
  root: OPEN_DESIGN_ROOT,
  schemaVersion: librarySchemaVersion,
  stats: libraryStats,
  provenance: libraryProvenance,
  creationModes,
  designSystems,
  templates: openDesignTemplates,
  skills: librarySkills,
  prompts: libraryPrompts,
  atoms: libraryAtoms,
  scenarios: libraryScenarios,
});

export default openDesignLibrary;
