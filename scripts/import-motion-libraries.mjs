import { lstat, mkdir, readdir, readFile, writeFile, mkdtemp, rename, rm } from 'node:fs/promises';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const libraries = {
  'motion-web': { license: 'CC-BY-NC-4.0', required: ['LICENSE', 'SKILL.md', 'cases'],
    include: ['LICENSE', 'SKILL.md', 'README.md', 'cases', 'references', 'scripts', 'data', 'assets/cases'] },
  onetake: { license: 'PolyForm-Noncommercial-1.0.0', required: ['LICENSE', 'SKILL.md', 'lib/motion.js', 'templates/comp.html'],
    include: ['LICENSE', 'SKILL.md', 'README.md', 'lib', 'references', 'templates', 'looks', 'scripts', 'cases', 'gallery/sheets'] },
};
const allowed = /\.(?:html|md|txt|js|mjs|py|json|css|svg|woff2?|ttf|otf|webp|png|jpe?g)$/i;

export async function importMotionLibrary({ library, source, destinationRoot = ROOT, usage } = {}) {
  if (!['noncommercial', 'licensed'].includes(usage)) {
    throw new Error('请确认用途：--noncommercial 用于非商业测试，或 --licensed 表示已另行取得所需商业授权。');
  }
  const config = libraries[library];
  if (!config) throw new Error('库名称必须是 motion-web 或 onetake');
  if (!source) throw new Error(`请提供 ${library} 的本地源码路径`);
  source = resolve(source);
  for (const file of config.required) {
    const info = await lstat(join(source, file)).catch(() => null);
    if (!info || info.isSymbolicLink() || !(info.isFile() || info.isDirectory())) throw new Error(`源码缺少 ${file}：${source}`);
  }
  const destination = resolve(destinationRoot, 'vendor', library);
  if (await lstat(destination).catch(() => null)) throw new Error(`目标已存在，未覆盖：${destination}。更新时请先将原目录移到备份位置。`);
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(join(dirname(destination), `.import-${library}-`));
  const digest = createHash('sha256');
  let files = 0;
  try {
    const copy = async (name) => {
      const path = join(source, name);
      const info = await lstat(path).catch(() => null);
      if (!info) return;
      if (info.isSymbolicLink()) throw new Error(`不导入符号链接：${name}`);
      if (info.isDirectory()) {
        for (const child of (await readdir(path)).sort()) {
          if (child.startsWith('.') || child === 'node_modules' || child === '__pycache__') continue;
          await copy(join(name, child));
        }
      } else if (info.isFile() && (allowed.test(name) || /(?:^|[\\/])LICENSE$/i.test(name))) {
        const bytes = await readFile(path);
        const target = join(staging, name);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
        digest.update(relative(source, path).replaceAll('\\', '/')).update('\0').update(bytes).update('\0');
        files++;
      }
    };
    for (const name of config.include) await copy(name);
    const git = spawnSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const revision = git.status === 0 && /^[a-f0-9]{40,64}$/i.test(git.stdout.trim()) ? git.stdout.trim() : null;
    const provenance = { library, homepage: `https://github.com/feitangyuan/${library}`, license: config.license,
      usage, revision, digest: `sha256:${digest.digest('hex')}`, files, importedAt: new Date().toISOString(),
      redistribution: 'Local optional source only; excluded from EAC public Git and release archives.' };
    await writeFile(join(staging, 'EAC-PROVENANCE.json'), JSON.stringify(provenance, null, 2) + '\n');
    await rename(staging, destination);
    return { ...provenance, destination };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const usage = args.includes('--licensed') ? 'licensed' : args.includes('--noncommercial') ? 'noncommercial' : undefined;
    const results = [];
    for (const library of Object.keys(libraries)) {
      const index = args.indexOf(`--${library}`);
      if (index < 0) continue;
      const source = args[index + 1];
      if (!source || source.startsWith('--')) throw new Error(`--${library} 后需要本地源码目录`);
      results.push(await importMotionLibrary({ library, source, usage }));
    }
    if (!results.length) throw new Error('用法：node scripts/import-motion-libraries.mjs --motion-web <本地目录> --onetake <本地目录> --noncommercial（或 --licensed）');
    console.log(JSON.stringify(results, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
