import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, templates } from '../src/catalog.mjs';

const checks = [
  { name: 'Node >= 22', ok: Number(process.versions.node.split('.')[0]) >= 22, detail: process.version },
  ...['ffmpeg', 'ffprobe', 'python'].map((name) => {
    const result = spawnSync(name, [name === 'python' ? '--version' : '-version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return { name, ok: result.status === 0, detail: String(result.stdout || result.stderr || result.error?.message).split('\n')[0] };
  }),
  { name: 'Edge', ok: existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'), detail: 'Windows browser capture / deterministic render' },
  ...templates.map((template) => ({ name: template.name, ok: existsSync(join(ROOT, template.entry)), detail: template.status }))
];
for (const check of checks) console.log(`${check.ok ? 'OK' : 'MISSING'}  ${check.name}: ${check.detail}`);
console.log('Note: template sources can require separately licensed fonts or pre-rendered Blender assets.');
if (checks.slice(0, 4).some((check) => !check.ok)) process.exitCode = 1;
