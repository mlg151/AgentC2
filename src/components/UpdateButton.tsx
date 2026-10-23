import { useCallback, useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { Modal } from './Modal';
import type { AppUpdate } from '../types';

export function UpdateButton() {
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    let active = true;
    const apply = (value: AppUpdate) => { if (active) setUpdate(value); };
    const fail = (cause: unknown) => { if (active) setError(String(cause)); };
    const off = window.agentHQ?.onUpdateState?.(apply);
    const check = () => { void window.agentHQ?.checkForUpdates?.().then(apply).catch(fail); };
    void window.agentHQ?.updateState?.().then((value) => { apply(value); if (['idle', 'current', 'pending'].includes(value.status)) check(); }).catch(fail);
    const timer = window.setInterval(check, 60 * 60000);
    return () => { active = false; off?.(); window.clearInterval(timer); };
  }, []);
  async function act(action: 'checkForUpdates' | 'downloadUpdate' | 'installUpdate') {
    setError('');
    try {
      if (!window.agentHQ) throw new Error('Updates are available in the desktop application');
      setUpdate(await window.agentHQ[action]());
    } catch (cause) { setError(String(cause)); }
  }
  const status = update?.status || 'idle';
  const busy = ['checking', 'downloading', 'installing'].includes(status);
  const label = status === 'pending' ? 'New main detected' : status === 'available' ? 'Update available' : status === 'ready' ? 'Restart to update' : status === 'downloading' ? 'Updating…' : 'Updates';
  return <>
    <button className="toolbar-button update-button" title="Check, download, and install application updates" onClick={() => setOpen(true)}><Download size={14} />{label}</button>
    {open ? <Modal title="Application updates" onClose={close}>
      <h2>Application updates</h2>
      <p>Installed version: {update?.version || 'Checking…'}</p>
      <p role="status" aria-live="polite">{status === 'checking' ? 'Checking for updates…' : status === 'pending' ? 'Newer main detected. Its installable update has not finished publishing yet. Check again after the release build completes.' : status === 'current' ? update?.source || update?.mainAhead === false ? 'You’re up to date.' : 'No newer published release was found.' : status === 'available' ? `Available: ${update?.target}` : status === 'downloading' ? update?.source ? 'Preparing and building the update…' : 'Downloading and verifying the update…' : status === 'ready' ? 'Your update is ready. Restart to install it.' : status === 'installing' ? 'Installing and restarting…' : 'Check for a newer version of AgentC2.'}</p>
      {status === 'downloading' ? <progress aria-label="Update progress" max={100} value={update?.percent ?? undefined} /> : null}
      {update?.source ? <p className="field-note">Updates build the latest main in a separate checkout. Restart opens that build; your original checkout and working files are kept. Git, Node.js 22, and npm must be installed.</p> : null}
      {status === 'ready' ? <p className="field-note">Restart disconnects desktop terminals and phone access briefly. Managed agents remain on their execution hosts.</p> : null}
      {error || update?.error ? <p className="form-error" role="alert">{error || update?.error}</p> : null}
      <div className="dialog-actions">
        <button className="button-secondary" onClick={close}>Close</button>
        <button className="button-secondary" disabled={busy || status === 'ready'} onClick={() => void act('checkForUpdates')}>{status === 'error' ? 'Retry check' : 'Check for updates'}</button>
        {status === 'available' ? <button className="button-primary" onClick={() => void act('downloadUpdate')}>{update?.source ? 'Build update' : 'Download update'}</button> : null}
        {status === 'ready' ? <button className="button-primary" onClick={() => void act('installUpdate')}>Restart and install</button> : null}
      </div>
    </Modal> : null}
  </>;
}
