import { isMac } from '../platform';
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { RemoteStatus } from '../types';

export function RemoteAccess() {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState('');
  const [transport, setTransport] = useState<'https' | 'tailnet-http'>('https');
  const [port, setPort] = useState(43127);
  const [tailscale, setTailscale] = useState('Checking Tailscale…');
  const [pairing, setPairing] = useState<{ url: string; expiresAt: number; image: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let cancelled = false;
    void Promise.all([window.agentHQ!.remoteStatus(), window.agentHQ!.tailscaleStatus()]).then(([remote, ts]) => {
      if (cancelled) return;
      setStatus(remote); setEnabled(remote.enabled); setPort(remote.port); setUrl(remote.url || ts.url); setTransport(remote.transport || 'https');
      setTailscale(ts.state === 'Running' ? 'Tailscale is connected.' : `Tailscale: ${ts.state}. Sign in on your computer and phone.`);
    }).catch((cause) => { if (!cancelled) setError(String(cause)); });
    const off = window.agentHQ?.onRemoteStatus((remote) => { setStatus(remote); setEnabled(remote.enabled); setPairing(null); });
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { cancelled = true; off?.(); clearInterval(timer); };
  }, []);
  async function save() {
    setBusy(true); setError(''); setPairing(null);
    try { setStatus(await window.agentHQ!.saveRemote({ enabled, port, url, transport })); }
    catch (cause) { setError(String(cause)); setStatus(await window.agentHQ!.remoteStatus()); }
    finally { setBusy(false); }
  }
  async function pair() {
    setBusy(true); setError('');
    try {
      const value = await window.agentHQ!.pairRemote();
      const image = await QRCode.toDataURL(value.url, { width: 240, margin: 2 });
      setPairing({ ...value, image });
      setStatus(await window.agentHQ!.remoteStatus());
    } catch (cause) { setError(String(cause)); } finally { setBusy(false); }
  }
  return <div className="remote-access dialog-form">
    <p className="field-note">Control sessions from your phone through your private Tailscale network. Keep this computer awake. When remote access is enabled, closing minimizes the window on Linux and keeps AgentC2 in the tray or Dock on other desktops.</p>
    <p role="status">{status?.running ? 'Gateway running' : 'Gateway stopped'} · {tailscale}</p>
    {status?.error ? <p role="alert" className="form-error">{status.error}</p> : null}
    <label className="checkbox-label"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enable remote access and tray operation</label>
    <label>Connection method<select value={transport} onChange={(e) => setTransport(e.target.value as typeof transport)}><option value="https">Tailscale HTTPS name</option><option value="tailnet-http">Private Tailscale IP (DNS disabled)</option></select></label>
    <div className="form-grid"><label>Companion origin<input placeholder={transport === 'tailnet-http' ? 'http://100.x.x.x:8080' : 'https://pc.tailnet.ts.net'} value={url} onChange={(e) => setUrl(e.target.value)} /></label><label>Local gateway port<input type="number" min={1024} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))} /></label></div>
    {transport === 'tailnet-http' ? <p className="field-note">Sign in to Tailscale on both devices. Forward port 8080 through the private tailnet:<br /><code>tailscale serve --bg --tcp=8080 tcp://127.0.0.1:{port}</code><br />Use http:// followed by this computer’s Tailscale IPv4 address and :8080. Tailscale encrypts the connection; DNS is not required. Allow this port only on the Tailscale interface. Do not enable Funnel.</p> : <p className="field-note">Sign in to Tailscale on both devices. {window.agentHQ?.platform === 'win32' ? 'In an Administrator PowerShell window' : isMac ? 'In Terminal (enable the Tailscale CLI first)' : 'In a terminal'}, forward private HTTPS traffic to AgentC2:<br /><code>tailscale serve --bg http://127.0.0.1:{port}</code><br />Use the HTTPS origin shown by that command. Existing Serve configurations may need a different HTTPS port. Do not enable Funnel.</p>}
    <button className="button-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Working…' : 'Apply remote access'}</button>
    {status?.running ? <>
      <label>Companion address<input readOnly value={`${status.url}/companion.html`} /></label>
      <div className="inline-actions"><button className="button-secondary" disabled={busy} onClick={() => void pair()}>Pair a device</button><button className="button-secondary" onClick={() => void window.agentHQ!.remoteStatus().then(setStatus).catch((cause) => setError(String(cause)))}>Refresh devices</button></div>
      {pairing && pairing.expiresAt > now ? <div className="pairing-card"><img src={pairing.image} width={240} height={240} alt="Scan to pair your phone" /><div><strong>Open the link on your phone, or scan</strong><p>Single-use link · expires in {Math.ceil((pairing.expiresAt - now) / 60000)} min</p><label>Pairing link<input readOnly value={pairing.url} /></label><button className="button-secondary" onClick={() => void window.agentHQ?.writeClipboard(pairing.url)}>Copy pairing link</button></div></div> : pairing ? <p>Pairing link expired. Generate a new one.</p> : null}
    </> : null}
    <h3>Paired devices</h3>
    {status?.devices.length ? status.devices.map((device) => <div className="paired-device" key={device.id}><div><strong>{device.name}</strong><small>Paired {new Date(device.createdAt).toLocaleDateString()} · expires {new Date(device.expiresAt).toLocaleDateString()}</small></div><button className="button-secondary danger-text" onClick={() => void window.agentHQ!.revokeRemote(device.id).then(setStatus).catch((cause) => setError(String(cause)))}>Revoke</button></div>) : <p className="field-note">No paired devices.</p>}
    {error ? <p role="alert" className="form-error">{error}</p> : null}
  </div>;
}
