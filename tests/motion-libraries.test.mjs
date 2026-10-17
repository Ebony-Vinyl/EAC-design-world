import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importMotionLibrary } from '../scripts/import-motion-libraries.mjs';
import { motionTemplates, motionSkills, readMotionLibraryItem } from '../src/motion-libraries.mjs';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'eac-motion-import-'));
  const source = join(root, 'source');
  const destinationRoot = join(root, 'plugin');
  await mkdir(join(source, 'cases/string-clock'), { recursive: true });
  await writeFile(join(source, 'LICENSE'), 'CC BY-NC 4.0');
  await writeFile(join(source, 'SKILL.md'), '# Motion Web');
  await writeFile(join(source, 'cases/string-clock/index.html'), '<html>clock</html>');
  await writeFile(join(source, 'cases/string-clock/README.md'), 'clock guide');
  await mkdir(join(source, '.git'), { recursive: true });
  await writeFile(join(source, '.git/private'), 'do not copy');
  try { await run({ root, source, destinationRoot }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('optional imports require an explicit license acknowledgement', () => fixture(async args => {
  await assert.rejects(importMotionLibrary({ ...args, library: 'motion-web' }), /noncommercial|licensed/);
  assert.deepEqual(motionTemplates({ root: args.destinationRoot }), []);
}));

test('import preserves provenance and actual source, does not copy git or overwrite', () => fixture(async args => {
  const result = await importMotionLibrary({ ...args, library: 'motion-web', usage: 'noncommercial' });
  assert.equal(result.library, 'motion-web');
  assert.match(result.digest, /^sha256:[a-f0-9]{64}$/);
  await assert.rejects(readFile(join(args.destinationRoot, 'vendor/motion-web/.git/private')), /ENOENT/);
  const items = motionTemplates({ root: args.destinationRoot });
  assert.equal(items.length, 1);
  assert.equal(items[0].renderable, false, 'interactive pages must not masquerade as seekable films');
  assert.equal(items[0].previewMode, 'interactive');
  assert.equal(motionSkills({ root: args.destinationRoot }).length, 1);
  const read = await readMotionLibraryItem({ kind: 'template', id: items[0].id, includeEntry: true, root: args.destinationRoot });
  assert.equal(read.entry.text, '<html>clock</html>');
  assert.equal(read.content, 'clock guide');
  await assert.rejects(importMotionLibrary({ ...args, library: 'motion-web', usage: 'noncommercial' }), /存在|exists/);
}));

test('authoring references are readable without allowing paths outside the imported source', () => fixture(async args => {
  await mkdir(join(args.source, 'references'));
  await writeFile(join(args.source, 'references/handfeel.md'), 'Spring and pointer guidance');
  await importMotionLibrary({ ...args, library: 'motion-web', usage: 'noncommercial' });
  const guide = await readMotionLibraryItem({ kind: 'skill', id: 'motion-web-skill', root: args.destinationRoot });
  assert.ok(guide.resources.includes('references/handfeel.md'));
  const resource = await readMotionLibraryItem({ kind: 'skill', id: guide.id, root: args.destinationRoot, resource: 'references/handfeel.md' });
  assert.equal(resource.resource.text, 'Spring and pointer guidance');
  await assert.rejects(readMotionLibraryItem({ kind: 'skill', id: guide.id, root: args.destinationRoot, resource: '../../source/SKILL.md' }), /路径|资源/);
}));

test('incomplete source never leaves a registered destination', () => fixture(async args => {
  await rm(join(args.source, 'LICENSE'));
  await assert.rejects(importMotionLibrary({ ...args, library: 'motion-web', usage: 'noncommercial' }), /LICENSE/);
  assert.deepEqual(motionTemplates({ root: args.destinationRoot }), []);
}));
