import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';

/**
 * Delivery of an EAC timeline to human NLEs.
 *
 * Draft content mirrors the plaintext draft written by pyJianYingDraft
 * (vector-drafting/pyJianYingDraft, Apache-2.0, vendored under vendor/):
 * same top-level keys, material entries, segment fields and track shape.
 * Times are integer microseconds there, frames in the FCP7 XML.
 * Variable-speed clips keep the timeline duration fixed and stretch the
 * consumed source range (duration * speed), in both draft and XML.
 */

const TARGETS = ['jianying', 'premiere-xml', 'srt', 'lut', 'bundle'];
const MICROS_PER_SECOND = 1_000_000;
const MAX_SECONDS = 3600;
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const DEFAULT_FPS = 30;
const DEFAULT_TEXT_SIZE = 8;
const SPEED_MIN = 0.25;
const SPEED_MAX = 4;
const FS_ILLEGAL = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;

function md5Id(...parts) {
  return createHash('md5').update(parts.join('\u0000')).digest('hex');
}

function finite(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function seconds(value, name) {
  const result = finite(value, NaN);
  if (!Number.isFinite(result) || result < 0 || result > MAX_SECONDS) {
    throw new TypeError(`${name} must be a finite number between 0 and ${MAX_SECONDS}`);
  }
  return result;
}

function micros(value) {
  return Math.round(value * MICROS_PER_SECOND);
}

/**
 * Exact rate descriptor. NTSC rates are rational (30000/1001 etc.) and xmeml represents them as
 * an integer timebase with `<ntsc>TRUE</ntsc>`; frame math must use the exact ratio, otherwise a
 * 600 s sequence collapses to 599.4 s (18000 instead of 17982 frames).
 */
const NTSC_RATES = [
  { num: 30000, den: 1001, timebase: 30 },
  { num: 24000, den: 1001, timebase: 24 },
  { num: 60000, den: 1001, timebase: 60 },
];
const NTSC_TOLERANCE = 0.02;

function parseRational(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return { num: value, den: 1 };
  if (typeof value === 'string') {
    const text = value.trim();
    const fraction = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(text);
    if (fraction) {
      const num = Number(fraction[1]);
      const den = Number(fraction[2]);
      return den > 0 && Number.isFinite(num) && num > 0 ? { num, den } : null;
    }
    const number = Number(text);
    if (Number.isFinite(number) && number > 0) return { num: number, den: 1 };
  }
  return null;
}

function rateInfo(value) {
  const parsed = parseRational(value);
  if (!parsed) return rateInfo(DEFAULT_FPS);
  const ratio = parsed.num / parsed.den;
  for (const ntsc of NTSC_RATES) {
    if (Math.abs(ratio - ntsc.num / ntsc.den) <= NTSC_TOLERANCE) {
      return { timebase: ntsc.timebase, ntsc: true, rate: ntsc.num / ntsc.den, num: ntsc.num, den: ntsc.den };
    }
  }
  return { timebase: Math.max(1, Math.round(ratio)), ntsc: false, rate: ratio, num: parsed.num, den: parsed.den };
}

function rateDescriptor(value) {
  return value && typeof value === 'object' && typeof value.rate === 'number' ? value : rateInfo(value);
}

/** Integer frame count in the given (possibly NTSC rational) timebase. */
function frames(value, rate) {
  return Math.round(finite(value, 0) * rateDescriptor(rate).rate);
}

function forwardPath(path) {
  return path.replace(/\\/g, '/');
}

function safeFileStem(value, fallback = 'EAC') {
  let text = String(value ?? '').normalize('NFC')
    .replace(FS_ILLEGAL, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!text) text = fallback;
  text = text.slice(0, 60).replace(/[. ]+$/g, '');
  return text || fallback;
}

function defaultDraftName(project) {
  const stem = safeFileStem(project.title, String(project.id || '未命名项目'));
  return `EAC ${stem}`.slice(0, 60).replace(/[. ]+$/g, '');
}

function exportDraftName(project, draftName) {
  if (draftName === undefined || draftName === null) return defaultDraftName(project);
  const text = safeFileStem(draftName, 'EAC 草稿');
  if (!text) throw new TypeError('draftName must not be empty');
  return text;
}

function cleanPath(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new TypeError(`${name} must be a nonempty filesystem path`);
  }
  return resolve(value);
}

function fullPath(value, name) {
  return cleanPath(value, name);
}

function normalizeClip(clip, index) {
  if (!clip || typeof clip !== 'object') throw new TypeError(`clips[${index}] must be a clip object`);
  const kind = clip.kind === 'image' ? 'image' : clip.kind === 'audio' ? 'audio' : 'video';
  const path = absoluteClipPath(clip.path, `clips[${index}].path`);
  const start = seconds(clip.start ?? 0, `clips[${index}].start`);
  const duration = seconds(clip.duration ?? 0, `clips[${index}].duration`);
  if (start + duration > MAX_SECONDS) throw new RangeError(`clips[${index}] exceeds the ${MAX_SECONDS} second timeline`);
  return {
    ...clip,
    index,
    kind,
    path,
    name: basename(path),
    start,
    duration,
    sourceIn: seconds(clip.sourceIn ?? 0, `clips[${index}].sourceIn`),
    speed: kind === 'image' ? 1 : Math.min(SPEED_MAX, Math.max(SPEED_MIN, finite(clip.speed, 1))),
    volume: Math.max(0, finite(clip.volume, 1)),
    track: Math.round(finite(clip.track, 0)),
  };
}

function absoluteClipPath(value, name) {
  return cleanPath(value, name);
}

function timeline(project) {
  if (!project || typeof project !== 'object') throw new TypeError('project is required');
  const width = Math.round(finite(project.width, DEFAULT_WIDTH));
  const height = Math.round(finite(project.height, DEFAULT_HEIGHT));
  const rate = rateInfo(project.fps ?? DEFAULT_FPS);
  const fps = rate.timebase;
  if (!Array.isArray(project.clips)) throw new TypeError('project.clips must be an array');
  const clips = project.clips.map(normalizeClip);
  let duration = 0;
  for (const clip of clips) duration = Math.max(duration, clip.start + clip.duration);
  for (const caption of Array.isArray(project.captions) ? project.captions : []) {
    const end = finite(caption?.end, NaN);
    if (Number.isFinite(end)) duration = Math.max(duration, Math.min(MAX_SECONDS, end));
  }
  return {
    project,
    width,
    height,
    fps,
    rate,
    clips,
    duration,
    musicStart: seconds(project.musicStart ?? 0, 'project.musicStart'),
    fadeIn: seconds(project.fadeIn ?? 0, 'project.fadeIn'),
    fadeOut: seconds(project.fadeOut ?? 0, 'project.fadeOut'),
  };
}

function visualClips(clips) {
  return clips.filter((clip) => clip.kind !== 'audio')
    .sort((a, b) => a.start - b.start || a.track - b.track || a.index - b.index);
}

/** Standard SRT blocks, 1-based, milliseconds, literal UTF-8 cue text. */
export function buildCaptionsSrt(captions) {
  if (captions === undefined || captions === null) return '';
  if (!Array.isArray(captions)) throw new TypeError('captions must be an array');
  const cues = [];
  for (const [index, caption] of captions.entries()) {
    if (!caption || typeof caption !== 'object') throw new TypeError(`captions[${index}] must be a timestamped object`);
    const start = seconds(caption.start, `captions[${index}].start`);
    const end = seconds(caption.end, `captions[${index}].end`);
    if (end <= start) throw new TypeError(`captions[${index}].end must be greater than start`);
    if (typeof caption.text !== 'string') throw new TypeError(`captions[${index}].text must be a string`);
    const text = caption.text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '')
      .split('\n').map((line) => line.replace(/[ \t]+$/g, '')).join('\n')
      .replace(/\n{2,}/g, '\n').trim();
    if (!text) continue;
    const startMs = Math.round(start * 1000);
    cues.push({ startMs, endMs: Math.max(startMs + 1, Math.round(end * 1000)), text });
  }
  return cues.map((cue, index) => `${index + 1}\n${srtTimestamp(cue.startMs)} --> ${srtTimestamp(cue.endMs)}\n${cue.text}\n`).join('\n');
}

function srtTimestamp(totalMilliseconds) {
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor(totalMilliseconds / 60_000) % 60;
  const secondsPart = Math.floor(totalMilliseconds / 1000) % 60;
  const milliseconds = totalMilliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secondsPart).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
}

function escapeXml(value) {
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** file://localhost URL used by FCP7 XML; drive letters stay uppercase and colons stay literal. */
function pathUrl(path) {
  const normalized = forwardPath(path);
  const drive = /^([A-Za-z]):(?=\/)/.exec(normalized);
  const segments = normalized.split('/');
  const encoded = segments.map((segment, index) => {
    if (index === 0 && drive) return `${drive[1].toUpperCase()}:`;
    return encodeURIComponent(segment);
  }).join('/');
  return `file://localhost${encoded.startsWith('/') ? '' : '/'}${encoded}`;
}

function fileId(path) {
  return `file-${createHash('md5').update(forwardPath(path)).digest('hex')}`;
}

function xmlRate(value) {
  const rate = rateDescriptor(value);
  return `<rate><timebase>${rate.timebase}</timebase><ntsc>${rate.ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
}

function parseRate(value) {
  const parsed = parseRational(value);
  return parsed ? parsed.num / parsed.den : null;
}

function parseSeconds(value) {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number > 0 ? number : null;
}

function pathKey(path) {
  return forwardPath(resolve(path)).toLowerCase();
}

/**
 * Source metadata hints from project.assets[].probe (real ffprobe output). The pure builder
 * only reads this JSON, so it never touches the filesystem; `format.duration` is the source of
 * truth for media length and `fps` (number or "30000/1001" string) for the media timebase.
 */
function assetHints(project) {
  const hints = new Map();
  for (const asset of Array.isArray(project.assets) ? project.assets : []) {
    if (!asset || typeof asset.path !== 'string' || !asset.path.trim()) continue;
    const probe = asset.probe && typeof asset.probe === 'object' ? asset.probe : {};
    const fps = rateInfo(parseRate(probe.fps) ?? parseRate(asset.fps) ?? DEFAULT_FPS);
    const seconds = parseSeconds(probe.format?.duration) ?? parseSeconds(probe.duration) ?? null;
    hints.set(pathKey(asset.path), { fps, seconds });
  }
  return hints;
}

function groupByTrack(clips, compare = (a, b) => a.start - b.start || a.index - b.index) {
  const groups = new Map();
  for (const clip of clips) {
    if (!groups.has(clip.track)) groups.set(clip.track, []);
    groups.get(clip.track).push(clip);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, items]) => items.sort(compare));
}

/**
 * FCP7 time-remap filter. Without it Premiere/Resolve read the stretched in/out as a simple
 * trim; `timeremap` + `speed` is what actually replays the source at the EAC speed. Audio
 * clipitems need the same filter (with `mediatype` audio) or a sped-up source stays stretched.
 */
function timeRemapFilter(speed, media = 'video') {
  const percent = (speed * 100).toFixed(6);
  return [
    '<filter>',
    '  <effect>',
    '    <name>Time Remap</name>',
    '    <effectid>timeremap</effectid>',
    '    <effectcategory>motion</effectcategory>',
    '    <effecttype>motion</effecttype>',
    `    <mediatype>${media}</mediatype>`,
    '    <parameter authoringApp="PremierePro"><parameterid>variablespeed</parameterid><name>variablespeed</name><value>0</value></parameter>',
    `    <parameter authoringApp="PremierePro"><parameterid>speed</parameterid><name>speed</name><value>${percent}</value></parameter>`,
    '    <parameter authoringApp="PremierePro"><parameterid>reverse</parameterid><name>reverse</name><value>FALSE</value></parameter>',
    '    <parameter authoringApp="PremierePro"><parameterid>frameblending</parameterid><name>frameblending</name><value>FALSE</value></parameter>',
    '  </effect>',
    '</filter>',
  ].join('\n');
}

/**
 * FCP7 `audiolevels` gain filter. Apple's xmeml templates and OpenShot's exporter both express
 * `level` as a linear gain (valuemin 0, valuemax 3.98109, unity 1.0) — not decibels.
 * Unity gain is omitted so 1x items stay byte-identical to earlier exports.
 */
function audioLevelsFilter(gain) {
  if (!(Math.abs(gain - 1) > 1e-9)) return null;
  return [
    '<filter>',
    '  <effect>',
    '    <name>Audio Levels</name>',
    '    <effectid>audiolevels</effectid>',
    '    <effectcategory>audiolevels</effectcategory>',
    '    <effecttype>audiolevels</effecttype>',
    '    <mediatype>audio</mediatype>',
    '    <parameter>',
    '      <parameterid>level</parameterid>',
    '      <name>Level</name>',
    '      <valuemin>0</valuemin>',
    '      <valuemax>3.98109</valuemax>',
    `      <value>${gain.toFixed(6)}</value>`,
    '    </parameter>',
    '  </effect>',
    '</filter>',
  ].join('\n');
}

function xmlFile({ id, name, path, duration, media, rate }) {
  return [
    `<file id="${id}">`,
    `  <name>${escapeXml(name)}</name>`,
    `  <pathurl>${escapeXml(pathUrl(path))}</pathurl>`,
    `  ${xmlRate(rate)}`,
    `  <duration>${duration}</duration>`,
    `  <media><${media}/></media>`,
    '</file>',
  ].join('\n');
}

function xmlTrack(items) {
  return [
    '        <track>',
    '          <enabled>TRUE</enabled>',
    '          <locked>FALSE</locked>',
    ...(items.length ? items.map((item) => `          ${item.replace(/\n/g, '\n          ')}`) : []),
    '        </track>',
  ].join('\n');
}

/**
 * Music bed source ranges. The engine loops the bed (`-stream_loop -1`) and seeks to
 * `musicStart % fileLength`, so a delivery must split the timeline at every repeat boundary
 * instead of pretending the file is `musicStart + timeline` long. Without probe metadata the
 * old single-segment fallback is kept and documented as an assumption.
 */
function musicPlan({ musicStart, duration, sourceLength }) {
  if (!(duration > 0)) return [];
  if (!(sourceLength > 0)) {
    return [{ targetStart: 0, targetDuration: duration, sourceStart: musicStart, sourceDuration: duration }];
  }
  const segments = [];
  let position = 0;
  let source = musicStart % sourceLength;
  let guard = 0;
  while (position < duration - 1e-9 && guard++ < 100000) {
    const take = Math.min(sourceLength - source, duration - position);
    if (!(take > 0)) break;
    segments.push({ targetStart: position, targetDuration: take, sourceStart: source, sourceDuration: take });
    position += take;
    source = 0;
  }
  return segments;
}

/**
 * Voice-over range. The engine truncates a voice longer than the timeline and never extends a
 * short one, so the real file length is the source and target length (falling back to the
 * timeline length only when no probe metadata exists).
 */
function voicePlan({ duration, sourceLength }) {
  if (!(duration > 0)) return [];
  const length = sourceLength > 0 ? Math.min(duration, sourceLength) : duration;
  return length > 0 ? [{ targetStart: 0, targetDuration: length, sourceStart: 0, sourceDuration: length }] : [];
}

/** Global fade envelope for the music bed: 0..1, linear ramp in and out, 1 in between. */
function fadeEnvelope(time, duration, fadeIn, fadeOut) {
  let gain = 1;
  if (fadeIn > 0 && time < fadeIn) gain = Math.min(gain, time / fadeIn);
  if (fadeOut > 0 && time > duration - fadeOut) gain = Math.min(gain, (duration - time) / fadeOut);
  return Math.max(0, Math.min(1, gain));
}

/**
 * Fade keyframes for one split music segment. Keyframes sample the *global* envelope at the
 * segment head/tail plus every fade breakpoint inside the segment, so the reconstructed
 * piecewise-linear envelope is continuous across loop boundaries (a per-segment audio_fade
 * would restart the ramp at every repeat).
 */
function fadeKeyframes(segment, { duration, fadeIn, fadeOut, gain }) {
  if (!(fadeIn > 0) && !(fadeOut > 0)) return [];
  const start = segment.targetStart;
  const end = start + segment.targetDuration;
  const points = new Set([start, end]);
  for (const time of [fadeIn, duration - fadeOut]) {
    if (time > start + 1e-9 && time < end - 1e-9) points.add(time);
  }
  return [...points].sort((a, b) => a - b).map((time) => ({
    offset: Math.round((time - start) * MICROS_PER_SECOND),
    value: Number((gain * fadeEnvelope(time, duration, fadeIn, fadeOut)).toFixed(6)),
  }));
}

/**
 * FCP7 XML (xmeml v4) readable by Adobe Premiere Pro and DaVinci Resolve.
 *
 * - One `<track>` per lane of each distinct clip.track: overlaps inside one EAC track split into
 *   extra lanes so no two items share a track in the NLE, while EAC stacking order (later
 *   overlapping clip on top) and audio mixing are preserved.
 * - Source audio clips, the music bed and the voice-over each get a dedicated audio track.
 * - Speed changes are written as a real `timeremap` filter on both video and audio items.
 * - `clip.volume` and the music bed's 0.22 gain are written as linear `audiolevels` gain.
 * - `<in>`/`<out>`/`<duration>` use the media timebase from project.assets probe data; start/end
 *   stay in the sequence timebase. NTSC rates (30000/1001 etc.) keep `<ntsc>TRUE</ntsc>` and
 *   exact rational frame math, so a 600 s sequence stays 600 s instead of collapsing to 599.4 s.
 * - The music bed and voice-over use the real probed file length: the bed is split at every loop
 *   boundary, a short voice is never extended to a fictional duration.
 */
export function buildFcp7Xml(project) {
  const timelineInfo = timeline(project);
  const { width, height, duration, musicStart } = timelineInfo;
  const seqRate = timelineInfo.rate;
  const totalFrames = frames(duration, seqRate);
  const rate = xmlRate(seqRate);
  const hints = assetHints(project);
  const visuals = visualClips(timelineInfo.clips);
  const audioClips = timelineInfo.clips
    .filter((clip) => (clip.kind === 'video' || clip.kind === 'audio') && clip.volume > 0)
    .sort((a, b) => a.start - b.start || a.track - b.track || a.index - b.index);

  const musicPath = typeof project.musicPath === 'string' && project.musicPath.trim()
    ? resolve(project.musicPath) : null;
  const voicePath = typeof project.voicePath === 'string' && project.voicePath.trim()
    ? resolve(project.voicePath) : null;
  const musicSegments = musicPath
    ? musicPlan({ musicStart, duration, sourceLength: hints.get(pathKey(musicPath))?.seconds ?? 0 })
    : [];
  const voiceSegments = voicePath
    ? voicePlan({ duration, sourceLength: hints.get(pathKey(voicePath))?.seconds ?? 0 })
    : [];

  // One <file> entry per path, with the longest media length seen and that media's timebase.
  const files = new Map();
  const noteFile = (path, seconds, sourceRate) => {
    const key = pathKey(path);
    const current = files.get(key);
    files.set(key, {
      path: current?.path ?? path,
      rate: current?.rate ?? rateDescriptor(sourceRate),
      seconds: Math.max(current?.seconds ?? 0, seconds),
    });
  };
  const clipSource = (clip) => {
    if (clip.kind === 'image') return { rate: seqRate, seconds: clip.duration };
    const hint = hints.get(pathKey(clip.path));
    return {
      rate: hint?.fps ?? seqRate,
      seconds: Math.max(hint?.seconds ?? 0, clip.sourceIn + clip.duration * clip.speed),
    };
  };
  for (const clip of timelineInfo.clips) {
    const source = clipSource(clip);
    noteFile(clip.path, source.seconds, source.rate);
  }
  if (musicPath) {
    const hint = hints.get(pathKey(musicPath));
    noteFile(musicPath, hint?.seconds ?? musicStart + duration, hint?.fps ?? seqRate);
  }
  if (voicePath) {
    const hint = hints.get(pathKey(voicePath));
    noteFile(voicePath, hint?.seconds ?? duration, hint?.fps ?? seqRate);
  }

  let clipItemNumber = 0;
  const fileBlock = (path, media) => {
    const entry = files.get(pathKey(path));
    const entryRate = entry?.rate ?? seqRate;
    return xmlFile({
      id: fileId(path), name: basename(path), path,
      duration: frames(entry?.seconds ?? 0, entryRate),
      media, rate: entryRate,
    });
  };

  /** One video/audio clipitem with speed, gain and the shared file block. */
  const mediaItem = ({ clip, media, gain }) => {
    clipItemNumber++;
    const source = clipSource(clip);
    const sourceRate = source.rate;
    const inFrame = clip.kind === 'image' ? 0 : frames(clip.sourceIn, sourceRate);
    const outFrame = clip.kind === 'image'
      ? frames(clip.duration, sourceRate)
      : frames(clip.sourceIn + clip.duration * clip.speed, sourceRate);
    const filters = [];
    if (clip.speed !== 1 && clip.kind !== 'image') {
      filters.push(timeRemapFilter(clip.speed, media === 'audio' ? 'audio' : 'video'));
    }
    const levels = audioLevelsFilter(gain);
    if (levels) filters.push(levels);
    return [
      `<clipitem id="clipitem-${clipItemNumber}">`,
      `  <name>${escapeXml(clip.name)}</name>`,
      '  <enabled>TRUE</enabled>',
      `  <duration>${Math.max(0, outFrame - inFrame)}</duration>`,
      `  ${xmlRate(sourceRate)}`,
      `  <start>${frames(clip.start, seqRate)}</start>`,
      `  <end>${frames(clip.start + clip.duration, seqRate)}</end>`,
      `  <in>${inFrame}</in>`,
      `  <out>${outFrame}</out>`,
      ...filters.map((filter) => `  ${filter.replace(/\n/g, '\n  ')}`),
      `  ${fileBlock(clip.path, media).replace(/\n/g, '\n  ')}`,
      ...(media === 'audio'
        ? ['  <sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>']
        : []),
      '</clipitem>',
    ].join('\n');
  };

  // Lane-split each EAC track: same-track overlaps become extra XML tracks, ordered so the
  // later (overlapping) clip stacks above the earlier one.
  const videoTracks = trackLanes(visuals).map(({ lane }) => lane.map((clip) => mediaItem({ clip, media: 'video', gain: 1 })));
  const audioTracks = trackLanes(audioClips, (a, b) => (
    a.start - b.start
    || (a.kind === 'audio' ? 0 : 1) - (b.kind === 'audio' ? 0 : 1)
    || a.index - b.index
  )).map(({ lane }) => lane.map((clip) => mediaItem({ clip, media: 'audio', gain: clip.volume })));

  /** Music/voice bed item for one planned source range. */
  const bedItem = ({ name, path, segment, gain, sourceRate }) => {
    clipItemNumber++;
    const inFrame = frames(segment.sourceStart, sourceRate);
    const outFrame = frames(segment.sourceStart + segment.sourceDuration, sourceRate);
    const start = frames(segment.targetStart, seqRate);
    const end = frames(segment.targetStart + segment.targetDuration, seqRate);
    const levels = audioLevelsFilter(gain);
    return [
      `<clipitem id="clipitem-${clipItemNumber}">`,
      `  <name>${escapeXml(name)}</name>`,
      '  <enabled>TRUE</enabled>',
      `  <duration>${Math.max(0, outFrame - inFrame)}</duration>`,
      `  ${xmlRate(sourceRate)}`,
      `  <start>${start}</start>`,
      `  <end>${end}</end>`,
      `  <in>${inFrame}</in>`,
      `  <out>${outFrame}</out>`,
      ...(levels ? [`  ${levels.replace(/\n/g, '\n  ')}`] : []),
      `  ${fileBlock(path, 'audio').replace(/\n/g, '\n  ')}`,
      '  <sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>',
      '</clipitem>',
    ].join('\n');
  };

  const bedTracks = [];
  if (musicPath) {
    const sourceRate = hints.get(pathKey(musicPath))?.fps ?? seqRate;
    bedTracks.push(musicSegments.map((segment) => bedItem({
      name: '音乐', path: musicPath, segment, gain: 0.22, sourceRate,
    })));
  }
  if (voicePath) {
    const sourceRate = hints.get(pathKey(voicePath))?.fps ?? seqRate;
    bedTracks.push(voiceSegments.map((segment) => bedItem({
      name: '旁白', path: voicePath, segment, gain: 1, sourceRate,
    })));
  }

  const videoTracksXml = (videoTracks.length ? videoTracks : [[]]).map(xmlTrack).join('\n');
  const audioTracksXml = ([...audioTracks, ...bedTracks].length
    ? [...audioTracks, ...bedTracks] : [[]]).map(xmlTrack).join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE xmeml>',
    '<xmeml version="4">',
    '  <sequence id="sequence-1">',
    `    <name>${escapeXml(project.title ?? '')}</name>`,
    `    <duration>${totalFrames}</duration>`,
    `    ${rate}`,
    '    <media>',
    '      <video>',
    `        <format><samplecharacteristics><width>${width}</width><height>${height}</height>${rate}</samplecharacteristics></format>`,
    videoTracksXml,
    '      </video>',
    '      <audio>',
    audioTracksXml,
    '      </audio>',
    '    </media>',
    '  </sequence>',
    '</xmeml>',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* JianYing / CapCut plaintext draft                                    */
/* ------------------------------------------------------------------ */

function emptyMaterials() {
  // Mirrors ScriptMaterial.export_json() from pyJianYingDraft.
  return {
    ai_translates: [],
    audio_balances: [],
    audio_effects: [],
    audio_fades: [],
    audio_track_indexes: [],
    audios: [],
    beats: [],
    canvases: [],
    chromas: [],
    common_mask: [],
    color_curves: [],
    digital_humans: [],
    drafts: [],
    effects: [],
    flowers: [],
    green_screens: [],
    handwrites: [],
    hsl: [],
    images: [],
    log_color_wheels: [],
    loudnesses: [],
    manual_deformations: [],
    masks: [],
    material_animations: [],
    material_colors: [],
    multi_language_refs: [],
    placeholders: [],
    plugin_effects: [],
    primary_color_wheels: [],
    realtime_denoises: [],
    shapes: [],
    smart_crops: [],
    smart_relights: [],
    sound_channel_mappings: [],
    speeds: [],
    stickers: [],
    tail_leaders: [],
    text_templates: [],
    texts: [],
    time_marks: [],
    transitions: [],
    video_effects: [],
    video_trackings: [],
    videos: [],
    vocal_beautifys: [],
    vocal_separations: [],
  };
}

function cropSettings() {
  return {
    upper_left_x: 0.0, upper_left_y: 0.0,
    upper_right_x: 1.0, upper_right_y: 0.0,
    lower_left_x: 0.0, lower_left_y: 1.0,
    lower_right_x: 1.0, lower_right_y: 1.0,
  };
}

function videoMaterial(project, clip) {
  const id = md5Id(project.id ?? 'project', 'video-material', clip.id ?? String(clip.index), clip.path);
  const duration = micros(clip.sourceIn + clip.duration * clip.speed);
  return {
    audio_fade: null,
    category_id: '',
    category_name: 'local',
    check_flag: 63487,
    crop: cropSettings(),
    crop_ratio: 'free',
    crop_scale: 1.0,
    duration,
    has_audio: clip.kind === 'video',
    height: Math.round(finite(project.height, DEFAULT_HEIGHT)),
    id,
    local_material_id: '',
    material_id: id,
    material_name: clip.name,
    media_path: '',
    path: forwardPath(clip.path),
    type: clip.kind === 'image' ? 'photo' : 'video',
    width: Math.round(finite(project.width, DEFAULT_WIDTH)),
  };
}

function audioMaterial(project, path, duration, name) {
  const id = md5Id(project.id ?? 'project', 'audio-material', forwardPath(path));
  return {
    app_id: 0,
    category_id: '',
    category_name: 'local',
    check_flag: 3,
    copyright_limit_type: 'none',
    duration,
    effect_id: '',
    formula_id: '',
    id,
    local_material_id: id,
    music_id: id,
    name,
    path: forwardPath(path),
    source_platform: 0,
    type: 'extract_music',
    wave_points: [],
  };
}

function textMaterial(project, caption, index) {
  const id = md5Id(project.id ?? 'project', 'text-material', String(index));
  const text = caption.text;
  const content = {
    styles: [{
      fill: {
        alpha: 1.0,
        content: { render_type: 'solid', solid: { alpha: 1.0, color: [1.0, 1.0, 1.0] } },
      },
      range: [0, Array.from(text).length],
      size: DEFAULT_TEXT_SIZE,
      bold: false,
      italic: false,
      underline: false,
      strokes: [],
    }],
    text,
  };
  return {
    id,
    content: JSON.stringify(content),
    typesetting: 0,
    alignment: 1,
    letter_spacing: 0.0,
    line_spacing: 0.02,
    line_feed: 1,
    line_max_width: 0.82,
    force_apply_line_max_width: false,
    check_flag: 7,
    type: 'text',
    global_alpha: 1.0,
  };
}

function baseSegment(project, kind, key, materialId, targetTimerange) {
  return {
    enable_adjust: true,
    enable_color_correct_adjust: false,
    enable_color_curves: true,
    enable_color_match_adjust: false,
    enable_color_wheels: true,
    enable_lut: true,
    enable_smart_color_adjust: false,
    last_nonzero_volume: 1.0,
    reverse: false,
    track_attribute: 0,
    track_render_index: 0,
    visible: true,
    id: md5Id(project.id ?? 'project', `${kind}-segment`, key),
    material_id: materialId,
    target_timerange: targetTimerange,
    common_keyframes: [],
    keyframe_refs: [],
  };
}

function clipSettings(transformY = 0) {
  return {
    alpha: 1.0,
    flip: { horizontal: false, vertical: false },
    rotation: 0.0,
    scale: { x: 1.0, y: 1.0 },
    transform: { x: 0.0, y: transformY },
  };
}

/** Speed materials entry (pyJianYingDraft Speed.export_json) with a deterministic id. */
function speedMaterial(project, key, speed) {
  return {
    curve_speed: null,
    id: md5Id(project.id ?? 'project', 'speed-material', key),
    mode: 0,
    speed,
    type: 'speed',
  };
}

/** audio_fades entry (pyJianYingDraft AudioFade.export_json) with a deterministic id. */
function audioFadeMaterial(project, key, fadeInDuration, fadeOutDuration) {
  return {
    id: md5Id(project.id ?? 'project', 'audio-fade', key),
    fade_in_duration: fadeInDuration,
    fade_out_duration: fadeOutDuration,
    fade_type: 0,
    type: 'audio_fade',
  };
}

function videoSegment(project, clip, materialId, timerange) {
  return {
    ...baseSegment(project, 'video', clip.id ?? String(clip.index), materialId, timerange),
    source_timerange: { start: micros(clip.sourceIn), duration: micros(clip.duration * clip.speed) },
    speed: clip.speed,
    // The clip's source audio is delivered by its own audio segment; leaving it audible on the
    // video segment too would play it twice in JianYing.
    volume: 0,
    extra_material_refs: [],
    is_tone_modify: false,
    clip: clipSettings(0),
    uniform_scale: { on: true, value: 1.0 },
    hdr_settings: { intensity: 1.0, mode: 1, nits: 1000 },
  };
}

function audioSegment(project, key, materialId, timerange, sourceTimerange, volume) {
  return {
    ...baseSegment(project, 'audio', key, materialId, timerange),
    source_timerange: sourceTimerange,
    speed: 1.0,
    volume,
    extra_material_refs: [],
    is_tone_modify: false,
  };
}

function textSegment(project, caption, index, materialId, timerange) {
  return {
    ...baseSegment(project, 'text', String(index), materialId, timerange),
    source_timerange: null,
    speed: 1.0,
    volume: 1.0,
    extra_material_refs: [],
    is_tone_modify: false,
    clip: clipSettings(-0.8),
    uniform_scale: { on: true, value: 1.0 },
  };
}

function track(project, type, segments, key = type) {
  return {
    attribute: 0,
    flag: 0,
    id: md5Id(project.id ?? 'project', 'track', type, key),
    is_default_name: false,
    name: type,
    segments,
    type,
  };
}

/**
 * JianYing cannot play two segments that overlap in time on the same track. Distribute sorted
 * items over the fewest lanes so no two neighbours overlap; each lane becomes one track.
 */
function laneSegments(items, startOf = (item) => item.target_timerange.start, durationOf = (item) => item.target_timerange.duration) {
  const lanes = [];
  for (const item of items) {
    const lane = lanes.find((laneItems) => {
      const last = laneItems[laneItems.length - 1];
      return startOf(last) + durationOf(last) <= startOf(item);
    });
    if (lane) lane.push(item);
    else lanes.push([item]);
  }
  return lanes;
}

/** Group clips by their EAC track and split each group into non-overlapping lanes. */
function trackLanes(clips, compare = (a, b) => a.start - b.start || a.index - b.index) {
  const groups = new Map();
  for (const clip of clips) {
    if (!groups.has(clip.track)) groups.set(clip.track, []);
    groups.get(clip.track).push(clip);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([trackNumber, items]) => laneSegments(
      items.sort(compare),
      (clip) => clip.start,
      (clip) => clip.duration,
    ).map((lane) => ({ trackNumber, lane })));
}

function draftContentTemplate() {
  // Top-level keys and defaults follow pyJianYingDraft assets/draft_content_template.json.
  return {
    canvas_config: { height: DEFAULT_HEIGHT, ratio: 'original', width: DEFAULT_WIDTH },
    color_space: 0,
    config: {
      adjust_max_index: 1,
      attachment_info: [],
      combination_max_index: 1,
      export_range: null,
      extract_audio_last_index: 1,
      lyrics_recognition_id: '',
      lyrics_sync: true,
      lyrics_taskinfo: [],
      maintrack_adsorb: true,
      material_save_mode: 0,
      multi_language_current: 'none',
      multi_language_list: [],
      multi_language_main: 'none',
      multi_language_mode: 'none',
      original_sound_last_index: 1,
      record_audio_last_index: 1,
      sticker_max_index: 1,
      subtitle_keywords_config: null,
      subtitle_recognition_id: '',
      subtitle_sync: true,
      subtitle_taskinfo: [],
      system_font_list: [],
      video_mute: false,
      zoom_info_params: null,
    },
    cover: null,
    create_time: 0,
    duration: 0,
    extra_info: null,
    fps: DEFAULT_FPS,
    free_render_index_mode_on: false,
    group_container: null,
    id: '',
    keyframe_graph_list: [],
    keyframes: {
      adjusts: [], audios: [], effects: [], filters: [], handwrites: [],
      stickers: [], texts: [], videos: [],
    },
    last_modified_platform: { app_id: 3704, app_source: 'lv', app_version: '5.9.0', os: 'windows' },
    materials: emptyMaterials(),
    mutable_config: null,
    name: '',
    new_version: '110.0.0',
    platform: { app_id: 3704, app_source: 'lv', app_version: '5.9.0', os: 'windows' },
    relationships: [],
    render_index_track_mode_on: false,
    retouch_cover: null,
    source: 'default',
    static_cover_image_path: '',
    time_marks: null,
    tracks: [],
    update_time: 0,
    version: 360000,
  };
}

function draftMetaTemplate(project, draftName, duration) {
  // Minimal plaintext draft_meta_info.json, following the reference template keys.
  return {
    cloud_package_completed_time: '',
    draft_cloud_capcut_purchase_info: '',
    draft_cloud_last_action_download: false,
    draft_cloud_materials: [],
    draft_cloud_purchase_info: '',
    draft_cloud_template_id: '',
    draft_cloud_tutorial_info: '',
    draft_cloud_videocut_purchase_info: '',
    draft_cover: '',
    draft_deeplink_url: '',
    draft_enterprise_info: { draft_enterprise_extra: '', draft_enterprise_id: '', draft_enterprise_name: '', enterprise_material: [] },
    draft_fold_path: '',
    draft_id: md5Id(project.id ?? 'project', 'draft-meta', draftName),
    draft_is_ai_packaging_used: false,
    draft_is_ai_shorts: false,
    draft_is_ai_translate: false,
    draft_is_article_video_draft: false,
    draft_is_from_deeplink: 'false',
    draft_is_invisible: false,
    draft_materials: [0, 1, 2, 3, 6, 7, 8].map((type) => ({ type, value: [] })),
    draft_materials_copied_info: [],
    draft_name: draftName,
    draft_new_version: '',
    draft_removable_storage_device: '',
    draft_root_path: '',
    draft_segment_extra_info: [],
    draft_type: '',
    tm_draft_cloud_completed: '',
    tm_draft_cloud_modified: 0,
    tm_draft_removed: 0,
    tm_duration: duration,
  };
}

/**
 * Plaintext JianYing draft files. Everything is deterministic: ids are md5 hex
 * derived from project/clip ids, so repeated builds are byte-identical.
 */
export function buildJianYingDraft(project, { draftName } = {}) {
  const timelineInfo = timeline(project);
  const { fps, width, height, duration, clips, musicStart, fadeIn, fadeOut } = timelineInfo;
  const name = exportDraftName(project, draftName);
  const total = micros(duration);
  const content = draftContentTemplate();
  content.canvas_config = { height, ratio: 'original', width };
  content.duration = total;
  content.fps = fps;
  content.id = md5Id(project.id ?? 'project', 'draft-content', name);
  content.name = name;
  content.tracks = [];

  const tracks = [];
  const speedMaterials = [];
  const audioFades = [];
  // Non-1 speeds get a Speed materials entry linked through extra_material_refs,
  // exactly as pyJianYingDraft's MediaSegment wires them; speed 1 stays bare.
  const applySpeed = (segment, key, speed) => {
    if (speed === 1) return;
    segment.speed = speed;
    const material = speedMaterial(project, key, speed);
    speedMaterials.push(material);
    segment.extra_material_refs = [...segment.extra_material_refs, material.id];
  };

  const visuals = visualClips(clips);
  const videos = [];
  // One JianYing video track per EAC clip.track (overlaps within a track get extra lanes).
  for (const { lane } of trackLanes(visuals)) {
    const videoSegments = [];
    for (const clip of lane) {
      const material = videoMaterial(project, clip);
      videos.push(material);
      const segment = videoSegment(project, clip, material.id, {
        start: micros(clip.start),
        duration: micros(clip.duration),
      });
      applySpeed(segment, clip.id ?? String(clip.index), clip.speed);
      videoSegments.push(segment);
    }
    tracks.push(track(project, 'video', videoSegments, `video-${tracks.length}`));
  }

  const audioMaterials = new Map();
  const ensureAudioMaterial = (path, materialDuration, label) => {
    const key = forwardPath(path);
    const existing = audioMaterials.get(key);
    if (existing) {
      existing.duration = Math.max(existing.duration, materialDuration);
      return existing.id;
    }
    const material = audioMaterial(project, path, materialDuration, label);
    audioMaterials.set(key, material);
    return material.id;
  };

  const musicSegments = [];
  const voiceSegments = [];
  const musicPath = typeof project.musicPath === 'string' && project.musicPath.trim()
    ? resolve(project.musicPath) : null;
  const voicePath = typeof project.voicePath === 'string' && project.voicePath.trim()
    ? resolve(project.voicePath) : null;
  const hints = assetHints(project);
  if (musicPath) {
    const realLength = hints.get(pathKey(musicPath))?.seconds ?? 0;
    // Material duration is the real probed file length; the old `musicStart + timeline` value
    // invented a longer file than exists and made JianYing loop silently.
    const id = ensureAudioMaterial(musicPath, micros(realLength > 0 ? realLength : musicStart + duration), basename(musicPath));
    const plan = musicPlan({ musicStart, duration, sourceLength: realLength });
    for (const [index, segment] of plan.entries()) {
      const audio = audioSegment(project, `music-${index}`, id,
        { start: micros(segment.targetStart), duration: micros(segment.targetDuration) },
        { start: micros(segment.sourceStart), duration: micros(segment.sourceDuration) }, 0.22);
      if (plan.length === 1) {
        // One contiguous bed: a native audio_fade is exact and survives the round trip.
        if (fadeIn > 0 || fadeOut > 0) {
          const fade = audioFadeMaterial(project, 'music', micros(fadeIn), micros(fadeOut));
          audioFades.push(fade);
          audio.extra_material_refs = [...audio.extra_material_refs, fade.id];
        }
      } else {
        // Loop-split bed: per-segment audio_fades would restart the ramp at every repeat, so
        // sample the *global* envelope into volume keyframes instead.
        const keyframes = fadeKeyframes(segment, { duration, fadeIn, fadeOut, gain: 0.22 });
        if (keyframes.length) {
          audio.common_keyframes = [{
            id: md5Id(project.id ?? 'project', 'audio-keyframes', `music-${index}`),
            keyframe_list: keyframes.map((point) => ({
              curveType: 'Line',
              graphID: '',
              left_control: { x: 0.0, y: 0.0 },
              right_control: { x: 0.0, y: 0.0 },
              id: md5Id(project.id ?? 'project', 'audio-keyframe', `music-${index}`, String(point.offset)),
              time_offset: point.offset,
              values: [point.value],
            })),
            material_id: '',
            property_type: 'KFTypeVolume',
          }];
        }
      }
      musicSegments.push(audio);
    }
  }
  if (voicePath) {
    const realLength = hints.get(pathKey(voicePath))?.seconds ?? 0;
    // A short voice-over keeps its real length; only missing metadata falls back to the timeline.
    const id = ensureAudioMaterial(voicePath, micros(realLength > 0 ? Math.min(duration, realLength) : duration), basename(voicePath));
    for (const [index, segment] of voicePlan({ duration, sourceLength: realLength }).entries()) {
      voiceSegments.push(audioSegment(project, `voice-${index}`, id,
        { start: micros(segment.targetStart), duration: micros(segment.targetDuration) },
        { start: micros(segment.sourceStart), duration: micros(segment.sourceDuration) }, 1.0));
    }
  }
  // Clip source audio keeps its own EAC track and is split into non-overlapping lanes.
  const clipAudio = clips
    .filter((clip) => (clip.kind === 'video' || clip.kind === 'audio') && clip.volume > 0 && clip.duration > 0)
    .sort((a, b) => a.start - b.start || a.track - b.track || a.index - b.index);
  const clipAudioLanes = new Map();
  for (const { trackNumber, lane } of trackLanes(clipAudio)) {
    const segments = [];
    for (const clip of lane) {
      const id = ensureAudioMaterial(clip.path, micros(clip.sourceIn + clip.duration * clip.speed), clip.name);
      const segment = audioSegment(project, `clip-${clip.id ?? clip.index}`, id,
        { start: micros(clip.start), duration: micros(clip.duration) },
        { start: micros(clip.sourceIn), duration: micros(clip.duration * clip.speed) }, clip.volume);
      applySpeed(segment, `clip-${clip.id ?? clip.index}`, clip.speed);
      segments.push(segment);
    }
    clipAudioLanes.set(`${trackNumber}-${clipAudioLanes.size}`, segments);
  }
  // Music and voice-over each get a dedicated track so they never compete with source audio.
  for (const [key, segments] of clipAudioLanes) {
    tracks.push(track(project, 'audio', segments, `audio-${key}`));
  }
  if (musicSegments.length) tracks.push(track(project, 'audio', musicSegments, 'audio-music'));
  if (voiceSegments.length) tracks.push(track(project, 'audio', voiceSegments, 'audio-voice'));

  const captions = (Array.isArray(project.captions) ? project.captions : [])
    .map((caption, index) => ({ ...caption, index }))
    .sort((a, b) => finite(a.start, 0) - finite(b.start, 0) || a.index - b.index);
  const texts = [];
  const textEntries = [];
  for (const caption of captions) {
    if (!caption || typeof caption !== 'object') throw new TypeError(`captions[${caption.index ?? '?'}] must be a timestamped object`);
    const start = seconds(caption.start ?? 0, `captions[${caption.index}].start`);
    const end = seconds(caption.end ?? 0, `captions[${caption.index}].end`);
    if (typeof caption.text !== 'string') throw new TypeError(`captions[${caption.index}].text must be a string`);
    if (end <= start || !caption.text.trim()) continue;
    const material = textMaterial(project, caption, caption.index);
    texts.push(material);
    const segment = textSegment(project, caption, caption.index, material.id, {
      start: micros(start), duration: micros(end - start),
    });
    textEntries.push({ start, duration: end - start, segment });
  }
  // Overlapping captions go on separate text tracks, exactly like the audio lanes.
  const textLanes = laneSegments(
    textEntries.sort((a, b) => a.start - b.start),
    (entry) => entry.start,
    (entry) => entry.duration,
  );
  for (const lane of textLanes) {
    tracks.push(track(project, 'text', lane.map((entry) => entry.segment), `text-${tracks.length}`));
  }

  // pyJianYingDraft writes render_index as the track's order, not a per-segment counter
  // (script_file.py enumerates tracks). Mirror that so JianYing stacks the tracks correctly.
  tracks.forEach((trackValue, trackIndex) => {
    for (const segment of trackValue.segments) {
      segment.render_index = trackIndex;
      segment.track_render_index = 0;
    }
  });

  const materials = emptyMaterials();
  materials.videos = videos;
  materials.audios = [...audioMaterials.values()];
  materials.texts = texts;
  materials.speeds = speedMaterials;
  materials.audio_fades = audioFades;
  content.materials = materials;
  content.tracks = tracks;

  const meta = draftMetaTemplate(project, name, total);
  return {
    draftName: name,
    files: {
      'draft_content.json': JSON.stringify(content, null, 4),
      'draft_meta_info.json': JSON.stringify(meta, null, 4),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Export job                                                          */
/* ------------------------------------------------------------------ */

function abortError() {
  return Object.assign(new Error('Export aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}

function selectedTargets(targets) {
  if (targets === undefined || targets === null) return new Set(TARGETS);
  if (!Array.isArray(targets)) throw new TypeError('targets must be an array');
  if (!targets.length) return new Set(TARGETS);
  const selected = new Set();
  for (const target of targets) {
    if (!TARGETS.includes(target)) throw new TypeError(`Unknown export target: ${target}`);
    selected.add(target);
  }
  return selected;
}

function resolveOutputDir(outputDir) {
  return fullPath(outputDir, 'outputDir');
}

async function writeDraft({ project, output, draftName }) {
  const folder = resolve(join(output, 'jianying', draftName));
  await mkdir(folder, { recursive: true });
  const written = [];
  const draft = buildJianYingDraft(project, { draftName });
  for (const [name, content] of Object.entries(draft.files)) {
    const path = resolve(join(folder, name));
    await writeFile(path, content, 'utf8');
    written.push(path);
  }
  return { folder, files: written, draftName: draft.draftName };
}

function lutJobs(project) {
  const jobs = [];
  if (project.look) {
    jobs.push({ grade: project.look, fileName: 'look.cube', label: '项目 look' });
  }
  if (Array.isArray(project.clips)) {
    project.clips.forEach((clip, index) => {
      if (!clip || typeof clip !== 'object') return;
      if (clip.grading !== undefined && clip.grading !== null) {
        const base = typeof clip.path === 'string' && clip.path.trim()
          ? basename(clip.path, extname(clip.path)) : `clip-${index + 1}`;
        jobs.push({
          grade: clip.grading,
          fileName: `clip-${index}-${safeFileStem(base, 'clip')}.cube`,
          label: `片段 ${index + 1}`,
          mergeLayers: [project.look ?? null, clip.grading],
        });
      }
      // One LUT per spatial window, merged look + clip + window grading; the
      // grade<N>w<M>.cube names are the render engine's convention.
      if (Array.isArray(clip.windows)) {
        clip.windows.forEach((window, windowIndex) => {
          if (!window || typeof window !== 'object') return;
          jobs.push({
            grade: window.grading,
            fileName: `grade${index}w${windowIndex}.cube`,
            label: `片段 ${index + 1} 蒙版 ${windowIndex + 1}`,
            mergeLayers: [project.look ?? null, clip.grading ?? null, window.grading],
          });
        });
      }
    });
  }
  return jobs;
}

/**
 * Write the project look and per-clip LUTs. A missing grading module or invalid
 * grading parameters only adds a note; it never fails the whole export.
 */
async function writeLuts({ project, output, settings, signal, notes }) {
  const jobs = lutJobs(project);
  if (!jobs.length) return [];
  let gradingApi;
  try {
    gradingApi = await import('./media/grading.mjs');
  } catch (error) {
    notes.push(`LUT 生成模块不可用（${error.message}），已跳过 LUT 导出；调色参数仍保留在工程文件中。`);
    return [];
  }
  if (typeof gradingApi.writeCubeLut !== 'function') {
    notes.push('LUT 生成模块缺少 writeCubeLut，已跳过 LUT 导出；调色参数仍保留在工程文件中。');
    return [];
  }
  const directory = resolve(join(output, 'lut'));
  await mkdir(directory, { recursive: true });
  const written = [];
  for (const job of jobs) {
    checkAbort(signal);
    let grade = job.grade;
    if (job.mergeLayers && typeof gradingApi.mergeGrading === 'function') {
      try {
        grade = gradingApi.mergeGrading(...job.mergeLayers);
      } catch (error) {
        notes.push(`${job.label} 的调色参数无效（${error.message}），已跳过对应 LUT。`);
        continue;
      }
    }
    if (!grade) {
      notes.push(`${job.label} 没有可用的调色参数，已跳过对应 LUT。`);
      continue;
    }
    const path = resolve(join(directory, job.fileName));
    try {
      const options = { signal };
      if (Number.isInteger(settings?.lutSize)) options.size = settings.lutSize;
      await gradingApi.writeCubeLut(grade, path, options);
      written.push(path);
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw abortError();
      notes.push(`${job.label} 的 LUT 生成失败（${error?.message || error}），已跳过该文件。`);
    }
  }
  return written;
}

function relativeToOutput(output, path) {
  const base = forwardPath(output).replace(/\/+$/g, '');
  const full = forwardPath(path);
  return full.startsWith(`${base}/`) ? full.slice(base.length + 1) : full;
}

/**
 * Copy the user's own .cube files into the delivery. These are not generated: the camera
 * input conversion (`clip.inputLut`) and the creative look (`clip.lut`) are original assets
 * the render engine applies before the parameter grade. Copying them keeps the handoff usable
 * on another machine without the original LUT folders.
 */
async function copyExternalLuts({ project, output, signal }) {
  const copies = [];
  const seen = new Set();
  const jobs = [];
  (Array.isArray(project.clips) ? project.clips : []).forEach((clip, index) => {
    if (!clip || typeof clip !== 'object') return;
    const base = typeof clip.path === 'string' && clip.path.trim()
      ? basename(clip.path, extname(clip.path)) : `clip-${index + 1}`;
    const stem = safeFileStem(base, 'clip');
    for (const [role, key] of [['input', 'inputLut'], ['creative', 'lut']]) {
      const source = clip[key];
      if (typeof source !== 'string' || !source.trim()) continue;
      const absolute = resolve(source);
      const dedupe = `${role}\u0000${absolute}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      jobs.push({
        role, source: absolute, fileName: `clip-${index}-${stem}.cube`,
        label: `片段 ${index + 1} ${role === 'input' ? '输入 LUT' : '创意 LUT'}`,
      });
    }
  });
  for (const job of jobs) {
    checkAbort(signal);
    const directory = resolve(join(output, 'lut', job.role));
    await mkdir(directory, { recursive: true });
    const path = resolve(join(directory, job.fileName));
    await copyFile(job.source, path);
    copies.push({
      role: job.role, source: job.source, path,
      exported: relativeToOutput(output, path), label: job.label, fileName: job.fileName,
    });
  }
  return copies;
}

/* ------------------------------------------------------------------ */
/* Handoff manifest and ZIP                                            */
/* ------------------------------------------------------------------ */

/**
 * Capability map for the handoff manifest. The LUT chain is documented as *independent
 * branches*: `inputLut` and `lut` run once on the shared stream, then the base grade and each
 * power window are separate branches blended by mask. Chaining a base LUT into a window LUT
 * would grade the window twice.
 */
const CAPABILITIES = {
  speed: { jianying: 'native', premiereXml: 'timeremap-filter' },
  externalLut: {
    order: ['inputLut', 'lut'],
    branches: 'base-and-each-window-are-independent',
    blend: 'each-window-lut-blended-with-base-by-mask',
    automatic: false,
  },
  parameterGrade: { retained: 'lut', automatic: false },
  powerWindows: { retained: 'grading-lut-and-geometry-in-manifest', automatic: false },
  motion: { retained: false },
  sharpenVignetteGrain: { retained: false },
  text: { jianying: 'native', premiereXml: false, srt: true },
  audioGain: { jianying: 'segment-volume', premiereXml: 'audiolevels-linear-gain', musicGain: 0.22 },
  audioFades: {
    jianying: 'audio_fades-or-volume-keyframes',
    premiereXml: 'not-written',
  },
  musicOffset: { jianying: 'source-timerange-modulo-duration', premiereXml: 'in-point-modulo-duration' },
  musicLoop: { jianying: 'split-segments', premiereXml: 'split-clipitems', fallbackWithoutProbe: 'single-segment-assumed-long-enough' },
  voice: { shortVoiceNotExtended: true },
  timebase: { ntsc: 'ntsc-true-exact-rational-frames' },
};

async function mediaManifest(project, { timelineInfo, copies }) {
  const entries = [];
  const seen = new Set();
  const probeFor = (path) => {
    const asset = (Array.isArray(project.assets) ? project.assets : [])
      .find((item) => item && typeof item.path === 'string' && pathKey(item.path) === pathKey(path));
    const probe = asset?.probe && typeof asset.probe === 'object' ? asset.probe : null;
    return probe ? {
      fps: parseRate(probe.fps),
      duration: parseSeconds(probe.format?.duration) ?? parseSeconds(probe.duration),
    } : null;
  };
  const add = async (path, kind, role) => {
    const absolute = resolve(path);
    const key = pathKey(absolute);
    if (seen.has(key)) return;
    seen.add(key);
    const info = await stat(absolute).catch(() => null);
    entries.push({
      path: absolute, kind, role,
      exists: Boolean(info?.isFile()),
      bytes: info?.isFile() ? info.size : null,
      probe: probeFor(absolute),
      luts: copies.filter((copy) => copy.source === absolute).map((copy) => ({ role: copy.role, exported: copy.exported })),
    });
  };
  for (const clip of timelineInfo.clips) await add(clip.path, clip.kind, 'clip');
  if (typeof project.musicPath === 'string' && project.musicPath.trim()) await add(project.musicPath, 'audio', 'music');
  if (typeof project.voicePath === 'string' && project.voicePath.trim()) await add(project.voicePath, 'audio', 'voice');
  return entries;
}

/**
 * Machine-readable color handoff. The render engine grades each clip as:
 *
 *   inputLut -> lut -> [base branch: project look + clip grading]
 *                   -> [window branch N: project look + clip grading + window N grading]
 *   ...then blends every window branch back over the base with that window's soft mask.
 *
 * That means the window LUTs are *siblings* of the base LUT, not layers on top of it: loading
 * base then window would grade the masked area twice. The manifest records the exact files and
 * the window geometry/opacity so the handoff can be reconstructed by hand or by a script.
 */
function colorHandoff({ project, generated, copies }) {
  const output = generated.output;
  const copyFor = (index, role) => {
    const source = project.clips?.[index]?.[role === 'input' ? 'inputLut' : 'lut'];
    return typeof source === 'string' && source.trim()
      ? copies.find(copy => copy.role === role && pathKey(copy.source) === pathKey(source))
      : null;
  };
  const generatedName = (name) => {
    const path = generated.luts.find((candidate) => basename(candidate) === name);
    return path ? relativeToOutput(output, path) : null;
  };
  const clips = [];
  (Array.isArray(project.clips) ? project.clips : []).forEach((clip, index) => {
    if (!clip || typeof clip !== 'object') return;
    const windows = (Array.isArray(clip.windows) ? clip.windows : []).map((window, windowIndex) => {
      if (!window || typeof window !== 'object') return null;
      const entry = { index: windowIndex, shape: window.shape ?? null };
      for (const key of ['x', 'y', 'radius', 'width', 'height', 'angle', 'feather', 'opacity']) {
        if (typeof window[key] === 'number' && Number.isFinite(window[key])) entry[key] = window[key];
      }
      entry.lut = generatedName(`grade${index}w${windowIndex}.cube`);
      return entry;
    }).filter(Boolean);
    const inputCopy = copyFor(index, 'input');
    const creativeCopy = copyFor(index, 'creative');
    const baseLut = generatedName(`clip-${index}-${safeFileStem(
      typeof clip.path === 'string' && clip.path.trim() ? basename(clip.path, extname(clip.path)) : `clip-${index + 1}`,
      'clip',
    )}.cube`) || (project.look ? generatedName('look.cube') : null);
    const hasColor = inputCopy || creativeCopy || baseLut || windows.length;
    if (!hasColor) return;
    clips.push({
      clipId: clip.id ?? null,
      index,
      path: typeof clip.path === 'string' ? resolve(clip.path) : null,
      inputLut: inputCopy ? { source: inputCopy.source, exported: inputCopy.exported } : null,
      creativeLut: creativeCopy ? { source: creativeCopy.source, exported: creativeCopy.exported } : null,
      baseLut,
      windows,
    });
  });
  return {
    pipeline: 'inputLut -> lut -> base grade; each window branch = inputLut -> lut -> base+window grade; blend each window with base by mask',
    doubleGradeWarning: '不要先把 baseLut 套在画面上再套 windowLut：windowLut 已包含 base 调色，串联会重复调色。请用两条独立分支再按蒙版混合。',
    clips,
  };
}

function buildManifest({ project, timelineInfo, generated, copies, files, media }) {
  const luts = [];
  for (const copy of copies) {
    luts.push({ role: copy.role, source: copy.source, exported: copy.exported });
  }
  for (const path of generated.luts) {
    const name = basename(path);
    const role = name === 'look.cube' ? 'look' : /^grade\d+w\d+\.cube$/.test(name) ? 'window' : 'grade';
    luts.push({ role, source: null, exported: relativeToOutput(generated.output, path) });
  }
  return {
    schema: 'eac-nle-handoff/1',
    project: {
      id: project.id ?? null,
      title: project.title ?? '',
      revision: Number.isInteger(project.revision) ? project.revision : null,
      width: timelineInfo.width,
      height: timelineInfo.height,
      fps: timelineInfo.rate.rate,
      timebase: { value: timelineInfo.rate.timebase, ntsc: timelineInfo.rate.ntsc },
      duration: timelineInfo.duration,
    },
    sourceRevision: Number.isInteger(project.revision) ? project.revision : null,
    formatValidation: 'format-only',
    verifiedInNle: false,
    note: '仅做了格式验证（XML 结构、草稿字段、LUT 文件可读）；未在真实剪映 / Premiere / Resolve 中导入验证。',
    generatedAt: new Date().toISOString(),
    files: files.map((path) => relativeToOutput(generated.output, path)),
    luts,
    color: colorHandoff({ project, generated, copies }),
    media,
    capabilities: CAPABILITIES,
    notes: generated.notes,
  };
}

const ZIP_DOS_TIME = 0;
// 2020-01-01 00:00:00 in DOS date format keeps repeated exports byte-identical.
const ZIP_DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Minimal ZIP writer (STORE/DEFLATE) so the handoff archive needs no dependency and no
 * external archiver. Entries use UTF-8 names and a fixed timestamp for reproducibility.
 */
export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(forwardPath(entry.name), 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const store = compressed.length >= data.length;
    const payload = store ? data : compressed;
    const method = store ? 0 : 8;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(ZIP_DOS_TIME, 10);
    local.writeUInt16LE(ZIP_DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(ZIP_DOS_TIME, 12);
    central.writeUInt16LE(ZIP_DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, payload);
    centrals.push(central, name);
    offset += local.length + name.length + payload.length;
  }
  const centralSize = centrals.reduce((total, buffer) => total + buffer.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

function creditLines(project) {
  const lines = [];
  const seen = new Set();
  // Only credit assets that actually appear in the delivered cut: stale downloads
  // that were later replaced must not show up as attributions.
  const used = new Set();
  for (const clip of Array.isArray(project.clips) ? project.clips : []) {
    if (typeof clip?.path === 'string') used.add(clip.path);
  }
  for (const key of ['musicPath', 'voicePath']) {
    if (typeof project[key] === 'string') used.add(project[key]);
  }
  for (const asset of Array.isArray(project.assets) ? project.assets : []) {
    const source = asset?.source;
    if (!source || typeof source !== 'object') continue;
    if (used.size && !used.has(asset.path)) continue;
    const values = [source.provider, source.author, source.license, source.url].filter(Boolean);
    if (!values.length) continue;
    const label = asset.name || (typeof asset.path === 'string' ? basename(asset.path) : '素材');
    const line = `- ${label}：${values.join(' / ')}`;
    if (!seen.has(line)) { seen.add(line); lines.push(line); }
  }
  for (const credit of Array.isArray(project.credits) ? project.credits : []) {
    const line = typeof credit === 'string' ? credit : credit?.text;
    if (typeof line !== 'string' || !line.trim()) continue;
    const rendered = `- ${line.trim()}`;
    if (!seen.has(rendered)) { seen.add(rendered); lines.push(rendered); }
  }
  if (!lines.length) lines.push('- 本包未记录第三方素材署名；发布前请核对素材来源与许可。');
  return lines;
}

function buildBundleReadme({ project, output, draftName, draftFolder, generated, copies = [] }) {
  const title = String(project.title ?? '');
  const width = Math.round(finite(project.width, DEFAULT_WIDTH));
  const height = Math.round(finite(project.height, DEFAULT_HEIGHT));
  const timelineInfo = timeline(project);
  const rate = timelineInfo.rate;
  const fpsText = rate.ntsc
    ? `${rate.timebase} fps NTSC（${rate.num}/${rate.den} ≈ ${rate.rate.toFixed(3)}）`
    : `${rate.timebase} fps`;
  const durationText = timelineInfo.duration.toFixed(2);
  const root = jianYingDefaultDraftRoot();
  const draftRoot = root || '%LOCALAPPDATA%\\JianyingPro\\User Data\\Projects\\com.lveditor.draft';
  const list = (paths) => paths.map((path) => `- ${relativeToOutput(output, path)}`);
  const inputCopies = copies.filter((copy) => copy.role === 'input');
  const creativeCopies = copies.filter((copy) => copy.role === 'creative');
  const lines = [
    'EAC 剪辑工程导出包',
    '================',
    '',
    `项目：${title}`,
    `画布：${width}x${height} @ ${fpsText}`,
    `时长：${durationText} 秒`,
    `剪映草稿名：${draftName}`,
    '',
    '已导出文件：',
  ];
  if (generated.draft.length) lines.push(...list(generated.draft));
  if (generated.xml) lines.push(`- ${relativeToOutput(output, generated.xml)}`);
  if (generated.srt) lines.push(`- ${relativeToOutput(output, generated.srt)}`);
  lines.push(...list(generated.luts));
  lines.push(...list(copies.map((copy) => copy.path)));
  if (generated.readme) lines.push(`- ${relativeToOutput(output, generated.readme)}`);
  if (generated.manifest) lines.push(`- ${relativeToOutput(output, generated.manifest)}`);
  if (generated.zip) lines.push(`- ${relativeToOutput(output, generated.zip)}`);

  lines.push(
    '',
    '一、剪映专业版（JianYing Pro）',
    generated.draft.length
      ? `草稿目录：${relativeToOutput(output, draftFolder)}/。把整个草稿文件夹复制到剪映草稿根目录（${draftRoot}），打开或重启剪映即可在草稿列表中看到。`
      : '本次未导出剪映草稿（未选择 jianying 目标）。',
    '草稿引用原始素材的绝对路径；移动或删除素材后需要重新链接（本包 manifest.json 记录了每个素材的原始绝对路径，可据此在剪映中「重新链接」）。',
    'AI 参数调色不会烘焙进草稿画面，请按下述 LUT 步骤复现成片色调。',
    'LUT 导入：选中片段 → 右侧「调节」→「LUT」→「导入」，选择 lut/ 目录下对应的 .cube 文件；项目整体 look 使用 lut/look.cube。',
    '',
    '二、Adobe Premiere Pro / DaVinci Resolve',
    generated.xml
      ? `文件 → 导入，选择 ${relativeToOutput(output, generated.xml)}（FCP7 XML）。视频轨、音频轨、素材入出点与剪辑点会写入，但仅为格式验证，导入后请人工核对。`
      : '本次未导出 Premiere XML（未选择 premiere-xml 目标）。',
    '调色：Premiere 使用 Lumetri 颜色 → Creative → Look；DaVinci 在节点上加载 LUT。两者均可直接读取 lut/ 下的 .cube 文件。',
    '',
    '三、Photoshop',
    '对视频帧或海报图：图层 → 新建调整图层 → 颜色查找（Color Lookup），载入 lut/look.cube 即可得到与成片一致的调色。',
    '',
    '四、必剪（BiJian）',
    '必剪草稿是封闭格式，与剪映草稿、FCP7 XML 均不互通，无法直接导入本工程。替代方案：使用导出的 MP4 成片，配合 srt/captions.srt 导入字幕，再在必剪中导入 lut/*.cube 继续人工制作。',
    '',
    '五、字幕',
    generated.srt
      ? `字幕文件：${relativeToOutput(output, generated.srt)}，剪映、Premiere、Resolve、必剪及常见播放器均可直接导入。`
      : Array.isArray(project.captions) && project.captions.length
        ? '本次未导出 SRT（未选择 srt 目标）；如需字幕文件，请重新导出并勾选 srt。'
        : '本次未生成 SRT（项目没有字幕）；如需字幕，请先在 EAC 中补字幕再导出。',
    '',
    '六、LUT 应用顺序（重要）',
    '本包会实际复制你指定的相机输入 LUT 与创意 LUT（不是生成，也不是模拟）：',
  );
  if (inputCopies.length) {
    lines.push('输入 LUT（相机 Log → 工作色彩，先套）：');
    for (const copy of inputCopies) lines.push(`- ${copy.exported}（原文件 ${copy.source}）`);
  }
  if (creativeCopies.length) {
    lines.push('创意 LUT（输入转换之后再套）：');
    for (const copy of creativeCopies) lines.push(`- ${copy.exported}（原文件 ${copy.source}）`);
  }
  if (!inputCopies.length && !creativeCopies.length) {
    lines.push('- 本次工程没有设置 clip.inputLut / clip.lut，未复制外部 LUT。');
  }
  lines.push(
    '正确做法是「同一输入、两条独立分支、按蒙版混合」，不是把基础 LUT 串进窗口 LUT：',
    '1) 输入转换：每个片段先套 输入 LUT（inputLut），再套 创意 LUT（lut）。这一步只做一次，基础分支与所有窗口分支共用同一个输入结果。',
    '2) 基础分支：输入结果 → 参数化调色 lut/clip-N-<素材名>.cube（项目 look + 片段 grading 的合并结果）。',
    '3) 每个窗口分支：从同一个输入结果再分出一条，套 lut/grade<N>w<M>.cube（该 LUT 已包含 项目 look + 片段 grading + 该窗口 grading），得到窗口内的完整调色。',
    '4) 混合：用该窗口的几何/羽化/不透明度生成蒙版，把窗口分支按蒙版叠回基础分支；多个窗口依次叠加。',
    '错误做法：先套 lut/clip-N-*.cube 得到基础画面，再在其上套 lut/grade<N>w<M>.cube —— 窗口区域会被调色两次（双重调色），色调明显偏重。',
    '各窗口的几何参数（shape/x/y/radius|width|height/angle/feather/opacity）与对应 LUT 文件名都记录在 manifest.json 的 color.clips[] 里，可据此重建蒙版与混合。',
    '未保留的能力：动画（motion）、锐化、暗角、颗粒、字幕样式细节只在 EAC 渲染引擎中生效，导出不会保留，需要人工重建；空间蒙版的几何形状本身不写进 NLE，但已写入 manifest 供重建。',
    '这不是全自动保留：剪映草稿与 FCP7 XML 只是格式验证（结构合法），未在真实剪映 / Premiere / Resolve 中导入验证，也不声称商业软件可直接导入；导入后请人工核对并续剪。',
    '',
    '七、时间线能力对照',
    '变速（speed）：剪映草稿已原生写入（视频与源音片段都带 speed 素材）；Premiere/Resolve 的 XML 对视频与音频 clipitem 都写入真正的 timeremap 时间重映射滤镜（speed 参数 + 变量变速关闭），若你的版本忽略该滤镜，请用「速度/持续时间」按同一比值设置。',
    '音量：XML 用 FCP7 的 audiolevels 增益滤镜（level 为线性增益，1.0 = 原音量）写入片段音量与配乐 0.22；剪映草稿用片段的 volume 字段。1.0 音量不写多余滤镜。',
    '同轨重叠：同一 EAC 轨内时间重叠的片段会拆到多条 XML 轨（剪映草稿同样拆 lane），视觉上后出现（重叠）的片段在上层，音频则同时混音，不会丢片段。',
    '动画（motion）、锐化、暗角、颗粒：仅渲染引擎生效，NLE 中需人工重建——PR 用 Lumetri 蒙版+关键帧，剪映用蒙版/动画/变速面板。',
    '曲线（curves）、二级调色（secondaries）、分区（zones）、hue-vs：已烘焙进导出的 .cube LUT，套用对应 LUT 即可复现成片色调；每个空间蒙版的合并调色在 lut/grade<片段>w<蒙版>.cube。',
    '音乐偏移与循环（musicStart）：音乐床会按真实文件时长循环。导出时 musicStart 取真实时长取模（与渲染引擎一致），并在每个循环边界拆成多个片段，XML 与剪映草稿都不会假装文件比实际更长；没有 probe 时长时退化为单段并在 manifest 标注。',
    '淡入淡出（fadeIn/fadeOut）：单段音乐写入剪映 audio_fades；循环拆分后改用音量关键帧，关键帧按整条时间线的全局淡入淡出包络采样，跨循环边界连续（不会每圈重置）。Premiere/Resolve 需用音量关键帧手动复现。',
    '旁白（voicePath）：按真实文件时长写入；旁白短于时间线时不会被拉长成虚构时长，长于时间线时与渲染一样被截断。',
    '帧率（NTSC）：29.97 / 23.976 / 59.94 等素材与序列写成 timebase 30/24/60 且 ntsc TRUE，帧数按精确有理数换算，600 秒仍是 600 秒（不会变成 599.4 秒）。',
    '音频轨道：XML 中素材源音、配乐、旁白分别占用独立音频轨，便于人工分别调整。',
    '',
    '八、素材来源与许可',
    ...creditLines(project),
    '',
  );
  return `${lines.join('\n')}`;
}

/** Default JianYing draft root; empty string on Windows when LOCALAPPDATA is missing, null elsewhere. */
export function jianYingDefaultDraftRoot() {
  if (process.platform !== 'win32') return null;
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return '';
  return join(localAppData, 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft');
}

/**
 * Validate the source material before anything is written: a delivery that silently references
 * a deleted file is worse than a failed export. Paths are checked with stat only; the pure
 * builders (buildFcp7Xml / buildJianYingDraft) never touch the filesystem.
 */
async function validateSources(project, timelineInfo) {
  if (!timelineInfo.clips.length) throw new Error('时间线为空：没有可导出的片段（empty timeline）');
  const paths = new Map();
  const add = (path, label) => {
    if (typeof path !== 'string' || !path.trim()) return;
    const absolute = resolve(path);
    if (!paths.has(pathKey(absolute))) paths.set(pathKey(absolute), { path: absolute, labels: [] });
    paths.get(pathKey(absolute)).labels.push(label);
  };
  for (const clip of timelineInfo.clips) add(clip.path, `片段 ${clip.index + 1}（${clip.name}）`);
  add(project.musicPath, '配乐 musicPath');
  add(project.voicePath, '旁白 voicePath');
  for (const clip of timelineInfo.clips) {
    for (const [key, label] of [['inputLut', '输入 LUT'], ['lut', '创意 LUT']]) {
      const value = clip[key];
      if (value === undefined || value === null || value === '') continue;
      if (typeof value !== 'string') throw new TypeError(`片段 ${clip.index + 1} 的 ${key} 必须是 .cube 文件路径`);
      add(value, `片段 ${clip.index + 1} 的 ${label}`);
    }
  }
  const missing = [];
  for (const entry of paths.values()) {
    const info = await stat(entry.path).catch(() => null);
    if (!info?.isFile()) missing.push(`${entry.labels.join('、')} → ${entry.path}`);
  }
  if (missing.length) {
    throw new Error(`导出中止：以下媒体或 LUT 文件丢失或不存在（missing media）——\n${missing.join('\n')}\n请恢复这些文件，或在 EAC 中移除对应片段/调色后重新导出。`);
  }
}

/**
 * Export a cloned EAC project to one or more human-editable delivery formats.
 * Every listed file is written below outputDir (which the engine creates).
 */
export async function runExport({ project, outputDir, targets, settings, signal } = {}) {
  checkAbort(signal);
  const output = resolveOutputDir(outputDir);
  const selected = selectedTargets(targets);
  const timelineInfo = timeline(project);
  await validateSources(project, timelineInfo);
  checkAbort(signal);
  const draftName = exportDraftName(project, settings?.draftName);
  const safeTitle = safeFileStem(project.title, String(project.id || 'EAC'));
  await mkdir(output, { recursive: true });
  const files = [];
  const notes = [];
  const generated = { output, draft: [], xml: null, srt: null, luts: [], readme: null, manifest: null, zip: null };
  let draftFolder = null;
  let copies = [];

  if (selected.has('jianying')) {
    checkAbort(signal);
    const draft = await writeDraft({ project, output, draftName });
    draftFolder = draft.folder;
    files.push(...draft.files);
    generated.draft = draft.files;
  }

  if (selected.has('premiere-xml')) {
    checkAbort(signal);
    const xmlDir = resolve(join(output, 'premiere-xml'));
    await mkdir(xmlDir, { recursive: true });
    const path = resolve(join(xmlDir, `${safeTitle}-premiere.xml`));
    await writeFile(path, buildFcp7Xml(project), 'utf8');
    files.push(path);
    generated.xml = path;
  }

  if (selected.has('srt')) {
    checkAbort(signal);
    const srt = buildCaptionsSrt(project.captions);
    if (!srt) {
      notes.push('项目没有字幕，已跳过 SRT 导出。');
    } else {
      const directory = resolve(join(output, 'srt'));
      await mkdir(directory, { recursive: true });
      const path = resolve(join(directory, 'captions.srt'));
      await writeFile(path, srt, 'utf8');
      files.push(path);
      generated.srt = path;
    }
  }

  if (selected.has('lut')) {
    checkAbort(signal);
    generated.luts = await writeLuts({ project, output, settings, signal, notes });
    copies = await copyExternalLuts({ project, output, signal });
    files.push(...generated.luts, ...copies.map((copy) => copy.path));
  }

  if (selected.has('bundle')) {
    checkAbort(signal);
    const directory = resolve(join(output, 'bundle'));
    await mkdir(directory, { recursive: true });
    const path = resolve(join(directory, 'README.txt'));
    // Compute the README text after its own filename is known.
    const text = buildBundleReadme({
      project, output, draftName, draftFolder, copies,
      generated: { ...generated, readme: path },
    });
    await writeFile(path, text, 'utf8');
    files.push(path);
    generated.readme = path;
  }

  // manifest.json + a dependency-free ZIP give the UI a single download and the main agent a
  // machine-readable record of what was and was not preserved.
  checkAbort(signal);
  const media = await mediaManifest(project, { timelineInfo, copies });
  const manifestPath = resolve(join(output, 'manifest.json'));
  const manifest = buildManifest({
    project, timelineInfo, generated, copies,
    files: [...files, manifestPath], media,
  });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  generated.manifest = manifestPath;
  files.push(manifestPath);

  checkAbort(signal);
  const zipEntries = [];
  const uniqueFiles = [...new Set(files.map((path) => resolve(path)))];
  for (const path of uniqueFiles) {
    zipEntries.push({
      name: relativeToOutput(output, path),
      data: await readFile(path),
    });
  }
  const zipPath = resolve(join(output, `${safeTitle}-handoff.zip`));
  await writeFile(zipPath, buildZip(zipEntries));
  generated.zip = zipPath;
  files.push(zipPath);

  checkAbort(signal);
  return {
    files: files.map((path) => resolve(path)),
    draftName,
    draftFolder: draftFolder ? resolve(draftFolder) : null,
    manifest: generated.manifest,
    zip: generated.zip,
    notes,
  };
}
