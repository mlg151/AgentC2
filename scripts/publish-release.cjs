const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { github, parse, nextVersion } = require('./auto-version.cjs');
const { checkVersion } = require('./check-version.cjs');

async function publishRelease({ repository, sha, ref, version, directory, api = github, execute = (args) => execFileSync('gh', args, { stdio: 'inherit' }) }) {
  parse(version);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(sha)) throw Error('Invalid release repository or revision');
  const tag = `v${version}`, root = `repos/${repository}`;
  if (ref !== 'refs/heads/main' && ref !== `refs/tags/${tag}`) throw Error('Releases must come from main or the matching version tag');
  const main = await api(`${root}/git/ref/heads/main`);
  if (ref === 'refs/heads/main' && main.object.sha !== sha) return { skipped: 'A newer main commit is being built' };
  if (main.object.sha !== sha) {
    const comparison = await api(`${root}/compare/${sha}...main`);
    if (!['ahead', 'identical'].includes(comparison.status)) throw Error('Release commit is not on main');
  }
  const existingTag = await api(`${root}/git/ref/tags/${tag}`);
  if (existingTag) {
    let object = existingTag.object;
    for (let depth = 0; object.type === 'tag' && depth < 5; depth++) object = (await api(`${root}/git/tags/${object.sha}`)).object;
    if (object.type !== 'commit' || object.sha !== sha) throw Error(`${tag} already points to another commit; refusing to move it`);
  }
  const existing = await api(`${root}/releases/tags/${tag}`);
  if (existing && !existing.draft) return { alreadyPublished: true, url: existing.html_url };
  const latest = await api(`${root}/releases/latest`);
  if (latest && latest.tag_name !== tag && nextVersion(latest.tag_name.replace(/^v/, ''), version) !== version) throw Error('Refusing to replace the latest release with an older version');
  if (!existingTag) await api(`${root}/git/refs`, 'POST', { ref: `refs/tags/${tag}`, sha });
  const common = ['--repo', repository];
  if (!existing) await execute(['release', 'create', tag, ...common, '--verify-tag', '--draft', '--title', `AgentC2 ${tag}`, '--generate-notes', '--notes', 'Windows x64, Linux AppImage/DEB, and macOS Intel/Apple Silicon packages are attached. Update feeds and SHA256SUMS.txt are included. See the signing reports and docs/platforms.md for installation details.']);
  const files = fs.readdirSync(directory).sort().map((name) => path.join(directory, name));
  if (!files.length) throw Error('No release assets');
  await execute(['release', 'upload', tag, ...common, ...files, '--clobber']);
  await execute(['release', 'edit', tag, ...common, '--draft=false', '--latest']);
  return { tag, sha, url: `https://github.com/${repository}/releases/tag/${tag}` };
}
if (require.main === module) {
  publishRelease({ repository: process.env.GITHUB_REPOSITORY, sha: process.env.GITHUB_SHA, ref: process.env.GITHUB_REF, version: checkVersion(), directory: path.resolve(process.argv[2] || 'release-assets') }).then(console.log).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { publishRelease };
