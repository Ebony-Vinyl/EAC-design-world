import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import lockfile from '../vendor/eac-runtime/proper-lockfile.cjs';
import { MaintenanceUpdater } from '../src/maintenance-updater.mjs';
import { RELEASE_PUBLIC_KEY } from '../src/maintenance-key.mjs';

export async function runOfflineUpdate({ installDir, dataDir, manifestPath, stopped = false, rollback = false } = {}) {
  if (!stopped) throw new Error('Stop the old EAC service first, then pass --stopped (请先停止旧 EAC 服务)');
  if (!installDir || !dataDir) throw new Error('Provide --install and the existing --data-dir explicitly');
  const root = await realpath(resolve(installDir));
  const data = resolve(dataDir);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'eac-design-world' || pkg.main !== './plugin/host.mjs') throw new Error('Target is not an EAC installation');
  if (existsSync(join(data, '.writer.lock'))) throw new Error('The data directory still has a writer lock (数据目录仍有写入锁)');
  await mkdir(data, { recursive: true });
  const release = await lockfile.lock(await realpath(data), {
    lockfilePath: join(data, '.writer.lock'), retries: 0, stale: 120000, update: 15000,
  });
  try {
    const updater = new MaintenanceUpdater({ pkgDir: root, dataDir: join(data, 'maintenance'),
      runningVersion: pkg.version, settings: () => ({}), manifestPublicKey: RELEASE_PUBLIC_KEY });
    const result = rollback ? await updater.rollback() : await updater.applyLocal({ manifestPath: resolve(manifestPath || '') });
    return { ...result, restartRequired: true };
  } finally { await release(); }
}

const entry = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => null) : null;
if (entry && entry === await realpath(fileURLToPath(import.meta.url))) {
  try {
    const { values } = parseArgs({ options: {
      install: { type: 'string' }, 'data-dir': { type: 'string' }, manifest: { type: 'string' },
      stopped: { type: 'boolean' }, rollback: { type: 'boolean' },
    } });
    const result = await runOfflineUpdate({ installDir: values.install, dataDir: values['data-dir'],
      manifestPath: values.manifest, stopped: values.stopped, rollback: values.rollback });
    console.log(JSON.stringify(result, null, 2));
    console.log('Restart EAC and verify the running version. The existing data and rollback backup are retained.');
  } catch (error) {
    console.error(`EAC update failed: ${error.message}`);
    process.exitCode = 1;
  }
}
