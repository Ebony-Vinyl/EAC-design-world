import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { renderTemplate } from '../src/render-template.mjs';

const run = promisify(execFile);
// A file that really exists but never belongs to a render: outside the repository, the job output
// directory and the OS temp root.
const foreignFile = process.platform === 'win32'
  ? join(process.env.SystemRoot || 'C:\\Windows', 'win.ini')
  : '/etc/hostname';
const templateId = 'motion-promo-film';

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
