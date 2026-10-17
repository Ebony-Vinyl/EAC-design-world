#!/usr/bin/env node
/**
 * Build and (optionally) sign a release manifest for the EAC Design World
 * Harness plugin.
 *
 * The manifest lists every deployable file of a release with its size and
 * SHA-256, using the same protected-prefix exclusion the in-app updater applies
 * (`src/maintenance-updater.mjs`): local media, the optional vendor libraries,
 * node_modules and built/runtime output never travel with an update. The
 * resulting document is what `MaintenanceUpdater.check()` downloads and
 * `MaintenanceUpdater.applyLocal()` imports from a prepared directory.
 *
 * Usage:
 *   node scripts/build-update-manifest.mjs \
 *     --root <pkgDir> --output <path> \
 *     [--base <relative>] [--key <private.pem>] \
 *     [--version <semver>] [--notes <text>] [--min-supported <semver>] \
 *     [--copy-to <dir>] [--unsigned]
 *
 * Without `--key` the manifest is written unsigned only when `--unsigned` is
 * passed explicitly; an unsigned remote manifest is refused by every consumer.
 * The private key is never committed; keep it outside the repository (for
 * example in `.eac/keys/`, which `.gitignore` covers).
 *
 * @module scripts/build-update-manifest
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { listPackageFiles, signManifest, isProtectedPath, parseManifest } from '../src/maintenance-updater.mjs'

/** sha256 of one file as lowercase hex. */
export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/**
 * Build a manifest document from a package directory.
 *
 * @param {object} options
 * @param {string} options.root - package directory to walk
 * @param {string} [options.version] - explicit version; defaults to package.json
 * @param {string} [options.base='../'] - manifest-relative base for file URLs
 * @param {string} [options.notes=''] - release notes
 * @param {string} [options.minSupported] - minimum supported installed version
 * @param {string|crypto.KeyObject} [options.privateKey] - Ed25519 key; omit for unsigned
 * @param {boolean} [options.unsigned=false] - required to omit a signature
 * @param {Date} [options.now] - publication timestamp
 * @returns {{manifest: object, files: number, bytes: number, signed: boolean}}
 */
export function buildManifest({ root, version, base = '../', notes = '', minSupported, privateKey, unsigned = false, now = new Date() }) {
  if (typeof root !== 'string' || root === '') throw new Error('buildManifest requires a root directory')
  const pkgDir = path.resolve(root)
  if (!fs.existsSync(pkgDir)) throw new Error(`root does not exist: ${pkgDir}`)
  const manifestVersion = version ?? JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version
  if (typeof manifestVersion !== 'string' || manifestVersion.trim() === '') throw new Error('no version: pass --version or provide a package.json')
  if (privateKey === undefined && unsigned !== true) throw new Error('refusing to build an unsigned manifest without --unsigned')
  const files = listPackageFiles(pkgDir).sort().map(rel => {
    if (isProtectedPath(rel)) throw new Error(`protected path in release: ${rel}`)
    const file = path.join(pkgDir, ...rel.split('/'))
    return { path: rel, size: fs.statSync(file).size, sha256: sha256File(file) }
  })
  if (!files.some(file => file.path === 'package.json')) throw new Error('release must include package.json')
  const payload = {
    manifestVersion: 1,
    version: manifestVersion,
    base,
    publishedAt: now.toISOString(),
    notes,
    ...minSupported === undefined ? {} : { minSupported },
    files,
  }
  // Sign the NORMALIZED document: consumers verify against the output of
  // parseManifest (which turns publishedAt into a number and clamps notes), so
  // the signer must reduce the manifest the same way or every signature fails.
  // The stored document keeps the human-readable ISO timestamp; the signature
  // is over the reduced form both sides compute.
  const normalized = parseManifest(payload)
  if (privateKey !== undefined) payload.signature = signManifest({ ...normalized }, privateKey)
  return {
    manifest: payload,
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
    signed: privateKey !== undefined,
  }
}

/** Copy a release's deployable files into `destination` preserving relative paths. */
export function copyRelease(root, destination) {
  const pkgDir = path.resolve(root)
  const dest = path.resolve(destination)
  const copied = []
  for (const rel of listPackageFiles(pkgDir).sort()) {
    const source = path.join(pkgDir, ...rel.split('/'))
    const target = path.join(dest, ...rel.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target)
    copied.push(rel)
  }
  return copied
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const [flag, inline] = token.slice(2).split('=')
    if (['unsigned'].includes(flag)) { args[flag] = true; continue }
    const value = inline ?? argv[i + 1]
    if (inline === undefined) i += 1
    args[flag] = value
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const root = args.root ?? process.cwd()
  const output = args.output ?? path.join(root, 'feed', 'manifest.json')
  const privateKey = typeof args.key === 'string' ? fs.readFileSync(args.key, 'utf8') : undefined
  const built = buildManifest({
    root,
    version: args.version,
    base: args.base ?? '../',
    notes: args.notes ?? '',
    minSupported: args['min-supported'],
    privateKey,
    unsigned: args.unsigned === true,
  })
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true })
  fs.writeFileSync(path.resolve(output), `${JSON.stringify(built.manifest, null, 2)}\n`)
  let copiedTo
  if (typeof args['copy-to'] === 'string' && args['copy-to'] !== '') {
    copiedTo = path.resolve(args['copy-to'])
    copyRelease(root, copiedTo)
  }
  process.stdout.write(`${JSON.stringify({ output: path.resolve(output), files: built.files, bytes: built.bytes, signed: built.signed, ...copiedTo === undefined ? {} : { copiedTo } })}\n`)
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`build-update-manifest: ${error?.message ?? error}\n`)
    process.exitCode = 1
  })
}
