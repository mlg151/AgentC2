const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { loadCommonJs } = require('./helpers/load-commonjs.cjs');

function fixture(host = 'fixture-host', env) {
  const timers = new Map(), writes = [], launches = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  child.stdin.write = (value) => writes.push(value);
  let killed = 0;
  child.kill = () => { killed++; };
  const { TmuxControl } = loadCommonJs('electron/tmux-control.cjs', { 'node:child_process': { spawn: (...args) => { launches.push(args); return child; } } }, {
    setTimeout: (run, delay) => { const timer = {}; timers.set(timer, { run, delay }); return timer; },
    clearTimeout: (timer) => timers.delete(timer),
  });
  const client = new TmuxControl('fixture-ssh', ['-o', 'BatchMode=yes'], host, 'hq-fixture', env);
  const data = (value) => child.stdout.emit('data', Buffer.from(value));
  const attach = async () => { data('%begin 1\n%end 1\n'); await client.ready; };
  const expire = (delay) => { const timer = [...timers.values()].find((entry) => entry.delay === delay); assert.ok(timer, `Missing timer ${delay}`); timer.run(); };
  return { client, child, timers, writes, launches, data, attach, expire, killed: () => killed };
}

async function main() {
  const input = fixture();
  let guarded = 0, delivered = false;
  const text = 'x'.repeat(4095) + 'é☃\r';
  const delivery = input.client.sendInput(text, () => { guarded++; }).then(() => { delivered = true; });
  await Promise.resolve(); assert.equal(input.writes.length, 0);
  await input.attach(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(input.writes.length, 1); assert.equal(delivered, false);
  input.data('%begin 2\n%end 2\n'); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(input.writes.length, 2); assert.equal(delivered, false, 'Local stdin writes are not remote acknowledgements');
  input.data('%begin 3\n%end 3\n'); await delivery;
  const bytes = input.writes.flatMap((line) => {
    assert.ok(line.startsWith('send-keys -H '), 'Input targets the attached session without resolving its name again');
    return line.trim().slice('send-keys -H '.length).split(' ').map((hex) => parseInt(hex, 16));
  });
  assert.equal(Buffer.from(bytes).toString('utf8'), text); assert.equal(guarded, 2);
  await assert.rejects(input.client.sendInput(null, () => {}), /exceeds/);
  await assert.rejects(input.client.sendInput('x'.repeat(1000001), () => {}), /exceeds/);
  await input.client.sendInput('', () => {});
  await assert.rejects(input.client.sendInput('blocked', () => { throw Error('Owner changed'); }), (error) => error.message === 'Owner changed' && !error.uncertain);
  input.client.close();
  await assert.rejects(input.client.sendInput('closed', () => {}), (error) => /closed/.test(error.message) && !error.uncertain);
  const lost = fixture(); await lost.attach();
  const uncertain = assert.rejects(lost.client.sendInput('single submission\r', () => {}), (error) => error.uncertain === true);
  await new Promise((resolve) => setImmediate(resolve)); lost.child.emit('close'); await uncertain;
  assert.equal(lost.writes.length, 1, 'Lost acknowledgement never replays terminal input');
  const revoked = fixture(); await revoked.attach(); let checks = 0;
  const stopped = assert.rejects(revoked.client.sendInput('x'.repeat(4097), () => { if (++checks === 2) throw Error('Controller disconnected'); }), (error) => error.uncertain === true && /disconnected/.test(error.message));
  await new Promise((resolve) => setImmediate(resolve)); revoked.data('%begin 2\n%end 2\n'); await stopped;
  assert.equal(revoked.writes.length, 1, 'A revoked controller cannot send the remaining input'); revoked.client.close();

  const env = { PATH: '/fixture' };
  const f = fixture('fixture-host', env);
  assert.deepEqual(f.launches, [['fixture-ssh', ['-o', 'BatchMode=yes', 'fixture-host', 'tmux', '-C', 'attach-session', '-f', 'no-output,ignore-size', '-t', 'hq-fixture'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env }]]);
  f.data('%window-add ignored\n%begin 1\r');
  assert.equal(f.timers.size, 1, 'Partial control frames must not settle readiness');
  f.data('\n%end 1\r\n'); await f.client.ready;
  assert.equal(f.timers.size, 0);
  const first = f.client.command('display-message first'), second = f.client.command('display-message second');
  const secondRejected = assert.rejects(second, /fixture rejected/);
  await Promise.resolve();
  assert.deepEqual(f.writes, ['display-message first\n', 'display-message second\n']);
  f.data('unframed output\n%begin 2\none\n%output ignored\ntwo\n%end 2\n%begin 3\nfixture rejected\n%error 3\n%end stray\n%begin empty\n%end empty\n');
  assert.equal(await first, 'one\ntwo'); await secondRejected;
  const empty = f.client.command('invalid-command');
  const emptyRejected = assert.rejects(empty, /tmux history command failed/);
  await Promise.resolve(); f.data('%begin 4\n%error 4\n'); await emptyRejected;
  assert.equal(f.timers.size, 0);
  f.client.close(); f.client.close();
  assert.equal(f.killed(), 1);
  await assert.rejects(f.client.command('after-close'), /control connection is closed/);

  const local = fixture(null);
  assert.deepEqual(local.launches[0][1], ['-o', 'BatchMode=yes', '-C', 'attach-session', '-f', 'no-output,ignore-size', '-t', 'hq-fixture']);
  assert.equal(local.launches[0][2].env, process.env);
  const attachFailed = assert.rejects(local.client.ready, /Could not attach tmux control client/);
  local.data('%begin 1\n%error 1\n'); await attachFailed;

  for (const [source, expected] of [['timeout', 'tmux control connection timed out'], ['process', 'process failed'], ['stdin', 'stdin failed'], ['exit', 'tmux control connection ended'], ['close', 'tmux control connection closed'], ['stderr', 'bounded diagnostic']]) {
    const f = fixture();
    const failed = assert.rejects(f.client.ready, (error) => error.message === expected);
    if (source === 'timeout') f.expire(15000);
    else if (source === 'process') f.child.emit('error', new Error(expected));
    else if (source === 'stdin') f.child.stdin.emit('error', new Error(expected));
    else if (source === 'exit') f.data('%exit fixture\n');
    else {
      if (source === 'stderr') { f.child.stderr.emit('data', Buffer.from('discarded'.repeat(1000))); f.child.stderr.emit('data', Buffer.from(' '.repeat(4000) + expected + '\n')); }
      f.child.emit('close');
    }
    await failed;
    assert.equal(f.killed(), 1); assert.equal(f.timers.size, 0);
  }
  const pending = fixture(); await pending.attach();
  const active = pending.client.command('active'), waiting = pending.client.command('queued');
  const rejected = Promise.all([active, waiting].map((promise) => assert.rejects(promise, /tmux history command timed out/)));
  await Promise.resolve(); pending.data('%begin 2\n'); pending.expire(10000); await rejected;
  pending.child.emit('close');
  assert.equal(pending.killed(), 1); assert.equal(pending.timers.size, 0);
  console.log('PASS SSH/local control invocation, split/CRLF framing, FIFO commands, notification filtering, history errors, every connection failure, startup/history deadlines, pending rejection, and idempotent teardown');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
