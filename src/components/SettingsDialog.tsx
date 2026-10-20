import { useState } from 'react';
import type { Settings } from '../types';
import { Modal } from './Modal';
import { RemoteAccess } from './RemoteAccess';

export function SettingsDialog({ settings, onSave, onClose }: { settings: Settings; onSave: (value: Settings) => Promise<void>; onClose: () => void }) {
  const [draft, setDraft] = useState(() => structuredClone(settings));
  const [section, setSection] = useState<'hosts' | 'presets' | 'remote'>('hosts');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [presetId, setPresetId] = useState(settings.presets[0]?.id || '');
  const preset = draft.presets.find((p) => p.id === presetId);
  function updatePreset(patch: Partial<Settings['presets'][number]>) { setDraft((d) => ({ ...d, presets: d.presets.map((p) => p.id === presetId ? { ...p, ...patch } : p) })); }
  async function save() {
    setBusy(true); setError('');
    try { await onSave(draft); onClose(); } catch (cause) { setError(String(cause)); } finally { setBusy(false); }
  }
  return <Modal title="Settings" onClose={onClose} wide>
    <div className="dialog-heading"><div><h2>Settings</h2><p>Connection profiles and repeatable agent launches.</p></div><button aria-label="Close settings" onClick={onClose} className="icon-button">×</button></div>
    <div className="segmented"><button className={section === 'hosts' ? 'active' : ''} onClick={() => setSection('hosts')}>SSH hosts</button><button className={section === 'presets' ? 'active' : ''} onClick={() => setSection('presets')}>Launch presets</button><button className={section === 'remote' ? 'active' : ''} onClick={() => setSection('remote')}>Remote access</button></div>
    <div className="settings-body">
      {section === 'remote' ? <RemoteAccess /> : section === 'hosts' ? <>
        <p className="field-note">Use an existing SSH config alias or user@hostname. Keys, ProxyJump, and known hosts come from OpenSSH. Host key verification stays enabled.</p>
        {draft.hosts.map((h) => <fieldset key={h.id} className="host-editor"><legend>{h.name || 'New host'}</legend>
          <div className="form-grid"><label>Name<input value={h.name} onChange={(e) => setDraft({ ...draft, hosts: draft.hosts.map((item) => item.id === h.id ? { ...item, name: e.target.value } : item) })} /></label><label>SSH target<input value={h.target} placeholder="user@server or ssh-alias" onChange={(e) => setDraft({ ...draft, hosts: draft.hosts.map((item) => item.id === h.id ? { ...item, target: e.target.value } : item) })} /></label><label>Port<input type="number" min="1" max="65535" value={h.port} onChange={(e) => setDraft({ ...draft, hosts: draft.hosts.map((item) => item.id === h.id ? { ...item, port: Number(e.target.value) } : item) })} /></label></div>
          <div className="inline-actions"><label className="checkbox-label"><input type="checkbox" checked={h.enabled} onChange={(e) => setDraft({ ...draft, hosts: draft.hosts.map((item) => item.id === h.id ? { ...item, enabled: e.target.checked } : item) })} /> Enabled</label><button className="text-button danger-text" onClick={() => setDraft({ ...draft, hosts: draft.hosts.filter((item) => item.id !== h.id), presets: draft.presets.map((p) => p.hostId === h.id ? { ...p, hostId: '' } : p) })}>Remove host</button></div>
        </fieldset>)}
        <button className="button-secondary" onClick={() => setDraft({ ...draft, hosts: [...draft.hosts, { id: crypto.randomUUID(), name: 'New host', target: '', port: 22, enabled: true }] })}>Add SSH host</button>
      </> : <>
        <div className="inline-actions"><label className="grow">Preset<select aria-label="Edit preset" value={presetId} onChange={(e) => setPresetId(e.target.value)}>{draft.presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><button className="button-secondary" onClick={() => { const id = crypto.randomUUID(); setDraft({ ...draft, presets: [...draft.presets, { id, name: 'New preset', provider: 'claude', command: 'claude3', args: '', cwd: '', instructions: '', fullPermissions: true, attentionHooks: true, hostId: '' }] }); setPresetId(id); }}>Add preset</button></div>
        {preset ? <div className="preset-editor">
          <div className="form-grid"><label>Preset name<input value={preset.name} onChange={(e) => updatePreset({ name: e.target.value })} /></label><label>Provider<select value={preset.provider} onChange={(e) => updatePreset({ provider: e.target.value as typeof preset.provider })}><option value="codex">Codex</option><option value="claude">Claude</option><option value="antigravity">Antigravity</option></select></label></div>
          <label>Launch command<input value={preset.command} placeholder="claude3" onChange={(e) => updatePreset({ command: e.target.value })} /></label><p className="field-note">Runs through bash -lic on the remote host, including aliases/functions loaded by that shell. For your OpenRouter setup, enter claude3. Keep API keys in the remote environment.</p>
          <label>Additional arguments<input value={preset.args} placeholder={'--model "your model"'} onChange={(e) => updatePreset({ args: e.target.value })} /></label>
          <div className="form-grid"><label>Default host<select value={preset.hostId} onChange={(e) => updatePreset({ hostId: e.target.value })}><option value="">Use selected host</option>{draft.hosts.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label><label>Working directory<input value={preset.cwd} onChange={(e) => updatePreset({ cwd: e.target.value })} placeholder="Remote home directory" /></label></div>
          <label>Starting instructions<textarea rows={4} value={preset.instructions} onChange={(e) => updatePreset({ instructions: e.target.value })} /></label>
          <label className="checkbox-label"><input type="checkbox" checked={preset.fullPermissions} onChange={(e) => updatePreset({ fullPermissions: e.target.checked })} /> Launch with full permissions</label><p className="field-note">Adds the provider’s bypass-permissions flag. Turn off to use the command’s configured defaults. Resume adds the provider’s conversation flag automatically.</p>
          {preset.provider !== 'antigravity' ? <><label className="checkbox-label"><input type="checkbox" checked={preset.attentionHooks} onChange={(e) => updatePreset({ attentionHooks: e.target.checked })} /> Report provider turn events to the attention inbox</label><p className="field-note">Adds session-only Claude hooks or a Codex turn-completion notifier. Disable for commands that do not accept provider flags. Existing sessions keep their launch settings.</p></> : <p className="field-note">Antigravity uses process exits and inferred terminal prompts for attention reporting.</p>}
          <button className="text-button danger-text" onClick={() => { const rest = draft.presets.filter((p) => p.id !== presetId); setDraft({ ...draft, presets: rest }); setPresetId(rest[0]?.id || ''); }}>Remove preset</button>
        </div> : <p>Add a preset to save a launch command.</p>}
      </>}
    </div>
    <label className="checkbox-label"><input type="checkbox" checked={draft.notifications} onChange={(e) => setDraft({ ...draft, notifications: e.target.checked })} /> Desktop notifications for new attention items</label>
    {error ? <p role="alert" className="form-error">{error}</p> : null}
    <div className="dialog-actions"><button className="button-secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="button-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save settings'}</button></div>
  </Modal>;
}
