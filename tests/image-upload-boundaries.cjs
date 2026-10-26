const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { loadCommonJs } = require('./helpers/load-commonjs.cjs');
const png = fs.readFileSync(path.resolve(__dirname, '../assets/app-icon.png'));
const timers = new Map();
let nextTimer = 0, child, execution, localCalls = 0;
const spawn = (binary, args, options) => {
  execution = { binary, args, options };
  child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  child.stdin.end = (bytes) => { assert.deepEqual(bytes, png); };
  child.kills = 0; child.kill = () => { child.kills++; };
  return child;
};
const upload = loadCommonJs('electron/image-upload.cjs', {
  'node:child_process': { spawn },
  './local.cjs': { localCommand: (binary, args) => { localCalls++; return { binary, args, env: { FIXTURE: 'local' } }; } },
}, {
  setTimeout: (callback, delay) => { assert.equal(delay, 60000); const id = ++nextTimer; timers.set(id, callback); return id; },
  clearTimeout: (id) => { timers.delete(id); },
});
const start = (extra = {}) => upload.uploadPng({ binary: 'fixture-ssh', args: ['-T'], target: 'fixture-target', png, ...extra });
const result = (extra = {}) => ({ path: '/fixture/.cache/agent-hq/uploads/agentc2-' + 'a'.repeat(32) + '.png', bytes: png.length, ...extra });
const output = (value) => { child.stdout.emit('data', JSON.stringify(value)); child.emit('close', 0); };

(async () => {
  for (const value of [null, 'PNG', Buffer.alloc(44), Buffer.alloc(upload.PNG_LIMIT + 1), Buffer.alloc(45), Buffer.concat([png.subarray(0, -1), Buffer.from([0])])]) assert.throws(() => upload.validatePng(value), /Clipboard PNG/);
  let promise = start();
  assert.equal(execution.binary, 'fixture-ssh'); assert.equal(execution.options.windowsHide, true);
  assert.deepEqual(execution.args.slice(0, 4), ['-T', 'fixture-target', 'python3', '-c']);
  child.stdin.emit('error', Error('Fixture broken pipe'));
  output(result()); assert.equal(await promise, result().path); assert.equal(timers.size, 0);
  // A close/error race must never settle a successful upload twice.
  child.emit('error', Error('Late fixture error')); child.emit('close', 1);

  promise = start({ local: true }); output(result()); assert.equal(await promise, result().path);
  assert.equal(localCalls, 1); assert.equal(execution.binary, 'python3'); assert.deepEqual(execution.options.env, { FIXTURE: 'local' });
  promise = start({ spawnProcess: spawn }); child.emit('error', Error('Fixture spawn failed')); await assert.rejects(promise, /spawn failed/); assert.equal(timers.size, 0);
  await assert.rejects(start({ spawnProcess: () => { throw Error('Fixture synchronous spawn failure'); } }), /synchronous spawn failure/);

  for (const message of ['', '  Fixture remote failure  ', 'x'.repeat(600)]) {
    promise = start(); if (message) child.stderr.emit('data', message); child.emit('close', 2);
    await assert.rejects(promise, (error) => { assert.equal(error.message, message.trim().slice(0, 500) || 'Image upload failed'); return true; });
  }
  for (const field of ['stdout', 'stderr']) {
    promise = start(); child[field].emit('data', 'x'.repeat(4096)); assert.equal(child.kills, 0);
    child[field].emit('data', 'x'); assert.equal(child.kills, 1); child.emit('close', 1); await assert.rejects(promise);
  }
  for (const value of [null, {}, { path: 4, bytes: png.length }, result({ bytes: png.length - 1 }), result({ path: '/tmp/untrusted.png' })]) {
    promise = start(); output(value); await assert.rejects(promise, /Invalid remote upload result/);
  }
  promise = start(); child.stdout.emit('data', '{'); child.emit('close', 0); await assert.rejects(promise, SyntaxError);
  promise = start(); assert.equal(timers.size, 1); [...timers.values()][0]();
  assert.equal(child.kills, 1); await assert.rejects(promise, /timed out/); assert.equal(timers.size, 0);
  child.emit('close', 0);
  console.log('PASS bounded PNG validation, local/SSH transfer selection, default/injected spawn, broken pipes, spawn/close races, bounded diagnostics, output limits, invalid receipts, timeout, and timer cleanup');
})().catch((error) => { console.error(error); process.exitCode = 1; });
