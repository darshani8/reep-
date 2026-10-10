import { DOCUMENT } from '@angular/core';
import { Component, DestroyRef, ElementRef, afterNextRender, effect, inject, signal, viewChild } from '@angular/core';
import {
  type ExpressionSpecification,
  FullscreenControl,
  type GeoJSONSource,
  getVersion,
  GPUInitializationError,
  LngLatBounds,
  Map as MapLibreMap,
  type MapGeoJSONFeature,
  type MapMouseEvent,
  type SymbolLayerSpecification,
  NavigationControl,
  Popup,
  ScaleControl,
  setWorkerUrl,
} from 'maplibre-gl';
import { BENGALURU_CENTER, DEFAULT_ZOOM, MAP_STYLE_URL, MAX_BOUNDS, MAX_ZOOM, MIN_ZOOM } from '../core/bengaluru';
import { MapStateService } from '../core/map-state.service';
import { CATEGORY_COLOR, TECH_PARK_COLOR } from '../data/types';

const SRC_OFFICES = 'offices';
const SRC_PARKS = 'parks';
const SRC_FOOTPRINTS = 'park-footprints';
const SRC_SELECTED = 'selected';

const L_FOOTPRINT_FILL = 'park-footprint-fill';
const L_FOOTPRINT_LINE = 'park-footprint-line';
const L_CLUSTERS = 'office-clusters';
const L_CLUSTER_COUNT = 'office-cluster-count';
const L_OFFICES = 'office-points';
const L_OFFICE_LABELS = 'office-labels';
const L_PARKS = 'park-points';
const L_PARKS_EMPTY = 'park-points-empty';
const L_PARK_LABELS = 'park-labels';
const L_PARK_LABELS_EMPTY = 'park-labels-empty';
const L_SELECTED = 'selected-ring';

/**
 * The map: MapLibre GL JS over OpenFreeMap's Positron vector tiles, pinned to Bengaluru.
 *
 * Everything it draws comes from `MapStateService`'s computed GeoJSON; this component owns no
 * data, only the MapLibre instance. Three sources: clustered office points coloured by
 * category, tech-park markers (with OSM footprints where the park has one), and a ring around
 * the selected office. Clicks write back into the state service and the panels react.
 */
@Component({
  selector: 'app-map',
  template: `
    <div #container class="map-canvas" aria-label="Map of company offices and tech parks in Bengaluru"></div>
    @if (error(); as message) {
      <div class="map-fallback" role="alert">
        <strong>The map could not start.</strong>
        <p>{{ message }}</p>
        <p>The company list on the left still works, and every office carries its address.</p>
      </div>
    }
    @if (!ready() && !error()) {
      <div class="map-loading" role="status">Loading map…</div>
    }
  `,
  styles: `
    :host {
      display: block;
      position: relative;
      height: 100%;
      min-height: 320px;
      background: #e9eef3;
    }
    .map-canvas {
      position: absolute;
      inset: 0;
    }
    .map-fallback,
    .map-loading {
      position: absolute;
      inset: auto 16px 16px 16px;
      max-width: 420px;
      margin: 0 auto;
      padding: 12px 14px;
      background: var(--surface);
      border: 1px solid var(--hairline);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
    }
    .map-loading {
      inset: 16px auto auto 50%;
      transform: translateX(-50%);
      padding: 6px 12px;
      font-size: 13px;
      color: var(--ink-3);
    }
    .map-fallback p {
      margin: 6px 0 0;
    }
  `,
})
export class MapComponent {
  private readonly container = viewChild.required<ElementRef<HTMLDivElement>>('container');
  private readonly state = inject(MapStateService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);

  readonly ready = signal(false);
  readonly error = signal<string | null>(null);

  private map: MapLibreMap | null = null;
  private hoverPopup: Popup | null = null;
  private clickPopup: Popup | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private lastFit = 0;

  constructor() {
    afterNextRender(() => this.init());

    effect(() => {
      const data = this.state.officeCollection();
      if (this.ready()) this.source(SRC_OFFICES)?.setData(data);
    });
    effect(() => {
      const parks = this.state.parkCollection();
      const footprints = this.state.parkFootprints();
      if (this.ready()) {
        this.source(SRC_PARKS)?.setData(parks);
        this.source(SRC_FOOTPRINTS)?.setData(footprints);
      }
    });
    effect(() => {
      const selected = this.state.selectedCollection();
      if (this.ready()) this.source(SRC_SELECTED)?.setData(selected);
    });
    effect(() => {
      const office = this.state.selectedOffice();
      const source = this.state.selectionSource();
      if (!this.ready() || !office) return;
      if (source === 'map') return; // the user is already looking at it
      this.revealPoint(office.lng, office.lat, source === 'url' ? 15 : 14.5);
    });
    effect(() => {
      const park = this.state.selectedPark();
      const source = this.state.selectionSource();
      if (!this.ready() || !park || source === 'map') return;
      if (park.bbox) {
        this.fit(new LngLatBounds([park.bbox[2], park.bbox[0]], [park.bbox[3], park.bbox[1]]), 60, 16);
      } else {
        this.revealPoint(park.lng, park.lat, 14.2);
      }
    });
    effect(() => {
      const n = this.state.fitRequest();
      if (!this.ready() || n === this.lastFit) return;
      this.lastFit = n;
      this.fitToVisible();
    });
    effect(() => {
      // a park filter frames the park; a cleared one frames whatever is left
      const parkId = this.state.filters().techParkId;
      if (!this.ready()) return;
      if (parkId) this.fitToVisible();
    });

    this.destroyRef.onDestroy(() => {
      this.resizeObserver?.disconnect();
      this.hoverPopup?.remove();
      this.clickPopup?.remove();
      this.map?.remove();
      this.map = null;
    });
  }

  private init(): void {
    const el = this.container().nativeElement;
    // MapLibre 6 is ESM-only and runs its tile parsing in a worker shipped as a separate file.
    // angular.json copies `maplibre-gl-worker.mjs` next to index.html; the version query keeps a
    // browser from reusing a cached worker from an older release under the same file name.
    setWorkerUrl(`maplibre-gl-worker.mjs?v=${getVersion()}`);
    let map: MapLibreMap;
    try {
      map = new MapLibreMap({
        container: el,
        style: MAP_STYLE_URL,
        center: BENGALURU_CENTER,
        zoom: DEFAULT_ZOOM,
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        maxBounds: MAX_BOUNDS,
        attributionControl: { compact: true },
        fadeDuration: 0,
      });
    } catch (err) {
      this.error.set(
        err instanceof GPUInitializationError
          ? 'This browser has no WebGL2, which MapLibre needs to draw vector tiles.'
          : `Unexpected error starting MapLibre: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    this.map = map;
    map.addControl(new NavigationControl({ visualizePitch: false }), 'top-right');
    map.addControl(new FullscreenControl(), 'top-right');
    map.addControl(new ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');

    map.on('error', (e) => {
      // Tile and glyph fetch failures are logged by MapLibre already; only a dead style is fatal.
      if (!this.ready() && e.error && /style/i.test(e.error.message)) {
        this.error.set(`The base map style could not be loaded (${e.error.message}). Check the network and MAP_STYLE_URL.`);
      }
    });

    map.on('load', () => {
      this.addSourcesAndLayers(map);
      this.wireInteractions(map);
      this.ready.set(true);
    });

    this.resizeObserver = new ResizeObserver(() => map.resize());
    this.resizeObserver.observe(el);
  }

  private source(id: string): GeoJSONSource | undefined {
    return this.map?.getSource(id) as GeoJSONSource | undefined;
  }

  private addSourcesAndLayers(map: MapLibreMap): void {
    const catColor: ExpressionSpecification = ['match', ['get', 'category'], 'MNC', CATEGORY_COLOR.MNC, 'MID_SIZE', CATEGORY_COLOR.MID_SIZE, 'STARTUP', CATEGORY_COLOR.STARTUP, 'PSU', CATEGORY_COLOR.PSU, '#475569'];
    const dominant = (prop: string): ExpressionSpecification => ['==', ['get', prop], ['max', ['get', 'mnc'], ['get', 'mid'], ['get', 'sta'], ['get', 'psu']]];

    map.addSource(SRC_FOOTPRINTS, { type: 'geojson', data: this.state.parkFootprints() });
    map.addSource(SRC_PARKS, { type: 'geojson', data: this.state.parkCollection() });
    map.addSource(SRC_OFFICES, {
      type: 'geojson',
      data: this.state.officeCollection(),
      cluster: true,
      clusterRadius: 42,
      clusterMaxZoom: 15,
      clusterProperties: {
        mnc: ['+', ['case', ['==', ['get', 'category'], 'MNC'], 1, 0]],
        mid: ['+', ['case', ['==', ['get', 'category'], 'MID_SIZE'], 1, 0]],
        sta: ['+', ['case', ['==', ['get', 'category'], 'STARTUP'], 1, 0]],
        psu: ['+', ['case', ['==', ['get', 'category'], 'PSU'], 1, 0]],
      },
    });
    map.addSource(SRC_SELECTED, { type: 'geojson', data: this.state.selectedCollection() });

    map.addLayer({
      id: L_FOOTPRINT_FILL,
      type: 'fill',
      source: SRC_FOOTPRINTS,
      minzoom: 11.5,
      paint: { 'fill-color': TECH_PARK_COLOR, 'fill-opacity': 0.07 },
    });
    map.addLayer({
      id: L_FOOTPRINT_LINE,
      type: 'line',
      source: SRC_FOOTPRINTS,
      minzoom: 11.5,
      paint: { 'line-color': TECH_PARK_COLOR, 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [3, 2] },
    });

    // Parks sit UNDER the office clusters: a white ring on top of a cluster hid its count. The ring grows
    // with the number of mapped tenants, and a park with none appears only once the map is zoomed in,
    // so the city view is not 190 rings competing with the offices.
    map.addLayer({
      id: L_PARKS_EMPTY,
      type: 'circle',
      source: SRC_PARKS,
      minzoom: 12.5,
      filter: ['==', ['get', 'tenants'], 0],
      paint: {
        'circle-color': '#ffffff',
        'circle-radius': 5,
        'circle-stroke-color': TECH_PARK_COLOR,
        'circle-stroke-width': 1.2,
        'circle-opacity': 0.9,
      },
    });
    map.addLayer({
      id: L_PARKS,
      type: 'circle',
      source: SRC_PARKS,
      filter: ['>', ['get', 'tenants'], 0],
      paint: {
        'circle-color': '#ffffff',
        'circle-radius': [
          'interpolate', ['linear'], ['zoom'],
          10, ['interpolate', ['linear'], ['get', 'tenants'], 1, 4, 10, 6, 40, 9],
          15, ['interpolate', ['linear'], ['get', 'tenants'], 1, 8, 10, 11, 40, 15],
        ],
        'circle-stroke-color': TECH_PARK_COLOR,
        'circle-stroke-width': ['case', ['get', 'verified'], 2.5, 1.5],
        'circle-opacity': 0.95,
      },
    });
    const parkLabelLayout: SymbolLayerSpecification['layout'] = {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Bold'],
      'text-size': 11.5,
      'text-anchor': 'bottom',
      'text-offset': [0, -1.1],
      'text-max-width': 10,
      // the busiest parks win label collisions
      'symbol-sort-key': ['-', 0, ['get', 'tenants']],
    };
    const parkLabelPaint: SymbolLayerSpecification['paint'] = { 'text-color': TECH_PARK_COLOR, 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 };
    map.addLayer({ id: L_PARK_LABELS, type: 'symbol', source: SRC_PARKS, minzoom: 11.2, filter: ['>', ['get', 'tenants'], 0], layout: parkLabelLayout, paint: parkLabelPaint });
    map.addLayer({ id: L_PARK_LABELS_EMPTY, type: 'symbol', source: SRC_PARKS, minzoom: 13, filter: ['==', ['get', 'tenants'], 0], layout: parkLabelLayout, paint: parkLabelPaint });

    map.addLayer({
      id: L_CLUSTERS,
      type: 'circle',
      source: SRC_OFFICES,
      filter: ['has', 'point_count'],
      paint: {
        // the cluster takes the colour of the category most of its offices belong to
        'circle-color': ['case', dominant('mnc'), CATEGORY_COLOR.MNC, dominant('mid'), CATEGORY_COLOR.MID_SIZE, dominant('sta'), CATEGORY_COLOR.STARTUP, CATEGORY_COLOR.PSU],
        'circle-opacity': 0.9,
        'circle-radius': ['step', ['get', 'point_count'], 15, 10, 19, 25, 23, 60, 28],
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff',
      },
    });
    map.addLayer({
      id: L_CLUSTER_COUNT,
      type: 'symbol',
      source: SRC_OFFICES,
      filter: ['has', 'point_count'],
      layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-allow-overlap': true },
      paint: { 'text-color': '#ffffff' },
    });
    map.addLayer({
      id: L_OFFICES,
      type: 'circle',
      source: SRC_OFFICES,
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': catColor,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, ['case', ['get', 'isHq'], 5.5, 4], 15, ['case', ['get', 'isHq'], 9, 7]],
        'circle-stroke-width': ['case', ['get', 'isHq'], 2.5, 1.5],
        'circle-stroke-color': '#ffffff',
        'circle-opacity': ['match', ['get', 'status'], 'closed', 0.45, 'closing', 0.7, 1],
      },
    });
    map.addLayer({
      id: L_OFFICE_LABELS,
      type: 'symbol',
      source: SRC_OFFICES,
      filter: ['!', ['has', 'point_count']],
      minzoom: 13.2,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
        'text-anchor': 'top',
        'text-offset': [0, 0.9],
        'text-optional': true,
        'text-max-width': 9,
      },
      paint: { 'text-color': '#1e293b', 'text-halo-color': '#ffffff', 'text-halo-width': 1.3 },
    });

    map.addLayer({
      id: L_SELECTED,
      type: 'circle',
      source: SRC_SELECTED,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 11, 15, 16],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': '#f59e0b',
        'circle-stroke-width': 3.5,
      },
    });
  }

  private wireInteractions(map: MapLibreMap): void {
    const canvas = map.getCanvas();
    for (const layer of [L_CLUSTERS, L_OFFICES, L_PARKS, L_PARKS_EMPTY]) {
      map.on('mouseenter', layer, () => (canvas.style.cursor = 'pointer'));
      map.on('mouseleave', layer, () => {
        canvas.style.cursor = '';
        this.hoverPopup?.remove();
        this.hoverPopup = null;
      });
    }

    map.on('click', L_CLUSTERS, async (e) => {
      const feature = e.features?.[0];
      if (!feature) return;
      const clusterId = feature.properties['cluster_id'] as number;
      const zoom = await this.source(SRC_OFFICES)!.getClusterExpansionZoom(clusterId);
      const [lng, lat] = (feature.geometry as GeoJSON.Point).coordinates;
      map.easeTo({ center: [lng, lat], zoom: Math.min(zoom + 0.3, MAX_ZOOM), duration: this.reducedMotion() ? 0 : 500 });
    });

    map.on('mousemove', L_OFFICES, (e) => this.showHover(map, e));
    map.on('click', L_OFFICES, (e) => {
      const feature = e.features?.[0];
      if (!feature) return;
      const officeId = feature.properties['officeId'] as string;
      this.state.selectOffice(officeId, 'map');
      this.showClickPopup(map, feature);
    });

    for (const layer of [L_PARKS, L_PARKS_EMPTY]) {
      map.on('click', layer, (e) => {
        // an office drawn over the park wins the click
        if (map.queryRenderedFeatures(e.point, { layers: [L_CLUSTERS, L_OFFICES] }).length) return;
        const feature = e.features?.[0];
        if (!feature) return;
        this.state.selectPark(feature.properties['parkId'] as string, 'map');
      });
      map.on('mousemove', layer, (e) => this.showHover(map, e));
    }

    map.on('click', (e) => {
      // a click on empty map closes the click popup; the panel selection stays so the user can read on
      const hits = map.queryRenderedFeatures(e.point, { layers: [L_CLUSTERS, L_OFFICES, L_PARKS, L_PARKS_EMPTY] });
      if (!hits.length) {
        this.clickPopup?.remove();
        this.clickPopup = null;
      }
    });
  }

  private showHover(map: MapLibreMap, e: MapMouseEvent & { features?: MapGeoJSONFeature[] }): void {
    const feature = e.features?.[0];
    if (!feature) return;
    const p = feature.properties;
    const title = (p['name'] as string) ?? '';
    const sub = p['officeId'] ? `${p['label']} · ${p['locality']}` : `Tech park · ${p['tenants']} ${p['tenants'] === 1 ? 'company' : 'companies'} mapped`;
    const [lng, lat] = (feature.geometry as GeoJSON.Point).coordinates;
    if (!this.hoverPopup) {
      this.hoverPopup = new Popup({ closeButton: false, closeOnClick: false, offset: 12, className: 'hover-popup' }).addTo(map);
    }
    this.hoverPopup.setLngLat([lng, lat]).setDOMContent(this.popupNode(title, sub));
  }

  private showClickPopup(map: MapLibreMap, feature: MapGeoJSONFeature): void {
    const p = feature.properties;
    const [lng, lat] = (feature.geometry as GeoJSON.Point).coordinates;
    this.clickPopup?.remove();
    this.clickPopup = new Popup({ offset: 14, closeOnClick: false })
      .setLngLat([lng, lat])
      .setDOMContent(this.popupNode(p['name'] as string, `${p['label']} · ${p['locality']}`, 'Details are in the panel'))
      .addTo(map);
  }

  /** Popup content is built from DOM nodes, never from an HTML string, so a name can carry anything. */
  private popupNode(title: string, subtitle: string, note?: string): HTMLElement {
    const root = this.document.createElement('div');
    const h = this.document.createElement('strong');
    h.textContent = title;
    const s = this.document.createElement('div');
    s.className = 'muted';
    s.textContent = subtitle;
    root.append(h, s);
    if (note) {
      const n = this.document.createElement('div');
      n.className = 'muted';
      n.style.fontSize = '11.5px';
      n.textContent = note;
      root.append(n);
    }
    return root;
  }

  private revealPoint(lng: number, lat: number, zoom: number): void {
    const map = this.map;
    if (!map) return;
    const inView = map.getBounds().contains([lng, lat]);
    if (inView && map.getZoom() >= zoom - 1) return;
    const options = { center: [lng, lat] as [number, number], zoom: Math.max(map.getZoom(), zoom) };
    if (this.reducedMotion()) map.jumpTo(options);
    else map.flyTo({ ...options, speed: 1.4, curve: 1.3 });
  }

  private fitToVisible(): void {
    const features = this.state.officeCollection().features;
    if (!this.map || !features.length) return;
    const bounds = new LngLatBounds();
    for (const f of features) bounds.extend(f.geometry.coordinates as [number, number]);
    this.fit(bounds, 50, 15.5);
  }

  private fit(bounds: LngLatBounds, padding: number, maxZoom: number): void {
    this.map?.fitBounds(bounds, { padding, maxZoom, duration: this.reducedMotion() ? 0 : 600 });
  }

  private reducedMotion(): boolean {
    return this.document.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches ?? false;
  }
}
