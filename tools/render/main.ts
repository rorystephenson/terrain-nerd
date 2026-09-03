/**
 * Renders basemap tiles with the app's own renderer.
 *
 * The point of doing this in a browser rather than with a server-side tile
 * renderer is fidelity. Martin's renderer draws fill, line and circle only, and
 * MapLibre Native's `color-relief` support was still in flight as of December
 * 2025 — but even once it lands, a second engine is a second implementation of
 * shading whose palette was fitted by measurement against a reference render.
 * MapLibre GL JS with the app's own `buildBasemapStyle` is the only arrangement where
 * the tiles are the same picture the app draws rather than a close one.
 *
 * The driver in `render.mjs` calls `renderBlock` once per 4x4 block of tiles.
 */
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';

import { buildBasemapStyle } from '../../web/src/lib/mapStyle.ts';
import { TILE_SIZE, latAtWorldY, lonAtWorldX, worldSizeAt } from '../../pipeline/src/mercator.ts';

maplibregl.addProtocol('pmtiles', new Protocol().tile);

/** How many tiles across each render covers. 16 tiles per screenshot, not one. */
const BLOCK = 4;

/**
 * The coverage, handed over by the driver before anything is drawn.
 *
 * The hatch marking unsupported ground is painted into the tiles here rather
 * than decided in the app, because the app can only decide it per *tile* — and
 * below the coverage zoom a tile spans many cells. Judged there, a z4 tile
 * containing one covered cell out of 8,192 counts as covered and draws a map
 * over ground we have nothing for; judged strictly, it hatches the Alps along
 * with everything else. Neither is right, and the two rules disagreeing is why
 * ground could read as mapped at z6 and unsupported at z10.
 *
 * Painted in, the boundary is in one place and is the same at every zoom.
 */
let coverageZoom = 10;
let covered = new Set<string>();

/** Diagonal hatch on the palest ground colour, matching the standalone tile. */
function hatchPattern(): CanvasPattern {
  const swatch = document.createElement('canvas');
  swatch.width = 18;
  swatch.height = 18;
  const ctx = swatch.getContext('2d')!;
  ctx.fillStyle = '#e8eae4';
  ctx.fillRect(0, 0, 18, 18);
  ctx.strokeStyle = 'rgba(120, 132, 145, 0.14)';
  ctx.lineWidth = 1;
  for (const at of [-18, 0, 18]) {
    ctx.beginPath();
    ctx.moveTo(at, 0);
    ctx.lineTo(at + 18, 18);
    ctx.stroke();
  }
  return ctx.createPattern(swatch, 'repeat')!;
}
let hatch: CanvasPattern | null = null;

/**
 * Paints over every part of this tile we have no data for.
 *
 * At and below the coverage zoom that is whole cells within the tile, so the
 * boundary lands exactly where coverage does however far out you are looking.
 * The pattern is offset by the tile's own position in the world so the hatch
 * runs continuously across tile seams instead of restarting at each one.
 */
function maskUncovered(ctx: CanvasRenderingContext2D, z: number, tx: number, ty: number): void {
  hatch ??= hatchPattern();
  ctx.save();
  ctx.fillStyle = hatch;
  const dx = -((tx * TILE_SIZE) % 18);
  const dy = -((ty * TILE_SIZE) % 18);
  ctx.translate(dx, dy);

  if (z >= coverageZoom) {
    const shift = z - coverageZoom;
    if (!covered.has(`x${tx >> shift}y${ty >> shift}`)) {
      ctx.fillRect(-dx, -dy, TILE_SIZE, TILE_SIZE);
    }
  } else {
    const span = 2 ** (coverageZoom - z);
    const size = TILE_SIZE / span;
    for (let i = 0; i < span; i++) {
      for (let j = 0; j < span; j++) {
        if (covered.has(`x${tx * span + i}y${ty * span + j}`)) continue;
        ctx.fillRect(i * size - dx, j * size - dy, size, size);
      }
    }
  }
  ctx.restore();
}
const map = new maplibregl.Map({
  container: 'map',
  // The basemap style: terrain shaded from raw elevation with roads, water and
  // glaciers over it. Quiz features are not in it — those stay vector layers the
  // app puts on top at runtime.
  style: buildBasemapStyle('context.pmtiles'),
  center: [11, 46],
  zoom: 8,
  // Off so a block is exactly the ground it claims to be.
  interactive: false,
  fadeDuration: 0,
  attributionControl: false,
  // Tiles must be complete, not progressively refined from a parent.
  refreshExpiredTiles: false,
});

const ready = new Promise<void>((resolve) => map.once('load', () => resolve()));

/** Resolves when the map has finished drawing everything it is going to. */
const idle = () =>
  new Promise<void>((resolve) => {
    if (map.loaded() && !map.isMoving()) {
      // `idle` will not fire again if it already has, so check first.
      map.once('idle', () => resolve());
      map.triggerRepaint();
    } else {
      map.once('idle', () => resolve());
    }
  });

/**
 * Draws the 4x4 block whose top-left tile is (x, y) at `z`, and cuts it up.
 *
 * A block of 4 tiles at 512px is 2048px, and at zoom `z` a 2048px canvas covers
 * exactly 4x4 tiles of that zoom — so centring on the block's midpoint lines the
 * canvas up with the tile grid to the pixel. Any drift here would show as a seam
 * running through every tile.
 */
async function renderBlock(z: number, x: number, y: number): Promise<Record<string, string>> {
  await ready;
  const worldSize = worldSizeAt(z);
  const centre: [number, number] = [
    lonAtWorldX((x + BLOCK / 2) * TILE_SIZE, worldSize),
    latAtWorldY((y + BLOCK / 2) * TILE_SIZE, worldSize),
  ];
  map.jumpTo({ center: centre, zoom: z });
  await idle();

  const source = map.getCanvas();
  const cut = document.createElement('canvas');
  cut.width = TILE_SIZE;
  cut.height = TILE_SIZE;
  const ctx = cut.getContext('2d')!;

  const out: Record<string, string> = {};
  for (let dy = 0; dy < BLOCK; dy++) {
    for (let dx = 0; dx < BLOCK; dx++) {
      ctx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
      ctx.drawImage(
        source,
        dx * TILE_SIZE, dy * TILE_SIZE, TILE_SIZE, TILE_SIZE,
        0, 0, TILE_SIZE, TILE_SIZE,
      );
      maskUncovered(ctx, z, x + dx, y + dy);
      out[`${x + dx}/${y + dy}`] = cut.toDataURL('image/webp', 0.82).split(',')[1];
    }
  }
  return out;
}

function setCoverage(zoom: number, cells: string[]): void {
  coverageZoom = zoom;
  covered = new Set(cells);
}

declare global {
  interface Window {
    renderBlock: typeof renderBlock;
    setCoverage: typeof setCoverage;
    blockSize: number;
  }
}
window.renderBlock = renderBlock;
window.setCoverage = setCoverage;
window.blockSize = BLOCK;
