import React from 'react';
import { createRoot } from 'react-dom/client';
import { HistorySearch } from '../../src/components/HistorySearch';
import { SettingsDialog } from '../../src/components/SettingsDialog';
import { ProviderMark } from '../../src/components/ProviderMark';
import { DeleteSessionDialog } from '../../src/components/DeleteSessionDialog';
import { Modal } from '../../src/components/Modal';
import { KeyboardHelp } from '../../src/components/KeyboardHelp';
import { ChatModelSelector } from '../../src/components/ChatModelSelector';
import { PeerSyncSettings } from '../../src/components/PeerSyncSettings';
import { CentcomDialog } from '../../src/components/CentcomDialog';
import '../../src/styles.css';

// Render production components with a controlled IPC boundary. No SSH,
// provider credentials, remote configuration, or model calls are involved.
const root = createRoot(document.getElementById('root')!);
window.qaBridgeSettled = [];
window.agentHQ = new Proxy({}, {
  get(_target, name: string) {
    if (name === 'platform') return window.qaPlatform || 'linux';
    if (name.startsWith('on')) return (callback) => {
      const listener = (event) => callback(event.detail);
      window.addEventListener(name, listener);
      return () => window.removeEventListener(name, listener);
    };
    return async (...args) => {
      try { return await window.invokeBridge(name, ...args); }
      finally { window.qaBridgeSettled.push(name); }
    };
  },
});
function FocusFixture({ onClose, empty = false, restoreFocus, wide = false, disabledFirst = false }) {
  return <Modal title="Focus fixture" onClose={onClose} restoreFocus={restoreFocus} wide={wide}>{empty ? <p>No dialog controls</p> : <><input type="hidden" /><button disabled={disabledFirst}>First dialog action</button><input aria-label="Disabled fixture field" disabled /><button>Last dialog action</button><p>Inside dialog content</p></>}</Modal>;
}
function KeyboardFixture(props) { return <KeyboardHelp {...props} onSave={(value) => window.invokeBridge('saveShortcuts', value)} />; }
function DeleteFixture(props) { return <DeleteSessionDialog {...props} onDeleted={() => { window.invokeBridge('deleted'); window.qaUnmount(); }} />; }
function ModelFixture(props) { return <ChatModelSelector {...props} onChange={(value) => window.invokeBridge('modelChange', value)} />; }
const components = { history: HistorySearch, settings: SettingsDialog, centcom: CentcomDialog, peers: PeerSyncSettings, modal: FocusFixture, keyboard: KeyboardFixture, model: ModelFixture, provider: ProviderMark, delete: DeleteFixture };
window.qaMount = (name, props = {}) => {
  const close = () => { window.invokeBridge('closed'); root.render(<p>Dialog closed</p>); };
  const Component = components[name];
  root.render(<Component key={crypto.randomUUID()} onClose={close} onSave={(settings) => window.invokeBridge('saveSettings', settings)} onExternalSettings={(settings) => window.invokeBridge('externalSettings', settings)} onSpecops={props.specops === false ? undefined : () => window.invokeBridge('specops')} {...props} />);
};
window.qaEmit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));
window.qaUnmount = () => root.render(<p>Dialog unmounted</p>);
document.getElementById('launch')!.addEventListener('click', () => {});
