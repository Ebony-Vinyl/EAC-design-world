export const creationKinds = ['website', 'motion', 'deck', 'document', 'image'];

export function templateKind(item) {
  if (item.kind && item.kind !== 'prompt') return item.kind;
  const surface = `${item.surface || ''} ${item.mode || ''} ${item.sourceSet || ''}`;
  if (/video|motion/.test(surface)) return 'motion';
  if (/image/.test(surface)) return 'image';
  return item.kind || 'motion';
}

export function scopedTemplates(templates, mode, kind) {
  const wanted = mode === 'design' ? kind : 'motion';
  return templates.filter(item => templateKind(item) === wanted);
}

export function recommendedTemplates(templates, mode, kind, limit = 4) {
  const scoped = scopedTemplates(templates, mode, kind);
  if (mode !== 'design') return scoped.slice(0, limit);
  return scoped.map((item, index) => ({ item, index, score:
    (item.thumbnail ? 8 : 0) + (item.entry ? 4 : 0) + (item.sourceSet === 'design-templates' ? 2 : 0)
    + (item.kind === kind ? 1 : 0) }))
    .sort((a, b) => b.score - a.score || a.index - b.index).slice(0, limit).map(row => row.item);
}

export function previewImage(item) {
  return `/library-previews/${encodeURIComponent(item.id)}.jpg`;
}
