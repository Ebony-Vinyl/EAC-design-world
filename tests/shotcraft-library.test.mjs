import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  shotcraftTemplates, readShotcraftLibraryItem, searchShotcraftLibrary,
  resolveShotcraftPath, shotcraftLibraryInfo, SHOTCRAFT_ROOT,
} from '../src/shotcraft-library.mjs';
import { ROOT, getTemplate, getTemplates, resolveTemplate } from '../src/catalog.mjs';
import { parsePickerShots, probeShotcraftMedia, importShotcraft, SHOTCRAFT_REVISION } from '../scripts/import-shotcraft.mjs';
import { createEngine } from '../src/engine.mjs';
import { startServer } from '../src/server.mjs';
import { renderTemplate } from '../src/render-template.mjs';
import { probeMedia } from '../src/media/index.mjs';

const items = shotcraftTemplates();
const sha256 = data => createHash('sha256').update(data).digest('hex');
const manifest = JSON.parse(readFileSync(join(ROOT, SHOTCRAFT_ROOT, 'EAC-PROVENANCE.json'), 'utf8'));

async function withEngine(run) {
  const directory = await mkdtemp(join(tmpdir(), 'eac-shotcraft-'));
  const engine = await createEngine({ dataDir: directory });
  try { await run(engine, directory); }
  finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
}

test('Shotcraft imports all local styles, Chinese metadata and actual portable media', () => {
  assert.equal(items.length, 150);
  assert.equal(new Set(items.map(item => item.id)).size, 150);
  assert.equal(new Set(items.map(item => item.recipe)).size, 124);
  assert.equal(items.filter(item => item.recommended).length, 59);
  assert.equal(new Set(items.map(item => item.category)).size, 10);
  for (const item of items) {
    assert.match(item.id, /^sc-/);
    assert.equal(item.source, 'video-shotcraft');
    assert.match(item.category, /[\u3400-\u9fff]/);
    assert.equal(typeof item.recommended, 'boolean');
    assert.ok(item.use && item.energy && item.recipe);
    assert.ok(item.duration > 0 && item.width > 0 && item.height > 0 && item.fps > 0);
    assert.ok(item.preview.startsWith('/vendor/video-shotcraft/media/'));
    assert.ok(item.thumbnail.startsWith('/vendor/video-shotcraft/poster/'));
    assert.ok(existsSync(join(ROOT, item.preview.slice(1))));
    assert.ok(existsSync(join(ROOT, item.thumbnail.slice(1))));
    assert.equal(item.sourceAvailable, true, item.id);
    assert.equal(item.entry, null);
    assert.equal(item.renderable, false);
    assert.equal(item.available, false);
    assert.equal(item.status, 'requires-dependencies');
    assert.match(item.requirements[0], /Remotion/);
    assert.equal(item.license, 'Apache-2.0');
  }
  const measured = probeShotcraftMedia(join(ROOT, items[0].preview.slice(1)));
  for (const key of ['duration', 'width', 'height', 'fps']) assert.equal(items[0][key], measured[key]);
});

test('pinned provenance inventories unchanged sources and user supplied preview hashes', async () => {
  assert.equal(manifest.revision, SHOTCRAFT_REVISION);
  assert.equal(manifest.license, 'Apache-2.0');
  assert.equal(manifest.contentDigest, `sha256:${sha256(JSON.stringify(manifest.files))}`);
  assert.equal(manifest.files.filter(file => file.origin === 'user-local-preview').length, 150);
  assert.equal(manifest.files.filter(file => file.origin === 'user-local-poster').length, 150);
  for (const file of manifest.files) {
    assert.ok(resolveShotcraftPath(file.path), file.path);
    assert.equal(sha256(await readFile(join(ROOT, file.path))), file.sha256, file.path);
    assert.ok(!file.sourcePath.includes(':') && !file.sourcePath.startsWith('/'), file.sourcePath);
    assert.ok(!file.path.includes('/.git/') && !file.path.includes('/node_modules/') && !file.path.includes('/_legacy/'));
    assert.ok(!/\.(mp3|wav|flac)$/i.test(file.path));
  }
  const license = await readFile(join(ROOT, SHOTCRAFT_ROOT, 'LICENSE'), 'utf8');
  assert.match(license, /Copyright 2026 Wei Yihao/);
  assert.deepEqual(shotcraftLibraryInfo().stats, { templates: 150, recipes: 124, recommended: 59 });
});

test('source reads return real recipe and TSX, shared fixtures and both multi-style variants', async () => {
  const read = await readShotcraftLibraryItem({ kind: 'motion', id: 'sc-blur-slide', includeEntry: true });
  assert.match(read.content, /BlurSlide\.tsx/);
  assert.equal(read.entry, null);
  assert.ok(read.sources.some(file => file.path.endsWith('/BlurSlide.tsx') && file.text.includes("from 'remotion'")));
  const resource = 'demos/_fixtures/Look.tsx';
  assert.ok(read.resources.includes(resource));
  const shared = await readShotcraftLibraryItem({ kind: 'template', id: read.id, resource });
  assert.match(shared.resource.text, /export/);
  await assert.rejects(readShotcraftLibraryItem({ kind: 'motion', id: read.id, resource: '../../package.json' }), /Invalid Shotcraft resource/);
  assert.equal(await readShotcraftLibraryItem({ kind: 'skill', id: read.id }), null);
  assert.equal(await readShotcraftLibraryItem({ kind: 'motion', id: 'sc-../../package' }), null);
  const grouped = await readShotcraftLibraryItem({ kind: 'motion', id: 'sc-icon-flip-bloom', includeEntry: true });
  assert.equal(grouped.recipe, 'ui-to-brand-morph');
  assert.ok(grouped.sources.some(file => file.path.endsWith('/IconFlipBloomLogo.tsx')));
  assert.ok(grouped.sources.some(file => file.path.endsWith('/InputMorphsIntoLogo.tsx')));
  for (const id of ['sc-brand-ink-open', 'sc-document-typewriter-reveal']) {
    assert.ok((await readShotcraftLibraryItem({ kind: 'motion', id, includeEntry: true })).sources.length);
  }
});

test('catalog and searches resolve sc IDs without advertising a video as renderable HTML', async () => {
  const item = getTemplate('sc-blur-slide');
  assert.equal(item.source, 'video-shotcraft');
  assert.equal(item.available, false);
  assert.equal((await resolveTemplate(item.id)).renderable, false);
  assert.equal(getTemplates().filter(item => item.source === 'video-shotcraft').length, 150);
  assert.ok(searchShotcraftLibrary('文字与字卡').some(item => item.id === 'sc-blur-slide'));
  assert.ok(searchShotcraftLibrary('ui-to-brand-morph').some(item => item.id === 'sc-input-morph-assemble'));
  assert.ok(searchShotcraftLibrary('三通道').length);
  assert.ok(searchShotcraftLibrary('低（一次性收敛').some(item => item.id === 'sc-blur-slide'));
  await assert.rejects(resolveTemplate('sc-missing'), /Unknown template/);
  await assert.rejects(renderTemplate({
    templateId: item.id, outputPath: join(tmpdir(), 'eac-shotcraft-must-not-render.mp4'),
  }), /没有可渲染的源文件/);
});

test('library and tool paths expose searchable metadata, recipes and real implementations', () => withEngine(async engine => {
  const library = await engine.library();
  assert.equal(library.templates.filter(item => item.source === 'video-shotcraft').length, 150);
  assert.equal(library.sourceLibraries['video-shotcraft'].revision, SHOTCRAFT_REVISION);
  const list = await engine.handle('library_list', { kind: 'motion', query: 'video-shotcraft', limit: 200 });
  assert.equal(list.total, 150);
  assert.equal(list.items.length, 150);
  for (const item of list.items) {
    assert.equal(typeof item.recommended, 'boolean');
    assert.ok(item.recipe && item.category && item.energy && item.use && item.duration);
    assert.ok(item.preview && item.thumbnail);
    assert.equal(item.renderable, false);
  }
  assert.ok((await engine.handle('library_list', { kind: 'template', query: '文字与字卡' })).items.some(item => item.id === 'sc-blur-slide'));
  const tool = await engine.handle('library_read', { kind: 'template', id: 'sc-blur-slide', source: true });
  assert.ok(tool.sources.some(file => file.text.includes('BLUR_SLIDE_DURATION')));
  const source = await engine.handle('template_read', { templateId: tool.id, source: true });
  assert.equal(source.content, tool.sources[0].text);
  assert.equal(source.template.entry, null);
  const recipe = await engine.handle('template_read', { templateId: tool.id });
  assert.equal(recipe.content, tool.content);
  const shared = await engine.handle('library_read', { kind: 'motion', id: tool.id, resource: 'demos/_fixtures/Brand.tsx' });
  assert.match(shared.resource.text, /ShotcraftMark/);
}));

test('HTTP serves local preview range, poster and Shotcraft tool source', () => withEngine(async engine => {
  const app = await startServer({ engine, port: 0 });
  try {
    const video = await fetch(`${app.url}${items[0].preview}`, { headers: { range: 'bytes=0-31' } });
    assert.equal(video.status, 206);
    assert.equal(video.headers.get('content-type'), 'video/mp4');
    const bytes = Buffer.from(await video.arrayBuffer());
    assert.equal(bytes.length, 32);
    assert.equal(bytes.toString('ascii', 4, 8), 'ftyp');
    const poster = await fetch(`${app.url}${items[0].thumbnail}`);
    assert.equal(poster.status, 200);
    assert.equal(poster.headers.get('content-type'), 'image/jpeg');
    assert.equal(Buffer.from(await poster.arrayBuffer()).readUInt16BE(0), 0xffd8);
    const source = await fetch(`${app.url}/api/tools/library_read`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'motion', id: 'sc-blur-slide', source: true }),
    });
    assert.equal(source.status, 200);
    assert.equal((await source.json()).entry, null);
  } finally { await app.close(); }
}));

test('registered Shotcraft previews import as probed footage and render through a short normal timeline', () => withEngine(async engine => {
  const project = await engine.handle('project_create', { title: 'Shotcraft footage proof', width: 320, height: 180, fps: 12 });
  await assert.rejects(engine.handle('asset_import', { projectId: project.id }), /path.*templateId/);
  await assert.rejects(engine.handle('asset_import', { projectId: project.id, path: 'unused.mp4', templateId: 'sc-blur-slide' }), /path.*templateId/);
  await assert.rejects(engine.handle('asset_import', { projectId: project.id, templateId: 'motion-promo-film' }), /Shotcraft/);
  await assert.rejects(engine.handle('asset_import', { projectId: project.id, templateId: 'sc-not-registered' }), /Unknown template/);
  const imported = await engine.handle('asset_import', { projectId: project.id, templateId: 'sc-blur-slide' });
  assert.equal(imported.assets.length, 1);
  const footage = imported.assets[0];
  assert.equal(footage.kind, 'video');
  assert.equal(footage.path, resolveShotcraftPath('vendor/video-shotcraft/media/blur-slide.mp4'));
  assert.ok(footage.duration > 0 && footage.probe.streams.some(stream => stream.codec_type === 'video'));
  assert.equal((await engine.handle('asset_import', { projectId: project.id, templateId: 'sc-blur-slide' })).assets.length, 1);
  // The original path-based import still works and preserves normal deduplication.
  assert.equal((await engine.handle('asset_import', { projectId: project.id, path: footage.path })).assets.length, 1);
  const planned = await engine.handle('timeline_plan', { projectId: project.id, duration: 0.6 });
  assert.equal(planned.clips.length, 1);
  assert.equal(planned.clips[0].assetId, footage.id);
  const queued = await engine.handle('job_submit', { projectId: project.id, type: 'render' });
  const deadline = Date.now() + 45000;
  let job;
  do {
    job = await engine.handle('job_status', { jobId: queued.id });
    if (!['queued', 'running'].includes(job.status)) break;
    await new Promise(done => setTimeout(done, 40));
  } while (Date.now() < deadline);
  assert.equal(job.status, 'completed', job.error || 'Timeline render timed out');
  assert.equal(job.result.qa.ok, true);
  const output = await probeMedia(job.result.path);
  assert.equal(output.hasVideo, true);
  assert.ok(Math.abs(output.duration - 0.6) < 0.15, `Unexpected rendered duration ${output.duration}`);
  assert.ok((await readFile(job.result.path)).length > 1000);
}));

test('paths reject traversal and escaping junctions, missing imports stay empty', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-shotcraft-paths-'));
  try {
    assert.deepEqual(shotcraftTemplates({ root: directory }), []);
    assert.equal(resolveShotcraftPath(`${SHOTCRAFT_ROOT}/../../package.json`), null);
    assert.equal(resolveShotcraftPath('src/engine.mjs'), null);
    const vendor = join(directory, SHOTCRAFT_ROOT);
    await mkdir(vendor, { recursive: true });
    const outside = join(directory, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'outside');
    await symlink(outside, join(vendor, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(resolveShotcraftPath(`${SHOTCRAFT_ROOT}/escape/secret.txt`, { root: directory }), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('picker JSON is parsed without execution and importer refuses unsafe or existing input', async () => {
  const valid = { key: 'sample', card: 'sample', cat: 'effects', catLabel: '光效与强调',
    rec: true, recUse: '示例', media: 'shotcraft/media/sample.mp4', poster: 'shotcraft/poster/sample.jpg' };
  const html = shots => `const SHOTS = ${JSON.stringify(shots)};\nthrow new Error('must not execute');`;
  assert.deepEqual(parsePickerShots(html([valid])), [valid]);
  assert.throws(() => parsePickerShots(html([valid, valid])), /Duplicate/);
  assert.throws(() => parsePickerShots(html([{ ...valid, key: '../escape' }])), /Invalid shot/);
  assert.throws(() => parsePickerShots(html([{ ...valid, media: 'C:/private.mp4' }])), /Unexpected preview path/);
  assert.throws(() => parsePickerShots('const SHOTS = dangerous();\n'), /JSON array/);
  await assert.rejects(importShotcraft({ sourceRoot: ROOT, pickerPath: join(ROOT, 'README.md') }), /already exists/);
  const destinationRoot = await mkdtemp(join(tmpdir(), 'eac-shotcraft-import-'));
  try {
    await assert.rejects(importShotcraft({ sourceRoot: ROOT, pickerPath: join(ROOT, 'README.md'), destinationRoot }), /Apache-2.0 LICENSE/);
    assert.equal(existsSync(join(destinationRoot, SHOTCRAFT_ROOT)), false);
  } finally { await rm(destinationRoot, { recursive: true, force: true }); }
});
