import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  buildCaptionsSrt, buildFcp7Xml, buildJianYingDraft,
  jianYingDefaultDraftRoot, runExport,
} from '../src/export-nle.mjs';

let gradingAvailable = false;
try {
  const grading = await import('../src/media/grading.mjs');
  gradingAvailable = typeof grading.writeCubeLut === 'function';
} catch {
  gradingAvailable = false;
}

const VIDEO_ONE = 'C:/shots/开场 clip.mp4';
const VIDEO_TWO = 'C:/shots/second.mp4';
const STILL = 'C:/shots/still.png';
const MUSIC = 'C:/audio/音乐.wav';
const VOICE = 'C:/audio/voice.wav';

function fixture(overrides = {}) {
  return {
    id: 'project-1',
    title: '测试片 <&> "引号"',
    width: 1920,
    height: 1080,
    fps: 30,
    clips: [
      {
        id: 'clip-one', assetId: 'asset-one', path: VIDEO_ONE, kind: 'video',
        start: 0, duration: 1.5, sourceIn: 0, volume: 1, track: 0,
        grading: { exposure: 0.2, contrast: 0.1 },
      },
      {
        id: 'clip-two', assetId: 'asset-two', path: VIDEO_TWO, kind: 'video',
        start: 1.5, duration: 2, sourceIn: 0.5, volume: 0.8, track: 0,
      },
      {
        id: 'clip-three', assetId: 'asset-three', path: STILL, kind: 'image',
        start: 3.5, duration: 2, sourceIn: 0, volume: 1, track: 0,
      },
    ],
    captions: [
      { start: 0.2, end: 1.4, text: '第一句 & <保持字面>' },
      { start: 1.5, end: 2.5, text: 'Second line' },
    ],
    musicPath: MUSIC,
    voicePath: VOICE,
    look: { temperature: 0.1, vibrance: 0.05 },
    assets: [
      {
        id: 'asset-one', name: '开场 clip.mp4', path: VIDEO_ONE, kind: 'video',
        source: { provider: 'Pexels', author: 'Jane Doe', license: 'CC BY 4.0', url: 'https://example.test/clip' },
      },
    ],
    credits: ['音乐：Example Artist - Example Track（CC BY）'],
    ...overrides,
  };
}

function decodeXmlText(value) {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function tagValue(block, name, occurrence = 1) {
  const matches = [...block.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, 'g'))];
  assert.ok(matches.length >= occurrence, `missing <${name}> #${occurrence} in ${block.slice(0, 200)}`);
  return matches[occurrence - 1][1];
}

function clipItems(xml) {
  return [...xml.matchAll(/<clipitem id="clipitem-\d+">[\s\S]*?<\/clipitem>/g)].map((match) => match[0]);
}

/** Tiny XML well-formedness checker: balanced tags, one root and escaped text. */
function assertWellFormedXml(xml) {
  const body = xml
    .replace(/^\uFEFF/, '')
    .replace(/^<\?xml[^>]*\?>\s*/, '')
    .replace(/<!DOCTYPE[^>]*>\s*/, '');
  const stack = [];
  let roots = 0;
  let cursor = 0;
  const pattern = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_:][\w.:-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let match;
  while ((match = pattern.exec(body))) {
    const between = body.slice(cursor, match.index);
    assert.doesNotMatch(between, /[<>]/, 'stray angle bracket outside a tag');
    assert.doesNotMatch(between, /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/, 'unescaped ampersand');
    cursor = pattern.lastIndex;
    const [, closing, name, , selfClosing] = match;
    if (closing) {
      assert.equal(stack.pop(), name, `unbalanced closing tag ${name}`);
    } else if (selfClosing) {
      if (!stack.length) roots++;
    } else {
      if (!stack.length) roots++;
      stack.push(name);
    }
  }
  assert.equal(stack.length, 0, 'unclosed tags remain');
  assert.equal(roots, 1, 'XML must have exactly one root element');
  assert.equal(body.slice(cursor).trim(), '', 'trailing content after root');
}

async function listFiles(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await listFiles(path));
    else output.push(path);
  }
  return output;
}

test('buildCaptionsSrt formats standard 1-based cues and keeps text literal', () => {
  const srt = buildCaptionsSrt([
    { start: 0, end: 1.5, text: '第一句 & <i>不转义</i>' },
    { start: 61.25, end: 62, text: 'Line one\r\nLine two' },
  ]);
  assert.equal(srt, [
    '1',
    '00:00:00,000 --> 00:00:01,500',
    '第一句 & <i>不转义</i>',
    '',
    '2',
    '00:01:01,250 --> 00:01:02,000',
    'Line one',
    'Line two',
    '',
  ].join('\n'));
  assert.doesNotMatch(srt, /&amp;|&lt;/);
  assert.equal(buildCaptionsSrt([]), '');
  assert.equal(buildCaptionsSrt(undefined), '');
  assert.throws(() => buildCaptionsSrt([{ start: 1, end: 1, text: 'x' }]), /greater than start/);
  assert.throws(() => buildCaptionsSrt([{ start: -1, end: 2, text: 'x' }]), /0 and 3600/);
});

test('buildFcp7Xml is well-formed, escapes text and computes frame math', () => {
  const project = fixture();
  const xml = buildFcp7Xml(project);
  assertWellFormedXml(xml);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<xmeml version="4">/);
  assert.match(xml, /<sequence id="sequence-1">/);
  assert.match(xml, /<timebase>30<\/timebase>/);
  assert.match(tagValue(xml, 'duration'), /^\d+$/);
  assert.equal(Number(tagValue(xml, 'duration')), 165);

  const sequenceName = /<sequence id="sequence-1">\s*<name>([\s\S]*?)<\/name>/.exec(xml)[1];
  assert.equal(decodeXmlText(sequenceName), project.title);
  assert.match(sequenceName, /&lt;|&amp;|&gt;/);

  const items = clipItems(xml);
  assert.equal(items.length, 7, '3 visual clips + music + voice + 2 clip audio items');
  const first = items[0];
  assert.equal(tagValue(first, 'duration'), '45');
  assert.equal(tagValue(first, 'start'), '0');
  assert.equal(tagValue(first, 'end'), '45');
  assert.equal(tagValue(first, 'in'), '0');
  assert.equal(tagValue(first, 'out'), '45');
  const second = items[1];
  assert.equal(tagValue(second, 'start'), '45');
  assert.equal(tagValue(second, 'end'), '105');
  assert.equal(tagValue(second, 'in'), '15');
  assert.equal(tagValue(second, 'out'), '75');
  const image = items.find((item) => tagValue(item, 'name') === 'still.png');
  assert.ok(image);
  assert.equal(tagValue(image, 'in'), '0');
  assert.equal(tagValue(image, 'out'), '60');
  assert.equal(tagValue(image, 'start'), '105');
  assert.equal(tagValue(image, 'end'), '165');
  for (const item of items) {
    for (const name of ['duration', 'start', 'end', 'in', 'out']) {
      assert.match(tagValue(item, name), /^\d+$/, `${name} must be an integer frame value`);
    }
  }

  const names = items.map((item) => decodeXmlText(tagValue(item, 'name')));
  assert.ok(names.includes('音乐'));
  assert.ok(names.includes('旁白'));
  assert.equal(names.filter((name) => name === '开场 clip.mp4').length, 2, 'video item plus its audio item');

  const pathurl = /<pathurl>([^<]+)<\/pathurl>/.exec(first)[1];
  assert.match(pathurl, /^file:\/\/localhost\//);
  assert.doesNotMatch(pathurl, /localhost\/\//);
  assert.match(pathurl, /%20/, 'spaces are percent-encoded');
  assert.doesNotMatch(pathurl, /\\/);
  const urlPath = pathurl.replace(/^file:\/\/localhost/, '');
  const decoded = decodeURIComponent(process.platform === 'win32' ? urlPath.replace(/^\//, '') : urlPath);
  assert.equal(decoded, resolve(VIDEO_ONE).replace(/\\/g, '/'));
  if (process.platform === 'win32') assert.match(pathurl, /^file:\/\/localhost\/[A-Z]:\//);

  assert.equal(buildFcp7Xml(project), xml, 'XML must be deterministic');
});

test('buildFcp7Xml reuses the file id for identical paths', () => {
  const base = fixture();
  const repeated = {
    ...base,
    captions: [],
    musicPath: undefined,
    voicePath: undefined,
    clips: [
      base.clips[0],
      { ...base.clips[0], id: 'clip-repeat', start: 1.5, duration: 1 },
    ],
  };
  const xml = buildFcp7Xml(repeated);
  assertWellFormedXml(xml);
  const fileEntries = [...xml.matchAll(/<file id="(file-[0-9a-f]{32})">[\s\S]*?<pathurl>([^<]+)<\/pathurl>/g)];
  assert.ok(fileEntries.length >= 2);
  const ids = new Set(fileEntries.map((match) => match[1]));
  assert.equal(ids.size, 1, 'same path must reuse one file id');
});

test('buildJianYingDraft emits the reference schema with deterministic ids and microseconds', () => {
  const project = fixture();
  const built = buildJianYingDraft(project);
  const again = buildJianYingDraft(project);
  assert.deepEqual(built, again);
  assert.equal(built.files['draft_content.json'], again.files['draft_content.json']);

  assert.match(built.draftName, /^EAC /);
  assert.equal(built.draftName.length <= 60, true);
  assert.doesNotMatch(built.draftName, /[<>:"/\\|?*]/);
  assert.equal(buildJianYingDraft(project, { draftName: '手工草稿' }).draftName, '手工草稿');

  const content = JSON.parse(built.files['draft_content.json']);
  const meta = JSON.parse(built.files['draft_meta_info.json']);
  assert.deepEqual(content.canvas_config, { height: 1080, ratio: 'original', width: 1920 });
  assert.equal(content.fps, 30);
  assert.equal(content.duration, 5_500_000);
  assert.match(content.id, /^[0-9a-f]{32}$/);

  const trackTypes = content.tracks.map((track) => track.type);
  assert.deepEqual(trackTypes, ['video', 'audio', 'audio', 'audio', 'text'],
    'one video track, then source-audio / music / voice tracks, then text');
  const videoTrack = content.tracks[0];
  const audioTracks = content.tracks.filter((track) => track.type === 'audio');
  const textTrack = content.tracks.find((track) => track.type === 'text');
  assert.equal(videoTrack.segments.length, 3);
  assert.equal(audioTracks.reduce((total, track) => total + track.segments.length, 0), 4,
    'music + voice + original audio of two video clips');
  assert.equal(textTrack.segments.length, 2);
  for (const track of content.tracks) {
    assert.match(track.id, /^[0-9a-f]{32}$/);
    for (const segment of track.segments) {
      assert.match(segment.id, /^[0-9a-f]{32}$/);
      assert.match(segment.material_id, /^[0-9a-f]{32}$/);
      assert.deepEqual(segment.extra_material_refs, []);
      assert.equal(segment.visible, true);
      assert.equal(segment.speed, 1.0);
      assert.equal(typeof segment.volume, 'number');
      assert.ok(segment.volume >= 0);
    }
  }
  assert.deepEqual(videoTrack.segments.map((segment) => segment.target_timerange.start), [0, 1_500_000, 3_500_000]);
  assert.deepEqual(videoTrack.segments.map((segment) => segment.target_timerange.duration), [1_500_000, 2_000_000, 2_000_000]);
  assert.deepEqual(videoTrack.segments.map((segment) => segment.source_timerange.start), [0, 500_000, 0]);
  assert.deepEqual(videoTrack.segments.map((segment) => segment.volume), [0, 0, 0],
    'video segments are muted; source audio lives on its own audio segment');
  const audioById = new Map(content.materials.audios.map((material) => [material.id, material]));
  const clipAudioSegments = audioTracks.flatMap((track) => track.segments)
    .filter((segment) => audioById.get(segment.material_id)?.path.endsWith('.mp4'));
  assert.deepEqual(clipAudioSegments.map((segment) => segment.volume).sort(), [0.8, 1],
    'each video clip contributes exactly one source-audio segment with its own volume');
  // render_index is the track order (pyJianYingDraft semantics), shared by a track's segments.
  content.tracks.forEach((track, trackIndex) => {
    for (const segment of track.segments) {
      assert.equal(segment.render_index, trackIndex, 'render_index equals the track order');
      assert.equal(segment.track_render_index, 0);
    }
  });

  assert.equal(content.materials.videos.length, 3);
  for (const material of content.materials.videos) {
    assert.match(material.material_id, /^[0-9a-f]{32}$/);
    assert.equal(material.material_id, material.id);
    assert.doesNotMatch(material.path, /\\/);
    assert.match(material.path, /^([A-Za-z]:\/|\/)/);
    assert.equal(Number.isInteger(material.duration) && material.duration >= 0, true);
  }
  assert.equal(content.materials.videos[0].type, 'video');
  assert.equal(content.materials.videos[0].has_audio, true);
  assert.equal(content.materials.videos[0].duration, 1_500_000);
  assert.equal(content.materials.videos[2].type, 'photo');
  assert.equal(content.materials.videos[2].has_audio, false);

  assert.equal(content.materials.audios.length, 4);
  for (const material of content.materials.audios) {
    assert.doesNotMatch(material.path, /\\/);
    assert.equal(material.type, 'extract_music');
  }
  assert.equal(content.materials.texts.length, 2);
  const textContent = JSON.parse(content.materials.texts[0].content);
  assert.equal(textContent.text, project.captions[0].text);
  assert.deepEqual(textContent.styles[0].range, [0, Array.from(project.captions[0].text).length]);

  assert.equal(meta.draft_name, built.draftName);
  assert.equal(meta.tm_duration, 5_500_000);
  assert.match(meta.draft_id, /^[0-9a-f]{32}$/);
  assert.equal(meta.draft_materials.length, 7);

  const expectedTopLevel = [
    'canvas_config', 'color_space', 'config', 'cover', 'create_time', 'duration', 'extra_info',
    'fps', 'free_render_index_mode_on', 'group_container', 'id', 'keyframe_graph_list', 'keyframes',
    'last_modified_platform', 'materials', 'mutable_config', 'name', 'new_version', 'platform',
    'relationships', 'render_index_track_mode_on', 'retouch_cover', 'source', 'static_cover_image_path',
    'time_marks', 'tracks', 'update_time', 'version',
  ];
  assert.deepEqual(Object.keys(content).sort(), [...expectedTopLevel].sort());
});

test('speed clips stretch the source range and record jianying speed materials', () => {
  const project = fixture({
    clips: [
      {
        id: 'clip-fast', assetId: 'asset-fast', path: VIDEO_ONE, kind: 'video',
        start: 0, duration: 2, sourceIn: 0.5, volume: 1, track: 0, speed: 2,
      },
    ],
    captions: [],
    musicPath: undefined,
    voicePath: undefined,
  });

  const built = buildJianYingDraft(project);
  const content = JSON.parse(built.files['draft_content.json']);
  const [videoTrack, audioTrack] = content.tracks;
  const segment = videoTrack.segments[0];
  assert.deepEqual(segment.target_timerange, { start: 0, duration: 2_000_000 }, 'timeline duration is fixed');
  assert.deepEqual(segment.source_timerange, { start: 500_000, duration: 4_000_000 }, 'source range doubles at 2x');
  assert.equal(segment.speed, 2);
  assert.equal(content.materials.speeds.length, 2, 'one speed material per media segment (video + linked audio)');
  const [videoSpeed, audioSpeed] = content.materials.speeds;
  assert.deepEqual(videoSpeed, { curve_speed: null, id: videoSpeed.id, mode: 0, speed: 2, type: 'speed' });
  assert.match(videoSpeed.id, /^[0-9a-f]{32}$/);
  assert.deepEqual(segment.extra_material_refs, [videoSpeed.id]);
  const audioSegment = audioTrack.segments[0];
  assert.equal(audioSegment.speed, 2);
  assert.deepEqual(audioSegment.source_timerange, { start: 500_000, duration: 4_000_000 });
  assert.deepEqual(audioSegment.target_timerange, { start: 0, duration: 2_000_000 });
  assert.deepEqual(audioSegment.extra_material_refs, [audioSpeed.id]);
  assert.deepEqual(content.materials.audio_fades, []);
  assert.deepEqual(buildJianYingDraft(project), built, 'speed draft is deterministic');

  // xmeml: speed = (out - in) / (end - start) = 120 / 60 = 2 at 30fps.
  const xml = buildFcp7Xml(project);
  assertWellFormedXml(xml);
  const items = clipItems(xml);
  assert.equal(items.length, 2, 'video item plus its linked audio item');
  const video = items[0];
  assert.equal(tagValue(video, 'start'), '0');
  assert.equal(tagValue(video, 'end'), '60');
  assert.equal(tagValue(video, 'in'), '15');
  assert.equal(tagValue(video, 'out'), '135');
  const audio = items[1];
  assert.equal(tagValue(audio, 'start'), '0');
  assert.equal(tagValue(audio, 'end'), '60');
  assert.equal(tagValue(audio, 'in'), '15');
  assert.equal(tagValue(audio, 'out'), '135');
});

test('musicStart offsets the music in-point and fadeIn/fadeOut become audio_fade materials', () => {
  const project = fixture({ musicStart: 1.5, fadeIn: 0.5, fadeOut: 1 });

  const built = buildJianYingDraft(project);
  const content = JSON.parse(built.files['draft_content.json']);
  const audioTracks = content.tracks.filter((track) => track.type === 'audio');
  const musicMaterial = content.materials.audios.find((material) => material.path.endsWith('音乐.wav'));
  const voiceMaterial = content.materials.audios.find((material) => material.path.endsWith('voice.wav'));
  assert.ok(musicMaterial && voiceMaterial);
  const musicTrack = audioTracks.find((track) => track.segments.some((segment) => segment.material_id === musicMaterial.id));
  const voiceTrack = audioTracks.find((track) => track.segments.some((segment) => segment.material_id === voiceMaterial.id));
  assert.ok(musicTrack && voiceTrack);
  assert.notEqual(musicTrack.id, voiceTrack.id, 'music and voice have dedicated tracks');
  const music = musicTrack.segments.find((segment) => segment.material_id === musicMaterial.id);
  const voice = voiceTrack.segments.find((segment) => segment.material_id === voiceMaterial.id);
  assert.deepEqual(music.source_timerange, { start: 1_500_000, duration: 5_500_000 }, 'music starts at the offset');
  assert.deepEqual(music.target_timerange, { start: 0, duration: 5_500_000 });
  assert.equal(musicMaterial.duration, 7_000_000, 'music material spans offset plus timeline');
  assert.equal(music.speed, 1);
  assert.equal(content.materials.audio_fades.length, 1);
  const fade = content.materials.audio_fades[0];
  assert.deepEqual(fade, {
    id: fade.id, fade_in_duration: 500_000, fade_out_duration: 1_000_000, fade_type: 0, type: 'audio_fade',
  });
  assert.match(fade.id, /^[0-9a-f]{32}$/);
  assert.deepEqual(music.extra_material_refs, [fade.id]);
  assert.deepEqual(voice.source_timerange, { start: 0, duration: 5_500_000 }, 'voice keeps a zero offset');
  assert.deepEqual(voice.extra_material_refs, []);
  assert.deepEqual(content.materials.speeds, []);

  const xml = buildFcp7Xml(project);
  assertWellFormedXml(xml);
  const items = clipItems(xml);
  const musicItem = items.find((item) => decodeXmlText(tagValue(item, 'name')) === '音乐');
  const voiceItem = items.find((item) => decodeXmlText(tagValue(item, 'name')) === '旁白');
  assert.ok(musicItem && voiceItem);
  assert.equal(tagValue(musicItem, 'in'), '45');
  assert.equal(tagValue(musicItem, 'out'), '210');
  assert.equal(tagValue(musicItem, 'start'), '0');
  assert.equal(tagValue(musicItem, 'end'), '165');
  assert.equal(tagValue(voiceItem, 'in'), '0');
  assert.equal(tagValue(voiceItem, 'out'), '165');
});

/**
 * Integration fixtures need real files on disk because runExport validates every source before
 * writing. The pure builders keep using the fictional paths above.
 */
async function realFixture(directory, overrides = {}) {
  const media = join(directory, 'media');
  await mkdir(media, { recursive: true });
  const paths = {
    one: join(media, '开场 clip.mp4'),
    two: join(media, 'second.mp4'),
    still: join(media, 'still.png'),
    music: join(media, '音乐.wav'),
    voice: join(media, 'voice.wav'),
  };
  for (const path of Object.values(paths)) await writeFile(path, 'media-bytes');
  return fixture({
    revision: 3,
    clips: [
      {
        id: 'clip-one', assetId: 'asset-one', path: paths.one, kind: 'video',
        start: 0, duration: 1.5, sourceIn: 0, volume: 1, track: 0,
        grading: { exposure: 0.2, contrast: 0.1 },
      },
      {
        id: 'clip-two', assetId: 'asset-two', path: paths.two, kind: 'video',
        start: 1.5, duration: 2, sourceIn: 0.5, volume: 0.8, track: 0,
      },
      {
        id: 'clip-three', assetId: 'asset-three', path: paths.still, kind: 'image',
        start: 3.5, duration: 2, sourceIn: 0, volume: 1, track: 0,
      },
    ],
    musicPath: paths.music,
    voicePath: paths.voice,
    assets: [
      {
        id: 'asset-one', name: '开场 clip.mp4', path: paths.one, kind: 'video',
        source: { provider: 'Pexels', author: 'Jane Doe', license: 'CC BY 4.0', url: 'https://example.test/clip' },
      },
    ],
    ...overrides,
  });
}

test('runExport exports per-window LUTs named grade<clip>w<window>.cube', async () => {
  if (!gradingAvailable) return;
  const directory = await mkdtemp(join(tmpdir(), 'eac-nle-windows-'));
  try {
    const project = await realFixture(directory, {
      clips: [
        {
          id: 'clip-one', assetId: 'asset-one', path: join(directory, 'media', '开场 clip.mp4'), kind: 'video',
          start: 0, duration: 1.5, sourceIn: 0, volume: 1, track: 0,
          grading: { exposure: 0.2 },
          windows: [{ shape: 'circle', grading: { saturation: 0.4 } }, { shape: 'rect' }],
        },
      ],
      captions: [],
      musicPath: undefined,
      voicePath: undefined,
    });
    const result = await runExport({ project, outputDir: directory, targets: ['lut'], settings: { lutSize: 5 } });
    const names = result.files.filter((path) => path.endsWith('.cube'))
      .map((path) => path.split(/[\\/]/).pop()).sort();
    assert.ok(names.includes('look.cube'), 'look LUT is still exported');
    assert.ok(names.some((name) => name.startsWith('clip-0-')), 'per-clip LUT is still exported');
    assert.deepEqual(
      names.filter((name) => /^grade\d+w\d+\.cube$/.test(name)),
      ['grade0w0.cube', 'grade0w1.cube'],
      'one LUT per window, named by clip and window index',
    );
    const windowCube = await readFile(join(directory, 'lut', 'grade0w0.cube'), 'utf8');
    assert.match(windowCube, /LUT_3D_SIZE 5/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('jianYingDefaultDraftRoot follows the platform and LOCALAPPDATA', () => {
  if (process.platform !== 'win32') {
    assert.equal(jianYingDefaultDraftRoot(), null);
    return;
  }
  const original = process.env.LOCALAPPDATA;
  try {
    process.env.LOCALAPPDATA = 'C:\\Users\\tester\\AppData\\Local';
    assert.equal(jianYingDefaultDraftRoot(),
      join('C:\\Users\\tester\\AppData\\Local', 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft'));
    delete process.env.LOCALAPPDATA;
    assert.equal(jianYingDefaultDraftRoot(), '');
  } finally {
    if (original === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = original;
  }
});

test('runExport writes the complete delivery set with absolute existing paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-nle-all-'));
  try {
    const project = await realFixture(directory);
    const result = await runExport({ project, outputDir: directory, settings: { lutSize: 9 } });
    assert.equal(result.draftName, buildJianYingDraft(project).draftName);
    assert.ok(result.draftFolder && isAbsolute(result.draftFolder));
    assert.equal(await stat(result.draftFolder).then((value) => value.isDirectory()), true);
    assert.ok(Array.isArray(result.notes));

    // draft 2 + xml 1 + srt 1 + luts 2 + readme 1 + manifest 1 + zip 1
    const expected = gradingAvailable ? 9 : 7;
    assert.equal(result.files.length, expected, `expected ${expected} files, got ${result.files.length}`);
    assert.equal(new Set(result.files).size, result.files.length, 'manifest files are unique');
    for (const path of result.files) {
      assert.ok(isAbsolute(path), `${path} is absolute`);
      const info = await stat(path);
      assert.equal(info.isFile(), true);
      assert.ok(info.size > 0);
    }
    assert.ok(result.manifest.endsWith('manifest.json'));
    assert.ok(result.zip.endsWith('.zip'));

    const rootEntries = (await readdir(directory)).sort();
    for (const name of ['bundle', 'jianying', 'manifest.json', 'premiere-xml', 'srt']) {
      assert.ok(rootEntries.includes(name), `output has ${name}`);
    }
    assert.ok(rootEntries.some((name) => name.endsWith('-handoff.zip')));
    const xmlFile = result.files.find((path) => path.endsWith('-premiere.xml'));
    assert.ok(xmlFile);
    assertWellFormedXml(await readFile(xmlFile, 'utf8'));
    assert.equal(await readFile(join(directory, 'srt', 'captions.srt'), 'utf8'), buildCaptionsSrt(project.captions));

    const draftFile = result.files.find((path) => path.endsWith('draft_content.json'));
    const content = JSON.parse(await readFile(draftFile, 'utf8'));
    assert.deepEqual(content.tracks.map((track) => track.type),
      ['video', 'audio', 'audio', 'audio', 'text'],
      'video, source audio, music, voice and text tracks');

    const readme = await readFile(join(directory, 'bundle', 'README.txt'), 'utf8');
    for (const keyword of ['剪映', 'Premiere', 'Resolve', 'Photoshop', '必剪', 'LUT', 'Pexels', 'Jane Doe', 'CC BY 4.0', '变速', '蒙版', 'musicStart']) {
      assert.ok(readme.includes(keyword), `README mentions ${keyword}`);
    }

    const manifest = JSON.parse(await readFile(result.manifest, 'utf8'));
    assert.equal(manifest.sourceRevision, 3);
    assert.equal(manifest.formatValidation, 'format-only');
    assert.equal(manifest.verifiedInNle, false);
    assert.ok(manifest.media.every((entry) => entry.exists === true), 'every delivered source exists');
    assert.equal(manifest.media.length, 5, 'three clips, music and voice');

    if (gradingAvailable) {
      const luts = result.files.filter((path) => path.endsWith('.cube')).sort();
      assert.equal(luts.length, 2);
      assert.ok(luts.some((path) => path.endsWith('look.cube')));
      assert.ok(luts.some((path) => /[\\/]clip-0-[^\\/]+\.cube$/.test(path)));
      assert.ok(!luts.some((path) => /clip-1-|clip-2-/.test(path)), 'only clips with their own grading get a LUT');
      for (const path of luts) {
        const cube = await readFile(path, 'utf8');
        assert.match(cube, /LUT_3D_SIZE 9/);
        assert.ok(cube.split('\n').length > 100);
      }
    } else {
      assert.equal(await readdir(join(directory, 'lut')).catch(() => []), []);
      assert.ok(result.notes.some((note) => /LUT/.test(note)), 'skipped LUTs are explained in notes');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runExport honors a single target and an explicit empty target list', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-nle-targets-'));
  try {
    const project = await realFixture(directory);
    const onlySrt = await runExport({ project, outputDir: directory, targets: ['srt'] });
    assert.equal(onlySrt.draftFolder, null);
    const srt = onlySrt.files.find((path) => path.endsWith('captions.srt'));
    assert.equal(srt, join(directory, 'srt', 'captions.srt'));
    assert.ok(isAbsolute(srt));
    assert.equal((await stat(srt)).isFile(), true);
    // manifest + zip are always part of the handoff envelope.
    assert.deepEqual(onlySrt.files.map((path) => path.split(/[\\/]/).pop()).sort(),
      ['captions.srt', 'manifest.json', '测试片 & 引号-handoff.zip'].sort());

    const second = await mkdtemp(join(tmpdir(), 'eac-nle-empty-targets-'));
    try {
      const all = await runExport({ project, outputDir: second, targets: [], settings: { lutSize: 5 } });
      const expected = gradingAvailable ? 9 : 7;
      assert.equal(all.files.length, expected);
      assert.ok(all.draftFolder);
    } finally {
      await rm(second, { recursive: true, force: true });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runExport skips SRT without captions and explains why', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-nle-nocaptions-'));
  try {
    const project = await realFixture(directory, { captions: [] });
    const result = await runExport({ project, outputDir: directory, targets: ['srt'] });
    assert.ok(!result.files.some((path) => path.endsWith('.srt')), 'no SRT is written');
    assert.ok(result.notes.some((note) => /字幕/.test(note)), 'note mentions missing captions');
    assert.ok(result.files.some((path) => path.endsWith('manifest.json')));
    assert.ok(!(await readdir(directory)).includes('srt'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runExport rejects unknown targets and pre-aborted signals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-nle-validation-'));
  try {
    await assert.rejects(
      runExport({ project: fixture(), outputDir: directory, targets: ['unknown'] }),
      /Unknown export target/,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runExport({ project: fixture(), outputDir: directory, targets: ['srt'], signal: controller.signal }),
      { name: 'AbortError' },
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runExport tolerates invalid grading and keeps other LUT targets', async () => {
  if (!gradingAvailable) return;
  const directory = await mkdtemp(join(tmpdir(), 'eac-nle-badgrading-'));
  try {
    const base = await realFixture(directory);
    const project = {
      ...base,
      clips: base.clips.map((clip, index) => (
        index === 1 ? { ...clip, grading: { exposure: 99 } } : clip
      )),
    };
    const result = await runExport({
      project,
      outputDir: directory,
      targets: ['lut', 'bundle'],
      settings: { lutSize: 5 },
    });
    assert.ok(result.notes.some((note) => /调色参数无效|LUT/.test(note)), 'invalid grading is reported');
    const luts = result.files.filter((path) => path.endsWith('.cube'));
    assert.ok(luts.some((path) => path.endsWith('look.cube')), 'valid look LUT is still written');
    assert.ok(!luts.some((path) => /clip-1-/.test(path)), 'invalid clip LUT is skipped');
    assert.ok(result.files.some((path) => path.endsWith('README.txt')));
    for (const path of result.files) assert.equal((await stat(path)).isFile(), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runExport writes only the requested jianying draft files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-nle-jianying-'));
  try {
    const project = await realFixture(directory);
    const result = await runExport({ project, outputDir: directory, targets: ['jianying'] });
    assert.ok(result.files.some((path) => /draft_content\.json$/.test(path)));
    assert.ok(result.files.some((path) => /draft_meta_info\.json$/.test(path)));
    assert.ok(result.files.some((path) => path.endsWith('manifest.json')));
    assert.ok(result.files.some((path) => path.endsWith('-handoff.zip')));
    assert.ok(result.draftFolder);
    assert.deepEqual((await readdir(directory)).sort(),
      ['jianying', 'manifest.json', 'media', '测试片 & 引号-handoff.zip'].sort());
    assert.deepEqual(await listFiles(join(directory, 'jianying')).then((files) => files.map((path) => path.split(/[\\/]/).pop()).sort()),
      ['draft_content.json', 'draft_meta_info.json']);
    for (const path of result.files) assert.ok((await stat(path)).size > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* NLE fidelity, LUT delivery, manifest and handoff archive             */
/* ------------------------------------------------------------------ */

function trackBlocks(xml, section) {
  const start = xml.indexOf(`<${section}>`);
  const end = xml.indexOf(`</${section}>`, start);
  assert.ok(start >= 0 && end > start, `missing <${section}> section`);
  return [...xml.slice(start, end).matchAll(/<track>[\s\S]*?<\/track>/g)].map((match) => match[0]);
}

function itemNames(track) {
  return clipItems(track).map((item) => decodeXmlText(tagValue(item, 'name')));
}

test('buildFcp7Xml writes real time-remap filters and independent video/audio tracks', () => {
  const SOURCE_AUDIO = 'C:/audio/source.wav';
  const project = fixture({
    clips: [
      { id: 'v0', path: VIDEO_ONE, kind: 'video', start: 0, duration: 2, sourceIn: 0.5, track: 0, speed: 2, volume: 1 },
      { id: 'v1', path: VIDEO_TWO, kind: 'video', start: 0, duration: 1, sourceIn: 0, track: 1, speed: 1, volume: 0 },
      { id: 'a1', path: SOURCE_AUDIO, kind: 'audio', start: 0, duration: 1, sourceIn: 0, track: 0, speed: 1, volume: 1 },
    ],
    captions: [],
    musicPath: MUSIC,
    voicePath: VOICE,
    look: undefined,
  });
  const xml = buildFcp7Xml(project);
  assertWellFormedXml(xml);

  const videoTracks = trackBlocks(xml, 'video');
  assert.equal(videoTracks.length, 2, 'one video track per clip.track value');
  assert.deepEqual(itemNames(videoTracks[0]), ['开场 clip.mp4']);
  assert.deepEqual(itemNames(videoTracks[1]), ['second.mp4']);

  const audioTracks = trackBlocks(xml, 'audio');
  assert.equal(audioTracks.length, 4,
    'the overlapping source-audio clip and v0 source audio split into lanes, plus music and voice');
  assert.deepEqual(itemNames(audioTracks[0]), ['source.wav'], 'the audio-kind clip takes the lower lane');
  assert.deepEqual(itemNames(audioTracks[1]), ['开场 clip.mp4'], 'v0 source audio moves to the next lane');
  assert.deepEqual(itemNames(audioTracks[2]), ['音乐'], 'music has a dedicated track');
  assert.deepEqual(itemNames(audioTracks[3]), ['旁白'], 'voice has a dedicated track');
  // Neither source-audio item is dropped: EAC mixing of simultaneous audio survives the export.
  for (const track of audioTracks.slice(0, 2)) {
    const items = clipItems(track);
    for (let index = 1; index < items.length; index++) {
      assert.ok(Number(tagValue(items[index], 'start')) >= Number(tagValue(items[index - 1], 'end')),
        'audio items inside one XML track never overlap');
    }
  }

  const fast = clipItems(videoTracks[0])[0];
  assert.match(fast, /<effectid>timeremap<\/effectid>/, '2x clip carries a real FCP7 time-remap filter');
  assert.match(fast, /<parameterid>speed<\/parameterid><name>speed<\/name><value>200\.000000<\/value>/);
  assert.match(fast, /<parameterid>variablespeed<\/parameterid>[\s\S]*?<value>0<\/value>/);
  assert.match(fast, /<parameterid>frameblending<\/parameterid>[\s\S]*?<value>FALSE<\/value>/);
  const normal = clipItems(videoTracks[1])[0];
  assert.doesNotMatch(normal, /timeremap/, '1x clips stay free of a time-remap filter');
  // in/out still describe the consumed source range, so timeremap and frame math agree.
  assert.equal(tagValue(fast, 'in'), '15');
  assert.equal(tagValue(fast, 'out'), '135');
  assert.equal(tagValue(fast, 'start'), '0');
  assert.equal(tagValue(fast, 'end'), '60');
});

test('buildFcp7Xml uses the asset probe timebase for file rate and source in/out', () => {
  const project = fixture({
    clips: [
      { id: 'v', path: VIDEO_ONE, kind: 'video', start: 0, duration: 2, sourceIn: 1, speed: 1, volume: 0 },
    ],
    captions: [],
    musicPath: undefined,
    voicePath: undefined,
    look: undefined,
    assets: [{
      id: 'asset-one', name: '开场 clip.mp4', path: VIDEO_ONE, kind: 'video',
      probe: { fps: '25/1', format: { duration: '10.0' } },
    }],
  });
  const xml = buildFcp7Xml(project);
  assertWellFormedXml(xml);
  assert.equal(Number(tagValue(xml, 'timebase')), 30, 'sequence keeps the project rate');
  const item = clipItems(xml)[0];
  assert.equal(tagValue(item, 'in'), '25', 'sourceIn is expressed in the 25 fps source timebase');
  assert.equal(tagValue(item, 'out'), '75');
  assert.equal(tagValue(item, 'duration'), '50');
  assert.equal(Number(tagValue(item, 'timebase')), 25, 'clipitem rate follows the source timebase');
  assert.equal(Number(tagValue(item, 'duration', 2)), 250, 'file duration comes from probe.format.duration');
});

test('buildFcp7Xml does not require media files to exist (pure builder)', () => {
  const xml = buildFcp7Xml(fixture({ clips: fixture().clips, look: undefined }));
  assertWellFormedXml(xml);
  assert.ok(clipItems(xml).length > 0);
});

test('runExport copies camera input and creative LUTs and documents the application order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-nle-luts-'));
  try {
    const media = join(directory, 'media');
    await mkdir(media, { recursive: true });
    const video = join(media, 'shot.mp4');
    const music = join(media, 'bed.wav');
    const voice = join(media, 'narration.wav');
    const inputLut = join(media, 'camera-log.cube');
    const creativeLut = join(media, 'film-look.cube');
    for (const path of [video, music, voice]) await writeFile(path, 'media-bytes');
    const inputCube = 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';
    const creativeCube = `${inputCube}# creative\n`;
    await writeFile(inputLut, inputCube);
    await writeFile(creativeLut, creativeCube);

    const project = fixture({
      revision: 7,
      clips: [{ id: 'c0', path: video, kind: 'video', start: 0, duration: 1, sourceIn: 0, track: 0, volume: 1, inputLut, lut: creativeLut }],
      captions: [],
      musicPath: music,
      voicePath: voice,
      look: undefined,
      assets: [],
    });
    const output = join(directory, 'out');
    const result = await runExport({ project, outputDir: output, targets: ['lut', 'bundle'], settings: { lutSize: 5 } });

    const inputCopy = join(output, 'lut', 'input', 'clip-0-shot.cube');
    const creativeCopy = join(output, 'lut', 'creative', 'clip-0-shot.cube');
    assert.equal(await readFile(inputCopy, 'utf8'), inputCube, 'camera input LUT is actually copied');
    assert.equal(await readFile(creativeCopy, 'utf8'), creativeCube, 'creative LUT is actually copied');
    assert.ok(result.files.includes(inputCopy) && result.files.includes(creativeCopy));

    const readme = await readFile(join(output, 'bundle', 'README.txt'), 'utf8');
    assert.match(readme, /输入 LUT/, 'README names the camera input conversion');
    assert.match(readme, /创意 LUT/);
    assert.match(readme, /独立分支/, 'README states independent graded branches');
    assert.match(readme, /双重调色/, 'README warns about the double-grade mistake');
    assert.match(readme, /不是全自动|不会自动|需人工|未保留/, 'README does not claim full automatic preservation');

    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
    assert.equal(manifest.sourceRevision, 7);
    assert.equal(manifest.formatValidation, 'format-only');
    assert.equal(manifest.verifiedInNle, false);
    const luts = manifest.luts.map((entry) => entry.role);
    assert.deepEqual(luts.slice(0, 2), ['input', 'creative']);
    assert.equal(manifest.luts[0].source, resolve(inputLut));
    assert.equal(manifest.luts[0].exported, 'lut/input/clip-0-shot.cube');
    // The LUT order is only the shared pre-chain; base and windows are sibling branches.
    assert.deepEqual(manifest.capabilities.externalLut.order, ['inputLut', 'lut']);
    assert.equal(manifest.capabilities.externalLut.automatic, false);
    assert.equal(manifest.capabilities.externalLut.branches, 'base-and-each-window-are-independent');
    assert.equal(manifest.color.clips[0].clipId, 'c0');
    assert.equal(manifest.color.clips[0].inputLut.exported, 'lut/input/clip-0-shot.cube');
    assert.equal(manifest.capabilities.motion.retained, false);
    assert.equal(manifest.capabilities.speed.jianying, 'native');
    assert.equal(manifest.capabilities.speed.premiereXml, 'timeremap-filter');
    assert.ok(manifest.media.some((entry) => entry.path === resolve(video) && entry.exists === true));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runExport writes a one-click handoff ZIP containing every delivered file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-nle-zip-'));
  try {
    const output = join(directory, 'out');
    const project = await realFixture(directory, {
      captions: fixture().captions,
      look: { exposure: 0.1 },
    });
    const result = await runExport({ project, outputDir: output, settings: { lutSize: 5 } });
    assert.ok(result.zip && result.zip.endsWith('.zip'), 'runExport reports the archive path');
    assert.ok(isAbsolute(result.zip));
    assert.ok(result.manifest && result.manifest.endsWith('manifest.json'));
    assert.ok(result.files.includes(result.zip));
    assert.ok(result.files.includes(result.manifest));

    const bytes = await readFile(result.zip);
    assert.equal(bytes.readUInt32LE(0), 0x04034b50, 'ZIP local file header signature');
    assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50, 'ZIP end-of-central-directory signature');
    const names = bytes.toString('latin1');
    for (const needle of ['manifest.json', 'draft_content.json', 'draft_meta_info.json', 'README.txt', 'captions.srt', '-premiere.xml']) {
      assert.ok(names.includes(needle), `archive contains ${needle}`);
    }
    const entryCount = bytes.readUInt16LE(bytes.length - 12);
    assert.ok(entryCount >= 8, `archive has all entries, got ${entryCount}`);

    // Prefer a real reader when the transitive jszip is available.
    try {
      const { default: JSZip } = await import('jszip');
      const zip = await JSZip.loadAsync(bytes);
      const archiveNames = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
      assert.ok(archiveNames.includes('manifest.json'));
      assert.ok(archiveNames.some((name) => name.endsWith('draft_content.json')));
      assert.equal(await zip.file('manifest.json').async('string'), await readFile(result.manifest, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND' && error?.code !== 'MODULE_NOT_FOUND') throw error;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runExport rejects missing media, missing LUT files and an empty timeline before writing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-nle-missing-'));
  try {
    const output = join(directory, 'out');
    const missing = join(directory, 'does-not-exist.mp4');
    const project = fixture({
      clips: [{ id: 'c0', path: missing, kind: 'video', start: 0, duration: 1, sourceIn: 0, volume: 1 }],
      captions: [], musicPath: undefined, voicePath: undefined, look: undefined, assets: [],
    });
    await assert.rejects(runExport({ project, outputDir: output, targets: ['srt'] }), /丢失|不存在|missing/i);

    const empty = fixture({ clips: [], captions: [], musicPath: undefined, voicePath: undefined, look: undefined });
    await assert.rejects(runExport({ project: empty, outputDir: output, targets: ['srt'] }), /时间线为空|empty timeline/i);

    const existing = join(directory, 'clip.mp4');
    await writeFile(existing, 'bytes');
    const missingMusic = fixture({
      clips: [{ id: 'c0', path: existing, kind: 'video', start: 0, duration: 1, sourceIn: 0, volume: 0 }],
      captions: [], musicPath: join(directory, 'no-music.wav'), voicePath: undefined, look: undefined, assets: [],
    });
    await assert.rejects(runExport({ project: missingMusic, outputDir: output, targets: ['lut'] }), /丢失|不存在|missing/i);

    const missingLut = fixture({
      clips: [{ id: 'c0', path: existing, kind: 'video', start: 0, duration: 1, sourceIn: 0, volume: 0, inputLut: join(directory, 'no.cube') }],
      captions: [], musicPath: undefined, voicePath: undefined, look: undefined, assets: [],
    });
    await assert.rejects(runExport({ project: missingLut, outputDir: output, targets: ['lut'] }), /丢失|不存在|missing/i);
    assert.deepEqual(await readdir(directory), ['clip.mp4'], 'nothing is written before validation passes');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runExport accepts a settings.draftName so hosts can avoid overwriting a human-edited draft', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-nle-draftname-'));
  try {
    const result = await runExport({
      project: await realFixture(directory), outputDir: directory, targets: ['jianying'], settings: { draftName: 'EAC job-42' },
    });
    assert.equal(result.draftName, 'EAC job-42');
    assert.ok(result.draftFolder.endsWith('EAC job-42'));
    const meta = JSON.parse(await readFile(join(result.draftFolder, 'draft_meta_info.json'), 'utf8'));
    assert.equal(meta.draft_name, 'EAC job-42');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* JianYing draft track layout (source audio, tracks, overlaps)         */
/* ------------------------------------------------------------------ */

function draftTracks(project) {
  const content = JSON.parse(buildJianYingDraft(project).files['draft_content.json']);
  return content.tracks;
}

function segmentsOverlap(a, b) {
  return a.target_timerange.start < b.target_timerange.start + b.target_timerange.duration
    && b.target_timerange.start < a.target_timerange.start + a.target_timerange.duration;
}

test('jianying draft keeps every source audio exactly once and splits video/audio by clip.track', () => {
  const SOURCE_AUDIO = 'C:/audio/source.wav';
  const project = fixture({
    clips: [
      // Two visual layers on different EAC tracks, both audible.
      { id: 'v0', path: VIDEO_ONE, kind: 'video', start: 0, duration: 2, sourceIn: 0, volume: 1, track: 0 },
      { id: 'v1', path: VIDEO_TWO, kind: 'video', start: 0, duration: 2, sourceIn: 0, volume: 0.5, track: 1 },
      // A dedicated audio clip on the same EAC track as v0, overlapping its source audio.
      { id: 'a0', path: SOURCE_AUDIO, kind: 'audio', start: 0.5, duration: 1.5, sourceIn: 0, volume: 1, track: 0 },
    ],
    captions: [],
    musicPath: MUSIC,
    voicePath: VOICE,
    look: undefined,
  });
  const tracks = draftTracks(project);
  const videoTracks = tracks.filter((track) => track.type === 'video');
  const audioTracks = tracks.filter((track) => track.type === 'audio');

  // Video: one track per EAC track, and the video segment itself is muted so the source
  // audio is not played twice (once by the video segment, once by its audio segment).
  assert.equal(videoTracks.length, 2, 'one video track per clip.track');
  for (const track of videoTracks) {
    assert.equal(track.segments.length, 1);
    assert.equal(track.segments[0].volume, 0, 'video segments never carry their own source audio');
  }

  // Each audible clip contributes exactly one audio segment.
  const allAudio = audioTracks.flatMap((track) => track.segments);
  assert.equal(allAudio.length, 5, 'v0 + v1 + a0 + music + voice');
  const audioMaterialById = new Map(
    JSON.parse(buildJianYingDraft(project).files['draft_content.json']).materials.audios.map((m) => [m.id, m]),
  );
  const countFor = (path) => allAudio.filter((segment) => audioMaterialById.get(segment.material_id)?.path.endsWith(path)).length;
  assert.equal(countFor('开场 clip.mp4'), 1, 'source audio of v0 is present exactly once');
  assert.equal(countFor('second.mp4'), 1);
  assert.equal(countFor('source.wav'), 1);
  assert.equal(countFor('音乐.wav'), 1);
  assert.equal(countFor('voice.wav'), 1);

  // Audio layout: v0 and a0 share EAC track 0 but overlap, so they land on separate lanes;
  // v1 keeps track 1; music and voice each get a dedicated track.
  assert.equal(audioTracks.length, 5, 'two lanes for track 0, one for track 1, music, voice');
  for (const track of audioTracks) {
    for (let i = 1; i < track.segments.length; i++) {
      assert.ok(!segmentsOverlap(track.segments[i - 1], track.segments[i]), 'segments on one track never overlap');
    }
  }
  const soloTracks = audioTracks.filter((track) => track.segments.length === 1)
    .map((track) => audioMaterialById.get(track.segments[0].material_id)?.path.split('/').pop());
  assert.ok(soloTracks.includes('音乐.wav'), 'music has its own audio track');
  assert.ok(soloTracks.includes('voice.wav'), 'voice has its own audio track');
});

test('jianying draft splits overlapping captions into separate text tracks', () => {
  const project = fixture({
    clips: [fixture().clips[0]],
    captions: [
      { start: 0, end: 2, text: 'A' },
      { start: 1, end: 3, text: 'B' },
      { start: 2.5, end: 4, text: 'C' },
    ],
    musicPath: undefined,
    voicePath: undefined,
    look: undefined,
  });
  const tracks = draftTracks(project);
  const textTracks = tracks.filter((track) => track.type === 'text');
  assert.equal(textTracks.length, 2, 'A+C share a lane, B needs its own');
  for (const track of textTracks) {
    for (let i = 1; i < track.segments.length; i++) {
      assert.ok(!segmentsOverlap(track.segments[i - 1], track.segments[i]), 'text segments on one track never overlap');
    }
  }
  assert.deepEqual(
    textTracks.map((track) => track.segments.length).sort(),
    [1, 2],
  );
});

test('jianying draft identity includes the draft name so renamed drafts are new projects', () => {
  const project = fixture({ clips: [fixture().clips[0]], captions: [], musicPath: undefined, voicePath: undefined });
  const read = (draftName) => {
    const built = buildJianYingDraft(project, { draftName });
    return {
      content: JSON.parse(built.files['draft_content.json']),
      meta: JSON.parse(built.files['draft_meta_info.json']),
    };
  };
  const first = read('EAC job-a');
  const again = read('EAC job-a');
  const renamed = read('EAC job-b');

  assert.equal(first.content.id, again.content.id, 'the same name stays deterministic');
  assert.equal(first.meta.draft_id, again.meta.draft_id);
  assert.notEqual(first.content.id, renamed.content.id, 'a new draft name is a distinct draft content id');
  assert.notEqual(first.meta.draft_id, renamed.meta.draft_id, 'a new draft name is a distinct draft meta id');
});
