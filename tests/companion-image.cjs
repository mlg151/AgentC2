const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createService } = require('../electron/service.cjs');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-image-'));
  const service = createService({ directory, home: os.homedir() });
  try {
    assert.equal(typeof service.uploadCompanionImage, 'function');
    for (const value of [null, '', 'not base64!', 'A'.repeat(1048577)]) await assert.rejects(async () => service.uploadCompanionImage({}, 'handle', value), /PNG/);
    await assert.rejects(async () => service.uploadCompanionImage({}, 'handle', Buffer.from('not png').toString('base64')), /PNG|invalid/);
    await service.saveSettings({ ...service.store.data.settings, hosts: [{ id: 'local', kind: 'local', name: 'Local fixture', enabled: true }] });
    const client = { id: 'web:fixture' }, record = { hostId: 'local' };
    let owner = true;
    service.terminals.get = () => ({ record });
    service.terminals.assertOwner = () => { if (!owner) throw new Error('Take control first'); };
    const png = fs.readFileSync(path.join(__dirname, '../assets/app-icon.png'));
    const result = await service.uploadCompanionImage(client, 'handle', png.toString('base64'));
    try { assert.deepEqual(fs.readFileSync(result), png); } finally { fs.unlinkSync(result); }
    owner = false;
    await assert.rejects(service.uploadCompanionImage(client, 'handle', png.toString('base64')), /Take control/);
    console.log('PASS bounded companion image transfer, PNG verification, local upload, and ownership enforcement');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
