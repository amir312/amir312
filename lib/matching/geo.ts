/**
 * Geo math for candidate filtering. Haversine — no PostGIS, no solver, on
 * purpose: this data is tiny and 20 lines of math beat an extension.
 */

const EARTH_RADIUS_KM = 6371;

export interface LatLng {
  lat: number;
  lng: number;
}

export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la = (a.lat * Math.PI) / 180;
  const lb = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/**
 * Rough driving-time estimate from crow-flight distance. Israeli intercity
 * driving averages ~50 km/h door to door; the matcher only needs a coarse
 * filter — the human confirms the shortlist.
 */
export function estimateTravelMinutes(a: LatLng, b: LatLng, avgKmh = 50): number {
  return Math.round((haversineKm(a, b) / avgKmh) * 60);
}
