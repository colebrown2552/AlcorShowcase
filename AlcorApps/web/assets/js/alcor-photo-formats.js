/**
 * alcor-photo-formats.js: AlcorPhoto file formats.
 *
 * Readers and writers for the image formats AlcorPhoto opens and exports:
 * PNG, JPEG, WebP, AVIF, GIF, BMP, TIFF, ICO, SVG and layered PSD.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AlcorPhotoFormats = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Image file formats for AlcorPhoto, written from the public format specifications.
  // Everything runs locally: no network access, no dependencies. Images are plain
  // { width, height, data } objects with straight (non-premultiplied) RGBA bytes.
  // Decoders check headers and dimensions before allocating and fail closed with a
  // readable Error on corrupt, hostile, or unsupported input.

  const MAX_PIXELS = 64 * 1024 * 1024;
  const MAX_SIDE = 16384;
  const HARD_MAX_SIDE = 300000; // PSB documents; per-call limits can never exceed these ceilings
  const TRACE_MAX_PIXELS = 4 * 1024 * 1024;
  const TRACE_MAX_POINTS = 2000000;
  const ICO_SIZES = Object.freeze([16, 32, 48, 64, 128, 256]);
  const PNG_SIGNATURE = Object.freeze([137, 80, 78, 71, 13, 10, 26, 10]);
  const BLEND_KEYS = Object.freeze({
    normal: 'norm',
    multiply: 'mul ',
    screen: 'scrn',
    overlay: 'over',
    darken: 'dark',
    lighten: 'lite',
    'color-dodge': 'div ',
    'color-burn': 'idiv',
    'hard-light': 'hLit',
    'soft-light': 'sLit',
    difference: 'diff',
    exclusion: 'smud',
    hue: 'hue ',
    saturation: 'sat ',
    color: 'colr',
    luminosity: 'lum ',
  });
  const BLEND_MODES = Object.freeze(Object.keys(BLEND_KEYS));
  const BLEND_BY_KEY = Object.freeze(
    Object.fromEntries(Object.entries(BLEND_KEYS).map(([name, key]) => [key, name])),
  );

  // ---------------------------------------------------------------- shared helpers

  function fail(message) {
    throw new Error(message);
  }

  function toBytes(input, label = 'file') {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input))
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return fail(`The ${label} must be bytes (Uint8Array or ArrayBuffer).`);
  }

  function limitsOf(opts) {
    const o = opts || {};
    return {
      maxPixels:
        Number.isFinite(o.maxPixels) && o.maxPixels >= 1
          ? Math.min(Math.floor(o.maxPixels), MAX_PIXELS)
          : MAX_PIXELS,
      maxSide:
        Number.isFinite(o.maxSide) && o.maxSide >= 1
          ? Math.min(Math.floor(o.maxSide), HARD_MAX_SIDE)
          : MAX_SIDE,
    };
  }

  function checkSize(width, height, limits, label) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
      fail(`This ${label} image has invalid dimensions (${width}×${height}).`);
    if (width > limits.maxSide || height > limits.maxSide)
      fail(
        `${label} images are limited to ${limits.maxSide} pixels per side (this one is ${width}×${height}).`,
      );
    if (width * height > limits.maxPixels)
      fail(
        `${label} images are limited to ${limits.maxPixels.toLocaleString('en-US')} pixels (this one is ${width}×${height}).`,
      );
  }

  function asImage(image, label, opts) {
    if (!image || typeof image !== 'object') fail(`${label} export needs image data.`);
    const { width, height, data } = image;
    checkSize(width, height, limitsOf(opts), label);
    const okType =
      data instanceof Uint8Array ||
      (typeof Uint8ClampedArray === 'function' && data instanceof Uint8ClampedArray);
    if (!okType || data.length !== width * height * 4)
      fail(`${label} export needs ${width}×${height} RGBA data.`);
    return { width, height, data };
  }

  function isOpaque(data) {
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return false;
    return true;
  }

  function clampInt(value, lo, hi, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
  }

  function dpiOf(opts) {
    const dpi = Number(opts && opts.dpi);
    if (opts && opts.dpi != null && !(Number.isFinite(dpi) && dpi > 0 && dpi <= 100000))
      fail('Resolution must be a positive number of dots per inch.');
    return opts && opts.dpi != null ? dpi : 72;
  }

  function concat(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  function ascii(text) {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 255;
    return out;
  }

  function utf8(text) {
    const s = String(text);
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(s);
    const out = [];
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else
        out.push(
          0xf0 | (c >> 18),
          0x80 | ((c >> 12) & 63),
          0x80 | ((c >> 6) & 63),
          0x80 | (c & 63),
        );
    }
    return new Uint8Array(out);
  }

  function utf8Decode(bytes) {
    if (typeof TextDecoder === 'function') return new TextDecoder('utf-8').decode(bytes);
    let s = '';
    for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function hasSignature(bytes, sig, at = 0) {
    if (bytes.length < at + sig.length) return false;
    for (let i = 0; i < sig.length; i += 1)
      if (bytes[at + i] !== (typeof sig === 'string' ? sig.charCodeAt(i) : sig[i])) return false;
    return true;
  }

  // Growable byte buffer.
  class Writer {
    constructor(size = 4096) {
      this.buf = new Uint8Array(Math.max(16, size));
      this.length = 0;
    }
    reserve(n) {
      const need = this.length + n;
      if (need <= this.buf.length) return;
      let cap = this.buf.length * 2;
      while (cap < need) cap *= 2;
      const next = new Uint8Array(cap);
      next.set(this.buf.subarray(0, this.length));
      this.buf = next;
    }
    u8(v) {
      this.reserve(1);
      this.buf[this.length++] = v & 255;
    }
    u16le(v) {
      this.reserve(2);
      const b = this.buf,
        o = this.length;
      b[o] = v & 255;
      b[o + 1] = (v >>> 8) & 255;
      this.length += 2;
    }
    u16be(v) {
      this.reserve(2);
      const b = this.buf,
        o = this.length;
      b[o] = (v >>> 8) & 255;
      b[o + 1] = v & 255;
      this.length += 2;
    }
    u32le(v) {
      this.reserve(4);
      this.setU32le(this.length, v);
      this.length += 4;
    }
    u32be(v) {
      this.reserve(4);
      this.setU32be(this.length, v);
      this.length += 4;
    }
    setU32le(at, v) {
      const b = this.buf;
      b[at] = v & 255;
      b[at + 1] = (v >>> 8) & 255;
      b[at + 2] = (v >>> 16) & 255;
      b[at + 3] = (v >>> 24) & 255;
    }
    setU32be(at, v) {
      const b = this.buf;
      b[at] = (v >>> 24) & 255;
      b[at + 1] = (v >>> 16) & 255;
      b[at + 2] = (v >>> 8) & 255;
      b[at + 3] = v & 255;
    }
    bytes(arr) {
      this.reserve(arr.length);
      this.buf.set(arr, this.length);
      this.length += arr.length;
    }
    ascii(text) {
      this.reserve(text.length);
      for (let i = 0; i < text.length; i += 1) this.buf[this.length++] = text.charCodeAt(i) & 255;
    }
    pad(multiple, from = 0) {
      while ((this.length - from) % multiple) this.u8(0);
    }
    result() {
      return this.buf.slice(0, this.length);
    }
  }

  // Bounds-checked reader.
  function makeReader(bytes, littleEndian, label) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 0;
    const need = (n) => {
      if (!(n >= 0) || pos + n > bytes.length) fail(`This ${label} file is truncated.`);
    };
    return {
      get pos() {
        return pos;
      },
      set pos(v) {
        if (!(v >= 0) || v > bytes.length) fail(`This ${label} file is truncated.`);
        pos = v;
      },
      remaining() {
        return bytes.length - pos;
      },
      u8() {
        need(1);
        return bytes[pos++];
      },
      u16() {
        need(2);
        const v = view.getUint16(pos, littleEndian);
        pos += 2;
        return v;
      },
      i16() {
        need(2);
        const v = view.getInt16(pos, littleEndian);
        pos += 2;
        return v;
      },
      u32() {
        need(4);
        const v = view.getUint32(pos, littleEndian);
        pos += 4;
        return v;
      },
      i32() {
        need(4);
        const v = view.getInt32(pos, littleEndian);
        pos += 4;
        return v;
      },
      u64() {
        need(8);
        const a = view.getUint32(pos, littleEndian),
          b = view.getUint32(pos + 4, littleEndian);
        const hi = littleEndian ? b : a,
          lo = littleEndian ? a : b;
        pos += 8;
        if (hi > 0x1fffff) fail(`This ${label} section is too large.`);
        return hi * 4294967296 + lo;
      },
      text(n) {
        need(n);
        let s = '';
        for (let i = 0; i < n; i += 1) s += String.fromCharCode(bytes[pos + i]);
        pos += n;
        return s;
      },
      bytes(n) {
        need(n);
        const v = bytes.subarray(pos, pos + n);
        pos += n;
        return v;
      },
      skip(n) {
        need(n);
        pos += n;
      },
    };
  }

  let crcTable = null;
  function crc32(bytes, crc = 0) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    let c = (crc ^ 0xffffffff) >>> 0;
    for (let i = 0; i < bytes.length; i += 1) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function adler32(bytes) {
    let a = 1,
      b = 0;
    for (let i = 0; i < bytes.length; ) {
      const end = Math.min(bytes.length, i + 5552);
      for (; i < end; i += 1) {
        a += bytes[i];
        b += a;
      }
      a %= 65521;
      b %= 65521;
    }
    return ((b << 16) | a) >>> 0;
  }

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function base64(bytes) {
    const parts = [];
    let line = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      line +=
        B64[(n >> 18) & 63] +
        B64[(n >> 12) & 63] +
        (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') +
        (i + 2 < bytes.length ? B64[n & 63] : '=');
      if (line.length >= 8192) {
        parts.push(line);
        line = '';
      }
    }
    parts.push(line);
    return parts.join('');
  }

  // PackBits (used by TIFF and PSD). Runs of 2..128 repeat a byte; literals hold 1..128 bytes.
  function packBits(src, start, end, out) {
    const begin = out.length;
    let i = start;
    while (i < end) {
      let run = 1;
      while (i + run < end && run < 128 && src[i + run] === src[i]) run += 1;
      if (run >= 2) {
        out.u8(257 - run);
        out.u8(src[i]);
        i += run;
        continue;
      }
      let lit = 1;
      while (
        i + lit < end &&
        lit < 128 &&
        !(
          i + lit + 2 < end &&
          src[i + lit] === src[i + lit + 1] &&
          src[i + lit] === src[i + lit + 2]
        )
      )
        lit += 1;
      out.u8(lit - 1);
      out.bytes(src.subarray(i, i + lit));
      i += lit;
    }
    return out.length - begin;
  }

  function unpackBits(src, inPos, inEnd, out, outPos, outLen, label) {
    let i = inPos,
      o = outPos;
    const end = outPos + outLen;
    while (o < end) {
      if (i >= inEnd) fail(`${label} run-length data ended early.`);
      let n = src[i++];
      if (n > 127) n -= 256;
      if (n >= 0) {
        if (i + n + 1 > inEnd || o + n + 1 > end) fail(`${label} run-length data is corrupt.`);
        out.set(src.subarray(i, i + n + 1), o);
        i += n + 1;
        o += n + 1;
      } else if (n !== -128) {
        if (i >= inEnd || o + 1 - n > end) fail(`${label} run-length data is corrupt.`);
        out.fill(src[i++], o, o + 1 - n);
        o += 1 - n;
      }
    }
    return i;
  }

  // LZW shared by GIF (LSB-first bit order) and TIFF (MSB-first with "early change").
  function lzwEncode(src, minSize, msb, early) {
    if (!Number.isInteger(minSize) || minSize < 2 || minSize > 8)
      fail('LZW code size must be an integer from 2 to 8.');
    const clear = 1 << minSize,
      eoi = clear + 1,
      limit = early ? 4094 : 4096;
    if (minSize < 8)
      for (let i = 0; i < src.length; i += 1)
        if (src[i] >= clear) fail(`LZW symbols must be below ${clear} for code size ${minSize}.`);
    const out = new Writer((src.length >> 1) + 64);
    let bitBuf = 0,
      bitCount = 0,
      codeLen = minSize + 1,
      next = eoi + 1;
    const put = (code) => {
      if (msb) {
        bitBuf = (bitBuf << codeLen) | code;
        bitCount += codeLen;
        while (bitCount >= 8) {
          out.u8(bitBuf >>> (bitCount - 8));
          bitCount -= 8;
          bitBuf &= (1 << bitCount) - 1;
        }
      } else {
        bitBuf |= code << bitCount;
        bitCount += codeLen;
        while (bitCount >= 8) {
          out.u8(bitBuf & 255);
          bitBuf >>>= 8;
          bitCount -= 8;
        }
      }
    };
    const grow = () => {
      next += 1;
      if (next > (early ? (1 << codeLen) - 1 : 1 << codeLen) && codeLen < 12) codeLen += 1;
    };
    const dict = new Map();
    put(clear);
    if (src.length) {
      let prefix = src[0];
      for (let i = 1; i < src.length; i += 1) {
        const k = src[i];
        const key = prefix * 256 + k;
        const hit = dict.get(key);
        if (hit !== undefined) {
          prefix = hit;
          continue;
        }
        put(prefix);
        if (next < limit) {
          dict.set(key, next);
          grow();
        } else {
          put(clear);
          dict.clear();
          codeLen = minSize + 1;
          next = eoi + 1;
        }
        prefix = k;
      }
      put(prefix);
      if (next < limit) grow();
    }
    put(eoi);
    if (bitCount > 0) out.u8(msb ? bitBuf << (8 - bitCount) : bitBuf);
    return out.result();
  }

  // Decodes into out[outPos, outPos+outLen). Returns the byte count produced.
  function lzwDecode(src, minSize, msb, early, out, outPos, outLen, label) {
    const clear = 1 << minSize,
      eoi = clear + 1;
    const prefix = new Int16Array(4096),
      suffix = new Uint8Array(4096),
      first = new Uint8Array(4096),
      size = new Uint16Array(4096);
    for (let i = 0; i < clear; i += 1) {
      prefix[i] = -1;
      suffix[i] = i;
      first[i] = i;
      size[i] = 1;
    }
    let codeLen = minSize + 1,
      next = eoi + 1,
      old = -1,
      bitBuf = 0,
      bitCount = 0,
      p = 0,
      o = outPos;
    const end = outPos + outLen;
    const emit = (code) => {
      const len = size[code];
      for (let k = len - 1, c = code; k >= 0; k -= 1) {
        if (o + k < end) out[o + k] = suffix[c];
        c = prefix[c];
      }
      o = Math.min(end, o + len);
    };
    while (o < end) {
      while (bitCount < codeLen) {
        if (p >= src.length) return o - outPos;
        if (msb) bitBuf = ((bitBuf << 8) | src[p++]) & 0xffffff;
        else bitBuf |= src[p++] << bitCount;
        bitCount += 8;
      }
      let code;
      if (msb) {
        code = (bitBuf >>> (bitCount - codeLen)) & ((1 << codeLen) - 1);
        bitCount -= codeLen;
      } else {
        code = bitBuf & ((1 << codeLen) - 1);
        bitBuf >>>= codeLen;
        bitCount -= codeLen;
      }
      if (code === clear) {
        codeLen = minSize + 1;
        next = eoi + 1;
        old = -1;
        continue;
      }
      if (code === eoi) break;
      if (old === -1) {
        if (code >= clear) fail(`${label} LZW data is corrupt.`);
        emit(code);
        old = code;
        continue;
      }
      if (code > next || (code === next && next >= 4096)) fail(`${label} LZW data is corrupt.`);
      if (next < 4096) {
        prefix[next] = old;
        suffix[next] = code === next ? first[old] : first[code];
        first[next] = first[old];
        size[next] = size[old] + 1;
        next += 1;
        if (next >= (early ? (1 << codeLen) - 1 : 1 << codeLen) && codeLen < 12) codeLen += 1;
      }
      emit(code);
      old = code;
    }
    return o - outPos;
  }

  // ---------------------------------------------------------------- resampling & quantizing

  function boxWeights(src, dst) {
    const scale = src / dst;
    const start = new Int32Array(dst),
      count = new Int32Array(dst),
      list = [];
    for (let i = 0; i < dst; i += 1) {
      const s0 = i * scale,
        s1 = (i + 1) * scale;
      const j0 = Math.floor(s0),
        j1 = Math.min(src, Math.ceil(s1));
      start[i] = list.length;
      for (let j = j0; j < j1; j += 1) {
        const w = (Math.min(s1, j + 1) - Math.max(s0, j)) / scale;
        if (w > 0) list.push(j, w);
      }
      count[i] = (list.length - start[i]) / 2;
    }
    return { start, count, list };
  }

  // Area-average (box) resampling with premultiplied alpha. Pure; returns a new image.
  function resizeArea(image, width, height) {
    const src = asImage(image, 'Resize');
    checkSize(width, height, limitsOf(), 'Resized');
    const xs = boxWeights(src.width, width),
      ys = boxWeights(src.height, height);
    const out = new Uint8ClampedArray(width * height * 4);
    const acc = new Float64Array(width * 4);
    const sd = src.data,
      sw = src.width;
    for (let ty = 0; ty < height; ty += 1) {
      acc.fill(0);
      for (let k = 0; k < ys.count[ty]; k += 1) {
        const sy = ys.list[ys.start[ty] + k * 2],
          wy = ys.list[ys.start[ty] + k * 2 + 1];
        const rowBase = sy * sw * 4;
        for (let tx = 0; tx < width; tx += 1) {
          let r = 0,
            g = 0,
            b = 0,
            a = 0;
          for (let m = 0, at = xs.start[tx]; m < xs.count[tx]; m += 1, at += 2) {
            const o = rowBase + xs.list[at] * 4,
              w = xs.list[at + 1],
              wa = w * sd[o + 3];
            r += sd[o] * wa;
            g += sd[o + 1] * wa;
            b += sd[o + 2] * wa;
            a += wa;
          }
          const t = tx * 4;
          acc[t] += r * wy;
          acc[t + 1] += g * wy;
          acc[t + 2] += b * wy;
          acc[t + 3] += a * wy;
        }
      }
      const base = ty * width * 4;
      for (let t = 0; t < width * 4; t += 4) {
        const a = acc[t + 3];
        if (a > 0) {
          out[base + t] = acc[t] / a;
          out[base + t + 1] = acc[t + 1] / a;
          out[base + t + 2] = acc[t + 2] / a;
        }
        out[base + t + 3] = a;
      }
    }
    return { width, height, data: out };
  }

  function fitInto(image, box, allowUpscale) {
    const k = Math.min(box / image.width, box / image.height);
    if (!allowUpscale && k >= 1) return image;
    return resizeArea(
      image,
      Math.max(1, Math.round(image.width * k)),
      Math.max(1, Math.round(image.height * k)),
    );
  }

  // Median cut over a 5-bit-per-channel histogram of opaque pixels.
  function medianCut(data, slots, alphaThreshold) {
    const hist = new Uint32Array(32768),
      sums = new Float64Array(32768 * 3);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < alphaThreshold) continue;
      const bin = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
      hist[bin] += 1;
      sums[bin * 3] += data[i];
      sums[bin * 3 + 1] += data[i + 1];
      sums[bin * 3 + 2] += data[i + 2];
    }
    const shrink = (box) => {
      const lo = [31, 31, 31],
        hi = [0, 0, 0];
      let count = 0;
      for (let r = box.lo[0]; r <= box.hi[0]; r += 1)
        for (let g = box.lo[1]; g <= box.hi[1]; g += 1)
          for (let b = box.lo[2]; b <= box.hi[2]; b += 1) {
            const c = hist[(r << 10) | (g << 5) | b];
            if (!c) continue;
            count += c;
            if (r < lo[0]) lo[0] = r;
            if (r > hi[0]) hi[0] = r;
            if (g < lo[1]) lo[1] = g;
            if (g > hi[1]) hi[1] = g;
            if (b < lo[2]) lo[2] = b;
            if (b > hi[2]) hi[2] = b;
          }
      return count ? { lo, hi, count } : null;
    };
    const firstBox = shrink({ lo: [0, 0, 0], hi: [31, 31, 31] });
    const boxes = firstBox ? [firstBox] : [];
    while (boxes.length < slots) {
      let best = -1,
        bestScore = 0;
      boxes.forEach((box, i) => {
        const side = Math.max(box.hi[0] - box.lo[0], box.hi[1] - box.lo[1], box.hi[2] - box.lo[2]);
        const score = side > 0 ? box.count * side : 0;
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      });
      if (best < 0) break;
      const box = boxes[best];
      let axis = 0;
      for (let a = 1; a < 3; a += 1)
        if (box.hi[a] - box.lo[a] > box.hi[axis] - box.lo[axis]) axis = a;
      const planes = new Float64Array(32);
      for (let r = box.lo[0]; r <= box.hi[0]; r += 1)
        for (let g = box.lo[1]; g <= box.hi[1]; g += 1)
          for (let b = box.lo[2]; b <= box.hi[2]; b += 1) {
            planes[axis === 0 ? r : axis === 1 ? g : b] += hist[(r << 10) | (g << 5) | b];
          }
      let cut = box.lo[axis],
        acc = planes[cut];
      while (cut < box.hi[axis] - 1 && acc < box.count / 2) {
        cut += 1;
        acc += planes[cut];
      }
      const left = { lo: box.lo.slice(), hi: box.hi.slice() },
        right = { lo: box.lo.slice(), hi: box.hi.slice() };
      left.hi[axis] = cut;
      right.lo[axis] = cut + 1;
      boxes.splice(best, 1, ...[shrink(left), shrink(right)].filter(Boolean));
    }
    return boxes.map((box) => {
      let n = 0,
        r = 0,
        g = 0,
        b = 0;
      for (let br = box.lo[0]; br <= box.hi[0]; br += 1)
        for (let bg = box.lo[1]; bg <= box.hi[1]; bg += 1)
          for (let bb = box.lo[2]; bb <= box.hi[2]; bb += 1) {
            const bin = (br << 10) | (bg << 5) | bb;
            n += hist[bin];
            r += sums[bin * 3];
            g += sums[bin * 3 + 1];
            b += sums[bin * 3 + 2];
          }
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    });
  }

  function nearestFinder(palette) {
    const cache = new Int16Array(1 << 18).fill(-1);
    return (r, g, b) => {
      const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
      const hit = cache[key];
      if (hit >= 0) return hit;
      let best = 0,
        bestD = Infinity;
      for (let i = 0; i < palette.length; i += 1) {
        const p = palette[i],
          dr = r - p[0],
          dg = g - p[1],
          db = b - p[2];
        const d = 3 * dr * dr + 4 * dg * dg + 2 * db * db;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      cache[key] = best;
      return best;
    };
  }

  // Reduce to at most `colors` (2..256) palette entries. Pixels with alpha < 128 map to a
  // reserved transparent index (the last entry). Exact when the image has few colors.
  function quantize(image, opts = {}) {
    const { width, height, data } = asImage(image, 'Quantize');
    const maxColors = clampInt(opts.colors, 2, 256, 256);
    const threshold = 128;
    let hasTransparent = false;
    for (let i = 3; i < data.length; i += 4)
      if (data[i] < threshold) {
        hasTransparent = true;
        break;
      }
    const slots = Math.max(1, maxColors - (hasTransparent ? 1 : 0));
    const exact = new Map();
    let overflow = false;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < threshold) continue;
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      if (!exact.has(key)) {
        if (exact.size >= slots) {
          overflow = true;
          break;
        }
        exact.set(key, exact.size);
      }
    }
    const n = width * height;
    const indices = new Uint8Array(n);
    let palette;
    if (!overflow) {
      palette = [...exact.keys()].map((k) => [(k >> 16) & 255, (k >> 8) & 255, k & 255]);
      const t = palette.length;
      for (let i = 0, o = 0; i < n; i += 1, o += 4)
        indices[i] =
          data[o + 3] < threshold
            ? t
            : exact.get((data[o] << 16) | (data[o + 1] << 8) | data[o + 2]);
    } else {
      palette = medianCut(data, slots, threshold);
      const t = palette.length;
      const find = nearestFinder(palette);
      if (!opts.dither) {
        for (let i = 0, o = 0; i < n; i += 1, o += 4)
          indices[i] = data[o + 3] < threshold ? t : find(data[o], data[o + 1], data[o + 2]);
      } else {
        let cur = new Float32Array((width + 2) * 3),
          nxt = new Float32Array((width + 2) * 3);
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const i = y * width + x,
              o = i * 4;
            if (data[o + 3] < threshold) {
              indices[i] = t;
              continue;
            }
            const e = (x + 1) * 3;
            const r = Math.min(255, Math.max(0, data[o] + cur[e])),
              g = Math.min(255, Math.max(0, data[o + 1] + cur[e + 1])),
              b = Math.min(255, Math.max(0, data[o + 2] + cur[e + 2]));
            const k = find(Math.round(r), Math.round(g), Math.round(b));
            indices[i] = k;
            const p = palette[k],
              err = [r - p[0], g - p[1], b - p[2]];
            for (let c = 0; c < 3; c += 1) {
              cur[e + 3 + c] += (err[c] * 7) / 16;
              nxt[e - 3 + c] += (err[c] * 3) / 16;
              nxt[e + c] += (err[c] * 5) / 16;
              nxt[e + 3 + c] += err[c] / 16;
            }
          }
          [cur, nxt] = [nxt, cur];
          nxt.fill(0);
        }
      }
    }
    const flat = new Uint8Array((palette.length + (hasTransparent ? 1 : 0)) * 3);
    palette.forEach((p, i) => flat.set(p, i * 3));
    return {
      palette: flat,
      count: flat.length / 3,
      indices,
      transparentIndex: hasTransparent ? palette.length : -1,
    };
  }

  // ---------------------------------------------------------------- BMP

  function encodeBmp(image, opts = {}) {
    const { width, height, data } = asImage(image, 'BMP', opts);
    const alpha = opts.alpha === true || (opts.alpha !== false && !isOpaque(data));
    const ppm = Math.round(dpiOf(opts) / 0.0254);
    if (!alpha) {
      const stride = (width * 3 + 3) & ~3,
        size = 54 + stride * height;
      const w = new Writer(size);
      w.ascii('BM');
      w.u32le(size);
      w.u32le(0);
      w.u32le(54);
      w.u32le(40);
      w.u32le(width);
      w.u32le(height);
      w.u16le(1);
      w.u16le(24);
      w.u32le(0);
      w.u32le(stride * height);
      w.u32le(ppm);
      w.u32le(ppm);
      w.u32le(0);
      w.u32le(0);
      const row = new Uint8Array(stride);
      for (let y = height - 1; y >= 0; y -= 1) {
        for (let x = 0, s = y * width * 4; x < width; x += 1, s += 4) {
          row[x * 3] = data[s + 2];
          row[x * 3 + 1] = data[s + 1];
          row[x * 3 + 2] = data[s];
        }
        w.bytes(row);
      }
      return w.result();
    }
    const header = opts.header === 108 ? 108 : 124;
    const offset = 14 + header,
      size = offset + width * height * 4;
    const w = new Writer(size);
    w.ascii('BM');
    w.u32le(size);
    w.u32le(0);
    w.u32le(offset);
    w.u32le(header);
    w.u32le(width);
    w.u32le(height);
    w.u16le(1);
    w.u16le(32);
    w.u32le(3);
    w.u32le(width * height * 4);
    w.u32le(ppm);
    w.u32le(ppm);
    w.u32le(0);
    w.u32le(0);
    w.u32le(0x00ff0000);
    w.u32le(0x0000ff00);
    w.u32le(0x000000ff);
    w.u32le(0xff000000);
    w.u32le(0x73524742); // 'sRGB'
    for (let i = 0; i < 12; i += 1) w.u32le(0); // endpoints (36 bytes) + gamma (12 bytes)
    if (header === 124) {
      w.u32le(4);
      w.u32le(0);
      w.u32le(0);
      w.u32le(0);
    }
    const row = new Uint8Array(width * 4);
    for (let y = height - 1; y >= 0; y -= 1) {
      for (let x = 0, s = y * width * 4; x < width * 4; x += 4, s += 4) {
        row[x] = data[s + 2];
        row[x + 1] = data[s + 1];
        row[x + 2] = data[s];
        row[x + 3] = data[s + 3];
      }
      w.bytes(row);
    }
    return w.result();
  }

  function maskChannel(mask) {
    mask >>>= 0;
    if (!mask) return null;
    let shift = 0,
      bits = 0;
    while (!((mask >>> shift) & 1)) shift += 1;
    while (shift + bits < 32 && (mask >>> (shift + bits)) & 1) bits += 1;
    const max = 2 ** bits - 1;
    return (v) => {
      const x = ((v & mask) >>> 0) >>> shift;
      return bits === 8 ? x : Math.round((x * 255) / max);
    };
  }

  // Decodes a DIB (BITMAPINFOHEADER family) starting at `at`. pixelOffset null = after palette.
  function decodeDib(bytes, at, pixelOffset, limits, icon) {
    const label = icon ? 'ICO' : 'BMP';
    const r = makeReader(bytes, true, label);
    r.pos = at;
    const headerSize = r.u32();
    let width,
      height,
      bpp,
      compression = 0,
      colorsUsed = 0,
      xppm = 0,
      masks = null;
    if (headerSize === 12) {
      width = r.u16();
      height = r.i16();
      r.u16();
      bpp = r.u16();
    } else if ([40, 52, 56, 108, 124].includes(headerSize)) {
      width = r.i32();
      height = r.i32();
      r.u16();
      bpp = r.u16();
      compression = r.u32();
      r.u32();
      xppm = r.i32();
      r.i32();
      colorsUsed = r.u32();
      r.u32();
      if (headerSize >= 52) masks = [r.u32(), r.u32(), r.u32(), headerSize >= 56 ? r.u32() : 0];
    } else fail(`This ${label} uses an unsupported header (${headerSize} bytes).`);
    r.pos = at + headerSize;
    if ((compression === 3 || compression === 6) && headerSize === 40)
      masks = [r.u32(), r.u32(), r.u32(), compression === 6 ? r.u32() : 0];
    const topDown = height < 0;
    height = Math.abs(height);
    if (icon) height = Math.floor(height / 2);
    checkSize(width, height, limits, label);
    if (![1, 4, 8, 16, 24, 32].includes(bpp))
      fail(`This ${label} has an unsupported bit depth (${bpp}).`);
    const rle = compression === 1 || compression === 2;
    const okCompression =
      compression === 0 ||
      (compression === 1 && bpp === 8) ||
      (compression === 2 && bpp === 4) ||
      ((compression === 3 || compression === 6) && (bpp === 16 || bpp === 32));
    if (!okCompression)
      fail(`This ${label} uses an unsupported compression (type ${compression}).`);
    if (rle && topDown) fail(`This ${label} is corrupt (top-down run-length data).`);
    let palette = null;
    if (bpp <= 8) {
      const max = 1 << bpp;
      if (colorsUsed > 256) fail(`This ${label} has an invalid palette size.`);
      const n = colorsUsed && colorsUsed <= max ? colorsUsed : max;
      const entry = headerSize === 12 ? 3 : 4;
      const avail = Math.min(n, Math.floor(r.remaining() / entry));
      if (avail < 1) fail(`This ${label} file is truncated (palette).`);
      palette = new Uint8Array(max * 4);
      for (let i = 0; i < avail; i += 1) {
        const p = r.pos + i * entry;
        palette[i * 4] = bytes[p + 2];
        palette[i * 4 + 1] = bytes[p + 1];
        palette[i * 4 + 2] = bytes[p];
        palette[i * 4 + 3] = 255;
      }
      for (let i = avail; i < max; i += 1) palette[i * 4 + 3] = 255;
      r.pos += avail * entry;
    }
    const start = pixelOffset == null ? r.pos : pixelOffset;
    if (start > bytes.length) fail(`This ${label} file is truncated.`);
    const out = new Uint8ClampedArray(width * height * 4);
    const stride = Math.floor((bpp * width + 31) / 32) * 4;
    let end = start;
    let usedAlpha = false;
    if (rle) {
      let x = 0,
        y = 0,
        p = start;
      const put = (idx) => {
        if (x < width && y < height) {
          const o = ((height - 1 - y) * width + x) * 4;
          out.set(palette.subarray(idx * 4, idx * 4 + 4), o);
        }
        x += 1;
      };
      while (p + 1 < bytes.length && y < height) {
        const n = bytes[p++],
          c = bytes[p++];
        if (n > 0) {
          const visible = Math.min(n, Math.max(0, width - x));
          for (let k = 0; k < visible; k += 1) put(bpp === 8 ? c : k & 1 ? c & 15 : c >> 4);
          x += n - visible;
        } else if (c === 0) {
          x = 0;
          y += 1;
        } else if (c === 1) break;
        else if (c === 2) {
          if (p + 2 > bytes.length) break;
          x += bytes[p];
          y += bytes[p + 1];
          p += 2;
        } else {
          const used = bpp === 8 ? c : (c + 1) >> 1;
          if (p + used > bytes.length) fail(`This ${label} run-length data is truncated.`);
          const visible = Math.min(c, Math.max(0, width - x));
          for (let k = 0; k < visible; k += 1)
            put(
              bpp === 8
                ? bytes[p + k]
                : k & 1
                  ? bytes[p + (k >> 1)] & 15
                  : bytes[p + (k >> 1)] >> 4,
            );
          x += c - visible;
          p += used + (used & 1);
        }
      }
      end = p;
      usedAlpha = true; // undefined pixels stay transparent
    } else {
      const lastRow = Math.ceil((bpp * width) / 8);
      if (start + stride * (height - 1) + lastRow > bytes.length)
        fail(`This ${label} file is truncated (pixel data).`);
      end = start + stride * height;
      let rc = null,
        gc = null,
        bc = null,
        ac = null;
      if (bpp === 16 || bpp === 32) {
        const m =
          compression === 0
            ? bpp === 16
              ? [0x7c00, 0x03e0, 0x001f, 0]
              : [0xff0000, 0xff00, 0xff, 0xff000000]
            : masks;
        [rc, gc, bc, ac] = m.map(maskChannel);
        if (bpp === 32 && compression === 0) {
          let any = false;
          for (let y = 0; y < height && !any; y += 1)
            for (let x = 0, p = start + y * stride + 3; x < width; x += 1, p += 4)
              if (bytes[p]) {
                any = true;
                break;
              }
          if (!any) ac = null;
        }
        usedAlpha = !!ac;
      }
      for (let y = 0; y < height; y += 1) {
        const row = start + (topDown ? y : height - 1 - y) * stride;
        let o = y * width * 4;
        for (let x = 0; x < width; x += 1, o += 4) {
          if (bpp <= 8) {
            const bit = x * bpp;
            const byte = bytes[row + (bit >> 3)];
            const idx = bpp === 8 ? byte : (byte >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
            out[o] = palette[idx * 4];
            out[o + 1] = palette[idx * 4 + 1];
            out[o + 2] = palette[idx * 4 + 2];
            out[o + 3] = 255;
          } else if (bpp === 24) {
            const p = row + x * 3;
            out[o] = bytes[p + 2];
            out[o + 1] = bytes[p + 1];
            out[o + 2] = bytes[p];
            out[o + 3] = 255;
          } else {
            const p = row + x * (bpp >> 3);
            const v =
              bpp === 16
                ? bytes[p] | (bytes[p + 1] << 8)
                : (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>>
                  0;
            out[o] = rc ? rc(v) : 0;
            out[o + 1] = gc ? gc(v) : 0;
            out[o + 2] = bc ? bc(v) : 0;
            out[o + 3] = ac ? ac(v) : 255;
          }
        }
      }
    }
    const result = { width, height, data: out };
    if (xppm > 0) result.resolution = Math.round(xppm * 0.0254 * 100) / 100;
    return { result, end, bpp, usedAlpha };
  }

  function decodeBmp(input, opts = {}) {
    const bytes = toBytes(input, 'BMP');
    if (bytes.length < 26 || !hasSignature(bytes, 'BM'))
      fail('This is not a BMP file (missing BM signature).');
    const offset = (bytes[10] | (bytes[11] << 8) | (bytes[12] << 16) | (bytes[13] << 24)) >>> 0;
    return decodeDib(bytes, 14, offset, limitsOf(opts), false).result;
  }

  // ---------------------------------------------------------------- TIFF

  function encodeTiff(image, opts = {}) {
    const { width, height, data } = asImage(image, 'TIFF', opts);
    const alpha = opts.alpha === true || (opts.alpha !== false && !isOpaque(data));
    const spp = alpha ? 4 : 3;
    const mode = opts.compression || 'none';
    if (!['none', 'packbits', 'lzw'].includes(mode))
      fail('TIFF compression must be none, packbits, or lzw.');
    const compression = mode === 'packbits' ? 32773 : mode === 'lzw' ? 5 : 1;
    const rowBytes = width * spp;
    const rowsPerStrip = Math.max(1, Math.min(height, Math.floor(65536 / rowBytes)));
    const w = new Writer(8 + rowBytes * height + 512);
    w.ascii('II');
    w.u16le(42);
    w.u32le(0);
    const offsets = [],
      counts = [];
    const strip = new Uint8Array(rowBytes * rowsPerStrip);
    for (let y0 = 0; y0 < height; y0 += rowsPerStrip) {
      const rows = Math.min(rowsPerStrip, height - y0);
      for (let y = 0; y < rows; y += 1) {
        let s = (y0 + y) * width * 4,
          o = y * rowBytes;
        for (let x = 0; x < width; x += 1, s += 4) {
          strip[o++] = data[s];
          strip[o++] = data[s + 1];
          strip[o++] = data[s + 2];
          if (alpha) strip[o++] = data[s + 3];
        }
      }
      w.pad(2);
      offsets.push(w.length);
      const before = w.length;
      if (compression === 1) w.bytes(strip.subarray(0, rows * rowBytes));
      else if (compression === 5)
        w.bytes(lzwEncode(strip.subarray(0, rows * rowBytes), 8, true, true));
      else for (let y = 0; y < rows; y += 1) packBits(strip, y * rowBytes, (y + 1) * rowBytes, w);
      counts.push(w.length - before);
    }
    const dpi = dpiOf(opts);
    const rational = Number.isInteger(dpi) ? [dpi, 1] : [Math.round(dpi * 1000), 1000];
    const entries = [
      [256, 4, [width]],
      [257, 4, [height]],
      [258, 3, new Array(spp).fill(8)],
      [259, 3, [compression]],
      [262, 3, [2]],
      [273, 4, offsets],
      [277, 3, [spp]],
      [278, 4, [rowsPerStrip]],
      [279, 4, counts],
      [282, 5, rational],
      [283, 5, rational],
      [284, 3, [1]],
      [296, 3, [2]],
      [305, 2, 'AlcorPhoto'],
    ];
    if (alpha) entries.push([338, 3, [2]]);
    writeIfd(w, entries);
    return w.result();
  }

  function writeIfd(w, entries) {
    const unit = { 2: 1, 3: 2, 4: 4, 5: 8 };
    const writeValues = (type, values) => {
      if (type === 2) {
        w.ascii(values);
        w.u8(0);
      } else
        for (const v of values) {
          if (type === 3) w.u16le(v);
          else w.u32le(v);
        }
    };
    const prepared = entries
      .map(([tag, type, values]) => {
        const count =
          type === 2 ? values.length + 1 : type === 5 ? values.length / 2 : values.length;
        const e = { tag, type, values, count, size: count * unit[type], offset: 0 };
        if (e.size > 4) {
          w.pad(2);
          e.offset = w.length;
          writeValues(type, values);
        }
        return e;
      })
      .sort((a, b) => a.tag - b.tag);
    w.pad(2);
    w.setU32le(4, w.length);
    w.u16le(prepared.length);
    for (const e of prepared) {
      w.u16le(e.tag);
      w.u16le(e.type);
      w.u32le(e.count);
      if (e.size > 4) w.u32le(e.offset);
      else {
        const at = w.length;
        writeValues(e.type, e.values);
        while (w.length < at + 4) w.u8(0);
      }
    }
    w.u32le(0);
  }

  function decodeTiff(input, opts = {}) {
    const bytes = toBytes(input, 'TIFF');
    if (bytes.length < 8) fail('This TIFF file is truncated.');
    const little = hasSignature(bytes, 'II')
      ? true
      : hasSignature(bytes, 'MM')
        ? false
        : fail('This is not a TIFF file (missing II/MM byte order).');
    const r = makeReader(bytes, little, 'TIFF');
    r.pos = 2;
    const magic = r.u16();
    if (magic === 43) fail('BigTIFF files are not supported.');
    if (magic !== 42) fail('This is not a TIFF file (bad magic number).');
    r.pos = r.u32();
    const count = r.u16();
    if (count < 1 || count > 1000) fail('This TIFF has an invalid directory.');
    const unit = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 16: 8 };
    const wanted = new Set([
      256, 257, 258, 259, 262, 273, 277, 278, 279, 282, 284, 296, 317, 320, 322, 324, 338,
    ]);
    const tags = new Map();
    for (let i = 0; i < count; i += 1) {
      const tag = r.u16(),
        type = r.u16(),
        n = r.u32();
      const valuePos = r.pos,
        offset = r.u32();
      if (!unit[type] || !wanted.has(tag) || tags.has(tag)) continue;
      const size = n * unit[type];
      if (size > bytes.length) fail('This TIFF has a corrupt tag.');
      const vr = makeReader(bytes, little, 'TIFF');
      vr.pos = size <= 4 ? valuePos : offset;
      if (vr.pos + size > bytes.length) fail('This TIFF file is truncated (tag data).');
      if (type === 3 || type === 4 || type === 1 || type === 5) {
        const values = [];
        for (let k = 0; k < n; k += 1)
          values.push(
            type === 3
              ? vr.u16()
              : type === 4
                ? vr.u32()
                : type === 1
                  ? vr.u8()
                  : vr.u32() / (vr.u32() || 1),
          );
        tags.set(tag, values);
      }
    }
    const one = (tag, fallback) => (tags.has(tag) ? tags.get(tag)[0] : fallback);
    for (const tag of [259, 262, 273, 277, 278, 279, 284, 317, 338]) {
      if (tags.has(tag) && !tags.get(tag).every(Number.isInteger))
        fail('This TIFF has a corrupt tag (non-integer value).');
    }
    const width = one(256),
      height = one(257);
    checkSize(width, height, limitsOf(opts), 'TIFF');
    if (tags.has(322) || tags.has(324)) fail('Tiled TIFF files are not supported.');
    const compression = one(259, 1),
      photometric = one(262, 2),
      spp = one(277, 1),
      planar = one(284, 1),
      predictor = one(317, 1);
    const bps = tags.get(258) || [1];
    if (bps.some((b) => b !== 8))
      fail(`Only 8-bit TIFF files are supported (this one is ${bps[0]}-bit).`);
    if (![1, 5, 32773].includes(compression))
      fail(
        compression === 7
          ? 'JPEG-compressed TIFF files are not supported.'
          : compression === 8 || compression === 32946
            ? 'Deflate-compressed TIFF files are not supported.'
            : `This TIFF compression (type ${compression}) is not supported.`,
      );
    if (planar !== 1) fail('Planar (separate-plane) TIFF files are not supported.');
    if (predictor !== 1 && predictor !== 2) fail('This TIFF predictor is not supported.');
    const colorCount = photometric === 2 ? 3 : 1;
    if (![0, 1, 2, 3].includes(photometric))
      fail('Only RGB, grayscale, and palette TIFF files are supported (no CMYK/YCbCr/Lab).');
    if (spp < colorCount || spp > 8) fail('This TIFF has an invalid samples-per-pixel count.');
    const extra = tags.get(338);
    const alphaKind = spp > colorCount ? (extra ? extra[0] : 2) : 0;
    const colormap = photometric === 3 ? tags.get(320) : null;
    if (photometric === 3 && (!colormap || colormap.length < 768))
      fail('This palette TIFF has no color map.');
    const rowsPerStrip = Math.min(height, one(278, height) || height); // integer, 1..height
    const offsets = tags.get(273),
      byteCounts = tags.get(279);
    const strips = Math.ceil(height / rowsPerStrip);
    if (!offsets || offsets.length < strips) fail('This TIFF has missing strip offsets.');
    if (compression !== 1 && (!byteCounts || byteCounts.length < strips))
      fail('This TIFF has missing strip byte counts.');
    const rowBytes = width * spp;
    // Most a compressed byte can expand to: PackBits 64x, LZW one code (>= 9 bits) per string of <= 4096.
    const maxRatio = compression === 1 ? 1 : compression === 32773 ? 64 : 4096;
    for (let s = 0; s < strips; s += 1) {
      const rows = Math.min(rowsPerStrip, height - s * rowsPerStrip),
        expected = rows * rowBytes;
      const off = offsets[s],
        len = byteCounts ? byteCounts[s] : expected;
      if (off > bytes.length || off + len > bytes.length)
        fail('This TIFF file is truncated (strip data).');
      if (len * maxRatio < expected) fail('This TIFF file is truncated (strip data).');
    }
    const raw = new Uint8Array(rowBytes * height);
    for (let s = 0; s < strips; s += 1) {
      const rows = Math.min(rowsPerStrip, height - s * rowsPerStrip),
        expected = rows * rowBytes,
        outPos = s * rowsPerStrip * rowBytes;
      const off = offsets[s],
        len = byteCounts ? byteCounts[s] : expected;
      const src = bytes.subarray(off, off + len);
      if (compression === 1) {
        if (src.length < expected) fail('This TIFF file is truncated (strip data).');
        raw.set(src.subarray(0, expected), outPos);
      } else if (compression === 32773)
        unpackBits(src, 0, src.length, raw, outPos, expected, 'TIFF');
      else if (lzwDecode(src, 8, true, true, raw, outPos, expected, 'TIFF') < expected)
        fail('This TIFF LZW strip ended early.');
    }
    if (predictor === 2)
      for (let y = 0; y < height; y += 1)
        for (let i = y * rowBytes + spp, e = (y + 1) * rowBytes; i < e; i += 1)
          raw[i] = (raw[i] + raw[i - spp]) & 255;
    const out = new Uint8ClampedArray(width * height * 4);
    for (let i = 0, s = 0, o = 0; i < width * height; i += 1, s += spp, o += 4) {
      if (photometric === 2) {
        out[o] = raw[s];
        out[o + 1] = raw[s + 1];
        out[o + 2] = raw[s + 2];
      } else if (photometric === 3) {
        const k = raw[s];
        out[o] = colormap[k] >> 8;
        out[o + 1] = colormap[256 + k] >> 8;
        out[o + 2] = colormap[512 + k] >> 8;
      } else {
        const v = photometric === 0 ? 255 - raw[s] : raw[s];
        out[o] = v;
        out[o + 1] = v;
        out[o + 2] = v;
      }
      const a = alphaKind ? raw[s + colorCount] : 255;
      out[o + 3] = a;
      if (alphaKind === 1 && a < 255) {
        for (let c = 0; c < 3; c += 1) out[o + c] = a ? Math.round((out[o + c] * 255) / a) : 0;
      }
    }
    const result = { width, height, data: out };
    const xres = one(282),
      resUnit = one(296, 2);
    if (xres > 0 && resUnit !== 1)
      result.resolution = Math.round((resUnit === 3 ? xres * 2.54 : xres) * 100) / 100;
    return result;
  }

  // ---------------------------------------------------------------- GIF

  function bitsFor(count) {
    let bits = 1;
    while (1 << bits < count) bits += 1;
    return bits;
  }

  function writeColorTable(w, q, bits) {
    const table = new Uint8Array((1 << bits) * 3);
    table.set(q.palette.subarray(0, Math.min(q.palette.length, table.length)));
    w.bytes(table);
  }

  function writeGifImage(w, indices, bits) {
    const minCode = Math.max(2, bits);
    w.u8(minCode);
    const lzw = lzwEncode(indices, minCode, false, false);
    for (let i = 0; i < lzw.length; i += 255) {
      const n = Math.min(255, lzw.length - i);
      w.u8(n);
      w.bytes(lzw.subarray(i, i + n));
    }
    w.u8(0);
  }

  function writeGce(w, disposal, delayCs, transparentIndex) {
    w.u8(0x21);
    w.u8(0xf9);
    w.u8(4);
    w.u8((disposal << 2) | (transparentIndex >= 0 ? 1 : 0));
    w.u16le(delayCs);
    w.u8(Math.max(0, transparentIndex));
    w.u8(0);
  }

  function gifSize(width, height) {
    if (width > 65535 || height > 65535) fail('GIF images are limited to 65535 pixels per side.');
  }

  function encodeGif(image, opts = {}) {
    const img = asImage(image, 'GIF', opts);
    gifSize(img.width, img.height);
    const q = quantize(img, { colors: opts.colors, dither: opts.dither });
    const bits = bitsFor(q.count);
    const w = new Writer(img.width * img.height + 1024);
    w.ascii('GIF89a');
    w.u16le(img.width);
    w.u16le(img.height);
    w.u8(0x80 | 0x70 | (bits - 1));
    w.u8(0);
    w.u8(0);
    writeColorTable(w, q, bits);
    if (q.transparentIndex >= 0) writeGce(w, 0, 0, q.transparentIndex);
    w.u8(0x2c);
    w.u16le(0);
    w.u16le(0);
    w.u16le(img.width);
    w.u16le(img.height);
    w.u8(0);
    writeGifImage(w, q.indices, bits);
    w.u8(0x3b);
    return w.result();
  }

  // frames: [{ width, height, data, left?, top?, delayMs? }]. Each frame gets its own palette.
  function encodeAnimatedGif(frames, opts = {}) {
    if (!Array.isArray(frames) || frames.length < 1)
      fail('An animated GIF needs at least one frame.');
    if (frames.length > 10000) fail('Animated GIF export is limited to 10000 frames.');
    const list = frames.map((f) =>
      Object.assign(asImage(f, 'GIF frame', opts), {
        left: clampInt(f.left, 0, 65535, 0),
        top: clampInt(f.top, 0, 65535, 0),
        delayMs: f.delayMs,
      }),
    );
    let width = 0,
      height = 0;
    for (const f of list) {
      width = Math.max(width, f.left + f.width);
      height = Math.max(height, f.top + f.height);
    }
    for (const [key, fit] of [
      ['width', width],
      ['height', height],
    ]) {
      if (opts[key] == null) continue;
      const v = opts[key];
      if (!Number.isInteger(v) || v < 1 || v > 65535)
        fail(`Animated GIF ${key} must be an integer from 1 to 65535.`);
      if (v < fit) fail('A GIF frame lies outside the canvas.');
      if (key === 'width') width = v;
      else height = v;
    }
    gifSize(width, height);
    const disposal = opts.disposal === 'none' ? 1 : opts.disposal === 'previous' ? 3 : 2;
    const w = new Writer(1024);
    w.ascii('GIF89a');
    w.u16le(width);
    w.u16le(height);
    w.u8(0x70);
    w.u8(0);
    w.u8(0);
    if (opts.loop !== false) {
      const loops = opts.loop === true || opts.loop == null ? 0 : clampInt(opts.loop, 0, 65535, 0);
      w.u8(0x21);
      w.u8(0xff);
      w.u8(11);
      w.ascii('NETSCAPE2.0');
      w.u8(3);
      w.u8(1);
      w.u16le(loops);
      w.u8(0);
    }
    for (const f of list) {
      if (f.left + f.width > width || f.top + f.height > height)
        fail('A GIF frame lies outside the canvas.');
      const q = quantize(f, { colors: opts.colors, dither: opts.dither });
      const bits = bitsFor(q.count);
      const delay = f.delayMs != null ? f.delayMs : opts.delayMs != null ? opts.delayMs : 100;
      writeGce(w, disposal, clampInt(delay / 10, 0, 65535, 10), q.transparentIndex);
      w.u8(0x2c);
      w.u16le(f.left);
      w.u16le(f.top);
      w.u16le(f.width);
      w.u16le(f.height);
      w.u8(0x80 | (bits - 1));
      writeColorTable(w, q, bits);
      writeGifImage(w, q.indices, bits);
    }
    w.u8(0x3b);
    return w.result();
  }

  // Minimal GIF reader: first frame by default, every composited frame with { allFrames: true }.
  function decodeGif(input, opts = {}) {
    const bytes = toBytes(input, 'GIF');
    if (!hasSignature(bytes, 'GIF87a') && !hasSignature(bytes, 'GIF89a'))
      fail('This is not a GIF file (missing GIF87a/GIF89a signature).');
    const r = makeReader(bytes, true, 'GIF');
    r.pos = 6;
    const width = r.u16(),
      height = r.u16(),
      packed = r.u8();
    r.skip(2);
    const limits = limitsOf(opts);
    checkSize(width, height, limits, 'GIF');
    const readTable = (flags) => (flags & 0x80 ? r.bytes(3 * (1 << ((flags & 7) + 1))) : null);
    const global = readTable(packed);
    const canvas = new Uint8ClampedArray(width * height * 4);
    const frames = [];
    let gce = { disposal: 0, delayMs: 0, transparent: -1 };
    // All decoded frames together stay within one image's pixel budget, and LZW work across
    // frames is capped as well: a tiny canvas must not license huge (or endless) frames.
    const frameBudget = Math.max(1, Math.floor(limits.maxPixels / (width * height)));
    let lzwBudget = limits.maxPixels * 2;
    for (;;) {
      const block = r.u8();
      if (block === 0x3b) break;
      if (block === 0x21) {
        const label = r.u8();
        if (label === 0xf9) {
          const size = r.u8();
          const body = r.bytes(size);
          if (size >= 4)
            gce = {
              disposal: (body[0] >> 2) & 7,
              delayMs: (body[1] | (body[2] << 8)) * 10,
              transparent: body[0] & 1 ? body[3] : -1,
            };
          for (let n = r.u8(); n; n = r.u8()) r.skip(n);
        } else {
          for (let n = r.u8(); n; n = r.u8()) r.skip(n);
        }
        continue;
      }
      if (block !== 0x2c) fail('This GIF file is corrupt (unknown block).');
      const left = r.u16(),
        top = r.u16(),
        fw = r.u16(),
        fh = r.u16(),
        flags = r.u8();
      const table = readTable(flags) || global;
      if (!table) fail('This GIF frame has no color table.');
      if (fw < 1 || fh < 1 || fw * fh > limits.maxPixels)
        fail('This GIF frame has invalid dimensions.');
      const minCode = r.u8();
      if (minCode < 1 || minCode > 11) fail('This GIF frame has an invalid LZW code size.');
      const chunks = [];
      for (let n = r.u8(); n; n = r.u8()) chunks.push(r.bytes(n));
      // Only rows that can land on the canvas are decoded (interlaced rows arrive out of order).
      const interlaced = (flags & 0x40) !== 0;
      const visibleW = Math.max(0, Math.min(fw, width - left)),
        visibleRows = Math.max(0, Math.min(fh, height - top));
      const rowOrder = [];
      let decodeRows = 0;
      if (visibleW && visibleRows) {
        if (!interlaced) decodeRows = visibleRows;
        else {
          for (const [start, step] of [
            [0, 8],
            [4, 8],
            [2, 4],
            [1, 2],
          ])
            for (let y = start; y < fh; y += step) {
              rowOrder.push(y);
              if (y < visibleRows) decodeRows = rowOrder.length;
            }
        }
      }
      if (decodeRows * fw > 4 * visibleW * visibleRows + 65536)
        fail('This GIF frame is far larger than its canvas.');
      lzwBudget -= decodeRows * fw;
      if (lzwBudget < 0) fail('This GIF has too much frame data to decode.');
      const indices = new Uint8Array(decodeRows * fw);
      if (indices.length)
        lzwDecode(concat(chunks), minCode, false, false, indices, 0, indices.length, 'GIF');
      const saved = gce.disposal === 3 && opts.allFrames ? canvas.slice() : null;
      for (let row = 0; row < decodeRows; row += 1) {
        const y = top + (interlaced ? rowOrder[row] : row);
        if (y >= height) continue;
        for (let x = 0; x < visibleW; x += 1) {
          const k = indices[row * fw + x];
          if (k === gce.transparent) continue;
          const o = (y * width + left + x) * 4;
          if (k * 3 + 2 < table.length) {
            canvas[o] = table[k * 3];
            canvas[o + 1] = table[k * 3 + 1];
            canvas[o + 2] = table[k * 3 + 2];
          }
          canvas[o + 3] = 255;
        }
      }
      if (!opts.allFrames) {
        frames.push({ data: canvas, delayMs: gce.delayMs });
        break;
      }
      frames.push({ data: canvas.slice(), delayMs: gce.delayMs });
      if (frames.length >= frameBudget) fail('This GIF has too many frames to decode.');
      if (gce.disposal === 2)
        for (let y = top; y < Math.min(height, top + fh); y += 1)
          canvas.fill(0, (y * width + left) * 4, (y * width + Math.min(width, left + fw)) * 4);
      else if (saved) canvas.set(saved);
      gce = { disposal: 0, delayMs: 0, transparent: -1 };
    }
    if (!frames.length) fail('This GIF has no frames.');
    return { width, height, data: frames[0].data, frames: opts.allFrames ? frames : undefined };
  }

  // ---------------------------------------------------------------- ICO

  async function encodeIco(image, opts = {}) {
    const src = asImage(image, 'ICO', opts);
    if (typeof opts.pngEncoder !== 'function') fail('ICO export needs a pngEncoder function.');
    if (opts.sizes != null && !Array.isArray(opts.sizes))
      fail('ICO sizes must be a list of numbers.');
    const sizes = [...new Set((opts.sizes || ICO_SIZES).map(Number))]
      .filter((s) => Number.isInteger(s) && s >= 1 && s <= 256)
      .sort((a, b) => a - b);
    if (!sizes.length) fail('ICO export needs at least one size between 1 and 256.');
    const pngs = [];
    for (const size of sizes) {
      const fitted = fitInto(src, size, true);
      const data = new Uint8ClampedArray(size * size * 4);
      const ox = (size - fitted.width) >> 1,
        oy = (size - fitted.height) >> 1;
      for (let y = 0; y < fitted.height; y += 1)
        data.set(
          fitted.data.subarray(y * fitted.width * 4, (y + 1) * fitted.width * 4),
          ((oy + y) * size + ox) * 4,
        );
      const png = toBytes(await opts.pngEncoder({ width: size, height: size, data }), 'PNG');
      if (!hasSignature(png, PNG_SIGNATURE)) fail('The ICO pngEncoder did not return PNG bytes.');
      pngs.push(png);
    }
    const w = new Writer(6 + 16 * sizes.length + pngs.reduce((n, p) => n + p.length, 0));
    w.u16le(0);
    w.u16le(1);
    w.u16le(sizes.length);
    let offset = 6 + 16 * sizes.length;
    sizes.forEach((size, i) => {
      w.u8(size & 255);
      w.u8(size & 255);
      w.u8(0);
      w.u8(0);
      w.u16le(1);
      w.u16le(32);
      w.u32le(pngs[i].length);
      w.u32le(offset);
      offset += pngs[i].length;
    });
    pngs.forEach((p) => w.bytes(p));
    return w.result();
  }

  function decodeIco(input, opts = {}) {
    const bytes = toBytes(input, 'ICO');
    const r = makeReader(bytes, true, 'ICO');
    if (bytes.length < 6 || r.u16() !== 0) fail('This is not an ICO file.');
    const type = r.u16(),
      count = r.u16();
    if ((type !== 1 && type !== 2) || count < 1) fail('This is not an ICO file.');
    let best = null;
    for (let i = 0; i < count; i += 1) {
      const w = r.u8() || 256,
        h = r.u8() || 256;
      r.skip(4);
      const bpp = r.u16(),
        size = r.u32(),
        offset = r.u32();
      if (offset + size > bytes.length || size < 16) continue;
      if (!best || w * h > best.w * best.h || (w * h === best.w * best.h && bpp > best.bpp))
        best = { w, h, bpp, size, offset };
    }
    if (!best) fail('This ICO file has no readable images.');
    const entry = bytes.subarray(best.offset, best.offset + best.size);
    const limits = limitsOf(opts);
    if (hasSignature(entry, PNG_SIGNATURE)) {
      if (entry.length < 24) fail('This ICO PNG entry is truncated.');
      const pw = ((entry[16] << 24) | (entry[17] << 16) | (entry[18] << 8) | entry[19]) >>> 0,
        ph = ((entry[20] << 24) | (entry[21] << 16) | (entry[22] << 8) | entry[23]) >>> 0;
      checkSize(pw, ph, limits, 'ICO');
      return { width: pw, height: ph, png: entry.slice() };
    }
    const { result, end, bpp, usedAlpha } = decodeDib(entry, 0, null, limits, true);
    const { width, height, data } = result;
    if (!(bpp === 32 && usedAlpha)) {
      const stride = ((width + 31) >> 5) * 4;
      if (end + stride * height <= entry.length) {
        for (let y = 0; y < height; y += 1) {
          const row = end + (height - 1 - y) * stride;
          for (let x = 0; x < width; x += 1)
            if ((entry[row + (x >> 3)] >> (7 - (x & 7))) & 1) data[(y * width + x) * 4 + 3] = 0;
        }
      }
    }
    return result;
  }

  // ---------------------------------------------------------------- TGA

  function encodeTga(image, opts = {}) {
    const { width, height, data } = asImage(image, 'TGA', opts);
    if (width > 65535 || height > 65535) fail('TGA images are limited to 65535 pixels per side.');
    const w = new Writer(18 + width * height * 4 + 64);
    w.u8(0);
    w.u8(0);
    w.u8(opts.rle ? 10 : 2);
    w.u16le(0);
    w.u16le(0);
    w.u8(0);
    w.u16le(0);
    w.u16le(0);
    w.u16le(width);
    w.u16le(height);
    w.u8(32);
    w.u8(0x28);
    const px = new Uint8Array(4);
    const write = (s) => {
      px[0] = data[s + 2];
      px[1] = data[s + 1];
      px[2] = data[s];
      px[3] = data[s + 3];
      w.bytes(px);
    };
    const same = (a, b) =>
      data[a] === data[b] &&
      data[a + 1] === data[b + 1] &&
      data[a + 2] === data[b + 2] &&
      data[a + 3] === data[b + 3];
    for (let y = 0; y < height; y += 1) {
      const row = y * width * 4;
      if (!opts.rle) {
        for (let x = 0; x < width; x += 1) write(row + x * 4);
        continue;
      }
      let x = 0;
      while (x < width) {
        let run = 1;
        while (x + run < width && run < 128 && same(row + x * 4, row + (x + run) * 4)) run += 1;
        if (run > 1) {
          w.u8(0x80 | (run - 1));
          write(row + x * 4);
          x += run;
          continue;
        }
        let lit = 1;
        while (
          x + lit < width &&
          lit < 128 &&
          !(x + lit + 1 < width && same(row + (x + lit) * 4, row + (x + lit + 1) * 4))
        )
          lit += 1;
        w.u8(lit - 1);
        for (let k = 0; k < lit; k += 1) write(row + (x + k) * 4);
        x += lit;
      }
    }
    w.u32le(0);
    w.u32le(0);
    w.ascii('TRUEVISION-XFILE.');
    w.u8(0);
    return w.result();
  }

  function decodeTga(input, opts = {}) {
    const bytes = toBytes(input, 'TGA');
    const r = makeReader(bytes, true, 'TGA');
    const idLen = r.u8(),
      cmapType = r.u8(),
      type = r.u8();
    const cmapFirst = r.u16(),
      cmapLen = r.u16(),
      cmapDepth = r.u8();
    r.skip(4);
    const width = r.u16(),
      height = r.u16(),
      bpp = r.u8(),
      desc = r.u8();
    if (![1, 2, 3, 9, 10, 11].includes(type) || cmapType > 1)
      fail('This is not a supported TGA file.');
    const mapped = type === 1 || type === 9,
      gray = type === 3 || type === 11,
      rle = type >= 9;
    if (mapped && (cmapType !== 1 || bpp !== 8 || ![15, 16, 24, 32].includes(cmapDepth)))
      fail('This color-mapped TGA is not supported.');
    if (!mapped && !gray && ![15, 16, 24, 32].includes(bpp))
      fail(`This TGA has an unsupported bit depth (${bpp}).`);
    if (gray && bpp !== 8 && bpp !== 16)
      fail(`This grayscale TGA has an unsupported bit depth (${bpp}).`);
    checkSize(width, height, limitsOf(opts), 'TGA');
    r.skip(idLen);
    const alphaBits = desc & 15;
    const toRgba = (src, p, depth, out, o) => {
      if (depth === 8) {
        out[o] = out[o + 1] = out[o + 2] = src[p];
        out[o + 3] = 255;
      } else if (gray) {
        out[o] = out[o + 1] = out[o + 2] = src[p];
        out[o + 3] = alphaBits ? src[p + 1] : 255;
      } else if (depth <= 16) {
        const v = src[p] | (src[p + 1] << 8);
        out[o] = (((v >> 10) & 31) * 255 + 15) / 31;
        out[o + 1] = (((v >> 5) & 31) * 255 + 15) / 31;
        out[o + 2] = ((v & 31) * 255 + 15) / 31;
        out[o + 3] = alphaBits && depth === 16 ? (v & 0x8000 ? 255 : 0) : 255;
      } else {
        out[o] = src[p + 2];
        out[o + 1] = src[p + 1];
        out[o + 2] = src[p];
        out[o + 3] = depth === 32 && alphaBits ? src[p + 3] : 255;
      }
    };
    let cmap = null;
    if (cmapType === 1) {
      const entry = Math.ceil(cmapDepth / 8),
        raw = r.bytes(cmapLen * entry);
      if (mapped) {
        cmap = new Uint8ClampedArray(256 * 4);
        for (let i = 0; i < cmapLen && cmapFirst + i < 256; i += 1)
          toRgba(raw, i * entry, cmapDepth, cmap, (cmapFirst + i) * 4);
      }
    }
    const pxBytes = Math.ceil(bpp / 8),
      n = width * height;
    if ((rle ? Math.ceil(n / 128) * (1 + pxBytes) : n * pxBytes) > bytes.length - r.pos)
      fail('This TGA file is truncated (pixel data).');
    const out = new Uint8ClampedArray(n * 4);
    const top = (desc & 0x20) !== 0,
      rtl = (desc & 0x10) !== 0;
    const place = (i) => {
      const x = i % width,
        y = (i / width) | 0;
      return ((top ? y : height - 1 - y) * width + (rtl ? width - 1 - x : x)) * 4;
    };
    const putPixel = (p, i) => {
      const o = place(i);
      if (mapped) out.set(cmap.subarray(bytes[p] * 4, bytes[p] * 4 + 4), o);
      else toRgba(bytes, p, bpp, out, o);
    };
    let p = r.pos;
    if (!rle) {
      if (p + n * pxBytes > bytes.length) fail('This TGA file is truncated (pixel data).');
      for (let i = 0; i < n; i += 1, p += pxBytes) putPixel(p, i);
    } else {
      let i = 0;
      while (i < n) {
        if (p >= bytes.length) fail('This TGA run-length data is truncated.');
        const head = bytes[p++],
          count = (head & 127) + 1;
        if (i + count > n) fail('This TGA run-length data is corrupt.');
        if (head & 128) {
          if (p + pxBytes > bytes.length) fail('This TGA run-length data is truncated.');
          for (let k = 0; k < count; k += 1) putPixel(p, i++);
          p += pxBytes;
        } else {
          if (p + count * pxBytes > bytes.length) fail('This TGA run-length data is truncated.');
          for (let k = 0; k < count; k += 1, p += pxBytes) putPixel(p, i++);
        }
      }
    }
    return { width, height, data: out };
  }

  // ---------------------------------------------------------------- QOI

  function encodeQoi(image, opts = {}) {
    const { width, height, data } = asImage(image, 'QOI', opts);
    const channels =
      opts.channels === 3 || opts.channels === 4 ? opts.channels : isOpaque(data) ? 3 : 4;
    const out = new Uint8Array(14 + width * height * 5 + 8);
    out.set(ascii('qoif'));
    const view = new DataView(out.buffer);
    view.setUint32(4, width);
    view.setUint32(8, height);
    out[12] = channels;
    out[13] = opts.linear ? 1 : 0;
    const index = new Uint8Array(256);
    let p = 14,
      pr = 0,
      pg = 0,
      pb = 0,
      pa = 255,
      run = 0;
    const last = data.length - 4;
    for (let s = 0; s <= last; s += 4) {
      const r = data[s],
        g = data[s + 1],
        b = data[s + 2],
        a = data[s + 3];
      if (r === pr && g === pg && b === pb && a === pa) {
        run += 1;
        if (run === 62 || s === last) {
          out[p++] = 0xc0 | (run - 1);
          run = 0;
        }
        continue;
      }
      if (run) {
        out[p++] = 0xc0 | (run - 1);
        run = 0;
      }
      const h = ((r * 3 + g * 5 + b * 7 + a * 11) & 63) * 4;
      if (index[h] === r && index[h + 1] === g && index[h + 2] === b && index[h + 3] === a)
        out[p++] = h >> 2;
      else {
        index[h] = r;
        index[h + 1] = g;
        index[h + 2] = b;
        index[h + 3] = a;
        if (a === pa) {
          const dr = ((r - pr + 384) & 255) - 128,
            dg = ((g - pg + 384) & 255) - 128,
            db = ((b - pb + 384) & 255) - 128;
          const rg = dr - dg,
            bg = db - dg;
          if (dr >= -2 && dr <= 1 && dg >= -2 && dg <= 1 && db >= -2 && db <= 1)
            out[p++] = 0x40 | ((dr + 2) << 4) | ((dg + 2) << 2) | (db + 2);
          else if (dg >= -32 && dg <= 31 && rg >= -8 && rg <= 7 && bg >= -8 && bg <= 7) {
            out[p++] = 0x80 | (dg + 32);
            out[p++] = ((rg + 8) << 4) | (bg + 8);
          } else {
            out[p++] = 0xfe;
            out[p++] = r;
            out[p++] = g;
            out[p++] = b;
          }
        } else {
          out[p++] = 0xff;
          out[p++] = r;
          out[p++] = g;
          out[p++] = b;
          out[p++] = a;
        }
      }
      pr = r;
      pg = g;
      pb = b;
      pa = a;
    }
    out.set([0, 0, 0, 0, 0, 0, 0, 1], p);
    return out.slice(0, p + 8);
  }

  function decodeQoi(input, opts = {}) {
    const bytes = toBytes(input, 'QOI');
    if (bytes.length < 22 || !hasSignature(bytes, 'qoif'))
      fail('This is not a QOI file (missing qoif signature).');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(4),
      height = view.getUint32(8),
      channels = bytes[12],
      colorspace = bytes[13];
    if ((channels !== 3 && channels !== 4) || colorspace > 1)
      fail('This QOI file has an invalid header.');
    checkSize(width, height, limitsOf(opts), 'QOI');
    if ((bytes.length - 22) * 62 < width * height) fail('This QOI file is truncated.');
    const out = new Uint8ClampedArray(width * height * 4);
    const index = new Uint8Array(256);
    const end = bytes.length - 8;
    let p = 14,
      r = 0,
      g = 0,
      b = 0,
      a = 255,
      run = 0;
    for (let o = 0; o < out.length; o += 4) {
      if (run > 0) run -= 1;
      else {
        if (p >= end) fail('This QOI file is truncated.');
        const b1 = bytes[p++];
        if (b1 === 0xfe) {
          if (p + 3 > end) fail('This QOI file is truncated.');
          r = bytes[p];
          g = bytes[p + 1];
          b = bytes[p + 2];
          p += 3;
        } else if (b1 === 0xff) {
          if (p + 4 > end) fail('This QOI file is truncated.');
          r = bytes[p];
          g = bytes[p + 1];
          b = bytes[p + 2];
          a = bytes[p + 3];
          p += 4;
        } else {
          const tag = b1 >> 6;
          if (tag === 0) {
            const h = (b1 & 63) * 4;
            r = index[h];
            g = index[h + 1];
            b = index[h + 2];
            a = index[h + 3];
          } else if (tag === 1) {
            r = (r + ((b1 >> 4) & 3) - 2) & 255;
            g = (g + ((b1 >> 2) & 3) - 2) & 255;
            b = (b + (b1 & 3) - 2) & 255;
          } else if (tag === 2) {
            if (p >= end) fail('This QOI file is truncated.');
            const b2 = bytes[p++],
              dg = (b1 & 63) - 32;
            r = (r + dg + ((b2 >> 4) & 15) - 8) & 255;
            g = (g + dg) & 255;
            b = (b + dg + (b2 & 15) - 8) & 255;
          } else run = b1 & 63;
        }
        const h = ((r * 3 + g * 5 + b * 7 + a * 11) & 63) * 4;
        index[h] = r;
        index[h + 1] = g;
        index[h + 2] = b;
        index[h + 3] = a;
      }
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
    }
    return { width, height, data: out };
  }

  // ---------------------------------------------------------------- PPM / PGM / PAM

  function overWhite(data, i) {
    const a = data[i + 3];
    return [0, 1, 2].map((c) => Math.round((data[i + c] * a + 255 * (255 - a)) / 255));
  }

  function encodePnm(image, opts = {}) {
    const { width, height, data } = asImage(image, 'PNM', opts);
    const format = opts.format || 'ppm';
    const n = width * height;
    let header, depth;
    if (format === 'ppm') {
      header = `P6\n${width} ${height}\n255\n`;
      depth = 3;
    } else if (format === 'pgm') {
      header = `P5\n${width} ${height}\n255\n`;
      depth = 1;
    } else if (format === 'pam') {
      header = `P7\nWIDTH ${width}\nHEIGHT ${height}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`;
      depth = 4;
    } else fail('PNM format must be ppm, pgm, or pam.');
    const out = new Uint8Array(header.length + n * depth);
    out.set(ascii(header));
    let o = header.length;
    for (let i = 0; i < n * 4; i += 4) {
      if (depth === 4) {
        out[o++] = data[i];
        out[o++] = data[i + 1];
        out[o++] = data[i + 2];
        out[o++] = data[i + 3];
        continue;
      }
      const [r, g, b] = overWhite(data, i);
      if (depth === 3) {
        out[o++] = r;
        out[o++] = g;
        out[o++] = b;
      } else out[o++] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    }
    return out;
  }
  const encodePpm = (image, opts = {}) =>
    encodePnm(image, Object.assign({}, opts, { format: 'ppm' }));
  const encodePgm = (image, opts = {}) =>
    encodePnm(image, Object.assign({}, opts, { format: 'pgm' }));
  const encodePam = (image, opts = {}) =>
    encodePnm(image, Object.assign({}, opts, { format: 'pam' }));

  function decodePnm(input, opts = {}) {
    const bytes = toBytes(input, 'PNM');
    if (bytes.length < 3 || bytes[0] !== 0x50) fail('This is not a PPM/PGM/PAM file.');
    const kind = bytes[1] - 48;
    if (kind >= 1 && kind <= 4) fail('Only binary P5, P6, and P7 netpbm files are supported.');
    if (kind !== 5 && kind !== 6 && kind !== 7) fail('This is not a PPM/PGM/PAM file.');
    const headerEnd = Math.min(bytes.length, 4096);
    let p = 2,
      width,
      height,
      maxval,
      depth,
      tupl = '';
    const isSpace = (c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12;
    if (kind !== 7) {
      const token = () => {
        for (;;) {
          while (p < headerEnd && isSpace(bytes[p])) p += 1;
          if (p < headerEnd && bytes[p] === 35) {
            while (p < headerEnd && bytes[p] !== 10 && bytes[p] !== 13) p += 1;
            continue;
          }
          break;
        }
        if (p >= headerEnd) fail('This PNM header is corrupt or too long.');
        let s = '';
        while (p < headerEnd && bytes[p] >= 48 && bytes[p] <= 57 && s.length < 10)
          s += String.fromCharCode(bytes[p++]);
        if (!s || (p < bytes.length && !isSpace(bytes[p]) && bytes[p] !== 35))
          fail('This PNM header is corrupt.');
        return Number(s);
      };
      width = token();
      height = token();
      maxval = token();
      p += 1; // single whitespace before raster
      depth = kind === 6 ? 3 : 1;
    } else {
      let line = '';
      const fields = {};
      for (;;) {
        if (p >= headerEnd) fail('This PAM header is corrupt or too long.');
        const c = bytes[p++];
        if (c !== 10) {
          line += String.fromCharCode(c);
          continue;
        }
        const t = line.trim();
        line = '';
        if (!t || t[0] === '#') continue;
        if (t === 'ENDHDR') break;
        const [key, ...rest] = t.split(/\s+/);
        if (key === 'TUPLTYPE')
          fields.TUPLTYPE = (
            (fields.TUPLTYPE ? fields.TUPLTYPE + ' ' : '') + rest.join(' ')
          ).trim();
        else fields[key] = Number(rest[0]);
      }
      width = fields.WIDTH;
      height = fields.HEIGHT;
      maxval = fields.MAXVAL;
      depth = fields.DEPTH;
      tupl = fields.TUPLTYPE || '';
      if (![1, 2, 3, 4].includes(depth)) fail('This PAM has an unsupported depth.');
    }
    if (!(maxval >= 1 && maxval <= 65535)) fail('This PNM has an invalid maximum value.');
    checkSize(width, height, limitsOf(opts), 'PNM');
    const sample = maxval > 255 ? 2 : 1,
      n = width * height;
    if (p + n * depth * sample > bytes.length) fail('This PNM file is truncated.');
    const out = new Uint8ClampedArray(n * 4);
    const read = () => {
      const v = sample === 2 ? (bytes[p] << 8) | bytes[p + 1] : bytes[p];
      p += sample;
      return maxval === 255 ? v : Math.round((v * 255) / maxval);
    };
    const hasAlpha = depth === 2 || depth === 4 || /ALPHA/.test(tupl);
    for (let o = 0; o < n * 4; o += 4) {
      if (depth >= 3) {
        out[o] = read();
        out[o + 1] = read();
        out[o + 2] = read();
      } else {
        const v = read();
        out[o] = v;
        out[o + 1] = v;
        out[o + 2] = v;
      }
      out[o + 3] = hasAlpha && (depth === 2 || depth === 4) ? read() : 255;
    }
    return { width, height, data: out };
  }

  // ---------------------------------------------------------------- zlib, PDF, EPS

  function zlibStored(bytes) {
    const blocks = Math.max(1, Math.ceil(bytes.length / 65535));
    const out = new Uint8Array(2 + bytes.length + blocks * 5 + 4);
    out[0] = 0x78;
    out[1] = 0x01;
    let o = 2;
    for (let b = 0; b < blocks; b += 1) {
      const start = b * 65535,
        len = Math.min(65535, bytes.length - start);
      out[o++] = b === blocks - 1 ? 1 : 0;
      out[o++] = len & 255;
      out[o++] = len >> 8;
      out[o++] = ~len & 255;
      out[o++] = (~len >> 8) & 255;
      out.set(bytes.subarray(start, start + len), o);
      o += len;
    }
    const sum = adler32(bytes);
    out[o++] = sum >>> 24;
    out[o++] = (sum >>> 16) & 255;
    out[o++] = (sum >>> 8) & 255;
    out[o++] = sum & 255;
    return out;
  }

  async function streamThrough(transform, bytes, maxOut, label) {
    const writer = transform.writable.getWriter();
    const reader = transform.readable.getReader();
    const writing = writer.write(bytes).then(() => writer.close());
    writing.catch(() => {});
    const chunks = [];
    let total = 0;
    for (;;) {
      let step;
      try {
        step = await reader.read();
      } catch (error) {
        return fail(`${label} is not valid compressed data.`);
      }
      const { value, done } = step;
      if (done) break;
      total += value.length;
      if (maxOut != null && total > maxOut) {
        reader.cancel().catch(() => {});
        fail(`${label} expands beyond its declared size.`);
      }
      chunks.push(value);
    }
    await writing;
    return concat(chunks);
  }

  // zlib-wrapped deflate: CompressionStream when available, else stored blocks.
  async function deflateZlib(bytes, opts = {}) {
    if (!opts.stored && typeof CompressionStream === 'function') {
      try {
        return await streamThrough(new CompressionStream('deflate'), bytes, null, 'Deflate');
      } catch (error) {
        /* fall back to stored blocks */
      }
    }
    return zlibStored(bytes);
  }

  function pdfNumber(n) {
    return String(Math.round(n * 10000) / 10000);
  }

  function pdfText(text) {
    let hex = 'FEFF';
    const s = String(text).slice(0, 500);
    for (let i = 0; i < s.length; i += 1)
      hex += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
    return `<${hex}>`;
  }

  async function encodePdf(image, opts = {}) {
    const { width, height, data } = asImage(image, 'PDF', opts);
    const dpi = dpiOf(opts);
    const wpt = (width * 72) / dpi,
      hpt = (height * 72) / dpi;
    if (wpt > 14400 || hpt > 14400)
      fail('PDF pages are limited to 200 inches per side; raise the dpi.');
    const n = width * height;
    const rgb = new Uint8Array(n * 3);
    const alpha = isOpaque(data) ? null : new Uint8Array(n);
    for (let i = 0, s = 0; i < n; i += 1, s += 4) {
      rgb[i * 3] = data[s];
      rgb[i * 3 + 1] = data[s + 1];
      rgb[i * 3 + 2] = data[s + 2];
      if (alpha) alpha[i] = data[s + 3];
    }
    const rgbZ = await deflateZlib(rgb, opts);
    const alphaZ = alpha ? await deflateZlib(alpha, opts) : null;
    const content = ascii(`q\n${pdfNumber(wpt)} 0 0 ${pdfNumber(hpt)} 0 0 cm\n/Im0 Do\nQ\n`);
    const objects = [];
    const add = (dict, stream) => {
      objects.push({ dict, stream });
      return objects.length;
    };
    const catalog = add(''),
      pages = add(''),
      page = add('');
    const contents = add(`<< /Length ${content.length} >>`, content);
    const smask = alphaZ
      ? add(
          `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${alphaZ.length} >>`,
          alphaZ,
        )
      : 0;
    const img = add(
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${smask ? ` /SMask ${smask} 0 R` : ''} /Length ${rgbZ.length} >>`,
      rgbZ,
    );
    const info = add(
      `<< /Producer ${pdfText('AlcorPhoto')}${opts.title ? ` /Title ${pdfText(opts.title)}` : ''} >>`,
    );
    objects[catalog - 1].dict = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
    objects[pages - 1].dict = `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`;
    objects[page - 1].dict =
      `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${pdfNumber(wpt)} ${pdfNumber(hpt)}] /Resources << /XObject << /Im0 ${img} 0 R >> >> /Contents ${contents} 0 R >>`;
    const w = new Writer(rgbZ.length + (alphaZ ? alphaZ.length : 0) + 2048);
    w.ascii('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
    const offsets = [];
    objects.forEach((obj, i) => {
      offsets.push(w.length);
      w.ascii(`${i + 1} 0 obj\n${obj.dict}\n`);
      if (obj.stream) {
        w.ascii('stream\n');
        w.bytes(obj.stream);
        w.ascii('\nendstream\n');
      }
      w.ascii('endobj\n');
    });
    const xref = w.length;
    w.ascii(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
    for (const off of offsets) w.ascii(`${String(off).padStart(10, '0')} 00000 n \n`);
    w.ascii(
      `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    );
    return w.result();
  }

  function encodeEps(image, opts = {}) {
    const { width, height, data } = asImage(image, 'EPS', opts);
    const dpi = dpiOf(opts);
    const wpt = (width * 72) / dpi,
      hpt = (height * 72) / dpi;
    const title = String(opts.title || 'AlcorPhoto image')
      .replace(/[^\x20-\x7e]/g, '?')
      .slice(0, 200);
    const head = `%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 ${Math.ceil(wpt)} ${Math.ceil(hpt)}\n%%HiResBoundingBox: 0 0 ${pdfNumber(wpt)} ${pdfNumber(hpt)}\n%%Creator: AlcorPhoto\n%%Title: ${title}\n%%LanguageLevel: 2\n%%Pages: 1\n%%EndComments\n%%Page: 1 1\ngsave\n${pdfNumber(wpt)} ${pdfNumber(hpt)} scale\n${width} ${height} 8 [${width} 0 0 -${height} 0 ${height}]\ncurrentfile /ASCIIHexDecode filter false 3 colorimage\n`;
    const tail = '>\ngrestore\nshowpage\n%%EOF\n';
    const hexBytes = width * height * 6;
    const out = new Uint8Array(head.length + hexBytes + Math.ceil(hexBytes / 72) + tail.length);
    out.set(ascii(head));
    const HEX = ascii('0123456789ABCDEF');
    let o = head.length,
      col = 0;
    for (let s = 0; s < data.length; s += 4) {
      for (const v of overWhite(data, s)) {
        out[o++] = HEX[v >> 4];
        out[o++] = HEX[v & 15];
        col += 2;
        if (col >= 72) {
          out[o++] = 10;
          col = 0;
        }
      }
    }
    if (col) out[o++] = 10;
    out.set(ascii(tail), o);
    return out.slice(0, o + tail.length);
  }

  // ---------------------------------------------------------------- PSD (layered)

  function layerSource(layer, index) {
    if (!layer || typeof layer !== 'object') fail(`Layer ${index + 1} is invalid.`);
    const width = clampInt(layer.width, 0, 30000, NaN),
      height = clampInt(layer.height, 0, 30000, NaN);
    if (!(width >= 0) || !(height >= 0) || width !== layer.width || height !== layer.height)
      fail(`Layer ${index + 1} has invalid dimensions.`);
    if (width * height > MAX_PIXELS)
      fail(`Layer ${index + 1} is larger than ${MAX_PIXELS.toLocaleString('en-US')} pixels.`);
    const data = width * height ? layer.data : new Uint8ClampedArray(0);
    if (!data || data.length !== width * height * 4)
      fail(`Layer ${index + 1} needs ${width}×${height} RGBA data.`);
    const blendMode = BLEND_KEYS[layer.blendMode] ? layer.blendMode : 'normal';
    const opacity =
      layer.opacity == null ? 1 : Math.min(1, Math.max(0, Number(layer.opacity) || 0));
    return {
      name: String(layer.name == null ? `Layer ${index + 1}` : layer.name),
      width,
      height,
      data,
      opacity,
      blendMode,
      left: clampInt(layer.left ?? layer.x, -1e9, 1e9, 0),
      top: clampInt(layer.top ?? layer.y, -1e9, 1e9, 0),
      visible: layer.visible !== false,
      clipped: !!layer.clipped,
    };
  }

  // Simple source-over flatten (blend modes ignored) for callers that do not pass a composite.
  function flattenLayers(width, height, layers) {
    const out = new Float64Array(width * height * 4);
    for (const l of layers) {
      if (!l.visible) continue;
      for (let y = Math.max(0, -l.top); y < l.height && l.top + y < height; y += 1) {
        for (let x = Math.max(0, -l.left); x < l.width && l.left + x < width; x += 1) {
          const s = (y * l.width + x) * 4,
            o = ((l.top + y) * width + l.left + x) * 4;
          const a = (l.data[s + 3] / 255) * l.opacity;
          if (!a) continue;
          const da = out[o + 3],
            na = a + da * (1 - a);
          for (let c = 0; c < 3; c += 1)
            out[o + c] = (l.data[s + c] * a + out[o + c] * da * (1 - a)) / na;
          out[o + 3] = na;
        }
      }
    }
    const data = new Uint8ClampedArray(out.length);
    for (let i = 0; i < out.length; i += 4) {
      data[i] = out[i];
      data[i + 1] = out[i + 1];
      data[i + 2] = out[i + 2];
      data[i + 3] = out[i + 3] * 255;
    }
    return { width, height, data };
  }

  function rleChannel(plane, width, height, w) {
    const counts = w.length;
    for (let y = 0; y < height; y += 1) w.u16be(0);
    for (let y = 0; y < height; y += 1) {
      const n = packBits(plane, y * width, (y + 1) * width, w);
      w.buf[counts + y * 2] = n >> 8;
      w.buf[counts + y * 2 + 1] = n & 255;
    }
  }

  function planeOf(data, n, channel) {
    const plane = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) plane[i] = data[i * 4 + channel];
    return plane;
  }

  // doc: { width, height, composite?, layers: [...] } with layers[0] at the bottom of the stack.
  function encodePsd(doc, opts = {}) {
    if (!doc || typeof doc !== 'object') fail('PSD export needs a document.');
    const { width, height } = doc;
    checkSize(width, height, { maxPixels: MAX_PIXELS, maxSide: 30000 }, 'PSD');
    if (doc.layers != null && !Array.isArray(doc.layers))
      fail('PSD export needs a list of layers.');
    if (doc.layers && doc.layers.length > 8000) fail('PSD export is limited to 8000 layers.');
    let layers = (doc.layers || []).map(layerSource);
    const composite = doc.composite
      ? asImage(doc.composite, 'PSD composite', { maxSide: 30000 })
      : flattenLayers(width, height, layers);
    if (composite.width !== width || composite.height !== height)
      fail('The PSD composite must match the document size.');
    if (!layers.length)
      layers = [
        layerSource({ name: 'Layer 1', left: 0, top: 0, width, height, data: composite.data }, 0),
      ];
    const hasAlpha = !isOpaque(composite.data);
    const w = new Writer(width * height * 4 + 4096);
    w.ascii('8BPS');
    w.u16be(1);
    w.bytes(new Uint8Array(6));
    w.u16be(hasAlpha ? 4 : 3);
    w.u32be(height);
    w.u32be(width);
    w.u16be(8);
    w.u16be(3);
    w.u32be(0);
    // Image resources: ResolutionInfo (0x03ED), stored as pixels per inch in 16.16 fixed point.
    const dpi = dpiOf(opts);
    if (dpi >= 65536) fail('PSD resolution must be below 65536 dots per inch.');
    const fixed = Math.round(dpi * 65536) >>> 0;
    w.u32be(28);
    w.ascii('8BIM');
    w.u16be(0x03ed);
    w.u16be(0);
    w.u32be(16);
    w.u32be(fixed);
    w.u16be(1);
    w.u16be(1);
    w.u32be(fixed);
    w.u16be(1);
    w.u16be(1);
    // Layer and mask information.
    const lmStart = w.length;
    w.u32be(0);
    const liStart = w.length;
    w.u32be(0);
    w.u16be((hasAlpha ? -layers.length : layers.length) & 0xffff);
    const channelData = layers.map((l) => {
      const n = l.width * l.height;
      return [-1, 0, 1, 2].map((id) => {
        const cw = new Writer(n + 16);
        if (!n) cw.u16be(0);
        else {
          cw.u16be(1);
          rleChannel(planeOf(l.data, n, id < 0 ? 3 : id), l.width, l.height, cw);
        }
        return { id, bytes: cw.result() };
      });
    });
    layers.forEach((l, i) => {
      w.u32be(l.top);
      w.u32be(l.left);
      w.u32be(l.top + l.height);
      w.u32be(l.left + l.width);
      w.u16be(4);
      for (const ch of channelData[i]) {
        w.u16be(ch.id & 0xffff);
        w.u32be(ch.bytes.length);
      }
      w.ascii('8BIM');
      w.ascii(BLEND_KEYS[l.blendMode]);
      w.u8(Math.round(l.opacity * 255));
      w.u8(l.clipped ? 1 : 0);
      w.u8(l.visible ? 0x08 : 0x0a);
      w.u8(0);
      const extraAt = w.length;
      w.u32be(0);
      w.u32be(0);
      w.u32be(0);
      const pascal = l.name.replace(/[^\x20-\x7e]/g, '?').slice(0, 255);
      const nameAt = w.length;
      w.u8(pascal.length);
      w.ascii(pascal);
      w.pad(4, nameAt);
      const chars = l.name.slice(0, 4096);
      w.ascii('8BIMluni');
      const luniAt = w.length;
      w.u32be(0);
      w.u32be(chars.length);
      for (let k = 0; k < chars.length; k += 1) w.u16be(chars.charCodeAt(k));
      w.pad(4, luniAt + 4);
      w.setU32be(luniAt, w.length - luniAt - 4);
      w.setU32be(extraAt, w.length - extraAt - 4);
    });
    channelData.forEach((list) => list.forEach((ch) => w.bytes(ch.bytes)));
    w.pad(4, liStart + 4);
    w.setU32be(liStart, w.length - liStart - 4);
    w.u32be(0); // global layer mask info
    w.setU32be(lmStart, w.length - lmStart - 4);
    // Merged image: RLE planes; transparency is stored matted against white.
    const n = width * height,
      channels = hasAlpha ? 4 : 3,
      cd = composite.data;
    w.u16be(1);
    const countsAt = w.length;
    for (let i = 0; i < channels * height; i += 1) w.u16be(0);
    for (let c = 0; c < channels; c += 1) {
      const plane = new Uint8Array(n);
      for (let i = 0; i < n; i += 1) {
        const a = cd[i * 4 + 3];
        plane[i] =
          c === 3
            ? a
            : hasAlpha
              ? Math.round((cd[i * 4 + c] * a + 255 * (255 - a)) / 255)
              : cd[i * 4 + c];
      }
      for (let y = 0; y < height; y += 1) {
        const len = packBits(plane, y * width, (y + 1) * width, w);
        const at = countsAt + (c * height + y) * 2;
        w.buf[at] = len >> 8;
        w.buf[at + 1] = len & 255;
      }
    }
    return w.result();
  }

  function decodePsdLayers(input, opts = {}) {
    const bytes = toBytes(input, 'PSD');
    if (!hasSignature(bytes, '8BPS')) fail('This is not a PSD file (missing 8BPS signature).');
    const r = makeReader(bytes, false, 'PSD');
    r.skip(4);
    const version = r.u16();
    if (version !== 1 && version !== 2) fail('Unsupported PSD version.');
    const psb = version === 2;
    r.skip(6);
    const channels = r.u16(),
      height = r.u32(),
      width = r.u32(),
      depth = r.u16(),
      mode = r.u16();
    const limits = limitsOf(opts);
    if (channels < 1 || channels > 56) fail('This PSD has an invalid channel count.');
    checkSize(width, height, limits, 'PSD');
    if (depth !== 8) fail(`Only 8-bit PSD layers can be imported (this file is ${depth}-bit).`);
    if (mode !== 3) fail('Only RGB PSD layers can be imported. Convert the document to RGB first.');
    r.skip(r.u32());
    const resLen = r.u32(),
      resEnd = r.pos + resLen;
    if (resEnd > bytes.length) fail('This PSD file is truncated (image resources).');
    let resolution = null,
      resolutionUnit = null;
    while (r.pos + 12 <= resEnd) {
      if (r.text(4) !== '8BIM') break;
      const id = r.u16(),
        nameLen = r.u8();
      r.skip(nameLen + ((nameLen + 1) & 1));
      const size = r.u32(),
        start = r.pos;
      if (start + size > resEnd) fail('This PSD has a corrupt image resource.');
      if (id === 0x03ed && size >= 16) {
        // hRes is always pixels per inch (16.16 fixed); hResUnit is only the display unit.
        resolution = Math.round((r.u32() / 65536) * 100) / 100;
        resolutionUnit = r.u16() === 2 ? 'ppcm' : 'ppi';
      }
      r.pos = start + size + (size & 1);
    }
    r.pos = resEnd;
    const len = () => (psb ? r.u64() : r.u32());
    const lmLen = len(),
      lmEnd = r.pos + lmLen;
    if (lmEnd > bytes.length) fail('This PSD file is truncated (layer section).');
    const layers = [];
    let mergedAlpha = false;
    if (lmLen >= 4) {
      const liLen = len(),
        liEnd = r.pos + liLen;
      if (liEnd > lmEnd) fail('This PSD has a corrupt layer section length.');
      if (liLen >= 2) {
        let count = r.i16();
        mergedAlpha = count < 0;
        count = Math.abs(count);
        if (count > 8000) fail('This PSD has too many layers.');
        const maxTotal =
          Number.isFinite(opts.maxTotalLayerPixels) && opts.maxTotalLayerPixels >= 0
            ? Math.min(opts.maxTotalLayerPixels, 2 * MAX_PIXELS)
            : 2 * limits.maxPixels;
        let totalPixels = 0;
        const records = [];
        for (let i = 0; i < count; i += 1) {
          const top = r.i32(),
            left = r.i32(),
            bottom = r.i32(),
            right = r.i32();
          const lw = right - left,
            lh = bottom - top;
          if (lw < 0 || lh < 0 || lw > 30000 || lh > 30000 || (psb && (lw > 300000 || lh > 300000)))
            fail(`PSD layer ${i + 1} has invalid bounds.`);
          if (lw * lh > limits.maxPixels)
            fail(
              `PSD layer ${i + 1} is larger than ${limits.maxPixels.toLocaleString('en-US')} pixels.`,
            );
          totalPixels += lw * lh;
          if (totalPixels > maxTotal) fail('The PSD layers exceed the import pixel budget.');
          const nch = r.u16();
          if (nch > 56) fail(`PSD layer ${i + 1} has an invalid channel count.`);
          const chans = [];
          let chanTotal = 0;
          for (let c = 0; c < nch; c += 1) {
            const id = r.i16(),
              length = len();
            chanTotal += length;
            if (chanTotal > liLen)
              fail(`PSD layer ${i + 1} has channel lengths that exceed the file.`);
            chans.push({ id, length });
          }
          if (r.text(4) !== '8BIM') fail(`PSD layer ${i + 1} has a corrupt blend signature.`);
          const blendKey = r.text(4),
            opacity = r.u8(),
            clipping = r.u8(),
            flags = r.u8();
          r.skip(1);
          const extraLen = r.u32(),
            extraEnd = r.pos + extraLen;
          if (extraEnd > liEnd) fail(`PSD layer ${i + 1} has corrupt extra data.`);
          // Layer mask data: the user mask rectangle, default color and flags.
          const maskLen = r.u32(),
            maskStart = r.pos;
          let mask = null;
          if (maskLen >= 18) {
            const mt = r.i32(),
              ml = r.i32(),
              mb = r.i32(),
              mr = r.i32(),
              defaultColor = r.u8(),
              mflags = r.u8();
            const mw = mr - ml,
              mh = mb - mt;
            if (
              mw >= 0 &&
              mh >= 0 &&
              mw <= limits.maxSide &&
              mh <= limits.maxSide &&
              mw * mh <= limits.maxPixels
            )
              mask = {
                top: mt,
                left: ml,
                width: mw,
                height: mh,
                defaultColor,
                disabled: (mflags & 2) !== 0,
              };
            if (mask) {
              totalPixels += mw * mh;
              if (totalPixels > maxTotal) fail('The PSD layers exceed the import pixel budget.');
            }
          }
          if (maskStart + maskLen > extraEnd) fail(`PSD layer ${i + 1} has a corrupt mask block.`);
          r.pos = maskStart + maskLen;
          r.skip(r.u32());
          const nameAt = r.pos,
            nameLen = r.u8();
          let name = r.text(nameLen);
          r.pos = Math.min(extraEnd, nameAt + ((nameLen + 4) & ~3));
          let section = null;
          while (r.pos + 12 <= extraEnd) {
            const sig = r.text(4);
            if (sig !== '8BIM' && sig !== '8B64') break;
            const key = r.text(4);
            const big =
              psb &&
              [
                'LMsk',
                'Lr16',
                'Lr32',
                'Layr',
                'Mt16',
                'Mt32',
                'Mtrn',
                'Alph',
                'FMsk',
                'lnk2',
                'FEid',
                'FXid',
                'PxSD',
              ].includes(key);
            const size = big ? r.u64() : r.u32(),
              start = r.pos;
            if (start + size > extraEnd) fail(`PSD layer ${i + 1} has corrupt additional data.`);
            if (key === 'luni' && size >= 4) {
              const chars = r.u32();
              if (chars * 2 + 4 <= size) {
                let s = '';
                for (let k = 0; k < chars; k += 1) s += String.fromCharCode(r.u16());
                name = s.replace(/\0+$/, '');
              }
            } else if ((key === 'lsct' || key === 'lsdk') && size >= 4) {
              section = ['other', 'open', 'closed', 'divider'][r.u32()] || 'other';
            }
            r.pos = start + size;
          }
          r.pos = extraEnd;
          records.push({
            name,
            left,
            top,
            width: lw,
            height: lh,
            chans,
            opacity: opacity / 255,
            visible: (flags & 2) === 0,
            blendMode: BLEND_BY_KEY[blendKey] || 'normal',
            blendKey,
            clipped: clipping === 1,
            section,
            mask,
          });
        }
        const minPlaneBytes = (w, h) =>
          2 + Math.min(w * h, h * ((psb ? 4 : 2) + 2 * Math.ceil(w / 128)));
        for (const rec of records) {
          const n = rec.width * rec.height;
          if (
            n &&
            !rec.chans.some(
              (ch) =>
                ch.id >= -1 && ch.id <= 2 && ch.length >= minPlaneBytes(rec.width, rec.height),
            )
          )
            fail(`PSD layer "${rec.name.slice(0, 64)}" has no pixel data for its bounds.`);
          const data = new Uint8ClampedArray(n * 4);
          if (n) for (let i = 3; i < data.length; i += 4) data[i] = 255;
          const decodePlane = (block, w, h) => {
            if (block.length < minPlaneBytes(w, h)) fail('PSD channel data is truncated.');
            const count = w * h,
              plane = new Uint8Array(count);
            const comp = (block[0] << 8) | block[1];
            if (comp === 0) {
              if (block.length < 2 + count) fail('PSD raw channel data is truncated.');
              plane.set(block.subarray(2, 2 + count));
            } else if (comp === 1) {
              const cb = psb ? 4 : 2,
                countsEnd = 2 + h * cb;
              if (countsEnd > block.length) fail('PSD run-length counts are truncated.');
              let p = countsEnd;
              for (let y = 0; y < h; y += 1) {
                const at = 2 + y * cb;
                const rowLen = psb
                  ? ((block[at] << 24) |
                      (block[at + 1] << 16) |
                      (block[at + 2] << 8) |
                      block[at + 3]) >>>
                    0
                  : (block[at] << 8) | block[at + 1];
                if (p + rowLen > block.length)
                  fail('PSD run-length rows exceed the channel length.');
                unpackBits(block, p, p + rowLen, plane, y * w, w, 'PSD');
                p += rowLen;
              }
            } else
              fail(
                'This PSD uses ZIP-compressed layer data, which is not supported. Re-save with RLE (PackBits) compression.',
              );
            return plane;
          };
          let maskPlane = null;
          for (const ch of rec.chans) {
            if (r.pos + ch.length > liEnd) fail('PSD channel data runs past the layer section.');
            const block = r.bytes(ch.length);
            if (
              ch.id === -2 &&
              rec.mask &&
              !rec.mask.disabled &&
              rec.mask.width * rec.mask.height
            ) {
              maskPlane = decodePlane(block, rec.mask.width, rec.mask.height);
              continue;
            }
            if (!n || ch.id < -1 || ch.id > 2) continue;
            const plane = decodePlane(block, rec.width, rec.height);
            const c = ch.id < 0 ? 3 : ch.id;
            for (let i = 0; i < n; i += 1) data[i * 4 + c] = plane[i];
          }
          // Apply the user mask (gray levels scale alpha; outside its rectangle the default color rules).
          if (n && rec.mask && !rec.mask.disabled) {
            const m = rec.mask;
            for (let y = 0; y < rec.height; y += 1)
              for (let x = 0; x < rec.width; x += 1) {
                const mx = rec.left + x - m.left,
                  my = rec.top + y - m.top;
                const v =
                  maskPlane && mx >= 0 && my >= 0 && mx < m.width && my < m.height
                    ? maskPlane[my * m.width + mx]
                    : m.defaultColor;
                const o = (y * rec.width + x) * 4 + 3;
                data[o] = (data[o] * v) / 255;
              }
          }
          rec.masked = Boolean(rec.mask && !rec.mask.disabled);
          delete rec.chans;
          delete rec.mask;
          rec.data = data;
          layers.push(rec);
        }
      }
    }
    return { width, height, layers, mergedAlpha, resolution, resolutionUnit, psb };
  }

  // ---------------------------------------------------------------- ZIP + OpenRaster

  function dosDateTime(date) {
    const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
    const year = Math.min(2107, Math.max(1980, d.getFullYear()));
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  function zipStore(input, opts = {}) {
    // Counts, sizes, offsets and name lengths are 16/32-bit fields (no ZIP64).
    if (!Array.isArray(input) || input.length > 65535)
      fail('A ZIP archive needs a list of at most 65535 entries.');
    let total = 0;
    const entries = input.map((e) => {
      if (!e || typeof e.name !== 'string' || !e.name) fail('Every ZIP entry needs a name.');
      const data = toBytes(e.data, `ZIP entry ${e.name}`);
      if (utf8(e.name).length > 65535) fail('A ZIP entry name is too long.');
      total += data.length + 128 + e.name.length * 3;
      if (total > 0xfffffff0) fail('ZIP archives are limited to 4 GB (ZIP64 is not written).');
      return { name: e.name, data };
    });
    const { time, date } = dosDateTime(opts.date);
    const w = new Writer(entries.reduce((n, e) => n + e.data.length + 128, 64));
    const central = new Writer(entries.length * 64 + 64);
    for (const e of entries) {
      const name = utf8(e.name),
        crc = crc32(e.data),
        offset = w.length,
        flags = /[^\x20-\x7e]/.test(e.name) ? 0x0800 : 0;
      w.u32le(0x04034b50);
      w.u16le(10);
      w.u16le(flags);
      w.u16le(0);
      w.u16le(time);
      w.u16le(date);
      w.u32le(crc);
      w.u32le(e.data.length);
      w.u32le(e.data.length);
      w.u16le(name.length);
      w.u16le(0);
      w.bytes(name);
      w.bytes(e.data);
      central.u32le(0x02014b50);
      central.u16le(20);
      central.u16le(10);
      central.u16le(flags);
      central.u16le(0);
      central.u16le(time);
      central.u16le(date);
      central.u32le(crc);
      central.u32le(e.data.length);
      central.u32le(e.data.length);
      central.u16le(name.length);
      central.u16le(0);
      central.u16le(0);
      central.u16le(0);
      central.u16le(0);
      central.u32le(0);
      central.u32le(offset);
      central.bytes(name);
    }
    const cdOffset = w.length;
    w.bytes(central.result());
    w.u32le(0x06054b50);
    w.u16le(0);
    w.u16le(0);
    w.u16le(entries.length);
    w.u16le(entries.length);
    w.u32le(w.length - cdOffset - 12);
    w.u32le(cdOffset);
    w.u16le(0);
    return w.result();
  }

  function zipDirectory(bytes) {
    const r = makeReader(bytes, true, 'ZIP');
    let eocd = -1;
    for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 22 - 65535); p -= 1) {
      if (bytes[p] === 0x50 && bytes[p + 1] === 0x4b && bytes[p + 2] === 5 && bytes[p + 3] === 6) {
        eocd = p;
        break;
      }
    }
    if (eocd < 0) fail('This ZIP archive has no central directory.');
    r.pos = eocd + 10;
    const count = r.u16();
    r.skip(4);
    const cdOffset = r.u32();
    if (count > 10000) fail('This ZIP archive has too many entries.');
    r.pos = cdOffset;
    const entries = new Map();
    const order = [];
    for (let i = 0; i < count; i += 1) {
      if (r.u32() !== 0x02014b50) fail('This ZIP central directory is corrupt.');
      r.skip(4);
      const flags = r.u16(),
        method = r.u16();
      r.skip(4);
      const crc = r.u32(),
        csize = r.u32(),
        usize = r.u32(),
        nameLen = r.u16(),
        extraLen = r.u16(),
        commentLen = r.u16();
      r.skip(8);
      const local = r.u32();
      const name = utf8Decode(r.bytes(nameLen));
      r.skip(extraLen + commentLen);
      if (flags & 1) fail('Encrypted ZIP entries are not supported.');
      if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff)
        fail('ZIP64 archives are not supported.');
      const lr = makeReader(bytes, true, 'ZIP');
      lr.pos = local;
      if (lr.u32() !== 0x04034b50) fail('This ZIP local header is corrupt.');
      lr.skip(22);
      const start = local + 30 + lr.u16() + lr.u16();
      if (start + csize > bytes.length) fail('This ZIP archive is truncated.');
      entries.set(name, { name, method, crc, csize, usize, start });
      order.push(name);
    }
    return { entries, order };
  }

  async function zipRead(bytes, entry, maxBytes) {
    if (entry.usize > maxBytes) fail(`ZIP entry ${entry.name} is too large.`);
    const raw = bytes.subarray(entry.start, entry.start + entry.csize);
    let data;
    if (entry.method === 0) data = raw;
    else if (entry.method === 8) {
      if (typeof DecompressionStream !== 'function')
        fail('This browser cannot read deflate-compressed ZIP entries.');
      data = await streamThrough(
        new DecompressionStream('deflate-raw'),
        raw,
        entry.usize,
        `ZIP entry ${entry.name}`,
      );
    } else fail(`ZIP entry ${entry.name} uses an unsupported compression method.`);
    if (data.length !== entry.usize || crc32(data) !== entry.crc)
      fail(`ZIP entry ${entry.name} failed its CRC check.`);
    return data;
  }

  function xmlAttr(value) {
    return escapeXml(cleanXmlChars(value))
      .replace(/\n/g, '&#10;')
      .replace(/\r/g, '&#13;')
      .replace(/\t/g, '&#9;');
  }

  // doc: { width, height, composite?, layers } with layers[0] at the bottom. opts.pngEncoder required.
  async function encodeOra(doc, opts = {}) {
    if (typeof opts.pngEncoder !== 'function')
      fail('OpenRaster export needs a pngEncoder function.');
    const { width, height } = doc || {};
    checkSize(width, height, limitsOf(opts), 'OpenRaster');
    if (doc.layers != null && (!Array.isArray(doc.layers) || doc.layers.length > 8000))
      fail('OpenRaster export needs a list of at most 8000 layers.');
    const layers = (doc.layers || []).map(layerSource);
    const composite = doc.composite
      ? asImage(doc.composite, 'OpenRaster composite', opts)
      : flattenLayers(width, height, layers);
    const png = async (image) => {
      const bytes = toBytes(await opts.pngEncoder(image), 'PNG');
      if (!hasSignature(bytes, PNG_SIGNATURE))
        fail('The OpenRaster pngEncoder did not return PNG bytes.');
      return bytes;
    };
    const dpi = dpiOf(opts);
    const files = [];
    const stack = [];
    for (let i = layers.length - 1; i >= 0; i -= 1) {
      const l = layers[i];
      const image =
        l.width && l.height
          ? { width: l.width, height: l.height, data: l.data }
          : { width: 1, height: 1, data: new Uint8ClampedArray(4) };
      const src = `data/layer${i}.png`;
      files.push({ name: src, data: await png(image) });
      const op = l.blendMode === 'normal' ? 'svg:src-over' : `svg:${l.blendMode}`;
      stack.push(
        `<layer name="${xmlAttr(l.name)}" src="${src}" x="${l.left}" y="${l.top}" opacity="${l.opacity.toFixed(3)}" visibility="${l.visible ? 'visible' : 'hidden'}" composite-op="${op}"/>`,
      );
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<image version="0.0.5" w="${width}" h="${height}" xres="${dpi}" yres="${dpi}"><stack>${stack.join('')}</stack></image>\n`;
    const entries = [
      { name: 'mimetype', data: ascii('image/openraster') },
      { name: 'stack.xml', data: utf8(xml) },
      ...files,
    ];
    entries.push({
      name: 'Thumbnails/thumbnail.png',
      data: await png(fitInto(composite, 256, false)),
    });
    entries.push({ name: 'mergedimage.png', data: await png(composite) });
    return zipStore(entries, opts);
  }

  function decodeEntities(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => {
      if (e[0] === '#') {
        const n =
          e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
      }
      return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e.toLowerCase()];
    });
  }

  function parseAttrs(text) {
    const attrs = {};
    const re = /(?<![\w:.-])([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(text))) attrs[m[1]] = decodeEntities(m[2] != null ? m[2] : m[3]);
    return attrs;
  }

  async function decodeOra(input, opts = {}) {
    const bytes = toBytes(input, 'OpenRaster');
    if (!hasSignature(bytes, [0x50, 0x4b, 3, 4]))
      fail('This is not an OpenRaster file (not a ZIP archive).');
    const { entries, order } = zipDirectory(bytes);
    const maxEntry =
      Number.isFinite(opts.maxEntryBytes) && opts.maxEntryBytes >= 0
        ? Math.min(opts.maxEntryBytes, 256 * 1024 * 1024)
        : 256 * 1024 * 1024;
    const mime = entries.get('mimetype');
    if (
      !mime ||
      order[0] !== 'mimetype' ||
      utf8Decode(await zipRead(bytes, mime, 256)).trim() !== 'image/openraster'
    )
      fail('This is not an OpenRaster file (bad mimetype entry).');
    const stackEntry = entries.get('stack.xml');
    if (!stackEntry) fail('This OpenRaster file has no stack.xml.');
    // Comments are cut with indexOf (linear); tags never span another '<'.
    const raw = utf8Decode(await zipRead(bytes, stackEntry, 4 * 1024 * 1024));
    let xml = '';
    for (let at = 0; at < raw.length; ) {
      const open = raw.indexOf('<!--', at);
      if (open < 0) {
        xml += raw.slice(at);
        break;
      }
      xml += raw.slice(at, open);
      const close = raw.indexOf('-->', open + 4);
      if (close < 0) break;
      at = close + 3;
    }
    // Linear-time tag scanner: the name cannot be backtracked into (lookahead), and the
    // attribute run is one greedy class that stops at the next '<' or '>'.
    const tagRe = /<\s*(\/?)([A-Za-z_][\w:.-]*)(?![\w:.-])([^<>]*)>/g;
    const finiteOr = (value, fallback) => {
      const v = Number(value);
      return Number.isFinite(v) ? v : fallback;
    };
    const clampOffset = (v) => Math.min(1e9, Math.max(-1e9, Math.round(v)));
    const found = [];
    const frames = [{ x: 0, y: 0, opacity: 1, visible: true }];
    let image = null,
      m;
    while ((m = tagRe.exec(xml))) {
      const [, closing, tag, rest] = m;
      const selfClose = rest.trimEnd().endsWith('/');
      if (closing) {
        if (tag === 'stack' && frames.length > 1) frames.pop();
        continue;
      }
      const a = parseAttrs(rest);
      const parent = frames[frames.length - 1];
      if (tag === 'image') image = a;
      else if (tag === 'stack' && !selfClose) {
        if (frames.length > 64) fail('This OpenRaster stack is nested too deeply.');
        const stackOpacity = Math.min(1, Math.max(0, finiteOr(a.opacity, 1)));
        frames.push({
          x: clampOffset(parent.x + finiteOr(a.x, 0)),
          y: clampOffset(parent.y + finiteOr(a.y, 0)),
          opacity: parent.opacity * stackOpacity,
          visible: parent.visible && a.visibility !== 'hidden',
        });
      } else if (tag === 'layer') {
        if (found.length >= 8000) fail('This OpenRaster file has too many layers.');
        const op = String(a['composite-op'] || 'svg:src-over').replace(/^svg:/, '');
        found.push({
          name: a.name || `Layer ${found.length + 1}`,
          src: a.src,
          x: clampOffset(parent.x + finiteOr(a.x, 0)),
          y: clampOffset(parent.y + finiteOr(a.y, 0)),
          opacity: Math.min(1, Math.max(0, finiteOr(a.opacity, 1))) * parent.opacity,
          visible: parent.visible && a.visibility !== 'hidden',
          blendMode: BLEND_KEYS[op] ? op : 'normal',
        });
      }
    }
    if (!image) fail('This OpenRaster stack.xml has no image element.');
    const width = Number(image.w),
      height = Number(image.h);
    checkSize(width, height, limitsOf(opts), 'OpenRaster');
    let total = 0;
    const readPng = async (name) => {
      const entry = entries.get(name);
      if (!entry) return null;
      total += entry.usize;
      if (total > 4 * maxEntry) fail('This OpenRaster file is too large to import.');
      const data = await zipRead(bytes, entry, maxEntry);
      if (!hasSignature(data, PNG_SIGNATURE)) fail(`OpenRaster entry ${name} is not a PNG image.`);
      return data.slice();
    };
    const layers = [];
    for (const l of found.reverse()) {
      if (!l.src) continue;
      const png = await readPng(l.src);
      if (!png) fail(`OpenRaster layer ${l.name} is missing ${l.src}.`);
      layers.push({
        name: l.name,
        x: l.x,
        y: l.y,
        opacity: l.opacity,
        visible: l.visible,
        blendMode: l.blendMode,
        png,
      });
    }
    const res = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    return {
      width,
      height,
      xres: res(image.xres),
      yres: res(image.yres),
      layers,
      merged: await readPng('mergedimage.png'),
      thumbnail: await readPng('Thumbnails/thumbnail.png'),
    };
  }

  // ---------------------------------------------------------------- SVG (layered + tracer)

  function cleanXmlChars(value) {
    const s = String(value == null ? '' : value);
    let out = '';
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          out += s[i] + s[i + 1];
          i += 1;
        }
        continue;
      }
      if (
        (c >= 0xdc00 && c <= 0xdfff) ||
        c === 0xfffe ||
        c === 0xffff ||
        (c < 0x20 && c !== 9 && c !== 10 && c !== 13)
      )
        continue;
      out += s[i];
    }
    return out;
  }

  function escapeXml(value) {
    return cleanXmlChars(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function num(value, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return String(fallback);
    return String(Math.round(Math.min(1e6, Math.max(-1e6, n)) * 1000) / 1000);
  }

  function svgColor(value, fallback) {
    const v = String(value == null ? '' : value).trim();
    if (
      /^#[0-9a-f]{3,8}$/i.test(v) ||
      /^(rgb|rgba|hsl|hsla)\([0-9.,%\s+-]+\)$/i.test(v) ||
      /^[a-z]{3,24}$/i.test(v)
    )
      return v;
    return fallback;
  }

  function paintAttrs(l, defaultFill) {
    let s = ` fill="${escapeXml(svgColor(l.fill, defaultFill))}"`;
    const stroke = svgColor(l.stroke, 'none');
    if (stroke !== 'none' && Number(l.strokeWidth) > 0)
      s += ` stroke="${escapeXml(stroke)}" stroke-width="${num(l.strokeWidth)}"`;
    return s;
  }

  // doc: { width, height, background?, title?, layers: [...] } with layers[0] at the bottom.
  // Returns an SVG document string.
  function encodeLayeredSvg(doc, opts = {}) {
    if (!doc || typeof doc !== 'object') fail('SVG export needs a document.');
    const { width, height } = doc;
    checkSize(width, height, limitsOf(opts), 'SVG');
    const layers = doc.layers || [];
    if (!Array.isArray(layers) || layers.length > 8000)
      fail('SVG export needs a list of at most 8000 layers.');
    const parts = [];
    parts.push(
      `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="isolation:isolate">`,
    );
    if (doc.title || opts.title)
      parts.push(`<title>${escapeXml(String(doc.title || opts.title).slice(0, 200))}</title>`);
    const bg = svgColor(doc.background, '');
    if (bg) parts.push(`<rect width="${width}" height="${height}" fill="${escapeXml(bg)}"/>`);
    layers.forEach((l, i) => {
      if (!l || typeof l !== 'object') fail(`SVG layer ${i + 1} is invalid.`);
      const lw = Number(l.width) || 0,
        lh = Number(l.height) || 0;
      const sx = l.scaleX == null ? 1 : Number(l.scaleX),
        sy = l.scaleY == null ? 1 : Number(l.scaleY),
        rot = Number(l.rotation) || 0;
      const px = lw / 2,
        py = lh / 2;
      let transform = `translate(${num((Number(l.x) || 0) + px)} ${num((Number(l.y) || 0) + py)})`;
      if (rot) transform += ` rotate(${num(rot)})`;
      if (sx !== 1 || sy !== 1) transform += ` scale(${num(sx, 1)} ${num(sy, 1)})`;
      if (px || py) transform += ` translate(${num(-px)} ${num(-py)})`;
      let g = `<g id="layer-${i + 1}" data-name="${xmlAttr(String(l.name == null ? `Layer ${i + 1}` : l.name).slice(0, 500))}" transform="${transform}"`;
      const opacity = l.opacity == null ? 1 : Math.min(1, Math.max(0, Number(l.opacity) || 0));
      if (opacity < 1) g += ` opacity="${num(opacity)}"`;
      if (l.blendMode && l.blendMode !== 'normal' && BLEND_KEYS[l.blendMode])
        g += ` style="mix-blend-mode:${l.blendMode}"`;
      if (l.visible === false) g += ' display="none"';
      // Drop shadow (text): canvas offsets/blur are in output pixels, so they are mapped
      // back through this group's rotation and scale to land in the same place.
      if (l.shadow && typeof l.shadow === 'object') {
        const a = (-rot * Math.PI) / 180,
          ox0 = Number(l.shadow.x) || 0,
          oy0 = Number(l.shadow.y) || 0;
        const dx = (ox0 * Math.cos(a) - oy0 * Math.sin(a)) / (sx || 1),
          dy = (ox0 * Math.sin(a) + oy0 * Math.cos(a)) / (sy || 1);
        const sd =
          Math.max(0, Number(l.shadow.blur) || 0) /
          2 /
          Math.max(1e-6, Math.sqrt(Math.abs(sx * sy)) || 1);
        const color = svgColor(l.shadow.color, '#000000');
        g += ` filter="url(#shadow-${i + 1})"`;
        parts.push(
          `<defs><filter id="shadow-${i + 1}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB"><feDropShadow dx="${num(dx)}" dy="${num(dy)}" stdDeviation="${num(sd)}" flood-color="${escapeXml(color)}"/></filter></defs>`,
        );
      }
      parts.push(`${g}>`);
      if (l.type === 'image') {
        // An untouched image layer keeps its original encoded bytes (no re-render, no re-encode).
        const bytes = toBytes(l.bytes, 'image');
        const mime = hasSignature(bytes, PNG_SIGNATURE)
          ? 'image/png'
          : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
            ? 'image/jpeg'
            : bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
              ? 'image/gif'
              : bytes[0] === 0x52 &&
                  bytes[1] === 0x49 &&
                  bytes[2] === 0x46 &&
                  bytes[3] === 0x46 &&
                  bytes[8] === 0x57 &&
                  bytes[9] === 0x45 &&
                  bytes[10] === 0x42 &&
                  bytes[11] === 0x50
                ? 'image/webp'
                : null;
        if (!mime) fail(`SVG image layer ${i + 1} needs PNG, JPEG, GIF, or WebP bytes.`);
        parts.push(
          `<image x="0" y="0" width="${num(lw)}" height="${num(lh)}" preserveAspectRatio="none" xlink:href="data:${mime};base64,${base64(bytes)}"/>`,
        );
      } else if (l.type === 'raster') {
        const png = toBytes(l.png, 'PNG');
        if (!hasSignature(png, PNG_SIGNATURE)) fail(`SVG raster layer ${i + 1} needs PNG bytes.`);
        parts.push(
          `<image x="0" y="0" width="${num(lw)}" height="${num(lh)}" preserveAspectRatio="none" xlink:href="data:image/png;base64,${base64(png)}"/>`,
        );
      } else if (l.type === 'rect') {
        const rx =
          Number(l.rx) > 0 ? ` rx="${num(l.rx)}" ry="${num(l.ry == null ? l.rx : l.ry)}"` : '';
        parts.push(
          `<rect x="0" y="0" width="${num(Math.max(0, lw))}" height="${num(Math.max(0, lh))}"${rx}${paintAttrs(l, '#000000')}/>`,
        );
      } else if (l.type === 'ellipse') {
        parts.push(
          `<ellipse cx="${num(px)}" cy="${num(py)}" rx="${num(Math.abs(px))}" ry="${num(Math.abs(py))}"${paintAttrs(l, '#000000')}/>`,
        );
      } else if (l.type === 'path') {
        const d = String(l.d || '');
        if (d.length > 4000000 || !/^[MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]*$/.test(d))
          fail(`SVG path layer ${i + 1} has invalid path data.`);
        const rule = l.fillRule === 'evenodd' ? ' fill-rule="evenodd"' : '';
        parts.push(
          `<path d="${d.replace(/\s+/g, ' ').trim()}"${rule}${paintAttrs(l, '#000000')}/>`,
        );
      } else if (l.type === 'text') {
        const size = Number(l.fontSize) > 0 ? Number(l.fontSize) : 32;
        const family =
          String(l.fontFamily || 'sans-serif')
            .replace(/[<>;{}\\]/g, '')
            .slice(0, 200) || 'sans-serif';
        const weight = /^(normal|bold|bolder|lighter|[1-9]00)$/.test(String(l.fontWeight))
          ? String(l.fontWeight)
          : 'normal';
        const anchor = l.align === 'center' ? 'middle' : l.align === 'right' ? 'end' : 'start';
        const ax = anchor === 'middle' ? lw / 2 : anchor === 'end' ? lw : 0;
        const lineHeight = (Number(l.lineHeight) > 0 ? Number(l.lineHeight) : 1.2) * size;
        let attrs = ` font-family="${xmlAttr(family)}" font-size="${num(size)}" font-weight="${weight}"`;
        if (l.italic) attrs += ' font-style="italic"';
        if (Number(l.letterSpacing)) attrs += ` letter-spacing="${num(l.letterSpacing)}"`;
        if (anchor !== 'start') attrs += ` text-anchor="${anchor}"`;
        attrs += paintAttrs(l, '#000000');
        // Canvas strokes the outline and then fills over it; paint-order matches that.
        if (svgColor(l.stroke, 'none') !== 'none' && Number(l.strokeWidth) > 0)
          attrs += ' paint-order="stroke" stroke-linejoin="round"';
        const lines = cleanXmlChars(l.text).replace(/\r\n?/g, '\n').split('\n').slice(0, 10000);
        const baseline = size * (l.baseline == null ? 0.8 : Number(l.baseline) || 0);
        const spans = lines.map(
          (line, k) =>
            `<tspan x="${num(ax)}" ${k ? `dy="${num(lineHeight)}"` : `y="${num(baseline)}"`}>${escapeXml(line) || ' '}</tspan>`,
        );
        parts.push(`<text xml:space="preserve"${attrs}>${spans.join('')}</text>`);
      } else fail(`SVG layer ${i + 1} has an unknown type.`);
      parts.push('</g>');
    });
    parts.push('</svg>\n');
    return parts.join('');
  }

  function traceLabels(img, mode, colors, threshold) {
    const { width, height, data } = img;
    const n = width * height;
    const labels = new Int16Array(n).fill(-1);
    let palette;
    if (mode === 'bw') {
      palette = [[0, 0, 0]];
      for (let i = 0, o = 0; i < n; i += 1, o += 4)
        if (
          data[o + 3] >= 128 &&
          0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2] < threshold
        )
          labels[i] = 0;
    } else if (mode === 'posterize') {
      const levels = Math.max(2, Math.floor(Math.cbrt(colors) + 1e-9));
      const step = 255 / (levels - 1),
        used = new Map();
      palette = [];
      for (let i = 0, o = 0; i < n; i += 1, o += 4) {
        if (data[o + 3] < 128) continue;
        const q = [0, 1, 2].map((c) => Math.round(data[o + c] / step));
        const key = (q[0] * levels + q[1]) * levels + q[2];
        if (!used.has(key)) {
          used.set(key, palette.length);
          palette.push(q.map((v) => Math.round(v * step)));
        }
        labels[i] = used.get(key);
      }
    } else if (mode === 'color') {
      const q = quantize(img, { colors });
      palette = [];
      for (let k = 0; k < q.count; k += 1)
        palette.push([q.palette[k * 3], q.palette[k * 3 + 1], q.palette[k * 3 + 2]]);
      for (let i = 0; i < n; i += 1)
        labels[i] = q.indices[i] === q.transparentIndex ? -1 : q.indices[i];
    } else fail('Trace mode must be color, bw, or posterize.');
    return { labels, palette };
  }

  // Closed-polygon Ramer–Douglas–Peucker (iterative). pts = [x0, y0, x1, y1, ...].
  function simplifyClosed(pts, epsilon) {
    const n = pts.length / 2;
    if (n < 4 || epsilon <= 0) return pts;
    let far = 0,
      best = -1;
    for (let i = 1; i < n; i += 1) {
      const d = (pts[i * 2] - pts[0]) ** 2 + (pts[i * 2 + 1] - pts[1]) ** 2;
      if (d > best) {
        best = d;
        far = i;
      }
    }
    const keep = new Uint8Array(n);
    keep[0] = 1;
    keep[far] = 1;
    const stack = [0, far, far, n];
    const eps2 = epsilon * epsilon;
    while (stack.length) {
      const b = stack.pop(),
        a = stack.pop();
      const ax = pts[a * 2],
        ay = pts[a * 2 + 1],
        bx = pts[(b % n) * 2],
        by = pts[(b % n) * 2 + 1];
      const dx = bx - ax,
        dy = by - ay,
        len2 = dx * dx + dy * dy;
      let idx = -1,
        max = eps2;
      for (let i = a + 1; i < b; i += 1) {
        const px = pts[i * 2] - ax,
          py = pts[i * 2 + 1] - ay;
        const d = len2 ? (px * dy - py * dx) ** 2 / len2 : px * px + py * py;
        if (d > max) {
          max = d;
          idx = i;
        }
      }
      if (idx >= 0) {
        keep[idx] = 1;
        stack.push(a, idx, idx, b);
      }
    }
    const out = [];
    for (let i = 0; i < n; i += 1) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
    return out.length >= 6 ? out : pts;
  }

  // Original raster-to-vector tracer: quantize, trace pixel-boundary contours per color,
  // simplify, optionally smooth into quadratic curves. Hard budgets fail closed.
  function traceToSvg(image, opts = {}) {
    const src = asImage(image, 'Trace', opts);
    const colors = clampInt(opts.colors, 2, 64, 8);
    const mode = opts.mode || 'color';
    const smoothing = Math.min(
      1,
      Math.max(0, Number(opts.smoothing == null ? 0.5 : opts.smoothing) || 0),
    );
    const minArea = Math.max(0, Number(opts.minArea == null ? 4 : opts.minArea) || 0);
    const maxPixels =
      Number.isFinite(opts.maxPixels) && opts.maxPixels > 0
        ? Math.min(opts.maxPixels, TRACE_MAX_PIXELS)
        : TRACE_MAX_PIXELS;
    const maxPoints =
      Number.isFinite(opts.maxPoints) && opts.maxPoints > 0
        ? Math.min(opts.maxPoints, TRACE_MAX_POINTS)
        : TRACE_MAX_POINTS;
    let img = src;
    if (src.width * src.height > maxPixels) {
      const k = Math.sqrt(maxPixels / (src.width * src.height));
      img = resizeArea(
        src,
        Math.max(1, Math.floor(src.width * k)),
        Math.max(1, Math.floor(src.height * k)),
      );
    }
    const W = img.width,
      H = img.height,
      V = W + 1;
    const scaleX = src.width / W,
      scaleY = src.height / H;
    const { labels, palette } = traceLabels(img, mode, colors, Number(opts.threshold) || 128);
    const areas = new Float64Array(palette.length),
      boxes = palette.map(() => [W, H, -1, -1]);
    for (let y = 0, i = 0; y < H; y += 1)
      for (let x = 0; x < W; x += 1, i += 1) {
        const c = labels[i];
        if (c < 0) continue;
        areas[c] += 1;
        const b = boxes[c];
        if (x < b[0]) b[0] = x;
        if (y < b[1]) b[1] = y;
        if (x > b[2]) b[2] = x;
        if (y > b[3]) b[3] = y;
      }
    const orderIdx = palette
      .map((_, i) => i)
      .filter((i) => areas[i] > 0)
      .sort((a, b) => areas[b] - areas[a]);
    const vert = new Uint8Array(V * (H + 1));
    const epsilon = smoothing * 1.5,
      curves = opts.curves == null ? smoothing > 0 : !!opts.curves;
    const fx = (v) => num(Math.round(v * scaleX * 100) / 100),
      fy = (v) => num(Math.round(v * scaleY * 100) / 100);
    const paths = [];
    let totalPoints = 0;
    for (const c of orderIdx) {
      const [x0, y0, x1, y1] = boxes[c];
      const inside = (x, y) => x >= 0 && y >= 0 && x < W && y < H && labels[y * W + x] === c;
      // Directed boundary edges with the shape on the right: E=1, S=2, W=4, N=8.
      for (let y = y0; y <= y1 + 1; y += 1)
        for (let x = x0; x <= x1 + 1; x += 1) vert[y * V + x] = 0;
      for (let y = y0; y <= y1 + 1; y += 1)
        for (let x = x0; x <= x1; x += 1) {
          const a = inside(x, y - 1),
            b = inside(x, y);
          if (a !== b) {
            if (b) vert[y * V + x] |= 1;
            else vert[y * V + x + 1] |= 4;
          }
        }
      for (let y = y0; y <= y1; y += 1)
        for (let x = x0; x <= x1 + 1; x += 1) {
          const a = inside(x - 1, y),
            b = inside(x, y);
          if (a !== b) {
            if (a) vert[y * V + x] |= 2;
            else vert[(y + 1) * V + x] |= 8;
          }
        }
      const d = [];
      for (let y = y0; y <= y1 + 1; y += 1)
        for (let x = x0; x <= x1 + 1; x += 1) {
          while (vert[y * V + x]) {
            const m0 = vert[y * V + x];
            let dir = m0 & -m0,
              cx = x,
              cy = y,
              prev = 0,
              firstDir = dir;
            const pts = [];
            for (;;) {
              vert[cy * V + cx] &= ~dir;
              if (dir !== prev) {
                pts.push(cx, cy);
                totalPoints += 1;
                if (totalPoints > maxPoints)
                  fail(
                    `Tracing stopped: the result would exceed ${maxPoints.toLocaleString('en-US')} points. Use fewer colors, more smoothing, or a larger minimum area.`,
                  );
              }
              prev = dir;
              cx += dir === 1 ? 1 : dir === 4 ? -1 : 0;
              cy += dir === 2 ? 1 : dir === 8 ? -1 : 0;
              if (cx === x && cy === y) break;
              const m = vert[cy * V + cx];
              if (!m) break;
              const right = dir === 8 ? 1 : dir << 1,
                left = dir === 1 ? 8 : dir >> 1;
              dir = m & right ? right : m & dir ? dir : m & left ? left : m & -m;
            }
            if (prev === firstDir && pts.length > 2) {
              pts.splice(0, 2);
              totalPoints -= 1;
            }
            let area = 0;
            for (let i = 0, k = pts.length; i < k; i += 2) {
              const j = (i + 2) % k;
              area += pts[i] * pts[j + 1] - pts[j] * pts[i + 1];
            }
            if (Math.abs(area / 2) < minArea || pts.length < 6) continue;
            const p = simplifyClosed(pts, epsilon);
            const k = p.length / 2;
            if (curves && k >= 3) {
              const mid = (i) => [
                (p[(i % k) * 2] + p[((i + 1) % k) * 2]) / 2,
                (p[(i % k) * 2 + 1] + p[((i + 1) % k) * 2 + 1]) / 2,
              ];
              const s = mid(k - 1);
              let seg = `M${fx(s[0])} ${fy(s[1])}`;
              for (let i = 0; i < k; i += 1) {
                const e = mid(i);
                seg += `Q${fx(p[i * 2])} ${fy(p[i * 2 + 1])} ${fx(e[0])} ${fy(e[1])}`;
              }
              d.push(`${seg}Z`);
            } else {
              let seg = `M${fx(p[0])} ${fy(p[1])}`;
              for (let i = 2; i < p.length; i += 2) seg += `L${fx(p[i])} ${fy(p[i + 1])}`;
              d.push(`${seg}Z`);
            }
          }
        }
      if (!d.length) continue;
      const [r, g, b] = palette[c];
      const hex = `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
      paths.push(`<path fill="${hex}" fill-rule="evenodd" d="${d.join('')}"/>`);
    }
    const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${src.width}" height="${src.height}" viewBox="0 0 ${src.width} ${src.height}">${paths.join('')}</svg>\n`;
    return {
      svg,
      width: src.width,
      height: src.height,
      pathCount: paths.length,
      pointCount: totalPoints,
      traceWidth: W,
      traceHeight: H,
    };
  }

  // ---------------------------------------------------------------- sniffing & browser probes

  function sniff(input, filename) {
    const bytes = toBytes(input);
    const has = (sig, at) => hasSignature(bytes, sig, at);
    if (has(PNG_SIGNATURE)) return 'png';
    if (has([0xff, 0xd8, 0xff])) return 'jpeg';
    if (has('GIF87a') || has('GIF89a')) return 'gif';
    if (has('RIFF') && has('WEBP', 8)) return 'webp';
    if (has('ftyp', 4) && bytes.length >= 12) {
      const boxEnd = Math.min(
        bytes.length,
        ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0 || 32,
      );
      const brands = [];
      for (let p = 8; p + 4 <= boxEnd; p += 4)
        if (p !== 12) brands.push(String.fromCharCode(...bytes.subarray(p, p + 4)));
      if (brands.some((b) => b === 'avif' || b === 'avis')) return 'avif';
      if (brands.some((b) => /^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)$/.test(b)))
        return 'heic';
    }
    if (has('qoif')) return 'qoi';
    if (has('8BPS')) return 'psd';
    if (has('%PDF-')) return 'pdf';
    if (has('II*\0') || has('MM\0*')) return 'tiff';
    if (has('BM') && bytes.length >= 26) {
      const h = bytes[14] | (bytes[15] << 8);
      if ([12, 40, 52, 56, 64, 108, 124].includes(h)) return 'bmp';
    }
    if (
      bytes.length >= 3 &&
      bytes[0] === 0x50 &&
      bytes[1] >= 0x31 &&
      bytes[1] <= 0x37 &&
      [9, 10, 13, 32].includes(bytes[2])
    )
      return 'ppm';
    if (
      bytes.length >= 6 &&
      bytes[0] === 0 &&
      bytes[1] === 0 &&
      (bytes[2] === 1 || bytes[2] === 2) &&
      bytes[3] === 0 &&
      (bytes[4] | (bytes[5] << 8)) > 0
    )
      return 'ico';
    if (has([0x50, 0x4b, 3, 4]))
      return has('mimetype', 30) && has('image/openraster', 38) ? 'ora' : 'zip';
    if (isSvgHead(utf8Decode(bytes.subarray(0, Math.min(bytes.length, 4096))))) return 'svg';
    if (bytes.length >= 44 && has('TRUEVISION-XFILE.', bytes.length - 18)) return 'tga';
    if (filename && /\.(tga|icb|vda|vst)$/i.test(String(filename))) return 'tga';
    return null;
  }

  // True when the text starts (after an optional BOM, XML declaration, comments and
  // DOCTYPE) with an <svg> element. Linear: every step moves forward with indexOf.
  function isSvgHead(text) {
    let s = text.replace(/^\uFEFF/, '').trimStart();
    if (s.startsWith('<?xml')) {
      const end = s.indexOf('>');
      if (end < 0) return false;
      s = s.slice(end + 1).trimStart();
    }
    for (;;) {
      if (s.startsWith('<!--')) {
        const end = s.indexOf('-->', 4);
        if (end < 0) return false;
        s = s.slice(end + 3).trimStart();
      } else if (/^<!DOCTYPE/i.test(s)) {
        const end = s.indexOf('>');
        if (end < 0) return false;
        s = s.slice(end + 1).trimStart();
      } else break;
    }
    return /^<svg[\s>]/i.test(s);
  }

  // Synchronous decode by sniffed format. Browser-native formats (png, jpeg, webp, avif, svg) are refused.
  function decode(input, opts) {
    opts = opts || {};
    const bytes = toBytes(input);
    const format = opts.format || sniff(bytes, opts.filename);
    const decoders = {
      bmp: decodeBmp,
      tiff: decodeTiff,
      tga: decodeTga,
      qoi: decodeQoi,
      ppm: decodePnm,
      ico: decodeIco,
      gif: decodeGif,
    };
    if (typeof format !== 'string' || !Object.prototype.hasOwnProperty.call(decoders, format)) {
      fail(
        typeof format === 'string' && /^[a-z0-9]{2,8}$/.test(format)
          ? `${format.toUpperCase()} files are decoded by the browser, not this module.`
          : 'This file format is not recognized.',
      );
    }
    return Object.assign({ format }, decoders[format](bytes, opts));
  }

  async function supportedBrowserTypes() {
    const result = { png: false, jpeg: false, webp: false, avif: false, probed: false };
    if (typeof document === 'undefined' || !document.createElement) return result;
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    if (typeof canvas.toBlob !== 'function') return result;
    const probe = (type) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 3000);
        try {
          canvas.toBlob(
            (blob) => {
              clearTimeout(timer);
              resolve(!!blob && blob.type === type);
            },
            type,
            0.8,
          );
        } catch (error) {
          clearTimeout(timer);
          resolve(false);
        }
      });
    result.png = await probe('image/png');
    result.jpeg = await probe('image/jpeg');
    result.webp = await probe('image/webp');
    result.avif = await probe('image/avif');
    result.probed = true;
    return result;
  }

  return Object.freeze({
    version: '1.0.0',
    MAX_PIXELS,
    MAX_SIDE,
    TRACE_MAX_PIXELS,
    TRACE_MAX_POINTS,
    ICO_SIZES,
    BLEND_MODES,
    BLEND_KEYS,
    encodeBmp,
    decodeBmp,
    encodeTiff,
    decodeTiff,
    encodeGif,
    encodeAnimatedGif,
    decodeGif,
    encodeIco,
    decodeIco,
    encodeTga,
    decodeTga,
    encodeQoi,
    decodeQoi,
    encodePnm,
    encodePpm,
    encodePgm,
    encodePam,
    decodePnm,
    encodePdf,
    encodeEps,
    encodePsd,
    decodePsdLayers,
    encodeOra,
    decodeOra,
    encodeLayeredSvg,
    traceToSvg,
    sniff,
    decode,
    supportedBrowserTypes,
    quantize,
    resizeArea,
    deflateZlib,
    zlibStored,
    crc32,
    adler32,
    lzwEncode,
    packBits,
    escapeXml,
    zipStore,
  });
});
