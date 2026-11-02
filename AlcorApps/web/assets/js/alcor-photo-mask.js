/**
 * alcor-photo-mask.js: AlcorPhoto layer masks.
 *
 * Creates, edits and applies non-destructive layer masks.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.AlcorPhotoMask = api;
    api.install(root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const clone = (value) =>
    typeof structuredClone === 'function'
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));
  const number = (value, fallback = 0) =>
    Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (value, min, max, fallback = min) =>
    Math.min(max, Math.max(min, number(value, fallback)));
  const MAX_FEATHER = 128;
  const MAX_POLYGON_POINTS = 64;
  const MAX_COMPOSITE_COMPONENTS = 16;
  const COMBINE_OPERATIONS = new Set(['add', 'subtract', 'intersect']);

  function polygonArea(points) {
    let sum = 0;
    for (let index = 0; index < points.length; index += 1) {
      const current = points[index];
      const next = points[(index + 1) % points.length];
      sum += current.x * next.y - next.x * current.y;
    }
    return Math.abs(sum) / 2;
  }

  function normalizePolygonPoints(points, sourceWidth, sourceHeight) {
    if (!Array.isArray(points)) return null;
    const minX = -sourceWidth / 2;
    const minY = -sourceHeight / 2;
    const maxX = sourceWidth / 2;
    const maxY = sourceHeight / 2;
    const cleaned = [];
    for (const raw of points.slice(0, 512)) {
      if (!raw || !Number.isFinite(Number(raw.x)) || !Number.isFinite(Number(raw.y))) continue;
      const point = {
        x: clamp(raw.x, minX, maxX, minX),
        y: clamp(raw.y, minY, maxY, minY),
      };
      const previous = cleaned[cleaned.length - 1];
      if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 0.25) continue;
      cleaned.push(point);
    }
    if (cleaned.length > 2) {
      const first = cleaned[0];
      const last = cleaned[cleaned.length - 1];
      if (Math.hypot(first.x - last.x, first.y - last.y) < 0.25) cleaned.pop();
    }
    if (cleaned.length < 3) return null;
    let normalized = cleaned;
    if (cleaned.length > MAX_POLYGON_POINTS) {
      normalized = Array.from({ length: MAX_POLYGON_POINTS }, (_, index) => {
        const sourceIndex = Math.round((index * (cleaned.length - 1)) / (MAX_POLYGON_POINTS - 1));
        return cleaned[sourceIndex];
      });
    }
    if (normalized.length < 3 || polygonArea(normalized) < 1) return null;
    return Object.freeze(normalized.map((point) => Object.freeze({ x: point.x, y: point.y })));
  }

  function sourceDimensions(layer) {
    if (!layer || layer.type !== 'image' || !layer.source) return null;
    const width = Number(layer.source.width);
    const height = Number(layer.source.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
    return { width, height };
  }

  function normalizePrimitiveMask(mask, layer) {
    if (!mask) return null;
    const source = sourceDimensions(layer);
    if (!source) return null;
    const sourceWidth = source.width;
    const sourceHeight = source.height;
    if (mask.shape === 'polygon') {
      const points = normalizePolygonPoints(mask.points, sourceWidth, sourceHeight);
      if (!points) return null;
      const xs = points.map((point) => point.x);
      const ys = points.map((point) => point.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      const width = Math.max(...xs) - x;
      const height = Math.max(...ys) - y;
      if (width < 1 || height < 1) return null;
      const feather = clamp(mask.feather, 0, Math.min(MAX_FEATHER, width, height), 0);
      return Object.freeze({ shape: 'polygon', x, y, width, height, points, feather });
    }
    const minX = -sourceWidth / 2;
    const minY = -sourceHeight / 2;
    const x = clamp(mask.x, minX, sourceWidth / 2 - 1, minX);
    const y = clamp(mask.y, minY, sourceHeight / 2 - 1, minY);
    const width = clamp(mask.width, 1, sourceWidth / 2 - x, sourceWidth / 2 - x);
    const height = clamp(mask.height, 1, sourceHeight / 2 - y, sourceHeight / 2 - y);
    const feather = clamp(mask.feather, 0, Math.min(MAX_FEATHER, width, height), 0);
    return Object.freeze({
      shape: mask.shape === 'ellipse' ? 'ellipse' : 'rectangle',
      x,
      y,
      width,
      height,
      feather,
    });
  }

  function boundsOf(mask) {
    return { x: mask.x, y: mask.y, width: mask.width, height: mask.height };
  }

  function unionBounds(a, b) {
    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const right = Math.max(a.x + a.width, b.x + b.width);
    const bottom = Math.max(a.y + a.height, b.y + b.height);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function intersectBounds(a, b) {
    const left = Math.max(a.x, b.x);
    const top = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    if (right - left < 1 || bottom - top < 1) return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function primitiveForComponent(mask) {
    if (!mask || mask.shape === 'composite') return null;
    const primitive = clone(mask);
    primitive.feather = 0;
    return primitive;
  }

  function normalizeCompositeMask(mask, layer) {
    if (!Array.isArray(mask?.components) || mask.components.length < 1) return null;
    const components = [];
    let bounds = null;
    for (const raw of mask.components.slice(0, MAX_COMPOSITE_COMPONENTS)) {
      if (!raw) continue;
      const primitive = normalizePrimitiveMask({ ...(raw.mask || raw), feather: 0 }, layer);
      if (!primitive) continue;
      const operation =
        components.length === 0
          ? 'base'
          : COMBINE_OPERATIONS.has(raw.operation)
            ? raw.operation
            : 'add';
      if (!bounds) bounds = boundsOf(primitive);
      else if (operation === 'add') bounds = unionBounds(bounds, boundsOf(primitive));
      else if (operation === 'intersect') bounds = intersectBounds(bounds, boundsOf(primitive));
      if (!bounds) return null;
      components.push(
        Object.freeze({ operation, mask: Object.freeze(primitiveForComponent(primitive)) }),
      );
    }
    if (!components.length || !bounds || bounds.width < 1 || bounds.height < 1) return null;
    const feather = clamp(mask.feather, 0, Math.min(MAX_FEATHER, bounds.width, bounds.height), 0);
    return Object.freeze({
      shape: 'composite',
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      components: Object.freeze(components),
      feather,
    });
  }

  function normalizeMask(mask, layer) {
    if (!mask) return null;
    if (mask.shape === 'composite') return normalizeCompositeMask(mask, layer);
    return normalizePrimitiveMask(mask, layer);
  }

  function composeMasks(existingMask, incomingMask, operation, layer) {
    const incoming = normalizeMask(incomingMask, layer);
    if (!incoming || incoming.shape === 'composite')
      throw new Error('Create one rectangle, ellipse, or lasso selection to combine.');
    const normalizedOperation =
      operation === 'new' ? 'new' : COMBINE_OPERATIONS.has(operation) ? operation : 'new';
    const existing = normalizeMask(existingMask, layer);
    if (!existing || normalizedOperation === 'new') return incoming;

    const components =
      existing.shape === 'composite'
        ? existing.components.map((component) => ({
            operation: component.operation,
            mask: clone(component.mask),
          }))
        : [{ operation: 'base', mask: primitiveForComponent(existing) }];
    if (components.length >= MAX_COMPOSITE_COMPONENTS) {
      throw new Error(
        `Selection composition supports up to ${MAX_COMPOSITE_COMPONENTS} regions. Start a new selection to continue.`,
      );
    }
    components.push({ operation: normalizedOperation, mask: primitiveForComponent(incoming) });
    const combined = normalizeCompositeMask(
      {
        shape: 'composite',
        components,
        feather: existing.feather,
      },
      layer,
    );
    if (!combined) {
      if (normalizedOperation === 'intersect')
        throw new Error('The new selection does not overlap the existing mask.');
      throw new Error('The selection combination could not be applied.');
    }
    return combined;
  }

  function attachMasks(normalized, source) {
    const inputLayers = new Map(
      (source?.layers || []).map((layer) => [String(layer?.id || ''), layer]),
    );
    const next = clone(normalized);
    next.layers = next.layers.map((layer) => {
      const original = inputLayers.get(layer.id);
      return { ...layer, mask: normalizeMask(original?.mask, layer) };
    });
    return next;
  }

  function preserveMasks(before, after) {
    const masks = new Map(
      (before?.layers || [])
        .filter((layer) => layer?.mask)
        .map((layer) => [layer.id, clone(layer.mask)]),
    );
    const next = clone(after);
    next.layers = (next.layers || []).map((layer) =>
      masks.has(layer.id) ? { ...layer, mask: clone(masks.get(layer.id)) } : layer,
    );
    return next;
  }

  function inverseProjectPoint(layer, point) {
    const transform = layer.transform || {};
    const angle = (-number(transform.rotation) * Math.PI) / 180;
    const dx = number(point.x) - number(transform.x);
    const dy = number(point.y) - number(transform.y);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const rotatedX = dx * cos - dy * sin;
    const rotatedY = dx * sin + dy * cos;
    const scaleX = number(transform.scaleX, 1) || 1;
    const scaleY = number(transform.scaleY, 1) || 1;
    return { x: rotatedX / scaleX, y: rotatedY / scaleY };
  }

  function layerMaskBoundsFromProjectRect(layer, rect, shape = 'rectangle') {
    if (!layer || layer.type !== 'image')
      throw new Error('Select an image layer before creating a mask.');
    const x = number(rect?.x);
    const y = number(rect?.y);
    const width = Math.abs(number(rect?.width));
    const height = Math.abs(number(rect?.height));
    if (width < 1 || height < 1) throw new Error('Drag a larger selection before creating a mask.');
    const corners = [
      { x, y },
      { x: x + width, y },
      { x, y: y + height },
      { x: x + width, y: y + height },
    ].map((point) => inverseProjectPoint(layer, point));
    const xs = corners.map((point) => point.x);
    const ys = corners.map((point) => point.y);
    return normalizeMask(
      {
        shape,
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
      },
      layer,
    );
  }

  function layerMaskFromProjectPolygon(layer, points) {
    if (!layer || layer.type !== 'image')
      throw new Error('Select an image layer before creating a mask.');
    if (!Array.isArray(points) || points.length < 3)
      throw new Error('Draw a larger lasso before creating a mask.');
    const mask = normalizeMask(
      {
        shape: 'polygon',
        points: points.map((point) => inverseProjectPoint(layer, point)),
      },
      layer,
    );
    if (!mask) throw new Error('Draw a larger lasso before creating a mask.');
    return mask;
  }

  function signedDistanceToPolygon(points, pointX, pointY) {
    let inside = false;
    let minDistanceSquared = Infinity;
    for (
      let index = 0, previous = points.length - 1;
      index < points.length;
      previous = index, index += 1
    ) {
      const a = points[previous];
      const b = points[index];
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const lengthSquared = vx * vx + vy * vy;
      const projection =
        lengthSquared > 0
          ? clamp(((pointX - a.x) * vx + (pointY - a.y) * vy) / lengthSquared, 0, 1, 0)
          : 0;
      const closestX = a.x + vx * projection;
      const closestY = a.y + vy * projection;
      const dx = pointX - closestX;
      const dy = pointY - closestY;
      minDistanceSquared = Math.min(minDistanceSquared, dx * dx + dy * dy);
      const crosses =
        a.y > pointY !== b.y > pointY &&
        pointX < ((b.x - a.x) * (pointY - a.y)) / (b.y - a.y || Number.EPSILON) + a.x;
      if (crosses) inside = !inside;
    }
    const distance = Math.sqrt(minDistanceSquared);
    return inside ? -distance : distance;
  }

  function signedDistanceToPrimitive(mask, pointX, pointY) {
    if (mask.shape === 'polygon' && Array.isArray(mask.points) && mask.points.length >= 3) {
      return signedDistanceToPolygon(mask.points, pointX, pointY);
    }
    const centerX = mask.x + mask.width / 2;
    const centerY = mask.y + mask.height / 2;
    if (mask.shape === 'ellipse') {
      const radiusX = Math.max(mask.width / 2, 0.5);
      const radiusY = Math.max(mask.height / 2, 0.5);
      const normalizedRadius = Math.hypot(
        (pointX - centerX) / radiusX,
        (pointY - centerY) / radiusY,
      );
      return (normalizedRadius - 1) * Math.min(radiusX, radiusY);
    }
    const qx = Math.abs(pointX - centerX) - mask.width / 2;
    const qy = Math.abs(pointY - centerY) - mask.height / 2;
    const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
    return outside + Math.min(Math.max(qx, qy), 0);
  }

  function signedDistanceToMask(mask, pointX, pointY) {
    if (!mask) return -Infinity;
    if (mask.shape !== 'composite') return signedDistanceToPrimitive(mask, pointX, pointY);
    const components = Array.isArray(mask.components) ? mask.components : [];
    if (!components.length) return Infinity;
    let distance = signedDistanceToPrimitive(components[0].mask, pointX, pointY);
    for (const component of components.slice(1)) {
      const next = signedDistanceToPrimitive(component.mask, pointX, pointY);
      if (component.operation === 'subtract') distance = Math.max(distance, -next);
      else if (component.operation === 'intersect') distance = Math.max(distance, next);
      else distance = Math.min(distance, next);
    }
    return distance;
  }

  function maskAlphaAtPoint(mask, pointX, pointY) {
    if (!mask) return 1;
    const distance = signedDistanceToMask(mask, pointX, pointY);
    const feather = number(mask.feather);
    if (feather <= 0) return distance <= 0 ? 1 : 0;
    const t = clamp(0.5 - distance / feather, 0, 1, 0);
    return t * t * (3 - 2 * t);
  }

  function createCanvas(root, width, height) {
    let canvas = null;
    if (typeof root?.OffscreenCanvas === 'function')
      canvas = new root.OffscreenCanvas(width, height);
    else if (root?.document?.createElement) {
      canvas = root.document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
    }
    if (!canvas) throw new Error('Layer-mask rendering is unavailable in this browser.');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  function createAlphaCanvas(root, layer) {
    const mask = layer.mask;
    const width = Number(layer.source.width);
    const height = Number(layer.source.height);
    const canvas = createCanvas(root, width, height);
    const context = canvas.getContext('2d', { alpha: true });
    if (
      !context ||
      typeof context.createImageData !== 'function' ||
      typeof context.putImageData !== 'function'
    ) {
      throw new Error('Composed or feathered layer masks require Canvas 2D pixel access.');
    }

    const pad = Math.ceil(number(mask.feather) / 2) + 2;
    const left = Math.max(0, Math.floor(mask.x + width / 2 - pad));
    const top = Math.max(0, Math.floor(mask.y + height / 2 - pad));
    const right = Math.min(width, Math.ceil(mask.x + mask.width + width / 2 + pad));
    const bottom = Math.min(height, Math.ceil(mask.y + mask.height + height / 2 + pad));
    const regionWidth = Math.max(0, right - left);
    const regionHeight = Math.max(0, bottom - top);
    if (!regionWidth || !regionHeight) return canvas;

    const image = context.createImageData(regionWidth, regionHeight);
    for (let row = 0; row < regionHeight; row += 1) {
      for (let column = 0; column < regionWidth; column += 1) {
        const sourceX = left + column - width / 2 + 0.5;
        const sourceY = top + row - height / 2 + 0.5;
        const alpha = Math.round(maskAlphaAtPoint(mask, sourceX, sourceY) * 255);
        image.data[(row * regionWidth + column) * 4 + 3] = alpha;
      }
    }
    context.putImageData(image, left, top);
    return canvas;
  }

  function maskSource(root, source, layer, cache) {
    if (!source || !layer?.mask) return source;
    const key = `${layer.source.width}x${layer.source.height}:${JSON.stringify(layer.mask)}`;
    if (source && (typeof source === 'object' || typeof source === 'function')) {
      const sourceCache = cache.get(source);
      if (sourceCache?.has(key)) return sourceCache.get(key);
    }
    const canvas = createCanvas(root, layer.source.width, layer.source.height);
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) throw new Error('Layer-mask rendering requires Canvas 2D support.');
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    context.globalCompositeOperation = 'destination-in';
    if (layer.mask.feather > 0 || layer.mask.shape === 'composite') {
      context.drawImage(createAlphaCanvas(root, layer), 0, 0);
    } else {
      context.beginPath();
      const x = layer.mask.x + layer.source.width / 2;
      const y = layer.mask.y + layer.source.height / 2;
      if (layer.mask.shape === 'polygon') {
        const points = layer.mask.points || [];
        if (points.length) {
          context.moveTo(
            points[0].x + layer.source.width / 2,
            points[0].y + layer.source.height / 2,
          );
          for (const point of points.slice(1))
            context.lineTo(point.x + layer.source.width / 2, point.y + layer.source.height / 2);
          context.closePath();
        }
      } else if (layer.mask.shape === 'ellipse') {
        context.ellipse(
          x + layer.mask.width / 2,
          y + layer.mask.height / 2,
          layer.mask.width / 2,
          layer.mask.height / 2,
          0,
          0,
          Math.PI * 2,
        );
      } else {
        context.rect(x, y, layer.mask.width, layer.mask.height);
      }
      context.fillStyle = '#000000';
      context.fill(layer.mask.shape === 'polygon' ? 'evenodd' : undefined);
    }
    context.globalCompositeOperation = 'source-over';
    if (source && (typeof source === 'object' || typeof source === 'function')) {
      let sourceCache = cache.get(source);
      if (!sourceCache) {
        sourceCache = new Map();
        cache.set(source, sourceCache);
      }
      sourceCache.set(key, canvas);
      while (sourceCache.size > 6) sourceCache.delete(sourceCache.keys().next().value);
    }
    return canvas;
  }

  function decorateCore(base, root = globalThis) {
    if (
      !base ||
      typeof base.normalizeProject !== 'function' ||
      typeof base.renderProject !== 'function'
    )
      throw new Error('AlcorPhoto core is required.');
    const cache = new WeakMap();
    const normalizeProject = (value) => attachMasks(base.normalizeProject(value), value);
    const core = Object.create(base);
    const descriptors = {
      normalizeProject: { value: normalizeProject },
      createProject: { value: (...args) => normalizeProject(base.createProject(...args)) },
      setLayerMask: {
        value: (project, layerId, mask) => {
          const next = normalizeProject(project);
          const index = next.layers.findIndex((layer) => layer.id === layerId);
          if (index < 0) throw new Error('Select an image layer before creating a mask.');
          if (next.layers[index].type !== 'image')
            throw new Error('Layer masks currently support image layers.');
          next.layers[index] = {
            ...next.layers[index],
            mask: normalizeMask(mask, next.layers[index]),
          };
          next.updatedAt = new Date().toISOString();
          return normalizeProject(next);
        },
      },
      composeLayerMask: {
        value: (project, layerId, mask, operation) => {
          const next = normalizeProject(project);
          const index = next.layers.findIndex((layer) => layer.id === layerId);
          if (index < 0) throw new Error('Select an image layer before combining a mask.');
          if (next.layers[index].type !== 'image')
            throw new Error('Layer masks currently support image layers.');
          const combined = composeMasks(
            next.layers[index].mask,
            mask,
            operation,
            next.layers[index],
          );
          next.layers[index] = { ...next.layers[index], mask: combined };
          next.updatedAt = new Date().toISOString();
          return normalizeProject(next);
        },
      },
      clearLayerMask: {
        value: (project, layerId) => {
          const next = normalizeProject(project);
          const index = next.layers.findIndex((layer) => layer.id === layerId);
          if (index < 0) throw new Error('Select an image layer first.');
          next.layers[index] = { ...next.layers[index], mask: null };
          next.updatedAt = new Date().toISOString();
          return normalizeProject(next);
        },
      },
      layerMaskBoundsFromProjectRect: { value: layerMaskBoundsFromProjectRect },
      layerMaskFromProjectPolygon: { value: layerMaskFromProjectPolygon },
      renderProject: {
        value: (context, project, resolveSource, options = {}) => {
          const normalized = normalizeProject(project);
          const renderable = clone(normalized);
          const synthetic = new Map();
          renderable.layers.forEach((layer, index) => {
            if (layer.type !== 'image' || !layer.mask) return;
            const originalId = layer.source.id;
            const source = resolveSource(originalId);
            if (!source) return;
            const id = `maskrender-${index}`;
            synthetic.set(id, maskSource(root, source, layer, cache));
            layer.source.id = id;
          });
          return base.renderProject(
            context,
            renderable,
            (id) => synthetic.get(id) || resolveSource(id),
            options,
          );
        },
      },
    };
    const preserved = [
      'addImageLayer',
      'relinkImageLayer',
      'addTextLayer',
      'addShapeLayer',
      'updateLayer',
      'removeLayer',
      'moveLayer',
      'moveLayerTo',
      'addRasterLayer',
      'addAdjustmentLayer',
      'setRasterMask',
      'createGroup',
      'setLayerGroup',
      'updateGroup',
      'removeGroup',
      'setCrop',
      'setAdjustments',
      'setBackground',
      'resizeCanvas',
      'flipLayer',
    ];
    for (const name of preserved) {
      if (typeof base[name] !== 'function') continue;
      descriptors[name] = {
        value: (project, ...args) => {
          const before = normalizeProject(project);
          return normalizeProject(preserveMasks(before, base[name](before, ...args)));
        },
      };
    }
    if (typeof base.duplicateLayer === 'function')
      descriptors.duplicateLayer = {
        value: (project, layerId) => {
          const before = normalizeProject(project);
          const source = before.layers.find((layer) => layer.id === layerId);
          const duplicated = preserveMasks(before, base.duplicateLayer(before, layerId));
          if (source?.mask) {
            const copy = duplicated.layers.find((layer) => layer.id === duplicated.selectedLayerId);
            if (copy) copy.mask = clone(source.mask);
          }
          return normalizeProject(duplicated);
        },
      };
    Object.defineProperties(core, descriptors);
    return Object.freeze(core);
  }

  function controller(root, Core) {
    const document = root.document;
    const editor = document?.querySelector?.('[data-alcor-photo-editor]');
    const canvas = editor?.querySelector?.('#ap-canvas');
    const tools = editor?.querySelector?.('.ap-canvas-tools');
    const viewport = editor?.querySelector?.('.ap-canvas-viewport');
    if (!editor || !canvas || !tools || !viewport) return { attachStore() {} };

    const toolbar = document.createElement('div');
    toolbar.className = 'ap-mask-tools';
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', 'Image layer mask selection');
    toolbar.innerHTML =
      '<strong>Mask</strong><button type="button" data-ap-mask="rectangle" aria-pressed="false">Rectangle select</button><button type="button" data-ap-mask="ellipse" aria-pressed="false">Ellipse select</button><button type="button" data-ap-mask="lasso" aria-pressed="false">Lasso select</button><span class="ap-mask-compose" role="group" aria-label="Selection composition"><button type="button" data-ap-mask-combine="new" aria-pressed="true">New</button><button type="button" data-ap-mask-combine="add" aria-pressed="false">Add</button><button type="button" data-ap-mask-combine="subtract" aria-pressed="false">Subtract</button><button type="button" data-ap-mask-combine="intersect" aria-pressed="false">Intersect</button></span><label class="ap-mask-feather">Feather <input type="range" min="0" max="128" step="1" value="0" data-ap-mask-feather disabled><output data-ap-mask-feather-value>0 px</output></label><button type="button" data-ap-mask-clear disabled>Clear mask</button><span data-ap-mask-state>No image layer selected</span>';
    const exportTools = tools.querySelector('.ap-export-tools');
    tools.insertBefore(toolbar, exportTools || null);
    const marquee = document.createElement('div');
    marquee.className = 'ap-mask-marquee';
    marquee.hidden = true;
    viewport.append(marquee);

    const buttons = [...toolbar.querySelectorAll('[data-ap-mask]')];
    const combineButtons = [...toolbar.querySelectorAll('[data-ap-mask-combine]')];
    const featherInput = toolbar.querySelector('[data-ap-mask-feather]');
    const featherValue = toolbar.querySelector('[data-ap-mask-feather-value]');
    const clearButton = toolbar.querySelector('[data-ap-mask-clear]');
    const state = toolbar.querySelector('[data-ap-mask-state]');
    const status = editor.querySelector('#ap-status');
    let store = null;
    let mode = null;
    let combineMode = 'new';
    let drag = null;
    let feather = 0;

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

    function shapeLabel(mask) {
      if (mask?.shape === 'composite') return `Composite · ${mask.components?.length || 0} regions`;
      if (mask?.shape === 'polygon') return `Lasso · ${mask.points?.length || 0} points`;
      if (mask?.shape === 'ellipse')
        return `Ellipse · ${Math.round(mask.width)}×${Math.round(mask.height)}`;
      return `Rectangle · ${Math.round(mask?.width || 0)}×${Math.round(mask?.height || 0)}`;
    }

    function renderState() {
      const layer = selectedImage();
      if (!layer?.mask && combineMode !== 'new') combineMode = 'new';
      buttons.forEach((button) => {
        button.disabled = !layer;
        button.setAttribute('aria-pressed', String(mode === button.dataset.apMask));
      });
      combineButtons.forEach((button) => {
        const operation = button.dataset.apMaskCombine;
        button.disabled = !layer || (!layer.mask && operation !== 'new');
        button.setAttribute('aria-pressed', String(combineMode === operation));
      });
      featherInput.disabled = !layer;
      clearButton.disabled = !layer?.mask;
      const currentFeather = layer?.mask ? layer.mask.feather : feather;
      featherInput.value = String(Math.round(currentFeather || 0));
      featherValue.value = `${Math.round(currentFeather || 0)} px`;
      featherValue.textContent = featherValue.value;
      if (!layer) state.textContent = 'Select an image layer';
      else if (!layer.mask) state.textContent = 'No mask';
      else
        state.textContent = `${shapeLabel(layer.mask)} · ${Math.round(layer.mask.feather || 0)} px feather`;
      canvas.dataset.maskTool = mode || '';
    }

    function resetMarquee() {
      marquee.hidden = true;
      marquee.style.clipPath = '';
      marquee.dataset.shape = '';
    }

    function setMode(value) {
      mode =
        value === 'ellipse'
          ? 'ellipse'
          : value === 'rectangle'
            ? 'rectangle'
            : value === 'lasso'
              ? 'lasso'
              : null;
      drag = null;
      resetMarquee();
      renderState();
      if (mode === 'lasso')
        message(
          'Drag a freehand lasso on the canvas. Release to close and apply it to the selected image layer.',
        );
      else if (mode)
        message(`Drag on the canvas to create a ${mode} mask on the selected image layer.`);
    }

    buttons.forEach((button) =>
      button.addEventListener('click', () => {
        if (!selectedImage())
          return message('Select an image layer before creating a mask.', 'error');
        setMode(mode === button.dataset.apMask ? null : button.dataset.apMask);
      }),
    );
    combineButtons.forEach((button) =>
      button.addEventListener('click', () => {
        const layer = selectedImage();
        if (!layer)
          return message('Select an image layer before choosing a selection mode.', 'error');
        const operation = button.dataset.apMaskCombine;
        if (!layer.mask && operation !== 'new')
          return message(
            'Create a mask before adding, subtracting, or intersecting a selection.',
            'error',
          );
        combineMode = operation;
        renderState();
        const label = operation === 'new' ? 'New' : operation[0].toUpperCase() + operation.slice(1);
        message(
          `${label} selection mode active. Choose Rectangle, Ellipse, or Lasso, then draw on the canvas.`,
        );
      }),
    );
    featherInput.addEventListener('input', () => {
      featherValue.value = `${Math.round(number(featherInput.value))} px`;
      featherValue.textContent = featherValue.value;
    });
    featherInput.addEventListener('change', () => {
      const layer = selectedImage();
      if (!layer) return;
      feather = clamp(featherInput.value, 0, MAX_FEATHER, 0);
      if (!layer.mask) {
        renderState();
        message(`New masks will use ${Math.round(feather)} px feather.`);
        return;
      }
      const next = Core.setLayerMask(store.project, layer.id, { ...layer.mask, feather });
      store.replace(next, 'Changed layer mask feather');
      const applied = selectedImage()?.mask?.feather || 0;
      feather = applied;
      renderState();
      message(`Layer mask feather set to ${Math.round(applied)} px. Undo restores the prior edge.`);
    });
    clearButton.addEventListener('click', () => {
      const layer = selectedImage();
      if (!store || !layer?.mask) return;
      feather = layer.mask.feather || feather;
      store.replace(Core.clearLayerMask(store.project, layer.id), 'Cleared layer mask');
      combineMode = 'new';
      setMode(null);
      message('Layer mask cleared.');
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

    function updateMarquee(clientX, clientY) {
      if (!drag) return;
      const bounds = viewport.getBoundingClientRect();
      marquee.hidden = false;
      if (drag.mode === 'lasso') {
        const points = drag.clientPoints || [];
        if (points.length < 2) return;
        const xs = points.map((point) => point.x);
        const ys = points.map((point) => point.y);
        const left = Math.min(...xs);
        const top = Math.min(...ys);
        const width = Math.max(1, Math.max(...xs) - left);
        const height = Math.max(1, Math.max(...ys) - top);
        marquee.style.left = `${left - bounds.left}px`;
        marquee.style.top = `${top - bounds.top}px`;
        marquee.style.width = `${width}px`;
        marquee.style.height = `${height}px`;
        marquee.style.clipPath = `polygon(${points.map((point) => `${((point.x - left) / width) * 100}% ${((point.y - top) / height) * 100}%`).join(',')})`;
        marquee.dataset.shape = 'lasso';
        return;
      }
      marquee.style.clipPath = '';
      marquee.style.left = `${Math.min(drag.clientX, clientX) - bounds.left}px`;
      marquee.style.top = `${Math.min(drag.clientY, clientY) - bounds.top}px`;
      marquee.style.width = `${Math.abs(clientX - drag.clientX)}px`;
      marquee.style.height = `${Math.abs(clientY - drag.clientY)}px`;
      marquee.dataset.shape = drag.mode || 'rectangle';
    }

    function appendLassoPoint(event) {
      if (!drag || drag.mode !== 'lasso') return;
      const last = drag.clientPoints[drag.clientPoints.length - 1];
      if (last && Math.hypot(event.clientX - last.x, event.clientY - last.y) < 3) return;
      const clientPoint = { x: event.clientX, y: event.clientY };
      const project = projectPoint(event);
      if (drag.clientPoints.length < 256) {
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
        if (!layer) {
          setMode(null);
          return message('Select an image layer before creating a mask.', 'error');
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        const startProject = projectPoint(event);
        drag = {
          mode,
          pointerId: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
          project: startProject,
          layerId: layer.id,
          clientPoints: mode === 'lasso' ? [{ x: event.clientX, y: event.clientY }] : null,
          projectPoints: mode === 'lasso' ? [startProject] : null,
        };
        canvas.setPointerCapture?.(event.pointerId);
        updateMarquee(event.clientX, event.clientY);
      },
      true,
    );

    canvas.addEventListener(
      'pointermove',
      (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        appendLassoPoint(event);
        updateMarquee(event.clientX, event.clientY);
      },
      true,
    );

    canvas.addEventListener(
      'pointerup',
      (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        appendLassoPoint(event);
        const current = drag;
        const end = projectPoint(event);
        const screenWidth =
          current.mode === 'lasso'
            ? Math.max(...current.clientPoints.map((point) => point.x)) -
              Math.min(...current.clientPoints.map((point) => point.x))
            : Math.abs(event.clientX - current.clientX);
        const screenHeight =
          current.mode === 'lasso'
            ? Math.max(...current.clientPoints.map((point) => point.y)) -
              Math.min(...current.clientPoints.map((point) => point.y))
            : Math.abs(event.clientY - current.clientY);
        drag = null;
        resetMarquee();
        if (screenWidth < 4 || screenHeight < 4)
          return message('Drag a larger selection before creating a mask.', 'error');
        const layer = store.project.layers.find((candidate) => candidate.id === current.layerId);
        if (!layer || layer.type !== 'image')
          return message('The selected image layer changed before the mask was applied.', 'error');
        try {
          const baseMask =
            current.mode === 'lasso'
              ? Core.layerMaskFromProjectPolygon(layer, current.projectPoints)
              : Core.layerMaskBoundsFromProjectRect(
                  layer,
                  {
                    x: Math.min(current.project.x, end.x),
                    y: Math.min(current.project.y, end.y),
                    width: Math.abs(end.x - current.project.x),
                    height: Math.abs(end.y - current.project.y),
                  },
                  current.mode,
                );
          const mask = { ...baseMask, feather };
          const next =
            combineMode === 'new' || !layer.mask
              ? Core.setLayerMask(store.project, layer.id, mask)
              : Core.composeLayerMask(store.project, layer.id, mask, combineMode);
          const editLabel =
            combineMode === 'new'
              ? `Applied ${current.mode} layer mask`
              : `${combineMode} ${current.mode} selection`;
          store.replace(next, editLabel);
          const applied = current.mode;
          const appliedOperation = combineMode;
          feather = selectedImage()?.mask?.feather || feather;
          setMode(null);
          const label =
            applied === 'lasso' ? 'Lasso' : applied === 'ellipse' ? 'Ellipse' : 'Rectangle';
          const operationLabel =
            appliedOperation === 'new' ? 'applied' : `${appliedOperation} selection applied`;
          message(
            `${label} ${operationLabel} non-destructively with ${Math.round(feather)} px feather. Undo restores the prior mask.`,
          );
        } catch (error) {
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
        resetMarquee();
      },
      true,
    );
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && mode) {
        setMode(null);
        message('Mask selection cancelled.');
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
    if (!root || root.__alcorPhotoMaskInstalled) return false;
    if (
      !root.AlcorPhotoCore ||
      !root.AlcorApp ||
      !root.document?.querySelector?.('[data-alcor-photo-editor]')
    )
      return false;
    const Core = decorateCore(root.AlcorPhotoCore, root);
    const ui = controller(root, Core);
    const baseApp = root.AlcorApp;
    const App = Object.create(baseApp);
    Object.defineProperty(App, 'createProjectStore', {
      value(options) {
        const store = baseApp.createProjectStore(options);
        ui.attachStore(store);
        return store;
      },
    });
    root.AlcorPhotoCore = Core;
    root.AlcorApp = App;
    root.__alcorPhotoMaskInstalled = true;
    return true;
  }

  return Object.freeze({
    MAX_FEATHER,
    MAX_POLYGON_POINTS,
    MAX_COMPOSITE_COMPONENTS,
    normalizeMask,
    composeMasks,
    layerMaskBoundsFromProjectRect,
    layerMaskFromProjectPolygon,
    signedDistanceToMask,
    maskAlphaAtPoint,
    decorateCore,
    install,
  });
});
