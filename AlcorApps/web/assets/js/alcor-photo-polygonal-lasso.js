/**
 * alcor-photo-polygonal-lasso.js: AlcorPhoto polygonal lasso.
 *
 * Point-by-point polygon selection tool.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.AlcorPhotoPolygonalLasso = api;
    api.install(root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_CLOSE_RADIUS = 12;
  const MIN_VERTEX_DISTANCE = 4;
  const number = (value, fallback = 0) =>
    Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (value, min, max, fallback = min) =>
    Math.min(max, Math.max(min, number(value, fallback)));

  function appendVertex(points, point, maxPoints = 64, minDistance = MIN_VERTEX_DISTANCE) {
    const existing = Array.isArray(points)
      ? points
          .filter(
            (candidate) =>
              candidate &&
              Number.isFinite(Number(candidate.x)) &&
              Number.isFinite(Number(candidate.y)),
          )
          .map((candidate) => Object.freeze({ x: Number(candidate.x), y: Number(candidate.y) }))
      : [];
    if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) {
      throw new Error('Choose a valid point on the canvas.');
    }
    const maximum = Math.max(3, Math.floor(number(maxPoints, 64)));
    if (existing.length >= maximum) {
      throw new Error(
        `Polygonal Lasso supports up to ${maximum} vertices. Finish or cancel this selection.`,
      );
    }
    const next = Object.freeze({ x: Number(point.x), y: Number(point.y) });
    const previous = existing[existing.length - 1];
    if (
      previous &&
      Math.hypot(next.x - previous.x, next.y - previous.y) <
        Math.max(0, number(minDistance, MIN_VERTEX_DISTANCE))
    ) {
      return Object.freeze(existing);
    }
    return Object.freeze([...existing, next]);
  }

  function applyPolygonalSelection(Core, project, layerId, points, operation = 'new', feather = 0) {
    if (
      !Core ||
      typeof Core.layerMaskFromProjectPolygon !== 'function' ||
      typeof Core.setLayerMask !== 'function' ||
      typeof Core.composeLayerMask !== 'function'
    ) {
      throw new Error('AlcorPhoto polygon mask composition is required.');
    }
    const layer = project?.layers?.find(
      (candidate) => candidate.id === layerId && candidate.type === 'image',
    );
    if (!layer) throw new Error('Select an image layer before creating a Polygonal Lasso mask.');
    const baseMask = Core.layerMaskFromProjectPolygon(layer, points);
    const boundedFeather = clamp(feather, 0, 128, 0);
    const mask = { ...baseMask, feather: boundedFeather };
    const combine = ['add', 'subtract', 'intersect'].includes(operation) ? operation : 'new';
    if (combine === 'new' || !layer.mask) return Core.setLayerMask(project, layerId, mask);
    return Core.composeLayerMask(project, layerId, mask, combine);
  }

  function controller(root, Core, MaskApi) {
    const document = root.document;
    const editor = document?.querySelector?.('[data-alcor-photo-editor]');
    const canvas = editor?.querySelector?.('#ap-canvas');
    const toolbar = editor?.querySelector?.('.ap-mask-tools');
    const viewport = editor?.querySelector?.('.ap-canvas-viewport');
    if (!editor || !canvas || !toolbar || !viewport) return { attachStore() {} };

    const maxPoints = Math.max(3, Math.floor(Number(MaskApi?.MAX_POLYGON_POINTS) || 64));
    const toolButton = document.createElement('button');
    toolButton.type = 'button';
    toolButton.dataset.apMask = 'polygonal';
    toolButton.setAttribute('aria-pressed', 'false');
    toolButton.textContent = 'Polygonal select';

    const controls = document.createElement('span');
    controls.className = 'ap-mask-polygonal-controls';
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', 'Polygonal Lasso actions');
    controls.hidden = true;
    controls.innerHTML =
      '<button type="button" data-ap-polygon-finish disabled>Finish</button><button type="button" data-ap-polygon-remove disabled>Undo point</button><button type="button" data-ap-polygon-cancel>Cancel</button><span data-ap-polygon-state aria-live="polite">0 vertices</span>';

    const compose = toolbar.querySelector('.ap-mask-compose');
    toolbar.insertBefore(toolButton, compose || null);
    toolbar.insertBefore(controls, compose || null);

    const svgNamespace = 'http://www.w3.org/2000/svg';
    const overlay = document.createElementNS(svgNamespace, 'svg');
    overlay.classList.add('ap-mask-polygonal-overlay');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.setAttribute('hidden', '');
    const fillPath = document.createElementNS(svgNamespace, 'path');
    fillPath.classList.add('ap-mask-polygonal-fill');
    const guidePath = document.createElementNS(svgNamespace, 'path');
    guidePath.classList.add('ap-mask-polygonal-guide');
    const vertices = document.createElementNS(svgNamespace, 'g');
    vertices.classList.add('ap-mask-polygonal-vertices');
    overlay.append(fillPath, guidePath, vertices);
    viewport.append(overlay);

    const finishButton = controls.querySelector('[data-ap-polygon-finish]');
    const removeButton = controls.querySelector('[data-ap-polygon-remove]');
    const cancelButton = controls.querySelector('[data-ap-polygon-cancel]');
    const state = controls.querySelector('[data-ap-polygon-state]');
    const status = editor.querySelector('#ap-status');
    const featherInput = toolbar.querySelector('[data-ap-mask-feather]');
    const otherSelectionButtons = [...toolbar.querySelectorAll('[data-ap-mask]')].filter(
      (button) => button !== toolButton,
    );
    let store = null;
    let active = false;
    let draft = null;
    let hoverClientPoint = null;

    function message(text, level = 'ok') {
      if (!status) return;
      status.textContent = String(text || '').slice(0, 220);
      status.dataset.level = level;
    }

    function selectedImage() {
      return (
        store?.project?.layers?.find(
          (layer) => layer.id === store.project.selectedLayerId && layer.type === 'image',
        ) || null
      );
    }

    function currentOperation() {
      const pressed = toolbar.querySelector('[data-ap-mask-combine][aria-pressed="true"]');
      const operation = pressed?.dataset?.apMaskCombine || 'new';
      return ['new', 'add', 'subtract', 'intersect'].includes(operation) ? operation : 'new';
    }

    function relativePoint(clientPoint, bounds) {
      return { x: clientPoint.x - bounds.left, y: clientPoint.y - bounds.top };
    }

    function pathData(points, close = false) {
      if (!points.length) return '';
      const commands = points.map(
        (point, index) => `${index ? 'L' : 'M'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`,
      );
      if (close) commands.push('Z');
      return commands.join(' ');
    }

    function renderOverlay() {
      if (!active || !draft?.clientPoints?.length) {
        overlay.toggleAttribute('hidden', true);
        fillPath.setAttribute('d', '');
        guidePath.setAttribute('d', '');
        vertices.replaceChildren();
        return;
      }
      const bounds = viewport.getBoundingClientRect();
      overlay.toggleAttribute('hidden', false);
      overlay.setAttribute(
        'viewBox',
        `0 0 ${Math.max(1, bounds.width)} ${Math.max(1, bounds.height)}`,
      );
      const points = draft.clientPoints.map((point) => relativePoint(point, bounds));
      fillPath.setAttribute('d', points.length >= 3 ? pathData(points, true) : '');
      const guidePoints = hoverClientPoint
        ? [...points, relativePoint(hoverClientPoint, bounds)]
        : points;
      guidePath.setAttribute('d', pathData(guidePoints, false));
      vertices.replaceChildren(
        ...points.map((point, index) => {
          const circle = document.createElementNS(svgNamespace, 'circle');
          circle.setAttribute('cx', String(point.x));
          circle.setAttribute('cy', String(point.y));
          circle.setAttribute('r', index === 0 ? '5' : '3.5');
          if (index === 0) circle.dataset.first = 'true';
          return circle;
        }),
      );
    }

    function renderState() {
      const layer = selectedImage();
      if (active && draft?.layerId && layer?.id !== draft.layerId) {
        active = false;
        draft = null;
        hoverClientPoint = null;
        message('Polygonal selection cancelled because the selected image layer changed.', 'error');
      }
      toolButton.disabled = !layer;
      toolButton.setAttribute('aria-pressed', String(active));
      controls.hidden = !active;
      const count = draft?.projectPoints?.length || 0;
      finishButton.disabled = !active || count < 3;
      removeButton.disabled = !active || count < 1;
      state.textContent = `${count} / ${maxPoints} vertices${count >= 3 ? ' · Enter or Finish closes' : ''}`;
      canvas.dataset.maskPolygonal = active ? 'true' : '';
      renderOverlay();
    }

    function clearDraft() {
      active = false;
      draft = null;
      hoverClientPoint = null;
      renderState();
    }

    function cancelSelection(announce = true) {
      if (!active) return;
      clearDraft();
      if (announce) message('Polygonal Lasso cancelled.');
    }

    function deactivateOtherTools() {
      const selectedTool = toolbar.querySelector('[data-ap-mask][aria-pressed="true"]');
      if (selectedTool && selectedTool !== toolButton) selectedTool.click();
      const brushTool = toolbar.querySelector('[data-ap-mask-brush][aria-pressed="true"]');
      if (brushTool) brushTool.click();
    }

    function beginSelection() {
      const layer = selectedImage();
      if (!layer) return message('Select an image layer before using Polygonal Lasso.', 'error');
      deactivateOtherTools();
      active = true;
      draft = { layerId: layer.id, clientPoints: [], projectPoints: [] };
      hoverClientPoint = null;
      if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = 0;
      renderState();
      message(
        `Polygonal Lasso active. Click up to ${maxPoints} vertices; click the first point, press Enter, or choose Finish to close. Backspace removes the last point; Escape cancels.`,
      );
    }

    function projectPoint(event) {
      // The editor viewport zooms and pans; use its mapping when present.
      const editorView = root.AlcorPhotoEditor?.view;
      if (editorView) return editorView.clientToProject(event.clientX, event.clientY);
      const rect = canvas.getBoundingClientRect();
      const crop = store.project.crop;
      return {
        x: crop.x + ((event.clientX - rect.left) * crop.width) / rect.width,
        y: crop.y + ((event.clientY - rect.top) * crop.height) / rect.height,
      };
    }

    function isNearFirst(clientPoint) {
      const first = draft?.clientPoints?.[0];
      return Boolean(
        first &&
          draft.clientPoints.length >= 3 &&
          Math.hypot(clientPoint.x - first.x, clientPoint.y - first.y) <= DEFAULT_CLOSE_RADIUS,
      );
    }

    function addVertex(event) {
      if (!active || !draft) return;
      const clientPoint = { x: event.clientX, y: event.clientY };
      if (isNearFirst(clientPoint)) return finishSelection();
      try {
        const nextClient = appendVertex(
          draft.clientPoints,
          clientPoint,
          maxPoints,
          MIN_VERTEX_DISTANCE,
        );
        if (nextClient.length === draft.clientPoints.length) {
          return message(
            'Choose a point farther from the previous Polygonal Lasso vertex.',
            'error',
          );
        }
        const nextProject = appendVertex(draft.projectPoints, projectPoint(event), maxPoints, 0.01);
        if (nextProject.length === draft.projectPoints.length) {
          return message(
            'Choose a point farther from the previous Polygonal Lasso vertex.',
            'error',
          );
        }
        draft.clientPoints = [...nextClient];
        draft.projectPoints = [...nextProject];
        hoverClientPoint = null;
        renderState();
        if (draft.projectPoints.length === maxPoints) {
          message(
            `Polygonal Lasso reached its ${maxPoints}-vertex limit. Choose Finish, press Enter, or cancel.`,
          );
        } else if (draft.projectPoints.length >= 3) {
          message(
            `${draft.projectPoints.length} vertices set. Click the first point, press Enter, or choose Finish to apply.`,
          );
        } else {
          message(
            `${draft.projectPoints.length} vertices set. Add at least ${3 - draft.projectPoints.length} more.`,
          );
        }
      } catch (error) {
        message(error.message, 'error');
      }
    }

    function removeLastVertex() {
      if (!active || !draft?.projectPoints?.length) return;
      draft.clientPoints.pop();
      draft.projectPoints.pop();
      hoverClientPoint = null;
      renderState();
      message(`Last Polygonal Lasso vertex removed. ${draft.projectPoints.length} remain.`);
    }

    function finishSelection() {
      if (!active || !draft) return;
      if (draft.projectPoints.length < 3)
        return message('Add at least three Polygonal Lasso vertices before finishing.', 'error');
      const layer = store?.project?.layers?.find(
        (candidate) => candidate.id === draft.layerId && candidate.type === 'image',
      );
      if (!layer || selectedImage()?.id !== draft.layerId) {
        cancelSelection(false);
        return message(
          'The selected image layer changed before the Polygonal Lasso was applied.',
          'error',
        );
      }
      const operation = currentOperation();
      const feather = clamp(featherInput?.value, 0, 128, 0);
      try {
        const next = applyPolygonalSelection(
          Core,
          store.project,
          layer.id,
          draft.projectPoints,
          operation,
          feather,
        );
        const changed = store.replace(
          next,
          operation === 'new'
            ? 'Applied Polygonal Lasso mask'
            : `${operation} Polygonal Lasso selection`,
        );
        if (!changed) throw new Error('Polygonal Lasso did not change the current mask.');
        const vertexCount = draft.projectPoints.length;
        clearDraft();
        const operationLabel = operation === 'new' ? 'applied' : `${operation} selection applied`;
        message(
          `Polygonal Lasso ${operationLabel} with ${vertexCount} vertices and ${Math.round(feather)} px feather. Undo restores the prior mask.`,
        );
      } catch (error) {
        renderState();
        message(error.message, 'error');
      }
    }

    toolButton.addEventListener('click', () => {
      if (active) cancelSelection();
      else beginSelection();
    });
    finishButton.addEventListener('click', finishSelection);
    removeButton.addEventListener('click', removeLastVertex);
    cancelButton.addEventListener('click', () => cancelSelection());

    otherSelectionButtons.forEach((button) =>
      button.addEventListener('click', () => {
        if (active) cancelSelection(false);
      }),
    );
    [...toolbar.querySelectorAll('[data-ap-mask-combine]')].forEach((button) =>
      button.addEventListener('click', () => {
        if (active) {
          const label =
            currentOperation() === 'new'
              ? 'New'
              : currentOperation()[0].toUpperCase() + currentOperation().slice(1);
          message(
            `${label} selection mode active. Continue the Polygonal Lasso or finish/cancel it before switching tools.`,
          );
        }
      }),
    );

    canvas.addEventListener(
      'pointerdown',
      (event) => {
        if (!active || !store || !event.isPrimary || event.button !== 0) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        addVertex(event);
        canvas.focus?.({ preventScroll: true });
      },
      true,
    );

    canvas.addEventListener(
      'pointermove',
      (event) => {
        if (!active || !draft?.clientPoints?.length) return;
        hoverClientPoint = { x: event.clientX, y: event.clientY };
        renderOverlay();
      },
      true,
    );

    canvas.addEventListener(
      'pointerleave',
      () => {
        if (!active) return;
        hoverClientPoint = null;
        renderOverlay();
      },
      true,
    );

    canvas.addEventListener(
      'click',
      (event) => {
        if (!active) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      true,
    );

    document.addEventListener('keydown', (event) => {
      if (!active || event.repeat) return;
      const interactive = event.target?.matches?.('input, select, textarea, button, a');
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelSelection();
      } else if ((event.key === 'Backspace' || event.key === 'Delete') && !interactive) {
        event.preventDefault();
        removeLastVertex();
      } else if (event.key === 'Enter' && !interactive) {
        event.preventDefault();
        finishSelection();
      }
    });

    // The editor snapshots every control's disabled state while an operation (such as an
    // image import) runs and restores that snapshot afterwards, overwriting the render the
    // change event just made. Re-render once the busy flag clears.
    if (root.MutationObserver) {
      new root.MutationObserver(() => {
        if (!editor.hasAttribute('aria-busy')) renderState();
      }).observe(editor, { attributes: true, attributeFilter: ['aria-busy'] });
    }

    return {
      attachStore(value) {
        store = value;
        if (store?.on) store.on('change', renderState);
        renderState();
      },
    };
  }

  function install(root = globalThis) {
    if (!root || root.__alcorPhotoPolygonalLassoInstalled) return false;
    if (
      !root.AlcorPhotoMask ||
      !root.AlcorPhotoCore ||
      !root.AlcorApp ||
      !root.document?.querySelector?.('[data-alcor-photo-editor]')
    )
      return false;
    const ui = controller(root, root.AlcorPhotoCore, root.AlcorPhotoMask);
    const baseApp = root.AlcorApp;
    const App = Object.create(baseApp);
    Object.defineProperty(App, 'createProjectStore', {
      value(options) {
        const store = baseApp.createProjectStore(options);
        ui.attachStore(store);
        return store;
      },
    });
    root.AlcorApp = App;
    root.__alcorPhotoPolygonalLassoInstalled = true;
    return true;
  }

  return Object.freeze({
    DEFAULT_CLOSE_RADIUS,
    MIN_VERTEX_DISTANCE,
    appendVertex,
    applyPolygonalSelection,
    install,
  });
});
