import { useMemo, useState } from 'react';
import { Bell, ChevronDown, ChevronRight, Pin, Plus, RefreshCw, Search, Settings, SlidersHorizontal, Trash2 } from 'lucide-react';
import type { AttentionItem, Provider, Session, SessionMetadata, SituationWorkspace } from '../types';
import { isManagedSession, projectFor, unitState } from '../workspace';

export type ProviderFilter = 'all' | Provider;
export type StateFilter = 'all' | 'live' | 'saved';
interface Props {
  sessions: Session[]; selectedKey: string | null; onSelect: (session: Session) => void;
  providerFilter: ProviderFilter; onProviderFilter: (filter: ProviderFilter) => void;
  stateFilter: StateFilter; onStateFilter: (filter: StateFilter) => void;
  onRefresh: () => void; onNew: () => void; loading: boolean;
  metadata: Record<string, SessionMetadata>; pinning: ReadonlySet<string>; onPin: (session: Session) => void;
  situation: SituationWorkspace; onSituation: (patch: Partial<SituationWorkspace>) => void; attention: AttentionItem[];
  projects: string[]; projectFilter: string; onProjectFilter: (value: string) => void;
  pinnedOnly: boolean; onPinnedOnly: () => void; onInbox: () => void; onCleanup: () => void; onSettings: () => void;
}

export function SessionList(props: Props) {
  const { sessions, selectedKey, onSelect, providerFilter, onProviderFilter, stateFilter, onStateFilter, onRefresh, onNew, loading, metadata, pinning, onPin, situation, onSituation, attention, projects, projectFilter, onProjectFilter, pinnedOnly, onPinnedOnly, onInbox, onCleanup, onSettings } = props;
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(150);
  const { filtered, groups } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = sessions.filter((session) => isManagedSession(session) && (providerFilter === 'all' || session.provider === providerFilter) && (stateFilter === 'all' || (stateFilter === 'live' ? session.state === 'live' : session.state !== 'live')) && (!q || `${session.title} ${session.id} ${session.cwd} ${session.provider} ${session.hostName} ${session.branch || ''} ${situation.callsigns[session.key] || ''} ${projectFor(session, metadata)}`.toLowerCase().includes(q))).sort((a, b) => (situation.urgentFirst ? unitState(a, attention).priority - unitState(b, attention).priority : 0) || Number(Boolean(metadata[b.key]?.pinned)) - Number(Boolean(metadata[a.key]?.pinned)) || Number(situation.callsigns[a.key] || 100) - Number(situation.callsigns[b.key] || 100));
    const groups = new Map<string, Session[]>();
    for (const session of filtered.slice(0, limit)) {
      const group = situation.groupBy === 'host' ? session.hostName : session.repository || projectFor(session, metadata);
      groups.set(group, [...(groups.get(group) || []), session]);
    }
    return { filtered, groups };
  }, [sessions, query, providerFilter, stateFilter, situation, metadata, attention, limit]);
  function toggleGroup(group: string) { onSituation({ collapsedGroups: situation.collapsedGroups.includes(group) ? situation.collapsedGroups.filter((value) => value !== group) : [...situation.collapsedGroups, group] }); }
  return <aside className="session-column situation-roster" aria-label="ORBAT roster">
    <div className="roster-heading"><strong>ORBAT ROSTER <span>({filtered.length})</span></strong><button className="icon-button" title="Refresh sessions" aria-label="Refresh sessions" disabled={loading} onClick={onRefresh}><RefreshCw size={14} className={loading ? 'spin' : ''} /></button></div>
    <div className="session-controls">
      <label className="search-box"><Search size={14} /><input aria-label="Search sessions" value={query} placeholder="Search callsigns…" onChange={(event) => { setQuery(event.target.value); setLimit(150); }} /></label>
      <div className="roster-filters"><select aria-label="Filter provider" value={providerFilter} onChange={(event) => onProviderFilter(event.target.value as ProviderFilter)}><option value="all">All providers</option><option value="codex">Codex</option><option value="claude">Claude</option><option value="antigravity">Antigravity</option><option value="terminal">Terminals</option></select><select aria-label="Filter session status" value={stateFilter} onChange={(event) => onStateFilter(event.target.value as StateFilter)}><option value="all">All states</option><option value="live">Live</option><option value="saved">Saved</option></select></div>
      <select className="project-picker" aria-label="Filter project" value={projectFilter} onChange={(event) => onProjectFilter(event.target.value)}><option value="">All repositories / projects</option>{projects.map((project) => <option key={project} value={project}>{project}</option>)}</select>
      <div className="roster-options-row"><button className={`text-button${pinnedOnly ? ' active' : ''}`} aria-pressed={pinnedOnly} onClick={onPinnedOnly}><Pin size={12} />Pinned sessions</button><details className="roster-options"><summary aria-label="Roster options"><SlidersHorizontal size={14} /></summary><div><label>Group by<select aria-label="Group roster" value={situation.groupBy} onChange={(event) => onSituation({ groupBy: event.target.value as SituationWorkspace['groupBy'], collapsedGroups: [] })}><option value="host">Theater / host</option><option value="repository">Repository</option></select></label><label><input type="checkbox" checked={situation.urgentFirst} onChange={(event) => onSituation({ urgentFirst: event.target.checked })} />Urgent units first</label><label><input type="checkbox" checked={situation.ligatures} onChange={(event) => onSituation({ ligatures: event.target.checked })} />Font ligatures where supported</label></div></details></div>
    </div>
    <div className="session-scroll">
      {!filtered.length ? <div className="empty-list">{loading ? 'Loading units…' : 'No sessions match this view.'}</div> : null}
      {[...groups].map(([group, units]) => <section className="roster-group" key={group}><button className="roster-group-heading" aria-expanded={!situation.collapsedGroups.includes(group)} title={group} onClick={() => toggleGroup(group)}>{situation.collapsedGroups.includes(group) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<span>{group.split('/').filter(Boolean).at(-1) || group}</span><small>{units.length}</small></button>{!situation.collapsedGroups.includes(group) ? units.map((session) => {
        const state = unitState(session, attention), samples = session.outputActivity;
        const contextPercent = session.telemetry?.status === 'reported' ? session.telemetry.context?.percent : null;
        return <div className={`session-entry unit-${state.tone}`} key={session.key}><button className={`session-row${selectedKey === session.key ? ' selected' : ''}${situation.anchorKey === session.key ? ' anchored' : ''}`} onClick={() => onSelect(session)} title={`${session.title}\n${session.hostName} · ${session.cwd || session.id}\n${state.label}`}><span className="unit-callsign">{situation.callsigns[session.key] || (session.kind === 'conversation' ? '··' : '—')}</span><span className="session-main"><span className="unit-first-line"><strong>{session.provider === 'antigravity' ? 'ANTIGRV' : session.provider.toUpperCase()}</strong><em className={`unit-state ${state.tone}`} title={state.label}>[{session.specops?.state === 'halted' ? '!HALT' : state.code}]</em></span><small className="unit-session-name" title={session.branch ? `${session.title} · ${session.branch}` : session.title}>{session.title}</small>{session.specops ? <small className="specops-roster" title={session.specops.breadcrumb}>{session.specops.state === 'halted' ? '[!HALT] ' : ''}{session.specops.breadcrumb}</small> : null}{contextPercent != null ? <span className={`context-line${contextPercent >= 90 ? ' fault' : contextPercent >= 75 ? ' halt' : ''}`} role="meter" aria-label="Context usage" aria-valuenow={contextPercent} aria-valuemin={0} aria-valuemax={100} title={`${contextPercent}% of reported context window`}><i style={{ width: `${Math.min(100, Math.max(0, contextPercent))}%` }} /></span> : null}</span>{samples ? <span className="stdout-spark" aria-label="Output activity, not token usage" title="Received output bytes per 10 seconds; last 50 seconds">{samples.map((sample, index) => <i key={index} style={{ height: `${Math.min(16, Math.max(2, Math.log2(sample + 1)))}px` }} />)}</span> : null}</button><button className={`pin-button${metadata[session.key]?.pinned ? ' pinned' : ''}`} aria-label={`${metadata[session.key]?.pinned ? 'Unpin' : 'Pin'} ${session.title}`} aria-pressed={Boolean(metadata[session.key]?.pinned)} disabled={pinning.has(session.key)} onClick={() => onPin(session)}><Pin size={12} /></button></div>;
      }) : null}</section>)}
      {filtered.length > limit ? <button className="show-more" onClick={() => setLimit((value) => value + 150)}>Show more ({filtered.length - limit} remaining)</button> : null}
    </div>
    <nav className="roster-navigation" aria-label="Workspace navigation"><button onClick={onInbox}><Bell size={14} />Attention inbox <b>{attention.filter((item) => !item.acknowledged).length}</b></button><button onClick={onCleanup}><Trash2 size={14} />Session cleanup</button><button aria-label="Workspace settings" onClick={onSettings}><Settings size={14} />Settings</button><button onClick={onNew}><Plus size={14} />New session</button></nav><div className="list-footer">{filtered.length} indexed · callsigns 01–99 for runtime units</div>
  </aside>;
}
