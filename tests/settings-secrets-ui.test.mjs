import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createEngine } from '../src/engine.mjs';
import { startServer } from '../src/server.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SECRET_KEYS = ['pexelsApiKey', 'pixabayApiKey', 'jamendoClientId'];

let directory;
let engine;
let app;
let vite;
let browser;
let base;

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'eac-settings-secrets-'));
  engine = await createEngine({ dataDir: directory });
  await engine.settingsUpdate({ outputRoot: join(directory, 'outputs'), jianyingDraftRoot: join(directory, 'drafts') });
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

async function openSettings() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('heading', { name: '输出与制作', exact: true }).waitFor();
  return { context, page, errors };
}

test('public settings never expose raw provider secrets, only configured flags', async () => {
  await engine.settingsUpdate({ pexelsApiKey: 'pexels-secret', pixabayApiKey: 'pixabay-secret', jamendoClientId: 'jamendo-secret' });
  const state = await engine.state();
  for (const key of SECRET_KEYS) {
    assert.equal(Object.hasOwn(state.settings, key), false, `${key} must not be public`);
  }
  assert.equal(state.settings.pexelsApiKeyConfigured, true);
  assert.equal(state.settings.pixabayApiKeyConfigured, true);
  assert.equal(state.settings.jamendoClientIdConfigured, true);
});

test('settings show masked configured status without fetching key values and omit untouched secrets on save', { timeout: 180000 }, async () => {
  await engine.settingsUpdate({ pexelsApiKey: 'pexels-secret', pixabayApiKey: '', jamendoClientId: 'jamendo-secret' });
  const { context, page, errors } = await openSettings();
  try {
    const pexels = page.getByLabel('Pexels API Key', { exact: true });
    const pixabay = page.getByLabel('Pixabay API Key', { exact: true });
    const jamendo = page.getByLabel('Jamendo Client ID', { exact: true });
    assert.equal(await pexels.getAttribute('type'), 'password');
    assert.equal(await pixabay.getAttribute('type'), 'password');
    assert.equal(await jamendo.getAttribute('type'), 'password');
    assert.equal(await pexels.inputValue(), '', 'raw key values are never fetched into the form');
    assert.equal(await jamendo.inputValue(), '');
    assert.equal(await page.getByText('Pexels API Key 已配置', { exact: true }).count(), 1);
    assert.equal(await page.getByText('Jamendo Client ID 已配置', { exact: true }).count(), 1);
    assert.equal(await page.getByText('Pixabay API Key 未配置', { exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: '清除 Pexels API Key', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: '清除 Pixabay API Key', exact: true }).count(), 0, 'no clear action for an unconfigured key');

    const puts = [];
    page.on('request', (request) => {
      if (request.method() === 'PUT' && /\/api\/settings$/.test(request.url())) puts.push(JSON.parse(request.postData() || '{}'));
    });

    await page.getByLabel('旁白声音', { exact: true }).fill('zh-CN-test');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.getByText('配置与服务保持同步', { exact: true }).waitFor();
    assert.equal(puts.length, 1);
    for (const key of SECRET_KEYS) assert.equal(Object.hasOwn(puts[0], key), false, `${key} untouched must be omitted from the save body`);
    assert.equal(puts[0].ttsVoice, 'zh-CN-test');
    assert.equal(engine.store.state.settings.pexelsApiKey, 'pexels-secret', 'untouched secret keeps its stored value');

    await pexels.fill('pexels-new');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.getByText('配置与服务保持同步', { exact: true }).waitFor();
    assert.equal(puts.at(-1).pexelsApiKey, 'pexels-new', 'an explicit new key is stored');
    assert.equal(Object.hasOwn(puts.at(-1), 'jamendoClientId'), false);
    assert.equal(engine.store.state.settings.pexelsApiKey, 'pexels-new');
    assert.equal(engine.store.state.settings.jamendoClientId, 'jamendo-secret');
    assert.equal(await page.getByLabel('Pexels API Key', { exact: true }).inputValue(), '', 'the form clears the secret after saving');

    await page.getByRole('button', { name: '清除 Jamendo Client ID', exact: true }).click();
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.getByText('配置与服务保持同步', { exact: true }).waitFor();
    assert.equal(puts.at(-1).jamendoClientId, '', 'an explicit clear sends an empty string for that key');
    assert.equal(Object.hasOwn(puts.at(-1), 'pexelsApiKey'), false, 'other secrets stay untouched');
    assert.equal(engine.store.state.settings.jamendoClientId, '');
    assert.equal(engine.store.state.settings.pexelsApiKey, 'pexels-new');
    await page.getByText('Jamendo Client ID 未配置', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
