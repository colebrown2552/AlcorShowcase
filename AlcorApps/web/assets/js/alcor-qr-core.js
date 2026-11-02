/*
 * AlcorQR core encoder and renderer.
 *
 * This file is intentionally content-local: it contains no network primitives,
 * storage, account logic, analytics, or payment authority.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AlcorQRCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FINDER_SIZE = 7;
  const MIN_QUIET_ZONE = 4;
  const MAX_QUIET_ZONE = 16;
  const MIN_LOGO_FRACTION = 0.08;
  const MAX_LOGO_FRACTION = 0.2;
  const MIN_OUTPUT_SIZE = 256;
  const MAX_OUTPUT_SIZE = 4096;
  const MIN_EXPORT_CONTRAST = 3;
  const RECOMMENDED_CONTRAST = 4.5;
  const MAX_PAYLOAD_BYTES = 1200;
  const MAX_SVG_CHARACTERS = 2 * 1024 * 1024;
  const MAX_SVG_ELEMENTS = 4096;
  const MAX_SVG_ATTRIBUTES = 16384;
  const MODULE_SHAPES = Object.freeze(['square', 'rounded', 'dots']);

  function clamp(value, minimum, maximum) {
    const number = Number(value);
    return Math.min(maximum, Math.max(minimum, Number.isFinite(number) ? number : minimum));
  }

  function normalizeHex(value, fallback) {
    const candidate = String(value || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(candidate)) return candidate.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(candidate)) {
      return (
        '#' +
        candidate
          .slice(1)
          .split('')
          .map((part) => part + part)
          .join('')
      ).toLowerCase();
    }
    return fallback;
  }

  function hexToRgb(value) {
    const hex = normalizeHex(value, '#000000').slice(1);
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }

  function channelLuminance(channel) {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
  }

  function relativeLuminance(value) {
    const rgb = hexToRgb(value);
    return (
      0.2126 * channelLuminance(rgb.r) +
      0.7152 * channelLuminance(rgb.g) +
      0.0722 * channelLuminance(rgb.b)
    );
  }

  function contrastRatio(first, second) {
    const a = relativeLuminance(first);
    const b = relativeLuminance(second);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  function validatePalette(foreground, background, eyeColor) {
    const modules = normalizeHex(foreground, '#111827');
    const backdrop = normalizeHex(background, '#ffffff');
    const eyes = normalizeHex(eyeColor, modules);
    const moduleContrast = contrastRatio(modules, backdrop);
    const eyeContrast = contrastRatio(eyes, backdrop);
    const warnings = [];

    if (moduleContrast < MIN_EXPORT_CONTRAST) {
      warnings.push(
        `Module/background contrast must reach ${MIN_EXPORT_CONTRAST.toFixed(1)}:1 before export.`,
      );
    } else if (moduleContrast < RECOMMENDED_CONTRAST) {
      warnings.push(
        `Module/background contrast is usable but below the ${RECOMMENDED_CONTRAST.toFixed(1)}:1 reliability target.`,
      );
    }
    if (eyeContrast < MIN_EXPORT_CONTRAST) {
      warnings.push(
        `Finder/background contrast must reach ${MIN_EXPORT_CONTRAST.toFixed(1)}:1 before export.`,
      );
    } else if (eyeContrast < RECOMMENDED_CONTRAST) {
      warnings.push(
        `Finder/background contrast is usable but below the ${RECOMMENDED_CONTRAST.toFixed(1)}:1 reliability target.`,
      );
    }
    if (relativeLuminance(modules) > relativeLuminance(backdrop)) {
      warnings.push(
        'Light modules on a dark background are less consistently recognized; test several scanners.',
      );
    }
    if (relativeLuminance(eyes) > relativeLuminance(backdrop)) {
      warnings.push(
        'Light finder eyes on a dark background are less consistently recognized; test several scanners.',
      );
    }

    return Object.freeze({
      foreground: modules,
      background: backdrop,
      eyeColor: eyes,
      moduleContrast,
      eyeContrast,
      exportable: moduleContrast >= MIN_EXPORT_CONTRAST && eyeContrast >= MIN_EXPORT_CONTRAST,
      recommended: moduleContrast >= RECOMMENDED_CONTRAST && eyeContrast >= RECOMMENDED_CONTRAST,
      warnings: Object.freeze(warnings),
    });
  }

  function utf8Bytes(value) {
    const text = String(value == null ? '' : value);
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(text));
    const encoded = unescape(encodeURIComponent(text));
    return Array.from(encoded, (character) => character.charCodeAt(0));
  }

  function binaryFromBytes(bytes) {
    let output = '';
    const chunkSize = 8192;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      output += String.fromCharCode.apply(null, bytes.slice(offset, offset + chunkSize));
    }
    return output;
  }

  function normalizeErrorLevel(value, hasLogo) {
    if (hasLogo) return 'H';
    return ['L', 'M', 'Q', 'H'].includes(value) ? value : 'Q';
  }

  function createMatrix(payload, errorLevel, engine, hasLogo) {
    const text = String(payload == null ? '' : payload).trim();
    if (!text) throw new Error('Enter a URL or text value to encode.');
    if (!engine || typeof engine.QRCode !== 'function' || !engine.QRErrorCorrectLevel) {
      throw new Error('The bundled QR encoding engine is unavailable.');
    }

    const bytes = utf8Bytes(text);
    if (bytes.length > MAX_PAYLOAD_BYTES) {
      throw new Error(
        `The payload is ${bytes.length.toLocaleString()} bytes. Keep it to ${MAX_PAYLOAD_BYTES.toLocaleString()} bytes or fewer.`,
      );
    }
    const level = normalizeErrorLevel(errorLevel, Boolean(hasLogo));

    try {
      const qr = new engine.QRCode(-1, engine.QRErrorCorrectLevel[level]);
      qr.addData(binaryFromBytes(bytes));
      qr.make();
      const count = qr.getModuleCount();
      if (!Number.isInteger(count) || count < 21 || count > 177 || (count - 17) % 4 !== 0) {
        throw new Error('The encoder returned an invalid matrix size.');
      }
      const matrix = Array.from({ length: count }, (_, row) =>
        Array.from({ length: count }, (_, column) => Boolean(qr.isDark(row, column))),
      );
      return Object.freeze({
        matrix: Object.freeze(matrix.map((row) => Object.freeze(row))),
        moduleCount: count,
        version: (count - 17) / 4,
        byteCount: bytes.length,
        errorLevel: level,
      });
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      if (/overflow/i.test(message)) {
        throw new Error(
          'That payload is too large for the selected error-correction level. Shorten it or remove unnecessary query parameters.',
        );
      }
      throw new Error(`Could not build this QR code: ${message}`);
    }
  }

  function normalizeMatrix(matrix) {
    if (!Array.isArray(matrix) || matrix.length < 21 || matrix.length > 177) {
      throw new Error('A valid square QR matrix is required.');
    }
    const count = matrix.length;
    return matrix.map((row) => {
      if (!Array.isArray(row) || row.length !== count)
        throw new Error('A valid square QR matrix is required.');
      return row.map(Boolean);
    });
  }

  function normalizeOptions(options) {
    const source = options || {};
    const palette = validatePalette(source.foreground, source.background, source.eyeColor);
    const shape = MODULE_SHAPES.includes(source.moduleShape) ? source.moduleShape : 'square';
    return Object.freeze({
      foreground: palette.foreground,
      background: palette.background,
      eyeColor: palette.eyeColor,
      logoBackground: normalizeHex(source.logoBackground, palette.background),
      moduleContrast: palette.moduleContrast,
      eyeContrast: palette.eyeContrast,
      exportable: palette.exportable,
      recommended: palette.recommended,
      warnings: palette.warnings,
      moduleShape: shape,
      quietZone: Math.round(clamp(source.quietZone, MIN_QUIET_ZONE, MAX_QUIET_ZONE)),
      logoFraction: clamp(source.logoFraction, MIN_LOGO_FRACTION, MAX_LOGO_FRACTION),
      roundLogo: source.roundLogo !== false,
      outputSize: Math.round(clamp(source.outputSize, MIN_OUTPUT_SIZE, MAX_OUTPUT_SIZE)),
      logoDataUrl: isSafeImageDataUrl(source.logoDataUrl) ? source.logoDataUrl : '',
    });
  }

  function isFinderCell(row, column, count) {
    return (
      (row < FINDER_SIZE && column < FINDER_SIZE) ||
      (row < FINDER_SIZE && column >= count - FINDER_SIZE) ||
      (row >= count - FINDER_SIZE && column < FINDER_SIZE)
    );
  }

  function layoutFor(matrixInput, options) {
    const matrix = normalizeMatrix(matrixInput);
    const normalized = normalizeOptions(options);
    const count = matrix.length;
    const totalModules = count + normalized.quietZone * 2;
    const moduleSize = Math.max(1, Math.floor(normalized.outputSize / totalModules));
    const renderedSize = moduleSize * totalModules;
    const outerOffset = Math.floor((normalized.outputSize - renderedSize) / 2);
    const matrixOffset = outerOffset + normalized.quietZone * moduleSize;
    return Object.freeze({
      matrix,
      options: normalized,
      count,
      totalModules,
      moduleSize,
      renderedSize,
      outerOffset,
      matrixOffset,
    });
  }

  function roundedRectPath(x, y, width, height, radius) {
    const r = clamp(radius, 0, Math.min(width, height) / 2);
    return [
      `M${x + r} ${y}`,
      `H${x + width - r}`,
      `Q${x + width} ${y} ${x + width} ${y + r}`,
      `V${y + height - r}`,
      `Q${x + width} ${y + height} ${x + width - r} ${y + height}`,
      `H${x + r}`,
      `Q${x} ${y + height} ${x} ${y + height - r}`,
      `V${y + r}`,
      `Q${x} ${y} ${x + r} ${y}`,
      'Z',
    ].join(' ');
  }

  function drawRoundedRect(context, x, y, width, height, radius) {
    const r = clamp(radius, 0, Math.min(width, height) / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.lineTo(x + width - r, y);
    context.quadraticCurveTo(x + width, y, x + width, y + r);
    context.lineTo(x + width, y + height - r);
    context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    context.lineTo(x + r, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - r);
    context.lineTo(x, y + r);
    context.quadraticCurveTo(x, y, x + r, y);
    context.closePath();
    context.fill();
  }

  function drawModule(context, shape, x, y, size) {
    if (shape === 'dots') {
      context.beginPath();
      context.arc(x + size / 2, y + size / 2, size * 0.44, 0, Math.PI * 2);
      context.fill();
      return;
    }
    if (shape === 'rounded') {
      drawRoundedRect(
        context,
        x + size * 0.04,
        y + size * 0.04,
        size * 0.92,
        size * 0.92,
        size * 0.24,
      );
      return;
    }
    context.fillRect(x, y, size, size);
  }

  function drawFinderCanvas(context, x, y, moduleSize, foreground, background) {
    context.fillStyle = foreground;
    context.fillRect(x, y, moduleSize * 7, moduleSize * 7);
    context.fillStyle = background;
    context.fillRect(x + moduleSize, y + moduleSize, moduleSize * 5, moduleSize * 5);
    context.fillStyle = foreground;
    context.fillRect(x + moduleSize * 2, y + moduleSize * 2, moduleSize * 3, moduleSize * 3);
  }

  function logoGeometry(layout) {
    const qrArea = layout.count * layout.moduleSize;
    const imageSide = qrArea * layout.options.logoFraction;
    const padding = Math.max(layout.moduleSize * 1.25, imageSide * 0.1);
    const plateSide = imageSide + padding * 2;
    const center = layout.options.outputSize / 2;
    return Object.freeze({
      imageSide,
      imageX: center - imageSide / 2,
      imageY: center - imageSide / 2,
      plateSide,
      plateX: center - plateSide / 2,
      plateY: center - plateSide / 2,
      radius: layout.options.roundLogo ? plateSide * 0.18 : 0,
    });
  }

  function drawCanvas(canvas, matrixInput, options, logoImage) {
    if (!canvas || typeof canvas.getContext !== 'function')
      throw new Error('A canvas is required.');
    const layout = layoutFor(matrixInput, options);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas rendering is unavailable.');
    canvas.width = layout.options.outputSize;
    canvas.height = layout.options.outputSize;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.fillStyle = layout.options.background;
    context.fillRect(0, 0, layout.options.outputSize, layout.options.outputSize);

    context.fillStyle = layout.options.foreground;
    for (let row = 0; row < layout.count; row += 1) {
      for (let column = 0; column < layout.count; column += 1) {
        if (!layout.matrix[row][column] || isFinderCell(row, column, layout.count)) continue;
        const x = layout.matrixOffset + column * layout.moduleSize;
        const y = layout.matrixOffset + row * layout.moduleSize;
        drawModule(context, layout.options.moduleShape, x, y, layout.moduleSize);
      }
    }

    const lastFinder = layout.matrixOffset + (layout.count - FINDER_SIZE) * layout.moduleSize;
    drawFinderCanvas(
      context,
      layout.matrixOffset,
      layout.matrixOffset,
      layout.moduleSize,
      layout.options.eyeColor,
      layout.options.background,
    );
    drawFinderCanvas(
      context,
      lastFinder,
      layout.matrixOffset,
      layout.moduleSize,
      layout.options.eyeColor,
      layout.options.background,
    );
    drawFinderCanvas(
      context,
      layout.matrixOffset,
      lastFinder,
      layout.moduleSize,
      layout.options.eyeColor,
      layout.options.background,
    );

    if (layout.options.logoDataUrl && logoImage) {
      const geometry = logoGeometry(layout);
      context.fillStyle = layout.options.logoBackground;
      drawRoundedRect(
        context,
        geometry.plateX,
        geometry.plateY,
        geometry.plateSide,
        geometry.plateSide,
        geometry.radius,
      );

      const width = Number(logoImage.naturalWidth || logoImage.width || geometry.imageSide);
      const height = Number(logoImage.naturalHeight || logoImage.height || geometry.imageSide);
      const scale = Math.min(geometry.imageSide / width, geometry.imageSide / height);
      const drawWidth = width * scale;
      const drawHeight = height * scale;
      context.drawImage(
        logoImage,
        geometry.imageX + (geometry.imageSide - drawWidth) / 2,
        geometry.imageY + (geometry.imageSide - drawHeight) / 2,
        drawWidth,
        drawHeight,
      );
    }

    return layout;
  }

  function escapeXml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function svgModule(shape, x, y, size, color) {
    if (shape === 'dots') {
      return `<circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size * 0.44}" fill="${color}"/>`;
    }
    if (shape === 'rounded') {
      return `<rect x="${x + size * 0.04}" y="${y + size * 0.04}" width="${size * 0.92}" height="${size * 0.92}" rx="${size * 0.24}" fill="${color}"/>`;
    }
    return `<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="${color}"/>`;
  }

  function svgFinder(x, y, moduleSize, foreground, background) {
    return [
      `<rect x="${x}" y="${y}" width="${moduleSize * 7}" height="${moduleSize * 7}" fill="${foreground}"/>`,
      `<rect x="${x + moduleSize}" y="${y + moduleSize}" width="${moduleSize * 5}" height="${moduleSize * 5}" fill="${background}"/>`,
      `<rect x="${x + moduleSize * 2}" y="${y + moduleSize * 2}" width="${moduleSize * 3}" height="${moduleSize * 3}" fill="${foreground}"/>`,
    ].join('');
  }

  function isSafeImageDataUrl(value) {
    if (typeof value !== 'string' || value.length > 3_000_000) return false;
    return /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[a-z0-9+/=\r\n]+$/i.test(value);
  }

  function createSvg(matrixInput, options) {
    const layout = layoutFor(matrixInput, options);
    const foreground = escapeXml(layout.options.foreground);
    const background = escapeXml(layout.options.background);
    const eyeColor = escapeXml(layout.options.eyeColor);
    const size = layout.options.outputSize;
    const parts = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-labelledby="alcor-qr-title">`,
      '<title id="alcor-qr-title">AlcorQR code</title>',
      `<rect width="100%" height="100%" fill="${background}"/>`,
    ];

    for (let row = 0; row < layout.count; row += 1) {
      for (let column = 0; column < layout.count; column += 1) {
        if (!layout.matrix[row][column] || isFinderCell(row, column, layout.count)) continue;
        const x = layout.matrixOffset + column * layout.moduleSize;
        const y = layout.matrixOffset + row * layout.moduleSize;
        parts.push(svgModule(layout.options.moduleShape, x, y, layout.moduleSize, foreground));
      }
    }

    const lastFinder = layout.matrixOffset + (layout.count - FINDER_SIZE) * layout.moduleSize;
    parts.push(
      svgFinder(layout.matrixOffset, layout.matrixOffset, layout.moduleSize, eyeColor, background),
    );
    parts.push(svgFinder(lastFinder, layout.matrixOffset, layout.moduleSize, eyeColor, background));
    parts.push(svgFinder(layout.matrixOffset, lastFinder, layout.moduleSize, eyeColor, background));

    if (layout.options.logoDataUrl) {
      const geometry = logoGeometry(layout);
      parts.push(
        `<path d="${roundedRectPath(geometry.plateX, geometry.plateY, geometry.plateSide, geometry.plateSide, geometry.radius)}" fill="${escapeXml(layout.options.logoBackground)}"/>`,
      );
      parts.push(
        `<image href="${escapeXml(layout.options.logoDataUrl)}" xlink:href="${escapeXml(layout.options.logoDataUrl)}" x="${geometry.imageX}" y="${geometry.imageY}" width="${geometry.imageSide}" height="${geometry.imageSide}" preserveAspectRatio="xMidYMid meet"/>`,
      );
    }

    parts.push('</svg>');
    return parts.join('');
  }

  // A <style> block is kept only when it is plain selectors and declarations: no url(), @-rules,
  // escapes, comments, markup, expression(), javascript:, behavior or binding properties.
  function isSafeSvgCss(css) {
    const text = String(css || '');
    if (text.length > 65536) return false;
    return !/[<\\@]|\/\*|url\s*\(|expression|javascript|behavio|binding|-moz-|image-set|src\s*:/i.test(
      text,
    );
  }

  function sanitizeSvgText(text, Parser, Serializer, settings) {
    const allowStyle = Boolean(settings && settings.allowStyle);
    const source = String(text || '');
    if (!source || source.length > MAX_SVG_CHARACTERS)
      throw new Error('SVG center image is empty or too large.');
    if (/<!DOCTYPE|<!ENTITY/i.test(source))
      throw new Error('SVG document declarations and entities are not allowed.');

    const DOMParserClass = Parser || (typeof DOMParser !== 'undefined' ? DOMParser : null);
    const XMLSerializerClass =
      Serializer || (typeof XMLSerializer !== 'undefined' ? XMLSerializer : null);
    if (!DOMParserClass || !XMLSerializerClass)
      throw new Error('This browser cannot safely read SVG center images.');

    const documentNode = new DOMParserClass().parseFromString(source, 'image/svg+xml');
    if (
      !documentNode ||
      documentNode.querySelector('parsererror') ||
      !documentNode.documentElement ||
      documentNode.documentElement.localName.toLowerCase() !== 'svg'
    ) {
      throw new Error('The uploaded file is not a valid SVG image.');
    }

    const forbidden = new Set([
      'script',
      'foreignobject',
      'iframe',
      'object',
      'embed',
      'audio',
      'video',
      'link',
      'style',
      'base',
      'meta',
      'animate',
      'animatemotion',
      'animatetransform',
      'set',
    ]);
    const descendants = Array.from(documentNode.documentElement.querySelectorAll('*'));
    if (descendants.length + 1 > MAX_SVG_ELEMENTS) {
      throw new Error(
        `SVG center images may contain at most ${MAX_SVG_ELEMENTS.toLocaleString()} elements.`,
      );
    }
    const nodes = [documentNode.documentElement].concat(descendants);
    const attributeCount = nodes.reduce((total, node) => total + node.attributes.length, 0);
    if (attributeCount > MAX_SVG_ATTRIBUTES) {
      throw new Error(
        `SVG center images may contain at most ${MAX_SVG_ATTRIBUTES.toLocaleString()} attributes.`,
      );
    }
    nodes.forEach((node) => {
      if (
        allowStyle &&
        node.localName.toLowerCase() === 'style' &&
        node.namespaceURI === 'http://www.w3.org/2000/svg' &&
        isSafeSvgCss(node.textContent)
      ) {
        Array.from(node.attributes).forEach((attribute) => {
          if (attribute.name.toLowerCase() !== 'type' || !/^text\/css$/i.test(attribute.value))
            node.removeAttribute(attribute.name);
        });
        return;
      }
      if (forbidden.has(node.localName.toLowerCase())) {
        node.remove();
        return;
      }
      Array.from(node.attributes).forEach((attribute) => {
        const name = attribute.name.toLowerCase();
        const value = String(attribute.value || '').trim();
        if (name.startsWith('on') || name === 'src') {
          node.removeAttribute(attribute.name);
          return;
        }
        if (/javascript\s*:|data\s*:\s*text\/html|expression\s*\(|@import/i.test(value)) {
          node.removeAttribute(attribute.name);
          return;
        }
        if (name === 'style' && /url\s*\(/i.test(value)) {
          node.removeAttribute(attribute.name);
          return;
        }
        if (name === 'href' || name === 'xlink:href') {
          const local = /^#[A-Za-z_][\w:.-]*$/.test(value);
          const embeddedRaster = /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\r\n]+$/i.test(
            value,
          );
          if (!local && !embeddedRaster) node.removeAttribute(attribute.name);
          return;
        }
        if (
          /url\s*\(/i.test(value) &&
          !/^url\(\s*['"]?#[A-Za-z_][\w:.-]*['"]?\s*\)$/i.test(value)
        ) {
          node.removeAttribute(attribute.name);
        }
      });
    });

    const svg = documentNode.documentElement;
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    if (
      !svg.hasAttribute('viewBox') &&
      !(svg.hasAttribute('width') && svg.hasAttribute('height'))
    ) {
      throw new Error('The SVG needs a viewBox or explicit width and height.');
    }
    const sanitized = new XMLSerializerClass().serializeToString(svg);
    if (!sanitized || sanitized.length > MAX_SVG_CHARACTERS)
      throw new Error('The sanitized SVG is unexpectedly large.');
    return sanitized;
  }

  function safeFilename(value, extension) {
    const base =
      Array.from(
        String(value || 'alcor-qr')
          .trim()
          .normalize('NFC')
          .replace(/\.(?:png|svg|jpe?g|webp)$/i, '')
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, '-')
          .replace(/^-+|-+$/g, ''),
      )
        .slice(0, 64)
        .join('')
        .replace(/-+$/g, '') || 'alcor-qr';
    return `${base}.${extension === 'svg' ? 'svg' : 'png'}`;
  }

  function createExportRequest(options) {
    const source = options || {};
    const requestId = String(source.requestId || '').trim();
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(requestId))
      throw new Error('A valid export request ID is required.');
    const format = source.format === 'svg' ? 'svg' : 'png';
    const size = Math.round(clamp(source.size, MIN_OUTPUT_SIZE, MAX_OUTPUT_SIZE));
    return Object.freeze({
      schema: 'alcorqr.export.request',
      schemaVersion: 1,
      requestId,
      product: 'alcorqr',
      appVersion: String(source.appVersion || '0.1.0').slice(0, 32),
      format,
      size,
      hasLogo: Boolean(source.hasLogo),
    });
  }

  function createExportConfirmation(request, authorizationId) {
    if (!request || request.schema !== 'alcorqr.export.request')
      throw new Error('A valid export request is required.');
    const receipt = String(authorizationId || '').trim();
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(receipt))
      throw new Error('A valid export authorization ID is required.');
    return Object.freeze({
      schema: 'alcorqr.export.confirmation',
      schemaVersion: 1,
      requestId: request.requestId,
      authorizationId: receipt,
      outcome: 'download-triggered',
    });
  }

  return Object.freeze({
    FINDER_SIZE,
    MIN_QUIET_ZONE,
    MAX_QUIET_ZONE,
    MIN_LOGO_FRACTION,
    MAX_LOGO_FRACTION,
    MIN_EXPORT_CONTRAST,
    RECOMMENDED_CONTRAST,
    MAX_PAYLOAD_BYTES,
    MAX_SVG_ELEMENTS,
    MAX_SVG_ATTRIBUTES,
    MODULE_SHAPES,
    clamp,
    normalizeHex,
    relativeLuminance,
    contrastRatio,
    validatePalette,
    utf8Bytes,
    normalizeErrorLevel,
    createMatrix,
    normalizeOptions,
    isFinderCell,
    layoutFor,
    logoGeometry,
    isSafeImageDataUrl,
    drawCanvas,
    createSvg,
    sanitizeSvgText,
    safeFilename,
    createExportRequest,
    createExportConfirmation,
  });
});
