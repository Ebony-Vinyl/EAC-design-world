import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { buildFcp7Xml, buildJianYingDraft, runExport } from '../src/export-nle.mjs';

/*
 * Regressions for review issues 7-12 of the NLE export:
 *   7  audio clipitems need the same speed filter as video
 *   8  clip volume and the 0.22 music gain must reach the XML
 *   9  overlapping clips on one EAC track need separate lanes (stacking / mixing)
 *  10  NTSC source rates need <ntsc>TRUE</ntsc> and frame math on the real rate
 *  11  music looping is split at repeat boundaries from probe metadata; voice keeps its real
 *      length; fades stay attached to the bed's head/tail
 *  12  the LUT handoff describes independent graded branches, not a serial double grade, and
 *      the manifest keeps clip/window LUT + geometry mappings
 */

let gradingAvailable = false;
try {
  const grading = await import('../src/media/grading.mjs');
  gradingAvailable = typeof grading.writeCubeLut === 'function';
} catch {
  gradingAvailable = false;
}

function clipItems(xml) {
  return [...xml.matchAll(/<clipitem id="clipitem-\d+">[\s\S]*?<\/clipitem>/g)].map((match) => match[0]);
}

function tagValue(block, name, occurrence = 1) {
  const matches = [...block.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, 'g'))];
  assert.ok(matches.length >= occurrence, `missing <${name}> #${occurrence} in ${block.slice(0, 240)}`);
  return matches[occurrence - 1][1];
}

function decodeXmlText(value) {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function itemNames(xml) {
  return clipItems(xml).map((item) => decodeXmlText(tagValue(item, 'name')));
}

function isAudioItem(item) {
  return item.includes('<sourcetrack><mediatype>audio</mediatype>');
}

function filterNamed(item, name) {
  const filters = [...item.matchAll(/<filter>[\s\S]*?<\/filter>/g)].map((match) => match[0]);
  return filters.find((filter) => tagValue(filter, 'name') === name) ?? null;
}

function audioLevelGain(item) {
  const filter = filterNamed(item, 'Audio Levels');
  assert.ok(filter, 'audio item carries an Audio Levels gain filter');
  assert.match(filter, /<effectid>audiolevels<\/effectid>/);
  assert.match(filter, /<mediatype>audio<\/mediatype>/);
  // FCP7 xmeml audiolevels/level is a linear gain (1.0 = unity, 0..3.98109 in Apple/OpenShot
  // templates), not decibels.
  const value = Number(/<parameterid>level<\/parameterid>[\s\S]*?<value>(-?\d+(?:\.\d+)?)<\/value>/.exec(filter)[1]);
  return value;
}

function rateOf(block) {
  const match = /<rate><timebase>(\d+)<\/timebase><ntsc>(TRUE|FALSE)<\/ntsc><\/rate>/.exec(block);
  assert.ok(match, `missing rate block in ${block.slice(0, 200)}`);
  return { timebase: Number(match[1]), ntsc: match[2] === 'TRUE' };
}

function sequenceOf(xml) {
  const match = /<sequence id="sequence-1">([\s\S]*?)<\/sequence>/.exec(xml);
  assert.ok(match, 'missing sequence');
  return match[1];
}

function trackBlocks(xml, section) {
  const start = xml.indexOf(`<${section}>`);
  const end = xml.indexOf(`</${section}>`, start);
  assert.ok(start >= 0 && end > start, `missing <${section}> section`);
  return [...xml.slice(start, end).matchAll(/<track>[\s\S]*?<\/track>/g)].map((match) => match[0]);
}

function fixture(overrides = {}) {
  return {
    id: 'regression-project',
    title: '回归项目',
    width: 1920,
    height: 1080,
    fps: 30,
    clips: [],
    captions: [],
    ...overrides,
  };
}

function closeTo(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} != ${expected} (±${tolerance})`);
}

/* Issue 7 ------------------------------------------------------------- */

test('issue 7: audio clipitems carry a real time-remap filter for non-1 speeds', () => {
  const project = fixture({
    clips: [
      { id: 'v', path: 'C:/m/v.mp4', kind: 'video', start: 0, duration: 2, sourceIn: 0, speed: 2, volume: 1, track: 0 },
      { id: 'a', path: 'C:/m/a.wav', kind: 'audio', start: 0, duration: 2, sourceIn: 0, speed: 2, volume: 1, track: 0 },
    ],
    musicPath: undefined,
    voicePath: undefined,
  });
  const xml = buildFcp7Xml(project);
  const items = clipItems(xml);
  const audioItems = items.filter(isAudioItem);
  assert.equal(audioItems.length, 2, 'one source-audio item for the video clip and one for the audio clip');

  for (const item of audioItems) {
    const filter = filterNamed(item, 'Time Remap');
    assert.ok(filter, `${tagValue(item, 'name')} audio item has a time-remap filter`);
    assert.match(filter, /<effectid>timeremap<\/effectid>/);
    assert.match(filter, /<mediatype>audio<\/mediatype>/, 'the filter declares the audio media type');
    assert.match(filter, /<parameterid>speed<\/parameterid>[\s\S]*?<value>200\.000000<\/value>/);
    assert.match(filter, /<parameterid>variablespeed<\/parameterid>[\s\S]*?<value>0<\/value>/);
    assert.match(filter, /<parameterid>frameblending<\/parameterid>[\s\S]*?<value>FALSE<\/value>/);
  }
  for (const item of audioItems) {
    assert.equal(Number(tagValue(item, 'out')) - Number(tagValue(item, 'in')), 120,
      'the source range is still stretched by speed');
  }
});

/* Issue 8 ------------------------------------------------------------- */

test('issue 8: clip volume and music gain reach the XML as audio gain filters', () => {
  const build = (volume) => buildFcp7Xml(fixture({
    clips: [{ id: 'v', path: 'C:/m/v.mp4', kind: 'video', start: 0, duration: 2, sourceIn: 0, volume, track: 0 }],
    musicPath: 'C:/m/bed.wav',
    voicePath: undefined,
  }));
  const loud = build(0.8);
  const quiet = build(0.5);
  assert.notEqual(loud, quiet, 'different volumes must not produce byte-identical XML');

  const loudAudio = clipItems(loud).find((item) => isAudioItem(item) && tagValue(item, 'name') === 'v.mp4');
  const quietAudio = clipItems(quiet).find((item) => isAudioItem(item) && tagValue(item, 'name') === 'v.mp4');
  closeTo(audioLevelGain(loudAudio), 0.8, 1e-5, 'clip gain 0.8 is written as dB');
  closeTo(audioLevelGain(quietAudio), 0.5, 1e-5, 'clip gain 0.5 is written as dB');

  const music = clipItems(loud).find((item) => tagValue(item, 'name') === '音乐');
  closeTo(audioLevelGain(music), 0.22, 1e-5, 'the music bed keeps its fixed 0.22 gain');

  const unity = clipItems(buildFcp7Xml(fixture({
    clips: [{ id: 'v', path: 'C:/m/v.mp4', kind: 'video', start: 0, duration: 2, sourceIn: 0, volume: 1, track: 0 }],
    musicPath: undefined,
    voicePath: undefined,
  }))).find((item) => isAudioItem(item));
  assert.equal(filterNamed(unity, 'Audio Levels'), null, 'unity gain needs no no-op filter');
});

/* Issue 9 ------------------------------------------------------------- */

test('issue 9: overlapping clips on one EAC track split into lanes and keep stacking/mixing', () => {
  const project = fixture({
    clips: [
      { id: 'v0', path: 'C:/m/v0.mp4', kind: 'video', start: 0, duration: 2, sourceIn: 0, volume: 0, track: 0 },
      { id: 'v1', path: 'C:/m/v1.mp4', kind: 'video', start: 1, duration: 2, sourceIn: 0, volume: 0, track: 0 },
      { id: 'v2', path: 'C:/m/v2.mp4', kind: 'video', start: 0, duration: 1, sourceIn: 0, volume: 0, track: 1 },
      { id: 'a0', path: 'C:/m/a0.wav', kind: 'audio', start: 0, duration: 2, sourceIn: 0, volume: 1, track: 0 },
      { id: 'a1', path: 'C:/m/a1.wav', kind: 'audio', start: 1, duration: 2, sourceIn: 0, volume: 0.6, track: 0 },
    ],
    musicPath: undefined,
    voicePath: undefined,
  });
  const xml = buildFcp7Xml(project);

  const videoTracks = trackBlocks(xml, 'video');
  assert.equal(videoTracks.length, 3, 'track 0 needs two lanes and track 1 keeps one');
  assert.deepEqual(videoTracks.map((track) => itemNames(track)), [['v0.mp4'], ['v1.mp4'], ['v2.mp4']],
    'lanes are ordered bottom-to-top, so the later overlapping clip stacks above');
  for (const track of videoTracks) {
    const items = clipItems(track);
    for (let index = 1; index < items.length; index++) {
      assert.ok(Number(tagValue(items[index], 'start')) >= Number(tagValue(items[index - 1], 'end')),
        'items inside one XML track never overlap');
    }
  }
  // Same-track overlap is legal in EAC; both clips remain in the sequence.
  assert.deepEqual(itemNames(xml).filter((name) => /^v\d\.mp4$/.test(name)).sort(), ['v0.mp4', 'v1.mp4', 'v2.mp4']);

  const audioTracks = trackBlocks(xml, 'audio');
  assert.equal(audioTracks.length, 2, 'two overlapping audio clips on one EAC track land on two lanes');
  assert.deepEqual(audioTracks.map((track) => itemNames(track)), [['a0.wav'], ['a1.wav']],
    'both source-audio clips survive so the NLE mixes them');
  closeTo(audioLevelGain(clipItems(audioTracks[1])[0]), 0.6, 1e-5, 'the lane keeps the clip gain');
});

/* Issue 10 ------------------------------------------------------------ */

test('issue 10: NTSC rates are written as ntsc TRUE and frames use the real rate', () => {
  const project = fixture({
    fps: '30000/1001',
    clips: [{ id: 'v', path: 'C:/m/v.mp4', kind: 'video', start: 0, duration: 600, sourceIn: 0, volume: 0, track: 0 }],
    musicPath: undefined,
    voicePath: undefined,
    assets: [{ id: 'asset', path: 'C:/m/v.mp4', kind: 'video', probe: { fps: '30000/1001', format: { duration: '700.0' } } }],
  });
  const xml = buildFcp7Xml(project);
  const sequence = sequenceOf(xml);
  const sequenceRate = rateOf(sequence);
  assert.deepEqual(sequenceRate, { timebase: 30, ntsc: true }, '29.97 fps is timebase 30 with ntsc TRUE');
  const totalFrames = Number(/<duration>(\d+)<\/duration>/.exec(sequence)[1]);
  assert.equal(totalFrames, 17982, '600 s at 30000/1001 rounds to 17982 whole frames');
  closeTo(totalFrames * 1001 / 30000, 600, 0.01, 'the NTSC timebase reconstructs 600 s instead of 599.4 s');

  const item = clipItems(xml)[0];
  assert.deepEqual(rateOf(item), { timebase: 30, ntsc: true }, 'the clipitem rate follows the NTSC source');
  assert.equal(Number(tagValue(item, 'start')), 0);
  assert.equal(Number(tagValue(item, 'end')), 17982);
  assert.equal(Number(tagValue(item, 'in')), 0);
  assert.equal(Number(tagValue(item, 'out')), 17982);
  for (const name of ['duration', 'start', 'end', 'in', 'out']) {
    assert.match(tagValue(item, name), /^\d+$/, `${name} stays an integer frame count`);
  }

  // The file rate and duration use the same NTSC timebase.
  const file = /<file id="file-[0-9a-f]{32}">[\s\S]*?<\/file>/.exec(item)[0];
  assert.deepEqual(rateOf(file), { timebase: 30, ntsc: true });
  assert.equal(Number(/<duration>(\d+)<\/duration>/.exec(file)[1]), 20979,
    '700 s of 29.97 fps source is 20979 frames');

  // A true integer rate must stay ntsc FALSE.
  const pal = buildFcp7Xml(fixture({
    fps: 25,
    clips: [{ id: 'v', path: 'C:/m/v.mp4', kind: 'video', start: 0, duration: 10, sourceIn: 0, volume: 0, track: 0 }],
    musicPath: undefined,
    voicePath: undefined,
  }));
  assert.deepEqual(rateOf(sequenceOf(pal)), { timebase: 25, ntsc: false });
});

/* Issue 11 ------------------------------------------------------------ */

test('issue 11: music loops split at repeat boundaries in XML and JianYing from probe duration', () => {
  const musicPath = 'C:/m/bed.wav';
  const assets = [{ id: 'music-asset', path: musicPath, kind: 'audio', probe: { fps: '30/1', format: { duration: '2.0' } } }];
  const project = fixture({
    clips: [{ id: 'v', path: 'C:/m/v.mp4', kind: 'video', start: 0, duration: 5, sourceIn: 0, volume: 0, track: 0 }],
    musicPath,
    musicStart: 3.5,
    fadeIn: 2.5,
    fadeOut: 1,
    voicePath: undefined,
    assets,
  });

  // XML: musicStart is taken modulo the real file length (3.5 % 2 = 1.5), then the bed wraps
  // at 2 s until the timeline is covered: 0.5 + 2 + 2 + 0.5 = 5 s.
  const xml = buildFcp7Xml(project);
  const musicItems = clipItems(xml).filter((item) => tagValue(item, 'name') === '音乐');
  assert.equal(musicItems.length, 4, 'the 5 s timeline needs four loop segments');
  assert.deepEqual(musicItems.map((item) => [tagValue(item, 'in'), tagValue(item, 'out')]),
    [['45', '60'], ['0', '60'], ['0', '60'], ['0', '15']],
    'each segment consumes a real range inside the 2 s file');
  assert.deepEqual(musicItems.map((item) => [tagValue(item, 'start'), tagValue(item, 'end')]),
    [['0', '15'], ['15', '75'], ['75', '135'], ['135', '150']], 'segments are contiguous in the sequence');
  const musicFile = /<file id="file-[0-9a-f]{32}">[\s\S]*?<\/file>/.exec(musicItems[0])[0];
  assert.equal(Number(/<duration>(\d+)<\/duration>/.exec(musicFile)[1]), 60,
    'the file element reports the real 2 s duration, not musicStart + timeline');

  const content = JSON.parse(buildJianYingDraft(project).files['draft_content.json']);
  const musicMaterial = content.materials.audios.find((material) => material.path.endsWith('bed.wav'));
  assert.equal(musicMaterial.duration, 2_000_000, 'the JianYing material is the real file length');
  const musicSegments = content.tracks.flatMap((track) => track.segments)
    .filter((segment) => segment.material_id === musicMaterial.id)
    .sort((a, b) => a.target_timerange.start - b.target_timerange.start);
  assert.deepEqual(musicSegments.map((segment) => segment.source_timerange), [
    { start: 1_500_000, duration: 500_000 },
    { start: 0, duration: 2_000_000 },
    { start: 0, duration: 2_000_000 },
    { start: 0, duration: 500_000 },
  ], 'JianYing gets the same source ranges as the XML');
  assert.deepEqual(musicSegments.map((segment) => segment.target_timerange), [
    { start: 0, duration: 500_000 },
    { start: 500_000, duration: 2_000_000 },
    { start: 2_500_000, duration: 2_000_000 },
    { start: 4_500_000, duration: 500_000 },
  ], 'the target ranges tile the whole timeline');
  assert.equal(content.materials.audio_fades.length, 0,
    'loop-split fades are volume keyframes, not per-segment audio_fades');

  // The global fade envelope (0 -> 1 over 2.5 s, 1 -> 0 over the last 1 s) is sampled into
  // volume keyframes; because each segment's keyframes use absolute timeline positions the
  // ramp is continuous across the loop boundaries instead of restarting.
  const envelope = (time) => {
    let gain = 1;
    if (time < 2.5) gain = Math.min(gain, time / 2.5);
    if (time > 4) gain = Math.min(gain, 5 - time);
    return Math.max(0, Math.min(1, gain));
  };
  for (const [index, segment] of musicSegments.entries()) {
    const list = segment.common_keyframes.find((entry) => entry.property_type === 'KFTypeVolume');
    assert.ok(list, `music segment ${index} carries volume keyframes`);
    const keys = list.keyframe_list;
    assert.equal(keys[0].time_offset, 0, 'the first keyframe starts at the segment head');
    assert.equal(keys[keys.length - 1].time_offset, segment.target_timerange.duration,
      'the last keyframe lands on the segment tail');
    const start = segment.target_timerange.start / 1e6;
    const duration = segment.target_timerange.duration / 1e6;
    for (const key of keys) {
      const time = start + key.time_offset / 1e6;
      closeTo(key.values[0], 0.22 * envelope(time), 1e-4,
        `segment ${index} keyframe at ${time}s follows the global fade envelope`);
    }
    // Continuity: the last value of a segment equals the first value of the next one.
    const next = musicSegments[index + 1];
    if (next) {
      const nextList = next.common_keyframes.find((entry) => entry.property_type === 'KFTypeVolume');
      const nextStart = next.target_timerange.start / 1e6;
      closeTo(keys[keys.length - 1].values[0], nextList.keyframe_list[0].values[0], 1e-4,
        `the fade envelope is continuous at the ${start + duration}s loop boundary`);
    }
  }

  // No probe metadata: keep the old single-segment fallback instead of guessing.
  const fallback = buildFcp7Xml(fixture({
    clips: project.clips,
    musicPath,
    musicStart: 3.5,
    voicePath: undefined,
    assets: [],
  }));
  assert.equal(clipItems(fallback).filter((item) => tagValue(item, 'name') === '音乐').length, 1);
});

test('issue 11: a 0.5 s bed with 0.25 s offset and 1 s fade-in spans three segments', () => {
  const musicPath = 'C:/m/short.wav';
  const project = fixture({
    clips: [{ id: 'v', path: 'C:/m/v.mp4', kind: 'video', start: 0, duration: 1, sourceIn: 0, volume: 0, track: 0 }],
    musicPath,
    musicStart: 0.25,
    fadeIn: 1,
    fadeOut: 0,
    voicePath: undefined,
    assets: [{ id: 'a', path: musicPath, kind: 'audio', probe: { fps: '30/1', format: { duration: '0.5' } } }],
  });

  const content = JSON.parse(buildJianYingDraft(project).files['draft_content.json']);
  const material = content.materials.audios.find((entry) => entry.path.endsWith('short.wav'));
  assert.equal(material.duration, 500_000);
  const segments = content.tracks.flatMap((track) => track.segments)
    .filter((segment) => segment.material_id === material.id)
    .sort((a, b) => a.target_timerange.start - b.target_timerange.start);
  assert.deepEqual(segments.map((segment) => segment.source_timerange), [
    { start: 250_000, duration: 250_000 },
    { start: 0, duration: 500_000 },
    { start: 0, duration: 250_000 },
  ], 'offset 0.25 leaves 0.25 s, then two more wraps cover the 1 s timeline');
  assert.deepEqual(segments.map((segment) => segment.target_timerange), [
    { start: 0, duration: 250_000 },
    { start: 250_000, duration: 500_000 },
    { start: 750_000, duration: 250_000 },
  ]);
  // fadeIn 1 s covers the whole timeline: keyframe values ramp 0 -> 0.22 monotonically and
  // continue across both loop boundaries (no reset to 0 at 0.25 s or 0.75 s).
  const values = segments.flatMap((segment) => {
    const list = segment.common_keyframes.find((entry) => entry.property_type === 'KFTypeVolume');
    return list.keyframe_list.map((key) => ({ time: (segment.target_timerange.start + key.time_offset) / 1e6, value: key.values[0] }));
  });
  closeTo(values[0].value, 0, 1e-6, 'the bed starts silent');
  closeTo(values[values.length - 1].value, 0.22, 1e-4, 'the bed reaches full gain at the timeline end');
  for (let index = 1; index < values.length; index++) {
    assert.ok(values[index].value >= values[index - 1].value - 1e-9, 'the fade-in is monotonic across splits');
    closeTo(values[index].value, 0.22 * Math.min(1, values[index].time), 1e-4,
      `keyframe at ${values[index].time}s follows the 1 s global fade-in`);
  }
  // A naive per-segment audio_fade would restart at 0.25 s and 0.75 s; assert it does not.
  assert.equal(content.materials.audio_fades.length, 0);

  const xml = buildFcp7Xml(project);
  const items = clipItems(xml).filter((item) => tagValue(item, 'name') === '音乐');
  assert.deepEqual(items.map((item) => [tagValue(item, 'in'), tagValue(item, 'out')]),
    [['8', '15'], ['0', '15'], ['0', '8']], 'XML gets the same three source ranges at 30 fps');
  assert.deepEqual(items.map((item) => [tagValue(item, 'start'), tagValue(item, 'end')]),
    [['0', '8'], ['8', '23'], ['23', '30']]);
});

test('issue 11: a short voice-over is not extended to a fictional file duration', () => {
  const voicePath = 'C:/m/voice.wav';
  const project = fixture({
    clips: [{ id: 'v', path: 'C:/m/v.mp4', kind: 'video', start: 0, duration: 5, sourceIn: 0, volume: 0, track: 0 }],
    musicPath: undefined,
    voicePath,
    assets: [{ id: 'voice-asset', path: voicePath, kind: 'audio', probe: { fps: '30/1', format: { duration: '1.2' } } }],
  });

  const xml = buildFcp7Xml(project);
  const voice = clipItems(xml).find((item) => tagValue(item, 'name') === '旁白');
  assert.equal(tagValue(voice, 'in'), '0');
  assert.equal(tagValue(voice, 'out'), '36', '1.2 s at 30 fps is 36 source frames');
  assert.equal(tagValue(voice, 'end'), '36', 'the item ends with the real file, not at 5 s');
  assert.equal(tagValue(voice, 'duration'), '36');
  const voiceFile = /<file id="file-[0-9a-f]{32}">[\s\S]*?<\/file>/.exec(voice)[0];
  assert.equal(Number(/<duration>(\d+)<\/duration>/.exec(voiceFile)[1]), 36);

  const content = JSON.parse(buildJianYingDraft(project).files['draft_content.json']);
  const voiceMaterial = content.materials.audios.find((material) => material.path.endsWith('voice.wav'));
  assert.equal(voiceMaterial.duration, 1_200_000, 'the material is the real 1.2 s file');
  const voiceSegment = content.tracks.flatMap((track) => track.segments)
    .find((segment) => segment.material_id === voiceMaterial.id);
  assert.deepEqual(voiceSegment.source_timerange, { start: 0, duration: 1_200_000 });
  assert.deepEqual(voiceSegment.target_timerange, { start: 0, duration: 1_200_000 });

  // Without probe metadata the previous timeline-length fallback still applies.
  const fallback = buildJianYingDraft(fixture({ ...project, assets: [] }));
  const fallbackContent = JSON.parse(fallback.files['draft_content.json']);
  const fallbackMaterial = fallbackContent.materials.audios.find((material) => material.path.endsWith('voice.wav'));
  assert.equal(fallbackMaterial.duration, 5_000_000);
});

/* Issue 12 ------------------------------------------------------------ */

test('color handoff maps a shared external LUT and inherited look for every clip', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-shared-lut-map-'));
  try {
    const video = join(directory, 'source.mp4');
    const inputLut = join(directory, 'camera.cube');
    await writeFile(video, 'media');
    await writeFile(inputLut, 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
    const project = fixture({ look: { exposure: 0.2 }, musicPath: undefined, voicePath: undefined,
      clips: [0, 1, 2].map(index => ({ id: `clip-${index}`, path: video, kind: 'video',
        start: index, duration: 1, sourceIn: 0, volume: 0, ...(index < 2 ? { inputLut } : {}) })) });
    const result = await runExport({ project, outputDir: join(directory, 'out'), targets: ['lut'], settings: { lutSize: 5 } });
    const manifest = JSON.parse(await readFile(result.manifest, 'utf8'));
    assert.equal(manifest.color.clips.length, 3);
    for (const clip of manifest.color.clips) assert.equal(clip.baseLut, 'lut/look.cube');
    assert.deepEqual(manifest.color.clips[1].inputLut, manifest.color.clips[0].inputLut);
    assert.equal(manifest.color.clips[1].inputLut.exported, 'lut/input/clip-0-source.cube');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('issue 12: LUT handoff documents independent branches and preserves window mappings', async () => {
  if (!gradingAvailable) return;
  const directory = await mkdtemp(join(tmpdir(), 'eac-nle-regression-lut-'));
  try {
    const media = join(directory, 'media');
    await mkdir(media, { recursive: true });
    const video = join(media, 'shot.mp4');
    const music = join(media, 'bed.wav');
    const voice = join(media, 'voice.wav');
    const inputLut = join(media, 'camera-log.cube');
    const creativeLut = join(media, 'film-look.cube');
    const cube = 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';
    for (const path of [video, music, voice]) await writeFile(path, 'media-bytes');
    await writeFile(inputLut, cube);
    await writeFile(creativeLut, `${cube}# creative\n`);

    const project = fixture({
      clips: [{
        id: 'c0', path: video, kind: 'video', start: 0, duration: 1, sourceIn: 0, volume: 1, track: 0,
        inputLut, lut: creativeLut, grading: { exposure: 0.2 },
        windows: [{
          shape: 'circle', x: 0.25, y: 0.4, radius: 0.3, feather: 0.1, opacity: 0.7,
          grading: { saturation: 0.3 },
        }],
      }],
      musicPath: music,
      voicePath: voice,
      assets: [],
    });
    const output = join(directory, 'out');
    const result = await runExport({ project, outputDir: output, targets: ['lut', 'bundle'], settings: { lutSize: 5 } });

    const readme = await readFile(join(output, 'bundle', 'README.txt'), 'utf8');
    assert.match(readme, /独立/, 'README explains independent graded branches');
    assert.match(readme, /不要|错误做法/, 'README warns against chaining the base LUT into a window LUT');
    assert.match(readme, /混合|blend|maskedmerge/i, 'README explains blending each window back with the base');
    assert.doesNotMatch(readme, /参数化调色（lut\/clip-N-\*\.cube）→ 空间蒙版分区调色/,
      'the old serial order that double-grades is gone');
    assert.doesNotMatch(readme, /导入即生效|完整还原/, 'README does not claim verified commercial import');
    assert.match(readme, /未在真实/, 'README keeps the format-only validation boundary');
    assert.match(readme, /manifest\.json 的 color\.clips|color 字段/, 'README points at the machine-readable color map');

    const manifest = JSON.parse(await readFile(result.manifest, 'utf8'));
    assert.equal(manifest.formatValidation, 'format-only');
    assert.equal(manifest.verifiedInNle, false);
    assert.ok(manifest.color, 'manifest records the color handoff mapping');
    assert.equal(manifest.color.clips.length, 1);
    const entry = manifest.color.clips[0];
    assert.equal(entry.clipId, 'c0');
    assert.equal(entry.index, 0);
    assert.equal(entry.path, resolve(video));
    assert.deepEqual(entry.inputLut, { source: resolve(inputLut), exported: 'lut/input/clip-0-shot.cube' });
    assert.deepEqual(entry.creativeLut, { source: resolve(creativeLut), exported: 'lut/creative/clip-0-shot.cube' });
    assert.match(entry.baseLut, /^lut\/clip-0-shot\.cube$/);
    assert.equal(entry.windows.length, 1);
    const window = entry.windows[0];
    assert.deepEqual(window, {
      index: 0, shape: 'circle', x: 0.25, y: 0.4, radius: 0.3, feather: 0.1, opacity: 0.7,
      lut: 'lut/grade0w0.cube',
    }, 'window geometry, opacity and its LUT are all reconstructable from the manifest');
    assert.equal(manifest.capabilities.powerWindows.retained, 'grading-lut-and-geometry-in-manifest');
    assert.equal(manifest.capabilities.externalLut.branches, 'base-and-each-window-are-independent');
    assert.deepEqual(manifest.capabilities.externalLut.order, ['inputLut', 'lut']);
    assert.equal(manifest.capabilities.audioGain.premiereXml, 'audiolevels-linear-gain');
    assert.equal(manifest.capabilities.musicLoop.premiereXml, 'split-clipitems');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
