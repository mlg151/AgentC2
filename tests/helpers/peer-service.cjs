const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
module.exports = (directory) => {
  const file = path.resolve(__dirname, '../../electron/service.cjs'), load = createRequire(file), module = { exports: {} };
  const requireFixture = (name) => name === 'node-pty' ? {} : name === 'node:child_process' ? { spawn: () => { throw new Error('Peer fixture must not contact SSH or providers'); } } : load(name);
  vm.compileFunction(fs.readFileSync(file, 'utf8'), ['require', 'module', '__dirname'], { filename: file, parsingContext: vm.createContext({ process, console, Buffer, setTimeout, clearTimeout }) })(requireFixture, module, path.dirname(file));
  return module.exports.createService({ directory, home: directory });
};
