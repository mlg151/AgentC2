const path = require('node:path');
const { execFile } = require('node:child_process');
const os = require('node:os');

function appDataDirectory(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return env.APPDATA || path.join(home, 'AppData', 'Roaming');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  return env.XDG_CONFIG_HOME || path.join(home, '.config');
}

function sshBinary(platform = process.platform, env = process.env) {
  if (platform === 'win32') return path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
  // Finder launches do not inherit an interactive shell's PATH.
  return platform === 'darwin' ? '/usr/bin/ssh' : 'ssh';
}

function tailscaleBinaries(platform = process.platform, env = process.env) {
  if (platform === 'win32') return [path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe')];
  if (platform === 'darwin') return ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale', 'tailscale'];
  return ['tailscale', '/usr/bin/tailscale', '/usr/local/bin/tailscale'];
}

async function tailscaleStatus({ platform = process.platform, env = process.env, execute = execFile } = {}) {
  for (const binary of tailscaleBinaries(platform, env)) {
    const { error, stdout } = await new Promise((resolve) => {
      execute(binary, ['status', '--json'], { windowsHide: true, timeout: 8000, maxBuffer: 2_000_000, env: { ...env, TAILSCALE_BE_CLI: '1' } }, (error, stdout) => resolve({ error, stdout }));
    });
    if (error?.code === 'ENOENT') continue;
    try {
      const status = JSON.parse(stdout);
      return { installed: true, state: status.BackendState || 'Unavailable', url: status.Self?.DNSName ? `https://${status.Self.DNSName.replace(/\.$/, '')}` : '', error: error ? 'Tailscale needs attention' : '' };
    } catch {
      return { installed: true, state: 'Unavailable', url: '', error: 'Start Tailscale and sign in on your computer and phone.' };
    }
  }
  return { installed: false, state: 'Unavailable', url: '', error: 'Install Tailscale and sign in on your computer and phone.' };
}

function closeAction({ platform = process.platform, quitting, remoteEnabled, hasTray }) {
  if (quitting || !remoteEnabled) return 'close';
  // Linux has no reliable API for detecting a visible StatusNotifier host.
  // Keep a taskbar entry even if constructing a Tray succeeds invisibly.
  return platform === 'linux' || (!hasTray && platform !== 'darwin') ? 'minimize' : 'hide';
}

module.exports = { appDataDirectory, sshBinary, tailscaleBinaries, tailscaleStatus, closeAction };
