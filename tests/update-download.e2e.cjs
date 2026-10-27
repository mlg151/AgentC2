// Real electron-updater transport/checksum/cache with a disposable local feed.
// The final native installer call is intercepted; this never replaces the user's app.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { _electron } = require('playwright-core');
const { Store } = require('../electron/config.cjs');
(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-update-download-'));
  const payload = Buffer.alloc(128 * 1024, 42);
  const sha512 = crypto.createHash('sha512').update(payload).digest('base64');
  let app, corrupt = true, downloads = 0;
  const server = http.createServer((request, response) => {
    if (request.url.split('?')[0].endsWith('.yml')) {
      response.end(JSON.stringify({ version: '99.0.0', releaseDate: '2026-01-01T00:00:00.000Z', files: ['exe', 'AppImage', 'deb', 'zip'].map((ext) => ({ url: `fixture.${ext}`, size: payload.length, sha512 })) }));
    } else {
      downloads++;
      response.writeHead(200, { 'Content-Length': payload.length });
      response.end(corrupt ? Buffer.alloc(payload.length, 43) : payload);
    }
  });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const feed = `http://127.0.0.1:${server.address().port}`;
    const store = new Store(directory);
    store.save('settings', { ...store.data.settings, hosts: [{ id: 'default', name: 'Offline', target: '127.0.0.1', port: 1, enabled: true }] });
    app = await _electron.launch({ args: ['.', `--user-data-dir=${path.join(directory, 'browser')}`], env: { ...process.env, NODE_ENV: 'production', AGENTC2_DATA_DIR: directory }, timeout: 60000 });
    await app.firstWindow();
    const initial = await app.evaluate(async ({ app }, { directory, feed }) => {
      const require = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/package.json');
      const fs = require('node:fs'), path = require('node:path');
      const library = require('electron-updater');
      const { createUpdates } = require('./electron/updates.cjs');
      const config = path.join(directory, 'feed.yml');
      fs.writeFileSync(config, JSON.stringify({ provider: 'generic', url: feed, updaterCacheDirName: path.basename(directory) }));
      app.setPath('cache', directory);
      const native = new (process.platform === 'win32' ? library.NsisUpdater : process.platform === 'darwin' ? library.MacUpdater : library.AppImageUpdater)();
      native.updateConfigPath = config;
      native.forceDevUpdateConfig = true;
      native.disableDifferentialDownload = true;
      native.disableWebInstaller = true;
      native.logger = null;
      if (process.platform === 'linux') {
        process.env.APPIMAGE = path.join(directory, 'current.AppImage');
        fs.writeFileSync(process.env.APPIMAGE, 'old fixture');
      }
      const controller = createUpdates({ updater: native, version: app.getVersion() });
      globalThis.updateFixture = { native, controller, installs: 0 };
      native.quitAndInstall = (silent, restart) => { if (silent !== false || restart !== true) throw new Error('Incorrect installer flags'); globalThis.updateFixture.installs++; };
      await controller.check();
      return controller.state();
    }, { directory, feed });
    assert.equal(initial.status, 'available'); assert.equal(downloads, 0, 'Checking must not download');
    const failed = await app.evaluate(() => globalThis.updateFixture.controller.download());
    assert.equal(failed.status, 'error'); assert.match(failed.error, /sha512|checksum/i);
    assert.equal(await app.evaluate(() => globalThis.updateFixture.installs), 0);
    corrupt = false;
    await app.evaluate(() => globalThis.updateFixture.controller.check());
    const ready = await app.evaluate(() => globalThis.updateFixture.controller.download());
    assert.equal(ready.status, 'ready', ready.error);
    assert.equal(await app.evaluate(() => globalThis.updateFixture.installs), 0);
    await app.evaluate(() => globalThis.updateFixture.controller.install());
    assert.equal(await app.evaluate(() => globalThis.updateFixture.installs), 1);
    assert.ok(downloads >= 2, 'Retry must fetch valid bytes after checksum rejection');
    console.log('PASS native updater feed discovery, explicit download, corrupt checksum rejection, retry, verified ready state, and explicit installer dispatch');
  } finally {
    try { await app?.close(); }
    finally {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
