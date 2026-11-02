// Reusable OpenStreetMap view (react-leaflet) that shows one marker at a location's coordinates.
// Uses OSM raster tiles, which need no API key. Shows a tidy placeholder when coordinates are missing.
import React from 'react';
import { MapContainer, TileLayer, Marker } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

// Leaflet resolves its default marker images relative to its CSS, which webpack breaks.
// Point the default icon at the bundled image files instead.
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

export const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/**
 * Map with a marker at the given coordinates.
 * @param {{latitude: number|string, longitude: number|string, height?: number, zoom?: number}} props
 *   Coordinates in decimal degrees; `height` in pixels; `zoom` is the initial Leaflet zoom level.
 * @returns {JSX.Element} the map, or a "no map for this location" box when coordinates are unusable.
 */
export function LocationMap({ latitude, longitude, height = 220, zoom = 14 }) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  const valid =
    latitude !== null && latitude !== undefined && latitude !== '' &&
    longitude !== null && longitude !== undefined && longitude !== '' &&
    Number.isFinite(lat) && Number.isFinite(lng);

  if (!valid) {
    return (
      <div
        className="d-flex align-items-center justify-content-center text-muted border rounded bg-light"
        style={{ height }}
      >
        No map for this location
      </div>
    );
  }

  return (
    <MapContainer
      key={`${lat},${lng}`}
      center={[lat, lng]}
      zoom={zoom}
      scrollWheelZoom={false}
      style={{ height, width: '100%' }}
    >
      <TileLayer url={OSM_TILE_URL} attribution={OSM_ATTRIBUTION} />
      <Marker position={[lat, lng]} />
    </MapContainer>
  );
}

export default LocationMap;
