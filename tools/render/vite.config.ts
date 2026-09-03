import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const repo = resolve(import.meta.dirname, '../..');

/**
 * Serves the render page with the app's own module graph.
 *
 * `publicDir` is the pipeline's cache, where `context.pmtiles` lives — it is a
 * build intermediate now rather than something the browser is served, and this
 * is the only thing that reads it.
 */
export default defineConfig({
  root: import.meta.dirname,
  publicDir: resolve(repo, 'pipeline/cache'),
  server: { fs: { allow: [repo] }, port: 5175, open: false },
});
