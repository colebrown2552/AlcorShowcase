/**
 * alcor-photo-svg.js: AlcorPhoto SVG rendering.
 *
 * Renders a document to SVG for display and for SVG export.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AlcorPhotoSvg = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_SVG_DIMENSION = 8192;
  const MAX_SVG_PIXELS = 4 * 1024 * 1024;
  const MAX_RASTER_BYTES = 16 * 1024 * 1024;
  const MAX_SVG_BYTES = 24 * 1024 * 1024;
  const VECTOR_MAX_PIXELS = 256 * 1024;
  const VECTOR_MAX_COLORS = 32;
  const VECTOR_MAX_RECTANGLES = 20000;
  const MAX_CANDIDATES = 3;
  const PNG_SIGNATURE = Object.freeze([137, 80, 78, 71, 13, 10, 26, 10]);

  function escapeXml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function minifySvg(value) {
    return String(value == null ? '' : value)
      .replace(/\r\n?/g, '\n')
      .replace(/>\s+</g, '><')
      .replace(/\n/g, '')
      .trim();
  }

  function utf8ByteLength(value) {
    const text = String(value == null ? '' : value);
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).byteLength;
    if (typeof Buffer === 'function') return Buffer.byteLength(text, 'utf8');
    throw new Error('UTF-8 measurement is unavailable.');
  }

  function assertDimensions(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
      throw new Error('SVG dimensions must be positive integers.');
    if (width > MAX_SVG_DIMENSION || height > MAX_SVG_DIMENSION)
      throw new Error(`SVG export is limited to ${MAX_SVG_DIMENSION} pixels per side.`);
    if (width * height > MAX_SVG_PIXELS)
      throw new Error(`SVG export is limited to ${MAX_SVG_PIXELS} pixels.`);
  }

  function readUint32(bytes, offset) {
    return (
      (bytes[offset] * 0x1000000 +
        (bytes[offset + 1] << 16) +
        (bytes[offset + 2] << 8) +
        bytes[offset + 3]) >>>
      0
    );
  }

  function pngMetadata(bytes) {
    if (bytes.byteLength < 33) throw new Error('SVG raster fallback PNG is truncated.');
    if (
      String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== 'IHDR' ||
      readUint32(bytes, 8) !== 13
    )
      throw new Error('SVG raster fallback PNG has no valid IHDR.');
    const width = readUint32(bytes, 16);
    const height = readUint32(bytes, 20);
    const bitDepth = bytes[24];
    const colorType = bytes[25];
    if (
      width < 1 ||
      height < 1 ||
      ![0, 2, 3, 4, 6].includes(colorType) ||
      ![1, 2, 4, 8, 16].includes(bitDepth)
    )
      throw new Error('SVG raster fallback PNG metadata is invalid.');
    return { width, height, bitDepth, colorType, hasAlpha: colorType === 4 || colorType === 6 };
  }

  function normalizePngBytes(value, width, height) {
    if (!(value instanceof Uint8Array))
      throw new Error('A PNG byte array is required for the SVG fallback.');
    if (value.byteLength < PNG_SIGNATURE.length || value.byteLength > MAX_RASTER_BYTES)
      throw new Error(
        `SVG raster fallback PNG must be between ${PNG_SIGNATURE.length} and ${MAX_RASTER_BYTES} bytes.`,
      );
    for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
      if (value[index] !== PNG_SIGNATURE[index])
        throw new Error('SVG raster fallback is not a PNG file.');
    }
    const metadata = pngMetadata(value);
    if (metadata.width !== width || metadata.height !== height)
      throw new Error('SVG raster fallback PNG dimensions do not match the SVG viewport.');
    return value;
  }

  function bytesToBase64(bytes) {
    if (typeof Buffer === 'function')
      return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
    if (typeof btoa !== 'function') throw new Error('Base64 encoding is unavailable.');
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      binary += String.fromCharCode(
        ...bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize)),
      );
    }
    return btoa(binary);
  }

  function svgOpen(width, height) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;
  }

  function svgTitle(title) {
    const text =
      String(title == null ? 'AlcorPhoto export' : title)
        .trim()
        .slice(0, 120) || 'AlcorPhoto export';
    return `<title>${escapeXml(text)}</title>`;
  }

  function shortHex(red, green, blue) {
    const full = `#${red.toString(16).padStart(2, '0')}${green.toString(16).padStart(2, '0')}${blue.toString(16).padStart(2, '0')}`;
    return full[1] === full[2] && full[3] === full[4] && full[5] === full[6]
      ? `#${full[1]}${full[3]}${full[5]}`
      : full;
  }

  function alphaValue(alpha) {
    if (alpha >= 255) return '';
    const value = (alpha / 255).toFixed(6).replace(/0+$/, '').replace(/^0\./, '.');
    return value || '0';
  }

  function normalizeImageData(value, width, height) {
    if (value == null) return null;
    const bytes = value?.data;
    const isByteArray =
      bytes instanceof Uint8Array ||
      (typeof Uint8ClampedArray === 'function' && bytes instanceof Uint8ClampedArray);
    if (
      !value ||
      value.width !== width ||
      value.height !== height ||
      !isByteArray ||
      bytes.byteLength !== width * height * 4
    ) {
      throw new Error('Malformed SVG palette image data.');
    }
    return value;
  }

  function colorKey(data, offset) {
    return `${data[offset]},${data[offset + 1]},${data[offset + 2]},${data[offset + 3]}`;
  }

  function paletteRectangles(imageData) {
    const { width, height, data } = imageData;
    if (width * height > VECTOR_MAX_PIXELS) return null;
    const colors = new Set();
    const finished = [];
    let active = new Map();

    for (let y = 0; y < height; y += 1) {
      const next = new Map();
      let x = 0;
      while (x < width) {
        const offset = (y * width + x) * 4;
        const rgba = colorKey(data, offset);
        colors.add(rgba);
        if (colors.size > VECTOR_MAX_COLORS) return null;
        let end = x + 1;
        while (end < width && colorKey(data, (y * width + end) * 4) === rgba) end += 1;
        const alpha = data[offset + 3];
        if (alpha > 0) {
          const runKey = `${rgba}:${x}:${end - x}`;
          const prior = active.get(runKey);
          const rectangle = prior || { x, y, width: end - x, height: 0, rgba };
          rectangle.height += 1;
          next.set(runKey, rectangle);
        }
        x = end;
      }
      for (const [key, rectangle] of active) if (!next.has(key)) finished.push(rectangle);
      if (finished.length + next.size > VECTOR_MAX_RECTANGLES) return null;
      active = next;
    }
    finished.push(...active.values());
    if (finished.length > VECTOR_MAX_RECTANGLES) return null;
    finished.sort(
      (left, right) =>
        left.rgba.localeCompare(right.rgba) ||
        left.y - right.y ||
        left.x - right.x ||
        left.height - right.height ||
        left.width - right.width,
    );
    return { colors: colors.size, rectangles: finished };
  }

  function vectorCandidate(width, height, title, imageData) {
    const packed = paletteRectangles(imageData);
    if (!packed) return null;
    const groups = new Map();
    for (const rectangle of packed.rectangles) {
      if (!groups.has(rectangle.rgba)) groups.set(rectangle.rgba, []);
      groups.get(rectangle.rgba).push(rectangle);
    }
    let shapes = '';
    for (const [rgba, rectangles] of groups) {
      const [red, green, blue, alpha] = rgba.split(',').map(Number);
      const opacity = alphaValue(alpha);
      const commands = rectangles
        .map(
          (rectangle) =>
            `M${rectangle.x} ${rectangle.y}h${rectangle.width}v${rectangle.height}H${rectangle.x}z`,
        )
        .join('');
      shapes += `<path fill="${shortHex(red, green, blue)}"${opacity ? ` fill-opacity="${opacity}"` : ''} d="${commands}"/>`;
    }
    return {
      id: 'palette-rectangles',
      kind: 'vector-rectangles',
      label: 'vector SVG',
      vector: true,
      colors: packed.colors,
      rectangles: packed.rectangles.length,
      text: `${svgOpen(width, height)}${svgTitle(title)}${shapes}</svg>`,
    };
  }

  function rasterCandidates(width, height, title, pngBytes) {
    const payload = `data:image/png;base64,${bytesToBase64(pngBytes)}`;
    const open = `${svgOpen(width, height)}${svgTitle(title)}`;
    return [
      {
        id: 'raster-compact',
        kind: 'raster-wrapper',
        label: 'image embedded in SVG',
        vector: false,
        text: `${open}<image width="${width}" height="${height}" href="${payload}"/></svg>`,
      },
    ];
  }

  function normalizeCandidate(candidate, width, height) {
    if (!candidate || !/^[a-z][a-z0-9-]{1,63}$/.test(String(candidate.id || '')))
      throw new Error('SVG candidate id is invalid.');
    if (!['vector-rectangles', 'raster-wrapper'].includes(candidate.kind))
      throw new Error('SVG candidate kind is invalid.');
    if (typeof candidate.text !== 'string' || candidate.text.length > MAX_SVG_BYTES)
      throw new Error(`SVG candidate ${candidate.id} exceeds the enforced byte limit.`);
    const text = minifySvg(candidate.text);
    if (!validateSvgCandidate(text, width, height, candidate.kind))
      throw new Error(`SVG candidate ${candidate.id} is malformed.`);
    const bytes = utf8ByteLength(text);
    if (bytes < 1 || bytes > MAX_SVG_BYTES)
      throw new Error(`SVG candidate ${candidate.id} exceeds the enforced byte limit.`);
    return Object.freeze({
      id: candidate.id,
      kind: candidate.kind,
      label: String(candidate.label || '').slice(0, 120),
      vector: candidate.vector === true,
      colors: Number.isInteger(candidate.colors) ? candidate.colors : null,
      rectangles: Number.isInteger(candidate.rectangles) ? candidate.rectangles : null,
      text,
      bytes,
    });
  }

  function validateSvgCandidate(text, width, height, kind) {
    if (
      typeof text !== 'string' ||
      text.length < 40 ||
      !Number.isInteger(width) ||
      !Number.isInteger(height)
    )
      return false;
    const expected = `${svgOpen(width, height)}`;
    if (!text.startsWith(expected) || !text.endsWith('</svg>')) return false;
    if (
      /<!DOCTYPE|<!ENTITY|<script\b|\son[a-z]+\s*=|javascript:|xlink:href|url\s*\(|<!--|<\?|<!\[CDATA\[/i.test(
        text,
      )
    )
      return false;
    if ((text.match(/<svg\b/g) || []).length !== 1 || (text.match(/<\/svg>/g) || []).length !== 1)
      return false;
    const tags = text.match(/<\/?([A-Za-z][A-Za-z0-9:-]*)\b/g) || [];
    if (
      tags.some(
        (tag) =>
          !['svg', '/svg', 'title', '/title', 'image', 'path'].includes(tag.replace(/^</, '')),
      )
    )
      return false;
    const hrefs = [...text.matchAll(/\shref="([^"]*)"/g)].map((match) => match[1]);
    if (hrefs.some((href) => !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(href)))
      return false;
    if (kind === 'raster-wrapper' && (hrefs.length !== 1 || !text.includes('<image ')))
      return false;
    if (kind === 'vector-rectangles' && (hrefs.length !== 0 || text.includes('<image ')))
      return false;
    if (kind === 'raster-wrapper') {
      const base64 = hrefs[0].slice('data:image/png;base64,'.length);
      const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
      const decodedLength = (base64.length * 3) / 4 - padding;
      if (
        !Number.isInteger(decodedLength) ||
        decodedLength < 33 ||
        decodedLength > MAX_RASTER_BYTES
      )
        return false;
      try {
        const headerText = base64.slice(0, 44);
        let header;
        if (typeof Buffer === 'function')
          header = new Uint8Array(Buffer.from(headerText, 'base64'));
        else {
          const binary = atob(headerText);
          header = Uint8Array.from(binary, (value) => value.charCodeAt(0));
        }
        const metadata = pngMetadata(header);
        if (metadata.width !== width || metadata.height !== height) return false;
      } catch (error) {
        return false;
      }
    }
    return true;
  }

  function selectSmallestValidCandidate(candidates, options) {
    const width = options?.width;
    const height = options?.height;
    assertDimensions(width, height);
    if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > MAX_CANDIDATES)
      throw new Error(`SVG export requires between 1 and ${MAX_CANDIDATES} candidates.`);
    const ids = new Set();
    const valid = [];
    let rejectedCandidateCount = 0;
    for (const candidate of candidates) {
      try {
        const normalized = normalizeCandidate(candidate, width, height);
        if (ids.has(normalized.id)) throw new Error('Duplicate SVG candidate id.');
        ids.add(normalized.id);
        valid.push(normalized);
      } catch (error) {
        rejectedCandidateCount += 1;
      }
    }
    if (!valid.length) throw new Error('No valid SVG could be generated.');
    valid.sort((left, right) => left.bytes - right.bytes || left.id.localeCompare(right.id));
    const selected = valid[0];
    return Object.freeze({
      ...selected,
      candidateCount: valid.length,
      rejectedCandidateCount,
      candidates: Object.freeze(
        valid.map((candidate) =>
          Object.freeze({
            id: candidate.id,
            kind: candidate.kind,
            label: candidate.label,
            vector: candidate.vector,
            colors: candidate.colors,
            rectangles: candidate.rectangles,
            bytes: candidate.bytes,
          }),
        ),
      ),
    });
  }

  function generateSvgCandidates(options = {}) {
    const width = options.width;
    const height = options.height;
    assertDimensions(width, height);
    const pngBytes = normalizePngBytes(options.pngBytes, width, height);
    const imageData = normalizeImageData(options.imageData, width, height);
    const candidates = rasterCandidates(width, height, options.title, pngBytes);
    if (imageData) {
      const vector = vectorCandidate(width, height, options.title, imageData);
      if (vector) candidates.push(vector);
    }
    return Object.freeze(
      candidates.map((candidate) => normalizeCandidate(candidate, width, height)),
    );
  }

  function createSvgExport(options = {}) {
    const candidates = generateSvgCandidates(options);
    return selectSmallestValidCandidate(candidates, {
      width: options.width,
      height: options.height,
    });
  }

  return Object.freeze({
    version: '0.2.0',
    MAX_SVG_DIMENSION,
    MAX_SVG_PIXELS,
    MAX_RASTER_BYTES,
    MAX_SVG_BYTES,
    VECTOR_MAX_PIXELS,
    VECTOR_MAX_COLORS,
    VECTOR_MAX_RECTANGLES,
    MAX_CANDIDATES,
    escapeXml,
    minifySvg,
    utf8ByteLength,
    validateSvgCandidate,
    selectSmallestValidCandidate,
    generateSvgCandidates,
    createSvgExport,
  });
});
