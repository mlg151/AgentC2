import { useEffect, useState } from 'react';
import type { HostHealth, Settings } from '../types';

function bytes(value: number) {
  const gib = value / 1024 ** 3;
  return gib >= 1024 ? `${(gib / 1024).toFixed(1)} TiB` : `${gib.toFixed(1)} GiB`;
}
export function HostMonitor({ hosts }: { hosts: Settings['hosts'] }) {
  const [readings, setReadings] = useState<HostHealth[]>([]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const off = window.agentHQ?.onHealth(setReadings);
    void window.agentHQ?.health().then(setReadings).catch(() => {});
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { off?.(); window.clearInterval(timer); };
  }, [hosts]);
  return <aside className="host-monitor" aria-label="Live host resources">{hosts.filter((h) => h.enabled).map((host) => {
    const sample = readings.find((s) => s.hostId === host.id);
    const stale = !sample || !sample.connected || !sample.sampledAt || now - sample.sampledAt > 20000;
    const memoryPercent = sample?.memoryTotal && sample.memoryUsed !== undefined ? sample.memoryUsed / sample.memoryTotal * 100 : null;
    const cpu = sample?.cpuPercent;
    const gpu = sample?.gpu;
    const gpuFresh = !stale && gpu?.status === 'reported' && Boolean(gpu.sampledAt && now - gpu.sampledAt <= 60000);
    const gpuTotal = gpuFresh ? gpu!.devices.reduce((sum, device) => sum + device.memoryTotal, 0) : 0;
    const gpuUsed = gpuFresh ? gpu!.devices.reduce((sum, device) => sum + device.memoryUsed, 0) : 0;
    return <section key={host.id} className={`host-resource${stale ? ' stale' : ''}`} aria-label={`${host.name} resources`}>
      <strong title={sample?.error || host.target}><span className={`connection-dot${stale ? ' offline' : ''}`} />{host.name}</strong>
      <span className={cpu !== undefined && cpu !== null && cpu >= 85 ? 'resource-warning' : ''}>CPU <b>{cpu === undefined || cpu === null ? sample ? 'Sampling…' : '—' : `${cpu.toFixed(0)}%`}</b><i className="resource-meter"><i style={{ width: `${cpu || 0}%` }} /></i></span>
      <span title="Used memory excludes available filesystem cache" className={memoryPercent !== null && memoryPercent >= 85 ? 'resource-warning' : ''}>RAM <b>{sample?.memoryUsed !== undefined && sample.memoryTotal ? `${bytes(sample.memoryUsed)} / ${bytes(sample.memoryTotal)}` : '—'}</b><i className="resource-meter"><i style={{ width: `${memoryPercent || 0}%` }} /></i></span>
      {sample?.disks?.map((disk) => <span key={disk.path} className={disk.free / disk.total < .1 ? 'resource-warning' : ''} title={`${disk.path}: ${bytes(disk.used)} used of ${bytes(disk.total)}`}>Disk {disk.path} <b>{bytes(disk.free)} free / {bytes(disk.total)}</b></span>) || <span>Disk <b>—</b></span>}
      <span title="Host command round trip, including helper startup">{host.kind === 'local' ? 'Local probe' : 'SSH probe'} <b>{stale || sample?.sshRoundTripMs == null ? 'unavailable' : `${sample.sshRoundTripMs} ms`}</b></span>
      <span title="Active desktop and companion PTY viewers on this host">Channels <b>{stale || sample?.activeChannels == null ? 'unavailable' : sample.activeChannels}</b></span>
      <span className="gpu-line" title={gpuFresh ? gpu!.devices.map((device) => device.name).join(', ') : 'GPU capability or sample unavailable'}>GPU / VRAM <b>{gpuFresh && gpuTotal ? `${gpu!.devices.length} · ${bytes(gpuUsed)} / ${bytes(gpuTotal)} · ${Math.round((now - gpu!.sampledAt!) / 1000)}s ago` : stale ? 'stale' : gpu?.status === 'unsupported' ? 'unsupported' : gpu?.status === 'reported' ? 'stale sample' : 'unknown'}</b></span>
      <small>{stale ? sample?.sampledAt ? `Stale · ${Math.max(0, Math.round((now - sample.sampledAt) / 1000))}s ago` : 'Unavailable' : sample?.sampledAt ? `Live · ${Math.max(0, Math.round((now - sample.sampledAt) / 1000))}s ago` : 'Connecting…'}</small>
    </section>;
  })}</aside>;
}
