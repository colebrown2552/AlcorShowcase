/**
 * alcor-map.mjs: AlcorMap app.
 *
 * Map UI built on MapLibre GL: labelled markers, coordinate entry, import/export
 * and shareable links. Pure helpers live in alcor-map-core.mjs.
 */
import * as maplibregl from '../lib/maplibre-gl/maplibre-gl.mjs';
import {
  ALCORMAP_COLORS,
  ALCORMAP_MAX_MARKERS,
  ALCORMAP_STORAGE_KEY,
  ALCORMAP_SHARE_PREFIX,
  ALCORMAP_IMPORT_MAX_BYTES,
  alcorMapParseCoordinates,
  alcorMapNormalizeMarker,
  alcorMapFormatClickedCoordinate,
  alcorMapCoerceMarker,
  alcorMapSerializeState,
  alcorMapRestoreState,
  alcorMapEncodeShare,
  alcorMapDecodeShare,
  alcorMapToGeoJSON,
  alcorMapToCSV,
  alcorMapImportText,
  alcorMapBuildPlaceIndex,
  alcorMapSearchPlaces,
  alcorMapParseCoordinateQuery,
  alcorMapMarkerBounds,
  alcorMapWrapLongitude,
  alcorMapCleanLabel,
} from './alcor-map-core.mjs';

export { alcorMapParseCoordinates, alcorMapNormalizeMarker, alcorMapFormatClickedCoordinate };

export function alcorMapRendererAvailable(browserWindow, browserDocument) {
  if (
    typeof maplibregl.Map !== 'function' ||
    typeof maplibregl.AttributionControl !== 'function' ||
    typeof maplibregl.Marker !== 'function'
  )
    return false;
  if (!browserWindow || !browserDocument || typeof browserDocument.createElement !== 'function')
    return false;
  if (
    typeof browserWindow.WebGLRenderingContext !== 'function' &&
    typeof browserWindow.WebGL2RenderingContext !== 'function'
  )
    return false;
  try {
    var canvas = browserDocument.createElement('canvas');
    return Boolean(canvas && typeof canvas.getContext === 'function');
  } catch (error) {
    return false;
  }
}

(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  var stage = document.getElementById('alcormap-stage');
  if (!stage) return;

  var byId = function (id) {
    return document.getElementById(id);
  };
  var mapElement = byId('alcormap');
  var status = byId('alcormap-status');
  var zoomLabel = byId('alcormap-zoom');
  var chrome = document.querySelector('.am-map-chrome');
  var actions = document.querySelector('.am-map-actions');
  var form = byId('alcormap-marker-form');
  var titleInput = byId('alcormap-marker-title');
  var latInput = byId('alcormap-marker-lat');
  var lngInput = byId('alcormap-marker-lng');
  var focusCoordinatesButton = byId('alcormap-coordinate-go');
  var markerPanel = byId('alcormap-marker-panel');
  var markerList = byId('alcormap-marker-list');
  var markerEmpty = byId('alcormap-marker-empty');
  var markerCount = byId('alcormap-marker-count');
  var searchForm = byId('alcormap-search-form');
  var searchInput = byId('alcormap-search');
  var suggestions = byId('alcormap-suggestions');
  var placeCard = byId('alcormap-place');
  var placeTitle = byId('alcormap-place-title');
  var placeDetail = byId('alcormap-place-detail');
  var placeAdd = byId('alcormap-place-add');
  var placeClose = byId('alcormap-place-close');
  var sheetToggle = byId('alcormap-sheet-toggle');
  var editor = byId('alcormap-editor');
  var editTitle = byId('alcormap-edit-title');
  var editCoords = byId('alcormap-edit-coords');
  var swatches = byId('alcormap-swatches');
  var shareInput = byId('alcormap-share-url');
  var importInput = byId('alcormap-import');
  var clearConfirm = byId('alcormap-clear-confirm');
  var cfg = window.AlcorMapConfig || {};
  var map = null;
  var active = false;
  var framed = false;
  var markers = [];
  var nextMarkerId = 1;
  var maxSessionMarkers = ALCORMAP_MAX_MARKERS;
  var savedView = null;
  var selectedId = null;
  var editingId = null;
  var pendingPlace = null;
  var ghostMarker = null;
  var lastColor = 0;
  var placeIndex = null;
  var placesLoading = null;
  var suggestionItems = [];
  var activeSuggestion = -1;
  var saveTimer = 0;
  var paddingWaiting = false;
  var aim = null; // where the last fly-to was heading; kept until something else moves the camera
  var statusTimer = 0;
  var storageWarned = false;
  var undoState = null; // one level: {kind, items: [{marker, index}]}
  var undoButton = null;
  var media = function (query) {
    try {
      return Boolean(window.matchMedia(query).matches);
    } catch (error) {
      return false;
    }
  };
  var reduced = media('(prefers-reduced-motion: reduce)');
  var coarse = media('(pointer: coarse)');
  var saveData = Boolean(navigator.connection && navigator.connection.saveData);
  var storage = null;
  var storageBlocked = false;
  try {
    storage = window.localStorage || null;
  } catch (error) {
    storage = null;
    storageBlocked = true;
  }
  var narrow = media('(max-width: 899px)');

  /* ------------------------------------------------------------ small helpers */

  function setStatus(message, state) {
    status.textContent = message;
    if (state) stage.dataset.state = state;
    if (status.classList) status.classList.remove('is-faded');
    if (statusTimer && window.clearTimeout) window.clearTimeout(statusTimer);
    // The Undo button stays until the next change, so the status that holds it must not fade away.
    if (undoState && undoButton) {
      status.appendChild(undoButton);
      return;
    }
    if (active && state !== 'error')
      statusTimer = window.setTimeout(function () {
        if (status.classList) status.classList.add('is-faded');
      }, 6000);
  }

  function setInteractive(element, enabled) {
    element.setAttribute('aria-hidden', enabled ? 'false' : 'true');
    if (enabled) element.removeAttribute('inert');
    else element.setAttribute('inert', '');
  }

  function setFormEnabled(enabled) {
    Array.prototype.forEach.call(form.querySelectorAll('input, button'), function (control) {
      control.disabled = !enabled;
    });
    if (searchInput) searchInput.disabled = !enabled;
  }

  function plural(count, word) {
    return String(count) + ' ' + word + (count === 1 ? '' : 's');
  }
  function coordinateText(point) {
    return String(point.lat) + ', ' + String(point.lng);
  }
  function animate(camera) {
    aim = { center: camera.center };
    if (reduced) map.jumpTo(camera);
    else map.easeTo(Object.assign(camera, { duration: 600 }));
  }

  function makeElement(tag, className, text) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  /* ------------------------------------------------------------ persistence */

  function currentView() {
    if (map) {
      var center = map.getCenter();
      return { lat: center.lat, lng: alcorMapWrapLongitude(center.lng), zoom: map.getZoom() };
    }
    return savedView;
  }

  function currentState() {
    return {
      view: currentView(),
      markers: markers.map(function (marker) {
        return { title: marker.title, lat: marker.lat, lng: marker.lng, color: marker.color };
      }),
    };
  }

  function saveNow() {
    saveTimer = 0;
    if (!storage) {
      if (storageBlocked && markers.length && !storageWarned) {
        storageWarned = true;
        setStatus(
          'This browser blocked local saving, so this map will not survive a refresh. Export or copy a share link to keep it.',
          'ready',
        );
      }
      return;
    }
    try {
      storage.setItem(ALCORMAP_STORAGE_KEY, alcorMapSerializeState(currentState()));
    } catch (error) {
      if (!storageWarned) {
        storageWarned = true;
        setStatus(
          'This browser blocked local saving, so this map will not survive a refresh. Export or copy a share link to keep it.',
          'ready',
        );
      }
    }
  }

  function scheduleSave() {
    if (saveTimer && window.clearTimeout) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(saveNow, 250);
    updateShareLink();
  }

  function readStorage(key) {
    if (!storage) return null;
    try {
      return storage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function writeStorage(key, value) {
    if (!storage) return false;
    try {
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, value);
      return true;
    } catch (error) {
      return false;
    }
  }

  /* ------------------------------------------------------------ view chrome */

  function syncView() {
    if (!map) return;
    var zoom = map.getZoom();
    var nextFramed = zoom >= Number(cfg.streetZoom || 4);
    stage.classList.toggle('is-street', nextFramed);
    stage.classList.toggle('is-globe', !nextFramed);
    setInteractive(chrome, active);
    setInteractive(markerPanel, active);
    setInteractive(actions, active);
    setFormEnabled(active);
    zoomLabel.textContent = nextFramed
      ? 'Map view · z' + zoom.toFixed(1)
      : 'Globe view · z' + zoom.toFixed(1);
    if (nextFramed !== framed) {
      framed = nextFramed;
      window.setTimeout(
        function () {
          if (map) {
            map.resize();
            updatePadding();
          }
        },
        reduced ? 0 : 520,
      );
    }
  }

  // The area the side panel, the bottom sheet and the top chrome cover, as map padding.
  function framePadding(mapRect, sheetRect) {
    var padding = { top: 0, right: 0, bottom: 0, left: 0 };
    if (active && sheetRect.width && mapRect.width) {
      var sidePanel = sheetRect.width < mapRect.width * 0.6;
      if (sidePanel)
        padding.left = Math.max(
          0,
          Math.min(mapRect.width / 2, sheetRect.right - mapRect.left + 12),
        );
      else {
        // .am-map-chrome covers the whole map, so the controls that actually sit at the top are the search form.
        var topControls = searchForm && searchForm.getBoundingClientRect ? searchForm : chrome;
        if (topControls.getBoundingClientRect) {
          padding.top = Math.max(
            0,
            Math.min(mapRect.height / 3, topControls.getBoundingClientRect().bottom - mapRect.top),
          );
        }
        // An expanded sheet can cover most of the map; always leave a band of it visible.
        padding.bottom = Math.max(
          0,
          Math.min(mapRect.height - padding.top - 120, mapRect.bottom - sheetRect.top + 12),
        );
      }
    }
    return padding;
  }

  function updatePadding() {
    if (!map || !markerPanel.getBoundingClientRect || !mapElement.getBoundingClientRect) return;
    var mapRect = mapElement.getBoundingClientRect();
    var sheetRect = markerPanel.getBoundingClientRect();
    var padding = framePadding(mapRect, sheetRect);
    stage.style.setProperty('--am-sheet-h', Math.round(sheetRect.height || 0) + 'px');
    // setPadding() is a jumpTo(), and every jumpTo() stops the camera animation that is running. The place card, the
    // sheet and the street-view resize all settle while a fly-to is in flight, so framing waits for the camera to rest.
    if (map.isMoving()) {
      if (!paddingWaiting) {
        paddingWaiting = true;
        map.once('moveend', function () {
          paddingWaiting = false;
          updatePadding();
        });
      }
      return;
    }
    var now = map.getPadding();
    if (
      !['top', 'right', 'bottom', 'left'].every(function (side) {
        return Math.abs(now[side] - padding[side]) < 0.5;
      })
    ) {
      try {
        map.setPadding(padding);
      } catch (error) {
        /* Padding only affects framing. */
      }
    }
    // The street layout resizes the map while a fly-to is in flight, and an ease aims at a screen point measured when it
    // began, so it can land off its target. At rest, put the target back in the middle of the framed map.
    if (aim) {
      var want = map.project(aim.center);
      var have = map.project(map.getCenter());
      if (Math.hypot(want.x - have.x, want.y - have.y) > 1.5) map.jumpTo({ center: aim.center });
    }
  }

  function setSheet(expanded) {
    markerPanel.dataset.sheet = expanded ? 'expanded' : 'collapsed';
    sheetToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    window.setTimeout(updatePadding, reduced ? 0 : 260);
  }

  function fallback(message) {
    setStatus(message + ' The local globe poster and text remain available.', 'error');
  }

  // Escape lets a keyboard user leave the map canvas (where arrow keys pan) for the search box.
  function releaseMapFocus() {
    if (!active || !searchInput) return;
    closeSuggestions();
    searchInput.focus({ preventScroll: true });
  }

  // The map opens with the page, so this runs once the first style is ready; focus stays where the visitor is.
  function activateExistingMap() {
    active = true;
    stage.classList.add('has-entered');
    syncView();
    attachAllMarkers();
    renderMarkerList();
    window.setTimeout(updatePadding, 0);
    var intro_message = markers.length
      ? 'Map ready with ' +
        plural(markers.length, 'marker') +
        '. Search, or tap the map to add more.'
      : 'Map ready. Search for a place or tap the map, then choose Add marker.';
    setStatus(intro_message, 'ready');
  }

  /* ------------------------------------------------------------ coordinate form */

  function setCoordinateFields(latitude, longitude) {
    latInput.value = alcorMapFormatClickedCoordinate(latitude);
    lngInput.value = alcorMapFormatClickedCoordinate(longitude);
    latInput.removeAttribute('aria-invalid');
    lngInput.removeAttribute('aria-invalid');
  }

  function readCoordinates() {
    var coordinates = alcorMapParseCoordinates(latInput.value, lngInput.value);
    if (coordinates) {
      latInput.removeAttribute('aria-invalid');
      lngInput.removeAttribute('aria-invalid');
      return coordinates;
    }
    latInput.setAttribute('aria-invalid', 'true');
    lngInput.setAttribute('aria-invalid', 'true');
    setStatus('Use latitude from −90 to 90 and longitude from −180 to 180.', 'error');
    return null;
  }

  function markerCamera(coordinates, zoom) {
    var maxZoom = Number(cfg.maxZoom || 19);
    var targetZoom =
      zoom != null ? zoom : Math.min(maxZoom, Math.max(Number(cfg.streetZoom || 4), 11));
    if (zoom == null) targetZoom = Math.max(map.getZoom(), targetZoom);
    return { center: [coordinates.lng, coordinates.lat], zoom: Math.min(maxZoom, targetZoom) };
  }

  function moveToCoordinates(coordinates, zoom) {
    animate(markerCamera(coordinates, zoom));
  }

  /* ------------------------------------------------------------ markers */

  function findMarker(markerId) {
    return (
      markers.find(function (candidate) {
        return candidate.id === markerId;
      }) || null
    );
  }

  function paintMarkerElement(marker) {
    if (!marker.element) return;
    marker.label.textContent = marker.title;
    marker.element.style.setProperty('--am-pin', ALCORMAP_COLORS[marker.color].hex);
    marker.element.setAttribute(
      'aria-label',
      'Edit ' + marker.title + ' at ' + coordinateText(marker),
    );
    marker.element.classList.toggle('is-active', marker.id === selectedId);
  }

  function createMarkerElement(marker) {
    var element = document.createElement('button');
    element.type = 'button';
    element.className = 'am-session-marker';
    var label = document.createElement('span');
    label.className = 'am-session-marker-label';
    label.textContent = marker.title;
    var pin = document.createElement('span');
    pin.className = 'am-session-marker-pin';
    pin.setAttribute('aria-hidden', 'true');
    element.appendChild(label);
    element.appendChild(pin);
    element.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      openEditor(marker.id, false);
    });
    marker.label = label;
    return element;
  }

  function attachMarker(marker) {
    if (!map || marker.mapMarker) return true;
    var element = createMarkerElement(marker);
    try {
      marker.mapMarker = new maplibregl.Marker({ element: element, anchor: 'bottom' })
        .setLngLat([marker.lng, marker.lat])
        .addTo(map);
    } catch (error) {
      setStatus('The marker could not be placed. The existing map remains available.', 'error');
      return false;
    }
    marker.element = element;
    paintMarkerElement(marker);
    return true;
  }

  function attachAllMarkers() {
    markers.forEach(attachMarker);
  }

  function detachMarker(marker) {
    if (marker.mapMarker) marker.mapMarker.remove();
    marker.mapMarker = null;
    marker.element = null;
  }

  function addMarkerRecord(raw) {
    var clean = alcorMapCoerceMarker(raw, 'Pin ' + String(markers.length + 1));
    if (!clean || markers.length >= maxSessionMarkers) return null;
    var record = {
      id: nextMarkerId,
      title: clean.title,
      lat: clean.lat,
      lng: clean.lng,
      color: clean.color,
      mapMarker: null,
      element: null,
    };
    nextMarkerId += 1;
    markers.push(record);
    if (map && !attachMarker(record)) {
      markers.pop();
      return null;
    }
    return record;
  }

  function addMarker(marker, options) {
    if (markers.length >= maxSessionMarkers) {
      setStatus(
        'This map holds up to ' +
          String(maxSessionMarkers) +
          ' markers. Remove one before adding another.',
        'error',
      );
      return null;
    }
    var record = addMarkerRecord({
      title: marker.title,
      lat: marker.lat,
      lng: marker.lng,
      color: marker.color == null ? lastColor : marker.color,
    });
    if (!record) return null;
    clearUndo();
    selectedId = record.id;
    markers.forEach(paintMarkerElement);
    renderMarkerList();
    if (!(options && options.keepCamera)) moveToCoordinates(record);
    scheduleSave();
    setStatus(
      'Added “' +
        record.title +
        '”. Select it in the list or on the map to rename it or change its color.',
      'ready',
    );
    return record;
  }

  function focusMarker(markerId) {
    var marker = findMarker(markerId);
    if (!marker || !map || !active) return;
    selectedId = markerId;
    markers.forEach(paintMarkerElement);
    renderMarkerList();
    moveToCoordinates(marker);
    setStatus('Focused “' + marker.title + '” at ' + coordinateText(marker) + '.', 'ready');
  }

  function removeMarker(markerId) {
    var index = markers.findIndex(function (candidate) {
      return candidate.id === markerId;
    });
    if (index < 0) return;
    var removed = markers[index];
    var hadFocus =
      focusWasIn(markerList.querySelector('[data-marker-id="' + String(markerId) + '"]')) ||
      focusWasIn(editor);
    detachMarker(removed);
    markers.splice(index, 1);
    undoState = {
      items: [{ marker: removed, index: index }],
      message: 'Restored “' + removed.title + '”.',
    };
    if (editingId === markerId) closeEditor();
    if (selectedId === markerId) selectedId = null;
    renderMarkerList();
    scheduleSave();
    setStatus(
      'Removed “' +
        removed.title +
        '”. ' +
        plural(markers.length, 'marker') +
        (markers.length === 1 ? ' remains.' : ' remain.'),
      'ready',
    );
    if (hadFocus) undoButton.focus({ preventScroll: true });
  }

  function focusWasIn(element) {
    return Boolean(element && document.activeElement && element.contains(document.activeElement));
  }

  function clearUndo() {
    undoState = null;
    if (undoButton && undoButton.parentNode) undoButton.parentNode.removeChild(undoButton);
  }

  function undoLast() {
    var pending = undoState;
    clearUndo();
    if (!pending) return;
    var restored = 0;
    pending.items.forEach(function (item) {
      var marker = item.marker;
      marker.mapMarker = null;
      marker.element = null;
      markers.splice(Math.min(item.index, markers.length), 0, marker);
      if (map && !attachMarker(marker)) markers.splice(markers.indexOf(marker), 1);
      else restored += 1;
    });
    renderMarkerList();
    scheduleSave();
    setStatus(
      restored === pending.items.length ? pending.message : 'Some markers could not be restored.',
      restored ? 'ready' : 'error',
    );
    if (restored)
      (markerList.querySelector('[data-marker-action="focus"]') || mapElement).focus({
        preventScroll: true,
      });
  }

  function makeUndoButton() {
    undoButton = makeElement('button', 'am-undo', 'Undo');
    undoButton.type = 'button';
    undoButton.addEventListener('click', undoLast);
  }

  function renderMarkerList() {
    markerList.textContent = '';
    stage.classList.toggle('has-session-markers', markers.length > 0);
    markerEmpty.hidden = markers.length > 0;
    markerCount.textContent = plural(markers.length, 'marker');
    markers.forEach(function (marker) {
      var item = document.createElement('li');
      item.dataset.markerId = String(marker.id);
      if (marker.id === selectedId) item.className = 'is-selected';
      var dot = makeElement('span', 'am-dot');
      dot.setAttribute('aria-hidden', 'true');
      dot.style.setProperty('--am-pin', ALCORMAP_COLORS[marker.color].hex);
      var details = document.createElement('div');
      details.className = 'am-marker-list-details';
      var title = document.createElement('strong');
      title.textContent = marker.title;
      var coordinates = document.createElement('span');
      coordinates.textContent = coordinateText(marker);
      details.appendChild(title);
      details.appendChild(coordinates);
      var controls = document.createElement('div');
      controls.className = 'am-marker-list-actions';
      [
        ['focus', 'Focus'],
        ['edit', 'Edit'],
        ['remove', 'Remove'],
      ].forEach(function (pair) {
        var button = document.createElement('button');
        button.type = 'button';
        button.dataset.markerAction = pair[0];
        button.textContent = pair[1];
        button.setAttribute('aria-label', pair[1] + ' ' + marker.title);
        controls.appendChild(button);
      });
      item.appendChild(dot);
      item.appendChild(details);
      item.appendChild(controls);
      markerList.appendChild(item);
    });
    updateTools();
  }

  /* ------------------------------------------------------------ editor */

  function buildSwatches() {
    if (!swatches) return;
    swatches.textContent = '';
    ALCORMAP_COLORS.forEach(function (color, index) {
      var label = makeElement('label', 'am-swatch');
      var input = document.createElement('input');
      input.type = 'radio';
      input.name = 'alcormap-color';
      input.value = String(index);
      var chip = makeElement('span', 'am-swatch-chip');
      chip.setAttribute('aria-hidden', 'true');
      chip.style.setProperty('--am-pin', color.hex);
      var name = makeElement('span', 'am-sr-only', color.name);
      label.appendChild(input);
      label.appendChild(chip);
      label.appendChild(name);
      swatches.appendChild(label);
    });
  }

  function openEditor(markerId, focusInput) {
    var marker = findMarker(markerId);
    if (!marker || !active) return;
    editingId = markerId;
    selectedId = markerId;
    markers.forEach(paintMarkerElement);
    renderMarkerList();
    editTitle.value = marker.title;
    editTitle.removeAttribute('aria-invalid');
    editCoords.textContent = coordinateText(marker);
    Array.prototype.forEach.call(swatches.querySelectorAll('input'), function (input) {
      input.checked = Number(input.value) === marker.color;
    });
    editor.hidden = false;
    setSheet(true);
    if (editor.scrollIntoView) editor.scrollIntoView({ block: 'nearest' });
    if (focusInput) editTitle.focus({ preventScroll: true });
    setStatus('Editing “' + marker.title + '”.', 'ready');
  }

  function closeEditor() {
    editingId = null;
    editor.hidden = true;
  }

  function saveEditor() {
    var marker = findMarker(editingId);
    if (!marker) {
      closeEditor();
      return;
    }
    var title = alcorMapCleanLabel(editTitle.value);
    if (!title || title.length > 80) {
      editTitle.setAttribute('aria-invalid', 'true');
      setStatus('Add a plain-text marker label of 80 characters or fewer.', 'error');
      return;
    }
    var checked = swatches.querySelector('input:checked');
    clearUndo();
    marker.title = title;
    marker.color = checked ? Number(checked.value) : marker.color;
    lastColor = marker.color;
    paintMarkerElement(marker);
    closeEditor();
    renderMarkerList();
    scheduleSave();
    setStatus('Saved “' + marker.title + '”.', 'ready');
  }

  /* ------------------------------------------------------------ place card */

  function showPlace(place) {
    pendingPlace = place;
    placeTitle.textContent = place.title;
    placeDetail.textContent = (place.detail ? place.detail + ' · ' : '') + coordinateText(place);
    placeCard.hidden = false;
    stage.classList.add('has-place');
    if (map) {
      try {
        if (!ghostMarker) {
          var element = makeElement('span', 'am-ghost');
          element.setAttribute('aria-hidden', 'true');
          ghostMarker = new maplibregl.Marker({ element: element, anchor: 'center' });
        }
        ghostMarker.setLngLat([place.lng, place.lat]).addTo(map);
      } catch (error) {
        /* The card still offers the action without a preview dot. */
      }
    }
  }

  function hidePlace() {
    pendingPlace = null;
    placeCard.hidden = true;
    stage.classList.remove('has-place');
    if (ghostMarker) {
      try {
        ghostMarker.remove();
      } catch (error) {
        /* Already removed. */
      }
    }
  }

  function addPendingPlace() {
    if (!pendingPlace || !active) return;
    var place = pendingPlace;
    hidePlace();
    addMarker({ title: place.title, lat: place.lat, lng: place.lng }, { keepCamera: true });
  }

  function prefillFromMapClick(event) {
    if (!active || !event || !event.lngLat) return;
    var wrappedLongitude = alcorMapWrapLongitude(Number(event.lngLat.lng));
    setCoordinateFields(Number(event.lngLat.lat), wrappedLongitude);
    closeSuggestions();
    if (markerPanel.dataset.sheet === 'expanded' && !media('(min-width: 900px)')) setSheet(false);
    var point = alcorMapParseCoordinates(Number(latInput.value), Number(lngInput.value));
    if (!point) return;
    showPlace({
      title: 'Pin ' + String(markers.length + 1),
      detail: 'Dropped pin',
      lat: Number(alcorMapFormatClickedCoordinate(point.lat)),
      lng: Number(alcorMapFormatClickedCoordinate(point.lng)),
      dropped: true,
    });
    setStatus('Point selected. Choose Add marker here, or tap somewhere else.', 'ready');
  }

  /* ------------------------------------------------------------ search */

  function placesUrl() {
    var fallbackUrl = './alcor-map-places.mjs';
    try {
      var url = new URL(String(cfg.placesUrl || ''), window.location.href);
      return url.origin === window.location.origin ? url.href : fallbackUrl;
    } catch (error) {
      return fallbackUrl;
    }
  }

  function loadPlaces() {
    if (placeIndex) return Promise.resolve(placeIndex);
    if (!placesLoading) {
      placesLoading = import(placesUrl())
        .then(function (module) {
          placeIndex = alcorMapBuildPlaceIndex(module);
          return placeIndex;
        })
        .catch(function (error) {
          placesLoading = null;
          throw error;
        });
    }
    return placesLoading;
  }

  function closeSuggestions() {
    if (!suggestions) return;
    suggestions.hidden = true;
    suggestions.textContent = '';
    stage.classList.remove('is-searching');
    suggestionItems = [];
    activeSuggestion = -1;
    searchInput.setAttribute('aria-expanded', 'false');
    searchInput.removeAttribute('aria-activedescendant');
  }

  function highlightSuggestion(index) {
    activeSuggestion = index;
    Array.prototype.forEach.call(suggestions.children, function (child, childIndex) {
      child.setAttribute('aria-selected', childIndex === index ? 'true' : 'false');
    });
    if (index >= 0 && suggestions.children[index])
      searchInput.setAttribute('aria-activedescendant', suggestions.children[index].id);
    else searchInput.removeAttribute('aria-activedescendant');
  }

  function renderSuggestions(items, emptyMessage) {
    suggestions.textContent = '';
    suggestionItems = items;
    activeSuggestion = -1;
    items.forEach(function (item, index) {
      var option = makeElement('li', 'am-suggest-item');
      option.id = 'alcormap-suggestion-' + String(index);
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.dataset.index = String(index);
      option.appendChild(makeElement('strong', '', item.title));
      option.appendChild(makeElement('span', '', item.detail));
      suggestions.appendChild(option);
    });
    if (!items.length && emptyMessage) {
      var empty = makeElement('li', 'am-suggest-empty', emptyMessage);
      empty.setAttribute('role', 'presentation');
      suggestions.appendChild(empty);
    }
    var open = Boolean(items.length || emptyMessage);
    suggestions.hidden = !open;
    stage.classList.toggle('is-searching', open);
    searchInput.setAttribute('aria-expanded', items.length ? 'true' : 'false');
  }

  function searchResults(query) {
    var results = [];
    var coordinates = alcorMapParseCoordinateQuery(query);
    if (coordinates)
      results.push({
        title: 'Go to ' + coordinateText(coordinates),
        detail: 'Coordinates',
        lat: coordinates.lat,
        lng: coordinates.lng,
        zoom: 12,
        pinTitle: 'Pin at ' + coordinateText(coordinates),
      });
    alcorMapSearchPlaces(placeIndex, query, 7).forEach(function (place) {
      results.push({
        title: place.name,
        detail: place.detail,
        lat: place.lat,
        lng: place.lng,
        zoom: place.zoom,
        pinTitle: place.name,
      });
    });
    return results.slice(0, 7);
  }

  function updateSearch() {
    var query = searchInput.value;
    if (!query.trim()) {
      closeSuggestions();
      return;
    }
    loadPlaces()
      .then(function () {
        if (searchInput.value !== query) return;
        renderSuggestions(
          searchResults(query),
          'No match in the built-in place list. Try a larger nearby city, or type coordinates.',
        );
      })
      .catch(function () {
        renderSuggestions(
          alcorMapParseCoordinateQuery(query) ? searchResults(query) : [],
          'Place search could not load. Coordinates still work, like 30.27, -97.74.',
        );
      });
  }

  function chooseSuggestion(index) {
    var item = suggestionItems[index];
    if (!item || !map || !active) return;
    closeSuggestions();
    searchInput.value = item.pinTitle;
    if (coarse) searchInput.blur();
    moveToCoordinates(item, Math.min(Number(cfg.maxZoom || 19), item.zoom));
    setCoordinateFields(item.lat, item.lng);
    showPlace({
      title: item.pinTitle,
      detail: item.detail === 'Coordinates' ? '' : item.detail,
      lat: item.lat,
      lng: item.lng,
    });
    setStatus('Showing ' + item.pinTitle + '. Choose Add marker here to pin it.', 'ready');
  }

  /* ------------------------------------------------------------ tools */

  function updateTools() {
    var has = markers.length > 0;
    Array.prototype.forEach.call(markerPanel.querySelectorAll('[data-tool]'), function (button) {
      var tool = button.dataset.tool;
      if (['fit', 'share', 'copy', 'geojson', 'csv', 'clear'].indexOf(tool) >= 0)
        button.disabled = !has;
    });
    updateShareLink();
  }

  function shareLink() {
    var location = window.location;
    return (
      location.origin +
      location.pathname +
      location.search +
      '#' +
      alcorMapEncodeShare(currentState())
    );
  }

  function updateShareLink() {
    if (!shareInput || !window.location) return;
    shareInput.value = markers.length ? shareLink() : '';
  }

  function copyShareLink() {
    if (!markers.length) return;
    var link = shareLink();
    shareInput.value = link;
    var done = function () {
      setStatus('Share link copied. It contains your labels and coordinates.', 'ready');
    };
    var manual = function () {
      setSheet(true);
      shareInput.focus({ preventScroll: true });
      shareInput.select();
      setStatus('Copy the selected link to share this map.', 'ready');
    };
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function')
      navigator.clipboard.writeText(link).then(done, manual);
    else manual();
  }

  function shareMap() {
    if (!markers.length) return;
    if (coarse && typeof navigator.share === 'function') {
      navigator.share({ title: 'AlcorMap', url: shareLink() }).catch(function () {
        /* Dismissed sheet is not an error. */
      });
      return;
    }
    copyShareLink();
  }

  function stamp() {
    var now = new Date();
    var pad = function (value) {
      return String(value).padStart(2, '0');
    };
    return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  }

  function download(filename, blob) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 4000);
  }

  function exportText(kind) {
    if (!markers.length) return;
    var state = currentState();
    if (kind === 'geojson') {
      download(
        'alcormap-' + stamp() + '.geojson',
        new Blob([JSON.stringify(alcorMapToGeoJSON(state.markers), null, 2) + '\n'], {
          type: 'application/geo+json',
        }),
      );
      setStatus('Exported ' + plural(markers.length, 'marker') + ' as GeoJSON.', 'ready');
    } else {
      download(
        'alcormap-' + stamp() + '.csv',
        new Blob([alcorMapToCSV(state.markers)], { type: 'text/csv' }),
      );
      setStatus('Exported ' + plural(markers.length, 'marker') + ' as CSV.', 'ready');
    }
  }

  function importMarkers(list, skipped, format, unsupported) {
    clearUndo();
    var room = maxSessionMarkers - markers.length;
    var added = [];
    list.slice(0, Math.max(0, room)).forEach(function (marker) {
      var record = addMarkerRecord(marker);
      if (record) added.push(record);
    });
    var overLimit = Math.max(0, list.length - Math.max(0, room));
    var dropped = skipped + overLimit;
    renderMarkerList();
    scheduleSave();
    if (added.length && map) fitMarkers(added);
    var message =
      'Imported ' + plural(added.length, 'marker') + (format ? ' from ' + format : '') + '.';
    var parts = [];
    if (unsupported && unsupported.lines)
      parts.push(plural(unsupported.lines, 'line') + ' (routes are not supported)');
    if (unsupported && unsupported.areas)
      parts.push(plural(unsupported.areas, 'polygon') + ' (areas are not supported)');
    if (unsupported && unsupported.other)
      parts.push(plural(unsupported.other, 'multi-part or mixed shape') + ' (not supported)');
    var invalid = Math.max(
      0,
      skipped - (unsupported ? unsupported.lines + unsupported.areas + unsupported.other : 0),
    );
    if (invalid) parts.push(String(invalid) + ' invalid row' + (invalid === 1 ? '' : 's'));
    if (overLimit)
      parts.push(String(overLimit) + ' over the ' + String(maxSessionMarkers) + '-marker limit');
    if (parts.length) message += ' Skipped ' + parts.join(', ') + '.';
    setStatus(message, added.length ? 'ready' : 'error');
  }

  function importFile(file) {
    if (!file) return;
    if (file.size > ALCORMAP_IMPORT_MAX_BYTES) {
      setStatus('That file is larger than 2 MB. Import a smaller GeoJSON or CSV file.', 'error');
      return;
    }
    file
      .text()
      .then(function (text) {
        var result = alcorMapImportText(text);
        if (!result) {
          setStatus(
            'That file is not GeoJSON points or a CSV with latitude and longitude columns.',
            'error',
          );
          return;
        }
        importMarkers(result.markers, result.skipped, result.format, result.unsupported);
      })
      .catch(function () {
        setStatus('The file could not be read.', 'error');
      });
  }

  function fitMarkers(list) {
    var targets = list || markers;
    if (!map || !targets.length) return;
    if (targets.length === 1) {
      moveToCoordinates(targets[0]);
      return;
    }
    var bounds = alcorMapMarkerBounds(targets);
    aim = null;
    // fitBounds() adds the map's own padding (the sheet and the top controls, see updatePadding) to the margin below,
    // so bring that padding up to date first: it may be stale after the sheet moved or while a camera move was running.
    if (active && mapElement.getBoundingClientRect && markerPanel.getBoundingClientRect) {
      var covered = framePadding(
        mapElement.getBoundingClientRect(),
        markerPanel.getBoundingClientRect(),
      );
      try {
        map.setPadding(covered);
      } catch (error) {
        /* Padding only affects framing. */
      }
    }
    try {
      map.fitBounds(bounds, {
        padding: 56,
        maxZoom: Math.min(14, Number(cfg.maxZoom || 19)),
        duration: reduced ? 0 : 600,
        animate: !reduced,
      });
    } catch (error) {
      moveToCoordinates(targets[0]);
    }
  }

  function clearMap(confirmed) {
    if (!confirmed) {
      clearConfirm.hidden = false;
      setSheet(true);
      var yes = clearConfirm.querySelector('[data-tool="clear-yes"]');
      if (yes) yes.focus({ preventScroll: true });
      return;
    }
    clearConfirm.hidden = true;
    var count = markers.length;
    var hadFocus = focusWasIn(clearConfirm);
    undoState = count
      ? {
          items: markers.map(function (marker, index) {
            return { marker: marker, index: index };
          }),
          message: 'Restored ' + plural(count, 'marker') + '.',
        }
      : null;
    markers.forEach(detachMarker);
    markers = [];
    selectedId = null;
    closeEditor();
    hidePlace();
    renderMarkerList();
    writeStorage(ALCORMAP_STORAGE_KEY, null);
    saveNow();
    setStatus('Cleared ' + plural(count, 'marker') + '.', 'ready');
    if (hadFocus && undoState) undoButton.focus({ preventScroll: true });
  }

  function restorePrevious() {
    var previous = alcorMapRestoreState(readStorage(ALCORMAP_STORAGE_KEY + '.previous'));
    if (!previous) return;
    clearUndo();
    markers.forEach(detachMarker);
    markers = [];
    previous.markers.forEach(addMarkerRecord);
    writeStorage(ALCORMAP_STORAGE_KEY + '.previous', null);
    renderMarkerList();
    renderRestoreButton();
    scheduleSave();
    fitMarkers();
    setStatus('Restored your previous map with ' + plural(markers.length, 'marker') + '.', 'ready');
  }

  function renderRestoreButton() {
    var button = markerPanel.querySelector('[data-tool="restore"]');
    if (button) button.hidden = !readStorage(ALCORMAP_STORAGE_KEY + '.previous');
  }

  /* ------------------------------------------------------------ PNG snapshot */

  function attributionText() {
    try {
      var parsed = new DOMParser().parseFromString(String(cfg.attributionHtml || ''), 'text/html');
      return (parsed.body.textContent || '').replace(/\s+/g, ' ').trim();
    } catch (error) {
      return '';
    }
  }

  function roundedRect(context, x, y, width, height, radius) {
    context.beginPath();
    context.moveTo(x + radius, y);
    context.arcTo(x + width, y, x + width, y + height, radius);
    context.arcTo(x + width, y + height, x, y + height, radius);
    context.arcTo(x, y + height, x, y, radius);
    context.arcTo(x, y, x + width, y, radius);
    context.closePath();
  }

  function drawSnapshotMarker(context, marker, x, y, scale) {
    var color = ALCORMAP_COLORS[marker.color].hex;
    context.save();
    context.translate(x, y);
    context.beginPath();
    context.moveTo(0, 0);
    context.bezierCurveTo(-7 * scale, -9 * scale, -9 * scale, -13 * scale, -9 * scale, -18 * scale);
    context.arc(0, -18 * scale, 9 * scale, Math.PI, 0);
    context.bezierCurveTo(9 * scale, -13 * scale, 7 * scale, -9 * scale, 0, 0);
    context.fillStyle = color;
    context.strokeStyle = '#0b0d13';
    context.lineWidth = 2 * scale;
    context.fill();
    context.stroke();
    context.beginPath();
    context.arc(0, -18 * scale, 3.4 * scale, 0, Math.PI * 2);
    context.fillStyle = '#0b0d13';
    context.fill();
    context.font = '700 ' + String(12 * scale) + 'px "Segoe UI", system-ui, sans-serif';
    var text = marker.title.length > 40 ? marker.title.slice(0, 39) + '…' : marker.title;
    var width = context.measureText(text).width + 14 * scale;
    var height = 22 * scale;
    roundedRect(context, -width / 2, -32 * scale - height, width, height, 5 * scale);
    context.fillStyle = '#f6f0e4';
    context.fill();
    context.lineWidth = 2 * scale;
    context.strokeStyle = color;
    context.stroke();
    context.fillStyle = '#160919';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, 0, -32 * scale - height / 2);
    context.restore();
  }

  function composeSnapshot() {
    var source = map.getCanvas();
    var width = source.width;
    var height = source.height;
    var scale = width / (source.clientWidth || width);
    var output = document.createElement('canvas');
    output.width = width;
    output.height = height;
    var context = output.getContext('2d');
    context.fillStyle = '#0b0d13';
    context.fillRect(0, 0, width, height);
    context.drawImage(source, 0, 0);
    markers.forEach(function (marker) {
      if (marker.element && parseFloat(marker.element.style.opacity || '1') < 0.5) return;
      var point = map.project([marker.lng, marker.lat]);
      var x = point.x * scale;
      var y = point.y * scale;
      if (x < -40 || y < -40 || x > width + 40 || y > height + 60) return;
      drawSnapshotMarker(context, marker, x, y, scale);
    });
    var credit = [attributionText(), 'Made with AlcorMap'].filter(Boolean).join(' · ');
    context.font = '600 ' + String(11 * scale) + 'px "Segoe UI", system-ui, sans-serif';
    var creditWidth = context.measureText(credit).width + 16 * scale;
    context.fillStyle = 'rgba(11, 13, 19, 0.82)';
    context.fillRect(width - creditWidth, height - 22 * scale, creditWidth, 22 * scale);
    context.fillStyle = '#f6f0e4';
    context.textAlign = 'right';
    context.textBaseline = 'middle';
    context.fillText(credit, width - 8 * scale, height - 11 * scale);
    return output;
  }

  function snapshotFailed() {
    setStatus(
      'This tile provider does not allow its map images to be saved, so a PNG could not be made. GeoJSON, CSV, and share links still work.',
      'error',
    );
  }

  function exportPng() {
    if (!map || !active) return;
    setStatus('Preparing image…', 'ready');
    map.once('render', function () {
      var output;
      try {
        output = composeSnapshot();
      } catch (error) {
        snapshotFailed();
        return;
      }
      try {
        output.toBlob(function (blob) {
          if (!blob) {
            snapshotFailed();
            return;
          }
          download('alcormap-' + stamp() + '.png', blob);
          setStatus(
            'Saved a PNG of the current view' +
              (markers.length ? ' with ' + plural(markers.length, 'marker') : '') +
              '. Tiles that had not loaded appear blank.',
            'ready',
          );
        }, 'image/png');
      } catch (error) {
        snapshotFailed();
      }
    });
    map.triggerRepaint();
  }

  /* ------------------------------------------------------------ boot state */

  function applyState(state) {
    markers.forEach(detachMarker);
    markers = [];
    state.markers.forEach(addMarkerRecord);
    savedView = state.view;
  }

  function readSharedHash() {
    var location = window.location;
    if (
      !location ||
      typeof location.hash !== 'string' ||
      location.hash.indexOf('#' + ALCORMAP_SHARE_PREFIX) !== 0
    )
      return null;
    var shared = alcorMapDecodeShare(location.hash);
    try {
      if (window.history && typeof window.history.replaceState === 'function')
        window.history.replaceState(null, '', location.pathname + location.search);
    } catch (error) {
      /* The hash stays; it is re-read harmlessly. */
    }
    return shared;
  }

  function openShared(shared) {
    clearUndo();
    var existing = readStorage(ALCORMAP_STORAGE_KEY);
    var mine = alcorMapRestoreState(existing);
    if (mine && mine.markers.length && existing !== alcorMapSerializeState(shared))
      writeStorage(ALCORMAP_STORAGE_KEY + '.previous', existing);
    applyState(shared);
    stage.dataset.shared = 'true';
    saveNow();
    renderRestoreButton();
  }

  function boot() {
    buildSwatches();
    var shared = readSharedHash();
    if (shared && shared.markers.length) openShared(shared);
    else {
      var saved = alcorMapRestoreState(readStorage(ALCORMAP_STORAGE_KEY));
      if (saved) applyState(saved);
    }
    renderMarkerList();
    renderRestoreButton();
    setSheet(media('(min-width: 900px)'));
  }

  /* ------------------------------------------------------------ renderer */

  // Called once at boot: the map and its tiles load with the page (owner 2026-10-29).
  function start() {
    if (map || stage.dataset.state === 'loading') return;
    if (saveData) {
      fallback('Data Saver is enabled, so AlcorMap did not request remote tiles.');
      return;
    }
    if (!alcorMapRendererAvailable(window, document)) {
      fallback('This browser cannot start the WebGL map.');
      return;
    }
    setStatus('Loading visible tiles from the configured provider…', 'loading');
    var nextMap = null;
    var view = savedView;
    try {
      // Singleton invariant: this is the only Map constructor in this bundle.
      nextMap = new maplibregl.Map({
        container: 'alcormap',
        center: view ? [view.lng, view.lat] : cfg.initialCenter || [-20, 25],
        zoom: view ? view.zoom : Number(cfg.initialZoom || 1.45),
        minZoom: 0.5,
        maxZoom: Number(cfg.maxZoom || 19),
        projection: 'globe',
        // Touch devices pan with one finger; mouse wheels zoom directly unless the page scrolls (narrow windows), where Control is required.
        cooperativeGestures: narrow && !coarse,
        attributionControl: false,
        fadeDuration: reduced ? 0 : 240,
        pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
        canvasContextAttributes: { antialias: false, preserveDrawingBuffer: false },
        refreshExpiredTiles: false,
        maxTileCacheSize: 64,
        maxTileCacheZoomLevels: 2,
        style: {
          version: 8,
          sources: {
            configuredTiles: {
              type: 'raster',
              tiles: [cfg.tileUrl],
              tileSize: 256,
              attribution: cfg.attributionHtml,
              maxzoom: Number(cfg.maxZoom || 19),
            },
          },
          layers: [
            {
              id: 'configured-tiles',
              type: 'raster',
              source: 'configuredTiles',
              paint: { 'raster-fade-duration': reduced ? 0 : 240 },
            },
          ],
        },
      });
      nextMap.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
      nextMap.keyboard.enable();
      nextMap.on('zoom', syncView);
      nextMap.on('moveend', scheduleSave);
      nextMap.on('movestart', function (event) {
        if (event.originalEvent) aim = null;
      });
      var ready = false;
      var onReady = function () {
        if (ready) return;
        ready = true;
        activateExistingMap();
        // Wait for the opening transition to settle the canvas size before framing shared or restored pins.
        if (!view && markers.length)
          window.setTimeout(
            function () {
              map.resize();
              updatePadding();
              fitMarkers();
            },
            reduced ? 0 : 600,
          );
      };
      // 'load' waits for every visible tile; a failing provider can delay it indefinitely, so the
      // parsed style is enough to start working with markers and search.
      nextMap.on('load', onReady);
      nextMap.on('style.load', function () {
        window.setTimeout(onReady, 1500);
      });
      nextMap.on('click', prefillFromMapClick);
      nextMap.on('error', function (event) {
        if (event && event.error)
          setStatus(
            'Some visible tiles could not be loaded. The configured provider may be unavailable.',
            'error',
          );
      });
      var canvas = nextMap.getCanvas();
      canvas.addEventListener('webglcontextlost', function (event) {
        event.preventDefault();
        setStatus(
          'The graphics context was lost. The text and local poster remain available while the browser attempts recovery.',
          'error',
        );
      });
      canvas.addEventListener('webglcontextrestored', function () {
        setStatus('Graphics context restored.', 'ready');
        map.resize();
      });
      if ('ResizeObserver' in window) {
        new ResizeObserver(function () {
          if (map) {
            map.resize();
            updatePadding();
          }
        }).observe(document.getElementById('alcormap'));
        new ResizeObserver(function () {
          updatePadding();
        }).observe(markerPanel);
      }
      map = nextMap;
    } catch (error) {
      if (nextMap && typeof nextMap.remove === 'function') {
        try {
          nextMap.remove();
        } catch (cleanupError) {
          /* Constructor guard remains fail-closed. */
        }
      }
      fallback('The map could not be initialized.');
    }
  }

  function move(action) {
    if (!map || !active) return;
    aim = null;
    var duration = reduced ? 0 : 400;
    var offsets = { north: [0, -120], south: [0, 120], west: [-120, 0], east: [120, 0] };
    if (offsets[action]) map.panBy(offsets[action], { duration: duration, animate: !reduced });
    else if (action === 'zoom-in')
      map.zoomTo(Math.min(map.getZoom() + 1, Number(cfg.maxZoom || 19)), {
        duration: duration,
        animate: !reduced,
      });
    else if (action === 'zoom-out')
      map.zoomTo(Math.max(map.getZoom() - 1, 0.5), { duration: duration, animate: !reduced });
    else if (action === 'reset') {
      var camera = {
        center: cfg.initialCenter || [-20, 25],
        zoom: Number(cfg.initialZoom || 1.45),
        bearing: 0,
        pitch: 0,
      };
      if (reduced) map.jumpTo(camera);
      else map.easeTo(Object.assign(camera, { duration: 500 }));
    }
  }

  /* ------------------------------------------------------------ events */

  actions.addEventListener('click', function (event) {
    var button = event.target.closest('[data-map-action]');
    if (button) move(button.dataset.mapAction);
  });
  stage.addEventListener('keydown', function (event) {
    if (
      event.key === 'Escape' &&
      active &&
      !event.defaultPrevented &&
      mapElement.contains(document.activeElement)
    ) {
      event.preventDefault();
      releaseMapFocus();
    }
  });
  focusCoordinatesButton.addEventListener('click', function () {
    if (!map || !active) return;
    var coordinates = readCoordinates();
    if (!coordinates) return;
    moveToCoordinates(coordinates);
    setStatus(
      'Focused the coordinates. The form value stays in this page; visible tile requests follow the camera.',
      'ready',
    );
  });
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!map || !active) return;
    var coordinates = readCoordinates();
    if (!coordinates) return;
    var marker = alcorMapNormalizeMarker(titleInput.value, coordinates.lat, coordinates.lng);
    if (!marker) {
      titleInput.setAttribute('aria-invalid', 'true');
      setStatus('Add a plain-text marker label of 80 characters or fewer.', 'error');
      return;
    }
    titleInput.removeAttribute('aria-invalid');
    if (addMarker(marker)) titleInput.value = '';
  });
  form.addEventListener('input', function (event) {
    if (event.target && typeof event.target.removeAttribute === 'function')
      event.target.removeAttribute('aria-invalid');
  });
  markerList.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-marker-action]');
    if (!button) return;
    var item = button.closest('[data-marker-id]');
    if (!item) return;
    var markerId = Number(item.dataset.markerId);
    if (button.dataset.markerAction === 'focus') focusMarker(markerId);
    else if (button.dataset.markerAction === 'edit') openEditor(markerId, true);
    else if (button.dataset.markerAction === 'remove') removeMarker(markerId);
  });
  sheetToggle.addEventListener('click', function () {
    setSheet(markerPanel.dataset.sheet !== 'expanded');
  });
  markerPanel.addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('[data-tool]') : null;
    if (!button || button.disabled || !active) return;
    var tool = button.dataset.tool;
    if (tool === 'fit') fitMarkers();
    else if (tool === 'share') shareMap();
    else if (tool === 'copy') copyShareLink();
    else if (tool === 'geojson' || tool === 'csv') exportText(tool);
    else if (tool === 'png') exportPng();
    else if (tool === 'clear') clearMap(false);
    else if (tool === 'clear-yes') clearMap(true);
    else if (tool === 'clear-no') {
      clearConfirm.hidden = true;
      setStatus('Kept your markers.', 'ready');
    } else if (tool === 'restore') restorePrevious();
  });
  editor.addEventListener('submit', function (event) {
    event.preventDefault();
    saveEditor();
  });
  editor.addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('[data-editor]') : null;
    if (!button) return;
    if (button.dataset.editor === 'cancel') {
      closeEditor();
      setStatus('Edit cancelled.', 'ready');
    } else if (button.dataset.editor === 'delete' && editingId !== null) removeMarker(editingId);
  });
  editor.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeEditor();
    }
  });
  importInput.addEventListener('change', function () {
    var file = importInput.files && importInput.files[0];
    importFile(file);
    importInput.value = '';
  });
  placeAdd.addEventListener('click', addPendingPlace);
  placeClose.addEventListener('click', hidePlace);
  searchForm.addEventListener('submit', function (event) {
    event.preventDefault();
    if (suggestionItems.length) chooseSuggestion(activeSuggestion >= 0 ? activeSuggestion : 0);
  });
  searchInput.addEventListener('focus', function () {
    loadPlaces().catch(function () {
      /* Reported on input. */
    });
  });
  searchInput.addEventListener('input', updateSearch);
  searchInput.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!suggestionItems.length) return;
      event.preventDefault();
      var step = event.key === 'ArrowDown' ? 1 : -1;
      highlightSuggestion(
        (activeSuggestion + step + suggestionItems.length) % suggestionItems.length,
      );
    } else if (event.key === 'Escape' && !suggestions.hidden) {
      event.preventDefault();
      closeSuggestions();
    }
  });
  searchInput.addEventListener('blur', function () {
    window.setTimeout(function () {
      if (document.activeElement !== searchInput) closeSuggestions();
    }, 150);
  });
  suggestions.addEventListener('mousedown', function (event) {
    event.preventDefault();
  });
  suggestions.addEventListener('click', function (event) {
    var option = event.target.closest ? event.target.closest('[data-index]') : null;
    if (option) chooseSuggestion(Number(option.dataset.index));
  });
  window.addEventListener('hashchange', function () {
    var shared = readSharedHash();
    if (!shared || !shared.markers.length) return;
    openShared(shared);
    if (map) {
      attachAllMarkers();
      fitMarkers();
    }
    renderMarkerList();
    setStatus(
      'Opened a shared map with ' + plural(markers.length, 'marker') + '.',
      active ? 'ready' : stage.dataset.state,
    );
  });
  window.addEventListener('pagehide', function () {
    if (saveTimer) saveNow();
  });

  makeUndoButton();
  boot();
  start();
})();
