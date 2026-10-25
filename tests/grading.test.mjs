import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  GRADING_PARAM_RANGES, GRADING_PRESETS, describeGrading, generateCubeLut, gradingToTransform,
  mergeGrading, normalizeGrading, writeCubeLut,
} from '../src/media/grading.mjs';

const SCALAR_KEYS = Object.keys(GRADING_PARAM_RANGES);
// Defaults filled by normalizeGrading for the extended structured fields.
const STRUCTURED_DEFAULTS = {
  curves: null, hueVsHue: null, hueVsSat: null, hueVsLum: null, lumVsSat: null,
  zones: null, secondaries: [],
};

function assertClose(actual, expected, epsilon = 1e-9, message = 'values match') {
  assert.equal(actual.length, expected.length, message);
  actual.forEach((value, index) => {
    assert.ok(Math.abs(value - expected[index]) <= epsilon,
      `${message}: channel ${index} ${value} != ${expected[index]}`);
  });
}

test('normalizeGrading fills defaults, resolves presets and passes null through', () => {
  assert.deepEqual(normalizeGrading({}), {
    exposure: 0, contrast: 0, saturation: 0, vibrance: 0, temperature: 0, tint: 0,
    offset: 0, hueShift: 0,
    lift: { r: 0, g: 0, b: 0 }, gamma: { r: 1, g: 1, b: 1 }, gain: { r: 1, g: 1, b: 1 },
    ...STRUCTURED_DEFAULTS,
  });
  assert.equal(normalizeGrading(null), null);
  assert.equal(normalizeGrading(undefined), null);
  const blackAndWhite = normalizeGrading({ preset: 'silver-bw' });
  assert.equal(blackAndWhite.preset, 'silver-bw');
  assert.equal(blackAndWhite.saturation, -1);
  assert.equal(blackAndWhite.contrast, 0.18);
  assert.deepEqual(blackAndWhite.gamma, { r: 0.98, g: 1, b: 1.04 });
  assert.deepEqual(blackAndWhite.lift, { r: 0, g: 0, b: 0 });
  const partial = normalizeGrading({ lift: { r: 0.1 }, gain: { b: 1.2 } });
  assert.deepEqual(partial.lift, { r: 0.1, g: 0, b: 0 });
  assert.deepEqual(partial.gain, { r: 1, g: 1, b: 1.2 });
  assert.deepEqual(normalizeGrading(partial), partial, 'normalizing is idempotent');
  const bounds = normalizeGrading({
    exposure: 2, contrast: 1, saturation: -1, vibrance: 1, temperature: -1, tint: 1,
    lift: { r: 0.5, g: -0.5, b: 0 }, gamma: { r: 0.5, g: 2, b: 1 }, gain: { r: 2, g: 0.5, b: 1 },
  });
  assert.equal(bounds.exposure, 2);
  assert.equal(bounds.gain.r, 2);
  const overridden = normalizeGrading({ preset: 'clean-landscape', contrast: 0.5, exposure: 0.3 });
  assert.equal(overridden.preset, 'clean-landscape');
  assert.equal(overridden.contrast, 0.5, 'explicit fields override the preset per field');
  assert.equal(overridden.exposure, 0.3);
  assert.equal(overridden.vibrance, 0.25);
  assert.equal(overridden.temperature, -0.18);
});

test('normalizeGrading rejects out-of-range values, unknown keys and non-numbers', () => {
  for (const bad of [
    { exposure: 3 }, { exposure: -2.1 }, { contrast: 1.01 }, { saturation: -1.5 },
    { vibrance: NaN }, { temperature: Infinity }, { tint: '0.5' }, { contrast: null },
    { lift: { r: 0.6 } }, { lift: { r: -0.51 } }, { gamma: { g: 2.1 } }, { gain: { b: 0.4 } },
    { lift: { x: 1 } }, { gain: 'warm' }, { preset: 'missing-preset' }, { preset: 42 },
    { sharpness: 1 }, [], ['contrast'], 'saturation', 5, true,
  ]) {
    assert.throws(() => normalizeGrading(bad), TypeError, JSON.stringify(bad));
  }
});

test('normalizeGrading validates and normalizes the extended grading fields', () => {
  for (const bad of [
    { offset: 0.6 }, { offset: -0.51 }, { offset: NaN },
    { hueShift: 180.1 }, { hueShift: -181 }, { hueShift: '15' },
    { curves: 5 }, { curves: { master: 'x' } }, { curves: { rgb: [[0, 0], [1, 1]] } },
    { curves: { master: [] } }, { curves: { master: [[0, 0]] } },
    { curves: { master: [[0, 0], [1, 1], [0.5, 0.5]] } },
    { curves: { master: [[0, 0], [0.5, 0.5], [0.5, 0.6], [1, 1]] } },
    { curves: { master: [[0.05, 0], [1, 1]] } }, { curves: { master: [[0, 0], [0.95, 1]] } },
    { curves: { master: [[0, 0], [1.2, 1]] } },
    { curves: { master: [[0, -0.1], [1, 1]] } }, { curves: { master: [[0, 0], [1, 1.1]] } },
    { curves: { master: [[0, 0], [1]] } },
    { curves: { master: [[0, 0], [0.4, 0.4], [0.6, 0.6], [0.8, 0.8], [0.9, 0.9], [0.95, 0.95], [0.98, 0.98], [1, 1], [1, 1]] } },
    { hueVsHue: [[0, 0]] }, { hueVsHue: [[-5, 0], [100, 0]] }, { hueVsHue: [[0, 0], [400, 0]] },
    { hueVsHue: [[0, 0], [100, 91]] }, { hueVsHue: [[0, -91], [100, 0]] },
    { hueVsHue: [[100, 0], [100, 10]] }, { hueVsSat: [[0, 0], [100, -1.01]] }, { hueVsLum: 'x' },
    { lumVsSat: [[0, 0], [1.5, 0]] }, { lumVsSat: [[0, 0], [0.5, 1.01]] },
    { zones: 5 }, { zones: { mids: { exposure: 0.1 } } },
    { zones: { shadowRange: 0.05 } }, { zones: { highlightRange: 0.95 } },
    { zones: { shadows: { exposure: 3 } } }, { zones: { shadows: { temperature: 0.1 } } },
    { zones: { highlights: { gain: { r: 3 } } } }, { zones: { shadows: 'x' } },
    { secondaries: 'x' }, { secondaries: [1, 2, 3, 4, 5] },
    { secondaries: [{ adjustments: {} }] }, { secondaries: [{ qualifier: { hue: 220 } }] },
    { secondaries: [{ qualifier: { hue: 400, hueWidth: 40 } }] },
    { secondaries: [{ qualifier: { hue: 220, hueWidth: 3 } }] },
    { secondaries: [{ qualifier: { hue: 220, hueWidth: 200 } }] },
    { secondaries: [{ qualifier: { hue: 220, hueWidth: 40, softness: 0.5 } }] },
    { secondaries: [{ qualifier: { hue: 220, hueWidth: 40, satMin: 0.8, satMax: 0.2 } }] },
    { secondaries: [{ qualifier: { hue: 220, hueWidth: 40, lumaMin: 0.9, lumaMax: 0.1 } }] },
    { secondaries: [{ qualifier: { hue: 220, hueWidth: 40, extra: 1 } }] },
    { secondaries: [{ qualifier: { hue: 220, hueWidth: 40 }, adjustments: { temperature: 0.1 } }] },
    { secondaries: [{ qualifier: { hue: 220, hueWidth: 40 }, adjustments: { offset: 0.1 } }] },
    { secondaries: [{ qualifier: { hue: 220, hueWidth: 40 }, adjustments: { gain: { r: 3 } } }] },
  ]) {
    assert.throws(() => normalizeGrading(bad), TypeError, JSON.stringify(bad));
  }
  const curvePoints = [[0, 0], [0.5, 0.35], [1, 1]];
  const normalized = normalizeGrading({
    offset: 0.25, hueShift: -90,
    curves: { master: curvePoints, b: [[0, 0], [1, 0.8]] },
    hueVsHue: [[200, 0.5], [10, -0.5]],
    zones: { shadows: { exposure: 0.2, lift: { r: 0.05 } }, highlightRange: 0.8 },
    secondaries: [{ qualifier: { hue: 220, hueWidth: 40 }, adjustments: { saturation: 0.5 } }],
  });
  assert.equal(normalized.offset, 0.25);
  assert.equal(normalized.hueShift, -90);
  assert.deepEqual(normalized.curves, { master: curvePoints, b: [[0, 0], [1, 0.8]] });
  assert.deepEqual(normalized.hueVsHue, [[10, -0.5], [200, 0.5]], 'hue-vs curves sort by anchor');
  assert.equal(normalized.hueVsSat, null);
  assert.deepEqual(normalized.zones, {
    shadows: { exposure: 0.2, lift: { r: 0.05 } }, shadowRange: 0.3, highlightRange: 0.8,
  });
  assert.deepEqual(normalized.secondaries[0].qualifier, {
    hue: 220, hueWidth: 40, satMin: 0, satMax: 1, lumaMin: 0, lumaMax: 1, softness: 0.08,
  });
  assert.deepEqual(normalized.secondaries[0].adjustments, { saturation: 0.5 });
  assert.deepEqual(normalizeGrading(normalized), normalized, 'extended fields normalize idempotently');
});

test('mergeGrading overlays layers per field and per channel while skipping nulls', () => {
  assert.equal(mergeGrading(null, undefined), null);
  assert.equal(mergeGrading(), null);
  const merged = mergeGrading(
    { preset: 'clean-landscape', exposure: 0.5, lift: { r: 0.1 } },
    null,
    { exposure: 0.3, lift: { b: -0.05 }, gamma: { g: 1.1 } },
  );
  assert.deepEqual(merged, {
    preset: 'clean-landscape',
    exposure: 0.3, contrast: 0.12, saturation: 0.05, vibrance: 0.25, temperature: -0.18, tint: 0,
    offset: 0, hueShift: 0,
    lift: { r: 0.1, g: 0, b: -0.05 }, gamma: { r: 1, g: 1.1, b: 1 }, gain: { r: 1, g: 1, b: 1 },
    ...STRUCTURED_DEFAULTS,
  });
  const switched = mergeGrading({ exposure: 0.5, saturation: -1 }, { preset: 'clean-landscape' });
  assert.equal(switched.preset, 'clean-landscape');
  assert.equal(switched.exposure, 0.5, 'fields absent from the new preset persist');
  assert.equal(switched.saturation, 0.05, 'preset params override earlier layers per field');
  assert.equal(switched.vibrance, 0.25);
  assert.throws(() => mergeGrading({ exposure: 1 }, 'contrast'), TypeError);
  assert.throws(() => mergeGrading(42), TypeError);
});

test('mergeGrading replaces structured fields wholesale while scalars merge per field', () => {
  const layered = mergeGrading(
    {
      offset: 0.1, hueShift: 10,
      curves: { master: [[0, 0], [1, 1]] },
      secondaries: [{ qualifier: { hue: 20, hueWidth: 30 }, adjustments: { saturation: 0.5 } }],
      zones: { shadows: { exposure: 0.5 } },
    },
    { curves: { r: [[0, 0], [1, 1]] }, secondaries: [], zones: null, hueShift: 20 },
  );
  assert.deepEqual(layered.curves, { r: [[0, 0], [1, 1]] }, 'curves are replaced wholesale');
  assert.deepEqual(layered.secondaries, [], 'secondaries are replaced wholesale');
  assert.equal(layered.zones, null, 'an explicit null clears zones wholesale');
  assert.equal(layered.offset, 0.1, 'scalars absent from the later layer persist');
  assert.equal(layered.hueShift, 20, 'scalars still override per field');
});

test('gradingToTransform is an identity for empty grading and stays monotonic under exposure', () => {
  const identity = gradingToTransform({});
  for (const [r, g, b] of [[0, 0, 0], [0.2, 0.4, 0.9], [0.435, 0.435, 0.435], [1, 1, 1]]) {
    assertClose(identity(r, g, b), [r, g, b]);
  }
  assertClose(gradingToTransform(null)(0.3, 0.6, 0.9), [0.3, 0.6, 0.9], 1e-9, 'null grading is identity');
  const brighter = gradingToTransform({ exposure: 1 });
  for (const value of [0.05, 0.3, 0.5, 0.8]) {
    assert.ok(brighter(value, value, value)[0] > identity(value, value, value)[0],
      `positive exposure brightens ${value}`);
  }
  for (const value of [0.05, 0.3, 0.45]) {
    assert.ok(brighter(value, value, value)[0] > brighter(value - 0.01, value, value)[0],
      'exposure stays monotonic below the clamp');
  }
});

test('gradingToTransform moves channels as documented: warmth, saturation, contrast, gain and lift', () => {
  const warm = gradingToTransform({ temperature: 1 });
  const [wr, wg, wb] = warm(0.5, 0.5, 0.5);
  assert.ok(wr > 0.5 && wb < 0.5, 'warm shifts mid gray toward red and away from blue');
  assertClose([wr, wg, wb], [0.625, 0.5, 0.375]);

  const desaturated = gradingToTransform({ saturation: -1 });
  const gray = desaturated(0.15, 0.6, 0.85);
  assert.equal(gray[0], gray[1]);
  assert.equal(gray[1], gray[2]);
  const luma = 0.2126 * 0.15 + 0.7152 * 0.6 + 0.0722 * 0.85;
  assertClose(gray, [luma, luma, luma], 1e-9, 'saturation -1 collapses onto luma');

  const contrast = gradingToTransform({ contrast: 0.5 });
  const dark = contrast(0.3, 0.3, 0.3)[0];
  const bright = contrast(0.6, 0.6, 0.6)[0];
  assert.ok(bright - dark > 0.3, 'positive contrast spreads values apart');
  assertClose([dark, bright], [0.2325, 0.6825], 1e-9);

  const redGain = gradingToTransform({ gain: { r: 1.5 } });
  assertClose(redGain(0.5, 0.5, 0.5), [0.75, 0.5, 0.5], 1e-9, 'gain.r only raises red');

  const lifted = gradingToTransform({ lift: { r: 0.1 } });
  assertClose(lifted(0, 0, 0), [0.1, 0, 0], 1e-9, 'lift raises black');
  assertClose(lifted(1, 1, 1), [1, 1, 1], 1e-9, 'shadow-weighted lift leaves white untouched');

  const vivid = gradingToTransform({ vibrance: 1 });
  const grayish = vivid(0.5, 0.5, 0.49);
  const saturated = vivid(0.9, 0.1, 0.1);
  const graySpread = Math.max(...grayish) - Math.min(...grayish);
  const saturatedSpread = Math.max(...saturated) - Math.min(...saturated);
  assert.ok(graySpread > 0.015 && graySpread < 0.025, 'vibrance boosts near-gray pixels');
  assert.ok(saturatedSpread > 0.8 && saturatedSpread < 0.92, 'vibrance barely touches saturated pixels');
});

test('offset adds an ASC-CDL master offset after lift/gamma/gain and before contrast', () => {
  const raised = gradingToTransform({ offset: 0.25 });
  assertClose(raised(0, 0, 0), [0.25, 0.25, 0.25], 1e-9, 'offset raises black');
  const lowered = gradingToTransform({ offset: -0.5 });
  assertClose(lowered(1, 1, 1), [0.5, 0.5, 0.5], 1e-9, 'offset lowers white');
  const afterGamma = gradingToTransform({ offset: 0.25, gamma: { r: 2 } });
  assertClose(afterGamma(0.5, 0.5, 0.5), [0.5, 0.75, 0.75], 1e-9,
    'offset is added after the gamma power, not before it');
  const beforeContrast = gradingToTransform({ offset: 0.25, contrast: 1 });
  assertClose(beforeContrast(0, 0, 0), [0.065, 0.065, 0.065], 1e-9,
    'contrast pivots around the offset value');
});

test('curves apply monotone cubic interpolation per channel after contrast', () => {
  const linear = gradingToTransform({ curves: { master: [[0, 0], [0.5, 0.5], [1, 1]] } });
  assertClose(linear(0, 0, 0), [0, 0, 0], 1e-9, 'f(0) stays 0');
  assertClose(linear(1, 1, 1), [1, 1, 1], 1e-9, 'f(1) stays 1');
  assertClose(linear(0.3, 0.3, 0.3), [0.3, 0.3, 0.3], 1e-9, 'an on-the-diagonal curve is identity');

  const lifted = gradingToTransform({ curves: { master: [[0, 0], [0.5, 0.6], [1, 1]] } });
  const mid = lifted(0.435, 0.435, 0.435);
  assert.ok(mid[0] > 0.5 && mid[0] < 0.6, 'a lifted master curve raises mid-gray');
  assert.equal(mid[0], mid[1]);
  assert.equal(mid[1], mid[2], 'a master curve keeps neutrals neutral');

  const redOnly = gradingToTransform({ curves: { r: [[0, 0], [0.5, 0.7], [1, 1]] } });
  assertClose(redOnly(0.5, 0.5, 0.5), [0.7, 0.5, 0.5], 1e-9, 'an r curve only reshapes red');

  const monotone = gradingToTransform({ curves: { master: [[0, 0], [0.3, 0.2], [0.6, 0.5], [1, 1]] } });
  let previous = -1;
  for (let i = 0; i <= 20; i++) {
    const value = monotone(i / 20, i / 20, i / 20)[0];
    assert.ok(value >= previous - 1e-9, `curve output stays monotone at ${i / 20}`);
    assert.ok(value >= 0 && value <= 1, `curve output stays clamped at ${i / 20}`);
    previous = value;
  }
});

test('hueShift rotates hue globally while keeping neutrals fixed', () => {
  const shifted = gradingToTransform({ hueShift: 180 });
  assertClose(shifted(1, 0, 0), [0, 1, 1], 1e-9, 'hue 180 turns red into cyan');
  assertClose(shifted(0.5, 0.5, 0.5), [0.5, 0.5, 0.5], 1e-9, 'neutrals keep their value');
  const opposite = gradingToTransform({ hueShift: -180 });
  assertClose(opposite(1, 0, 0), [0, 1, 1], 1e-9, 'hue -180 also turns red into cyan');
  const quarter = gradingToTransform({ hueShift: 120 });
  assertClose(quarter(0, 1, 0), [0, 0, 1], 1e-9, 'hue 120 turns green into blue');
});

test('hueVsHue curves are periodic and leave distant hues untouched', () => {
  const hueVsHue = gradingToTransform({ hueVsHue: [[0, 0], [45, 60], [90, 0]] });
  assertClose(hueVsHue(0, 0, 1), [0, 0, 1], 1e-9,
    'pure blue is far from the anchors and does not move');
  assertClose(hueVsHue(1, 0.75, 0), [0.25, 1, 0], 1e-9, 'orange at the anchor rotates by 60 degrees');
  const wrap = gradingToTransform({ hueVsHue: [[300, 90], [60, 90]] });
  assertClose(wrap(1, 0, 0), [0.5, 1, 0], 1e-9, 'the anchor curve wraps around the 0/360 boundary');
});

test('hueVsSat, hueVsLum and lumVsSat act on the documented signals', () => {
  const desaturate = gradingToTransform({ hueVsSat: [[0, -0.5], [360, -0.5]] });
  assertClose(desaturate(1, 0, 0), [1, 0.5, 0.5], 1e-9, 'hueVsSat halves the saturation of red');

  const lumaLift = gradingToTransform({ hueVsLum: [[0, 1], [360, 1]] });
  assertClose(lumaLift(0.2, 0.2, 0.2), [0.45, 0.45, 0.45], 1e-9, 'hueVsLum maps delta 1 to +0.25 luma');
  assert.equal(lumaLift(0.9, 0.9, 0.9)[0], 1, 'the hueVsLum luma shift clamps at white');

  const lumVsSat = gradingToTransform({ lumVsSat: [[0, 1], [1, 1]] });
  assertClose(lumVsSat(0.2, 0.4, 0.6), [0.02808, 0.42808, 0.82808], 1e-9,
    'lumVsSat doubles saturation around Rec.709 luma');
  const result = lumVsSat(0.2, 0.4, 0.6);
  const lumaBefore = 0.2126 * 0.2 + 0.7152 * 0.4 + 0.0722 * 0.6;
  const lumaAfter = 0.2126 * result[0] + 0.7152 * result[1] + 0.0722 * result[2];
  assert.ok(Math.abs(lumaAfter - lumaBefore) < 1e-9, 'lumVsSat preserves luma');
});

test('secondaries qualify softly and blend on top of the base result', () => {
  const secondary = { qualifier: { hue: 220, hueWidth: 40 }, adjustments: { saturation: 0.8 } };
  const selective = gradingToTransform({ secondaries: [secondary] });
  assertClose(selective(0, 1, 0), [0, 1, 0], 1e-9, 'pure green is outside the qualifier and does not move');
  const lut = generateCubeLut({ secondaries: [secondary] }, 3).trimEnd().split('\n');
  const greenEntry = lut[6 + ((0 * 3 + 2) * 3 + 0)].split(' ').map(Number);
  assertClose(greenEntry, [0, 1, 0], 1e-6, 'the pure-green LUT entry stays neutral');
  assertClose(selective(0.2, 0.3, 0.9), [0.102352, 0.282352, 1], 1e-9,
    'a qualifying blue pixel is fully adjusted');

  const outside = gradingToTransform({
    secondaries: [{ qualifier: { hue: 220, hueWidth: 40, softness: 0.1 }, adjustments: { saturation: 0.8 } }],
  });
  assertClose(outside(0.3, 0, 0.9), [0.3, 0, 0.9], 1e-9,
    'a pixel beyond the soft hue falloff does not move');

  const chained = gradingToTransform({ secondaries: [secondary, secondary] });
  assert.ok(chained(0.2, 0.3, 0.9)[0] < selective(0.2, 0.3, 0.9)[0],
    'second secondaries chain on top of the first');
});

test('zones weight shadows, midtones and highlights from the input luma', () => {
  const zones = gradingToTransform({ zones: { shadows: { exposure: 0.5 }, highlights: { exposure: -0.5 } } });
  const dark = 0.1 * 2 ** 0.5;
  assertClose(zones(0.1, 0.1, 0.1), [dark, dark, dark], 1e-9, 'dark pixels get the shadows adjustment');
  const bright = 0.95 * 2 ** -0.5;
  assertClose(zones(0.95, 0.95, 0.95), [bright, bright, bright], 1e-9,
    'bright pixels get the highlights adjustment');
  assertClose(zones(0.435, 0.435, 0.435), [0.435, 0.435, 0.435], 1e-9,
    'midtones stay neutral when only shadows/highlights are set');

  const neutral = gradingToTransform({ zones: { shadows: {}, midtones: { contrast: 0 }, highlightRange: 0.5 } });
  assertClose(neutral(0.25, 0.5, 0.75), [0.25, 0.5, 0.75], 1e-9, 'an all-neutral zones object is a no-op');

  const colored = gradingToTransform({ zones: { shadows: { saturation: 0.5 } } });
  assertClose(colored(0.2, 0.1, 0.1), [0.23937, 0.08937, 0.08937], 1e-9,
    'zone saturation applies scaled by the shadow weight');
});

test('gradingToTransform stays total and clamped for extreme gradings including black and white', () => {
  const extreme = gradingToTransform({
    exposure: 2, contrast: 1, saturation: 1, vibrance: 1, temperature: 1, tint: 1,
    lift: { r: 0.5, g: 0.5, b: 0.5 }, gamma: { r: 2, g: 0.5, b: 2 }, gain: { r: 2, g: 2, b: 2 },
  });
  for (const [r, g, b] of [[0, 0, 0], [1, 1, 1], [0.5, 0.25, 0.75]]) {
    for (const value of extreme(r, g, b)) {
      assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `clamped finite output for ${r},${g},${b}`);
    }
  }
  assertClose(gradingToTransform({ exposure: 2 })(1, 1, 1), [1, 1, 1], 1e-9, 'white stays clamped');
  const dark = gradingToTransform({ exposure: -2 })(0.1, 0.1, 0.1);
  assert.ok(dark.every((value) => value > 0 && value < 0.1), 'negative exposure darkens');
});

test('full-featured gradings bake deterministic, clamped and NaN-free LUTs', () => {
  const everything = {
    preset: 'showcase-vivid',
    exposure: 0.4, contrast: 0.6, saturation: 0.5, vibrance: 0.6, temperature: 0.5, tint: -0.4,
    offset: 0.3, hueShift: 120,
    curves: {
      master: [[0, 0.02], [0.5, 0.9], [1, 0.98]],
      r: [[0, 0], [1, 1]],
      g: [[0, 0.05], [0.5, 0.8], [1, 1]],
      b: [[0, 0], [0.3, 0.7], [1, 1]],
    },
    hueVsHue: [[0, 90], [180, -90], [359, 90]],
    hueVsSat: [[0, 1], [120, -1], [240, 1]],
    hueVsLum: [[45, 1], [315, -1]],
    lumVsSat: [[0, 1], [0.5, -1], [1, 1]],
    zones: {
      shadows: {
        exposure: 1, contrast: 1, saturation: 1, hueShift: 180,
        lift: { r: 0.5, g: 0.5, b: 0.5 }, gamma: { r: 2, g: 0.5, b: 2 }, gain: { r: 2, g: 2, b: 0.5 },
      },
      midtones: { exposure: 0.5, saturation: 0.5 },
      highlights: { exposure: -1, saturation: -1, hueShift: -180 },
      shadowRange: 0.6, highlightRange: 0.4,
    },
    secondaries: [
      {
        qualifier: { hue: 0, hueWidth: 180, softness: 0.45 },
        adjustments: {
          exposure: 2, contrast: 1, saturation: 1, vibrance: 1, hueShift: 180,
          lift: { r: 0.5, g: 0.5, b: 0.5 }, gamma: { r: 2, g: 0.5, b: 2 }, gain: { r: 2, g: 2, b: 2 },
        },
      },
      { qualifier: { hue: 240, hueWidth: 5, satMin: 0.9, lumaMin: 0.9, softness: 0 }, adjustments: { saturation: -1 } },
      { qualifier: { hue: 120, hueWidth: 60 }, adjustments: { vibrance: -1 } },
      { qualifier: { hue: 30, hueWidth: 10, lumaMin: 0.2, lumaMax: 0.6, softness: 0.2 }, adjustments: { exposure: -2, gamma: { r: 0.5 } } },
    ],
  };
  const transform = gradingToTransform(everything);
  for (let i = 0; i <= 5; i++) {
    for (let j = 0; j <= 5; j++) {
      for (let k = 0; k <= 5; k++) {
        for (const value of transform(i / 5, j / 5, k / 5)) {
          assert.ok(Number.isFinite(value) && value >= 0 && value <= 1,
            `clamped finite output for ${i / 5},${j / 5},${k / 5}`);
        }
      }
    }
  }
  const lutA = generateCubeLut(everything, 4);
  assert.equal(lutA, generateCubeLut(everything, 4), 'LUT generation is deterministic');
  assert.ok(!lutA.includes('NaN'), 'no NaN reaches the LUT text');
  assert.ok(lutA.startsWith('# EAC design world\n# showcase-vivid\nTITLE showcase-vivid\nLUT_3D_SIZE 4\n'),
    'the header shape is preserved');
  assert.notEqual(lutA, generateCubeLut({}, 4), 'the features actually change the LUT');
});

test('generateCubeLut emits the exact .cube header with red-fastest identity data', () => {
  const rows = generateCubeLut({}, 4).split('\n');
  assert.equal(rows.at(-1), '', 'content ends with a newline');
  const data = rows.slice(0, -1);
  assert.equal(data.length, 6 + 4 ** 3);
  assert.deepEqual(data.slice(0, 6), [
    '# EAC design world', '# custom', 'TITLE custom', 'LUT_3D_SIZE 4',
    'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0',
  ]);
  assert.equal(data[6], '0.000000 0.000000 0.000000', 'black maps to black');
  assert.equal(data[7], '0.333333 0.000000 0.000000', 'the red index varies fastest');
  assert.equal(data[9], '1.000000 0.000000 0.000000');
  assert.equal(data[10], '0.000000 0.333333 0.000000', 'green advances after red wraps');
  assert.equal(data.at(-1), '1.000000 1.000000 1.000000', 'white maps to white');
});

test('generateCubeLut supports presets, the default 33-point grid and rejects invalid input', () => {
  const lut = generateCubeLut({});
  assert.ok(lut.includes('LUT_3D_SIZE 33'), 'default size is 33');
  const rows = lut.trimEnd().split('\n');
  assert.equal(rows.length, 6 + 33 ** 3);
  assert.equal(rows[7], '0.031250 0.000000 0.000000');
  const mid = rows[6 + ((16 * 33) + 16) * 33 + 16].split(' ').map(Number);
  assertClose(mid, [0.5, 0.5, 0.5], 1e-6, 'the mid-grid entry of an identity LUT is neutral gray');

  const preset = generateCubeLut({ preset: 'silver-bw' }, 4).trimEnd().split('\n');
  assert.equal(preset[1], '# silver-bw');
  assert.equal(preset[2], 'TITLE silver-bw');
  assert.equal(preset.length, 6 + 4 ** 3);
  assert.equal(preset[6], '0.000000 0.000000 0.000000');
  assert.equal(preset.at(-1), '1.000000 1.000000 1.000000');
  const neutralMid = preset[6 + ((1 * 4) + 1) * 4 + 1].split(' ').map(Number);
  assert.equal(neutralMid[0], neutralMid[1]);
  assert.equal(neutralMid[1], neutralMid[2], 'black and white LUT keeps neutral grays');

  assert.throws(() => generateCubeLut(null), TypeError);
  assert.throws(() => generateCubeLut(undefined, 4), TypeError);
  assert.throws(() => generateCubeLut({}, 1), TypeError);
  assert.throws(() => generateCubeLut({}, 2.5), TypeError);
  assert.throws(() => generateCubeLut({}, 300), TypeError);
  assert.throws(() => generateCubeLut({ exposure: 9 }, 4), TypeError);
});

test('writeCubeLut writes UTF-8 content, honors cancellation and validates arguments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-grading-'));
  try {
    const path = join(directory, 'teal-orange.cube');
    await writeCubeLut({ preset: 'teal-orange' }, path, { size: 4 });
    assert.equal(await readFile(path, 'utf8'), generateCubeLut({ preset: 'teal-orange' }, 4));
    const fullPath = join(directory, 'default-size.cube');
    await writeCubeLut({}, fullPath);
    assert.ok((await readFile(fullPath, 'utf8')).includes('LUT_3D_SIZE 33'));

    const guarded = join(directory, 'guarded.cube');
    await writeFile(guarded, 'keep', 'utf8');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(writeCubeLut({}, guarded, { size: 4, signal: controller.signal }),
      { name: 'AbortError' });
    assert.equal(await readFile(guarded, 'utf8'), 'keep', 'cancellation preserves existing files');

    await assert.rejects(writeCubeLut({}, 42), TypeError);
    await assert.rejects(writeCubeLut(null, join(directory, 'null.cube')), TypeError);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('GRADING_PRESETS provides at least thirteen unique valid cinematic looks', () => {
  assert.deepEqual(GRADING_PARAM_RANGES, {
    exposure: [-2, 2], contrast: [-1, 1], saturation: [-1, 1],
    vibrance: [-1, 1], temperature: [-1, 1], tint: [-1, 1],
  });
  assert.ok(GRADING_PRESETS.length >= 13);
  const ids = new Set();
  for (const preset of GRADING_PRESETS) {
    assert.match(preset.id, /^[a-z\d]+(?:-[a-z\d]+)*$/, 'preset ids are kebab-case ASCII');
    assert.ok(!ids.has(preset.id), `preset id ${preset.id} is unique`);
    ids.add(preset.id);
    assert.ok(typeof preset.name === 'string' && preset.name.trim(), 'preset names are nonempty');
    assert.ok(typeof preset.description === 'string' && preset.description.trim());
    const normalized = normalizeGrading(preset.params);
    for (const key of SCALAR_KEYS) {
      const [min, max] = GRADING_PARAM_RANGES[key];
      assert.ok(normalized[key] >= min && normalized[key] <= max, `${preset.id}.${key} in range`);
    }
  }
  for (const id of ['clean-landscape', 'teal-orange', 'golden-hour', 'moody-blue', 'film-warm',
    'alpine-crisp', 'forest-emerald', 'desert-dust', 'nordic-pale', 'silver-bw',
    'showcase-vivid', 'neon-night', 'lantern-night']) {
    assert.ok(ids.has(id), `builtin preset ${id} exists`);
  }
});

test('describeGrading summarizes a grading as one Chinese line for logs', () => {
  assert.equal(describeGrading(null), '无调色');
  assert.equal(describeGrading(undefined), '无调色');
  assert.equal(describeGrading({}), '无调色');
  assert.equal(describeGrading({ preset: 'teal-orange', exposure: 0.3, temperature: 0.2 }),
    '青橙电影 · 曝光+0.3 · 色温+0.2');
  assert.equal(describeGrading({ preset: 'teal-orange' }), '青橙电影');
  assert.equal(describeGrading({ exposure: -0.5, saturation: -1 }), '曝光-0.5 · 饱和度-1');
  assert.equal(describeGrading({ lift: { r: 0.1, g: 0.1, b: 0.1 }, gain: { r: 1.2, g: 1.2, b: 1.2 } }),
    '暗部+0.1 · 增益+0.2');
  assert.equal(describeGrading({ gamma: { r: 0.98, b: 1.04 } }), '伽马(R-0.02,B+0.04)');
});

test('describeGrading appends markers for offset, curves, secondaries, zones and hue shift', () => {
  assert.equal(describeGrading({ hueShift: 15 }), '色相+15°');
  assert.equal(describeGrading({ hueShift: -7.5 }), '色相-7.5°');
  assert.equal(describeGrading({ offset: 0.1, exposure: 0.2 }), '曝光+0.2 · 偏移+0.1');
  assert.equal(describeGrading({ curves: { master: [[0, 0], [1, 1]] } }), '曲线');
  assert.equal(describeGrading({ hueVsSat: [[0, 0], [120, 0.5]] }), '曲线');
  assert.equal(describeGrading({
    secondaries: [{ qualifier: { hue: 20, hueWidth: 30 } }, { qualifier: { hue: 40, hueWidth: 30 } }],
  }), '二级×2');
  assert.equal(describeGrading({ zones: { shadows: { exposure: 0.1 } } }), '分区');
  assert.equal(describeGrading({ zones: { shadowRange: 0.4 } }), '无调色', 'ranges alone are not a marker');
  assert.equal(
    describeGrading({
      hueShift: 15,
      curves: { master: [[0, 0], [1, 1]] },
      secondaries: [{ qualifier: { hue: 20, hueWidth: 30 } }],
      zones: { highlights: { saturation: 0.2 } },
    }),
    '曲线 · 二级×1 · 分区 · 色相+15°',
  );
  assert.equal(describeGrading({ preset: 'showcase-vivid' }), '浓艳风光');
  assert.equal(describeGrading({ preset: 'lantern-night' }), '灯火楼阁');
});
