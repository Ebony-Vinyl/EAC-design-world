import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recommendedTemplates, scopedTemplates, matchesTemplate, formatDuration, readShotlist, shotlistText } from '../ui/library-selection.mjs';
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

test('motion recommendations include curated shots alongside existing full templates', () => {
  const templates = [
    { id: 'classic', kind: 'motion', source: 'mg-styles-15' },
    { id: 'shot-a', kind: 'motion', source: 'video-shotcraft', recommended: false },
    { id: 'shot-b', kind: 'motion', source: 'video-shotcraft', recommended: true },
    { id: 'shot-c', kind: 'motion', source: 'video-shotcraft', recommended: true },
  ];
  assert.deepEqual(recommendedTemplates(templates, 'edit', 'motion', 3).map(item => item.id), ['classic', 'shot-b', 'shot-c']);
  assert.equal(new Set(recommendedTemplates(templates, 'edit', 'motion', 8).map(item => item.id)).size, 4);
});

test('search matches multiple words across actual shot metadata', () => {
  const shot = { name: '标题入场', id: 'sc-title', category: '文字与字卡', recipe: 'type-assembly',
    use: '产品 launch', tags: ['3D', 'spring'] };
  assert.equal(matchesTemplate(shot, ' LAUNCH  3d '), true);
  assert.equal(matchesTemplate(shot, '字卡 assembly'), true);
  assert.equal(matchesTemplate(shot, 'launch nonexistent'), false);
});

test('shotlists reject malformed storage, deduplicate ids and export readable ids and timings', () => {
  assert.deepEqual(readShotlist('{"x":1}'), []);
  assert.deepEqual(readShotlist('bad'), []);
  assert.deepEqual(readShotlist('["sc-a","sc-a","../private",null,4,"sc-b"]'), ['sc-a', 'sc-b']);
  assert.equal(formatDuration(5.666), '5.7s');
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration('unknown'), '');
  assert.equal(formatDuration(0), '');
  const text = shotlistText([{ id: 'sc-a', name: '动效', category: '转场', duration: 5.5, use: '品牌片' }]);
  assert.match(text, /1\. 动效 \[sc-a\] · 转场 · 5\.5s\n   品牌片/);
});
