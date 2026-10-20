import { useState } from 'react';
import { Modal } from './Modal';
import type { Session } from '../types';

export function QuickSwitcher({ sessions, onSelect, onNew, onSettings, onInbox, onClose }: { sessions: Session[]; onSelect: (session: Session) => void; onNew: () => void; onSettings: () => void; onInbox: () => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const q = query.toLowerCase();
  const entries = [
    { id: 'new', title: 'New session', subtitle: 'Start an agent', run: onNew },
    { id: 'inbox', title: 'Attention inbox', subtitle: 'Review input requests and results', run: onInbox },
    { id: 'settings', title: 'Settings', subtitle: 'SSH hosts and launch presets', run: onSettings },
    ...sessions.map((s) => ({ id: s.key, title: s.title, subtitle: `${s.hostName} · ${s.provider} · ${s.cwd}`, run: () => onSelect(s) })),
  ].filter((e) => `${e.title} ${e.subtitle}`.toLowerCase().includes(q)).slice(0, 60);
  function run(i: number) { const entry = entries[i]; if (entry) { onClose(); entry.run(); } }
  return <Modal title="Quick switcher" onClose={onClose}>
    <input aria-label="Quick switcher search" placeholder="Search sessions, projects, or actions…" value={query} onChange={(e) => { setQuery(e.target.value); setIndex(0); }} onKeyDown={(e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, Math.min(entries.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))); }
      if (e.key === 'Enter') { e.preventDefault(); run(index); }
    }} />
    <div className="quick-results" role="listbox" aria-label="Quick switcher results">{entries.map((e, i) => <button key={e.id} role="option" aria-selected={i === index} className={i === index ? 'active' : ''} onClick={() => run(i)}><strong>{e.title}</strong><small>{e.subtitle}</small></button>)}{!entries.length ? <p>No matching sessions or actions.</p> : null}</div>
    <p className="field-note">↑ ↓ to choose · Enter to open · Esc to close</p>
  </Modal>;
}
