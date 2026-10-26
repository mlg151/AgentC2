import React from 'react';
import { createRoot } from 'react-dom/client';
import { HistorySearch } from '../../src/components/HistorySearch';
import { SettingsDialog } from '../../src/components/SettingsDialog';
import { CentcomDialog } from '../../src/components/CentcomDialog';
import '../../src/styles.css';

// Render production components with a controlled IPC boundary. No SSH,
// provider credentials, remote configuration, or model calls are involved.
const root = createRoot(document.getElementById('root')!);
window.agentHQ = new Proxy({}, {
  get(_target, name: string) {
    if (name === 'platform') return window.qaPlatform || 'linux';
    if (name.startsWith('on')) return (callback) => {
      const listener = (event) => callback(event.detail);
      window.addEventListener(name, listener);
      return () => window.removeEventListener(name, listener);
    };
    return (...args) => window.invokeBridge(name, ...args);
  },
});
const components = { history: HistorySearch, settings: SettingsDialog, centcom: CentcomDialog };
window.qaMount = (name, props = {}) => {
  const close = () => { window.invokeBridge('closed'); root.render(<p>Dialog closed</p>); };
  const Component = components[name];
  root.render(<Component key={crypto.randomUUID()} onClose={close} onSave={(settings) => window.invokeBridge('saveSettings', settings)} onExternalSettings={(settings) => window.invokeBridge('externalSettings', settings)} onSpecops={props.specops === false ? undefined : () => window.invokeBridge('specops')} {...props} />);
};
window.qaEmit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));
window.qaUnmount = () => root.render(<p>Dialog unmounted</p>);
document.getElementById('launch')!.addEventListener('click', () => {});
