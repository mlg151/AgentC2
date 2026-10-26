import { createRoot } from 'react-dom/client';
import { ChatView } from '../../src/components/ChatView';
import '../../src/styles.css';

// Only the public ChatApi boundary is controlled by the browser test.
const root = createRoot(document.getElementById('root')!);
const listen = (name, callback) => {
  const listener = (event) => callback(event.detail);
  window.addEventListener(name, listener);
  return () => window.removeEventListener(name, listener);
};
const api = Object.fromEntries(['open', 'ready', 'history', 'take', 'submit', 'receipt', 'close', 'prune'].map((name) => [name, (...args) => window.invokeChat(name, ...args)]));
api.onEvents = (callback) => listen('chat:events', callback);
api.onState = (callback) => listen('chat:state', callback);
const refresh = () => window.invokeChat('refresh');
window.qaMountChat = (props = {}) => root.render(<main style={{ height: '100dvh', maxWidth: 1000, margin: 'auto', display: 'flex', flexDirection: 'column' }}><ChatView api={api} sessionId="chat-0123456789abcdef0123456789abcdef" hostId="fixture" onRefresh={refresh} {...props} /></main>);
window.qaMountChat();
