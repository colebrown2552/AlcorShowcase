/**
 * alcor-photo.js: AlcorPhoto editor.
 *
 * The main editor: wires the document model (alcor-photo-core.js), SVG rendering
 * and the AlcorApps shell into the page, and handles open, save and export.
 */
(() => {
  'use strict';

  const Core = globalThis.AlcorPhotoCore;
  const Svg = globalThis.AlcorPhotoSvg;
  const App = globalThis.AlcorApp;
  const root = document.querySelector('[data-alcor-photo-editor]');
  if (!Core || !Svg || !App || !root) return;

  const elements = {
    name: root.querySelector('#ap-project-name'),
    save: root.querySelector('#ap-save-state'),
    status: root.querySelector('#ap-status'),
    stats: root.querySelector('#ap-stats'),
    zoom: root.querySelector('#ap-zoom'),
    layers: root.querySelector('#ap-layer-list'),
    canvas: root.querySelector('#ap-canvas'),
    importFile: root.querySelector('#ap-image-file'),
    relinkFile: root.querySelector('#ap-relink-file'),
    projectFile: root.querySelector('#ap-project-file'),
    layerForm: root.querySelector('#ap-layer-form'),
    textForm: root.querySelector('#ap-text-form'),
    cropForm: root.querySelector('#ap-crop-form'),
    backgroundForm: root.querySelector('#ap-background-form'),
    resizeForm: root.querySelector('#ap-resize-form'),
    adjustments: root.querySelector('#ap-adjustments'),
    exportFormat: root.querySelector('#ap-export-format'),
    exportQuality: root.querySelector('#ap-export-quality'),
    exportScale: root.querySelector('#ap-export-scale'),
    exportWidth: root.querySelector('#ap-export-width'),
    exportReport: root.querySelector('#ap-export-report'),
    layerShortcuts: root.querySelector('#ap-layer-shortcuts'),
  };
  const ADJUSTMENT_NAMES = Object.freeze([
    'brightness',
    'contrast',
    'saturation',
    'hue',
    'blur',
    'grayscale',
  ]);
  if (elements.exportFormat && !elements.exportFormat.querySelector('option[value="svg"]')) {
    const option = document.createElement('option');
    option.value = 'svg';
    option.textContent = 'SVG · optimized';
    elements.exportFormat.append(option);
  }
  // AVIF only where this browser can actually encode it.
  if (elements.exportFormat?.querySelector('option[value="avif"]')) {
    try {
      const probe = document.createElement('canvas');
      probe.width = probe.height = 1;
      probe.toBlob(
        (blob) => {
          if (!blob || blob.type !== 'image/avif')
            elements.exportFormat.querySelector('option[value="avif"]')?.remove();
        },
        'image/avif',
        0.5,
      );
    } catch {
      elements.exportFormat.querySelector('option[value="avif"]')?.remove();
    }
  }
  if (!elements.exportReport) {
    elements.exportReport = document.createElement('span');
    elements.exportReport.id = 'ap-export-report';
    elements.exportReport.className = 'ap-export-report';
    elements.exportReport.textContent = 'No export yet';
    root.querySelector('.aa-statusbar')?.append(elements.exportReport);
  }
  for (const label of root.querySelectorAll('.aa-file-button')) {
    label.tabIndex = 0;
    label.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      label.querySelector('input[type="file"]')?.click();
    });
  }
  elements.status.setAttribute('role', 'status');
  elements.status.setAttribute('aria-live', 'polite');
  elements.save.setAttribute('role', 'status');
  elements.save.setAttribute('aria-live', 'polite');
  elements.save.textContent = 'In-memory draft · portable download available';
  const saveButton = root.querySelector('[data-action="save-browser"]');
  if (saveButton) saveButton.textContent = 'Download project';
  let sources = new Map();
  let sourceFiles = new Map();
  // Low-memory devices keep the original 64-megapixel session budget.
  const lowMemory =
    matchMedia('(max-width: 820px)').matches ||
    (navigator.deviceMemory && navigator.deviceMemory <= 4);
  function newSourceBudget() {
    return lowMemory
      ? Core.createSourceBudget({ maxDecodedPixels: 64 * 1024 * 1024 })
      : Core.createSourceBudget();
  }
  let sourceBudget = newSourceBudget();
  const createStore = () =>
    App.createProjectStore({
      schema: Core.SCHEMA,
      schemaVersion: Core.SCHEMA_VERSION,
      extension: '.alcorphoto',
      mimeType: 'application/json',
      storageKey: 'alcorphoto.project.v1',
      storage: null,
      historyLimit: 500,
      createProject: () => Core.createProject(),
      normalizeProject: Core.normalizeProject,
      sanitizeProject: Core.normalizeProject,
    });
  let store = createStore();
  let previewFrame = 0;
  let drag = null;
  let dragProject = null;
  const newDocumentHandlers = [];
  let adjustmentPreview = null;
  let exporting = false;
  let operation = null;
  let pendingInput = false;
  let savedContent = projectContent();
  let cleanMessage = 'New project · no unsaved changes';
  const disabledControls = new Map();

  function projectContent(project = store.project) {
    // Selection and edit timestamps are not changes to the user's document.
    const { selectedLayerId, createdAt, updatedAt, selection, ...content } = project;
    return JSON.stringify(content);
  }

  function hasUnsavedChanges() {
    return (
      pendingInput || Boolean(adjustmentPreview || dragProject) || projectContent() !== savedContent
    );
  }

  function showSaveState() {
    elements.save.textContent = hasUnsavedChanges()
      ? 'Unsaved changes · download project'
      : cleanMessage;
  }

  function confirmReplacement() {
    return (
      !hasUnsavedChanges() ||
      window.confirm(
        'Discard unsaved changes? Download the current project first to keep your edits.',
      )
    );
  }

  function syncHistory(state = store.state()) {
    root.querySelector('[data-action="undo"]').disabled = Boolean(operation) || !state.canUndo;
    root.querySelector('[data-action="redo"]').disabled = Boolean(operation) || !state.canRedo;
  }

  function disableBusyControls() {
    if (!operation) return;
    for (const control of root.querySelectorAll('button,input,select,textarea')) {
      if (!disabledControls.has(control)) disabledControls.set(control, control.disabled);
      control.disabled = true;
    }
  }

  async function runOperation(label, action) {
    if (operation) {
      status(`${operation} Please wait before starting another action.`);
      return;
    }
    // Commit a focused field or pointer preview before taking the file snapshot.
    if (root.contains(document.activeElement)) document.activeElement.blur();
    commitAdjustments();
    endDrag();
    operation = label;
    root.setAttribute('aria-busy', 'true');
    disableBusyControls();
    status(label);
    try {
      return await action();
    } catch (error) {
      status(error.message, 'error');
    } finally {
      operation = null;
      root.removeAttribute('aria-busy');
      for (const [control, disabled] of disabledControls)
        if (control.isConnected) control.disabled = disabled;
      disabledControls.clear();
      syncHistory();
      showSaveState();
    }
  }

  function observeStore() {
    store.on('change', (event) => {
      pendingInput = false;
      adjustmentPreview = null;
      status(event.label);
      renderAll();
      showSaveState();
    });
    store.on('history', syncHistory);
    syncHistory();
  }

  function installProject(
    project,
    nextSources = new Map(),
    nextFiles = new Map(),
    nextBudget = newSourceBudget(),
  ) {
    // Validate in a new store before swapping anything. Even reopening identical
    // content starts a new document history, without retaining old source pixels.
    const nextStore = createStore();
    nextStore.replace(project, 'Opened local project', false);
    store = nextStore;
    sources = nextSources;
    sourceFiles = nextFiles;
    sourceBudget = nextBudget;
    drag = dragProject = adjustmentPreview = null;
    pendingInput = false;
    savedContent = projectContent();
    cleanMessage = 'Opened local project · no unsaved changes';
    observeStore();
    renderAll();
    showSaveState();
    for (const listener of storeListeners) listener(store);
  }
  const storeListeners = [];

  // Disabled controls communicate the busy state; the event guard also covers
  // canvas gestures, form submission and commands dispatched by the shared shell.
  for (const type of [
    'click',
    'input',
    'change',
    'submit',
    'pointerdown',
    'pointermove',
    'pointerup',
    'keydown',
  ]) {
    root.addEventListener(
      type,
      (event) => {
        if (!operation) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      true,
    );
  }
  root.addEventListener('input', (event) => {
    if (event.target === elements.name || elements.layerForm.contains(event.target)) {
      pendingInput = true;
      showSaveState();
    }
  });
  window.addEventListener('beforeunload', (event) => {
    if (!operation && !hasUnsavedChanges()) return;
    event.preventDefault();
    event.returnValue = '';
  });

  function setMode(mode) {
    const value = mode === 'advanced' ? 'advanced' : 'essentials';
    root.dataset.mode = value;
    // Basic is its own phone UI; the shared phone frame takes over only in Advanced.
    root.toggleAttribute('data-af-off', value === 'essentials');
    for (const button of root.querySelectorAll('[data-mode-target]'))
      button.setAttribute('aria-pressed', String(button.dataset.modeTarget === value));
    const note = root.querySelector('#ap-mode-note');
    if (note)
      note.textContent =
        value === 'advanced'
          ? 'Advanced adds exact transforms, crop, resize, blend modes, and expanded adjustments.'
          : 'Basic keeps the photo big and the everyday tools in one tray.';
  }

  function setMobilePanel(panel) {
    const value = ['layers', 'layer', 'image'].includes(panel) ? panel : 'layers';
    root.dataset.mobilePanel = value;
    for (const button of root.querySelectorAll('[data-panel-target]'))
      button.setAttribute('aria-pressed', String(button.dataset.panelTarget === value));
  }

  function status(message, level = 'ok') {
    elements.status.textContent = String(message || 'Ready').slice(0, 180);
    elements.status.title = elements.status.textContent;
    elements.status.dataset.level = level;
  }

  function selected(project = store.project) {
    return project.layers.find((layer) => layer.id === project.selectedLayerId) || null;
  }

  function replace(project, label) {
    store.replace(project, label);
  }

  // dirty: optional project-space rectangle that is the only area that changed (a brush
  // stroke). Any request without one repaints everything in that frame.
  let pendingDirty = null;
  function scheduleRender(project = store.project, dirty = null) {
    dragProject = project === store.project ? null : project;
    pendingDirty =
      dirty && pendingDirty !== 'all'
        ? pendingDirty
          ? unionRect(pendingDirty, dirty)
          : { ...dirty }
        : 'all';
    if (previewFrame) return;
    previewFrame = requestAnimationFrame(() => {
      previewFrame = 0;
      const region = pendingDirty === 'all' ? null : pendingDirty;
      pendingDirty = null;
      renderCanvas(dragProject || store.project, region);
    });
  }
  function unionRect(a, b) {
    const x = Math.min(a.x, b.x),
      y = Math.min(a.y, b.y);
    return {
      x,
      y,
      width: Math.max(a.x + a.width, b.x + b.width) - x,
      height: Math.max(a.y + a.height, b.y + b.height) - y,
    };
  }

  // Sources come from decoded imports first, then from registered extensions
  // (pixel layers and masks painted in this session).
  const sourceResolvers = [];
  const sourceOverrides = [];
  function resolveSource(sourceId) {
    // Overrides show in-progress pixels (a stroke, a filter preview) in place of a source.
    for (const override of sourceOverrides) {
      const value = override(sourceId);
      if (value) return value;
    }
    return resolveStoredSource(sourceId);
  }
  // Stored pixels only (no in-progress overrides): what history and saving must use.
  function resolveStoredSource(sourceId) {
    const decoded = sources.get(sourceId);
    if (decoded) return decoded;
    for (const resolver of sourceResolvers) {
      const value = resolver(sourceId);
      if (value) return value;
    }
    return null;
  }
  const hasSource = (sourceId) => Boolean(resolveSource(sourceId));
  const Pixels = globalThis.AlcorPhotoPixels || null;
  const adjustHook = Pixels
    ? (image, layer, geometry) => Pixels.applyAdjustment(image, layer.kind, layer.params, geometry)
    : undefined;

  // Viewport: zoom and pan map project pixels onto a canvas that fills the
  // viewport, so tools work at any magnification.
  const MIN_ZOOM = 1 / 64,
    MAX_ZOOM = 32;
  const view = { mode: 'fit', zoom: 1, panX: 0, panY: 0 };
  const viewport = elements.canvas.parentElement;
  // The viewport size is cached from a ResizeObserver so rendering never forces a
  // synchronous layout; it is measured directly only until the first observation.
  let viewportBox = null;
  function viewportSize() {
    if (viewportBox) return viewportBox;
    const width = Math.max(
      1,
      Math.round(viewport?.clientWidth || elements.canvas.clientWidth || 1280),
    );
    const height = Math.max(
      1,
      Math.round(viewport?.clientHeight || elements.canvas.clientHeight || 720),
    );
    return { width, height };
  }
  function syncViewZoom() {
    if (!elements.zoom) return;
    const value = `${Math.round(view.zoom * 100)}%`;
    elements.zoom.textContent = view.mode === 'manual' ? value : `Fit · ${value}`;
  }
  function viewTransform(project = store.project) {
    const size = viewportSize();
    const crop = project.crop;
    if (view.mode !== 'manual') {
      const pad = Math.min(48, size.width * 0.06);
      const fit = Math.min((size.width - pad) / crop.width, (size.height - pad) / crop.height);
      view.zoom = Math.max(MIN_ZOOM, Math.min(view.mode === 'fit' ? 1 : MAX_ZOOM, fit));
      view.panX = 0;
      view.panY = 0;
    }
    syncViewZoom();
    return {
      zoom: view.zoom,
      x: size.width / 2 - (crop.x + crop.width / 2) * view.zoom + view.panX,
      y: size.height / 2 - (crop.y + crop.height / 2) * view.zoom + view.panY,
      width: size.width,
      height: size.height,
    };
  }
  function clientToProject(clientX, clientY) {
    const rect = elements.canvas.getBoundingClientRect();
    const t = viewTransform();
    return { x: (clientX - rect.left - t.x) / t.zoom, y: (clientY - rect.top - t.y) / t.zoom };
  }
  function projectToClient(x, y) {
    const rect = elements.canvas.getBoundingClientRect();
    const t = viewTransform();
    return { x: rect.left + t.x + x * t.zoom, y: rect.top + t.y + y * t.zoom };
  }
  function setZoom(zoom, clientX, clientY) {
    const rect = elements.canvas.getBoundingClientRect();
    const anchorX = clientX == null ? rect.left + rect.width / 2 : clientX;
    const anchorY = clientY == null ? rect.top + rect.height / 2 : clientY;
    const before = clientToProject(anchorX, anchorY);
    const t = viewTransform();
    view.mode = 'manual';
    view.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(zoom) || 1));
    // Keep the project point under the anchor fixed.
    const crop = store.project.crop;
    view.panX =
      anchorX -
      rect.left -
      t.width / 2 +
      (crop.x + crop.width / 2) * view.zoom -
      before.x * view.zoom;
    view.panY =
      anchorY -
      rect.top -
      t.height / 2 +
      (crop.y + crop.height / 2) * view.zoom -
      before.y * view.zoom;
    syncViewZoom();
    scheduleRender();
  }
  function panBy(dx, dy) {
    viewTransform();
    view.mode = 'manual';
    view.panX += dx;
    view.panY += dy;
    scheduleRender();
  }
  function fitView(mode = 'fit-screen') {
    view.mode = mode === 'fit' ? 'fit' : 'fit-screen';
    viewTransform();
    scheduleRender();
  }
  if (typeof ResizeObserver === 'function' && viewport) {
    new ResizeObserver(() => {
      // The canvas fills the viewport's padding box (clientWidth), not its content box: on
      // phones the viewport has padding, and a content-box size stretched the picture.
      // Layout is already up to date when observations are delivered, so this read is free.
      const box = { width: viewport.clientWidth, height: viewport.clientHeight };
      if (box.width > 0 && box.height > 0)
        viewportBox = {
          width: Math.max(1, Math.round(box.width)),
          height: Math.max(1, Math.round(box.height)),
        };
      scheduleRender();
    }).observe(viewport, { box: 'border-box' });
  }

  const observesViewport = typeof ResizeObserver === 'function' && Boolean(viewport);
  let lastFrameKey = '';
  let lastPaint = null; // { project, key, x, y } of the last complete paint, for pan-by-copy
  const paints = { full: 0, partial: 0, shifted: 0 };
  // Repaint only a device-pixel rectangle (or rectangles) of the view.
  function paintClipped(context, project, view, rects, quality) {
    context.save();
    if (quality) context.imageSmoothingQuality = quality;
    context.beginPath();
    for (const r of rects) context.rect(r.x, r.y, r.width, r.height);
    context.clip();
    Core.renderProject(context, project, resolveSource, { view, adjust: adjustHook });
    context.restore();
  }
  function renderCanvas(project, region = null) {
    // Wait for the first ResizeObserver measurement instead of forcing layout mid-startup.
    if (observesViewport && !viewportBox) return;
    const size = viewportSize();
    const dpr = Math.max(1, Math.min(2, globalThis.devicePixelRatio || 1));
    const width = Math.max(1, Math.round(size.width * dpr));
    const height = Math.max(1, Math.round(size.height * dpr));
    if (elements.canvas.width !== width) elements.canvas.width = width;
    if (elements.canvas.height !== height) elements.canvas.height = height;
    const context = elements.canvas.getContext('2d', { alpha: true });
    if (!context) {
      status('Canvas 2D preview is unavailable in this browser.', 'error');
      return;
    }
    const t = viewTransform(project);
    // Smooth when reducing; show hard pixels when magnified.
    context.imageSmoothingEnabled = t.zoom * dpr < 2;
    context.imageSmoothingQuality = 'medium';
    const view = { scale: t.zoom * dpr, x: t.x * dpr, y: t.y * dpr };
    // A partial repaint is only valid while the frame geometry is unchanged since the last paint.
    const frameKey = [
      width,
      height,
      view.scale,
      view.x,
      view.y,
      project.width,
      project.height,
      project.crop.x,
      project.crop.y,
      project.crop.width,
      project.crop.height,
      project.background || '',
    ].join(',');
    // Adjustment layers read and write whole-canvas pixels (putImageData ignores the clip), so they force a full paint.
    const clippable = !project.layers.some((layer) => layer.visible && layer.type === 'adjustment');
    const partial = region && frameKey === lastFrameKey && clippable;
    lastFrameKey = frameKey;
    // Panning: the same picture moved by whole device pixels. Copy what is already on screen and
    // paint only the strips that scrolled into view.
    const shapeKey = [
      width,
      height,
      view.scale,
      project.width,
      project.height,
      project.crop.x,
      project.crop.y,
      project.crop.width,
      project.crop.height,
      project.background || '',
    ].join(',');
    const rawDx = lastPaint ? view.x - lastPaint.x : 0,
      rawDy = lastPaint ? view.y - lastPaint.y : 0;
    const dx = Math.round(rawDx),
      dy = Math.round(rawDy);
    const wholePixels = Math.abs(rawDx - dx) < 1e-6 && Math.abs(rawDy - dy) < 1e-6;
    if (
      !region &&
      clippable &&
      wholePixels &&
      lastPaint &&
      lastPaint.project === project &&
      lastPaint.key === shapeKey &&
      (dx || dy) &&
      Math.abs(dx) < width &&
      Math.abs(dy) < height
    ) {
      context.save();
      context.globalCompositeOperation = 'copy';
      context.drawImage(elements.canvas, dx, dy);
      context.restore();
      const strips = [];
      if (dx > 0) strips.push({ x: 0, y: 0, width: dx, height });
      if (dx < 0) strips.push({ x: width + dx, y: 0, width: -dx, height });
      if (dy > 0) strips.push({ x: 0, y: 0, width, height: dy });
      if (dy < 0) strips.push({ x: 0, y: height + dy, width, height: -dy });
      paintClipped(context, project, view, strips);
      lastPaint = { project, key: shapeKey, x: view.x, y: view.y };
      paints.shifted += 1;
      root.dispatchEvent(
        new CustomEvent('alcorphoto:view', {
          detail: { zoom: t.zoom, x: t.x, y: t.y, width: t.width, height: t.height, dpr },
        }),
      );
      return;
    }
    if (partial) {
      // Repaint only the device pixels the change can touch (plus a 2 px guard for smoothing).
      const x0 = Math.max(0, Math.floor(region.x * view.scale + view.x) - 2);
      const y0 = Math.max(0, Math.floor(region.y * view.scale + view.y) - 2);
      const x1 = Math.min(width, Math.ceil((region.x + region.width) * view.scale + view.x) + 2);
      const y1 = Math.min(height, Math.ceil((region.y + region.height) * view.scale + view.y) + 2);
      if (x1 <= x0 || y1 <= y0) return;
      // 'medium' rebuilds mipmaps of the whole edited source on every stroke frame; plain
      // bilinear is enough for the moving stroke, and the full paint on release restores it.
      paintClipped(
        context,
        project,
        view,
        [{ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }],
        'low',
      );
      lastPaint = null;
      paints.partial += 1;
      return;
    }
    Core.renderProject(context, project, resolveSource, { view, adjust: adjustHook });
    lastPaint = { project, key: shapeKey, x: view.x, y: view.y };
    paints.full += 1;
    // Write attributes only when they change (each write can invalidate style).
    const missingCount = String(
      project.layers.filter((layer) => layer.type === 'image' && !hasSource(layer.source.id))
        .length,
    );
    if (elements.canvas.dataset.missingSources !== missingCount)
      elements.canvas.dataset.missingSources = missingCount;
    const zoomText = String(Math.round(t.zoom * 10000) / 100);
    if (elements.canvas.dataset.zoom !== zoomText) elements.canvas.dataset.zoom = zoomText;
    root.dispatchEvent(
      new CustomEvent('alcorphoto:view', {
        detail: { zoom: t.zoom, x: t.x, y: t.y, width: t.width, height: t.height, dpr },
      }),
    );
  }

  function renderLayers() {
    elements.layers.replaceChildren();
    const layers = [...store.project.layers].reverse();
    if (!layers.length) {
      const empty = document.createElement('div');
      empty.className = 'aa-empty-state';
      empty.innerHTML = '<strong>No layers yet</strong><span>Import an image or add text.</span>';
      elements.layers.append(empty);
      return;
    }
    for (const layer of layers) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ap-layer';
      button.dataset.layerId = layer.id;
      button.setAttribute('aria-pressed', String(layer.id === store.project.selectedLayerId));
      const visibility = document.createElement('span');
      visibility.textContent = layer.visible ? '◉' : '○';
      visibility.title = layer.visible ? 'Visible' : 'Hidden';
      const label = document.createElement('span');
      const strong = document.createElement('strong');
      const small = document.createElement('small');
      strong.textContent = layer.name;
      small.textContent =
        layer.type === 'image'
          ? layer.source.name
          : layer.type === 'text'
            ? layer.text
            : `${layer.shape} · ${Math.round(layer.width)}×${Math.round(layer.height)}`;
      label.append(strong, small);
      const kind = document.createElement('b');
      kind.textContent = layer.type === 'image' ? 'IMG' : layer.type === 'text' ? 'TXT' : 'SHP';
      button.append(visibility, label, kind);
      elements.layers.append(button);
    }
  }

  function renderInspector() {
    const layer = selected();
    elements.layerForm.hidden = !layer;
    elements.layerShortcuts.hidden = !layer;
    const heading = root.querySelector('#ap-layer-heading');
    if (heading) {
      const kind = layer
        ? { text: 'Text', shape: 'Shape', image: 'Image', adjustment: 'Adjustment' }[layer.type] ||
          'Layer'
        : '';
      heading.textContent = layer ? `${kind} · ${layer.name}` : 'No layer selected';
    }
    if (layer) {
      for (const name of ['x', 'y', 'scaleX', 'scaleY', 'rotation'])
        elements.layerForm.elements[name].value = String(layer.transform[name]);
      elements.layerForm.elements.opacity.value = String(Math.round(layer.opacity * 100));
      const opacityOutput = root.querySelector('[data-layer-value="opacity"]');
      if (opacityOutput) opacityOutput.textContent = String(Math.round(layer.opacity * 100));
      elements.layerForm.elements.visible.checked = layer.visible;
      elements.layerForm.elements.layerName.value = layer.name;
      elements.layerForm.elements.blendMode.value = layer.blendMode;
      const isText = layer.type === 'text';
      const isShape = layer.type === 'shape';
      for (const field of elements.layerForm.querySelectorAll('[data-text-field]'))
        field.hidden = !isText;
      for (const field of elements.layerForm.querySelectorAll('[data-shape-field]'))
        field.hidden = !isShape;
      if (isText) {
        elements.layerForm.elements.text.value = layer.text;
        elements.layerForm.elements.fontSize.value = String(layer.fontSize);
        elements.layerForm.elements.color.value = layer.color;
        elements.layerForm.elements.fontWeight.value = String(layer.fontWeight);
        elements.layerForm.elements.align.value = layer.align;
        elements.layerForm.elements.fontFamily.value = layer.fontFamily;
        syncFontPreset(layer.fontFamily);
        const f = elements.layerForm.elements;
        if (f.textStroke) {
          f.textStroke.value = layer.stroke || '#ffffff';
          f.textStrokeWidth.value = String(layer.strokeWidth || 0);
        }
        if (f.shadowColor) {
          f.shadowColor.value = layer.shadowColor || '#000000';
          f.shadowBlur.value = String(layer.shadowBlur || 0);
          f.shadowX.value = String(layer.shadowX || 0);
          f.shadowY.value = String(layer.shadowY || 0);
        }
        if (elements.layerForm.elements.italic)
          elements.layerForm.elements.italic.checked = Boolean(layer.italic);
        if (elements.layerForm.elements.lineHeight)
          elements.layerForm.elements.lineHeight.value = String(layer.lineHeight || 1.2);
        if (elements.layerForm.elements.letterSpacing)
          elements.layerForm.elements.letterSpacing.value = String(layer.letterSpacing || 0);
      }
      if (isShape) {
        const kind = elements.layerForm.querySelector('[data-shape-kind-field]');
        if (kind) {
          kind.hidden = layer.shape === 'path';
          if (layer.shape !== 'path') elements.layerForm.elements.shapeKind.value = layer.shape;
        }
        elements.layerForm.elements.shapeWidth.value = String(layer.width);
        elements.layerForm.elements.shapeHeight.value = String(layer.height);
        elements.layerForm.elements.fill.value = layer.fill;
        elements.layerForm.elements.stroke.value = layer.stroke;
        elements.layerForm.elements.strokeWidth.value = String(layer.strokeWidth);
      }
    }
    const crop = store.project.crop;
    for (const name of ['x', 'y', 'width', 'height'])
      elements.cropForm.elements[name].value = String(crop[name]);
    elements.backgroundForm.elements.background.value = store.project.background || '#ffffff';
    elements.backgroundForm.elements.transparent.checked = !store.project.background;
    elements.resizeForm.elements.width.value = String(store.project.width);
    elements.resizeForm.elements.height.value = String(store.project.height);
    for (const name of ADJUSTMENT_NAMES) {
      elements.adjustments.elements[name].value = String(store.project.adjustments[name]);
      const out = root.querySelector(`[data-adjustment-value="${name}"]`);
      if (out) out.textContent = String(store.project.adjustments[name]);
    }
  }

  function renderAll() {
    elements.name.value = store.project.name;
    renderLayers();
    renderInspector();
    const missing = store.project.layers.filter(
      (layer) => layer.type === 'image' && !hasSource(layer.source.id),
    ).length;
    elements.stats.textContent = `${store.project.layers.length} layer${store.project.layers.length === 1 ? '' : 's'} · ${store.project.crop.width}×${store.project.crop.height}${missing ? ` · ${missing} image${missing === 1 ? '' : 's'} to relink` : ''}`;
    const relink = elements.relinkFile?.closest('[data-ap-relink]');
    if (relink) relink.hidden = !missing;
    scheduleRender();
    disableBusyControls();
  }

  function selectLayer(layerId) {
    store.replaceTransient({ ...store.project, selectedLayerId: layerId }, 'Selected layer');
  }

  function adjustmentValues() {
    const data = new FormData(elements.adjustments);
    return Object.fromEntries(ADJUSTMENT_NAMES.map((name) => [name, Number(data.get(name))]));
  }

  function previewAdjustments() {
    adjustmentPreview = Core.setAdjustments(store.project, adjustmentValues());
    for (const name of ADJUSTMENT_NAMES) {
      const out = root.querySelector(`[data-adjustment-value="${name}"]`);
      if (out) out.textContent = String(adjustmentPreview.adjustments[name]);
    }
    scheduleRender(adjustmentPreview);
  }

  function commitAdjustments() {
    const values = adjustmentValues();
    if (
      !adjustmentPreview &&
      Object.entries(values).every(([name, value]) => store.project.adjustments[name] === value)
    )
      return;
    const next = adjustmentPreview || Core.setAdjustments(store.project, values);
    adjustmentPreview = null;
    replace(next, 'Changed adjustments');
  }

  function discardSource(sourceId) {
    sources.delete(sourceId);
    sourceFiles.delete(sourceId);
    sourceBudget.release(sourceId);
  }

  async function readImageDimensions(file) {
    const bytes = new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (
      bytes.length >= 24 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    ) {
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
      return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
    }
    if (
      bytes.length >= 30 &&
      view.getUint32(0) === 0x52494646 &&
      view.getUint32(8) === 0x57454250
    ) {
      const chunk = String.fromCharCode(...bytes.slice(12, 16));
      if (chunk === 'VP8X')
        return {
          width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
          height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
        };
      if (chunk === 'VP8L' && bytes[20] === 0x2f) {
        const bits = view.getUint32(21, true);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
      }
      if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
        return {
          width: view.getUint16(26, true) & 0x3fff,
          height: view.getUint16(28, true) & 0x3fff,
        };
      }
    }
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = bytes[offset + 1];
        if (
          [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
            marker,
          )
        ) {
          return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
        }
        if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset += 2;
          continue;
        }
        const length = view.getUint16(offset + 2);
        if (length < 2) break;
        offset += length + 2;
      }
    }
    return null;
  }

  async function decodeImageInto(
    file,
    targetSources,
    targetBudget,
    targetFiles,
    preferredId = null,
  ) {
    if (!(file instanceof File) || !/^image\/(png|jpeg|webp|gif)$/i.test(file.type))
      throw new Error('Choose a PNG, JPEG, WebP, or GIF image.');
    const mobile =
      matchMedia('(max-width: 820px)').matches ||
      (navigator.deviceMemory && navigator.deviceMemory <= 4);
    const sourceByteLimit = mobile ? 64 * 1024 * 1024 : Core.MAX_SOURCE_BYTES;
    if (file.size <= 0 || file.size > sourceByteLimit)
      throw new Error(
        `Image files must be between 1 byte and ${mobile ? 64 : 256} MB on this device.`,
      );
    const decodedPixelLimit = mobile ? 24 * 1024 * 1024 : Core.MAX_CANVAS_PIXELS;
    const dimensions = await readImageDimensions(file);
    if (
      dimensions &&
      (dimensions.width < 1 ||
        dimensions.height < 1 ||
        dimensions.width > Core.MAX_DIMENSION ||
        dimensions.height > Core.MAX_DIMENSION ||
        dimensions.width * dimensions.height > decodedPixelLimit)
    ) {
      throw new Error(
        `Image dimensions exceed the ${mobile ? 24 : 64}-megapixel decode budget on this device.`,
      );
    }
    const url = URL.createObjectURL(file);
    try {
      const image = await new Promise((resolve, reject) => {
        const value = new Image();
        value.decoding = 'async';
        value.onload = () => resolve(value);
        value.onerror = () => reject(new Error('The browser could not decode that image.'));
        value.src = url;
      });
      if (
        image.naturalWidth < 1 ||
        image.naturalHeight < 1 ||
        image.naturalWidth > Core.MAX_DIMENSION ||
        image.naturalHeight > Core.MAX_DIMENSION ||
        image.naturalWidth * image.naturalHeight > decodedPixelLimit
      ) {
        throw new Error(
          `Decoded images are limited to 16,384 pixels per side and ${mobile ? 24 : 64} megapixels on this device.`,
        );
      }
      const id =
        preferredId ||
        `source-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
      const source = {
        id,
        name: file.name,
        mime: file.type,
        width: image.naturalWidth,
        height: image.naturalHeight,
        size: file.size,
      };
      targetBudget.reserve(source);
      targetSources.set(id, image);
      targetFiles.set(id, file.slice(0, file.size, file.type));
      return source;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function decodeImage(file) {
    return decodeImageInto(file, sources, sourceBudget, sourceFiles);
  }

  // The PSD reader loads on first use (a same-origin script beside this one).
  let psdLoading = null;
  function loadPsdModule() {
    if (globalThis.AlcorPhotoPsd) return Promise.resolve(globalThis.AlcorPhotoPsd);
    if (psdLoading) return psdLoading;
    const own =
      document.querySelector('script[src*="alcor-photo.js"]')?.src ||
      document.querySelector('script[src*="alcor-photo-core.js"]')?.src;
    if (!own) return Promise.resolve(null);
    psdLoading = new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = own.replace(/alcor-photo(-core)?\.js/, 'alcor-photo-psd.js');
      script.onload = () => resolve(globalThis.AlcorPhotoPsd || null);
      script.onerror = () => {
        psdLoading = null;
        resolve(null);
      };
      document.head.append(script);
    });
    return psdLoading;
  }

  // PSD documents import as their flattened composite, converted to PNG locally.
  async function psdToPng(file) {
    const Psd = await loadPsdModule();
    if (!Psd) throw new Error('PSD import is unavailable in this build.');
    if (file.size <= 0 || file.size > Core.MAX_SOURCE_BYTES)
      throw new Error('PSD files must be between 1 byte and 256 MB.');
    const decoded = Psd.decodePsd(new Uint8Array(await file.arrayBuffer()));
    const canvas = document.createElement('canvas');
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    canvas
      .getContext('2d')
      .putImageData(new ImageData(decoded.data, decoded.width, decoded.height), 0, 0);
    const blob = await canvasBlob(canvas, 'image/png');
    psdNote = `${file.name}: imported its flattened composite (${decoded.width}×${decoded.height}, ${decoded.mode}${decoded.transparent ? ', transparent' : ''}). Layers inside the PSD are not imported.`;
    return new File([blob], `${file.name.replace(/\.ps[db]$/i, '')}.png`, { type: 'image/png' });
  }

  // Formats the browser cannot decode by itself are decoded by AlcorPhotoFormats
  // into pixels first. Layered PSD and ORA files keep their layers.
  async function rgbaToPngFile(image, name) {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    canvas
      .getContext('2d')
      .putImageData(
        new ImageData(new Uint8ClampedArray(image.data), image.width, image.height),
        0,
        0,
      );
    return new File([await canvasBlob(canvas, 'image/png')], name, { type: 'image/png' });
  }
  async function svgToPngFile(file) {
    if (file.size > 32 * 1024 * 1024) throw new Error('SVG files are limited to 32 MB.');
    const url = URL.createObjectURL(
      new Blob([await file.arrayBuffer()], { type: 'image/svg+xml' }),
    );
    try {
      const image = await new Promise((resolve, reject) => {
        const value = new Image();
        value.onload = () => resolve(value);
        value.onerror = () => reject(new Error('The browser could not draw that SVG.'));
        value.src = url;
      });
      let width = image.naturalWidth || 1024,
        height = image.naturalHeight || 1024;
      const fit = Math.min(1, 8192 / Math.max(width, height));
      width = Math.max(1, Math.round(width * fit));
      height = Math.max(1, Math.round(height * fit));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(image, 0, 0, width, height);
      return new File(
        [await canvasBlob(canvas, 'image/png')],
        file.name.replace(/\.svgz?$/i, '.png'),
        { type: 'image/png' },
      );
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  async function importLayers(file, doc) {
    if (!doc.layers.length) return false;
    if (!confirmReplacement()) {
      status('Import cancelled. Current project preserved.');
      return true;
    }
    const base = Core.createProject({
      name: file.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'Imported layers',
      width: doc.width,
      height: doc.height,
    });
    installProject(base);
    let project = store.project;
    for (const layer of doc.layers) {
      const png = layer.png
        ? new File([layer.png], `${layer.name || 'Layer'}.png`, { type: 'image/png' })
        : await rgbaToPngFile(layer, `${layer.name || 'Layer'}.png`);
      const source = await decodeImage(png);
      source.name = String(layer.name || 'Layer').slice(0, 80);
      project = Core.addImageLayer(project, source);
      const id = project.selectedLayerId;
      project = Core.updateLayer(project, id, {
        name: source.name,
        opacity: layer.opacity ?? 1,
        visible: layer.visible !== false,
        blendMode: Core.BLEND_MODES.includes(layer.blendMode) ? layer.blendMode : 'normal',
        clip: layer.clipped === true,
        transform: {
          x: (layer.left ?? layer.x ?? 0) + source.width / 2,
          y: (layer.top ?? layer.y ?? 0) + source.height / 2,
          scaleX: 1,
          scaleY: 1,
          rotation: 0,
        },
      });
    }
    // The first image layer sizes an empty project; a layered file brings its own canvas.
    replace(
      {
        ...project,
        width: doc.width,
        height: doc.height,
        crop: { x: 0, y: 0, width: doc.width, height: doc.height },
      },
      `Imported ${file.name}`,
    );
    fitView();
    psdNote = `${file.name}: ${doc.layers.length} layer${doc.layers.length === 1 ? '' : 's'} imported.${doc.note ? ` ${doc.note}` : ''}`;
    return true;
  }
  async function convertForImport(file) {
    const Formats = globalThis.AlcorPhotoFormats;
    if (!(file instanceof File) || !Formats || /^image\/(png|jpeg|webp|gif)$/i.test(file.type))
      return { file };
    if (file.size <= 0 || file.size > Core.MAX_SOURCE_BYTES)
      throw new Error('Image files must be between 1 byte and 256 MB.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = Formats.sniff(bytes, file.name);
    const png = (name) => `${file.name.replace(/\.[^.]+$/, '')}.png`;
    if (kind === 'png' || kind === 'jpeg' || kind === 'webp' || kind === 'gif')
      return { file: new File([bytes], file.name, { type: `image/${kind}` }) };
    if (kind === 'avif' || kind === 'bmp') {
      // The browser decodes these; re-encode as PNG so the project stores a portable source.
      const url = URL.createObjectURL(new Blob([bytes], { type: `image/${kind}` }));
      try {
        const image = await new Promise((resolve, reject) => {
          const value = new Image();
          value.onload = () => resolve(value);
          value.onerror = () =>
            reject(new Error(`This browser cannot open ${kind.toUpperCase()} files.`));
          value.src = url;
        });
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext('2d').drawImage(image, 0, 0);
        return {
          file: new File([await canvasBlob(canvas, 'image/png')], png(), { type: 'image/png' }),
        };
      } catch (error) {
        if (kind === 'bmp') return { file: await rgbaToPngFile(Formats.decodeBmp(bytes), png()) };
        throw error;
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    if (kind === 'svg') return { file: await svgToPngFile(file) };
    if (kind === 'ora') {
      const doc = await Formats.decodeOra(bytes);
      return {
        layers: {
          width: doc.width,
          height: doc.height,
          layers: doc.layers.map((layer) => ({ ...layer, left: layer.x, top: layer.y })),
        },
      };
    }
    if (kind === 'psd') {
      try {
        const doc = Formats.decodePsdLayers(bytes);
        // Group folders and their end markers carry no pixels; every other layer is kept.
        const layers = doc.layers.filter(
          (layer) =>
            !['open', 'closed', 'divider'].includes(layer.section) &&
            layer.width > 0 &&
            layer.height > 0,
        );
        const masked = layers.filter((layer) => layer.masked).length;
        if (layers.length)
          return {
            layers: {
              width: doc.width,
              height: doc.height,
              layers,
              note: `${masked ? `${masked} layer mask${masked === 1 ? ' was' : 's were'} applied to the pixels. ` : ''}Layer effects and adjustment layers are not imported.`,
            },
          };
      } catch {
        /* fall back to the flattened composite below */
      }
      return { file: await psdToPng(new File([bytes], file.name)) };
    }
    if (kind === 'ico') {
      const icon = Formats.decodeIco(bytes);
      return {
        file: icon.png
          ? new File([icon.png], png(), { type: 'image/png' })
          : await rgbaToPngFile(icon, png()),
      };
    }
    if (['tiff', 'tga', 'qoi', 'ppm'].includes(kind))
      return {
        file: await rgbaToPngFile(
          Formats.decode(bytes, { format: kind, filename: file.name }),
          png(),
        ),
      };
    if (kind === 'heic')
      throw new Error(
        'HEIC photos cannot be decoded in this browser. Export the photo as JPEG on the device first.',
      );
    if (kind === 'pdf')
      throw new Error('PDF import is not supported. Export the page as an image first.');
    return { file };
  }

  let psdNote = '';
  async function importImage(file) {
    psdNote = '';
    const converted = await convertForImport(file);
    if (converted.layers) {
      if (await importLayers(file, converted.layers)) {
        status(psdNote || 'Imported.');
        return;
      }
    }
    file = converted.file || file;
    if (
      file instanceof File &&
      (/\.ps[db]$/i.test(file.name) || file.type === 'image/vnd.adobe.photoshop')
    )
      file = await psdToPng(file);
    const source = await decodeImage(file);
    try {
      replace(Core.addImageLayer(store.project, source), `Imported ${source.name}`);
    } catch (error) {
      discardSource(source.id);
      throw error;
    }
    status(psdNote || `${source.name} imported without changing the source file.`);
  }

  async function relinkImage(file) {
    const layer = selected();
    if (!layer || layer.type !== 'image') throw new Error('Select an image layer to relink.');
    const source = await decodeImage(file);
    try {
      replace(Core.relinkImageLayer(store.project, layer.id, source), `Relinked ${layer.name}`);
    } catch (error) {
      discardSource(source.id);
      throw error;
    }
    status(`${layer.name} relinked from a local file.`);
  }

  async function openProject(file) {
    if (!(file instanceof File) || file.size <= 0)
      throw new Error('Choose a non-empty AlcorPhoto project file.');
    if (await Core.isPortableBundle(file)) {
      const bundle = await Core.readPortableBundle(file);
      if (!confirmReplacement()) {
        status('Open cancelled. Current project preserved.');
        return;
      }
      const nextSources = new Map();
      const nextFiles = new Map();
      const nextBudget = newSourceBudget();
      for (const entry of bundle.sources) {
        const local = new File([entry.blob], entry.metadata.name, { type: entry.metadata.mime });
        const decoded = await decodeImageInto(
          local,
          nextSources,
          nextBudget,
          nextFiles,
          entry.metadata.id,
        );
        if (
          decoded.width !== entry.metadata.width ||
          decoded.height !== entry.metadata.height ||
          decoded.size !== entry.metadata.size ||
          decoded.mime !== entry.metadata.mime
        ) {
          throw new Error(
            `Portable project image metadata changed while decoding ${entry.metadata.name}.`,
          );
        }
      }
      installProject(bundle.project, nextSources, nextFiles, nextBudget);
      status(
        `Portable project opened with ${bundle.sources.length} local image source${bundle.sources.length === 1 ? '' : 's'} restored.`,
      );
      return;
    }
    if (file.size > 10 * 1024 * 1024)
      throw new Error('Legacy metadata-only project files are limited to 10 MB.');
    const parsed = Core.normalizeProject(JSON.parse(await file.text()));
    if (!confirmReplacement()) {
      status('Open cancelled. Current project preserved.');
      return;
    }
    installProject(parsed);
    status(
      'Legacy metadata-only project opened. Relink image layers once, then download a portable project.',
    );
  }

  const bundlePreparers = [];
  // Extensions contribute bytes for sources they own (painted pixels, masks).
  async function prepareBundle(project) {
    let prepared = { project, files: new Map(sourceFiles) };
    for (const prepare of bundlePreparers) prepared = await prepare(prepared);
    return prepared;
  }

  async function downloadProject() {
    const project = Core.normalizeProject(store.project);
    const content = projectContent(project);
    const prepared = await prepareBundle(project);
    const bundle = await Core.createPortableBundle(prepared.project, prepared.files);
    const name = `${App.utils.safeName(project.name, 'alcorphoto')}.alcorphoto`;
    App.utils.download(bundle, name);
    root.dispatchEvent(
      new CustomEvent('alcorphoto:saved', {
        detail: { filename: name, bytes: bundle.size, kind: 'project' },
      }),
    );
    savedContent = content;
    cleanMessage = 'Project download started · current version';
    showSaveState();
    status(`${name} downloaded with its referenced local image bytes. Nothing was uploaded.`);
  }

  // Some browsers (notably iOS Safari) hand out canvases above their memory limit
  // that silently draw nothing. Write and read back the far corner before trusting one.
  function assertCanvasUsable(context, size) {
    try {
      context.save();
      context.fillStyle = '#ff00ff';
      context.fillRect(size.width - 1, size.height - 1, 1, 1);
      const probe = context.getImageData(size.width - 1, size.height - 1, 1, 1).data;
      context.clearRect(size.width - 1, size.height - 1, 1, 1);
      context.restore();
      if (probe[0] === 255 && probe[1] === 0 && probe[2] === 255) return;
    } catch {
      /* fall through to the explanation */
    }
    throw new Error(
      `This browser cannot allocate a ${size.width}×${size.height} image. Choose a smaller export size (Size → 75% or 50%).`,
    );
  }

  function canvasBlob(canvas, mime, quality) {
    return new Promise((resolve, reject) =>
      canvas.toBlob(
        (blob) => {
          if (!blob || blob.size <= 0) reject(new Error(`The browser could not encode ${mime}.`));
          else if (blob.type && blob.type !== mime)
            reject(new Error(`This browser did not produce the requested ${mime} format.`));
          else resolve(blob);
        },
        mime,
        quality,
      ),
    );
  }

  // ------------------------------------------------------------------ more export formats
  // Flattened formats encode the rendered pixels; layered formats (PSD, ORA,
  // layered SVG) keep each layer. Layers at or below the topmost adjustment
  // layer are flattened into one layer, because adjustments have no
  // equivalent in those files.
  let extraNote = '';
  const pixelsOf = (context, size) => {
    const d = context.getImageData(0, 0, size.width, size.height);
    return { width: size.width, height: size.height, data: d.data };
  };
  const pngBytes = async (image) => {
    const c = document.createElement('canvas');
    c.width = image.width;
    c.height = image.height;
    c.getContext('2d').putImageData(
      new ImageData(new Uint8ClampedArray(image.data), image.width, image.height),
      0,
      0,
    );
    return new Uint8Array(await (await canvasBlob(c, 'image/png')).arrayBuffer());
  };
  const dpiOf = (project) => project.ppi || 72;
  // An image layer's own pixels as encoded bytes: the original file when the layer
  // still shows it untouched (fast, and a JPEG stays a JPEG), else a PNG at source size.
  async function sourceBytes(source) {
    const file = sourceFiles.get(source.id);
    const stored = sources.get(source.id);
    if (
      file &&
      stored &&
      resolveSource(source.id) === stored &&
      /^image\/(png|jpeg|gif|webp)$/i.test(file.type)
    )
      return new Uint8Array(await file.arrayBuffer());
    const pixels = resolveSource(source.id);
    if (!pixels) throw new Error('Relink every image layer before exporting.');
    const c = document.createElement('canvas');
    c.width = source.width;
    c.height = source.height;
    c.getContext('2d').drawImage(pixels, 0, 0, source.width, source.height);
    return new Uint8Array(await (await canvasBlob(c, 'image/png')).arrayBuffer());
  }
  function renderAlone(project, layers, options = {}) {
    const p = project,
      w = p.crop.width,
      h = p.crop.height;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const solo = {
      ...p,
      layers,
      background: options.background || null,
      adjustments: { brightness: 0, contrast: 0, saturation: 0, hue: 0, blur: 0, grayscale: 0 },
    };
    if (!options.keepGroups) delete solo.groups;
    delete solo.selection;
    Core.renderProject(ctx, solo, resolveSource, { adjust: adjustHook });
    const data = ctx.getImageData(0, 0, w, h).data;
    canvas.width = canvas.height = 0; // release the backing store now, not at GC time
    return { width: w, height: h, data };
  }
  function trimmed(image) {
    let x0 = image.width,
      y0 = image.height,
      x1 = -1,
      y1 = -1;
    for (let y = 0; y < image.height; y += 1)
      for (let x = 0; x < image.width; x += 1)
        if (image.data[(y * image.width + x) * 4 + 3]) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
    if (x1 < 0) return { left: 0, top: 0, width: 1, height: 1, data: new Uint8ClampedArray(4) };
    const width = x1 - x0 + 1,
      height = y1 - y0 + 1,
      data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1)
      data.set(
        image.data.subarray(
          ((y0 + y) * image.width + x0) * 4,
          ((y0 + y) * image.width + x0 + width) * 4,
        ),
        y * width * 4,
      );
    return { left: x0, top: y0, width, height, data };
  }
  // The document as a stack of exportable layers (bottom first).
  // Raster items are trimmed as soon as they are rendered, so a deep stack never
  // holds many full-size images at once.
  function exportStack(project, vectors) {
    const p = Core.normalizeProject(project);
    const groups = new Map((p.groups || []).map((group) => [group.id, group]));
    const lastAdjustment = p.layers.reduce(
      (found, layer, index) => (layer.type === 'adjustment' ? index : found),
      -1,
    );
    const stack = [];
    const notes = [];
    const raster = (item, image) => ({ ...item, kind: 'raster', piece: trimmed(image) });
    if (lastAdjustment >= 0) {
      // Adjustments see the background, exactly as in the editor.
      stack.push(
        raster(
          {
            name: 'Flattened (adjustments applied)',
            opacity: 1,
            blendMode: 'normal',
            visible: true,
          },
          renderAlone(p, p.layers.slice(0, lastAdjustment + 1), {
            keepGroups: true,
            background: p.background,
          }),
        ),
      );
      notes.push('Adjustment layers were flattened into the bottom layer.');
    } else if (p.background && !vectors) {
      // Layered SVG writes the background as a plain rectangle instead.
      stack.push(
        raster(
          { name: 'Background', opacity: 1, blendMode: 'normal', visible: true },
          renderAlone(p, [], { background: p.background }),
        ),
      );
    }
    const rest = p.layers.slice(lastAdjustment + 1);
    for (let index = 0; index < rest.length; index += 1) {
      const layer = rest[index];
      const group = layer.groupId ? groups.get(layer.groupId) : null;
      const opacity = layer.opacity * (group ? group.opacity : 1);
      const visible = layer.visible && (!group || group.visible);
      const skewed = Boolean(layer.transform.skewX || layer.transform.skewY);
      const plain =
        !layer.rasterMask && !layer.styles && !(layer.fillOpacity < 1) && !layer.clip && !skewed;
      const base = {
        name: group ? `${group.name} / ${layer.name}` : layer.name,
        opacity,
        blendMode: layer.blendMode,
        visible,
        clipped: Boolean(layer.clip),
        layer,
      };
      // A layer with clipped layers above it exports as one flattened clipping group.
      let end = index + 1;
      while (end < rest.length && rest[end].clip) end += 1;
      if (end > index + 1) {
        const run = rest.slice(index, end).map((item, k) => {
          const copy = {
            ...item,
            ...(k ? {} : { visible: true, opacity: 1, blendMode: 'normal' }),
          };
          delete copy.groupId;
          return copy;
        });
        stack.push(
          raster(
            { ...base, name: `${base.name} (clipping group)`, clipped: false },
            renderAlone(p, run),
          ),
        );
        index = end - 1;
        continue;
      }
      if (
        vectors &&
        plain &&
        (layer.type === 'text' || layer.type === 'shape' || layer.type === 'image')
      ) {
        stack.push({ ...base, kind: layer.type });
        continue;
      }
      const alone = { ...layer, visible: true, opacity: 1, blendMode: 'normal', clip: false };
      delete alone.groupId;
      stack.push(raster(base, renderAlone(p, [alone])));
    }
    if (Object.values(p.adjustments).some(Boolean))
      notes.push('Whole-composition color settings are in the merged image only.');
    extraNote = notes.join(' ');
    return { p, stack };
  }
  // Canvas path commands → SVG path data, for shape layers.
  function shapeToPathData(layer) {
    const d = [],
      f = (v) => String(Math.round(v * 1000) / 1000);
    const rec = {
      beginPath() {},
      closePath() {
        d.push('Z');
      },
      moveTo(x, y) {
        d.push(`M${f(x)} ${f(y)}`);
      },
      lineTo(x, y) {
        d.push(`L${f(x)} ${f(y)}`);
      },
      bezierCurveTo(a, b, c, e, x, y) {
        d.push(`C${f(a)} ${f(b)} ${f(c)} ${f(e)} ${f(x)} ${f(y)}`);
      },
      quadraticCurveTo(a, b, x, y) {
        d.push(`Q${f(a)} ${f(b)} ${f(x)} ${f(y)}`);
      },
      rect(x, y, w, h) {
        d.push(`M${f(x)} ${f(y)}H${f(x + w)}V${f(y + h)}H${f(x)}Z`);
      },
      ellipse(cx, cy, rx, ry) {
        d.push(
          `M${f(cx + rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx - rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx + rx)} ${f(cy)}Z`,
        );
      },
    };
    Core.shapePath(rec, layer);
    return d.join('');
  }
  async function layeredSvg({ Formats, project }) {
    const { p, stack } = exportStack(project, true);
    const ox = -p.crop.x,
      oy = -p.crop.y,
      layers = [];
    for (const item of stack) {
      const common = {
        name: item.name,
        opacity: item.opacity,
        blendMode: item.blendMode,
        visible: item.visible,
      };
      const t = item.layer?.transform;
      if (item.kind === 'raster') {
        const piece = item.piece;
        layers.push({
          ...common,
          type: 'raster',
          x: piece.left,
          y: piece.top,
          width: piece.width,
          height: piece.height,
          png: await pngBytes(piece),
        });
      } else if (item.kind === 'image') {
        const src = item.layer.source;
        layers.push({
          ...common,
          type: 'image',
          x: t.x + ox - src.width / 2,
          y: t.y + oy - src.height / 2,
          width: src.width,
          height: src.height,
          rotation: t.rotation,
          scaleX: t.scaleX,
          scaleY: t.scaleY,
          bytes: await sourceBytes(src),
        });
      } else if (item.kind === 'text') {
        const l = item.layer,
          lines = l.text.replace(/\r\n?/g, '\n').split('\n').length,
          lh = l.lineHeight || 1.2;
        layers.push({
          ...common,
          type: 'text',
          x: t.x + ox,
          y: t.y + oy,
          rotation: t.rotation,
          scaleX: t.scaleX,
          scaleY: t.scaleY,
          text: l.text,
          fontFamily: l.fontFamily,
          fontSize: l.fontSize,
          fontWeight: l.fontWeight,
          italic: l.italic,
          letterSpacing: l.letterSpacing,
          lineHeight: lh,
          align: l.align,
          baseline: -((lines - 1) * lh) / 2 + 0.35,
          fill: l.color,
          stroke: l.strokeWidth ? l.stroke : null,
          strokeWidth: l.strokeWidth || 0,
          shadow:
            l.shadowColor && (l.shadowBlur || l.shadowX || l.shadowY)
              ? {
                  color: l.shadowColor,
                  blur: l.shadowBlur || 0,
                  x: l.shadowX || 0,
                  y: l.shadowY || 0,
                }
              : null,
        });
      } else {
        const l = item.layer;
        layers.push({
          ...common,
          type: 'path',
          x: t.x + ox,
          y: t.y + oy,
          rotation: t.rotation,
          scaleX: t.scaleX,
          scaleY: t.scaleY,
          d: shapeToPathData(l),
          fill: l.shape === 'line' || (l.shape === 'path' && !l.closed) ? 'none' : l.fill,
          stroke: l.stroke,
          strokeWidth:
            l.shape === 'line' || (l.shape === 'path' && !l.closed)
              ? Math.max(1, l.strokeWidth)
              : l.strokeWidth,
        });
      }
    }
    return Formats.encodeLayeredSvg({
      width: p.crop.width,
      height: p.crop.height,
      background: p.background,
      title: p.name,
      layers,
    });
  }
  async function layeredFile(Formats, project, kind) {
    const { p, stack } = exportStack(project, false);
    const layers = stack.map((item) => {
      const piece = item.piece;
      return {
        name: item.name,
        left: piece.left,
        top: piece.top,
        width: piece.width,
        height: piece.height,
        data: piece.data,
        opacity: item.opacity,
        visible: item.visible,
        blendMode: item.blendMode,
        clipped: item.clipped,
      };
    });
    const composite = (() => {
      const canvas = document.createElement('canvas');
      canvas.width = p.crop.width;
      canvas.height = p.crop.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const report = {};
      Core.renderProject(ctx, p, resolveSource, { adjust: adjustHook, report });
      if (report.missingMasks?.length)
        throw new Error('A layer mask is missing its pixels. Remove the mask before exporting.');
      return {
        width: canvas.width,
        height: canvas.height,
        data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
      };
    })();
    const doc = { width: p.crop.width, height: p.crop.height, composite, layers };
    return kind === 'psd'
      ? Formats.encodePsd(doc, { dpi: dpiOf(p) })
      : Formats.encodeOra(doc, { pngEncoder: pngBytes, dpi: dpiOf(p) });
  }
  const flat =
    (fn) =>
    ({ Formats, context, size, project }) =>
      fn(Formats, pixelsOf(context, size), dpiOf(project), project);
  const EXTRA_EXPORTS = Object.freeze({
    avif: {
      label: 'AVIF',
      extension: 'avif',
      mime: 'image/avif',
      canvasMime: 'image/avif',
      encode: ({ canvas, quality }) => canvasBlob(canvas, 'image/avif', quality),
    },
    gif: {
      label: 'GIF',
      extension: 'gif',
      mime: 'image/gif',
      canvasMime: 'image/png',
      encode: flat((F, img) => F.encodeGif(img, { dither: true })),
    },
    tiff: {
      label: 'TIFF (LZW)',
      extension: 'tif',
      mime: 'image/tiff',
      canvasMime: 'image/png',
      encode: flat((F, img, dpi) => F.encodeTiff(img, { compression: 'lzw', dpi })),
    },
    bmp: {
      label: 'BMP',
      extension: 'bmp',
      mime: 'image/bmp',
      canvasMime: 'image/png',
      encode: flat((F, img, dpi) => F.encodeBmp(img, { dpi })),
    },
    ico: {
      label: 'ICO (16–256 px)',
      extension: 'ico',
      mime: 'image/x-icon',
      canvasMime: 'image/png',
      encode: flat((F, img) => F.encodeIco(img, { pngEncoder: pngBytes })),
    },
    tga: {
      label: 'TGA',
      extension: 'tga',
      mime: 'image/x-tga',
      canvasMime: 'image/png',
      encode: flat((F, img) => F.encodeTga(img, { rle: true })),
    },
    qoi: {
      label: 'QOI',
      extension: 'qoi',
      mime: 'image/qoi',
      canvasMime: 'image/png',
      encode: flat((F, img) => F.encodeQoi(img)),
    },
    ppm: {
      label: 'PPM',
      extension: 'ppm',
      mime: 'image/x-portable-pixmap',
      canvasMime: 'image/png',
      encode: flat((F, img) => F.encodePnm(img, { format: 'ppm' })),
    },
    pam: {
      label: 'PAM (with alpha)',
      extension: 'pam',
      mime: 'image/x-portable-arbitrarymap',
      canvasMime: 'image/png',
      encode: flat((F, img) => F.encodePnm(img, { format: 'pam' })),
    },
    pdf: {
      label: 'PDF',
      extension: 'pdf',
      mime: 'application/pdf',
      canvasMime: 'image/png',
      encode: flat((F, img, dpi, project) => F.encodePdf(img, { dpi, title: project.name })),
    },
    eps: {
      label: 'EPS',
      extension: 'eps',
      mime: 'application/postscript',
      canvasMime: 'image/png',
      encode: flat((F, img, dpi, project) => F.encodeEps(img, { dpi, title: project.name })),
    },
    'svg-traced': {
      label: 'SVG · traced vector',
      extension: 'svg',
      mime: 'image/svg+xml',
      canvasMime: 'image/png',
      encode: flat((F, img) => {
        const r = F.traceToSvg(img, { colors: 16, smoothing: 0.6 });
        extraNote = `${r.pathCount.toLocaleString()} vector paths.`;
        return r.svg;
      }),
    },
    'svg-layered': {
      label: 'SVG · layered',
      extension: 'svg',
      mime: 'image/svg+xml',
      canvasMime: 'image/png',
      layered: true,
      encode: layeredSvg,
    },
    psd: {
      label: 'PSD · layered',
      extension: 'psd',
      mime: 'image/vnd.adobe.photoshop',
      canvasMime: 'image/png',
      layered: true,
      encode: ({ Formats, project }) => layeredFile(Formats, project, 'psd'),
    },
    ora: {
      label: 'OpenRaster · layered',
      extension: 'ora',
      mime: 'image/openraster',
      canvasMime: 'image/png',
      layered: true,
      encode: ({ Formats, project }) => layeredFile(Formats, project, 'ora'),
    },
  });

  async function exportImage() {
    if (exporting) return;
    exporting = true;
    const exportButton = root.querySelector('[data-action="export-image"]');
    if (exportButton) exportButton.disabled = true;
    try {
      const format = elements.exportFormat.value;
      const extra = EXTRA_EXPORTS[format] || null;
      const mime = extra ? extra.canvasMime : Core.mimeForFormat(format);
      const cropSize = Core.outputSize(store.project);
      // Export size: a preset scale or an exact width (downscale only; never upsample).
      let exportScale = 1;
      if (elements.exportScale?.value === 'width') {
        const width = Math.round(Number(elements.exportWidth?.value));
        if (!Number.isFinite(width) || width < 1)
          throw new Error('Enter an export width in pixels.');
        exportScale = Math.min(1, width / cropSize.width);
      } else if (elements.exportScale)
        exportScale = Math.min(1, Math.max(0.01, Number(elements.exportScale.value) || 1));
      // Layered files always keep every layer at document size.
      if (extra?.layered) exportScale = 1;
      const size = {
        width: Math.max(1, Math.round(cropSize.width * exportScale)),
        height: Math.max(1, Math.round(cropSize.height * exportScale)),
      };
      const quality = elements.exportQuality
        ? Math.min(1, Math.max(0.1, Number(elements.exportQuality.value) / 100))
        : 0.92;
      const mobile =
        matchMedia('(max-width: 820px)').matches ||
        (navigator.deviceMemory && navigator.deviceMemory <= 4);
      const exportPixelLimit = mobile ? 24 * 1024 * 1024 : 36 * 1024 * 1024;
      if (size.width * size.height > exportPixelLimit)
        throw new Error(
          `Export is limited to ${mobile ? 24 : 36} megapixels on this device. Reduce the crop size.`,
        );
      if (
        format === 'svg' &&
        (size.width > Svg.MAX_SVG_DIMENSION ||
          size.height > Svg.MAX_SVG_DIMENSION ||
          size.width * size.height > Svg.MAX_SVG_PIXELS)
      ) {
        throw new Error(
          `SVG export is limited to ${Svg.MAX_SVG_DIMENSION} pixels per side and ${Svg.MAX_SVG_PIXELS.toLocaleString()} pixels.`,
        );
      }
      const missing = store.project.layers.filter(
        (layer) => layer.type === 'image' && !hasSource(layer.source.id),
      );
      if (missing.length) throw new Error('Relink every image layer before exporting.');
      const filenameBase = App.utils.safeName(store.project.name, 'alcorphoto');
      const finishExtra = async (canvas, context) => {
        const Formats = globalThis.AlcorPhotoFormats;
        if (!Formats)
          throw new Error('The file format module did not load. Reload the editor and try again.');
        const result = await extra.encode({
          Formats,
          canvas,
          context,
          size,
          quality,
          project: store.project,
        });
        const blob = result instanceof Blob ? result : new Blob([result], { type: extra.mime });
        const filename = `${filenameBase}.${extra.extension}`;
        App.utils.download(blob, filename);
        root.dispatchEvent(
          new CustomEvent('alcorphoto:saved', {
            detail: {
              filename,
              bytes: blob.size,
              kind: 'export',
              format,
              width: size.width,
              height: size.height,
            },
          }),
        );
        elements.exportReport.textContent = `${blob.size.toLocaleString()} bytes · ${extra.label}${extra.layered ? '' : ` · ${size.width}×${size.height}`}`;
        status(`${filename} is ready in your browser.${extraNote ? ` ${extraNote}` : ''}`);
        extraNote = '';
      };
      // Layered encoders render each layer and their own composite; a flat render here would be thrown away.
      if (extra?.layered) {
        await finishExtra(null, null);
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext('2d', { alpha: mime !== 'image/jpeg' });
      if (!context) throw new Error('Canvas 2D export is unavailable in this browser.');
      assertCanvasUsable(context, size);
      const renderReport = {};
      if (exportScale < 1) context.imageSmoothingQuality = 'high';
      Core.renderProject(context, store.project, resolveSource, {
        background: mime === 'image/jpeg' ? '#ffffff' : null,
        adjust: adjustHook,
        report: renderReport,
        scale: exportScale,
      });
      if (renderReport.missingMasks?.length)
        throw new Error('A layer mask is missing its pixels. Remove the mask before exporting.');
      if (extra) {
        await finishExtra(canvas, context);
        return;
      }
      if (format === 'svg') {
        const pngBlob = await canvasBlob(canvas, 'image/png');
        if (pngBlob.size > Svg.MAX_RASTER_BYTES)
          throw new Error(
            `SVG raster fallback exceeded the enforced ${Svg.MAX_RASTER_BYTES.toLocaleString()}-byte PNG limit.`,
          );
        let imageData = null;
        if (size.width * size.height <= Svg.VECTOR_MAX_PIXELS) {
          try {
            imageData = context.getImageData(0, 0, size.width, size.height);
          } catch (error) {
            imageData = null;
          }
        }
        const result = Svg.createSvgExport({
          width: size.width,
          height: size.height,
          title: store.project.name,
          pngBytes: new Uint8Array(await pngBlob.arrayBuffer()),
          imageData,
        });
        const blob = new Blob([result.text], { type: mime });
        if (blob.size !== result.bytes)
          throw new Error('SVG UTF-8 byte measurement did not match the generated download.');
        const filename = `${filenameBase}.svg`;
        App.utils.download(blob, filename);
        root.dispatchEvent(
          new CustomEvent('alcorphoto:saved', {
            detail: { filename, bytes: result.bytes, kind: 'export' },
          }),
        );
        elements.exportReport.textContent = `${result.bytes.toLocaleString()} bytes · ${result.label}`;
        status(`${filename} downloaded · ${result.bytes.toLocaleString()} bytes.`);
        return;
      }
      const blob = await canvasBlob(canvas, mime, mime === 'image/png' ? undefined : quality);
      const extension = format === 'jpeg' ? 'jpg' : format;
      const filename = `${filenameBase}.${extension}`;
      App.utils.download(blob, filename);
      root.dispatchEvent(
        new CustomEvent('alcorphoto:saved', {
          detail: {
            filename,
            bytes: blob.size,
            kind: 'export',
            width: size.width,
            height: size.height,
          },
        }),
      );
      elements.exportReport.textContent = `${blob.size.toLocaleString()} bytes · ${mime} · ${size.width}×${size.height}${mime === 'image/png' ? '' : ` · quality ${Math.round(quality * 100)}`}`;
      status(
        `${filename} is ready in your browser.${root.hasAttribute('data-alcor-local-distribution') ? '' : ' Exports are free.'}`,
      );
    } finally {
      exporting = false;
      if (exportButton) exportButton.disabled = false;
    }
  }

  root.addEventListener('click', (event) => {
    const modeButton = event.target.closest('[data-mode-target]');
    if (modeButton) return setMode(modeButton.dataset.modeTarget);
    const panelButton = event.target.closest('[data-panel-target]');
    if (panelButton) return setMobilePanel(panelButton.dataset.panelTarget);
    const layerButton = event.target.closest('[data-layer-id]');
    if (layerButton) return selectLayer(layerButton.dataset.layerId);
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    try {
      if (action === 'zoom-out') {
        setZoom(viewTransform().zoom / 1.25);
      } else if (action === 'zoom-in') {
        setZoom(viewTransform().zoom * 1.25);
      } else if (action === 'zoom-fit') {
        fitView();
      } else if (action === 'zoom-100') {
        setZoom(1);
      } else if (action === 'new-project' && newDocumentHandlers.length) {
        newDocumentHandlers.at(-1)();
      } else if (action === 'new-project') {
        runOperation('Creating project…', () => {
          if (!confirmReplacement()) {
            status('New cancelled. Current project preserved.');
            return;
          }
          installProject(Core.createProject());
          cleanMessage = 'New project · no unsaved changes';
          status('New local project created.');
        });
      } else if (action === 'save-browser') {
        runOperation('Preparing project download…', downloadProject);
      } else if (action === 'export-project')
        runOperation('Preparing project download…', downloadProject);
      else if (action === 'undo') store.undo();
      else if (action === 'redo') store.redo();
      else if (action === 'add-text') {
        replace(
          Core.addTextLayer(store.project, { text: elements.textForm.elements.text.value }),
          'Added text layer',
        );
        setMobilePanel('layer');
      } else if (action === 'add-rectangle' || action === 'add-ellipse') {
        replace(
          Core.addShapeLayer(store.project, {
            shape: action === 'add-ellipse' ? 'ellipse' : 'rectangle',
          }),
          action === 'add-ellipse' ? 'Added ellipse' : 'Added rectangle',
        );
        setMobilePanel('layer');
      } else if (action === 'duplicate-layer')
        replace(
          Core.duplicateLayer(store.project, store.project.selectedLayerId),
          'Duplicated layer',
        );
      else if (action === 'delete-layer')
        replace(Core.removeLayer(store.project, store.project.selectedLayerId), 'Deleted layer');
      else if (action === 'layer-up')
        replace(Core.moveLayer(store.project, store.project.selectedLayerId, 'up'), 'Raised layer');
      else if (action === 'layer-down')
        replace(
          Core.moveLayer(store.project, store.project.selectedLayerId, 'down'),
          'Lowered layer',
        );
      else if (action === 'toggle-layer') {
        const layer = selected();
        if (!layer) throw new Error('Select a layer first.');
        replace(
          Core.updateLayer(store.project, layer.id, { visible: !layer.visible }),
          layer.visible ? 'Hid layer' : 'Showed layer',
        );
      } else if (action === 'flip-horizontal' || action === 'flip-vertical') {
        replace(
          Core.flipLayer(
            store.project,
            store.project.selectedLayerId,
            action === 'flip-vertical' ? 'vertical' : 'horizontal',
          ),
          action === 'flip-vertical' ? 'Flipped layer vertically' : 'Flipped layer horizontally',
        );
      } else if (action === 'rotate-left' || action === 'rotate-right') {
        const layer = selected();
        if (!layer) throw new Error('Select a layer first.');
        const amount = action === 'rotate-left' ? -90 : 90;
        replace(
          Core.updateLayer(store.project, layer.id, {
            transform: { rotation: layer.transform.rotation + amount },
          }),
          action === 'rotate-left' ? 'Rotated layer left' : 'Rotated layer right',
        );
      } else if (action === 'scale-down' || action === 'scale-up') {
        const layer = selected();
        if (!layer) throw new Error('Select a layer first.');
        const factor = action === 'scale-down' ? 0.9 : 1.1;
        replace(
          Core.updateLayer(store.project, layer.id, {
            transform: {
              scaleX: layer.transform.scaleX * factor,
              scaleY: layer.transform.scaleY * factor,
            },
          }),
          action === 'scale-down' ? 'Made layer smaller' : 'Made layer larger',
        );
      } else if (action === 'reset-crop') {
        replace(
          Core.setCrop(store.project, {
            x: 0,
            y: 0,
            width: store.project.width,
            height: store.project.height,
          }),
          'Reset crop',
        );
      } else if (action === 'reset-adjustments') {
        replace(
          Core.setAdjustments(
            store.project,
            Object.fromEntries(ADJUSTMENT_NAMES.map((name) => [name, 0])),
          ),
          'Reset adjustments',
        );
      } else if (action === 'export-image') runOperation('Exporting image…', exportImage);
    } catch (error) {
      status(error.message, 'error');
    }
  });

  function syncExportOptions() {
    const lossy = ['jpeg', 'webp', 'avif'].includes(elements.exportFormat.value);
    const qualityLabel = root.querySelector('[data-export-quality]');
    if (qualityLabel) qualityLabel.hidden = !lossy;
    const widthLabel = root.querySelector('[data-export-width]');
    if (widthLabel) widthLabel.hidden = elements.exportScale?.value !== 'width';
    if (elements.exportWidth && !elements.exportWidth.value)
      elements.exportWidth.value = String(Core.outputSize(store.project).width);
    const out = root.querySelector('output[for="ap-export-quality"]');
    if (out && elements.exportQuality) out.textContent = elements.exportQuality.value;
  }
  for (const control of [elements.exportFormat, elements.exportQuality, elements.exportScale])
    control?.addEventListener('input', syncExportOptions);
  for (const control of [elements.exportFormat, elements.exportScale])
    control?.addEventListener('change', syncExportOptions);
  syncExportOptions();

  elements.name.addEventListener('change', () => {
    pendingInput = false;
    store.mutate('Renamed project', (project) => {
      project.name = elements.name.value;
    });
    showSaveState();
  });
  elements.layers.addEventListener('dblclick', (event) => {
    const layerId = event.target.closest('[data-layer-id]')?.dataset.layerId;
    const layer = store.project.layers.find((candidate) => candidate.id === layerId);
    if (layer)
      replace(
        Core.updateLayer(store.project, layer.id, { visible: !layer.visible }),
        layer.visible ? 'Hid layer' : 'Showed layer',
      );
  });
  // Font picker: system font stacks, plus fonts installed on this device where the
  // browser lets a page list them (Local Font Access). Picking one fills the CSS stack.
  const fontPreset = elements.layerForm.elements.fontPreset;
  function fontOption(value, label) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    option.style.fontFamily = value;
    return option;
  }
  if (fontPreset) {
    for (const [stack, label] of Core.FONT_STACKS || [])
      fontPreset.append(fontOption(stack, label));
    if (typeof globalThis.queryLocalFonts === 'function')
      fontPreset.append(fontOption('__local__', 'Fonts on this device…'));
    fontPreset.append(fontOption('__custom__', 'Custom (CSS stack)'));
    fontPreset.addEventListener('change', async (event) => {
      event.stopPropagation();
      let value = fontPreset.value;
      if (value === '__local__') {
        try {
          const fonts = await globalThis.queryLocalFonts();
          const families = [...new Set(fonts.map((font) => font.family))]
            .sort((a, b) => a.localeCompare(b))
            .slice(0, 400);
          fontPreset.querySelector('option[value="__local__"]')?.remove();
          const group = document.createElement('optgroup');
          group.label = 'On this device';
          for (const family of families)
            group.append(
              fontOption(`"${family.replace(/["\\]/g, '')}", system-ui, sans-serif`, family),
            );
          fontPreset.append(group);
          status(`${families.length} fonts from this device are in the font list.`);
        } catch (error) {
          status('This browser did not share its installed fonts.', 'error');
        }
        syncFontPreset(elements.layerForm.elements.fontFamily.value);
        return;
      }
      if (value === '__custom__') {
        elements.layerForm.elements.fontFamily.focus();
        return;
      }
      elements.layerForm.elements.fontFamily.value = value;
      elements.layerForm.elements.fontFamily.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  function syncFontPreset(family) {
    if (!fontPreset) return;
    const match = [...fontPreset.options].find((option) => option.value === family);
    fontPreset.value = match ? family : '__custom__';
  }
  elements.layerForm.addEventListener('change', () => {
    pendingInput = false;
    const layer = selected();
    if (!layer) return;
    const data = new FormData(elements.layerForm);
    const patch = {
      name: data.get('layerName'),
      visible: elements.layerForm.elements.visible.checked,
      opacity: Number(data.get('opacity')) / 100,
      blendMode: data.get('blendMode'),
      transform: Object.fromEntries(
        ['x', 'y', 'scaleX', 'scaleY', 'rotation'].map((name) => [name, Number(data.get(name))]),
      ),
    };
    if (layer.type === 'text')
      Object.assign(patch, {
        text: data.get('text'),
        fontSize: Number(data.get('fontSize')),
        color: data.get('color'),
        fontWeight: Number(data.get('fontWeight')),
        align: data.get('align'),
        fontFamily: data.get('fontFamily'),
        ...(elements.layerForm.elements.italic
          ? {
              italic: elements.layerForm.elements.italic.checked,
              lineHeight: Number(data.get('lineHeight')) || 1.2,
              letterSpacing: Number(data.get('letterSpacing')) || 0,
            }
          : {}),
        ...(elements.layerForm.elements.textStroke
          ? {
              stroke: data.get('textStroke'),
              strokeWidth: Number(data.get('textStrokeWidth')) || 0,
            }
          : {}),
        ...(elements.layerForm.elements.shadowColor
          ? {
              shadowColor: data.get('shadowColor'),
              shadowBlur: Number(data.get('shadowBlur')) || 0,
              shadowX: Number(data.get('shadowX')) || 0,
              shadowY: Number(data.get('shadowY')) || 0,
            }
          : {}),
      });
    if (layer.type === 'shape')
      Object.assign(patch, {
        ...(layer.shape !== 'path' && data.get('shapeKind')
          ? { shape: data.get('shapeKind') }
          : {}),
        width: Number(data.get('shapeWidth')),
        height: Number(data.get('shapeHeight')),
        fill: data.get('fill'),
        stroke: data.get('stroke'),
        strokeWidth: Number(data.get('strokeWidth')),
      });
    replace(Core.updateLayer(store.project, layer.id, patch), 'Changed layer');
    showSaveState();
  });
  elements.layerForm.addEventListener('input', (event) => {
    if (event.target.name !== 'opacity') return;
    const output = root.querySelector('[data-layer-value="opacity"]');
    if (output) output.textContent = String(event.target.value);
  });
  elements.cropForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(elements.cropForm);
    replace(
      Core.setCrop(
        store.project,
        Object.fromEntries(
          ['x', 'y', 'width', 'height'].map((name) => [name, Number(data.get(name))]),
        ),
      ),
      'Changed crop',
    );
  });
  elements.backgroundForm.addEventListener('change', (event) => {
    if (event.target.name === 'background')
      elements.backgroundForm.elements.transparent.checked = false;
    const transparent = elements.backgroundForm.elements.transparent.checked;
    replace(
      Core.setBackground(
        store.project,
        transparent ? null : elements.backgroundForm.elements.background.value,
      ),
      transparent ? 'Made canvas transparent' : 'Changed canvas background',
    );
  });
  elements.resizeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(elements.resizeForm);
    try {
      replace(
        Core.resizeCanvas(
          store.project,
          { width: Number(data.get('width')), height: Number(data.get('height')) },
          { scaleLayers: elements.resizeForm.elements.scaleLayers.checked },
        ),
        'Resized canvas',
      );
    } catch (error) {
      status(error.message, 'error');
    }
  });
  elements.adjustments.addEventListener('input', () => {
    previewAdjustments();
  });
  elements.adjustments.addEventListener('change', commitAdjustments);
  elements.adjustments.addEventListener('pointerup', commitAdjustments);
  for (const [input, handler] of [
    [elements.importFile, importImage],
    [elements.relinkFile, relinkImage],
    [elements.projectFile, openProject],
  ]) {
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;
      await runOperation(
        handler === openProject ? 'Opening project…' : 'Reading local image…',
        () => handler(file),
      );
    });
  }

  elements.canvas.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    const layer = selected();
    if (!layer || layer.type === 'adjustment') return;
    if (layer.locked) {
      status(`${layer.name} is locked. Unlock it in the Layers panel to move it.`, 'error');
      return;
    }
    drag = {
      id: layer.id,
      x: event.clientX,
      y: event.clientY,
      startX: layer.transform.x,
      startY: layer.transform.y,
      zoom: viewTransform().zoom,
    };
    elements.canvas.setPointerCapture(event.pointerId);
  });
  elements.canvas.addEventListener('pointermove', (event) => {
    if (!drag) return;
    let dx = (event.clientX - drag.x) / drag.zoom,
      dy = (event.clientY - drag.y) / drag.zoom;
    // Shift constrains the move to the dominant axis.
    if (event.shiftKey) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    let position = { x: drag.startX + dx, y: drag.startY + dy };
    const moving = store.project.layers.find((layer) => layer.id === drag.id);
    for (const snapper of moveSnappers)
      position = snapper.snap(moving, position, event) || position;
    dragProject = Core.updateLayer(store.project, drag.id, { transform: position });
    scheduleRender(dragProject);
  });
  const moveSnappers = [];
  const endDrag = () => {
    for (const snapper of moveSnappers) snapper.end?.();
    if (drag && dragProject) store.replace(dragProject, 'Moved layer');
    drag = null;
    dragProject = null;
  };
  elements.canvas.addEventListener('pointerup', endDrag);
  elements.canvas.addEventListener('pointercancel', endDrag);

  observeStore();
  const keyHandlers = [];
  document.addEventListener('keydown', (event) => {
    if (operation) return;
    if (
      /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '') ||
      event.target?.isContentEditable
    )
      return;
    // A layer drag in progress commits its own snapshot on release; don't let
    // shortcuts change the document underneath it.
    if (drag) {
      if (!['Shift', 'Alt', 'Control', 'Meta'].includes(event.key)) event.preventDefault();
      return;
    }
    for (const handler of keyHandlers) {
      if (handler(event) === true) {
        event.preventDefault();
        return;
      }
    }
    const command = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (command && (key === '+' || key === '=')) {
      event.preventDefault();
      setZoom(viewTransform().zoom * 1.25);
      return;
    }
    if (command && (key === '-' || key === '_')) {
      event.preventDefault();
      setZoom(viewTransform().zoom / 1.25);
      return;
    }
    if (command && key === '0') {
      event.preventDefault();
      fitView();
      return;
    }
    if (command && key === '1') {
      event.preventDefault();
      setZoom(1);
      return;
    }
    if (command && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) store.redo();
      else store.undo();
      return;
    }
    if (command && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      store.redo();
      return;
    }
    if (command && event.key.toLowerCase() === 's') {
      event.preventDefault();
      runOperation('Preparing project download…', downloadProject);
      return;
    }
    if (command && event.key.toLowerCase() === 'd' && selected()) {
      event.preventDefault();
      replace(
        Core.duplicateLayer(store.project, store.project.selectedLayerId),
        'Duplicated layer',
      );
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selected()) {
      event.preventDefault();
      replace(Core.removeLayer(store.project, store.project.selectedLayerId), 'Deleted layer');
    }
  });

  // Extension API: later modules (tools, panels, recovery) attach here without
  // reaching into this closure. Registered before the first render.
  const editorApi = Object.freeze({
    root,
    elements,
    get store() {
      return store;
    },
    get operation() {
      return operation;
    },
    onStore(listener) {
      storeListeners.push(listener);
      listener(store);
    },
    status,
    runOperation,
    renderAll,
    requestRender: () => scheduleRender(),
    previewProject: (project, dirty) => scheduleRender(project, dirty),
    selected: () => selected(),
    resolveSource,
    resolveStoredSource,
    hasSource,
    hasDecodedSource: (sourceId) => sources.has(sourceId),
    addSourceResolver(resolver) {
      sourceResolvers.push(resolver);
    },
    addSourceOverride(override) {
      sourceOverrides.push(override);
    },
    addBundlePreparer(prepare) {
      bundlePreparers.push(prepare);
    },
    prepareBundle,
    addKeyHandler(handler) {
      keyHandlers.push(handler);
    },
    addMoveSnapper(snapper) {
      moveSnappers.push(snapper);
    },
    addNewDocumentHandler(handler) {
      newDocumentHandlers.push(handler);
    },
    newDocument(options = {}) {
      if (!confirmReplacement()) {
        status('New cancelled. Current project preserved.');
        return false;
      }
      installProject(Core.createProject(options));
      cleanMessage = 'New project · no unsaved changes';
      status(`New ${options.width || 1920} × ${options.height || 1080} document created.`);
      return true;
    },
    importFile: (file) => runOperation('Reading local image…', () => importImage(file)),
    openProjectFile: (file) => runOperation('Opening project…', () => openProject(file)),
    installProject: (project, nextSources, nextFiles, nextBudget) =>
      installProject(project, nextSources, nextFiles, nextBudget),
    decodeInto: (file, targetSources, targetBudget, targetFiles, preferredId) =>
      decodeImageInto(file, targetSources, targetBudget, targetFiles, preferredId),
    createSourceBudget: () => newSourceBudget(),
    markSaved(message) {
      savedContent = projectContent();
      cleanMessage = message;
      showSaveState();
    },
    markUnsaved(message) {
      savedContent = null;
      if (message) status(message);
      showSaveState();
    },
    hasUnsavedChanges,
    confirmReplacement,
    adjust: adjustHook,
    view: Object.freeze({
      transform: () => viewTransform(),
      clientToProject,
      projectToClient,
      setZoom,
      panBy,
      fit: fitView,
      actualPixels: () => setZoom(1),
      get zoom() {
        return viewTransform().zoom;
      },
      get ready() {
        return !observesViewport || Boolean(viewportBox);
      },
      get paints() {
        return { ...paints };
      },
    }),
  });
  globalThis.AlcorPhotoEditor = editorApi;
  // Extensions install one per task so no single startup task blocks input for long.
  const pendingExtensions = (globalThis.AlcorPhotoExtensions || []).slice();
  let extensionsInstalled = false;
  const installNextExtension = () => {
    const extension = pendingExtensions.shift();
    if (!extension) {
      extensionsInstalled = true;
      maybeReveal();
      return;
    }
    try {
      extension(editorApi);
    } catch (error) {
      status(`An editor module failed to start: ${error.message}`, 'error');
    }
    setTimeout(installNextExtension, 0);
  };

  setMode('essentials');
  setMobilePanel('layers');
  renderAll();
  showSaveState();
  status('Ready · your images stay in this browser.');

  // The editor builds hidden behind a lightweight skeleton; it is revealed once,
  // after the shared shell and phone frame have finished rearranging the page,
  // so the browser lays the full editor out a single time.
  let documentParsed = document.readyState !== 'loading';
  function maybeReveal() {
    if (documentParsed && extensionsInstalled && !root.dataset.ready) {
      root.dataset.ready = 'true';
      root.dispatchEvent(new CustomEvent('alcorphoto:ready', { detail: editorApi }));
    }
  }
  if (!documentParsed)
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        documentParsed = true;
        maybeReveal();
      },
      { once: true },
    );
  setTimeout(installNextExtension, 0);
})();
