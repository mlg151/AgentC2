import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Bell, Pin, Plus, RefreshCw, TerminalSquare } from 'lucide-react';
import { CreateDialog } from '../components/CreateDialog';
import { ProviderMark } from '../components/ProviderMark';
import { projectFor } from '../workspace';
import type { AttentionItem, CompanionState, CreateInput, HostHealth, Inventory, Session } from '../types';
import { CompanionClient } from './client';
import { PhoneTerminal } from './PhoneTerminal';
import { PhoneChat } from './PhoneChat';

function isManaged(session: Session) { return session.managed === true || session.kind === 'managed'; }

export default function Companion() {
  const [client] = useState(() => new CompanionClient());
  const [state, setState] = useState<CompanionState | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [health, setHealth] = useState<HostHealth[]>([]);
  const [connection, setConnection] = useState('connecting');
  const [generation, setGeneration] = useState(0);
  const [paired, setPaired] = useState(false);
  const [pairToken] = useState(() => {
    const value = new URLSearchParams(location.hash.slice(1)).get('pair');
    if (value) history.replaceState(null, '', location.pathname);
    return value;
  });
  const [deviceName, setDeviceName] = useState('My phone');
  const [error, setError] = useState('');
  const [createError, setCreateError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [known, setKnown] = useState<Record<string, Session>>({});
  const [inbox, setInbox] = useState(false);
  const [showAcknowledged, setShowAcknowledged] = useState(false);
  const [query, setQuery] = useState('');
  const [host, setHost] = useState('');
  const [provider, setProvider] = useState('');
  const [project, setProject] = useState('');
  const [pinned, setPinned] = useState(false);
  const [managedOnly, setManagedOnly] = useState(true);
  const [pinning, setPinning] = useState<Set<string>>(() => new Set());
  const [dialog, setDialog] = useState<Session | null | undefined>(undefined);
  const [clock, setClock] = useState(Date.now());
  const [alert, setAlert] = useState<AttentionItem | null>(null);
  const seenAttention = useRef<Set<string> | null>(null);
  const connected = connection === 'connected';
  const managedKeys = useMemo(() => new Set((inventory?.sessions || []).filter(isManaged).map((session) => session.key)), [inventory]);
  const refresh = useCallback(() => { void client.request<Inventory>('inventory').then(setInventory).catch((cause) => setError(String(cause))); }, [client]);
  useEffect(() => {
    const off = [
      client.on('connection', (value) => setConnection(value as string)),
      client.on('connected', (value) => { setState(value as CompanionState); setGeneration((number) => number + 1); setError(''); refresh(); void client.request<HostHealth[]>('health').then(setHealth).catch(() => {}); }),
      client.on('inventory:updated', (value) => setInventory(value as Inventory)),
      client.on('health:updated', (value) => setHealth(value as HostHealth[])),
      client.on('state:updated', (value) => setState(value as CompanionState)),
      client.on('revoked', () => { setPaired(false); setError('This device was revoked. Pair again from desktop.'); }),
    ];
    return () => { off.forEach((dispose) => dispose()); };
  }, [client, refresh]);
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/v1/state', { cache: 'no-store' }).then(async (response) => {
      if (cancelled) return;
      if (response.ok) { setState(await response.json()); setPaired(true); }
      else if (response.status !== 401) setError('Desktop gateway unavailable. Check Tailscale and AgentC2.');
    }).catch(() => { if (!cancelled) setError('Desktop gateway unavailable. Check Tailscale and AgentC2.'); });
    const timer = window.setInterval(() => setClock(Date.now()), 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);
  useEffect(() => { if (paired) client.connect(); }, [paired, client]);
  useEffect(() => () => client.close(), [client]);
  useEffect(() => {
    if (!inventory) return;
    setState((current) => current ? { ...current, attention: inventory.attention } : current);
    setKnown((current) => ({ ...Object.fromEntries(Object.entries(current).map(([key, session]) => [key, { ...session, stale: true, missing: true }])), ...Object.fromEntries(inventory.sessions.map((session) => [session.key, session])) }));
  }, [inventory]);
  useEffect(() => {
    if (!state) return;
    const next = new Set(state.attention.map((item) => item.id));
    if (seenAttention.current) {
      const fresh = state.attention.filter((item) => managedKeys.has(item.sessionKey) && !item.acknowledged && !seenAttention.current!.has(item.id));
      if (fresh.length) setAlert(fresh[fresh.length - 1]);
    }
    seenAttention.current = next;
  }, [state?.attention, managedKeys]);
  useEffect(() => { if (!alert) return; const timer = setTimeout(() => setAlert(null), 15000); return () => clearTimeout(timer); }, [alert]);
  async function pair(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response = await fetch('/api/v1/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: pairToken, name: deviceName }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setPaired(true);
    } catch (cause) { setError(String(cause)); } finally { setBusy(false); }
  }
  async function create(input: CreateInput) {
    if (busy || !connected) return;
    setBusy(true); setCreateError('');
    try {
      const result = await client.request<{ name: string }>('create', input);
      // The creation receipt is authoritative. A later inventory failure must
      // not leave a live launch form that can submit the same shell twice.
      setDialog(undefined); setInbox(false);
      const key = `${input.hostId}/tmux:${result.name}`;
      try {
        for (let attempt = 0; attempt < 4; attempt++) {
          const next = await client.request<Inventory>('inventory');
          setInventory(next);
          if (next.sessions.some((session) => session.key === key)) { setSelectedKey(key); setError(''); return; }
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
        setError('The session started. Refresh sessions to find it; do not launch it again.');
      } catch { setError('The session started, but inventory could not refresh. Reconnect or refresh sessions to find it; do not launch it again.'); }
    } catch (cause) { setCreateError(String(cause)); } finally { setBusy(false); }
  }
  async function togglePin(session: Session) {
    if (!connected || pinning.has(session.key)) return;
    setPinning((current) => new Set(current).add(session.key));
    try {
      await client.request('session:pin', session.key, !state?.metadata[session.key]?.pinned);
    } catch (cause) {
      setError(`Could not update pin: ${String(cause)}`);
      // An interrupted request may have succeeded. Read state; never replay a toggle.
      void client.request<CompanionState>('state').then(setState).catch(() => {});
    } finally { setPinning((current) => { const next = new Set(current); next.delete(session.key); return next; }); }
  }
  function pinButton(session: Session, compact = false) {
    const isPinned = Boolean(state?.metadata[session.key]?.pinned);
    return <button className={`phone-pin${isPinned ? ' active' : ''}`} aria-label={`${isPinned ? 'Unpin' : 'Pin'} ${session.title}`} aria-pressed={isPinned} aria-busy={pinning.has(session.key)} disabled={!connected || pinning.has(session.key)} onClick={() => void togglePin(session)}><Pin size={17} aria-hidden="true" />{compact ? null : isPinned ? 'Unpin' : 'Pin'}</button>;
  }
  const closeDialog = useCallback(() => { if (!busy) setDialog(undefined); }, [busy]);
  const sessions = inventory?.sessions || [];
  const projects = useMemo(() => [...new Set(sessions.filter((session) => !managedOnly || isManaged(session)).map((session) => projectFor(session, state?.metadata || {})))].sort(), [sessions, state?.metadata, managedOnly]);
  const filtered = sessions.filter((session) => {
    const usable = (!host || session.hostId === host)
      && (!provider || session.provider === provider)
      && (!project || projectFor(session, state?.metadata || {}) === project)
      && (!pinned || state?.metadata[session.key]?.pinned)
      && [session.title, session.cwd, session.id, session.hostName, session.provider, projectFor(session, state?.metadata || {})].join(' ').toLowerCase().includes(query.toLowerCase());
    if (!usable) return false;
    if (!managedOnly) return true;
    return isManaged(session);
  });
  const selected = selectedKey ? known[selectedKey] : null;
  const managedAttention = (state?.attention || []).filter((item) => managedKeys.has(item.sessionKey));
  const unread = managedAttention.filter((item) => !item.acknowledged);
  const attention = showAcknowledged ? managedAttention : unread;
  if (!paired) return <main className="phone-pair"><div className="phone-brand"><TerminalSquare size={27} />AgentC2</div><h1>Your agents, within reach.</h1><p>Connect this phone to AgentC2 on your computer.</p>{pairToken ? <form onSubmit={(event) => void pair(event)}><label>Device name<input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} maxLength={80} required /></label><button className="button-primary" disabled={busy} type="submit">{busy ? 'Pairing…' : 'Pair this device'}</button></form> : <div className="phone-empty">Open Settings → Remote access on desktop, choose Pair a device, and scan the QR code. Connect both devices to Tailscale first.</div>}{error ? <p className="phone-error" role="alert">{error}</p> : null}</main>;
  return <div className="phone-app">
    <header className="phone-header"><div className="phone-brand"><TerminalSquare size={23} />AgentC2</div><span className={`phone-connection ${connected ? '' : 'offline'}`} role="status">{connected ? 'Connected' : connection === 'connecting' ? 'Connecting…' : 'Desktop offline'}</span></header>
    {!connected ? <p className="phone-banner">Reconnect to Tailscale and keep AgentC2 running on an awake computer. Displayed data may be stale.</p> : null}
    {alert && !inbox ? <div className="phone-alert" role="status"><div><strong>{alert.kind === 'input' ? 'Input needed' : alert.kind === 'failed' ? 'Session failed' : 'Completed'}{alert.confidence === 'inferred' ? ' · inferred' : ''}</strong><span>{alert.title}</span></div><button onClick={() => { setInbox(true); setAlert(null); }}>Review</button><button aria-label="Dismiss alert" onClick={() => setAlert(null)}>×</button></div> : null}
    {error ? <p role="alert" className="phone-error">{error}<button aria-label="Dismiss error" onClick={() => setError('')}>×</button></p> : null}
    <nav className="phone-nav" aria-label="Companion navigation"><button className={!inbox ? 'active' : ''} onClick={() => { setInbox(false); setSelectedKey(null); }}><TerminalSquare size={17} />Sessions</button><button className={inbox ? 'active' : ''} onClick={() => setInbox(true)}><Bell size={17} />Attention <b>{unread.length}</b></button><button disabled={!connected} onClick={() => { setCreateError(''); setDialog(null); }}><Plus size={17} />New</button></nav>
    <main className="phone-main">
      {inbox ? <section><div className="phone-section-heading"><h1>Attention inbox</h1><button disabled={!connected} onClick={() => void client.request('acknowledge', 'all').catch((cause) => setError(String(cause)))}>Acknowledge all</button></div><p className="phone-muted">Review completion, failures, and input requests.</p><label className="checkbox-label"><input type="checkbox" checked={showAcknowledged} onChange={(e) => setShowAcknowledged(e.target.checked)} /> Show acknowledged</label>{attention.length ? attention.slice().reverse().map((item) => <article className="phone-attention" key={item.id}><div className="phone-section-heading"><strong>{item.title}</strong><span className={item.confidence === 'inferred' ? 'phone-inferred' : ''}>{item.confidence}</span></div><p>{item.detail}</p><small>{item.provider} · {item.kind} · {new Date(item.createdAt).toLocaleString()}</small><div className="phone-actions"><button onClick={() => { setSelectedKey(item.sessionKey); setInbox(false); }}>Open session</button><button disabled={!connected || item.acknowledged} onClick={() => void client.request('acknowledge', item.id).catch((cause) => setError(String(cause)))}>{item.acknowledged ? 'Acknowledged' : 'Acknowledge'}</button></div></article>) : <div className="phone-empty">No attention items.</div>}</section> : selected ? <><div className="phone-detail-actions"><button className="phone-back" onClick={() => setSelectedKey(null)}><ArrowLeft size={16} />All sessions</button>{pinButton(selected)}</div>{selected.transport === 'chat' ? <PhoneChat key={`${selected.key}/${generation}`} client={client} session={selected} connected={connected} onResume={() => { setCreateError(''); setDialog(selected); }} onRefresh={refresh} /> : <PhoneTerminal key={`${selected.key}/${generation}`} client={client} session={selected} connected={connected} onResume={() => { setCreateError(''); setDialog(selected); }} onRefresh={refresh} />}{state?.metadata[selected.key]?.notes ? <section className="phone-notes"><h2>Notes & handoff</h2><pre>{state.metadata[selected.key].notes}</pre></section> : null}</> : selectedKey ? <div className="phone-empty">Session unavailable. Refresh the session list.<button onClick={() => { setSelectedKey(null); refresh(); }}>Back to sessions</button></div> : <section>
        <div className="phone-section-heading"><h1>Sessions</h1><button aria-label="Refresh sessions" disabled={!connected} onClick={refresh}><RefreshCw size={17} /></button></div>
        <input className="phone-search" aria-label="Search sessions" placeholder="Search sessions, projects, hosts…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="phone-filters"><select aria-label="Filter SSH host" value={host} onChange={(e) => setHost(e.target.value)}><option value="">All hosts</option>{state?.settings.hosts.filter((item) => item.enabled).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select aria-label="Filter provider" value={provider} onChange={(e) => setProvider(e.target.value)}><option value="">All providers</option><option value="codex">Codex</option><option value="claude">Claude</option><option value="antigravity">Antigravity</option><option value="terminal">Terminals</option></select><select aria-label="Filter project" value={project} onChange={(e) => setProject(e.target.value)}><option value="">All projects</option>{projects.map((name) => <option key={name}>{name}</option>)}</select><button aria-pressed={pinned} className={pinned ? 'active' : ''} onClick={() => setPinned(!pinned)}>Pinned</button><button aria-pressed={managedOnly} className={managedOnly ? 'active' : ''} onClick={() => setManagedOnly(!managedOnly)}>Managed only</button></div>
        <div className="phone-session-list">{filtered.length ? filtered.map((session) => <div className="phone-session-entry" key={session.key}><button className="phone-session-row" onClick={() => setSelectedKey(session.key)}><ProviderMark provider={session.provider} small /><div><strong>{session.title}</strong><small>{session.hostName} · {projectFor(session, state?.metadata || {})}</small><span>{session.stale || !connected ? 'Stale' : session.state} · {session.kind}{state?.metadata[session.key]?.pinned ? ' · pinned' : ''}</span></div><span aria-hidden="true">›</span></button>{pinButton(session, true)}</div>) : <div className="phone-empty">{inventory ? 'No sessions match your filters.' : 'Loading sessions…'}</div>}</div>
      </section>}
    </main>
    <aside className="phone-health" aria-label="Host resources">{health.map((reading) => { const stale = !connected || !reading.connected || !reading.sampledAt || clock - reading.sampledAt > 20000; return <div key={reading.hostId}><strong>{reading.name}</strong><span>{stale ? 'Stale / unavailable' : `CPU ${reading.cpuPercent == null ? 'Sampling' : `${Math.round(reading.cpuPercent)}%`} · RAM ${Math.round((reading.memoryUsed || 0) / 1024 ** 3 * 10) / 10}/${Math.round((reading.memoryTotal || 0) / 1024 ** 3)} GiB`}</span>{reading.disks?.map((disk) => <small key={disk.path}>{disk.path} · {Math.round(disk.free / 1024 ** 3)} / {Math.round(disk.total / 1024 ** 3)} GiB free</small>)}</div>; })}</aside>
    <footer className="phone-footer"><span>Private connection through your desktop</span><button onClick={() => void fetch('/api/v1/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' } }).then((response) => { if (!response.ok) throw new Error('Could not disconnect device'); client.close(); location.reload(); }).catch((cause) => setError(String(cause)))}>Forget this device</button></footer>
    {dialog !== undefined && state ? <CreateDialog resume={dialog} settings={state.settings} hostId={host} onClose={closeDialog} onSubmit={(input) => void create(input)} busy={busy} error={createError} presetsOnly /> : null}
  </div>;
}
