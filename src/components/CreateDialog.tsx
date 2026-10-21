import { useEffect, useState } from 'react';
import type { CreateInput, Session, Settings, WorktreeRecord } from '../types';
import { Modal } from './Modal';

export function CreateDialog({ resume, settings, hostId, onClose, onSubmit, busy, presetsOnly = false }: {
  resume: Session | null; settings: Settings; hostId: string; onClose: () => void; onSubmit: (input: CreateInput) => void; busy: boolean; presetsOnly?: boolean;
}) {
  const options = settings.presets.filter((p) => !resume || p.provider === resume.provider);
  const [presetId, setPresetId] = useState(options[0]?.id || '');
  const initial = options[0];
  const [target, setTarget] = useState(resume?.hostId || initial?.hostId || hostId || settings.hosts.find((h) => h.enabled)?.id || '');
  const [provider, setProvider] = useState(resume?.provider || initial?.provider || 'codex');
  const [cwd, setCwd] = useState(resume?.cwd || initial?.cwd || '');
  const [title, setTitle] = useState(resume?.title || '');
  const [instructions, setInstructions] = useState(resume ? '' : initial?.instructions || '');
  const [roeOverride, setRoeOverride] = useState<CreateInput['roeProfile'] | ''>('');
  const [sessionType, setSessionType] = useState<'agent' | 'terminal'>('agent');
  const [isolated, setIsolated] = useState(false);
  const [baseRef, setBaseRef] = useState('HEAD');
  const [slug, setSlug] = useState('task');
  const [operationId, setOperationId] = useState(() => crypto.randomUUID().replaceAll('-', ''));
  const [worktrees, setWorktrees] = useState<WorktreeRecord[]>([]);
  const [worktreeLoading, setWorktreeLoading] = useState(false);
  const [worktreeError, setWorktreeError] = useState('');
  const [worktreeBusy, setWorktreeBusy] = useState(false);
  const isTerminal = sessionType === 'terminal';
  const preset = settings.presets.find((p) => p.id === presetId);
  const effectiveRoe = roeOverride || preset?.roeProfile || settings.roe?.hostDefaults[target] || (preset?.fullPermissions === false ? 'provider-default' : 'full');
  const gatedUnavailable = !isTerminal && !resume?.agentId && effectiveRoe === 'gated' && (provider === 'antigravity' || Boolean(preset && (preset.command !== provider || /--(?:dangerously|sandbox|ask-for-approval|permission-mode|settings|allowedTools|allowed-tools|config|profile)|(?:^|\s)-c(?:\s|=)/.test(preset.args))));
  const visibleWorktrees = worktrees.filter((item) => item.state !== 'archived').slice(-8);
  useEffect(() => {
    if (!isolated || !target) return;
    let current = true;
    setWorktrees([]); setWorktreeError(''); setWorktreeLoading(true);
    void window.agentHQ?.listWorktrees(target).then((items) => { if (current) setWorktrees(items); }).catch((error) => { if (current) setWorktreeError(String(error)); }).finally(() => { if (current) setWorktreeLoading(false); });
    return () => { current = false; };
  }, [isolated, target]);
  function retry(record: WorktreeRecord) {
    if (record.state !== 'ready' && record.state !== 'provisioning') return;
    setOperationId(record.operationId);
    setCwd(record.repository || ''); setBaseRef(record.baseRef || 'HEAD');
    setSlug(record.slug || 'task'); setTitle(record.title || '');
    if (record.provider && record.provider !== 'terminal') setProvider(record.provider);
    const matching = settings.presets.find((item) => item.name === record.presetName && item.provider === record.provider && item.hostId === target);
    setPresetId(matching?.id || '');
    setInstructions('');
    setWorktreeError(record.hasInstructions ? 'Re-enter the original starting instructions before retrying this operation.' : 'Review the launch settings, then start this operation again.');
  }
  async function archive(record: WorktreeRecord) {
    setWorktreeBusy(true); setWorktreeError('');
    try {
      await window.agentHQ?.archiveWorktree(target, record.operationId);
      setWorktrees(await window.agentHQ?.listWorktrees(target) || []);
    } catch (error) { setWorktreeError(String(error)); }
    finally { setWorktreeBusy(false); }
  }
  return <Modal title={resume ? 'Resume conversation' : 'New session'} onClose={onClose}>
    <form className="dialog-form" onSubmit={(event) => { event.preventDefault(); onSubmit(isTerminal ? { provider: 'terminal', cwd, title, hostId: target } : { provider, cwd, title, hostId: target, presetId: presetId || undefined, instructions, ...(roeOverride ? { roeProfile: roeOverride } : {}), ...(resume ? { conversationId: resume.id } : {}), ...(resume?.agentId ? { agentId: resume.agentId } : {}), ...(isolated ? { worktree: { operationId, repository: cwd, baseRef, slug } } : {}) }); }}>
      <div className="dialog-heading"><div><h2>{resume ? 'Resume conversation' : 'New session'}</h2><p>{isTerminal ? 'Start a remote shell that keeps running when detached.' : 'Start a managed agent using your saved launch configuration.'}</p></div><button type="button" aria-label="Close" className="icon-button" onClick={onClose} disabled={busy}>×</button></div>
      {!resume ? <label>Session type<select value={sessionType} disabled={busy} onChange={(e) => setSessionType(e.target.value as typeof sessionType)}><option value="agent">Agent</option><option value="terminal">Terminal</option></select></label> : null}
      {!isTerminal ? <label>Launch preset<select value={presetId} disabled={busy} onChange={(e) => {
        const p = settings.presets.find((item) => item.id === e.target.value);
        setPresetId(e.target.value);
        if (p) { setProvider(p.provider); setCwd(resume?.cwd || p.cwd); setInstructions(resume ? '' : p.instructions); if (!resume && p.hostId) setTarget(p.hostId); }
      }}>{!presetsOnly ? <option value="">Provider default</option> : null}{options.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label> : null}
      <div className="form-grid">{!isTerminal ? <label>Provider<select value={provider} disabled={Boolean(resume) || Boolean(preset) || busy} onChange={(e) => setProvider(e.target.value as typeof provider)}><option value="codex">Codex</option><option value="claude">Claude</option><option value="antigravity">Antigravity CLI</option></select></label> : null}<label>SSH host<select value={target} disabled={Boolean(resume) || busy} onChange={(e) => setTarget(e.target.value)}>{settings.hosts.filter((h) => h.enabled).map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label></div>
      {!resume && !isTerminal ? <label className="checkbox-label"><input type="checkbox" checked={isolated} onChange={(event) => setIsolated(event.target.checked)} disabled={busy} />Isolate this task in a Git worktree</label> : null}
      <label>{isolated ? 'Remote Git repository' : 'Working directory'}<input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder={isolated ? 'Existing remote repository path' : 'Remote home directory'} disabled={busy} required={isolated} /></label>
      {isolated ? <>
        <div className="form-grid">
          <label>Base ref<input value={baseRef} onChange={(event) => setBaseRef(event.target.value)} maxLength={200} required disabled={busy} /></label>
          <label>Task slug<input value={slug} onChange={(event) => setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} maxLength={40} required disabled={busy} /></label>
        </div>
        <p className="field-note">Creates a separate branch and working directory from the selected ref. Git worktrees isolate files and indexes; provider permissions follow the effective launch profile. Retry keeps this task’s operation ID while this dialog stays open.</p>
        <div className="worktree-list">
          <strong>Owned worktrees on this host</strong>
          {worktreeLoading ? <small>Checking owned worktrees…</small> : visibleWorktrees.length ? visibleWorktrees.map((item) =>
            <div key={item.operationId} className="worktree-row">
              <span><code>{item.branch || item.operationId}</code><small>{item.state} · {item.status.active ? 'tmux session present' : item.status.dirty ? 'dirty' : item.status.merged ? 'clean and merged' : 'unmerged or unavailable'} · {item.path}</small></span>
              {(item.state === 'ready' || item.state === 'provisioning') ? <button type="button" disabled={busy || worktreeBusy} onClick={() => retry(item)}>Use for retry</button> : null}
              <button type="button" disabled={busy || worktreeBusy || !item.status.owned || !item.status.exists || item.status.active || item.status.dirty !== false || item.status.merged !== true} onClick={() => void archive(item)}>Archive clean worktree</button>
            </div>
          ) : <small>No owned worktrees found.</small>}
          {worktreeError ? <p role="alert">{worktreeError}</p> : null}
        </div>
      </> : null}
      <label>Session name<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={isTerminal ? 'Terminal session' : `${provider} session`} disabled={busy} maxLength={100} /></label>
      {!isTerminal && !resume?.agentId ? <label>Starting instructions<textarea rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} disabled={busy} /></label> : null}
      {!isTerminal && !resume?.agentId ? <label>Rules of Engagement for this launch<select value={roeOverride} onChange={(e) => setRoeOverride(e.target.value as typeof roeOverride)}><option value="">Inherit saved policy</option><option value="full">Full permissions</option><option value="gated" disabled={provider === 'antigravity'}>Gated: ask for protected operations</option><option value="provider-default">Provider defaults (unverified)</option></select></label> : null}
      {isTerminal ? <p className="field-note">Uses your remote account’s login shell. Detach leaves it running; Stop ends the shell and its tmux session.</p> : <p className="field-note">Command: <code>{preset?.command || (provider === 'antigravity' ? 'agy' : provider)} {preset?.args}</code><br />{resume?.agentId ? 'Attaches to the existing background agent; its permission mode is unknown.' : `Effective permissions: ${effectiveRoe}.`}{gatedUnavailable ? ' This preset cannot enforce gated mode; select the standard provider command or another profile.' : ''}</p>}
      {resume ? <div className="resume-id">Conversation ID <code>{resume.id}</code></div> : null}
      <div className="dialog-actions"><button type="button" className="button-secondary" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="button-primary" disabled={busy || gatedUnavailable || !target || (isolated && (!cwd || !baseRef || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug))) || (!isTerminal && presetsOnly && !presetId)}>{busy ? 'Starting…' : resume ? 'Resume' : isTerminal ? 'Start terminal' : 'Start session'}</button></div>
    </form>
  </Modal>;
}
