import React, { useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, ExternalLink, Image, LoaderCircle, Pause, Play, RotateCcw } from 'lucide-react';
import Dialog from './Dialog';
import { fileUrl } from './api';
import { sourceLabel } from './templates';
import { previewUrl } from '../src/template-preview-bridge.mjs';
import './template-preview.css';

const positive = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
const dimensions = template => ({ width: positive(template.width, 1920), height: positive(template.height, 1080) });
const clock = value => {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
const sourceUrl = entry => {
  const path = typeof entry === 'string' ? entry : entry?.path;
  if (!path || !/\.html?(?:[?#]|$)/i.test(path)) return '';
  try {
    const url = new URL(path.replaceAll('\\', '/'), `${location.origin}/`);
    return url.origin === location.origin && url.pathname.startsWith('/vendor/') ? url.href : '';
  } catch { return ''; }
};

function SourcePreview({ template, onReady, onFailure, onDimensions }) {
  const frame = useRef(null);
  const viewport = useRef(null);
  const [src, setSrc] = useState('');
  const [size, setSize] = useState(dimensions(template));
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [timeline, setTimeline] = useState(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const channel = useRef(crypto.randomUUID()).current;
  const send = (type, data = {}) => frame.current?.contentWindow?.postMessage({ channel, type, ...data }, '*');
  const callbacks = useRef({ onReady, onFailure, onDimensions });
  callbacks.current = { onReady, onFailure, onDimensions };
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setBounds({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let active = true, loaded = false;
    const timeout = setTimeout(() => { if (active && !loaded) callbacks.current.onFailure(); controller.abort(); }, 15000);
    const receive = event => {
      const data = event.data;
      if (!active || event.source !== frame.current?.contentWindow || event.origin !== 'null' || data?.channel !== channel) return;
      if (data.type === 'error') { callbacks.current.onFailure(); return; }
      if (data.type === 'ready') {
        loaded = true; clearTimeout(timeout);
        const nextSize = { width: positive(data.width, template.width || 1920), height: positive(data.height, template.height || 1080) };
        if (nextSize.width > 16384 || nextSize.height > 16384) { callbacks.current.onFailure(); return; }
        setSize(nextSize); callbacks.current.onDimensions(nextSize);
        setTimeline(data.deterministic ? positive(data.duration, 12) : null);
        callbacks.current.onReady();
      }
      if (data.type === 'state') {
        if (Number.isFinite(data.time)) setTime(data.time);
        setPlaying(data.playing === true);
      }
    };
    window.addEventListener('message', receive);
    void (async () => {
      try {
        const mode = template.previewMode === 'interactive' ? 'interactive'
          : template.previewMode === 'timeline' || /motion-promo|onetake|video-shotcraft/.test(template.source || '') ? 'timeline' : 'auto';
        const url = previewUrl(sourceUrl(template.entry), {
          channel, ...dimensions(template), duration: positive(template.duration, 12), mode,
        }, location.origin);
        const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
        if (!response.ok || !/text\/html/i.test(response.headers.get('content-type') || '')) throw new Error('Source unavailable');
        if (active) setSrc(url);
      } catch { if (active && !controller.signal.aborted) callbacks.current.onFailure(); }
    })();
    return () => {
      active = false; controller.abort(); clearTimeout(timeout);
      window.removeEventListener('message', receive);
      send('dispose');
    };
  }, [channel, template.entry]);
  const scale = Math.min(bounds.width / size.width, bounds.height / size.height);
  return <>
    <div ref={viewport} className="tp-source-viewport">
      {src && <iframe ref={frame} title={`${template.name}模板源码预览`} sandbox="allow-scripts" src={src}
        style={{ width: size.width, height: size.height, transform: `scale(${scale})`, left: (bounds.width - size.width * scale) / 2, top: (bounds.height - size.height * scale) / 2 }} />}
    </div>
    {timeline && <div className="tp-controls">
      <button type="button" className="icon-button" title={playing ? '暂停' : '播放'} aria-label={playing ? '暂停' : '播放'} onClick={() => send(playing ? 'pause' : 'play')}>{playing ? <Pause size={17} /> : <Play size={17} />}</button>
      <button type="button" className="icon-button" title="重播" aria-label="重播" onClick={() => { send('seek', { time: 0 }); send('play'); }}><RotateCcw size={16} /></button>
      <input type="range" min="0" max={timeline} step="0.01" value={Math.min(time, timeline)} aria-label="预览进度"
        aria-valuetext={`${clock(time)} / ${clock(timeline)}`} onChange={event => { const next = Number(event.target.value); setTime(next); send('seek', { time: next }); }} />
      <output aria-label="预览时间">{clock(time)} / {clock(timeline)}</output>
    </div>}
  </>;
}

function VideoPreview({ template, onReady, onLoading, onFailure, onDimensions }) {
  const ref = useRef(null);
  useEffect(() => {
    const media = ref.current;
    let timeout = setTimeout(onFailure, 15000);
    const loaded = () => { clearTimeout(timeout); onReady(); };
    const waiting = () => {
      clearTimeout(timeout); onLoading();
      timeout = setTimeout(onFailure, 15000);
    };
    media.addEventListener('loadeddata', loaded);
    media.addEventListener('canplay', loaded);
    media.addEventListener('playing', loaded);
    media.addEventListener('waiting', waiting);
    return () => {
      clearTimeout(timeout);
      media.removeEventListener('loadeddata', loaded); media.removeEventListener('canplay', loaded);
      media.removeEventListener('playing', loaded); media.removeEventListener('waiting', waiting);
      media.pause(); media.removeAttribute('src'); media.load();
    };
  }, []);
  return <video ref={ref} controls playsInline preload="auto" poster={template.thumbnail || undefined} src={fileUrl(template.preview)}
    aria-label={`${template.name}视频预览`} onError={onFailure}
    onLoadedMetadata={event => {
      const media = event.currentTarget;
      if (media.videoWidth && media.videoHeight) onDimensions({ width: media.videoWidth, height: media.videoHeight });
    }} />;
}

function PreviewPlayer({ template }) {
  const entry = sourceUrl(template.entry);
  const initialMode = template.preview ? 'video' : entry ? 'source' : 'image';
  const [mode, setMode] = useState(initialMode);
  const [status, setStatus] = useState(initialMode === 'image' && !template.thumbnail ? 'error' : 'loading');
  const [notice, setNotice] = useState('');
  const [imageFailed, setImageFailed] = useState(false);
  const [size, setSize] = useState(dimensions(template));
  const [attempt, setAttempt] = useState(0);
  const ready = () => {
    setStatus('ready');
    if (mode === 'source') setNotice(current => current ? '视频暂不可用，当前显示源文件预览' : '');
  };
  const fail = () => {
    setStatus('loading');
    if (mode === 'video' && entry) {
      setMode('source'); setNotice('视频暂不可用，正在载入源文件预览');
    } else {
      setMode('image'); setNotice(mode === 'source' ? '源文件预览暂不可用' : '视频暂不可用');
      if (!template.thumbnail || imageFailed) setStatus('error');
      else if (mode === 'image') setStatus('ready');
    }
  };
  useEffect(() => {
    if (mode !== 'image' || status !== 'loading') return;
    const timeout = setTimeout(() => { setImageFailed(true); setStatus('error'); }, 15000);
    return () => clearTimeout(timeout);
  }, [mode, status]);
  const retry = () => { setImageFailed(false); setMode(initialMode); setStatus('loading'); setNotice(''); setAttempt(value => value + 1); };
  return <div className="tp-player" data-preview-mode={mode} data-preview-status={status} style={{ '--tp-ratio': `${size.width} / ${size.height}` }}>
    <div className={`tp-stage ${mode === 'source' ? 'tp-with-source' : ''}`} aria-busy={status === 'loading'}>
      {mode === 'video' && <VideoPreview key={attempt} template={template} onReady={ready} onLoading={() => setStatus('loading')} onFailure={fail} onDimensions={setSize} />}
      {mode === 'source' && <SourcePreview key={attempt} template={template} onReady={ready} onFailure={fail} onDimensions={setSize} />}
      {mode === 'image' && template.thumbnail && !imageFailed && <img key={attempt} src={template.thumbnail} alt={`${template.name}参考图`}
        onLoad={event => { const image = event.currentTarget; setSize({ width: image.naturalWidth, height: image.naturalHeight }); ready(); }}
        onError={() => { setImageFailed(true); setStatus('error'); }} />}
      {status === 'loading' && <div className="tp-state" role="status"><LoaderCircle size={22} className="spin" /><span>正在载入预览</span></div>}
      {(status === 'error' || (mode === 'image' && !template.thumbnail)) && <div className="tp-state tp-error" role="status"><Image size={27} /><span>暂无可用预览</span></div>}
    </div>
    {(notice || mode === 'image' || status === 'error') && <div className="tp-notice" role="status">
      {notice && <CircleAlert size={14} />}
      <span>{notice}{status === 'ready' && mode === 'image' ? `${notice ? '，' : ''}当前显示参考图` : !notice && status === 'error' ? '预览暂不可用' : ''}</span>
      {(notice || status === 'error') && <button type="button" className="icon-button" aria-label="重试预览" title="重试预览" onClick={retry}><RotateCcw size={15} /></button>}
    </div>}
  </div>;
}

export default function TemplatePreview({ template }) {
  return <PreviewPlayer key={`${template.id}|${template.preview || ''}|${typeof template.entry === 'string' ? template.entry : template.entry?.path || ''}`} template={template} />;
}

const textValue = value => typeof value === 'string' || typeof value === 'number' ? String(value)
  : Array.isArray(value) ? value.map(textValue).filter(Boolean).join('、') : '';
const externalUrl = value => {
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url.href : ''; } catch { return ''; }
};

export function TemplateDetail({ template, onClose, onSelect, selectedId }) {
  const selected = selectedId === template.id;
  const recommended = template.recommended || {};
  const metadata = [
    ['分类', template.category],
    ['时长', positive(template.duration, 0) ? `${positive(template.duration, 0)} 秒` : ''],
    ['推荐用途', template.recommendedUse || recommended.use || template.use],
    ['节奏', template.energy || recommended.energy],
    ['推荐配方', template.recommendedRecipe || recommended.recipe || template.recipe],
  ].map(([label, value]) => [label, textValue(value)]).filter(([, value]) => value);
  const original = externalUrl(template.sourceUrl) || externalUrl(template.homepage);
  return <Dialog title="模板预览" className="template-dialog tp-detail" onClose={onClose}>
    <div className="tp-detail-content">
      <TemplatePreview template={template} />
      <div className="tp-detail-body">
        <span className="eyebrow">{sourceLabel(template.source)}</span>
        <h2>{template.name}</h2>
        {template.description && <p>{template.description}</p>}
        {metadata.length > 0 && <dl className="tp-metadata">{metadata.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
        {(template.license || template.author) && <p className="tp-credit">{[template.license, textValue(template.author)].filter(Boolean).join(' · ')}</p>}
        {template.renderable === false && <p className="tp-requirements">参考模板 · 可预览和导入素材</p>}
        {original && <a className="tp-original" href={original} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} />查看原始来源</a>}
      </div>
    </div>
    <footer className="dialog-footer tp-detail-footer"><span>{template.subtitle || template.id}</span>
      <button type="button" className="button primary" aria-pressed={selected} onClick={() => onSelect(template)}><Check size={15} />{selected ? '取消选择' : '使用此模板'}</button>
    </footer>
  </Dialog>;
}
