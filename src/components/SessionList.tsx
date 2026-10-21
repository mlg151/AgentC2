import { useEffect, useMemo, useState } from 'react';
import { Search, RefreshCw, Plus, Pin } from 'lucide-react';
import { ProviderMark } from './ProviderMark';
import type { Provider, Session, SessionMetadata } from '../types';
import { projectFor } from '../workspace';

export type ProviderFilter = 'all' | Provider;
export type StateFilter = 'all' | 'live' | 'saved';

function relativeTime(value: string | null) {
  if (!value) return 'Unknown';
  const diff = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diff) || diff < 0) return 'Recently';
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function stateLabel(session: Session) {
  if (session.stale) return 'Host unavailable · last known state';
  if (session.state === 'exited') return `Exited (${session.exitCode ?? '?'})`;
  if (session.kind === 'managed') return 'Managed';
  if (session.kind === 'external-tmux') return 'External tmux';
  if (session.kind === 'unmanaged') return 'Unmanaged process';
  if (session.kind === 'background') return session.state === 'blocked' ? 'Needs attention' : 'Background agent';
  return session.state === 'archived' ? 'Archived' : 'Saved';
}

export function SessionList({ sessions, selectedKey, onSelect, providerFilter, stateFilter, onStateFilter, onRefresh, onNew, loading, metadata, pinning, onPin }: {
  sessions: Session[];
  selectedKey: string | null;
  onSelect: (session: Session) => void;
  providerFilter: ProviderFilter;
  stateFilter: StateFilter;
  onStateFilter: (filter: StateFilter) => void;
  onRefresh: () => void;
  onNew: () => void;
  loading: boolean;
  metadata: Record<string, SessionMetadata>;
  pinning: ReadonlySet<string>;
  onPin: (session: Session) => void;
}) {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(150);
  useEffect(() => setLimit(150), [query, providerFilter, stateFilter]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((session) => {
      if (providerFilter !== 'all' && session.provider !== providerFilter) return false;
      if (stateFilter === 'live' && session.state !== 'live') return false;
      if (stateFilter === 'saved' && session.state === 'live') return false;
      return !q || `${session.title} ${session.cwd} ${session.id} ${session.provider} ${session.hostName} ${projectFor(session, metadata)}`.toLowerCase().includes(q);
    }).sort((a, b) => Number(Boolean(metadata[b.key]?.pinned)) - Number(Boolean(metadata[a.key]?.pinned)));
  }, [sessions, query, providerFilter, stateFilter, metadata]);

  return <section className="session-column" aria-label="Sessions">
    <div className="session-controls">
      <div className="search-row">
        <label className="search-box"><Search size={17} aria-hidden="true" /><input aria-label="Search sessions" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search sessions..." /></label>
        <button className="icon-button" title="Refresh sessions" aria-label="Refresh sessions" onClick={onRefresh} disabled={loading}><RefreshCw size={17} className={loading ? 'spin' : ''} /></button>
      </div>
      <div className="filter-row">
        <div className="segmented" role="group" aria-label="Session status">
          {(['all', 'live', 'saved'] as const).map((filter) => <button key={filter} className={stateFilter === filter ? 'active' : ''} onClick={() => onStateFilter(filter)}>{filter === 'all' ? 'All' : filter === 'live' ? 'Live' : 'Saved'}</button>)}
        </div>
        <button className="new-inline" onClick={onNew}><Plus size={16} /> New</button>
      </div>
    </div>
    <div className="list-heading"><span>SESSION</span><span>LAST ACTIVITY</span></div>
    <div className="session-scroll">
      {filtered.length === 0 ? <div className="empty-list">{loading ? 'Loading sessions…' : 'No sessions match this view.'}</div> : null}
      {filtered.slice(0, limit).map((session) => <div className="session-entry" key={session.key}><button className={`session-row${selectedKey === session.key ? ' selected' : ''}`} onClick={() => onSelect(session)}>
        <ProviderMark provider={session.provider} small />
        <span className="session-main"><strong title={session.title}>{session.title}</strong><small title={session.cwd}>{session.hostName} · {session.cwd || session.id}</small><em className={session.state === 'live' && !session.stale ? 'is-live' : ''}><i />{stateLabel(session)}</em></span>
        <time title={session.updatedAt || ''}>{relativeTime(session.updatedAt)}</time>
      </button><button className={`pin-button${metadata[session.key]?.pinned ? ' pinned' : ''}`} aria-label={`${metadata[session.key]?.pinned ? 'Unpin' : 'Pin'} ${session.title}`} aria-pressed={Boolean(metadata[session.key]?.pinned)} disabled={pinning.has(session.key)} onClick={() => onPin(session)}><Pin size={13} /></button></div>)}
      {filtered.length > limit ? <button className="show-more" onClick={() => setLimit((current) => current + 150)}>Show more ({filtered.length - limit} remaining)</button> : null}
    </div>
    <div className="list-footer">{filtered.length.toLocaleString()} session{filtered.length === 1 ? '' : 's'}</div>
  </section>;
}
