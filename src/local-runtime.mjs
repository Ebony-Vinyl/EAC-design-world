import { existsSync, openSync, closeSync, realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, win32, posix } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { ROOT } from './catalog.mjs';
import { VERSION } from './version.mjs';

export function localDataDirectory({ platform = process.platform, env = process.env, home = homedir(), cwd = process.cwd() } = {}) {
  const paths = platform === 'win32' ? win32 : posix;
  if (env.EAC_DATA_DIR) return paths.resolve(cwd, env.EAC_DATA_DIR);
  const base = platform === 'darwin' ? paths.join(home, 'Library', 'Application Support')
    : platform === 'win32' ? env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local')
      : env.XDG_DATA_HOME || paths.join(home, '.local', 'share');
  return paths.join(base, 'EAC-design-world');
}

async function occupied(port) {
  return new Promise((done, reject) => {
    const probe = net.createServer();
    probe.once('error', error => error.code === 'EADDRINUSE' ? done(true) : reject(error));
    probe.listen(port, '127.0.0.1', () => probe.close(() => done(false)));
  });
}

export async function verifyLocalService(url, dataDir) {
  const conflict = message => Object.assign(new Error(message), { code: 'EAC_SERVICE_CONFLICT' });
  const request = async path => {
    const response = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw conflict(`端口上的服务返回 HTTP ${response.status}`);
    try { return await response.json(); }
    catch { throw conflict('端口上的服务没有返回 EAC 状态'); }
  };
  const health = await request('/api/health');
  if (health.ok !== true || health.name !== 'EAC design world' || health.version !== VERSION) {
    throw conflict('端口上运行的不是匹配版本的 EAC 服务');
  }
  const status = await request('/api/maintenance');
  let same = false;
  try { same = realpathSync(status.root) === realpathSync(ROOT) && realpathSync(status.dataDir) === realpathSync(dataDir); } catch {}
  if (!same) throw conflict('已有 EAC 服务使用其他安装或数据目录；请使用其他 EAC_PORT，或显式配置 EAC_URL');
  return health;
}

// The workspace outlives individual MCP clients. Concurrent launches race only on
// listen(); server.mjs binds before opening the store, so the loser cannot rewrite it.
export async function ensureLocalRuntime({ port = Number(process.env.EAC_PORT || 4173), dataDir = localDataDirectory() } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('EAC_PORT 必须为 1 至 65535 的整数');
  const url = `http://127.0.0.1:${port}`;
  if (await occupied(port)) {
    // Another client may still be probing the port, or initializing its server.
    // Retry transport failures, but never retry a confirmed foreign identity.
    const deadline = Date.now() + 15000;
    while (true) {
      try {
        await verifyLocalService(url, dataDir);
        return { url, dataDir, reused: true };
      } catch (error) {
        if (error.code === 'EAC_SERVICE_CONFLICT' || Date.now() >= deadline) throw error;
        if (!await occupied(port)) break;
        await new Promise(done => setTimeout(done, 150));
      }
    }
  }
  if (!existsSync(join(ROOT, 'dist/index.html'))) throw new Error('工作台尚未构建，请先运行 npm run build');
  await mkdir(dataDir, { recursive: true });
  const logPath = join(dataDir, 'server.log');
  const log = openSync(logPath, 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [join(ROOT, 'src/server.mjs')], {
      cwd: ROOT, detached: true, windowsHide: true, stdio: ['ignore', log, log],
      env: { ...process.env, EAC_PORT: String(port), EAC_DATA_DIR: dataDir },
    });
  } finally { closeSync(log); }
  let launchError;
  child.on('error', error => { launchError = error; });
  child.unref();
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    try {
      await verifyLocalService(url, dataDir);
      return { url, dataDir, logPath, reused: false };
    } catch (error) { lastError = error; }
    await new Promise(done => setTimeout(done, 150));
  }
  throw new Error(`本地服务启动失败：${lastError?.message}。日志：${logPath}`);
}
