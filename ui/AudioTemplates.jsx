import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AudioLines, Check, CircleAlert, Download, HardDrive, LoaderCircle, Play, RefreshCw, Sparkles } from 'lucide-react';
import { api } from './api';

const formatBytes = bytes => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
const heights = [18, 30, 44, 28, 60, 82, 48, 72, 96, 56, 38, 70, 44, 24, 54, 78, 42, 60, 30, 18];

function VoiceCard({ template, installation, action, onAction }) {
  const audio = useRef(null);
  const wantsPreview = useRef(false);
  const [playError, setPlayError] = useState('');
  const mambo = template.id === 'mambo-zh';
  const installing = mambo && installation?.status === 'running';
  const previewing = template.preview?.status === 'running';
  useEffect(() => {
    if (template.sampleUrl && wantsPreview.current && audio.current) {
      wantsPreview.current = false;
      audio.current.play().catch(() => setPlayError('试听已就绪，点击播放器播放。'));
    }
  }, [template.sampleUrl]);
  const preview = async () => {
    setPlayError('');
    if (template.sampleUrl) { try { await audio.current.play(); } catch { setPlayError('点击播放器播放试听。'); } }
    else { wantsPreview.current = true; await onAction(template.id, 'preview'); }
  };
  return <article className={`audio-template-card ${mambo ? 'mambo' : 'system'} ${template.selected ? 'selected' : ''}`} aria-label={template.name}>
    <div className="audio-template-art" aria-hidden="true"><div className="audio-art-orbit" /><div className="audio-art-icon">{mambo ? <Sparkles size={26} /> : <AudioLines size={26} />}</div><div className="audio-art-wave">{heights.map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div><span className="audio-art-caption">{mambo ? 'MAMBO · 中文' : 'DEFAULT · 系统声音'}</span></div>
    <div className="audio-template-body"><div className="audio-template-title"><div><span className="eyebrow">{mambo ? '本地音色' : '系统内置'}</span><h2>{template.name}</h2></div>{template.selected && <span className="audio-selected"><Check size={13} />当前默认</span>}</div>
      <p>{mambo ? '使用已确认的曼波中文音色，让文案多一点轻快与活力。' : '使用电脑当前的默认语音，适合日常旁白与快速制作。'}</p>
      <div className="audio-local-status"><HardDrive size={14} /><span>{template.installed ? mambo ? '已下载到本地 · 可离线使用' : '无需下载 · 即选即用' : mambo ? `需下载到本地 · 模型约 ${formatBytes(template.downloadBytes)}` : '当前系统不支持系统语音'}</span></div>
      {installing && <div className="audio-install-progress" role="status" aria-live="polite"><div><LoaderCircle size={14} className="spin" /><span>{installation.detail}</span></div>{installation.phase === 'downloading' && <><progress aria-label="曼波模型下载进度" value={installation.preparedBytes} max={installation.totalBytes} /><small>{formatBytes(installation.preparedBytes)} / {formatBytes(installation.totalBytes)}</small></>}</div>}
      {mambo && !template.installed && installation?.status === 'failed' && <p className="inline-error" role="alert"><CircleAlert size={14} />{installation.error}</p>}
      {mambo && !template.installed && installation?.status === 'cancelled' && <p className="muted">已取消下载，重试时会复用已下载资源。</p>}
      {template.preview?.status === 'failed' && <p className="inline-error" role="alert">{template.preview.error}</p>}
      <div className="audio-template-actions"><button className="button secondary" disabled={!template.installed || previewing || Boolean(action)} onClick={preview}>{previewing ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}{previewing ? '正在生成试听' : '试听音色'}</button>
        {template.installed ? <button className={`button ${template.selected ? 'secondary' : 'primary'}`} disabled={template.selected || Boolean(action)} onClick={() => onAction(template.id, 'select')}><Check size={15} />{template.selected ? '当前使用' : '设为默认'}</button>
          : mambo && (installing ? <button className="button ghost" disabled={Boolean(action)} onClick={() => onAction(template.id, 'cancel')}>取消下载</button> : <button className="button primary" disabled={Boolean(action)} onClick={() => onAction(template.id, 'install')}><Download size={15} />{installation && ['failed', 'cancelled'].includes(installation.status) ? '重试下载' : '下载到本地'}</button>)}</div>
      {template.sampleUrl && <audio ref={audio} aria-label={`${template.name}试听`} controls preload="metadata" src={template.sampleUrl} onError={() => setPlayError('试听暂不可播放，请重试生成。')} />}
      {playError && <small className="muted" role="status">{playError}</small>}
    </div>
  </article>;
}

export default function AudioTemplates({ onChanged, notify }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [action, setAction] = useState('');
  const mounted = useRef(false), inFlight = useRef(false), actionLock = useRef(false), controller = useRef(null), revision = useRef(0);
  const refresh = useCallback(async () => {
    if (inFlight.current || actionLock.current) return;
    inFlight.current = true;
    const requestedRevision = revision.current;
    controller.current = new AbortController();
    try { const result = await api('/audio-templates', { signal: controller.current.signal }); if (mounted.current && revision.current === requestedRevision) { setData(result); setError(''); } }
    catch (err) { if (mounted.current && revision.current === requestedRevision && err.name !== 'AbortError') setError(err.message); }
    finally { inFlight.current = false; }
  }, []);
  useEffect(() => {
    mounted.current = true; refresh();
    const timer = setInterval(() => { if (!document.hidden) refresh(); }, 2000);
    return () => { mounted.current = false; clearInterval(timer); controller.current?.abort(); };
  }, [refresh]);
  const mutate = async (id, method) => {
    if (actionLock.current) return;
    revision.current++;
    actionLock.current = true; setAction(`${id}:${method}`); setError('');
    try {
      const result = await api(`/audio-templates/${id}/${method}`, { method: 'POST', body: {} });
      if (!mounted.current) return;
      setData(result);
      if (method === 'select') { await onChanged?.(); notify?.(`${id === 'default' ? '默认音色' : '曼波中文'}已设为默认配音`); }
    } catch (err) { if (mounted.current) setError(err.message); }
    finally { actionLock.current = false; if (mounted.current) setAction(''); }
  };
  return <div className="audio-template-workspace">
    <div className="audio-template-toolbar"><span className="muted">{data?.templates?.length || 2} 款音色 · 选择后用于后续旁白制作</span><button className="button ghost" onClick={refresh} aria-label="刷新音频模板"><RefreshCw size={15} />刷新</button></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!data && !error && <div className="audio-template-loading" role="status"><LoaderCircle size={20} className="spin" />正在读取本地音色…</div>}
    <div className="audio-template-grid">{data?.templates?.map(template => <VoiceCard key={template.id} template={template} installation={data.installation} action={action} onAction={mutate} />)}</div>
    <div className="audio-template-note"><HardDrive size={17} /><div><strong>声音留在你的电脑上</strong><p>默认音色使用系统语音。曼波首次需要联网下载模型和运行依赖，并需要 Python 3.12；安装完成后，配音在本地生成。</p></div></div>
  </div>;
}
