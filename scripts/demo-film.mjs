import { chromium } from 'playwright';
import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { renderTemplate } from '../src/render-template.mjs';
import { composeMusic, synthesizeVoice, renderTimeline, qualityCheck } from '../src/media/index.mjs';

const root = resolve('examples/eac-launch');
const output = resolve('artifacts/eac-launch');
await mkdir(output, { recursive: true });
const url = process.env.EAC_URL || 'http://127.0.0.1:4173';
async function api(path, args) {
  const response = await fetch(`${url}/api${path}`, { method: args ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' }, ...(args ? { body: JSON.stringify(args) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
let state = await api('/state');
let project = state.projects.find((p) => p.title === 'EAC design world · 实机示例');
if (!project) project = await api('/projects', { title: 'EAC design world · 实机示例',
  brief: '录制真实工作台、选择视觉模板、AI 剪辑、字幕、配音配乐与审片。', templateId: 'motion-promo-film-v2', width: 1920, height: 1080, fps: 30 });
console.log(`Demo project: ${project.id}`);
const validation = JSON.parse(await readFile(resolve('artifacts/validation/report.json'), 'utf8'));
if (!project.assets.length) await api(`/projects/${project.id}/assets`, { path: validation.output });
if (!project.clips.length) await api(`/projects/${project.id}/plan`, { duration: 12, bpm: 100 });
const capture = await api('/jobs', { projectId: project.id, type: 'record-browser', params: {
  url, actions: [
    { type: 'wait', ms: 1400 },
    { type: 'click', selector: 'nav .nav-item:nth-child(2)' },
    { type: 'wait', ms: 3400 },
    { type: 'click', selector: 'nav .nav-item:nth-child(3)' },
    { type: 'wait', ms: 3000 },
    { type: 'click', selector: 'nav .nav-item:nth-child(5)' },
    { type: 'wait', ms: 2400 }
  ]
}});
let captureJob;
do {
  await new Promise((done) => setTimeout(done, 500));
  captureJob = await api(`/jobs/${capture.id}`);
} while (['running', 'queued'].includes(captureJob.status));
if (captureJob.status !== 'completed') throw new Error(captureJob.error);
await copyFile(captureJob.result.path, join(root, 'capture.mp4'));
console.log('Actual product capture completed.');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.addInitScript((id) => localStorage.setItem('eac:project', id), project.id);
  await page.goto(url);
  await page.waitForSelector('.app-shell');
  await page.locator('.brand-mark').screenshot({ path: join(root, 'brand.png') });
  for (const [image, nav] of [['studio', 1], ['templates', 2], ['workflow', 3], ['outputs', 5]]) {
    await page.locator(`nav .nav-item:nth-child(${nav})`).click();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(root, `${image}.png`) });
  }
} finally { await browser.close(); }
const musicPath = join(output, 'music.wav'), voicePath = join(output, 'voice.wav');
await composeMusic({ outputPath: musicPath, duration: 24, bpm: 100, seed: 26 });
await synthesizeVoice({ outputPath: voicePath,
  text: 'EAC design world。从真实产品录制开始。选择视觉语言，让镜头、旁白与音乐合拍。保留素材，持续精修。创作，自成世界。' });
console.log('Narration and original music generated.');
const picture = join(output, 'picture.mp4');
await renderTemplate({ templateId: 'motion-promo-film-v2', htmlPath: join(root, 'film.html'), outputPath: picture,
  duration: 24, fps: 30, onProgress: (progress) => { if (Math.round(progress * 100) % 10 === 0) console.log(`Picture ${Math.round(progress * 100)}%`); } });
const deliverable = join(output, 'EAC-design-world-launch.mp4');
await renderTimeline({ project: { width: 1920, height: 1080, fps: 30, quality: 'production',
  clips: [{ id: 'motion-picture', path: picture, kind: 'video', start: 0, sourceIn: 0, duration: 24, volume: 1, track: 0 }],
  musicPath, voicePath }, outputPath: deliverable });
const qa = await qualityCheck({ path: deliverable, expectedDuration: 24 });
await writeFile(join(output, 'qa.json'), JSON.stringify(qa, null, 2));
await writeFile(join(output, 'provenance.json'), JSON.stringify({ projectId: project.id, captureJobId: capture.id,
  sourceCapture: captureJob.result.path, recipe: root, deliverable, duration: 24, bpm: 100, voice: 'Windows SAPI', music: 'EAC local synthesizer' }, null, 2));
console.log(JSON.stringify({ deliverable, qa: qa.ok, warnings: qa.warnings }));
