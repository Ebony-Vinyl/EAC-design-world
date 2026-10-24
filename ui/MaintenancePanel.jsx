import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CircleAlert, CircleCheck, Download, ExternalLink, History, LoaderCircle, Megaphone,
  Package, RefreshCw, RotateCcw, ShieldAlert, Wrench,
} from 'lucide-react';
import { api } from './api';
import './maintenance.css';

/**
 * 插件维护面板：更新、热重载与公告。宿主（main.jsx）负责挂载位置。
 * 所有变更都必须由用户明确点击触发——这里从不自动安装或自动重载。
 */

const POLL_MS = 4000;
// 空闲时的状态重读间隔：后端按 feedPollMinutes / updateCheckHours 自己刷新，界面只需跟上。
const IDLE_POLL_MS = 60000;
// 热重载会短暂断开本地服务；这段时间内的读取失败不算错误，只提示正在重连。
const RELOAD_TIMEOUT_MS = 90000;

const PHASE_LABEL = {
  download: '正在下载新版本…', install: '正在安装文件…', reload: '正在应用新版本…',
  installing: '正在安装文件…', activating: '正在应用新版本…',
};
const OPERATION_LABEL = { check: '检查更新', apply: '安装更新', reload: '热重载', rollback: '回滚备份', local: '本地安装' };
const LEVEL_LABEL = { info: '通知', update: '更新', warn: '注意', urgent: '重要' };
const OPERATION_STATE = { running: '进行中', completed: '已完成', failed: '失败' };

const clean = value => typeof value === 'string' && value.trim() !== '' ? value.trim() : '';

/** 只接受 http(s) 与页内锚点；其余协议一律不渲染。 */
export function safeLink(url) {
  const value = String(url ?? '').trim();
  if (value === '' || value.length > 2000) return undefined;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^#/.test(value)) return value;
  return undefined;
}

function formatTime(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  try { return new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

function progressPercent(progress) {
  if (typeof progress === 'number') return progress <= 1 ? Math.round(progress * 100) : Math.round(progress);
  if (progress && typeof progress === 'object') {
    const done = Number(progress.done);
    const total = Number(progress.total);
    if (Number.isFinite(done) && Number.isFinite(total) && total > 0) return Math.round((done / total) * 100);
  }
  return null;
}

// ── 公告 HTML：DOMParser 惰性解析 + 白名单，绝不使用 dangerouslySetInnerHTML ──
// DOMParser 解析出的文档不执行脚本、不加载脚本资源；随后只把白名单内的标签与
// 属性映射成 React 元素，事件属性一律忽略，因此公告内容无法变成脚本执行。

const ALLOWED_TAGS = new Set(['a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'dd', 'del',
  'details', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'small', 'span',
  'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul']);
const DROP_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template',
  'textarea', 'title', 'svg', 'math', 'form', 'input', 'button', 'select', 'option', 'video', 'audio',
  'canvas', 'link', 'meta', 'base']);
const ALLOWED_STYLE = new Set(['color', 'background-color', 'text-align', 'font-weight', 'font-style', 'text-decoration']);
const STYLE_CAMEL = {
  'background-color': 'backgroundColor', 'text-align': 'textAlign', 'font-weight': 'fontWeight',
  'font-style': 'fontStyle', 'text-decoration': 'textDecoration', color: 'color',
};

function safeStyle(raw) {
  const out = {};
  for (const decl of String(raw ?? '').split(';')) {
    const idx = decl.indexOf(':');
    if (idx === -1) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const value = decl.slice(idx + 1).trim();
    if (!ALLOWED_STYLE.has(prop) || value === '' || value.length > 120) continue;
    if (/url\(|expression|javascript:|@|<|>/i.test(value)) continue;
    out[STYLE_CAMEL[prop]] = value;
  }
  return out;
}

function elementProps(tag, node) {
  const props = {};
  for (const attr of node.attributes) {
    const name = attr.name.toLowerCase();
    const value = attr.value;
    if (name === 'style') { const style = safeStyle(value); if (Object.keys(style).length > 0) props.style = style; continue; }
    if (tag === 'a' && name === 'href') {
      const url = safeLink(value);
      if (url !== undefined) { props.href = url; props.target = '_blank'; props.rel = 'noopener noreferrer'; }
      continue;
    }
    if (tag === 'img' && name === 'src') {
      const url = safeLink(value) ?? (/^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(value.trim()) ? value.trim() : undefined);
      if (url !== undefined) props.src = url;
      continue;
    }
    if ((tag === 'img' || tag === 'a') && name === 'title') { props.title = value.slice(0, 300); continue; }
    if (tag === 'img' && name === 'alt') { props.alt = value.slice(0, 300); continue; }
    if ((name === 'width' || name === 'height') && /^\d{1,4}$/.test(value)) props[name] = Number(value);
  }
  if (tag === 'img' && props.src === undefined) return null;
  return props;
}

function mapChildren(parent) {
  const out = [];
  for (const node of parent.childNodes) {
    if (node.nodeType === 3) { if (node.nodeValue) out.push(node.nodeValue); continue; }
    if (node.nodeType !== 1) continue;
    const tag = node.tagName.toLowerCase();
    if (DROP_TAGS.has(tag)) continue;
    if (!ALLOWED_TAGS.has(tag)) { out.push(...mapChildren(node)); continue; }
    const props = elementProps(tag, node);
    if (props === null) continue;
    out.push(React.createElement(tag, { key: out.length, ...props }, ...mapChildren(node)));
  }
  return out;
}

/** 将公告 HTML 解析为 React 子节点数组；无 DOM 环境（如测试）时降级为去除标签的纯文本。 */
export function safeHtmlNodes(html) {
  if (typeof html !== 'string' || html.trim() === '') return [];
  if (typeof DOMParser === 'undefined') {
    const text = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return text === '' ? [] : [text];
  }
  try { return mapChildren(new DOMParser().parseFromString(html, 'text/html').body); }
  catch { return []; }
}

// ── 小组件 ────────────────────────────────────────────────────────────────

function PanelButton({ icon: Icon, children, variant = '', busy, disabled, ...props }) {
  return <button type="button" className={`button mt-button ${variant}`} disabled={busy === true || disabled === true} {...props}>
    {busy ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : Icon ? <Icon size={15} aria-hidden="true" /> : null}
    {children}
  </button>;
}

function Pill({ tone = '', children, title }) {
  return <span className={`mt-pill ${tone}`} title={title}>{children}</span>;
}

function Section({ icon: Icon, title, hint, actions, children }) {
  return <section className="mt-section">
    <header className="mt-section-head">
      <div className="mt-section-title">{Icon && <Icon size={16} aria-hidden="true" />}<h2>{title}</h2>{hint && <p>{hint}</p>}</div>
      {actions && <div className="mt-section-actions">{actions}</div>}
    </header>
    {children}
  </section>;
}

function AnnouncementItem({ item, busy, onAck }) {
  const body = useMemo(() => safeHtmlNodes(item.html ?? ''), [item.html]);
  const link = item.link ? safeLink(item.link.url) : undefined;
  const unread = item.acked !== true;
  const level = ['info', 'update', 'warn', 'urgent'].includes(item.level) ? item.level : 'info';
  return <article className={`mt-announcement ${unread ? 'unread' : ''}`}>
    <div className="mt-announcement-head">
      <span className={`mt-level ${level}`}>{LEVEL_LABEL[level]}</span>
      <h3>{item.title}</h3>
      {item.pinned === true && <span className="mt-pin" title="置顶公告" aria-label="置顶公告">置顶</span>}
      <span className="mt-announcement-time">{formatTime(item.createdAt)}</span>
      {unread && <PanelButton icon={CircleCheck} busy={busy} onClick={onAck} aria-label={`将公告「${item.title}」标记为已读`}>标记已读</PanelButton>}
    </div>
    {body.length > 0 && <div className="mt-announcement-body">{body}</div>}
    {link && <a className="mt-announcement-link" href={link} target="_blank" rel="noopener noreferrer">{item.link.label || '查看详情'}<ExternalLink size={13} aria-hidden="true" /></a>}
  </article>;
}

// 供测试直接验证白名单映射；不影响组件本身。
export { mapChildren, elementProps };

// ── 主面板 ────────────────────────────────────────────────────────────────

export default function MaintenancePanel({ notify, initialStatus = null }) {
  const [status, setStatus] = useState(initialStatus);
  const [error, setError] = useState('');
  const [reconnectNote, setReconnectNote] = useState('');
  const [action, setAction] = useState('');
  const [reloadState, setReloadState] = useState('idle'); // idle | waiting | confirmed | timeout
  const [confirmApply, setConfirmApply] = useState(false);
  const [rollbackConfirmed, setRollbackConfirmed] = useState(false);
  const [localManifest, setLocalManifest] = useState('');
  const [allowUnsigned, setAllowUnsigned] = useState(false);
  // 本地安装的一次性确认令牌失效时的可操作提示（令牌 60 秒过期、消费一次即失效）。
  const [localTokenHint, setLocalTokenHint] = useState('');
  const [settingsDraft, setSettingsDraft] = useState({ autoReloadWatch: false, feedPollMinutes: '', updateCheckHours: '' });
  const alive = useRef(true);
  // 以 operation 记录为准确认结果：失败回滚同样会更换实例，只有操作本身成功才算成功。
  const pendingOp = useRef(null);
  // 错误来源：连接/轮询错误会在下次成功读取时清除，用户操作错误保留到下次操作。
  const errorSource = useRef('');
  // 宿主可能每次渲染都传入新的 notify；用 ref 固定，避免 load/run 反复重建。
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const fail = useCallback(message => { errorSource.current = 'action'; setError(message); }, []);

  const load = useCallback(async () => {
    try {
      const data = await api('/maintenance');
      if (!alive.current) return;
      setStatus(data);
      setReconnectNote('');
      let nextError = '';
      let resolved = false;
      const pending = pendingOp.current;
      const op = data?.operation;
      if (pending && op && op.id === pending.id && op.status !== 'running') {
        pendingOp.current = null;
        resolved = true;
        if (op.status === 'failed') {
          // 失败立即结束等待并显示原因，不必等超时。
          if (pending.type === 'reload') setReloadState('idle');
          nextError = `${OPERATION_LABEL[pending.type] || '维护操作'}失败：${op.error || '未知原因'}`;
        } else {
          const version = clean(op.result?.version);
          if (pending.type === 'reload') {
            if (op.result?.ok === false) {
              setReloadState('idle');
              nextError = '热重载未能生效，旧代码仍在运行。';
            } else if (pending.expected && version && version !== pending.expected) {
              setReloadState('idle');
              nextError = `热重载后的版本（${version}）与磁盘版本（${pending.expected}）不一致，请重启应用确认。`;
            } else {
              setReloadState('confirmed');
              notifyRef.current?.(`插件已热重载，当前运行版本 ${version || clean(data?.runningVersion) || '—'}`);
            }
          } else if (pending.expected && version && version !== pending.expected) {
            nextError = `${OPERATION_LABEL[pending.type] || '维护操作'}结果版本（${version}）与目标版本（${pending.expected}）不一致，请检查安装状态。`;
          }
        }
      }
      if (pending && pendingOp.current === pending && pending.type === 'reload' && Date.now() - pending.at > RELOAD_TIMEOUT_MS) {
        pendingOp.current = null;
        setReloadState('timeout');
      }
      // 轮询成功时清除连接类错误；用户操作产生的错误保留，直到下一次操作。
      if (nextError !== '') { errorSource.current = 'operation'; setError(nextError); }
      else if (resolved || errorSource.current === 'connection') { errorSource.current = ''; setError(''); }
    } catch (err) {
      if (!alive.current) return;
      // 保留上一次成功读取的内容；失败只作为提示，不清空面板。
      if (pendingOp.current) setReconnectNote('正在等待插件重载完成，本地服务短暂不可用…');
      else { errorSource.current = 'connection'; setError(err?.message || '无法读取维护状态。'); }
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    load();
    return () => { alive.current = false; };
  }, [load]);

  const updates = status?.updates ?? {};
  const notesBody = useMemo(() => safeHtmlNodes(typeof updates.notes === 'string' ? updates.notes : ''), [updates.notes]);
  const announcements = status?.announcements ?? {};
  const busyState = status?.busy ?? {};
  const reload = status?.reload ?? {};
  const operation = status?.operation ?? null;
  const settings = status?.settings ?? {};
  const activeJobs = Number(busyState.activeJobs) || 0;
  const operationRunning = busyState.operation === true || operation?.status === 'running';
  const busy = operationRunning || activeJobs > 0 || updates.applying === true;
  const shouldPoll = busy || reloadState === 'waiting' || action !== '';

  useEffect(() => {
    if (!shouldPoll) return undefined;
    const timer = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
    const onVisible = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [shouldPoll, load]);

  // 空闲时也要定期重读状态：后端按自己的周期拉取公告与更新，界面需要跟上。
  useEffect(() => {
    if (shouldPoll) return undefined;
    const timer = setInterval(() => { if (!document.hidden) load(); }, IDLE_POLL_MS);
    return () => clearInterval(timer);
  }, [shouldPoll, load]);

  // 设置草稿跟随服务端，但只在面板空闲时覆盖，避免打断正在输入的值。
  useEffect(() => {
    if (action !== '') return;
    setSettingsDraft({
      autoReloadWatch: settings.autoReloadWatch === true,
      feedPollMinutes: settings.feedPollMinutes ?? '',
      updateCheckHours: settings.updateCheckHours ?? '',
    });
  }, [settings.autoReloadWatch, settings.feedPollMinutes, settings.updateCheckHours, action]);

  // 202 接口统一返回 { operationId }：记录它，轮询到该操作结束时按状态与结果判定。
  const run = useCallback(async (key, fn, successMessage, expected = '') => {
    if (action !== '') return null;
    setAction(key);
    setError('');
    try {
      const result = await fn();
      const operationId = clean(result?.operationId);
      if (operationId) pendingOp.current = { id: operationId, type: key, expected: clean(expected), at: Date.now() };
      if (successMessage) notifyRef.current?.(successMessage);
      await load();
      return result;
    } catch (err) {
      const message = err?.message || '操作失败。';
      fail(message);
      notifyRef.current?.(message, 'error');
      await load();
      return null;
    } finally {
      if (alive.current) setAction('');
    }
  }, [action, fail, load]);

  // check/apply/local/rollback 都是 202：请求被接受后由轮询跟踪 operation。
  const checkUpdates = () => run('check', () => api('/maintenance/check', { method: 'POST', body: {} }), '已开始检查最新版本…');

  const applyUpdate = () => run('apply', async () => {
    const version = clean(updates.latest);
    setConfirmApply(false);
    return api('/maintenance/apply', { method: 'POST', body: version ? { version } : {} });
  }, '已开始安装更新，完成后会自动应用。', clean(updates.latest));

  const hotReload = useCallback(async () => {
    if (action !== '') return;
    setAction('reload');
    setError('');
    setReloadState('waiting');
    try {
      const result = await api('/maintenance/reload', { method: 'POST', body: {} });
      const operationId = clean(result?.operationId);
      // 不宣称“已重载”：只有该 operation 完成且结果成功、版本一致才算成功。
      pendingOp.current = { id: operationId, type: 'reload', expected: clean(status?.installedVersion) || clean(updates.installedVersion), at: Date.now() };
    } catch (err) {
      pendingOp.current = null;
      setReloadState('idle');
      const message = err?.message || '热重载请求未被接受。';
      fail(message);
      notifyRef.current?.(message, 'error');
    } finally {
      if (alive.current) setAction('');
    }
  }, [action, status?.installedVersion, updates.installedVersion]);

  const rollback = () => run('rollback', () => {
    setRollbackConfirmed(false);
    return api('/maintenance/rollback', { method: 'POST', body: {} });
  }, '已开始回滚到保留的备份。');

  // 本地安装必须携带 status() 返回的一次性确认令牌（60 秒有效、消费一次即失效）。
  // 令牌失效时给出可操作提示：重新读取状态拿新令牌后再试一次。
  const localUpdate = () => run('local', async () => {
    setLocalTokenHint('');
    try {
      return await api('/maintenance/local', { method: 'POST', body: {
        manifestPath: localManifest.trim(),
        allowUnsigned: allowUnsigned === true,
        localInstallToken: clean(status?.localInstallToken),
      } });
    } catch (err) {
      if (/EAC_LOCAL_TOKEN|令牌/.test(err?.message || '')) {
        setLocalTokenHint('本地安装确认令牌缺失、无效或已过期，安装未开始。请刷新维护面板获取新的确认令牌后重试。');
      }
      throw err;
    }
  }, '已开始从本地目录安装。');

  // 公告刷新可能依次尝试多个来源，耗时超过默认的 20 秒超时；单独放宽到 60 秒。
  const refreshAnnouncements = () => run('announce-refresh',
    () => api('/maintenance/announcements/refresh', { method: 'POST', body: {}, signal: AbortSignal.timeout(60000) }),
    '已刷新公告。');
  const ackAnnouncements = ids => run('announce-ack', () => api('/maintenance/announcements/ack', { method: 'POST', body: { ids } }));

  // 服务端要求 feedPollMinutes ∈ [1,1440]、updateCheckHours ∈ [1,720]，并拒绝在
  // 热重载不可用时开启 autoReloadWatch；这里做同样的夹取，避免提交被拒绝。
  const saveSettings = () => run('settings', () => api('/maintenance/settings', {
    method: 'PUT',
    body: {
      autoReloadWatch: settingsDraft.autoReloadWatch === true,
      feedPollMinutes: clampInt(settingsDraft.feedPollMinutes, 1, 1440, settings.feedPollMinutes ?? 30),
      updateCheckHours: clampInt(settingsDraft.updateCheckHours, 1, 720, settings.updateCheckHours ?? 24),
    },
  }), '维护设置已保存。');

  if (!status && !error) {
    return <div className="mt-panel"><p className="mt-help"><LoaderCircle size={14} className="spin" aria-hidden="true" />正在读取维护状态…</p></div>;
  }

  const runningVersion = clean(status?.runningVersion) || clean(updates.runningVersion) || '—';
  const installedVersion = clean(status?.installedVersion) || clean(updates.installedVersion) || '—';
  const mismatch = status?.versionMismatch === true || updates.versionMismatch === true;
  const latest = clean(updates.latest);
  const available = updates.available === true;
  const recoveryRequired = updates.recoveryRequired === true;
  const rollbackAvailable = updates.rollbackAvailable === true;
  const unread = Number(announcements.unread) || 0;
  const items = Array.isArray(announcements.items) ? announcements.items : [];
  const lastReload = reload.last && typeof reload.last === 'object' ? reload.last : null;
  const reloadSupported = reload.available === true;
  const reloadBlockedByJobs = activeJobs > 0;
  const reloadDisabled = action !== '' || operationRunning || reloadBlockedByJobs || !reloadSupported || updates.applying === true
    || recoveryRequired || reloadState === 'waiting';
  const reloadHint = reloadState === 'waiting' ? '正在等待重载完成并重连本地服务…'
    : !reloadSupported ? '当前运行方式不支持热重载（独立服务模式下需重启应用）。'
      : reloadBlockedByJobs ? `有 ${activeJobs} 个任务正在运行，全部结束后才能热重载。`
        : recoveryRequired ? '需要先回滚备份，才能热重载。'
          : '让插件立即使用磁盘上的最新代码，无需重启应用。';
  const operationPercent = operation ? progressPercent(operation.progress) : null;
  const operationPhase = operation && operation.progress && typeof operation.progress === 'object' ? PHASE_LABEL[operation.progress.phase] : '';

  return <div className="mt-panel" aria-label="插件维护">
    {error && <div className="mt-callout error" role="alert"><CircleAlert size={16} aria-hidden="true" /><span>{error}</span></div>}
    {reconnectNote && <div className="mt-callout" role="status" aria-live="polite"><LoaderCircle size={16} className="spin" aria-hidden="true" /><span>{reconnectNote}</span></div>}

    {/* 版本 */}
    <Section icon={Package} title="版本" hint="运行中的代码与磁盘上的安装版本">
      <div className="mt-pills">
        <Pill tone="strong">运行版本 {runningVersion}</Pill>
        <Pill>磁盘版本 {installedVersion}</Pill>
        {latest && <Pill>最新版本 {latest}</Pill>}
        {available && <Pill tone="warn">可更新到 {latest}</Pill>}
        {!available && latest && !busy && !recoveryRequired && !mismatch && !updates.applying && <Pill tone="ok">已是最新版本</Pill>}
        <Pill>{updates.checkedAt ? `上次检查 ${formatTime(updates.checkedAt)}` : '尚未检查更新'}</Pill>
      </div>
      {mismatch && <div className="mt-banner" role="status"><CircleAlert size={15} aria-hidden="true" /><span>运行中的版本与磁盘上的版本不一致。请先热重载或重启应用，确认两者一致后再继续其他操作。</span></div>}
      {recoveryRequired && <div className="mt-callout error" role="alert"><ShieldAlert size={16} aria-hidden="true" /><span>上一次更新未能完整结束，当前安装处于待恢复状态。请先回滚到保留的备份，再重新检查更新。</span></div>}
      <div className="mt-actions">
        <PanelButton icon={RefreshCw} busy={action === 'check'} disabled={action !== '' || operationRunning || updates.applying === true} onClick={checkUpdates}>检查更新</PanelButton>
        {available && !confirmApply && <PanelButton icon={Download} variant="primary" disabled={action !== '' || updates.applying === true || recoveryRequired || operationRunning} onClick={() => setConfirmApply(true)}>安装更新 {latest}</PanelButton>}
        {available && confirmApply && <span className="mt-confirm" role="group" aria-label="确认安装更新">
          <span className="mt-confirm-text">将安装到 <b>{latest}</b>（当前 {runningVersion}）。安装前会自动备份现有版本，失败时可回滚。</span>
          <PanelButton icon={Download} variant="primary" busy={action === 'apply'} disabled={action !== '' || operationRunning} onClick={applyUpdate}>确认安装</PanelButton>
          <PanelButton variant="ghost" disabled={action !== ''} onClick={() => setConfirmApply(false)}>取消</PanelButton>
        </span>}
      </div>
      {(updates.applying === true || ['installing', 'activating'].includes(updates.phase)) && <p className="mt-status" role="status" aria-live="polite"><LoaderCircle size={14} className="spin" aria-hidden="true" />{PHASE_LABEL[updates.phase] || '正在更新…'}{updates.error ? `：${updates.error}` : ''}</p>}
      {!updates.applying && updates.error && <p className="mt-help error-text">上次更新未成功：{updates.error}</p>}
      {notesBody.length > 0 && <div className="mt-notes"><span className="mt-notes-label">更新说明</span><div className="mt-notes-body">{notesBody}</div></div>}
    </Section>

    {/* 热重载 */}
    <Section icon={Wrench} title="热重载" hint="不重启应用，直接启用磁盘上的最新代码"
      actions={<Pill tone={reload.watching ? 'ok' : ''}>文件变化自动重载：{reload.watching ? '已开启' : '关闭'}</Pill>}>
      <div className="mt-actions">
        <PanelButton icon={RotateCcw} variant="primary" busy={action === 'reload' || reloadState === 'waiting'} disabled={reloadDisabled} onClick={hotReload}>热重载插件</PanelButton>
        {reloadState === 'confirmed' && <span className="mt-status ok" role="status"><CircleCheck size={14} aria-hidden="true" />重载已完成，运行版本 {runningVersion}</span>}
        {reloadState === 'confirmed' && <PanelButton icon={RefreshCw} onClick={() => { try { window.location.reload(); } catch { /* 顶层导航可能被拒绝 */ } }}>刷新维护界面</PanelButton>}
        {reloadState === 'timeout' && <span className="mt-status warn" role="status"><CircleAlert size={14} aria-hidden="true" />请求已发出，但在等待时间内未确认版本变化，请稍后重新检查。</span>}
      </div>
      <p className="mt-help">{reloadHint}</p>
      {lastReload && <p className="mt-help">上次重载：{lastReload.status === 'completed' || lastReload.status === 'ok' ? '成功' : lastReload.status === 'failed' ? '失败' : lastReload.status === 'running' ? '进行中' : (lastReload.status || '未知')}{lastReload.result?.version ? ` · 版本 ${lastReload.result.version}` : ''}{lastReload.finishedAt ? ` · ${formatTime(lastReload.finishedAt)}` : ''}{lastReload.error ? ` · ${lastReload.error}` : ''}</p>}
    </Section>

    {/* 最近一次维护操作：刷新后仍保留，直到下一次操作覆盖 */}
    {operation && <Section icon={History} title="最近一次维护操作">
      <p className="mt-status" role="status" aria-live="polite">
        {operation.status === 'running' ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : operation.status === 'failed' ? <CircleAlert size={14} aria-hidden="true" /> : <CircleCheck size={14} aria-hidden="true" />}
        {OPERATION_LABEL[operation.type] || '维护操作'}：{OPERATION_STATE[operation.status] || operation.status}
        {operation.startedAt ? ` · 开始于 ${formatTime(operation.startedAt)}` : ''}
        {operation.finishedAt ? ` · 结束于 ${formatTime(operation.finishedAt)}` : ''}
      </p>
      {operation.status === 'running' && operationPhase && <p className="mt-help">{operationPhase}</p>}
      {operation.status === 'running' && operationPercent !== null && <div className="mt-progress"><progress value={operationPercent} max={100} aria-label={`${OPERATION_LABEL[operation.type] || '维护操作'}进度`} /><span>{operationPercent}%</span></div>}
      {operation.status === 'completed' && operation.result?.latest && <p className="mt-help">最新版本 {operation.result.latest}{operation.result.available ? '，可更新' : '，已是最新'}。</p>}
      {operation.error && <p className="mt-help error-text">{operation.error}</p>}
    </Section>}

    {/* 公告 */}
    <Section icon={Megaphone} title="公告" hint="来自项目方的通知与更新说明"
      actions={<>
        {unread > 0 && <Pill tone="strong">未读 {unread}</Pill>}
        {unread > 0 && <PanelButton variant="ghost" busy={action === 'announce-ack'} disabled={action !== ''} onClick={() => ackAnnouncements(items.filter(item => item.acked !== true).map(item => item.id))}>全部标记已读</PanelButton>}
        <PanelButton icon={RefreshCw} busy={action === 'announce-refresh'} disabled={action !== ''} onClick={refreshAnnouncements} aria-label="刷新公告">刷新</PanelButton>
      </>}>
      {announcements.error && <div className="mt-banner" role="status"><CircleAlert size={15} aria-hidden="true" /><span>公告暂时无法更新，以下为最近一次成功获取的内容。{announcements.fetchedAt ? `（获取于 ${formatTime(announcements.fetchedAt)}）` : ''}</span></div>}
      {!announcements.error && Boolean(announcements.fetchedAt) && <p className="mt-help">更新于 {formatTime(announcements.fetchedAt)}{clean(announcements.source) ? ` · 来源 ${announcements.source}` : ''}</p>}
      {items.length === 0
        ? <p className="mt-help">{announcements.error ? '尚无缓存内容。' : '暂时没有公告。'}</p>
        : <div className="mt-announcements">{items.map(item => <AnnouncementItem key={item.id} item={item} busy={action === 'announce-ack'} onAck={() => ackAnnouncements([item.id])} />)}</div>}
    </Section>

    {/* 高级：本地安装与回滚 */}
    <details className="mt-details">
      <summary>本地安装与回滚</summary>
      <div className="mt-details-body">
        <div className="mt-field">
          <label htmlFor="mt-local-manifest">本地更新清单路径</label>
          <input id="mt-local-manifest" type="text" value={localManifest} spellCheck={false}
            placeholder="例如 D:\\builds\\eac\\feed\\manifest.json"
            onChange={event => setLocalManifest(event.target.value)} />
          <p className="mt-help">填写本地更新清单（manifest.json）的完整路径，用于安装尚未发布的本地构建。</p>
        </div>
        <label className="checkbox-label mt-checkbox">
          <input type="checkbox" checked={allowUnsigned} onChange={event => setAllowUnsigned(event.target.checked)} />
          我了解：清单中的哈希只能证明文件与清单一致，不能证明清单来自官方签名；勾选后将接受未签名清单。
        </label>
        {localTokenHint && <>
          <div className="mt-banner" role="alert"><CircleAlert size={15} aria-hidden="true" /><span>{localTokenHint}</span></div>
          <div className="mt-actions">
            <PanelButton icon={RefreshCw} disabled={action !== ''}
              onClick={() => { setLocalTokenHint(''); load(); }}>刷新确认令牌</PanelButton>
          </div>
        </>}
        <div className="mt-actions">
          <PanelButton icon={Download} busy={action === 'local'} disabled={action !== '' || operationRunning || activeJobs > 0 || !reloadSupported || recoveryRequired || localManifest.trim() === '' || !clean(status?.localInstallToken)} onClick={localUpdate}>从本地目录安装</PanelButton>
        </div>
        <p className="mt-help">安装时会消耗一枚一次性安装确认令牌（60 秒内有效、仅可用一次），令牌随面板状态自动刷新；已签名与未签名的本地包都需要它，签名校验不受影响。</p>
        <div className="mt-subsection">
          <h3>回滚到备份</h3>
          <p className="mt-help">{rollbackAvailable ? '用更新前保留的备份覆盖当前安装，恢复到上一个可用版本。' : '当前没有可用的备份，回滚不可用。'}</p>
          <label className="checkbox-label mt-checkbox">
            <input type="checkbox" checked={rollbackConfirmed} disabled={!rollbackAvailable || action !== ''} onChange={event => setRollbackConfirmed(event.target.checked)} />
            我确认要用保留的备份覆盖当前安装。
          </label>
          <div className="mt-actions">
            <PanelButton icon={RotateCcw} variant="primary" busy={action === 'rollback'} disabled={action !== '' || operationRunning || activeJobs > 0 || !reloadSupported || !rollbackAvailable || !rollbackConfirmed} onClick={rollback}>回滚到备份</PanelButton>
          </div>
        </div>
      </div>
    </details>

    {/* 维护设置 */}
    <Section icon={Wrench} title="维护设置" hint="自动检查与公告刷新频率">
      <div className="mt-fields">
        <label className="checkbox-label mt-checkbox">
          <input type="checkbox" checked={settingsDraft.autoReloadWatch === true} disabled={!reloadSupported || action !== ''}
            onChange={event => setSettingsDraft(draft => ({ ...draft, autoReloadWatch: event.target.checked }))} />
          文件变化时自动热重载（仅用于开发与演示{!reloadSupported ? '；当前运行方式不可用' : ''}）
        </label>
        <div className="mt-field">
          <label htmlFor="mt-feed-poll">公告刷新间隔（分钟，1–1440）</label>
          <input id="mt-feed-poll" type="number" min="1" max="1440" value={settingsDraft.feedPollMinutes} onChange={event => setSettingsDraft(draft => ({ ...draft, feedPollMinutes: event.target.value }))} />
        </div>
        <div className="mt-field">
          <label htmlFor="mt-update-hours">自动检查更新间隔（小时，1–720）</label>
          <input id="mt-update-hours" type="number" min="1" max="720" value={settingsDraft.updateCheckHours} onChange={event => setSettingsDraft(draft => ({ ...draft, updateCheckHours: event.target.value }))} />
        </div>
      </div>
      <div className="mt-actions">
        <PanelButton icon={CircleCheck} variant="primary" busy={action === 'settings'} disabled={action !== ''} onClick={saveSettings}>保存维护设置</PanelButton>
      </div>
    </Section>

    {/* 诊断信息 */}
    <details className="mt-details">
      <summary>诊断信息</summary>
      <dl className="mt-diagnostic">
        <div><dt>运行方式</dt><dd>{status?.mode === 'harness' ? '宿主内运行' : status?.mode === 'standalone' ? '独立运行' : '—'}</dd></div>
        <div><dt>实例标识</dt><dd className="mono">{clean(status?.instanceId) || '—'}</dd></div>
        <div><dt>启动时间</dt><dd>{formatTime(status?.startedAt) || '—'}</dd></div>
        <div><dt>安装目录</dt><dd className="mono">{clean(status?.root) || '—'}</dd></div>
        <div><dt>数据目录</dt><dd className="mono">{clean(status?.dataDir) || '—'}</dd></div>
        <div><dt>签名校验</dt><dd>{updates.signingConfigured === false ? '未配置（仅本地安装可用）' : '已启用'}</dd></div>
      </dl>
    </details>
  </div>;
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
