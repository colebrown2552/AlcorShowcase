/**
 * alcor-photo-core.js: AlcorPhoto document model.
 *
 * Pure document logic: layers, transforms and project schema. No DOM access,
 * so it also loads under Node for tests (UMD wrapper below).
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AlcorPhotoCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA = 'alcorphoto.project';
  const SCHEMA_VERSION = 1;
  const MAX_DIMENSION = 16384;
  const MAX_CANVAS_PIXELS = 64 * 1024 * 1024;
  const MAX_LAYERS = 200;
  const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
  const MAX_RUNTIME_SOURCES = 32;
  // Session-wide decoded pixels (1 GiB of RGBA). Each image is still capped at MAX_CANVAS_PIXELS,
  // and the browser passes a smaller budget on low-memory devices.
  const MAX_RUNTIME_DECODED_PIXELS = 256 * 1024 * 1024;
  const PORTABLE_SCHEMA = 'alcorphoto.bundle';
  const PORTABLE_SCHEMA_VERSION = 1;
  const PORTABLE_MAGIC = 'ALCORPHOTO1';
  const MAX_PORTABLE_HEADER_BYTES = 1024 * 1024;
  const MAX_PORTABLE_SOURCE_BYTES = 512 * 1024 * 1024;
  const MAX_PORTABLE_FILE_BYTES = MAX_PORTABLE_SOURCE_BYTES + MAX_PORTABLE_HEADER_BYTES + 64;
  const EXPORT_MIMES = Object.freeze({
    png: 'image/png',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    svg: 'image/svg+xml',
  });
  const BLEND_MODES = Object.freeze([
    'normal',
    'multiply',
    'screen',
    'overlay',
    'darken',
    'lighten',
    'color-dodge',
    'color-burn',
    'hard-light',
    'soft-light',
    'difference',
    'exclusion',
    'hue',
    'saturation',
    'color',
    'luminosity',
  ]);
  // Non-destructive adjustment layers. The pixel math lives in alcor-photo-pixels.js;
  // the core owns only the closed kind list and bounded parameters.
  const ADJUSTMENT_KINDS = Object.freeze([
    'levels',
    'curves',
    'hue-saturation',
    'vibrance',
    'color-balance',
    'brightness-contrast',
    'exposure',
    'black-white',
    'invert',
    'threshold',
    'gradient-map',
    'photo-filter',
    'posterize',
    'channel-mixer',
    'develop',
    'selective-color',
  ]);
  const MAX_ADJUSTMENT_PARAM_BYTES = 8192;
  const MAX_GROUPS = 64;
  const LAYER_TYPES = Object.freeze(['image', 'text', 'shape', 'adjustment']);
  // Font stacks offered in the font pickers: system fonts only (nothing is downloaded).
  const FONT_STACKS = Object.freeze([
    ['Inter, system-ui, sans-serif', 'Modern'],
    ['Arial, Helvetica, sans-serif', 'Arial'],
    ['"Helvetica Neue", Helvetica, Arial, sans-serif', 'Helvetica'],
    ['"Segoe UI", system-ui, sans-serif', 'Segoe'],
    ['Verdana, Geneva, sans-serif', 'Verdana'],
    ['"Trebuchet MS", Arial, sans-serif', 'Trebuchet'],
    ['"Arial Black", Impact, sans-serif', 'Heavy'],
    ['Impact, "Arial Black", sans-serif', 'Impact'],
    ['"Arial Narrow", "Helvetica Neue Condensed", sans-serif-condensed, sans-serif', 'Condensed'],
    ['ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", system-ui, sans-serif', 'Rounded'],
    ['Georgia, "Times New Roman", serif', 'Georgia'],
    ['"Times New Roman", Times, serif', 'Times'],
    ['"Palatino Linotype", Palatino, Georgia, serif', 'Palatino'],
    ['Garamond, "EB Garamond", Baskerville, serif', 'Garamond'],
    ['Didot, "Bodoni MT", "Bodoni 72", serif', 'Didot'],
    ['Rockwell, "Courier New", serif', 'Slab'],
    ['"SFMono-Regular", Consolas, monospace', 'Mono'],
    ['"Courier New", Courier, monospace', 'Courier'],
    ['"Brush Script MT", "Segoe Script", cursive', 'Script'],
    ['"Comic Sans MS", "Comic Neue", cursive', 'Casual'],
    ['cursive', 'Handwriting'],
    ['fantasy', 'Display'],
  ]);
  const SHAPE_TYPES = Object.freeze([
    'rectangle',
    'rounded-rectangle',
    'ellipse',
    'line',
    'arrow',
    'star',
    'heart',
    'speech-bubble',
    'path',
  ]);
  const MAX_PATH_POINTS = 4000;
  const DEFAULT_LAYER_NAMES = Object.freeze({
    image: 'Image layer',
    text: 'Text layer',
    shape: 'Shape layer',
    adjustment: 'Adjustment',
  });

  const clone = (value) =>
    typeof structuredClone === 'function'
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));
  const number = (value, fallback = 0) =>
    Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (value, min, max, fallback = min) =>
    Math.min(max, Math.max(min, number(value, fallback)));
  const boundedString = (value, fallback, max) => {
    const text = String(value == null ? fallback : value).trim();
    return (text || fallback).slice(0, max);
  };
  const isSafeSourceId = (value) =>
    /^[a-z0-9][a-z0-9._:-]{0,99}$/i.test(String(value || '').trim());
  const safeId = (value, prefix = 'item') => {
    const id = String(value || '').trim();
    if (isSafeSourceId(id)) return id;
    const random =
      globalThis.crypto?.randomUUID?.() ||
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${random}`.slice(0, 100);
  };
  const isoDate = (value) => {
    const parsed = new Date(value || '');
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
  };
  const hexColor = (value, fallback = '#ffffff') =>
    /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value).toLowerCase() : fallback;
  const scaleValue = (value, fallback = 1) => {
    const raw = number(value, fallback);
    const sign = raw < 0 ? -1 : 1;
    return sign * clamp(Math.abs(raw), 0.01, 100, Math.abs(fallback) || 1);
  };

  function normalizeTransform(value = {}) {
    const transform = {
      x: clamp(value.x, -1000000, 1000000, 0),
      y: clamp(value.y, -1000000, 1000000, 0),
      scaleX: scaleValue(value.scaleX, 1),
      scaleY: scaleValue(value.scaleY, 1),
      rotation: clamp(value.rotation, -36000, 36000, 0),
    };
    // Skew is optional so version 0.2 transforms normalize unchanged.
    const skewX = clamp(value.skewX, -80, 80, 0);
    const skewY = clamp(value.skewY, -80, 80, 0);
    if (skewX) transform.skewX = skewX;
    if (skewY) transform.skewY = skewY;
    return transform;
  }

  function normalizeSourceDescriptor(source, fallbackName) {
    const value = source || {};
    return {
      id: safeId(value.id, 'source'),
      name: boundedString(value.name, fallbackName, 180),
      mime: /^image\/(png|jpeg|webp|gif)$/i.test(String(value.mime || ''))
        ? String(value.mime).toLowerCase()
        : 'image/unknown',
      width: Math.round(clamp(value.width, 1, MAX_DIMENSION, 1)),
      height: Math.round(clamp(value.height, 1, MAX_DIMENSION, 1)),
      size: Math.round(clamp(value.size, 0, MAX_SOURCE_BYTES, 0)),
    };
  }

  // Bounded JSON-only parameters: numbers, booleans, short strings, small arrays and objects.
  function normalizeParams(value, depth = 0) {
    if (depth > 4) return null;
    if (typeof value === 'number')
      return Number.isFinite(value) ? Math.min(1e6, Math.max(-1e6, value)) : 0;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.slice(0, 64);
    if (Array.isArray(value))
      return value.slice(0, 64).map((item) => normalizeParams(item, depth + 1));
    if (value && typeof value === 'object') {
      const out = {};
      for (const key of Object.keys(value).slice(0, 32)) {
        if (!/^[a-z][a-z0-9]{0,31}$/i.test(key)) continue;
        out[key] = normalizeParams(value[key], depth + 1);
      }
      return out;
    }
    return null;
  }

  // Layer styles (effects). Each effect is optional and only kept when enabled,
  // so documents without styles normalize exactly as before.
  const STROKE_POSITIONS = Object.freeze(['outside', 'center', 'inside']);
  const LAYER_STYLE_KEYS = Object.freeze([
    'dropShadow',
    'innerShadow',
    'outerGlow',
    'stroke',
    'colorOverlay',
    'gradientOverlay',
  ]);
  function normalizeLayerStyles(value) {
    if (!value || typeof value !== 'object') return null;
    const out = {};
    const on = (item) => item && typeof item === 'object' && item.enabled !== false;
    const shadow = (item, color) => ({
      color: hexColor(item.color, color),
      opacity: clamp(item.opacity, 0, 1, 0.75),
      angle: clamp(item.angle, -180, 180, 120),
      distance: clamp(item.distance, 0, 1000, 8),
      size: clamp(item.size, 0, 250, 10),
    });
    if (on(value.dropShadow)) out.dropShadow = shadow(value.dropShadow, '#000000');
    if (on(value.innerShadow)) out.innerShadow = shadow(value.innerShadow, '#000000');
    if (on(value.outerGlow))
      out.outerGlow = {
        color: hexColor(value.outerGlow.color, '#ffffbe'),
        opacity: clamp(value.outerGlow.opacity, 0, 1, 0.75),
        size: clamp(value.outerGlow.size, 0, 250, 12),
      };
    if (on(value.stroke))
      out.stroke = {
        color: hexColor(value.stroke.color, '#000000'),
        opacity: clamp(value.stroke.opacity, 0, 1, 1),
        size: clamp(value.stroke.size, 1, 64, 3),
        position: STROKE_POSITIONS.includes(value.stroke.position)
          ? value.stroke.position
          : 'outside',
      };
    if (on(value.colorOverlay))
      out.colorOverlay = {
        color: hexColor(value.colorOverlay.color, '#ff0000'),
        opacity: clamp(value.colorOverlay.opacity, 0, 1, 1),
      };
    if (on(value.gradientOverlay))
      out.gradientOverlay = {
        from: hexColor(value.gradientOverlay.from, '#000000'),
        to: hexColor(value.gradientOverlay.to, '#ffffff'),
        angle: clamp(value.gradientOverlay.angle, -180, 180, 90),
        opacity: clamp(value.gradientOverlay.opacity, 0, 1, 1),
      };
    return Object.keys(out).length ? out : null;
  }
  const hasLayerStyles = (layer) => Boolean(layer && (layer.styles || layer.fillOpacity < 1));

  function normalizeLayer(value, index) {
    if (!value || !LAYER_TYPES.includes(value.type))
      throw new Error(`Unsupported layer at index ${index}.`);
    const base = {
      id: safeId(value.id, 'layer'),
      type: value.type,
      name: boundedString(value.name, DEFAULT_LAYER_NAMES[value.type], 80),
      visible: value.visible !== false,
      opacity: clamp(value.opacity, 0, 1, 1),
      blendMode: BLEND_MODES.includes(value.blendMode) ? value.blendMode : 'normal',
      transform: normalizeTransform(value.transform),
    };
    // Optional flags stay absent when false so older documents normalize unchanged.
    if (value.locked === true) base.locked = true;
    if (value.groupId && isSafeSourceId(value.groupId)) base.groupId = String(value.groupId).trim();
    if (value.clip === true) base.clip = true;
    if (value.type === 'image') {
      base.source = normalizeSourceDescriptor(value.source, 'Local image');
    } else if (value.type === 'text') {
      base.text = boundedString(value.text, 'Text', 2000);
      base.fontSize = clamp(value.fontSize, 4, 1024, 72);
      base.fontFamily = boundedString(value.fontFamily, 'Inter, system-ui, sans-serif', 120);
      base.fontWeight = Math.round(clamp(value.fontWeight, 100, 900, 700) / 100) * 100;
      base.color = hexColor(value.color);
      base.align = ['left', 'center', 'right'].includes(value.align) ? value.align : 'center';
      if (value.italic === true) base.italic = true;
      const lineHeight = clamp(value.lineHeight, 0.5, 4, 1.2);
      if (lineHeight !== 1.2) base.lineHeight = lineHeight;
      const letterSpacing = clamp(value.letterSpacing, -100, 400, 0);
      if (letterSpacing) base.letterSpacing = letterSpacing;
      const textStrokeWidth = clamp(value.strokeWidth, 0, 64, 0);
      if (textStrokeWidth) {
        base.strokeWidth = textStrokeWidth;
        base.stroke = hexColor(value.stroke, '#ffffff');
      }
      const shadowBlur = clamp(value.shadowBlur, 0, 128, 0);
      const shadowX = clamp(value.shadowX, -512, 512, 0);
      const shadowY = clamp(value.shadowY, -512, 512, 0);
      if (shadowBlur || shadowX || shadowY) {
        base.shadowColor = hexColor(value.shadowColor, '#000000');
        if (shadowBlur) base.shadowBlur = shadowBlur;
        if (shadowX) base.shadowX = shadowX;
        if (shadowY) base.shadowY = shadowY;
      }
    } else if (value.type === 'adjustment') {
      base.kind = ADJUSTMENT_KINDS.includes(value.kind) ? value.kind : 'levels';
      const params = normalizeParams(
        value.params && typeof value.params === 'object' ? value.params : {},
      );
      base.params =
        params && JSON.stringify(params).length <= MAX_ADJUSTMENT_PARAM_BYTES ? params : {};
    } else {
      base.shape = SHAPE_TYPES.includes(value.shape) ? value.shape : 'rectangle';
      base.width = clamp(value.width, 1, MAX_DIMENSION, 480);
      base.height = clamp(value.height, 1, MAX_DIMENSION, 320);
      base.fill = hexColor(value.fill, '#4f8cff');
      base.stroke = hexColor(value.stroke, '#ffffff');
      base.strokeWidth = clamp(value.strokeWidth, 0, 256, 4);
      if (base.shape === 'path') {
        // Pen paths: anchors with in/out handles, normalized to the layer box (-0.5..0.5).
        const unit = (v) => clamp(v, -4, 4, 0);
        const points = Array.isArray(value.points) ? value.points.slice(0, MAX_PATH_POINTS) : [];
        base.points = points
          .filter((pt) => pt && typeof pt === 'object')
          .map((pt) => {
            const x = unit(pt.x),
              y = unit(pt.y);
            return {
              x,
              y,
              ix: unit(pt.ix ?? x),
              iy: unit(pt.iy ?? y),
              ox: unit(pt.ox ?? x),
              oy: unit(pt.oy ?? y),
            };
          });
        if (base.points.length < 2)
          base.points = [
            { x: -0.5, y: 0, ix: -0.5, iy: 0, ox: -0.5, oy: 0 },
            { x: 0.5, y: 0, ix: 0.5, iy: 0, ox: 0.5, oy: 0 },
          ];
        if (value.closed === true) base.closed = true;
      }
      if (base.shape === 'rounded-rectangle' || base.shape === 'speech-bubble') {
        base.cornerRadius = clamp(
          value.cornerRadius,
          0,
          Math.min(base.width, base.height) / 2,
          Math.min(48, base.height / 4),
        );
      }
    }
    if (value.type !== 'adjustment') {
      const styles = normalizeLayerStyles(value.styles);
      if (styles) base.styles = styles;
      const fillOpacity = clamp(value.fillOpacity, 0, 1, 1);
      if (fillOpacity < 1) base.fillOpacity = fillOpacity;
    }
    // Pixel masks: grey levels stored as alpha in a PNG source. Image layers use a
    // mask the size of their source that moves with the layer; adjustment layers
    // use a canvas-sized mask.
    if (
      (value.type === 'image' || value.type === 'adjustment') &&
      value.rasterMask &&
      value.rasterMask.source
    ) {
      base.rasterMask = {
        source: normalizeSourceDescriptor(
          { mime: 'image/png', ...value.rasterMask.source },
          'Layer mask',
        ),
        enabled: value.rasterMask.enabled !== false,
      };
    }
    return base;
  }

  function normalizeProject(value) {
    if (!value || value.schema !== SCHEMA || Number(value.schemaVersion) !== SCHEMA_VERSION)
      throw new Error('Unsupported AlcorPhoto project.');
    const width = Math.round(clamp(value.width, 1, MAX_DIMENSION, 1920));
    const height = Math.round(clamp(value.height, 1, MAX_DIMENSION, 1080));
    if (!Array.isArray(value.layers) || value.layers.length > MAX_LAYERS)
      throw new Error(`AlcorPhoto projects support at most ${MAX_LAYERS} layers.`);
    let layers = value.layers.map(normalizeLayer);
    if (new Set(layers.map((layer) => layer.id)).size !== layers.length)
      throw new Error('Layer ids must be unique.');
    // Layer groups (one level): folders of consecutive layers with their own
    // visibility, opacity, and blend mode. Empty groups and dangling references are dropped.
    const groups = [];
    const groupIds = new Set();
    for (const raw of Array.isArray(value.groups) ? value.groups.slice(0, MAX_GROUPS) : []) {
      if (!raw || !isSafeSourceId(raw.id) || groupIds.has(String(raw.id).trim())) continue;
      const id = String(raw.id).trim();
      if (!layers.some((layer) => layer.groupId === id)) continue;
      groupIds.add(id);
      const group = {
        id,
        name: boundedString(raw.name, 'Group', 80),
        visible: raw.visible !== false,
        opacity: clamp(raw.opacity, 0, 1, 1),
        blendMode:
          raw.blendMode === 'pass-through' || BLEND_MODES.includes(raw.blendMode)
            ? raw.blendMode
            : 'pass-through',
      };
      if (raw.collapsed === true) group.collapsed = true;
      groups.push(group);
    }
    layers = layers.map((layer) => {
      if (!layer.groupId || groupIds.has(layer.groupId)) return layer;
      const { groupId, ...rest } = layer;
      void groupId;
      return rest;
    });
    const crop = value.crop || {};
    const x = Math.round(clamp(crop.x, 0, width - 1, 0));
    const y = Math.round(clamp(crop.y, 0, height - 1, 0));
    const cropWidth = Math.round(clamp(crop.width, 1, width - x, width - x));
    const cropHeight = Math.round(clamp(crop.height, 1, height - y, height - y));
    const selected = layers.some((layer) => layer.id === value.selectedLayerId)
      ? value.selectedLayerId
      : layers.at(-1)?.id || null;
    const normalized = {
      schema: SCHEMA,
      schemaVersion: SCHEMA_VERSION,
      name: boundedString(value.name, 'Untitled photo', 80),
      width,
      height,
      background:
        value.background === null || value.background === 'transparent'
          ? null
          : hexColor(value.background, null),
      crop: { x, y, width: cropWidth, height: cropHeight },
      adjustments: {
        brightness: clamp(value.adjustments?.brightness, -100, 100, 0),
        contrast: clamp(value.adjustments?.contrast, -100, 100, 0),
        saturation: clamp(value.adjustments?.saturation, -100, 100, 0),
        hue: clamp(value.adjustments?.hue, -180, 180, 0),
        blur: clamp(value.adjustments?.blur, 0, 40, 0),
        grayscale: clamp(value.adjustments?.grayscale, 0, 100, 0),
      },
      layers,
      selectedLayerId: selected,
      createdAt: isoDate(value.createdAt),
      updatedAt: isoDate(value.updatedAt),
    };
    // The active pixel selection is session state referenced by id so undo and
    // redo restore it; it carries no pixels and is dropped from saved bundles.
    if (value.selection && isSafeSourceId(value.selection.id))
      normalized.selection = { id: String(value.selection.id).trim() };
    if (groups.length) normalized.groups = groups;
    // Print resolution (pixels per inch) only labels exports; 72 stays implicit.
    const ppi = Math.round(clamp(value.ppi, 1, 10000, 72));
    if (ppi !== 72) normalized.ppi = ppi;
    return normalized;
  }

  function createProject(options = {}) {
    const now = new Date().toISOString();
    return normalizeProject({
      schema: SCHEMA,
      schemaVersion: SCHEMA_VERSION,
      name: options.name || 'Untitled photo',
      width: options.width || 1920,
      height: options.height || 1080,
      background: options.background || null,
      ppi: options.ppi || 72,
      crop: { x: 0, y: 0, width: options.width || 1920, height: options.height || 1080 },
      adjustments: { brightness: 0, contrast: 0, saturation: 0, hue: 0, blur: 0, grayscale: 0 },
      layers: [],
      selectedLayerId: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  function createSourceBudget(options = {}) {
    const maxSources = Math.round(
      clamp(options.maxSources, 1, MAX_RUNTIME_SOURCES, MAX_RUNTIME_SOURCES),
    );
    const maxDecodedPixels = Math.round(
      clamp(options.maxDecodedPixels, 1, MAX_RUNTIME_DECODED_PIXELS, MAX_RUNTIME_DECODED_PIXELS),
    );
    const entries = new Map();
    let decodedPixels = 0;
    return Object.freeze({
      reserve(source) {
        const id = String(source?.id || '');
        const width = Number(source?.width);
        const height = Number(source?.height);
        if (
          !isSafeSourceId(id) ||
          !Number.isInteger(width) ||
          !Number.isInteger(height) ||
          width < 1 ||
          height < 1 ||
          width > MAX_DIMENSION ||
          height > MAX_DIMENSION ||
          width * height > MAX_CANVAS_PIXELS
        )
          throw new Error('Decoded source metadata is invalid.');
        if (entries.has(id)) throw new Error('Decoded source ids must be unique.');
        const pixels = width * height;
        if (entries.size + 1 > maxSources || decodedPixels + pixels > maxDecodedPixels) {
          throw new Error(
            'This session has reached its image-memory limit. Start a new project or reopen this one to clear imported image data.',
          );
        }
        entries.set(id, pixels);
        decodedPixels += pixels;
        return Object.freeze({
          sources: entries.size,
          decodedPixels,
          maxSources,
          maxDecodedPixels,
        });
      },
      release(id) {
        if (!entries.has(id)) return false;
        decodedPixels -= entries.get(id);
        entries.delete(id);
        return true;
      },
      clear() {
        entries.clear();
        decodedPixels = 0;
      },
      has(id) {
        return entries.has(id);
      },
      state() {
        return Object.freeze({
          sources: entries.size,
          decodedPixels,
          maxSources,
          maxDecodedPixels,
        });
      },
    });
  }

  function addImageLayer(project, source) {
    const next = normalizeProject(project);
    if (next.layers.length >= MAX_LAYERS)
      throw new Error(`AlcorPhoto projects support at most ${MAX_LAYERS} layers.`);
    const width = Number(source?.width);
    const height = Number(source?.height);
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > MAX_DIMENSION ||
      height > MAX_DIMENSION ||
      width * height > MAX_CANVAS_PIXELS
    ) {
      throw new Error(
        `Imported images are limited to ${MAX_DIMENSION} pixels per side and ${MAX_CANVAS_PIXELS} pixels.`,
      );
    }
    if (next.layers.length === 0) {
      next.width = width;
      next.height = height;
      next.crop = { x: 0, y: 0, width, height };
    }
    const fit = Math.min(next.width / width, next.height / height, 1);
    const layer = normalizeLayer(
      {
        id: safeId(null, 'layer'),
        type: 'image',
        name: source?.name || 'Image layer',
        visible: true,
        opacity: 1,
        transform: { x: next.width / 2, y: next.height / 2, scaleX: fit, scaleY: fit, rotation: 0 },
        source,
      },
      next.layers.length,
    );
    next.layers.push(layer);
    next.selectedLayerId = layer.id;
    next.updatedAt = new Date().toISOString();
    return normalizeProject(next);
  }

  function relinkImageLayer(project, layerId, source) {
    const next = normalizeProject(project);
    const layer = next.layers.find((candidate) => candidate.id === layerId);
    if (!layer || layer.type !== 'image') throw new Error('Select an image layer to relink.');
    if (!source || !isSafeSourceId(source.id) || source.id === layer.source.id)
      throw new Error(
        'Relinking requires a fresh source id so undo and redo keep the matching pixels.',
      );
    return updateLayer(next, layerId, { source, name: layer.name });
  }

  function addTextLayer(project, options = {}) {
    const next = normalizeProject(project);
    if (next.layers.length >= MAX_LAYERS)
      throw new Error(`AlcorPhoto projects support at most ${MAX_LAYERS} layers.`);
    const layer = normalizeLayer(
      {
        id: safeId(null, 'layer'),
        type: 'text',
        name: options.name || 'Text layer',
        text: options.text || 'AlcorPhoto',
        fontSize: options.fontSize || 72,
        fontFamily: options.fontFamily,
        fontWeight: options.fontWeight,
        color: options.color,
        align: options.align,
        italic: options.italic,
        lineHeight: options.lineHeight,
        letterSpacing: options.letterSpacing,
        stroke: options.stroke,
        strokeWidth: options.strokeWidth,
        shadowColor: options.shadowColor,
        shadowBlur: options.shadowBlur,
        shadowX: options.shadowX,
        shadowY: options.shadowY,
        visible: true,
        opacity: 1,
        transform: { x: next.width / 2, y: next.height / 2, scaleX: 1, scaleY: 1, rotation: 0 },
      },
      next.layers.length,
    );
    next.layers.push(layer);
    next.selectedLayerId = layer.id;
    next.updatedAt = new Date().toISOString();
    return normalizeProject(next);
  }

  function addShapeLayer(project, options = {}) {
    const next = normalizeProject(project);
    if (next.layers.length >= MAX_LAYERS)
      throw new Error(`AlcorPhoto projects support at most ${MAX_LAYERS} layers.`);
    const shape = SHAPE_TYPES.includes(options.shape) ? options.shape : 'rectangle';
    const names = {
      rectangle: 'Rectangle',
      'rounded-rectangle': 'Rounded rectangle',
      ellipse: 'Ellipse',
      line: 'Line',
      arrow: 'Arrow',
      star: 'Star',
      heart: 'Heart',
      'speech-bubble': 'Speech bubble',
      path: 'Path',
    };
    const layer = normalizeLayer(
      {
        id: safeId(null, 'layer'),
        type: 'shape',
        name: options.name || names[shape],
        shape,
        width: options.width || Math.min(480, next.width * 0.5),
        height: options.height || Math.min(320, next.height * 0.5),
        fill: options.fill || '#4f8cff',
        stroke: options.stroke || '#ffffff',
        strokeWidth: options.strokeWidth == null ? 4 : options.strokeWidth,
        cornerRadius: options.cornerRadius,
        points: options.points,
        closed: options.closed === true,
        visible: true,
        opacity: 1,
        transform: { x: next.width / 2, y: next.height / 2, scaleX: 1, scaleY: 1, rotation: 0 },
      },
      next.layers.length,
    );
    next.layers.push(layer);
    next.selectedLayerId = layer.id;
    next.updatedAt = new Date().toISOString();
    return normalizeProject(next);
  }

  function updateLayer(project, layerId, patch) {
    const next = normalizeProject(project);
    const index = next.layers.findIndex((layer) => layer.id === layerId);
    if (index < 0) throw new Error('Select a layer first.');
    const current = next.layers[index];
    const candidate = { ...current, ...clone(patch || {}) };
    if (patch?.transform) candidate.transform = { ...current.transform, ...patch.transform };
    next.layers[index] = normalizeLayer(candidate, index);
    next.updatedAt = new Date().toISOString();
    return normalizeProject(next);
  }

  function removeLayer(project, layerId) {
    const next = normalizeProject(project);
    const index = next.layers.findIndex((layer) => layer.id === layerId);
    if (index < 0) return next;
    next.layers.splice(index, 1);
    next.selectedLayerId = next.layers[Math.min(index, next.layers.length - 1)]?.id || null;
    next.updatedAt = new Date().toISOString();
    return normalizeProject(next);
  }

  function duplicateLayer(project, layerId) {
    const next = normalizeProject(project);
    if (next.layers.length >= MAX_LAYERS)
      throw new Error(`AlcorPhoto projects support at most ${MAX_LAYERS} layers.`);
    const index = next.layers.findIndex((layer) => layer.id === layerId);
    if (index < 0) throw new Error('Select a layer first.');
    const duplicate = clone(next.layers[index]);
    duplicate.id = safeId(null, 'layer');
    duplicate.name = `${duplicate.name} copy`;
    duplicate.transform.x += 24;
    duplicate.transform.y += 24;
    next.layers.splice(index + 1, 0, normalizeLayer(duplicate, index + 1));
    next.selectedLayerId = duplicate.id;
    next.updatedAt = new Date().toISOString();
    return normalizeProject(next);
  }

  function moveLayer(project, layerId, direction) {
    const next = normalizeProject(project);
    const from = next.layers.findIndex((layer) => layer.id === layerId);
    const to = direction === 'up' ? from + 1 : direction === 'down' ? from - 1 : -1;
    if (from < 0 || to < 0 || to >= next.layers.length) return next;
    // One step across a group edge moves the layer into or out of that group
    // (it takes the group of the layer it passes), keeping groups consecutive.
    const passed = next.layers[to];
    const moved = next.layers[from];
    if (passed.groupId) moved.groupId = passed.groupId;
    else delete moved.groupId;
    [next.layers[from], next.layers[to]] = [next.layers[to], next.layers[from]];
    next.updatedAt = new Date().toISOString();
    return normalizeProject(next);
  }

  // New layers created by editing tools go directly above the selected layer.
  function insertAboveSelected(next, layer) {
    const selectedIndex = next.layers.findIndex(
      (candidate) => candidate.id === next.selectedLayerId,
    );
    // Inserting next to a group member puts the new layer in that group, so the
    // group's members stay consecutive.
    const selectedGroup = selectedIndex >= 0 ? next.layers[selectedIndex].groupId : null;
    if (selectedGroup) layer.groupId = selectedGroup;
    else delete layer.groupId;
    next.layers.splice(selectedIndex < 0 ? next.layers.length : selectedIndex + 1, 0, layer);
    next.selectedLayerId = layer.id;
    next.updatedAt = new Date().toISOString();
    return normalizeProject(next);
  }

  // A pixel layer whose source is produced in the browser (paint, paste, filters).
  // Unlike addImageLayer it never resizes the canvas and keeps 1:1 pixel scale.
  function addRasterLayer(project, source, options = {}) {
    const next = normalizeProject(project);
    if (next.layers.length >= MAX_LAYERS)
      throw new Error(`AlcorPhoto projects support at most ${MAX_LAYERS} layers.`);
    const width = Number(source?.width),
      height = Number(source?.height);
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > MAX_DIMENSION ||
      height > MAX_DIMENSION ||
      width * height > MAX_CANVAS_PIXELS
    ) {
      throw new Error(
        `Pixel layers are limited to ${MAX_DIMENSION} pixels per side and ${MAX_CANVAS_PIXELS} pixels.`,
      );
    }
    const layer = normalizeLayer(
      {
        id: safeId(null, 'layer'),
        type: 'image',
        name: options.name || `Layer ${next.layers.length + 1}`,
        visible: true,
        opacity: 1,
        transform: {
          x: number(options.x, next.width / 2),
          y: number(options.y, next.height / 2),
          scaleX: 1,
          scaleY: 1,
          rotation: 0,
        },
        source: { mime: 'image/png', size: 0, ...source },
      },
      next.layers.length,
    );
    return insertAboveSelected(next, layer);
  }

  function addAdjustmentLayer(project, kind, params = {}, options = {}) {
    const next = normalizeProject(project);
    if (next.layers.length >= MAX_LAYERS)
      throw new Error(`AlcorPhoto projects support at most ${MAX_LAYERS} layers.`);
    if (!ADJUSTMENT_KINDS.includes(kind)) throw new Error('Choose a supported adjustment.');
    const layer = normalizeLayer(
      {
        id: safeId(null, 'layer'),
        type: 'adjustment',
        name:
          options.name ||
          kind
            .split('-')
            .map((word) => word[0].toUpperCase() + word.slice(1))
            .join(' '),
        kind,
        params,
        clip: options.clip === true,
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      },
      next.layers.length,
    );
    return insertAboveSelected(next, layer);
  }

  // Move a layer to an absolute stack index (0 = bottom). Used by drag reordering.
  function moveLayerTo(project, layerId, index) {
    const next = normalizeProject(project);
    const from = next.layers.findIndex((layer) => layer.id === layerId);
    if (from < 0) throw new Error('Select a layer first.');
    const to = Math.round(clamp(index, 0, next.layers.length - 1, from));
    if (to === from) return next;
    const [layer] = next.layers.splice(from, 1);
    next.layers.splice(to, 0, layer);
    next.updatedAt = new Date().toISOString();
    return normalizeProject(next);
  }

  // Attach, replace, toggle, or remove a pixel mask. `source` is a PNG source descriptor.
  function setRasterMask(project, layerId, source, options = {}) {
    const next = normalizeProject(project);
    const index = next.layers.findIndex((layer) => layer.id === layerId);
    if (index < 0) throw new Error('Select a layer first.');
    const layer = next.layers[index];
    if (layer.type !== 'image' && layer.type !== 'adjustment')
      throw new Error(
        'Layer masks need a pixel or adjustment layer. Rasterize text and shapes first.',
      );
    if (source === null) delete layer.rasterMask;
    else {
      const expected =
        layer.type === 'image' ? layer.source : { width: next.width, height: next.height };
      const mask = source || layer.rasterMask?.source;
      if (!mask) throw new Error('This layer has no mask.');
      if (Number(mask.width) !== expected.width || Number(mask.height) !== expected.height)
        throw new Error('A layer mask must match its layer dimensions.');
      layer.rasterMask = {
        source: { mime: 'image/png', ...mask },
        enabled:
          options.enabled == null ? (layer.rasterMask?.enabled ?? true) : options.enabled !== false,
      };
    }
    next.layers[index] = normalizeLayer(layer, index);
    next.updatedAt = new Date().toISOString();
    return normalizeProject(next);
  }

  // Put one layer in a new group (Layer > Group, Ctrl+G).
  function createGroup(project, layerId, options = {}) {
    const next = normalizeProject(project);
    const layer = next.layers.find((item) => item.id === layerId);
    if (!layer) throw new Error('Select a layer to group.');
    if ((next.groups || []).length >= MAX_GROUPS)
      throw new Error(`AlcorPhoto projects support at most ${MAX_GROUPS} groups.`);
    const id = safeId(null, 'group');
    next.groups = [
      ...(next.groups || []),
      {
        id,
        name: options.name || `Group ${(next.groups || []).length + 1}`,
        visible: true,
        opacity: 1,
        blendMode: 'pass-through',
      },
    ];
    layer.groupId = id;
    next.updatedAt = new Date().toISOString();
    return normalizeProject(next);
  }

  // Move a layer into a group (placed just above the group's top member) or out of any group.
  function setLayerGroup(project, layerId, groupId) {
    const next = normalizeProject(project);
    const from = next.layers.findIndex((item) => item.id === layerId);
    if (from < 0) throw new Error('Select a layer first.');
    const [layer] = next.layers.splice(from, 1);
    if (groupId) {
      if (!(next.groups || []).some((group) => group.id === groupId))
        throw new Error('That group no longer exists.');
      let top = -1;
      next.layers.forEach((item, index) => {
        if (item.groupId === groupId) top = index;
      });
      layer.groupId = groupId;
      next.layers.splice(top < 0 ? next.layers.length : top + 1, 0, layer);
    } else {
      delete layer.groupId;
      next.layers.splice(from, 0, layer);
    }
    next.updatedAt = new Date().toISOString();
    return normalizeProject(next);
  }

  function updateGroup(project, groupId, patch = {}) {
    const next = normalizeProject(project);
    const index = (next.groups || []).findIndex((group) => group.id === groupId);
    if (index < 0) throw new Error('That group no longer exists.');
    next.groups[index] = { ...next.groups[index], ...clone(patch), id: groupId };
    next.updatedAt = new Date().toISOString();
    return normalizeProject(next);
  }

  // Ungroup keeps the layers; deleting contents removes them too.
  function removeGroup(project, groupId, options = {}) {
    const next = normalizeProject(project);
    if (!(next.groups || []).some((group) => group.id === groupId))
      throw new Error('That group no longer exists.');
    if (options.deleteLayers)
      next.layers = next.layers.filter((layer) => layer.groupId !== groupId);
    else
      next.layers = next.layers.map((layer) => {
        if (layer.groupId !== groupId) return layer;
        const { groupId: dropped, ...rest } = layer;
        void dropped;
        return rest;
      });
    next.groups = next.groups.filter((group) => group.id !== groupId);
    if (!next.layers.some((layer) => layer.id === next.selectedLayerId))
      next.selectedLayerId = next.layers.at(-1)?.id || null;
    next.updatedAt = new Date().toISOString();
    return normalizeProject(next);
  }

  function setCrop(project, crop) {
    const next = normalizeProject(project);
    next.crop = { ...next.crop, ...clone(crop || {}) };
    next.updatedAt = new Date().toISOString();
    return normalizeProject(next);
  }

  function setAdjustments(project, adjustments) {
    const next = normalizeProject(project);
    next.adjustments = { ...next.adjustments, ...clone(adjustments || {}) };
    next.updatedAt = new Date().toISOString();
    return normalizeProject(next);
  }

  function setBackground(project, color) {
    const next = normalizeProject(project);
    next.background = color === null || color === 'transparent' ? null : hexColor(color, '#ffffff');
    next.updatedAt = new Date().toISOString();
    return normalizeProject(next);
  }

  function resizeCanvas(project, dimensions, options = {}) {
    const next = normalizeProject(project);
    const width = Math.round(clamp(dimensions?.width, 1, MAX_DIMENSION, next.width));
    const height = Math.round(clamp(dimensions?.height, 1, MAX_DIMENSION, next.height));
    if (width * height > MAX_CANVAS_PIXELS)
      throw new Error(`Canvas resize is limited to ${MAX_CANVAS_PIXELS.toLocaleString()} pixels.`);
    if (options.scaleLayers) {
      const scaleX = width / next.width;
      const scaleY = height / next.height;
      next.layers = next.layers.map((layer, index) =>
        normalizeLayer(
          {
            ...layer,
            transform: {
              ...layer.transform,
              x: layer.transform.x * scaleX,
              y: layer.transform.y * scaleY,
              scaleX: layer.transform.scaleX * scaleX,
              scaleY: layer.transform.scaleY * scaleY,
            },
          },
          index,
        ),
      );
    } else if (options.anchor) {
      // Canvas Size: keep pixels at 1:1 and shift layers by the anchor.
      const anchor = String(options.anchor);
      const fx = anchor.includes('left') ? 0 : anchor.includes('right') ? 1 : 0.5;
      const fy = anchor.includes('top') ? 0 : anchor.includes('bottom') ? 1 : 0.5;
      const dx = (width - next.width) * fx,
        dy = (height - next.height) * fy;
      next.layers = next.layers.map((layer, index) =>
        layer.type === 'adjustment'
          ? layer
          : normalizeLayer(
              {
                ...layer,
                transform: {
                  ...layer.transform,
                  x: layer.transform.x + dx,
                  y: layer.transform.y + dy,
                },
              },
              index,
            ),
      );
    }
    if (width !== next.width || height !== next.height) {
      for (const layer of next.layers) {
        if (layer.type === 'adjustment' && layer.rasterMask)
          throw new Error(
            'Remove adjustment-layer masks before resizing the canvas; they are pinned to canvas pixels.',
          );
      }
    }
    next.width = width;
    next.height = height;
    next.crop = { x: 0, y: 0, width, height };
    next.updatedAt = new Date().toISOString();
    return normalizeProject(next);
  }

  function flipLayer(project, layerId, axis) {
    const next = normalizeProject(project);
    const layer = next.layers.find((candidate) => candidate.id === layerId);
    if (!layer) throw new Error('Select a layer first.');
    const key = axis === 'vertical' ? 'scaleY' : 'scaleX';
    return updateLayer(next, layerId, { transform: { [key]: -layer.transform[key] } });
  }

  function canvasFilter(adjustments) {
    const a = normalizeProject({ ...createProject(), adjustments }).adjustments;
    return `brightness(${100 + a.brightness}%) contrast(${100 + a.contrast}%) saturate(${100 + a.saturation}%) hue-rotate(${a.hue}deg) blur(${a.blur}px) grayscale(${a.grayscale}%)`;
  }

  function outputSize(project) {
    const p = normalizeProject(project);
    return { width: p.crop.width, height: p.crop.height };
  }

  function applyLayerTransform(context, transform) {
    context.translate(transform.x, transform.y);
    context.rotate((transform.rotation * Math.PI) / 180);
    if (transform.skewX || transform.skewY) {
      context.transform(
        1,
        Math.tan(((transform.skewY || 0) * Math.PI) / 180),
        Math.tan(((transform.skewX || 0) * Math.PI) / 180),
        1,
        0,
        0,
      );
    }
    context.scale(transform.scaleX, transform.scaleY);
  }

  function roundedRectPath(context, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius || 0, width / 2, height / 2));
    if ('roundRect' in context) {
      context.roundRect(x, y, width, height, r);
      return;
    }
    context.moveTo(x + r, y);
    context.lineTo(x + width - r, y);
    context.quadraticCurveTo(x + width, y, x + width, y + r);
    context.lineTo(x + width, y + height - r);
    context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    context.lineTo(x + r, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - r);
    context.lineTo(x, y + r);
    context.quadraticCurveTo(x, y, x + r, y);
  }

  function shapePath(context, layer) {
    const x = -layer.width / 2,
      y = -layer.height / 2;
    context.beginPath();
    if (layer.shape === 'ellipse') {
      context.ellipse(0, 0, layer.width / 2, layer.height / 2, 0, 0, Math.PI * 2);
    } else if (layer.shape === 'rounded-rectangle') {
      roundedRectPath(context, x, y, layer.width, layer.height, layer.cornerRadius || 0);
    } else if (layer.shape === 'line') {
      context.moveTo(x, 0);
      context.lineTo(-x, 0);
    } else if (layer.shape === 'arrow') {
      const h = layer.height / 2,
        stem = layer.width * 0.58,
        sh = h * 0.38;
      context.moveTo(x, -sh);
      context.lineTo(x + stem, -sh);
      context.lineTo(x + stem, -h);
      context.lineTo(-x, 0);
      context.lineTo(x + stem, h);
      context.lineTo(x + stem, sh);
      context.lineTo(x, sh);
      context.closePath();
    } else if (layer.shape === 'star') {
      const unit = Math.max(1, Math.min(layer.width, layer.height));
      const outer = unit / 2,
        inner = outer * 0.46;
      for (let i = 0; i < 10; i += 1) {
        const radius = i % 2 ? inner : outer;
        const angle = -Math.PI / 2 + (i * Math.PI) / 5;
        const px = Math.cos(angle) * radius * (layer.width / unit);
        const py = Math.sin(angle) * radius * (layer.height / unit);
        if (!i) context.moveTo(px, py);
        else context.lineTo(px, py);
      }
      context.closePath();
    } else if (layer.shape === 'heart') {
      const w = layer.width,
        h = layer.height;
      context.moveTo(0, h * 0.42);
      context.bezierCurveTo(-w * 0.58, h * 0.08, -w * 0.55, -h * 0.38, -w * 0.2, -h * 0.34);
      context.bezierCurveTo(0, -h * 0.32, 0, -h * 0.08, 0, -h * 0.02);
      context.bezierCurveTo(0, -h * 0.08, 0, -h * 0.32, w * 0.2, -h * 0.34);
      context.bezierCurveTo(w * 0.55, -h * 0.38, w * 0.58, h * 0.08, 0, h * 0.42);
      context.closePath();
    } else if (layer.shape === 'path') {
      const w = layer.width,
        h = layer.height,
        pts = layer.points || [];
      if (pts.length) {
        context.moveTo(pts[0].x * w, pts[0].y * h);
        const seg = (a, b) =>
          context.bezierCurveTo(a.ox * w, a.oy * h, b.ix * w, b.iy * h, b.x * w, b.y * h);
        for (let i = 1; i < pts.length; i += 1) seg(pts[i - 1], pts[i]);
        if (layer.closed) {
          seg(pts[pts.length - 1], pts[0]);
          context.closePath();
        }
      }
    } else if (layer.shape === 'speech-bubble') {
      const tail = Math.min(layer.height * 0.22, 64),
        bodyHeight = layer.height - tail;
      roundedRectPath(context, x, y, layer.width, bodyHeight, layer.cornerRadius || 0);
      context.moveTo(x + layer.width * 0.3, y + bodyHeight - 1);
      context.lineTo(x + layer.width * 0.2, y + bodyHeight + tail);
      context.lineTo(x + layer.width * 0.48, y + bodyHeight - 1);
      context.closePath();
    } else {
      context.rect(x, y, layer.width, layer.height);
    }
  }

  // Draw one layer's content in its own transform. Callers own alpha and blending.
  function drawLayerContent(context, layer, resolveSource, p) {
    applyLayerTransform(context, layer.transform);
    if (layer.type === 'image') {
      const source = resolveSource(layer.source.id);
      if (source)
        context.drawImage(
          source,
          -layer.source.width / 2,
          -layer.source.height / 2,
          layer.source.width,
          layer.source.height,
        );
    } else if (layer.type === 'text') {
      context.fillStyle = layer.color;
      context.font = `${layer.italic ? 'italic ' : ''}${layer.fontWeight} ${layer.fontSize}px ${layer.fontFamily}`;
      context.textAlign = layer.align;
      context.textBaseline = 'middle';
      if (layer.letterSpacing && 'letterSpacing' in context)
        context.letterSpacing = `${layer.letterSpacing}px`;
      if (layer.shadowColor) {
        context.shadowColor = layer.shadowColor;
        context.shadowBlur = layer.shadowBlur || 0;
        context.shadowOffsetX = layer.shadowX || 0;
        context.shadowOffsetY = layer.shadowY || 0;
      }
      const lines = layer.text.replace(/\r\n?/g, '\n').split('\n').slice(0, 100);
      const lineHeight = layer.fontSize * (layer.lineHeight || 1.2);
      const firstBaseline = -((lines.length - 1) * lineHeight) / 2;
      lines.forEach((line, index) => {
        const y = firstBaseline + index * lineHeight;
        if (layer.strokeWidth > 0) {
          context.strokeStyle = layer.stroke || '#ffffff';
          context.lineWidth = layer.strokeWidth;
          context.lineJoin = 'round';
          context.strokeText(line, 0, y, Math.max(1, p.width * 2));
        }
        context.fillText(line, 0, y, Math.max(1, p.width * 2));
      });
      context.shadowColor = 'transparent';
      context.shadowBlur = 0;
      context.shadowOffsetX = 0;
      context.shadowOffsetY = 0;
    } else if (layer.type === 'shape') {
      shapePath(context, layer);
      if (layer.shape !== 'line' && !(layer.shape === 'path' && !layer.closed)) {
        context.fillStyle = layer.fill;
        context.fill();
      }
      if (
        layer.strokeWidth > 0 ||
        layer.shape === 'line' ||
        (layer.shape === 'path' && !layer.closed)
      ) {
        context.strokeStyle = layer.stroke;
        context.lineWidth = Math.max(layer.shape === 'line' ? 1 : 0, layer.strokeWidth);
        context.lineJoin = 'round';
        context.lineCap = 'round';
        context.stroke();
      }
    }
  }

  // Pixel masks are drawn with destination-in so their alpha keeps the layer.
  function applyRasterMask(context, layer, resolveSource, p) {
    const mask = layer.rasterMask;
    if (!mask || !mask.enabled) return true;
    const source = resolveSource(mask.source.id);
    if (!source) return false;
    context.save();
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'destination-in';
    context.filter = 'none';
    if (layer.type === 'adjustment') context.drawImage(source, 0, 0, p.width, p.height);
    else {
      applyLayerTransform(context, layer.transform);
      context.drawImage(
        source,
        -layer.source.width / 2,
        -layer.source.height / 2,
        layer.source.width,
        layer.source.height,
      );
    }
    context.restore();
    return true;
  }

  // A scratch canvas in device pixels. By default it matches the context's canvas,
  // optionally grown by `pad` on every side. With `frame` ({ x, y, width, height }
  // in the context's pixel space) it covers just that rectangle. `ox`/`oy` record
  // where the scratch's pixel 0 sits in the context's pixel space.
  function makeScratch(env, context, pad = 0, frame = null) {
    const ox = frame ? frame.x : -pad,
      oy = frame ? frame.y : -pad;
    const width = frame ? frame.width : context.canvas.width + pad * 2,
      height = frame ? frame.height : context.canvas.height + pad * 2;
    let canvas = null;
    if (typeof env.createCanvas === 'function') canvas = env.createCanvas(width, height);
    else if (typeof OffscreenCanvas === 'function') canvas = new OffscreenCanvas(width, height);
    else if (context.canvas.ownerDocument?.createElement)
      canvas = context.canvas.ownerDocument.createElement('canvas');
    if (!canvas)
      throw new Error('Layer masks and clipping need an offscreen canvas in this browser.');
    canvas.width = width;
    canvas.height = height;
    const scratch = canvas.getContext('2d', { alpha: true });
    if (!scratch) throw new Error('Layer masks and clipping need Canvas 2D support.');
    if (typeof context.getTransform === 'function') {
      const t = context.getTransform();
      scratch.setTransform(t.a, t.b, t.c, t.d, t.e - ox, t.f - oy);
    }
    scratch.ox = (context.ox || 0) + ox;
    scratch.oy = (context.oy || 0) + oy;
    return scratch;
  }

  // Device-space bounding box of a layer's own pixels (before effects), or null
  // when it cannot be computed (then callers fall back to the whole canvas).
  function layerDeviceBounds(context, layer) {
    if (typeof context.getTransform !== 'function' || typeof DOMMatrix !== 'function') return null;
    let x0,
      y0,
      x1,
      y1,
      extra = 2;
    if (layer.type === 'image') {
      x0 = -layer.source.width / 2;
      x1 = -x0;
      y0 = -layer.source.height / 2;
      y1 = -y0;
    } else if (layer.type === 'shape') {
      let sx = 0.5,
        sy = 0.5;
      if (layer.shape === 'path')
        for (const pt of layer.points || []) {
          sx = Math.max(sx, Math.abs(pt.x), Math.abs(pt.ix), Math.abs(pt.ox));
          sy = Math.max(sy, Math.abs(pt.y), Math.abs(pt.iy), Math.abs(pt.oy));
        }
      x1 = layer.width * sx;
      x0 = -x1;
      y1 = layer.height * sy;
      y0 = -y1;
      extra += (layer.strokeWidth || 0) * 1.5 + (layer.shape === 'line' ? 4 : 0);
    } else if (layer.type === 'text') {
      if (typeof context.measureText !== 'function') return null;
      context.save();
      context.font = `${layer.italic ? 'italic ' : ''}${layer.fontWeight} ${layer.fontSize}px ${layer.fontFamily}`;
      if (layer.letterSpacing && 'letterSpacing' in context)
        context.letterSpacing = `${layer.letterSpacing}px`;
      const lines = layer.text.replace(/\r\n?/g, '\n').split('\n').slice(0, 100);
      let widest = 0;
      for (const line of lines)
        widest = Math.max(
          widest,
          context.measureText(line).width + Math.abs(layer.letterSpacing || 0) * line.length,
        );
      context.restore();
      const lineHeight = layer.fontSize * (layer.lineHeight || 1.2),
        half = ((lines.length - 1) * lineHeight) / 2 + layer.fontSize;
      x0 = layer.align === 'left' ? 0 : layer.align === 'right' ? -widest : -widest / 2;
      x1 = x0 + widest;
      y0 = -half;
      y1 = half;
      extra +=
        (layer.strokeWidth || 0) +
        (layer.shadowBlur || 0) * 2 +
        Math.max(Math.abs(layer.shadowX || 0), Math.abs(layer.shadowY || 0)) +
        layer.fontSize * 0.25;
    } else return null;
    const t = layer.transform;
    let m = new DOMMatrix([
      ...['a', 'b', 'c', 'd', 'e', 'f'].map((k) => context.getTransform()[k]),
    ]);
    m = m.translate(t.x, t.y).rotate(t.rotation || 0);
    if (t.skewX || t.skewY)
      m = m.multiply(
        new DOMMatrix([
          1,
          Math.tan(((t.skewY || 0) * Math.PI) / 180),
          Math.tan(((t.skewX || 0) * Math.PI) / 180),
          1,
          0,
          0,
        ]),
      );
    m = m.scale(t.scaleX, t.scaleY);
    const scale = Math.max(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d));
    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity;
    for (const [x, y] of [
      [x0, y0],
      [x1, y0],
      [x0, y1],
      [x1, y1],
    ]) {
      const q = m.transformPoint(new DOMPoint(x, y));
      left = Math.min(left, q.x);
      right = Math.max(right, q.x);
      top = Math.min(top, q.y);
      bottom = Math.max(bottom, q.y);
    }
    if (![left, top, right, bottom].every(Number.isFinite)) return null;
    const grow = extra * scale;
    return {
      x: left - grow,
      y: top - grow,
      width: right - left + 2 * grow,
      height: bottom - top + 2 * grow,
    };
  }
  // The scratch region for a styled layer: its bounds plus the effects' reach,
  // limited to the canvas plus that reach. Null means "use the padded canvas".
  function styleFrame(context, layer, pad) {
    const b = layerDeviceBounds(context, layer);
    if (!b) return null;
    const x = Math.max(-pad, Math.floor(b.x - pad)),
      y = Math.max(-pad, Math.floor(b.y - pad));
    const right = Math.min(context.canvas.width + pad, Math.ceil(b.x + b.width + pad)),
      bottom = Math.min(context.canvas.height + pad, Math.ceil(b.y + b.height + pad));
    if (right <= x || bottom <= y) return { x: 0, y: 0, width: 1, height: 1 };
    return { x, y, width: right - x, height: bottom - y };
  }

  // Adjustment layers read the pixels composited so far, run the pixel hook,
  // then mix the result back through the layer's opacity and mask.
  function applyAdjustmentLayer(target, layer, resolveSource, p, env) {
    if (typeof env.adjust !== 'function' || typeof target.getImageData !== 'function') {
      env.skipped.push(layer.id);
      return;
    }
    const width = target.canvas.width,
      height = target.canvas.height;
    const before = target.getImageData(0, 0, width, height);
    // Where the document frame sits in these pixels, for position-aware adjustments.
    const t =
      typeof target.getTransform === 'function'
        ? target.getTransform()
        : { a: 1, d: 1, e: 0, f: 0 };
    const geometry = {
      x: t.a * p.crop.x + t.e,
      y: t.d * p.crop.y + t.f,
      width: t.a * p.crop.width,
      height: t.d * p.crop.height,
      scale: t.a,
    };
    const processed = env.adjust({ width, height, data: before.data }, layer, geometry);
    if (!processed || !processed.data || processed.data.length !== before.data.length)
      throw new Error('An adjustment hook returned mismatched pixels.');
    let weights = null;
    if (layer.rasterMask && layer.rasterMask.enabled) {
      const source = resolveSource(layer.rasterMask.source.id);
      if (!source) {
        env.missing.push(layer.rasterMask.source.id);
        return;
      }
      const scratch = makeScratch(env, target);
      scratch.clearRect(0, 0, width, height);
      scratch.drawImage(source, 0, 0, p.width, p.height);
      weights = scratch.getImageData(0, 0, width, height).data;
    }
    const a = before.data,
      b = processed.data;
    const opacity = layer.opacity;
    for (let i = 0; i < a.length; i += 4) {
      const w = opacity * (weights ? weights[i + 3] / 255 : 1);
      if (w <= 0) continue;
      a[i] += (b[i] - a[i]) * w;
      a[i + 1] += (b[i + 1] - a[i + 1]) * w;
      a[i + 2] += (b[i + 2] - a[i + 2]) * w;
    }
    target.putImageData(before, 0, 0);
  }

  // Draw a masked or clipping-base layer into a scratch canvas at full strength.
  function renderIsolated(context, layer, resolveSource, p, env, pad = 0, frame = null) {
    const scratch = makeScratch(env, context, pad, frame);
    scratch.save();
    scratch.setTransform(1, 0, 0, 1, 0, 0);
    scratch.clearRect(0, 0, scratch.canvas.width, scratch.canvas.height);
    scratch.restore();
    scratch.save();
    drawLayerContent(scratch, layer, resolveSource, p);
    scratch.restore();
    if (!applyRasterMask(scratch, layer, resolveSource, p))
      env.missing.push(layer.rasterMask.source.id);
    return scratch;
  }

  // ---- layer style rendering. Works on device-pixel scratch canvases; sizes
  // are given in project pixels and scaled by the current view transform.
  function blankLike(env, ref) {
    const scratch = makeScratch(env, ref);
    scratch.ox = ref.ox || 0;
    scratch.oy = ref.oy || 0;
    scratch.setTransform(1, 0, 0, 1, 0, 0);
    scratch.clearRect(0, 0, scratch.canvas.width, scratch.canvas.height);
    return scratch;
  }
  function rgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  // Silhouette of src filled with one color.
  function tintCanvas(env, src, color, alpha = 1) {
    const out = blankLike(env, src);
    out.drawImage(src.canvas, 0, 0);
    out.globalCompositeOperation = 'source-in';
    out.fillStyle = rgba(color, alpha);
    out.fillRect(0, 0, out.canvas.width, out.canvas.height);
    out.globalCompositeOperation = 'source-over';
    return out;
  }
  // Only the shadow of src, offset and blurred. The source is drawn beyond the
  // canvas and its shadow thrown back in, which works without ctx.filter.
  function shadowOnly(env, src, color, alpha, blur, dx, dy) {
    const out = blankLike(env, src);
    const far = out.canvas.width + out.canvas.height + 64 + Math.ceil(blur) * 4;
    out.shadowColor = rgba(color, alpha);
    out.shadowBlur = Math.max(0, blur);
    out.shadowOffsetX = dx + far;
    out.shadowOffsetY = dy;
    out.drawImage(src.canvas, -far, 0);
    out.shadowColor = 'transparent';
    return out;
  }
  // Grow a silhouette by r pixels: stamp it around concentric rings.
  function dilate(env, src, r) {
    const out = blankLike(env, src);
    out.drawImage(src.canvas, 0, 0);
    if (r <= 0) return out;
    // Concentric rings about 1.5 px apart fill the whole disk, so thin features
    // (text dots, hairlines) grow evenly; the total stamp count stays bounded.
    const ringCount = Math.max(1, Math.min(24, Math.ceil(r / 1.5)));
    const budget = 480;
    let circumference = 0;
    for (let k = 1; k <= ringCount; k += 1) circumference += 2 * Math.PI * ((r * k) / ringCount);
    const density = Math.min(1, budget / Math.max(1, circumference));
    for (let k = ringCount; k >= 1; k -= 1) {
      const radius = (r * k) / ringCount;
      const steps = Math.max(6, Math.ceil(2 * Math.PI * radius * density));
      for (let i = 0; i < steps; i += 1) {
        const a = (i / steps) * Math.PI * 2 + k * 0.37;
        out.drawImage(src.canvas, Math.cos(a) * radius, Math.sin(a) * radius);
      }
    }
    return out;
  }
  function inverse(env, src) {
    const out = blankLike(env, src);
    out.fillStyle = '#000';
    out.fillRect(0, 0, out.canvas.width, out.canvas.height);
    out.globalCompositeOperation = 'destination-out';
    out.drawImage(src.canvas, 0, 0);
    out.globalCompositeOperation = 'source-over';
    return out;
  }
  function viewScale(context) {
    if (typeof context.getTransform !== 'function') return 1;
    const t = context.getTransform();
    return Math.hypot(t.a, t.b) || 1;
  }
  // Device-pixel margin an effect can reach beyond the layer's own pixels.
  function styleExtent(layer, k) {
    const s = layer.styles || {};
    let reach = 0;
    for (const fx of [s.dropShadow, s.innerShadow])
      if (fx) reach = Math.max(reach, fx.distance + fx.size * 1.5);
    if (s.outerGlow) reach = Math.max(reach, s.outerGlow.size * 1.5);
    if (s.stroke) reach = Math.max(reach, s.stroke.size);
    // Bounded so a huge effect on a big view cannot allocate an unbounded canvas.
    return Math.min(Math.ceil(reach * k) + 2, 1024);
  }
  // The layer's own box in scratch pixels, so overlays are laid out on the layer,
  // not on the effect-padded, view-clipped scratch area.
  function styleBox(context, layer, pad, frame) {
    const b = layerDeviceBounds(context, layer);
    if (!b) return null;
    const ox = frame ? frame.x : -pad,
      oy = frame ? frame.y : -pad;
    return { x: b.x - ox, y: b.y - oy, width: b.width, height: b.height };
  }
  function applyLayerStyles(base, layer, env, k, box = null) {
    const s = layer.styles || {};
    const out = blankLike(env, base);
    const offset = (fx) => {
      const a = (fx.angle * Math.PI) / 180;
      return [-Math.cos(a) * fx.distance * k, Math.sin(a) * fx.distance * k];
    };
    if (s.dropShadow) {
      const [dx, dy] = offset(s.dropShadow);
      out.drawImage(
        shadowOnly(
          env,
          base,
          s.dropShadow.color,
          s.dropShadow.opacity,
          s.dropShadow.size * k,
          dx,
          dy,
        ).canvas,
        0,
        0,
      );
    }
    if (s.outerGlow) {
      const glow = shadowOnly(env, base, s.outerGlow.color, 1, s.outerGlow.size * k, 0, 0);
      out.globalAlpha = s.outerGlow.opacity;
      out.drawImage(glow.canvas, 0, 0);
      out.drawImage(glow.canvas, 0, 0);
      out.globalAlpha = 1;
    }
    const strokeSize = s.stroke ? s.stroke.size * k : 0;
    if (s.stroke && s.stroke.position !== 'inside') {
      const ring = tintCanvas(
        env,
        dilate(env, base, s.stroke.position === 'center' ? strokeSize / 2 : strokeSize),
        s.stroke.color,
        s.stroke.opacity,
      );
      ring.globalCompositeOperation = 'destination-out';
      ring.drawImage(base.canvas, 0, 0);
      out.drawImage(ring.canvas, 0, 0);
    }
    // Fill: content plus overlays and inner shadow, faded by fill opacity.
    const fill = blankLike(env, base);
    fill.drawImage(base.canvas, 0, 0);
    if (s.gradientOverlay) {
      const g = s.gradientOverlay,
        a = (g.angle * Math.PI) / 180;
      const area =
        box && box.width > 0 && box.height > 0
          ? box
          : { x: 0, y: 0, width: fill.canvas.width, height: fill.canvas.height };
      const w = area.width,
        h = area.height,
        cx = area.x + w / 2,
        cy = area.y + h / 2,
        len = (Math.abs(Math.cos(a)) * w + Math.abs(Math.sin(a)) * h) / 2;
      const grad = fill.createLinearGradient(
        cx - Math.cos(a) * len,
        cy + Math.sin(a) * len,
        cx + Math.cos(a) * len,
        cy - Math.sin(a) * len,
      );
      grad.addColorStop(0, g.from);
      grad.addColorStop(1, g.to);
      fill.globalCompositeOperation = 'source-atop';
      fill.globalAlpha = g.opacity;
      fill.fillStyle = grad;
      fill.fillRect(0, 0, fill.canvas.width, fill.canvas.height);
    }
    if (s.colorOverlay) {
      fill.globalCompositeOperation = 'source-atop';
      fill.globalAlpha = s.colorOverlay.opacity;
      fill.fillStyle = s.colorOverlay.color;
      fill.fillRect(0, 0, fill.canvas.width, fill.canvas.height);
    }
    if (s.innerShadow) {
      const [dx, dy] = offset(s.innerShadow);
      fill.globalCompositeOperation = 'source-atop';
      fill.globalAlpha = 1;
      fill.drawImage(
        shadowOnly(
          env,
          inverse(env, base),
          s.innerShadow.color,
          s.innerShadow.opacity,
          s.innerShadow.size * k,
          dx,
          dy,
        ).canvas,
        0,
        0,
      );
    }
    out.globalAlpha = layer.fillOpacity < 1 ? layer.fillOpacity : 1;
    out.drawImage(fill.canvas, 0, 0);
    out.globalAlpha = 1;
    if (s.stroke && s.stroke.position !== 'outside') {
      const inner = tintCanvas(
        env,
        dilate(
          env,
          inverse(env, base),
          s.stroke.position === 'center' ? strokeSize / 2 : strokeSize,
        ),
        s.stroke.color,
        s.stroke.opacity,
      );
      inner.globalCompositeOperation = 'destination-in';
      inner.drawImage(base.canvas, 0, 0);
      out.drawImage(inner.canvas, 0, 0);
    }
    return out;
  }

  function compositeScratch(context, scratch, opacity, blendMode) {
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = opacity;
    context.globalCompositeOperation = blendMode === 'normal' ? 'source-over' : blendMode;
    context.drawImage(
      scratch.canvas,
      (scratch.ox || 0) - (context.ox || 0),
      (scratch.oy || 0) - (context.oy || 0),
    );
    context.restore();
  }

  function renderProject(context, project, resolveSource, options = {}) {
    if (!context || typeof context.save !== 'function' || typeof resolveSource !== 'function')
      throw new Error('A canvas context and source resolver are required.');
    const p = normalizeProject(project);
    const offsetCrop = options.offsetCrop !== false;
    const renderScale = clamp(options.scale, 0.001, 1, 1);
    const view =
      options.view && Number.isFinite(Number(options.view.scale))
        ? {
            scale: clamp(options.view.scale, 0.001, 64, 1),
            x: number(options.view.x),
            y: number(options.view.y),
          }
        : null;
    const report = options.report && typeof options.report === 'object' ? options.report : {};
    const env = {
      adjust: options.adjust,
      createCanvas: options.createCanvas,
      skipped: [],
      missing: [],
    };
    report.skippedAdjustments = env.skipped;
    report.missingMasks = env.missing;
    context.save();
    context.clearRect(0, 0, context.canvas.width, context.canvas.height);
    const background =
      p.background || (options.background ? hexColor(options.background, '#ffffff') : null);
    if (view) {
      // Viewport rendering: project pixels map to device pixels by scale + offset,
      // and nothing is drawn outside the crop frame.
      context.setTransform(view.scale, 0, 0, view.scale, view.x, view.y);
      context.beginPath();
      context.rect(p.crop.x, p.crop.y, p.crop.width, p.crop.height);
      context.clip();
      if (background) {
        context.filter = 'none';
        context.fillStyle = background;
        context.fillRect(p.crop.x, p.crop.y, p.crop.width, p.crop.height);
      }
    } else {
      if (background) {
        context.filter = 'none';
        context.fillStyle = background;
        context.fillRect(0, 0, context.canvas.width, context.canvas.height);
      }
      context.scale(renderScale, renderScale);
      if (offsetCrop) context.translate(-p.crop.x, -p.crop.y);
    }
    // An all-zero composition filter is the identity; 'none' skips a per-draw filter pass.
    const adjustmentsIdle = Object.values(p.adjustments).every((value) => value === 0);
    const filter = adjustmentsIdle ? 'none' : canvasFilter(p.adjustments);
    // With a composition filter, draw the layers once into a scratch canvas and
    // filter the result in a single pass (a filter per layer draw is very slow).
    // Without an offscreen canvas (tests, very old browsers) fall back to per-layer.
    let composite = null;
    if (
      filter !== 'none' &&
      p.layers.length &&
      (typeof env.createCanvas === 'function' ||
        typeof OffscreenCanvas === 'function' ||
        context.canvas.ownerDocument?.createElement)
    ) {
      composite = makeScratch(env, context);
      composite.save();
      composite.setTransform(1, 0, 0, 1, 0, 0);
      composite.clearRect(0, 0, composite.canvas.width, composite.canvas.height);
      composite.restore();
    }
    const target = composite || context;
    const layerFilter = composite ? 'none' : filter;
    target.filter = layerFilter;
    const groupMap = new Map((p.groups || []).map((group) => [group.id, group]));
    compositeLayers(target, p.layers, null);

    function compositeLayers(into, layers, insideGroup) {
      for (let index = 0; index < layers.length; index += 1) {
        const layer = layers[index];
        // A run of consecutive members of one group renders as that group.
        if (layer.groupId && layer.groupId !== insideGroup && groupMap.has(layer.groupId)) {
          let end = index + 1;
          while (end < layers.length && layers[end].groupId === layer.groupId) end += 1;
          const members = layers.slice(index, end);
          index = end - 1;
          const group = groupMap.get(layer.groupId);
          if (!group.visible || group.opacity <= 0) continue;
          if (group.blendMode === 'pass-through' && group.opacity >= 1) {
            compositeLayers(into, members, group.id);
            continue;
          }
          const scratch = makeScratch(env, into);
          scratch.save();
          scratch.setTransform(1, 0, 0, 1, 0, 0);
          scratch.clearRect(0, 0, scratch.canvas.width, scratch.canvas.height);
          scratch.restore();
          scratch.filter = 'none';
          compositeLayers(scratch, members, group.id);
          into.save();
          into.filter = layerFilter;
          compositeScratch(
            into,
            scratch,
            group.opacity,
            group.blendMode === 'pass-through' ? 'normal' : group.blendMode,
          );
          into.restore();
          continue;
        }
        // Collect layers clipped to this one (a clipping group), within the same group.
        let end = index + 1;
        while (
          end < layers.length &&
          layers[end].clip &&
          (layers[end].groupId || null) === (layer.groupId || null)
        )
          end += 1;
        const clipped = layers.slice(index + 1, end);
        index = end - 1;
        if (!layer.visible || layer.opacity <= 0) continue;
        if (layer.type === 'adjustment') {
          into.save();
          into.filter = 'none';
          applyAdjustmentLayer(into, layer, resolveSource, p, env);
          into.restore();
          continue;
        }
        const visibleClipped = clipped.filter((item) => item.visible && item.opacity > 0);
        const styled = layer.type !== 'adjustment' && hasLayerStyles(layer);
        if (!visibleClipped.length && !styled && !(layer.rasterMask && layer.rasterMask.enabled)) {
          // Plain layer: identical drawing path to version 0.2.
          into.save();
          into.globalAlpha = layer.opacity;
          into.globalCompositeOperation =
            layer.blendMode === 'normal' ? 'source-over' : layer.blendMode;
          drawLayerContent(into, layer, resolveSource, p);
          into.restore();
          continue;
        }
        // Styled layers render with a margin so effects keep their context at view edges.
        // Only the layer's own area (plus the effects' reach) is allocated, never a
        // whole padded export canvas per effect pass.
        const pad = styled ? styleExtent(layer, viewScale(into)) : 0;
        const frame = styled ? styleFrame(into, layer, pad) : null;
        const base = renderIsolated(into, layer, resolveSource, p, env, pad, frame);
        for (const item of visibleClipped) {
          if (item.type === 'adjustment') {
            applyAdjustmentLayer(base, item, resolveSource, p, env);
            continue;
          }
          let piece = renderIsolated(into, item, resolveSource, p, env, pad, frame);
          // A clipped layer keeps its own effects; the base still clips them.
          if (hasLayerStyles(item))
            piece = applyLayerStyles(
              piece,
              item,
              env,
              viewScale(into),
              styleBox(into, item, pad, frame),
            );
          piece.save();
          piece.setTransform(1, 0, 0, 1, 0, 0);
          piece.globalCompositeOperation = 'destination-in';
          piece.drawImage(base.canvas, 0, 0);
          piece.restore();
          compositeScratch(base, piece, item.opacity, item.blendMode);
        }
        const finished = styled
          ? applyLayerStyles(base, layer, env, viewScale(into), styleBox(into, layer, pad, frame))
          : base;
        into.save();
        into.filter = layerFilter;
        compositeScratch(into, finished, layer.opacity, layer.blendMode);
        into.restore();
      }
    }
    if (composite) {
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalAlpha = 1;
      context.globalCompositeOperation = 'source-over';
      context.filter = filter;
      context.drawImage(composite.canvas, 0, 0);
      context.restore();
    }
    context.restore();
    return Object.freeze({
      width: p.crop.width,
      height: p.crop.height,
      layers: p.layers.length,
      scale: view ? view.scale : renderScale,
    });
  }

  function imageSourceMap(project) {
    const p = normalizeProject(project);
    const sources = new Map();
    const referenced = [];
    for (const layer of p.layers) {
      if (layer.type === 'image') referenced.push(layer.source);
      if (layer.rasterMask) referenced.push(layer.rasterMask.source);
    }
    for (const source of referenced) {
      const existing = sources.get(source.id);
      if (
        existing &&
        (existing.mime !== source.mime ||
          existing.width !== source.width ||
          existing.height !== source.height ||
          existing.size !== source.size)
      ) {
        throw new Error('Image layers sharing one source id must share identical source metadata.');
      }
      if (!existing) sources.set(source.id, clone(source));
    }
    return { project: p, sources };
  }

  function portableSourceDescriptor(value) {
    const id = String(value?.id || '').trim();
    const mime = String(value?.mime || '').toLowerCase();
    const size = Number(value?.size);
    const width = Number(value?.width);
    const height = Number(value?.height);
    const sha256 = String(value?.sha256 || '').toLowerCase();
    if (!isSafeSourceId(id)) throw new Error('Portable project source id is invalid.');
    if (!/^image\/(png|jpeg|webp|gif)$/.test(mime))
      throw new Error('Portable projects support PNG, JPEG, WebP, and GIF source images.');
    if (!Number.isInteger(size) || size < 1 || size > MAX_SOURCE_BYTES)
      throw new Error('Portable project source size is invalid.');
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > MAX_DIMENSION ||
      height > MAX_DIMENSION ||
      width * height > MAX_CANVAS_PIXELS
    )
      throw new Error('Portable project source dimensions are invalid.');
    if (!/^[0-9a-f]{64}$/.test(sha256))
      throw new Error('Portable project source digest is invalid.');
    return {
      id,
      name: boundedString(value?.name, 'Local image', 180),
      mime,
      width,
      height,
      size,
      sha256,
    };
  }

  function normalizePortableManifest(value) {
    if (
      !value ||
      value.schema !== PORTABLE_SCHEMA ||
      Number(value.schemaVersion) !== PORTABLE_SCHEMA_VERSION
    )
      throw new Error('Unsupported portable AlcorPhoto project.');
    const mapped = imageSourceMap(value.project);
    if (!Array.isArray(value.sources) || value.sources.length > MAX_RUNTIME_SOURCES)
      throw new Error(`Portable projects support at most ${MAX_RUNTIME_SOURCES} image sources.`);
    const descriptors = value.sources.map(portableSourceDescriptor);
    const descriptorMap = new Map();
    let bytes = 0;
    for (const descriptor of descriptors) {
      if (descriptorMap.has(descriptor.id))
        throw new Error('Portable project source ids must be unique.');
      descriptorMap.set(descriptor.id, descriptor);
      bytes += descriptor.size;
      if (bytes > MAX_PORTABLE_SOURCE_BYTES)
        throw new Error(`Portable source bytes are limited to ${MAX_PORTABLE_SOURCE_BYTES} bytes.`);
      const expected = mapped.sources.get(descriptor.id);
      if (
        !expected ||
        expected.mime !== descriptor.mime ||
        expected.width !== descriptor.width ||
        expected.height !== descriptor.height ||
        expected.size !== descriptor.size
      ) {
        throw new Error('Portable project source metadata does not match the project.');
      }
    }
    const expectedIds = [...mapped.sources.keys()].sort();
    const actualIds = [...descriptorMap.keys()].sort();
    if (
      expectedIds.length !== actualIds.length ||
      expectedIds.some((id, index) => id !== actualIds[index])
    )
      throw new Error(
        'Portable project must contain exactly the image sources referenced by the project.',
      );
    return {
      schema: PORTABLE_SCHEMA,
      schemaVersion: PORTABLE_SCHEMA_VERSION,
      project: mapped.project,
      sources: descriptors,
    };
  }

  async function sha256Hex(blob) {
    if (!(blob instanceof Blob) || !globalThis.crypto?.subtle)
      throw new Error('Portable project integrity checks are unavailable in this browser.');
    const digest = new Uint8Array(
      await globalThis.crypto.subtle.digest('SHA-256', await blob.arrayBuffer()),
    );
    return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function createPortableBundle(project, sourceBlobs) {
    if (!(sourceBlobs instanceof Map))
      throw new Error('Portable project source blobs must be supplied as a Map.');
    const mapped = imageSourceMap(project);
    const descriptors = [];
    const blobs = [];
    for (const [id, metadata] of mapped.sources) {
      const blob = sourceBlobs.get(id);
      if (
        !(blob instanceof Blob) ||
        blob.size !== metadata.size ||
        blob.type.toLowerCase() !== metadata.mime
      )
        throw new Error(`Relink ${metadata.name} before downloading a portable project.`);
      descriptors.push({ ...metadata, sha256: await sha256Hex(blob) });
      blobs.push(blob);
    }
    const manifest = normalizePortableManifest({
      schema: PORTABLE_SCHEMA,
      schemaVersion: PORTABLE_SCHEMA_VERSION,
      project: mapped.project,
      sources: descriptors,
    });
    const encoder = new TextEncoder();
    const magic = encoder.encode(PORTABLE_MAGIC);
    const header = encoder.encode(JSON.stringify(manifest));
    if (header.byteLength > MAX_PORTABLE_HEADER_BYTES)
      throw new Error('Portable project metadata is too large.');
    const length = new ArrayBuffer(4);
    new DataView(length).setUint32(0, header.byteLength, false);
    const result = new Blob([magic, length, header, ...blobs], {
      type: 'application/x-alcorphoto',
    });
    if (result.size > MAX_PORTABLE_FILE_BYTES)
      throw new Error(`Portable project files are limited to ${MAX_PORTABLE_FILE_BYTES} bytes.`);
    return result;
  }

  async function isPortableBundle(blob) {
    if (!(blob instanceof Blob) || blob.size < PORTABLE_MAGIC.length + 4) return false;
    return (
      new TextDecoder().decode(await blob.slice(0, PORTABLE_MAGIC.length).arrayBuffer()) ===
      PORTABLE_MAGIC
    );
  }

  async function readPortableBundle(blob) {
    if (
      !(blob instanceof Blob) ||
      blob.size < PORTABLE_MAGIC.length + 5 ||
      blob.size > MAX_PORTABLE_FILE_BYTES
    )
      throw new Error('Portable project file size is invalid.');
    if (!(await isPortableBundle(blob))) throw new Error('Not a portable AlcorPhoto project.');
    const prefixSize = PORTABLE_MAGIC.length + 4;
    const prefix = new DataView(await blob.slice(PORTABLE_MAGIC.length, prefixSize).arrayBuffer());
    const headerLength = prefix.getUint32(0, false);
    if (
      headerLength < 2 ||
      headerLength > MAX_PORTABLE_HEADER_BYTES ||
      prefixSize + headerLength > blob.size
    )
      throw new Error('Portable project header length is invalid.');
    let raw;
    try {
      raw = JSON.parse(await blob.slice(prefixSize, prefixSize + headerLength).text());
    } catch (error) {
      throw new Error('Portable project metadata is not valid JSON.');
    }
    const manifest = normalizePortableManifest(raw);
    let offset = prefixSize + headerLength;
    const sources = [];
    for (const descriptor of manifest.sources) {
      const end = offset + descriptor.size;
      if (end > blob.size) throw new Error('Portable project image payload is truncated.');
      const sourceBlob = blob.slice(offset, end, descriptor.mime);
      if ((await sha256Hex(sourceBlob)) !== descriptor.sha256)
        throw new Error(`Portable project integrity check failed for ${descriptor.name}.`);
      sources.push({ metadata: descriptor, blob: sourceBlob });
      offset = end;
    }
    if (offset !== blob.size)
      throw new Error('Portable project contains unexpected trailing bytes.');
    return { project: manifest.project, sources };
  }

  function mimeForFormat(format) {
    const mime = EXPORT_MIMES[String(format || '').toLowerCase()];
    if (!mime) throw new Error('Choose PNG, JPEG, WebP, or SVG.');
    return mime;
  }

  return Object.freeze({
    version: '0.3.0',
    SCHEMA,
    SCHEMA_VERSION,
    MAX_DIMENSION,
    MAX_CANVAS_PIXELS,
    MAX_LAYERS,
    MAX_SOURCE_BYTES,
    MAX_RUNTIME_SOURCES,
    MAX_RUNTIME_DECODED_PIXELS,
    PORTABLE_SCHEMA,
    PORTABLE_SCHEMA_VERSION,
    PORTABLE_MAGIC,
    MAX_PORTABLE_HEADER_BYTES,
    MAX_PORTABLE_SOURCE_BYTES,
    MAX_PORTABLE_FILE_BYTES,
    EXPORT_MIMES,
    BLEND_MODES,
    ADJUSTMENT_KINDS,
    LAYER_TYPES,
    SHAPE_TYPES,
    FONT_STACKS,
    LAYER_STYLE_KEYS,
    shapePath,
    normalizeLayerStyles,
    hasLayerStyles,
    createProject,
    createSourceBudget,
    normalizeProject,
    addImageLayer,
    relinkImageLayer,
    addTextLayer,
    addShapeLayer,
    updateLayer,
    removeLayer,
    duplicateLayer,
    moveLayer,
    moveLayerTo,
    addRasterLayer,
    addAdjustmentLayer,
    setRasterMask,
    createGroup,
    setLayerGroup,
    updateGroup,
    removeGroup,
    MAX_GROUPS,
    imageSourceMap,
    setCrop,
    setAdjustments,
    setBackground,
    resizeCanvas,
    flipLayer,
    canvasFilter,
    outputSize,
    renderProject,
    normalizePortableManifest,
    createPortableBundle,
    isPortableBundle,
    readPortableBundle,
    mimeForFormat,
  });
});
