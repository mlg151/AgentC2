import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import type { HistoryMatches, Session } from '../types';
import { commandBinding, commandDefinitions } from '../commands';
import type { CommandActions } from '../commands';

export function QuickSwitcher({ sessions, callsigns, actions, overrides, onSelect, onSettings, onInbox, onClose }: { sessions: Session[]; callsigns: Record<string, string>; actions: CommandActions; overrides: Record<string, string>; onSelect: (session: Session) => void; onSettings: () => void; onInbox: () => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [history, setHistory] = useState<HistoryMatches | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const restoreFocus = useRef(true);
  useEffect(() => () => { generation.current++; }, []);
  const q = query.toLowerCase();
  const entries = [
    { id: 'inbox', title: 'Attention inbox', subtitle: 'Review input requests and results', run: onInbox },
    { id: 'settings', title: 'Settings', subtitle: 'Local/Hosts and launch presets', run: onSettings },
    ...commandDefinitions.filter((command) => actions[command.id] && actions[command.id]?.available !== false && command.id !== 'search').map((command) => ({ id: `command:${command.id}`, title: command.label, subtitle: `Command · ${commandBinding(command.id, overrides) || `command mode → ${command.chord.toUpperCase()}`}`, run: () => actions[command.id]?.run() })),
    ...sessions.map((s) => ({ id: s.key, title: `${callsigns[s.key] ? callsigns[s.key] + ' / ' : ''}${s.title}`, subtitle: `${s.hostName} · ${s.provider} · ${s.branch || ''} ${s.cwd} ${s.repository || ''}`, run: () => onSelect(s) })),
  ].filter((e) => q.split(/\s+/).every((token) => `${e.title} ${e.subtitle}`.toLowerCase().includes(token)))
    .sort((a, b) => Number(!a.title.toLowerCase().includes(q)) - Number(!b.title.toLowerCase().includes(q)))
    .slice(0, 60);
  function run(i: number) { const entry = entries[i]; if (entry) { restoreFocus.current = false; onClose(); entry.run(); } }
  async function search() {
    if (!window.agentHQ) return;
    const request = ++generation.current;
    setSearching(true); setError('');
    try { const matches = await window.agentHQ.searchHistory(query, sessions.filter((session) => session.canAttach).slice(0, 200).map((session) => session.key)); if (request === generation.current) setHistory(matches); }
    catch (cause) { if (request === generation.current) setError(String(cause)); }
    finally { if (request === generation.current) setSearching(false); }
  }
  return <Modal title="Quick switcher" onClose={onClose} restoreFocus={restoreFocus}>
    <input aria-label="Quick switcher search" placeholder="Search callsigns, sessions, projects, or actions…" value={query} onChange={(e) => { generation.current++; setQuery(e.target.value); setIndex(0); setHistory(null); setSearching(false); }} onKeyDown={(e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, Math.min(entries.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))); }
      if (e.key === 'Enter') { e.preventDefault(); if (e.ctrlKey && query.length >= 3) void search(); else run(index); }
    }} />
    <div className="quick-results" role="listbox" aria-label="Quick switcher results">{entries.map((e, i) => <button key={e.id} role="option" aria-selected={i === index} className={i === index ? 'active' : ''} onClick={() => run(i)}><strong>{e.title}</strong><small>{e.subtitle}</small></button>)}{!entries.length ? <p>No matching sessions or actions.</p> : null}</div>
    <button className="button-secondary" disabled={query.length < 3 || searching} onClick={() => void search()}>{searching ? 'Searching snapshots…' : 'Search retained terminal history'}</button>
    {history ? <section className="history-matches" aria-label="History search results"><p className="field-note">Searched {history.searched}/{history.total} attachable units (bounded to 200 candidates, 8 snapshots, 5 matches per unit). {history.truncated ? 'Results or retained snapshots are truncated.' : ''} {history.errors.length ? `${history.errors.length} snapshots unavailable.` : ''}</p>{history.matches.map((match, index) => <button key={`${match.key}/${index}`} onClick={() => { const session = sessions.find((item) => item.key === match.key); if (session) { restoreFocus.current = false; onClose(); onSelect(session); } }}><strong>{sessions.find((session) => session.key === match.key)?.title} · line {match.line}</strong><code>{match.excerpt}</code></button>)}{!history.matches.length ? <p>No matches in the inspected retained snapshots.</p> : null}</section> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <p className="field-note">↑ ↓ to choose · Enter to open · Esc to close</p>
  </Modal>;
}
