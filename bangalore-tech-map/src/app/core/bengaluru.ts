/**
 * Bengaluru, and nothing else. The map cannot be panned out of `MAX_BOUNDS`, the dataset
 * refuses coordinates outside `BENGALURU_BOUNDS`, and the default view frames the city.
 *
 * The box reaches Devanahalli's aerospace park in the north (13.2), Electronics City and
 * Bommasandra in the south (12.8), Bidadi in the west (77.4) and Whitefield/Hoskote's edge in
 * the east (77.85). Hosur (Tamil Nadu) and Mysuru are deliberately outside it.
 */
export interface LatLngBounds {
  south: number;
  north: number;
  west: number;
  east: number;
}

export const BENGALURU_BOUNDS: LatLngBounds = { south: 12.75, north: 13.25, west: 77.35, east: 77.9 };

/** A little slack past the data box so the edge of the city is not a wall against the viewport. */
export const MAX_BOUNDS: [[number, number], [number, number]] = [
  [77.2, 12.6],
  [78.05, 13.4],
];

/** Vidhana Soudha, near enough the centre of the city. [lng, lat] as MapLibre wants it. */
export const BENGALURU_CENTER: [number, number] = [77.5946, 12.9791];
export const DEFAULT_ZOOM = 10.6;
export const MIN_ZOOM = 9.4;
export const MAX_ZOOM = 18;

/**
 * OpenFreeMap serves OpenMapTiles vector tiles with no API key, no sign-up and no quota, which
 * is why it is the default here rather than Mapbox, Google or MapTiler. Positron is the muted
 * style that lets the data carry the colour. Swap the URL for any MapLibre style JSON.
 */
export const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';

export function insideBengaluru(lat: number, lng: number, b: LatLngBounds = BENGALURU_BOUNDS): boolean {
  return lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east;
}
