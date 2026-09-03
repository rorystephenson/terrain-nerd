import { mount } from 'svelte';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import App from './App.svelte';
import { registerTileProtocol } from './lib/tiles.ts';

/*
 * The basemap is pre-rendered images, fetched through a protocol handler rather
 * than a plain tile URL: it answers for ground outside coverage itself, so no
 * request is ever made for a tile that was never rendered.
 */
registerTileProtocol();

export default mount(App, { target: document.getElementById('app')! });
