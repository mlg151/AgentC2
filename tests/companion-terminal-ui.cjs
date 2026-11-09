const assert = require('node:assert/strict');
const { phoneComponent } = require('./fixtures/phone-component.cjs');
(async () => {
  const calls = [], listeners = new Map(), opened = [], copied = [];
  let links, selection = true, uploadFailure, clipboardFailure;
  class Terminal {
    cols = 100; rows = 30; options = {};
    loadAddon() {} open() {} resize(cols, rows) { this.cols = cols; this.rows = rows; } write() {} dispose() {}
    onData() { return { dispose() {} }; }
    hasSelection() { return selection; } getSelection() { return 'selected phone text'; }
  }
  class ResizeObserver { observe() {} disconnect() {} }
  const state = { id: 'handle', canControl: true, controller: { name: 'Phone', id: 'phone' }, connection: 'connected', exitCode: null, cols: 100, rows: 30 };
  const client = { on: (name, callback) => { listeners.set(name, callback); return () => listeners.delete(name); }, request: async (name, ...args) => {
    calls.push([name, ...args]);
    if (name === 'terminal:open') return 'handle';
    if (name === 'terminal:ready') return { text: 'Phone fixture', sequence: 0, state };
    if (name === 'image:upload') { if (uploadFailure) throw uploadFailure; return '/tmp/phone image.png'; }
    if (name === 'tunnel:open') return 'https://desktop.ts.net:8443/handoff/once';
  } };
  const props = { client, session: { id: 'hq-111111111111', key: 'host/tmux:hq-111111111111', title: 'Phone fixture', hostId: 'host', hostName: 'Host', provider: 'codex', canAttach: true }, connected: true, onResume() {}, onRefresh() {} };
  const view = phoneComponent('PhoneTerminal.tsx', props, { element: { clientWidth: 390, clientHeight: 400 }, globals: { ResizeObserver }, window: { open: (...args) => opened.push(args) }, modules: {
    '@xterm/xterm': { Terminal }, '@xterm/addon-fit': { FitAddon: class { fit() {} } },
    '../terminalLinks': { enableTerminalLinks: (_terminal, callback) => { links = callback; } },
    './image': { imagePayload: async () => 'PNGDATA' },
    './clipboard': { readPhoneClipboard: async () => { if (clipboardFailure) throw clipboardFailure; return 'phone clipboard'; }, writePhoneClipboard: async (value) => { if (clipboardFailure) throw clipboardFailure; copied.push(value); } },
  } });
  links('http://localhost:5173'); assert.equal(calls.some(([name]) => name === 'tunnel:open'), false, 'An unbound terminal must not open previews');
  await view.flush();
  const image = () => view.find((node) => node.type === 'input' && node.props.type === 'file');
  assert.equal(image().props.disabled, false);
  image().props.onChange({ target: { files: [{}], value: 'chosen' } }); await view.flush(); assert.ok(calls.some(([method, id, data]) => method === 'image:upload' && id === 'handle' && data === 'PNGDATA')); assert.equal(view.find((node) => node.type === 'textarea').props.value, '"/tmp/phone image.png"');
  image().props.onChange({ target: { files: [{}], value: 'chosen' } }); await view.flush(); assert.match(view.find((node) => node.type === 'textarea').props.value, /" "/);
  image().props.onChange({ target: { files: [], value: '' } });
  uploadFailure = new Error('Upload interrupted'); image().props.onChange({ target: { files: [{}], value: 'chosen' } }); await view.flush(); assert.match(view.text(view.tree), /Upload interrupted/);
  view.button('Paste text').props.onClick(); await view.flush(); assert.match(view.find((node) => node.type === 'textarea').props.value, /phone clipboard$/);
  view.button('Copy selection').props.onClick(); await view.flush(); assert.deepEqual(copied, ['selected phone text']);
  clipboardFailure = new Error('Clipboard unavailable'); view.button('Paste text').props.onClick(); await view.flush(); assert.match(view.text(view.tree), /Clipboard unavailable/); view.button('Copy selection').props.onClick(); await view.flush();
  links('http://localhost:5173'); await view.flush(); assert.deepEqual(opened.pop(), ['https://desktop.ts.net:8443/handoff/once', '_blank', 'noopener,noreferrer']); assert.equal(view.find((node) => node.type === 'a').props.href, 'https://desktop.ts.net:8443/handoff/once');
  listeners.get('terminal:state')({ ...state, canControl: false }); view.render(); assert.equal(image().props.disabled, true); const previousUploads = calls.filter(([name]) => name === 'image:upload').length; image().props.onChange({ target: { files: [{}], value: 'chosen' } }); await view.flush(); assert.equal(calls.filter(([name]) => name === 'image:upload').length, previousUploads);
  view.close();
  console.log('PASS phone terminal image receipts/failures, local clipboard controls, and development preview routing');
})().catch((error) => { console.error(error); process.exitCode = 1; });
