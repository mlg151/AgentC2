const assert = require('node:assert/strict');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const { compileTypeScript } = require('./fixtures/ts-coverage.cjs');
(async () => {
  class Socket {
    static OPEN = 1; readyState = 1;
    constructor() { Socket.latest = this; }
    send(data) { this.last = JSON.parse(data); }
    close() {}
  }
  const exports = {};
  compileTypeScript(path.resolve(__dirname, '../src/companion/client.ts'), ['exports', 'WebSocket', 'location', 'crypto'])(exports, Socket, { protocol: 'https:', host: 'phone.test' }, webcrypto);
  const client = new exports.CompanionClient(); client.connect();
  assert.equal(typeof client.setCapabilities, 'function', 'Phone must explain when its desktop needs an upgrade');
  client.setCapabilities();
  await assert.rejects(client.request('settings:save', {}), /Update AgentC2/);
  const pending = client.request('inventory'); Socket.latest.onmessage({ data: JSON.stringify({ id: Socket.latest.last.id, result: [] }) }); assert.deepEqual(await pending, []);
  client.setCapabilities(['settings:save']);
  const saved = client.request('settings:save', {}); Socket.latest.onmessage({ data: JSON.stringify({ id: Socket.latest.last.id, result: { hosts: [] } }) }); assert.deepEqual(await saved, { hosts: [] });
  await assert.rejects(client.request('unsupported'), /Update AgentC2/);
  const first = Socket.latest; client.resume(); assert.equal(Socket.latest, first, 'Foreground does not replace an active socket');
  first.onclose({ code: 4000 }); client.resume(); assert.notEqual(Socket.latest, first, 'Foreground reconnects an offline socket');
  client.close(); const last = Socket.latest; client.resume(); assert.equal(Socket.latest, last, 'Closed clients stay closed');
  console.log('PASS companion retains legacy RPCs and explains desktop upgrades for unsupported new workflows');
})().catch((error) => { console.error(error); process.exitCode = 1; });
