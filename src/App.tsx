import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Bell, Columns2, Pin, Plus, Search, Settings as SettingsIcon, TerminalSquare, X } from 'lucide-react';
import { SessionList, type ProviderFilter, type StateFilter } from './components/SessionList';
import { SessionPane } from './components/SessionPane';
import { CreateDialog } from './components/CreateDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { QuickSwitcher } from './components/QuickSwitcher';
import { ProviderMark } from './components/ProviderMark';
import { HostMonitor } from './components/HostMonitor';
import { primaryModifier } from './platform';
import { emptyMetadata, projectFor } from './workspace';
import type { AttentionItem, CreateInput, Inventory, Session, Settings, Workspace } from './types';

const emptyWorkspace: Workspace = { tabs: [], selectedKey: null, splitKey: null, metadata: {} };

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [attention, setAttention] = useState<AttentionItem[]>([]);
  const [known, setKnown] = useState<Record<string, Session>>({});
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>('all');
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [hostFilter, setHostFilter] = useState('all');
  const [projectFilter, setProjectFilter] = useState('');
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [inbox, setInbox] = useState(false);
  const [showAcknowledged, setShowAcknowledged] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [dialog, setDialog] = useState<Session | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const initialized = useRef(false);
  const choseInitial = useRef(false);
  const sessions = inventory?.sessions || [];
  const selected = known[workspace.selectedKey || ''];
  const unread = attention.filter((a) => !a.acknowledged);

  const acceptInventory = useCallback((next: Inventory) => {
    setInventory(next); setAttention(next.attention);
    setKnown((current) => {
      const keys = new Set(next.sessions.map((s) => s.key));
      const stale = Object.fromEntries(Object.entries(current).map(([key, s]) => [key, keys.has(key) ? s : { ...s, stale: true, missing: true }]));
      return { ...stale, ...Object.fromEntries(next.sessions.map((s) => [s.key, s])) };
    });
  }, []);
  const refresh = useCallback(async () => {
    if (!window.agentHQ) { setError('Open AgentC2 as a desktop app to connect over SSH.'); return; }
    setLoading(true);
    try { acceptInventory(await window.agentHQ.inventory()); setError(''); }
    catch (cause) { setError(String(cause)); } finally { setLoading(false); }
  }, [acceptInventory]);
  useEffect(() => {
    let cancelled = false;
    if (!window.agentHQ) { setError('Open AgentC2 as a desktop app to connect over SSH.'); return; }
    void window.agentHQ.getState().then(async (state) => {
      if (cancelled) return;
      setSettings(state.settings); setWorkspace(state.workspace); setAttention(state.attention);
      initialized.current = true;
      await refresh();
    }).catch((cause) => { if (!cancelled) setError(String(cause)); });
    const off = window.agentHQ.onInventory(acceptInventory);
    return () => { cancelled = true; off(); };
  }, [acceptInventory, refresh]);
  useEffect(() => {
    if (initialized.current) void window.agentHQ?.saveWorkspace(workspace).catch((cause) => setError(`Could not save workspace: ${String(cause)}`));
  }, [workspace]);
  useEffect(() => {
    if (choseInitial.current || !sessions.length || !initialized.current) return;
    choseInitial.current = true;
    if (workspace.selectedKey) return;
    const first = sessions.find((s) => s.kind === 'managed') || sessions[0];
    setWorkspace((w) => w.selectedKey ? w : { ...w, selectedKey: first.key, tabs: [first.key] });
  }, [sessions, workspace.selectedKey]);
  const openSession = useCallback((session: Session) => {
    setInbox(false);
    setWorkspace((w) => {
      const tabs = w.tabs.includes(session.key) ? w.tabs : [...w.tabs, session.key].slice(-40);
      return { ...w, selectedKey: session.key, tabs, splitKey: w.splitKey && w.splitKey !== session.key && tabs.includes(w.splitKey) ? w.splitKey : null };
    });
  }, []);
  useEffect(() => window.agentHQ?.onAttentionOpen((key) => {
    const session = known[key];
    if (session) openSession(session); else setInbox(true);
  }), [known, openSession]);
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setShowSwitcher((value) => !value); }
    }
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);

  const projects = useMemo(() => [...new Set(sessions.map((s) => projectFor(s, workspace.metadata)))].sort(), [sessions, workspace.metadata]);
  const scoped = useMemo(() => sessions.filter((s) => (hostFilter === 'all' || s.hostId === hostFilter) && (!projectFilter || projectFor(s, workspace.metadata) === projectFilter) && (!pinnedOnly || workspace.metadata[s.key]?.pinned)), [sessions, hostFilter, projectFilter, pinnedOnly, workspace.metadata]);
  function updateMetadata(key: string, patch: Partial<Workspace['metadata'][string]>) {
    setWorkspace((w) => ({ ...w, metadata: { ...w.metadata, [key]: { ...emptyMetadata, ...w.metadata[key], ...patch } } }));
  }
  function closeTab(key: string) {
    setWorkspace((w) => {
      const tabs = w.tabs.filter((k) => k !== key);
      const selectedKey = w.selectedKey === key ? tabs.at(-1) || null : w.selectedKey;
      return { ...w, tabs, selectedKey, splitKey: w.splitKey === key || w.splitKey === selectedKey ? null : w.splitKey };
    });
  }
  async function create(input: CreateInput) {
    if (!window.agentHQ) return;
    setBusy(true);
    try {
      const result = await window.agentHQ.create(input);
      const key = `${input.hostId}/tmux:${result.name}`;
      setDialog(undefined);
      const next = await window.agentHQ.inventory();
      acceptInventory(next);
      const session = next.sessions.find((s) => s.key === key);
      if (session) openSession(session);
      else setError('The session started but has not appeared in inventory. Refresh to find it.');
    } catch (cause) { setError(String(cause)); } finally { setBusy(false); }
  }
  async function saveSettings(next: Settings) {
    if (!window.agentHQ) return;
    setSettings(await window.agentHQ.saveSettings(next));
    setHostFilter('all');
    void refresh();
  }
  async function acknowledge(id: string) {
    try { const next = await window.agentHQ?.acknowledge(id); if (next) setAttention(next); }
    catch (cause) { setError(String(cause)); }
  }
  const closeCreate = useCallback(() => { if (!busy) setDialog(undefined); }, [busy]);
  const closeSettings = useCallback(() => setShowSettings(false), []);
  const closeSwitcher = useCallback(() => setShowSwitcher(false), []);

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><TerminalSquare size={24} /><span>AgentC2</span></div><div className="topbar-actions"><button className="quick-trigger" onClick={() => setShowSwitcher(true)}><Search size={14} />Quick switch <kbd>{primaryModifier} K</kbd></button><label className="host-picker">Host<select aria-label="Filter SSH host" value={hostFilter} onChange={(e) => setHostFilter(e.target.value)}><option value="all">All hosts</option>{settings?.hosts.filter((h) => h.enabled).map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label><button className="icon-button" aria-label="Settings" title="Settings" onClick={() => setShowSettings(true)}><SettingsIcon size={19} /></button></div></header>
    <div className="workspace">
      <nav className="sidebar" aria-label="Workspace navigation">
        <button className={`sidebar-item${inbox ? ' active' : ''}`} onClick={() => setInbox(true)}><Bell size={18} /><span>Attention inbox</span><b>{unread.length}</b></button>
        <button className={`sidebar-item${pinnedOnly && !inbox ? ' active' : ''}`} onClick={() => { setPinnedOnly((v) => !v); setInbox(false); }}><Pin size={17} /><span>Pinned sessions</span><b>{sessions.filter((s) => workspace.metadata[s.key]?.pinned).length}</b></button>
        <div className="sidebar-title section-title">PROVIDERS</div>
        {(['all', 'codex', 'claude', 'antigravity', 'terminal'] as const).map((p) => <button key={p} className={`sidebar-item${providerFilter === p && !inbox ? ' active' : ''}`} onClick={() => { setProviderFilter(p); setInbox(false); }}>{p === 'all' ? <Activity size={18} /> : <ProviderMark provider={p} small />}<span>{p === 'all' ? 'All sessions' : p === 'terminal' ? 'Terminals' : p === 'antigravity' ? 'Antigravity' : p === 'claude' ? 'Claude' : 'Codex'}</span><b>{sessions.filter((s) => p === 'all' || s.provider === p).length}</b></button>)}
        <div className="sidebar-title section-title">PROJECTS</div>
        <div className="project-list"><button className={`project-item${!projectFilter ? ' active' : ''}`} onClick={() => { setProjectFilter(''); setInbox(false); }}>All projects</button>{projects.map((p) => <button key={p} title={p} className={`project-item${projectFilter === p ? ' active' : ''}`} onClick={() => { setProjectFilter(p); setInbox(false); }}>{p.split('/').filter(Boolean).at(-1) || p}</button>)}</div>
        <div className="sidebar-spacer" /><button className="sidebar-item" onClick={() => setDialog(null)}><Plus size={18} /><span>New session</span></button>
      </nav>
      <SessionList sessions={scoped} selectedKey={workspace.selectedKey} onSelect={openSession} providerFilter={providerFilter} stateFilter={stateFilter} onStateFilter={setStateFilter} onRefresh={() => void refresh()} onNew={() => setDialog(null)} loading={loading} metadata={workspace.metadata} onPin={(s) => updateMetadata(s.key, { pinned: !workspace.metadata[s.key]?.pinned })} />
      <main className="detail-panel">
        <div className="tab-strip" role="tablist" aria-label="Open sessions">{workspace.tabs.map((key) => <div className={`session-tab${workspace.selectedKey === key ? ' active' : ''}`} key={key}><button role="tab" aria-selected={workspace.selectedKey === key} title={known[key]?.title || key} onClick={() => { setInbox(false); setWorkspace((w) => ({ ...w, selectedKey: key, splitKey: w.splitKey === key ? null : w.splitKey })); }}>{known[key]?.title || key}</button><button aria-label={`Close tab ${known[key]?.title || key}`} onClick={() => closeTab(key)}><X size={12} /></button></div>)}</div>
        {inventory?.hosts.some((h) => !h.connected) ? <div className="host-errors" role="status">{inventory.hosts.filter((h) => !h.connected).map((h) => <span key={h.id} title={h.error}>{h.name}: {h.error}</span>)}<button className="text-button" onClick={() => void refresh()}>Retry</button></div> : null}
        {inbox ? <section className="attention-inbox"><div className="inbox-heading"><div><h1>Attention inbox</h1><p>Provider turn events, process results, and possible input requests across your hosts.</p></div><button className="button-secondary" disabled={!unread.length} onClick={() => void acknowledge('all')}>Acknowledge all</button></div><label className="checkbox-label"><input type="checkbox" checked={showAcknowledged} onChange={(e) => setShowAcknowledged(e.target.checked)} />Show acknowledged</label>
          <div className="attention-list">{attention.filter((a) => (showAcknowledged || !a.acknowledged) && (hostFilter === 'all' || a.hostId === hostFilter)).slice().reverse().map((a) => <article className={`attention-card ${a.kind}`} key={a.id}><div className="attention-card-heading"><strong>{a.kind === 'input' ? a.confidence === 'inferred' ? 'Possible input needed' : 'Input needed' : a.kind === 'failed' ? a.signature?.startsWith('hook:') ? 'Turn failed' : 'Process failed' : a.signature?.startsWith('hook:') ? 'Turn finished' : 'Process completed'}</strong><span className="signal-tag">{a.confidence}</span></div><h3>{a.title}</h3><p>{a.detail}</p><small>{settings?.hosts.find((h) => h.id === a.hostId)?.name || a.hostId} · {new Date(a.createdAt).toLocaleString()}</small><div className="inline-actions"><button className="button-secondary" disabled={!known[a.sessionKey]} onClick={() => { if (known[a.sessionKey]) openSession(known[a.sessionKey]); }}>Open session</button><button className="text-button" disabled={a.acknowledged} onClick={() => void acknowledge(a.id)}>{a.acknowledged ? 'Acknowledged' : 'Acknowledge'}</button></div></article>)}{!attention.some((a) => (showAcknowledged || !a.acknowledged) && (hostFilter === 'all' || a.hostId === hostFilter)) ? <div className="no-selection"><Bell size={32} /><h2>You’re caught up</h2><p>New provider events and process exits will appear here. Quiet output alone never counts as completion.</p></div> : null}</div>
        </section> : null}
        {selected && !inbox ? <div className="workspace-tools"><button className="text-button" onClick={() => updateMetadata(selected.key, { pinned: !workspace.metadata[selected.key]?.pinned })}><Pin size={13} />{workspace.metadata[selected.key]?.pinned ? 'Unpin' : 'Pin'}</button><label>Project<input aria-label="Session project" list="project-names" placeholder={selected.cwd || 'Ungrouped'} value={workspace.metadata[selected.key]?.project || ''} maxLength={100} onChange={(e) => updateMetadata(selected.key, { project: e.target.value })} /><datalist id="project-names">{projects.map((p) => <option key={p}>{p}</option>)}</datalist></label><button className="text-button" onClick={() => setShowNotes((v) => !v)}>{showNotes ? 'Hide notes' : 'Notes & handoff'}</button><label className="split-selector"><Columns2 size={14} /><select aria-label="Split terminal" value={workspace.splitKey || ''} onChange={(e) => setWorkspace((w) => ({ ...w, splitKey: e.target.value || null }))}><option value="">Single pane</option>{workspace.tabs.filter((k) => k !== workspace.selectedKey).map((k) => <option key={k} value={k}>{known[k]?.title || k}</option>)}</select></label></div> : null}
        <div className={`pane-grid${workspace.splitKey ? ' is-split' : ''}${inbox ? ' pane-hidden' : ''}`}>
          {workspace.tabs.map((key) => known[key] ? <SessionPane key={key} session={known[key]} primary={key === workspace.selectedKey} visible={key === workspace.selectedKey || key === workspace.splitKey} onResume={setDialog} onRefresh={() => void refresh()} /> : <section className={`session-pane${key === workspace.selectedKey || key === workspace.splitKey ? '' : ' pane-hidden'}`} key={key}><div className="no-selection"><h2>Session unavailable</h2><p>Enable its host or refresh to restore this tab.</p></div></section>)}
          {!workspace.tabs.length ? <div className="no-selection"><TerminalSquare size={35} /><h1>{loading ? 'Finding sessions…' : 'Select a session'}</h1><p>Open conversations in tabs or start a new managed terminal.</p><button className="button-primary" onClick={() => setDialog(null)}>New session</button></div> : null}
        </div>
        {selected && showNotes && !inbox ? <section className="notes-panel"><label>Notes & handoff<textarea aria-label="Session notes and handoff" rows={4} maxLength={20000} placeholder="Objective, current status, next step, and relevant links…" value={workspace.metadata[selected.key]?.notes || ''} onChange={(e) => updateMetadata(selected.key, { notes: e.target.value })} /></label><div className="inline-actions"><span>Saved locally with this session.</span><button className="text-button" onClick={() => void window.agentHQ?.writeClipboard(`${selected.title}\nHost: ${selected.hostName}\nProject: ${projectFor(selected, workspace.metadata)}\nDirectory: ${selected.cwd}\n\n${workspace.metadata[selected.key]?.notes || ''}`).catch((cause) => setError(String(cause)))}>Copy handoff</button></div></section> : null}
      </main>
    </div>
    {settings ? <HostMonitor hosts={settings.hosts} /> : null}
    <footer className="statusbar"><span><span className={`connection-dot${inventory?.hosts.some((h) => !h.connected) || error ? ' offline' : ''}`} />{inventory ? `${inventory.hosts.filter((h) => h.connected).length}/${inventory.hosts.length} hosts connected` : 'Connecting…'}</span><span>{sessions.length.toLocaleString()} indexed · {sessions.filter((s) => s.state === 'live' && !s.stale).length} live</span><span className="status-fill" /><span>Remote sessions survive disconnects</span></footer>
    {error ? <div className="error-banner" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={15} /></button></div> : null}
    {settings && dialog !== undefined ? <CreateDialog resume={dialog} settings={settings} hostId={hostFilter === 'all' ? settings.hosts.find((h) => h.enabled)?.id || '' : hostFilter} onClose={closeCreate} onSubmit={(input) => void create(input)} busy={busy} /> : null}
    {settings && showSettings ? <SettingsDialog settings={settings} onSave={saveSettings} onClose={closeSettings} /> : null}
    {showSwitcher ? <QuickSwitcher sessions={sessions.map((s) => ({ ...s, cwd: `${s.cwd} ${projectFor(s, workspace.metadata)}` }))} onSelect={(s) => openSession(known[s.key] || s)} onNew={() => setDialog(null)} onSettings={() => setShowSettings(true)} onInbox={() => setInbox(true)} onClose={closeSwitcher} /> : null}
  </div>;
}
