import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { ExerciseInput, ExerciseInspection, ExercisePromotionPreview, ExerciseRecord, Provider, RoeProfile, Settings, WorktreeRecord } from '../types';
import { Modal } from './Modal';

type Choice = ExerciseInput['contestants'][number];
const providers: Exclude<Provider, 'terminal'>[] = ['codex', 'claude', 'antigravity', 'opencode'];

export function ExerciseDialog({ settings, hostId, onClose, onLaunched }: { settings: Settings; hostId: string; onClose: () => void; onLaunched: () => void }) {
  const [records, setRecords] = useState<ExerciseRecord[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [title, setTitle] = useState('Joint exercise');
  const [target, setTarget] = useState(hostId);
  const [repository, setRepository] = useState('');
  const [baseRef, setBaseRef] = useState('HEAD');
  const [prompt, setPrompt] = useState('');
  const [testCommand, setTestCommand] = useState('');
  const [choices, setChoices] = useState<Choice[]>([{ provider: 'codex' }, { provider: 'claude' }]);
  const [choicesEdited, setChoicesEdited] = useState(false);
  const [capabilities, setCapabilities] = useState<Record<Exclude<Provider, 'terminal'>, boolean> | null>(null);
  const [inspections, setInspections] = useState<Record<string, ExerciseInspection>>({});
  const [preview, setPreview] = useState<ExercisePromotionPreview | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreeRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const record = records.find((item) => item.id === selectedId);
  async function reload() { const next = await window.agentHQ!.listExercises(); setRecords(next); return next; }
  useEffect(() => { void reload().catch((cause) => setError(String(cause))); }, []);
  useEffect(() => {
    let current = true;
    setCapabilities(null);
    if (target) void window.agentHQ?.exerciseCapabilities(target).then((result) => {
      if (!current) return;
      setCapabilities(result);
      const installed = providers.filter((provider) => result[provider]);
      if (!choicesEdited && installed.length >= 2) setChoices(installed.slice(0, 3).map((provider) => ({ provider })));
    }).catch((cause) => { if (current) setError(`Could not check provider availability: ${String(cause)}`); });
    return () => { current = false; };
  }, [target, choicesEdited]);
  useEffect(() => {
    if (!record?.promotion) return;
    void window.agentHQ?.listWorktrees(record.hostId).then(setWorktrees).catch((cause) => setError(String(cause)));
  }, [record?.id, record?.promotion?.at]);
  async function perform(action: () => Promise<unknown>, refresh = true) {
    setBusy(true); setError('');
    try { await action(); if (refresh) await reload(); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  function changeChoice(index: number, patch: Partial<Choice>) {
    setChoicesEdited(true);
    setChoices((current) => current.map((choice, i) => i === index ? { ...choice, ...patch } : choice));
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    await perform(async () => {
      const result = await window.agentHQ!.createExercise({ title, hostId: target, repository, baseRef, prompt, testCommand, contestants: choices });
      setSelectedId(result.id); onLaunched();
    });
  }
  async function inspect(id: string, verify: boolean) {
    if (!record) return;
    await perform(async () => {
      const result = await window.agentHQ!.inspectExercise(record.id, id, verify);
      setInspections((current) => ({ ...current, [id]: result }));
      setPreview(null);
    });
  }
  async function archiveLoser(item: ExerciseRecord['contestants'][number]) {
    if (!record) return;
    await perform(async () => {
      await window.agentHQ!.archiveWorktree(record.hostId, item.id);
      setWorktrees(await window.agentHQ!.listWorktrees(record.hostId));
    }, false);
  }
  return <Modal title="Joint Exercises" onClose={onClose} wide>
    <div className="dialog-form exercise-dialog">
      <div className="dialog-heading"><div><h2>Joint Exercises</h2><p>Give the same task to isolated agents, verify their work, then choose a result to promote.</p></div><button className="icon-button" onClick={onClose} aria-label="Close">×</button></div>
      <label>Exercise<select value={selectedId} onChange={(event) => { setSelectedId(event.target.value); setInspections({}); setPreview(null); }}><option value="">New exercise</option>{records.map((item) => <option value={item.id} key={item.id}>{item.title} · {item.state} · {new Date(item.createdAt).toLocaleString()}</option>)}</select></label>
      {!record ? <form className="dialog-form" onSubmit={(event) => void create(event)}>
        <div className="form-grid"><label>Title<input value={title} maxLength={100} onChange={(event) => setTitle(event.target.value)} required /></label><label>Host<select value={target} onChange={(event) => setTarget(event.target.value)}>{settings.hosts.filter((host) => host.enabled).map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}</select></label></div>
        <label>Primary Git checkout<input value={repository} onChange={(event) => setRepository(event.target.value)} required placeholder="/home/user/project" /></label>
        <label>Base ref<input value={baseRef} onChange={(event) => setBaseRef(event.target.value)} required maxLength={200} /></label>
        <label>Identical task for every contestant<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} maxLength={12000} required /></label>
        <label>Verification command (optional)<input value={testCommand} onChange={(event) => setTestCommand(event.target.value)} maxLength={500} placeholder="npm test" /></label>
        <strong>Contestants</strong>
        {choices.map((choice, index) => <div className="exercise-choice form-grid" key={index}>
          <label>Provider<select value={choice.provider} onChange={(event) => changeChoice(index, { provider: event.target.value as Choice['provider'], presetId: undefined })}>{providers.map((provider) => <option key={provider} value={provider}>{provider}</option>)}</select></label>
          <label>Launch preset<select value={choice.presetId || ''} onChange={(event) => changeChoice(index, { presetId: event.target.value || undefined })}><option value="">Provider default</option>{settings.presets.filter((preset) => preset.provider === choice.provider && (!preset.hostId || preset.hostId === target)).map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label>
          <label>Rules of Engagement<select value={choice.roeProfile || ''} onChange={(event) => changeChoice(index, { roeProfile: (event.target.value || undefined) as RoeProfile | undefined })}><option value="">Inherit policy</option><option value="full">Full permissions</option><option value="gated" disabled={choice.provider === 'antigravity'}>Gated</option><option value="provider-default">Provider default</option></select></label>
          {capabilities && !capabilities[choice.provider] && !(choice.presetId && settings.presets.some((preset) => preset.id === choice.presetId && preset.command !== (choice.provider === 'antigravity' ? 'agy' : choice.provider))) ? <small role="status">{choice.provider} CLI was not found on this host. Install it or select a valid custom preset.</small> : null}
        </div>)}
        <div className="inline-actions"><button type="button" disabled={choices.length >= 3} onClick={() => { setChoicesEdited(true); setChoices((current) => [...current, { provider: 'antigravity' }]); }}>Add contestant</button><button type="button" disabled={choices.length <= 2} onClick={() => { setChoicesEdited(true); setChoices((current) => current.slice(0, -1)); }}>Remove last</button></div>
        <p className="field-note">The host must have each selected CLI installed. Launch failures stay on the exercise record for review and retry. Contestants receive separate branches and indexes at one resolved commit.</p>
        <div className="dialog-actions"><button type="button" className="button-secondary" onClick={onClose}>Close</button><button type="submit" className="button-primary" disabled={busy || !target || !repository || !prompt.trim()}>{busy ? 'Launching…' : 'Launch exercise'}</button></div>
      </form> : <>
        <p className="field-note"><strong>{record.title}</strong> · {record.state} · {record.hostId}<br /><code>{record.repository}</code><br />Shared base <code>{record.baseCommit}</code></p>
        <details><summary>Shared task and verification command</summary><pre>{record.prompt}</pre><code>{record.testCommand || 'No command selected'}</code></details>
        <div className="inline-actions"><button disabled={busy || !['partial', 'launching'].includes(record.state)} onClick={() => void perform(async () => { await window.agentHQ!.retryExercise(record.id); onLaunched(); })}>Retry failed launches</button><button disabled={busy || !['running', 'partial', 'launching'].includes(record.state)} onClick={() => void perform(() => window.agentHQ!.cancelExercise(record.id))}>Cancel remaining dispatch</button></div>
        <div className="exercise-results">{record.contestants.map((item) => {
          const result = inspections[item.id];
          const owned = worktrees.find((tree) => tree.operationId === item.id);
          return <section className="exercise-result" key={item.id}>
            <h3>{item.provider} <small>{item.state}</small></h3>
            <p><code>{item.name || item.id}</code>{item.error ? <span role="alert"> · {item.error}</span> : null}</p>
            {item.state === 'launched' ? <>
              <div className="inline-actions"><button disabled={busy} onClick={() => void inspect(item.id, false)}>Inspect diff</button><button disabled={busy || item.markedComplete} onClick={() => void perform(() => window.agentHQ!.markExerciseComplete(record.id, item.id))}>{item.markedComplete ? 'Marked complete' : 'Mark complete'}</button><button disabled={busy} onClick={() => void inspect(item.id, true)}>Run verification</button></div>
              {result ? <><p><code>{result.branch}</code> · {result.patchBytes} patch bytes · {result.active ? 'session active' : 'session stopped'}</p>{result.warnings.map((warning) => <p key={warning} role="alert">{warning}</p>)}{result.untracked.length ? <p>Untracked: {result.untracked.join(', ')}</p> : null}<pre className="exercise-diff">{result.patch || 'No tracked diff'}</pre>{result.patchTruncated ? <small>Diff display truncated. Review full changes in Git.</small> : null}</> : null}
              <p>Verification: {result?.evidence ? result.evidence.test ? `${result.evidence.test.command} · ${result.evidence.test.timedOut ? 'timed out' : `exit ${result.evidence.test.exitCode}`} · ${result.evidence.test.durationMs} ms` : 'Explicit completion; no command selected' : item.evidence ? 'Evidence needs a fresh inspection' : 'Not run'}</p>
              {result?.evidence?.test ? <pre>{result.evidence.test.output}</pre> : null}
              <p>Cost: unavailable · Elapsed run time: unavailable</p>
              <button disabled={busy || !result?.evidence || Boolean(result.warnings.length) || Boolean(record.promotion)} onClick={() => void perform(async () => { setPreview(await window.agentHQ!.previewExercisePromotion(record.id, item.id)); }, false)}>Preview promotion</button>
              {record.promotion && record.promotion.contestantId !== item.id ? <p>Cleanup: {owned ? owned.state === 'archived' ? 'archived' : owned.status.active ? 'session active; stop it separately' : owned.status.dirty ? 'dirty worktree preserved' : owned.status.merged ? 'eligible for archive' : 'unmerged worktree preserved' : 'refreshing ownership'}</p> : null}
              {record.promotion && record.promotion.contestantId !== item.id && owned?.status.owned && !owned.status.active && owned.status.dirty === false && owned.status.merged === true ? <button disabled={busy} onClick={() => void archiveLoser(item)}>Archive clean loser</button> : null}
            </> : null}
          </section>;
        })}</div>
        {preview ? <section className="exercise-promotion"><h3>Promotion preview</h3><p><code>{preview.branch}</code> at <code>{preview.headCommit}</code> · {preview.paths} files · {preview.patchBytes} bytes</p><p>Applies the reviewed tracked patch to the clean primary checkout. The changes remain staged for your commit.</p><button className="button-primary" disabled={busy || Boolean(record.promotion)} onClick={() => void perform(async () => { await window.agentHQ!.promoteExercise(record.id, preview.contestantId, preview.revision); setPreview(null); })}>Promote selected result</button></section> : null}
        {record.promotion ? <p role="status">Promoted {record.contestants.find((item) => item.id === record.promotion?.contestantId)?.provider} into <code>{record.promotion.branch}</code>; changes are staged.</p> : null}
        <div className="dialog-actions"><button className="button-secondary" onClick={onClose}>Close</button></div>
      </>}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  </Modal>;
}
