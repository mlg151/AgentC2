const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Use only on disposable Actions runners');
const directory = path.join(os.homedir(), '.ssh');
const key = path.join(directory, 'agentc2-qa-key');
const hosts = path.join(directory, 'agentc2-qa-known-hosts');
const config = path.join(directory, 'config');
const backup = path.join(process.env.RUNNER_TEMP, 'agentc2-qa-ssh-config.json');
if (process.argv.includes('--clean')) {
  fs.rmSync(key, { force: true }); fs.rmSync(hosts, { force: true });
  if (fs.existsSync(backup)) {
    const original = JSON.parse(fs.readFileSync(backup, 'utf8'));
    if (original === null) fs.rmSync(config, { force: true });
    else fs.writeFileSync(config, original, { mode: 0o600 });
    fs.rmSync(backup);
  }
} else {
  const { QA_SSH_TARGET: target, QA_SSH_PRIVATE_KEY: privateKey, QA_SSH_KNOWN_HOSTS: knownHosts } = process.env;
  assert.ok(target && /^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+$/.test(target), 'Set AGENTC2_QA_TARGET to user@host (port 22) in the ssh-qa environment');
  assert.ok(privateKey && knownHosts, 'Set both QA SSH secrets in the ssh-qa environment');
  const [user, host] = target.split('@');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assert.ok(!fs.existsSync(backup), 'QA SSH configuration is already installed');
  fs.writeFileSync(backup, JSON.stringify(fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : null), { mode: 0o600 });
  fs.writeFileSync(key, privateKey.replace(/\r\n/g, '\n').trim() + '\n', { mode: 0o600 });
  fs.writeFileSync(hosts, knownHosts.trim() + '\n', { mode: 0o600 });
  // Prefix the entry so existing wildcard settings cannot override its identity.
  const original = JSON.parse(fs.readFileSync(backup, 'utf8')) || '';
  fs.writeFileSync(config, `Host agentc2-live-qa\n  HostName ${host}\n  User ${user}\n  IdentityFile "${key.replaceAll('\\', '/')}"\n  IdentitiesOnly yes\n  UserKnownHostsFile "${hosts.replaceAll('\\', '/')}"\n  StrictHostKeyChecking yes\n\n${original}`, { mode: 0o600 });
}
