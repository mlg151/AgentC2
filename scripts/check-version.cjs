const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function checkVersion(ref = process.env.GITHUB_REF || '') {
  const root = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, pkg.version, 'Lockfile version must match package.json');
  assert.equal(lock.packages[''].version, pkg.version, 'Lockfile root version must match package.json');
  if (ref.startsWith('refs/tags/')) assert.equal(ref, `refs/tags/v${pkg.version}`, 'Release tag must be v followed by the exact package.json version');
  return pkg.version;
}

if (require.main === module) console.log(`Version verified: ${checkVersion()}`);
module.exports = { checkVersion };
