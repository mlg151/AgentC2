const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function loadCommonJs(file, dependencies = {}, globals = {}) {
  const filename = path.resolve(__dirname, '../..', file);
  const original = createRequire(filename);
  const load = (name) => Object.hasOwn(dependencies, name) ? dependencies[name] : original(name);
  const module = { exports: {} };
  vm.compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports', '__filename', '__dirname'], { filename, contextExtensions: [globals] })(load, module, module.exports, filename, path.dirname(filename));
  return module.exports;
}
module.exports = { loadCommonJs };
