const classicThumbnail = new URL('./assets/motion-promo-film.jpg', import.meta.url).href;
const cinemaThumbnail = new URL('./assets/motion-promo-film-v2.jpg', import.meta.url).href;

const library = [
  ['01-flat-vector', '扁平矢量', '平面设计', 'popwise · One Dot', '鲜明色块与清晰的几何节奏，让品牌信息轻快登场。'],
  ['02-line-art', '线条动画', '平面设计', 'ATELIER LINEA · 一笔画', '用线条的生长与转折，构建克制的品牌叙事。'],
  ['03-isometric', '等轴 2.5D', '空间设计', 'ISOPOLIS · 让城市自己生长', '微缩空间与等轴视角，适合系统、产品与城市故事。'],
  ['04-3d-render', '3D 渲染', '空间设计', 'soft. · 柔软着陆', '柔软材质、空间运动与立体排版。需要 Blender 渲染能力。'],
  ['05-cel-boil', '逐帧手绘', '手作质感', 'HAND MADE · 手作', '带有线条沸腾与手绘温度的逐帧动画。'],
  ['06-collage', '拼贴剪贴', '手作质感', 'NOGGIN · 脑洞季刊', '照片、纸张与剪贴元素交织的编辑式视觉。'],
  ['07-liquid', '液态流动', '实验动态', 'drop. · 万物始于一滴', '有机形态与流动转场，连接每个视觉瞬间。'],
  ['08-morph', '形变动画', '实验动态', 'morphe. · 一形万象', '以连续的图形变换，串起完整的动态叙事。'],
  ['09-bauhaus', '几何构成', '平面设计', 'KONSTRUKTION · 二十拍构成', '包豪斯几何构成，以形状和节拍建立秩序。'],
  ['10-synthwave', '复古 Synthwave', '数字风格', 'NEON DRIVE · 霓虹夜驰 1986', '复古电子视觉、透视网格与 VHS 质感。'],
  ['12-aurora-glass', '极光玻璃', '实验动态', 'Aurora · 思考，自有光', '弥散光色与玻璃材质，呈现轻盈的数字体验。'],
  ['18-hanazi', '综艺花字', '数字风格', '喵呜日记 · EP.07', '9:16 竖屏花字与活泼排版，适合短视频内容。'],
  ['19-paperclip', '贴纸科普', '手作质感', '一部手机里，藏着多少种元素？', '粗描边贴纸人物与信息图形，讲清复杂的知识。'],
  ['20-pixel', '像素风格', '数字风格', 'PIXEL QUEST · 像素冒险', '像素图形与游戏式节奏，重现数字复古趣味。'],
  ['22-hud', '赛博 HUD', '数字风格', '隼眼-9 · 目标锁定', '精密信息图形与科幻界面构成的动态设计。'],
];

export const localTemplates = [
  ...library.map(([id, name, category, subtitle, description]) => ({
    id, name, category, subtitle, description,
    source: 'mg-styles-15',
    thumbnail: `/vendor/mg-styles-15/docs/readme/films/${id}.webp`,
    preview: `/vendor/mg-styles-15/videos/${id}.mp4`,
  })),
  {
    id: 'motion-promo-film', name: '产品动效宣传片', category: '产品演示',
    subtitle: 'Motion Promo · 确定性时间轴',
    description: '以产品界面、动态排版与编号章节组织产品宣传内容。',
    source: 'motion-promo-film',
    thumbnail: classicThumbnail,
    entry: 'vendor/motion-promo-film/templates/film-template.html',
  },
  {
    id: 'motion-promo-film-v2', name: '悬浮窗口演示', category: '产品演示',
    subtitle: 'Motion Promo V2 · 界面与节拍',
    description: '悬浮窗口、交互光标与交替字幕，适合产品功能演示。',
    source: 'motion-promo-film-v2',
    thumbnail: cinemaThumbnail,
    entry: 'vendor/motion-promo-film-v2/references/example-film.html',
  },
];

// A source id is rendered as a small uppercase credit; upstream library entries
// must not all be labelled as the MG video pack.
const sourceLabels = {
  'mg-styles-15': 'MG STYLES',
  'motion-promo-film': 'MOTION PROMO',
  'motion-promo-film-v2': 'MOTION PROMO V2',
  'local-skill': 'LOCAL SKILL',
  'open-design': 'OPEN DESIGN',
  'motion-web': 'MOTION WEB',
  'onetake': 'ONETAKE',
  'video-shotcraft': 'SHOTCRAFT',
};
const authorName = author => typeof author === 'string' ? author : author?.name || '';
const entryPath = entry => typeof entry === 'string' ? entry : entry?.path || '';

export function sourceLabel(source) {
  if (!source) return 'CATALOG';
  if (sourceLabels[source]) return sourceLabels[source];
  return String(source).replace(/[-_]+/g, ' ').toUpperCase().slice(0, 32);
}

export function resolveTemplates(templates) {
  if (!templates?.length) return localTemplates;
  return templates.map(template => {
    const local = localTemplates.find(item => item.id === template.id);
    return {
      ...local,
      ...template,
      name: template.titleI18n?.['zh-CN'] || template.name || template.title || local?.name || template.id,
      description: template.description || template.summary || local?.description || '',
      author: authorName(template.author),
      entry: entryPath(template.entry) || local?.entry,
      prompt: entryPath(template.prompt) || template.promptPath || '',
      homepage: template.homepage || template.sourceUrl || '',
      thumbnail: template.thumbnail || local?.thumbnail,
      preview: (typeof template.preview === 'string' ? template.preview : template.preview?.video) || local?.preview,
      category: template.category || local?.category || '其他',
    };
  });
}

export const creationKindLabels = {
  motion: '动效视频', website: '网站 / 原型', deck: '幻灯片', document: '文档', image: '图片',
  prompt: '提示词', example: '示例', video: '视频', design: '设计', 'design-system': '设计体系',
};

export function kindLabel(kind) {
  return creationKindLabels[kind] || (kind ? String(kind) : '其他');
}

// Design systems are normalised so search, swatches and font previews never
// depend on one exact upstream key. Missing fields degrade to empty, never fake.
const asArray = value => Array.isArray(value) ? value : value && typeof value === 'object' ? Object.entries(value).map(([name, item]) =>
  (item && typeof item === 'object' ? { name, ...item } : { name, value: item })) : [];

function colorEntries(system) {
  const raw = [system.colors, system.palette, system.swatches, system.colorTokens].find(Array.isArray)
    || [system.colors, system.palette].find(value => value && typeof value === 'object')
    || [];
  return asArray(raw).map((entry, index) => {
    const value = typeof entry === 'string' ? entry : entry.value || entry.hex || entry.color || '';
    const name = typeof entry === 'string' ? '' : entry.name || entry.label || entry.token || '';
    return { name: name || `色板 ${index + 1}`, value: String(value || '').trim() };
  }).filter(entry => /^#([0-9a-f]{3,8})$/i.test(entry.value) || /^(rgb|hsl)a?\(/i.test(entry.value)).slice(0, 16);
}

function fontEntries(system) {
  if (system.fonts && !Array.isArray(system.fonts) && typeof system.fonts === 'object') {
    const fonts = Object.entries(system.fonts).filter(([role]) => ['display', 'body', 'mono'].includes(role))
      .flatMap(([role, families]) => (Array.isArray(families) ? families : [families]).filter(value => typeof value === 'string').map(family => ({ role, family })));
    if (fonts.length) return fonts;
  }
  const raw = [system.fonts, system.fontFamilies, system.typography, system.type].find(Array.isArray)
    || [system.fonts, system.fontFamilies].find(value => value && typeof value === 'object')
    || [];
  return asArray(raw).map((entry, index) => {
    const family = typeof entry === 'string' ? entry : entry.family || entry.name || entry.stack || '';
    const role = typeof entry === 'string' ? '' : entry.role || entry.label || '';
    return { role: role || `字体 ${index + 1}`, family: String(family || '').trim() };
  }).filter(entry => entry.family).slice(0, 12);
}

function tokenEntries(system) {
  const raw = [system.tokens?.primary, system.tokens, system.variables, system.designTokens].find(Array.isArray)
    || [system.tokens, system.variables].find(value => value && typeof value === 'object')
    || [];
  return asArray(raw).map(entry => ({
    name: typeof entry === 'string' ? entry : entry.name || entry.token || '',
    value: typeof entry === 'string' ? '' : entry.value ?? entry.text ?? '',
  })).filter(entry => entry.name && String(entry.value) !== '').slice(0, 40);
}

export function normalizeDesignSystem(system = {}) {
  const attribution = system.attribution || system.provenance || {};
  return {
    id: system.id || system.slug || '',
    name: system.name || system.title || system.id || '未命名设计体系',
    description: system.description || system.summary || '',
    source: system.source || 'open-design',
    license: system.license || attribution.license || '',
    author: authorName(system.author || attribution.author || attribution.owner),
    preview: system.preview, components: system.components, tokensCss: system.tokensCss, designPath: system.design,
    homepage: system.homepage || system.sourceUrl || system.url || attribution.url || attribution.homepage || '',
    kind: system.kind || 'design-system',
    status: system.status || system.runtime || '',
    colors: colorEntries(system),
    fonts: fontEntries(system),
    tokens: tokenEntries(system),
  };
}

export function resolveDesignSystems(systems) {
  return (Array.isArray(systems) ? systems : []).map(normalizeDesignSystem).filter(system => system.id);
}

export function resolveLibraryTemplates(templates) {
  return resolveTemplates(templates).map(template => ({
    ...template,
    kind: template.kind || (/motion|video/.test(template.category || '') ? 'motion' : 'motion'),
    renderable: template.renderable !== false && Boolean(template.entry || template.preview),
  }));
}
