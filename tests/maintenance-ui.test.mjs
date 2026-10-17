import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { createEngine } from '../src/engine.mjs';
import { startServer } from '../src/server.mjs';
import { VERSION } from '../src/version.mjs';

test('maintenance UI reports versions, persists acknowledgements and detects failed reload', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-maintenance-ui-'));
  const engine = await createEngine({ dataDir: directory });
  const app = await startServer({ engine, port: 0, maintenanceOptions: { mode: 'harness', feedSources: [], reload: async () => ({ ok: false, restored: true, error: '测试：新模块激活失败，旧模块已保留' }) } });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.EAC_BROWSER ? { executablePath: process.env.EAC_BROWSER } : process.platform === 'win32' ? { channel: 'msedge' } : {}) });
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${app.url}/?view=maintenance`, { waitUntil: 'domcontentloaded' });
    const maintenanceNav = page.locator('.app-topnav').getByRole('button', { name: '插件维护', exact: true });
    await maintenanceNav.waitFor();
    assert.match(await maintenanceNav.getAttribute('class'), /active/);
    await page.locator('.app-topnav').getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '输出与制作', exact: true }).waitFor();
    assert.equal(await page.locator('.mt-panel').count(), 0);
    await maintenanceNav.click();
    await page.getByRole('heading', { name: '插件维护.', exact: true }).waitFor();
    await page.getByText(`运行版本 ${VERSION}`, { exact: true }).waitFor();
    await page.getByText(`磁盘版本 ${VERSION}`, { exact: true }).waitFor();
    await page.getByRole('heading', { name: '0.3.0：工具修复与插件维护中心', exact: true }).waitFor();
    await page.getByRole('button', { name: '将公告「0.3.0：工具修复与插件维护中心」标记为已读', exact: true }).click();
    await page.getByRole('button', { name: '将公告「0.3.0：工具修复与插件维护中心」标记为已读', exact: true }).waitFor({ state: 'detached' });
    assert.equal(app.maintenance.status().announcements.unread, 0);
    await page.getByRole('button', { name: '热重载插件', exact: true }).click();
    await page.getByText('测试：新模块激活失败，旧模块已保留', { exact: false }).first().waitFor({ timeout: 15000 });
    assert.equal(app.maintenance.status().operation.status, 'failed');
    assert.equal(await page.getByText(/重载已完成/).count(), 0);
    await mkdir('artifacts/maintenance-qa', { recursive: true });
    await page.screenshot({ path: 'artifacts/maintenance-qa/maintenance-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 600, height: 850 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: 'artifacts/maintenance-qa/maintenance-600px.png', fullPage: true });
    await page.setViewportSize({ width: 320, height: 850 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: 'artifacts/maintenance-qa/maintenance-320px.png', fullPage: true });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); await app.close(); await engine.close(); await rm(directory, { recursive: true, force: true });
  }
});
