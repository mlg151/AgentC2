const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const REPOSITORY = 'https://github.com/mlg151/AgentC2.git';
function sourceExecutable(root, platform = process.platform) {
  return path.join(root, 'node_modules', 'electron', 'dist', platform === 'win32' ? 'electron.exe' : platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
}
function activeBuild(directory) {
  try {
    const saved = JSON.parse(syncFs.readFileSync(path.join(directory, 'active.json'), 'utf8'));
    if (!/^build-[a-zA-Z0-9]+$/.test(saved.build) || !Array.isArray(saved.origins)) return null;
    const staging = path.join(directory, saved.build);
    const executable = sourceExecutable(staging);
    if (!syncFs.existsSync(executable) || !syncFs.existsSync(path.join(staging, 'dist', 'index.html'))) return null;
    return { ...saved, staging, executable };
  } catch { return null; }
}
function resumeSourceUpdate({ directory, revision, app }) {
  const saved = activeBuild(directory);
  if (!saved || path.resolve(app.getAppPath()) === path.resolve(saved.staging) || !saved.origins.some((origin) => origin.root === app.getAppPath() && origin.revision === revision)) return false;
  process.env.NODE_ENV = 'production';
  app.relaunch({ execPath: saved.executable, args: [saved.staging] });
  app.quit();
  return true;
}

function run(file, args, cwd) {
  return new Promise((resolve, reject) => {
    // Only fixed npm commands use cmd.exe on Windows; no user-provided shell text.
    const child = spawn(file, args, { cwd, shell: process.platform === 'win32' && file === 'npm', windowsHide: true, env: { ...process.env, NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: undefined, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (data) => { output = (output + data.toString()).slice(-8000); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`${file} timed out while preparing the update`)); }, 20 * 60000);
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('close', (code) => { clearTimeout(timeout); if (code === 0) resolve(output.trim()); else reject(new Error(`${file} ${args[0]} failed (${code}): ${output}`)); });
  });
}
class SourceUpdater extends EventEmitter {
  constructor({ revision, directory, app, execute = run, repository = REPOSITORY }) {
    super();
    this.revision = revision;
    this.directory = directory;
    this.app = app;
    this.execute = execute;
    this.repository = repository;
    this.target = null;
    this.prepared = null;
  }
  async checkForUpdates() {
    this.emit('checking-for-update');
    const result = await this.execute('git', ['ls-remote', this.repository, 'refs/heads/main']);
    const target = result.split(/\s/)[0];
    if (!/^[a-f0-9]{40}$/.test(target)) throw new Error('Could not determine the latest main revision');
    this.target = target;
    this.emit(target === this.revision ? 'update-not-available' : 'update-available', { version: `main ${target.slice(0, 7)}` });
  }
  async downloadUpdate() {
    if (!this.target) throw new Error('Check for updates first');
    await fs.mkdir(this.directory, { recursive: true });
    const staging = await fs.mkdtemp(path.join(this.directory, 'build-'));
    try {
      this.emit('download-progress', { percent: 5 });
      await this.execute('git', ['init', staging]);
      await this.execute('git', ['fetch', '--depth=1', this.repository, this.target], staging);
      await this.execute('git', ['checkout', '--detach', 'FETCH_HEAD'], staging);
      const revision = await this.execute('git', ['rev-parse', 'HEAD'], staging);
      if (revision !== this.target) throw new Error('Downloaded source revision did not match the checked update');
      this.emit('download-progress', { percent: 25 });
      await this.execute('npm', ['ci', '--include=dev'], staging);
      this.emit('download-progress', { percent: 70 });
      await this.execute('npm', ['run', 'build'], staging);
      const build = JSON.parse(await fs.readFile(path.join(staging, 'dist', 'build-info.json'), 'utf8'));
      if (build.revision !== this.target) throw new Error('Built application revision did not match the checked update');
      const executable = sourceExecutable(staging);
      await fs.access(executable);
      this.prepared = { staging, executable };
      this.emit('update-downloaded', { version: build.version });
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
  }
  quitAndInstall() {
    if (!this.prepared) throw new Error('No source update has been built');
    // The original checkout (including uncommitted work) remains untouched.
    const origins = (activeBuild(this.directory)?.origins || []).filter((origin) => origin.root !== this.app.getAppPath()).slice(-99);
    origins.push({ root: this.app.getAppPath(), revision: this.revision });
    const temporary = path.join(this.directory, 'active.json.tmp');
    syncFs.writeFileSync(temporary, JSON.stringify({ build: path.basename(this.prepared.staging), origins }), { mode: 0o600 });
    syncFs.renameSync(temporary, path.join(this.directory, 'active.json'));
    process.env.NODE_ENV = 'production';
    this.app.relaunch({ execPath: this.prepared.executable, args: [this.prepared.staging] });
    this.app.quit();
  }
}
module.exports = { SourceUpdater, run, resumeSourceUpdate, sourceExecutable };
