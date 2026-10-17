// Lossless JSON boundary for plugin tool outputs.
//
// The Harness host validates that every tool `execute()` return value is a
// lossless JSON value: it must survive a JSON.stringify -> JSON.parse round
// trip with no information lost. Plain JSON has no representation for
// `undefined`, functions, symbols, bigint, non-finite numbers or cycles, so any
// of those silently degrade (dropped, coerced to null, or thrown) inside
// JSON.stringify. This module rebuilds an engine result into a value that is
// guaranteed lossless, or fails loudly instead of fabricating loss.
//
// Semantics:
//   - Object properties whose value is `undefined` are omitted. JSON cannot
//     carry `undefined`, and an absent optional field is the engine's own
//     intent, so omission is lossless rather than fabricated loss.
//   - `undefined` in any other position (root, array element, Map/Set member)
//     is rejected: JSON would coerce an array hole to `null`.
//   - bigint, function, symbol, non-finite number, -0, non-plain object
//     instances (Map/Set/Date/class) and true cycles are rejected.
//   - Shared (non-cyclic) object references are preserved; JSON duplicates them.
//   - null, booleans, strings, finite numbers, plain objects and arrays keep
//     their exact values and structure.

const MAX_DEPTH = 256;

export class LosslessJsonError extends Error {
  constructor(message, path) {
    super(`${message} at ${path}`);
    this.name = 'LosslessJsonError';
    this.code = 'EAC_LOSSLESS_JSON';
    this.path = path;
  }
}

function isPlainRecord(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function describe(node) {
  if (Array.isArray(node)) return 'array';
  const name = node.constructor?.name;
  return name && name !== 'Object' ? `${name} instance` : 'object';
}

// Rebuild `value` into a plain, lossless JSON structure, or throw LosslessJsonError.
export function toLosslessJson(value) {
  const seen = new WeakSet();
  const convert = (node, path, depth) => {
    if (node === null) return null;
    const type = typeof node;
    if (type === 'string' || type === 'boolean') return node;
    if (type === 'number') {
      if (!Number.isFinite(node)) throw new LosslessJsonError(`unsupported non-finite number ${node}`, path);
      if (Object.is(node, -0)) throw new LosslessJsonError('unsupported negative zero (JSON loses its sign)', path);
      return node;
    }
    if (type === 'undefined') throw new LosslessJsonError('unsupported undefined value', path);
    if (type === 'bigint') throw new LosslessJsonError('unsupported bigint value', path);
    if (type === 'function' || type === 'symbol') throw new LosslessJsonError(`unsupported ${type} value`, path);
    if (depth > MAX_DEPTH) throw new LosslessJsonError('JSON structure exceeds maximum depth', path);
    if (seen.has(node)) throw new LosslessJsonError('cyclic reference', path);
    seen.add(node);
    try {
      if (Array.isArray(node)) {
        // Read every index explicitly: Array.prototype.map skips holes, which
        // JSON.stringify would then emit as null (fabricated loss).
        const output = new Array(node.length);
        for (let index = 0; index < node.length; index++) {
          if (!Object.hasOwn(node, index)) throw new LosslessJsonError('unsupported sparse array hole', `${path}[${index}]`);
          output[index] = convert(node[index], `${path}[${index}]`, depth + 1);
        }
        return output;
      }
      if (!isPlainRecord(node)) throw new LosslessJsonError(`unsupported ${describe(node)}`, path);
      const output = {};
      for (const key of Object.keys(node)) {
        const child = node[key];
        if (child === undefined) continue;
        // Define own data properties instead of assigning: JSON.parse produces a
        // real own "__proto__" key, and `output[key] =` would hit the prototype
        // setter, mutating the prototype and dropping the value.
        Object.defineProperty(output, key, {
          value: convert(child, `${path}.${key}`, depth + 1), enumerable: true, writable: true, configurable: true,
        });
      }
      return output;
    } finally {
      seen.delete(node);
    }
  };
  return convert(value, '$', 0);
}

// True only when `value` is already a lossless JSON value with no normalization needed:
// no undefined anywhere, no unsupported leaf types, and an exact JSON round trip.
export function isLosslessJson(value) {
  const inspect = (node, depth) => {
    if (node === null) return true;
    const type = typeof node;
    if (type === 'string' || type === 'boolean') return true;
    if (type === 'number') return Number.isFinite(node) && !Object.is(node, -0);
    if (type !== 'object' || depth > MAX_DEPTH) return false;
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index++) {
        if (!Object.hasOwn(node, index) || !inspect(node[index], depth + 1)) return false;
      }
      return true;
    }
    if (!isPlainRecord(node)) return false;
    return Object.keys(node).every((key) => node[key] !== undefined && inspect(node[key], depth + 1));
  };
  if (!inspect(value, 0)) return false;
  try {
    const encoded = JSON.stringify(value);
    return encoded !== undefined && JSON.stringify(JSON.parse(encoded)) === encoded;
  } catch {
    return false;
  }
}
