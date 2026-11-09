const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { checkVersion } = require('../scripts/check-version.cjs');
const version = require('../package.json').version;
assert.equal(checkVersion('refs/heads/main'), version);
assert.equal(checkVersion(`refs/tags/v${version}`), version);
assert.throws(() => checkVersion('refs/tags/v0.0.0'), /exact package.json version/);
const run = (script, args, extra = {}) => spawnSync(process.execPath, [path.resolve(__dirname, `../scripts/${script}.cjs`), ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_REF: '', ...extra } });
assert.equal(run('check-version', []).status, 0);
assert.equal(run('check-version', [], { GITHUB_REF: `refs/tags/v${version}` }).status, 0);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-release-coverage-'));
try {
  assert.notEqual(run('prepare-release', [directory]).status, 0);
  const required = [
    `AgentC2-${version}-android.apk`,
    `AgentC2-${version}-android-signing.txt`,
    `AgentC2-${version}-win-x64-setup.exe`,
    `AgentC2-${version}-linux-x86_64.AppImage`,
    `AgentC2-${version.replace('-', '~')}-linux-amd64.deb`,
    ...['x64', 'arm64'].flatMap((arch) => ['dmg', 'zip'].map((extension) => `AgentC2-${version}-mac-${arch}.${extension}`)),
    ...['win-x64', 'linux-x64', 'mac-x64', 'mac-arm64'].map((target) => `AgentC2-${version}-${target}-signing.txt`),
  ];
  for (const file of required) fs.writeFileSync(path.join(directory, file), `fixture ${file}\n`);
  const yaml = require('js-yaml');
  for (const [name, asset] of [['latest.yml', required.find((f) => f.endsWith('.exe'))], ['latest-linux.yml', required.find((f) => f.endsWith('.AppImage'))], ...['x64', 'arm64'].map((arch) => [`latest-mac-${arch}.yml`, `AgentC2-${version}-mac-${arch}.zip`])]) {
    const data = fs.readFileSync(path.join(directory, asset));
    fs.writeFileSync(path.join(directory, name), yaml.dump({ version, files: [{ url: asset, sha512: crypto.createHash('sha512').update(data).digest('base64'), size: data.length }] }));
  }
  fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), 'old checksums');
  const result = run('prepare-release', [directory]);
  assert.equal(result.status, 0, result.stderr);
  const sums = fs.readFileSync(path.join(directory, 'SHA256SUMS.txt'), 'utf8');
  const expected = fs.readdirSync(directory).filter((file) => file !== 'SHA256SUMS.txt').sort().map((file) => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('hex')}  ${file}`).join('\n') + '\n';
  assert.equal(sums, expected);
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
console.log('PASS version/tag agreement, missing release artifacts, and deterministic complete checksums');
