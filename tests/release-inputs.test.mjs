import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { releaseInputs } from '../scripts/release-inputs.mjs';

test('release defaults keep media outside output and preflight failures create no partial package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eac-release-input-'));
  const input = { root, version: '0.5.0', env: {}, expectedHash: createHash('sha256').update('fixture').digest('hex') };
  try {
    const media = join(root, 'release/media-cache/eac-design-world-v0.3.0-media.zip');
    const output = join(root, 'release/publish-v0.5.0');
    await assert.rejects(releaseInputs(input), /Media archive not found/);
    assert.equal(existsSync(output), false);
    await mkdir(join(root, 'release/media-cache'), { recursive: true });
    await writeFile(media, 'fixture');
    assert.deepEqual(await releaseInputs(input), { output, mediaPath: await realpath(media) });
    const selected = await releaseInputs({ ...input, args: ['--media', media, '--output', join(root, 'release/custom')] });
    assert.equal(selected.output, join(root, 'release/custom'));
    await writeFile(media, 'tampered');
    await assert.rejects(releaseInputs(input), /must match/);
    assert.equal(existsSync(output), false);
    await mkdir(output);
    await assert.rejects(releaseInputs(input), /Refusing to overwrite/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
