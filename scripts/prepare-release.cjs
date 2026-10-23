const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { checkVersion } = require('./check-version.cjs');
const { prepareUpdateManifests } = require('./update-manifests.cjs');

const version = checkVersion();
const directory = path.resolve(process.argv[2] || 'release-assets');
const required = [
  `AgentC2-${version}-win-x64-setup.exe`,
  `AgentC2-${version}-linux-x86_64.AppImage`,
  `AgentC2-${version.replace('-', '~')}-linux-amd64.deb`,
  ...['x64', 'arm64'].flatMap((arch) => ['dmg', 'zip'].map((extension) => `AgentC2-${version}-mac-${arch}.${extension}`)),
  ...['win-x64', 'linux-x64', 'mac-x64', 'mac-arm64'].map((target) => `AgentC2-${version}-${target}-signing.txt`),
];
for (const file of required) assert.ok(fs.existsSync(path.join(directory, file)), `Release asset missing: ${file}`);
prepareUpdateManifests(directory, version);
const files = fs.readdirSync(directory).filter((file) => file !== 'SHA256SUMS.txt').sort();
const sums = files.map((file) => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('hex')}  ${file}`);
fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
console.log(`Verified ${required.length} required release assets and generated SHA256SUMS.txt`);
