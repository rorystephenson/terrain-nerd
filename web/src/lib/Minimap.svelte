<script lang="ts">
  import type { QuizFeature } from './types.ts';

  type Props = {
    /** Extent of the zone being quizzed. */
    bbox: [number, number, number, number];
    /** Current map viewport. */
    view: [number, number, number, number];
    features: QuizFeature[];
  };

  let { bbox, view, features }: Props = $props();

  const W = 116;
  const H = 92;
  const PAD = 5;

  /**
   * Projects lon/lat into the box, preserving aspect so the shape of the zone
   * stays recognisable rather than being stretched to fill the corner.
   */
  const layout = $derived.by(() => {
    const spanLon = Math.max(bbox[2] - bbox[0], 1e-6);
    const spanLat = Math.max(bbox[3] - bbox[1], 1e-6);
    // Longitude degrees are shorter than latitude ones at this latitude.
    const midLat = ((bbox[1] + bbox[3]) / 2) * (Math.PI / 180);
    const wide = spanLon * Math.cos(midLat);
    const scale = Math.min((W - PAD * 2) / wide, (H - PAD * 2) / spanLat);
    const drawW = wide * scale;
    const drawH = spanLat * scale;
    return {
      x: (lon: number) => (W - drawW) / 2 + (lon - bbox[0]) * Math.cos(midLat) * scale,
      y: (lat: number) => (H - drawH) / 2 + (bbox[3] - lat) * scale,
      drawW,
      drawH,
    };
  });

  const zoneRect = $derived({
    x: layout.x(bbox[0]),
    y: layout.y(bbox[3]),
    w: layout.drawW,
    h: layout.drawH,
  });

  /** The viewport, clipped to the drawing so it can't spill outside the box. */
  const viewRect = $derived.by(() => {
    const left = Math.max(layout.x(Math.max(view[0], bbox[0])), zoneRect.x);
    const right = Math.min(layout.x(Math.min(view[2], bbox[2])), zoneRect.x + zoneRect.w);
    const top = Math.max(layout.y(Math.min(view[3], bbox[3])), zoneRect.y);
    const bottom = Math.min(layout.y(Math.max(view[1], bbox[1])), zoneRect.y + zoneRect.h);
    return { x: left, y: top, w: Math.max(2, right - left), h: Math.max(2, bottom - top) };
  });

  const dots = $derived(
    features.map((f) => ({
      cx: layout.x(f.properties.anchor[0]),
      cy: layout.y(f.properties.anchor[1]),
    })),
  );
</script>

<div class="minimap" aria-hidden="true">
  <svg width={W} height={H} viewBox="0 0 {W} {H}">
    <rect class="zone" x={zoneRect.x} y={zoneRect.y} width={zoneRect.w} height={zoneRect.h} rx="2" />
    {#each dots as dot, i (i)}
      <circle class="dot" cx={dot.cx} cy={dot.cy} r="1.4" />
    {/each}
    <rect class="view" x={viewRect.x} y={viewRect.y} width={viewRect.w} height={viewRect.h} rx="1" />
  </svg>
  <span class="caption">whole area</span>
</div>

<style>
  .minimap {
    position: absolute;
    left: 0.75rem;
    bottom: 0.75rem;
    z-index: 4;
    padding: 0.35rem 0.35rem 0.15rem;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.9);
    backdrop-filter: blur(4px);
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.18);
    pointer-events: none;
  }
  svg { display: block; }
  .zone { fill: rgba(0, 0, 0, 0.05); stroke: rgba(0, 0, 0, 0.25); stroke-width: 1; }
  .dot { fill: var(--muted); opacity: 0.55; }
  .view { fill: rgba(47, 111, 79, 0.16); stroke: var(--accent); stroke-width: 1.5; }
  .caption {
    display: block;
    text-align: center;
    font-size: 0.6rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }
</style>
