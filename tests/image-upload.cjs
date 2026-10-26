const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PNG_LIMIT, validatePng, uploadPng } = require('../electron/image-upload.cjs');
const { readClipboardPng } = require('../electron/clipboard-image.cjs');

(async () => {
  const png = fs.readFileSync(path.join(__dirname, '..', 'assets', 'app-icon.png'));
  assert.doesNotThrow(() => validatePng(png));
  assert.throws(() => validatePng(png.subarray(0, -1)), /invalid/);
  assert.throws(() => validatePng(Buffer.alloc(PNG_LIMIT + 1)), /larger than 8 MB/);
  assert.throws(() => uploadPng({ png: Buffer.from('not an image') }), /invalid/);

  const clipboard = { read: async () => [{ types: ['image/png'], getType: async () => new Blob([png]) }] };
  const nativeImage = { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 512, height: 512 }), toPNG: () => png }) };
  assert.deepEqual(await readClipboardPng(clipboard, nativeImage), png);
  await assert.rejects(readClipboardPng(clipboard, { createFromBuffer: () => ({ isEmpty: () => true }) }), /could not be decoded/);
  await assert.rejects(() => readClipboardPng({ read: async () => [{ types: ['image/png'], getType: async () => ({ size: PNG_LIMIT + 1 }) }] }, nativeImage), /larger than 8 MB/);
  await assert.rejects(() => readClipboardPng(clipboard, { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 10001, height: 1 }) }) }), /dimensions/);
  assert.equal(await readClipboardPng({ read: async () => [{ types: ['text/plain'] }] }, nativeImage), null);
  console.log('PASS bounded image detection, dimensions, and PNG rejection');
})().catch((error) => { console.error(error); process.exitCode = 1; });
