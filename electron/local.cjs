const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

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

// Resolve through the same default distribution as the helper. Do not assume
// /mnt/<drive>: WSL automount roots can be configured by the user.
async function localPayload(payload, { platform = process.platform, env = process.env, execute = execFile } = {}) {
  if (platform !== 'win32') return payload;
  const result = { ...payload };
  for (const key of ['cwd', 'repository']) {
    const value = payload[key];
    if (typeof value !== 'string' || !/^[a-z]:[\\/]/i.test(value)) continue;
    if (value.includes('\0')) throw new Error('Local paths cannot contain null characters');
    const execution = localCommand('wslpath', ['-a', '-u', value], platform, env);
    result[key] = await new Promise((resolve, reject) => {
      execute(execution.binary, execution.args, { windowsHide: true, env: execution.env, timeout: 10000, maxBuffer: 65536 }, (error, stdout) => {
        const converted = typeof stdout === 'string' ? stdout.replace(/\r?\n$/, '') : '';
        if (error || !converted.startsWith('/') || /[\0\r\n]/.test(converted)) {
          reject(new Error(`Could not resolve local ${key} in WSL. Check that the default WSL distribution is running and the Windows drive is mounted.`, { cause: error }));
        } else resolve(converted);
      });
    });
  }
  return result;
}

module.exports = { localCommand, connectionKey, localPayload };
