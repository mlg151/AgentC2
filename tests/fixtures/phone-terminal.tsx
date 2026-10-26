import React from 'react';
import { createRoot } from 'react-dom/client';
import { PhoneTerminal } from '../../src/companion/PhoneTerminal';
import '../../src/styles.css';
import '../../src/companion/companion.css';
import '@xterm/xterm/css/xterm.css';

// Only the companion transport boundary is simulated. The terminal and its
// public buffer, resize, input, lifecycle, and gesture behavior are real.
const client = {
  on(name, callback) {
    const listener = (event) => callback(event.detail);
    window.addEventListener(name, listener);
    return () => window.removeEventListener(name, listener);
  },
  request: (...args) => window.invokeTerminal(...args),
};
const session = { key: 'fixture/tmux:hq-111111111111', id: 'hq-111111111111', hostId: 'fixture', hostName: 'Fixture', title: 'Local history observer', provider: 'terminal', kind: 'managed', state: 'live', canAttach: true };
createRoot(document.getElementById('root')!).render(<React.StrictMode><div className="phone-app"><main className="phone-main"><PhoneTerminal client={client} session={session} connected onResume={() => {}} onRefresh={() => {}} /></main></div></React.StrictMode>);
