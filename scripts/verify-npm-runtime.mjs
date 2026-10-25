import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { parseArgs } from 'node:util';
import { VERSION } from '../src/version.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { report: { type: 'string' }, manager: { type: 'string' } } });
assert.ok(!values.manager || ['npm', 'pnpm'].includes(values.manager), 'manager must be npm or pnpm');
const archive = resolve(positionals[0] || `release/publish-v${VERSION}/eac-design-world-${VERSION}.tgz`);
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run through npm run verify:npm');
const reportPath = resolve(values.report || `artifacts/maintenance-qa/npm-install-v${VERSION}.json`);
const results = [];
async function execute(command, args, cwd) {
  return new Promise((complete, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, env: { ...process.env, npm_config_registry: 'https://registry.npmjs.org', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' } });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Package installation timed out: ${output.slice(-12000)}`)); }, 900000);
    child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { output += chunk; process.stderr.write(chunk); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? complete(output) : reject(new Error(output)); });
  });
}
async function unusedPort() {
  const probe = net.createServer();
  await new Promise(done => probe.listen(0, '127.0.0.1', done));
  const port = probe.address().port;
  await new Promise(done => probe.close(done));
  return port;
}
for (const manager of values.manager ? [values.manager] : ['npm', 'pnpm']) {
  const directory = await mkdtemp(join(tmpdir(), `eac-${manager}-install-`));
  let server;
  try {
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'eac-runtime-install-verification', version: '1.0.0', private: true }));
    let output;
    console.log(`Installing complete release with ${manager}`);
    if (manager === 'npm') output = await execute(process.execPath, [npmCli, 'install', archive, '--no-audit', '--no-fund', '--loglevel=verbose'], directory);
    else {
      const locator = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['pnpm'], { encoding: 'utf8', windowsHide: true });
      assert.equal(locator.status, 0, 'pnpm must be installed for verification');
      const commands = locator.stdout.trim().split(/\r?\n/);
      const command = process.platform === 'win32' ? commands.find(path => /\.(?:cmd|exe)$/i.test(path)) : commands[0];
      assert.ok(command, 'No executable pnpm entry was found');
      if (process.platform === 'win32') {
        const entry = join(dirname(command), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
        assert.ok(existsSync(entry), `Missing pnpm Node entry: ${entry}`);
        output = await execute(process.execPath, [entry, 'add', archive, '--registry=https://registry.npmjs.org'], directory);
      } else output = await execute(command, ['add', archive, '--registry=https://registry.npmjs.org'], directory);
    }
    assert.doesNotMatch(output, /ERR_PNPM_IGNORED_BUILDS/);
    const linked = join(directory, 'node_modules', 'eac-design-world');
    const root = await realpath(linked);
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    assert.equal(manifest.version, VERSION);
    for (const hook of ['preinstall', 'install', 'postinstall']) assert.equal(manifest.scripts?.[hook], undefined);
    const map = JSON.parse(await readFile(join(root, 'npm-asset-map.json'), 'utf8'));
    const asset = map.assets.find(asset => !existsSync(join(root, asset.to)));
    assert.ok(asset, 'At least one deduplicated asset must be missing before first launch');
    const port = await unusedPort();
    const url = `http://127.0.0.1:${port}`;
    let logs = '';
    server = spawn(process.execPath, [join(linked, 'src', 'server.mjs')], { cwd: directory, windowsHide: true,
      env: { ...process.env, EAC_PORT: String(port), EAC_DATA_DIR: join(directory, 'data') } });
    server.stdout.on('data', chunk => { logs += chunk; });
    server.stderr.on('data', chunk => { logs += chunk; });
    let health;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (server.exitCode !== null) throw new Error(`Installed server exited: ${logs}`);
      health = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) }).then(r => r.json()).catch(() => null);
      if (health?.version === VERSION) break;
      await new Promise(done => setTimeout(done, 100));
    }
    assert.equal(health?.version, VERSION, logs);
    for (let attempt = 0; attempt < 30 && !logs.includes('EAC design world:'); attempt++) {
      await new Promise(done => setTimeout(done, 100));
    }
    assert.match(logs, /EAC design world:/);
    assert.ok(existsSync(join(root, asset.to)), 'First startup restores local assets without lifecycle scripts');
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/);
    results.push({ manager, version: VERSION, packageVersion: manifest.version, linked: root !== linked,
      installedWithoutEacLifecycleScripts: true, restoredAsset: asset.to, health: health.version, productionUi: true });
    console.log(`${manager}: installed, linked server started, local assets restored and UI served`);
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill('SIGTERM');
      await exited;
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
await (await import('node:fs/promises')).mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify({ ok: true, version: VERSION, results }, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, report: reportPath }));
