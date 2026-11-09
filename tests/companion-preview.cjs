const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { WebSocket, WebSocketServer } = require('ws');
const { PreviewGateway } = require('../electron/companion-preview.cjs');

(async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/redirect-relative') { res.writeHead(302, { Location: '/next?ok=1#hash' }); res.end(); return; }
    if (req.url === '/redirect-external') { res.writeHead(302, { Location: 'https://attacker.invalid/' }); res.end(); return; }
    if (req.url === '/hang') return;
    if (req.url === '/fail') { req.socket.destroy(); return; }
    res.setHeader('Set-Cookie', 'upstream=unsafe');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(JSON.stringify({ path: req.url, headers: req.headers }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const wss = new WebSocketServer({ server: upstream, handleProtocols: (protocols) => [...protocols].at(-1) });
  wss.on('connection', (socket) => socket.on('message', (message) => socket.send(message.toString())));
  const target = `http://127.0.0.1:${upstream.address().port}/page?x=1`;
  const active = new Set(['phone']);
  const preview = new PreviewGateway({ port: 0, origin: 'http://preview.ts.net:8443', deviceActive: (id) => active.has(id), secure: false, requestTimeout: 30, revalidationInterval: 10 });
  assert.equal(new PreviewGateway({ requestTimeout: 25 }).requestTimeout, 25);
  try {
    await preview.start();
    const base = `http://127.0.0.1:${preview.server.address().port}`;
    const headers = { Host: 'preview.ts.net:8443' };
    const request = async (route, extra = {}) => {
      return new Promise((resolve, reject) => {
        const request = http.get(base + route, { headers: { ...headers, ...extra } }, (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, String(value)])) })));
        });
        request.on('error', reject);
      });
    };
    assert.equal((await request('/')).status, 401);
    assert.equal((await request('/', { Host: 'wrong' })).status, 403);
    assert.equal((await request('/', { 'Tailscale-Funnel-Request': '?1' })).status, 403);
    for (const url of ['http://example.com:3000', 'file:///etc/passwd', 'http://user:secret@localhost:3000', 'http://127.0.0.1']) assert.throws(() => preview.issue('phone', url), /loopback/);
    const expired = { expiresAt: Date.now() - 1 };
    preview.handoffs.set('expired', expired); preview.sessions.set('expired', expired);
    const link = preview.issue('phone', target);
    assert.equal(preview.handoffs.has('expired'), false); assert.equal(preview.sessions.has('expired'), false);
    for (let i = 0; i < 100; i++) preview.handoffs.set(String(i), { expiresAt: Date.now() + 1000 });
    assert.throws(() => preview.issue('phone', target), /Too many/);
    for (let i = 0; i < 100; i++) preview.handoffs.delete(String(i));
    for (let i = 0; i < 100; i++) preview.sessions.set(String(i), { expiresAt: Date.now() + 1000 });
    assert.throws(() => preview.issue('phone', target), /Too many/);
    preview.sessions.clear();
    assert.equal(new URL(link).origin, 'http://preview.ts.net:8443');
    const handoff = new URL(link).pathname;
    const response = await request(handoff);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/page?x=1');
    const cookie = response.headers.get('set-cookie').split(';')[0];
    assert.ok(response.headers.get('set-cookie').includes('HttpOnly'));
    assert.equal((await request(handoff)).status, 401);
    const authHeaders = { Cookie: cookie };
    assert.equal((await request('/redirect-relative', authHeaders)).headers.get('location'), '/next?ok=1#hash');
    assert.equal((await request('/redirect-external', authHeaders)).status, 502);
    assert.equal((await request('/hang', authHeaders)).status, 502);
    assert.equal((await request('/fail', authHeaders)).status, 502);
    assert.equal((await request('//attacker.invalid/secret', authHeaders)).status, 403);
    assert.equal((await request('/', { ...authHeaders, Origin: 'https://attacker.invalid' })).status, 403);
    assert.throws(() => preview.authenticate({ headers: {host:'wrong'} }), /Invalid/);
    assert.throws(() => preview.authenticate({ headers: {host:headers.Host, 'tailscale-funnel-request':'yes'} }), /Invalid/);
    const securePreview = new PreviewGateway({ port: 0, origin: preview.origin, deviceActive: () => true });
    const secureRoute = new URL(securePreview.issue('phone', target)).pathname;
    let secureHeaders; securePreview.handle({ headers: {host:headers.Host}, url:secureRoute }, { setHeader(){}, writeHead(status, headers){ assert.equal(status,303); secureHeaders=headers; }, end(){} });
    assert.match(secureHeaders['Set-Cookie'], /; Secure/);
    await securePreview.close();
    const page = await request('/asset.js?ok=1', { Cookie: cookie + '; __Host-agenthq=SECRET', Authorization: 'Bearer SECRET', Origin: 'http://preview.ts.net:8443' });
    const data = await page.json();
    assert.equal(data.path, '/asset.js?ok=1');
    assert.equal(data.headers.cookie, undefined);
    assert.equal(data.headers.authorization, undefined);
    assert.equal(data.headers.origin, new URL(target).origin);
    assert.equal(page.headers.get('set-cookie'), null);
    assert.equal(page.headers.get('access-control-allow-origin'), null);
    assert.equal((await request('/api/v1/socket', { Cookie: cookie })).status, 403);
    const ws = new WebSocket(base.replace('http', 'ws') + '/socket', { headers: { ...headers, Cookie: cookie, Origin: 'http://preview.ts.net:8443' } });
    await once(ws, 'open'); ws.send('preview echo');
    assert.equal((await once(ws, 'message'))[0].toString(), 'preview echo');
    ws.close(); await once(ws, 'close');
    const hmr = new WebSocket(base.replace('http', 'ws') + '/socket', ['ignored', 'vite-hmr'], { headers: { ...headers, Cookie: cookie, Origin: preview.origin } });
    await once(hmr, 'open');
    assert.equal(hmr.protocol, 'vite-hmr', 'Preserve the upstream-negotiated subprotocol');
    hmr.send('hmr update');
    assert.equal((await once(hmr, 'message'))[0].toString(), 'hmr update');
    hmr.close(); await once(hmr, 'close');
    const denied = async (route, extra) => {
      const socket = new WebSocket(base.replace('http','ws') + route, {headers:{...headers, Cookie:cookie, Origin:preview.origin, ...extra}});
      const error = await new Promise((resolve) => socket.on('error',resolve));
      assert.match(error.message,/401/);
      await new Promise((resolve) => socket.readyState === WebSocket.CLOSED ? resolve() : socket.on('close',resolve));
    };
    await denied('/socket',{Cookie:''}); await denied('/socket',{Origin:'https://attacker.invalid'}); await denied('//attacker.invalid',{});
    const revocable = new WebSocket(base.replace('http','ws')+'/socket',{headers:{...headers,Cookie:cookie,Origin:preview.origin}});
    await once(revocable,'open');
    const expiryConnection = [...preview.connections][0];
    expiryConnection.expiresAt=Date.now()-1;
    await once(revocable,'close');
    const revoked = new WebSocket(base.replace('http','ws')+'/socket',{headers:{...headers,Cookie:cookie,Origin:preview.origin}});
    await once(revoked,'open');
    active.clear();
    await once(revoked,'close');
    assert.equal((await request('/', { Cookie: cookie })).status, 401);
    active.add('phone');
    // A loopback TLS endpoint without a trusted certificate must fail closed for HTTP and WS.
    const tlsServer = require('node:https').createServer();
    tlsServer.listen(0, '127.0.0.1'); await once(tlsServer, 'listening');
    try {
      const tlsHandoff = new URL(preview.issue('phone', `https://127.0.0.1:${tlsServer.address().port}/`)).pathname;
      const tlsResponse = await request(tlsHandoff);
      const tlsCookie = tlsResponse.headers.get('set-cookie').split(';')[0];
      assert.equal((await request('/', { Cookie: tlsCookie })).status, 502);
      const tlsSocket = new WebSocket(base.replace('http','ws')+'/socket', {headers:{...headers, Cookie:tlsCookie, Origin:preview.origin}});
      assert.match((await new Promise((resolve) => tlsSocket.on('error',resolve))).message, /socket hang up/);
      await new Promise((resolve) => tlsSocket.readyState === WebSocket.CLOSED ? resolve() : tlsSocket.on('close',resolve));
    } finally { await new Promise((resolve) => tlsServer.close(resolve)); }
    const pending = new WebSocket(base.replace('http','ws')+'/socket',{headers:{...headers,Cookie:cookie,Origin:preview.origin}});
    await once(pending,'open');
    await preview.close(); await once(pending,'close');

    console.log('PASS isolated preview handoff, scoped authentication/revocation, credential stripping, HTTP/assets and WebSocket forwarding');
  } finally { await preview.close(); wss.close(); await new Promise((resolve) => upstream.close(resolve)); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
