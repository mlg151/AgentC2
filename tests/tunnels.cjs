const assert = require('node:assert/strict');
const { Tunnels, parseDevUrl, detectedUrls } = require('../electron/tunnels.cjs');

assert.equal(parseDevUrl('http://localhost:80/path?q=1').port, 80);
assert.equal(parseDevUrl('https://[::1]:8443/path').hostname, '[::1]');
assert.equal(detectedUrls('\x1b[32mReady: http://127.0.0.1:5173/a?q=1\x1b[0m')[0].href, 'http://127.0.0.1:5173/a?q=1');
for (const value of ['http://example.com:3000', 'http://192.168.1.1:3000', 'http://localhost', 'file:///tmp', 'http://user@localhost:3000', 'http://localhost:70000']) assert.throws(() => parseDevUrl(value));
assert.deepEqual(detectedUrls('The docs are at https://example.com and 127.0.0.1:3000'), []);
const tunnels = new Tunnels({ binary: 'ssh', argsForHost: () => [], onUpdate: () => {} });
const host = { id: 'fixture', enabled: true, autoForward: false };
tunnels.feed(host, 'fixture/tmux:one', 'Ready at http://localhost:5173/pre');
assert.deepEqual(tunnels.list('fixture/tmux:one'), []);
tunnels.feed(host, 'fixture/tmux:one', 'view?q=1\n');
assert.equal(tunnels.list('fixture/tmux:one')[0].url, 'http://localhost:5173/preview?q=1');
assert.equal(tunnels.key('fixture', parseDevUrl('http://localhost:5173')), tunnels.key('fixture', parseDevUrl('http://127.0.0.1:5173')));
tunnels.closeAll();
console.log('PASS bounded loopback URL parsing and destination rejection');
