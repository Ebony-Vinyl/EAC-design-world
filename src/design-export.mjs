import { chromium } from 'playwright';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// The export page renders user-authored HTML, so it gets the same treatment as the design preview in
// src/server.mjs: an opaque origin (no cookies, no storage, no same-origin reach into the EAC API),
// no network (`connect-src`/`form-action` 'none'), and only data:/blob: or server-origin assets, which
// the route below narrows further to read-only /vendor/. Scripts stay enabled because real decks build
// their layout with inline scripts. The policy is delivered through a <meta http-equiv> because the
// page is created with page.setContent(): a CSP `sandbox` response header on a route.fulfill() response
// crashes the bundled Chromium, while an opaque document origin already provides the isolation.
export function exportDocumentCsp(origin) {
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${origin}`,
    `style-src 'unsafe-inline' ${origin}`,
    `img-src data: blob: ${origin}`,
    `font-src data: ${origin}`,
    `media-src data: blob: ${origin}`,
    "connect-src 'none'",
    "form-action 'none'",
    `base-uri ${origin}`,
  ].join('; ');
}

// A <base> keeps relative URLs resolving exactly where they resolved when the artifact was served at
// /__eac-export/<uuid>.html, so a relative asset is still refused (and reported) instead of silently
// resolving against about:blank.
export function isolatedArtifactDocument(content, origin) {
  const head = `<meta http-equiv="Content-Security-Policy" content="${exportDocumentCsp(origin)}">`
    + `<base href="${new URL('/__eac-export/', origin).href}">`;
  if (/<head[^>]*>/i.test(content)) return content.replace(/<head[^>]*>/i, match => `${match}${head}`);
  if (/<html[^>]*>/i.test(content)) return content.replace(/<html[^>]*>/i, match => `${match}<head>${head}</head>`);
  return `<!doctype html><html><head>${head}</head><body>${content}</body></html>`;
}

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
  const browser = await chromium.launch({ ...(process.env.EAC_BROWSER ? { executablePath: process.env.EAC_BROWSER } : { channel: 'msedge' }), headless: true });
  const abort = () => { void browser.close(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    // Relative URLs (./style.css, images/x.png) resolve under /__eac-export/, a path the server never
    // hosts, and /api/* must stay blocked because the same origin also serves write endpoints. Only
    // read-only /vendor/ files are let through, and every refused request is collected: a partly
    // rendered export must never be reported as a clean success.
    const blocked = new Map();
    // An isolated page can also break in ways a picture will not show (a script that used cookies or
    // storage now throws). Collect those too so the caller never learns "success" about a broken page.
    const pageErrors = [];
    page.on('pageerror', error => { if (pageErrors.length < 20) pageErrors.push(error.message); });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === origin && url.pathname.startsWith('/vendor/')) return route.continue();
      if (!blocked.has(url.href)) blocked.set(url.href, route.request().resourceType());
      return route.abort();
    });
    // `window.open` escapes everything the route does: no CSP directive constrains it, and the popup
    // is a NEW page, so it neither hits `page.route` nor lands in `blocked` — a document could ship
    // its own content out in a URL while this function reported complete:true. This batch already
    // learned exactly that for render-template (popup guard there); it was not mirrored here.
    // Two layers, because closing alone leaves a window: a closing page can still have dispatched its
    // request. `context.route` also covers popups, so the navigation itself is refused as well, then
    // the page is closed so nothing lingers. Recorded either way, so `complete` cannot claim clean.
    const popups = [];
    const refusePopup = (target) => {
      const url = typeof target === 'string' ? target : (target?.url?.() ?? '');
      // Only real network destinations count. After the abort below, Chromium settles the popup on
      // `chrome-error://chromewebdata/`; recording that would report a second "popup" for one attempt
      // and make the warning misleading.
      if (!/^(https?|wss?|ftp):/i.test(url)) return;
      if (popups.length < 20 && !popups.includes(url)) popups.push(url);
    };
    // Close the popup as well as refusing its navigation: the abort stops the request, the close stops
    // the page from lingering for the rest of the export (a live page could still run script).
    page.context().on('page', opened => {
      if (opened === page) return;
      refusePopup(opened.url());
      void opened.close().catch(() => {});
    });
    await page.context().route('**/*', route => {
      refusePopup(route.request().url());
      return route.abort('blockedbyclient').catch(() => {});
    });
    await page.setContent(isolatedArtifactDocument(source.content, origin), { waitUntil: 'load', timeout: 30000 });
    // Live probe, not a claim: the document has an opaque origin, so storage access throws. Callers
    // (and tests) can see the export page really was isolated instead of trusting a constant.
    const pageSandboxed = await page.evaluate(() => {
      try { window.localStorage.setItem('eac-export-probe', '1'); window.localStorage.removeItem('eac-export-probe'); return false; } catch { return true; }
    });
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
    const missing = [...blocked.entries()].map(([url, type]) => ({ url, type }));
    const warnings = [];
    if (format === 'pptx') warnings.push('PPTX 为整页图像形式；文字与图形的逐元素编辑请保留并修改 HTML 源文件。');
    if (missing.length) warnings.push(`导出缺失 ${missing.length} 个外部资源：${missing.slice(0, 5).map(item => item.url).join('、')}${missing.length > 5 ? ' 等' : ''}。导出页只允许同源 /vendor/ 资源，相对路径与 /api/ 请求不会加载；请改用 data: 内联或 /vendor/ 路径后重新导出。`);
    if (pageErrors.length) warnings.push(`导出页脚本报错 ${pageErrors.length} 次：${pageErrors.slice(0, 3).join('；')}。导出页与设计预览一样运行在不透明来源，访问 cookie / localStorage / 同源接口会抛错，请移除这些依赖后重新导出。`);
    if (popups.length) warnings.push(`导出页尝试打开 ${popups.length} 个弹窗（已在打开瞬间关闭）：${popups.slice(0, 3).join('；')}。弹窗不受 CSP 约束，可能把页面内容带向外部地址，请移除 window.open 后重新导出。`);
    return { id, revision: source.revision, format, path: output, slides: slideCount || undefined,
      editableElements: format === 'pptx' ? false : undefined,
      pageSandboxed,
      blockedRequests: { count: missing.length, sample: missing.slice(0, 10) },
      pageErrors: { count: pageErrors.length, sample: pageErrors.slice(0, 5) },
      blockedPopups: { count: popups.length, sample: popups.slice(0, 5) },
      // A popup is an exfiltration attempt, not a missing asset, but it is equally a sign the page did
      // not render the way it was supposed to — before this it silently counted as complete.
      complete: missing.length === 0 && popups.length === 0,
      warning: warnings.length ? warnings.join(' ') : undefined };
  } finally {
    signal?.removeEventListener('abort', abort);
    await browser.close();
    await rm(staged, { force: true });
  }
}
