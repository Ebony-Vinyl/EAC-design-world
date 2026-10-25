import { writeFile } from 'node:fs/promises';

/** Inclusive valid ranges for the six scalar grading controls, exported for external validators. */
export const GRADING_PARAM_RANGES = {
  exposure: [-2, 2], // stops
  contrast: [-1, 1],
  saturation: [-1, 1],
  vibrance: [-1, 1],
  temperature: [-1, 1], // >0 warmer
  tint: [-1, 1], // >0 magenta, <0 green
};

const SCALAR_KEYS = Object.keys(GRADING_PARAM_RANGES);
// Extra scalar controls kept out of GRADING_PARAM_RANGES: offset shares the lift tone scale and
// hueShift is measured in degrees.
const EXTRA_SCALAR_RANGES = { offset: [-0.5, 0.5], hueShift: [-180, 180] };
const SCALAR_RANGES = { ...GRADING_PARAM_RANGES, ...EXTRA_SCALAR_RANGES };
const ALL_SCALAR_KEYS = [...SCALAR_KEYS, ...Object.keys(EXTRA_SCALAR_RANGES)];
const CHANNEL_NAMES = ['r', 'g', 'b'];
const CHANNEL_KEYS = ['lift', 'gamma', 'gain'];
const CHANNEL_DEFAULTS = {
  lift: { r: 0, g: 0, b: 0 },
  gamma: { r: 1, g: 1, b: 1 },
  gain: { r: 1, g: 1, b: 1 },
};
// Per-channel ranges: lift is a shadow-weighted offset, gain a slope and gamma a power exponent.
const CHANNEL_RANGES = { lift: [-0.5, 0.5], gamma: [0.5, 2], gain: [0.5, 2] };
const CURVE_CHANNELS = ['master', ...CHANNEL_NAMES];
const HUE_VS_KEYS = ['hueVsHue', 'hueVsSat', 'hueVsLum'];
const HUE_VS_DELTA_RANGES = { hueVsHue: [-90, 90], hueVsSat: [-1, 1], hueVsLum: [-1, 1] };
const ZONE_KEYS = ['shadows', 'midtones', 'highlights'];
const ZONE_RANGE_RANGES = { shadowRange: [0.1, 0.6], highlightRange: [0.4, 0.9] };
const ZONE_ADJ_SCALARS = ['exposure', 'contrast', 'saturation', 'hueShift'];
const SECONDARY_ADJ_SCALARS = ['exposure', 'contrast', 'saturation', 'vibrance', 'hueShift'];
const QUALIFIER_RANGES = {
  hue: [0, 360], hueWidth: [5, 180], satMin: [0, 1], satMax: [0, 1],
  lumaMin: [0, 1], lumaMax: [0, 1], softness: [0, 0.45],
};
const QUALIFIER_DEFAULTS = { satMin: 0, satMax: 1, lumaMin: 0, lumaMax: 1, softness: 0.08 };
const MAX_SECONDARIES = 4;
const KNOWN_KEYS = [
  ...ALL_SCALAR_KEYS, 'preset', ...CHANNEL_KEYS,
  'curves', ...HUE_VS_KEYS, 'lumVsSat', 'zones', 'secondaries',
];
const DEFAULT_LUT_SIZE = 33;
const MIN_LUT_SIZE = 2;
const MAX_LUT_SIZE = 256;
// Contrast pivot in gamma space, and Rec.709 luma weights for the saturation/vibrance steps.
const CONTRAST_PIVOT = 0.435;
const LUMA_WEIGHTS = { r: 0.2126, g: 0.7152, b: 0.0722 };
// Channel scaling strength at temperature/tint = +/-1: warm raises R and lowers B, tint lowers G.
const WHITE_BALANCE_STRENGTH = 0.25;
// Zone weights fall off over +/-0.12 luma around each range boundary; hueVsLum delta 1 lifts luma.
const ZONE_FEATHER = 0.12;
const HUE_VS_LUMA_STRENGTH = 0.25;

/** Built-in cinematic looks for landscape and travel films; ids are kebab-case ASCII. */
export const GRADING_PRESETS = [
  {
    id: 'clean-landscape', name: '清透风景',
    description: '轻柔对比与自然饱和度提升，微冷色温，适合白天风景与旅行镜头。',
    params: { contrast: 0.12, saturation: 0.05, vibrance: 0.25, temperature: -0.18 },
  },
  {
    id: 'teal-orange', name: '青橙电影',
    description: '阴影偏青、高光偏暖的经典电影对比，适合旅拍大片的强氛围叙事。',
    params: {
      contrast: 0.1, saturation: 0.1,
      lift: { r: -0.04, g: 0, b: 0.06 },
      gain: { r: 1.08, g: 1, b: 0.94 },
    },
  },
  {
    id: 'golden-hour', name: '黄金时刻',
    description: '温暖的金色落日氛围，高光泛橙、暗部微暖，适合日落与逆光镜头。',
    params: {
      exposure: 0.1, temperature: 0.35, tint: 0.05, saturation: 0.12,
      lift: { r: 0.02, g: 0.01, b: -0.03 },
      gain: { r: 1.06, g: 1.01, b: 0.9 },
    },
  },
  {
    id: 'moody-blue', name: '冷调雾蓝',
    description: '冷雾蓝调、轻柔对比与微微灰化的暗部，营造清晨薄雾的冷静氛围。',
    params: {
      contrast: 0.05, temperature: -0.3, saturation: -0.1,
      lift: { r: -0.01, g: 0.01, b: 0.05 },
      gain: { r: 0.96, g: 1, b: 1.06 },
    },
  },
  {
    id: 'film-warm', name: '胶片暖褐',
    description: '模拟胶片暗部灰化与暖褐中间调，低反差的复古氛围。',
    params: {
      contrast: -0.05, temperature: 0.15, saturation: -0.08,
      lift: { r: 0.03, g: 0.025, b: 0.015 },
      gamma: { r: 0.95, g: 0.97, b: 1 },
    },
  },
  {
    id: 'alpine-crisp', name: '高山清冽',
    description: '高对比的清冽冷调，突出雪山蓝天与空气的通透质感。',
    params: {
      contrast: 0.18, temperature: -0.2, vibrance: 0.15,
      lift: { r: -0.02, g: 0, b: 0.02 },
      gain: { r: 0.98, g: 1, b: 1.04 },
    },
  },
  {
    id: 'forest-emerald', name: '森林翠绿',
    description: '绿色通道增强与深林阴影，突出植被层次的自然翠绿。',
    params: {
      contrast: 0.1, tint: -0.18, saturation: 0.08,
      lift: { r: -0.02, g: 0.02, b: -0.02 },
      gamma: { r: 1.03, g: 0.96, b: 1.04 },
    },
  },
  {
    id: 'desert-dust', name: '沙漠尘金',
    description: '尘金色暖调与柔和对比，适合沙漠戈壁与黄昏荒野。',
    params: {
      contrast: 0.08, temperature: 0.25, tint: 0.08, saturation: -0.05,
      lift: { r: 0.03, g: 0.02, b: 0 },
      gain: { r: 1.05, g: 1, b: 0.88 },
    },
  },
  {
    id: 'nordic-pale', name: '北欧灰调',
    description: '低饱和灰调、轻微提亮与柔和对比，冷淡克制的北欧风格。',
    params: {
      exposure: 0.08, contrast: -0.08, saturation: -0.35,
      lift: { r: 0.02, g: 0.025, b: 0.03 },
      gain: { r: 0.98 },
    },
  },
  {
    id: 'silver-bw', name: '银盐黑白',
    description: '经典黑白银盐质感，用通道伽马塑造灰阶并加深对比。',
    params: {
      contrast: 0.18, saturation: -1,
      gamma: { r: 0.98, g: 1, b: 1.04 },
    },
  },
  {
    id: 'showcase-vivid', name: '浓艳风光',
    description: '参考浓艳通透的风光大片观感：深蓝天空、翠绿植被、蓝绿水面，高对比高饱和。',
    params: {
      contrast: 0.22, saturation: 0.18, vibrance: 0.3, temperature: -0.05, tint: -0.04,
      gamma: { r: 1, g: 1, b: 0.96 },
      gain: { r: 1, g: 1, b: 1.03 },
      lift: { r: -0.005, g: 0, b: 0.01 },
    },
  },
  {
    id: 'neon-night', name: '都市夜景',
    description: '黑底高对比都市夜景：高光偏暖橙、暗部偏蓝、霓虹色彩浓郁。',
    params: {
      contrast: 0.25, saturation: 0.22, temperature: 0.08,
      lift: { r: 0, g: 0.005, b: 0.02 },
      gamma: { r: 0.95, g: 1, b: 1.03 },
      gain: { r: 1.06, g: 0.99, b: 0.95 },
    },
  },
  {
    id: 'lantern-night', name: '灯火楼阁',
    description: '暖色灯笼夜景与古建筑夜景，红金灯火突出、夜空沉静。',
    params: {
      contrast: 0.18, saturation: 0.15, temperature: 0.22,
      lift: { r: 0.01, g: 0, b: 0.015 },
      gain: { r: 1.05, g: 1, b: 0.9 },
    },
  },
];

const PRESET_INDEX = new Map(GRADING_PRESETS.map((preset) => [preset.id, preset]));

function fail(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function scalarValue(value, key) {
  const [min, max] = SCALAR_RANGES[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`调色参数 ${key} 必须是 ${min} 到 ${max} 之间的有限数字`);
  }
  if (value < min || value > max) fail(`调色参数 ${key} 必须在 ${min} 到 ${max} 之间`);
  return value;
}

function channelValue(value, name, channel) {
  const [min, max] = CHANNEL_RANGES[name];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`调色参数 ${name}.${channel} 必须是 ${min} 到 ${max} 之间的有限数字`);
  }
  if (value < min || value > max) fail(`调色参数 ${name}.${channel} 必须在 ${min} 到 ${max} 之间`);
  return value;
}

function rejectUnknownKeys(source) {
  for (const key of Object.keys(source)) {
    if (!KNOWN_KEYS.includes(key)) fail(`调色参数不支持字段 "${key}"`);
  }
}

function readScalars(source, target) {
  for (const key of ALL_SCALAR_KEYS) {
    if (source[key] === undefined) continue;
    target[key] = scalarValue(source[key], key);
  }
}

function readChannel(source, name, target) {
  const raw = source[name];
  if (raw === undefined) return;
  if (!isPlainObject(raw)) fail(`调色参数 ${name} 必须是包含 r/g/b 通道的对象`);
  const merged = { ...(target[name] ?? CHANNEL_DEFAULTS[name]) };
  for (const [channel, value] of Object.entries(raw)) {
    if (!CHANNEL_NAMES.includes(channel)) fail(`调色参数 ${name} 不支持通道 "${channel}"`);
    merged[channel] = channelValue(value, name, channel);
  }
  target[name] = merged;
}

/** Validate a standalone (non-merging) r/g/b channel object for zone/secondary adjustments. */
function readStandaloneChannel(value, name, label) {
  if (!isPlainObject(value)) fail(`调色参数 ${label} 必须是包含 r/g/b 通道的对象`);
  const channels = {};
  for (const [channel, entry] of Object.entries(value)) {
    if (!CHANNEL_NAMES.includes(channel)) fail(`调色参数 ${label} 不支持通道 "${channel}"`);
    channels[channel] = channelValue(entry, name, channel);
  }
  return channels;
}

/** Validate a partial zone/secondary adjustment: allowed scalars plus lift/gamma/gain channels. */
function readAdjustment(value, label, allowedScalars) {
  if (!isPlainObject(value)) fail(`调色参数 ${label} 必须是对象`);
  const adjustment = {};
  for (const [key, entry] of Object.entries(value)) {
    if (allowedScalars.includes(key)) {
      adjustment[key] = scalarValue(entry, key);
    } else if (CHANNEL_KEYS.includes(key)) {
      adjustment[key] = readStandaloneChannel(entry, key, `${label}.${key}`);
    } else {
      fail(`调色参数 ${label} 不支持字段 "${key}"`);
    }
  }
  return adjustment;
}

/** Validate a 2..8 point [x, y] curve with x strictly increasing from 0 to 1. */
function readControlPoints(value, label) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 8) {
    fail(`调色参数 ${label} 必须是 2 到 8 个 [x, y] 控制点组成的数组`);
  }
  const points = value.map((point) => {
    if (!Array.isArray(point) || point.length !== 2) {
      fail(`调色参数 ${label} 的每个控制点必须是 [x, y] 两个数字`);
    }
    const [x, y] = point;
    for (const coordinate of [x, y]) {
      if (typeof coordinate !== 'number' || !Number.isFinite(coordinate) || coordinate < 0 || coordinate > 1) {
        fail(`调色参数 ${label} 的控制点坐标必须在 0 到 1 之间`);
      }
    }
    return [x, y];
  });
  if (points[0][0] !== 0) fail(`调色参数 ${label} 的首个控制点 x 必须是 0`);
  if (points[points.length - 1][0] !== 1) fail(`调色参数 ${label} 的末尾控制点 x 必须是 1`);
  for (let i = 1; i < points.length; i++) {
    if (points[i][0] <= points[i - 1][0]) fail(`调色参数 ${label} 的控制点 x 必须严格递增`);
  }
  return points;
}

/** Validate a 2..8 point [anchor, delta] curve, returning the points sorted by anchor. */
function readAnchorPoints(value, label, [deltaMin, deltaMax], anchorMin, anchorMax) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 8) {
    fail(`调色参数 ${label} 必须是 2 到 8 个 [锚点, 强度] 数组`);
  }
  const points = value.map((point) => {
    if (!Array.isArray(point) || point.length !== 2) {
      fail(`调色参数 ${label} 的每一项必须是 [锚点, 强度] 两个数字`);
    }
    const [anchor, delta] = point;
    if (typeof anchor !== 'number' || !Number.isFinite(anchor) || anchor < anchorMin || anchor > anchorMax) {
      fail(`调色参数 ${label} 的锚点必须在 ${anchorMin} 到 ${anchorMax} 之间`);
    }
    if (typeof delta !== 'number' || !Number.isFinite(delta) || delta < deltaMin || delta > deltaMax) {
      fail(`调色参数 ${label} 的强度必须在 ${deltaMin} 到 ${deltaMax} 之间`);
    }
    return [anchor, delta];
  });
  points.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < points.length; i++) {
    if (points[i][0] === points[i - 1][0]) fail(`调色参数 ${label} 的锚点不能重复`);
  }
  return points;
}

function readCurvesField(source, target) {
  const raw = source.curves;
  if (raw === undefined) return;
  if (raw === null) {
    target.curves = null;
    return;
  }
  if (!isPlainObject(raw)) fail('调色参数 curves 必须是包含 master/r/g/b 曲线的对象');
  const curves = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!CURVE_CHANNELS.includes(key)) fail(`调色参数 curves 不支持通道 "${key}"`);
    curves[key] = readControlPoints(value, `curves.${key}`);
  }
  target.curves = curves;
}

function readHueVsFields(source, target) {
  for (const key of HUE_VS_KEYS) {
    const raw = source[key];
    if (raw === undefined) continue;
    target[key] = raw === null
      ? null
      : readAnchorPoints(raw, key, HUE_VS_DELTA_RANGES[key], 0, 360);
  }
  const raw = source.lumVsSat;
  if (raw === undefined) return;
  target.lumVsSat = raw === null ? null : readAnchorPoints(raw, 'lumVsSat', [-1, 1], 0, 1);
}

function readZonesField(source, target) {
  const raw = source.zones;
  if (raw === undefined) return;
  if (raw === null) {
    target.zones = null;
    return;
  }
  if (!isPlainObject(raw)) fail('调色参数 zones 必须是对象');
  const zones = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'shadowRange' || key === 'highlightRange') {
      const [min, max] = ZONE_RANGE_RANGES[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        fail(`调色参数 zones.${key} 必须在 ${min} 到 ${max} 之间`);
      }
      zones[key] = value;
    } else if (ZONE_KEYS.includes(key)) {
      zones[key] = readAdjustment(value, `zones.${key}`, ZONE_ADJ_SCALARS);
    } else {
      fail(`调色参数 zones 不支持字段 "${key}"`);
    }
  }
  zones.shadowRange ??= 0.3;
  zones.highlightRange ??= 0.7;
  target.zones = zones;
}

function readSecondary(item, index) {
  const label = `secondaries[${index}]`;
  if (!isPlainObject(item)) fail(`调色参数 ${label} 必须是对象`);
  for (const key of Object.keys(item)) {
    if (key !== 'qualifier' && key !== 'adjustments') fail(`调色参数 ${label} 不支持字段 "${key}"`);
  }
  if (!isPlainObject(item.qualifier)) fail(`调色参数 ${label}.qualifier 必须是对象`);
  const qualifier = {};
  for (const [key, value] of Object.entries(item.qualifier)) {
    if (!QUALIFIER_RANGES[key]) fail(`调色参数 ${label}.qualifier 不支持字段 "${key}"`);
    const [min, max] = QUALIFIER_RANGES[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      fail(`调色参数 ${label}.qualifier.${key} 必须在 ${min} 到 ${max} 之间`);
    }
    qualifier[key] = value;
  }
  for (const required of ['hue', 'hueWidth']) {
    if (qualifier[required] === undefined) fail(`调色参数 ${label}.qualifier.${required} 必须提供`);
  }
  for (const [key, value] of Object.entries(QUALIFIER_DEFAULTS)) qualifier[key] ??= value;
  if (qualifier.satMin > qualifier.satMax) fail(`调色参数 ${label}.qualifier 的 satMin 不能大于 satMax`);
  if (qualifier.lumaMin > qualifier.lumaMax) fail(`调色参数 ${label}.qualifier 的 lumaMin 不能大于 lumaMax`);
  const adjustments = item.adjustments === undefined ? {} : item.adjustments;
  return {
    qualifier,
    adjustments: readAdjustment(adjustments, `${label}.adjustments`, SECONDARY_ADJ_SCALARS),
  };
}

function readSecondariesField(source, target) {
  const raw = source.secondaries;
  if (raw === undefined) return;
  if (raw === null) {
    target.secondaries = [];
    return;
  }
  if (!Array.isArray(raw)) fail('调色参数 secondaries 必须是数组');
  if (raw.length > MAX_SECONDARIES) {
    fail(`调色参数 secondaries 最多支持 ${MAX_SECONDARIES} 个二级调色`);
  }
  target.secondaries = raw.map(readSecondary);
}

/**
 * Overlay one layer (its preset params first, then its own fields) onto a partial accumulator.
 * Scalars (including offset/hueShift) merge per field and lift/gamma/gain per channel; the
 * structured fields (curves, hue-vs curves, zones, secondaries) are replaced wholesale whenever a
 * layer contains them.
 */
function applyGradingLayer(target, layer) {
  if (layer.preset !== undefined && layer.preset !== null) {
    if (typeof layer.preset !== 'string') fail('调色预设 id 必须是字符串');
    const preset = PRESET_INDEX.get(layer.preset);
    if (!preset) fail(`未知的调色预设 "${layer.preset}"`);
    target.preset = preset.id;
    readScalars(preset.params, target);
    for (const name of CHANNEL_KEYS) readChannel(preset.params, name, target);
  }
  readScalars(layer, target);
  for (const name of CHANNEL_KEYS) readChannel(layer, name, target);
  readCurvesField(layer, target);
  readHueVsFields(layer, target);
  readZonesField(layer, target);
  readSecondariesField(layer, target);
}

function finalizeGrading(fields) {
  const result = {};
  if (fields.preset !== undefined) result.preset = fields.preset;
  for (const key of ALL_SCALAR_KEYS) result[key] = fields[key] ?? 0;
  for (const name of CHANNEL_KEYS) result[name] = { ...CHANNEL_DEFAULTS[name], ...fields[name] };
  result.curves = fields.curves ?? null;
  result.hueVsHue = fields.hueVsHue ?? null;
  result.hueVsSat = fields.hueVsSat ?? null;
  result.hueVsLum = fields.hueVsLum ?? null;
  result.lumVsSat = fields.lumVsSat ?? null;
  result.zones = fields.zones ?? null;
  result.secondaries = fields.secondaries ?? [];
  return result;
}

/**
 * Validate a grading description and fill defaults for every omitted control.
 * Returns null for null/undefined (no grading), otherwise an object with all scalars (exposure,
 * contrast, saturation, vibrance, temperature, tint, offset, hueShift) as finite numbers,
 * lift/gamma/gain as complete {r,g,b} channels, curves/hue-vs/zones as validated structures (or
 * null when absent), secondaries as a validated array (possibly empty), and `preset` kept when a
 * known id was given. A preset resolves to its params first, then the object's own fields override
 * per field/channel; structured fields from the object replace the preset's wholesale.
 * Throws TypeError (Chinese message) on unknown keys, non-numbers, out-of-range or unknown presets.
 */
export function normalizeGrading(grading) {
  if (grading === null || grading === undefined) return null;
  if (!isPlainObject(grading)) fail('调色参数必须是对象，传入 null 或 undefined 表示不调色');
  rejectUnknownKeys(grading);
  const fields = {};
  applyGradingLayer(fields, grading);
  return finalizeGrading(fields);
}

/**
 * Merge grading layers from base (project look) to clip override. Null/undefined layers are skipped;
 * each layer's preset resolves to its params as the base of that layer; numeric fields (including
 * offset/hueShift) override per field and lift/gamma/gain override per channel; a later layer that
 * contains a structured field (curves, hueVsHue/hueVsSat/hueVsLum, lumVsSat, zones, secondaries)
 * replaces the earlier value wholesale — explicit null clears it. Returns the normalized result,
 * or null when every layer is null.
 */
export function mergeGrading(...layers) {
  const fields = {};
  let found = false;
  for (const layer of layers) {
    if (layer === null || layer === undefined) continue;
    if (!isPlainObject(layer)) fail('调色图层必须是对象，null 表示跳过该图层');
    rejectUnknownKeys(layer);
    applyGradingLayer(fields, layer);
    found = true;
  }
  return found ? finalizeGrading(fields) : null;
}

function clampUnit(value) {
  return Math.min(Math.max(Number(value) || 0, 0), 1);
}

function lumaOf(r, g, b) {
  return LUMA_WEIGHTS.r * r + LUMA_WEIGHTS.g * g + LUMA_WEIGHTS.b * b;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

function wrap360(degrees) {
  return ((degrees % 360) + 360) % 360;
}

/** Total RGB->HSV for clamped 0..1 inputs; hue in [0, 360), saturation and value in 0..1. */
function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === r) hue = wrap360(60 * (g - b) / delta);
    else if (max === g) hue = 60 * (b - r) / delta + 120;
    else hue = 60 * (r - g) / delta + 240;
  }
  return [hue, max > 0 ? delta / max : 0, max];
}

/** Total HSV->RGB for hue in [0, 360) and saturation/value clamped to 0..1. */
function hsvToRgb(hue, sat, val) {
  const s = clampUnit(sat);
  const v = clampUnit(val);
  const chroma = v * s;
  const hp = hue / 60;
  const second = chroma * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [chroma, second, 0];
  else if (hp < 2) [r, g, b] = [second, chroma, 0];
  else if (hp < 3) [r, g, b] = [0, chroma, second];
  else if (hp < 4) [r, g, b] = [0, second, chroma];
  else if (hp < 5) [r, g, b] = [second, 0, chroma];
  else [r, g, b] = [chroma, 0, second];
  const m = v - chroma;
  return [r + m, g + m, b + m];
}

/** Scale saturation around Rec.709 luma by a per-pixel factor (1 keeps the pixel unchanged). */
function scaleSaturation(r, g, b, factor) {
  const luma = lumaOf(r, g, b);
  return [luma + (r - luma) * factor, luma + (g - luma) * factor, luma + (b - luma) * factor];
}

/** Vibrance: extra saturation weighted by (1 - pixel saturation), clamped to 0..1. */
function applyVibrance(r, g, b, vibrance) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const pixelSaturation = max > 0 ? Math.min((max - min) / max, 1) : 0;
  const [vr, vg, vb] = scaleSaturation(r, g, b, 1 + vibrance * (1 - pixelSaturation));
  return [clampUnit(vr), clampUnit(vg), clampUnit(vb)];
}

/**
 * Fritsch–Carlson monotone cubic sampler for curve control points. Inputs are clamped to 0..1 and
 * the interpolant never overshoots its control points, so outputs stay inside 0..1.
 */
function createCurveSampler(points) {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const n = xs.length;
  const secants = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) secants[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
  const slopes = new Array(n);
  slopes[0] = secants[0];
  slopes[n - 1] = secants[n - 2];
  for (let i = 1; i < n - 1; i++) {
    slopes[i] = secants[i - 1] * secants[i] <= 0 ? 0 : (secants[i - 1] + secants[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (secants[i] === 0) {
      slopes[i] = 0;
      slopes[i + 1] = 0;
      continue;
    }
    const a = slopes[i] / secants[i];
    const b = slopes[i + 1] / secants[i];
    const square = a * a + b * b;
    if (square > 9) {
      const t = 3 / Math.sqrt(square);
      slopes[i] = t * a * secants[i];
      slopes[i + 1] = t * b * secants[i];
    }
  }
  return (value) => {
    const x = clampUnit(value);
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i]
      + (t3 - 2 * t2 + t) * h * slopes[i]
      + (-2 * t3 + 3 * t2) * ys[i + 1]
      + (t3 - t2) * h * slopes[i + 1];
  };
}

/**
 * Cyclic linear sampler over the 0..360 hue axis: the anchor list wraps around, so the segment
 * between the last anchor and the first anchor (+360) interpolates too. Always returns a delta.
 */
function createHueCurveSampler(points) {
  const anchors = points.map((point) => point[0]);
  const deltas = points.map((point) => point[1]);
  const n = points.length;
  return (hue) => {
    const h = wrap360(hue);
    if (h < anchors[0] || h >= anchors[n - 1]) {
      const span = anchors[0] + 360 - anchors[n - 1];
      if (span <= 0) return deltas[0];
      const shifted = h < anchors[0] ? h + 360 : h;
      const t = (shifted - anchors[n - 1]) / span;
      return deltas[n - 1] + (deltas[0] - deltas[n - 1]) * t;
    }
    for (let i = 0; i < n - 1; i++) {
      if (h < anchors[i + 1]) {
        const t = (h - anchors[i]) / (anchors[i + 1] - anchors[i]);
        return deltas[i] + (deltas[i + 1] - deltas[i]) * t;
      }
    }
    return deltas[n - 1];
  };
}

/** Linear sampler over the 0..1 luma axis, holding the end deltas outside the anchor span. */
function createLumaCurveSampler(points) {
  const anchors = points.map((point) => point[0]);
  const deltas = points.map((point) => point[1]);
  const n = points.length;
  return (value) => {
    const x = clampUnit(value);
    if (x <= anchors[0]) return deltas[0];
    if (x >= anchors[n - 1]) return deltas[n - 1];
    for (let i = 0; i < n - 1; i++) {
      if (x < anchors[i + 1]) {
        const t = (x - anchors[i]) / (anchors[i + 1] - anchors[i]);
        return deltas[i] + (deltas[i + 1] - deltas[i]) * t;
      }
    }
    return deltas[n - 1];
  };
}

/**
 * Compile log-wheel zones into per-pixel weighted adjustment offsets. Weights come from the input
 * pixel's luma: shadows fade out around shadowRange, highlights fade in around highlightRange
 * (both over +/-0.12), midtones take the remainder. Zone adjustments are offsets relative to
 * neutral, folded into the matching global steps, so a neutral zone is a no-op.
 */
function compileZones(zones) {
  if (!zones) return null;
  const entries = [];
  for (const kind of ZONE_KEYS) {
    const adjustment = zones[kind];
    if (!adjustment) continue;
    if (!adjustment.exposure && !adjustment.contrast && !adjustment.saturation && !adjustment.hueShift
      && !adjustment.lift && !adjustment.gamma && !adjustment.gain) continue;
    entries.push({
      kind,
      exposure: adjustment.exposure ?? 0,
      contrast: adjustment.contrast ?? 0,
      saturation: adjustment.saturation ?? 0,
      hueShift: adjustment.hueShift ?? 0,
      lift: [adjustment.lift?.r ?? 0, adjustment.lift?.g ?? 0, adjustment.lift?.b ?? 0],
      gamma: [
        (adjustment.gamma?.r ?? 1) - 1, (adjustment.gamma?.g ?? 1) - 1, (adjustment.gamma?.b ?? 1) - 1,
      ],
      gain: [
        (adjustment.gain?.r ?? 1) - 1, (adjustment.gain?.g ?? 1) - 1, (adjustment.gain?.b ?? 1) - 1,
      ],
    });
  }
  if (!entries.length) return null;
  return {
    shadowLow: zones.shadowRange - ZONE_FEATHER,
    shadowHigh: zones.shadowRange + ZONE_FEATHER,
    highlightLow: zones.highlightRange - ZONE_FEATHER,
    highlightHigh: zones.highlightRange + ZONE_FEATHER,
    entries,
  };
}

/** Precompute the numeric factors of one secondary's adjustment for fast per-pixel application. */
function compileSecondary(secondary) {
  const adjustment = secondary.adjustments;
  return {
    qualifier: secondary.qualifier,
    exposureGain: 2 ** (adjustment.exposure ?? 0),
    contrastFactor: 1 + (adjustment.contrast ?? 0),
    saturationFactor: 1 + (adjustment.saturation ?? 0),
    vibrance: adjustment.vibrance ?? 0,
    hueShift: adjustment.hueShift ?? 0,
    lift: [adjustment.lift?.r ?? 0, adjustment.lift?.g ?? 0, adjustment.lift?.b ?? 0],
    gamma: [adjustment.gamma?.r ?? 1, adjustment.gamma?.g ?? 1, adjustment.gamma?.b ?? 1],
    gain: [adjustment.gain?.r ?? 1, adjustment.gain?.g ?? 1, adjustment.gain?.b ?? 1],
  };
}

/** Soft hue membership: 1 inside hueWidth/2, falling to 0 over the falloff span. */
function circularMembership(hue, center, inner, falloff) {
  const distance = Math.abs(hue - center);
  const span = distance > 180 ? 360 - distance : distance;
  if (span <= inner) return 1;
  if (falloff <= 0 || span >= inner + falloff) return 0;
  return 1 - (span - inner) / falloff;
}

/** Soft range membership: 1 inside [low, high], falling to 0 over `softness` outside each edge. */
function bandMembership(value, low, high, softness) {
  if (value >= low && value <= high) return 1;
  if (softness <= 0) return 0;
  if (value < low) return clampUnit((value - (low - softness)) / softness);
  return clampUnit(1 - (value - high) / softness);
}

/** Per-pixel secondary mask: product of the hue, saturation and luma soft memberships. */
function secondaryMask(qualifier, r, g, b) {
  const [hue, sat] = rgbToHsv(r, g, b);
  const luma = lumaOf(r, g, b);
  return circularMembership(hue, qualifier.hue, qualifier.hueWidth / 2, qualifier.softness * 90)
    * bandMembership(sat, qualifier.satMin, qualifier.satMax, qualifier.softness)
    * bandMembership(luma, qualifier.lumaMin, qualifier.lumaMax, qualifier.softness);
}

/** Apply one secondary's compiled adjustment to a clamped pixel (exposure..hueShift, base order). */
function applySecondaryAdjustment(secondary, r, g, b) {
  const [liftR, liftG, liftB] = secondary.lift;
  const [gammaR, gammaG, gammaB] = secondary.gamma;
  const [gainR, gainG, gainB] = secondary.gain;
  let cr = r * secondary.exposureGain;
  let cg = g * secondary.exposureGain;
  let cb = b * secondary.exposureGain;
  cr = clampUnit(cr * gainR + liftR * (1 - cr)) ** gammaR;
  cg = clampUnit(cg * gainG + liftG * (1 - cg)) ** gammaG;
  cb = clampUnit(cb * gainB + liftB * (1 - cb)) ** gammaB;
  cr = CONTRAST_PIVOT + (cr - CONTRAST_PIVOT) * secondary.contrastFactor;
  cg = CONTRAST_PIVOT + (cg - CONTRAST_PIVOT) * secondary.contrastFactor;
  cb = CONTRAST_PIVOT + (cb - CONTRAST_PIVOT) * secondary.contrastFactor;
  [cr, cg, cb] = scaleSaturation(cr, cg, cb, secondary.saturationFactor);
  if (secondary.vibrance !== 0) [cr, cg, cb] = applyVibrance(cr, cg, cb, secondary.vibrance);
  if (secondary.hueShift !== 0) {
    const [hue, sat, val] = rgbToHsv(clampUnit(cr), clampUnit(cg), clampUnit(cb));
    [cr, cg, cb] = hsvToRgb(wrap360(hue + secondary.hueShift), sat, val);
  }
  return [cr, cg, cb];
}

/**
 * Build the pure pixel transform of an already normalized grading, working in gamma space 0..1:
 * 1. white balance: temperature/tint scale channels by up to +/-25% (warm raises R and lowers B,
 *    positive tint lowers G toward magenta);
 * 2. exposure: multiply every channel by 2 ** exposure, with zone exposure offsets folded in;
 * 3. per-channel ASC-CDL-like slope/offset/power with the lift offset weighted toward shadows, full
 *    at v = 0 and fading linearly to zero at v = 1, so highlights stay untouched and a neutral
 *    mid-gray only shifts by roughly half the lift: v' = clamp(v * gain + lift * (1 - v), 0, 1) ** gamma;
 * 4. the master `offset` added to all channels, before contrast;
 * 5. contrast around the fixed pivot 0.435: v' = pivot + (v - pivot) * (1 + contrast);
 * 6. optional curves: monotone cubic per channel (master first, then r/g/b), inputs clamped to 0..1;
 * 7. saturation toward Rec.709 luma: v' = luma + (v - luma) * (1 + saturation), with zone
 *    saturation folded into the factor;
 * 8. vibrance: extra saturation weighted by (1 - pixel saturation), pixel saturation being
 *    (max - min) / max capped at 1 with a max === 0 guard;
 * 9. hue stage (only when hue work is present): HSV roundtrip applying hueVsHue then hueShift
 *    rotation and a hueVsSat factor keyed on the original hue, then lumVsSat around Rec.709 luma,
 *    then hueVsLum as a luma offset of delta * 0.25;
 * 10. secondaries in order: each qualifies the current pixel with a soft hue/saturation/luma mask
 *     and blends its adjustment on top (mask 0 keeps the base result, 1 applies it fully);
 * 11. final clamp to 0..1.
 * Zone weights come from the input pixel's luma via smoothstep and fold their weighted adjustments
 * into steps 2/3/5/7/9, so a zone with all-neutral adjustment is a no-op.
 * The result is clamped to 0..1; the transform is deterministic and total (never NaN).
 */
function createGradingTransform(params) {
  const exposureGain = 2 ** params.exposure;
  const warmFactorR = 1 + WHITE_BALANCE_STRENGTH * params.temperature;
  const warmFactorB = 1 - WHITE_BALANCE_STRENGTH * params.temperature;
  const tintFactorG = 1 - WHITE_BALANCE_STRENGTH * params.tint;
  const { lift, gamma, gain } = params;
  const contrastFactor = 1 + params.contrast;
  const saturationFactor = 1 + params.saturation;
  const { vibrance, offset, hueShift } = params;

  const zoneData = compileZones(params.zones);
  const masterCurve = params.curves?.master ? createCurveSampler(params.curves.master) : null;
  const redCurve = params.curves?.r ? createCurveSampler(params.curves.r) : null;
  const greenCurve = params.curves?.g ? createCurveSampler(params.curves.g) : null;
  const blueCurve = params.curves?.b ? createCurveSampler(params.curves.b) : null;
  const hueVsHueCurve = params.hueVsHue ? createHueCurveSampler(params.hueVsHue) : null;
  const hueVsSatCurve = params.hueVsSat ? createHueCurveSampler(params.hueVsSat) : null;
  const hueVsLumCurve = params.hueVsLum ? createHueCurveSampler(params.hueVsLum) : null;
  const lumVsSatCurve = params.lumVsSat ? createLumaCurveSampler(params.lumVsSat) : null;
  const zoneHueShiftUsed = zoneData !== null
    && zoneData.entries.some((entry) => entry.hueShift !== 0);
  const hasHueStage = hueShift !== 0 || zoneHueShiftUsed
    || hueVsHueCurve || hueVsSatCurve || hueVsLumCurve || lumVsSatCurve;
  const secondaries = params.secondaries.map(compileSecondary);

  const runHueStage = (r, g, b, extraHueShift) => {
    let cr = clampUnit(r);
    let cg = clampUnit(g);
    let cb = clampUnit(b);
    let hueKey = 0;
    const totalHueShift = hueShift + extraHueShift;
    if (hueVsHueCurve || hueVsSatCurve || hueVsLumCurve || totalHueShift !== 0) {
      const [originalHue, sat0, val] = rgbToHsv(cr, cg, cb);
      hueKey = originalHue;
      let hue = originalHue;
      if (hueVsHueCurve) hue = wrap360(hue + hueVsHueCurve(originalHue));
      if (totalHueShift !== 0) hue = wrap360(hue + totalHueShift);
      const sat = hueVsSatCurve ? clampUnit(sat0 * (1 + hueVsSatCurve(originalHue))) : sat0;
      [cr, cg, cb] = hsvToRgb(hue, sat, val);
    }
    if (lumVsSatCurve) {
      const luma = lumaOf(cr, cg, cb);
      const factor = 1 + lumVsSatCurve(luma);
      cr = luma + (cr - luma) * factor;
      cg = luma + (cg - luma) * factor;
      cb = luma + (cb - luma) * factor;
    }
    if (hueVsLumCurve) {
      const shift = hueVsLumCurve(hueKey) * HUE_VS_LUMA_STRENGTH;
      cr += shift;
      cg += shift;
      cb += shift;
    }
    return [cr, cg, cb];
  };

  return (red, green, blue) => {
    const inR = clampUnit(red);
    const inG = clampUnit(green);
    const inB = clampUnit(blue);
    let zoneExposure = 0;
    let zoneContrast = 0;
    let zoneSaturation = 0;
    let zoneHueShift = 0;
    let zoneLiftR = 0;
    let zoneLiftG = 0;
    let zoneLiftB = 0;
    let zoneGammaR = 0;
    let zoneGammaG = 0;
    let zoneGammaB = 0;
    let zoneGainR = 0;
    let zoneGainG = 0;
    let zoneGainB = 0;
    if (zoneData) {
      const lumaIn = lumaOf(inR, inG, inB);
      const shadowW = 1 - smoothstep(zoneData.shadowLow, zoneData.shadowHigh, lumaIn);
      const highlightW = smoothstep(zoneData.highlightLow, zoneData.highlightHigh, lumaIn);
      const midW = Math.min(Math.max(1 - shadowW - highlightW, 0), 1);
      for (const entry of zoneData.entries) {
        const weight = entry.kind === 'shadows' ? shadowW
          : entry.kind === 'midtones' ? midW : highlightW;
        if (weight <= 0) continue;
        zoneExposure += weight * entry.exposure;
        zoneContrast += weight * entry.contrast;
        zoneSaturation += weight * entry.saturation;
        zoneHueShift += weight * entry.hueShift;
        zoneLiftR += weight * entry.lift[0];
        zoneLiftG += weight * entry.lift[1];
        zoneLiftB += weight * entry.lift[2];
        zoneGammaR += weight * entry.gamma[0];
        zoneGammaG += weight * entry.gamma[1];
        zoneGammaB += weight * entry.gamma[2];
        zoneGainR += weight * entry.gain[0];
        zoneGainG += weight * entry.gain[1];
        zoneGainB += weight * entry.gain[2];
      }
    }
    const pixelExposure = exposureGain * 2 ** zoneExposure;
    let r = inR * warmFactorR * pixelExposure;
    let g = inG * tintFactorG * pixelExposure;
    let b = inB * warmFactorB * pixelExposure;
    r = clampUnit(r * (gain.r + zoneGainR) + (lift.r + zoneLiftR) * (1 - r)) ** (gamma.r + zoneGammaR);
    g = clampUnit(g * (gain.g + zoneGainG) + (lift.g + zoneLiftG) * (1 - g)) ** (gamma.g + zoneGammaG);
    b = clampUnit(b * (gain.b + zoneGainB) + (lift.b + zoneLiftB) * (1 - b)) ** (gamma.b + zoneGammaB);
    r += offset;
    g += offset;
    b += offset;
    const pixelContrast = contrastFactor + zoneContrast;
    r = CONTRAST_PIVOT + (r - CONTRAST_PIVOT) * pixelContrast;
    g = CONTRAST_PIVOT + (g - CONTRAST_PIVOT) * pixelContrast;
    b = CONTRAST_PIVOT + (b - CONTRAST_PIVOT) * pixelContrast;
    if (masterCurve) {
      r = masterCurve(r);
      g = masterCurve(g);
      b = masterCurve(b);
    }
    if (redCurve) r = redCurve(r);
    if (greenCurve) g = greenCurve(g);
    if (blueCurve) b = blueCurve(b);
    [r, g, b] = scaleSaturation(r, g, b, saturationFactor + zoneSaturation);
    [r, g, b] = applyVibrance(r, g, b, vibrance);
    if (hasHueStage) [r, g, b] = runHueStage(r, g, b, zoneHueShift);
    if (secondaries.length) {
      let cr = clampUnit(r);
      let cg = clampUnit(g);
      let cb = clampUnit(b);
      for (const secondary of secondaries) {
        const mask = secondaryMask(secondary.qualifier, cr, cg, cb);
        if (mask <= 0) continue;
        const [ar, ag, ab] = applySecondaryAdjustment(secondary, cr, cg, cb);
        cr = clampUnit(cr + (ar - cr) * mask);
        cg = clampUnit(cg + (ag - cg) * mask);
        cb = clampUnit(cb + (ab - cb) * mask);
      }
      r = cr;
      g = cg;
      b = cb;
    }
    return [clampUnit(r), clampUnit(g), clampUnit(b)];
  };
}

/**
 * Compile a grading into a pure (r, g, b) => [r, g, b] pixel transform clamped to 0..1.
 * null/undefined grading yields an identity transform; invalid gradings throw TypeError.
 */
export function gradingToTransform(grading) {
  if (grading === null || grading === undefined) {
    return (r, g, b) => [clampUnit(r), clampUnit(g), clampUnit(b)];
  }
  return createGradingTransform(normalizeGrading(grading));
}

/**
 * Render the full .cube 3D LUT text for a grading: two "# " comment lines ("# EAC design world" and
 * "# <preset id or 'custom'>"), TITLE, LUT_3D_SIZE, DOMAIN_MIN/MAX, then size^3 data lines "R G B"
 * with 6 decimals and the red index varying fastest. Every grading feature is baked into the LUT,
 * so hosts like 剪映/Premiere/Photoshop/Resolve render exactly what the engine previews.
 * null/undefined grading throws TypeError.
 */
export function generateCubeLut(grading, size = DEFAULT_LUT_SIZE) {
  if (grading === null || grading === undefined) fail('生成 LUT 需要调色参数，不能为 null');
  if (!Number.isInteger(size) || size < MIN_LUT_SIZE || size > MAX_LUT_SIZE) {
    fail(`LUT 尺寸必须是 ${MIN_LUT_SIZE} 到 ${MAX_LUT_SIZE} 之间的整数`);
  }
  const params = normalizeGrading(grading);
  const transform = createGradingTransform(params);
  const label = params.preset ?? 'custom';
  const lines = [
    '# EAC design world',
    `# ${label}`,
    `TITLE ${label}`,
    `LUT_3D_SIZE ${size}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
  ];
  const last = size - 1;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const [outR, outG, outB] = transform(r / last, g / last, b / last);
        lines.push(`${outR.toFixed(6)} ${outG.toFixed(6)} ${outB.toFixed(6)}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

function canceled() {
  const error = new Error('调色 LUT 写入已取消');
  error.name = 'AbortError';
  return error;
}

/** Write the .cube LUT for a grading to path as UTF-8, honoring an optional AbortSignal. */
export async function writeCubeLut(grading, path, { size = DEFAULT_LUT_SIZE, signal } = {}) {
  if (signal?.aborted) throw canceled();
  if (typeof path !== 'string' || !path.trim()) fail('LUT 输出路径必须是非空字符串');
  const content = generateCubeLut(grading, size);
  if (signal?.aborted) throw canceled();
  await writeFile(path, content, { encoding: 'utf8', signal });
}

const SCALAR_LABELS = {
  exposure: '曝光', contrast: '对比度', saturation: '饱和度',
  vibrance: '自然饱和度', temperature: '色温', tint: '色调', offset: '偏移',
};
const CHANNEL_LABELS = { lift: '暗部', gamma: '伽马', gain: '增益' };
const DESCRIBE_SCALAR_KEYS = [...SCALAR_KEYS, 'offset'];

function signedNumber(value) {
  return `${value < 0 ? '-' : '+'}${Math.round(Math.abs(value) * 100) / 100}`;
}

/**
 * Summarize a grading as one Chinese line for AI logs, e.g. "青橙电影 · 曝光+0.3 · 色温+0.2".
 * With a preset, only deviations from the preset's own params are listed; markers are appended for
 * the advanced features ("曲线" for curves/hue-vs, "二级×N", "分区", "色相±X°"), and null or a
 * no-op grading returns "无调色".
 */
export function describeGrading(grading) {
  if (grading === null || grading === undefined) return '无调色';
  const params = normalizeGrading(grading);
  const preset = params.preset ? PRESET_INDEX.get(params.preset) : null;
  const baseline = preset ? normalizeGrading(preset.params) : null;
  const parts = [];
  if (preset) parts.push(preset.name);
  for (const key of DESCRIBE_SCALAR_KEYS) {
    const delta = params[key] - (baseline?.[key] ?? 0);
    if (delta !== 0) parts.push(`${SCALAR_LABELS[key]}${signedNumber(delta)}`);
  }
  for (const name of CHANNEL_KEYS) {
    const base = baseline?.[name] ?? CHANNEL_DEFAULTS[name];
    const deltas = CHANNEL_NAMES.map((channel) => params[name][channel] - base[channel]);
    if (deltas.every((delta) => delta === 0)) continue;
    if (deltas[0] === deltas[1] && deltas[1] === deltas[2]) {
      parts.push(`${CHANNEL_LABELS[name]}${signedNumber(deltas[0])}`);
      continue;
    }
    const values = CHANNEL_NAMES
      .map((channel, index) => deltas[index] === 0 ? null : `${channel.toUpperCase()}${signedNumber(deltas[index])}`)
      .filter((text) => text !== null);
    parts.push(`${CHANNEL_LABELS[name]}(${values.join(',')})`);
  }
  const hasCurves = (params.curves && Object.keys(params.curves).length > 0)
    || params.hueVsHue || params.hueVsSat || params.hueVsLum || params.lumVsSat;
  if (hasCurves) parts.push('曲线');
  if (params.secondaries.length) parts.push(`二级×${params.secondaries.length}`);
  const hasZones = params.zones && ZONE_KEYS.some((key) => {
    const adjustment = params.zones[key];
    return adjustment && Object.keys(adjustment).length > 0;
  });
  if (hasZones) parts.push('分区');
  const hueDelta = params.hueShift - (baseline?.hueShift ?? 0);
  if (hueDelta !== 0) parts.push(`色相${signedNumber(hueDelta)}°`);
  return parts.length ? parts.join(' · ') : '无调色';
}
