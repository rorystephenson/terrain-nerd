import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Everything the pipeline downloads or derives, gitignored. */
export const CACHE_DIR = join(HERE, '..', 'cache');
export const OUT_DIR = join(HERE, '..', '..', 'web', 'public', 'data');
