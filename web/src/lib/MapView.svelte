<script lang="ts">
  import { untrack } from 'svelte';
  import maplibregl from 'maplibre-gl';
  import { layoutLabels } from './labels.ts';
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
    places = [],
    enabled = true,
    chromeTop = 0,
    onpick,
    onview,
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
  const MAX_FEATURE_LABELS = 45;
  /**
   * A ceiling, not a quota. Which names appear should follow zoom and available
   * space; a tight cap would make it follow the viewport instead, so that
   * panning a busier area into view silently evicted labels elsewhere.
   */
  const MAX_PLACE_LABELS = 140;
  /**
   * How far off screen labels still compete, in pixels. Comfortably wider than
   * the longest place name, so a label sliding into view cannot displace one
   * already drawn.
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
  let map: maplibregl.Map | undefined = $state();
  let ready = $state(false);
  let hoveredId = $state<string | null>(null);
  /** Bumped on every move, so label layout recomputes against the new screen. */
  let viewTick = $state(0);

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
  function pickAt(point: maplibregl.Point): string | null {
    for (const tolerance of [4, 14]) {
      const hits = map!.queryRenderedFeatures(
        [
          [point.x - tolerance, point.y - tolerance],
          [point.x + tolerance, point.y + tolerance],
        ],
        { layers: PICK_LAYERS.filter((id) => map!.getLayer(id)) },
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

    instance.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution: '© OpenStreetMap contributors',
      }),
      'bottom-right',
    );
    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    instance.on('load', () => {
      frame(instance);
      map = instance;
      ready = true;
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
      viewTick++;
    });

    return () => {
      ready = false;
      instance.remove();
    };
  });

  // The builder swaps in a whole new area as you pan, so the source is updated
  // in place rather than rebuilding the map.
  $effect(() => {
    if (!ready || !map) return;
    const source = map.getSource('features') as maplibregl.GeoJSONSource | undefined;
    source?.setData(indexed as GeoJSON.FeatureCollection);
  });

  $effect(() => {
    if (!ready || !map) return;
    const source = map.getSource('context') as maplibregl.GeoJSONSource | undefined;
    source?.setData(context as GeoJSON.FeatureCollection);
  });

  // Play draws only the round's features — the player chooses between visible
  // candidates, Seterra-style, rather than hunting blank terrain. The builder
  // draws everything, because what you are excluding is part of the decision.
  $effect(() => {
    if (!ready || !map) return;
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
    if (!ready || !map) return;
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
   * Blinks the revealed feature and pulses a ring at it, panning there first if
   * it is off screen. It blinks rather than staying red because the player still
   * has to go and click it — a static highlight is something you look at, a
   * blinking one is something you go to.
   */
  $effect(() => {
    if (!ready || !map || !revealId) return;
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
      instance.setFeatureState({ source: 'features', id: idx }, { flash: false });
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
    if (!ready || !map) return [];
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
      const candidates = collection.features
        .filter((f) => isIncluded(shade[f.id] ?? 'auto-out') || f.id === hoveredId)
        .map((f) => ({
          // Hovering is a direct question about one feature, so it always wins.
          priority: f.id === hoveredId ? 1e6 : (f.properties.popularity ?? f.properties.lengthKm),
          text: f.properties.name,
          item: f,
          key: f.id,
        }));
      for (const placed of layoutLabels(candidates, (f) => project(f.properties.anchor), {
        ...size,
        pad: LABEL_PAD,
        max: MAX_FEATURE_LABELS,
      })) {
        out.push({
          key: `f:${placed.item.id}`,
          text: placed.text,
          at: placed.item.properties.anchor,
          className: `map-label map-label--picked${placed.item.id === hoveredId ? ' is-hover' : ''}`,
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
    const instance = ready ? map : undefined;
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
      if (label.className !== entry.label.className) element.className = label.className;
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
    if (!ready || !map) return;
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
    if (!ready || !map) return;
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
      if (enabled) onpick(pickAt(event.point));
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
      const hit = enabled ? pickAt(event.point) : null;
      instance.getCanvas().style.cursor = hit ? 'pointer' : '';
      if (mode === 'build') hoveredId = hit;
    };

    instance.on('click', onClick);
    instance.on('touchstart', onTouchStart);
    instance.on('touchmove', onTouchMove);
    instance.on('touchend', onTouchEnd);
    instance.on('mousemove', onMove);
    return () => {
      instance.off('click', onClick);
      instance.off('touchstart', onTouchStart);
      instance.off('touchmove', onTouchMove);
      instance.off('touchend', onTouchEnd);
      instance.off('mousemove', onMove);
    };
  });
</script>

<div class="map" bind:this={container}></div>

<style>
  .map {
    position: absolute;
    inset: 0;
  }
</style>
