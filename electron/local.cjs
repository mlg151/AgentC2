const path = require('node:path');
const os = require('node:os');

// Local hosts run the same private helper/worker and tmux lifecycle as SSH
// hosts, without requiring an SSH server or changing host-key policy.
function localCommand(command, args, platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    return { binary: path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe'), args: ['--exec', command, ...args], env };
  }
  const home = env.HOME || os.homedir();
  const extra = [path.posix.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return { binary: command, args, env: { ...env, PATH: [...new Set([...(env.PATH || '').split(':'), ...extra])].filter(Boolean).join(':') } };
}

function connectionKey(host) {
  return host.kind === 'local' ? 'local' : `ssh/${host.target}/${host.port}`;
}

module.exports = { localCommand, connectionKey };
