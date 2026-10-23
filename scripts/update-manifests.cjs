const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');

function prepareUpdateManifests(directory, version) {
  const names = ['latest.yml', 'latest-linux.yml', 'latest-mac-x64.yml', 'latest-mac-arm64.yml'];
  const manifests = names.map((name) => {
    const manifest = yaml.load(fs.readFileSync(path.join(directory, name), 'utf8'));
    assert.equal(manifest.version, version, `${name}: update version differs from release`);
    assert.ok(Array.isArray(manifest.files) && manifest.files.length, `${name}: no update files`);
    for (const file of manifest.files) {
      assert.ok(typeof file.url === 'string' && path.basename(file.url) === file.url && !/[\\/]/.test(file.url), 'Update files must be local release assets');
      const contents = fs.readFileSync(path.join(directory, file.url));
      assert.equal(crypto.createHash('sha512').update(contents).digest('base64'), file.sha512, `${file.url}: update checksum mismatch`);
      if (file.size !== undefined) assert.equal(contents.length, file.size, `${file.url}: update size mismatch`);
    }
    return manifest;
  });
  for (const [index, arch] of [[2, 'x64'], [3, 'arm64']]) {
    assert.ok(manifests[index].files.some((file) => file.url.endsWith(`-mac-${arch}.zip`)), `Missing ${arch} Mac update ZIP`);
  }
  const mac = { ...manifests[2], files: [...manifests[2].files, ...manifests[3].files] };
  fs.writeFileSync(path.join(directory, 'latest-mac.yml'), yaml.dump(mac));
}
module.exports = { prepareUpdateManifests };
