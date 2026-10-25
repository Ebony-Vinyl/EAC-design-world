/**
 * Tests for the ported maintenance updater (`src/maintenance-updater.mjs`) and
 * the manifest builder (`scripts/build-update-manifest.mjs`).
 *
 * Ported from the upstream MIT project's updater tests
 * (`Ebony-Vinyl/dsh-our-free-model`, commit 0b712bcbb887ae101cae5fdf935b0845761a1421),
 * adapted to this repository's caps, protected-prefix rules and no-default-key
 * policy. Every test injects a throwaway Ed25519 keypair so remote behaviour can
 * be exercised without a production signing key.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import crypto from 'node:crypto'
import {
  parseVersion, compareVersions, parseManifest, stableStringify,
  signManifest, verifyManifestSignature, isProtectedPath, isOptionalMediaPath, isExcludedPath,
  listPackageFiles, verifyPackageIdentity, PACKAGE_IDENTITY,
  backupPackage, restoreBackup, installStaged, verifyStaged, verifyInstalled,
  stageRelease, MaintenanceUpdater, PINNED_MANIFEST_PUBLIC_KEY, NO_SIGNING_KEY_ERROR,
  LICENSE_EXCLUDED_PATHS, LICENSE_EXCLUDED_PREFIXES,
} from '../src/maintenance-updater.mjs'
import { buildManifest, copyRelease } from '../scripts/build-update-manifest.mjs'

/** A throwaway Ed25519 keypair (SPKI base64 public, PKCS8 PEM private). */
function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

/** A minimal fake fetch that serves a manifest + file map keyed by URL suffix. */
function fakeFetch(routes, { status = {} } = {}) {
  return async url => {
    const href = String(url)
    for (const [suffix, body] of Object.entries(routes)) {
      if (href.endsWith(suffix) || href.includes(suffix)) {
        const code = status[suffix] ?? 200
        return {
          ok: code >= 200 && code < 300,
          status: code,
          headers: { get: () => null },
          text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
          arrayBuffer: async () => Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
          body: null,
        }
      }
    }
    return { ok: false, status: 404, headers: { get: () => null }, text: async () => '', arrayBuffer: async () => Buffer.alloc(0), body: null }
  }
}

/**
 * Create a small installable package directory. By default it carries the
 * minimum EAC runtime identity (`PACKAGE_IDENTITY`) so identity verification
 * passes; pass `identity: false` to omit it for negative tests.
 */
async function makePackage(dir, { version = '1.0.0', files = {}, identity = true, name = 'eac-design-world', main = './plugin/host.mjs' } = {}) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), `${JSON.stringify({ name, version, main }, null, 2)}\n`)
  const merged = identity ? {
    'index.js': 'export const version = "1.0.0"\n',
    'plugin/host.mjs': 'export const name = "eac-design-world"\n',
    'src/server.mjs': 'export const startServer = () => {}\n',
    'src/version.mjs': `export const VERSION = '${version}'\n`,
    'dist/index.html': '<!doctype html><title>EAC</title>\n',
    ...files,
  } : files
  for (const [rel, content] of Object.entries(merged)) {
    const target = join(dir, ...rel.split('/'))
    await mkdir(resolve(target, '..'), { recursive: true })
    await writeFile(target, content)
  }
  return dir
}

/** Build a manifest for a package and write it into <dir>/feed/manifest.json. */
async function writeManifest(dir, options) {
  const built = buildManifest({ root: dir, ...options })
  await mkdir(join(dir, 'feed'), { recursive: true })
  await writeFile(join(dir, 'feed', 'manifest.json'), JSON.stringify(built.manifest, null, 2))
  return built
}

async function withTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'eac-maintenance-'))
  try { return await fn(dir) }
  finally { await rm(dir, { recursive: true, force: true }) }
}

test('version parsing and comparison follow semver precedence', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, pre: null })
  assert.equal(parseVersion('nope'), null)
  assert.equal(compareVersions('1.2.3', '1.2.4'), -1)
  assert.equal(compareVersions('1.2.3-rc.1', '1.2.3'), -1)
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1)
})

test('stableStringify sorts keys and drops undefined', () => {
  assert.equal(stableStringify({ b: 1, a: 2, c: undefined }), '{"a":2,"b":1}')
  assert.equal(stableStringify([1, undefined, 2]), '[1,null,2]')
})

test('manifest signing round-trips and rejects a tampered payload', () => {
  const { publicKey, privateKey } = keypair()
  const payload = { version: '1.0.0', base: '../', publishedAt: '2026-01-01T00:00:00.000Z', notes: '', files: [{ path: 'package.json', size: 1, sha256: 'a'.repeat(64) }] }
  const signature = signManifest(payload, privateKey)
  assert.equal(verifyManifestSignature({ ...payload, signature }, publicKey), true)
  // Changing a signed field invalidates the signature.
  assert.equal(verifyManifestSignature({ ...payload, notes: 'changed', signature }, publicKey), false)
  // A malformed key or signature answers false, never throws.
  assert.equal(verifyManifestSignature({ ...payload, signature }, 'not-a-key'), false)
  assert.equal(verifyManifestSignature(payload, publicKey), false)
})

test('parseManifest refuses unsafe, protected and oversized entries', () => {
  const entry = (p, size = 10) => ({ path: p, size, sha256: 'a'.repeat(64) })
  const base = { version: '1.0.0', files: [entry('package.json'), entry('index.js')] }
  assert.equal(parseManifest(base).version, '1.0.0')
  assert.throws(() => parseManifest({ ...base, base: 'https://evil.example/' }), /relative/)
  assert.throws(() => parseManifest({ ...base, files: [entry('../escape')] }), /safe relative/)
  assert.throws(() => parseManifest({ ...base, files: [entry('C:/abs')] }), /safe relative/)
  // Excluded (protected and optional-media) paths may never be part of a release.
  assert.throws(() => parseManifest({ ...base, files: [entry('vendor/motion-web/x.bin')] }), /excluded local\/media path/)
  assert.throws(() => parseManifest({ ...base, files: [entry('node_modules/x')] }), /excluded local\/media path/)
  assert.throws(() => parseManifest({ ...base, files: [entry('public/media/v.mp4')] }), /excluded local\/media path/)
  assert.throws(() => parseManifest({ ...base, files: [entry('vendor/mg-styles-15/assets/fonts/x.ttf')] }), /excluded local\/media path/)
  assert.throws(() => parseManifest({ ...base, files: [entry('package.json'), entry('package.json')] }), /twice/)
  assert.throws(() => parseManifest({ ...base, files: [entry('index.js')] }), /package.json/)
  // Out-of-range sizes are refused; a zero-byte file is legitimate source.
  assert.throws(() => parseManifest({ ...base, files: [entry('package.json', -1), entry('index.js')] }), /out-of-range/)
  const zero = parseManifest({ version: '1.0.0', files: [
    { path: 'package.json', size: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
    entry('index.js'),
  ] })
  assert.equal(zero.files[0].size, 0)
})

test('isProtectedPath protects local EAC assets and keeps deployable vendor content', () => {
  for (const rel of ['vendor/motion-web/a.mp4', 'vendor/onetake/x', '.eac/keys/k.pem', 'release/x', 'artifacts/y', 'runtime/z', 'node_modules/p/index.js', '.git/config', 'ui/bundle.js', 'ui/bundle.css']) {
    assert.equal(isProtectedPath(rel), true, `${rel} should be protected`)
  }
  for (const rel of ['vendor/open-design/catalog.json', 'vendor/mg-styles-15/style.css', 'vendor/mg-styles-15/assets/covers/a.webp', 'scripts/import-motion-libraries.mjs', 'feed/announcements.json', 'catalog/integrity.json', 'plugin/host.mjs', 'src/server.mjs', 'locale/en.json', 'ui/app.tsx', 'dist/bundle.js', 'package.json']) {
    assert.equal(isProtectedPath(rel), false, `${rel} should be deployable`)
  }
})

test('isOptionalMediaPath mirrors build-release.py and keeps scripts/webp deployable', () => {
  for (const rel of [
    'public/media/studio-preview.mp4', 'dist/media/studio-preview.mp4',
    'vendor/mg-styles-15/videos/demo.mp4',
    'vendor/mg-styles-15/assets/fonts/cjk/notosanssc/NotoSansSC-VF.ttf',
    'vendor/mg-styles-15/assets/audio/x.flac',
    'vendor/mg-styles-15/assets/models/x.ply',
    'vendor/mg-styles-15/assets/hdr/x.hdr',
    'vendor/mg-styles-15/assets/cover.png', 'vendor/mg-styles-15/demos/shot.jpg',
  ]) {
    assert.equal(isOptionalMediaPath(rel), true, `${rel} should be optional media`)
    assert.equal(isExcludedPath(rel), true)
  }
  for (const rel of [
    'vendor/mg-styles-15/style.css', 'vendor/mg-styles-15/index.html',
    'vendor/mg-styles-15/assets/covers/a.webp',
    'vendor/open-design/templates/x.html', 'dist/index.html', 'dist/bundle.js',
    'runtime/fonts/x.ttf',
  ]) {
    assert.equal(isOptionalMediaPath(rel), false, `${rel} should stay deployable`)
  }
})

test('listPackageFiles excludes protected prefixes and optional media but keeps deployable content', async () => {
  await withTemp(async dir => {
    await makePackage(dir, { files: { 'src/a.mjs': 'a', 'vendor/open-design/c.json': '{}', 'vendor/mg-styles-15/style.css': 'c', 'vendor/mg-styles-15/assets/fonts/x.ttf': 'FONT', 'vendor/mg-styles-15/videos/d.mp4': 'VID', 'public/media/v.mp4': 'V', 'dist/media/v.mp4': 'V', 'vendor/motion-web/big.bin': 'BIG', '.eac/keys/k.pem': 'secret', 'node_modules/p/index.js': 'n', 'artifacts/media.png': 'M', 'scripts/tool.mjs': 's' } })
    const files = listPackageFiles(dir)
    assert.ok(files.includes('package.json'))
    assert.ok(files.includes('src/a.mjs'))
    assert.ok(files.includes('plugin/host.mjs'))
    assert.ok(files.includes('dist/index.html'))
    assert.ok(files.includes('vendor/open-design/c.json'))
    assert.ok(files.includes('vendor/mg-styles-15/style.css'))
    assert.ok(files.includes('scripts/tool.mjs'))
    assert.ok(!files.some(f => f.startsWith('vendor/mg-styles-15/assets/fonts')))
    assert.ok(!files.some(f => f.startsWith('vendor/mg-styles-15/videos')))
    assert.ok(!files.some(f => f.startsWith('public/media')))
    assert.ok(!files.some(f => f.startsWith('dist/media')))
    assert.ok(!files.some(f => f.startsWith('vendor/motion-web')))
    assert.ok(!files.some(f => f.startsWith('.eac')))
    assert.ok(!files.some(f => f.startsWith('node_modules')))
  })
})

test('verifyPackageIdentity refuses a foreign package or a missing runtime file', async () => {
  await withTemp(async dir => {
    const good = join(dir, 'good')
    await makePackage(good, { version: '1.0.0' })
    assert.equal(verifyPackageIdentity(good).name, 'eac-design-world')
    // A package with the right files but another name is refused.
    const foreign = join(dir, 'foreign')
    await makePackage(foreign, { version: '1.0.0', name: 'some-other-plugin' })
    assert.throws(() => verifyPackageIdentity(foreign), /not eac-design-world/)
    // A package missing a required runtime file is refused.
    const missing = join(dir, 'missing')
    await makePackage(missing, { version: '1.0.0', identity: false, files: { 'plugin/host.mjs': 'x' } })
    assert.throws(() => verifyPackageIdentity(missing), /required runtime file missing/)
    // Wrong main entry is refused.
    const wrongMain = join(dir, 'wrongmain')
    await makePackage(wrongMain, { version: '1.0.0', main: './index.js' })
    assert.throws(() => verifyPackageIdentity(wrongMain), /package main is/)
    assert.ok(PACKAGE_IDENTITY.requiredFiles.includes('src/version.mjs'))
  })
})

test('buildManifest excludes the manifest itself and supports zero-byte files', async () => {
  await withTemp(async dir => {
    const root = join(dir, 'root')
    await makePackage(root, { version: '1.2.0', files: { 'src/empty.py': '' } })
    // The manifest and its signature live under feed/ and must not hash themselves.
    await writeManifest(root, { unsigned: true, base: './' })
    const { manifest } = buildManifest({ root, unsigned: true })
    assert.ok(!manifest.files.some(f => f.path === 'feed/manifest.json'))
    const empty = manifest.files.find(f => f.path === 'src/empty.py')
    assert.ok(empty, 'zero-byte file must be listed')
    assert.equal(empty.size, 0)
    assert.equal(empty.sha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
})

test('a signed release carrying the wrong package name is refused before the swap', async () => {
  await withTemp(async dir => {
    const pkg = join(dir, 'pkg')
    await makePackage(pkg, { version: '1.0.0' })
    const { publicKey, privateKey } = keypair()
    const release = join(dir, 'release')
    // Same key, but the package is a different project.
    await makePackage(release, { version: '1.1.0', name: 'another-plugin', files: { 'src/a.mjs': 'new' } })
    const { manifest } = buildManifest({ root: release, privateKey, base: './' })
    const routes = { '/feed/manifest.json': JSON.stringify(manifest) }
    for (const file of manifest.files) routes[`/${file.path}`] = await readFile(join(release, ...file.path.split('/')), 'utf8')
    const updater = new MaintenanceUpdater({
      pkgDir: pkg, dataDir: join(dir, 'data'), settings: () => ({}),
      manifestPublicKey: publicKey, defaultSources: ['https://example.test/feed/manifest.json'],
      fetchImpl: fakeFetch(routes), runningVersion: '1.0.0',
    })
    await assert.rejects(updater.apply(), /not eac-design-world|foreign package/)
    // The installed package is untouched.
    assert.equal(JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8')).version, '1.0.0')
  })
})

test('remote apply fails closed with no signing key and works with an injected key', async () => {
  await withTemp(async dir => {
    const pkg = join(dir, 'pkg')
    await makePackage(pkg, { version: '1.0.0' })
    const data = join(dir, 'data')
    // No key: check() must refuse before any network use.
    const disabled = new MaintenanceUpdater({ pkgDir: pkg, dataDir: data, settings: () => ({}), manifestPublicKey: null })
    assert.equal(disabled.remoteEnabled, false)
    await assert.rejects(disabled.check(), new RegExp(NO_SIGNING_KEY_ERROR))
    assert.equal(disabled.status().remoteEnabled, false)

    // With an injected key the same installation checks and applies a signed release.
    const { publicKey, privateKey } = keypair()
    const release = join(dir, 'release')
    await makePackage(release, { version: '1.1.0', files: { 'index.js': 'export const version = "1.1.0"\n', 'src/a.mjs': 'new' } })
    const { manifest } = buildManifest({ root: release, privateKey, base: './' })
    const routes = { '/feed/manifest.json': JSON.stringify(manifest) }
    for (const file of manifest.files) {
      routes[`/${file.path}`] = await readFile(join(release, ...file.path.split('/')), 'utf8')
    }
    const updater = new MaintenanceUpdater({
      pkgDir: pkg, dataDir: data, settings: () => ({}),
      manifestPublicKey: publicKey,
      defaultSources: ['https://example.test/feed/manifest.json'],
      fetchImpl: fakeFetch(routes),
      runningVersion: '1.0.0',
    })
    const check = await updater.check()
    assert.equal(check.available, true)
    assert.equal(check.latest, '1.1.0')
    let activatedVersion
    const result = await updater.apply({ activate: async r => { activatedVersion = r.version; return { ok: true, version: r.version } } })
    assert.equal(result.version, '1.1.0')
    assert.equal(activatedVersion, '1.1.0')
    assert.equal(JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8')).version, '1.1.0')
    assert.equal(await readFile(join(pkg, 'src', 'a.mjs'), 'utf8'), 'new')
    assert.equal(updater.status().rollbackAvailable, true)
  })
})

test('a tampered file body aborts staging and leaves the install untouched', async () => {
  await withTemp(async dir => {
    const pkg = join(dir, 'pkg')
    await makePackage(pkg, { version: '1.0.0' })
    const { publicKey, privateKey } = keypair()
    const release = join(dir, 'release')
    await makePackage(release, { version: '1.1.0', files: { 'index.js': 'v1.1.0\n' } })
    const { manifest } = buildManifest({ root: release, privateKey, base: './' })
    const routes = { '/feed/manifest.json': JSON.stringify(manifest) }
    for (const file of manifest.files) routes[`/${file.path}`] = 'tampered body'
    const updater = new MaintenanceUpdater({
      pkgDir: pkg, dataDir: join(dir, 'data'), settings: () => ({}),
      manifestPublicKey: publicKey, defaultSources: ['https://example.test/feed/manifest.json'],
      fetchImpl: fakeFetch(routes), runningVersion: '1.0.0',
    })
    await assert.rejects(updater.apply(), /sha256 mismatch|staging failed/)
    assert.equal(JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8')).version, '1.0.0')
    assert.equal(await readFile(join(pkg, 'index.js'), 'utf8'), 'export const version = "1.0.0"\n')
  })
})

test('a failed activation restores the previous files from the backup', async () => {
  await withTemp(async dir => {
    const pkg = join(dir, 'pkg')
    await makePackage(pkg, { version: '1.0.0', files: { 'index.js': 'old\n' } })
    const { publicKey, privateKey } = keypair()
    const release = join(dir, 'release')
    await makePackage(release, { version: '1.1.0', files: { 'index.js': 'new\n' } })
    const { manifest } = buildManifest({ root: release, privateKey, base: './' })
    const routes = { '/feed/manifest.json': JSON.stringify(manifest) }
    for (const file of manifest.files) routes[`/${file.path}`] = await readFile(join(release, ...file.path.split('/')), 'utf8')
    const updater = new MaintenanceUpdater({
      pkgDir: pkg, dataDir: join(dir, 'data'), settings: () => ({}),
      manifestPublicKey: publicKey, defaultSources: ['https://example.test/feed/manifest.json'],
      fetchImpl: fakeFetch(routes), runningVersion: '1.0.0',
    })
    await assert.rejects(updater.apply({ activate: async () => ({ ok: false, error: 'boom', restored: false }) }), /boom|previous files restored/)
    assert.equal(await readFile(join(pkg, 'index.js'), 'utf8'), 'old\n')
    assert.equal(JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8')).version, '1.0.0')
    assert.equal(updater.status().recoveryRequired, true)
  })
})

test('applyLocal resolves the package root from manifest.base given only manifestPath', async () => {
  await withTemp(async dir => {
    const pkg = join(dir, 'pkg')
    await makePackage(pkg, { version: '1.0.0' })
    // Build a release laid out as update/manifest.json + update/files/ (base ./files/).
    const release = join(dir, 'update')
    const filesRoot = join(release, 'files')
    await makePackage(filesRoot, { version: '1.2.0', files: { 'src/a.mjs': 'new-a' } })
    const { publicKey, privateKey } = keypair()
    const built = buildManifest({ root: filesRoot, privateKey, base: './files/' })
    await mkdir(release, { recursive: true })
    await writeFile(join(release, 'manifest.json'), JSON.stringify(built.manifest, null, 2))
    const updater = new MaintenanceUpdater({
      pkgDir: pkg, dataDir: join(dir, 'data'), settings: () => ({}),
      manifestPublicKey: publicKey, runningVersion: '1.0.0',
    })
    // Only the manifest path is supplied; the root comes from base.
    const result = await updater.applyLocal({ manifestPath: join(release, 'manifest.json') })
    assert.equal(result.version, '1.2.0')
    assert.equal(result.signed, true)
    assert.equal(await readFile(join(pkg, 'src', 'a.mjs'), 'utf8'), 'new-a')
  })
})

test('applyLocal refuses a manifest base that escapes its directory', async () => {
  await withTemp(async dir => {
    const pkg = join(dir, 'pkg')
    await makePackage(pkg, { version: '1.0.0' })
    const release = join(dir, 'update')
    await mkdir(release, { recursive: true })
    // parseManifest itself rejects absolute/escape bases before we get further.
    const { privateKey } = keypair()
    const filesRoot = join(release, 'files')
    await makePackage(filesRoot, { version: '1.2.0' })
    const built = buildManifest({ root: filesRoot, privateKey, base: '../' })
    built.manifest.base = '../../etc/'
    await writeFile(join(release, 'manifest.json'), JSON.stringify(built.manifest, null, 2))
    const { publicKey } = keypair()
    const updater = new MaintenanceUpdater({
      pkgDir: pkg, dataDir: join(dir, 'data'), settings: () => ({}),
      manifestPublicKey: publicKey, runningVersion: '1.0.0',
    })
    await assert.rejects(updater.applyLocal({ manifestPath: join(release, 'manifest.json'), allowUnsigned: true }), /relative|escapes/)
  })
})

test('rollback reports failure when activation returns the wrong version', async () => {
  await withTemp(async dir => {
    const pkg = join(dir, 'pkg')
    await makePackage(pkg, { version: '1.0.0', files: { 'src/a.mjs': 'old' } })
    const { publicKey, privateKey } = keypair()
    const release = join(dir, 'release')
    await makePackage(release, { version: '1.1.0', files: { 'src/a.mjs': 'new' } })
    const { manifest } = buildManifest({ root: release, privateKey, base: './' })
    const routes = { '/feed/manifest.json': JSON.stringify(manifest) }
    for (const file of manifest.files) routes[`/${file.path}`] = await readFile(join(release, ...file.path.split('/')), 'utf8')
    const updater = new MaintenanceUpdater({
      pkgDir: pkg, dataDir: join(dir, 'data'), settings: () => ({}),
      manifestPublicKey: publicKey, defaultSources: ['https://example.test/feed/manifest.json'],
      fetchImpl: fakeFetch(routes), runningVersion: '1.0.0',
    })
    await updater.apply({ activate: async r => ({ ok: true, version: r.version }) })
    // Activation claims success but names the wrong version: not a real rollback.
    const rolled = await updater.rollback({ activate: async () => ({ ok: true, version: '9.9.9' }) })
    assert.equal(rolled.ok, false)
    assert.equal(rolled.activated, false)
    assert.match(rolled.error, /version mismatch/)
    assert.equal(updater.status().recoveryRequired, true)
    assert.equal(await readFile(join(pkg, 'src', 'a.mjs'), 'utf8'), 'old')
  })
})

test('license-excluded paths are preserved, not deleted, by an update', async () => {
  await withTemp(async dir => {
    const pkg = join(dir, 'pkg')
    await makePackage(pkg, { version: '1.0.0' })
    // Place a license-excluded local file that a prepared release never carries.
    const excluded = LICENSE_EXCLUDED_PATHS[0]
    const excludedTarget = join(pkg, ...excluded.split('/'))
    await mkdir(resolve(excludedTarget, '..'), { recursive: true })
    await writeFile(excludedTarget, 'LICENSED-LOCAL')
    const fontPrefixFile = join(pkg, ...`${LICENSE_EXCLUDED_PREFIXES[0]}x.ttf`.split('/'))
    await mkdir(resolve(fontPrefixFile, '..'), { recursive: true })
    await writeFile(fontPrefixFile, 'FONT')
    // They are excluded from the manifest and from listPackageFiles.
    assert.equal(isExcludedPath(excluded), true)
    assert.equal(isExcludedPath(`${LICENSE_EXCLUDED_PREFIXES[0]}x.ttf`), true)
    assert.ok(!listPackageFiles(pkg).includes(excluded))
    assert.throws(() => parseManifest({ version: '1.0.0', files: [
      { path: excluded, size: 13, sha256: 'a'.repeat(64) },
      { path: 'package.json', size: 1, sha256: 'b'.repeat(64) },
    ] }), /excluded local\/media path/)

    // Apply a release that does not list them; they must survive.
    const { publicKey, privateKey } = keypair()
    const release = join(dir, 'release')
    await makePackage(release, { version: '1.1.0', files: { 'src/a.mjs': 'new' } })
    const { manifest } = buildManifest({ root: release, privateKey, base: './' })
    const routes = { '/feed/manifest.json': JSON.stringify(manifest) }
    for (const file of manifest.files) routes[`/${file.path}`] = await readFile(join(release, ...file.path.split('/')), 'utf8')
    const updater = new MaintenanceUpdater({
      pkgDir: pkg, dataDir: join(dir, 'data'), settings: () => ({}),
      manifestPublicKey: publicKey, defaultSources: ['https://example.test/feed/manifest.json'],
      fetchImpl: fakeFetch(routes), runningVersion: '1.0.0',
    })
    await updater.apply({ activate: async r => ({ ok: true, version: r.version }) })
    assert.equal(await readFile(excludedTarget, 'utf8'), 'LICENSED-LOCAL')
    assert.equal(await readFile(fontPrefixFile, 'utf8'), 'FONT')
  })
})

test('installStaged refuses a junction inside the package that escapes outside', async () => {
  await withTemp(async dir => {
    const stage = join(dir, 'stage')
    const pkg = join(dir, 'pkg')
    await makePackage(stage, { files: { 'index.js': 'new' } })
    await makePackage(pkg, { files: { 'index.js': 'old' } })
    // A real directory outside the package, then a junction pkg/sub -> outside.
    const outside = join(dir, 'outside')
    await mkdir(outside, { recursive: true })
    await symlink(outside, join(pkg, 'sub'), 'junction')
    // A manifest path that resolves through the junction must be refused.
    await assert.rejects(
      installStaged(stage, pkg, ['package.json', 'index.js', 'sub/evil.js']),
      /symlink or junction/,
    )
    // Nothing was written outside the package.
    assert.ok(!existsSync(join(outside, 'evil.js')))
  })
})

test('listPackageFiles refuses a package containing a non-excluded junction', async () => {
  await withTemp(async dir => {
    await makePackage(dir, { files: { 'index.js': 'x' } })
    const outside = join(dir, '..', `outside-${crypto.randomUUID()}`)
    await mkdir(outside, { recursive: true })
    await symlink(outside, join(dir, 'linked'), 'junction')
    assert.throws(() => listPackageFiles(dir), /symlink or junction/)
    // An EXCLUDED junction (a user's linked optional library) is skipped, not fatal.
    await rm(join(dir, 'linked'), { recursive: true, force: true })
    await mkdir(join(dir, 'vendor'), { recursive: true })
    await symlink(outside, join(dir, 'vendor', 'motion-web'), 'junction')
    assert.doesNotThrow(() => listPackageFiles(dir))
    await rm(outside, { recursive: true, force: true })
  })
})

test('restoreBackup refuses to write through a junction in the package', async () => {
  await withTemp(async dir => {
    const pkg = join(dir, 'pkg')
    // The package has a real file under a directory that will become a junction.
    await makePackage(pkg, { files: { 'sub/keep.js': 'keep' } })
    const backup = join(dir, 'backup')
    backupPackage(pkg, backup)
    // Replace pkg/sub with a junction pointing outside the package.
    await rm(join(pkg, 'sub'), { recursive: true, force: true })
    const outside = join(dir, 'outside')
    await mkdir(outside, { recursive: true })
    await symlink(outside, join(pkg, 'sub'), 'junction')
    // The restore must refuse rather than write sub/keep.js through the junction.
    assert.throws(() => restoreBackup(backup, pkg), /rollback incomplete|symlink or junction/)
    assert.ok(!existsSync(join(outside, 'keep.js')))
    await rm(outside, { recursive: true, force: true })
  })
})

test('an update preserves unknown user files and prunes only previously-owned ones', async () => {
  await withTemp(async dir => {
    const pkg = join(dir, 'pkg')
    await makePackage(pkg, { version: '1.0.0', files: { 'src/a.mjs': 'a', 'src/gone.mjs': 'gone' } })
    // A file the user added that no release ever owned.
    await writeFile(join(pkg, 'user-notes.md'), 'mine')
    const { publicKey, privateKey } = keypair()
    // First release drops src/gone.mjs. With no receipt yet, nothing is pruned.
    const release = join(dir, 'release')
    await makePackage(release, { version: '1.1.0', files: { 'src/a.mjs': 'a2' } })
    const { manifest } = buildManifest({ root: release, privateKey, base: './' })
    const routes = { '/feed/manifest.json': JSON.stringify(manifest) }
    for (const file of manifest.files) routes[`/${file.path}`] = await readFile(join(release, ...file.path.split('/')), 'utf8')
    const updater = new MaintenanceUpdater({
      pkgDir: pkg, dataDir: join(dir, 'data'), settings: () => ({}),
      manifestPublicKey: publicKey, defaultSources: ['https://example.test/feed/manifest.json'],
      fetchImpl: fakeFetch(routes), runningVersion: '1.0.0',
    })
    await updater.apply({ activate: async r => ({ ok: true, version: r.version }) })
    // The user file survives; the never-owned stale file also survives the first update.
    assert.equal(await readFile(join(pkg, 'user-notes.md'), 'utf8'), 'mine')
    assert.ok(existsSync(join(pkg, 'src', 'gone.mjs')))

    // The receipt now lists the 1.1.0 managed set. A second release that drops
    // src/gone.mjs (now owned) prunes it, while the user file still survives.
    await writeFile(join(pkg, 'src', 'gone.mjs'), 'stale')
    updater.saveOwnedFiles(new Set(['package.json', 'plugin/host.mjs', 'src/server.mjs', 'src/version.mjs', 'dist/index.html', 'src/a.mjs', 'src/gone.mjs']))
    const release2 = join(dir, 'release2')
    await makePackage(release2, { version: '1.2.0', files: { 'src/a.mjs': 'a3' } })
    const { manifest: manifest2 } = buildManifest({ root: release2, privateKey, base: './' })
    const routes2 = { '/feed/manifest.json': JSON.stringify(manifest2) }
    for (const file of manifest2.files) routes2[`/${file.path}`] = await readFile(join(release2, ...file.path.split('/')), 'utf8')
    updater.deps.fetchImpl = fakeFetch(routes2)
    updater.deps.runningVersion = '1.1.0'
    await updater.apply({ activate: async r => ({ ok: true, version: r.version }) })
    assert.ok(!existsSync(join(pkg, 'src', 'gone.mjs')), 'previously-owned dropped file is pruned')
    assert.equal(await readFile(join(pkg, 'user-notes.md'), 'utf8'), 'mine')
  })
})

test('applyLocal refuses a source read through a junction in the local package', async () => {
  await withTemp(async dir => {
    const pkg = join(dir, 'pkg')
    await makePackage(pkg, { version: '1.0.0' })
    const release = join(dir, 'update')
    await mkdir(release, { recursive: true })
    const { publicKey, privateKey } = keypair()
    // Build a valid signed manifest whose files live under update/files/, but a
    // junction at update/files/sub points outside the package.
    const filesRoot = join(release, 'files')
    await makePackage(filesRoot, { version: '1.2.0', files: { 'sub/evil.js': 'evil' } })
    const built = buildManifest({ root: filesRoot, privateKey, base: './files/' })
    await writeFile(join(release, 'manifest.json'), JSON.stringify(built.manifest, null, 2))
    // Replace the real sub/ with a junction to an outside directory that holds
    // the same bytes, so only the symlink guard can catch the escape.
    await rm(join(filesRoot, 'sub'), { recursive: true, force: true })
    const outside = join(dir, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'evil.js'), 'evil')
    await symlink(outside, join(filesRoot, 'sub'), 'junction')
    const updater = new MaintenanceUpdater({
      pkgDir: pkg, dataDir: join(dir, 'data'), settings: () => ({}),
      manifestPublicKey: publicKey, runningVersion: '1.0.0',
    })
    await assert.rejects(
      updater.applyLocal({ manifestPath: join(release, 'manifest.json') }),
      /symlink or junction/,
    )
    // The installed package is untouched.
    assert.equal(JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8')).version, '1.0.0')
  })
})

test('rollback restores ownership without claiming user files on a subsequent update', async () => {
  await withTemp(async dir => {
    const pkg = await makePackage(join(dir, 'pkg'), { files: { 'src/user-custom.mjs': 'user content', 'src/retired.mjs': 'old release file' } })
    const release = await makePackage(join(dir, 'release'), { version: '1.1.0', files: { 'src/new-release.mjs': 'new release file' } })
    const { privateKey, publicKey } = keypair()
    const { manifest } = await writeManifest(release, { privateKey })
    const updater = new MaintenanceUpdater({
      pkgDir: pkg, dataDir: join(dir, 'data'), settings: () => ({}),
      manifestPublicKey: publicKey, runningVersion: '1.0.0',
    })
    updater.saveOwnedFiles(new Set(['package.json', 'src/retired.mjs']))
    const options = { manifestPath: join(release, 'feed', 'manifest.json') }
    await updater.applyLocal(options)
    assert.equal(existsSync(join(pkg, 'src/retired.mjs')), false)
    await writeFile(join(pkg, 'src/user-after-update.mjs'), 'later user content')
    await updater.rollback()
    assert.deepEqual([...updater.loadOwnedFiles()].sort(), ['package.json', 'src/retired.mjs'])
    assert.equal(await readFile(join(pkg, 'src/retired.mjs'), 'utf8'), 'old release file')
    assert.equal(existsSync(join(pkg, 'src/new-release.mjs')), false)
    assert.equal(await readFile(join(pkg, 'src/user-after-update.mjs'), 'utf8'), 'later user content')
    await updater.applyLocal(options)
    assert.equal(existsSync(join(pkg, 'src/retired.mjs')), false)
    assert.equal(await readFile(join(pkg, 'src/user-custom.mjs'), 'utf8'), 'user content')
    assert.equal(JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8')).version, manifest.version)
  })
})

test('rollback({activate}) restores the backup and reports activation', async () => {
  await withTemp(async dir => {
    const pkg = join(dir, 'pkg')
    await makePackage(pkg, { version: '1.0.0', files: { 'index.js': 'old\n' } })
    const { publicKey, privateKey } = keypair()
    const release = join(dir, 'release')
    await makePackage(release, { version: '1.1.0', files: { 'index.js': 'new\n' } })
    const { manifest } = buildManifest({ root: release, privateKey, base: './' })
    const routes = { '/feed/manifest.json': JSON.stringify(manifest) }
    for (const file of manifest.files) routes[`/${file.path}`] = await readFile(join(release, ...file.path.split('/')), 'utf8')
    const updater = new MaintenanceUpdater({
      pkgDir: pkg, dataDir: join(dir, 'data'), settings: () => ({}),
      manifestPublicKey: publicKey, defaultSources: ['https://example.test/feed/manifest.json'],
      fetchImpl: fakeFetch(routes), runningVersion: '1.0.0',
    })
    await updater.apply({ activate: async r => ({ ok: true, version: r.version }) })
    assert.equal(await readFile(join(pkg, 'index.js'), 'utf8'), 'new\n')
    const rolled = await updater.rollback({ activate: async r => ({ ok: true, version: r.version }) })
    assert.equal(rolled.ok, true)
    assert.equal(rolled.activated, true)
    assert.equal(await readFile(join(pkg, 'index.js'), 'utf8'), 'old\n')
    assert.equal(JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8')).version, '1.0.0')
  })
})

test('applyLocal verifies hashes and refuses an unsigned package unless allowed', async () => {
  await withTemp(async dir => {
    const pkg = join(dir, 'pkg')
    await makePackage(pkg, { version: '1.0.0' })
    const release = join(dir, 'release')
    await makePackage(release, { version: '1.1.0', files: { 'index.js': 'local\n' } })
    const { publicKey } = keypair()
    // Build a signed local package with a DIFFERENT throwaway key, so the
    // configured key does not match and the package is refused.
    await writeManifest(release, { privateKey: keypair().privateKey, base: './' })
    const updater = new MaintenanceUpdater({
      pkgDir: pkg, dataDir: join(dir, 'data'), settings: () => ({}),
      manifestPublicKey: publicKey, runningVersion: '1.0.0',
    })
    await assert.rejects(updater.applyLocal({ packageDir: release }), /not signed with the configured release key/)
    // An explicit acknowledgement imports it anyway, hashes still verified.
    const result = await updater.applyLocal({ packageDir: release, allowUnsigned: true })
    assert.equal(result.version, '1.1.0')
    assert.equal(result.signed, false)
    assert.equal(await readFile(join(pkg, 'index.js'), 'utf8'), 'local\n')
  })
})

test('applyLocal refuses an unsigned manifest without allowUnsigned', async () => {
  await withTemp(async dir => {
    const pkg = join(dir, 'pkg')
    await makePackage(pkg, { version: '1.0.0' })
    const release = join(dir, 'release')
    await makePackage(release, { version: '1.1.0', files: { 'index.js': 'local\n' } })
    await writeManifest(release, { unsigned: true, base: './' })
    const { publicKey } = keypair()
    const updater = new MaintenanceUpdater({
      pkgDir: pkg, dataDir: join(dir, 'data'), settings: () => ({}),
      manifestPublicKey: publicKey, runningVersion: '1.0.0',
    })
    await assert.rejects(updater.applyLocal({ packageDir: release }), /not signed with the configured release key/)
  })
})

test('backup and restore are hash-verified and preserve protected paths', async () => {
  await withTemp(async dir => {
    const pkg = join(dir, 'pkg')
    await makePackage(pkg, { files: { 'index.js': 'x', 'src/a.mjs': 'a', 'vendor/motion-web/local.bin': 'LOCAL' } })
    const backup = join(dir, 'backup')
    const count = backupPackage(pkg, backup, { installed: ['extra.mjs'] })
    assert.ok(count >= 2)
    // The optional local library is never copied into the backup.
    assert.ok(!existsSync(join(backup, 'vendor', 'motion-web', 'local.bin')))
    // Mutate the installed copy, then restore.
    await writeFile(join(pkg, 'src', 'a.mjs'), 'changed')
    await writeFile(join(pkg, 'extra.mjs'), 'dropped-by-release')
    restoreBackup(backup, pkg)
    assert.equal(await readFile(join(pkg, 'src', 'a.mjs'), 'utf8'), 'a')
    assert.ok(!existsSync(join(pkg, 'extra.mjs')))
    // The protected local asset was never touched.
    assert.equal(await readFile(join(pkg, 'vendor', 'motion-web', 'local.bin'), 'utf8'), 'LOCAL')
  })
})

test('legacy backups without an install receipt preserve later user additions', async () => {
  await withTemp(async dir => {
    const pkg = await makePackage(join(dir, 'pkg'))
    const backup = join(dir, 'backup')
    backupPackage(pkg, backup)
    await writeFile(join(pkg, 'user-after-backup.mjs'), 'user content')
    restoreBackup(backup, pkg)
    assert.equal(await readFile(join(pkg, 'user-after-backup.mjs'), 'utf8'), 'user content')
  })
})

test('installStaged writes atomically and prunes only previously-owned dropped files', async () => {
  await withTemp(async dir => {
    const stage = join(dir, 'stage')
    const pkg = join(dir, 'pkg')
    await makePackage(stage, { files: { 'index.js': 'new', 'src/b.mjs': 'b' } })
    await makePackage(pkg, { files: { 'index.js': 'old', 'src/a.mjs': 'a' } })
    await writeFile(join(pkg, 'user-extra.mjs'), 'mine')
    const applied = await installStaged(stage, pkg, ['package.json', 'plugin/host.mjs', 'src/server.mjs', 'src/version.mjs', 'dist/index.html', 'index.js', 'src/b.mjs'], { previousOwned: ['package.json', 'index.js', 'src/a.mjs'] })
    assert.equal(await readFile(join(pkg, 'index.js'), 'utf8'), 'new')
    assert.ok(existsSync(join(pkg, 'src', 'b.mjs')))
    // src/a.mjs was owned by the previous install and is dropped by the release.
    assert.ok(!existsSync(join(pkg, 'src', 'a.mjs')))
    // The user's own file is not owned and is preserved.
    assert.equal(await readFile(join(pkg, 'user-extra.mjs'), 'utf8'), 'mine')
    assert.deepEqual(applied.pruned, ['src/a.mjs'])
    // No scratch files remain.
    assert.ok(!listPackageFiles(pkg).some(f => f.includes('.eac-new')))
  })
})

test('installStaged with an empty receipt prunes nothing (first managed update)', async () => {
  await withTemp(async dir => {
    const stage = join(dir, 'stage')
    const pkg = join(dir, 'pkg')
    await makePackage(stage, { files: { 'index.js': 'new' } })
    await makePackage(pkg, { files: { 'index.js': 'old', 'legacy.mjs': 'legacy' } })
    await installStaged(stage, pkg, ['package.json', 'plugin/host.mjs', 'src/server.mjs', 'src/version.mjs', 'dist/index.html', 'index.js'], { previousOwned: [] })
    // The never-owned legacy file is preserved on the first managed update.
    assert.ok(existsSync(join(pkg, 'legacy.mjs')))
  })
})

test('buildManifest + copyRelease produce an importable local package', async () => {
  await withTemp(async dir => {
    const root = join(dir, 'root')
    await makePackage(root, { version: '2.0.0', files: { 'index.js': 'v2', 'vendor/onetake/optional.bin': 'OPT' } })
    const { publicKey, privateKey } = keypair()
    const built = await writeManifest(root, { privateKey })
    assert.equal(built.signed, true)
    assert.equal(built.manifest.version, '2.0.0')
    assert.ok(built.manifest.files.some(f => f.path === 'index.js'))
    assert.ok(!built.manifest.files.some(f => f.path.startsWith('vendor/onetake')))
    assert.equal(verifyManifestSignature(built.manifest, publicKey), true)
    const copyDir = join(dir, 'copy')
    copyRelease(root, copyDir)
    assert.ok(existsSync(join(copyDir, 'index.js')))
    assert.ok(!existsSync(join(copyDir, 'vendor', 'onetake', 'optional.bin')))
    // The copied package installs through applyLocal with the matching key.
    const pkg = join(dir, 'pkg')
    await makePackage(pkg, { version: '1.0.0' })
    const updater = new MaintenanceUpdater({
      pkgDir: pkg, dataDir: join(dir, 'data'), settings: () => ({}),
      manifestPublicKey: publicKey, runningVersion: '1.0.0',
    })
    const result = await updater.applyLocal({ packageDir: copyDir, manifestPath: join(root, 'feed', 'manifest.json') })
    assert.equal(result.version, '2.0.0')
    assert.equal(result.signed, true)
  })
})

test('signed local updates enforce minSupported before staging or altering installed files', async () => {
  await withTemp(async dir => {
    const pkg = join(dir, 'pkg'), release = join(dir, 'release');
    await makePackage(pkg, { version: '0.1.0' });
    await makePackage(release, { version: '0.5.0' });
    const keys = keypair();
    await writeManifest(release, { privateKey: keys.privateKey, minSupported: '0.3.0' });
    const updater = new MaintenanceUpdater({ pkgDir: pkg, dataDir: join(dir, 'data'), settings: () => ({}), manifestPublicKey: keys.publicKey });
    const before = await readFile(join(pkg, 'package.json'), 'utf8');
    await assert.rejects(updater.applyLocal({ manifestPath: join(release, 'feed/manifest.json') }), /requires at least 0.3.0/);
    assert.equal(await readFile(join(pkg, 'package.json'), 'utf8'), before);
    assert.equal(existsSync(updater.stageDir), false);
    await makePackage(pkg, { version: '0.3.0' });
    const result = await updater.applyLocal({ manifestPath: join(release, 'feed/manifest.json') });
    assert.equal(result.version, '0.5.0');
    assert.equal(result.signed, true);
  });
});
