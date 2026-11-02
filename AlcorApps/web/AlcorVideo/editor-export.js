/* alcor-video-mp4-core */
(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AlcorVideoMp4 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // A small ISO-BMFF (MP4) writer for WebCodecs output: one H.264 video track and
  // one AAC or Opus audio track, sample tables for every sample, and the movie box
  // written before the media data ("fast start") so players can begin at once.
  // It never allocates one big buffer: finalize() returns the file as parts that
  // go straight into a Blob.

  const MAX_SAMPLES = 2000000;

  function u8(values) {
    return Uint8Array.from(values);
  }

  function u16(value) {
    return u8([(value >>> 8) & 255, value & 255]);
  }

  function u32(value) {
    const v = value >>> 0;
    return u8([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
  }

  function i32(value) {
    return u32(value | 0);
  }

  function u64(value) {
    const high = Math.floor(value / 4294967296);
    const low = value - high * 4294967296;
    return concat([u32(high), u32(low)]);
  }

  function ascii(text) {
    const out = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) out[index] = text.charCodeAt(index) & 255;
    return out;
  }

  function concat(parts) {
    let length = 0;
    for (const part of parts) length += part.length;
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  function box(type, ...payload) {
    const body = concat(payload.flat());
    return concat([u32(body.length + 8), ascii(type), body]);
  }

  function fullBox(type, version, flags, ...payload) {
    return box(
      type,
      u8([version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255]),
      ...payload,
    );
  }

  function fixed16(value) {
    return u32(Math.round(value * 65536));
  }

  const MATRIX = concat([
    fixed16(1),
    fixed16(0),
    u32(0),
    fixed16(0),
    fixed16(1),
    u32(0),
    u32(0),
    u32(0),
    u32(0x40000000),
  ]);

  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data))
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new Error('MP4 sample data must be bytes.');
  }

  // Run-length encode an array of numbers into [count, value] pairs.
  function runs(values) {
    const out = [];
    for (const value of values) {
      const last = out[out.length - 1];
      if (last && last[1] === value) last[0] += 1;
      else out.push([1, value]);
    }
    return out;
  }

  function descriptor(tag, payload) {
    // MPEG-4 descriptors use a variable-length size; four bytes always fit.
    const size = payload.length;
    return concat([
      u8([
        tag,
        0x80 | ((size >>> 21) & 127),
        0x80 | ((size >>> 14) & 127),
        0x80 | ((size >>> 7) & 127),
        size & 127,
      ]),
      payload,
    ]);
  }

  function esds(config, bitrate) {
    const specific = descriptor(0x05, config);
    const decoderConfig = descriptor(
      0x04,
      concat([u8([0x40, 0x15, 0, 0, 0]), u32(bitrate), u32(bitrate), specific]),
    );
    const sl = descriptor(0x06, u8([0x02]));
    const es = descriptor(0x03, concat([u16(1), u8([0]), decoderConfig, sl]));
    return fullBox('esds', 0, 0, es);
  }

  // AudioSpecificConfig for AAC-LC when the encoder did not supply one.
  function aacConfig(sampleRate, channels) {
    const rates = [
      96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
    ];
    const index = rates.indexOf(sampleRate);
    if (index < 0) throw new Error(`AAC sample rate ${sampleRate} Hz is not supported.`);
    const objectType = 2;
    return u8([(objectType << 3) | (index >>> 1), ((index & 1) << 7) | (channels << 3)]);
  }

  function opusSpecific(sampleRate, channels, description) {
    let preSkip = 312;
    let gain = 0;
    const head = description ? toBytes(description) : null;
    // OpusHead: "OpusHead", version, channels, pre-skip (LE), rate (LE), gain (LE), family.
    if (head && head.length >= 19 && String.fromCharCode(...head.slice(0, 8)) === 'OpusHead') {
      preSkip = head[10] | (head[11] << 8);
      gain = ((head[16] | (head[17] << 8)) << 16) >> 16;
    }
    return box(
      'dOps',
      u8([0, channels]),
      u16(preSkip),
      u32(sampleRate),
      u16(gain & 0xffff),
      u8([0]),
    );
  }

  function createMuxer(options = {}) {
    const video = options.video || null;
    const audio = options.audio || null;
    if (!video && !audio) throw new Error('An MP4 needs a video or an audio track.');
    if (video && !(video.width > 0 && video.height > 0))
      throw new Error('Video track needs a width and height.');
    if (audio && !(audio.sampleRate > 0 && audio.channels > 0))
      throw new Error('Audio track needs a sample rate and channel count.');
    const tracks = [];
    if (video)
      tracks.push({
        kind: 'video',
        config: video,
        timescale: Math.round(video.timescale || 90000),
        samples: [],
      });
    if (audio)
      tracks.push({
        kind: 'audio',
        config: audio,
        timescale: Math.round(audio.sampleRate),
        samples: [],
      });
    const chunks = [];
    let mediaBytes = 0;
    let finalized = false;

    function add(kind, chunk) {
      if (finalized) throw new Error('This MP4 has already been finalized.');
      const track = tracks.find((item) => item.kind === kind);
      if (!track) throw new Error(`This MP4 has no ${kind} track.`);
      if (track.samples.length >= MAX_SAMPLES)
        throw new Error('Too many samples for one MP4 track.');
      const data = toBytes(chunk.data);
      if (!data.length) throw new Error('Empty MP4 sample.');
      const timestamp = Number(chunk.timestamp) || 0;
      const duration = Math.max(0, Number(chunk.duration) || 0);
      if (!Number.isFinite(timestamp) || !Number.isFinite(duration))
        throw new Error('MP4 sample times must be finite.');
      track.samples.push({
        size: data.length,
        pts: Math.round((timestamp * track.timescale) / 1e6),
        duration: Math.round((duration * track.timescale) / 1e6),
        key: kind === 'audio' ? true : Boolean(chunk.key),
        offset: mediaBytes,
      });
      chunks.push(data);
      mediaBytes += data.length;
    }

    function sampleEntry(track) {
      if (track.kind === 'video') {
        const c = track.config;
        if (!c.description) throw new Error('H.264 needs its avcC decoder description.');
        return box(
          'avc1',
          new Uint8Array(6),
          u16(1),
          new Uint8Array(16),
          u16(c.width),
          u16(c.height),
          u32(0x00480000),
          u32(0x00480000),
          u32(0),
          u16(1),
          new Uint8Array(32),
          u16(0x18),
          u16(0xffff),
          box('avcC', toBytes(c.description)),
          box('pasp', u32(1), u32(1)),
        );
      }
      const c = track.config;
      const codec = String(c.codec || 'mp4a.40.2');
      const header = [
        new Uint8Array(6),
        u16(1),
        new Uint8Array(8),
        u16(c.channels),
        u16(16),
        u16(0),
        u16(0),
        u32(((c.sampleRate & 0xffff) << 16) >>> 0),
      ];
      if (codec.toLowerCase() === 'opus')
        return box('Opus', ...header, opusSpecific(c.sampleRate, c.channels, c.description));
      const config = c.description ? toBytes(c.description) : aacConfig(c.sampleRate, c.channels);
      return box('mp4a', ...header, esds(config, Math.round(c.bitrate || 192000)));
    }

    // Decode order is arrival order. If presentation times reorder (B-frames),
    // decode times are the sorted presentation times and ctts carries the offset.
    function timing(track) {
      const samples = track.samples;
      let origin = samples.length ? samples[0].pts : 0;
      for (const sample of samples) if (sample.pts < origin) origin = sample.pts;
      const pts = samples.map((sample) => sample.pts - origin);
      const sorted = pts.slice().sort((a, b) => a - b);
      const dts = sorted;
      const durations = samples.map((sample, index) => {
        if (index + 1 < samples.length) return Math.max(0, dts[index + 1] - dts[index]);
        return Math.max(1, sample.duration || (index ? dts[index] - dts[index - 1] : 1));
      });
      const offsets = pts.map((value, index) => value - dts[index]);
      const reordered = offsets.some((value) => value !== 0);
      const total = samples.length ? dts[dts.length - 1] + durations[durations.length - 1] : 0;
      return { durations, offsets, reordered, total };
    }

    function trak(track, id, movieTimescale, chunkBase, useCo64) {
      const t = timing(track);
      const samples = track.samples;
      const durationMovie = Math.round((t.total * movieTimescale) / track.timescale);
      const video = track.kind === 'video';
      const tkhd = fullBox(
        'tkhd',
        0,
        3,
        u32(0),
        u32(0),
        u32(id),
        u32(0),
        u32(durationMovie),
        new Uint8Array(8),
        u16(0),
        u16(0),
        u16(video ? 0 : 0x0100),
        u16(0),
        MATRIX,
        fixed16(video ? track.config.width : 0),
        fixed16(video ? track.config.height : 0),
      );
      const mdhd = fullBox(
        'mdhd',
        0,
        0,
        u32(0),
        u32(0),
        u32(track.timescale),
        u32(t.total),
        u16(0x55c4),
        u16(0),
      );
      const hdlr = fullBox(
        'hdlr',
        0,
        0,
        u32(0),
        ascii(video ? 'vide' : 'soun'),
        new Uint8Array(12),
        ascii(video ? 'AlcorVideo video\0' : 'AlcorVideo audio\0'),
      );
      const header = video
        ? fullBox('vmhd', 0, 1, new Uint8Array(8))
        : fullBox('smhd', 0, 0, u16(0), u16(0));
      const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
      const stsd = fullBox('stsd', 0, 0, u32(1), sampleEntry(track));
      const sttsRuns = runs(t.durations);
      const stts = fullBox(
        'stts',
        0,
        0,
        u32(sttsRuns.length),
        ...sttsRuns.map(([count, value]) => concat([u32(count), u32(value)])),
      );
      const parts = [stsd, stts];
      if (t.reordered) {
        const cttsRuns = runs(t.offsets);
        parts.push(
          fullBox(
            'ctts',
            1,
            0,
            u32(cttsRuns.length),
            ...cttsRuns.map(([count, value]) => concat([u32(count), i32(value)])),
          ),
        );
      }
      if (video && samples.some((sample) => !sample.key)) {
        const keys = [];
        samples.forEach((sample, index) => {
          if (sample.key) keys.push(index + 1);
        });
        parts.push(fullBox('stss', 0, 0, u32(keys.length), ...keys.map((value) => u32(value))));
      }
      parts.push(fullBox('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1)));
      parts.push(
        fullBox(
          'stsz',
          0,
          0,
          u32(0),
          u32(samples.length),
          ...samples.map((sample) => u32(sample.size)),
        ),
      );
      if (useCo64)
        parts.push(
          fullBox(
            'co64',
            0,
            0,
            u32(samples.length),
            ...samples.map((sample) => u64(chunkBase + sample.offset)),
          ),
        );
      else
        parts.push(
          fullBox(
            'stco',
            0,
            0,
            u32(samples.length),
            ...samples.map((sample) => u32(chunkBase + sample.offset)),
          ),
        );
      const stbl = box('stbl', ...parts);
      const minf = box('minf', header, dinf, stbl);
      return { box: box('trak', tkhd, box('mdia', mdhd, hdlr, minf)), durationMovie };
    }

    function moov(chunkBase, useCo64) {
      const movieTimescale = 1000;
      const traks = tracks.map((track, index) =>
        trak(track, index + 1, movieTimescale, chunkBase, useCo64),
      );
      const duration = Math.max(0, ...traks.map((item) => item.durationMovie));
      const mvhd = fullBox(
        'mvhd',
        0,
        0,
        u32(0),
        u32(0),
        u32(movieTimescale),
        u32(duration),
        fixed16(1),
        u16(0x0100),
        new Uint8Array(10),
        MATRIX,
        new Uint8Array(24),
        u32(tracks.length + 1),
      );
      return box('moov', mvhd, ...traks.map((item) => item.box));
    }

    return {
      addVideoChunk(chunk) {
        add('video', chunk);
      },
      addAudioChunk(chunk) {
        add('audio', chunk);
      },
      get sampleCount() {
        return tracks.reduce((sum, track) => sum + track.samples.length, 0);
      },
      get mediaBytes() {
        return mediaBytes;
      },
      finalize() {
        if (finalized) throw new Error('This MP4 has already been finalized.');
        for (const track of tracks)
          if (!track.samples.length) throw new Error(`The ${track.kind} track has no samples.`);
        finalized = true;
        const ftyp = box(
          'ftyp',
          ascii('isom'),
          u32(0x200),
          ascii('isom'),
          ascii('iso2'),
          ascii('avc1'),
          ascii('mp41'),
        );
        const large = mediaBytes + 16 > 0xffffffff;
        const mdatHeader = large
          ? concat([u32(1), ascii('mdat'), u64(mediaBytes + 16)])
          : concat([u32(mediaBytes + 8), ascii('mdat')]);
        // The movie box size does not depend on the offsets' values, only on their width.
        let useCo64 = false;
        let movie = moov(0, false);
        let base = ftyp.length + movie.length + mdatHeader.length;
        if (base + mediaBytes > 0xffffffff) {
          useCo64 = true;
          movie = moov(0, true);
          base = ftyp.length + movie.length + mdatHeader.length;
        }
        movie = moov(base, useCo64);
        const parts = [ftyp, movie, mdatHeader, ...chunks];
        chunks.length = 0;
        return {
          parts,
          size: base + mediaBytes,
          mimeType: audio && !video ? 'audio/mp4' : 'video/mp4',
        };
      },
    };
  }

  return Object.freeze({ MAX_SAMPLES, aacConfig, createMuxer });
});

/* alcor-video-formats-core */
(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AlcorVideoFormats = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Export file writers that need no browser encoder of their own: animated GIF
  // (median-cut palette + LZW), stored ZIP archives (CRC-32), PCM WAV, a WebM
  // (Matroska) muxer for WebCodecs VP8/VP9 + Opus chunks, and WebVTT captions.
  // Everything is pure byte work; nothing here touches the network or the DOM.

  const LIMITS = Object.freeze({
    gifMaxSeconds: 15,
    gifMaxFps: 15,
    gifMaxWidth: 640,
    zipMaxEntries: 9000,
    zipMaxBytes: 2 ** 31,
  });

  function concat(parts) {
    let length = 0;
    for (const part of parts) length += part.length;
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
  const utf8 = (text) =>
    typeof TextEncoder === 'function'
      ? new TextEncoder().encode(String(text))
      : Uint8Array.from(Buffer.from(String(text), 'utf8'));
  const u16le = (v) => Uint8Array.of(v & 255, (v >>> 8) & 255);
  const u32le = (v) => Uint8Array.of(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);

  // ------------------------------------------------------------- CRC-32 / ZIP

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes, previous = 0) {
    let crc = (previous ^ 0xffffffff) >>> 0;
    for (let index = 0; index < bytes.length; index += 1)
      crc = CRC_TABLE[(crc ^ bytes[index]) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(date = new Date(Date.UTC(2026, 0, 1))) {
    const time =
      (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
    const day =
      ((Math.max(1980, date.getUTCFullYear()) - 1980) << 9) |
      ((date.getUTCMonth() + 1) << 5) |
      date.getUTCDate();
    return { time, day };
  }

  // A ZIP writer that stores entries uncompressed (images are compressed already).
  function createZip() {
    const parts = [];
    const central = [];
    let offset = 0;
    const { time, day } = dosDateTime();
    return {
      add(name, data) {
        if (central.length >= LIMITS.zipMaxEntries)
          throw new Error('Too many files for one ZIP archive.');
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        const nameBytes = utf8(String(name).replace(/^\/+/, '').replace(/\\/g, '/'));
        if (offset + bytes.length + nameBytes.length + 30 > LIMITS.zipMaxBytes)
          throw new Error('The archive would exceed 2 GB.');
        const crc = crc32(bytes);
        const header = concat([
          u32le(0x04034b50),
          u16le(20),
          u16le(0x0800),
          u16le(0),
          u16le(time),
          u16le(day),
          u32le(crc),
          u32le(bytes.length),
          u32le(bytes.length),
          u16le(nameBytes.length),
          u16le(0),
          nameBytes,
        ]);
        central.push(
          concat([
            u32le(0x02014b50),
            u16le(20),
            u16le(20),
            u16le(0x0800),
            u16le(0),
            u16le(time),
            u16le(day),
            u32le(crc),
            u32le(bytes.length),
            u32le(bytes.length),
            u16le(nameBytes.length),
            u16le(0),
            u16le(0),
            u16le(0),
            u16le(0),
            u32le(0),
            u32le(offset),
            nameBytes,
          ]),
        );
        parts.push(header, bytes);
        offset += header.length + bytes.length;
      },
      get count() {
        return central.length;
      },
      finish() {
        const directory = concat(central);
        const end = concat([
          u32le(0x06054b50),
          u16le(0),
          u16le(0),
          u16le(central.length),
          u16le(central.length),
          u32le(directory.length),
          u32le(offset),
          u16le(0),
        ]);
        return parts.concat([directory, end]);
      },
    };
  }

  // Minimal stored-ZIP reader (for tests and self-checks): returns [{ name, data, crcOk }].
  function readStoredZip(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let at = bytes.length - 22; at >= 0; at -= 1)
      if (view.getUint32(at, true) === 0x06054b50) {
        end = at;
        break;
      }
    if (end < 0) throw new Error('No ZIP end record.');
    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    const out = [];
    for (let index = 0; index < count; index += 1) {
      if (view.getUint32(at, true) !== 0x02014b50) throw new Error('Bad ZIP directory.');
      const crc = view.getUint32(at + 16, true);
      const size = view.getUint32(at + 20, true);
      const nameLength = view.getUint16(at + 28, true);
      const extra = view.getUint16(at + 30, true);
      const comment = view.getUint16(at + 32, true);
      const local = view.getUint32(at + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
      const localName = view.getUint16(local + 26, true);
      const localExtra = view.getUint16(local + 28, true);
      const data = bytes.subarray(
        local + 30 + localName + localExtra,
        local + 30 + localName + localExtra + size,
      );
      out.push({ name, data, crcOk: crc32(data) === crc });
      at += 46 + nameLength + extra + comment;
    }
    return out;
  }

  // -------------------------------------------------------------------- WAV

  function encodeWav(channels, sampleRate, bitsPerSample = 16) {
    const count = channels.length;
    const length = count ? channels[0].length : 0;
    const bytesPerSample = bitsPerSample / 8;
    const dataBytes = length * count * bytesPerSample;
    const out = new Uint8Array(44 + dataBytes);
    const view = new DataView(out.buffer);
    const ascii = (at, text) => {
      for (let index = 0; index < text.length; index += 1) out[at + index] = text.charCodeAt(index);
    };
    ascii(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, count, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * count * bytesPerSample, true);
    view.setUint16(32, count * bytesPerSample, true);
    view.setUint16(34, bitsPerSample, true);
    ascii(36, 'data');
    view.setUint32(40, dataBytes, true);
    let at = 44;
    for (let index = 0; index < length; index += 1) {
      for (let channel = 0; channel < count; channel += 1) {
        const sample = Math.max(-1, Math.min(1, channels[channel][index] || 0));
        if (bitsPerSample === 16) {
          view.setInt16(
            at,
            sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767),
            true,
          );
          at += 2;
        } else {
          view.setUint8(at, Math.round((sample + 1) * 127.5));
          at += 1;
        }
      }
    }
    return out;
  }

  function decodeWav(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const text = (at, n) => String.fromCharCode(...bytes.subarray(at, at + n));
    if (text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE') throw new Error('Not a WAV file.');
    let at = 12;
    let format = null;
    let data = null;
    while (at + 8 <= bytes.length) {
      const id = text(at, 4);
      const size = view.getUint32(at + 4, true);
      if (id === 'fmt ')
        format = {
          channels: view.getUint16(at + 10, true),
          sampleRate: view.getUint32(at + 12, true),
          bits: view.getUint16(at + 22, true),
        };
      if (id === 'data') data = { at: at + 8, size };
      at += 8 + size + (size % 2);
    }
    if (!format || !data || format.bits !== 16) throw new Error('Unsupported WAV.');
    const frames = Math.floor(data.size / (2 * format.channels));
    const channels = Array.from({ length: format.channels }, () => new Float32Array(frames));
    for (let index = 0; index < frames; index += 1) {
      for (let channel = 0; channel < format.channels; channel += 1)
        channels[channel][index] =
          view.getInt16(data.at + (index * format.channels + channel) * 2, true) / 32768;
    }
    return { sampleRate: format.sampleRate, channels };
  }

  // -------------------------------------------------------------------- GIF

  // Median-cut palette over a 15-bit color histogram of RGBA pixels.
  function quantize(rgba, maxColors = 256) {
    const histogram = new Uint32Array(32768);
    // Exact color sums per bucket, so palette entries are true averages of their pixels.
    const sums = new Float64Array(32768 * 3);
    for (let index = 0; index < rgba.length; index += 4) {
      const key =
        ((rgba[index] >> 3) << 10) | ((rgba[index + 1] >> 3) << 5) | (rgba[index + 2] >> 3);
      histogram[key] += 1;
      sums[key * 3] += rgba[index];
      sums[key * 3 + 1] += rgba[index + 1];
      sums[key * 3 + 2] += rgba[index + 2];
    }
    const colors = [];
    for (let key = 0; key < 32768; key += 1) if (histogram[key]) colors.push(key);
    const channel = (key, c) => (key >> (10 - 5 * c)) & 31;
    let boxes = [{ colors, count: colors.reduce((sum, key) => sum + histogram[key], 0) }];
    while (boxes.length < maxColors) {
      // Split the box with the most pixels that still has more than one color.
      let target = -1;
      for (let index = 0; index < boxes.length; index += 1)
        if (
          boxes[index].colors.length > 1 &&
          (target < 0 || boxes[index].count > boxes[target].count)
        )
          target = index;
      if (target < 0) break;
      const box = boxes[target];
      const ranges = [0, 1, 2].map((c) => {
        let lo = 31;
        let hi = 0;
        for (const key of box.colors) {
          const v = channel(key, c);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        return hi - lo;
      });
      const axis = ranges.indexOf(Math.max(...ranges));
      box.colors.sort((a, b) => channel(a, axis) - channel(b, axis));
      let half = 0;
      let cut = 0;
      for (; cut < box.colors.length - 1; cut += 1) {
        half += histogram[box.colors[cut]];
        if (half * 2 >= box.count) break;
      }
      const left = box.colors.slice(0, cut + 1);
      const right = box.colors.slice(cut + 1);
      const sum = (list) => list.reduce((total, key) => total + histogram[key], 0);
      boxes.splice(
        target,
        1,
        { colors: left, count: sum(left) },
        { colors: right, count: sum(right) },
      );
    }
    const palette = new Uint8Array(maxColors * 3);
    boxes.forEach((box, index) => {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (const key of box.colors) {
        r += sums[key * 3];
        g += sums[key * 3 + 1];
        b += sums[key * 3 + 2];
        n += histogram[key];
      }
      n = Math.max(1, n);
      palette[index * 3] = Math.round(r / n);
      palette[index * 3 + 1] = Math.round(g / n);
      palette[index * 3 + 2] = Math.round(b / n);
    });
    return { palette, size: Math.max(1, boxes.length) };
  }

  function mapToPalette(rgba, quantized) {
    const { palette, size } = quantized;
    const cache = new Int16Array(32768).fill(-1);
    const indices = new Uint8Array(rgba.length / 4);
    for (let pixel = 0, index = 0; index < rgba.length; index += 4, pixel += 1) {
      const key =
        ((rgba[index] >> 3) << 10) | ((rgba[index + 1] >> 3) << 5) | (rgba[index + 2] >> 3);
      let found = cache[key];
      if (found < 0) {
        let best = 0;
        let bestDistance = Infinity;
        const r = rgba[index];
        const g = rgba[index + 1];
        const b = rgba[index + 2];
        for (let entry = 0; entry < size; entry += 1) {
          const dr = r - palette[entry * 3];
          const dg = g - palette[entry * 3 + 1];
          const db = b - palette[entry * 3 + 2];
          const distance = dr * dr * 2 + dg * dg * 4 + db * db * 3;
          if (distance < bestDistance) {
            bestDistance = distance;
            best = entry;
          }
        }
        cache[key] = found = best;
      }
      indices[pixel] = found;
    }
    return indices;
  }

  // GIF LZW (variable code size, 8-bit minimum code size), packed LSB first.
  function lzwEncode(indices, minCodeSize = 8) {
    const clear = 1 << minCodeSize;
    const end = clear + 1;
    const out = [];
    let bitBuffer = 0;
    let bitCount = 0;
    let codeSize = minCodeSize + 1;
    let next = end + 1;
    const table = new Int32Array(1 << 20);
    let generation = 1;
    const emit = (code) => {
      bitBuffer |= code << bitCount;
      bitCount += codeSize;
      while (bitCount >= 8) {
        out.push(bitBuffer & 255);
        bitBuffer >>>= 8;
        bitCount -= 8;
      }
    };
    emit(clear);
    if (!indices.length) {
      emit(end);
      if (bitCount) out.push(bitBuffer & 255);
      return Uint8Array.from(out);
    }
    let prefix = indices[0];
    for (let index = 1; index < indices.length; index += 1) {
      const symbol = indices[index];
      const key = (prefix << 8) | symbol;
      const entry = table[key];
      if (entry >>> 12 === generation) {
        prefix = entry & 4095;
        continue;
      }
      emit(prefix);
      if (next < 4096) {
        table[key] = (generation << 12) | next;
        next += 1;
        if (next > 1 << codeSize && codeSize < 12) codeSize += 1;
      } else {
        emit(clear);
        generation += 1;
        codeSize = minCodeSize + 1;
        next = end + 1;
      }
      prefix = symbol;
    }
    emit(prefix);
    emit(end);
    if (bitCount) out.push(bitBuffer & 255);
    return Uint8Array.from(out);
  }

  // Reference LZW decoder (tests and self-checks).
  function lzwDecode(data, minCodeSize, pixelCount) {
    const clear = 1 << minCodeSize;
    const end = clear + 1;
    let codeSize = minCodeSize + 1;
    let dictionary = [];
    const reset = () => {
      dictionary = [];
      for (let i = 0; i < clear; i += 1) dictionary[i] = [i];
      dictionary[clear] = [];
      dictionary[end] = [];
      codeSize = minCodeSize + 1;
    };
    reset();
    const out = [];
    let bit = 0;
    let previous = null;
    while (bit + codeSize <= data.length * 8 && out.length < pixelCount) {
      let code = 0;
      for (let i = 0; i < codeSize; i += 1)
        code |= ((data[(bit + i) >> 3] >> ((bit + i) & 7)) & 1) << i;
      bit += codeSize;
      if (code === clear) {
        reset();
        previous = null;
        continue;
      }
      if (code === end) break;
      let entry;
      if (code < dictionary.length) entry = dictionary[code];
      else entry = previous.concat([previous[0]]);
      out.push(...entry);
      if (previous && dictionary.length < 4096) dictionary.push(previous.concat([entry[0]]));
      if (dictionary.length === 1 << codeSize && codeSize < 12) codeSize += 1;
      previous = entry;
    }
    return Uint8Array.from(out.slice(0, pixelCount));
  }

  function subBlocks(data) {
    const parts = [];
    for (let at = 0; at < data.length; at += 255) {
      const chunk = data.subarray(at, Math.min(data.length, at + 255));
      parts.push(Uint8Array.of(chunk.length), chunk);
    }
    parts.push(Uint8Array.of(0));
    return concat(parts);
  }

  // Streaming animated GIF: each frame gets its own 256-color palette.
  function createGif(width, height, options = {}) {
    const parts = [utf8('GIF89a'), u16le(width), u16le(height), Uint8Array.of(0x70, 0, 0)];
    // NETSCAPE2.0 looping extension (0 = forever).
    parts.push(
      Uint8Array.of(0x21, 0xff, 0x0b),
      utf8('NETSCAPE2.0'),
      Uint8Array.of(0x03, 0x01),
      u16le(options.loop == null ? 0 : options.loop),
      Uint8Array.of(0),
    );
    let elapsed = 0;
    let clock = 0;
    return {
      // rgba: Uint8ClampedArray of width*height*4; durationSeconds sets the frame delay.
      addFrame(rgba, durationSeconds) {
        clock += durationSeconds;
        const delay = Math.max(2, Math.round(clock * 100) - elapsed);
        elapsed += delay;
        const quantized = quantize(rgba, 256);
        const indices = mapToPalette(rgba, quantized);
        parts.push(Uint8Array.of(0x21, 0xf9, 0x04, 0x04), u16le(delay), Uint8Array.of(0, 0));
        parts.push(
          Uint8Array.of(0x2c),
          u16le(0),
          u16le(0),
          u16le(width),
          u16le(height),
          Uint8Array.of(0x87),
          quantized.palette,
        );
        parts.push(Uint8Array.of(8), subBlocks(lzwEncode(indices, 8)));
      },
      finish() {
        parts.push(Uint8Array.of(0x3b));
        return parts;
      },
    };
  }

  // Fit a GIF inside the limits: at most gifMaxWidth wide (even sizes), at most gifMaxFps.
  function gifPlan(width, height, fps, seconds) {
    const scale = Math.min(1, LIMITS.gifMaxWidth / Math.max(1, width));
    const w = Math.max(2, Math.round((width * scale) / 2) * 2);
    const h = Math.max(2, Math.round((height * scale) / 2) * 2);
    const rate = Math.min(LIMITS.gifMaxFps, Math.max(1, fps));
    const duration = Math.min(LIMITS.gifMaxSeconds, Math.max(0, seconds));
    return {
      width: w,
      height: h,
      fps: rate,
      seconds: duration,
      frames: Math.max(1, Math.round(duration * rate)),
      truncated: seconds > LIMITS.gifMaxSeconds + 1e-6,
    };
  }

  // ---------------------------------------------------------------- WebM

  function ebmlId(id) {
    const bytes = [];
    let value = id;
    while (value > 0) {
      bytes.unshift(value & 255);
      value = Math.floor(value / 256);
    }
    return Uint8Array.from(bytes);
  }

  function ebmlSize(size) {
    for (let length = 1; length <= 8; length += 1) {
      if (size < 2 ** (7 * length) - 1) {
        const bytes = new Uint8Array(length);
        let value = size;
        for (let index = length - 1; index >= 0; index -= 1) {
          bytes[index] = value % 256;
          value = Math.floor(value / 256);
        }
        bytes[0] |= 1 << (8 - length);
        return bytes;
      }
    }
    throw new Error('EBML element too large.');
  }

  function element(id, data) {
    return concat([ebmlId(id), ebmlSize(data.length), data]);
  }
  function uint(id, value) {
    const bytes = [];
    let v = Math.max(0, Math.floor(value));
    do {
      bytes.unshift(v % 256);
      v = Math.floor(v / 256);
    } while (v > 0);
    return element(id, Uint8Array.from(bytes));
  }
  function float(id, value) {
    const data = new Uint8Array(8);
    new DataView(data.buffer).setFloat64(0, value);
    return element(id, data);
  }
  function string(id, value) {
    return element(id, utf8(value));
  }
  function master(id, children) {
    return element(id, concat(children));
  }

  function opusHead(channels = 2, sampleRate = 48000, preSkip = 312) {
    return concat([
      utf8('OpusHead'),
      Uint8Array.of(1, channels),
      u16le(preSkip),
      u32le(sampleRate),
      u16le(0),
      Uint8Array.of(0),
    ]);
  }

  // WebM muxer for encoded chunks ({ data, timestamp (us), key }).
  // video: { codec: 'vp8'|'vp9', width, height }; audio: { sampleRate, channels, description }.
  function createWebmMuxer(options = {}) {
    const video = options.video || null;
    const audio = options.audio || null;
    const blocks = [];
    return {
      addVideoChunk(chunk) {
        blocks.push({
          track: 1,
          time: Math.round(chunk.timestamp / 1000),
          key: chunk.key !== false,
          data: chunk.data,
        });
      },
      addAudioChunk(chunk) {
        blocks.push({
          track: 2,
          time: Math.round(chunk.timestamp / 1000),
          key: true,
          data: chunk.data,
        });
      },
      finalize(durationMs) {
        blocks.sort((a, b) => a.time - b.time || a.track - b.track);
        const tracks = [];
        if (video) {
          tracks.push(
            master(0xae, [
              uint(0xd7, 1),
              uint(0x73c5, 1),
              uint(0x83, 1),
              uint(0x9c, 0),
              string(
                0x86,
                String(video.codec).startsWith('vp09') || video.codec === 'vp9' ? 'V_VP9' : 'V_VP8',
              ),
              master(0xe0, [uint(0xb0, video.width), uint(0xba, video.height)]),
            ]),
          );
        }
        if (audio) {
          const head =
            audio.description && audio.description.byteLength >= 19
              ? new Uint8Array(
                  audio.description.buffer
                    ? audio.description.buffer.slice(
                        audio.description.byteOffset || 0,
                        (audio.description.byteOffset || 0) + audio.description.byteLength,
                      )
                    : audio.description,
                )
              : opusHead(audio.channels || 2, audio.sampleRate || 48000);
          tracks.push(
            master(0xae, [
              uint(0xd7, 2),
              uint(0x73c5, 2),
              uint(0x83, 2),
              uint(0x9c, 0),
              string(0x86, 'A_OPUS'),
              element(0x63a2, head),
              uint(0x56bb, 80000000),
              master(0xe1, [
                float(0xb5, audio.sampleRate || 48000),
                uint(0x9f, audio.channels || 2),
              ]),
            ]),
          );
        }
        const end = blocks.length ? blocks[blocks.length - 1].time : 0;
        const info = master(0x1549a966, [
          uint(0x2ad7b1, 1000000),
          string(0x4d80, 'AlcorVideo'),
          string(0x5741, 'AlcorVideo'),
          float(0x4489, Math.max(durationMs || 0, end)),
        ]);
        const trackBox = master(0x1654ae6b, tracks);
        // Frame data is never copied: clusters are lists of parts (id, size, small headers
        // and the encoder's own chunk arrays) for a Blob, sized explicitly.
        const sizeOf = (parts) => parts.reduce((sum, part) => sum + part.length, 0);
        // Clusters start at each video keyframe (or every 5 s) so players can seek.
        const clusters = [];
        let current = null;
        for (const block of blocks) {
          const startNew =
            !current ||
            (block.track === 1 && block.key && video) ||
            block.time - current.time > 5000 ||
            (!video && block.time - current.time > 2000);
          if (startNew) {
            current = { time: block.time, parts: [uint(0xe7, block.time)] };
            clusters.push(current);
          }
          const data = block.data instanceof Uint8Array ? block.data : new Uint8Array(block.data);
          const relative = block.time - current.time;
          current.parts.push(
            ebmlId(0xa3),
            ebmlSize(4 + data.length),
            Uint8Array.of(
              0x80 | block.track,
              (relative >> 8) & 255,
              relative & 255,
              block.key ? 0x80 : 0,
            ),
            data,
          );
        }
        const clusterParts = clusters.map((cluster) => {
          const size = sizeOf(cluster.parts);
          return [ebmlId(0x1f43b675), ebmlSize(size), ...cluster.parts];
        });
        const clusterSizes = clusterParts.map(sizeOf);
        // Layout: SeekHead, Info, Tracks, Clusters, Cues. Positions are relative to the segment payload.
        const seekEntry = (id, position) =>
          master(0x4dbb, [element(0x53ab, ebmlId(id)), uint(0x53ac, position)]);
        const buildSeek = (positions) =>
          master(0x114d9b74, [
            seekEntry(0x1549a966, positions.info),
            seekEntry(0x1654ae6b, positions.tracks),
            seekEntry(0x1c53bb6b, positions.cues),
          ]);
        let positions = { info: 0, tracks: 0, cues: 0 };
        let seek = buildSeek(positions);
        let cues;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          positions.info = seek.length;
          positions.tracks = positions.info + info.length;
          let clusterAt = positions.tracks + trackBox.length;
          const points = [];
          clusters.forEach((cluster, index) => {
            points.push(
              master(0xbb, [
                uint(0xb3, cluster.time),
                master(0xb7, [uint(0xf7, video ? 1 : 2), uint(0xf1, clusterAt)]),
              ]),
            );
            clusterAt += clusterSizes[index];
          });
          cues = master(0x1c53bb6b, points);
          positions.cues = clusterAt;
          const next = buildSeek(positions);
          if (next.length === seek.length) {
            seek = next;
            break;
          }
          seek = next;
        }
        const header = master(0x1a45dfa3, [
          uint(0x4286, 1),
          uint(0x42f7, 1),
          uint(0x42f2, 4),
          uint(0x42f3, 8),
          string(0x4282, 'webm'),
          uint(0x4287, 4),
          uint(0x4285, 2),
        ]);
        const body = [seek, info, trackBox, ...clusterParts.flat(), cues];
        return [header, ebmlId(0x18538067), ebmlSize(sizeOf(body)), ...body];
      },
    };
  }

  // ---------------------------------------------------------------- captions

  function vttTime(seconds) {
    const ms = Math.max(0, Math.round(Number(seconds) * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor(ms / 60000) % 60;
    const s = Math.floor(ms / 1000) % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  }

  // Cue payload: one block (no blank or whitespace-only lines, any line ending), no "-->"
  // that could start a new cue, and & < > escaped as WebVTT requires.
  function vttText(value) {
    let text = String(value)
      .replace(/\r\n?/g, '\n')
      .replace(/\n[ \t]*(?:\n[ \t]*)+/g, '\n')
      .trim();
    for (let previous = ''; previous !== text; ) {
      previous = text;
      text = text.replace(/-{2,}>/g, '->');
    }
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function serializeVtt(cues) {
    const lines = ['WEBVTT', ''];
    (cues || [])
      .filter((cue) => cue && cue.end > cue.start && String(cue.text || '').trim())
      .sort((a, b) => a.start - b.start)
      .forEach((cue, index) => {
        lines.push(
          String(index + 1),
          `${vttTime(cue.start)} --> ${vttTime(cue.end)}`,
          vttText(cue.text),
          '',
        );
      });
    return lines.join('\n');
  }

  // Platform export presets the dialog adds on top of the editor's size presets. `value` is
  // the editor preset whose width and height the export uses; `fps` (when set) is the frame
  // rate the offline WebM, GIF and image-sequence writers honour.
  const PLATFORM_PRESETS = Object.freeze([
    Object.freeze({
      id: 'youtube-1080p',
      value: '1080p',
      label: 'YouTube 1080p · 1920×1080',
      width: 1920,
      height: 1080,
      fps: 0,
    }),
    Object.freeze({
      id: 'tiktok-reels',
      value: 'vertical',
      label: 'TikTok / Reels 9:16 · 1080×1920 · 30 fps',
      width: 1080,
      height: 1920,
      fps: 30,
    }),
  ]);

  // Export dialog wording: the offline WebM is the default; the real-time recording is the fallback.
  const FORMAT_LABELS = Object.freeze({
    'webm-fast': 'WebM (fast) · VP9/VP8 + Opus, offline, seekable',
    webm: 'WebM (real time) · no seeking, use WebM (fast)',
  });
  const REALTIME_WEBM_WARNING =
    'WebM (real time) records the sequence as it plays: the file has no duration or seeking, and it takes as long as the sequence. Use WebM (fast) unless that option is unavailable.';

  return Object.freeze({
    LIMITS,
    FORMAT_LABELS,
    PLATFORM_PRESETS,
    REALTIME_WEBM_WARNING,
    concat,
    crc32,
    createGif,
    createWebmMuxer,
    createZip,
    decodeWav,
    encodeWav,
    gifPlan,
    lzwDecode,
    lzwEncode,
    mapToPalette,
    opusHead,
    quantize,
    readStoredZip,
    serializeVtt,
    vttTime,
  });
});

/* alcor-video-export-formats */
(() => {
  'use strict';

  // Extra export formats: WebM (WebCodecs VP9/VP8 + Opus, offline), animated GIF,
  // PNG still, PNG/JPEG sequences in a ZIP, WAV and SRT/WebVTT captions. Frames come
  // from the editor's own compositor through the export bridge, so every format shows
  // exactly what the Program monitor shows. All bytes are written on this device.
  const formats = window.AlcorVideoFormats;
  if (!formats || window.AlcorVideoExportFormats) return;

  const MAX_SEQUENCE_FRAMES = 3000;
  // The editor owns the bitrate table and device budget; these are only fallbacks for an older bridge.
  const isSmallDevice = (bridge) =>
    bridge && typeof bridge.isSmallDevice === 'function'
      ? bridge.isSmallDevice()
      : Boolean(
          window.matchMedia?.('(max-width: 1024px)').matches ||
            (navigator.deviceMemory && navigator.deviceMemory <= 4),
        );
  const qualityBpp = (bridge) =>
    (bridge && bridge.qualityBpp) || Object.freeze({ high: 0.2, medium: 0.12, low: 0.06 });

  function makeCanvas(width, height) {
    return typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height });
  }

  function canvasBlob(canvas, type, quality) {
    if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality });
    return new Promise((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob ? resolve(blob) : reject(new Error('The browser could not encode the image.')),
        type,
        quality,
      ),
    );
  }

  // Render every frame of a range through the compositor and hand it to `onFrame`.
  async function eachFrame(bridge, range, frameRate, width, height, onFrame, read = false) {
    const entries = await bridge.prepareSources();
    try {
      const canvas = makeCanvas(width, height);
      const context = canvas.getContext('2d', { alpha: false, willReadFrequently: read });
      const count = Math.max(1, Math.round((range.end - range.start) * frameRate));
      for (let index = 0; index < count; index += 1) {
        if (bridge.cancelled()) throw new Error('cancelled');
        const time = range.start + index / frameRate;
        await bridge.seekSources(entries, time, bridge.fps());
        bridge.draw(context, time, width, height, entries);
        await onFrame({ canvas, context, index, count, time });
      }
      return count;
    } finally {
      bridge.releaseSources(entries);
    }
  }

  async function still(bridge, settings) {
    const time = Math.min(
      Math.max(0, bridge.currentTime()),
      Math.max(0, bridge.projectDuration() - 1e-3),
    );
    const entries = await bridge.prepareSources();
    try {
      const canvas = makeCanvas(settings.width, settings.height);
      const context = canvas.getContext('2d', { alpha: false });
      await bridge.seekSources(entries, time, bridge.fps());
      bridge.draw(context, time, settings.width, settings.height, entries);
      const blob = await canvasBlob(canvas, 'image/png');
      bridge.deliver(
        blob,
        bridge.fileName(`-frame-${bridge.formatClock(time, true).replace(/:/g, '-')}.png`),
        0,
      );
      return `PNG still · ${settings.width}×${settings.height} · ${bridge.formatClock(time, true)} · ${bridge.formatBytes(blob.size)}`;
    } finally {
      bridge.releaseSources(entries);
    }
  }

  async function sequence(bridge, settings, range, type) {
    const frameRate = bridge.fps();
    const count = Math.round((range.end - range.start) * frameRate);
    if (count > MAX_SEQUENCE_FRAMES)
      throw new Error(
        `An image sequence is limited to ${MAX_SEQUENCE_FRAMES} frames (${count} requested). Set in and out points around a shorter range.`,
      );
    const budget = isSmallDevice(bridge) ? 256 * 1024 * 1024 : 1024 * 1024 * 1024;
    const zip = formats.createZip();
    let bytes = 0;
    const extension = type === 'image/png' ? 'png' : 'jpg';
    await eachFrame(
      bridge,
      range,
      frameRate,
      settings.width,
      settings.height,
      async ({ canvas, index, count: total }) => {
        const blob = await canvasBlob(canvas, type, type === 'image/jpeg' ? 0.92 : undefined);
        bytes += blob.size;
        if (bytes > budget)
          throw new Error(
            `The sequence passed this device's ${isSmallDevice(bridge) ? '256 MB' : '1 GB'} export budget. Export a shorter range or a smaller preset.`,
          );
        zip.add(
          `frame-${String(index + 1).padStart(6, '0')}.${extension}`,
          new Uint8Array(await blob.arrayBuffer()),
        );
        bridge.progress(
          (index + 1) / total,
          `Frame ${index + 1} of ${total} · ${bridge.formatBytes(bytes)}`,
        );
      },
    );
    const blob = new Blob(zip.finish(), { type: 'application/zip' });
    bridge.deliver(blob, bridge.fileName(`-${extension}-sequence.zip`), range.end - range.start);
    return `${extension.toUpperCase()} sequence · ${zip.count} frames in a ZIP · ${bridge.formatBytes(blob.size)}`;
  }

  async function gif(bridge, settings, range) {
    const plan = formats.gifPlan(
      settings.width,
      settings.height,
      bridge.fps(),
      range.end - range.start,
    );
    const encoder = formats.createGif(plan.width, plan.height);
    const clipped = { start: range.start, end: range.start + plan.seconds };
    await eachFrame(
      bridge,
      clipped,
      plan.fps,
      plan.width,
      plan.height,
      async ({ context, index, count }) => {
        encoder.addFrame(context.getImageData(0, 0, plan.width, plan.height).data, 1 / plan.fps);
        bridge.progress((index + 1) / count, `GIF frame ${index + 1} of ${count}`);
        if (index % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 0));
      },
      true,
    );
    const blob = new Blob(encoder.finish(), { type: 'image/gif' });
    bridge.deliver(blob, bridge.fileName('.gif'), plan.seconds);
    return `GIF · ${plan.width}×${plan.height} · ${plan.fps} fps · ${plan.frames} frames · ${bridge.formatBytes(blob.size)}${plan.truncated ? ' · first 15 s only (GIF limit)' : ''}`;
  }

  async function wav(bridge, range) {
    if (!bridge.hasSound(range)) throw new Error('There is no sound in the export range.');
    bridge.progress(0.1, 'Mixing audio on this device…');
    const mix = await bridge.mixAudio(range);
    if (bridge.cancelled()) throw new Error('cancelled');
    if (!mix) throw new Error('There is no sound in the export range.');
    const left = mix.getChannelData(0);
    const right = mix.numberOfChannels > 1 ? mix.getChannelData(1) : left;
    const bytes = formats.encodeWav([left, right], mix.sampleRate);
    const blob = new Blob([bytes], { type: 'audio/wav' });
    bridge.deliver(blob, bridge.fileName('.wav'), range.end - range.start);
    return `WAV · 16-bit PCM stereo · ${mix.sampleRate} Hz · ${bridge.formatBytes(blob.size)}`;
  }

  function captions(bridge, range, kind) {
    const cues = bridge
      .captionCues()
      .map((cue) => ({
        start: Math.max(cue.start, range.start) - range.start,
        end: Math.min(cue.end, range.end) - range.start,
        text: cue.text,
      }))
      .filter((cue) => cue.end - cue.start > 0.001);
    if (!cues.length) throw new Error('Add at least one title or caption in the export range.');
    const text =
      kind === 'vtt' ? formats.serializeVtt(cues) : `${bridge.timelineCore.serializeSrt(cues)}\n`;
    const blob = new Blob([text], { type: kind === 'vtt' ? 'text/vtt' : 'application/x-subrip' });
    bridge.deliver(blob, bridge.fileName(`.${kind}`), 0);
    return `${kind.toUpperCase()} · ${cues.length} caption${cues.length === 1 ? '' : 's'}`;
  }

  async function webm(bridge, settings, range, support) {
    if (!support || !support.webmFast)
      throw new Error('This browser has no WebCodecs VP9 or VP8 encoder; choose WebM (real time).');
    const frameRate = bridge.fps();
    const { width, height } = settings;
    const sound = bridge.hasSound(range);
    if (sound && !support.webmAudio)
      throw new Error('This browser has no Opus encoder for the sound; choose WebM (real time).');
    const videoBitrate = Math.round(
      (qualityBpp(bridge)[settings.quality] || qualityBpp(bridge).high) *
        width *
        height *
        frameRate,
    );
    const budget = isSmallDevice(bridge) ? 256 * 1024 * 1024 : 1024 * 1024 * 1024;
    if (((range.end - range.start) * (videoBitrate + 128000)) / 8 > budget)
      throw new Error(
        'This render may exceed the local memory budget. Lower the quality or size, or export a shorter range.',
      );
    let failure = null;
    let encodedBytes = 0;
    const audioTrack = sound ? { sampleRate: 48000, channels: 2 } : null;
    const muxer = formats.createWebmMuxer({
      video: { codec: support.webmFast.codec, width, height },
      audio: audioTrack,
    });
    let audioDescription = null;
    const encoder = new window.VideoEncoder({
      output(chunk) {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        encodedBytes += data.length;
        if (encodedBytes > budget) {
          failure = new Error(
            'The encoded output exceeded this device’s local render-memory budget.',
          );
          return;
        }
        muxer.addVideoChunk({ data, timestamp: chunk.timestamp, key: chunk.type === 'key' });
      },
      error(error) {
        failure = error;
      },
    });
    let audioEncoder = null;
    try {
      encoder.configure({
        codec: support.webmFast.codec,
        width,
        height,
        bitrate: videoBitrate,
        framerate: frameRate,
        latencyMode: 'quality',
      });
      const mix = sound
        ? (bridge.progress(0, 'Mixing audio on this device…'), await bridge.mixAudio(range))
        : null;
      const keyInterval = Math.max(1, Math.round(frameRate * 2));
      const started = performance.now();
      await eachFrame(bridge, range, frameRate, width, height, async ({ canvas, index, count }) => {
        if (failure) throw failure;
        const frame = new window.VideoFrame(canvas, {
          timestamp: Math.round((index * 1e6) / frameRate),
          duration: Math.round(1e6 / frameRate),
        });
        encoder.encode(frame, { keyFrame: index % keyInterval === 0 });
        frame.close();
        const waitStart = performance.now();
        while (encoder.encodeQueueSize > 6 && !failure) {
          if (performance.now() - waitStart > bridge.stallMs)
            throw new bridge.ExportStall('The browser video encoder stopped accepting frames.');
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        if (index % 3 === 0 || index === count - 1) {
          const elapsed = (performance.now() - started) / 1000;
          bridge.progress(
            ((index + 1) / count) * (mix ? 0.9 : 1),
            `Frame ${index + 1} of ${count} · ${elapsed > 0 ? ((index + 1) / frameRate / elapsed).toFixed(2) : '0'}× real time`,
          );
        }
      });
      await encoder.flush();
      if (failure) throw failure;
      if (mix) {
        audioEncoder = new window.AudioEncoder({
          output(chunk, meta) {
            if (meta?.decoderConfig?.description && !audioDescription)
              audioDescription = meta.decoderConfig.description;
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            muxer.addAudioChunk({ data, timestamp: chunk.timestamp });
          },
          error(error) {
            failure = error;
          },
        });
        audioEncoder.configure({
          codec: 'opus',
          sampleRate: 48000,
          numberOfChannels: 2,
          bitrate: 128000,
        });
        const left = mix.getChannelData(0);
        const right = mix.numberOfChannels > 1 ? mix.getChannelData(1) : left;
        for (let start = 0; start < mix.length; start += 4800) {
          if (bridge.cancelled()) throw new Error('cancelled');
          const count = Math.min(4800, mix.length - start);
          const planar = new Float32Array(count * 2);
          planar.set(left.subarray(start, start + count), 0);
          planar.set(right.subarray(start, start + count), count);
          const data = new window.AudioData({
            format: 'f32-planar',
            sampleRate: 48000,
            numberOfFrames: count,
            numberOfChannels: 2,
            timestamp: Math.round((start / 48000) * 1e6),
            data: planar,
          });
          audioEncoder.encode(data);
          data.close();
          if (audioEncoder.encodeQueueSize > 20)
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        await audioEncoder.flush();
        if (failure) throw failure;
      }
      // The encoder's own OpusHead (real pre-skip) becomes the track's CodecPrivate.
      if (audioTrack && audioDescription) audioTrack.description = audioDescription;
      const parts = muxer.finalize((range.end - range.start) * 1000);
      const blob = new Blob(parts, { type: 'video/webm' });
      bridge.deliver(blob, bridge.fileName('.webm'), range.end - range.start);
      return `WebM · ${support.webmFast.label}${mix ? ' + Opus' : ''} · ${width}×${height} · ${bridge.formatBytes(blob.size)}`;
    } finally {
      try {
        if (encoder.state !== 'closed') encoder.close();
      } catch (_) {}
      try {
        if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close();
      } catch (_) {}
    }
  }

  const LABELS = Object.freeze({
    'webm-fast': 'WebM',
    gif: 'GIF',
    png: 'PNG still',
    'png-seq': 'PNG sequence',
    'jpeg-seq': 'JPEG sequence',
    wav: 'WAV audio',
    srt: 'SRT captions',
    vtt: 'WebVTT captions',
  });

  // ---------------------------------------------------------------- dialog

  // The dialog markup belongs to the page template; this adds the platform presets, the
  // WebM wording and the WebM (fast) default to it once this module has loaded.
  const FPS_FORMATS = Object.freeze(['webm-fast', 'gif', 'png-seq', 'jpeg-seq']);
  const dialogForm =
    typeof document === 'object' ? document.getElementById('av-export-form') : null;
  const dialogRoot =
    dialogForm && dialogForm.closest ? dialogForm.closest('#av-render-dialog') : null;
  const field = (name) =>
    (dialogForm && dialogForm.elements && dialogForm.elements.namedItem(name)) || null;
  let formatTouched = false;
  let noteElement = null;

  // Frame rate of the selected platform preset (0 = keep the sequence rate).
  function presetFps() {
    const select = field('preset');
    const option = select && select.selectedOptions && select.selectedOptions[0];
    return option && option.dataset.alcorFps ? Number(option.dataset.alcorFps) || 0 : 0;
  }

  function installPresets() {
    const select = field('preset');
    if (!select || !select.options || select.querySelector('[data-alcor-platform]')) return;
    for (const preset of formats.PLATFORM_PRESETS || []) {
      const host = Array.from(select.options).find(
        (option) => option.value === preset.value && !option.dataset.alcorPlatform,
      );
      if (!host) continue;
      const option = document.createElement('option');
      option.value = preset.value; // the editor resolves the size from this id
      option.textContent = preset.label;
      option.dataset.alcorPlatform = preset.id;
      if (preset.fps) option.dataset.alcorFps = String(preset.fps);
      host.after(option);
    }
  }

  function installFormatLabels() {
    const select = field('format');
    if (!select || !select.options) return;
    const labels = formats.FORMAT_LABELS || {};
    for (const option of Array.from(select.options))
      if (labels[option.value]) option.textContent = labels[option.value];
    const fast = Array.from(select.options).find((option) => option.value === 'webm-fast');
    const realtime = Array.from(select.options).find((option) => option.value === 'webm');
    if (fast && realtime && fast.compareDocumentPosition(realtime) & 2)
      select.insertBefore(fast, realtime); // fast first
  }

  function updateNote() {
    if (!dialogForm) return;
    const support = document.getElementById('av-export-support');
    if (!noteElement) {
      noteElement = document.createElement('p');
      noteElement.id = 'av-export-platform-note';
      noteElement.className = 'av-export-note';
      noteElement.setAttribute('role', 'status');
      (support && support.parentNode ? support.parentNode : dialogForm).insertBefore(
        noteElement,
        support ? support.nextSibling : null,
      );
    }
    const format = field('format') ? field('format').value : '';
    const lines = [];
    if (format === 'webm')
      lines.push(
        formats.REALTIME_WEBM_WARNING || 'WebM (real time) has no seeking; use WebM (fast).',
      );
    const fps = presetFps();
    const sequence = document.getElementById('av-fps');
    const sequenceFps = sequence ? Number(sequence.value) : 0;
    if (fps && !FPS_FORMATS.includes(format) && sequenceFps && Math.abs(sequenceFps - fps) > 0.01) {
      lines.push(
        `This preset's ${fps} fps applies to WebM (fast), GIF and image sequences. MP4 and real-time WebM keep the sequence rate (${sequenceFps} fps).`,
      );
    }
    noteElement.textContent = lines.join(' ');
    noteElement.hidden = !lines.length;
  }

  // WebM (fast) is the default format; a choice the user makes is never overridden.
  function applyDefaults() {
    const select = field('format');
    if (!select || formatTouched || select.value !== 'auto') return;
    const fast = Array.from(select.options).find((option) => option.value === 'webm-fast');
    if (fast && !fast.disabled) select.value = 'webm-fast';
  }

  function refreshDialog() {
    installPresets();
    installFormatLabels();
    applyDefaults();
    updateNote();
  }

  if (dialogForm && dialogRoot) {
    refreshDialog();
    let wasHidden = dialogRoot.hidden;
    new MutationObserver(() => {
      if (wasHidden && !dialogRoot.hidden) formatTouched = false;
      wasHidden = dialogRoot.hidden;
      refreshDialog();
    }).observe(dialogRoot, { attributes: true, attributeFilter: ['hidden', 'data-stage'] });
    // The editor rewrites the support line after it disables unavailable formats.
    const support = document.getElementById('av-export-support');
    if (support)
      new MutationObserver(refreshDialog).observe(support, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    dialogForm.addEventListener('change', (event) => {
      if (event.target && event.target.name === 'format') formatTouched = true;
      updateNote();
    });
  }

  async function run(format, bridge, settings, range, support) {
    const label = LABELS[format];
    if (!label) {
      bridge.setStatus('Unknown export format');
      return;
    }
    const fps = presetFps();
    if (fps && FPS_FORMATS.includes(format)) bridge = Object.freeze({ ...bridge, fps: () => fps });
    bridge.begin(`Preparing ${label}…`);
    try {
      let summary;
      if (format === 'png') summary = await still(bridge, settings);
      else if (format === 'png-seq') summary = await sequence(bridge, settings, range, 'image/png');
      else if (format === 'jpeg-seq')
        summary = await sequence(bridge, settings, range, 'image/jpeg');
      else if (format === 'gif') summary = await gif(bridge, settings, range);
      else if (format === 'wav') summary = await wav(bridge, range);
      else if (format === 'srt' || format === 'vtt') summary = captions(bridge, range, format);
      else summary = await webm(bridge, settings, range, support);
      bridge.end();
      bridge.setStatus(`Export complete · ${summary}`);
    } catch (error) {
      const cancelled = bridge.cancelled() || error.message === 'cancelled';
      bridge.end();
      if (!cancelled) console.error(`AlcorVideo ${label} export failed:`, error);
      bridge.setStatus(
        cancelled ? 'Render cancelled' : `Export failed (${label}): ${error.message}`,
      );
    }
  }

  window.AlcorVideoExportFormats = Object.freeze({ run, LABELS });
})();
