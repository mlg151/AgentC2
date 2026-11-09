const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compileTypeScript } = require('./fixtures/ts-coverage.cjs');
const file = path.resolve(__dirname, '../src/companion/clipboard.ts');
assert.ok(fs.existsSync(file), 'Private HTTP phones need clipboard controls that do not assume secure-context APIs');
(async () => {
  let copied, pasted = 'manual text', commandResult = true, removed = false;
  const navigator = {}, exports = {};
  const input = { style: {}, select() {}, remove() { removed = true; } };
  const document = { createElement: () => input, body: { append() {} }, execCommand: () => commandResult };
  compileTypeScript(file, ['exports', 'navigator', 'window', 'document'])(exports, navigator, { prompt: () => pasted }, document);
  assert.equal(await exports.readPhoneClipboard(), 'manual text'); pasted = null; assert.equal(await exports.readPhoneClipboard(), '');
  await exports.writePhoneClipboard('fallback'); assert.equal(input.value, 'fallback'); assert.equal(removed, true);
  commandResult = false; removed = false; await assert.rejects(exports.writePhoneClipboard('select manually'), /Copy/); assert.equal(removed, true);
  navigator.clipboard = { readText: async () => 'system text', writeText: async (value) => { copied = value; } };
  assert.equal(await exports.readPhoneClipboard(), 'system text'); await exports.writePhoneClipboard('system copy'); assert.equal(copied, 'system copy');
  console.log('PASS local clipboard APIs and private HTTP manual-paste/copy fallback');
})().catch((error) => { console.error(error); process.exitCode = 1; });
