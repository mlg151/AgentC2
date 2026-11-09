const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter, once } = require('node:events');
const { WebSocket } = require('ws');
const platform = require('../electron/platform.cjs');
const originalStatus = platform.tailscaleStatus;
platform.tailscaleStatus = () => ({ installed: true, fixture: true });
const { Gateway } = require('../electron/gateway.cjs');
platform.tailscaleStatus = originalStatus;
const { PreviewGateway } = require('../electron/companion-preview.cjs');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-gateway-parity-'));
  const events = new EventEmitter(), calls = [];
  const upstream = http.createServer((_, res) => res.end('preview target'));
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const target = `http://127.0.0.1:${upstream.address().port}/`;
  const service = {
    events, store: { data: { settings: {}, workspace: { metadata: {} }, attention: [] } },
    terminals: { disconnect: (id) => calls.push(['disconnect', id]) }, chats: { disconnect() {} },
    create: async (input, requirePreset) => { calls.push(['create', input, requirePreset]); return {name:'hq-parity'}; },
    saveSettings: async (input) => { calls.push(['settings', input]); return input; },
    openDevUrl: async (client, id, url) => { calls.push(['devurl', client, id, url]); return target; },
  };
  const gateways = [];
  const create = () => {
    const gateway = new Gateway({ directory: path.join(directory, String(gateways.length)), assets: '', service, secure: false });
    gateway.data.devices = [{ id: 'phone', expiresAt: Date.now() + 60000 }];
    gateway.data.url = 'https://desktop.ts.net';
    gateway.data.port = 0;
    gateways.push(gateway); return gateway;
  };
  try {
    const gateway = create();
    assert.deepEqual(gateway.tailscale(), { installed: true, fixture: true });
    const ws = new EventEmitter(); ws.readyState = WebSocket.OPEN;
    const messages = []; ws.send = (raw) => messages.push(JSON.parse(raw)); ws.close = () => ws.emit('close'); ws.terminate = ws.close;
    gateway.connect(ws, gateway.data.devices[0]);
    const record = [...gateway.sockets.values()][0];
    assert.equal(record.client.admin, true); assert.match(record.client.id, /^web:/);
    assert.ok(messages[0].value.capabilities.includes('settings:save'));
    events.emit('session:pinned', 'session', true);
    events.emit('sessions:deleted', ['old']);
    events.emit('tunnel:updated', { sessionKey: 'session', urls: [] });
    assert.deepEqual(messages.slice(-3), [{event:'session:pinned',value:{key:'session',pinned:true}}, {event:'sessions:deleted',value:['old']}, {event:'tunnel:updated',value:{sessionKey:'session',urls:[]}}]);
    events.emit('remote:updated', { enabled:true });
    assert.deepEqual(messages.at(-1), {event:'remote:updated',value:{enabled:true}});
    assert.deepEqual(await gateway.rpc(record, {id:'launch',method:'create',args:[{provider:'codex'}]}), {name:'hq-parity'});
    assert.deepEqual(calls.find(([name]) => name === 'create'), ['create',{provider:'codex'},false]);
    assert.deepEqual(await gateway.rpc(record, { id: 'read', method: 'state:get', args: [] }), gateway.bootstrap());
    assert.deepEqual(await gateway.rpc(record, { id: 'save', method: 'settings:save', args: [{theme:'dark'}] }), {theme:'dark'});
    assert.deepEqual(await gateway.rpc(record, { id: 'save', method: 'settings:save', args: [{theme:'dark'}] }), {theme:'dark'});
    assert.equal(calls.filter(([name]) => name === 'settings').length, 1, 'Admin writes must deduplicate per device/request');
    const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation,'listening'); gateway.data.port = reservation.address().port - 1; await new Promise((resolve) => reservation.close(resolve));
    const link = await gateway.previewUrl(record, 'terminal', target);
    assert.equal(new URL(link).origin, 'https://desktop.ts.net:8443');
    assert.deepEqual(calls.find(([name]) => name === 'devurl'), ['devurl', record.client, 'terminal', target]);
    const instance = gateway.preview;
    await gateway.previewUrl(record, 'terminal', target); assert.equal(gateway.preview, instance);
    assert.equal(instance.deviceActive('phone'), true);
    assert.equal(instance.deviceActive('unknown'), false);
    gateway.data.devices[0].expiresAt = Date.now() - 1; assert.equal(instance.deviceActive('phone'), false);
    gateway.data.devices[0].expiresAt = Date.now() + 60000;
    record.client.closed = true;
    await assert.rejects(gateway.previewUrl(record, 'terminal', target), /Device revoked/);
    record.client.closed = false; gateway.data.devices = [];
    await assert.rejects(gateway.previewUrl(record, 'terminal', target), /Device revoked/);
    await gateway.dispose();
    assert.equal(events.listenerCount('session:pinned'), 0);
    assert.equal(events.listenerCount('sessions:deleted'), 0);
    assert.equal(events.listenerCount('tunnel:updated'), 0);
    assert.equal(events.listenerCount('remote:updated'), 0);

    // Changing remote access from this device closes its own transport, with an
    // explicit state event still reaching the desktop before it reconnects.
    const admin = create(); const administrativeUpdates = [];
    const observe = (status) => administrativeUpdates.push(status);
    events.on('remote:updated', observe);
    const adminWs = new EventEmitter(); adminWs.readyState=WebSocket.OPEN; adminWs.send=()=>{}; adminWs.close=()=>adminWs.emit('close'); adminWs.terminate=adminWs.close;
    admin.connect(adminWs,admin.data.devices[0]);
    const adminRecord=[...admin.sockets.values()][0];
    await admin.rpc(adminRecord,{id:'remote-change',method:'remote:save',args:[{enabled:false,port:43127,url:'https://desktop.ts.net'}]});
    assert.equal(adminRecord.client.closed,true); assert.equal(admin.sockets.size,0);
    assert.equal(administrativeUpdates.at(-1).enabled,false);
    const revokeWs = new EventEmitter(); revokeWs.readyState=WebSocket.OPEN; revokeWs.send=()=>{}; revokeWs.close=()=>revokeWs.emit('close'); revokeWs.terminate=revokeWs.close;
    admin.connect(revokeWs,admin.data.devices[0]);
    const revokeRecord=[...admin.sockets.values()][0];
    await admin.rpc(revokeRecord,{id:'revoke-self',method:'remote:revoke',args:['phone']});
    assert.equal(revokeRecord.client.closed,true); assert.deepEqual(administrativeUpdates.at(-1).devices,[]);
    events.off('remote:updated',observe); await admin.dispose();

    const edge = create(); edge.data.port = 65535; edge.data.url = 'https://desktop.ts.net:8443';
    const start = PreviewGateway.prototype.start;
    PreviewGateway.prototype.start = async function() { assert.equal(this.port,65533); };
    try {
      const edgeLink = await edge.previewUrl({client:{id:'web:edge'},device:{id:'phone'}},'terminal',target);
      assert.equal(new URL(edgeLink).origin,'https://desktop.ts.net:9443');
    } finally { PreviewGateway.prototype.start = start; await edge.dispose(); }

    const coexist = create(); coexist.data.port = upstream.address().port - 1;
    await coexist.previewUrl({client:{id:'web:coexist'},device:{id:'phone'}},'terminal',target);
    assert.equal(coexist.preview.port, upstream.address().port + 1, 'Preview must coexist with the listener at gateway+1 used by desktop sync');
    await coexist.dispose();

    const blocked = create(); blocked.data.port = upstream.address().port - 2;
    const failedStart = blocked.previewUrl({client:{id:'web:blocked'},device:{id:'phone'}},'terminal',target);
    const failedAssertion = assert.rejects(failedStart,/Preview endpoint unavailable:.*Tailscale Serve endpoint/);
    await Promise.resolve();
    await blocked.stop();
    await failedAssertion;
    assert.equal(blocked.previewFlight,null);
    console.log('PASS companion capability discovery, scoped admin writes/events, validated previews, listener reuse, startup failures and cleanup');
  } finally {
    for (const gateway of gateways) await gateway.dispose();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(directory, {recursive:true,force:true});
  }
})().catch((error) => { console.error(error); process.exitCode=1; });
