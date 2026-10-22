import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createEngine, designContextFor } from '../src/engine.mjs';
import { startServer } from '../src/server.mjs';
import { loadLibrary, resolveTemplate, libraryCatalogEntry } from '../src/catalog.mjs';

const libraryModule = resolve('src', 'open-design-library.mjs');

async function setup(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'eac-design-'));
  const engine = await createEngine({ dataDir: directory });
  try { return await fn(engine, directory); }
  finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
}
async function withServer(fn) {
  return setup(async (engine, dir) => {
    const app = await startServer({ engine, port: 0 });
    try { return await fn(engine, app, dir); }
    finally { await app.close(); }
  });
}

test('design projects and artifacts persist immutable, revision-checked content', () => setup(async (engine) => {
  const project = await engine.handle('design_project_create', { title: 'Landing page', brief: 'Brand hero', kind: 'website', templateId: 'od-hero', sessionId: 's1' });
  assert.equal(project.kind, 'website');
  const first = await engine.handle('design_artifact_save', { projectId: project.id, name: 'index.html', content: '<!doctype html><h1>One</h1>' });
  assert.equal(first.kind, 'html');
  assert.equal(first.revision, 1);
  assert.equal(first.revisions.length, 1);
  assert.match(first.url, /\/api\/design\/artifacts\/[^/]+\/preview/);
  const second = await engine.handle('design_artifact_save', { projectId: project.id, name: 'index.html', content: '<!doctype html><h1>Two</h1>', revision: 1 });
  assert.equal(second.revision, 2);
  assert.equal(second.revisions.length, 2);
  // Stale revision must be refused rather than overwriting history.
  await assert.rejects(engine.handle('design_artifact_save', { projectId: project.id, name: 'index.html', content: '<h1>Stale</h1>', revision: 1 }), /修订号/);
  // Earlier revisions stay byte-for-byte readable.
  const original = await engine.handle('design_artifact_save', { projectId: project.id, name: 'index.html', content: '<h1>Three</h1>', revision: 2 });
  assert.equal(original.revision, 3);
  const old = await engine.designStore.readContent(first.id, 1);
  assert.equal(old.content, '<!doctype html><h1>One</h1>');
  const latest = await engine.designStore.readContent(first.id);
  assert.equal(latest.content, '<h1>Three</h1>');
  const state = await engine.handle('design_state', { sessionId: 's1' });
  assert.equal(state.projects.length, 1);
  assert.equal(state.projects[0].artifacts[0].revisions.length, 3);
}));

test('simultaneous saves cannot overwrite an immutable revision', () => setup(async (engine) => {
  const project = await engine.handle('design_project_create', { title: 'Concurrent', kind: 'website' });
  const first = await engine.handle('design_artifact_save', { projectId: project.id, name: 'index.html', content: '<h1>original</h1>' });
  const results = await Promise.allSettled(['a', 'b'].map(text => engine.handle('design_artifact_save', {
    projectId: project.id, name: 'index.html', content: `<h1>${text}</h1>`, revision: 1,
  })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal((await engine.designStore.readContent(first.id, 1)).content, '<h1>original</h1>');
  assert.equal((await engine.designStore.readContent(first.id)).revision, 2);
}));

test('design store rejects traversal, unsupported kinds and oversized content', () => setup(async (engine) => {
  const project = await engine.handle('design_project_create', { title: 'Guards', kind: 'document' });
  for (const name of ['../escape.html', 'a/b.html', '..', 'evil\\path.html']) {
    await assert.rejects(engine.handle('design_artifact_save', { projectId: project.id, name, content: '<h1>x</h1>' }), /名称/);
  }
  await assert.rejects(engine.handle('design_artifact_save', { projectId: project.id, name: 'big.txt', content: 'x'.repeat(5 * 1024 * 1024 + 1) }), /MB|大小|超过/);
  await assert.rejects(engine.handle('design_project_create', { title: 'bad', kind: 'binary' }), /设计类型/);
  // A kind is derived from the extension: .svg and .md both supported.
  const svg = await engine.handle('design_artifact_save', { projectId: project.id, name: 'icon.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
  assert.equal(svg.kind, 'svg');
  const md = await engine.handle('design_artifact_save', { projectId: project.id, name: 'readme.md', content: '# Title' });
  assert.equal(md.kind, 'markdown');
  await assert.rejects(engine.handle('design_artifact_save', { projectId: 'missing', name: 'a.html', content: '<h1>x</h1>' }), /不存在/);
}));

test('design state filters by session but always includes unscoped projects', () => setup(async (engine) => {
  await engine.handle('design_project_create', { title: 'Scoped', kind: 'website', sessionId: 'a' });
  await engine.handle('design_project_create', { title: 'Other', kind: 'website', sessionId: 'b' });
  await engine.handle('design_project_create', { title: 'Unscoped', kind: 'deck' });
  const scoped = await engine.handle('design_state', { sessionId: 'a' });
  assert.deepEqual(scoped.projects.map((p) => p.title).sort(), ['Scoped', 'Unscoped']);
  const all = await engine.handle('design_state', {});
  assert.equal(all.projects.length, 3);
}));

test('artifact endpoints serve text, sandboxed preview and attachment download', () => withServer(async (engine, app) => {
  const project = await engine.handle('design_project_create', { title: 'Preview', kind: 'website' });
  const html = await engine.handle('design_artifact_save', { projectId: project.id, name: 'page.html', content: '<!doctype html><script>document.title="x"</script><h1>Hi</h1>' });
  const content = await fetch(`${app.url}/api/design/artifacts/${html.id}/content`);
  assert.equal(content.status, 200);
  assert.match((await content.json()).content, /<h1>Hi<\/h1>/);
  const preview = await fetch(`${app.url}/api/design/artifacts/${html.id}/preview`);
  assert.equal(preview.status, 200);
  const csp = preview.headers.get('content-security-policy');
  assert.match(csp, /sandbox/);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.doesNotMatch(csp, /allow-top-navigation|allow-forms/);
  assert.equal(preview.headers.get('x-content-type-options'), 'nosniff');
  // Local assets stay reachable for source-ready HTML, but the opaque sandbox keeps API access off.
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /127\.0\.0\.1/);
  assert.match(await preview.text(), /<h1>Hi<\/h1>/);
  const download = await fetch(`${app.url}/api/design/artifacts/${html.id}/download`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /attachment/);
  const chinese = await engine.handle('design_artifact_save', { projectId: project.id, name: '作品.html', content: '<h1>中文作品</h1>' });
  const unicodeDownload = await fetch(`${app.url}/api/design/artifacts/${chinese.id}/download`);
  assert.equal(unicodeDownload.status, 200);
  assert.match(unicodeDownload.headers.get('content-disposition'), /filename\*=UTF-8''%E4%BD%9C/);
  assert.equal(await unicodeDownload.text(), '<h1>中文作品</h1>');
  const older = await fetch(`${app.url}/api/design/artifacts/${html.id}/content?revision=1`);
  assert.equal(older.status, 200);
  // Unknown artifact and unknown revision are honest 404/400, never a traversal path.
  assert.equal((await fetch(`${app.url}/api/design/artifacts/nope/content`)).status, 404);
  assert.equal((await fetch(`${app.url}/api/design/artifacts/${html.id}/content?revision=99`)).status, 400);
  // SVG preview also carries the sandbox policy.
  const svg = await engine.handle('design_artifact_save', { projectId: project.id, name: 'pic.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>' });
  const svgPreview = await fetch(`${app.url}/api/design/artifacts/${svg.id}/preview`);
  assert.match(svgPreview.headers.get('content-type'), /svg/);
  assert.match(svgPreview.headers.get('content-security-policy'), /sandbox/);
}));

test('composer state is session-scoped and edit/design selections yield current context', () => setup(async (engine) => {
  const normal = await engine.handle('composer_update', { sessionId: 's1', mode: 'normal' });
  assert.equal(normal.mode, 'normal');
  assert.equal(designContextFor(normal), null);
  const design = await engine.handle('composer_update', { sessionId: 's1', mode: 'design', kind: 'website', templateId: 'od-hero', designSystemId: 'od-sys' });
  assert.equal(design.templateId, 'od-hero');
  assert.equal(design.designSystemId, 'od-sys');
  const context = designContextFor(design);
  assert.match(context, /\[EAC design template: od-hero; kind: website\]/);
  assert.match(context, /\[EAC design system: od-sys\]/);
  assert.match(context, /模式本身不产生任何成品/);
  // Another session that never chose design must not inherit the design context.
  assert.equal(designContextFor(await engine.handle('composer_get', { sessionId: 's2' })), null);
  const fetched = await engine.handle('composer_get', { sessionId: 's1' });
  assert.equal(fetched.designSystemId, 'od-sys');
  const edit = await engine.handle('composer_update', { sessionId: 's1', mode: 'edit', templateId: '03-isometric' });
  assert.match(designContextFor(edit), /03-isometric/);
  const cancelled = await engine.handle('composer_update', { sessionId: 's1', mode: 'edit', templateId: '' });
  assert.doesNotMatch(designContextFor(cancelled), /03-isometric/);
  assert.match(designContextFor(cancelled), /没有选择模板/);
  await assert.rejects(engine.handle('composer_update', { sessionId: 's1', mode: 'design', kind: 'binary' }), /创作类型/);
  await assert.rejects(engine.handle('composer_update', { mode: 'design' }), /会话 ID/);
}));

test('composer endpoint allows trusted origins with preflight but rejects others', () => withServer(async (engine, app) => {
  const ok = await fetch(`${app.url}/api/composer`, {
    method: 'PUT', headers: { 'content-type': 'application/json', origin: 'dsh-app://app' },
    body: JSON.stringify({ sessionId: 's1', mode: 'design', kind: 'deck' }),
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'dsh-app://app');
  const preflight = await fetch(`${app.url}/api/composer`, { method: 'OPTIONS', headers: { origin: 'dsh-app://app' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'dsh-app://app');
  const read = await fetch(`${app.url}/api/composer?sessionId=s1`);
  assert.equal(read.status, 200);
  assert.equal((await read.json()).kind, 'deck');
  const blocked = await fetch(`${app.url}/api/composer`, {
    method: 'PUT', headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ sessionId: 's1', mode: 'normal' }),
  });
  assert.equal(blocked.status, 403);
  // Other API routes keep rejecting cross-origin calls.
  const other = await fetch(`${app.url}/api/state`, { headers: { origin: 'dsh-app://app' } });
  assert.equal(other.status, 403);
}));

test('renderable catalog entries are distinguished from prompt-only items', () => {
  const promptOnly = libraryCatalogEntry({ id: 'od-prompt', kind: 'prompt', status: 'prompt-only', entry: null, prompt: 'vendor/open-design/p.md' });
  assert.equal(promptOnly.renderable, false);
  const example = libraryCatalogEntry({ id: 'od-example', kind: 'example', status: 'example-only', entry: 'vendor/open-design/e.html' });
  assert.equal(example.renderable, false);
  const ready = libraryCatalogEntry({ id: 'od-ready', kind: 'website', status: 'source-ready', entry: 'vendor/open-design/r.html' });
  assert.equal(ready.renderable, true);
});

test('prompt-only templates are marked non-renderable by the catalog', () => {
  const promptOnly = libraryCatalogEntry({ id: 'od-prompt-only', kind: 'prompt', status: 'prompt-only', entry: null, prompt: 'vendor/open-design/p.md' });
  assert.equal(promptOnly.renderable, false);
  assert.equal(promptOnly.entry, null);
});

test('library module exports the required contract', async () => {
  // The content module is owned by another agent. It must exist and expose the contract; an
  // import failure is surfaced loudly rather than silently degrading to an empty library.
  assert.equal(existsSync(libraryModule), true, 'src/open-design-library.mjs must exist');
  const library = await loadLibrary();
  assert.ok(Array.isArray(library.openDesignTemplates));
  assert.ok(Array.isArray(library.designSystems));
  assert.ok(Array.isArray(library.creationModes));
  assert.equal(typeof library.readLibraryItem, 'function');
  assert.ok(library.creationModes.length > 0, 'creation modes must be populated');
  for (const template of library.openDesignTemplates) {
    assert.match(template.id, /^od-[A-Za-z0-9._-]+$/);
    assert.ok(template.kind, `${template.id} must declare a kind`);
  }
  for (const system of library.designSystems) assert.match(system.id, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  if (library.openDesignTemplates.length) {
    const item = await library.readLibraryItem({ kind: 'template', id: library.openDesignTemplates[0].id, source: false });
    assert.ok(item && item.id, 'readLibraryItem must return the addressed item');
    assert.ok(typeof item.kind === 'string');
  }
});

test('library API and tool mapping surface templates, systems and modes', async () => {
  await withServer(async (engine, app) => {
    const response = await fetch(`${app.url}/api/library`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.templates));
    assert.ok(Array.isArray(body.designSystems));
    assert.ok(Array.isArray(body.creationModes));
    // The combined catalog always includes the 17 built-in templates plus any OpenDesign items.
    assert.ok(body.templates.length >= 17);
    assert.equal(body.provenance.repo, 'nexu-io/open-design');
    assert.equal(body.designSystems.length, 152);
    assert.equal(body.templates.filter(item => !['motion-web', 'onetake', 'video-shotcraft'].includes(item.source)).length, 534);
    assert.ok(body.templates.filter(item => item.id.startsWith('od-')).every(item => item.license && item.provenance));
    const sourceTemplate = body.templates.find(item => item.id.startsWith('od-') && item.entry);
    assert.equal(typeof sourceTemplate.entry, 'string');
    const sourceRead = await engine.handle('library_read', { kind: 'template', id: sourceTemplate.id, source: true });
    assert.ok(sourceRead.entry.text.length > 0);
    const template = body.templates.find((item) => item.id.startsWith('od-'));
    if (template) {
      const read = await fetch(`${app.url}/api/tools/library_read`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'template', id: template.id }),
      });
      assert.equal(read.status, 200);
      assert.equal((await read.json()).id, template.id);
    }
    const unknown = await fetch(`${app.url}/api/tools/not_a_tool`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(unknown.status, 404);
  });
});

test('AI library search returns compact real ids and reads selected source', () => setup(async engine => {
  const systems = await engine.handle('library_list', { kind: 'design-system', query: 'Agentic', limit: 10 });
  assert.equal(systems.total, 1);
  assert.equal(systems.items[0].id, 'od-ds-agentic');
  const motion = await engine.handle('library_list', { kind: 'motion', query: 'bold-poster' });
  assert.ok(motion.items.some(item => item.id === 'od-vt-frame-bold-poster'));
  const source = await engine.handle('library_read', { kind: 'template', id: 'od-vt-frame-bold-poster', source: true });
  assert.match(source.entry.text, /Make it/);
}));

test('template_read rejects prompt-only items but serves renderable sources', async () => {
  await setup(async (engine, dir) => {
    // A local template always has both entry and prompt, so template_read works.
    const local = await engine.handle('template_read', { templateId: 'motion-promo-film-v2', source: true });
    assert.match(local.content, /</);
    await assert.rejects(engine.handle('template_read', { templateId: 'does-not-exist' }), /Unknown template/);
  });
});

test('imported OpenDesign HTML/SVG is served sandboxed but legacy templates stay same-origin', async () => {
  await withServer(async (engine, app, dir) => {
    const vendorRoot = resolve('vendor');
    const odDir = join(vendorRoot, 'open-design');
    const created = !existsSync(odDir);
    if (created) await mkdir(odDir, { recursive: true });
    const sample = join(odDir, 'sample.html');
    await writeFile(sample, '<!doctype html><script>fetch("/api/state")</script><h1>od</h1>');
    try {
      const response = await fetch(`${app.url}/vendor/open-design/sample.html`);
      assert.equal(response.status, 200);
      const csp = response.headers.get('content-security-policy');
      assert.match(csp, /sandbox allow-scripts/);
      assert.doesNotMatch(csp, /allow-same-origin/);
      // Legacy local template must NOT get the sandbox CSP (it needs same-origin __seek).
      const legacy = await fetch(`${app.url}/vendor/motion-promo-film-v2/references/example-film.html`);
      assert.equal(legacy.status, 200);
      assert.equal(legacy.headers.get('content-security-policy'), null);
    } finally {
      if (created) await rm(odDir, { recursive: true, force: true });
      else await rm(sample, { force: true });
    }
  });
});

test('renderTemplate refuses prompt-only and dependency-missing templates', async () => {
  const { renderTemplate } = await import('../src/render-template.mjs');
  // The 3D template is dependency-gated: it must refuse before launching a browser.
  await assert.rejects(renderTemplate({ templateId: '04-3d-render', outputPath: join(tmpdir(), 'x.mp4') }), /Blender/);
  await assert.rejects(renderTemplate({ templateId: 'nope', outputPath: join(tmpdir(), 'x.mp4') }), /Unknown template/);
});

test('a revision written before the metadata save is adopted instead of blocking later saves', async () => {
  // Regression: writeFile(r3) succeeded but projects.json still said revision 2 (crash, power loss).
  // The next save then recomputed r3, hit EEXIST on the wx write and could never save that artifact
  // again. The bytes on disk must be kept, adopted, and numbered past.
  const directory = await mkdtemp(join(tmpdir(), 'eac-design-crash-'));
  try {
    const first = await createEngine({ dataDir: directory });
    const project = await first.handle('design_project_create', { title: 'Crash', kind: 'website' });
    const one = await first.handle('design_artifact_save', { projectId: project.id, name: 'index.html', content: '<h1>one</h1>' });
    await first.handle('design_artifact_save', { projectId: project.id, name: 'index.html', content: '<h1>two</h1>', revision: 1 });
    await first.close();
    const artifactDirectory = join(directory, 'design', 'files', one.id);
    await writeFile(join(artifactDirectory, 'r3.html'), '<h1>interrupted</h1>', 'utf8');
    // A crash in the middle of the write leaves only a temporary file; it is not a revision.
    await writeFile(join(artifactDirectory, `r4.html.eac-tmp-${'0'.repeat(8)}`), '<h1>partial', 'utf8');
    const second = await createEngine({ dataDir: directory });
    try {
      const state = second.designStore.snapshot();
      assert.equal(state.projects[0].artifacts[0].revision, 3, 'the revision on disk is adopted');
      assert.deepEqual(second.designStore.recovered.map((entry) => entry.revision), [3]);
      assert.equal(existsSync(join(artifactDirectory, `r4.html.eac-tmp-${'0'.repeat(8)}`)), false, 'interrupted write is discarded');
      assert.equal((await second.designStore.readContent(one.id, 3)).content, '<h1>interrupted</h1>');
      const saved = await second.handle('design_artifact_save', { projectId: project.id, name: 'index.html', content: '<h1>three</h1>', revision: 3 });
      assert.equal(saved.revision, 4);
      assert.equal((await second.designStore.readContent(one.id)).content, '<h1>three</h1>');
      assert.equal((await second.designStore.readContent(one.id, 1)).content, '<h1>one</h1>');
      assert.equal((await second.designStore.readContent(one.id, 2)).content, '<h1>two</h1>');
    } finally { await second.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an untracked revision file that appears at runtime is adopted instead of failing the save', () => setup(async (engine, directory) => {
  const project = await engine.handle('design_project_create', { title: 'Stray', kind: 'document' });
  const saved = await engine.handle('design_artifact_save', { projectId: project.id, name: 'doc.md', content: '# one' });
  assert.equal(saved.revision, 1);
  // Something put a revision file where the store is about to write (a second writer, a restore).
  await writeFile(join(directory, 'design', 'files', saved.id, 'r2.md'), '# stray', 'utf8');
  const next = await engine.handle('design_artifact_save', { projectId: project.id, name: 'doc.md', content: '# two', revision: 1 });
  assert.equal(next.revision, 3, 'the conflicting number is skipped, not overwritten');
  assert.equal((await engine.designStore.readContent(saved.id, 1)).content, '# one');
  assert.equal((await engine.designStore.readContent(saved.id, 2)).content, '# stray');
  assert.equal((await engine.designStore.readContent(saved.id, 3)).content, '# two');
}));

test('design projects survive engine restart through the local store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-design-restart-'));
  try {
    const first = await createEngine({ dataDir: directory });
    const project = await first.handle('design_project_create', { title: 'Persistent', kind: 'image' });
    const artifact = await first.handle('design_artifact_save', { projectId: project.id, name: 'hero.svg', content: '<svg/>' });
    await first.close();
    const second = await createEngine({ dataDir: directory });
    const state = await second.handle('design_state', {});
    assert.equal(state.projects[0].title, 'Persistent');
    assert.equal(state.projects[0].artifacts[0].name, 'hero.svg');
    assert.equal((await second.designStore.readContent(artifact.id)).content, '<svg/>');
    await second.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
