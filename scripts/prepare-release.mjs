import { releaseInputs } from './release-inputs.mjs';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildManifest, copyRelease } from './build-update-manifest.mjs';
import { isExcludedPath, listPackageFiles, verifyManifestSignature } from '../src/maintenance-updater.mjs';
import { RELEASE_PUBLIC_KEY } from '../src/maintenance-key.mjs';
import { VERSION } from '../src/version.mjs';
import { packNpmRuntime } from './pack-npm-runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
const { output, mediaPath: reusedMedia } = await releaseInputs({ root, version: VERSION, args: process.argv.slice(2) });
if (!process.env.npm_execpath) throw new Error('Run this script through npm run release:prepare');
const key = createPrivateKey(await readFile(join(root, '.eac/keys/release-private.pem')));
assert.equal(createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64'), RELEASE_PUBLIC_KEY, 'Release signing key must match the installed trust root');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(), '', 'Commit the release source before packaging');
await mkdir(output, { recursive: true });
const packageRoot = join(output, 'package');
copyRelease(root, packageRoot);
const files = listPackageFiles(packageRoot);
assert.ok(files.includes('dist/index.html') && files.includes('src/template-preview-bridge.mjs'));
assert.equal(files.filter(path => /^vendor\/video-shotcraft\/media\/.*\.mp4$/.test(path)).length, 150);
for (const path of files) {
  assert.equal(isExcludedPath(path), false, path);
  assert.ok(!/(?:^|\/)(?:\.npmrc|\.env(?:\..*)?|[^/]*private[^/]*\.pem)$/.test(path), `Private file: ${path}`);
}
const notes = `v${VERSION}: ink-blue glass design system, motion polish and library card layout fix`;
const update = join(output, 'update');
const channel = join(output, 'channel');
await mkdir(update);
copyRelease(packageRoot, join(update, 'files'));
copyRelease(packageRoot, channel);
const local = buildManifest({ root: packageRoot, version: VERSION, base: './files/', notes, privateKey: key, minSupported: '0.3.0' });
const remote = buildManifest({ root: channel, version: VERSION, base: '../', notes, privateKey: key, minSupported: '0.3.0' });
assert.equal(verifyManifestSignature(local.manifest, RELEASE_PUBLIC_KEY), true);
assert.equal(verifyManifestSignature(remote.manifest, RELEASE_PUBLIC_KEY), true);
await writeFile(join(update, 'manifest.json'), `${JSON.stringify(local.manifest, null, 2)}\n`);
await writeFile(join(channel, 'feed/manifest.json'), `${JSON.stringify(remote.manifest, null, 2)}\n`);
await writeFile(join(channel, '.gitattributes'), '* -text\n');
const zipScript = [
  'import pathlib,sys,zipfile',
  'root=pathlib.Path(sys.argv[1]); target=pathlib.Path(sys.argv[2]); prefix=sys.argv[3]',
  'with zipfile.ZipFile(target,"x",zipfile.ZIP_DEFLATED,compresslevel=6,allowZip64=True) as archive:',
  ' for file in sorted(root.rglob("*")):',
  '  if file.is_file(): archive.write(file,prefix+file.relative_to(root).as_posix())',
].join('\n');
function archive(directory, name, prefix) {
  execFileSync('python', ['-c', zipScript, directory, join(output, name), prefix], { windowsHide: true, timeout: 600000, stdio: 'inherit' });
}
archive(packageRoot, `eac-design-world-v${VERSION}-plugin.zip`, 'eac-design-world/');
archive(update, `eac-design-world-v${VERSION}-update.zip`, '');
// Media is validated before creating output; its cache is separate from release artifacts.
await cp(reusedMedia, join(output, `eac-design-world-v${VERSION}-media.zip`));
await cp(join(root, `docs/release-v${VERSION}.md`), join(output, 'RELEASE_NOTES.md'));
const npmOutput = join(output, 'npm');
const npmPackage = await packNpmRuntime({ source: packageRoot, output: npmOutput, npmCli: process.env.npm_execpath });
await cp(join(npmOutput, npmPackage.filename), join(output, npmPackage.filename));
assert.equal(npmPackage.name, 'eac-design-world');
assert.equal(npmPackage.version, VERSION);
const packed = new Set(npmPackage.files.map(item => item.path));
for (const path of ['plugin/host.mjs', 'plugin/client.js', 'src/server.mjs', 'dist/index.html', 'vendor/video-shotcraft/catalog.json', 'vendor/video-shotcraft/LICENSE']) assert.ok(packed.has(path), `Missing npm runtime file: ${path}`);
assert.equal([...packed].filter(path => /^vendor\/video-shotcraft\/media\/.*\.mp4$/.test(path)).length, 150);
for (const path of packed) assert.equal(isExcludedPath(path), false, `Excluded npm file: ${path}`);
const assets = [];
for (const name of [`eac-design-world-v${VERSION}-plugin.zip`, `eac-design-world-v${VERSION}-media.zip`, `eac-design-world-v${VERSION}-update.zip`, npmPackage.filename]) {
  assets.push({ file: name, bytes: (await stat(join(output, name))).size, sha256: await sha256File(join(output, name)) });
}
await writeFile(join(output, 'release-manifest.json'), `${JSON.stringify({
  version: VERSION, sourceCommit: commit, assets,
  verification: { status: 'pending', note: 'Run tests and package verification before publication.' },
  update: { signed: local.signed, algorithm: 'Ed25519', files: local.files, bytes: local.bytes },
  npm: { name: npmPackage.name, version: npmPackage.version, filename: npmPackage.filename, integrity: npmPackage.integrity, shasum: npmPackage.shasum, files: npmPackage.entryCount, deduplication: npmPackage.deduplication },
  media: { reusedFrom: 'v0.3.0', sha256: assets[1].sha256 },
}, null, 2)}\n`);
await writeFile(join(output, 'SHA256SUMS.txt'), assets.map(item => `${item.sha256}  ${item.file}\n`).join('')
  + `${await sha256File(join(output, 'release-manifest.json'))}  release-manifest.json\n`);
console.log(JSON.stringify({ output, sourceCommit: commit, assets, signed: local.signed, files: local.files }, null, 2));
