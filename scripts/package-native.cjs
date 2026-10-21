const { spawnSync } = require('node:child_process');
const path = require('node:path');

function signingEnvironment(source) {
  const env = { ...source };
  // On macOS an empty CSC_LINK is a supplied certificate path, resolved to cwd.
  // Missing Actions secrets must be absent, including on non-PR builds.
  for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
    if (env[key] === '') delete env[key];
  }
  return env;
}

function packageNative(args, source = process.env, execute = spawnSync) {
  const options = { env: signingEnvironment(source), stdio: 'inherit' };
  for (const command of [
    [require.resolve('electron-builder/cli.js'), ...args],
    [path.join(__dirname, 'record-package.cjs')],
  ]) {
    const result = execute(process.execPath, command, options);
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status || 1;
  }
  return 0;
}

if (require.main === module) process.exitCode = packageNative(process.argv.slice(2));
module.exports = { signingEnvironment, packageNative };
