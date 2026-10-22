/**
 * 本地安装一次性确认令牌（EAC_LOCAL_TOKEN）的闸门测试。
 *
 * 覆盖：无令牌 / 错误令牌 / 过期令牌 / 令牌二次使用 / 有效令牌 + 合法包安装成功，
 * 以及“令牌只是额外前置条件、不替代验签”的回归（未签名包行为不变）。
 * 时间相关用例注入 now 时钟，不真的等 60 秒。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import crypto from 'node:crypto';
import { createEngine } from '../src/engine.mjs';
import { createMaintenance } from '../src/maintenance.mjs';
import { startServer } from '../src/server.mjs';
import { buildManifest } from '../scripts/build-update-manifest.mjs';

/** 一次性 Ed25519 密钥对（SPKI base64 公钥、PKCS8 PEM 私钥），与 updater 测试一致。 */
function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** 最小可安装包目录（含 PACKAGE_IDENTITY 身份文件），与 updater 测试一致。 */
async function makePackage(dir, { version = '1.0.0', files = {}, name = 'eac-design-world', main = './plugin/host.mjs' } = {}) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), `${JSON.stringify({ name, version, main }, null, 2)}\n`);
  const merged = {
    'index.js': 'export const version = "1.0.0"\n',
    'plugin/host.mjs': 'export const name = "eac-design-world"\n',
    'src/server.mjs': 'export const startServer = () => {}\n',
    'src/version.mjs': `export const VERSION = '${version}'\n`,
    'dist/index.html': '<!doctype html><title>EAC</title>\n',
    ...files,
  };
  for (const [rel, content] of Object.entries(merged)) {
    const target = join(dir, ...rel.split('/'));
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, content);
  }
  return dir;
}

/** 构建清单并写入 <dir>/feed/manifest.json（与 updater 测试同款布局）。 */
async function writeManifest(dir, options) {
  const built = buildManifest({ root: dir, ...options });
  await mkdir(join(dir, 'feed'), { recursive: true });
  await writeFile(join(dir, 'feed', 'manifest.json'), JSON.stringify(built.manifest, null, 2));
  return built;
}

/** 断言抛出的是 EAC_LOCAL_TOKEN 闸门错误（不是其它错误）。 */
const expectTokenError = fn => assert.throws(fn, error => {
  assert.equal(error?.code, 'EAC_LOCAL_TOKEN');
  assert.match(String(error?.message), /EAC_LOCAL_TOKEN|令牌/);
  return true;
});

/** 等待异步维护操作落终态；与 maintenance.test.mjs 相同，经 status() 轮询。
 *  用例结束前必须等它返回，避免清理临时目录后仍有定时器写 operation.json。 */
async function finished(maintenance, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = maintenance.status();
    if (state.operation && state.operation.status !== 'running') return state.operation;
    await new Promise(done => setTimeout(done, 15));
  }
  throw new Error('维护操作未在限时内结束');
}

async function setup(run, { now } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'eac-maint-token-'));
  const pkg = join(dir, 'pkg');
  await makePackage(pkg, { version: '1.0.0' });
  const engine = await createEngine({ dataDir: join(dir, 'data') });
  const { publicKey, privateKey } = keypair();
  const reloadCalls = [];
  const maintenance = createMaintenance({
    engine, root: pkg, runningVersion: '1.0.0', feedSources: [], manifestSources: [],
    manifestPublicKey: publicKey,
    reload: async ({ expectedVersion } = {}) => { reloadCalls.push(expectedVersion); return { ok: true, version: expectedVersion, fibers: 1 }; },
    ...(now ? { now } : {}),
  });
  try { await run({ dir, pkg, engine, maintenance, publicKey, privateKey, reloadCalls }); }
  finally { await maintenance.close(); await engine.close(); await rm(dir, { recursive: true, force: true }); }
}

test('status() 每次发放一枚新的一次性本地安装令牌', () => setup(async ({ maintenance }) => {
  const first = maintenance.status();
  const second = maintenance.status();
  assert.equal(typeof first.localInstallToken, 'string');
  assert.ok(first.localInstallToken.length >= 16);
  assert.notEqual(first.localInstallToken, second.localInstallToken);
}));

test('本地安装没有令牌被拒绝，且不创建任何操作记录', () => setup(async ({ dir, maintenance }) => {
  const manifestPath = join(dir, 'release', 'feed', 'manifest.json');
  expectTokenError(() => maintenance.start('local', { manifestPath }));
  expectTokenError(() => maintenance.start('local', { manifestPath, localInstallToken: '' }));
  const state = maintenance.status();
  assert.equal(state.operation, null, '请求没有走到 updater，也没有排队任何操作');
}));

test('错误的令牌被拒绝（含其它实例签发的令牌）', () => setup(async ({ dir, maintenance }) => {
  const manifestPath = join(dir, 'release', 'feed', 'manifest.json');
  expectTokenError(() => maintenance.start('local', { manifestPath, localInstallToken: 'x'.repeat(32) }));
  expectTokenError(() => maintenance.start('local', { manifestPath, localInstallToken: 'a'.repeat(16) + 'b'.repeat(16) }));
}));

test('过期令牌被拒绝；TTL 内的令牌放行（注入时钟，不等 60 秒）', async () => {
  let clock = 1_000_000;
  await setup(async ({ dir, maintenance }) => {
    const manifestPath = join(dir, 'missing', 'manifest.json');
    // TTL 内（59.999 秒后）：闸门放行——清单不存在只会让异步安装失败，不拦截受理。
    const fresh = maintenance.status().localInstallToken;
    clock += 59_999;
    assert.equal(maintenance.start('local', { manifestPath, localInstallToken: fresh }).accepted, true);
    await finished(maintenance);
    // 再往前推 60.001 秒：上一时刻发的令牌已过期。
    const stale = maintenance.status().localInstallToken;
    clock += 60_001;
    expectTokenError(() => maintenance.start('local', { manifestPath, localInstallToken: stale }));
  }, { now: () => clock });
});

test('令牌一次即废：安装失败也已消费，重试必须拿新令牌', () => setup(async ({ dir, maintenance }) => {
  const manifestPath = join(dir, 'missing', 'manifest.json');
  const token = maintenance.status().localInstallToken;
  assert.equal(maintenance.start('local', { manifestPath, localInstallToken: token }).accepted, true);
  const record = await finished(maintenance);
  assert.equal(record.status, 'failed');
  assert.match(String(record.error), /manifest/);
  expectTokenError(() => maintenance.start('local', { manifestPath, localInstallToken: token }));
}));

test('有效令牌 + 合法已签名包安装成功，且同一令牌第二次使用被拒绝', () => setup(async ({ dir, pkg, maintenance, privateKey, reloadCalls }) => {
  const release = join(dir, 'release');
  await makePackage(release, { version: '1.2.0', files: { 'src/a.mjs': 'new-a' } });
  await writeManifest(release, { privateKey });
  const manifestPath = join(release, 'feed', 'manifest.json');
  const token = maintenance.status().localInstallToken;
  assert.equal(maintenance.start('local', { manifestPath, localInstallToken: token }).accepted, true);
  // 同一枚令牌立刻再用：闸门先于忙碌检查命中，必须拒绝。
  expectTokenError(() => maintenance.start('local', { manifestPath, localInstallToken: token }));
  const record = await finished(maintenance);
  assert.equal(record.status, 'completed', record.error);
  assert.equal(record.result.version, '1.2.0');
  assert.equal(record.result.signed, true);
  assert.equal(await readFile(join(pkg, 'src', 'a.mjs'), 'utf8'), 'new-a');
  assert.equal(JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8')).version, '1.2.0');
  assert.deepEqual(reloadCalls, ['1.2.0']);
}));

test('令牌是额外前置条件：未签名包的签名闸门行为完全不变', () => setup(async ({ dir, maintenance }) => {
  const release = join(dir, 'release');
  await makePackage(release, { version: '1.2.0', files: { 'src/a.mjs': 'new-a' } });
  await writeManifest(release, { unsigned: true });
  const manifestPath = join(release, 'feed', 'manifest.json');
  // 令牌有效但未签名、未勾选 allowUnsigned：仍被签名闸门拒绝。
  const token = maintenance.status().localInstallToken;
  assert.equal(maintenance.start('local', { manifestPath, localInstallToken: token }).accepted, true);
  const refused = await finished(maintenance);
  assert.equal(refused.status, 'failed');
  assert.match(String(refused.error), /not signed/);
  // 未签名 + 显式 allowUnsigned：原行为不变，仍然可以安装。
  const token2 = maintenance.status().localInstallToken;
  assert.equal(maintenance.start('local', { manifestPath, localInstallToken: token2, allowUnsigned: true }).accepted, true);
  const installed = await finished(maintenance);
  assert.equal(installed.status, 'completed', installed.error);
  assert.equal(installed.result.signed, false);
}));

test('令牌闸门只覆盖 local 动作，check 等其它动作不受影响', () => setup(async ({ maintenance }) => {
  assert.equal(maintenance.start('check').accepted, true);
  await finished(maintenance);
  // local 依旧必须带令牌。
  expectTokenError(() => maintenance.start('local', { manifestPath: 'x' }));
}));

test('HTTP：/api/maintenance/local 强制令牌并在错误体中给出 EAC_LOCAL_TOKEN', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'eac-maint-token-http-'));
  const engine = await createEngine({ dataDir });
  const app = await startServer({ engine, port: 0, maintenanceOptions: { feedSources: [], manifestSources: [], reload: async ({ expectedVersion } = {}) => ({ ok: true, version: expectedVersion, fibers: 1 }) } });
  const post = body => fetch(`${app.url}/api/maintenance/local`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const first = await (await fetch(`${app.url}/api/maintenance`)).json();
    assert.equal(typeof first.localInstallToken, 'string');
    assert.ok(first.localInstallToken.length >= 16);
    const second = await (await fetch(`${app.url}/api/maintenance`)).json();
    assert.notEqual(second.localInstallToken, first.localInstallToken);

    const missing = await post({ manifestPath: 'X:\\nope\\manifest.json' });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).code, 'EAC_LOCAL_TOKEN');

    const wrong = await post({ manifestPath: 'X:\\nope\\manifest.json', localInstallToken: 'x'.repeat(32) });
    assert.equal(wrong.status, 400);
    assert.equal((await wrong.json()).code, 'EAC_LOCAL_TOKEN');

    // 有效令牌：请求被受理（202），安装随后因清单不存在异步失败；令牌已被消费。
    const accepted = await post({ manifestPath: 'X:\\nope\\manifest.json', localInstallToken: second.localInstallToken });
    assert.equal(accepted.status, 202);
    const reuse = await post({ manifestPath: 'X:\\nope\\manifest.json', localInstallToken: second.localInstallToken });
    assert.equal(reuse.status, 400);
    assert.equal((await reuse.json()).code, 'EAC_LOCAL_TOKEN');
    // 等受理的那次异步失败落盘，避免清理目录后定时器还在写。
    const failed = await finished(app.maintenance);
    assert.equal(failed.status, 'failed');

    // 跨来源请求仍先被 Origin 检查拦下（浏览器路径不变）。
    const cross = await fetch(`${app.url}/api/maintenance/local`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({}) });
    assert.equal(cross.status, 403);
  } finally { await app.close(); await engine.close(); await rm(dataDir, { recursive: true, force: true }); }
});
