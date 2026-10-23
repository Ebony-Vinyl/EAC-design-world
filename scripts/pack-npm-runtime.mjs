import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { isExcludedPath } from '../src/maintenance-updater.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bootstrap = 'src/npm-assets-restore.mjs';
const image = /\.(?:png|jpe?g|webp|avif|gif|svg|mp4|webm|woff2?|ttf|otf)$/i;
const safe = (root, file) => {
  const path = relative(root, file);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
};

export async function packNpmRuntime({ source, output, npmCli = process.env.npm_execpath } = {}) {
  assert.ok(npmCli, 'Provide npmCli or run through npm');
  source = resolve(source);
  output = resolve(output);
  if (existsSync(output)) throw new Error(`Refusing to overwrite ${output}`);
  const npmRequire = createRequire(npmCli);
  const Arborist = npmRequire('@npmcli/arborist');
  const packlist = npmRequire('npm-packlist');
  const tree = await new Arborist({ path: source }).loadActual();
  const files = (await packlist(tree, { path: source })).sort();
  assert.ok(files.includes('src/catalog.mjs') && files.includes('dist/index.html'));
  for (const file of files) {
    assert.ok(safe(source, resolve(source, file)), file);
    assert.equal(isExcludedPath(file), false, `Excluded source file: ${file}`);
  }
  const stage = join(output, 'package');
  await mkdir(stage, { recursive: true });
  // Stage real copies, never hard links: npm's tar writer treats nlink>1 files
  // as hard-link candidates keyed by dev:ino, and libuv's Windows ino is a
  // collision-prone file-id hash — a collision would silently replace one
  // staged file's content with another's inside the tarball.
  for (const file of files) {
    const target = join(stage, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(source, file), target);
  }
  await copyFile(join(ROOT, bootstrap), join(stage, bootstrap));
  const catalog = await readFile(join(stage, 'src/catalog.mjs'), 'utf8');
  if (!catalog.includes("import './npm-assets-restore.mjs';")) {
    await writeFile(join(stage, 'src/catalog.mjs'), "import './npm-assets-restore.mjs';\n" + catalog);
  }
  const manifest = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'));
  const postinstall = 'node src/npm-assets-restore.mjs';
  if (manifest.scripts?.postinstall && manifest.scripts.postinstall !== postinstall) {
    throw new Error('Cannot replace an existing postinstall script');
  }
  manifest.scripts = { ...manifest.scripts, postinstall };
  manifest.files = [...new Set([...(manifest.files || []), 'npm-asset-map.json'])];
  if (manifest.scripts.build && !manifest.scripts.build.startsWith(postinstall)) {
    manifest.scripts.build = `${postinstall} && ${manifest.scripts.build}`;
  }
  await writeFile(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const bySize = new Map();
  for (const file of files.filter(file => file.startsWith('vendor/') && image.test(file)
    && !file.startsWith('vendor/video-shotcraft/media/'))) {
    const size = (await stat(join(source, file))).size;
    if (size < 1024) continue;
    const group = bySize.get(size) || [];
    group.push(file);
    bySize.set(size, group);
  }
  const assets = [];
  let savedBytes = 0;
  for (const [size, group] of bySize) {
    if (group.length < 2) continue;
    const hashes = new Map();
    for (const file of group) {
      const sha256 = createHash('sha256').update(await readFile(join(source, file))).digest('hex');
      const from = hashes.get(sha256);
      if (!from) { hashes.set(sha256, file); continue; }
      const target = resolve(stage, file);
      assert.ok(safe(stage, target));
      await unlink(target);
      assets.push({ from, to: file, sha256 });
      savedBytes += size;
    }
  }
  assets.sort((a, b) => a.to.localeCompare(b.to, 'en'));
  assert.ok(assets.every(asset => asset.from.startsWith('vendor/') && asset.to.startsWith('vendor/')));
  await writeFile(join(stage, 'npm-asset-map.json'), JSON.stringify({ version: 1, packageVersion: manifest.version, assets }, null, 2) + '\n');
  const [packed] = JSON.parse(execFileSync(process.execPath, [
    npmCli, 'pack', stage, '--pack-destination', output, '--json', '--ignore-scripts',
  ], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 600000, maxBuffer: 16 * 1024 * 1024 }));
  assert.ok(packed.size < 190 * 1024 * 1024, 'npm archive exceeds the 190 MiB publication budget');
  const packaged = new Set(packed.files.map(file => file.path));
  assert.ok(packaged.has(bootstrap) && packaged.has('npm-asset-map.json'));
  for (const file of files) {
    assert.ok(packaged.has(file) || assets.some(asset => asset.to === file), `Lost package file: ${file}`);
  }
  assert.equal(packed.files.filter(file => /^vendor\/video-shotcraft\/media\/.*\.mp4$/.test(file.path)).length, 150);
  for (const file of packed.files) assert.equal(isExcludedPath(file.path), false, file.path);
  // A tarball entry that is not a regular file (hard link, symlink, device…)
  // would either be rejected by the registry or silently alias another file's
  // content on install, so refuse to ship one.
  {
    const bytes = await readFile(join(output, packed.filename));
    const tar = gunzipSync(bytes);
    let offset = 0, entries = 0;
    while (offset + 512 <= tar.length) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every(byte => byte === 0)) break;
      const type = String.fromCharCode(header[156]);
      const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
      assert.ok(type === '0' || type === '\0', `npm archive entry "${name}" has non-regular type "${type.trim()}"`);
      const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim();
      const size = sizeField === '' ? 0 : parseInt(sizeField, 8);
      assert.ok(Number.isInteger(size) && size >= 0, `npm archive entry "${name}" has an unreadable size`);
      offset += 512 + Math.ceil(size / 512) * 512;
      entries += 1;
    }
    assert.equal(entries, packed.entryCount, 'npm archive entry count disagrees with the pack report');
  }
  const result = { ...packed, deduplication: { assets: assets.length, savedBytes, originalFiles: files.length, restoredFiles: files.length + (files.includes(bootstrap) ? 1 : 2) } };
  await writeFile(join(output, 'npm-package.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ filename: packed.filename, bytes: packed.size, files: packed.entryCount, deduplicatedAssets: assets.length, savedBytes }));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    source: { type: 'string' }, output: { type: 'string' }, 'npm-cli': { type: 'string' },
  } });
  await packNpmRuntime({ source: values.source, output: values.output, npmCli: values['npm-cli'] || process.env.npm_execpath });
}
