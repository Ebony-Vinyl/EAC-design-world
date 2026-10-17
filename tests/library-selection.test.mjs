import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recommendedTemplates, scopedTemplates } from '../ui/library-selection.mjs';
const catalog = JSON.parse(readFileSync(new URL('../vendor/open-design/catalog.json', import.meta.url)));
const items = catalog.templates.map(item => ({ ...item, entry: item.entry?.path }));

test('each design type changes recommendation ids and never leaks MG motion into website', () => {
  const selections = [];
  for (const kind of ['website', 'deck', 'document', 'image', 'motion']) {
    const result = recommendedTemplates(items, 'design', kind, 12);
    assert.equal(result.length, 12);
    assert.ok(result.every(item => scopedTemplates([item], 'design', kind).length === 1));
    selections.push(result.map(item => item.id).join(','));
  }
  assert.equal(new Set(selections).size, 5);
  assert.ok(recommendedTemplates(items, 'design', 'website', 12).every(item => item.kind === 'website'));
});

test('inline gallery can show several rows and expanded recommendations', () => {
  assert.equal(recommendedTemplates(items, 'design', 'website', 12).length, 12);
  assert.equal(recommendedTemplates(items, 'design', 'website', 24).length, 24);
  assert.ok(scopedTemplates(items, 'edit', 'website').every(item => item.kind === 'motion' || item.kind === 'prompt'));
});
