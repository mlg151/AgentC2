const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

// Compile with original filenames and inline maps so unit execution is attributed
// to TypeScript rather than an anonymous new Function() that coverage cannot see.
function loadRenderer(file, dependencies = {}) {
  const filename = path.resolve(__dirname, '../../src', file);
  const source = require('../../scripts/source-coverage-hook.cjs').prepare(filename, fs.readFileSync(filename, 'utf8'));
  const compiled = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, inlineSourceMap: true, inlineSources: true },
  }).outputText;
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const requireOriginal = loaded.require.bind(loaded);
  loaded.require = (name) => Object.hasOwn(dependencies, name) ? dependencies[name] : requireOriginal(name);
  loaded._compile(compiled, filename);
  return loaded.exports;
}
module.exports = { loadRenderer };
