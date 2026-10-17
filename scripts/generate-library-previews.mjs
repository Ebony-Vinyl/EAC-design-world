import { readFile, mkdir, access, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../src/server.mjs';

const catalog = JSON.parse(await readFile(resolve('vendor/open-design/catalog.json'), 'utf8'));
const directory = resolve('public/library-previews');
await mkdir(directory, { recursive: true });
const entries = [
  ...catalog.designSystems.map(item => ({ ...item, path: `${item.path}/system/artifacts/landing.html`, system: true })),
  ...catalog.templates.filter(item => item.entry?.path && !item.thumbnail).map(item => ({ ...item, path: item.entry.path })),
];
const server = await startServer({ port: 0 });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
let cursor = 0;
async function worker() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 0.5, reducedMotion: 'reduce', javaScriptEnabled: false });
  await context.route('**/*', route => route.request().url().startsWith(server.url + '/') ? route.continue() : route.abort());
  const page = await context.newPage();
  while (cursor < entries.length) {
    const item = entries[cursor++];
    const output = join(directory, `${item.id}.jpg`);
    try { await access(output); continue; } catch {}
    try {
      await access(resolve(item.path));
      await page.goto(`${server.url}/${item.path}`, { waitUntil: 'load', timeout: 7000 });
      await page.screenshot({ path: output, type: 'jpeg', quality: 78, timeout: 7000 });
      results.push({ id: item.id, source: item.path, image: `/library-previews/${item.id}.jpg` });
    } catch (error) { results.push({ id: item.id, error: error.message.split('\n')[0] }); }
    if (results.length % 25 === 0) console.log(`${results.length} covers captured`);
  }
  await context.close();
}
try { await Promise.all([worker(), worker(), worker()]); }
finally { await browser.close(); await server.close(); }
await writeFile(join(directory, 'sources.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ generated: results.filter(row => row.image).length, failed: results.filter(row => row.error).length }));
