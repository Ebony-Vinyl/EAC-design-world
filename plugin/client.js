window.__ModuleLoader__.load({
  id: 'eac-design-world',
  factory(require) {
    const React = require('react');
    const { createPortal } = require('react-dom');
    const { Menu, Modal } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;
    const ORIGIN = 'http://127.0.0.1:4173';
    const NS = 'eacDesignWorld';
    const COMPOSER_ORIGIN = ORIGIN;
    const syncComposerMode = async (sessionId, selection) => {
      if (!sessionId || !selection?.mode) return;
      const response = await fetch(`${COMPOSER_ORIGIN}/api/composer`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, mode: selection.mode, kind: selection.kind || 'website', templateId: selection.templateId || '', designSystemId: selection.designSystemId || '' }) });
      if (!response.ok) throw new Error(`Selection sync failed (${response.status})`);
    };
    const templatePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
    const en = {
      title: 'EAC design world', templates: 'Choose template', library: 'Video templates',
      maintenance: 'Plugin maintenance', workspace: 'Creative workspace',
      selected: 'Selected template', selectionFailed: 'Could not sync the selection. Please reload the plugin.',
      addSelection: 'Try again', normal: 'Normal mode', edit: 'Editing mode', design: 'Design mode',
      soon: 'Coming soon', mode: 'Creation mode', close: 'Close template library',
      description: 'Choose a visual style, then describe the video you want to make.',
      loading: 'Loading templates…', unavailable: 'The local template service is unavailable.',
      retry: 'Reload', draftOnly: 'Selection is attached to this conversation. Nothing is sent.',
      removeSelection: 'Remove selection', syncing: 'Syncing selection…',
      dismiss: 'Hide recommended templates', canvas: 'Preview canvas', systems: 'Design systems',
      website: 'Website', motion: 'Motion design', deck: 'Slides', document: 'Document', image: 'Image',
      designLibrary: 'Design templates & systems', resize: 'Resize preview canvas',
      designDescription: 'Choose a template or design system, then describe what you want to create.',
    };
    const zh = {
      title: 'EAC design world', templates: '选择模板', library: '视频模板',
      maintenance: '插件维护', workspace: '创作工作台',
      selected: '已选模板', selectionFailed: '选择未能同步，请重试或重新加载插件。',
      addSelection: '重新加入', normal: '正常模式', edit: '剪辑模式', design: 'Design 模式',
      soon: '即将推出', mode: '创作模式', close: '关闭模板库',
      description: '选择喜欢的视觉风格，再描述你想制作的内容。',
      loading: '正在加载模板…', unavailable: '本地模板服务暂未连接。',
      retry: '重新加载', draftOnly: '选择后附在输入框上方，发送时作为创作参考。', dismiss: '收起推荐模板',
      removeSelection: '取消选择', syncing: '正在同步选择…',
      canvas: '作品预览画布', systems: '设计体系', website: '网站 / 原型', motion: '动效设计',
      deck: '幻灯片', document: '文档', image: '图片', designLibrary: '设计模板与体系',
      designDescription: '选择模板或设计体系，再描述你要创作的网站、幻灯片、文档或图片。', resize: '调整画布宽度',
    };
    const css = `
      [data-composer-card]:has(.eac-composer-controls){height:auto!important;min-height:0!important;flex-grow:0!important;justify-content:flex-start!important}
      [data-composer-card]:has(.eac-composer-controls) [data-input-scroll]{height:auto!important;min-height:0!important;flex:0 1 auto!important}
      [data-composer-card]:has(.eac-composer-controls) [contenteditable][data-placeholder]{height:auto!important;min-height:52px!important;flex-grow:0!important}
      .eac-composer-controls{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%;font:inherit;color:inherit}
      .eac-composer-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:30px;max-width:210px;padding:4px 8px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap}
      .eac-composer-button:hover{background:var(--dsw-alias-interactive-bg-hover,#80808012)}
      .eac-composer-button:focus-visible{outline:2px solid var(--dsw-alias-label-primary-bluish,#4678ef);outline-offset:2px}
      .eac-composer-button[data-mode=edit],.eac-composer-button[data-mode=design]{color:var(--dsw-alias-label-primary-bluish,#4478d8)}
      .eac-canvas-panel{position:fixed;inset:12px 12px 12px auto;width:min(var(--eac-canvas-width,560px),calc(100vw - 24px));z-index:120;background:var(--dsw-alias-bg-base,#f7f8f6);border:1px solid var(--dsw-alias-border-l1,#dfe4dd);border-radius:12px;box-shadow:0 12px 60px #15271e24;display:flex;flex-direction:column;overflow:hidden;color:var(--dsw-alias-label-primary,#263c32);font:13px/1.5 system-ui}
      .eac-canvas-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,#dfe4dd)}
      .eac-canvas-header strong{font-weight:600}.eac-canvas-header>div{display:flex;gap:4px}.eac-canvas-panel iframe{flex:1;width:100%;min-height:0;border:0}
      .eac-canvas-resize{position:absolute;left:0;top:50px;bottom:0;width:6px;cursor:ew-resize;touch-action:none;background:transparent}
      .eac-canvas-resize:focus-visible{outline:2px solid #4478d8}.eac-canvas-resize:hover{background:#4478d833}
      .eac-composer-button>span{overflow:hidden;text-overflow:ellipsis}
      .eac-composer-button svg{flex:none;width:15px;height:15px}
      .eac-control-divider{width:1px;height:14px;background:var(--dsw-alias-border-l1,#80808030)}
      .eac-mode-menu{min-width:190px}
      .eac-menu-label{display:flex;align-items:center;justify-content:space-between;gap:20px}
      .eac-menu-label small{font-size:10px;opacity:.65}
      .eac-template-modal{width:min(1080px,calc(100vw - 40px))!important;max-width:none!important;height:min(780px,calc(100dvh - 72px));max-height:calc(100dvh - 32px)!important;padding:0!important;display:flex;flex-direction:column;overflow:hidden!important;border-radius:16px!important}
      .eac-modal-heading{display:flex;align-items:center;justify-content:space-between;gap:20px;flex:none;padding:22px 26px 18px;border-bottom:1px solid var(--dsw-alias-border-l1,#80808022)}
      .eac-modal-heading h2{margin:0;font:inherit;font-size:20px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}
      .eac-modal-heading p{margin:7px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#888)}
      .eac-modal-close{width:32px;height:32px;flex:none;padding:6px;align-self:flex-start}
      .eac-picker-frame{position:relative;min-height:0;flex:1;background:#f7f8f6;overflow:hidden}
      .eac-picker-frame iframe{display:block;width:100%;height:100%;min-width:0;border:0;background:transparent}
      .eac-picker-feedback{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;background:#f7f8f6;color:#69746b;font-size:13px;text-align:center;padding:20px}
      .eac-picker-feedback button{border:1px solid #dfe4dd;background:white;color:#303531;border-radius:6px;padding:7px 16px;font:inherit;cursor:pointer}
      .eac-modal-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;flex:none;padding:12px 26px;border-top:1px solid var(--dsw-alias-border-l1,#80808022);font-size:12px;color:var(--dsw-alias-label-secondary,#888);line-height:1.6}
      [data-eac-selection-seat]:empty,[data-eac-selection-seat]:not(:has(.eac-selection-chip)){display:none}.eac-selection-rail:empty{display:none}.eac-selection-rail{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:4px 14px 0}.eac-selection-chip{display:flex;align-items:center;gap:6px;border:1px solid #cdddd1;background:#f4f8f3;border-radius:9px;padding:5px;max-width:270px}.eac-selection-open{display:flex;gap:9px;align-items:center;padding:0;border:0;background:none;text-align:left;min-width:0;cursor:pointer}.eac-selection-open>img{width:54px;height:34px;border-radius:5px;object-fit:cover;background:#e3eae2}.eac-selection-open>span{display:flex;flex-direction:column;min-width:0;gap:2px}.eac-selection-open small{font-size:9px;color:#8a988c}.eac-selection-open strong{font-size:12px;font-weight:500;color:#315744;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.eac-selection-remove{border:0;background:none;color:#7d9183;width:25px;height:25px;display:grid;place-items:center;cursor:pointer;border-radius:50%}.eac-selection-remove:hover{background:#dfeadf;color:#264f3b}.eac-selection-remove svg{width:13px;height:13px}.eac-selection-sync{font-size:10px;color:#8b988d}
      .eac-selection-error{color:#bd6149;font-size:12px;line-height:1.6}
      .eac-selection-error button{font:inherit;color:inherit;background:none;border:0;text-decoration:underline;cursor:pointer;padding:0 4px}
      [data-eac-intro-seat]{width:100%;max-width:var(--dsh-composer-card-max-width,100%);margin-inline:auto;min-width:0;align-self:center;flex:0 0 0;height:0;min-height:0;position:relative;overflow:visible}
      [data-eac-intro-seat][hidden]{display:none}
      .eac-intro{position:absolute;top:18px;left:var(--eac-gallery-left,0px);width:var(--eac-gallery-width,100%);max-width:none;min-width:0;margin:0;padding-bottom:24px;border-top:1px solid var(--dsw-alias-border-l1,#80808020)}
      .eac-intro-dismiss{position:absolute;right:8px;top:10px;z-index:1;width:26px;height:26px;padding:4px}
      .eac-intro .eac-picker-frame{background:transparent;border-radius:8px}
      @media(max-width:600px){.eac-composer-controls{gap:2px}.eac-composer-button{font-size:12px;padding:4px 6px;max-width:142px}.eac-template-modal{width:calc(100vw - 20px)!important;height:calc(100dvh - 36px);border-radius:12px!important}.eac-modal-heading{padding:17px 16px 14px;gap:10px}.eac-modal-heading h2{font-size:18px}.eac-modal-heading p{font-size:11px}.eac-modal-footer{padding:10px 16px;font-size:11px;flex-wrap:wrap}}
    `;
    function icon(name) {
      const paths = {
        normal: 'M4 4h16v12H8l-4 4V4Z',
        edit: 'm8 8 12 12M8 16 20 4M8 8a3 3 0 1 1-4-4 3 3 0 0 1 4 4Zm0 8a3 3 0 1 1-4 4 3 3 0 0 1 4-4Z',
        templates: 'M3 4h7v6H3zM14 4h7v6h-7zM3 14h7v6H3zM14 14h7v6h-7z',
        design: 'm12 3 9 6-9 6-9-6 9-6Zm-9 12 9 6 9-6M3 12l9 6 9-6',
        canvas: 'M3 4h18v16H3zM14 4v16',
        up: 'm7 14 5-5 5 5', close: 'm6 6 12 12M6 18 18 6',
      };
      return h('svg', { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: paths[name] }));
    }
    function templateFromMessage(event, frame) {
      if (!frame?.contentWindow || event.source !== frame.contentWindow || event.origin !== ORIGIN) return;
      const data = event.data;
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.type !== 'eac:template'
        || typeof data.templateId !== 'string' || !templatePattern.test(data.templateId)) return;
      return data.templateId;
    }
    const designKinds = ['website', 'motion', 'deck', 'document', 'image'];
    function removeLegacySelection({ draft = '', inputActions }) {
      const match = /\[EAC (?:template selection: [a-zA-Z0-9_-]+|design template: [a-zA-Z0-9_-]+; kind: [a-z-]+|design system: [a-zA-Z0-9_-]+)\]/.exec(draft);
      if (!match) return true;
      if (!inputActions?.captureInsertion || !inputActions?.insertText) return false;
      const span = inputActions.captureInsertion();
      if (!Number.isInteger(span?.end)) return false;
      let start = match.index;
      let end = start + match[0].length;
      const lineStart = draft.lastIndexOf('\n', start - 1) + 1;
      const nextBreak = draft.indexOf('\n', end);
      const lineEnd = nextBreak === -1 ? draft.length : nextBreak;
      if (!draft.slice(lineStart, start).trim() && !draft.slice(end, lineEnd).trim()) {
        start = lineStart;
        end = nextBreak === -1 ? lineEnd : nextBreak + 1;
        if (end === draft.length && start > 0) start--;
      }
      return inputActions.insertText('', { ...span, start, end }) === true;
    }
    function toggledSelection(selection, id, name = '', kind) {
      if (!templatePattern.test(id)) return null;
      const mode = selection.mode === 'design' ? 'design' : 'edit';
      if (kind && ![...designKinds, 'design-system', 'prompt', 'example'].includes(kind)) return null;
      if (kind === 'design-system') return { ...selection, mode, designSystemId: selection.designSystemId === id ? '' : id,
        designSystemName: selection.designSystemId === id ? '' : name };
      const prefix = mode === 'design' ? 'design' : 'edit';
      const cancelling = selection.templateId === id;
      return { ...selection, mode, templateId: cancelling ? '' : id, templateName: cancelling ? '' : name,
        [`${prefix}TemplateId`]: cancelling ? '' : id, [`${prefix}TemplateName`]: cancelling ? '' : name,
        kind: designKinds.includes(kind) ? kind : selection.kind || 'website' };
    }
    function recommendationVisible({ dismissed, pickerOpen, mode }) {
      return !dismissed && !pickerOpen && mode !== 'normal';
    }
    function readSelection(sessionId, draft) {
      let saved;
      try { if (sessionId) saved = JSON.parse(window.localStorage.getItem(`eac:composer:${sessionId}`) || 'null'); } catch {}
      const restored = [...draft.matchAll(/\[EAC template selection: ([a-zA-Z0-9_-]+)\]/g)]
        .map(match => match[1]).filter(id => templatePattern.test(id)).at(-1) || '';
      const templateId = restored || (typeof saved?.templateId === 'string' && templatePattern.test(saved.templateId) ? saved.templateId : '');
      const designNote = [...draft.matchAll(/\[EAC design template: ([a-zA-Z0-9_-]+); kind: ([a-z-]+)\]/g)].at(-1);
      const systemNote = [...draft.matchAll(/\[EAC design system: ([a-zA-Z0-9_-]+)\]/g)].at(-1);
      const mode = ['normal', 'edit', 'design'].includes(saved?.mode) ? saved.mode : designNote || systemNote ? 'design' : restored ? 'edit' : 'normal';
      return { mode, templateId: mode === 'design' ? designNote?.[1] || saved?.designTemplateId || '' : restored || saved?.editTemplateId || templateId,
        editTemplateId: saved?.editTemplateId || (mode === 'edit' ? templateId : ''),
        designTemplateId: designNote?.[1] || saved?.designTemplateId || '',
        editTemplateName: typeof saved?.editTemplateName === 'string' ? saved.editTemplateName.slice(0, 80) : '',
        designTemplateName: typeof saved?.designTemplateName === 'string' ? saved.designTemplateName.slice(0, 80) : '',
        kind: designKinds.includes(saved?.kind) ? saved.kind : designKinds.includes(designNote?.[2]) ? designNote[2] : 'website',
        designSystemName: typeof saved?.designSystemName === 'string' ? saved.designSystemName.slice(0, 80) : '',
        designSystemId: systemNote?.[1] || (typeof saved?.designSystemId === 'string' && templatePattern.test(saved.designSystemId) ? saved.designSystemId : ''),
        templateName: saved?.templateId === (designNote?.[1] || templateId) && typeof saved.templateName === 'string' ? saved.templateName.slice(0, 80) : '' };
    }
    function PickerFrame({ frameRef, selected, designSystemId = '', mode = 'edit', kind = 'website', inline = false, height = 256, t }) {
      const [ready, setReady] = React.useState(false);
      const [timedOut, setTimedOut] = React.useState(false);
      const [attempt, setAttempt] = React.useState(0);
      const [initialSelected] = React.useState(selected);
      const [initialKind] = React.useState(kind);
      const state = React.useRef(null);
      state.current = { type: 'eac:picker-state', templateId: selected || '', designSystemId, mode, kind, presentation: inline ? 'inline' : 'dialog' };
      const sync = () => frameRef.current?.contentWindow?.postMessage(state.current, ORIGIN);
      React.useEffect(() => { sync(); }, [selected, designSystemId, mode, kind]);
      React.useEffect(() => {
        setReady(false);
        setTimedOut(false);
        const receive = event => {
          if (event.source !== frameRef.current?.contentWindow || event.origin !== ORIGIN || event.data?.type !== 'eac:picker-ready') return;
          setReady(true);
          setTimedOut(false);
          sync();
        };
        const timeout = setTimeout(() => setTimedOut(true), 10000);
        window.addEventListener('message', receive);
        return () => { clearTimeout(timeout); window.removeEventListener('message', receive); };
      }, [attempt]);
      return h('div', { className: 'eac-picker-frame', style: inline ? { height, flex: 'none' } : undefined },
        h('iframe', { key: attempt, ref: frameRef, title: t('library'), tabIndex: 0,
          src: `${ORIGIN}/?view=templates&mode=${mode}&kind=${initialKind}&layout=${inline ? 'inline' : 'dialog'}&selected=${encodeURIComponent(initialSelected || '')}&reload=${attempt}`, 
          'data-eac-frame': inline ? 'recommendations' : 'templates', onLoad: sync }),
        !ready ? h('div', { className: 'eac-picker-feedback', role: 'status' },
          timedOut ? t('unavailable') : t('loading'), timedOut ? h('button', { type: 'button', onClick: () => setAttempt(value => value + 1) }, t('retry')) : null) : null);
    }
    function SelectionChip({ id, name, label, removeLabel, onRemove, onOpen }) {
      const thumbnail = /^\d{2}-/.test(id) ? `${ORIGIN}/vendor/mg-styles-15/docs/readme/films/${id}.webp`
        : /^sc-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) ? `${ORIGIN}/vendor/video-shotcraft/poster/${id.slice(3)}.jpg`
          : `${ORIGIN}/library-previews/${id}.jpg`;
      return h('div', { className: 'eac-selection-chip', 'data-eac-selection-id': id },
        h('button', { type: 'button', className: 'eac-selection-open', onClick: onOpen, title: name || id },
          h('img', { src: thumbnail.startsWith('/') ? `${ORIGIN}${thumbnail}` : thumbnail, alt: '', onError: event => { event.currentTarget.style.visibility = 'hidden'; } }),
          h('span', null, h('small', null, label), h('strong', null, name || id))),
        h('button', { type: 'button', className: 'eac-selection-remove', 'aria-label': `${removeLabel}${name || id}`, onClick: onRemove }, icon('close')));
    }
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { en, zh }));
      function Settings() {
        return h('div', null,
          h('iframe', { title: t('title'), src: `${ORIGIN}/?view=maintenance`, 'data-eac-frame': 'settings',
            style: { display: 'block', border: 0, width: '100%', minWidth: 0, height: 'min(760px, 78vh)', background: 'transparent' } }));
      }
      function CanvasPanel({ sessionId, mode, onClose }) {
        const [width, setWidth] = React.useState(560);
        const resize = event => {
          if (event.type === 'keydown') {
            if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
            event.preventDefault();
            setWidth(value => Math.max(340, Math.min(window.innerWidth - 24, value + (event.key === 'ArrowLeft' ? 24 : -24))));
            return;
          }
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
        };
        React.useEffect(() => {
          const close = event => { if (event.key === 'Escape' && !event.defaultPrevented) onClose(); };
          window.addEventListener('keydown', close);
          return () => window.removeEventListener('keydown', close);
        }, [onClose]);
        return createPortal(h('aside', { className: 'eac-canvas-panel', role: 'complementary', 'aria-label': t('canvas'), style: { '--eac-canvas-width': `${width}px` } },
          h('header', { className: 'eac-canvas-header' }, h('strong', null, `EAC · ${t('canvas')}`),
            h('div', null, h('button', { type: 'button', className: 'eac-composer-button', 'aria-label': t('close'), onClick: onClose }, icon('close')))),
          h('div', { className: 'eac-canvas-resize', role: 'separator', tabIndex: 0, 'aria-orientation': 'vertical', 'aria-label': t('resize'),
            onPointerDown: resize, onKeyDown: resize, onPointerMove: event => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) setWidth(Math.max(340, Math.min(window.innerWidth - 24, window.innerWidth - event.clientX)));
            }, onPointerUp: event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); } }),
          h('iframe', { title: t('canvas'), 'data-eac-frame': 'canvas', src: `${ORIGIN}/?view=canvas&sessionId=${encodeURIComponent(sessionId || '')}&mode=${mode}` })), document.body);
      }
      function NativeCanvas({ useTabInfo, sessionId }) {
        const { tab } = useTabInfo();
        const frame = React.useRef(null);
        const params = tab.navigation.params || {};
        const session = sessionId || params.sessionId || '';
        React.useEffect(() => tab.actions.bindCommands({ refresh: () => {
          if (frame.current) frame.current.src = frame.current.src;
        } }), [tab.actions]);
        return h('iframe', { ref: frame, title: t('canvas'), 'data-eac-frame': 'canvas',
          src: `${ORIGIN}/?view=canvas&sessionId=${encodeURIComponent(session)}&mode=${params.mode === 'edit' ? 'edit' : 'design'}`,
          style: { display: 'block', width: '100%', height: '100%', border: 0, minHeight: 0 } });
      }
      ctx.effect(() => ctx.sidebarRightTabs.register({ id: 'eac-design-world/canvas', kind: 'eac-canvas',
        title: () => `EAC · ${t('canvas')}`, keepMounted: true,
        guide: [{ id: 'canvas', order: 80, title: () => t('canvas'), description: () => t('designDescription') }] }));
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab', key: 'eac-design-world/canvas', inject: sessionId => ({ sessionId }),
      }, NativeCanvas)));
      function ComposerControls({ useInput, inputActions, sessionId }) {
        const draft = useInput(value => value?.draft || '');
        const [selection, setSelection] = React.useState(() => readSelection(sessionId, draft));
        const [menuOpen, setMenuOpen] = React.useState(false);
        const [pickerOpen, setPickerOpen] = React.useState(false);
        const [kindOpen, setKindOpen] = React.useState(false);
        const [canvasOpen, setCanvasOpen] = React.useState(false);
        const [failed, setFailed] = React.useState(null);
        const [dismissed, setDismissed] = React.useState(false);
        const [introSeat, setIntroSeat] = React.useState(null);
        const [introHeight, setIntroHeight] = React.useState(360);
        const frame = React.useRef(null);
        const introFrame = React.useRef(null);
        const controls = React.useRef(null);
        const input = React.useRef({ draft, inputActions });
        input.current = { draft, inputActions };
        const [selectionSeat, setSelectionSeat] = React.useState(null);
        const [syncing, setSyncing] = React.useState(false);
        const syncQueue = React.useRef(Promise.resolve());
        const syncVersion = React.useRef(0);
        const synchronize = value => {
          const version = ++syncVersion.current;
          setSyncing(true);
          syncQueue.current = syncQueue.current.catch(() => {}).then(() => syncComposerMode(sessionId, value));
          syncQueue.current.then(() => {
            if (syncVersion.current === version) { setSyncing(false); setFailed(null); }
          }, () => {
            if (syncVersion.current === version) { setSyncing(false); setFailed({ value }); }
          });
        };
        React.useEffect(() => {
          const restored = readSelection(sessionId, input.current.draft);
          setSelection(restored);
          synchronize(restored);
          setMenuOpen(false); setPickerOpen(false); setKindOpen(false); setCanvasOpen(false); setFailed(null); setDismissed(false);
        }, [sessionId]);
        React.useEffect(() => { removeLegacySelection(input.current); }, [draft, sessionId]);
        const remember = value => {
          setSelection(value);
          synchronize(value);
          try { if (sessionId) window.localStorage.setItem(`eac:composer:${sessionId}`, JSON.stringify(value)); } catch {}
        };
        const stage = (templateId, templateName = '', kind) => {
          const next = toggledSelection(selection, templateId, templateName, kind);
          if (!next) return;
          remember(next);
          setPickerOpen(false);
        };
        const openPicker = () => { setMenuOpen(false); setPickerOpen(true); };
        const openCanvas = () => {
          if (sessionId) {
            try { ctx.sidebarRight.openTab('eac-canvas', { params: { sessionId, mode: selection.mode } }); return; }
            catch { /* A hero session can exist before the host mounts its sidebar store. */ }
          }
          setCanvasOpen(value => !value);
        };
        const actions = React.useRef(null);
        actions.current = { stage, openPicker };
        React.useEffect(() => {
          const receive = event => {
            const source = [frame.current, introFrame.current].find(item => item?.contentWindow && event.source === item.contentWindow);
            if (!source || event.origin !== ORIGIN || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return;
            const templateId = templateFromMessage(event, source);
            if (templateId) {
              const name = typeof event.data.templateName === 'string' ? event.data.templateName.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) : '';
              const kind = typeof event.data.kind === 'string' ? event.data.kind : undefined;
              actions.current.stage(templateId, name, kind);
            } else if (source === introFrame.current && event.data.type === 'eac:open-picker') actions.current.openPicker();
            else if (source === frame.current && event.data.type === 'eac:close-picker') setPickerOpen(false);
            else if (source === introFrame.current && event.data.type === 'eac:picker-height' && Number.isInteger(event.data.height)) {
              setIntroHeight(Math.max(180, Math.min(760, event.data.height)));
            }
          };
          window.addEventListener('message', receive);
          return () => window.removeEventListener('message', receive);
        }, []);
        React.useEffect(() => {
          const card = controls.current?.closest('[data-composer-card]');
          if (!card) return;
          const rail = document.createElement('div');
          rail.setAttribute('data-eac-selection-seat', '');
          card.insertBefore(rail, card.firstChild);
          setSelectionSeat(rail);
          return () => { rail.remove(); };
        }, [sessionId]);
        React.useEffect(() => {
          setIntroSeat(null);
          if (!sessionId) return;
          const card = controls.current?.closest('[data-composer-card]');
          const shell = card?.closest('[data-phase]');
          if (!card || !shell) return;
          // The host has no hero dock slot; keep this portal beside this control's own composer card.
          const seat = document.createElement('div');
          seat.setAttribute('data-eac-intro-seat', '');
          seat.hidden = true;
          const measure = () => {
            if (!seat.isConnected) return;
            const bounds = shell.getBoundingClientRect();
            const anchor = seat.getBoundingClientRect();
            const gutter = window.innerWidth <= 600 ? 12 : 24;
            const left = Math.max(gutter, bounds.left + gutter);
            const right = Math.min(window.innerWidth - gutter, bounds.right - gutter);
            seat.style.setProperty('--eac-gallery-left', `${left - anchor.left}px`);
            seat.style.setProperty('--eac-gallery-width', `${Math.max(0, right - left)}px`);
          };
          const update = () => {
            if (shell.getAttribute('data-phase') === 'hero') {
              if (!seat.isConnected) card.insertAdjacentElement('afterend', seat);
              measure();
              setIntroSeat(seat);
            } else { seat.remove(); setIntroSeat(null); }
          };
          const observer = new MutationObserver(update);
          observer.observe(shell, { attributes: true, attributeFilter: ['data-phase'] });
          const sizing = new ResizeObserver(measure);
          sizing.observe(shell); sizing.observe(card); sizing.observe(seat);
          window.addEventListener('resize', measure);
          window.addEventListener('scroll', measure, true);
          update();
          return () => {
            observer.disconnect(); sizing.disconnect();
            window.removeEventListener('resize', measure);
            window.removeEventListener('scroll', measure, true);
            seat.remove();
          };
        }, [sessionId]);
        React.useEffect(() => {
          if (introSeat) introSeat.hidden = !recommendationVisible({ dismissed, pickerOpen, mode: selection.mode });
        }, [introSeat, dismissed, pickerOpen, selection.mode]);
        const selectMode = mode => {
          if (!['normal', 'edit', 'design'].includes(mode)) return;
          const nextKey = mode === 'design' ? 'design' : 'edit';
          remember({ ...selection, mode,
            templateId: selection[`${nextKey}TemplateId`] || (mode === selection.mode ? selection.templateId : ''),
            templateName: selection[`${nextKey}TemplateName`] || (mode === selection.mode ? selection.templateName : ''),
          });
          setMenuOpen(false); setPickerOpen(false); setKindOpen(false);
          if (mode !== selection.mode) setDismissed(false);
          if (mode === 'normal') setCanvasOpen(false);
          setFailed(null);
        };
        const error = failed ? h('span', { className: 'eac-selection-error', role: 'alert' }, t('selectionFailed'), ' ',
          h('button', { type: 'button', onClick: () => synchronize(failed.value) }, t('addSelection'))) : null;
        const libraryTitle = selection.mode === 'design' ? t('designLibrary') : t('library');
        return h(React.Fragment, null,
          h('style', null, css),
          h('div', { ref: controls, className: 'eac-composer-controls', 'data-eac-mode': selection.mode },
            h(Menu, { open: menuOpen, side: 'top', portal: true, autoFocus: true, selectedId: selection.mode,
              listClassName: 'eac-mode-menu', onClose: () => setMenuOpen(false), onSelect: selectMode,
              items: [{ id: 'normal', label: t('normal'), icon: icon('normal') },
                { id: 'edit', label: t('edit'), icon: icon('edit') },
                { id: 'design', label: t('design'), icon: icon('design') }],
              anchor: h('button', { type: 'button', className: 'eac-composer-button', 'data-mode': selection.mode,
                'aria-label': `${t('mode')}: ${t(selection.mode)}`, 'aria-haspopup': 'menu', 'aria-expanded': menuOpen,
                onClick: () => setMenuOpen(value => !value), onKeyDown: event => {
                  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setMenuOpen(true); }
                } }, icon(selection.mode), h('span', null, t(selection.mode)), icon('up')) }),
            selection.mode !== 'normal' ? h(React.Fragment, null,
              selection.mode === 'design' ? h(Menu, { open: kindOpen, side: 'top', portal: true,
                selectedId: selection.kind, onClose: () => setKindOpen(false),
                onSelect: kind => { if (designKinds.includes(kind)) remember({ ...selection, kind }); setKindOpen(false); },
                items: designKinds.map(id => ({ id, label: t(id) })),
                anchor: h('button', { type: 'button', className: 'eac-composer-button', 'aria-label': `${t('mode')}: ${t(selection.kind || 'website')}`,
                  'aria-haspopup': 'menu', 'aria-expanded': kindOpen, onClick: () => setKindOpen(value => !value) }, t(selection.kind || 'website'), icon('up')) }) : null,
              h('span', { className: 'eac-control-divider', 'aria-hidden': true }),
              h('button', { type: 'button', className: 'eac-composer-button', 'aria-haspopup': 'dialog',
                'aria-expanded': pickerOpen, 'data-eac-selected-template': selection.templateId || undefined,
                title: selection.templateId ? `${t('selected')}: ${selection.templateName || selection.templateId}` : t('templates'),
                onClick: openPicker }, icon('templates'), h('span', null, selection.templateName || t('templates'))),
              h('button', { type: 'button', className: 'eac-composer-button', title: t('canvas'), 'aria-label': t('canvas'),
                onClick: openCanvas }, icon('canvas'))) : null,
            !pickerOpen ? error : null),
          selectionSeat ? createPortal(h('div', { className: 'eac-selection-rail' },
            selection.mode !== 'normal' && selection.templateId ? h(SelectionChip, { id: selection.templateId, name: selection.templateName, label: t('selected'),
              removeLabel: t('removeSelection'), onRemove: () => stage(selection.templateId, selection.templateName), onOpen: openPicker }) : null,
            selection.mode === 'design' && selection.designSystemId ? h(SelectionChip, { id: selection.designSystemId, name: selection.designSystemName, label: t('systems'),
              removeLabel: t('removeSelection'), onRemove: () => stage(selection.designSystemId, selection.designSystemName, 'design-system'), onOpen: openPicker }) : null,
            syncing && (selection.templateId || selection.designSystemId) ? h('span', { className: 'eac-selection-sync', role: 'status' }, t('syncing')) : null), selectionSeat) : null,
          h(Modal, { open: pickerOpen, onClose: () => setPickerOpen(false), title: libraryTitle, closeLabel: t('close'),
            className: 'eac-template-modal', headless: true },
            h('header', { className: 'eac-modal-heading' }, h('div', null, h('h2', null, libraryTitle), h('p', null, t(selection.mode === 'design' ? 'designDescription' : 'description'))),
              h('button', { type: 'button', className: 'eac-composer-button eac-modal-close', 'aria-label': t('close'),
                onClick: () => setPickerOpen(false) }, icon('close'))),
            pickerOpen ? h(PickerFrame, { key: selection.mode, frameRef: frame, selected: selection.templateId, designSystemId: selection.designSystemId, mode: selection.mode, kind: selection.kind, t }) : null,
            h('footer', { className: 'eac-modal-footer' }, error || h('span', null, t('draftOnly')),
              selection.templateId ? h('span', { role: 'status' }, `${t('selected')}: ${selection.templateName || selection.templateId}`) : null)),
          canvasOpen ? h(CanvasPanel, { sessionId, mode: selection.mode, onClose: () => setCanvasOpen(false) }) : null,
          introSeat ? createPortal(h('section', { className: 'eac-intro', 'aria-label': libraryTitle },
            h('button', { type: 'button', className: 'eac-composer-button eac-intro-dismiss', 'aria-label': t('dismiss'),
              onClick: () => setDismissed(true) }, icon('close')),
            h(PickerFrame, { key: selection.mode, frameRef: introFrame, selected: selection.templateId, designSystemId: selection.designSystemId, mode: selection.mode, kind: selection.kind, inline: true, height: introHeight, t })), introSeat) : null);
      }
      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'eac-design-world', order: 80,
        label: () => t('title'), inject: () => ({}),
      }, Settings)));
      ctx.effect(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left', id: 'eac-design-world/modes', order: 80,
      }, ComposerControls)));
    }
    return { name: 'eac-design-world', templateFromMessage, removeLegacySelection, toggledSelection, recommendationVisible, readSelection,
      inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'], apply };
  },
});
