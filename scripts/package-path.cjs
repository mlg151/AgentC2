const path = require('node:path');

function packagePath(root = path.resolve(__dirname, '..'), platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return path.join(root, 'release', `win${arch === 'x64' ? '' : `-${arch}`}-unpacked`, 'AgentC2.exe');
  if (platform === 'darwin') return path.join(root, 'release', `mac${arch === 'x64' ? '' : `-${arch}`}`, 'AgentC2.app', 'Contents', 'MacOS', 'AgentC2');
  return path.join(root, 'release', `linux${arch === 'x64' ? '' : `-${arch}`}-unpacked`, 'agentc2');
}

module.exports = { packagePath };
