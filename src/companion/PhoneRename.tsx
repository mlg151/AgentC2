import { useState } from 'react';
import type { Session } from '../types';
import type { CompanionClient } from './client';

export function PhoneRename({ session, connected, client, onRefresh }: { session: Session; connected: boolean; client: CompanionClient; onRefresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(session.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !connected) return;
    setBusy(true); setError('');
    try { await client.request('session:rename', session.key, title); setOpen(false); onRefresh(); }
    catch (cause) { setError(String(cause)); } finally { setBusy(false); }
  }
  return <div className="phone-rename"><button disabled={!connected || session.stale || session.missing || busy} aria-expanded={open} onClick={() => { setTitle(session.title); setOpen((value) => !value); setError(''); }}>{open ? 'Cancel rename' : 'Rename'}</button>{open ? <form onSubmit={(event) => void save(event)}>
    <label>Session name<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} maxLength={100} disabled={busy} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) setOpen(false); }} /></label>
    <button type="submit" disabled={busy || !connected || session.stale || !title.trim() || /[\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(title)}>{busy ? 'Saving…' : 'Save'}</button>
    <button type="button" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
  </form> : null}{error ? <p role="alert" className="phone-error">{error}</p> : null}</div>;
}
