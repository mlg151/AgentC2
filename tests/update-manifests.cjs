const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');
const { prepareUpdateManifests } = require('../scripts/update-manifests.cjs');
const { MacUpdater } = require('electron-updater');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-update-manifests-'));
try {
  const manifests = {};
  for (const [manifest, assets] of [
    ['latest.yml', ['AgentC2-0.4.2-win-x64-setup.exe']],
    ['latest-linux.yml', ['AgentC2-0.4.2-linux-x86_64.AppImage', 'AgentC2-0.4.2-linux-amd64.deb']],
    ['latest-mac-x64.yml', ['AgentC2-0.4.2-mac-x64.zip', 'AgentC2-0.4.2-mac-x64.dmg']],
    ['latest-mac-arm64.yml', ['AgentC2-0.4.2-mac-arm64.zip', 'AgentC2-0.4.2-mac-arm64.dmg']],
  ]) {
    const files = assets.map((name) => {
      const contents = Buffer.from(name);
      fs.writeFileSync(path.join(directory, name), contents);
      return { url: name, size: contents.length, sha512: crypto.createHash('sha512').update(contents).digest('base64') };
    });
    manifests[manifest] = { version: '0.4.2', files, path: files[0].url, sha512: files[0].sha512 };
    fs.writeFileSync(path.join(directory, manifest), yaml.dump(manifests[manifest]));
  }
  prepareUpdateManifests(directory, '0.4.2');
  const mac = yaml.load(fs.readFileSync(path.join(directory, 'latest-mac.yml'), 'utf8'));
  assert.equal(mac.files.length, 4);
  const files = mac.files.map((info) => ({ info, url: new URL(info.url, 'https://example.invalid/') }));
  for (const arm of [false, true]) {
    const chosen = MacUpdater.filterFilesForArch(files, arm);
    assert.equal(chosen.length, 2);
    assert.ok(chosen.every((item) => item.info.url.includes(arm ? 'arm64' : 'x64')));
  }
  assert.throws(() => prepareUpdateManifests(directory, '0.4.3'), /version differs/);
  fs.writeFileSync(path.join(directory, 'AgentC2-0.4.2-win-x64-setup.exe'), 'corrupted download');
  assert.throws(() => prepareUpdateManifests(directory, '0.4.2'), /checksum mismatch/);
  console.log('PASS release metadata checksums, version matching, merged Mac feeds, and native updater architecture selection');
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
