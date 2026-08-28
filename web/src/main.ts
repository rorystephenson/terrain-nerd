import { mount } from 'svelte';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import App from './App.svelte';

export default mount(App, { target: document.getElementById('app')! });
