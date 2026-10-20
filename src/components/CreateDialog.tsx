import { useState } from 'react';
import type { CreateInput, Session, Settings } from '../types';
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
  const [sessionType, setSessionType] = useState<'agent' | 'terminal'>('agent');
  const isTerminal = sessionType === 'terminal';
  const preset = settings.presets.find((p) => p.id === presetId);
  return <Modal title={resume ? 'Resume conversation' : 'New session'} onClose={onClose}>
    <form className="dialog-form" onSubmit={(event) => { event.preventDefault(); onSubmit(isTerminal ? { provider: 'terminal', cwd, title, hostId: target } : { provider, cwd, title, hostId: target, presetId: presetId || undefined, instructions, ...(resume ? { conversationId: resume.id } : {}), ...(resume?.agentId ? { agentId: resume.agentId } : {}) }); }}>
      <div className="dialog-heading"><div><h2>{resume ? 'Resume conversation' : 'New session'}</h2><p>{isTerminal ? 'Start a remote shell that keeps running when detached.' : 'Start a managed agent using your saved launch configuration.'}</p></div><button type="button" aria-label="Close" className="icon-button" onClick={onClose} disabled={busy}>×</button></div>
      {!resume ? <label>Session type<select value={sessionType} disabled={busy} onChange={(e) => setSessionType(e.target.value as typeof sessionType)}><option value="agent">Agent</option><option value="terminal">Terminal</option></select></label> : null}
      {!isTerminal ? <label>Launch preset<select value={presetId} disabled={busy} onChange={(e) => {
        const p = settings.presets.find((item) => item.id === e.target.value);
        setPresetId(e.target.value);
        if (p) { setProvider(p.provider); setCwd(resume?.cwd || p.cwd); setInstructions(resume ? '' : p.instructions); if (!resume && p.hostId) setTarget(p.hostId); }
      }}>{!presetsOnly ? <option value="">Provider default</option> : null}{options.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label> : null}
      <div className="form-grid">{!isTerminal ? <label>Provider<select value={provider} disabled={Boolean(resume) || Boolean(preset) || busy} onChange={(e) => setProvider(e.target.value as typeof provider)}><option value="codex">Codex</option><option value="claude">Claude</option><option value="antigravity">Antigravity CLI</option></select></label> : null}<label>SSH host<select value={target} disabled={Boolean(resume) || busy} onChange={(e) => setTarget(e.target.value)}>{settings.hosts.filter((h) => h.enabled).map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label></div>
      <label>Working directory<input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="Remote home directory" disabled={busy} /></label>
      <label>Session name<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={isTerminal ? 'Terminal session' : `${provider} session`} disabled={busy} maxLength={100} /></label>
      {!isTerminal && !resume?.agentId ? <label>Starting instructions<textarea rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} disabled={busy} /></label> : null}
      {isTerminal ? <p className="field-note">Uses your remote account’s login shell. Detach leaves it running; Stop ends the shell and its tmux session.</p> : <p className="field-note">Command: <code>{preset?.command || (provider === 'antigravity' ? 'agy' : provider)} {preset?.args}</code><br />{resume?.agentId ? 'Attaches to the existing background agent.' : preset?.fullPermissions === false ? 'Uses the command’s configured permission defaults.' : 'Starts with full permissions.'}</p>}
      {resume ? <div className="resume-id">Conversation ID <code>{resume.id}</code></div> : null}
      <div className="dialog-actions"><button type="button" className="button-secondary" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="button-primary" disabled={busy || !target || (!isTerminal && presetsOnly && !presetId)}>{busy ? 'Starting…' : resume ? 'Resume' : isTerminal ? 'Start terminal' : 'Start session'}</button></div>
    </form>
  </Modal>;
}
