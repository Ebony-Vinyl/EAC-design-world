import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { MaintenanceUpdater } from '../src/maintenance-updater.mjs';
import { RELEASE_PUBLIC_KEY } from '../src/maintenance-key.mjs';
import { ROOT } from '../src/catalog.mjs';
import { VERSION } from '../src/version.mjs';

const manifestPath = resolve(process.argv[2] || `release/publish-v${VERSION}/update/manifest.json`);
const originalArchive = resolve(process.argv[3] || 'release/publish-v0.3.0/eac-design-world-v0.3.0-plugin.zip');
const targetVersion = JSON.parse(await readFile(manifestPath, 'utf8')).version;
const outDir = resolve('artifacts/maintenance-qa');
await mkdir(outDir, { recursive: true });
const directory = await mkdtemp(join(outDir, 'package-proof-'));
const install = join(directory, 'eac-design-world');
const checks = [];
async function run(command, args, options = {}) {
  const child = spawn(command, args, { windowsHide: true, ...options });
  let stdout = '', stderr = '';
  child.stdout?.on('data', bytes => { stdout += bytes; });
  child.stderr?.on('data', bytes => { stderr += bytes; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr || stdout);
  return stdout;
}
const boot = async expected => {
  const value = await run(process.execPath, ['--input-type=module', '-e', `
    import {pathToFileURL} from 'node:url';
    const root=process.env.EAC_PROOF_ROOT;
    const {createEngine}=await import(pathToFileURL(root+'/src/engine.mjs'));
    const {startServer}=await import(pathToFileURL(root+'/src/server.mjs'));
    const {createToolRegistrations}=await import(pathToFileURL(root+'/plugin/host.mjs'));
    const {toolDefinitions}=await import(pathToFileURL(root+'/src/tools.mjs'));
    const engine=await createEngine({dataDir:process.env.EAC_PROOF_DATA});
    const app=await startServer({engine,port:0});
    try {
      const health=await(await fetch(app.url+'/api/health')).json();
      const result={version:health.version,templates:(await engine.state()).templates.length};
      if(health.version===process.env.EAC_PROOF_TARGET){
        const tools=createToolRegistrations(engine,toolDefinitions);
        const list=await tools.find(t=>t.name==='eac_library_list').execute({kind:'template',query:'05-cel-boil'});
        const source=await tools.find(t=>t.name==='eac_library_read').execute({kind:'template',id:'05-cel-boil',source:true});
        const skill=await tools.find(t=>t.name==='eac_library_read').execute({kind:'skill',id:'onetake-skill'});
        result.jsonRoundTrip=JSON.stringify(list)===JSON.stringify(JSON.parse(JSON.stringify(list)));
        result.sourceBytes=source.entry.text.length;
        result.skillBytes=skill.content.length;
        result.versionApi=(await(await fetch(app.url+'/api/maintenance')).json()).runningVersion;
        result.shots=(await engine.library()).templates.filter(item=>item.source==='video-shotcraft'&&item.preview).length;
      }
      process.stdout.write(JSON.stringify(result));
    } finally {await app.close();await engine.close();}
  `], { env: { ...process.env, EAC_PROOF_ROOT: install.replaceAll('\\', '/'), EAC_PROOF_DATA: join(directory, 'proof-data'), EAC_PROOF_TARGET: targetVersion } });
  const result = JSON.parse(value);
  assert.equal(result.version, expected);
  return result;
};
try {
  await run('python', ['-c', 'import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', originalArchive, directory]);
  await symlink(join(ROOT, 'node_modules'), join(install, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await mkdir(join(install, '.eac'), { recursive: true });
  await writeFile(join(install, '.eac/user-project.json'), '{"title":"must survive"}');
  await cp(join(ROOT, 'vendor/onetake'), join(install, 'vendor/onetake'), { recursive: true });
  await cp(join(ROOT, 'vendor/motion-web'), join(install, 'vendor/motion-web'), { recursive: true });
  const previousVersion = JSON.parse(await readFile(join(install, 'package.json'), 'utf8')).version;
  const before = await boot(previousVersion);
  checks.push(`Original ${previousVersion} release archive boots before upgrade`);
  const updater = new MaintenanceUpdater({ pkgDir: install, dataDir: join(directory, 'maintenance'), runningVersion: previousVersion, settings: () => ({}), manifestPublicKey: RELEASE_PUBLIC_KEY });
  const upgraded = await updater.applyLocal({ manifestPath, activate: async result => {
    const loaded = await boot(result.version);
    assert.equal(loaded.sourceBytes > 1000, true);
    assert.equal(loaded.skillBytes > 1000, true);
    assert.equal(loaded.versionApi, targetVersion);
    assert.equal(loaded.shots, 150);
    return { ok: true, version: loaded.version };
  } });
  assert.equal(upgraded.signed, true);
  assert.equal(upgraded.version, targetVersion);
  checks.push(`Signed release boots ${targetVersion}, executes native tools and finds all 150 Shotcraft videos`);
  assert.equal(await readFile(join(install, '.eac/user-project.json'), 'utf8'), '{"title":"must survive"}');
  assert.ok((await readFile(join(install, 'vendor/onetake/lib/motion.js'))).length > 1000);
  checks.push('User project data, node_modules junction, and both optional motion libraries survive upgrade');
  const rollback = await updater.rollback({ activate: async result => ({ ok: true, version: (await boot(result.version)).version }) });
  assert.equal(rollback.ok, true);
  assert.equal(rollback.version, before.version);
  assert.ok((await readFile(join(install, 'vendor/onetake/lib/motion.js'))).length > 1000);
  checks.push(`Rollback restores ${previousVersion} and preserves optional libraries`);
  const report = { ok: true, checks, signed: upgraded.signed, files: upgraded.files, bytes: upgraded.bytes, from: before.version, to: upgraded.version, rollback: rollback.version };
  await writeFile(join(outDir, 'package-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
