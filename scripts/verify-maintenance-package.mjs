import assert from 'node:assert/strict';
import { existsSync, createReadStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { ROOT } from '../src/catalog.mjs';
import { VERSION } from '../src/version.mjs';
import { backupPackage, installStaged, restoreBackup, verifyInstalled } from '../src/maintenance-updater.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  report: { type: 'string' }, 'legacy-dependencies': { type: 'string' },
} });
const manifestPath = resolve(positionals[0] || `release/publish-v${VERSION}/update/manifest.json`);
const archives = positionals.slice(1).length ? positionals.slice(1).map(path => resolve(path)) : [
  resolve('release/baseline-v0.3.0/eac-design-world-v0.3.0-plugin.zip'),
  resolve('release/baseline-v0.4.0/eac-design-world-v0.4.0-plugin.zip'),
  resolve('release/publish-v0.5.0/eac-design-world-v0.5.0-plugin.zip'),
];
const targetVersion = JSON.parse(await readFile(manifestPath, 'utf8')).version;
const reportPath = resolve(values.report || `artifacts/maintenance-qa/package-verification-v${targetVersion}.json`);
const results = [];
const dependencyRoot = resolve(values['legacy-dependencies'] || 'release/legacy-dependencies-v0.5.0/node_modules');
assert.ok(existsSync(dependencyRoot), 'Install the original baseline lockfile dependencies before verification');
async function run(command, args, options = {}) {
  return new Promise((complete, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Verification process timed out: ${command}`)); }, 300000);
    child.stdout?.on('data', bytes => { stdout += bytes; });
    child.stderr?.on('data', bytes => { stderr += bytes; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr || stdout || `${command}: ${code}`));
      else complete(stdout);
    });
  });
}
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function legacyDependencies(install) {
  const target = join(install, 'node_modules');
  await mkdir(target);
  const omit = new Set(['.bin', '.package-lock.json', 'proper-lockfile', 'graceful-fs', 'retry', 'signal-exit']);
  for (const entry of await readdir(dependencyRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || omit.has(entry.name)) continue;
    const destination = join(target, entry.name);
    await symlink(join(dependencyRoot, entry.name), destination, process.platform === 'win32' ? 'junction' : 'dir');
  }
}
const bootScript = `
  import assert from 'node:assert/strict';
  import {pathToFileURL} from 'node:url';
  import {readFile,writeFile} from 'node:fs/promises';
  import {join} from 'node:path';
  const root=process.env.EAC_PROOF_ROOT, dataDir=process.env.EAC_PROOF_DATA;
  const {createEngine}=await import(pathToFileURL(root+'/src/engine.mjs'));
  const {startServer}=await import(pathToFileURL(root+'/src/server.mjs'));
  const engine=await createEngine({dataDir});
  const app=await startServer({engine,port:0});
  try {
    const health=await(await fetch(app.url+'/api/health')).json();
    assert.equal(health.version,process.env.EAC_PROOF_EXPECTED);
    if(process.env.EAC_PROOF_SEED==='1'){
      await engine.handle('project_create',{title:'Upgrade preservation fixture',brief:'Keep my edit'});
      await engine.settingsUpdate({quality:'draft',ttsVoice:'fixture-voice'});
      const design=await engine.handle('design_project_create',{title:'User design',kind:'website'});
      await engine.handle('design_artifact_save',{projectId:design.id,name:'index.html',content:'<h1>User-owned design</h1>'});
    }
    const state=await engine.state({includeTemplates:false});
    assert.equal(state.projects[0].title,'Upgrade preservation fixture');
    assert.equal(state.settings.quality,'draft');
    const library=await engine.library();
    const result={version:health.version,projects:state.projects.length,shots:library.templates.filter(t=>t.source==='video-shotcraft'&&t.preview).length};
    if(health.version===process.env.EAC_PROOF_TARGET){
      assert.equal(result.shots,150);
      const p=await engine.handle('project_get',{projectId:state.projects[0].id});
      const imported=await engine.handle('asset_import',{projectId:p.id,templateId:'sc-blur-slide'});
      const planned=await engine.handle('timeline_plan',{projectId:p.id,duration:.5});
      const submitted=await engine.handle('job_submit',{projectId:p.id,type:'render'});
      for(let i=0;i<1000;i++){
        const job=await engine.handle('job_status',{jobId:submitted.id});
        if(job.status==='completed'){result.rendered=job.result.qa.ok;break;}
        if(job.status==='failed')throw new Error(job.error);
        await new Promise(done=>setTimeout(done,30));
      }
      assert.equal(result.rendered,true);
      assert.ok(!Object.hasOwn(state.settings,'pexelsApiKey'));
      const disk=JSON.parse(await readFile(join(dataDir,'state.json'),'utf8'));
      assert.equal(disk.settings.pexelsApiKey,'upgrade-dummy-secret');
      result.secretPreserved=true;
    }
    process.stdout.write(JSON.stringify(result));
  }finally{await app.close();await engine.close();}
`;
await mkdir(dirname(reportPath), { recursive: true });
for (const archive of archives) {
  assert.ok(existsSync(archive), `Missing baseline: ${archive}`);
  const sums = await readFile(join(dirname(archive), 'SHA256SUMS.txt'), 'utf8');
  const expectedHash = sums.split(/\r?\n/).find(line => line.trim().endsWith(basename(archive)))?.split(/\s+/)[0];
  assert.ok(expectedHash, `Missing baseline checksum for ${archive}`);
  assert.equal(await digest(archive), expectedHash, 'Official baseline archive digest must match');
  const directory = await mkdtemp(join(tmpdir(), 'eac-upgrade-proof-'));
  const install = join(directory, 'eac-design-world');
  const dataDir = join(install, '.eac');
  const proofEnv = { ...process.env, EAC_PROOF_ROOT: install.replaceAll('\\', '/'), EAC_PROOF_DATA: dataDir, EAC_PROOF_TARGET: targetVersion };
  try {
    await run(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', archive, directory]);
    await legacyDependencies(install);
    const previousVersion = JSON.parse(await readFile(join(install, 'package.json'), 'utf8')).version;
    const boot = async (version, seed = false) => JSON.parse(await run(process.execPath, ['--input-type=module', '-e', bootScript], {
      env: { ...proofEnv, EAC_PROOF_EXPECTED: version, EAC_PROOF_SEED: seed ? '1' : '' },
    }));
    const before = await boot(previousVersion, true);
    const state = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8'));
    state.settings.pexelsApiKey = 'upgrade-dummy-secret';
    await writeFile(join(dataDir, 'state.json'), JSON.stringify(state));
    await writeFile(join(dataDir, 'user-project.json'), '{"title":"must survive"}');
    await writeFile(join(install, 'user-added.txt'), 'Do not prune');
    await mkdir(join(install, 'vendor', 'onetake'), { recursive: true });
    await writeFile(join(install, 'vendor', 'onetake', 'user-marker.txt'), 'Optional library remains');
    // Load the updater and trust root from the OLD install, as an existing user's UI does.
    const installScript = `
      import assert from 'node:assert/strict';
      import {pathToFileURL} from 'node:url';
      const root=process.env.EAC_PROOF_ROOT;
      const {MaintenanceUpdater}=await import(pathToFileURL(root+'/src/maintenance-updater.mjs'));
      const {RELEASE_PUBLIC_KEY}=await import(pathToFileURL(root+'/src/maintenance-key.mjs'));
      const updater=new MaintenanceUpdater({pkgDir:root,dataDir:root+'/.eac/maintenance',runningVersion:process.env.EAC_PROOF_PREVIOUS,settings:()=>({}),manifestPublicKey:RELEASE_PUBLIC_KEY});
      const result=await updater.applyLocal({manifestPath:process.env.EAC_PROOF_MANIFEST});
      assert.equal(result.signed,true);
      process.stdout.write(JSON.stringify(result));
    `;
    const manualMigration = previousVersion === '0.1.0';
    const backup = join(directory, 'manual-backup');
    let upgraded;
    if (manualMigration) {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      const files = manifest.files.map(file => file.path);
      backupPackage(install, backup, { installed: files });
      await installStaged(resolve(dirname(manifestPath), manifest.base), install, files, { previousOwned: [] });
      verifyInstalled(install, manifest);
      upgraded = { version: targetVersion, signed: false, files: files.length, bytes: manifest.files.reduce((n, file) => n + file.size, 0) };
    } else {
      upgraded = JSON.parse(await run(process.execPath, ['--input-type=module', '-e', installScript], { env: {
        ...proofEnv, EAC_PROOF_PREVIOUS: previousVersion, EAC_PROOF_MANIFEST: manifestPath,
      } }));
    }
    const activated = await boot(targetVersion);
    assert.equal(await readFile(join(dataDir, 'user-project.json'), 'utf8'), '{"title":"must survive"}');
    assert.equal(await readFile(join(install, 'user-added.txt'), 'utf8'), 'Do not prune');
    assert.equal(await readFile(join(install, 'vendor', 'onetake', 'user-marker.txt'), 'utf8'), 'Optional library remains');
    const rollbackScript = `
      import {pathToFileURL} from 'node:url';
      const root=process.env.EAC_PROOF_ROOT;
      const {MaintenanceUpdater}=await import(pathToFileURL(root+'/src/maintenance-updater.mjs'));
      const updater=new MaintenanceUpdater({pkgDir:root,dataDir:root+'/.eac/maintenance',settings:()=>({})});
      process.stdout.write(JSON.stringify(await updater.rollback()));
    `;
    let rollback;
    if (manualMigration) {
      restoreBackup(backup, install);
      rollback = { version: JSON.parse(await readFile(join(install, 'package.json'), 'utf8')).version };
    } else {
      rollback = JSON.parse(await run(process.execPath, ['--input-type=module', '-e', rollbackScript], { env: proofEnv }));
    }
    assert.equal(rollback.version, previousVersion);
    const restored = await boot(previousVersion);
    results.push({ from: previousVersion, to: targetVersion, migration: manualMigration ? 'manual-file-upgrade' : 'signed-old-updater', oldUpdaterVerifiedSignature: upgraded.signed,
      files: upgraded.files, bytes: upgraded.bytes, activated, rollback: restored.version,
      preserved: ['projects', 'design artifacts', 'settings', 'provider credential', 'user-added files', 'optional libraries', 'legacy node_modules'],
      baseline: basename(archive), baselineSha256: expectedHash, before });
    await writeFile(reportPath, `${JSON.stringify({ ok: true, targetVersion, results }, null, 2)}\n`);
    console.log(`${previousVersion} -> ${targetVersion} -> ${previousVersion}: passed (${manualMigration ? 'manual migration' : 'old updater'}, legacy dependencies, render and preserved user data)`);
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}
console.log(JSON.stringify({ ok: true, report: reportPath, versions: results.map(result => result.from) }));
