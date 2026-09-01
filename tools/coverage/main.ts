/**
 * Picks the ground the pipeline will build for.
 *
 * A dev tool, not part of the app: it runs on its own Vite root and writes
 * `pipeline/coverage.json` straight to disk through a middleware, so choosing
 * coverage is a matter of clicking squares rather than editing a list of
 * indices by hand. The basemap is OpenFreeMap rather than our own style —
 * orientation is the whole job here, and it is the same source the app falls
 * back to outside covered ground.
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
  const body = JSON.stringify({ zoom: COVERAGE_ZOOM, cells: [...selected].sort() }, null, 2);
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

/**
 * Which Geofabrik extracts the selection needs.
 *
 * Deepest match wins: Alpine coverage should pull `nord-est` rather than the
 * whole of Italy, which is most of the download saved before the pipeline runs
 * at all. This is what makes extending past Italy a data question rather than a
 * code one.
 */
async function showRegions() {
  const list = document.getElementById('regions')!;
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

  const depth = (region: Region): number => {
    let n = 0;
    let at: Region | undefined = region;
    while (at?.parent) {
      at = regions!.find((r) => r.id === at!.parent);
      n++;
    }
    return n;
  };

  const needed = new Map<string, Region>();
  for (const key of selected) {
    const [w, s, e, n] = bboxOfCell(key, COVERAGE_ZOOM);
    const centre: [number, number] = [(w + e) / 2, (s + n) / 2];
    const hits = regions.filter((region) => containsPoint(region, centre));
    if (hits.length === 0) continue;
    const best = hits.reduce((a, b) => (depth(b) > depth(a) ? b : a));
    needed.set(best.id, best);
  }

  list.innerHTML = needed.size
    ? [...needed.values()]
        .map((r) => `<li><strong>${r.name}</strong><br /><code>${r.pbf}</code></li>`)
        .join('')
    : '<li>No Geofabrik region matched.</li>';
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
