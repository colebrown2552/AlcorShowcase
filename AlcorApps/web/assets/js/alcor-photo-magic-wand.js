/**
 * alcor-photo-magic-wand.js: AlcorPhoto magic wand.
 *
 * Colour-similarity selection tool (flood fill with a tolerance).
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.AlcorPhotoMagicWand = api;
    api.install(root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_ANALYSIS_DIMENSION = 512;
  const MAX_ANALYSIS_PIXELS = 512 * 512;
  const MAX_POLYGON_POINTS = 64;
  const MAX_FIDELITY_ERROR_RATIO = 0.02;
  const DEFAULT_TOLERANCE = 32;
  const clamp = (v, min, max) =>
    Math.min(max, Math.max(min, Number.isFinite(Number(v)) ? Number(v) : min));
  const key = (x, y) => `${x},${y}`;

  function projectPointToLayerPoint(layer, point) {
    const transform = layer?.transform || {};
    const angle = (-Number(transform.rotation || 0) * Math.PI) / 180;
    const dx = Number(point?.x || 0) - Number(transform.x || 0);
    const dy = Number(point?.y || 0) - Number(transform.y || 0);
    const cos = Math.cos(angle),
      sin = Math.sin(angle);
    const scaleX = Number(transform.scaleX || 1) || 1,
      scaleY = Number(transform.scaleY || 1) || 1;
    return { x: (dx * cos - dy * sin) / scaleX, y: (dx * sin + dy * cos) / scaleY };
  }

  function colorMatch(data, index, seed, tolerance) {
    const base = index * 4;
    return (
      Math.max(
        Math.abs(data[base] - seed[0]),
        Math.abs(data[base + 1] - seed[1]),
        Math.abs(data[base + 2] - seed[2]),
        Math.abs(data[base + 3] - seed[3]),
      ) <= tolerance
    );
  }

  function floodFillRegion(imageData, width, height, seedX, seedY, tolerance = DEFAULT_TOLERANCE) {
    width = Math.floor(width);
    height = Math.floor(height);
    if (!imageData?.data || width < 1 || height < 1 || width * height > MAX_ANALYSIS_PIXELS)
      throw new Error('Magic Wand analysis exceeds its bounded pixel budget.');
    seedX = Math.floor(seedX);
    seedY = Math.floor(seedY);
    if (seedX < 0 || seedY < 0 || seedX >= width || seedY >= height)
      throw new Error('Click inside the selected image layer.');
    tolerance = clamp(tolerance, 0, 255);
    const seedIndex = seedY * width + seedX,
      seedBase = seedIndex * 4;
    const seed = [
      imageData.data[seedBase],
      imageData.data[seedBase + 1],
      imageData.data[seedBase + 2],
      imageData.data[seedBase + 3],
    ];
    const selected = new Uint8Array(width * height),
      queued = new Uint8Array(width * height),
      stack = [seedIndex];
    queued[seedIndex] = 1;
    let count = 0;
    while (stack.length) {
      const index = stack.pop();
      if (!colorMatch(imageData.data, index, seed, tolerance)) continue;
      selected[index] = 1;
      count += 1;
      const x = index % width,
        y = Math.floor(index / width);
      const neighbors = [];
      if (x > 0) neighbors.push(index - 1);
      if (x + 1 < width) neighbors.push(index + 1);
      if (y > 0) neighbors.push(index - width);
      if (y + 1 < height) neighbors.push(index + width);
      for (const next of neighbors)
        if (!queued[next]) {
          queued[next] = 1;
          stack.push(next);
        }
    }
    if (count < 2)
      throw new Error(
        'Magic Wand found only one matching pixel. Increase Tolerance or click a larger color region.',
      );
    return { selected, count, width, height };
  }

  function polygonArea(points) {
    let sum = 0;
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i],
        b = points[(i + 1) % points.length];
      sum += a.x * b.y - b.x * a.y;
    }
    return Math.abs(sum) / 2;
  }

  function hasInteriorHole(region) {
    const { selected, width, height } = region;
    const outside = new Uint8Array(width * height);
    const stack = [];
    const push = (x, y) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const index = y * width + x;
      if (selected[index] || outside[index]) return;
      outside[index] = 1;
      stack.push(index);
    };
    for (let x = 0; x < width; x += 1) {
      push(x, 0);
      push(x, height - 1);
    }
    for (let y = 1; y + 1 < height; y += 1) {
      push(0, y);
      push(width - 1, y);
    }
    while (stack.length) {
      const index = stack.pop(),
        x = index % width,
        y = Math.floor(index / width);
      push(x - 1, y);
      push(x + 1, y);
      push(x, y - 1);
      push(x, y + 1);
    }
    for (let index = 0; index < selected.length; index += 1)
      if (!selected[index] && !outside[index]) return true;
    return false;
  }

  function boundaryLoops(region) {
    const { selected, width, height } = region;
    const edges = [];
    const inside = (x, y) => x >= 0 && y >= 0 && x < width && y < height && selected[y * width + x];
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        if (!inside(x, y)) continue;
        if (!inside(x, y - 1))
          edges.push([
            { x, y },
            { x: x + 1, y },
          ]);
        if (!inside(x + 1, y))
          edges.push([
            { x: x + 1, y },
            { x: x + 1, y: y + 1 },
          ]);
        if (!inside(x, y + 1))
          edges.push([
            { x: x + 1, y: y + 1 },
            { x, y: y + 1 },
          ]);
        if (!inside(x - 1, y))
          edges.push([
            { x, y: y + 1 },
            { x, y },
          ]);
      }
    const byStart = new Map();
    edges.forEach((edge, index) => {
      const k = key(edge[0].x, edge[0].y);
      if (!byStart.has(k)) byStart.set(k, []);
      byStart.get(k).push(index);
    });
    const used = new Uint8Array(edges.length),
      loops = [];
    for (let start = 0; start < edges.length; start += 1) {
      if (used[start]) continue;
      const loop = [],
        first = edges[start][0];
      let current = start,
        guard = 0;
      while (current != null && !used[current] && guard++ <= edges.length + 1) {
        used[current] = 1;
        const [a, b] = edges[current];
        loop.push(a);
        if (b.x === first.x && b.y === first.y) break;
        current = (byStart.get(key(b.x, b.y)) || []).find((index) => !used[index]);
      }
      if (loop.length >= 3) loops.push(loop);
    }
    return loops;
  }

  function simplifyLoop(points, maxPoints = MAX_POLYGON_POINTS) {
    const compact = [];
    for (let i = 0; i < points.length; i += 1) {
      const prev = points[(i - 1 + points.length) % points.length],
        cur = points[i],
        next = points[(i + 1) % points.length];
      const cross = (cur.x - prev.x) * (next.y - cur.y) - (cur.y - prev.y) * (next.x - cur.x);
      if (Math.abs(cross) > 1e-9) compact.push(cur);
    }
    if (compact.length <= maxPoints) return compact;
    return Array.from(
      { length: maxPoints },
      (_, i) => compact[Math.floor((i * compact.length) / maxPoints)],
    );
  }

  function pointInPolygon(points, x, y) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
      const a = points[i],
        b = points[j];
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x)
        inside = !inside;
    }
    return inside;
  }

  function compareRegionToPolygon(region, polygon) {
    const width = Math.floor(region?.width || 0),
      height = Math.floor(region?.height || 0),
      selected = region?.selected;
    if (!selected || width < 1 || height < 1 || selected.length !== width * height)
      throw new Error('Magic Wand fidelity comparison requires a valid bounded region.');
    if (!Array.isArray(polygon) || polygon.length < 3)
      throw new Error('Magic Wand fidelity comparison requires a valid polygon.');
    let selectedCount = 0,
      polygonCount = 0,
      falsePositive = 0,
      falseNegative = 0;
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        const actual = Boolean(selected[y * width + x]);
        const predicted = pointInPolygon(polygon, x + 0.5, y + 0.5);
        if (actual) selectedCount += 1;
        if (predicted) polygonCount += 1;
        if (predicted && !actual) falsePositive += 1;
        if (actual && !predicted) falseNegative += 1;
      }
    const denominator = Math.max(1, selectedCount);
    return {
      selectedCount,
      polygonCount,
      falsePositive,
      falseNegative,
      falsePositiveRatio: falsePositive / denominator,
      falseNegativeRatio: falseNegative / denominator,
    };
  }

  function assertRegionPolygonFidelity(region, polygon, maxErrorRatio = MAX_FIDELITY_ERROR_RATIO) {
    maxErrorRatio = clamp(maxErrorRatio, 0, 1);
    const result = compareRegionToPolygon(region, polygon);
    if (result.falsePositiveRatio > maxErrorRatio || result.falseNegativeRatio > maxErrorRatio) {
      throw new Error(
        `Magic Wand contour is too detailed for the bounded polygon model (${(result.falsePositiveRatio * 100).toFixed(1)}% false-positive, ${(result.falseNegativeRatio * 100).toFixed(1)}% false-negative coverage). Try a tighter Tolerance or another seed point.`,
      );
    }
    return result;
  }

  function regionToPolygon(region, maxPoints = MAX_POLYGON_POINTS) {
    if (hasInteriorHole(region))
      throw new Error(
        'This Magic Wand region contains holes or disconnected boundaries that cannot be represented safely yet. Try a tighter Tolerance or another seed point.',
      );
    const loops = boundaryLoops(region).sort((a, b) => polygonArea(b) - polygonArea(a));
    if (loops.length !== 1)
      throw new Error(
        'This Magic Wand region contains holes or disconnected boundaries that cannot be represented safely yet. Try a tighter Tolerance or another seed point.',
      );
    const polygon = simplifyLoop(loops[0], maxPoints);
    if (polygon.length < 3 || polygonArea(polygon) < 1)
      throw new Error('Magic Wand produced a degenerate selection.');
    assertRegionPolygonFidelity(region, polygon);
    return polygon;
  }

  function analyzeSource(root, source, layer, projectPoint, tolerance) {
    if (!source || !layer?.source)
      throw new Error(
        'Wait for the local preview to render or relink the selected image layer before using Magic Wand.',
      );
    const sourceWidth = Number(layer.source.width),
      sourceHeight = Number(layer.source.height);
    const scale = Math.min(
      1,
      MAX_ANALYSIS_DIMENSION / sourceWidth,
      MAX_ANALYSIS_DIMENSION / sourceHeight,
      Math.sqrt(MAX_ANALYSIS_PIXELS / (sourceWidth * sourceHeight)),
    );
    const width = Math.max(1, Math.round(sourceWidth * scale)),
      height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = root.document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Magic Wand requires Canvas 2D pixel access.');
    context.drawImage(source, 0, 0, width, height);
    const imageData = context.getImageData(0, 0, width, height);
    const local = projectPointToLayerPoint(layer, projectPoint);
    const seedX = ((local.x + sourceWidth / 2) * width) / sourceWidth,
      seedY = ((local.y + sourceHeight / 2) * height) / sourceHeight;
    const region = floodFillRegion(imageData, width, height, seedX, seedY, tolerance);
    const polygon = regionToPolygon(region).map((point) => ({
      x: (point.x * sourceWidth) / width - sourceWidth / 2,
      y: (point.y * sourceHeight) / height - sourceHeight / 2,
    }));
    return { polygon, matchedPixels: region.count, analysisPixels: width * height, width, height };
  }

  function applySelection(Core, MaskApi, project, layerId, polygon, operation, feather) {
    const layer = project?.layers?.find(
      (candidate) => candidate.id === layerId && candidate.type === 'image',
    );
    if (!layer) throw new Error('Select an image layer before using Magic Wand.');
    const mask = MaskApi.normalizeMask(
      { shape: 'polygon', points: polygon, feather: clamp(feather, 0, 128) },
      layer,
    );
    if (!mask)
      throw new Error('Magic Wand selection could not be represented as a bounded polygon mask.');
    const combine = ['add', 'subtract', 'intersect'].includes(operation) ? operation : 'new';
    return combine === 'new' || !layer.mask
      ? Core.setLayerMask(project, layerId, mask)
      : Core.composeLayerMask(project, layerId, mask, combine);
  }

  function decorateCoreForSourceAccess(base, cache) {
    const core = Object.create(base);
    Object.defineProperty(core, 'renderProject', {
      value(context, project, resolveSource, options = {}) {
        return base.renderProject(
          context,
          project,
          (id) => {
            const source = resolveSource(id);
            if (source) cache.set(id, source);
            return source;
          },
          options,
        );
      },
    });
    return core;
  }

  function controller(root, Core, MaskApi, sourceCache) {
    const document = root.document,
      editor = document?.querySelector?.('[data-alcor-photo-editor]');
    const canvas = editor?.querySelector?.('#ap-canvas'),
      toolbar = editor?.querySelector?.('.ap-mask-tools');
    if (!editor || !canvas || !toolbar) return { attachStore() {} };
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.apMaskMagicWand = 'true';
    button.setAttribute('aria-pressed', 'false');
    button.textContent = 'Magic Wand';
    const controls = document.createElement('label');
    controls.className = 'ap-mask-magic-wand-controls';
    controls.hidden = true;
    controls.innerHTML =
      'Tolerance <input type="range" min="0" max="255" step="1" value="32" data-ap-magic-tolerance><output data-ap-magic-tolerance-value>32</output> · Contiguous';
    const compose = toolbar.querySelector('.ap-mask-compose');
    toolbar.insertBefore(button, compose || null);
    toolbar.insertBefore(controls, compose || null);
    const toleranceInput = controls.querySelector('[data-ap-magic-tolerance]'),
      toleranceValue = controls.querySelector('[data-ap-magic-tolerance-value]');
    const featherInput = toolbar.querySelector('[data-ap-mask-feather]'),
      status = editor.querySelector('#ap-status');
    let store = null,
      active = false;
    const message = (text, level = 'ok') => {
      if (status) {
        status.textContent = String(text).slice(0, 220);
        status.dataset.level = level;
      }
    };
    const selectedImage = () =>
      store?.project?.layers?.find(
        (layer) => layer.id === store.project.selectedLayerId && layer.type === 'image',
      ) || null;
    const operation = () =>
      toolbar.querySelector('[data-ap-mask-combine][aria-pressed="true"]')?.dataset
        ?.apMaskCombine || 'new';
    const render = () => {
      const layer = selectedImage();
      if (!layer) active = false;
      button.disabled = !layer;
      button.setAttribute('aria-pressed', String(active));
      controls.hidden = !active;
      canvas.dataset.maskMagicWand = active ? 'true' : '';
    };
    function deactivateOthers() {
      const selection = toolbar.querySelector('[data-ap-mask][aria-pressed="true"]');
      if (selection) selection.click();
      const brush = toolbar.querySelector('[data-ap-mask-brush][aria-pressed="true"]');
      if (brush) brush.click();
    }
    button.addEventListener('click', () => {
      if (!selectedImage()) return;
      active = !active;
      if (active) {
        deactivateOthers();
        message('Magic Wand active. Click a contiguous color region on the selected image layer.');
      }
      render();
    });
    toleranceInput.addEventListener('input', () => {
      toleranceValue.value = toleranceInput.value;
      toleranceValue.textContent = toleranceInput.value;
    });
    canvas.addEventListener(
      'pointerdown',
      (event) => {
        if (!active || !store || !event.isPrimary || event.button !== 0) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const layer = selectedImage();
        if (!layer) return render();
        try {
          const rect = canvas.getBoundingClientRect(),
            crop = store.project.crop,
            editorView = root.AlcorPhotoEditor?.view;
          const point = editorView
            ? editorView.clientToProject(event.clientX, event.clientY)
            : {
                x: crop.x + ((event.clientX - rect.left) * crop.width) / rect.width,
                y: crop.y + ((event.clientY - rect.top) * crop.height) / rect.height,
              };
          const result = analyzeSource(
            root,
            sourceCache.get(layer.source.id),
            layer,
            point,
            Number(toleranceInput.value),
          );
          const op = operation();
          const next = applySelection(
            Core,
            MaskApi,
            store.project,
            layer.id,
            result.polygon,
            op,
            Number(featherInput?.value || 0),
          );
          if (
            !store.replace(
              next,
              op === 'new' ? 'Applied Magic Wand mask' : `${op} Magic Wand selection`,
            )
          )
            throw new Error('Magic Wand did not change the current mask.');
          message(
            `Magic Wand selected ${result.matchedPixels.toLocaleString()} contiguous analysis pixels with tolerance ${toleranceInput.value}. Undo restores the prior mask.`,
          );
        } catch (error) {
          message(error.message, 'error');
        }
      },
      true,
    );
    document.addEventListener('keydown', (event) => {
      if (active && event.key === 'Escape') {
        active = false;
        render();
        message('Magic Wand cancelled.');
      }
    });
    return {
      attachStore(value) {
        store = value;
        if (store?.on) store.on('change', render);
        render();
      },
    };
  }

  function install(root = globalThis) {
    if (!root || root.__alcorPhotoMagicWandInstalled) return false;
    if (
      !root.AlcorPhotoMask ||
      !root.AlcorPhotoCore ||
      !root.AlcorApp ||
      !root.document?.querySelector?.('[data-alcor-photo-editor]')
    )
      return false;
    const sourceCache = new Map(),
      Core = decorateCoreForSourceAccess(root.AlcorPhotoCore, sourceCache);
    const ui = controller(root, Core, root.AlcorPhotoMask, sourceCache),
      baseApp = root.AlcorApp,
      App = Object.create(baseApp);
    Object.defineProperty(App, 'createProjectStore', {
      value(options) {
        const store = baseApp.createProjectStore(options);
        ui.attachStore(store);
        return store;
      },
    });
    root.AlcorPhotoCore = Core;
    root.AlcorApp = App;
    root.__alcorPhotoMagicWandInstalled = true;
    return true;
  }

  return Object.freeze({
    MAX_ANALYSIS_DIMENSION,
    MAX_ANALYSIS_PIXELS,
    MAX_POLYGON_POINTS,
    MAX_FIDELITY_ERROR_RATIO,
    DEFAULT_TOLERANCE,
    projectPointToLayerPoint,
    floodFillRegion,
    hasInteriorHole,
    boundaryLoops,
    simplifyLoop,
    pointInPolygon,
    compareRegionToPolygon,
    assertRegionPolygonFidelity,
    regionToPolygon,
    applySelection,
    decorateCoreForSourceAccess,
    install,
  });
});
