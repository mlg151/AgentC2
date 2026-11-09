const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const execute = promisify(execFile);
const quote = (value) => "'" + value.replace(/'/g, "'\"'\"'") + "'";

// The archive has already passed electron-updater's release SHA-512 validation.
// This path supports our existing ad hoc Mac packages, which Squirrel rejects.
async function installMacArchive({ archive, bundle, version, directory, run = execute }) {
  const staging = await fs.mkdtemp(path.join(directory, 'mac-install-'));
  const parent = path.dirname(bundle);
  const candidate = path.join(parent, `.AgentC2-update-${randomUUID()}.app`);
  const backup = path.join(parent, `.AgentC2-previous-${randomUUID()}.app`);
  try {
    await run('/usr/bin/ditto', ['-x', '-k', archive, staging]);
    const incoming = path.join(staging, 'AgentC2.app');
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', incoming]);
    const plist = path.join(incoming, 'Contents', 'Info.plist');
    const identity = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist]);
    const release = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist]);
    if (identity.stdout.trim() !== 'com.agentc2.desktop' || release.stdout.trim() !== version) throw new Error('Downloaded Mac bundle identity or version does not match the update');
    // Copy before moving the current app. A failed final rename restores it.
    // A previous bundle is retained for manual rollback after a successful update.
    const command = `set -eu\n/usr/bin/ditto ${quote(incoming)} ${quote(candidate)}\n/bin/mv ${quote(bundle)} ${quote(backup)}\nif /bin/mv ${quote(candidate)} ${quote(bundle)}; then\n  /usr/bin/true\nelse\n  /bin/mv ${quote(backup)} ${quote(bundle)}\n  exit 1\nfi`;
    // Only the access preflight can select elevation. A failure while running
    // the replacement transaction must leave the current app running for review.
    let elevate = false;
    try { await fs.access(parent, require('node:fs').constants.W_OK); }
    catch (error) {
      if (error.code !== 'EACCES' && error.code !== 'EPERM') throw error;
      elevate = true;
    }
    if (elevate) await run('/usr/bin/osascript', ['-e', `do shell script ${JSON.stringify(command)} with administrator privileges`]);
    else await run('/bin/sh', ['-c', command]);
    return backup;
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

function createMacUpdater(app, { updater = new (require('electron-updater').MacUpdater)(), bundle = path.resolve(process.execPath, '..', '..', '..'), inspect = spawnSync, install = installMacArchive } = {}) {
  const signature = inspect('/usr/bin/codesign', ['-d', '--verbose=4', bundle], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // Only an explicitly identified ad hoc signature selects the fallback. Never
  // weaken publisher verification because signature inspection failed.
  if (signature.status !== 0 || !/Signature=adhoc/.test(signature.stderr || '')) return updater;
  let downloaded;
  updater.on('update-downloaded', (event) => { downloaded = event; });
  updater.quitAndInstall = async () => {
    if (!downloaded?.downloadedFile) throw new Error('No verified Mac update is available');
    await install({ archive: downloaded.downloadedFile, version: downloaded.version, bundle, directory: path.dirname(downloaded.downloadedFile) });
    updater.closeServerIfExists();
    app.relaunch();
    app.quit();
  };
  return updater;
}
module.exports = { installMacArchive, createMacUpdater };
