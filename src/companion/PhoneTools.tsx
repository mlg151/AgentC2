import { PhoneHistory } from './PhoneHistory';
import { useCallback, useEffect, useState } from 'react';
import { SettingsDialog } from '../components/SettingsDialog';
import { ExerciseDialog } from '../components/ExerciseDialog';
import { FlashTraffic } from '../components/FlashTraffic';
import { SessionCleanupDialog } from '../components/SessionCleanupDialog';
import { Overwatch } from '../components/Overwatch';
import { SitRepDialog } from '../components/SitRepDialog';
import { DiffDrawer } from '../components/DiffDrawer';
import { DeleteSessionDialog } from '../components/DeleteSessionDialog';
import { situationFor } from '../workspace';
import type { CompanionState, FlashRequest, Inventory, Session, Settings } from '../types';
import type { CompanionClient } from './client';

type Panel = 'history' | 'settings' | 'exercise' | 'flash' | 'cleanup' | 'overwatch' | 'sitrep' | 'diff' | 'delete' | null;

/** Phone navigation wraps the same validated workflows as the desktop. */
export function PhoneTools({ client, state, inventory, selected, connected, onSettings, onSelect, onRefresh }: {
  client: CompanionClient; state: CompanionState; inventory: Inventory | null; selected: Session | null; connected: boolean;
  onSettings: (settings: Settings) => void; onSelect: (session: Session | null) => void; onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [sessionTools, setSessionTools] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [flash, setFlash] = useState<FlashRequest[]>([]);
  const [flashId, setFlashId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [project, setProject] = useState('');
  const [notes, setNotes] = useState('');
  const [dirty, setDirty] = useState({ project: false, notes: false });
  const metadata = state.metadata[selected?.key || ''];
  const close = useCallback(() => setPanel(null), []);
  useEffect(() => {
    setSessionTools(false); setMessage(''); setDirty({ project: false, notes: false });
    setProject(state.metadata[selected?.key || '']?.project || '');
    setNotes(state.metadata[selected?.key || '']?.notes || '');
  }, [selected?.key]);
  useEffect(() => {
    if (!dirty.project) setProject(metadata?.project || '');
    if (!dirty.notes) setNotes(metadata?.notes || '');
  }, [metadata?.project, metadata?.notes]);
  useEffect(() => {
    if (panel !== 'flash' || !connected) return;
    let active = true;
    const refresh = () => { void client.request<FlashRequest[]>('flash:list').then((items) => { if (active) setFlash(items); }).catch((cause) => { if (active) setMessage(String(cause)); }); };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [panel, connected, client]);
  async function perform(action: () => Promise<unknown>) {
    setBusy(true); setMessage('');
    try { await action(); onRefresh(); }
    catch (cause) { setMessage(String(cause)); }
    finally { setBusy(false); }
  }
  async function saveSettings(value: Settings) { onSettings(await window.agentHQ!.saveSettings(value)); }
  function open(value: Panel) { setExpanded(false); setMessage(''); setPanel(value); }
  const sessions = inventory?.sessions || [];
  return <section className="phone-tools" aria-label="Companion tools">
    <div className="phone-actions"><button aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>Tools</button>{selected ? <button aria-expanded={sessionTools} onClick={() => setSessionTools(!sessionTools)}>Session tools</button> : null}</div>
    {expanded ? <div className="phone-tool-grid"><button disabled={!connected} onClick={() => open('history')}>Search history</button><button disabled={!connected} onClick={() => open('settings')}>Settings & remote access</button><button disabled={!connected} onClick={() => open('exercise')}>Joint Exercises</button><button disabled={!connected} onClick={() => open('flash')}>Flash Traffic</button><button disabled={!connected} onClick={() => open('cleanup')}>Clean up history</button><button disabled={!connected} onClick={() => open('overwatch')}>Overwatch</button><button disabled={!connected || busy} onClick={() => { if (window.confirm('Interrupt all sessions flagged by the loop breaker?')) void perform(() => window.agentHQ!.interruptFaults()); }}>Interrupt faulty sessions</button></div> : null}
    {selected && sessionTools ? <div className="phone-session-tools">
      <label>Project<input value={project} disabled={busy} onChange={(event) => { setProject(event.target.value); setDirty((current) => ({ ...current, project: true })); }} maxLength={100} /></label>
      <label>Notes & handoff<textarea value={notes} disabled={busy} onChange={(event) => { setNotes(event.target.value); setDirty((current) => ({ ...current, notes: true })); }} rows={4} maxLength={20000} /></label>
      <div className="phone-actions"><button disabled={!connected || busy} onClick={() => void perform(async () => { await client.request('metadata:update', selected.key, { ...(dirty.project ? { project } : {}), ...(dirty.notes ? { notes } : {}) }); setDirty({ project: false, notes: false }); setMessage('Saved notes and project.'); })}>Save notes & project</button><button disabled={!connected} onClick={() => open('cleanup')}>Clean up this history</button><button disabled={!connected} onClick={() => open('delete')}>Delete session</button>{selected.worktreeOperation ? <><button disabled={!connected} onClick={() => open('sitrep')}>Send SitRep</button><button disabled={!connected} onClick={() => open('diff')}>Review diff</button></> : null}<button disabled={!connected || busy} onClick={() => void perform(() => window.agentHQ!.resetFault(selected.key))}>Reset fault baseline</button></div>
      {inventory?.faults.filter((fault) => fault.sessionKey === selected.key).map((fault) => <p key={fault.id}>{fault.label}: {fault.detail} · {fault.status}</p>)}
    </div> : null}
    {message ? <p className="phone-tool-message" role="status">{message}</p> : null}
    {panel === 'history' ? <PhoneHistory sessions={sessions} onSelect={(session) => { onSelect(session); close(); }} onClose={close} /> : null}
    {panel === 'settings' ? <SettingsDialog settings={state.settings} onSave={saveSettings} onExternalSettings={onSettings} onClose={close} /> : null}
    {panel === 'exercise' ? <ExerciseDialog settings={state.settings} hostId={selected?.hostId || ''} onLaunched={onRefresh} onClose={close} /> : null}
    {panel === 'cleanup' ? <SessionCleanupDialog settings={state.settings} target={selected} onSave={saveSettings} onClose={close} /> : null}
    {panel === 'overwatch' ? <Overwatch sessions={sessions} situation={situationFor({ tabs: [], selectedKey: null, splitKey: null, metadata: state.metadata })} attention={state.attention} onSelect={(session) => { onSelect(session); close(); }} onClose={close} /> : null}
    {panel === 'flash' ? <FlashTraffic requests={flash} selectedId={flashId} busy={busy} error={message} onSelect={setFlashId} onDecide={(decision) => { const item = flash.find((value) => value.id === flashId) || flash[0]; if (item) void perform(async () => { await window.agentHQ!.decideFlashTraffic({ hostId: item.hostId, name: item.name, id: item.id, decision }); setFlash(await window.agentHQ!.listFlashTraffic()); }); }} onJump={() => { const item = flash.find((value) => value.id === flashId) || flash[0]; const session = sessions.find((value) => value.hostId === item?.hostId && value.id === item?.name); if (session) { onSelect(session); close(); } }} onClose={close} /> : null}
    {panel === 'sitrep' && selected ? <SitRepDialog source={selected} settings={state.settings} initialSummary={notes} onLaunched={async () => { onRefresh(); close(); }} onClose={close} /> : null}
    {panel === 'diff' && selected ? <div className="phone-diff"><DiffDrawer session={selected} visible onClose={close} /></div> : null}
    {panel === 'delete' && selected ? <DeleteSessionDialog session={selected} onClose={close} onDeleted={() => { onSelect(null); close(); onRefresh(); }} /> : null}
  </section>;
}
