// All update operations stay in the main process; the renderer never supplies a URL or path.
function createUpdates({ updater, version, source = false, notify = () => {} }) {
  let state = { status: 'idle', version, target: null, percent: null, error: '', source };
  let operation;
  function change(patch) { state = { ...state, ...patch }; notify({ ...state }); }
  function failed(error) { change({ status: 'error', error: String(error?.message || error).slice(0, 1500), percent: null }); }
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.on('checking-for-update', () => change({ status: 'checking', error: '' }));
  updater.on('update-available', (info) => change({ status: 'available', target: info.version, error: '', percent: null }));
  updater.on('update-not-available', () => change({ status: 'current', target: null, error: '', percent: null }));
  updater.on('download-progress', (progress) => change({ status: 'downloading', percent: Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : null }));
  updater.on('update-downloaded', () => change({ status: 'ready', percent: 100, error: '' }));
  updater.on('error', failed);
  function run(action) {
    if (operation) return operation;
    operation = Promise.resolve().then(action).catch(failed).then(() => ({ ...state })).finally(() => { operation = null; });
    return operation;
  }
  return {
    state: () => ({ ...state }),
    check() {
      if (operation) return operation;
      if (['ready', 'installing'].includes(state.status)) return Promise.resolve({ ...state });
      return run(() => updater.checkForUpdates());
    },
    download() {
      if (operation) return operation;
      if (state.status !== 'available') return Promise.reject(new Error('Check for an available update before downloading'));
      change({ status: 'downloading', percent: null, error: '' });
      return run(() => updater.downloadUpdate());
    },
    install() {
      if (state.status !== 'ready' || operation) throw new Error('The update is not ready to install');
      change({ status: 'installing', error: '' });
      try {
        const result = updater.quitAndInstall(false, true);
        if (result?.then) return result.then(() => ({ ...state })).catch((error) => { failed(error); return { ...state }; });
      } catch (error) { failed(error); }
      return { ...state };
    },
  };
}
module.exports = { createUpdates };
