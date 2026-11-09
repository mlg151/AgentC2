// All update operations stay in the main process; the renderer never supplies a URL or path.
function createMainCheck(revision, fetchJson = async (url) => {
  const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AgentC2' }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw Error('Could not check the latest main build');
  return response.json();
}) {
  return async () => {
    if (!/^[a-f0-9]{40}$/.test(revision || '')) return null;
    const comparison = await fetchJson(`https://api.github.com/repos/mlg151/AgentC2/compare/${revision}...main`);
    return ['ahead', 'diverged'].includes(comparison.status) && comparison.ahead_by > 0;
  };
}
function createUpdates({ updater, version, source = false, checkMain = async () => null, notify = () => {} }) {
  let state = { status: 'idle', version, target: null, percent: null, error: '', source, mainAhead: null };
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
  const controller = {
    state: () => ({ ...state }),
    check() {
      if (operation) return operation;
      if (['ready', 'installing'].includes(state.status)) return Promise.resolve({ ...state });
      return run(async () => {
        const [release, main] = await Promise.allSettled([updater.checkForUpdates(), checkMain()]);
        change({ mainAhead: main.status === 'fulfilled' ? main.value : null });
        const noRelease = release.status === 'rejected' && ['ERR_UPDATER_NO_PUBLISHED_VERSIONS', 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND', 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'].includes(release.reason?.code);
        if (state.mainAhead && (state.status === 'current' || noRelease)) change({ status: 'pending', error: '', target: null });
        else if (release.status === 'rejected') throw release.reason;
        else if (main.status === 'rejected' && state.status === 'current') change({ error: 'No newer published release found, but checking main failed. Try again.' });
      });
    },
    download() {
      if (operation) return state.status === 'available' ? operation.then(() => controller.download()) : operation;
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
  return controller;
}
module.exports = { createUpdates, createMainCheck };
