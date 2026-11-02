/**
 * alcor-photo-studio.js: AlcorPhoto Studio workspace.
 *
 * Pixel-editing tools, selections, masks, adjustment layers, filters, history,
 * colour and shortcuts. Attaches through the editor's extension API.
 */
(function () {
  'use strict';

  // AlcorPhoto Studio: the pixel-editing workspace. Tools, selections, pixel
  // layers, masks, adjustment-layer controls, filters, history, color, and
  // keyboard shortcuts. Attaches through the editor extension API exposed by
  // alcor-photo.js; everything runs locally in this tab.

  const scriptTag = document.currentScript;
  (globalThis.AlcorPhotoExtensions = globalThis.AlcorPhotoExtensions || []).push(install);

  const TOOLS = Object.freeze([
    { id: 'move', key: 'v', label: 'Move' },
    { id: 'marquee', key: 'm', label: 'Marquee', variants: ['rectangle', 'ellipse'] },
    { id: 'lasso', key: 'l', label: 'Lasso', variants: ['free', 'polygon'] },
    { id: 'wand', key: 'w', label: 'Magic Wand' },
    { id: 'crop', key: 'c', label: 'Crop' },
    { id: 'eyedropper', key: 'i', label: 'Eyedropper' },
    { id: 'heal', key: 'j', label: 'Spot Healing', variants: ['spot', 'healing', 'redeye'] },
    { id: 'brush', key: 'b', label: 'Brush' },
    { id: 'clone', key: 's', label: 'Clone Stamp' },
    { id: 'eraser', key: 'e', label: 'Eraser' },
    { id: 'tone', key: 'o', label: 'Dodge', variants: ['dodge', 'burn', 'sponge'] },
    { id: 'focus', key: 'r', label: 'Blur', variants: ['blur', 'sharpen'] },
    { id: 'fill', key: 'g', label: 'Paint Bucket', variants: ['bucket', 'gradient'] },
    { id: 'type', key: 't', label: 'Type' },
    { id: 'pen', key: 'p', label: 'Pen' },
    { id: 'shape', key: 'u', label: 'Rectangle', variants: ['rect-shape', 'ellipse-shape'] },
    { id: 'hand', key: 'h', label: 'Hand' },
    { id: 'zoom', key: 'z', label: 'Zoom' },
  ]);
  const ICONS = Object.freeze({
    move: '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
    marquee: '<rect x="4" y="5" width="16" height="14" rx="1" stroke-dasharray="3 2.5"/>',
    lasso: '<path d="M5 13c-2-5 3-9 8-8s7 5 4 8-9 3-11 1"/><path d="M6 14c-1 2 0 4 2 4s2 2 1 3"/>',
    wand: '<path d="M4 20 15 9"/><path d="m15 9 2-2"/><path d="M17 3v2M20 7h-2M19 4l-1 1M13 5l1 1"/>',
    crop: '<path d="M7 2v15h15"/><path d="M2 7h15v15"/>',
    eyedropper:
      '<path d="m14 4 6 6"/><path d="m17 7-9.5 9.5L4 20l3.5-3.5"/><path d="m13 5 6 6-2 2-6-6z"/>',
    heal: '<rect x="3" y="9" width="18" height="6" rx="3" transform="rotate(-45 12 12)"/><path d="M11 11h2v2h-2z"/>',
    brush: '<path d="M14 4l6 6-8 8H6v-6z"/><path d="m4 20 2-2"/>',
    clone: '<path d="M8 3h8v5l3 3H5l3-3z"/><path d="M5 14h14v3H5zM7 20h10"/>',
    eraser: '<path d="m15 4 5 5-10 10H5l-2-2z"/><path d="M9 9l6 6M12 19h8"/>',
    tone: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',
    focus: '<path d="M12 3c3 4 6 7 6 11a6 6 0 0 1-12 0c0-4 3-7 6-11z"/>',
    fill: '<path d="m5 11 7-7 7 7-7 7z"/><path d="M19 15c0 2 1 3 1 4a1 1 0 0 1-2 0c0-1 1-2 1-4z" fill="currentColor"/>',
    type: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
    shape: '<rect x="3" y="5" width="11" height="9" rx="1"/><circle cx="16" cy="15" r="5"/>',
    pen: '<path d="M12 19l7-7 3 3-7 7z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18z"/><path d="M2 2l7.6 7.6"/><circle cx="11" cy="11" r="2"/>',
    hand: '<path d="M8 12V6a1.5 1.5 0 0 1 3 0v5M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v7c0 4-2 7-6 7-3 0-4-2-6-5l-1.5-2.5a1.5 1.5 0 0 1 2.5-1.5L8 13"/>',
    zoom: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5M10 7v6M7 10h6"/>',
    swap: '<path d="M7 4 3 8l4 4M3 8h12M17 20l4-4-4-4M21 16H9"/>',
    undo: '<path d="M9 7 4 12l5 5"/><path d="M4 12h11a5 5 0 0 1 0 10h-2"/>',
    redo: '<path d="m15 7 5 5-5 5"/><path d="M20 12H9a5 5 0 0 0 0 10h2"/>',
    image:
      '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 17-5-5-9 8"/>',
    check: '<path d="m5 12 5 5 9-10"/>',
    alert: '<path d="M12 4 2 20h20z"/><path d="M12 10v4M12 17v.5"/>',
    reset:
      '<rect x="3" y="3" width="11" height="11" fill="currentColor"/><rect x="10" y="10" width="11" height="11"/>',
    open: '<path d="m6 9 6 6 6-6"/>',
    closed: '<path d="m9 6 6 6-6 6"/>',
    clip: '<path d="M8 4v10h10M14 10l4 4-4 4"/>',
  });
  const icon = (name, size = 18) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
  const VARIANT_LABELS = Object.freeze({
    rectangle: 'Rectangular Marquee',
    ellipse: 'Elliptical Marquee',
    free: 'Lasso',
    polygon: 'Polygonal Lasso',
    spot: 'Spot Healing Brush',
    healing: 'Healing Brush',
    redeye: 'Red Eye',
    bucket: 'Paint Bucket',
    gradient: 'Gradient',
    dodge: 'Dodge',
    burn: 'Burn',
    sponge: 'Sponge',
    blur: 'Blur',
    sharpen: 'Sharpen',
    'rect-shape': 'Rectangle',
    'ellipse-shape': 'Ellipse',
  });
  const PAINT_TOOLS = new Set(['brush', 'eraser', 'clone', 'tone', 'focus']);
  const ADJUSTMENT_LABELS = Object.freeze({
    levels: 'Levels',
    curves: 'Curves',
    'hue-saturation': 'Hue/Saturation',
    vibrance: 'Vibrance',
    'color-balance': 'Color Balance',
    'brightness-contrast': 'Brightness/Contrast',
    exposure: 'Exposure',
    'black-white': 'Black & White',
    invert: 'Invert',
    threshold: 'Threshold',
    'gradient-map': 'Gradient Map',
    'photo-filter': 'Photo Filter',
    posterize: 'Posterize',
    'channel-mixer': 'Channel Mixer',
    develop: 'Develop',
    'selective-color': 'Selective Color',
  });
  const FILTER_MENU = Object.freeze([
    {
      name: 'shadows-highlights',
      label: 'Shadows / Highlights…',
      group: 'Tone',
      fullContext: true,
      preserveAlpha: true,
      params: [
        { key: 'shadows', label: 'Shadows %', min: 0, max: 100, step: 1, value: 35 },
        { key: 'highlights', label: 'Highlights %', min: 0, max: 100, step: 1, value: 0 },
        { key: 'shadowTone', label: 'Shadow tonal width %', min: 1, max: 100, step: 1, value: 50 },
        {
          key: 'highlightTone',
          label: 'Highlight tonal width %',
          min: 1,
          max: 100,
          step: 1,
          value: 50,
        },
        { key: 'radius', label: 'Radius px', min: 0, max: 250, step: 1, value: 30, scale: true },
        { key: 'color', label: 'Color correction %', min: -100, max: 100, step: 1, value: 20 },
        { key: 'midtone', label: 'Midtone contrast %', min: -100, max: 100, step: 1, value: 0 },
      ],
    },
    {
      name: 'auto-contrast',
      label: 'Auto Contrast…',
      group: 'Tone',
      fullContext: true,
      preserveAlpha: true,
      params: [
        { key: 'amount', label: 'Amount %', min: 0, max: 100, step: 1, value: 100 },
        { key: 'clip', label: 'Clip each end %', min: 0, max: 5, step: 0.1, value: 0.1 },
      ],
    },
    {
      name: 'auto-tone',
      label: 'Auto Tone…',
      group: 'Tone',
      fullContext: true,
      preserveAlpha: true,
      params: [
        { key: 'amount', label: 'Amount %', min: 0, max: 100, step: 1, value: 100 },
        { key: 'clip', label: 'Clip each end %', min: 0, max: 5, step: 0.1, value: 0.1 },
      ],
    },
    {
      name: 'equalize',
      label: 'Equalize…',
      group: 'Tone',
      fullContext: true,
      preserveAlpha: true,
      params: [{ key: 'amount', label: 'Amount %', min: 0, max: 100, step: 1, value: 100 }],
    },
    {
      name: 'gaussian-blur',
      label: 'Gaussian Blur…',
      group: 'Blur',
      params: [
        { key: 'radius', label: 'Radius', min: 0.1, max: 250, step: 0.1, value: 4, scale: true },
      ],
    },
    {
      name: 'motion-blur',
      label: 'Motion Blur…',
      group: 'Blur',
      params: [
        { key: 'angle', label: 'Angle', min: -180, max: 180, step: 1, value: 0 },
        { key: 'distance', label: 'Distance', min: 1, max: 999, step: 1, value: 20, scale: true },
      ],
    },
    {
      name: 'unsharp-mask',
      label: 'Unsharp Mask…',
      group: 'Sharpen',
      params: [
        { key: 'amount', label: 'Amount %', min: 1, max: 500, step: 1, value: 100 },
        { key: 'radius', label: 'Radius', min: 0.1, max: 250, step: 0.1, value: 1.5, scale: true },
        { key: 'threshold', label: 'Threshold', min: 0, max: 255, step: 1, value: 0 },
      ],
    },
    { name: 'sharpen', label: 'Sharpen', group: 'Sharpen', params: [] },
    {
      name: 'add-noise',
      label: 'Add Noise…',
      group: 'Noise',
      params: [
        { key: 'amount', label: 'Amount %', min: 0.1, max: 400, step: 0.1, value: 12 },
        {
          key: 'distribution',
          label: 'Gaussian',
          type: 'check',
          on: 'gaussian',
          off: 'uniform',
          value: 'gaussian',
        },
        { key: 'monochromatic', label: 'Monochromatic', type: 'check', value: false },
      ],
    },
    {
      name: 'reduce-noise',
      label: 'Median (Reduce Noise)…',
      group: 'Noise',
      params: [
        { key: 'radius', label: 'Radius', min: 1, max: 2, step: 1, value: 1 },
        { key: 'strength', label: 'Strength %', min: 0, max: 100, step: 1, value: 100 },
      ],
    },
    {
      name: 'pixelate',
      label: 'Mosaic…',
      group: 'Pixelate',
      params: [
        { key: 'cellSize', label: 'Cell size', min: 2, max: 512, step: 1, value: 12, scale: true },
      ],
    },
    {
      name: 'emboss',
      label: 'Emboss…',
      group: 'Stylize',
      params: [
        { key: 'angle', label: 'Angle', min: -180, max: 180, step: 1, value: 135 },
        { key: 'height', label: 'Height', min: 1, max: 10, step: 1, value: 3 },
        { key: 'amount', label: 'Amount %', min: 1, max: 500, step: 1, value: 100 },
      ],
    },
    {
      name: 'high-pass',
      label: 'High Pass…',
      group: 'Other',
      params: [
        { key: 'radius', label: 'Radius', min: 0.1, max: 250, step: 0.1, value: 10, scale: true },
      ],
    },
  ]);

  function install(editor) {
    const Core = globalThis.AlcorPhotoCore;
    const Px = globalThis.AlcorPhotoPixels;
    const Raster = globalThis.AlcorPhotoRaster;
    const Bg = globalThis.AlcorPhotoBackground;
    const root = editor.root;
    const canvas = editor.elements.canvas;
    const viewport = canvas.parentElement;
    if (!Core || !Px || !Raster || !Bg || !viewport) return;
    root.dataset.studio = 'true';

    const pixelScript =
      document.querySelector('script[src*="alcor-photo-pixels"]')?.src ||
      (scriptTag?.src
        ? scriptTag.src.replace(/alcor-photo-studio\.js/, 'alcor-photo-pixels.js')
        : null);
    const worker = Px.createPixelWorker(pixelScript);
    const makeCanvas = (width, height) => {
      const value = document.createElement('canvas');
      value.width = Math.max(1, Math.round(width));
      value.height = Math.max(1, Math.round(height));
      return value;
    };
    const ctx2d = (target, read = false) => {
      const context = target.getContext('2d', read ? { willReadFrequently: true } : undefined);
      if (!context) throw new Error('Canvas 2D is unavailable in this browser.');
      return context;
    };
    const rasters = Raster.createRasterStore({ createCanvas: makeCanvas });
    const store = () => editor.store;
    const project = () => editor.store.project;
    const status = (message, level) => editor.status(message, level);

    // ------------------------------------------------------------ state

    const state = {
      tool: 'move',
      variant: {
        marquee: 'rectangle',
        lasso: 'free',
        heal: 'spot',
        fill: 'bucket',
        tone: 'dodge',
        focus: 'blur',
        shape: 'rect-shape',
      },
      fg: '#000000',
      bg: '#ffffff',
      brush: { size: 40, hardness: 0.8, opacity: 1, flow: 1, spacing: 0.12, pressure: true },
      eraser: { size: 40, hardness: 0.8, opacity: 1, flow: 1, spacing: 0.12, pressure: true },
      clone: {
        size: 60,
        hardness: 0.5,
        opacity: 1,
        flow: 1,
        spacing: 0.12,
        pressure: false,
        aligned: true,
        source: null,
        offset: null,
      },
      heal: { size: 40, hardness: 0.5, source: null, offset: null, aligned: true },
      tone: {
        size: 80,
        hardness: 0.3,
        opacity: 1,
        flow: 0.25,
        spacing: 0.12,
        pressure: false,
        exposure: 50,
        range: 'midtones',
        sponge: 'desaturate',
      },
      focus: {
        size: 60,
        hardness: 0.3,
        opacity: 1,
        flow: 0.3,
        spacing: 0.12,
        pressure: false,
        strength: 50,
      },
      bucket: { tolerance: 32, contiguous: true, antiAlias: true, opacity: 1 },
      gradient: { type: 'linear', reverse: false, opacity: 1 },
      wand: { tolerance: 32, contiguous: true, antiAlias: true, sample: 'layer' },
      eyedropper: { sample: 'all', size: 1 },
      selection: { mode: 'new', feather: 0, antiAlias: true },
      crop: { ratio: 'free', box: null },
      type: {
        fontFamily: 'Inter, system-ui, sans-serif',
        fontSize: 72,
        fontWeight: 700,
        italic: false,
        align: 'center',
        lineHeight: 1.2,
        letterSpacing: 0,
      },
      targetMask: false,
      selectedGroup: null,
      snap: true,
      showGuides: true,
      spaceDown: false,
      transform: null,
      recent: [],
    };
    try {
      const saved = JSON.parse(localStorage.getItem('alcorphoto.studio.prefs') || 'null');
      if (saved && typeof saved === 'object') {
        for (const key of [
          'brush',
          'eraser',
          'clone',
          'heal',
          'tone',
          'focus',
          'bucket',
          'wand',
          'eyedropper',
          'type',
        ])
          if (saved[key]) Object.assign(state[key], saved[key]);
        if (/^#[0-9a-f]{6}$/i.test(saved.fg)) state.fg = saved.fg;
        if (/^#[0-9a-f]{6}$/i.test(saved.bg)) state.bg = saved.bg;
        if (Array.isArray(saved.recent))
          state.recent = saved.recent.filter((value) => /^#[0-9a-f]{6}$/i.test(value)).slice(0, 12);
      }
    } catch {
      /* preferences are optional */
    }
    function savePrefs() {
      try {
        const { brush, eraser, heal, tone, focus, bucket, wand, eyedropper, type, fg, bg, recent } =
          state;
        const clone = {
          size: state.clone.size,
          hardness: state.clone.hardness,
          opacity: state.clone.opacity,
          flow: state.clone.flow,
          aligned: state.clone.aligned,
        };
        localStorage.setItem(
          'alcorphoto.studio.prefs',
          JSON.stringify({
            brush,
            eraser,
            clone,
            heal,
            tone,
            focus,
            bucket,
            wand,
            eyedropper,
            type,
            fg,
            bg,
            recent,
          }),
        );
      } catch {
        /* storage may be blocked */
      }
    }

    // ------------------------------------------------------------ geometry

    function layerSize(layer) {
      if (layer.type === 'image') return { width: layer.source.width, height: layer.source.height };
      return { width: project().width, height: project().height };
    }

    // Maps layer pixel coordinates to project coordinates.
    function layerMatrix(layer) {
      if (layer.type === 'adjustment') return new DOMMatrix();
      const t = layer.transform;
      const size = layerSize(layer);
      let matrix = new DOMMatrix().translate(t.x, t.y).rotate(t.rotation || 0);
      if (t.skewX || t.skewY)
        matrix = matrix.multiply(
          new DOMMatrix([
            1,
            Math.tan(((t.skewY || 0) * Math.PI) / 180),
            Math.tan(((t.skewX || 0) * Math.PI) / 180),
            1,
            0,
            0,
          ]),
        );
      return matrix.scale(t.scaleX, t.scaleY).translate(-size.width / 2, -size.height / 2);
    }
    const projectToLayer = (layer, point) =>
      layerMatrix(layer).inverse().transformPoint(new DOMPoint(point.x, point.y));
    const layerToProject = (layer, point) =>
      layerMatrix(layer).transformPoint(new DOMPoint(point.x, point.y));
    function layerScale(layer) {
      if (layer.type !== 'image') return 1;
      const t = layer.transform;
      return Math.max(0.0001, Math.sqrt(Math.abs(t.scaleX * t.scaleY)));
    }
    function isIdentityPlaced(layer) {
      const t = layer.transform;
      if (layer.type !== 'image') return true;
      const size = layerSize(layer);
      return (
        t.rotation % 360 === 0 &&
        !t.skewX &&
        !t.skewY &&
        t.scaleX === 1 &&
        t.scaleY === 1 &&
        Number.isInteger(t.x - size.width / 2) &&
        Number.isInteger(t.y - size.height / 2)
      );
    }

    // ------------------------------------------------------------ selection storage

    const selections = new Map(); // id -> { width, height, runs, bounds }
    let selectionCache = { id: null, mask: null, canvas: null, outline: null };
    let lastSelectionId = null;

    function currentSelection() {
      const id = project().selection?.id;
      if (!id) return null;
      const entry = selections.get(id);
      if (!entry || entry.width !== project().width || entry.height !== project().height)
        return null;
      if (selectionCache.id !== id) {
        selectionCache = {
          id,
          mask: Raster.decodeRuns(entry.runs, entry.width * entry.height),
          canvas: null,
          outline: null,
        };
      }
      return {
        id,
        mask: selectionCache.mask,
        width: entry.width,
        height: entry.height,
        bounds: entry.bounds,
      };
    }

    // A one-off project-space mask used in place of the selection (Basic Remove brush),
    // so a fill can run without adding selection steps to the history.
    let selectionOverride = null;
    function selectionCanvas() {
      if (selectionOverride) return selectionOverride;
      const selection = currentSelection();
      if (!selection) return null;
      if (!selectionCache.canvas) {
        const value = makeCanvas(selection.width, selection.height);
        const context = ctx2d(value);
        const image = context.createImageData(selection.width, selection.height);
        for (let i = 0, p = 3; i < selection.mask.length; i += 1, p += 4)
          image.data[p] = selection.mask[i];
        context.putImageData(image, 0, 0);
        selectionCache.canvas = value;
      }
      return selectionCache.canvas;
    }

    function commitSelection(mask, label) {
      const p = project();
      let next;
      if (!mask) {
        if (!p.selection) return false;
        next = { ...p };
        delete next.selection;
      } else {
        const bounds = Px.maskBounds(mask, p.width, p.height);
        if (!bounds) return commitSelection(null, label);
        const id = `sel-${Raster.randomId().slice(3)}`;
        selections.set(id, {
          width: p.width,
          height: p.height,
          runs: Raster.encodeRuns(mask),
          bounds,
        });
        lastSelectionId = id;
        next = { ...p, selection: { id } };
      }
      store().replace(next, label);
      return true;
    }

    function combineSelection(incoming, mode, label) {
      const existing = currentSelection();
      const feather = state.selection.feather;
      const p = project();
      const shaped = feather > 0 ? Px.featherMask(incoming, p.width, p.height, feather) : incoming;
      const mask = existing
        ? Px.combineMasks(existing.mask, shaped, mode)
        : mode === 'subtract' || mode === 'intersect'
          ? null
          : shaped;
      commitSelection(mask, label);
    }

    function modifiers(event) {
      if (event.shiftKey && event.altKey) return 'intersect';
      if (event.shiftKey) return 'add';
      if (event.altKey) return 'subtract';
      return state.selection.mode;
    }

    // Selection alpha re-projected into a layer's pixel grid.
    function selectionInLayer(layer) {
      const selection = selectionCanvas();
      if (!selection) return null;
      const size = layerSize(layer);
      const out = makeCanvas(size.width, size.height);
      const context = ctx2d(out);
      context.setTransform(layerMatrix(layer).inverse());
      context.drawImage(selection, 0, 0);
      return out;
    }

    // A layer-space alpha canvas (e.g. wand result) re-projected onto the project grid.
    function layerMaskToProject(layer, mask, width, height) {
      const p = project();
      const source = makeCanvas(width, height);
      const context = ctx2d(source);
      const image = context.createImageData(width, height);
      for (let i = 0, k = 3; i < mask.length; i += 1, k += 4) image.data[k] = mask[i];
      context.putImageData(image, 0, 0);
      if (isIdentityPlaced(layer) && layer.type === 'image') {
        const size = layerSize(layer);
        const ox = layer.transform.x - size.width / 2,
          oy = layer.transform.y - size.height / 2;
        const out = new Uint8ClampedArray(p.width * p.height);
        for (let y = 0; y < height; y += 1) {
          const py = y + oy;
          if (py < 0 || py >= p.height) continue;
          for (let x = 0; x < width; x += 1) {
            const px = x + ox;
            if (px < 0 || px >= p.width) continue;
            out[py * p.width + px] = mask[y * width + x];
          }
        }
        return out;
      }
      const target = makeCanvas(p.width, p.height);
      const targetContext = ctx2d(target, true);
      targetContext.setTransform(layerMatrix(layer));
      targetContext.drawImage(source, 0, 0);
      const data = targetContext.getImageData(0, 0, p.width, p.height).data;
      const out = new Uint8ClampedArray(p.width * p.height);
      for (let i = 0, k = 3; i < out.length; i += 1, k += 4) out[i] = data[k];
      return out;
    }

    // ------------------------------------------------------------ pixel access

    function selectedLayer() {
      return editor.selected();
    }

    // Which raster a paint or pixel operation edits: the layer, or its mask.
    function pixelTarget(options = {}) {
      const layer = selectedLayer();
      if (!layer) throw new Error('Select a layer first.');
      if (layer.locked)
        throw new Error(`${layer.name} is locked. Unlock it in the Layers panel first.`);
      if (!layer.visible && !options.allowHidden)
        throw new Error(`${layer.name} is hidden. Show it before editing its pixels.`);
      const wantsMask =
        options.mask !== false &&
        (layer.type === 'adjustment' || (state.targetMask && layer.rasterMask));
      if (wantsMask) {
        if (!layer.rasterMask) {
          if (options.noCreate)
            throw new Error('This adjustment layer has no mask to filter. Add a mask first.');
          // Create the mask with the edit, as one history step (not a separate "Add layer mask").
          const base = ensureMask(layer.id, 'reveal', { commit: false });
          const pending = base.layers.find((item) => item.id === layer.id);
          return { layer: pending, mask: true, source: pending.rasterMask.source, base };
        }
        return { layer, mask: true, source: layer.rasterMask.source };
      }
      if (layer.type === 'adjustment')
        throw new Error('Adjustment layers have no pixels. Paint on their mask instead.');
      if (layer.type !== 'image') {
        if (
          (layer.type === 'text' || layer.type === 'shape') &&
          root.hasAttribute('data-phone') &&
          root.dataset.mode !== 'advanced'
        ) {
          // The phone Basic UI has no Layer menu: say so, and offer the button.
          const message = `This is a ${layer.type} layer. Effects work on pixels: tap Rasterize, then pick the effect again.`;
          rasterizeOffer = { message, layerId: layer.id };
          throw new Error(message);
        }
        throw new Error(`This is a ${layer.type} layer. Use Layer › Rasterize to paint on it.`);
      }
      return { layer, mask: false, source: layer.source };
    }

    // Raster version id for a target, creating one over an imported image when needed.
    function versionFor(target) {
      // A reopened project decodes painted layers back into ordinary sources that
      // keep their px- ids, so a decoded source always wins over a stale version.
      if (!editor.hasDecodedSource(target.source.id) && rasters.has(target.source.id))
        return target.source.id;
      if (!editor.hasSource(target.source.id))
        throw new Error('Relink this image before editing its pixels.');
      return rasters.create({
        width: target.source.width,
        height: target.source.height,
        baseId: target.source.id,
      });
    }

    function pictureFor(target) {
      const id = versionFor(target);
      const picture = rasters.canvas(id, editor.resolveStoredSource);
      if (!picture) throw new Error('This layer’s pixels are not available. Relink the image.');
      return { id, picture };
    }

    // Swap a target's source for a new raster version as one history step.
    function commitTarget(target, newId, label, options = {}) {
      const p = options.base || target.base || project();
      const layer = p.layers.find((item) => item.id === target.layer.id);
      if (!layer) return;
      const current = target.mask ? layer.rasterMask?.source.id : layer.source.id;
      if (current !== target.source.id) {
        status(
          'That edit was discarded because the layer changed while it was in progress.',
          'error',
        );
        return;
      }
      const source = {
        ...(target.mask ? layer.rasterMask.source : layer.source),
        id: newId,
        mime: 'image/png',
        size: 0,
      };
      if (!target.mask && !/\.png$/i.test(source.name))
        source.name = `${source.name.replace(/\.[a-z0-9]+$/i, '')}.png`;
      const next = target.mask
        ? Core.setRasterMask(p, layer.id, source)
        : Core.updateLayer(p, layer.id, { source });
      if (options.commit === false) return next;
      store().replace(next, label);
      return next;
    }

    // A canvas keeps the options of its first getContext call, and the raster store opens its canvases without
    // willReadFrequently, so those are copied through one shared readback canvas instead of read directly.
    let readbackCanvas = null;
    function readPixels(picture, rect = null) {
      const r = rect || { x: 0, y: 0, width: picture.width, height: picture.height };
      let context = ctx2d(picture, true);
      let sx = r.x,
        sy = r.y;
      if (context.getContextAttributes?.().willReadFrequently === false) {
        if (!readbackCanvas) readbackCanvas = makeCanvas(1, 1);
        readbackCanvas.width = Math.max(1, r.width);
        readbackCanvas.height = Math.max(1, r.height);
        const copy = ctx2d(readbackCanvas, true);
        copy.globalCompositeOperation = 'copy';
        copy.drawImage(picture, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
        context = copy;
        sx = 0;
        sy = 0;
      }
      const image = context.getImageData(sx, sy, r.width, r.height);
      return { width: image.width, height: image.height, data: image.data };
    }

    function pixelsToCanvas(image, into = null, x = 0, y = 0) {
      const target = into || makeCanvas(image.width, image.height);
      const context = ctx2d(target);
      context.putImageData(new ImageData(image.data, image.width, image.height), x, y);
      return target;
    }

    function cloneCanvas(source) {
      const out = makeCanvas(source.width, source.height);
      ctx2d(out).drawImage(source, 0, 0);
      return out;
    }

    // Run an ImageData job over a whole target with optional selection mixing.
    async function processTarget(label, job, options = {}) {
      const target = pixelTarget({ mask: options.maskAllowed !== false, noCreate: true });
      const { id, picture } = pictureFor(target);
      const selection = selectionInLayer(target.layer);
      let region = { x: 0, y: 0, width: picture.width, height: picture.height };
      let selectionAlpha = null;
      if (selection) {
        const alpha = readPixels(selection);
        const mask = new Uint8ClampedArray(alpha.width * alpha.height);
        for (let i = 0, k = 3; i < mask.length; i += 1, k += 4) mask[i] = alpha.data[k];
        const bounds = Px.maskBounds(mask, alpha.width, alpha.height);
        if (!bounds) throw new Error('The selection does not cover this layer.');
        // Statistics and local tone masks need full-layer context, even for a selection.
        const pad = options.fullContext
          ? Math.max(picture.width, picture.height)
          : Math.ceil(options.pad || 0);
        region = {
          x: Math.max(0, bounds.x - pad),
          y: Math.max(0, bounds.y - pad),
          width: 0,
          height: 0,
        };
        region.width = Math.min(picture.width, bounds.x + bounds.width + pad) - region.x;
        region.height = Math.min(picture.height, bounds.y + bounds.height + pad) - region.y;
        selectionAlpha = new Uint8ClampedArray(region.width * region.height);
        for (let y = 0; y < region.height; y += 1) {
          selectionAlpha.set(
            mask.subarray(
              (region.y + y) * alpha.width + region.x,
              (region.y + y) * alpha.width + region.x + region.width,
            ),
            y * region.width,
          );
        }
      }
      const original = readPixels(picture, region);
      const processed = await job(Px.cloneImage(original), target, selectionAlpha);
      const result =
        selectionAlpha && options.mix !== false
          ? await worker.run('mixImages', { original, processed, mask: selectionAlpha, opacity: 1 })
          : processed;
      const output = cloneCanvas(picture);
      pixelsToCanvas(result, output, region.x, region.y);
      const next = rasters.commit(id, output, region);
      commitTarget(target, next, label);
      return target;
    }

    // Pen: turn the drafted anchors into a vector path shape layer.
    function finishPen(closed) {
      const pen = draft?.kind === 'pen' ? draft : null;
      draft = null;
      hoverPoint = null;
      scheduleOverlay();
      if (!pen || pen.points.length < 2) {
        if (pen) status('A path needs at least two points.');
        return;
      }
      if (pen.points.length > 4000) {
        status(
          `Paths hold up to 4,000 points; the last ${pen.points.length - 4000} were dropped.`,
          'error',
        );
        pen.points.length = 4000;
      }
      const pts = pen.points;
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (const pt of pts)
        for (const [x, y] of [
          [pt.x, pt.y],
          [pt.ix, pt.iy],
          [pt.ox, pt.oy],
        ]) {
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
      const width = Math.max(1, x1 - x0),
        height = Math.max(1, y1 - y0),
        cx = (x0 + x1) / 2,
        cy = (y0 + y1) / 2;
      const norm = (pt) => ({
        x: (pt.x - cx) / width,
        y: (pt.y - cy) / height,
        ix: (pt.ix - cx) / width,
        iy: (pt.iy - cy) / height,
        ox: (pt.ox - cx) / width,
        oy: (pt.oy - cy) / height,
      });
      let next = Core.addShapeLayer(project(), {
        shape: 'path',
        width,
        height,
        points: pts.map(norm),
        closed,
        fill: state.fg,
        stroke: closed ? state.bg : state.fg,
        strokeWidth: closed ? 0 : Math.max(2, Math.round(4 / Math.max(0.1, editor.view.zoom))),
      });
      next = Core.updateLayer(next, next.selectedLayerId, {
        name: closed ? 'Path' : 'Open path',
        transform: { x: cx, y: cy },
      });
      store().replace(next, closed ? 'Pen: closed path' : 'Pen: open path');
      status(
        `${closed ? 'Closed' : 'Open'} path with ${pts.length} points. Change its fill and stroke in Properties.`,
      );
    }

    // Filter > Liquify: push, bloat, pucker, twirl and reconstruct pixels with a brush.
    function liquifyDialog() {
      const target = pixelTarget({ noCreate: true, mask: false });
      const { picture } = pictureFor(target);
      const W = picture.width,
        H = picture.height;
      const scale = Math.min(1, 720 / Math.max(W, H));
      const pw = Math.max(1, Math.round(W * scale)),
        ph = Math.max(1, Math.round(H * scale));
      const small = document.createElement('canvas');
      small.width = pw;
      small.height = ph;
      const sctx = small.getContext('2d', { willReadFrequently: true });
      sctx.drawImage(picture, 0, 0, pw, ph);
      const source = { width: pw, height: ph, data: sctx.getImageData(0, 0, pw, ph).data };
      const mesh = Px.createLiquifyField(W, H, Math.max(4, Math.ceil(Math.max(W, H) / 256)));
      const opts = {
        mode: 'warp',
        size: Math.max(8, Math.round(Math.max(W, H) / 8)),
        pressure: 50,
      };
      const view = el('canvas', 'ap-liquify-canvas');
      view.width = pw;
      view.height = ph;
      view.setAttribute('aria-label', 'Liquify preview. Drag to warp.');
      const vctx = view.getContext('2d');
      let frame = 0,
        dirty = false;
      const redraw = () => {
        frame = 0;
        const scaled = new Float32Array(mesh.field.length);
        for (let i = 0; i < scaled.length; i += 1) scaled[i] = mesh.field[i] * scale;
        const out = Px.liquify(source, {
          field: scaled,
          gw: mesh.gw,
          gh: mesh.gh,
          width: pw,
          height: ph,
        });
        vctx.putImageData(new ImageData(out.data, pw, ph), 0, 0);
      };
      const request = () => {
        if (!frame) frame = requestAnimationFrame(redraw);
      };
      let last = null;
      const toLayer = (event) => {
        const r = view.getBoundingClientRect();
        return {
          x: ((event.clientX - r.left) * W) / r.width,
          y: ((event.clientY - r.top) * H) / r.height,
        };
      };
      const strokeAt = (p, prev) => {
        const strength = opts.pressure / 100;
        if (opts.mode === 'warp') {
          if (prev)
            Px.liquifyBrush(
              mesh,
              'warp',
              prev.x,
              prev.y,
              opts.size / 2,
              strength,
              p.x - prev.x,
              p.y - prev.y,
            );
        } else Px.liquifyBrush(mesh, opts.mode, p.x, p.y, opts.size / 2, strength);
        dirty = true;
        request();
      };
      // One brush pointer at a time: a second finger is ignored, never warped toward.
      let hold = 0,
        active = null;
      view.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        if (active !== null) return;
        active = event.pointerId;
        view.setPointerCapture(event.pointerId);
        last = toLayer(event);
        strokeAt(last, null);
        // Bloat, pucker, twirl and reconstruct keep working while the pointer is held still.
        clearInterval(hold);
        if (opts.mode !== 'warp') hold = setInterval(() => last && strokeAt(last, null), 40);
      });
      view.addEventListener('pointermove', (event) => {
        if (!last || event.pointerId !== active) return;
        const p = toLayer(event);
        strokeAt(p, last);
        last = p;
      });
      const stop = (event) => {
        if (event && event.pointerId !== active) return;
        active = null;
        last = null;
        clearInterval(hold);
        hold = 0;
      };
      view.addEventListener('pointerup', stop);
      view.addEventListener('pointercancel', stop);
      dialog(
        'Liquify',
        (body) => {
          const tools = el('div', 'ap-style-presets');
          tools.setAttribute('role', 'group');
          tools.setAttribute('aria-label', 'Liquify tool');
          for (const [mode, label] of [
            ['warp', 'Forward Warp'],
            ['bloat', 'Bloat'],
            ['pucker', 'Pucker'],
            ['twirl', 'Twirl'],
            ['reconstruct', 'Reconstruct'],
          ]) {
            const b = el('button', 'ap-style-preset', label);
            b.type = 'button';
            b.dataset.mode = mode;
            b.setAttribute('aria-pressed', String(opts.mode === mode));
            b.addEventListener('click', () => {
              opts.mode = mode;
              for (const other of tools.children)
                other.setAttribute('aria-pressed', String(other === b));
            });
            tools.append(b);
          }
          const restore = el('button', 'ap-style-preset', 'Restore All');
          restore.type = 'button';
          restore.addEventListener('click', () => {
            mesh.field.fill(0);
            dirty = false;
            request();
          });
          tools.append(restore);
          body.append(
            tools,
            field(
              'Brush size px',
              rangeInput(opts.size, 2, Math.max(16, Math.round(Math.max(W, H) / 2)), 1, (v) => {
                opts.size = v;
              }),
            ),
            field(
              'Pressure %',
              rangeInput(opts.pressure, 1, 100, 1, (v) => {
                opts.pressure = v;
              }),
            ),
            view,
            el(
              'p',
              'ap-dialog-note',
              'The preview is reduced; OK warps the full-resolution layer.',
            ),
          );
          redraw();
        },
        () => {
          if (!dirty) return;
          const params = {
            field: mesh.field.slice(),
            gw: mesh.gw,
            gh: mesh.gh,
            width: W,
            height: H,
          };
          return editor.runOperation('Liquify…', () =>
            processTarget(
              'Liquify',
              (image) =>
                worker.run('applyFilter', {
                  image,
                  name: 'liquify',
                  params: { ...params, field: params.field.slice() },
                }),
              { fullContext: true, maskAllowed: false },
            ),
          );
        },
        {
          wide: true,
          okLabel: 'OK',
          onClose: () => {
            active = null;
            last = null;
            clearInterval(hold);
            cancelAnimationFrame(frame);
          },
        },
      );
    }

    // Content-Aware Fill: replace the selected area with texture found elsewhere on the layer.
    // mask (optional): a project-space Uint8 mask to fill instead of the selection.
    async function contentAwareFill(mask = null) {
      const p = project();
      const bounds = mask ? Px.maskBounds(mask, p.width, p.height) : currentSelection()?.bounds;
      if (!bounds)
        throw new Error(
          mask
            ? 'Paint over what you want to remove first.'
            : 'Select the area to remove first (or paint it with Remove in Basic).',
        );
      // Enough surroundings to borrow from, without making a long thin stroke cover the whole image.
      const reach = Math.max(
        48,
        Math.min(512, Math.round(Math.sqrt(bounds.width * bounds.height) * 1.6)),
      );
      return editor.runOperation('Filling from the surroundings…', async () => {
        if (mask) {
          const canvas = makeCanvas(p.width, p.height);
          const context = ctx2d(canvas);
          const image = context.createImageData(p.width, p.height);
          for (let i = 0, k = 3; i < mask.length; i += 1, k += 4) image.data[k] = mask[i];
          context.putImageData(image, 0, 0);
          selectionOverride = canvas;
        }
        try {
          return await processTarget(
            'Content-Aware Fill',
            (image, target, alpha) => {
              if (!alpha) throw new Error('Select the area to remove first.');
              return worker.run('contentAwareFill', {
                image,
                mask: new Uint8ClampedArray(alpha),
                options: { seed: 11 },
              });
            },
            { pad: reach, maskAllowed: false, mix: false },
          );
        } finally {
          selectionOverride = null;
        }
      });
    }

    // ------------------------------------------------------------ overlay

    // Checkerboard under the document only; the pasteboard around it stays flat.
    const underlay = document.createElement('div');
    underlay.className = 'ap-doc-underlay';
    underlay.setAttribute('aria-hidden', 'true');
    viewport.prepend(underlay);
    root.addEventListener('alcorphoto:view', (event) => {
      const t = event.detail,
        crop = project().crop;
      underlay.style.left = `${t.x + crop.x * t.zoom}px`;
      underlay.style.top = `${t.y + crop.y * t.zoom}px`;
      underlay.style.width = `${crop.width * t.zoom}px`;
      underlay.style.height = `${crop.height * t.zoom}px`;
      underlay.style.opacity = project().background ? '0' : '1';
    });
    const overlay = document.createElement('canvas');
    overlay.className = 'ap-studio-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    viewport.append(overlay);
    const cursorRing = document.createElement('div');
    cursorRing.className = 'ap-brush-cursor';
    cursorRing.hidden = true;
    viewport.append(cursorRing);
    let overlayFrame = 0;
    let antsOffset = 0;
    let draft = null; // in-progress marquee / lasso / crop / gradient
    let hoverPoint = null;

    function scheduleOverlay() {
      if (overlayFrame) return;
      overlayFrame = requestAnimationFrame(drawOverlay);
    }
    root.addEventListener('alcorphoto:view', scheduleOverlay);

    function selectionOutline() {
      const selection = currentSelection();
      if (!selection) return null;
      if (!selectionCache.outline) {
        const small = Px.downsampleMask(selection.mask, selection.width, selection.height, 1400);
        const segments = Px.maskOutline(small.mask, small.width, small.height, 128);
        const scale = 1 / small.scale;
        const out = new Float32Array(segments.length);
        for (let i = 0; i < segments.length; i += 1) out[i] = segments[i] * scale;
        selectionCache.outline = out;
      }
      return selectionCache.outline;
    }

    function drawOverlay() {
      overlayFrame = 0;
      if (!editor.view.ready) return; // the first view event redraws once the size is known
      const t = editor.view.transform();
      const dpr = Math.max(1, Math.min(2, globalThis.devicePixelRatio || 1));
      const width = Math.round(t.width * dpr),
        height = Math.round(t.height * dpr);
      if (overlay.width !== width) overlay.width = width;
      if (overlay.height !== height) overlay.height = height;
      const context = ctx2d(overlay);
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, width, height);
      const toDevice = () =>
        context.setTransform(t.zoom * dpr, 0, 0, t.zoom * dpr, t.x * dpr, t.y * dpr);
      const px = 1 / (t.zoom * dpr);
      // Marching ants.
      const outline = selectionOutline();
      if (outline && outline.length) {
        toDevice();
        if (pixelMove) context.translate(pixelMove.offset.x, pixelMove.offset.y);
        context.beginPath();
        for (let i = 0; i < outline.length; i += 4) {
          context.moveTo(outline[i], outline[i + 1]);
          context.lineTo(outline[i + 2], outline[i + 3]);
        }
        context.lineWidth = px;
        context.setLineDash([]);
        context.strokeStyle = '#ffffff';
        context.stroke();
        context.setLineDash([4 * px, 4 * px]);
        context.lineDashOffset = antsOffset * px;
        context.strokeStyle = '#000000';
        context.stroke();
        context.setLineDash([]);
      }
      // Drafts.
      if (draft) {
        toDevice();
        context.lineWidth = px;
        context.strokeStyle = '#ffffff';
        context.setLineDash([4 * px, 4 * px]);
        context.lineDashOffset = antsOffset * px;
        if (draft.kind === 'marquee' || draft.kind === 'shape') {
          const r = draft.rect;
          context.beginPath();
          if (draft.shape === 'ellipse')
            context.ellipse(
              r.x + r.width / 2,
              r.y + r.height / 2,
              Math.abs(r.width / 2),
              Math.abs(r.height / 2),
              0,
              0,
              Math.PI * 2,
            );
          else context.rect(r.x, r.y, r.width, r.height);
          context.stroke();
          context.strokeStyle = '#000000';
          context.lineDashOffset = antsOffset * px + 4 * px;
          context.stroke();
        } else if (draft.kind === 'lasso' || draft.kind === 'polygon') {
          const points = draft.points.concat(
            draft.kind === 'polygon' && hoverPoint ? [hoverPoint] : [],
          );
          if (points.length > 1) {
            context.beginPath();
            context.moveTo(points[0].x, points[0].y);
            for (const point of points.slice(1)) context.lineTo(point.x, point.y);
            context.stroke();
            context.strokeStyle = '#000000';
            context.lineDashOffset = antsOffset * px + 4 * px;
            context.stroke();
          }
          if (draft.kind === 'polygon') {
            context.setLineDash([]);
            context.fillStyle = '#ffffff';
            for (const point of draft.points)
              context.fillRect(point.x - 2.5 * px, point.y - 2.5 * px, 5 * px, 5 * px);
          }
        } else if (draft.kind === 'pen') {
          context.setLineDash([]);
          const pts = draft.points;
          context.beginPath();
          if (pts.length) context.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i += 1)
            context.bezierCurveTo(
              pts[i - 1].ox,
              pts[i - 1].oy,
              pts[i].ix,
              pts[i].iy,
              pts[i].x,
              pts[i].y,
            );
          if (hoverPoint && pts.length && draft.dragging == null) {
            const last = pts[pts.length - 1];
            context.bezierCurveTo(
              last.ox,
              last.oy,
              hoverPoint.x,
              hoverPoint.y,
              hoverPoint.x,
              hoverPoint.y,
            );
          }
          context.lineWidth = 2.5 * px;
          context.strokeStyle = '#000000';
          context.stroke();
          context.lineWidth = 1.25 * px;
          context.strokeStyle = '#53d9d4';
          context.stroke();
          const last = pts[pts.length - 1];
          if (last && (last.ox !== last.x || last.oy !== last.y)) {
            context.beginPath();
            context.moveTo(last.ix, last.iy);
            context.lineTo(last.ox, last.oy);
            context.lineWidth = px;
            context.strokeStyle = '#ffffff';
            context.stroke();
            for (const [hx, hy] of [
              [last.ix, last.iy],
              [last.ox, last.oy],
            ]) {
              context.beginPath();
              context.arc(hx, hy, 3 * px, 0, Math.PI * 2);
              context.fillStyle = '#ffffff';
              context.fill();
            }
          }
          for (const [i, pt] of pts.entries()) {
            context.fillStyle = i === 0 ? '#53d9d4' : '#ffffff';
            context.fillRect(pt.x - 3 * px, pt.y - 3 * px, 6 * px, 6 * px);
            context.strokeStyle = '#000000';
            context.lineWidth = px;
            context.strokeRect(pt.x - 3 * px, pt.y - 3 * px, 6 * px, 6 * px);
          }
        } else if (draft.kind === 'gradient') {
          context.setLineDash([]);
          context.beginPath();
          context.moveTo(draft.from.x, draft.from.y);
          context.lineTo(draft.to.x, draft.to.y);
          context.lineWidth = 2 * px;
          context.strokeStyle = '#000000';
          context.stroke();
          context.lineWidth = px;
          context.strokeStyle = '#ffffff';
          context.stroke();
        } else if (draft.kind === 'straighten') {
          context.setLineDash([]);
          context.beginPath();
          context.moveTo(draft.from.x, draft.from.y);
          context.lineTo(draft.to.x, draft.to.y);
          context.lineWidth = 2 * px;
          context.strokeStyle = '#ffcc00';
          context.stroke();
        }
        context.setLineDash([]);
      }
      if (state.tool === 'crop' && state.crop.box) drawCropBox(context, t, dpr);
      if (state.transform) drawTransformBox(context, t, dpr);
      const sourceMark =
        state.tool === 'clone'
          ? state.clone.source
          : state.tool === 'heal' && state.variant.heal === 'healing'
            ? state.heal.source
            : null;
      if (sourceMark) {
        toDevice();
        const s = sourceMark;
        context.lineWidth = px * 1.5;
        context.strokeStyle = '#ffffff';
        context.beginPath();
        context.moveTo(s.x - 8 * px, s.y);
        context.lineTo(s.x + 8 * px, s.y);
        context.moveTo(s.x, s.y - 8 * px);
        context.lineTo(s.x, s.y + 8 * px);
        context.stroke();
      }
      const guideSet = [
        ...(state.showGuides ? overlayGuides : []),
        ...(guideDraft ? [guideDraft] : []),
      ];
      if (guideSet.length) {
        toDevice();
        context.lineWidth = px;
        context.strokeStyle = '#19d3ff';
        context.beginPath();
        for (const guide of guideSet) {
          if (guide.axis === 'x') {
            context.moveTo(guide.value, -1e6);
            context.lineTo(guide.value, 1e6);
          } else {
            context.moveTo(-1e6, guide.value);
            context.lineTo(1e6, guide.value);
          }
        }
        context.stroke();
      }
      if (snapLines.length) {
        toDevice();
        context.lineWidth = px;
        context.strokeStyle = '#ff3df2';
        context.beginPath();
        for (const line of snapLines) {
          if (line.axis === 'x') {
            context.moveTo(line.value, -1e6);
            context.lineTo(line.value, 1e6);
          } else {
            context.moveTo(-1e6, line.value);
            context.lineTo(1e6, line.value);
          }
        }
        context.stroke();
      }
    }
    let overlayGuides = [];
    let guideDraft = null;
    let snapLines = [];

    // Snapping: guides, canvas edges, and canvas centers, within 8 screen pixels.
    function snapTargets(axis) {
      const p = project();
      const size = axis === 'x' ? p.width : p.height;
      const lines = [0, size / 2, size];
      if (state.showGuides)
        for (const guide of overlayGuides) if (guide.axis === axis) lines.push(guide.value);
      return lines;
    }
    function snapAxis(values, axis) {
      if (!state.snap) return null;
      const threshold = 8 / editor.view.zoom;
      let best = null;
      for (const target of snapTargets(axis)) {
        for (const value of values) {
          const distance = Math.abs(target - value);
          if (distance <= threshold && (!best || distance < best.distance))
            best = { distance, shift: target - value, line: { axis, value: target } };
        }
      }
      return best;
    }
    function snapPoint(point) {
      const sx = snapAxis([point.x], 'x'),
        sy = snapAxis([point.y], 'y');
      snapLines = [sx?.line, sy?.line].filter(Boolean);
      return { x: point.x + (sx?.shift || 0), y: point.y + (sy?.shift || 0) };
    }
    editor.addMoveSnapper({
      snap(layer, position, event) {
        snapLines = [];
        if (!state.snap || event?.ctrlKey || event?.metaKey || !layer) return position;
        const corners =
          layerCorners({
            ...layer,
            transform: { ...layer.transform, x: position.x, y: position.y },
          }) ||
          (layer.type === 'text'
            ? (() => {
                const f = transformFrame(layer);
                const m = frameMatrix(f, { ...layer.transform, x: position.x, y: position.y });
                return [
                  [0, 0],
                  [f.width, 0],
                  [f.width, f.height],
                  [0, f.height],
                ].map(([x, y]) => m.transformPoint(new DOMPoint(x, y)));
              })()
            : null);
        if (!corners) return position;
        const xs = corners.map((c) => c.x),
          ys = corners.map((c) => c.y);
        const minX = Math.min(...xs),
          maxX = Math.max(...xs),
          minY = Math.min(...ys),
          maxY = Math.max(...ys);
        const sx = snapAxis([minX, (minX + maxX) / 2, maxX], 'x'),
          sy = snapAxis([minY, (minY + maxY) / 2, maxY], 'y');
        snapLines = [sx?.line, sy?.line].filter(Boolean);
        scheduleOverlay();
        return { x: position.x + (sx?.shift || 0), y: position.y + (sy?.shift || 0) };
      },
      end() {
        snapLines = [];
        scheduleOverlay();
      },
    });
    setInterval(() => {
      if (document.hidden) return;
      if (!currentSelection() && !draft) return;
      antsOffset = (antsOffset + 1) % 8;
      scheduleOverlay();
    }, 140);

    // ------------------------------------------------------------ brush cursor

    function toolSettings() {
      if (state.tool === 'brush') return state.brush;
      if (state.tool === 'eraser') return state.eraser;
      if (state.tool === 'clone') return state.clone;
      if (state.tool === 'heal') return state.heal;
      if (state.tool === 'tone') return state.tone;
      if (state.tool === 'focus') return state.focus;
      return null;
    }

    function updateCursor(event) {
      const settings = toolSettings();
      if (!settings || state.spaceDown || !event) {
        cursorRing.hidden = true;
        return;
      }
      const rect = viewport.getBoundingClientRect();
      const diameter = Math.max(2, settings.size * editor.view.zoom);
      cursorRing.hidden = false;
      cursorRing.style.width = cursorRing.style.height = `${diameter}px`;
      cursorRing.style.transform = `translate(${event.clientX - rect.left - diameter / 2}px, ${event.clientY - rect.top - diameter / 2}px)`;
    }

    // ------------------------------------------------------------ painting

    const tipCache = new Map();
    function tipCanvas(diameter, hardness, color) {
      const size = Math.max(1, Math.round(diameter * 4) / 4);
      const key = `${size}|${hardness}|${color}`;
      if (tipCache.has(key)) return tipCache.get(key);
      const tip = Px.brushTip(size, hardness);
      const out = makeCanvas(tip.size, tip.size);
      const context = ctx2d(out);
      const image = context.createImageData(tip.size, tip.size);
      const rgb = Px.parseHex(color);
      for (let i = 0, k = 0; i < tip.data.length; i += 1, k += 4) {
        image.data[k] = rgb.r;
        image.data[k + 1] = rgb.g;
        image.data[k + 2] = rgb.b;
        image.data[k + 3] = tip.data[i];
      }
      context.putImageData(image, 0, 0);
      tipCache.set(key, out);
      if (tipCache.size > 24) tipCache.delete(tipCache.keys().next().value);
      return out;
    }

    let stroke = null;
    let lastStrokeEnd = null;
    // In-progress pixels (stroke, pixel move, filter preview) render through a preview
    // project in which only the edited layer points at a temporary source id, so other
    // layers that share the same source (duplicates) do not show the unfinished edit.
    let live = null;
    let liveCounter = 0;
    editor.addSourceOverride((id) => (live && id === live.tempId ? live.canvas : null));
    // rect: optional changed area in the target's pixel coordinates, so the view repaints only there.
    function showLive(target, canvas, rect = null) {
      if (!live || live.canvas !== canvas || live.layerId !== target.layer.id) {
        const tempId = `live-preview-${++liveCounter}`;
        const base = target.base || project();
        const layers = base.layers.map((layer) => {
          if (layer.id !== target.layer.id) return layer;
          return target.mask
            ? {
                ...layer,
                rasterMask: {
                  ...layer.rasterMask,
                  source: { ...layer.rasterMask.source, id: tempId },
                },
              }
            : { ...layer, source: { ...layer.source, id: tempId } };
        });
        live = { tempId, canvas, layerId: target.layer.id, project: { ...base, layers } };
      }
      editor.previewProject(live.project, rect ? layerRectToProject(target.layer, rect) : null);
    }
    function layerRectToProject(layer, rect) {
      const corners = [
        [rect.x, rect.y],
        [rect.x + rect.width, rect.y],
        [rect.x, rect.y + rect.height],
        [rect.x + rect.width, rect.y + rect.height],
      ].map(([x, y]) => layerToProject(layer, { x, y }));
      const xs = corners.map((point) => point.x),
        ys = corners.map((point) => point.y);
      const x = Math.min(...xs),
        y = Math.min(...ys);
      return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
    }
    function endLive() {
      live = null;
      editor.requestRender();
    }
    editor.addSourceResolver((id) =>
      rasters.has(id) ? rasters.canvas(id, editor.resolveStoredSource) : null,
    );

    function maskValue() {
      // Painting a mask: foreground luminance decides reveal (white) vs conceal (black).
      const rgb = Px.parseHex(state.fg);
      return Px.luma(rgb.r, rgb.g, rgb.b) / 255;
    }

    function beginStroke(event, point) {
      const target = pixelTarget({ mask: !(state.tool === 'tone' || state.tool === 'focus') });
      const { id, picture } = pictureFor(target);
      const settings = toolSettings();
      const scale = layerScale(target.layer);
      if (state.tool === 'clone' && !state.clone.source)
        throw new Error('Alt-click (Option-click) to set the clone source first.');
      const size = Math.max(1, settings.size / scale);
      stroke = {
        tool: state.tool,
        variant: state.variant[state.tool],
        target,
        parentId: id,
        sourceId: target.source.id,
        original: picture,
        buffer: makeCanvas(picture.width, picture.height),
        display: cloneCanvas(picture),
        selection: selectionInLayer(target.layer),
        size,
        settings: { ...settings },
        color: state.tool === 'brush' && !target.mask ? state.fg : '#000000',
        maskValue: target.mask ? (state.tool === 'eraser' ? 1 - maskValue() : maskValue()) : 1,
        carry: 0,
        last: null,
        dirty: null,
        pointerId: event.pointerId,
        cloneOffset: null,
      };
      if (state.tool === 'clone') {
        const layerSource = projectToLayer(target.layer, state.clone.source);
        const layerPoint = projectToLayer(target.layer, point);
        if (!state.clone.aligned || !state.clone.offset)
          state.clone.offset = { x: layerSource.x - layerPoint.x, y: layerSource.y - layerPoint.y };
        stroke.cloneOffset = state.clone.offset;
      }
      const start = projectToLayer(target.layer, point);
      if (event.shiftKey && lastStrokeEnd && lastStrokeEnd.layerId === target.layer.id) {
        stroke.last = { x: lastStrokeEnd.x, y: lastStrokeEnd.y };
        strokeTo(start, event.pressure);
      } else {
        stamp(start, event.pointerType === 'pen' ? event.pressure : 1);
        stroke.last = start;
      }
      refreshStroke();
    }

    function stamp(point, pressure) {
      const s = stroke;
      const usePressure = s.settings.pressure && pressure > 0 && pressure < 1;
      const diameter = Math.max(1, s.size * (usePressure ? Math.max(0.05, pressure) : 1));
      const buffer = ctx2d(s.buffer);
      const half = diameter / 2 + 1;
      buffer.globalAlpha = s.settings.flow;
      if (s.tool === 'clone') {
        const tip = tipCanvas(diameter, s.settings.hardness, '#000000');
        const piece = makeCanvas(tip.width, tip.height);
        const pieceContext = ctx2d(piece);
        const sx = point.x + s.cloneOffset.x - tip.width / 2,
          sy = point.y + s.cloneOffset.y - tip.height / 2;
        pieceContext.drawImage(
          s.original,
          sx,
          sy,
          tip.width,
          tip.height,
          0,
          0,
          tip.width,
          tip.height,
        );
        pieceContext.globalCompositeOperation = 'destination-in';
        pieceContext.drawImage(tip, 0, 0);
        buffer.drawImage(piece, point.x - tip.width / 2, point.y - tip.height / 2);
      } else {
        const tip = tipCanvas(diameter, s.settings.hardness, s.color);
        buffer.drawImage(tip, point.x - tip.width / 2, point.y - tip.height / 2);
      }
      buffer.globalAlpha = 1;
      const rect = {
        x: Math.floor(point.x - half),
        y: Math.floor(point.y - half),
        width: Math.ceil(half * 2) + 1,
        height: Math.ceil(half * 2) + 1,
      };
      s.pending = unionRect(s.pending, rect);
      s.dirty = unionRect(s.dirty, rect);
    }

    function strokeTo(point, pressure) {
      const s = stroke;
      const spacing = Math.max(1, s.size * s.settings.spacing);
      const { points, carry } = Px.spacedDabs(s.last, point, spacing, s.carry);
      for (const dab of points) stamp(dab, pressure);
      s.carry = carry;
      s.last = point;
    }

    function unionRect(a, b) {
      if (!a) return { ...b };
      const x = Math.min(a.x, b.x),
        y = Math.min(a.y, b.y);
      return {
        x,
        y,
        width: Math.max(a.x + a.width, b.x + b.width) - x,
        height: Math.max(a.y + a.height, b.y + b.height) - y,
      };
    }

    function clampRect(rect, width, height) {
      if (!rect) return null;
      const x = Math.max(0, rect.x),
        y = Math.max(0, rect.y);
      const w = Math.min(width, rect.x + rect.width) - x,
        h = Math.min(height, rect.y + rect.height) - y;
      return w > 0 && h > 0 ? { x, y, width: w, height: h } : null;
    }

    // Recompose display = original + stroke buffer (through selection, at opacity).
    function refreshStroke() {
      const s = stroke;
      const r = clampRect(s.pending, s.display.width, s.display.height);
      s.pending = null;
      if (!r) return;
      if (s.tool === 'tone' || s.tool === 'focus') {
        const pad = 8;
        refreshProcessed(s, r);
        showLive(s.target, s.display, {
          x: r.x - pad,
          y: r.y - pad,
          width: r.width + pad * 2,
          height: r.height + pad * 2,
        });
        return;
      }
      const display = ctx2d(s.display);
      // Restore the untouched pixels for this region only ('copy' would clear the whole canvas).
      display.clearRect(r.x, r.y, r.width, r.height);
      display.drawImage(s.original, r.x, r.y, r.width, r.height, r.x, r.y, r.width, r.height);
      let piece = s.buffer;
      let pieceRect = r;
      if (s.selection) {
        piece = makeCanvas(r.width, r.height);
        const context = ctx2d(piece);
        context.drawImage(s.buffer, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
        context.globalCompositeOperation = 'destination-in';
        context.drawImage(s.selection, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
        pieceRect = { x: 0, y: 0, width: r.width, height: r.height };
      }
      const opacity = s.settings.opacity;
      display.save();
      if (s.target.mask) {
        display.globalCompositeOperation = 'destination-out';
        display.globalAlpha = opacity;
        display.drawImage(
          piece,
          pieceRect.x,
          pieceRect.y,
          r.width,
          r.height,
          r.x,
          r.y,
          r.width,
          r.height,
        );
        display.globalCompositeOperation = 'lighter';
        display.globalAlpha = opacity * s.maskValue;
        if (display.globalAlpha > 0)
          display.drawImage(
            piece,
            pieceRect.x,
            pieceRect.y,
            r.width,
            r.height,
            r.x,
            r.y,
            r.width,
            r.height,
          );
      } else {
        display.globalCompositeOperation = s.tool === 'eraser' ? 'destination-out' : 'source-over';
        display.globalAlpha = opacity;
        display.drawImage(
          piece,
          pieceRect.x,
          pieceRect.y,
          r.width,
          r.height,
          r.x,
          r.y,
          r.width,
          r.height,
        );
      }
      display.restore();
      showLive(s.target, s.display, r);
    }

    // Dodge/Burn/Sponge and Blur/Sharpen: recompute the effect from the untouched
    // pixels and blend it in by the stroke's accumulated coverage.
    function refreshProcessed(s, rect) {
      const radius =
        s.tool === 'focus' ? (s.variant === 'blur' ? 1 + s.settings.strength / 20 : 1) : 0;
      const pad = Math.ceil(radius * 3) + 2;
      const r = clampRect(
        {
          x: rect.x - pad,
          y: rect.y - pad,
          width: rect.width + pad * 2,
          height: rect.height + pad * 2,
        },
        s.display.width,
        s.display.height,
      );
      const original = readPixels(s.original, r);
      let processed;
      if (s.tool === 'tone') {
        const mode = s.variant === 'sponge' ? s.settings.sponge : s.variant;
        processed = Px.toneRegion(original, {
          mode,
          range: s.settings.range,
          exposure: s.settings.exposure,
        });
      } else if (s.variant === 'blur') processed = Px.gaussianBlur(original, radius);
      else
        processed = Px.unsharpMask(original, {
          amount: 40 + s.settings.strength * 2,
          radius: 1,
          threshold: 2,
        });
      const coverage = new Uint8ClampedArray(r.width * r.height);
      const buffer = readPixels(s.buffer, r).data;
      for (let i = 0, k = 3; i < coverage.length; i += 1, k += 4) coverage[i] = buffer[k];
      if (s.selection) {
        const alpha = readPixels(s.selection, r).data;
        for (let i = 0, k = 3; i < coverage.length; i += 1, k += 4)
          coverage[i] = (coverage[i] * alpha[k]) / 255;
      }
      const out = Px.mixByCoverage(original, processed, coverage, s.settings.opacity);
      ctx2d(s.display).putImageData(new ImageData(out.data, out.width, out.height), r.x, r.y);
    }

    function endStroke(commit = true) {
      const s = stroke;
      stroke = null;
      live = null;
      if (!s) return;
      if (!commit || !s.dirty) {
        editor.requestRender();
        return;
      }
      const dirty = clampRect(s.dirty, s.display.width, s.display.height);
      if (!dirty) {
        editor.requestRender();
        return;
      }
      const newId = rasters.commit(s.parentId, s.display, dirty);
      lastStrokeEnd = { layerId: s.target.layer.id, x: s.last.x, y: s.last.y };
      const label = s.target.mask
        ? 'Paint layer mask'
        : s.tool === 'eraser'
          ? 'Eraser'
          : s.tool === 'clone'
            ? 'Clone Stamp'
            : s.tool === 'tone' || s.tool === 'focus'
              ? VARIANT_LABELS[s.variant]
              : 'Brush Tool';
      commitTarget(s.target, newId, label);
      editor.requestRender();
    }

    // ------------------------------------------------------------ fills

    async function bucketFill(point) {
      const target = pixelTarget();
      const layerPoint = projectToLayer(target.layer, point);
      const { id, picture } = pictureFor(target);
      const x = Math.floor(layerPoint.x),
        y = Math.floor(layerPoint.y);
      if (x < 0 || y < 0 || x >= picture.width || y >= picture.height)
        throw new Error('Click inside the layer to fill.');
      const pixels = readPixels(picture);
      const { mask } = await worker.run('floodSelect', {
        image: pixels,
        x,
        y,
        options: {
          tolerance: state.bucket.tolerance,
          contiguous: state.bucket.contiguous,
          antiAlias: state.bucket.antiAlias,
        },
      });
      const selection = selectionInLayer(target.layer);
      if (selection) {
        const alpha = readPixels(selection).data;
        for (let i = 0, k = 3; i < mask.length; i += 1, k += 4)
          mask[i] = (mask[i] * alpha[k]) / 255;
      }
      const bounds = Px.maskBounds(mask, picture.width, picture.height);
      if (!bounds) throw new Error('Nothing to fill there.');
      const fillCanvas = makeCanvas(picture.width, picture.height);
      const fc = ctx2d(fillCanvas);
      const image = fc.createImageData(bounds.width, bounds.height);
      const rgb = target.mask ? { r: 0, g: 0, b: 0 } : Px.parseHex(state.fg);
      for (let yy = 0; yy < bounds.height; yy += 1) {
        for (let xx = 0; xx < bounds.width; xx += 1) {
          const m = mask[(bounds.y + yy) * picture.width + bounds.x + xx];
          if (!m) continue;
          const k = (yy * bounds.width + xx) * 4;
          image.data[k] = rgb.r;
          image.data[k + 1] = rgb.g;
          image.data[k + 2] = rgb.b;
          image.data[k + 3] = m;
        }
      }
      fc.putImageData(image, bounds.x, bounds.y);
      const output = cloneCanvas(picture);
      const oc = ctx2d(output);
      if (target.mask) {
        oc.globalCompositeOperation = 'destination-out';
        oc.globalAlpha = state.bucket.opacity;
        oc.drawImage(fillCanvas, 0, 0);
        oc.globalCompositeOperation = 'lighter';
        oc.globalAlpha = state.bucket.opacity * maskValue();
        oc.drawImage(fillCanvas, 0, 0);
      } else {
        oc.globalAlpha = state.bucket.opacity;
        oc.drawImage(fillCanvas, 0, 0);
      }
      commitTarget(target, rasters.commit(id, output, bounds), 'Paint Bucket');
    }

    function drawGradient(from, to) {
      const target = pixelTarget();
      const { id, picture } = pictureFor(target);
      const a = projectToLayer(target.layer, from),
        b = projectToLayer(target.layer, to);
      const gradientCanvas = makeCanvas(picture.width, picture.height);
      const gc = ctx2d(gradientCanvas);
      const radius = Math.hypot(b.x - a.x, b.y - a.y);
      const gradient =
        state.gradient.type === 'radial'
          ? gc.createRadialGradient(a.x, a.y, 0, a.x, a.y, Math.max(1, radius))
          : gc.createLinearGradient(a.x, a.y, b.x, b.y);
      const [c0, c1] = state.gradient.reverse ? [state.bg, state.fg] : [state.fg, state.bg];
      gradient.addColorStop(0, target.mask ? '#ffffff' : c0);
      gradient.addColorStop(1, target.mask ? '#000000' : c1);
      gc.fillStyle = gradient;
      gc.fillRect(0, 0, picture.width, picture.height);
      const selection = selectionInLayer(target.layer);
      if (selection) {
        gc.globalCompositeOperation = 'destination-in';
        gc.drawImage(selection, 0, 0);
      }
      const output = cloneCanvas(picture);
      const oc = ctx2d(output);
      oc.globalAlpha = state.gradient.opacity;
      if (target.mask) {
        // Convert the grey gradient to mask alpha.
        const grey = readPixels(gradientCanvas);
        for (let i = 0; i < grey.data.length; i += 4) {
          grey.data[i + 3] = (grey.data[i + 3] * grey.data[i]) / 255;
          grey.data[i] = grey.data[i + 1] = grey.data[i + 2] = 0;
        }
        const alphaCanvas = pixelsToCanvas(grey);
        if (selection) {
          oc.globalCompositeOperation = 'destination-out';
          oc.drawImage(selection, 0, 0);
          oc.globalCompositeOperation = 'lighter';
        } else {
          oc.globalCompositeOperation = 'copy';
        }
        oc.drawImage(alphaCanvas, 0, 0);
      } else oc.drawImage(gradientCanvas, 0, 0);
      commitTarget(target, rasters.commit(id, output, null), 'Gradient');
    }

    // Fill (Alt/Ctrl+Backspace) and Delete through the active selection.
    function fillOrClear(mode, color = state.fg, opacity = 1, options = {}) {
      const target = pixelTarget();
      const { id, picture } = pictureFor(target);
      const selection = selectionInLayer(target.layer);
      const output = cloneCanvas(picture);
      const oc = ctx2d(output);
      const shape =
        selection ||
        (() => {
          const full = makeCanvas(picture.width, picture.height);
          const c = ctx2d(full);
          c.fillStyle = '#000';
          c.fillRect(0, 0, full.width, full.height);
          return full;
        })();
      if (mode === 'clear' && !target.mask) {
        oc.globalCompositeOperation = 'destination-out';
        oc.drawImage(shape, 0, 0);
      } else {
        const value = target.mask
          ? mode === 'clear'
            ? 0
            : (() => {
                const rgb = Px.parseHex(color);
                return Px.luma(rgb.r, rgb.g, rgb.b) / 255;
              })()
          : 1;
        if (target.mask) {
          oc.globalCompositeOperation = 'destination-out';
          oc.globalAlpha = opacity;
          oc.drawImage(shape, 0, 0);
          oc.globalCompositeOperation = 'lighter';
          oc.globalAlpha = opacity * value;
          if (value > 0) oc.drawImage(shape, 0, 0);
        } else {
          const colored = makeCanvas(picture.width, picture.height);
          const cc = ctx2d(colored);
          cc.drawImage(shape, 0, 0);
          cc.globalCompositeOperation = 'source-in';
          cc.fillStyle = color;
          cc.fillRect(0, 0, colored.width, colored.height);
          oc.globalAlpha = opacity;
          oc.drawImage(colored, 0, 0);
        }
      }
      return commitTarget(
        target,
        rasters.commit(id, output, null),
        mode === 'clear' ? 'Clear' : 'Fill',
        options,
      );
    }

    // ------------------------------------------------------------ eyedropper

    function sampleColor(point) {
      const size = state.eyedropper.size;
      const half = Math.floor(size / 2);
      const sample = makeCanvas(size, size);
      const context = ctx2d(sample, true);
      if (state.eyedropper.sample === 'layer') {
        const layer = selectedLayer();
        if (!layer || layer.type !== 'image')
          throw new Error('Select a pixel layer, or sample all layers.');
        const picture = editor.resolveStoredSource(layer.source.id);
        const lp = projectToLayer(layer, point);
        if (picture)
          context.drawImage(
            picture,
            Math.floor(lp.x) - half,
            Math.floor(lp.y) - half,
            size,
            size,
            0,
            0,
            size,
            size,
          );
      } else {
        Core.renderProject(context, project(), editor.resolveSource, {
          view: { scale: 1, x: -Math.floor(point.x) + half, y: -Math.floor(point.y) + half },
          adjust: editor.adjust,
        });
      }
      const data = context.getImageData(0, 0, size, size).data;
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i] * data[i + 3];
        g += data[i + 1] * data[i + 3];
        b += data[i + 2] * data[i + 3];
        a += data[i + 3];
      }
      if (!a) return null;
      return Px.toHex({ r: r / a, g: g / a, b: b / a });
    }

    // ------------------------------------------------------------ retouching

    // Spot Healing and Healing Brush strokes: one history step for the whole drag.
    function healStroke(points, mode) {
      const target = pixelTarget({ mask: false });
      const { id, picture } = pictureFor(target);
      const radius = Math.max(2, state.heal.size / 2 / layerScale(target.layer));
      const centres = points.map((point) => projectToLayer(target.layer, point));
      let offset = null;
      if (mode === 'healing') {
        if (!state.heal.source)
          throw new Error('Alt-click (Option-click) to set the healing source first.');
        const src = projectToLayer(target.layer, state.heal.source);
        if (!state.heal.aligned || !state.heal.offset)
          state.heal.offset = { x: src.x - centres[0].x, y: src.y - centres[0].y };
        offset = state.heal.offset;
      }
      const reach = mode === 'spot' ? radius * 6 : radius * 2 + 4;
      const xs = centres.flatMap((c) => [c.x, offset ? c.x + offset.x : c.x]);
      const ys = centres.flatMap((c) => [c.y, offset ? c.y + offset.y : c.y]);
      const rect = clampRect(
        {
          x: Math.floor(Math.min(...xs) - reach),
          y: Math.floor(Math.min(...ys) - reach),
          width: Math.ceil(Math.max(...xs) - Math.min(...xs) + reach * 2),
          height: Math.ceil(Math.max(...ys) - Math.min(...ys) + reach * 2),
        },
        picture.width,
        picture.height,
      );
      if (!rect) throw new Error('Heal on the layer.');
      const original = readPixels(picture, rect);
      let image = Px.cloneImage(original);
      for (const c of centres) {
        const local = { x: c.x - rect.x, y: c.y - rect.y };
        if (mode === 'spot')
          image = Px.spotHeal(image, local.x, local.y, radius, {
            hardness: state.heal.hardness,
          }).image;
        else
          image = Px.healPatch(
            image,
            local.x,
            local.y,
            radius,
            { x: local.x + offset.x, y: local.y + offset.y },
            { hardness: state.heal.hardness },
          );
      }
      const selection = selectionInLayer(target.layer);
      if (selection) {
        const alpha = readPixels(selection, rect).data;
        const mask = new Uint8ClampedArray(rect.width * rect.height);
        for (let i = 0, k = 3; i < mask.length; i += 1, k += 4) mask[i] = alpha[k];
        image = Px.mixImages(original, image, mask, 1);
      }
      const output = cloneCanvas(picture);
      pixelsToCanvas(image, output, rect.x, rect.y);
      commitTarget(
        target,
        rasters.commit(id, output, rect),
        mode === 'spot' ? 'Spot Healing Brush' : 'Healing Brush',
      );
    }

    async function healAt(point) {
      await processTargetAround(
        point,
        state.heal.size,
        'Spot Healing Brush',
        (image, center, radius) => {
          const result = Px.spotHeal(image, center.x, center.y, radius, {
            hardness: state.heal.hardness,
          });
          return result.image;
        },
        6,
      );
    }

    async function redEyeAt(point) {
      let changed = 0;
      await processTargetAround(
        point,
        state.heal.size * 1.2,
        'Red Eye',
        (image, center, radius) => {
          const result = Px.redEye(image, center.x, center.y, radius);
          changed = result.changed;
          return result.image;
        },
        1.2,
      );
      if (!changed)
        status('No strongly red pixels found there. Click on the center of a red pupil.');
    }

    async function processTargetAround(point, diameter, label, fn, reach) {
      const target = pixelTarget({ mask: false });
      const { id, picture } = pictureFor(target);
      const lp = projectToLayer(target.layer, point);
      const radius = Math.max(2, diameter / 2 / layerScale(target.layer));
      const span = Math.ceil(radius * reach) + 4;
      const rect = clampRect(
        {
          x: Math.floor(lp.x - span),
          y: Math.floor(lp.y - span),
          width: span * 2,
          height: span * 2,
        },
        picture.width,
        picture.height,
      );
      if (!rect) throw new Error('Click on the layer.');
      const image = readPixels(picture, rect);
      const result = fn(image, { x: lp.x - rect.x, y: lp.y - rect.y }, radius);
      let finalImage = result;
      const selection = selectionInLayer(target.layer);
      if (selection) {
        const alpha = readPixels(selection, rect).data;
        const mask = new Uint8ClampedArray(rect.width * rect.height);
        for (let i = 0, k = 3; i < mask.length; i += 1, k += 4) mask[i] = alpha[k];
        finalImage = Px.mixImages(image, result, mask, 1);
      }
      const output = cloneCanvas(picture);
      pixelsToCanvas(finalImage, output, rect.x, rect.y);
      commitTarget(target, rasters.commit(id, output, rect), label);
    }

    // ------------------------------------------------------------ free local background removal

    async function removeBackground(options = {}) {
      // With text or a shape selected, the photo is still what this means.
      let layer = selectedLayer();
      if (layer?.type !== 'image') {
        layer = [...project().layers].reverse().find((item) => item.type === 'image');
        if (!layer) throw new Error('Open a photo first.');
        store().replaceTransient({ ...project(), selectedLayerId: layer.id }, 'Select photo');
      }
      if (layer.locked) throw new Error(`${layer.name} is locked. Unlock it first.`);
      if (!editor.hasSource(layer.source.id) && !rasters.has(layer.source.id))
        throw new Error('Relink this image before removing its background.');
      return editor.runOperation('Removing background locally…', async () => {
        const picture = editor.resolveSource(layer.source.id);
        if (!picture) throw new Error('This layer’s pixels are not available. Relink the image.');
        const maxPixels = 1_000_000;
        const scale = Math.min(
          1,
          Math.sqrt(maxPixels / Math.max(1, picture.width * picture.height)),
          1280 / Math.max(picture.width, picture.height),
        );
        const width = Math.max(1, Math.round(picture.width * scale));
        const height = Math.max(1, Math.round(picture.height * scale));
        const small = makeCanvas(width, height);
        const sc = ctx2d(small, true);
        sc.imageSmoothingEnabled = true;
        sc.imageSmoothingQuality = 'high';
        sc.drawImage(picture, 0, 0, width, height);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const pixels = sc.getImageData(0, 0, width, height);
        const { alpha, kept } = Bg.subjectMask(pixels.data, width, height, {
          sensitivity: Number(options.sensitivity ?? 44),
          feather: Number(options.feather ?? 1),
        });
        // A mask that keeps next to nothing, or removes next to nothing, never reaches the photo.
        if (kept < 0.04)
          throw new Error(
            'No clear subject found, so the photo was left as it was. Try a lower Sensitivity, or paint things out with Remove.',
          );
        if (kept > 0.985)
          throw new Error(
            'No background to remove was found, so the photo was left as it was. Try a higher Sensitivity, or paint things out with Remove.',
          );
        const maskImage = sc.createImageData(width, height);
        for (let i = 0, k = 0; i < alpha.length; i += 1, k += 4) {
          maskImage.data[k] = 255;
          maskImage.data[k + 1] = 255;
          maskImage.data[k + 2] = 255;
          maskImage.data[k + 3] = alpha[i];
        }
        sc.clearRect(0, 0, width, height);
        sc.putImageData(maskImage, 0, 0);

        const mask = makeCanvas(picture.width, picture.height);
        const mc = ctx2d(mask);
        mc.imageSmoothingEnabled = true;
        mc.imageSmoothingQuality = 'high';
        mc.drawImage(small, 0, 0, mask.width, mask.height);
        const id = rasters.fromCanvas(mask);
        const next = Core.setRasterMask(project(), layer.id, {
          id,
          name: `${layer.name} background mask.png`,
          mime: 'image/png',
          width: mask.width,
          height: mask.height,
          size: 0,
        });
        store().replace(next, 'Remove background');
        state.targetMask = true;
        showPanel('properties');
        status(
          'Background removed on this device. Refine the mask for hair, edges, or complex scenes.',
        );
        return next;
      });
    }

    // ------------------------------------------------------------ masks

    function ensureMask(layerId, mode = 'reveal', options = {}) {
      const p = project();
      const layer = p.layers.find((item) => item.id === layerId);
      if (!layer) throw new Error('Select a layer first.');
      if (layer.type !== 'image' && layer.type !== 'adjustment')
        throw new Error(
          'Layer masks need a pixel or adjustment layer. Rasterize text and shapes first.',
        );
      const size = layerSize(layer);
      const maskCanvas = makeCanvas(size.width, size.height);
      const mc = ctx2d(maskCanvas);
      const selection = mode === 'selection' ? selectionInLayer(layer) : null;
      if (mode === 'selection' && !selection) throw new Error('Make a selection first.');
      if (selection) mc.drawImage(selection, 0, 0);
      else if (mode === 'reveal') {
        mc.fillStyle = '#000';
        mc.fillRect(0, 0, size.width, size.height);
      }
      const id = rasters.fromCanvas(maskCanvas);
      const next = Core.setRasterMask(p, layer.id, {
        id,
        name: `${layer.name} mask.png`,
        mime: 'image/png',
        width: size.width,
        height: size.height,
        size: 0,
      });
      if (options.commit === false) return next;
      store().replace(
        next,
        mode === 'selection'
          ? 'Add layer mask (reveal selection)'
          : mode === 'hide'
            ? 'Add layer mask (hide all)'
            : 'Add layer mask',
      );
      state.targetMask = true;
    }

    function invertMask() {
      const layer = selectedLayer();
      if (!layer?.rasterMask) throw new Error('Select a layer with a mask.');
      const target = { layer, mask: true, source: layer.rasterMask.source };
      const { id, picture } = pictureFor(target);
      const output = makeCanvas(picture.width, picture.height);
      const oc = ctx2d(output);
      oc.fillStyle = '#000';
      oc.fillRect(0, 0, output.width, output.height);
      oc.globalCompositeOperation = 'destination-out';
      oc.drawImage(picture, 0, 0);
      commitTarget(target, rasters.commit(id, output, null), 'Invert layer mask');
    }

    // Bake the mask into the layer's pixels and remove it.
    function applyMask() {
      const layer = selectedLayer();
      if (!layer?.rasterMask || layer.type !== 'image')
        throw new Error('Select a pixel layer with a mask.');
      const target = { layer, mask: false, source: layer.source };
      const { id, picture } = pictureFor(target);
      const mask = pictureFor({ layer, mask: true, source: layer.rasterMask.source }).picture;
      const output = cloneCanvas(picture);
      const oc = ctx2d(output);
      oc.globalCompositeOperation = 'destination-in';
      oc.drawImage(mask, 0, 0);
      const newId = rasters.commit(id, output, null);
      let next = Core.updateLayer(project(), layer.id, {
        source: { ...layer.source, id: newId, mime: 'image/png', size: 0 },
      });
      next = Core.setRasterMask(next, layer.id, null);
      store().replace(next, 'Apply layer mask');
      state.targetMask = false;
    }

    // ------------------------------------------------------------ clipboard and layers

    let clipboard = null; // { canvas, x, y }

    function renderLayerAlone(layer) {
      const p = project();
      const out = makeCanvas(p.width, p.height);
      const context = ctx2d(out, true);
      const single = {
        ...p,
        background: null,
        groups: [],
        adjustments: { brightness: 0, contrast: 0, saturation: 0, hue: 0, blur: 0, grayscale: 0 },
        layers: [{ ...layer, visible: true, opacity: 1, blendMode: 'normal', clip: false }],
      };
      Core.renderProject(context, single, editor.resolveStoredSource, {
        view: { scale: 1, x: 0, y: 0 },
        adjust: editor.adjust,
      });
      return out;
    }

    function renderMerged() {
      const p = project();
      const out = makeCanvas(p.width, p.height);
      Core.renderProject(
        ctx2d(out, true),
        { ...p, crop: { x: 0, y: 0, width: p.width, height: p.height } },
        editor.resolveStoredSource,
        { view: { scale: 1, x: 0, y: 0 }, adjust: editor.adjust },
      );
      return out;
    }

    function copySelection(merged = false, cut = false) {
      const p = project();
      const layer = selectedLayer();
      if (!merged && (!layer || layer.type === 'adjustment'))
        throw new Error('Select a pixel, text, or shape layer to copy.');
      const source = merged ? renderMerged() : renderLayerAlone(layer);
      const selection = selectionCanvas();
      const bounds = currentSelection()?.bounds || { x: 0, y: 0, width: p.width, height: p.height };
      const piece = makeCanvas(bounds.width, bounds.height);
      const pc = ctx2d(piece, true);
      pc.drawImage(source, -bounds.x, -bounds.y);
      if (selection) {
        pc.globalCompositeOperation = 'destination-in';
        pc.drawImage(selection, -bounds.x, -bounds.y);
      }
      clipboard = { canvas: piece, x: bounds.x, y: bounds.y };
      writeSystemClipboard(piece);
      if (cut) {
        if (layer?.type !== 'image')
          throw new Error('Cut works on pixel layers. The copy is on the clipboard.');
        fillOrClear('clear');
      }
      status(
        `${cut ? 'Cut' : 'Copied'} ${bounds.width}×${bounds.height} px${merged ? ' (merged)' : ''}. Paste with Ctrl+V.`,
      );
    }

    function writeSystemClipboard(piece) {
      if (!navigator.clipboard?.write || typeof ClipboardItem !== 'function') return;
      // Local OS clipboard only; nothing leaves the device.
      const item = new ClipboardItem({
        'image/png': new Promise((resolve) => piece.toBlob(resolve, 'image/png')),
      });
      navigator.clipboard.write([item]).catch(() => {});
    }

    function pasteCanvas(piece, x, y, name = 'Pasted layer', options = {}) {
      const id = rasters.fromCanvas(piece);
      const next = Core.addRasterLayer(
        options.base || project(),
        {
          id,
          name: `${name}.png`,
          mime: 'image/png',
          width: piece.width,
          height: piece.height,
          size: 0,
        },
        { name, x: x + piece.width / 2, y: y + piece.height / 2 },
      );
      if (options.commit === false) return next;
      store().replace(next, 'Paste');
      return next;
    }

    function pasteInternal(inPlace = true) {
      if (!clipboard) throw new Error('The clipboard is empty. Copy a selection first.');
      const p = project();
      const x = inPlace
        ? clipboard.x
        : Math.round(p.crop.x + p.crop.width / 2 - clipboard.canvas.width / 2);
      const y = inPlace
        ? clipboard.y
        : Math.round(p.crop.y + p.crop.height / 2 - clipboard.canvas.height / 2);
      pasteCanvas(clipboard.canvas, x, y);
    }

    document.addEventListener('paste', (event) => {
      if (
        /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '') ||
        event.target?.isContentEditable ||
        editor.operation
      )
        return;
      const file = [...(event.clipboardData?.files || [])].find((item) =>
        /^image\/(png|jpeg|webp|gif)$/i.test(item.type),
      );
      if (!file) return;
      event.preventDefault();
      editor.importFile(new File([file], file.name || 'pasted.png', { type: file.type }));
    });

    function newLayer() {
      const p = project();
      const blank = makeCanvas(p.width, p.height);
      const id = rasters.fromCanvas(blank);
      const next = Core.addRasterLayer(p, {
        id,
        name: 'Layer.png',
        mime: 'image/png',
        width: p.width,
        height: p.height,
        size: 0,
      });
      store().replace(next, 'New layer');
      state.targetMask = false;
    }

    function layerViaCopy(cut = false) {
      const selection = currentSelection();
      const layer = selectedLayer();
      if (!layer) throw new Error('Select a layer first.');
      if (!selection) {
        // Duplicate in place (Photoshop's Ctrl+J without a selection).
        const duplicated = Core.duplicateLayer(project(), layer.id);
        const copy = duplicated.layers.find((item) => item.id === duplicated.selectedLayerId);
        store().replace(
          Core.updateLayer(duplicated, copy.id, {
            transform: { x: layer.transform.x, y: layer.transform.y },
          }),
          'Duplicate layer',
        );
        return;
      }
      copySelection(false, false);
      const piece = clipboard;
      // Clear (for cut), paste, and deselect as one history step.
      let next = cut ? fillOrClear('clear', state.fg, 1, { commit: false }) : project();
      next = pasteCanvas(piece.canvas, piece.x, piece.y, cut ? 'Layer via Cut' : 'Layer via Copy', {
        base: next,
        commit: false,
      });
      next = { ...next };
      delete next.selection;
      store().replace(next, cut ? 'Layer via Cut' : 'Layer via Copy');
    }

    let rasterizeOffer = null;
    function rasterizeLayer() {
      const layer = selectedLayer();
      if (!layer || (layer.type !== 'text' && layer.type !== 'shape'))
        throw new Error('Select a text or shape layer to rasterize.');
      const pictureCanvas = renderLayerAlone(layer);
      const p = project();
      const id = rasters.fromCanvas(pictureCanvas);
      const index = p.layers.findIndex((item) => item.id === layer.id);
      const replacement = {
        id: layer.id,
        type: 'image',
        name: layer.name,
        visible: layer.visible,
        opacity: layer.opacity,
        blendMode: layer.blendMode,
        clip: layer.clip,
        locked: layer.locked,
        groupId: layer.groupId,
        transform: { x: p.width / 2, y: p.height / 2, scaleX: 1, scaleY: 1, rotation: 0 },
        source: {
          id,
          name: `${layer.name}.png`,
          mime: 'image/png',
          width: p.width,
          height: p.height,
          size: 0,
        },
      };
      const layers = p.layers.slice();
      layers[index] = replacement;
      store().replace({ ...p, layers }, 'Rasterize layer');
    }

    function mergeDown() {
      const p = project();
      const index = p.layers.findIndex((item) => item.id === p.selectedLayerId);
      if (index < 1) throw new Error('Select a layer above another layer to merge down.');
      const upper = p.layers[index],
        lower = p.layers[index - 1];
      if (upper.type === 'adjustment' || lower.type === 'adjustment')
        throw new Error('Merge Down works on pixel, text, and shape layers.');
      const out = makeCanvas(p.width, p.height);
      const pair = {
        ...p,
        background: null,
        adjustments: { brightness: 0, contrast: 0, saturation: 0, hue: 0, blur: 0, grayscale: 0 },
        crop: { x: 0, y: 0, width: p.width, height: p.height },
        layers: [{ ...lower, clip: false }, { ...upper }],
      };
      Core.renderProject(ctx2d(out, true), pair, editor.resolveStoredSource, {
        view: { scale: 1, x: 0, y: 0 },
        adjust: editor.adjust,
      });
      const id = rasters.fromCanvas(out);
      const merged = {
        id: lower.id,
        type: 'image',
        name: lower.name,
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: lower.locked,
        groupId: lower.groupId,
        transform: { x: p.width / 2, y: p.height / 2, scaleX: 1, scaleY: 1, rotation: 0 },
        source: {
          id,
          name: `${lower.name}.png`,
          mime: 'image/png',
          width: p.width,
          height: p.height,
          size: 0,
        },
      };
      const layers = p.layers.slice();
      layers.splice(index - 1, 2, merged);
      store().replace({ ...p, layers, selectedLayerId: lower.id }, 'Merge Down');
    }

    function flattenImage() {
      const p = project();
      if (!p.layers.length) throw new Error('There is nothing to flatten.');
      const out = renderMerged();
      const id = rasters.fromCanvas(out);
      const layer = {
        id: `layer-${Raster.randomId().slice(3)}`,
        type: 'image',
        name: 'Background',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        transform: { x: p.width / 2, y: p.height / 2, scaleX: 1, scaleY: 1, rotation: 0 },
        source: {
          id,
          name: 'Background.png',
          mime: 'image/png',
          width: p.width,
          height: p.height,
          size: 0,
        },
      };
      store().replace(
        {
          ...p,
          background: null,
          adjustments: { brightness: 0, contrast: 0, saturation: 0, hue: 0, blur: 0, grayscale: 0 },
          layers: [layer],
          selectedLayerId: layer.id,
        },
        'Flatten Image',
      );
    }

    function addAdjustment(kind) {
      let next = Core.addAdjustmentLayer(
        project(),
        kind,
        Px.ADJUSTMENT_DEFAULTS[kind] ? structuredClone(Px.ADJUSTMENT_DEFAULTS[kind]) : {},
      );
      const selection = selectionCanvas();
      if (selection) {
        const p = project();
        const id = rasters.fromCanvas(cloneCanvas(selection));
        next = Core.setRasterMask(next, next.selectedLayerId, {
          id,
          name: 'Adjustment mask.png',
          mime: 'image/png',
          width: p.width,
          height: p.height,
          size: 0,
        });
        const withoutSelection = { ...next };
        delete withoutSelection.selection;
        next = withoutSelection;
      }
      store().replace(next, `New ${ADJUSTMENT_LABELS[kind]} layer`);
      showPanel('properties');
    }

    // ------------------------------------------------------------ filters

    let preview = null; // { sourceId, canvas }
    async function applyFilter(spec, params) {
      await editor.runOperation(`Applying ${spec.label.replace('…', '')}…`, async () => {
        const started = performance.now();
        await processTarget(
          spec.label.replace('…', ''),
          (image) => worker.run('applyFilter', { image, name: spec.name, params }),
          {
            pad: filterPad(spec, params),
            fullContext: spec.fullContext === true,
            maskAllowed: true,
          },
        );
        status(
          `${spec.label.replace('…', '')} applied in ${Math.round(performance.now() - started)} ms${worker.threaded ? ' (background thread)' : ''}.`,
        );
      });
    }

    function filterPad(spec, params) {
      if (
        spec.name === 'gaussian-blur' ||
        spec.name === 'unsharp-mask' ||
        spec.name === 'high-pass'
      )
        return (params.radius || 1) * 3;
      if (spec.name === 'motion-blur') return params.distance || 10;
      if (spec.name === 'pixelate') return params.cellSize || 10;
      return 4;
    }

    // Live preview on a reduced copy of the layer; parameters scale with it.
    function previewFilter(spec, params) {
      try {
        // Same target as applyFilter/processTarget: the mask when painting on it.
        const target = pixelTarget({ noCreate: true });
        const { picture } = pictureFor(target);
        const scale = Math.min(1, 1200 / Math.max(picture.width, picture.height));
        const w = Math.max(1, Math.round(picture.width * scale)),
          h = Math.max(1, Math.round(picture.height * scale));
        const small = makeCanvas(w, h);
        ctx2d(small).drawImage(picture, 0, 0, w, h);
        const scaled = { ...params };
        for (const param of spec.params)
          if (param.scale && typeof scaled[param.key] === 'number')
            scaled[param.key] = Math.max(param.min, scaled[param.key] * scale);
        const result = Px.applyFilter(readPixels(small), spec.name, scaled);
        const out = pixelsToCanvas(result);
        const selection = selectionInLayer(target.layer);
        const canvasOut = makeCanvas(picture.width, picture.height);
        const cc = ctx2d(canvasOut);
        cc.drawImage(picture, 0, 0);
        if (selection) {
          const masked = makeCanvas(picture.width, picture.height);
          const mc = ctx2d(masked);
          mc.drawImage(out, 0, 0, picture.width, picture.height);
          mc.globalCompositeOperation = 'destination-in';
          mc.drawImage(selection, 0, 0);
          if (spec.preserveAlpha) {
            // Replace the selected fraction instead of stacking a translucent
            // filtered copy on top (which would increase alpha in preview).
            cc.globalCompositeOperation = 'destination-out';
            cc.drawImage(selection, 0, 0);
            cc.globalCompositeOperation = 'lighter';
          }
          cc.drawImage(masked, 0, 0);
        } else {
          cc.globalCompositeOperation = 'copy';
          cc.drawImage(out, 0, 0, picture.width, picture.height);
        }
        preview = { canvas: canvasOut };
        showLive(target, canvasOut);
      } catch (error) {
        status(error.message, 'error');
      }
    }
    function clearPreview() {
      preview = null;
      endLive();
    }

    // ------------------------------------------------------------ transform

    function layerCorners(layer) {
      const size =
        layer.type === 'image'
          ? layerSize(layer)
          : layer.type === 'shape'
            ? { width: layer.width, height: layer.height }
            : null;
      if (!size) return null;
      if (layer.type === 'shape') {
        const t = layer.transform;
        let m = new DOMMatrix().translate(t.x, t.y).rotate(t.rotation || 0);
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
        m = m.scale(t.scaleX, t.scaleY).translate(-size.width / 2, -size.height / 2);
        return [
          [0, 0],
          [size.width, 0],
          [size.width, size.height],
          [0, size.height],
        ].map(([x, y]) => m.transformPoint(new DOMPoint(x, y)));
      }
      return [
        [0, 0],
        [size.width, 0],
        [size.width, size.height],
        [0, size.height],
      ].map(([x, y]) => layerToProject(layer, { x, y }));
    }

    function textBounds(layer) {
      const context = ctx2d(makeCanvas(1, 1));
      context.font = `${layer.italic ? 'italic ' : ''}${layer.fontWeight} ${layer.fontSize}px ${layer.fontFamily}`;
      const lines = layer.text.split('\n');
      const width =
        Math.max(...lines.map((line) => context.measureText(line).width)) +
        Math.max(0, layer.letterSpacing || 0) * Math.max(...lines.map((l) => l.length));
      const height = lines.length * layer.fontSize * (layer.lineHeight || 1.2);
      const offsetX = layer.align === 'left' ? width / 2 : layer.align === 'right' ? -width / 2 : 0;
      return { width: Math.max(8, width), height: Math.max(8, height), offsetX };
    }

    function transformFrame(layer) {
      const t = layer.transform;
      let size,
        offsetX = 0;
      if (layer.type === 'image') size = layerSize(layer);
      else if (layer.type === 'shape') size = { width: layer.width, height: layer.height };
      else if (layer.type === 'text') {
        const b = textBounds(layer);
        size = b;
        offsetX = b.offsetX;
      } else return null;
      return { width: size.width, height: size.height, offsetX, t };
    }

    function frameMatrix(frame, transform) {
      const t = transform;
      let m = new DOMMatrix().translate(t.x, t.y).rotate(t.rotation || 0);
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
      return m
        .scale(t.scaleX, t.scaleY)
        .translate(frame.offsetX - frame.width / 2, -frame.height / 2);
    }

    function beginTransform() {
      const layer = selectedLayer();
      if (!layer || layer.type === 'adjustment')
        throw new Error('Select a pixel, text, or shape layer to transform.');
      if (layer.locked) throw new Error(`${layer.name} is locked.`);
      const frame = transformFrame(layer);
      state.transform = {
        layerId: layer.id,
        frame,
        start: { ...layer.transform },
        current: { ...layer.transform },
        drag: null,
      };
      renderOptions();
      scheduleOverlay();
      status(
        'Free Transform: drag corners to scale (Shift keeps proportions free), drag outside to rotate, Ctrl-drag an edge to skew. Enter applies, Escape cancels.',
      );
    }

    function transformPoints() {
      const tr = state.transform;
      const m = frameMatrix(tr.frame, tr.current);
      return [
        [0, 0],
        [tr.frame.width, 0],
        [tr.frame.width, tr.frame.height],
        [0, tr.frame.height],
      ].map(([x, y]) => m.transformPoint(new DOMPoint(x, y)));
    }

    function drawTransformBox(context, t, dpr) {
      const points = transformPoints();
      context.setTransform(1, 0, 0, 1, 0, 0);
      const device = points.map((p) => ({
        x: (t.x + p.x * t.zoom) * dpr,
        y: (t.y + p.y * t.zoom) * dpr,
      }));
      context.lineWidth = 1;
      context.strokeStyle = '#19d3ff';
      context.beginPath();
      device.forEach((p, i) => (i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y)));
      context.closePath();
      context.stroke();
      const handles = [
        ...device,
        ...device.map((p, i) => {
          const q = device[(i + 1) % 4];
          return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
        }),
      ];
      context.fillStyle = '#ffffff';
      const r = (coarsePointer?.matches ? 7 : 4) * dpr;
      // A small box shows corner handles only, a tiny one just its outline, so the
      // handles never bury the layer (the hit areas stay the same size).
      const side = Math.min(
        Math.hypot(device[1].x - device[0].x, device[1].y - device[0].y),
        Math.hypot(device[3].x - device[0].x, device[3].y - device[0].y),
      );
      const shown = side < 6 * r ? [] : side < 14 * r ? handles.slice(0, 4) : handles;
      for (const h of shown) {
        context.fillRect(h.x - r, h.y - r, 2 * r, 2 * r);
        context.strokeRect(h.x - r, h.y - r, 2 * r, 2 * r);
      }
    }

    function transformHit(clientPoint, touch = false) {
      const t = editor.view.transform();
      const rect = canvas.getBoundingClientRect();
      const points = transformPoints().map((p) => ({
        x: rect.left + t.x + p.x * t.zoom,
        y: rect.top + t.y + p.y * t.zoom,
      }));
      const handles = [
        ...points.map((p, i) => ({ ...p, kind: 'corner', index: i })),
        ...points.map((p, i) => {
          const q = points[(i + 1) % 4];
          return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, kind: 'edge', index: i };
        }),
      ];
      // Fingers get a 24px reach (Apple's 44pt target); a mouse keeps 9px.
      const reach = touch ? 24 : 9;
      let best = null,
        bestDistance = reach;
      for (const h of handles) {
        const distance = Math.hypot(clientPoint.x - h.x, clientPoint.y - h.y);
        if (distance <= bestDistance) {
          best = h;
          bestDistance = distance;
        }
      }
      if (best) return best;
      // Inside the quad moves; just outside rotates (transform controls: only a band
      // around the box rotates, so a tap elsewhere can pick another layer).
      if (pointInQuad(clientPoint, points)) return { kind: 'move' };
      if (!state.transform?.auto) return { kind: 'rotate' };
      const band = touch ? 40 : 24;
      const near = points.some((p, i) => {
        const q = points[(i + 1) % 4];
        return distanceToSegment(clientPoint, p, q) <= band;
      });
      return near ? { kind: 'rotate' } : { kind: 'outside' };
    }

    function distanceToSegment(p, a, b) {
      const dx = b.x - a.x,
        dy = b.y - a.y,
        len = dx * dx + dy * dy;
      const k = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
      return Math.hypot(p.x - (a.x + k * dx), p.y - (a.y + k * dy));
    }

    function pointInQuad(p, quad) {
      let inside = false;
      for (let i = 0, j = quad.length - 1; i < quad.length; j = i, i += 1) {
        const a = quad[i],
          b = quad[j];
        if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
          inside = !inside;
      }
      return inside;
    }

    function transformDrag(event) {
      const tr = state.transform;
      const d = tr.drag;
      const point = editor.view.clientToProject(event.clientX, event.clientY);
      const start = d.start;
      const t = { ...d.transform };
      if (d.hit.kind === 'move') {
        t.x += point.x - d.point.x;
        t.y += point.y - d.point.y;
      } else if (d.hit.kind === 'rotate') {
        const a0 = Math.atan2(d.point.y - start.y, d.point.x - start.x);
        const a1 = Math.atan2(point.y - start.y, point.x - start.x);
        let angle = d.transform.rotation + ((a1 - a0) * 180) / Math.PI;
        if (event.shiftKey) angle = Math.round(angle / 15) * 15;
        t.rotation = angle;
      } else {
        // Work in the frame's local (unrotated) axes.
        const m = frameMatrix(tr.frame, d.transform);
        const inv = m.inverse();
        const local = inv.transformPoint(new DOMPoint(point.x, point.y));
        const w = tr.frame.width,
          h = tr.frame.height;
        const index = d.hit.index;
        if (d.hit.kind === 'edge' && (event.ctrlKey || event.metaKey)) {
          // Skew along the dragged edge.
          const startLocal = inv.transformPoint(new DOMPoint(d.point.x, d.point.y));
          if (index === 0 || index === 2)
            t.skewX = Math.max(
              -80,
              Math.min(
                80,
                (d.transform.skewX || 0) +
                  (Math.atan2((local.x - startLocal.x) * (index === 0 ? -1 : 1), h) * 180) /
                    Math.PI,
              ),
            );
          else
            t.skewY = Math.max(
              -80,
              Math.min(
                80,
                (d.transform.skewY || 0) +
                  (Math.atan2((local.y - startLocal.y) * (index === 3 ? -1 : 1), w) * 180) /
                    Math.PI,
              ),
            );
        } else {
          // Opposite anchor stays fixed.
          const corners = [
            [0, 0],
            [w, 0],
            [w, h],
            [0, h],
          ];
          let ax,
            ay,
            sx = 1,
            sy = 1;
          if (d.hit.kind === 'corner') {
            [ax, ay] = corners[(index + 2) % 4];
            sx = (local.x - ax) / (corners[index][0] - ax);
            sy = (local.y - ay) / (corners[index][1] - ay);
            if (!event.shiftKey) {
              const k = Math.abs(sx) > Math.abs(sy) ? sx : sy;
              sx = Math.sign(sx || 1) * Math.abs(k);
              sy = Math.sign(sy || 1) * Math.abs(k);
            }
          } else {
            const edge = [
              [w / 2, 0],
              [w, h / 2],
              [w / 2, h],
              [0, h / 2],
            ];
            [ax, ay] = edge[(index + 2) % 4];
            if (index === 0 || index === 2) sy = (local.y - ay) / (edge[index][1] - ay);
            else sx = (local.x - ax) / (edge[index][0] - ax);
          }
          if (!Number.isFinite(sx) || Math.abs(sx) < 0.01) sx = 0.01 * Math.sign(sx || 1);
          if (!Number.isFinite(sy) || Math.abs(sy) < 0.01) sy = 0.01 * Math.sign(sy || 1);
          const anchorWorld = m.transformPoint(new DOMPoint(ax, ay));
          t.scaleX = d.transform.scaleX * sx;
          t.scaleY = d.transform.scaleY * sy;
          const m2 = frameMatrix(tr.frame, { ...t, x: 0, y: 0 });
          const anchorNew = m2.transformPoint(new DOMPoint(ax, ay));
          t.x = anchorWorld.x - anchorNew.x;
          t.y = anchorWorld.y - anchorNew.y;
        }
      }
      tr.current = t;
      editor.previewProject(Core.updateLayer(project(), tr.layerId, { transform: t }));
      scheduleOverlay();
      renderOptions(true);
    }

    function commitTransform(apply = true) {
      const tr = state.transform;
      state.transform = null;
      if (tr && apply && JSON.stringify(tr.current) !== JSON.stringify(tr.start)) {
        store().replace(
          Core.updateLayer(project(), tr.layerId, { transform: tr.current }),
          tr.auto ? 'Transform' : 'Free Transform',
        );
      } else editor.requestRender();
      if (!tr?.auto) renderOptions();
      syncAutoTransform();
      scheduleOverlay();
    }

    // Transform controls (Move tool): the selected text, shape or image layer always
    // shows its box. Drag a corner to resize, an edge to stretch, inside to move,
    // just outside to rotate; each drag is one undo step. Tap another layer to pick it.
    const coarsePointer = globalThis.matchMedia?.('(pointer: coarse)');
    function autoTransformLayer() {
      if (state.tool !== 'move' || state.autoTransform === false || state.targetMask) return null;
      const layer = selectedLayer();
      if (
        !layer ||
        layer.locked ||
        layer.visible === false ||
        !['image', 'shape', 'text'].includes(layer.type)
      )
        return null;
      if (currentSelection()) return null; // a pixel selection moves pixels instead
      return layer;
    }
    function syncAutoTransform() {
      if (state.transform && (!state.transform.auto || state.transform.drag)) return;
      const layer = autoTransformLayer();
      const frame = layer && transformFrame(layer);
      state.transform = frame
        ? {
            auto: true,
            layerId: layer.id,
            frame,
            start: { ...layer.transform },
            current: { ...layer.transform },
            drag: null,
          }
        : null;
      scheduleOverlay();
    }
    // Topmost visible layer whose box contains the project point.
    function layerAtPoint(point) {
      for (const layer of [...project().layers].reverse()) {
        if (layer.visible === false || !['image', 'shape', 'text'].includes(layer.type)) continue;
        const frame = transformFrame(layer);
        if (!frame) continue;
        const local = frameMatrix(frame, layer.transform)
          .inverse()
          .transformPoint(new DOMPoint(point.x, point.y));
        if (local.x >= 0 && local.y >= 0 && local.x <= frame.width && local.y <= frame.height)
          return layer;
      }
      return null;
    }

    // ------------------------------------------------------------ crop tool

    const RATIOS = {
      free: null,
      original: 'original',
      '1:1': 1,
      '4:5': 4 / 5,
      '5:4': 5 / 4,
      '3:2': 3 / 2,
      '2:3': 2 / 3,
      '16:9': 16 / 9,
      '9:16': 9 / 16,
    };
    function cropRatio() {
      const value = RATIOS[state.crop.ratio];
      if (value === 'original') return project().width / project().height;
      return value;
    }
    function startCropTool() {
      const p = project();
      state.crop.box = { ...p.crop };
      scheduleOverlay();
    }
    // A ratio is a real box: the largest of that shape, centred on the canvas. Free keeps the current box.
    function setCropRatio(ratio) {
      state.crop.ratio = ratio;
      if (state.tool !== 'crop') setTool('crop');
      const p = project(),
        value = cropRatio();
      if (value) {
        const width = Math.min(p.width, p.height * value),
          height = width / value;
        state.crop.box = {
          x: Math.round((p.width - width) / 2),
          y: Math.round((p.height - height) / 2),
          width: Math.round(width),
          height: Math.round(height),
        };
      }
      scheduleOverlay();
      renderOptions();
    }
    function resetCrop() {
      state.crop.box = { x: 0, y: 0, width: project().width, height: project().height };
      scheduleOverlay();
      renderOptions(true);
    }
    function drawCropBox(context, t, dpr) {
      const box = state.crop.box;
      context.setTransform(1, 0, 0, 1, 0, 0);
      const x = (t.x + box.x * t.zoom) * dpr,
        y = (t.y + box.y * t.zoom) * dpr,
        w = box.width * t.zoom * dpr,
        h = box.height * t.zoom * dpr;
      context.fillStyle = 'rgba(0,0,0,0.55)';
      context.beginPath();
      context.rect(0, 0, overlay.width, overlay.height);
      context.rect(x, y, w, h);
      context.fill('evenodd');
      context.strokeStyle = '#ffffff';
      context.lineWidth = 1;
      context.strokeRect(x, y, w, h);
      context.strokeStyle = 'rgba(255,255,255,0.45)';
      context.beginPath();
      for (let k = 1; k < 3; k += 1) {
        context.moveTo(x + (w * k) / 3, y);
        context.lineTo(x + (w * k) / 3, y + h);
        context.moveTo(x, y + (h * k) / 3);
        context.lineTo(x + w, y + (h * k) / 3);
      }
      context.stroke();
      context.fillStyle = '#ffffff';
      for (const [hx, hy] of cropHandles(x, y, w, h))
        context.fillRect(hx - 4 * dpr, hy - 4 * dpr, 8 * dpr, 8 * dpr);
    }
    function cropHandles(x, y, w, h) {
      return [
        [x, y],
        [x + w / 2, y],
        [x + w, y],
        [x + w, y + h / 2],
        [x + w, y + h],
        [x + w / 2, y + h],
        [x, y + h],
        [x, y + h / 2],
      ];
    }
    function cropHit(clientPoint) {
      const t = editor.view.transform();
      const rect = canvas.getBoundingClientRect();
      const box = state.crop.box;
      const x = rect.left + t.x + box.x * t.zoom,
        y = rect.top + t.y + box.y * t.zoom,
        w = box.width * t.zoom,
        h = box.height * t.zoom;
      const handles = cropHandles(x, y, w, h);
      for (let i = 0; i < handles.length; i += 1)
        if (Math.hypot(clientPoint.x - handles[i][0], clientPoint.y - handles[i][1]) <= 10)
          return i;
      // Inside a box smaller than the canvas moves it; otherwise dragging draws a new box.
      const p = project();
      const full = box.x <= 0 && box.y <= 0 && box.width >= p.width && box.height >= p.height;
      if (
        !full &&
        clientPoint.x > x &&
        clientPoint.x < x + w &&
        clientPoint.y > y &&
        clientPoint.y < y + h
      )
        return 'move';
      return 'new';
    }
    function cropDrag(event) {
      const d = draft;
      const p = project();
      const point = editor.view.clientToProject(event.clientX, event.clientY);
      const dx = point.x - d.point.x,
        dy = point.y - d.point.y;
      let { x, y, width, height } = d.box;
      const ratio = cropRatio();
      if (d.hit === 'move') {
        x = Math.max(0, Math.min(p.width - width, x + dx));
        y = Math.max(0, Math.min(p.height - height, y + dy));
      } else if (d.hit === 'new') {
        x = Math.min(d.point.x, point.x);
        y = Math.min(d.point.y, point.y);
        width = Math.abs(point.x - d.point.x);
        height = Math.abs(point.y - d.point.y);
        if (ratio) {
          if (width / Math.max(1, height) > ratio) width = height * ratio;
          else height = width / ratio;
          if (point.x < d.point.x) x = d.point.x - width;
          if (point.y < d.point.y) y = d.point.y - height;
        }
      } else {
        const i = d.hit;
        if ([0, 6, 7].includes(i)) {
          x += dx;
          width -= dx;
        }
        if ([2, 3, 4].includes(i)) width += dx;
        if ([0, 1, 2].includes(i)) {
          y += dy;
          height -= dy;
        }
        if ([4, 5, 6].includes(i)) height += dy;
        if (ratio) {
          if ([1, 5].includes(i)) {
            const nw = height * ratio;
            x -= (nw - width) / 2;
            width = nw;
          } else {
            const nh = width / ratio;
            if ([0, 1, 2].includes(i)) y -= nh - height;
            height = nh;
          }
        }
      }
      width = Math.max(1, width);
      height = Math.max(1, height);
      x = Math.max(0, Math.min(p.width - 1, x));
      y = Math.max(0, Math.min(p.height - 1, y));
      width = Math.min(width, p.width - x);
      height = Math.min(height, p.height - y);
      state.crop.box = {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
      };
      scheduleOverlay();
      renderOptions(true);
    }
    function applyCrop() {
      if (!state.crop.box) return;
      store().replace(Core.setCrop(project(), state.crop.box), 'Crop');
      editor.view.fit('fit');
      status(
        `Cropped to ${state.crop.box.width}×${state.crop.box.height}. The crop is non-destructive: pixels outside stay in the layers, and Undo or a new crop brings them back.`,
      );
    }

    // Rotate every layer about the crop center (Image › Rotate / Straighten).
    // Canvas-pinned adjustment masks cannot follow a canvas rotation or flip.
    function assertNoPinnedMasks(verb) {
      if (project().layers.some((layer) => layer.type === 'adjustment' && layer.rasterMask))
        throw new Error(
          `Remove adjustment-layer masks before ${verb}; they are pinned to canvas pixels.`,
        );
    }
    const withoutSelection = (next) => {
      const out = { ...next };
      delete out.selection;
      return out;
    };

    // Rotate every layer about the canvas centre (Image › Rotate / Straighten).
    // Quarter and half turns also carry the crop; other angles keep the canvas and crop.
    function rotateCanvas(angle, label = 'Rotate canvas') {
      assertNoPinnedMasks('rotating');
      const p = project();
      const cx = p.width / 2,
        cy = p.height / 2;
      const rad = (angle * Math.PI) / 180,
        cos = Math.cos(rad),
        sin = Math.sin(rad);
      let next = p;
      for (const layer of p.layers) {
        if (layer.type === 'adjustment') continue;
        const dx = layer.transform.x - cx,
          dy = layer.transform.y - cy;
        next = Core.updateLayer(next, layer.id, {
          transform: {
            x: cx + dx * cos - dy * sin,
            y: cy + dx * sin + dy * cos,
            rotation: layer.transform.rotation + angle,
          },
        });
      }
      const turn = ((Math.round(angle) % 360) + 360) % 360;
      const c = p.crop;
      if (Number.isInteger(angle) && (turn === 90 || turn === 270)) {
        // Quarter turns swap the canvas dimensions and recentre the layers.
        const shiftX = (p.height - p.width) / 2,
          shiftY = (p.width - p.height) / 2;
        for (const layer of next.layers)
          if (layer.type !== 'adjustment')
            next = Core.updateLayer(next, layer.id, {
              transform: { x: layer.transform.x + shiftX, y: layer.transform.y + shiftY },
            });
        const crop =
          turn === 90
            ? { x: p.height - c.y - c.height, y: c.x, width: c.height, height: c.width }
            : { x: c.y, y: p.width - c.x - c.width, width: c.height, height: c.width };
        next = withoutSelection({ ...next, width: p.height, height: p.width, crop });
      } else if (Number.isInteger(angle) && turn === 180) {
        next = withoutSelection({
          ...next,
          crop: {
            x: p.width - c.x - c.width,
            y: p.height - c.y - c.height,
            width: c.width,
            height: c.height,
          },
        });
      }
      store().replace(next, label);
      editor.view.fit('fit');
    }

    // Mirror every layer (and the crop) across the canvas centre. Mirroring
    // T·R(θ)·K(kx,ky)·S(sx,sy) gives R(−θ), K(−kx,−ky) and one scale negated.
    function flipCanvas(axis) {
      assertNoPinnedMasks('flipping');
      const p = project();
      let next = p;
      for (const layer of p.layers) {
        if (layer.type === 'adjustment') continue;
        const t = layer.transform;
        const common = { rotation: -t.rotation, skewX: -(t.skewX || 0), skewY: -(t.skewY || 0) };
        next = Core.updateLayer(
          next,
          layer.id,
          axis === 'horizontal'
            ? { transform: { ...common, x: p.width - t.x, scaleX: -t.scaleX } }
            : { transform: { ...common, y: p.height - t.y, scaleY: -t.scaleY } },
        );
      }
      const c = p.crop;
      const crop =
        axis === 'horizontal'
          ? { ...c, x: p.width - c.x - c.width }
          : { ...c, y: p.height - c.y - c.height };
      store().replace(
        withoutSelection({ ...next, crop }),
        axis === 'horizontal' ? 'Flip canvas horizontal' : 'Flip canvas vertical',
      );
    }

    // ------------------------------------------------------------ type tool

    let textEditor = null;
    let lastBoxTap = null;
    function openTextEditor(layer, pending = null) {
      closeTextEditor(true);
      const area = document.createElement('textarea');
      area.className = 'ap-text-editor';
      area.value = layer.text;
      area.setAttribute('aria-label', 'Edit text layer');
      const t = editor.view.transform();
      const rect = viewport.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      const client = editor.view.projectToClient(layer.transform.x, layer.transform.y);
      const size = Math.max(10, layer.fontSize * t.zoom * Math.abs(layer.transform.scaleY));
      area.style.left = `${client.x - rect.left}px`;
      area.style.top = `${client.y - rect.top}px`;
      area.style.font = `${layer.italic ? 'italic ' : ''}${layer.fontWeight} ${size}px ${layer.fontFamily}`;
      area.style.color = layer.color;
      area.style.textAlign = layer.align;
      area.style.lineHeight = String(layer.lineHeight || 1.2);
      void canvasRect;
      viewport.append(area);
      textEditor = { area, layerId: layer.id, pending };
      if (pending) area.placeholder = 'Type here';
      area.focus();
      area.select();
      area.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          closeTextEditor(false);
        } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          closeTextEditor(true);
        }
      });
      area.addEventListener('blur', () => closeTextEditor(true));
    }
    function closeTextEditor(commit) {
      const current = textEditor;
      textEditor = null;
      if (!current) return;
      current.area.remove();
      if (current.pending) {
        const text = current.area.value.slice(0, 2000);
        if (!commit || !text.trim()) return;
        const { point, props } = current.pending;
        const added = Core.addTextLayer(project(), { ...props, text });
        store().replace(
          Core.updateLayer(added, added.selectedLayerId, {
            transform: { x: point.x, y: point.y },
            italic: state.type.italic,
            lineHeight: state.type.lineHeight,
            letterSpacing: state.type.letterSpacing,
          }),
          'Type Tool',
        );
        return;
      }
      const layer = project().layers.find((item) => item.id === current.layerId);
      if (commit && layer && current.area.value.trim() && current.area.value !== layer.text) {
        store().replace(
          Core.updateLayer(project(), layer.id, { text: current.area.value.slice(0, 2000) }),
          'Edit text',
        );
      }
    }

    function addTextAt(point) {
      // New text is at least ~28 screen px tall at the current zoom (a 72 px default is a
      // speck on a large canvas viewed on a phone), never more than a third of the canvas.
      const p = project();
      const readable = Math.round(
        Math.min(28 / Math.max(editor.view.zoom || 1, 0.01), Math.min(p.width, p.height) / 3),
      );
      const props = {
        fontSize: Math.min(1024, Math.max(state.type.fontSize, readable)),
        fontFamily: state.type.fontFamily,
        fontWeight: state.type.fontWeight,
        color: state.fg,
        align: state.type.align,
      };
      const draftLayer = {
        id: 'pending-text',
        text: '',
        transform: { x: point.x, y: point.y, scaleX: 1, scaleY: 1, rotation: 0 },
        italic: state.type.italic,
        lineHeight: state.type.lineHeight,
        ...props,
      };
      openTextEditor(draftLayer, { point, props });
    }

    function hitTextLayer(point) {
      const layers = [...project().layers].reverse();
      for (const layer of layers) {
        if (layer.type !== 'text' || !layer.visible) continue;
        const frame = transformFrame(layer);
        const local = frameMatrix(frame, layer.transform)
          .inverse()
          .transformPoint(new DOMPoint(point.x, point.y));
        if (local.x >= 0 && local.y >= 0 && local.x <= frame.width && local.y <= frame.height)
          return layer;
      }
      return null;
    }

    // ------------------------------------------------------------ moving selected pixels

    let pixelMove = null;
    function beginPixelMove(point, pointerId) {
      const target = pixelTarget({ mask: false });
      const { id, picture } = pictureFor(target);
      const selection = selectionInLayer(target.layer);
      const floating = cloneCanvas(picture);
      const fc = ctx2d(floating);
      fc.globalCompositeOperation = 'destination-in';
      fc.drawImage(selection, 0, 0);
      const base = cloneCanvas(picture);
      const bc = ctx2d(base);
      bc.globalCompositeOperation = 'destination-out';
      bc.drawImage(selection, 0, 0);
      pixelMove = {
        target,
        parentId: id,
        sourceId: target.source.id,
        floating,
        base,
        display: cloneCanvas(base),
        start: point,
        offset: { x: 0, y: 0 },
        pointerId,
      };
      updatePixelMove(0, 0);
    }
    // Project-space offset to the layer's pixel grid (linear part of the inverse transform).
    function layerDelta(layer, dx, dy) {
      const inv = layerMatrix(layer).inverse();
      return { x: inv.a * dx + inv.c * dy, y: inv.b * dx + inv.d * dy };
    }
    function updatePixelMove(dx, dy) {
      const m = pixelMove;
      m.offset = { x: dx, y: dy };
      const d = layerDelta(m.target.layer, dx, dy);
      // On a 1:1 layer, whole-pixel moves stay crisp. On a scaled or rotated layer the
      // pixels move by the exact layer-space delta, so they stay under the selection
      // (which moves by whole project pixels) instead of drifting by rounding.
      const exact = !isIdentityPlaced(m.target.layer);
      const dc = ctx2d(m.display);
      dc.clearRect(0, 0, m.display.width, m.display.height);
      dc.drawImage(m.base, 0, 0);
      dc.drawImage(m.floating, exact ? d.x : Math.round(d.x), exact ? d.y : Math.round(d.y));
      showLive(m.target, m.display);
      scheduleOverlay();
    }
    function finishPixelMove(commit) {
      const m = pixelMove;
      pixelMove = null;
      live = null;
      if (!m) return;
      if (!commit || (!m.offset.x && !m.offset.y)) {
        editor.requestRender();
        scheduleOverlay();
        return;
      }
      const p = project();
      const layer = p.layers.find((item) => item.id === m.target.layer.id);
      if (!layer || layer.source.id !== m.sourceId) {
        status(
          'The move was discarded because the layer changed while it was in progress.',
          'error',
        );
        editor.requestRender();
        return;
      }
      const newId = rasters.commit(m.parentId, m.display, null);
      const selection = currentSelection();
      let next = Core.updateLayer(p, layer.id, {
        source: { ...layer.source, id: newId, mime: 'image/png', size: 0 },
      });
      if (selection) {
        const shifted = new Uint8ClampedArray(selection.mask.length);
        const { width, height } = selection;
        for (let y = 0; y < height; y += 1) {
          const sy = y - m.offset.y;
          if (sy < 0 || sy >= height) continue;
          const sx0 = Math.max(0, -m.offset.x),
            sx1 = Math.min(width, width - m.offset.x);
          if (sx1 > sx0)
            shifted.set(
              selection.mask.subarray(sy * width + sx0, sy * width + sx1),
              y * width + sx0 + m.offset.x,
            );
        }
        const bounds = Px.maskBounds(shifted, width, height);
        if (bounds) {
          const selectionId = `sel-${Raster.randomId().slice(3)}`;
          selections.set(selectionId, { width, height, runs: Raster.encodeRuns(shifted), bounds });
          lastSelectionId = selectionId;
          next = { ...next, selection: { id: selectionId } };
        } else {
          next = { ...next };
          delete next.selection;
        }
      }
      store().replace(next, 'Move selection');
    }
    function nudge(dx, dy) {
      const layer = selectedLayer();
      if (!layer || layer.type === 'adjustment') return false;
      if (currentSelection() && layer.type === 'image') {
        const selection = currentSelection();
        beginPixelMove({ x: selection.bounds.x, y: selection.bounds.y }, -1);
        updatePixelMove(dx, dy);
        finishPixelMove(true);
        return true;
      }
      if (layer.locked) throw new Error(`${layer.name} is locked.`);
      store().replace(
        Core.updateLayer(project(), layer.id, {
          transform: { x: layer.transform.x + dx, y: layer.transform.y + dy },
        }),
        'Nudge',
      );
      return true;
    }

    // ------------------------------------------------------------ pointer handling

    let pan = null;
    function guard(fn) {
      try {
        const result = fn();
        if (result && typeof result.catch === 'function')
          result.catch((error) => status(error.message, 'error'));
        return result;
      } catch (error) {
        status(error.message, 'error');
        return null;
      }
    }

    function selectionToolActive() {
      return ['marquee', 'lasso', 'wand'].includes(state.tool);
    }

    // Two-finger pinch/pan on touch screens. Registered before the tool handler so it
    // sees every touch, and a second finger cancels the stroke the first one started.
    const touches = new Map();
    let pinch = null;
    viewport.addEventListener(
      'pointerdown',
      (event) => {
        if (event.pointerType !== 'touch') return;
        touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (touches.size === 2) {
          if (stroke) endStroke(false);
          draft = null;
          const [a, b] = [...touches.values()];
          pinch = {
            distance: Math.hypot(a.x - b.x, a.y - b.y),
            zoom: editor.view.zoom,
            cx: (a.x + b.x) / 2,
            cy: (a.y + b.y) / 2,
          };
          event.stopImmediatePropagation();
        }
      },
      true,
    );
    viewport.addEventListener(
      'pointermove',
      (event) => {
        if (!touches.has(event.pointerId)) return;
        touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pinch && touches.size === 2) {
          const [a, b] = [...touches.values()];
          const cx = (a.x + b.x) / 2,
            cy = (a.y + b.y) / 2;
          editor.view.panBy(cx - pinch.cx, cy - pinch.cy);
          editor.view.setZoom(
            (pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.distance,
            cx,
            cy,
          );
          pinch.cx = cx;
          pinch.cy = cy;
          event.stopImmediatePropagation();
        }
      },
      true,
    );
    const touchEnd = (event) => {
      touches.delete(event.pointerId);
      if (touches.size < 2) pinch = null;
    };
    viewport.addEventListener('pointerup', touchEnd, true);
    viewport.addEventListener('pointercancel', touchEnd, true);

    // Pointer work on the canvas moves keyboard focus to it, so Enter/Space act on
    // the canvas (apply crop, pan) instead of the tool button clicked earlier.
    viewport.tabIndex = -1;
    viewport.addEventListener(
      'pointerdown',
      (event) => {
        if (!event.target.closest?.('.ap-text-editor') && document.activeElement !== viewport)
          viewport.focus({ preventScroll: true });
      },
      true,
    );
    viewport.addEventListener(
      'pointerdown',
      (event) => {
        if (editor.operation || event.target.closest?.('.ap-text-editor')) return;
        if (!event.isPrimary && event.pointerType !== 'mouse') return;
        const point = editor.view.clientToProject(event.clientX, event.clientY);
        const takeOver = () => {
          event.preventDefault();
          event.stopImmediatePropagation();
          viewport.setPointerCapture?.(event.pointerId);
        };
        if (textEditor) closeTextEditor(true);
        const ruler = event.target.closest?.('.ap-ruler');
        if (ruler && event.button === 0) {
          takeOver();
          const axis = ruler.classList.contains('ap-ruler-top') ? 'y' : 'x';
          guideDraft = {
            axis,
            value: axis === 'x' ? point.x : point.y,
            pointerId: event.pointerId,
          };
          state.showGuides = true;
          scheduleOverlay();
          return;
        }
        if (
          state.tool === 'move' &&
          event.button === 0 &&
          state.showGuides &&
          overlayGuides.length
        ) {
          const tolerance = 4 / editor.view.zoom;
          const index = overlayGuides.findIndex(
            (guide) =>
              Math.abs((guide.axis === 'x' ? point.x : point.y) - guide.value) <= tolerance,
          );
          if (index >= 0) {
            takeOver();
            const [guide] = overlayGuides.splice(index, 1);
            guideDraft = { ...guide, pointerId: event.pointerId };
            scheduleOverlay();
            return;
          }
        }
        if (event.button === 1 || state.spaceDown || state.tool === 'hand') {
          takeOver();
          pan = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
          viewport.dataset.panning = 'true';
          return;
        }
        if (event.button !== 0) return;
        if (
          state.tool === 'move' &&
          state.autoTransform !== false &&
          !currentSelection() &&
          (!state.transform || state.transform.auto) &&
          !event.target.closest?.('.ap-remove-overlay')
        ) {
          // Transform controls: a handle or the box edits the selected layer; a tap on
          // another layer selects it (and can drag it straight away).
          const touch = event.pointerType === 'touch' || event.pointerType === 'pen';
          const hit = state.transform
            ? transformHit({ x: event.clientX, y: event.clientY }, touch)
            : { kind: 'outside' };
          if (hit.kind === 'outside') {
            const target = layerAtPoint(point);
            if (target && target.id !== project().selectedLayerId) {
              // Select it; the base editor's drag (with guide snapping) moves it right away.
              store().replaceTransient(
                { ...project(), selectedLayerId: target.id },
                'Selected layer',
              );
              state.transform = null;
              scheduleOverlay();
              return;
            }
            if (!target) {
              state.transform = null;
              scheduleOverlay();
              return;
            } // empty canvas: the base editor keeps its drag-to-move
          } else {
            // Double-tap on text edits it, on touch as well as with a mouse.
            const layer = selectedLayer();
            const now = performance.now();
            if (
              layer?.type === 'text' &&
              hit.kind === 'move' &&
              lastBoxTap &&
              now - lastBoxTap.time < 350 &&
              lastBoxTap.id === layer.id
            ) {
              lastBoxTap = null;
              takeOver();
              state.transform = null;
              openTextEditor(layer);
              return;
            }
            lastBoxTap = { time: now, id: layer?.id };
            if (hit.kind === 'move') {
              // Moving stays with the base editor (guide snapping, one 'Moved layer' step);
              // the box hides while it moves and comes back on release.
              state.transform = null;
              scheduleOverlay();
              return;
            }
          }
          if (state.transform) {
            takeOver();
            const tr = state.transform;
            tr.drag = {
              hit: hit.kind === 'outside' ? { kind: 'move' } : hit,
              point,
              start: { x: tr.current.x, y: tr.current.y },
              transform: { ...tr.current },
              pointerId: event.pointerId,
            };
          }
          return;
        }
        if (state.transform && !state.transform.auto) {
          takeOver();
          const hit = transformHit(
            { x: event.clientX, y: event.clientY },
            event.pointerType === 'touch' || event.pointerType === 'pen',
          );
          const tr = state.transform;
          tr.drag = {
            hit,
            point,
            start: { x: tr.current.x, y: tr.current.y },
            transform: { ...tr.current },
            pointerId: event.pointerId,
          };
          return;
        }
        if (state.tool === 'zoom') {
          takeOver();
          const factor = event.altKey ? 0.5 : 2;
          editor.view.setZoom(editor.view.zoom * factor, event.clientX, event.clientY);
          return;
        }
        if (state.tool === 'move') {
          const selection = currentSelection();
          const layer = selectedLayer();
          const inside =
            selection &&
            point.x >= 0 &&
            point.y >= 0 &&
            point.x < selection.width &&
            point.y < selection.height &&
            selection.mask[Math.floor(point.y) * selection.width + Math.floor(point.x)] > 127;
          if (!inside || layer?.type !== 'image') return; // the base editor drags the whole layer
          takeOver();
          guard(() => beginPixelMove(point, event.pointerId));
          return;
        }
        takeOver();
        guard(() => {
          if (state.tool === 'marquee') {
            const start = snapPoint(point);
            draft = {
              kind: 'marquee',
              shape: state.variant.marquee,
              start,
              rect: { x: point.x, y: point.y, width: 0, height: 0 },
              mode: modifiers(event),
              pointerId: event.pointerId,
            };
          } else if (state.tool === 'lasso') {
            if (state.variant.lasso === 'polygon') {
              if (!draft || draft.kind !== 'polygon')
                draft = { kind: 'polygon', points: [point], mode: modifiers(event) };
              else {
                const first = draft.points[0];
                const firstClient = editor.view.projectToClient(first.x, first.y);
                if (
                  draft.points.length >= 3 &&
                  (Math.hypot(firstClient.x - event.clientX, firstClient.y - event.clientY) < 9 ||
                    event.detail >= 2)
                )
                  finishPolygon();
                else draft.points.push(point);
              }
            } else
              draft = {
                kind: 'lasso',
                points: [point],
                mode: modifiers(event),
                pointerId: event.pointerId,
              };
          } else if (state.tool === 'wand') {
            return magicWand(point, modifiers(event));
          } else if (PAINT_TOOLS.has(state.tool)) {
            if (event.altKey && state.tool === 'clone') {
              state.clone.source = point;
              state.clone.offset = null;
              status('Clone source set. Paint to copy from it.');
              scheduleOverlay();
              return null;
            }
            if (event.altKey && state.tool === 'brush') {
              const color = sampleColor(point);
              if (color) setColor('fg', color);
              return null;
            }
            beginStroke(event, point);
          } else if (state.tool === 'fill') {
            if (state.variant.fill === 'gradient')
              draft = { kind: 'gradient', from: point, to: point, pointerId: event.pointerId };
            else return editor.runOperation('Filling…', () => bucketFill(point));
          } else if (state.tool === 'eyedropper') {
            const color = sampleColor(point);
            if (!color) throw new Error('No visible pixel there to sample.');
            setColor(event.altKey ? 'bg' : 'fg', color);
            status(`Sampled ${color}.`);
          } else if (state.tool === 'heal') {
            if (state.variant.heal === 'redeye') return redEyeAt(point);
            if (state.variant.heal === 'healing' && event.altKey) {
              state.heal.source = point;
              state.heal.offset = null;
              status('Healing source set. Paint over the area to repair.');
              scheduleOverlay();
              return null;
            }
            pixelTarget({ mask: false });
            draft = {
              kind: 'heal',
              mode: state.variant.heal,
              points: [point],
              pointerId: event.pointerId,
            };
          } else if (state.tool === 'crop') {
            if (!state.crop.box) startCropTool();
            if (event.ctrlKey || event.metaKey) {
              draft = { kind: 'straighten', from: point, to: point, pointerId: event.pointerId };
              return null;
            }
            draft = {
              kind: 'crop',
              hit: cropHit({ x: event.clientX, y: event.clientY }),
              point,
              box: { ...state.crop.box },
              pointerId: event.pointerId,
            };
          } else if (state.tool === 'shape') {
            draft = {
              kind: 'shape',
              shape: state.variant.shape === 'ellipse-shape' ? 'ellipse' : 'rectangle',
              start: point,
              rect: { x: point.x, y: point.y, width: 0, height: 0 },
              pointerId: event.pointerId,
            };
          } else if (state.tool === 'pen') {
            if (draft?.kind === 'pen' && draft.points.length >= 2) {
              const first = draft.points[0],
                fc = editor.view.projectToClient(first.x, first.y);
              if (Math.hypot(fc.x - event.clientX, fc.y - event.clientY) < 10) {
                finishPen(true);
                return null;
              }
            }
            if (!draft || draft.kind !== 'pen') draft = { kind: 'pen', points: [] };
            const anchor = snapPoint(point);
            draft.points.push({
              x: anchor.x,
              y: anchor.y,
              ix: anchor.x,
              iy: anchor.y,
              ox: anchor.x,
              oy: anchor.y,
            });
            draft.dragging = event.pointerId;
          } else if (state.tool === 'type') {
            const hit = hitTextLayer(point);
            if (hit) {
              store().replaceTransient({ ...project(), selectedLayerId: hit.id }, 'Selected layer');
              openTextEditor(hit);
            } else addTextAt(point);
          }
          return null;
        });
        scheduleOverlay();
      },
      true,
    );

    viewport.addEventListener(
      'pointermove',
      (event) => {
        updateCursor(event);
        const point = editor.view.clientToProject(event.clientX, event.clientY);
        if (guideDraft && event.pointerId === guideDraft.pointerId) {
          const snapped = state.snap ? snapPoint(point) : point;
          snapLines = [];
          guideDraft.value = guideDraft.axis === 'x' ? snapped.x : snapped.y;
          scheduleOverlay();
          return;
        }
        if (pixelMove && event.pointerId === pixelMove.pointerId) {
          let dx = point.x - pixelMove.start.x,
            dy = point.y - pixelMove.start.y;
          if (event.shiftKey) {
            if (Math.abs(dx) > Math.abs(dy)) dy = 0;
            else dx = 0;
          }
          updatePixelMove(Math.round(dx), Math.round(dy));
          return;
        }
        if (pan) {
          editor.view.panBy(event.clientX - pan.x, event.clientY - pan.y);
          pan.x = event.clientX;
          pan.y = event.clientY;
          return;
        }
        if (state.transform?.drag) {
          transformDrag(event);
          return;
        }
        if (stroke && event.pointerId === stroke.pointerId) {
          const events = event.getCoalescedEvents ? event.getCoalescedEvents() : [event];
          for (const item of events.length ? events : [event]) {
            const p = editor.view.clientToProject(item.clientX, item.clientY);
            strokeTo(
              projectToLayer(stroke.target.layer, p),
              item.pointerType === 'pen' ? item.pressure : 1,
            );
          }
          refreshStroke();
          return;
        }
        if (!draft) {
          if (state.tool === 'lasso' && state.variant.lasso === 'polygon') {
            hoverPoint = null;
          }
          return;
        }
        if (draft.kind === 'pen') {
          if (draft.dragging === event.pointerId) {
            const a = draft.points[draft.points.length - 1];
            a.ox = point.x;
            a.oy = point.y;
            // Alt breaks the handle pair (a corner); otherwise the in-handle mirrors the out-handle.
            if (!event.altKey) {
              a.ix = 2 * a.x - point.x;
              a.iy = 2 * a.y - point.y;
            }
          } else hoverPoint = point;
          scheduleOverlay();
          return;
        }
        if (draft.kind === 'shape') {
          const snapped = snapPoint(point);
          let w = snapped.x - draft.start.x,
            h = snapped.y - draft.start.y;
          if (event.shiftKey) {
            const side = Math.max(Math.abs(w), Math.abs(h));
            w = Math.sign(w || 1) * side;
            h = Math.sign(h || 1) * side;
          }
          draft.rect = {
            x: Math.min(draft.start.x, draft.start.x + w),
            y: Math.min(draft.start.y, draft.start.y + h),
            width: Math.abs(w),
            height: Math.abs(h),
          };
          scheduleOverlay();
          return;
        }
        if (draft.kind === 'marquee') {
          const snapped = snapPoint(point);
          let w = snapped.x - draft.start.x,
            h = snapped.y - draft.start.y;
          if (event.shiftKey && draft.mode === state.selection.mode) {
            const s = Math.max(Math.abs(w), Math.abs(h));
            w = Math.sign(w || 1) * s;
            h = Math.sign(h || 1) * s;
          }
          let x = draft.start.x,
            y = draft.start.y;
          if (event.altKey && draft.mode === state.selection.mode) {
            x -= w;
            y -= h;
            w *= 2;
            h *= 2;
          }
          draft.rect = {
            x: Math.min(x, x + w),
            y: Math.min(y, y + h),
            width: Math.abs(w),
            height: Math.abs(h),
          };
        } else if (draft.kind === 'lasso') {
          const last = draft.points[draft.points.length - 1];
          const lastClient = editor.view.projectToClient(last.x, last.y);
          if (Math.hypot(lastClient.x - event.clientX, lastClient.y - event.clientY) >= 2)
            draft.points.push(point);
        } else if (draft.kind === 'polygon') {
          hoverPoint = point;
        } else if (draft.kind === 'heal') {
          const last = draft.points[draft.points.length - 1];
          if (Math.hypot(point.x - last.x, point.y - last.y) >= state.heal.size / 3)
            draft.points.push(point);
        } else if (draft.kind === 'gradient' || draft.kind === 'straighten') {
          draft.to = point;
        } else if (draft.kind === 'crop') {
          cropDrag(event);
        }
        scheduleOverlay();
      },
      true,
    );

    function pointerEnd(event) {
      snapLines = [];
      if (guideDraft && event.pointerId === guideDraft.pointerId) {
        // Dropping a guide outside the document removes it.
        const p = project();
        const size = guideDraft.axis === 'x' ? p.width : p.height;
        if (guideDraft.value >= 0 && guideDraft.value <= size)
          overlayGuides.push({ axis: guideDraft.axis, value: Math.round(guideDraft.value) });
        guideDraft = null;
        scheduleOverlay();
        return;
      }
      // Transform controls hide while the base editor moves a layer; show them again after it commits.
      if (state.tool === 'move' && !state.transform) setTimeout(syncAutoTransform);
      if (pan) {
        pan = null;
        delete viewport.dataset.panning;
        return;
      }
      if (pixelMove && event.pointerId === pixelMove.pointerId) {
        guard(() => finishPixelMove(true));
        return;
      }
      if (state.transform?.drag) {
        state.transform.drag = null;
        if (state.transform.auto) commitTransform(true);
        return;
      }
      if (stroke && event.pointerId === stroke.pointerId) {
        guard(() => endStroke(true));
        return;
      }
      if (draft?.kind === 'pen') {
        if (draft.dragging === event.pointerId) draft.dragging = null;
        scheduleOverlay();
        return;
      }
      if (!draft || draft.kind === 'polygon') return;
      const current = draft;
      draft = null;
      guard(() => {
        const p = project();
        if (current.kind === 'shape') {
          const r = current.rect;
          const tiny = Math.max(r.width, r.height) * editor.view.zoom < 4;
          const width = tiny ? 240 : r.width,
            height = tiny ? 160 : r.height;
          const cx = tiny ? current.start.x : r.x + r.width / 2,
            cy = tiny ? current.start.y : r.y + r.height / 2;
          let next = Core.addShapeLayer(project(), {
            shape: current.shape,
            width,
            height,
            fill: state.fg,
            stroke: state.bg,
            strokeWidth: 0,
          });
          next = Core.updateLayer(next, next.selectedLayerId, { transform: { x: cx, y: cy } });
          store().replace(next, current.shape === 'ellipse' ? 'Ellipse Tool' : 'Rectangle Tool');
          return;
        }
        if (current.kind === 'marquee') {
          const r = current.rect;
          const client = Math.max(r.width, r.height) * editor.view.zoom;
          if (client < 3) {
            if (current.mode === 'new') commitSelection(null, 'Deselect');
            return;
          }
          const mask =
            current.shape === 'ellipse'
              ? Px.ellipseMask(p.width, p.height, r, state.selection.antiAlias)
              : Px.rectangleMask(p.width, p.height, r, state.selection.antiAlias);
          combineSelection(
            mask,
            current.mode,
            current.shape === 'ellipse' ? 'Elliptical Marquee' : 'Rectangular Marquee',
          );
        } else if (current.kind === 'lasso') {
          if (current.points.length < 3) return;
          combineSelection(
            Px.rasterizePolygon(p.width, p.height, current.points, {
              antialias: state.selection.antiAlias,
            }),
            current.mode,
            'Lasso',
          );
        } else if (current.kind === 'heal') {
          if (current.points.length > 120) current.points.length = 120;
          healStroke(current.points, current.mode);
        } else if (current.kind === 'gradient') {
          if (Math.hypot(current.to.x - current.from.x, current.to.y - current.from.y) < 1) return;
          drawGradient(current.from, current.to);
        } else if (current.kind === 'straighten') {
          const angle =
            (Math.atan2(current.to.y - current.from.y, current.to.x - current.from.x) * 180) /
            Math.PI;
          const correction = Math.abs(angle) > 45 ? (angle > 0 ? 90 - angle : -90 - angle) : -angle;
          if (Math.abs(correction) > 0.05) rotateCanvas(correction, 'Straighten');
          state.crop.box = { ...project().crop };
        }
      });
      scheduleOverlay();
    }
    viewport.addEventListener('pointerup', pointerEnd, true);
    viewport.addEventListener(
      'pointercancel',
      (event) => {
        if (stroke) endStroke(false);
        if (pixelMove) finishPixelMove(false);
        pan = null;
        draft = draft?.kind === 'polygon' || draft?.kind === 'pen' ? draft : null;
        if (state.transform) {
          state.transform.drag = null;
          if (state.transform.auto) commitTransform(false);
        } else if (state.tool === 'move') setTimeout(syncAutoTransform);
        void event;
        scheduleOverlay();
      },
      true,
    );
    viewport.addEventListener('pointerleave', () => {
      cursorRing.hidden = true;
    });
    viewport.addEventListener(
      'dblclick',
      (event) => {
        if (state.tool === 'lasso' && draft?.kind === 'polygon') {
          event.preventDefault();
          guard(finishPolygon);
        } else if (state.tool === 'pen' && draft?.kind === 'pen') {
          event.preventDefault();
          draft.points.pop();
          guard(() => finishPen(false));
        } else if (state.tool === 'move' || state.tool === 'type') {
          const hit = hitTextLayer(editor.view.clientToProject(event.clientX, event.clientY));
          if (hit) {
            event.preventDefault();
            openTextEditor(hit);
          }
        }
      },
      true,
    );

    function finishPolygon() {
      const current = draft;
      draft = null;
      hoverPoint = null;
      if (!current || current.points.length < 3) {
        scheduleOverlay();
        return;
      }
      const p = project();
      combineSelection(
        Px.rasterizePolygon(p.width, p.height, current.points, {
          antialias: state.selection.antiAlias,
        }),
        current.mode,
        'Polygonal Lasso',
      );
      scheduleOverlay();
    }

    async function magicWand(point, mode) {
      const p = project();
      let mask;
      if (state.wand.sample === 'all') {
        const merged = renderMerged();
        const x = Math.floor(point.x),
          y = Math.floor(point.y);
        if (x < 0 || y < 0 || x >= p.width || y >= p.height)
          throw new Error('Click inside the canvas.');
        ({ mask } = await worker.run('floodSelect', {
          image: readPixels(merged),
          x,
          y,
          options: {
            tolerance: state.wand.tolerance,
            contiguous: state.wand.contiguous,
            antiAlias: state.wand.antiAlias,
          },
        }));
      } else {
        const layer = selectedLayer();
        if (!layer || layer.type !== 'image')
          throw new Error('Select a pixel layer, or set Sample to All layers.');
        const picture = editor.resolveStoredSource(layer.source.id);
        if (!picture) throw new Error('Relink this image first.');
        const lp = projectToLayer(layer, point);
        const x = Math.floor(lp.x),
          y = Math.floor(lp.y);
        if (x < 0 || y < 0 || x >= layer.source.width || y >= layer.source.height)
          throw new Error('Click on the selected layer.');
        const flat = makeCanvas(layer.source.width, layer.source.height);
        ctx2d(flat).drawImage(picture, 0, 0, flat.width, flat.height);
        const result = await worker.run('floodSelect', {
          image: readPixels(flat),
          x,
          y,
          options: {
            tolerance: state.wand.tolerance,
            contiguous: state.wand.contiguous,
            antiAlias: state.wand.antiAlias,
          },
        });
        mask = layerMaskToProject(layer, result.mask, flat.width, flat.height);
      }
      combineSelection(mask, mode, 'Magic Wand');
    }

    // Wheel: Ctrl/Cmd or pinch zooms at the pointer, otherwise pans.
    viewport.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        if (event.ctrlKey || event.metaKey || event.altKey) {
          const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0025));
          editor.view.setZoom(editor.view.zoom * factor, event.clientX, event.clientY);
        } else {
          const scale = event.deltaMode === 1 ? 16 : 1;
          editor.view.panBy(
            -(event.shiftKey ? event.deltaY : event.deltaX) * scale,
            -(event.shiftKey ? 0 : event.deltaY) * scale,
          );
        }
      },
      { passive: false },
    );

    // ------------------------------------------------------------ keyboard

    const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
    editor.addKeyHandler((event) => {
      const command = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      // While a pointer gesture is building an edit, no shortcut may change the
      // document underneath it (its commit would silently overwrite the change).
      if (stroke || pixelMove || state.transform?.drag || guideDraft)
        return (
          event.key !== 'Shift' &&
          event.key !== 'Alt' &&
          event.key !== 'Control' &&
          event.key !== 'Meta'
        );
      if (state.transform && !state.transform.auto && !command && event.key.startsWith('Arrow')) {
        // Arrows nudge the transform itself (committed with Enter).
        const step = event.shiftKey ? 10 : 1;
        const t = state.transform.current;
        state.transform.current = {
          ...t,
          x: t.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
          y: t.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0),
        };
        editor.previewProject(
          Core.updateLayer(project(), state.transform.layerId, {
            transform: state.transform.current,
          }),
        );
        scheduleOverlay();
        renderOptions(true);
        return true;
      }
      if (state.transform && !state.transform.auto && command && ['z', 'y'].includes(key)) {
        commitTransform(false);
        return true;
      }
      // Space and Enter belong to a focused control (button, tab, menu, link).
      if (
        (event.key === ' ' || event.key === 'Enter') &&
        event.target?.closest?.('button, summary, a[href], [role="tab"], [role="button"]')
      )
        return false;
      if (event.key === ' ' && !event.repeat) {
        state.spaceDown = true;
        viewport.dataset.hand = 'true';
        cursorRing.hidden = true;
        return true;
      }
      if (event.key === 'Escape') {
        if (state.transform && !state.transform.auto) {
          commitTransform(false);
          return true;
        }
        if (draft) {
          draft = null;
          hoverPoint = null;
          scheduleOverlay();
          return true;
        }
        if (state.tool === 'crop' && state.crop.box) {
          state.crop.box = { ...project().crop };
          scheduleOverlay();
          return true;
        }
        return false;
      }
      if (event.key === 'Enter') {
        if (state.transform && !state.transform.auto) {
          commitTransform(true);
          return true;
        }
        if (draft?.kind === 'polygon') {
          guard(finishPolygon);
          return true;
        }
        if (draft?.kind === 'pen') {
          guard(() => finishPen(event.ctrlKey || event.metaKey));
          return true;
        }
        if (state.tool === 'crop' && state.crop.box) {
          guard(applyCrop);
          return true;
        }
        return false;
      }
      if (draft?.kind === 'pen' && event.key === 'Backspace') {
        draft.points.pop();
        if (!draft.points.length) draft = null;
        scheduleOverlay();
        return true;
      }
      if (draft?.kind === 'polygon' && event.key === 'Backspace') {
        draft.points.pop();
        if (!draft.points.length) draft = null;
        scheduleOverlay();
        return true;
      }
      if (command) {
        if (key === 'a') {
          commitSelection(Px.createMask(project().width, project().height, 255), 'Select All');
          return true;
        }
        if (key === 'd' && event.shiftKey) {
          if (lastSelectionId && selections.has(lastSelectionId))
            store().replace({ ...project(), selection: { id: lastSelectionId } }, 'Reselect');
          return true;
        }
        if (key === 'd') {
          commitSelection(null, 'Deselect');
          return true;
        }
        if (key === 'i' && event.shiftKey) {
          const s = currentSelection();
          commitSelection(s ? Px.invertMask(s.mask) : null, 'Inverse');
          return true;
        }
        if (key === 'i') {
          guard(() => addAdjustment('invert'));
          return true;
        }
        if (key === 'l') {
          guard(() => addAdjustment('levels'));
          return true;
        }
        if (key === 'm') {
          guard(() => addAdjustment('curves'));
          return true;
        }
        if (key === 'u') {
          guard(() => addAdjustment('hue-saturation'));
          return true;
        }
        if (key === 'b') {
          guard(() => addAdjustment('color-balance'));
          return true;
        }
        if (key === 'j') {
          guard(() => layerViaCopy(event.shiftKey));
          return true;
        }
        if (key === 'n' && event.shiftKey) {
          guard(newLayer);
          return true;
        }
        if (key === 'e' && event.shiftKey) {
          guard(flattenImage);
          return true;
        }
        if (key === 'e') {
          guard(mergeDown);
          return true;
        }
        if (key === 't') {
          guard(beginTransform);
          return true;
        }
        if (key === 'c') {
          guard(() => copySelection(event.shiftKey));
          return true;
        }
        if (key === 'x' && event.shiftKey) {
          guard(liquifyDialog);
          return true;
        }
        if (key === 'x') {
          guard(() => copySelection(false, true));
          return true;
        }
        if (key === 'v') {
          if (!clipboard) return false;
          guard(() => pasteInternal(event.shiftKey));
          return true;
        }
        if (key === '0') {
          fitAnimated();
          return true;
        }
        if (key === '1') {
          zoomTo(1);
          return true;
        }
        if (key === '=' || key === '+') {
          zoomTo(editor.view.zoom * 1.25);
          return true;
        }
        if (key === '-') {
          zoomTo(editor.view.zoom / 1.25);
          return true;
        }
        if (key === ']') {
          guard(() =>
            store().replace(
              Core.moveLayer(project(), project().selectedLayerId, 'up'),
              'Bring forward',
            ),
          );
          return true;
        }
        if (key === '[') {
          guard(() =>
            store().replace(
              Core.moveLayer(project(), project().selectedLayerId, 'down'),
              'Send backward',
            ),
          );
          return true;
        }
        if (event.key === 'Backspace') {
          guard(() => fillOrClear('fill', state.bg));
          return true;
        }
        if (key === 'g' && event.altKey) {
          guard(toggleClip);
          return true;
        }
        if (key === 'g' && event.shiftKey) {
          guard(ungroupSelected);
          return true;
        }
        if (key === 'g') {
          guard(groupSelected);
          return true;
        }
        if (event.key === ';' && event.shiftKey) {
          state.snap = !state.snap;
          status(state.snap ? 'Snapping is on.' : 'Snapping is off.');
          return true;
        }
        if (event.key === ';') {
          state.showGuides = !state.showGuides;
          scheduleOverlay();
          return true;
        }
        return false;
      }
      const canvasFocus =
        !document.activeElement ||
        document.activeElement === document.body ||
        viewport.contains(document.activeElement);
      if (state.tool === 'move' && !command && canvasFocus && event.key.startsWith('Arrow')) {
        const step = event.shiftKey ? 10 : 1;
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        return guard(() => nudge(dx, dy)) === true;
      }
      if (event.shiftKey && event.key === 'Backspace' && currentSelection()) {
        guard(contentAwareFill);
        return true;
      }
      if (event.altKey && event.key === 'Backspace') {
        guard(() => fillOrClear('fill', state.fg));
        return true;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && currentSelection()) {
        guard(() => fillOrClear('clear'));
        return true;
      }
      if (event.key === 'F6' && event.shiftKey) {
        guard(() => modifySelection('feather'));
        return true;
      }
      if (event.altKey || event.metaKey) return false;
      if (event.key === '?') {
        shortcutsDialog();
        return true;
      }
      if (key === 'x') {
        swapColors();
        return true;
      }
      if (key === 'd') {
        setColor('fg', '#000000', false);
        setColor('bg', '#ffffff');
        return true;
      }
      if (key === '[' || key === ']') {
        const settings = toolSettings();
        if (!settings) return false;
        if (event.shiftKey)
          settings.hardness = Math.max(
            0,
            Math.min(1, Math.round((settings.hardness + (key === ']' ? 0.25 : -0.25)) * 100) / 100),
          );
        else {
          const step =
            settings.size < 10 ? 1 : settings.size < 50 ? 5 : settings.size < 200 ? 10 : 50;
          settings.size = Math.max(1, Math.min(2500, settings.size + (key === ']' ? step : -step)));
        }
        renderOptions();
        savePrefs();
        return true;
      }
      if (/^[0-9]$/.test(key) && toolSettings() && 'opacity' in toolSettings()) {
        toolSettings().opacity = key === '0' ? 1 : Number(key) / 10;
        renderOptions();
        savePrefs();
        status(`Opacity ${Math.round(toolSettings().opacity * 100)}%`);
        return true;
      }
      const tool = TOOLS.find((item) => item.key === key);
      if (tool) {
        if (event.shiftKey && tool.variants) {
          const variants = tool.variants;
          state.variant[tool.id] =
            variants[(variants.indexOf(state.variant[tool.id]) + 1) % variants.length];
        }
        setTool(tool.id);
        return true;
      }
      if (key === 'q') {
        state.targetMask = !state.targetMask;
        renderLayersEnhancement();
        status(state.targetMask ? 'Editing the layer mask.' : 'Editing layer pixels.');
        return true;
      }
      return false;
    });
    document.addEventListener('keyup', (event) => {
      if (event.key === ' ') {
        state.spaceDown = false;
        delete viewport.dataset.hand;
      }
    });
    window.addEventListener('blur', () => {
      state.spaceDown = false;
      delete viewport.dataset.hand;
    });

    // ------------------------------------------------------------ colors

    function setColor(which, value, record = true) {
      if (!/^#[0-9a-f]{6}$/i.test(value)) return;
      state[which] = value.toLowerCase();
      if (record) {
        state.recent = [
          state[which],
          ...state.recent.filter((item) => item !== state[which]),
        ].slice(0, 12);
      }
      tipCache.clear();
      renderColors();
      savePrefs();
    }
    function swapColors() {
      [state.fg, state.bg] = [state.bg, state.fg];
      renderColors();
      savePrefs();
    }

    // ------------------------------------------------------------ UI construction

    const el = (tag, className = '', text = '') => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    };
    const grid = root.querySelector('.ap-grid');
    const toolbar = el('nav', 'ap-toolbar');
    toolbar.setAttribute('aria-label', 'Tools');
    toolbar.dataset.afToolbar = '';
    for (const tool of TOOLS) {
      const button = el('button', 'ap-tool');
      button.type = 'button';
      button.dataset.tool = tool.id;
      button.setAttribute('aria-pressed', 'false');
      button.innerHTML = `${icon(tool.id)}<span class="ap-tool-label"></span><kbd class="ap-tool-key" aria-hidden="true">${tool.key.toUpperCase()}</kbd>`;
      button.querySelector('.ap-tool-label').textContent = tool.label;
      button.dataset.tip = `${tool.label}${tool.variants ? ` · Shift+${tool.key.toUpperCase()} cycles` : ''}`;
      button.setAttribute('aria-keyshortcuts', tool.key.toUpperCase());
      button.setAttribute('aria-label', tool.label);
      toolbar.append(button);
    }
    const swatches = el('div', 'ap-swatches');
    swatches.innerHTML = `<button type="button" class="ap-swatch ap-swatch-fg" data-color-target="fg" aria-label="Foreground color"></button><button type="button" class="ap-swatch ap-swatch-bg" data-color-target="bg" aria-label="Background color"></button><button type="button" class="ap-swatch-swap" data-color-swap aria-label="Swap colors (X)">${icon('swap', 12)}</button><button type="button" class="ap-swatch-reset" data-color-reset aria-label="Default colors (D)">${icon('reset', 11)}</button>`;
    toolbar.append(swatches);
    grid?.prepend(toolbar);
    toolbar.addEventListener('click', (event) => {
      const tool = event.target.closest('[data-tool]');
      if (tool) {
        const def = TOOLS.find((item) => item.id === tool.dataset.tool);
        if (def.variants && state.tool === def.id)
          state.variant[def.id] =
            def.variants[(def.variants.indexOf(state.variant[def.id]) + 1) % def.variants.length];
        setTool(def.id);
        return;
      }
      if (event.target.closest('[data-color-swap]')) swapColors();
      else if (event.target.closest('[data-color-reset]')) {
        setColor('fg', '#000000', false);
        setColor('bg', '#ffffff', false);
      } else if (event.target.closest('[data-color-target]')) {
        colorTarget = event.target.closest('[data-color-target]').dataset.colorTarget;
        showPanel('color');
        renderColors();
      }
    });
    toolbar.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      const buttons = [...toolbar.querySelectorAll('.ap-tool')];
      const index = buttons.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      buttons[
        (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      ].focus();
    });

    const optionsBar = el('div', 'ap-options-bar');
    optionsBar.setAttribute('role', 'toolbar');
    optionsBar.setAttribute('aria-label', 'Tool options');
    const canvasPanel = root.querySelector('.ap-canvas-panel');
    canvasPanel?.insertBefore(optionsBar, viewport);

    function setTool(id) {
      if (textEditor) closeTextEditor(true); // switching tools commits the text being typed
      if (state.transform) commitTransform(true);
      if (stroke) endStroke(true);
      if (draft?.kind === 'pen' && id !== 'pen') {
        if (draft.points.length >= 2) guard(() => finishPen(false));
        else draft = null;
      }
      if (draft && draft.kind !== 'polygon' && draft.kind !== 'pen') draft = null;
      if (id !== 'lasso' || state.variant.lasso !== 'polygon') {
        if (draft?.kind === 'polygon') draft = null;
      }
      if (state.tool === 'crop' && id !== 'crop') state.crop.box = null;
      state.tool = id;
      if (id === 'crop') startCropTool();
      // Legacy vector-mask tools and studio tools must not both capture the canvas.
      if (id !== 'move')
        for (const active of root.querySelectorAll(
          '.ap-mask-tools [aria-pressed="true"][data-ap-mask], .ap-mask-tools [aria-pressed="true"][data-ap-mask-brush]',
        ))
          active.click();
      viewport.dataset.tool = id;
      for (const button of toolbar.querySelectorAll('[data-tool]')) {
        const on = button.dataset.tool === id;
        button.setAttribute('aria-pressed', String(on));
        const def = TOOLS.find((item) => item.id === button.dataset.tool);
        const label = def.variants ? VARIANT_LABELS[state.variant[def.id]] : def.label;
        button.querySelector('.ap-tool-label').textContent = label;
        button.setAttribute('aria-label', label);
        button.dataset.tip = `${label}${def.variants ? ` · Shift+${def.key.toUpperCase()} cycles` : ''}`;
      }
      cursorRing.hidden = true;
      syncAutoTransform();
      renderOptions();
      scheduleOverlay();
    }

    function field(label, input) {
      const wrap = el('label', 'ap-opt');
      wrap.append(el('span', '', label), input);
      return wrap;
    }
    function rangeInput(value, min, max, step, onInput, format = (v) => v) {
      const wrap = el('span', 'ap-opt-range');
      const input = el('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(value);
      const number = el('input', 'ap-opt-number');
      number.type = 'number';
      number.min = String(min);
      number.max = String(max);
      number.step = String(step);
      number.value = String(format(value));
      input.addEventListener('input', () => {
        number.value = String(format(Number(input.value)));
        onInput(Number(input.value));
      });
      number.addEventListener('change', () => {
        const v = Math.min(max, Math.max(min, Number(number.value) || min));
        input.value = String(v);
        number.value = String(v);
        onInput(v);
      });
      wrap.append(input, number);
      return wrap;
    }
    function checkbox(checked, onChange) {
      const input = el('input');
      input.type = 'checkbox';
      input.checked = Boolean(checked);
      input.addEventListener('change', () => onChange(input.checked));
      return input;
    }
    function select(options, value, onChange) {
      const input = el('select');
      for (const [v, label] of options) {
        const option = el('option', '', label);
        option.value = v;
        input.append(option);
      }
      input.value = value;
      input.addEventListener('change', () => onChange(input.value));
      return input;
    }
    function button(label, onClick, title = '') {
      const node = el('button', '', label);
      node.type = 'button';
      if (title) node.title = title;
      node.addEventListener('click', () => guard(onClick));
      return node;
    }

    function selectionModeControls() {
      const group = el('span', 'ap-opt-group');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', 'Selection mode');
      for (const [mode, label, hint] of [
        ['new', 'New', ''],
        ['add', 'Add', 'Shift'],
        ['subtract', 'Subtract', 'Alt'],
        ['intersect', 'Intersect', 'Shift+Alt'],
      ]) {
        const node = button(
          label,
          () => {
            state.selection.mode = mode;
            renderOptions();
          },
          hint ? `Hold ${hint} while dragging` : '',
        );
        node.setAttribute('aria-pressed', String(state.selection.mode === mode));
        group.append(node);
      }
      return group;
    }

    function paintControls(settings, extras = true) {
      const nodes = [
        field(
          'Size',
          rangeInput(settings.size, 1, 2500, 1, (v) => {
            settings.size = v;
            savePrefs();
          }),
        ),
        field(
          'Hardness %',
          rangeInput(Math.round(settings.hardness * 100), 0, 100, 1, (v) => {
            settings.hardness = v / 100;
            savePrefs();
          }),
        ),
      ];
      if (extras) {
        nodes.push(
          field(
            'Opacity %',
            rangeInput(Math.round(settings.opacity * 100), 1, 100, 1, (v) => {
              settings.opacity = v / 100;
              savePrefs();
            }),
          ),
        );
        nodes.push(
          field(
            'Flow %',
            rangeInput(Math.round(settings.flow * 100), 1, 100, 1, (v) => {
              settings.flow = v / 100;
              savePrefs();
            }),
          ),
        );
        nodes.push(
          field(
            'Pen pressure',
            checkbox(settings.pressure, (v) => {
              settings.pressure = v;
              savePrefs();
            }),
          ),
        );
      }
      return nodes;
    }

    function renderOptions(valuesOnly = false) {
      if (valuesOnly && state.transform && !state.transform.auto) {
        const t = state.transform.current;
        for (const [name, value] of Object.entries({
          x: t.x,
          y: t.y,
          w: t.scaleX * 100,
          h: t.scaleY * 100,
          angle: t.rotation,
          skewX: t.skewX || 0,
          skewY: t.skewY || 0,
        })) {
          const input = optionsBar.querySelector(`[data-transform="${name}"]`);
          if (input && document.activeElement !== input)
            input.value = String(Math.round(value * 100) / 100);
        }
        return;
      }
      if (valuesOnly && state.tool === 'crop' && state.crop.box) {
        const info = optionsBar.querySelector('[data-crop-size]');
        if (info) info.textContent = `${state.crop.box.width} × ${state.crop.box.height} px`;
        return;
      }
      optionsBar.replaceChildren();
      const title = el('strong', 'ap-options-title');
      const def = TOOLS.find((item) => item.id === state.tool);
      title.textContent =
        state.transform && !state.transform.auto
          ? 'Free Transform'
          : def.variants
            ? VARIANT_LABELS[state.variant[def.id]]
            : def.label;
      optionsBar.append(title);
      const add = (...nodes) => optionsBar.append(...nodes.flat());
      if (state.transform && !state.transform.auto) {
        const t = state.transform.current;
        const numberInput = (name, value, apply) => {
          const input = el('input', 'ap-opt-number');
          input.type = 'number';
          input.step = 'any';
          input.value = String(Math.round(value * 100) / 100);
          input.dataset.transform = name;
          input.addEventListener('change', () => {
            const v = Number(input.value);
            if (!Number.isFinite(v)) return;
            state.transform.current = { ...state.transform.current, ...apply(v) };
            editor.previewProject(
              Core.updateLayer(project(), state.transform.layerId, {
                transform: state.transform.current,
              }),
            );
            scheduleOverlay();
          });
          return input;
        };
        add(
          field(
            'X',
            numberInput('x', t.x, (v) => ({ x: v })),
          ),
          field(
            'Y',
            numberInput('y', t.y, (v) => ({ y: v })),
          ),
          field(
            'W %',
            numberInput('w', t.scaleX * 100, (v) => ({ scaleX: v / 100 })),
          ),
          field(
            'H %',
            numberInput('h', t.scaleY * 100, (v) => ({ scaleY: v / 100 })),
          ),
          field(
            'Angle °',
            numberInput('angle', t.rotation, (v) => ({ rotation: v })),
          ),
          field(
            'Skew H °',
            numberInput('skewX', t.skewX || 0, (v) => ({ skewX: Math.max(-80, Math.min(80, v)) })),
          ),
          field(
            'Skew V °',
            numberInput('skewY', t.skewY || 0, (v) => ({ skewY: Math.max(-80, Math.min(80, v)) })),
          ),
          button('Apply', () => commitTransform(true), 'Enter'),
          button('Cancel', () => commitTransform(false), 'Escape'),
        );
        add(el('span', 'ap-opt-note', 'Perspective and warp are not available.'));
        return;
      }
      const tool = state.tool;
      if (tool === 'move') {
        add(
          el(
            'span',
            'ap-opt-note',
            'Tap a layer to select it. Drag inside to move, a corner to resize, an edge to stretch, just outside to rotate. Double-tap text to edit.',
          ),
        );
        add(
          field(
            'Transform controls',
            checkbox(state.autoTransform !== false, (v) => {
              state.autoTransform = v;
              syncAutoTransform();
            }),
          ),
        );
        add(button('Free Transform', beginTransform, `${MOD}T`));
      } else if (tool === 'marquee' || tool === 'lasso') {
        add(selectionModeControls());
        add(
          field(
            'Feather px',
            rangeInput(state.selection.feather, 0, 250, 1, (v) => {
              state.selection.feather = v;
            }),
          ),
        );
        add(
          field(
            'Anti-alias',
            checkbox(state.selection.antiAlias, (v) => {
              state.selection.antiAlias = v;
            }),
          ),
        );
        if (tool === 'lasso' && state.variant.lasso === 'polygon')
          add(
            el(
              'span',
              'ap-opt-note',
              'Click to add points; double-click, Enter, or click the first point to close. Backspace removes a point.',
            ),
          );
        add(selectionCommands());
      } else if (tool === 'wand') {
        add(selectionModeControls());
        add(
          field(
            'Tolerance',
            rangeInput(state.wand.tolerance, 0, 255, 1, (v) => {
              state.wand.tolerance = v;
              savePrefs();
            }),
          ),
        );
        add(
          field(
            'Contiguous',
            checkbox(state.wand.contiguous, (v) => {
              state.wand.contiguous = v;
              savePrefs();
            }),
          ),
        );
        add(
          field(
            'Anti-alias',
            checkbox(state.wand.antiAlias, (v) => {
              state.wand.antiAlias = v;
              savePrefs();
            }),
          ),
        );
        add(
          field(
            'Sample',
            select(
              [
                ['layer', 'Current layer'],
                ['all', 'All layers'],
              ],
              state.wand.sample,
              (v) => {
                state.wand.sample = v;
                savePrefs();
              },
            ),
          ),
        );
        add(
          field(
            'Feather px',
            rangeInput(state.selection.feather, 0, 250, 1, (v) => {
              state.selection.feather = v;
            }),
          ),
        );
        add(selectionCommands());
      } else if (tool === 'brush' || tool === 'eraser') {
        add(paintControls(state[tool]));
        add(maskTargetNote());
      } else if (tool === 'clone') {
        add(paintControls(state.clone));
        add(
          field(
            'Aligned',
            checkbox(state.clone.aligned, (v) => {
              state.clone.aligned = v;
              state.clone.offset = null;
              savePrefs();
            }),
          ),
        );
        add(
          el(
            'span',
            'ap-opt-note',
            state.clone.source
              ? 'Source set. Alt-click to move it.'
              : 'Alt-click (Option-click) to set the source.',
          ),
        );
      } else if (tool === 'tone') {
        add(paintControls(state.tone));
        if (state.variant.tone === 'sponge')
          add(
            field(
              'Mode',
              select(
                [
                  ['desaturate', 'Desaturate'],
                  ['saturate', 'Saturate'],
                ],
                state.tone.sponge,
                (v) => {
                  state.tone.sponge = v;
                  savePrefs();
                },
              ),
            ),
          );
        else
          add(
            field(
              'Range',
              select(
                [
                  ['shadows', 'Shadows'],
                  ['midtones', 'Midtones'],
                  ['highlights', 'Highlights'],
                ],
                state.tone.range,
                (v) => {
                  state.tone.range = v;
                  savePrefs();
                },
              ),
            ),
          );
        add(
          field(
            state.variant.tone === 'sponge' ? 'Flow %' : 'Exposure %',
            rangeInput(state.tone.exposure, 1, 100, 1, (v) => {
              state.tone.exposure = v;
              savePrefs();
            }),
          ),
        );
      } else if (tool === 'focus') {
        add(paintControls(state.focus));
        add(
          field(
            'Strength %',
            rangeInput(state.focus.strength, 1, 100, 1, (v) => {
              state.focus.strength = v;
              savePrefs();
            }),
          ),
        );
      } else if (tool === 'heal') {
        add(
          field(
            'Size',
            rangeInput(state.heal.size, 2, 500, 1, (v) => {
              state.heal.size = v;
              savePrefs();
            }),
          ),
        );
        if (state.variant.heal === 'spot')
          add(
            field(
              'Hardness %',
              rangeInput(Math.round(state.heal.hardness * 100), 0, 100, 1, (v) => {
                state.heal.hardness = v / 100;
                savePrefs();
              }),
            ),
          );
        if (state.variant.heal === 'healing')
          add(
            field(
              'Aligned',
              checkbox(state.heal.aligned, (v) => {
                state.heal.aligned = v;
                state.heal.offset = null;
              }),
            ),
          );
        add(
          el(
            'span',
            'ap-opt-note',
            state.variant.heal === 'redeye'
              ? 'Click the center of each red pupil.'
              : state.variant.heal === 'healing'
                ? state.heal.source
                  ? 'Paint over the flaw; texture comes from the source and is color-matched to the edge.'
                  : 'Alt-click (Option-click) to set the source, then paint.'
                : 'Click or brush over blemishes. Texture comes from the best-matching nearby area and is color-matched to the edge.',
          ),
        );
        if (state.variant.heal === 'spot')
          add(
            el(
              'span',
              'ap-opt-note ap-opt-hint',
              'Best for textured areas; use Clone Stamp for flat colour.',
            ),
          );
      } else if (tool === 'fill') {
        if (state.variant.fill === 'gradient') {
          add(
            field(
              'Type',
              select(
                [
                  ['linear', 'Linear'],
                  ['radial', 'Radial'],
                ],
                state.gradient.type,
                (v) => {
                  state.gradient.type = v;
                },
              ),
            ),
          );
          add(
            field(
              'Reverse',
              checkbox(state.gradient.reverse, (v) => {
                state.gradient.reverse = v;
              }),
            ),
          );
          add(
            field(
              'Opacity %',
              rangeInput(Math.round(state.gradient.opacity * 100), 1, 100, 1, (v) => {
                state.gradient.opacity = v / 100;
              }),
            ),
          );
          add(
            el(
              'span',
              'ap-opt-note',
              'Drag to draw a foreground-to-background gradient (inside the selection, if any).',
            ),
          );
        } else {
          add(
            field(
              'Tolerance',
              rangeInput(state.bucket.tolerance, 0, 255, 1, (v) => {
                state.bucket.tolerance = v;
                savePrefs();
              }),
            ),
          );
          add(
            field(
              'Contiguous',
              checkbox(state.bucket.contiguous, (v) => {
                state.bucket.contiguous = v;
                savePrefs();
              }),
            ),
          );
          add(
            field(
              'Anti-alias',
              checkbox(state.bucket.antiAlias, (v) => {
                state.bucket.antiAlias = v;
                savePrefs();
              }),
            ),
          );
          add(
            field(
              'Opacity %',
              rangeInput(Math.round(state.bucket.opacity * 100), 1, 100, 1, (v) => {
                state.bucket.opacity = v / 100;
                savePrefs();
              }),
            ),
          );
        }
      } else if (tool === 'eyedropper') {
        add(
          field(
            'Sample',
            select(
              [
                ['all', 'All layers'],
                ['layer', 'Current layer'],
              ],
              state.eyedropper.sample,
              (v) => {
                state.eyedropper.sample = v;
                savePrefs();
              },
            ),
          ),
        );
        add(
          field(
            'Size',
            select(
              [
                ['1', 'Point'],
                ['3', '3 × 3 average'],
                ['5', '5 × 5 average'],
              ],
              String(state.eyedropper.size),
              (v) => {
                state.eyedropper.size = Number(v);
                savePrefs();
              },
            ),
          ),
        );
        add(el('span', 'ap-opt-note', 'Click sets the foreground; Alt-click sets the background.'));
      } else if (tool === 'crop') {
        add(
          field(
            'Ratio',
            select(
              Object.keys(RATIOS).map((key) => [
                key,
                key === 'free' ? 'Free' : key === 'original' ? 'Original' : key,
              ]),
              state.crop.ratio,
              setCropRatio,
            ),
          ),
        );
        const info = el('span', 'ap-opt-note');
        info.dataset.cropSize = 'true';
        info.textContent = state.crop.box
          ? `${state.crop.box.width} × ${state.crop.box.height} px`
          : '';
        add(info, button('Apply', applyCrop, 'Enter'), button('Reset', resetCrop));
        add(
          button('Rotate…', () =>
            numberDialog('Rotate canvas', 'Degrees clockwise', 0, -360, 360, 0.1, (value) => {
              if (value) rotateCanvas(value);
            }),
          ),
        );
        add(el('span', 'ap-opt-note', 'Ctrl-drag a line along the horizon to straighten.'));
      } else if (tool === 'type') {
        // Show the selected text layer's settings, so the bar never claims a font the layer doesn't use.
        const layer = selectedLayer()?.type === 'text' ? selectedLayer() : null;
        const type = layer
          ? {
              ...state.type,
              ...Object.fromEntries(
                Object.entries(layer).filter(([key, value]) => key in state.type && value != null),
              ),
            }
          : state.type;
        const fonts = Core.FONT_STACKS.some(([stack]) => stack === type.fontFamily)
          ? Core.FONT_STACKS
          : [...Core.FONT_STACKS, [type.fontFamily, 'Custom']];
        add(
          field(
            'Font',
            select(fonts, type.fontFamily, (v) => {
              state.type.fontFamily = v;
              applyTypeToSelected({ fontFamily: v });
            }),
          ),
        );
        add(
          field(
            'Size px',
            rangeInput(type.fontSize, 4, 1024, 1, (v) => {
              state.type.fontSize = v;
              applyTypeToSelected({ fontSize: v }, true);
            }),
          ),
        );
        add(
          field(
            'Weight',
            select(
              ['100', '300', '400', '500', '700', '900'].map((v) => [v, v]),
              String(type.fontWeight),
              (v) => {
                state.type.fontWeight = Number(v);
                applyTypeToSelected({ fontWeight: Number(v) });
              },
            ),
          ),
        );
        add(
          field(
            'Italic',
            checkbox(type.italic, (v) => {
              state.type.italic = v;
              applyTypeToSelected({ italic: v });
            }),
          ),
        );
        add(
          field(
            'Align',
            select(
              [
                ['left', 'Left'],
                ['center', 'Center'],
                ['right', 'Right'],
              ],
              type.align,
              (v) => {
                state.type.align = v;
                applyTypeToSelected({ align: v });
              },
            ),
          ),
        );
        add(
          field(
            'Leading',
            rangeInput(type.lineHeight, 0.5, 4, 0.05, (v) => {
              state.type.lineHeight = v;
              applyTypeToSelected({ lineHeight: v }, true);
            }),
          ),
        );
        add(
          field(
            'Tracking px',
            rangeInput(type.letterSpacing, -100, 400, 1, (v) => {
              state.type.letterSpacing = v;
              applyTypeToSelected({ letterSpacing: v }, true);
            }),
          ),
        );
        add(
          el(
            'span',
            'ap-opt-note',
            'Click to add text; click a text layer to edit. Ctrl+Enter commits.',
          ),
        );
      } else if (tool === 'pen') {
        add(
          el(
            'span',
            'ap-opt-note',
            'Click to add corner points; drag to pull smooth curves (Alt breaks the handle). Click the first point to close a filled shape; Enter finishes an open path; Backspace removes the last point.',
          ),
        );
        const done = el('button', '', 'Finish path');
        done.type = 'button';
        done.addEventListener('click', () => guard(() => finishPen(false)));
        add(done);
      } else if (tool === 'shape') {
        add(
          el(
            'span',
            'ap-opt-note',
            'Drag to draw (Shift for a square or circle); click for a default size. Fill uses the foreground color; edit size, fill and stroke in the Layer panel.',
          ),
        );
      } else if (tool === 'hand') {
        add(
          button('Fit on screen', () => editor.view.fit(), `${MOD}0`),
          button('100%', () => editor.view.actualPixels(), `${MOD}1`),
        );
      } else if (tool === 'zoom') {
        add(el('span', 'ap-opt-note', 'Click to zoom in, Alt-click to zoom out.'));
        add(
          button('Fit on screen', () => editor.view.fit(), `${MOD}0`),
          button('100%', () => editor.view.actualPixels(), `${MOD}1`),
        );
      }
    }

    let typeTimer = 0;
    function applyTypeToSelected(patch, debounce = false) {
      savePrefs();
      const layer = selectedLayer();
      if (!layer || layer.type !== 'text') return;
      const run = () =>
        guard(() => store().replace(Core.updateLayer(project(), layer.id, patch), 'Change type'));
      clearTimeout(typeTimer);
      if (debounce) typeTimer = setTimeout(run, 250);
      else run();
    }

    function maskTargetNote() {
      const layer = selectedLayer();
      if (!layer?.rasterMask) return [];
      const toggle = button(
        state.targetMask ? 'Painting: mask' : 'Painting: pixels',
        () => {
          state.targetMask = !state.targetMask;
          renderOptions();
          renderLayersEnhancement();
        },
        'Q toggles',
      );
      toggle.setAttribute('aria-pressed', String(state.targetMask));
      return [
        toggle,
        el('span', 'ap-opt-note', state.targetMask ? 'White reveals, black hides.' : ''),
      ];
    }

    function selectionCommands() {
      return [
        button(
          'Select All',
          () =>
            commitSelection(Px.createMask(project().width, project().height, 255), 'Select All'),
          `${MOD}A`,
        ),
        button('Deselect', () => commitSelection(null, 'Deselect'), `${MOD}D`),
        button(
          'Inverse',
          () => {
            const s = currentSelection();
            commitSelection(s ? Px.invertMask(s.mask) : null, 'Inverse');
          },
          `Shift+${MOD}I`,
        ),
      ];
    }

    // ------------------------------------------------------------ dock: color, history, properties

    const dock = el('aside', 'ap-dock');
    dock.setAttribute('aria-label', 'Studio panels');
    dock.dataset.apPanel = 'layer';
    dock.innerHTML = `
      <div class="ap-dock-tabs" role="tablist" aria-label="Panels">
        <button type="button" role="tab" data-dock="properties" aria-selected="true">Properties</button>
        <button type="button" role="tab" data-dock="color" aria-selected="false">Color</button>
        <button type="button" role="tab" data-dock="history" aria-selected="false">History</button>
      </div>
      <section class="ap-dock-panel" data-dock-panel="properties" data-af-panel="properties" data-af-label="Properties" role="tabpanel" aria-label="Properties"></section>
      <section class="ap-dock-panel" data-dock-panel="color" data-af-panel="color" data-af-label="Color" role="tabpanel" aria-label="Color" hidden></section>
      <section class="ap-dock-panel" data-dock-panel="history" data-af-panel="history" data-af-label="History" role="tabpanel" aria-label="History" hidden><ol class="ap-history" aria-label="History states"></ol><p class="ap-dock-note" data-history-note></p></section>`;
    // Right-hand sidebar: panels first, then layers, then the detailed inspector.
    const inspector = root.querySelector('.ap-inspector');
    const layersPanel = root.querySelector('.ap-layers-panel');
    const sidebar = el('div', 'ap-sidebar');
    grid?.append(sidebar);
    sidebar.append(dock);
    if (layersPanel) sidebar.append(layersPanel);
    if (inspector) sidebar.append(inspector);
    dock.querySelector('.ap-dock-tabs').addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const tabs = [...dock.querySelectorAll('[data-dock]')];
      const index = tabs.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      const next =
        tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      next.focus();
      showPanel(next.dataset.dock);
    });
    dock.querySelector('.ap-dock-tabs').addEventListener('click', (event) => {
      const tab = event.target.closest('[data-dock]');
      if (tab) showPanel(tab.dataset.dock);
    });
    function showPanel(name) {
      for (const tab of dock.querySelectorAll('[data-dock]')) {
        tab.setAttribute('aria-selected', String(tab.dataset.dock === name));
        tab.tabIndex = tab.dataset.dock === name ? 0 : -1;
      }
      for (const panel of dock.querySelectorAll('[data-dock-panel]'))
        panel.hidden = panel.dataset.dockPanel !== name;
      if (name === 'color') renderColors();
      if (name === 'history') renderHistory();
      if (name === 'properties') renderProperties();
    }

    // Color panel: HSB field + hue strip, hex / RGB / HSB inputs, recent swatches.
    let colorTarget = 'fg';
    const colorPanel = dock.querySelector('[data-dock-panel="color"]');
    colorPanel.innerHTML = `
      <div class="ap-color-targets" role="group" aria-label="Color being edited"><button type="button" data-edit-color="fg">Foreground</button><button type="button" data-edit-color="bg">Background</button></div>
      <div class="ap-color-picker"><canvas class="ap-sb" width="220" height="150" aria-label="Saturation and brightness" tabindex="0"></canvas><canvas class="ap-hue" width="22" height="150" aria-label="Hue" tabindex="0"></canvas></div>
      <div class="ap-color-fields">
        <label>Hex<input data-color-field="hex" maxlength="7" spellcheck="false"></label>
        <label>R<input data-color-field="r" type="number" min="0" max="255"></label><label>G<input data-color-field="g" type="number" min="0" max="255"></label><label>B<input data-color-field="b" type="number" min="0" max="255"></label>
        <label>H°<input data-color-field="h" type="number" min="0" max="360"></label><label>S%<input data-color-field="s" type="number" min="0" max="100"></label><label>B%<input data-color-field="v" type="number" min="0" max="100"></label>
        <label class="ap-native-color">System picker<input type="color" data-color-field="native"></label>
      </div>
      <div class="ap-recent" aria-label="Recent colors"></div>`;
    const sb = colorPanel.querySelector('.ap-sb'),
      hueStrip = colorPanel.querySelector('.ap-hue');
    let hsb = Px.rgbToHsb(Px.parseHex(state.fg));
    function drawPicker() {
      const c = ctx2d(sb);
      const base = Px.hsbToRgb({ h: hsb.h, s: 100, b: 100 });
      const horizontal = c.createLinearGradient(0, 0, sb.width, 0);
      horizontal.addColorStop(0, '#ffffff');
      horizontal.addColorStop(1, Px.toHex(base));
      c.fillStyle = horizontal;
      c.fillRect(0, 0, sb.width, sb.height);
      const vertical = c.createLinearGradient(0, 0, 0, sb.height);
      vertical.addColorStop(0, 'rgba(0,0,0,0)');
      vertical.addColorStop(1, '#000000');
      c.fillStyle = vertical;
      c.fillRect(0, 0, sb.width, sb.height);
      const x = (hsb.s / 100) * sb.width,
        y = (1 - hsb.b / 100) * sb.height;
      c.strokeStyle = hsb.b > 50 ? '#000' : '#fff';
      c.lineWidth = 2;
      c.beginPath();
      c.arc(x, y, 5, 0, Math.PI * 2);
      c.stroke();
      const h = ctx2d(hueStrip);
      const hue = h.createLinearGradient(0, 0, 0, hueStrip.height);
      for (let k = 0; k <= 6; k += 1)
        hue.addColorStop(k / 6, Px.toHex(Px.hsbToRgb({ h: k * 60, s: 100, b: 100 })));
      h.fillStyle = hue;
      h.fillRect(0, 0, hueStrip.width, hueStrip.height);
      const hy = (hsb.h / 360) * hueStrip.height;
      h.fillStyle = '#fff';
      h.fillRect(0, hy - 1.5, hueStrip.width, 3);
    }
    function renderColors() {
      const fgSwatch = toolbar.querySelector('.ap-swatch-fg'),
        bgSwatch = toolbar.querySelector('.ap-swatch-bg');
      fgSwatch.style.background = state.fg;
      bgSwatch.style.background = state.bg;
      fgSwatch.title = `Foreground ${state.fg}`;
      bgSwatch.title = `Background ${state.bg}`;
      if (colorPanel.hidden) return;
      const value = state[colorTarget];
      const rgb = Px.parseHex(value);
      const current = Px.rgbToHsb(rgb);
      if (Px.toHex(Px.hsbToRgb(hsb)) !== value) hsb = current;
      for (const node of colorPanel.querySelectorAll('[data-edit-color]'))
        node.setAttribute('aria-pressed', String(node.dataset.editColor === colorTarget));
      const set = (name, v) => {
        const input = colorPanel.querySelector(`[data-color-field="${name}"]`);
        if (input && document.activeElement !== input) input.value = String(v);
      };
      set('hex', value);
      set('r', rgb.r);
      set('g', rgb.g);
      set('b', rgb.b);
      set('h', Math.round(hsb.h));
      set('s', Math.round(hsb.s));
      set('v', Math.round(hsb.b));
      set('native', value);
      const recent = colorPanel.querySelector('.ap-recent');
      recent.replaceChildren(
        ...state.recent.map((color) => {
          const b = el('button', 'ap-recent-swatch');
          b.type = 'button';
          b.style.background = color;
          b.title = color;
          b.setAttribute('aria-label', `Use ${color}`);
          b.dataset.recent = color;
          return b;
        }),
      );
      drawPicker();
    }
    colorPanel.addEventListener('click', (event) => {
      const which = event.target.closest('[data-edit-color]');
      if (which) {
        colorTarget = which.dataset.editColor;
        hsb = Px.rgbToHsb(Px.parseHex(state[colorTarget]));
        renderColors();
      }
      const recent = event.target.closest('[data-recent]');
      if (recent) setColor(colorTarget, recent.dataset.recent);
    });
    colorPanel.addEventListener('change', (event) => {
      const name = event.target.dataset.colorField;
      if (!name) return;
      const rgb = Px.parseHex(state[colorTarget]);
      if (name === 'hex' || name === 'native') {
        const v = event.target.value.startsWith('#')
          ? event.target.value
          : `#${event.target.value}`;
        if (/^#[0-9a-f]{6}$/i.test(v)) {
          hsb = Px.rgbToHsb(Px.parseHex(v));
          setColor(colorTarget, v);
        }
        return;
      }
      if ('rgb'.includes(name)) {
        rgb[name] = Math.max(0, Math.min(255, Number(event.target.value) || 0));
        hsb = Px.rgbToHsb(rgb);
        setColor(colorTarget, Px.toHex(rgb));
        return;
      }
      const key = name === 'v' ? 'b' : name;
      hsb = {
        ...hsb,
        [key]: Math.max(0, Math.min(key === 'h' ? 360 : 100, Number(event.target.value) || 0)),
      };
      setColor(colorTarget, Px.toHex(Px.hsbToRgb(hsb)));
    });
    function pickerDrag(target, handler) {
      let active = false;
      const apply = (event) => {
        const r = target.getBoundingClientRect();
        handler(
          Math.max(0, Math.min(1, (event.clientX - r.left) / r.width)),
          Math.max(0, Math.min(1, (event.clientY - r.top) / r.height)),
        );
      };
      target.addEventListener('pointerdown', (event) => {
        active = true;
        target.setPointerCapture(event.pointerId);
        apply(event);
      });
      target.addEventListener('pointermove', (event) => {
        if (active) apply(event);
      });
      target.addEventListener('pointerup', () => {
        active = false;
        setColor(colorTarget, state[colorTarget]);
      });
    }
    pickerDrag(sb, (x, y) => {
      hsb = { ...hsb, s: x * 100, b: (1 - y) * 100 };
      state[colorTarget] = Px.toHex(Px.hsbToRgb(hsb));
      tipCache.clear();
      renderColors();
    });
    pickerDrag(hueStrip, (x, y) => {
      hsb = { ...hsb, h: y * 360 };
      state[colorTarget] = Px.toHex(Px.hsbToRgb(hsb));
      tipCache.clear();
      renderColors();
    });
    for (const [target, axis] of [
      [sb, 'sb'],
      [hueStrip, 'h'],
    ]) {
      target.addEventListener('keydown', (event) => {
        const step = event.shiftKey ? 10 : 1;
        const dx = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0;
        const dy = event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0;
        if (!dx && !dy) return;
        event.preventDefault();
        if (axis === 'sb')
          hsb = {
            ...hsb,
            s: Math.max(0, Math.min(100, hsb.s + dx)),
            b: Math.max(0, Math.min(100, hsb.b - dy)),
          };
        else hsb = { ...hsb, h: (hsb.h + dy * 2 + 360) % 360 };
        setColor(colorTarget, Px.toHex(Px.hsbToRgb(hsb)), false);
      });
    }

    // History: labels mirror the store's undo stack.
    const history = { past: [], future: [], current: 'Open', storeRef: null };
    function trackHistory(event) {
      const s = store();
      if (!s || !Array.isArray(s.h)) return;
      const sameStore = history.storeRef === s;
      const priorLayers = sameStore ? history.layerCount : undefined;
      if (!sameStore) {
        history.storeRef = s;
        history.past = [];
        history.future = [];
        history.current = event?.label || 'Open';
      }
      history.layerCount = s.project.layers.length;
      const label = event?.label || 'Change';
      // Opening a picture on the empty start screen (a sample, a file, a drop or a
      // paste) is the document's floor: undo and the History panel stop there.
      if (sameStore && priorLayers === 0 && history.layerCount > 0 && /^Imported /.test(label)) {
        s.h.length = 0;
        s.f.length = 0;
        history.past = [];
        history.future = [];
        history.current = 'Open';
        history.lastTop = undefined;
        s.e?.emit?.('history', s.state());
        renderHistory();
        return;
      }
      const top = s.h[s.h.length - 1];
      const pushedAtLimit =
        label !== 'Undo' && label !== 'Redo' && top !== history.lastTop && s.f.length === 0;
      history.lastTop = top;
      if (pushedAtLimit && s.h.length === history.past.length) {
        history.past.push(history.current);
        history.past.shift();
        history.current = label;
        history.future = [];
        renderHistory();
        return;
      }
      if (s.h.length === history.past.length && s.f.length === history.future.length) {
        // No stack movement: transient selection change or history trim.
        renderHistory();
        return;
      }
      if (label === 'Undo' && history.past.length) {
        history.future.push(history.current);
        history.current = history.past.pop();
      } else if (label === 'Redo' && history.future.length) {
        history.past.push(history.current);
        history.current = history.future.pop();
      } else {
        history.past.push(history.current);
        history.current = label;
        history.future = [];
      }
      while (history.past.length > s.h.length) history.past.shift();
      while (history.past.length < s.h.length) history.past.unshift('Earlier step');
      while (history.future.length > s.f.length) history.future.shift();
      renderHistory();
    }
    const historyList = dock.querySelector('.ap-history');
    function renderHistory() {
      if (dock.querySelector('[data-dock-panel="history"]').hidden) return;
      const rows = [...history.past, history.current, ...[...history.future].reverse()];
      const currentIndex = history.past.length;
      historyList.replaceChildren(
        ...rows.map((label, index) => {
          const item = el('li');
          const b = el('button', '', label);
          b.type = 'button';
          b.dataset.historyIndex = String(index);
          if (index === currentIndex) b.setAttribute('aria-current', 'step');
          if (index > currentIndex) b.classList.add('ap-history-future');
          item.append(b);
          return item;
        }),
      );
      const s = rasters.stats();
      dock.querySelector('[data-history-note]').textContent =
        `${rows.length} states · pixel history ${Math.round(s.tileBytes / 1048576)} of ${Math.round(s.budgetBytes / 1048576)} MB`;
    }
    historyList.addEventListener('click', (event) => {
      const b = event.target.closest('[data-history-index]');
      if (!b) return;
      const target = Number(b.dataset.historyIndex);
      let steps = target - history.past.length;
      while (steps < 0 && store().undo()) steps += 1;
      while (steps > 0 && store().redo()) steps -= 1;
    });

    // Properties: adjustment controls, mask controls, layer lock/clip.
    const propertiesPanel = dock.querySelector('[data-dock-panel="properties"]');
    let adjustmentDraft = null;
    function renderProperties() {
      if (propertiesPanel.hidden) return;
      const layer = selectedLayer();
      propertiesPanel.replaceChildren();
      const group = state.selectedGroup
        ? (project().groups || []).find((item) => item.id === state.selectedGroup)
        : null;
      if (group) {
        propertiesPanel.append(el('h3', 'ap-prop-heading', `Group: ${group.name}`));
        const name = el('input');
        name.value = group.name;
        name.maxLength = 80;
        name.setAttribute('aria-label', 'Group name');
        name.addEventListener('change', () =>
          guard(() =>
            store().replace(
              Core.updateGroup(project(), group.id, { name: name.value }),
              'Rename group',
            ),
          ),
        );
        const blend = select(
          [
            ['pass-through', 'Pass through'],
            ...Core.BLEND_MODES.map((mode) => [
              mode,
              mode.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()),
            ]),
          ],
          group.blendMode,
          (v) =>
            guard(() =>
              store().replace(
                Core.updateGroup(project(), group.id, { blendMode: v }),
                'Group blend mode',
              ),
            ),
        );
        const opacity = rangeInput(Math.round(group.opacity * 100), 0, 100, 1, () => {});
        opacity.addEventListener('change', () =>
          guard(() =>
            store().replace(
              Core.updateGroup(project(), group.id, {
                opacity: Number(opacity.querySelector('input').value) / 100,
              }),
              'Group opacity',
            ),
          ),
        );
        const row = el('div', 'ap-prop-row');
        row.append(field('Name', name), field('Blend', blend), field('Opacity %', opacity));
        propertiesPanel.append(
          row,
          el(
            'p',
            'ap-dock-note',
            'Pass through blends each layer into the image below; any other mode (or opacity under 100 %) composites the group first.',
          ),
          button(
            'Ungroup',
            () => {
              store().replace(Core.removeGroup(project(), group.id), 'Ungroup layers');
              state.selectedGroup = null;
            },
            `Shift+${MOD}G`,
          ),
          button('Delete group and contents', () => {
            store().replace(
              Core.removeGroup(project(), group.id, { deleteLayers: true }),
              'Delete group',
            );
            state.selectedGroup = null;
          }),
        );
        return;
      }
      if (!layer) {
        propertiesPanel.append(el('p', 'ap-dock-note', 'Select a layer to see its properties.'));
        return;
      }
      const heading = el(
        'h3',
        'ap-prop-heading',
        layer.type === 'adjustment' ? ADJUSTMENT_LABELS[layer.kind] : layer.name,
      );
      propertiesPanel.append(heading);
      const flags = el('div', 'ap-prop-row');
      flags.append(
        field(
          'Lock',
          checkbox(layer.locked, (v) =>
            store().replace(
              Core.updateLayer(project(), layer.id, { locked: v }),
              v ? 'Lock layer' : 'Unlock layer',
            ),
          ),
        ),
        field(
          'Clip to layer below',
          checkbox(layer.clip, (v) =>
            store().replace(
              Core.updateLayer(project(), layer.id, { clip: v }),
              v ? 'Create clipping mask' : 'Release clipping mask',
            ),
          ),
        ),
      );
      const blend = select(
        Core.BLEND_MODES.map((mode) => [
          mode,
          mode.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()),
        ]),
        layer.blendMode,
        (v) =>
          store().replace(Core.updateLayer(project(), layer.id, { blendMode: v }), 'Blend mode'),
      );
      flags.append(field('Blend', blend));
      propertiesPanel.append(flags);
      if (layer.type === 'adjustment') propertiesPanel.append(adjustmentEditor(layer));
      if (layer.type === 'image' || layer.type === 'adjustment') {
        const maskRow = el('div', 'ap-prop-row ap-mask-row');
        if (layer.rasterMask) {
          maskRow.append(
            field(
              'Mask enabled',
              checkbox(layer.rasterMask.enabled, (v) =>
                store().replace(
                  Core.setRasterMask(project(), layer.id, undefined, { enabled: v }),
                  v ? 'Enable layer mask' : 'Disable layer mask',
                ),
              ),
            ),
            field(
              'Paint on mask',
              checkbox(state.targetMask, (v) => {
                state.targetMask = v;
                renderLayersEnhancement();
                renderOptions();
              }),
            ),
            button('Invert mask', invertMask),
            ...(layer.type === 'image' ? [button('Apply mask', applyMask)] : []),
            button('Delete mask', () => {
              store().replace(Core.setRasterMask(project(), layer.id, null), 'Delete layer mask');
              state.targetMask = false;
            }),
          );
        } else {
          maskRow.append(
            button(
              'Add mask',
              () => ensureMask(layer.id, currentSelection() ? 'selection' : 'reveal'),
              'Reveals the selection when one is active',
            ),
            button('Add hiding mask', () => ensureMask(layer.id, 'hide')),
          );
        }
        propertiesPanel.append(maskRow);
      }
      if (layer.type === 'text' || layer.type === 'shape')
        propertiesPanel.append(button('Rasterize layer', rasterizeLayer));
    }

    const selectiveRange = {};
    function adjustmentEditor(layer) {
      const wrap = el('div', 'ap-adjust');
      const params = {
        ...Px.ADJUSTMENT_DEFAULTS[layer.kind],
        ...(adjustmentDraft?.layerId === layer.id ? adjustmentDraft.params : layer.params),
      };
      const commit = (label) => {
        const current = adjustmentDraft;
        adjustmentDraft = null;
        if (!current) return;
        store().replace(
          Core.updateLayer(project(), layer.id, { params: current.params }),
          label || `Edit ${ADJUSTMENT_LABELS[layer.kind]}`,
        );
      };
      const update = (patch, live = true) => {
        adjustmentDraft = {
          layerId: layer.id,
          params: {
            ...params,
            ...(adjustmentDraft?.layerId === layer.id ? adjustmentDraft.params : {}),
            ...patch,
          },
        };
        Object.assign(params, patch);
        if (live)
          editor.previewProject(
            Core.updateLayer(project(), layer.id, { params: adjustmentDraft.params }),
          );
      };
      const slider = (label, key, min, max, step = 1) => {
        const node = field(
          label,
          rangeInput(params[key], min, max, step, (v) => update({ [key]: v })),
        );
        node.addEventListener('change', () => commit());
        node.addEventListener('pointerup', () => commit());
        return node;
      };
      const toggle = (label, key) =>
        field(
          label,
          checkbox(params[key], (v) => {
            update({ [key]: v });
            commit();
          }),
        );
      const color = (label, key) => {
        const input = el('input');
        input.type = 'color';
        input.value = params[key];
        input.addEventListener('input', () => update({ [key]: input.value }));
        input.addEventListener('change', () => commit());
        return field(label, input);
      };
      const k = layer.kind;
      if (k === 'levels') {
        wrap.append(
          histogramCanvas(layer),
          slider('Input black', 'inBlack', 0, 253),
          slider('Gamma', 'gamma', 0.1, 9.99, 0.01),
          slider('Input white', 'inWhite', 2, 255),
          slider('Output black', 'outBlack', 0, 255),
          slider('Output white', 'outWhite', 0, 255),
        );
        wrap.append(
          button('Auto', () => {
            const levels = autoLevels(layer);
            update(levels);
            commit('Auto Levels');
          }),
        );
      } else if (k === 'curves') {
        wrap.append(curvesEditor(layer, params, update, commit));
      } else if (k === 'hue-saturation') {
        wrap.append(
          slider('Hue', 'hue', -180, 180),
          slider('Saturation', 'saturation', -100, 100),
          slider('Lightness', 'lightness', -100, 100),
          toggle('Colorize', 'colorize'),
        );
      } else if (k === 'vibrance') {
        wrap.append(
          slider('Vibrance', 'vibrance', -100, 100),
          slider('Saturation', 'saturation', -100, 100),
        );
      } else if (k === 'color-balance') {
        for (const range of ['shadows', 'midtones', 'highlights']) {
          const values = Array.isArray(params[range]) ? params[range] : [0, 0, 0];
          wrap.append(el('h4', 'ap-prop-sub', range[0].toUpperCase() + range.slice(1)));
          ['Cyan – Red', 'Magenta – Green', 'Yellow – Blue'].forEach((label, index) => {
            const node = field(
              label,
              rangeInput(values[index], -100, 100, 1, (v) => {
                const next = [...(Array.isArray(params[range]) ? params[range] : [0, 0, 0])];
                next[index] = v;
                update({ [range]: next });
              }),
            );
            node.addEventListener('change', () => commit());
            node.addEventListener('pointerup', () => commit());
            wrap.append(node);
          });
        }
        wrap.append(toggle('Preserve luminosity', 'preserveLuminosity'));
      } else if (k === 'brightness-contrast') {
        wrap.append(
          slider('Brightness', 'brightness', -150, 150),
          slider('Contrast', 'contrast', -50, 100),
        );
      } else if (k === 'exposure') {
        wrap.append(
          slider('Exposure', 'exposure', -5, 5, 0.01),
          slider('Offset', 'offset', -0.5, 0.5, 0.001),
          slider('Gamma', 'gamma', 0.1, 4, 0.01),
        );
      } else if (k === 'black-white') {
        for (const [key, label] of [
          ['reds', 'Reds'],
          ['yellows', 'Yellows'],
          ['greens', 'Greens'],
          ['cyans', 'Cyans'],
          ['blues', 'Blues'],
          ['magentas', 'Magentas'],
        ])
          wrap.append(slider(label, key, -200, 300));
        wrap.append(
          toggle('Tint', 'tint'),
          slider('Tint hue', 'tintHue', 0, 360),
          slider('Tint saturation', 'tintSaturation', 0, 100),
        );
      } else if (k === 'threshold') {
        wrap.append(histogramCanvas(layer), slider('Level', 'level', 1, 255));
      } else if (k === 'gradient-map') {
        const stops =
          Array.isArray(params.stops) && params.stops.length >= 2
            ? params.stops
            : Px.ADJUSTMENT_DEFAULTS['gradient-map'].stops;
        const first = el('input');
        first.type = 'color';
        first.value = stops[0].color;
        const last = el('input');
        last.type = 'color';
        last.value = stops[stops.length - 1].color;
        const sync = () =>
          update({
            stops: [
              { position: 0, color: first.value },
              { position: 1, color: last.value },
            ],
          });
        first.addEventListener('input', sync);
        last.addEventListener('input', sync);
        first.addEventListener('change', () => commit());
        last.addEventListener('change', () => commit());
        wrap.append(
          field('Shadows', first),
          field('Highlights', last),
          toggle('Reverse', 'reverse'),
        );
      } else if (k === 'photo-filter') {
        wrap.append(
          color('Filter color', 'color'),
          slider('Density', 'density', 0, 100),
          toggle('Preserve luminosity', 'preserveLuminosity'),
        );
      } else if (k === 'posterize') {
        wrap.append(slider('Levels', 'levels', 2, 255));
      } else if (k === 'channel-mixer') {
        wrap.append(toggle('Monochrome', 'monochrome'));
        const rows = params.monochrome
          ? [['gray', 'Gray']]
          : [
              ['red', 'Red output'],
              ['green', 'Green output'],
              ['blue', 'Blue output'],
            ];
        for (const [key, label] of rows) {
          const values = Array.isArray(params[key])
            ? params[key]
            : Px.ADJUSTMENT_DEFAULTS['channel-mixer'][key];
          wrap.append(el('h4', 'ap-prop-sub', label));
          ['Red', 'Green', 'Blue', 'Constant'].forEach((name, index) => {
            const node = field(
              `${name} %`,
              rangeInput(values[index], -200, 200, 1, (v) => {
                const next = [...(Array.isArray(params[key]) ? params[key] : values)];
                next[index] = v;
                update({ [key]: next });
              }),
            );
            node.addEventListener('change', () => commit());
            node.addEventListener('pointerup', () => commit());
            wrap.append(node);
          });
        }
      } else if (k === 'selective-color') {
        const ranges = [
          ['reds', 'Reds'],
          ['yellows', 'Yellows'],
          ['greens', 'Greens'],
          ['cyans', 'Cyans'],
          ['blues', 'Blues'],
          ['magentas', 'Magentas'],
          ['whites', 'Whites'],
          ['neutrals', 'Neutrals'],
          ['blacks', 'Blacks'],
        ];
        let rangeKey =
          adjustmentDraft?.layerId === layer.id && adjustmentDraft.range
            ? adjustmentDraft.range
            : selectiveRange[layer.id] || 'reds';
        const sliders = el('div');
        const renderRange = () => {
          sliders.textContent = '';
          ['Cyan', 'Magenta', 'Yellow', 'Black'].forEach((name, index) => {
            const values = Array.isArray(params[rangeKey]) ? params[rangeKey] : [0, 0, 0, 0];
            const node = field(
              `${name} %`,
              rangeInput(values[index], -100, 100, 1, (v) => {
                const next = [
                  ...(Array.isArray(params[rangeKey]) ? params[rangeKey] : [0, 0, 0, 0]),
                ];
                next[index] = v;
                update({ [rangeKey]: next });
              }),
            );
            node.addEventListener('change', () => commit());
            node.addEventListener('pointerup', () => commit());
            sliders.append(node);
          });
        };
        wrap.append(
          field(
            'Colors',
            select(ranges, rangeKey, (v) => {
              rangeKey = v;
              selectiveRange[layer.id] = v;
              renderRange();
            }),
          ),
          sliders,
          toggle('Absolute', 'absolute'),
        );
        renderRange();
      } else if (k === 'develop') {
        const group = (title, rows) => {
          wrap.append(el('h4', 'ap-prop-sub', title));
          for (const [label, key, min = -100, max = 100] of rows)
            wrap.append(slider(label, key, min, max));
        };
        group('Light', [
          ['Exposure', 'exposure'],
          ['Contrast', 'contrast'],
          ['Highlights', 'highlights'],
          ['Shadows', 'shadows'],
          ['Whites', 'whites'],
          ['Blacks', 'blacks'],
        ]);
        group('Color', [
          ['Temperature', 'temperature'],
          ['Tint', 'tint'],
          ['Vibrance', 'vibrance'],
          ['Saturation', 'saturation'],
        ]);
        group('Effects', [
          ['Clarity', 'clarity'],
          ['Fade', 'fade', 0, 100],
          ['Vignette', 'vignette'],
          ['Grain', 'grain', 0, 100],
        ]);
        group('Split toning', [
          ['Shadow hue', 'splitShadowHue', 0, 360],
          ['Shadow amount', 'splitShadowAmount', 0, 100],
          ['Highlight hue', 'splitHighlightHue', 0, 360],
          ['Highlight amount', 'splitHighlightAmount', 0, 100],
        ]);
      } else if (k === 'invert') {
        wrap.append(
          el('p', 'ap-dock-note', 'Invert has no settings. Use opacity or a mask to limit it.'),
        );
      }
      const reset = button('Reset', () => {
        update(structuredClone(Px.ADJUSTMENT_DEFAULTS[k]));
        commit(`Reset ${ADJUSTMENT_LABELS[k]}`);
        renderProperties();
      });
      wrap.append(reset);
      return wrap;
    }

    // Composite of everything below an adjustment layer at preview size.
    function compositeBelow(layer, maxSide = 512) {
      const p = project();
      const index = p.layers.findIndex((item) => item.id === layer.id);
      const scale = Math.min(1, maxSide / Math.max(p.crop.width, p.crop.height));
      const out = makeCanvas(p.crop.width * scale, p.crop.height * scale);
      Core.renderProject(
        ctx2d(out, true),
        { ...p, layers: p.layers.slice(0, Math.max(0, index)) },
        editor.resolveSource,
        { view: { scale, x: -p.crop.x * scale, y: -p.crop.y * scale }, adjust: editor.adjust },
      );
      return readPixels(out);
    }
    function histogramCanvas(layer) {
      const node = el('canvas', 'ap-histogram');
      node.width = 256;
      node.height = 72;
      node.setAttribute('aria-label', 'Histogram of the layers below');
      try {
        const hist = Px.histogram(compositeBelow(layer)).l;
        const max = Math.max(1, ...hist);
        const c = ctx2d(node);
        c.fillStyle = 'rgba(255,255,255,0.75)';
        for (let i = 0; i < 256; i += 1) {
          const h = Math.sqrt(hist[i] / max) * node.height;
          c.fillRect(i, node.height - h, 1, h);
        }
      } catch {
        /* histogram is a guide only */
      }
      return node;
    }
    function autoLevels(layer) {
      const hist = Px.histogram(compositeBelow(layer)).l;
      const total = hist.reduce((a, b) => a + b, 0);
      const clip = total * 0.001;
      let low = 0,
        high = 255,
        acc = 0;
      while (low < 254 && (acc += hist[low]) <= clip) low += 1;
      acc = 0;
      while (high > low + 2 && (acc += hist[high]) <= clip) high -= 1;
      return { inBlack: low, inWhite: high, gamma: 1 };
    }

    function curvesEditor(layer, params, update, commit) {
      const wrap = el('div', 'ap-curves');
      const channelSelect = select(
        [
          ['points', 'RGB'],
          ['red', 'Red'],
          ['green', 'Green'],
          ['blue', 'Blue'],
        ],
        'points',
        () => draw(),
      );
      const node = el('canvas', 'ap-curves-canvas');
      node.width = 256;
      node.height = 256;
      node.tabIndex = 0;
      node.setAttribute(
        'aria-label',
        'Curve editor. Drag points; double-click to add; drag a point off the graph to remove it.',
      );
      let hist = null;
      try {
        hist = Px.histogram(compositeBelow(layer)).l;
      } catch {
        hist = null;
      }
      const pointsFor = (key) => {
        const value = params[key];
        return Array.isArray(value) && value.length >= 2
          ? value.map((p) => [p[0], p[1]])
          : [
              [0, 0],
              [255, 255],
            ];
      };
      function draw() {
        const c = ctx2d(node);
        c.clearRect(0, 0, 256, 256);
        c.fillStyle = 'rgba(0,0,0,0.35)';
        c.fillRect(0, 0, 256, 256);
        if (hist) {
          const max = Math.max(1, ...hist);
          c.fillStyle = 'rgba(255,255,255,0.18)';
          for (let i = 0; i < 256; i += 1) {
            const h = Math.sqrt(hist[i] / max) * 256;
            c.fillRect(i, 256 - h, 1, h);
          }
        }
        c.strokeStyle = 'rgba(255,255,255,0.2)';
        c.beginPath();
        for (let k = 1; k < 4; k += 1) {
          c.moveTo(k * 64, 0);
          c.lineTo(k * 64, 256);
          c.moveTo(0, k * 64);
          c.lineTo(256, k * 64);
        }
        c.stroke();
        const key = channelSelect.value;
        const lut = Px.curveLut(pointsFor(key));
        c.strokeStyle =
          key === 'red'
            ? '#ff5a5a'
            : key === 'green'
              ? '#5aff7a'
              : key === 'blue'
                ? '#5aa8ff'
                : '#ffffff';
        c.lineWidth = 1.5;
        c.beginPath();
        for (let i = 0; i < 256; i += 1) {
          const y = 255 - lut[i];
          if (i) c.lineTo(i, y);
          else c.moveTo(i, y);
        }
        c.stroke();
        c.fillStyle = '#ffffff';
        for (const [x, y] of pointsFor(key)) c.fillRect(x - 3, 255 - y - 3, 6, 6);
      }
      let dragIndex = -1;
      const toPoint = (event) => {
        const r = node.getBoundingClientRect();
        return [
          Math.round(((event.clientX - r.left) / r.width) * 255),
          Math.round(255 - ((event.clientY - r.top) / r.height) * 255),
        ];
      };
      node.addEventListener('pointerdown', (event) => {
        const key = channelSelect.value;
        const points = pointsFor(key);
        const [x, y] = toPoint(event);
        dragIndex = points.findIndex((p) => Math.hypot(p[0] - x, p[1] - y) < 10);
        if (dragIndex < 0 && points.length < 16) {
          points.push([x, y]);
          points.sort((a, b) => a[0] - b[0]);
          dragIndex = points.findIndex((p) => p[0] === x && p[1] === y);
          update({ [key]: points });
          draw();
        }
        node.setPointerCapture(event.pointerId);
      });
      node.addEventListener('pointermove', (event) => {
        if (dragIndex < 0) return;
        const key = channelSelect.value;
        const points = pointsFor(key);
        const [x, y] = toPoint(event);
        const outside = x < -20 || x > 275 || y < -20 || y > 275;
        if (outside && points.length > 2 && dragIndex > 0 && dragIndex < points.length - 1) {
          points.splice(dragIndex, 1);
          dragIndex = -1;
          update({ [key]: points });
          draw();
          return;
        }
        const prev = points[dragIndex - 1],
          next = points[dragIndex + 1];
        const cx = Math.max(prev ? prev[0] + 1 : 0, Math.min(next ? next[0] - 1 : 255, x));
        points[dragIndex] = [
          dragIndex === 0 ? Math.max(0, Math.min(cx, 254)) : cx,
          Math.max(0, Math.min(255, y)),
        ];
        update({ [key]: points });
        draw();
      });
      node.addEventListener('pointerup', () => {
        if (dragIndex >= -1) {
          dragIndex = -1;
          commit('Edit Curves');
        }
      });
      wrap.append(field('Channel', channelSelect), node);
      draw();
      return wrap;
    }

    // ------------------------------------------------------------ layers panel enhancements

    const layerList = editor.elements.layers;
    const layerHeader = el('div', 'ap-layer-controls');
    layerHeader.innerHTML =
      '<label class="ap-opt"><span>Blend</span><select data-layer-blend aria-label="Blend mode"></select></label><label class="ap-opt"><span>Opacity</span><input data-layer-opacity type="number" min="0" max="100" step="1" aria-label="Layer opacity percent"></label>';
    for (const mode of Core.BLEND_MODES) {
      const option = el(
        'option',
        '',
        mode.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()),
      );
      option.value = mode;
      layerHeader.querySelector('[data-layer-blend]').append(option);
    }
    layerList.before(layerHeader);
    layerHeader.addEventListener('change', (event) =>
      guard(() => {
        const layer = selectedLayer();
        if (!layer) return;
        if (event.target.matches('[data-layer-blend]'))
          store().replace(
            Core.updateLayer(project(), layer.id, { blendMode: event.target.value }),
            'Blend mode',
          );
        if (event.target.matches('[data-layer-opacity]'))
          store().replace(
            Core.updateLayer(project(), layer.id, {
              opacity: Math.max(0, Math.min(100, Number(event.target.value) || 0)) / 100,
            }),
            'Layer opacity',
          );
      }),
    );
    const layerButtons = el('div', 'ap-layer-buttons');
    const newAdjustmentSelect = select(
      [
        ['', 'New adjustment…'],
        ...Px.ADJUSTMENT_KINDS.map((kind) => [kind, ADJUSTMENT_LABELS[kind]]),
      ],
      '',
      (v) => {
        if (v) guard(() => addAdjustment(v));
        newAdjustmentSelect.value = '';
      },
    );
    newAdjustmentSelect.setAttribute('aria-label', 'New adjustment layer');
    layerButtons.append(
      button('New layer', newLayer, `Shift+${MOD}N`),
      newAdjustmentSelect,
      button('Add mask', () => {
        const layer = selectedLayer();
        if (!layer) throw new Error('Select a layer first.');
        ensureMask(layer.id, currentSelection() ? 'selection' : 'reveal');
      }),
    );
    layerList.after(layerButtons);

    const EYE_OPEN =
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12Z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/></svg>';
    const EYE_SHUT =
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M2 12s4 6 10 6 10-6 10-6M4 16l-2 2M20 16l2 2M12 18v3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
    const thumbCache = new Map();
    function layerThumbnail(layer) {
      const p = project();
      const { name, visible, opacity, blendMode, locked, clip, ...content } = layer;
      void name;
      void visible;
      void opacity;
      void blendMode;
      void locked;
      void clip;
      const key = JSON.stringify([
        p.width,
        p.height,
        content,
        stroke?.sourceId === layer.source?.id,
      ]);
      let entry = thumbCache.get(layer.id);
      if (!entry || entry.key !== key) {
        const scale = Math.min(40 / p.width, 30 / p.height);
        const node = makeCanvas(
          Math.max(1, Math.round(p.width * scale)),
          Math.max(1, Math.round(p.height * scale)),
        );
        node.className = 'ap-layer-thumb';
        node.setAttribute('aria-hidden', 'true');
        if (layer.type !== 'adjustment') {
          try {
            const single = {
              ...p,
              background: null,
              adjustments: {
                brightness: 0,
                contrast: 0,
                saturation: 0,
                hue: 0,
                blur: 0,
                grayscale: 0,
              },
              crop: { x: 0, y: 0, width: p.width, height: p.height },
              layers: [{ ...layer, visible: true, opacity: 1, blendMode: 'normal', clip: false }],
            };
            Core.renderProject(ctx2d(node), single, editor.resolveStoredSource, {
              view: { scale, x: 0, y: 0 },
            });
          } catch {
            /* thumbnails are decorative */
          }
        }
        entry = { key, node };
        thumbCache.set(layer.id, entry);
        if (thumbCache.size > 400) thumbCache.delete(thumbCache.keys().next().value);
      }
      if (!entry.node.isConnected) return entry.node;
      // Still on screen (row not rebuilt yet): hand out a copy.
      const copy = makeCanvas(entry.node.width, entry.node.height);
      copy.className = entry.node.className;
      copy.setAttribute('aria-hidden', 'true');
      ctx2d(copy).drawImage(entry.node, 0, 0);
      return copy;
    }

    // Mask chip shows the mask itself (white reveals, black hides), cached per mask source.
    const maskThumbCache = new Map();
    function maskThumbnail(source) {
      let node = maskThumbCache.get(source.id);
      if (!node) {
        let picture = null;
        try {
          picture = editor.resolveStoredSource(source.id);
        } catch {
          picture = null;
        }
        if (!picture || !picture.width) return null;
        const scale = Math.min(34 / picture.width, 26 / picture.height);
        node = makeCanvas(
          Math.max(1, Math.round(picture.width * scale)),
          Math.max(1, Math.round(picture.height * scale)),
        );
        const context = ctx2d(node);
        // Mask strength is alpha: paint it white over black.
        context.drawImage(picture, 0, 0, node.width, node.height);
        context.globalCompositeOperation = 'source-in';
        context.fillStyle = '#fff';
        context.fillRect(0, 0, node.width, node.height);
        context.globalCompositeOperation = 'destination-over';
        context.fillStyle = '#000';
        context.fillRect(0, 0, node.width, node.height);
        node.className = 'ap-mask-thumb';
        node.setAttribute('aria-hidden', 'true');
        maskThumbCache.set(source.id, node);
        if (maskThumbCache.size > 200) maskThumbCache.delete(maskThumbCache.keys().next().value);
      }
      const copy = makeCanvas(node.width, node.height);
      copy.className = node.className;
      copy.setAttribute('aria-hidden', 'true');
      ctx2d(copy).drawImage(node, 0, 0);
      return copy;
    }

    function renderGroupHeaders() {
      const p = project();
      for (const old of layerList.querySelectorAll('.ap-group-row')) old.remove();
      const groups = new Map((p.groups || []).map((group) => [group.id, group]));
      if (state.selectedGroup && !groups.has(state.selectedGroup)) state.selectedGroup = null;
      let previous = null;
      for (const wrapper of [...layerList.querySelectorAll('.ap-layer-row')]) {
        const layer = p.layers.find((item) => item.id === wrapper.dataset.dragLayer);
        const group = layer?.groupId ? groups.get(layer.groupId) : null;
        wrapper.classList.toggle('ap-layer-in-group', Boolean(group));
        wrapper.hidden = Boolean(group?.collapsed);
        if (group && group.id !== previous) {
          const header = el('div', 'ap-group-row');
          header.dataset.groupRow = group.id;
          header.dataset.dragGroup = group.id;
          header.classList.toggle('ap-group-selected', state.selectedGroup === group.id);
          header.classList.toggle('ap-layer-hidden', !group.visible);
          const eye = el('button', 'ap-layer-eye');
          eye.innerHTML = group.visible ? EYE_OPEN : EYE_SHUT;
          eye.type = 'button';
          eye.dataset.groupEye = group.id;
          eye.setAttribute(
            'aria-label',
            group.visible ? `Hide group ${group.name}` : `Show group ${group.name}`,
          );
          eye.setAttribute('aria-pressed', String(group.visible));
          const twisty = el('button', 'ap-group-twisty');
          twisty.innerHTML = icon(group.collapsed ? 'closed' : 'open', 14);
          twisty.type = 'button';
          twisty.dataset.groupToggle = group.id;
          twisty.setAttribute('aria-expanded', String(!group.collapsed));
          twisty.setAttribute(
            'aria-label',
            `${group.collapsed ? 'Expand' : 'Collapse'} group ${group.name}`,
          );
          const name = el('button', 'ap-group-name');
          name.type = 'button';
          name.dataset.groupSelect = group.id;
          name.setAttribute('aria-pressed', String(state.selectedGroup === group.id));
          name.append(
            el('strong', '', group.name),
            el(
              'small',
              '',
              `${group.blendMode === 'pass-through' ? 'Pass through' : group.blendMode} · ${Math.round(group.opacity * 100)}%`,
            ),
          );
          header.append(eye, twisty, name);
          wrapper.before(header);
        }
        previous = group ? group.id : null;
      }
    }

    function renderLayersEnhancement() {
      const p = project();
      const layer = selectedLayer();
      const blend = layerHeader.querySelector('[data-layer-blend]'),
        opacity = layerHeader.querySelector('[data-layer-opacity]');
      blend.disabled = opacity.disabled = !layer;
      if (layer) {
        blend.value = layer.blendMode;
        if (document.activeElement !== opacity)
          opacity.value = String(Math.round(layer.opacity * 100));
      }
      for (const row of layerList.querySelectorAll('.ap-layer[data-layer-id]')) {
        const item = p.layers.find((entry) => entry.id === row.dataset.layerId);
        if (!item) continue;
        let wrapper = row.parentElement;
        if (!wrapper.classList.contains('ap-layer-row')) {
          wrapper = el('div', 'ap-layer-row');
          row.before(wrapper);
          wrapper.append(row);
        }
        wrapper.draggable = true;
        wrapper.dataset.dragLayer = item.id;
        wrapper.dataset.kind = item.type;
        wrapper.classList.toggle('ap-layer-clipped', Boolean(item.clip));
        wrapper.classList.toggle('ap-layer-hidden', !item.visible);
        wrapper.classList.toggle('ap-layer-selected', item.id === p.selectedLayerId);
        for (const old of wrapper.querySelectorAll(
          ':scope > .ap-layer-eye, :scope > .ap-layer-flag, :scope > .ap-layer-thumb',
        ))
          old.remove();
        const thumb = layerThumbnail(item);
        if (thumb) wrapper.prepend(thumb);
        const eye = el('button', 'ap-layer-eye');
        eye.innerHTML = item.visible ? EYE_OPEN : EYE_SHUT;
        eye.type = 'button';
        eye.dataset.layerEye = item.id;
        eye.setAttribute('aria-label', item.visible ? `Hide ${item.name}` : `Show ${item.name}`);
        eye.setAttribute('aria-pressed', String(item.visible));
        eye.title = item.visible ? 'Hide layer' : 'Show layer';
        wrapper.prepend(eye);
        if (item.locked)
          wrapper.append(
            Object.assign(el('span', 'ap-layer-flag ap-layer-lock', 'LOCK'), { title: 'Locked' }),
          );
        if (item.clip) {
          const clip = el('span', 'ap-layer-flag ap-layer-clip');
          clip.innerHTML = icon('clip', 14);
          clip.title = 'Clipped to the layer below';
          wrapper.append(clip);
        }
        if (item.rasterMask) {
          const mask = el('button', 'ap-layer-flag ap-layer-mask');
          mask.type = 'button';
          const maskThumb = maskThumbnail(item.rasterMask.source);
          if (maskThumb) mask.append(maskThumb);
          else mask.textContent = 'MASK';
          mask.dataset.layerMask = item.id;
          mask.setAttribute(
            'aria-label',
            `Paint on the mask of ${item.name} (Shift-click toggles it)`,
          );
          mask.setAttribute(
            'aria-pressed',
            String(item.id === p.selectedLayerId && state.targetMask),
          );
          mask.title = 'Click to paint on the mask; Shift-click to disable it';
          if (!item.rasterMask.enabled) mask.classList.add('ap-mask-off');
          wrapper.append(mask);
        }
        if (item.groupId) wrapper.dataset.groupId = item.groupId;
        else delete wrapper.dataset.groupId;
        if (item.type === 'adjustment') {
          const kind = row.querySelector('b');
          if (kind) kind.textContent = 'ADJ';
          const small = row.querySelector('small');
          if (small) small.textContent = ADJUSTMENT_LABELS[item.kind];
        } else if (item.type === 'image' && rasters.isRasterId(item.source.id)) {
          const kind = row.querySelector('b');
          if (kind) kind.textContent = 'PX';
          const small = row.querySelector('small');
          if (small) small.textContent = `${item.source.width}×${item.source.height} pixels`;
        }
      }
      renderGroupHeaders();
    }

    layerList.addEventListener(
      'click',
      (event) => {
        const groupEye = event.target.closest('[data-group-eye]');
        const groupToggle = event.target.closest('[data-group-toggle]');
        const groupSelect = event.target.closest('[data-group-select]');
        if (groupEye || groupToggle || groupSelect) {
          event.stopPropagation();
          const id =
            (groupEye || groupToggle || groupSelect).dataset.groupEye ||
            (groupEye || groupToggle || groupSelect).dataset.groupToggle ||
            (groupEye || groupToggle || groupSelect).dataset.groupSelect;
          const group = (project().groups || []).find((item) => item.id === id);
          if (!group) return;
          if (groupEye)
            guard(() =>
              store().replace(
                Core.updateGroup(project(), id, { visible: !group.visible }),
                group.visible ? 'Hide group' : 'Show group',
              ),
            );
          else if (groupToggle)
            guard(() =>
              store().replaceTransient(
                Core.updateGroup(project(), id, { collapsed: !group.collapsed }),
                'Toggle group',
              ),
            );
          else {
            state.selectedGroup = id;
            renderLayersEnhancement();
            showPanel('properties');
            renderProperties();
          }
          return;
        }
        const eye = event.target.closest('[data-layer-eye]');
        if (eye) {
          event.stopPropagation();
          const item = project().layers.find((entry) => entry.id === eye.dataset.layerEye);
          if (item)
            guard(() =>
              store().replace(
                Core.updateLayer(project(), item.id, { visible: !item.visible }),
                item.visible ? 'Hide layer' : 'Show layer',
              ),
            );
          return;
        }
        const mask = event.target.closest('[data-layer-mask]');
        if (mask) {
          event.stopPropagation();
          const item = project().layers.find((entry) => entry.id === mask.dataset.layerMask);
          if (!item) return;
          if (event.shiftKey) {
            guard(() =>
              store().replace(
                Core.setRasterMask(project(), item.id, undefined, {
                  enabled: !item.rasterMask.enabled,
                }),
                'Toggle layer mask',
              ),
            );
            return;
          }
          if (project().selectedLayerId !== item.id)
            store().replaceTransient({ ...project(), selectedLayerId: item.id }, 'Selected layer');
          state.targetMask = true;
          renderLayersEnhancement();
          renderOptions();
          status(
            'Painting on the layer mask. White reveals, black hides. Click the layer name to paint pixels again.',
          );
          return;
        }
        const row = event.target.closest('[data-layer-id]');
        if (row) {
          state.targetMask = false;
          state.selectedGroup = null;
        }
      },
      true,
    );

    // Drag reorder (rows are listed top-first).
    let dragRow = null;
    layerList.addEventListener('dragstart', (event) => {
      const row = event.target.closest('[data-drag-layer]');
      if (!row) return;
      dragRow = row.dataset.dragLayer;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', dragRow);
    });
    layerList.addEventListener('dragover', (event) => {
      if (dragRow) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }
    });
    layerList.addEventListener('drop', (event) => {
      event.preventDefault();
      const header = event.target.closest('[data-drag-group]');
      const row = event.target.closest('[data-drag-layer]');
      const id = dragRow;
      dragRow = null;
      if (!id) return;
      if (header) {
        guard(() =>
          store().replace(
            Core.setLayerGroup(project(), id, header.dataset.dragGroup),
            'Move into group',
          ),
        );
        return;
      }
      if (!row || row.dataset.dragLayer === id) return;
      guard(() => {
        const p = project();
        const targetIndex = p.layers.findIndex((entry) => entry.id === row.dataset.dragLayer);
        const targetGroup = p.layers[targetIndex]?.groupId || null;
        let next = Core.moveLayerTo(p, id, targetIndex);
        const moved = next.layers.find((entry) => entry.id === id);
        if ((moved.groupId || null) !== targetGroup)
          next = Core.updateLayer(next, id, { groupId: targetGroup || undefined });
        if (!targetGroup && next.layers.find((entry) => entry.id === id).groupId) {
          const { groupId, ...rest } = next.layers.find((entry) => entry.id === id);
          void groupId;
          next = { ...next, layers: next.layers.map((entry) => (entry.id === id ? rest : entry)) };
        }
        store().replace(next, 'Reorder layers');
      });
    });
    layerList.addEventListener('dragend', () => {
      dragRow = null;
    });

    function groupSelected() {
      const layer = selectedLayer();
      if (!layer) throw new Error('Select a layer to group.');
      if (layer.groupId)
        throw new Error('This layer is already in a group. Groups are one level deep.');
      const next = Core.createGroup(project(), layer.id);
      state.selectedGroup = null;
      store().replace(next, 'Group layer');
      status('Grouped. Drag more layers onto the group header to add them.');
    }
    function ungroupSelected() {
      const id = state.selectedGroup || selectedLayer()?.groupId;
      if (!id) throw new Error('Select a group or a layer inside one.');
      store().replace(Core.removeGroup(project(), id), 'Ungroup layers');
      state.selectedGroup = null;
    }

    function toggleClip() {
      const layer = selectedLayer();
      if (!layer) throw new Error('Select a layer first.');
      store().replace(
        Core.updateLayer(project(), layer.id, { clip: !layer.clip }),
        layer.clip ? 'Release clipping mask' : 'Create clipping mask',
      );
    }

    // ------------------------------------------------------------ menus

    let menubar = null;
    let findButton = null;
    const pendingMenus = [];
    function mountMenus(fallback = false) {
      if (menubar) return;
      const shellBar = root.querySelector('.aa-shell-menubar');
      if (!shellBar && !fallback) return;
      menubar =
        shellBar ||
        (() => {
          const bar = el('div', 'aa-shell-menubar ap-studio-menubar');
          bar.setAttribute('role', 'group');
          bar.setAttribute('aria-label', 'Editor commands');
          root.querySelector('.ap-app')?.prepend(bar);
          return bar;
        })();
      menubar.dataset.afMenu = '';
      findButton = menubar.querySelector('.aa-shell-document, .aa-find-button');
      for (const [label, entries] of pendingMenus) buildMenu(label, entries);
      document.addEventListener('pointerdown', (event) => {
        if (!menubar.contains(event.target))
          for (const open of menubar.querySelectorAll('details.ap-studio-menu[open]'))
            open.open = false;
      });
    }
    function menu(label, entries) {
      pendingMenus.push([label, entries]);
      if (menubar) buildMenu(label, entries);
    }
    function buildMenu(label, entries) {
      const details = el('details', 'aa-menu ap-studio-menu');
      const summary = el('summary', '', label);
      const panel = el('div', 'aa-menu-panel');
      for (const entry of entries) {
        if (entry === '-') {
          panel.append(el('hr', 'ap-menu-sep'));
          continue;
        }
        const item = el('button', 'aa-menu-item');
        item.type = 'button';
        item.append(el('span', 'aa-action-label', entry.label));
        if (entry.key) item.append(el('kbd', '', entry.key));
        item.addEventListener('click', () => {
          details.open = false;
          guard(entry.run);
        });
        panel.append(item);
      }
      details.append(summary, panel);
      details.addEventListener('toggle', () => {
        if (details.open)
          for (const other of menubar.querySelectorAll('details[open]'))
            if (other !== details) other.open = false;
      });
      menubar.insertBefore(details, findButton || null);
    }
    menu('Image', [
      ...[
        'levels',
        'curves',
        'hue-saturation',
        'vibrance',
        'color-balance',
        'brightness-contrast',
        'exposure',
        'black-white',
        'photo-filter',
        'channel-mixer',
        'gradient-map',
        'invert',
        'posterize',
        'threshold',
      ].map((kind) => ({
        label: `${ADJUSTMENT_LABELS[kind]}…`,
        key:
          {
            levels: `${MOD}L`,
            curves: `${MOD}M`,
            'hue-saturation': `${MOD}U`,
            'color-balance': `${MOD}B`,
            invert: `${MOD}I`,
          }[kind] || '',
        run: () => addAdjustment(kind),
      })),
      '-',
      { label: 'Image Size…', run: imageSizeDialog },
      { label: 'Canvas Size…', run: canvasSizeDialog },
      { label: 'Rotate 90° clockwise', run: () => rotateCanvas(90, 'Rotate 90° clockwise') },
      {
        label: 'Rotate 90° counter-clockwise',
        run: () => rotateCanvas(-90, 'Rotate 90° counter-clockwise'),
      },
      { label: 'Rotate 180°', run: () => rotateCanvas(180, 'Rotate 180°') },
      { label: 'Flip canvas horizontal', run: () => flipCanvas('horizontal') },
      { label: 'Flip canvas vertical', run: () => flipCanvas('vertical') },
      {
        label: 'Crop to selection',
        run: () => {
          const s = currentSelection();
          if (!s) throw new Error('Make a selection first.');
          store().replace(Core.setCrop(project(), s.bounds), 'Crop to selection');
          editor.view.fit('fit');
        },
      },
      { label: 'Trim transparent edges', run: trimTransparent },
      '-',
      {
        label: 'Content-Aware Fill (remove selection)',
        key: 'Shift+Backspace',
        run: contentAwareFill,
      },
    ]);
    menu('Layer', [
      { label: 'New layer', key: `Shift+${MOD}N`, run: newLayer },
      { label: 'Layer via Copy', key: `${MOD}J`, run: () => layerViaCopy(false) },
      { label: 'Layer via Cut', key: `Shift+${MOD}J`, run: () => layerViaCopy(true) },
      { label: 'Rasterize layer', run: rasterizeLayer },
      '-',
      {
        label: 'Add layer mask (reveal all / selection)',
        run: () => {
          const layer = selectedLayer();
          if (!layer) throw new Error('Select a layer first.');
          ensureMask(layer.id, currentSelection() ? 'selection' : 'reveal');
        },
      },
      {
        label: 'Add layer mask (hide all)',
        run: () => {
          const layer = selectedLayer();
          if (!layer) throw new Error('Select a layer first.');
          ensureMask(layer.id, 'hide');
        },
      },
      { label: 'Invert layer mask', run: invertMask },
      { label: 'Apply layer mask', run: applyMask },
      {
        label: 'Delete layer mask',
        run: () => {
          const layer = selectedLayer();
          if (!layer?.rasterMask) throw new Error('Select a layer with a mask.');
          store().replace(Core.setRasterMask(project(), layer.id, null), 'Delete layer mask');
        },
      },
      { label: 'Create / release clipping mask', key: `Alt+${MOD}G`, run: toggleClip },
      { label: 'Group layer', key: `${MOD}G`, run: groupSelected },
      { label: 'Ungroup', key: `Shift+${MOD}G`, run: ungroupSelected },
      {
        label: 'Remove layer from group',
        run: () => {
          const layer = selectedLayer();
          if (!layer?.groupId) throw new Error('The selected layer is not in a group.');
          store().replace(Core.setLayerGroup(project(), layer.id, null), 'Remove from group');
        },
      },
      { label: 'Layer Style…', run: () => layerStyleDialog() },
      {
        label: 'Clear Layer Style',
        run: () => {
          const layer = selectedLayer();
          if (!layer?.styles && !(layer?.fillOpacity < 1))
            throw new Error('The selected layer has no style.');
          store().replace(
            Core.updateLayer(project(), layer.id, { styles: null, fillOpacity: 1 }),
            'Clear Layer Style',
          );
        },
      },
      {
        label: 'Lock / unlock layer',
        run: () => {
          const layer = selectedLayer();
          if (!layer) throw new Error('Select a layer first.');
          store().replace(
            Core.updateLayer(project(), layer.id, { locked: !layer.locked }),
            layer.locked ? 'Unlock layer' : 'Lock layer',
          );
        },
      },
      '-',
      { label: 'Merge Down', key: `${MOD}E`, run: mergeDown },
      { label: 'Flatten Image', key: `Shift+${MOD}E`, run: flattenImage },
      { label: 'Free Transform', key: `${MOD}T`, run: beginTransform },
    ]);
    menu('Select', [
      {
        label: 'All',
        key: `${MOD}A`,
        run: () =>
          commitSelection(Px.createMask(project().width, project().height, 255), 'Select All'),
      },
      { label: 'Deselect', key: `${MOD}D`, run: () => commitSelection(null, 'Deselect') },
      {
        label: 'Reselect',
        key: `Shift+${MOD}D`,
        run: () => {
          if (!lastSelectionId || !selections.has(lastSelectionId))
            throw new Error('There is no previous selection.');
          store().replace({ ...project(), selection: { id: lastSelectionId } }, 'Reselect');
        },
      },
      {
        label: 'Inverse',
        key: `Shift+${MOD}I`,
        run: () => {
          const s = currentSelection();
          commitSelection(s ? Px.invertMask(s.mask) : null, 'Inverse');
        },
      },
      {
        label: 'Layer transparency',
        run: () => {
          const layer = selectedLayer();
          if (!layer || layer.type === 'adjustment')
            throw new Error('Select a pixel, text, or shape layer.');
          const data = readPixels(renderLayerAlone(layer)).data;
          const mask = new Uint8ClampedArray(data.length / 4);
          for (let i = 0, k = 3; i < mask.length; i += 1, k += 4) mask[i] = data[k];
          commitSelection(mask, 'Load layer transparency');
        },
      },
      { label: 'Color Range (foreground color)…', run: colorRangeSelect },
      '-',
      { label: 'Feather…', key: 'Shift+F6', run: () => modifySelection('feather') },
      { label: 'Expand…', run: () => modifySelection('expand') },
      { label: 'Contract…', run: () => modifySelection('contract') },
    ]);
    menu('Filter', [
      { label: 'Liquify…', key: `Shift+${MOD}X`, run: liquifyDialog },
      '-',
      ...FILTER_MENU.map((spec) => ({
        label: `${spec.group}: ${spec.label}`,
        run: () => filterDialog(spec),
      })),
    ]);
    menu('Zoom', [
      { label: 'Zoom in', key: `${MOD}+`, run: () => zoomTo(editor.view.zoom * 1.25) },
      { label: 'Zoom out', key: `${MOD}-`, run: () => zoomTo(editor.view.zoom / 1.25) },
      { label: 'Fit on screen', key: `${MOD}0`, run: fitAnimated },
      { label: '100%', key: `${MOD}1`, run: () => zoomTo(1) },
      { label: 'Rulers', run: toggleRulers },
      { label: 'Add horizontal guide…', run: () => addGuide('y') },
      { label: 'Add vertical guide…', run: () => addGuide('x') },
      {
        label: 'Show / hide guides',
        key: `${MOD};`,
        run: () => {
          state.showGuides = !state.showGuides;
          scheduleOverlay();
          status(state.showGuides ? 'Guides shown.' : 'Guides hidden.');
        },
      },
      {
        label: 'Snap on / off',
        key: `Shift+${MOD};`,
        run: () => {
          state.snap = !state.snap;
          status(state.snap ? 'Snapping to guides and canvas edges is on.' : 'Snapping is off.');
        },
      },
      {
        label: 'Clear guides',
        run: () => {
          overlayGuides = [];
          scheduleOverlay();
        },
      },
      { label: 'Keyboard shortcuts', key: '?', run: shortcutsDialog },
    ]);
    mountMenus();
    root.addEventListener('alcorapp:mounted', () => mountMenus());
    if (document.readyState === 'complete') setTimeout(() => mountMenus(true), 0);
    else window.addEventListener('load', () => mountMenus(true), { once: true });

    function modifySelection(kind) {
      const s = currentSelection();
      if (!s) throw new Error('Make a selection first.');
      const title = `${kind[0].toUpperCase() + kind.slice(1)} selection`;
      numberDialog(
        title,
        kind === 'feather' ? 'Feather radius (px)' : 'By (px)',
        kind === 'feather' ? 10 : 4,
        1,
        250,
        1,
        (value) => applyModify(kind, s, value),
      );
    }
    function applyModify(kind, s, value) {
      if (!Number.isFinite(value) || value <= 0) return;
      const mask =
        kind === 'feather'
          ? Px.featherMask(s.mask, s.width, s.height, value)
          : kind === 'expand'
            ? Px.expandMask(s.mask, s.width, s.height, value)
            : Px.contractMask(s.mask, s.width, s.height, value);
      commitSelection(mask, `${kind[0].toUpperCase() + kind.slice(1)} selection`);
    }

    function colorRangeSelect(fuzziness = null) {
      if (fuzziness == null) {
        numberDialog(
          'Color Range',
          `Fuzziness around ${state.fg} (0–255)`,
          40,
          0,
          255,
          1,
          (value) => colorRangeSelect(value),
        );
        return;
      }
      const value = fuzziness;
      if (!Number.isFinite(value) || value < 0) return;
      const mask = Px.colorRangeMask(readPixels(renderMerged()), state.fg, value);
      if (!Px.maskBounds(mask, project().width, project().height))
        throw new Error(`No pixels are within ${value} of ${state.fg}.`);
      combineSelection(mask, state.selection.mode, 'Color Range');
    }

    function trimTransparent() {
      const p = project();
      const crop = p.crop;
      const merged = readPixels(renderMerged(), crop);
      const alpha = new Uint8ClampedArray(merged.width * merged.height);
      for (let i = 0, k = 3; i < alpha.length; i += 1, k += 4) alpha[i] = merged.data[k];
      const bounds = Px.maskBounds(alpha, merged.width, merged.height);
      if (!bounds) throw new Error('The image is fully transparent.');
      const nextCrop = {
        x: crop.x + bounds.x,
        y: crop.y + bounds.y,
        width: bounds.width,
        height: bounds.height,
      };
      if (
        nextCrop.x !== crop.x ||
        nextCrop.y !== crop.y ||
        nextCrop.width !== crop.width ||
        nextCrop.height !== crop.height
      ) {
        store().replace(Core.setCrop(p, nextCrop), 'Trim');
      }
      editor.view.fit('fit');
    }

    // ------------------------------------------------------------ dialogs

    function dialog(title, build, onOk, options = {}) {
      const node = el(
        'dialog',
        `ap-dialog${options.side ? ' ap-dialog-side' : ''}${options.wide ? ' ap-dialog-wide' : ''}`,
      );
      node.setAttribute('aria-label', title);
      const form = el('form');
      form.method = 'dialog';
      form.append(el('h2', '', title));
      const body = el('div', 'ap-dialog-body');
      form.append(body);
      build(body);
      const actions = el('div', 'ap-dialog-actions');
      const cancel = el('button', '', 'Cancel');
      cancel.type = 'button';
      cancel.value = 'cancel';
      const ok = el('button', 'aa-button-primary', options.okLabel || 'OK');
      ok.type = 'submit';
      ok.value = 'ok';
      actions.append(cancel, ok);
      form.append(actions);
      node.append(form);
      root.append(node);
      cancel.addEventListener('click', () => node.close('cancel'));
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        node.close('ok');
      });
      node.addEventListener('close', () => {
        const accepted = node.returnValue === 'ok';
        node.remove();
        if (options.onClose) options.onClose(accepted);
        if (accepted) guard(onOk);
      });
      node.addEventListener('keydown', (event) => event.stopPropagation());
      if (typeof node.showModal === 'function') node.showModal();
      else node.setAttribute('open', '');
      body.querySelector('input,select')?.focus();
      return node;
    }

    // One-number dialog (replaces window.prompt, which some embedded browsers block).
    function numberDialog(title, label, value, min, max, step, onOk) {
      let current = value;
      dialog(
        title,
        (body) => {
          const input = el('input', 'ap-opt-number');
          input.type = 'number';
          input.min = String(min);
          input.max = String(max);
          input.step = String(step);
          input.value = String(value);
          input.addEventListener('input', () => {
            current = Number(input.value);
          });
          body.append(field(label, input));
        },
        () => {
          if (Number.isFinite(current)) onOk(Math.min(max, Math.max(min, current)));
        },
      );
    }

    function filterDialog(spec) {
      pixelTarget({ noCreate: true });
      const params = Object.fromEntries(
        spec.params.map((param) => [param.key, param.type === 'check' ? param.value : param.value]),
      );
      if (!spec.params.length) return applyFilter(spec, params);
      let timer = 0;
      const refresh = () => {
        clearTimeout(timer);
        timer = setTimeout(() => previewFilter(spec, params), 60);
      };
      dialog(
        spec.label.replace('…', ''),
        (body) => {
          for (const param of spec.params) {
            if (param.type === 'check') {
              const input = checkbox(
                param.on ? params[param.key] === param.on : params[param.key],
                (v) => {
                  params[param.key] = param.on ? (v ? param.on : param.off) : v;
                  refresh();
                },
              );
              body.append(field(param.label, input));
            } else
              body.append(
                field(
                  param.label,
                  rangeInput(params[param.key], param.min, param.max, param.step, (v) => {
                    params[param.key] = v;
                    refresh();
                  }),
                ),
              );
          }
          body.append(
            el(
              'p',
              'ap-dialog-note',
              'Preview is computed on a reduced copy; OK applies at full resolution in the background.',
            ),
          );
          refresh();
        },
        () => applyFilter(spec, params),
        {
          side: true,
          onClose: () => {
            clearTimeout(timer);
            clearPreview();
          },
        },
      );
    }

    // Layer > Layer Style: live-previewed effects stored on the layer (non-destructive).
    const STYLE_DEFAULTS = Object.freeze({
      dropShadow: { color: '#000000', opacity: 0.6, angle: 120, distance: 8, size: 12 },
      innerShadow: { color: '#000000', opacity: 0.6, angle: 120, distance: 4, size: 8 },
      outerGlow: { color: '#ffe680', opacity: 0.8, size: 16 },
      stroke: { color: '#000000', opacity: 1, size: 3, position: 'outside' },
      colorOverlay: { color: '#ff3366', opacity: 1 },
      gradientOverlay: { from: '#1e3cff', to: '#ff3ca0', angle: 90, opacity: 1 },
    });
    const STYLE_LABELS = Object.freeze({
      dropShadow: 'Drop Shadow',
      innerShadow: 'Inner Shadow',
      outerGlow: 'Outer Glow',
      stroke: 'Stroke',
      colorOverlay: 'Color Overlay',
      gradientOverlay: 'Gradient Overlay',
    });
    const STYLE_PRESETS = Object.freeze([
      [
        'Soft shadow',
        { dropShadow: { color: '#000000', opacity: 0.45, angle: 90, distance: 10, size: 24 } },
      ],
      [
        'Sticker',
        {
          stroke: { color: '#ffffff', opacity: 1, size: 10, position: 'outside' },
          dropShadow: { color: '#000000', opacity: 0.35, angle: 90, distance: 4, size: 10 },
        },
      ],
      [
        'Neon',
        {
          outerGlow: { color: '#39ff14', opacity: 0.9, size: 22 },
          stroke: { color: '#d9ffd0', opacity: 1, size: 2, position: 'center' },
        },
      ],
      ['Outline', { stroke: { color: '#000000', opacity: 1, size: 4, position: 'outside' } }, 0],
      [
        'Embossed',
        {
          innerShadow: { color: '#000000', opacity: 0.5, angle: 120, distance: 3, size: 4 },
          dropShadow: { color: '#ffffff', opacity: 0.5, angle: -60, distance: 2, size: 2 },
        },
      ],
    ]);
    function layerStyleDialog(focusKey = null) {
      const layer = selectedLayer();
      if (!layer || layer.type === 'adjustment')
        throw new Error('Select a pixel, text, or shape layer to style.');
      const original = project();
      const styles = JSON.parse(JSON.stringify(layer.styles || {}));
      let fillOpacity = layer.fillOpacity ?? 1;
      const build = () =>
        Core.updateLayer(original, layer.id, {
          styles: Object.keys(styles).length ? styles : null,
          fillOpacity,
        });
      const preview = () => {
        try {
          editor.previewProject(build());
        } catch (error) {
          editor.status(error.message, 'error');
        }
      };
      dialog(
        'Layer Style',
        (body) => {
          const presets = el('div', 'ap-style-presets');
          presets.setAttribute('role', 'group');
          presets.setAttribute('aria-label', 'Style presets');
          const sections = el('div', 'ap-style-sections');
          const renderSections = () => {
            sections.textContent = '';
            for (const key of Object.keys(STYLE_DEFAULTS)) {
              const box = el('details', 'ap-style-section');
              box.open = Boolean(styles[key]) || key === focusKey;
              const summary = el('summary');
              const toggle = checkbox(Boolean(styles[key]), (on) => {
                if (on) styles[key] = { ...STYLE_DEFAULTS[key], ...(styles[key] || {}) };
                else delete styles[key];
                renderSections();
                preview();
              });
              toggle.setAttribute('aria-label', `Enable ${STYLE_LABELS[key]}`);
              toggle.dataset.style = key;
              summary.append(toggle, el('span', '', STYLE_LABELS[key]));
              box.append(summary);
              const fx = styles[key];
              if (fx) {
                const set = (name, value) => {
                  fx[name] = value;
                  preview();
                };
                const color = (name) => {
                  const input = el('input');
                  input.type = 'color';
                  input.value = fx[name];
                  input.addEventListener('input', () => set(name, input.value));
                  return input;
                };
                if ('color' in fx) box.append(field('Color', color('color')));
                if ('from' in fx)
                  box.append(field('From', color('from')), field('To', color('to')));
                box.append(
                  field(
                    'Opacity %',
                    rangeInput(Math.round(fx.opacity * 100), 0, 100, 1, (v) =>
                      set('opacity', v / 100),
                    ),
                  ),
                );
                if ('angle' in fx)
                  box.append(
                    field(
                      'Angle °',
                      rangeInput(fx.angle, -180, 180, 1, (v) => set('angle', v)),
                    ),
                  );
                if ('distance' in fx)
                  box.append(
                    field(
                      'Distance px',
                      rangeInput(fx.distance, 0, 200, 1, (v) => set('distance', v)),
                    ),
                  );
                if (key === 'stroke') {
                  box.append(
                    field(
                      'Size px',
                      rangeInput(fx.size, 1, 64, 1, (v) => set('size', v)),
                    ),
                  );
                  box.append(
                    field(
                      'Position',
                      select(
                        [
                          ['outside', 'Outside'],
                          ['center', 'Center'],
                          ['inside', 'Inside'],
                        ],
                        fx.position,
                        (v) => set('position', v),
                      ),
                    ),
                  );
                } else if ('size' in fx)
                  box.append(
                    field(
                      'Size px',
                      rangeInput(fx.size, 0, 250, 1, (v) => set('size', v)),
                    ),
                  );
              }
              sections.append(box);
            }
          };
          for (const [name, preset] of STYLE_PRESETS) {
            const b = el('button', 'ap-style-preset', name);
            b.type = 'button';
            b.addEventListener('click', () => {
              for (const key of Object.keys(styles)) delete styles[key];
              Object.assign(styles, JSON.parse(JSON.stringify(preset)));
              renderSections();
              preview();
            });
            presets.append(b);
          }
          const clear = el('button', 'ap-style-preset', 'None');
          clear.type = 'button';
          clear.addEventListener('click', () => {
            for (const key of Object.keys(styles)) delete styles[key];
            renderSections();
            preview();
          });
          presets.append(clear);
          body.append(
            presets,
            field(
              'Fill opacity %',
              rangeInput(Math.round(fillOpacity * 100), 0, 100, 1, (v) => {
                fillOpacity = v / 100;
                preview();
              }),
            ),
            sections,
          );
          body.append(
            el(
              'p',
              'ap-dialog-note',
              'Effects stay editable: they follow the layer, its mask and text edits. Fill opacity fades the layer content but not its effects.',
            ),
          );
          renderSections();
        },
        () => store().replace(build(), 'Layer Style'),
        {
          side: true,
          onClose: (accepted) => {
            if (!accepted) editor.requestRender();
          },
        },
      );
    }

    // File > New: document presets for photo, social, print, screen and art work.
    const DOC_PRESETS = Object.freeze([
      [
        'Photo',
        [
          ['Photo 6×4 in · 300 ppi', 1800, 1200, 300],
          ['Photo 7×5 in · 300 ppi', 2100, 1500, 300],
          ['Square photo 2048', 2048, 2048, 72],
        ],
      ],
      [
        'Social',
        [
          ['Instagram post 4:5', 1080, 1350, 72],
          ['Instagram / TikTok story 9:16', 1080, 1920, 72],
          ['Square post 1:1', 1080, 1080, 72],
          ['YouTube thumbnail', 1280, 720, 72],
          ['X / LinkedIn banner', 1500, 500, 72],
          ['Facebook cover', 1640, 624, 72],
        ],
      ],
      [
        'Print',
        [
          ['US Letter · 300 ppi', 2550, 3300, 300],
          ['A4 · 300 ppi', 2480, 3508, 300],
          ['A5 · 300 ppi', 1748, 2480, 300],
          ['Business card 3.5×2 in · 300 ppi', 1050, 600, 300],
          ['Poster 18×24 in · 150 ppi', 2700, 3600, 150],
        ],
      ],
      [
        'Screen',
        [
          ['HD 1280×720', 1280, 720, 72],
          ['Full HD 1920×1080', 1920, 1080, 72],
          ['4K UHD 3840×2160', 3840, 2160, 72],
          ['Phone wallpaper 1170×2532', 1170, 2532, 72],
          ['Desktop wallpaper 2560×1440', 2560, 1440, 72],
        ],
      ],
      [
        'Art & icons',
        [
          ['Sketch canvas 3000×2000', 3000, 2000, 300],
          ['Comic page 6.625×10.25 in', 1988, 3075, 300],
          ['Pixel art 64×64', 64, 64, 72],
          ['Sprite sheet 512×512', 512, 512, 72],
          ['App icon 1024', 1024, 1024, 72],
          ['Favicon 256', 256, 256, 72],
        ],
      ],
    ]);
    function newDocumentDialog() {
      const values = {
        name: 'Untitled photo',
        width: 1920,
        height: 1080,
        ppi: 72,
        background: 'white',
      };
      let w, h, r;
      const sync = () => {
        w.value = String(values.width);
        h.value = String(values.height);
        r.value = String(values.ppi);
      };
      dialog(
        'New document',
        (body) => {
          const presets = el('div', 'ap-doc-presets');
          for (const [group, items] of DOC_PRESETS) {
            const box = el('details', 'ap-style-section');
            box.open = group === 'Social';
            box.append(el('summary', '', group));
            const list = el('div', 'ap-style-presets');
            for (const [label, pw, ph, ppi] of items) {
              const b = el('button', 'ap-style-preset', label);
              b.type = 'button';
              b.addEventListener('click', () => {
                Object.assign(values, { width: pw, height: ph, ppi, name: label.split(' · ')[0] });
                sync();
                for (const other of presets.querySelectorAll('.ap-style-preset'))
                  other.setAttribute('aria-pressed', String(other === b));
              });
              list.append(b);
            }
            box.append(list);
            presets.append(box);
          }
          w = el('input');
          w.type = 'number';
          w.min = '1';
          w.max = String(Core.MAX_DIMENSION);
          h = el('input');
          h.type = 'number';
          h.min = '1';
          h.max = String(Core.MAX_DIMENSION);
          r = el('input');
          r.type = 'number';
          r.min = '1';
          r.max = '10000';
          w.addEventListener('input', () => {
            values.width = Number(w.value);
          });
          h.addEventListener('input', () => {
            values.height = Number(h.value);
          });
          r.addEventListener('input', () => {
            values.ppi = Number(r.value);
          });
          const swap = el('button', 'ap-style-preset', 'Swap orientation');
          swap.type = 'button';
          swap.addEventListener('click', () => {
            [values.width, values.height] = [values.height, values.width];
            sync();
          });
          sync();
          body.append(
            presets,
            field('Width px', w),
            field('Height px', h),
            swap,
            field('Resolution ppi', r),
            field(
              'Background',
              select(
                [
                  ['white', 'White'],
                  ['black', 'Black'],
                  ['transparent', 'Transparent'],
                  ['fg', 'Foreground color'],
                ],
                values.background,
                (v) => {
                  values.background = v;
                },
              ),
            ),
          );
        },
        () => {
          const width = Math.round(values.width),
            height = Math.round(values.height);
          if (
            !(
              width >= 1 &&
              height >= 1 &&
              width <= Core.MAX_DIMENSION &&
              height <= Core.MAX_DIMENSION
            )
          )
            throw new Error(`Width and height must be 1–${Core.MAX_DIMENSION} px.`);
          if (width * height > Core.MAX_CANVAS_PIXELS)
            throw new Error('That document is larger than the 64-megapixel limit.');
          const background =
            values.background === 'transparent'
              ? null
              : values.background === 'white'
                ? '#ffffff'
                : values.background === 'black'
                  ? '#000000'
                  : state.fg;
          if (
            editor.newDocument({
              name: values.name,
              width,
              height,
              ppi: Math.round(values.ppi) || 72,
              background,
            })
          )
            editor.view.fit('fit');
        },
        { okLabel: 'Create' },
      );
    }
    editor.addNewDocumentHandler(() => guard(newDocumentDialog));

    function imageSizeDialog() {
      const p = project();
      const values = { width: p.width, height: p.height, keep: true };
      dialog(
        'Image Size',
        (body) => {
          const w = el('input');
          w.type = 'number';
          w.min = '1';
          w.max = String(Core.MAX_DIMENSION);
          w.value = String(p.width);
          const h = el('input');
          h.type = 'number';
          h.min = '1';
          h.max = String(Core.MAX_DIMENSION);
          h.value = String(p.height);
          const keep = checkbox(true, (v) => {
            values.keep = v;
          });
          w.addEventListener('input', () => {
            values.width = Number(w.value);
            if (values.keep) {
              values.height = Math.max(1, Math.round((values.width * p.height) / p.width));
              h.value = String(values.height);
            }
          });
          h.addEventListener('input', () => {
            values.height = Number(h.value);
            if (values.keep) {
              values.width = Math.max(1, Math.round((values.height * p.width) / p.height));
              w.value = String(values.width);
            }
          });
          body.append(
            field('Width px', w),
            field('Height px', h),
            field('Constrain proportions', keep),
            el(
              'p',
              'ap-dialog-note',
              'Layers are rescaled non-destructively; pixels are resampled when the image is drawn or exported.',
            ),
          );
        },
        () => {
          store().replace(
            Core.resizeCanvas(project(), values, { scaleLayers: true }),
            'Image Size',
          );
          editor.view.fit('fit');
        },
      );
    }

    function canvasSizeDialog() {
      const p = project();
      const values = { width: p.width, height: p.height, anchor: 'center' };
      dialog(
        'Canvas Size',
        (body) => {
          const w = el('input');
          w.type = 'number';
          w.min = '1';
          w.max = String(Core.MAX_DIMENSION);
          w.value = String(p.width);
          const h = el('input');
          h.type = 'number';
          h.min = '1';
          h.max = String(Core.MAX_DIMENSION);
          h.value = String(p.height);
          w.addEventListener('input', () => {
            values.width = Number(w.value);
          });
          h.addEventListener('input', () => {
            values.height = Number(h.value);
          });
          const anchors = el('div', 'ap-anchor-grid');
          anchors.setAttribute('role', 'group');
          anchors.setAttribute('aria-label', 'Anchor');
          for (const anchor of [
            'top-left',
            'top',
            'top-right',
            'left',
            'center',
            'right',
            'bottom-left',
            'bottom',
            'bottom-right',
          ]) {
            const b = el('button', '', '•');
            b.type = 'button';
            b.setAttribute('aria-label', `Anchor ${anchor}`);
            b.setAttribute('aria-pressed', String(anchor === 'center'));
            b.addEventListener('click', () => {
              values.anchor = anchor;
              for (const other of anchors.children)
                other.setAttribute('aria-pressed', String(other === b));
            });
            anchors.append(b);
          }
          body.append(field('Width px', w), field('Height px', h), field('Anchor', anchors));
        },
        () => {
          const next = Core.resizeCanvas(project(), values, { anchor: values.anchor });
          const cleared = { ...next };
          delete cleared.selection;
          store().replace(cleared, 'Canvas Size');
          editor.view.fit('fit');
        },
      );
    }

    function shortcutsDialog() {
      dialog(
        'Keyboard shortcuts',
        (body) => {
          const list = el('dl', 'ap-shortcuts');
          const rows = [
            ...TOOLS.map((tool) => [
              tool.key.toUpperCase(),
              tool.label + (tool.variants ? ` (Shift+${tool.key.toUpperCase()} cycles)` : ''),
            ]),
            ['Space-drag', 'Pan'],
            [`${MOD}wheel / pinch`, 'Zoom at pointer'],
            [`${MOD}0 / ${MOD}1`, 'Fit / 100%'],
            ['[ / ]', 'Brush size'],
            ['Shift+[ / ]', 'Brush hardness'],
            ['1…0', 'Tool opacity 10…100%'],
            ['X / D', 'Swap / default colors'],
            ['Q', 'Paint on layer mask'],
            [`${MOD}Z / Shift+${MOD}Z`, 'Undo / redo'],
            [`${MOD}A / ${MOD}D / Shift+${MOD}I`, 'Select all / deselect / inverse'],
            [`${MOD}C / ${MOD}X / ${MOD}V`, 'Copy / cut / paste'],
            [`${MOD}J`, 'Layer via copy'],
            [`${MOD}T`, 'Free Transform'],
            [`${MOD}E / Shift+${MOD}E`, 'Merge down / flatten'],
            ['Alt+Backspace / Ctrl+Backspace', 'Fill with foreground / background'],
            ['Delete', 'Clear selection'],
            [
              `${MOD}L / M / U / B / I`,
              'Levels / Curves / Hue-Sat / Color Balance / Invert (adjustment layers)',
            ],
            [`${MOD}G / Shift+${MOD}G`, 'Group / ungroup'],
            [`Alt+${MOD}G`, 'Clipping mask'],
            ['Arrow keys', 'Nudge layer or selected pixels (Shift: 10 px)'],
            [`${MOD}; / Shift+${MOD};`, 'Show guides / snap'],
            ['Alt-click', 'Set clone or healing source; eyedropper while painting'],
          ];
          for (const [keys, action] of rows) list.append(el('dt', '', keys), el('dd', '', action));
          body.append(list);
        },
        () => {},
        { okLabel: 'Close' },
      );
    }

    // ------------------------------------------------------------ chrome: one row of controls, bigger canvas

    // The project name becomes the editable document title in the shell; Undo/Redo
    // and the workspace switch join the canvas action bar. The original rows stay in
    // the DOM (their file inputs and data-af-* hooks are used by menus and the phone frame).
    function consolidateChrome() {
      const nameInput = root.querySelector('#ap-project-name');
      const shellDoc = root.querySelector('.aa-shell-document');
      if (nameInput && shellDoc && !shellDoc.contains(nameInput)) {
        nameInput.classList.add('ap-title-input');
        nameInput.setAttribute('aria-label', 'Project name');
        shellDoc.prepend(nameInput);
        shellDoc.classList.add('ap-shell-doc');
      }
      const tools = root.querySelector('.ap-canvas-tools');
      if (tools && !tools.querySelector('.ap-actionbar')) {
        const bar = el('div', 'ap-actionbar');
        const history = root.querySelector('.ap-history-actions');
        const modes = root.querySelector('.ap-mode-switch');
        if (history) {
          for (const b of history.querySelectorAll('button')) {
            const undo = b.dataset.action === 'undo';
            b.innerHTML = `${icon(undo ? 'undo' : 'redo', 16)}<span class="ap-sr">${undo ? 'Undo' : 'Redo'}</span>`;
            b.dataset.tip = undo ? `Undo · ${MOD}Z` : `Redo · Shift+${MOD}Z`;
          }
          bar.append(history);
        }
        if (modes) {
          modes.classList.add('ap-mode-compact');
          bar.append(modes);
        }
        tools.prepend(bar);
      }
      const exportButton = root.querySelector('[data-action="export-image"]');
      if (exportButton) exportButton.classList.add('ap-export-primary');
    }
    consolidateChrome();
    root.addEventListener('alcorapp:mounted', consolidateChrome);

    // ------------------------------------------------------------ empty state, samples, drag and drop

    const empty = el('div', 'ap-empty');
    empty.innerHTML = `<div class="ap-empty-card"><div class="ap-empty-mark" aria-hidden="true">${icon('image', 30)}</div><h2>Start with a picture</h2><p>Drop an image here, paste with ${MOD}V, or try a sample. Everything stays on this device.</p><div class="ap-empty-actions"><button type="button" class="ap-empty-open" data-empty-open>Open an image…</button><button type="button" data-empty-blank>Blank canvas</button></div><div class="ap-samples" role="group" aria-label="Sample images"></div></div>`;
    viewport.append(empty);
    const SAMPLES = [
      { id: 'dusk', name: 'Harbour at dusk' },
      { id: 'peaks', name: 'Alpine ridge' },
      { id: 'city', name: 'Night city' },
    ];
    // Samples are painted in code (no files, no downloads, no licences to track).
    function paintSample(id, width, height) {
      const c = makeCanvas(width, height);
      const x = ctx2d(c);
      const W = width,
        H = height;
      const rand = (() => {
        let a = id.length * 9973;
        return () => (a = (a * 16807) % 2147483647) / 2147483647;
      })();
      if (id === 'dusk') {
        const sky = x.createLinearGradient(0, 0, 0, H * 0.62);
        sky.addColorStop(0, '#1b1446');
        sky.addColorStop(0.45, '#7a3b7a');
        sky.addColorStop(0.8, '#f08a4b');
        sky.addColorStop(1, '#ffd37a');
        x.fillStyle = sky;
        x.fillRect(0, 0, W, H * 0.62);
        x.fillStyle = 'rgba(255,236,190,0.95)';
        x.beginPath();
        x.arc(W * 0.62, H * 0.58, H * 0.09, 0, Math.PI * 2);
        x.fill();
        const sea = x.createLinearGradient(0, H * 0.62, 0, H);
        sea.addColorStop(0, '#3b2a55');
        sea.addColorStop(1, '#0c1024');
        x.fillStyle = sea;
        x.fillRect(0, H * 0.62, W, H * 0.38);
        x.fillStyle = 'rgba(255,206,140,0.55)';
        for (let i = 0; i < 70; i += 1) {
          const y = H * 0.63 + rand() * H * 0.3;
          const w = (1 - (y - H * 0.62) / (H * 0.4)) * W * 0.16 * rand();
          x.fillRect(W * 0.62 - w / 2 + (rand() - 0.5) * W * 0.05, y, w, Math.max(1, H * 0.004));
        }
        x.fillStyle = '#0b0d1c';
        x.beginPath();
        x.moveTo(0, H * 0.62);
        for (let i = 0; i <= 24; i += 1)
          x.lineTo(
            (W * 0.42 * i) / 24,
            H * (0.62 - 0.05 * Math.abs(Math.sin(i * 1.3)) - (i > 8 && i < 16 ? 0.06 : 0)),
          );
        x.lineTo(W * 0.42, H * 0.62);
        x.fill();
        // Lighthouse on the headland: tapered tower, lamp room, soft beam.
        x.beginPath();
        x.moveTo(W * 0.085, H * 0.6);
        x.lineTo(W * 0.093, H * 0.45);
        x.lineTo(W * 0.107, H * 0.45);
        x.lineTo(W * 0.115, H * 0.6);
        x.fill();
        x.fillRect(W * 0.089, H * 0.435, W * 0.022, H * 0.012);
        x.fillRect(W * 0.096, H * 0.41, W * 0.008, H * 0.025);
        const beam = x.createRadialGradient(W * 0.1, H * 0.42, 0, W * 0.1, H * 0.42, W * 0.05);
        beam.addColorStop(0, 'rgba(255,230,160,0.9)');
        beam.addColorStop(1, 'rgba(255,230,160,0)');
        x.fillStyle = beam;
        x.beginPath();
        x.arc(W * 0.1, H * 0.42, W * 0.05, 0, Math.PI * 2);
        x.fill();
      } else if (id === 'peaks') {
        const sky = x.createLinearGradient(0, 0, 0, H);
        sky.addColorStop(0, '#8fd3ff');
        sky.addColorStop(0.6, '#e6f4ff');
        sky.addColorStop(1, '#ffffff');
        x.fillStyle = sky;
        x.fillRect(0, 0, W, H);
        const ridge = (base, amp, color, snow) => {
          x.fillStyle = color;
          x.beginPath();
          x.moveTo(0, H);
          const pts = [];
          for (let i = 0; i <= 14; i += 1) {
            const px = (W * i) / 14;
            const py = H * (base - amp * (0.3 + rand() * 0.7) * (i % 2 ? 1 : 0.45));
            pts.push([px, py]);
            x.lineTo(px, py);
          }
          x.lineTo(W, H);
          x.fill();
          if (snow) {
            x.fillStyle = 'rgba(255,255,255,0.9)';
            for (let i = 1; i < pts.length - 1; i += 2) {
              const [px, py] = pts[i];
              x.beginPath();
              x.moveTo(px, py);
              x.lineTo(px - W * 0.03, py + H * 0.07);
              x.lineTo(px + W * 0.03, py + H * 0.07);
              x.fill();
            }
          }
        };
        ridge(0.6, 0.35, '#5b6f8f', true);
        ridge(0.75, 0.25, '#34506b', false);
        ridge(0.9, 0.18, '#1f3a44', false);
        x.fillStyle = '#16302f';
        for (let i = 0; i < 60; i += 1) {
          const px = rand() * W,
            py = H * (0.86 + rand() * 0.14),
            s2 = H * (0.03 + rand() * 0.05);
          x.beginPath();
          x.moveTo(px, py - s2);
          x.lineTo(px - s2 * 0.35, py);
          x.lineTo(px + s2 * 0.35, py);
          x.fill();
        }
      } else {
        const sky = x.createLinearGradient(0, 0, 0, H);
        sky.addColorStop(0, '#060812');
        sky.addColorStop(1, '#1a1440');
        x.fillStyle = sky;
        x.fillRect(0, 0, W, H);
        x.fillStyle = 'rgba(255,255,255,0.8)';
        for (let i = 0; i < 120; i += 1) x.fillRect(rand() * W, rand() * H * 0.5, 1.2, 1.2);
        for (let i = 0; i < 26; i += 1) {
          const bw = W * (0.03 + rand() * 0.05),
            bh = H * (0.2 + rand() * 0.5),
            bx = (W * i) / 26 + (rand() - 0.5) * W * 0.02;
          x.fillStyle = `hsl(${230 + rand() * 30} 25% ${8 + rand() * 8}%)`;
          x.fillRect(bx, H - bh, bw, bh);
          for (let wy = H - bh + 6; wy < H - 6; wy += H * 0.02)
            for (let wx = bx + 3; wx < bx + bw - 4; wx += W * 0.008)
              if (rand() > 0.55) {
                x.fillStyle = rand() > 0.85 ? '#53d9d4' : rand() > 0.6 ? '#ffd27a' : '#f5e7b8';
                x.fillRect(wx, wy, W * 0.004, H * 0.008);
              }
        }
        const glow = x.createRadialGradient(W * 0.7, H, 0, W * 0.7, H, W * 0.5);
        glow.addColorStop(0, 'rgba(160,110,255,0.35)');
        glow.addColorStop(1, 'rgba(160,110,255,0)');
        x.fillStyle = glow;
        x.fillRect(0, 0, W, H);
      }
      return c;
    }
    const samplesHost = empty.querySelector('.ap-samples');
    (globalThis.requestIdleCallback || ((fn) => setTimeout(fn, 200)))(
      () => {
        for (const sample of SAMPLES) {
          const b = el('button', 'ap-sample');
          b.type = 'button';
          b.dataset.sample = sample.id;
          b.setAttribute('aria-label', `Open sample: ${sample.name}`);
          const thumb = paintSample(sample.id, 144, 96);
          thumb.setAttribute('aria-hidden', 'true');
          b.append(thumb, el('span', '', sample.name));
          samplesHost.append(b);
        }
      },
      { timeout: 1500 },
    );
    async function openSample(id) {
      const sample = SAMPLES.find((item) => item.id === id);
      const picture = paintSample(id, 1800, 1200);
      const blob = await new Promise((resolve) => picture.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('This browser could not create the sample image.');
      await editor.importFile(
        new File([blob], `${sample.name.toLowerCase().replace(/\s+/g, '-')}.png`, {
          type: 'image/png',
        }),
      );
    }
    empty.addEventListener('click', (event) => {
      const sample = event.target.closest('[data-sample]');
      if (sample) {
        guard(() => openSample(sample.dataset.sample));
        return;
      }
      if (event.target.closest('[data-empty-open]')) root.querySelector('#ap-image-file')?.click();
      if (event.target.closest('[data-empty-blank]')) {
        guard(newLayer);
      }
    });
    empty.addEventListener('pointerdown', (event) => event.stopPropagation(), true);
    function syncEmpty() {
      const isEmpty = project().layers.length === 0;
      if (empty.hidden === !isEmpty) return;
      empty.hidden = !isEmpty;
      if (!isEmpty) {
        // A short entrance when the first picture arrives.
        canvas.classList.remove('ap-canvas-enter');
        void canvas.offsetWidth;
        canvas.classList.add('ap-canvas-enter');
      }
    }
    empty.hidden = project().layers.length !== 0;

    // Whole-window drag and drop: images import, .alcorphoto files open.
    let dragDepth = 0;
    const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');
    window.addEventListener('dragenter', (event) => {
      if (!hasFiles(event)) return;
      dragDepth += 1;
      root.classList.add('ap-drop-active');
    });
    window.addEventListener('dragleave', (event) => {
      if (!hasFiles(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) root.classList.remove('ap-drop-active');
    });
    window.addEventListener('dragover', (event) => {
      if (hasFiles(event)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }
    });
    window.addEventListener('drop', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth = 0;
      root.classList.remove('ap-drop-active');
      const file = event.dataTransfer.files?.[0];
      if (!file) return;
      if (/\.alcorphoto$|\.json$/i.test(file.name)) editor.openProjectFile(file);
      else editor.importFile(file);
    });
    const dropHint = el('div', 'ap-drop-hint');
    dropHint.setAttribute('aria-hidden', 'true');
    dropHint.innerHTML = `<div>${icon('image', 36)}<strong>Drop to open</strong><span>Images become a new layer · .alcorphoto files open as a project</span></div>`;
    viewport.append(dropHint);

    // ------------------------------------------------------------ toasts and progress

    const toasts = el('div', 'ap-toasts');
    toasts.setAttribute('role', 'status');
    toasts.setAttribute('aria-live', 'polite');
    root.append(toasts);
    function toast(message, kind = 'ok', action = null) {
      const item = el('div', `ap-toast ap-toast-${kind}`);
      item.innerHTML = icon(kind === 'ok' ? 'check' : 'alert', 16);
      item.append(el('span', '', message));
      if (action) {
        const b = el('button', 'ap-toast-action', action.label);
        b.type = 'button';
        b.addEventListener('click', () => {
          item.remove();
          action.run();
        });
        item.append(b);
        item.classList.add('ap-toast-has-action');
      }
      toasts.append(item);
      requestAnimationFrame(() => item.classList.add('ap-toast-in'));
      setTimeout(
        () => {
          item.classList.remove('ap-toast-in');
          setTimeout(() => item.remove(), 260);
        },
        action ? 9000 : 3200,
      );
      while (toasts.children.length > 3) toasts.firstChild.remove();
    }
    // Errors also surface as toasts: on phones the status bar is hidden, and a
    // silent failure looks like a broken button.
    const statusNode = root.querySelector('#ap-status');
    let lastErrorToast = '';
    if (statusNode && typeof MutationObserver === 'function') {
      new MutationObserver(() => {
        const text = statusNode.textContent.trim();
        if (statusNode.dataset.level !== 'error' || !text || text === lastErrorToast) {
          if (statusNode.dataset.level !== 'error') lastErrorToast = '';
          return;
        }
        lastErrorToast = text;
        const offer = rasterizeOffer && rasterizeOffer.message === text ? rasterizeOffer : null;
        toast(
          text,
          'error',
          offer && {
            label: 'Rasterize',
            run: () => {
              try {
                if (selectedLayer()?.id !== offer.layerId)
                  throw new Error('Select the text or shape layer, then tap Rasterize.');
                rasterizeLayer();
                status('Layer rasterized. Pick the effect again.');
              } catch (error) {
                status(error.message, 'error');
              }
            },
          },
        );
      }).observe(statusNode, {
        childList: true,
        characterData: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-level'],
      });
    }
    // Last line of defense: an unexpected error in an editor script becomes a
    // visible, plain message rather than a control that silently does nothing.
    const editorScript = /alcor-photo[\w-]*\.js/;
    const report = (error, origin) => {
      const message = String(error?.message || error || '').slice(0, 160);
      if (!message || !editorScript.test(String(origin || error?.stack || ''))) return;
      toast(
        `Something went wrong: ${message}. Your work is unchanged; try again or undo.`,
        'error',
      );
    };
    globalThis.addEventListener?.('error', (event) =>
      report(event.error || event.message, event.filename || event.error?.stack),
    );
    globalThis.addEventListener?.('unhandledrejection', (event) =>
      report(event.reason, event.reason?.stack),
    );
    const formatBytes = (bytes) =>
      bytes >= 1048576
        ? `${(bytes / 1048576).toFixed(1)} MB`
        : `${Math.max(1, Math.round(bytes / 1024))} KB`;
    root.addEventListener('alcorphoto:saved', (event) => {
      const d = event.detail || {};
      toast(
        d.kind === 'project'
          ? `Project saved · ${d.filename} · ${formatBytes(d.bytes)}`
          : `Exported ${d.filename} · ${formatBytes(d.bytes)}${d.width ? ` · ${d.width}×${d.height}` : ''}`,
      );
    });
    const progress = el('div', 'ap-progress');
    progress.setAttribute('aria-hidden', 'true');
    canvasPanel?.prepend(progress);

    // ------------------------------------------------------------ animated zoom for commands

    var zoomAnimation = 0;
    function animateView(targetZoom, done) {
      cancelAnimationFrame(zoomAnimation);
      const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      const from = editor.view.zoom;
      if (
        reduce ||
        !Number.isFinite(targetZoom) ||
        Math.abs(from - targetZoom) / targetZoom < 0.01
      ) {
        done();
        return;
      }
      const started = performance.now(),
        duration = 170;
      const step = (now) => {
        const t = Math.min(1, (now - started) / duration);
        const ease = 1 - Math.pow(1 - t, 3);
        if (t < 1) {
          editor.view.setZoom(from * Math.pow(targetZoom / from, ease));
          zoomAnimation = requestAnimationFrame(step);
        } else done();
      };
      zoomAnimation = requestAnimationFrame(step);
    }
    function fitTarget() {
      const t = editor.view.transform();
      const crop = project().crop;
      const pad = Math.min(48, t.width * 0.06);
      return Math.min((t.width - pad) / crop.width, (t.height - pad) / crop.height);
    }
    function zoomTo(zoom) {
      animateView(zoom, () => editor.view.setZoom(zoom));
    }
    function fitAnimated() {
      animateView(fitTarget(), () => editor.view.fit());
    }

    // ------------------------------------------------------------ rulers and guides

    const rulerTop = el('canvas', 'ap-ruler ap-ruler-top');
    const rulerLeft = el('canvas', 'ap-ruler ap-ruler-left');
    rulerTop.hidden = rulerLeft.hidden = true;
    rulerTop.setAttribute('aria-hidden', 'true');
    rulerLeft.setAttribute('aria-hidden', 'true');
    viewport.append(rulerTop, rulerLeft);
    function toggleRulers() {
      rulerTop.hidden = rulerLeft.hidden = !rulerTop.hidden;
      viewport.dataset.rulers = String(!rulerTop.hidden);
      drawRulers();
    }
    function drawRulers() {
      if (rulerTop.hidden) return;
      const t = editor.view.transform();
      const dpr = Math.max(1, Math.min(2, globalThis.devicePixelRatio || 1));
      for (const [node, horizontal] of [
        [rulerTop, true],
        [rulerLeft, false],
      ]) {
        const length = horizontal ? t.width : t.height;
        node.width = Math.round((horizontal ? length : 18) * dpr);
        node.height = Math.round((horizontal ? 18 : length) * dpr);
        const c = ctx2d(node);
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.fillStyle = '#1b1f27';
        c.fillRect(0, 0, node.width, node.height);
        c.fillStyle = '#9aa4b2';
        c.strokeStyle = '#6b7482';
        c.font = '9px system-ui';
        c.lineWidth = 1;
        const steps = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
        const step = steps.find((s) => s * t.zoom >= 60) || 10000;
        const offset = horizontal ? t.x : t.y;
        const start = Math.floor(-offset / t.zoom / step) * step;
        c.beginPath();
        for (let v = start; v * t.zoom + offset < length; v += step / 5) {
          const pos = Math.round(v * t.zoom + offset) + 0.5;
          const major = Math.abs(v % step) < 1e-6;
          if (horizontal) {
            c.moveTo(pos, major ? 4 : 12);
            c.lineTo(pos, 18);
            if (major) c.fillText(String(Math.round(v)), pos + 2, 10);
          } else {
            c.moveTo(major ? 4 : 12, pos);
            c.lineTo(18, pos);
            if (major) {
              c.save();
              c.translate(10, pos + 2);
              c.rotate(-Math.PI / 2);
              c.fillText(String(Math.round(v)), -24, 0);
              c.restore();
            }
          }
        }
        c.stroke();
      }
    }
    root.addEventListener('alcorphoto:view', drawRulers);
    function addGuide(axis) {
      const size = axis === 'x' ? project().width : project().height;
      numberDialog(
        axis === 'x' ? 'New vertical guide' : 'New horizontal guide',
        'Position (px)',
        Math.round(size / 2),
        -size,
        size * 2,
        1,
        (value) => {
          overlayGuides.push({ axis, value });
          state.showGuides = true;
          scheduleOverlay();
        },
      );
    }

    // ------------------------------------------------------------ memory: history-aware garbage collection

    let gcTimer = 0;
    function liveIds() {
      const s = store();
      const texts = [
        JSON.stringify(s.project),
        ...(Array.isArray(s.h) ? s.h : []),
        ...(Array.isArray(s.f) ? s.f : []),
      ];
      const ids = new Set();
      for (const text of texts)
        for (const match of text.matchAll(/"((?:px|sel)-[a-z0-9-]{6,90})"/g)) ids.add(match[1]);
      if (stroke) ids.add(stroke.parentId);
      if (pixelMove) ids.add(pixelMove.parentId);
      return ids;
    }
    function collectGarbage() {
      gcTimer = 0;
      if (stroke || pixelMove || editor.operation) {
        scheduleGc();
        return;
      }
      let live = liveIds();
      rasters.retain(live);
      for (const id of [...selections.keys()])
        if (!live.has(id) && id !== lastSelectionId) selections.delete(id);
      // Over budget: release the oldest undo steps until pixel history fits.
      const s = store();
      let dropped = 0;
      while (rasters.stats().overBudget && Array.isArray(s.h) && s.h.length > 0) {
        s.h.shift();
        dropped += 1;
        live = liveIds();
        rasters.retain(live);
      }
      if (dropped) {
        history.past.splice(0, dropped);
        s.e?.emit?.('history', s.state());
        status(
          `Released the ${dropped} oldest undo step${dropped === 1 ? '' : 's'} to stay within the ${Math.round(rasters.stats().budgetBytes / 1048576)} MB pixel-history budget.`,
        );
      }
      renderHistory();
    }
    function scheduleGc() {
      if (!gcTimer) gcTimer = setTimeout(collectGarbage, 800);
    }

    // ------------------------------------------------------------ saving: bundle painted pixels

    const encodeCanvas = (target) =>
      new Promise((resolve, reject) =>
        target.toBlob(
          (blob) =>
            blob
              ? resolve(blob)
              : reject(new Error('The browser could not encode a painted layer.')),
          'image/png',
        ),
      );
    editor.addBundlePreparer(async ({ project: p, files }) => {
      const next = structuredClone(p);
      delete next.selection;
      const out = new Map(files);
      const sized = new Map();
      const owned = next.layers
        .flatMap((layer) => [
          layer.type === 'image' ? layer.source : null,
          layer.rasterMask ? layer.rasterMask.source : null,
        ])
        .filter((source) => source && !files.has(source.id) && rasters.has(source.id));
      const ids = [...new Set(owned.map((source) => source.id))];
      // Pin the versions being encoded so history clean-up cannot release them mid-save.
      rasters.pin(ids);
      try {
        for (const source of owned) {
          if (!sized.has(source.id)) {
            const blob = await rasters.encode(source.id, editor.resolveStoredSource, encodeCanvas);
            out.set(source.id, blob);
            sized.set(source.id, blob.size);
          }
          source.size = sized.get(source.id);
          source.mime = 'image/png';
        }
      } finally {
        rasters.unpin(ids);
      }
      return { project: Core.normalizeProject(next), files: out };
    });

    // ------------------------------------------------------------ store wiring

    editor.onStore((s) => {
      if (stroke) {
        stroke = null;
      }
      pixelMove = null;
      live = null;
      preview = null;
      state.transform = null;
      state.selectedGroup = null;
      state.targetMask = false;
      draft = null;
      hoverPoint = null;
      if (textEditor) {
        textEditor.area.remove();
        textEditor = null;
      }
      state.crop.box = state.tool === 'crop' ? { ...s.project.crop } : null;
      scheduleGc();
      if (typeof syncEmpty === 'function') syncEmpty();
      history.lastTop = undefined;
      history.storeRef = null;
      trackHistory({ label: 'Open' });
      s.on('change', (event) => {
        if (s !== editor.store) return;
        if (
          state.transform &&
          !project().layers.some((layer) => layer.id === state.transform.layerId)
        )
          state.transform = null;
        syncAutoTransform();
        if (state.crop.box && state.tool === 'crop' && event.label !== 'Crop')
          state.crop.box = { ...project().crop };
        trackHistory(event);
        syncEmpty();
        renderLayersEnhancement();
        renderProperties();
        renderOptionsIfNeeded();
        scheduleOverlay();
        scheduleGc();
      });
      renderLayersEnhancement();
      renderProperties();
      syncAutoTransform();
    });
    let lastSelectedForOptions = null;
    function renderOptionsIfNeeded() {
      // The Type bar mirrors the selected text layer, so a font/weight/style change made in
      // another panel re-renders it too (unless the change came from the bar itself).
      const layer = selectedLayer();
      const key =
        state.tool === 'type' && layer?.type === 'text'
          ? [layer.id, layer.fontFamily, layer.fontWeight, layer.italic, layer.align].join('|')
          : project().selectedLayerId;
      if (key === lastSelectedForOptions) return;
      lastSelectedForOptions = key;
      if (state.tool === 'type' && optionsBar.contains(document.activeElement)) return;
      if (!state.transform || state.transform.auto) renderOptions();
    }

    // ------------------------------------------------------------ legacy vector mask toolbar

    // The original shape-mask tools stay available for projects that use them,
    // grouped under a disclosure so the pixel tools lead.
    const legacy = root.querySelector('.ap-mask-tools');
    if (legacy) {
      const holder = el('details', 'ap-legacy-masks');
      holder.dataset.afPanel = 'vector-mask';
      holder.dataset.afLabel = 'Vector shape mask';
      holder.append(el('summary', '', 'Vector shape mask (image layers)'));
      legacy.before(holder);
      holder.append(legacy);
      sidebar.append(holder);
      legacy.addEventListener('click', (event) => {
        if (event.target.closest('[data-ap-mask],[data-ap-mask-brush]'))
          setTimeout(() => {
            if (
              legacy.querySelector(
                '[aria-pressed="true"][data-ap-mask],[aria-pressed="true"][data-ap-mask-brush]',
              )
            )
              setTool('move');
          });
      });
    }

    // ------------------------------------------------------------ zoom readout

    const zoomReadout = el('span', 'ap-zoom-readout');
    zoomReadout.setAttribute('aria-live', 'off');
    root.querySelector('.aa-statusbar')?.prepend(zoomReadout);
    root.addEventListener('alcorphoto:view', (event) => {
      const text = `${Math.round(event.detail.zoom * 1000) / 10}%`;
      if (zoomReadout.textContent !== text) zoomReadout.textContent = text;
    });

    setTool('move');
    renderColors();
    showPanel('properties');

    // Test and automation hooks (no network, no globals beyond this object).
    globalThis.AlcorPhotoStudio = Object.freeze({
      state,
      rasters,
      worker,
      setTool,
      setColor,
      currentSelection,
      commitSelection,
      selectAll: () =>
        commitSelection(Px.createMask(project().width, project().height, 255), 'Select All'),
      colorRangeSelect,
      newLayer,
      fillOrClear,
      addAdjustment,
      ensureMask,
      removeBackground,
      showPanel,
      applyFilter: (name, params) =>
        applyFilter(
          FILTER_MENU.find((spec) => spec.name === name),
          params || {},
        ),
      beginTransform,
      commitTransform,
      // Screen-space corners of the active transform box (tests and assistive tooling).
      transformControls: () => {
        if (!state.transform) return null;
        const t = editor.view.transform();
        const rect = canvas.getBoundingClientRect();
        return {
          auto: Boolean(state.transform.auto),
          layerId: state.transform.layerId,
          corners: transformPoints().map((p) => ({
            x: rect.left + t.x + p.x * t.zoom,
            y: rect.top + t.y + p.y * t.zoom,
          })),
        };
      },
      copySelection,
      pasteInternal,
      layerViaCopy,
      mergeDown,
      flattenImage,
      rasterizeLayer,
      rotateCanvas,
      flipCanvas,
      setCropRatio,
      applyCrop,
      resetCrop,
      groupSelected,
      ungroupSelected,
      guides: () => overlayGuides.map((guide) => ({ ...guide })),
      history: () => ({
        past: [...history.past],
        current: history.current,
        future: [...history.future],
      }),
      collectGarbage,
      sampleColor,
      layerStyleDialog,
      newDocumentDialog,
      contentAwareFill,
      liquifyDialog,
    });
  }
})();
