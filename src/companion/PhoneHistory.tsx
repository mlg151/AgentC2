import { useState } from 'react';
import { Modal } from '../components/Modal';
import type { HistoryMatches, Session } from '../types';

export function PhoneHistory({ sessions, onSelect, onClose }: { sessions: Session[]; onSelect: (session: Session) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<HistoryMatches | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function search() {
    setBusy(true); setError('');
    try { setResult(await window.agentHQ!.searchHistory(query, sessions.filter((session) => session.canAttach).slice(0, 200).map((session) => session.key))); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  return <Modal title="Search session history" onClose={onClose} wide><div className="dialog-heading"><h2>Search session history</h2><button aria-label="Close history search" onClick={onClose}>×</button></div><form className="phone-history-search" onSubmit={(event) => { event.preventDefault(); void search(); }}><label>Search retained history<input value={query} onChange={(event) => setQuery(event.target.value)} minLength={3} maxLength={200} required /></label><button type="submit" disabled={busy || query.length < 3}>{busy ? 'Searching…' : 'Search'}</button></form>{error ? <p role="alert">{error}</p> : null}{result ? <><p role="status">{result.matches.length} matches in {result.searched} sessions{result.truncated ? ' · Results limited; narrow the session list or query.' : ''}</p>{result.errors.length ? <p>Some sessions could not be searched: {result.errors.join(', ')}</p> : null}{result.matches.map((match, index) => { const session = sessions.find((item) => item.key === match.key); return <button className="phone-history-result" key={`${match.key}/${index}`} disabled={!session} onClick={() => { if (session) onSelect(session); }}><strong>{session?.title || match.key} · line {match.line}</strong><pre>{match.excerpt}</pre></button>; })}</> : <p>Search snapshots of up to eight attached sessions. Results never take control of a session.</p>}</Modal>;
}
