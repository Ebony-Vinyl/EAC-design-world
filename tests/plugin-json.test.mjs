import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../src/engine.mjs';
import { createToolRegistrations } from '../plugin/host.mjs';
import { toLosslessJson, isLosslessJson, LosslessJsonError } from '../src/lossless-json.mjs';
import { toolDefinitions } from '../src/tools.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 可选 Motion Web / Onetake 库的注册条件与 src/motion-libraries.mjs 相同：对应源文件存在。
// 用同一判据先判断「有没有导入」，而不是把任何 ENOENT 都当作未导入——已导入但内容损坏时
// 后面的读取断言必须真的失败。
const optionalLibrary = (path) => existsSync(resolve(ROOT, path));

// Walk a value and report every path holding `undefined` (JSON.stringify would
// silently drop object fields and coerce array holes to null).
function undefinedPaths(value, path = '$', found = []) {
  if (value === undefined) { found.push(path); return found; }
  if (Array.isArray(value)) {
    value.forEach((item, index) => undefinedPaths(item, `${path}[${index}]`, found));
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) undefinedPaths(value[key], `${path}.${key}`, found);
  }
  return found;
}

// Assert a value is already a lossless plain-JSON value: exact round trip,
// no undefined anywhere, and no exotic leaves.
function assertLossless(value, label) {
  assert.deepEqual(undefinedPaths(value), [], `${label} must not contain undefined`);
  const encoded = JSON.stringify(value);
  assert.notEqual(encoded, undefined, `${label} must be JSON-serializable`);
  const parsed = JSON.parse(encoded);
  assert.equal(JSON.stringify(parsed), encoded, `${label} must round-trip losslessly`);
  assert.equal(isLosslessJson(value), true, `${label} must be lossless JSON`);
}

async function withEngine(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'eac-plugin-json-'));
  const engine = await createEngine({ dataDir: directory });
  try { return await fn(engine, directory); }
  finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
}

function toolFor(engine, name) {
  return createToolRegistrations(engine, toolDefinitions).find(tool => tool.name === name);
}

test('real engine library_list and library_read outputs are lossless plain JSON for every category', async (t) => {
  await withEngine(async (engine) => {
    const list = toolFor(engine, 'eac_library_list');
    const read = toolFor(engine, 'eac_library_read');

    for (const kind of [undefined, 'template', 'design-system', 'skill', 'atom', 'scenario',
      'motion', 'website', 'deck', 'document', 'image', 'prompt']) {
      const args = kind === undefined ? { limit: 200 } : { kind, limit: 200 };
      const result = await list.execute(args, { signal: new AbortController().signal });
      assertLossless(result, `library_list ${JSON.stringify(args)}`);
      assert.ok(Array.isArray(result.items) && result.items.length > 0, `library_list ${kind} returns items`);
      assert.equal(typeof result.total, 'number');
      for (const item of result.items) {
        assert.equal(typeof item.id, 'string');
        assert.equal(typeof item.kind, 'string');
        // renderable must never be an undefined own property.
        assert.notEqual(Object.hasOwn(item, 'renderable') && item.renderable === undefined, true);
        assert.ok(Array.isArray(item.requirements));
      }
      const rendered = list.output.render(args, result);
      assert.equal(rendered[0].type, 'text');
      assert.deepEqual(JSON.parse(rendered[0].text), result);
    }

    // Built-in catalog template read (source and prompt modes).
    const builtinPrompt = await read.execute({ kind: 'template', id: '05-cel-boil' }, { signal: new AbortController().signal });
    assertLossless(builtinPrompt, 'library_read 05-cel-boil prompt');
    assert.equal(builtinPrompt.id, '05-cel-boil');
    assert.match(builtinPrompt.content, /\S/);
    assert.equal(builtinPrompt.entry.path, 'vendor/mg-styles-15/demos/05-cel-boil/index.html');
    assert.equal(Object.hasOwn(builtinPrompt.entry, 'text'), false);

    const builtinSource = await read.execute({ kind: 'template', id: '05-cel-boil', source: true }, { signal: new AbortController().signal });
    assertLossless(builtinSource, 'library_read 05-cel-boil source');
    assert.match(builtinSource.entry.text, /<html|<!doctype/i);

    // Optional Motion Web / Onetake skill entries must not carry undefined `entry`/`resource`.
    // 未导入的库显式跳过并在测试输出里留痕；已导入的库读取失败仍然失败。
    for (const [id, marker] of [['motion-web-skill', 'vendor/motion-web/SKILL.md'], ['onetake-skill', 'vendor/onetake/SKILL.md']]) {
      if (!optionalLibrary(marker)) {
        t.diagnostic(`可选库未导入（缺 ${marker}），跳过 skill/${id}`);
        continue;
      }
      for (const source of [false, true]) {
        const skill = await read.execute({ kind: 'skill', id, source }, { signal: new AbortController().signal });
        assertLossless(skill, `library_read ${id} source=${source}`);
        assert.equal(skill.id, id);
        assert.equal(typeof skill.content, 'string');
        assert.match(skill.content, /\S/);
        assert.equal(Object.hasOwn(skill, 'entry'), false, `${id} must omit entry`);
        assert.equal(Object.hasOwn(skill, 'resource'), false, `${id} must omit resource`);
      }
    }

    // Optional motion templates expose a real entry and resources list. The shared
    // library_read schema only enumerates template/design-system/skill/atom/scenario/prompt,
    // so optional motion entries are read through the engine's 'template' kind (which the
    // engine treats identically for mw-* / onetake-studio).
    for (const [id, marker] of [['mw-string-clock', 'vendor/motion-web/cases/string-clock/index.html'], ['onetake-studio', 'vendor/onetake/SKILL.md']]) {
      if (!optionalLibrary(marker)) {
        t.diagnostic(`可选库未导入（缺 ${marker}），跳过 template/${id}`);
        continue;
      }
      const item = await read.execute({ kind: 'template', id, source: true }, { signal: new AbortController().signal });
      assertLossless(item, `library_read ${id}`);
      assert.equal(item.id, id);
      assert.ok(Array.isArray(item.resources) && item.resources.length > 0);
      assert.equal(typeof item.entry.path, 'string');
      assert.match(item.entry.text, /<html|<!doctype/i);
    }

    // Engine-level motion read (outside the host schema enum) must also be lossless.
    if (optionalLibrary('vendor/motion-web/cases/string-clock/index.html')) {
      const motionEngine = await engine.handle('library_read', { kind: 'motion', id: 'mw-string-clock', source: true });
      assertLossless(motionEngine, 'engine library_read motion');
      assert.equal(motionEngine.id, 'mw-string-clock');
    } else {
      t.diagnostic('可选库未导入，跳过 motion/mw-string-clock 的 engine 级读取');
    }

    const status = await toolFor(engine, 'eac_status').execute({}, { signal: new AbortController().signal });
    assertLossless(status, 'status');
    assert.ok(Array.isArray(status.capabilities));
    assert.ok(Array.isArray(status.templates));
  });
});

test('host boundary omits undefined object fields while preserving real values and structure', () => {
  const input = {
    id: 'x', optional: undefined, nested: { keep: 1, drop: undefined, deep: { also: undefined, value: 'ok' } },
    list: [1, { a: undefined, b: 2 }], empty: {}, flag: false, zero: 0, nil: null,
  };
  const normalized = toLosslessJson(input);
  assert.deepEqual(normalized, {
    id: 'x', nested: { keep: 1, deep: { value: 'ok' } }, list: [1, { b: 2 }], empty: {}, flag: false, zero: 0, nil: null,
  });
  assert.deepEqual(undefinedPaths(normalized), []);
  assert.equal(isLosslessJson(normalized), true);
  // Values, not identity, are preserved; rich nested data survives.
  assert.equal(input.nested.keep, 1);
  assert.equal(normalized.list[0], 1);
});

test('host boundary preserves shared references but rejects cycles instead of truncating', () => {
  const shared = { v: 1 };
  const normalized = toLosslessJson({ a: shared, b: shared });
  assert.deepEqual(normalized, { a: { v: 1 }, b: { v: 1 } });

  const cyclic = { name: 'loop' };
  cyclic.self = cyclic;
  assert.throws(() => toLosslessJson(cyclic), (error) => error instanceof LosslessJsonError
    && error.code === 'EAC_LOSSLESS_JSON' && /cyclic/.test(error.message));

  const deep = {}; let cursor = deep;
  for (let i = 0; i < 300; i++) { cursor.next = {}; cursor = cursor.next; }
  assert.throws(() => toLosslessJson(deep), /depth/);
});

test('host boundary rejects unsupported leaves rather than silently fabricating loss', () => {
  const cases = [
    [undefined, /undefined/],
    [{ list: [1, undefined, 3] }, /undefined/],
    [NaN, /non-finite/],
    [Infinity, /non-finite/],
    [-Infinity, /non-finite/],
    [-0, /negative zero/],
    [10n, /bigint/],
    [{ big: 9007199254740993n }, /bigint/],
    [() => {}, /function/],
    [Symbol('s'), /symbol/],
    [new Date(), /Date instance/],
    [new Map(), /Map instance/],
    [new Set([1]), /Set instance/],
  ];
  for (const [value, pattern] of cases) {
    assert.throws(() => toLosslessJson(value), (error) => error instanceof LosslessJsonError
      && error.code === 'EAC_LOSSLESS_JSON' && pattern.test(error.message), `expected rejection for ${String(value)}`);
    assert.equal(isLosslessJson(value), false);
  }
  // An object whose only undefined fields are omitted is normalized, not rejected.
  assert.deepEqual(toLosslessJson({ a: undefined, b: 1 }), { b: 1 });
  // undefined nested in an array is the classic hole JSON would coerce to null.
  assert.throws(() => toLosslessJson({ rows: [{ id: 'a' }, undefined] }), /undefined/);
  // A real sparse array hole (no own index) must be rejected, not emitted as null.
  const sparse = [1, , 3];
  assert.equal(Object.hasOwn(sparse, 1), false);
  assert.throws(() => toLosslessJson(sparse), (error) => error instanceof LosslessJsonError
    && error.code === 'EAC_LOSSLESS_JSON' && /sparse array hole/.test(error.message) && error.path === '$[1]');
  assert.equal(isLosslessJson(sparse), false);
});

test('host boundary preserves an own "__proto__" key without polluting the prototype', () => {
  // JSON.parse produces a genuine own "__proto__" data property; a plain
  // `output[key] = value` would hit the setter, mutate the prototype and drop it.
  const parsed = JSON.parse('{"__proto__":{"polluted":true},"ok":1,"__proto__x":2}');
  assert.equal(Object.hasOwn(parsed, '__proto__'), true);
  const normalized = toLosslessJson(parsed);
  assert.equal(Object.hasOwn(normalized, '__proto__'), true);
  assert.deepEqual(normalized.__proto__, { polluted: true });
  assert.equal(normalized.ok, 1);
  assert.equal(normalized.__proto__x, 2);
  assert.equal(Object.getPrototypeOf(normalized), Object.prototype);
  assert.equal({}.polluted, undefined, 'global Object.prototype must not be polluted');
  assert.equal(JSON.stringify(normalized), JSON.stringify(parsed), 'own __proto__ key round-trips');
  assert.equal(isLosslessJson(normalized), true);
});

test('normalized engine output is accepted even when the raw result is not lossless', async () => {
  const engine = {
    handle: async () => ({ id: 'od-x', entry: undefined, nested: { keep: 1, gone: undefined }, rows: [1, 2] }),
  };
  const tool = toolFor(engine, 'eac_library_read');
  const result = await tool.execute({ kind: 'skill', id: 'x' }, { signal: new AbortController().signal });
  assert.deepEqual(result, { id: 'od-x', nested: { keep: 1 }, rows: [1, 2] });
  assertLossless(result, 'normalized fake engine output');
});

test('a genuinely invalid engine result fails the tool instead of being stringified away', async () => {
  for (const [label, invalid] of [
    ['array undefined', { items: [undefined] }],
    ['bigint', { count: 2n }],
    ['cyclic', (() => { const o = {}; o.self = o; return o; })()],
    ['non-finite', { ratio: NaN }],
  ]) {
    const tool = toolFor({ handle: async () => invalid }, 'eac_status');
    await assert.rejects(tool.execute({}, { signal: new AbortController().signal }),
      (error) => error.code === 'EAC_INVALID_OUTPUT' && /EAC tool status returned invalid output/.test(error.message),
      label);
  }
});

test('real engine errors still propagate untouched through the boundary', async () => {
  const tool = toolFor({ handle: async () => { const error = new Error('库条目不存在：skill/missing'); error.code = 'ENOENT'; throw error; } }, 'eac_library_read');
  await assert.rejects(tool.execute({ kind: 'skill', id: 'missing' }, { signal: new AbortController().signal }),
    (error) => error.code === 'ENOENT' && error.message === '库条目不存在：skill/missing');

  // A non-normalization failure inside the boundary must not be masked either.
  const internal = new Error('engine exploded');
  const tool2 = toolFor({ handle: async () => { throw internal; } }, 'eac_status');
  await assert.rejects(tool2.execute({}, { signal: new AbortController().signal }), (error) => error === internal);
});

test('argument schema validation and cancellation semantics are unchanged by the boundary', async () => {
  const calls = [];
  const engine = { handle: async (...args) => { calls.push(args); return { ok: true }; } };
  const tool = toolFor(engine, 'eac_project_create');
  const signal = new AbortController().signal;

  await assert.rejects(tool.execute({}, { signal }), { code: 'INVALID_ARGS' });
  await assert.rejects(tool.execute({ title: 7 }, { signal }), { code: 'INVALID_ARGS' });
  await assert.rejects(tool.execute({ title: 'x', unexpected: true }, { signal }), { code: 'INVALID_ARGS' });
  assert.equal(calls.length, 0, 'invalid args must never reach the engine');

  const cancellation = new AbortController();
  cancellation.abort();
  await assert.rejects(tool.execute({ title: 'x' }, { signal: cancellation.signal }), { name: 'AbortError' });
  assert.equal(calls.length, 0, 'aborted calls must never reach the engine');

  const result = await tool.execute({ title: 'Valid' }, { signal });
  assert.deepEqual(calls, [['project_create', { title: 'Valid' }]]);
  assert.deepEqual(result, { ok: true });
});
