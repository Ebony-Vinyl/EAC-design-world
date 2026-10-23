import React, { useEffect, useState } from 'react';
import { kindLabel } from './templates';
import { previewImage } from './library-selection.mjs';
import './library-picker.css';

export default function LibraryThumbnail({ item, system = false }) {
  const primary = item.thumbnail || previewImage(item);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { setFailed(false); setLoaded(false); }, [primary]);
  const colors = item.colors || [];
  const value = (name, fallback) => colors.find(color => color.name === name)?.value || fallback;
  const accent = value('--accent', '#4d6bfe');
  return <>
    {!failed && <img className={`library-cover ${loaded ? 'cover-loaded' : ''}`} src={primary} alt={item.name} loading="lazy" decoding="async" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />}
    {(!loaded || failed) && <div className={`library-specimen ${system ? 'is-system' : ''}`} style={{ '--spec-bg': value('--bg', '#eef1f7'), '--spec-ink': value('--fg', '#171923'), '--spec-accent': accent, fontFamily: item.fonts?.[0]?.family || 'Georgia,serif' }}>
      <div className="specimen-top"><span>{system ? 'DESIGN SYSTEM' : kindLabel(item.kind)}</span><span>↗</span></div>
      <strong>{system ? 'Aa' : item.name}</strong>
      <span className="specimen-rule" />
      <div className="specimen-bottom"><span>{system ? item.name : '创作参考'}</span><div>{colors.slice(0, 4).map((color, index) => <i key={index} style={{ background: color.value }} />)}</div></div>
    </div>}
  </>;
}
