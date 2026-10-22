import { useCallback, useState } from 'react';
import { Modal } from './Modal';
import type { Session } from '../types';

export function DeleteSessionDialog({ session, onClose, onDeleted }: { session: Session; onClose: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const close = useCallback(() => { if (!busy) onClose(); }, [busy, onClose]);
  async function remove() {
    if (!window.agentHQ || busy) return;
    setBusy(true); setError('');
    try { await window.agentHQ.deleteSession(session.key); onDeleted(); }
    catch (cause) { setError(String(cause)); setBusy(false); }
  }
  return <Modal title="Delete session" onClose={close}>
    <h2>Delete “{session.title}”?</h2>
    <p>This stops any running work on {session.hostName} and removes the session, its tabs, and workspace notes from AgentC2. It will no longer appear in ORBAT or Overwatch.</p>
    <p>Repository files and saved provider history are kept. Saved conversations remain available through search.</p>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <div className="dialog-actions"><button className="button-secondary" disabled={busy} onClick={close}>Cancel</button><button className="button-primary danger" disabled={busy} onClick={() => void remove()}>{busy ? 'Deleting…' : 'Delete session'}</button></div>
  </Modal>;
}
