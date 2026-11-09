// A broken SSH transport must not end a live tmux unit or transfer control.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Terminals } = require('../electron/terminals.cjs');
const { commanderFacade } = require('../electron/commander.cjs');

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
  // Real Windows ConPTY consumes smcup/smkx and redraws the screen itself.
  // Its output still contains tmux's secondary device-attributes query, sent
  // by tty_send_requests only after tty_start_tty has entered raw mode.
  for (const platform of ['win32', 'linux', 'darwin']) {
    for (const query of ['\x1b[>c', '\x1b[>0c']) {
      for (let split = 1; split < query.length; split++) {
        const windowsPtys = [];
        const windows = new Terminals({
          platform,
          spawn: () => { const pty = new FakePty(); windowsPtys.push(pty); return pty; },
          configure: async () => {}, history: async () => ({}), scroll: async () => {}, emit: () => {},
        });
        const client = { id: 'desktop', name: 'Desktop' };
        const id = await windows.open(client, 'hq-0123456789ab', 'windows', 100, 30);
        const record = windows.get(client, id).record;
        try {
          await windows.ready(client, id);
          windowsPtys[0].data('\x1b[2J\x1b[m\x1b[H\x1b]0;ssh.exe\x07\x1b[?25hSSH banner\r\n');
          await record.queue;
          assert.equal(windows.state(client, id).connection, 'connecting', 'ConPTY setup and SSH banners are not attachment');
          await assert.rejects(windows.write(client, id, 'never replay'), /connecting/);
          windowsPtys[0].data(query.slice(0, split));
          await record.queue;
          assert.equal(windows.state(client, id).connection, 'connecting', 'A partial query is not readiness');
          windowsPtys[0].data(query.slice(split) + '\x1b[>q\x1b[HLoaded CLI');
          await record.queue;
          assert.equal(windowsPtys[0].lastWrite, undefined);
          assert.equal(windows.state(client, id).connection, platform === 'win32' ? 'connected' : 'connecting', `${platform}: ConPTY-translated tmux startup must enable Windows input`);
          if (platform !== 'win32') {
            windowsPtys[0].data('\x1b[?1h');
            await record.queue;
            assert.equal(windows.state(client, id).connection, 'connecting');
            windowsPtys[0].data('\x1b=');
            await record.queue;
          }
          await windows.write(client, id, 'first command\r');
          assert.equal(windowsPtys[0].lastWrite, 'first command\r');
        } finally { windows.closeAll(); }
      }
    }
  }
  const ptys = [], events = [];
  const terminals = new Terminals({
    platform: 'win32',
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
  ptys[0].data('\x1b[>cstale redraw');
  ptys[1].data('Reconnect banner\r\n\x1b[>');
  await terminals.sessions.get(`default/${name}`).queue;
  assert.equal(terminals.state(phone, phoneHandle).connection, 'reconnecting');
  ptys[1].data('cafter\r\n');
  await terminals.sessions.get(`default/${name}`).queue;
  assert.equal(terminals.state(phone, phoneHandle).connection, 'connected');
  assert.equal(terminals.state(phone, phoneHandle).canControl, true);
  assert.equal(terminals.state(desktop, desktopHandle).canControl, false);
  assert.equal(terminals.sessions.get(`default/${name}`).sequence, initialSequence + 2);
  await terminals.write(phone, phoneHandle, 'approved after reconnection');
  await assert.rejects(terminals.write(phone, phoneHandle, 'must not fall back', { confirmed: true }), /Acknowledged terminal input is unavailable/);
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
  ptys[3].data('\x1b[>c');
  ptys[3].exit(255);
  await terminals.sessions.get(`default/${name}`).queue;
  assert.equal(terminals.state(desktop, interrupted).connection, 'reconnecting', 'Queued redraw from an exited PTY must not restore readiness');
  terminals.close(desktop, interrupted);
  const commander = { id: 'centcom-commander', name: 'CENTCOM' };
  const facade = commanderFacade({ terminals });
  let acknowledge, delivered;
  const acknowledgement = new Promise((resolve) => { acknowledge = resolve; });
  terminals.confirmInput = async (_record, data, guard) => {
    guard();
    await acknowledgement;
    guard();
    delivered = data;
  };
  const dispatch = facade.commanderControl(commander, { key: `default/tmux:${name}`, id: name, hostId: 'default' }, async (id) => {
    assert.equal(terminals.state(commander, id).connection, 'connected');
    await facade.terminalInput(commander, id, 'reviewed command');
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(ptys[4].lastWrite, undefined, 'Commander must not dispatch before tty startup');
  ptys[4].data('\x1b[?1049h');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(terminals.sessions.size, 1, 'Do not tear down the temporary view while input is unacknowledged');
  assert.equal(ptys[4].lastWrite, undefined, 'Confirmed sends must not use a locally buffered PTY write');
  acknowledge();
  await dispatch;
  assert.equal(delivered, 'reviewed command\r');
  assert.equal(terminals.sessions.size, 0, 'Commander must release its private attachment');
  const stalled = await terminals.open(desktop, name, 'default', 100, 30);
  await assert.rejects(terminals.waitForConnection(desktop, stalled, 20), /timed out/);
  const disconnected = terminals.waitForConnection(desktop, stalled);
  terminals.close(desktop, stalled);
  await assert.rejects(disconnected, /disconnected/);
  console.log('PASS initial attach and reattach reject input until tmux startup, split markers and banners, no replay; SSH drop retains handles, output sequence, dimensions, and phone ownership; input is rejected until redraw; closing all viewers cancels retry');
})().catch((error) => { console.error(error); process.exitCode = 1; });
