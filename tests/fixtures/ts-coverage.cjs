const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const ts = require('typescript');

// Preserve exact original TypeScript mappings when tests inject browser globals.
function compileTypeScript(file, parameters) {
  const source = fs.readFileSync(file, 'utf8');
  const compiled = ts.transpileModule(source, { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, sourceMap: true, inlineSources: true } });
  const map = JSON.parse(compiled.sourceMapText);
  map.sources = [file]; map.sourceRoot = '';
  const output = compiled.outputText.replace(/\/\/# sourceMappingURL=.*$/, '') + `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}\n`;
  const directory = path.resolve('coverage/transpiled');
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, crypto.createHash('sha256').update(file).digest('hex') + '.js');
  fs.writeFileSync(filename, output);
  return vm.compileFunction(output, parameters, { filename });
}

module.exports = { compileTypeScript };
