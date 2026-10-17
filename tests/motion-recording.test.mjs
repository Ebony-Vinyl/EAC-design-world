import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordBrowser, probeMedia } from '../src/media/index.mjs';

test('live motion recording drives real pointer and wheel events', { timeout: 120000 }, async () => {
  const events = new Set();
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/event/')) { events.add(request.url.slice(7)); response.end('ok'); return; }
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><html><body style="margin:0;background:#603b21"><h1>Interactive fixture</h1><script>
      addEventListener('pointermove', () => { document.body.style.background='#215a40'; fetch('/event/pointer'); });
      addEventListener('wheel', event => { event.preventDefault(); document.body.style.background='#304b7a'; fetch('/event/wheel'); }, {passive:false});
    </script></body></html>`);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const outputDir = await mkdtemp(join(tmpdir(), 'eac-motion-events-'));
  try {
    const output = await recordBrowser({ url: `http://127.0.0.1:${server.address().port}`, outputDir,
      width: 320, height: 180, actions: [
        { type: 'move', x: 170, y: 90, steps: 12 },
        { type: 'wheel', deltaY: 500, deltaX: 0 },
        { type: 'wait', ms: 350 },
      ] });
    assert.ok(events.has('pointer'), 'pointer-following cases must receive actual input');
    assert.ok(events.has('wheel'), 'wheel-hijacked cases must receive actual wheel events');
    assert.ok((await probeMedia(output.path)).duration > 0);
    await assert.rejects(recordBrowser({ url: 'data:text/html,test', outputDir, actions: [{ type: 'move', x: -1, y: 0 }] }), /x/);
    await assert.rejects(recordBrowser({ url: 'data:text/html,test', outputDir, actions: [{ type: 'move', x: 0, y: 0, steps: 10000 }] }), /steps/);
  } finally {
    await new Promise(done => { server.close(done); server.closeAllConnections(); });
    await rm(outputDir, { recursive: true, force: true });
  }
});
