import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createAudioTemplates, downloadVoiceAsset } from '../src/audio-templates.mjs';
import { createEngine } from '../src/engine.mjs';
import { startServer } from '../src/server.mjs';
const sha = b => createHash('sha256').update(b).digest('hex');
async function fixture(fn) { const directory = await mkdtemp(join(tmpdir(), 'eac-audio-')); try { return await fn(directory); } finally { await rm(directory,{recursive:true,force:true}); } }
async function done(manager) {
  const until = Date.now()+15000;
  while(Date.now()<until){const state=await manager.catalog('');if(state.installation&&state.installation.status!=='running')return state;await new Promise(r=>setTimeout(r,10));}
  throw new Error('Install deadline exceeded');
}

function options(directory,{fail=false,pause}={}) {
  const bytes=Buffer.from('model-bytes');
  return {dataDir:directory,resolvePython:()=>process.execPath,
    preset:{id:'fixture',assets:[{id:'engine',filename:'engine.zip',url:'https://models.invalid/test',bytes:bytes.length,sha256:sha(bytes),label:'测试资源'}]},
    fetchImpl:async()=>new Response(bytes),
    bootstrap:async({root,signal,phase})=>{
      phase('dependencies','安装测试依赖');
      if(pause)await pause(signal);
      if(fail)throw new Error('fixture bootstrap failed');
      const engineRoot=join(root,'runtime/engine');
      await mkdir(join(engineRoot,'GPT_SoVITS/TTS_infer_pack'),{recursive:true});
      await writeFile(join(engineRoot,'GPT_SoVITS/TTS_infer_pack/TTS.py'),'fixture');
      const profile={schema_version:1,selection:'user_confirmed_sample',voice_id:'mambo-gpt-sovits-v1',engine:{name:'GPT-SoVITS',version:'v2'},models_and_frontend:[],approved_sample:{path:'voice-anchor/sample.wav'}};
      const profilePath=join(root,'profile.json'),profileBytes=JSON.stringify(profile);
      await writeFile(profilePath,profileBytes);
      return {pythonExecutable:process.execPath,engineRoot,voiceRoot:root,profilePath,profileSha256:sha(profileBytes)};
    }};
}

test('verified downloads resume a partial file and reuse cache without network',()=>fixture(async directory=>{
  const bytes=Buffer.from('abcdef0123456789'),asset={filename:'model.bin',url:'https://models.invalid/model',bytes:bytes.length,sha256:sha(bytes),label:'模型'};
  await writeFile(join(directory,'model.bin.part'),bytes.subarray(0,6));
  let calls=0;
  const path=await downloadVoiceAsset(asset,directory,{fetchImpl:async(url,init)=>{
    calls++;assert.equal(init.headers.Range,'bytes=6-');
    return new Response(bytes.subarray(6),{status:206,headers:{'content-range':`bytes 6-${bytes.length-1}/${bytes.length}`}});
  }});
  assert.deepEqual(await readFile(path),bytes);
  await downloadVoiceAsset(asset,directory,{fetchImpl:async()=>{throw new Error('cache should avoid network');}});
  assert.equal(calls,1);
}));

test('corrupt downloads never become published model files',()=>fixture(async directory=>{
  const bytes=Buffer.from('expected');
  const asset={filename:'bad.bin',url:'https://models.invalid/test',bytes:bytes.length,sha256:sha(bytes),label:'模型'};
  await assert.rejects(downloadVoiceAsset(asset,directory,{fetchImpl:async()=>new Response(Buffer.from('tampered'))}),/SHA-256/);
  await assert.rejects(stat(join(directory,'bad.bin')),{code:'ENOENT'});
  await assert.rejects(stat(join(directory,'bad.bin.part')),{code:'ENOENT'});
}));

test('an invalid resume range cannot append bytes to the partial download',()=>fixture(async directory=>{
  const bytes=Buffer.from('abcdef');
  const path=join(directory,'range.bin.part');await writeFile(path,bytes.subarray(0,2));
  await assert.rejects(downloadVoiceAsset({filename:'range.bin',url:'https://models.invalid/test',bytes:bytes.length,sha256:sha(bytes),label:'模型'},directory,
    {fetchImpl:async()=>new Response(bytes.subarray(3),{status:206,headers:{'content-range':'bytes 3-5/6'}})}),/范围不匹配/);
  assert.deepEqual(await readFile(path),bytes.subarray(0,2));
}));

test('missing Python fails before downloading model data',()=>fixture(async directory=>{
  let fetched=false;const config=options(directory);
  const manager=createAudioTemplates({...config,resolvePython:()=>{throw new Error('需要 Python 3.12');},fetchImpl:async()=>{fetched=true;throw new Error('unexpected download');}});
  try {await manager.install();const after=await done(manager);assert.equal(after.installation.status,'failed');assert.match(after.installation.error,/Python 3.12/);assert.equal(fetched,false);}
  finally {await manager.close();}
}));

test('failed final verification preserves existing configuration and removes its temporary file',()=>fixture(async directory=>{
  const config=options(directory),configPath=join(directory,'voice/gpt-sovits.json');
  await mkdir(join(directory,'voice'),{recursive:true});await writeFile(configPath,'{"existing":"preserve"}\n');
  const manager=createAudioTemplates({...config,bootstrap:async args=>({...await config.bootstrap(args),profileSha256:'0'.repeat(64)})});
  try {
    await manager.install();assert.equal((await done(manager)).installation.status,'failed');
    assert.equal(await readFile(configPath,'utf8'),'{"existing":"preserve"}\n');
    assert.deepEqual((await readdir(join(directory,'voice'))).filter(name=>name.endsWith('.tmp')),[]);
  } finally {await manager.close();}
}));

test('installation only publishes configuration after verification and does not choose a default',()=>fixture(async directory=>{
  const manager=createAudioTemplates(options(directory));
  try {
    const before=await manager.catalog('');assert.deepEqual(before.templates.map(t=>t.id),['default','mambo-zh']);assert.equal(before.templates[1].installed,false);
    await assert.rejects(manager.assertAvailable('mambo-zh'),/尚未/);
    await manager.install();const after=await done(manager);
    assert.equal(after.installation.status,'completed');assert.equal(after.templates[1].installed,true);assert.equal(after.templates[1].selected,false);
    assert.equal((await manager.catalog('mambo-zh')).templates[1].selected,true);
  } finally { await manager.close(); }
}));

test('failed installation can retry using verified cached resources',()=>fixture(async directory=>{
  const manager=createAudioTemplates(options(directory,{fail:true}));
  try {
    await manager.install();assert.equal((await done(manager)).installation.status,'failed');
    await assert.rejects(stat(join(directory,'voice/gpt-sovits.json')),{code:'ENOENT'});
    await manager.install();const retry=await done(manager);
    assert.equal(retry.installation.status,'failed');assert.match(retry.installation.error,/fixture bootstrap failed/);
    assert.equal((await readFile(join(directory,'voice/downloads/mambo-v1/engine.zip'))).toString(),'model-bytes');
  } finally { await manager.close(); }
}));

test('cancelling installation leaves the default configuration unpublished',()=>fixture(async directory=>{
  let started;const ready=new Promise(r=>started=r);
  const manager=createAudioTemplates(options(directory,{pause:signal=>new Promise((resolve,reject)=>{started();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})}));
  try {
    await manager.install();await ready;manager.cancel();
    assert.equal((await done(manager)).installation.status,'cancelled');
    await assert.rejects(stat(join(directory,'voice/gpt-sovits.json')),{code:'ENOENT'});
  } finally { await manager.close(); }
}));

test('concurrent install requests cannot start duplicate workers',()=>fixture(async directory=>{
  const manager=createAudioTemplates(options(directory));
  try {
    const results=await Promise.allSettled([manager.install(),manager.install()]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal((await done(manager)).installation.status,'completed');
  } finally { await manager.close(); }
}));

test('HTTP templates reject selecting an unavailable voice and reuse existing settings',()=>fixture(async directory=>{
  const engine=await createEngine({dataDir:join(directory,'engine')});
  const app=await startServer({engine,port:0,audioTemplateOptions:options(directory)});
  try {
    const get=async()=>(await fetch(app.url+'/api/audio-templates')).json();
    assert.equal((await get()).templates[1].installed,false);
    const request=async action=>fetch(app.url+'/api/audio-templates/mambo-zh/'+action,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    assert.equal((await request('select')).status,400);
    assert.equal(engine.store.state.settings.ttsVoice,'');
    assert.equal((await request('install')).status,202);await done(app.audioTemplates);
    assert.equal((await request('select')).status,200);assert.equal(engine.store.state.settings.ttsVoice,'mambo-zh');
    assert.equal((await fetch(app.url+'/api/audio-templates/unknown/select',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,404);
  } finally { await app.close();await engine.close(); }
}));
