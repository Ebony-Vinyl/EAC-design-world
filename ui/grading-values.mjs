/**
 * Browser-safe grading scalar resolver.
 *
 * `src/media/grading.mjs` is the source of truth but imports `node:fs`, so the UI cannot import it
 * directly. This module mirrors only the scalar/channel resolution rules the timeline controls need:
 * a layer's preset params apply first, then that layer's own explicit scalars override per field.
 * Layers are applied in engine order: project look (preset, then explicit), then clip grading
 * (preset, then explicit). No structured fields (curves/zones/secondaries) are interpreted here.
 */

/** Scalar grading fields shown in the timeline with the same ranges as src/media/grading.mjs. */
export const GRADING_SCALAR_FIELDS = Object.freeze({
  exposure: [-2, 2],
  temperature: [-1, 1],
  saturation: [-1, 1],
  contrast: [-1, 1],
  vibrance: [-1, 1],
  tint: [-1, 1],
  offset: [-0.5, 0.5],
  hueShift: [-180, 180],
});

const SCALAR_KEYS = Object.keys(GRADING_SCALAR_FIELDS);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function presetParams(presetId, presets) {
  if (typeof presetId !== 'string' || !presetId || !Array.isArray(presets)) return null;
  const preset = presets.find((entry) => entry && entry.id === presetId);
  return preset && isPlainObject(preset.params) ? preset.params : null;
}

function readScalars(layer, presets, sourceName, values) {
  if (!isPlainObject(layer)) return;
  const params = presetParams(layer.preset, presets);
  if (params) {
    for (const key of SCALAR_KEYS) {
      if (typeof params[key] === 'number' && Number.isFinite(params[key])) {
        values[key] = { value: params[key], source: `${sourceName}-preset` };
      }
    }
  }
  for (const key of SCALAR_KEYS) {
    if (typeof layer[key] === 'number' && Number.isFinite(layer[key])) {
      values[key] = { value: layer[key], source: sourceName };
    }
  }
}

/**
 * Resolve the effective value and origin of every scalar grading control.
 * Returns `{ [key]: { value, source } }` where source is one of `default`, `look-preset`, `look`,
 * `clip-preset` or `clip`. Presets are the `{ id, params }` objects the engine publishes.
 */
export function resolveGradingValues(look, grading, presets = []) {
  const values = {};
  for (const key of SCALAR_KEYS) values[key] = { value: 0, source: 'default' };
  readScalars(look, presets, 'look', values);
  readScalars(grading, presets, 'clip', values);
  return values;
}

/**
 * Remove one explicit scalar override from a clip grading while keeping every other field,
 * including advanced curves/hue-vs/zones/secondaries. Returns null when nothing else remains,
 * which the timeline treats as "no clip grading".
 */
export function removeScalarOverride(grading, key) {
  if (!isPlainObject(grading) || !Object.hasOwn(grading, key)) return grading ?? null;
  const next = { ...grading };
  delete next[key];
  return Object.keys(next).length ? next : null;
}

/** True when the clip grading stores this scalar explicitly (a real override, including 0). */
export function hasScalarOverride(grading, key) {
  return isPlainObject(grading) && Object.hasOwn(grading, key);
}
