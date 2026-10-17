// Faithful contract harness for src/maintenance-reload.mjs.
//
// When the real @deepseek-ai/cordis kernel + cordis-plugin-loader are not
// resolvable on this machine, the reload unit is exercised against a harness
// that mirrors the exact primitive shapes the module depends on:
//   - a loader with a duck-typed `internal.loadCache` (keys/get/delete), a
//     `import(url)` that returns a namespace, and `unwrapExports`;
//   - a registry with `get/delete/plugin` and fibers carrying
//     `uid`, `await()`, `parent`, `entry`, `_config`.
//
// What the harness deliberately does NOT reproduce (and the test file states
// explicitly): Node's real ESM evaluation and LoadCache shape, real fiber
// disposal ordering, real config schema validation, and real module identity.
// Those are covered by the real-kernel integration tests when available.

/** A Map whose `delete` only clears the type slot, like Node 24's LoadCache. */
export function loadCacheWithStickyDelete(entries) {
  class StickyLoadCache extends Map {
    delete(key) {
      const value = this.get(key);
      if (value === undefined) return false;
      // Keep the key; only blank the "javascript" type slot (Node 24 behaviour).
      Map.prototype.set.call(this, key, { ...value, javascript: undefined });
      return true;
    }
  }
  const cache = new StickyLoadCache();
  for (const [key, value] of entries) Map.prototype.set.call(cache, key, value);
  return cache;
}

/** A non-Map duck-typed cache (Node 24.12+ style): keys/get/delete/set own methods. */
export function duckLoadCache(entries) {
  const map = new Map(entries);
  return {
    keys: () => map.keys(),
    get: (key) => map.get(key),
    set: (key, value) => map.set(key, value),
    delete: (key) => map.delete(key),
    get size() { return map.size; },
    has: (key) => map.has(key),
  };
}

function createFiber(registry, plugin, config, { uid, entry, parent }) {
  const fiber = {
    uid, entry, parent, _config: config, _disposed: false,
    async await() { return fiber; },
    dispose() { fiber._disposed = true; fiber.uid = null; },
  };
  return fiber;
}

/**
 * Build a contract harness.
 * @param {object} options
 * @param {Map<string,object>} options.cacheEntries - initial loadCache rows.
 * @param {'map'|'sticky'|'duck'} [options.cacheKind] - loadCache shape.
 * @param {() => object} options.importModule - produces the namespace per import.
 * @returns {{ctx, loader, registry, events, fibers, cache, imports}}
 */
export function createContractHarness({ cacheEntries = new Map(), cacheKind = 'map', importModule } = {}) {
  const cache = cacheKind === 'sticky' ? loadCacheWithStickyDelete(cacheEntries)
    : cacheKind === 'duck' ? duckLoadCache(cacheEntries) : new Map(cacheEntries);
  const events = [];
  const fibers = [];
  const imports = [];
  const runtimes = new Map();
  let nextUid = 1;

  const registry = {
    get: (plugin) => runtimes.get(plugin),
    has: (plugin) => runtimes.has(plugin),
    delete(plugin) {
      const runtime = runtimes.get(plugin);
      if (!runtime) return undefined;
      runtimes.delete(plugin);
      for (const fiber of runtime.fibers) { events.push(`dispose:${fiber.uid}`); fiber.dispose(); }
      return runtime;
    },
    plugin(plugin, config) {
      let runtime = runtimes.get(plugin);
      if (!runtime) { runtime = { callback: plugin, fibers: [] }; runtimes.set(plugin, runtime); }
      const fiber = createFiber(registry, plugin, config, { uid: nextUid++, parent: { registry } });
      runtime.fibers.push(fiber);
      fibers.push(fiber);
      events.push(`plugin:${plugin.version ?? '?'}`);
      return { ctx: { fiber } };
    },
  };

  const loader = {
    internal: { loadCache: cache },
    async import(url) {
      imports.push(url);
      return importModule ? importModule(url, imports.length) : { apply() {} };
    },
    unwrapExports: (exports) => (exports?.default ?? exports),
  };

  const pluginExports = { apply() {}, version: '1.0.0' };
  const ctx = {
    loader, registry,
    fiber: { runtime: { callback: pluginExports } },
  };
  runtimes.set(pluginExports, { callback: pluginExports, fibers: [createFiber(registry, pluginExports, { from: 'harness' }, { uid: nextUid++, parent: { registry } })] });
  return { ctx, loader, registry, events, fibers, cache, imports, pluginExports, runtimes };
}
