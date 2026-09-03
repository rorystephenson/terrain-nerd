/**
 * Renders basemap tiles with the app's own renderer.
 *
 * The point of doing this in a browser rather than with a server-side tile
 * renderer is fidelity. Martin's renderer draws fill, line and circle only, and
 * MapLibre Native's `color-relief` support was still in flight as of December
 * 2025 — but even once it lands, a second engine is a second implementation of
 * shading whose palette was fitted by measurement against a reference render.
 * MapLibre GL JS with the app's own `buildStyle` is the only arrangement where
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
      out[`${x + dx}/${y + dy}`] = cut.toDataURL('image/webp', 0.82).split(',')[1];
    }
  }
  return out;
}

declare global {
  interface Window {
    renderBlock: typeof renderBlock;
    blockSize: number;
  }
}
window.renderBlock = renderBlock;
window.blockSize = BLOCK;
