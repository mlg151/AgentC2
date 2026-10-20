import { createRoot } from 'react-dom/client';
import Companion from './companion/Companion';
import './styles.css';
import './companion/companion.css';
import '@xterm/xterm/css/xterm.css';

createRoot(document.getElementById('root')!).render(<Companion />);
if ('serviceWorker' in navigator && import.meta.env.PROD) void navigator.serviceWorker.register('/companion-sw.js').catch(() => {});
