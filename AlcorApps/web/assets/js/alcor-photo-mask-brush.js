/**
 * alcor-photo-mask-brush.js: AlcorPhoto mask brush.
 *
 * Brush tool for painting layer masks.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.AlcorPhotoMaskBrush = api;
    api.install(root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_BRUSH_SIZE = 128;
  const DEFAULT_BRUSH_SIZE = 32;
  const MAX_CENTERLINE_POINTS = 24;
  const MAX_INPUT_POINTS = 256;
  const CAP_STEPS = 5;
  const MIN_POINT_SPACING = 2;

  const number = (value, fallback = 0) =>
    Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (value, min, max, fallback = min) =>
    Math.min(max, Math.max(min, number(value, fallback)));

  function cleanPoints(points) {
    if (!Array.isArray(points)) return [];
    const cleaned = [];
    for (const raw of points.slice(0, MAX_INPUT_POINTS)) {
      if (!raw || !Number.isFinite(Number(raw.x)) || !Number.isFinite(Number(raw.y))) continue;
      const point = { x: Number(raw.x), y: Number(raw.y) };
      const previous = cleaned[cleaned.length - 1];
      if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 0.5) continue;
      cleaned.push(point);
    }
    return cleaned;
  }

  function resampleCenterline(points, maxPoints = MAX_CENTERLINE_POINTS) {
    const cleaned = cleanPoints(points);
    if (cleaned.length <= maxPoints) return cleaned;
    const cumulative = [0];
    for (let index = 1; index < cleaned.length; index += 1) {
      cumulative[index] =
        cumulative[index - 1] +
        Math.hypot(
          cleaned[index].x - cleaned[index - 1].x,
          cleaned[index].y - cleaned[index - 1].y,
        );
    }
    const total = cumulative[cumulative.length - 1];
    if (total < 0.5) return [cleaned[0]];
    const sampled = [];
    let segment = 1;
    for (let index = 0; index < maxPoints; index += 1) {
      const target = (total * index) / (maxPoints - 1);
      while (segment < cumulative.length - 1 && cumulative[segment] < target) segment += 1;
      const previousIndex = Math.max(0, segment - 1);
      const startDistance = cumulative[previousIndex];
      const endDistance = cumulative[segment];
      const ratio =
        endDistance > startDistance ? (target - startDistance) / (endDistance - startDistance) : 0;
      const a = cleaned[previousIndex];
      const b = cleaned[segment];
      sampled.push({
        x: a.x + (b.x - a.x) * ratio,
        y: a.y + (b.y - a.y) * ratio,
      });
    }
    return sampled;
  }

  function circlePolygon(point, radius, segments = 16) {
    return Array.from({ length: segments }, (_, index) => {
      const angle = (index / segments) * Math.PI * 2;
      return { x: point.x + Math.cos(angle) * radius, y: point.y + Math.sin(angle) * radius };
    });
  }

  function tangentAngle(points, index) {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    let dx = next.x - previous.x;
    let dy = next.y - previous.y;
    if (Math.hypot(dx, dy) < 0.001 && index > 0) {
      dx = points[index].x - points[index - 1].x;
      dy = points[index].y - points[index - 1].y;
    }
    return Math.atan2(dy, dx);
  }

  function strokePolygon(points, brushSize = DEFAULT_BRUSH_SIZE) {
    const size = clamp(brushSize, 2, MAX_BRUSH_SIZE, DEFAULT_BRUSH_SIZE);
    const radius = size / 2;
    const centerline = resampleCenterline(points);
    if (!centerline.length) throw new Error('Paint a mask stroke before applying it.');
    if (centerline.length === 1) return circlePolygon(centerline[0], radius);

    const totalLength = centerline.slice(1).reduce((sum, point, index) => {
      const previous = centerline[index];
      return sum + Math.hypot(point.x - previous.x, point.y - previous.y);
    }, 0);
    if (totalLength < 1) return circlePolygon(centerline[0], radius);

    const left = [];
    const right = [];
    for (let index = 0; index < centerline.length; index += 1) {
      const angle = tangentAngle(centerline, index);
      const nx = -Math.sin(angle);
      const ny = Math.cos(angle);
      left.push({ x: centerline[index].x + nx * radius, y: centerline[index].y + ny * radius });
      right.push({ x: centerline[index].x - nx * radius, y: centerline[index].y - ny * radius });
    }

    const polygon = [...left];
    const end = centerline[centerline.length - 1];
    const endAngle = tangentAngle(centerline, centerline.length - 1);
    for (let step = 1; step <= CAP_STEPS; step += 1) {
      const angle = endAngle + Math.PI / 2 - (Math.PI * step) / (CAP_STEPS + 1);
      polygon.push({ x: end.x + Math.cos(angle) * radius, y: end.y + Math.sin(angle) * radius });
    }
    polygon.push(...right.slice().reverse());
    const start = centerline[0];
    const startAngle = tangentAngle(centerline, 0);
    for (let step = 1; step <= CAP_STEPS; step += 1) {
      const angle = startAngle - Math.PI / 2 - (Math.PI * step) / (CAP_STEPS + 1);
      polygon.push({
        x: start.x + Math.cos(angle) * radius,
        y: start.y + Math.sin(angle) * radius,
      });
    }
    return polygon;
  }

  function componentCount(mask) {
    if (!mask) return 0;
    return mask.shape === 'composite' ? Math.max(0, mask.components?.length || 0) : 1;
  }

  function remainingStrokeBudget(mask, MaskApi) {
    const max = Number(MaskApi?.MAX_COMPOSITE_COMPONENTS) || 16;
    return Math.max(0, max - componentCount(mask));
  }

  function applyBrushStroke(
    Core,
    project,
    layerId,
    points,
    mode = 'add',
    brushSize = DEFAULT_BRUSH_SIZE,
  ) {
    if (
      !Core ||
      typeof Core.layerMaskFromProjectPolygon !== 'function' ||
      typeof Core.composeLayerMask !== 'function'
    ) {
      throw new Error('AlcorPhoto mask composition is required for paint refinement.');
    }
    const layer = project?.layers?.find(
      (candidate) => candidate.id === layerId && candidate.type === 'image',
    );
    if (!layer?.mask) throw new Error('Create a mask before painting refinements.');
    const polygon = strokePolygon(points, brushSize);
    const strokeMask = Core.layerMaskFromProjectPolygon(layer, polygon);
    return Core.composeLayerMask(
      project,
      layerId,
      strokeMask,
      mode === 'erase' ? 'subtract' : 'add',
    );
  }

  function controller(root, Core, MaskApi) {
    const document = root.document;
    const editor = document?.querySelector?.('[data-alcor-photo-editor]');
    const canvas = editor?.querySelector?.('#ap-canvas');
    const toolbar = editor?.querySelector?.('.ap-mask-tools');
    if (!editor || !canvas || !toolbar) return { attachStore() {} };

    const controls = document.createElement('span');
    controls.className = 'ap-mask-brush';
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', 'Paint mask refinement');
    controls.innerHTML =
      '<button type="button" data-ap-mask-brush="add" aria-pressed="false">Brush Add</button><button type="button" data-ap-mask-brush="erase" aria-pressed="false">Brush Erase</button><label>Size <input type="range" min="2" max="128" step="2" value="32" data-ap-mask-brush-size disabled><output data-ap-mask-brush-size-value>32 px</output></label><span data-ap-mask-brush-state>Create a mask first</span>';
    const feather = toolbar.querySelector('.ap-mask-feather');
    toolbar.insertBefore(controls, feather || null);

    const buttons = [...controls.querySelectorAll('[data-ap-mask-brush]')];
    const sizeInput = controls.querySelector('[data-ap-mask-brush-size]');
    const sizeValue = controls.querySelector('[data-ap-mask-brush-size-value]');
    const state = controls.querySelector('[data-ap-mask-brush-state]');
    const status = editor.querySelector('#ap-status');
    const selectionButtons = [...toolbar.querySelectorAll('[data-ap-mask]')];
    let store = null;
    let mode = null;
    let drag = null;
    let brushSize = DEFAULT_BRUSH_SIZE;

    function message(text, level = 'ok') {
      if (!status) return;
      status.textContent = String(text || '').slice(0, 180);
      status.dataset.level = level;
    }

    function selectedImage() {
      return (
        store?.project?.layers?.find(
          (layer) => layer.id === store.project.selectedLayerId && layer.type === 'image',
        ) || null
      );
    }

    function setMode(nextMode, announce = true) {
      mode = nextMode === 'erase' ? 'erase' : nextMode === 'add' ? 'add' : null;
      drag = null;
      canvas.dataset.maskBrush = mode || '';
      renderState();
      if (announce && mode)
        message(
          `${mode === 'add' ? 'Brush Add' : 'Brush Erase'} active. Paint on the canvas; each completed stroke is one Undo step.`,
        );
    }

    function renderState() {
      const layer = selectedImage();
      const remaining = layer?.mask ? remainingStrokeBudget(layer.mask, MaskApi) : 0;
      if ((!layer?.mask || remaining <= 0) && mode) {
        mode = null;
        drag = null;
        canvas.dataset.maskBrush = '';
      }
      buttons.forEach((button) => {
        button.disabled = !layer?.mask || remaining <= 0;
        button.setAttribute('aria-pressed', String(mode === button.dataset.apMaskBrush));
      });
      sizeInput.disabled = !layer?.mask || remaining <= 0;
      sizeInput.value = String(Math.round(brushSize));
      sizeValue.value = `${Math.round(brushSize)} px`;
      sizeValue.textContent = sizeValue.value;
      if (!layer) state.textContent = 'Select an image layer';
      else if (!layer.mask) state.textContent = 'Create a mask first';
      else if (!remaining) state.textContent = 'Composition limit reached';
      else state.textContent = `${remaining} stroke${remaining === 1 ? '' : 's'} left`;
    }

    function deactivateSelectionTool() {
      const active = toolbar.querySelector('[data-ap-mask][aria-pressed="true"]');
      if (active) active.click();
    }

    buttons.forEach((button) =>
      button.addEventListener('click', () => {
        const layer = selectedImage();
        if (!layer?.mask) return message('Create a mask before painting refinements.', 'error');
        if (remainingStrokeBudget(layer.mask, MaskApi) <= 0)
          return message(
            'Selection composition limit reached. Start a new mask to paint more refinements.',
            'error',
          );
        deactivateSelectionTool();
        setMode(mode === button.dataset.apMaskBrush ? null : button.dataset.apMaskBrush);
      }),
    );

    selectionButtons.forEach((button) =>
      button.addEventListener('click', () => {
        if (button.getAttribute('aria-pressed') === 'true' && mode) setMode(null, false);
      }),
    );

    sizeInput.addEventListener('input', () => {
      brushSize = clamp(sizeInput.value, 2, MAX_BRUSH_SIZE, DEFAULT_BRUSH_SIZE);
      sizeValue.value = `${Math.round(brushSize)} px`;
      sizeValue.textContent = sizeValue.value;
    });

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

    function appendPoint(event) {
      if (!drag) return;
      const lastClient = drag.clientPoints[drag.clientPoints.length - 1];
      if (
        lastClient &&
        Math.hypot(event.clientX - lastClient.x, event.clientY - lastClient.y) < MIN_POINT_SPACING
      )
        return;
      const clientPoint = { x: event.clientX, y: event.clientY };
      const project = projectPoint(event);
      if (drag.clientPoints.length < MAX_INPUT_POINTS) {
        drag.clientPoints.push(clientPoint);
        drag.projectPoints.push(project);
      } else {
        drag.clientPoints[drag.clientPoints.length - 1] = clientPoint;
        drag.projectPoints[drag.projectPoints.length - 1] = project;
      }
    }

    canvas.addEventListener(
      'pointerdown',
      (event) => {
        if (!mode || !store || !event.isPrimary || event.button !== 0) return;
        const layer = selectedImage();
        if (!layer?.mask) {
          setMode(null, false);
          return message('Create a mask before painting refinements.', 'error');
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        const project = projectPoint(event);
        drag = {
          pointerId: event.pointerId,
          layerId: layer.id,
          mode,
          projectPoints: [project],
          clientPoints: [{ x: event.clientX, y: event.clientY }],
        };
        canvas.setPointerCapture?.(event.pointerId);
      },
      true,
    );

    canvas.addEventListener(
      'pointermove',
      (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        appendPoint(event);
      },
      true,
    );

    canvas.addEventListener(
      'pointerup',
      (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        appendPoint(event);
        const current = drag;
        drag = null;
        const layer = store.project.layers.find(
          (candidate) => candidate.id === current.layerId && candidate.type === 'image',
        );
        if (!layer?.mask)
          return message(
            'The selected image mask changed before the brush stroke was applied.',
            'error',
          );
        try {
          const next = applyBrushStroke(
            Core,
            store.project,
            layer.id,
            current.projectPoints,
            current.mode,
            brushSize,
          );
          store.replace(
            next,
            `${current.mode === 'erase' ? 'Erased from' : 'Added to'} layer mask with brush`,
          );
          const remaining = remainingStrokeBudget(selectedImage()?.mask, MaskApi);
          renderState();
          message(
            `${current.mode === 'erase' ? 'Erase' : 'Add'} brush stroke applied non-destructively at ${Math.round(brushSize)} px. ${remaining} stroke${remaining === 1 ? '' : 's'} remain in the bounded composition budget.`,
          );
        } catch (error) {
          renderState();
          message(error.message, 'error');
        }
      },
      true,
    );

    canvas.addEventListener(
      'pointercancel',
      (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        event.stopImmediatePropagation();
        drag = null;
      },
      true,
    );

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && mode) {
        setMode(null, false);
        message('Mask brush cancelled.');
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
    if (!root || root.__alcorPhotoMaskBrushInstalled) return false;
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
    root.__alcorPhotoMaskBrushInstalled = true;
    return true;
  }

  return Object.freeze({
    MAX_BRUSH_SIZE,
    DEFAULT_BRUSH_SIZE,
    MAX_CENTERLINE_POINTS,
    strokePolygon,
    componentCount,
    remainingStrokeBudget,
    applyBrushStroke,
    install,
  });
});
