import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { getTemplates } from '../src/catalog.mjs';
import { createEngine } from '../src/engine.mjs';
import { startServer } from '../src/server.mjs';

const shots = getTemplates().filter(item => item.source === 'video-shotcraft');
test('real Shotcraft picker supports bounded video playback, filters, persistent shotlists and mobile layouts',
  { skip: shots.length === 0, timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eac-shot-picker-'));
    const engine = await createEngine({ dataDir: directory });
    const app = await startServer({ engine, port: 0 });
    let browser;
    try {
      browser = await chromium.launch({ headless: true, ...(process.env.EAC_BROWSER
        ? { executablePath: process.env.EAC_BROWSER } : process.platform === 'win32' ? { channel: 'msedge' } : {}) });
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      const errors = [];
      const missing = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('response', response => {
        if (response.status() >= 400 && /\/vendor\/video-shotcraft\/.*\.(mp4|jpg|png|html)/.test(response.url())) missing.push(response.url());
      });
      await page.goto(`${app.url}/?view=templates`);
      const source = () => page.getByRole('group', { name: '模板来源' }).getByRole('button', { name: /SHOTCRAFT/ });
      await source().click();
      await page.locator('.library-picker[data-source="video-shotcraft"]').waitFor();
      assert.equal(await page.locator('.library-card').count(), Math.min(24, shots.length));
      await page.waitForFunction(() => [...document.querySelectorAll('.library-motion-video')].some(video => !video.paused && video.readyState >= 2));
      assert.ok(await page.locator('.library-motion-video').evaluateAll(videos => videos.filter(video => !video.paused).length <= 3));
      assert.ok(await page.locator('.library-card .library-cover').first().evaluate(image => image.complete && image.naturalWidth > 0));

      await page.getByRole('switch', { name: '自动播放预览' }).uncheck();
      await page.locator('.library-motion-heading').hover();
      await page.waitForFunction(() => [...document.querySelectorAll('.library-motion-video')].every(video => video.paused));
      await page.locator('.library-card-cover').first().hover();
      await page.waitForFunction(() => [...document.querySelectorAll('.library-motion-video')].some(video => !video.paused));
      await page.locator('.library-motion-heading').hover();
      await page.waitForFunction(() => [...document.querySelectorAll('.library-motion-video')].every(video => video.paused));

      const firstName = await page.locator('.library-card h3').first().textContent();
      const secondName = await page.locator('.library-card h3').nth(1).textContent();
      await page.getByRole('button', { name: `加入选片单${firstName}`, exact: true }).click();
      await page.getByRole('button', { name: `加入选片单${secondName}`, exact: true }).click();
      await page.getByRole('button', { name: '复制名单', exact: true }).click();
      const clipboard = await page.evaluate(() => navigator.clipboard.readText());
      assert.ok(clipboard.includes(firstName) && clipboard.includes(secondName) && clipboard.includes('[sc-'));
      await page.getByRole('button', { name: `选择${firstName}`, exact: true }).click();
      assert.equal(await page.locator('.library-card.selected h3').textContent(), firstName);

      await page.getByRole('button', { name: `预览${firstName}`, exact: true }).click();
      const detail = page.getByRole('dialog', { name: '模板预览', exact: true });
      await detail.waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll('.library-motion-video')].every(video => video.paused));
      await detail.locator('video').waitFor();
      await detail.locator('video').evaluate(video => video.play());
      await page.waitForFunction(() => document.querySelector('[role=dialog] video')?.currentTime > 1.2);
      await mkdir('artifacts/shotcraft-polish', { recursive: true });
      await page.screenshot({ path: 'artifacts/shotcraft-polish/preview-desktop.png' });
      await page.keyboard.press('Escape');
      assert.equal(await detail.count(), 0);

      const category = shots.find(item => item.category === '转场')?.category || shots[0].category;
      await page.getByRole('combobox', { name: '模板分类' }).selectOption(category);
      const expected = shots.filter(item => item.category === category).length;
      assert.equal(await page.locator('.library-card').count(), Math.min(expected, 24));
      await page.getByRole('combobox', { name: '模板分类' }).selectOption('全部');
      await page.getByRole('textbox', { name: '搜索模板', exact: true }).fill('nonexistent-shot-581919');
      await page.getByText('没有匹配的内容', { exact: true }).waitFor();
      await page.getByRole('button', { name: '清除筛选', exact: true }).click();
      await source().click();
      await page.getByRole('group', { name: '镜头视图' }).getByRole('button', { name: /精选/ }).click();
      assert.equal(await page.locator('.library-card').count(), Math.min(24, shots.filter(item => item.recommended).length));
      await page.reload();
      await source().click();
      await page.getByRole('group', { name: '镜头视图' }).getByRole('button', { name: /选片单/ }).click();
      assert.equal(await page.locator('.library-card').count(), 2);
      await page.getByRole('button', { name: `移出选片单${firstName}`, exact: true }).click();
      assert.equal(await page.locator('.library-card').count(), 1);
      await page.getByRole('group', { name: '镜头视图' }).getByRole('button', { name: '全部', exact: true }).click();
      await page.getByRole('button', { name: '加入当前页到选片单', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: '加入当前页到选片单', exact: true }).isDisabled(), true);

      for (const width of [1440, 768, 390, 320]) {
        await page.setViewportSize({ width, height: width === 320 ? 600 : 900 });
        await page.locator('.library-motion-heading').hover();
        const layout = await page.evaluate(() => ({
          width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
          height: innerHeight, scrollHeight: document.documentElement.scrollHeight,
          browserHeight: document.querySelector('.library-picker-scroll').clientHeight,
          overflowingControls: [...document.querySelectorAll('.library-picker-controls button, .library-shotlist-actions button')]
            .filter(node => { const rect = node.getBoundingClientRect(); return rect.width && node.scrollWidth > node.clientWidth + 2; })
            .map(node => node.textContent),
        }));
        assert.ok(layout.scrollWidth <= layout.width + 1, JSON.stringify(layout));
        assert.ok(layout.scrollHeight <= layout.height + 1, JSON.stringify(layout));
        assert.ok(layout.browserHeight > 100, JSON.stringify(layout));
        assert.deepEqual(layout.overflowingControls, []);
        await page.screenshot({ path: `artifacts/shotcraft-polish/picker-${width}.png` });
      }
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.reload();
      assert.equal(await page.getByRole('switch', { name: '自动播放预览' }).isChecked(), false);
      const project = await engine.handle('project_create', { title: 'Shot picker import regression', width: 320, height: 180, fps: 12 });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(app.url);
      await page.locator('.app-topnav').getByRole('button', { name: /^视觉模板/ }).click();
      await source().click();
      await page.getByRole('button', { name: '清空选片单', exact: true }).click();
      for (const name of [firstName, secondName]) await page.getByRole('button', { name: `加入选片单${name}`, exact: true }).click();
      await page.getByRole('button', { name: '导入选片到项目素材', exact: true }).click();
      await page.getByText('已导入 2 个镜头', { exact: true }).waitFor();
      const imported = await engine.handle('project_get', { projectId: project.id });
      assert.equal(imported.assets.length, 2);
      assert.ok(imported.assets.every(asset => asset.kind === 'video' && asset.duration > 0));
      await page.getByRole('button', { name: `选择${firstName}`, exact: true }).click();
      await page.getByRole('button', { name: `取消选择${firstName}`, exact: true }).click();
      assert.equal(await page.locator('.library-card.selected').count(), 0);
      await page.getByRole('button', { name: `选择${firstName}`, exact: true }).click();
      await page.screenshot({ path: 'artifacts/shotcraft-polish/project-import.png', fullPage: true });
      await page.locator('.app-topnav').getByRole('button', { name: '制作工作台', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: '渲染所选模板', exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: '渲染项目', exact: true }).isDisabled(), false);
      assert.deepEqual(errors, []);
      assert.deepEqual(missing, []);
    } finally {
      await browser?.close(); await app.close(); await engine.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
