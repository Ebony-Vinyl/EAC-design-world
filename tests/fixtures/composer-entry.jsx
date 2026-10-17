import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as ReactDOM from 'react-dom';

const registrations = [];
const dict = {};
let plugin;
let revealSidebar = () => {};
const tabDefinitions = [];
const Menu = ({ anchor, open, items, onSelect, onClose }) => <span>{anchor}{open && <span className="qa-menu" role="menu">{items.map(item => <button role="menuitem" key={item.id} disabled={item.disabled} onClick={() => onSelect(item.id)}>{item.label}</button>)}<button onClick={onClose}>关闭菜单</button></span>}</span>;
const Modal = ({ open, children, className }) => open ? <div role="dialog" className={`qa-modal ${className}`}>{children}</div> : null;
window.__ModuleLoader__ = { load(entry) {
  plugin = entry.factory(id => {
    if (id === 'react') return React;
    if (id === 'react-dom') return ReactDOM;
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Menu, Modal };
    throw new Error(`Unexpected import ${id}`);
  });
  plugin.apply({
    locale: { bind: () => key => dict.zh?.[key] || key, register: (_ns, strings) => { Object.assign(dict, strings); return () => {}; } },
    effect: callback => callback(),
    slots: { inject: (_name, callback) => callback(), register: (options, component) => { registrations.push({ options, component }); return () => {}; } },
    sidebarRightTabs: { register: definition => { tabDefinitions.push(definition); return () => {}; } },
    sidebarRight: { openTab: (kind, { params }) => { if (!tabDefinitions.some(item => item.kind === kind)) throw new Error('Missing tab type'); revealSidebar(params); } },
  });
} };
const backend = new URLSearchParams(location.search).get('backend');
if (backend && /^http:\/\/127\.0\.0\.1:\d+$/.test(backend)) {
  const source = await (await fetch('/plugin/client.js')).text();
  new Function(source.replace("const ORIGIN = 'http://127.0.0.1:4173';", `const ORIGIN = '${backend}';`))();
} else await import('/plugin/client.js');
const Controls = registrations.find(item => item.options.name === 'conversation.input.left').component;
const Canvas = registrations.find(item => item.options.name === 'sidebar.right.pane.tab').component;
function App() {
  const [draft, setDraft] = useState('');
  const [sessionId, setSession] = useState('qa-composer-session');
  const [phase, setPhase] = useState('hero');
  const [canvas, setCanvas] = useState(null);
  revealSidebar = setCanvas;
  const inputActions = {
    captureInsertion: () => ({ start: draft.length, end: draft.length, draftRev: draft.length }),
    insertText: (text, span) => { if (span.draftRev !== draft.length) return false; setDraft(current => current.slice(0, span.start) + text + current.slice(span.end)); return true; },
    submit: () => { throw new Error('QA must never submit'); },
  };
  if (new URLSearchParams(location.search).get('nativeEditor') === '1') return <main><div data-phase="hero"><div data-composer-card style={{ minHeight: 260, height: 260, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 12 }}>
    <div data-input-scroll style={{ height: 190, minHeight: 190, flexGrow: 1 }}><div contentEditable suppressContentEditableWarning data-placeholder="输入消息" role="textbox" aria-label="原生文本输入" style={{ minHeight: 180, height: 180, lineHeight: '24px' }}><p style={{ margin: 0 }}>第一行</p><p style={{ margin: 0 }}>第二行</p></div></div>
    <div className="qa-toolbar"><Controls useInput={selector => selector({ draft })} inputActions={inputActions} sessionId={sessionId} /></div>
  </div></div></main>;
  const wideLayout = new URLSearchParams(location.search).get('wideLayout') === '1';
  return <main style={wideLayout ? { maxWidth: 'none', marginLeft: 180, marginRight: 0 } : undefined}>
    <h1>宿主模式切换与右侧画布验收</h1>
    <div className="qa-meta">测试会话：{sessionId}<button onClick={() => setSession(value => value === 'qa-composer-session' ? 'qa-second-session' : 'qa-composer-session')}>切换测试会话</button><button onClick={() => setPhase(value => value === 'hero' ? 'active' : 'hero')}>切换对话阶段</button><button onClick={() => setDraft('')}>清空测试草稿</button></div>
    <div data-phase={phase}>
      <div data-composer-card="true" style={wideLayout ? { maxWidth: 760, width: '100%', marginInline: 'auto' } : undefined}>
        <textarea aria-label="测试草稿" placeholder="描述你的作品" value={draft} onChange={event => setDraft(event.target.value)} />
        <div className="qa-toolbar"><Controls useInput={selector => selector({ draft })} inputActions={inputActions} sessionId={sessionId} /><span>宿主模拟器</span></div>
      </div>
    </div>
    {canvas && <aside className="qa-sidebar" aria-label="原生侧栏模拟"><button onClick={() => setCanvas(null)}>关闭预览侧栏</button><div><Canvas sessionId={sessionId} useTabInfo={() => ({ tab: { navigation: { params: canvas }, actions: { bindCommands: () => () => {} } } })} /></div></aside>}
  </main>;
}
createRoot(document.getElementById('root')).render(<App />);
