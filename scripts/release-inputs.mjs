import { existsSync, createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

export const REUSED_MEDIA_SHA256 = 'e25eaa79f91b030f2f5028d6b3515b9c1c4332303aa38086477f1d5fabb98166';

export async function releaseInputs({ root, version, args = [], env = process.env, expectedHash = REUSED_MEDIA_SHA256 }) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    output: { type: 'string' }, media: { type: 'string' },
  } });
  if (positionals.length > 1 || (positionals.length && values.output)) throw new Error('Specify one output directory');
  const output = resolve(values.output || positionals[0] || join(root, 'release', `publish-v${version}`));
  const outputRelative = relative(join(root, 'release'), output);
  if (!outputRelative || outputRelative.startsWith('..') || isAbsolute(outputRelative)) throw new Error('Output must be a new release subdirectory');
  if (existsSync(output)) throw new Error(`Refusing to overwrite ${output}`);
  const requested = values.media || env.EAC_RELEASE_MEDIA || join(root, 'release', 'media-cache', 'eac-design-world-v0.3.0-media.zip');
  let mediaPath;
  try { mediaPath = await realpath(resolve(requested)); }
  catch { throw new Error(`Media archive not found: ${requested}. Supply --media or EAC_RELEASE_MEDIA before packaging.`); }
  if (!(await stat(mediaPath)).isFile()) throw new Error('Media archive must be a regular file');
  const mediaRelative = relative(output, mediaPath);
  if (!mediaRelative.startsWith('..') && !isAbsolute(mediaRelative)) throw new Error('Media source must be outside the output directory');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(mediaPath)) hash.update(chunk);
  if (hash.digest('hex') !== expectedHash) throw new Error('Reused media must match the published v0.3.0 archive');
  return { output, mediaPath };
}
