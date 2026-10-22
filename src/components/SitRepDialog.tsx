import { useEffect, useRef, useState } from 'react';
import type { Provider, Session, Settings, SitrepLaunchInput, SitrepPreview } from '../types';
import { Modal } from './Modal';

export function SitRepDialog({ source, settings, initialSummary, onLaunched, onClose }: { source: Session; settings: Settings; initialSummary: string; onLaunched: (name: string, hostId: string) => Promise<void>; onClose: () => void }) {
  const [targetHostId, setTargetHostId] = useState(source.hostId);
  const [repository, setRepository] = useState('');
  const [provider, setProvider] = useState<Exclude<Provider, 'terminal'>>(source.provider === 'terminal' ? 'codex' : source.provider);
  const [presetId, setPresetId] = useState('');
  const [roeProfile, setRoeProfile] = useState<SitrepLaunchInput['roeProfile'] | ''>('');
  const [title, setTitle] = useState(`Handoff: ${source.title}`.slice(0, 100));
  const [slug, setSlug] = useState('handoff');
  const [objective, setObjective] = useState(source.title);
  const [summary, setSummary] = useState(initialSummary);
  const [nextSteps, setNextSteps] = useState('Review the applied changes and continue the objective.');
  const [testCommand, setTestCommand] = useState('');
  const [operationId] = useState(() => crypto.randomUUID().replaceAll('-', ''));
  const [preview, setPreview] = useState<SitrepPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  const presets = settings.presets.filter((item) => item.provider === provider && (!item.hostId || item.hostId === targetHostId));
  useEffect(() => { if (preview && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; }, [preview]);

  async function review() {
    setBusy(true); setError(''); setPreview(null);
    try {
      if (!window.agentHQ || !source.worktreeOperation || !source.id.startsWith('hq-')) throw new Error('Select an owned managed worktree unit');
      setPreview(await window.agentHQ.previewSitrep({ sourceHostId: source.hostId, name: source.id, operationId: source.worktreeOperation, targetHostId, repository, testCommand }));
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  async function launch() {
    if (!preview?.ready) return;
    setBusy(true); setError('');
    try {
      if (!window.agentHQ) throw new Error('Open AgentC2 as a desktop app to send a SitRep');
      const result = await window.agentHQ.launchSitrep({ id: preview.id, operationId, objective, summary, nextSteps, title, slug, provider, presetId: presetId || undefined, roeProfile: roeProfile || undefined });
      await onLaunched(result.name, result.hostId);
      onClose();
    } catch (cause) { setError(String(cause)); setPreview(null); }
    finally { setBusy(false); }
  }

  return <Modal title="SitRep handoff" onClose={onClose} wide>
    <div className="dialog-heading"><div><h2>SitRep handoff</h2><p>Review one owned worktree’s changes and test evidence, then start a recipient in an isolated target worktree.</p></div><button className="icon-button" aria-label="Close SitRep" disabled={busy} onClick={onClose}>×</button></div>
    <div ref={bodyRef} className="settings-body sitrep-editor">
      <p className="field-note">Source: {source.hostName} · {source.title} · {source.branch || 'branch unknown'}. The source unit stays in place. Untracked, binary, and patches over 512 KB must be handled before transfer.</p>
      <div className="form-grid"><label>Target SSH host<select value={targetHostId} disabled={busy} onChange={(event) => { setTargetHostId(event.target.value); setPresetId(''); setPreview(null); }}>{settings.hosts.filter((host) => host.enabled).map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}</select></label><label>Recipient provider<select value={provider} disabled={busy} onChange={(event) => { setProvider(event.target.value as typeof provider); setPresetId(''); }}><option value="codex">Codex</option><option value="claude">Claude</option><option value="antigravity">Antigravity</option></select></label></div>
      <label>Primary Git checkout on target host<input value={repository} placeholder={targetHostId === source.hostId ? 'Use source checkout on this host' : '/home/user/project'} disabled={busy} onChange={(event) => { setRepository(event.target.value); setPreview(null); }} /></label>
      <div className="form-grid"><label>Launch preset<select value={presetId} disabled={busy} onChange={(event) => setPresetId(event.target.value)}><option value="">Provider default</option>{presets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Rules of Engagement<select value={roeProfile} disabled={busy} onChange={(event) => setRoeProfile(event.target.value as typeof roeProfile)}><option value="">Inherit policy</option><option value="full">Full permissions</option><option value="gated" disabled={provider === 'antigravity'}>Gated</option><option value="provider-default">Provider defaults</option></select></label></div>
      <div className="form-grid"><label>Recipient title<input value={title} maxLength={100} disabled={busy} onChange={(event) => setTitle(event.target.value)} /></label><label>Task slug<input value={slug} maxLength={40} disabled={busy} onChange={(event) => setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} /></label></div>
      <label>Objective<textarea rows={2} maxLength={2000} disabled={busy} value={objective} onChange={(event) => setObjective(event.target.value)} /></label>
      <label>What changed<textarea rows={3} maxLength={4000} disabled={busy} value={summary} onChange={(event) => setSummary(event.target.value)} /></label>
      <label>Next steps<textarea rows={2} maxLength={2000} disabled={busy} value={nextSteps} onChange={(event) => setNextSteps(event.target.value)} /></label>
      <label>Run test command in source worktree (optional)<input value={testCommand} maxLength={500} disabled={busy} placeholder="npm test" onChange={(event) => { setTestCommand(event.target.value); setPreview(null); }} /></label>
      <p className="field-note">A test result is shown only when this command actually runs. It may modify source files; if it does, review the new diff before sending. The recipient gets the result and a verified patch, not a claim of passing tests.</p>
      <button className="button-secondary" disabled={busy || (!repository && targetHostId !== source.hostId)} onClick={() => void review()}>Preview SitRep and target</button>
      {preview ? <div className="sitrep-preview"><strong>{preview.ready ? 'Ready to send' : 'Review required'}</strong><p>Source base: <code>{preview.source.baseCommit}</code> · Patch: {preview.patchBytes.toLocaleString()} bytes</p>{preview.warnings.map((message) => <p className="form-error" key={message}>{message}</p>)}{!preview.target.ready ? <p className="form-error">{preview.target.reason}</p> : null}{preview.untracked.length ? <p>Untracked: {preview.untracked.join(', ')}</p> : null}<details><summary>Reviewed patch{preview.patchPreviewTruncated ? ' (display truncated to 12 KB; full patch transfers)' : ''}</summary><pre>{preview.patchPreview || 'No tracked changes'}</pre></details><details><summary>Test evidence</summary>{preview.test ? <><p>{preview.test.command} · {preview.test.timedOut ? 'timed out' : `exit ${preview.test.exitCode}`} · {preview.test.durationMs} ms · {new Date(preview.test.ranAt).toLocaleString()}{preview.test.outputTruncated ? ' · output truncated' : ''}</p><pre>{preview.test.output}</pre></> : <p>No test command was run.</p>}</details></div> : null}
      {error ? <p role="alert" className="form-error">{error}</p> : null}
    </div>
    <div className="dialog-actions"><button className="button-secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="button-primary" disabled={busy || !preview?.ready || !objective.trim() || !summary.trim() || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)} onClick={() => void launch()}>{busy ? 'Working…' : 'Send and launch recipient'}</button></div>
  </Modal>;
}
