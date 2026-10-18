import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEngine } from '../src/engine.mjs';
import { startServer } from '../src/server.mjs';
import { VERSION } from '../src/version.mjs';

const request = (url, body = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('maintenance HTTP guards origins and reports real asynchronous reload outcomes', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'eac-maintenance-http-'));
  const engine = await createEngine({ dataDir });
  let calls = 0;
  const app = await startServer({ engine, port: 0, maintenanceOptions: { feedSources: [], reload: async () => {
    calls++;
    return { ok: true, version: VERSION, fibers: 1 };
  } } });
  try {
    const initial = await (await fetch(`${app.url}/api/maintenance`)).json();
    assert.equal(initial.runningVersion, VERSION);
    assert.equal(initial.reload.available, true);
    const bundled = JSON.parse(await readFile(new URL('../feed/announcements.json', import.meta.url), 'utf8'));
    assert.equal(initial.announcements.items[0].id, bundled.announcements[0].id);
    const blocked = await fetch(`${app.url}/api/maintenance/reload`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(blocked.status, 403);
    assert.equal(calls, 0);
    const accepted = await request(`${app.url}/api/maintenance/reload`);
    assert.equal(accepted.status, 202);
    const { operationId } = await accepted.json();
    let final;
    for (let i = 0; i < 100; i++) {
      final = await (await fetch(`${app.url}/api/maintenance`)).json();
      if (final.operation?.status !== 'running') break;
      await new Promise(done => setTimeout(done, 20));
    }
    assert.equal(final.operation.id, operationId);
    assert.equal(final.operation.status, 'completed');
    assert.equal(calls, 1);
    assert.equal((await request(`${app.url}/api/maintenance/announcements/ack`, { ids: initial.announcements.items.map(item => item.id) })).status, 200);
    const ack = await (await fetch(`${app.url}/api/maintenance`)).json();
    assert.equal(ack.announcements.unread, 0);
    assert.equal((await request(`${app.url}/api/maintenance/unknown`)).status, 404);
  } finally { await app.close(); await engine.close(); await rm(dataDir, { recursive: true, force: true }); }
});
