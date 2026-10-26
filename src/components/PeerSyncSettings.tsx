import { useEffect, useRef, useState } from 'react';
import type { PeerSyncConfig, PeerSyncStatus } from '../types';

export function PeerSyncSettings() {
  const [status, setStatus] = useState<PeerSyncStatus | null>(null);
  const [draft, setDraft] = useState<PeerSyncConfig>({ enabled: false, deviceName: '', bindAddress: '127.0.0.1', port: 43128 });
  const [pairing, setPairing] = useState<{ code: string; url: string; expiresAt: number } | null>(null);
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const draftRevision = useRef(0);
  const statusRevision = useRef(0);
  function edit(patch: Partial<PeerSyncConfig>) {
    draftRevision.current++;
    setDraft((current) => ({ ...current, ...patch }));
  }
  useEffect(() => {
    let active = true;
    const initialDraft = draftRevision.current, initialStatus = statusRevision.current;
    void window.agentHQ!.peerSyncStatus().then((value) => {
      if (!active || statusRevision.current !== initialStatus) return;
      setStatus(value);
      if (draftRevision.current === initialDraft) setDraft(value);
    }).catch((cause) => { if (active && statusRevision.current === initialStatus) setError(String(cause)); });
    const off = window.agentHQ!.onPeerSyncStatus((value) => { statusRevision.current++; setStatus(value); setPairing(null); });
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { active = false; off(); clearInterval(timer); };
  }, []);
  async function run(action: () => Promise<void>) {
    statusRevision.current++;
    setBusy(true); setError('');
    try { await action(); } catch (cause) { setError(String(cause)); } finally { setBusy(false); }
  }
  return <div className="dialog-form peer-sync-settings">
    <p className="field-note">Pair trusted desktops on your LAN or VPN to share SSH hosts, presets, Rules of Engagement, enrolled OpOrders, cleanup policies, notes, pins, callsigns, and attention acknowledgements. Each desktop keeps its own panes and local sessions. SSH and provider credentials stay on each computer.</p>
    <label className="checkbox-label"><input type="checkbox" checked={draft.enabled} onChange={(event) => edit({ enabled: event.target.checked })} />Enable desktop sync</label>
    <div className="form-grid"><label>Device name<input value={draft.deviceName} maxLength={80} onChange={(event) => edit({ deviceName: event.target.value })} /></label><label>LAN / VPN bind address<input value={draft.bindAddress} onChange={(event) => edit({ bindAddress: event.target.value })} /></label><label>Sync port<input type="number" min={0} max={65535} value={draft.port} onChange={(event) => edit({ port: Number(event.target.value) })} /></label></div>
    <p className="field-note">Use this computer’s private IPv4 address, including a Tailscale address, or 127.0.0.1 with a tunnel. Allow the selected port through your firewall. Paired traffic is encrypted.</p>
    <button className="button-primary" disabled={busy} onClick={() => void run(async () => { const revision = draftRevision.current; setPairing(null); const value = await window.agentHQ!.savePeerSync(draft); setStatus(value); if (draftRevision.current === revision) setDraft(value); })}>Apply desktop sync</button>
    <p role="status">{status?.running ? `Listening at ${status.address}` : 'Desktop sync is off'}</p>
    {status?.running ? <>
      <button className="button-secondary" disabled={busy} onClick={() => void run(async () => setPairing(await window.agentHQ!.issuePeerPairing()))}>Generate pairing code</button>
      {pairing && pairing.expiresAt > now ? <div className="host-editor"><p>Single use · expires in {Math.ceil((pairing.expiresAt - now) / 60000)} minutes. Enter these on the other desktop.</p><label>Pairing address<input readOnly value={pairing.url} /></label><label>Pairing code<input readOnly value={pairing.code} /></label></div> : pairing ? <p>Pairing code expired. Generate a new one.</p> : null}
      <h3>Connect to another desktop</h3>
      <label>Peer address<input value={url} placeholder="ws://192.168.1.10:43128" onChange={(event) => setUrl(event.target.value)} /></label><label>Peer pairing code<input type="password" autoComplete="off" value={code} onChange={(event) => setCode(event.target.value)} /></label>
      <button className="button-secondary" disabled={busy || !url || !code} onClick={() => void run(async () => { setStatus(await window.agentHQ!.connectPeer({ url: url.trim(), code: code.trim() })); setCode(''); })}>Connect desktop</button>
    </> : null}
    <h3>Paired desktops</h3>
    {status?.peers.length ? status.peers.map((peer) => <div className="host-editor" key={peer.id}><strong>{peer.name}</strong><p>{peer.connected ? 'Connected' : 'Offline · reconnects automatically'}{peer.lastSyncedAt ? ` · Last sync ${new Date(peer.lastSyncedAt).toLocaleTimeString()}` : ''}</p>{peer.error ? <p className="form-error">{peer.error}</p> : null}<div className="inline-actions"><button className="button-secondary" disabled={busy || !peer.connected} onClick={() => void run(async () => { await window.agentHQ!.pullPeerTabs(peer.id); })}>Pull open tabs ({peer.remoteTabs.length})</button><button className="button-secondary danger-text" disabled={busy} onClick={() => void run(async () => setStatus(await window.agentHQ!.revokePeer(peer.id)))}>Revoke desktop</button></div></div>) : <p className="field-note">No paired desktops.</p>}
    {error || status?.error ? <p role="alert" className="form-error">{error || status?.error}</p> : null}
  </div>;
}
