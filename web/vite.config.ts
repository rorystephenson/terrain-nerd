import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const TILE_DIR = resolve(import.meta.dirname, '../pipeline/cache/tiles');

/**
 * Serves the rendered basemap tiles in development.
 *
 * In production `VITE_TILE_BASE` points at Cloudflare R2. Locally they are read
 * straight out of the render tool's output, so there is nothing to copy and
 * nothing to keep in sync — and the app works offline against whatever has been
 * rendered so far.
 */
function localTiles(): Plugin {
  return {
    name: 'local-tiles',
    configureServer(server) {
      server.middlewares.use(
        '/tiles',
        async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
          const path = resolve(TILE_DIR, `.${(request.url ?? '').replace(/\?.*$/, '')}`);
          // Nothing outside the tile directory, whatever the URL claims.
          if (!path.startsWith(TILE_DIR)) return next();
          try {
            const body = await readFile(path);
            response.setHeader('content-type', 'image/webp');
            response.setHeader('cache-control', 'public, max-age=31536000, immutable');
            response.end(body);
          } catch {
            // Not rendered. The client's own protocol handler decides what to
            // draw instead, so this only has to be honest about the absence.
            response.statusCode = 404;
            response.end();
          }
        },
      );
    },
  };
}

export default defineConfig({
  plugins: [svelte(), localTiles()],
  server: { port: 5173, open: false },
});
