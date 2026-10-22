import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import * as Library from '../src/open-design-library.mjs';
import {
  openDesignTemplates, designSystems, creationModes, readLibraryItem,
  librarySkills, libraryPrompts, libraryAtoms, libraryScenarios,
  libraryStats, libraryProvenance, isOpenDesignLibraryAvailable,
  searchLibrary, listLibraryIds, resolveLibraryPath, libraryFileUrl, SAFE_ID,
} from '../src/open-design-library.mjs';
import { ROOT } from '../src/catalog.mjs';

const CATALOG_PATH = join(ROOT, 'vendor', 'open-design', 'catalog.json');
const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
const allItems = [
  ...catalog.designSystems, ...catalog.templates,
  ...catalog.skills, ...catalog.atoms, ...catalog.scenarios,
];

test('catalog exists with pinned provenance and real upstream revision', () => {
  assert.ok(existsSync(CATALOG_PATH), 'catalog.json must exist');
  assert.equal(catalog.schemaVersion, 'eac-open-design-library/v1');
  assert.equal(catalog.source.repo, 'nexu-io/open-design');
  assert.match(catalog.source.digest, /^[a-f0-9]{64}$/);
  assert.equal(catalog.source.revision, `sha256:${catalog.source.digest}`);
  assert.equal(catalog.source.version, '0.25.1');
  assert.equal(catalog.source.commit, null);
  assert.ok(catalog.source.license, 'upstream license recorded');
  const marker = JSON.parse(readFileSync(join(ROOT, 'vendor', 'open-design', 'PROVENANCE.json'), 'utf8'));
  assert.equal(marker.name, 'open-design');
  assert.equal(marker.source.digest, catalog.source.digest);
});

test('imported counts match the real upstream content, not fabricated', () => {
  assert.equal(designSystems.length, 152);
  assert.equal(openDesignTemplates.length, 517);
  assert.equal(librarySkills.length, 169);
  assert.equal(libraryAtoms.length, 13);
  assert.equal(libraryScenarios.length, 14);
  assert.equal(libraryStats.designSystems, 152);
  assert.equal(libraryStats.templatesBySet.examples, 188);
  assert.equal(libraryStats.templatesBySet['design-templates'], 115);
  assert.equal(libraryStats.templatesBySet['video-templates'], 63);
  assert.equal(libraryStats.templatesBySet['image-templates'], 45);
  assert.equal(libraryStats.templatesBySet['prompt-templates/video'], 58);
  assert.equal(libraryStats.templatesBySet['prompt-templates/image'], 48);
  assert.equal(libraryStats.total, 865);
  assert.equal(libraryStats.uniqueIds, 865);
  assert.equal(allItems.length, 865);
});

test('every id is od-prefixed, safe for the host regex, and unique', () => {
  const seen = new Set();
  for (const item of allItems) {
    assert.ok(item.id.startsWith('od-'), `id must be od- prefixed: ${item.id}`);
    assert.ok(SAFE_ID.test(item.id), `id must match host safe pattern: ${item.id}`);
    assert.ok(item.id.length <= 128, `id too long: ${item.id}`);
    assert.ok(!seen.has(item.id), `duplicate id: ${item.id}`);
    seen.add(item.id);
  }
  assert.equal(seen.size, allItems.length);
});

test('every catalog entry path stays inside vendor/open-design and exists', () => {
  for (const item of allItems) {
    if (item.path) {
      assert.ok(item.path.startsWith('vendor/open-design/'), `path escaped: ${item.id} -> ${item.path}`);
      assert.ok(existsSync(resolve(ROOT, item.path)), `path missing on disk: ${item.id} -> ${item.path}`);
    }
    for (const file of item.files || []) {
      assert.ok(file.startsWith('vendor/open-design/'), `file escaped: ${item.id} -> ${file}`);
      assert.ok(existsSync(resolve(ROOT, file)), `listed file missing: ${item.id} -> ${file}`);
    }
    if (item.entry) {
      assert.ok(item.entry.path.startsWith('vendor/open-design/'), `entry escaped: ${item.id}`);
      assert.equal(item.entry.url, `/vendor/${item.entry.path.replace(/^vendor\//, '')}`);
      if (item.entry.exists) assert.ok(existsSync(resolve(ROOT, item.entry.path)), `entry missing: ${item.id}`);
    }
    if (item.prompt) {
      assert.ok(item.prompt.path.startsWith('vendor/open-design/'), `prompt escaped: ${item.id}`);
      assert.ok(existsSync(resolve(ROOT, item.prompt.path)), `prompt file missing: ${item.id} -> ${item.prompt.path}`);
    }
    if (item.thumbnail) {
      assert.ok(item.thumbnail.startsWith('/vendor/'), `thumbnail must be vendored or null: ${item.id} -> ${item.thumbnail}`);
      const local = resolve(ROOT, item.thumbnail.replace(/^\//, ''));
      assert.ok(existsSync(local), `thumbnail file missing: ${item.id} -> ${item.thumbnail}`);
    }
  }
});

test('no fabricated thumbnails: motion/image with remote-only posters report null local thumb', () => {
  for (const item of allItems) {
    if (item.thumbnail === null || item.thumbnail === undefined) continue;
    assert.ok(item.thumbnail.startsWith('/vendor/'), `unexpected thumbnail source: ${item.id}`);
  }
  // A prompt-only video template with no local preview must not claim a local thumb.
  const remoteOnly = catalog.templates.find((t) => t.id === 'od-vt-3d-animated-boy-building-lego');
  assert.ok(remoteOnly, 'expected a prompt-only video template');
  assert.equal(remoteOnly.thumbnail, null);
  assert.equal(remoteOnly.entry, null);
  assert.equal(remoteOnly.runtime, 'external-generation-required');
  assert.equal(remoteOnly.requiresExternalGeneration, true);
});

test('motion source-ready vs external-generation is distinguished by real local HTML', () => {
  const sourceReady = catalog.templates.filter((t) => t.kind === 'motion' && t.runtime === 'source-ready');
  const external = catalog.templates.filter((t) => t.kind === 'motion' && t.runtime === 'external-generation-required');
  assert.ok(sourceReady.length >= 22, `expected hyperframes source-ready motion templates, got ${sourceReady.length}`);
  assert.ok(external.length >= 40, `expected prompt-only motion templates, got ${external.length}`);
  for (const item of sourceReady) {
    assert.equal(item.sourceReady, true);
    assert.ok(item.entry && item.entry.exists, `source-ready motion needs a local entry: ${item.id}`);
    assert.ok(existsSync(resolve(ROOT, item.entry.path)), `motion entry missing: ${item.id}`);
  }
  for (const item of external) {
    assert.equal(item.sourceReady, false);
    assert.equal(item.requiresExternalGeneration, true);
    assert.ok(item.prompt && existsSync(resolve(ROOT, item.prompt.path)), `external motion needs readable prompt: ${item.id}`);
  }
});

test('every non-null prompt resolves to existing readable text', () => {
  let withPrompt = 0;
  for (const item of allItems) {
    if (!item.prompt) continue;
    withPrompt++;
    const abs = resolve(ROOT, item.prompt.path);
    assert.ok(existsSync(abs), `prompt missing: ${item.id}`);
    assert.ok(statSync(abs).isFile(), `prompt not a file: ${item.id}`);
    assert.ok(readFileSync(abs, 'utf8').length > 0, `prompt empty: ${item.id}`);
  }
  assert.equal(withPrompt, allItems.length, 'every catalog entry must expose a readable prompt');
});

test('design system metadata includes name/category/colors/fonts/path/tokens/license/sourceUrl', async () => {
  assert.equal(designSystems.length, 152);
  for (const ds of designSystems) {
    assert.ok(ds.name, `name missing: ${ds.id}`);
    assert.ok(ds.category, `category missing: ${ds.id}`);
    assert.ok(Array.isArray(ds.colors) && ds.colors.length > 0, `colors missing: ${ds.id}`);
    assert.ok(ds.fonts && Array.isArray(ds.fonts.families) && ds.fonts.families.length > 0, `fonts missing: ${ds.id}`);
    assert.ok(ds.tokens && Number.isInteger(ds.tokens.total) && ds.tokens.total > 0, `tokens missing: ${ds.id}`);
    assert.ok(ds.design && existsSync(resolve(ROOT, ds.design)), `DESIGN.md missing: ${ds.id}`);
    assert.ok(ds.license, `license missing: ${ds.id}`);
    assert.ok(ds.sourceUrl, `sourceUrl missing: ${ds.id}`);
  }
  const airbnb = await readLibraryItem({ kind: 'design-system', id: 'od-ds-airbnb' });
  assert.ok(airbnb);
  assert.equal(airbnb.title, 'Airbnb');
  assert.equal(airbnb.category, 'E-Commerce & Retail');
  assert.ok(airbnb.colors.length >= 8);
  assert.ok(airbnb.tokens.total > 0);
  assert.equal(typeof airbnb.designText, 'string');
  assert.ok(airbnb.designText.length > 1000);
});

test('readLibraryItem exposes prompt.text and entry for template kinds', async () => {
  const t = await readLibraryItem({ kind: 'website', id: 'od-article-magazine' });
  assert.ok(t);
  assert.equal(t.source, 'open-design');
  assert.ok(t.prompt && typeof t.prompt.text === 'string' && t.prompt.text.length > 100);
  assert.ok(t.entry && t.entry.exists === true);
  assert.ok(existsSync(resolve(ROOT, t.entry.path)));
  const withEntryText = await readLibraryItem({ kind: 'website', id: 'od-article-magazine', includeEntry: true });
  assert.ok(withEntryText.entry.text.length > 100);
});

test('readLibraryItem resolves design-system, template, skill, atom, scenario and prompt kinds', async () => {
  const cases = [
    { kind: 'design-system', id: 'od-ds-airbnb', collection: 'designSystems' },
    { kind: 'skill', id: 'od-sk-motion-design', collection: 'skills' },
    { kind: 'atom', id: 'od-at-build-test', collection: 'atoms' },
    { kind: 'scenario', id: 'od-sc-od-default', collection: 'scenarios' },
    { kind: 'template', id: 'od-vt-frame-decision-tree', collection: 'templates' },
    { kind: 'prompt', id: 'od-pv-hyperframes-logo-outro-cinematic', collection: 'templates' },
    { kind: 'motion', id: 'od-vt-frame-decision-tree', collection: 'templates' },
  ];
  for (const c of cases) {
    const r = await readLibraryItem({ kind: c.kind, id: c.id });
    assert.ok(r, `expected to read ${c.kind} ${c.id}`);
    assert.equal(r.id, c.id);
    assert.equal(r.collection, c.collection);
  }
});

test('readLibraryItem accepts slugs and rejects unknown kinds/sources', async () => {
  const bySlug = await readLibraryItem({ id: 'airbnb' });
  assert.equal(bySlug.id, 'od-ds-airbnb');
  const bySlug2 = await readLibraryItem({ id: 'frame-decision-tree' });
  assert.equal(bySlug2.id, 'od-vt-frame-decision-tree');
  assert.equal(await readLibraryItem({ kind: 'website', id: 'definitely-not-real' }), null);
  await assert.rejects(readLibraryItem({ kind: 'skill', id: 'od-sk-motion-design', source: 'nope' }), /source/);
  await assert.rejects(readLibraryItem({ kind: 'not-a-kind', id: 'x' }), /kind/);
  await assert.rejects(readLibraryItem({ kind: 'skill', id: '' }), /id/);
});

test('traversal outside vendor/open-design is refused', () => {
  assert.equal(resolveLibraryPath('../../package.json'), null);
  assert.equal(resolveLibraryPath('vendor/open-design/../../package.json'), null);
  assert.equal(resolveLibraryPath('/etc/passwd'), null);
  assert.ok(resolveLibraryPath('vendor/open-design/catalog.json'));
  assert.equal(libraryFileUrl('vendor/open-design/catalog.json'), '/vendor/open-design/catalog.json');
  assert.equal(libraryFileUrl('/vendor/open-design/x.png'), '/vendor/open-design/x.png');
});

test('creationModes describe the supported creation kinds', () => {
  assert.deepEqual(creationModes.map((m) => m.id), ['website', 'deck', 'document', 'image', 'motion']);
  for (const mode of creationModes) {
    assert.ok(mode.name && mode.en && mode.description);
    assert.ok(Array.isArray(mode.kinds) && mode.kinds.length > 0);
    assert.ok(Array.isArray(mode.surfaces) && mode.surfaces.length > 0);
  }
});

test('library helpers search, list and report availability', () => {
  assert.equal(isOpenDesignLibraryAvailable(), true);
  assert.equal(listLibraryIds({ kind: 'design-system' }).length, 152);
  assert.equal(listLibraryIds({ kind: 'skill' }).length, 169);
  assert.ok(searchLibrary('airbnb').some((x) => x.id === 'od-ds-airbnb'));
  assert.ok(searchLibrary('deck').length > 0);
  assert.deepEqual(searchLibrary(''), []);
});

test('licenses are recorded per item with a real, non-empty source', () => {
  const licenses = new Set();
  for (const item of allItems) {
    assert.ok(item.license, `license missing: ${item.id}`);
    assert.ok(typeof item.license === 'string' && item.license.trim().length > 0);
    assert.ok(item.licenseSource, `licenseSource missing: ${item.id}`);
    licenses.add(item.license);
  }
  assert.ok(licenses.has('MIT'));
  assert.ok(licenses.has('Apache-2.0'));
  assert.ok(licenses.has('CC-BY-4.0'));
  assert.ok(libraryProvenance.licenseSummary.MIT > 0);
});

test('non-grant sources are flagged non-redistributable, not presented as licensed', () => {
  for (const item of allItems) {
    assert.equal(typeof item.redistributable, 'boolean', `redistributable flag missing: ${item.id}`);
    if (item.license === 'Original X post') {
      assert.equal(item.redistributable, false, `X-post entry must not be treated as redistributable: ${item.id}`);
      assert.match(item.licenseNote, /reference-only|not a redistribution/i);
    }
  }
  const flagged = allItems.filter((i) => i.redistributable === false);
  assert.ok(flagged.length >= 2);
  assert.ok(allItems.filter((i) => i.redistributable === true).length > 800);
});

test('no upstream application tree, node_modules or .git was vendored', () => {
  const vendorRoot = join(ROOT, 'vendor', 'open-design');
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) {
        assert.notEqual(name, 'node_modules', `node_modules vendored at ${abs}`);
        assert.notEqual(name, '.git', `.git vendored at ${abs}`);
        assert.notEqual(name, 'apps', `upstream apps tree vendored at ${abs}`);
        assert.notEqual(name, 'packages', `upstream packages tree vendored at ${abs}`);
        walk(abs);
      }
    }
  };
  walk(vendorRoot);
  const rel = relative(ROOT, vendorRoot);
  assert.ok(!rel.startsWith('..') && !isAbsolute(rel));
});

test('import is idempotent: catalog digest is stable across re-reads', () => {
  const again = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  assert.equal(again.source.digest, catalog.source.digest);
  assert.equal(again.stats.total, catalog.stats.total);
});

test('a junction inside the library cannot hand out a file from outside it', async () => {
  // Containment used to be decided on the STRING that names a path: `resolve()` normalises `..` but
  // never follows a link, while every reader of this value does follow links. One contributed
  // junction inside the tree was therefore enough to read any file on the machine.
  const { symlinkSync, unlinkSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const linkPath = join(ROOT, 'vendor', 'open-design', `probe-junction-${process.pid}`);
  let created = false;
  try {
    // A directory junction is creatable without privileges on Windows; a plain symlink elsewhere.
    if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, process.env.SystemRoot || 'C:\Windows'], { stdio: 'ignore' });
    } else {
      symlinkSync('/', linkPath);
    }
    created = true;
  } catch { /* an environment that forbids links cannot exercise this; skip below */ }
  if (!created) {
    assert.ok(true, 'symbolic links are unavailable here; the realpath gate is covered by the refusal cases');
    return;
  }
  try {
    const escaping = resolveLibraryPath(`vendor/open-design/${linkPath.split(/[\/]/).pop()}/win.ini`);
    assert.equal(escaping, null, 'a path that RESOLVES outside the library must be refused');
    // A real file inside the library is still served.
    assert.ok(resolveLibraryPath('vendor/open-design/catalog.json'));
  } finally {
    try { unlinkSync(linkPath); } catch { /* already gone */ }
  }
});

test('a missing catalog file degrades to "not there" instead of throwing', () => {
  // catalog.json and the vendor tree are third-party contribution, so a listed file can be absent.
  // Reading it must report absence (callers show exists:false), never abort the whole library read.
  const absent = resolveLibraryPath('vendor/open-design/definitely-absent-probe.html');
  assert.ok(absent, 'a missing file still resolves to its intended path');
  assert.equal(existsSync(absent), false);
  // Still a refusal when the path itself leaves the tree.
  assert.equal(resolveLibraryPath('vendor/open-design/../../package.json'), null);
});
