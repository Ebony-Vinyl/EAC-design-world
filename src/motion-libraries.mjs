import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const motionCases = [
  ['string-clock', '软体时钟', '精确端点与弹性绳索表针'],
  ['ink-crowd', '墨线人群', 'WebGL2 深度轮廓与手绘沸腾'],
  ['press-stack', '唱片叠层', '原生滚动、粘性封套与 Canvas 唱片'],
  ['wheel-rail', '滚轮轨道', '滚轮编排、曲线标签与指针视差'],
  ['toy-flipbook', '玩具翻页', '预渲染角度帧、弹簧与定格抖动'],
  ['char-curtain', '字符幕帘', '指针交互与 Verlet 绳索字符'],
  ['lyre-crows', '琴弦与墨鸦', '拨弦、文字粒子与追逐生态'],
];
const sources = {
  'motion-web': { license: 'CC-BY-NC-4.0', author: 'Patrick (feitangyuan)', homepage: 'https://github.com/feitangyuan/motion-web' },
  onetake: { license: 'PolyForm-Noncommercial-1.0.0', author: 'Patrick (feitangyuan)', homepage: 'https://github.com/feitangyuan/onetake' },
};

export function motionTemplates({ root = ROOT } = {}) {
  const entries = [];
  if (existsSync(resolve(root, 'vendor/motion-web/LICENSE'))) {
    for (const [slug, name, description] of motionCases) {
      const entry = `vendor/motion-web/cases/${slug}/index.html`;
      if (!existsSync(resolve(root, entry)) || !existsSync(resolve(root, `vendor/motion-web/cases/${slug}/README.md`))) continue;
      entries.push({ id: `mw-${slug}`, name: `Motion Web · ${name}`, description,
        kind: 'motion', category: '交互动效', source: 'motion-web', ...sources['motion-web'],
        entry, prompt: `vendor/motion-web/cases/${slug}/README.md`,
        thumbnail: `/vendor/motion-web/assets/cases/${slug}.webp`,
        width: 1440, height: 900, duration: 10, available: true,
        status: 'interactive', renderable: false, previewMode: 'interactive',
        requirements: ['实时交互案例；视频导出请用 record-browser 录制，或定制为 __seek(t) 时间线'],
      });
    }
  }
  if (['vendor/onetake/LICENSE', 'vendor/onetake/SKILL.md', 'vendor/onetake/lib/motion.js', 'vendor/eac-motion/onetake-demo.html']
    .every(path => existsSync(resolve(root, path)))) {
    entries.push({ id: 'onetake-studio', name: 'Onetake · 连续运镜',
      description: 'EAC 原创示例，使用 Onetake 的 OM 弹簧、文字入场和连续运镜函数。',
      kind: 'motion', category: '连续运镜', source: 'onetake', ...sources.onetake,
      entry: 'vendor/eac-motion/onetake-demo.html', prompt: 'vendor/onetake/SKILL.md',
      width: 1920, height: 1080, duration: 8, available: true,
      status: 'source-ready', renderable: true, previewMode: 'timeline',
    });
  }
  return entries;
}

export function motionSkills({ root = ROOT } = {}) {
  return Object.entries(sources).filter(([id]) => existsSync(resolve(root, `vendor/${id}/SKILL.md`)))
    .map(([source, meta]) => ({ id: `${source}-skill`, name: `${source} 制作指南`,
      kind: 'skill', source, ...meta, path: `vendor/${source}/SKILL.md`,
      description: `${source} 的本地可选制作规范与参考文档；非商业许可。`, status: 'local-optional' }));
}

function resourcePaths(root, directory, prefix = '') {
  if (!existsSync(resolve(root, directory))) return [];
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink() || entry.name.startsWith('.') || entry.name === 'node_modules') return [];
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) return resourcePaths(root, `${directory}/${entry.name}`, `${name}/`);
    return /\.(md|txt|js|mjs|py|json|html|css)$/i.test(name) || entry.name === 'LICENSE' ? [name] : [];
  });
}

export async function readMotionLibraryItem({ kind, id, includeEntry = false, resource, root = ROOT }) {
  const item = kind === 'skill' ? motionSkills({ root }).find(item => item.id === id)
    : ['template', 'motion'].includes(kind) ? motionTemplates({ root }).find(item => item.id === id) : null;
  if (!item) return null;
  const prompt = item.prompt || item.path;
  const resources = resourcePaths(root, `vendor/${item.source}`);
  let selected;
  if (resource !== undefined) {
    if (typeof resource !== 'string' || !resources.includes(resource)) throw new Error('资源路径无效；请从 resources 列表选择');
    const directory = realpathSync(resolve(root, `vendor/${item.source}`));
    const path = realpathSync(resolve(directory, resource));
    const rel = relative(directory, path);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('资源路径越界');
    selected = { path: `vendor/${item.source}/${resource}`, text: readFileSync(path, 'utf8') };
  }
  return { ...item, resources, ...(selected ? { resource: selected } : {}), content: prompt ? readFileSync(resolve(root, prompt), 'utf8') : '',
    ...(item.entry ? { entry: { path: item.entry, ...(includeEntry ? { text: readFileSync(resolve(root, item.entry), 'utf8') } : {}) } } : {}) };
}
