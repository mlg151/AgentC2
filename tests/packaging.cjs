const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { packageNative } = require('../scripts/package-native.cjs');

// Inspect the actual child environment and electron-builder's certificate lookup,
// without requiring certificates, a keychain, or a macOS machine.
for (const ref of ['refs/heads/main', 'refs/tags/v0.4.1', 'refs/pull/5/merge']) {
  const source = {
    ...process.env, GITHUB_REF: ref, GITHUB_BASE_REF: ref.includes('/pull/') ? 'main' : '',
    CSC_LINK: '', CSC_KEY_PASSWORD: '', APPLE_ID: '', APPLE_APP_SPECIFIC_PASSWORD: '', APPLE_TEAM_ID: '',
  };
  const calls = [];
  const result = packageNative(['--mac', '--arm64', '--publish', 'never'], source, (file, args, options) => {
    calls.push(args);
    const child = spawnSync(file, ['-e', `
      const assert = require('node:assert/strict');
      require('app-builder-lib');
      const { PlatformPackager } = require('app-builder-lib/out/platformPackager');
      const packager = { info: { config: {} }, platformSpecificBuildOptions: {} };
      assert.equal(PlatformPackager.prototype.getCscLink.call(packager), undefined);
      for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
        assert.equal(Object.hasOwn(process.env, key), false, key + ' must be absent');
      }
    `], { env: options.env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    return { status: 0 };
  });
  assert.equal(result, 0);
  assert.deepEqual(calls[0].slice(1), ['--mac', '--arm64', '--publish', 'never']);
  assert.ok(calls[1][0].endsWith('record-package.cjs'));
  assert.equal(source.CSC_LINK, '', 'Do not mutate the caller environment');
}

const signed = { ...process.env, CSC_LINK: 'certificate-fixture.p12', CSC_KEY_PASSWORD: '   ', APPLE_ID: 'qa@example.invalid', APPLE_APP_SPECIFIC_PASSWORD: 'fixture-token', APPLE_TEAM_ID: 'FIXTURE' };
assert.equal(packageNative(['--mac'], signed, (_file, _args, options) => {
  assert.deepEqual(options.env, signed, 'Preserve configured signing and notarization');
  return { status: 0 };
}), 0);
let calls = 0;
assert.equal(packageNative(['--mac'], signed, () => { calls++; return { status: 7 }; }), 7);
assert.equal(calls, 1, 'Do not report a failed build as a successful package');
console.log('PASS unsigned main/tag/PR packaging environments, optional signing preservation, and build failure propagation');

const { default: FpmTarget } = require('app-builder-lib/out/targets/FpmTarget');
const dependencies = require('../package.json').build.deb.depends;
for (const requirement of [...FpmTarget.prototype.getDefaultDepends('deb'), 'tmux', 'python3 (>= 3.10)', 'openssh-client']) {
  assert.ok(dependencies.includes(requirement), `Debian package must require ${requirement}`);
}
console.log('PASS Debian local-session requirements preserve Electron runtime dependencies');
