import http from 'node:http';
import { existsSync } from 'node:fs';
import { open, readFile, stat, realpath } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { resolve, join, extname, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, getTemplates } from './catalog.mjs';
import { createEngine } from './engine.mjs';
import { designArtifactKinds } from './design-store.mjs';
import { VERSION } from './version.mjs';
import { createMaintenance } from './maintenance.mjs';
import { RELEASE_PUBLIC_KEY } from './maintenance-key.mjs';
import { injectPreviewBridge, previewConfig } from './template-preview-bridge.mjs';

const mime = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.glb': 'model/gltf-binary',
  '.hdr': 'application/octet-stream', '.exr': 'application/octet-stream',
  '.md': 'text/markdown; charset=utf-8', '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};
const inside = (root, path) => {
  const rel = relative(root, path);
  return !rel.startsWith('..') && !isAbsolute(rel);
};
// Preview runs saved/imported HTML/SVG in an opaque origin: sandbox WITHOUT allow-same-origin,
// so scripts cannot read cookies, storage, or reach the EAC API with shared privileges. Subresource
// loads are limited to the server's own loopback origin (so source-ready HTML still finds its local
// assets); connect-src and forms stay blocked. Only an optional template project can
// resolve a base URL on the current local server origin.
// The allowed sources are exactly this server's origin, in both loopback spellings and on its own
// port. A `http://127.0.0.1:*` / `http://localhost:*` port wildcard would let a previewed document
// (vendor/open-design/** is upstream-controllable) blind-GET every service on this machine from an
// opaque origin — local CSRF and port probing — even with connect-src 'none'.
function previewOrigins(origin) {
  if (!origin) return [];
  const url = new URL(origin);
  const twin = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname === '127.0.0.1' ? 'localhost' : null;
  return twin ? [origin, `${url.protocol}//${twin}${url.port ? `:${url.port}` : ''}`] : [origin];
}
export function previewCsp(kind, origin, assetBase = "'none'") {
  const local = previewOrigins(origin);
  const sources = (base) => [...base, ...local].join(' ').trim();
  if (kind === 'markdown') return "sandbox; default-src 'none'; style-src 'unsafe-inline'";
  if (kind === 'svg') return `sandbox; default-src 'none'; style-src ${sources(["'unsafe-inline'"])}; img-src ${sources(['data:', 'blob:'])}; font-src ${sources(['data:'])}`;
  return `sandbox allow-scripts allow-downloads; default-src 'none'; script-src ${sources(["'unsafe-inline'"])}; style-src ${sources(["'unsafe-inline'"])}; img-src ${sources(['data:', 'blob:'])}; font-src ${sources(['data:'])}; media-src ${sources(['data:', 'blob:'])}; connect-src 'none'; base-uri ${assetBase}; form-action 'none'`;
}
// A read stream has no 'error' listener of its own, so piping one straight into the response
// turns a missing or unreadable file into an uncaughtException — and plugin/host.mjs runs this
// server inside the Harness host process, so that kills the host. The race is real: stat() and the
// open are separate syscalls, and engine.mjs removes job directories while /api/files downloads
// are still in flight. So the handle is opened before any header goes out (a failure is answered
// as 404/500 while headers are unsent) and the body is pumped with pipeline(), which destroys both
// sides and reports the error to this function instead of the process. The promise never rejects,
// so callers cannot turn it into an unhandled rejection.
export async function sendFileBody(request, response, file, { status = 200, headers = {}, start, end } = {}) {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch (error) {
    return answerStreamFailure(response, error);
  }
  try {
    response.writeHead(status, headers);
    if (request.method === 'HEAD') response.end();
    else await pipeline(handle.createReadStream({ start, end, autoClose: false }), response);
  } catch (error) {
    if (!response.headersSent) return answerStreamFailure(response, error);
    // Headers are gone: terminate the transfer so the client sees a truncated body instead of
    // hanging, and keep the failure out of the process.
    if (!response.destroyed) response.destroy();
  } finally {
    await handle.close().catch(() => {});
  }
}
function answerStreamFailure(response, error) {
  if (response.headersSent || response.destroyed) { if (!response.destroyed) response.destroy(); return; }
  const code = ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code) ? 404 : 500;
  response.writeHead(code, { 'content-type': mime['.json'], 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: error.message }));
}
// The composer controls live inside the Harness dsh-app context and must reach this one
// endpoint across origins. Only this route relaxes CORS, and only for trusted origins.
const trustedOrigin = (value) => Boolean(value) && (
  /^dsh-app:/i.test(value) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(value) ||
  (process.env.EAC_COMPOSER_ORIGIN ? value === process.env.EAC_COMPOSER_ORIGIN : false)
);
function cors(response, request) {
  const origin = request.headers.origin;
  if (trustedOrigin(origin)) response.setHeader('access-control-allow-origin', origin);
  response.setHeader('access-control-allow-methods', 'GET, PUT, OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type');
  response.setHeader('vary', 'origin');
}
function json(response, code, value) {
  response.writeHead(code, { 'content-type': mime['.json'], 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}
async function body(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('请求必须使用 application/json');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
      if (size > 6 * 1024 * 1024) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
// Only these read-oriented tools are exposed over the generic HTTP mapping; mutations keep
// their dedicated endpoints so method and status semantics stay explicit.
const exposedTools = new Set(['template_read', 'library_read', 'library_list']);
async function serveUntrusted(request, response, file, kind, origin) {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) { response.writeHead(404); response.end(); return; }
  const headers = {
    'content-type': mime[extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': info.size, 'x-content-type-options': 'nosniff',
    'content-security-policy': previewCsp(kind, origin),
    'cache-control': 'no-store',
  };
  return sendFileBody(request, response, file, { headers });
}
async function serveArtifact(request, response, file, { preview, origin, assetBase }) {
  const info = await stat(file.path).catch(() => null);
  if (!info?.isFile()) { response.writeHead(404); response.end(); return; }
  const extension = extname(file.path).toLowerCase();
  const type = mime[extension] || 'application/octet-stream';
  const headers = { 'content-type': type, 'content-length': info.size, 'x-content-type-options': 'nosniff' };
  if (preview) {
    headers['content-security-policy'] = previewCsp(file.kind, origin, assetBase);
    headers['cache-control'] = 'no-store';
  } else {
    const fallback = file.name.replace(/[^A-Za-z0-9._-]+/g, '_');
    headers['content-disposition'] = `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(file.name)}`;
  }
  return sendFileBody(request, response, file.path, { headers });
}
async function serveFile(request, response, file) {
  const info = await stat(file);
  if (!info.isFile()) { response.writeHead(404); response.end(); return; }
  const extension = extname(file).toLowerCase();
  const headers = { 'content-type': mime[extension] || 'application/octet-stream', 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff',
    ...(['.woff2', '.woff', '.ttf'].includes(extension) ? { 'access-control-allow-origin': '*' } : {}) };
  if (request.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
    if (!match || (!match[1] && !match[2])) { response.writeHead(416, { 'content-range': `bytes */${info.size}` }); response.end(); return; }
    const start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) { response.writeHead(416, { 'content-range': `bytes */${info.size}` }); response.end(); return; }
    return sendFileBody(request, response, file, { status: 206, start, end,
      headers: { ...headers, 'content-range': `bytes ${start}-${end}/${info.size}`, 'content-length': end - start + 1 } });
  }
  return sendFileBody(request, response, file, { headers: { ...headers, 'content-length': info.size } });
}

export async function startServer({ engine: suppliedEngine, port = Number(process.env.EAC_PORT || 4173), dev = false, maintenanceOptions = {} } = {}) {
  const engine = suppliedEngine || await createEngine();
  const maintenance = createMaintenance({ engine, manifestPublicKey: RELEASE_PUBLIC_KEY, ...maintenanceOptions });
  // instanceId 每个维护实例固定不变；缓存它供 /api/health 使用，避免健康检查
  // 每次都走 status() 把本地安装的一次性令牌池冲掉（令牌随每次 status() 发放）。
  const healthInstanceId = maintenance.status().instanceId;
  const vite = dev ? await (await import('vite')).createServer({ root: ROOT, server: { middlewareMode: true }, appType: 'spa' }) : null;
  let origin;
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const host = request.headers.host?.split(':')[0];
      if (!['localhost', '127.0.0.1', '['].includes(host)) return json(response, 403, { error: 'Invalid host' });
      if (url.pathname.startsWith('/api/')) {
        const requestOrigin = request.headers.origin;
        const loopback = (value) => value === origin || value === origin.replace('127.0.0.1', 'localhost');
        const composerRoute = url.pathname === '/api/composer';
        if (requestOrigin && !loopback(requestOrigin) && !(composerRoute && trustedOrigin(requestOrigin))) {
          return json(response, 403, { error: '跨来源请求被拒绝' });
        }
        if (url.pathname === '/api/health') return json(response, 200, { ok: true, name: 'EAC design world', version: VERSION, instanceId: healthInstanceId });
        if (url.pathname === '/api/maintenance' && request.method === 'GET') return json(response, 200, maintenance.status());
        if (url.pathname.startsWith('/api/maintenance/') && ['POST', 'PUT'].includes(request.method)) {
          const input = await body(request);
          const action = url.pathname.slice('/api/maintenance/'.length);
          if (action === 'settings' && request.method === 'PUT') return json(response, 200, await maintenance.settingsUpdate(input));
          if (action === 'announcements/refresh') return json(response, 200, await maintenance.refreshAnnouncements());
          if (action === 'announcements/ack') return json(response, 200, await maintenance.acknowledge(input.ids));
          if (['check', 'apply', 'local', 'reload', 'rollback'].includes(action)) return json(response, 202, maintenance.start(action, input));
          return json(response, 404, { error: '维护接口不存在' });
        }
        if (composerRoute) {
          cors(response, request);
          if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
          if (request.method === 'PUT') return json(response, 200, await engine.handle('composer_update', await body(request)));
          if (request.method === 'GET') return json(response, 200, await engine.handle('composer_get', { sessionId: url.searchParams.get('sessionId') ?? undefined }));
        }
        if (url.pathname === '/api/library' && request.method === 'GET') return json(response, 200, await engine.library());
        if (url.pathname === '/api/design/projects' && request.method === 'POST') return json(response, 201, await engine.handle('design_project_create', await body(request)));
        if (url.pathname === '/api/design/artifacts' && request.method === 'POST') return json(response, 201, await engine.handle('design_artifact_save', await body(request)));
        if (url.pathname === '/api/design/state' && request.method === 'GET') return json(response, 200, await engine.handle('design_state', { sessionId: url.searchParams.get('sessionId') ?? undefined }));
        const designExportMatch = /^\/api\/design\/artifacts\/([^/]+)\/export\/(pdf|pptx|png)$/.exec(url.pathname);
        if (designExportMatch && ['POST', 'GET'].includes(request.method)) {
          const id = decodeURIComponent(designExportMatch[1]);
          const format = designExportMatch[2];
          const input = request.method === 'POST' ? await body(request) : {};
          const revision = input.revision ?? (url.searchParams.has('revision') ? Number(url.searchParams.get('revision')) : undefined);
          if (request.method === 'POST') {
            const { exportDesignArtifact } = await import('./design-export.mjs');
            const result = await exportDesignArtifact({ store: engine.designStore, id, format, revision, origin });
            return json(response, 201, { ...result, url: `/api/design/artifacts/${id}/export/${format}?revision=${result.revision}` });
          }
          const source = engine.designStore.fileFor(id, revision);
          const path = join(engine.designStore.root, 'exports', source.id, `v${source.revision}.${format}`);
          return await serveArtifact(request, response, { ...source, path, name: source.name.replace(/\.[^.]+$/, '') + `.${format}` }, { preview: false });
        }
        const designArtifactMatch = /^\/api\/design\/artifacts\/([^/]+)\/(content|preview|download)$/.exec(url.pathname);
        if (designArtifactMatch && ['GET', 'HEAD'].includes(request.method)) {
          const id = decodeURIComponent(designArtifactMatch[1]);
          const action = designArtifactMatch[2];
          const revision = url.searchParams.get('revision') ?? undefined;
          if (action === 'content') return json(response, 200, await engine.designStore.readContent(id, revision ? Number(revision) : undefined));
          const file = engine.designStore.fileFor(id, revision ? Number(revision) : undefined);
          if (action === 'preview') {
            const project = engine.designStore.project(file.projectId);
            const template = getTemplates().find(item => item.id === project.templateId && ['motion-web', 'onetake'].includes(item.source));
            const assetBase = template ? origin : undefined;
            return await serveArtifact(request, response, file, { preview: true, origin, assetBase });
          }
          return await serveArtifact(request, response, file, { preview: false });
        }
        const toolMatch = /^\/api\/tools\/([A-Za-z_][A-Za-z0-9_]*)$/.exec(url.pathname);
        if (toolMatch && request.method === 'POST') {
          const name = toolMatch[1];
          if (!exposedTools.has(name)) return json(response, 404, { error: '接口不存在' });
          return json(response, 200, await engine.handle(name, await body(request)));
        }
        if (url.pathname === '/api/state' && request.method === 'GET') return json(response, 200, await engine.state({ includeTemplates: url.searchParams.get('templates') !== '0' }));
        if (url.pathname === '/api/settings' && request.method === 'PUT') return json(response, 200, await engine.settingsUpdate(await body(request)));
        if (url.pathname === '/api/files' && ['GET', 'HEAD'].includes(request.method)) {
          const path = url.searchParams.get('path') || '';
          if (!await engine.canServeFile(path)) return json(response, 403, { error: '文件不属于已导入素材或输出目录' });
          const extension = extname(path).toLowerCase();
          if (['.html', '.htm', '.svg'].includes(extension)) {
            return await serveUntrusted(request, response, resolve(path), extension === '.svg' ? 'svg' : 'html', origin);
          }
          return await serveFile(request, response, resolve(path));
        }
        if (url.pathname === '/api/projects' && request.method === 'POST') return json(response, 201, await engine.handle('project_create', await body(request)));
        if (url.pathname === '/api/jobs' && request.method === 'POST') return json(response, 202, await engine.handle('job_submit', await body(request)));
        const projectMatch = /^\/api\/projects\/([^/]+)(?:\/(assets|plan|timeline))?$/.exec(url.pathname);
        if (projectMatch) {
          const projectId = decodeURIComponent(projectMatch[1]);
          if (request.method === 'GET' && !projectMatch[2]) return json(response, 200, await engine.handle('project_get', { projectId }));
          const methods = { assets: 'asset_import', plan: 'timeline_plan', timeline: 'timeline_update' };
          if (['POST', 'PUT'].includes(request.method) && methods[projectMatch[2]]) {
            return json(response, 200, await engine.handle(methods[projectMatch[2]], { ...await body(request), projectId }));
          }
        }
        const jobMatch = /^\/api\/jobs\/([^/]+)(\/cancel)?$/.exec(url.pathname);
        if (jobMatch && request.method === (jobMatch[2] ? 'POST' : 'GET')) {
          return json(response, 200, await engine.handle(jobMatch[2] ? 'job_cancel' : 'job_status', { jobId: jobMatch[1] }));
        }
        return json(response, 404, { error: '接口不存在' });
      }
      if (url.pathname.startsWith('/vendor/')) {
        const vendor = await realpath(join(ROOT, 'vendor'));
        const path = await realpath(resolve(ROOT, `.${decodeURIComponent(url.pathname)}`));
        if (!inside(vendor, path) || /(^|[\\/])\.git([\\/]|$)/.test(path)) return json(response, 403, { error: 'Forbidden' });
        // Preview HTML keeps its real document URL so opaque frames can load local assets.
        // Only validated preview requests get the bridge; the sandbox policy stays intact.
        const openDesign = inside(join(vendor, 'open-design'), path);
        const extension = extname(path).toLowerCase();
        if (['.html', '.htm'].includes(extension)) {
          const documentOrigin = host === 'localhost' ? origin.replace('127.0.0.1', 'localhost') : origin;
          const config = previewConfig(url.searchParams, documentOrigin);
          if (config) {
            const html = injectPreviewBridge(await readFile(path, 'utf8'), config);
            response.writeHead(200, {
              'content-type': mime[extension], 'content-length': Buffer.byteLength(html),
              'content-security-policy': previewCsp('html', origin),
              'x-content-type-options': 'nosniff', 'cache-control': 'no-store',
            });
            response.end(request.method === 'HEAD' ? undefined : html);
            return;
          }
        }
        const optionalMotion = ['motion-web', 'onetake', 'eac-motion'].some(name => inside(join(vendor, name), path));
        const untrusted = (openDesign || optionalMotion) && ['.html', '.htm', '.svg'].includes(extension);
        if (untrusted) return await serveUntrusted(request, response, path, extension === '.svg' ? 'svg' : 'html', origin);
        return await serveFile(request, response, path);
      }
      if (vite) return vite.middlewares(request, response, () => { response.writeHead(404); response.end(); });
      const dist = resolve(ROOT, 'dist');
      const file = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
      if (!inside(dist, file)) return json(response, 403, { error: 'Forbidden' });
      return await serveFile(request, response, existsSync(file) && (await stat(file)).isFile() ? file : join(dist, 'index.html'));
    } catch (error) {
      if (response.headersSent) { response.destroy(error); return; }
      // error.code 一并返回（如本地安装令牌 EAC_LOCAL_TOKEN），前端据此给出可操作提示。
      return json(response, error.code === 'ENOENT' ? 404 : 400, { error: error.message, ...(error.code ? { code: error.code } : {}) });
    }
  });
  try {
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
  } catch (error) {
    await maintenance.close();
    await vite?.close();
    if (!suppliedEngine) await engine.close();
    throw error;
  }
  const actualPort = server.address().port;
  origin = `http://127.0.0.1:${actualPort}`;
  return {
    port: actualPort, url: origin, engine, maintenance,
    async close() {
      await maintenance.close();
      await new Promise((done) => { server.close(done); server.closeAllConnections(); });
      await vite?.close();
      if (!suppliedEngine) await engine.close();
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await startServer({ dev: process.argv.includes('--dev') });
  console.log(`EAC design world: ${app.url}`);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    process.exit(0);
  });
}
