<script lang="ts">
  import { untrack } from 'svelte';
  import maplibregl from 'maplibre-gl';
  import AreaSelect from './AreaSelect.svelte';
  import { labelReachesScreen, layoutLabels } from './labels.ts';
  import {
    clampRect,
    defaultRect,
    fitPadding,
    regionFor,
    sameRect,
    scaleRect,
    type Inset as Chrome,
    type Rect,
  } from './selection.ts';
  import {
    buildStyle,
    firstPickable,
    LAYER_GEOMETRY,
    PICK_LAYERS,
    type MapMode,
  } from './mapStyle.ts';
  import { isIncluded, isLocked } from './builder.ts';
  import type {
    ContextCollection,
    FeatureFile,
    Inclusion,
    MapLabel,
    PlaceFeature,
    ViewState,
  } from './types.ts';

  type Props = {
    collection: FeatureFile;
    context: ContextCollection;
    mode?: MapMode;
    /** Feature ids drawn for the current round. Play mode only. */
    activeIds?: string[];
    /** The area's extent. Framed and leashed in play, only framed in build. */
    bbox: [number, number, number, number];
    /** How far the player may roam in build mode — the extent of the data. */
    coverage?: [number, number, number, number];
    /** Answered features: id -> grade (0 found first try … 1 had to be shown). */
    graded?: Record<string, number>;
    /** A feature clicked by mistake, shown amber while its label is up. */
    missId?: string | null;
    /** The answer being pointed out: flashes and pulses until it is clicked. */
    revealId?: string | null;
    labels?: MapLabel[];
    /** Build mode: what the current filters and locks make of each feature. */
    shade?: Record<string, Inclusion>;
    /** Build mode: the crop frame is live, and reports the area it covers. */
    selecting?: boolean;
    /** An area to open the frame on, so editing adjusts the one the quiz has. */
    selected?: [number, number, number, number] | null;
    /** Room the frame must leave for chrome drawn over the map, in pixels. */
    selectInset?: Partial<Chrome>;
    /** The ground inside the frame, reported as it changes. */
    onarea?: (box: [number, number, number, number]) => void;
    /** Settlement names drawn as an orientation aid. */
    places?: PlaceFeature[];
    enabled?: boolean;
    /** Height of the prompt bar drawn over the map, in pixels. */
    chromeTop?: number;
    onpick: (id: string | null) => void;
    onview?: (view: ViewState) => void;
  };

  let {
    collection,
    context,
    mode = 'play',
    activeIds,
    bbox,
    coverage,
    graded = {},
    missId = null,
    revealId = null,
    labels = [],
    shade = {},
    selecting = false,
    selected = null,
    selectInset = {},
    places = [],
    enabled = true,
    chromeTop = 0,
    onpick,
    onview,
    onarea,
  }: Props = $props();

  /** How fast the revealed feature blinks. */
  const FLASH_MS = 420;
  /**
   * How much ground past the features the player may see.
   *
   * A share of the visible map rather than a fixed count of pixels: 100px is a
   * tenth of a desktop window but a quarter of a phone's width, and a quarter
   * of the screen spent on ground outside the quiz is a lot of glass to waste.
   * The floor is what the other job of the slack needs — a feature on the very
   * edge of the area has to be draggable clear of the screen edge far enough to
   * read and to tap, and a fingertip is about 44px whatever the device.
   */
  const PAN_SLACK_SHARE = 0.12;
  const PAN_SLACK_MIN_PX = 48;
  const PAN_SLACK_MAX_PX = 120;
  /** Breathing room left around the area when framing it, in screen pixels. */
  const FRAME_MARGIN_PX = 40;
  /** As far in as the terrain data is worth showing. */
  const MAX_ZOOM = 14;
  /** Below this, naming every candidate would be unreadable anyway. */
  const NAME_FROM_ZOOM = 9.5;
  /**
   * A ceiling, not a quota. Which names appear should follow zoom and available
   * space; a tight cap would make it follow the viewport instead, so that
   * panning a busier area into view silently evicted labels elsewhere.
   */
  const MAX_PLACE_LABELS = 140;
  /**
   * How far off screen place names still compete, in pixels. Comfortably wider
   * than the longest of them, so one sliding into view cannot displace a name
   * already drawn. Only the place names are thinned; the builder's own labels
   * are all drawn (see `drawn`).
   */
  const LABEL_PAD = 320;
  /** How long two fingers may rest before their lift stops being a tap. */
  const TWO_FINGER_TAP_MS = 500;
  /** How far a two-finger tap may travel and still be a tap. MapLibre's own. */
  const TAP_SLOP_PX = 30;

  /**
   * MapLibre feature-state needs a stable id it can index on, so every feature
   * gets a numeric one and the source promotes it. The OSM id stays in the
   * properties for talking to the quiz logic.
   */
  const indexed = $derived({
    type: 'FeatureCollection' as const,
    features: collection.features.map((feature, idx) => ({
      ...feature,
      properties: { ...feature.properties, idx, osmId: feature.id },
    })),
  });
  const idxOf = $derived(new Map(collection.features.map((feature, idx) => [feature.id, idx])));
  const byId = $derived(new Map(collection.features.map((feature) => [feature.id, feature])));

  /**
   * What the prompt hides. Map is drawn under it, so it is not ground the
   * player can see — everything else over the map is a small floating control
   * with map either side of it.
   */
  const chrome = $derived({ top: chromeTop, bottom: 0, left: 0, right: 0 });
  /** The box the area is framed into when the view opens. */
  const framePad = $derived({
    top: chromeTop + FRAME_MARGIN_PX,
    bottom: FRAME_MARGIN_PX,
    left: FRAME_MARGIN_PX,
    right: FRAME_MARGIN_PX,
  });

  /**
   * Where the features actually are, which is what the camera is answerable
   * to. Not the `bbox` prop: a saved quiz stores its extent padded by a
   * fraction of its own span, and a fraction of a span is a different number
   * of pixels at every zoom — anchoring to it would put the slack back on the
   * sliding scale this is meant to have taken it off.
   */
  const bounds = $derived.by(() => {
    let box: [number, number, number, number] | null = null;
    for (const feature of collection.features) {
      const at = feature.bbox;
      box = box
        ? [
            Math.min(box[0], at[0]),
            Math.min(box[1], at[1]),
            Math.max(box[2], at[2]),
            Math.max(box[3], at[3]),
          ]
        : [at[0], at[1], at[2], at[3]];
    }
    return box ?? bbox;
  });

  let container: HTMLDivElement;
  /**
   * The map, once it is usable, and `undefined` again the moment it goes away,
   * so `map` alone answers "is there a map to talk to".
   *
   * Effect teardowns that undo a highlight must read this rather than the
   * instance they captured: on unmount Svelte tears effects down in the order
   * they were created, so the map — built by the first effect below — is already
   * removed by the time they run, and a removed map has no style to write to.
   */
  let map: maplibregl.Map | undefined = $state();
  let hoveredId = $state<string | null>(null);
  /** Bumped on every move, so label layout recomputes against the new screen. */
  let viewTick = $state(0);
  /** The canvas the crop frame is measured against, in CSS pixels. */
  let canvasSize = $state({ width: 0, height: 0 });
  /**
   * The crop frame, and the region it was last fitted to.
   *
   * The two travel together because carrying a frame across a change of region
   * needs the one it came from, and a region recomputed from the current canvas
   * is by then the new one.
   */
  let crop = $state<{ rect: Rect; region: Rect } | null>(null);

  const pad = (box: [number, number, number, number], lon: number, lat: number) =>
    [
      [box[0] - lon, box[1] - lat],
      [box[2] + lon, box[3] + lat],
    ] as [[number, number], [number, number]];

  type Inset = { top: number; bottom: number; left: number; right: number };

  /**
   * The area and a box on screen to judge it against, in the units the camera
   * works in: mercator (0..1 across the world) for the area, pixels for the
   * box. Two boxes get used. The leash is judged against `chrome` — what the
   * player can see — because the rule it enforces is about what reaches their
   * eyes. The opening view is judged against `framePad`, which adds margins so
   * the area does not open flush against the edges.
   */
  function framing(
    size: { width: number; height: number },
    box: [number, number, number, number],
    inset: Inset,
  ) {
    const nw = maplibregl.MercatorCoordinate.fromLngLat({ lng: box[0], lat: box[3] });
    const se = maplibregl.MercatorCoordinate.fromLngLat({ lng: box[2], lat: box[1] });
    return {
      nw,
      se,
      inset,
      width: size.width - inset.left - inset.right,
      height: size.height - inset.top - inset.bottom,
      /** Half the canvas — where MapLibre draws whatever centre it is given. */
      half: { x: size.width / 2, y: size.height / 2 },
    };
  }

  /** The canvas an existing map is drawn on, in CSS pixels. */
  const sizeOf = (instance: maplibregl.Map) => {
    const canvas = instance.getCanvas();
    return { width: canvas.clientWidth, height: canvas.clientHeight };
  };

  type Framing = ReturnType<typeof framing>;

  /** The slack, in pixels, for a given visible map. Measured on its shorter
   * side, so it reads the same however the window is turned. */
  const slackFor = (shape: Framing) =>
    Math.min(
      Math.max(PAN_SLACK_SHARE * Math.min(shape.width, shape.height), PAN_SLACK_MIN_PX),
      PAN_SLACK_MAX_PX,
    );

  /** The zoom at which `mercator` units of world cover `px` pixels. */
  const zoomFor = (px: number, mercator: number) =>
    px <= 0 ? -Infinity : Math.log2(px / (mercator * 512));

  /** The zoom that puts the whole area inside the box. */
  const fitZoom = (shape: Framing) =>
    Math.min(
      zoomFor(shape.width, shape.se.x - shape.nw.x),
      zoomFor(shape.height, shape.se.y - shape.nw.y),
    );

  /**
   * The lowest zoom the leash can still be honoured at: below it the box is
   * wider than the area and its slack put together, so no centre satisfies the
   * rule and that axis has to be pinned instead.
   */
  const leashZoom = (shape: Framing) => {
    const slack = slackFor(shape);
    return Math.max(
      zoomFor(shape.width - 2 * slack, shape.se.x - shape.nw.x),
      zoomFor(shape.height - 2 * slack, shape.se.y - shape.nw.y),
    );
  };

  /** The centre that sits the area in the middle of the box. */
  function centred(shape: Framing, zoom: number) {
    const world = 512 * 2 ** zoom;
    return new maplibregl.MercatorCoordinate(
      (shape.nw.x + shape.se.x) / 2 - (shape.inset.left - shape.inset.right) / 2 / world,
      (shape.nw.y + shape.se.y) / 2 - (shape.inset.top - shape.inset.bottom) / 2 / world,
    ).toLngLat();
  }

  /**
   * The leash: how much ground past the features the player may drag into
   * view. The same amount of it, on every side, at every zoom.
   *
   * `maxBounds` cannot express that — it is a fixed span of degrees, so the
   * slack it leaves is worth more and more pixels the further in you zoom.
   * Neither can a bbox padded by a fraction of itself, for the same reason.
   * Only a rule stated in pixels and applied at the requested zoom holds still.
   *
   * MapLibre asks this for a verdict on every camera change, before the change
   * lands, so there is nothing to correct after the fact and inertia is left to
   * the engine. Below `leashZoom` the two limits cross and the axis pins to the
   * middle of the range it could not satisfy.
   */
  function leash(instance: maplibregl.Map, box: [number, number, number, number]) {
    return (lngLat: maplibregl.LngLat, zoom: number) => {
      // Overriding the constrain replaces the zoom clamp too, so redo it here.
      const held = Math.min(Math.max(zoom, instance.getMinZoom()), instance.getMaxZoom());
      const shape = framing(sizeOf(instance), box, chrome);
      const slack = slackFor(shape);
      const world = 512 * 2 ** held;
      const at = maplibregl.MercatorCoordinate.fromLngLat(lngLat);
      // Clamps one axis of the centre. `near` and `far` are its distances, in
      // pixels, to the two edges of the box on that axis.
      const hold = (centre: number, lo: number, hi: number, near: number, far: number) => {
        const min = lo * world - slack + near;
        const max = hi * world + slack - far;
        const px = min > max ? (min + max) / 2 : Math.min(Math.max(centre * world, min), max);
        return px / world;
      };
      return {
        center: new maplibregl.MercatorCoordinate(
          hold(
            at.x,
            shape.nw.x,
            shape.se.x,
            shape.half.x - shape.inset.left,
            shape.half.x - shape.inset.right,
          ),
          hold(
            at.y,
            shape.nw.y,
            shape.se.y,
            shape.half.y - shape.inset.top,
            shape.half.y - shape.inset.bottom,
          ),
        ).toLngLat(),
        zoom: held,
      };
    };
  }

  /**
   * The camera a play view opens on, and the floor it may not zoom out past.
   *
   * Worked out from a size rather than from a map, so the map can be built
   * looking at exactly this and never has to be moved afterwards. A map that
   * opens somewhere else and corrects itself on load does not just jump under
   * the player — it has already spent a round of tile requests on the view it
   * was about to abandon.
   *
   * The floor is the lower of two zooms: the one that shows the whole area, and
   * the one below which the leash stops being satisfiable. Taking the lower
   * keeps the whole area reachable when its shape does not match the window's —
   * an area much wider than it is tall cannot fill a squarer window, and the
   * alternative to relaxing the leash for that last stretch would be to crop
   * the quiz and never show it whole.
   */
  function opening(size: { width: number; height: number }, box: [number, number, number, number]) {
    const shape = framing(size, box, framePad);
    const zoom = Math.min(Math.max(fitZoom(shape), 0), MAX_ZOOM);
    return {
      center: centred(shape, zoom),
      zoom,
      minZoom: Math.max(Math.min(zoom, leashZoom(framing(size, box, chrome))), 0),
    };
  }

  /**
   * Frames the area and locks the view to it. On first load this repeats what
   * the map was built with and changes nothing; on resize it recuts both the
   * framing and the leash for the new window.
   */
  function frame(instance: maplibregl.Map) {
    // The previous area's limits would constrain this fit, so clear them first.
    instance.setMaxBounds(null);
    instance.setTransformConstrain(null);
    instance.setMinZoom(0);

    // Choosing an area means going wherever you like inside the coverage.
    if (mode === 'build') {
      instance.fitBounds(pad(bbox, 0.02, 0.02), { padding: framePad, duration: 0 });
      if (coverage) {
        instance.setMaxBounds([
          [coverage[0], coverage[1]],
          [coverage[2], coverage[3]],
        ]);
      }
      return;
    }

    const camera = opening(sizeOf(instance), bounds);
    instance.setMinZoom(camera.minZoom);
    instance.setTransformConstrain(leash(instance, bounds));
    instance.jumpTo({ center: camera.center, zoom: camera.zoom });
  }

  /** Where the crop frame may go: the canvas, less its margins and the panel. */
  const cropRegion = $derived(regionFor(canvasSize, selectInset));

  /** The ground under a frame, and the frame over a piece of ground. */
  const boxOf = (
    instance: maplibregl.Map,
    rect: Rect,
  ): [number, number, number, number] => {
    const nw = instance.unproject([rect.left, rect.top]);
    const se = instance.unproject([rect.right, rect.bottom]);
    return [nw.lng, se.lat, se.lng, nw.lat];
  };
  const rectOf = (instance: maplibregl.Map, box: [number, number, number, number]): Rect => {
    const nw = instance.project([box[0], box[3]]);
    const se = instance.project([box[2], box[1]]);
    return { left: nw.x, top: nw.y, right: se.x, bottom: se.y };
  };

  /**
   * Opens the crop frame, and puts it away again.
   *
   * Reopening a saved quiz has to offer the area that quiz was built with, so
   * the map is fitted to it and the frame set to wherever it landed — with
   * padding that leaves slack on every side, because "change the area" has to
   * mean either direction and a frame flush against its limits can only shrink.
   *
   * Only `selecting` and `selected` are tracked. The region and the canvas are
   * not: the frame is what reports the area, so one that re-opened on every pan
   * — or on every window resize, which moves the region — would undo the
   * trimming that prompted it. `selected` is tracked because it changes only
   * when an area is committed or recovered, and a frame opened before a saved
   * area had finished loading should still pick it up.
   *
   * The camera move is untracked for a sharper reason. `fitBounds` fires `move`
   * synchronously, so the handler above runs inside this effect — and `report`
   * reads `bounds`, which would quietly make an effect that moves the camera
   * depend on where the camera is. It never settles: each fit lands a few
   * floating-point ulps from the last, so the frame is recomputed, which fits
   * again, forever. Untracking the move keeps the reads inside it out of this
   * effect's dependencies.
   */
  $effect(() => {
    if (!map || !selecting) {
      crop = null;
      return;
    }
    const instance = map;
    const area = selected;
    const region = untrack(() => cropRegion);
    if (!area) {
      crop = { rect: defaultRect(region), region };
      return;
    }
    untrack(() => {
      instance.fitBounds(
        [
          [area[0], area[1]],
          [area[2], area[3]],
        ],
        { padding: fitPadding(canvasSize, region), duration: 0 },
      );
      crop = { rect: clampRect(rectOf(instance, area), region), region };
    });
  });

  /** A resized window is a different region, so the frame is carried into it. */
  $effect(() => {
    const region = cropRegion;
    const held = untrack(() => crop);
    if (!held || sameRect(held.region, region)) return;
    crop = { rect: scaleRect(held.rect, held.region, region), region };
  });

  /**
   * What the frame currently covers.
   *
   * Recomputed on every move as well as on every drag: the frame holds still on
   * screen while the ground slides under it, so panning and zooming change the
   * selection just as dragging a handle does.
   *
   * The callback is *read* untracked, not merely called. A parent that stores
   * what it is handed re-renders, and if that hands down a fresh closure, an
   * effect depending on it would run again and report again, forever. What the
   * frame covers should be recomputed when the frame or the camera moves, and
   * at no other time.
   */
  $effect(() => {
    void viewTick;
    const held = crop;
    if (!map || !held) return;
    const box = boxOf(map, held.rect);
    untrack(() => onarea?.(box));
  });

  /**
   * Features that are finished with: answered already, or the wrong one being
   * held up right now. Clicks fall straight through them.
   */
  const spent = $derived(
    new Set(missId ? [...Object.keys(graded), missId] : Object.keys(graded)),
  );

  /**
   * Two-stage hit test: a tight box first so a deliberate click on one of two
   * adjacent features lands where the player aimed, then a forgiving one so
   * thin lines and small circles stay clickable on a trackpad.
   */
  function pickAt(instance: maplibregl.Map, point: maplibregl.Point): string | null {
    for (const tolerance of [4, 14]) {
      const hits = instance.queryRenderedFeatures(
        [
          [point.x - tolerance, point.y - tolerance],
          [point.x + tolerance, point.y + tolerance],
        ],
        { layers: PICK_LAYERS.filter((id) => instance.getLayer(id)) },
      );
      const osmId = firstPickable(hits, spent);
      if (osmId !== null) return osmId;
    }
    return null;
  }

  function report(instance: maplibregl.Map) {
    const view = instance.getBounds();
    const box: [number, number, number, number] = [
      view.getWest(),
      view.getSouth(),
      view.getEast(),
      view.getNorth(),
    ];
    onview?.({
      view: box,
      covers:
        box[0] <= bounds[0] &&
        box[1] <= bounds[1] &&
        box[2] >= bounds[2] &&
        box[3] >= bounds[3],
    });
  }

  /**
   * Builds the map exactly once.
   *
   * Every read here is untracked on purpose. `buildStyle` and the initial
   * `bounds` read `indexed`, `context` and `bbox`, and left tracked they make
   * the map itself depend on its own data — so loading a chunk, or toggling a
   * feature type, would tear the whole map down and construct a new one, which
   * reads on screen as the map zooming out and back in. The source is kept
   * current by the `setData` effects below instead.
   */
  $effect(() => {
    const initial = untrack(() => ({
      camera:
        mode === 'play'
          ? opening(
              { width: container.clientWidth, height: container.clientHeight },
              bounds,
            )
          : null,
      style: buildStyle(
        context as GeoJSON.FeatureCollection,
        indexed as GeoJSON.FeatureCollection,
        mode,
      ),
    }));

    const instance = new maplibregl.Map({
      container,
      // Built looking where it means to stay. The builder has no leash, so it
      // is framed the same way `frame` frames it, by the same call.
      ...(initial.camera
        ? { center: initial.camera.center, zoom: initial.camera.zoom, minZoom: initial.camera.minZoom }
        : {
            bounds: pad(bbox, 0.02, 0.02),
            fitBoundsOptions: { padding: framePad },
          }),
      maxZoom: MAX_ZOOM,
      dragRotate: false,
      attributionControl: false,
      style: initial.style,
    });

    // Before the first frame is drawn, so nothing can be shown off the leash.
    if (mode === 'play') instance.setTransformConstrain(leash(instance, untrack(() => bounds)));

    // Added before the zoom buttons so it lands under them, flush in the corner:
    // MapLibre *prepends* controls in a bottom corner, so the first one added is
    // the one nearest the edge.
    //
    // `compact: false` because the collapsed form is a white pill with an info
    // button — furniture that looks like a control you are meant to press, on a
    // screen where pressing things is the whole game. Styled down to a line of
    // faint text in styles.css.
    instance.addControl(
      new maplibregl.AttributionControl({
        compact: false,
        customAttribution: '© OpenStreetMap contributors',
      }),
      'bottom-right',
    );
    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    instance.on('load', () => {
      frame(instance);
      canvasSize = sizeOf(instance);
      map = instance;
      report(instance);
    });
    instance.on('move', () => {
      report(instance);
      viewTick++;
    });
    // A resized window changes what "fits", so the play leash has to be recut.
    // The builder deliberately does not re-frame: its camera belongs to the
    // user, and re-fitting would both move it under them and, because a fit
    // pads outwards, ratchet the framed area wider on every resize.
    instance.on('resize', () => {
      if (mode === 'play') frame(instance);
      canvasSize = sizeOf(instance);
      viewTick++;
    });

    return () => {
      map = undefined;
      instance.remove();
    };
  });

  // The builder swaps in a whole new area as you pan, so the source is updated
  // in place rather than rebuilding the map.
  $effect(() => {
    if (!map) return;
    const source = map.getSource('features') as maplibregl.GeoJSONSource | undefined;
    source?.setData(indexed as GeoJSON.FeatureCollection);
  });

  $effect(() => {
    if (!map) return;
    const source = map.getSource('context') as maplibregl.GeoJSONSource | undefined;
    source?.setData(context as GeoJSON.FeatureCollection);
  });

  // Play draws only the round's features — the player chooses between visible
  // candidates, Seterra-style, rather than hunting blank terrain. The builder
  // draws everything, because what you are excluding is part of the decision.
  $effect(() => {
    if (!map) return;
    const round =
      mode === 'play' && activeIds
        ? (['in', ['get', 'idx'], ['literal', activeIds.flatMap((id) => idxOf.get(id) ?? [])]] as maplibregl.FilterSpecification)
        : null;

    // Keep each layer's geometry restriction — replacing the filter outright is
    // what would let the circle layer speckle dots along every valley line.
    for (const [id, geometry] of Object.entries(LAYER_GEOMETRY)) {
      if (!map.getLayer(id)) continue;
      map.setFilter(
        id,
        (round
          ? ['all', geometry, round]
          : geometry) as unknown as maplibregl.FilterSpecification,
      );
    }
  });

  $effect(() => {
    if (!map) return;
    for (const [id, idx] of idxOf) {
      if (mode === 'build') {
        const inclusion = shade[id] ?? 'auto-out';
        map.setFeatureState(
          { source: 'features', id: idx },
          { included: isIncluded(inclusion), locked: isLocked(inclusion) },
        );
        continue;
      }
      const grade = graded[id];
      map.setFeatureState(
        { source: 'features', id: idx },
        {
          answered: grade !== undefined,
          grade: grade ?? 0,
          miss: id === missId,
          flash: false,
        },
      );
    }
  });

  /**
   * Lights the feature under the pointer, and puts it out again when the
   * pointer moves on.
   *
   * Kept apart from the effect above rather than folded into its loop: that one
   * rewrites every feature whenever a grade or a miss changes, and a hover
   * changes far more often than either. `setFeatureState` merges, so writing
   * one key here leaves the answer state the other effect owns untouched.
   *
   * Only unanswered features are ever lit, because `pickAt` is the only source
   * of `hoveredId` and it refuses to return a feature that is already spent.
   */
  $effect(() => {
    if (!map || !hoveredId) return;
    const instance = map;
    const idx = idxOf.get(hoveredId);
    if (idx === undefined) return;
    instance.setFeatureState({ source: 'features', id: idx }, { hover: true });
    return () => map?.setFeatureState({ source: 'features', id: idx }, { hover: false });
  });

  /**
   * Blinks the revealed feature and pulses a ring at it, panning there first if
   * it is off screen. It blinks rather than staying red because the player still
   * has to go and click it — a static highlight is something you look at, a
   * blinking one is something you go to.
   */
  $effect(() => {
    if (!map || !revealId) return;
    const instance = map;
    const idx = idxOf.get(revealId);
    const target = byId.get(revealId);
    if (idx === undefined || !target) return;

    const box = target.bbox;
    const view = instance.getBounds();
    const onScreen =
      view.getWest() <= box[0] &&
      view.getSouth() <= box[1] &&
      view.getEast() >= box[2] &&
      view.getNorth() >= box[3];
    if (!onScreen) {
      instance.fitBounds(
        [
          [box[0], box[1]],
          [box[2], box[3]],
        ],
        {
          padding: framePad,
          // Never zoom further in than the player already was; they chose that
          // scale and yanking it away is disorienting.
          maxZoom: instance.getZoom(),
          duration: 500,
        },
      );
    }

    let on = true;
    const blink = () => {
      instance.setFeatureState({ source: 'features', id: idx }, { flash: on });
      on = !on;
    };
    blink();
    const timer = setInterval(blink, FLASH_MS);

    const element = document.createElement('div');
    element.className = 'map-pulse';
    const marker = new maplibregl.Marker({ element })
      .setLngLat(target.properties.anchor)
      .addTo(instance);

    return () => {
      clearInterval(timer);
      map?.setFeatureState({ source: 'features', id: idx }, { flash: false });
      marker.remove();
    };
  });

  type Drawn = {
    key: string;
    text: string;
    at: [number, number];
    className: string;
    /** Ink for the label's text, where the class does not already fix it. */
    color?: string;
  };

  /**
   * Everything to write on the map, already thinned so nothing overlaps.
   *
   * Play labels the answers as they land; the builder labels what is currently
   * selected, because you cannot hand-pick "the 2 km valley I know" without
   * being able to read which line it is.
   */
  const drawn = $derived.by((): Drawn[] => {
    void viewTick;
    if (!map) return [];
    const instance = map;
    const canvas = instance.getCanvas();
    const size = { width: canvas.clientWidth, height: canvas.clientHeight };
    const project = (at: [number, number]) => instance.project(at);

    const out: Drawn[] = [];

    if (mode === 'play') {
      for (const label of labels) {
        const anchor = byId.get(label.featureId)?.properties.anchor;
        if (anchor) {
          out.push({
            // The tone is part of the identity: a feature going from wrong
            // to answered is a new label that should animate in, not the old
            // one restyled in place.
            key: `f:${label.featureId}:${label.tone}`,
            text: label.text,
            at: anchor,
            className: `map-label map-label--${label.tone}`,
            color: label.color,
          });
        }
      }
    } else if (instance.getZoom() >= NAME_FROM_ZOOM) {
      /*
       * Every selected feature is named, with no collision pass — deliberately
       * unlike the place names below.
       *
       * Thinning is right for the basemap, where the names are scenery and any
       * one of them is expendable. It is wrong here: these names *are* the
       * selection, and a builder counting what is in the quiz cannot be shown
       * an arbitrary subset of it. Dropping the pass also drops the shuffling
       * that came with it, where hovering promoted one name over everything
       * around it and evicted whatever it happened to touch.
       *
       * Set as plateless haloed text rather than filled boxes, which is what
       * makes that affordable: they overlap without blotting each other or the
       * terrain out, so nothing has to be evicted to keep the map readable.
       */
      for (const feature of collection.features) {
        const included = isIncluded(shade[feature.id] ?? 'auto-out');
        const hovered = feature.id === hoveredId;
        // Excluded features are named only while pointed at — that is the
        // builder asking about this one, not a name it wants on the map.
        if (!included && !hovered) continue;

        // Drawn once any of the name reaches the map, not once its anchor does
        // — the same rule the place names use. A valley's anchor sits mid-line,
        // so culling by the point alone withheld names whose text was already
        // well inside the edge.
        if (!labelReachesScreen(project(feature.properties.anchor), feature.properties.name, size)) {
          continue;
        }

        out.push({
          key: `f:${feature.id}`,
          text: feature.properties.name,
          at: feature.properties.anchor,
          className:
            `map-label map-label--build` +
            `${included ? '' : ' is-out'}${hovered ? ' is-hover' : ''}`,
        });
      }
    }

    if (places.length > 0) {
      const candidates = places.map((place) => ({
        priority: 100 - place.properties.rank,
        text: place.properties.name,
        item: place,
        // Settlements are points, so name plus position is a sound identity.
        key: `${place.properties.name}@${place.geometry.coordinates.join(',')}`,
      }));
      for (const placed of layoutLabels(
        candidates,
        (place) => project(place.geometry.coordinates),
        { ...size, pad: LABEL_PAD, max: MAX_PLACE_LABELS },
      )) {
        out.push({
          key: `p:${placed.text}@${placed.item.geometry.coordinates.join()}`,
          text: placed.text,
          at: placed.item.geometry.coordinates,
          className: `map-place map-place--r${placed.item.properties.rank}`,
        });
      }
    }

    return out;
  });

  /** Labels currently on the map, by key, so they can be reconciled in place. */
  const live = new Map<string, { marker: maplibregl.Marker; label: Drawn }>();

  /**
   * Place and feature names are HTML markers, never a symbol layer. The style
   * has no symbol layers at all, so no text can reach the map except through
   * here, where the app decides what may be shown.
   *
   * The set is reconciled by key rather than rebuilt. Every `move` bumps
   * `viewTick` so the layout can be recut against the new screen, and tearing
   * the markers down each time restarted `label-in` on every surviving label —
   * which, since that animation starts at zero opacity, left the wrong-guess
   * and reveal labels invisible for as long as the player kept panning.
   */
  $effect(() => {
    const instance = map;
    if (!instance) {
      for (const { marker } of live.values()) marker.remove();
      live.clear();
      return;
    }

    const wanted = new Map(drawn.map((label) => [label.key, label]));
    for (const [key, entry] of live) {
      if (wanted.has(key)) continue;
      entry.marker.remove();
      live.delete(key);
    }

    for (const [key, label] of wanted) {
      const entry = live.get(key);
      if (!entry) {
        const element = document.createElement('div');
        element.className = label.className;
        element.textContent = label.text;
        // Answered names are set in their grade colour rather than plated in it.
        if (label.color) element.style.color = label.color;
        const marker = new maplibregl.Marker({ element, anchor: 'bottom' })
          .setLngLat(label.at)
          .addTo(instance);
        live.set(key, { marker, label });
        continue;
      }
      const element = entry.marker.getElement();
      if (label.text !== entry.label.text) element.textContent = label.text;
      if (label.className !== entry.label.className) {
        // Swapped class by class, never by assigning `className`. MapLibre puts
        // its own classes on the element it was handed — `maplibregl-marker`,
        // which is what positions it absolutely, and `maplibregl-marker-covered`
        // which it toggles as the terrain hides it. Overwriting the attribute
        // took those with it, and an unpositioned label falls back into the flow
        // of the map container as a full-width block: hovering one feature left
        // a neighbouring name stretched across the map until it was redrawn.
        element.classList.remove(...entry.label.className.split(' '));
        element.classList.add(...label.className.split(' '));
      }
      if (label.color !== entry.label.color) element.style.color = label.color ?? '';
      if (label.at[0] !== entry.label.at[0] || label.at[1] !== entry.label.at[1]) {
        entry.marker.setLngLat(label.at);
      }
      entry.label = label;
    }
  });

  /** A pin on anything the user has decided about by hand, so locks are visible. */
  const pinned = $derived(
    mode === 'build'
      ? collection.features.filter((f) => isLocked(shade[f.id] ?? 'auto-out'))
      : [],
  );

  $effect(() => {
    if (!map) return;
    const instance = map;
    const markers = pinned.map((feature) => {
      const element = document.createElement('div');
      const inclusion = shade[feature.id];
      element.className = `map-pin map-pin--${inclusion === 'locked-in' ? 'in' : 'out'}`;
      element.title = inclusion === 'locked-in' ? 'Pinned in' : 'Pinned out';
      return new maplibregl.Marker({ element, anchor: 'center' })
        .setLngLat(feature.properties.anchor)
        .addTo(instance);
    });
    return () => {
      for (const marker of markers) marker.remove();
    };
  });

  $effect(() => {
    if (!map) return;
    const instance = map;

    /*
     * Double tapping does not zoom.
     *
     * A tap that answers the question and a tap that is half of a zoom look
     * identical until the second one arrives, so keeping both would mean
     * holding every answer back for the length of the double-tap window before
     * it could count. Zooming has other ways in — pinch, the wheel, the +/-
     * buttons, and the two-finger tap below — and none of them costs a try.
     */
    instance.doubleClickZoom.disable();

    const zoomBy = (at: { x: number; y: number }, out: boolean) => {
      const snap = instance.getZoomSnap();
      const target = instance.getZoom() + (out ? -1 : 1);
      instance.easeTo({
        duration: 300,
        zoom: snap > 0 ? Math.round(target / snap) * snap : target,
        around: instance.unproject([at.x, at.y]),
      });
    };

    /**
     * Two fingers down and up again: MapLibre's zoom out, which went quiet with
     * the rest of its double-press handling. A pinch starts the same way, so a
     * gesture that travels is left to the pinch handler.
     */
    let twoFinger: { at: maplibregl.Point; time: number } | null = null;

    const onClick = (event: maplibregl.MapMouseEvent) => {
      if (enabled) onpick(pickAt(instance, event.point));
    };
    const onTouchStart = (event: maplibregl.MapTouchEvent) => {
      twoFinger =
        event.points.length === 2 ? { at: event.point, time: event.originalEvent.timeStamp } : null;
    };
    const onTouchMove = (event: maplibregl.MapTouchEvent) => {
      if (twoFinger && event.point.dist(twoFinger.at) > TAP_SLOP_PX) twoFinger = null;
    };
    const onTouchEnd = (event: maplibregl.MapTouchEvent) => {
      // A touchend reports the fingers that just left, so the ones still down
      // have to be read off the DOM event: a stagger is still one gesture.
      if (!twoFinger || event.originalEvent.touches.length > 0) return;
      const tap = twoFinger;
      twoFinger = null;
      if (event.originalEvent.timeStamp - tap.time < TWO_FINGER_TAP_MS) zoomBy(tap.at, true);
    };
    const onMove = (event: maplibregl.MapMouseEvent) => {
      const hit = enabled ? pickAt(instance, event.point) : null;
      instance.getCanvas().style.cursor = hit ? 'pointer' : '';
      hoveredId = hit;
    };
    // A pointer that leaves the map is not hovering anything. Without this the
    // last feature it crossed stays lit, and a highlight that outlives the
    // pointer has stopped reading as a hover and started reading as a state.
    const onLeave = () => {
      hoveredId = null;
    };

    instance.on('click', onClick);
    instance.on('touchstart', onTouchStart);
    instance.on('touchmove', onTouchMove);
    instance.on('touchend', onTouchEnd);
    instance.on('mousemove', onMove);
    instance.on('mouseout', onLeave);
    return () => {
      instance.off('click', onClick);
      instance.off('touchstart', onTouchStart);
      instance.off('touchmove', onTouchMove);
      instance.off('touchend', onTouchEnd);
      instance.off('mousemove', onMove);
      instance.off('mouseout', onLeave);
    };
  });
</script>

<div class="map" bind:this={container}></div>
{#if selecting && crop}
  <AreaSelect
    rect={crop.rect}
    region={cropRegion}
    onchange={(rect) => (crop = { rect, region: cropRegion })}
  />
{/if}

<style>
  .map {
    position: absolute;
    inset: 0;
  }
</style>
