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

Every settlement carries the zooms it may be named at, worked out once for the
whole coverage before the browser ever sees it, so the builder and the player
both do the same thing with it: draw the name if the map's zoom is inside its
range. Panning cannot change that answer, because nothing in it looks at where
the viewport sits.

## Running it

```bash
npm install
npm run dev          # http://localhost:5173
```

The app needs the data pool to exist first — see below — and the basemap tiles
to have been rendered, see [The map](#the-map). In production those tiles come
from Cloudflare R2; a dev server reads them out of `pipeline/cache/tiles`
instead, so local work needs no upload and keeps working offline against
whatever has been rendered so far.

## Data

Coverage is **chosen, not inherited from a border**: 527 z10 cells over the
Alps, the Apennines, Corsica and the Dinarides, picked by hand in
`tools/coverage`. Inside it nothing is filtered — every named valley, peak, pass
and settlement. The pipeline deliberately makes no judgement about what is worth
learning; that is the builder's job.

| | count |
|---|---|
| Mountains | 73,758 |
| Valleys | 5,960 (merged from named ways) |
| Passes | 7,288 |
| Settlements | 68,807 |

Roads, glaciers, rivers, lakes and coastline are extracted as well, but nothing
downstream loads them: they exist only to be drawn into the basemap tiles, so
the browser never sees that geometry.

Two steps, deliberately separate, so changing how data is processed never means
downloading a country again:

```bash
# 1. Download every extract the coverage needs (~5.7 GB, resumable), clip each
#    to coverage, and filter it locally.   needs: brew install osmium-tool
npm run extract:data

# 2. Turn the extracts into what the browser loads, and into the vector tiles
#    the renderer draws from.              needs: brew install tippecanoe
npm run build:data
npm run build:data -- --skip-water                  # ~2 min saved
npm run build:data -- --skip-water --skip-context   # terrain only, ~3s
```

Water is by far the slowest layer and context the second; both change rarely, so
either can be skipped. The two skips together leave just the terrain layer,
which is what tuning how place names are thinned re-runs, so that loop is seconds
rather than minutes. Skipping either also skips the vector tiles, since half a
basemap is worse than no rebuild at all.

`extract:data` writes only to `pipeline/cache/osm/`; `build:data` reads only from
it. The one network call in step 2 is Wikidata sitelink counts, which are cached
on disk and requested only for ids not already held, so an interrupted run
resumes rather than restarting.

### Picking the ground, and paying for it

`npm run coverage` puts a z10 grid (~27 km squares) over a plain basemap, with
thermal.kk7.ch's skyways and thermals as overlays — because the ground worth
covering is the ground people actually fly, not the ground that looks dramatic
on a relief map. Clicking cells writes `pipeline/coverage.json` straight to disk
through a middleware, so coverage is a matter of clicking squares rather than
editing a list of indices.

**The choice decides the downloads.** Geofabrik publishes its region polygons in
`index-v1.json`, so the tool can work out which extracts cover the chosen cells
— and, more usefully, which combination costs the fewest bytes. Taking the
deepest matching region per cell looks right and is not: it hides `alps`, which
covers most of the selection in one file, behind a scatter of German
Regierungsbezirke. So the pick is a greedy set cover weighted by **bytes per
newly covered cell**, with real file sizes fetched by HEAD and cached to disk.
For the current selection that is 10 extracts and ~5.7 GB, `alps` chosen first.

`extract.ts` downloads each one, clips it with `osmium extract -p` *before*
filtering, and concatenates the results. Two things bit here. `osmium merge`
refuses extracts built on different days — "Node ID twice in input" — so sources
are filtered and exported one at a time and deduped by feature id on read, which
matters because `alps` and `italy` both hold Trentino. And a crashed export once
left a partial file newer than its inputs, which the next run read as up to date
and built a pool with 243 mountains and no valleys at all; every layer is now
written to a temp file and renamed into place.

### Why not Overpass

The first version chunked the download into Overpass queries. Small and medium
queries work fine, but the public endpoint reliably fell over above a certain
query weight — a 2° cell asking for way geometry drew connection resets — and a
country-sized pull meant hours of requests hostage to a free service. A regional
extract is one download, filtered in seconds, and re-filtering costs nothing.

### Chunking

The pool is far too big to load at once, so it ships as **z9 tiles** (~55 km
square at Alpine latitudes) under `web/public/data/<kind>/<cell>.geojson`, with
an `index.json` listing which cells hold anything. The app loads only the cells
its area touches, and only for the feature types that are switched on. Tiles
rather than the degree cells this started with, so that the chunk grid, the
coverage grid and the basemap pyramid are all the same arithmetic — `mercator.ts`
is the single implementation of it, shared by pipeline and browser.

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

**The basemap is not assembled in the browser and not bought from anyone.** It
is rendered once on a laptop — relief, both hillshade passes, glaciers, sea,
rivers, lakes and roads, all of it — into a pyramid of WebP tiles served from
Cloudflare R2. z4 to z11, 2,905 tiles, 127 MB for the whole coverage. No API
key, no tile bill, and nothing arrives pre-labelled.

It used to be assembled live, from MapLibre's `color-relief` and `hillshade`
over keyless Terrarium DEM tiles, with our own vector furniture over the top.
That worked, and the vector tiles were cheap — 70 KB a view — but **the DEM was
5.15 MB of a 6.3 MB first load, 82% of it**, because Terrarium PNGs encode
elevation at full precision and barely compress. Nothing queried that elevation
at runtime; it existed only to be shaded. So the shading happens once, on a
laptop. First load is now about 1 MB, a z6 view went from 10.9 MB to 70 KB, and
a drag frame from 440 ms to 106 ms.

The deepest view worth having was measured rather than assumed — z10.9, by
looking — which is what makes the pyramid 2,905 tiles rather than the 180,000 a
z14 ceiling would need. Raster sources *round* the zoom where vector sources
floor it, so 10.9 asks for z11, and z11 is exactly the top needed. `MAX_ZOOM` is
12, one level of overzoom past the tiles: soft on a retina screen at full zoom,
and the deliberate trade for a 127 MB pyramid over a roughly 580 MB one. It is
not a one-way door: re-rendering at @2x needs time and disk, not a code change.

**The style contains no symbol layers at all,** and a test enforces it. Standard
topo tiles print valley and peak names straight into the raster, which would
hand the player every answer. Nor is any name baked into ours: place names are
HTML markers built by app code, so they stay live, stay thinned per zoom, and
stay free to become multilingual later — the extracts already carry `name:de`,
`name:it` and `name:sl`. That also means no glyph endpoint and therefore no API
key. Because HTML markers do not collide-avoid the way symbol layers do, the
thinning that a symbol layer would have done for free is done in the pipeline,
once, for the whole coverage. Contours are drawn unlabelled for the same reason.

### Rendering the tiles

`npm run render:tiles` serves the render page and `node tools/render/render.mjs`
drives it through headless Chrome. It is **MapLibre GL JS, the same renderer the
app uses, over the same style builder** — which is the whole point. MapLibre
Native would be the obvious host, but `color-relief` was still in development
there as of late 2025, and Martin's renderer handles fill, line and circle only.
A second implementation's impression of this style is not this style: the
elevation palette was fitted by measurement against a reference render, and a
different engine's shading is a different answer.

Two things make the run bearable. Tiles are drawn **16 at a time** — a 2048 px
canvas is exactly a 4×4 block at its own zoom — so the pyramid costs a couple of
hundred screenshots rather than a couple of thousand. And the DEM is cached to
disk on the way through, so a re-render after a style change costs no network:
the full pyramid takes 5.6 minutes warm. A tile already on disk is never
redrawn, so an interrupted run resumes.

The capture waits on the map's `idle` event rather than a timeout, because this
failure mode is quiet: a tile grabbed before the DEM has arrived is blank but
perfectly well-formed, and looks exactly like a rendered one.

`node tools/render/upload.mjs` puts them in R2 — individual objects rather than
one archive, because coverage only ever grows, so adding a region uploads its
own new tiles and nothing else where a single PMTiles archive would be rebuilt
and re-sent whole. It skips what is already there unless given `--force`, and
credentials come from `.env`, which is gitignored. `Cache-Control` is a day
rather than a year: the tiles at a given path are *not* immutable, since a style
change replaces every one of them in place, and marked immutable they would sit
in edge caches until something purged them.

### The edge of coverage

Outside the pyramid the map draws a placeholder saying the ground is not
covered. A free third-party terrain layer was tried there first and dropped: it
made unsupported ground look like a working map, which is the opposite of what
the edge of coverage should say.

**Nothing decides that by taking a 404.** The 527 coverage cells ship in
`index.json`, about 5 KB, and a `tn://` protocol handler resolves every tile
request against them before the network is touched — so an uncovered tile costs
no request and no billed read. A tile that is *covered but missing* — mid-render,
a part-finished upload — deliberately fails instead, which leaves MapLibre
showing the parent tile scaled up. Blurry and continuous beats sharp and wrong,
and saying "not supported" over supported ground is a lie the user cannot tell
from the truth.

**The boundary is drawn once, in the tiles.** It used to be decided twice: the
renderer drew a low-zoom tile if any part of it was covered, while the client
asked the same question of a different grid, and the two disagreed more the
further out you zoomed — a z4 tile was 6% honest, z6 23%, z8 56%. The hatch
marking uncovered ground is now painted into the tile itself at z10 cell
resolution, so a wide view shows exactly which squares exist. The pattern is
offset by the tile's own position so it runs continuously across seams.

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

**The choice is made offline, in `placeZoom.ts`, and the browser only reads the
answer.** Every settlement ships a `minzoom` — and, for the few that hand over,
a `maxzoom` — and drawing a name is then `minzoom <= zoom < maxzoom` plus "does
any of the text reach the screen". Two independent tests per label. Nothing to
sort, nothing to evict, no order for the result to depend on.

It used to be a greedy screen-space pass, run on every frame over whatever the
viewport had loaded, and it churned. A global greedy cascades: one candidate
arriving at the edge of the fetched box can evict a name in the middle of the
screen, and every zoom change moves all the pixel distances together and
reshuffles whole clusters. There is no `pad` that fixes that — a wider pad only
moves the boundary the churn happens at. It has to stop being a decision the
viewport can participate in, which is what the whole vector-tile world does:
tippecanoe's label grid, OpenMapTiles' `rank`.

So the pass runs over the whole coverage at once, in **world pixels** rather than
degrees, admitting names strongest first — tier, then population, then OSM id so
the answer is reproducible — and recording the first zoom each one fits at. It
measures the same box `labels.ts` draws with, including the per-rank font sizes,
because one flat character width under-measured city names by a quarter.

The whole thing rests on one property: world coordinates double per zoom while
label boxes do not. So a set that clears itself at one zoom clears itself at
every zoom above it, on both axes, exactly — which is why an integer-zoom
decision is safe to use at 11.7, and why nothing has to be recomputed as the map
moves. Names fade in over a quarter of a zoom rather than popping, and the fade
goes *inward* from each end of the range: drawn any earlier, a name would sit
closer to its neighbour than the pass ever validated.

**Coarse names hand over.** Zoom far enough into Trento and "Trento" gives way to
Sardagna, Povo and Vela — the ground has outgrown the name, and the word is left
sitting on one arbitrary street. It takes both halves of having gone past it:
the map has to be drawing the city's own ground wider than a screen, *and* three
finer names inside that ground must already be drawn with the nearest of them
close to where the old one was. Either half alone gets it wrong. On the count
alone Trento loses its name at z12, with twenty kilometres still on screen; on
the scale alone, empty country goes unnamed. Twenty-five names hand over, every
one of them a city — a village's ground is a few hundred metres, which the map
is never inside.

The cost, stated plainly: dead-centre on a handed-over city at the deepest zoom,
a phone can end up with no name on screen at all. `HANDOVER_PX` is the dial, and
zero retirements is `TAKEOVER` set past any real count.

**A name with no room at any zoom is dropped, not clamped to the ceiling.** The
ceiling is z12, matching the map's, and 38,245 of 107,052 names never fit below
it. Giving them the ceiling as a minzoom would stack every one of them on the
deepest zoom, which is not thinning; leaving them out takes the places directory
from 19 MB to 12 MB.

Because the answer is per-label, **there is nothing to settle before fetching.**
The names refresh on every view change, straight through: what it costs is a
filter over cells already in memory, about two milliseconds at the widest view
and a fraction of one at a valley. There was a 250 ms debounce there while the
collision pass still existed, because a batch landing late could reshuffle names
already on screen — and it was, on measurement, the entire pause you saw after a
pan. A late batch can only add now, so it went.

The fetch box is stated in pixels, and asks for the view plus about half a
label's reach. An unmeasured canvas gets no pad rather than a guessed one:
treating a canvas of zero as one pixel makes the pad four hundred times the
view, which touches every cell in the pool — that is how opening the builder
briefly came to download the whole settlement pool, twelve megabytes of it,
before drawing a single name.

### Shading is two passes

`hillshade` runs twice — at render time now, but the reasoning is unchanged and
still lives in the style the renderer draws with. The first pass does the
modelling; the second is shadow-only, with no highlight at all, purely to deepen
the dark end.

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
  extract.ts       Geofabrik pbf -> clipped, filtered GeoJSON-seq  (osmium)
  process.ts       GeoJSON-seq -> chunked GeoJSON + index.json
  tiles.ts         the drawn layers -> context.pmtiles     (tippecanoe)
  coastline.ts     ocean polygons from the OSM water shapefile
  coverage.ts      reading coverage.json, and its rectangles
  source.ts        streams the extracts, dedupes by id
  normalize.ts     merge same-named segments by proximity
  stitch.ts        join road ways into maximal chains at junctions
  importance.ts    popularity scoring + Wikidata sitelinks
  spatial.ts       grid index: nearest higher peak, radius queries
  placeZoom.ts     which zooms each settlement is named at
  simplify.ts      Douglas-Peucker
  mercator.ts      web mercator and tile maths, shared with the browser
  grid.ts          the chunk grid, in tiles
tools/             dev tools, on their own Vite roots
  coverage/        pick the ground, and the extracts that cover it cheapest
  render/          draw the tile pyramid, and upload it to R2
web/src/lib/
  terrain.ts       elevation palette and DEM source     (pure)
  mapStyle.ts      the rendered style, and the app's    (pure)
  builder.ts       inclusion rules, pins, resolution    (pure)
  selection.ts     the crop frame, in pixels            (pure)
  places.ts        reading a name's zoom range          (pure)
  quiz.ts          quiz state machine                   (pure)
  labels.ts        how much ink a name puts on screen   (pure)
  grid.ts          client half of the chunk grid        (pure)
  tiles.ts         the tn:// protocol and coverage
  chunks.ts        cell loading and caching
  storage.ts       localStorage
  MapView.svelte   MapLibre, both play and build modes
```

The pure modules hold the logic worth being sure about, and are directly
unit-tested — including two that live in the pipeline, `placeZoom.ts` and
`stitch.ts`, tested from here because this is where the test runner is:

```bash
npm test             # 139 tests
npm run typecheck    # pipeline, web and the tools
```

## Known gaps

- **No massif names.** OSM has no consistent tagging for ranges like "the Brenta
  Dolomites", so ranges cannot be quizzed as objects.
- **Peak isolation uses named peaks only.** An unnamed higher summit nearby will
  not reduce a peak's isolation. In practice a named sub-summit's nearest higher
  neighbour is the named main summit it hangs off, so this holds up.
- **Coverage is a set of squares, and the builder does not check it.** Frame an
  area outside the rendered ground and you get a placeholder basemap and an
  empty quiz rather than a refusal. The bundled coverage set is right there; it
  is simply not consulted at that point yet.
- **`web/public/data/` is ~39 MB**, of which place names are 12 MB and peaks
  20 MB. That is a hosting number, not a per-visit one: cells load individually,
  and a Val Rendena viewport pulls a few hundred kilobytes across four cells.
  The basemap's 127 MB is not on that server at all — it is in R2, where egress
  is free.
- **A style change now costs a re-render**, not a page refresh. Changing the
  palette or a road colour means redrawing the pyramid — six minutes with a warm
  DEM cache — and re-uploading 127 MB with `--force` before anyone sees it. The
  palette was fitted by measurement and is settled, so this is an accepted cost
  rather than a live problem, but it is the one that does not show up in the
  byte counts.
- **Green follows elevation, not land cover.** The reference style colours by
  what is actually on the ground, so its treeline bends with aspect and shelter
  while ours is a horizontal band. Fixing that means shipping a landcover layer.
