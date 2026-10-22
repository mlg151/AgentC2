// Local test transport for the real production origin/cookie checks.
// It never logs pairing links, cookies, or device secrets.
const { WebSocket } = require('ws');
async function companionProxy(context, origin, port, errors) {
  const sockets = new Set();
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(`phone: ${error.message}`));
  await page.route(origin + '/**', async (route) => {
    try {
      const request = route.request(), target = new URL(request.url());
      const response = await route.fetch({ url: `http://127.0.0.1:${port}${target.pathname}${target.search}`, headers: { ...request.headers(), host: new URL(origin).host, ...(request.method() !== 'GET' ? { origin } : {}) } });
      await route.fulfill({ response });
    } catch { await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Gateway offline"}' }).catch(() => {}); }
  });
  await page.routeWebSocket(origin.replace('https:', 'wss:') + '/**', async (socket) => {
    const cookies = await context.cookies(origin);
    const proxy = new WebSocket(`ws://127.0.0.1:${port}/api/v1/socket`, { headers: { host: new URL(origin).host, origin, cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') } });
    sockets.add(proxy);
    const pending = [];
    socket.onMessage((data) => { if (proxy.readyState === WebSocket.OPEN) proxy.send(data); else pending.push(data); });
    proxy.on('open', () => { for (const data of pending) proxy.send(data); });
    proxy.on('message', (data) => socket.send(data.toString()));
    proxy.on('error', () => socket.close({ code: 1011, reason: 'Proxy unavailable' }));
    proxy.on('close', (code, reason) => { sockets.delete(proxy); socket.close({ code: code === 1006 ? 1011 : code, reason: reason.toString() }); });
    socket.onClose(() => { proxy.close(); sockets.delete(proxy); });
  });
  return { page, disconnect: () => { for (const socket of sockets) socket.terminate(); }, close: async () => { for (const socket of sockets) socket.terminate(); await page.close(); } };
}
module.exports = { companionProxy };
