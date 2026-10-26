const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
let sequence = 0;

function localFile(url) {
  if (path.isAbsolute(url)) return path.resolve(url);
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol === 'file:') return fileURLToPath(parsed);
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  const relative = decodeURIComponent(parsed.pathname).replace(/^\//, '');
  if (relative.startsWith('@fs/')) return relative.slice(3);
  return path.resolve(root, relative.startsWith('assets/') ? `dist/${relative}` : relative);
}

function normalize(entries) {
  const result = [], maps = {};
  for (const entry of entries) {
    if (!entry.url) continue;
    const file = localFile(entry.url);
    if (!file || !file.startsWith(root + path.sep) || !/\.(?:cjs|js|ts|tsx)$/.test(file) || !fs.existsSync(file)) continue;
    if (!entry.source && /\.tsx?$/.test(file)) throw Error(`Browser omitted the generated source for ${file}`);
    const source = entry.source ?? fs.readFileSync(file, 'utf8');
    const url = pathToFileURL(file).href;
    let data;
    const inline = /sourceMappingURL=data:application\/json(?:;charset=[^;,]+)?;base64,([^\s]+)/.exec(source);
    if (inline) data = JSON.parse(Buffer.from(inline[1], 'base64').toString('utf8'));
    else if (fs.existsSync(`${file}.map`)) data = JSON.parse(fs.readFileSync(`${file}.map`, 'utf8'));
    if (data) {
      // v8-to-istanbul passes multi-source paths directly to test-exclude. A
      // file: URL there silently drops every function/branch while leaving
      // default line counts at 1, producing a false 100% browser report.
      data.sources = data.sources.map((source) => source.startsWith('file:') ? fileURLToPath(source) : path.resolve(path.dirname(file), data.sourceRoot || '', source));
      data.sourceRoot = '';
      maps[url] = { data, lineLengths: source.split('\n').map((line) => line.length) };
    }
    result.push({ scriptId: entry.scriptId, url, functions: entry.functions });
  }
  return { result, 'source-map-cache': maps };
}

async function instrumentCoverage(context) {
  const saveSource = process.env.AGENTC2_SOURCE_COVERAGE === '1' ? await require('./source-browser-coverage.cjs').instrumentSourceCoverage(context) : null;
  const pending = new Map();
  function attach(page) {
    if (pending.has(page)) return pending.get(page);
    const started = page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false });
    let saved = false;
    async function save() {
      if (saved || page.isClosed()) return;
      saved = true;
      await started;
      const data = normalize(await page.coverage.stopJSCoverage());
      const directory = process.env.NODE_V8_COVERAGE;
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, `coverage-browser-${process.pid}-${++sequence}.json`), JSON.stringify(data));
    }
    const close = page.close.bind(page);
    page.close = async (...args) => { try { await save(); } finally { await close(...args); } };
    // Keep the rejection handled even if the page is closed by the application.
    started.catch(() => {});
    const record = { started, save };
    pending.set(page, record);
    return record;
  }
  context.on('page', attach);
  const newPage = context.newPage.bind(context);
  context.newPage = async (...args) => {
    const page = await newPage(...args);
    await attach(page).started;
    return page;
  };
  await Promise.all(context.pages().map((page) => attach(page).started));
  return async () => { await saveSource?.(); for (const record of pending.values()) await record.save(); };
}
module.exports = { instrumentCoverage, normalize, localFile };
