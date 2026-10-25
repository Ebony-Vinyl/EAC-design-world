import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { browserLaunchOptions } from '../src/browser.mjs';
import { createEngine } from '../src/engine.mjs';
import { previewCsp } from '../src/preview-policy.mjs';
import { startServer } from '../src/server.mjs';

test('editor and deck srcdoc block outbound fetch while retaining scripts and local assets; canvas follows revisions', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-preview-policy-'));
  const engine = await createEngine({ dataDir: directory });
  const app = await startServer({ engine, port: 0 });
  let browser;
  let hits = 0;
  const collector = http.createServer((request, response) => { hits++; response.end('received'); });
  await new Promise(done => collector.listen(0, '127.0.0.1', done));
  try {
    const project = await engine.handle('design_project_create', { title: 'Isolation fixture', kind: 'deck' });
    const content = `<!doctype html><section class="slide"><h1>First</h1><img src="${app.url}/eac-avatar.jpg"></section><section class="slide">Second</section>
      <script>document.body.dataset.script='ran';fetch('http://127.0.0.1:${collector.address().port}/beacon',{mode:'no-cors'}).then(()=>document.body.dataset.probe='sent',()=>document.body.dataset.probe='blocked');</script>`;
    const artifact = await engine.handle('design_artifact_save', { projectId: project.id, name: 'deck.html', content });
    browser = await chromium.launch(browserLaunchOptions(chromium));
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    page.setDefaultTimeout(10000);
    await page.goto(`${app.url}/?view=design`);
    await page.getByRole('tab', { name: /^我的作品/ }).click();
    await page.getByRole('button', { name: '打开编辑', exact: true }).click();
    const preview = page.frameLocator('.dw-editor-preview iframe');
    await preview.locator('body[data-script="ran"][data-probe="blocked"]').waitFor();
    await preview.locator('img').evaluate(img => img.decode());
    assert.equal(hits, 0);
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await preview.locator('body[data-probe="blocked"]').waitFor();
    assert.equal(hits, 0);
    // A normal HTML document uses the same srcdoc path without deck splitting.
    const website = await engine.handle('design_project_create', { title: 'Website fixture', kind: 'website', sessionId: 'website-test' });
    const html = await engine.handle('design_artifact_save', { projectId: website.id, name: 'index.html', content: '<h1>Version ONE</h1>' });
    await page.goto(`${app.url}/?view=canvas&sessionId=website-test`);
    await page.locator('.dw-canvas-list button').filter({ hasText: 'index.html' }).click();
    const canvas = page.frameLocator('.dw-canvas-stage iframe');
    await canvas.getByRole('heading', { name: 'Version ONE' }).waitFor();
    await engine.handle('design_artifact_save', { projectId: website.id, name: 'index.html', revision: 1, content: '<h1>Version TWO</h1>' });
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await canvas.getByRole('heading', { name: 'Version TWO' }).waitFor();
    assert.match(await page.locator('.dw-canvas-stage iframe').getAttribute('src'), /revision=2/);
    const svg = await engine.handle('design_artifact_save', { projectId: website.id, name: 'image.svg', content: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>' });
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.locator('.dw-canvas-list button').filter({ hasText: 'image.svg' }).click();
    await page.locator('.dw-canvas-stage img').evaluate(img => img.decode());
    await engine.handle('design_artifact_save', { projectId: website.id, name: 'image.svg', revision: 1, content: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="blue"/></svg>' });
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.dw-canvas-stage img')?.src.endsWith('revision=2'));
    await page.locator('.dw-canvas-stage img').evaluate(img => img.decode());
    assert.equal(await page.locator('.dw-canvas-stage img').evaluate(img => img.naturalWidth), 20);
    assert.equal((await engine.designStore.readContent(artifact.id)).revision, 1);
    assert.equal((await engine.designStore.readContent(html.id)).revision, 2);
    assert.equal((await engine.designStore.readContent(svg.id)).revision, 2);
  } finally {
    await browser?.close();
    await new Promise(done => { collector.close(done); collector.closeAllConnections(); });
    await app.close(); await engine.close();
    await rm(directory, { recursive: true, force: true });
  }
});


test('preview resource aliases retain the service port and do not allow other local ports', () => {
  const policy = previewCsp('html', 'http://127.0.0.1:4173');
  assert.ok(policy.includes('http://localhost:4173'));
  assert.ok(!policy.includes('localhost:*'));
  assert.ok(!policy.includes('127.0.0.1:*'));
  assert.ok(policy.includes("connect-src 'none'"));
});
