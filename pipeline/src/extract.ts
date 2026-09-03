/**
 * Pulls the raw feature pool out of Geofabrik extracts.
 *
 * This replaced a chunked Overpass download. The public endpoint handles small
 * queries fine but falls over above a certain query weight — a 2° cell asking
 * for way geometry reliably drew connection resets — and a country-sized pull
 * meant hours of requests hostage to a free service. Regional extracts are
 * resumable downloads, filtered locally in about a minute, and re-filtering
 * costs no network at all.
 *
 * Which extracts is decided by coverage: `tools/coverage` works out the
 * cheapest set that reaches every chosen cell, so ground nobody flies is never
 * downloaded rather than downloaded and thrown away. Each is clipped to the
 * coverage polygon on arrival — Italy alone drops from 2.07 GB to 1.20 GB —
 * and the clipped pieces merged, which also removes the overlap between
 * extracts that cover the same border twice.
 *
 * Writes only to `cache/osm/`. Interpreting the result is `process.ts`'s job.
 */
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
  coverageBBox,
  coverageHash,
  readCoverage,
  writeCoveragePolygon,
  type Source,
} from './coverage.ts';
import { CACHE_DIR } from './paths.ts';

export const OSM_DIR = join(CACHE_DIR, 'osm');

/** Where the pool comes from when no coverage has been chosen. */
const DEFAULT_SOURCE: Source = {
  id: 'italy',
  name: 'Italy',
  pbf: 'https://download.geofabrik.de/europe/italy-latest.osm.pbf',
};
/** The ground the default source covers, give or take: Italy plus its borders. */
const DEFAULT_COVERAGE: [number, number, number, number] = [6.5, 35, 19, 47.5];

const coverage = readCoverage();

/**
 * What the pool covers.
 *
 * From `coverage.json` when there is one — the tiles chosen in `tools/coverage`
 * — and otherwise the whole of the default extract, which is how this behaved
 * before coverage existed.
 */
export const COVERAGE: [number, number, number, number] = coverage
  ? coverageBBox(coverage)
  : DEFAULT_COVERAGE;

export const SOURCES: Source[] = coverage?.sources?.length
  ? coverage.sources
  : [DEFAULT_SOURCE];

const downloadOf = (source: Source) => join(OSM_DIR, `${source.id}.osm.pbf`);
const clippedOf = (source: Source) => join(OSM_DIR, `${source.id}.clipped.osm.pbf`);
/** Which coverage a clip was cut for, written beside it. */
const clipStampOf = (source: Source) => `${clippedOf(source)}.coverage`;
/** What the tag filters read: the clip where there is one, the raw download otherwise. */
const inputFor = (source: Source) => (coverage ? clippedOf(source) : downloadOf(source));

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

/**
 * Filters and exports one layer, source by source.
 *
 * The sources are deliberately *not* merged into one PBF first, which was the
 * obvious thing to try. `osmium merge` keeps objects that differ only by
 * version, and Geofabrik builds each extract on its own schedule — so a node
 * edited between the `alps` and `italy` snapshots exists at two versions,
 * survives the merge, and makes `osmium export` refuse the whole file with
 * "Node ID twice in input".
 *
 * Exporting each source on its own and concatenating sidesteps it. The overlap
 * between extracts then arrives as repeated features rather than a broken file,
 * and `source.ts` drops them by id on the way in.
 */
async function extractLayer(layer: LayerId, force: boolean) {
  const exported = layerFile(layer);
  const newest = Math.max(...(await Promise.all(SOURCES.map((s) => mtime(inputFor(s))))));

  if (!force && (await mtime(exported)) > newest) {
    console.log(`  ${layer}: up to date`);
    return;
  }

  const parts: string[] = [];
  for (const source of SOURCES) {
    const filtered = join(OSM_DIR, `${layer}.${source.id}.osm.pbf`);
    const part = join(OSM_DIR, `${layer}.${source.id}.geojsonseq`);
    process.stdout.write(`  ${layer}: ${source.id}...\n`);
    await run('osmium', ['tags-filter', inputFor(source), ...LAYERS[layer],
      '-o', filtered, '--overwrite']);
    // GeoJSON-seq is one feature per line, so process.ts can stream it rather
    // than holding a country's worth of parsed JSON at once.
    await run('osmium', ['export', filtered, '-f', 'geojsonseq',
      '--add-unique-id=type_id', '-o', part, '--overwrite']);
    await rm(filtered, { force: true });
    parts.push(part);
  }

  /*
   * Assembled under a temporary name and renamed at the end, so an interrupted
   * run leaves no output rather than a plausible-looking short one. The first
   * version wrote straight to `exported`; a crash mid-export left 672 of 119,210
   * elements on disk, newer than its own inputs, and the next run skipped the
   * layer as up to date and built a pool with almost no mountains in it.
   */
  const partial = `${exported}.partial`;
  await writeFile(partial, '');
  for (const part of parts) {
    await appendFile(partial, await readFile(part));
    await rm(part, { force: true });
  }
  await rename(partial, exported);

  const size = (await stat(exported)).size;
  console.log(`  ${layer}: ${(size / 1048576).toFixed(0)} MB`);
}

/**
 * Fetches one extract, resuming a part-finished file.
 *
 * Through curl rather than `fetch` because these run to gigabytes over a free
 * service, and `-C -` picking up where a dropped connection left off is worth
 * more here than avoiding a subprocess.
 */
async function download(source: Source) {
  const path = downloadOf(source);
  if ((await mtime(path)) > 0) {
    console.log(`  ${source.id}: already downloaded`);
    return;
  }
  console.log(`  ${source.id}: downloading ${source.pbf}`);
  await run('curl', ['-L', '-C', '-', '--fail', '-o', path, source.pbf]);
}

/**
 * Cuts an extract down to the covered cells, so the merge stays small.
 *
 * Freshness is against the *coverage*, not only against the download. Comparing
 * mtimes alone reported "clip up to date" for every extract already on disk
 * after coverage grew — the download had not moved, so the new ground was never
 * cut out of it, and the run looked entirely normal while rebuilding the old
 * pool. The fingerprint is written beside the clip, so what a clip was cut for
 * is recorded rather than inferred.
 */
async function clip(source: Source, polygon: string, hash: string) {
  const path = clippedOf(source);
  const cutFor = (await readFile(clipStampOf(source), 'utf8').catch(() => '')).trim();
  if (cutFor === hash && (await mtime(path)) > (await mtime(downloadOf(source)))) {
    console.log(`  ${source.id}: clip up to date`);
    return;
  }
  console.log(`  ${source.id}: clipping to coverage...`);
  await run('osmium', ['extract', '-p', polygon, '-o', path, '--overwrite', downloadOf(source)]);
  await writeFile(clipStampOf(source), `${hash}\n`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      layer: { type: 'string' },
      force: { type: 'boolean', default: false },
      'skip-fetch': { type: 'boolean', default: false },
    },
  });

  await mkdir(OSM_DIR, { recursive: true });

  if (!values['skip-fetch']) {
    console.log(
      coverage
        ? `Coverage: ${coverage.cells.length} cells, ${SOURCES.length} extracts`
        : 'No coverage.json — using the whole default extract',
    );
    for (const source of SOURCES) await download(source);

    if (coverage) {
      const polygon = await writeCoveragePolygon(coverage);
      const hash = coverageHash(coverage);
      for (const source of SOURCES) await clip(source, polygon, hash);
    }
  }

  for (const source of SOURCES) {
    if ((await mtime(inputFor(source))) === 0) {
      throw new Error(`Missing ${inputFor(source)} — run without --skip-fetch first.`);
    }
  }

  const layers = (values.layer ? values.layer.split(',') : Object.keys(LAYERS)) as LayerId[];
  console.log(`Extracting ${layers.join(', ')} from ${SOURCES.length} source(s)`);
  for (const layer of layers) await extractLayer(layer, values.force!);
}

/** Only run the CLI when invoked directly — this module is imported for its constants too. */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
