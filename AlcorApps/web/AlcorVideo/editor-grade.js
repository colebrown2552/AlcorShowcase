/* alcor-video-grade-ui */
(() => {
  'use strict';

  // Curves, LUT, vibrance and scopes panels. Edits go to the editor as events
  // ('alcorvideo:grade-patch', 'alcorvideo:lut-import'); the editor owns state and undo.
  const root = document.querySelector('[data-alcor-video-editor]');
  const grade = window.AlcorVideoGrade;
  if (!root || !grade) return;

  const form = root.querySelector('#av-clip-inspector');
  const anchor = form
    ? Array.from(form.children).find((child) => child.classList?.contains('av-inspector-actions'))
    : null;
  let state = { kind: '', vibrance: 0, curves: null, lut: null, luts: [] };
  let channel = 'master';
  let dragging = null;

  function send(patch, label, live = false) {
    root.dispatchEvent(
      new CustomEvent('alcorvideo:grade-patch', { detail: { patch, label, live } }),
    );
  }

  if (form && anchor && !form.querySelector('[data-av-grade-section]')) {
    const section = document.createElement('fieldset');
    section.className = 'av-grade-section av-field-wide';
    section.dataset.avGradeSection = '';
    section.dataset.afPanel = 'color';
    section.dataset.afLabel = 'Color';
    section.hidden = true;
    const legend = document.createElement('legend');
    legend.textContent = 'Curves · LUT · vibrance';

    const vibranceLabel = document.createElement('label');
    vibranceLabel.className = 'av-color-field';
    vibranceLabel.textContent = 'Vibrance';
    const vibrance = document.createElement('input');
    vibrance.type = 'number';
    vibrance.name = 'vibrance';
    vibrance.min = '-100';
    vibrance.max = '100';
    vibrance.step = '1';
    vibrance.value = '0';
    vibranceLabel.append(vibrance);

    const channelLabel = document.createElement('label');
    channelLabel.className = 'av-color-field';
    channelLabel.textContent = 'Curve';
    const channelSelect = document.createElement('select');
    channelSelect.dataset.avCurveChannel = '';
    for (const [value, text] of [
      ['master', 'RGB (master)'],
      ['red', 'Red'],
      ['green', 'Green'],
      ['blue', 'Blue'],
    ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      channelSelect.append(option);
    }
    channelLabel.append(channelSelect);

    const canvas = document.createElement('canvas');
    canvas.className = 'av-curve-canvas';
    canvas.width = 220;
    canvas.height = 220;
    canvas.tabIndex = 0;
    canvas.dataset.avCurveEditor = '';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute(
      'aria-label',
      'Tone curve. Click to add a point, drag to move it, double-click a point to remove it.',
    );

    const curveActions = document.createElement('div');
    curveActions.className = 'av-inline-actions';
    const resetCurve = document.createElement('button');
    resetCurve.type = 'button';
    resetCurve.dataset.avCurveReset = '';
    resetCurve.textContent = 'Reset curve';
    curveActions.append(resetCurve);

    const lutLabel = document.createElement('label');
    lutLabel.className = 'av-file-button av-lut-button';
    lutLabel.textContent = 'Load .cube LUT';
    const lutInput = document.createElement('input');
    lutInput.type = 'file';
    lutInput.accept = '.cube,text/plain';
    lutInput.dataset.avLutInput = '';
    lutLabel.append(lutInput);
    const lutName = document.createElement('span');
    lutName.className = 'av-lut-name';
    lutName.dataset.avLutName = '';
    lutName.textContent = 'No LUT';
    const intensityLabel = document.createElement('label');
    intensityLabel.className = 'av-color-field';
    intensityLabel.textContent = 'LUT intensity %';
    const intensity = document.createElement('input');
    intensity.type = 'range';
    intensity.min = '0';
    intensity.max = '100';
    intensity.step = '1';
    intensity.value = '100';
    intensity.dataset.avLutIntensity = '';
    intensityLabel.append(intensity);
    const removeLut = document.createElement('button');
    removeLut.type = 'button';
    removeLut.dataset.avLutRemove = '';
    removeLut.textContent = 'Remove LUT';
    const lutRow = document.createElement('div');
    lutRow.className = 'av-inline-actions';
    lutRow.append(lutLabel, removeLut);

    const status = document.createElement('p');
    status.className = 'av-grade-status';
    status.dataset.avGradeStatus = '';
    status.setAttribute('role', 'status');
    status.textContent = 'Curves and LUTs render with WebGL2 in preview and export.';

    section.append(
      legend,
      vibranceLabel,
      channelLabel,
      canvas,
      curveActions,
      lutName,
      lutRow,
      intensityLabel,
      status,
    );
    anchor.before(section);
  }

  const section = root.querySelector('[data-av-grade-section]');
  const canvas = root.querySelector('[data-av-curve-editor]');

  function points() {
    const curve = state.curves && state.curves[channel];
    return curve
      ? curve.map((point) => ({ ...point }))
      : [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ];
  }

  function drawCurve(list = points()) {
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context || typeof context.clearRect !== 'function') return;
    const { width, height } = canvas;
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#070a0f';
    context.fillRect(0, 0, width, height);
    context.strokeStyle = 'rgba(255,255,255,.08)';
    for (let index = 1; index < 4; index += 1) {
      context.beginPath();
      context.moveTo((index * width) / 4, 0);
      context.lineTo((index * width) / 4, height);
      context.stroke();
      context.beginPath();
      context.moveTo(0, (index * height) / 4);
      context.lineTo(width, (index * height) / 4);
      context.stroke();
    }
    const colors = { master: '#e8eef6', red: '#ff6b6b', green: '#5fe39a', blue: '#6aa2ff' };
    const table = grade.curveTable(list, 256);
    context.strokeStyle = colors[channel];
    context.lineWidth = 2;
    context.beginPath();
    for (let index = 0; index < 256; index += 1) {
      const x = (index / 255) * width;
      const y = (1 - table[index]) * height;
      if (index) context.lineTo(x, y);
      else context.moveTo(x, y);
    }
    context.stroke();
    context.fillStyle = colors[channel];
    for (const point of list) {
      context.beginPath();
      context.arc(point.x * width, (1 - point.y) * height, 5, 0, Math.PI * 2);
      context.fill();
    }
  }

  function pointerPosition(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width))),
      y: Math.min(1, Math.max(0, 1 - (event.clientY - rect.top) / Math.max(1, rect.height))),
    };
  }

  function nearest(list, position) {
    let best = -1;
    let distance = 0.06;
    list.forEach((point, index) => {
      const next = Math.hypot(point.x - position.x, point.y - position.y);
      if (next < distance) {
        distance = next;
        best = index;
      }
    });
    return best;
  }

  function curvesWith(list) {
    return { ...(state.curves || {}), [channel]: list };
  }

  canvas?.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !state.kind) return;
    event.preventDefault();
    const list = points();
    const position = pointerPosition(event);
    let index = nearest(list, position);
    if (index < 0) {
      if (list.length >= grade.LIMITS.maxCurvePoints) return;
      list.push(position);
      list.sort((a, b) => a.x - b.x);
      index = list.indexOf(position);
    }
    dragging = { list, index };
    canvas.setPointerCapture?.(event.pointerId);
    send({ curves: curvesWith(list) }, 'Curve point', true);
    drawCurve(list);
  });
  canvas?.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const position = pointerPosition(event);
    const { list, index } = dragging;
    const lower = index > 0 ? list[index - 1].x + 0.01 : 0;
    const upper = index < list.length - 1 ? list[index + 1].x - 0.01 : 1;
    list[index] = { x: Math.min(upper, Math.max(lower, position.x)), y: position.y };
    send({ curves: curvesWith(list) }, 'Curve point', true);
    drawCurve(list);
  });
  const finishDrag = () => {
    if (!dragging) return;
    const { list } = dragging;
    dragging = null;
    send({ curves: curvesWith(list) }, 'Curve adjusted');
  };
  canvas?.addEventListener('pointerup', finishDrag);
  canvas?.addEventListener('pointercancel', finishDrag);
  canvas?.addEventListener('dblclick', (event) => {
    const list = points();
    const index = nearest(list, pointerPosition(event));
    if (index <= 0 || index >= list.length - 1 || list.length <= 2) return;
    list.splice(index, 1);
    send({ curves: curvesWith(list) }, 'Curve point removed');
  });
  canvas?.addEventListener('keydown', (event) => {
    // Keyboard: arrow keys lift or lower the midtones of the active curve.
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    event.stopPropagation();
    const list = points();
    let index = list.findIndex((point) => Math.abs(point.x - 0.5) < 0.02);
    if (index < 0) {
      list.push({ x: 0.5, y: grade.curveTable(list, 256)[128] });
      list.sort((a, b) => a.x - b.x);
      index = list.findIndex((point) => point.x === 0.5);
    }
    list[index] = {
      x: 0.5,
      y: Math.min(1, Math.max(0, list[index].y + (event.key === 'ArrowUp' ? 0.02 : -0.02))),
    };
    send({ curves: curvesWith(list) }, 'Curve adjusted');
  });

  root.addEventListener('change', async (event) => {
    const target = event.target;
    if (target.matches?.('[data-av-curve-channel]')) {
      channel = target.value;
      drawCurve();
      return;
    }
    if (target.matches?.('[data-av-lut-intensity]')) {
      if (state.lut)
        send({ lut: { id: state.lut.id, intensity: Number(target.value) } }, 'LUT intensity');
      return;
    }
    if (!target.matches?.('[data-av-lut-input]')) return;
    const file = target.files?.[0];
    target.value = '';
    if (!file) return;
    const status = root.querySelector('[data-av-grade-status]');
    try {
      if (file.size > grade.LIMITS.maxLutFileBytes)
        throw new Error('The LUT file is too large (8 MB limit).');
      const lut = grade.parseCube(await file.text());
      root.dispatchEvent(
        new CustomEvent('alcorvideo:lut-import', {
          detail: {
            name: lut.title || file.name.replace(/\.cube$/i, ''),
            size: lut.size,
            data: grade.encodeLut(lut),
          },
        }),
      );
    } catch (error) {
      if (status) status.textContent = `LUT not loaded: ${error.message}`;
    }
  });
  root.addEventListener('input', (event) => {
    if (event.target.matches?.('[data-av-lut-intensity]') && state.lut)
      send(
        { lut: { id: state.lut.id, intensity: Number(event.target.value) } },
        'LUT intensity',
        true,
      );
  });
  root.addEventListener('click', (event) => {
    if (event.target.closest?.('[data-av-curve-reset]')) {
      const curves = { ...(state.curves || {}) };
      delete curves[channel];
      send({ curves }, 'Curve reset');
    } else if (event.target.closest?.('[data-av-lut-remove]')) {
      send({ lut: null }, 'LUT removed');
    }
  });

  root.addEventListener('alcorvideo:grade-state', (event) => {
    state = { ...state, ...(event.detail || {}) };
    const visual = state.kind === 'video' || state.kind === 'image';
    if (section) section.hidden = !visual;
    if (!visual) return;
    const vibrance = form?.elements?.namedItem?.('vibrance');
    if (vibrance && document.activeElement !== vibrance)
      vibrance.value = String(state.vibrance || 0);
    const name = root.querySelector('[data-av-lut-name]');
    if (name)
      name.textContent = state.lut ? `LUT: ${state.lut.name} (${state.lut.size}³)` : 'No LUT';
    const intensity = root.querySelector('[data-av-lut-intensity]');
    if (intensity) {
      intensity.disabled = !state.lut;
      if (state.lut) intensity.value = String(state.lut.intensity);
    }
    const remove = root.querySelector('[data-av-lut-remove]');
    if (remove) remove.disabled = !state.lut;
    if (!dragging) drawCurve();
    const status = root.querySelector('[data-av-grade-status]');
    if (status && event.detail?.message) status.textContent = event.detail.message;
  });

  // ------------------------------------------- color wheels, HSL secondary, vignette
  // Lumetri-style: Shadows (lift), Midtones (gamma) and Highlights (gain) wheels with a
  // level slider each; an HSL qualifier with hue/saturation/luma corrections; and the
  // Lumetri vignette, which is the clip's Vignette effect.

  const WHEEL_LABELS = { lift: 'Shadows', gamma: 'Midtones', gain: 'Highlights' };
  const HSL_FIELDS = [
    ['hue', 'Hue', 0, 360, 1],
    ['hueRange', 'Hue range', 0, 180, 1],
    ['softness', 'Softness', 0, 100, 1],
    ['satMin', 'Sat min', 0, 100, 1],
    ['satMax', 'Sat max', 0, 100, 1],
    ['lumMin', 'Luma min', 0, 100, 1],
    ['lumMax', 'Luma max', 0, 100, 1],
    ['hueShift', 'Hue shift', -180, 180, 1],
    ['saturation', 'Saturation', -100, 100, 1],
    ['luma', 'Luma', -100, 100, 1],
  ];
  let wheelDrag = null;

  function wheelsValue() {
    return JSON.parse(JSON.stringify(state.wheels || {}));
  }

  if (section && grade.WHEELS && !section.querySelector('[data-av-wheels]')) {
    const block = document.createElement('div');
    block.className = 'av-wheels';
    block.dataset.avWheels = '';
    const title = document.createElement('strong');
    title.textContent = 'Color wheels';
    block.append(title);
    const row = document.createElement('div');
    row.className = 'av-wheel-row';
    for (const name of grade.WHEELS) {
      const cell = document.createElement('div');
      cell.className = 'av-wheel-cell';
      const disc = document.createElement('canvas');
      disc.width = 96;
      disc.height = 96;
      disc.tabIndex = 0;
      disc.className = 'av-wheel';
      disc.dataset.avWheel = name;
      disc.setAttribute('role', 'slider');
      disc.setAttribute(
        'aria-label',
        `${WHEEL_LABELS[name]} color wheel. Arrow keys push the color; Home resets.`,
      );
      const level = document.createElement('input');
      level.type = 'range';
      level.min = '-100';
      level.max = '100';
      level.step = '1';
      level.value = '0';
      level.dataset.avWheelLevel = name;
      level.setAttribute('aria-label', `${WHEEL_LABELS[name]} level`);
      const label = document.createElement('span');
      label.textContent = WHEEL_LABELS[name];
      cell.append(disc, level, label);
      row.append(cell);
    }
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.dataset.avWheelsReset = '';
    reset.textContent = 'Reset wheels';
    block.append(row, reset);

    const hsl = document.createElement('div');
    hsl.className = 'av-hsl';
    hsl.dataset.avHsl = '';
    const hslTitle = document.createElement('strong');
    hslTitle.textContent = 'HSL secondary';
    const grid = document.createElement('div');
    grid.className = 'av-color-grid';
    for (const [name, text, min, max, step] of HSL_FIELDS) {
      const field = document.createElement('label');
      field.className = 'av-color-field';
      field.textContent = text;
      const input = document.createElement('input');
      input.type = 'number';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(grade.HSL_DEFAULTS[name]);
      input.dataset.avHslField = name;
      field.append(input);
      grid.append(field);
    }
    const hslActions = document.createElement('div');
    hslActions.className = 'av-inline-actions';
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.dataset.avHslPick = '';
    pick.textContent = 'Pick hue from monitor';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.dataset.avHslReset = '';
    clear.textContent = 'Reset HSL';
    hslActions.append(pick, clear);
    hsl.append(hslTitle, grid, hslActions);

    const vignette = document.createElement('label');
    vignette.className = 'av-color-field';
    vignette.textContent = 'Vignette amount';
    const amount = document.createElement('input');
    amount.type = 'range';
    amount.min = '-100';
    amount.max = '100';
    amount.step = '1';
    amount.value = '0';
    amount.dataset.avLumetriVignette = '';
    vignette.append(amount);
    section.append(block, hsl, vignette);
  }

  function drawWheel(disc) {
    const context = disc.getContext('2d');
    if (!context || typeof context.createConicGradient !== 'function') return;
    const size = disc.width;
    const radius = size / 2 - 3;
    context.clearRect(0, 0, size, size);
    const conic = context.createConicGradient(0, size / 2, size / 2);
    // Red at the right (phase 0), then green and blue counterclockwise at 120 degree steps.
    for (const [stop, color] of [
      [0, '#ff4040'],
      [1 / 6, '#ff40ff'],
      [2 / 6, '#4040ff'],
      [3 / 6, '#40ffff'],
      [4 / 6, '#40ff40'],
      [5 / 6, '#ffff40'],
      [1, '#ff4040'],
    ])
      conic.addColorStop(stop, color);
    context.fillStyle = conic;
    context.beginPath();
    context.arc(size / 2, size / 2, radius, 0, Math.PI * 2);
    context.fill();
    const fade = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, radius);
    fade.addColorStop(0, 'rgba(40,40,44,1)');
    fade.addColorStop(1, 'rgba(40,40,44,0)');
    context.fillStyle = fade;
    context.beginPath();
    context.arc(size / 2, size / 2, radius, 0, Math.PI * 2);
    context.fill();
    const wheel = (state.wheels || {})[disc.dataset.avWheel] || { x: 0, y: 0 };
    context.strokeStyle = '#fff';
    context.lineWidth = 2;
    context.beginPath();
    context.arc(size / 2 + wheel.x * radius, size / 2 - wheel.y * radius, 5, 0, Math.PI * 2);
    context.stroke();
  }

  function renderWheels() {
    for (const disc of root.querySelectorAll('[data-av-wheel]')) {
      drawWheel(disc);
      const wheel = (state.wheels || {})[disc.dataset.avWheel] || { x: 0, y: 0, l: 0 };
      disc.setAttribute('aria-valuetext', `x ${wheel.x.toFixed(2)}, y ${wheel.y.toFixed(2)}`);
      const level = root.querySelector(`[data-av-wheel-level="${disc.dataset.avWheel}"]`);
      if (level && document.activeElement !== level)
        level.value = String(Math.round((wheel.l || 0) * 100));
    }
    const hsl = state.hsl || grade.HSL_DEFAULTS;
    for (const input of root.querySelectorAll('[data-av-hsl-field]'))
      if (document.activeElement !== input) input.value = String(hsl[input.dataset.avHslField]);
  }

  function setWheel(name, values, label, live) {
    const wheels = wheelsValue();
    wheels[name] = { x: 0, y: 0, l: 0, ...(wheels[name] || {}), ...values };
    state.wheels = grade.normalizeWheels(wheels);
    send({ wheels: state.wheels }, label, live);
    renderWheels();
  }

  function wheelPoint(event, disc) {
    const rect = disc.getBoundingClientRect();
    const radius = rect.width / 2 - 3;
    let x = (event.clientX - rect.left - rect.width / 2) / radius;
    let y = -(event.clientY - rect.top - rect.height / 2) / radius;
    const length = Math.hypot(x, y);
    if (length > 1) {
      x /= length;
      y /= length;
    }
    return { x, y };
  }

  root.addEventListener('pointerdown', (event) => {
    const disc = event.target.closest?.('[data-av-wheel]');
    if (!disc || event.button !== 0) return;
    event.preventDefault();
    wheelDrag = disc;
    disc.setPointerCapture?.(event.pointerId);
    setWheel(
      disc.dataset.avWheel,
      wheelPoint(event, disc),
      `${WHEEL_LABELS[disc.dataset.avWheel]} wheel`,
      true,
    );
  });
  root.addEventListener('pointermove', (event) => {
    if (!wheelDrag) return;
    setWheel(
      wheelDrag.dataset.avWheel,
      wheelPoint(event, wheelDrag),
      `${WHEEL_LABELS[wheelDrag.dataset.avWheel]} wheel`,
      true,
    );
  });
  const endWheel = () => {
    if (!wheelDrag) return;
    const name = wheelDrag.dataset.avWheel;
    wheelDrag = null;
    send({ wheels: state.wheels }, `${WHEEL_LABELS[name]} wheel`);
  };
  root.addEventListener('pointerup', endWheel);
  root.addEventListener('pointercancel', endWheel);
  root.addEventListener('keydown', (event) => {
    const disc = event.target.closest?.('[data-av-wheel]');
    if (!disc) return;
    const moves = {
      ArrowLeft: [-0.05, 0],
      ArrowRight: [0.05, 0],
      ArrowUp: [0, 0.05],
      ArrowDown: [0, -0.05],
    };
    const name = disc.dataset.avWheel;
    const wheel = (state.wheels || {})[name] || { x: 0, y: 0 };
    if (event.key === 'Home') {
      event.preventDefault();
      event.stopPropagation();
      setWheel(name, { x: 0, y: 0 }, `${WHEEL_LABELS[name]} wheel`);
      return;
    }
    if (!moves[event.key]) return;
    event.preventDefault();
    event.stopPropagation();
    setWheel(
      name,
      { x: wheel.x + moves[event.key][0], y: wheel.y + moves[event.key][1] },
      `${WHEEL_LABELS[name]} wheel`,
    );
  });

  function readHsl() {
    const out = { ...(state.hsl || grade.HSL_DEFAULTS) };
    for (const input of root.querySelectorAll('[data-av-hsl-field]'))
      out[input.dataset.avHslField] = Number(input.value);
    return grade.normalizeHsl(out);
  }

  function selectedVignette() {
    const api = window.AlcorVideoEditor;
    const ids = api?.selection?.() || [];
    const clip = (api?.project?.().clips || []).find(
      (item) => ids.includes(item.id) && (item.kind === 'video' || item.kind === 'image'),
    );
    return clip ? (clip.effects || []).find((effect) => effect.type === 'vignette') || null : null;
  }

  const effectsCommand = (detail) =>
    root.dispatchEvent(new CustomEvent('alcorvideo:effects-command', { detail }));

  root.addEventListener(
    'input',
    (event) => {
      const target = event.target;
      if (target.matches?.('[data-av-wheel-level]')) {
        event.stopPropagation();
        setWheel(
          target.dataset.avWheelLevel,
          { l: Number(target.value) / 100 },
          `${WHEEL_LABELS[target.dataset.avWheelLevel]} level`,
          true,
        );
      } else if (target.matches?.('[data-av-hsl-field]')) {
        event.stopPropagation();
        state.hsl = readHsl();
        send({ hsl: state.hsl }, 'HSL secondary', true);
      } else if (target.matches?.('[data-av-lumetri-vignette]')) {
        event.stopPropagation();
        const effect = selectedVignette();
        if (effect)
          effectsCommand({
            action: 'param',
            effectId: effect.id,
            name: 'amount',
            value: Number(target.value),
            live: true,
          });
      }
    },
    true,
  );
  root.addEventListener(
    'change',
    (event) => {
      const target = event.target;
      if (target.matches?.('[data-av-wheel-level]')) {
        event.stopPropagation();
        setWheel(
          target.dataset.avWheelLevel,
          { l: Number(target.value) / 100 },
          `${WHEEL_LABELS[target.dataset.avWheelLevel]} level`,
        );
      } else if (target.matches?.('[data-av-hsl-field]')) {
        event.stopPropagation();
        state.hsl = readHsl();
        send({ hsl: state.hsl }, 'HSL secondary');
      } else if (target.matches?.('[data-av-lumetri-vignette]')) {
        event.stopPropagation();
        const effect = selectedVignette();
        if (effect)
          effectsCommand({
            action: 'param',
            effectId: effect.id,
            name: 'amount',
            value: Number(target.value),
          });
        else
          effectsCommand({
            action: 'add',
            type: 'vignette',
            params: { amount: Number(target.value) },
          });
      }
    },
    true,
  );
  root.addEventListener('click', async (event) => {
    if (event.target.closest?.('[data-av-wheels-reset]')) {
      state.wheels = null;
      send({ wheels: null }, 'Color wheels reset');
      renderWheels();
    } else if (event.target.closest?.('[data-av-hsl-reset]')) {
      state.hsl = null;
      send({ hsl: null }, 'HSL secondary reset');
      renderWheels();
    } else if (event.target.closest?.('[data-av-hsl-pick]')) {
      const color = window.AlcorVideoEffectsUI
        ? await window.AlcorVideoEffectsUI.pickColor({})
        : null;
      if (!color) return;
      const value = parseInt(color.slice(1), 16);
      const [hue] = grade.rgbToHsl(
        ((value >> 16) & 255) / 255,
        ((value >> 8) & 255) / 255,
        (value & 255) / 255,
      );
      state.hsl = grade.normalizeHsl({
        ...(state.hsl || grade.HSL_DEFAULTS),
        hue: Math.round(hue),
      });
      send({ hsl: state.hsl }, 'HSL hue picked');
      renderWheels();
    }
  });
  root.addEventListener('alcorvideo:grade-state', () => {
    renderWheels();
    const amount = root.querySelector('[data-av-lumetri-vignette]');
    const effect = selectedVignette();
    if (amount && document.activeElement !== amount)
      amount.value = String(effect ? effect.params.amount : 0);
  });

  // ------------------------------------------------------------------ scopes

  const scopes = root.querySelector('#av-scopes');
  const scratch = document.createElement('canvas');
  scratch.width = 256;
  scratch.height = 144;
  let lastScope = 0;
  let pending = 0;

  // Visibility without layout: offsetParent forced a synchronous layout on every rendered frame.
  const scopesShown = () => Boolean(scopes && scopes.isConnected && !scopes.closest('[hidden]'));

  function drawScopes(source) {
    if (!scopesShown()) return;
    const context = scopes.getContext('2d');
    const small = scratch.getContext('2d', { willReadFrequently: true });
    if (!context || !small) return;
    small.drawImage(source, 0, 0, scratch.width, scratch.height);
    const pixels = small.getImageData(0, 0, scratch.width, scratch.height).data;
    const data = grade.computeScopes(pixels, scratch.width, scratch.height, {
      columns: 256,
      vectorSize: 120,
    });
    const width = scopes.width;
    const height = scopes.height;
    context.fillStyle = '#05070a';
    context.fillRect(0, 0, width, height);
    const third = Math.floor(height / 3);
    // Luma waveform.
    const image = context.createImageData(256, 128);
    let peak = 1;
    for (const value of data.waveform) peak = Math.max(peak, value);
    for (let column = 0; column < 256; column += 1) {
      for (let level = 0; level < 256; level += 2) {
        const count = data.waveform[column * 256 + level] + data.waveform[column * 256 + level + 1];
        if (!count) continue;
        const intensity = Math.min(255, 60 + Math.round(Math.sqrt(count / peak) * 400));
        const offset = ((127 - (level >> 1)) * 256 + column) * 4;
        image.data[offset] = intensity * 0.55;
        image.data[offset + 1] = intensity;
        image.data[offset + 2] = intensity * 0.7;
        image.data[offset + 3] = 255;
      }
    }
    const waveformCanvas = document.createElement('canvas');
    waveformCanvas.width = 256;
    waveformCanvas.height = 128;
    waveformCanvas.getContext('2d').putImageData(image, 0, 0);
    context.drawImage(waveformCanvas, 0, 0, width, third - 4);
    // Vectorscope.
    const size = data.vectorSize;
    const vector = context.createImageData(size, size);
    let vectorPeak = 1;
    for (const value of data.vector) vectorPeak = Math.max(vectorPeak, value);
    for (let index = 0; index < data.vector.length; index += 1) {
      if (!data.vector[index]) continue;
      const intensity = Math.min(
        255,
        80 + Math.round(Math.sqrt(data.vector[index] / vectorPeak) * 400),
      );
      vector.data[index * 4] = intensity * 0.7;
      vector.data[index * 4 + 1] = intensity;
      vector.data[index * 4 + 2] = intensity * 0.8;
      vector.data[index * 4 + 3] = 255;
    }
    const vectorCanvas = document.createElement('canvas');
    vectorCanvas.width = size;
    vectorCanvas.height = size;
    vectorCanvas.getContext('2d').putImageData(vector, 0, 0);
    const vs = Math.min(width, third - 8);
    context.drawImage(vectorCanvas, (width - vs) / 2, third + 2, vs, vs);
    context.strokeStyle = 'rgba(255,255,255,.18)';
    context.beginPath();
    context.arc(width / 2, third + 2 + vs / 2, vs / 2, 0, Math.PI * 2);
    context.stroke();
    // RGB histogram.
    const top = third * 2 + 4;
    const histHeight = height - top - 2;
    let histPeak = 1;
    for (const name of ['red', 'green', 'blue'])
      for (let index = 1; index < 255; index += 1)
        histPeak = Math.max(histPeak, data.histogram[name][index]);
    context.globalCompositeOperation = 'lighter';
    for (const [name, color] of [
      ['red', 'rgba(255,80,80,.75)'],
      ['green', 'rgba(80,255,120,.75)'],
      ['blue', 'rgba(90,140,255,.75)'],
    ]) {
      context.fillStyle = color;
      for (let index = 0; index < 256; index += 1) {
        const value = Math.min(1, data.histogram[name][index] / histPeak);
        context.fillRect(
          (index * width) / 256,
          top + histHeight * (1 - value),
          width / 256 + 0.5,
          histHeight * value,
        );
      }
    }
    context.globalCompositeOperation = 'source-over';
    scopes.dataset.updated = String(Date.now());
  }

  root.addEventListener('alcorvideo:frame-rendered', (event) => {
    const source = event.detail?.canvas;
    if (!source || !scopesShown()) return;
    const now = performance.now();
    if (now - lastScope < 120) {
      window.clearTimeout(pending);
      pending = window.setTimeout(() => {
        lastScope = performance.now();
        drawScopes(source);
      }, 130);
      return;
    }
    lastScope = now;
    drawScopes(source);
  });

  drawCurve();
})();
