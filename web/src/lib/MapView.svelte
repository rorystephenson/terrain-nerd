<script lang="ts">
  import { untrack } from 'svelte';
  import maplibregl from 'maplibre-gl';
  import { layoutLabels } from './labels.ts';
  import { buildStyle, LAYER_GEOMETRY, PICK_LAYERS, type MapMode } from './mapStyle.ts';
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
    onpick,
    onview,
  }: Props = $props();

  /** How fast the revealed feature blinks. */
  const FLASH_MS = 420;
  /** How far beyond the framed view the player may pan, as a fraction of it. */
  const PAN_SLACK = 0.15;
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

  /**
   * Frames the area and locks the view to it.
   *
   * The leash is derived from the *fitted viewport*, not from the area's own
   * bbox. That matters: bounds narrower than the window make MapLibre zoom in
   * to obey them, so a leash measured off the bbox would either crop the area
   * or, padded enough to be safe, let the player wander half the province.
   * Pinning `minZoom` to the framing zoom closes the same hole from the other
   * side — you cannot zoom out past the area being quizzed.
   */
  function frame(instance: maplibregl.Map) {
    // The previous area's limits would constrain this fit, so clear them first.
    instance.setMaxBounds(null);
    instance.setMinZoom(0);
    instance.fitBounds(pad(bbox, 0.02, 0.02), {
      padding: { top: 110, bottom: 40, left: 40, right: 40 },
      duration: 0,
    });

    // Choosing an area means going wherever you like inside the coverage.
    if (mode === 'build') {
      if (coverage) {
        instance.setMaxBounds([
          [coverage[0], coverage[1]],
          [coverage[2], coverage[3]],
        ]);
      }
      return;
    }

    instance.setMinZoom(instance.getZoom());
    const framed = instance.getBounds();
    const lon = (framed.getEast() - framed.getWest()) * PAN_SLACK;
    const lat = (framed.getNorth() - framed.getSouth()) * PAN_SLACK;
    instance.setMaxBounds([
      [framed.getWest() - lon, framed.getSouth() - lat],
      [framed.getEast() + lon, framed.getNorth() + lat],
    ]);
  }

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
      const osmId = hits[0]?.properties?.osmId;
      if (typeof osmId === 'string') return osmId;
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
      covers: box[0] <= bbox[0] && box[1] <= bbox[1] && box[2] >= bbox[2] && box[3] >= bbox[3],
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
      bounds: pad(bbox, 0.02, 0.02),
      style: buildStyle(
        context as GeoJSON.FeatureCollection,
        indexed as GeoJSON.FeatureCollection,
        mode,
      ),
    }));

    const instance = new maplibregl.Map({
      container,
      bounds: initial.bounds,
      maxZoom: 14,
      dragRotate: false,
      attributionControl: false,
      style: initial.style,
    });

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
          padding: { top: 110, bottom: 48, left: 48, right: 48 },
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
    const onClick = (event: maplibregl.MapMouseEvent) => {
      if (enabled) onpick(pickAt(event.point));
    };
    const onMove = (event: maplibregl.MapMouseEvent) => {
      const hit = enabled ? pickAt(event.point) : null;
      instance.getCanvas().style.cursor = hit ? 'pointer' : '';
      if (mode === 'build') hoveredId = hit;
    };
    instance.on('click', onClick);
    instance.on('mousemove', onMove);
    return () => {
      instance.off('click', onClick);
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
