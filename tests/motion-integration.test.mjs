import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as catalog from '../src/catalog.mjs';
import { createEngine } from '../src/engine.mjs';

async function withEngine(run) {
  const dataDir = await mkdtemp(join(tmpdir(), 'eac-motion-integration-'));
  const engine = await createEngine({ dataDir });
  try { await run(engine); }
  finally { await engine.close(); await rm(dataDir, { recursive: true, force: true }); }
}

test('template catalog includes optional local motion sources at lookup time', async () => {
  assert.equal(typeof catalog.getTemplates, 'function', 'catalog must refresh optional motion sources without a process restart');
  const items = catalog.getTemplates();
  assert.ok(items.length >= catalog.templates.length);
  assert.equal(new Set(items.map(item => item.id)).size, items.length);
  for (const item of items.filter(item => ['motion-web', 'onetake'].includes(item.source))) {
    assert.equal((await catalog.resolveTemplate(item.id)).available, true);
    assert.equal(item.kind, 'motion');
    assert.ok(item.license);
  }
});

test('design library can read the same built-in template source as the video tools', () => withEngine(async engine => {
  const id = 'motion-promo-film';
  const video = await engine.handle('template_read', { templateId: id, source: true });
  const design = await engine.handle('library_read', { kind: 'template', id, source: true });
  assert.equal(design.entry.path, video.template.entry);
  assert.equal(design.entry.text, video.content);
}));

test('all installed optional motion templates are searchable and readable through both tool paths', () => withEngine(async engine => {
  const state = await engine.state();
  const library = await engine.library();
  for (const item of state.templates.filter(item => ['motion-web', 'onetake'].includes(item.source))) {
    assert.ok(library.templates.some(candidate => candidate.id === item.id));
    const found = await engine.handle('library_list', { kind: 'motion', query: item.id });
    assert.ok(found.items.some(candidate => candidate.id === item.id));
    const video = await engine.handle('template_read', { templateId: item.id, source: true });
    const design = await engine.handle('library_read', { kind: 'template', id: item.id, source: true });
    assert.equal(design.entry.text, video.content);
    assert.ok(video.content.includes('<html'));
  }
}));
