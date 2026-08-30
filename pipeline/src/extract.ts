/**
 * Pulls the raw feature pool for Italy out of a Geofabrik extract.
 *
 * This replaced a chunked Overpass download. The public endpoint handles small
 * queries fine but falls over above a certain query weight — a 2° cell asking
 * for way geometry reliably drew connection resets — and a country-sized pull
 * meant hours of requests hostage to a free service. A regional extract is one
 * resumable download, filtered locally in about a minute, and re-filtering
 * costs no network at all.
 *
 * Writes only to `cache/osm/`. Interpreting the result is `process.ts`'s job.
 */
import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { CACHE_DIR } from './paths.ts';

export const OSM_DIR = join(CACHE_DIR, 'osm');

export const SOURCE_URL = 'https://download.geofabrik.de/europe/italy-latest.osm.pbf';

/** What the extract covers, give or take: Italy plus its border terrain. */
export const COVERAGE: [number, number, number, number] = [6.5, 35, 19, 47.5];
export const SOURCE_PBF = join(OSM_DIR, 'italy-latest.osm.pbf');

/**
 * What each layer keeps, in osmium's `type/key=value` filter syntax.
 *
 * Water is separate because it is by far the heaviest geometry, and because
 * nothing downstream needs it to build a quiz — only to draw one. `context`
 * is the same idea for what the map still draws: roads and glaciers.
 */
const LAYERS = {
  terrain: [
    'nwr/natural=peak',
    'nwr/natural=valley',
    'nwr/place=valley',
    'nwr/mountain_pass=yes',
    'nwr/sport=free_flying',
    'n/place=city,town,village,hamlet',
  ],
  water: ['nwr/natural=water', 'nwr/waterway=river'],
  context: [
    // Major roads only. Anything down to tertiary multiplies the shipped size
    // several times over for lines nobody navigates a valley by.
    'w/highway=motorway,motorway_link,trunk,trunk_link,primary,primary_link,secondary,secondary_link',
    'nwr/natural=glacier',
  ],
} satisfies Record<string, string[]>;

export type LayerId = keyof typeof LAYERS;
export const layerFile = (layer: string) => join(OSM_DIR, `${layer}.geojsonseq`);

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', (error) =>
      reject(
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? new Error(`${command} not found. Install it with: brew install osmium-tool`)
          : error,
      ),
    );
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)),
    );
  });
}

const mtime = async (path: string): Promise<number> => {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
};

async function extractLayer(layer: LayerId, force: boolean) {
  const filtered = join(OSM_DIR, `${layer}.osm.pbf`);
  const exported = layerFile(layer);

  if (!force && (await mtime(exported)) > (await mtime(SOURCE_PBF))) {
    console.log(`  ${layer}: up to date`);
    return;
  }

  console.log(`  ${layer}: filtering...`);
  await run('osmium', [
    'tags-filter', SOURCE_PBF, ...LAYERS[layer],
    '-o', filtered, '--overwrite',
  ]);

  // GeoJSON-seq is one feature per line, so process.ts can stream it rather
  // than holding a country's worth of parsed JSON at once.
  console.log(`  ${layer}: exporting geometry...`);
  await run('osmium', [
    'export', filtered,
    '-f', 'geojsonseq',
    '--add-unique-id=type_id',
    '-o', exported, '--overwrite',
  ]);

  const size = (await stat(exported)).size;
  console.log(`  ${layer}: ${(size / 1048576).toFixed(0)} MB`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      layer: { type: 'string' },
      force: { type: 'boolean', default: false },
    },
  });

  await mkdir(OSM_DIR, { recursive: true });
  if ((await mtime(SOURCE_PBF)) === 0) {
    throw new Error(
      `Missing ${SOURCE_PBF}\n  Download it with:\n` +
        `  curl -L -C - -o ${SOURCE_PBF} ${SOURCE_URL}`,
    );
  }

  const layers = (values.layer ? values.layer.split(',') : Object.keys(LAYERS)) as LayerId[];
  console.log(`Extracting ${layers.join(', ')} from ${SOURCE_PBF}`);
  for (const layer of layers) await extractLayer(layer, values.force!);
}

/** Only run the CLI when invoked directly — this module is imported for its constants too. */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
