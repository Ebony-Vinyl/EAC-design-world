const channelPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const modes = new Set(['auto', 'interactive', 'timeline']);

export function previewConfig(params, origin) {
  if (!params.has('eac-preview')) return null;
  if (params.get('eac-preview') !== '1' || !channelPattern.test(params.get('channel') || '')) throw new Error('Invalid preview channel');
  const bounded = (name, fallback, min, max) => {
    if (!params.has(name)) return fallback;
    const value = Number(params.get(name));
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid preview ${name}`);
    return value;
  };
  const mode = params.get('mode') || 'auto';
  if (!modes.has(mode)) throw new Error('Invalid preview mode');
  return {
    channel: params.get('channel'), origin: new URL(origin).origin,
    width: bounded('width', 1920, 1, 16384), height: bounded('height', 1080, 1, 16384),
    duration: bounded('duration', 12, 0.01, 600),
    interactive: mode === 'interactive', timeline: mode === 'timeline',
  };
}

export function previewUrl(entry, { channel, width, height, duration, mode = 'auto' }, origin) {
  const url = new URL(entry, origin);
  if (url.origin !== new URL(origin).origin || !url.pathname.startsWith('/vendor/')) throw new Error('Invalid preview URL');
  for (const [key, value] of Object.entries({ 'eac-preview': '1', channel, width, height, duration, mode })) {
    url.searchParams.set(key, String(value));
  }
  previewConfig(url.searchParams, origin);
  return url.href;
}

// Runs inside an opaque-origin document. Only its parent can drive the clock.
function previewBridge(config) {
  window.__odMotionRender = true;
  let duration = config.duration, time = 0, playing = false, render, frame, poll, last, reported = 0, disposed = false, revision = 0;
  let renderQueue = Promise.resolve(), commandQueue = Promise.resolve();
  const send = (type, data = {}) => parent.postMessage({ channel: config.channel, type, ...data }, config.origin);
  const number = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
  const cancel = () => { revision++; cancelAnimationFrame(frame); last = undefined; };
  const state = () => send('state', { time, playing });
  const fail = () => { playing = false; cancel(); send('error'); };
  const draw = value => {
    const target = Math.max(0, Math.min(duration, value));
    renderQueue = renderQueue.catch(() => {}).then(async () => {
      if (disposed) return;
      await render(target);
      time = target;
    });
    return renderQueue;
  };
  const tick = async (now, version) => {
    if (!playing || disposed || document.hidden || version !== revision) { last = undefined; return; }
    const delta = last === undefined ? 0 : Math.min((now - last) / 1000, 0.25);
    last = now;
    try { await draw(time + delta); } catch { fail(); return; }
    if (disposed || version !== revision) return;
    if (time >= duration) playing = false;
    if (now - reported > 150 || !playing) { state(); reported = now; }
    if (playing) frame = requestAnimationFrame(next => tick(next, version));
  };
  const start = () => {
    cancel();
    const version = revision;
    if (playing && !document.hidden) frame = requestAnimationFrame(now => tick(now, version));
  };
  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source !== parent || event.origin !== config.origin || data?.channel !== config.channel || disposed) return;
    if (data.type === 'dispose') {
      disposed = true; playing = false; cancel(); clearTimeout(poll);
      document.querySelectorAll('video,audio').forEach(media => media.pause());
      return;
    }
    if (!render || !['seek', 'pause', 'play'].includes(data.type)) return;
    cancel();
    commandQueue = commandQueue.catch(() => {}).then(async () => {
      if (disposed) return;
      try {
        if (data.type === 'seek' && Number.isFinite(data.time)) await draw(data.time);
        else await renderQueue;
        if (data.type === 'pause') playing = false;
        if (data.type === 'play') { if (time >= duration) await draw(0); playing = true; }
        state(); start();
      } catch { fail(); }
    });
  });
  document.addEventListener('visibilitychange', start);
  window.addEventListener('pagehide', () => { disposed = true; cancel(); clearTimeout(poll); }, { once: true });
  window.addEventListener('error', event => {
    if (event instanceof ErrorEvent && event.message) fail();
  });
  window.addEventListener('load', async () => {
    await Promise.race([
      Promise.all([document.fonts.ready, ...[...document.images].map(image => image.decode().catch(() => {}))]),
      new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
    const probe = async () => {
      if (disposed) return;
      const values = window.__timelines;
      const timelines = Array.isArray(values) ? values : values instanceof Map ? [...values.values()] : Object.values(values || {});
      const seekable = timelines.filter(timeline => typeof timeline?.seek === 'function');
      const nativeRender = window.renderAt || window.__seek;
      if (window.__ready === false) { poll = setTimeout(probe, 50); return; }
      if (typeof nativeRender === 'function') render = value => nativeRender.call(window, value);
      else if (seekable.length) render = value => seekable.forEach(timeline => timeline.seek(value, false));
      const animations = document.getAnimations();
      if (!render && !config.interactive && animations.length) {
        render = value => animations.forEach(animation => { animation.currentTime = value * 1000; });
      }
      if (render) {
        seekable.forEach(timeline => timeline.pause?.());
        animations.forEach(animation => animation.pause());
        const declared = [...document.querySelectorAll('[data-duration]')].map(node => Number(node.dataset.duration));
        for (const timeline of seekable) {
          declared.push(Number(typeof timeline.duration === 'function' ? timeline.duration() : timeline.duration));
        }
        duration = number(window.DEMO?.duration || window.__DUR || window.__meta?.dur || window.__meta?.duration,
          Math.max(0, ...declared.filter(Number.isFinite)) || config.duration);
        try { await draw(0); } catch { fail(); return; }
      } else if (!config.interactive && config.timeline) {
        poll = setTimeout(probe, 50); return;
      }
      const meta = window.__meta || window.DEMO || {};
      const body = getComputedStyle(document.body);
      const bodyWidth = parseFloat(body.width), bodyHeight = parseFloat(body.height);
      const fixedBody = Math.abs(bodyWidth + (parseFloat(body.marginLeft) || 0) + (parseFloat(body.marginRight) || 0) - innerWidth) > 1;
      const width = number(meta.w || meta.width, fixedBody ? number(bodyWidth, config.width) : config.width);
      const height = number(meta.h || meta.height, fixedBody ? number(bodyHeight, config.height) : config.height);
      send('ready', { duration, deterministic: Boolean(render), width, height });
    };
    void probe();
  }, { once: true });
}

export function injectPreviewBridge(html, config) {
  const script = `<script>(${previewBridge.toString()})(${JSON.stringify(config).replaceAll('<', '\\u003c')});</script>`;
  // Insert before source scripts while keeping the doctype and the original URLs intact.
  const prolog = /^(?:\uFEFF|\s|<!--[\s\S]*?-->)*(?:<!doctype\s+html[^>]*>)?/i.exec(html)[0].length;
  return `${html.slice(0, prolog)}${script}${html.slice(prolog)}`;
}
