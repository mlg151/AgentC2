const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const { packagePath } = require('./package-path.cjs');
const { version } = require('../package.json');

const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
const executable = packagePath();
assert.ok(fs.existsSync(executable), 'Packaged executable is missing');
let signed = false, notarized = false;
if (process.platform === 'darwin') {
  const bundle = path.resolve(executable, '..', '..', '..');
  const result = spawnSync('codesign', ['-dv', '--verbose=4', bundle], { encoding: 'utf8' });
  signed = result.status === 0 && /Authority=Developer ID Application:/.test(result.stderr);
  if (signed) execFileSync('codesign', ['--verify', '--deep', '--strict', bundle]);
  if (process.env.APPLE_ID) {
    assert.ok(signed, 'Notarization requires a Developer ID signed application');
    execFileSync('xcrun', ['stapler', 'validate', bundle]);
    notarized = true;
  }
} else if (process.platform === 'win32') {
  const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-AuthenticodeSignature -LiteralPath $env:AGENTC2_VERIFY_PATH).Status.ToString()'], { env: { ...process.env, AGENTC2_VERIFY_PATH: executable }, encoding: 'utf8' });
  signed = result.trim() === 'Valid';
}
if (process.env.CSC_LINK) assert.ok(signed, 'Signing credentials were supplied but the packaged application signature did not validate');
const description = [
  `AgentC2 ${version} ${platform}/${process.arch}`,
  `Publisher signature: ${signed ? 'verified' : 'absent (unsigned or ad hoc)'}`,
  `Apple notarization: ${notarized ? 'stapled ticket verified' : 'not verified / not applicable'}`,
  'Unsigned builds may be blocked by SmartScreen or Gatekeeper. See docs/platforms.md.',
].join('\n') + '\n';
fs.writeFileSync(path.join(__dirname, '..', 'release', `AgentC2-${version}-${platform}-${process.arch}-signing.txt`), description);
console.log(description);
