import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Everything the pipeline downloads or derives, gitignored. */
export const CACHE_DIR = join(HERE, '..', 'cache');

/**
 * Where the browser's copy of the pool is written.
 *
 * Beside the rendered tiles rather than inside `web/public`, and for the same
 * reason: it is ~40 MB of pipeline output that changes only when the pipeline
 * runs, and it has no business being copied into every build of a 1 MB site.
 * In production it is served from R2 via `VITE_DATA_BASE`, exactly as the tiles
 * are; a dev server reads it straight from here through a middleware, so there
 * is nothing to copy and nothing to keep in sync.
 */
export const OUT_DIR = join(CACHE_DIR, 'data');
