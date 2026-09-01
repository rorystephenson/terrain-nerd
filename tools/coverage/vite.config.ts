import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const repo = resolve(import.meta.dirname, '../..');
const COVERAGE = resolve(repo, 'pipeline/coverage.json');
const GEOFABRIK_CACHE = resolve(repo, 'pipeline/cache/geofabrik-index.json');
const GEOFABRIK_URL = 'https://download.geofabrik.de/index-v1.json';

const body = async (request: { on: (e: string, f: (c: unknown) => void) => void }) =>
  new Promise<string>((done) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => done(text));
  });

/**
 * Lets the tool read and write `pipeline/coverage.json` directly.
 *
 * A download-and-move dance would work, but coverage is something you nudge and
 * re-run the pipeline against a dozen times; making it a button is the
 * difference between the tool being used and being a diagram. Dev server only —
 * there is no production build of this page.
 */
function coverageApi(): Plugin {
  return {
    name: 'coverage-api',
    configureServer(server) {
      server.middlewares.use('/api/coverage', async (request, response, next) => {
        if (request.method === 'GET') {
          const text = await readFile(COVERAGE, 'utf8').catch(() => '{}');
          response.setHeader('content-type', 'application/json');
          return response.end(text);
        }
        if (request.method === 'POST') {
          const text = await body(request);
          try {
            JSON.parse(text); // never write something the pipeline cannot read
          } catch {
            response.statusCode = 400;
            return response.end('not JSON');
          }
          await mkdir(dirname(COVERAGE), { recursive: true });
          await writeFile(COVERAGE, `${text}\n`);
          return response.end('ok');
        }
        next();
      });

      // Cached on disk: 555 regions of polygon, and the tool asks on every edit.
      server.middlewares.use('/api/geofabrik', async (_request, response) => {
        let text = await readFile(GEOFABRIK_CACHE, 'utf8').catch(() => null);
        if (!text) {
          text = await (await fetch(GEOFABRIK_URL)).text();
          await mkdir(dirname(GEOFABRIK_CACHE), { recursive: true });
          await writeFile(GEOFABRIK_CACHE, text);
        }
        response.setHeader('content-type', 'application/json');
        response.end(text);
      });
    },
  };
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [coverageApi()],
  // The tool imports the pipeline's grid and Mercator maths rather than keeping
  // a third copy, so Vite has to be allowed to read outside its own root.
  server: { fs: { allow: [repo] }, port: 5174, open: false },
});
