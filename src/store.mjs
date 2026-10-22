import { mkdir, readFile, rename, unlink, open, link, stat } from 'node:fs/promises';
import { readFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { ROOT } from './catalog.mjs';

// One data directory belongs to exactly one live engine instance. Two instances each keep their
// own in-memory snapshot and write the whole JSON back, so the slower writer silently erases the
// other's projects (last writer wins). The lock makes that impossible: a second live instance is
// refused instead of allowed to overwrite, and a lock left behind by a crashed process (its pid is
// gone) is taken over automatically. The mutexes below (this.tail / design-store mutations) only
// order writes inside one instance; they never protected two processes from each other.

const lockName = 'LOCK';
// A LOCK that proves no owner (0 bytes, truncated JSON, no pid) is exactly what a writer looks like
// between create and write, so it must be waited for, never stolen. Only past this grace is it
// evidence of a crash.
const INCOMPLETE_LOCK_GRACE_MS = 2_000;
// A lock written by another machine cannot be probed with process.kill (its pid means nothing
// here), so it counts as live until it is clearly abandoned.
const FOREIGN_LOCK_TTL_MS = 30 * 60_000;
const LOCK_POLL_MS = 50;
const LOCK_RETRY_BUDGET_MS = 15_000;
// Filesystems where link() is unavailable (FAT/exFAT, some network mounts and sandboxes): the
// exclusive-create fallback still works, covered by the grace above.
const LINK_WITHOUT_HARDLINK = new Set(['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK']);
const lockDirectories = new Map(); // resolved data root -> entry of the live lock in this process
const exitHooks = new Map(); // lock file path -> token owned by this process
let exitHandlerInstalled = false;

/** True when a pid names a live process. On Windows `process.kill(pid, 0)` uses the OS process
 *  handle: it returns normally for a running pid and throws ESRCH once the pid is gone. EPERM
 *  means the process exists but cannot be signalled, so it counts as alive (never steal it). */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** Reads the lock and the proof it carries.
 *  `null` = no LOCK at all. Otherwise `{ info, incomplete, mtimeMs }`; `incomplete` means the file
 *  exists but no owner can be proven from it (0 bytes, truncated JSON, no pid) — that is a writer
 *  in flight, NOT proof of a crash, so it must not be reclaimed before the grace expires. */
async function readLock(path) {
  let raw;
  let mtimeMs = Date.now();
  try {
    raw = await readFile(path, 'utf8');
    const held = await stat(path).catch(() => null);
    if (held) mtimeMs = held.mtimeMs;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    const held = await stat(path).catch(() => null);
    return { incomplete: true, info: null, mtimeMs: held ? held.mtimeMs : Date.now() };
  }
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value) && Number(value.pid) > 0) {
      return { incomplete: false, info: value, mtimeMs };
    }
  } catch { /* truncated: fall through */ }
  return { incomplete: true, info: null, mtimeMs };
}

const lockIdentity = (state) => (state.info?.token ?? `mtime:${state.mtimeMs}`);

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** fsync a handle, tolerating filesystems that refuse it (some network mounts answer EINVAL). */
async function syncHandle(handle) {
  try {
    await handle.sync();
  } catch (error) {
    if (!['ENOSYS', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EBADF'].includes(error.code)) throw error;
  }
}

/**
 * Publishes our owner record at `lockPath` without ever exposing a 0-byte LOCK: the bytes go to a
 * private temporary file, which is then hard-linked into place. link() is atomic and fails with
 * EEXIST when any lock already exists. (Keeping the created file open is not enough — rename()
 * still moves a file that has an open handle on Windows, so a competitor could take it away.)
 * Returns 'published' or 'occupied'.
 */
async function publishLock(lockPath, payload) {
  const temporary = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(payload, 'utf8');
    await syncHandle(handle);
  } finally {
    await handle.close();
  }
  try {
    try {
      await link(temporary, lockPath);
      return 'published';
    } catch (error) {
      if (error.code === 'EEXIST') return 'occupied';
      if (!LINK_WITHOUT_HARDLINK.has(error.code)) throw error;
      // No hard links here: exclusive create is the next best thing. It reopens the short window
      // this fix is about (readers wait it out via INCOMPLETE_LOCK_GRACE_MS), and the content is
      // read back because a reclaimer may have deleted the file while we were writing it.
      let fallback;
      try {
        fallback = await open(lockPath, 'wx');
      } catch (openError) {
        if (openError.code === 'EEXIST') return 'occupied';
        throw openError;
      }
      try {
        await fallback.writeFile(payload, 'utf8');
        await syncHandle(fallback);
      } finally {
        await fallback.close();
      }
      const readback = await readFile(lockPath, 'utf8').catch(() => null);
      return readback === payload ? 'published' : 'occupied';
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/** What an existing LOCK means for a candidate owner:
 *  'refuse'  — proven live on this host, or unverifiable on another host: never steal it.
 *  'wait'    — a writer may still be publishing it (no owner proven yet, mtime still fresh).
 *  'reclaim' — leftovers of a crashed instance: safe to remove and replace. */
function classifyLock(state) {
  const age = Date.now() - state.mtimeMs;
  if (state.incomplete) return age < INCOMPLETE_LOCK_GRACE_MS ? 'wait' : 'reclaim';
  const { info } = state;
  if (info.hostname && info.hostname !== hostname()) {
    return age < FOREIGN_LOCK_TTL_MS ? 'refuse' : 'reclaim';
  }
  // Same host: the pid decides. Our own pid without a live in-process entry is a leftover of a
  // closed or failed instance in this process and gets reclaimed.
  if (info.pid === process.pid) return 'reclaim';
  return processAlive(info.pid) ? 'refuse' : 'reclaim';
}

/**
 * Removes a lock this process judged stale, one reclaimer at a time.
 * Without the guard two processes can both judge the same file stale, and then the second rename()
 * cannot tell "the file I judged" from the fresh LOCK the first one just published — it moves a
 * live lock out of the way, which is another route to two holders (the same class of bug as the
 * empty-file window). Under the guard, removal is re-checked against what was judged.
 * Returns true when the judged file is gone.
 */
async function reclaimStaleLock(lockPath, judged) {
  const guardPath = `${lockPath}.reclaim`;
  let guard;
  try {
    guard = await open(guardPath, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Someone else is reclaiming: let them finish, and clean up after a crashed reclaimer.
    const held = await stat(guardPath).catch(() => null);
    if (held && Date.now() - held.mtimeMs > INCOMPLETE_LOCK_GRACE_MS) await unlink(guardPath).catch(() => {});
    await sleep(LOCK_POLL_MS);
    return false;
  }
  try {
    const again = await readLock(lockPath);
    if (!again) return true;
    if (lockIdentity(again) !== lockIdentity(judged)) return false; // a successor published meanwhile
    let removed = false;
    try {
      await unlink(lockPath);
      removed = true;
    } catch (error) {
      // Already gone: another reclaimer won. Do NOT fall through to the rename below — by now the
      // winner may have published its fresh LOCK, and moving that aside is the double hold.
      if (error.code === 'ENOENT') return true;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
    }
    if (!removed) {
      // Windows refuses to delete a file another process still has open: move it aside instead.
      const stale = `${lockPath}.stale-${randomUUID()}`;
      if (await rename(lockPath, stale).then(() => true, () => false)) await unlink(stale).catch(() => {});
    }
    return true;
  } finally {
    await guard.close().catch(() => {});
    await unlink(guardPath).catch(() => {});
  }
}

function lockError(info, root, lockPath) {
  const owner = Number.isInteger(info?.pid) && info.pid > 0
    ? `pid ${info.pid}${info.hostname ? ` @ ${info.hostname}` : ''}${
      info.startedAt || info.acquiredAt ? `，自 ${info.startedAt || info.acquiredAt} 起` : ''}`
    : 'pid 未知的进程';
  const error = new Error(
    `数据目录已被另一个运行中的 EAC 实例占用（${owner}）。\n`
    + `为避免静默覆盖用户数据，本次启动被拒绝。数据目录：${root}\n`
    + `请先停止占用该目录的实例；若它正在关闭，请稍候重试；`
    + `若确认该进程已不存在，删除锁文件 ${lockPath} 后重试。`,
  );
  error.code = 'EAC_LOCKED';
  error.lockPath = lockPath;
  return error;
}

function lockDisabled() {
  const flag = String(process.env.EAC_DATA_LOCK ?? '').trim().toLowerCase();
  return flag === 'off' || flag === '0' || flag === 'false' || flag === 'no';
}

let disabledWarningIssued = false;
function warnLockDisabled(root) {
  if (disabledWarningIssued) return;
  disabledWarningIssued = true;
  process.emitWarning(`EAC_DATA_LOCK 已关闭数据目录锁（${root}）：同时运行两个实例会静默丢失项目数据。`, {
    code: 'EAC_LOCK_DISABLED', type: 'Warning',
  });
}

function releaseOnExit() {
  for (const [lockPath, token] of exitHooks) {
    try {
      const parsed = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (parsed?.token === token) unlinkSync(lockPath);
    } catch { /* already gone, or another owner took the file over */ }
  }
  exitHooks.clear();
}

class DataLock {
  constructor(entry) {
    this.entry = entry;
  }
  get path() { return this.entry.path; }
  get info() { return this.entry.info; }
  get released() { return Boolean(this.entry.disabled || this.entry.released); }

  /** Drops this owner's claim. With force (the shutdown path) the whole shared lock is released,
   *  so the next engine instance in this process can start; the file is only unlinked when it
   *  still carries our token, never a successor's lock. */
  async release({ force = false } = {}) {
    const entry = this.entry;
    if (entry.disabled || entry.released) return;
    if (force) entry.owners.clear();
    else entry.owners.delete(entry.owner);
    if (entry.owners.size > 0) return;
    entry.released = true;
    lockDirectories.delete(entry.root);
    exitHooks.delete(entry.path);
    const current = await readLock(entry.path);
    if (current && current.info?.token !== entry.info.token) return;
    await unlink(entry.path).catch(() => {});
  }
}

/**
 * Takes the exclusive lock of a data directory.
 * `share: true` lets a sub-store (design/, owned by the same engine) join the lock its parent
 * root already holds in this process instead of being refused.
 * Throws EAC_LOCKED when another live instance owns the directory.
 */
export async function acquireDataLock(root, { kind = 'data', share = false, owner = null } = {}) {
  const key = resolve(root);
  if (lockDisabled()) {
    warnLockDisabled(key);
    return new DataLock({ path: join(key, lockName), info: {}, owners: new Set(), root: key, owner, released: false, disabled: true });
  }
  const live = lockDirectories.get(key);
  if (live && live.released) lockDirectories.delete(key);
  const current = lockDirectories.get(key);
  if (current) {
    if (share) {
      current.owners.add(owner);
      return new DataLock(current);
    }
    throw lockError(current.info, key, current.path);
  }
  await mkdir(key, { recursive: true });
  const lockPath = join(key, lockName);
  const token = randomUUID();
  const info = {
    tool: 'eac-design-world', kind, pid: process.pid, hostname: hostname(), token,
    startedAt: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
    acquiredAt: new Date().toISOString(),
  };
  const payload = `${JSON.stringify(info, null, 2)}\n`;
  // Retrying is time-bounded: a fresh half-written lock is waited for (up to the grace), a foreign
  // host lock is refused at once, and a stale one is reclaimed once, under the reclaim guard.
  const deadline = Date.now() + LOCK_RETRY_BUDGET_MS;
  while (Date.now() < deadline) {
    const existing = await readLock(lockPath);
    if (existing) {
      const verdict = classifyLock(existing);
      // A different live process owns it: refuse, never steal.
      if (verdict === 'refuse') throw lockError(existing.info, key, lockPath);
      if (verdict === 'wait') {
        await sleep(LOCK_POLL_MS);
        continue;
      }
      await reclaimStaleLock(lockPath, existing);
      continue;
    }
    if (await publishLock(lockPath, payload) !== 'published') continue;
    const entry = { path: lockPath, info, owners: new Set(owner ? [owner] : []), owner, root: key, released: false };
    lockDirectories.set(key, entry);
    if (!exitHandlerInstalled) {
      exitHandlerInstalled = true;
      process.once('exit', releaseOnExit);
    }
    exitHooks.set(lockPath, token);
    return new DataLock(entry);
  }
  throw new Error(`无法获取数据目录锁：${lockPath}。请确认没有其他 EAC 实例正在运行。`);
}

export class Store {
  constructor(root = process.env.EAC_DATA_DIR || join(ROOT, '.eac')) {
    this.root = resolve(root);
    this.file = join(this.root, 'state.json');
    this.tail = Promise.resolve();
    this.lock = null;
  }
  async init() {
    await mkdir(this.root, { recursive: true });
    // Lock before reading: a second instance must never load state, demote another instance's
    // running jobs to failed and then write that snapshot back over the live one.
    this.lock ??= await acquireDataLock(this.root, { kind: 'data', owner: this });
    try {
      try {
        this.state = JSON.parse(await readFile(this.file, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error(`State file cannot be read: ${error.message}`);
        this.state = { version: 1, projects: [], jobs: [], settings: {
          outputRoot: join(this.root, 'outputs'), ttsVoice: '', quality: 'production'
        }};
      }
      this.state.settings = Object.fromEntries(['outputRoot', 'ttsVoice', 'quality']
        .filter((key) => Object.hasOwn(this.state.settings, key)).map((key) => [key, this.state.settings[key]]));
      this.state.jobs = this.state.jobs.filter((job) => job.type !== 'concat-export');
      for (const project of this.state.projects) {
        delete project.concat;
        delete project.concatHandoff;
      }
      for (const job of this.state.jobs) {
        if (['running', 'queued'].includes(job.status)) {
          job.status = 'failed';
          job.error = '制作进程已中断。项目与已有素材已保留，请重新提交任务。';
        }
      }
      await this.save();
      return this;
    } catch (error) {
      await this.release().catch(() => {});
      throw error;
    }
  }
  snapshot() { return structuredClone(this.state); }
  /** Releases the data-directory lock (idempotent). engine.close() reaches this through the
   *  design store's flush(), which is the shutdown quiesce point. */
  async release() {
    const lock = this.lock;
    this.lock = null;
    if (lock) await lock.release({ force: true });
  }
  save() {
    const content = JSON.stringify(this.state, null, 2);
    this.tail = this.tail.catch(() => {}).then(async () => {
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      // Durability: the rename must not become visible before the bytes are on disk. Without the
      // fsync a power loss leaves a 0-byte or half-written state.json behind (every project gone),
      // because rename() only orders the directory entry, not the data behind the temp file.
      const handle = await open(temporary, 'wx');
      try {
        await handle.writeFile(content, 'utf8');
        await syncHandle(handle);
      } finally {
        await handle.close();
      }
      try {
        await rename(temporary, this.file);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
    });
    return this.tail;
  }
  project(id) {
    const project = this.state.projects.find((p) => p.id === id);
    if (!project) throw new Error('项目不存在');
    return project;
  }
  async updateProject(id, fn, expectedRevision) {
    const project = this.project(id);
    if (expectedRevision !== undefined && project.revision !== expectedRevision) {
      throw new Error('项目已被其他操作修改，请刷新后重试');
    }
    const next = structuredClone(project);
    fn(next);
    next.revision++;
    next.updatedAt = new Date().toISOString();
    this.state.projects[this.state.projects.indexOf(project)] = next;
    await this.save();
    return structuredClone(next);
  }
}
