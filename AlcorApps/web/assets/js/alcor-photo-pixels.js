/**
 * alcor-photo-pixels.js: AlcorPhoto pixel engine.
 *
 * Raster operations (filters, adjustments, blending). Runs in a Web Worker when
 * available so large images do not block the page; falls back to the main thread.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.AlcorPhotoPixels = api;
    // Worker mode: the same file runs pixel jobs off the main thread.
    if (typeof root.WorkerGlobalScope === 'function' && root instanceof root.WorkerGlobalScope)
      api.serveWorker(root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Pure pixel algorithms for AlcorPhoto. Every image is a plain
  // { width, height, data: Uint8ClampedArray(width * height * 4) } in
  // straight (non-premultiplied) RGBA; every selection or mask is a
  // Uint8ClampedArray(width * height) of coverage 0..255. Nothing here
  // touches the DOM, the network, or global state.

  const MAX_PIXELS = 64 * 1024 * 1024;
  const clampNumber = (value, min, max, fallback = min) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const clamp255 = (value) => (value < 0 ? 0 : value > 255 ? 255 : value);

  function assertImage(image, label = 'image') {
    if (
      !image ||
      !Number.isInteger(image.width) ||
      !Number.isInteger(image.height) ||
      image.width < 1 ||
      image.height < 1
    )
      throw new Error(`A valid ${label} is required.`);
    if (image.width * image.height > MAX_PIXELS)
      throw new Error(
        `The ${label} exceeds the ${MAX_PIXELS.toLocaleString('en-US')} pixel budget.`,
      );
    if (!image.data || image.data.length !== image.width * image.height * 4)
      throw new Error(`The ${label} pixel buffer does not match its dimensions.`);
    return image;
  }

  function assertMask(mask, width, height) {
    if (!mask || mask.length !== width * height)
      throw new Error('The selection does not match the image dimensions.');
    return mask;
  }

  function createImage(width, height, fill = null) {
    const w = Math.round(width);
    const h = Math.round(height);
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w * h > MAX_PIXELS)
      throw new Error('Image dimensions are outside the pixel budget.');
    const data = new Uint8ClampedArray(w * h * 4);
    if (fill)
      for (let i = 0; i < data.length; i += 4) {
        data[i] = fill.r;
        data[i + 1] = fill.g;
        data[i + 2] = fill.b;
        data[i + 3] = fill.a == null ? 255 : fill.a;
      }
    return { width: w, height: h, data };
  }

  function cloneImage(image) {
    assertImage(image);
    return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
  }

  function createMask(width, height, value = 0) {
    const mask = new Uint8ClampedArray(width * height);
    if (value) mask.fill(value);
    return mask;
  }

  // ---------------------------------------------------------------- color

  function parseHex(value, fallback = { r: 0, g: 0, b: 0 }) {
    const text = String(value || '')
      .trim()
      .replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(text))
      return {
        r: parseInt(text[0] + text[0], 16),
        g: parseInt(text[1] + text[1], 16),
        b: parseInt(text[2] + text[2], 16),
      };
    if (/^[0-9a-f]{6}$/i.test(text))
      return {
        r: parseInt(text.slice(0, 2), 16),
        g: parseInt(text.slice(2, 4), 16),
        b: parseInt(text.slice(4, 6), 16),
      };
    return { ...fallback };
  }

  function toHex(color) {
    const part = (value) =>
      Math.round(clamp255(Number(value) || 0))
        .toString(16)
        .padStart(2, '0');
    return `#${part(color.r)}${part(color.g)}${part(color.b)}`;
  }

  function rgbToHsb(color) {
    const r = color.r / 255,
      g = color.g / 255,
      b = color.b / 255;
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b),
      delta = max - min;
    let h = 0;
    if (delta > 0) {
      if (max === r) h = ((g - b) / delta) % 6;
      else if (max === g) h = (b - r) / delta + 2;
      else h = (r - g) / delta + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h, s: max === 0 ? 0 : (delta / max) * 100, b: max * 100 };
  }

  function hsbToRgb(hsb) {
    const h = (((Number(hsb.h) % 360) + 360) % 360) / 60;
    const s = clampNumber(hsb.s, 0, 100, 0) / 100;
    const v = clampNumber(hsb.b, 0, 100, 0) / 100;
    const c = v * s,
      x = c * (1 - Math.abs((h % 2) - 1)),
      m = v - c;
    const [r, g, b] =
      h < 1
        ? [c, x, 0]
        : h < 2
          ? [x, c, 0]
          : h < 3
            ? [0, c, x]
            : h < 4
              ? [0, x, c]
              : h < 5
                ? [x, 0, c]
                : [c, 0, x];
    return {
      r: Math.round((r + m) * 255),
      g: Math.round((g + m) * 255),
      b: Math.round((b + m) * 255),
    };
  }

  // HSL helpers on 0..1 floats; used by Hue/Saturation and luminosity-preserving adjustments.
  function rgbToHsl(r, g, b) {
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h / 6, s, l];
  }

  function hueToRgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }

  function hslToRgb(h, s, l) {
    if (s === 0) return [l, l, l];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [hueToRgb(p, q, h + 1 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1 / 3)];
  }

  const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

  // ---------------------------------------------------------------- brush

  // Alpha falloff for a round tip. distance is 0 at the center and 1 at the rim.
  function brushFalloff(distance, hardness) {
    const h = clampNumber(hardness, 0, 1, 1);
    if (distance >= 1) return 0;
    if (distance <= h) return 1;
    const t = (distance - h) / (1 - h);
    return 1 - t * t * (3 - 2 * t);
  }

  // A square alpha tip. Hard tips keep a one-pixel anti-aliased rim.
  function brushTip(diameter, hardness = 1) {
    const d = clampNumber(diameter, 1, 5000, 1);
    const size = Math.max(1, Math.ceil(d) + 2);
    const radius = d / 2;
    const center = size / 2;
    const data = new Uint8ClampedArray(size * size);
    const h = clampNumber(hardness, 0, 1, 1);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const dist = Math.hypot(x + 0.5 - center, y + 0.5 - center);
        let alpha;
        if (h >= 0.999 || radius < 1.5) alpha = clampNumber(radius - dist + 0.5, 0, 1, 0);
        else alpha = brushFalloff(dist / radius, h);
        data[y * size + x] = Math.round(alpha * 255);
      }
    }
    return { size, radius, hardness: h, data };
  }

  // Place dabs every `spacing` pixels along a segment, carrying the
  // remainder between segments so a stroke's rhythm does not reset.
  function spacedDabs(from, to, spacing, carry = 0) {
    const step = Math.max(0.25, Number(spacing) || 1);
    const dx = to.x - from.x,
      dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    const points = [];
    let distance = step - (Number(carry) || 0);
    if (distance < 0) distance = 0;
    while (distance <= length) {
      const t = length === 0 ? 0 : distance / length;
      points.push({ x: from.x + dx * t, y: from.y + dy * t });
      distance += step;
      if (points.length > 100000) break;
    }
    const lastDistance = distance - step;
    return { points, carry: length - lastDistance < 0 ? 0 : length - lastDistance };
  }

  // ---------------------------------------------------------------- flood fill / wand

  // Scanline flood fill. A pixel matches when every RGBA channel is within
  // `tolerance` of the seed (the channel-maximum rule). Returns a 0/255 mask.
  function floodSelect(image, seedX, seedY, options = {}) {
    assertImage(image);
    const { width, height, data } = image;
    const x0 = Math.floor(seedX),
      y0 = Math.floor(seedY);
    const mask = createMask(width, height);
    if (x0 < 0 || y0 < 0 || x0 >= width || y0 >= height) return mask;
    const tolerance = clampNumber(options.tolerance, 0, 255, 32);
    const contiguous = options.contiguous !== false;
    const s = (y0 * width + x0) * 4;
    const sr = data[s],
      sg = data[s + 1],
      sb = data[s + 2],
      sa = data[s + 3];
    const matches = (index) => {
      const i = index * 4;
      return (
        Math.abs(data[i] - sr) <= tolerance &&
        Math.abs(data[i + 1] - sg) <= tolerance &&
        Math.abs(data[i + 2] - sb) <= tolerance &&
        Math.abs(data[i + 3] - sa) <= tolerance
      );
    };
    if (!contiguous) {
      for (let index = 0; index < width * height; index += 1) if (matches(index)) mask[index] = 255;
    } else {
      const stack = [x0, y0];
      while (stack.length) {
        const y = stack.pop();
        let x = stack.pop();
        let index = y * width + x;
        while (x >= 0 && !mask[index] && matches(index)) {
          x -= 1;
          index -= 1;
        }
        x += 1;
        index += 1;
        let spanUp = false,
          spanDown = false;
        while (x < width && !mask[index] && matches(index)) {
          mask[index] = 255;
          if (y > 0) {
            const up = index - width;
            if (!mask[up] && matches(up)) {
              if (!spanUp) {
                stack.push(x, y - 1);
                spanUp = true;
              }
            } else spanUp = false;
          }
          if (y < height - 1) {
            const down = index + width;
            if (!mask[down] && matches(down)) {
              if (!spanDown) {
                stack.push(x, y + 1);
                spanDown = true;
              }
            } else spanDown = false;
          }
          x += 1;
          index += 1;
        }
      }
    }
    if (options.antiAlias) return softenEdges(mask, width, height);
    return mask;
  }

  // Select > Color Range: soft selection of every pixel near a color.
  // Coverage falls linearly from 255 at the color to 0 at `fuzziness` (channel-max distance).
  function colorRangeMask(image, color, fuzziness = 40) {
    assertImage(image);
    const c = typeof color === 'string' ? parseHex(color) : color;
    const fuzz = clampNumber(fuzziness, 0, 255, 40);
    const mask = new Uint8ClampedArray(image.width * image.height);
    const d = image.data;
    for (let p = 0, i = 0; p < mask.length; p += 1, i += 4) {
      if (d[i + 3] === 0) continue;
      const dist = Math.max(
        Math.abs(d[i] - c.r),
        Math.abs(d[i + 1] - c.g),
        Math.abs(d[i + 2] - c.b),
      );
      mask[p] =
        fuzz === 0 ? (dist === 0 ? 255 : 0) : (Math.max(0, 1 - dist / fuzz) * 255 * d[i + 3]) / 255;
    }
    return mask;
  }

  // One-pixel edge softening: boundary pixels take the 3x3 mean.
  function softenEdges(mask, width, height) {
    const out = new Uint8ClampedArray(mask);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x;
        const v = mask[i];
        const l = x > 0 ? mask[i - 1] : v,
          r = x < width - 1 ? mask[i + 1] : v;
        const u = y > 0 ? mask[i - width] : v,
          d = y < height - 1 ? mask[i + width] : v;
        if (l === v && r === v && u === v && d === v) continue;
        let sum = 0,
          count = 0;
        for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy += 1) {
          for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx += 1) {
            sum += mask[yy * width + xx];
            count += 1;
          }
        }
        out[i] = Math.round(sum / count);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- selection masks

  // Even-odd polygon fill with 4 vertical sub-samples and exact horizontal
  // span coverage, so edges are anti-aliased without a canvas.
  function rasterizePolygon(width, height, points, options = {}) {
    const mask = createMask(width, height);
    if (!Array.isArray(points) || points.length < 3) return mask;
    const pts = points
      .map((p) => ({ x: Number(p.x), y: Number(p.y) }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (pts.length < 3) return mask;
    const antialias = options.antialias !== false;
    const samples = antialias ? 4 : 1;
    let minY = Infinity,
      maxY = -Infinity;
    for (const p of pts) {
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const y0 = Math.max(0, Math.floor(minY)),
      y1 = Math.min(height - 1, Math.ceil(maxY));
    const coverage = new Float32Array(width + 2);
    const crossings = [];
    const n = pts.length;
    for (let y = y0; y <= y1; y += 1) {
      coverage.fill(0);
      for (let s = 0; s < samples; s += 1) {
        const sy = y + (s + 0.5) / samples;
        crossings.length = 0;
        for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
          const a = pts[j],
            b = pts[i];
          if (a.y > sy !== b.y > sy) crossings.push(a.x + ((sy - a.y) * (b.x - a.x)) / (b.y - a.y));
        }
        if (crossings.length < 2) continue;
        crossings.sort((p, q) => p - q);
        for (let k = 0; k + 1 < crossings.length; k += 2) {
          let left = crossings[k],
            right = crossings[k + 1];
          if (!antialias) {
            left = Math.round(left);
            right = Math.round(right);
          }
          if (right <= 0 || left >= width) continue;
          left = Math.max(0, left);
          right = Math.min(width, right);
          const li = Math.floor(left),
            ri = Math.floor(right);
          if (li === ri) {
            coverage[li] += right - left;
            continue;
          }
          coverage[li] += li + 1 - left;
          for (let x = li + 1; x < ri; x += 1) coverage[x] += 1;
          if (ri < width) coverage[ri] += right - ri;
        }
      }
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        const c = coverage[x] / samples;
        if (c > 0) mask[row + x] = Math.round(Math.min(1, c) * 255);
      }
    }
    return mask;
  }

  function rectanglePoints(x, y, width, height) {
    const left = Math.min(x, x + width),
      top = Math.min(y, y + height);
    const w = Math.abs(width),
      h = Math.abs(height);
    return [
      { x: left, y: top },
      { x: left + w, y: top },
      { x: left + w, y: top + h },
      { x: left, y: top + h },
    ];
  }

  function ellipsePoints(x, y, width, height) {
    const rx = Math.abs(width) / 2,
      ry = Math.abs(height) / 2;
    const cx = Math.min(x, x + width) + rx,
      cy = Math.min(y, y + height) + ry;
    const segments = Math.max(24, Math.min(720, Math.ceil((Math.PI * (rx + ry)) / 2)));
    return Array.from({ length: segments }, (_, i) => {
      const a = (i / segments) * Math.PI * 2;
      return { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry };
    });
  }

  function rectangleMask(width, height, rect, antialias = true) {
    return rasterizePolygon(
      width,
      height,
      rectanglePoints(rect.x, rect.y, rect.width, rect.height),
      { antialias },
    );
  }

  function ellipseMask(width, height, rect, antialias = true) {
    return rasterizePolygon(width, height, ellipsePoints(rect.x, rect.y, rect.width, rect.height), {
      antialias,
    });
  }

  const SELECTION_OPERATIONS = Object.freeze(['new', 'add', 'subtract', 'intersect']);

  function combineMasks(base, incoming, operation = 'new') {
    if (!incoming) throw new Error('A selection is required.');
    if (!base || operation === 'new') return new Uint8ClampedArray(incoming);
    if (base.length !== incoming.length) throw new Error('Selections must share dimensions.');
    const out = new Uint8ClampedArray(base.length);
    if (operation === 'add')
      for (let i = 0; i < out.length; i += 1)
        out[i] = base[i] > incoming[i] ? base[i] : incoming[i];
    else if (operation === 'subtract')
      for (let i = 0; i < out.length; i += 1) out[i] = (base[i] * (255 - incoming[i]) + 127) / 255;
    else if (operation === 'intersect')
      for (let i = 0; i < out.length; i += 1) out[i] = (base[i] * incoming[i] + 127) / 255;
    else throw new Error('Choose new, add, subtract, or intersect.');
    return out;
  }

  function invertMask(mask) {
    const out = new Uint8ClampedArray(mask.length);
    for (let i = 0; i < mask.length; i += 1) out[i] = 255 - mask[i];
    return out;
  }

  function maskBounds(mask, width, height, threshold = 1) {
    assertMask(mask, width, height);
    let minX = width,
      minY = height,
      maxX = -1,
      maxY = -1;
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        if (mask[row + x] < threshold) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        maxY = y;
      }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }

  function maskCoverage(mask) {
    let sum = 0;
    for (let i = 0; i < mask.length; i += 1) sum += mask[i];
    return sum / 255;
  }

  // Three box passes approximate a Gaussian with standard deviation sigma.
  function boxSizesForGauss(sigma, passes = 3) {
    const ideal = Math.sqrt((12 * sigma * sigma) / passes + 1);
    let lower = Math.floor(ideal);
    if (lower % 2 === 0) lower -= 1;
    const upper = lower + 2;
    const m = Math.round(
      (12 * sigma * sigma - passes * lower * lower - 4 * passes * lower - 3 * passes) /
        (-4 * lower - 4),
    );
    return Array.from({ length: passes }, (_, i) => (i < m ? lower : upper));
  }

  // Box blur of `channels` interleaved channels, radius r, edge-clamped.
  // Horizontal passes slide along rows; vertical passes slide whole rows so
  // memory is read sequentially (much faster than striding down columns).
  function boxBlurPass(src, dst, width, height, channels, radius, horizontal) {
    const r = Math.max(0, Math.floor(radius));
    if (r === 0) {
      dst.set(src);
      return;
    }
    const inv = 1 / (r * 2 + 1);
    if (horizontal && channels === 4) {
      // Unrolled RGBA path: the common case for image filters.
      const rowLength = width * 4,
        last = (width - 1) * 4;
      for (let y = 0; y < height; y += 1) {
        const base = y * rowLength;
        let s0 = src[base] * (r + 1),
          s1 = src[base + 1] * (r + 1),
          s2 = src[base + 2] * (r + 1),
          s3 = src[base + 3] * (r + 1);
        for (let k = 1; k <= r; k += 1) {
          const j = base + Math.min(width - 1, k) * 4;
          s0 += src[j];
          s1 += src[j + 1];
          s2 += src[j + 2];
          s3 += src[j + 3];
        }
        for (let x = 0; x < width; x += 1) {
          const o = base + x * 4;
          dst[o] = (s0 * inv + 0.5) | 0;
          dst[o + 1] = (s1 * inv + 0.5) | 0;
          dst[o + 2] = (s2 * inv + 0.5) | 0;
          dst[o + 3] = (s3 * inv + 0.5) | 0;
          const a = base + (x + r + 1 < width ? (x + r + 1) * 4 : last),
            m = base + (x - r > 0 ? (x - r) * 4 : 0);
          s0 += src[a] - src[m];
          s1 += src[a + 1] - src[m + 1];
          s2 += src[a + 2] - src[m + 2];
          s3 += src[a + 3] - src[m + 3];
        }
      }
      return;
    }
    if (horizontal) {
      const rowLength = width * channels;
      const sums = new Float64Array(channels);
      const last = (width - 1) * channels;
      for (let y = 0; y < height; y += 1) {
        const base = y * rowLength;
        for (let c = 0; c < channels; c += 1) {
          let sum = src[base + c] * (r + 1);
          for (let k = 1; k <= r; k += 1) sum += src[base + Math.min(width - 1, k) * channels + c];
          sums[c] = sum;
        }
        for (let x = 0; x < width; x += 1) {
          const out = base + x * channels;
          const add = base + (x + r + 1 < width ? (x + r + 1) * channels : last);
          const remove = base + (x - r > 0 ? (x - r) * channels : 0);
          for (let c = 0; c < channels; c += 1) {
            dst[out + c] = (sums[c] * inv + 0.5) | 0;
            sums[c] += src[add + c] - src[remove + c];
          }
        }
      }
      return;
    }
    const rowLength = width * channels;
    const sums = new Float64Array(rowLength);
    for (let i = 0; i < rowLength; i += 1) {
      let sum = src[i] * (r + 1);
      for (let k = 1; k <= r; k += 1) sum += src[Math.min(height - 1, k) * rowLength + i];
      sums[i] = sum;
    }
    for (let y = 0; y < height; y += 1) {
      const out = y * rowLength;
      const add = (y + r + 1 < height ? y + r + 1 : height - 1) * rowLength;
      const remove = (y - r > 0 ? y - r : 0) * rowLength;
      for (let i = 0; i < rowLength; i += 1) {
        dst[out + i] = (sums[i] * inv + 0.5) | 0;
        sums[i] += src[add + i] - src[remove + i];
      }
    }
  }

  function gaussianChannels(data, width, height, channels, sigma) {
    if (!(sigma > 0)) return new Uint8ClampedArray(data);
    // Plain Uint8Array stores are cheaper than clamped ones; averages never leave 0..255.
    const a = new Uint8Array(data);
    const b = new Uint8Array(data.length);
    for (const size of boxSizesForGauss(sigma)) {
      const radius = (size - 1) / 2;
      boxBlurPass(a, b, width, height, channels, radius, true);
      boxBlurPass(b, a, width, height, channels, radius, false);
    }
    return new Uint8ClampedArray(a.buffer, a.byteOffset, a.length);
  }

  function featherMask(mask, width, height, radius) {
    assertMask(mask, width, height);
    const r = clampNumber(radius, 0, 1000, 0);
    if (r <= 0) return new Uint8ClampedArray(mask);
    return gaussianChannels(mask, width, height, 1, r / 2);
  }

  // Separable running max/min (square structuring element).
  function morphology(mask, width, height, radius, grow) {
    const r = Math.round(clampNumber(radius, 0, 500, 0));
    if (r === 0) return new Uint8ClampedArray(mask);
    const pick = grow ? Math.max : Math.min;
    const pass = (src, horizontal) => {
      const dst = new Uint8ClampedArray(src.length);
      const lines = horizontal ? height : width,
        length = horizontal ? width : height;
      const stride = horizontal ? 1 : width,
        lineStride = horizontal ? width : 1;
      const line = new Uint8ClampedArray(length);
      for (let l = 0; l < lines; l += 1) {
        const base = l * lineStride;
        for (let i = 0; i < length; i += 1) line[i] = src[base + i * stride];
        for (let i = 0; i < length; i += 1) {
          let v = line[i];
          const from = Math.max(0, i - r),
            to = Math.min(length - 1, i + r);
          for (let k = from; k <= to; k += 1) v = pick(v, line[k]);
          dst[base + i * stride] = v;
        }
      }
      return dst;
    };
    return pass(pass(mask, true), false);
  }

  const expandMask = (mask, width, height, radius) => morphology(mask, width, height, radius, true);
  const contractMask = (mask, width, height, radius) =>
    morphology(mask, width, height, radius, false);

  // Boundary as merged horizontal/vertical runs: [x0, y0, x1, y1, ...].
  function maskOutline(mask, width, height, threshold = 128) {
    assertMask(mask, width, height);
    const segments = [];
    const inside = (x, y) =>
      x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] >= threshold;
    for (let y = 0; y <= height; y += 1) {
      let start = -1;
      for (let x = 0; x <= width; x += 1) {
        const edge = x < width && inside(x, y - 1) !== inside(x, y);
        if (edge && start < 0) start = x;
        if (!edge && start >= 0) {
          segments.push(start, y, x, y);
          start = -1;
        }
      }
    }
    for (let x = 0; x <= width; x += 1) {
      let start = -1;
      for (let y = 0; y <= height; y += 1) {
        const edge = y < height && inside(x - 1, y) !== inside(x, y);
        if (edge && start < 0) start = y;
        if (!edge && start >= 0) {
          segments.push(x, start, x, y);
          start = -1;
        }
      }
    }
    return new Float32Array(segments);
  }

  // Area-average downsample for previews (factor chosen from maxSide).
  function downsampleMask(mask, width, height, maxSide) {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    if (scale >= 1) return { mask: new Uint8ClampedArray(mask), width, height, scale: 1 };
    const w = Math.max(1, Math.round(width * scale)),
      h = Math.max(1, Math.round(height * scale));
    const out = new Uint8ClampedArray(w * h);
    const sx = width / w,
      sy = height / h;
    for (let y = 0; y < h; y += 1) {
      const y0 = Math.floor(y * sy),
        y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      for (let x = 0; x < w; x += 1) {
        const x0 = Math.floor(x * sx),
          x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
        let sum = 0,
          count = 0;
        for (let yy = y0; yy < y1; yy += 1)
          for (let xx = x0; xx < x1; xx += 1) {
            sum += mask[yy * width + xx];
            count += 1;
          }
        out[y * w + x] = Math.round(sum / count);
      }
    }
    return { mask: out, width: w, height: h, scale: w / width };
  }

  // ---------------------------------------------------------------- pixel editing with selections

  // out = original + (processed - original) * weight, weight = mask/255 * opacity.
  function mixImages(original, processed, mask = null, opacity = 1) {
    assertImage(original);
    assertImage(processed, 'processed image');
    if (original.width !== processed.width || original.height !== processed.height)
      throw new Error('Images must share dimensions.');
    if (mask) assertMask(mask, original.width, original.height);
    const o = clampNumber(opacity, 0, 1, 1);
    const a = original.data,
      b = processed.data;
    const out = new Uint8ClampedArray(a.length);
    for (let p = 0, i = 0; i < a.length; p += 1, i += 4) {
      const w = (mask ? mask[p] / 255 : 1) * o;
      if (w <= 0) {
        out[i] = a[i];
        out[i + 1] = a[i + 1];
        out[i + 2] = a[i + 2];
        out[i + 3] = a[i + 3];
        continue;
      }
      if (w >= 1) {
        out[i] = b[i];
        out[i + 1] = b[i + 1];
        out[i + 2] = b[i + 2];
        out[i + 3] = b[i + 3];
        continue;
      }
      out[i] = a[i] + (b[i] - a[i]) * w;
      out[i + 1] = a[i + 1] + (b[i + 1] - a[i + 1]) * w;
      out[i + 2] = a[i + 2] + (b[i + 2] - a[i + 2]) * w;
      out[i + 3] = a[i + 3] + (b[i + 3] - a[i + 3]) * w;
    }
    return { width: original.width, height: original.height, data: out };
  }

  // Normal-blend a flat color over the selected pixels (Edit > Fill).
  function fillSelection(image, mask, color, opacity = 1) {
    assertImage(image);
    if (mask) assertMask(mask, image.width, image.height);
    const c = typeof color === 'string' ? parseHex(color) : color;
    const o = clampNumber(opacity, 0, 1, 1);
    const data = new Uint8ClampedArray(image.data);
    for (let p = 0, i = 0; i < data.length; p += 1, i += 4) {
      const sa = (mask ? mask[p] / 255 : 1) * o;
      if (sa <= 0) continue;
      const da = data[i + 3] / 255;
      const outA = sa + da * (1 - sa);
      if (outA <= 0) continue;
      data[i] = (c.r * sa + data[i] * da * (1 - sa)) / outA;
      data[i + 1] = (c.g * sa + data[i + 1] * da * (1 - sa)) / outA;
      data[i + 2] = (c.b * sa + data[i + 2] * da * (1 - sa)) / outA;
      data[i + 3] = outA * 255;
    }
    return { width: image.width, height: image.height, data };
  }

  // Delete selected pixels to transparency (partial coverage erases partially).
  function clearSelection(image, mask) {
    assertImage(image);
    assertMask(mask, image.width, image.height);
    const data = new Uint8ClampedArray(image.data);
    for (let p = 0, i = 3; i < data.length; p += 1, i += 4)
      if (mask[p]) data[i] = (data[i] * (255 - mask[p])) / 255;
    return { width: image.width, height: image.height, data };
  }

  // Copy selected pixels; unselected become transparent. Returns the cropped bounds.
  function extractSelection(image, mask) {
    assertImage(image);
    assertMask(mask, image.width, image.height);
    const bounds = maskBounds(mask, image.width, image.height);
    if (!bounds) return null;
    const out = createImage(bounds.width, bounds.height);
    for (let y = 0; y < bounds.height; y += 1) {
      for (let x = 0; x < bounds.width; x += 1) {
        const p = (bounds.y + y) * image.width + bounds.x + x;
        const s = p * 4,
          d = (y * bounds.width + x) * 4;
        out.data[d] = image.data[s];
        out.data[d + 1] = image.data[s + 1];
        out.data[d + 2] = image.data[s + 2];
        out.data[d + 3] = (image.data[s + 3] * mask[p]) / 255;
      }
    }
    return { image: out, bounds };
  }

  // ---------------------------------------------------------------- adjustments (point operations)

  const identityLut = () => {
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i += 1) lut[i] = i;
    return lut;
  };

  function levelsLut(params = {}) {
    const inBlack = clampNumber(params.inBlack, 0, 253, 0);
    const inWhite = clampNumber(params.inWhite, inBlack + 2, 255, 255);
    const gamma = clampNumber(params.gamma, 0.1, 9.99, 1);
    const outBlack = clampNumber(params.outBlack, 0, 255, 0);
    const outWhite = clampNumber(params.outWhite, 0, 255, 255);
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v += 1) {
      const t = Math.min(1, Math.max(0, (v - inBlack) / (inWhite - inBlack)));
      lut[v] = Math.round(outBlack + Math.pow(t, 1 / gamma) * (outWhite - outBlack));
    }
    return lut;
  }

  // Monotone cubic (Fritsch-Carlson) through the control points.
  function curveLut(points) {
    const pts = (Array.isArray(points) ? points : [])
      .map((p) => [clampNumber(p[0] ?? p.x, 0, 255, 0), clampNumber(p[1] ?? p.y, 0, 255, 0)])
      .sort((a, b) => a[0] - b[0])
      .filter((p, i, list) => i === 0 || p[0] > list[i - 1][0]);
    if (pts.length < 2) return identityLut();
    const n = pts.length;
    const dx = [],
      slope = [];
    for (let i = 0; i < n - 1; i += 1) {
      dx[i] = pts[i + 1][0] - pts[i][0];
      slope[i] = (pts[i + 1][1] - pts[i][1]) / dx[i];
    }
    const tangent = [slope[0]];
    for (let i = 1; i < n - 1; i += 1)
      tangent[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
    tangent[n - 1] = slope[n - 2];
    for (let i = 0; i < n - 1; i += 1) {
      if (slope[i] === 0) {
        tangent[i] = 0;
        tangent[i + 1] = 0;
        continue;
      }
      const a = tangent[i] / slope[i],
        b = tangent[i + 1] / slope[i];
      const h = a * a + b * b;
      if (h > 9) {
        const t = 3 / Math.sqrt(h);
        tangent[i] = t * a * slope[i];
        tangent[i + 1] = t * b * slope[i];
      }
    }
    const lut = new Uint8ClampedArray(256);
    let seg = 0;
    for (let v = 0; v < 256; v += 1) {
      if (v <= pts[0][0]) {
        lut[v] = Math.round(pts[0][1]);
        continue;
      }
      if (v >= pts[n - 1][0]) {
        lut[v] = Math.round(pts[n - 1][1]);
        continue;
      }
      while (seg < n - 2 && v > pts[seg + 1][0]) seg += 1;
      const h = dx[seg],
        t = (v - pts[seg][0]) / h;
      const t2 = t * t,
        t3 = t2 * t;
      const y =
        (2 * t3 - 3 * t2 + 1) * pts[seg][1] +
        (t3 - 2 * t2 + t) * h * tangent[seg] +
        (-2 * t3 + 3 * t2) * pts[seg + 1][1] +
        (t3 - t2) * h * tangent[seg + 1];
      lut[v] = Math.round(y);
    }
    return lut;
  }

  const composeLuts = (first, second) => {
    const out = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i += 1) out[i] = second[first[i]];
    return out;
  };

  function applyChannelLuts(data, r, g, b) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = r[data[i]];
      data[i + 1] = g[data[i + 1]];
      data[i + 2] = b[data[i + 2]];
    }
  }

  const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const linearToSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

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

  const SELECTIVE_RANGES = Object.freeze([
    'reds',
    'yellows',
    'greens',
    'cyans',
    'blues',
    'magentas',
    'whites',
    'neutrals',
    'blacks',
  ]);
  const ADJUSTMENT_DEFAULTS = Object.freeze({
    'selective-color': {
      ...Object.fromEntries(SELECTIVE_RANGES.map((name) => [name, [0, 0, 0, 0]])),
      absolute: false,
    },
    develop: {
      exposure: 0,
      contrast: 0,
      highlights: 0,
      shadows: 0,
      whites: 0,
      blacks: 0,
      temperature: 0,
      tint: 0,
      vibrance: 0,
      saturation: 0,
      clarity: 0,
      fade: 0,
      vignette: 0,
      grain: 0,
      splitShadowHue: 220,
      splitShadowAmount: 0,
      splitHighlightHue: 40,
      splitHighlightAmount: 0,
    },
    levels: { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 },
    curves: {
      points: [
        [0, 0],
        [255, 255],
      ],
      red: null,
      green: null,
      blue: null,
    },
    'hue-saturation': { hue: 0, saturation: 0, lightness: 0, colorize: false },
    vibrance: { vibrance: 0, saturation: 0 },
    'color-balance': {
      shadows: [0, 0, 0],
      midtones: [0, 0, 0],
      highlights: [0, 0, 0],
      preserveLuminosity: true,
    },
    'brightness-contrast': { brightness: 0, contrast: 0 },
    exposure: { exposure: 0, offset: 0, gamma: 1 },
    'black-white': {
      reds: 40,
      yellows: 60,
      greens: 40,
      cyans: 60,
      blues: 20,
      magentas: 80,
      tint: false,
      tintHue: 35,
      tintSaturation: 25,
    },
    invert: {},
    threshold: { level: 128 },
    'gradient-map': {
      stops: [
        { position: 0, color: '#000000' },
        { position: 1, color: '#ffffff' },
      ],
      reverse: false,
    },
    'photo-filter': { color: '#ec8a00', density: 25, preserveLuminosity: true },
    posterize: { levels: 4 },
    'channel-mixer': {
      red: [100, 0, 0, 0],
      green: [0, 100, 0, 0],
      blue: [0, 0, 100, 0],
      monochrome: false,
      gray: [40, 40, 20, 0],
    },
  });

  function colorBalanceWeights(v) {
    // Bell-shaped tonal-range weights (0..1) for shadows, midtones, highlights.
    const t = v / 255;
    const shadows = Math.max(0, 1 - t / 0.5) ** 1.2;
    const highlights = Math.max(0, (t - 0.5) / 0.5) ** 1.2;
    const midtones = Math.max(0, 1 - Math.abs(t - 0.5) / 0.5) ** 1.2;
    return [shadows, midtones, highlights];
  }

  // Develop: a one-layer photo finishing pass (white balance, exposure, a
  // luminance tone curve, clarity, color, split toning, fade, vignette, grain).
  // Tone moves the luminance only and scales RGB by the gain, so hue holds.
  // geometry (optional) maps the pixels to the document: { x, y, width, height,
  // scale } of the document frame in these pixels, so vignette, grain and
  // clarity stay put when the view is zoomed or panned.
  function develop(image, raw, geometry) {
    const P = (key) => clampNumber(raw[key], -100, 100, 0) / 100;
    const exposure = P('exposure') * 2,
      contrast = P('contrast'),
      highlights = P('highlights'),
      shadows = P('shadows');
    const whites = P('whites'),
      blacks = P('blacks'),
      temperature = P('temperature'),
      tintShift = P('tint');
    const vibrance = P('vibrance'),
      saturation = P('saturation'),
      clarity = P('clarity'),
      vignette = P('vignette');
    const fade = clampNumber(raw.fade, 0, 100, 0) / 100,
      grain = clampNumber(raw.grain, 0, 100, 0) / 100;
    const shadowAmt = clampNumber(raw.splitShadowAmount, 0, 100, 0) / 100,
      highAmt = clampNumber(raw.splitHighlightAmount, 0, 100, 0) / 100;
    const hueRgb = (h) => {
      const c = hsbToRgb({ h, s: 100, b: 100 });
      const m = (c.r + c.g + c.b) / 765;
      return [c.r / 255 - m, c.g / 255 - m, c.b / 255 - m];
    };
    const shadowTint = hueRgb(clampNumber(raw.splitShadowHue, 0, 360, 220)),
      highTint = hueRgb(clampNumber(raw.splitHighlightHue, 0, 360, 40));
    const { width, height } = image;
    const src = image.data,
      data = new Uint8ClampedArray(src);
    const g = geometry && geometry.width > 0 ? geometry : { x: 0, y: 0, width, height, scale: 1 };
    const docScale = g.scale > 0 ? g.scale : 1;
    // Luminance tone curve in a lookup table (4096 steps).
    const N = 4096,
      curve = new Float32Array(N + 1);
    for (let k = 0; k <= N; k += 1) {
      const L = k / N;
      let y = L;
      y += shadows * 2.4 * y * Math.pow(1 - y, 3);
      y += highlights * 2.4 * Math.pow(y, 3) * (1 - y);
      y += whites * 0.2 * Math.pow(y, 4);
      y += blacks * 0.2 * Math.pow(1 - y, 4);
      y = Math.min(1, Math.max(0, y));
      y += contrast * 2 * (y - 0.5) * y * (1 - y);
      y = fade > 0 ? fade * 0.16 + y * (1 - fade * 0.22) : y;
      curve[k] = Math.min(1, Math.max(0, y));
    }
    // White balance and exposure act per channel in linear light: one 256-entry table each.
    const gainR = Math.pow(2, exposure) * (1 + temperature * 0.3),
      gainG = Math.pow(2, exposure) * (1 - tintShift * 0.2),
      gainB = Math.pow(2, exposure) * (1 - temperature * 0.3);
    const lutR = new Float32Array(256),
      lutG = new Float32Array(256),
      lutB = new Float32Array(256);
    for (let v = 0; v < 256; v += 1) {
      const lin = srgbToLinear(v / 255);
      lutR[v] = Math.min(1, linearToSrgb(Math.min(1, lin * gainR)));
      lutG[v] = Math.min(1, linearToSrgb(Math.min(1, lin * gainG)));
      lutB[v] = Math.min(1, linearToSrgb(Math.min(1, lin * gainB)));
    }
    let local = null;
    if (clarity !== 0) {
      const lum = new Uint8ClampedArray(width * height);
      // Rec.709 weights, matching the detail term below: clarity is a high-pass of one luminance.
      for (let i = 0, k = 0; k < lum.length; i += 4, k += 1)
        lum[k] = 0.2126 * src[i] + 0.7152 * src[i + 1] + 0.0722 * src[i + 2];
      local = gaussianChannels(
        lum,
        width,
        height,
        1,
        Math.max(1, Math.min(120, Math.max(g.width, g.height) / 60)),
      );
    }
    const cx = g.x + g.width / 2,
      cy = g.y + g.height / 2,
      rx = g.width / 2,
      ry = g.height / 2;
    for (let i = 0, k = 0; i < data.length; i += 4, k += 1) {
      if (src[i + 3] === 0) continue;
      let r = lutR[src[i]],
        gg = lutG[src[i + 1]],
        b = lutB[src[i + 2]];
      const L = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      let Ln = curve[Math.round(L * N)];
      if (local) {
        // Local detail from the source (source luminance minus its blur), so exposure and white balance never read as detail.
        const detail =
          (0.2126 * src[i] + 0.7152 * src[i + 1] + 0.0722 * src[i + 2] - local[k]) / 255;
        Ln = Math.min(1, Math.max(0, Ln + clarity * 0.7 * detail * 4 * Ln * (1 - Ln)));
      }
      const gain = L > 1e-4 ? Ln / L : 0;
      r = L > 1e-4 ? r * gain : Ln;
      gg = L > 1e-4 ? gg * gain : Ln;
      b = L > 1e-4 ? b * gain : Ln;
      // Saturation and vibrance around the new luminance.
      const max = Math.max(r, gg, b),
        min = Math.min(r, gg, b),
        sat = max > 0 ? (max - min) / max : 0;
      const factor = Math.max(0, 1 + saturation + vibrance * (1 - sat) * (vibrance > 0 ? 1.2 : 1));
      r = Ln + (r - Ln) * factor;
      gg = Ln + (gg - Ln) * factor;
      b = Ln + (b - Ln) * factor;
      if (shadowAmt || highAmt) {
        const ws = shadowAmt * (1 - Ln) * (1 - Ln) * 0.35,
          wh = highAmt * Ln * Ln * 0.35;
        r += shadowTint[0] * ws + highTint[0] * wh;
        gg += shadowTint[1] * ws + highTint[1] * wh;
        b += shadowTint[2] * ws + highTint[2] * wh;
      }
      if (vignette || grain) {
        const px = k % width,
          py = (k - px) / width;
        if (vignette) {
          const dx = (px + 0.5 - cx) / rx,
            dy = (py + 0.5 - cy) / ry,
            d = Math.sqrt(dx * dx + dy * dy) / Math.SQRT2;
          const t = Math.min(1, Math.max(0, (d - 0.25) / 0.75)),
            w = t * t * (3 - 2 * t);
          const f = vignette < 0 ? 1 + vignette * 0.85 * w : 1;
          r *= f;
          gg *= f;
          b *= f;
          if (vignette > 0) {
            const lift = vignette * 0.85 * w;
            r += (1 - r) * lift;
            gg += (1 - gg) * lift;
            b += (1 - b) * lift;
          }
        }
        if (grain) {
          // Integer hash of the document pixel: stable grain at every zoom.
          const dxp = Math.floor((px - g.x) / docScale),
            dyp = Math.floor((py - g.y) / docScale);
          let h = Math.imul(dxp ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(dyp + 0x632be5ab, 0xc2b2ae35);
          h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
          h ^= h >>> 12;
          const n = ((h >>> 0) / 4294967295 - 0.5) * grain * 0.22 * (0.5 + 2 * Ln * (1 - Ln));
          r += n;
          gg += n;
          b += n;
        }
      }
      data[i] = r * 255;
      data[i + 1] = gg * 255;
      data[i + 2] = b * 255;
    }
    return { width, height, data };
  }

  // Selective Color: per color range, add or remove cyan, magenta, yellow and
  // black. A pixel belongs to a hue range by its chroma (strongest-channel lead
  // for primaries, second-channel lead for secondaries), to whites/blacks by how
  // far it sits above/below mid gray, and to neutrals by how gray it is.
  // Relative mode scales each change by the ink already present.
  function selectiveColor(image, params) {
    const ranges = SELECTIVE_RANGES.map((name) =>
      (Array.isArray(params[name]) ? params[name] : [0, 0, 0, 0])
        .slice(0, 4)
        .map((v) => clampNumber(v, -100, 100, 0) / 100),
    );
    const active = ranges.map((r) => r.some(Boolean));
    const data = new Uint8ClampedArray(image.data);
    if (!active.some(Boolean)) return { width: image.width, height: image.height, data };
    const absolute = Boolean(params.absolute);
    const w = new Float32Array(9);
    const flat = new Float32Array(36);
    ranges.forEach((range, k) => flat.set(range, k * 4));
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] / 255,
        g = data[i + 1] / 255,
        b = data[i + 2] / 255;
      const max = r > g ? (r > b ? r : b) : g > b ? g : b,
        min = r < g ? (r < b ? r : b) : g < b ? g : b,
        mid = r + g + b - max - min;
      w.fill(0);
      const lead = max - mid,
        second = mid - min;
      if (max === r) {
        w[0] = lead;
        if (mid === g) w[1] = second;
        else w[5] = second;
      } else if (max === g) {
        w[2] = lead;
        if (mid === r) w[1] = second;
        else w[3] = second;
      } else {
        w[4] = lead;
        if (mid === g) w[3] = second;
        else w[5] = second;
      }
      w[6] = min > 0.5 ? (min - 0.5) * 2 : 0;
      w[8] = max < 0.5 ? (0.5 - max) * 2 : 0;
      const chroma = 1 - (max - min);
      w[7] = chroma * chroma * (1 - Math.abs(max + min - 1));
      const c = 1 - r,
        m = 1 - g,
        y = 1 - b;
      let dc = 0,
        dm = 0,
        dy = 0,
        dk = 0;
      for (let k = 0; k < 9; k += 1) {
        const wk = w[k];
        if (!active[k] || !wk) continue;
        const o = k * 4;
        dc += flat[o] * wk * (absolute ? 1 : c);
        dm += flat[o + 1] * wk * (absolute ? 1 : m);
        dy += flat[o + 2] * wk * (absolute ? 1 : y);
        dk += flat[o + 3] * wk;
      }
      if (!dc && !dm && !dy && !dk) continue;
      // Black ink darkens (or lightens) all three channels together.
      const kf = dk >= 0 ? 1 - dk : 1,
        lift = dk < 0 ? -dk * 0.5 : 0;
      let x = Math.min(1, Math.max(0, 1 - c - dc)) * kf;
      data[i] = (x + (1 - x) * lift) * 255;
      x = Math.min(1, Math.max(0, 1 - m - dm)) * kf;
      data[i + 1] = (x + (1 - x) * lift) * 255;
      x = Math.min(1, Math.max(0, 1 - y - dy)) * kf;
      data[i + 2] = (x + (1 - x) * lift) * 255;
    }
    return { width: image.width, height: image.height, data };
  }

  // Apply one adjustment to an image (returns a new image). Alpha is preserved.
  function applyAdjustment(image, kind, rawParams = {}, geometry = null) {
    assertImage(image);
    if (!ADJUSTMENT_KINDS.includes(kind)) throw new Error(`Unknown adjustment: ${kind}`);
    const params = { ...ADJUSTMENT_DEFAULTS[kind], ...(rawParams || {}) };
    if (kind === 'develop') return develop(image, params, geometry);
    if (kind === 'selective-color') return selectiveColor(image, params);
    const data = new Uint8ClampedArray(image.data);
    const out = { width: image.width, height: image.height, data };
    if (kind === 'levels') {
      const master = levelsLut(params);
      const channel = (name) =>
        params[name] ? composeLuts(levelsLut(params[name]), master) : master;
      applyChannelLuts(data, channel('red'), channel('green'), channel('blue'));
    } else if (kind === 'curves') {
      const master = curveLut(params.points);
      const channel = (name) =>
        Array.isArray(params[name]) ? composeLuts(curveLut(params[name]), master) : master;
      applyChannelLuts(data, channel('red'), channel('green'), channel('blue'));
    } else if (kind === 'brightness-contrast') {
      const brightness = clampNumber(params.brightness, -150, 150, 0);
      const contrast = clampNumber(params.contrast, -50, 100, 0);
      const lut = new Uint8ClampedArray(256);
      const k = contrast >= 0 ? 1 / Math.max(0.01, 1 - contrast / 100) : 1 + contrast / 100;
      for (let v = 0; v < 256; v += 1) {
        // Brightness bends the midtones (endpoints stay anchored); contrast pivots on the midpoint.
        const t = v / 255;
        const bent =
          brightness >= 0
            ? 1 - Math.pow(1 - t, 1 + brightness / 100)
            : Math.pow(t, 1 - brightness / 100);
        lut[v] = Math.round(((bent - 0.5) * k + 0.5) * 255);
      }
      applyChannelLuts(data, lut, lut, lut);
    } else if (kind === 'exposure') {
      const exposure = clampNumber(params.exposure, -20, 20, 0);
      const offset = clampNumber(params.offset, -0.5, 0.5, 0);
      const gamma = clampNumber(params.gamma, 0.01, 9.99, 1);
      const lut = new Uint8ClampedArray(256);
      const gain = Math.pow(2, exposure);
      for (let v = 0; v < 256; v += 1) {
        const linear = Math.max(0, srgbToLinear(v / 255) * gain + offset);
        lut[v] = Math.round(linearToSrgb(Math.min(1, Math.pow(linear, 1 / gamma))) * 255);
      }
      applyChannelLuts(data, lut, lut, lut);
    } else if (kind === 'posterize') {
      const levels = Math.round(clampNumber(params.levels, 2, 255, 4));
      const lut = new Uint8ClampedArray(256);
      for (let v = 0; v < 256; v += 1)
        lut[v] = Math.round((Math.round((v / 255) * (levels - 1)) / (levels - 1)) * 255);
      applyChannelLuts(data, lut, lut, lut);
    } else if (kind === 'channel-mixer') {
      // Each output channel is a percentage mix of R, G, B plus a constant (-200..200 %).
      const row = (value, fallback) =>
        (Array.isArray(value) ? value : fallback)
          .slice(0, 4)
          .map((v) => clampNumber(v, -200, 200, 0) / 100);
      const red = row(params.red, [100, 0, 0, 0]),
        green = row(params.green, [0, 100, 0, 0]),
        blue = row(params.blue, [0, 0, 100, 0]),
        gray = row(params.gray, [40, 40, 20, 0]);
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i],
          g = data[i + 1],
          b = data[i + 2];
        if (params.monochrome) {
          const v = r * gray[0] + g * gray[1] + b * gray[2] + 255 * gray[3];
          data[i] = v;
          data[i + 1] = v;
          data[i + 2] = v;
        } else {
          data[i] = r * red[0] + g * red[1] + b * red[2] + 255 * red[3];
          data[i + 1] = r * green[0] + g * green[1] + b * green[2] + 255 * green[3];
          data[i + 2] = r * blue[0] + g * blue[1] + b * blue[2] + 255 * blue[3];
        }
      }
    } else if (kind === 'invert') {
      for (let i = 0; i < data.length; i += 4) {
        data[i] = 255 - data[i];
        data[i + 1] = 255 - data[i + 1];
        data[i + 2] = 255 - data[i + 2];
      }
    } else if (kind === 'threshold') {
      const level = clampNumber(params.level, 1, 255, 128);
      for (let i = 0; i < data.length; i += 4) {
        const v = luma(data[i], data[i + 1], data[i + 2]) >= level ? 255 : 0;
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
      }
    } else if (kind === 'gradient-map') {
      const stops = (
        Array.isArray(params.stops) && params.stops.length >= 2
          ? params.stops
          : ADJUSTMENT_DEFAULTS['gradient-map'].stops
      )
        .map((stop) => ({
          position: clampNumber(stop.position, 0, 1, 0),
          color: parseHex(stop.color),
        }))
        .sort((a, b) => a.position - b.position);
      const table = new Uint8ClampedArray(256 * 3);
      for (let v = 0; v < 256; v += 1) {
        let t = v / 255;
        if (params.reverse) t = 1 - t;
        let k = 0;
        while (k < stops.length - 2 && t > stops[k + 1].position) k += 1;
        const a = stops[k],
          b = stops[k + 1];
        const span = b.position - a.position;
        const f =
          span <= 0 ? (t >= b.position ? 1 : 0) : Math.min(1, Math.max(0, (t - a.position) / span));
        table[v * 3] = a.color.r + (b.color.r - a.color.r) * f;
        table[v * 3 + 1] = a.color.g + (b.color.g - a.color.g) * f;
        table[v * 3 + 2] = a.color.b + (b.color.b - a.color.b) * f;
      }
      for (let i = 0; i < data.length; i += 4) {
        const v = Math.round(luma(data[i], data[i + 1], data[i + 2])) * 3;
        data[i] = table[v];
        data[i + 1] = table[v + 1];
        data[i + 2] = table[v + 2];
      }
    } else if (kind === 'black-white') {
      const w = {
        r: params.reds,
        y: params.yellows,
        g: params.greens,
        c: params.cyans,
        b: params.blues,
        m: params.magentas,
      };
      for (const key of Object.keys(w)) w[key] = clampNumber(w[key], -200, 300, 0) / 100;
      const tint = params.tint
        ? hsbToRgb({
            h: clampNumber(params.tintHue, 0, 360, 35),
            s: clampNumber(params.tintSaturation, 0, 100, 25),
            b: 100,
          })
        : null;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i],
          g = data[i + 1],
          b = data[i + 2];
        const max = Math.max(r, g, b),
          min = Math.min(r, g, b);
        const mid = r + g + b - max - min;
        let primary, secondary;
        if (max === r) {
          primary = w.r;
          secondary = mid === g ? w.y : w.m;
        } else if (max === g) {
          primary = w.g;
          secondary = mid === r ? w.y : w.c;
        } else {
          primary = w.b;
          secondary = mid === g ? w.c : w.m;
        }
        const gray = min + (max - mid) * primary + (mid - min) * secondary;
        if (tint) {
          // Tint keeps the gray value as luminosity and adds the chosen hue.
          const t = clamp255(gray) / 255;
          data[i] = tint.r * t;
          data[i + 1] = tint.g * t;
          data[i + 2] = tint.b * t;
        } else {
          data[i] = gray;
          data[i + 1] = gray;
          data[i + 2] = gray;
        }
      }
    } else if (kind === 'photo-filter') {
      const f = parseHex(params.color, { r: 236, g: 138, b: 0 });
      const density = clampNumber(params.density, 0, 100, 25) / 100;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i],
          g = data[i + 1],
          b = data[i + 2];
        let fr = (r * f.r) / 255,
          fg = (g * f.g) / 255,
          fb = (b * f.b) / 255;
        if (params.preserveLuminosity) {
          const before = luma(r, g, b),
            after = luma(fr, fg, fb);
          if (after > 0) {
            const k = before / after;
            fr *= k;
            fg *= k;
            fb *= k;
          }
        }
        data[i] = r + (fr - r) * density;
        data[i + 1] = g + (fg - g) * density;
        data[i + 2] = b + (fb - b) * density;
      }
    } else if (kind === 'hue-saturation') {
      const hue = clampNumber(params.hue, -180, 180, 0) / 360;
      const saturation = clampNumber(params.saturation, -100, 100, 0) / 100;
      const lightness = clampNumber(params.lightness, -100, 100, 0) / 100;
      const colorize = Boolean(params.colorize);
      const colorizeHue = ((clampNumber(params.hue, -180, 180, 0) + 360) % 360) / 360;
      const colorizeSat = Math.max(0, Math.min(1, 0.25 + saturation * 0.75));
      for (let i = 0; i < data.length; i += 4) {
        const r0 = data[i] / 255,
          g0 = data[i + 1] / 255,
          b0 = data[i + 2] / 255;
        const max = r0 > g0 ? (r0 > b0 ? r0 : b0) : g0 > b0 ? g0 : b0;
        const min = r0 < g0 ? (r0 < b0 ? r0 : b0) : g0 < b0 ? g0 : b0;
        const l = (max + min) / 2;
        let h = 0,
          s = 0;
        if (max !== min) {
          const d = max - min;
          s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
          if (max === r0) h = (g0 - b0) / d + (g0 < b0 ? 6 : 0);
          else if (max === g0) h = (b0 - r0) / d + 2;
          else h = (r0 - g0) / d + 4;
          h /= 6;
        }
        if (colorize) {
          h = colorizeHue;
          s = colorizeSat;
        } else {
          h = (h + hue + 1) % 1;
          s = saturation >= 0 ? s + (1 - s) * saturation * s : s * (1 + saturation);
          if (s > 1) s = 1;
          else if (s < 0) s = 0;
        }
        let r, g, b;
        if (s === 0) {
          r = g = b = l;
        } else {
          const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
          const p2 = 2 * l - q;
          r = hueToRgb(p2, q, h + 1 / 3);
          g = hueToRgb(p2, q, h);
          b = hueToRgb(p2, q, h - 1 / 3);
        }
        if (lightness > 0) {
          r += (1 - r) * lightness;
          g += (1 - g) * lightness;
          b += (1 - b) * lightness;
        } else if (lightness < 0) {
          r *= 1 + lightness;
          g *= 1 + lightness;
          b *= 1 + lightness;
        }
        data[i] = r * 255;
        data[i + 1] = g * 255;
        data[i + 2] = b * 255;
      }
    } else if (kind === 'vibrance') {
      const vibrance = clampNumber(params.vibrance, -100, 100, 0) / 100;
      const saturation = clampNumber(params.saturation, -100, 100, 0) / 100;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i],
          g = data[i + 1],
          b = data[i + 2];
        const max = Math.max(r, g, b),
          min = Math.min(r, g, b);
        const current = max === 0 ? 0 : (max - min) / max;
        // Vibrance weights the boost toward low-saturation pixels.
        const factor = 1 + saturation + vibrance * (1 - current) * (1 - current);
        const y = luma(r, g, b);
        data[i] = y + (r - y) * factor;
        data[i + 1] = y + (g - y) * factor;
        data[i + 2] = y + (b - y) * factor;
      }
    } else if (kind === 'color-balance') {
      const ranges = ['shadows', 'midtones', 'highlights'].map((name) =>
        (Array.isArray(params[name]) ? params[name] : [0, 0, 0])
          .slice(0, 3)
          .map((v) => clampNumber(v, -100, 100, 0)),
      );
      const lut = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];
      for (let v = 0; v < 256; v += 1) {
        const weights = colorBalanceWeights(v);
        for (let c = 0; c < 3; c += 1) {
          let shift = 0;
          for (let range = 0; range < 3; range += 1)
            shift += ranges[range][c] * weights[range] * 0.5;
          lut[c][v] = clamp255(v + shift);
        }
      }
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i],
          g = data[i + 1],
          b = data[i + 2];
        let nr = lut[0][r],
          ng = lut[1][g],
          nb = lut[2][b];
        if (params.preserveLuminosity) {
          const [h, s] = rgbToHsl(nr / 255, ng / 255, nb / 255);
          const [, , l] = rgbToHsl(r / 255, g / 255, b / 255);
          [nr, ng, nb] = hslToRgb(h, s, l).map((x) => x * 255);
        }
        data[i] = nr;
        data[i + 1] = ng;
        data[i + 2] = nb;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- spatial filters

  function isOpaque(data) {
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return false;
    return true;
  }

  // Blur in premultiplied space so transparent pixels do not bleed dark fringes.
  function blurRgba(image, sigma, blurFn) {
    const { width, height } = image;
    if (isOpaque(image.data)) return { width, height, data: blurFn(image.data) };
    const pre = new Uint8ClampedArray(image.data.length);
    for (let i = 0; i < pre.length; i += 4) {
      const a = image.data[i + 3];
      pre[i] = (image.data[i] * a) / 255;
      pre[i + 1] = (image.data[i + 1] * a) / 255;
      pre[i + 2] = (image.data[i + 2] * a) / 255;
      pre[i + 3] = a;
    }
    const blurred = blurFn(pre);
    for (let i = 0; i < blurred.length; i += 4) {
      const a = blurred[i + 3];
      if (a > 0) {
        blurred[i] = (blurred[i] * 255) / a;
        blurred[i + 1] = (blurred[i + 1] * 255) / a;
        blurred[i + 2] = (blurred[i + 2] * 255) / a;
      }
    }
    return { width, height, data: blurred };
  }

  function gaussianBlur(image, radius) {
    assertImage(image);
    const sigma = clampNumber(radius, 0, 250, 0);
    if (sigma <= 0) return cloneImage(image);
    return blurRgba(image, sigma, (data) =>
      gaussianChannels(data, image.width, image.height, 4, sigma),
    );
  }

  function unsharpMask(image, options = {}) {
    assertImage(image);
    const amount = clampNumber(options.amount, 0, 500, 100) / 100;
    const radius = clampNumber(options.radius, 0.1, 250, 1);
    const threshold = clampNumber(options.threshold, 0, 255, 0);
    const blurred = gaussianBlur(image, radius).data;
    const data = new Uint8ClampedArray(image.data);
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c += 1) {
        const diff = image.data[i + c] - blurred[i + c];
        if (Math.abs(diff) >= threshold) data[i + c] = image.data[i + c] + diff * amount;
      }
    }
    return { width: image.width, height: image.height, data };
  }

  function convolve3x3(image, kernel, divisor = 1, bias = 0, includeAlpha = false) {
    assertImage(image);
    const { width, height } = image;
    const src = image.data;
    const data = new Uint8ClampedArray(src);
    const channels = includeAlpha ? 4 : 3;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const o = (y * width + x) * 4;
        for (let c = 0; c < channels; c += 1) {
          let sum = 0,
            k = 0;
          for (let dy = -1; dy <= 1; dy += 1) {
            const yy = Math.min(height - 1, Math.max(0, y + dy));
            for (let dx = -1; dx <= 1; dx += 1) {
              const xx = Math.min(width - 1, Math.max(0, x + dx));
              sum += src[(yy * width + xx) * 4 + c] * kernel[k];
              k += 1;
            }
          }
          data[o + c] = sum / divisor + bias;
        }
      }
    }
    return { width, height, data };
  }

  const sharpen = (image) => convolve3x3(image, [0, -0.25, 0, -0.25, 2, -0.25, 0, -0.25, 0]);

  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function addNoise(image, options = {}) {
    assertImage(image);
    const amount = (clampNumber(options.amount, 0, 400, 10) / 100) * 255;
    const gaussian = options.distribution === 'gaussian';
    const mono = Boolean(options.monochromatic);
    const random = mulberry32(Number.isFinite(Number(options.seed)) ? Number(options.seed) : 1);
    const sample = () => {
      if (!gaussian) return (random() * 2 - 1) * amount;
      const u = Math.max(1e-9, random()),
        v = random();
      return (Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * amount) / 2.5;
    };
    const data = new Uint8ClampedArray(image.data);
    for (let i = 0; i < data.length; i += 4) {
      if (mono) {
        const n = sample();
        data[i] += n;
        data[i + 1] += n;
        data[i + 2] += n;
      } else {
        data[i] += sample();
        data[i + 1] += sample();
        data[i + 2] += sample();
      }
    }
    return { width: image.width, height: image.height, data };
  }

  // Median filter (radius 1 or 2) blended by strength. A noise reducer, not a denoiser model.
  function reduceNoise(image, options = {}) {
    assertImage(image);
    const radius = Math.round(clampNumber(options.radius, 1, 2, 1));
    const strength = clampNumber(options.strength, 0, 100, 100) / 100;
    const { width, height } = image;
    const src = image.data;
    const data = new Uint8ClampedArray(src);
    const window = new Uint8Array((radius * 2 + 1) ** 2);
    const half = window.length >> 1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const o = (y * width + x) * 4;
        for (let c = 0; c < 3; c += 1) {
          let k = 0;
          for (let dy = -radius; dy <= radius; dy += 1) {
            const yy = Math.min(height - 1, Math.max(0, y + dy));
            for (let dx = -radius; dx <= radius; dx += 1) {
              const xx = Math.min(width - 1, Math.max(0, x + dx));
              window[k] = src[(yy * width + xx) * 4 + c];
              k += 1;
            }
          }
          window.sort();
          data[o + c] = src[o + c] + (window[half] - src[o + c]) * strength;
        }
      }
    }
    return { width, height, data };
  }

  function motionBlur(image, options = {}) {
    assertImage(image);
    const distance = clampNumber(options.distance, 1, 999, 10);
    const angle = (clampNumber(options.angle, -360, 360, 0) * Math.PI) / 180;
    const taps = Math.max(2, Math.min(64, Math.round(distance)));
    const { width, height } = image;
    const src = image.data;
    const data = new Uint8ClampedArray(src.length);
    const offsets = [];
    for (let t = 0; t < taps; t += 1) {
      const d = (t / (taps - 1) - 0.5) * distance;
      offsets.push([Math.round(Math.cos(angle) * d), Math.round(-Math.sin(angle) * d)]);
    }
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let r = 0,
          g = 0,
          b = 0,
          a = 0;
        for (const [dx, dy] of offsets) {
          const xx = Math.min(width - 1, Math.max(0, x + dx)),
            yy = Math.min(height - 1, Math.max(0, y + dy));
          const i = (yy * width + xx) * 4;
          const alpha = src[i + 3];
          r += src[i] * alpha;
          g += src[i + 1] * alpha;
          b += src[i + 2] * alpha;
          a += alpha;
        }
        const o = (y * width + x) * 4;
        if (a > 0) {
          data[o] = r / a;
          data[o + 1] = g / a;
          data[o + 2] = b / a;
        }
        data[o + 3] = a / taps;
      }
    }
    return { width, height, data };
  }

  function pixelate(image, options = {}) {
    assertImage(image);
    const cell = Math.round(clampNumber(options.cellSize, 2, 512, 10));
    const { width, height } = image;
    const src = image.data;
    const data = new Uint8ClampedArray(src.length);
    for (let cy = 0; cy < height; cy += cell) {
      for (let cx = 0; cx < width; cx += cell) {
        let r = 0,
          g = 0,
          b = 0,
          a = 0,
          n = 0;
        const yEnd = Math.min(height, cy + cell),
          xEnd = Math.min(width, cx + cell);
        for (let y = cy; y < yEnd; y += 1)
          for (let x = cx; x < xEnd; x += 1) {
            const i = (y * width + x) * 4,
              alpha = src[i + 3];
            r += src[i] * alpha;
            g += src[i + 1] * alpha;
            b += src[i + 2] * alpha;
            a += alpha;
            n += 1;
          }
        const outR = a ? r / a : 0,
          outG = a ? g / a : 0,
          outB = a ? b / a : 0,
          outA = a / n;
        for (let y = cy; y < yEnd; y += 1)
          for (let x = cx; x < xEnd; x += 1) {
            const i = (y * width + x) * 4;
            data[i] = outR;
            data[i + 1] = outG;
            data[i + 2] = outB;
            data[i + 3] = outA;
          }
      }
    }
    return { width, height, data };
  }

  function emboss(image, options = {}) {
    assertImage(image);
    const angle = (clampNumber(options.angle, -360, 360, 135) * Math.PI) / 180;
    const height = Math.round(clampNumber(options.height, 1, 10, 3));
    const amount = clampNumber(options.amount, 1, 500, 100) / 100;
    const dx = Math.round(Math.cos(angle) * height),
      dy = Math.round(-Math.sin(angle) * height);
    const { width } = image,
      h = image.height;
    const src = image.data;
    const data = new Uint8ClampedArray(src);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const ax = Math.min(width - 1, Math.max(0, x + dx)),
          ay = Math.min(h - 1, Math.max(0, y + dy));
        const bx = Math.min(width - 1, Math.max(0, x - dx)),
          by = Math.min(h - 1, Math.max(0, y - dy));
        const ia = (ay * width + ax) * 4,
          ib = (by * width + bx) * 4;
        const v =
          128 +
          (luma(src[ia], src[ia + 1], src[ia + 2]) - luma(src[ib], src[ib + 1], src[ib + 2])) *
            amount;
        const o = (y * width + x) * 4;
        data[o] = v;
        data[o + 1] = v;
        data[o + 2] = v;
      }
    }
    return { width, height: h, data };
  }

  function highPass(image, options = {}) {
    assertImage(image);
    const radius = clampNumber(options.radius, 0.1, 250, 10);
    const blurred = gaussianBlur(image, radius).data;
    const data = new Uint8ClampedArray(image.data);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = image.data[i] - blurred[i] + 128;
      data[i + 1] = image.data[i + 1] - blurred[i + 1] + 128;
      data[i + 2] = image.data[i + 2] - blurred[i + 2] + 128;
    }
    return { width: image.width, height: image.height, data };
  }

  // Shadows / Highlights: AlcorPhoto's own base/detail tone mapper.
  // The blurred luminance is the "base" (lighting) and Y / base is the
  // "detail" (texture). Only the base is re-lit, so texture survives:
  // shadows lift along base' = base^(1 - k), highlights fold along the
  // mirrored curve, and the RGB triplet is scaled by base'/base so hue
  // stays put. Midtone contrast stretches the detail ratio, color
  // correction rescales chroma where the tone moved. Alpha is untouched.
  function shadowsHighlights(image, options = {}) {
    assertImage(image);
    const sa = clampNumber(options.shadows, 0, 100, 35) / 100;
    const ha = clampNumber(options.highlights, 0, 100, 0) / 100;
    const sw = clampNumber(options.shadowTone, 1, 100, 50) / 100;
    const hw = clampNumber(options.highlightTone, 1, 100, 50) / 100;
    const mid = clampNumber(options.midtone, -100, 100, 0) / 100;
    const color = clampNumber(options.color, -100, 100, 20) / 100;
    const radius = clampNumber(options.radius, 0, 250, 30);
    const out = cloneImage(image);
    if (sa === 0 && ha === 0 && mid === 0) return out;
    const src = image.data;
    const base = radius > 0 ? gaussianBlur(image, radius / 2).data : src;
    const EPS = 1 / 512;
    // Quadratic band weights: 1 at the extreme, 0 once the base leaves the band.
    const band = (t) => {
      t = 1 - Math.min(1, Math.max(0, t));
      return t * t;
    };
    for (let i = 0; i < out.data.length; i += 4) {
      if (src[i + 3] === 0) continue;
      const b = Math.max(
        EPS,
        (0.2126 * base[i] + 0.7152 * base[i + 1] + 0.0722 * base[i + 2]) / 255,
      );
      const y = Math.max(EPS, (0.2126 * src[i] + 0.7152 * src[i + 1] + 0.0722 * src[i + 2]) / 255);
      const ws = band(b / sw),
        wh = band((1 - b) / hw);
      let nb = b;
      if (sa > 0 && ws > 0) nb = Math.pow(nb, 1 - 0.75 * sa * ws);
      if (ha > 0 && wh > 0) nb = 1 - Math.pow(Math.max(EPS, 1 - nb), 1 - 0.75 * ha * wh);
      let detail = y / b;
      if (mid !== 0) detail = Math.pow(detail, 1 + mid * Math.max(0, 1 - ws - wh));
      const ny = Math.min(1, nb * detail);
      const gain = ny / y;
      const chroma = 1 + color * Math.min(1, sa * ws + ha * wh);
      let r = (src[i] / 255) * gain,
        g = (src[i + 1] / 255) * gain,
        bl = (src[i + 2] / 255) * gain;
      r = ny + (r - ny) * chroma;
      g = ny + (g - ny) * chroma;
      bl = ny + (bl - ny) * chroma;
      // Soft-limit any channel pushed past white by pulling the triplet toward its luminance.
      const peak = Math.max(r, g, bl);
      if (peak > 1 && peak > ny) {
        const k = (1 - ny) / (peak - ny);
        r = ny + (r - ny) * k;
        g = ny + (g - ny) * k;
        bl = ny + (bl - ny) * k;
      }
      out.data[i] = r * 255;
      out.data[i + 1] = g * 255;
      out.data[i + 2] = bl * 255;
    }
    return out;
  }

  // Histogram corrections use only visible pixels (weighted by alpha). A
  // shared RGB map preserves the channel relationship for Auto Contrast;
  // Auto Tone and Equalize deliberately use independent channel maps.
  function automaticTone(image, options = {}, mode = 'contrast') {
    assertImage(image);
    const out = cloneImage(image);
    const amount = clampNumber(options.amount, 0, 100, 100) / 100;
    if (amount === 0) return out;
    const clip = clampNumber(options.clip, 0, 5, 0.1) / 100;
    const bins = Array.from({ length: mode === 'contrast' ? 1 : 3 }, () => new Float64Array(256));
    for (let i = 0; i < image.data.length; i += 4) {
      const weight = image.data[i + 3] / 255;
      if (!weight) continue;
      for (let c = 0; c < 3; c += 1) bins[mode === 'contrast' ? 0 : c][image.data[i + c]] += weight;
    }
    const maps = bins.map((hist) => {
      const lut = identityLut();
      const total = hist.reduce((a, b) => a + b, 0);
      if (total === 0) return lut;
      let low = 0,
        high = 255,
        acc = 0;
      const threshold = mode === 'equalize' ? 0 : total * clip;
      while (low < 255 && (acc += hist[low]) <= threshold) low += 1;
      acc = 0;
      while (high > 0 && (acc += hist[high]) <= threshold) high -= 1;
      if (high <= low) return lut; // Flat channels stay unchanged, not black.
      acc = 0;
      for (let v = 0; v < 256; v += 1) {
        acc += hist[v];
        lut[v] =
          mode === 'equalize'
            ? ((acc - hist[low]) / (total - hist[low])) * 255
            : ((v - low) / (high - low)) * 255;
      }
      return lut;
    });
    for (let i = 0; i < out.data.length; i += 4) {
      if (!image.data[i + 3]) continue;
      for (let c = 0; c < 3; c += 1) {
        const v = image.data[i + c];
        out.data[i + c] = v + (maps[mode === 'contrast' ? 0 : c][v] - v) * amount;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- liquify
  // A displacement grid (gw × gh nodes spanning the image, two floats per node,
  // in image pixels). Each output pixel reads the source at its position plus
  // the bilinearly interpolated displacement, so the warp is smooth at any grid size.
  const MAX_LIQUIFY_NODES = 512 * 512;
  function createLiquifyField(width, height, spacing = 8) {
    const gw = Math.max(2, Math.min(512, Math.ceil(width / spacing) + 1)),
      gh = Math.max(2, Math.min(512, Math.ceil(height / spacing) + 1));
    return { gw, gh, width, height, field: new Float32Array(gw * gh * 2) };
  }
  function sampleField(f, x, y) {
    const fx = Math.min(f.gw - 1, Math.max(0, (x / Math.max(1, f.width - 1)) * (f.gw - 1)));
    const fy = Math.min(f.gh - 1, Math.max(0, (y / Math.max(1, f.height - 1)) * (f.gh - 1)));
    const x0 = Math.min(f.gw - 2, Math.floor(fx)),
      y0 = Math.min(f.gh - 2, Math.floor(fy)),
      ax = fx - x0,
      ay = fy - y0;
    const at = (gx, gy, c) => f.field[(gy * f.gw + gx) * 2 + c];
    const lerp = (c) =>
      (at(x0, y0, c) * (1 - ax) + at(x0 + 1, y0, c) * ax) * (1 - ay) +
      (at(x0, y0 + 1, c) * (1 - ax) + at(x0 + 1, y0 + 1, c) * ax) * ay;
    return [lerp(0), lerp(1)];
  }
  // Brush edit on the field. mode: warp (dx, dy = drag), bloat, pucker, reconstruct.
  function liquifyBrush(f, mode, cx, cy, radius, strength, dx = 0, dy = 0) {
    const sx = (f.gw - 1) / Math.max(1, f.width - 1),
      sy = (f.gh - 1) / Math.max(1, f.height - 1);
    const gx0 = Math.max(0, Math.floor((cx - radius) * sx)),
      gx1 = Math.min(f.gw - 1, Math.ceil((cx + radius) * sx));
    const gy0 = Math.max(0, Math.floor((cy - radius) * sy)),
      gy1 = Math.min(f.gh - 1, Math.ceil((cy + radius) * sy));
    for (let gy = gy0; gy <= gy1; gy += 1)
      for (let gx = gx0; gx <= gx1; gx += 1) {
        const px = gx / sx,
          py = gy / sy,
          d = Math.hypot(px - cx, py - cy);
        if (d >= radius) continue;
        const t = 1 - d / radius,
          w = t * t * (3 - 2 * t) * strength,
          k = (gy * f.gw + gx) * 2;
        if (mode === 'warp') {
          f.field[k] -= dx * w;
          f.field[k + 1] -= dy * w;
        } else if (mode === 'bloat' || mode === 'pucker') {
          const sign = mode === 'bloat' ? 1 : -1;
          f.field[k] -= (px - cx) * 0.08 * w * sign;
          f.field[k + 1] -= (py - cy) * 0.08 * w * sign;
        } else if (mode === 'reconstruct') {
          f.field[k] *= 1 - 0.25 * w;
          f.field[k + 1] *= 1 - 0.25 * w;
        } else if (mode === 'twirl') {
          const ang = 0.06 * w;
          const rx = px - cx,
            ry = py - cy;
          f.field[k] += rx * (Math.cos(ang) - 1) - ry * Math.sin(ang);
          f.field[k + 1] += rx * Math.sin(ang) + ry * (Math.cos(ang) - 1);
        }
      }
  }
  function liquify(image, options = {}) {
    assertImage(image);
    if (options.field == null) return cloneImage(image); // no mesh: nothing to warp
    const gw = Math.round(clampNumber(options.gw, 2, 512, 2)),
      gh = Math.round(clampNumber(options.gh, 2, 512, 2));
    const field = options.field;
    if (
      !(field instanceof Float32Array) ||
      field.length !== gw * gh * 2 ||
      gw * gh > MAX_LIQUIFY_NODES
    )
      throw new Error('The liquify mesh is invalid.');
    for (let i = 0; i < field.length; i += 1)
      if (!Number.isFinite(field[i])) throw new Error('The liquify mesh is invalid.');
    const { width, height } = image,
      src = image.data;
    const f = {
      gw,
      gh,
      width: Number(options.width) || width,
      height: Number(options.height) || height,
      field,
    };
    const ox = Number(options.offsetX) || 0,
      oy = Number(options.offsetY) || 0;
    const out = new Uint8ClampedArray(src.length);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        const [dx, dy] = sampleField(f, x + ox, y + oy);
        const sxp = Math.min(width - 1, Math.max(0, x + dx)),
          syp = Math.min(height - 1, Math.max(0, y + dy));
        const x0 = Math.floor(sxp),
          y0 = Math.floor(syp),
          x1 = Math.min(width - 1, x0 + 1),
          y1 = Math.min(height - 1, y0 + 1),
          ax = sxp - x0,
          ay = syp - y0;
        const o = (y * width + x) * 4,
          a = (y0 * width + x0) * 4,
          b = (y0 * width + x1) * 4,
          c = (y1 * width + x0) * 4,
          d = (y1 * width + x1) * 4;
        // Premultiplied blend so transparent neighbors do not bleed color.
        const wa = (1 - ax) * (1 - ay) * src[a + 3],
          wb = ax * (1 - ay) * src[b + 3],
          wc = (1 - ax) * ay * src[c + 3],
          wd = ax * ay * src[d + 3];
        const alpha = wa + wb + wc + wd;
        out[o + 3] = alpha;
        if (alpha > 0)
          for (let ch = 0; ch < 3; ch += 1)
            out[o + ch] =
              (src[a + ch] * wa + src[b + ch] * wb + src[c + ch] * wc + src[d + ch] * wd) / alpha;
      }
    return { width, height, data: out };
  }

  const FILTERS = Object.freeze({
    liquify: (image, p) => liquify(image, p),
    'auto-contrast': (image, p) => automaticTone(image, p, 'contrast'),
    'auto-tone': (image, p) => automaticTone(image, p, 'tone'),
    equalize: (image, p) => automaticTone(image, p, 'equalize'),
    'shadows-highlights': (image, p) => shadowsHighlights(image, p),
    'gaussian-blur': (image, p) => gaussianBlur(image, p.radius),
    'unsharp-mask': (image, p) => unsharpMask(image, p),
    sharpen: (image) => sharpen(image),
    'add-noise': (image, p) => addNoise(image, p),
    'reduce-noise': (image, p) => reduceNoise(image, p),
    'motion-blur': (image, p) => motionBlur(image, p),
    pixelate: (image, p) => pixelate(image, p),
    emboss: (image, p) => emboss(image, p),
    'high-pass': (image, p) => highPass(image, p),
  });

  function applyFilter(image, name, params = {}) {
    const fn = FILTERS[name];
    if (!fn) throw new Error(`Unknown filter: ${name}`);
    return fn(image, params || {});
  }

  // ---------------------------------------------------------------- retouching

  // Desaturate and darken strongly red pixels inside a circle. Returns { image, changed }.
  function redEye(image, cx, cy, radius, options = {}) {
    assertImage(image);
    const darken = clampNumber(options.darken, 0, 100, 50) / 100;
    const threshold = clampNumber(options.threshold, 0, 255, 40);
    const r = Math.max(1, Number(radius) || 1);
    const { width, height } = image;
    const data = new Uint8ClampedArray(image.data);
    let changed = 0;
    for (
      let y = Math.max(0, Math.floor(cy - r));
      y <= Math.min(height - 1, Math.ceil(cy + r));
      y += 1
    ) {
      for (
        let x = Math.max(0, Math.floor(cx - r));
        x <= Math.min(width - 1, Math.ceil(cx + r));
        x += 1
      ) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
        if (d > 1) continue;
        const i = (y * width + x) * 4;
        const red = data[i],
          green = data[i + 1],
          blue = data[i + 2];
        const redness = red - (green + blue) / 2;
        if (redness < threshold || red < green * 1.4 || red < blue * 1.4) continue;
        const edge = d > 0.85 ? (1 - d) / 0.15 : 1;
        const target = ((green + blue) / 2) * (1 - darken);
        data[i] = red + (target - red) * edge;
        data[i + 1] = green + (green * (1 - darken) - green) * edge;
        data[i + 2] = blue + (blue * (1 - darken) - blue) * edge;
        changed += 1;
      }
    }
    return { image: { width, height, data }, changed };
  }

  function sampleRegion(image, x, y, w, h) {
    const out = new Float32Array(w * h * 4);
    for (let yy = 0; yy < h; yy += 1) {
      const sy = Math.min(image.height - 1, Math.max(0, y + yy));
      for (let xx = 0; xx < w; xx += 1) {
        const sx = Math.min(image.width - 1, Math.max(0, x + xx));
        const s = (sy * image.width + sx) * 4,
          d = (yy * w + xx) * 4;
        out[d] = image.data[s];
        out[d + 1] = image.data[s + 1];
        out[d + 2] = image.data[s + 2];
        out[d + 3] = image.data[s + 3];
      }
    }
    return out;
  }

  // Choose a nearby source patch whose surroundings best match the target's
  // surroundings (sum of squared differences on an annulus).
  function findHealSource(image, cx, cy, radius) {
    assertImage(image);
    const r = Math.max(2, Math.round(radius));
    const size = r * 3;
    const target = sampleRegion(
      image,
      Math.round(cx - size / 2),
      Math.round(cy - size / 2),
      size,
      size,
    );
    let best = null;
    for (const distance of [2.2, 3.2, 4.4]) {
      for (let k = 0; k < 12; k += 1) {
        const angle = (k / 12) * Math.PI * 2;
        const sx = Math.round(cx + Math.cos(angle) * r * distance),
          sy = Math.round(cy + Math.sin(angle) * r * distance);
        if (sx - r < 0 || sy - r < 0 || sx + r >= image.width || sy + r >= image.height) continue;
        const candidate = sampleRegion(
          image,
          Math.round(sx - size / 2),
          Math.round(sy - size / 2),
          size,
          size,
        );
        let score = 0;
        for (let y = 0; y < size; y += 2)
          for (let x = 0; x < size; x += 2) {
            const d = Math.hypot(x - size / 2, y - size / 2);
            if (d < r || d > size / 2) continue;
            const i = (y * size + x) * 4;
            for (let c = 0; c < 3; c += 1) {
              const diff = target[i + c] - candidate[i + c];
              score += diff * diff;
            }
          }
        if (!best || score < best.score) best = { x: sx, y: sy, score };
      }
    }
    return best;
  }

  // Healing: copy texture from the source patch, then correct its color with
  // a smooth membrane that matches the destination along the patch boundary
  // (a coarse Laplace solve, i.e. a lightweight Poisson-style blend).
  function healPatch(image, cx, cy, radius, source, options = {}) {
    assertImage(image);
    const r = Math.max(2, Math.round(radius));
    const size = r * 2 + 3;
    const x0 = Math.round(cx) - (size >> 1),
      y0 = Math.round(cy) - (size >> 1);
    const sx0 = Math.round(source.x) - (size >> 1),
      sy0 = Math.round(source.y) - (size >> 1);
    const dst = sampleRegion(image, x0, y0, size, size);
    const src = sampleRegion(image, sx0, sy0, size, size);
    const grid = Math.min(size, 24);
    const scale = (size - 1) / (grid - 1);
    const diff = new Float32Array(grid * grid * 3);
    const fixed = new Uint8Array(grid * grid);
    const center = (size - 1) / 2;
    for (let gy = 0; gy < grid; gy += 1)
      for (let gx = 0; gx < grid; gx += 1) {
        const px = Math.round(gx * scale),
          py = Math.round(gy * scale);
        const g = gy * grid + gx;
        if (Math.hypot(px - center, py - center) >= r) {
          fixed[g] = 1;
          const i = (py * size + px) * 4;
          for (let c = 0; c < 3; c += 1) diff[g * 3 + c] = dst[i + c] - src[i + c];
        }
      }
    for (let iteration = 0; iteration < 400; iteration += 1) {
      for (let gy = 1; gy < grid - 1; gy += 1)
        for (let gx = 1; gx < grid - 1; gx += 1) {
          const g = gy * grid + gx;
          if (fixed[g]) continue;
          for (let c = 0; c < 3; c += 1) {
            diff[g * 3 + c] =
              (diff[(g - 1) * 3 + c] +
                diff[(g + 1) * 3 + c] +
                diff[(g - grid) * 3 + c] +
                diff[(g + grid) * 3 + c]) /
              4;
          }
        }
    }
    const data = new Uint8ClampedArray(image.data);
    const feather = clampNumber(options.hardness, 0, 1, 0.5);
    for (let py = 0; py < size; py += 1)
      for (let px = 0; px < size; px += 1) {
        const d = Math.hypot(px - center, py - center) / r;
        if (d >= 1) continue;
        const ix = x0 + px,
          iy = y0 + py;
        if (ix < 0 || iy < 0 || ix >= image.width || iy >= image.height) continue;
        const gxF = px / scale,
          gyF = py / scale;
        const gx = Math.min(grid - 2, Math.floor(gxF)),
          gy = Math.min(grid - 2, Math.floor(gyF));
        const fx = gxF - gx,
          fy = gyF - gy;
        const weight = brushFalloff(d, feather);
        const s = (py * size + px) * 4,
          o = (iy * image.width + ix) * 4;
        for (let c = 0; c < 3; c += 1) {
          const a = diff[(gy * grid + gx) * 3 + c],
            b = diff[(gy * grid + gx + 1) * 3 + c];
          const e = diff[((gy + 1) * grid + gx) * 3 + c],
            f = diff[((gy + 1) * grid + gx + 1) * 3 + c];
          const correction = (a * (1 - fx) + b * fx) * (1 - fy) + (e * (1 - fx) + f * fx) * fy;
          const healed = src[s + c] + correction;
          data[o + c] = image.data[o + c] + (healed - image.data[o + c]) * weight;
        }
      }
    return { width: image.width, height: image.height, data };
  }

  function spotHeal(image, cx, cy, radius, options = {}) {
    const source = findHealSource(image, cx, cy, radius);
    if (!source)
      throw new Error('Spot healing needs clear image area around the spot. Try a smaller brush.');
    return { image: healPatch(image, cx, cy, radius, source, options), source };
  }

  // ---------------------------------------------------------------- toning brushes

  // Full-strength result of a Dodge/Burn/Sponge dab; brushes mix it in by coverage.
  function toneRegion(image, options = {}) {
    assertImage(image);
    const mode = ['dodge', 'burn', 'saturate', 'desaturate'].includes(options.mode)
      ? options.mode
      : 'dodge';
    const range = ['shadows', 'midtones', 'highlights'].includes(options.range)
      ? options.range
      : 'midtones';
    const exposure = clampNumber(options.exposure, 0, 100, 50) / 100;
    const weight = new Float32Array(256);
    for (let v = 0; v < 256; v += 1) {
      const t = v / 255;
      // Gaussian bells keep each tonal range from spilling far into the others.
      weight[v] =
        range === 'shadows'
          ? Math.exp(-((t / 0.35) ** 2))
          : range === 'highlights'
            ? Math.exp(-(((1 - t) / 0.35) ** 2))
            : Math.exp(-(((t - 0.5) / 0.22) ** 2));
    }
    const data = new Uint8ClampedArray(image.data);
    for (let i = 0; i < data.length; i += 4) {
      if (mode === 'dodge' || mode === 'burn') {
        for (let c = 0; c < 3; c += 1) {
          const v = data[i + c];
          data[i + c] =
            mode === 'dodge' ? v + (255 - v) * exposure * weight[v] : v - v * exposure * weight[v];
        }
      } else {
        const r = data[i],
          g = data[i + 1],
          b = data[i + 2];
        const y = luma(r, g, b);
        const k = mode === 'saturate' ? 1 + exposure : 1 - exposure;
        data[i] = y + (r - y) * k;
        data[i + 1] = y + (g - y) * k;
        data[i + 2] = y + (b - y) * k;
      }
    }
    return { width: image.width, height: image.height, data };
  }

  // out = original + (processed - original) * coverage/255 * opacity (coverage from a brush buffer's alpha).
  function mixByCoverage(original, processed, coverage, opacity = 1) {
    assertImage(original);
    assertImage(processed, 'processed image');
    const o = clampNumber(opacity, 0, 1, 1);
    const data = new Uint8ClampedArray(original.data);
    for (let p = 0, i = 0; i < data.length; p += 1, i += 4) {
      const w = (coverage[p] / 255) * o;
      if (w <= 0) continue;
      data[i] += (processed.data[i] - data[i]) * w;
      data[i + 1] += (processed.data[i + 1] - data[i + 1]) * w;
      data[i + 2] += (processed.data[i + 2] - data[i + 2]) * w;
      data[i + 3] += (processed.data[i + 3] - data[i + 3]) * w;
    }
    return { width: original.width, height: original.height, data };
  }

  // ---------------------------------------------------------------- histogram

  function histogram(image, mask = null) {
    assertImage(image);
    const r = new Uint32Array(256),
      g = new Uint32Array(256),
      b = new Uint32Array(256),
      l = new Uint32Array(256);
    for (let p = 0, i = 0; i < image.data.length; p += 1, i += 4) {
      if (image.data[i + 3] === 0 || (mask && mask[p] < 128)) continue;
      r[image.data[i]] += 1;
      g[image.data[i + 1]] += 1;
      b[image.data[i + 2]] += 1;
      l[Math.round(luma(image.data[i], image.data[i + 1], image.data[i + 2]))] += 1;
    }
    return { r, g, b, l };
  }

  // ---------------------------------------------------------------- worker bridge

  // ------------------------------------------------------------------ content-aware fill
  // Fills the masked hole from the rest of the picture. Coarse to fine: at each
  // pyramid level every patch touching the hole is matched to a fully-known
  // patch by randomized search (neighbors pass good matches along, then random
  // probes shrink around the best), and hole pixels become the weighted vote of
  // the matched patches. The coarsest level starts from an inward diffusion.
  const FILL_MAX_TARGET_PIXELS = 220000;
  function contentAwareFill(image, mask, options = {}) {
    assertImage(image);
    const W = image.width,
      H = image.height;
    if (!(mask instanceof Uint8Array || mask instanceof Uint8ClampedArray) || mask.length !== W * H)
      throw new Error('The fill area does not match the image.');
    const R = Math.round(clampNumber(options.patchRadius, 2, 6, 3));
    let seed = Math.round(clampNumber(options.seed, 0, 2 ** 31, 7)) | 0 || 7;
    const rand = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 4294967296;
    };
    // Hole: the mask plus a 2 px margin so anti-aliased edges are replaced too.
    let hole = new Uint8Array(W * H);
    let holeCount = 0;
    for (let i = 0; i < hole.length; i += 1)
      if (mask[i] > 32) {
        hole[i] = 1;
        holeCount += 1;
      }
    if (!holeCount) return cloneImage(image);
    hole = dilateBinary(hole, W, H, 2);
    holeCount = hole.reduce((a, b) => a + b, 0);
    if (holeCount >= W * H * 0.9)
      throw new Error('Leave more of the picture outside the area to fill.');
    // Pyramid of float RGBA (premultiplied so transparent pixels carry no color).
    const levels = [];
    let cur = { w: W, h: H, px: new Float32Array(W * H * 4), hole };
    for (let i = 0; i < W * H; i += 1) {
      const a = image.data[i * 4 + 3] / 255;
      cur.px[i * 4] = image.data[i * 4] * a;
      cur.px[i * 4 + 1] = image.data[i * 4 + 1] * a;
      cur.px[i * 4 + 2] = image.data[i * 4 + 2] * a;
      cur.px[i * 4 + 3] = image.data[i * 4 + 3];
    }
    levels.push(cur);
    const holeSpan = (lv) => {
      let x0 = lv.w,
        y0 = lv.h,
        x1 = -1,
        y1 = -1;
      for (let y = 0; y < lv.h; y += 1)
        for (let x = 0; x < lv.w; x += 1)
          if (lv.hole[y * lv.w + x]) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
      return Math.max(x1 - x0 + 1, y1 - y0 + 1);
    };
    while (levels.length < 9 && holeSpan(cur) > R * 4 && Math.min(cur.w, cur.h) > R * 8) {
      const w = Math.max(1, cur.w >> 1),
        h = Math.max(1, cur.h >> 1);
      const next = { w, h, px: new Float32Array(w * h * 4), hole: new Uint8Array(w * h) };
      for (let y = 0; y < h; y += 1)
        for (let x = 0; x < w; x += 1) {
          let any = 0,
            n = 0;
          const acc = [0, 0, 0, 0];
          for (let dy = 0; dy < 2; dy += 1)
            for (let dx = 0; dx < 2; dx += 1) {
              const sx = Math.min(cur.w - 1, x * 2 + dx),
                sy = Math.min(cur.h - 1, y * 2 + dy),
                si = sy * cur.w + sx;
              if (cur.hole[si]) {
                any = 1;
                continue;
              }
              for (let c = 0; c < 4; c += 1) acc[c] += cur.px[si * 4 + c];
              n += 1;
            }
          const o = y * w + x;
          next.hole[o] = any;
          if (n) for (let c = 0; c < 4; c += 1) next.px[o * 4 + c] = acc[c] / n;
        }
      levels.push(next);
      cur = next;
    }
    // Inward diffusion seeds the coarsest hole.
    diffuseInto(cur.px, cur.hole, cur.w, cur.h);
    let nnf = null,
      prev = null;
    for (let l = levels.length - 1; l >= 0; l -= 1) {
      const lv = levels[l],
        { w, h } = lv;
      if (prev) {
        // Upsample the previous level's filled pixels into this level's hole.
        for (let y = 0; y < h; y += 1)
          for (let x = 0; x < w; x += 1) {
            const o = y * w + x;
            if (!lv.hole[o]) continue;
            const px = Math.min(prev.w - 1, x >> 1),
              py = Math.min(prev.h - 1, y >> 1),
              po = (py * prev.w + px) * 4;
            for (let c = 0; c < 4; c += 1) lv.px[o * 4 + c] = prev.px[po + c];
          }
      }
      // Source centers: patches entirely inside the image and outside the hole.
      const holeAt = integralOf(lv.hole, w, h);
      const valid = new Uint8Array(w * h);
      let validCount = 0;
      for (let y = R; y < h - R; y += 1)
        for (let x = R; x < w - R; x += 1) {
          if (sumRect(holeAt, w, x - R, y - R, x + R, y + R) === 0) {
            valid[y * w + x] = 1;
            validCount += 1;
          }
        }
      if (!validCount) {
        prev = lv;
        nnf = null;
        continue;
      }
      const validList = new Int32Array(validCount);
      for (let i = 0, k = 0; i < valid.length; i += 1) if (valid[i]) validList[k++] = i;
      // Targets: centers whose patch touches the hole.
      const near = dilateBinary(lv.hole, w, h, R);
      const targets = [];
      for (let i = 0; i < near.length; i += 1) if (near[i]) targets.push(i);
      // Too much work at full size: stop at the previous level (prev) and upsample it smoothly.
      if (l === 0 && targets.length > FILL_MAX_TARGET_PIXELS && prev) break;
      const match = new Int32Array(w * h).fill(-1);
      const cost = new Float64Array(w * h).fill(Infinity);
      const dist = (t, s, limit) => {
        const tx = t % w,
          ty = (t - tx) / w,
          sx = s % w,
          sy = (s - sx) / w;
        let d = 0,
          n = 0;
        for (let dy = -R; dy <= R; dy += 1) {
          const yy = ty + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -R; dx <= R; dx += 1) {
            const xx = tx + dx;
            if (xx < 0 || xx >= w) continue;
            const a = (yy * w + xx) * 4,
              b = ((sy + dy) * w + sx + dx) * 4;
            const e0 = lv.px[a] - lv.px[b],
              e1 = lv.px[a + 1] - lv.px[b + 1],
              e2 = lv.px[a + 2] - lv.px[b + 2],
              e3 = lv.px[a + 3] - lv.px[b + 3];
            d += e0 * e0 + e1 * e1 + e2 * e2 + e3 * e3;
            n += 1;
            if (d > limit * n) return Infinity;
          }
        }
        return n ? d / n : Infinity;
      };
      const tryMatch = (t, s) => {
        if (s < 0 || s >= valid.length || !valid[s] || s === match[t]) return;
        const d = dist(t, s, cost[t]);
        if (d < cost[t]) {
          cost[t] = d;
          match[t] = s;
        }
      };
      for (const t of targets) {
        let s = -1;
        if (nnf && prev) {
          const tx = t % w,
            ty = (t - tx) / w,
            pi = Math.min(prev.h - 1, ty >> 1) * prev.w + Math.min(prev.w - 1, tx >> 1);
          const ps = nnf[pi];
          if (ps >= 0) {
            const psx = ps % prev.w,
              psy = (ps - psx) / prev.w;
            s = Math.min(h - 1, psy * 2 + (ty & 1)) * w + Math.min(w - 1, psx * 2 + (tx & 1));
          }
        }
        if (s < 0 || !valid[s]) s = validList[Math.floor(rand() * validCount)];
        match[t] = s;
        cost[t] = dist(t, s, Infinity);
      }
      const iterations = l === levels.length - 1 ? 6 : l === 0 ? 3 : 4;
      let votes = null;
      const searchMax = Math.max(w, h);
      for (let it = 0; it < iterations; it += 1) {
        for (let pass = 0; pass < 2; pass += 1) {
          const forward = pass % 2 === 0,
            step = forward ? 1 : -1;
          for (let k = forward ? 0 : targets.length - 1; k >= 0 && k < targets.length; k += step) {
            const t = targets[k],
              tx = t % w;
            // Propagation: a neighbor's match, shifted back by one.
            if (tx - step >= 0 && tx - step < w) {
              const m = match[t - step];
              if (m >= 0) tryMatch(t, m + step);
            }
            if (t - step * w >= 0 && t - step * w < w * h) {
              const m = match[t - step * w];
              if (m >= 0) tryMatch(t, m + step * w);
            }
            // Random search in a shrinking window.
            const best = match[t],
              bx = best % w,
              by = (best - bx) / w;
            for (let radius = searchMax; radius >= 1; radius >>= 1) {
              const cx = Math.round(bx + (rand() * 2 - 1) * radius),
                cy = Math.round(by + (rand() * 2 - 1) * radius);
              if (cx >= 0 && cy >= 0 && cx < w && cy < h) tryMatch(t, cy * w + cx);
            }
          }
        }
        // Voting: hole pixels become the similarity-weighted average of matched patches.
        if (!votes) votes = holeVotes(lv);
        const { acc, weight } = votes;
        acc.fill(0);
        weight.fill(0);
        let sigma = 0,
          count = 0;
        for (const t of targets)
          if (Number.isFinite(cost[t])) {
            sigma += cost[t];
            count += 1;
          }
        sigma = Math.max(1, count ? sigma / count : 1);
        for (const t of targets) {
          const s = match[t];
          if (s < 0) continue;
          const wgt = Math.exp(-cost[t] / (2 * sigma));
          const tx = t % w,
            ty = (t - tx) / w,
            sx = s % w,
            sy = (s - sx) / w;
          for (let dy = -R; dy <= R; dy += 1) {
            const yy = ty + dy;
            if (yy < 0 || yy >= h) continue;
            for (let dx = -R; dx <= R; dx += 1) {
              const xx = tx + dx;
              if (xx < 0 || xx >= w) continue;
              const o = yy * w + xx;
              if (!lv.hole[o]) continue;
              const b = ((sy + dy) * w + sx + dx) * 4,
                k = votes.index[o];
              acc[k * 4] += lv.px[b] * wgt;
              acc[k * 4 + 1] += lv.px[b + 1] * wgt;
              acc[k * 4 + 2] += lv.px[b + 2] * wgt;
              acc[k * 4 + 3] += lv.px[b + 3] * wgt;
              weight[k] += wgt;
            }
          }
        }
        for (const o of votes.holes) {
          const k = votes.index[o];
          if (weight[k] > 0)
            for (let c = 0; c < 4; c += 1) lv.px[o * 4 + c] = acc[k * 4 + c] / weight[k];
        }
        for (const t of targets) cost[t] = dist(t, match[t], Infinity);
      }
      nnf = match;
      prev = lv;
    }
    // If the finest level was skipped (huge hole) the last solved level is upsampled.
    const solved = prev;
    const out = cloneImage(image);
    for (let y = 0; y < H; y += 1)
      for (let x = 0; x < W; x += 1) {
        const o = y * W + x;
        if (!hole[o]) continue;
        let v;
        if (solved.w === W)
          v = [solved.px[o * 4], solved.px[o * 4 + 1], solved.px[o * 4 + 2], solved.px[o * 4 + 3]];
        else {
          const fx = Math.min(solved.w - 1, ((x + 0.5) * solved.w) / W - 0.5),
            fy = Math.min(solved.h - 1, ((y + 0.5) * solved.h) / H - 0.5);
          v = bilinear4(solved, Math.max(0, fx), Math.max(0, fy));
        }
        const a = v[3];
        out.data[o * 4] = a > 0 ? v[0] / (a / 255) : 0;
        out.data[o * 4 + 1] = a > 0 ? v[1] / (a / 255) : 0;
        out.data[o * 4 + 2] = a > 0 ? v[2] / (a / 255) : 0;
        out.data[o * 4 + 3] = a;
      }
    return out;
  }
  // Vote accumulators sized to the hole only (a compact index per hole pixel).
  function holeVotes(lv) {
    let n = 0;
    for (let i = 0; i < lv.hole.length; i += 1) if (lv.hole[i]) n += 1;
    const holes = new Int32Array(n),
      index = new Int32Array(lv.hole.length);
    for (let i = 0, k = 0; i < lv.hole.length; i += 1)
      if (lv.hole[i]) {
        holes[k] = i;
        index[i] = k;
        k += 1;
      }
    return { holes, index, acc: new Float64Array(n * 4), weight: new Float64Array(n) };
  }
  function bilinear4(lv, fx, fy) {
    const x0 = Math.floor(fx),
      y0 = Math.floor(fy),
      x1 = Math.min(lv.w - 1, x0 + 1),
      y1 = Math.min(lv.h - 1, y0 + 1),
      ax = fx - x0,
      ay = fy - y0;
    const at = (x, y, c) => lv.px[(y * lv.w + x) * 4 + c];
    return [0, 1, 2, 3].map(
      (c) =>
        (at(x0, y0, c) * (1 - ax) + at(x1, y0, c) * ax) * (1 - ay) +
        (at(x0, y1, c) * (1 - ax) + at(x1, y1, c) * ax) * ay,
    );
  }
  function dilateBinary(src, w, h, r) {
    if (r <= 0) return new Uint8Array(src);
    const tmp = new Uint8Array(w * h),
      out = new Uint8Array(w * h);
    for (let y = 0; y < h; y += 1) {
      let last = -1e9;
      for (let x = 0; x < w; x += 1) {
        if (src[y * w + x]) last = x;
        if (x - last <= r) tmp[y * w + x] = 1;
      }
      last = 1e9;
      for (let x = w - 1; x >= 0; x -= 1) {
        if (src[y * w + x]) last = x;
        if (last - x <= r) tmp[y * w + x] = 1;
      }
    }
    for (let x = 0; x < w; x += 1) {
      let last = -1e9;
      for (let y = 0; y < h; y += 1) {
        if (tmp[y * w + x]) last = y;
        if (y - last <= r) out[y * w + x] = 1;
      }
      last = 1e9;
      for (let y = h - 1; y >= 0; y -= 1) {
        if (tmp[y * w + x]) last = y;
        if (last - y <= r) out[y * w + x] = 1;
      }
    }
    return out;
  }
  function integralOf(bin, w, h) {
    const I = new Int32Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y += 1) {
      let row = 0;
      for (let x = 0; x < w; x += 1) {
        row += bin[y * w + x];
        I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row;
      }
    }
    return I;
  }
  function sumRect(I, w, x0, y0, x1, y1) {
    const W1 = w + 1;
    return (
      I[(y1 + 1) * W1 + x1 + 1] - I[y0 * W1 + x1 + 1] - I[(y1 + 1) * W1 + x0] + I[y0 * W1 + x0]
    );
  }
  // Onion-peel fill: each ring of hole pixels takes the mean of its known neighbors.
  function diffuseInto(px, hole, w, h) {
    const known = new Uint8Array(w * h);
    let remaining = 0;
    for (let i = 0; i < known.length; i += 1) {
      known[i] = hole[i] ? 0 : 1;
      if (hole[i]) remaining += 1;
    }
    while (remaining > 0) {
      const ring = [];
      for (let y = 0; y < h; y += 1)
        for (let x = 0; x < w; x += 1) {
          const o = y * w + x;
          if (known[o]) continue;
          const acc = [0, 0, 0, 0];
          let n = 0;
          for (let dy = -1; dy <= 1; dy += 1)
            for (let dx = -1; dx <= 1; dx += 1) {
              const xx = x + dx,
                yy = y + dy;
              if ((dx || dy) && xx >= 0 && yy >= 0 && xx < w && yy < h && known[yy * w + xx]) {
                const q = (yy * w + xx) * 4;
                for (let c = 0; c < 4; c += 1) acc[c] += px[q + c];
                n += 1;
              }
            }
          if (n) ring.push([o, acc.map((v) => v / n)]);
        }
      if (!ring.length) break;
      for (const [o, v] of ring) {
        for (let c = 0; c < 4; c += 1) px[o * 4 + c] = v[c];
        known[o] = 1;
        remaining -= 1;
      }
    }
  }

  const WORKER_OPS = Object.freeze({
    applyAdjustment: (args) => applyAdjustment(args.image, args.kind, args.params),
    applyFilter: (args) => applyFilter(args.image, args.name, args.params),
    mixImages: (args) => mixImages(args.original, args.processed, args.mask, args.opacity),
    floodSelect: (args) => ({ mask: floodSelect(args.image, args.x, args.y, args.options) }),
    featherMask: (args) => ({ mask: featherMask(args.mask, args.width, args.height, args.radius) }),
    spotHeal: (args) => spotHeal(args.image, args.x, args.y, args.radius, args.options),
    contentAwareFill: (args) => contentAwareFill(args.image, args.mask, args.options),
  });

  function transferList(value, list = []) {
    if (!value || typeof value !== 'object') return list;
    if (ArrayBuffer.isView(value)) {
      if (!list.includes(value.buffer)) list.push(value.buffer);
      return list;
    }
    for (const key of Object.keys(value)) transferList(value[key], list);
    return list;
  }

  function serveWorker(scope) {
    scope.addEventListener('message', (event) => {
      const { id, op, args } = event.data || {};
      try {
        const fn = WORKER_OPS[op];
        if (!fn) throw new Error(`Unknown pixel job: ${op}`);
        const result = fn(args || {});
        scope.postMessage({ id, ok: true, result }, transferList(result));
      } catch (error) {
        scope.postMessage({ id, ok: false, error: String(error?.message || error) });
      }
    });
  }

  // Main-thread client: runs jobs in a worker when possible, inline otherwise.
  function createPixelWorker(scriptUrl, options = {}) {
    let worker = null;
    let nextId = 1;
    const pending = new Map();
    const WorkerCtor = options.Worker || globalThis.Worker;
    if (scriptUrl && typeof WorkerCtor === 'function') {
      try {
        worker = new WorkerCtor(scriptUrl);
        worker.addEventListener('message', (event) => {
          const job = pending.get(event.data?.id);
          if (!job) return;
          pending.delete(event.data.id);
          if (event.data.ok) job.resolve(event.data.result);
          else job.reject(new Error(event.data.error));
        });
        worker.addEventListener('error', (event) => {
          event.preventDefault?.();
          // In-flight inputs were transferred to the worker (their buffers are now
          // empty here), so they cannot be retried; later jobs run on the main thread.
          const error = new Error(
            'The pixel worker stopped (possibly out of memory). Nothing was changed; try the action again.',
          );
          for (const job of pending.values()) job.reject(error);
          pending.clear();
          worker = null;
        });
      } catch {
        worker = null;
      }
    }
    function inline(op, args) {
      return new Promise((resolve, reject) => {
        const run = () => {
          try {
            resolve(WORKER_OPS[op](args));
          } catch (error) {
            reject(error);
          }
        };
        setTimeout(run, 0);
      });
    }
    return Object.freeze({
      get threaded() {
        return Boolean(worker);
      },
      run(op, args, transfer = true) {
        if (!WORKER_OPS[op]) return Promise.reject(new Error(`Unknown pixel job: ${op}`));
        if (!worker) return inline(op, args);
        return new Promise((resolve, reject) => {
          const id = nextId++;
          pending.set(id, { resolve, reject });
          worker.postMessage({ id, op, args }, transfer ? transferList(args) : []);
        });
      },
      terminate() {
        worker?.terminate();
        worker = null;
      },
    });
  }

  return Object.freeze({
    version: '0.3.0',
    MAX_PIXELS,
    ADJUSTMENT_KINDS,
    ADJUSTMENT_DEFAULTS,
    SELECTION_OPERATIONS,
    FILTER_NAMES: Object.freeze(Object.keys(FILTERS)),
    createImage,
    cloneImage,
    createMask,
    parseHex,
    toHex,
    rgbToHsb,
    hsbToRgb,
    rgbToHsl,
    hslToRgb,
    luma,
    brushFalloff,
    brushTip,
    spacedDabs,
    floodSelect,
    colorRangeMask,
    softenEdges,
    rasterizePolygon,
    rectanglePoints,
    ellipsePoints,
    rectangleMask,
    ellipseMask,
    combineMasks,
    invertMask,
    maskBounds,
    maskCoverage,
    boxSizesForGauss,
    featherMask,
    expandMask,
    contractMask,
    maskOutline,
    downsampleMask,
    mixImages,
    fillSelection,
    clearSelection,
    extractSelection,
    levelsLut,
    curveLut,
    applyAdjustment,
    gaussianBlur,
    unsharpMask,
    convolve3x3,
    sharpen,
    addNoise,
    reduceNoise,
    motionBlur,
    pixelate,
    emboss,
    highPass,
    applyFilter,
    redEye,
    findHealSource,
    healPatch,
    spotHeal,
    contentAwareFill,
    liquify,
    createLiquifyField,
    liquifyBrush,
    toneRegion,
    mixByCoverage,
    histogram,
    serveWorker,
    createPixelWorker,
  });
});
