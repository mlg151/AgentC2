import { useEffect, useState } from 'react';
import type { Settings, SpecopsDefinition, SpecopsRun, GithubResult } from '../types';
import { Modal } from './Modal';

export function SpecopsDialog({ settings, onClose }: { settings: Settings; onClose: () => void }) {
  const [definition, setDefinition] = useState<SpecopsDefinition | null>(null);
  const [runs, setRuns] = useState<SpecopsRun[]>([]);
  const [tab, setTab] = useState('missions');
  const [yaml, setYaml] = useState('');
  const [hostId, setHostId] = useState(settings.hosts.find((h) => h.enabled)?.id || '');
  const [repo, setRepo] = useState('');
  const [repository, setRepository] = useState('');
  const [issue, setIssue] = useState('');
  const [query, setQuery] = useState('is:open is:issue');
  const [workflowId, setWorkflowId] = useState('issue-to-pr');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<GithubResult | null>(null);
  const [number, setNumber] = useState('');
  const [commit, setCommit] = useState('');
  const [summary, setSummary] = useState('');
  const [inspected, setInspected] = useState('');
  useEffect(() => {
    let disposed = false;
    void Promise.all([window.agentHQ!.specopsDefinition(), window.agentHQ!.listSpecops()]).then(([d, r]) => { if (!disposed) { setDefinition(d); setYaml(d.yaml); setRuns(r); } }).catch((e: Error) => { if (!disposed) setError(e.message); });
    const timer = setInterval(() => { void window.agentHQ!.listSpecops().then((r) => { if (!disposed) setRuns(r); }).catch(() => {}); }, 2000);
    return () => { disposed = true; clearInterval(timer); };
  }, []);
  async function perform(action: () => Promise<void>) { setBusy(true); setError(''); try { await action(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  async function github(operation: string) {
    const value = await window.agentHQ!.githubRequest({ hostId, repo, repository, operation, issue, query, number: Number(number), headCommit: result?.headRefOid, updatedAt: result?.updatedAt, evidence: { commit, summary } });
    setResult(value); setInspected(operation);
  }
  const workflow = definition?.workflows.find((w) => w.id === workflowId);
  const changeContext = () => { setResult(null); setInspected(''); };
  return <Modal title="SPECOPS and GitHub" onClose={onClose} wide>
    <h2>SPECOPS / GitHub</h2>
    <div className="segmented">{['missions', 'workflows & ranks', 'GitHub'].map((value) => <button key={value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{value}</button>)}</div>
    <div className="specops-content">
      {tab === 'workflows & ranks' ? <>
        <p className="field-note">Assign provider model IDs to one or more ranks. Clone a workflow by copying its entry with a unique id. Edits apply to new missions; running missions retain their definitions. Model aliases are examples: use IDs available to your host account.</p>
        <div className="specops-profiles">{definition?.profiles.map((p) => <div key={p.id}><strong>{p.name}</strong><span>{p.provider} / {p.model}</span><small>{p.ranks.join(' · ').replaceAll('_', ' ')}</small></div>)}</div>
        <label>Workflow and rank YAML<textarea className="specops-yaml" rows={20} value={yaml} onChange={(e) => setYaml(e.target.value)} spellCheck={false} /></label>
        <p className="field-note">Saved in {definition?.directory}/specops.yaml. Gated planner/reviewer stages require provider approval for protected operations. Set allow_write: true only for an intentional override. Optional budgets halt subsequent stages when cost is unknown; they cannot cap an in-flight provider turn.</p>
        <button className="button-primary" disabled={busy} onClick={() => void perform(async () => { const d = await window.agentHQ!.configureSpecops(yaml); setDefinition(d); setYaml(d.yaml); })}>Save workflows and ranks</button>
      </> : <>
        <div className="form-grid"><label>Target host<select value={hostId} onChange={(e) => { setHostId(e.target.value); changeContext(); }}>{settings.hosts.filter((h) => h.enabled).map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label><label>GitHub repository<input value={repo} placeholder="owner/repository" onChange={(e) => { setRepo(e.target.value); changeContext(); }} /></label><label>Repository path on host<input value={repository} placeholder="/home/user/project" onChange={(e) => { setRepository(e.target.value); changeContext(); }} /></label></div>
        {tab === 'missions' ? <>
          <label>Mission template<select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>{definition?.workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
          {workflow?.trigger === 'github_issue' ? <label>Issue number or URL<input value={issue} placeholder="#52 or https://github.com/owner/repo/issues/52" onChange={(e) => setIssue(e.target.value)} /></label> : <label>Issue filter<input value={query} onChange={(e) => setQuery(e.target.value)} /></label>}
          <p className="field-note">Launch checks host gh access and structured providers, creates an isolated worktree at HEAD, and starts automatic stage handoffs. Implementers have full permissions; reviewers default to gated. Follow provider approval requests in the unit chat. An approved final review marks its PR ready or posts verified closure evidence and closes the audited issues. No auto-merge.</p>
          <div className="inline-actions"><button className="button-secondary" disabled={busy || !repo} onClick={() => void perform(() => github('readiness'))}>Check GitHub access</button><button className="button-primary" disabled={busy || !repo || !repository || !workflow} onClick={() => void perform(async () => { await window.agentHQ!.launchSpecops({ hostId, repo, repository, issue, query, workflowId }); setRuns(await window.agentHQ!.listSpecops()); })}>{busy ? 'Working…' : 'Launch mission'}</button></div>
          {result ? <pre className="specops-result">{JSON.stringify(result, null, 2)}</pre> : null}
          <h3>Mission activity</h3>
          {!runs.length ? <p className="field-note">No missions yet. Configure profiles and launch a template above.</p> : null}
          {runs.map((r) => <article className={`specops-run ${r.state}`} key={r.id}><strong>{r.workflow.name} · {r.repo}</strong><p className="specops-breadcrumb">{r.workflow.stages.map((s) => s.id === r.stage ? `[*${s.id}*]` : `[${s.id}]`).join(' → ')}</p><span>{r.state === 'halted' ? '[!HALT]' : r.state} · reported spend ${r.costUsd.toFixed(2)}{r.costKnown ? '' : ' (partial / unknown)'}</span>{r.error ? <p role="status">{r.error}</p> : null}<div className="inline-actions">{r.canResume ? <button className="button-secondary" disabled={busy} onClick={() => void perform(async () => { await window.agentHQ!.controlSpecops(r.id, 'resume'); setRuns(await window.agentHQ!.listSpecops()); })}>Resume observation</button> : null}{r.canRetry ? <button className="button-secondary" disabled={busy} onClick={() => void perform(async () => { await window.agentHQ!.controlSpecops(r.id, 'retry'); setRuns(await window.agentHQ!.listSpecops()); })}>Authorize one stage retry</button> : null}{!['completed', 'cancelled'].includes(r.state) ? <button className="text-button" disabled={busy} onClick={() => void perform(async () => { await window.agentHQ!.controlSpecops(r.id, 'cancel'); setRuns(await window.agentHQ!.listSpecops()); })}>Cancel routing</button> : null}</div><details><summary>Stage artifacts and review feedback ({r.visits.length})</summary>{r.visits.map((v) => <div key={v.id}><h4>{v.stage} · {v.outcome || 'pending'} · {v.name}</h4><pre>{v.output || 'Waiting for final artifact'}</pre></div>)}</details></article>)}
        </> : <>
          <div className="form-grid"><label>Issue number or URL<input value={issue} onChange={(e) => { setIssue(e.target.value); changeContext(); }} /></label><label>PR number<input type="number" min="1" value={number} onChange={(e) => { setNumber(e.target.value); changeContext(); }} /></label></div>
          <div className="inline-actions"><button disabled={busy} onClick={() => void perform(() => github('readiness'))}>Check access</button><button disabled={busy} onClick={() => void perform(() => github('issue'))}>Read issue</button><button disabled={busy} onClick={() => void perform(() => github('pr'))}>Inspect PR</button><button disabled={busy || inspected !== 'pr' || !result?.isDraft} onClick={() => void perform(() => github('ready'))}>Mark reviewed PR ready</button></div>
          {result ? <pre className="specops-result">{JSON.stringify(result, null, 2)}</pre> : null}
          {inspected === 'issue' ? <fieldset><legend>Reviewed closure evidence</legend><p className="field-note">Review the triage audit before closing. The bridge verifies the full SHA is on GitHub’s default branch and rejects a changed issue.</p><label>Full commit SHA<input value={commit} onChange={(e) => setCommit(e.target.value)} /></label><label>Evidence summary<textarea value={summary} onChange={(e) => setSummary(e.target.value)} /></label><button className="button-secondary" disabled={busy || !commit || !summary || result?.state !== 'OPEN'} onClick={() => void perform(async () => { const value = await window.agentHQ!.githubRequest({ hostId, repo, repository, operation: 'close', number: result?.number, updatedAt: result?.updatedAt, evidence: { commit, summary } }); setResult(value); setInspected('close'); })}>Post reviewed evidence and close issue</button></fieldset> : null}
        </>}
      </>}
    </div>
    {error ? <p role="alert" className="form-error">{error}</p> : null}
    <div className="dialog-actions"><button className="button-secondary" onClick={onClose}>Close</button></div>
  </Modal>;
}
