const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');

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

function separateCompilations(report, root) {
  const maps = report['source-map-cache'] || {};
  const output = { ...report, 'source-map-cache': { ...maps } };
  output.result = report.result.map((entry) => {
    const url = entry.url.startsWith('file:') ? entry.url : path.isAbsolute(entry.url) ? pathToFileURL(entry.url).href : null;
    const cache = url && maps[url];
    if (!cache?.data || !Array.isArray(cache.data.sources) || !Array.isArray(cache.lineLengths)) return entry;
    const original = fileURLToPath(url);
    const data = { ...cache.data, sourceRoot: '', sources: cache.data.sources.map((source) => source.startsWith('file:') ? fileURLToPath(source) : path.resolve(path.dirname(original), cache.data.sourceRoot || '', source)) };
    const identity = createHash('sha256').update(JSON.stringify([original, data, cache.lineLengths])).digest('hex');
    const generated = pathToFileURL(path.join(root, 'dist/coverage-generated', identity, path.basename(original) + '.js')).href;
    delete output['source-map-cache'][url];
    output['source-map-cache'][generated] = { ...cache, data };
    return { ...entry, url: generated };
  });
  return output;
}

function normalize(source, destination, root = path.resolve(__dirname, '..')) {
  fs.mkdirSync(destination, { recursive: true });
  for (const file of fs.readdirSync(source).filter((name) => name.endsWith('.json'))) {
    const report = JSON.parse(fs.readFileSync(path.join(source, file), 'utf8'));
    fs.writeFileSync(path.join(destination, file), JSON.stringify(separateCompilations(nameAnonymousFunctions(report), root)));
  }
}
module.exports = { nameAnonymousFunctions, separateCompilations, normalize };
