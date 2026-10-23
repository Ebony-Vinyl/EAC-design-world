import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inside = (root, file) => {
  const path = relative(root, file);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
};

export function restoreNpmAssets(directory = packageRoot) {
  const root = realpathSync(directory);
  const mapPath = resolve(root, 'npm-asset-map.json');
  if (!existsSync(mapPath)) return { restored: 0 };
  const map = JSON.parse(readFileSync(mapPath, 'utf8'));
  if (map.version !== 1 || !Array.isArray(map.assets) || map.assets.length > 20000) {
    throw new Error('Invalid npm asset map');
  }
  const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
  if (map.packageVersion !== version) return { restored: 0 };
  const checked = new Map();
  let restored = 0;
  for (const asset of map.assets) {
    if (typeof asset.from !== 'string' || typeof asset.to !== 'string'
      || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Invalid npm asset record');
    const source = resolve(root, asset.from);
    const target = resolve(root, asset.to);
    if (!inside(root, source) || !inside(root, target) || source === root || target === root) {
      throw new Error('npm asset path escapes package');
    }
    if (existsSync(target)) continue;
    const realSource = realpathSync(source);
    if (!inside(root, realSource)) throw new Error('npm asset source escapes package');
    if (!checked.has(asset.from)) checked.set(asset.from, createHash('sha256').update(readFileSync(realSource)).digest('hex'));
    if (checked.get(asset.from) !== asset.sha256) throw new Error(`npm asset content differs: ${asset.from}`);
    let ancestor = dirname(target);
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    if (!inside(root, realpathSync(ancestor))) throw new Error('npm asset directory escapes package');
    mkdirSync(dirname(target), { recursive: true });
    if (!inside(root, realpathSync(dirname(target)))) throw new Error('npm asset directory escapes package');
    try {
      copyFileSync(realSource, target, constants.COPYFILE_EXCL);
      restored++;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  return { restored };
}

restoreNpmAssets();
