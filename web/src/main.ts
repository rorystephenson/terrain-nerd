import { mount } from 'svelte';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import App from './App.svelte';
import { registerTileProtocols } from './lib/tiles.ts';

/*
 * The basemap is pre-rendered images inside covered ground and OpenTopoMap
 * outside it. Both go through protocol handlers rather than plain tile URLs, so
 * the choice is made from the coverage the pool ships with — one request per
 * tile of ground, and never one for a tile that was never rendered.
 */
registerTileProtocols();

export default mount(App, { target: document.getElementById('app')! });
