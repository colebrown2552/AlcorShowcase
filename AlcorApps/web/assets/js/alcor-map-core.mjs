// AlcorMap core: pure functions shared by the browser controller and the Node tests.
// No DOM, no network, no storage access. Every input from a file, a link, or storage is untrusted.

export const ALCORMAP_MAX_MARKERS = 500;
export const ALCORMAP_LABEL_MAX = 80;
export const ALCORMAP_STORAGE_KEY = 'alcormap.v1';
export const ALCORMAP_SHARE_PREFIX = 'am1=';
export const ALCORMAP_IMPORT_MAX_BYTES = 2 * 1024 * 1024;

export const ALCORMAP_COLORS = Object.freeze([
  Object.freeze({ id: 'magenta', name: 'Magenta', hex: '#ff5ec4' }),
  Object.freeze({ id: 'gold', name: 'Gold', hex: '#d7b56d' }),
  Object.freeze({ id: 'cyan', name: 'Cyan', hex: '#53d9d4' }),
  Object.freeze({ id: 'violet', name: 'Violet', hex: '#b38cff' }),
  Object.freeze({ id: 'green', name: 'Green', hex: '#7bd88f' }),
  Object.freeze({ id: 'orange', name: 'Orange', hex: '#ff9f43' }),
  Object.freeze({ id: 'red', name: 'Red', hex: '#ff5d6c' }),
  Object.freeze({ id: 'cream', name: 'Cream', hex: '#f6f0e4' }),
]);

function parseDecimal(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  var text = String(value == null ? '' : value).trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
  var parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function alcorMapParseCoordinates(latitude, longitude) {
  var lat = parseDecimal(latitude);
  var lng = parseDecimal(longitude);
  if (lat === null || lng === null || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat: Object.is(lat, -0) ? 0 : lat, lng: Object.is(lng, -0) ? 0 : lng };
}

export function alcorMapCleanLabel(title) {
  // Control characters and runs of whitespace collapse to single spaces; labels stay plain text.
  return String(title == null ? '' : title)
    .replace(/[\u0000-\u001f\u007f\s]+/g, ' ')
    .trim();
}

export function alcorMapNormalizeMarker(title, latitude, longitude) {
  var normalizedTitle = alcorMapCleanLabel(title);
  var coordinates = alcorMapParseCoordinates(latitude, longitude);
  if (!normalizedTitle || normalizedTitle.length > ALCORMAP_LABEL_MAX || !coordinates) return null;
  return { title: normalizedTitle, lat: coordinates.lat, lng: coordinates.lng };
}

export function alcorMapRound(value, digits) {
  var factor = Math.pow(10, digits == null ? 6 : digits);
  var rounded = Math.round(Number(value) * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function alcorMapFormatClickedCoordinate(value) {
  var parsed = parseDecimal(value);
  if (parsed === null) return '';
  return String(alcorMapRound(parsed, 6));
}

export function alcorMapWrapLongitude(lng) {
  var value = ((((Number(lng) + 180) % 360) + 360) % 360) - 180;
  return value === -180 && Number(lng) > 0 ? 180 : value;
}

/** Resolve a palette index from an index, palette id, or hex value. Unknown values use the default. */
export function alcorMapColorIndex(value) {
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < ALCORMAP_COLORS.length
  )
    return value;
  var text = String(value == null ? '' : value)
    .trim()
    .toLowerCase();
  if (/^\d$/.test(text) && Number(text) < ALCORMAP_COLORS.length) return Number(text);
  if (/^#[0-9a-f]{3}$/.test(text))
    text = '#' + text[1] + text[1] + text[2] + text[2] + text[3] + text[3];
  for (var i = 0; i < ALCORMAP_COLORS.length; i += 1) {
    if (
      ALCORMAP_COLORS[i].id === text ||
      ALCORMAP_COLORS[i].hex === text ||
      ALCORMAP_COLORS[i].name.toLowerCase() === text
    )
      return i;
  }
  return 0;
}

/** Normalize a marker from any untrusted source; long labels are shortened instead of rejected. */
export function alcorMapCoerceMarker(raw, fallbackTitle) {
  if (!raw || typeof raw !== 'object') return null;
  var coordinates = alcorMapParseCoordinates(raw.lat, raw.lng);
  if (!coordinates) return null;
  var title = alcorMapCleanLabel(raw.title);
  if (!title) title = alcorMapCleanLabel(fallbackTitle);
  if (!title) return null;
  if (title.length > ALCORMAP_LABEL_MAX) title = title.slice(0, ALCORMAP_LABEL_MAX).trim();
  return {
    title: title,
    lat: alcorMapRound(coordinates.lat, 6),
    lng: alcorMapRound(coordinates.lng, 6),
    color: alcorMapColorIndex(raw.color),
  };
}

function coerceView(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var coordinates = alcorMapParseCoordinates(raw.lat, raw.lng);
  var zoom = parseDecimal(raw.zoom);
  if (!coordinates || zoom === null || zoom < 0 || zoom > 24) return null;
  return {
    lat: alcorMapRound(coordinates.lat, 5),
    lng: alcorMapRound(coordinates.lng, 5),
    zoom: alcorMapRound(zoom, 2),
  };
}

function coerceMarkers(list, limit) {
  var markers = [];
  var skipped = 0;
  (Array.isArray(list) ? list : []).forEach(function (raw) {
    var marker = alcorMapCoerceMarker(raw, 'Pin ' + String(markers.length + 1));
    if (!marker || markers.length >= (limit == null ? ALCORMAP_MAX_MARKERS : limit)) skipped += 1;
    else markers.push(marker);
  });
  return { markers: markers, skipped: skipped };
}

/* ---------------------------------------------------------------- Local persistence */

export function alcorMapSerializeState(state) {
  var view = coerceView(state && state.view);
  var markers = coerceMarkers(state && state.markers).markers;
  return JSON.stringify({ v: 1, view: view, markers: markers });
}

export function alcorMapRestoreState(text) {
  if (typeof text !== 'string' || !text || text.length > ALCORMAP_IMPORT_MAX_BYTES) return null;
  var parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || parsed.v !== 1) return null;
  var result = coerceMarkers(parsed.markers);
  return { view: coerceView(parsed.view), markers: result.markers, skipped: result.skipped };
}

/* ---------------------------------------------------------------- Share links */

function encodeLabel(title) {
  return encodeURIComponent(title)
    .replace(/%20/g, '+')
    .replace(/[!'()*~]/g, function (character) {
      return '%' + character.charCodeAt(0).toString(16).toUpperCase();
    });
}

function decodeLabel(text) {
  return decodeURIComponent(String(text).replace(/\+/g, ' '));
}

/** Compact, versioned fragment: am1=zoom,lat,lng~lat,lng,color,label~... (fragments never reach a server). */
export function alcorMapEncodeShare(state) {
  var view = coerceView(state && state.view);
  var parts = [view ? [view.zoom, view.lat, view.lng].join(',') : ''];
  coerceMarkers(state && state.markers).markers.forEach(function (marker) {
    parts.push(
      [
        alcorMapRound(marker.lat, 5),
        alcorMapRound(marker.lng, 5),
        marker.color,
        encodeLabel(marker.title),
      ].join(','),
    );
  });
  return ALCORMAP_SHARE_PREFIX + parts.join('~');
}

export function alcorMapDecodeShare(hash) {
  var text = String(hash == null ? '' : hash).replace(/^#/, '');
  if (text.indexOf(ALCORMAP_SHARE_PREFIX) !== 0 || text.length > 60000) return null;
  var parts = text.slice(ALCORMAP_SHARE_PREFIX.length).split('~');
  var view = null;
  if (parts[0]) {
    var v = parts[0].split(',');
    view = v.length === 3 ? coerceView({ zoom: v[0], lat: v[1], lng: v[2] }) : null;
  }
  var raw = [];
  var skipped = 0;
  parts.slice(1).forEach(function (part) {
    var fields = part.split(',');
    if (fields.length !== 4) {
      skipped += 1;
      return;
    }
    var title;
    try {
      title = decodeLabel(fields[3]);
    } catch (error) {
      skipped += 1;
      return;
    }
    raw.push({
      lat: fields[0],
      lng: fields[1],
      color: /^\d$/.test(fields[2]) ? Number(fields[2]) : 0,
      title: title,
    });
  });
  var result = coerceMarkers(raw);
  return { view: view, markers: result.markers, skipped: skipped + result.skipped };
}

/* ---------------------------------------------------------------- GeoJSON and CSV */

export function alcorMapToGeoJSON(markers) {
  return {
    type: 'FeatureCollection',
    features: coerceMarkers(markers).markers.map(function (marker) {
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [marker.lng, marker.lat] },
        properties: { name: marker.title, 'marker-color': ALCORMAP_COLORS[marker.color].hex },
      };
    }),
  };
}

export function alcorMapFromGeoJSON(input) {
  var data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch (error) {
      return null;
    }
  }
  var features;
  if (data && data.type === 'FeatureCollection' && Array.isArray(data.features))
    features = data.features;
  else if (data && data.type === 'Feature') features = [data];
  else if (Array.isArray(data)) features = data;
  else return null;
  var raw = [];
  var skipped = 0;
  var unsupported = { lines: 0, areas: 0, other: 0 };
  features.forEach(function (feature) {
    var geometry = feature && feature.geometry;
    var kind = geometry && typeof geometry.type === 'string' ? geometry.type : '';
    if (/^(Multi)?LineString$/.test(kind)) {
      unsupported.lines += 1;
      skipped += 1;
      return;
    }
    if (/^(Multi)?Polygon$/.test(kind)) {
      unsupported.areas += 1;
      skipped += 1;
      return;
    }
    if (kind === 'GeometryCollection' || kind === 'MultiPoint') {
      unsupported.other += 1;
      skipped += 1;
      return;
    }
    var coordinates =
      geometry && geometry.type === 'Point' && Array.isArray(geometry.coordinates)
        ? geometry.coordinates
        : null;
    if (
      !coordinates ||
      coordinates.length < 2 ||
      typeof coordinates[0] !== 'number' ||
      typeof coordinates[1] !== 'number'
    ) {
      skipped += 1;
      return;
    }
    var properties =
      feature.properties && typeof feature.properties === 'object' ? feature.properties : {};
    var title = [properties.name, properties.title, properties.label].find(function (value) {
      return typeof value === 'string' && value.trim();
    });
    raw.push({
      lat: coordinates[1],
      lng: coordinates[0],
      title: title || '',
      color: properties['marker-color'] || properties.color,
    });
  });
  var result = coerceMarkers(raw);
  return { markers: result.markers, skipped: skipped + result.skipped, unsupported: unsupported };
}

function csvCell(value) {
  var text = String(value);
  // Spreadsheet formula guard: a leading apostrophe keeps =, +, -, @ labels as text.
  if (/^[=+\-@\t\r]/.test(text) && typeof value === 'string') text = "'" + text;
  return /[",\r\n;]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

export function alcorMapToCSV(markers) {
  var rows = ['name,latitude,longitude,color'];
  coerceMarkers(markers).markers.forEach(function (marker) {
    rows.push(
      [
        csvCell(marker.title),
        String(marker.lat),
        String(marker.lng),
        ALCORMAP_COLORS[marker.color].hex,
      ].join(','),
    );
  });
  return rows.join('\r\n') + '\r\n';
}

export function alcorMapParseCSVRows(text) {
  var source = String(text).replace(/^﻿/, '');
  var firstLine = source.split(/\r?\n/, 1)[0] || '';
  var delimiter = ',';
  [';', '\t'].forEach(function (candidate) {
    if (firstLine.split(candidate).length > firstLine.split(delimiter).length)
      delimiter = candidate;
  });
  var rows = [];
  var row = [];
  var cell = '';
  var quoted = false;
  for (var i = 0; i < source.length; i += 1) {
    var character = source[i];
    if (quoted) {
      if (character === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"' && cell === '') quoted = true;
    else if (character === delimiter) {
      row.push(cell);
      cell = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += character;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter(function (candidate) {
    return candidate.some(function (value) {
      return value.trim() !== '';
    });
  });
}

// Decimal-comma cells ("52,52" from a semicolon CSV) become decimal points.
function decimalCell(value) {
  var text = String(value == null ? '' : value).trim();
  return /^[+-]?\d+,\d+$/.test(text) ? text.replace(',', '.') : value;
}

export function alcorMapFromCSV(text) {
  var rows = alcorMapParseCSVRows(text);
  if (!rows.length) return null;
  var header = rows[0].map(function (value) {
    return value.trim().toLowerCase().replace(/^"|"$/g, '');
  });
  function column(names) {
    return header.findIndex(function (value) {
      return names.indexOf(value) >= 0;
    });
  }
  var latIndex = column(['lat', 'latitude', 'y']);
  var lngIndex = column(['lng', 'lon', 'long', 'longitude', 'x']);
  var nameIndex = column(['name', 'title', 'label', 'marker']);
  var colorIndex = column(['color', 'colour', 'marker-color']);
  var wktIndex = column(['wkt', 'geometry', 'the_geom', 'geom']);
  var body = rows.slice(1);
  if ((latIndex < 0 || lngIndex < 0) && wktIndex >= 0) {
    // Google My Maps style export: a WKT column with POINT (lng lat); lines and polygons are counted, not imported.
    var wktRaw = [];
    var unsupportedWkt = { lines: 0, areas: 0, other: 0 };
    var descIndex = column(['description']);
    body.forEach(function (cells) {
      var wkt = String(cells[wktIndex] == null ? '' : cells[wktIndex]).trim();
      var point =
        /^POINT\s*(?:Z|M|ZM)?\s*\(\s*([+-]?[\d.]+(?:[eE][+-]?\d+)?)\s+([+-]?[\d.]+(?:[eE][+-]?\d+)?)(?:\s+[+-]?[\d.]+)*\s*\)$/i.exec(
          wkt,
        );
      if (!point) {
        if (/^(MULTI)?LINESTRING/i.test(wkt)) unsupportedWkt.lines += 1;
        else if (/^(MULTI)?POLYGON/i.test(wkt)) unsupportedWkt.areas += 1;
        else if (/^(MULTIPOINT|GEOMETRYCOLLECTION)/i.test(wkt)) unsupportedWkt.other += 1;
        else wktRaw.push({ lat: null, lng: null });
        return;
      }
      var wktTitle = nameIndex >= 0 ? String(cells[nameIndex] == null ? '' : cells[nameIndex]) : '';
      if (!alcorMapCleanLabel(wktTitle) && descIndex >= 0)
        wktTitle = String(cells[descIndex] == null ? '' : cells[descIndex]);
      wktRaw.push({
        lat: point[2],
        lng: point[1],
        title: wktTitle,
        color: colorIndex >= 0 ? cells[colorIndex] : 0,
      });
    });
    var wktResult = coerceMarkers(wktRaw);
    wktResult.unsupported = unsupportedWkt;
    wktResult.skipped += unsupportedWkt.lines + unsupportedWkt.areas + unsupportedWkt.other;
    return wktResult;
  }
  if (latIndex < 0 || lngIndex < 0) {
    // Headerless "lat,lng[,name]" rows.
    if (alcorMapParseCoordinates(decimalCell(rows[0][0]), decimalCell(rows[0][1])) === null)
      return null;
    latIndex = 0;
    lngIndex = 1;
    nameIndex = rows[0].length > 2 ? 2 : -1;
    colorIndex = rows[0].length > 3 ? 3 : -1;
    body = rows;
  }
  var raw = body.map(function (cells) {
    var title = nameIndex >= 0 ? String(cells[nameIndex] == null ? '' : cells[nameIndex]) : '';
    if (/^'[=+\-@\t\r]/.test(title)) title = title.slice(1);
    return {
      lat: decimalCell(cells[latIndex]),
      lng: decimalCell(cells[lngIndex]),
      title: title,
      color: colorIndex >= 0 ? cells[colorIndex] : 0,
    };
  });
  return coerceMarkers(raw);
}

/** Detect GeoJSON or CSV text and return {markers, skipped, format} or null. */
export function alcorMapImportText(text) {
  if (typeof text !== 'string' || text.length > ALCORMAP_IMPORT_MAX_BYTES) return null;
  var trimmed = text.replace(/^﻿/, '').trim();
  if (!trimmed) return null;
  if (trimmed[0] === '{' || trimmed[0] === '[') {
    var geo = alcorMapFromGeoJSON(trimmed);
    return geo ? Object.assign(geo, { format: 'GeoJSON' }) : null;
  }
  var csv = alcorMapFromCSV(trimmed);
  return csv ? Object.assign(csv, { format: 'CSV' }) : null;
}

/* ---------------------------------------------------------------- Place search */

export function alcorMapNormalizeText(text) {
  return String(text == null ? '' : text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'ʻ`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function splitTable(table) {
  var result = {};
  String(table || '')
    .split('|')
    .forEach(function (entry) {
      var pair = entry.split('=');
      if (pair.length === 2) result[pair[0]] = pair[1].split(';');
    });
  return result;
}

/** Build a searchable index from the lazily loaded places module. */
export function alcorMapBuildPlaceIndex(module) {
  var countries = splitTable(module.ALCORMAP_COUNTRIES);
  var states = splitTable(module.ALCORMAP_US_STATES);
  var nations = splitTable(module.ALCORMAP_GB_NATIONS);
  var places = [];
  String(module.ALCORMAP_PLACES || '')
    .split('\n')
    .forEach(function (line) {
      var f = line.split('|');
      if (f.length < 6) return;
      var coordinates = alcorMapParseCoordinates(f[4], f[5]);
      if (!coordinates || ['C', 'S', 'R', 'T'].indexOf(f[1]) < 0) return;
      var countryNames = countries[f[2]] || [f[2]];
      var regionName =
        f[2] === 'US' && states[f[3]]
          ? states[f[3]][0]
          : f[2] === 'GB' && nations[f[3]]
            ? nations[f[3]][0]
            : '';
      var detail;
      if (f[1] === 'C') detail = 'Capital of ' + countryNames[0];
      else if (f[1] === 'S') detail = 'US state';
      else if (f[1] === 'R') detail = countryNames[0];
      else detail = regionName ? regionName + ', ' + countryNames[0] : countryNames[0];
      var contextWords = [];
      countryNames.concat(regionName && f[1] !== 'S' ? [regionName] : []).forEach(function (name) {
        alcorMapNormalizeText(name)
          .split(' ')
          .forEach(function (word) {
            if (word) contextWords.push(word);
          });
      });
      var codes = [f[2].toLowerCase()];
      if (f[3] && f[1] !== 'S') codes.push(f[3].toLowerCase());
      var norm = alcorMapNormalizeText(f[0]);
      places.push({
        name: f[0],
        kind: f[1],
        country: f[2],
        region: f[3],
        lat: coordinates.lat,
        lng: coordinates.lng,
        zoom:
          f[6] && parseDecimal(f[6]) !== null
            ? parseDecimal(f[6])
            : f[1] === 'C' || f[1] === 'T'
              ? 10
              : 6,
        detail: detail,
        norm: norm,
        words: norm.split(' '),
        countryNorms: countryNames.map(alcorMapNormalizeText),
        regionNorm: alcorMapNormalizeText(regionName),
        contextWords: contextWords,
        codes: codes,
      });
    });
  return places;
}

function contextMatches(place, token) {
  if (place.codes.indexOf(token) >= 0) return true;
  return (
    token.length >= 2 &&
    place.contextWords.some(function (word) {
      return word.indexOf(token) === 0;
    })
  );
}

function placeScore(place, query, tokens) {
  var name = place.norm;
  var best = 0;
  if (name === query) best = 1000;
  else if (name.indexOf(query) === 0) best = 800 - Math.min(100, name.length - query.length);
  else if (
    place.words.some(function (word) {
      return word.indexOf(query) === 0;
    })
  )
    best = 520;
  else if (query.length >= 3 && name.indexOf(query) >= 0) best = 320;
  if (best < 800 && tokens.length > 1) {
    for (var k = tokens.length - 1; k >= 1; k -= 1) {
      var head = tokens.slice(0, k).join(' ');
      if (name.indexOf(head) !== 0) continue;
      if (
        tokens.slice(k).every(function (token) {
          return contextMatches(place, token);
        })
      ) {
        best = Math.max(best, name === head ? 950 : 760);
        break;
      }
    }
  }
  if (place.kind === 'C' && query.length >= 2) {
    // A two-letter query only counts as a whole alias such as "UK"; partial matches need three letters.
    if (place.countryNorms.indexOf(query) >= 0) best = Math.max(best, 900);
    else if (
      query.length >= 3 &&
      place.countryNorms.some(function (country) {
        return country.indexOf(query) === 0;
      })
    )
      best = Math.max(best, 600);
  } else if (
    query.length >= 4 &&
    (place.countryNorms.indexOf(query) >= 0 || place.regionNorm === query)
  ) {
    best = Math.max(best, 260);
  }
  if (!best) return 0;
  return best + (place.kind === 'C' ? 30 : place.kind === 'S' ? 25 : 0);
}

export function alcorMapSearchPlaces(index, query, limit) {
  var normalized = alcorMapNormalizeText(query);
  if (!normalized || !Array.isArray(index)) return [];
  var tokens = normalized.split(' ');
  var scored = [];
  index.forEach(function (place) {
    var score = placeScore(place, normalized, tokens);
    if (score > 0) scored.push({ place: place, score: score });
  });
  scored.sort(function (a, b) {
    return (
      b.score - a.score ||
      a.place.name.length - b.place.name.length ||
      a.place.name.localeCompare(b.place.name)
    );
  });
  return scored.slice(0, limit || 8).map(function (entry) {
    return entry.place;
  });
}

// One DMS / degrees-decimal-minutes part: degrees, optional minutes, optional seconds, then N/S/E/W.
var DMS_PART =
  "(\\d+(?:\\.\\d+)?)\\s*(?:[°º]\\s*|\\s)(?:(\\d+(?:\\.\\d+)?)\\s*(?:['′’]\\s*|\\s)(?:(\\d+(?:\\.\\d+)?)\\s*(?:[\"″”]|['′’]{2}|\\s)\\s*)?)?([NSEW])";
var DMS_PATTERN = new RegExp('^' + DMS_PART + '\\s*[,;]?\\s*' + DMS_PART + '$');

function dmsValue(degrees, minutes, seconds, hemisphere) {
  if (minutes !== undefined && Number(minutes) >= 60) return null;
  if (seconds !== undefined && Number(seconds) >= 60) return null;
  var value =
    Number(degrees) +
    (minutes === undefined ? 0 : Number(minutes) / 60) +
    (seconds === undefined ? 0 : Number(seconds) / 3600);
  return hemisphere === 'S' || hemisphere === 'W' ? -value : value;
}

function parseDmsQuery(text) {
  var match = DMS_PATTERN.exec(text);
  if (!match) return null;
  var first = match[4],
    second = match[8];
  // One latitude letter and one longitude letter, in either order.
  var latFirst = first === 'N' || first === 'S';
  if (latFirst !== (second === 'E' || second === 'W')) return null;
  var a = dmsValue(match[1], match[2], match[3], first);
  var b = dmsValue(match[5], match[6], match[7], second);
  if (a === null || b === null) return null;
  return latFirst ? alcorMapParseCoordinates(a, b) : alcorMapParseCoordinates(b, a);
}

/** "30.27, -97.74", "30.27 -97.74", "30.27N 97.74W", or degrees-minutes(-seconds) with N/S/E/W. */
export function alcorMapParseCoordinateQuery(query) {
  var raw = String(query == null ? '' : query)
    .trim()
    .toUpperCase();
  var text = raw.replace(/°/g, '');
  var match = /^([+-]?\d+(?:\.\d+)?)\s*([NS])?\s*[,;\s]\s*([+-]?\d+(?:\.\d+)?)\s*([EW])?$/.exec(
    text,
  );
  if (!match) return /[NSEW]/.test(raw) && !/[+-]/.test(raw) ? parseDmsQuery(raw) : null;
  var lat = Number(match[1]) * (match[2] === 'S' ? -1 : 1);
  var lng = Number(match[3]) * (match[4] === 'W' ? -1 : 1);
  if ((match[2] && match[1][0] === '-') || (match[4] && match[3][0] === '-')) return null;
  return alcorMapParseCoordinates(lat, lng);
}

/** Bounds for "fit all markers": [[west, south], [east, north]] or null. */
export function alcorMapMarkerBounds(markers) {
  var list = Array.isArray(markers) ? markers : [];
  if (!list.length) return null;
  var south = 90,
    north = -90,
    west = 180,
    east = -180;
  list.forEach(function (marker) {
    south = Math.min(south, marker.lat);
    north = Math.max(north, marker.lat);
    west = Math.min(west, marker.lng);
    east = Math.max(east, marker.lng);
  });
  return [
    [west, south],
    [east, north],
  ];
}
