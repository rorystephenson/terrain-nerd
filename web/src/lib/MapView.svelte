<script lang="ts">
  import maplibregl from 'maplibre-gl';
  import { buildStyle, LAYER_GEOMETRY, PICK_LAYERS } from './mapStyle.ts';
  import type { ContextCollection, FeatureFile, MapLabel, ViewState } from './types.ts';

  type Props = {
    collection: FeatureFile;
    context: ContextCollection;
    /** Feature ids drawn for the current round. */
    activeIds: string[];
    /** The zone's extent, framed on entry. */
    bbox: [number, number, number, number];
    /** Answered features: id -> grade (0 found first try … 1 had to be shown). */
    graded: Record<string, number>;
    /** A feature clicked by mistake, shown amber while its label is up. */
    missId: string | null;
    /** The answer being pointed out: flashes and pulses until it is clicked. */
    revealId: string | null;
    labels: MapLabel[];
    enabled: boolean;
    onpick: (id: string | null) => void;
    onview: (view: ViewState) => void;
  };

  let {
    collection,
    context,
    activeIds,
    bbox,
    graded,
    missId,
    revealId,
    labels,
    enabled,
    onpick,
    onview,
  }: Props = $props();

  /** How fast the revealed feature blinks. */
  const FLASH_MS = 420;

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
  const anchorOf = $derived(
    new Map(collection.features.map((feature) => [feature.id, feature.properties.anchor])),
  );
  const bboxOf = $derived(new Map(collection.features.map((feature) => [feature.id, feature.bbox])));

  let container: HTMLDivElement;
  let map: maplibregl.Map | undefined = $state();
  let ready = $state(false);

  const pad = (box: [number, number, number, number], lon: number, lat: number) =>
    [
      [box[0] - lon, box[1] - lat],
      [box[2] + lon, box[3] + lat],
    ] as [[number, number], [number, number]];

  /** How far beyond the framed view the player may pan, as a fraction of it. */
  const PAN_SLACK = 0.15;

  /**
   * Frames the zone and locks the view to it.
   *
   * The leash is derived from the *fitted viewport*, not from the zone's own
   * bbox. That matters: bounds narrower than the window make MapLibre zoom in
   * to obey them, so a leash measured off the bbox would either crop the zone
   * or, padded enough to be safe, let the player wander half the province.
   * Pinning `minZoom` to the framing zoom closes the same hole from the other
   * side — you cannot zoom out past the area being quizzed.
   */
  function frame(instance: maplibregl.Map) {
    // The previous zone's limits would constrain this fit, so clear them first.
    instance.setMaxBounds(null);
    instance.setMinZoom(0);
    instance.fitBounds(pad(bbox, 0.02, 0.02), {
      padding: { top: 110, bottom: 40, left: 40, right: 40 },
      duration: 0,
    });

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
    onview({
      view: box,
      covers:
        box[0] <= bbox[0] && box[1] <= bbox[1] && box[2] >= bbox[2] && box[3] >= bbox[3],
    });
  }

  $effect(() => {
    const instance = new maplibregl.Map({
      container,
      bounds: pad(bbox, 0.02, 0.02),
      maxZoom: 14,
      dragRotate: false,
      attributionControl: false,
      style: buildStyle(
        context as GeoJSON.FeatureCollection,
        indexed as GeoJSON.FeatureCollection,
      ),
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
    instance.on('move', () => report(instance));
    // A resized window changes what "fits", so the leash has to be recut.
    instance.on('resize', () => frame(instance));

    return () => {
      ready = false;
      instance.remove();
    };
  });

  // Only the features in play this round are drawn — the player chooses between
  // visible candidates, Seterra-style, rather than hunting blank terrain.
  $effect(() => {
    if (!ready || !map) return;
    const active = activeIds.map((id) => idxOf.get(id)).filter((idx) => idx !== undefined);
    const inRound = ['in', ['get', 'idx'], ['literal', active]] as maplibregl.FilterSpecification;
    // Keep each layer's geometry restriction — replacing the filter outright is
    // what would let the circle layer speckle dots along every valley line.
    for (const [id, geometry] of Object.entries(LAYER_GEOMETRY)) {
      if (map.getLayer(id)) {
        map.setFilter(id, ['all', geometry, inRound] as unknown as maplibregl.FilterSpecification);
      }
    }
  });

  // Re-frame whenever the zone changes. Top padding clears the prompt bar.
  $effect(() => {
    if (!ready || !map) return;
    frame(map);
  });

  $effect(() => {
    if (!ready || !map) return;
    for (const [id, idx] of idxOf) {
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
    const anchor = anchorOf.get(revealId);
    if (idx === undefined || !anchor) return;

    const box = bboxOf.get(revealId);
    if (box) {
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
            // Never zoom further in than the player already was; they chose
            // that scale and yanking it away is disorienting.
            maxZoom: instance.getZoom(),
            duration: 500,
          },
        );
      }
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
    const marker = new maplibregl.Marker({ element }).setLngLat(anchor).addTo(instance);

    return () => {
      clearInterval(timer);
      instance.setFeatureState({ source: 'features', id: idx }, { flash: false });
      marker.remove();
    };
  });

  /**
   * Labels are HTML markers rather than a symbol layer: a symbol layer would
   * need a glyph endpoint (and therefore an API key), and keeping the style
   * label-free is what guarantees the basemap cannot give an answer away.
   */
  $effect(() => {
    if (!ready || !map) return;
    const instance = map;
    const markers = labels.flatMap((label) => {
      const anchor = anchorOf.get(label.featureId);
      if (!anchor) return [];
      const element = document.createElement('div');
      element.className = `map-label map-label--${label.tone}`;
      element.textContent = label.text;
      if (label.color) element.style.background = label.color;
      return [
        new maplibregl.Marker({ element, anchor: 'bottom' }).setLngLat(anchor).addTo(instance),
      ];
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
      instance.getCanvas().style.cursor = enabled && pickAt(event.point) ? 'pointer' : '';
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
