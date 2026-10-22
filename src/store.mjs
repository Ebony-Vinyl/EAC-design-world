import { mkdir, readFile, writeFile, rename, unlink, open } from 'node:fs/promises';
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

async function readLock(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    // Truncated or unreadable lock: no owner can be proven, so it is treated as stale.
    return {};
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
    if (current && current.token !== entry.info.token) return;
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
  for (let attempt = 0; attempt < 6; attempt++) {
    let handle;
    try {
      handle = await open(lockPath, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const other = await readLock(lockPath);
      const pid = Number(other?.pid);
      // A different live process owns it: refuse, never steal. Our own pid without a live
      // in-process entry is a leftover of a closed or failed instance and is reclaimed below.
      if (Number.isInteger(pid) && pid !== process.pid && processAlive(pid)) {
        throw lockError(other, key, lockPath);
      }
      // Stale (owner gone / half-written). Move it aside under a unique name so that two
      // reclaiming processes cannot both win the same file, then retry the exclusive create.
      // A file another process still has open can refuse the rename on Windows: that owner is
      // alive, so the next attempt reads it again and refuses properly instead of failing here.
      const stale = `${lockPath}.stale-${randomUUID()}`;
      const moved = await rename(lockPath, stale).then(() => true, () => false);
      if (moved) await unlink(stale).catch(() => {});
      continue;
    }
    try {
      await handle.writeFile(JSON.stringify(info, null, 2), 'utf8');
    } finally {
      await handle.close();
    }
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
      await writeFile(temporary, content, 'utf8');
      await rename(temporary, this.file);
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
