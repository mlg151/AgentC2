const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { loadCommonJs } = require('./helpers/load-commonjs.cjs');
const { PNG_LIMIT, validatePng, uploadPng } = require('../electron/image-upload.cjs');
const { readClipboardPng } = require('../electron/clipboard-image.cjs');

(async () => {
  const png = fs.readFileSync(path.join(__dirname, '..', 'assets', 'app-icon.png'));
  assert.doesNotThrow(() => validatePng(png));
  assert.throws(() => validatePng(png.subarray(0, -1)), /invalid/);
  assert.throws(() => validatePng(Buffer.alloc(PNG_LIMIT + 1)), /larger than 8 MB/);
  assert.throws(() => uploadPng({ png: Buffer.from('not an image') }), /invalid/);

  let command;
  const transfer = loadCommonJs('electron/image-upload.cjs', {
    './local.cjs': { localCommand: (binary, args) => ({ binary, args, env: { FIXTURE: 'private' } }) },
  });
  const spawnProcess = (binary, args, options) => {
    command = { binary, args, options };
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.stdin.end = (input) => { assert.deepEqual(input, png); queueMicrotask(() => { child.stdout.emit('data', JSON.stringify({ path: '/fixture/.cache/agent-hq/uploads/agentc2-' + 'a'.repeat(32) + '.png', bytes: png.length })); child.emit('close', 0); }); };
    return child;
  };
  for (const local of [false, true]) {
    const uploaded = await transfer.uploadPng({ binary: 'fixture-ssh', args: ['-T'], target: 'fixture-host', local, png, spawnProcess });
    assert.match(uploaded, /agentc2-a{32}\.png$/);
    const program = command.args.at(-1).replace(/^'|'$/g, '');
    const encoded = /base64\.b64decode\("([A-Za-z0-9+/=]+)"\)/.exec(program);
    assert.ok(encoded); assert.equal(Buffer.from(encoded[1], 'base64').toString(), fs.readFileSync(path.join(__dirname, '../electron/image-upload.py'), 'utf8').replaceAll('\r\n', '\n'));
    assert.match(program, /hashlib\.sha256\(source\)\.hexdigest\(\)/);
    assert.equal(command.binary, local ? 'python3' : 'fixture-ssh');
    assert.deepEqual(command.args.slice(0, -1), local ? ['-c'] : ['-T', 'fixture-host', 'python3', '-c']);
  }

  const clipboard = { read: async () => [{ types: ['image/png'], getType: async () => new Blob([png]) }] };
  const nativeImage = { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 512, height: 512 }), toPNG: () => png }) };
  assert.deepEqual(await readClipboardPng(clipboard, nativeImage), png);
  await assert.rejects(readClipboardPng(clipboard, { createFromBuffer: () => ({ isEmpty: () => true }) }), /could not be decoded/);
  await assert.rejects(() => readClipboardPng({ read: async () => [{ types: ['image/png'], getType: async () => ({ size: PNG_LIMIT + 1 }) }] }, nativeImage), /larger than 8 MB/);
  await assert.rejects(() => readClipboardPng(clipboard, { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 10001, height: 1 }) }) }), /dimensions/);
  assert.equal(await readClipboardPng({ read: async () => [{ types: ['text/plain'] }] }, nativeImage), null);
  console.log('PASS bounded image detection, dimensions, and PNG rejection');
})().catch((error) => { console.error(error); process.exitCode = 1; });
