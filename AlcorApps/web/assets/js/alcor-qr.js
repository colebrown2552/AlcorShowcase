/* AlcorQR 0.1 browser editor. QR payloads and uploaded center marks remain in this page. */
(function (global) {
  'use strict';

  const root = global.document && global.document.querySelector('[data-alcor-qr-editor]');
  if (!root) return;

  const core = global.AlcorQRCore;
  const engine = global.AlcorQREngine;
  const config = Object.freeze(
    Object.assign(
      {
        version: '0.1.0',
        exportMode: 'preview-unmetered',
        maxLogoBytes: 2 * 1024 * 1024,
        policyLabel:
          'Free to export. Businesses can ask for a written quote for custom branded designs.',
      },
      global.AlcorQRConfig || {},
    ),
  );

  const MAX_LOGO_DIMENSION = 4096;
  const MAX_LOGO_PIXELS = 16 * 1024 * 1024;
  const MIN_EXPORT_MODULE_PX = 4;
  const STYLED_LOGO_RASTER_SIDE = 1024;

  const elements = {
    payload: root.querySelector('#aq-payload'),
    filename: root.querySelector('#aq-filename'),
    foreground: root.querySelector('#aq-foreground'),
    background: root.querySelector('#aq-background'),
    eyeColor: root.querySelector('#aq-eye-color'),
    logoBackground: root.querySelector('#aq-logo-background'),
    moduleShape: root.querySelector('#aq-module-shape'),
    errorCorrection: root.querySelector('#aq-error-correction'),
    quietZone: root.querySelector('#aq-quiet-zone'),
    quietZoneOutput: root.querySelector('#aq-quiet-zone-output'),
    logoZone: root.querySelector('#aq-logo-zone'),
    logoInput: root.querySelector('#aq-logo-input'),
    logoName: root.querySelector('#aq-logo-name'),
    logoFraction: root.querySelector('#aq-logo-fraction'),
    logoFractionOutput: root.querySelector('#aq-logo-fraction-output'),
    roundLogo: root.querySelector('#aq-round-logo'),
    removeLogo: root.querySelector('[data-action="remove-logo"]'),
    size: root.querySelector('#aq-size'),
    canvas: root.querySelector('#aq-canvas'),
    details: root.querySelector('#aq-details'),
    status: root.querySelector('#aq-status'),
    logoRule: root.querySelector('#aq-logo-rule'),
    payloadCount: root.querySelector('#aq-payload-count'),
    payloadCountCopy: root.querySelector('#aq-payload-count-copy'),
    contrast: root.querySelector('#aq-contrast'),
    exportPolicy: root.querySelector('#aq-export-policy'),
    exportPng: root.querySelector('[data-action="export-png"]'),
    exportSvg: root.querySelector('[data-action="export-svg"]'),
  };

  const required = [
    'payload',
    'filename',
    'foreground',
    'background',
    'eyeColor',
    'logoBackground',
    'moduleShape',
    'errorCorrection',
    'quietZone',
    'logoZone',
    'logoInput',
    'logoName',
    'logoFraction',
    'roundLogo',
    'removeLogo',
    'size',
    'canvas',
    'details',
    'status',
    'payloadCount',
    'payloadCountCopy',
    'contrast',
    'exportPolicy',
    'exportPng',
    'exportSvg',
  ];
  const missing = required.filter((name) => !elements[name]);

  const state = {
    matrixResult: null,
    logo: null,
    renderTimer: 0,
    exportBusy: false,
    errorLevelBeforeLogo: 'Q',
  };

  function setStatus(message, level) {
    if (!elements.status) return;
    elements.status.textContent = String(message || '');
    elements.status.dataset.level = level || 'neutral';
  }

  function setExportEnabled(enabled) {
    const active = Boolean(enabled) && !state.exportBusy;
    if (elements.exportPng) elements.exportPng.disabled = !active;
    if (elements.exportSvg) elements.exportSvg.disabled = !active;
  }

  function setBusy(busy) {
    state.exportBusy = Boolean(busy);
    root.dataset.exportBusy = busy ? 'true' : 'false';
    setExportEnabled(!busy && Boolean(state.matrixResult) && paletteFromForm().exportable);
  }

  if (missing.length) {
    setStatus(`AlcorQR editor markup is incomplete: ${missing.join(', ')}.`, 'error');
    setExportEnabled(false);
    return;
  }
  if (!core || !engine) {
    setStatus('The bundled AlcorQR encoding engine did not load. Reload before editing.', 'error');
    setExportEnabled(false);
    return;
  }

  function paletteFromForm() {
    return core.validatePalette(
      elements.foreground.value,
      elements.background.value,
      elements.eyeColor.value,
    );
  }

  function optionsFromForm(outputSize) {
    return {
      foreground: elements.foreground.value,
      background: elements.background.value,
      eyeColor: elements.eyeColor.value,
      logoBackground: elements.logoBackground.value,
      moduleShape: elements.moduleShape.value,
      quietZone: Number(elements.quietZone.value),
      logoFraction: Number(elements.logoFraction.value) / 100,
      roundLogo: elements.roundLogo.checked,
      outputSize: Number(outputSize || 1024),
      logoDataUrl: state.logo ? state.logo.dataUrl : '',
    };
  }

  function syncColorCode(input) {
    const code =
      input && input.closest('.aq-color') && input.closest('.aq-color').querySelector('code');
    if (code) code.textContent = String(input.value || '').toLowerCase();
  }

  function updateReadouts(result) {
    [elements.foreground, elements.background, elements.eyeColor, elements.logoBackground].forEach(
      syncColorCode,
    );
    const bytes = core.utf8Bytes(elements.payload.value.trim()).length;
    elements.payloadCount.textContent = `${bytes.toLocaleString()} / ${core.MAX_PAYLOAD_BYTES.toLocaleString()} bytes`;
    elements.payloadCount.dataset.level =
      bytes > core.MAX_PAYLOAD_BYTES
        ? 'error'
        : bytes > core.MAX_PAYLOAD_BYTES * 0.85
          ? 'warning'
          : 'neutral';
    elements.payloadCountCopy.textContent = `${bytes.toLocaleString()} ${bytes === 1 ? 'byte' : 'bytes'}`;
    if (elements.quietZoneOutput)
      elements.quietZoneOutput.textContent = `${elements.quietZone.value}`;
    if (elements.logoFractionOutput)
      elements.logoFractionOutput.textContent = `${elements.logoFraction.value}%`;

    const palette = paletteFromForm();
    // Plain-language contrast: the weaker of the dots and the corner squares decides how well it scans.
    const weakest = Math.min(palette.moduleContrast, palette.eyeContrast);
    const verdict = palette.exportable
      ? palette.recommended
        ? 'scans reliably'
        : 'test before printing'
      : 'too low to scan';
    elements.contrast.textContent = `${weakest.toFixed(1)}:1 — ${verdict}`;
    elements.contrast.dataset.level = palette.exportable
      ? palette.recommended
        ? 'good'
        : 'warn'
      : 'bad';

    if (result) {
      elements.details.textContent = `Version ${result.version} · ${result.moduleCount}×${result.moduleCount} · ${result.errorLevel} correction`;
    }
    elements.logoName.textContent = state.logo ? state.logo.name : 'No center mark selected';
    elements.removeLogo.disabled = !state.logo;
    if (elements.logoRule) {
      elements.logoRule.textContent = state.logo
        ? 'High error correction is locked while a center mark is active'
        : 'Add a center mark to lock high error correction';
    }
  }

  function clearCanvas() {
    const context = elements.canvas.getContext('2d');
    elements.canvas.width = 1024;
    elements.canvas.height = 1024;
    if (!context) return;
    context.fillStyle = elements.background.value || '#ffffff';
    context.fillRect(0, 0, 1024, 1024);
  }

  function render() {
    const palette = paletteFromForm();
    try {
      const result = core.createMatrix(
        elements.payload.value,
        elements.errorCorrection.value,
        engine,
        Boolean(state.logo),
      );
      state.matrixResult = result;
      if (elements.errorCorrection.value !== result.errorLevel)
        elements.errorCorrection.value = result.errorLevel;
      core.drawCanvas(
        elements.canvas,
        result.matrix,
        optionsFromForm(1024),
        state.logo && state.logo.image,
      );
      updateReadouts(result);

      const warnings = Array.from(palette.warnings);
      if (elements.moduleShape.value !== 'square') {
        warnings.push(
          'Decorative module shapes reduce tolerance; test the exported file on several scanners.',
        );
      }
      const moduleSize = core.layoutFor(
        result.matrix,
        optionsFromForm(elements.size.value),
      ).moduleSize;
      if (moduleSize < MIN_EXPORT_MODULE_PX) {
        warnings.push(
          `At ${Number(elements.size.value).toLocaleString()} px each module is only ${moduleSize} px. Choose a larger output size or shorten the payload so phones can scan it.`,
        );
      }
      if (state.logo)
        warnings.push(
          'A center mark hides modules; keep it small and test the final physical output.',
        );

      if (!palette.exportable) {
        setStatus(warnings.join(' '), 'error');
        setExportEnabled(false);
      } else if (warnings.length) {
        setStatus(warnings.join(' '), 'warning');
        setExportEnabled(true);
      } else {
        setStatus(
          'Preview ready. Scan the downloaded file with a phone before you print it.',
          'success',
        );
        setExportEnabled(true);
      }
    } catch (error) {
      state.matrixResult = null;
      clearCanvas();
      updateReadouts(null);
      elements.details.textContent = 'No valid matrix';
      setStatus(String(error && error.message ? error.message : error), 'error');
      setExportEnabled(false);
    }
  }

  function queueRender() {
    global.clearTimeout(state.renderTimer);
    state.renderTimer = global.setTimeout(render, 100);
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const chunkSize = 8192;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.slice(offset, offset + chunkSize));
    }
    return global.btoa(binary);
  }

  function svgToDataUrl(svgText) {
    return `data:image/svg+xml;base64,${bytesToBase64(core.utf8Bytes(svgText))}`;
  }

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('The center image could not be read.'));
      reader.readAsDataURL(file);
    });
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => resolve(image);
      image.onerror = () =>
        reject(new Error('The center image could not be decoded by this browser.'));
      image.src = dataUrl;
    });
  }

  async function rasterizeStyledLogo(svgDataUrl) {
    const source = await loadImage(svgDataUrl);
    const width = Number(source.naturalWidth || source.width || 0);
    const height = Number(source.naturalHeight || source.height || 0);
    if (width < 1 || height < 1) throw new Error('The center image has no usable dimensions.');
    const scale = STYLED_LOGO_RASTER_SIDE / Math.max(width, height);
    const canvas = global.document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser could not prepare the SVG center image.');
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  }

  function classifyLogo(file) {
    const type = String(file.type || '').toLowerCase();
    const name = String(file.name || '').toLowerCase();
    if (type === 'image/svg+xml' || name.endsWith('.svg')) return 'svg';
    if (
      ['image/png', 'image/jpeg', 'image/webp'].includes(type) ||
      /\.(png|jpe?g|webp)$/.test(name)
    )
      return 'raster';
    return '';
  }

  async function acceptLogo(file) {
    if (!file) return;
    if (!Number.isFinite(file.size) || file.size < 1 || file.size > Number(config.maxLogoBytes)) {
      throw new Error(
        `Choose a center image smaller than ${Math.round(Number(config.maxLogoBytes) / 1048576)} MB.`,
      );
    }
    const kind = classifyLogo(file);
    if (!kind) throw new Error('Center images must be PNG, JPEG, WebP, or SVG.');

    let dataUrl;
    if (kind === 'svg') {
      const sanitized = core.sanitizeSvgText(await file.text(), undefined, undefined, {
        allowStyle: true,
      });
      dataUrl = svgToDataUrl(sanitized);
      if (/<style[\s>]/i.test(sanitized)) {
        // Styled SVGs are flattened to PNG so the exported SVG never carries CSS.
        dataUrl = await rasterizeStyledLogo(dataUrl);
      }
    } else {
      dataUrl = await readAsDataUrl(file);
    }
    if (!core.isSafeImageDataUrl(dataUrl))
      throw new Error('The center image data is not accepted.');

    const image = await loadImage(dataUrl);
    const width = Number(image.naturalWidth || image.width || 0);
    const height = Number(image.naturalHeight || image.height || 0);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
      throw new Error('The center image has no usable dimensions.');
    }
    if (
      width > MAX_LOGO_DIMENSION ||
      height > MAX_LOGO_DIMENSION ||
      width * height > MAX_LOGO_PIXELS
    ) {
      throw new Error(
        `Center images are limited to ${MAX_LOGO_DIMENSION.toLocaleString()} pixels per side and ${MAX_LOGO_PIXELS.toLocaleString()} decoded pixels.`,
      );
    }
    if (!state.logo) state.errorLevelBeforeLogo = elements.errorCorrection.value;
    state.logo = Object.freeze({
      kind,
      dataUrl,
      image,
      name: String(file.name || 'Center image').slice(0, 120),
    });
    elements.errorCorrection.value = 'H';
    elements.errorCorrection.disabled = true;
    elements.logoInput.value = '';
    render();
    setStatus(
      'Center image loaded locally. High error correction is locked for this design.',
      'success',
    );
  }

  function removeLogo() {
    state.logo = null;
    elements.logoInput.value = '';
    elements.errorCorrection.disabled = false;
    elements.errorCorrection.value = ['L', 'M', 'Q', 'H'].includes(state.errorLevelBeforeLogo)
      ? state.errorLevelBeforeLogo
      : 'Q';
    render();
  }

  function createRequestId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID().replace(/-/g, '');
    }
    if (global.crypto && typeof global.crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      global.crypto.getRandomValues(bytes);
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    throw new Error('Secure export request IDs are unavailable in this browser.');
  }

  async function authorizeDownload(request) {
    const adapter = global.AlcorQRExportAuthorizer;
    if (adapter && typeof adapter.authorizeDownload === 'function') {
      const result = await adapter.authorizeDownload(request);
      if (!result || result.allowed !== true) {
        throw new Error(
          result && result.message
            ? result.message
            : 'Sign in or unlock continued AlcorQR exports.',
        );
      }
      return Object.freeze({ mode: 'adapter', result });
    }
    if (config.exportMode === 'preview-unmetered') {
      return Object.freeze({
        mode: 'preview-unmetered',
        result: Object.freeze({ allowed: true, authorizationId: `preview-${request.requestId}` }),
      });
    }
    throw new Error(
      'AlcorQR export authorization is not connected. Previewing and editing still work locally.',
    );
  }

  async function confirmDownload(request, authorization) {
    if (authorization.mode !== 'adapter') return null;
    const adapter = global.AlcorQRExportAuthorizer;
    const authorizationId = authorization.result && authorization.result.authorizationId;
    if (!adapter || typeof adapter.confirmDownload !== 'function' || !authorizationId) return null;
    const confirmation = core.createExportConfirmation(request, authorizationId);
    return adapter.confirmDownload(confirmation);
  }

  function canvasBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('This browser could not create the PNG file.'));
      }, 'image/png');
    });
  }

  function triggerDownload(blob, filename) {
    if (!global.URL || typeof global.URL.createObjectURL !== 'function')
      throw new Error('Browser download capability is unavailable.');
    const url = global.URL.createObjectURL(blob);
    try {
      const anchor = global.document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.rel = 'noopener';
      anchor.hidden = true;
      global.document.body.append(anchor);
      anchor.click();
      anchor.remove();
    } finally {
      global.setTimeout(() => global.URL.revokeObjectURL(url), 30000);
    }
  }

  function ensureExportable() {
    render();
    if (!state.matrixResult) throw new Error('Create a valid QR preview before exporting.');
    const palette = paletteFromForm();
    if (!palette.exportable) throw new Error(palette.warnings.join(' '));
    return state.matrixResult;
  }

  async function buildExport(format) {
    const result = ensureExportable();
    const size = Number(elements.size.value);
    const request = core.createExportRequest({
      requestId: createRequestId(),
      appVersion: config.version,
      format,
      size,
      hasLogo: Boolean(state.logo),
    });

    let blob;
    if (format === 'svg') {
      const svg = core.createSvg(result.matrix, optionsFromForm(size));
      blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    } else {
      const canvas = global.document.createElement('canvas');
      core.drawCanvas(canvas, result.matrix, optionsFromForm(size), state.logo && state.logo.image);
      blob = await canvasBlob(canvas);
    }
    return Object.freeze({
      request,
      blob,
      filename: core.safeFilename(elements.filename.value, format),
    });
  }

  async function runExport(format) {
    if (state.exportBusy) return;
    setBusy(true);
    setStatus(`Preparing ${format.toUpperCase()} entirely in this browser…`, 'neutral');
    try {
      const built = await buildExport(format);
      const authorization = await authorizeDownload(built.request);
      triggerDownload(built.blob, built.filename);
      let confirmationWarning = '';
      try {
        await confirmDownload(built.request, authorization);
      } catch (error) {
        confirmationWarning =
          ' The file was created, but the usage receipt could not be confirmed.';
      }
      setStatus(
        `${format.toUpperCase()} download created.${confirmationWarning}`,
        confirmationWarning ? 'warning' : 'success',
      );
    } catch (error) {
      setStatus(String(error && error.message ? error.message : error), 'error');
    } finally {
      setBusy(false);
    }
  }

  function resetColors() {
    elements.foreground.value = '#111827';
    elements.background.value = '#ffffff';
    elements.eyeColor.value = '#111827';
    elements.logoBackground.value = '#ffffff';
    render();
  }

  const DEFAULTS = Object.freeze({
    payload: 'https://alcor-industries.com/',
    filename: 'alcor-qr',
    moduleShape: 'square',
    quietZone: '4',
    logoFraction: '16',
    size: '1024',
    errorCorrection: 'Q',
    foreground: '#111827',
    background: '#ffffff',
    eyeColor: '#111827',
    logoBackground: '#ffffff',
  });

  function designDiffersFromDefaults() {
    if (state.logo) return true;
    if (!elements.roundLogo.checked) return true;
    return Object.keys(DEFAULTS).some(
      (name) => String(elements[name].value).toLowerCase() !== DEFAULTS[name].toLowerCase(),
    );
  }

  const resetButton = root.querySelector('[data-action="reset-design"]');
  const resetConfirm = global.document.createElement('div');
  const resetYes = global.document.createElement('button');
  const resetKeep = global.document.createElement('button');

  function buildResetConfirm() {
    if (!resetButton) return;
    const text = global.document.createElement('p');
    text.id = 'aq-reset-confirm-text';
    text.textContent = 'Reset the design? Your text, colors and logo go back to the start.';
    resetYes.type = 'button';
    resetYes.className = 'aq-button';
    resetYes.textContent = 'Reset';
    resetKeep.type = 'button';
    resetKeep.className = 'aq-button aq-button-primary';
    resetKeep.textContent = 'Keep';
    resetConfirm.className = 'aq-confirm';
    resetConfirm.setAttribute('role', 'group');
    resetConfirm.setAttribute('aria-labelledby', text.id);
    resetConfirm.hidden = true;
    resetConfirm.append(text, resetYes, resetKeep);
    resetButton.parentNode.append(resetConfirm);
    resetYes.addEventListener('click', () => {
      closeResetConfirm(false);
      resetDesign();
      resetButton.focus();
    });
    resetKeep.addEventListener('click', () => closeResetConfirm(true));
    global.document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !resetConfirm.hidden) {
        event.preventDefault();
        closeResetConfirm(true);
      }
    });
  }

  function closeResetConfirm(returnFocus) {
    if (resetConfirm.hidden) return;
    resetConfirm.hidden = true;
    if (returnFocus) resetButton.focus();
  }

  function requestResetDesign() {
    if (!resetButton || !designDiffersFromDefaults()) {
      resetDesign();
      return;
    }
    resetConfirm.hidden = false;
    resetKeep.focus();
  }

  function resetDesign() {
    elements.payload.value = 'https://alcor-industries.com/';
    elements.filename.value = 'alcor-qr';
    elements.moduleShape.value = 'square';
    elements.quietZone.value = '4';
    elements.logoFraction.value = '16';
    elements.roundLogo.checked = true;
    elements.size.value = '1024';
    state.errorLevelBeforeLogo = 'Q';
    if (state.logo) removeLogo();
    elements.errorCorrection.disabled = false;
    elements.errorCorrection.value = 'Q';
    resetColors();
  }

  root.addEventListener('input', (event) => {
    if (event.target === elements.logoInput) return;
    queueRender();
  });

  root.addEventListener('change', (event) => {
    if (event.target === elements.logoInput) {
      acceptLogo(elements.logoInput.files && elements.logoInput.files[0]).catch((error) => {
        setStatus(String(error && error.message ? error.message : error), 'error');
      });
      return;
    }
    if (
      event.target === elements.errorCorrection &&
      state.logo &&
      elements.errorCorrection.value !== 'H'
    ) {
      elements.errorCorrection.value = 'H';
      setStatus('Center images require high error correction in this release.', 'warning');
    }
    render();
  });

  root.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]');
    if (!action) return;
    switch (action.dataset.action) {
      case 'export-png':
        runExport('png');
        break;
      case 'export-svg':
        runExport('svg');
        break;
      case 'remove-logo':
        removeLogo();
        break;
      case 'reset-colors':
        resetColors();
        break;
      case 'swap-colors': {
        const foreground = elements.foreground.value;
        const eyesFollowModules =
          elements.eyeColor.value.toLowerCase() === foreground.toLowerCase();
        elements.foreground.value = elements.background.value;
        if (eyesFollowModules) elements.eyeColor.value = elements.background.value;
        elements.background.value = foreground;
        render();
        break;
      }
      case 'reset-design':
        requestResetDesign();
        break;
      default:
        break;
    }
  });

  ['dragenter', 'dragover'].forEach((name) => {
    elements.logoZone.addEventListener(name, (event) => {
      event.preventDefault();
      elements.logoZone.dataset.drag = 'true';
    });
  });
  ['dragleave', 'drop'].forEach((name) => {
    elements.logoZone.addEventListener(name, (event) => {
      event.preventDefault();
      elements.logoZone.dataset.drag = 'false';
    });
  });
  elements.logoZone.addEventListener('drop', (event) => {
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    acceptLogo(file).catch((error) =>
      setStatus(String(error && error.message ? error.message : error), 'error'),
    );
  });

  elements.exportPolicy.textContent =
    config.exportMode === 'preview-unmetered'
      ? 'Free to use, with no account.'
      : config.policyLabel;

  buildResetConfirm();
  updateReadouts(null);
  render();
})(typeof window !== 'undefined' ? window : globalThis);
