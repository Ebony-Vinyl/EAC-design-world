import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { fileUrl } from './api';

const PreviewContext = createContext(null);
const MAX_PLAYING = 3;

export function MotionThumbnailProvider({ autoplay = false, suspended = false, children }) {
  const entries = useRef(new Map());
  const observer = useRef(null);
  const options = useRef({ autoplay, suspended });
  options.current = { autoplay, suspended };
  const reconcile = useCallback(() => {
    const candidates = [...entries.current.values()].filter(entry => !entry.failed && entry.visible
      && !document.hidden && !options.current.suspended && (entry.hovered || options.current.autoplay))
      .sort((a, b) => Number(b.hovered) - Number(a.hovered) || b.ratio - a.ratio);
    const active = new Set(candidates.slice(0, MAX_PLAYING));
    for (const entry of entries.current.values()) {
      const shouldPlay = active.has(entry);
      if (!shouldPlay) {
        entry.wanted = false;
        entry.video.pause();
        entry.onPlaying(false);
      } else if (!entry.wanted) {
        entry.wanted = true;
        if (!entry.video.getAttribute('src')) entry.video.src = fileUrl(entry.source);
        entry.video.play()?.then(() => {
          if (entry.wanted && entries.current.has(entry.video)) entry.onPlaying(true);
          else entry.video.pause();
        }).catch(error => {
          entry.wanted = false;
          if (error.name !== 'AbortError' && error.name !== 'NotAllowedError') entry.failed = true;
          entry.onPlaying(false);
        });
      }
    }
  }, []);
  const register = useCallback((video, source, onPlaying) => {
    const entry = { video, source, onPlaying, visible: false, ratio: 0, hovered: false, wanted: false };
    entries.current.set(video, entry);
    observer.current?.observe(video);
    const hover = event => {
      entry.hovered = event.type === 'pointerenter' || event.type === 'focusin';
      reconcile();
    };
    const cover = video.closest('.library-card-cover');
    for (const event of ['pointerenter', 'pointerleave', 'focusin', 'focusout']) cover?.addEventListener(event, hover);
    return () => {
      entries.current.delete(video);
      observer.current?.unobserve(video);
      for (const event of ['pointerenter', 'pointerleave', 'focusin', 'focusout']) cover?.removeEventListener(event, hover);
      entry.wanted = false;
      video.pause();
      video.removeAttribute('src');
      video.load();
      reconcile();
    };
  }, [reconcile]);
  useEffect(() => {
    if (typeof IntersectionObserver !== 'function') return;
    observer.current = new IntersectionObserver(changes => {
      for (const change of changes) {
        const entry = entries.current.get(change.target);
        if (entry) { entry.visible = change.isIntersecting && change.intersectionRatio >= 0.25; entry.ratio = change.intersectionRatio; }
      }
      reconcile();
    }, { threshold: [0, 0.25, 0.6, 1] });
    for (const entry of entries.current.values()) observer.current.observe(entry.video);
    document.addEventListener('visibilitychange', reconcile);
    return () => {
      observer.current?.disconnect();
      observer.current = null;
      document.removeEventListener('visibilitychange', reconcile);
      for (const entry of entries.current.values()) { entry.wanted = false; entry.video.pause(); }
    };
  }, [reconcile]);
  useEffect(reconcile, [autoplay, suspended, reconcile]);
  return <PreviewContext.Provider value={register}>{children}</PreviewContext.Provider>;
}

export default function MotionThumbnail({ item }) {
  const register = useContext(PreviewContext);
  const ref = useRef(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    setPlaying(false);
    if (!ref.current || !register || !item.preview) return;
    return register(ref.current, item.preview, setPlaying);
  }, [register, item.preview]);
  if (!item.preview) return null;
  return <video ref={ref} className={`library-motion-video ${playing ? 'is-playing' : ''}`}
    aria-hidden="true" muted loop playsInline preload="none" disablePictureInPicture tabIndex={-1} />;
}
