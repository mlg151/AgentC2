const fs = require('node:fs');
const path = require('node:path');

function nameAnonymousFunctions(report) {
  if (!Array.isArray(report.result)) throw Error('Invalid V8 process report');
  return { ...report, result: report.result.map((entry) => ({ ...entry,
    functions: entry.functions.map((fn, index) => {
      // C8 records only named functions. Give anonymous callbacks stable names
      // so an uncalled callback cannot disappear from the function denominator.
      // The leading offset-zero script/module wrapper is not a user function.
      const range = fn.ranges[0];
      return !fn.functionName && range && (index > 0 || range.startOffset > 0)
        ? { ...fn, functionName: `(anonymous@${range.startOffset})` } : fn;
    }),
  })) };
}

function normalize(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const file of fs.readdirSync(source).filter((name) => name.endsWith('.json'))) {
    const report = JSON.parse(fs.readFileSync(path.join(source, file), 'utf8'));
    fs.writeFileSync(path.join(destination, file), JSON.stringify(nameAnonymousFunctions(report)));
  }
}
module.exports = { nameAnonymousFunctions, normalize };
