const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { createCoverageMap } = require('istanbul-lib-coverage');

const SHARDS = {
  'desktop-win-x64': { platform: 'win32', arch: 'x64', groups: ['core', 'desktop', 'updater', 'windows', 'packaged'] },
  'desktop-linux-x64': { platform: 'linux', arch: 'x64', groups: ['core', 'desktop', 'updater', 'packaged'] },
  'desktop-mac-x64': { platform: 'darwin', arch: 'x64', groups: ['core', 'desktop', 'updater', 'packaged'] },
  'desktop-mac-arm64': { platform: 'darwin', arch: 'arm64', groups: ['core', 'desktop', 'updater', 'packaged'] },
  'linux-ssh': { platform: 'linux', arch: 'x64', groups: ['linux-python', 'linux-web', 'linux-chat', 'linux-ui'] },
  'linux-cleanup': { platform: 'linux', arch: 'x64', groups: ['cleanup'] },
};

function canonical(file, base) {
  const implementation = path.win32.isAbsolute(base) && !path.posix.isAbsolute(base) ? path.win32 : path.posix;
  const relative = implementation.isAbsolute(file) ? implementation.relative(base, file) : file;
  const name = relative.replaceAll('\\', '/');
  if (!/^(electron|src)\//.test(name) || name.split('/').some((part) => !part || part === '.' || part === '..')) throw Error(`Unexpected coverage source: ${file}`);
  return name;
}

function metadata(base, execute = execFileSync) {
  const git = (args) => execute('git', args, { cwd: base, encoding: 'utf8' });
  const revision = git(['rev-parse', 'HEAD']).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) throw Error('A Git revision is required for coverage provenance');
  const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean).sort();
  const sources = {}, instrumentation = {};
  const digest = (file) => {
    const bytes = fs.readFileSync(path.join(base, file));
    return createHash('sha256').update(bytes.includes(0) ? bytes : Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n'))).digest('hex');
  };
  for (const file of tracked) {
    if (/^(?:electron|src)\//.test(file)) sources[file] = digest(file);
    else if (/^(?:scripts|tests|\.github)\//.test(file) || ['.coveragerc', '.nvmrc', 'vite.config.ts', 'package.json', 'package-lock.json'].includes(file)) instrumentation[file] = digest(file);
  }
  if (!Object.keys(sources).length || !Object.keys(instrumentation).length) throw Error('Coverage source and instrumentation manifests cannot be empty');
  return { version: 1, revision, dirty: Boolean(git(['status', '--porcelain', '--untracked-files=normal']).trim()), sources, instrumentation };
}

function assertMetadata(actual, expected) {
  if (!isDeepStrictEqual(actual, expected)) throw Error('Coverage revision, source, or instrumentation changed; reset and collect again');
}

function collection(base, directory) {
  const current = metadata(base);
  const file = path.join(directory, 'collection.json');
  if (!fs.existsSync(file)) {
    for (const name of ['v8', 'python']) {
      const folder = path.join(directory, name);
      if (fs.existsSync(folder) && fs.readdirSync(folder).some((name) => name.endsWith('.json') || name.startsWith('.coverage.'))) throw Error('Unversioned coverage data exists; reset and collect again');
    }
    fs.mkdirSync(directory, { recursive: true });
    const staging = path.join(directory, `collection-${process.pid}-${require('node:crypto').randomUUID()}.tmp`);
    try {
      fs.writeFileSync(staging, JSON.stringify(current, null, 2) + '\n');
      try { fs.linkSync(staging, file); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally { fs.rmSync(staging, { force: true }); }
  }
  assertMetadata(JSON.parse(fs.readFileSync(file, 'utf8')), current);
  return current;
}

function verifyCollection(base, directory) {
  const file = path.join(directory, 'collection.json');
  if (!fs.existsSync(file)) throw Error('Coverage collection metadata is missing; reset and collect again');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assertMetadata(saved, metadata(base));
  return saved;
}

function expectedFiles(base) {
  const declarations = new Set(require('./coverage.cjs').declarationFiles(base));
  return fs.readdirSync(path.join(base, 'electron'), { recursive: true }).map((file) => `electron/${file.replaceAll('\\', '/')}`).filter((file) => file.endsWith('.cjs'))
    .concat(fs.readdirSync(path.join(base, 'src'), { recursive: true }).map((file) => `src/${file.replaceAll('\\', '/')}`).filter((file) => /\.tsx?$/.test(file) && !declarations.has(file))).sort();
}

function counters(data, source) {
  if (data.all !== undefined && typeof data.all !== 'boolean') throw Error(`Invalid all-files placeholder for ${source}`);
  for (const [counts, locations] of [['s', 'statementMap'], ['f', 'fnMap'], ['b', 'branchMap']]) {
    if (!data[counts] || !data[locations] || !isDeepStrictEqual(Object.keys(data[counts]).sort(), Object.keys(data[locations]).sort())) throw Error(`Incomplete ${counts} coverage for ${source}`);
    for (const [id, raw] of Object.entries(data[counts])) {
      const values = counts === 'b' ? raw : [raw];
      if (!Array.isArray(values) || !values.length || values.some((value) => !Number.isSafeInteger(value) || value < 0)) throw Error(`Invalid execution count for ${source}`);
      if (counts === 'b' && values.length !== data.branchMap[id].locations?.length) throw Error(`Incomplete branch coverage for ${source}`);
      if (data.all === true && values.some((value) => value !== 0)) throw Error(`An all-files placeholder cannot contain execution for ${source}`);
    }
  }
}

function javascriptData(report, base, expected = expectedFiles(base)) {
  const mapped = {};
  for (const [file, data] of Object.entries(report)) {
    const relative = canonical(file, base);
    if (mapped[relative] || canonical(data.path, base) !== relative) throw Error(`Duplicate or inconsistent coverage path: ${relative}`);
    counters(data, relative);
    mapped[relative] = { ...data, path: relative };
  }
  if (!isDeepStrictEqual(Object.keys(mapped).sort(), [...expected].sort())) throw Error('JavaScript coverage must contain every executable production file, without generated bundles');
  return mapped;
}

function suiteEvidence(label, reports, inventory) {
  const shard = SHARDS[label];
  if (!shard) throw Error(`Unknown coverage shard: ${label}`);
  if (!isDeepStrictEqual(Object.keys(reports).sort(), [...shard.groups].sort())) throw Error(`Missing or unexpected suite groups for ${label}`);
  for (const group of shard.groups) {
    const expected = inventory.suites.filter((suite) => suite.group === group).map((suite) => suite.id).sort();
    const results = reports[group];
    if (!Array.isArray(results) || !isDeepStrictEqual(results.map((result) => result.id).sort(), expected)) throw Error(`Missing, duplicate, or unexpected suites in ${label}/${group}`);
    for (const result of results) {
      if (result.status !== 'success' || result.code !== 0 || result.signal !== null || !Number.isFinite(result.durationSeconds) || result.durationSeconds < 0 || !Array.isArray(result.skips) || result.skips.some((skip) => typeof skip !== 'string')) throw Error(`Unsuccessful or invalid suite evidence: ${result.id}`);
      if (result.id === 'chat-upgrade-python' && result.skips.length) throw Error('The deployed-worker upgrade regression may not be skipped');
    }
  }
}

function pythonData(value, sources) {
  if (value?.version !== '7.16.0' || value.branchCoverage !== true || !Number.isSafeInteger(value.processReports) || value.processReports < 0 || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) throw Error('Pinned Python branch coverage is required');
  for (const [file, contexts] of Object.entries(value.files)) {
    if (!Object.hasOwn(sources, file) || !/^electron\/.*\.py$/.test(file) || !contexts || Array.isArray(contexts) || typeof contexts !== 'object') throw Error(`Unexpected Python coverage source: ${file}`);
    for (const arcs of Object.values(contexts)) if (!Array.isArray(arcs) || arcs.some((arc) => !Array.isArray(arc) || arc.length !== 2 || arc.some((line) => !Number.isSafeInteger(line)))) throw Error(`Invalid Python branch arcs: ${file}`);
  }
  if (!value.processReports && Object.values(value.files).some((contexts) => Object.values(contexts).some((arcs) => arcs.length))) throw Error('Python execution cannot lack process reports');
}

function validateArtifact(artifact, expected, inventory, expectedJavascript) {
  const shard = SHARDS[artifact.label];
  if (artifact.version !== 1 || !shard || artifact.platform !== shard.platform || artifact.arch !== shard.arch) throw Error('Missing or incorrect native coverage shard identity');
  assertMetadata(artifact.metadata, expected);
  if (artifact.metadata.dirty) throw Error('CI coverage must come from a clean checkout');
  suiteEvidence(artifact.label, artifact.suites, inventory);
  javascriptData(artifact.javascript, '', expectedJavascript);
  pythonData(artifact.python, expected.sources);
  if (artifact.label !== 'linux-cleanup' && !artifact.python.processReports) throw Error(`Python collection is missing for ${artifact.label}`);
}

function mergeArtifacts(artifacts, expected, inventory, expectedJavascript) {
  const seen = new Set();
  for (const artifact of artifacts) {
    validateArtifact(artifact, expected, inventory, expectedJavascript);
    if (seen.has(artifact.label)) throw Error(`Duplicate coverage shard: ${artifact.label}`);
    seen.add(artifact.label);
  }
  if (!isDeepStrictEqual([...seen].sort(), Object.keys(SHARDS).sort())) throw Error('Coverage from all six required native and isolated jobs is required');
  return mergeJavascript(artifacts.map((artifact) => artifact.javascript));
}

function mergeJavascript(reports) {
  const grouped = new Map();
  for (const report of reports) for (const [file, data] of Object.entries(report)) {
    counters(data, file);
    if (!grouped.has(file)) grouped.set(file, []);
    grouped.get(file).push(data);
  }
  const output = createCoverageMap({});
  for (const [file, candidates] of grouped) {
    const executed = candidates.filter((data) => data.all !== true);
    const inputs = executed.length ? executed : candidates.slice(0, 1);
    const value = { path: file, all: !executed.length, statementMap: {}, fnMap: {}, branchMap: {}, s: {}, f: {}, b: {} };
    for (const [counts, locations] of [['s', 'statementMap'], ['f', 'fnMap'], ['b', 'branchMap']]) {
      const identities = new Map();
      for (const data of inputs) {
        const occurrences = new Map();
        for (const [id, hits] of Object.entries(data[counts])) {
          const entry = data[locations][id];
          // C8's statements are whole original-source lines. CRLF changes the
          // trailing column, without adding another executable statement.
          const shape = counts === 's' ? entry.start.column === 0 && entry.start.line === entry.end.line ? { line: entry.start.line } : entry : counts === 'f' ? entry.loc : { type: entry.type, loc: entry.loc, locations: entry.locations };
          const identity = JSON.stringify(shape);
          if (!identity) throw Error(`Missing coverage location for ${file}`);
          const ordinal = occurrences.get(identity) || 0;
          occurrences.set(identity, ordinal + 1);
          const key = identity + ':' + ordinal;
          if (!identities.has(key)) {
            const next = String(identities.size); identities.set(key, next);
            value[locations][next] = structuredClone(entry);
            value[counts][next] = counts === 'b' ? hits.map(() => 0) : 0;
          }
          const target = identities.get(key);
          const add = (left, right) => { const sum = left + right; if (!Number.isSafeInteger(sum)) throw Error('Coverage execution count overflow'); return sum; };
          value[counts][target] = counts === 'b' ? value[counts][target].map((count, index) => add(count, hits[index])) : add(value[counts][target], hits);
        }
      }
    }
    // Missing child functions/branches never borrow a containing range's hit.
    output.addFileCoverage(value);
  }
  return output;
}

function writeJavascriptReports(coverage, base, directory) {
  const mapped = createCoverageMap({});
  for (const file of coverage.files()) mapped.addFileCoverage({ ...coverage.fileCoverageFor(file).toJSON(), path: path.join(base, file) });
  const context = require('istanbul-lib-report').createContext({ dir: directory, coverageMap: mapped });
  for (const type of ['json', 'json-summary', 'html', 'text-summary']) require('istanbul-reports').create(type).execute(context);
}

module.exports = { SHARDS, canonical, metadata, assertMetadata, collection, verifyCollection, expectedFiles, counters, javascriptData, suiteEvidence, pythonData, validateArtifact, mergeArtifacts, mergeJavascript, writeJavascriptReports };
