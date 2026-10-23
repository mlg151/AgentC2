// Isolated transport and protocol fixture; no provider credentials or model calls.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
async function poll(check, label, attempts = 300) {
  for (let i = 0; i < attempts; i++) { const result = await check(); if (result) return result; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error(label);
}
async function isolatedChatSsh(directory) {
  const home = path.join(directory, 'home'), bin = path.join(directory, 'bin'), remoteBin = path.join(directory, 'remote-bin');
  for (const folder of [home, bin, remoteBin]) fs.mkdirSync(folder, { mode: 0o700 });
  const script = (name, body) => fs.writeFileSync(name, '#!/bin/sh\n' + body + '\n', { mode: 0o700 });
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const key = path.join(directory, 'client-key'), hostKey = path.join(directory, 'host-key');
  for (const file of [key, hostKey]) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file]);
  const knownHosts = path.join(directory, 'known-hosts');
  fs.writeFileSync(knownHosts, `[127.0.0.1]:${port} ${fs.readFileSync(hostKey + '.pub', 'utf8')}`);
  const tmuxSocket = path.join(directory, 'tmux.sock');
  script(path.join(remoteBin, 'tmux'), `exec /usr/bin/tmux -S ${quote(tmuxSocket)} "$@"`);
  fs.copyFileSync(path.join(__dirname, 'codex-app-server.py'), path.join(remoteBin, 'codex'));
  fs.chmodSync(path.join(remoteBin, 'codex'), 0o700);
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ centcom: true }));
  const force = path.join(directory, 'remote-command');
  script(force, `export HOME=${quote(home)}\nexport PATH=${quote(remoteBin + ':/usr/local/bin:/usr/bin:/bin')}\nexport AGENTC2_CODEX_FIXTURE_DIR=${quote(home)}\nexec /bin/bash -c "$SSH_ORIGINAL_COMMAND"`);
  const config = path.join(directory, 'sshd_config');
  fs.writeFileSync(config, `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${hostKey}\nPidFile ${directory}/sshd.pid\nAuthorizedKeysFile ${key}.pub\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nAllowUsers ${os.userInfo().username}\nForceCommand ${force}\n`);
  const log = fs.openSync(path.join(directory, 'sshd.log'), 'w');
  const daemon = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', config], { stdio: ['ignore', 'ignore', log] });
  fs.closeSync(log);
  try {
    await poll(async () => {
      if (daemon.exitCode !== null) throw new Error(fs.readFileSync(path.join(directory, 'sshd.log'), 'utf8'));
      return new Promise((resolve) => { const socket = net.connect(port, '127.0.0.1'); socket.on('connect', () => { socket.destroy(); resolve(true); }); socket.on('error', () => resolve(false)); });
    }, 'Isolated sshd unavailable');
  } catch (error) { daemon.kill(); throw error; }
  script(path.join(bin, 'ssh'), `exec /usr/bin/ssh -i ${quote(key)} -o IdentitiesOnly=yes -o UserKnownHostsFile=${quote(knownHosts)} "$@"`);
  const host = { id: 'default', name: 'CENTCOM isolated SSH', target: os.userInfo().username + '@127.0.0.1', port, enabled: true };
  return { home, host, env: { ...process.env, PATH: bin + ':' + process.env.PATH },
    close() {
      // Query only this fixture's private socket to identify its worker.
      const socket = path.join(home, '.cache/agentc2/chat-v1/worker.sock');
      if (fs.existsSync(socket)) {
        try {
          const pid = Number(execFileSync('python3', ['-c', 'import json,socket,sys\ns=socket.socket(socket.AF_UNIX);s.settimeout(3);s.connect(sys.argv[1]);s.sendall(b\'{"protocolVersion":1,"action":"health"}\\n\');print(json.loads(s.makefile().readline())["result"]["pid"])', socket], { encoding: 'utf8', timeout: 5000 }));
          if (pid > 1) process.kill(pid, 'SIGTERM');
        } catch { /* The fixture worker may already have exited. */ }
      }
      try { execFileSync('/usr/bin/tmux', ['-S', tmuxSocket, 'kill-server'], { stdio: 'ignore' }); } catch { /* No remaining fixture sessions. */ }
      daemon.kill();
    } };
}
module.exports = { isolatedChatSsh, poll };
