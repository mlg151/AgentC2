const assert = require('node:assert/strict');
const path = require('node:path');
const { compileTypeScript } = require('./fixtures/ts-coverage.cjs');
(async () => {
  const exports = {};
  const bitmap = { width: 20, height: 10, closed: false, close() { this.closed = true; } };
  let context = { drawImage() {} }, data = 'data:image/png;base64,PNGDATA', decoded = 0;
  const canvas = { getContext() { return context; }, toDataURL() { return data; } };
  compileTypeScript(path.resolve(__dirname, '../src/companion/image.ts'), ['exports', 'createImageBitmap', 'document'])(exports, async () => { decoded++; return bitmap; }, { createElement: () => canvas });
  assert.equal(await exports.imagePayload({ type: 'image/jpeg', size: 10 }), 'PNGDATA');
  assert.equal(canvas.width, 20); assert.equal(canvas.height, 10); assert.equal(bitmap.closed, true);
  for (const file of [{ type: 'text/plain', size: 10 }, { type: 'image/png', size: 768 * 1024 + 1 }]) await assert.rejects(exports.imagePayload(file), /image.*768 KB/i);
  assert.equal(decoded, 1);
  context = null; bitmap.closed = false;
  await assert.rejects(exports.imagePayload({ type: 'image/png', size: 10 }), /image conversion/i); assert.equal(bitmap.closed, true);
  context = { drawImage() {} }; data = `data:image/png;base64,${'A'.repeat(12 * 1024 * 1024)}`;
  await assert.rejects(exports.imagePayload({ type: 'image/png', size: 10 }), /768 KB/);
  console.log('PASS phone image validation, JPEG-to-PNG normalization, bounded transfer, and decoder cleanup');
})().catch((error) => { console.error(error); process.exitCode = 1; });
