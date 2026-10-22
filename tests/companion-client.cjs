const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const crypto = require('node:crypto').webcrypto;

(async () => {
  class Socket {
    static OPEN = 1;
    readyState = 1;
    constructor() { Socket.latest = this; }
    send() {}
    close() {}
  }
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/companion/client.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function('exports', 'WebSocket', 'location', 'crypto', code)(exports, Socket, { protocol: 'https:', host: 'fixture.invalid' }, crypto);
  const client = new exports.CompanionClient();
  let revoked = false;
  client.on('revoked', () => { revoked = true; });
  client.connect();
  const pending = client.request('inventory');
  Socket.latest.onclose({ code: 4001 });
  await assert.rejects(pending, /This device was revoked\. Pair again from desktop\./);
  assert.equal(revoked, true);
  client.close();
  console.log('PASS revocation preserves its actionable message when pending requests reject after the revoked event');
})().catch((error) => { console.error(error); process.exitCode = 1; });
