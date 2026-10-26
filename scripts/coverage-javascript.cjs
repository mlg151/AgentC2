const path = require('node:path');
const { mergeJavascript } = require('./coverage-artifacts.cjs');

// Use C8's pinned raw-V8 parser and v8-to-istanbul mapper, while combining
// original-source counters only at their exact locations. Containing functions
// and blocks cannot establish that an uncalled child function/branch executed.
async function main() {
  if (require('c8/package.json').version !== '12.0.0') throw Error('Coverage reporting requires pinned C8 12.0.0');
  const argv = require('c8/lib/parse-args').buildYargs().parse(process.argv.slice(2));
  const report = require('c8/lib/report')({
    include: argv.include, exclude: argv.exclude, extension: argv.extension, excludeAfterRemap: argv.excludeAfterRemap,
    reporter: Array.isArray(argv.reporter) ? argv.reporter : [argv.reporter], reportsDirectory: argv['reports-dir'],
    tempDirectory: argv.tempDirectory, resolve: argv.resolve, omitRelative: argv.omitRelative,
    wrapperLength: argv.wrapperLength, all: argv.all, src: argv.src, excludeNodeModules: argv.excludeNodeModules,
  });
  for (const method of ['_getMergedProcessCov', '_getSourceMap', '_shouldInstrument']) if (typeof report[method] !== 'function') throw Error(`Pinned C8 interface is unavailable: ${method}`);
  report.getCoverageMapFromAllCoverageFiles = async function () {
    if (this._allCoverageFiles) return this._allCoverageFiles;
    const outputs = [];
    for (const entry of this._getMergedProcessCov().result) {
      const sources = this._getSourceMap(entry) || {};
      const filename = path.resolve(this.resolve, entry.url);
      const mapped = sources.sourceMap?.sourcemap.sources || [];
      if (sources.sourceMap ? !mapped.some((file) => this._shouldInstrument(file)) : !this._shouldInstrument(filename)) continue;
      if (/\.tsx?$/.test(filename) && !sources.sourceMap && !entry.functions.some((fn) => fn.functionName === '(empty-report)')) throw Error(`Compiled TypeScript source map is missing: ${filename}`);
      const converter = require('v8-to-istanbul')(filename, this.wrapperLength, sources, (file) => this.excludeAfterRemap && !this._shouldInstrument(file));
      try { await converter.load(); converter.applyCoverage(entry.functions); outputs.push(converter.toIstanbul()); }
      catch (error) { throw new Error(`Could not attribute production coverage for ${entry.url}`, { cause: error }); }
    }
    this._allCoverageFiles = mergeJavascript(outputs);
    return this._allCoverageFiles;
  };
  await report.run();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
