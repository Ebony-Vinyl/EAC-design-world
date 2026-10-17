import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BUNDLE = 'eac-design-world';
const defaultSource = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function optionalRead(path) {
  try { return await readFile(path); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicWrite(path, bytes) {
  const temporary = `${path}.eac-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function addBundle(bytes, source) {
  const document = JSON.parse(bytes);
  if (document.dependencies?.[BUNDLE] !== undefined
    || document.dsh?.profile?.bundles?.includes(BUNDLE)) {
    throw new Error('EAC already exists in this profile; no changes made.');
  }
  document.dependencies = { ...document.dependencies, [BUNDLE]: `link:${source.replaceAll('\\', '/')}` };
  document.dsh = { ...document.dsh, profile: { ...document.dsh?.profile,
    bundles: [...(document.dsh?.profile?.bundles ?? []), BUNDLE] } };
  return Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
}

export async function installHarness({
  profile = join(homedir(), '.dsh', 'profiles', 'desktop'),
  source = defaultSource, dryRun = false, check = true,
} = {}) {
  profile = await realpath(profile);
  source = await realpath(source);
  const manifestPath = join(profile, 'package.json');
  const patchPath = join(profile, 'cordis.patch.yml');
  const before = await readFile(manifestPath);
  const patch = await optionalRead(patchPath);
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  if (manifest.name !== BUNDLE || manifest.dsh?.bundle?.patch !== './cordis.patch.yml'
    || manifest.exports?.['./client'] !== './plugin/client.js') {
    throw new Error('Source is not the expected EAC Harness bundle.');
  }
  for (const entry of ['plugin/host.mjs', 'plugin/client.js', 'cordis.patch.yml',
    'src/engine.mjs', 'src/server.mjs', 'src/tools.mjs']) {
    await lstat(join(source, entry));
  }
  if (check) {
    const [{ createEngine }, { startServer }, { toolDefinitions }] = await Promise.all([
      import(pathToFileURL(join(source, 'src/engine.mjs'))),
      import(pathToFileURL(join(source, 'src/server.mjs'))),
      import(pathToFileURL(join(source, 'src/tools.mjs'))),
    ]);
    if (typeof createEngine !== 'function' || typeof startServer !== 'function'
      || !Array.isArray(toolDefinitions)) throw new Error('Parent integration exports are not ready.');
  }
  const after = addBundle(before, source);
  const link = join(profile, 'node_modules', BUNDLE);
  try {
    await lstat(link);
    throw new Error('EAC package path already exists; refusing to replace it.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (dryRun) return { dryRun: true, profile, source, bundle: BUNDLE, patchChanged: false };
  const backup = join(profile, '.plugin-manager', `eac-backup-${randomUUID()}`);
  await mkdir(backup, { recursive: true });
  await writeFile(join(backup, 'package.json'), before, { flag: 'wx' });
  if (patch) await writeFile(join(backup, 'cordis.patch.yml'), patch, { flag: 'wx' });
  await writeFile(join(backup, 'receipt.json'), JSON.stringify({
    version: 1, profile, source, bundle: BUNDLE,
    beforeHash: hash(before), afterHash: hash(after),
    patchHash: patch === null ? null : hash(patch),
  }, null, 2), { flag: 'wx' });
  let linked = false;
  try {
    await mkdir(dirname(link), { recursive: true });
    await symlink(source, link, process.platform === 'win32' ? 'junction' : 'dir');
    linked = true;
    if (hash(await readFile(manifestPath)) !== hash(before)) {
      throw new Error('Profile changed during installation; retry after the other writer finishes.');
    }
    await atomicWrite(manifestPath, after);
  } catch (error) {
    if (linked) await rm(link, { force: true });
    throw error;
  }
  return { profile, source, backup, bundle: BUNDLE, patchChanged: false, restartMayBeRequired: true };
}

export async function uninstallHarness({ backup }) {
  backup = await realpath(backup);
  const receipt = JSON.parse(await readFile(join(backup, 'receipt.json'), 'utf8'));
  if (receipt.version !== 1 || receipt.bundle !== BUNDLE) throw new Error('Invalid EAC backup receipt.');
  const profile = await realpath(receipt.profile);
  if (dirname(backup) !== join(profile, '.plugin-manager')) throw new Error('Backup is outside its profile.');
  const manifestPath = join(profile, 'package.json');
  const current = await readFile(manifestPath);
  const original = await readFile(join(backup, 'package.json'));
  if (hash(original) !== receipt.beforeHash) throw new Error('Backup manifest checksum mismatch.');
  const link = join(profile, 'node_modules', BUNDLE);
  const info = await lstat(link);
  if (!info.isSymbolicLink() || await realpath(link) !== await realpath(receipt.source)) {
    throw new Error('EAC link changed; refusing to remove it.');
  }
  let restored = original;
  if (hash(current) !== receipt.afterHash) {
    // A later writer may have changed other bundles. Remove only our two exact additions.
    const doc = JSON.parse(current);
    if (doc.dependencies?.[BUNDLE] !== `link:${receipt.source.replaceAll('\\', '/')}`) {
      throw new Error('EAC dependency changed; refusing to overwrite it.');
    }
    delete doc.dependencies[BUNDLE];
    doc.dsh.profile.bundles = doc.dsh.profile.bundles.filter(name => name !== BUNDLE);
    restored = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
  }
  await atomicWrite(manifestPath, restored);
  // rm on a verified junction removes the link itself; never traverse the source directory.
  await rm(link, { force: true });
  return { profile, bundle: BUNDLE, removed: true, patchChanged: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = {};
  try {
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === '--dry-run') options.dryRun = true;
      else if (['--profile', '--source', '--uninstall'].includes(arg) && args[index + 1]) {
        options[arg === '--uninstall' ? 'backup' : arg.slice(2)] = args[++index];
      } else throw new Error(`Unknown or incomplete option: ${arg}`);
    }
    console.log(JSON.stringify(options.backup
      ? await uninstallHarness(options) : await installHarness(options), null, 2));
  } catch (error) {
    console.error(`EAC installation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
