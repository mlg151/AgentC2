import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, Minimize2, X } from 'lucide-react';
import type { AttentionItem, Session, SituationWorkspace, UnitPreview } from '../types';
import { isManagedSession, unitState } from '../workspace';
import { Modal } from './Modal';

const hints = ['A', 'S', 'D', 'F', 'J', 'K', 'L', 'Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O'];
export function Overwatch({ sessions, situation, attention, onSelect, onClose, standalone = false, onUndock, onDock }: { standalone?: boolean; onUndock?: () => void; onDock?: () => void; sessions: Session[]; situation: SituationWorkspace; attention: AttentionItem[]; onSelect: (session: Session) => void; onClose: () => void }) {
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(12);
  const [previews, setPreviews] = useState<Record<string, UnitPreview>>({});
  const [error, setError] = useState('');
  const [clock, setClock] = useState(Date.now());
  const selected = useRef(onSelect); selected.current = onSelect;
  const restoreFocus = useRef(true);
  function inspect(session: Session) { restoreFocus.current = false; selected.current(session); }
  const units = useMemo(() => sessions.filter(isManagedSession).sort((a, b) => Number(situation.callsigns[a.key] || 100) - Number(situation.callsigns[b.key] || 100) || a.key.localeCompare(b.key)), [sessions, situation.callsigns]);
  const pages = Math.max(1, Math.ceil(units.length / size));
  const currentPage = Math.min(page, pages - 1);
  const visible = useMemo(() => units.slice(currentPage * size, (currentPage + 1) * size), [units, currentPage, size]);
  const keys = visible.map((session) => session.key).join('\n');
  useEffect(() => { const frame = requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-label="Overwatch"] .overwatch-unit')?.focus()); return () => cancelAnimationFrame(frame); }, []);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      if (!document.hidden && keys && window.agentHQ) {
        try {
          const next = await window.agentHQ.terminalPreviews(keys.split('\n'));
          if (!cancelled) { setPreviews((current) => ({ ...current, ...Object.fromEntries(next.map((item) => [item.key, item])) })); setError(''); }
        } catch (cause) { if (!cancelled) setError(String(cause)); }
      }
      if (!cancelled) timer = setTimeout(() => { setClock(Date.now()); void refresh(); }, 5000);
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [keys]);
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey || (event.target as HTMLElement)?.closest('input,select,textarea')) return;
      const index = hints.indexOf(event.key.toUpperCase());
      if (index >= 0 && visible[index]) { event.preventDefault(); event.stopPropagation(); restoreFocus.current = false; selected.current(visible[index]); }
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); setPage((value) => Math.max(0, Math.min(pages - 1, value + (event.key === 'ArrowRight' ? 1 : -1)))); }
    }
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, [visible, pages]);
  const close = useCallback(onClose, [onClose]);
  const content = <><header className="overwatch-header"><div><strong>AGENTC2 <span>/ OVERWATCH</span></strong><small>{units.length} runtime units · read-only session snapshots</small></div><div className="overwatch-controls"><label>Grid<select aria-label="Overwatch grid size" value={size} onChange={(event) => { setSize(Number(event.target.value)); setPage(0); }}><option value={12}>4 × 3</option><option value={16}>4 × 4</option></select></label><button className="button-secondary" onClick={standalone ? onDock : onUndock}>{standalone ? <Minimize2 size={14} /> : <ExternalLink size={14} />}{standalone ? 'Dock to main window' : 'Undock window'}</button>{!standalone ? <button className="button-secondary" onClick={onClose}><X size={14} />Close Overwatch <kbd>Esc</kbd></button> : null}</div></header><div className={`overwatch-grid${size === 16 ? ' grid-sixteen' : ''}`}>{visible.map((session, index) => {
    const state = unitState(session, attention), preview = previews[session.key];
    const stale = !preview?.sampledAt || session.stale || clock - preview.sampledAt > 15000;
    return <button key={session.key} data-session-key={session.key} className={`overwatch-unit unit-${state.tone}`} aria-label={`Inspect unit ${situation.callsigns[session.key] || session.title}`} onClick={() => inspect(session)}><div className="overwatch-unit-heading"><kbd>{hints[index]}</kbd><strong>{situation.callsigns[session.key] || '—'} {session.provider.toUpperCase()}</strong><em>[{state.code}]</em></div><small title={session.cwd}>{session.hostName} · {session.branch ? `${session.branch} · ` : ''}{session.title}</small><pre>{preview?.text || 'Capturing read-only snapshot…'}</pre><span className="preview-time">{stale ? preview?.sampledAt ? 'Stale snapshot' : preview?.error ? 'Unavailable' : 'Waiting for snapshot' : `${Math.max(0, Math.round((clock - preview!.sampledAt!) / 1000))}s ago · snapshot`}</span></button>;
  })}{!units.length ? <p>No runtime units. Start or resume a session to inspect it here.</p> : null}</div>{error ? <p className="form-error" role="alert">{error}</p> : null}<footer className="overwatch-footer"><span>Snapshots never take control or resize terminals · select a unit to inspect</span><div><button className="icon-button" aria-label="Previous Overwatch page" disabled={currentPage === 0} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={16} /></button><span>Page {currentPage + 1} of {pages}</span><button className="icon-button" aria-label="Next Overwatch page" disabled={currentPage + 1 >= pages} onClick={() => setPage((value) => value + 1)}><ChevronRight size={16} /></button></div></footer></>;
  return standalone ? <main className="overwatch-standalone" aria-label="Overwatch">{content}</main> : <div className="overwatch-overlay"><Modal title="Overwatch" onClose={close} wide restoreFocus={restoreFocus}>{content}</Modal></div>;
}
