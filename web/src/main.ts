import { mount } from 'svelte';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import App from './App.svelte';

/*
 * The basemap furniture is one PMTiles archive rather than a directory of
 * tiles: one file to deploy, and any static host that answers a byte-range
 * request can serve it — no tile server, no process, nothing to keep running.
 * MapLibre needs the `pmtiles://` protocol registering before any style uses it.
 */
maplibregl.addProtocol('pmtiles', new Protocol().tile);

export default mount(App, { target: document.getElementById('app')! });
