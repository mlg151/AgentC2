import { useCallback, useEffect, useState } from 'react';
import { Modal } from './Modal';
import type { CleanupPolicy, CleanupPreview, CleanupResult, Session, Settings } from '../types';

export function SessionCleanupDialog({ settings, target, onSave, onClose }: { settings: Settings; target: Session | null; onSave: (settings: Settings) => Promise<void>; onClose: () => void }) {
  const [hostId, setHostId] = useState(target?.hostId || settings.hosts.find((host) => host.enabled)?.id || '');
  const [provider, setProvider] = useState<CleanupPolicy['provider']>(target && target.provider !== 'terminal' ? target.provider : 'codex');
  const [days, setDays] = useState(30);
  const [allowPinned, setAllowPinned] = useState(false);
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState<CleanupResult[]>([]);
  const [policies, setPolicies] = useState<CleanupPolicy[]>(() => structuredClone(settings.cleanup || []));
  const [saved, setSaved] = useState('');
  const [lastRuns, setLastRuns] = useState<Record<string, string>>({});
  const policy = policies.find((item) => item.hostId === hostId && item.provider === provider);
  const single = target?.hostId === hostId && target.provider === provider ? target : null;
  const close = useCallback(() => { if (!busy) onClose(); }, [busy, onClose]);
  useEffect(() => { void window.agentHQ?.cleanupState().then((state) => { setResults(state.results); setLastRuns(state.lastRuns); }).catch((cause) => setError(String(cause))); }, []);
  function invalidate() { setPreview(null); setSelected(new Set()); setConfirmed(false); setError(''); }
  function updatePolicy(patch: Partial<CleanupPolicy>) {
    setSaved('');
    setPolicies((current) => [...current.filter((item) => item.hostId !== hostId || item.provider !== provider), { hostId, provider, enabled: false, days: 30, ...policy, ...patch }]);
  }
  async function review(retention = false) {
    if (!window.agentHQ) return;
    invalidate(); setBusy(true);
    try {
      const next = await window.agentHQ.previewCleanup({ hostId, provider, days: retention ? policy?.days || 30 : days, ids: !retention && single ? [single.id] : undefined, allowPinned: !retention && allowPinned });
      setPreview(next); setSelected(new Set(next.items.filter((item) => item.eligible).map((item) => item.key)));
    } catch (cause) { setError(String(cause)); } finally { setBusy(false); }
  }
  async function execute() {
    if (!window.agentHQ || !preview || !confirmed) return;
    setBusy(true); setError('');
    try {
      setResults(await window.agentHQ.executeCleanup(preview.token, [...selected]));
      setPreview(null); setSelected(new Set()); setConfirmed(false);
    } catch (cause) { setError(String(cause)); setPreview(null); setConfirmed(false); }
    finally { setBusy(false); }
  }
  async function savePolicies() {
    setBusy(true); setError(''); setSaved('');
    try {
      const supported = policies.map((item) => item.provider === 'antigravity' ? { ...item, enabled: false } : item);
      await onSave({ ...settings, cleanup: supported });
      setPolicies(supported);
      setSaved('Retention saved. Enabled policies run daily while AgentC2 is running.');
    }
    catch (cause) { setError(String(cause)); } finally { setBusy(false); }
  }
  return <Modal title="Session cleanup" onClose={close} wide>
    <div className="dialog-heading"><div><h2>Session cleanup</h2><p>Review and remove saved conversations from remote storage.</p></div><button className="icon-button" aria-label="Close session cleanup" disabled={busy} onClick={onClose}>×</button></div>
    <div className="settings-body cleanup-body">
      <div className="form-grid"><label>History host<select disabled={busy} value={hostId} onChange={(event) => { setHostId(event.target.value); invalidate(); }}>{settings.hosts.filter((host) => host.enabled).map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}</select></label><label>History provider<select disabled={busy} value={provider} onChange={(event) => { setProvider(event.target.value as CleanupPolicy['provider']); invalidate(); }}><option value="codex">Codex</option><option value="claude">Claude</option><option value="antigravity">Antigravity</option></select></label></div>
      <p className="field-note">Deletion removes reviewed conversation files and provider records. It cannot be undone. Detach and Stop keep saved history; cleanup never deletes project files or worktrees. Live or ambiguous sessions are excluded.</p>
      {provider === 'antigravity' ? <p className="field-note" role="status">AgentC2 cannot safely automate Antigravity history deletion. For a manual provider-managed deletion, open <code>agy</code> in the conversation’s original project directory, choose the conversation in <code>/resume</code>, press F4 (or your configured <code>item.delete</code> key), and confirm in Antigravity. Back up uncommitted or untracked work first; the CLI may clean its own internal worktrees. A disposable ordinary Git worktree survived this action in CLI 1.4.4. Then refresh AgentC2. Automatic retention leaves Antigravity histories untouched.</p> : null}
      {single ? <p>Selected conversation: <strong>{single.title}</strong></p> : <label>Minimum age in days<input aria-label="Cleanup minimum age" type="number" min={1} max={36500} disabled={busy} value={days} onChange={(event) => { setDays(Number(event.target.value)); invalidate(); }} /></label>}
      <label className="checkbox-label"><input type="checkbox" checked={allowPinned} disabled={busy} onChange={(event) => { setAllowPinned(event.target.checked); invalidate(); }} /> Allow manual deletion of pinned histories in this preview</label>
      <button className="button-secondary" disabled={busy} onClick={() => void review()}>{busy ? 'Working…' : single ? 'Preview selected history' : 'Preview old histories'}</button>
      {preview ? <section className="cleanup-preview" aria-label="Cleanup preview"><h3>Review {preview.items.length} {preview.items.length === 1 ? 'history' : 'histories'}</h3><p className="field-note">Preview expires in five minutes. Sizes cover reviewed files; Codex sizes are estimates. Shared caches and unrelated provider data are retained.</p>{preview.truncated ? <p role="status">Showing the first 50 old histories. Preview again after this batch for remaining conversations.</p> : null}{!preview.items.length ? <p>No saved histories match this age and provider.</p> : null}{preview.items.map((item) => <article className="cleanup-item" key={item.key}><label className="checkbox-label"><input aria-label={`Delete history ${item.title}`} type="checkbox" disabled={busy || !item.eligible} checked={selected.has(item.key)} onChange={(event) => { const checked = event.target.checked; setSelected((current) => { const next = new Set(current); if (checked) next.add(item.key); else next.delete(item.key); return next; }); setConfirmed(false); }} /><strong>{item.title}</strong></label><p>{item.reason || (item.missing ? 'Already absent; remove remaining local references' : 'Eligible for deletion')} · {item.bytes === null ? 'Size unavailable' : `${item.estimated ? '~' : ''}${item.bytes.toLocaleString()} bytes`} · {item.updatedAt ? new Date(item.updatedAt).toLocaleString() : 'Activity unknown'}</p>{item.files.length ? <details><summary>{item.files.length} reviewed files / indexes</summary><ul>{item.files.map((file) => <li key={file}><code>{file}</code></li>)}</ul></details> : null}</article>)}{selected.size ? <><label className="checkbox-label"><input type="checkbox" aria-label="Confirm permanent history deletion" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} /> Permanently delete {selected.size} selected {selected.size === 1 ? 'history' : 'histories'} from {settings.hosts.find((host) => host.id === preview.hostId)?.name}. I have reviewed the files above.</label><button className="button-secondary danger-text" disabled={busy || !confirmed} onClick={() => void execute()}>Delete selected histories</button></> : null}</section> : null}
      <fieldset className="host-editor"><legend>Automatic retention — {provider}</legend><label className="checkbox-label"><input type="checkbox" aria-label="Enable automatic history cleanup" disabled={busy || provider === 'antigravity'} checked={provider !== 'antigravity' && (policy?.enabled || false)} onChange={(event) => updatePolicy({ enabled: event.target.checked })} /> Automatically delete old, unpinned histories on this host</label><label>Retention age in days<input aria-label="Retention age in days" type="number" min={1} max={36500} disabled={busy || provider === 'antigravity'} value={policy?.days || 30} onChange={(event) => updatePolicy({ days: Number(event.target.value) })} /></label>{provider === 'antigravity' ? <p className="field-note" role="status">Automatic retention is unavailable for Antigravity until a scoped unattended CLI deletion path is verified. Previously saved Antigravity policies are disabled.</p> : <p className="field-note">Runs once daily while AgentC2 is running, with one batch of up to 50 histories per host/provider and one due catch-up after restart. Pinned histories, unknown activity, unsupported layouts, and live/ambiguous providers are always excluded. Failed runs retry when next due; no remote daemon is installed.</p>}<div className="inline-actions"><button className="button-secondary" disabled={busy || provider === 'antigravity'} onClick={() => void review(true)}>Preview retention / run now</button><button className="button-secondary" disabled={busy} onClick={() => void savePolicies()}>Save retention</button></div><small>Last automatic run: {lastRuns[`${hostId}/${provider}`] ? new Date(lastRuns[`${hostId}/${provider}`]).toLocaleString() : 'Never'}</small>{saved ? <p role="status">{saved}</p> : null}</fieldset>
      {results.length ? <section aria-label="Cleanup results"><h3>Cleanup results</h3>{results.slice(0, 50).map((result, index) => <p className="cleanup-result" key={`${result.at}/${result.key}/${index}`}><strong>{result.status}</strong> · {result.provider} · {settings.hosts.find((host) => host.id === result.hostId)?.name || result.hostId}<br />{result.key ? <code>{result.key}</code> : null}<br />{result.detail}{result.bytes !== undefined ? ` (${result.estimated ? '~' : ''}${result.bytes.toLocaleString()} transcript bytes)` : ''}</p>)}</section> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </div><div className="dialog-actions"><button className="button-secondary" disabled={busy} onClick={onClose}>Close</button></div>
  </Modal>;
}
