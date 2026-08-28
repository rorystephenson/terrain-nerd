# Terrain Nerd

Learn the names of geographical landmarks. A Seterra-style quiz: you get a name,
the map shows you the candidate features, you click the right one.

You get four tries per question. Every wrong click briefly labels the feature you
actually hit — that near-miss is where most of the learning is. When the tries
run out the answer starts flashing, pulses a ring, and pans into view if it had
drifted off screen — but the question stays open until you go and click it, and
wrong clicks in the meantime cost nothing. Being shown where something is teaches
much less than having to find it.

Answered features keep their name on the map, tinted by how many tries they took:
green found first time, shading through yellow and orange, red for ones you had
to be shown. By the end the map is a readable picture of what you actually know. The headline score is
first-try accuracy; questions recovered on a later try are tracked separately.

Quizzes are organised into **zones**: a fixed set of features in a named area.
Replaying a zone asks the same set in a new order, so the score actually tracks
what you have learnt — a fresh random sample every round could never tell you
that. Your best score per zone is kept in the browser.

| Quiz | What's in it | Zones |
|---|---|---|
| Valleys | `wikidata`-tagged or over 8km — the ones named in a flight report | 2 (19 and 28) |
| Peaks | The 120 most important for flying (see below) | 8 (12–23 each) |

The motivating case is paragliding — pilots describe routes and flights by naming
valleys, passes and peaks — but it works for anyone who wants the names.

**Current state:** prototype. Valleys of Trentino only, no accounts. Best scores
live in `localStorage`, so they are per-browser and not synced anywhere.

## Running it

```bash
npm install
npm run dev          # http://localhost:5173
```

The generated map data is committed, so the app runs without touching the network
beyond terrain tiles.

## Regenerating the data

```bash
npm run build:data                                  # valleys of Trentino
npm run build:data -- --region trentino --type pass # other feature types
npm run build:data -- --refresh                     # bypass the local cache
```

It writes three files into `web/public/data/`: the features as GeoJSON, a
`quizzes-*.json` manifest describing the tiers and their zones, and an unlabeled
water layer for orientation. The build prints every zone and its size, and flags
any that fell outside the target range.

Raw Overpass responses are cached in `pipeline/cache/` (gitignored), so re-runs are
offline and instant.

### How the pipeline works

`pipeline/` queries the [Overpass API](https://overpass-api.de) for one feature type
in one region, then normalises the result into a GeoJSON file the web app loads
directly. Adding a region is one entry in `pipeline/src/regions.ts`; adding a feature
type is one entry in `pipeline/src/featureTypes.ts`.

Normalisation is where the real work is, because raw OSM data is not quiz-ready:

- **Valleys are lines, not areas.** All 798 named valleys in Trentino are mapped as
  open ways following the valley floor — none are polygons. The quiz highlights
  lines rather than filling shapes.
- **Same-named segments are merged, but only when they are close.** OSM splits one
  valley across several ways. Merging purely on name would fuse Trentino's four
  separate `Valsorda` valleys into one feature spread across the province, so
  proximity decides (`mergeGapKm`).
- **Features are clipped by their own anchor point.** Overpass area queries return
  anything that *intersects* the region, which drags in 74km of Lombardy as
  `Valle Camonica`. Each feature is tested against the assembled boundary rings.
- **Significance ranking.** The median named valley is 1.34km of side gully. The
  quiz pool is the "major" tier — a `wikidata` tag or over 8km, with a 2km floor —
  which yields 47 valleys, the ones people actually name.
- **Peak importance is not elevation.** Ranking peaks by height produces a list of
  sub-summits — `Anticima Sud` ("south sub-peak"), `Presanella Bassa` — while the
  names pilots actually say sit a thousand metres lower. Three better signals are
  combined in `pipeline/src/importance.ts`:
  **isolation** (distance to the nearest higher peak, which demolishes the
  sub-summit problem on its own), **Wikidata sitelink count** (how many language
  Wikipedias carry an article — a decent proxy for "a name you hear often"), and
  **distance to a free-flying site** (OSM tags takeoffs and landings, so peaks near
  where people fly get a boost). The resulting top 120 contains Paganella, Stivo,
  Brento, Brione, Altissimo, Casale, Cima d'Asta, Tosa, Brenta, Presanella,
  Tremalzo, Cadria and Carega — which is the check that matters.
- **Zones are derived, not hand-drawn.** Trentino's 16 *comunità di valle*
  (`admin_level=7`) give real, locally-correct names, but they are wildly uneven —
  Valsugana e Tesino holds 64 valleys where Cembra holds 2. So they are the
  starting point: undersized ones are merged into their nearest neighbour, and
  oversized ones are bisected across their wider axis until every zone is 12–28
  features. Parts are named for where they actually sit (`Giudicarie — north-east`),
  and a zone fused from three or more communities is named by position instead
  (`West Trentino`), because calling a quarter of the province "Giudicarie &
  surrounds" would be a lie.
- **Ambiguity is handled at question time.** Where two features in the same zone
  share a name — Trentino has two unrelated `Valpiana` valleys 14km apart — the
  quiz asks once and accepts a click on either.

## The map

MapLibre GL with a hand-written style and **no API key**. Shaded relief is computed
in the browser from Mapzen/AWS terrarium DEM tiles.

There are deliberately no labels: ordinary topographic tiles print valley and peak
names into the raster, which would hand the player every answer. Unlabeled lakes and
rivers provide orientation instead. `mapStyle.test.ts` asserts the style contains no
symbol layer, so this cannot regress.

## Layout

```
pipeline/   Overpass -> GeoJSON + quiz manifest. Run on demand, output committed.
  src/zones.ts           comunita -> merged/bisected quiz zones
web/        Vite + Svelte 5 SPA.
  src/lib/quiz.ts        pure quiz logic, no DOM or map references
  src/lib/mapStyle.ts    the basemap, validated against the MapLibre spec
  src/lib/ZonePicker.svelte  tier tabs and the zone menu
  src/lib/MapView.svelte MapLibre setup, layer state, click hit-testing
```

## Tests

```bash
npm test
```

Covers the quiz state machine (tries, reveal-on-exhaustion, first-try vs.
recovered scoring, ambiguous names, and that replaying a zone gives the same set
in a different order) and validates the map style against the MapLibre style
specification.

## Attribution

Feature data © OpenStreetMap contributors (ODbL). Terrain tiles from Mapzen /
AWS Open Data. Peak sitelink counts from Wikidata (CC0).

## Known gaps

Massif names are not usable from OSM. "Monte Bondone" exists only as
`landuse=winter_sports`, "Monte Baldo" as a scatter of 1071m and 1682m nodes, and
"Pale di San Martino" as `natural=mountain_range`. There is no consistent tagging
to build a quiz from, so the peak quiz is `natural=peak` only — which means some
names pilots use a lot are missing.
