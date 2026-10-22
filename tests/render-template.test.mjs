import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { renderTemplate, sendAssetBody, containRenderSource } from '../src/render-template.mjs';

const run = promisify(execFile);
const renderSource = fileURLToPath(new URL('../src/render-template.mjs', import.meta.url));
// A file that really exists but never belongs to a render: outside the repository, the job output
// directory and the OS temp root.
const foreignFile = process.platform === 'win32'
  ? join(process.env.SystemRoot || 'C:\\Windows', 'win.ini')
  : '/etc/hostname';
const templateId = 'motion-promo-film';
// This renderer runs inside the plugin/Harness host process, so a stream error that escapes is a
// host-level crash. Turn that into an assertion instead of a dead test run.
function watchProcess() {
  const seen = [];
  const onException = (error) => seen.push({ kind: 'uncaughtException', code: error?.code, message: error?.message });
  const onRejection = (error) => seen.push({ kind: 'unhandledRejection', code: error?.code, message: error?.message });
  process.on('uncaughtException', onException);
  process.on('unhandledRejection', onRejection);
  return { seen, stop() { process.off('uncaughtException', onException); process.off('unhandledRejection', onRejection); } };
}

test('render-template refuses an htmlPath outside the repository, working directory, output and temp roots', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-render-guard-'));
  try {
    await assert.rejects(renderTemplate({ templateId, htmlPath: foreignFile, outputPath: join(directory, 'foreign.mp4') }), /htmlPath 必须位于仓库\/工作目录、项目输出目录或系统临时目录内/);
    await assert.rejects(renderTemplate({ templateId, htmlPath: join('..', '..', 'escape.html'), outputPath: join(directory, 'escape.mp4') }), /htmlPath 不存在/);
    await assert.rejects(renderTemplate({ templateId, htmlPath: 'vendor/does-not-exist.html', outputPath: join(directory, 'missing.mp4') }), /htmlPath 不存在/);
    // The guard runs before any browser or ffmpeg work, so nothing was written for the rejected calls.
    assert.equal((await stat(join(directory, 'foreign.mp4')).catch(() => null)), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a vendored template still renders real, changing frames', { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-render-entry-'));
  try {
    const result = await renderTemplate({ templateId, outputPath: join(directory, 'entry.mp4'), duration: 1, fps: 10, scale: 0.2 });
    assert.equal(result.templateId, templateId);
    assert.deepEqual(result.missingAssets, []);
    assert.equal(result.deterministic, true);
    assert.equal(result.qa.ok, true);
    assert.equal(result.referencePreview, true);
    assert.ok((await stat(result.path)).size > 1000, 'MP4 was written');
    const frame = async (name, time) => {
      const path = join(directory, name);
      await run('ffmpeg', ['-v', 'error', '-y', '-ss', String(time), '-i', result.path, '-frames:v', '1', path]);
      return await readFile(path);
    };
    const first = await frame('frame-0.png', 0.1);
    const later = await frame('frame-1.png', 0.7);
    assert.ok(first.length > 1000 && later.length > 1000, 'frames were decoded from the MP4');
    assert.ok(!first.equals(later), 'the timed composition changes between frames');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a custom film renders from its own folder while the render page cannot reach other hosts', { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-render-csp-'));
  const hits = [];
  const spy = http.createServer((request, response) => {
    hits.push(request.url);
    response.writeHead(200, { 'content-type': 'image/gif' });
    response.end('GIF89a');
  });
  try {
    await new Promise(done => spy.listen(0, '127.0.0.1', done));
    const spyOrigin = `http://127.0.0.1:${spy.address().port}`;
    await writeFile(join(directory, 'pixel.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#f0b429"/></svg>');
    const htmlPath = join(directory, 'custom.html');
    await writeFile(htmlPath, `<!doctype html><html><head><style>html,body{margin:0;height:100%}</style></head><body>
      <img id="local" src="./pixel.svg" alt="">
      <script>
        // Relative asset in the film's own folder must still load through the asset server.
        const local = document.getElementById('local');
        // Egress to another loopback port and to a remote host must be refused by the page CSP.
        fetch('${spyOrigin}/beacon', { method: 'POST', body: 'x' }).catch(() => {});
        const beacon = new Image(); beacon.src = '${spyOrigin}/pixel.gif';
        fetch('https://example.com/beacon').catch(() => {});
        window.__meta = { dur: 1, fps: 10, w: 320, h: 180 };
        window.__seek = t => { document.body.style.background = 'hsl(' + (t * 120 + 20) + ',70%,45%)'; };
        local.decode().then(() => { window.__ready = true; });
      </script></body></html>`);
    const result = await renderTemplate({ templateId, htmlPath, outputPath: join(directory, 'custom.mp4'), scale: 0.5 });
    assert.equal(result.deterministic, true);
    assert.deepEqual(result.missingAssets, []);
    assert.equal(result.referencePreview, false);
    assert.ok((await stat(result.path)).size > 1000);
    assert.deepEqual(hits, [], `render page reached ${hits.join(', ')}`);
  } finally {
    await new Promise(done => { spy.close(done); spy.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});

test('a tampered od-* catalog entry cannot become the render root', { timeout: 60000 }, async () => {
  // `od-*` entries come from vendor/open-design/catalog.json — data, not code — and the asset server
  // derives its document root from dirname(entry). Mutating an already-loaded catalog item is exactly
  // what a tampered data file hands to resolveTemplate, and it is restored so later tests see real data.
  const { loadLibrary } = await import('../src/catalog.mjs');
  const library = await loadLibrary();
  const item = library.openDesignTemplates.find((candidate) => {
    const entry = typeof candidate.entry === 'string' ? candidate.entry : candidate.entry?.path;
    return typeof entry === 'string' && entry && candidate.kind !== 'motion';
  });
  assert.ok(item, 'the OpenDesign catalog needs one entry to tamper with');
  const original = item.entry;
  const directory = await mkdtemp(join(tmpdir(), 'eac-render-entry-guard-'));
  try {
    item.entry = { path: foreignFile, url: '', exists: true };
    await assert.rejects(
      renderTemplate({ templateId: item.id, outputPath: join(directory, 'entry.mp4') }),
      /模板 entry (越界|不存在|必须位于仓库\/工作目录、项目输出目录或系统临时目录内)/,
      'an entry outside the render roots must be refused, never used as the asset root',
    );
    // Refused before any browser or ffmpeg work: no frames, no output, no report.
    assert.equal(await stat(join(directory, 'entry.mp4')).catch(() => null), null);
  } finally {
    item.entry = original;
    await rm(directory, { recursive: true, force: true });
  }
});

test('the asset server carries the render CSP for executable documents and keeps no entry exemption', async () => {
  const source = await readFile(renderSource, 'utf8');
  // Both were measured holes: an .svg subdocument ran its own script with no CSP at all, and an
  // unvalidated entry was explicitly excused from the asset-root containment check.
  assert.doesNotMatch(source, /resolved\s*!==\s*entry/, 'the entry must not be exempt from the containment check');
  assert.match(source, /executableDocuments = new Set\(\[[^\]]*'\.svg'/, 'svg documents need the render CSP too');
  assert.match(source, /'content-security-policy': renderCsp/);
  assert.match(source, /resolveEntrySource\(/, 'template.entry must walk the containment chain');
  // CSP cannot stop window.open, so the session itself refuses foreign origins and closes popups.
  assert.match(source, /context\.route\(/);
  assert.match(source, /\.on\('page',/);
});

test('a rendered page cannot reach another port from an SVG subdocument or through a popup', { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-render-svg-egress-'));
  const hits = [];
  const spy = http.createServer((request, response) => {
    hits.push(request.url);
    response.writeHead(200, { 'content-type': 'image/gif' });
    response.end('GIF89a');
  });
  try {
    await new Promise(done => spy.listen(0, '127.0.0.1', done));
    const spyOrigin = `http://127.0.0.1:${spy.address().port}`;
    // An .svg loaded in an iframe is a real document with a real script context.
    await writeFile(join(directory, 'probe.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><script>
      fetch('${spyOrigin}/svg-beacon', { method: 'POST', body: 'x' }).catch(() => {});
      new Image().src = '${spyOrigin}/svg-img';
      window.open('${spyOrigin}/open-beacon');
      window.__ready = true;
    </script><rect width="80" height="40" fill="#f0b429"/></svg>`);
    const htmlPath = join(directory, 'film.html');
    await writeFile(htmlPath, `<!doctype html><html><head><style>html,body{margin:0;height:100%}</style></head><body>
      <iframe src="./probe.svg" width="200" height="100"></iframe>
      <script>
        window.__meta = { dur: 1, fps: 10, w: 320, h: 180 };
        window.__seek = t => { document.body.style.background = 'hsl(' + (t * 120 + 20) + ',70%,45%)'; };
        window.__ready = true;
      </script></body></html>`);
    const result = await renderTemplate({ templateId, htmlPath, outputPath: join(directory, 'svg-egress.mp4'), scale: 0.5 });
    assert.deepEqual(hits, [], `render page reached ${hits.join(', ')}`);
    assert.equal(result.deterministic, true);
    // The refusal is reported instead of being swallowed behind ok/missingAssets:[].
    assert.ok(result.refusedEgress.some(url => url.includes('/open-beacon')), `popup must be refused and reported: ${JSON.stringify(result.refusedEgress)}`);
    assert.equal(result.productionReady, false, 'a template that phones home is not production ready');
    assert.ok((await stat(result.path)).size > 1000);
  } finally {
    await new Promise(done => { spy.close(done); spy.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});

test('the asset server answers 404 for a vanished file instead of crashing the host', async () => {
  const watch = watchProcess();
  const directory = await mkdtemp(join(tmpdir(), 'eac-asset-stream-'));
  try {
    // The race: realpath+stat approved the path, then the file was removed before open().
    const ghost = { headersSent: false, code: null, ended: false, destroyed: false,
      writeHead(code) { this.code = code; this.headersSent = true; },
      end() { this.ended = true; },
      destroy() { this.destroyed = true; } };
    await sendAssetBody({ method: 'GET' }, ghost, join(directory, 'vanished.mp4'));
    assert.equal(ghost.code, 404, 'a vanished asset answers 404, never a naked pipe error');
    assert.equal(ghost.ended, true);
    // A body that fails after the headers went out is torn down, and the function still never rejects.
    const file = join(directory, 'body.mp4');
    await writeFile(file, Buffer.alloc(256 * 1024, 3));
    class FlakySink extends Writable {
      headersSent = false;
      closedByServer = false;
      writeHead() { this.headersSent = true; }
      destroy(error) { this.closedByServer = true; return super.destroy(); }
      _write(chunk, encoding, callback) { callback(new Error('socket gone')); }
    }
    const sink = new FlakySink();
    await sendAssetBody({ method: 'GET' }, sink, file, { headers: { 'content-type': 'video/mp4' } });
    assert.equal(sink.headersSent, true);
    assert.equal(sink.closedByServer, true);
    assert.equal(sink.destroyed, true);
    await new Promise(done => setTimeout(done, 50));
    assert.deepEqual(watch.seen, [], 'a stream failure must never reach the process');
  } finally {
    watch.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a short output path cannot promote the drive root into an allowed render root', async () => {
  // `dirname(dirname(outputPath))` for C:\x.mp4 is C:\ — treating a whole drive as "project output",
  // which let an htmlPath of C:\Windows\win.ini pass containment. The walked-up roots must stop
  // before a filesystem root, and the root is never a legitimate candidate.
  const winIni = 'C:' + String.fromCharCode(92) + 'Windows' + String.fromCharCode(92) + 'win.ini';
  for (const outputPath of ['C:' + String.fromCharCode(92) + 'x.mp4', 'C:' + String.fromCharCode(92) + 'dir' + String.fromCharCode(92) + 'x.mp4']) {
    await assert.rejects(containRenderSource(winIni, outputPath, 'htmlPath'),
      /必须位于仓库\/工作目录、项目输出目录或系统临时目录内/,
      `the drive root leaked into the allowed roots for ${outputPath}`);
  }
  // A file in a real project directory is still accepted.
  const project = await mkdtemp(join(tmpdir(), 'eac contain '));
  try {
    const film = join(project, 'film.html');
    await writeFile(film, '<!doctype html><h1>ok</h1>');
    const accepted = await containRenderSource(film, join(project, 'job', 'film.mp4'), 'htmlPath');
    const { realpath } = await import('node:fs/promises');
    assert.equal(accepted, await realpath(film), 'a file in the project directory must still be allowed');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
