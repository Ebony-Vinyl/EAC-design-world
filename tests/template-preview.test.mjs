import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createEngine } from '../src/engine.mjs';
import { startServer } from '../src/server.mjs';

const thumbnail = '/vendor/preview-test/thumbnail.svg';
const templateDefinitions = [
  {
    id: 'sc-preview-portrait', name: 'Portrait bridge', source: 'video-shotcraft', kind: 'motion',
    category: '产品演示', duration: 6, width: 1920, height: 1080, preview: '/vendor/preview-test/missing.mp4',
    entry: 'vendor/preview-test/portrait/index.html', thumbnail, renderable: true,
    description: '具有详细制作建议和较长元数据的模板。'.repeat(30),
    requirements: ['可定制的动态源文件与素材参考。'.repeat(15)],
    homepage: 'https://example.com', sourceUrl: 'https://example.com/original', recommended: { use: '功能发布', energy: 'high', recipe: 'product-demo' },
  },
  { id: 'sc-preview-image', name: 'Thumbnail fallback', source: 'video-shotcraft', kind: 'motion', preview: '/vendor/preview-test/missing.mp4', thumbnail },
  { id: 'sc-preview-error', name: 'Unavailable source', source: 'video-shotcraft', kind: 'motion', entry: 'vendor/preview-test/unavailable.html', thumbnail: '/vendor/preview-test/missing.jpg' },
  { id: 'sc-preview-video', name: 'Actual video', source: 'video-shotcraft', kind: 'motion', preview: '/vendor/open-design/templates/video/frame-product-promo/preview.mp4', thumbnail },
  { id: 'preview-classic', name: 'Classic source', source: 'motion-promo-film', kind: 'motion', entry: 'vendor/motion-promo-film/templates/film-template.html', width: 1920, height: 1080, duration: 12 },
];
const portrait = `<!doctype html><html><head><style>
html,body{margin:0;width:360px;height:640px;background:#18c6c0;color:#102c29;overflow:hidden}
#block{position:absolute;left:30px;top:100px;width:80px;height:80px;background:#f25558}
img{width:100px;height:60px}h1{font:32px sans-serif;padding:20px}
</style></head><body><h1>Portrait source</h1><div id="block"></div><img src="../../open-design/templates/video/frame-product-promo/preview.png">
<script>
window.__meta={w:360,h:640,dur:6};
window.renderAt=async t=>{await new Promise(resolve=>setTimeout(resolve,12));document.body.dataset.time=t.toFixed(3);document.getElementById('block').style.top=(100+t*30)+'px'};
window.__ready=true;
try{parent.document.body.dataset.escaped='yes'}catch{document.body.dataset.parentBlocked='yes'}
try{localStorage.setItem('escaped','yes')}catch{document.body.dataset.storageBlocked='yes'}
fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:'{"quality":"production"}'}).catch(()=>{document.body.dataset.fetchBlocked='yes'});
</script></body></html>`;

test('detail player scales opaque sources, controls deterministic playback, falls back and releases media', { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-template-preview-'));
  const fixtureDirectory = await mkdtemp(join(fileURLToPath(new URL('../vendor/', import.meta.url)), 'eac-preview-test-'));
  const fixtureBase = `/vendor/${basename(fixtureDirectory)}`;
  const templates = templateDefinitions.map(template => Object.fromEntries(Object.entries(template).map(([key, value]) => [
    key, typeof value === 'string' ? value.replace('vendor/preview-test/', `vendor/${basename(fixtureDirectory)}/`) : value,
  ])));
  await mkdir(join(fixtureDirectory, 'portrait'));
  await writeFile(join(fixtureDirectory, 'portrait', 'index.html'), portrait);
  await writeFile(join(fixtureDirectory, 'thumbnail.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="640"><rect width="360" height="640" fill="#18c6c0"/><circle cx="180" cy="320" r="90" fill="#f25558"/></svg>');
  const engine = await createEngine({ dataDir: directory });
  const app = await startServer({ engine, port: 0 });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.EAC_BROWSER ? { executablePath: process.env.EAC_BROWSER } : process.platform === 'win32' ? { channel: 'msedge' } : {}) });
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    page.setDefaultTimeout(12000);
    const errors = [], writes = [], consoleErrors = [], assetRequests = [];
    let releaseSource;
    const sourceGate = new Promise(resolve => { releaseSource = resolve; });
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('requestfailed', request => assetRequests.push({ url: request.url(), failure: request.failure()?.errorText }));
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'PUT' && request.url().endsWith('/api/settings')) writes.push(request.url()); });
    await page.route('**/api/library', route => route.fulfill({ json: { templates, designSystems: [] } }));
    await page.route(`**${fixtureBase}/portrait/index.html*`, async route => {
      if (route.request().method() === 'HEAD') await sourceGate;
      await route.continue();
    });
    await page.goto(`${app.url}/?view=templates&mode=edit&selected=sc-preview-portrait`);
    const open = async item => {
      await page.getByRole('textbox', { name: '搜索模板', exact: true }).fill(item.id);
      await page.getByRole('button', { name: `预览${item.name}`, exact: true }).click();
      await page.getByRole('dialog', { name: '模板预览', exact: true }).waitFor();
    };
    const close = () => page.getByRole('button', { name: '关闭', exact: true }).click();
    const player = page.locator('.tp-player');
    await open(templates[0]);
    await page.locator('.tp-player[data-preview-mode="source"][data-preview-status="loading"]').waitFor();
    await player.getByText('正在载入预览', { exact: true }).waitFor();
    releaseSource();
    await page.locator('.tp-player[data-preview-mode="source"][data-preview-status="ready"]').waitFor();
    const iframe = page.locator('iframe[title="Portrait bridge模板源码预览"]');
    const source = page.frameLocator('iframe[title="Portrait bridge模板源码预览"]');
    const sourceFrame = await (await iframe.elementHandle()).contentFrame();
    assert.equal(await iframe.getAttribute('sandbox'), 'allow-scripts');
    assert.equal(await iframe.getAttribute('srcdoc'), null);
    assert.equal(new URL(sourceFrame.url()).pathname, `${fixtureBase}/portrait/index.html`);
    assert.equal(new URL(sourceFrame.url()).searchParams.get('eac-preview'), '1');
    await source.locator('body[data-fetch-blocked="yes"]').waitFor();
    assert.equal(await source.locator('body').getAttribute('data-parent-blocked'), 'yes');
    assert.equal(await source.locator('body').getAttribute('data-storage-blocked'), 'yes');
    assert.deepEqual(writes, []);
    assert.equal(await page.locator('body').getAttribute('data-escaped'), null);
    const imageState = await source.locator('img').evaluate(image => ({ complete: image.complete, width: image.naturalWidth, src: image.src, base: document.baseURI }));
    assert.ok(imageState.complete && imageState.width > 0, JSON.stringify({ imageState, consoleErrors, assetRequests }));
    assert.equal(await source.locator('body').getAttribute('data-time'), '0.000');
    await page.getByRole('button', { name: '取消选择', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '取消选择', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByRole('link', { name: '查看原始来源', exact: true }).getAttribute('href'), 'https://example.com/original');
    for (const text of ['功能发布', 'high', 'product-demo', '6 秒']) await page.getByText(text, { exact: true }).waitFor();
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await sourceFrame.waitForFunction(() => Number(document.body.dataset.time) > 0.2);
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await page.getByRole('button', { name: '播放', exact: true }).waitFor();
    const paused = await source.locator('body').getAttribute('data-time');
    await page.waitForTimeout(180);
    assert.equal(await source.locator('body').getAttribute('data-time'), paused);
    await page.getByRole('slider', { name: '预览进度', exact: true }).evaluate(input => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '3');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await source.locator('body[data-time="3.000"]').waitFor();
    await page.getByRole('slider', { name: '预览进度', exact: true }).evaluate(input => {
      for (const value of ['1', '2', '4']) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await source.locator('body[data-time="4.000"]').waitFor();
    await page.getByRole('button', { name: '重播', exact: true }).click();
    await sourceFrame.waitForFunction(() => Number(document.body.dataset.time) < 1);
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await mkdir('artifacts/preview-review', { recursive: true });
    for (const viewport of [{ width: 1400, height: 1000 }, { width: 390, height: 950 }, { width: 320, height: 600 }]) {
      const { width, height } = viewport;
      await page.setViewportSize(viewport);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const box = await iframe.boundingBox();
      const container = await page.locator('.tp-source-viewport').boundingBox();
      assert.ok(Math.abs(box.width / box.height - 360 / 640) < 0.002, JSON.stringify(box));
      assert.ok(box.x >= container.x - 1 && box.y >= container.y - 1 && box.x + box.width <= container.x + container.width + 1 && box.y + box.height <= container.y + container.height + 1);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      const action = page.getByRole('button', { name: '取消选择', exact: true });
      const actionBox = await action.boundingBox();
      assert.ok(actionBox.y >= 0 && actionBox.y + actionBox.height <= height, JSON.stringify({ actionBox, viewport }));
      await page.locator('.tp-detail-content').evaluate(content => { content.scrollTop = content.scrollHeight; });
      const scrolledActionBox = await action.boundingBox();
      assert.ok(Math.abs(scrolledActionBox.y - actionBox.y) < 1);
      await page.locator('.tp-detail-content').evaluate(content => { content.scrollTop = 0; });
      await page.screenshot({ path: `artifacts/preview-review/portrait-${width}.png`, fullPage: true });
    }
    await page.getByRole('button', { name: '取消选择', exact: true }).click();
    assert.equal(await page.getByRole('dialog').count(), 0);
    await open(templates[0]);
    await page.getByRole('button', { name: '使用此模板', exact: true }).waitFor();
    await close();
    assert.equal(await page.locator('iframe').count(), 0);
    await open(templates[1]);
    await page.locator('.tp-player[data-preview-mode="image"][data-preview-status="ready"]').waitFor();
    assert.match(await player.innerText(), /当前显示参考图/);
    await page.getByRole('button', { name: '重试预览', exact: true }).click();
    await page.locator('.tp-player[data-preview-mode="image"][data-preview-status="ready"]').waitFor();
    await close();
    await open(templates[2]);
    await page.locator('.tp-player[data-preview-status="error"]').waitFor();
    await page.getByText('暂无可用预览', { exact: true }).waitFor();
    await close();
    await page.setViewportSize({ width: 1400, height: 950 });
    await open(templates[3]);
    await page.locator('.tp-player[data-preview-mode="video"][data-preview-status="ready"]').waitFor();
    const video = await player.locator('video').elementHandle();
    assert.equal(await video.evaluate(media => media.controls && media.videoWidth > 0), true);
    await video.evaluate(media => media.play());
    await page.waitForFunction(() => document.querySelector('.tp-player video')?.currentTime > 0.2);
    await close();
    assert.equal(await video.evaluate(media => media.paused && !media.getAttribute('src')), true);
    await open(templates[4]);
    await page.locator('.tp-player[data-preview-mode="source"][data-preview-status="ready"]').waitFor();
    const classicFrame = await (await page.locator('iframe').elementHandle()).contentFrame();
    assert.equal(await classicFrame.evaluate(() => typeof window.__seek), 'function');
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await page.waitForFunction(() => Number(document.querySelector('.tp-controls input')?.value) > 0.2);
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    const classicBox = await page.locator('iframe').boundingBox();
    assert.ok(Math.abs(classicBox.width / classicBox.height - 1920 / 1080) < 0.002);
    await page.screenshot({ path: 'artifacts/preview-review/classic-desktop.png', fullPage: true });
    await close();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await app.close();
    await engine.close();
    await rm(directory, { recursive: true, force: true });
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});
