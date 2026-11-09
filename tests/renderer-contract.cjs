const assert = require('node:assert/strict');
const { loadRenderer } = require('./helpers/load-renderer.cjs');
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

async function main() {
  const methods = {
    open: ['openChat', 'chat:open', ['session', 'host']], ready: ['readyChat', 'chat:ready', ['view', 25]],
    history: ['chatHistory', 'chat:history', ['view', 40, 50]], take: ['takeChat', 'chat:take', ['view']],
    submit: ['submitChat', 'chat:submit', ['view', { operation: 'send', payload: { text: 'Reviewed command' } }]],
    receipt: ['chatReceipt', 'chat:receipt', ['view', 'command']], close: ['closeChat', 'chat:close', ['view']], prune: ['pruneChat', 'chat:prune', ['view']],
  };
  const calls = [], response = { fixture: 'response' }, rejected = new Error('Transport refused');
  let error;
  const listeners = new Map();
  const unsubscribe = () => {};
  const desktop = Object.fromEntries(Object.values(methods).map(([method]) => [method, (...args) => {
    calls.push([method, ...args]); return error ? Promise.reject(error) : Promise.resolve(response);
  }]));
  Object.assign(desktop, { onChatEvents(callback) { listeners.set('events', callback); return unsubscribe; }, onChatState(callback) { listeners.set('state', callback); return unsubscribe; } });
  globalThis.window = { agentHQ: desktop };
  const { desktopChatApi, companionChatApi, chatLink, chatCommandId } = loadRenderer('chatClient.ts');
  assert.match(chatCommandId(), /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  const companion = companionChatApi({
    request: (...args) => { calls.push(args); return error ? Promise.reject(error) : Promise.resolve(response); },
    on: (name, callback) => { listeners.set(name, callback); return unsubscribe; },
  });
  for (const [method, [native, wire, args]] of Object.entries(methods)) {
    for (const [api, name] of [[desktopChatApi, native], [companion, wire]]) {
      assert.equal(await api[method](...args), response);
      assert.deepEqual(calls.pop(), [name, ...args]);
      error = rejected;
      await assert.rejects(api[method](...args), (failure) => failure === rejected);
      calls.pop(); error = undefined;
    }
  }
  await companion.ready('view'); assert.deepEqual(calls.pop(), ['chat:ready', 'view']);
  await companion.ready('view', 0); assert.deepEqual(calls.pop(), ['chat:ready', 'view', 0]);
  await companion.history('view'); assert.deepEqual(calls.pop(), ['chat:history', 'view', 0, 200]);
  for (const [method, name, wire] of [['onEvents', 'events', 'chat:events'], ['onState', 'state', 'chat:state']]) {
    for (const [api, key] of [[desktopChatApi, name], [companion, wire]]) {
      const value = { [method]: true };
      let received;
      assert.equal(api[method]((payload) => { received = payload; }), unsubscribe);
      listeners.get(key)(value);
      assert.equal(received, value);
    }
  }
  assert.equal(chatLink('https://example.invalid/path?q=1#x'), 'https://example.invalid/path?q=1#x');
  for (const url of ['ftp://example.invalid', 'javascript:alert(1)', 'file:///tmp/private', '/relative', 'malformed URL']) assert.equal(chatLink(url), undefined);
  for (const [agentHQ, mac] of [[undefined, false], [{ platform: 'linux' }, false], [{ platform: 'darwin' }, true]]) {
    globalThis.window = { agentHQ };
    assert.deepEqual(loadRenderer('platform.ts'), { isMac: mac, primaryModifier: mac ? '⌘' : 'Ctrl' });
  }
  let activated;
  class Links {
    constructor(activate) { activated = activate; }
  }
  const { enableTerminalLinks } = loadRenderer('terminalLinks.ts', { '@xterm/addon-web-links': { WebLinksAddon: Links } });
  const opened = [], forwarded = [];
  globalThis.window = { open: (...args) => opened.push(args) };
  const terminal = { options: {}, loadAddon(addon) { assert.ok(addon instanceof Links); } };
  for (const forwarding of [undefined, (url) => forwarded.push(url)]) {
    enableTerminalLinks(terminal, forwarding);
    for (const activate of [activated, terminal.options.linkHandler.activate]) {
      for (const url of ['https://example.invalid/path', 'HTTP://example.invalid', 'http://localhost.evil.invalid:80/', 'https://127.0.0.2:8080/']) {
        activate({}, url);
        assert.deepEqual(opened.pop(), [new URL(url).href, '_blank', 'noopener,noreferrer']);
      }
      for (const url of ['http://localhost:3000/path?q=1', 'https://127.0.0.1:5173', 'http://[::1]:8080/#x']) {
        activate({}, url);
        if (forwarding) assert.equal(forwarded.pop(), url);
        else assert.deepEqual(opened.pop(), [new URL(url).href, '_blank', 'noopener,noreferrer']);
      }
      for (const url of ['javascript:alert(1)', 'file:///tmp/private', 'data:text/html,unsafe', 'mailto:qa@example.invalid', 'not a URL']) activate({}, url);
      assert.deepEqual(opened, []); assert.deepEqual(forwarded, []);
    }
  }
  console.log('PASS desktop/companion chat transport contracts and errors, cursor omission/defaults, callback disposal, platform modifiers, OSC8/detected URL activation, safe schemes, and loopback forwarding');
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else delete globalThis.window;
});
