import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../src/engine.mjs';
import { startServer } from '../src/server.mjs';
import http from 'node:http';
import { chromium } from 'playwright';
import { exportDesignArtifact, exportDocumentCsp, isolatedArtifactDocument } from '../src/design-export.mjs';

test('real HTML deck exports PDF, PNG and a two-slide PowerPoint with explicit image fidelity', { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-design-export-'));
  const engine = await createEngine({ dataDir: directory });
  const app = await startServer({ engine, port: 0 });
  try {
    const project = await engine.handle('design_project_create', { title: 'Two slides', kind: 'deck' });
    const artifact = await engine.handle('design_artifact_save', { projectId: project.id, name: '演示稿.html', content: '<!doctype html><style>body{margin:0}.slide{width:1280px;height:720px;background:#227b70;color:white;font:64px system-ui}</style><section class="slide">One</section><section class="slide" style="background:#222">Two</section>' });
    for (const format of ['pdf', 'png', 'pptx']) {
      const response = await fetch(`${app.url}/api/design/artifacts/${artifact.id}/export/${format}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: 1 }) });
      assert.equal(response.status, 201, await response.clone().text());
      const result = await response.json();
      const download = await fetch(`${app.url}${result.url}`);
      assert.equal(download.status, 200);
      assert.match(download.headers.get('content-disposition'), /attachment/);
      const bytes = Buffer.from(await download.arrayBuffer());
      assert.ok(bytes.length > 500);
      if (format === 'pdf') assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
      if (format === 'png') assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
      if (format === 'pptx') {
        assert.equal(bytes.subarray(0, 2).toString(), 'PK');
        assert.equal(result.slides, 2);
        assert.equal(result.editableElements, false);
        assert.match(result.warning, /整页图像/);
        const { default: JSZip } = await import('jszip');
        const zip = await JSZip.loadAsync(bytes);
        const slides = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
        assert.equal(slides.length, 2);
        assert.match(await zip.file(slides[0]).async('string'), /<p:pic>/);
      }
    }
    assert.equal((await engine.designStore.readContent(artifact.id)).revision, 1);
  } finally { await app.close(); await engine.close(); await rm(directory, { recursive: true, force: true }); }
});

test('export resolves relative vendor assets and blocks requests to the API', { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-export-assets-'));
  const engine = await createEngine({ dataDir: directory });
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'content-type': 'image/svg+xml' });
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="red"/></svg>');
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const project = await engine.handle('design_project_create', { title: 'Relative assets', kind: 'website' });
    const artifact = await engine.handle('design_artifact_save', {
      projectId: project.id, name: 'index.html',
      content: '<!doctype html><img src="/vendor/relative.svg"><script>fetch("/api/design/projects",{method:"POST"}).catch(()=>{})</script>',
    });
    const result = await exportDesignArtifact({ store: engine.designStore, id: artifact.id, format: 'png', origin });
    assert.ok((await readFile(result.path)).length > 500);
    assert.deepEqual(requests, ['/vendor/relative.svg']);
    // The export page is isolated (opaque origin) and reported that honestly.
    assert.equal(result.pageSandboxed, true);
    assert.equal(result.complete, true);
    assert.equal(result.blockedRequests.count, 0);
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await engine.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('export reports the resources it refused instead of shipping a silently incomplete file', { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-export-missing-'));
  const engine = await createEngine({ dataDir: directory });
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'content-type': 'image/svg+xml' });
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="red"/></svg>');
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const project = await engine.handle('design_project_create', { title: 'Missing assets', kind: 'website' });
    const artifact = await engine.handle('design_artifact_save', {
      projectId: project.id, name: 'index.html',
      // A relative stylesheet, a relative image and an allowed vendor image: the artifact is typical
      // of a page written against the project folder, where relative paths can never resolve here.
      content: '<!doctype html><link rel="stylesheet" href="./style.css"><img src="images/photo.svg"><img src="/vendor/allowed.svg">'
        // Touching storage used to work on the same-origin export page; the isolated page throws and
        // the export must say so instead of reporting a clean success.
        + '<script>localStorage.getItem("design-export-probe")</script>',
    });
    const result = await exportDesignArtifact({ store: engine.designStore, id: artifact.id, format: 'png', origin });
    assert.ok((await readFile(result.path)).length > 500, 'the export still produces its file');
    assert.equal(result.complete, false);
    assert.equal(result.blockedRequests.count, 2);
    const blockedUrls = result.blockedRequests.sample.map(item => item.url);
    assert.ok(blockedUrls.some(url => url.endsWith('/__eac-export/style.css')), blockedUrls.join(', '));
    assert.ok(blockedUrls.some(url => url.endsWith('/__eac-export/images/photo.svg')), blockedUrls.join(', '));
    assert.ok(result.blockedRequests.sample.every(item => typeof item.type === 'string'));
    assert.match(result.warning, /导出缺失 2 个外部资源/);
    assert.match(result.warning, /__eac-export\/style\.css/);
    assert.deepEqual(requests, ['/vendor/allowed.svg'], 'refused resources never reach the server');
    assert.equal(result.pageSandboxed, true);
    assert.ok(result.pageErrors.count >= 1, JSON.stringify(result.pageErrors));
    assert.match(result.warning, /导出页脚本报错/);
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await engine.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('the export page policy runs scripts in an opaque origin and blocks every network egress', { timeout: 45000 }, async () => {
  const origin = 'http://127.0.0.1:43210';
  const policy = exportDocumentCsp(origin);
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /connect-src 'none'/);
  assert.match(policy, /form-action 'none'/);
  assert.doesNotMatch(policy, /\*/);
  const hits = [];
  const spy = http.createServer((request, response) => {
    hits.push(request.url);
    response.writeHead(200, { 'content-type': 'image/gif' });
    response.end('GIF89a');
  });
  let browser;
  try {
    await new Promise(done => spy.listen(0, '127.0.0.1', done));
    const spyOrigin = `http://127.0.0.1:${spy.address().port}`;
    browser = await chromium.launch({ ...(process.env.EAC_BROWSER ? { executablePath: process.env.EAC_BROWSER } : { channel: 'msedge' }), headless: true });
    const page = await browser.newPage({ viewport: { width: 640, height: 360 }, serviceWorkers: 'block' });
    await page.setContent(isolatedArtifactDocument(`<!doctype html><html><head><style>body{margin:0;background:#123456}</style></head><body>
      <div id="mark">pending</div>
      <script>
        fetch('${spyOrigin}/beacon', { method: 'POST', body: 'x' }).catch(() => {});
        new Image().src = '${spyOrigin}/pixel.gif';
        document.getElementById('mark').textContent = 'script ran';
      </script></body></html>`, origin), { waitUntil: 'load' });
    await page.waitForTimeout(600);
    assert.equal(await page.locator('#mark').textContent(), 'script ran');
    assert.equal(await page.evaluate(() => document.baseURI), `${origin}/__eac-export/`);
    assert.equal(await page.evaluate(() => { try { window.localStorage.setItem('probe', '1'); return 'reachable'; } catch { return 'blocked'; } }), 'blocked');
    assert.deepEqual(hits, []);
  } finally {
    await browser?.close();
    await new Promise(done => { spy.close(done); spy.closeAllConnections(); });
  }
});

