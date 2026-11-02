/**
 * alcor-photo-creator.js: AlcorPhoto creator tools.
 *
 * The simplified tool tray: crop, text, shapes, basic edits, one-tap auto
 * enhance and a remove brush. Registered as an editor extension.
 */
(function () {
  'use strict';

  (globalThis.AlcorPhotoExtensions = globalThis.AlcorPhotoExtensions || []).push(install);

  const ICONS = Object.freeze({
    image:
      '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 17-5-5-9 8"/><path d="M18 3v6M15 6h6"/>',
    wand: '<path d="M4 20 15 9M13 5l6 6"/><path d="M18 2v3M22 6h-3M20 3l-2 2M14 3l2 2"/>',
    type: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
    shape: '<rect x="3" y="5" width="11" height="9" rx="2"/><circle cx="16" cy="15" r="5"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/>',
    tone: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',
    effect: '<path d="M4 19 16 7M14 4l6 6M4 8h5M6.5 5.5v5M15 16h5M17.5 13.5v5"/>',
    brush: '<path d="M14 4l6 6-8 8H6v-6z"/><path d="m4 20 2-2"/>',
    crop: '<path d="M7 2v15h15M2 7h15v15"/>',
    auto: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/><circle cx="12" cy="12" r="3.5"/>',
    erase: '<path d="m7 21-4-4 11-11 7 7-8 8z"/><path d="M10 10l7 7M3 21h18"/>',
    looks:
      '<circle cx="9" cy="9" r="5"/><circle cx="15" cy="9" r="5"/><circle cx="12" cy="15" r="5"/>',
    heal: '<rect x="3" y="9" width="18" height="6" rx="3" transform="rotate(-45 12 12)"/><path d="M11 11h.01M13 13h.01M11 13h.01M13 11h.01"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
    compare: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 2v20"/>',
    more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
    move: '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
  });

  // The shared font list lives in Core (the Layer panel uses it too); this is the fallback.
  const FONTS_FALLBACK = Object.freeze([
    ['Inter, system-ui, sans-serif', 'Modern'],
    ['Arial, Helvetica, sans-serif', 'Arial'],
    ['"Arial Black", Impact, sans-serif', 'Heavy'],
    ['"Trebuchet MS", Arial, sans-serif', 'Trebuchet'],
    ['Georgia, "Times New Roman", serif', 'Georgia'],
    ['"Times New Roman", Times, serif', 'Times'],
    ['"Palatino Linotype", Palatino, Georgia, serif', 'Palatino'],
    ['"SFMono-Regular", Consolas, monospace', 'Mono'],
    ['"Courier New", Courier, monospace', 'Courier'],
    ['Impact, "Arial Black", sans-serif', 'Impact'],
    ['"Brush Script MT", cursive', 'Script'],
    ['cursive', 'Cursive'],
  ]);

  function install(editor) {
    const Core = globalThis.AlcorPhotoCore;
    const Studio = globalThis.AlcorPhotoStudio;
    const root = editor.root;
    if (!Core || !Studio || !root || root.querySelector('[data-ap-creator]')) return;

    const el = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const svg = (name) =>
      `<svg viewBox="0 0 24 24" width="25" height="25" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.shape}</svg>`;
    const selected = () => editor.selected();
    const store = () => editor.store;
    const project = () => editor.store.project;
    const status = (message, level) => editor.status(message, level);
    const guard = (fn) => {
      try {
        const result = fn();
        if (result && typeof result.catch === 'function')
          result.catch((error) => status(error.message, 'error'));
        return result;
      } catch (error) {
        status(error.message, 'error');
        return null;
      }
    };

    const creator = el('section', 'ap-creator');
    creator.dataset.apCreator = 'true';
    creator.setAttribute('aria-label', 'Creator tools');
    const rail = el('nav', 'ap-creator-rail');
    rail.setAttribute('aria-label', 'Create and edit');
    const sheet = el('div', 'ap-creator-sheet');
    sheet.hidden = true;
    creator.append(rail, sheet);

    const tabs = root.querySelector('.ap-mobile-tabs');
    const grid = root.querySelector('.ap-grid');
    if (tabs) tabs.after(creator);
    else grid?.before(creator);

    function railButton(label, iconName, run, accent = false, sheetKind = null) {
      const node = el('button', `ap-creator-button${accent ? ' is-accent' : ''}`);
      if (sheetKind) node.dataset.sheet = sheetKind;
      node.type = 'button';
      node.innerHTML = `${svg(iconName)}<span>${label}</span>`;
      node.setAttribute('aria-label', label);
      node.addEventListener('click', () => guard(run));
      rail.append(node);
      return node;
    }

    function sheetButton(label, run, className = '') {
      const node = el('button', `ap-creator-chip ${className}`.trim(), label);
      node.type = 'button';
      node.addEventListener('click', () => guard(run));
      return node;
    }

    function heading(title) {
      const head = el('div', 'ap-creator-sheet-head');
      head.append(el('strong', '', title));
      sheet.setAttribute('role', 'region');
      sheet.setAttribute('aria-label', title);
      const close = el('button', 'ap-creator-sheet-close', '×');
      close.type = 'button';
      close.setAttribute('aria-label', `Close ${title}`);
      close.addEventListener('click', closeSheet);
      head.append(close);
      sheet.append(head);
    }

    function closeSheet() {
      markActive(null);
      if (typeof clearRemovePaint === 'function' && removeBrush?.active) clearRemovePaint();
      if (!sheet.hidden) {
        leaveSheetTool(null);
        status('Ready');
      }
      sheet.hidden = true;
      sheet.replaceChildren();
      creator.removeAttribute('data-sheet');
      placeSheet();
    }

    // Crop and Text put the canvas in their own tool. Moving on to anything else ends it, so a drag on the
    // photo never crops or adds text while another tool's panel is showing. An unapplied crop box is dropped.
    function leaveSheetTool(nextKind) {
      if (
        (Studio.state.tool === 'crop' && nextKind !== 'crop') ||
        (Studio.state.tool === 'type' && nextKind !== 'text')
      )
        Studio.setTool('move');
    }

    // On desktop the tray docks over the side column, so the whole picture stays in view while a tool is open.
    // The columns change with the window, so measure the column rather than assume its size.
    function placeSheet() {
      const side = root.querySelector('.ap-sidebar');
      if (sheet.hidden || !side || getComputedStyle(sheet).position !== 'absolute') {
        for (const name of ['--ap-sheet-top', '--ap-sheet-width', '--ap-sheet-height'])
          creator.style.removeProperty(name);
        return;
      }
      const box = side.getBoundingClientRect();
      creator.style.setProperty(
        '--ap-sheet-top',
        `${Math.round(box.top - creator.getBoundingClientRect().top - creator.clientTop)}px`,
      );
      creator.style.setProperty('--ap-sheet-width', `${Math.round(box.width)}px`);
      creator.style.setProperty('--ap-sheet-height', `${Math.round(box.height)}px`);
    }
    globalThis.addEventListener?.('resize', placeSheet);
    const sheetDock = root.querySelector('.ap-sidebar');
    if (sheetDock && typeof ResizeObserver === 'function')
      new ResizeObserver(placeSheet).observe(sheetDock);

    function markActive(kind) {
      for (const button of rail.querySelectorAll('.ap-creator-button')) {
        if (button.dataset.sheet && button.dataset.sheet === kind)
          button.setAttribute('aria-current', 'true');
        else button.removeAttribute('aria-current');
      }
    }
    // Paint the slider's filled span from its neutral point (0, or the minimum) to the value.
    function paintRange(input) {
      const min = Number(input.min),
        max = Number(input.max),
        v = Number(input.value),
        zero = min < 0 && max > 0 ? 0 : min;
      const pos = (x) => `${((x - min) / (max - min || 1)) * 100}%`;
      input.style.setProperty('--fill-from', pos(Math.min(zero, v)));
      input.style.setProperty('--fill-to', pos(Math.max(zero, v)));
    }
    sheet.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || sheet.hidden) return;
      event.stopPropagation();
      const opener = rail.querySelector(`[data-sheet="${creator.dataset.sheet}"]`);
      closeSheet();
      opener?.focus({ preventScroll: true });
    });
    sheet.addEventListener('input', (event) => {
      if (event.target.matches?.('input[type="range"]')) paintRange(event.target);
    });
    new MutationObserver(() => {
      for (const input of sheet.querySelectorAll('input[type="range"]')) paintRange(input);
    }).observe(sheet, { childList: true, subtree: true });
    function openSheet(kind) {
      markActive(kind);
      if (kind !== 'remove' && removeBrush?.active) clearRemovePaint();
      leaveSheetTool(kind);
      status('Ready');
      sheet.replaceChildren();
      sheet.hidden = false;
      creator.dataset.sheet = kind;
      if (kind === 'remove') armRemovePainting(); // a drag on the photo must paint, not move the layer
      if (kind === 'crop') {
        Studio.state.crop.ratio = 'free';
        Studio.setTool('crop');
        status('Drag the box or its corners on the photo, then Apply crop.');
      }
      renderSheet(kind);
      placeSheet();
      // Keyboard users land in the sheet; touch users keep their place on the tray.
      if (!globalThis.matchMedia?.('(pointer: coarse)').matches)
        sheet
          .querySelector('button:not(.ap-creator-sheet-close), input, select, textarea')
          ?.focus({ preventScroll: true });
    }

    function mobilePanel(name) {
      root.querySelector(`[data-panel-target="${name}"]`)?.click();
    }

    function patchSelected(patch, label) {
      const layer = selected();
      if (!layer) throw new Error('Select a layer first.');
      store().replace(Core.updateLayer(project(), layer.id, patch), label);
      return project().layers.find((item) => item.id === layer.id);
    }

    function addText(text) {
      const value = String(text || 'Tap to edit').trim() || 'Tap to edit';
      const next = Core.addTextLayer(project(), {
        text: value,
        fontFamily: Studio.state.type.fontFamily,
        fontSize: Studio.state.type.fontSize,
        fontWeight: Studio.state.type.fontWeight,
        italic: Studio.state.type.italic,
        lineHeight: Studio.state.type.lineHeight,
        letterSpacing: Studio.state.type.letterSpacing,
        color: Studio.state.fg,
      });
      store().replace(next, 'Add text');
      Studio.setTool('type');
      mobilePanel('layer');
      Studio.showPanel('properties');
      renderSheet('text');
    }

    function addShape(shape) {
      const next = Core.addShapeLayer(project(), {
        shape,
        fill: Studio.state.fg,
        stroke: Studio.state.bg,
        strokeWidth: shape === 'line' ? 10 : 4,
        cornerRadius: shape === 'rounded-rectangle' || shape === 'speech-bubble' ? 42 : undefined,
      });
      store().replace(next, `Add ${shape.replaceAll('-', ' ')}`);
      Studio.setTool('move');
      mobilePanel('layer');
      Studio.showPanel('properties');
      renderSheet('shapes');
    }

    function colorControl(label, value, run) {
      const wrap = el('label', 'ap-creator-color');
      wrap.append(el('span', '', label));
      const input = el('input');
      input.type = 'color';
      input.value = value;
      input.addEventListener('input', () => guard(() => run(input.value)));
      wrap.append(input);
      return wrap;
    }

    function rangeControl(label, value, min, max, step, run) {
      const wrap = el('label', 'ap-creator-range');
      const cap = el('span');
      const name = el('span', '', label);
      const out = el('output', '', String(value));
      cap.append(name, out);
      const input = el('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(value);
      input.addEventListener('input', () => {
        out.textContent = input.value;
      });
      input.addEventListener('change', () => guard(() => run(Number(input.value))));
      wrap.append(cap, input);
      return wrap;
    }

    // ---------------------------------------------------------------- Develop (Basic edits)
    const Px = globalThis.AlcorPhotoPixels;
    const BASIC_NAME = 'Basic edits';
    let adjustGroup = 'light';
    const DEVELOP_GROUPS = Object.freeze({
      light: [
        ['exposure', 'Exposure'],
        ['contrast', 'Contrast'],
        ['highlights', 'Highlights'],
        ['shadows', 'Shadows'],
        ['whites', 'Whites'],
        ['blacks', 'Blacks'],
      ],
      color: [
        ['temperature', 'Warmth'],
        ['tint', 'Tint'],
        ['vibrance', 'Vibrance'],
        ['saturation', 'Saturation'],
      ],
      effects: [
        ['clarity', 'Clarity'],
        ['vignette', 'Vignette'],
        ['fade', 'Fade', 0, 100],
        ['grain', 'Grain', 0, 100],
      ],
    });
    const LOOKS = Object.freeze([
      ['Original', {}],
      ['Vivid', { contrast: 18, vibrance: 40, saturation: 8, clarity: 12 }],
      ['Warm', { temperature: 35, vibrance: 12, highlights: -10 }],
      ['Cool', { temperature: -30, tint: 6, contrast: 8 }],
      [
        'Golden',
        {
          temperature: 40,
          exposure: 6,
          shadows: 18,
          splitHighlightHue: 42,
          splitHighlightAmount: 45,
          vignette: -18,
        },
      ],
      [
        'Teal & orange',
        {
          contrast: 14,
          splitShadowHue: 190,
          splitShadowAmount: 60,
          splitHighlightHue: 32,
          splitHighlightAmount: 55,
          vibrance: 10,
        },
      ],
      ['Matte', { fade: 45, contrast: -12, saturation: -10, shadows: 10 }],
      [
        'Film',
        {
          fade: 25,
          grain: 35,
          temperature: 10,
          saturation: -8,
          splitShadowHue: 200,
          splitShadowAmount: 25,
        },
      ],
      ['Mono', { saturation: -100, contrast: 15 }],
      ['Noir', { saturation: -100, contrast: 45, blacks: -30, vignette: -45, grain: 20 }],
      ['Faded', { fade: 60, saturation: -25, exposure: 5 }],
      [
        'Drama',
        { contrast: 35, clarity: 40, highlights: -35, shadows: 25, vignette: -35, saturation: -10 },
      ],
      ['Bright', { exposure: 18, shadows: 25, highlights: -15, vibrance: 15 }],
      [
        'Moody',
        {
          exposure: -10,
          contrast: 20,
          highlights: -30,
          temperature: -12,
          saturation: -20,
          vignette: -40,
        },
      ],
    ]);
    function developLayer() {
      return (
        project().layers.find(
          (layer) =>
            layer.type === 'adjustment' && layer.kind === 'develop' && layer.name === BASIC_NAME,
        ) || null
      );
    }
    function developProject(params) {
      const layer = developLayer();
      if (layer) return Core.updateLayer(project(), layer.id, { params });
      if (!project().layers.length) throw new Error('Open a photo first.');
      let next = Core.addAdjustmentLayer(project(), 'develop', params, { name: BASIC_NAME });
      const id = next.selectedLayerId;
      next = Core.moveLayerTo(next, id, next.layers.length - 1);
      return next;
    }
    function setDevelop(params, label, rerender = false) {
      const keepSelected = project().selectedLayerId;
      const next = developProject(params);
      if (keepSelected && next.layers.some((layer) => layer.id === keepSelected))
        next.selectedLayerId = keepSelected;
      store().replace(next, label);
      if (rerender) renderSheet(creator.dataset.sheet || 'adjust');
    }
    // A range whose drag previews live and commits once on release.
    function liveRange(label, value, min, max, preview, commit) {
      const wrap = el('label', 'ap-creator-range');
      const cap = el('span');
      const out = el('output', '', String(value));
      cap.append(el('span', '', label), out);
      const input = el('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = '1';
      input.value = String(value);
      input.addEventListener('input', () => {
        out.textContent = input.value;
        guard(() => editor.previewProject(developProject(preview(Number(input.value)))));
      });
      input.addEventListener('change', () => guard(() => commit(preview(Number(input.value)))));
      input.addEventListener('dblclick', () => {
        input.value = '0';
        input.dispatchEvent(new Event('input'));
        input.dispatchEvent(new Event('change'));
      });
      wrap.append(cap, input);
      return wrap;
    }
    // The picture without the Basic edits layer, at a small size.
    function smallComposite(size) {
      const p = project();
      if (!p.layers.length) return null;
      const base = { ...p, layers: p.layers.filter((layer) => layer !== developLayer()) };
      const scale = Math.min(1, size / Math.max(p.crop.width, p.crop.height));
      const canvas = el('canvas');
      canvas.width = Math.max(1, Math.round(p.crop.width * scale));
      canvas.height = Math.max(1, Math.round(p.crop.height * scale));
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      Core.renderProject(ctx, base, editor.resolveSource, { scale, adjust: editor.adjust });
      return {
        width: canvas.width,
        height: canvas.height,
        data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
      };
    }
    // Auto: one tap from image statistics (exposure, endpoints, cast, color).
    function autoEnhance() {
      const img = smallComposite(256);
      if (!img) throw new Error('Open a photo first.');
      const lums = [];
      let sr = 0,
        sg = 0,
        sb = 0,
        n = 0,
        satSum = 0;
      for (let i = 0; i < img.data.length; i += 4) {
        if (img.data[i + 3] < 128) continue;
        const r = img.data[i],
          g = img.data[i + 1],
          b = img.data[i + 2];
        lums.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
        sr += r;
        sg += g;
        sb += b;
        n += 1;
        const max = Math.max(r, g, b);
        satSum += max ? (max - Math.min(r, g, b)) / max : 0;
      }
      if (!n) throw new Error('The picture is fully transparent.');
      lums.sort((a, b) => a - b);
      const q = (f) => lums[Math.min(lums.length - 1, Math.floor(f * lums.length))] / 255;
      const lo = q(0.01),
        mid = q(0.5),
        hi = q(0.99);
      const clampP = (v) => Math.round(Math.max(-45, Math.min(45, v)));
      const params = { ...Px.ADJUSTMENT_DEFAULTS.develop };
      params.exposure = clampP(Math.log2(0.46 / Math.max(0.04, mid)) * 35);
      params.blacks = clampP(-lo * 260);
      params.whites = clampP((1 - hi) * 260);
      params.highlights = clampP(hi > 0.97 ? -25 : 0);
      params.shadows = clampP(lo < 0.06 ? 20 : 8);
      params.contrast = clampP((0.62 - (hi - lo)) * 60);
      const cast = (sb - sr) / n / 255;
      params.temperature = clampP(cast * 160);
      params.tint = clampP((((sr + sb) / 2 - sg) / n / 255) * -120);
      params.vibrance = clampP(satSum / n < 0.35 ? 25 : 10);
      setDevelop(params, 'Auto enhance', !sheet.hidden);
      status('Auto enhance applied. Fine-tune in Adjust, or hold ◫ to compare.');
    }

    // ---------------------------------------------------------------- Remove brush
    // Paint a project-space mask over the photo; Remove fills it with Content-Aware Fill.
    const removeBrush = { size: 48, active: false, mask: null, overlay: null, last: null };
    function startRemovePainting() {
      const p = project();
      if (!p.layers.some((layer) => layer.type === 'image')) throw new Error('Open a photo first.');
      const viewport = root.querySelector('.ap-canvas-viewport');
      if (!removeBrush.mask || removeBrush.mask.length !== p.width * p.height)
        removeBrush.mask = new Uint8Array(p.width * p.height);
      if (!removeBrush.overlay) {
        const overlay = el('canvas', 'ap-remove-overlay');
        overlay.setAttribute('aria-label', 'Paint over what to remove');
        overlay.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          overlay.setPointerCapture(event.pointerId);
          removeBrush.last = null;
          paintRemove(event);
        });
        overlay.addEventListener('pointermove', (event) => {
          if (event.buttons) paintRemove(event);
        });
        overlay.addEventListener('pointerup', () => {
          removeBrush.last = null;
        });
        removeBrush.overlay = overlay;
      }
      viewport.append(removeBrush.overlay);
      removeBrush.active = true;
      sizeRemoveOverlay();
      status('Paint over what to remove, then tap Remove now.');
    }
    // The tray opens armed; with no photo yet it stays unarmed and the button reports why.
    function armRemovePainting() {
      if (removeBrush.active) return;
      try {
        startRemovePainting();
      } catch (error) {
        removeBrush.active = false;
      }
    }
    function sizeRemoveOverlay() {
      const overlay = removeBrush.overlay,
        viewport = overlay?.parentElement;
      if (!overlay || !viewport) return;
      const ratio = globalThis.devicePixelRatio || 1;
      overlay.width = Math.round(viewport.clientWidth * ratio);
      overlay.height = Math.round(viewport.clientHeight * ratio);
      drawRemoveOverlay();
    }
    // The painted area lives in a persistent project-size tint canvas; each stamp
    // updates only its own rectangle, and the overlay just redraws that canvas.
    function tintFor(p) {
      if (
        !removeBrush.tint ||
        removeBrush.tint.width !== p.width ||
        removeBrush.tint.height !== p.height
      ) {
        removeBrush.tint = el('canvas');
        removeBrush.tint.width = p.width;
        removeBrush.tint.height = p.height;
      }
      return removeBrush.tint;
    }
    function drawRemoveOverlay() {
      const overlay = removeBrush.overlay;
      if (!overlay || !removeBrush.mask) return;
      const ctx = overlay.getContext('2d');
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      const p = project(),
        rect = overlay.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const tl = editor.view.projectToClient(0, 0),
        br = editor.view.projectToClient(p.width, p.height);
      const sx = overlay.width / rect.width,
        sy = overlay.height / rect.height;
      ctx.drawImage(
        tintFor(p),
        (tl.x - rect.left) * sx,
        (tl.y - rect.top) * sy,
        (br.x - tl.x) * sx,
        (br.y - tl.y) * sy,
      );
    }
    function paintRemove(event) {
      const p = project(),
        mask = removeBrush.mask;
      const at = editor.view.clientToProject(event.clientX, event.clientY);
      const radius = removeBrush.size / 2 / Math.max(0.01, editor.view.zoom);
      const from = removeBrush.last || at;
      const steps = Math.max(
        1,
        Math.ceil(Math.hypot(at.x - from.x, at.y - from.y) / Math.max(1, radius / 3)),
      );
      const tc = tintFor(p).getContext('2d');
      tc.fillStyle = 'rgba(255,40,90,0.55)';
      for (let k = 1; k <= steps; k += 1) {
        const cx = from.x + ((at.x - from.x) * k) / steps,
          cy = from.y + ((at.y - from.y) * k) / steps;
        const x0 = Math.max(0, Math.floor(cx - radius)),
          x1 = Math.min(p.width - 1, Math.ceil(cx + radius));
        const y0 = Math.max(0, Math.floor(cy - radius)),
          y1 = Math.min(p.height - 1, Math.ceil(cy + radius));
        for (let y = y0; y <= y1; y += 1)
          for (let x = x0; x <= x1; x += 1)
            if ((x - cx) ** 2 + (y - cy) ** 2 <= radius * radius) mask[y * p.width + x] = 255;
        // Repaint the stamp's rectangle of the tint from the mask so overlaps never darken.
        if (x1 >= x0 && y1 >= y0) {
          const w = x1 - x0 + 1,
            h = y1 - y0 + 1,
            patch = tc.createImageData(w, h);
          for (let y = 0; y < h; y += 1)
            for (let x = 0; x < w; x += 1)
              if (mask[(y0 + y) * p.width + x0 + x]) {
                const o = (y * w + x) * 4;
                patch.data[o] = 255;
                patch.data[o + 1] = 40;
                patch.data[o + 2] = 90;
                patch.data[o + 3] = 140;
              }
          tc.putImageData(patch, x0, y0);
        }
      }
      if (!removeBrush.frame)
        removeBrush.frame = requestAnimationFrame(() => {
          removeBrush.frame = 0;
          drawRemoveOverlay();
        });
      removeBrush.last = at;
    }
    function clearRemovePaint() {
      removeBrush.mask = null;
      removeBrush.active = false;
      removeBrush.tint = null;
      removeBrush.overlay?.remove();
    }
    async function finishRemove() {
      const mask = removeBrush.mask;
      if (!mask || !mask.some((v) => v))
        throw new Error('Paint over what you want to remove first.');
      const target =
        project().layers.find(
          (layer) => layer.id === project().selectedLayerId && layer.type === 'image',
        ) || [...project().layers].reverse().find((layer) => layer.type === 'image');
      if (target && target.id !== project().selectedLayerId)
        store().replaceTransient({ ...project(), selectedLayerId: target.id }, 'Select photo');
      clearRemovePaint();
      // One history step: the fill runs on the painted mask, not on a committed selection.
      await Studio.contentAwareFill(mask);
      syncBasic(); // the busy state restored the pre-fill undo/redo flags
      if (creator.dataset.sheet === 'remove') renderSheet('remove');
    }

    function renderSheet(kind) {
      sheet.replaceChildren();

      if (kind === 'text') {
        heading('Text');
        const selectedLayer = selected();
        const textLayer = selectedLayer?.type === 'text' ? selectedLayer : null;
        const compose = el('div', 'ap-creator-compose');
        const input = el('textarea', 'ap-creator-text');
        input.rows = 2;
        input.maxLength = 2000;
        input.value = textLayer?.text || 'Tap to edit';
        input.setAttribute('aria-label', 'Text');
        const apply = sheetButton(
          textLayer ? 'Update text' : 'Add text',
          () => {
            if (selected()?.type === 'text') patchSelected({ text: input.value }, 'Change text');
            else addText(input.value);
          },
          'is-primary',
        );
        compose.append(input, apply);
        sheet.append(compose);

        const fonts = el('div', 'ap-creator-fonts');
        for (const [family, label] of Core.FONT_STACKS || FONTS_FALLBACK) {
          const chip = sheetButton(
            label,
            () => {
              Studio.state.type.fontFamily = family;
              const layer = selected();
              if (layer?.type === 'text') patchSelected({ fontFamily: family }, 'Change font');
              renderSheet('text');
            },
            'ap-font-chip',
          );
          chip.style.fontFamily = family;
          if (selected()?.type === 'text' && selected().fontFamily === family)
            chip.setAttribute('aria-pressed', 'true');
          fonts.append(chip);
        }
        sheet.append(fonts);

        const current = selected()?.type === 'text' ? selected() : null;
        const controls = el('div', 'ap-creator-controls');
        controls.append(
          colorControl('Color', current?.color || Studio.state.fg, (value) => {
            Studio.state.fg = value;
            Studio.setColor?.('fg', value);
            if (selected()?.type === 'text') patchSelected({ color: value }, 'Change text color');
          }),
          rangeControl('Outline', current?.strokeWidth || 0, 0, 32, 1, (value) => {
            if (selected()?.type !== 'text') throw new Error('Add or select text first.');
            patchSelected(
              { strokeWidth: value, stroke: current?.stroke || '#ffffff' },
              'Change text outline',
            );
          }),
          rangeControl(
            'Size',
            current?.fontSize || Studio.state.type.fontSize,
            8,
            300,
            1,
            (value) => {
              Studio.state.type.fontSize = value;
              if (selected()?.type === 'text')
                patchSelected({ fontSize: value }, 'Change text size');
            },
          ),
          sheetButton(current?.shadowColor ? 'Shadow on' : 'Shadow', () => {
            const layer = selected();
            if (layer?.type !== 'text') throw new Error('Add or select text first.');
            patchSelected(
              layer.shadowColor
                ? { shadowBlur: 0, shadowX: 0, shadowY: 0 }
                : { shadowColor: '#000000', shadowBlur: 14, shadowX: 5, shadowY: 7 },
              'Toggle text shadow',
            );
            renderSheet('text');
          }),
        );
        sheet.append(controls);
        return;
      }

      if (kind === 'shapes') {
        heading('Shapes');
        const chips = el('div', 'ap-creator-chips');
        for (const [shape, label] of [
          ['rectangle', 'Rectangle'],
          ['rounded-rectangle', 'Rounded'],
          ['ellipse', 'Circle'],
          ['line', 'Line'],
          ['arrow', 'Arrow'],
          ['star', 'Star'],
          ['heart', 'Heart'],
          ['speech-bubble', 'Bubble'],
        ])
          chips.append(sheetButton(label, () => addShape(shape)));
        sheet.append(chips);

        const current = selected()?.type === 'shape' ? selected() : null;
        const controls = el('div', 'ap-creator-controls');
        controls.append(
          colorControl('Fill', current?.fill || Studio.state.fg, (value) => {
            Studio.state.fg = value;
            if (selected()?.type === 'shape') patchSelected({ fill: value }, 'Change shape fill');
          }),
          colorControl('Stroke', current?.stroke || Studio.state.bg, (value) => {
            Studio.state.bg = value;
            if (selected()?.type === 'shape')
              patchSelected({ stroke: value }, 'Change shape stroke');
          }),
        );
        if (current)
          controls.append(
            rangeControl('Stroke width', current.strokeWidth, 0, 64, 1, (value) =>
              patchSelected({ strokeWidth: value }, 'Change shape stroke'),
            ),
          );
        sheet.append(controls);
        return;
      }

      if (kind === 'adjust') {
        heading('Adjust');
        const tabs = el('div', 'ap-creator-chips');
        for (const [group, label] of [
          ['light', 'Light'],
          ['color', 'Color'],
          ['effects', 'Effects'],
        ]) {
          const chip = sheetButton(label, () => {
            adjustGroup = group;
            renderSheet('adjust');
          });
          chip.setAttribute('aria-pressed', String(adjustGroup === group));
          tabs.append(chip);
        }
        tabs.append(
          sheetButton('Auto', autoEnhance),
          sheetButton('Reset', () =>
            setDevelop({ ...Px.ADJUSTMENT_DEFAULTS.develop }, 'Reset adjustments', true),
          ),
        );
        const currentDevelop = () => ({
          ...Px.ADJUSTMENT_DEFAULTS.develop,
          ...(developLayer()?.params || {}),
        });
        const params = currentDevelop();
        const controls = el('div', 'ap-creator-controls ap-develop-controls');
        for (const [key, label, min = -100, max = 100] of DEVELOP_GROUPS[adjustGroup]) {
          // Read the live params on every preview/commit so an undo made while a slider has focus is never written back.
          controls.append(
            liveRange(
              label,
              params[key],
              min,
              max,
              (value) => ({ ...currentDevelop(), [key]: value }),
              (next) =>
                setDevelop({ ...currentDevelop(), ...next }, `Adjust ${label.toLowerCase()}`),
            ),
          );
        }
        const more = el('div', 'ap-creator-chips');
        for (const [name, label] of [
          ['curves', 'Curves'],
          ['levels', 'Levels'],
          ['hue-saturation', 'Hue/Sat'],
          ['black-white', 'B&W'],
          ['color-balance', 'Color balance'],
        ])
          more.append(
            sheetButton(label, () => {
              Studio.addAdjustment(name);
              status(`${label} added as an editable layer. Fine-tune it in Advanced.`);
            }),
          );
        sheet.append(
          tabs,
          controls,
          el(
            'p',
            'ap-creator-note',
            'Edits stay in one editable "Basic edits" layer. Hold ◫ to compare.',
          ),
          more,
        );
        return;
      }

      if (kind === 'looks') {
        heading('Looks');
        const grid = el('div', 'ap-looks');
        const small = smallComposite(84);
        const current = developLayer()?.params || null;
        for (const [name, look] of LOOKS) {
          const chip = el('button', 'ap-look');
          chip.type = 'button';
          const canvas = el('canvas');
          if (small) {
            canvas.width = small.width;
            canvas.height = small.height;
            const out = Px.applyAdjustment(small, 'develop', look);
            canvas
              .getContext('2d')
              .putImageData(new ImageData(out.data, small.width, small.height), 0, 0);
          }
          chip.append(canvas, el('span', '', name));
          if (
            current &&
            JSON.stringify({ ...Px.ADJUSTMENT_DEFAULTS.develop, ...look }) ===
              JSON.stringify({ ...Px.ADJUSTMENT_DEFAULTS.develop, ...current })
          )
            chip.setAttribute('aria-pressed', 'true');
          chip.addEventListener('click', () =>
            guard(() => {
              setDevelop({ ...Px.ADJUSTMENT_DEFAULTS.develop, ...look }, `Look: ${name}`, true);
              renderSheet('looks');
            }),
          );
          grid.append(chip);
        }
        sheet.append(
          grid,
          el(
            'p',
            'ap-creator-note',
            'Looks set the Basic edits sliders, so you can fine-tune any look in Adjust.',
          ),
        );
        return;
      }

      if (kind === 'effects') {
        heading('Effects');
        const chips = el('div', 'ap-creator-chips');
        for (const [name, label, params] of [
          ['gaussian-blur', 'Blur', { radius: 4 }],
          ['sharpen', 'Sharpen', {}],
          ['pixelate', 'Mosaic', { cellSize: 12 }],
          ['add-noise', 'Noise', { amount: 10, distribution: 'gaussian', monochromatic: false }],
          ['emboss', 'Emboss', { angle: 135, height: 3, amount: 100 }],
          ['high-pass', 'High pass', { radius: 8 }],
        ])
          chips.append(sheetButton(label, () => Studio.applyFilter(name, params)));
        sheet.append(
          chips,
          el(
            'p',
            'ap-creator-note',
            'Effects are undoable. Adjustment tools stay editable as layers.',
          ),
        );
        return;
      }

      if (kind === 'remove') {
        heading('Remove objects');
        const controls = el('div', 'ap-creator-controls');
        controls.append(
          rangeControl('Brush size', removeBrush.size, 8, 200, 1, (value) => {
            removeBrush.size = value;
          }),
        );
        const actions = el('div', 'ap-creator-chips');
        actions.append(
          sheetButton(
            removeBrush.active ? 'Painting… tap Done' : 'Paint over it',
            () => {
              startRemovePainting();
              renderSheet('remove');
            },
            removeBrush.active ? '' : 'is-primary',
          ),
          sheetButton('Remove now', () => finishRemove(), removeBrush.active ? 'is-primary' : ''),
          sheetButton('Clear', () => {
            clearRemovePaint();
            armRemovePainting();
            renderSheet('remove');
          }),
        );
        sheet.append(
          controls,
          actions,
          el(
            'p',
            'ap-creator-note',
            'Paint over a person, object or blemish, then Remove now. The gap is filled from the rest of the photo, on this device. Undo if you want another try.',
          ),
        );
        return;
      }

      if (kind === 'crop') {
        heading('Crop & rotate');
        const ratios = el('div', 'ap-creator-chips');
        for (const [label, ratio] of [
          ['Free', 'free'],
          ['Original', 'original'],
          ['Square', '1:1'],
          ['4:5', '4:5'],
          ['9:16', '9:16'],
          ['16:9', '16:9'],
          ['3:2', '3:2'],
        ]) {
          const chip = sheetButton(label, () => {
            Studio.setCropRatio(ratio);
            for (const other of ratios.children)
              other.setAttribute('aria-pressed', String(other === chip));
            status(`Crop ${label}: drag the box or its corners on the photo, then Apply crop.`);
          });
          chip.setAttribute('aria-pressed', String(Studio.state.crop.ratio === ratio));
          ratios.append(chip);
        }
        const finish = el('div', 'ap-creator-chips');
        finish.append(
          sheetButton('Apply crop', () => Studio.applyCrop(), 'is-primary'),
          sheetButton('Reset', () => Studio.resetCrop()),
        );
        // A turn or flip changes the canvas under the box, so the tool starts over from the new frame.
        const turned = (run) => () => {
          run();
          Studio.setTool('crop');
        };
        const turn = el('div', 'ap-creator-chips');
        turn.append(
          sheetButton(
            'Rotate ↻',
            turned(() => Studio.rotateCanvas(90, 'Rotate 90° clockwise')),
          ),
          sheetButton(
            'Rotate ↺',
            turned(() => Studio.rotateCanvas(-90, 'Rotate 90° counter-clockwise')),
          ),
          sheetButton(
            'Flip ↔',
            turned(() => Studio.flipCanvas('horizontal')),
          ),
          sheetButton(
            'Flip ↕',
            turned(() => Studio.flipCanvas('vertical')),
          ),
        );
        sheet.append(ratios, finish, turn);
        return;
      }

      if (kind === 'export') {
        heading('Export');
        const format = root.querySelector('#ap-export-format');
        const quality = root.querySelector('#ap-export-quality');
        const scale = root.querySelector('#ap-export-scale');
        const formats = el('div', 'ap-creator-chips');
        const setFormat = (value) => {
          format.value = value;
          format.dispatchEvent(new Event('input', { bubbles: true }));
          format.dispatchEvent(new Event('change', { bubbles: true }));
          renderSheet('export');
        };
        const common = [
          ['jpeg', 'JPEG'],
          ['png', 'PNG'],
          ['webp', 'WebP'],
          ['avif', 'AVIF'],
          ['svg-layered', 'SVG'],
          ['pdf', 'PDF'],
          ['psd', 'PSD'],
        ];
        for (const [value, label] of common) {
          if (!format?.querySelector(`option[value="${value}"]`)) continue;
          const chip = sheetButton(label, () => setFormat(value));
          chip.setAttribute('aria-pressed', String(format.value === value));
          formats.append(chip);
        }
        const more = el('select', 'ap-creator-select');
        more.setAttribute('aria-label', 'More formats');
        for (const node of format ? format.children : []) more.append(node.cloneNode(true));
        more.value = format?.value || 'png';
        more.addEventListener('change', () => setFormat(more.value));
        formats.append(more);
        const sizes = el('div', 'ap-creator-chips');
        for (const option of scale
          ? [...scale.options].filter((item) => item.value !== 'width')
          : []) {
          const chip = sheetButton(option.textContent, () => {
            scale.value = option.value;
            scale.dispatchEvent(new Event('change', { bubbles: true }));
            renderSheet('export');
          });
          chip.setAttribute('aria-pressed', String(scale.value === option.value));
          sizes.append(chip);
        }
        const controls = el('div', 'ap-creator-controls');
        if (quality && /jpeg|webp|avif/.test(format?.value || '')) {
          controls.append(
            rangeControl('Quality', Number(quality.value), 10, 100, 1, (value) => {
              quality.value = String(value);
              quality.dispatchEvent(new Event('input', { bubbles: true }));
            }),
          );
        }
        const go = el('div', 'ap-creator-chips');
        go.append(
          sheetButton(
            'Download image',
            () => {
              root.querySelector('[data-action="export-image"]')?.click();
            },
            'is-primary',
          ),
          sheetButton('Save project', () =>
            root.querySelector('[data-action="save-browser"]')?.click(),
          ),
        );
        sheet.append(
          el('p', 'ap-creator-note', 'Format'),
          formats,
          el('p', 'ap-creator-note', 'Size'),
          sizes,
          controls,
          go,
          el('p', 'ap-creator-note', 'Exports are made on this device and are always free.'),
        );
        return;
      }

      if (kind === 'layers') {
        heading('Layers');
        const list = el('div', 'ap-basic-layers');
        const layers = [...project().layers].reverse();
        if (!layers.length)
          list.append(el('p', 'ap-creator-note', 'No layers yet. Open a photo or add text.'));
        for (const layer of layers) {
          const row = el('div', 'ap-basic-layer');
          if (layer.id === project().selectedLayerId) row.setAttribute('aria-current', 'true');
          const pick = el(
            'button',
            'ap-basic-layer-name',
            layer.type === 'adjustment' ? `${layer.name}` : layer.name,
          );
          pick.type = 'button';
          pick.addEventListener('click', () =>
            guard(() => {
              store().replace({ ...project(), selectedLayerId: layer.id }, 'Select layer');
              renderSheet('layers');
            }),
          );
          const eye = sheetButton(layer.visible ? 'Hide' : 'Show', () => {
            store().replace(
              Core.updateLayer(project(), layer.id, { visible: !layer.visible }),
              layer.visible ? 'Hide layer' : 'Show layer',
            );
            renderSheet('layers');
          });
          const up = sheetButton('↑', () => {
            store().replace(Core.moveLayer(project(), layer.id, 'up'), 'Raise layer');
            renderSheet('layers');
          });
          up.setAttribute('aria-label', `Move ${layer.name} up`);
          const down = sheetButton('↓', () => {
            store().replace(Core.moveLayer(project(), layer.id, 'down'), 'Lower layer');
            renderSheet('layers');
          });
          down.setAttribute('aria-label', `Move ${layer.name} down`);
          const remove = sheetButton('Delete', () => {
            store().replace(Core.removeLayer(project(), layer.id), 'Delete layer');
            renderSheet('layers');
          });
          row.append(pick, eye, up, down, remove);
          list.append(row);
        }
        sheet.append(list);
        return;
      }

      if (kind === 'remove-bg') {
        heading('Remove BG');
        const controls = el('div', 'ap-creator-controls');
        let sensitivity = 44,
          feather = 1;
        controls.append(
          rangeControl('Sensitivity', sensitivity, 12, 80, 1, (value) => {
            sensitivity = value;
          }),
          rangeControl('Edge softness', feather, 0, 5, 1, (value) => {
            feather = value;
          }),
        );
        const actions = el('div', 'ap-creator-chips');
        actions.append(
          sheetButton(
            'Remove background',
            async () => {
              await Studio.removeBackground({ sensitivity, feather });
              renderSheet('remove-bg');
            },
            'is-primary',
          ),
          sheetButton('Refine mask', () => {
            const layer = selected();
            if (!layer?.rasterMask) throw new Error('Remove the background first.');
            Studio.state.targetMask = true;
            Studio.setTool('brush');
            closeSheet();
            status('Refine mask: paint white to reveal. Switch foreground to black to hide.');
          }),
        );
        sheet.append(
          controls,
          actions,
          el(
            'p',
            'ap-creator-note',
            'Free and local: the photo never leaves this device. Best on distinct backgrounds; refine the mask for hair or complex scenes.',
          ),
        );
        return;
      }
    }

    const openImage = () => root.querySelector('#ap-image-file')?.click();
    railButton('Photo', 'image', openImage);
    railButton('Auto', 'auto', autoEnhance, true);
    railButton('Looks', 'looks', () => openSheet('looks'), false, 'looks');
    railButton('Adjust', 'tone', () => openSheet('adjust'), false, 'adjust');
    railButton('Crop', 'crop', () => openSheet('crop'), false, 'crop');
    railButton('Text', 'type', () => openSheet('text'), false, 'text');
    railButton('Remove BG', 'wand', () => openSheet('remove-bg'), true, 'remove-bg');
    railButton('Remove', 'erase', () => openSheet('remove'), true, 'remove');
    railButton('Heal', 'heal', () => {
      Studio.setTool('heal');
      closeSheet();
      status('Heal: tap or brush over a spot to remove it.');
    });
    railButton('Effects', 'effect', () => openSheet('effects'), false, 'effects');
    railButton('Shapes', 'shape', () => openSheet('shapes'), false, 'shapes');
    railButton('Draw', 'brush', () => {
      Studio.setTool('brush');
      closeSheet();
    });
    railButton('Layers', 'layers', () => openSheet('layers'), false, 'layers');
    railButton('Move', 'move', () => {
      Studio.setTool('move');
      closeSheet();
    });

    // ---------------------------------------------------------------- Basic mode shell
    // Phones get one slim bar, the photo, and the tool tray. Everything else is one
    // tap away in Advanced.
    const phoneQuery = globalThis.matchMedia?.('(max-width: 760px)');
    const syncPhone = () => {
      if (phoneQuery?.matches) root.dataset.phone = 'true';
      else delete root.dataset.phone;
    };
    syncPhone();
    phoneQuery?.addEventListener?.('change', syncPhone);

    const bar = el('div', 'ap-basic-bar');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Basic editing');
    const barButton = (label, iconName, run, className = '') => {
      const node = el('button', `ap-basic-button ${className}`.trim());
      node.type = 'button';
      node.innerHTML = iconName ? svg(iconName) : '';
      if (iconName) node.setAttribute('aria-label', label);
      else node.textContent = label;
      node.title = label;
      if (run) node.addEventListener('click', () => guard(run));
      return node;
    };
    const advanced = barButton(
      'Advanced',
      null,
      () => {
        closeSheet();
        const next = root.dataset.mode === 'advanced' ? 'essentials' : 'advanced';
        root.querySelector(`[data-mode-target="${next}"]`)?.click();
      },
      'ap-basic-pro',
    );
    new MutationObserver(() => {
      advanced.textContent = root.dataset.mode === 'advanced' ? '← Basic' : 'Advanced';
      requestAnimationFrame(() => editor.view.fit('fit'));
    }).observe(root, { attributes: true, attributeFilter: ['data-mode', 'data-phone'] });
    const undo = barButton('Undo', 'undo', () => store().undo());
    const redo = barButton('Redo', 'redo', () => store().redo());
    const compare = barButton('Hold to compare with the original', 'compare', null);
    const exportButton = barButton('Export', null, () => openSheet('export'), 'ap-basic-export');
    const spacer = el('span', 'ap-basic-spacer');
    bar.append(advanced, spacer, undo, redo, compare, exportButton);
    // On a phone the editor fills the screen, so this is the way back to the site.
    const homeMark = root.ownerDocument.querySelector('.apx-wordmark__mark');
    if (homeMark) {
      const home = el('a', 'ap-basic-home');
      home.href = '/';
      home.setAttribute('aria-label', 'Alcor Industries home');
      home.append(homeMark.cloneNode(true));
      bar.prepend(home);
    }
    const main = root.querySelector('.ap-app');
    main?.prepend(bar);

    // Compare: hold to see the photo as it was opened.
    let baseline = null;
    const showOriginal = (event) => {
      if (!baseline) {
        status('Nothing to compare yet.');
        return;
      }
      event.preventDefault();
      compare.setAttribute('aria-pressed', 'true');
      editor.previewProject(baseline);
    };
    const showEdited = () => {
      if (compare.getAttribute('aria-pressed') !== 'true') return;
      compare.setAttribute('aria-pressed', 'false');
      editor.requestRender();
    };
    compare.addEventListener('pointerdown', showOriginal);
    for (const type of ['pointerup', 'pointerleave', 'pointercancel'])
      compare.addEventListener(type, showEdited);
    compare.addEventListener('keydown', (event) => {
      if (event.key === ' ' || event.key === 'Enter') showOriginal(event);
    });
    compare.addEventListener('keyup', showEdited);

    // A new store means New, Open or a layered import: forget the old compare
    // baseline and painted area, and refresh undo/redo for the new history.
    editor.onStore((current) => {
      baseline = null;
      if (removeBrush.active) clearRemovePaint();
      current.on?.('change', syncBasic);
      queueMicrotask(syncBasic);
    });
    function syncBasic() {
      const p = project();
      const hasLayers = p.layers.length > 0;
      if (!hasLayers) baseline = null;
      else if (!baseline && p.layers.some((layer) => layer.type === 'image')) baseline = p;
      const history = store().state?.() || {};
      undo.disabled = !history.canUndo;
      redo.disabled = !history.canRedo;
      if (!sheet.hidden && creator.dataset.sheet === 'layers') renderSheet('layers');
      // Undo/redo can change the Basic edits; refresh the sliders so a later drag never writes stale values back.
      if (
        !sheet.hidden &&
        creator.dataset.sheet === 'adjust' &&
        !creator.contains(document.activeElement)
      )
        renderSheet('adjust');
    }
    syncBasic();

    root.addEventListener('alcorphoto:view', () => {
      if (
        !sheet.hidden &&
        (creator.dataset.sheet === 'text' || creator.dataset.sheet === 'shapes')
      ) {
        // Keep current controls in sync after a layer selection without forcing a reflow every frame.
        creator.dataset.selectedLayer = project().selectedLayerId || '';
      }
    });
  }
})();
