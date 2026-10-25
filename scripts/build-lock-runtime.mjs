import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const directory = join(root, 'vendor', 'eac-runtime');
const packages = ['proper-lockfile', 'graceful-fs', 'retry', 'signal-exit'];
const provenance = [];
await mkdir(directory, { recursive: true });
for (const name of packages) {
  const path = require.resolve(`${name}/package.json`);
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  const home = dirname(path);
  let license;
  for (const filename of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
    license = await readFile(join(home, filename), 'utf8').catch(() => null);
    if (license) break;
  }
  if (!license) throw new Error(`Missing license for ${name}`);
  await writeFile(join(directory, `${name}.LICENSE`), license);
  provenance.push({ name, version: manifest.version, license: manifest.license, repository: manifest.repository });
}
const output = join(directory, 'proper-lockfile.cjs');
await build({
  entryPoints: [require.resolve('proper-lockfile')], outfile: output,
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', legalComments: 'inline',
  banner: { js: '// Bundled for updates to existing installs without changing node_modules. See adjacent licenses and PROVENANCE.json.' },
});
const bytes = await readFile(output);
await writeFile(join(directory, 'PROVENANCE.json'), `${JSON.stringify({
  purpose: 'Self-contained data-directory lock for in-place updates retaining existing dependencies',
  entry: 'proper-lockfile.cjs', sha256: createHash('sha256').update(bytes).digest('hex'), packages: provenance,
}, null, 2)}\n`);
console.log(`Built lock runtime (${bytes.length} bytes)`);
