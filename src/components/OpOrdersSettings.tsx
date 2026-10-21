import { useState } from 'react';
import type { OpOrder, OpOrderPreview, Settings } from '../types';

const emptyOrder = (hostId: string): OpOrder => ({
  version: 1, id: crypto.randomUUID(), hostId, repository: '', enabled: false,
  instructions: '', overrides: { codex: '', claude: '', antigravity: '' }, mcp: [],
});

export function OpOrdersSettings({ settings, onSave, onApplied }: { settings: Settings; onSave: (value: Settings) => Promise<void>; onApplied: (value: Settings) => void }) {
  const [selectedId, setSelectedId] = useState(settings.opOrders?.[0]?.id || '');
  const [working, setWorking] = useState<OpOrder | null>(null);
  const [mcpText, setMcpText] = useState(() => JSON.stringify(settings.opOrders?.[0]?.mcp || [], null, 2));
  const [preview, setPreview] = useState<OpOrderPreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const selected = settings.opOrders?.find((order) => order.id === selectedId);
  const order = working || selected;

  function select(next: OpOrder) {
    setSelectedId(next.id); setWorking(structuredClone(next)); setMcpText(JSON.stringify(next.mcp, null, 2)); setPreview(null); setError('');
  }
  function edit(patch: Partial<OpOrder>) {
    if (!order) return;
    setWorking({ ...order, ...patch }); setPreview(null); setError('');
  }
  function parsedOrder(): OpOrder {
    if (!order) throw new Error('Select an OpOrder');
    const mcp: unknown = JSON.parse(mcpText);
    if (!Array.isArray(mcp)) throw new Error('MCP servers must be a JSON array');
    return { ...order, mcp: mcp as OpOrder['mcp'] };
  }
  async function showPreview() {
    setBusy(true); setError(''); setPreview(null);
    try {
      if (!window.agentHQ) throw new Error('Open AgentC2 as a desktop app to preview OpOrders');
      setPreview(await window.agentHQ.previewOpOrder(parsedOrder()));
    }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (!preview?.ready) return;
    setBusy(true); setError('');
    try {
      if (!window.agentHQ) throw new Error('Open AgentC2 as a desktop app to apply OpOrders');
      const updated = await window.agentHQ.enrollOpOrder(parsedOrder(), preview.revision);
      onApplied(updated);
      const saved = updated.opOrders?.find((item) => item.id === order?.id);
      if (saved) select(saved);
    } catch (cause) { setPreview(null); setError(String(cause)); }
    finally { setBusy(false); }
  }
  async function disableOrRemove(remove: boolean) {
    if (!order) return;
    setBusy(true); setError('');
    try {
      const opOrders = remove ? (settings.opOrders || []).filter((item) => item.id !== order.id) : (settings.opOrders || []).map((item) => item.id === order.id ? { ...item, enabled: false } : item);
      const updated = { ...settings, opOrders };
      await onSave(updated); onApplied(updated);
      const next = opOrders.find((item) => item.id === order.id) || opOrders[0];
      if (next) select(next); else { setSelectedId(''); setWorking(null); setPreview(null); }
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }

  return <div className="oporder-settings">
    <p className="field-note">Project guidance and MCP servers sync only after you preview and apply an OpOrder. The selected path must be an absolute Git worktree root on the selected SSH host. Remote environment variables hold credentials.</p>
    <div className="inline-actions"><label className="grow">OpOrder<select value={selectedId} onChange={(event) => { const next = settings.opOrders?.find((item) => item.id === event.target.value); if (next) select(next); }}><option value="" disabled>Select an OpOrder</option>{order && !selected ? <option value={order.id}>New OpOrder</option> : null}{(settings.opOrders || []).map((item) => <option key={item.id} value={item.id}>{item.repository || item.id} {item.enabled ? '· syncing' : '· paused'}</option>)}</select></label><button className="button-secondary" disabled={busy} onClick={() => select(emptyOrder(settings.hosts.find((host) => host.enabled)?.id || 'default'))}>Add OpOrder</button></div>
    {order ? <div className="oporder-editor">
      <div className="form-grid"><label>SSH host<select value={order.hostId} onChange={(event) => edit({ hostId: event.target.value })}>{settings.hosts.filter((host) => host.enabled).map((host) => <option value={host.id} key={host.id}>{host.name}</option>)}</select></label><label>Remote Git worktree root<input value={order.repository} placeholder="/home/user/project" onChange={(event) => edit({ repository: event.target.value })} /></label></div>
      <label>Shared instructions<textarea rows={5} value={order.instructions} onChange={(event) => edit({ instructions: event.target.value })} /></label>
      <label>Claude override<textarea rows={3} value={order.overrides.claude} onChange={(event) => edit({ overrides: { ...order.overrides, claude: event.target.value } })} /></label>
      <label>Antigravity override<textarea rows={3} value={order.overrides.antigravity} onChange={(event) => edit({ overrides: { ...order.overrides, antigravity: event.target.value } })} /></label>
      <label>Codex-only override<textarea rows={2} value={order.overrides.codex} onChange={(event) => edit({ overrides: { ...order.overrides, codex: event.target.value } })} /></label><p className="field-note">Codex-only overrides are currently unsupported; preview will explain the conversion limit. Shared instructions apply through AGENTS.md.</p>
      <label>MCP servers (JSON array)<textarea rows={8} className="oporder-json" spellCheck={false} value={mcpText} onChange={(event) => { setMcpText(event.target.value); setPreview(null); }} /></label>
      <p className="field-note">Each server needs name, transport (stdio or http), and providers. Stdio uses command, args, and env variable names. HTTP uses url and header names mapped to remote environment variable names. No secret values are stored here.</p>
      <div className="inline-actions"><button className="button-secondary" disabled={busy} onClick={() => void showPreview()}>Preview remote changes</button><button className="button-primary" disabled={busy || !preview?.ready} onClick={() => void apply()}>{order.enabled ? 'Apply update' : 'Apply and enable sync'}</button>{selected ? <button className="text-button" disabled={busy} onClick={() => void disableOrRemove(false)}>Pause sync</button> : null}{selected ? <button className="text-button danger-text" disabled={busy} onClick={() => void disableOrRemove(true)}>Remove</button> : null}</div>
      {preview ? <div className="oporder-preview"><strong>{preview.ready ? 'Ready to apply' : 'Review required'}</strong>{preview.unsupported.map((message) => <p className="form-error" key={message}>{message}</p>)}{preview.changes.map((change) => <details key={change.path} open={change.status === 'conflict'}><summary>{change.path} · {change.status}</summary>{change.reason ? <p className="form-error">{change.reason}</p> : null}{change.diff ? <pre>{change.diff}</pre> : null}</details>)}</div> : null}
      {error ? <p role="alert" className="form-error">{error}</p> : null}
    </div> : <p>Create an OpOrder to enroll a project.</p>}
  </div>;
}
