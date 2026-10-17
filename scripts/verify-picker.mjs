import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { startServer } from '../src/server.mjs';
import { templates } from '../src/catalog.mjs';
import { createEngine } from '../src/engine.mjs';

const directory = resolve('artifacts/composer');
await mkdir(directory, { recursive: true });
const state = { projects: [{ id: 'existing-project', templateId: 'motion-promo-film-v2', revision: 1 }],
  jobs: [], templates, settings: {}, capabilities: [] };
const dataDir = await mkdtemp(join(tmpdir(), 'eac-picker-'));
const engine = await createEngine({ dataDir });
engine.state = async () => state;
engine.library = async () => ({ templates, designSystems: [] });
const app = await startServer({ port: 0, engine });
const executablePath = [process.env.EAC_BROWSER, chromium.executablePath(),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(path => path && existsSync(path));
let browser;
const checks = [];
const errors = [];
const pass = message => { checks.push(message); console.log(`PASS ${message}`); };
try {
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1024, height: 650 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('eac:project', 'existing-project'));
  await page.route(`${app.url}/picker-host.html*`, route => {
    const layout = new URL(route.request().url()).searchParams.get('layout') || 'dialog';
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8"><style>
      *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%}iframe{display:block;border:0;width:100%;height:100%}
      </style></head><body><script>
      window.messages=[];
      window.addEventListener('message',event=>{
        if(event.source!==document.querySelector('iframe')?.contentWindow)return;
        window.messages.push(event.data);
        if(event.data?.type==='eac:picker-height')document.querySelector('iframe').style.height=event.data.height+'px';
      });
      </script><iframe title="模板库" src="${app.url}/?view=templates&layout=${layout}&selected=05-cel-boil"></iframe></body></html>` });
  });
  await page.goto(`${app.url}/picker-host.html`, { waitUntil: 'domcontentloaded' });
  const picker = page.frameLocator('iframe[title="模板库"]');
  await picker.getByRole('textbox', { name: '搜索模板' }).waitFor();
  await page.waitForFunction(() => window.messages.some(message => message.type === 'eac:picker-ready'));
  assert.equal(await picker.locator('.library-card').count(), templates.length);
  assert.equal(await picker.locator('.library-card.selected').getByRole('heading').textContent(), '逐帧手绘');
  assert.equal(await picker.locator('.picker-header').isVisible(), false, 'embedded picker must not duplicate the host heading');
  pass('17 templates and URL selection survive an existing project; embedded header is not duplicated');

  for (const width of [1024, 680, 390, 320]) {
    await page.setViewportSize({ width, height: 650 });
    const layout = await picker.locator('main').evaluate(element => {
      const grid = element.querySelector('.library-card-grid');
      const rect = element.getBoundingClientRect();
      return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        height: innerHeight, scrollHeight: document.documentElement.scrollHeight,
        columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
        scrolls: [...document.querySelectorAll('*')].filter(node => node.scrollHeight > node.clientHeight + 1
          && ['auto', 'scroll'].includes(getComputedStyle(node).overflowY)).map(node => node.className),
        shellHeight: rect.height };
    });
    assert.ok(layout.scrollWidth <= layout.width + 1, JSON.stringify(layout));
    assert.ok(layout.scrollHeight <= layout.height + 1, JSON.stringify(layout));
    assert.deepEqual(layout.scrolls, ['library-picker-scroll']);
    if (width === 1024) assert.equal(layout.columns, 4, 'desktop thumbnails should have a readable four-column layout');
    if (width <= 390) assert.equal(layout.columns, 2);
    await page.screenshot({ path: join(directory, `picker-${width}.png`) });
  }
  pass('desktop, tablet, 390px and 320px use one list scroll area without horizontal overflow');

  await picker.getByRole('textbox', { name: '搜索模板' }).fill('玻璃');
  assert.equal(await picker.locator('.library-card').count(), 1);
  await picker.getByRole('button', { name: '预览极光玻璃', exact: true }).click();
  await picker.getByRole('dialog', { name: '模板预览' }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await picker.getByRole('dialog').count(), 0);
  assert.equal(await page.evaluate(() => window.messages.filter(message => message.type === 'eac:close-picker').length), 0);
  await picker.getByRole('textbox', { name: '搜索模板' }).focus();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.messages.some(message => message.type === 'eac:close-picker'));
  pass('Escape closes the preview before asking to close the outer template library');

  await picker.getByRole('button', { name: '选择极光玻璃', exact: true }).click();
  await page.waitForFunction(() => window.messages.some(message => message.type === 'eac:template' && message.templateId === '12-aurora-glass'));
  assert.equal(await page.evaluate(() => window.messages.find(message => message.type === 'eac:template').templateName), '极光玻璃');
  await page.evaluate(origin => document.querySelector('iframe').contentWindow.postMessage({
    type: 'eac:picker-state', templateId: '05-cel-boil', presentation: 'dialog',
  }, origin), app.url);
  await picker.getByRole('button', { name: '清除搜索', exact: true }).click();
  assert.equal(await picker.locator('.library-card.selected').getByRole('heading').textContent(), '逐帧手绘');
  pass('selection sends the exact template id/name and parent state updates the chosen card');

  await page.goto(`${app.url}/picker-host.html?layout=inline`);
  await picker.getByRole('button', { name: '浏览全部模板' }).waitFor();
  for (const width of [836, 390, 320]) {
    await page.setViewportSize({ width, height: 650 });
    await page.waitForFunction(() => {
      const frame = document.querySelector('iframe');
      const main = frame.contentDocument?.querySelector('main');
      return main && Math.abs(frame.getBoundingClientRect().height - main.getBoundingClientRect().height) < 2;
    });
    assert.equal(await picker.locator('.library-card').count(), width > 600 ? 8 : 4);
    assert.equal(await picker.getByRole('textbox').count(), 0);
    const layout = await picker.locator('main').evaluate(element => ({
      width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      height: innerHeight, contentHeight: element.getBoundingClientRect().height,
      browseBottom: element.querySelector('.library-browse-all').getBoundingClientRect().bottom,
    }));
    assert.ok(layout.scrollWidth <= layout.width + 1, JSON.stringify(layout));
    assert.ok(layout.browseBottom <= layout.height + 1, JSON.stringify(layout));
    await page.screenshot({ path: join(directory, `recommendations-${width}.png`) });
  }
  await picker.getByRole('button', { name: '浏览全部模板' }).click();
  await page.waitForFunction(() => window.messages.some(message => message.type === 'eac:open-picker'));
  pass('responsive recommendations resize their iframe to fit and open the full library');
  assert.deepEqual(errors, []);
  pass('no browser runtime errors');
} finally {
  await browser?.close();
  await app.close();
  await engine.close();
  await rm(dataDir, { recursive: true, force: true });
  await writeFile(join(directory, 'verification.json'), JSON.stringify({ checks, errors }, null, 2));
}
console.log(`Evidence: ${directory}`);
