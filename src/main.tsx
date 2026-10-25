import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { OverwatchWindowApp } from './components/OverwatchWindowApp';
import './styles.css';
import '@xterm/xterm/css/xterm.css';

const overwatchWindow = new URLSearchParams(window.location.search).get('view') === 'overwatch';
if (overwatchWindow) document.documentElement.classList.add('overwatch-window');

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{overwatchWindow ? <OverwatchWindowApp /> : <App />}</React.StrictMode>,
);
