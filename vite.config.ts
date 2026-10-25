import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

let revision = '';
try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* Release checks still work in source archives. */ }
const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string;

export default defineConfig({
  plugins: [react(), { name: 'agentc2-build-info', generateBundle() { this.emitFile({ type: 'asset', fileName: 'build-info.json', source: JSON.stringify({ version, revision }) }); } }],
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  // Preserve generated statement boundaries when mapping V8 coverage to TSX.
  build: { sourcemap: process.env.AGENTC2_COVERAGE === '1', minify: process.env.AGENTC2_COVERAGE !== '1', rollupOptions: { input: { desktop: 'index.html', companion: 'companion.html' } } },
});
