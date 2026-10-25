// A broken SSH transport must not end a live tmux unit or transfer control.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Terminals } = require('../electron/terminals.cjs');

class FakePty extends EventEmitter {
  onData(listener) { this.on('data', listener); }
  onExit(listener) { this.on('exit', listener); }
  write(value) { this.lastWrite = value; }
  resize(cols, rows) { this.size = { cols, rows }; }
  kill() { this.killed = true; this.emit('exit', { exitCode: 0 }); }
  data(value) { this.emit('data', value); }
  exit(code) { this.emit('exit', { exitCode: code }); }
}

(async () => {
  const ptys = [], events = [];
  const terminals = new Terminals({
    spawn: () => { const pty = new FakePty(); ptys.push(pty); return pty; },
    configure: async () => {}, history: async () => ({ text: '', truncated: false }), scroll: async () => {},
    emit: (client, event, value) => events.push({ client, event, value }),
  });
  const desktop = { id: 'desktop', name: 'Desktop' }, phone = { id: 'phone', name: 'Phone' };
  const name = 'hq-123456789abc';
  const desktopHandle = await terminals.open(desktop, name, 'default', 100, 30);
  const phoneHandle = await terminals.open(phone, name, 'default', 100, 30);
  await terminals.ready(desktop, desktopHandle); await terminals.ready(phone, phoneHandle);
  assert.equal(terminals.state(phone, phoneHandle).connection, 'connecting');
  await assert.rejects(terminals.write(desktop, desktopHandle, 'lost before attach'), /connecting/);
  await assert.rejects(terminals.take(phone, phoneHandle), /connecting/);
  ptys[0].data('SSH banner\r\n');
  await terminals.sessions.get(`default/${name}`).queue;
  assert.equal(terminals.state(phone, phoneHandle).connection, 'connecting', 'SSH banner is not tmux readiness');
  ptys[0].data('\x1b[?104');
  await terminals.sessions.get(`default/${name}`).queue;
  assert.equal(terminals.state(phone, phoneHandle).connection, 'connecting');
  ptys[0].data('9hfirst redraw\r\n');
  await terminals.sessions.get(`default/${name}`).queue;
  assert.equal(ptys[0].lastWrite, undefined, 'Rejected startup input must never be queued');
  await terminals.take(phone, phoneHandle);
  assert.equal(terminals.state(desktop, desktopHandle).canControl, false);
  ptys[0].data('before\r\n');
  await terminals.sessions.get(`default/${name}`).queue;
  const initialSequence = terminals.sessions.get(`default/${name}`).sequence;
  ptys[0].exit(255);
  assert.equal(terminals.state(phone, phoneHandle).connection, 'reconnecting');
  assert.equal(terminals.state(phone, phoneHandle).canControl, true);
  await assert.rejects(terminals.write(phone, phoneHandle, 'must not queue'), /reconnecting/);
  await assert.rejects(terminals.take(desktop, desktopHandle), /reconnecting/);
  assert.equal(events.some((item) => item.event === 'terminal:exit'), false);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(ptys.length, 2, 'Reconnect must use one replacement PTY');
  assert.equal(terminals.state(phone, phoneHandle).connection, 'reconnecting');
  ptys[0].data('\x1b[?1049hstale redraw');
  ptys[1].data('Reconnect banner\r\n\x1b[?1h');
  await terminals.sessions.get(`default/${name}`).queue;
  assert.equal(terminals.state(phone, phoneHandle).connection, 'reconnecting');
  ptys[1].data('\x1b=after\r\n');
  await terminals.sessions.get(`default/${name}`).queue;
  assert.equal(terminals.state(phone, phoneHandle).connection, 'connected');
  assert.equal(terminals.state(phone, phoneHandle).canControl, true);
  assert.equal(terminals.state(desktop, desktopHandle).canControl, false);
  assert.equal(terminals.sessions.get(`default/${name}`).sequence, initialSequence + 2);
  await terminals.write(phone, phoneHandle, 'approved after reconnection');
  assert.equal(ptys[1].lastWrite, 'approved after reconnection');
  assert.equal(events.filter((item) => item.event === 'terminal:exit').length, 0);
  ptys[1].exit(255);
  terminals.close(phone, phoneHandle); terminals.close(desktop, desktopHandle);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(ptys.length, 2, 'Detached viewers must cancel reconnect retries');
  assert.equal(terminals.sessions.size, 0);
  const reattached = await terminals.open(phone, name, 'default', 100, 30);
  assert.equal(terminals.state(phone, reattached).connection, 'connecting');
  await assert.rejects(terminals.take(phone, reattached), /connecting/);
  ptys[2].data('\x1b[?1049hretained shell\r\n');
  await terminals.sessions.get(`default/${name}`).queue;
  await terminals.take(phone, reattached);
  await terminals.write(phone, reattached, 'first command after reattach');
  assert.equal(ptys[2].lastWrite, 'first command after reattach');
  terminals.close(phone, reattached);
  const interrupted = await terminals.open(desktop, name, 'default', 100, 30);
  ptys[3].data('\x1b[?1049h');
  ptys[3].exit(255);
  await terminals.sessions.get(`default/${name}`).queue;
  assert.equal(terminals.state(desktop, interrupted).connection, 'reconnecting', 'Queued redraw from an exited PTY must not restore readiness');
  terminals.close(desktop, interrupted);
  console.log('PASS initial attach and reattach reject input until tmux startup, split markers and banners, no replay; SSH drop retains handles, output sequence, dimensions, and phone ownership; input is rejected until redraw; closing all viewers cancels retry');
})().catch((error) => { console.error(error); process.exitCode = 1; });
