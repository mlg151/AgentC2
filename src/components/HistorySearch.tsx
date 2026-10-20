import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './Modal';

export function HistorySearch({ terminalId, onClose }: { terminalId: string; onClose: () => void }) {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState('Loading retained tmux history…');
  const [revision, setRevision] = useState(0);
  const currentRef = useRef<HTMLElement>(null);
  useEffect(() => {
    let cancelled = false;
    setStatus('Loading retained tmux history…');
    void window.agentHQ?.terminalHistory(terminalId).then((result) => {
      if (cancelled) return;
      setText(result.text); setIndex(0); setStatus(result.truncated ? 'Showing the most recent 4 million characters.' : 'Snapshot of up to 50,000 retained lines.');
    }).catch((cause) => { if (!cancelled) setStatus(String(cause)); });
    return () => { cancelled = true; };
  }, [terminalId, revision]);
  const matches = useMemo(() => {
    if (!query) return [];
    const source = text.toLowerCase(), needle = query.toLowerCase();
    const result: number[] = [];
    let start = 0, found;
    while ((found = source.indexOf(needle, start)) !== -1) { result.push(found); start = found + needle.length; }
    return result;
  }, [text, query]);
  const current = matches.length ? matches[index % matches.length] : -1;
  const start = current < 0 ? Math.max(0, text.length - 20000) : Math.max(0, current - 3000);
  const end = current < 0 ? text.length : Math.min(text.length, current + query.length + 3000);
  useEffect(() => { currentRef.current?.scrollIntoView({ block: 'center' }); }, [current]);
  function move(delta: number) { if (matches.length) setIndex((i) => (i + delta + matches.length) % matches.length); }
  return <Modal title="Search terminal history" onClose={onClose} wide>
    <div className="dialog-heading"><div><h2>Search terminal history</h2><p>{status}</p></div><button aria-label="Close history search" className="icon-button" onClick={onClose}>×</button></div>
    <div className="inline-actions"><input className="grow" aria-label="Find in history" value={query} onChange={(e) => { setQuery(e.target.value); setIndex(0); }} placeholder="Find text…" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); move(e.shiftKey ? -1 : 1); } }} /><button className="button-secondary" disabled={!matches.length} onClick={() => move(-1)}>Previous</button><button className="button-secondary" disabled={!matches.length} onClick={() => move(1)}>Next</button><button className="button-secondary" onClick={() => setRevision((r) => r + 1)}>Reload</button></div>
    <span role="status">{matches.length ? `${index % matches.length + 1} of ${matches.length} matches` : query ? 'No matches' : 'Enter text to search'}</span>
    <pre className="history-output">{current < 0 ? text.slice(start, end) : <>{text.slice(start, current)}<mark ref={currentRef}>{text.slice(current, current + query.length)}</mark>{text.slice(current + query.length, end)}</>}</pre>
    <p className="field-note">Search includes history retained before attachment. Enter / Shift+Enter moves between matches.</p>
  </Modal>;
}
