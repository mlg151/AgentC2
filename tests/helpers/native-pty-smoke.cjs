const { randomBytes } = require('node:crypto');
const { Terminal } = require('@xterm/headless');

async function nativePtySmoke(pty, { platform, env, cwd, timeoutMs = 15000 }) {
  const token = randomBytes(6).toString('hex');
  const ready = `NATIVE_READY_${token}`, marker = `NATIVE_DONE_${token}`;
  const windows = platform === 'win32';
  const screen = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const terminal = pty.spawn(windows ? (env.ComSpec || 'C:\\Windows\\System32\\cmd.exe') : '/bin/sh',
    windows ? ['/d', '/q', '/k', `echo ${ready}`] : ['-c', `printf '${ready}\\n'; exec /bin/sh -i`],
    { name: 'xterm-256color', cols: 80, rows: 24, cwd, env });
  let stage = 'shell readiness', output = '', finished = false, exited = false, replies = 0;
  const subscriptions = [];
  try {
    return await new Promise((resolve, reject) => {
      const finish = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (error) reject(new Error(`${error}; stage=${stage}; output=${JSON.stringify(output)}`));
        else resolve({ output: true, replies });
      };
      const timeout = setTimeout(() => finish('Native PTY smoke timed out'), timeoutMs);
      // A real terminal answers VT queries. Ignoring these can stall ConPTY.
      subscriptions.push(screen.onData((data) => { if (!finished) { replies++; terminal.write(data); } }));
      subscriptions.push(terminal.onData((data) => {
        output = (output + data).slice(-4000);
        screen.write(data, () => {
          if (finished) return;
          const lines = Array.from({ length: screen.buffer.active.length }, (_, index) => screen.buffer.active.getLine(index).translateToString(true));
          if (stage === 'shell readiness' && lines.includes(ready)) {
            stage = 'command output';
            screen.resize(100, 32);
            terminal.resize(100, 32);
            terminal.write(`echo ${marker}\r`);
          } else if (stage === 'command output' && lines.includes(marker)) {
            stage = 'shell exit';
            terminal.write('exit\r');
          }
        });
      }));
      subscriptions.push(terminal.onExit(({ exitCode }) => {
        exited = true;
        finish(exitCode === 0 && stage === 'shell exit' ? null : `Native PTY exited unexpectedly (${exitCode})`);
      }));
    });
  } finally {
    for (const subscription of subscriptions) subscription.dispose();
    screen.dispose();
    // On timeout/failure the child may still be waiting for input.
    if (!exited) { try { terminal.kill(); } catch { /* It may already have exited. */ } }
  }
}

module.exports = { nativePtySmoke };
