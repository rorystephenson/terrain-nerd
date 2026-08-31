# Terrain Nerd

Learn the names of geographical landmarks. A Seterra-style quiz: you get a name,
the map shows you the candidate features, you click the right one.

The motivating case is paragliding — pilots describe routes and flights by naming
valleys, passes and peaks — but it works for anyone who wants the names.

## Building a quiz

You choose what to learn. Frame an area, tick which feature types to include,
and narrow them down with one slider each:

| Type | Filter |
|---|---|
| Valleys | length |
| Mountains | popularity |
| Passes | popularity |

### Framing the area

The area is a **red frame you drag by its handles**, over a map that pans and
zooms underneath it. The frame holds still on screen while the ground moves, so
zooming in to check what you have caught is a look rather than an edit.

It was the whole viewport once, and a viewport is the wrong shape for a valley:
a screen is a landscape rectangle and the ground people want is usually a strip
along one valley or a square around one massif, so half of what came back was
from the next valley over and had to be pinned out by hand. Trimming the frame
is the same decision made before the download rather than after it.

Two rules, both stated in pixels rather than in degrees, because both are about
the screen. It cannot shrink below about a fingertip and a half — smaller and
you cannot tell which handle you grabbed — and it stays clear of the window edge
and of the panel, so every handle has room to be grabbed *around*. A rule in
degrees would be worth a different number of pixels at every zoom.

Nothing is reserved for the zoom buttons or the credit; those are drawn above
the frame instead. An inset for them would be one you cannot see the reason for,
and it would stop the frame reaching as far one way as it reaches the other.

Reopening a quiz to change its area puts the frame back around the area that
quiz was built from, with slack on every side so it can be grown as well as cut.

Then hand-correct anything the filter got wrong for you. **Tap a feature to pin
it**: one that the filter included gets pinned out, one it excluded gets pinned
in. Tap it again and it goes back to following the filter. Pins survive any
amount of slider dragging, which is the point — you can filter to valleys over
5 km and still keep the 2 km one you actually fly past.

Excluded features stay on the map, dimmed, so you can see what you are choosing
against and click one back in. Pinned ones carry a badge.

The panel **minimises to a pill** in its own corner, because pinning is done on
the map and on a phone the panel covers most of it. The pill keeps the question
count, which is the number you minimised to watch: every pin moves it, and a
fold that hid the count would only be unfolded again after each tap.

Quizzes save to `localStorage` and can be replayed and edited. Nothing is synced
anywhere, so each quiz has a **save to file** button and there is a matching
load. A file holds the quiz itself and never your scores — those belong to the
browser that earned them. Loading merges rather than overwrites, so a file
dropped onto a browser that already has quizzes cannot destroy them.

### Why popularity rather than altitude

Altitude is close to useless as a relevance filter: a 2,000 m peak you fly past
every week matters more than a 3,500 m one you never see. Ranking by elevation
also fills the top of the list with sub-summits — "Anticima Sud" is literally
"south sub-peak" — while the names pilots actually say sit a thousand metres
lower.

Popularity is a 0–100 percentile built from three signals:

- **Topographic isolation** — distance to the nearest higher peak. This is what
  separates a mountain you navigate by from a bump on someone else's ridge, and
  it demolishes the sub-summit problem on its own.
- **Wikidata sitelinks** — how many language Wikipedias carry an article, as a
  proxy for "a name you hear often".
- **Distance to a free-flying site** — OSM tags takeoffs and landings, so peaks
  near where people actually fly get a boost.

Around the Brenta this puts Cima Brenta, Presanella, Cima Tosa, Carè Alto and
Paganella at the top, and spot-heights like "Quota 3368" at the bottom.

Passes drop the isolation term — a saddle is by definition a low point between
two higher things, so its isolation is always tiny and says nothing.

## Playing

Four tries per question. Every wrong click briefly labels the feature you
actually hit — that near-miss is where most of the learning is. When the tries
run out the answer starts flashing, pulses a ring, and pans into view if it had
drifted off screen — but the question stays open until you go and click it, and
wrong clicks in the meantime cost nothing. Being shown where something is teaches
much less than having to find it.

Answered features keep their name on the map, tinted by how many tries they took:
green found first time, shading through yellow and orange, red for ones you had
to be shown. By the end the map is a readable picture of what you actually know.
The headline score is first-try accuracy; questions recovered on a later try are
tracked separately.

Replaying a quiz asks the same set in a new order, so the score actually tracks
what you have learnt — a fresh random sample every round could never tell you
that. Best score per quiz is kept in the browser.

**Place names** are always on, and follow the map rather than a saved setting:
zoom out and you get cities, zoom into one valley and you get hamlets. They are
settlements only — never the features being quizzed — and they are the only
names the map is allowed to show, which is why they are not optional. A quiz you
cannot find your way around is not a harder quiz, just a worse one.

The builder and the player share one rule for this, in `places.ts`. Detail
follows the *span* being looked at and nothing else, so panning at a fixed zoom
never changes which names are eligible — only which of them are on screen.

## Running it

```bash
npm install
npm run dev          # http://localhost:5173
```

The app needs the data pool to exist first — see below.

## Data

Coverage is **all of Italy**, unfiltered: every named valley, peak, pass and
settlement. The pipeline deliberately makes no judgement about what is worth
learning; that is the builder's job.

| | count |
|---|---|
| Mountains | 38,058 |
| Valleys | 3,510 (merged from 4,193 named ways) |
| Passes | 4,255 |
| Settlements | 66,180 |
| Lakes | 11,457 |
| Rivers and waterways | 19,383 |
| Major roads | 496,174 |
| Glaciers | 999 |

Two steps, deliberately separate, so changing how data is processed never means
downloading a country again:

```bash
# 1. Download the extract (~2.2 GB, resumable), then filter it locally.
curl -L -C - -o pipeline/cache/osm/italy-latest.osm.pbf \
  https://download.geofabrik.de/europe/italy-latest.osm.pbf
npm run extract:data          # ~15s per layer, needs: brew install osmium-tool

# 2. Turn the extract into what the browser loads.
npm run build:data                 # ~2 min
npm run build:data -- --skip-water # reuse the water chunks already on disk
```

Water is by far the slowest layer — 178 MB of river geometry — and changes
rarely, so `--skip-water` reads the existing chunks' counts back instead of
regenerating them.

`extract:data` writes only to `pipeline/cache/osm/`; `build:data` reads only from
it. The one network call in step 2 is Wikidata sitelink counts, which are cached
on disk and requested only for ids not already held, so an interrupted run
resumes rather than restarting.

### Why not Overpass

The first version chunked the download into Overpass queries. Small and medium
queries work fine, but the public endpoint reliably fell over above a certain
query weight — a 2° cell asking for way geometry drew connection resets — and a
country-sized pull meant hours of requests hostage to a free service. A regional
extract is one download, filtered in seconds, and re-filtering costs nothing.

### Chunking

The pool is far too big to load at once, so it ships as 0.5° cells (~55 km
square) under `web/public/data/<kind>/<cell>.geojson`, with an `index.json`
listing which cells hold anything. The app loads only the cells its area touches,
and only for the feature types that are switched on.

A feature is written into **every** cell its bounding box touches, so a long
valley does not vanish when you look at the neighbouring cell; the app dedupes by
id on the way in and clips to the requested area.

**That clip is an intersection test, not containment.** A valley running through
the area you picked is one of the valleys in that area, even if most of its
length lies beyond the edge — and those long through-valleys are exactly the
ones people navigate by. It tests the geometry rather than the bounding box,
because a diagonal valley's bbox can clip the corner of an area the valley never
enters.

A consequence worth knowing: because chosen features may extend well outside the
area they were picked in, the area cannot be reconstructed from them. So
reopening a quiz for editing does not re-run the filters to decide what is in
it — the saved set wins, and any disagreement with the current filters is
recorded as a pin. Without that, reopening a 71-feature quiz offered 104.

Geometry is simplified with Douglas–Peucker, at a tolerance that depends on how
the shape is read: 50 m for rivers and 30 m for roads, which are drawn a pixel
or two wide, but 10 m for shorelines and glacier edges, which are read as
silhouettes where every cut corner shows. That takes water from 3.9M vertices
to 821k.

**Nothing is classified by elimination.** Filtering for `natural=glacier` or
`natural=water` makes osmium emit those relations' *member ways* as well, and
those arrive with no tags at all. Treating "not a glacier" as "therefore a road"
drew 338 white lines along glacier outlines and across the ice, and the same
mistake on the water layer turned 8,504 lake-boundary arcs into rivers. A road
must carry `highway`; water must carry `natural=water` or `waterway`.

Features are also grouped for output by geometry type as well as kind, because a
group is written as a single `Multi*` — mixing lines and polygons emits one of
them with the other's nesting, which renders as garbage strung across the map.

**Polygon structure is preserved end to end.** `RawElement` carries both a
flattened coordinate list — all a valley needs — and the geometry as exported.
Filled shapes must use the latter: flattening Lake Garda's multipolygon into one
list and closing it yields a single self-intersecting ring, which renders as
wedges of land lying across open water. Rings that collapse below a triangle are
dropped, and a polygon that loses its outer ring is dropped whole rather than
leaving a hole with no shape around it.

## The map

There is no basemap provider. The whole thing is assembled in the browser from
raw elevation — MapLibre's `color-relief` and `hillshade` layers over keyless
Terrarium DEM tiles — plus OSM roads, glaciers and water from our own pipeline.
No API key, no tile bill, and nothing arrives pre-labelled.

**The style contains no symbol layers at all,** and a test enforces it. Standard
topo tiles print valley and peak names straight into the raster, which would
hand the player every answer. Place names, where a quiz asks for them, are HTML
markers instead — which also means no glyph endpoint and therefore no API key.
Because HTML markers do not collide-avoid the way symbol layers do, labels are
thinned by a greedy screen-space pass before being drawn. Contours are drawn
unlabelled for the same reason.

### The elevation palette is measured, not designed

`ELEVATION_STOPS` in `terrain.ts` looks like arbitrary hex. It was fitted: pixels
of a reference topo render were paired with real Terrarium elevations at the
same coordinates — the render was georeferenced by solving a Mercator transform
against three peaks whose positions we already hold — and the ramp was then
iterated until this style reproduced the reference's colour in every 100 m band
to within about 2%.

Two things fell out of that which guessing would have missed:

- **The bright end of a topo map is its valley floors, not its highlights.**
  An early attempt matched the reference's brightness by cranking the hillshade
  highlight, which washed every lit slope toward white. The reference gets that
  brightness from the tint instead, so the shading leans on shadow.
- **Lowlands are pale, not green.** The Adige through Trento and Rovereto reads
  near-white, because down there the ground is farmland and town rather than
  forest. A saturated green at 200 m makes plains look like alpine meadow.

Glaciers are drawn beneath the hillshade, so ice takes the same shading as the
rock around it and reads as a surface with shape rather than a flat white
sticker. Water sits above the shading, because a lake surface genuinely is flat
— and rivers go *under* lakes, since OSM maps a river's course straight through
the lake it flows into, which drawn the other way puts a blue line down the
middle of Garda.

### Which place names get drawn

Zoom picks how much detail is worth showing — cities only when you are looking
at half a country, hamlets when you are in one valley — and a greedy pass then
drops any label whose box touches one already placed, strongest first, because
HTML markers do not collide-avoid the way symbol layers do.

The subtlety is that **the choice must not depend on where the viewport sits**.
Two things make that true. Labels beyond the screen edge still take part in
collisions (`pad`), so sliding one into view cannot evict the neighbour it
should have been blocking all along; and ties are broken by a stable key rather
than by arrival order, which otherwise varies with whichever data chunk loaded
first. The ceiling on label count is a safety net, set high enough that it is
never what decides. At a fixed zoom, panning then only adds and removes labels
at the edges.

### Shading is two passes

`hillshade` runs twice. The first does the modelling; the second is shadow-only,
with no highlight at all, purely to deepen the dark end.

That is not a flourish — it is the only dial left. MapLibre caps
`hillshade-exaggeration` at 1 (values above it are *silently refused*, which
quietly invalidated an early sweep), and the first pass already runs an opaque
near-black shadow. Stacking is also the better answer than simply darkening
everything: it deepens shadow without touching the highlight, so the relief gets
contrastier rather than the whole map muddier. Measured against the reference,
it takes 5th-percentile luminance from 48 to 36 against its 35, while holding
the median.

### Geometry is held as `$state.raw`

Svelte's `$state` proxies an object and everything reachable from it. Handing
MapLibre a few hundred thousand coordinates behind reactive proxies costs a trap
on every read: profiling a pan put **38% of CPU time in Svelte's proxy machinery**
rather than in rendering, with 7.2 seconds of blocking time and 449 ms frames.
None of this data is ever mutated in place, only reassigned, so `$state.raw` in
`App.svelte` and `Builder.svelte` is both correct and the whole fix — the same
pan now runs with zero long tasks and a 33 ms worst frame.

## Layout

```
pipeline/          run on demand, never at build time
  extract.ts       Geofabrik pbf -> filtered GeoJSON-seq  (osmium)
  process.ts       GeoJSON-seq -> chunked GeoJSON + index.json
  source.ts        streams the extract, source-agnostic RawElement
  normalize.ts     merge same-named segments by proximity
  importance.ts    popularity scoring + Wikidata sitelinks
  spatial.ts       grid index for nearest-higher-peak
  simplify.ts      Douglas-Peucker
  grid.ts          the chunk grid
web/src/lib/
  terrain.ts       elevation palette and DEM source     (pure)
  builder.ts       inclusion rules, pins, resolution   (pure)
  places.ts        how much settlement detail per zoom  (pure)
  quiz.ts          quiz state machine                  (pure)
  labels.ts        greedy label collision              (pure)
  grid.ts          client half of the chunk grid       (pure)
  chunks.ts        cell loading and caching
  storage.ts       localStorage
  MapView.svelte   MapLibre, both play and build modes
```

The pure modules hold the logic worth being sure about, and are directly
unit-tested:

```bash
npm test             # 76 tests
npm run typecheck -w pipeline
npm run check -w web
```

## Known gaps

- **No massif names.** OSM has no consistent tagging for ranges like "the Brenta
  Dolomites", so ranges cannot be quizzed as objects.
- **Peak isolation uses named peaks only.** An unnamed higher summit nearby will
  not reduce a peak's isolation. In practice a named sub-summit's nearest higher
  neighbour is the named main summit it hangs off, so this holds up.
- **Coverage stops at Italy's bounding box**, which does include the Swiss,
  Austrian and Slovenian border terrain — deliberately, since the terrain people
  name does not stop at the border.
- **`web/public/data/` is ~67 MB**, of which roads are 25 MB. That is a hosting
  number, not a per-visit one: cells load individually, and a Val Rendena
  viewport pulls about 650 KB of roads, glaciers and water across four cells.
  Dropping `secondary` roads would halve the road layer if it ever matters.
- **Green follows elevation, not land cover.** The reference style colours by
  what is actually on the ground, so its treeline bends with aspect and shelter
  while ours is a horizontal band. Fixing that means shipping a landcover layer.
