import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEngine } from '../src/engine.mjs';
import { startServer } from '../src/server.mjs';
import { injectPreviewBridge, previewConfig, previewUrl } from '../src/template-preview-bridge.mjs';

const channel = '3280a9d7-0c69-4c95-a783-e724dfcdd952';

test('preview requests validate local URLs, channel and bounded playback configuration', () => {
  const origin = 'http://127.0.0.1:4173';
  const url = new URL(previewUrl('/vendor/eac-motion/onetake-demo.html?t=2', {
    channel, width: 1920, height: 1080, duration: 8, mode: 'timeline',
  }, origin));
  assert.equal(url.searchParams.get('t'), '2');
  assert.deepEqual(previewConfig(url.searchParams, origin), {
    channel, origin, width: 1920, height: 1080, duration: 8, interactive: false, timeline: true,
  });
  assert.equal(previewConfig(new URLSearchParams('channel=invalid'), origin), null);
  for (const [name, value] of [
    ['channel', '</script><script>alert(1)</script>'], ['eac-preview', '2'],
    ['width', '0'], ['width', '16385'], ['height', '-1'], ['height', 'NaN'],
    ['duration', 'Infinity'], ['duration', '0'], ['duration', '601'], ['mode', 'unknown'],
  ]) {
    const params = new URLSearchParams(url.searchParams);
    params.set(name, value);
    assert.throws(() => previewConfig(params, origin), /Invalid preview/, `${name}=${value}`);
  }
  for (const path of ['https://example.com/vendor/example.html', '/api/state']) {
    assert.throws(() => previewUrl(path, { channel, width: 1920, height: 1080, duration: 8 }, origin), /Invalid preview URL/);
  }
  const original = '<!-- before doctype --><!doctype html><html lang="en"><head><script src="./runtime.js"></script></head><body></body></html>';
  const injected = injectPreviewBridge(original, previewConfig(url.searchParams, origin));
  assert.ok(injected.indexOf('<!doctype html>') < injected.indexOf('__odMotionRender'));
  assert.ok(injected.indexOf('__odMotionRender') < injected.indexOf('<script src="./runtime.js">'));
  assert.ok(injected.endsWith(original.slice(original.indexOf('<html'))));
});

test('vendor preview injection preserves sandbox headers, normal responses and HEAD semantics', { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-preview-bridge-'));
  const engine = await createEngine({ dataDir: directory });
  const app = await startServer({ engine, port: 0 });
  try {
    const entry = '/vendor/motion-promo-film/templates/film-template.html';
    const original = await readFile(new URL('../vendor/motion-promo-film/templates/film-template.html', import.meta.url), 'utf8');
    const normal = await fetch(`${app.url}${entry}`);
    assert.equal(normal.status, 200);
    assert.equal(normal.headers.get('content-security-policy'), null);
    assert.equal(await normal.text(), original);
    const url = new URL(previewUrl(entry, { channel, width: 1920, height: 1080, duration: 12, mode: 'timeline' }, app.url));
    url.searchParams.set('origin', 'https://untrusted.example');
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const html = await response.text();
    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /sandbox allow-scripts/);
    assert.doesNotMatch(csp, /allow-same-origin|allow-forms|allow-top-navigation/);
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /form-action 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(html));
    assert.ok(html.includes(`"origin":"${app.url}"`));
    assert.ok(!html.includes('untrusted.example'));
    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-security-policy'), csp);
    assert.equal(head.headers.get('content-length'), response.headers.get('content-length'));
    assert.equal(await head.text(), '');
    for (const [name, value] of [['channel', 'invalid'], ['duration', '9999'], ['width', '-1'], ['mode', '<script>']]) {
      const invalid = new URL(url);
      invalid.searchParams.set(name, value);
      const rejected = await fetch(invalid);
      assert.equal(rejected.status, 400);
      assert.match((await rejected.json()).error, /Invalid preview/);
    }
  } finally {
    await app.close();
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  }
});
