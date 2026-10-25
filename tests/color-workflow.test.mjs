import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  MAX_CUBE_BYTES, gradeSignature, parseCubeLut, restoreGradeVersion, saveGradeVersion,
  suggestShotMatch, validateCubeFile,
} from '../src/color-workflow.mjs';

const IDENTITY = 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';

async function withTemp(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'eac-color-'));
  try { return await fn(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function project(overrides = {}) {
  return {
    id: 'p1', title: 'Color', revision: 3, width: 1920, height: 1080, fps: 30,
    look: { preset: 'teal-orange' },
    captions: [{ start: 0, end: 1, text: 'keep' }],
    gradeVersions: [],
    clips: [
      {
        id: 'c1', path: 'a.mp4', kind: 'video', start: 0, sourceIn: 0, duration: 2, volume: 1, track: 0,
        grading: { exposure: 0.2 }, inputLut: 'C:/luts/camera.cube', lut: null,
        windows: [{ shape: 'circle', x: 0.5, y: 0.5, grading: { exposure: 0.1 } }],
      },
      { id: 'c2', path: 'b.mp4', kind: 'video', start: 2, sourceIn: 0, duration: 3, volume: 1, track: 0 },
    ],
    ...overrides,
  };
}

test('validateCubeFile parses a real 3D LUT file and returns its canonical path', () => withTemp(async (directory) => {
  const path = join(directory, 'my camera look.cube');
  await writeFile(path, `# generated\nTITLE Camera to Rec.709\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n${IDENTITY}`);
  const metadata = await validateCubeFile(path);
  assert.equal(metadata.path, await realpath(path));
  assert.equal(metadata.title, 'Camera to Rec.709');
  assert.equal(metadata.size, 2);
  assert.equal(metadata.entryCount, 8);
  assert.deepEqual(metadata.domainMin, [0, 0, 0]);
  assert.deepEqual(metadata.domainMax, [1, 1, 1]);
  assert.equal(metadata.bytes, (await readFile(path)).length);
  const parsed = parseCubeLut(await readFile(path, 'utf8'));
  assert.equal(parsed.data.length, 24);
  assert.deepEqual([...parsed.data.slice(0, 3)], [0, 0, 0]);
  assert.deepEqual([...parsed.data.slice(3, 6)], [1, 0, 0], 'red index varies fastest');
  assert.deepEqual([...parsed.data.slice(-3)], [1, 1, 1]);
}));

test('validateCubeFile rejects missing, non-cube, oversized and malformed files', () => withTemp(async (directory) => {
  await assert.rejects(validateCubeFile(join(directory, 'missing.cube')), /ENOENT|不存在/i);
  await assert.rejects(validateCubeFile(directory), /cube|文件|目录/i);
  const text = join(directory, 'look.txt');
  await writeFile(text, IDENTITY);
  await assert.rejects(validateCubeFile(text), /cube/i);
  const huge = join(directory, 'huge.cube');
  const handle = await open(huge, 'w');
  await handle.truncate(MAX_CUBE_BYTES + 1);
  await handle.close();
  await assert.rejects(validateCubeFile(huge), /大|大小|限制/);
  for (const bad of [
    '', 'LUT_3D_SIZE 2\n', 'LUT_1D_SIZE 2\n0 0 0\n',
    'LUT_3D_SIZE 1\n0 0 0\n', 'LUT_3D_SIZE 66\n', 'LUT_3D_SIZE 2.5\n', 'LUT_3D_SIZE\n',
    'LUT_3D_SIZE 2\nLUT_3D_SIZE 2\n0 0 0\n',
    `LUT_3D_SIZE 2\n${'0 0 0\n'.repeat(7)}`,
    `LUT_3D_SIZE 2\n${'0 0 0\n'.repeat(9)}`,
    'LUT_3D_SIZE 2\nnan 0 0\n', 'LUT_3D_SIZE 2\nInfinity 0 0\n',
    'LUT_3D_SIZE 2\n0 0\n', 'LUT_3D_SIZE 2\n0 0 0 0\n',
    'LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\n0 0 0\nTITLE late\n',
    'LUT_3D_SIZE 2\nDOMAIN_MIN 1 0 0\nDOMAIN_MAX 0 1 1\n',
    'LUT_3D_SIZE 2\nDOMAIN_MIN 0 0\n',
    'LUT_3D_SIZE 2\nSOMETHING 1\n',
  ]) {
    const path = join(directory, 'bad.cube');
    await writeFile(path, bad);
    await assert.rejects(validateCubeFile(path), /LUT|cube|尺寸|数据|DOMAIN|TITLE|字段|有限|3D/i, JSON.stringify(bad));
  }
  await assert.rejects(validateCubeFile(42), TypeError);
}));

test('parseCubeLut rejects values that are not finite in double or 32-bit float', () => {
  const rows = (first) => `LUT_3D_SIZE 2\n${first}\n${'0 0 0\n'.repeat(7)}`;
  for (const bad of ['1e999 0 0', '-1e999 0 0', '1e39 0 0', '0 1e39 0', '3.5e38 0 0']) {
    assert.throws(() => parseCubeLut(rows(bad)), /有限|范围|浮点/, bad);
  }
  assert.ok(Number.isFinite(parseCubeLut(rows('1e38 0 0')).data[0]), '1e38 is representable as float32');
});

test('saveGradeVersion stores looks, clip gradings, LUTs and windows without mutating input', () => {
  const base = project();
  const snapshot = structuredClone(base);
  const saved = saveGradeVersion(base, { name: '  Balanced  ' });
  assert.notEqual(saved, base);
  assert.deepEqual(base, snapshot, 'input project is untouched');
  assert.equal(saved.revision, base.revision, 'caller bumps the revision when persisting');
  assert.equal(saved.gradeVersions.length, 1);
  const version = saved.gradeVersions[0];
  assert.match(version.id, /^[0-9a-f-]{36}$/);
  assert.equal(version.name, 'Balanced');
  assert.equal(version.description, null);
  assert.ok(version.createdAt);
  assert.deepEqual(version.look, { preset: 'teal-orange' });
  assert.deepEqual(version.clipIds, ['c1', 'c2']);
  assert.deepEqual(version.clips[0], {
    clipId: 'c1', grading: { exposure: 0.2 }, inputLut: 'C:/luts/camera.cube', lut: null,
    windows: [{ shape: 'circle', x: 0.5, y: 0.5, grading: { exposure: 0.1 } }],
  });
  assert.deepEqual(version.clips[1], { clipId: 'c2', grading: null, inputLut: null, lut: null, windows: null });
  const twice = saveGradeVersion(saved, { name: 'Warm', description: 'sunset' });
  assert.equal(twice.gradeVersions.length, 2);
  assert.equal(twice.gradeVersions[0].id, version.id);
  assert.equal(twice.gradeVersions[1].description, 'sunset');
});

test('saveGradeVersion validates names, descriptions, clip ids and the version cap', () => {
  for (const bad of [undefined, '', '   ', 5, 'x'.repeat(81)]) {
    assert.throws(() => saveGradeVersion(project(), { name: bad }), TypeError);
  }
  assert.throws(() => saveGradeVersion(project(), { name: 'ok', description: 'y'.repeat(281) }), TypeError);
  assert.throws(() => saveGradeVersion(project({ clips: [{ path: 'a.mp4', kind: 'video' }] }), { name: 'ok' }), /片段.*id/i);
  assert.throws(() => saveGradeVersion(project({ gradeVersions: Array.from({ length: 50 }, () => ({})) }), { name: 'ok' }), /版本/);
  assert.throws(() => saveGradeVersion(null, { name: 'ok' }), TypeError);
});

test('restoreGradeVersion restores only color and preserves the new edit', () => {
  const saved = saveGradeVersion(project(), { name: 'Balanced' });
  const versionId = saved.gradeVersions[0].id;
  const edited = structuredClone(saved);
  edited.revision = 9;
  edited.look = { exposure: -0.4 };
  edited.captions = [{ start: 0, end: 2, text: 'new edit' }];
  edited.clips[0] = {
    ...edited.clips[0], duration: 0.75, start: 0.4, grading: null, inputLut: null, windows: null,
  };
  const snapshot = structuredClone(edited);
  const restored = restoreGradeVersion(edited, { versionId });
  assert.deepEqual(edited, snapshot, 'input project is untouched');
  assert.deepEqual(restoreGradeVersion(edited, versionId), restored, 'a bare version id is accepted too');
  assert.deepEqual(restored.look, { preset: 'teal-orange' });
  assert.deepEqual(restored.clips[0].grading, { exposure: 0.2 });
  assert.equal(restored.clips[0].inputLut, 'C:/luts/camera.cube');
  assert.deepEqual(restored.clips[0].windows, [{ shape: 'circle', x: 0.5, y: 0.5, grading: { exposure: 0.1 } }]);
  assert.equal(restored.clips[0].duration, 0.75, 'cuts are preserved');
  assert.equal(restored.clips[0].start, 0.4);
  assert.deepEqual(restored.captions, [{ start: 0, end: 2, text: 'new edit' }]);
  assert.equal(restored.revision, 9);
  assert.equal(restored.gradeVersions.length, 1);
  assert.equal(restored.clips[1].grading, undefined);
});

test('restoreGradeVersion clears color fields recorded as absent and maps reordered clips by id', () => {
  const saved = saveGradeVersion(project(), { name: 'Clean' });
  const edited = structuredClone(saved);
  edited.clips = [edited.clips[1], { ...edited.clips[0], grading: { exposure: 1 }, inputLut: 'other.cube', windows: [] }];
  const restored = restoreGradeVersion(edited, saved.gradeVersions[0].id);
  assert.equal(restored.clips[0].id, 'c2');
  assert.equal(restored.clips[1].id, 'c1');
  assert.deepEqual(restored.clips[1].grading, { exposure: 0.2 });
  assert.equal(restored.clips[1].inputLut, 'C:/luts/camera.cube');
  assert.equal(restored.clips[0].inputLut, undefined);
  assert.equal(restored.clips[0].windows, undefined);
});

test('restoreGradeVersion fails without partial changes on unknown ids or changed clip sets', () => {
  const saved = saveGradeVersion(project(), { name: 'Balanced' });
  const versionId = saved.gradeVersions[0].id;
  assert.throws(() => restoreGradeVersion(saved, 'missing-id'), /版本/);
  assert.throws(() => restoreGradeVersion(saved, { versionId: 'missing-id' }), /版本/);
  assert.throws(() => restoreGradeVersion(saved, 42), TypeError);
  for (const clips of [
    [...saved.clips, { id: 'c3', path: 'c.mp4', kind: 'video', start: 5, duration: 1 }],
    [saved.clips[0]],
  ]) {
    const edited = { ...saved, clips, gradeVersions: saved.gradeVersions };
    const snapshot = structuredClone(edited);
    assert.throws(() => restoreGradeVersion(edited, versionId), /片段/);
    assert.deepEqual(edited, snapshot);
  }
});

function frame(clipId, clipIndex, lumaAvg, extra = {}) {
  const stats = {
    lumaMin: 0, lumaMax: 255, lumaAvg, saturationAvg: 0.2, highlightClip: 0, shadowCrush: 0, ...extra,
  };
  return { clipId, clipIndex, sourceTime: 0, original: stats, graded: { ...stats } };
}

test('suggestShotMatch recommends a bounded exposure delta from measured graded luma only', () => {
  const preview = { frames: [frame('c1', 0, 120), frame('c2', 1, 60), frame('c3', 2, 115)] };
  const bounded = suggestShotMatch(preview, { referenceClipId: 'c1', maxExposure: 0.5 });
  assert.equal(bounded.method, 'measured-graded-luma');
  assert.equal(bounded.bounded, true);
  assert.equal(bounded.referenceClipId, 'c1');
  assert.equal(bounded.reference.lumaAvg, 120);
  assert.equal(bounded.recommendations.length, 1);
  const recommendation = bounded.recommendations[0];
  assert.equal(recommendation.clipId, 'c3');
  assert.equal(recommendation.clipIndex, 2);
  assert.equal(recommendation.exposureDelta, 0.1);
  assert.equal(recommendation.exposure, 0.1, 'exposure is a deprecated alias of exposureDelta');
  assert.equal(recommendation.measuredLuma, 115);
  assert.equal(recommendation.referenceLuma, 120);
  assert.equal(recommendation.sampleCount, 1);
  assert.match(recommendation.reason, /曝光/);
  assert.match(recommendation.reason, /相对当前/, 'the delta is relative to the current grade');
  const flagged = bounded.needsReview.find((item) => item.clipId === 'c2');
  assert.ok(flagged, 'a one-stop correction is outside the safe bound');
  assert.match(flagged.reason, /超出/);
  assert.equal(flagged.neededExposure, 1);
  assert.match(bounded.disclaimer, /不代表|不构成/);
  assert.match(bounded.disclaimer, /粗|近似|不.*精确/);

  const wider = suggestShotMatch(preview, { referenceClipId: 'c1', maxExposure: 1.5 });
  assert.equal(wider.recommendations.find((item) => item.clipId === 'c2').exposureDelta, 1);
  assert.equal(wider.needsReview.length, 0);
});

test('suggestShotMatch measures the current graded appearance and skips matched shots', () => {
  const graded = frame('c2', 1, 60);
  graded.original = { ...graded.original, lumaAvg: 120 };
  const preview = { frames: [frame('c1', 0, 120), graded, frame('c3', 2, 121)] };
  const result = suggestShotMatch(preview, { referenceClipId: 'c1', maxExposure: 1.5 });
  assert.deepEqual(result.recommendations.map((item) => item.clipId), ['c2']);
  assert.equal(result.recommendations[0].exposureDelta, 1,
    'the graded frame (60) is compared with the reference, not its original (120)');
  const same = suggestShotMatch({ frames: [frame('c1', 0, 120), frame('c2', 1, 121)] }, { referenceClipId: 'c1' });
  assert.equal(same.recommendations.length, 0, 'a sub-0.05-stop difference is already matched');
  const originalOnly = {
    frames: [
      { clipId: 'c1', clipIndex: 0, original: { lumaAvg: 120 } },
      { clipId: 'c2', clipIndex: 1, original: { lumaAvg: 60 } },
    ],
  };
  assert.throws(() => suggestShotMatch(originalOnly, { referenceClipId: 'c1' }), /graded|调色后/,
    'original-only stats cannot prove the current look');
});

test('suggestShotMatch flags a clip when any sampled frame clips or crushes', () => {
  const preview = {
    frames: [
      frame('c1', 0, 120),
      frame('c2', 1, 120, { highlightClip: 0.3 }),
      frame('c2', 1, 120, { highlightClip: 0 }),
      frame('c3', 2, 118),
      frame('c3', 2, 118, { shadowCrush: 0.25 }),
    ],
  };
  const result = suggestShotMatch(preview, { referenceClipId: 'c1' });
  assert.equal(result.recommendations.length, 0);
  const reasons = Object.fromEntries(result.needsReview.map((item) => [item.clipId, item.reason]));
  assert.match(reasons.c2, /裁切/);
  assert.match(reasons.c3, /死黑|暗部/);
});

test('suggestShotMatch rejects non-finite or out-of-range preview statistics', () => {
  for (const graded of [
    { lumaAvg: 120, highlightClip: NaN },
    { lumaAvg: 120, shadowCrush: 1.5 },
    { lumaAvg: 120, highlightClip: '0.1' },
    { lumaAvg: 120, shadowCrush: Infinity },
    { lumaAvg: 300 },
    { lumaAvg: -5 },
  ]) {
    const preview = {
      frames: [
        { clipId: 'c1', clipIndex: 0, graded },
        { clipId: 'c2', clipIndex: 1, graded: { lumaAvg: 120 } },
      ],
    };
    assert.throws(() => suggestShotMatch(preview, { referenceClipId: 'c1' }), TypeError, JSON.stringify(graded));
  }
});

test('suggestShotMatch routes black, white, clipped, crushed and unstable samples to review', () => {
  const preview = {
    frames: [
      frame('c1', 0, 120),
      frame('black', 1, 8),
      frame('white', 2, 245),
      frame('clipped', 3, 120, { highlightClip: 0.3 }),
      frame('crushed', 4, 60, { shadowCrush: 0.4 }),
      frame('unstable', 5, 40), frame('unstable', 5, 100),
    ],
  };
  const result = suggestShotMatch(preview, { referenceClipId: 'c1', maxExposure: 1 });
  assert.equal(result.recommendations.length, 0);
  const reasons = Object.fromEntries(result.needsReview.map((item) => [item.clipId, item.reason]));
  assert.match(reasons.black, /黑/);
  assert.match(reasons.white, /白/);
  assert.match(reasons.clipped, /裁切/);
  assert.match(reasons.crushed, /死黑|暗部/);
  assert.match(reasons.unstable, /不稳定/);
});

test('suggestShotMatch rejects unusable previews and invalid references', () => {
  assert.throws(() => suggestShotMatch(null, { referenceClipId: 'c1' }), /预览/);
  assert.throws(() => suggestShotMatch({ frames: [] }, { referenceClipId: 'c1' }), /预览/);
  assert.throws(() => suggestShotMatch({ frames: [frame('c1', 0, 120)] }), TypeError);
  assert.throws(() => suggestShotMatch({ frames: [frame('c1', 0, 120)] }, { referenceClipId: 'c9' }), /参考/);
  assert.throws(() => suggestShotMatch({ frames: [frame('c1', 0, 120)] }, { referenceClipId: 'c1', maxExposure: 0 }), TypeError);
  assert.throws(() => suggestShotMatch({ frames: [frame('c1', 0, 120)] }, { referenceClipId: 'c1', maxExposure: 3 }), TypeError);
  assert.throws(() => suggestShotMatch({ frames: [frame('c1', 0, 5), frame('c2', 1, 120)] }, { referenceClipId: 'c1' }), /参考.*可靠|黑/);
  const byIndex = suggestShotMatch(
    { frames: [{ clipIndex: 0, graded: frame(null, 0, 120).graded }, { clipIndex: 1, graded: frame(null, 1, 60).graded }] },
    { referenceClipIndex: 0, maxExposure: 1.5 },
  );
  assert.equal(byIndex.referenceClipId, null);
  assert.equal(byIndex.recommendations[0].clipIndex, 1);
  assert.equal(byIndex.recommendations[0].exposure, 1);
});

test('gradeSignature is stable across key order and sensitive only to color state', () => {
  const base = project({ look: { preset: 'teal-orange', temperature: -0.1 } });
  const reordered = {
    ...base,
    look: { temperature: -0.1, preset: 'teal-orange' },
    clips: base.clips.map((clip) => (clip.grading
      ? { ...clip, grading: { exposure: 0.2 }, windows: [{ y: 0.5, shape: 'circle', grading: { exposure: 0.1 }, x: 0.5 }] }
      : clip)),
  };
  const signature = gradeSignature(base);
  assert.match(signature, /^[0-9a-f]{64}$/);
  assert.equal(gradeSignature(reordered), signature, 'object key order is irrelevant');
  const unrelated = { ...base, title: 'Renamed', revision: 99, captions: [], updatedAt: '2026-01-01' };
  assert.equal(gradeSignature(unrelated), signature, 'edits and metadata are ignored');
  for (const changed of [
    { ...base, look: { exposure: 0.3 } },
    { ...base, clips: [{ ...base.clips[0], grading: { exposure: 0.25 } }, base.clips[1]] },
    { ...base, clips: [{ ...base.clips[0], inputLut: 'C:/luts/other.cube' }, base.clips[1]] },
    { ...base, clips: [{ ...base.clips[0], windows: [] }, base.clips[1]] },
    { ...base, clips: [{ ...base.clips[0], id: 'c9' }, base.clips[1]] },
  ]) {
    assert.notEqual(gradeSignature(changed), signature);
  }
});
