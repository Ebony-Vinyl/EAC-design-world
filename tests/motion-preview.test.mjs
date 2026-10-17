import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { createEngine } from '../src/engine.mjs';
import { startServer } from '../src/server.mjs';
import { motionTemplates } from '../src/motion-libraries.mjs';

const optional = motionTemplates();
test('optional templates preview and retain dynamic assets after design project creation', { skip: optional.length !== 8, timeout: 90000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'eac-motion-preview-'));
  const engine = await createEngine({ dataDir });
  const app = await startServer({ engine, port: 0 });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.EAC_BROWSER ? { executablePath: process.env.EAC_BROWSER } : process.platform === 'win32' ? { channel: 'msedge' } : {}) });
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    page.setDefaultTimeout(10000);
    const errors = [], missing = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400 && /\/vendor\/(?:motion-web|onetake|eac-motion)\//.test(response.url())) missing.push(response.url()); });
    await page.goto(`${app.url}/?view=templates&mode=edit`);
    await page.getByRole('textbox', { name: '搜索模板', exact: true }).fill('mw-');
    await page.getByRole('button', { name: '预览Motion Web · 软体时钟', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /^预览Motion Web/ }).count(), 7);
    for (const item of optional) {
      await page.getByRole('textbox', { name: '搜索模板', exact: true }).fill(item.id);
      await page.getByRole('button', { name: `预览${item.name}`, exact: true }).click();
      const frame = page.frameLocator(`iframe[title="${item.name}模板源码预览"]`);
      await frame.locator('body').waitFor();
      await frame.locator('body').evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map(image => image.decode()));
        if (window.__probe?.reason) throw new Error(window.__probe.reason);
      });
      await page.getByRole('button', { name: '关闭', exact: true }).click();
    }
    await page.goto(`${app.url}/?view=design`);
    await page.getByRole('tab', { name: /^创作模板/ }).click();
    await page.getByRole('textbox', { name: '搜索设计库', exact: true }).fill('mw-toy-flipbook');
    await page.getByRole('button', { name: '使用', exact: true }).click();
    await page.getByRole('textbox', { name: '作品名称', exact: true }).fill('Dynamic asset regression');
    await page.getByRole('button', { name: '创建作品', exact: true }).click();
    await page.getByRole('textbox', { name: '文件内容', exact: true }).waitFor();
    const frame = page.frameLocator('iframe[title="index.html 预览"]');
    await frame.locator('img').first().waitFor();
    await frame.locator('body').evaluate(async () => { await Promise.all([...document.images].map(image => image.decode())); });
    const state = await engine.handle('design_state');
    const artifact = state.projects[0].artifacts[0];
    const content = await engine.designStore.readContent(artifact.id);
    assert.match(content.content, /<base href="\/vendor\/motion-web\/cases\/toy-flipbook\/">/);
    await page.goto(`${app.url}${artifact.url}`);
    await page.locator('img').first().waitFor();
    await page.evaluate(async () => { await Promise.all([...document.images].map(image => image.decode())); });
    assert.deepEqual(missing, []);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await app.close();
    await engine.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
