import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT } from './catalog.mjs';

export class Store {
  constructor(root = process.env.EAC_DATA_DIR || join(ROOT, '.eac')) {
    this.root = resolve(root);
    this.file = join(this.root, 'state.json');
    this.tail = Promise.resolve();
  }
  async init() {
    await mkdir(this.root, { recursive: true });
    try {
      this.state = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`State file cannot be read: ${error.message}`);
      this.state = { version: 1, projects: [], jobs: [], settings: {
        outputRoot: join(this.root, 'outputs'), ttsVoice: '', quality: 'production',
        pexelsApiKey: '', pixabayApiKey: '', jamendoClientId: '', jianyingDraftRoot: ''
      }};
    }
    this.state.settings = Object.fromEntries(['outputRoot', 'ttsVoice', 'quality',
      'pexelsApiKey', 'pixabayApiKey', 'jamendoClientId', 'jianyingDraftRoot']
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
  }
  snapshot() { return structuredClone(this.state); }
  save() {
    const content = JSON.stringify(this.state, null, 2);
    this.tail = this.tail.catch(() => {}).then(async () => {
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, content, 'utf8');
      // Windows Defender / search indexers can hold a freshly written file briefly;
      // retry the atomic rename a few times before surfacing EPERM.
      for (let attempt = 0; ; attempt += 1) {
        try {
          await rename(temporary, this.file);
          return;
        } catch (error) {
          if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
          if (attempt >= 4) throw error;
          await new Promise((done) => setTimeout(done, 120 * (attempt + 1)));
        }
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
