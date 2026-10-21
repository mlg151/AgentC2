import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, Columns2, Pin, TerminalSquare, X } from 'lucide-react';
import { SessionList, type ProviderFilter, type StateFilter } from './components/SessionList';
import { SessionPane } from './components/SessionPane';
import { CreateDialog } from './components/CreateDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { SitRepDialog } from './components/SitRepDialog';
import { ExerciseDialog } from './components/ExerciseDialog';
import { FlashTraffic } from './components/FlashTraffic';
import { SessionCleanupDialog } from './components/SessionCleanupDialog';
import { QuickSwitcher } from './components/QuickSwitcher';
import { SituationHeader } from './components/SituationHeader';
import { KeyboardHelp } from './components/KeyboardHelp';
import { Overwatch } from './components/Overwatch';
import { commandBinding } from './commands';
import type { CommandActions } from './commands';
import { useCommandKeys } from './useCommandKeys';
import { HostMonitor } from './components/HostMonitor';
import { assignCallsigns, closeWorkspaceTab, emptyMetadata, openInPane, projectFor, situationFor, unitState, updateSituation } from './workspace';
import type { AttentionItem, CreateInput, FlashRequest, Inventory, Session, Settings, SituationWorkspace, Workspace } from './types';

const emptyWorkspace: Workspace = { tabs: [], selectedKey: null, splitKey: null, metadata: {} };
function applyPin(workspace: Workspace, key: string, pinned: boolean): Workspace {
  if (workspace.metadata[key]?.pinned === pinned) return workspace;
  return { ...workspace, metadata: { ...workspace.metadata, [key]: { ...emptyMetadata, ...workspace.metadata[key], pinned } } };
}
function withoutSessions(workspace: Workspace, keys: Set<string>): Workspace {
  const tabs = workspace.tabs.filter((key) => !keys.has(key));
  const room = situationFor(workspace);
  const anchorKey = room.anchorKey && !keys.has(room.anchorKey) ? room.anchorKey : room.targetKey && !keys.has(room.targetKey) ? room.targetKey : tabs.at(-1) || null;
  return updateSituation({ ...workspace, tabs, metadata: Object.fromEntries(Object.entries(workspace.metadata).filter(([key]) => !keys.has(key))) }, { anchorKey, targetKey: room.targetKey && !keys.has(room.targetKey) && room.targetKey !== anchorKey ? room.targetKey : null, callsigns: Object.fromEntries(Object.entries(room.callsigns).filter(([key]) => !keys.has(key))) });
}

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
  const [sitrepSource, setSitrepSource] = useState<Session | null>(null);
  const [showExercises, setShowExercises] = useState(false);
  const [flashRequests, setFlashRequests] = useState<FlashRequest[]>([]);
  const [flashSelectedId, setFlashSelectedId] = useState('');
  const [showFlash, setShowFlash] = useState(false);
  const [flashBusy, setFlashBusy] = useState(false);
  const [flashError, setFlashError] = useState('');
  const [cleanupTarget, setCleanupTarget] = useState<Session | null | undefined>(undefined);
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [showOverwatch, setShowOverwatch] = useState(false);
  const [diffOpenKey, setDiffOpenKey] = useState<string | null>(null);
  const [showKeyboardHelp, setShowKeyboardHelp] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [dialog, setDialog] = useState<Session | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pinning, setPinning] = useState<Set<string>>(() => new Set());
  const initialized = useRef(false);
  const choseInitial = useRef(false);
  const sessions = inventory?.sessions || [];
  const selected = known[workspace.selectedKey || ''];
  const situation = situationFor(workspace);
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
    const pins = new Map<string, boolean>();
    const deleted = new Set<string>();
    const offDeleted = window.agentHQ.onSessionsDeleted((keys) => {
      for (const key of keys) deleted.add(key);
      setWorkspace((current) => withoutSessions(current, new Set(keys)));
      setKnown((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !deleted.has(key))));
    });
    const offPins = window.agentHQ.onSessionPinned((key, pinned) => {
      pins.set(key, pinned);
      setWorkspace((current) => applyPin(current, key, pinned));
    });
    void window.agentHQ.getState().then(async (state) => {
      if (cancelled) return;
      for (const [key, pinned] of pins) state.workspace = applyPin(state.workspace, key, pinned);
      if (deleted.size) state.workspace = withoutSessions(state.workspace, deleted);
      setSettings(state.settings); setWorkspace(state.workspace); setAttention(state.attention);
      initialized.current = true;
      await refresh();
    }).catch((cause) => { if (!cancelled) setError(String(cause)); });
    const off = window.agentHQ.onInventory(acceptInventory);
    return () => { cancelled = true; off(); offPins(); offDeleted(); };
  }, [acceptInventory, refresh]);
  useEffect(() => {
    if (initialized.current) void window.agentHQ?.saveWorkspace(workspace).catch((cause) => setError(`Could not save workspace: ${String(cause)}`));
  }, [workspace]);
  useEffect(() => {
    let current = true;
    let running = false;
    async function poll() {
      if (!window.agentHQ || running) return;
      running = true;
      try { const next = await window.agentHQ.listFlashTraffic(); if (current) setFlashRequests(next); }
      catch { if (current) setFlashRequests((items) => items.map((item) => ({ ...item, connected: false }))); }
      finally { running = false; }
    }
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => { current = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (choseInitial.current || !sessions.length || !initialized.current) return;
    choseInitial.current = true;
    if (workspace.selectedKey) return;
    const first = sessions.find((s) => s.kind === 'managed') || sessions[0];
    setWorkspace((w) => w.selectedKey ? w : openInPane(w, first.key, 'anchor'));
  }, [sessions, workspace.selectedKey]);
  const openSession = useCallback((session: Session) => {
    setInbox(false);
    setWorkspace((w) => openInPane(w, session.key));
  }, []);
  useEffect(() => window.agentHQ?.onAttentionOpen((key) => {
    const session = known[key];
    if (session) openSession(session); else setInbox(true);
  }), [known, openSession]);

  const projects = useMemo(() => [...new Set(sessions.map((s) => projectFor(s, workspace.metadata)))].sort(), [sessions, workspace.metadata]);
  const scoped = useMemo(() => sessions.filter((s) => (hostFilter === 'all' || s.hostId === hostFilter) && (!projectFilter || projectFor(s, workspace.metadata) === projectFilter) && (!pinnedOnly || workspace.metadata[s.key]?.pinned)), [sessions, hostFilter, projectFilter, pinnedOnly, workspace.metadata]);
  function updateMetadata(key: string, patch: Partial<Workspace['metadata'][string]>) {
    setWorkspace((w) => ({ ...w, metadata: { ...w.metadata, [key]: { ...emptyMetadata, ...w.metadata[key], ...patch } } }));
  }
  async function togglePin(session: Session) {
    if (!window.agentHQ || pinning.has(session.key)) return;
    setPinning((current) => new Set(current).add(session.key));
    try { await window.agentHQ.setSessionPinned(session.key, !workspace.metadata[session.key]?.pinned); }
    catch (cause) { setError(`Could not update pin: ${String(cause)}`); }
    finally { setPinning((current) => { const next = new Set(current); next.delete(session.key); return next; }); }
  }
  useEffect(() => { if (initialized.current) setWorkspace((current) => assignCallsigns(current, sessions)); }, [sessions]);
  function changeSituation(patch: Partial<SituationWorkspace>) {
    setWorkspace((current) => Object.entries(patch).every(([key, value]) => situationFor(current)[key as keyof SituationWorkspace] === value) ? current : updateSituation(current, patch));
  }
  function closeTab(key: string) { setWorkspace((current) => closeWorkspaceTab(current, key)); }
  function cycleTarget(direction: number) {
    setWorkspace((current) => {
      const room = situationFor(current);
      const runtime = sessions.filter((session) => session.kind !== 'conversation');
      const units = (runtime.length ? runtime : sessions).filter((session) => session.key !== room.anchorKey).sort((a, b) => Number(room.callsigns[a.key] || 100) - Number(room.callsigns[b.key] || 100));
      if (!units.length) return current;
      const index = units.findIndex((unit) => unit.key === room.targetKey);
      const next = units[index < 0 ? direction > 0 ? 0 : units.length - 1 : (index + direction + units.length) % units.length];
      return updateSituation(openInPane(current, next.key, 'target'), { focusedPane: room.focusedPane });
    });
  }
  function promoteTarget() {
    setWorkspace((current) => { const room = situationFor(current); return room.targetKey ? updateSituation(current, { anchorKey: room.targetKey, targetKey: room.anchorKey, focusedPane: 'anchor' }) : current; });
  }
  function unpinAnchor() {
    setWorkspace((current) => { const room = situationFor(current); return updateSituation(current, { anchorKey: null, targetKey: room.targetKey || room.anchorKey, focusedPane: 'target' }); });
  }
  async function create(input: CreateInput) {
    if (!window.agentHQ) return;
    setBusy(true);
    try {
      const result = await window.agentHQ.create(input);
      const key = `${input.hostId}/tmux:${result.name}`;
      setDialog(undefined);
      let session: Session | undefined;
      for (let attempt = 0; attempt < 4; attempt++) {
        const next = await window.agentHQ.inventory();
        acceptInventory(next);
        session = next.sessions.find((s) => s.key === key);
        if (session) break;
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
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
  const closeCleanup = useCallback(() => setCleanupTarget(undefined), []);
  const closeSwitcher = useCallback(() => setShowSwitcher(false), []);
  const closeOverwatch = useCallback(() => setShowOverwatch(false), []);
  const closeKeyboardHelp = useCallback(() => setShowKeyboardHelp(false), []);
  function requestFocus(key: string | null) {
    if (!key) return 'This viewport has no unit';
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`.session-pane:not(.pane-hidden)[data-session-key="${CSS.escape(key)}"] .xterm-helper-textarea`)?.focus());
  }
  function focusPane(pane: 'anchor' | 'target') { const key = pane === 'anchor' ? situation.anchorKey : situation.targetKey; if (!key) return 'This viewport has no unit'; changeSituation({ focusedPane: pane }); return requestFocus(key); }
  function nextUrgent() {
    const pending = flashRequests.filter((item) => item.connected && item.state === 'pending');
    if (pending.length) {
      const index = pending.findIndex((item) => item.id === flashSelectedId);
      setFlashSelectedId(pending[(index + 1) % pending.length].id);
      setShowFlash(true);
      return 'Verified permission request selected';
    }
    const candidates = sessions.filter((session) => unitState(session, attention).priority <= 1).sort((a, b) => {
      const oldest = (session: Session) => Math.min(...attention.filter((item) => item.sessionKey === session.key && !item.acknowledged && item.confidence === 'confirmed').map((item) => Date.parse(item.createdAt)), Date.parse(session.updatedAt || '') || Date.now());
      return oldest(a) - oldest(b);
    });
    if (!candidates.length) return 'No confirmed urgent units';
    openSession(candidates[0]); return requestFocus(candidates[0].key);
  }
  function toggleDiff(key: string) {
    if (diffOpenKey === key) { setDiffOpenKey(null); requestFocus(key); }
    else setDiffOpenKey(key);
  }
  const flashPending = flashRequests.filter((item) => ['pending', 'submitted'].includes(item.state));
  const flashSelected = flashPending.find((item) => item.id === flashSelectedId) || flashPending[0];
  async function decideFlash(decision: 'allow' | 'deny') {
    if (!window.agentHQ || !flashSelected || flashSelected.state !== 'pending' || !flashSelected.connected || flashBusy) return;
    const focusKey = workspace.selectedKey;
    setFlashBusy(true); setFlashError('');
    try {
      await window.agentHQ.decideFlashTraffic({ hostId: flashSelected.hostId, name: flashSelected.name, id: flashSelected.id, decision });
      setFlashRequests(await window.agentHQ.listFlashTraffic());
      requestFocus(focusKey);
    } catch (cause) { setFlashError(String(cause)); }
    finally { setFlashBusy(false); }
  }
  function jumpFlash() {
    if (!flashSelected) return;
    const session = known[`${flashSelected.hostId}/tmux:${flashSelected.name}`];
    if (session) { openSession(session); requestFocus(session.key); }
    else setFlashError('The target unit is not in inventory. Refresh its host.');
  }
  const commands: CommandActions = {
    search: { run: () => setShowSwitcher((value) => !value) }, overwatch: { run: () => setShowOverwatch((value) => !value) },
    cycleNext: { run: () => cycleTarget(1) }, cyclePrevious: { run: () => cycleTarget(-1) },
    focusAnchor: { run: () => focusPane('anchor') }, focusTarget: { run: () => focusPane('target') },
    promote: { run: promoteTarget, available: Boolean(situation.targetKey), reason: 'Pane B is empty' },
    zen: { run: () => changeSituation({ zen: !situation.zen }) }, newUnit: { run: () => setDialog(null) },
    urgent: { run: nextUrgent }, help: { run: () => setShowKeyboardHelp(true) },
    approve: { run: () => { void decideFlash('allow'); }, available: Boolean(flashSelected?.state === 'pending' && flashSelected.connected && !flashBusy), reason: 'No connected verified permission request' },
    deny: { run: () => { void decideFlash('deny'); }, available: Boolean(flashSelected?.state === 'pending' && flashSelected.connected && !flashBusy), reason: 'No connected verified permission request' },
    jumpRequest: { run: jumpFlash, available: Boolean(flashSelected), reason: 'No verified permission request' },
    diff: { run: () => { if (selected) toggleDiff(selected.key); }, available: Boolean(selected?.worktreeOperation && selected.kind === 'managed'), reason: 'Select an owned worktree unit' },
    exercise: { run: () => setShowExercises(true) },
    handoff: { run: () => { if (selected) setSitrepSource(selected); }, available: Boolean(selected?.worktreeOperation && selected.kind === 'managed' && !selected.stale), reason: 'Select a connected owned worktree unit' },
    faultStop: { run: () => {}, available: false, reason: 'No verified runaway managed units' },
  };
  const commandKeys = useCommandKeys({ actions: commands, overrides: situation.shortcuts, overwatch: showOverwatch, onCallsign: (callsign) => {
    const session = sessions.find((item) => situation.callsigns[item.key] === callsign);
    if (!session) return `No available unit has callsign ${callsign}`;
    setInbox(false); setWorkspace((current) => openInPane(current, session.key, situationFor(current).focusedPane)); return requestFocus(session.key);
  } });

  return <div className={`app-shell situation-room${situation.rosterCollapsed || situation.zen ? ' roster-hidden' : ''}${situation.zen ? ' is-zen' : ''}${situation.ligatures ? ' font-ligatures' : ''}`}>
    <SituationHeader inventory={inventory} hosts={settings?.hosts || []} hostFilter={hostFilter} onHostFilter={setHostFilter} onSearch={() => setShowSwitcher(true)} onSettings={() => setShowSettings(true)} onNew={() => setDialog(null)} collapsed={situation.rosterCollapsed || situation.zen} onToggleRoster={() => changeSituation({ rosterCollapsed: !situation.rosterCollapsed, zen: false })} />
    <div className="workspace" inert={showOverwatch}>
      <SessionList sessions={scoped} selectedKey={workspace.selectedKey} onSelect={openSession} providerFilter={providerFilter} onProviderFilter={setProviderFilter} stateFilter={stateFilter} onStateFilter={setStateFilter} onRefresh={() => void refresh()} onNew={() => setDialog(null)} loading={loading} metadata={workspace.metadata} pinning={pinning} onPin={(session) => void togglePin(session)} situation={situation} onSituation={changeSituation} attention={attention} projects={projects} projectFilter={projectFilter} onProjectFilter={setProjectFilter} pinnedOnly={pinnedOnly} onPinnedOnly={() => setPinnedOnly((value) => !value)} onInbox={() => setInbox((value) => !value)} onCleanup={() => setCleanupTarget(null)} onSettings={() => setShowSettings(true)} />
      <main className="detail-panel">
        <div className="tab-strip" role="tablist" aria-label="Open sessions">{workspace.tabs.map((key) => <div className={`session-tab${workspace.selectedKey === key ? ' active' : ''}`} key={key}><button role="tab" aria-selected={workspace.selectedKey === key} title={known[key]?.title || key} onClick={() => { setInbox(false); setWorkspace((w) => openInPane(w, key)); }}>{known[key]?.title || key}</button><button aria-label={`Close tab ${known[key]?.title || key}`} onClick={() => closeTab(key)}><X size={12} /></button></div>)}</div>
        {inventory?.hosts.some((h) => !h.connected) ? <div className="host-errors" role="status">{inventory.hosts.filter((h) => !h.connected).map((h) => <span key={h.id} title={h.error}>{h.name}: {h.error}</span>)}<button className="text-button" onClick={() => void refresh()}>Retry</button></div> : null}
        {inbox ? <section className="attention-inbox"><div className="inbox-heading"><div><h1>Attention inbox</h1><p>Provider turn events, process results, and possible input requests across your hosts.</p></div><button className="button-secondary" disabled={!unread.length} onClick={() => void acknowledge('all')}>Acknowledge all</button></div><label className="checkbox-label"><input type="checkbox" checked={showAcknowledged} onChange={(e) => setShowAcknowledged(e.target.checked)} />Show acknowledged</label>
          <div className="attention-list">{attention.filter((a) => (showAcknowledged || !a.acknowledged) && (hostFilter === 'all' || a.hostId === hostFilter)).slice().reverse().map((a) => <article className={`attention-card ${a.kind}`} key={a.id}><div className="attention-card-heading"><strong>{a.kind === 'input' ? a.confidence === 'inferred' ? 'Possible input needed' : 'Input needed' : a.kind === 'failed' ? a.signature?.startsWith('hook:') ? 'Turn failed' : 'Process failed' : a.signature?.startsWith('hook:') ? 'Turn finished' : 'Process completed'}</strong><span className="signal-tag">{a.confidence}</span></div><h3>{a.title}</h3><p>{a.detail}</p><small>{settings?.hosts.find((h) => h.id === a.hostId)?.name || a.hostId} · {new Date(a.createdAt).toLocaleString()}</small><div className="inline-actions"><button className="button-secondary" disabled={!known[a.sessionKey]} onClick={() => { if (known[a.sessionKey]) openSession(known[a.sessionKey]); }}>Open session</button><button className="text-button" disabled={a.acknowledged} onClick={() => void acknowledge(a.id)}>{a.acknowledged ? 'Acknowledged' : 'Acknowledge'}</button></div></article>)}{!attention.some((a) => (showAcknowledged || !a.acknowledged) && (hostFilter === 'all' || a.hostId === hostFilter)) ? <div className="no-selection"><Bell size={32} /><h2>You’re caught up</h2><p>New provider events and process exits will appear here. Quiet output alone never counts as completion.</p></div> : null}</div>
        </section> : null}
        {selected && !inbox ? <div className="workspace-tools"><button className="text-button" disabled={pinning.has(selected.key)} aria-pressed={Boolean(workspace.metadata[selected.key]?.pinned)} onClick={() => void togglePin(selected)}><Pin size={13} />{workspace.metadata[selected.key]?.pinned ? 'Unpin' : 'Pin'}</button><label>Project<input aria-label="Session project" list="project-names" placeholder={selected.cwd || 'Ungrouped'} value={workspace.metadata[selected.key]?.project || ''} maxLength={100} onChange={(e) => updateMetadata(selected.key, { project: e.target.value })} /><datalist id="project-names">{projects.map((p) => <option key={p}>{p}</option>)}</datalist></label><button className="text-button" onClick={() => setShowNotes((v) => !v)}>{showNotes ? 'Hide notes' : 'Notes & handoff'}</button><label className="split-selector"><Columns2 size={14} /><select aria-label="Split terminal" value={situation.targetKey || ''} onChange={(e) => changeSituation({ targetKey: e.target.value || null })}><option value="">Single pane</option>{workspace.tabs.filter((k) => k !== situation.anchorKey).map((k) => <option key={k} value={k}>{known[k]?.title || k}</option>)}</select></label></div> : null}
        <div className={`pane-grid${situation.anchorKey && situation.targetKey ? ' is-split' : ''}${inbox ? ' pane-hidden' : ''}`}>
          {workspace.tabs.map((key) => known[key] ? <SessionPane key={key} session={known[key]} primary={key === situation.anchorKey} focused={key === workspace.selectedKey} slot={key === situation.anchorKey ? 'anchor' : 'target'} callsign={situation.callsigns[key]} diffOpen={diffOpenKey === key} onToggleDiff={() => toggleDiff(key)} visible={(key === situation.anchorKey || key === situation.targetKey) && (!situation.zen || key === workspace.selectedKey)} onFocus={() => changeSituation({ focusedPane: key === situation.anchorKey ? 'anchor' : 'target' })} onAnchor={key === situation.anchorKey ? unpinAnchor : promoteTarget} onCycle={cycleTarget} onResume={setDialog} onDeleteHistory={setCleanupTarget} onRefresh={() => void refresh()} /> : <section className={`session-pane${(key === situation.anchorKey || key === situation.targetKey) && (!situation.zen || key === workspace.selectedKey) ? '' : ' pane-hidden'}`} key={key}><div className="no-selection"><h2>Session unavailable</h2><p>Enable its host or refresh to restore this tab.</p></div></section>)}
          {!workspace.tabs.length ? <div className="no-selection"><TerminalSquare size={35} /><h1>{loading ? 'Finding sessions…' : 'Select a session'}</h1><p>Open conversations in tabs or start a new managed terminal.</p><button className="button-primary" onClick={() => setDialog(null)}>New session</button></div> : null}
        </div>
        {selected && showNotes && !inbox ? <section className="notes-panel"><label>Notes & handoff<textarea aria-label="Session notes and handoff" rows={4} maxLength={20000} placeholder="Objective, current status, next step, and relevant links…" value={workspace.metadata[selected.key]?.notes || ''} onChange={(e) => updateMetadata(selected.key, { notes: e.target.value })} /></label><div className="inline-actions"><span>Saved locally with this session.</span><button className="text-button" onClick={() => void window.agentHQ?.writeClipboard(`${selected.title}\nHost: ${selected.hostName}\nProject: ${projectFor(selected, workspace.metadata)}\nDirectory: ${selected.cwd}\n\n${workspace.metadata[selected.key]?.notes || ''}`).catch((cause) => setError(String(cause)))}>Copy handoff</button>{selected.worktreeOperation && selected.kind === 'managed' ? <button className="text-button" onClick={() => setSitrepSource(selected)}>SitRep handoff</button> : null}</div></section> : null}
      </main>
    </div>
    {settings ? <HostMonitor hosts={settings.hosts} /> : null}
    <footer className="statusbar"><span><span className={`connection-dot${inventory?.hosts.some((h) => !h.connected) || error ? ' offline' : ''}`} />{inventory ? `${inventory.hosts.filter((h) => h.connected).length}/${inventory.hosts.length} hosts connected` : 'Connecting…'}</span><span>{sessions.length.toLocaleString()} indexed · {sessions.filter((s) => s.state === 'live' && !s.stale).length} live</span><span className="command-feedback" role="status" aria-live="polite">{commandKeys.prefix !== null ? `COMMAND: ${commandKeys.prefix || "_"} · Esc cancels` : commandKeys.status}</span><span className="status-fill" /><button className="text-button" onClick={() => setShowFlash((value) => !value)}>FLASH TRAFFIC {flashPending.filter((item) => item.state === 'pending').length}</button><button className="text-button" onClick={() => setShowKeyboardHelp(true)}><kbd>{commandBinding('commandMode', situation.shortcuts) || 'F1'}</kbd> COMMANDS</button><button className="text-button" onClick={() => cycleTarget(1)}><kbd>{commandBinding('cycleNext', situation.shortcuts)}</kbd> CYCLE B</button><button className="text-button" onClick={() => setShowOverwatch(true)}><kbd>{commandBinding('overwatch', situation.shortcuts)}</kbd> OVERWATCH</button></footer>
    {error ? <div className="error-banner" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={15} /></button></div> : null}
    {settings && dialog !== undefined ? <CreateDialog resume={dialog} settings={settings} hostId={hostFilter === 'all' ? settings.hosts.find((h) => h.enabled)?.id || '' : hostFilter} onClose={closeCreate} onSubmit={(input) => void create(input)} busy={busy} /> : null}
    {settings && showSettings ? <SettingsDialog settings={settings} onSave={saveSettings} onExternalSettings={(updated) => { setSettings(updated); void refresh(); }} onClose={closeSettings} /> : null}
    {settings && sitrepSource ? <SitRepDialog source={sitrepSource} settings={settings} initialSummary={workspace.metadata[sitrepSource.key]?.notes || ''} onLaunched={async (name, hostId) => { if (!window.agentHQ) throw new Error('Desktop bridge unavailable'); for (let attempt = 0; attempt < 6; attempt++) { const next = await window.agentHQ.inventory(); acceptInventory(next); const unit = next.sessions.find((item) => item.id === name && item.hostId === hostId); if (unit) { openSession(unit); return; } await new Promise((resolve) => setTimeout(resolve, 350)); } throw new Error('Recipient launched but has not appeared in inventory; refresh to find it.'); }} onClose={() => setSitrepSource(null)} /> : null}
    {settings && showExercises ? <ExerciseDialog settings={settings} hostId={hostFilter === 'all' ? settings.hosts.find((host) => host.enabled)?.id || '' : hostFilter} onLaunched={() => void refresh()} onClose={() => setShowExercises(false)} /> : null}
    {showFlash ? <FlashTraffic requests={flashPending} selectedId={flashSelectedId} busy={flashBusy} error={flashError} onSelect={setFlashSelectedId} onDecide={(decision) => void decideFlash(decision)} onJump={jumpFlash} onClose={() => setShowFlash(false)} /> : null}
    {settings && cleanupTarget !== undefined ? <SessionCleanupDialog settings={settings} target={cleanupTarget} onSave={saveSettings} onClose={closeCleanup} /> : null}
    {showSwitcher ? <QuickSwitcher sessions={sessions.map((s) => ({ ...s, cwd: `${s.cwd} ${projectFor(s, workspace.metadata)}` }))} callsigns={situation.callsigns} actions={commands} overrides={situation.shortcuts} onSelect={(s) => { openSession(known[s.key] || s); requestFocus(s.key); }} onSettings={() => setShowSettings(true)} onInbox={() => setInbox(true)} onClose={closeSwitcher} /> : null}
    {showKeyboardHelp ? <KeyboardHelp overrides={situation.shortcuts} actions={commands} onSave={(shortcuts) => changeSituation({ shortcuts })} onClose={closeKeyboardHelp} /> : null}
    {showOverwatch ? <Overwatch sessions={sessions} situation={situation} attention={attention} onSelect={(session) => { setShowOverwatch(false); openSession(session); requestFocus(session.key); }} onClose={closeOverwatch} /> : null}
  </div>;
}
