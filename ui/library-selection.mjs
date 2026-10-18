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
  if (mode !== 'design' || kind === 'motion') {
    const picks = scoped.filter(item => item.source === 'video-shotcraft' && item.recommended);
    if (!picks.length) return scoped.slice(0, limit);
    const others = scoped.filter(item => item.source !== 'video-shotcraft');
    const result = [];
    for (let index = 0; result.length < limit && (index < picks.length || index < others.length); index++) {
      if (others[index]) result.push(others[index]);
      if (picks[index] && result.length < limit) result.push(picks[index]);
    }
    return [...result, ...scoped.filter(item => !result.includes(item))].slice(0, limit);
  }
  return scoped.map((item, index) => ({ item, index, score:
    (item.thumbnail ? 8 : 0) + (item.entry ? 4 : 0) + (item.sourceSet === 'design-templates' ? 2 : 0)
    + (item.kind === kind ? 1 : 0) }))
    .sort((a, b) => b.score - a.score || a.index - b.index).slice(0, limit).map(row => row.item);
}

export function previewImage(item) {
  return `/library-previews/${encodeURIComponent(item.id)}.jpg`;
}

export function matchesTemplate(item, query) {
  const text = [item.name, item.id, item.source, item.description, item.category, item.recipe,
    item.summary, item.use, item.energy, ...(Array.isArray(item.tags) ? item.tags : [])].join(' ').toLocaleLowerCase();
  return String(query || '').trim().toLocaleLowerCase().split(/\s+/).every(word => text.includes(word));
}

export function formatDuration(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${Number(seconds.toFixed(1))}s`;
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

export function readShotlist(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? [...new Set(parsed.filter(id =>
      typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)))].slice(0, 500) : [];
  } catch { return []; }
}

export function shotlistText(items) {
  return items.map((item, index) => `${index + 1}. ${item.name} [${item.id}]${item.category ? ` · ${item.category}` : ''}${formatDuration(item.duration) ? ` · ${formatDuration(item.duration)}` : ''}${item.use ? `\n   ${item.use}` : ''}`).join('\n');
}
