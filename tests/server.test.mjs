import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createEngine } from '../src/engine.mjs';
import { previewCsp, sendFileBody, startServer } from '../src/server.mjs';

const serverSource = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');

// The harness host runs this server in-process (plugin/host.mjs), so an uncaught stream error is a
// host-level crash. These listeners turn that into a test assertion instead of a dead test run.
function watchProcess() {
  const seen = [];
  const onException = (error) => seen.push({ kind: 'uncaughtException', code: error?.code, message: error?.message });
  const onRejection = (error) => seen.push({ kind: 'unhandledRejection', code: error?.code, message: error?.message });
  process.on('uncaughtException', onException);
  process.on('unhandledRejection', onRejection);
  return {
    seen,
    stop() {
      process.off('uncaughtException', onException);
      process.off('unhandledRejection', onRejection);
    },
  };
}
async function withServer(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'eac-server-'));
  const outputRoot = join(directory, 'outputs');
  await mkdir(outputRoot, { recursive: true });
  const engine = await createEngine({ dataDir: directory });
  await engine.settingsUpdate({ outputRoot });
  const app = await startServer({ engine, port: 0 });
  try {
    return await fn({ app, engine, directory, outputRoot });
  } finally {
    await app.close();
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('preview CSP allows only the server origin, never a loopback port wildcard', () => {
  const origin = 'http://127.0.0.1:4173';
  for (const kind of ['html', 'svg']) {
    const csp = previewCsp(kind, origin);
    assert.doesNotMatch(csp, /127\.0\.0\.1:\*/, `${kind}: port wildcard must not come back`);
    assert.doesNotMatch(csp, /localhost:\*/, `${kind}: port wildcard must not come back`);
    // Same-origin assets are what a source-ready preview needs, so the real origin stays reachable —
    // in both loopback spellings, on this port only.
    assert.ok(csp.includes('http://127.0.0.1:4173'), `${kind}: ${csp}`);
    assert.ok(csp.includes('http://localhost:4173'), `${kind}: ${csp}`);
    assert.match(csp, /sandbox/);
    assert.doesNotMatch(csp, /allow-same-origin/);
    if (kind === 'html') assert.match(csp, /connect-src 'none'/);
    assert.doesNotMatch(csp, /https?:\/\/[^ ]*:\*/);
  }
  // Markdown has no local assets at all.
  assert.equal(previewCsp('markdown', origin), "sandbox; default-src 'none'; style-src 'unsafe-inline'");
  // A localhost-hosted UI keeps working, still without any port wildcard.
  const localhost = previewCsp('html', 'http://localhost:5000');
  assert.ok(localhost.includes('http://localhost:5000'));
  assert.ok(localhost.includes('http://127.0.0.1:5000'));
  assert.doesNotMatch(localhost, /:\*/);
  // Defensive: a missing origin must not reintroduce a wildcard.
  assert.doesNotMatch(previewCsp('html', undefined), /:\*/);
});

test('a file that vanishes between stat and the read answers 404 and never reaches the process', async () => {
  const watch = watchProcess();
  const directory = await mkdtemp(join(tmpdir(), 'eac-stream-failure-'));
  // The race: stat() succeeded (the route already approved this path), then the file is removed —
  // engine.mjs removes job directories while /api/files downloads are in flight. Driving the same
  // serve primitive the four routes use reproduces exactly the open-after-stat failure.
  const vanished = join(directory, 'vanished.mp4');
  await writeFile(vanished, Buffer.alloc(64, 1));
  await rm(vanished);
  const healthy = join(directory, 'healthy.txt');
  await writeFile(healthy, 'still serving');
  const server = createServer((request, response) => {
    const file = request.url === '/gone' ? vanished : healthy;
    void sendFileBody(request, response, file, { headers: { 'content-type': 'text/plain' } });
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    // A timeout keeps a failed fix from hanging the run: without error handling the response is
    // never finished, the client just waits.
    const gone = await fetch(`${origin}/gone`, { signal: AbortSignal.timeout(5000) })
      .catch((error) => ({ status: 0, error: error.message }));
    assert.deepEqual(watch.seen, [], 'a stream failure must never reach the process');
    assert.equal(gone.status, 404, `vanished file must answer 404, got ${gone.status} ${gone.error ?? ''}`);
    assert.match(await gone.text(), /ENOENT|no such file/i);
    // The same process keeps answering: this is the behaviour the host depends on.
    const alive = await fetch(`${origin}/ok`, { signal: AbortSignal.timeout(5000) });
    assert.equal(alive.status, 200);
    assert.equal(await alive.text(), 'still serving');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(watch.seen, []);
  } finally {
    watch.stop();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failure after the headers were sent tears down the transfer without an unhandled rejection', async () => {
  const watch = watchProcess();
  const directory = await mkdtemp(join(tmpdir(), 'eac-stream-abort-'));
  const file = join(directory, 'body.bin');
  await writeFile(file, Buffer.alloc(256 * 1024, 3));
  class FlakySink extends Writable {
    headersSent = false;
    closedByServer = false;
    writeHead() { this.headersSent = true; }
    destroy(error) { this.closedByServer = true; return super.destroy(); }
    _write(chunk, encoding, callback) { callback(new Error('socket gone')); }
  }
  try {
    const sink = new FlakySink();
    // Must resolve (never reject) even though the body write fails mid-transfer.
    await sendFileBody({ method: 'GET' }, sink, file, { headers: { 'content-type': 'application/octet-stream' } });
    assert.equal(sink.headersSent, true);
    assert.equal(sink.closedByServer, true);
    assert.equal(sink.destroyed, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(watch.seen, []);
  } finally {
    watch.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('file routes still serve bodies, ranges, HEAD and sandboxed previews after the stream change', async () => {
  await withServer(async ({ app, engine, outputRoot }) => {
    const binary = join(outputRoot, 'clip.bin');
    await writeFile(binary, Buffer.alloc(4096, 7));
    const url = `${app.url}/api/files?path=${encodeURIComponent(binary)}`;
    const full = await fetch(url);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-length'), '4096');
    assert.equal((await full.arrayBuffer()).byteLength, 4096);
    const range = await fetch(url, { headers: { range: 'bytes=0-31' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), 'bytes 0-31/4096');
    assert.equal((await range.arrayBuffer()).byteLength, 32);
    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), '4096');
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal((await fetch(url, { headers: { range: 'bytes=99999999-' } })).status, 416);
    // The stat-then-removed window is the real crash seat; the route still refuses honestly.
    await rm(binary);
    const gone = await fetch(url);
    assert.ok([403, 404].includes(gone.status), `status ${gone.status}`);
    // Sandboxed preview keeps the tightened policy plus a real body.
    const html = join(outputRoot, 'preview.html');
    await writeFile(html, '<!doctype html><h1>Output preview</h1>');
    const preview = await fetch(`${app.url}/api/files?path=${encodeURIComponent(html)}`);
    assert.equal(preview.status, 200);
    const csp = preview.headers.get('content-security-policy');
    assert.match(csp, /sandbox allow-scripts/);
    assert.doesNotMatch(csp, /127\.0\.0\.1:\*|localhost:\*/);
    assert.ok(csp.includes(app.url), csp);
    assert.equal(await preview.text(), '<!doctype html><h1>Output preview</h1>');
    const svg = join(outputRoot, 'preview.svg');
    await writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>');
    const svgPreview = await fetch(`${app.url}/api/files?path=${encodeURIComponent(svg)}`);
    assert.equal(svgPreview.status, 200);
    assert.match(svgPreview.headers.get('content-security-policy'), /sandbox; default-src 'none'/);
    assert.doesNotMatch(svgPreview.headers.get('content-security-policy'), /:\*/);
    // Design artifacts are the third preview surface and go through the same policy helper.
    const project = await engine.handle('design_project_create', { title: 'Preview', kind: 'website' });
    const artifact = await engine.handle('design_artifact_save', { projectId: project.id, name: 'page.html', content: '<!doctype html><h1>Hi</h1>' });
    const artifactPreview = await fetch(`${app.url}/api/design/artifacts/${artifact.id}/preview`);
    assert.equal(artifactPreview.status, 200);
    const artifactCsp = artifactPreview.headers.get('content-security-policy');
    assert.doesNotMatch(artifactCsp, /:\*/);
    assert.ok(artifactCsp.includes(app.url), artifactCsp);
    assert.equal(await artifactPreview.text(), '<!doctype html><h1>Hi</h1>');
    const download = await fetch(`${app.url}/api/design/artifacts/${artifact.id}/download`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /attachment/);
    assert.equal(await download.text(), '<!doctype html><h1>Hi</h1>');
    // The service is still healthy after all of it.
    assert.equal((await fetch(`${app.url}/api/health`)).status, 200);
  });
});

test('no route pipes a read stream straight into the response', async () => {
  const source = await readFile(serverSource, 'utf8');
  // `createReadStream(...).pipe(response)` has no 'error' listener: an ENOENT between stat() and
  // open() becomes an uncaughtException in the host process. Everything must go through the
  // hardened primitive, which opens first and pumps with pipeline().
  assert.doesNotMatch(source, /\.pipe\(response\)/);
  assert.doesNotMatch(source, /createReadStream\(\s*(file|path)\b/);
  assert.match(source, /from 'node:stream\/promises'/);
  assert.ok((source.match(/sendFileBody\(/g) || []).length >= 4, 'every serve path routes through sendFileBody');
});

test('a sandboxed preview reaches its own origin but no other local port', { timeout: 60000 }, async () => {
  // With `img-src ... http://127.0.0.1:*` a previewed, upstream-controllable document could
  // blind-GET any service on this machine from an opaque origin (local CSRF / port probing).
  let probeHits = 0;
  const probe = createServer((request, response) => {
    probeHits += 1;
    response.writeHead(200, { 'content-type': 'image/png' });
    response.end(png);
  });
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const probeOrigin = `http://127.0.0.1:${probe.address().port}`;
  let browser;
  try {
    await withServer(async ({ app, outputRoot }) => {
      await writeFile(join(outputRoot, 'dot.png'), png);
      await writeFile(join(outputRoot, 'page.css'), 'body { color: rgb(1, 2, 3) }');
      const own = `${app.url}/api/files?path=${encodeURIComponent(join(outputRoot, 'dot.png'))}`;
      const ownCss = `${app.url}/api/files?path=${encodeURIComponent(join(outputRoot, 'page.css'))}`;
      const previewFile = join(outputRoot, 'preview.html');
      await writeFile(previewFile, `<!doctype html><html><head><link rel="stylesheet" href="${ownCss}"></head><body>
        <img id="own" src="${own}">
        <img id="foreign" src="${probeOrigin}/probe.png">
      </body></html>`);
      const previewUrl = `${app.url}/api/files?path=${encodeURIComponent(previewFile)}`;
      browser = await chromium.launch({ headless: true, ...(process.env.EAC_BROWSER ? { executablePath: process.env.EAC_BROWSER } : process.platform === 'win32' ? { channel: 'msedge' } : {}) });
      const page = await browser.newPage();
      const requests = [], responses = [];
      page.on('request', (request) => requests.push(request.url()));
      page.on('response', (response) => responses.push({ url: response.url(), status: response.status() }));
      await page.setContent(`<!doctype html><body><iframe sandbox="allow-scripts" src="${previewUrl}" width="600" height="400"></iframe></body>`);
      await page.waitForTimeout(2000);
      // Same-origin assets of the preview still load, so the tightening did not break previews.
      const image = responses.find((entry) => entry.url === own);
      assert.ok(image, `own origin asset must load: ${JSON.stringify({ responses, requests })}`);
      assert.equal(image.status, 200);
      const stylesheet = responses.find((entry) => entry.url === ownCss);
      assert.ok(stylesheet, `own origin stylesheet must load: ${JSON.stringify(responses)}`);
      assert.equal(stylesheet.status, 200);
      // A different loopback port is not a local source any more: the other server never sees it.
      assert.equal(probeHits, 0, `blocked CSP still produced a request to ${probeOrigin}`);
      assert.equal(responses.some((entry) => entry.url.startsWith(probeOrigin)), false);
    });
    // A real upstream OpenDesign preview keeps loading its own CSS/JS under the tightened policy.
    await withServer(async ({ app }) => {
      const deck = '/vendor/open-design/templates/design-templates/html-ppt/examples/demo-deck/index.html';
      const deckPage = await browser.newPage();
      const local = [];
      deckPage.on('response', (response) => { if (response.url().startsWith(app.url)) local.push({ url: response.url(), status: response.status() }); });
      await deckPage.setContent(`<!doctype html><body><iframe sandbox="allow-scripts" src="${app.url}${deck}" width="1000" height="700"></iframe></body>`);
      await deckPage.waitForTimeout(2000);
      await deckPage.close();
      const styles = local.filter((entry) => entry.url.endsWith('.css'));
      if (local.length === 0) return; // vendor/open-design is absent in this checkout: nothing to prove
      assert.equal(local.find((entry) => entry.url.endsWith('/index.html'))?.status, 200);
      assert.ok(styles.length >= 2, `real preview stylesheets must load: ${JSON.stringify(local)}`);
      for (const entry of local) assert.equal(entry.status, 200, `${entry.url} -> ${entry.status}`);
    });
  } finally {
    await browser?.close();
    await new Promise((resolve) => { probe.close(resolve); probe.closeAllConnections(); });
  }
});
