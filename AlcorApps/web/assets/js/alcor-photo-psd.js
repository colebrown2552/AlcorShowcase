/**
 * alcor-photo-psd.js: AlcorPhoto PSD reader.
 *
 * Reads the flattened composite image from Photoshop PSD and PSB files. Dimensions and total
 * pixels are capped so a hostile file cannot exhaust memory, and only raw or PackBits (RLE)
 * data is accepted; anything else fails closed. Loaded on demand by alcor-photo.js the first
 * time a PSD is opened.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AlcorPhotoPsd = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Read-only PSD/PSB import of the flattened composite ("Maximize Compatibility")
  // image. Layers, masks, adjustment layers, text, and effects inside the file are
  // not read: the result is one flattened picture. Supports 8- and 16-bit RGB and
  // Grayscale with raw or PackBits (RLE) compression. Fails closed on anything else.

  const MAX_PIXELS = 64 * 1024 * 1024;
  const MAX_SIDE_PSD = 30000;
  const MAX_SIDE_PSB = 300000;

  function reader(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    const need = (n) => {
      if (!(n >= 0) || offset + n > bytes.length) throw new Error('This PSD file is truncated.');
    };
    return {
      get offset() {
        return offset;
      },
      remaining() {
        return bytes.length - offset;
      },
      seek(value) {
        if (!(value >= 0) || value > bytes.length) throw new Error('This PSD file is truncated.');
        offset = value;
      },
      u8() {
        need(1);
        return bytes[offset++];
      },
      u16() {
        need(2);
        const v = view.getUint16(offset);
        offset += 2;
        return v;
      },
      i16() {
        need(2);
        const v = view.getInt16(offset);
        offset += 2;
        return v;
      },
      u32() {
        need(4);
        const v = view.getUint32(offset);
        offset += 4;
        return v;
      },
      u64() {
        need(8);
        const hi = view.getUint32(offset),
          lo = view.getUint32(offset + 4);
        offset += 8;
        if (hi > 0x1fffff) throw new Error('This PSB section is too large.');
        return hi * 4294967296 + lo;
      },
      text(n) {
        need(n);
        const v = String.fromCharCode(...bytes.subarray(offset, offset + n));
        offset += n;
        return v;
      },
      skip(n) {
        need(n);
        offset += n;
      },
      bytes(n) {
        need(n);
        const v = bytes.subarray(offset, offset + n);
        offset += n;
        return v;
      },
    };
  }

  // PackBits: n in 0..127 copies n+1 literal bytes; -127..-1 repeats the next byte 1-n times.
  function unpackBits(input, output, outOffset, outLength) {
    let i = 0,
      o = outOffset;
    const end = outOffset + outLength;
    while (o < end) {
      if (i >= input.length) throw new Error('PSD run-length data ended early.');
      let n = input[i++];
      if (n > 127) n -= 256;
      if (n >= 0) {
        const count = n + 1;
        if (i + count > input.length || o + count > end)
          throw new Error('PSD run-length data is corrupt.');
        output.set(input.subarray(i, i + count), o);
        i += count;
        o += count;
      } else if (n !== -128) {
        const count = 1 - n;
        if (i >= input.length || o + count > end)
          throw new Error('PSD run-length data is corrupt.');
        output.fill(input[i++], o, o + count);
        o += count;
      }
    }
    return i;
  }

  function isPsd(bytes) {
    return (
      bytes &&
      bytes.length >= 4 &&
      bytes[0] === 0x38 &&
      bytes[1] === 0x42 &&
      bytes[2] === 0x50 &&
      bytes[3] === 0x53
    );
  }

  function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input))
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw new Error('The PSD file must be bytes (Uint8Array or ArrayBuffer).');
  }

  function decodePsd(input) {
    const bytes = toBytes(input);
    if (!isPsd(bytes)) throw new Error('This is not a PSD file (missing 8BPS signature).');
    const r = reader(bytes);
    r.skip(4);
    const version = r.u16();
    if (version !== 1 && version !== 2) throw new Error('Unsupported PSD version.');
    const psb = version === 2;
    r.skip(6);
    const channels = r.u16();
    const height = r.u32();
    const width = r.u32();
    const depth = r.u16();
    const mode = r.u16();
    const maxSide = psb ? MAX_SIDE_PSB : MAX_SIDE_PSD;
    if (channels < 1 || channels > 56) throw new Error('This PSD has an invalid channel count.');
    if (width < 1 || height < 1 || width > maxSide || height > maxSide)
      throw new Error('This PSD has invalid dimensions.');
    if (width * height > MAX_PIXELS)
      throw new Error(`PSD import is limited to ${MAX_PIXELS.toLocaleString('en-US')} pixels.`);
    if (depth !== 8 && depth !== 16)
      throw new Error(`Only 8- and 16-bit PSD files can be imported (this one is ${depth}-bit).`);
    if (mode !== 3 && mode !== 1) {
      const names = {
        0: 'Bitmap',
        2: 'Indexed',
        4: 'CMYK',
        7: 'Multichannel',
        8: 'Duotone',
        9: 'Lab',
      };
      throw new Error(
        `${names[mode] || 'This'} color mode is not supported. Convert the document to RGB before importing.`,
      );
    }
    const colorChannels = mode === 3 ? 3 : 1;
    if (channels < colorChannels) throw new Error('This PSD is missing color channels.');
    // Color mode data, image resources.
    r.skip(r.u32());
    r.skip(r.u32());
    // Layer and mask information: only used to learn whether the composite has transparency.
    const layerSectionLength = psb ? r.u64() : r.u32();
    const layerSectionEnd = r.offset + layerSectionLength;
    let mergedAlpha = false;
    if (layerSectionLength >= 4) {
      const layerInfoLength = psb ? r.u64() : r.u32();
      if (layerInfoLength >= 2) mergedAlpha = r.i16() < 0;
    }
    r.seek(layerSectionEnd);
    const compression = r.u16();
    const bytesPerSample = depth / 8;
    const rowBytes = width * bytesPerSample;
    const planeBytes = rowBytes * height;
    const readChannels = Math.min(channels, colorChannels + (mergedAlpha ? 1 : 0));
    const planes = [];
    if (compression === 0) {
      for (let c = 0; c < readChannels; c += 1) planes.push(r.bytes(planeBytes));
    } else if (compression === 1) {
      const countBytes = psb ? 4 : 2;
      if (channels * height * countBytes > r.remaining())
        throw new Error('This PSD file is truncated (run-length counts).');
      const counts = new Uint32Array(channels * height);
      for (let i = 0; i < counts.length; i += 1) counts[i] = psb ? r.u32() : r.u16();
      const minRow = 2 * Math.ceil(rowBytes / 128);
      let packedTotal = 0;
      for (let i = 0; i < readChannels * height; i += 1) {
        if (counts[i] < minRow) throw new Error('PSD run-length data is corrupt.');
        packedTotal += counts[i];
      }
      if (packedTotal > r.remaining()) throw new Error('This PSD file is truncated.');
      for (let c = 0; c < readChannels; c += 1) {
        const plane = new Uint8Array(planeBytes);
        for (let y = 0; y < height; y += 1) {
          const packed = r.bytes(counts[c * height + y]);
          unpackBits(packed, plane, y * rowBytes, rowBytes);
        }
        planes.push(plane);
      }
    } else
      throw new Error(
        'This PSD uses ZIP-compressed image data, which is not supported. Re-save with Maximize Compatibility.',
      );
    const data = new Uint8ClampedArray(width * height * 4);
    const sample = (plane, i) => (bytesPerSample === 1 ? plane[i] : plane[i * 2]);
    for (let i = 0; i < width * height; i += 1) {
      const o = i * 4;
      if (colorChannels === 3) {
        data[o] = sample(planes[0], i);
        data[o + 1] = sample(planes[1], i);
        data[o + 2] = sample(planes[2], i);
      } else {
        const v = sample(planes[0], i);
        data[o] = v;
        data[o + 1] = v;
        data[o + 2] = v;
      }
      data[o + 3] = mergedAlpha && planes[colorChannels] ? sample(planes[colorChannels], i) : 255;
    }
    // Merged transparency is stored matted against white; undo the matte.
    if (mergedAlpha) {
      for (let o = 0; o < data.length; o += 4) {
        const a = data[o + 3];
        if (a === 0 || a === 255) continue;
        const k = 255 / a;
        data[o] = Math.round((data[o] - 255) * k + 255);
        data[o + 1] = Math.round((data[o + 1] - 255) * k + 255);
        data[o + 2] = Math.round((data[o + 2] - 255) * k + 255);
      }
    }
    return {
      width,
      height,
      data,
      depth,
      mode: mode === 3 ? 'rgb' : 'grayscale',
      transparent: mergedAlpha,
      psb,
    };
  }

  // Build a minimal PSD (8-bit RGB, RLE or raw). Used by tests.
  function encodeTestPsd({ width, height, pixels, rle = true, alpha = false }) {
    const channels = alpha ? 4 : 3;
    const parts = [];
    const u16 = (v) => [(v >> 8) & 255, v & 255];
    const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    parts.push(
      ...[0x38, 0x42, 0x50, 0x53],
      ...u16(1),
      0,
      0,
      0,
      0,
      0,
      0,
      ...u16(channels),
      ...u32(height),
      ...u32(width),
      ...u16(8),
      ...u16(3),
    );
    parts.push(...u32(0), ...u32(0));
    if (alpha) parts.push(...u32(6), ...u32(2), ...u16(0xffff));
    else parts.push(...u32(0));
    parts.push(...u16(rle ? 1 : 0));
    const plane = (c) => Array.from({ length: width * height }, (_, i) => pixels[i * 4 + c]);
    if (!rle) {
      for (let c = 0; c < channels; c += 1) parts.push(...plane(c));
      return new Uint8Array(parts);
    }
    const rows = [];
    for (let c = 0; c < channels; c += 1) {
      const p = plane(c);
      for (let y = 0; y < height; y += 1) {
        const row = p.slice(y * width, (y + 1) * width);
        const packed = [];
        let i = 0;
        while (i < row.length) {
          let run = 1;
          while (i + run < row.length && row[i + run] === row[i] && run < 128) run += 1;
          if (run > 1) {
            packed.push(257 - run, row[i]);
            i += run;
          } else {
            let lit = 1;
            while (i + lit < row.length && lit < 128 && row[i + lit] !== row[i + lit - 1]) lit += 1;
            packed.push(lit - 1, ...row.slice(i, i + lit));
            i += lit;
          }
        }
        rows.push(packed);
      }
    }
    for (let c = 0; c < channels; c += 1)
      for (let y = 0; y < height; y += 1) parts.push(...u16(rows[c * height + y].length));
    for (const row of rows) parts.push(...row);
    return new Uint8Array(parts);
  }

  return Object.freeze({ MAX_PIXELS, isPsd, decodePsd, unpackBits, encodeTestPsd });
});
