import { createRoot } from 'react-dom/client';
import { ChatView } from '../../src/components/ChatView';
import type { ChatApi } from '../../src/chatTypes';
import '../../src/styles.css';
const bridge = window as unknown as { invoke: (method: string, ...args: unknown[]) => Promise<never> };
const listen = (name: string, callback: (value: never) => void) => {
  const handler = (event: Event) => callback((event as CustomEvent).detail);
  window.addEventListener(name, handler);
  return () => window.removeEventListener(name, handler);
};
const api: ChatApi = {
  open: (...args) => bridge.invoke('open', ...args), ready: (...args) => bridge.invoke('ready', ...args),
  history: (...args) => bridge.invoke('history', ...args), take: (...args) => bridge.invoke('take', ...args),
  submit: (...args) => bridge.invoke('submit', ...args), receipt: (...args) => bridge.invoke('receipt', ...args), close: (...args) => bridge.invoke('close', ...args),
  prune: (...args) => bridge.invoke('prune', ...args),
  onEvents: (callback) => listen('chat:events', callback), onState: (callback) => listen('chat:state', callback),
};
createRoot(document.getElementById('root')!).render(<div style={{ height: '100dvh', maxWidth: 1100, margin: 'auto', display: 'flex', flexDirection: 'column' }}><header style={{ padding: '16px 20px', borderBottom: '1px solid #30383f' }}><strong>Mission review</strong><small style={{ display: 'block', marginTop: 6 }}>Codex · QA host · /workspace/agentc2</small></header><ChatView api={api} hostId="fixture" sessionId="chat-0123456789abcdef0123456789abcdef" /></div>);
