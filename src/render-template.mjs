import http from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, stat, writeFile, rm, realpath, rename } from 'node:fs/promises';
import { resolve, join, dirname, relative, isAbsolute, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { ROOT, resolveTemplate } from './catalog.mjs';
import { chromium } from 'playwright';

const within = (root, file) => { const rel = relative(root, file); return !rel.startsWith('..') && !isAbsolute(rel); };
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.glb': 'model/gltf-binary', '.mp4': 'video/mp4' };

async function assetServer(root, entry) {
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname);
      let file;
      if (pathname === '/__film.html') file = entry;
      else if (pathname.startsWith('/node_modules/')) file = resolve(ROOT, `.${pathname}`);
      else file = resolve(root, `.${pathname}`);
      const resolved = await realpath(file);
      if (resolved !== entry && !within(root, resolved) && !within(join(ROOT, 'node_modules'), resolved)) throw new Error('Path outside template');
      if (!(await stat(resolved)).isFile()) throw new Error('Not a file');
      res.writeHead(200, { 'content-type': types[extname(resolved)] || 'application/octet-stream' });
      createReadStream(resolved).pipe(res);
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
  if (!htmlPath && !template.entry) throw new Error(`模板 ${template.id} 只有提示词或示例，没有可渲染的源文件；请提交 htmlPath 或改用其它模板`);
  if (!htmlPath && template.renderable === false) throw new Error(`模板 ${template.id} 的运行时依赖不可用（${template.status}），不能直接渲染；请补全依赖或提交定制 htmlPath`);
  const source = resolve(ROOT, htmlPath || template.entry);
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
      const page = await context.newPage();
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
          fps: window.DEMO?.fps || window.__FPS,
          duration: window.DEMO?.duration || window.__DUR,
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
        referencePreview: !htmlPath, qa, productionReady: qa.ok && missing.size === 0,
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
