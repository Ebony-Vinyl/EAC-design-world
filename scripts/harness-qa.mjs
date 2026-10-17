import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const directory = resolve('artifacts/harness');
await mkdir(directory, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.EAC_HARNESS_CDP || 'http://127.0.0.1:9232');
const page = browser.contexts()[0].pages().find((item) => item.url().startsWith('dsh-app://'));
page.setDefaultTimeout(8000);
await page.setViewportSize({ width: 1294, height: 822 });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
try {
  const action = process.argv[2] || 'inspect';
  if (action === 'reload') {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(8000);
  }
  if (action === 'plugins') {
    const sidebar = page.getByRole('button', { name: '打开侧边栏', exact: true });
    if (await sidebar.isVisible()) await sidebar.click();
    await page.getByRole('button', { name: '插件', exact: true }).click();
  }
  if (action === 'picker') {
    const mode = page.getByRole('button', { name: /^创作模式: / });
    if ((await mode.getAttribute('aria-label')) !== '创作模式: 剪辑模式') {
      await mode.click();
      await page.getByRole('menuitem', { name: '剪辑模式', exact: true }).click();
    }
    const chooser = page.locator('.eac-composer-controls button[aria-haspopup="dialog"]');
    if (await chooser.getAttribute('aria-expanded') !== 'true') await chooser.click();
    await page.frameLocator('[data-eac-frame="templates"]').locator('.template-grid').waitFor({ timeout: 15000 });
  }
  if (action === 'settings') {
    if (!await page.getByRole('button', { name: 'EAC design world', exact: true }).isVisible()) {
      await page.getByRole('button', { name: '账号菜单', exact: true }).click();
      await page.getByRole('menuitem', { name: /^设置/ }).click();
    }
    await page.getByRole('button', { name: 'EAC design world', exact: true }).click();
    await page.frameLocator('[data-eac-frame="settings"]').locator('.app-shell').waitFor({ timeout: 15000 });
  }
  const state = await page.evaluate(() => ({
    url: location.href, origin: location.origin, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    frames: [...document.querySelectorAll('iframe')].map((frame) => ({ src: frame.src, title: frame.title })),
    buttons: [...document.querySelectorAll('button')].map((button) => ({ text: button.innerText, aria: button.getAttribute('aria-label'), title: button.title })),
    text: document.body.innerText.slice(-16000),
    boot: window.__DSH_BOOT__?.entries.filter((entry) => JSON.stringify(entry).includes('eac-design-world'))
  }));
  state.errors = errors;
  await writeFile(join(directory, `${action}.json`), JSON.stringify(state, null, 2));
  if (process.argv.includes('--screenshot')) await page.screenshot({ path: join(directory, `${action}.png`), timeout: 5000 });
  console.log(JSON.stringify(state, null, 2));
} finally {
  // Only disconnect the debugger. The user's desktop application remains running.
  setTimeout(() => process.exit(0), 20);
}
