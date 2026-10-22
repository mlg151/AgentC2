import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { DiffDetail, DiffFile, Session } from '../types';

export function DiffDrawer({ session, visible, onClose }: { session: Session; visible: boolean; onClose: () => void }) {
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [fileId, setFileId] = useState('');
  const [detail, setDetail] = useState<DiffDetail | null>(null);
  const [selectedHunk, setSelectedHunk] = useState('');
  const [confirmRevert, setConfirmRevert] = useState('');
  const [error, setError] = useState('');
  const [stale, setStale] = useState(Boolean(session.stale));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [revisionTick, setRevisionTick] = useState(0);
  const drawer = useRef<HTMLElement>(null);
  const scope = { hostId: session.hostId, name: session.id, operationId: session.worktreeOperation || '' };
  useEffect(() => { drawer.current?.focus(); }, []);
  useEffect(() => {
    if (!visible || session.stale || !session.worktreeOperation) { setStale(true); return; }
    const client = window.agentHQ!;
    if (!client) { setStale(true); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = 3000;
    async function load() {
      try {
        const next = await client.diffFiles(scope);
        const selected = next.some((item) => item.id === fileId) ? fileId : next[0]?.id || '';
        const nextDetail = selected ? await client.diffDetail({ ...scope, fileId: selected }) : null;
        if (cancelled) return;
        setFiles(next); setFileId(selected); setDetail(nextDetail);
        setSelectedHunk((current) => nextDetail?.unstaged.some((hunk) => hunk.id === current) ? current : nextDetail?.unstaged[0]?.id || '');
        setError(''); setStale(false); setLoading(false); delay = 3000;
      } catch (cause) {
        if (cancelled) return;
        setError(String(cause)); setStale(true); setLoading(false); delay = Math.min(delay * 2, 30000);
      }
      if (!cancelled) timer = setTimeout(() => void load(), delay);
    }
    void load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [visible, session.key, session.stale, session.worktreeOperation, fileId, revisionTick]);
  async function change(hunkId: string, operation: 'stage' | 'revert') {
    const client = window.agentHQ;
    if (!client || !detail || stale || busy) return;
    setBusy(true); setError('');
    try {
      await client.diffHunk({ ...scope, fileId, revision: detail.revision, hunkId, operation });
      setConfirmRevert(''); setRevisionTick((value) => value + 1);
    } catch (cause) { setError(String(cause)); setStale(true); }
    finally { setBusy(false); }
  }
  function moveFile(direction: number) {
    if (!files.length) return;
    const index = Math.max(0, files.findIndex((item) => item.id === fileId));
    setFileId(files[(index + direction + files.length) % files.length].id);
    setDetail(null); setStale(true); setConfirmRevert('');
  }
  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing || event.target instanceof HTMLInputElement) return;
    if (event.key === 'j' || event.key === 'k') { event.preventDefault(); moveFile(event.key === 'j' ? 1 : -1); }
    if (event.key === 's' && selectedHunk && !stale && !busy) { event.preventDefault(); void change(selectedHunk, 'stage'); }
    if (event.key === 'r' && selectedHunk && !stale && !busy) { event.preventDefault(); setConfirmRevert(selectedHunk); }
  }
  const selected = files.find((item) => item.id === fileId);
  return <section ref={drawer} tabIndex={0} className="diff-drawer" role="region" aria-label="Worktree diff" onKeyDown={onKeyDown}>
    <header><strong>WORKTREE DIFF</strong><span>{session.branch || 'Branch unknown'}</span>{stale ? <em role="status">Stale · refresh after reconnect</em> : loading ? <em>Loading…</em> : <em>{files.length} changed</em>}<button aria-label="Close worktree diff" onClick={onClose}>×</button></header>
    {error ? <p className="diff-error" role="alert">{error}</p> : null}
    <div className="diff-body">
      <nav aria-label="Changed files">{files.length ? files.map((file) => <button key={file.id} aria-current={file.id === fileId ? 'true' : undefined} className={file.id === fileId ? 'active' : ''} onClick={() => { setFileId(file.id); setDetail(null); setStale(true); setConfirmRevert(''); }}><span>{file.path}</span><small>{[file.staged ? 'staged' : '', file.unstaged ? 'unstaged' : '', file.untracked ? 'untracked' : ''].filter(Boolean).join(' · ')}</small></button>) : <p>{loading ? 'Reading Git changes…' : 'No changed files.'}</p>}</nav>
      <div className="diff-content">{selected && detail ? <><h3>{selected.path}</h3>{detail.large ? <p>Diff is larger than 512 KB. Inspect this file with Git.</p> : detail.binary ? <p>Binary change. Hunk actions are unavailable.</p> : <><pre className="diff-summary">{detail.summary}</pre>{detail.staged.length ? <div className="diff-section"><strong>Staged</strong>{detail.staged.map((hunk) => <pre key={hunk.id}>{hunk.text}</pre>)}</div> : null}{detail.unstaged.length ? <div className="diff-section"><strong>Unstaged</strong>{detail.unstaged.map((hunk) => <article key={hunk.id} className={selectedHunk === hunk.id ? 'selected' : ''}><button className="diff-hunk-select" onClick={() => setSelectedHunk(hunk.id)}>Select hunk</button><pre>{hunk.text}</pre>{hunk.actionable ? <div className="diff-hunk-actions"><button disabled={stale || busy} onClick={() => void change(hunk.id, 'stage')}>Stage hunk</button><button disabled={stale || busy} onClick={() => setConfirmRevert(hunk.id)}>Review revert</button>{confirmRevert === hunk.id ? <span role="status">Discard only this reviewed hunk? <button disabled={stale || busy} onClick={() => void change(hunk.id, 'revert')}>Confirm revert</button><button onClick={() => setConfirmRevert('')}>Cancel</button></span> : null}</div> : <small>Use Git for this file-level change.</small>}</article>)}</div> : null}</>}</> : <p>{selected ? 'Reading diff…' : 'Select a changed file.'}</p>}</div>
    </div>
    <footer>j/k files · s stage selected hunk · r review revert · Alt+D close</footer>
  </section>;
}
