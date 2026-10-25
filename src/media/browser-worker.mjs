import { browserLaunchOptions } from '../browser.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
// Install cancellation before loading Playwright; early IPC messages must not be lost.
let context;
let deadline;
let performing;
let cancelled = false;
const controller = new AbortController();
const wait = async ms => {
  const { setTimeout } = await import('node:timers/promises');
  await setTimeout(ms, undefined, { signal: controller.signal });
};
const cancel = () => {
  cancelled = true;
  controller.abort();
  if (context) void context.close().catch(() => {});
  else process.emit('SIGTERM');
};
process.on('message', cancel);
if (process.connected) process.send('ready');
try {
  const { url, actions, width, height, directory } = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const { chromium } = await import('playwright');
  if (cancelled) throw new Error('Browser recording aborted');
  context = await chromium.launchPersistentContext(join(directory, 'profile'), {
    headless: true, timeout: 30_000,
    viewport: { width, height }, deviceScaleFactor: 1,
    ...browserLaunchOptions(chromium),
  });
  if (cancelled) throw new Error('Browser recording aborted');
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(10_000);
  page.setDefaultNavigationTimeout(30_000);
  let timedOut = false;
  deadline = setTimeout(() => { timedOut = true; void context.close().catch(() => {}); }, 120_000);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const frames = [];
  const capture = async () => {
    const name = `frame-${String(frames.length).padStart(5, '0')}.jpg`;
    const time = performance.now();
    await page.screenshot({ path: join(directory, name), type: 'jpeg', quality: 85, timeout: 10_000 });
    frames.push({ name, time });
  };
  await capture();
  let done = false;
  let actionFailure;
  performing = (async () => {
    for (const action of actions) {
      controller.signal.throwIfAborted();
      if (action.type === 'click') await page.locator(action.selector).click();
      else if (action.type === 'fill') await page.locator(action.selector).fill(action.text);
      else if (action.type === 'wait') await wait(action.ms ?? 1000);
      else if (action.type === 'move') await page.mouse.move(action.x, action.y, { steps: action.steps ?? 1 });
      else if (action.type === 'wheel') await page.mouse.wheel(action.deltaX ?? 0, action.deltaY ?? 600);
      else if (action.selector) await page.locator(action.selector).evaluate((element, delta) => element.scrollBy(0, delta), action.deltaY ?? 600);
      else await page.evaluate((delta) => window.scrollBy(0, delta), action.deltaY ?? 600);
    }
  })().catch((error) => { actionFailure = error; }).finally(() => { done = true; });
  while (!done) {
    await wait(100);
    if (!done) await capture();
  }
  await performing;
  if (timedOut) throw new Error('Browser recording exceeded 120 seconds');
  if (actionFailure) throw actionFailure;
  await capture();
  const concat = frames.map((frame, index) =>
    `file '${frame.name}'\nduration ${Math.max(1 / 30, ((frames[index + 1]?.time ?? frame.time + 100) - frame.time) / 1000).toFixed(6)}`
  ).join('\n') + `\nfile '${frames.at(-1).name}'\n`;
  await writeFile(join(directory, 'frames.txt'), concat, 'utf8');
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  controller.abort();
  await context?.close().catch(() => {});
  await performing;
  process.removeListener('message', cancel);
  if (process.connected) process.disconnect();
}
