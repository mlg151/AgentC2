const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
module.exports = (directory) => {
  const file = path.resolve(__dirname, '../../electron/service.cjs'), load = createRequire(file), module = { exports: {} };
  const requireFixture = (name) => name === 'node-pty' ? {} : name === 'node:child_process' ? { spawn: () => { throw new Error('Peer fixture must not contact SSH or providers'); } } : load(name);
  vm.runInNewContext('(function(require,module,__dirname){' + fs.readFileSync(file, 'utf8') + '\n})', { process, console, Buffer, setTimeout, clearTimeout })(requireFixture, module, path.dirname(file));
  return module.exports.createService({ directory, home: directory });
};
