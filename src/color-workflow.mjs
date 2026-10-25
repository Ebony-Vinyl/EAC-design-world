import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname } from 'node:path';

/**
 * Non-destructive color workflow helpers: strict .cube validation, saved grade versions that never
 * touch the edit, and bounded exposure-only shot matching from measured preview luma.
 * Everything here is local and deterministic; no external service and no "AI quality score".
 */

/** Hard cap on a .cube file; a 65^3 LUT fits comfortably below this. */
export const MAX_CUBE_BYTES = 16 * 1024 * 1024;
const MIN_CUBE_SIZE = 2;
const MAX_CUBE_SIZE = 65;
const MAX_VERSIONS = 50;
const MAX_NAME_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 280;
const EXPOSURE_STEP = 0.05;
const DEFAULT_MAX_EXPOSURE = 0.5;
const MIN_MAX_EXPOSURE = 0.1;
const MAX_MAX_EXPOSURE = 2;
const BLACK_LUMA = 20;
const WHITE_LUMA = 235;
const CLIP_RATIO = 0.02;
const LUMA_SPREAD_LIMIT = 25;
const NUMBER_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

const COLOR_CLIP_FIELDS = ['grading', 'inputLut', 'lut', 'windows'];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function cubeError(message) {
  return new Error(`LUT 无效：${message}`);
}

function parseNumberToken(token, label) {
  if (!NUMBER_PATTERN.test(token)) throw cubeError(`${label} 必须是有限数字，收到 "${token}"`);
  const value = Number(token);
  // The regex admits overflow literals such as 1e999, which Number() turns into Infinity.
  if (!Number.isFinite(value)) throw cubeError(`${label} 超出有限数字范围，收到 "${token}"`);
  return value;
}

/**
 * Strictly parse a 3D .cube LUT text. Supports comments (#), blank lines, one optional TITLE, one
 * LUT_3D_SIZE (integer 2..65) and optional DOMAIN_MIN/DOMAIN_MAX with three finite numbers each.
 * Requires exactly size^3 data rows of three finite numbers (red index fastest) and rejects
 * LUT_1D_*, duplicate keywords, unknown keywords and keywords after the data block.
 * Returns { size, title, domainMin, domainMax, entryCount, data } with `data` a Float32Array of
 * size^3 * 3 channel values. Throws Error (Chinese message) on any deviation, TypeError on
 * non-string input.
 */
export function parseCubeLut(text) {
  if (typeof text !== 'string') throw new TypeError('LUT 文本必须是字符串');
  let size;
  let title = null;
  let domainMin = [0, 0, 0];
  let domainMax = [1, 1, 1];
  let sawDomainMin = false;
  let sawDomainMax = false;
  let data = null;
  let dataCount = 0;
  let inData = false;
  const rows = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const [lineNumber, raw] of rows.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const tokens = line.split(/\s+/);
    const keyword = tokens[0];
    const isDataRow = NUMBER_PATTERN.test(keyword);
    if (inData && !isDataRow) throw cubeError(`数据区之后不允许关键字 "${keyword}"（第 ${lineNumber + 1} 行）`);
    if (isDataRow) {
      if (size === undefined) throw cubeError('数据行出现在 LUT_3D_SIZE 之前');
      if (tokens.length !== 3) throw cubeError(`数据行必须是 3 个数字（第 ${lineNumber + 1} 行）`);
      data ??= new Float32Array(size ** 3 * 3);
      if (dataCount >= size ** 3) throw cubeError(`数据行超过 LUT_3D_SIZE ${size} 要求的 ${size ** 3} 行`);
      for (let channel = 0; channel < 3; channel++) {
        const value = parseNumberToken(tokens[channel], 'LUT 数据');
        // Float32Array silently turns values above ~3.4e38 into Infinity; reject those too.
        const stored = Math.fround(value);
        if (!Number.isFinite(stored)) {
          throw cubeError(`LUT 数据 ${value} 超出 32 位浮点范围（第 ${lineNumber + 1} 行）`);
        }
        data[dataCount * 3 + channel] = stored;
      }
      dataCount++;
      inData = true;
      continue;
    }
    if (keyword === 'LUT_1D_SIZE' || keyword === 'LUT_1D_INPUT_RANGE') {
      throw cubeError(`只支持 3D LUT，不支持 ${keyword}`);
    }
    if (keyword === 'LUT_3D_SIZE') {
      if (size !== undefined) throw cubeError('LUT_3D_SIZE 重复出现');
      if (tokens.length !== 2) throw cubeError('LUT_3D_SIZE 必须带一个尺寸值');
      const value = parseNumberToken(tokens[1], 'LUT_3D_SIZE');
      if (!Number.isInteger(value) || value < MIN_CUBE_SIZE || value > MAX_CUBE_SIZE) {
        throw cubeError(`LUT_3D_SIZE 必须是 ${MIN_CUBE_SIZE} 到 ${MAX_CUBE_SIZE} 之间的整数`);
      }
      size = value;
      continue;
    }
    if (keyword === 'TITLE') {
      if (title !== null) throw cubeError('TITLE 重复出现');
      title = tokens.slice(1).join(' ').trim();
      if (!title) throw cubeError('TITLE 不能为空');
      continue;
    }
    if (keyword === 'DOMAIN_MIN' || keyword === 'DOMAIN_MAX') {
      if (tokens.length !== 4) throw cubeError(`${keyword} 必须带 3 个数字`);
      const values = [1, 2, 3].map((index) => parseNumberToken(tokens[index], keyword));
      if (keyword === 'DOMAIN_MIN') {
        if (sawDomainMin) throw cubeError('DOMAIN_MIN 重复出现');
        sawDomainMin = true;
        domainMin = values;
      } else {
        if (sawDomainMax) throw cubeError('DOMAIN_MAX 重复出现');
        sawDomainMax = true;
        domainMax = values;
      }
      continue;
    }
    throw cubeError(`不支持的关键字 "${keyword}"（第 ${lineNumber + 1} 行）`);
  }
  if (size === undefined) throw cubeError('缺少 LUT_3D_SIZE');
  const entryCount = size ** 3;
  if (dataCount !== entryCount) {
    throw cubeError(`数据行数量 ${dataCount} 与 LUT_3D_SIZE ${size} 要求的 ${entryCount} 行不一致`);
  }
  for (let channel = 0; channel < 3; channel++) {
    if (!(domainMin[channel] < domainMax[channel])) {
      throw cubeError(`DOMAIN_MIN 必须在每一通道小于 DOMAIN_MAX（通道 ${channel}）`);
    }
  }
  return { size, title, domainMin, domainMax, entryCount, data };
}

/**
 * Validate a local .cube file before storing it on a clip. Returns
 * { path, size, bytes, title, domainMin, domainMax, entryCount } where `path` is the canonical
 * absolute path (realpath). Rejects non-.cube names, missing paths, directories, files larger than
 * MAX_CUBE_BYTES and every strict parse failure. Throws TypeError for a non-string path.
 */
export async function validateCubeFile(path) {
  if (typeof path !== 'string' || !path.trim() || path.includes('\0')) {
    throw new TypeError('LUT 路径必须是非空本地文件路径');
  }
  if (extname(path).toLowerCase() !== '.cube') throw new TypeError('LUT 只支持 .cube 文件');
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`LUT 文件不存在：${path}`);
    throw error;
  }
  if (!info.isFile()) throw new Error(`LUT 路径不是文件：${path}`);
  if (info.size > MAX_CUBE_BYTES) {
    throw new Error(`LUT 文件过大（${info.size} 字节），上限 ${MAX_CUBE_BYTES} 字节`);
  }
  const parsed = parseCubeLut(await readFile(path, 'utf8'));
  return {
    path: await realpath(path),
    size: parsed.size,
    bytes: info.size,
    title: parsed.title,
    domainMin: parsed.domainMin,
    domainMax: parsed.domainMax,
    entryCount: parsed.entryCount,
  };
}

function requireProject(project) {
  if (!isPlainObject(project)) throw new TypeError('项目必须是对象');
  if (!Array.isArray(project.clips)) throw new TypeError('项目缺少 clips 数组');
}

function requireClipIds(project) {
  const ids = project.clips.map((clip, index) => {
    if (!isPlainObject(clip) || typeof clip.id !== 'string' || !clip.id) {
      throw new TypeError(`片段 ${index} 缺少 id，无法记录调色版本`);
    }
    return clip.id;
  });
  if (new Set(ids).size !== ids.length) throw new TypeError('片段 id 重复，无法记录调色版本');
  return ids;
}

/**
 * Save the current color state as a new grade version and return a new project object.
 * Captures project.look plus per clip { clipId, grading, inputLut, lut, windows } and the clip id
 * order; cuts, captions and every other field are left untouched. The input project is never
 * mutated and no revision is bumped (the store update does that). Throws TypeError on a bad
 * name/description/clip id and Error when MAX_VERSIONS is reached.
 */
export function saveGradeVersion(project, { name, description } = {}) {
  requireProject(project);
  if (typeof name !== 'string' || !name.trim()) throw new TypeError('调色版本名称必须是非空字符串');
  const trimmed = name.trim();
  if (trimmed.length > MAX_NAME_LENGTH) throw new TypeError(`调色版本名称不能超过 ${MAX_NAME_LENGTH} 字`);
  if (description !== undefined && description !== null && typeof description !== 'string') {
    throw new TypeError('调色版本说明必须是字符串');
  }
  const note = description === undefined || description === null ? null : description.trim();
  if (note !== null && note.length > MAX_DESCRIPTION_LENGTH) {
    throw new TypeError(`调色版本说明不能超过 ${MAX_DESCRIPTION_LENGTH} 字`);
  }
  const clipIds = requireClipIds(project);
  const versions = project.gradeVersions ?? [];
  if (!Array.isArray(versions)) throw new TypeError('项目 gradeVersions 必须是数组');
  if (versions.length >= MAX_VERSIONS) throw new Error(`调色版本最多保存 ${MAX_VERSIONS} 个，请先清理旧版本`);
  const next = structuredClone(project);
  next.gradeVersions = structuredClone(versions);
  next.gradeVersions.push({
    id: randomUUID(),
    name: trimmed,
    description: note,
    createdAt: new Date().toISOString(),
    look: structuredClone(project.look ?? null),
    clipIds,
    clips: project.clips.map((clip) => {
      const record = { clipId: clip.id };
      for (const key of COLOR_CLIP_FIELDS) record[key] = clip[key] === undefined ? null : structuredClone(clip[key]);
      return record;
    }),
  });
  return next;
}

function findVersion(project, versionId) {
  if (typeof versionId === 'string' && versionId.trim()) {
    const version = (project.gradeVersions ?? []).find((entry) => entry?.id === versionId);
    if (!version) throw new Error(`调色版本不存在：${versionId}`);
    return version;
  }
  if (isPlainObject(versionId) && typeof versionId.versionId === 'string') {
    return findVersion(project, versionId.versionId);
  }
  throw new TypeError('restoreGradeVersion 需要调色版本 id');
}

/**
 * Restore one saved grade version onto the current project and return a new project object.
 * Only project.look and each clip's grading/inputLut/lut/windows change; start, duration,
 * sourceIn, captions and every other edit field stay exactly as they are now. Clips are matched by
 * id in any order and fields the version recorded as absent are deleted. Throws when the version
 * id is unknown or the current clip id set differs from the saved one (a clip was added or
 * removed); a failing call never partially changes anything. Accepts the id directly or
 * { versionId }.
 */
export function restoreGradeVersion(project, versionId) {
  requireProject(project);
  const version = findVersion(project, versionId);
  const currentIds = requireClipIds(project);
  const savedIds = Array.isArray(version.clipIds) ? version.clipIds : [];
  const sameSet = currentIds.length === savedIds.length
    && currentIds.every((id) => savedIds.includes(id));
  if (!sameSet) {
    throw new Error('当前时间线的片段与调色版本不一致（新增或删除了片段），无法恢复；请撤销剪辑改动或另存新版本');
  }
  const byClip = new Map((version.clips ?? []).map((record) => [record?.clipId, record]));
  const next = structuredClone(project);
  next.look = structuredClone(version.look ?? null);
  for (const clip of next.clips) {
    const record = byClip.get(clip.id);
    if (!record) throw new Error(`调色版本缺少片段 ${clip.id} 的记录`);
    for (const key of COLOR_CLIP_FIELDS) {
      const value = record[key];
      if (value === undefined || value === null) delete clip[key];
      else clip[key] = structuredClone(value);
    }
  }
  return next;
}

function groupKey(frame) {
  return typeof frame.clipId === 'string' && frame.clipId ? frame.clipId : `index:${frame.clipIndex}`;
}

/** Read an optional 0..1 ratio from graded stats, rejecting non-finite or out-of-range values. */
function readRatio(stats, key, position) {
  const value = stats[key];
  if (value === undefined || value === null) return 0;
  if (!finiteNumber(value) || value < 0 || value > 1) {
    throw new TypeError(`预览帧 ${position} 的 graded.${key} 必须是 0 到 1 之间的有限数字`);
  }
  return value;
}

/**
 * Group preview frames per clip using the *graded* stats; original-only frames are unusable.
 * Highlight clipping and shadow crush take the worst value across all sampled frames, so one bad
 * frame cannot be hidden by a clean frame, and luma outliers must stay inside 0..255.
 */
function sampleGroups(frames) {
  const groups = new Map();
  for (const [position, frame] of frames.entries()) {
    if (!isPlainObject(frame)) throw new TypeError(`预览帧 ${position} 必须是对象`);
    const stats = frame.graded;
    if (!isPlainObject(stats) || !finiteNumber(stats.lumaAvg)) {
      throw new TypeError(`预览帧 ${position} 缺少调色后的 graded.lumaAvg；请先重新生成 grade-preview`);
    }
    if (stats.lumaAvg < 0 || stats.lumaAvg > 255) {
      throw new TypeError(`预览帧 ${position} 的 graded.lumaAvg 必须在 0 到 255 之间`);
    }
    if (!Number.isInteger(frame.clipIndex)) throw new TypeError(`预览帧 ${position} 缺少 clipIndex`);
    const key = groupKey(frame);
    const group = groups.get(key) ?? {
      clipId: typeof frame.clipId === 'string' && frame.clipId ? frame.clipId : null,
      clipIndex: frame.clipIndex,
      lumas: [],
      highlightClip: 0,
      shadowCrush: 0,
    };
    group.lumas.push(stats.lumaAvg);
    group.highlightClip = Math.max(group.highlightClip, readRatio(stats, 'highlightClip', position));
    group.shadowCrush = Math.max(group.shadowCrush, readRatio(stats, 'shadowCrush', position));
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const lumaAvg = group.lumas.reduce((sum, value) => sum + value, 0) / group.lumas.length;
    return {
      clipId: group.clipId,
      clipIndex: group.clipIndex,
      lumaAvg,
      spread: Math.max(...group.lumas) - Math.min(...group.lumas),
      sampleCount: group.lumas.length,
      highlightClip: group.highlightClip,
      shadowCrush: group.shadowCrush,
    };
  });
}

function sampleProblem(sample) {
  if (sample.spread > LUMA_SPREAD_LIMIT) {
    return `多帧亮度不稳定（跨度 ${sample.spread.toFixed(0)}），需人工确认`;
  }
  if (sample.highlightClip >= CLIP_RATIO) {
    return `高光裁切 ${(sample.highlightClip * 100).toFixed(0)}%，样本不可靠`;
  }
  if (sample.shadowCrush >= CLIP_RATIO) {
    return `暗部死黑 ${(sample.shadowCrush * 100).toFixed(0)}%，样本不可靠`;
  }
  if (sample.lumaAvg < BLACK_LUMA) return '实测亮度接近纯黑，无法可靠匹配';
  if (sample.lumaAvg > WHITE_LUMA) return '实测亮度接近纯白，无法可靠匹配';
  return null;
}

/**
 * Snap to the next 0.05 grid step in the direction of the correction (ceil in magnitude). This is a
 * coarse grid, not an exact stop value: it merely avoids suggesting less than the measured gap.
 */
function quantizeExposure(value) {
  const magnitude = Math.ceil(Math.abs(value) / EXPOSURE_STEP - 1e-9) * EXPOSURE_STEP;
  return Number((Math.sign(value) * magnitude).toFixed(2));
}

function round(value, digits = 2) {
  return Number(value.toFixed(digits));
}

/**
 * Suggest exposure-only shot matching from a gradePreview result. Compares each clip's measured
 * *graded* luma (never the original) with the reference clip and returns exposureDelta relative to
 * that clip's current grade, bounded to +/- maxExposure. Black, white, clipped, crushed and
 * unstable samples go to needsReview instead of receiving a number. This is a coarse measured-luma
 * heuristic, not an exact stop calculation and not an artistic judgment. Throws when the preview
 * is missing/unusable, no reliable reference sample exists, or maxExposure is out of range.
 */
export function suggestShotMatch(preview, { referenceClipId, referenceClipIndex, maxExposure = DEFAULT_MAX_EXPOSURE } = {}) {
  if (!isPlainObject(preview) || !Array.isArray(preview.frames) || !preview.frames.length) {
    throw new Error('缺少可用的调色预览帧，请先执行 grade-preview 再匹配镜头');
  }
  if (typeof referenceClipId !== 'string' && !Number.isInteger(referenceClipIndex)) {
    throw new TypeError('suggestShotMatch 需要 referenceClipId 或 referenceClipIndex');
  }
  if (!finiteNumber(maxExposure) || maxExposure < MIN_MAX_EXPOSURE || maxExposure > MAX_MAX_EXPOSURE) {
    throw new TypeError(`maxExposure 必须在 ${MIN_MAX_EXPOSURE} 到 ${MAX_MAX_EXPOSURE} 之间`);
  }
  const samples = sampleGroups(preview.frames);
  const reference = samples.find((sample) => (typeof referenceClipId === 'string'
    ? sample.clipId === referenceClipId
    : sample.clipIndex === referenceClipIndex));
  if (!reference) throw new Error('预览中没有参考片段的有效样本');
  const referenceProblem = sampleProblem(reference);
  if (referenceProblem) throw new Error(`参考片段不能作为可靠基准：${referenceProblem}`);
  const recommendations = [];
  const needsReview = [];
  for (const sample of samples) {
    if (sample === reference) continue;
    const problem = sampleProblem(sample);
    const base = {
      clipId: sample.clipId, clipIndex: sample.clipIndex, measuredLuma: round(sample.lumaAvg),
      referenceLuma: round(reference.lumaAvg), sampleCount: sample.sampleCount,
    };
    if (problem) {
      needsReview.push({ ...base, reason: problem });
      continue;
    }
    const needed = Math.log2(reference.lumaAvg / Math.max(sample.lumaAvg, 1));
    if (Math.abs(needed) < EXPOSURE_STEP) continue;
    const delta = quantizeExposure(needed);
    if (Math.abs(delta) > maxExposure) {
      needsReview.push({
        ...base,
        neededExposure: delta,
        reason: `相对当前需要 ${delta > 0 ? '+' : ''}${delta.toFixed(2)} 曝光，超出单次安全上限 ±${maxExposure}，请人工确认`,
      });
      continue;
    }
    recommendations.push({
      ...base,
      exposureDelta: delta,
      exposure: delta, // deprecated alias; it is a delta relative to the current grade, not absolute
      reason: `相对当前调色 ${delta > 0 ? '+' : ''}${delta.toFixed(2)} 曝光（实测亮度 ${round(sample.lumaAvg)} / 参考 ${round(reference.lumaAvg)}），仅按亮度粗估，请用 grade-preview 复核`,
    });
  }
  return {
    referenceClipId: reference.clipId,
    reference: {
      clipId: reference.clipId, clipIndex: reference.clipIndex,
      lumaAvg: round(reference.lumaAvg), sampleCount: reference.sampleCount,
    },
    recommendations,
    needsReview,
    method: 'measured-graded-luma',
    bounded: true,
    maxExposure,
    disclaimer: '仅按实测调色后亮度给出有界粗估曝光增量，不代表艺术判断或完美镜头匹配，也不是精确曝光档换算；最终请用 grade-preview 人工复核。',
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Stable sha256 signature of only the color state: project.look plus each clip's id, grading,
 * inputLut, lut and windows. Edits, captions and metadata are ignored while object key order is
 * irrelevant. Hosts can store it with lastGradePreview and reject matching against a stale sheet.
 * It is deliberately coarse: hosts that also need to reject previews taken before an edit change
 * should use their own edit-aware fingerprint instead.
 */
export function gradeSignature(project) {
  requireProject(project);
  const payload = {
    look: project.look ?? null,
    clips: project.clips.map((clip) => {
      const entry = { id: clip?.id ?? null };
      for (const key of COLOR_CLIP_FIELDS) entry[key] = clip?.[key] ?? null;
      return entry;
    }),
  };
  return createHash('sha256').update(canonical(payload)).digest('hex');
}
