const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { nativePtySmoke } = require('./helpers/native-pty-smoke.cjs');

function fixture(timeoutMs = 1000) {
  const events = new EventEmitter();
  const writes = [], sizes = [];
  let data, exit, ready, killed = false;
  const terminal = {
    onData: (listener) => { data = listener; return { dispose() {} }; },
    onExit: (listener) => { exit = listener; return { dispose() {} }; },
    write: (value) => { writes.push(value); events.emit('write', value); },
    resize: (...size) => sizes.push(size),
    kill: () => { killed = true; },
  };
  const result = nativePtySmoke({ spawn: (_file, args) => {
    ready = args.join(' ').match(/NATIVE_READY_[a-f0-9]+/)[0];
    return terminal;
  } }, { platform: 'win32', cwd: '.', env: {}, timeoutMs });
  return { events, writes, sizes, result, get ready() { return ready; }, get killed() { return killed; }, data: (value) => data(value), exit: (code) => exit({ exitCode: code }) };
}

async function query(pty) {
  const reply = once(pty.events, 'write');
  pty.data('\x1b[6n');
  assert.match((await reply)[0], /^\x1b\[\d+;\d+R$/, 'Answer the cursor query before shell readiness');
}

(async () => {
  for (const exitCode of [0, 7]) {
    const pty = fixture();
    const outcome = exitCode ? assert.rejects(pty.result, /unexpectedly \(7\)/) : pty.result;
    assert.deepEqual(pty.writes, [], 'Do not send commands before the shell is ready');
    assert.deepEqual(pty.sizes, [], 'Do not queue a resize before readiness');
    await query(pty);
    pty.data(pty.ready.slice(0, 10));
    await query(pty); // Parser barrier: partial markers and VT queries are not readiness.
    assert.equal(pty.writes.length, 2);
    const command = once(pty.events, 'write');
    pty.data(pty.ready.slice(10) + '\r\n');
    const input = (await command)[0];
    const marker = input.match(/NATIVE_DONE_[a-f0-9]+/)[0];
    assert.deepEqual(pty.sizes, [[100, 32]]);
    pty.data('> ' + input + '\r\n');
    await query(pty);
    assert.ok(!pty.writes.includes('exit\r'), 'An echoed command is not proof it executed');
    const exiting = once(pty.events, 'write');
    pty.data(marker.slice(0, 9));
    pty.data(marker.slice(9) + '\r\n');
    assert.equal((await exiting)[0], 'exit\r', 'Exit only after actual command output');
    pty.exit(exitCode);
    await outcome;
    assert.equal(pty.killed, false, 'Do not kill an already exited child');
  }
  const early = fixture();
  const rejected = assert.rejects(early.result, /unexpectedly \(0\).*stage=shell readiness/);
  early.exit(0);
  await rejected;
  const stalled = fixture(50);
  stalled.data('fixture startup output');
  await assert.rejects(stalled.result, /timed out.*stage=shell readiness.*fixture startup output/);
  assert.equal(stalled.killed, true, 'Clean up a stalled native process');
  console.log('PASS PTY readiness, VT query replies, fragmented output, echoed-input rejection, exit status, timeout diagnostics, and cleanup');
})().catch((error) => { console.error(error); process.exitCode = 1; });
