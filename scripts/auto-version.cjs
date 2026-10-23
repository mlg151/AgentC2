const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

function parse(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version || '')) throw Error('Release versions must be stable major.minor.patch numbers');
  const parts = version.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw Error('Version number is too large');
  return parts;
}
function nextVersion(base, proposed) {
  const current = parse(base), candidate = parse(proposed);
  for (let index = 0; index < 3; index++) {
    if (candidate[index] > current[index]) return proposed;
    if (candidate[index] < current[index]) break;
  }
  if (!Number.isSafeInteger(current[2] + 1)) throw Error('Version number is too large');
  return `${current[0]}.${current[1]}.${current[2] + 1}`;
}
function versionFiles(base, pkg, lock) {
  const version = nextVersion(base, pkg.version);
  if (!lock.packages?.['']) throw Error('Expected an npm lockfile with a root package');
  return { version, pkg: { ...pkg, version }, lock: { ...lock, version, packages: { ...lock.packages, '': { ...lock.packages[''], version } } } };
}
function github(endpoint, method = 'GET', body) {
  const args = ['api', endpoint, '--method', method];
  if (body !== undefined) args.push('--input', '-');
  let output;
  try { output = execFileSync('gh', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], input: body === undefined ? undefined : JSON.stringify(body) }); }
  catch (error) {
    if (method === 'GET' && String(error.stderr).includes('(HTTP 404)')) return null;
    throw error;
  }
  return output.trim() ? JSON.parse(output) : null;
}
async function assignVersion({ repository, number, api = github }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[1-9]\d*$/.test(String(number))) throw Error('Invalid repository or pull request');
  const root = `repos/${repository}`;
  const pr = await api(`${root}/pulls/${number}`);
  if (pr.state !== 'open' || pr.base.ref !== 'main' || pr.head.repo?.full_name !== repository || pr.head.ref === 'main') return { skipped: true };
  const file = async (name, sha) => {
    const result = await api(`${root}/contents/${name}?ref=${sha}`);
    if (result.encoding !== 'base64' || result.type !== 'file') throw Error(`Cannot read ${name}`);
    return JSON.parse(Buffer.from(result.content, 'base64').toString('utf8'));
  };
  const [base, pkg, lock] = await Promise.all([file('package.json', pr.base.sha), file('package.json', pr.head.sha), file('package-lock.json', pr.head.sha)]);
  const next = versionFiles(base.version, pkg, lock);
  if (pkg.version === next.version && lock.version === next.version && lock.packages[''].version === next.version) return { unchanged: true, version: next.version };
  const commit = await api(`${root}/git/commits/${pr.head.sha}`);
  const tree = await api(`${root}/git/trees`, 'POST', { base_tree: commit.tree.sha, tree: [
    { path: 'package.json', mode: '100644', type: 'blob', content: JSON.stringify(next.pkg, null, 2) + '\n' },
    { path: 'package-lock.json', mode: '100644', type: 'blob', content: JSON.stringify(next.lock, null, 2) + '\n' },
  ] });
  const versionCommit = await api(`${root}/git/commits`, 'POST', { message: `Set release version to ${next.version}`, tree: tree.sha, parents: [pr.head.sha] });
  // A concurrent human push causes this non-forced update to fail safely.
  await api(`${root}/git/refs/heads/${encodeURIComponent(pr.head.ref)}`, 'PATCH', { sha: versionCommit.sha, force: false });
  // GITHUB_TOKEN pushes do not start normal push CI; dispatch explicitly.
  await api(`${root}/actions/workflows/desktop.yml/dispatches`, 'POST', { ref: pr.head.ref });
  return { version: next.version, sha: versionCommit.sha };
}
if (require.main === module) {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  assignVersion({ repository: process.env.GITHUB_REPOSITORY, number: event.pull_request?.number || event.inputs?.pull_request }).then(console.log).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { parse, nextVersion, versionFiles, assignVersion, github };
