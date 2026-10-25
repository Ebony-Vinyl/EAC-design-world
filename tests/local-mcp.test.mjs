import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { browserExecutable } from '../src/browser.mjs';
import { ROOT } from '../src/catalog.mjs';
import { ensureLocalRuntime } from '../src/local-runtime.mjs';
import { synthesizeVoice, analyzeMedia } from '../src/media/index.mjs';

test('browser resolution honors explicit paths and discovers Mac Chrome', () => {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.equal(browserExecutable({ env: {}, platform: 'darwin', exists: p => p === chrome }), chrome);
  assert.equal(browserExecutable({ env: { EAC_BROWSER: '/custom' }, exists: () => true }), '/custom');
  assert.throws(() => browserExecutable({ env: { EAC_BROWSER: '/missing' }, exists: () => false }), /不存在/);
});

test('local launcher refuses an unrelated listener', async () => {
  const server = http.createServer((req, res) => res.end(JSON.stringify({ ok: true, name: 'other' })));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try { await assert.rejects(ensureLocalRuntime({ port: server.address().port, dataDir: tmpdir() }), /匹配版本/); }
  finally { await new Promise(done => { server.close(done); server.closeAllConnections(); }); }
});

test('real stdio clients start and reuse the workspace, import Shotcraft by ID, and preserve saved projects', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'eac-local-mcp-'));
  const probe = net.createServer();
  await new Promise(done => probe.listen(0, '127.0.0.1', done));
  const port = probe.address().port;
  await new Promise(done => probe.close(done));
  const clients = [];
  let pid;
  async function connect() {
    const client = new Client({ name: 'eac-local-test', version: '1' });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'src/mcp-local.mjs')],
      env: { ...process.env, EAC_PORT: String(port), EAC_DATA_DIR: dataDir, EAC_URL: '' }, stderr: 'pipe' }));
    return client;
  }
  const call = async (client, name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  try {
    const [first, second] = await Promise.all([connect(), connect()]);
    const url = `http://127.0.0.1:${port}`;
    const health = await (await fetch(`${url}/api/health`)).json(); pid = health.pid;
    assert.ok(pid > 0);
    assert.equal((await call(first, 'workspace_info')).url, url);
    await assert.rejects(ensureLocalRuntime({ port, dataDir: tmpdir() }), /其他安装或数据目录/);
    assert.ok((await first.listTools()).tools.some(t => t.name === 'job_submit'));
    const project = await call(first, 'project_create', { title: 'MCP Shotcraft', width: 320, height: 180, fps: 12 });
    const imported = await call(first, 'asset_import', { projectId: project.id, templateId: 'sc-blur-slide' });
    assert.equal(imported.assets.length, 1);
    assert.equal(imported.assets[0].kind, 'video');
    const design = await call(first, 'design_project_create', { title: 'MCP design', kind: 'website' });
    const artifact = await call(first, 'design_artifact_save', { projectId: design.id, name: 'index.html', content: '<h1>MCP persisted</h1>' });
    assert.equal(artifact.revision, 1);
    await first.close();
    assert.equal((await (await fetch(`${url}/api/health`)).json()).instanceId, health.instanceId);
    assert.equal((await call(second, 'project_get', { projectId: project.id })).assets.length, 1);
    assert.match(await (await fetch(`${url}${artifact.url}`)).text(), /MCP persisted/);
    const error = await second.callTool({ name: 'asset_import', arguments: { projectId: project.id, templateId: 'sc-not-real' } });
    assert.equal(error.isError, true);
  } finally {
    await Promise.all(clients.map(client => client.close().catch(() => {})));
    if (!pid) {
      const health = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) }).then(r => r.json()).catch(() => null);
      if (health?.name === 'EAC design world') pid = health.pid;
    }
    if (pid) {
      process.kill(pid, 'SIGTERM');
      for (let i = 0; i < 100; i++) {
        try { process.kill(pid, 0); } catch { break; }
        await new Promise(done => setTimeout(done, 50));
      }
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('macOS say produces audible speech and rejects missing voices', { skip: process.platform !== 'darwin', timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-mac-voice-'));
  try {
    const path = join(directory, 'voice.wav');
    await synthesizeVoice({ text: '你好，这是本地工作台的语音测试。', outputPath: path });
    const media = await analyzeMedia(path);
    assert.ok(media.duration > 0.5);
    assert.ok(media.audio.peakDb > -60);
    await assert.rejects(synthesizeVoice({ text: 'test', outputPath: path, voice: 'EAC nonexistent voice' }), /未安装/);
    await assert.rejects(synthesizeVoice({ text: 'test', outputPath: path, signal: AbortSignal.abort() }), /aborted/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Windows SAPI remains usable through the shared media implementation', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eac-windows-voice-'));
  try {
    const path = join(directory, 'voice.wav');
    await synthesizeVoice({ text: 'Local MCP workspace verification.', outputPath: path });
    const media = await analyzeMedia(path);
    assert.ok(media.duration > 0.5);
    assert.ok(media.audio.peakDb > -60);
    await assert.rejects(synthesizeVoice({ text: 'test', outputPath: path, signal: AbortSignal.abort() }), /aborted/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
