import { mkdir, readFile, writeFile, rename, link, unlink, readdir, stat } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, extname, basename, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireDataLock } from './store.mjs';

// Design projects/artifacts are separate from video projects: immutable HTML/SVG/Markdown
// revisions are written under a local store directory and never overwritten.

export const designProjectKinds = ['website', 'deck', 'document', 'image', 'motion'];
export const designArtifactKinds = ['html', 'svg', 'markdown'];

const maxContentBytes = 5 * 1024 * 1024;
const maxNameLength = 120;
const maxSessionLength = 200;
const extensions = { html: '.html', svg: '.svg', markdown: '.md' };
const revisionPattern = /^r(\d+)(\.html|\.svg|\.md)$/i;
const temporaryMarker = '.eac-tmp-';

const inside = (root, path) => {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

// Missing design resources map to HTTP 404 rather than a generic 400.
function notFound(message) {
  const error = new Error(message);
  error.code = 'ENOENT';
  return error;
}

function safeName(value) {
  const name = String(value ?? '').trim();
  if (!name || name.length > maxNameLength) throw new Error(`成品名称必须是 1 至 ${maxNameLength} 字符`);
  if (/[\x00-\x1f<>:"/\\|?*]/.test(name)) throw new Error('成品名称不能包含路径分隔符或控制字符');
  if (name === '.' || name === '..') throw new Error('成品名称无效');
  return name;
}

function kindFromName(name, content) {
  const extension = extname(name).toLowerCase();
  if (['.html', '.htm'].includes(extension)) return 'html';
  if (extension === '.svg') return 'svg';
  if (['.md', '.markdown'].includes(extension)) return 'markdown';
  const head = String(content).trimStart().slice(0, 256).toLowerCase();
  if (head.startsWith('<svg')) return 'svg';
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'html';
  return 'markdown';
}

function fileStem(name) {
  const stem = basename(name).replace(/\.[a-z0-9]+$/i, '');
  return stem.replace(/[^A-Za-z0-9._\u4e00-\u9fff-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'artifact';
}

function artifactView(project, artifact) {
  const revision = artifact.revisions.find((entry) => entry.revision === artifact.revision) || artifact.revisions.at(-1);
  return {
    id: artifact.id, projectId: project.id, name: artifact.name, kind: artifact.kind,
    revision: revision.revision, path: revision.path, bytes: revision.bytes,
    url: `/api/design/artifacts/${artifact.id}/preview`,
    contentUrl: `/api/design/artifacts/${artifact.id}/content`,
    downloadUrl: `/api/design/artifacts/${artifact.id}/download`,
    revisions: artifact.revisions.map((entry) => ({ revision: entry.revision, bytes: entry.bytes, createdAt: entry.createdAt })),
    createdAt: artifact.createdAt, updatedAt: artifact.updatedAt,
  };
}

/** Writes an immutable revision without ever clobbering an existing file: the bytes land in a
 *  private temporary file first (fsync'd, so a power cut cannot leave a half-written file that
 *  looks like a revision), then a hard link publishes them under the final name, which fails with
 *  EEXIST if anything is already there. There is deliberately no rename fallback: on a volume
 *  without hard links a rename would replace an existing revision and break the immutability
 *  promise, so such a volume fails closed instead of quietly overwriting history. A crash
 *  mid-write therefore leaves only a temporary file (discarded on the next start). */
async function writeImmutable(path, content, publish) {
  const temporary = `${path}${temporaryMarker}${randomUUID()}`;
  await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', flush: true });
  try {
    await publish(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export class DesignStore {
  /** `publish` is the hard-link step of an immutable revision write. It is a constructor option so
   *  a test can simulate a volume without hard-link support, where the old rename fallback
   *  silently replaced an existing revision. Production never passes it. */
  constructor(root, { publish = link } = {}) {
    this.root = resolve(root);
    this.file = join(this.root, 'projects.json');
    this.files = join(this.root, 'files');
    this.publish = publish;
    this.tail = Promise.resolve();
    this.mutations = Promise.resolve();
    this.lock = null;
    this.recovered = []; // revisions found on disk but missing from the metadata, adopted on load
    this.orphans = []; // artifact directories no metadata refers to; left untouched
  }
  async init() {
    // The engine puts this store at <dataDir>/design, inside the Store's data directory. Its lock is
    // shared with that parent root so one engine = one lock, and so the shutdown quiesce point
    // (flush(), called by engine.close()) releases both.
    const lockRoot = basename(this.root) === 'design' ? dirname(this.root) : this.root;
    this.lock ??= await acquireDataLock(lockRoot, {
      kind: lockRoot === this.root ? 'design' : 'design-shared', share: lockRoot !== this.root, owner: this,
    });
    try {
      await mkdir(this.files, { recursive: true });
      try {
        this.data = JSON.parse(await readFile(this.file, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error(`Design state cannot be read: ${error.message}`);
        this.data = { version: 1, projects: [] };
      }
      this.data.projects = Array.isArray(this.data.projects) ? this.data.projects : [];
      for (const project of this.data.projects) {
        project.artifacts = Array.isArray(project.artifacts) ? project.artifacts : [];
        for (const artifact of project.artifacts) artifact.revisions = Array.isArray(artifact.revisions) ? artifact.revisions : [];
      }
      // A crash between "revision file written" and "projects.json saved" leaves files/ ahead of
      // the metadata. Without this reconciliation the next save recomputes the same revision number
      // and hits EEXIST forever, so the artifact could never be saved again. Adopting what is on
      // disk (never deleting it) makes every interrupted save self-healing and keeps the content.
      await this.reconcile();
      await this.save();
      return this;
    } catch (error) {
      await this.release().catch(() => {});
      throw error;
    }
  }
  snapshot() { return structuredClone(this.data); }
  save() {
    const content = JSON.stringify(this.data, null, 2);
    this.tail = this.tail.catch(() => {}).then(async () => {
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      // flush: fsync before the rename publishes the new metadata, so a power cut cannot leave a
      // truncated projects.json behind (same durability contract as the revision writes above).
      await writeFile(temporary, content, { encoding: 'utf8', flush: true });
      await rename(temporary, this.file);
    });
    return this.tail;
  }
  project(id) {
    const project = this.data.projects.find((entry) => entry.id === id);
    if (!project) throw notFound('设计项目不存在');
    return project;
  }
  async createProject({ title, brief, kind, templateId, designSystemId, sessionId } = {}) {
    const name = String(title ?? '').trim();
    if (!name || name.length > 160) throw new Error('请输入 1 至 160 字的设计项目名称');
    if (!designProjectKinds.includes(kind)) throw new Error(`设计类型必须是：${designProjectKinds.join('、')}`);
    const session = sessionId === undefined || sessionId === null || sessionId === '' ? null : String(sessionId).slice(0, maxSessionLength);
    const now = new Date().toISOString();
    const project = {
      id: randomUUID(), title: name, brief: String(brief ?? '').slice(0, 8000), kind,
      templateId: templateId ? String(templateId).slice(0, 160) : null,
      designSystemId: designSystemId ? String(designSystemId).slice(0, 160) : null,
      sessionId: session, artifacts: [], createdAt: now, updatedAt: now,
    };
    this.data.projects.unshift(project);
    await this.save();
    return { ...structuredClone(project) };
  }
  /** Waits for pending writes only. Lock release is deliberately separate: a caller that just
   *  wants the data on disk (a checkpoint, a test, a future periodic flush) must not silently
   *  hand the data directory to another instance. engine.close() releases explicitly. */
  async flush() {
    await this.mutations;
    await this.tail;
  }
  async release() {
    const lock = this.lock;
    this.lock = null;
    if (lock) await lock.release({ force: true });
  }
  artifact(id) {
    for (const project of this.data.projects) {
      const artifact = project.artifacts.find((entry) => entry.id === id);
      if (artifact) return { project, artifact };
    }
    throw notFound('设计成品不存在');
  }
  /**
   * Maps files/<artifactId>/ against the metadata. Revisions on disk that the metadata never
   * recorded are adopted (the content is kept and the counter moves past them); leftover temporary
   * files of an interrupted write are discarded; directories no metadata refers to are reported in
   * this.orphans and left exactly as they are.
   */
  async reconcile() {
    this.recovered = [];
    this.orphans = [];
    let directories;
    try {
      directories = await readdir(this.files, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const dirent of directories) {
      if (!dirent.isDirectory()) continue;
      const id = dirent.name;
      const directory = join(this.files, id);
      const found = this.findArtifact(id);
      if (!found) {
        this.orphans.push({ id, directory });
        continue;
      }
      await this.syncArtifactDirectory(found.artifact, directory);
    }
  }
  findArtifact(id) {
    for (const project of this.data.projects) {
      const artifact = project.artifacts.find((entry) => entry.id === id);
      if (artifact) return { project, artifact };
    }
    return null;
  }
  /** Re-reads one artifact directory: adopts unrecorded revisions, drops interrupted temp files,
   *  and keeps artifact.revision at or above every revision that exists on disk. Returns the
   *  highest revision number now known. */
  async syncArtifactDirectory(artifact, directory) {
    let names;
    try {
      names = await readdir(directory);
    } catch (error) {
      if (error.code === 'ENOENT') return Math.max(artifact.revision ?? 0, 0);
      throw error;
    }
    const files = [];
    for (const name of names) {
      if (name.includes(temporaryMarker)) {
        await unlink(join(directory, name)).catch(() => {});
        continue;
      }
      const match = revisionPattern.exec(name);
      if (match) files.push({ revision: Number(match[1]), path: join(directory, name) });
    }
    files.sort((left, right) => left.revision - right.revision);
    const known = new Set(artifact.revisions.map((entry) => entry.revision));
    for (const file of files) {
      if (known.has(file.revision)) continue;
      const info = await stat(file.path).catch(() => null);
      if (!info) continue;
      artifact.revisions.push({
        revision: file.revision, path: file.path, bytes: info.size,
        createdAt: info.mtime.toISOString(), recovered: true,
      });
      known.add(file.revision);
      this.recovered.push({ id: artifact.id, revision: file.revision, path: file.path });
    }
    artifact.revisions.sort((left, right) => left.revision - right.revision);
    const highestFile = files.length ? files.at(-1).revision : 0;
    const highestRecorded = artifact.revisions.length ? artifact.revisions.at(-1).revision : 0;
    artifact.revision = Math.max(Number(artifact.revision) || 0, highestFile, highestRecorded);
    return artifact.revision;
  }
  saveArtifact(args = {}) {
    const task = this.mutations.then(() => this.writeArtifact(args));
    this.mutations = task.catch(() => {});
    return task;
  }
  async writeArtifact({ projectId, name, content, revision } = {}) {
    const project = this.project(projectId);
    const fileName = safeName(name);
    if (typeof content !== 'string') throw new Error('成品内容必须是文本');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > maxContentBytes) throw new Error(`成品内容不能超过 ${maxContentBytes / (1024 * 1024)} MB`);
    const kind = kindFromName(fileName, content);
    if (!designArtifactKinds.includes(kind)) throw new Error('成品类型必须是 HTML、SVG 或 Markdown');
    if (revision !== undefined && revision !== null && !Number.isInteger(revision)) throw new Error('revision 必须是整数');
    const now = new Date().toISOString();
    let artifact = project.artifacts.find((entry) => entry.name === fileName);
    let nextRevision;
    if (artifact) {
      if (revision !== undefined && revision !== null && revision !== artifact.revision) {
        throw new Error('成品已被其他保存更新，请读取最新修订号后重试');
      }
      nextRevision = artifact.revision + 1;
    } else {
      if (revision !== undefined && revision !== null && revision !== 0) throw new Error('新成品不能指定已有修订号');
      artifact = { id: randomUUID(), name: fileName, kind, revision: 0, revisions: [], createdAt: now, updatedAt: now };
      nextRevision = 1;
    }
    const directory = join(this.files, artifact.id);
    await mkdir(directory, { recursive: true });
    // The metadata is only updated after the bytes are on disk, so a crash never claims content
    // that does not exist. The reverse (bytes without metadata) is what reconcile() repairs, and
    // an unexpected file at the computed revision number is adopted here instead of failing forever.
    let written;
    for (let attempt = 0; ; attempt++) {
      const path = resolve(directory, `r${nextRevision}${extensions[kind]}`);
      if (!inside(this.files, path)) throw new Error('成品路径越界');
      try {
        await writeImmutable(path, content, this.publish);
        written = path;
        break;
      } catch (error) {
        if (error.code !== 'EEXIST' || attempt >= 5) throw error;
        nextRevision = (await this.syncArtifactDirectory(artifact, directory)) + 1;
      }
    }
    if (!project.artifacts.includes(artifact)) project.artifacts.push(artifact);
    artifact.kind = kind;
    artifact.revision = nextRevision;
    artifact.revisions.push({ revision: nextRevision, path: written, bytes, createdAt: now });
    artifact.revisions.sort((left, right) => left.revision - right.revision);
    artifact.updatedAt = now;
    project.updatedAt = now;
    await this.save();
    return artifactView(project, artifact);
  }
  state(sessionId) {
    const session = sessionId === undefined || sessionId === null || sessionId === '' ? null : String(sessionId);
    const projects = this.data.projects
      .filter((project) => !session || project.sessionId === session || !project.sessionId)
      .map((project) => ({
        ...structuredClone(project),
        artifacts: project.artifacts.map((artifact) => artifactView(project, artifact)),
      }));
    return { sessionId: session, projects };
  }
  revisionOf(artifact, revision) {
    if (revision === undefined || revision === null) return artifact.revisions.at(-1);
    if (!Number.isInteger(revision)) throw new Error('revision 必须是整数');
    const entry = artifact.revisions.find((row) => row.revision === revision);
    if (!entry) throw new Error('成品修订号不存在');
    return entry;
  }
  async readContent(id, revision) {
    const { project, artifact } = this.artifact(id);
    const entry = this.revisionOf(artifact, revision);
    const content = await readFile(entry.path, 'utf8');
    return { id: artifact.id, projectId: project.id, name: artifact.name, kind: artifact.kind, revision: entry.revision, content };
  }
  fileFor(id, revision) {
    const { project, artifact } = this.artifact(id);
    const entry = this.revisionOf(artifact, revision);
    return { id: artifact.id, projectId: project.id, name: artifact.name, kind: artifact.kind, revision: entry.revision, path: entry.path };
  }
}
