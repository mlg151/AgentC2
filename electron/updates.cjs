const REPOSITORY = 'https://github.com/mlg151/AgentC2';
const API = 'https://api.github.com/repos/mlg151/AgentC2';

function newerVersion(candidate, current) {
  const parse = (value) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value || '')?.slice(1).map(Number);
  const next = parse(candidate), installed = parse(current);
  if (!next || !installed) return false;
  for (let index = 0; index < 3; index++) if (next[index] !== installed[index]) return next[index] > installed[index];
  return false;
}

function createUpdates({ version, revision, fetchJson = async (url) => {
  const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AgentC2' }, signal: AbortSignal.timeout(10000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('GitHub update check is temporarily unavailable');
  return response.json();
}, now = Date.now }) {
  let cached = null, checkedAt = 0, flight;
  async function check() {
    if (cached && now() - checkedAt < 5 * 60000) return cached;
    if (flight) return flight;
    flight = (async () => {
      const [release, comparison] = await Promise.allSettled([
        fetchJson(`${API}/releases/latest`),
        /^[a-f0-9]{40}$/.test(revision || '') ? fetchJson(`${API}/compare/${revision}...main`) : Promise.resolve(null),
      ]);
      let result = { available: false, version, revision: revision || null, kind: null, label: '', url: '' };
      if (release.status === 'fulfilled' && release.value && !release.value.draft && !release.value.prerelease && newerVersion(release.value.tag_name, version)) {
        result = { ...result, available: true, kind: 'release', label: `Update to ${release.value.tag_name}`, url: `${REPOSITORY}/releases/latest` };
      } else if (comparison.status === 'fulfilled' && comparison.value?.ahead_by > 0 && ['ahead', 'diverged'].includes(comparison.value.status)) {
        result = { ...result, available: true, kind: 'main', label: 'New main available', url: `${REPOSITORY}/compare/${revision}...main` };
      } else if (release.status === 'rejected' || comparison.status === 'rejected') {
        // Keep a known update visible during outages; retry on the next check.
        return cached || result;
      }
      cached = result; checkedAt = now();
      return result;
    })().finally(() => { flight = null; });
    return flight;
  }
  return { check };
}
module.exports = { createUpdates, newerVersion };
