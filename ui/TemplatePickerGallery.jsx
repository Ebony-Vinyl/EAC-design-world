import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Plus, Search, X } from 'lucide-react';
import { kindLabel, sourceLabel } from './templates';
import { creationKinds, scopedTemplates, recommendedTemplates } from './library-selection.mjs';
import LibraryThumbnail from './LibraryThumbnail';
import './library-picker.css';

const PAGE_SIZE = 24;
export default function TemplatePickerGallery({ templates, selectedId, onSelect, inline = false, onBrowseAll,
  designSystems = [], mode = 'edit', kind = 'website', selectedSystemId = '', onSelectSystem, onKindChange, onPreview }) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('全部');
  const [section, setSection] = useState('templates');
  const [page, setPage] = useState(0);
  const [inlineCount, setInlineCount] = useState(() => window.matchMedia('(max-width:600px)').matches ? 4 : 8);
  useEffect(() => {
    const media = window.matchMedia('(max-width:600px)');
    const update = () => setInlineCount(media.matches ? 4 : 8);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const scroller = useRef(null);
  const design = mode === 'design';
  const scoped = useMemo(() => scopedTemplates(templates, mode, kind), [templates, mode, kind]);
  const systems = design && section === 'systems' && !inline;
  const pool = systems ? designSystems : scoped;
  const categories = ['全部', ...new Set(pool.map(item => item.category).filter(Boolean))];
  const query = search.trim().toLowerCase();
  const filtered = pool.filter(item => (category === '全部' || category === item.category)
    && `${item.name} ${item.id} ${item.source || ''} ${item.description || ''} ${item.category || ''}`.toLowerCase().includes(query));
  const pages = Math.ceil(filtered.length / PAGE_SIZE);
  const currentPage = Math.min(page, Math.max(0, pages - 1));
  const visible = inline ? recommendedTemplates(templates, mode, kind, inlineCount) : filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  useEffect(() => { setPage(value => Math.min(value, Math.max(0, pages - 1))); }, [pages]);
  useEffect(() => { setCategory('全部'); setPage(0); }, [mode, kind, section]);
  useEffect(() => { setPage(0); }, [search, category]);
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 0; }, [page, kind, section, search, category]);
  return <div className={`library-picker ${inline ? 'library-inline' : ''}`} data-kind={design ? kind : 'motion'} data-section={systems ? 'systems' : 'templates'}>
    {!inline && <div className="library-picker-controls">
      {design && <div className="library-mode-tabs" role="tablist" aria-label="创作类型">{creationKinds.map(id => <button key={id} role="tab" aria-selected={kind === id} onClick={() => onKindChange?.(id)}>{kindLabel(id)}</button>)}</div>}
      <div className="library-search-row"><div className="library-search"><Search size={17} /><input aria-label="搜索模板" placeholder={systems ? '搜索设计体系…' : `搜索${kindLabel(design ? kind : 'motion')}模板…`} value={search} onChange={event => setSearch(event.target.value)} />{search && <button aria-label="清除搜索" onClick={() => setSearch('')}><X size={15} /></button>}</div>
        <select aria-label="模板分类" value={category} onChange={event => setCategory(event.target.value)}>{categories.map(value => <option key={value} value={value}>{value}</option>)}</select>
      </div>
      <div className="library-results-bar">{design ? <div className="library-section-tabs" role="tablist" aria-label="内容分区"><button role="tab" aria-selected={!systems} onClick={() => setSection('templates')}>创作模板 <span>{scoped.length}</span></button><button role="tab" aria-selected={systems} onClick={() => setSection('systems')}>设计体系 <span>{designSystems.length}</span></button></div> : <strong>视频与动效模板</strong>}<span role="status" aria-live="polite" aria-atomic="true">{filtered.length} 项</span></div>
    </div>}
    {inline && <div className="library-recommend-label"><div><strong>{kindLabel(design ? kind : 'motion')}</strong><span>{scoped.length} 个灵感起点</span></div><span>选择风格，开始创作</span></div>}
    <div className="library-picker-scroll" ref={scroller} tabIndex={inline ? undefined : 0} aria-label="模板浏览区">
      <div className="library-card-grid">{visible.map(item => {
        const selected = systems ? selectedSystemId === item.id : selectedId === item.id;
        const select = () => systems ? onSelectSystem?.(item) : onSelect(item);
        return <article key={item.id} className={`library-card ${selected ? 'selected' : ''}`} data-template-kind={systems ? 'design-system' : item.kind || 'motion'}>
          <button className="library-card-cover" aria-label={`${systems ? '选择' : '预览'}${item.name}`} onClick={() => systems ? select() : onPreview?.(item)}><LibraryThumbnail item={item} system={systems} />{selected && <span className="library-selected"><Check size={13} /></span>}<span className="library-cover-action">{systems ? '使用体系' : '查看预览'} <ArrowRight size={12} /></span></button>
          <div className="library-card-caption"><div><h3 title={item.name}>{item.name}</h3>{!inline && <p>{systems ? item.category : kindLabel(item.kind || 'motion')} · {sourceLabel(item.source)}</p>}</div><button className="library-select" title={`${selected ? '取消选择' : '选择'}${item.name}`} aria-label={`${selected ? '取消选择' : '选择'}${item.name}`} aria-pressed={selected} onClick={select}>{selected ? <Check size={15} /> : <Plus size={15} />}{inline && <span>{selected ? '已选择' : '选择'}</span>}</button></div>
        </article>;
      })}</div>
      {!visible.length && <div className="library-no-results"><Search size={22} /><strong>没有匹配的内容</strong><p>换个关键词或分类试试。</p>{(search || category !== '全部') && <button className="button secondary" onClick={() => { setSearch(''); setCategory('全部'); }}><X size={14} />清除筛选</button>}</div>}
    </div>
    {!inline && pages > 1 && <div className="library-pagination"><span>每页 {PAGE_SIZE} 项 · 第 {currentPage + 1} / {pages} 页</span><div><button aria-label="上一页模板" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ArrowLeft size={15} />上一页</button><button aria-label="下一页模板" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>下一页<ArrowRight size={15} /></button></div></div>}
    {inline && <footer className="library-inline-footer"><button className="library-browse-all" onClick={onBrowseAll}>浏览全部{design ? kindLabel(kind) : ''}模板<ArrowRight size={15} /></button></footer>}
  </div>;
}
