import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../src/engine.mjs';
import { startServer } from '../src/server.mjs';

test('real HTML deck exports PDF, PNG and a two-slide PowerPoint with explicit image fidelity', { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-design-export-'));
  const engine = await createEngine({ dataDir: directory });
  const app = await startServer({ engine, port: 0 });
  try {
    const project = await engine.handle('design_project_create', { title: 'Two slides', kind: 'deck' });
    const artifact = await engine.handle('design_artifact_save', { projectId: project.id, name: '演示稿.html', content: '<!doctype html><style>body{margin:0}.slide{width:1280px;height:720px;background:#227b70;color:white;font:64px system-ui}</style><section class="slide">One</section><section class="slide" style="background:#222">Two</section>' });
    for (const format of ['pdf', 'png', 'pptx']) {
      const response = await fetch(`${app.url}/api/design/artifacts/${artifact.id}/export/${format}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: 1 }) });
      assert.equal(response.status, 201, await response.clone().text());
      const result = await response.json();
      const download = await fetch(`${app.url}${result.url}`);
      assert.equal(download.status, 200);
      assert.match(download.headers.get('content-disposition'), /attachment/);
      const bytes = Buffer.from(await download.arrayBuffer());
      assert.ok(bytes.length > 500);
      if (format === 'pdf') assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
      if (format === 'png') assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
      if (format === 'pptx') {
        assert.equal(bytes.subarray(0, 2).toString(), 'PK');
        assert.equal(result.slides, 2);
        assert.equal(result.editableElements, false);
        assert.match(result.warning, /整页图像/);
        const { default: JSZip } = await import('jszip');
        const zip = await JSZip.loadAsync(bytes);
        const slides = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
        assert.equal(slides.length, 2);
        assert.match(await zip.file(slides[0]).async('string'), /<p:pic>/);
      }
    }
    assert.equal((await engine.designStore.readContent(artifact.id)).revision, 1);
  } finally { await app.close(); await engine.close(); await rm(directory, { recursive: true, force: true }); }
});
