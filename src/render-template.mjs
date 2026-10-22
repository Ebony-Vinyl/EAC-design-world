import http from 'node:http';
import { mkdir, mkdtemp, open, stat, writeFile, rm, realpath, rename } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { resolve, join, dirname, relative, isAbsolute, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { ROOT, resolveTemplate } from './catalog.mjs';
import { chromium } from 'playwright';

const within = (root, file) => { const rel = relative(root, file); return !rel.startsWith('..') && !isAbsolute(rel); };
const motionAssetRoots = ['vendor/onetake/lib', 'vendor/motion-web', 'vendor/eac-motion'];
const types = { '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.glb': 'model/gltf-binary', '.mp4': 'video/mp4' };
// The render page is local template code running against a throwaway file server. That server has no
// API and no credentials, but the page still must not phone home, reach another localhost service,
// submit forms or pull a remote CDN: 'self' is the ephemeral 127.0.0.1 port only. No `sandbox`
// directive — deterministic frame rendering needs a real origin for canvas/WebGL/blob workers, and an
// opaque origin would make ordinary template scripts throw on storage access.
// The same policy covers every document type the browser will execute (an .svg subdocument runs its
// own inline script just like an .html one), not only .html: a documented-CSP-less SVG iframe was a
// working egress path (fetch/Image to any loopback port) while the render still reported ok:true.
const renderCsp = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' 'self'",
  "style-src 'unsafe-inline' 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');
// Documents the browser may execute as a page (with its own script context). Everything else is a
// passive subresource, where a CSP response header has no effect anyway.
const executableDocuments = new Set(['.html', '.htm', '.svg', '.xhtml']);

// htmlPath is user-supplied through job_submit, so it must resolve inside a root this renderer is
// allowed to read: the repository (vendored templates and example films), the working directory,
// the job/project output directory the MP4 is written to, or the OS temp directory used for
// throwaway drafts. Symlinks are resolved first so a link inside the tree cannot point outside it.
// The asset server derives its document root from this path, so containing it also bounds what the
// page can read.
async function containRenderSource(candidate, outputPath, label) {
  const real = await realpath(resolve(ROOT, candidate)).catch(() => null);
  if (!real) throw new Error(`${label} 不存在：${candidate}`);
  // Repository and working directory cover vended templates and agent-authored films; the job output
  // directory and its project directory cover drafts kept next to the rendered MP4; the OS temp
  // directory covers throwaway fixtures.
  const candidates = [ROOT, process.cwd(), dirname(resolve(outputPath)), dirname(dirname(resolve(outputPath))), tmpdir()];
  const roots = await Promise.all([...new Set(candidates)]
    .map(candidate => realpath(candidate).catch(() => resolve(candidate))));
  if (!roots.some(root => within(root, real))) {
    throw new Error(`${label} 必须位于仓库/工作目录、项目输出目录或系统临时目录内：${real}`);
  }
  return real;
}
async function resolveRenderSource(htmlPath, outputPath) {
  return await containRenderSource(htmlPath, outputPath, 'htmlPath');
}
// template.entry is the second, independent source of a render root, and it is not always code:
// `od-*` entries are read straight out of vendor/open-design/catalog.json (untrusted data), and the
// asset server turns `dirname(entry)` into a static document root. So the entry walks the exact same
// chain as htmlPath — and an `od-*` entry first passes the library gate that keeps catalog data
// inside vendor/open-design. Without this an entry could point the whole asset root at C:\Windows.
async function resolveEntrySource(template, outputPath) {
  const declared = typeof template.entry === 'string' ? template.entry : null;
  if (!declared) return null;
  if (String(template.id || '').startsWith('od-')) {
    const { resolveLibraryPath } = await import('./open-design-library.mjs');
    const contained = resolveLibraryPath(declared);
    if (!contained) throw new Error(`模板 entry 越界：${declared}`);
    return await containRenderSource(contained, outputPath, '模板 entry');
  }
  const candidate = resolve(ROOT, declared);
  const rel = relative(ROOT, candidate);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`模板 entry 越界：${declared}`);
  return await containRenderSource(candidate, outputPath, '模板 entry');
}

// A read stream carries no 'error' listener of its own, so piping one straight into the response
// turns a file that disappeared between realpath/stat and open() into an uncaughtException — and
// this renderer runs inside the plugin/Harness host process. Same shape, same fix as
// src/server.mjs:sendFileBody: open the handle before any header goes out (so a failure is still a
// clean 404), pump with pipeline() so it destroys both sides, and close the handle in `finally`.
// The promise never rejects, so a failed body cannot become an unhandled rejection either.
export async function sendAssetBody(request, response, file, { headers = {} } = {}) {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch (error) {
    return assetFailure(response, error);
  }
  try {
    response.writeHead(200, headers);
    if (request.method === 'HEAD') response.end();
    else await pipeline(handle.createReadStream({ autoClose: false }), response);
  } catch {
    if (!response.headersSent) return assetFailure(response);
    if (!response.destroyed) response.destroy();
  } finally {
    await handle.close().catch(() => {});
  }
}
function assetFailure(response) {
  if (response.headersSent || response.destroyed) { if (!response.destroyed) response.destroy(); return; }
  response.writeHead(404);
  response.end();
}

async function assetServer(root, entry) {
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname);
      let file;
      if (pathname === '/__film.html') file = entry;
      else if (pathname.startsWith('/node_modules/')) file = resolve(ROOT, `.${pathname}`);
      else if (motionAssetRoots.some(directory => pathname.startsWith(`/${directory}/`))) file = resolve(ROOT, `.${pathname}`);
      else file = resolve(root, `.${pathname}`);
      const resolved = await realpath(file);
      // No entry exemption: the entry was realpath-contained in containRenderSource, and it lives
      // inside the document root derived from it, so a second bypass is not needed and would let a
      // single unvalidated pointer widen the whole asset root.
      if (!within(root, resolved) && !within(join(ROOT, 'node_modules'), resolved)
        && !motionAssetRoots.some(directory => within(join(ROOT, directory), resolved))) throw new Error('Path outside template');
      if (!(await stat(resolved)).isFile()) throw new Error('Not a file');
      const extension = extname(resolved).toLowerCase();
      const type = types[extension] || 'application/octet-stream';
      const document = executableDocuments.has(extension);
      const headers = {
        'content-type': type,
        ...(document ? { 'content-security-policy': renderCsp, 'cache-control': 'no-store' } : {}),
        ...(type === 'application/octet-stream' ? {} : { 'x-content-type-options': 'nosniff' }),
      };
      return await sendAssetBody(req, res, resolved, { headers });
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return server;
}
async function ffmpeg(args, signal) {
  const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, signal });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
  const [code] = await once(child, 'close');
  if (code !== 0) throw new Error(`Template encoding failed: ${stderr}`);
}

export async function renderTemplate({ templateId, htmlPath, outputPath, duration, fps, scale = 1, audioPath, signal, onProgress }) {
  signal?.throwIfAborted();
  outputPath = resolve(outputPath);
  if (extname(outputPath).toLowerCase() !== '.mp4') throw new Error('模板输出必须是 MP4 文件');
  const template = await resolveTemplate(templateId);
  const entryDeclared = typeof template.entry === 'string' && template.entry;
  if (!htmlPath && !entryDeclared) throw new Error(`模板 ${template.id} 只有提示词或示例，没有可渲染的源文件；请提交 htmlPath 或改用其它模板`);
  if (!htmlPath && template.previewMode === 'interactive') throw new Error(`模板 ${template.id} 是实时交互页面；请用 record-browser 录制实际操作，或先定制为支持 __seek(t) 的 htmlPath 再逐帧渲染`);
  if (!htmlPath && template.renderable === false) throw new Error(`模板 ${template.id} 的运行时依赖不可用（${template.status}），不能直接渲染；请补全依赖或提交定制 htmlPath`);
  // Resolved when it is the actual source, or when the interactive-source guard below has to compare
  // the two. A supplied htmlPath never uses the entry as a render root, so an unrelated broken catalog
  // entry must not fail an otherwise valid custom film.
  const entryReal = !htmlPath || template.previewMode === 'interactive' ? await resolveEntrySource(template, outputPath) : null;
  const source = htmlPath ? await resolveRenderSource(htmlPath, outputPath) : entryReal;
  if (htmlPath && template.previewMode === 'interactive' && source === entryReal) {
    throw new Error(`模板 ${template.id} 是原始实时交互页面；请用 record-browser 录制，或将定制合成另存为支持 __seek(t) 的 htmlPath`);
  }
  const sourceRoot = htmlPath ? dirname(source) : template.source === 'mg-styles-15' ? join(ROOT, 'vendor/mg-styles-15') : dirname(source);
  if (template.id === '04-3d-render' && !htmlPath) throw new Error('此三维模板依赖预渲染 Blender 资产，请先生成其资产再渲染');
  scale = Number(scale);
  if (!Number.isFinite(scale) || scale < 0.2 || scale > 1) throw new Error('scale 必须为 0.2 至 1');
  await mkdir(dirname(outputPath), { recursive: true });
  const framesDir = await mkdtemp(join(dirname(outputPath), '.eac-frames-'));
  const stagedOutput = join(framesDir, 'render.mp4');
  const assets = await assetServer(sourceRoot, source);
  const url = `http://127.0.0.1:${assets.address().port}`;
  let browser;
  const errors = [];
  const missing = new Set();
  try {
    browser = await chromium.launch({ ...(process.env.EAC_BROWSER ? { executablePath: process.env.EAC_BROWSER } : { channel: 'msedge' }), headless: true });
    const abort = () => { void browser.close(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const context = await browser.newContext({ viewport: { width: template.width, height: template.height }, deviceScaleFactor: scale });
      // CSP cannot constrain window.open, and a popup document does not inherit the opener's policy:
      // before this guard a rendered template could ask the browser to open any URL (a loopback port
      // probe was reproduced this way) while the report still said ok:true and missingAssets:[]. The
      // render context itself now refuses every http(s) request outside its own throwaway origin and
      // closes any popup that still appears, and both facts are reported instead of being swallowed.
      const assetOrigin = new URL(url).origin;
      const refused = [];
      await context.route('**/*', async (route) => {
        let allowed = false;
        try { allowed = new URL(route.request().url()).origin === assetOrigin; } catch { allowed = false; }
        if (allowed) return route.continue().catch(() => {});
        refused.push(route.request().url());
        return route.abort('blockedbyclient').catch(() => {});
      });
      const page = await context.newPage();
      context.on('page', (opened) => {
        if (opened === page) return;
        refused.push(opened.url());
        void opened.close().catch(() => {});
      });
      await page.addInitScript(() => { window.__odMotionRender = true; });
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('response', (response) => { if (response.status() >= 400) missing.add(response.url()); });
      const entryRelative = htmlPath ? '/__film.html' : `/${relative(sourceRoot, source).replaceAll('\\', '/')}`;
      await page.goto(`${url}${entryRelative}`, { waitUntil: 'load', timeout: 45000 });
      try {
        await page.waitForFunction(allowCss => {
          if (window.__ready === true) return true;
          if (allowCss && document.getAnimations().length > 0) return true;
          const values = window.__timelines;
          const timelines = Array.isArray(values) ? values : values instanceof Map ? [...values.values()] : values && typeof values === 'object' ? Object.values(values) : [];
          return timelines.some(timeline => typeof timeline?.seek === 'function');
        }, template.source === 'open-design', { timeout: 15000 });
        await page.evaluate(allowCss => {
          const values = window.__timelines;
          const timelines = Array.isArray(values) ? values : values instanceof Map ? [...values.values()] : values && typeof values === 'object' ? Object.values(values) : [];
          for (const timeline of timelines) {
            if (typeof timeline?.pause === 'function') timeline.pause();
          }
          if (typeof window.renderAt !== 'function' && typeof window.__seek !== 'function' && timelines.length) {
            window.__seek = time => { for (const timeline of timelines) timeline.seek?.(time, false); };
            window.__ready = true;
          } else if (allowCss && typeof window.renderAt !== 'function' && typeof window.__seek !== 'function' && document.getAnimations().length) {
            const animations = document.getAnimations();
            animations.forEach(animation => animation.pause());
            window.__seek = time => animations.forEach(animation => { animation.currentTime = time * 1000; });
            window.__ready = true;
          }
        }, template.source === 'open-design');
      } catch (error) {
        throw new Error(`模板未就绪：${errors.join('; ') || error.message}。缺失资源：${[...missing].slice(0, 8).join(', ')}`);
      }
      await page.evaluate(() => document.fonts.ready);
      // OpenDesign composition contract: pages may declare window.__timelines and/or
      // data-duration attributes instead of window.DEMO. Derive fps/duration from all
      // of them so any declared composition can be driven deterministically via __seek.
      const config = await page.evaluate(() => {
        const timelines = window.__timelines;
        const timelineList = Array.isArray(timelines) ? timelines : timelines instanceof Map ? [...timelines.values()] : timelines && typeof timelines === 'object' ? Object.values(timelines) : [];
        const timelineDurations = timelineList.flatMap((entry) => {
          if (!entry || typeof entry !== 'object') return [];
          const duration = typeof entry.duration === 'function' ? entry.duration() : entry.duration;
          return [duration, entry.total, entry.end].filter((value) => Number.isFinite(value));
        });
        const dataDurations = [...document.querySelectorAll('[data-duration]')]
          .map((node) => Number(node.getAttribute('data-duration'))).filter((value) => Number.isFinite(value) && value > 0);
        const declared = [...timelineDurations, ...dataDurations];
        return {
          fps: window.DEMO?.fps || window.__FPS || window.__meta?.fps,
          duration: window.DEMO?.duration || window.__DUR || window.__meta?.dur,
          hasTimelines: timelineList.length > 0,
          maxDeclared: declared.length ? Math.max(...declared) : undefined,
        };
      });
      const rate = Number(fps || config.fps || 30);
      const seconds = Number(duration || config.duration || config.maxDeclared || template.duration);
      if (!Number.isFinite(rate) || rate < 1 || rate > 60 || !Number.isFinite(seconds) || seconds <= 0 || seconds > 600) throw new Error('无效渲染时长或帧率');
      const seek = async (t) => page.evaluate(async (time) => {
        for (const animation of document.getAnimations()) { animation.pause(); animation.currentTime = time * 1000; }
        let render = window.renderAt || window.__seek;
        if (typeof render !== 'function' && window.__timelines) {
          const timelines = Array.isArray(window.__timelines) ? window.__timelines : Object.values(window.__timelines);
          const timeline = timelines.find((entry) => entry && typeof entry.seek === 'function');
          if (timeline) render = timeline.seek.bind(timeline);
        }
        if (typeof render !== 'function') throw new Error('模板缺少 renderAt(t)、__seek(t) 或 __timelines.seek(t)');
        await render(time);
        await document.fonts.ready;
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      }, t);
      const hash = (data) => createHash('sha256').update(data).digest('hex');
      await seek(Math.min(1, seconds / 2));
      const first = await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' });
      await seek(Math.min(1, seconds / 2));
      const second = await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' });
      const exactPixels = hash(first) === hash(second);
      const pixelCheck = exactPixels ? { meanDifference: 0, significantPixelRatio: 0 } : await page.evaluate(async ({ first, second }) => {
        const load = async (bytes) => {
          const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width; canvas.height = bitmap.height;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        };
        const a = await load(first), b = await load(second);
        if (a.length !== b.length) return { meanDifference: 255, significantPixelRatio: 1 };
        let sum = 0, significant = 0;
        for (let i = 0; i < a.length; i += 4) {
          let largest = 0;
          for (let c = 0; c < 3; c++) { const difference = Math.abs(a[i + c] - b[i + c]); sum += difference; largest = Math.max(largest, difference); }
          if (largest > 3) significant++;
        }
        return { meanDifference: sum / (a.length / 4 * 3), significantPixelRatio: significant / (a.length / 4) };
      }, { first: [...first], second: [...second] });
      // GPU shadow dithering can change a few low bits without changing the timed composition.
      const deterministic = exactPixels || (pixelCheck.meanDifference < 0.5 && pixelCheck.significantPixelRatio < 0.0005);
      if (!deterministic) {
        await writeFile(join(dirname(outputPath), 'determinism-a.png'), first);
        await writeFile(join(dirname(outputPath), 'determinism-b.png'), second);
        await writeFile(join(dirname(outputPath), 'determinism.json'), JSON.stringify(pixelCheck, null, 2));
        throw new Error(`同一时间点的画面不一致，确定性检查失败；已保存两张对比帧。像素差异：${JSON.stringify(pixelCheck)}`);
      }
      const frameCount = Math.round(seconds * rate);
      for (let frame = 0; frame < frameCount; frame++) {
        signal?.throwIfAborted();
        await seek(frame / rate);
        await page.screenshot({ path: join(framesDir, `${String(frame).padStart(6, '0')}.jpg`), type: 'jpeg', quality: 96 });
        if (frame % 15 === 0) onProgress?.(frame / frameCount);
      }
      if (errors.length) throw new Error(`模板运行错误：${errors.slice(0, 3).join('; ')}`);
      const args = ['-framerate', String(rate), '-i', join(framesDir, '%06d.jpg')];
      if (audioPath) args.push('-i', resolve(audioPath));
      args.push('-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2');
      if (audioPath) args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=9', '-c:a', 'aac', '-b:a', '192k');
      args.push('-t', String(seconds), '-movflags', '+faststart', stagedOutput);
      await ffmpeg(args, signal);
      const { qualityCheck } = await import('./media/index.mjs');
      const qa = await qualityCheck({ path: stagedOutput, expectedDuration: seconds, signal });
      if (!qa.ok) throw new Error(`模板成片技术质检失败：${qa.errors.join('; ')}`);
      signal?.throwIfAborted();
      await rename(stagedOutput, outputPath);
      qa.path = outputPath;
      const report = { path: outputPath, templateId, source, duration: seconds, fps: rate, deterministic, exactPixels, pixelCheck, missingAssets: [...missing],
        referencePreview: !htmlPath, qa, refusedEgress: refused, productionReady: qa.ok && missing.size === 0 && refused.length === 0,
        warning: !htmlPath ? '此输出是原模板示例预览；用户成片须定制内容后提交 htmlPath。' : undefined };
      await writeFile(join(dirname(outputPath), 'template-report.json'), JSON.stringify(report, null, 2));
      return report;
    } finally { signal?.removeEventListener('abort', abort); }
  } finally {
    await browser?.close();
    await new Promise((done) => { assets.close(done); assets.closeAllConnections(); });
    if (within(dirname(outputPath), framesDir) && framesDir.includes('.eac-frames-')) await rm(framesDir, { recursive: true, force: true });
  }
}
