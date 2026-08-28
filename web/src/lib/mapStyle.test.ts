import assert from 'node:assert/strict';
import test from 'node:test';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';

import { buildStyle, gradeColor, GRADE_STOPS, LAYER_GEOMETRY, PICK_LAYERS } from './mapStyle.ts';

const empty = { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection;
const style = buildStyle(empty, empty);

test('style passes the MapLibre style specification', () => {
  const errors = validateStyleMin(style as never);
  assert.deepEqual(errors.map((e) => `${e.line ?? '?'}: ${e.message}`), []);
});

test('carries no symbol layer, so the map cannot leak an answer', () => {
  assert.equal(style.layers.filter((l) => l.type === 'symbol').length, 0);
});

test('every hit-test layer exists in the style', () => {
  for (const id of PICK_LAYERS) assert.ok(style.layers.some((l) => l.id === id), id);
});

test('renders both line and point features, so peaks and valleys both work', () => {
  assert.ok(style.layers.some((l) => l.type === 'line' && l.source === 'features'));
  assert.ok(style.layers.some((l) => l.type === 'circle' && l.source === 'features'));
});

test('feature layers are restricted by geometry', () => {
  // A circle layer draws one circle per vertex, so an unrestricted one dots
  // every joint of every valley line. Each layer must declare its geometry.
  const featureLayers = style.layers.filter(
    (l): l is typeof l & { source: string; filter?: unknown } =>
      (l as { source?: string }).source === 'features',
  );
  assert.ok(featureLayers.length >= 3);
  for (const layer of featureLayers) {
    assert.ok(LAYER_GEOMETRY[layer.id], `${layer.id} has no geometry filter`);
    assert.deepEqual(layer.filter, LAYER_GEOMETRY[layer.id], `${layer.id} filter not applied`);
  }
  assert.deepEqual(LAYER_GEOMETRY['features-point'], ['==', ['geometry-type'], 'Point']);
  assert.deepEqual(LAYER_GEOMETRY['features-line'], ['!=', ['geometry-type'], 'Point']);
});

test('gradeColor matches the ramp the map paints with', () => {
  for (const [at, hex] of GRADE_STOPS) assert.equal(gradeColor(at), hex, `stop ${at}`);
  assert.equal(gradeColor(-1), GRADE_STOPS[0][1], 'clamps low');
  assert.equal(gradeColor(2), GRADE_STOPS[GRADE_STOPS.length - 1][1], 'clamps high');
  // A part-way grade lands between its neighbouring stops rather than snapping.
  const mid = gradeColor(0.17);
  assert.notEqual(mid, GRADE_STOPS[0][1]);
  assert.notEqual(mid, GRADE_STOPS[1][1]);
  assert.match(mid, /^#[0-9a-f]{6}$/);
});

test('feature source promotes the numeric id that feature-state indexes on', () => {
  const source = style.sources.features;
  assert.equal(source.type, 'geojson');
  assert.equal((source as { promoteId?: string }).promoteId, 'idx');
});

test('terrain source is a keyless terrarium DEM', () => {
  const source = style.sources.terrain as { type: string; encoding?: string; tiles?: string[] };
  assert.equal(source.type, 'raster-dem');
  assert.equal(source.encoding, 'terrarium');
  assert.ok(source.tiles?.[0] && !/[?&](key|access_token|api_key)=/i.test(source.tiles[0]));
});
