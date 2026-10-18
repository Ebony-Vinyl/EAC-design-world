import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SHOTCRAFT_ROOT = 'vendor/video-shotcraft';
export const SHOTCRAFT_SOURCE = 'video-shotcraft';
const SAFE_ID = /^sc-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const within = (root, file) => {
  const rel = relative(root, file);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
const cache = new Map();

function pathResolver(root) {
  let directory;
  try {
    directory = realpathSync(resolve(root, SHOTCRAFT_ROOT));
    if (!within(realpathSync(root), directory)) return () => null;
  } catch { return () => null; }
  const paths = new Map();
  return path => {
    if (typeof path !== 'string' || !path.startsWith(`${SHOTCRAFT_ROOT}/`) || path.includes('\\')) return null;
    if (paths.has(path)) return paths.get(path);
    let file = null;
    try {
      const candidate = realpathSync(resolve(root, path));
      if (within(directory, candidate) && statSync(candidate).isFile()) file = candidate;
    } catch { /* A deleted source or preview is unavailable, never a fabricated URL. */ }
    paths.set(path, file);
    return file;
  };
}

export function resolveShotcraftPath(path, { root = ROOT } = {}) {
  return pathResolver(root)(path);
}

function catalog(root) {
  const path = resolve(root, SHOTCRAFT_ROOT, 'catalog.json');
  if (!existsSync(path)) return { templates: [], stats: {} };
  const info = statSync(path);
  const version = `${info.mtimeMs}:${info.size}:${info.ino}`;
  if (cache.get(path)?.version === version) return cache.get(path).value;
  if (!resolveShotcraftPath(`${SHOTCRAFT_ROOT}/catalog.json`, { root })) throw new Error('Shotcraft catalog path is invalid');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (value.schemaVersion !== 'eac-shotcraft-library/v1' || !Array.isArray(value.templates)) throw new Error('Invalid Shotcraft catalog');
  const ids = new Set();
  for (const item of value.templates) {
    if (!SAFE_ID.test(item.id) || ids.has(item.id) || item.source !== SHOTCRAFT_SOURCE || item.entry !== null || item.renderable !== false) {
      throw new Error(`Invalid Shotcraft reference: ${item.id}`);
    }
    ids.add(item.id);
  }
  cache.set(path, { version, value });
  return value;
}

export function shotcraftTemplates({ root = ROOT } = {}) {
  const resolvePath = pathResolver(root);
  return catalog(root).templates.map(item => templateView(item, resolvePath));
}

function templateView(item, resolvePath) {
  return {
    ...structuredClone(item),
    // This import is Remotion source material. A preview MP4 is never a render entry.
    entry: null, renderable: false, available: false,
    sourceAvailable: Boolean(resolvePath(item.prompt))
      && item.sourceFiles.length > 0 && item.sourceFiles.every(path => resolvePath(path)),
    preview: resolvePath(item.preview?.replace(/^\//, '')) ? item.preview : null,
    thumbnail: resolvePath(item.thumbnail?.replace(/^\//, '')) ? item.thumbnail : null,
  };
}

export function getShotcraftTemplate(id, { root = ROOT } = {}) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) return null;
  const item = catalog(root).templates.find(item => item.id === id);
  return item ? templateView(item, pathResolver(root)) : null;
}

export function shotcraftLibraryInfo({ root = ROOT } = {}) {
  const data = catalog(root);
  return {
    source: SHOTCRAFT_SOURCE, revision: data.revision || null, stats: structuredClone(data.stats),
    provenancePath: existsSync(resolve(root, SHOTCRAFT_ROOT, 'EAC-PROVENANCE.json')) ? `${SHOTCRAFT_ROOT}/EAC-PROVENANCE.json` : null,
  };
}

export function searchShotcraftLibrary(query = '', { root = ROOT, limit = 50 } = {}) {
  const needle = String(query).trim().toLowerCase();
  const count = Number.isInteger(limit) ? Math.max(1, Math.min(200, limit)) : 50;
  return shotcraftTemplates({ root }).filter(item =>
    [item.id, item.name, item.description, item.category, item.recipe, item.use, item.energy, item.recommendedUse, ...item.tags]
      .join(' ').toLowerCase().includes(needle)).slice(0, count);
}

export async function readShotcraftLibraryItem({ kind, id, includeEntry = false, resource, root = ROOT }) {
  if (!['template', 'motion'].includes(kind) || typeof id !== 'string' || !SAFE_ID.test(id)) return null;
  const item = getShotcraftTemplate(id, { root });
  if (!item) return null;
  const resolvePath = pathResolver(root);
  const shared = (catalog(root).resources || []).filter(path =>
    /^(?:demos\/_fixtures\/|assets\/lib\/|references\/|assets\/brand\/)/.test(path)).map(path => `${SHOTCRAFT_ROOT}/${path}`);
  const resources = [...new Set([item.prompt, ...item.sourceFiles, ...shared, `${SHOTCRAFT_ROOT}/demos/README.md`,
    `${SHOTCRAFT_ROOT}/LICENSE`, `${SHOTCRAFT_ROOT}/references/shots/ATTRIBUTION.md`]
    .filter(path => resolvePath(path)).map(path => path.slice(SHOTCRAFT_ROOT.length + 1)))];
  function read(path) {
    const file = resolvePath(path);
    if (!file) throw new Error(`Shotcraft source file is unavailable: ${path}`);
    return readFileSync(file, 'utf8');
  }
  let selected;
  if (resource !== undefined) {
    if (typeof resource !== 'string' || !resources.includes(resource)) throw new Error('Invalid Shotcraft resource; choose a path from resources');
    const path = `${SHOTCRAFT_ROOT}/${resource}`;
    selected = { path, text: read(path) };
  }
  return {
    ...item, content: read(item.prompt), resources,
    ...(includeEntry ? { sources: item.sourceFiles.map(path => ({ path, text: read(path) })) } : {}),
    ...(selected ? { resource: selected } : {}),
  };
}
