import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT } from '../src/catalog.mjs';
import { createEngine } from '../src/engine.mjs';
import { startServer } from '../src/server.mjs';
import { mcpRoute } from '../src/mcp.mjs';

test('MCP route forwards exactly the provided asset import selector', () => {
  const template = mcpRoute('asset_import', { projectId: 'p 1', templateId: 'sc-blur-slide' });
  assert.equal(template[0], 'POST');
  assert.equal(template[1], '/api/projects/p%201/assets');
  assert.deepEqual(template[2], { projectId: 'p 1', templateId: 'sc-blur-slide' });
  const path = mcpRoute('asset_import', { projectId: 'p 1', path: 'C:\\clips\\a.mp4' });
  assert.deepEqual(path[2], { projectId: 'p 1', path: 'C:\\clips\\a.mp4' });
  // No phantom keys: an absent selector must not reach the engine as undefined/null.
  assert.deepEqual(mcpRoute('asset_import', { projectId: 'p 1' })[2], { projectId: 'p 1' });
  assert.equal(mcpRoute('unknown_tool', {}), null);
});

test('real stdio MCP imports a Shotcraft templateId through the HTTP server', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'eac-mcp-transport-'));
  const engine = await createEngine({ dataDir });
  const app = await startServer({ engine, port: 0 });
  const client = new Client({ name: 'eac-mcp-transport', version: '1' });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [join(ROOT, 'src/mcp.mjs')],
      env: { ...process.env, EAC_URL: app.url }, stderr: 'pipe',
    }));
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result));
      return JSON.parse(result.content[0].text);
    };
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(tools.includes('workspace_info'));
    assert.ok(tools.includes('asset_import'));
    assert.deepEqual(await call('workspace_info'), {
      url: app.url, designUrl: `${app.url}/?view=design`, canvasUrl: `${app.url}/?view=canvas`,
    });
    const project = await call('project_create', { title: 'MCP template transport', width: 320, height: 180, fps: 12 });
    const imported = await call('asset_import', { projectId: project.id, templateId: 'sc-blur-slide' });
    assert.equal(imported.assets.length, 1);
    assert.equal(imported.assets[0].kind, 'video');
    assert.match(imported.assets[0].path.replace(/\\/g, '/'), /video-shotcraft\/media\/blur-slide\.mp4$/);
    // Both selectors are rejected by the engine, proving the MCP route did not invent one.
    const conflict = await client.callTool({ name: 'asset_import', arguments: { projectId: project.id, path: imported.assets[0].path, templateId: 'sc-blur-slide' } });
    assert.equal(conflict.isError, true);
    assert.match(conflict.content[0].text, /path|templateId/);
    const missing = await client.callTool({ name: 'asset_import', arguments: { projectId: project.id } });
    assert.equal(missing.isError, true);
  } finally {
    await client.close().catch(() => {});
    await app.close();
    await engine.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('HTTP assets endpoint accepts templateId without a path', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'eac-http-assets-'));
  const engine = await createEngine({ dataDir });
  const app = await startServer({ engine, port: 0 });
  try {
    const project = await engine.handle('project_create', { title: 'HTTP template', width: 320, height: 180, fps: 12 });
    const response = await fetch(`${app.url}/api/projects/${project.id}/assets`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateId: 'sc-blur-slide' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).assets.length, 1);
    const bad = await fetch(`${app.url}/api/projects/${project.id}/assets`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateId: 'sc-not-registered' }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await app.close();
    await engine.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
