/**
 * In-app plugin upgrade for the EAC Design World Harness plugin.
 *
 * Ported (MIT) from `Ebony-Vinyl/dsh-our-free-model` `src/updater.js`
 * (commit 0b712bcbb887ae101cae5fdf935b0845761a1421, Copyright (c) 2026
 * Ebony-Vinyl, MIT License — see THIRD_PARTY_NOTICES.md). Adapted for this
 * project: repository identity, symbol namespace, file/size caps sized for a
 * repository of a few thousand files, and a trust root that is deliberately
 * absent by default rather than copied from upstream.
 *
 * Applying an update is download -> verify -> stage -> backup -> replace ->
 * verify -> reload:
 *
 * - downloads land in a staging directory under the plugin's data dir and are
 *   hash-checked before anything on the installed copy is touched;
 * - the running process keeps executing from its in-memory module graph, so
 *   replacing files on disk cannot disturb a live request;
 * - the installed package is backed up first, a failed verification restores
 *   it, and a failed reload also restores the disk from that same backup;
 * - replacements are written as `<file>.eac-new` beside their target and
 *   renamed over it, so a crash mid-swap cannot truncate a file that the next
 *   boot will import (transient Windows EPERM from indexers is retried).
 *
 * Remote updates require a pinned Ed25519 release key. This project ships no
 * default key (`PINNED_MANIFEST_PUBLIC_KEY` is `null`): until an installation
 * configures one, a remote manifest is refused with an explicit error rather
 * than silently applied. Local, explicitly triggered imports are supported by
 * {@link MaintenanceUpdater#applyLocal}; content hashes are always verified,
 * and an unsigned local package is refused unless the caller opts in.
 *
 * @module src/maintenance-updater.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const REPO = 'Ebony-Vinyl/EAC-design-world'

/** Discovery locations, in preference order.
 *
 * The release channel lives on a dedicated `updates` branch, not `main`: `main`
 * is the source tree, and its `dist/` output is gitignored, so a manifest built
 * from it would not be deployable. `updates` carries the prepared runtime tree
 * (built `dist`, no node_modules, no optional media) and its `feed/manifest.json`.
 * Official mutable refs are resolved to a full commit before fetching either the
 * manifest or its files. Mirrors remain untrusted: only an existing Ed25519
 * signature authorizes content. */
export const DEFAULT_MANIFEST_SOURCES = [
  `https://raw.githubusercontent.com/${REPO}/updates/feed/manifest.json`,
  `https://cdn.jsdelivr.net/gh/${REPO}@updates/feed/manifest.json`,
  `https://raw.githubusercontent.com/${REPO}/main/feed/manifest.json`,
  `https://cdn.jsdelivr.net/gh/${REPO}@main/feed/manifest.json`,
]

/**
 * The Ed25519 public key (SPKI, base64) every remote release manifest must be
 * signed with before it may be applied.
 *
 * Deliberately `null`: this project has no release signing key configured, and
 * copying upstream's key would authenticate upstream's code rather than ours.
 * An installation that publishes signed releases supplies its own key here (or
 * via the settings/constructor); until then remote application fails closed.
 */
export const PINNED_MANIFEST_PUBLIC_KEY = null

/** The manifest fields a signature covers, in canonical (sorted-key) JSON. */
export const SIGNED_FIELDS = ['version', 'base', 'publishedAt', 'notes', 'files', 'minSupported']

/**
 * Size caps. The upstream defaults (80 files / 4 MiB per file / 256 KiB
 * manifest) were sized for a small plugin; this repository carries thousands of
 * source files, so the caps are raised while still bounding any single
 * transaction.
 */
export const CAPS = {
  // A release of ~6000 source files with a manifest listing each path is a few
  // hundred KB; 4 MiB leaves headroom for notes and a large file list.
  MAX_MANIFEST_BYTES: 4 * 1024 * 1024,
  MAX_FILE_BYTES: 32 * 1024 * 1024,
  MAX_FILES: 20000,
  // Total staged/downloaded bytes for one transaction. The first clip release is
  // ~200 MB of deployable source (optional media is excluded), so 1 GiB refuses
  // a runaway tree without blocking a legitimate release.
  MAX_STAGE_BYTES: 1024 * 1024 * 1024,
  // Rollback copies the deployable release tree only (protected and optional
  // media prefixes are excluded). The cap refuses an unexpectedly large tree
  // instead of filling the data dir.
  MAX_BACKUP_BYTES: 1024 * 1024 * 1024,
}

/**
 * Deterministic JSON: sorted keys, no whitespace, `undefined` dropped (object
 * fields) or nulled (array slots) — the same rules JSON.stringify applies, plus
 * key order. Both signer and verifier reduce the manifest to this form, so the
 * signature is over meaning, not byte layout.
 */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(row => stableStringify(row ?? null)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).filter(key => value[key] !== undefined).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/** Reduce a manifest to exactly the fields a signature covers.
 *
 * `publishedAt` is canonicalized to epoch milliseconds: a manifest may carry it
 * as an ISO string (as published) or as the number `parseManifest` returns, and
 * both must reduce to the same signed bytes or a valid signature would verify
 * on one code path and fail on another. */
function signaturePayload(payload) {
  const source = payload !== null && typeof payload === 'object' ? payload : {}
  const picked = {}
  for (const key of SIGNED_FIELDS) if (source[key] !== undefined) picked[key] = source[key]
  if (typeof picked.publishedAt === 'string') {
    const ms = Date.parse(picked.publishedAt)
    picked.publishedAt = Number.isFinite(ms) ? ms : picked.publishedAt
  }
  return picked
}

/**
 * Sign one manifest's canonical form with an Ed25519 private key (PEM).
 * @param {object} payload - the manifest document (any superset of the signed fields)
 * @param {string|crypto.KeyObject} privateKey - PKCS8 PEM, or a loaded key
 * @returns {string} base64 signature to store as the manifest's `signature`
 */
export function signManifest(payload, privateKey) {
  const key = privateKey instanceof crypto.KeyObject ? privateKey : crypto.createPrivateKey(privateKey)
  return crypto.sign(null, Buffer.from(stableStringify(signaturePayload(payload))), key).toString('base64')
}

/**
 * Verify a manifest's `signature` against an Ed25519 public key (SPKI, base64).
 * Any malformed input answers `false` — a signature that cannot be checked is
 * a signature that is not there.
 */
export function verifyManifestSignature(payload, publicKeyBase64) {
  const signature = payload !== null && typeof payload === 'object' && typeof payload.signature === 'string'
    ? payload.signature
    : ''
  if (signature === '' || typeof publicKeyBase64 !== 'string' || publicKeyBase64 === '') return false
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' })
    return crypto.verify(null, Buffer.from(stableStringify(signaturePayload(payload))), key, Buffer.from(signature, 'base64'))
  } catch {
    return false
  }
}

/** Cache hint only: query strings cannot refresh jsDelivr's branch resolution. */
export function bustCdnCache(url, now = Date.now()) {
  try {
    const parsed = new URL(url)
    if (parsed.hostname.endsWith('.jsdelivr.net')) {
      parsed.searchParams.set('eac', Math.floor(now / 60_000).toString())
      return parsed.href
    }
  } catch { /* malformed URL: let fetch report it */ }
  return url
}

const SHA_RE = /^[0-9a-f]{64}$/
// Hot reload evaluates a fresh updater module before the old request finishes.
// A process-wide lock keeps the successor from starting a second transaction.
const UPGRADE_LOCKS = Symbol.for('eac-design-world.maintenance.upgrade-locks')
const upgradeLocks = globalThis[UPGRADE_LOCKS] ??= new Set()

/** Parse `1.2.3` / `1.2.3-rc.4` into a comparable tuple; `null` when malformed. */
export function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/.exec(String(value ?? '').trim())
  if (match === null) return null
  const pre = match[4] === undefined ? null : match[4].split('.')
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre }
}

/** -1 | 0 | 1 in semver precedence; a pre-release sorts before its release. */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return a === b ? 0 : a > b ? 1 : -1
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.pre === null && right.pre === null) return 0
  if (left.pre === null) return 1
  if (right.pre === null) return -1
  const width = Math.max(left.pre.length, right.pre.length)
  for (let i = 0; i < width; i += 1) {
    const x = left.pre[i]
    const y = right.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn && Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
    if (xn !== yn) return xn ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * Validate the manifest document.
 * @param {unknown} payload
 * @returns {object} {version, notes, publishedAt, base, files}
 * @throws {Error} with a reason the settings page can show
 */
export function parseManifest(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('manifest must be a JSON object')
  }
  const version = typeof payload.version === 'string' ? payload.version.trim() : ''
  if (parseVersion(version) === null) throw new Error(`manifest version "${version}" is not a valid semver`)
  const base = typeof payload.base === 'string' && payload.base !== '' ? payload.base : '../'
  // The base is resolved against the manifest's own URL, so it must stay
  // relative: an absolute or protocol-relative value would point every download
  // at a host of the manifest author's choosing, and the sha256 pins would ride
  // along inside the same forged document. A relative URL cannot leave the
  // origin it resolves against.
  if (/^[a-z][a-z0-9+.-]*:/i.test(base) || base.startsWith('//') || base.startsWith('/') || base.includes('\\')) {
    throw new Error(`manifest base "${base}" must be a path relative to the manifest`)
  }
  const rows = payload.files
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('manifest carries no file list')
  if (rows.length > CAPS.MAX_FILES) throw new Error(`manifest lists ${rows.length} files, above the ${CAPS.MAX_FILES} cap`)
  const files = []
  const seen = new Set()
  for (const row of rows) {
    const file = parseFileEntry(row)
    if (seen.has(file.path)) throw new Error(`manifest lists ${file.path} twice`)
    seen.add(file.path)
    files.push(file)
  }
  if (!seen.has('package.json')) throw new Error('manifest must include package.json')
  return {
    version,
    base,
    files,
    notes: typeof payload.notes === 'string' ? payload.notes.slice(0, 32 * 1024) : '',
    publishedAt: timestampOf(payload.publishedAt) ?? 0,
    ...typeof payload.minSupported === 'string' ? { minSupported: payload.minSupported } : {},
    ...typeof payload.signature === 'string' ? { signature: payload.signature } : {},
  }
}

function parseFileEntry(row) {
  const rel = typeof row?.path === 'string' ? row.path.trim() : ''
  const normalized = rel.replace(/\\/g, '/')
  if (normalized === '' || normalized.startsWith('/') || normalized.includes('../') || normalized.endsWith('..')
    || /[A-Za-z]:/.test(normalized) || normalized.split('/').includes('')) {
    throw new Error(`manifest file path "${rel}" is not a safe relative path`)
  }
  // A release may never claim an excluded path: those are local assets or
  // optional large media that must not be replaced on install nor deleted on
  // rollback.
  if (isExcludedPath(normalized)) {
    throw new Error(`manifest file path "${normalized}" is an excluded local/media path and cannot be part of a release`)
  }
  const sha256 = typeof row?.sha256 === 'string' ? row.sha256.toLowerCase() : ''
  if (!SHA_RE.test(sha256)) throw new Error(`manifest entry "${normalized}" has no valid sha256`)
  const size = row?.size
  // Zero-byte files are legitimate source (empty `__init__.py`, placeholder
  // files); only negative, non-integer or oversized values are refused. The
  // sha256 of an empty file is fixed and still verified.
  if (!Number.isInteger(size) || size < 0 || size > CAPS.MAX_FILE_BYTES) {
    throw new Error(`manifest entry "${normalized}" has an out-of-range size`)
  }
  return { path: normalized, sha256, size }
}

function timestampOf(value) {
  if (typeof value !== 'string' || value === '') return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

/** Resolve one manifest-relative path against the URL the manifest came from. */
export function fileUrlOf(manifestUrl, manifest, relativePath) {
  return new URL(manifest.base + relativePath.split('/').map(encodeURIComponent).join('/'), manifestUrl).href
}

/** Pin an official discovery URL without changing the signed manifest format.
 *  A resolution is reused across mirrors in this check, so a moving branch
 *  cannot select different snapshots when raw fails and the CDN takes over.
 *  Custom/local sources and already immutable SHA URLs retain their semantics.
 *  The resolver supplies a location, never authority to install its contents. */
async function snapshotManifestSource(source, fetchImpl, signal, revisions) {
  const url = new URL(source)
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return source
  const rawPrefix = `/${REPO}/`
  const cdnPrefix = `/gh/${REPO}@`
  const prefix = url.hostname === 'raw.githubusercontent.com' ? rawPrefix
    : url.hostname === 'cdn.jsdelivr.net' ? cdnPrefix : null
  if (prefix === null || !url.pathname.startsWith(prefix)) return source
  const match = /^([^/]+)\/feed\/manifest\.json$/.exec(url.pathname.slice(prefix.length))
  if (match === null) return source
  const ref = match[1]
  if (/^[a-f0-9]{40}$/.test(ref)) return source
  // Never insert arbitrary URL/path syntax in a resolver request.
  if (!/^[A-Za-z0-9._-]+$/.test(ref)) throw new Error('unsupported update source ref')
  let revision = revisions.get(ref)
  if (revision === undefined) {
    const response = await fetchImpl(`https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(ref)}`, {
      redirect: 'error', signal,
      // `application/vnd.github.sha` answers with the bare 40-character SHA. The
      // default JSON envelope carries the commit's full patch list, and a merge
      // that touched hundreds of files pushes that document past
      // MAX_MANIFEST_BYTES — for a payload whose only consumed field is `.sha`.
      headers: { accept: 'application/vnd.github.sha', 'user-agent': 'eac-design-world-updater' },
    })
    if (!response.ok) throw new Error(`snapshot resolution failed for ${ref}: HTTP ${response.status}`)
    const text = (await response.text()).trim()
    if (text.length > CAPS.MAX_MANIFEST_BYTES) throw new Error('snapshot resolution response too large')
    const sha = /^[a-f0-9]{40}$/.test(text) ? text : JSON.parse(text)?.sha
    if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) {
      throw new Error(`snapshot resolution did not return a full commit SHA for ${ref}`)
    }
    revision = sha
    revisions.set(ref, revision)
  }
  url.pathname = `${prefix}${revision}/feed/manifest.json`
  return url.href
}

/** Read a response body as a Buffer while refusing to exceed `maxBytes`. */
async function readBodyCapped(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`declared size ${declared} exceeds the ${maxBytes} cap`)
  if (response.body === null || response.body === undefined || typeof response.body.getReader !== 'function') {
    const body = Buffer.from(await response.arrayBuffer())
    if (body.length > maxBytes) throw new Error(`body size ${body.length} exceeds the ${maxBytes} cap`)
    return body
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new Error(`body size exceeds the ${maxBytes} cap`)
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock?.()
  }
  return Buffer.concat(chunks, total)
}

/** The message a remote application fails with when no trust root is present. */
export const NO_SIGNING_KEY_ERROR = 'no release signing key configured — remote updates are disabled until one is pinned'

/**
 * Fetch the first source that answers with a manifest this installation accepts.
 *
 * A source is only believed when its document carries a signature made with
 * `verifyKey` (see {@link verifyManifestSignature}): every mirror — the
 * repository's own raw URLs and third-party CDNs alike — is equally untrusted
 * as a *code* source, and equally usable once the manifest itself is the thing
 * being authenticated. With no `verifyKey`, no remote manifest is believed.
 *
 * @param {string[]} sources
 * @param {{timeoutMs?: number, fetchImpl?: typeof fetch, verifyKey?: string}} [options]
 * @returns {Promise<{manifest: object, source: string, signed: boolean}>}
 */
export async function downloadManifest(sources, { timeoutMs = 15000, fetchImpl = fetch, verifyKey = PINNED_MANIFEST_PUBLIC_KEY } = {}) {
  if (typeof verifyKey !== 'string' || verifyKey === '') throw new Error(NO_SIGNING_KEY_ERROR)
  const failures = []
  const revisions = new Map()
  for (const source of sources) {
    try {
      // One deadline covers resolution, manifest headers and body for this leg.
      const signal = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined
      const snapshot = await snapshotManifestSource(source, fetchImpl, signal, revisions)
      const response = await fetchImpl(bustCdnCache(snapshot), {
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal,
      })
      if (!response.ok) { failures.push(`${source} -> HTTP ${response.status}`); continue }
      const text = await readBodyCapped(response, CAPS.MAX_MANIFEST_BYTES)
      const manifest = parseManifest(JSON.parse(text.toString('utf8')))
      if (!verifyManifestSignature(manifest, verifyKey)) {
        failures.push(`${source} -> manifest signature missing or not made with the release key`)
        continue
      }
      return { manifest, source: snapshot, signed: true }
    } catch (error) {
      failures.push(`${source} -> ${error?.message ?? error}`)
    }
  }
  throw new Error(`no manifest source answered (${failures.join('; ')})`)
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/**
 * Download and hash-verify the whole release into `stageDir`.
 * @returns {Promise<{bytes: number, files: number}>}
 */
const STAGE_ATTEMPTS = 3
const STAGE_BACKOFF_MS = 700

/** A CN egress to the CDN drops connections regularly, and a one-shot staging
 * turned one flaky second into a whole failed upgrade ("fetch failed" on a
 * random file). Transport-class failures retry with a short backoff; integrity
 * failures (size/digest) never do — a wrong body is the trust chain refusing,
 * not a bad hair day. */
function isTransientDownloadError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return true
  return /fetch failed|network|ECONN|ETIMEDOUT|EAI_AGAIN|terminated|socket/i.test(String(error?.message ?? error))
}

/** jsDelivr's primary edge can redirect documentation files to raw, which is
 *  unavailable on some client networks. Try its gcore edge at the exact same
 *  SHA/path, never an arbitrary Location or a mutable branch. Size/hash checks
 *  remain outside the transport fallback and cannot authorize another body. */
function stagedFileSources(manifestUrl, manifest, relativePath) {
  const file = fileUrlOf(manifestUrl, manifest, relativePath)
  const url = new URL(file)
  const prefix = `/gh/${REPO}@`
  if (url.protocol !== 'https:' || url.hostname !== 'cdn.jsdelivr.net' || url.port
    || url.username || url.password || !url.pathname.startsWith(prefix)
    || !/^[a-f0-9]{40}\//.test(url.pathname.slice(prefix.length))) return [file]
  url.hostname = 'gcore.jsdelivr.net'
  return [file, url.href]
}

export async function stageRelease({ manifest, manifestUrl, stageDir, fetchImpl = fetch, concurrency = 4, onProgress = () => {}, timeoutMs = 30000 }) {
  fs.rmSync(stageDir, { recursive: true, force: true })
  fs.mkdirSync(stageDir, { recursive: true })
  let done = 0
  let bytes = 0
  let cursor = 0
  const failures = []
  const workers = Array.from({ length: Math.min(concurrency, manifest.files.length) }, async () => {
    while (cursor < manifest.files.length) {
      const file = manifest.files[cursor++]
      const target = path.join(stageDir, ...file.path.split('/'))
      const sources = stagedFileSources(manifestUrl, manifest, file.path)
      let lastError
      for (let attempt = 1; attempt <= STAGE_ATTEMPTS; attempt += 1) {
        try {
          const signal = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined
          let body
          for (let mirror = 0; mirror < sources.length; mirror++) {
            try {
              const response = await fetchImpl(bustCdnCache(sources[mirror]), { redirect: 'error', signal })
              if (!response.ok) throw new Error(`HTTP ${response.status}`)
              // A per-file cap keeps one oversized (or hostile) body from
              // exhausting memory; the manifest size is the authority, and the
              // read refuses anything larger before it is buffered whole.
              body = await readBodyCapped(response, Math.min(file.size, CAPS.MAX_FILE_BYTES) + 1)
              break
            } catch (error) {
              const status = /^HTTP (\d{3})$/.exec(String(error?.message ?? ''))?.[1]
              const canFallback = status ? /^(3\d\d|404|429|5\d\d)$/.test(status) : isTransientDownloadError(error)
              if (!canFallback || mirror === sources.length - 1 || signal?.aborted) throw error
            }
          }
          if (body.length !== file.size) throw new Error(`size ${body.length} != manifest ${file.size}`)
          const digest = crypto.createHash('sha256').update(body).digest('hex')
          if (digest !== file.sha256) throw new Error('sha256 mismatch')
          if (bytes + body.length > CAPS.MAX_STAGE_BYTES) {
            throw new Error(`release exceeds the ${CAPS.MAX_STAGE_BYTES} byte staging cap`)
          }
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.writeFileSync(target, body)
          done += 1
          bytes += body.length
          onProgress({ done, total: manifest.files.length, file: file.path })
          lastError = null
          break
        } catch (error) {
          lastError = error
          const httpStatus = /^HTTP (\d{3})$/.exec(String(error?.message ?? ''))?.[1]
          const retryable = httpStatus ? httpStatus === '429' || httpStatus.startsWith('5') : isTransientDownloadError(error)
          if (attempt >= STAGE_ATTEMPTS || !retryable) break
          await new Promise(resolve => setTimeout(resolve, STAGE_BACKOFF_MS * attempt))
        }
      }
      if (lastError) failures.push(`${file.path}: ${lastError?.message ?? lastError}`)
    }
  })
  await Promise.all(workers)
  if (failures.length > 0) {
    fs.rmSync(stageDir, { recursive: true, force: true })
    throw new Error(`staging failed: ${failures.join('; ')}`)
  }
  return { bytes, files: done }
}

/** The staged copy is checked against the manifest before install touches anything. */
export function verifyStaged(stageDir, manifest) {
  for (const file of manifest.files) {
    const target = path.join(stageDir, ...file.path.split('/'))
    let stat
    try { stat = fs.statSync(target) } catch { throw new Error(`staged file missing: ${file.path}`) }
    if (stat.size !== file.size) throw new Error(`staged size drift for ${file.path}`)
    if (sha256File(target) !== file.sha256) throw new Error(`staged hash drift for ${file.path}`)
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(stageDir, 'package.json'), 'utf8'))
  if (pkg.version !== manifest.version) throw new Error(`staged package.json says ${pkg.version}, manifest says ${manifest.version}`)
  verifyPackageIdentity(stageDir, manifest)
}

/**
 * Identity and minimum file set of an installable EAC release.
 *
 * A signed manifest proves the bytes came from whoever holds the release key;
 * it does not prove the bytes are *this* project. An installation that pins a
 * key shared with another project could otherwise install a foreign package.
 * These checks run after staging and after install, so a release that is not
 * EAC Design World — or that is missing a runtime entry point — is refused
 * before the swap commits.
 */
export const PACKAGE_IDENTITY = {
  name: 'eac-design-world',
  main: './plugin/host.mjs',
  requiredFiles: ['plugin/host.mjs', 'src/server.mjs', 'src/version.mjs', 'dist/index.html', 'package.json'],
}

/**
 * Verify a staged or installed package is EAC Design World and carries every
 * required runtime file.
 *
 * @param {string} dir - package directory (stage or install)
 * @param {object} [manifest] - optional manifest whose file list must also be
 *   present; when omitted the directory is walked
 * @throws {Error} when the identity or a required file does not match
 */
export function verifyPackageIdentity(dir, manifest) {
  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch (error) {
    throw new Error(`package.json unreadable in ${dir} (${error?.message ?? error})`)
  }
  if (pkg.name !== PACKAGE_IDENTITY.name) {
    throw new Error(`package is "${String(pkg.name)}", not ${PACKAGE_IDENTITY.name}; refusing to install a foreign package`)
  }
  if (pkg.main !== PACKAGE_IDENTITY.main) {
    throw new Error(`package main is "${String(pkg.main)}", expected ${PACKAGE_IDENTITY.main}`)
  }
  const present = manifest === undefined
    ? new Set(listPackageFiles(dir))
    : new Set(manifest.files.map(file => file.path))
  for (const rel of PACKAGE_IDENTITY.requiredFiles) {
    if (!present.has(rel) || !fs.existsSync(path.join(dir, ...rel.split('/')))) {
      throw new Error(`required runtime file missing from the release: ${rel}`)
    }
  }
  return pkg
}

/**
 * Path prefixes that must never be owned, backed up, replaced or deleted by an
 * update transaction. These are the local, user- or runtime-owned parts of an
 * EAC installation, not the deployable release:
 *
 * - `vendor/motion-web` and `vendor/onetake` are optional, user-provisioned
 *   noncommercial libraries (see THIRD_PARTY_NOTICES.md); they must survive
 *   updates untouched;
 * - `.eac`, `release`, `artifacts`, `runtime` hold local state, built output and
 *   media, which are large and machine-specific;
 * - `node_modules` and `.git` are never part of a release.
 *
 * Everything else — `vendor/open-design`, `vendor/mg-styles`, `vendor/eac-motion`,
 * `catalog`, `scripts`, `feed`, templates, `plugin`, `src`, `ui`, `dist`,
 * `locale` — is deployable content and DOES travel with a managed update.
 */
export const PROTECTED_PATH_PREFIXES = [
  '.git', 'node_modules', 'release', 'artifacts', 'runtime',
  'vendor/motion-web', 'vendor/onetake', '.eac',
]

/** Optional large media that is distributed as a separate archive, mirroring
 *  `scripts/build-release.py`'s `media_file` rule. It never travels with an
 *  in-app update: it is hundreds of MB, optional, and a user may have added or
 *  removed it locally, so an update must neither overwrite nor delete it.
 *
 *  - `public/media/` and `dist/media/` hold bundled video;
 *  - `vendor/mg-styles-15/videos/` holds the style demos;
 *  - under `vendor/mg-styles-15/`, the font/audio/3-D extensions and the
 *    `assets/`+`demos/` raster images are optional media.
 *
 *  Style scripts, HTML templates and `.webp` covers stay deployable. */
export const OPTIONAL_MEDIA_EXTENSIONS = ['.ttf', '.flac', '.wav', '.ply', '.hdr']

export function isOptionalMediaPath(rel) {
  const normalized = String(rel).replace(/\\/g, '/')
  if (normalized.startsWith('public/media/') || normalized.startsWith('dist/media/')) return true
  // Showcase films are README-only assets played straight from GitHub; they are
  // far above the per-file manifest cap and no runtime path reads them.
  if (normalized.startsWith('docs/assets/showcase/')) return true
  if (normalized.startsWith('vendor/mg-styles-15/videos/')) return true
  if (!normalized.startsWith('vendor/mg-styles-15/')) return false
  const lower = normalized.toLowerCase()
  if (OPTIONAL_MEDIA_EXTENSIONS.some(ext => lower.endsWith(ext))) return true
  if ((lower.endsWith('.png') || lower.endsWith('.jpg'))
    && (normalized.startsWith('vendor/mg-styles-15/assets/') || normalized.startsWith('vendor/mg-styles-15/demos/'))) return true
  return false
}

/** Files excluded from the release for licensing reasons, mirroring
 *  `scripts/build-release.py`'s `EXCLUDED` + `FONT_EXCLUDES`. They exist in a
 *  developer's working tree but never in a prepared release, so an update must
 *  not treat them as "dropped by the release" and delete them. */
export const LICENSE_EXCLUDED_PATHS = [
  'vendor/motion-promo-film/templates/lib/motion.js',
  'vendor/motion-promo-film/templates/film-template-plus.html',
  'vendor/open-design/templates/prompts/image/profile-avatar-seedream-high-fashion-dreamy-portrait.json',
  'vendor/open-design/templates/prompts/image-assets/profile-avatar-seedream-high-fashion-dreamy-portrait.jpg',
  'vendor/open-design/templates/prompts/image/social-media-post-seedream-squishcraft-kids-clay-ad.json',
  'vendor/open-design/templates/prompts/image-assets/social-media-post-seedream-squishcraft-kids-clay-ad.jpg',
]

/** Prefixes excluded for licensing reasons (upstream font directories). */
export const LICENSE_EXCLUDED_PREFIXES = [
  'vendor/mg-styles-15/assets/fonts/cjk/alibabapuhuiti3/',
  'vendor/mg-styles-15/assets/fonts/cjk/alimamashuheiti/',
]

/** True when a package-relative path must not be part of an update. */
export function isExcludedPath(rel) {
  const normalized = String(rel).replace(/\\/g, '/')
  // The release manifest and its signature live beside the feed; hashing the
  // manifest into itself is impossible, so it is never part of a release.
  if (normalized === 'feed/manifest.json' || normalized === 'feed/release-manifest.json') return true
  if (LICENSE_EXCLUDED_PATHS.includes(normalized)) return true
  if (LICENSE_EXCLUDED_PREFIXES.some(prefix => normalized.startsWith(prefix))) return true
  return isProtectedPath(normalized) || isOptionalMediaPath(normalized)
}

/** True when a package-relative path is inside a protected prefix or a dot dir. */
export function isProtectedPath(rel) {
  const normalized = String(rel).replace(/\\/g, '/')
  for (const segment of normalized.split('/')) {
    if (segment !== '' && segment.startsWith('.')) return true
  }
  return PROTECTED_PATH_PREFIXES.some(prefix =>
    normalized === prefix || normalized.startsWith(`${prefix}/`))
}

/**
 * Walk a directory into relative file paths, skipping release scratch files and
 * every excluded path (protected prefixes and optional large media). The same
 * rule bounds the manifest (parseManifest refuses excluded paths), the backup
 * and the install swap, so a manifest can never claim — or delete — local EAC
 * assets or optional media.
 *
 * A symlink or junction anywhere below the root that is not itself an excluded
 * path is refused loudly: silently skipping it would hide a write-escape from
 * both the backup and the recovery sweep, so the walk throws instead.
 */
export function listPackageFiles(dir) {
  const out = []
  const visit = (current, rel) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.endsWith('.eac-new') || entry.name.endsWith('.eac-old')) continue
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      const child = path.join(current, entry.name)
      // An excluded path may legitimately be a junction (a user's linked local
      // library); it is outside the managed set, so it is skipped, not refused.
      if (isExcludedPath(childRel)) continue
      const link = fs.lstatSync(child).isSymbolicLink()
      if (link) throw new Error(`refusing to manage a package containing a symlink or junction: ${childRel}`)
      if (entry.isDirectory()) visit(child, childRel)
      else if (entry.isFile()) out.push(childRel)
    }
  }
  if (fs.existsSync(dir)) visit(dir, '')
  return out
}

/**
 * Copy the current package aside so a failed swap can be undone.
 *
 * The deployable file set excludes protected prefixes (local media, optional
 * vendor libraries, node_modules), so this is the release tree only. A size cap
 * refuses to copy an unexpectedly large tree rather than silently filling the
 * data directory.
 *
 * @param {string} pkgDir
 * @param {string} backupDir
 * @param {{only?: string[], owned?: Iterable<string>, installed?: string[], maxBytes?: number}} [options] - `only` backs up
 *   exactly those package-relative files instead of the whole deployable set;
 *   `maxBytes` (default {@link CAPS.MAX_BACKUP_BYTES}) refuses an oversized copy.
 * @returns {number} files backed up
 */
export function backupPackage(pkgDir, backupDir, { only, owned, installed, maxBytes = CAPS.MAX_BACKUP_BYTES } = {}) {
  const all = listPackageFiles(pkgDir).sort()
  const wanted = Array.isArray(only) && only.length > 0
    ? all.filter(rel => only.includes(rel))
    : all
  const totalBytes = wanted.reduce((sum, rel) => sum + fs.statSync(path.join(pkgDir, ...rel.split('/'))).size, 0)
  if (Number.isFinite(maxBytes) && totalBytes > maxBytes) {
    throw new Error(`rollback copy would be ${totalBytes} bytes, above the ${maxBytes} cap; use a prepared release directory or raise maxBytes`)
  }
  const snapshot = packageSnapshot(pkgDir, wanted)
  const pending = `${backupDir}.pending-${crypto.randomUUID()}`
  const previous = `${backupDir}.previous-${crypto.randomUUID()}`
  let movedPrevious = false
  try {
    fs.mkdirSync(pending, { recursive: true })
    for (const file of snapshot.files) {
      const target = path.join(pending, ...file.path.split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(path.join(pkgDir, ...file.path.split('/')), target)
    }
    verifySnapshot(pending, snapshot)
    // Detect edits during backup too: the copy must describe the preimage
    // that is actually about to be replaced.
    verifySnapshot(pkgDir, snapshot)
    // `preimage` records the complete deployable file set at backup time, so a
    // later restore knows exactly which installed files a release legitimately
    // dropped rather than deleting everything it cannot find in the copy.
    fs.writeFileSync(path.join(pending, '.eac-backup.json'), JSON.stringify({
      ...snapshot, preimage: all, ...(owned === undefined ? {} : { owned: [...owned].sort() }),
      ...(installed === undefined ? {} : { installed: [...installed].sort() }),
    }))
    if (fs.existsSync(backupDir)) {
      fs.renameSync(backupDir, previous)
      movedPrevious = true
    }
    try {
      fs.renameSync(pending, backupDir)
    } catch (error) {
      if (movedPrevious) fs.renameSync(previous, backupDir)
      throw error
    }
    // Failure to clean an older copy does not invalidate the new verified copy.
    if (movedPrevious) {
      try { fs.rmSync(previous, { recursive: true, force: true }) } catch { /* retain it */ }
    }
    return snapshot.files.length
  } finally {
    try { fs.rmSync(pending, { recursive: true, force: true }) } catch { /* retain it */ }
  }
}

function packageSnapshot(dir, wanted) {
  const list = Array.isArray(wanted) ? wanted : listPackageFiles(dir)
  const files = list.sort().map(rel => {
    const file = path.join(dir, ...rel.split('/'))
    return { path: rel, size: fs.statSync(file).size, sha256: sha256File(file) }
  })
  // A complete rollback copy must contain the runtime entry point and the
  // manifest of record. `index.js` is legacy and no longer required: EAC's
  // entry is plugin/host.mjs (see PACKAGE_IDENTITY).
  if (!files.some(file => file.path === 'package.json') || !files.some(file => file.path === PACKAGE_IDENTITY.main.replace(/^\.\//, ''))) {
    throw new Error(`no complete rollback copy in ${dir} — package.json and ${PACKAGE_IDENTITY.main} are required`)
  }
  return { files }
}

function verifySnapshot(dir, snapshot, { allowExtra = false } = {}) {
  const paths = listPackageFiles(dir).sort()
  const expected = snapshot.files.map(file => file.path).sort()
  const actual = new Set(paths)
  if (allowExtra ? expected.some(file => !actual.has(file)) : paths.join('\n') !== expected.join('\n')) {
    throw new Error('rollback file set mismatch')
  }
  for (const file of snapshot.files) {
    const target = path.join(dir, ...file.path.split('/'))
    if (fs.statSync(target).size !== file.size || sha256File(target) !== file.sha256) {
      throw new Error(`rollback hash drift for ${file.path}`)
    }
  }
}

function backupSnapshot(backupDir) {
  if (listPackageFiles(backupDir).length === 0) {
    throw new Error(`no rollback copy in ${backupDir} — leaving the installed package untouched`)
  }
  const metadata = path.join(backupDir, '.eac-backup.json')
  // Older releases did not leave a receipt. Keep their complete backups usable.
  if (!fs.existsSync(metadata)) return { ...packageSnapshot(backupDir), preimage: listPackageFiles(backupDir).sort() }
  const snapshot = JSON.parse(fs.readFileSync(metadata, 'utf8'))
  if (!Array.isArray(snapshot?.files) || snapshot.files.length === 0
    || snapshot.files.some(file => file === null || typeof file !== 'object')
    || !snapshot.files.some(file => file.path === 'package.json')
    || !snapshot.files.some(file => file.path === PACKAGE_IDENTITY.main.replace(/^\.\//, ''))
    || snapshot.files.some(file => typeof file.path !== 'string' || file.path.startsWith('/')
      || file.path.includes('\\') || file.path.split('/').some(part => part === '' || part === '.' || part === '..')
      || /:/.test(file.path) || !SHA_RE.test(file.sha256) || !Number.isInteger(file.size) || file.size < 0)
    || new Set(snapshot.files.map(file => file.path)).size !== snapshot.files.length) {
    throw new Error('invalid rollback receipt')
  }
  // `preimage` is the full deployable file set at backup time; restore uses it to
  // decide which files a release legitimately dropped. Without it (legacy
  // receipts) the backed-up set is the whole preimage.
  if (snapshot.preimage !== undefined
    && (!Array.isArray(snapshot.preimage) || snapshot.preimage.some(p => typeof p !== 'string'))) {
    throw new Error('invalid rollback receipt')
  }
  for (const field of ['owned', 'installed']) {
    if (snapshot[field] !== undefined && (!Array.isArray(snapshot[field])
      || snapshot[field].some(p => typeof p !== 'string' || isExcludedPath(p)
        || p.includes('\\') || p.startsWith('/') || /:/.test(p)
        || p.split('/').some(part => part === '' || part === '.' || part === '..')))) {
      throw new Error('invalid rollback ownership receipt')
    }
  }
  verifySnapshot(backupDir, snapshot)
  return { ...snapshot, preimage: snapshot.preimage ?? snapshot.files.map(file => file.path) }
}

/** Put a backed-up copy back in place (used when a swap or reload fails). */
export function restoreBackup(backupDir, pkgDir) {
  // Never let a missing rollback copy turn into a wipe: listPackageFiles
  // answers [] for a directory that does not exist, and an install that has
  // never applied an update has no rollback copy at all — walking into the
  // delete loop with nothing to put back would empty the package while the
  // running process keeps going from memory.
  const snapshot = backupSnapshot(backupDir)
  const backup = snapshot.files.map(file => file.path)
  const preimage = new Set(snapshot.preimage ?? backup)
  const installed = new Set(snapshot.installed ?? [])
  assertRealRoot(pkgDir)
  const failures = []
  for (const rel of backup) {
    // Copy loop must survive a locked file: attempting every entry keeps the
    // restore as complete as this machine allows instead of crashing halfway.
    try {
      // A junction inside the package must not redirect a restore outside it.
      assertNoSymlinkBelow(pkgDir, rel.split('/'))
      const target = path.join(pkgDir, ...rel.split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(path.join(backupDir, ...rel.split('/')), target)
    } catch (error) { failures.push(`${rel} (${error?.message ?? error})`) }
  }
  // Restore first. Deleting every installed file before copying made a denied
  // copy destroy files that could otherwise still have been used for recovery.
  // Only remove files the update explicitly installed. A legacy backup without
  // this receipt cannot authorize deleting additions made after the snapshot.
  try {
    for (const rel of listPackageFiles(pkgDir)) {
      if (preimage.has(rel) || !installed.has(rel)) continue
      try {
        assertNoSymlinkBelow(pkgDir, rel.split('/'))
        fs.rmSync(path.join(pkgDir, ...rel.split('/')), { force: true })
      } catch (error) { failures.push(`${rel} (${error?.message ?? error})`) }
    }
    verifySnapshot(pkgDir, snapshot, { allowExtra: true })
  } catch (error) { failures.push(String(error?.message ?? error)) }
  if (failures.length > 0) throw new Error(`rollback incomplete: ${failures.slice(0, 3).join('; ')}${failures.length > 3 ? ` +${failures.length - 3} more` : ''}`)
}

/** Windows can transiently refuse a rename while a file is scanned; retry briefly. */
async function renameWithRetry(from, to) {
  let delay = 60
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to)
      return
    } catch (error) {
      if (attempt >= 4 || !['EPERM', 'EACCES', 'ENOENT'].includes(error?.code)) throw error
      await new Promise(resolve => setTimeout(resolve, delay))
      delay *= 4
    }
  }
}

/**
 * Refuse to read or write through a symlink/junction below `rootDir`.
 *
 * `rootDir` itself is exempt: a user may install the plugin at a path reached
 * through a junction, and that is their own choice. Every component *below* the
 * root, however, must be a real directory or file — a junction planted inside
 * the package (`pkg/sub -> D:/outside`) would otherwise let an install write
 * outside the package, and a manifest listing `sub/evil.js` would do so
 * invisibly. Components that do not exist yet are fine (their parent was
 * checked); the first missing segment ends the walk.
 *
 * @param {string} rootDir - trusted root (its own symlink status is ignored)
 * @param {string[]} segments - path components below the root
 * @throws {Error} when any existing component is a symlink
 */
export function assertNoSymlinkBelow(rootDir, segments) {
  let current = rootDir
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    current = path.join(current, segment)
    let stat
    try { stat = fs.lstatSync(current) } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error(`refusing to traverse a symlink or junction: ${current}`)
  }
}

/** Guard a stage/pkg directory root itself against being a symlink. */
function assertRealRoot(dir) {
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`directory must not be a symlink: ${dir}`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

/**
 * Move a verified staging directory into the installed package location.
 * Every file goes through a same-directory `<name>.eac-new` so the final
 * hop is a same-volume rename; the running module graph is unaffected.
 *
 * Both sides of every hop are guarded against symlink traversal: the source
 * component below the stage root and the target component below the package
 * root are checked with `lstat` before any write, so a junction planted inside
 * either tree cannot redirect a file outside it.
 *
 * Files the new release dropped are pruned ONLY when the previous installation
 * owned them (recorded in the ownership receipt, passed as `previousOwned`).
 * Files an installation has never owned — a user's own additions — are left in
 * place; an update must not silently delete them.
 *
 * @param {string} stageDir
 * @param {string} pkgDir
 * @param {string[]} files - manifest file paths to install
 * @param {{previousOwned?: string[]}} [options]
 * @returns {{installed: string[], pruned: string[]}}
 */
export async function installStaged(stageDir, pkgDir, files, { previousOwned } = {}) {
  assertRealRoot(stageDir)
  assertRealRoot(pkgDir)
  const owned = new Set(Array.isArray(previousOwned) ? previousOwned : [])
  for (const rel of files) {
    const parts = rel.split('/')
    // Refuse a symlinked component on either side before writing anything.
    assertNoSymlinkBelow(stageDir, parts)
    assertNoSymlinkBelow(pkgDir, parts)
    const source = path.join(stageDir, ...parts)
    const target = path.join(pkgDir, ...parts)
    const pending = `${target}.eac-new`
    // The scratch file itself can be a pre-planted symlink: `copyFileSync` would
    // follow it and write outside the package. Guard the pending path, then
    // clear a stale scratch entry only if it is a real file, and write with `wx`
    // so the write cannot follow or silently overwrite an existing entry.
    assertNoSymlinkBelow(pkgDir, [...parts.slice(0, -1), `${parts[parts.length - 1]}.eac-new`])
    fs.mkdirSync(path.dirname(target), { recursive: true })
    try {
      if (fs.lstatSync(pending).isSymbolicLink()) throw new Error(`refusing to write through a scratch symlink: ${pending}`)
      fs.rmSync(pending, { force: true })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    fs.writeFileSync(pending, fs.readFileSync(source), { flag: 'wx' })
    await renameWithRetry(pending, target)
  }
  // Prune only files this installation previously owned and the release dropped.
  // Unknown files (user additions) and never-owned files are preserved.
  const pruned = []
  for (const rel of listPackageFiles(pkgDir)) {
    if (files.includes(rel)) continue
    if (!owned.has(rel)) continue
    assertNoSymlinkBelow(pkgDir, rel.split('/'))
    fs.rmSync(path.join(pkgDir, ...rel.split('/')), { force: true })
    pruned.push(rel)
  }
  return { installed: [...files], pruned }
}

/** Read back everything that was just written; one drifted byte aborts the swap. */
export function verifyInstalled(pkgDir, manifest) {
  for (const file of manifest.files) {
    const target = path.join(pkgDir, ...file.path.split('/'))
    if (!fs.existsSync(target)) throw new Error(`installed file missing: ${file.path}`)
    if (sha256File(target) !== file.sha256) throw new Error(`installed hash drift for ${file.path}`)
  }
  verifyPackageIdentity(pkgDir, manifest)
}

/** Resolve the directory holding a local release's files from its manifest.
 *
 * `manifest.base` is validated by {@link parseManifest} to be a relative path
 * (no scheme, no leading slash, no backslash), so joining it to the manifest's
 * own directory cannot leave that directory. The result must exist, be a
 * directory, and contain no symlink component between the manifest directory and
 * the root: a manifest may not redirect its own file reads through a link.
 *
 * @param {string} manifestFile - absolute path to the manifest
 * @param {string} base - the manifest's `base` (e.g. `../`, `./`, `./files/`)
 * @returns {string} absolute package root
 */
function resolveLocalPackageRoot(manifestFile, base) {
  const manifestDir = path.dirname(manifestFile)
  // The builder's conventional feed/manifest.json refers to its package root.
  // Keep other parent-directory redirects forbidden.
  const conventionalFeed = path.basename(manifestFile) === 'manifest.json'
    && path.basename(manifestDir) === 'feed' && base === '../'
  if (conventionalFeed) assertRealRoot(manifestDir)
  const boundary = conventionalFeed ? path.dirname(manifestDir) : manifestDir
  const root = path.resolve(manifestDir, base)
  const relative = path.relative(boundary, root)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`manifest base "${base}" escapes the manifest directory`)
  }
  // Walk each component and refuse a symlinked step.
  let current = boundary
  for (const segment of relative.split(/[\\/]+/).filter(Boolean)) {
    current = path.join(current, segment)
    if (!fs.existsSync(current)) throw new Error(`local package directory does not exist: ${current}`)
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`local package path crosses a symlink: ${current}`)
  }
  if (!fs.statSync(root).isDirectory()) throw new Error(`local package root is not a directory: ${root}`)
  return root
}

/**
 * The upgrade lifecycle. The optional activate callback lets the Host include
 * hot reload in the transaction; standalone release audits only install files.
 */
export class MaintenanceUpdater {
  /**
   * @param {object} deps
   * @param {string} deps.pkgDir - installed package directory
   * @param {string} deps.dataDir - plugin data dir (staging, backup, history)
   * @param {() => {updateCheckHours?: number}} deps.settings
   * @param {(message: string) => void} [deps.log]
   * @param {typeof fetch} [deps.fetchImpl]
   * @param {string|null} [deps.manifestPublicKey] - SPKI base64; null (default)
   *   refuses remote application, tests substitute a throwaway keypair here
   * @param {string} [deps.runningVersion] - version captured by the running module
   */
  constructor({ pkgDir, dataDir, settings, log = () => {}, fetchImpl = fetch, defaultSources = DEFAULT_MANIFEST_SOURCES, manifestPublicKey = PINNED_MANIFEST_PUBLIC_KEY, runningVersion }) {
    this.deps = { pkgDir, dataDir, settings, log, fetchImpl, defaultSources, manifestPublicKey, runningVersion }
    this.latest = undefined
    this.checkedAt = 0
    this.error = ''
    this.applying = false
    this.history = this.loadHistory()
  }

  get stageDir() { return path.join(this.deps.dataDir, 'upgrade-stage') }
  get backupDir() { return path.join(this.deps.dataDir, 'rollback') }
  get stateFile() { return path.join(this.deps.dataDir, 'upgrade-state.json') }
  get ownedFile() { return path.join(this.deps.dataDir, 'owned-files.json') }

  /**
   * Read the ownership receipt: the file paths this installation last installed.
   *
   * The receipt is what lets an update prune files the new release dropped
   * without deleting a user's own additions. A fresh install has none, and a
   * first managed update prunes nothing (unknown files are preserved).
   *
   * @returns {Set<string>}
   */
  loadOwnedFiles() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.ownedFile, 'utf8'))
      return new Set(Array.isArray(parsed?.owned) ? parsed.owned.filter(rel => typeof rel === 'string') : [])
    } catch {
      return new Set()
    }
  }

  /** Persist the ownership receipt atomically. */
  saveOwnedFiles(owned) {
    try {
      fs.mkdirSync(this.deps.dataDir, { recursive: true })
      const pending = `${this.ownedFile}.tmp`
      fs.writeFileSync(pending, JSON.stringify({ owned: [...owned].sort() }), { mode: 0o600 })
      fs.renameSync(pending, this.ownedFile)
    } catch (error) {
      this.deps.log?.(`eac-design-world: could not write the ownership receipt (${error?.message ?? error})`)
    }
  }

  loadUpgradeState() {
    try {
      const state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
      if (state === null || !['installing', 'activating', 'recovery-required', 'rolled-back', 'complete'].includes(state.phase)) {
        throw new Error('invalid transaction phase')
      }
      return state
    }
    catch (error) {
      if (error?.code === 'ENOENT') return undefined
      return { phase: 'recovery-required', error: `could not read upgrade state (${error?.message ?? error})` }
    }
  }

  saveUpgradeState(state) {
    fs.mkdirSync(this.deps.dataDir, { recursive: true })
    const pending = `${this.stateFile}.tmp`
    fs.writeFileSync(pending, JSON.stringify(state), { mode: 0o600 })
    fs.renameSync(pending, this.stateFile)
  }

  reconcileRecovery() {
    const state = this.loadUpgradeState()
    if (upgradeLocks.has(this.deps.pkgDir) || !['installing', 'activating', 'recovery-required'].includes(state?.phase)) return
    try {
      verifySnapshot(this.deps.pkgDir, backupSnapshot(this.backupDir))
      if ((this.deps.runningVersion ?? this.currentVersion()) !== state.from) return
      this.saveUpgradeState({ ...state, phase: 'rolled-back', error: '', diskRestored: true, runtimeRestored: true })
    } catch { /* keep the blocker until both the bytes and runtime match */ }
  }

  currentVersion() {
    try {
      return String(JSON.parse(fs.readFileSync(path.join(this.deps.pkgDir, 'package.json'), 'utf8')).version ?? '')
    } catch {
      return ''
    }
  }

  loadHistory() {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(this.deps.dataDir, 'updates.json'), 'utf8'))
      return Array.isArray(parsed?.applied) ? parsed.applied : []
    } catch {
      return []
    }
  }

  recordHistory(entry) {
    // A hot reload creates a successor before the caller finishes. Merge with
    // durable history, and let both instances read the final outcome.
    this.history = [...this.loadHistory(), entry].slice(-20)
    try {
      fs.mkdirSync(this.deps.dataDir, { recursive: true })
      fs.writeFileSync(path.join(this.deps.dataDir, 'updates.json'), JSON.stringify({ applied: this.history }, undefined, 2))
    } catch (error) {
      this.deps.log?.(`eac-design-world: could not write update history (${error?.message ?? error})`)
    }
  }

  /** True when this installation has a trust root for remote updates. */
  get remoteEnabled() {
    return typeof this.deps.manifestPublicKey === 'string' && this.deps.manifestPublicKey !== ''
  }

  status() {
    const installedVersion = this.currentVersion()
    const current = this.deps.runningVersion ?? installedVersion
    const state = this.loadUpgradeState()
    const active = upgradeLocks.has(this.deps.pkgDir)
    const unfinished = ['installing', 'activating'].includes(state?.phase)
    const recoveryRequired = state?.phase === 'recovery-required' || (unfinished && !active)
    const available = this.latest !== undefined && compareVersions(this.latest.version, current) > 0
    this.history = this.loadHistory()
    return {
      current,
      runningVersion: current,
      installedVersion,
      versionMismatch: current !== installedVersion,
      recoveryRequired,
      phase: state?.phase ?? 'idle',
      latest: this.latest?.version ?? '',
      available,
      notes: this.latest?.notes ?? '',
      publishedAt: this.latest?.publishedAt ?? 0,
      checkedAt: this.checkedAt,
      applying: active,
      error: state?.error || this.error,
      remoteEnabled: this.remoteEnabled,
      rollbackAvailable: this.rollbackAvailable(),
      recoveryBackup: recoveryRequired ? this.backupDir : undefined,
      lastApplied: this.history[this.history.length - 1] ?? undefined,
    }
  }

  /**
   * True when a verified rollback copy exists on disk for this installation.
   *
   * `status()` is polled by the UI every few seconds, so this must not hash the
   * whole (multi-thousand-file, ~200 MB) backup on every call. The receipt's
   * own mtime+size is used as a cheap validity hint and cached; a full hash
   * verification still runs inside {@link restoreBackup} when a rollback is
   * actually performed. The cache is invalidated whenever a transaction writes
   * a new receipt (apply, rollback).
   */
  rollbackAvailable() {
    const receipt = path.join(this.backupDir, '.eac-backup.json')
    let stat
    try { stat = fs.statSync(receipt) } catch { this._rollbackCache = undefined; return false }
    const stamp = `${stat.mtimeMs}:${stat.size}`
    if (this._rollbackCache?.stamp === stamp) return this._rollbackCache.ok
    let ok = true
    try { backupSnapshot(this.backupDir) } catch { ok = false }
    this._rollbackCache = { stamp, ok }
    return ok
  }

  /** Drop the rollback-availability cache after any transaction touches the receipt. */
  invalidateRollbackCache() {
    this._rollbackCache = undefined
  }

  /** Manifest sources. Deliberately immune to the `feedUrl` setting: an update
   *  source is a code source, and a settings value pointing it anywhere else is
   *  the one-step path from "wrote a config field" to "executed arbitrary code
   *  in the host process". Announcements may be mirrored by their user; the
   *  update channel may not. */
  sources() {
    return this.deps.defaultSources
  }

  /**
   * Fetch and evaluate the latest manifest.
   * @returns {Promise<{available: boolean, current: string, latest: string}>}
   * @throws {Error} when no trust root is configured or no source answers
   */
  async check() {
    try {
      this.reconcileRecovery()
      const { manifest, source } = await downloadManifest(this.sources(), { fetchImpl: this.deps.fetchImpl, verifyKey: this.deps.manifestPublicKey })
      const current = this.deps.runningVersion ?? this.currentVersion()
      if (manifest.minSupported !== undefined && current !== '' && compareVersions(current, manifest.minSupported) < 0) {
        throw new Error(`update path requires at least ${manifest.minSupported}; ${current} is installed`)
      }
      this.latest = manifest
      this.manifestUrl = source
      this.checkedAt = Date.now()
      this.error = ''
      this.deps.log?.(`eac-design-world: update check via ${source} -> ${manifest.version} (installed ${current})`)
      return { available: compareVersions(manifest.version, current) > 0, current, latest: manifest.version }
    } catch (error) {
      this.error = String(error?.message ?? error)
      throw error
    }
  }

  /**
   * Download, verify and install one manifest. Idempotent for the same version.
   * @param {{version?: string, onProgress?: (progress: object) => void, activate?: (result: object) => Promise<object>}} [options]
   * @returns {Promise<{version: string, files: number, bytes: number, previous: string}>}
   */
  async apply({ version, onProgress = () => {}, activate } = {}) {
    if (upgradeLocks.has(this.deps.pkgDir)) throw new Error('an upgrade is already running')
    this.reconcileRecovery()
    const priorState = this.loadUpgradeState()
    if (['installing', 'activating', 'recovery-required'].includes(priorState?.phase)) {
      throw new Error(`previous upgrade requires recovery; restore the verified backup in ${this.backupDir} and restart before upgrading again`)
    }
    this.applying = true
    upgradeLocks.add(this.deps.pkgDir)
    const previous = this.currentVersion()
    let targetVersion = version ?? ''
    let state
    let installed = false
    let activated = false
    try {
      // Re-check immediately before installing: the owner may have pushed a new
      // manifest since the last check, and a stale cached manifest would verify
      // downloads against hashes the repository no longer stands behind.
      await this.check()
      const manifest = this.latest
      if (manifest === undefined) throw new Error('no manifest available')
      targetVersion = manifest.version
      if (version !== undefined && manifest.version !== version) throw new Error(`manifest offers ${manifest.version}, not ${version}`)
      if (compareVersions(manifest.version, previous) < 0) throw new Error(`installed ${previous} is newer than ${manifest.version}`)
      if (manifest.minSupported !== undefined && compareVersions(previous, manifest.minSupported) < 0) {
        throw new Error(`update path requires at least ${manifest.minSupported}; ${previous} is installed`)
      }

      onProgress({ phase: 'download' })
      // `check` above only accepts signed manifests, but this guard is cheap and
      // keeps `apply` honest on its own: a manifest that cannot be attributed to
      // the release key must not reach the file swap, whatever path delivered it.
      if (manifest.signature === undefined || !verifyManifestSignature(manifest, this.deps.manifestPublicKey)) {
        throw new Error('the manifest is not signed with the pinned release key')
      }
      const staged = await stageRelease({
        manifest, manifestUrl: this.manifestUrl ?? this.sources()[0], stageDir: this.stageDir,
        fetchImpl: this.deps.fetchImpl, onProgress,
      })
      verifyStaged(this.stageDir, manifest)

      onProgress({ phase: 'install' })
      const previousOwned = this.loadOwnedFiles()
      const backedUp = backupPackage(this.deps.pkgDir, this.backupDir, { owned: previousOwned, installed: manifest.files.map(file => file.path) })
      // The receipt names the files the PREVIOUS install owned; only those may
      // be pruned when the new release drops them. A first managed update has an
      // empty receipt and therefore prunes nothing.
      state = { from: previous, to: manifest.version, at: Date.now(), phase: 'installing' }
      // Persist the intent before the first installed byte changes.
      this.saveUpgradeState(state)
      const result = { version: manifest.version, previous, files: manifest.files.length, bytes: staged.bytes, signed: true }
      try {
        installed = true
        const applied = await installStaged(this.stageDir, this.deps.pkgDir, manifest.files.map(file => file.path), { previousOwned: [...previousOwned] })
        verifyInstalled(this.deps.pkgDir, manifest)
        this.saveOwnedFiles(new Set(manifest.files.map(file => file.path)))
        if (activate !== undefined) {
          state = { ...state, phase: 'activating' }
          this.saveUpgradeState(state)
          onProgress({ phase: 'reload' })
          const activation = await activate(result)
          if (activation?.ok !== true) {
            throw Object.assign(new Error(activation?.error ?? 'hot reload did not confirm activation'), { runtimeRestored: activation?.restored === true })
          }
          if (activation.version !== manifest.version) {
            throw new Error(`activation version mismatch: expected ${manifest.version}, got ${String(activation.version ?? '(missing)')}`)
          }
          activated = true
        }
      } catch (error) {
        // The installed copy is now in an unknown state: put the old one back
        // before surfacing the failure, so the next boot still works. A failed
        // restore must not mask the install failure that caused it, and the
        // "previous version restored" claim is only true when it succeeded.
        let restoreError = null
        try {
          restoreBackup(this.backupDir, this.deps.pkgDir)
          // The receipt was advanced to the failed release before activation;
          // put the previous managed set back so a later update does not prune
          // against the wrong ownership.
          this.saveOwnedFiles(previousOwned)
        } catch (rollbackError) { restoreError = rollbackError }
        state = {
          ...state,
          phase: restoreError !== null || (state.phase === 'activating' && error.runtimeRestored !== true) ? 'recovery-required' : 'rolled-back',
          diskRestored: restoreError === null,
          runtimeRestored: state.phase !== 'activating' || error.runtimeRestored === true,
        }
        if (restoreError !== null) {
          throw new Error(`upgrade failed (${error?.message ?? error}); rollback also failed (${restoreError?.message ?? restoreError})`)
        }
        throw new Error(`upgrade failed, previous files restored (${error?.message ?? error})`)
      }
      this.saveUpgradeState({ ...state, phase: 'complete', activated })
      try { fs.rmSync(this.stageDir, { recursive: true, force: true }) } catch (error) { this.deps.log?.(`eac-design-world: staging cleanup failed (${error?.message ?? error})`) }
      const record = { from: previous, to: manifest.version, at: Date.now(), ok: true, files: manifest.files.length, bytes: staged.bytes, backedUp, activated }
      this.recordHistory(record)
      this.checkedAt = Date.now()
      this.deps.log?.(`eac-design-world: upgraded ${previous} -> ${manifest.version} (${manifest.files.length} files)`)
      return result
    } catch (error) {
      this.error = String(error?.message ?? error)
      if (state !== undefined && installed) {
        try {
          this.saveUpgradeState({ ...state, phase: activated ? 'complete' : state.phase, error: this.error, activated })
        } catch (stateError) {
          this.error += `; could not persist upgrade outcome (${stateError?.message ?? stateError})`
        }
      }
      const record = { from: previous, to: targetVersion, at: Date.now(), ok: false, error: this.error }
      this.recordHistory(record)
      throw new Error(this.error)
    } finally {
      this.applying = false
      upgradeLocks.delete(this.deps.pkgDir)
    }
  }

  /**
   * Install an explicitly selected local package. Used when the UI imports a
   * locally built or reviewed package rather than fetching one from the network.
   *
   * The caller normally supplies only `manifestPath`: the directory holding the
   * release files is then resolved from the manifest's own `base` (a
   * manifest-relative path, validated by {@link parseManifest}), exactly as a
   * remote download resolves file URLs against the manifest URL. A `--base
   * './files/'` layout with files copied to `update/files/` therefore imports
   * with a single path. An explicit `packageDir` may still be passed (tests and
   * tooling); when both are given, `packageDir` wins.
   *
   * The resolved root must exist, be a directory, and not be reached through a
   * symlink component — a manifest may not redirect its own file reads.
   *
   * Content hashes are always verified against the manifest. A manifest that is
   * not signed with the configured release key is refused unless the caller
   * passes `allowUnsigned: true` — the explicit human acknowledgement that this
   * specific local package is trusted. The same staging, backup, install,
   * verify, activate and rollback transaction as {@link apply} runs afterwards.
   *
   * @param {{manifestPath?: string, packageDir?: string, onProgress?: (progress: object) => void, activate?: (result: object) => Promise<object>, allowUnsigned?: boolean, version?: string}} options
   * @returns {Promise<{version: string, files: number, bytes: number, previous: string, signed: boolean}>}
   */
  async applyLocal({ manifestPath, packageDir, onProgress = () => {}, activate, allowUnsigned = false, version } = {}) {
    // Locate the manifest: an explicit path, or the conventional `feed/`
    // location beside an explicitly given package directory.
    const candidates = manifestPath !== undefined
      ? [manifestPath]
      : typeof packageDir === 'string' && packageDir !== ''
        ? [path.join(packageDir, 'feed', 'manifest.json'), path.join(packageDir, 'manifest.json')]
        : []
    const manifestFile = candidates.map(candidate => path.resolve(candidate)).find(candidate => fs.existsSync(candidate))
    if (manifestFile === undefined) {
      throw new Error(candidates.length === 0
        ? 'applyLocal requires a manifestPath'
        : `cannot read local manifest (looked in ${candidates.join(', ')})`)
    }
    if (fs.lstatSync(manifestFile).isSymbolicLink()) throw new Error(`local manifest ${manifestFile} must not be a symlink`)
    const manifest = parseManifest(JSON.parse(fs.readFileSync(manifestFile, 'utf8')))
    const signed = manifest.signature !== undefined && verifyManifestSignature(manifest, this.deps.manifestPublicKey)
    if (!signed && allowUnsigned !== true) {
      throw new Error('local manifest is not signed with the configured release key; pass allowUnsigned to trust this package explicitly')
    }
    const root = packageDir !== undefined && packageDir !== ''
      ? path.resolve(packageDir)
      : resolveLocalPackageRoot(manifestFile, manifest.base)
    assertRealRoot(root)
    // Local packages stage from disk: copy each manifest file into the staging
    // directory and verify size + sha256 exactly as a download would.
    return this.#installVerified({
      manifest, onProgress, activate, allowUnsigned, version,
      stage: async () => {
        const stageDir = this.stageDir
        fs.rmSync(stageDir, { recursive: true, force: true })
        fs.mkdirSync(stageDir, { recursive: true })
        let bytes = 0
        const total = manifest.files.reduce((sum, f) => sum + f.size, 0)
        for (const file of manifest.files) {
          const parts = file.path.split('/')
          // A junction inside the local package must not redirect a source read.
          assertNoSymlinkBelow(root, parts)
          const source = path.join(root, ...parts)
          let body
          try { body = fs.readFileSync(source) } catch { throw new Error(`local package missing ${file.path}`) }
          if (body.length !== file.size) throw new Error(`local size ${body.length} != manifest ${file.size} for ${file.path}`)
          const digest = crypto.createHash('sha256').update(body).digest('hex')
          if (digest !== file.sha256) throw new Error(`local sha256 mismatch for ${file.path}`)
          const target = path.join(stageDir, ...parts)
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.writeFileSync(target, body)
          bytes += body.length
          onProgress({ done: bytes, total, file: file.path })
        }
        return { bytes, files: manifest.files.length }
      },
      signed,
    })
  }

  /** Shared install transaction for remote and local sources. */
  async #installVerified({ manifest, onProgress, activate, version, stage, signed }) {
    if (upgradeLocks.has(this.deps.pkgDir)) throw new Error('an upgrade is already running')
    this.reconcileRecovery()
    const priorState = this.loadUpgradeState()
    if (['installing', 'activating', 'recovery-required'].includes(priorState?.phase)) {
      throw new Error(`previous upgrade requires recovery; restore the verified backup in ${this.backupDir} and restart before upgrading again`)
    }
    this.applying = true
    upgradeLocks.add(this.deps.pkgDir)
    const previous = this.currentVersion()
    let state
    let installed = false
    let activated = false
    try {
      if (version !== undefined && manifest.version !== version) throw new Error(`package offers ${manifest.version}, not ${version}`)
      if (compareVersions(manifest.version, previous) < 0) throw new Error(`installed ${previous} is newer than ${manifest.version}`)
      if (manifest.minSupported !== undefined && compareVersions(previous, manifest.minSupported) < 0) {
        throw new Error(`update path requires at least ${manifest.minSupported}; ${previous} is installed`)
      }
      const staged = await stage()
      verifyStaged(this.stageDir, manifest)

      onProgress({ phase: 'install' })
      const previousOwned = this.loadOwnedFiles()
      const backedUp = backupPackage(this.deps.pkgDir, this.backupDir, { owned: previousOwned, installed: manifest.files.map(file => file.path) })
      // The receipt names the files the PREVIOUS install owned; only those may
      // be pruned when the new release drops them. A first managed update has an
      // empty receipt and therefore prunes nothing.
      state = { from: previous, to: manifest.version, at: Date.now(), phase: 'installing' }
      this.saveUpgradeState(state)
      const result = { version: manifest.version, previous, files: manifest.files.length, bytes: staged.bytes, signed }
      try {
        installed = true
        const applied = await installStaged(this.stageDir, this.deps.pkgDir, manifest.files.map(file => file.path), { previousOwned: [...previousOwned] })
        verifyInstalled(this.deps.pkgDir, manifest)
        // Record the new managed set only after the install verifies.
        this.saveOwnedFiles(new Set(manifest.files.map(file => file.path)))
        if (activate !== undefined) {
          state = { ...state, phase: 'activating' }
          this.saveUpgradeState(state)
          onProgress({ phase: 'reload' })
          const activation = await activate(result)
          if (activation?.ok !== true) {
            throw Object.assign(new Error(activation?.error ?? 'hot reload did not confirm activation'), { runtimeRestored: activation?.restored === true })
          }
          if (activation.version !== manifest.version) {
            throw new Error(`activation version mismatch: expected ${manifest.version}, got ${String(activation.version ?? '(missing)')}`)
          }
          activated = true
        }
      } catch (error) {
        let restoreError = null
        try {
          restoreBackup(this.backupDir, this.deps.pkgDir)
          // The receipt was advanced to the failed release before activation;
          // put the previous managed set back so a later update does not prune
          // against the wrong ownership.
          this.saveOwnedFiles(previousOwned)
        } catch (rollbackError) { restoreError = rollbackError }
        state = {
          ...state,
          phase: restoreError !== null || (state.phase === 'activating' && error.runtimeRestored !== true) ? 'recovery-required' : 'rolled-back',
          diskRestored: restoreError === null,
          runtimeRestored: state.phase !== 'activating' || error.runtimeRestored === true,
        }
        if (restoreError !== null) {
          throw new Error(`upgrade failed (${error?.message ?? error}); rollback also failed (${restoreError?.message ?? restoreError})`)
        }
        throw new Error(`upgrade failed, previous files restored (${error?.message ?? error})`)
      }
      this.saveUpgradeState({ ...state, phase: 'complete', activated })
      try { fs.rmSync(this.stageDir, { recursive: true, force: true }) } catch (error) { this.deps.log?.(`eac-design-world: staging cleanup failed (${error?.message ?? error})`) }
      this.recordHistory({ from: previous, to: manifest.version, at: Date.now(), ok: true, files: manifest.files.length, bytes: staged.bytes, backedUp, activated, signed })
      this.checkedAt = Date.now()
      this.deps.log?.(`eac-design-world: installed ${previous} -> ${manifest.version} (${manifest.files.length} files)`)
      return result
    } catch (error) {
      this.error = String(error?.message ?? error)
      if (state !== undefined && installed) {
        try {
          this.saveUpgradeState({ ...state, phase: activated ? 'complete' : state.phase, error: this.error, activated })
        } catch (stateError) {
          this.error += `; could not persist upgrade outcome (${stateError?.message ?? stateError})`
        }
      }
      this.recordHistory({ from: previous, to: manifest.version, at: Date.now(), ok: false, error: this.error })
      throw new Error(this.error)
    } finally {
      this.applying = false
      upgradeLocks.delete(this.deps.pkgDir)
    }
  }

  /**
   * Put the retained backup back in place on demand (recovery UI).
   *
   * @param {{activate?: (result: object) => Promise<object>}} [options] - when
   *   `activate` is given, the restored code is hot-reloaded and its result is
   *   reported; a failed activation leaves the disk restored but marks the
   *   transaction as requiring recovery.
   * @returns {Promise<{restored: number, version: string, activated: boolean, ok: boolean, error?: string}>}
   */
  async rollback({ activate } = {}) {
    if (upgradeLocks.has(this.deps.pkgDir)) throw new Error('an upgrade is already running')
    // Take the lock BEFORE touching disk: the restore is synchronous but the
    // activation that follows is not, and a concurrent apply must not slip in
    // between the swap and the reload.
    this.applying = true
    upgradeLocks.add(this.deps.pkgDir)
    let version
    let count
    try {
      count = backupPackageCount(this.backupDir)
      restoreBackup(this.backupDir, this.deps.pkgDir)
      version = this.currentVersion()
      // A full disk snapshot includes user files. Only the saved ownership
      // receipt may authorize pruning during a later update.
      const snapshot = backupSnapshot(this.backupDir)
      this.saveOwnedFiles(new Set(snapshot.owned ?? []))
    } catch (error) {
      this.applying = false
      upgradeLocks.delete(this.deps.pkgDir)
      this.error = String(error?.message ?? error)
      this.recordHistory({ from: this.currentVersion(), to: this.currentVersion(), at: Date.now(), ok: false, error: this.error, rollback: true })
      throw new Error(this.error)
    }
    let activated = false
    let ok = true
    let error
    try {
      if (activate !== undefined) {
        try {
          const activation = await activate({ version, restored: count })
          if (activation?.ok !== true) {
            ok = false
            error = activation?.error ?? 'hot reload did not confirm the restored version'
          } else if (activation.version !== undefined && activation.version !== version) {
            // A reload that reports the wrong version is not a successful rollback.
            ok = false
            error = `activation version mismatch: expected ${version}, got ${String(activation.version)}`
          } else {
            activated = true
          }
        } catch (activationError) {
          ok = false
          error = String(activationError?.message ?? activationError)
        }
      }
      this.saveUpgradeState({ phase: ok ? 'rolled-back' : 'recovery-required', at: Date.now(), diskRestored: true, runtimeRestored: activated, error: error ?? '' })
      this.recordHistory({ from: version, to: version, at: Date.now(), ok, error, restored: count, rollback: true })
    } finally {
      this.applying = false
      upgradeLocks.delete(this.deps.pkgDir)
    }
    return { restored: count, version, activated, ok, ...(error === undefined ? {} : { error }) }
  }
}

/** Count files in a backup directory without throwing on a missing copy. */
function backupPackageCount(backupDir) {
  try { return listPackageFiles(backupDir).length } catch { return 0 }
}
