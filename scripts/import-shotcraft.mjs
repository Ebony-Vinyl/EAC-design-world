import { copyFile, link, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute, extname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { setTimeout } from 'node:timers/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SHOTCRAFT_REVISION = '43bd349a136651865ecfa6ea1cf012f6e957d304';
const REPOSITORY = 'https://github.com/Vincentwei1021/video-shotcraft';
const PREFIX = 'vendor/video-shotcraft';
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const digest = data => createHash('sha256').update(data).digest('hex');
const portable = path => path.replaceAll('\\', '/');
const within = (root, file) => {
  const rel = relative(root, file);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

function sourcePath(root, path) {
  if (typeof path !== 'string' || isAbsolute(path) || path.includes('\\')) throw new Error(`Invalid source path: ${path}`);
  const file = resolve(root, path);
  if (!within(root, file) || !within(root, realpathSync(file)) || lstatSync(file).isSymbolicLink()) {
    throw new Error(`Source path escapes its root: ${path}`);
  }
  return file;
}

export function parsePickerShots(html) {
  // Parse the literal as JSON; the supplied picker is never executed.
  const match = html.match(/\bconst SHOTS\s*=\s*(\[[\s\S]*?\])\s*;[ \t]*(?:\r?\n|$)/);
  if (!match) throw new Error('Picker must contain a const SHOTS JSON array');
  const shots = JSON.parse(match[1]);
  if (!Array.isArray(shots) || !shots.length) throw new Error('Picker contains no shots');
  const ids = new Set();
  for (const shot of shots) {
    if (![shot.key, shot.card, shot.cat].every(value => typeof value === 'string' && SLUG.test(value))) {
      throw new Error('Invalid shot key, recipe or category');
    }
    if (ids.has(shot.key)) throw new Error(`Duplicate shot key: ${shot.key}`);
    ids.add(shot.key);
    if (typeof shot.catLabel !== 'string' || typeof shot.rec !== 'boolean' || typeof shot.recUse !== 'string') {
      throw new Error(`Invalid picker metadata: ${shot.key}`);
    }
    if (shot.media !== `shotcraft/media/${shot.key}.mp4` || shot.poster !== `shotcraft/poster/${shot.key}.jpg`) {
      throw new Error(`Unexpected preview path: ${shot.key}`);
    }
  }
  return shots;
}

export function probeShotcraftMedia(path, ffprobe = 'ffprobe') {
  const data = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,duration,avg_frame_rate:format=duration', '-of', 'json', path],
  { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 }));
  const stream = data.streams?.[0];
  const duration = Number(stream?.duration || data.format?.duration);
  const [n, d = '1'] = String(stream?.avg_frame_rate || '').split('/');
  const fps = Number(n) / Number(d);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(fps) || fps <= 0
    || !Number.isInteger(stream?.width) || stream.width <= 0 || !Number.isInteger(stream?.height) || stream.height <= 0) {
    throw new Error(`Invalid video metadata: ${basename(path)}`);
  }
  return { duration, width: stream.width, height: stream.height, fps };
}

async function treeFiles(root, directory) {
  if (!existsSync(resolve(root, directory))) return [];
  const files = [];
  for (const entry of await readdir(sourcePath(root, directory), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Symlink is not importable: ${path}`);
    if (entry.isDirectory()) files.push(...await treeFiles(root, path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

function demoDirectory(text, sourceRoot) {
  const paths = text.match(/\bdemos\/[A-Za-z0-9_./-]+/g) || [];
  for (const path of paths) {
    const candidate = path.replace(/\/$/, '');
    const directory = extname(candidate) ? portable(dirname(candidate)) : candidate;
    if (!directory.startsWith('demos/_') && existsSync(resolve(sourceRoot, directory))) {
      sourcePath(sourceRoot, directory);
      return directory;
    }
  }
  throw new Error('Recipe has no existing explicit demos/ reference');
}

export async function importShotcraft({ sourceRoot, pickerPath, destinationRoot = ROOT, ffprobe = 'ffprobe', linkMedia = false }) {
  sourceRoot = realpathSync(resolve(sourceRoot));
  pickerPath = realpathSync(resolve(pickerPath));
  destinationRoot = resolve(destinationRoot);
  const target = join(destinationRoot, PREFIX);
  if (existsSync(target)) throw new Error(`Shotcraft destination already exists: ${target}`);
  const license = await readFile(sourcePath(sourceRoot, 'LICENSE'), 'utf8');
  if (!license.includes('Apache License') || !license.includes('Version 2.0')) {
    throw new Error('Expected upstream Apache-2.0 LICENSE');
  }
  const revision = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  if (revision !== SHOTCRAFT_REVISION) throw new Error(`Unexpected upstream revision: ${revision}; expected ${SHOTCRAFT_REVISION}`);
  const pickerText = await readFile(pickerPath, 'utf8');
  const shots = parsePickerShots(pickerText);
  const upstream = JSON.parse(await readFile(sourcePath(sourceRoot, 'gallery/api/library.json'), 'utf8'));
  const cards = new Map(upstream.cards.map(card => [card.name, card]));
  const selected = new Set(['LICENSE', 'README.md', 'README_CN.md', 'SKILL.md', 'demos/README.md',
    'references/shots/ATTRIBUTION.md', 'gallery/api/library.json']);
  for (const name of ['NOTICE', 'NOTICE.md', 'NOTICE.txt']) if (existsSync(join(sourceRoot, name))) selected.add(name);
  for (const directory of ['demos/_fixtures', 'demos/_textures', 'assets/lib', 'assets/brand']) {
    for (const path of await treeFiles(sourceRoot, directory)) selected.add(path);
  }
  // Keep production references, including attribution, without importing audio or publishing tools.
  for (const path of await treeFiles(sourceRoot, 'references')) if (path.endsWith('.md')) selected.add(path);
  const recipes = new Map();
  for (const shot of shots) {
    const card = cards.get(shot.card);
    if (!card || !card.styles.some(style => style.key === shot.key) || card.category !== shot.cat) {
      throw new Error(`Picker does not match pinned upstream: ${shot.key}`);
    }
    if (!recipes.has(shot.card)) {
      const prompt = `gallery/source/${shot.card}.md`;
      const text = await readFile(sourcePath(sourceRoot, prompt), 'utf8');
      const directory = demoDirectory(text, sourceRoot);
      const files = await treeFiles(sourceRoot, directory);
      const sourceFiles = files.filter(path => /\.(tsx?|jsx?|mjs|html)$/i.test(path));
      if (!sourceFiles.length) throw new Error(`Recipe has no implementation: ${shot.card}`);
      for (const path of [prompt, ...files]) selected.add(path);
      recipes.set(shot.card, { prompt, sourceFiles, paths: sourceFiles.map(path => sourcePath(sourceRoot, path)) });
    }
  }
  await mkdir(dirname(target), { recursive: true });
  const stagingRoot = join(destinationRoot, '.eac');
  await mkdir(stagingRoot, { recursive: true });
  const staging = await mkdtemp(join(stagingRoot, 'shotcraft-import-'));
  try {
    const inventory = [];
    async function copy(root, from, to, origin) {
      const file = sourcePath(root, from);
      const data = await readFile(file);
      await mkdir(dirname(join(staging, to)), { recursive: true });
      if (linkMedia && origin.startsWith('user-local-')) await link(file, join(staging, to));
      else await copyFile(file, join(staging, to));
      inventory.push({ path: `${PREFIX}/${to}`, origin, sourcePath: from, bytes: data.length, sha256: digest(data) });
    }
    for (const path of [...selected].sort()) await copy(sourceRoot, path, path, 'upstream');
    const items = [];
    const previewRoot = realpathSync(dirname(pickerPath));
    for (const shot of shots) {
      const card = cards.get(shot.card);
      const style = card.styles.find(style => style.key === shot.key);
      const recipe = recipes.get(shot.card);
      const metadata = probeShotcraftMedia(sourcePath(previewRoot, shot.media), ffprobe);
      await copy(previewRoot, shot.media, `media/${shot.key}.mp4`, 'user-local-preview');
      await copy(previewRoot, shot.poster, `poster/${shot.key}.jpg`, 'user-local-poster');
      const sourceText = (await Promise.all(recipe.paths.map(path => readFile(path, 'utf8')))).join('\n');
      const requirements = ['Remotion 源码需在 Remotion 项目中注册组件，或改写为支持 renderAt(t)/__seek(t) 的 HTML 时间线；本地预览可直接播放和导入素材'];
      if (sourceText.includes('@remotion/motion-blur')) requirements.push('@remotion/motion-blur');
      if (sourceText.includes('staticFile(')) requirements.push('将 demos/_textures 复制到 Remotion 项目的 public/textures/live；详见 demos/README.md');
      const preview = `/${PREFIX}/media/${shot.key}.mp4`;
      items.push({
        id: `sc-${shot.key}`, slug: shot.key, name: style.label || shot.label || shot.key,
        kind: 'motion', source: 'video-shotcraft', category: shot.catLabel, categoryId: shot.cat,
        description: style.description || card.summary, summary: card.summary,
        use: card.use, energy: card.energy, recipe: shot.card,
        recommended: shot.rec, recommendedUse: shot.recUse,
        tags: [shot.cat, shot.catLabel, shot.card, card.use, card.energy, shot.recUse, ...(shot.rec ? ['recommended', '推荐'] : [])].filter(Boolean),
        duration: metadata.duration, durationLabel: card.duration, fps: metadata.fps,
        width: metadata.width, height: metadata.height,
        composition: { width: 1920, height: 1080, fps: 30 },
        thumbnail: `/${PREFIX}/poster/${shot.key}.jpg`, preview, previewMode: 'video',
        entry: null, renderable: false, status: 'requires-dependencies', runtime: 'requires-dependencies',
        requirements, prompt: `${PREFIX}/${recipe.prompt}`, sourceFiles: recipe.sourceFiles.map(path => `${PREFIX}/${path}`),
        sourceAvailable: true, license: 'Apache-2.0', author: 'Wei Yihao (Vincentwei1021)',
        licenseSource: `${PREFIX}/LICENSE`, attribution: `${PREFIX}/references/shots/ATTRIBUTION.md`,
        homepage: REPOSITORY, sourceUrl: `${REPOSITORY}/tree/${revision}/${portable(dirname(recipe.sourceFiles[0]))}`,
        provenance: { repository: REPOSITORY, revision, recipePath: recipe.prompt, mediaOrigin: 'user-supplied-local-gallery-preview' },
      });
    }
    inventory.sort((a, b) => a.path.localeCompare(b.path));
    const provenance = {
      repository: REPOSITORY, revision, license: 'Apache-2.0', author: 'Wei Yihao',
      importedAt: new Date().toISOString(), picker: { name: basename(pickerPath), sha256: digest(pickerText) },
      mediaStorage: linkMedia ? 'same-volume-hardlinks' : 'copies',
      contentDigest: `sha256:${digest(JSON.stringify(inventory))}`, files: inventory,
      modifications: ['Upstream code and recipes copied unchanged; EAC catalog generated separately.',
        'Local preview videos and posters supplied by the user, hashed individually; not fetched from a release.',
        'Audio assets and Remotion runtime are not bundled. Upstream attribution is retained.'],
    };
    await writeFile(join(staging, 'EAC-PROVENANCE.json'), `${JSON.stringify(provenance, null, 2)}\n`);
    await writeFile(join(staging, 'catalog.json'), `${JSON.stringify({
      schemaVersion: 'eac-shotcraft-library/v1', source: 'video-shotcraft', revision,
      stats: { templates: items.length, recipes: recipes.size, recommended: items.filter(item => item.recommended).length },
      resources: [...selected].filter(path => /\.(md|txt|tsx?|jsx?|mjs|json|css)$/i.test(path) || path === 'LICENSE').sort(),
      templates: items,
    }, null, 2)}\n`);
    // Windows can retain directory handles on imported media; publish the index last on fallback.
    for (let attempt = 0; ; attempt++) {
      try { await rename(staging, target); break; }
      catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || existsSync(target)) throw error;
        if (attempt >= 2) {
          await mkdir(target);
          for (const file of [...inventory.map(file => file.path.slice(PREFIX.length + 1)), 'EAC-PROVENANCE.json']) {
            await mkdir(dirname(join(target, file)), { recursive: true });
            await link(join(staging, file), join(target, file));
          }
          await copyFile(join(staging, 'catalog.json'), join(target, '.catalog.pending'));
          await rename(join(target, '.catalog.pending'), join(target, 'catalog.json'));
          break;
        }
        await setTimeout(200 * (attempt + 1));
      }
    }
    return { directory: target, templates: items.length, recipes: recipes.size, revision, contentDigest: provenance.contentDigest };
  } finally {
    // staging is an mkdtemp child of our work directory, never a caller-supplied path.
    if (within(stagingRoot, staging)) await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      source: { type: 'string' }, picker: { type: 'string' }, destination: { type: 'string', default: ROOT },
      ffprobe: { type: 'string', default: 'ffprobe' }, 'link-media': { type: 'boolean', default: false },
    } });
    if (!values.source || !values.picker) throw new Error('Usage: node scripts/import-shotcraft.mjs --source <pinned checkout> --picker <shotcraft-picker.html> [--destination <repo>]');
    console.log(JSON.stringify(await importShotcraft({
      sourceRoot: values.source, pickerPath: values.picker, destinationRoot: values.destination, ffprobe: values.ffprobe, linkMedia: values['link-media'],
    }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
