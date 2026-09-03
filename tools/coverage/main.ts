/**
 * Picks the ground the pipeline will build for.
 *
 * A dev tool, not part of the app: it runs on its own Vite root and writes
 * `pipeline/coverage.json` straight to disk through a middleware, so choosing
 * coverage is a matter of clicking squares rather than editing a list of
 * indices by hand. The basemap is OpenFreeMap rather than our own style: our
 * own only exists inside coverage, which is precisely the thing being chosen
 * here, and orientation is the whole job.
 */
import maplibregl from 'maplibre-gl';

import { bboxOfCell, cellsCovering, keyOf } from '../../pipeline/src/grid.ts';
import { tileXOf, tileYOf } from '../../pipeline/src/mercator.ts';

/** Coverage is picked at z10 — 27 km squares. Chunks ship at z9, four to a cell. */
const COVERAGE_ZOOM = 10;
/**
 * Below this the grid is more cells than a screen can usefully show, and
 * drawing them all costs more than it tells you. The selection stays visible.
 */
const GRID_FROM_ZOOM = 6;

const selected = new Set<string>();

/**
 * Where people actually fly, from thermal.kk7.ch — the whole reason this tool
 * can be used to judge anything. Skyways are the routes XC flights trace out;
 * thermals are where they climb. A valley with neither is a valley nobody will
 * be quizzed on, whatever it looks like on a relief map.
 *
 * Served TMS rather than XYZ, so the row is counted from the south and MapLibre
 * needs telling. Getting that wrong does not fail loudly — it quietly returns a
 * 1x1 placeholder for every tile, so the layer just looks empty.
 *
 * CC BY-NC-SA 4.0, and `src` is required on every request.
 */
const KK7 = { skyways: { layer: 'skyways_all_all', maxzoom: 13 },
              thermals: { layer: 'thermals_all_all', maxzoom: 12 } } as const;
type Overlay = keyof typeof KK7;

const kk7Url = (layer: string) =>
  `https://thermal.kk7.ch/tiles/${layer}/{z}/{x}/{y}.png?src=${location.hostname || 'localhost'}`;

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/positron',
  center: [11.12, 46.07],
  zoom: 8,
  hash: true,
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

const polygonOf = (key: string): GeoJSON.Feature => {
  const [w, s, e, n] = bboxOfCell(key, COVERAGE_ZOOM);
  return {
    type: 'Feature',
    properties: { key },
    geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
  };
};

const collection = (keys: Iterable<string>): GeoJSON.FeatureCollection => ({
  type: 'FeatureCollection',
  features: [...keys].map(polygonOf),
});

/** Every coverage cell the current view touches, or none if the view is too wide. */
function visibleCells(): string[] {
  if (map.getZoom() < GRID_FROM_ZOOM) return [];
  const b = map.getBounds();
  return cellsCovering(
    [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
    COVERAGE_ZOOM,
  );
}

/**
 * Ground a cell covers, in km². Exact for a lon/lat rectangle on a sphere,
 * which matters because a z10 cell is 27 km square in the Alps and rather more
 * of one further south.
 */
const EARTH_R = 6371.0088;
function areaKm2(key: string): number {
  const [w, s, e, n] = bboxOfCell(key, COVERAGE_ZOOM);
  const rad = Math.PI / 180;
  return EARTH_R ** 2 * (e - w) * rad * (Math.sin(n * rad) - Math.sin(s * rad));
}

function redraw() {
  (map.getSource('grid') as maplibregl.GeoJSONSource | undefined)?.setData(
    collection(visibleCells().filter((key) => !selected.has(key))),
  );
  (map.getSource('picked') as maplibregl.GeoJSONSource | undefined)?.setData(
    collection(selected),
  );

  let area = 0;
  for (const key of selected) area += areaKm2(key);
  document.getElementById('count')!.textContent = String(selected.size);
  document.getElementById('area')!.textContent = Math.round(area).toLocaleString();
  void showRegions();
}

map.on('load', () => {
  map.addSource('grid', { type: 'geojson', data: collection([]) });
  map.addSource('picked', { type: 'geojson', data: collection([]) });

  for (const [name, { layer, maxzoom }] of Object.entries(KK7) as [Overlay, typeof KK7[Overlay]][]) {
    map.addSource(name, {
      type: 'raster',
      tiles: [kk7Url(layer)],
      tileSize: 256,
      scheme: 'tms',
      // Beyond this they have no data; without it MapLibre asks anyway and gets
      // placeholders, so the overlay vanishes exactly when you zoom in to look.
      maxzoom,
      attribution:
        '<a href="https://thermal.kk7.ch/">thermal.kk7.ch</a> CC BY-NC-SA 4.0',
    });
    map.addLayer({
      id: name,
      type: 'raster',
      source: name,
      layout: { visibility: 'none' },
      paint: { 'raster-opacity': 0.75 },
    });
  }

  /*
   * Everything below is drawn twice, dark under light. The skyways overlay runs
   * the whole way from near-black to saturated red, so a single-colour line is
   * invisible against some part of it — and a grid you cannot see is a grid you
   * cannot pick cells off, which is the entire job.
   */
  map.addLayer({
    id: 'grid-casing',
    type: 'line',
    source: 'grid',
    paint: { 'line-color': '#11151a', 'line-width': 2.2, 'line-opacity': 0.3 },
  });
  map.addLayer({
    id: 'grid-line',
    type: 'line',
    source: 'grid',
    paint: { 'line-color': '#ffffff', 'line-width': 0.8, 'line-opacity': 0.75 },
  });
  map.addLayer({
    id: 'picked-fill',
    type: 'fill',
    source: 'picked',
    paint: { 'fill-color': '#19c37d', 'fill-opacity': 0.22 },
  });
  map.addLayer({
    id: 'picked-casing',
    type: 'line',
    source: 'picked',
    paint: { 'line-color': '#0b3d28', 'line-width': 4.5, 'line-opacity': 0.55 },
  });
  map.addLayer({
    id: 'picked-line',
    type: 'line',
    source: 'picked',
    paint: { 'line-color': '#2bff9e', 'line-width': 1.8 },
  });

  map.on('moveend', redraw);
  void load();
});

/** The cell under a click, whether or not the grid happens to be drawn. */
const cellAt = (point: maplibregl.LngLat): string =>
  keyOf(tileXOf(point.lng, COVERAGE_ZOOM), tileYOf(point.lat, COVERAGE_ZOOM));

map.on('click', (event) => {
  const key = cellAt(event.lngLat);
  if (selected.has(key)) selected.delete(key);
  else selected.add(key);
  redraw();
});

/*
 * Shift-drag adds a block, alt-drag removes one. MapLibre's own box-zoom binds
 * shift-drag, so it is turned off; alt-drag would otherwise rotate, and rotation
 * is off for the same reason it is off in the app — a turned map is harder to
 * match against the ground, not easier.
 */
map.boxZoom.disable();
map.dragRotate.disable();

let dragFrom: maplibregl.LngLat | null = null;
let dragMode: 'add' | 'remove' = 'add';

map.on('mousedown', (event) => {
  if (!event.originalEvent.shiftKey && !event.originalEvent.altKey) return;
  dragMode = event.originalEvent.altKey ? 'remove' : 'add';
  dragFrom = event.lngLat;
  map.dragPan.disable();
});

map.on('mouseup', (event) => {
  if (!dragFrom) return;
  const from = dragFrom;
  dragFrom = null;
  map.dragPan.enable();

  const box: [number, number, number, number] = [
    Math.min(from.lng, event.lngLat.lng),
    Math.min(from.lat, event.lngLat.lat),
    Math.max(from.lng, event.lngLat.lng),
    Math.max(from.lat, event.lngLat.lat),
  ];
  for (const key of cellsCovering(box, COVERAGE_ZOOM)) {
    if (dragMode === 'add') selected.add(key);
    else selected.delete(key);
  }
  redraw();
});

// Drawn under the grid, so the squares you are picking stay readable over them.
for (const name of Object.keys(KK7) as Overlay[]) {
  const box = document.getElementById(name) as HTMLInputElement;
  box.addEventListener('change', () => {
    map.setLayoutProperty(name, 'visibility', box.checked ? 'visible' : 'none');
    localStorage.setItem(`overlay:${name}`, String(box.checked));
  });
  if (localStorage.getItem(`overlay:${name}`) === 'true') box.checked = true;
}

const opacity = document.getElementById('opacity') as HTMLInputElement;
opacity.addEventListener('input', () => {
  for (const name of Object.keys(KK7) as Overlay[]) {
    map.setPaintProperty(name, 'raster-opacity', Number(opacity.value) / 100);
  }
});

map.on('load', () => {
  // Applied after the layers exist, so a choice survives a reload.
  for (const name of Object.keys(KK7) as Overlay[]) {
    const box = document.getElementById(name) as HTMLInputElement;
    if (box.checked) map.setLayoutProperty(name, 'visibility', 'visible');
  }
});

// ---------------------------------------------------------------- persistence

const status = (text: string, bad = false) => {
  const el = document.getElementById('status')!;
  el.textContent = text;
  el.className = bad ? 'err' : '';
};

async function load() {
  try {
    const response = await fetch('/api/coverage');
    const saved = (await response.json()) as { zoom?: number; cells?: string[] };
    selected.clear();
    if (saved.zoom && saved.zoom !== COVERAGE_ZOOM) {
      status(`Saved coverage is z${saved.zoom}, not z${COVERAGE_ZOOM} — not loaded.`, true);
    } else {
      for (const key of saved.cells ?? []) selected.add(key);
      status(saved.cells?.length ? `Loaded ${saved.cells.length} cells.` : 'No coverage saved yet.');
    }
  } catch {
    status('Could not read coverage.json.', true);
  }
  redraw();
}

async function save() {
  // The extracts go with the cells, so `extract:data` downloads exactly the set
  // that was chosen here rather than working it out again with no size data.
  const body = JSON.stringify(
    { zoom: COVERAGE_ZOOM, cells: [...selected].sort(), sources: chosen },
    null,
    2,
  );
  try {
    const response = await fetch('/api/coverage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    if (!response.ok) throw new Error(await response.text());
    status(`Saved ${selected.size} cells to pipeline/coverage.json.`);
  } catch (error) {
    status(`Could not save: ${String(error)}`, true);
  }
}

document.getElementById('save')!.addEventListener('click', () => void save());
document.getElementById('reload')!.addEventListener('click', () => void load());
document.getElementById('clear')!.addEventListener('click', () => {
  selected.clear();
  status('Cleared — not saved yet.');
  redraw();
});

// ------------------------------------------------------------------- extracts

type Region = {
  id: string;
  name: string;
  parent?: string;
  pbf: string;
  rings: [number, number][][][];
};

let regions: Region[] | null = null;

/** The extracts the current selection needs, cheapest set first. Saved with it. */
let chosen: { id: string; name: string; pbf: string }[] = [];

/**
 * Which Geofabrik extracts the selection needs, chosen by total bytes.
 *
 * Not by *count*: asked for the fewest downloads, the answer is `europe`, once,
 * at 27 GB. And not by taking the deepest region containing each cell either —
 * Geofabrik's tree has overlapping special regions like `alps` and `dach` that
 * are nobody's child, so "deepest" fragmented an Alpine selection into German
 * Regierungsbezirke and French départements, 23 downloads for 7.25 GB, with
 * `alps` never chosen at all despite covering more than half the cells on its
 * own.
 *
 * Greedy on bytes-per-new-cell instead, which picks `alps` first and lands on
 * 10 downloads for 5.7 GB over the same ground. Sizes come from the dev server,
 * since a browser cannot ask Geofabrik for them across origins.
 *
 * **What is already downloaded is free.** Without that the cover re-optimises
 * from scratch on every edit, and the answer is unstable in an expensive
 * direction: adding twelve cells in southern Italy dropped the 2 GB `italy`
 * extract already on disk in favour of five Italian sub-regions, because each
 * costs less per new cell — 1.7 GB of download to reach ground the file already
 * held. Bytes on disk are bytes already paid for, so they cost nothing here,
 * and adding cells inside ground already downloaded now costs no download at
 * all. Delete an extract and the choice reverts to cheapest.
 */
async function showRegions() {
  const list = document.getElementById('regions')!;
  chosen = [];
  if (selected.size === 0) {
    list.innerHTML = '<li>—</li>';
    return;
  }
  if (!regions) {
    try {
      const response = await fetch('/api/geofabrik');
      const index = (await response.json()) as GeoJSON.FeatureCollection;
      regions = index.features.flatMap((feature) => {
        const p = feature.properties as Record<string, unknown>;
        const pbf = (p.urls as { pbf?: string } | undefined)?.pbf;
        if (!pbf || !feature.geometry) return [];
        const g = feature.geometry;
        const rings =
          g.type === 'MultiPolygon'
            ? (g.coordinates as [number, number][][][])
            : g.type === 'Polygon'
              ? [g.coordinates as [number, number][][]]
              : [];
        return rings.length
          ? [{ id: String(p.id), name: String(p.name), parent: p.parent as string, pbf, rings }]
          : [];
      });
    } catch {
      list.innerHTML = '<li>Could not reach Geofabrik.</li>';
      return;
    }
  }

  const cells = [...selected];
  const centres = cells.map((key) => {
    const [w, s, e, n] = bboxOfCell(key, COVERAGE_ZOOM);
    return [(w + e) / 2, (s + n) / 2] as [number, number];
  });

  // Which cells each region could supply. Regions touching none are dropped.
  const candidates = regions
    .map((region) => ({
      region,
      cells: new Set(centres.map((p, i) => (containsPoint(region, p) ? i : -1)).filter((i) => i >= 0)),
    }))
    .filter((c) => c.cells.size > 0);

  if (candidates.length === 0) {
    list.innerHTML = '<li>No Geofabrik region matched.</li>';
    return;
  }

  list.innerHTML = '<li>Measuring downloads…</li>';
  let held: Set<string>;
  try {
    held = new Set((await (await fetch('/api/downloaded')).json()) as string[]);
  } catch {
    held = new Set();
  }
  let sizes: Record<string, number>;
  try {
    const response = await fetch('/api/pbf-sizes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(candidates.map((c) => c.region.pbf)),
    });
    sizes = (await response.json()) as Record<string, number>;
  } catch {
    list.innerHTML = '<li>Could not measure download sizes.</li>';
    return;
  }

  const left = new Set(cells.map((_, i) => i));
  const picked: { region: Region; cells: number; bytes: number }[] = [];
  while (left.size > 0) {
    let best: (typeof candidates)[number] | null = null;
    let bestCost = Infinity;
    let bestNew = 0;
    for (const candidate of candidates) {
      const gained = [...candidate.cells].filter((i) => left.has(i)).length;
      const bytes = sizes[candidate.region.pbf];
      if (!gained || !bytes) continue;
      const cost = held.has(candidate.region.id) ? 0 : bytes / gained;
      // Ties are all the free ones: take whichever reaches furthest, so a
      // selection inside downloaded ground settles in as few picks as it can.
      if (cost < bestCost || (cost === bestCost && gained > bestNew)) {
        bestCost = cost;
        best = candidate;
        bestNew = gained;
      }
    }
    if (!best) break;
    picked.push({ region: best.region, cells: bestNew, bytes: sizes[best.region.pbf] });
    for (const i of best.cells) left.delete(i);
  }

  chosen = picked.map(({ region }) => ({ id: region.id, name: region.name, pbf: region.pbf }));

  /*
   * The running total that matters is what this selection would *fetch*, not
   * what it adds up to — most of the time the answer should be nothing, and a
   * number that only ever grows cannot show you that.
   */
  let running = 0;
  const mb = (bytes: number) => `${Math.round(bytes / 1048576)} MB`;
  const toFetch = picked.filter(({ region }) => !held.has(region.id));
  list.innerHTML =
    picked
      .map(({ region, cells: n, bytes }) => {
        const have = held.has(region.id);
        if (!have) running += bytes;
        return (
          `<li><strong>${region.name}</strong>${have ? ' <small>· on disk</small>' : ''}<br />` +
          `<small>${n} cells · ${mb(bytes)}` +
          (have ? '' : ` · to fetch ${(running / 1073741824).toFixed(2)} GB`) +
          `</small></li>`
        );
      })
      .join('') +
    `<li><em>${
      toFetch.length
        ? `${toFetch.length} to download, ${mb(toFetch.reduce((sum, p) => sum + p.bytes, 0))}`
        : 'nothing to download'
    }${left.size ? `; ${left.size} cells unmatched` : ''}</em></li>`;
}

function containsPoint(region: Region, point: [number, number]): boolean {
  for (const polygon of region.rings) {
    if (!pointInRing(polygon[0], point)) continue;
    if (polygon.slice(1).some((hole) => pointInRing(hole, point))) continue;
    return true;
  }
  return false;
}

/** Ray casting, the usual way. */
function pointInRing(ring: [number, number][], [x, y]: [number, number]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
