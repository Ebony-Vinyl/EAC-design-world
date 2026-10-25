import { browserLaunchOptions } from './browser.mjs';
import { chromium } from 'playwright';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function exportDesignArtifact({ store, id, format, revision, origin, signal }) {
  if (!['pdf', 'pptx', 'png'].includes(format)) throw new Error('导出格式必须是 pdf、pptx 或 png');
  const source = await store.readContent(id, revision);
  const { project } = store.artifact(id);
  if (source.kind === 'markdown') throw new Error('Markdown 可直接下载源文件；PDF / PPTX 导出需要 HTML 或 SVG 页面');
  if (format === 'pptx' && project.kind !== 'deck') throw new Error('PPTX 导出需要幻灯片作品');
  signal?.throwIfAborted();
  const directory = join(store.root, 'exports', id);
  await mkdir(directory, { recursive: true });
  const output = resolve(directory, `v${source.revision}.${format}`);
  const staged = resolve(directory, `.${randomUUID()}.${format}`);
  const browser = await chromium.launch(browserLaunchOptions(chromium));
  const abort = () => { void browser.close(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    const documentUrl = new URL(`/__eac-export/${randomUUID()}.html`, origin).href;
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.href === documentUrl) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: source.content });
      if (url.origin === origin && url.pathname.startsWith('/vendor/')) return route.continue();
      return route.abort();
    });
    await page.goto(documentUrl, { waitUntil: 'load', timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);
    const slideCount = project.kind === 'deck' ? await page.evaluate(() => {
      let nodes = [...document.querySelectorAll('[data-slide],.slide,.deck-page')];
      if (!nodes.length) nodes = [...document.querySelectorAll('section')];
      nodes = nodes.filter(node => !nodes.some(parent => parent !== node && parent.contains(node)));
      nodes.forEach((node, index) => node.setAttribute('data-eac-export-slide', String(index)));
      return nodes.length;
    }) : 0;
    if (format === 'pptx' && !slideCount) throw new Error('没有找到幻灯片，请使用 section、.slide 或 data-slide 标记各页');
    if (slideCount > 100) throw new Error('一次最多导出 100 页幻灯片');
    if (format === 'pptx') {
      const { default: PptxGenJS } = await import('pptxgenjs');
      const pptx = new PptxGenJS();
      pptx.layout = 'LAYOUT_WIDE';
      pptx.author = 'EAC design world';
      pptx.subject = 'HTML slide visual export; pages are images, original HTML remains editable in EAC';
      pptx.title = project.title;
      for (let index = 0; index < slideCount; index++) {
        signal?.throwIfAborted();
        await page.evaluate(current => {
          document.querySelectorAll('[data-eac-export-slide]').forEach(node => {
            const active = Number(node.getAttribute('data-eac-export-slide')) === current;
            node.style.cssText += active ? ';display:flex!important;position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;visibility:visible!important;opacity:1!important;transform:none!important' : ';display:none!important';
          });
        }, index);
        const image = await page.screenshot({ type: 'png', animations: 'disabled' });
        const slide = pptx.addSlide();
        slide.addImage({ data: `image/png;base64,${image.toString('base64')}`, x: 0, y: 0, w: 13.333333, h: 7.5 });
        slide.addNotes('Visual export from editable HTML. Edit source elements in EAC design world.');
      }
      await pptx.writeFile({ fileName: staged });
    } else if (format === 'pdf') {
      if (slideCount) await page.addStyleTag({ content: '[data-eac-export-slide]{display:flex!important;position:relative!important;inset:auto!important;visibility:visible!important;opacity:1!important;transform:none!important;width:1280px!important;height:720px!important;break-after:page;page-break-after:always}html,body{margin:0!important;overflow:visible!important;height:auto!important}@page{size:1280px 720px;margin:0}' });
      await page.pdf({ path: staged, printBackground: true, preferCSSPageSize: true, ...(slideCount ? { width: '1280px', height: '720px' } : { format: 'A4' }) });
    } else await page.screenshot({ path: staged, type: 'png', fullPage: true, animations: 'disabled' });
    signal?.throwIfAborted();
    await rename(staged, output);
    return { id, revision: source.revision, format, path: output, slides: slideCount || undefined,
      editableElements: format === 'pptx' ? false : undefined,
      warning: format === 'pptx' ? 'PPTX 为整页图像形式；文字与图形的逐元素编辑请保留并修改 HTML 源文件。' : undefined };
  } finally {
    signal?.removeEventListener('abort', abort);
    await browser.close();
    await rm(staged, { force: true });
  }
}
