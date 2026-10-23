import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Bookmark, BookmarkCheck, Check, Copy, Download, Film, ListFilter, Plus, Search, Star, Trash2, X } from 'lucide-react';
import { kindLabel, sourceLabel } from './templates';
import { creationKinds, scopedTemplates, recommendedTemplates, matchesTemplate, formatDuration, readShotlist, shotlistText } from './library-selection.mjs';
import LibraryThumbnail from './LibraryThumbnail';
import MotionThumbnail, { MotionThumbnailProvider } from './MotionThumbnail';
import './library-picker.css';
import './shot-picker.css';

const PAGE_SIZE = 24;
export default function TemplatePickerGallery({ templates, selectedId, onSelect, inline = false, onBrowseAll,
  designSystems = [], mode = 'edit', kind = 'website', selectedSystemId = '', onSelectSystem, onKindChange, onPreview, previewOpen = false, onImportShots }) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('全部');
  const [section, setSection] = useState('templates');
  const [page, setPage] = useState(0);
  const [source, setSource] = useState('all');
  const [collection, setCollection] = useState('all');
  const [notice, setNotice] = useState('');
  const [importing, setImporting] = useState(false);
  const [savedIds, setSavedIds] = useState(() => {
    try { return readShotlist(localStorage.getItem('eac:shotlist')); } catch { return []; }
  });
  const [autoplay, setAutoplay] = useState(() => {
    try {
      return !window.matchMedia('(prefers-reduced-motion:reduce)').matches && !navigator.connection?.saveData
        && localStorage.getItem('eac:preview-autoplay') !== '0';
    } catch { return false; }
  });
  const [inlineCount, setInlineCount] = useState(() => window.matchMedia('(max-width:600px)').matches ? 4 : 8);
  useEffect(() => {
    const media = window.matchMedia('(max-width:600px)');
    const update = () => setInlineCount(media.matches ? 4 : 8);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const scroller = useRef(null);
  const sourceTabs = useRef(null);
  const noticeTimer = useRef(0);
  const design = mode === 'design';
  const scoped = useMemo(() => scopedTemplates(templates, mode, kind), [templates, mode, kind]);
  const systems = design && section === 'systems' && !inline;
  const motion = !systems && (!design || kind === 'motion');
  const pool = systems ? designSystems : scoped;
  const sources = useMemo(() => [...new Set(pool.map(item => item.source).filter(Boolean))], [pool]);
  const effectiveSource = sources.includes(source) ? source : 'all';
  const sourcePool = effectiveSource === 'all' ? pool : pool.filter(item => item.source === effectiveSource);
  const categories = ['全部', ...new Set(sourcePool.map(item => item.category).filter(Boolean))];
  const effectiveCategory = categories.includes(category) ? category : '全部';
  const saved = useMemo(() => new Set(savedIds), [savedIds]);
  const savedItems = useMemo(() => savedIds.map(id => templates.find(item => item.id === id)).filter(Boolean), [savedIds, templates]);
  const selectedItem = pool.find(item => item.id === (systems ? selectedSystemId : selectedId));
  const filtered = sourcePool.filter(item => (effectiveCategory === '全部' || effectiveCategory === item.category)
    && (!motion || collection === 'all' || (collection === 'saved' ? saved.has(item.id) : item.recommended))
    && matchesTemplate(item, search));
  const pages = Math.ceil(filtered.length / PAGE_SIZE);
  const currentPage = Math.min(page, Math.max(0, pages - 1));
  const visible = inline ? recommendedTemplates(templates, mode, kind, inlineCount) : filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  useEffect(() => { setPage(value => Math.min(value, Math.max(0, pages - 1))); }, [pages]);
  useEffect(() => { setCategory('全部'); setPage(0); setCollection('all'); setSource('all'); }, [mode, kind, section]);
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('source');
    if (requested && !inline) setSource(requested);
  }, []);
  useEffect(() => {
    const element = sourceTabs.current;
    if (!element) return;
    const reveal = () => {
      const active = element.querySelector('[aria-pressed=true]');
      if (!active) return;
      const bounds = element.getBoundingClientRect();
      const button = active.getBoundingClientRect();
      if (button.left < bounds.left || button.right > bounds.right) {
        element.scrollLeft += button.left - bounds.left - (element.clientWidth - button.width) / 2;
      }
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(element);
    return () => observer.disconnect();
  }, [effectiveSource, sources.length, motion, inline]);
  useEffect(() => { setPage(0); }, [search, category, source, collection]);
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 0; }, [page, kind, section, search, category, source, collection]);
  useEffect(() => {
    try { localStorage.setItem('eac:shotlist', JSON.stringify(savedIds)); } catch { /* The current selection still works without storage. */ }
  }, [savedIds]);
  useEffect(() => {
    const sync = event => { if (event.key === 'eac:shotlist') setSavedIds(readShotlist(event.newValue)); };
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener('storage', sync); window.clearTimeout(noticeTimer.current); };
  }, []);
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion:reduce)');
    const change = () => { if (preference.matches) setAutoplay(false); };
    preference.addEventListener('change', change);
    return () => preference.removeEventListener('change', change);
  }, []);
  const announce = message => {
    setNotice(message);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(''), 4000);
  };
  const toggleSaved = item => setSavedIds(current => current.includes(item.id) ? current.filter(id => id !== item.id) : [...current, item.id]);
  const reset = () => { setSearch(''); setCategory('全部'); setCollection('all'); setSource('all'); setPage(0); };
  const exportList = () => {
    const blob = new Blob([shotlistText(savedItems)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = 'eac-shotlist.txt'; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(shotlistText(savedItems)); announce(`已复制 ${savedItems.length} 个镜头`); }
    catch { exportList(); announce('选片单已下载'); }
  };
  const importShots = async () => {
    if (importing) return;
    const footage = savedItems.filter(item => item.source === 'video-shotcraft' && item.preview);
    if (!footage.length) return;
    setImporting(true);
    try {
      const result = await onImportShots(footage);
      if (result !== false) announce(`已导入 ${footage.length} 个镜头`);
    } catch (error) { announce(error.message || '镜头导入失败'); }
    finally { setImporting(false); }
  };
  return <MotionThumbnailProvider autoplay={autoplay && !inline && motion} suspended={previewOpen}>
    <div className={`library-picker ${inline ? 'library-inline' : ''} ${motion ? 'library-is-motion' : ''}`} data-source={effectiveSource} data-kind={design ? kind : 'motion'} data-section={systems ? 'systems' : 'templates'}>
    {!inline && <div className="library-picker-controls">
      {design && <div className="library-mode-tabs" role="tablist" aria-label="创作类型">{creationKinds.map(id => <button key={id} role="tab" aria-selected={kind === id} onClick={() => onKindChange?.(id)}>{kindLabel(id)}</button>)}</div>}
      {motion && <div className="library-motion-heading"><div><Film size={18} /><strong>镜头与动效</strong><span>{scoped.length} 个模板</span></div><label className="library-autoplay"><input type="checkbox" role="switch" aria-label="自动播放预览" checked={autoplay} onChange={event => {
        setAutoplay(event.target.checked);
        try { localStorage.setItem('eac:preview-autoplay', event.target.checked ? '1' : '0'); } catch { /* Optional preference. */ }
      }} /><span>自动预览</span></label></div>}
      <div className="library-search-row"><div className="library-search"><Search size={17} /><input aria-label="搜索模板" placeholder={systems ? '搜索设计体系…' : motion ? '搜索镜头、动效、用途…' : `搜索${kindLabel(kind)}模板…`} value={search} onChange={event => setSearch(event.target.value)} />{search && <button type="button" aria-label="清除搜索" onClick={() => setSearch('')}><X size={15} /></button>}</div>
        <select aria-label="模板分类" value={effectiveCategory} onChange={event => setCategory(event.target.value)}>{categories.map(value => <option key={value} value={value}>{value}</option>)}</select>
      </div>
      {motion && sources.length > 1 && <div ref={sourceTabs} className="library-source-tabs" role="group" aria-label="模板来源">
        {['all', ...sources].map(value => <button key={value} type="button" aria-pressed={effectiveSource === value} onClick={() => { setSource(value); setCategory('全部'); }}>
          {value === 'all' ? '全部来源' : sourceLabel(value)}<span>{value === 'all' ? pool.length : pool.filter(item => item.source === value).length}</span>
        </button>)}
      </div>}
      {motion && effectiveSource === 'video-shotcraft' && <div className="library-category-chips" role="group" aria-label="镜头分类">{categories.map(value => <button key={value} type="button" aria-pressed={effectiveCategory === value} onClick={() => setCategory(value)}>{value}<span>{value === '全部' ? sourcePool.length : sourcePool.filter(item => item.category === value).length}</span></button>)}</div>}
      <div className="library-results-bar">{design ? <div className="library-section-tabs" role="tablist" aria-label="内容分区"><button role="tab" aria-selected={!systems} onClick={() => setSection('templates')}>创作模板 <span>{scoped.length}</span></button><button role="tab" aria-selected={systems} onClick={() => setSection('systems')}>设计体系 <span>{designSystems.length}</span></button></div> : <div className="library-collection-tabs" role="group" aria-label="镜头视图">
        <button type="button" aria-pressed={collection === 'all'} onClick={() => setCollection('all')}>全部</button>
        <button type="button" aria-pressed={collection === 'recommended'} onClick={() => setCollection('recommended')}><Star size={12} />精选</button>
        <button type="button" aria-pressed={collection === 'saved'} onClick={() => setCollection('saved')}><Bookmark size={12} />选片单 <span>{savedItems.length}</span></button>
      </div>}<span role="status" aria-live="polite" aria-atomic="true">{filtered.length} 项</span></div>
      {design && motion && <div className="library-collection-tabs library-design-collection" role="group" aria-label="镜头视图">{[['all', '全部'], ['recommended', '精选'], ['saved', `选片单 ${savedItems.length}`]].map(([value, label]) => <button type="button" key={value} aria-pressed={collection === value} onClick={() => setCollection(value)}>{label}</button>)}</div>}
    </div>}
    {inline && <div className="library-recommend-label"><div><strong>{kindLabel(design ? kind : 'motion')}</strong><span>{scoped.length} 个灵感起点</span></div><span>选择风格，开始创作</span></div>}
    <div className="library-picker-scroll" ref={scroller} tabIndex={inline ? undefined : 0} aria-label="模板浏览区">
      <div className="library-card-grid">{visible.map((item, index) => {
        const selected = systems ? selectedSystemId === item.id : selectedId === item.id;
        const select = () => systems ? onSelectSystem?.(item) : onSelect(item);
        return <article key={item.id} className={`library-card ${selected ? 'selected' : ''} ${saved.has(item.id) ? 'in-shotlist' : ''}`} data-template-kind={systems ? 'design-system' : item.kind || 'motion'} style={{ '--i': index }}>
          <div className="library-card-visual"><button type="button" className="library-card-cover" aria-label={`${systems ? '选择' : '预览'}${item.name}`} onClick={() => systems ? select() : onPreview?.(item)}><LibraryThumbnail item={item} system={systems} />{motion && <MotionThumbnail item={item} />}{selected && <span className="library-selected"><Check size={13} /></span>}
            {motion && !inline && <><span className="library-card-category">{item.category}</span>{item.recommended && <span className="library-curated"><Star size={10} fill="currentColor" />精选</span>}{formatDuration(item.duration) && <span className="library-card-duration">{formatDuration(item.duration)}</span>}</>}
            <span className="library-cover-action">{systems ? '使用体系' : '查看预览'} <ArrowRight size={12} /></span></button>
            {motion && !inline && <button type="button" className="library-bookmark" title={`${saved.has(item.id) ? '移出' : '加入'}选片单`} aria-label={`${saved.has(item.id) ? '移出' : '加入'}选片单${item.name}`} aria-pressed={saved.has(item.id)} onClick={() => toggleSaved(item)}>{saved.has(item.id) ? <BookmarkCheck size={16} /> : <Bookmark size={16} />}</button>}
          </div>
          <div className="library-card-caption"><div><h3 title={item.name}>{item.name}</h3>{!inline && <p>{systems ? item.category : kindLabel(item.kind || 'motion')} · {sourceLabel(item.source)}</p>}</div><button className="library-select" title={`${selected ? '取消选择' : '选择'}${item.name}`} aria-label={`${selected ? '取消选择' : '选择'}${item.name}`} aria-pressed={selected} onClick={select}>{selected ? <Check size={15} /> : <Plus size={15} />}{inline && <span>{selected ? '已选择' : '选择'}</span>}</button></div>
          {motion && !inline && <p className="library-card-description" title={item.description}>{item.description}</p>}
        </article>;
      })}</div>
      {!visible.length && <div className="library-no-results">{collection === 'saved' ? <Bookmark size={22} /> : <Search size={22} />}<strong>没有匹配的内容</strong><p>{collection === 'saved' && !savedItems.length ? '选片单为空' : '换个关键词或分类试试。'}</p>{(search || effectiveCategory !== '全部' || effectiveSource !== 'all' || collection !== 'all') && <button className="button secondary" onClick={reset}><X size={14} />清除筛选</button>}</div>}
    </div>
    {!inline && pages > 1 && <div className="library-pagination"><span>每页 {PAGE_SIZE} 项 · 第 {currentPage + 1} / {pages} 页</span><div><button aria-label="上一页模板" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ArrowLeft size={15} />上一页</button><button aria-label="下一页模板" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>下一页<ArrowRight size={15} /></button></div></div>}
    {motion && !inline && <footer className="library-shotlist-bar">
      <div className="library-shotlist-summary"><Bookmark size={15} /><strong>选片单 <span>{savedItems.length}</span></strong>{selectedItem && <span className="library-current-choice" title={selectedItem.name}><Check size={12} />{selectedItem.name}</span>}</div>
      {savedItems.length > 0 && <div className="library-shotlist-chips">{savedItems.map(item => <button type="button" key={item.id} title={`移出选片单${item.name}`} aria-label={`移出已选镜头${item.name}`} onClick={() => toggleSaved(item)}>{item.name}<X size={11} /></button>)}</div>}
      <div className="library-shotlist-actions">
        <button type="button" title="加入当前页" aria-label="加入当前页到选片单" disabled={!visible.some(item => !saved.has(item.id))} onClick={() => setSavedIds(current => [...new Set([...current, ...visible.map(item => item.id)])])}><ListFilter size={14} /><span>加入本页</span></button>
        <button type="button" title="清空选片单" aria-label="清空选片单" disabled={!savedItems.length} onClick={() => setSavedIds([])}><Trash2 size={14} /></button>
        <button type="button" title="下载选片单" aria-label="下载选片单" disabled={!savedItems.length} onClick={exportList}><Download size={14} /></button>
        {onImportShots && <button type="button" className="library-shotlist-import" title="导入选片到项目素材" aria-label="导入选片到项目素材" disabled={importing || !savedItems.some(item => item.source === 'video-shotcraft' && item.preview)} onClick={importShots}><Film size={14} /><span>{importing ? '导入中' : '导入素材'}</span></button>}
        <button type="button" className="library-copy-list" disabled={!savedItems.length} onClick={copy}><Copy size={14} /><span>复制名单</span></button>
      </div>
      {notice && <span className="library-shotlist-notice" role="status">{notice}</span>}
    </footer>}
    {inline && <footer className="library-inline-footer"><button className="library-browse-all" onClick={onBrowseAll}>浏览全部{design ? kindLabel(kind) : ''}模板<ArrowRight size={15} /></button></footer>}
  </div></MotionThumbnailProvider>;
}
