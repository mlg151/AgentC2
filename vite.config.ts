import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let revision = '';
try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* Release checks still work in source archives. */ }
const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string;

const sourceCoverage = process.env.AGENTC2_SOURCE_COVERAGE === '1' && process.env.AGENTC2_COVERAGE === '1' ? createRequire(import.meta.url)('./scripts/source-coverage.cjs') : null;
const sourceFiles = sourceCoverage ? new Set<string>(createRequire(import.meta.url)('./scripts/coverage-artifacts.cjs').expectedFiles(path.dirname(fileURLToPath(import.meta.url)))) : null;

export default defineConfig({
  plugins: [sourceCoverage && {
    name: 'agentc2-source-coverage', enforce: 'pre',
    transform(code, id) {
      const filename = id.split('?')[0];
      const base = path.dirname(fileURLToPath(import.meta.url));
      const relative = path.relative(base, filename).replaceAll('\\', '/');
      if (!sourceFiles?.has(relative)) return null;
      const result = sourceCoverage.instrument(filename, code);
      return { code: result.code, map: result.map };
    },
    configureServer(server) {
      // Vite copies public files without running transform hooks. Serve the
      // exact instrumented source in development as well as production QA.
      server.middlewares.use((request, response, next) => {
        const filename = 'public' + new URL(request.url || '/', 'http://localhost').pathname;
        if (!sourceFiles?.has(filename)) return next();
        const result = sourceCoverage.instrument(filename, readFileSync(new URL(filename, import.meta.url), 'utf8'));
        response.setHeader('Content-Type', 'text/javascript');
        response.end(result.code);
      });
    },
    writeBundle(options) {
      for (const file of sourceFiles || []) {
        if (!file.startsWith('public/')) continue;
        const result = sourceCoverage.instrument(file, readFileSync(new URL(file, import.meta.url), 'utf8'));
        writeFileSync(path.join(options.dir || 'dist', file.slice('public/'.length)), result.code);
      }
    },
  }, react(), { name: 'agentc2-build-info', generateBundle() { this.emitFile({ type: 'asset', fileName: 'build-info.json', source: JSON.stringify({ version, revision }) }); } }],
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  // Preserve generated statement boundaries when mapping V8 coverage to TSX.
  build: { sourcemap: process.env.AGENTC2_COVERAGE === '1', minify: process.env.AGENTC2_COVERAGE !== '1', rollupOptions: { input: { desktop: 'index.html', companion: 'companion.html' } } },
});
