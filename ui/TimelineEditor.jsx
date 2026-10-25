import React, { useEffect, useState } from 'react';
import { Check, ExternalLink, Palette, Plus, RotateCcw, Scissors, Trash2, Volume2 } from 'lucide-react';
import { hasScalarOverride, removeScalarOverride, resolveGradingValues } from './grading-values.mjs';

const gradeFields = [
  ['exposure', '曝光', -2, 2], ['temperature', '色温', -1, 1],
  ['saturation', '饱和', -1, 1], ['contrast', '对比', -1, 1], ['vibrance', '自然饱和', -1, 1],
];

const CUSTOM_GRADE = '__custom';
const hasGradeFields = grading => Boolean(grading) && typeof grading === 'object' && Object.keys(grading).length > 0;
const SOURCE_LABELS = {
  default: '默认值', 'look-preset': '项目预设', look: '项目 look',
  'clip-preset': '片段预设', clip: '片段覆盖',
};

function GradingControls({ grading, look, presets, onChange, disabled }) {
  if (!presets.length) return null;
  const presetId = grading?.preset || '';
  // A grade that carries values but no preset id is hand-built (curves, HSL, custom scalars); it must
  // read as 自定义调色 instead of silently pretending to be "follow the project look".
  const custom = !presetId && hasGradeFields(grading);
  // The five scalar controls must show the value that actually renders: project look preset, then
  // explicit look, then clip preset, then explicit clip. Reading `grading[key] ?? 0` hid the inherited
  // value and made an untouched control look like an override to zero.
  const values = resolveGradingValues(look, grading, presets);
  const setScalar = (key, raw) => {
    const text = String(raw).trim();
    if (!text) {
      // Clearing the input removes the override so the inherited value applies again.
      return onChange(removeScalarOverride(grading, key));
    }
    const value = Number(text);
    // An explicit 0 is a real override of a preset/project value, so it is stored rather than dropped.
    if (!Number.isFinite(value)) return;
    onChange({ ...(grading || {}), [key]: value });
  };
  return <div className="grading-controls">
    <label>调色预设<select aria-label="调色预设" value={custom ? CUSTOM_GRADE : presetId} disabled={disabled} onChange={event => {
      const value = event.target.value;
      if (value === CUSTOM_GRADE) return;
      if (!value) return onChange(null);
      // Keep every non-preset field (advanced curves, hue-vs, zones, secondaries, scalars) so
      // choosing a look never discards hand-built work.
      onChange({ ...(grading || {}), preset: value });
    }}>
      <option value="">跟随项目 look</option>
      {custom && <option value={CUSTOM_GRADE} disabled>自定义调色</option>}
      {presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
    </select></label>
    {gradeFields.map(([key, label, min, max]) => {
      const resolved = values[key];
      const override = hasScalarOverride(grading, key);
      return <div key={key} className="grading-field" data-source={resolved.source} data-override={override ? 'true' : 'false'}>
        <label>{label}<input type="number" aria-label={`${label} ${key}`} min={min} max={max} step={0.05}
          disabled={disabled}
          value={resolved.value}
          onChange={event => setScalar(key, event.target.value)} /></label>
        <span className="grading-source" aria-label={`${label} 来源`}>
          {override ? '片段覆盖' : SOURCE_LABELS[resolved.source]}
          {override && <button type="button" className="grading-reset" aria-label={`重置${label}为继承值`} title="恢复为继承值" disabled={disabled}
            onClick={() => onChange(removeScalarOverride(grading, key))}><RotateCcw size={11} /></button>}
        </span>
      </div>;
    })}
  </div>;
}

export default function TimelineEditor({ project, onSave, busy, presets = [], onExport }) {
  const [clips, setClips] = useState(() => structuredClone(project.clips || []));
  const [look, setLook] = useState(() => structuredClone(project.look ?? null));
  const [baseRevision, setBaseRevision] = useState(project.revision);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [advanced, setAdvanced] = useState({});
  const [exportIntent, setExportIntent] = useState(false);
  useEffect(() => {
    if (!dirty) { setClips(structuredClone(project.clips || [])); setLook(structuredClone(project.look ?? null)); setBaseRevision(project.revision); }
  }, [project.revision, dirty]);
  const update = (index, key, value) => { setDirty(true); setClips(rows => rows.map((row, current) => current === index ? { ...row, [key]: value } : row)); };
  const updateGrading = (index, grading) => {
    setDirty(true);
    setClips(rows => rows.map((row, current) => {
      if (current !== index) return row;
      const next = { ...row };
      if (grading === null) delete next.grading; else next.grading = grading;
      return next;
    }));
  };
  const updateMotion = (index, motion) => {
    setDirty(true);
    setClips(rows => rows.map((row, current) => {
      if (current !== index) return row;
      const next = { ...row };
      if (!motion) delete next.motion; else next.motion = motion;
      return next;
    }));
  };
  const updateLut = (index, key, value) => {
    setDirty(true);
    setClips(rows => rows.map((row, current) => {
      if (current !== index) return row;
      const next = { ...row };
      const text = typeof value === 'string' ? value.trim() : '';
      if (!text) delete next[key]; else next[key] = text;
      return next;
    }));
  };
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
    setError(''); setNotice('');
    if (clips.some(clip => !Number.isFinite(Number(clip.start)) || Number(clip.start) < 0 || !Number.isFinite(Number(clip.duration)) || Number(clip.duration) <= 0)) {
      setError('每个片段需要有效的开始时间和正时长。'); return;
    }
    const updated = await onSave({ revision: baseRevision, clips, captions: project.captions || [], subtitleStyle: project.subtitleStyle, look });
    if (updated) {
      setDirty(false); setBaseRevision(updated.revision);
      if (exportIntent) { setExportIntent(false); setNotice(''); onExport?.(updated.revision); }
    }
  };
  const exportSaved = () => {
    setError('');
    if (dirty) { setExportIntent(true); setNotice('请先保存当前编排，导出只使用已保存的修订。'); return; }
    setNotice('');
    onExport?.(baseRevision);
  };
  return <section className="timeline-editor">
    <div className="section-toolbar"><div className="section-title"><Scissors size={16} /><h2>多轨时间线</h2><span className="count">{clips.length} 个片段 · {total.toFixed(2)}s</span></div><div className="button-row"><button className="button secondary" onClick={exportSaved}><ExternalLink size={14} />导出续剪工程</button><button className="button primary" disabled={!dirty || busy} onClick={save}><Check size={14} />保存编排</button></div></div>
    {notice && <p className="timeline-notice" role="status">{notice}</p>}
    {presets.length > 0 && <div className="project-look-bar"><Palette size={14} /><span>项目 look</span>
      <select aria-label="项目级调色 look" value={look?.preset || (hasGradeFields(look) ? CUSTOM_GRADE : '')} onChange={event => {
        setDirty(true);
        const value = event.target.value;
        if (value === CUSTOM_GRADE) return;
        setLook(value ? { ...(look || {}), preset: value } : null);
      }}>
        <option value="">不调色</option>
        {!look?.preset && hasGradeFields(look) && <option value={CUSTOM_GRADE} disabled>自定义调色</option>}
        {presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name} · {preset.description}</option>)}
      </select>
      <span className="muted">片段未单独调色时沿用项目 look</span>
    </div>}
    {project.revision !== baseRevision && dirty && <p className="inline-error" role="alert">项目已被其他操作更新。当前未保存编排仍保留；请重新打开时间线以使用最新版本。</p>}
    <div className="timeline-ruler"><span>0s</span><span>{(total / 2).toFixed(1)}s</span><span>{total.toFixed(1)}s</span></div>
    <div className="timeline-tracks">{[...new Set(clips.map(clip => Number(clip.track || 0)))].sort((a, b) => a - b).map(track => <div key={track} className="timeline-track"><span>轨 {track + 1}</span><div>{clips.map((clip, index) => Number(clip.track || 0) === track && <button key={clip.id || index} title={`${clip.path?.split(/[\\/]/).pop()} ${clip.start}s / ${clip.duration}s${clip.grading?.preset ? ` · ${clip.grading.preset}` : ''}`} style={{ left: `${Number(clip.start) / total * 100}%`, width: `${Number(clip.duration) / total * 100}%` }} onClick={() => document.getElementById(`clip-${index}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })}>{clip.kind === 'audio' ? <Volume2 size={12} /> : <Scissors size={12} />}<span>{clip.path?.split(/[\\/]/).pop()}</span></button>)}</div></div>)}</div>
    <label className="timeline-add">添加项目素材<select aria-label="添加时间线素材" defaultValue="" onChange={add}><option value="">选择素材…</option>{project.assets.map(asset => <option key={asset.id} value={asset.id}>{asset.name || asset.path.split(/[\\/]/).pop()} · {asset.kind}</option>)}</select></label>
    <div className="timeline-clip-list">{clips.map((clip, index) => <article key={clip.id || index} id={`clip-${index}`} className="timeline-clip-editor"><header><strong>{String(index + 1).padStart(2, '0')} · {clip.path?.split(/[\\/]/).pop()}</strong><button className="icon-button" aria-label={`删除片段 ${index + 1}`} onClick={() => { setClips(rows => rows.filter((_, current) => current !== index)); setDirty(true); }}><Trash2 size={15} /></button></header><div className="timeline-fields">{[['start', '开始 / 秒', 0, 3600], ['sourceIn', '素材入点 / 秒', 0, 3600], ['duration', '保留时长 / 秒', 0.01, 3600], ['speed', '变速倍数', 0.25, 4], ['volume', '音量倍数', 0, 4], ['track', '轨道序号', 0, 100]].map(([key, label, min, max]) => <label key={key}>{label}<input type="number" aria-label={`片段 ${index + 1} ${label}`} min={min} max={max} step={key === 'track' ? 1 : 0.05} value={clip[key] ?? (key === 'volume' || key === 'speed' ? 1 : 0)} onChange={event => update(index, key, Number(event.target.value))} /></label>)}</div>
      {clip.kind !== 'audio' && <div className="grading-controls"><label>数字运镜<select aria-label={`片段 ${index + 1} 数字运镜`} value={clip.motion?.type || ''} disabled={busy}
        onChange={event => updateMotion(index, event.target.value ? { type: event.target.value, amount: clip.motion?.amount ?? 0.12 } : null)}>
        <option value="">无运镜</option>
        <option value="zoom-in">推近 zoom-in</option><option value="zoom-out">拉远 zoom-out</option>
        <option value="pan-left">左摇 pan-left</option><option value="pan-right">右摇 pan-right</option>
        <option value="pan-up">上摇 pan-up</option><option value="pan-down">下摇 pan-down</option>
      </select></label>{clip.motion && <label>幅度<input type="number" aria-label={`片段 ${index + 1} 运镜幅度`} min={0} max={0.5} step={0.02} value={clip.motion.amount ?? 0.12}
        onChange={event => updateMotion(index, { ...clip.motion, amount: Number(event.target.value) })} /></label>}</div>}
      {clip.kind !== 'audio' && <GradingControls grading={clip.grading} look={look} presets={presets} disabled={busy} onChange={grading => updateGrading(index, grading)} />}
      {clip.kind !== 'audio' && <details className="lut-paths" open={Boolean(advanced[index])} onToggle={event => setAdvanced(current => ({ ...current, [index]: event.target.open }))}>
        <summary>高级：相机输入 LUT / 创意 LUT</summary>
        <div className="lut-fields">
          <label>相机输入 LUT（Log → 显示）<input type="text" aria-label={`片段 ${index + 1} 相机输入 LUT`} spellCheck={false} placeholder="D:\luts\camera-log.cube"
            value={clip.inputLut || ''} onChange={event => updateLut(index, 'inputLut', event.target.value)} /></label>
          <label>创意 LUT（风格）<input type="text" aria-label={`片段 ${index + 1} 创意 LUT`} spellCheck={false} placeholder="D:\luts\creative-look.cube"
            value={clip.lut || ''} onChange={event => updateLut(index, 'lut', event.target.value)} /></label>
        </div>
        <p className="muted">输入 LUT 用于相机 Log 还原，创意 LUT 叠加风格；两者都是本地 .cube 文件，保存时由服务端校验，预设调色不能替代 Log 还原。</p>
      </details>}
    </article>)}</div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <p className="muted timeline-note">保存保留原素材与历史剪辑。修改镜头后请重新生成字幕，再渲染检查成片；调色可先用「制作流程 → AI 调色迭代」生成对比预览。导出只使用已保存的修订。</p>
  </section>;
}
