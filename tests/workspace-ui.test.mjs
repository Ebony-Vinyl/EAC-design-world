import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createEngine } from '../src/engine.mjs';
import { startServer } from '../src/server.mjs';

test('editor retains drafts, ignores stale reads and keeps dialogs keyboard accessible', { timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-workspace-ui-'));
  const engine = await createEngine({ dataDir: directory });
  const project = await engine.handle('design_project_create', { title: 'Workspace regression', kind: 'website' });
  const first = await engine.handle('design_artifact_save', { projectId: project.id, name: 'first.html', content: '<h1>First file</h1>' });
  const second = await engine.handle('design_artifact_save', { projectId: project.id, name: 'second.html', content: '<h1>Second file</h1>' });
  const app = await startServer({ engine, port: 0 });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.EAC_BROWSER ? { executablePath: process.env.EAC_BROWSER } : process.platform === 'win32' ? { channel: 'msedge' } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${app.url}/?view=design`, { waitUntil: 'domcontentloaded' });
    const openEditor = async () => {
      await page.getByRole('tab', { name: /^我的作品/ }).click();
      await page.getByRole('button', { name: '打开编辑', exact: true }).click();
    };
    await openEditor();
    const code = page.getByRole('textbox', { name: '文件内容', exact: true });
    await page.waitForFunction(() => document.querySelector('.dw-code')?.value === '<h1>First file</h1>');
    await code.fill('<h1>Unsaved draft</h1>');
    await page.locator('.dw-file').filter({ hasText: 'second.html' }).click();
    await page.waitForFunction(() => document.querySelector('.dw-code')?.value === '<h1>Second file</h1>');
    await page.locator('.dw-file').filter({ hasText: 'first.html' }).click();
    await page.waitForFunction(() => document.querySelector('.dw-code')?.value === '<h1>Unsaved draft</h1>');
    await page.getByRole('tab', { name: /^设计库/ }).first().click();
    await openEditor();
    await page.waitForFunction(() => document.querySelector('.dw-code')?.value === '<h1>Unsaved draft</h1>');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openEditor();
    await page.waitForFunction(() => document.querySelector('.dw-code')?.value === '<h1>Unsaved draft</h1>');
    await page.getByRole('button', { name: '保存新版本', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.dw-file.selected small')?.textContent === 'v2');
    assert.equal((await engine.designStore.readContent(first.id)).content, '<h1>Unsaved draft</h1>');

    let releaseRead;
    const blocked = new Promise(resolve => { releaseRead = resolve; });
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    await page.route(`**/api/design/artifacts/${first.id}/content*`, async route => {
      const response = await route.fetch();
      markStarted();
      await blocked;
      await route.fulfill({ response });
    });
    await page.locator('.dw-file').filter({ hasText: 'second.html' }).click();
    await page.waitForFunction(() => document.querySelector('.dw-code')?.value === '<h1>Second file</h1>');
    await page.locator('.dw-file').filter({ hasText: 'first.html' }).click();
    await started;
    assert.equal(await page.getByRole('button', { name: '保存新版本', exact: true }).isDisabled(), true);
    await page.locator('.dw-file').filter({ hasText: 'second.html' }).click();
    await page.waitForFunction(() => document.querySelector('.dw-code')?.value === '<h1>Second file</h1>');
    releaseRead();
    await page.unrouteAll({ behavior: 'wait' });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await code.inputValue(), '<h1>Second file</h1>');
    assert.equal((await engine.designStore.readContent(second.id)).revision, 1);
    await page.getByRole('textbox', { name: '文件名', exact: true }).fill('first.html');
    await page.getByRole('button', { name: '另存为新文件', exact: true }).click();
    await page.getByText('同名文件已存在，请使用其他文件名。', { exact: true }).waitFor();
    assert.equal((await engine.designStore.readContent(first.id)).revision, 2);
    await page.getByRole('textbox', { name: '文件名', exact: true }).fill('copy.html');
    await page.getByRole('button', { name: '另存为新文件', exact: true }).click();
    await page.locator('.dw-file.selected').filter({ hasText: 'copy.html' }).waitFor();
    assert.equal((await engine.designStore.readContent(second.id)).revision, 1);

    await page.getByRole('button', { name: '新建作品', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建设计作品', exact: true });
    await dialog.waitFor();
    assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true);
    await dialog.getByRole('button', { name: '创建作品', exact: true }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await dialog.getByRole('button', { name: '关闭', exact: true }).evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 0);
    assert.equal(await page.getByRole('button', { name: '新建作品', exact: true }).evaluate(element => element === document.activeElement), true);

    await mkdir('artifacts/workspace-review', { recursive: true });
    await page.screenshot({ path: 'artifacts/workspace-review/editor-desktop.png', fullPage: true });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 850 });
      await page.getByRole('tab', { name: '编辑内容', exact: true }).click();
      const overflow = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(overflow.scroll <= overflow.width + 1, JSON.stringify(overflow));
      await page.screenshot({ path: `artifacts/workspace-review/editor-${width}.png`, fullPage: true });
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.button').first().evaluate(element => getComputedStyle(element).transitionDuration), '1e-05s');
    await page.goto(app.url, { waitUntil: 'domcontentloaded' });
    await page.locator('.preview-stage .template-image').waitFor();
    assert.equal(await page.locator('.preview-stage video').count(), 0);
    await page.getByRole('button', { name: '预览所选模板', exact: true }).click();
    await page.getByRole('dialog', { name: '模板预览', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    const videoProject = await engine.handle('project_create', { title: 'Current production' });
    const output = join(directory, 'actual-project-output.mp4');
    await engine.store.updateProject(videoProject.id, item => { item.lastOutput = { path: output, revision: item.revision }; });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.preview-stage video').waitFor();
    assert.equal(new URL(await page.locator('.preview-stage video').getAttribute('src'), app.url).searchParams.get('path'), output);
    await page.getByRole('button', { name: '所选模板', exact: true }).click();
    await page.locator('.preview-stage .template-image').waitFor();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: 'artifacts/workspace-review/studio-desktop.png', fullPage: true });
    await page.locator('.app-topnav').getByRole('button', { name: /^视觉模板/ }).click();
    const search = page.getByRole('textbox', { name: '搜索模板', exact: true });
    await search.fill('no-such-template-519287');
    await page.getByText('没有匹配的内容', { exact: true }).waitFor();
    await page.getByRole('button', { name: '清除筛选', exact: true }).click();
    assert.equal(await search.inputValue(), '');
    await page.locator('.library-card').first().waitFor();
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 850 });
      await page.screenshot({ path: `artifacts/workspace-review/library-${width}.png`, fullPage: true });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await app.close();
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('output HTML is sandboxed and cannot mutate the workspace API', { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-output-sandbox-'));
  const engine = await createEngine({ dataDir: directory });
  const outputRoot = join(directory, 'outputs');
  await mkdir(outputRoot, { recursive: true });
  await engine.settingsUpdate({ outputRoot });
  const file = join(outputRoot, 'untrusted.html');
  await writeFile(file, '<!doctype html><h1>Output preview</h1><script>fetch("/api/design/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({title:"Injected project",kind:"website"})}).then(()=>document.body.dataset.result="allowed").catch(()=>document.body.dataset.result="blocked")</script>');
  const app = await startServer({ engine, port: 0 });
  let browser;
  try {
    const url = `${app.url}/api/files?path=${encodeURIComponent(file)}`;
    const response = await fetch(url);
    assert.match(response.headers.get('content-security-policy'), /sandbox allow-scripts/);
    assert.match(response.headers.get('content-security-policy'), /connect-src 'none'/);
    browser = await chromium.launch({ headless: true, ...(process.env.EAC_BROWSER ? { executablePath: process.env.EAC_BROWSER } : process.platform === 'win32' ? { channel: 'msedge' } : {}) });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.dataset.result === 'blocked');
    assert.equal((await engine.handle('design_state')).projects.length, 0);
  } finally {
    await browser?.close(); await app.close(); await engine.close();
    await rm(directory, { recursive: true, force: true });
  }
});
