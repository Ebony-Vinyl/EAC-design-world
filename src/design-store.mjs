import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, extname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

// Design projects/artifacts are separate from video projects: immutable HTML/SVG/Markdown
// revisions are written under a local store directory and never overwritten.

export const designProjectKinds = ['website', 'deck', 'document', 'image', 'motion'];
export const designArtifactKinds = ['html', 'svg', 'markdown'];

const maxContentBytes = 5 * 1024 * 1024;
const maxNameLength = 120;
const maxSessionLength = 200;
const extensions = { html: '.html', svg: '.svg', markdown: '.md' };

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

export class DesignStore {
  constructor(root) {
    this.root = resolve(root);
    this.file = join(this.root, 'projects.json');
    this.files = join(this.root, 'files');
    this.tail = Promise.resolve();
    this.mutations = Promise.resolve();
  }
  async init() {
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
    await this.save();
    return this;
  }
  snapshot() { return structuredClone(this.data); }
  save() {
    const content = JSON.stringify(this.data, null, 2);
    this.tail = this.tail.catch(() => {}).then(async () => {
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, content, 'utf8');
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
  async flush() { await this.mutations; await this.tail; }
  artifact(id) {
    for (const project of this.data.projects) {
      const artifact = project.artifacts.find((entry) => entry.id === id);
      if (artifact) return { project, artifact };
    }
    throw notFound('设计成品不存在');
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
    const path = resolve(directory, `r${nextRevision}${extensions[kind]}`);
    if (!inside(this.files, path)) throw new Error('成品路径越界');
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
    if (!project.artifacts.includes(artifact)) project.artifacts.push(artifact);
    artifact.kind = kind;
    artifact.revision = nextRevision;
    artifact.revisions.push({ revision: nextRevision, path, bytes, createdAt: now });
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
