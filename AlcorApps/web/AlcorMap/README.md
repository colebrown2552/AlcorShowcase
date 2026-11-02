# AlcorMap

![AlcorMap](../../screenshots/AlcorMap.png)

A simple map maker: search for a place or type coordinates, drop labelled markers, then share the
whole map as a link or export it as GeoJSON, CSV or a PNG image.

## How it works

| File | Role |
|---|---|
| `alcor-map-core.mjs` | Pure helpers: coordinate parsing, marker validation, state, share links, GeoJSON. |
| `alcor-map-places.mjs` | A built-in place list, so city search works without a geocoding service. |
| `alcor-map.mjs` | The UI on top of MapLibre GL JS. |

## The hard parts

- **Share links with no server.** `alcorMapEncodeShare` packs the markers into the URL itself and
  `alcorMapDecodeShare` restores them, validating every field on the way in.
- **Forgiving input, strict storage.** `alcorMapParseCoordinates` accepts the common ways people
  write coordinates; `alcorMapNormalizeMarker` and `alcorMapWrapLongitude` keep stored data valid.
- **Round-trip GeoJSON** through `alcorMapToGeoJSON` and `alcorMapFromGeoJSON`.

The basemap tiles come from OpenStreetMap, so the background map needs a network connection.
Markers, search, sharing and exports work offline.

## Run

Serve `AlcorApps/web` with any static server and open `AlcorMap/`.
