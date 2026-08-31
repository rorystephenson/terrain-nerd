import assert from 'node:assert/strict';
import test from 'node:test';
import { expression, validateStyleMin } from '@maplibre/maplibre-gl-style-spec';

import {
  buildStyle,
  firstPickable,
  gradeColor,
  gradeLabelColor,
  GRADE_STOPS,
  CASING_LAYERS,
  LAYER_GEOMETRY,
  LINE_LAYERS,
  PICK_LAYERS,
  UNANSWERED,
  UNANSWERED_HOVER,
} from './mapStyle.ts';
import { gradeFor, MAX_TRIES } from './quiz.ts';
import { ELEVATION_STOPS } from './terrain.ts';

const empty = { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection;
const style = buildStyle(empty, empty);
const buildMode = buildStyle(empty, empty, 'build');

test('style passes the MapLibre style specification', () => {
  for (const [name, candidate] of [['play', style], ['build', buildMode]] as const) {
    const errors = validateStyleMin(candidate as never);
    assert.deepEqual(errors.map((e) => `${e.line ?? '?'}: ${e.message}`), [], name);
  }
});

test('carries no symbol layer, so the map cannot leak an answer', () => {
  // Holds for both modes. Place and feature names are HTML markers precisely so
  // this stays true, which also means no glyph endpoint and therefore no API key.
  assert.equal(style.layers.filter((l) => l.type === 'symbol').length, 0);
  assert.equal(buildMode.layers.filter((l) => l.type === 'symbol').length, 0);
  assert.equal(style.glyphs, undefined, 'no glyph endpoint is needed');
});

test('shading is two passes, both over the ice', () => {
  // The second pass exists only to deepen shadow: MapLibre caps exaggeration at
  // 1 and the first pass already runs an opaque near-black shadow, so stacking
  // is the only remaining way to get darker. It must carry no highlight, or it
  // would lighten the map it is meant to deepen.
  const order = style.layers.map((l) => l.id);
  const deepen = style.layers.find((l) => l.id === 'hillshade-deepen') as {
    type: string;
    paint?: Record<string, string>;
  };
  assert.equal(deepen.type, 'hillshade');
  assert.match(deepen.paint!['hillshade-highlight-color'], /,\s*0\)$/, 'shadow only');
  assert.ok(order.indexOf('hillshade-deepen') > order.indexOf('hillshade'), 'after the first pass');
  assert.ok(order.indexOf('hillshade-deepen') > order.indexOf('glacier'), 'ice is shaded too');
});

test('water is drawn from the context source, rivers beneath lakes', () => {
  for (const id of ['lakes', 'rivers']) {
    const layer = style.layers.find((l) => l.id === id) as { source?: string } | undefined;
    assert.ok(layer, id);
    assert.equal(layer.source, 'context');
  }
  // OSM maps a river's course straight through the lake it flows into, so drawn
  // the other way round a blue line runs down the middle of Garda.
  const order = style.layers.map((l) => l.id);
  assert.ok(order.indexOf('rivers') < order.indexOf('lakes'), 'rivers under lakes');
});

test('the basemap needs no source but elevation and our own context', () => {
  // Contours were dropped, and with them the one third-party runtime dependency.
  assert.deepEqual(Object.keys(style.sources).sort(), ['context', 'features', 'terrain']);
});

test('elevation drives the tint through a sane, ordered ramp', () => {
  const relief = style.layers.find((l) => l.id === 'relief') as {
    type: string;
    paint?: Record<string, unknown>;
  };
  assert.equal(relief.type, 'color-relief');
  const ramp = relief.paint?.['color-relief-color'] as unknown[];
  assert.equal(ramp[0], 'interpolate');
  assert.deepEqual(ramp[2], ['elevation'], 'keyed on elevation, not zoom');

  // Ascending stops: MapLibre samples these into a texture and a stop out of
  // order silently inverts a band of the map.
  const heights = ELEVATION_STOPS.map(([h]) => h);
  assert.deepEqual(heights, [...heights].sort((a, b) => a - b));
  assert.equal(new Set(heights).size, heights.length, 'no duplicate stops');
  for (const [, hex] of ELEVATION_STOPS) assert.match(hex, /^#[0-9a-f]{6}$/);
});

test('the builder dims what it is leaving out instead of hiding it', () => {
  // You have to be able to see what you are choosing against, and click it back in.
  const line = buildMode.layers.find((l) => l.id === LINE_LAYERS[0]);
  const opacity = (line as { paint?: Record<string, unknown> }).paint?.['line-opacity'];
  assert.ok(Array.isArray(opacity), 'excluded features need their own opacity');
  assert.ok(JSON.stringify(opacity).includes('included'));
  // Never zero: an invisible feature cannot be clicked back in.
  const stops = JSON.parse(JSON.stringify(opacity)).flat(9).filter((v: unknown) => typeof v === 'number');
  assert.ok(Math.min(...(stops as number[])) > 0, 'dimmed, not hidden');
});

test('playing never dims by inclusion, which is a builder-only idea', () => {
  const line = style.layers.find((l) => l.id === LINE_LAYERS[0]);
  const opacity = (line as { paint?: Record<string, unknown> }).paint?.['line-opacity'];
  assert.equal(opacity, 1);
});

test('casings and fills interleave, so a feature is drawn over a whole feature', () => {
  // MapLibre orders by layer, not by feature. With one casing layer under one
  // fill layer, a valley's white halo is buried by the next valley's colour and
  // the two run together; with the casing hung above instead, both halos draw
  // over both colours and a crossing reads as a lattice. Alternating pairs is
  // the only arrangement in which one feature passes cleanly over another.
  const order = style.layers.map((l) => l.id);
  assert.equal(CASING_LAYERS.length, LINE_LAYERS.length);
  assert.ok(CASING_LAYERS.length > 1, 'a single pair cannot order two features');
  for (const [i, casing] of CASING_LAYERS.entries()) {
    assert.ok(order.indexOf(casing) >= 0 && order.indexOf(LINE_LAYERS[i]) >= 0, `pair ${i}`);
    assert.equal(order.indexOf(LINE_LAYERS[i]), order.indexOf(casing) + 1, `pair ${i} adjacent`);
    if (i > 0) {
      assert.ok(order.indexOf(casing) > order.indexOf(LINE_LAYERS[i - 1]), `pair ${i} above ${i - 1}`);
    }
  }
  // Every feature must land in exactly one pair, or it is drawn twice or not at all.
  const slices = CASING_LAYERS.map((id) => JSON.stringify(LAYER_GEOMETRY[id]));
  assert.equal(new Set(slices).size, CASING_LAYERS.length, 'each pair takes a different slice');
  for (const [i, id] of LINE_LAYERS.entries()) {
    assert.deepEqual(LAYER_GEOMETRY[id], LAYER_GEOMETRY[CASING_LAYERS[i]], `pair ${i} matches`);
  }
});

test('a casing is opaque while playing, or the feature under it shows through', () => {
  for (const id of CASING_LAYERS) {
    const casing = style.layers.find((l) => l.id === id) as { paint?: Record<string, unknown> };
    assert.equal(casing.paint!['line-opacity'], 1, id);
    // Wider than the fill it carries, or there is no halo to separate anything.
    const fill = style.layers.find((l) => l.id === LINE_LAYERS[0]) as {
      paint?: Record<string, unknown>;
    };
    const widest = (ramp: unknown) => Math.max(...(JSON.parse(JSON.stringify(ramp)) as unknown[])
      .flat(9).filter((v): v is number => typeof v === 'number'));
    assert.ok(widest(casing.paint!['line-width']) > widest(fill.paint!['line-width']), id);
  }
});

test('feature ink shrinks faster than linearly as the map zooms out', () => {
  // Screen pixels buy ten times as much ground at z8 as at z12, so a linear
  // ramp makes plainly separate features merge into one blob when zoomed out.
  const ramps = [CASING_LAYERS[0], LINE_LAYERS[0], 'features-point'].map((id) => {
    const layer = style.layers.find((l) => l.id === id) as { paint?: Record<string, unknown> };
    return (layer.paint!['line-width'] ?? layer.paint!['circle-radius']) as unknown[];
  });
  for (const ramp of ramps) {
    assert.equal(ramp[0], 'interpolate');
    assert.equal((ramp[1] as unknown[])[0], 'exponential');
    // Linear or flatter would grow the ground footprint on the way out.
    assert.ok(((ramp[1] as [string, number])[1]) > 1, 'curved, not linear');
    assert.deepEqual(ramp[2], ['zoom']);
    // Never hairline: a feature too faint to see is one the player cannot click.
    const stops = ramp.slice(3).filter((_, i) => i % 2 === 1) as number[];
    assert.ok(Math.min(...stops) > 1, 'thin, not invisible');
  }
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
  for (const id of [...CASING_LAYERS, ...LINE_LAYERS]) {
    assert.ok(
      JSON.stringify(LAYER_GEOMETRY[id]).includes('["!=",["geometry-type"],"Point"]'),
      `${id} still lets points through`,
    );
  }
});

/**
 * What MapLibre would actually paint a feature, given its feature-state.
 *
 * Compiled and evaluated rather than read off the expression by index: the
 * `case` is a flat list of test-then-value, so an assertion on its shape says
 * nothing about which branch a state lands in — which is the whole of what
 * these colours have to get right.
 */
const painted = (() => {
  const layer = style.layers.find((l) => l.id === LINE_LAYERS[0]) as {
    paint: Record<string, unknown>;
  };
  const compiled = expression.createExpression(layer.paint['line-color'], {
    type: 'color',
    'property-type': 'data-driven',
    expression: { parameters: ['zoom', 'feature', 'feature-state'] },
  } as never);
  assert.equal(compiled.result, 'success');
  const value = (compiled as { value: { evaluate: (...args: unknown[]) => unknown } }).value;
  return (state: Record<string, unknown>) =>
    String(value.evaluate({ zoom: 10 }, { type: 'LineString', properties: {} }, state));
})();

/** A hex colour as MapLibre renders it back out, for comparison. */
const rgba = (hex: string) =>
  `rgba(${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(',')},1)`;

test('hovering an unanswered feature lightens it, and only it', () => {
  assert.equal(painted({}), rgba(UNANSWERED), 'untouched');
  assert.equal(painted({ hover: true }), rgba(UNANSWERED_HOVER), 'under the pointer');
  // An answered feature's colour is its score. A hover that overrode it would
  // rub out the one thing the finished map is there to show.
  assert.equal(
    painted({ answered: true, grade: 0, hover: true }),
    painted({ answered: true, grade: 0 }),
    'answered stays on the ramp',
  );
  // Both feedback colours are being said *about* a feature, and outrank a
  // pointer that merely happens to be resting on it.
  assert.equal(painted({ miss: true, hover: true }), painted({ miss: true }), 'a miss holds');
  assert.equal(painted({ flash: true, hover: true }), painted({ flash: true }), 'a reveal holds');
});

test('the hover violet is a visible step that still holds its casing', () => {
  const [base, lit] = [UNANSWERED, UNANSWERED_HOVER].map(luminance);
  // Lighter, as asked, and by enough to read as a change at a glance.
  assert.ok(lit > base, 'lighter than the resting colour');
  assert.ok((lit + 0.05) / (base + 0.05) >= 1.9, 'and not by a hair');
  // A line on a white casing is a graphic element: 3:1 is the bar it must clear.
  assert.ok(1.05 / (lit + 0.05) >= 3, 'still reads against the white casing');
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

test('every outcome lands on a ramp stop of its own', () => {
  assert.equal(GRADE_STOPS.length, MAX_TRIES + 1, 'one colour per outcome');
  const outcomes = [
    ...Array.from({ length: MAX_TRIES }, (_, misses) => gradeFor(misses, false)),
    gradeFor(MAX_TRIES, true),
  ];
  const colours = outcomes.map((grade) => gradeColor(grade));
  // Landing between stops would show blends rather than the chosen colours.
  for (const [i, grade] of outcomes.entries()) {
    assert.equal(grade, GRADE_STOPS[i][0], `outcome ${i} sits on stop ${i}`);
    assert.equal(colours[i], GRADE_STOPS[i][1]);
  }
  assert.equal(new Set(colours).size, colours.length, 'every outcome reads differently');
});

/** WCAG relative luminance of an `#rrggbb` colour. */
function luminance(hex: string): number {
  const channels = [1, 3, 5]
    .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

test('every grade reads as text on the white halo answered labels use', () => {
  for (const [at] of GRADE_STOPS) {
    const contrast = 1.05 / (luminance(gradeLabelColor(at)) + 0.05);
    assert.ok(contrast >= 4, `grade ${at} is ${contrast.toFixed(2)}:1 against white`);
  }
  // The olive mid-ramp is the stop that fails without the darkening, so the
  // label colour must not simply be the fill colour.
  assert.notEqual(gradeLabelColor(0.34), gradeColor(0.34));
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

const hit = (osmId: unknown) => ({ properties: { osmId } });

test('picking takes the first hit when nothing is spent', () => {
  assert.equal(firstPickable([hit('valley/a'), hit('valley/b')], new Set()), 'valley/a');
});

test('an answered feature is skipped, and what is behind it picked instead', () => {
  assert.equal(firstPickable([hit('valley/a'), hit('valley/b')], new Set(['valley/a'])), 'valley/b');
});

test('a click that only lands on spent features picks nothing at all', () => {
  const spent = new Set(['valley/a', 'valley/b']);
  assert.equal(firstPickable([hit('valley/a'), hit('valley/b')], spent), null);
});

test('hits without a usable id are ignored', () => {
  assert.equal(firstPickable([hit(undefined), { properties: null }, hit(7)], new Set()), null);
});

test('nothing under the click picks nothing', () => {
  assert.equal(firstPickable([], new Set()), null);
});
