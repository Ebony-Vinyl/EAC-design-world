import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createEngine } from '../src/engine.mjs';
import { startServer } from '../src/server.mjs';
import { removeScalarOverride, resolveGradingValues } from '../ui/grading-values.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CUBE = 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';
const colorWorkflowReady = existsSync(join(ROOT, 'src', 'color-workflow.mjs'));

let directory;
let engine;
let app;
let vite;
let browser;
let base;
let project;
let shot;
let inputLut;
let creativeLut;

function fixtureClips(id) {
  return [{ id: `${id}-clip`, assetId: `${id}-asset`, path: shot, kind: 'video', start: 0, duration: 2, sourceIn: 0, volume: 1, track: 0 }];
}

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'eac-export-ui-'));
  engine = await createEngine({ dataDir: directory });
  await engine.settingsUpdate({ outputRoot: join(directory, 'outputs'), jianyingDraftRoot: join(directory, 'drafts') });
  shot = join(directory, 'shot.mp4');
  const encoded = spawnSync('ffmpeg', ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=12:d=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', shot], { windowsHide: true });
  assert.equal(encoded.status, 0, encoded.stderr?.toString());
  inputLut = join(directory, 'camera.cube');
  creativeLut = join(directory, 'creative.cube');
  await writeFile(inputLut, CUBE);
  await writeFile(creativeLut, CUBE);
  project = await engine.handle('project_create', { title: 'Export panel regression', width: 160, height: 90, fps: 12 });
  await engine.handle('asset_import', { projectId: project.id, path: shot });
  const imported = await engine.handle('project_get', { projectId: project.id });
  shot = imported.assets[0].path;
  const seeded = await engine.handle('timeline_update', {
    projectId: project.id, revision: imported.revision,
    clips: fixtureClips('export').map((clip) => ({ ...clip, assetId: imported.assets[0].id })),
    captions: [{ start: 0.2, end: 1.2, text: '续剪字幕' }],
  });
  app = await startServer({ engine, port: 0 });
  const port = await freePort();
  vite = await createServer({
    root: ROOT, logLevel: 'silent',
    server: {
      port, strictPort: true, hmr: false,
      proxy: { '/api': { target: app.url, changeOrigin: true, headers: { origin: app.url } } },
    },
  });
  await vite.listen();
  base = `http://127.0.0.1:${port}/`;
  browser = await chromium.launch({ headless: true, ...(process.env.EAC_BROWSER ? { executablePath: process.env.EAC_BROWSER } : process.platform === 'win32' ? { channel: 'msedge' } : {}) });
});

after(async () => {
  await browser?.close();
  await vite?.close();
  await app?.close();
  await engine?.close();
  await rm(directory, { recursive: true, force: true });
});

async function openPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(120000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { context, page, errors };
}

async function openExportPanel(page) {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('.app-topnav').getByRole('button', { name: /^制作流程/ }).click();
  await page.getByRole('heading', { name: '导出续剪工程', exact: true }).waitFor();
  await page.getByRole('group', { name: '导出目标', exact: true }).waitFor();
}

const exportJobCount = () => engine.store.state.jobs.filter((job) => job.type === 'export').length;

test('export panel exports only the selected targets and never double submits', { timeout: 180000 }, async () => {
  const { context, page, errors } = await openPage();
  try {
    await openExportPanel(page);
    await page.getByText(/导出已保存修订 r\d+/).waitFor();
    const group = page.getByRole('group', { name: '导出目标', exact: true });
    assert.equal(await group.getByRole('checkbox').count(), 5);
    for (const label of ['导出目标 剪映草稿', '导出目标 Premiere · Resolve XML', '导出目标 SRT 字幕', '导出目标 .cube LUT', '导出目标 交付说明']) {
      assert.equal(await group.getByRole('checkbox', { name: label, exact: true }).isChecked(), true, label);
    }
    await page.getByRole('button', { name: '清空选择', exact: true }).click();
    assert.equal(await group.getByRole('checkbox', { name: '导出目标 SRT 字幕', exact: true }).isChecked(), false);
    await page.getByRole('button', { name: '全部', exact: true }).click();
    assert.equal(await group.getByRole('checkbox', { name: '导出目标 SRT 字幕', exact: true }).isChecked(), true);
    await group.getByRole('checkbox', { name: '导出目标 .cube LUT', exact: true }).uncheck();
    await group.getByRole('checkbox', { name: '导出目标 交付说明', exact: true }).uncheck();

    let posts = 0;
    page.on('request', (request) => { if (request.method() === 'POST' && /\/api\/jobs$/.test(request.url())) posts += 1; });
    const exportedRevision = (await engine.handle('project_get', { projectId: project.id })).revision;
    await page.getByText(new RegExp(`导出已保存修订 r${exportedRevision}`)).waitFor();
    await page.getByRole('button', { name: '开始导出', exact: true }).dblclick();
    await page.getByText(/导出完成 · 共 \d+ 个文件/).waitFor();
    assert.equal(posts, 1, 'double click must submit a single export job');

    const job = engine.store.state.jobs.find((item) => item.type === 'export');
    assert.deepEqual(job.params.targets, ['jianying', 'premiere-xml', 'srt']);
    assert.equal(job.status, 'completed');
    assert.ok(job.result.files.length >= 3, 'export must produce real files');
    assert.equal(job.result.sourceRevision, exportedRevision, 'result reports the exported revision');
    await page.getByText(new RegExp(`导出完成 · 共 \\d+ 个文件`)).waitFor();
    await page.getByText(`修订 r${exportedRevision}`, { exact: true }).waitFor();

    const links = page.getByRole('link').filter({ hasText: /\.(xml|srt|json|meta|draft_content)$/ });
    assert.ok(await links.count() >= 2, 'result lists downloadable files');
    const href = await links.first().getAttribute('href');
    assert.match(href, /^\/api\/files\?path=.+&download=1$/);
    const response = await page.request.get(new URL(href, base).href);
    assert.equal(response.status(), 200);
    assert.match(response.headers()['content-disposition'] || '', /^attachment;/);
    assert.ok((await response.body()).length > 0);

    await page.getByRole('button', { name: '复制导出目录', exact: true }).click();
    await page.getByText(/已复制|请手动复制/).waitFor();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(copied.length > 0);
    assert.ok(job.result.files.some((file) => file.startsWith(copied)) || copied === job.result.draftFolder || copied.includes('outputs'), copied);

    await page.getByRole('button', { name: '复制剪映草稿目录', exact: true }).click();
    await page.getByText(/已复制|请手动复制/).waitFor();

    await engine.store.state.jobs.unshift({
      id: 'failed-export-fixture', type: 'export', projectId: project.id, status: 'failed',
      error: '磁盘空间不足（模拟失败）', params: { targets: ['srt'] }, createdAt: new Date().toISOString(),
    });
    await engine.store.save();
    await page.getByText('磁盘空间不足（模拟失败）').waitFor({ timeout: 30000 });
    const before = exportJobCount();
    await page.getByRole('button', { name: '重试导出', exact: true }).click();
    const deadline = Date.now() + 90000;
    while (exportJobCount() < before + 1) {
      assert.ok(Date.now() < deadline, 'retry must submit a fresh export job');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const retried = engine.store.state.jobs[0];
    assert.equal(retried.type, 'export');
    assert.notEqual(retried.status, 'failed');
    assert.deepEqual(retried.params.targets, ['srt']);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('timeline exposes camera and creative LUT paths and blocks exporting unsaved edits', { timeout: 180000 }, async () => {
  const { context, page, errors } = await openPage();
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: '时间线编辑', exact: true }).click();
    await page.getByRole('heading', { name: '多轨时间线', exact: true }).waitFor();
    await page.getByText('高级：相机输入 LUT / 创意 LUT').click();
    const input = page.getByRole('textbox', { name: '片段 1 相机输入 LUT', exact: true });
    const creative = page.getByRole('textbox', { name: '片段 1 创意 LUT', exact: true });
    await input.fill(inputLut);
    await creative.fill(creativeLut);
    await page.getByRole('spinbutton', { name: '片段 1 开始 / 秒', exact: true }).fill('0.1');
    await page.getByRole('button', { name: '导出续剪工程', exact: true }).click();
    await page.getByText(/请先保存当前编排/).waitFor();
    assert.equal(await page.getByRole('heading', { name: '多轨时间线', exact: true }).count(), 1);

    await page.getByRole('button', { name: '保存编排', exact: true }).click();
    await page.getByText(/时间线已保存/).waitFor();
    await page.getByRole('heading', { name: '导出续剪工程', exact: true }).waitFor();
    const saved = await engine.handle('project_get', { projectId: project.id });
    assert.equal(saved.clips[0].inputLut, inputLut);
    assert.equal(saved.clips[0].lut, creativeLut);
    await page.getByText(new RegExp(`导出已保存修订 r${saved.revision}`)).waitFor();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('custom grading without a preset is labelled as such and explicit zeros survive edits', { timeout: 180000 }, async () => {
  const { context, page, errors } = await openPage();
  try {
    const projectId = project.id;
    const current = await engine.handle('project_get', { projectId });
    const customLook = { exposure: -0.1, curves: { master: [[0, 0], [1, 0.92]] } };
    const customClip = { exposure: 0, curves: { master: [[0, 0.02], [1, 1]] } };
    const seeded = await engine.handle('timeline_update', {
      projectId, revision: current.revision,
      clips: [{ ...current.clips[0], grading: customClip }],
      look: customLook,
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: '时间线编辑', exact: true }).click();
    await page.getByRole('heading', { name: '多轨时间线', exact: true }).waitFor();

    const lookSelect = page.getByRole('combobox', { name: '项目级调色 look', exact: true });
    assert.equal(await lookSelect.inputValue(), '__custom');
    assert.equal(await lookSelect.locator('option:checked').innerText(), '自定义调色');
    assert.equal(await page.getByRole('option', { name: '不调色', exact: true }).count(), 1);
    const clipSelect = page.getByRole('combobox', { name: '调色预设', exact: true }).first();
    assert.equal(await clipSelect.inputValue(), '__custom');
    assert.equal(await clipSelect.locator('option:checked').innerText(), '自定义调色');
    const clipExposure = page.getByRole('spinbutton', { name: '曝光 exposure', exact: true }).first();
    assert.equal(await clipExposure.inputValue(), '0');
    assert.equal(await clipExposure.isEditable(), true);
    assert.equal(await page.getByRole('spinbutton', { name: '对比 contrast', exact: true }).first().isEditable(), true);

    await clipExposure.fill('0.15');
    await page.getByRole('button', { name: '保存编排', exact: true }).click();
    await page.getByText(/时间线已保存/).waitFor();
    let saved = await engine.handle('project_get', { projectId });
    assert.equal(saved.clips[0].grading.exposure, 0.15);
    assert.deepEqual(saved.clips[0].grading.curves, customClip.curves, 'advanced curves must survive a scalar edit');
    assert.equal(saved.clips[0].grading.preset, undefined);

    await page.getByRole('button', { name: '保存编排', exact: true }).waitFor();
    await clipExposure.fill('0');
    await page.getByRole('button', { name: '保存编排', exact: true }).click();
    await page.getByText(/时间线已保存/).waitFor();
    saved = await engine.handle('project_get', { projectId });
    assert.equal(saved.clips[0].grading.exposure, 0, 'an explicit zero must be kept, not dropped back to the look');
    assert.deepEqual(saved.clips[0].grading.curves, customClip.curves);

    await clipSelect.selectOption({ label: '青橙电影' });
    await page.getByRole('button', { name: '保存编排', exact: true }).click();
    await page.getByText(/时间线已保存/).waitFor();
    saved = await engine.handle('project_get', { projectId });
    assert.equal(saved.clips[0].grading.preset, 'teal-orange');
    assert.deepEqual(saved.clips[0].grading.curves, customClip.curves, 'switching a preset must keep existing advanced curves');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('saving camera LUT rejects a malformed cube without touching the revision', { timeout: 120000, skip: !colorWorkflowReady }, async () => {
  const broken = join(directory, 'broken.cube');
  await writeFile(broken, 'LUT_3D_SIZE 2\n0 0 0\n');
  const current = await engine.handle('project_get', { projectId: project.id });
  await assert.rejects(engine.handle('timeline_update', {
    projectId: current.id, revision: current.revision,
    clips: [{ ...current.clips[0], inputLut: broken }],
  }), /LUT|cube|不存在|无效/i);
  assert.equal((await engine.handle('project_get', { projectId: project.id })).revision, current.revision);
});

test('grading value resolver applies look preset, explicit look, clip preset then clip override', () => {
  const presets = [
    { id: 'golden-hour', params: { exposure: 0.1, temperature: 0.35, saturation: 0.12, contrast: 0.02 } },
    { id: 'moody-blue', params: { temperature: -0.3, saturation: -0.1, vibrance: 0.2 } },
  ];
  const fromPreset = resolveGradingValues({ preset: 'golden-hour' }, { contrast: 0.2 }, presets);
  assert.equal(fromPreset.exposure.value, 0.1);
  assert.equal(fromPreset.exposure.source, 'look-preset');
  assert.equal(fromPreset.temperature.value, 0.35);
  assert.equal(fromPreset.saturation.value, 0.12);
  assert.equal(fromPreset.contrast.value, 0.2);
  assert.equal(fromPreset.contrast.source, 'clip');
  assert.equal(fromPreset.vibrance.value, 0);
  assert.equal(fromPreset.vibrance.source, 'default');

  const clipPresetWins = resolveGradingValues({ temperature: 0.9 }, { preset: 'moody-blue' }, presets);
  assert.equal(clipPresetWins.temperature.value, -0.3, 'a clip preset resolves before the explicit project look');
  assert.equal(clipPresetWins.temperature.source, 'clip-preset');
  assert.equal(clipPresetWins.saturation.value, -0.1);
  assert.equal(clipPresetWins.vibrance.value, 0.2);

  const explicitLook = resolveGradingValues({ preset: 'golden-hour', exposure: -0.5 }, null, presets);
  assert.equal(explicitLook.exposure.value, -0.5);
  assert.equal(explicitLook.exposure.source, 'look');
  assert.equal(explicitLook.temperature.value, 0.35);

  const zeroOverride = resolveGradingValues({ preset: 'golden-hour' }, { exposure: 0 }, presets);
  assert.equal(zeroOverride.exposure.value, 0, 'an explicit zero overrides the preset value');
  assert.equal(zeroOverride.exposure.source, 'clip');
});

test('removing a scalar override keeps advanced grading fields and clears empty grades', () => {
  const curves = { master: [[0, 0], [1, 0.9]] };
  assert.deepEqual(removeScalarOverride({ exposure: 0, contrast: 0.2, curves }, 'exposure'), { contrast: 0.2, curves });
  assert.equal(removeScalarOverride({ exposure: 0 }, 'exposure'), null);
  assert.deepEqual(removeScalarOverride({ preset: 'teal-orange', exposure: 0 }, 'exposure'), { preset: 'teal-orange' });
  assert.equal(removeScalarOverride(null, 'exposure'), null);
  const original = { curves };
  assert.deepEqual(removeScalarOverride(original, 'exposure'), { curves }, 'a missing override is returned unchanged');
  assert.deepEqual(original, { curves }, 'the input grading is never mutated');
});

test('timeline scalar controls show inherited preset values, mark overrides and reset to inherited', { timeout: 180000 }, async () => {
  const { context, page, errors } = await openPage();
  try {
    const current = await engine.handle('project_get', { projectId: project.id });
    const curves = { master: [[0, 0], [1, 0.92]] };
    await engine.handle('timeline_update', {
      projectId: project.id, revision: current.revision,
      clips: [{ ...current.clips[0], grading: { contrast: 0.2, curves } }],
      look: { preset: 'golden-hour' },
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: '时间线编辑', exact: true }).click();
    await page.getByRole('heading', { name: '多轨时间线', exact: true }).waitFor();

    const exposure = page.getByRole('spinbutton', { name: '曝光 exposure', exact: true }).first();
    const contrast = page.getByRole('spinbutton', { name: '对比 contrast', exact: true }).first();
    const temperature = page.getByRole('spinbutton', { name: '色温 temperature', exact: true }).first();
    assert.equal(await exposure.inputValue(), '0.1', 'the inherited preset exposure is shown, not 0');
    assert.equal(await temperature.inputValue(), '0.35', 'the inherited preset temperature is shown');
    assert.equal(await contrast.inputValue(), '0.2');
    assert.equal(await page.locator('.grading-field[data-source="look-preset"]').count() >= 3, true);
    assert.equal(await page.locator('.grading-field[data-source="clip"]').count(), 1);
    await page.getByText('片段覆盖', { exact: true }).waitFor();

    await exposure.fill('0');
    await page.getByRole('button', { name: '保存编排', exact: true }).click();
    await page.getByText(/时间线已保存/).waitFor();
    let saved = await engine.handle('project_get', { projectId: project.id });
    assert.equal(saved.clips[0].grading.exposure, 0, 'an explicit zero is stored as a real override');
    assert.deepEqual(saved.clips[0].grading.curves, curves, 'advanced curves survive a scalar edit');

    await contrast.fill('');
    await page.getByRole('button', { name: '保存编排', exact: true }).click();
    await page.getByText(/时间线已保存/).waitFor();
    saved = await engine.handle('project_get', { projectId: project.id });
    assert.equal(saved.clips[0].grading.contrast, undefined, 'clearing the input removes the override');
    assert.equal(saved.clips[0].grading.exposure, 0);
    assert.deepEqual(saved.clips[0].grading.curves, curves);

    await page.getByRole('button', { name: '重置曝光为继承值', exact: true }).click();
    assert.equal(await exposure.inputValue(), '0.1', 'reset restores the inherited preset value');
    await page.getByRole('button', { name: '保存编排', exact: true }).click();
    await page.getByText(/时间线已保存/).waitFor();
    saved = await engine.handle('project_get', { projectId: project.id });
    assert.equal(saved.clips[0].grading.exposure, undefined);
    assert.equal(saved.clips[0].grading.contrast, undefined);
    assert.deepEqual(saved.clips[0].grading.curves, curves, 'reset must not discard advanced grading fields');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
