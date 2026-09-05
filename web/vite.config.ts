import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const TILE_DIR = resolve(import.meta.dirname, '../pipeline/cache/tiles');
const DATA_DIR = resolve(import.meta.dirname, '../pipeline/cache/data');

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

/**
 * Serves the feature pool in development.
 *
 * The same arrangement as the tiles above, for the same reason: in production
 * `VITE_DATA_BASE` points at R2, and locally this reads the pipeline's output
 * where the pipeline left it. It used to live in `web/public`, which meant
 * `vite build` copied 40 MB of it into every build of a 1 MB site.
 *
 * Same-origin here, which is why the missing CORS policy on the bucket never
 * showed up locally — see `tools/upload/cors.mjs`.
 */
function localData(): Plugin {
  return {
    name: 'local-data',
    configureServer(server) {
      server.middlewares.use(
        '/data',
        async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
          const path = resolve(DATA_DIR, `.${(request.url ?? '').replace(/\?.*$/, '')}`);
          // Nothing outside the pool directory, whatever the URL claims.
          if (!path.startsWith(DATA_DIR)) return next();
          try {
            const body = await readFile(path);
            response.setHeader('content-type', 'application/json');
            response.end(body);
          } catch {
            // Not built. `loadCell` treats an absent cell as empty ground, and
            // `loadIndex` says what to run — so this only has to be honest.
            response.statusCode = 404;
            response.end();
          }
        },
      );
    },
  };
}

export default defineConfig({
  plugins: [svelte(), localTiles(), localData()],
  server: { port: 5173, open: false },
});
