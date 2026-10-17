import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createEngine } from '../src/engine.mjs';
import { startServer } from '../src/server.mjs';
import { probeMedia } from '../src/media/index.mjs';

const directory = resolve('artifacts/motion-libraries-qa');
await mkdir(directory, { recursive: true });
const engine = await createEngine({ dataDir: join(directory, 'data') });
await engine.settingsUpdate({ outputRoot: join(directory, 'outputs') });
const app = await startServer({ engine, port: 0 });
const checks = [];
const waitJob = async id => {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const job = await engine.handle('job_status', { jobId: id });
    if (!['queued', 'running'].includes(job.status)) {
      assert.equal(job.status, 'completed', job.error);
      return job.result;
    }
    await new Promise(done => setTimeout(done, 250));
  }
  throw new Error(`Job deadline exceeded: ${id}`);
};
try {
  const library = await engine.library();
  const items = library.templates.filter(item => ['motion-web', 'onetake'].includes(item.source));
  assert.equal(items.filter(item => item.source === 'motion-web').length, 7, 'import motion-web before running verification');
  assert.equal(items.filter(item => item.source === 'onetake').length, 1, 'import onetake before running verification');
  for (const item of items) {
    const source = await engine.handle('library_read', { kind: 'template', id: item.id, source: true });
    assert.ok(source.entry.text.includes('<html'));
    const response = await fetch(`${app.url}/${item.entry}`);
    assert.equal(response.status, 200, item.id);
    assert.match(response.headers.get('content-security-policy'), /sandbox allow-scripts/);
    assert.doesNotMatch(response.headers.get('content-security-policy'), /allow-same-origin/);
    const found = await engine.handle('library_list', { kind: 'motion', query: item.id });
    assert.ok(found.items.some(row => row.id === item.id));
  }
  checks.push('8 optional templates searchable/readable; original HTML served in opaque-origin sandboxes');
  for (const id of ['motion-web-skill', 'onetake-skill']) {
    const skill = await engine.handle('library_read', { kind: 'skill', id });
    assert.ok(skill.content.length > 1000);
  }
  checks.push('Both upstream authoring guides readable through plugin tools');
  const project = await engine.handle('project_create', { title: 'Onetake integration verification', templateId: 'onetake-studio' });
  const queued = await engine.handle('job_submit', { projectId: project.id, type: 'render-template', params: { fps: 12, scale: 0.5 } });
  const rendered = await waitJob(queued.id);
  assert.equal(rendered.duration, 8, '__meta.dur must determine the complete composition length');
  assert.equal(rendered.deterministic, true);
  assert.equal(rendered.missingAssets.length, 0);
  assert.equal(rendered.qa.ok, true);
  const video = await probeMedia(rendered.path);
  assert.equal(video.width, 960);
  assert.equal(video.height, 540);
  checks.push('Onetake 8s 960×540 MP4: deterministic seek, OM dependency loaded, media QA passed');
  const { renderTemplate } = await import('../src/render-template.mjs');
  await assert.rejects(renderTemplate({ templateId: 'mw-string-clock', outputPath: join(directory, 'invalid.mp4') }), /实时交互/);
  checks.push('Interactive motion-web pages rejected by deterministic renderer with recording guidance');
  const interactive = await engine.handle('project_create', { title: 'Motion Web live recording verification', templateId: 'mw-wheel-rail', width: 960, height: 600 });
  const recording = await engine.handle('job_submit', { projectId: interactive.id, type: 'record-browser', params: {
    url: `${app.url}/vendor/motion-web/cases/wheel-rail/index.html`, actions: [
      { type: 'move', x: 480, y: 300, steps: 20 }, { type: 'wheel', deltaY: 700 }, { type: 'wait', ms: 1100 },
      { type: 'move', x: 780, y: 180, steps: 30 }, { type: 'wheel', deltaY: 700 }, { type: 'wait', ms: 1100 },
    ],
  } });
  const recorded = await waitJob(recording.id);
  assert.ok((await probeMedia(recorded.path)).duration >= 2);
  checks.push('Motion Web live page recorded as playable video and imported into video project');
  const report = { ok: true, checks, onetake: rendered, motionWeb: recorded };
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, checks, onetake: rendered.path, motionWeb: recorded.path, report: join(directory, 'report.json') }, null, 2));
} finally {
  await app.close();
  await engine.close();
}
