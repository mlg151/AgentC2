import { useEffect, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';

export function Modal({ title, onClose, children, wide = false, restoreFocus }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; restoreFocus?: RefObject<boolean> }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // The dialog is mounted for this effect; retain it until listener cleanup.
    const dialog = ref.current!;
    const controls = () => [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled):not([type="hidden"]),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')];
    (controls()[0] || dialog).focus();
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab') return;
      const nodes = controls();
      const first = nodes[0], last = nodes.at(-1)!;
      if (!first) { event.preventDefault(); dialog.focus(); }
      else if (!dialog.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); if (restoreFocus?.current !== false) previous?.focus(); };
  }, [onClose, restoreFocus]);
  return <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={`create-dialog${wide ? ' wide-dialog' : ''}`}>{children}</div></div>;
}
