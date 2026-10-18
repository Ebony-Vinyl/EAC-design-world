import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowDownToLine, ArrowRight, AudioLines, Captions, Check, CheckCheck,
  CircleAlert, CircleCheck, CircleHelp, Clapperboard,
  Clock3, ExternalLink, FileImage, FileText, FileVideo, Film, Folder, FolderOpen, Grid2X2,
  Layers3, ListVideo, LoaderCircle, Maximize2, Monitor,
  Palette, Play, Plus, Radio, RefreshCw, Scissors, Search, Settings2, SlidersHorizontal,
  Sparkles, Square, WandSparkles, Workflow, Wrench, X,
} from 'lucide-react';
import { api, fileUrl, jobNames, outputPaths, resultWarnings, statusNames } from './api';
import { kindLabel, localTemplates, resolveDesignSystems, resolveTemplates, sourceLabel } from './templates';
import DesignWorkspace, { DesignCanvas } from './DesignWorkspace';
import TimelineEditor from './TimelineEditor';
import TemplatePickerGallery from './TemplatePickerGallery';
import { TemplateDetail } from './TemplatePreview';
import MaintenancePanel from './MaintenancePanel';
import Dialog from './Dialog';
import './styles.css';
import './polish.css';

const initialForm = { title: '', brief: '', templateId: '01-flat-vector', width: 1920, height: 1080, fps: 30 };
const isActive = job => ['running', 'queued'].includes(job.status);
const videoPattern = /\.(mp4|webm|mov|m4v)(?:\?|$)/i;
const audioPattern = /\.(wav|mp3|m4a|ogg|flac|aac)(?:\?|$)/i;
const subtitlePattern = /\.srt(?:\?|$)/i;
const imagePattern = /\.(png|jpe?g|webp|gif|avif|svg)(?:\?|$)/i;
const displayDate = date => date ? new Date(date).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) : '';
const hasAudio = asset => asset.kind === 'audio' || (asset.kind === 'video'
  && (asset.probe?.streams?.some(stream => stream.codec_type === 'audio') ?? false));
const productionCapabilities = new Set(['ffmpeg', 'browser', 'desktop', 'voice', 'music', 'transcription', 'captions', 'semantic-review']);
const editableSettings = settings => ({ outputRoot: settings.outputRoot || '', ttsVoice: settings.ttsVoice || '', quality: settings.quality || 'draft' });
const pickerIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const pickerQuery = new URLSearchParams(window.location.search);
const pickerPage = pickerQuery.get('view') === 'templates';
const canvasPage = pickerQuery.get('view') === 'canvas';
const designPage = pickerQuery.get('view') === 'design';
const maintenancePage = pickerQuery.get('view') === 'maintenance';
const pickerMode = ['normal', 'edit', 'design'].includes(pickerQuery.get('mode')) ? pickerQuery.get('mode') : 'edit';
const pickerKind = pickerQuery.get('kind') || 'website';
const canvasSessionId = pickerQuery.get('sessionId') || '';
const canvasMode = pickerQuery.get('mode') === 'edit' ? 'edit' : 'design';
const pickerInitialPresentation = pickerQuery.get('layout') === 'inline' ? 'inline' : 'dialog';
const pickerInitialTemplateId = pickerIdPattern.test(pickerQuery.get('selected') || '') ? pickerQuery.get('selected') : '';
const designKinds = ['website', 'motion', 'deck', 'document', 'image'];
function pickerTargetOrigin() {
  try { return document.referrer ? new URL(document.referrer).origin : '*'; } catch { return '*'; }
}
function pickerPost(message) {
  try { window.parent?.postMessage(message, pickerTargetOrigin()); } catch { /* No host frame available. */ }
}
function isTrustedPickerMessage(event) {
  if (!event || event.source !== window.parent) return false;
  try {
    if (document.referrer) return event.origin === new URL(document.referrer).origin;
  } catch { return true; }
  return true;
}
function parsePickerState(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.type !== 'eac:picker-state') return null;
  const presentation = data.presentation === 'inline' || data.presentation === 'dialog' ? data.presentation : null;
  const mode = ['normal', 'edit', 'design'].includes(data.mode) ? data.mode : null;
  const kind = designKinds.includes(data.kind) ? data.kind : null;
  let templateId = null;
  if (Object.hasOwn(data, 'templateId') && typeof data.templateId === 'string') {
    if (data.templateId === '') templateId = '';
    else if (pickerIdPattern.test(data.templateId)) templateId = data.templateId;
  }
  const designSystemId = typeof data.designSystemId === 'string' && (data.designSystemId === '' || pickerIdPattern.test(data.designSystemId)) ? data.designSystemId : null;
  return { templateId, designSystemId, presentation, mode, kind };
}

function IconButton({ icon: Icon, label, className = '', ...props }) {
  return <button type="button" className={`icon-button ${className}`} title={label} aria-label={label} {...props}><Icon size={17} /></button>;
}

function Button({ icon: Icon, children, variant = 'secondary', className = '', busy, ...props }) {
  return <button className={`button ${variant} ${className}`} disabled={busy || props.disabled} {...props}>
    {busy ? <LoaderCircle size={15} className="spin" /> : Icon && <Icon size={15} />}
    {children}
  </button>;
}

function Status({ status }) {
  return <span className={`status ${status}`}><span className="status-dot" />{statusNames[status] || status}</span>;
}

function Thumbnail({ template, className = '' }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [template?.thumbnail]);
  return template?.thumbnail && !failed
    ? <img className={`template-image ${className}`} src={template.thumbnail} alt={template.name} loading="lazy" onError={() => setFailed(true)} />
    : <div className={`template-placeholder ${className}`}><Monitor size={30} strokeWidth={1.25} /><span>{template?.name || '选择视觉模板'}</span><small>产品界面动效</small></div>;
}

function Empty({ icon: Icon = Layers3, title, description, action }) {
  return <div className="empty"><Icon size={27} strokeWidth={1.4} /><strong>{title}</strong>{description && <p>{description}</p>}{action}</div>;
}

function TemplateGallery({ templates, selectedId, onSelect, compact = false, inline = false, onBrowseAll, designSystems = [], mode = 'edit', kind = 'website', selectedSystemId = '', onSelectSystem, onKindChange, onImportShots }) {
  const [detail, setDetail] = useState(null);
  return <>
    <TemplatePickerGallery templates={templates} selectedId={selectedId} onSelect={onSelect} inline={inline}
      onBrowseAll={onBrowseAll} designSystems={designSystems} mode={mode} kind={kind} selectedSystemId={selectedSystemId}
      onSelectSystem={onSelectSystem} onKindChange={onKindChange} onPreview={setDetail} previewOpen={Boolean(detail)} onImportShots={onImportShots} />
    {detail && <TemplateDetail template={detail} selectedId={selectedId} onClose={() => setDetail(null)} onSelect={template => { onSelect(template); setDetail(null); }} />}
  </>;
}

function PickerView({ templates, designSystems, selectedId, connected, onSelect, onBrowseAll, onState, mode, kind, onKindChange, selectedSystemId, onSelectSystem }) {
  const [presentation, setPresentation] = useState(pickerInitialPresentation);
  const [notice, setNotice] = useState('');
  const shell = useRef(null);
  const noticeTimer = useRef(0);
  const select = template => {
    setNotice(selectedId === template.id ? `已取消「${template.name}」` : `已选择「${template.name}」`);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(''), 6000);
    onSelect(template);
  };
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);
  useEffect(() => {
    const receive = event => {
      if (!isTrustedPickerMessage(event)) return;
      const state = parsePickerState(event.data);
      if (!state) return;
      if (state.presentation) setPresentation(state.presentation);
      onState?.(state);
    };
    window.addEventListener('message', receive);
    pickerPost({ type: 'eac:picker-ready' });
    return () => window.removeEventListener('message', receive);
  }, []);
  useEffect(() => {
    if (presentation !== 'inline') return;
    const element = shell.current;
    if (!element || typeof ResizeObserver !== 'function') return;
    let last = 0;
    const send = () => {
      const height = Math.ceil(element.getBoundingClientRect().height);
      if (height === last) return;
      last = height;
      pickerPost({ type: 'eac:picker-height', height });
    };
    const observer = new ResizeObserver(send);
    observer.observe(element);
    send();
    return () => observer.disconnect();
  }, [presentation]);
  useEffect(() => {
    const onKeyDown = event => {
      if (event.key !== 'Escape') return;
      if (event.defaultPrevented) return;
      event.preventDefault();
      pickerPost({ type: 'eac:close-picker' });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  const inline = presentation === 'inline';
  const design = mode === 'design';
  const count = design ? designSystems.length + templates.length : templates.length;
  return <main ref={shell} className={`picker-shell ${inline ? 'inline-picker inline-bounded' : ''} ${window.parent !== window && !inline ? 'embedded-picker' : ''}`} data-presentation={presentation}>
    <header className="picker-header"><Brand /><span className="picker-title">{design ? '设计库' : '选择视觉模板'}</span>{!inline && <span className="tag">{count} {design ? 'ITEMS' : 'STYLES'}</span>}</header>
    <div className="picker-body" style={inline ? { display: 'flex', flex: '1 1 0%', minHeight: 0, overflow: 'hidden' } : undefined}><TemplateGallery templates={templates} selectedId={selectedId} onSelect={select} compact inline={inline} onBrowseAll={onBrowseAll} designSystems={designSystems} mode={mode} kind={kind} onKindChange={onKindChange} selectedSystemId={selectedSystemId} onSelectSystem={onSelectSystem} /></div>
    {!inline && <footer className="picker-footer"><span><span className={`availability ${connected ? 'available' : ''}`} />{connected ? '模板库已同步' : '本地模板目录'}</span><span role="status">{notice || 'DeepSeek Harness'}</span></footer>}
  </main>;
}

function ProjectForm({ form, setForm, templates, onSubmit, busy, onTemplateChange, existing = false }) {
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const ratio = form.width === 1080 && form.height === 1920 ? 'portrait' : form.width === 1080 && form.height === 1080 ? 'square' : form.width === 1920 && form.height === 1080 ? 'landscape' : 'custom';
  const dimensions = { landscape: [1920, 1080], portrait: [1080, 1920], square: [1080, 1080] };
  return <form className="project-form" onSubmit={onSubmit}>
    <label>项目名称<input required maxLength={120} placeholder="为这支作品取个名字" value={form.title} onChange={event => set('title', event.target.value)} /></label>
    <label>制作简报<textarea required rows={5} maxLength={20000} placeholder="这支片子要讲什么？描述产品、受众、核心信息和期望的视觉节奏…" value={form.brief} onChange={event => set('brief', event.target.value)} /></label>
    <label>视觉模板<select aria-label="视觉模板" value={form.templateId} onChange={event => { set('templateId', event.target.value); onTemplateChange?.(event.target.value); }}>{templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>
    <fieldset><legend>画面比例</legend><div className="ratio-control">{[['landscape', Monitor, '16:9'], ['portrait', FileVideo, '9:16'], ['square', Square, '1:1']].map(([id, Icon, text]) => <button type="button" className={ratio === id ? 'selected' : ''} key={id} onClick={() => setForm(current => ({ ...current, width: dimensions[id][0], height: dimensions[id][1] }))}><Icon size={16} />{text}</button>)}</div></fieldset>
    <div className="form-row three"><label>宽度<input type="number" min={160} max={7680} step={2} required value={form.width} onChange={event => set('width', Number(event.target.value))} /></label><label>高度<input type="number" min={90} max={7680} step={2} required value={form.height} onChange={event => set('height', Number(event.target.value))} /></label><label>帧率<select aria-label="帧率" value={form.fps} onChange={event => set('fps', Number(event.target.value))}>{[24, 25, 30, 50, 60].map(fps => <option key={fps} value={fps}>{fps} fps</option>)}</select></label></div>
    <Button variant="primary" icon={Plus} busy={busy} type="submit" className="full-width">{existing ? '以此简报新建项目' : '创建项目'}</Button>
  </form>;
}

function Warnings({ messages = [] }) {
  return messages.length > 0 && <div className="result-warnings" role="status">{[...new Set(messages)].map(message => <p key={message}><CircleAlert size={13} /><span>{message}</span></p>)}</div>;
}

function SubtitlePreview({ path, onClose }) {
  const [state, setState] = useState({ loading: true, text: '', error: '' });
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timeout = setTimeout(() => controller.abort(), 20000);
    setState({ loading: true, text: '', error: '' });
    (async () => {
      try {
        const response = await fetch(fileUrl(path), { signal: controller.signal });
        if (!response.ok) throw new Error(`字幕读取失败（${response.status}）`);
        const text = await response.text();
        if (active && !controller.signal.aborted) setState({ loading: false, text, error: '' });
      } catch (error) {
        if (active) setState({ loading: false, text: '', error: error.name === 'AbortError' ? '字幕读取超时，请重试。' : error.message });
      } finally { clearTimeout(timeout); }
    })();
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [path]);
  return <Dialog title="SRT 字幕" className="subtitle-dialog" onClose={onClose}>
    <div className="subtitle-body">{state.loading ? <span className="subtitle-loading" role="status"><LoaderCircle size={16} className="spin" />读取字幕…</span>
      : state.error ? <p className="inline-error" role="alert">{state.error}</p>
        : state.text ? <pre className="subtitle-text">{state.text}</pre> : <p className="muted">未识别到语音，SRT 文件为空。</p>}</div>
    <footer className="dialog-footer"><span className="file-path">{path}</span><a className="button secondary" href={fileUrl(path)} download={path.split(/[\\/]/).pop()}><ArrowDownToLine size={15} />下载 SRT</a></footer>
  </Dialog>;
}

function TranscriptOutput({ transcript }) {
  const [preview, setPreview] = useState(false);
  return transcript?.srtPath && <div className="transcript-output">
    <div className="transcript-toolbar"><span className="muted">{transcript.language?.toUpperCase()} · {transcript.segments?.length ?? 0} 段字幕</span><Button icon={FileText} onClick={() => setPreview(true)}>查看 SRT</Button><a className="output-link" href={fileUrl(transcript.srtPath)} download={transcript.srtPath.split(/[\\/]/).pop()}><ArrowDownToLine size={12} />SRT</a>{transcript.jsonPath && <a className="output-link" href={fileUrl(transcript.jsonPath)} download={transcript.jsonPath.split(/[\\/]/).pop()}><ArrowDownToLine size={12} />JSON</a>}</div>
    {preview && <SubtitlePreview path={transcript.srtPath} onClose={() => setPreview(false)} />}
  </div>;
}

function TimelineCaptions({ project }) {
  const captions = project?.captions || [];
  return <div className="timeline-caption-output">
    <p className="caption-count" role="status">时间线字幕：{captions.length} 段</p>
    {captions.length > 0 && <details><summary>查看时间线字幕</summary><ol>{captions.map((caption, index) => <li key={index}><time>{Number(caption.start).toFixed(2)}–{Number(caption.end).toFixed(2)}s</time><span>{caption.text}</span></li>)}</ol></details>}
  </div>;
}

function JobList({ jobs, onCancel, busy, projects, minimal = false }) {
  return jobs.length ? <div className={`job-list ${minimal ? 'minimal' : ''}`}>{jobs.map(job => <article className="job-row" key={job.id}>
    <div className={`job-symbol ${job.status}`}>{job.status === 'running' ? <LoaderCircle size={18} className="spin" /> : job.status === 'failed' ? <CircleAlert size={18} /> : job.status === 'completed' ? <CheckCheck size={18} /> : <Film size={18} />}</div>
    <div className="job-info"><strong>{jobNames[job.type] || job.type}</strong><span>{projects.find(project => project.id === job.projectId)?.title || job.projectId || job.id}</span>{job.error && <p className="inline-error">{typeof job.error === 'string' ? job.error : JSON.stringify(job.error)}</p>}
      {job.stage && <span className="job-stage">{job.stage}</span>}
      {job.status === 'running' && job.progress != null && Number.isFinite(Number(job.progress)) && <div className="progress-line"><progress max="1" value={Math.max(0, Math.min(1, Number(job.progress)))} /><span>{(Number(job.progress) * 100).toFixed(0)}%</span></div>}
      <Warnings messages={resultWarnings(job.result)} />
      {job.status === 'completed' && <><TranscriptOutput transcript={job.result} />{outputPaths(job.result).filter(path => path !== job.result?.srtPath && path !== job.result?.jsonPath).map(path => <a className="output-link" href={fileUrl(path)} key={path} target="_blank" rel="noreferrer"><ArrowDownToLine size={12} />{path.split(/[\\/]/).pop()}</a>)}</>}
      {job.type === 'beats' && job.status === 'completed' && <span>{job.result?.bpm ? `${job.result.bpm} BPM · ${job.result.beats?.length ?? 0} 个节拍` : '未检测到稳定节拍'}</span>}
      {job.type === 'captions' && job.status === 'completed' && <span>已生成 {job.result?.count ?? job.result?.captions?.length ?? 0} 段时间线字幕</span>}
    </div><Status status={job.status} />{isActive(job) && <IconButton icon={X} label="取消任务" disabled={busy === `cancel-${job.id}`} onClick={() => onCancel(job.id)} />}
  </article>)}</div> : <Empty icon={ListVideo} title="暂无制作任务" description="提交渲染、录制或旁白任务后，进度将在这里更新。" />;
}

function Preview({ project, template, onPreviewTemplate }) {
  const stage = useRef(null);
  const [mediaError, setMediaError] = useState(false);
  const [mode, setMode] = useState('output');
  const output = project?.lastOutput?.path;
  const showOutput = mode === 'output' && Boolean(output);
  useEffect(() => { setMediaError(false); }, [output]);
  useEffect(() => { setMode('output'); }, [project?.id, output]);
  return <section className="preview-section">
    <div className="section-toolbar"><div className="section-title"><Monitor size={15} /><h2>画面预览</h2></div>
      {output && <div className="segmented" role="group" aria-label="预览内容"><button className={mode === 'output' ? 'selected' : ''} aria-pressed={mode === 'output'} onClick={() => setMode('output')}>项目成片</button><button className={mode === 'template' ? 'selected' : ''} aria-pressed={mode === 'template'} onClick={() => setMode('template')}>所选模板</button></div>}
      <IconButton icon={Maximize2} label="全屏预览" onClick={() => stage.current?.requestFullscreen?.().catch(() => {})} /></div>
    <div ref={stage} className="preview-stage">
      {showOutput ? <video key={output} src={fileUrl(output)} aria-label={`${project.title} 项目成片`} controls playsInline preload="metadata" onError={() => setMediaError(true)} />
        : <><Thumbnail template={template} /><button className="play-preview" title="预览所选模板" aria-label="预览所选模板" onClick={onPreviewTemplate}><Play size={20} fill="currentColor" /></button><span className="stage-label">模板参考 · {template.name}</span></>}
      {showOutput && mediaError && <div className="media-error" role="alert"><CircleAlert size={15} />成片暂不可播放，可在素材与输出中查看文件。</div>}
    </div>
    <div className="preview-footer"><div><span className="tiny-dot" /><span>{showOutput ? '项目成片' : '所选模板'}</span><span className="divider-text">/</span><span className="muted">{showOutput ? project.title : template.name}</span></div><span className="mono">{showOutput ? `${project.width} × ${project.height}` : template.source}</span></div>
  </section>;
}

function ClipStrip({ project, onPlan, busy }) {
  return <section className="sequence-section"><div className="section-toolbar"><div className="section-title"><Layers3 size={15} /><h2>镜头编排</h2><span className="count">{project?.clips?.length || 0}</span></div><Button icon={WandSparkles} variant="ghost" busy={busy} disabled={!project || !project.assets?.some(asset => asset.kind !== 'audio')} onClick={onPlan}>编排素材</Button></div>
    {project?.clips?.length ? <div className="clip-strip">{project.clips.map((clip, index) => <div className="clip" key={clip.id || index}><span className="mono">{String(index + 1).padStart(2, '0')}</span><strong>{clip.title || clip.name || clip.path?.split(/[\\/]/).pop() || `镜头 ${index + 1}`}</strong><p>{clip.description || clip.text || clip.narration || ''}</p>{(clip.duration ?? clip.end) !== undefined && <small>{clip.duration !== undefined ? `${Number(clip.duration).toFixed(2).replace(/\.?0+$/, '')}s` : `${clip.start ?? 0}–${clip.end}s`}</small>}</div>)}</div> : <div className="sequence-empty"><span className="sequence-track"><span /><span /><span /><span /><span /></span><span>{project?.assets?.some(asset => asset.kind !== 'audio') ? '按素材时长与节拍编排实际画面' : project ? '导入视频或图片后开始编排' : '创建项目并导入素材后开始编排'}</span></div>}
    {project?.plan?.warning && <p className="plan-warning"><CircleAlert size={13} />{project.plan.warning}</p>}
  </section>;
}

function SettingsView({ settings, capabilities, onSave, busy, connected }) {
  const [draft, setDraft] = useState(() => editableSettings(settings));
  const [dirty, setDirty] = useState(false);
  const [section, setSection] = useState('production');
  useEffect(() => { if (!dirty) setDraft(editableSettings(settings)); }, [settings, dirty]);
  const set = (key, value) => { setDraft(current => ({ ...current, [key]: value })); setDirty(true); };
  const sections = [['production', Folder, '输出与制作'], ['capabilities', Radio, '服务能力']];
  return <div className="settings-workspace">
    <nav className="settings-subnav" aria-label="设置分区">{sections.map(([id, Icon, label]) => <button key={id} className={section === id ? 'active' : ''} onClick={() => setSection(id)}><Icon size={15} />{label}</button>)}</nav>
    <div className="settings-pane">
      {section === 'production' && <form className="settings-form" onSubmit={async event => { event.preventDefault(); if (await onSave(draft)) setDirty(false); }}>
        <div className="section-heading"><Folder size={19} /><div><h2>输出与制作</h2><p>项目文件位置与默认制作规格</p></div></div>
        <label>输出目录<input required value={draft.outputRoot || ''} placeholder="D:\EAC design world\output" onChange={event => set('outputRoot', event.target.value)} /></label>
        <div className="form-row"><label>旁白声音<input value={draft.ttsVoice || ''} placeholder="输入服务支持的 voice ID" onChange={event => set('ttsVoice', event.target.value)} /></label><label>默认画质<select aria-label="默认画质" value={draft.quality || 'draft'} onChange={event => set('quality', event.target.value)}><option value="draft">草稿 · Draft</option><option value="production">正式 · Production</option></select></label></div>
        <div className="settings-actions"><span className="muted">{dirty ? '有未保存的更改' : '配置与服务保持同步'}</span><Button icon={Check} variant="primary" busy={busy} disabled={!connected || !dirty} type="submit">保存设置</Button></div>
      </form>}
      {section === 'capabilities' && <div className="settings-capabilities">
        <div className="section-heading"><Radio size={19} /><div><h2>服务能力</h2><p>本地服务检测到的实际可用能力</p></div></div>
        <CapabilityList capabilities={capabilities} connected={connected} />
        <div className="connection-note"><CircleHelp size={16} /><p>可用状态由本地服务检测并返回。配置保存后，下一次检测会更新连接状态。</p></div>
      </div>}
    </div>
  </div>;
}

function CapabilityList({ capabilities, connected }) {
  if (!connected || !capabilities.length) return <div className="capability-empty"><span className="status-dot" />{connected ? '尚未返回服务能力' : '等待 API 连接'}</div>;
  return <div className="capabilities">{capabilities.map(capability => <div className="capability" key={capability.id}><div><span className={`availability ${capability.available ? 'available' : ''}`} /><strong>{capability.name}</strong><span>{capability.available ? '可用' : '不可用'}</span></div>{capability.detail && <p>{capability.detail}</p>}</div>)}</div>;
}

function WorkflowView({ project, busy, onJob, onPlan, jobs, capabilities, connected, template }) {
  const [url, setUrl] = useState('');
  const [actions, setActions] = useState('');
  const [duration, setDuration] = useState(15);
  const [bpm, setBpm] = useState(120);
  const [voiceText, setVoiceText] = useState('');
  const [assetId, setAssetId] = useState('');
  const [speechAssetId, setSpeechAssetId] = useState('');
  const [language, setLanguage] = useState('');
  const [musicPath, setMusicPath] = useState('');
  const [followMusic, setFollowMusic] = useState(true);
  const [error, setError] = useState('');
  const captureParams = () => {
    const parsed = actions.trim() ? JSON.parse(actions) : undefined;
    if (parsed !== undefined && !Array.isArray(parsed)) throw new Error('操作 JSON 必须是数组。');
    if (url.trim()) {
      const parsedUrl = new URL(url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('请输入 HTTP 或 HTTPS 网页地址。');
    }
    return { ...(url.trim() ? { url: url.trim() } : {}), ...(parsed ? { actions: parsed } : {}) };
  };
  const record = event => {
    event.preventDefault();
    try {
      const params = captureParams();
      if (!params.url) throw new Error('请填写需要录制的网页地址。');
      setError('');
      onJob('record-browser', { ...params, duration: Number(duration) });
    } catch (err) { setError(err instanceof SyntaxError ? '操作 JSON 格式有误，请检查语法。' : err.message); }
  };
  const produce = () => {
    try {
      const params = captureParams();
      if (!params.url && !project?.assets?.some(asset => asset.kind !== 'audio')) throw new Error('请填写录制地址，或先导入视频或图片。');
      if (!(Number(duration) >= 1 && Number(duration) <= 600) || (!(musicPath.trim() && followMusic) && !(Number(bpm) >= 30 && Number(bpm) <= 240))) throw new Error('时长须为 1–600 秒，节拍须为 30–240 BPM。');
      setError('');
      onJob('produce', { ...params, narration: voiceText, duration: Number(duration), ...(musicPath.trim() && followMusic ? {} : { bpm: Number(bpm) }), ...(musicPath.trim() ? { musicPath: musicPath.trim() } : {}) });
    } catch (err) { setError(err instanceof SyntaxError ? '操作 JSON 格式有误，请检查语法。' : err.message); }
  };
  const analysisAssetId = project?.assets?.some(asset => asset.id === assetId) ? assetId : project?.assets?.[0]?.id || '';
  const analysisAsset = project?.assets?.find(asset => asset.id === analysisAssetId);
  const speechAssets = (project?.assets || []).filter(hasAudio);
  const speechAsset = speechAssets.find(asset => asset.id === speechAssetId) || speechAssets[0];
  const transcription = capabilities.find(capability => capability.id === 'transcription');
  const speechJob = jobs.find(job => isActive(job) && ['transcribe', 'rough-cut'].includes(job.type) && job.params?.assetId === speechAsset?.id);
  const captionJob = jobs.find(job => isActive(job) && job.type === 'captions');
  const speechDisabled = !speechAsset || !connected || Boolean(busy) || Boolean(speechJob) || Boolean(captionJob) || transcription?.available === false;
  const latestSpeechJob = jobs.find(job => ['transcribe', 'rough-cut'].includes(job.type) && job.params?.assetId === speechAsset?.id);
  const latestCaptionJob = jobs.find(job => job.type === 'captions' && job.params?.assetId === speechAsset?.id);
  const captionDisabled = !connected || Boolean(busy) || Boolean(speechJob) || Boolean(captionJob)
    || !speechAsset?.transcript?.segments?.length || !project?.clips?.some(clip => clip.assetId === speechAsset?.id);
  return <div className="workflow-layout"><div className="workflow-main">
    {!project && <div className="inline-notice"><CircleAlert size={16} />先创建或选择项目，再开始制作。</div>}
    <div className="production-command"><div><Sparkles size={18} /><div><h2>一键制作</h2><p>录制 / 导入 → 编排 → 旁白 → 配乐 → 渲染</p></div></div><Button icon={Play} variant="primary" busy={busy === 'produce'} disabled={!project || !connected || Boolean(busy)} onClick={produce}>开始完整制作</Button></div>
    {error && <p className="inline-error workflow-error" role="alert">{error}</p>}
    <section className="workflow-step"><div className="step-heading"><span>01</span><div><h2>录制产品界面</h2><p>导入真实网页交互，作为制作素材</p></div><Monitor size={20} /></div><form onSubmit={record}><label>网页地址<input type="url" required placeholder="https://your-product.com" value={url} onChange={event => setUrl(event.target.value)} /></label><label>交互操作 <span className="muted">可选 · JSON 数组</span><textarea rows={3} className="mono" placeholder='[{"type":"click","selector":"#start"}]' value={actions} onChange={event => setActions(event.target.value)} /></label>{error && <p className="inline-error">{error}</p>}<Button icon={Radio} disabled={!project} busy={busy === 'record-browser'} type="submit">开始录制</Button></form></section>
    <section className="workflow-step"><div className="step-heading"><span>02</span><div><h2>编排镜头与节拍</h2><p>按素材时长与节拍编排实际画面</p></div><Layers3 size={20} /></div><form onSubmit={event => { event.preventDefault(); onPlan({ duration: Number(duration), bpm: Number(bpm) }); }}><div className="form-row"><label>目标时长 / 秒<input type="number" min={1} max={600} required value={duration} onChange={event => setDuration(event.target.value)} /></label><label>节拍 / BPM<input type="number" min={30} max={240} required value={bpm} onChange={event => setBpm(event.target.value)} /></label></div><Button icon={WandSparkles} busy={busy === 'plan'} disabled={!project || !project.assets?.some(asset => asset.kind !== 'audio')} type="submit">生成制作计划</Button></form></section>
    <Warnings messages={resultWarnings(project?.plan)} />
    <section className="workflow-step"><div className="step-heading"><span>03</span><div><h2>口播转录与初剪</h2></div><Scissors size={20} /></div>
      <div className="speech-controls"><label>口播素材<select aria-label="口播素材" value={speechAsset?.id || ''} disabled={!speechAssets.length} onChange={event => setSpeechAssetId(event.target.value)}>{speechAssets.length ? speechAssets.map(asset => <option key={asset.id} value={asset.id}>{asset.name || asset.path?.split(/[\\/]/).pop() || asset.id}</option>) : <option value="">暂无含音轨素材</option>}</select></label><label>语音语言<select aria-label="语音语言" value={language} onChange={event => setLanguage(event.target.value)}><option value="">自动识别</option><option value="zh">中文</option><option value="en">英语</option><option value="ja">日语</option><option value="ko">韩语</option><option value="fr">法语</option><option value="de">德语</option><option value="es">西班牙语</option></select></label></div>
      <div className="button-row"><Button icon={FileText} busy={busy === 'transcribe'} disabled={speechDisabled} title={transcription?.available === false ? transcription.detail : undefined} onClick={() => onJob('transcribe', { assetId: speechAsset.id, ...(language ? { language } : {}) })}>转录字幕</Button><Button icon={Scissors} busy={busy === 'rough-cut'} disabled={speechDisabled || speechAsset?.kind !== 'video'} title={speechAsset?.kind !== 'video' ? '口播初剪需要含音轨的视频' : '按语音保留片段替换当前镜头编排，完成后请复核'} onClick={() => onJob('rough-cut', { assetId: speechAsset.id, ...(language ? { language } : {}) })}>生成口播初剪</Button><Button icon={Captions} busy={busy === 'captions' || Boolean(captionJob)} disabled={captionDisabled} onClick={() => onJob('captions', { assetId: speechAsset.id })}>生成时间线字幕</Button>{(speechJob || captionJob) && <Status status={(speechJob || captionJob).status} />}</div>
      {latestSpeechJob?.error && <p className="inline-error" role="alert">{latestSpeechJob.error}</p>}
      <TranscriptOutput transcript={speechAsset?.transcript} />
      {latestCaptionJob?.error && <p className="inline-error" role="alert">{latestCaptionJob.error}</p>}
      <TimelineCaptions project={project} />
      <Warnings messages={resultWarnings(latestSpeechJob?.result)} />
      <Warnings messages={resultWarnings(latestCaptionJob?.result)} />
    </section>
    <section className="workflow-step"><div className="step-heading"><span>04</span><div><h2>旁白与素材分析</h2><p>为镜头准备音轨和素材信息</p></div><AudioLines size={20} /></div><form onSubmit={event => { event.preventDefault(); onJob('voice', { text: voiceText }); }}><label>旁白文案<textarea required rows={3} placeholder="输入需要生成的旁白内容…" value={voiceText} onChange={event => setVoiceText(event.target.value)} /></label><div className="button-row"><Button icon={AudioLines} busy={busy === 'voice'} disabled={!project} type="submit">生成旁白</Button></div></form><div className="analysis-controls"><label>分析素材<select aria-label="分析素材" value={analysisAssetId} onChange={event => setAssetId(event.target.value)} disabled={!project?.assets?.length}>{project?.assets?.length ? project.assets.map(asset => <option key={asset.id} value={asset.id}>{asset.name || asset.path?.split(/[\\/]/).pop() || asset.id}</option>) : <option value="">暂无项目素材</option>}</select></label><div className="button-row"><Button type="button" icon={Search} busy={busy === 'analyze'} disabled={!analysisAssetId || !connected || Boolean(busy)} onClick={() => onJob('analyze', { assetId: analysisAssetId })}>分析素材</Button><Button type="button" icon={AudioLines} busy={busy === 'beats'} disabled={!analysisAsset || !hasAudio(analysisAsset) || !connected || Boolean(busy)} onClick={() => onJob('beats', { assetId: analysisAssetId })}>分析节拍</Button></div></div>
      {analysisAsset?.beats && <p className="beat-result" role="status">{analysisAsset.beats.bpm ? `${analysisAsset.beats.bpm} BPM · ${analysisAsset.beats.beats?.length ?? 0} 个节拍` : '未检测到稳定节拍'}</p>}
    </section>
    <section className="workflow-step"><div className="step-heading"><span>05</span><div><h2>配乐与渲染</h2></div><Film size={20} /></div><div className="music-controls"><label>用户配乐路径 <span className="muted">可选</span><input value={musicPath} placeholder="D:\assets\music.wav" onChange={event => setMusicPath(event.target.value)} /></label>{musicPath.trim() && <label className="checkbox-label"><input type="checkbox" checked={followMusic} onChange={event => setFollowMusic(event.target.checked)} />一键制作跟随配乐节拍</label>}</div><div className="button-row"><Button icon={AudioLines} busy={busy === 'compose'} disabled={!project || !duration || !bpm} onClick={() => onJob('compose', { duration: Number(duration), bpm: Number(bpm) })}>生成原创配乐</Button><Button icon={Play} variant="primary" busy={busy === 'render'} disabled={!project} onClick={() => onJob('render')}>渲染项目</Button><Button icon={Clapperboard} busy={busy === 'render-template'} disabled={!project || !template || template.renderable === false} title={template?.renderable === false ? '此镜头需定制源码；可先从选片单导入视频素材' : undefined} onClick={() => onJob('render-template')}>渲染所选模板</Button></div><Warnings messages={resultWarnings(project?.lastOutput)} /></section>
  </div><aside className="capability-panel"><div className="section-title"><Radio size={16} /><h2>制作环境</h2></div><CapabilityList capabilities={capabilities} connected={connected} /></aside></div>;
}

function AssetsView({ project, jobs, onImport, busy }) {
  const [path, setPath] = useState('');
  const outputs = jobs.filter(job => job.projectId === project?.id && job.status === 'completed').flatMap(job => outputPaths(job.result)).filter((item, index, list) => list.indexOf(item) === index);
  const [preview, setPreview] = useState(null);
  const assets = project?.assets || [];
  return <div className="assets-view"><form className="import-form" onSubmit={async event => { event.preventDefault(); if (await onImport(path)) setPath(''); }}><label>从本地路径导入素材<div className="import-input"><FolderOpen size={17} /><input required value={path} placeholder="D:\assets\product-demo.mp4" onChange={event => setPath(event.target.value)} /><Button type="submit" icon={Plus} variant="primary" busy={busy} disabled={!project}>导入素材</Button></div></label></form>
    <div className="section-toolbar"><div className="section-title"><FolderOpen size={16} /><h2>项目素材</h2><span className="count">{assets.length}</span></div></div>
    {assets.length ? <div className="file-list">{assets.map((asset, index) => { const assetPath = typeof asset === 'string' ? asset : asset.path || asset.filePath; return <FileRow key={asset.id || assetPath || index} path={assetPath} name={asset.name} onPreview={setPreview} />; })}</div> : <Empty icon={FileImage} title="素材库等待你的第一份素材" description={project ? '导入视频、图片或音频的本地文件路径。' : '创建项目后即可导入素材。'} />}
    <div className="section-toolbar separated"><div className="section-title"><Film size={16} /><h2>制作输出</h2><span className="count">{outputs.length}</span></div></div>
    {outputs.length ? <div className="file-list">{outputs.map(item => <FileRow key={item} path={item} onPreview={setPreview} />)}</div> : <Empty icon={Film} title="尚无输出文件" description="任务完成后，实际输出文件将显示在这里。" />}
    {preview && (subtitlePattern.test(preview) ? <SubtitlePreview path={preview} onClose={() => setPreview(null)} /> : <Dialog title={preview.split(/[\\/]/).pop()} onClose={() => setPreview(null)} className="media-dialog"><div className="file-preview">{videoPattern.test(preview) ? <video src={fileUrl(preview)} controls playsInline /> : audioPattern.test(preview) ? <audio src={fileUrl(preview)} controls /> : <img src={fileUrl(preview)} alt={preview.split(/[\\/]/).pop()} />}</div><footer className="dialog-footer"><span className="file-path">{preview}</span><a className="button secondary" href={fileUrl(preview)} target="_blank" rel="noreferrer"><ExternalLink size={15} />打开文件</a></footer></Dialog>)}
  </div>;
}

function FileRow({ path, name, onPreview }) {
  const Icon = videoPattern.test(path || '') ? FileVideo : audioPattern.test(path || '') ? AudioLines : imagePattern.test(path || '') ? FileImage : FileText;
  const playable = path && (videoPattern.test(path) || audioPattern.test(path) || imagePattern.test(path) || subtitlePattern.test(path));
  return <div className="file-row"><Icon size={21} strokeWidth={1.5} /><div><strong>{name || path?.split(/[\\/]/).pop() || '未命名素材'}</strong><span>{path || '未提供文件路径'}</span></div>{playable && <IconButton icon={Play} label="预览文件" onClick={() => onPreview(path)} />}{path && <a className="icon-button" href={fileUrl(path)} title="打开文件" aria-label="打开文件" target="_blank" rel="noreferrer"><ExternalLink size={16} /></a>}</div>;
}

function App() {
  const picker = pickerPage;
  const [view, setView] = useState(picker ? 'templates' : maintenancePage ? 'maintenance' : 'studio');
  const [data, setData] = useState({ projects: [], jobs: [], templates: [], settings: {}, capabilities: [] });
  const [library, setLibrary] = useState({ templates: [], designSystems: [] });
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState('');
  const [selectedId, setSelectedId] = useState(() => { try { return localStorage.getItem('eac:project') || ''; } catch { return ''; } });
  const [templateId, setTemplateId] = useState(() => picker ? pickerInitialTemplateId : '01-flat-vector');
  const [designSystemId, setDesignSystemId] = useState('');
  const [pickerModeState, setPickerModeState] = useState(pickerMode);
  const [pickerKindState, setPickerKindState] = useState(pickerKind);
  const [form, setForm] = useState(initialForm);
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [previewTemplate, setPreviewTemplate] = useState(null);
  const [studioTab, setStudioTab] = useState('overview');
  const [jobFilter, setJobFilter] = useState('all');
  const requestInFlight = useRef(false);
  const mounted = useRef(true);
  const stateController = useRef(null);
  const libraryLoaded = useRef(false);
  const appSessionId = pickerQuery.get('sessionId') || '';
  const catalogTemplates = library.templates.length ? library.templates : data.templates;
  const allTemplates = useMemo(() => resolveTemplates(catalogTemplates), [catalogTemplates]);
  const templates = useMemo(() => picker && pickerModeState === 'design' ? allTemplates
    : allTemplates.filter(item => !item.kind || item.kind === 'motion'), [allTemplates, picker, pickerModeState]);
  const designSystems = useMemo(() => resolveDesignSystems(library.designSystems), [library.designSystems]);
  const project = data.projects.find(item => item.id === selectedId);
  const selectedTemplate = templates.find(item => item.id === templateId) || templates[0] || localTemplates[0];
  const activeJobs = data.jobs.filter(isActive);
  const projectJobs = data.jobs.filter(job => job.projectId === project?.id);
  const notify = (message, type = 'success') => setToast({ message, type, id: Date.now() });
  const refresh = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    const controller = new AbortController();
    stateController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const state = await api(libraryLoaded.current ? '/state?templates=0' : '/state', { signal: controller.signal });
      if (!state || !Array.isArray(state.projects) || !Array.isArray(state.jobs)) throw new Error('API 状态格式不正确。');
      if (mounted.current) {
        setData(current => ({ projects: state.projects.map(item => {
          const known = current.projects.find(existing => existing.id === item.id);
          return known?.revision > item.revision ? known : item;
        }), jobs: state.jobs.filter(job => Object.hasOwn(jobNames, job.type)), templates: state.templates || [], settings: state.settings || {}, capabilities: (state.capabilities || []).filter(capability => productionCapabilities.has(capability.id)) }));
        setConnected(true);
        setConnectionError('');
      }
    } catch (error) {
      if (mounted.current) { setConnected(false); setConnectionError(error.name === 'AbortError' ? '本地 API 连接超时' : error.message); }
    } finally {
      clearTimeout(timeout);
      requestInFlight.current = false;
      if (mounted.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    refresh();
    const interval = setInterval(() => { if (!document.hidden) refresh(); }, 2500);
    const onVisible = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { mounted.current = false; clearInterval(interval); stateController.current?.abort(); document.removeEventListener('visibilitychange', onVisible); };
  }, [refresh]);
  // The design library is a large catalog: fetch it once, never on the state poll.
  useEffect(() => {
    let active = true;
    api('/library').then(result => {
      if (active) {
        libraryLoaded.current = Array.isArray(result?.templates) && result.templates.length > 0;
        setLibrary({ templates: result?.templates || [], designSystems: result?.designSystems || [] });
      }
    }).catch(() => { /* The catalog may be unavailable; the local template list still renders. */ });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (picker) return;
    if (!selectedId && data.projects.length) setSelectedId(data.projects[0].id);
  }, [data.projects, selectedId]);
  useEffect(() => {
    if (picker) return;
    if (project) {
      setTemplateId(project.templateId);
      setForm({ title: project.title, brief: project.brief, templateId: project.templateId, width: project.width, height: project.height, fps: project.fps });
    }
    try { if (selectedId) localStorage.setItem('eac:project', selectedId); } catch { /* Storage may be unavailable in embedded pickers. */ }
  }, [selectedId, project?.id]);
  const mutate = async (key, action, success) => {
    if (busy) return false;
    setBusy(key);
    try { const result = await action(); if (success) notify(success); await refresh(); return result ?? true; }
    catch (error) { notify(error.message, 'error'); await refresh(); return false; }
    finally { setBusy(''); }
  };
  const selectTemplate = template => {
    const nextId = templateId === template.id ? '' : template.id;
    setTemplateId(nextId);
    setForm(current => ({ ...current, templateId: nextId || initialForm.templateId }));
    if (picker) {
      pickerPost({ type: 'eac:template', templateId: template.id, templateName: template.name, ...(pickerModeState === 'design' ? { kind: template.kind || pickerKindState } : {}) });
    } else {
      notify(!nextId ? `已取消「${template.name}」` : `已选「${template.name}」`);
    }
  };
  const selectDesignSystem = system => {
    setDesignSystemId(picker && designSystemId === system.id ? '' : system.id);
    if (picker) {
      pickerPost({ type: 'eac:template', templateId: system.id, templateName: system.name, kind: 'design-system', designSystemId: system.id });
    } else {
      notify(`已选择设计体系「${system.name}」`);
    }
  };
  const createProject = async event => {
    event.preventDefault();
    const created = await mutate('project', () => api('/projects', { method: 'POST', body: form }), '项目已创建');
    if (created?.id) { setData(current => ({ ...current, projects: [created, ...current.projects.filter(item => item.id !== created.id)] })); setSelectedId(created.id); setDialog(null); setView('studio'); }
  };
  const runJob = async (type, params = {}) => {
    if (!project) return;
    const result = await mutate(type, () => api('/jobs', { method: 'POST', body: { type, projectId: project.id, params: { ...(type === 'render-template' ? { templateId } : {}), ...params } } }), `${jobNames[type]}任务已提交`);
    if (result?.id) setData(current => current.jobs.some(item => item.id === result.id)
      ? current : { ...current, jobs: [result, ...current.jobs] });
  };
  const planProject = async (params = {}) => {
    if (!project) return;
    const planned = await mutate('plan', () => api(`/projects/${encodeURIComponent(project.id)}/plan`, { method: 'POST', body: params }), '制作计划已生成');
    if (planned?.id) updateProject(planned);
  };
  const updateProject = updated => setData(current => ({ ...current, projects: current.projects.map(item => item.id === updated.id && item.revision <= updated.revision ? updated : item) }));
  const cancelJob = id => mutate(`cancel-${id}`, () => api(`/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }), '已请求取消任务');
  const importAsset = path => mutate('asset', () => api(`/projects/${encodeURIComponent(project.id)}/assets`, { method: 'POST', body: { path } }), '素材已导入');
  const importShots = items => mutate('shotlist', async () => {
    let updated;
    for (const item of items) {
      updated = await api(`/projects/${encodeURIComponent(project.id)}/assets`, { method: 'POST', body: { templateId: item.id } });
    }
    if (updated) updateProject(updated);
    return updated;
  }, `已将 ${items.length} 个镜头加入项目素材`);
  const changeView = value => setView(value);
  const title = { studio: '制作工作台', templates: '视觉模板', design: '设计工作台', workflow: '制作流程', jobs: '任务队列', assets: '素材与输出', maintenance: '插件维护', settings: '工作空间设置' }[view];
  const subtitle = { studio: '从一份简报，开始下一支作品。', templates: '找到适合表达的视觉语言。', design: '从设计库选择体系与模板，创作网站、幻灯片、文档与图片。', workflow: '连接素材、镜头、声音与最终成片。', jobs: '追踪每一次录制、生成与渲染。', assets: '项目素材与真实制作输出。', maintenance: '版本、更新、热重载与公告。', settings: '设置输出目录、制作画质与旁白声音。' }[view];
  const eyebrow = { studio: 'PRODUCTION STUDIO', templates: 'VISUAL LIBRARY', design: 'DESIGN WORKSPACE', workflow: 'PRODUCTION CONTROL', jobs: 'PRODUCTION CONTROL', assets: 'PRODUCTION CONTROL', maintenance: 'PLUGIN MAINTENANCE', settings: 'WORKSPACE PREFERENCES' }[view];
  const newProject = () => { setForm({ ...initialForm, templateId: templateId || initialForm.templateId }); setDialog('project'); };
  if (canvasPage) return <DesignCanvas sessionId={canvasSessionId} mode={canvasMode} />;
  if (designPage) return <div className="route-page"><DesignWorkspace sessionId={appSessionId} embedded={window.parent !== window} /></div>;
  if (picker) return <PickerView templates={templates} designSystems={designSystems} selectedId={templateId} connected={connected} mode={pickerModeState} kind={pickerKindState} selectedSystemId={designSystemId}
    onSelect={selectTemplate} onSelectSystem={selectDesignSystem} onKindChange={setPickerKindState}
    onBrowseAll={() => pickerPost({ type: 'eac:open-picker' })}
    onState={state => { if (state.templateId !== null) setTemplateId(state.templateId); if (state.designSystemId !== null) setDesignSystemId(state.designSystemId); if (state.mode) setPickerModeState(state.mode); if (state.kind) setPickerKindState(state.kind); }} />;
  const navEntries = [['studio', Clapperboard, '制作工作台'], ['templates', Grid2X2, '视觉模板'], ['design', Palette, '设计工作台'], ['workflow', Workflow, '制作流程'], ['jobs', ListVideo, '任务队列'], ['assets', FolderOpen, '素材与输出'], ['maintenance', Wrench, '插件维护']];
  return <div className="app-shell">
    <header className="app-topnav">
      <Brand compact />
      <nav className="topnav-items" aria-label="工作空间导航">{navEntries.map(([id, Icon, label]) => <button key={id} className={`topnav-item ${view === id ? 'active' : ''}`} onClick={() => changeView(id)}><Icon size={16} strokeWidth={1.7} /><span>{label}</span>{id === 'jobs' && activeJobs.length > 0 && <span className="nav-badge">{activeJobs.length}</span>}{id === 'templates' && <span className="nav-count">{templates.length}</span>}</button>)}</nav>
      <div className="topnav-right">
        {project && !['settings', 'maintenance'].includes(view) && <span className="current-project"><Folder size={13} />{project.title}</span>}
        <span className="harness-label"><span className="tiny-dot" />DEEPSEEK HARNESS</span>
        <IconButton icon={RefreshCw} label="刷新服务状态" onClick={refresh} />
        <button className={`topnav-item settings-item ${view === 'settings' ? 'active' : ''}`} onClick={() => changeView('settings')}><Settings2 size={16} strokeWidth={1.7} /><span>设置</span></button>
        <span className={`availability ${connected ? 'available' : ''}`} title={connected ? '本地服务已连接' : '本地服务未连接'} />
      </div>
    </header>
    <main className={`main-content view-${view}`}>
      {view !== 'settings' && <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}<span className="heading-dot">.</span></h1><p>{subtitle}</p></div>{view !== 'maintenance' && <div className="heading-actions">{project && <span className="current-project"><Folder size={14} />{project.title}</span>}{view !== 'design' && <Button icon={Plus} variant="primary" onClick={newProject}>新建项目</Button>}</div>}</div>}
      {!connected && !loading && <div className="connection-banner" role="status"><CircleAlert size={16} /><span>本地 API 未连接<span className="connection-detail"> · {connectionError}</span></span><Button icon={RefreshCw} variant="ghost" onClick={refresh}>重试</Button></div>}
      {view === 'studio' && <>
        <div className="studio-tabs"><div role="tablist" aria-label="工作台视图"><button role="tab" aria-selected={studioTab === 'overview'} className={studioTab === 'overview' ? 'selected' : ''} onClick={() => setStudioTab('overview')}><SlidersHorizontal size={15} />制作概览</button><button role="tab" aria-selected={studioTab === 'jobs'} className={studioTab === 'jobs' ? 'selected' : ''} onClick={() => setStudioTab('jobs')}><Clock3 size={15} />项目任务<span>{projectJobs.length}</span></button><button role="tab" aria-selected={studioTab === 'timeline'} className={studioTab === 'timeline' ? 'selected' : ''} onClick={() => setStudioTab('timeline')}><Scissors size={15} />时间线编辑</button></div><span className="studio-format">{project ? `${project.width} × ${project.height} / ${project.fps} fps` : '1920 × 1080 / 30 fps'}</span></div>
        {studioTab === 'overview' ? <div className="studio-layout"><div className="studio-main"><Preview project={project} template={selectedTemplate} onPreviewTemplate={() => setPreviewTemplate(selectedTemplate)} /><ClipStrip project={project} onPlan={() => planProject()} busy={busy === 'plan'} />
          <section className="recommendations"><div className="section-toolbar"><div className="section-title"><Grid2X2 size={15} /><h2>视觉风格</h2><span className="count">{templates.length}</span></div><Button icon={ArrowRight} variant="ghost" onClick={() => changeView('templates')}>浏览全部</Button></div><div className="template-strip">{templates.slice(0, 4).map(template => <button key={template.id} className={`mini-template ${template.id === templateId ? 'selected' : ''}`} onClick={() => selectTemplate(template)}><div><Thumbnail template={template} />{template.id === templateId && <span className="selected-mark"><Check size={12} /></span>}</div><span>{template.name}{template.id === templateId && <Check size={12} />}</span></button>)}</div></section>
        </div><aside className="brief-panel"><header><div className="section-title"><FileImage size={16} /><h2>制作简报</h2></div><span className={`tag ${project ? 'teal-tag' : ''}`}>{project ? '已创建' : '新项目'}</span></header>
          {project ? <><div className="project-summary"><h3>{project.title}</h3><p>{project.brief}</p><dl><div><dt>视觉风格</dt><dd>{templates.find(item => item.id === project.templateId)?.name || project.templateId}</dd></div><div><dt>画面规格</dt><dd>{project.width} × {project.height}</dd></div><div><dt>帧率</dt><dd>{project.fps} fps</dd></div><div><dt>项目素材</dt><dd>{project.assets?.length || 0} 个文件</dd></div><div><dt>更新时间</dt><dd>{displayDate(project.updatedAt) || '—'}</dd></div></dl></div>{templateId && templateId !== project.templateId && <div className="template-change"><Sparkles size={15} /><span>{selectedTemplate.renderable === false ? '创作参考' : '模板渲染'}将使用「{selectedTemplate.name}」</span></div>}<div className="brief-actions"><Button variant="primary" icon={Workflow} onClick={() => changeView('workflow')}>一键制作与工作流<ArrowRight size={14} /></Button><Button icon={Play} busy={busy === 'render'} onClick={() => runJob('render')}>渲染项目</Button><Button icon={Clapperboard} busy={busy === 'render-template'} disabled={!templateId || selectedTemplate.renderable === false} title={selectedTemplate.renderable === false ? '此镜头需定制源码；可先从选片单导入视频素材' : undefined} onClick={() => runJob('render-template')}>渲染所选模板</Button></div></> : <ProjectForm form={form} setForm={setForm} templates={templates} onSubmit={createProject} busy={busy === 'project'} onTemplateChange={setTemplateId} />}
          <div className="brief-bottom"><span className="tiny-dot" />{data.settings.quality === 'production' ? '正式制作' : '草稿制作'}<span>本地工作空间</span></div>
        </aside></div> : studioTab === 'timeline' ? (project ? <TimelineEditor key={project.id} project={project} busy={busy === 'timeline'} onSave={async inputs => {
          const saved = await mutate('timeline', () => api(`/projects/${encodeURIComponent(project.id)}/timeline`, { method: 'PUT', body: inputs }), '时间线已保存');
          if (saved?.id) updateProject(saved);
          return saved;
        }} /> : <Empty icon={Scissors} title="先创建制作项目" description="导入素材后可以在此调整每段素材的入点、时长、音量和轨道。" />) : <JobList jobs={projectJobs} onCancel={cancelJob} busy={busy} projects={data.projects} />}
      </>}
      {view === 'templates' && <TemplateGallery templates={templates} selectedId={templateId} onSelect={selectTemplate} onImportShots={project ? importShots : undefined} />}
      {view === 'design' && <DesignWorkspace sessionId={appSessionId} initialView="library" embedded={window.parent !== window} library={library} />}
      {view === 'workflow' && <WorkflowView key={project?.id || 'none'} project={project} template={templateId ? selectedTemplate : null} busy={busy} onJob={runJob} onPlan={planProject} jobs={projectJobs} capabilities={data.capabilities} connected={connected} />}
      {view === 'jobs' && <><div className="jobs-toolbar"><div className="filter-tabs">{[['all', '全部任务'], ['active', '进行中'], ['completed', '已完成'], ['failed', '失败']].map(([id, label]) => <button key={id} className={jobFilter === id ? 'selected' : ''} onClick={() => setJobFilter(id)}>{label}{id === 'active' && <span className="count">{activeJobs.length}</span>}</button>)}</div><IconButton icon={RefreshCw} label="刷新任务" onClick={refresh} /></div><JobList jobs={data.jobs.filter(job => jobFilter === 'all' || (jobFilter === 'active' ? isActive(job) : job.status === jobFilter))} onCancel={cancelJob} busy={busy} projects={data.projects} /></>}
      {view === 'assets' && <AssetsView project={project} jobs={data.jobs} onImport={importAsset} busy={busy === 'asset'} />}
      {view === 'settings' && <SettingsView settings={data.settings} capabilities={data.capabilities} connected={connected} onSave={draft => mutate('settings', () => api('/settings', { method: 'PUT', body: draft }), '设置已保存')} busy={busy === 'settings'} />}
      {view === 'maintenance' && <MaintenancePanel notify={notify} />}
      {view !== 'settings' && <footer className="page-footer"><span>EAC design world<span className="footer-divider">/</span>让创作有序发生</span><span><span className={`availability ${connected ? 'available' : ''}`} />{connected ? '工作空间已同步' : loading ? '正在连接' : '离线浏览'}</span></footer>}
    </main>
    {dialog === 'project' && <Dialog title="新建制作项目" onClose={() => setDialog(null)}><div className="project-dialog-body"><ProjectForm form={form} setForm={setForm} templates={templates} onSubmit={createProject} busy={busy === 'project'} existing={false} onTemplateChange={setTemplateId} /></div></Dialog>}
    {previewTemplate && <TemplateDetail template={previewTemplate} selectedId={templateId} onClose={() => setPreviewTemplate(null)} onSelect={template => { selectTemplate(template); setPreviewTemplate(null); }} />}
    {toast && <Toast toast={toast} onClose={() => setToast(null)} />}
  </div>;
}

function Brand({ compact = false }) {
  return <div className={`brand ${compact ? 'brand-compact' : ''}`}><span className="brand-mark"><img src="/eac-avatar.jpg" alt="EAC design world" width={compact ? 29 : 35} height={compact ? 31 : 37} /></span><div><strong>EAC<span>design world</span></strong>{!compact && <small>创作，自成世界</small>}</div></div>;
}

function Toast({ toast, onClose }) {
  return <div className={`toast ${toast.type}`} role={toast.type === 'error' ? 'alert' : 'status'}>{toast.type === 'error' ? <CircleAlert size={18} /> : <CircleCheck size={18} />}<span>{toast.message}</span><IconButton icon={X} label="关闭提示" onClick={onClose} /></div>;
}

createRoot(document.getElementById('root')).render(<App />);
