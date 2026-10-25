import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine, ArrowRight, Check, ChevronLeft, ChevronRight, CircleAlert,
  Code2, ExternalLink, Eye, FileImage, FileText, Film, FolderOpen, Layers3,
  LayoutGrid, ListVideo, LoaderCircle, Monitor, Palette, Plus, RefreshCw, Save,
  Search, Smartphone, Sparkles, Tablet, Type, X,
} from 'lucide-react';
import { api, fileUrl, outputPaths } from './api';
import { kindLabel, resolveDesignSystems, resolveLibraryTemplates, sourceLabel } from './templates';
import './design-workspace.css';
import LibraryThumbnail from './LibraryThumbnail';
import Dialog from './Dialog';
import { previewCsp } from '../src/preview-policy.mjs';

function isolatedPreview(content) {
  const doc = new DOMParser().parseFromString(content || '', 'text/html');
  const policy = doc.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = previewCsp('html', location.origin, location.origin).replace('sandbox allow-scripts allow-downloads; ', '');
  doc.head.prepend(policy);
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}


const videoPattern = /\.(mp4|webm|mov|m4v)(?:\?|$)/i;
const designKinds = ['website', 'motion', 'deck', 'document', 'image'];
const kindIcons = { website: LayoutGrid, motion: Film, deck: ListVideo, document: FileText, image: FileImage };
const deviceWidths = { desktop: '100%', tablet: '820px', mobile: '390px' };
const editorDrafts = new Map();

function readEditorDraft(key) {
  if (editorDrafts.has(key)) return editorDrafts.get(key);
  try {
    const draft = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (draft && typeof draft.name === 'string' && typeof draft.content === 'string') return draft;
  } catch { /* Session storage may be unavailable in an embedded workspace. */ }
  return null;
}

function storeEditorDraft(key, draft) {
  if (draft) editorDrafts.set(key, draft);
  else editorDrafts.delete(key);
  try {
    if (draft) sessionStorage.setItem(key, JSON.stringify(draft));
    else sessionStorage.removeItem(key);
  } catch { /* Keep the in-memory draft when browser storage is full or blocked. */ }
}

function Button({ icon: Icon, children, variant = 'secondary', busy, className = '', ...props }) {
  return <button className={`button ${variant} ${className}`} disabled={busy || props.disabled} {...props}>
    {busy ? <LoaderCircle size={15} className="spin" /> : Icon && <Icon size={15} />}
    {children}
  </button>;
}

function Empty({ icon: Icon = Layers3, title, description, action }) {
  return <div className="empty"><Icon size={27} strokeWidth={1.4} /><strong>{title}</strong>{description && <p>{description}</p>}{action}</div>;
}

function Swatches({ colors, size = 34 }) {
  if (!colors?.length) return <span className="dw-swatch-empty">无公开色值</span>;
  return <div className="dw-swatches" style={{ '--swatch-size': `${size}px` }}>
    {colors.slice(0, 8).map((color, index) => <span key={`${color.value}-${index}`} className="dw-swatch" style={{ background: color.value }} title={`${color.name} · ${color.value}`} />)}
  </div>;
}

function FontPreview({ fonts }) {
  if (!fonts?.length) return <span className="dw-swatch-empty">无公开字体令牌</span>;
  return <ul className="dw-fonts">{fonts.slice(0, 3).map((font, index) => <li key={`${font.family}-${index}`}>
    <span className="dw-font-family" style={{ fontFamily: font.family }}>{font.family}</span>
    <small>{font.role}</small>
  </li>)}</ul>;
}

function Attribution({ item }) {
  const source = sourceLabel(item.source);
  const license = item.license || item.attribution?.license || '';
  const author = item.author || item.attribution?.author || '';
  const href = item.homepage || item.attribution?.url || item.attribution?.homepage || '';
  return <div className="dw-attribution">
    <span className="dw-attribution-source">{source}</span>
    {license && <span className="tag">{license}</span>}
    {author && <span className="muted">{author}</span>}
    {href && <a href={href} target="_blank" rel="noreferrer" title="打开来源"><ExternalLink size={12} /></a>}
  </div>;
}

function DesignSystemCard({ system, selected, onSelect, onOpen }) {
  return <article className={`dw-system-card ${selected ? 'chosen' : ''}`}>
    <header>
      <div>
        <h3>{system.name}</h3>
        <p>{system.description || system.id}</p>
      </div>
      {selected && <span className="selected-mark"><Check size={13} /></span>}
    </header>
    <button className="dw-system-cover" aria-label={`预览${system.name}设计体系`} onClick={() => onOpen(system)}><LibraryThumbnail item={system} system /><span>查看设计体系 ↗</span></button>
    <div className="dw-system-visual"><Swatches colors={system.colors} size={24} /><FontPreview fonts={system.fonts} /></div>
    {system.tokens?.length > 0 && <div className="dw-token-row">
      {system.tokens.slice(0, 6).map((token, index) => <span key={`${token.name}-${index}`} className="dw-token" title={`${token.name} · ${token.value}`}>
        {/^#([0-9a-f]{3,8})$/i.test(String(token.value)) && <i style={{ background: token.value }} />}{String(token.value)}
      </span>)}
    </div>}
    <Attribution item={system} />
    <footer>
      <Button icon={Eye} variant="ghost" onClick={() => onOpen(system)}>查看详情</Button>
      <Button variant={selected ? 'secondary' : 'primary'} icon={selected ? Check : Sparkles} onClick={() => onSelect(system)}>{selected ? '已选为风格' : '用这套体系创作'}</Button>
    </footer>
  </article>;
}

function LibraryPanel({ templates, systems, loading, error, kindFilter, setKindFilter, query, setQuery, selected, onSelectTemplate, onSelectSystem, onOpenSystem, onRetry, onUse }) {
  const [tab, setTab] = useState(systems.length ? 'systems' : 'templates');
  useEffect(() => { if (systems.length && !templates.length) setTab('systems'); else if (templates.length && !systems.length) setTab('templates'); }, [systems.length, templates.length]);
  const kinds = ['全部', ...new Set([...templates.map(item => item.kind), ...systems.map(item => item.kind)].filter(Boolean))];
  const term = query.trim().toLowerCase();
  const matches = item => !term || `${item.name} ${item.id} ${item.source || ''} ${item.description || ''} ${item.author || ''} ${item.category || ''}`.toLowerCase().includes(term);
  const visibleSystems = systems.filter(item => (kindFilter === '全部' || item.kind === kindFilter) && matches(item));
  const visibleTemplates = templates.filter(item => (kindFilter === '全部' || item.kind === kindFilter) && matches(item));
  return <div className="dw-library">
    <div className="dw-library-toolbar">
      <div className="dw-tabs" role="tablist" aria-label="设计库分区">
        <button role="tab" aria-selected={tab === 'systems'} className={tab === 'systems' ? 'selected' : ''} onClick={() => setTab('systems')}><Palette size={14} />设计体系<span className="count">{systems.length}</span></button>
        <button role="tab" aria-selected={tab === 'templates'} className={tab === 'templates' ? 'selected' : ''} onClick={() => setTab('templates')}><Layers3 size={14} />创作模板<span className="count">{templates.length}</span></button>
      </div>
      <div className="search-input"><Search size={16} /><input aria-label="搜索设计库" placeholder="搜索名称、来源、风格…" value={query} onChange={event => setQuery(event.target.value)} />{query && <button className="icon-button" title="清除搜索" aria-label="清除搜索" onClick={() => setQuery('')}><X size={15} /></button>}</div>
    </div>
    <div className="filter-tabs" aria-label="设计类型筛选">{kinds.map(kind => <button key={kind} className={kindFilter === kind ? 'selected' : ''} onClick={() => setKindFilter(kind)}>{kind === '全部' ? '全部类型' : kindLabel(kind)}</button>)}</div>
    {loading && <div className="dw-loading" role="status"><LoaderCircle size={17} className="spin" />正在读取本地设计库…</div>}
    {error && <div className="connection-banner" role="status"><CircleAlert size={16} /><span>设计库读取失败<span className="connection-detail"> · {error}</span></span><Button icon={RefreshCw} variant="ghost" onClick={onRetry}>重试</Button></div>}
    {!loading && !error && tab === 'systems' && (visibleSystems.length
      ? <div className="dw-system-grid">{visibleSystems.map(system => <DesignSystemCard key={system.id} system={system} selected={selected?.type === 'system' && selected.id === system.id} onSelect={onSelectSystem} onOpen={onOpenSystem} />)}</div>
      : <Empty icon={Palette} title="没有匹配的设计体系" description="试试其他关键词或类型。" />)}
    {!loading && !error && tab === 'templates' && (visibleTemplates.length
      ? <div className="dw-template-grid">{visibleTemplates.map(template => <article key={template.id} className={`dw-template-card ${selected?.type === 'template' && selected.id === template.id ? 'chosen' : ''}`}>
        <button className="dw-template-thumb" onClick={() => onSelectTemplate(template)} title={`选择${template.name}`}>
          {template.thumbnail ? <img src={template.thumbnail} alt={template.name} loading="lazy" /> : <div className="template-placeholder"><Monitor size={22} strokeWidth={1.25} /><span>{template.name}</span></div>}
          {selected?.type === 'template' && selected.id === template.id && <span className="selected-mark"><Check size={13} /></span>}
        </button>
        <div className="dw-template-caption">
          <div><h3>{template.name}</h3><p>{kindLabel(template.kind)}{template.category ? ` · ${template.category}` : ''}</p></div>
          <Button variant="ghost" icon={Sparkles} onClick={() => onUse(template)}>使用</Button>
        </div>
        <Attribution item={template} />
      </article>)}</div>
      : <Empty icon={Layers3} title="没有匹配的创作模板" description="试试其他关键词或类型。" />)}
  </div>;
}

function SystemDialog({ system, onClose, onUse }) {
  return <Dialog title={`${system.name} 设计体系`} className="dw-system-dialog" onClose={onClose}>
      <div className="dw-system-body">
        <p className="dw-system-summary">{system.description || '未提供描述。'}</p>
        <section><h3><Palette size={14} />色板</h3><Swatches colors={system.colors} size={44} />
          {system.colors?.length > 0 && <dl className="dw-token-list">{system.colors.map((color, index) => <div key={`${color.value}-${index}`}><dt>{color.name}</dt><dd><i style={{ background: color.value }} />{color.value}</dd></div>)}</dl>}</section>
        <section><h3><Type size={14} />字体</h3><FontPreview fonts={system.fonts} /></section>
        {system.tokens?.length > 0 && <section><h3><Code2 size={14} />令牌</h3><dl className="dw-token-list">{system.tokens.map((token, index) => <div key={`${token.name}-${index}`}><dt>{token.name}</dt><dd>{String(token.value)}</dd></div>)}</dl></section>}
        <section><h3><FolderOpen size={14} />来源与许可</h3><Attribution item={system} /><p className="muted dw-license-note">来源与许可信息来自上游条目，未在此处推断。</p></section>
      </div>
      <footer className="dialog-footer"><span className="muted">{system.id}</span><Button variant="primary" icon={Sparkles} onClick={() => onUse(system)}>用这套体系创作</Button></footer>
  </Dialog>;
}

function ProjectDialog({ selection, sessionId, onCreate, onClose, busy }) {
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [kind, setKind] = useState(designKinds.includes(selection?.kind) ? selection.kind : 'website');
  const submit = event => {
    event.preventDefault();
    onCreate({ title, brief, kind, ...(selection?.type === 'template' ? { templateId: selection.id } : {}), ...(selection?.type === 'system' ? { designSystemId: selection.id } : {}), sessionId });
  };
  return <Dialog title="新建设计作品" className="dw-project-dialog" onClose={onClose}>
      <form className="dw-project-form" onSubmit={submit}>
        <label>作品名称<input required maxLength={160} autoFocus placeholder="例如：产品发布页、季度汇报幻灯片" value={title} onChange={event => setTitle(event.target.value)} /></label>
        <label>创作说明<textarea rows={4} maxLength={8000} placeholder="想做什么、给谁看、希望传达什么…" value={brief} onChange={event => setBrief(event.target.value)} /></label>
        <fieldset><legend>作品类型</legend>
          <div className="dw-kind-grid">{designKinds.map(item => { const Icon = kindIcons[item]; return <button type="button" key={item} className={kind === item ? 'selected' : ''} onClick={() => setKind(item)}><Icon size={15} />{kindLabel(item)}</button>; })}</div>
        </fieldset>
        <div className="dw-selection-summary">
          <span className="tiny-dot" />
          {selection ? (selection.type === 'system' ? `设计体系：${selection.name}` : `创作模板：${selection.name}`) : '未选择模板或设计体系，可稍后在工作区选择。'}
        </div>
        <div className="dw-dialog-actions"><Button type="button" variant="ghost" onClick={onClose}>取消</Button><Button type="submit" variant="primary" icon={Plus} busy={busy}>创建作品</Button></div>
      </form>
  </Dialog>;
}

function starterFor(name, kind) {
  const title = name.replace(/\.[a-z0-9]+$/i, '') || '作品';
  if (/\.md$/i.test(name) || kind === 'document') return `# ${title}\n\n在这里写下正文。\n`;
  if (/\.svg$/i.test(name)) return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450" width="800" height="450">\n  <rect width="800" height="450" fill="#f3f5f9"/>\n  <text x="40" y="80" font-family="sans-serif" font-size="28" fill="#4d6bfe">${title}</text>\n</svg>\n`;
  return `<!doctype html>\n<html lang="zh-CN">\n  <head>\n    <meta charset="utf-8" />\n    <title>${title}</title>\n    <style>\n      body { margin: 0; font-family: system-ui, sans-serif; background: #f3f5f9; color: #171923; }\n      main { max-width: 900px; margin: 0 auto; padding: 64px 32px; }\n      h1 { font-size: 40px; margin: 0 0 16px; }\n      p { line-height: 1.9; color: #7b8497; }\n    </style>\n  </head>\n  <body>\n    <main>\n      <h1>${title}</h1>\n      <p>在这里搭建页面内容。</p>\n    </main>\n  </body>\n</html>\n`;
}

function splitDeckPages(content) {
  if (!content) return [];
  const doc = new DOMParser().parseFromString(content, 'text/html');
  let candidates = [...doc.querySelectorAll('[data-slide],.slide,.deck-page')];
  if (!candidates.length) candidates = [...doc.querySelectorAll('section')];
  const slides = candidates.filter(node => !candidates.some(parent => parent !== node && parent.contains(node)));
  if (slides.length < 2) return [];
  slides.forEach((node, index) => node.setAttribute('data-eac-slide', String(index)));
  return slides.map((_, index) => {
    const page = doc.documentElement.cloneNode(true);
    page.querySelectorAll('[data-eac-slide]').forEach(node => {
      if (node.getAttribute('data-eac-slide') !== String(index)) node.remove();
      else node.setAttribute('style', `${node.getAttribute('style') || ''};display:flex!important;visibility:visible!important;opacity:1!important;transform:none!important;position:relative!important;inset:auto!important;`);
    });
    return `<!doctype html>${page.outerHTML}`;
  });
}

function ArtifactPreview({ artifact, content, revision, device }) {
  const [deckIndex, setDeckIndex] = useState(0);
  const pages = useMemo(() => artifact.kind === 'html' && artifact.projectKind === 'deck' ? splitDeckPages(content) : [], [artifact.kind, artifact.projectKind, content]);
  useEffect(() => setDeckIndex(0), [artifact.id, revision]);
  const previewSrc = `${artifact.url}${revision ? `?revision=${revision}` : ''}`;
  const width = deviceWidths[device] || '100%';
  if (artifact.kind === 'markdown') return <div className="dw-preview-frame dw-device" data-device={device} style={{ width }}>
    <pre className="dw-doc-text">{content || '（空文档）'}</pre>
  </div>;
  if (artifact.kind === 'svg') return <div className="dw-preview-frame dw-device dw-dark" data-device={device} style={{ width }}>
    <img src={content ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}` : previewSrc} alt={artifact.name} />
  </div>;
  const decking = pages.length > 1;
  return <div className="dw-preview-block">
    {decking && <div className="dw-deck-nav">
      <button className="icon-button" title="上一页" aria-label="上一页" disabled={deckIndex === 0} onClick={() => setDeckIndex(index => Math.max(0, index - 1))}><ChevronLeft size={16} /></button>
      <span className="mono">{deckIndex + 1} / {pages.length}</span>
      <button className="icon-button" title="下一页" aria-label="下一页" disabled={deckIndex >= pages.length - 1} onClick={() => setDeckIndex(index => Math.min(pages.length - 1, index + 1))}><ChevronRight size={16} /></button>
    </div>}
    <div className="dw-preview-frame dw-device" data-device={device} style={{ width }}>
      <iframe key={`${artifact.id}-${revision}-${decking ? deckIndex : 'all'}`} title={`${artifact.name} 预览`}
        srcDoc={isolatedPreview(decking ? pages[deckIndex] : content)}
        sandbox="allow-scripts allow-downloads" loading="lazy" />
    </div>
  </div>;
}

function EditorPanel({ project, artifacts, artifactId, onSelectArtifact, onSave, busy, notify }) {
  const artifact = artifacts.find(item => item.id === artifactId) || null;
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [revision, setRevision] = useState(null);
  const [device, setDevice] = useState('desktop');
  const [loadedRevision, setLoadedRevision] = useState(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState('');
  const [exportResult, setExportResult] = useState(null);
  const [surface, setSurface] = useState(() => window.innerWidth < 900 ? 'preview' : 'split');
  const [loadedKey, setLoadedKey] = useState('');
  const [loadError, setLoadError] = useState('');
  const requestVersion = useRef(0);
  const latestDraft = useRef(null);
  const draftKey = `eac:draft:${project.id}:${artifact?.id || 'new'}`;
  const editable = loadedKey === draftKey && !loading && busy !== 'save';
  const dirty = loadedKey === draftKey && (artifact
    ? name !== loadedRevision?.name || content !== loadedRevision?.content
    : Boolean(name.trim() && content.trim()));
  const edit = patch => {
    const next = { name, content, revision, loadedRevision, ...patch };
    latestDraft.current = { key: draftKey, draft: next };
    editorDrafts.set(draftKey, next);
    if (Object.hasOwn(patch, 'name')) setName(patch.name);
    if (Object.hasOwn(patch, 'content')) setContent(patch.content);
  };
  useEffect(() => {
    const persist = () => {
      if (latestDraft.current) storeEditorDraft(latestDraft.current.key, latestDraft.current.draft);
    };
    window.addEventListener('pagehide', persist);
    return () => {
      ++requestVersion.current;
      persist();
      window.removeEventListener('pagehide', persist);
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (latestDraft.current) storeEditorDraft(latestDraft.current.key, latestDraft.current.draft);
    }, 350);
    return () => clearTimeout(timer);
  }, [name, content]);
  const exportFile = async format => {
    if (!artifact) return;
    const version = requestVersion.current;
    setExporting(format); setExportResult(null);
    try {
      const result = await api(`/design/artifacts/${artifact.id}/export/${format}`, { method: 'POST', body: { revision } });
      if (version === requestVersion.current) {
        setExportResult(result);
        notify(result.warning || `已导出 ${format.toUpperCase()}`);
      }
    } catch (error) { notify(error.message, 'error'); }
    finally { setExporting(''); }
  };
  const load = useCallback(async (target, revisionNumber, restoreDraft = false) => {
    const version = ++requestVersion.current;
    const key = `eac:draft:${project.id}:${target.id}`;
    const draft = restoreDraft ? readEditorDraft(key) : null;
    setLoading(true); setLoadError(''); setExportResult(null);
    try {
      const result = await api(`/design/artifacts/${encodeURIComponent(target.id)}/content${revisionNumber ? `?revision=${revisionNumber}` : ''}`);
      if (version !== requestVersion.current) return;
      const next = draft || { name: result.name, content: result.content, revision: result.revision, loadedRevision: result };
      setName(next.name); setContent(next.content); setRevision(next.revision); setLoadedRevision(next.loadedRevision);
      setLoadedKey(key);
      latestDraft.current = draft ? { key, draft } : null;
    } catch (error) {
      if (version === requestVersion.current) setLoadError(error.message);
    } finally { if (version === requestVersion.current) setLoading(false); }
  }, [project.id]);
  useEffect(() => {
    if (!artifact) {
      ++requestVersion.current;
      setLoading(false); setLoadError(''); setExportResult(null);
      const next = project?.kind === 'document' ? 'document.md' : project?.kind === 'image' ? 'image.svg' : 'index.html';
      const draft = readEditorDraft(draftKey);
      setName(draft?.name ?? next); setContent(draft?.content ?? starterFor(next, project?.kind));
      setRevision(null); setLoadedRevision(null); setLoadedKey(draftKey);
      latestDraft.current = draft ? { key: draftKey, draft } : null;
    } else {
      load(artifact, artifact.revision, true);
    }
    return () => {
      ++requestVersion.current;
      if (latestDraft.current) storeEditorDraft(latestDraft.current.key, latestDraft.current.draft);
      latestDraft.current = null;
    };
  }, [artifact?.id]);
  const save = async () => {
    if (!project || !name.trim() || !editable) return;
    const fileName = name.trim();
    if (artifacts.some(item => item.id !== artifact?.id && item.name === fileName)) {
      notify('同名文件已存在，请使用其他文件名。', 'error');
      return;
    }
    const sameFile = artifact && fileName === artifact.name;
    const saved = await onSave({ projectId: project.id, name: fileName, content, ...(sameFile && revision !== null ? { revision } : {}) });
    if (saved) {
      storeEditorDraft(draftKey, null); latestDraft.current = null;
      setRevision(saved.revision); setLoadedRevision({ content, revision: saved.revision, name: saved.name }); setName(saved.name);
    }
  };
  return <div className="dw-editor">
    <aside className="dw-file-list">
      <div className="dw-file-list-head"><span className="section-title"><FileText size={14} /><h2>作品文件</h2></span>
        <button className="icon-button" title="新建文件" aria-label="新建文件" disabled={busy === 'save'} onClick={() => { onSelectArtifact(''); }}><Plus size={15} /></button>
      </div>
      {artifacts.length ? <ul>{artifacts.map(item => <li key={item.id}>
        <button className={`dw-file ${item.id === artifact?.id ? 'selected' : ''}`} disabled={busy === 'save'} onClick={() => onSelectArtifact(item.id)}>
          <FileText size={14} /><span>{item.name}</span><small className="mono">v{item.revision}</small>
        </button>
      </li>)}</ul> : <p className="muted dw-file-empty">还没有文件，先新建一个。</p>}
      <button className={`dw-file dw-file-new ${!artifact && name ? 'selected' : ''}`} disabled={busy === 'save'} onClick={() => { onSelectArtifact(''); }}>
        <Plus size={14} /><span>新建文件</span>
      </button>
    </aside>
    <div className="dw-editor-main" aria-busy={loading}>
      <div className="dw-editor-toolbar">
        <input aria-label="文件名" className="dw-name-input" disabled={!editable} value={loadedKey === draftKey ? name : ''} placeholder="文件名，如 index.html / deck.md / mark.svg" onChange={event => edit({ name: event.target.value })} />
        {artifact && revision !== null && loadedKey === draftKey && <span className="tag">修订 v{revision}{dirty ? ' · 有改动' : ''}</span>}
        <Button icon={Save} variant="primary" busy={busy === 'save'} disabled={!editable || !project || !name.trim() || !dirty && Boolean(artifact)} onClick={save}>{loadedKey === draftKey && artifact && name.trim() !== artifact.name ? '另存为新文件' : '保存新版本'}</Button>
      </div>
      {loadError && <div className="connection-banner" role="alert"><CircleAlert size={15} /><span>{loadError}</span><Button icon={RefreshCw} onClick={() => load(artifact, artifact.revision, true)}>重新读取</Button></div>}
      {dirty && <div className="dw-draft-status" role="status"><CircleAlert size={12} />有未保存改动 · 草稿已暂存于当前浏览器</div>}
      <div className="dw-tabs dw-surface-tabs" role="tablist" aria-label="编辑显示方式">{[['preview', Eye, '预览作品'], ['source', Code2, '编辑内容'], ['split', LayoutGrid, '并排查看']].map(([id, Icon, label]) => <button key={id} role="tab" aria-selected={surface === id} className={surface === id ? 'selected' : ''} onClick={() => setSurface(id)}><Icon size={14} />{label}</button>)}</div>
      <div className={`dw-editor-split dw-surface-${surface}`}>
        <textarea className="dw-code mono" aria-label="文件内容" disabled={!editable} spellCheck={false} value={loadedKey === draftKey ? content : ''} placeholder="在此编写 HTML、SVG 或 Markdown。保存会生成一个新版本，不会覆盖旧版本。" onChange={event => edit({ content: event.target.value })} />
        <div className="dw-editor-preview">
          <div className="dw-device-bar" role="group" aria-label="预览宽度">
            <button className={device === 'desktop' ? 'selected' : ''} onClick={() => setDevice('desktop')}><Monitor size={14} />桌面</button>
            <button className={device === 'tablet' ? 'selected' : ''} onClick={() => setDevice('tablet')}><Tablet size={14} />平板</button>
            <button className={device === 'mobile' ? 'selected' : ''} onClick={() => setDevice('mobile')}><Smartphone size={14} />手机</button>
          </div>
          {loading ? <div className="dw-loading"><LoaderCircle size={16} className="spin" />读取文件…</div>
            : content.trim() ? <ArtifactPreview artifact={{ id: artifact?.id || 'draft', name, projectKind: project?.kind, kind: artifact?.kind || (/\.svg$/i.test(name) ? 'svg' : /\.md$/i.test(name) ? 'markdown' : 'html'), url: artifact ? artifact.url : '' }} content={content} revision={artifact ? revision : null} device={device} />
              : <Empty icon={Code2} title="还没有内容" description="在上方输入内容，或使用新建文件的骨架。" />}
          {!artifact && content.trim() && <p className="dw-draft-note"><CircleAlert size={12} />未保存的草稿预览，保存后才会生成可下载版本。</p>}
        </div>
      </div>
      {artifact && artifact.kind !== 'markdown' && <div className="dw-export-actions"><Button icon={ArrowDownToLine} busy={exporting === 'pdf'} disabled={!editable || Boolean(exporting) || dirty} onClick={() => exportFile('pdf')}>导出 PDF</Button><Button icon={FileImage} busy={exporting === 'png'} disabled={!editable || Boolean(exporting) || dirty} onClick={() => exportFile('png')}>导出 PNG</Button>{project?.kind === 'deck' && <Button icon={ListVideo} busy={exporting === 'pptx'} disabled={!editable || Boolean(exporting) || dirty} onClick={() => exportFile('pptx')}>导出 PPTX（整页图像）</Button>}{exportResult && <a className="button primary" href={exportResult.url} download>下载 {exportResult.format.toUpperCase()}</a>}</div>}
      {artifact && <div className="dw-history">
        <span className="section-title"><Layers3 size={14} /><h2>版本历史</h2><span className="count">{artifact.revisions?.length || 0}</span></span>
        <div className="dw-history-row">{artifact.revisions?.slice().reverse().map(item => <button key={item.revision} disabled={dirty || !editable} className={item.revision === revision ? 'selected' : ''} onClick={() => load(artifact, item.revision)}>v{item.revision}<small>{(item.bytes / 1024).toFixed(1)}KB</small></button>)}</div>
      </div>}
    </div>
  </div>;
}

function ProjectsPanel({ projects, selectedProject, onSelect, onOpenEditor, onNew, sessionId }) {
  return <div className="dw-projects">
    <div className="dw-projects-head">
      <div className="section-title"><FolderOpen size={15} /><h2>我的设计作品</h2><span className="count">{projects.length}</span></div>
      <Button icon={Plus} variant="primary" onClick={onNew}>新建作品</Button>
    </div>
    {projects.length ? <div className="dw-project-grid">{projects.map(project => {
      const Icon = kindIcons[project.kind] || Layers3;
      return <article key={project.id} className={`dw-project-card ${selectedProject?.id === project.id ? 'chosen' : ''}`}>
        <header><span className="dw-project-kind"><Icon size={15} />{kindLabel(project.kind)}</span>{project.sessionId && project.sessionId === sessionId && <span className="tag teal-tag">当前会话</span>}</header>
        <h3>{project.title}</h3>
        <p>{project.brief || '未填写创作说明。'}</p>
        <div className="dw-project-meta"><span>{project.artifacts?.length || 0} 个文件</span><span className="mono">{new Date(project.updatedAt).toLocaleDateString('zh-CN')}</span></div>
        <footer>
          <Button variant="ghost" icon={FolderOpen} onClick={() => onSelect(project)}>选中</Button>
          <Button variant="primary" icon={Code2} onClick={() => onOpenEditor(project)}>打开编辑</Button>
        </footer>
      </article>;
    })}</div> : <Empty icon={FolderOpen} title="还没有设计作品" description="从设计库选择模板或设计体系，或直接新建一个作品。" action={<Button icon={Plus} variant="primary" onClick={onNew}>新建作品</Button>} />}
  </div>;
}

export default function DesignWorkspace({ sessionId = '', initialView = 'library', embedded = false, library: providedLibrary = null }) {
  const [library, setLibrary] = useState({ templates: [], designSystems: [], creationModes: [], provenance: [] });
  const [libraryState, setLibraryState] = useState({ loading: true, error: '' });
  const [design, setDesign] = useState({ projects: [] });
  const [view, setView] = useState(initialView);
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState('全部');
  const [selection, setSelection] = useState(null);
  const [systemDetail, setSystemDetail] = useState(null);
  const [projectDialog, setProjectDialog] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [artifactId, setArtifactId] = useState('');
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState(null);
  const [connectionError, setConnectionError] = useState('');
  const mounted = useRef(true);
  const notify = useCallback((message, type = 'success') => setToast({ message, type, id: Date.now() }), []);

  const loadLibrary = useCallback(async () => {
    if (providedLibrary) {
      setLibrary({ templates: providedLibrary.templates || [], designSystems: providedLibrary.designSystems || [], creationModes: providedLibrary.creationModes || [], provenance: providedLibrary.provenance || [] });
      setLibraryState({ loading: false, error: '' });
      return;
    }
    setLibraryState({ loading: true, error: '' });
    try {
      const result = await api('/library');
      setLibrary({ templates: result.templates || [], designSystems: result.designSystems || [], creationModes: result.creationModes || [], provenance: result.provenance || [] });
      setLibraryState({ loading: false, error: '' });
    } catch (error) {
      setLibraryState({ loading: false, error: error.message });
    }
  }, [providedLibrary]);
  const loadDesign = useCallback(async () => {
    try {
      const result = await api(`/design/state${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`);
      if (mounted.current) { setDesign({ projects: result.projects || [] }); setConnectionError(''); }
    } catch (error) {
      if (mounted.current) setConnectionError(error.message);
    }
  }, [sessionId]);

  useEffect(() => {
    mounted.current = true;
    loadLibrary();
    loadDesign();
    return () => { mounted.current = false; };
  }, [loadLibrary, loadDesign]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  const templates = useMemo(() => resolveLibraryTemplates(library.templates), [library.templates]);
  const systems = useMemo(() => resolveDesignSystems(library.designSystems), [library.designSystems]);
  const projects = design.projects;
  const selectedProject = projects.find(item => item.id === projectId) || null;

  const createProject = async input => {
    setBusy('project');
    try {
      const created = await api('/design/projects', { method: 'POST', body: input });
      let seeded;
      if (input.templateId) {
        const item = await api('/tools/library_read', { method: 'POST', body: { kind: 'template', id: input.templateId, source: true } });
        if (item.entry?.text && /\.html?$/i.test(item.entry.path)) {
          const doc = new DOMParser().parseFromString(item.entry.text, 'text/html');
          const base = new URL(`/${item.entry.path.replace(/[^/]+$/, '')}`, location.origin);
          const optionalMotion = ['motion-web', 'onetake'].includes(item.source);
          if (optionalMotion) {
            doc.querySelectorAll('base').forEach(node => node.remove());
            const assetBase = doc.createElement('base');
            assetBase.setAttribute('href', base.pathname);
            doc.head.prepend(assetBase);
          }
          doc.querySelectorAll('[src],[href],[poster]').forEach(node => {
            for (const attr of ['src', 'href', 'poster']) {
              const value = node.getAttribute(attr);
              if (value && !/^(?:[a-z]+:|\/\/|#)/i.test(value)) {
                const target = new URL(value, base);
                node.setAttribute(attr, optionalMotion ? `${target.pathname}${target.search}${target.hash}` : target.href);
              }
            }
          });
          seeded = await api('/design/artifacts', { method: 'POST', body: { projectId: created.id, name: 'index.html', content: `<!doctype html>${doc.documentElement.outerHTML}` } });
        }
      }
      if (!seeded && input.designSystemId) {
        const system = library.designSystems.find(item => item.id === input.designSystemId);
        if (system?.tokensCss) {
          const response = await fetch(`/${system.tokensCss}`);
          if (!response.ok) throw new Error('设计体系配色文件读取失败');
          const tokens = await response.text();
          const title = created.title.replace(/[<>&"']/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[character]);
          seeded = await api('/design/artifacts', { method: 'POST', body: { projectId: created.id, name: 'index.html', content: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${tokens}\nbody{margin:0;padding:48px;background:var(--bg,#fff);color:var(--fg,#222);font-family:var(--font-body,system-ui)}h1{font-family:var(--font-display,system-ui)}button{padding:12px 20px;border:0;background:var(--accent,#4d6bfe);color:var(--accent-on,#fff);border-radius:var(--radius-md,8px)}</style><main><h1>${title}</h1><p>已载入所选设计体系，请按创作说明完善内容。</p><button>开始</button></main></html>` } });
        }
      }
      notify(seeded ? `已创建「${created.title}」的起始文件，请按简报修改` : `已创建「${created.title}」`);
      setProjectId(created.id);
      setProjectDialog(false);
      setView('editor');
      setArtifactId(seeded?.id || '');
      await loadDesign();
    } catch (error) { notify(error.message, 'error'); }
    finally { setBusy(''); }
  };
  const saveArtifact = async input => {
    setBusy('save');
    try {
      const saved = await api('/design/artifacts', { method: 'POST', body: input });
      notify(`已保存 ${saved.name} · v${saved.revision}`);
      await loadDesign();
      setArtifactId(saved.id);
      return saved;
    } catch (error) { notify(error.message, 'error'); return null; }
    finally { setBusy(''); }
  };
  const pickTemplate = template => {
    setSelection({ type: 'template', id: template.id, name: template.name, kind: template.kind || 'motion' });
    notify(`已选择模板「${template.name}」，可开始创作`);
  };
  const pickSystem = system => {
    setSelection({ type: 'system', id: system.id, name: system.name, kind: system.kind || 'design-system' });
    setSystemDetail(null);
    notify(`已选择设计体系「${system.name}」`);
  };
  const openEditor = project => { setProjectId(project.id); setArtifactId(project.artifacts?.[0]?.id || ''); setView('editor'); };
  const tab = (id, Icon, label, count) => <button role="tab" aria-selected={view === id} className={view === id ? 'selected' : ''} onClick={() => setView(id)}><Icon size={15} />{label}{count !== undefined && <span className="count">{count}</span>}</button>;

  return <div className={`dw-shell ${embedded ? 'dw-embedded' : ''}`}>
    <div className="dw-topbar">
      <div className="dw-tabs" role="tablist" aria-label="设计工作区视图">
        {tab('library', Palette, '设计库', systems.length + templates.length)}
        {tab('projects', FolderOpen, '我的作品', projects.length)}
        {tab('editor', Code2, '编辑与预览')}
      </div>
      <div className="dw-topbar-right">
        <Button icon={Plus} variant="primary" onClick={() => setProjectDialog(true)}>新建作品</Button>
        <span className={`availability ${connectionError ? '' : 'available'}`} />
        <span className="muted">{connectionError ? '设计服务未连接' : `${systems.length} 设计体系 · ${templates.length} 模板`}</span>
        <button className="icon-button" title="刷新设计作品" aria-label="刷新设计作品" onClick={loadDesign}><RefreshCw size={16} /></button>
      </div>
    </div>
    {selection && <div className="dw-selection-bar"><span className="tiny-dot" /><strong>{selection.type === 'system' ? '设计体系' : '创作模板'}</strong><span>{selection.name}</span><span className="muted">· {kindLabel(selection.kind)}</span><Button icon={Plus} variant="primary" onClick={() => setProjectDialog(true)}>用它新建作品</Button><button className="icon-button" title="清除选择" aria-label="清除选择" onClick={() => setSelection(null)}><X size={15} /></button></div>}
    {connectionError && <div className="connection-banner" role="status"><CircleAlert size={16} /><span>设计作品服务未连接<span className="connection-detail"> · {connectionError}</span></span><Button icon={RefreshCw} variant="ghost" onClick={loadDesign}>重试</Button></div>}
    <div className="dw-body">
      {view === 'library' && <LibraryPanel templates={templates} systems={systems} loading={libraryState.loading} error={libraryState.error}
        kindFilter={kindFilter} setKindFilter={setKindFilter} query={query} setQuery={setQuery} selected={selection}
        onSelectTemplate={pickTemplate} onSelectSystem={pickSystem} onOpenSystem={setSystemDetail} onRetry={loadLibrary}
        onUse={template => { pickTemplate(template); setProjectDialog(true); }} />}
      {view === 'projects' && <ProjectsPanel projects={projects} selectedProject={selectedProject} onSelect={project => setProjectId(project.id)} onOpenEditor={openEditor} onNew={() => setProjectDialog(true)} sessionId={sessionId} />}
      {view === 'editor' && (selectedProject
        ? <EditorPanel key={selectedProject.id} project={selectedProject} artifacts={selectedProject.artifacts || []} artifactId={artifactId} onSelectArtifact={setArtifactId} onSave={saveArtifact} busy={busy} notify={notify} />
        : <Empty icon={Code2} title="先选择一个作品" description="在「我的作品」中选择或新建一个作品，然后在这里编写与预览文件。" action={<Button icon={FolderOpen} variant="primary" onClick={() => setView('projects')}>前往我的作品</Button>} />)}
    </div>
    {projectDialog && <ProjectDialog selection={selection} sessionId={sessionId} onCreate={createProject} onClose={() => setProjectDialog(false)} busy={busy === 'project'} />}
    {systemDetail && <SystemDialog system={systemDetail} onClose={() => setSystemDetail(null)} onUse={pickSystem} />}
    {toast && <div className={`toast ${toast.type}`} role={toast.type === 'error' ? 'alert' : 'status'}>{toast.type === 'error' ? <CircleAlert size={18} /> : <Check size={18} />}<span>{toast.message}</span><button className="icon-button" title="关闭提示" aria-label="关闭提示" onClick={() => setToast(null)}><X size={15} /></button></div>}
  </div>;
}

function CanvasItemPreview({ item, device }) {
  const width = deviceWidths[device] || '100%';
  const previewUrl = `${item.url}?revision=${item.revision}`;
  if (item.type === 'video') return <div className="dw-preview-frame dw-device dw-dark" data-device={device} style={{ width }}><video src={fileUrl(item.path)} controls playsInline preload="metadata" /></div>;
  if (item.type === 'image') return <div className="dw-preview-frame dw-device dw-dark" data-device={device} style={{ width }}><img src={previewUrl} alt={item.name} /></div>;
  if (item.type === 'markdown') return <div className="dw-preview-frame dw-device" data-device={device} style={{ width }}><pre className="dw-doc-text">{item.content || '（空文档）'}</pre></div>;
  if (item.projectKind === 'deck' && item.content) return <ArtifactPreview artifact={item} content={item.content} revision={item.revision} device={device} />;
  return <div className="dw-preview-frame dw-device" data-device={device} style={{ width }}><iframe key={`${item.id}:${item.revision}`} title={`${item.name} 预览`} src={previewUrl} sandbox="allow-scripts allow-downloads" loading="lazy" /></div>;
}

export function DesignCanvas({ sessionId = '', mode = 'design' }) {
  const [design, setDesign] = useState([]);
  const [videos, setVideos] = useState([]);
  const [content, setContent] = useState({});
  const [selected, setSelected] = useState(null);
  const [device, setDevice] = useState('desktop');
  const [filter, setFilter] = useState('all');
  const [state, setState] = useState({ loading: true, error: '' });
  const mounted = useRef(true);
  const load = useCallback(async () => {
    try {
      const [designState, engineState] = await Promise.all([
        api(`/design/state${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`),
        api('/state'),
      ]);
      if (!mounted.current) return;
      const artifacts = (designState.projects || []).flatMap(project => (project.artifacts || []).map(artifact => ({
        id: artifact.id, name: artifact.name, kind: artifact.kind, url: artifact.url, projectTitle: project.title,
        projectId: project.id, projectKind: project.kind, revision: artifact.revision, downloadUrl: artifact.downloadUrl, contentUrl: artifact.contentUrl,
      })));
      const outputs = [];
      for (const job of engineState.jobs || []) {
        if (job.status !== 'completed') continue;
        for (const path of outputPaths(job.result)) if (videoPattern.test(path)) outputs.push({ id: `${job.id}-${path}`, name: path.split(/[\\/]/).pop(), path, jobType: job.type });
      }
      setDesign(artifacts);
      setVideos(outputs.filter((item, index, list) => list.findIndex(other => other.path === item.path) === index));
      setState({ loading: false, error: '' });
    } catch (error) { if (mounted.current) setState({ loading: false, error: error.message }); }
  }, [sessionId]);
  useEffect(() => {
    mounted.current = true; load();
    const timer = setInterval(() => { if (!document.hidden) load(); }, 5000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [load]);
  useEffect(() => { setSelected(null); setContent({}); }, [sessionId]);

  const items = useMemo(() => {
    const artifactItems = design.map(artifact => ({ type: artifact.kind === 'svg' ? 'image' : artifact.kind === 'markdown' ? 'markdown' : 'html', ...artifact }));
    const videoItems = videos.map(video => ({ type: 'video', ...video }));
    return [...artifactItems, ...videoItems];
  }, [design, videos]);
  const visible = items.filter(item => filter === 'all' || (filter === 'videos' ? item.type === 'video' : item.type !== 'video'));
  const current = visible.find(item => item.id === selected) || visible[0] || null;
  useEffect(() => {
    if (selected !== current?.id) setSelected(current?.id || null);
  }, [selected, current?.id]);
  useEffect(() => {
    if (!current || (current.type !== 'markdown' && current.projectKind !== 'deck')) return;
    let active = true;
    api(`/design/artifacts/${encodeURIComponent(current.id)}/content`).then(result => { if (active) setContent(rows => ({ ...rows, [current.id]: result.content })); }).catch(() => {});
    return () => { active = false; };
  }, [current?.id, current?.revision]);
  const deviceButtons = <div className="dw-device-bar" role="group" aria-label="预览宽度">
    <button title="桌面预览" aria-label="桌面预览" aria-pressed={device === 'desktop'} className={device === 'desktop' ? 'selected' : ''} onClick={() => setDevice('desktop')}><Monitor size={14} /></button>
    <button title="平板预览" aria-label="平板预览" aria-pressed={device === 'tablet'} className={device === 'tablet' ? 'selected' : ''} onClick={() => setDevice('tablet')}><Tablet size={14} /></button>
    <button title="手机预览" aria-label="手机预览" aria-pressed={device === 'mobile'} className={device === 'mobile' ? 'selected' : ''} onClick={() => setDevice('mobile')}><Smartphone size={14} /></button>
  </div>;
  return <div className="dw-shell dw-canvas">
    <div className="dw-topbar">
      <div className="section-title"><Eye size={15} /><h2>作品画布</h2></div>
      <div className="dw-topbar-right">{deviceButtons}<button className="icon-button" title="刷新" aria-label="刷新" onClick={load}><RefreshCw size={16} /></button></div>
    </div>
    <div className="dw-canvas-filters" role="tablist" aria-label="画布内容">
      <button role="tab" aria-selected={filter === 'all'} className={filter === 'all' ? 'selected' : ''} onClick={() => setFilter('all')}>全部<span className="count">{items.length}</span></button>
      <button role="tab" aria-selected={filter === 'design'} className={filter === 'design' ? 'selected' : ''} onClick={() => setFilter('design')}>设计成品<span className="count">{design.length}</span></button>
      <button role="tab" aria-selected={filter === 'videos'} className={filter === 'videos' ? 'selected' : ''} onClick={() => setFilter('videos')}>视频成片<span className="count">{videos.length}</span></button>
    </div>
    {state.loading && <div className="dw-loading" role="status"><LoaderCircle size={17} className="spin" />正在读取作品与成片…</div>}
    {state.error && <div className="connection-banner" role="status"><CircleAlert size={16} /><span>画布读取失败<span className="connection-detail"> · {state.error}</span></span><Button icon={RefreshCw} variant="ghost" onClick={load}>重试</Button></div>}
    {!state.loading && !state.error && (visible.length ? <div className="dw-canvas-body">
      <div className="dw-canvas-stage">
        {current ? <>
          <div className="dw-canvas-stage-head"><div><strong>{current.name}</strong><span className="muted">{current.type === 'video' ? `视频成片 · ${kindLabel(current.jobType)}` : `${kindLabel(current.kind)} · v${current.revision}`}</span></div>
            {current.type === 'video' ? <a className="button secondary" href={fileUrl(current.path)} download={current.name}><ArrowDownToLine size={14} />下载</a>
              : <a className="button secondary" href={current.downloadUrl} download={current.name}><ArrowDownToLine size={14} />下载</a>}</div>
          <CanvasItemPreview item={{ ...current, content: content[current.id] }} device={device} />
          {current.projectTitle && <p className="dw-canvas-note"><FolderOpen size={12} />来自作品「{current.projectTitle}」</p>}
        </> : <Empty icon={Eye} title="选择一个作品预览" description="在上方选择设计成品或视频成片，即可在此预览。" />}
      </div>
      <ul className="dw-canvas-list">{visible.map(item => <li key={item.id}>
        <button className={item.id === selected ? 'selected' : ''} onClick={() => setSelected(item.id)}>
          <span className={`dw-canvas-kind ${item.type}`}>{item.type === 'video' ? <Film size={14} /> : item.type === 'image' ? <FileImage size={14} /> : item.type === 'markdown' ? <FileText size={14} /> : <Code2 size={14} />}</span>
          <span className="dw-canvas-item-name">{item.name}</span>
          <small className="mono">{item.type === 'video' ? 'MP4' : `v${item.revision}`}</small>
        </button>
      </li>)}</ul>
    </div> : <Empty icon={Eye} title="还没有可预览的作品" description="保存设计文件或完成一次视频渲染后，作品会出现在这里。" />)}
  </div>;
}
