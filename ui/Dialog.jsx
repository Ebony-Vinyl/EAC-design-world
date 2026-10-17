import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

const dialogs = [];

export default function Dialog({ title, children, onClose, className = '' }) {
  const ref = useRef(null);
  const previousFocus = useRef(document.activeElement);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const element = ref.current;
    const previous = previousFocus.current;
    const overflow = document.body.style.overflow;
    dialogs.push(element);
    document.body.style.overflow = 'hidden';
    const focusable = () => [...element.querySelectorAll(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], video[controls], [tabindex="0"]',
    )].filter(node => node.getClientRects().length && !node.closest('[inert]'));
    if (!element.contains(document.activeElement)) (focusable()[0] || element).focus();
    const handler = event => {
      if (dialogs.at(-1) !== element) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
      }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      const first = elements[0] || element;
      const last = elements.at(-1) || element;
      if (event.shiftKey && (document.activeElement === first || !elements.includes(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !elements.includes(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => {
      document.removeEventListener('keydown', handler, true);
      dialogs.splice(dialogs.indexOf(element), 1);
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <section ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={`dialog ${className}`}>
      <header className="dialog-header"><h2>{title}</h2><button type="button" className="icon-button" title="关闭" aria-label="关闭" onClick={onClose}><X size={17} /></button></header>
      {children}
    </section>
  </div>;
}
