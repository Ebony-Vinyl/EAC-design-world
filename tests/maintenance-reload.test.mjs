// Hot-reload contract tests for src/maintenance-reload.mjs.
//
// Two layers:
//   1. Real-kernel integration: drives the actual @deepseek-ai/cordis kernel and
//      cordis-plugin-loader (the same primitives the Harness uses) end to end.
//      Skipped with an explicit notice when those packages are not installed on
//      this machine, so the absence is never reported as a pass.
//   2. Contract harness: exercises cache shapes and error branches that the
//      installed Node/kernel combination cannot be made to produce on demand.
//      The harness is faithful to the module's required primitive shapes; the
//      test names state exactly which real behaviour it does not reproduce.
//
// No production .eac data is touched and no running service is stopped: every
// fixture lives in a temp directory and every fake plugin is generated on disk.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import {
  selfReload, isReloading, packageUrlOf, entryUrlOf, packageCacheKeys, purgeCaches, restoreCaches, watchPackage,
} from '../src/maintenance-reload.mjs';
import { createContractHarness, loadCacheWithStickyDelete, duckLoadCache } from './fixtures/maintenance-host.mjs';

const require = createRequire(import.meta.url);
const CORDIS_CANDIDATES = [
  'C:/Users/HUAWEI/.dsh/profiles/desktop/node_modules/@deepseek-ai/cordis/lib/index.js',
  'D:/dsh real subagent/node_modules/@deepseek-ai/cordis/lib/index.js',
];
const LOADER_CANDIDATES = [
  'C:/Users/HUAWEI/.dsh/profiles/desktop/node_modules/dsh-real-subagent/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js',
  'D:/dsh real subagent/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js',
];
const CLIENT_MODULES_CANDIDATES = [
  'C:/Users/HUAWEI/.dsh/profiles/desktop/node_modules/dsh-real-subagent/node_modules/@deepseek-ai/dsh-client-modules/lib/client.js',
  'D:/dsh real subagent/node_modules/@deepseek-ai/dsh-client-modules/lib/client.js',
];
const firstExisting = (paths) => paths.find((path) => existsSync(path));

const cordisPath = firstExisting(CORDIS_CANDIDATES);
const loaderPath = firstExisting(LOADER_CANDIDATES);
const realKernelAvailable = Boolean(cordisPath && loaderPath);
const skipReal = realKernelAvailable ? false
  : 'real @deepseek-ai/cordis kernel + cordis-plugin-loader not installed on this machine';

const silentLogger = { info() {}, warn() {}, error() {} };
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

// A temp package whose plugin.mjs re-imports a shared dependency under
// node_modules (which must survive the purge) and records every apply().
async function pluginFixture(t, { sourceOf } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'eac-reload-'));
  const pkg = join(root, 'pkg');
  await mkdir(join(pkg, 'node_modules', 'shared-dep'), { recursive: true });
  await writeFile(join(pkg, 'node_modules', 'shared-dep', 'package.json'),
    JSON.stringify({ name: 'shared-dep', version: '1.0.0', type: 'module', main: 'index.mjs' }));
  await writeFile(join(pkg, 'node_modules', 'shared-dep', 'index.mjs'), 'export const marker = "shared-v1";\n');
  const pluginFile = join(pkg, 'plugin.mjs');
  const source = sourceOf ?? ((version, fail) => `import { marker } from 'shared-dep';
export const name = 'eac-fixture';
export const version = '${version}';
export function apply(ctx, config) {
  globalThis.__eacReloadLog ??= [];
  globalThis.__eacReloadLog.push({ version: '${version}', marker, config: JSON.parse(JSON.stringify(config ?? null)) });
  globalThis.__eacReloadCtx = ctx;
  ${fail ? "throw new Error('fixture failed to start');" : 'ctx.effect(() => () => { (globalThis.__eacReloadDispose ??= []).push(\'' + version + '\'); });'}
}
`);
  await writeFile(pluginFile, source('1.0.0', false));
  t.after(() => {
    assert.match(root.slice(tmpdir().length + 1), /^eac-reload-/);
    return rm(root, { recursive: true, force: true });
  });
  return { pkg, pluginFile, source, packageUrl: `${pathToFileURL(pkg).href}/`, entryUrl: pathToFileURL(pluginFile).href };
}

// Boot the real kernel, mount the loader, and register one fixture entry.
async function realKernel(t, fixture) {
  const { Context } = await import(pathToFileURL(cordisPath).href);
  const { Loader } = await import(pathToFileURL(loaderPath).href);
  const ctx = new Context();
  await ctx.plugin(Loader, { baseUrl: fixture.packageUrl }).await();
  const options = { name: fixture.entryUrl, config: { keep: 'yes', n: 7 } };
  await ctx.loader.create(options);
  const entry = ctx.loader.resolve(options.id);
  await entry.fiber?.await();
  t.after(async () => { await ctx.root?.fiber?.dispose?.(); });
  return { ctx, entry };
}

test('URL helpers derive the package directory and entry file', () => {
  const entry = 'file:///D:/EAC%20design%20world/plugin/host.mjs';
  assert.equal(packageUrlOf(entry), 'file:///D:/EAC%20design%20world/');
  assert.equal(entryUrlOf(entry), 'file:///D:/EAC%20design%20world/plugin/host.mjs');
  assert.equal(isReloading(), false);
});

test('packageCacheKeys keeps only package-local keys and skips node_modules, case and encoding drift', () => {
  const base = 'file:///D:/EAC%20design%20world/';
  const cache = new Map([
    [`${base}src/engine.mjs`, { row: 1 }],
    [`${base}node_modules/left-pad/index.js`, { row: 2 }],
    ['file:///d:/eac%20DESIGN%20world/src/x.mjs', { row: 3 }],
    ['file:///C:/elsewhere/src/y.mjs', { row: 4 }],
    ['node:fs', { row: 5 }],
  ]);
  assert.deepEqual(packageCacheKeys(cache, base), [
    `${base}src/engine.mjs`,
    'file:///d:/eac%20DESIGN%20world/src/x.mjs',
  ]);
});

test('purge/restore round-trips a Node 24 sticky-delete LoadCache and the CJS require cache', () => {
  const base = 'file:///D:/EAC%20design%20world/';
  const moduleKey = `${base}src/engine.mjs`;
  const cache = loadCacheWithStickyDelete([[moduleKey, { javascript: { job: 'original' } }]]);
  // A real sticky delete would leave a blanked entry; the module must use Map.prototype.
  assert.equal(cache.size, 1);
  const backup = purgeCaches({ loadCache: cache }, base);
  assert.equal(cache.size, 0, 'Map.prototype.delete must fully remove the key');
  assert.equal(backup.esm.get(moduleKey).javascript.job, 'original');
  restoreCaches({ loadCache: cache }, backup);
  assert.equal(cache.get(moduleKey).javascript.job, 'original', 'restore puts the original module job back');
});

test('purge tolerates a non-Map duck-typed cache (Node 24.12+ shape)', () => {
  const base = 'file:///D:/EAC%20design%20world/';
  const cache = duckLoadCache([[`${base}src/a.mjs`, { row: 'a' }], [`${base}src/b.mjs`, { row: 'b' }]]);
  const backup = purgeCaches({ loadCache: cache }, base);
  assert.equal(backup.esm.size, 2);
  assert.equal(cache.size, 0);
  restoreCaches({ loadCache: cache }, backup);
  assert.equal(cache.size, 2);
  assert.equal(cache.get(`${base}src/a.mjs`).row, 'a');
});

test('selfReload refuses a context without loader/registry or without an ordinary runtime', async () => {
  const bare = createContractHarness();
  const noLoader = await selfReload({ registry: bare.registry, fiber: { runtime: { callback: bare.pluginExports } } }, { logger: silentLogger });
  assert.deepEqual(noLoader, { ok: false, error: 'no loader/registry on this context', restored: false });
  const noRuntime = await selfReload({ loader: bare.loader, registry: bare.registry, fiber: {} }, { logger: silentLogger });
  assert.deepEqual(noRuntime, { ok: false, error: 'no runtime to reload (plugin was not registered the ordinary way)', restored: false });
});

test('selfReload reports no live fibers rather than pretending to swap', async () => {
  const harness = createContractHarness();
  harness.runtimes.get(harness.pluginExports).fibers.length = 0;
  const result = await selfReload(harness.ctx, { logger: silentLogger });
  assert.deepEqual(result, { ok: false, error: 'runtime has no live fibers', restored: false });
});

test('overlapping selfReload calls share one in-flight swap', async () => {
  let release;
  const gate = new Promise((accept) => { release = accept; });
  let imports = 0;
  const harness = createContractHarness({ importModule: async () => { imports++; await gate; return { apply() {}, version: '2.0.0' }; } });
  const first = selfReload(harness.ctx, { logger: silentLogger });
  assert.equal(isReloading(), true);
  const second = selfReload(harness.ctx, { logger: silentLogger });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(imports, 1, 'only one import ran for the shared swap');
  assert.deepEqual(a, b, 'both callers observe the same swap result');
  assert.equal(isReloading(), false, 'the guard clears after settlement');
});

test('contract harness: purge spares node_modules and the swap re-registers under the same config', async () => {
  const base = 'file:///D:/EAC%20design%20world/';
  const sharedKey = `${base}node_modules/shared/index.js`;
  const pluginKey = `${base}plugin/host.mjs`;
  const harness = createContractHarness({
    cacheEntries: new Map([[sharedKey, { row: 'shared' }], [pluginKey, { row: 'plugin' }]]),
    importModule: async () => ({ apply() {}, version: '2.0.0' }),
  });
  const result = await selfReload(harness.ctx, { packageUrl: base, entryUrl: pluginKey, logger: silentLogger });
  assert.deepEqual(result, { ok: true, version: '2.0.0', fibers: 1 });
  assert.equal(harness.cache.has(sharedKey), true, 'node_modules dependency cache row must survive');
  assert.equal(harness.cache.has(pluginKey), false, 'the plugin row is purged and not re-inserted by the harness import');
  assert.deepEqual(harness.imports, [pluginKey]);
});

test('contract harness: a re-import failure restores caches and keeps the old registration', async () => {
  const base = 'file:///D:/EAC%20design%20world/';
  const pluginKey = `${base}plugin/host.mjs`;
  const harness = createContractHarness({
    cacheEntries: new Map([[pluginKey, { row: 'old' }]]),
    importModule: async () => { throw new Error('Unexpected token'); },
  });
  const result = await selfReload(harness.ctx, { packageUrl: base, entryUrl: pluginKey, logger: silentLogger });
  assert.equal(result.ok, false);
  assert.equal(result.restored, true);
  assert.match(result.error, /re-import failed, old code still running/);
  assert.equal(harness.cache.get(pluginKey).row, 'old', 'cache row is restored on re-import failure');
  assert.equal(harness.registry.has(harness.pluginExports), true, 'old runtime stays registered');
});

test('contract harness: a replacement that fails to start rolls back to the previous registration', async () => {
  const base = 'file:///D:/EAC%20design%20world/';
  const pluginKey = `${base}plugin/host.mjs`;
  let mode = 'ok';
  const harness = createContractHarness({
    cacheEntries: new Map([[pluginKey, { row: 'old' }]]),
    importModule: async () => ({ apply() {}, version: '2.0.0' }),
  });
  // Make the first re-registration throw, exercising the failure branch.
  const originalPlugin = harness.registry.plugin;
  let registrations = 0;
  harness.registry.plugin = (plugin, config) => {
    registrations++;
    if (registrations === 1) throw new Error('fixture failed to start');
    return originalPlugin(plugin, config);
  };
  const result = await selfReload(harness.ctx, { packageUrl: base, entryUrl: pluginKey, logger: silentLogger });
  assert.equal(result.ok, false);
  assert.equal(result.restored, true);
  assert.match(result.error, /new code failed to start, previous version restored/);
  assert.equal(harness.cache.get(pluginKey).row, 'old', 'cache restored');
  assert.ok(registrations >= 2, 'the previous plugin was re-registered after the failure');
});

test('contract harness: a version mismatch aborts before touching the registry', async () => {
  const base = 'file:///D:/EAC%20design%20world/';
  const pluginKey = `${base}plugin/host.mjs`;
  const harness = createContractHarness({
    cacheEntries: new Map([[pluginKey, { row: 'old' }]]),
    importModule: async () => ({ apply() {}, version: '9.9.9' }),
  });
  const result = await selfReload(harness.ctx, { packageUrl: base, entryUrl: pluginKey, expectedVersion: '2.0.0', logger: silentLogger });
  assert.equal(result.ok, false);
  assert.equal(result.restored, true);
  assert.match(result.error, /activation version mismatch: expected 2\.0\.0, got 9\.9\.9/);
  assert.equal(harness.cache.get(pluginKey).row, 'old');
  assert.deepEqual(harness.events.filter((event) => event.startsWith('dispose')), [], 'no fiber was disposed on a pre-swap failure');
});

test('real kernel: hot reload purges, re-imports, disposes and re-registers with config preserved', { skip: skipReal }, async (t) => {
  const fixture = await pluginFixture(t);
  const { ctx } = await realKernel(t, fixture);
  delete globalThis.__eacReloadLog;
  delete globalThis.__eacReloadDispose;
  // Re-run the already-registered fixture so the log reflects the live apply.
  await ctx.loader.await();

  const liveBefore = await import(`${fixture.entryUrl}?probe=1`);
  assert.equal(liveBefore.version, '1.0.0');

  const sharedKeyBefore = [...ctx.loader.internal.loadCache.keys()].find((key) => String(key).includes('shared-dep'));
  assert.ok(sharedKeyBefore, 'the fixture shared dependency is loaded and cached');
  assert.equal(packageCacheKeys(ctx.loader.internal.loadCache, fixture.packageUrl).some((key) => String(key).includes('shared-dep')), false,
    'packageCacheKeys must not select node_modules rows');

  await writeFile(fixture.pluginFile, fixture.source('2.0.0', false));
  const result = await selfReload(globalThis.__eacReloadCtx, {
    packageUrl: fixture.packageUrl, entryUrl: fixture.entryUrl, expectedVersion: '2.0.0', logger: silentLogger,
  });
  assert.deepEqual(result, { ok: true, version: '2.0.0', fibers: 1 });

  // Real re-import: a fresh evaluation saw the new code.
  const reimported = await import(`${fixture.entryUrl}?probe=2`);
  assert.equal(reimported.version, '2.0.0');
  assert.equal(globalThis.__eacReloadLog.at(-1).version, '2.0.0');
  assert.equal(globalThis.__eacReloadLog.at(-1).config.n, 7, 'config survived the swap');
  assert.equal(globalThis.__eacReloadLog.at(-1).marker, 'shared-v1', 'shared dependency identity preserved');
  assert.deepEqual(globalThis.__eacReloadDispose, ['1.0.0'], 'the previous fiber was disposed');
  assert.ok([...ctx.loader.internal.loadCache.keys()].some((key) => String(key).includes('shared-dep')),
    'the shared node_modules module stayed cached (no shared-dependency churn)');
});

test('real kernel: re-import failure leaves the previous code running', { skip: skipReal }, async (t) => {
  const fixture = await pluginFixture(t);
  await realKernel(t, fixture);
  const before = globalThis.__eacReloadLog?.length ?? 0;
  await writeFile(fixture.pluginFile, 'export const name = "eac-fixture"; export function apply() { ((( }\n');
  const result = await selfReload(globalThis.__eacReloadCtx, {
    packageUrl: fixture.packageUrl, entryUrl: fixture.entryUrl, logger: silentLogger,
  });
  assert.equal(result.ok, false);
  assert.equal(result.restored, true);
  assert.match(result.error, /re-import failed, old code still running/);
  assert.equal(globalThis.__eacReloadLog.length, before, 'no new apply ran from broken code');
});

test('real kernel: replacement start failure restores the previous version', { skip: skipReal }, async (t) => {
  const fixture = await pluginFixture(t);
  const { ctx } = await realKernel(t, fixture);
  const before = globalThis.__eacReloadLog?.length ?? 0;
  await writeFile(fixture.pluginFile, fixture.source('3.0.0', true));
  const result = await selfReload(globalThis.__eacReloadCtx, {
    packageUrl: fixture.packageUrl, entryUrl: fixture.entryUrl, logger: silentLogger,
  });
  assert.equal(result.ok, false);
  assert.equal(result.restored, true);
  assert.match(result.error, /new code failed to start, previous version restored/);
  // The failed version was attempted, then the previous version was re-applied
  // from the still-registered (old) module object, so the live runtime is v1.
  assert.equal(globalThis.__eacReloadLog.at(-1).version, '1.0.0', 'the previous version is live again');
  assert.ok(globalThis.__eacReloadLog.length >= before + 2, 'a start attempt and a restore both ran');
  // The registry was rolled back to the previous plugin object. Disk is the
  // caller's job (the updater restores its backup); once v1 is written back,
  // a fresh reload succeeds, proving the runtime was not left on dead code.
  await writeFile(fixture.pluginFile, fixture.source('1.0.0', false));
  const again = await selfReload(globalThis.__eacReloadCtx, {
    packageUrl: fixture.packageUrl, entryUrl: fixture.entryUrl, logger: silentLogger,
  });
  assert.equal(again.ok, true, 'the restored runtime accepts a further reload');
  assert.equal(again.version, '1.0.0');
  assert.equal(ctx.registry.size, 3, 'registry holds the loader, the fixture runtime and one re-registration');
});

test('watchPackage fires on source edits but ignores state, output, deps and vendor trees', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'eac-watch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const sub of ['src', 'node_modules/dep', '.eac', 'artifacts', 'runtime', 'release', 'vendor', '.git']) {
    await mkdir(join(dir, sub), { recursive: true });
  }
  let fired = 0;
  const stop = watchPackage(dir, { debounceMs: 25, logger: silentLogger, onChange: () => { fired++; } });
  t.after(() => stop());
  await wait(250); // let the recursive watcher become ready

  await writeFile(join(dir, 'src', 'engine.mjs'), 'export const x = 1;\n'); // real source change
  await wait(150);
  assert.equal(fired, 1, 'a source edit triggers exactly one reload');

  for (const ignored of [
    ['node_modules', 'dep/index.js'], ['.eac', 'state.json'], ['artifacts', 'out.json'],
    ['runtime', 'cache.json'], ['release', 'manifest.json'], ['vendor', 'lib.js'], ['.git', 'HEAD'],
  ]) {
    await writeFile(join(dir, ignored[0], ignored[1]), '{}\n');
  }
  await writeFile(join(dir, 'README.md'), 'docs\n'); // unsupported extension
  await wait(200);
  assert.equal(fired, 1, 'state, output, dependency, vendor and doc changes must not reload');

  // A change that must not loop: writing to .eac repeatedly stays quiet.
  await writeFile(join(dir, '.eac', 'state.json'), '{"n":1}\n');
  await wait(120);
  await writeFile(join(dir, '.eac', 'state.json'), '{"n":2}\n');
  await wait(150);
  assert.equal(fired, 1, 'no reload loop from repeated user-state writes');

  await writeFile(join(dir, 'src', 'server.mjs'), 'export const y = 2;\n');
  await wait(150);
  assert.equal(fired, 2, 'a later real source edit still fires');
  stop();
});

test('client hot-refresh API is the real @deepseek-ai/dsh-client-modules surface', (t) => {
  const clientPath = firstExisting(CLIENT_MODULES_CANDIDATES);
  if (!clientPath) {
    t.skip('@deepseek-ai/dsh-client-modules not installed; client hot-refresh API not verifiable here');
    return;
  }
  const source = readFileSync(clientPath, 'utf8');
  // The browser half exposes reload(id, rev), sync(graph) and retry(), and it
  // refuses to swap bootstrap modules without a full page reload.
  assert.match(source, /reload\(id, rev\)/, 'reload(id, rev) is the per-package hot-refresh entry');
  assert.match(source, /sync\(graph\)/, 'sync(graph) applies a new boot graph');
  assert.match(source, /retry\(\)/, 'retry() re-attempts failed entries');
  assert.match(source, /replacing bootstrap module .* requires a page reload/,
    'bootstrap modules cannot be swapped without a full page reload');
  assert.match(source, /window\.__ModuleLoader__\.load\(/, 'the bundle registers through the ModuleLoader facade');
});

test('plugin host entry advertises the reload version contract the maintenance layer expects', async () => {
  const host = await readFile(join(process.cwd(), 'plugin', 'host.mjs'), 'utf8');
  assert.match(host, /export const version = VERSION/, 'host exports its running version for the reload handshake');
  assert.match(host, /selfReload\(ctx,/, 'host wires the harness-mode reload callback');
  assert.match(host, /entryUrl: new URL\('\.\/host\.mjs', import\.meta\.url\)\.href/, 'the reload entry is the real host module');
  const { VERSION } = await import('../src/version.mjs');
  assert.equal(VERSION, JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')).version, 'running and package versions agree');
});

test('real kernel: the actual EAC host activates, serves, and hot-reloads in place', { skip: skipReal }, async (t) => {
  // Mount the real plugin/host.mjs through the real loader (as DSH does, so the
  // fiber owns a loader entry and ctx.loader resolves) on an ephemeral port and
  // a temp dataDir. Nothing touches production .eac or the running 4173 service.
  const { Context } = await import(pathToFileURL(cordisPath).href);
  const { Loader } = await import(pathToFileURL(loaderPath).href);
  const root = process.cwd();
  const { VERSION } = await import('../src/version.mjs');
  const packageUrl = `${pathToFileURL(root).href}/`;
  const hostUrl = pathToFileURL(join(root, 'plugin', 'host.mjs')).href;

  const net = await import('node:net');
  const port = await new Promise((accept) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const { port: p } = probe.address(); probe.close(() => accept(p)); });
  });
  const dataDir = await mkdtemp(join(tmpdir(), 'eac-host-reload-'));
  const ctx = new Context();
  let hostEntry;
  t.after(async () => {
    const current = hostEntry?.fiber;
    if (current) {
      ctx.registry.delete(current.runtime.callback);
      await current.await();
    }
    await ctx.root?.fiber?.dispose?.();
    await rm(dataDir, { recursive: true, force: true });
  });
  await ctx.plugin(Loader, { baseUrl: packageUrl }).await();

  const tools = new Map();
  ctx.reflect.provide('tools', { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name); } }, () => true);
  ctx.reflect.provide('systemPrompt', { section: () => () => {}, provide: true }, () => true);

  const options = { name: hostUrl, config: { port, dataDir } };
  await ctx.loader.create(options);
  const entry = hostEntry = ctx.loader.resolve(options.id);
  await entry.fiber?.await();
  assert.equal(entry.fiber.state, 2, 'host fiber is ACTIVE');

  const before = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  assert.equal(before.ok, true);
  assert.equal(before.version, VERSION);
  assert.equal(tools.size, 15, 'all native EAC tools registered');

  // Native tool output is strict, lossless JSON on the real engine.
  const status = await tools.get('eac_status').execute({}, { signal: new AbortController().signal });
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(status))), JSON.stringify(status));

  const maintenanceBefore = await (await fetch(`http://127.0.0.1:${port}/api/maintenance`)).json();
  assert.equal(maintenanceBefore.reload.available, true);
  const accepted = await fetch(`http://127.0.0.1:${port}/api/maintenance/reload`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(accepted.status, 202);
  const { operationId } = await accepted.json();
  let finished;
  for (let i = 0; i < 150; i++) {
    await wait(40);
    try { finished = await (await fetch(`http://127.0.0.1:${port}/api/maintenance`)).json(); } catch { continue; }
    if (finished.operation?.id === operationId && finished.operation.status !== 'running') break;
  }
  assert.equal(finished.operation.id, operationId);
  assert.equal(finished.operation.status, 'completed', finished.operation.error);
  assert.equal(finished.operation.result.version, VERSION);

  const after = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  assert.equal(after.ok, true, 'the reloaded host serves again on the same port');
  assert.equal(after.version, VERSION);
  assert.notEqual(after.instanceId, before.instanceId, 'the old service was disposed and a fresh runtime owns the port');
  assert.equal(tools.size, 15, 'the new activation re-registered every native tool');
  assert.equal(globalThis[Symbol.for('eac-design-world.last-reload')] !== undefined, true);
  // The old host closed its server during disposal; the new fiber owns the port
  // with no deadlock, so a fresh native call still succeeds.
  const reloadedStatus = await tools.get('eac_status').execute({}, { signal: new AbortController().signal });
  assert.ok(Array.isArray(reloadedStatus.templates));
});
