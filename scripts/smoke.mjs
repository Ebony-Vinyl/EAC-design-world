import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createEngine } from '../src/engine.mjs';
import { startServer } from '../src/server.mjs';

const directory = resolve('artifacts/validation');
await mkdir(directory, { recursive: true });
const engine = await createEngine({ dataDir: join(directory, 'state') });
const app = await startServer({ engine, port: 0 });
const errors = [];
try {
  const project = await engine.handle('project_create', {
    title: 'EAC design world 自主制作验证', templateId: 'motion-promo-film-v2',
    brief: '真实录制本地工作台，导入、原创配乐、本地中文旁白、输出带声音视频与检查报告。',
    width: 1280, height: 720, fps: 30
  });
  const job = await engine.handle('job_submit', { projectId: project.id, type: 'produce', params: {
    url: app.url, duration: 12, bpm: 100,
    narration: 'EAC design world。从真实产品录制开始，选择视觉模板，编排镜头与声音。让人工智能和你，在同一个工程里完成创作。',
    actions: [
      { type: 'wait', ms: 1800 },
      { type: 'click', selector: 'nav .nav-item:nth-child(2)' },
      { type: 'wait', ms: 2400 },
      { type: 'scroll', deltaY: 500 },
      { type: 'wait', ms: 1800 },
      { type: 'click', selector: 'button[aria-label="打开设置"]' },
      { type: 'wait', ms: 2200 },
      { type: 'click', selector: 'nav .nav-item:nth-child(1)' },
      { type: 'wait', ms: 1800 }
    ]
  }});
  console.log(`Production job: ${job.id}`);
  let result;
  const deadline = Date.now() + 300000;
  let previous;
  while (Date.now() < deadline) {
    result = await engine.handle('job_status', { jobId: job.id });
    const status = `${result.status} ${result.stage || ''} ${Math.round(result.progress * 100)}%`;
    if (status !== previous) console.log(status);
    previous = status;
    if (!['running', 'queued'].includes(result.status)) break;
    await new Promise((done) => setTimeout(done, 400));
  }
  if (result.status !== 'completed') throw new Error(result.error || 'Validation timed out');
  console.log(`Actual output: ${result.result.path}`);
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(app.url);
      await page.waitForSelector('.nav-item');
      await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      if (overflow) errors.push(`${name}: horizontal overflow`);
      await page.close();
    }
  } finally { await browser.close(); }
  const report = { testedAt: new Date().toISOString(), projectId: project.id, jobId: job.id,
    output: result.result.path, qa: result.result.qa, uiErrors: errors };
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  if (errors.length) throw new Error(errors.join('; '));
  console.log(`Validation report: ${join(directory, 'report.json')}`);
} finally {
  await app.close();
  await engine.close();
}
