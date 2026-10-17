import React, { useEffect, useState } from 'react';
import { Check, Plus, Scissors, Trash2, Volume2 } from 'lucide-react';

export default function TimelineEditor({ project, onSave, busy }) {
  const [clips, setClips] = useState(() => structuredClone(project.clips || []));
  const [baseRevision, setBaseRevision] = useState(project.revision);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!dirty) { setClips(structuredClone(project.clips || [])); setBaseRevision(project.revision); }
  }, [project.revision, dirty]);
  const update = (index, key, value) => { setDirty(true); setClips(rows => rows.map((row, current) => current === index ? { ...row, [key]: value } : row)); };
  const total = Math.max(1, ...clips.map(clip => Number(clip.start) + Number(clip.duration)));
  const add = event => {
    const asset = project.assets.find(item => item.id === event.target.value);
    if (!asset) return;
    setClips(rows => [...rows, { id: crypto.randomUUID(), assetId: asset.id, path: asset.path, kind: asset.kind,
      start: rows.length ? Math.max(...rows.map(clip => Number(clip.start) + Number(clip.duration))) : 0,
      sourceIn: 0, duration: asset.kind === 'image' ? 4 : Math.min(asset.duration, 4), track: asset.kind === 'audio' ? 1 : 0, volume: 1 }]);
    setDirty(true); event.target.value = '';
  };
  const save = async () => {
    setError('');
    if (clips.some(clip => !Number.isFinite(Number(clip.start)) || Number(clip.start) < 0 || !Number.isFinite(Number(clip.duration)) || Number(clip.duration) <= 0)) {
      setError('每个片段需要有效的开始时间和正时长。'); return;
    }
    const updated = await onSave({ revision: baseRevision, clips, captions: project.captions || [], subtitleStyle: project.subtitleStyle });
    if (updated) { setDirty(false); setBaseRevision(updated.revision); }
  };
  return <section className="timeline-editor">
    <div className="section-toolbar"><div className="section-title"><Scissors size={16} /><h2>多轨时间线</h2><span className="count">{clips.length} 个片段 · {total.toFixed(2)}s</span></div><button className="button primary" disabled={!dirty || busy} onClick={save}><Check size={14} />保存编排</button></div>
    {project.revision !== baseRevision && dirty && <p className="inline-error" role="alert">项目已被其他操作更新。当前未保存编排仍保留；请重新打开时间线以使用最新版本。</p>}
    <div className="timeline-ruler"><span>0s</span><span>{(total / 2).toFixed(1)}s</span><span>{total.toFixed(1)}s</span></div>
    <div className="timeline-tracks">{[...new Set(clips.map(clip => Number(clip.track || 0)))].sort((a, b) => a - b).map(track => <div key={track} className="timeline-track"><span>轨 {track + 1}</span><div>{clips.map((clip, index) => Number(clip.track || 0) === track && <button key={clip.id || index} title={`${clip.path?.split(/[\\/]/).pop()} ${clip.start}s / ${clip.duration}s`} style={{ left: `${Number(clip.start) / total * 100}%`, width: `${Number(clip.duration) / total * 100}%` }} onClick={() => document.getElementById(`clip-${index}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })}>{clip.kind === 'audio' ? <Volume2 size={12} /> : <Scissors size={12} />}<span>{clip.path?.split(/[\\/]/).pop()}</span></button>)}</div></div>)}</div>
    <label className="timeline-add">添加项目素材<select aria-label="添加时间线素材" defaultValue="" onChange={add}><option value="">选择素材…</option>{project.assets.map(asset => <option key={asset.id} value={asset.id}>{asset.name || asset.path.split(/[\\/]/).pop()} · {asset.kind}</option>)}</select></label>
    <div className="timeline-clip-list">{clips.map((clip, index) => <article key={clip.id || index} id={`clip-${index}`} className="timeline-clip-editor"><header><strong>{String(index + 1).padStart(2, '0')} · {clip.path?.split(/[\\/]/).pop()}</strong><button className="icon-button" aria-label={`删除片段 ${index + 1}`} onClick={() => { setClips(rows => rows.filter((_, current) => current !== index)); setDirty(true); }}><Trash2 size={15} /></button></header><div className="timeline-fields">{[['start', '开始 / 秒', 0, 3600], ['sourceIn', '素材入点 / 秒', 0, 3600], ['duration', '保留时长 / 秒', 0.01, 3600], ['volume', '音量倍数', 0, 4], ['track', '轨道序号', 0, 100]].map(([key, label, min, max]) => <label key={key}>{label}<input type="number" aria-label={`片段 ${index + 1} ${label}`} min={min} max={max} step={key === 'track' ? 1 : 0.01} value={clip[key] ?? (key === 'volume' ? 1 : 0)} onChange={event => update(index, key, Number(event.target.value))} /></label>)}</div></article>)}</div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <p className="muted timeline-note">保存保留原素材与历史剪辑。修改镜头后请重新生成字幕，再渲染检查成片。</p>
  </section>;
}
