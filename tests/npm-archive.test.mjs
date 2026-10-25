import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import * as packaging from '../scripts/pack-npm-runtime.mjs';

function archive(entries) {
  const buffers = [];
  for (const { name, type, body = 'fixture' } of entries) {
    const data = Buffer.from(body);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12);
    header[156] = type.charCodeAt(0);
    buffers.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...buffers, Buffer.alloc(1024)]));
}

test('npm tar validation accepts PAX path metadata and counts only regular files', () => {
  assert.equal(typeof packaging.validateNpmArchive, 'function');
  assert.equal(packaging.validateNpmArchive(archive([
    { name: 'PaxHeader/preview.jpg', type: 'x', body: 'path=package/使用思路.jpg\n' },
    { name: 'package/preview.jpg', type: '0' },
  ]), 1), 1);
});

test('npm tar validation refuses links even when preceded by PAX metadata', () => {
  assert.equal(typeof packaging.validateNpmArchive, 'function');
  for (const type of ['1', '2', '3', '4', '6']) {
    assert.throws(() => packaging.validateNpmArchive(archive([
      { name: 'PaxHeader/source', type: 'x' }, { name: 'package/source', type },
    ]), 1), /non-regular/);
  }
});
