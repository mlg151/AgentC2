import type { FlashRequest } from '../types';

export function FlashTraffic({ requests, selectedId, busy, error, onSelect, onDecide, onJump, onClose }: {
  requests: FlashRequest[]; selectedId: string; busy: boolean; error: string;
  onSelect: (id: string) => void; onDecide: (decision: 'allow' | 'deny') => void; onJump: () => void; onClose: () => void;
}) {
  const selected = requests.find((item) => item.id === selectedId) || requests[0];
  return <aside className="flash-traffic" aria-label="Flash Traffic permission queue">
    <div className="flash-heading"><div><strong>Flash Traffic</strong><small>{requests.filter((item) => item.state === 'pending').length} pending verified requests</small></div><button className="icon-button" onClick={onClose} aria-label="Close Flash Traffic">×</button></div>
    <div className="flash-items" role="listbox" aria-label="Permission requests">{requests.map((item) => <button key={item.id} role="option" aria-selected={item.id === selected?.id} className={item.id === selected?.id ? 'selected' : ''} onClick={() => onSelect(item.id)}><strong>{item.hostName} / {item.name}</strong><span>{item.tool} · {item.state}{item.connected ? '' : ' · disconnected'}</span></button>)}</div>
    {selected ? <div className="flash-detail"><p><strong>Target:</strong> {selected.hostName} / {selected.name} {selected.branch ? `· ${selected.branch}` : ''}</p><p><strong>Provider:</strong> Claude · <strong>Tool:</strong> {selected.tool}</p><p><strong>Requested:</strong> {new Date(selected.createdAt * 1000).toLocaleString()} · expires {new Date(selected.expiresAt * 1000).toLocaleTimeString()}</p><pre aria-label="Exact requested action">{selected.action}</pre><p className="field-note">One decision for this exact provider hook request. An inbox acknowledgement never answers it.</p><div className="inline-actions"><button className="button-primary" disabled={busy || !selected.connected || selected.state !== 'pending'} onClick={() => onDecide('allow')}>Approve once <kbd>Alt+Y</kbd></button><button className="button-secondary" disabled={busy || !selected.connected || selected.state !== 'pending'} onClick={() => onDecide('deny')}>Deny <kbd>Alt+N</kbd></button><button className="button-secondary" onClick={onJump}>Jump <kbd>Alt+G</kbd></button></div></div> : <p className="field-note">No verified requests are pending. Inferred terminal prompts must be checked in their own session.</p>}
    {error ? <p role="alert">{error}</p> : null}
  </aside>;
}
