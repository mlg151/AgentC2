const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ appOutDir, electronPlatformName, packager }) => {
  if (electronPlatformName === 'win32') return;
  const resources = electronPlatformName === 'darwin'
    ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(appOutDir, 'resources');
  const root = path.join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty');
  let found = false;
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.name === 'spawn-helper') { fs.chmodSync(file, 0o755); found = true; }
      else if (entry.name.endsWith('.node')) fs.chmodSync(file, 0o755);
    }
  }
  visit(root);
  if (electronPlatformName === 'darwin' && !found) throw new Error('Packaged node-pty spawn-helper is missing');
  if (electronPlatformName === 'darwin') {
    // PR builds intentionally skip certificate signing in electron-builder.
    // Re-sign modified bundles and native helpers ad hoc so Apple Silicon can
    // launch them. Publisher signing, when configured, runs after this hook.
    const { signAsync } = require('@electron/osx-sign');
    await signAsync({
      app: path.join(appOutDir, `${packager.appInfo.productFilename}.app`),
      platform: 'darwin', identity: '-', identityValidation: false,
      preAutoEntitlements: false, preEmbedProvisioningProfile: false,
      optionsForFile: () => ({
        entitlements: path.join(__dirname, '..', 'assets', 'entitlements.mac.plist'),
        // Ad hoc signatures have no team identity for library validation.
        hardenedRuntime: false,
      }),
    });
  }
};
