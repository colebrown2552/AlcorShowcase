/* alcor-video-recorder-guard */
(() => {
  'use strict';

  const root = document.querySelector('[data-alcor-video-editor]');
  if (!root) return;

  const config = window.AlcorVideoRenderGuardConfig || {};
  const stopTimeoutMs = Math.max(1000, Number(config.stopTimeoutMs) || 10000);
  const audioTimeoutMs = Math.max(1000, Number(config.audioTimeoutMs) || 10000);
  const stopTimers = new WeakMap();

  function timeoutPromise(ms, message) {
    return new Promise((_, reject) => {
      window.setTimeout(() => reject(new Error(message)), ms);
    });
  }

  function clearStopTimer(recorder) {
    const timer = stopTimers.get(recorder);
    if (timer) window.clearTimeout(timer);
    stopTimers.delete(recorder);
  }

  function installMediaRecorderGuard() {
    const NativeMediaRecorder = window.MediaRecorder;
    if (typeof NativeMediaRecorder !== 'function' || NativeMediaRecorder.__alcorStopGuard) return;

    const GuardedMediaRecorder = new Proxy(NativeMediaRecorder, {
      construct(Target, args) {
        const recorder = Reflect.construct(Target, args, Target);
        const nativeStop = recorder.stop.bind(recorder);

        recorder.addEventListener('stop', () => clearStopTimer(recorder));
        recorder.addEventListener('error', () => clearStopTimer(recorder));

        recorder.stop = function alcorGuardedStop() {
          nativeStop();
          clearStopTimer(recorder);
          stopTimers.set(
            recorder,
            window.setTimeout(() => {
              stopTimers.delete(recorder);
              try {
                Object.defineProperty(recorder, 'error', {
                  configurable: true,
                  value: new Error('The browser render did not finish in time.'),
                });
              } catch (_) {}
              recorder.dispatchEvent(new Event('error'));
            }, stopTimeoutMs),
          );
        };

        return recorder;
      },
      get(Target, property) {
        if (property === '__alcorStopGuard') return true;
        const value = Reflect.get(Target, property, Target);
        return typeof value === 'function' ? value.bind(Target) : value;
      },
    });

    window.MediaRecorder = GuardedMediaRecorder;
  }

  function installAudioContextGuard(name) {
    const NativeAudioContext = window[name];
    if (typeof NativeAudioContext !== 'function' || NativeAudioContext.__alcorRenderGuard) return;

    const GuardedAudioContext = new Proxy(NativeAudioContext, {
      construct(Target, args) {
        const context = Reflect.construct(Target, args, Target);
        const renderClocks = new Set();
        // Chromium may produce an empty recording when a destination audio
        // track exists but has no samples (for example, an image-only edit).
        // Zero-valued audio keeps that track clocked without changing the mix
        // or connecting to the speakers. The existing context owns its life.
        if (
          typeof context.createMediaStreamDestination === 'function' &&
          typeof context.createConstantSource === 'function'
        ) {
          const nativeDestination = context.createMediaStreamDestination.bind(context);
          context.createMediaStreamDestination = function alcorClockedDestination() {
            const destination = nativeDestination();
            const silence = context.createConstantSource();
            silence.offset.value = 0;
            try {
              silence.connect(destination);
              silence.start();
            } catch (error) {
              try {
                silence.disconnect();
              } catch (_) {}
              throw error;
            }
            renderClocks.add(silence);
            return destination;
          };
        }
        if (typeof context.resume === 'function') {
          const nativeResume = context.resume.bind(context);
          context.resume = function alcorGuardedResume() {
            return Promise.race([
              nativeResume(),
              timeoutPromise(
                audioTimeoutMs,
                'The browser audio renderer did not become ready in time.',
              ),
            ]);
          };
        }
        if (typeof context.close === 'function') {
          const nativeClose = context.close.bind(context);
          context.close = function alcorGuardedClose() {
            for (const silence of renderClocks) {
              try {
                silence.stop();
              } catch (_) {}
              try {
                silence.disconnect();
              } catch (_) {}
            }
            renderClocks.clear();
            return Promise.race([
              nativeClose(),
              timeoutPromise(audioTimeoutMs, 'The browser audio renderer did not close in time.'),
            ]);
          };
        }
        return context;
      },
      get(Target, property) {
        if (property === '__alcorRenderGuard') return true;
        const value = Reflect.get(Target, property, Target);
        return typeof value === 'function' ? value.bind(Target) : value;
      },
    });

    window[name] = GuardedAudioContext;
  }

  installMediaRecorderGuard();
  installAudioContextGuard('AudioContext');
  installAudioContextGuard('webkitAudioContext');
})();

/* alcor-video-core */
(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AlcorVideoCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_MIN_DURATION = 0.04;
  const MAX_CAPTION_SECONDS = 24 * 60 * 60;
  const LIMITS = Object.freeze({
    maxAssets: 128,
    maxClips: 500,
    maxProjectSeconds: 2 * 60 * 60,
    maxRenderSeconds: 30 * 60,
    maxAggregateImportBytes: 4 * 1024 * 1024 * 1024,
    maxHistoryBytes: 24 * 1024 * 1024,
  });

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, number(value)));
  }

  function round(value, precision = 3) {
    const power = 10 ** precision;
    const safe = number(value);
    const scaled = safe * power;
    return Number.isFinite(scaled) ? Math.round(scaled) / power : safe;
  }

  function normalizeClipWindow(
    start,
    duration,
    minDuration = DEFAULT_MIN_DURATION,
    maxSeconds = LIMITS.maxProjectSeconds,
  ) {
    const minimum = clamp(minDuration, 0.001, 60);
    const maximum = clamp(maxSeconds, minimum, LIMITS.maxProjectSeconds);
    const safeStart = clamp(start, 0, maximum - minimum);
    const safeDuration = clamp(duration, minimum, maximum - safeStart);
    return Object.freeze({ start: round(safeStart), duration: round(safeDuration) });
  }

  function validateProjectEnvelope(project) {
    if (!project || typeof project !== 'object') throw new Error('Project file is not an object.');
    const assets = Array.isArray(project.assets) ? project.assets : [];
    const clips = Array.isArray(project.clips) ? project.clips : [];
    if (assets.length > LIMITS.maxAssets)
      throw new Error(`Projects are limited to ${LIMITS.maxAssets} assets.`);
    if (clips.length > LIMITS.maxClips)
      throw new Error(`Projects are limited to ${LIMITS.maxClips} clips.`);
    for (const clip of clips) {
      const minimum = clip && clip.kind === 'title' ? 0.1 : DEFAULT_MIN_DURATION;
      const start = number(clip && clip.start, 0);
      const duration = number(clip && clip.duration, minimum);
      if (start < 0 || duration < minimum || start + duration > LIMITS.maxProjectSeconds) {
        throw new Error(`Project clips must fit within ${LIMITS.maxProjectSeconds} seconds.`);
      }
    }
    return project;
  }

  function preserveWorkspaceArrowKey(event, workspace, schedule) {
    const key = event && event.key;
    if (!workspace || (key !== 'ArrowLeft' && key !== 'ArrowRight')) return false;
    const start = number(workspace.scrollLeft);
    const viewport = Math.max(1, number(workspace.clientWidth, 1));
    const maximum = Math.max(0, number(workspace.scrollWidth) - viewport);
    const delta = Math.max(80, Math.floor(viewport * 0.8)) * (key === 'ArrowRight' ? 1 : -1);
    const defer = typeof schedule === 'function' ? schedule : (callback) => callback();
    defer(() => {
      // Preserve the browser's native scroll first. Only supply the bounded
      // fallback when that default action did not move the focused region.
      if (number(workspace.scrollLeft) !== start) return;
      const next = clamp(start + delta, 0, maximum);
      if (typeof workspace.scrollBy === 'function') {
        workspace.scrollBy({ left: next - start, top: 0, behavior: 'auto' });
      } else {
        workspace.scrollLeft = next;
      }
    });
    return true;
  }

  function clipEnd(clip) {
    return round(
      Math.max(0, number(clip && clip.start)) + Math.max(0, number(clip && clip.duration)),
    );
  }

  function projectDuration(clips) {
    return round(
      (Array.isArray(clips) ? clips : []).reduce(
        (maximum, clip) => Math.max(maximum, clipEnd(clip)),
        0,
      ),
    );
  }

  function activeAt(clip, time) {
    if (!clip) return false;
    const point = number(time);
    const start = Math.max(0, number(clip.start));
    return point >= start && point < start + Math.max(0, number(clip.duration));
  }

  function sourceTime(clip, timelineTime) {
    if (!clip) return 0;
    return Math.max(
      0,
      round(
        number(clip.in) +
          (number(timelineTime) - number(clip.start)) * clamp(clip.speed || 1, 0.01, 100),
        6,
      ),
    );
  }

  function fadeEnvelope(clip, timelineTime) {
    if (!clip || !activeAt(clip, timelineTime)) return 0;
    const duration = Math.max(0, number(clip.duration));
    if (!duration) return 0;

    const local = clamp(number(timelineTime) - number(clip.start), 0, duration);
    const fadeIn = clamp(clip.fadeIn, 0, duration);
    const fadeOut = clamp(clip.fadeOut, 0, duration);
    const incoming = fadeIn > 0 ? clamp(local / fadeIn, 0, 1) : 1;
    const outgoing = fadeOut > 0 ? clamp((duration - local) / fadeOut, 0, 1) : 1;
    return round(Math.min(incoming, outgoing), 6);
  }

  function snapTime(options) {
    const settings = options || {};
    let value = Math.max(0, number(settings.time));
    if (settings.enabled === false) return round(value);

    const pxPerSecond = Math.max(1, number(settings.pxPerSecond, 72));
    const tolerance = Math.max(0.03, 9 / pxPerSecond);
    const candidates = [0, Math.max(0, number(settings.currentTime))];
    for (const clip of Array.isArray(settings.clips) ? settings.clips : []) {
      if (!clip || clip.id === settings.excludedId) continue;
      candidates.push(Math.max(0, number(clip.start)), clipEnd(clip));
    }

    let nearest = value;
    let distance = tolerance;
    for (const candidate of candidates) {
      const nextDistance = Math.abs(candidate - value);
      if (nextDistance < distance) {
        nearest = candidate;
        distance = nextDistance;
      }
    }
    return round(nearest);
  }

  function splitClip(clip, splitAt, newId, minDuration = DEFAULT_MIN_DURATION) {
    if (!clip || typeof clip !== 'object') return null;
    const minimum = Math.max(0.001, number(minDuration, DEFAULT_MIN_DURATION));
    const start = Math.max(0, number(clip.start));
    const duration = Math.max(minimum, number(clip.duration, minimum));
    const end = start + duration;
    const point = number(splitAt);
    if (point <= start + minimum || point >= end - minimum) return null;

    const left = JSON.parse(JSON.stringify(clip));
    const right = JSON.parse(JSON.stringify(clip));
    left.duration = round(point - start);
    right.id = String(newId || `${String(clip.id || 'clip')}-split`);
    right.start = round(point);
    right.duration = round(end - point);

    if (clip.kind !== 'title') {
      right.in = round(number(clip.in) + left.duration * clamp(clip.speed || 1, 0.01, 100));
      left.fadeIn = clamp(clip.fadeIn, 0, left.duration);
      left.fadeOut = 0;
      right.fadeIn = 0;
      right.fadeOut = clamp(clip.fadeOut, 0, right.duration);
    }
    return { left, right };
  }

  function parseTimestamp(value) {
    const match = String(value || '')
      .trim()
      .match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
    if (!match) throw new Error(`Invalid caption timestamp: ${value}`);
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    const millis = Number(match[4].padEnd(3, '0'));
    if (minutes > 59 || seconds > 59 || millis > 999)
      throw new Error(`Invalid caption timestamp: ${value}`);
    const total = hours * 3600 + minutes * 60 + seconds + millis / 1000;
    if (total > MAX_CAPTION_SECONDS) throw new Error('Caption timestamps may not exceed 24 hours.');
    return round(total, 3);
  }

  function formatTimestamp(seconds) {
    const totalMillis = Math.max(0, Math.round(number(seconds) * 1000));
    const hours = Math.floor(totalMillis / 3600000);
    const minutes = Math.floor((totalMillis % 3600000) / 60000);
    const secs = Math.floor((totalMillis % 60000) / 1000);
    const millis = totalMillis % 1000;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
  }

  function decodeCaptionText(value) {
    return String(value || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .trim();
  }

  function parseSrt(text, options) {
    const settings = options || {};
    const maxCues = Math.max(1, Math.min(2000, number(settings.maxCues, 500)));
    const normalized = String(text || '')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .trim();
    if (!normalized) return [];

    const blocks = normalized.split(/\n{2,}/);
    const cues = [];
    for (const block of blocks) {
      const lines = block.split('\n').map((line) => line.trimEnd());
      const timingIndex = lines.findIndex((line) => line.includes('-->'));
      if (timingIndex < 0) continue;
      const timing = lines[timingIndex].match(
        /^\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})(?:\s+.*)?$/,
      );
      if (!timing) throw new Error(`Invalid caption timing line: ${lines[timingIndex]}`);
      const start = parseTimestamp(timing[1]);
      const end = parseTimestamp(timing[2]);
      if (end <= start)
        throw new Error(`Caption end must be after its start: ${lines[timingIndex]}`);
      const cueText = decodeCaptionText(lines.slice(timingIndex + 1).join('\n'));
      if (!cueText) continue;
      cues.push({
        id: String(lines[timingIndex - 1] || cues.length + 1),
        start,
        end,
        duration: round(end - start),
        text: cueText.slice(0, 240),
      });
      if (cues.length > maxCues)
        throw new Error(`Caption file exceeds the ${maxCues}-cue import limit.`);
    }
    return cues.sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
  }

  function serializeSrt(cues) {
    return (Array.isArray(cues) ? cues : [])
      .filter(
        (cue) =>
          cue &&
          number(cue.end, number(cue.start) + number(cue.duration)) > number(cue.start) &&
          String(cue.text || '').trim(),
      )
      .sort(
        (a, b) =>
          number(a.start) - number(b.start) ||
          number(a.end, number(a.start) + number(a.duration)) -
            number(b.end, number(b.start) + number(b.duration)),
      )
      .map((cue, index) => {
        const start = Math.max(0, number(cue.start));
        const end = Math.max(start + 0.001, number(cue.end, start + number(cue.duration)));
        const text = String(cue.text || '')
          .replace(/\r\n?/g, '\n')
          .replace(/\n[ \t]*(?:\n[ \t]*)+/g, '\n')
          .trim();
        return `${index + 1}\n${formatTimestamp(start)} --> ${formatTimestamp(end)}\n${text}`;
      })
      .join('\n\n');
  }

  const PORTABLE_MAGIC = 'ALCORVIDEO-BUNDLE-V1\n';
  const PORTABLE_SCHEMA = 'alcorvideo.bundle';
  const MAX_PORTABLE_MANIFEST_BYTES = 2 * 1024 * 1024;
  const MAX_PORTABLE_ASSET_BYTES = 2 * 1024 * 1024 * 1024;

  function utf8(value) {
    if (typeof TextEncoder !== 'function') throw new Error('UTF-8 encoder unavailable.');
    return new TextEncoder().encode(String(value));
  }

  function portablePrefixBytes() {
    return utf8(PORTABLE_MAGIC);
  }

  async function hasPortableProjectMagic(blob) {
    if (!blob || typeof blob.slice !== 'function') return false;
    const magic = portablePrefixBytes();
    if (Number(blob.size) < magic.length + 4) return false;
    const prefix = new Uint8Array(await blob.slice(0, magic.length).arrayBuffer());
    return prefix.length === magic.length && prefix.every((value, index) => value === magic[index]);
  }

  async function createPortableProjectBundle(project, assetBlobs, options) {
    if (!project || typeof project !== 'object' || project.schema !== 'alcorvideo.project')
      throw new Error('Portable project requires an AlcorVideo project.');
    if (Number(project.schemaVersion) !== 1)
      throw new Error('Unsupported AlcorVideo project schema.');
    if (!Array.isArray(project.assets))
      throw new Error('Portable project requires an asset array.');
    const assets = project.assets;
    if (assets.length > LIMITS.maxAssets)
      throw new Error(`Portable projects are limited to ${LIMITS.maxAssets} assets.`);
    const sources =
      assetBlobs instanceof Map ? assetBlobs : new Map(Object.entries(assetBlobs || {}));
    const maxAssetBytes = Math.min(
      MAX_PORTABLE_ASSET_BYTES,
      Math.max(1, number(options && options.maxAssetBytes, MAX_PORTABLE_ASSET_BYTES)),
    );
    let offset = 0;
    const records = [];
    const parts = [];
    const seen = new Set();
    for (const asset of assets) {
      const id = String((asset && asset.id) || '');
      if (!id || seen.has(id))
        throw new Error('Portable project asset ids must be unique and non-empty.');
      seen.add(id);
      const blob = sources.get(id);
      if (!blob || typeof blob.slice !== 'function')
        throw new Error(
          `Relink ${String(asset.name || id)} before downloading a portable project.`,
        );
      const size = Number(blob.size);
      if (!Number.isFinite(size) || size < 0 || size > maxAssetBytes)
        throw new Error(
          `Asset ${String(asset.name || id)} exceeds the portable-project asset limit.`,
        );
      if (Number(asset.size) && Number(asset.size) !== size)
        throw new Error(
          `Asset ${String(asset.name || id)} no longer matches its imported byte size.`,
        );

      records.push({
        id,
        name: String(asset.name || id).slice(0, 255),
        type: String(asset.type || blob.type || '').slice(0, 160),
        kind: String(asset.kind || ''),
        size,
        offset,
      });
      parts.push(blob);
      offset += size;
      if (offset > LIMITS.maxAggregateImportBytes)
        throw new Error('Portable project exceeds the aggregate local-media budget.');
    }
    const manifest = {
      schema: PORTABLE_SCHEMA,
      schemaVersion: 1,
      project,
      assets: records,
      dataBytes: offset,
    };
    const manifestBytes = utf8(JSON.stringify(manifest));
    if (manifestBytes.length > MAX_PORTABLE_MANIFEST_BYTES)
      throw new Error('Portable project manifest is too large.');
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, manifestBytes.length, false);
    return {
      blob: new Blob([portablePrefixBytes(), length, manifestBytes, ...parts], {
        type: 'application/vnd.alcorvideo.project',
      }),
      manifest,
    };
  }

  async function parsePortableProjectBundle(blob) {
    if (!(await hasPortableProjectMagic(blob)))
      throw new Error('This is not an AlcorVideo portable project.');
    const magic = portablePrefixBytes();
    const lengthBytes = await blob.slice(magic.length, magic.length + 4).arrayBuffer();
    const manifestLength = new DataView(lengthBytes).getUint32(0, false);
    if (!manifestLength || manifestLength > MAX_PORTABLE_MANIFEST_BYTES)
      throw new Error('Portable project manifest length is invalid.');
    const dataStart = magic.length + 4 + manifestLength;
    if (dataStart > blob.size)
      throw new Error('Portable project is truncated before its media payload.');

    const manifestText = await blob.slice(magic.length + 4, dataStart).text();
    let manifest;
    try {
      manifest = JSON.parse(manifestText);
    } catch (error) {
      throw new Error('Portable project manifest is not valid JSON.');
    }
    if (!manifest || manifest.schema !== PORTABLE_SCHEMA || Number(manifest.schemaVersion) !== 1)
      throw new Error('Unsupported AlcorVideo portable project version.');
    if (!manifest.project || manifest.project.schema !== 'alcorvideo.project')
      throw new Error('Portable project is missing AlcorVideo project metadata.');
    if (Number(manifest.project.schemaVersion) !== 1)
      throw new Error('Unsupported AlcorVideo project schema.');
    if (!Array.isArray(manifest.assets) || manifest.assets.length > LIMITS.maxAssets)
      throw new Error('Portable project asset table is invalid.');
    if (
      !Array.isArray(manifest.project.assets) ||
      manifest.project.assets.length > LIMITS.maxAssets
    )
      throw new Error('Portable project asset table does not match project metadata.');
    const projectAssets = manifest.project.assets;
    const expectedIds = new Set();
    for (const asset of projectAssets) {
      const id = String((asset && asset.id) || '');
      if (!id || expectedIds.has(id))
        throw new Error('Portable project asset table does not match project metadata.');
      expectedIds.add(id);
    }
    const seen = new Set();
    let expectedOffset = 0;
    const assets = [];
    for (const record of manifest.assets) {
      const id = String((record && record.id) || '');
      const size = Number(record && record.size);
      const offset = Number(record && record.offset);
      if (!id || seen.has(id) || !expectedIds.has(id))
        throw new Error('Portable project asset table does not match project metadata.');
      if (
        !Number.isSafeInteger(size) ||
        size < 0 ||
        !Number.isSafeInteger(offset) ||
        offset !== expectedOffset
      )
        throw new Error('Portable project asset offsets are invalid.');
      if (size > MAX_PORTABLE_ASSET_BYTES || offset + size > LIMITS.maxAggregateImportBytes)
        throw new Error('Portable project media exceeds local safety limits.');
      const start = dataStart + offset;
      const end = start + size;
      if (end > blob.size) throw new Error('Portable project media payload is truncated.');
      assets.push({
        id,
        name: String(record.name || id).slice(0, 255),
        type: String(record.type || '').slice(0, 160),
        kind: String(record.kind || ''),
        size,
        blob: blob.slice(start, end, String(record.type || '')),
      });
      seen.add(id);
      expectedOffset += size;
    }

    if (seen.size !== expectedIds.size)
      throw new Error('Portable project is missing one or more media assets.');
    if (Number(manifest.dataBytes) !== expectedOffset || dataStart + expectedOffset !== blob.size)
      throw new Error('Portable project payload length does not match its manifest.');
    return { project: manifest.project, assets, manifest };
  }

  return Object.freeze({
    DEFAULT_MIN_DURATION,
    LIMITS,
    PORTABLE_MAGIC,
    PORTABLE_SCHEMA,
    activeAt,
    clamp,
    clipEnd,
    fadeEnvelope,
    formatTimestamp,
    hasPortableProjectMagic,
    createPortableProjectBundle,
    parsePortableProjectBundle,
    parseSrt,
    parseTimestamp,
    projectDuration,
    preserveWorkspaceArrowKey,
    normalizeClipWindow,
    validateProjectEnvelope,
    round,
    serializeSrt,
    snapTime,
    sourceTime,
    splitClip,
  });
});

/* alcor-video-transforms-core */
(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AlcorVideoTransforms = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FIT_MODES = Object.freeze(['contain', 'cover', 'stretch']);
  const KEYFRAME_PROPERTIES = Object.freeze([
    'positionX',
    'positionY',
    'scale',
    'rotation',
    'opacity',
  ]);
  const MAX_KEYFRAMES = 200;
  // Easing of the segment that starts at a keyframe (Premiere's temporal interpolation).
  const EASES = Object.freeze(['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold']);

  function easeProgress(ease, t) {
    const x = Math.min(1, Math.max(0, t));
    switch (ease) {
      case 'ease-in':
        return x * x * x;
      case 'ease-out':
        return 1 - Math.pow(1 - x, 3);
      case 'ease-in-out':
        return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
      case 'hold':
        return x >= 1 ? 1 : 0;
      default:
        return x;
    }
  }

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, number(value)));
  }

  function round(value, precision = 6) {
    const power = 10 ** precision;
    return Math.round(number(value) * power) / power;
  }

  function normalizeFit(value) {
    return FIT_MODES.includes(String(value || '').toLowerCase())
      ? String(value).toLowerCase()
      : 'contain';
  }

  function normalizeTransform(clip) {
    const value = clip && typeof clip === 'object' ? clip : {};
    return {
      positionX: clamp(value.positionX == null ? 50 : value.positionX, -100, 200),
      positionY: clamp(value.positionY == null ? 50 : value.positionY, -100, 200),
      scale: clamp(value.scale == null ? 100 : value.scale, 10, 800),
      rotation: clamp(value.rotation == null ? 0 : value.rotation, -180, 180),
      opacity: clamp(value.opacity == null ? 1 : value.opacity, 0, 1),
      fit: normalizeFit(value.fit),
    };
  }

  function normalizeKeyframe(value, duration) {
    if (!value || typeof value !== 'object') return null;
    const transform = normalizeTransform(value);
    const frame = {
      time: round(clamp(value.time, 0, Math.max(0, number(duration))), 3),
      positionX: transform.positionX,
      positionY: transform.positionY,
      scale: transform.scale,
      rotation: transform.rotation,
      opacity: transform.opacity,
    };
    // Linear frames keep the original shape so older projects round-trip unchanged.
    if (EASES.includes(value.ease) && value.ease !== 'linear') frame.ease = value.ease;
    return Object.freeze(frame);
  }

  function normalizeKeyframes(values, duration) {
    const maximum = Math.max(0, number(duration));
    const byTime = new Map();
    for (const value of Array.isArray(values) ? values.slice(0, MAX_KEYFRAMES * 2) : []) {
      const frame = normalizeKeyframe(value, maximum);
      if (!frame) continue;
      byTime.set(frame.time.toFixed(3), frame);
    }
    return Array.from(byTime.values())
      .sort((a, b) => a.time - b.time)
      .slice(0, MAX_KEYFRAMES);
  }

  function interpolate(start, end, progress) {
    return round(start + (end - start) * clamp(progress, 0, 1), 6);
  }

  function resolveTransformAtLocalTime(clip, localTime) {
    const base = normalizeTransform(clip);
    const duration = Math.max(0, number(clip && clip.duration));
    const frames = normalizeKeyframes(clip && clip.transformKeyframes, duration);
    if (!frames.length) return base;

    const time = clamp(localTime, 0, duration);
    if (time <= frames[0].time)
      return {
        positionX: frames[0].positionX,
        positionY: frames[0].positionY,
        scale: frames[0].scale,
        rotation: frames[0].rotation,
        opacity: frames[0].opacity,
        fit: base.fit,
      };
    const last = frames[frames.length - 1];
    if (time >= last.time)
      return {
        positionX: last.positionX,
        positionY: last.positionY,
        scale: last.scale,
        rotation: last.rotation,
        opacity: last.opacity,
        fit: base.fit,
      };

    for (let index = 1; index < frames.length; index += 1) {
      const right = frames[index];
      if (time > right.time) continue;
      const left = frames[index - 1];
      const span = Math.max(0.001, right.time - left.time);
      const progress = easeProgress(left.ease, (time - left.time) / span);
      return {
        positionX: interpolate(left.positionX, right.positionX, progress),
        positionY: interpolate(left.positionY, right.positionY, progress),
        scale: interpolate(left.scale, right.scale, progress),
        rotation: interpolate(left.rotation, right.rotation, progress),
        opacity: interpolate(left.opacity, right.opacity, progress),
        fit: base.fit,
      };
    }
    return base;
  }

  function resolveTransformAtTime(clip, timelineTime) {
    const localTime = number(timelineTime) - number(clip && clip.start);
    return resolveTransformAtLocalTime(clip, localTime);
  }

  function upsertKeyframe(values, value, duration) {
    const maximum = Math.max(0, number(duration));
    const next = normalizeKeyframes(values, maximum);
    let frame = normalizeKeyframe(value, maximum);
    if (!frame) return next;
    const replaced = next.find((item) => Math.abs(item.time - frame.time) <= 0.0005);
    // Updating a keyframe's values keeps its easing unless a new one is given.
    if (replaced && replaced.ease && !(value && 'ease' in value))
      frame = normalizeKeyframe({ ...frame, ease: replaced.ease }, maximum);
    const filtered = next.filter((item) => Math.abs(item.time - frame.time) > 0.0005);
    filtered.push(frame);
    return normalizeKeyframes(filtered, maximum);
  }

  function findKeyframeAtTime(values, time, duration, tolerance = 0.05) {
    const frames = normalizeKeyframes(values, duration);
    const point = clamp(time, 0, Math.max(0, number(duration)));
    const window = Math.max(0.001, number(tolerance, 0.05));
    let nearest = null;
    let distance = window;
    for (const frame of frames) {
      const next = Math.abs(frame.time - point);
      if (next <= distance) {
        nearest = frame;
        distance = next;
      }
    }
    return nearest;
  }

  function removeKeyframe(values, time, duration, tolerance = 0.05) {
    const frames = normalizeKeyframes(values, duration);
    const target = findKeyframeAtTime(frames, time, duration, tolerance);
    if (!target) return frames;
    return frames.filter((frame) => frame.time !== target.time);
  }

  function splitKeyframes(clip, splitLocalTime, leftDuration, rightDuration) {
    const duration = Math.max(0, number(clip && clip.duration));
    const frames = normalizeKeyframes(clip && clip.transformKeyframes, duration);
    if (!frames.length) return Object.freeze({ left: [], right: [] });

    const split = clamp(splitLocalTime, 0, duration);
    const boundary = { time: split, ...resolveTransformAtLocalTime(clip, split) };
    delete boundary.fit;
    // The right half's first segment keeps the easing of the segment it was cut from.
    const segment = frames.filter((frame) => frame.time <= split).pop();
    if (segment && segment.ease) boundary.ease = segment.ease;
    const left = frames
      .filter((frame) => frame.time < split)
      .concat([{ ...boundary, time: Math.max(0, number(leftDuration)) }]);
    const right = [{ ...boundary, time: 0 }].concat(
      frames
        .filter((frame) => frame.time > split)
        .map((frame) => ({ ...frame, time: round(frame.time - split, 3) })),
    );
    return Object.freeze({
      left: normalizeKeyframes(left, leftDuration),
      right: normalizeKeyframes(right, rightDuration),
    });
  }

  function resolveMediaTransform(clip, sourceWidth, sourceHeight, frameWidth, frameHeight) {
    const sw = number(sourceWidth);
    const sh = number(sourceHeight);
    const fw = number(frameWidth);
    const fh = number(frameHeight);
    if (sw <= 0 || sh <= 0 || fw <= 0 || fh <= 0) return null;

    const transform = normalizeTransform(clip);
    let baseWidth;
    let baseHeight;
    if (transform.fit === 'stretch') {
      baseWidth = fw;
      baseHeight = fh;
    } else {
      const ratio =
        transform.fit === 'cover' ? Math.max(fw / sw, fh / sh) : Math.min(fw / sw, fh / sh);
      baseWidth = sw * ratio;
      baseHeight = sh * ratio;
    }

    const scale = transform.scale / 100;
    return Object.freeze({
      ...transform,
      centerX: round((fw * transform.positionX) / 100),
      centerY: round((fh * transform.positionY) / 100),
      drawWidth: round(baseWidth * scale),
      drawHeight: round(baseHeight * scale),
      rotationRadians: round((transform.rotation * Math.PI) / 180, 9),
    });
  }

  function resolveMediaTransformAtTime(
    clip,
    timelineTime,
    sourceWidth,
    sourceHeight,
    frameWidth,
    frameHeight,
  ) {
    return resolveMediaTransform(
      resolveTransformAtTime(clip, timelineTime),
      sourceWidth,
      sourceHeight,
      frameWidth,
      frameHeight,
    );
  }

  function isIdentity(clip) {
    const transform = normalizeTransform(clip);
    const baseIdentity =
      transform.positionX === 50 &&
      transform.positionY === 50 &&
      transform.scale === 100 &&
      transform.rotation === 0 &&
      transform.opacity === 1 &&
      transform.fit === 'contain';
    if (!baseIdentity) return false;
    return normalizeKeyframes(clip && clip.transformKeyframes, clip && clip.duration).every(
      (frame) =>
        frame.positionX === 50 &&
        frame.positionY === 50 &&
        frame.scale === 100 &&
        frame.rotation === 0 &&
        frame.opacity === 1,
    );
  }

  // Set the easing of the segment that starts at (or before) a clip-local time.
  function setKeyframeEase(values, time, duration, ease, tolerance = 0.05) {
    const frames = normalizeKeyframes(values, duration);
    if (!EASES.includes(ease) || !frames.length) return frames;
    const point = clamp(time, 0, Math.max(0, number(duration)));
    const target =
      findKeyframeAtTime(frames, point, duration, tolerance) ||
      frames.filter((frame) => frame.time <= point).pop() ||
      frames[0];
    return normalizeKeyframes(
      frames.map((frame) => (frame.time === target.time ? { ...frame, ease } : frame)),
      duration,
    );
  }

  function easeAt(values, time, duration) {
    const frames = normalizeKeyframes(values, duration);
    const segment = frames.filter((frame) => frame.time <= number(time) + 0.0005).pop();
    return segment && segment.ease ? segment.ease : 'linear';
  }

  return Object.freeze({
    EASES,
    easeAt,
    easeProgress,
    setKeyframeEase,
    FIT_MODES,
    KEYFRAME_PROPERTIES,
    MAX_KEYFRAMES,
    clamp,
    findKeyframeAtTime,
    isIdentity,
    normalizeFit,
    normalizeKeyframes,
    normalizeTransform,
    removeKeyframe,
    resolveMediaTransform,
    resolveMediaTransformAtTime,
    resolveTransformAtLocalTime,
    resolveTransformAtTime,
    round,
    splitKeyframes,
    upsertKeyframe,
  });
});

/* alcor-video-transitions-core */
(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AlcorVideoTransitions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VISUAL_KINDS = Object.freeze(['video', 'image']);
  // Legacy constant kept for callers; any video track (V1..V12) now holds transitions.
  const VISUAL_TRACKS = Object.freeze(['V1', 'V2']);
  const VIDEO_TRACK = /^V[1-9][0-9]?$/;
  const AUDIO_TRACK = /^A[1-9][0-9]?$/;
  const MIN_TRANSITION_SECONDS = 0.05;
  const MAX_TRANSITION_SECONDS = 4;
  const VISUAL_TYPES = Object.freeze([
    'cross-dissolve',
    'dip-to-black',
    'dip-to-white',
    'wipe-left',
    'wipe-right',
    'wipe-up',
    'wipe-down',
  ]);
  const AUDIO_TYPES = Object.freeze(['constant-power', 'constant-gain']);

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, number(value)));
  }

  function round(value, precision = 3) {
    const power = 10 ** precision;
    return Math.round(number(value) * power) / power;
  }

  function isVisualClip(clip) {
    return Boolean(
      clip &&
        VISUAL_KINDS.includes(String(clip.kind || '')) &&
        clip.hold == null &&
        VIDEO_TRACK.test(String(clip.track || '')),
    );
  }

  function isAudioClip(clip) {
    return Boolean(clip && clip.kind === 'audio' && AUDIO_TRACK.test(String(clip.track || '')));
  }

  // Clips that can take part in an edit-point transition: pictures on video
  // tracks (dissolves, dips, wipes) and audio on audio tracks (crossfades).
  function isTransitionClip(clip) {
    return isVisualClip(clip) || isAudioClip(clip);
  }

  function sameFamily(a, b) {
    return (isVisualClip(a) && isVisualClip(b)) || (isAudioClip(a) && isAudioClip(b));
  }

  function fail(reason) {
    return Object.freeze({ ok: false, reason: String(reason) });
  }

  function clipEnd(clip) {
    return Math.max(0, number(clip && clip.start)) + Math.max(0, number(clip && clip.duration));
  }

  function findCutPair(clips, selectedId, fps = 30) {
    const list = Array.isArray(clips) ? clips : [];
    const selected = list.find((clip) => String(clip && clip.id) === String(selectedId || ''));
    if (!isTransitionClip(selected)) {
      return fail('Select the incoming video, image or audio clip at a cut first.');
    }

    const selectedStart = Math.max(0, number(selected.start));
    const candidates = list
      .filter(
        (clip) => clip !== selected && sameFamily(clip, selected) && clip.track === selected.track,
      )
      .map((clip) => ({ clip, start: Math.max(0, number(clip.start)), end: clipEnd(clip) }))
      .filter((candidate) => candidate.start < selectedStart)
      .sort(
        (left, right) =>
          right.end - left.end ||
          right.start - left.start ||
          String(left.clip.id).localeCompare(String(right.clip.id)),
      );

    const previous = candidates[0];
    if (!previous)
      return fail('The selected clip needs a previous clip of the same kind on the same track.');

    const tolerance = Math.max(0.02, 1 / Math.max(1, number(fps, 30)));
    const gap = selectedStart - previous.end;
    if (Math.abs(gap) > tolerance) {
      return fail(
        'Place the selected clip directly after the previous clip before applying a cut transition.',
      );
    }

    return Object.freeze({
      ok: true,
      outgoing: previous.clip,
      incoming: selected,
      cutTime: round(selectedStart),
      track: String(selected.track),
      gap: round(gap),
      tolerance,
    });
  }

  function planFadeThroughBackground(clips, selectedId, requestedDuration = 0.5, fps = 30) {
    const pair = findCutPair(clips, selectedId, fps);
    if (!pair.ok) return pair;
    const maximum = Math.min(
      MAX_TRANSITION_SECONDS,
      Math.max(0, number(pair.outgoing.duration)),
      Math.max(0, number(pair.incoming.duration)),
    );
    if (maximum < MIN_TRANSITION_SECONDS)
      return fail('Both clips must be at least 0.05 seconds long.');
    const duration = round(clamp(requestedDuration || 0.5, MIN_TRANSITION_SECONDS, maximum));
    return Object.freeze({
      ok: true,
      type: 'fade-through-background',
      outgoingId: String(pair.outgoing.id),
      incomingId: String(pair.incoming.id),
      track: pair.track,
      cutTime: pair.cutTime,
      duration,
      gap: pair.gap,
    });
  }

  function findAsset(assets, assetId) {
    return (
      (Array.isArray(assets) ? assets : []).find(
        (asset) => String(asset && asset.id) === String(assetId || ''),
      ) || null
    );
  }

  // The edit engine's handle math (it follows speed ramps); loaded after this file.
  function editCore() {
    if (globalThis.AlcorVideoEdit) return globalThis.AlcorVideoEdit;
    return typeof module === 'object' && module.exports
      ? require('./alcor-video-edit-core.js')
      : null;
  }

  function sourceHandles(clip, assets) {
    if (!isTransitionClip(clip)) return { head: 0, tail: 0 };
    if (clip.kind === 'image') return { head: Infinity, tail: Infinity };
    const asset = findAsset(assets, clip.assetId);
    if (!asset || number(asset.duration) <= 0) return null;
    const edit = editCore();
    if (edit) return edit.headroom(clip, asset);
    const speed = clamp(clip.speed || 1, 0.01, 100);
    const sourceIn = Math.max(0, number(clip.in));
    const before = sourceIn / speed;
    const after = Math.max(
      0,
      (number(asset.duration) - sourceIn - Math.max(0, number(clip.duration)) * speed) / speed,
    );
    return clip.reverse ? { head: after, tail: before } : { head: before, tail: after };
  }

  function sourceHeadHandleSeconds(clip, assets) {
    const handles = sourceHandles(clip, assets);
    return handles ? handles.head : null;
  }

  function sourceTailHandleSeconds(clip, assets) {
    const handles = sourceHandles(clip, assets);
    return handles ? handles.tail : null;
  }

  function planCrossDissolve(
    clips,
    assets,
    selectedId,
    requestedDuration = 0.5,
    fps = 30,
    requestedType = '',
  ) {
    const pair = findCutPair(clips, selectedId, fps);
    if (!pair.ok) return pair;
    const audioPair = isAudioClip(pair.incoming);
    const types = audioPair ? AUDIO_TYPES : VISUAL_TYPES;
    const transitionType = types.includes(requestedType) ? requestedType : types[0];

    const outgoingTail = sourceTailHandleSeconds(pair.outgoing, assets);
    const incomingHead = sourceHeadHandleSeconds(pair.incoming, assets);
    if (outgoingTail === null || incomingHead === null) {
      return fail(
        'Cross Dissolve needs readable source durations for both video clips. Relink the media and try again.',
      );
    }

    const requested = round(
      clamp(requestedDuration || 0.5, MIN_TRANSITION_SECONDS, MAX_TRANSITION_SECONDS),
    );
    const centeredMaximum = Math.min(
      MAX_TRANSITION_SECONDS,
      Math.max(0, number(pair.outgoing.duration)) * 2,
      Math.max(0, number(pair.incoming.duration)) * 2,
      outgoingTail * 2,
      incomingHead * 2,
    );

    if (centeredMaximum < MIN_TRANSITION_SECONDS) {
      return fail(
        'Cross Dissolve needs source handles on both sides of the cut. Trim the outgoing tail and incoming head to create handles.',
      );
    }
    if (requested > centeredMaximum + pair.tolerance / 2) {
      return Object.freeze({
        ok: false,
        reason: `Cross Dissolve needs ${(requested / 2).toFixed(2)}s of source handle on each side of the cut; this edit safely supports at most ${Math.max(0, centeredMaximum).toFixed(2)}s centered.`,
        maxDuration: round(Math.floor(centeredMaximum * 1000) / 1000),
      });
    }

    const duration = round(Math.min(requested, centeredMaximum));
    const halfDuration = round(duration / 2, 6);
    return Object.freeze({
      ok: true,
      type: 'cross-dissolve',
      transitionType,
      outgoingId: String(pair.outgoing.id),
      incomingId: String(pair.incoming.id),
      track: pair.track,
      cutTime: pair.cutTime,
      startTime: round(pair.cutTime - halfDuration, 6),
      endTime: round(pair.cutTime + halfDuration, 6),
      duration,
      halfDuration,
      gap: pair.gap,
      outgoingTailHandle: Number.isFinite(outgoingTail) ? round(outgoingTail, 6) : null,
      incomingHeadHandle: Number.isFinite(incomingHead) ? round(incomingHead, 6) : null,
    });
  }

  function normalizeCrossDissolve(value) {
    if (!value || typeof value !== 'object') return null;
    const outgoingId = String(value.outgoingId || '').slice(0, 100);
    if (!outgoingId || !/^[a-z0-9][a-z0-9._:-]{0,99}$/i.test(outgoingId)) return null;
    const duration = round(clamp(value.duration, MIN_TRANSITION_SECONDS, MAX_TRANSITION_SECONDS));
    if (duration < MIN_TRANSITION_SECONDS) return null;
    const type = String(value.type || '');
    // Plain dissolves keep the original two-field shape so older projects round-trip unchanged.
    if (!type || type === 'cross-dissolve' || ![...VISUAL_TYPES, ...AUDIO_TYPES].includes(type))
      return Object.freeze({ outgoingId, duration });
    return Object.freeze({ outgoingId, duration, type });
  }

  function resolveCrossDissolveForClip(clip, clips, assets = null) {
    if (!isTransitionClip(clip)) return null;
    const list = Array.isArray(clips) ? clips : [];
    let incoming = null;
    let outgoing = null;
    let metadata = null;
    let role = '';

    const own = normalizeCrossDissolve(clip.crossDissolve);
    if (own) {
      incoming = clip;
      outgoing =
        list.find((candidate) => String(candidate && candidate.id) === own.outgoingId) || null;
      metadata = own;
      role = 'incoming';
    } else {
      incoming =
        list.find((candidate) => {
          const candidateTransition = normalizeCrossDissolve(candidate && candidate.crossDissolve);
          return candidateTransition && candidateTransition.outgoingId === String(clip.id || '');
        }) || null;
      metadata = normalizeCrossDissolve(incoming && incoming.crossDissolve);
      outgoing = clip;
      role = incoming && metadata ? 'outgoing' : '';
    }

    if (!incoming || !outgoing || !metadata || !sameFamily(incoming, outgoing)) return null;
    if (incoming.track !== outgoing.track) return null;
    const cutTime = Math.max(0, number(incoming.start));
    if (Math.abs(cutTime - clipEnd(outgoing)) > 0.002) return null;
    const halfDuration = metadata.duration / 2;
    if (Array.isArray(assets)) {
      const outgoingTail = sourceTailHandleSeconds(outgoing, assets);
      const incomingHead = sourceHeadHandleSeconds(incoming, assets);
      if (outgoingTail === null || incomingHead === null) return null;
      if (outgoingTail + 0.001 < halfDuration || incomingHead + 0.001 < halfDuration) return null;
      if (
        number(outgoing.duration) + 0.001 < halfDuration ||
        number(incoming.duration) + 0.001 < halfDuration
      )
        return null;
    }
    const audioPair = isAudioClip(incoming);
    const type =
      metadata.type && (audioPair ? AUDIO_TYPES : VISUAL_TYPES).includes(metadata.type)
        ? metadata.type
        : audioPair
          ? 'constant-power'
          : 'cross-dissolve';
    return Object.freeze({
      role,
      type,
      incomingId: String(incoming.id),
      outgoingId: String(outgoing.id),
      cutTime,
      duration: metadata.duration,
      startTime: cutTime - halfDuration,
      endTime: cutTime + halfDuration,
    });
  }

  // Everything a compositor needs for one clip at one time during a transition:
  // an alpha multiplier, an optional color veil over the clip, and an optional
  // reveal rectangle (fractions of the frame) for wipes. Null outside transitions.
  function visualTransitionState(clip, time, clips, assets = null) {
    if (!isVisualClip(clip)) return null;
    const transition = resolveCrossDissolveForClip(clip, clips, assets);
    if (!transition) return null;
    const point = number(time);
    if (point < transition.startTime || point >= transition.endTime) return null;
    const progress = clamp(
      (point - transition.startTime) / Math.max(0.000001, transition.duration),
      0,
      1,
    );
    const incoming = transition.role === 'incoming';
    const state = {
      type: transition.type,
      role: transition.role,
      progress: round(progress, 6),
      alpha: 1,
      veil: null,
      reveal: null,
    };
    switch (transition.type) {
      case 'dip-to-black':
      case 'dip-to-white': {
        const color = transition.type === 'dip-to-black' ? '#000000' : '#ffffff';
        const visible = incoming ? progress >= 0.5 : progress < 0.5;
        state.alpha = visible ? 1 : 0;
        state.veil = { color, alpha: round(1 - Math.abs(progress * 2 - 1), 6) };
        break;
      }
      case 'wipe-left':
      case 'wipe-right':
      case 'wipe-up':
      case 'wipe-down':
        if (incoming) {
          const p = round(progress, 6);
          state.reveal = {
            'wipe-left': { x: round(1 - p, 6), y: 0, width: p, height: 1 },
            'wipe-right': { x: 0, y: 0, width: p, height: 1 },
            'wipe-up': { x: 0, y: round(1 - p, 6), width: 1, height: p },
            'wipe-down': { x: 0, y: 0, width: 1, height: p },
          }[transition.type];
        }
        break;
      default:
        state.alpha = incoming ? round(progress, 6) : 1;
    }
    return Object.freeze(state);
  }

  // Audio crossfade gain for a clip at a time (1 outside a crossfade).
  function audioTransitionGain(clip, time, clips, assets = null) {
    if (!isAudioClip(clip)) return 1;
    const transition = resolveCrossDissolveForClip(clip, clips, assets);
    if (!transition) return 1;
    const point = number(time);
    if (point < transition.startTime || point >= transition.endTime) return 1;
    const progress = clamp(
      (point - transition.startTime) / Math.max(0.000001, transition.duration),
      0,
      1,
    );
    const incoming = transition.role === 'incoming';
    if (transition.type === 'constant-gain') return round(incoming ? progress : 1 - progress, 6);
    return round(
      incoming ? Math.sin((progress * Math.PI) / 2) : Math.cos((progress * Math.PI) / 2),
      6,
    );
  }

  function audioActiveAt(clip, time, clips, assets = null) {
    if (!isAudioClip(clip)) return nominalActiveAt(clip, time);
    if (nominalActiveAt(clip, time)) return true;
    const transition = resolveCrossDissolveForClip(clip, clips, assets);
    if (!transition) return false;
    const point = number(time);
    return point >= transition.startTime && point < transition.endTime;
  }

  function nominalActiveAt(clip, time) {
    if (!clip) return false;
    const point = number(time);
    const start = Math.max(0, number(clip.start));
    return point >= start && point < start + Math.max(0, number(clip.duration));
  }

  function visualActiveAt(clip, time, clips, assets = null) {
    if (nominalActiveAt(clip, time)) return true;
    const transition = resolveCrossDissolveForClip(clip, clips, assets);
    if (!transition) return false;
    const point = number(time);
    return point >= transition.startTime && point < transition.endTime;
  }

  function visualEnvelope(clip, time, clips, assets = null, nominalEnvelope = 1) {
    const transition = resolveCrossDissolveForClip(clip, clips, assets);
    if (!transition) return clamp(nominalEnvelope, 0, 1);
    const point = number(time);
    if (point < transition.startTime || point >= transition.endTime)
      return clamp(nominalEnvelope, 0, 1);
    const manualEnvelope = nominalActiveAt(clip, point) ? clamp(nominalEnvelope, 0, 1) : 1;
    if (transition.role === 'outgoing') return manualEnvelope;
    const progress = clamp(
      (point - transition.startTime) / Math.max(0.000001, transition.duration),
      0,
      1,
    );
    return round(manualEnvelope * progress, 6);
  }

  return Object.freeze({
    AUDIO_TYPES,
    MAX_TRANSITION_SECONDS,
    MIN_TRANSITION_SECONDS,
    VISUAL_KINDS,
    VISUAL_TRACKS,
    VISUAL_TYPES,
    audioActiveAt,
    audioTransitionGain,
    findCutPair,
    isAudioClip,
    isTransitionClip,
    isVisualClip,
    normalizeCrossDissolve,
    planCrossDissolve,
    planFadeThroughBackground,
    resolveCrossDissolveForClip,
    round,
    sourceHeadHandleSeconds,
    sourceTailHandleSeconds,
    visualActiveAt,
    visualEnvelope,
    visualTransitionState,
  });
});

/* alcor-video-audio-automation-core */
(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AlcorVideoAudioAutomation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_KEYFRAMES = 200;

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, number(value)));
  }

  function round(value, precision = 6) {
    const power = 10 ** precision;
    return Math.round(number(value) * power) / power;
  }

  function normalizeKeyframe(value, duration, fallbackVolume = 1) {
    if (!value || typeof value !== 'object') return null;
    return Object.freeze({
      time: round(clamp(value.time, 0, Math.max(0, number(duration))), 3),
      volume: clamp(value.volume == null ? fallbackVolume : value.volume, 0, 1),
    });
  }

  function normalizeKeyframes(values, duration, fallbackVolume = 1) {
    const maximum = Math.max(0, number(duration));
    const fallback = clamp(fallbackVolume, 0, 1);
    const byTime = new Map();
    for (const value of Array.isArray(values) ? values.slice(0, MAX_KEYFRAMES * 2) : []) {
      const frame = normalizeKeyframe(value, maximum, fallback);
      if (!frame) continue;
      byTime.set(frame.time.toFixed(3), frame);
    }
    return Array.from(byTime.values())
      .sort((a, b) => a.time - b.time)
      .slice(0, MAX_KEYFRAMES);
  }

  function resolveAtLocalTime(clip, localTime) {
    const base = clamp(clip && clip.volume == null ? 1 : clip && clip.volume, 0, 1);
    const duration = Math.max(0, number(clip && clip.duration));
    const frames = normalizeKeyframes(clip && clip.volumeKeyframes, duration, base);
    if (!frames.length) return base;

    const time = clamp(localTime, 0, duration);
    if (time <= frames[0].time) return frames[0].volume;
    const last = frames[frames.length - 1];
    if (time >= last.time) return last.volume;

    for (let index = 1; index < frames.length; index += 1) {
      const right = frames[index];
      if (time > right.time) continue;
      const left = frames[index - 1];
      const span = Math.max(0.001, right.time - left.time);
      const progress = clamp((time - left.time) / span, 0, 1);
      return round(left.volume + (right.volume - left.volume) * progress, 6);
    }
    return base;
  }

  function resolveAtTime(clip, timelineTime) {
    return resolveAtLocalTime(clip, number(timelineTime) - number(clip && clip.start));
  }

  function upsertKeyframe(values, value, duration, fallbackVolume = 1) {
    const next = normalizeKeyframes(values, duration, fallbackVolume);
    const frame = normalizeKeyframe(value, duration, fallbackVolume);
    if (!frame) return next;
    const filtered = next.filter((item) => Math.abs(item.time - frame.time) > 0.0005);
    filtered.push(frame);
    return normalizeKeyframes(filtered, duration, fallbackVolume);
  }

  function findKeyframeAtTime(values, time, duration, tolerance = 0.05, fallbackVolume = 1) {
    const frames = normalizeKeyframes(values, duration, fallbackVolume);
    const point = clamp(time, 0, Math.max(0, number(duration)));
    const window = Math.max(0.001, number(tolerance, 0.05));
    let nearest = null;
    let distance = window;
    for (const frame of frames) {
      const next = Math.abs(frame.time - point);
      if (next <= distance) {
        nearest = frame;
        distance = next;
      }
    }
    return nearest;
  }

  function removeKeyframe(values, time, duration, tolerance = 0.05, fallbackVolume = 1) {
    const frames = normalizeKeyframes(values, duration, fallbackVolume);
    const target = findKeyframeAtTime(frames, time, duration, tolerance, fallbackVolume);
    if (!target) return frames;
    return frames.filter((frame) => frame.time !== target.time);
  }

  function splitKeyframes(clip, splitLocalTime, leftDuration, rightDuration) {
    const base = clamp(clip && clip.volume == null ? 1 : clip && clip.volume, 0, 1);
    const duration = Math.max(0, number(clip && clip.duration));
    const frames = normalizeKeyframes(clip && clip.volumeKeyframes, duration, base);
    if (!frames.length) return Object.freeze({ left: [], right: [] });

    const split = clamp(splitLocalTime, 0, duration);
    const boundaryVolume = resolveAtLocalTime(clip, split);
    const left = frames
      .filter((frame) => frame.time < split)
      .concat([{ time: Math.max(0, number(leftDuration)), volume: boundaryVolume }]);
    const right = [{ time: 0, volume: boundaryVolume }].concat(
      frames
        .filter((frame) => frame.time > split)
        .map((frame) => ({ time: round(frame.time - split, 3), volume: frame.volume })),
    );
    return Object.freeze({
      left: normalizeKeyframes(left, leftDuration, base),
      right: normalizeKeyframes(right, rightDuration, base),
    });
  }

  return Object.freeze({
    MAX_KEYFRAMES,
    clamp,
    findKeyframeAtTime,
    normalizeKeyframes,
    removeKeyframe,
    resolveAtLocalTime,
    resolveAtTime,
    round,
    splitKeyframes,
    upsertKeyframe,
  });
});

/* alcor-video-color-core */
(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AlcorVideoColor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LIMITS = Object.freeze({
    exposure: Object.freeze({ min: -5, max: 5, neutral: 0 }),
    temperature: Object.freeze({ min: -100, max: 100, neutral: 0 }),
    tint: Object.freeze({ min: -100, max: 100, neutral: 0 }),
    brightness: Object.freeze({ min: -100, max: 100, neutral: 0 }),
    contrast: Object.freeze({ min: -100, max: 100, neutral: 0 }),
    highlights: Object.freeze({ min: -100, max: 100, neutral: 0 }),
    shadows: Object.freeze({ min: -100, max: 100, neutral: 0 }),
    whites: Object.freeze({ min: -100, max: 100, neutral: 0 }),
    blacks: Object.freeze({ min: -100, max: 100, neutral: 0 }),
    saturation: Object.freeze({ min: 0, max: 200, neutral: 100 }),
  });
  const SOFTWARE_FALLBACK_MAX_PIXELS = 524288;
  const SOFTWARE_FALLBACK_FRAME_BUDGET_MS = 50;
  const SOFTWARE_FALLBACK_SLOW_FRAME_LIMIT = 3;
  const SOFTWARE_FALLBACK_STILL_CACHE_ENTRIES = 4;
  let nativeFilterSupport = null;
  let scratchCanvas = null;
  let runtimeStates = new WeakMap();
  let compatibilitySignatures = new WeakMap();
  const stillCache = new Map();

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function clamp(value, min, max, fallback = min) {
    return Math.min(max, Math.max(min, number(value, fallback)));
  }

  function round(value, precision = 3) {
    const power = 10 ** precision;
    return Math.round(number(value) * power) / power;
  }

  function smoothstep(edge0, edge1, value) {
    if (edge0 === edge1) return value >= edge1 ? 1 : 0;
    const t = clamp((value - edge0) / (edge1 - edge0), 0, 1, 0);
    return t * t * (3 - 2 * t);
  }

  function neutralColor() {
    return {
      exposure: 0,
      temperature: 0,
      tint: 0,
      brightness: 0,
      contrast: 0,
      highlights: 0,
      shadows: 0,
      whites: 0,
      blacks: 0,
      saturation: 100,
    };
  }

  function normalizeColor(value) {
    const source = value && typeof value === 'object' ? value : {};
    const normalized = {};
    for (const [name, limit] of Object.entries(LIMITS)) {
      normalized[name] = round(clamp(source[name], limit.min, limit.max, limit.neutral));
    }
    return normalized;
  }

  function isNeutral(value) {
    const color = normalizeColor(value);
    return Object.entries(LIMITS).every(([name, limit]) => color[name] === limit.neutral);
  }

  function requiresSoftware(value) {
    const color = normalizeColor(value);
    return (
      color.temperature !== 0 ||
      color.tint !== 0 ||
      color.highlights !== 0 ||
      color.shadows !== 0 ||
      color.whites !== 0 ||
      color.blacks !== 0
    );
  }

  function percent(value) {
    return String(round(value, 3));
  }

  function exposureMultiplier(value) {
    return 2 ** normalizeColor(value).exposure;
  }

  function toCanvasFilter(value) {
    const color = normalizeColor(value);
    if (isNeutral(color)) return 'none';
    const brightnessPercent = (100 + color.brightness) * exposureMultiplier(color);
    return [
      `brightness(${percent(brightnessPercent)}%)`,
      `contrast(${percent(100 + color.contrast)}%)`,
      `saturate(${percent(color.saturation)}%)`,
    ].join(' ');
  }

  function toneWeights(luminance) {
    const level = clamp(luminance / 255, 0, 1, 0);
    return {
      shadows: 1 - smoothstep(0, 0.55, level),
      highlights: smoothstep(0.45, 1, level),
      blacks: 1 - smoothstep(0, 0.25, level),
      whites: smoothstep(0.75, 1, level),
    };
  }

  function tonalDelta(luminance, color) {
    const weights = toneWeights(luminance);
    return (
      64 * (color.shadows / 100) * weights.shadows +
      64 * (color.highlights / 100) * weights.highlights +
      48 * (color.blacks / 100) * weights.blacks +
      48 * (color.whites / 100) * weights.whites
    );
  }

  function applyToRgba(data, value) {
    if (!data || typeof data.length !== 'number') return data;
    const color = normalizeColor(value);
    if (isNeutral(color)) return data;
    const brightness = ((100 + color.brightness) / 100) * exposureMultiplier(color);
    const contrast = (100 + color.contrast) / 100;
    const saturation = color.saturation / 100;
    const temperature = color.temperature / 100;
    const tint = color.tint / 100;
    for (let index = 0; index + 3 < data.length; index += 4) {
      let red = data[index] * brightness;
      let green = data[index + 1] * brightness;
      let blue = data[index + 2] * brightness;

      if (temperature !== 0 || tint !== 0) {
        const level = clamp(Math.max(red, green, blue) / 255, 0, 1, 0);
        red += (32 * temperature + 16 * tint) * level;
        green -= 32 * tint * level;
        blue += (-32 * temperature + 16 * tint) * level;
      }

      red = (red - 127.5) * contrast + 127.5;
      green = (green - 127.5) * contrast + 127.5;
      blue = (blue - 127.5) * contrast + 127.5;

      if (
        color.highlights !== 0 ||
        color.shadows !== 0 ||
        color.whites !== 0 ||
        color.blacks !== 0
      ) {
        const luminance = 0.213 * red + 0.715 * green + 0.072 * blue;
        const delta = tonalDelta(luminance, color);
        red += delta;
        green += delta;
        blue += delta;
      }

      if (saturation !== 1) {
        const luminance = 0.213 * red + 0.715 * green + 0.072 * blue;
        red = luminance + (red - luminance) * saturation;
        green = luminance + (green - luminance) * saturation;
        blue = luminance + (blue - luminance) * saturation;
      }

      data[index] = red;
      data[index + 1] = green;
      data[index + 2] = blue;
    }
    return data;
  }

  function fallbackDimensions(width, height, maxPixels = SOFTWARE_FALLBACK_MAX_PIXELS) {
    const sourceWidth = Math.max(1, Math.round(Math.abs(number(width, 1))));
    const sourceHeight = Math.max(1, Math.round(Math.abs(number(height, 1))));
    const budget = Math.max(1, Math.floor(number(maxPixels, SOFTWARE_FALLBACK_MAX_PIXELS)));
    const pixels = sourceWidth * sourceHeight;
    if (pixels <= budget) return { width: sourceWidth, height: sourceHeight };
    const scale = Math.sqrt(budget / pixels);
    return {
      width: Math.max(1, Math.floor(sourceWidth * scale)),
      height: Math.max(1, Math.floor(sourceHeight * scale)),
    };
  }

  function recordSoftwareFallbackFrame(
    state,
    elapsedMs,
    frameBudgetMs = SOFTWARE_FALLBACK_FRAME_BUDGET_MS,
    slowFrameLimit = SOFTWARE_FALLBACK_SLOW_FRAME_LIMIT,
  ) {
    const previous = state && typeof state === 'object' ? state : {};
    const budgetMs = Math.max(1, number(frameBudgetMs, SOFTWARE_FALLBACK_FRAME_BUDGET_MS));
    const limit = Math.max(
      1,
      Math.min(12, Math.floor(number(slowFrameLimit, SOFTWARE_FALLBACK_SLOW_FRAME_LIMIT))),
    );
    const elapsed = Math.max(0, number(elapsedMs));
    const slowFrames = elapsed > budgetMs ? Math.max(0, number(previous.slowFrames)) + 1 : 0;
    return {
      ...previous,
      processedFrames: Math.max(0, number(previous.processedFrames)) + 1,
      slowFrames,
      blocked: slowFrames >= limit,
      lastElapsedMs: round(elapsed, 3),
      maxElapsedMs: round(Math.max(Math.max(0, number(previous.maxElapsedMs)), elapsed), 3),
      frameBudgetMs: budgetMs,
      slowFrameLimit: limit,
    };
  }

  function canvasFilterSupported() {
    if (nativeFilterSupport !== null) return nativeFilterSupport;
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      nativeFilterSupport = false;
      return nativeFilterSupport;
    }
    try {
      const source = document.createElement('canvas');
      source.width = 1;
      source.height = 1;
      const sourceContext = source.getContext('2d');
      const output = document.createElement('canvas');
      output.width = 1;
      output.height = 1;
      const outputContext = output.getContext('2d', { willReadFrequently: true });
      if (!sourceContext || !outputContext || !('filter' in outputContext)) {
        nativeFilterSupport = false;
        return nativeFilterSupport;
      }
      sourceContext.fillStyle = '#ff0000';
      sourceContext.fillRect(0, 0, 1, 1);
      outputContext.filter = 'brightness(50%)';
      outputContext.drawImage(source, 0, 0);
      const red = outputContext.getImageData(0, 0, 1, 1).data[0];
      nativeFilterSupport = red >= 120 && red <= 135;
    } catch (_) {
      nativeFilterSupport = false;
    }
    return nativeFilterSupport;
  }

  function getScratchCanvas(width, height) {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function')
      return null;
    if (!scratchCanvas) scratchCanvas = document.createElement('canvas');
    if (scratchCanvas.width !== width) scratchCanvas.width = width;
    if (scratchCanvas.height !== height) scratchCanvas.height = height;
    return scratchCanvas;
  }

  function createCanvas(width, height) {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function')
      return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  function mediaTag(media) {
    return String(media?.tagName || media?.nodeName || '').toUpperCase();
  }

  function isCacheableStill(media) {
    return mediaTag(media) === 'IMG' && media?.complete !== false;
  }

  function colorKey(color) {
    const normalized = normalizeColor(color);
    return Object.keys(LIMITS)
      .map((name) => normalized[name])
      .join('|');
  }

  function mediaSourceKey(media) {
    if (!media) return '';
    return String(
      media.currentSrc ||
        media.src ||
        `${number(media.naturalWidth)}x${number(media.naturalHeight)}`,
    );
  }

  function fallbackKey(media, width, height, color) {
    return `${mediaSourceKey(media)}|${width}x${height}|${colorKey(color)}`;
  }

  function getCachedStill(media, key) {
    const entry = stillCache.get(media);
    if (!entry || entry.key !== key || !entry.canvas) return null;
    stillCache.delete(media);
    stillCache.set(media, entry);
    return entry.canvas;
  }

  function setCachedStill(media, key, canvas) {
    if (!media || !canvas) return;
    stillCache.delete(media);
    stillCache.set(media, { key, canvas });
    while (stillCache.size > SOFTWARE_FALLBACK_STILL_CACHE_ENTRIES) {
      const oldest = stillCache.keys().next().value;
      stillCache.delete(oldest);
    }
  }

  function clearSoftwareFallbackState(media) {
    if (media && (typeof media === 'object' || typeof media === 'function')) {
      runtimeStates.delete(media);
      compatibilitySignatures.delete(media);
      stillCache.delete(media);
      return;
    }
    runtimeStates = new WeakMap();
    compatibilitySignatures = new WeakMap();
    stillCache.clear();
  }

  function softwareFallbackDiagnostics(media) {
    const state = media && runtimeStates.get(media);
    return state
      ? { ...state }
      : {
          processedFrames: 0,
          cacheHits: 0,
          slowFrames: 0,
          blocked: false,
          lastElapsedMs: 0,
          maxElapsedMs: 0,
          frameBudgetMs: SOFTWARE_FALLBACK_FRAME_BUDGET_MS,
          slowFrameLimit: SOFTWARE_FALLBACK_SLOW_FRAME_LIMIT,
        };
  }

  function emitCompatibility(media, detail) {
    if (!media || typeof document === 'undefined' || typeof CustomEvent !== 'function') return;
    const editor = document.querySelector('[data-alcor-video-editor]');
    if (!editor) return;
    const payload = {
      mode: String(detail?.mode || ''),
      blocked: detail?.blocked === true,
      frameBudgetMs: Math.max(1, number(detail?.frameBudgetMs, SOFTWARE_FALLBACK_FRAME_BUDGET_MS)),
      slowFrameLimit: Math.max(
        1,
        Math.floor(number(detail?.slowFrameLimit, SOFTWARE_FALLBACK_SLOW_FRAME_LIMIT)),
      ),
      maxPixels: SOFTWARE_FALLBACK_MAX_PIXELS,
      cacheHit: detail?.cacheHit === true,
    };
    const signature = `${payload.mode}|${payload.blocked}|${payload.frameBudgetMs}|${payload.slowFrameLimit}|${payload.cacheHit}`;
    if (compatibilitySignatures.get(media) === signature) return;
    compatibilitySignatures.set(media, signature);
    editor.dispatchEvent(new CustomEvent('alcorvideo:color-compatibility', { detail: payload }));
  }

  function runtimeOptions(options) {
    const source = options && typeof options === 'object' ? options : {};
    return {
      forceSoftware: source.forceSoftware === true,
      frameBudgetMs: Math.max(1, number(source.frameBudgetMs, SOFTWARE_FALLBACK_FRAME_BUDGET_MS)),
      slowFrameLimit: Math.max(
        1,
        Math.min(12, Math.floor(number(source.slowFrameLimit, SOFTWARE_FALLBACK_SLOW_FRAME_LIMIT))),
      ),
      now:
        typeof source.now === 'function'
          ? source.now
          : () =>
              typeof performance !== 'undefined' && typeof performance.now === 'function'
                ? performance.now()
                : Date.now(),
    };
  }

  function stateFor(media, key, options) {
    let state = runtimeStates.get(media);
    if (!state || state.key !== key) {
      state = {
        key,
        processedFrames: 0,
        cacheHits: 0,
        slowFrames: 0,
        blocked: false,
        lastElapsedMs: 0,
        maxElapsedMs: 0,
        frameBudgetMs: options.frameBudgetMs,
        slowFrameLimit: options.slowFrameLimit,
      };
      runtimeStates.set(media, state);
    }
    return state;
  }

  function drawCorrectedCanvas(context, canvas, x, y, width, height) {
    const canFilter = context && 'filter' in context;
    const previousFilter = canFilter ? context.filter : null;
    try {
      if (canFilter) context.filter = 'none';
      context.drawImage(canvas, x, y, width, height);
      return true;
    } finally {
      if (canFilter) context.filter = previousFilter;
    }
  }

  function drawImageWithColor(context, media, x, y, width, height, value, options) {
    if (!context || !media) return false;
    const color = normalizeColor(value);
    const settings = runtimeOptions(options);
    try {
      if (isNeutral(color)) {
        runtimeStates.delete(media);
        emitCompatibility(media, { mode: 'neutral', blocked: false });
        context.drawImage(media, x, y, width, height);
        return true;
      }
      if (!settings.forceSoftware && !requiresSoftware(color) && canvasFilterSupported()) {
        runtimeStates.delete(media);
        emitCompatibility(media, { mode: 'native', blocked: false });
        context.filter = toCanvasFilter(color);
        context.drawImage(media, x, y, width, height);
        return true;
      }

      const size = fallbackDimensions(width, height);
      const key = fallbackKey(media, size.width, size.height, color);
      const state = stateFor(media, key, settings);
      if (state.blocked) {
        emitCompatibility(media, state);
        return false;
      }

      if (isCacheableStill(media)) {
        const cached = getCachedStill(media, key);
        if (cached) {
          state.cacheHits += 1;
          runtimeStates.set(media, state);
          emitCompatibility(media, { ...state, mode: 'software-cache', cacheHit: true });
          return drawCorrectedCanvas(context, cached, x, y, width, height);
        }
      }

      const canvas = isCacheableStill(media)
        ? createCanvas(size.width, size.height)
        : getScratchCanvas(size.width, size.height);
      const scratch = canvas?.getContext('2d', { alpha: true, willReadFrequently: true });
      if (!canvas || !scratch) return false;
      const started = number(settings.now());
      scratch.clearRect(0, 0, size.width, size.height);
      scratch.drawImage(media, 0, 0, size.width, size.height);
      const pixels = scratch.getImageData(0, 0, size.width, size.height);
      applyToRgba(pixels.data, color);
      scratch.putImageData(pixels, 0, 0);
      const elapsedMs = Math.max(0, number(settings.now()) - started);

      if (isCacheableStill(media)) {
        const next = {
          ...state,
          processedFrames: state.processedFrames + 1,
          slowFrames: 0,
          blocked: false,
          lastElapsedMs: round(elapsedMs, 3),
          maxElapsedMs: round(Math.max(state.maxElapsedMs, elapsedMs), 3),
        };
        runtimeStates.set(media, next);
        setCachedStill(media, key, canvas);
        emitCompatibility(media, { ...next, mode: 'software-cache', cacheHit: false });
        return drawCorrectedCanvas(context, canvas, x, y, width, height);
      }

      const next = recordSoftwareFallbackFrame(
        state,
        elapsedMs,
        settings.frameBudgetMs,
        settings.slowFrameLimit,
      );
      next.key = key;
      next.cacheHits = state.cacheHits;
      runtimeStates.set(media, next);
      if (next.blocked) {
        emitCompatibility(media, { ...next, mode: 'software' });
        return false;
      }
      emitCompatibility(media, { ...next, mode: 'software' });
      return drawCorrectedCanvas(context, canvas, x, y, width, height);
    } catch (_) {
      return false;
    }
  }

  return Object.freeze({
    LIMITS,
    SOFTWARE_FALLBACK_FRAME_BUDGET_MS,
    SOFTWARE_FALLBACK_MAX_PIXELS,
    SOFTWARE_FALLBACK_SLOW_FRAME_LIMIT,
    SOFTWARE_FALLBACK_STILL_CACHE_ENTRIES,
    applyToRgba,
    canvasFilterSupported,
    clearSoftwareFallbackState,
    drawImageWithColor,
    fallbackDimensions,
    isNeutral,
    neutralColor,
    normalizeColor,
    recordSoftwareFallbackFrame,
    requiresSoftware,
    softwareFallbackDiagnostics,
    tonalDelta,
    toneWeights,
    toCanvasFilter,
  });
});
/* alcor-video-effects-core */
(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AlcorVideoEffects = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Clip effect data, pure and small: the per-clip video effect stack (blur, sharpen,
  // crop, keying, black & white, invert, flip, vignette, drop shadow), blend mode and
  // anchor point, effect keyframes, time-remap speed ramps and per-clip audio effects.
  // The pixel work lives in alcor-video-effects-render.js (lazy); this file only
  // describes, validates and interpolates, so projects round-trip without it loaded.

  const LIMITS = Object.freeze({
    maxEffects: 16,
    maxKeyframes: 120,
    maxRemapPoints: 32,
    minRemapSpeed: 0.1,
    maxRemapSpeed: 16,
  });

  // Parameter definitions: [min, max, default, keyframeable]. Distances are sequence pixels.
  const EFFECT_TYPES = Object.freeze({
    'gaussian-blur': { label: 'Gaussian Blur', params: { amount: [0, 200, 12, true] } },
    sharpen: { label: 'Sharpen', params: { amount: [0, 100, 30, true] } },
    crop: {
      label: 'Crop',
      params: {
        left: [0, 100, 0, true],
        right: [0, 100, 0, true],
        top: [0, 100, 0, true],
        bottom: [0, 100, 0, true],
        feather: [0, 200, 0, true],
      },
    },
    'ultra-key': {
      label: 'Ultra Key',
      params: {
        color: ['color', '#00ff00'],
        tolerance: [0, 100, 30, false],
        softness: [0, 100, 12, false],
        spill: [0, 100, 50, false],
      },
    },
    'black-white': { label: 'Black & White', params: { amount: [0, 100, 100, true] } },
    invert: { label: 'Invert', params: { amount: [0, 100, 100, true] } },
    flip: {
      label: 'Mirror / Flip',
      params: {
        mode: [
          'choice',
          'horizontal',
          [
            'horizontal',
            'vertical',
            'both',
            'mirror-left',
            'mirror-right',
            'mirror-top',
            'mirror-bottom',
          ],
        ],
      },
    },
    vignette: {
      label: 'Vignette',
      params: {
        amount: [-100, 100, -50, true],
        midpoint: [0, 100, 50, false],
        feather: [1, 100, 50, false],
        roundness: [0, 100, 100, false],
      },
    },
    'drop-shadow': {
      label: 'Drop Shadow',
      params: {
        color: ['color', '#000000'],
        opacity: [0, 100, 60, true],
        direction: [0, 360, 135, false],
        distance: [0, 200, 12, true],
        softness: [0, 200, 18, true],
      },
    },
  });
  // Effects that change pixels inside the layer (run by the renderer, in stack order).
  const PIXEL_EFFECTS = Object.freeze([
    'gaussian-blur',
    'sharpen',
    'crop',
    'ultra-key',
    'black-white',
    'invert',
    'flip',
    'vignette',
  ]);

  // Premiere blend mode -> canvas globalCompositeOperation (W3C compositing names).
  const BLEND_MODES = Object.freeze({
    normal: 'source-over',
    darken: 'darken',
    multiply: 'multiply',
    'color-burn': 'color-burn',
    lighten: 'lighten',
    screen: 'screen',
    'color-dodge': 'color-dodge',
    add: 'lighter',
    overlay: 'overlay',
    'soft-light': 'soft-light',
    'hard-light': 'hard-light',
    difference: 'difference',
    exclusion: 'exclusion',
    hue: 'hue',
    saturation: 'saturation',
    color: 'color',
    luminosity: 'luminosity',
  });

  const EASES = Object.freeze(['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold']);

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, number(value, min)));
  }
  function round(value, precision = 4) {
    const p = 10 ** precision;
    return Math.round(number(value) * p) / p;
  }
  function hex(value, fallback) {
    return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value).toLowerCase() : fallback;
  }

  function ease(name, t) {
    const x = clamp(t, 0, 1);
    switch (name) {
      case 'ease-in':
        return x * x * x;
      case 'ease-out':
        return 1 - Math.pow(1 - x, 3);
      case 'ease-in-out':
        return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
      case 'hold':
        return x >= 1 ? 1 : 0;
      default:
        return x;
    }
  }

  // ---------------------------------------------------------------- params

  function normalizeParam(spec, value) {
    if (spec[0] === 'color') return hex(value, spec[1]);
    if (spec[0] === 'choice') return spec[2].includes(value) ? value : spec[1];
    return round(clamp(value == null ? spec[2] : value, spec[0], spec[1]), 3);
  }

  function defaultParams(type) {
    const definition = EFFECT_TYPES[type];
    if (!definition) return null;
    const out = {};
    for (const [name, spec] of Object.entries(definition.params))
      out[name] = normalizeParam(spec, undefined);
    return out;
  }

  function keyframeableParams(type) {
    const definition = EFFECT_TYPES[type];
    return definition
      ? Object.keys(definition.params).filter((name) => definition.params[name][3] === true)
      : [];
  }

  function normalizeParams(type, input) {
    const definition = EFFECT_TYPES[type];
    const source = input && typeof input === 'object' ? input : {};
    const out = {};
    for (const [name, spec] of Object.entries(definition.params))
      out[name] = normalizeParam(spec, source[name]);
    return out;
  }

  function normalizeEffectKeyframes(type, frames, duration) {
    if (!Array.isArray(frames)) return [];
    const names = keyframeableParams(type);
    if (!names.length) return [];
    const definition = EFFECT_TYPES[type];
    const end = Math.max(0, number(duration));
    const byTime = new Map();
    for (const frame of frames.slice(0, LIMITS.maxKeyframes * 2)) {
      if (!frame || typeof frame !== 'object') continue;
      const time = round(clamp(frame.time, 0, end), 3);
      const params = {};
      const source = frame.params && typeof frame.params === 'object' ? frame.params : {};
      for (const name of names)
        params[name] = normalizeParam(definition.params[name], source[name]);
      const out = { time, params };
      if (EASES.includes(frame.ease) && frame.ease !== 'linear') out.ease = frame.ease;
      byTime.set(time, out);
    }
    return [...byTime.values()].sort((a, b) => a.time - b.time).slice(0, LIMITS.maxKeyframes);
  }

  function normalizeEffect(input, duration, index = 0) {
    if (!input || typeof input !== 'object' || !EFFECT_TYPES[input.type]) return null;
    const id = /^[a-z0-9][a-z0-9._:-]{0,63}$/i.test(String(input.id || ''))
      ? String(input.id)
      : `fx-${index + 1}`;
    const effect = { id, type: input.type, params: normalizeParams(input.type, input.params) };
    if (input.enabled === false) effect.enabled = false;
    const keyframes = normalizeEffectKeyframes(input.type, input.keyframes, duration);
    if (keyframes.length) effect.keyframes = keyframes;
    return effect;
  }

  // A free id from a trimmed base plus a counter. At most maxEffects ids are taken, so
  // maxEffects + 1 distinct candidates always contain a free one; the loop is bounded.
  function uniqueId(base, seen, index) {
    for (let n = 2; n <= LIMITS.maxEffects + 2; n++) {
      const id = `${base.slice(0, 63 - String(n).length)}-${n}`;
      if (!seen.has(id)) return id;
    }
    return `fx-${index + 1}`;
  }

  function normalizeEffects(list, duration) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];
    for (const item of list.slice(0, LIMITS.maxEffects)) {
      const effect = normalizeEffect(item, duration, out.length);
      if (!effect) continue;
      if (seen.has(effect.id)) effect.id = uniqueId(effect.id, seen, out.length);
      seen.add(effect.id);
      out.push(effect);
    }
    return out;
  }

  function createEffect(type, makeId, params = {}) {
    if (!EFFECT_TYPES[type]) return null;
    const id = typeof makeId === 'function' ? String(makeId('fx')).slice(0, 64) : `fx-${type}`;
    return {
      id: /^[a-z0-9][a-z0-9._:-]{0,63}$/i.test(id) ? id : `fx-${type}`,
      type,
      params: normalizeParams(type, Object.assign(defaultParams(type), params)),
    };
  }

  // Effect values at a local clip time: static params, with keyframed ones interpolated.
  function resolveEffectParams(effect, localTime) {
    const params = Object.assign({}, effect.params);
    const frames = Array.isArray(effect.keyframes) ? effect.keyframes : [];
    if (!frames.length) return params;
    const time = number(localTime);
    let values;
    if (time <= frames[0].time) values = frames[0].params;
    else if (time >= frames[frames.length - 1].time) values = frames[frames.length - 1].params;
    else {
      for (let index = 1; index < frames.length; index += 1) {
        const right = frames[index];
        if (time > right.time) continue;
        const left = frames[index - 1];
        const progress = ease(
          left.ease,
          (time - left.time) / Math.max(0.001, right.time - left.time),
        );
        values = {};
        for (const name of Object.keys(right.params))
          values[name] = round(
            left.params[name] + (right.params[name] - left.params[name]) * progress,
            4,
          );
        break;
      }
    }
    return Object.assign(params, values || {});
  }

  function activeEffects(clip, localTime) {
    const list = clip && Array.isArray(clip.effects) ? clip.effects : [];
    return list
      .filter((effect) => effect && effect.enabled !== false && EFFECT_TYPES[effect.type])
      .map((effect) => ({
        id: effect.id,
        type: effect.type,
        params: resolveEffectParams(effect, localTime),
      }));
  }

  // True when an effect actually changes the picture (skip the renderer otherwise).
  function isEffective(effect) {
    const p = effect.params || {};
    switch (effect.type) {
      case 'gaussian-blur':
      case 'sharpen':
      case 'black-white':
      case 'invert':
        return p.amount > 0;
      case 'crop':
        return p.left > 0 || p.right > 0 || p.top > 0 || p.bottom > 0;
      case 'vignette':
        return p.amount !== 0;
      case 'drop-shadow':
        return p.opacity > 0;
      default:
        return true;
    }
  }

  function upsertEffectKeyframe(effect, localTime, duration, values) {
    const names = keyframeableParams(effect.type);
    if (!names.length) return effect.keyframes || [];
    const current = resolveEffectParams(effect, localTime);
    const params = {};
    for (const name of names)
      params[name] = values && values[name] != null ? values[name] : current[name];
    const frames = (effect.keyframes || []).filter(
      (frame) => Math.abs(frame.time - localTime) > 0.0005,
    );
    frames.push({ time: localTime, params });
    return normalizeEffectKeyframes(effect.type, frames, duration);
  }

  function removeEffectKeyframe(effect, localTime, tolerance = 0.05) {
    return (effect.keyframes || []).filter((frame) => Math.abs(frame.time - localTime) > tolerance);
  }

  // Keep [fromLocal, toLocal] of a clip's effect keyframes (trims and razor cuts).
  function sliceEffects(effects, fromLocal, toLocal) {
    if (!Array.isArray(effects)) return effects;
    const from = number(fromLocal);
    const to = number(toLocal);
    const length = Math.max(0, to - from);
    return effects.map((effect) => {
      if (!effect || !Array.isArray(effect.keyframes) || !effect.keyframes.length) return effect;
      const startValues = resolveEffectParams({ params: {}, keyframes: effect.keyframes }, from);
      const endValues = resolveEffectParams({ params: {}, keyframes: effect.keyframes }, to);
      const inside = effect.keyframes
        .filter((frame) => frame.time > from + 0.0005 && frame.time < to - 0.0005)
        .map((frame) => Object.assign({}, frame, { time: round(frame.time - from, 3) }));
      const before = effect.keyframes.filter((frame) => frame.time <= from + 0.0005).pop();
      const head = { time: 0, params: startValues };
      if (before && before.ease) head.ease = before.ease;
      const keyframes = [head, ...inside, { time: round(length, 3), params: endValues }];
      return Object.assign({}, effect, {
        keyframes: normalizeEffectKeyframes(effect.type, keyframes, length),
      });
    });
  }

  function scaleEffectKeyframes(effects, ratio) {
    if (!Array.isArray(effects)) return effects;
    return effects.map((effect) =>
      effect && Array.isArray(effect.keyframes) && effect.keyframes.length
        ? Object.assign({}, effect, {
            keyframes: effect.keyframes.map((frame) =>
              Object.assign({}, frame, { time: round(frame.time * ratio, 3) }),
            ),
          })
        : effect,
    );
  }

  function normalizeBlendMode(value) {
    return Object.prototype.hasOwnProperty.call(BLEND_MODES, value) ? value : 'normal';
  }
  function compositeOperation(mode) {
    return BLEND_MODES[normalizeBlendMode(mode)];
  }

  // Motion anchor point in percent of the layer (50/50 is the center).
  function normalizeAnchor(clip) {
    return {
      anchorX: round(clamp(clip && clip.anchorX != null ? clip.anchorX : 50, -100, 200), 3),
      anchorY: round(clamp(clip && clip.anchorY != null ? clip.anchorY : 50, -100, 200), 3),
    };
  }

  // Drop shadow offset in sequence pixels: direction 0 = up, clockwise, like Premiere.
  function shadowOffset(params) {
    const radians = (number(params.direction, 135) * Math.PI) / 180;
    const distance = number(params.distance);
    return {
      x: round(Math.sin(radians) * distance, 4),
      y: round(-Math.cos(radians) * distance, 4),
    };
  }

  // ---------------------------------------------------------- time remap
  // A speed ramp: points { time (local clip seconds), speed } with speed linear
  // between points and constant outside them. Source position is the integral.

  function normalizeTimeRemap(points, duration) {
    if (!Array.isArray(points)) return null;
    const end = Math.max(0, number(duration));
    const byTime = new Map();
    for (const point of points.slice(0, LIMITS.maxRemapPoints * 2)) {
      if (!point || typeof point !== 'object') continue;
      const time = round(clamp(point.time, 0, end), 3);
      byTime.set(time, {
        time,
        speed: round(clamp(point.speed, LIMITS.minRemapSpeed, LIMITS.maxRemapSpeed), 4),
      });
    }
    const list = [...byTime.values()]
      .sort((a, b) => a.time - b.time)
      .slice(0, LIMITS.maxRemapPoints);
    return list.length >= 2 ? list : null;
  }

  function remapSpeedAt(points, localTime) {
    if (!points || !points.length) return 1;
    const t = number(localTime);
    if (t <= points[0].time) return points[0].speed;
    const last = points[points.length - 1];
    if (t >= last.time) return last.speed;
    for (let index = 1; index < points.length; index += 1) {
      const right = points[index];
      if (t > right.time) continue;
      const left = points[index - 1];
      const span = Math.max(1e-6, right.time - left.time);
      return left.speed + ((right.speed - left.speed) * (t - left.time)) / span;
    }
    return last.speed;
  }

  // Source seconds consumed from local time 0 to localTime (exact trapezoid integral).
  function remapOffset(points, localTime) {
    const t = number(localTime);
    if (!points || !points.length) return t;
    let total = 0;
    let cursor = Math.min(0, t);
    const segment = (a, b) => {
      if (b <= a) return 0;
      return ((b - a) * (remapSpeedAt(points, a) + remapSpeedAt(points, b))) / 2;
    };
    // Breakpoints keep each piece linear, so the trapezoid rule is exact.
    const stops = points.map((point) => point.time).filter((time) => time > 0 && time < t);
    for (const stop of stops) {
      total += segment(cursor, stop);
      cursor = stop;
    }
    total += segment(cursor, t);
    if (t < 0) total = t * points[0].speed;
    return total;
  }

  // Local time at which `offset` source seconds have been consumed (inverse of remapOffset).
  function remapLocalForOffset(points, offset, duration) {
    let lo = 0;
    let hi = Math.max(0, number(duration));
    for (let step = 0; step < 50; step += 1) {
      const mid = (lo + hi) / 2;
      if (remapOffset(points, mid) < offset) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  // Remap points restricted to [from, to] of the clip, re-based at 0.
  function sliceTimeRemap(points, fromLocal, toLocal) {
    if (!points || !points.length) return points || null;
    const from = number(fromLocal);
    const to = number(toLocal);
    const inside = points
      .filter((point) => point.time > from + 0.0005 && point.time < to - 0.0005)
      .map((point) => ({ time: round(point.time - from, 3), speed: point.speed }));
    return normalizeTimeRemap(
      [
        { time: 0, speed: remapSpeedAt(points, from) },
        ...inside,
        { time: round(to - from, 3), speed: remapSpeedAt(points, to) },
      ],
      to - from,
    );
  }

  function scaleTimeRemap(points, ratio) {
    return points
      ? points.map((point) => ({ time: round(point.time * ratio, 3), speed: point.speed }))
      : points;
  }

  // ---------------------------------------------------------- audio effects

  const AUDIO_FX = Object.freeze({
    eq: {
      lowGain: [-24, 24, 0],
      lowFreq: [20, 1000, 120],
      midGain: [-24, 24, 0],
      midFreq: [100, 12000, 1000],
      midQ: [0.1, 18, 1],
      highGain: [-24, 24, 0],
      highFreq: [1000, 20000, 8000],
    },
    highpass: { freq: [20, 2000, 80] },
    lowpass: { freq: [500, 20000, 12000] },
    gate: { threshold: [-90, 0, -45], attack: [0.1, 200, 2], release: [5, 2000, 120] },
    compressor: {
      threshold: [-60, 0, -18],
      ratio: [1, 20, 4],
      attack: [0, 1000, 5],
      release: [10, 2000, 150],
      knee: [0, 40, 6],
      makeup: [0, 24, 0],
    },
  });
  const AUDIO_FX_ORDER = Object.freeze(['highpass', 'lowpass', 'eq', 'gate', 'compressor']);

  function normalizeAudioFx(value) {
    if (!value || typeof value !== 'object') return null;
    const out = {};
    for (const name of AUDIO_FX_ORDER) {
      const section = value[name];
      if (!section || typeof section !== 'object' || section.enabled === false) continue;
      const params = {};
      for (const [key, [min, max, fallback]] of Object.entries(AUDIO_FX[name]))
        params[key] = round(clamp(section[key] == null ? fallback : section[key], min, max), 3);
      out[name] = params;
    }
    return Object.keys(out).length ? out : null;
  }

  function defaultAudioFx(name) {
    const spec = AUDIO_FX[name];
    if (!spec) return null;
    return Object.fromEntries(Object.entries(spec).map(([key, [, , fallback]]) => [key, fallback]));
  }

  // ---------------------------------------------------------- clip helpers

  // Normalize every effect-related field of a loaded clip (missing fields stay absent).
  function normalizeClipEffects(clip, source, duration) {
    const input = source && typeof source === 'object' ? source : {};
    delete clip.effects;
    delete clip.blendMode;
    delete clip.anchorX;
    delete clip.anchorY;
    delete clip.timeRemap;
    delete clip.audioFx;
    delete clip.preservePitch;
    if (clip.kind === 'video' || clip.kind === 'image') {
      const effects = normalizeEffects(input.effects, duration);
      if (effects.length) clip.effects = effects;
      const blend = normalizeBlendMode(input.blendMode);
      if (blend !== 'normal') clip.blendMode = blend;
      const anchor = normalizeAnchor(input);
      if (anchor.anchorX !== 50 || anchor.anchorY !== 50) Object.assign(clip, anchor);
    }
    if ((clip.kind === 'video' || clip.kind === 'audio') && clip.hold == null && !clip.reverse) {
      const remap = normalizeTimeRemap(input.timeRemap, duration);
      if (remap) clip.timeRemap = remap;
    }
    if (clip.kind === 'audio') {
      const fx = normalizeAudioFx(input.audioFx);
      if (fx) clip.audioFx = fx;
      if (input.preservePitch === true) clip.preservePitch = true;
    }
    return clip;
  }

  function hasPixelEffects(clip, localTime) {
    return activeEffects(clip, localTime).some(
      (effect) => PIXEL_EFFECTS.includes(effect.type) && isEffective(effect),
    );
  }

  return Object.freeze({
    AUDIO_FX,
    AUDIO_FX_ORDER,
    BLEND_MODES,
    EFFECT_TYPES,
    LIMITS,
    PIXEL_EFFECTS,
    activeEffects,
    compositeOperation,
    createEffect,
    defaultAudioFx,
    defaultParams,
    ease,
    hasPixelEffects,
    isEffective,
    keyframeableParams,
    normalizeAnchor,
    normalizeAudioFx,
    normalizeBlendMode,
    normalizeClipEffects,
    normalizeEffect,
    normalizeEffects,
    normalizeTimeRemap,
    removeEffectKeyframe,
    remapLocalForOffset,
    remapOffset,
    remapSpeedAt,
    resolveEffectParams,
    scaleEffectKeyframes,
    scaleTimeRemap,
    shadowOffset,
    sliceEffects,
    sliceTimeRemap,
    upsertEffectKeyframe,
  });
});

/* alcor-video-edit-core */
(function (root, factory) {
  'use strict';

  const isNode = typeof module === 'object' && module.exports;
  const transforms = isNode
    ? require('./alcor-video-transforms-core.js')
    : root.AlcorVideoTransforms;
  const audio = isNode
    ? require('./alcor-video-audio-automation-core.js')
    : root.AlcorVideoAudioAutomation;
  const effects = isNode ? require('./alcor-video-effects-core.js') : root.AlcorVideoEffects;
  const api = factory(transforms, audio, effects);
  if (isNode) module.exports = api;
  if (root) root.AlcorVideoEdit = api;
})(
  typeof globalThis !== 'undefined' ? globalThis : this,
  function (transforms, audioAutomation, effectsCore) {
    'use strict';

    // Pure timeline edit engine. Every function works on plain project data
    // (the same object the editor serializes), mutates it in place, and returns
    // a small result object. Nothing here touches the DOM, media or time.

    const LIMITS = Object.freeze({
      maxVideoTracks: 12,
      maxAudioTracks: 12,
      maxMarkers: 500,
      maxSpeed: 16,
      minSpeed: 0.1,
      maxHistoryBytes: 64 * 1024 * 1024,
      // Maintain pitch time-stretches on the main thread: bound one clip's stretched sound.
      maxPitchStretchSeconds: 180,
    });
    const MIN_DURATION = 0.04;
    const TITLE_MIN_DURATION = 0.1;
    const EPSILON = 0.0005;
    const TRACK_PATTERN = /^([VA])([1-9][0-9]?)$/;
    const MARKER_COLORS = Object.freeze([
      'green',
      'red',
      'purple',
      'orange',
      'yellow',
      'white',
      'blue',
      'cyan',
    ]);

    function number(value, fallback = 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, number(value, min)));
    }

    function round(value, precision = 3) {
      const power = 10 ** precision;
      return Math.round(number(value) * power) / power;
    }

    function ok(extra = {}) {
      return Object.assign({ ok: true }, extra);
    }
    function fail(reason) {
      return { ok: false, reason: String(reason) };
    }

    // ---------------------------------------------------------------- tracks

    function trackKind(id) {
      const match = TRACK_PATTERN.exec(String(id || ''));
      if (!match) return '';
      return match[1] === 'V' ? 'video' : 'audio';
    }

    function trackNumber(id) {
      const match = TRACK_PATTERN.exec(String(id || ''));
      return match ? Number(match[2]) : 0;
    }

    function makeTrack(id, input = {}) {
      const kind = trackKind(id);
      if (!kind) return null;
      const value = input && typeof input === 'object' ? input : {};
      const track = {
        id,
        kind,
        name: String(value.name || id).slice(0, 24) || id,
        locked: Boolean(value.locked),
      };
      if (kind === 'video') {
        track.hidden = Boolean(value.hidden);
      } else {
        track.muted = Boolean(value.muted);
        track.solo = Boolean(value.solo);
        track.volume = round(clamp(value.volume == null ? 0 : value.volume, -60, 12), 1);
        track.pan = round(clamp(value.pan == null ? 0 : value.pan, -1, 1), 2);
      }
      return track;
    }

    function compareTracks(a, b) {
      if (a.kind !== b.kind) return a.kind === 'video' ? -1 : 1;
      return trackNumber(a.id) - trackNumber(b.id);
    }

    // Legacy projects have no track list: V1, V2 and A1 are implied.
    function normalizeTracks(input, clips = []) {
      const byId = new Map();
      for (const value of Array.isArray(input)
        ? input.slice(0, LIMITS.maxVideoTracks + LIMITS.maxAudioTracks + 8)
        : []) {
        const id = String((value && value.id) || '');
        if (byId.has(id)) continue;
        const track = makeTrack(id, value);
        if (track) byId.set(id, track);
      }
      for (const id of ['V1', 'V2', 'A1']) {
        if (!Array.isArray(input) && !byId.has(id)) byId.set(id, makeTrack(id));
      }
      for (const clip of Array.isArray(clips) ? clips : []) {
        const id = String((clip && clip.track) || '');
        if (trackKind(id) && !byId.has(id)) byId.set(id, makeTrack(id));
      }
      if (![...byId.values()].some((track) => track.kind === 'video'))
        byId.set('V1', makeTrack('V1'));
      if (![...byId.values()].some((track) => track.kind === 'audio'))
        byId.set('A1', makeTrack('A1'));
      const tracks = [...byId.values()].sort(compareTracks);
      const videos = tracks
        .filter((track) => track.kind === 'video')
        .slice(0, LIMITS.maxVideoTracks);
      const audios = tracks
        .filter((track) => track.kind === 'audio')
        .slice(0, LIMITS.maxAudioTracks);
      return videos.concat(audios);
    }

    // Timeline display order: the top video track first, then A1..An.
    function displayOrder(tracks) {
      const list = Array.isArray(tracks) ? tracks : [];
      const videos = list
        .filter((track) => track.kind === 'video')
        .sort((a, b) => trackNumber(b.id) - trackNumber(a.id));
      const audios = list
        .filter((track) => track.kind === 'audio')
        .sort((a, b) => trackNumber(a.id) - trackNumber(b.id));
      return videos.concat(audios);
    }

    function getTrack(project, id) {
      return (
        (project && Array.isArray(project.tracks) ? project.tracks : []).find(
          (track) => track.id === id,
        ) || null
      );
    }

    function isLocked(project, trackId) {
      const track = getTrack(project, trackId);
      return Boolean(track && track.locked);
    }

    function addTrack(project, kind) {
      if (kind !== 'video' && kind !== 'audio') return fail('Choose a video or audio track.');
      project.tracks = normalizeTracks(project.tracks, project.clips);
      const existing = project.tracks.filter((track) => track.kind === kind);
      const limit = kind === 'video' ? LIMITS.maxVideoTracks : LIMITS.maxAudioTracks;
      if (existing.length >= limit)
        return fail(`Sequences are limited to ${limit} ${kind} tracks.`);
      const next = existing.reduce((max, track) => Math.max(max, trackNumber(track.id)), 0) + 1;
      const id = `${kind === 'video' ? 'V' : 'A'}${next}`;
      project.tracks.push(makeTrack(id));
      project.tracks.sort(compareTracks);
      return ok({ trackId: id });
    }

    function removeTrack(project, trackId) {
      const track = getTrack(project, trackId);
      if (!track) return fail('That track does not exist.');
      if (project.tracks.filter((item) => item.kind === track.kind).length <= 1)
        return fail(`A sequence keeps at least one ${track.kind} track.`);
      if (track.locked) return fail(`Unlock ${track.id} before removing it.`);
      const removed = project.clips.filter((clip) => clip.track === trackId).map((clip) => clip.id);
      const removedSet = new Set(removed);
      project.clips = project.clips.filter((clip) => !removedSet.has(clip.id));
      detachTransitions(project, removedSet);
      project.tracks = project.tracks.filter((item) => item.id !== trackId);
      return ok({ removedClipIds: removed });
    }

    function trackAccepts(trackId, clip) {
      const kind = trackKind(trackId);
      if (!kind || !clip) return false;
      return kind === 'audio' ? clip.kind === 'audio' : clip.kind !== 'audio';
    }

    // Mute/solo resolution for playback and export: an audio track is audible when
    // it is not muted and either no track is soloed or it is one of the soloed tracks.
    function audibleTrackIds(project) {
      const audios = (project.tracks || []).filter((track) => track.kind === 'audio');
      const soloed = audios.some((track) => track.solo);
      return new Set(
        audios.filter((track) => !track.muted && (!soloed || track.solo)).map((track) => track.id),
      );
    }

    function visibleTrackIds(project) {
      return new Set(
        (project.tracks || [])
          .filter((track) => track.kind === 'video' && !track.hidden)
          .map((track) => track.id),
      );
    }

    // ------------------------------------------------------------ clip basics

    function clipEnd(clip) {
      return round(number(clip && clip.start) + number(clip && clip.duration));
    }

    function minDuration(clip) {
      return clip && clip.kind === 'title' ? TITLE_MIN_DURATION : MIN_DURATION;
    }

    function isTimedMedia(clip) {
      return Boolean(clip && (clip.kind === 'video' || clip.kind === 'audio') && clip.hold == null);
    }

    function clipsOnTrack(project, trackId, except = null) {
      return project.clips
        .filter((clip) => clip.track === trackId && !(except && except.has(clip.id)))
        .sort((a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id)));
    }

    function findClip(project, id) {
      return project.clips.find((clip) => clip.id === id) || null;
    }

    function findAsset(project, id) {
      return (project.assets || []).find((asset) => asset.id === id) || null;
    }

    function speedOf(clip) {
      return clamp(
        clip && clip.speed == null ? 1 : clip && clip.speed,
        LIMITS.minSpeed,
        LIMITS.maxSpeed,
      );
    }

    // Source-media time shown at a timeline time. Reverse plays the same source
    // window backwards; a frame hold shows one source frame for the whole clip.
    function sourceTimeAt(clip, timelineTime) {
      if (!clip) return 0;
      if (clip.hold != null) return Math.max(0, number(clip.hold));
      const local = clamp(number(timelineTime) - number(clip.start), 0, number(clip.duration));
      if (remapOf(clip))
        return Math.max(0, number(clip.in) + effectsCore.remapOffset(clip.timeRemap, local));
      const offset = clip.reverse ? number(clip.duration) - local : local;
      return Math.max(0, number(clip.in) + offset * speedOf(clip));
    }

    // Time remapping (speed ramps): the active remap points, or null.
    function remapOf(clip) {
      return effectsCore &&
        clip &&
        Array.isArray(clip.timeRemap) &&
        clip.timeRemap.length >= 2 &&
        clip.hold == null
        ? clip.timeRemap
        : null;
    }

    // Source seconds a clip consumes between two local times.
    function sourceSpan(clip, fromLocal, toLocal) {
      const remap = remapOf(clip);
      if (remap)
        return effectsCore.remapOffset(remap, toLocal) - effectsCore.remapOffset(remap, fromLocal);
      return (number(toLocal) - number(fromLocal)) * speedOf(clip);
    }

    // Unused source media available before and after a clip, in timeline seconds.
    function headroom(clip, asset) {
      if (!isTimedMedia(clip)) return { head: Infinity, tail: Infinity };
      const total = number(asset && asset.duration, 0);
      if (!(total > 0)) return { head: Infinity, tail: Infinity };
      const remap = remapOf(clip);
      const sourceIn = Math.max(0, number(clip.in));
      const sourceOut = sourceIn + sourceSpan(clip, 0, number(clip.duration));
      const before = sourceIn / (remap ? remap[0].speed : speedOf(clip));
      const after = Math.max(
        0,
        (total - sourceOut) / (remap ? remap[remap.length - 1].speed : speedOf(clip)),
      );
      return clip.reverse ? { head: after, tail: before } : { head: before, tail: after };
    }

    // Offline mix memory for `clips` over `range`: each source decoded at its own channel
    // count (plus a stereo copy when downmixed), every pitch-kept stretch (output plus its
    // buffer copy) and the stereo mix with its render copy. Refuses over-long stretches.
    function audioMixPlan(project, clips, range, sampleRate = 48000) {
      const second = sampleRate * 4;
      let bytes = (range.end - range.start) * second * 4;
      for (const id of new Set(clips.map((clip) => clip.assetId))) {
        const asset = findAsset(project, id);
        const channels = Math.max(1, number(asset && asset.channels, 2));
        bytes +=
          number(asset && asset.duration) * second * (channels > 2 ? channels + 2 : channels);
      }
      for (const clip of clips) {
        if (!clip.preservePitch || remapOf(clip) || Math.abs(speedOf(clip) - 1) <= 0.001) continue;
        const seconds = Math.max(
          0,
          Math.min(number(clip.start) + number(clip.duration), range.end) -
            Math.max(number(clip.start), range.start),
        );
        if (seconds > LIMITS.maxPitchStretchSeconds)
          return {
            bytes,
            reason: `Maintain pitch can stretch at most ${LIMITS.maxPitchStretchSeconds / 60} minutes of one clip's sound; split ${clip.name || 'the clip'} or turn Maintain pitch off.`,
          };
        bytes += seconds * second * 4;
      }
      return { bytes };
    }

    function sliceTransformKeyframes(clip, fromLocal, toLocal) {
      if (!transforms || !Array.isArray(clip.transformKeyframes) || !clip.transformKeyframes.length)
        return clip.transformKeyframes || [];
      const duration = number(clip.duration);
      let frames = clip.transformKeyframes;
      let working = clip;
      if (fromLocal > EPSILON) {
        frames = transforms.splitKeyframes(
          working,
          fromLocal,
          fromLocal,
          duration - fromLocal,
        ).right;
        working = Object.assign({}, clip, {
          transformKeyframes: frames,
          duration: duration - fromLocal,
        });
      }
      const length = toLocal - fromLocal;
      if (length < number(working.duration) - EPSILON) {
        frames = transforms.splitKeyframes(
          working,
          length,
          length,
          number(working.duration) - length,
        ).left;
      }
      return frames;
    }

    function sliceVolumeKeyframes(clip, fromLocal, toLocal) {
      if (!audioAutomation || !Array.isArray(clip.volumeKeyframes) || !clip.volumeKeyframes.length)
        return clip.volumeKeyframes || [];
      const duration = number(clip.duration);
      let frames = clip.volumeKeyframes;
      let working = clip;
      if (fromLocal > EPSILON) {
        frames = audioAutomation.splitKeyframes(
          working,
          fromLocal,
          fromLocal,
          duration - fromLocal,
        ).right;
        working = Object.assign({}, clip, {
          volumeKeyframes: frames,
          duration: duration - fromLocal,
        });
      }
      const length = toLocal - fromLocal;
      if (length < number(working.duration) - EPSILON) {
        frames = audioAutomation.splitKeyframes(
          working,
          length,
          length,
          number(working.duration) - length,
        ).left;
      }
      return frames;
    }

    // Keep the timeline window [newStart, newEnd] of a clip, adjusting its source
    // in-point, keyframes and fades. The caller guarantees the window lies inside
    // the clip's available media (see headroom).
    function setClipWindow(clip, newStart, newEnd) {
      const start = round(Math.max(0, newStart));
      const end = round(newEnd);
      const fromLocal = start - number(clip.start);
      const toLocal = end - number(clip.start);
      const duration = round(end - start);
      if (duration < minDuration(clip) - EPSILON) return false;
      if (clip.kind !== 'title') {
        if (clip.hold == null) {
          // Reverse clips read the source backwards, so trimming the timeline start moves the source out-point.
          const sourceShift = clip.reverse
            ? sourceSpan(clip, toLocal, number(clip.duration))
            : sourceSpan(clip, 0, fromLocal);
          clip.in = round(Math.max(0, number(clip.in) + sourceShift));
          if (remapOf(clip)) {
            const remap = effectsCore.sliceTimeRemap(clip.timeRemap, fromLocal, toLocal);
            if (remap) clip.timeRemap = remap;
            else delete clip.timeRemap;
          }
        }
        clip.transformKeyframes = sliceTransformKeyframes(clip, fromLocal, toLocal);
        clip.volumeKeyframes = sliceVolumeKeyframes(clip, fromLocal, toLocal);
        if (effectsCore && Array.isArray(clip.effects))
          clip.effects = effectsCore.sliceEffects(clip.effects, fromLocal, toLocal);
        // Fades belong to the clip edges, so they follow a trimmed edge (bounded by the new length).
        clip.fadeIn = round(Math.min(duration, Math.max(0, number(clip.fadeIn))));
        clip.fadeOut = round(Math.min(duration, Math.max(0, number(clip.fadeOut))));
      }
      clip.start = start;
      clip.duration = duration;
      return true;
    }

    function cloneClip(clip) {
      return JSON.parse(JSON.stringify(clip));
    }

    // Transitions store the id of their outgoing clip; keep those references valid.
    function detachTransitions(project, removedIds) {
      for (const clip of project.clips) {
        if (clip.crossDissolve && removedIds.has(String(clip.crossDissolve.outgoingId)))
          clip.crossDissolve = null;
      }
    }

    function retargetTransitions(project, fromId, toId) {
      for (const clip of project.clips) {
        if (clip.crossDissolve && String(clip.crossDissolve.outgoingId) === String(fromId)) {
          clip.crossDissolve = Object.assign({}, clip.crossDissolve, { outgoingId: toId });
        }
      }
    }

    // Split one clip at a timeline time. The left part keeps the id (and any
    // incoming transition); the right part gets makeId() and inherits the role of
    // outgoing clip in any transition that followed the original.
    function splitClipAt(project, clip, time, makeId) {
      const at = round(time);
      if (
        at <= number(clip.start) + minDuration(clip) - EPSILON ||
        at >= clipEnd(clip) - minDuration(clip) + EPSILON
      )
        return null;
      const originalStart = number(clip.start);
      const originalEnd = clipEnd(clip);
      const right = cloneClip(clip);
      right.id = makeId(clip.kind === 'title' ? 'title' : 'clip');
      setClipWindow(clip, originalStart, at);
      setClipWindow(right, at, originalEnd);
      // The new inner edges are hard cuts: the left keeps the fade in, the right the fade out.
      if (clip.kind !== 'title') {
        clip.fadeOut = 0;
        right.fadeIn = 0;
      }
      right.crossDissolve = null;
      retargetTransitions(project, clip.id, right.id);
      project.clips.push(right);
      return right;
    }

    // ------------------------------------------------------------- linking

    function linkedIds(project, clipIds) {
      const ids = new Set(clipIds);
      const links = new Set();
      for (const clip of project.clips) if (ids.has(clip.id) && clip.linkId) links.add(clip.linkId);
      if (links.size)
        for (const clip of project.clips)
          if (clip.linkId && links.has(clip.linkId)) ids.add(clip.id);
      return ids;
    }

    function linkClips(project, clipIds, makeId) {
      const clips = project.clips.filter((clip) => clipIds.includes(clip.id));
      if (clips.length < 2) return fail('Select a video clip and an audio clip to link.');
      if (
        !clips.some((clip) => clip.kind === 'audio') ||
        !clips.some((clip) => clip.kind !== 'audio')
      )
        return fail('Linking needs at least one video and one audio clip.');
      const linkId = makeId('link');
      for (const clip of clips) clip.linkId = linkId;
      return ok({ linkId });
    }

    function unlinkClips(project, clipIds) {
      const ids = linkedIds(project, clipIds);
      let changed = 0;
      for (const clip of project.clips)
        if (ids.has(clip.id) && clip.linkId) {
          delete clip.linkId;
          changed += 1;
        }
      return changed ? ok({ changed }) : fail('The selection is not linked.');
    }

    // ------------------------------------------------------ overwrite model

    // Vacate [start, end) on one track: material fully inside is removed, material
    // crossing an edge is trimmed, and material spanning the range is split.
    function clearRange(project, trackId, start, end, options = {}) {
      const from = round(start);
      const to = round(end);
      if (!(to > from)) return { removed: [], trimmed: [], created: [] };
      const except = options.except || new Set();
      const makeId = options.makeId;
      const removed = [];
      const trimmed = [];
      const created = [];
      for (const clip of clipsOnTrack(project, trackId, except)) {
        const clipStart = number(clip.start);
        const clipStop = clipEnd(clip);
        if (clipStop <= from + EPSILON || clipStart >= to - EPSILON) continue;
        const keepLeft =
          clipStart < from - EPSILON && from - clipStart >= minDuration(clip) - EPSILON;
        const keepRight = clipStop > to + EPSILON && clipStop - to >= minDuration(clip) - EPSILON;
        if (keepLeft && keepRight) {
          if (typeof makeId !== 'function')
            throw new Error('clearRange needs makeId to split a spanning clip.');
          const right = splitClipAt(project, clip, to, makeId);
          if (right) created.push(right.id);
          setClipWindow(clip, clipStart, from);
          trimmed.push(clip.id);
        } else if (keepLeft) {
          setClipWindow(clip, clipStart, from);
          trimmed.push(clip.id);
        } else if (keepRight) {
          setClipWindow(clip, to, clipStop);
          trimmed.push(clip.id);
        } else {
          removed.push(clip.id);
        }
      }
      if (removed.length) {
        const set = new Set(removed);
        project.clips = project.clips.filter((clip) => !set.has(clip.id));
        detachTransitions(project, set);
      }
      return { removed, trimmed, created };
    }

    // Move clips (and their linked partners) by a time delta and optional track
    // offsets, overwriting whatever they land on — the default Premiere drag.
    function moveClips(project, clipIds, delta, options = {}) {
      const ids = options.ignoreLinks ? new Set(clipIds) : linkedIds(project, clipIds);
      const moving = project.clips.filter((clip) => ids.has(clip.id));
      if (!moving.length) return fail('Select a clip to move.');
      const trackShift = options.trackShift || {};
      const targets = [];
      for (const clip of moving) {
        if (isLocked(project, clip.track)) return fail(`${clip.track} is locked.`);
        const kind = trackKind(clip.track);
        const shift = Math.trunc(number(trackShift[kind], 0));
        const destination = shift
          ? `${kind === 'video' ? 'V' : 'A'}${trackNumber(clip.track) + shift}`
          : clip.track;
        if (!getTrack(project, destination))
          return fail(`There is no ${destination} track to move onto.`);
        if (isLocked(project, destination)) return fail(`${destination} is locked.`);
        if (!trackAccepts(destination, clip))
          return fail(`${destination} cannot hold ${clip.kind} clips.`);
        targets.push({
          clip,
          track: destination,
          start: round(number(clip.start) + number(delta)),
        });
      }
      const earliest = Math.min(...targets.map((target) => target.start));
      const correction = earliest < 0 ? -earliest : 0;
      for (const target of targets) target.start = round(target.start + correction);
      for (const target of targets) {
        clearRange(
          project,
          target.track,
          target.start,
          target.start + number(target.clip.duration),
          { except: ids, makeId: options.makeId },
        );
      }
      for (const target of targets) {
        target.clip.track = target.track;
        target.clip.start = target.start;
      }
      return ok({
        moved: targets.map((target) => target.clip.id),
        delta: round(number(delta) + correction),
      });
    }

    // Place a new clip at a position with overwrite semantics.
    function placeClip(project, clip, options = {}) {
      if (!getTrack(project, clip.track)) return fail(`There is no ${clip.track} track.`);
      if (isLocked(project, clip.track)) return fail(`${clip.track} is locked.`);
      if (!trackAccepts(clip.track, clip))
        return fail(`${clip.track} cannot hold ${clip.kind} clips.`);
      clearRange(project, clip.track, clip.start, clipEnd(clip), { makeId: options.makeId });
      project.clips.push(clip);
      return ok({ clipId: clip.id });
    }

    // ------------------------------------------------------------- razor

    function razor(project, time, options = {}) {
      const at = round(time);
      const makeId = options.makeId;
      const trackFilter = options.trackIds ? new Set(options.trackIds) : null;
      let candidates = project.clips.filter(
        (clip) => number(clip.start) + EPSILON < at && clipEnd(clip) - EPSILON > at,
      );
      if (options.clipIds) {
        const ids = options.ignoreLinks
          ? new Set(options.clipIds)
          : linkedIds(project, options.clipIds);
        candidates = candidates.filter((clip) => ids.has(clip.id));
      }
      if (trackFilter) candidates = candidates.filter((clip) => trackFilter.has(clip.track));
      candidates = candidates.filter((clip) => !isLocked(project, clip.track));
      if (!candidates.length) return fail('No unlocked clip crosses that point.');
      const created = [];
      const linkMap = new Map();
      for (const clip of candidates) {
        const right = splitClipAt(project, clip, at, makeId);
        if (!right) continue;
        if (clip.linkId) {
          if (!linkMap.has(clip.linkId)) linkMap.set(clip.linkId, makeId('link'));
          right.linkId = linkMap.get(clip.linkId);
        }
        created.push(right.id);
      }
      if (!created.length) return fail('The cut is too close to a clip edge.');
      return ok({ created });
    }

    // ----------------------------------------------------------- ripple

    function unlockedTracks(project) {
      return (project.tracks || []).filter((track) => !track.locked).map((track) => track.id);
    }

    // Largest leftward shift the sync-locked tracks can take at `from`: every
    // track must be empty in the stretch that closes, so material after the edit
    // stays in sync across tracks (a clip spanning the stretch blocks it).
    function maxLeftShift(project, trackIds, from, except = new Set()) {
      let allowed = Infinity;
      for (const trackId of trackIds) {
        const clips = clipsOnTrack(project, trackId, except);
        const staying = clips.filter((clip) => number(clip.start) < from - EPSILON);
        const moving = clips.filter((clip) => number(clip.start) >= from - EPSILON);
        const firstMoving = moving.length
          ? Math.min(from, ...moving.map((clip) => number(clip.start)))
          : from;
        const barrier = staying.reduce((max, clip) => Math.max(max, clipEnd(clip)), 0);
        if (!staying.length) continue;
        allowed = Math.min(allowed, firstMoving - barrier);
      }
      return Math.max(0, allowed);
    }

    function shiftFrom(project, trackIds, from, amount, except = new Set()) {
      const tracks = new Set(trackIds);
      for (const clip of project.clips) {
        if (except.has(clip.id) || !tracks.has(clip.track)) continue;
        if (number(clip.start) >= from - EPSILON)
          clip.start = round(Math.max(0, number(clip.start) + amount));
      }
      if (Array.isArray(project.markers) && amount) {
        for (const marker of project.markers)
          if (number(marker.time) >= from - EPSILON)
            marker.time = round(Math.max(0, number(marker.time) + amount));
      }
    }

    // Delete clips and close the gap they leave on every unlocked (sync-locked)
    // track, as far as the other tracks allow.
    function rippleDelete(project, clipIds, options = {}) {
      const ids = options.ignoreLinks ? new Set(clipIds) : linkedIds(project, clipIds);
      const doomed = project.clips.filter((clip) => ids.has(clip.id));
      if (!doomed.length) return fail('Select a clip to ripple delete.');
      if (doomed.some((clip) => isLocked(project, clip.track)))
        return fail('Unlock the track before deleting from it.');
      const start = Math.min(...doomed.map((clip) => number(clip.start)));
      const end = Math.max(...doomed.map((clip) => clipEnd(clip)));
      project.clips = project.clips.filter((clip) => !ids.has(clip.id));
      detachTransitions(project, ids);
      const tracks = unlockedTracks(project);
      // Only close the part of the range that is empty on every sync track.
      const shift = Math.min(end - start, maxLeftShift(project, tracks, end));
      if (shift > EPSILON) shiftFrom(project, tracks, end, -shift);
      return ok({ removed: [...ids], closed: round(shift) });
    }

    function gapAt(project, trackId, time) {
      const at = number(time);
      const clips = clipsOnTrack(project, trackId);
      let previousEnd = 0;
      for (const clip of clips) {
        if (at >= previousEnd - EPSILON && at < number(clip.start) - EPSILON)
          return { start: round(previousEnd), end: round(number(clip.start)) };
        if (at < clipEnd(clip)) return null;
        previousEnd = Math.max(previousEnd, clipEnd(clip));
      }
      return null;
    }

    function deleteGap(project, trackId, time) {
      if (isLocked(project, trackId)) return fail(`${trackId} is locked.`);
      const gap = gapAt(project, trackId, time);
      if (!gap) return fail('There is no gap there to close.');
      const tracks = unlockedTracks(project);
      const shift = Math.min(gap.end - gap.start, maxLeftShift(project, tracks, gap.end));
      if (shift <= EPSILON)
        return fail(
          'Another track has material in that gap; the gap cannot close without overlapping it.',
        );
      shiftFrom(project, tracks, gap.end, -shift);
      return ok({ closed: round(shift) });
    }

    // ----------------------------------------------------- three-point edits

    // Insert: open room at `time` on every unlocked track (splitting clips that
    // cross it), then place the source clips. Overwrite replaces what is there.
    function insertEdit(project, clips, time, options = {}) {
      const list = (Array.isArray(clips) ? clips : [clips]).filter(Boolean);
      if (!list.length) return fail('Nothing to insert.');
      for (const clip of list) {
        if (!getTrack(project, clip.track)) return fail(`There is no ${clip.track} track.`);
        if (isLocked(project, clip.track)) return fail(`${clip.track} is locked.`);
        if (!trackAccepts(clip.track, clip))
          return fail(`${clip.track} cannot hold ${clip.kind} clips.`);
      }
      const at = round(Math.max(0, time));
      const length = Math.max(...list.map((clip) => number(clip.duration)));
      const tracks = unlockedTracks(project);
      for (const trackId of tracks) {
        for (const clip of clipsOnTrack(project, trackId)) {
          if (number(clip.start) + EPSILON < at && clipEnd(clip) - EPSILON > at)
            splitClipAt(project, clip, at, options.makeId);
        }
      }
      shiftFrom(project, tracks, at, length);
      for (const clip of list) {
        clip.start = round(at + (number(clip.start) - number(list[0].start)));
        project.clips.push(clip);
      }
      return ok({ inserted: list.map((clip) => clip.id), shifted: round(length) });
    }

    function overwriteEdit(project, clips, time, options = {}) {
      const list = (Array.isArray(clips) ? clips : [clips]).filter(Boolean);
      if (!list.length) return fail('Nothing to overwrite with.');
      const at = round(Math.max(0, time));
      const base = number(list[0].start);
      for (const clip of list) {
        clip.start = round(at + (number(clip.start) - base));
        const result = placeClip(project, clip, options);
        if (!result.ok) return result;
      }
      return ok({ placed: list.map((clip) => clip.id) });
    }

    // --------------------------------------------------------------- trims

    function neighbors(project, clip) {
      const clips = clipsOnTrack(project, clip.track).filter((item) => item.id !== clip.id);
      const before =
        clips.filter((item) => clipEnd(item) <= number(clip.start) + EPSILON).pop() || null;
      const after = clips.find((item) => number(item.start) >= clipEnd(clip) - EPSILON) || null;
      return { before, after };
    }

    // Regular trim: move one edge, never past media or a neighbor.
    function trimEdge(project, clipId, edge, delta) {
      const clip = findClip(project, clipId);
      if (!clip) return fail('Select a clip to trim.');
      if (isLocked(project, clip.track)) return fail(`${clip.track} is locked.`);
      const room = headroom(clip, findAsset(project, clip.assetId));
      const { before, after } = neighbors(project, clip);
      const start = number(clip.start);
      const end = clipEnd(clip);
      if (edge === 'start') {
        const earliest = Math.max(0, start - room.head, before ? clipEnd(before) : 0);
        const latest = end - minDuration(clip);
        const next = clamp(start + number(delta), earliest, latest);
        if (Math.abs(next - start) < EPSILON) return fail('That edge cannot move further.');
        setClipWindow(clip, next, end);
        return ok({ delta: round(next - start) });
      }
      const earliest = start + minDuration(clip);
      const latest = Math.min(end + room.tail, after ? number(after.start) : Infinity);
      const next = clamp(end + number(delta), earliest, latest);
      if (Math.abs(next - end) < EPSILON) return fail('That edge cannot move further.');
      setClipWindow(clip, start, next);
      return ok({ delta: round(next - end) });
    }

    // Ripple trim (B): trimming an edge changes the clip's length and every later
    // clip on unlocked tracks moves with it, so no gap or overlap appears.
    // options.alsoTrim lists linked partners whose same edge sits at the same time;
    // they are trimmed by the same amount instead of blocking the ripple.
    function rippleTrim(project, clipId, edge, delta, options = {}) {
      const clip = findClip(project, clipId);
      if (!clip) return fail('Select a clip to ripple trim.');
      if (isLocked(project, clip.track)) return fail(`${clip.track} is locked.`);
      const tracks = unlockedTracks(project);
      const start = number(clip.start);
      const end = clipEnd(clip);
      const partners = (options.alsoTrim || [])
        .map((id) => findClip(project, id))
        .filter(
          (item) =>
            item &&
            item.id !== clip.id &&
            !isLocked(project, item.track) &&
            Math.abs(number(item.start) - start) < 0.002 &&
            Math.abs(clipEnd(item) - end) < 0.002,
        );
      const group = [clip, ...partners];
      // Positive change lengthens the clip.
      let change = edge === 'start' ? -number(delta) : number(delta);
      let maxGrow = Infinity;
      let minChange = -Infinity;
      for (const item of group) {
        const room = headroom(item, findAsset(project, item.assetId));
        maxGrow = Math.min(maxGrow, edge === 'start' ? room.head : room.tail);
        minChange = Math.max(minChange, minDuration(item) - number(item.duration));
      }
      change = clamp(change, minChange, maxGrow);
      const except = new Set(group.map((item) => item.id));
      const shiftPoint = Math.max(...group.map((item) => clipEnd(item)));
      if (change < 0) {
        const limit = maxLeftShift(project, tracks, shiftPoint, except);
        change = Math.max(change, -limit);
      }
      if (Math.abs(change) < EPSILON) return fail('That edge cannot ripple further.');
      for (const item of group) {
        const itemStart = number(item.start);
        const itemEnd = clipEnd(item);
        if (edge === 'start') {
          // Keep the clip's position; reveal or hide source at its head.
          setClipWindow(item, itemStart - change, itemEnd);
          item.start = round(itemStart);
        } else {
          setClipWindow(item, itemStart, itemEnd + change);
        }
      }
      shiftFrom(project, tracks, shiftPoint, change, except);
      return ok({ change: round(change), trimmed: group.map((item) => item.id) });
    }

    // Roll (N): move the cut between two adjacent clips; total length is unchanged.
    function rollEdit(project, leftId, rightId, delta) {
      const left = findClip(project, leftId);
      const right = findClip(project, rightId);
      if (!left || !right) return fail('Choose an edit point between two clips.');
      if (left.track !== right.track || Math.abs(clipEnd(left) - number(right.start)) > 0.002)
        return fail('Roll needs two clips that touch on one track.');
      if (isLocked(project, left.track)) return fail(`${left.track} is locked.`);
      const leftRoom = headroom(left, findAsset(project, left.assetId));
      const rightRoom = headroom(right, findAsset(project, right.assetId));
      const cut = number(right.start);
      const low = Math.max(number(left.start) + minDuration(left), cut - rightRoom.head);
      const high = Math.min(clipEnd(right) - minDuration(right), cut + leftRoom.tail);
      const next = clamp(cut + number(delta), low, high);
      if (Math.abs(next - cut) < EPSILON) return fail('The edit point cannot roll further.');
      const rightEnd = clipEnd(right);
      setClipWindow(left, left.start, next);
      setClipWindow(right, next, rightEnd);
      return ok({ delta: round(next - cut) });
    }

    // Slip (Y): change which part of the source plays without moving the clip.
    function slipClip(project, clipId, delta) {
      const clip = findClip(project, clipId);
      if (!clip) return fail('Select a clip to slip.');
      if (!isTimedMedia(clip)) return fail('Only audio and video clips can slip.');
      if (isLocked(project, clip.track)) return fail(`${clip.track} is locked.`);
      const asset = findAsset(project, clip.assetId);
      const total = number(asset && asset.duration, 0);
      if (!(total > 0)) return fail('Relink the media before slipping.');
      const speed = remapOf(clip)
        ? sourceSpan(clip, 0, number(clip.duration)) / Math.max(EPSILON, number(clip.duration))
        : speedOf(clip);
      const maxIn = Math.max(0, total - sourceSpan(clip, 0, number(clip.duration)));
      const direction = clip.reverse ? -1 : 1;
      const next = clamp(number(clip.in) + direction * number(delta) * speed, 0, maxIn);
      if (Math.abs(next - number(clip.in)) < EPSILON)
        return fail('There is no more source media to slip into.');
      clip.in = round(next);
      return ok({ in: clip.in });
    }

    // Slide (U): move a clip between its neighbors; the neighbors' edges follow so
    // the sequence length and the clip's content stay the same.
    function slideClip(project, clipId, delta) {
      const clip = findClip(project, clipId);
      if (!clip) return fail('Select a clip to slide.');
      if (isLocked(project, clip.track)) return fail(`${clip.track} is locked.`);
      const { before, after } = neighbors(project, clip);
      const start = number(clip.start);
      const end = clipEnd(clip);
      const touchingBefore = before && Math.abs(clipEnd(before) - start) < 0.002 ? before : null;
      const touchingAfter = after && Math.abs(number(after.start) - end) < 0.002 ? after : null;
      let low = -start;
      let high = Infinity;
      if (touchingBefore) {
        low = Math.max(low, minDuration(touchingBefore) - number(touchingBefore.duration));
        high = Math.min(
          high,
          headroom(touchingBefore, findAsset(project, touchingBefore.assetId)).tail,
        );
      } else if (before) {
        low = Math.max(low, clipEnd(before) - start);
      }
      if (touchingAfter) {
        high = Math.min(high, number(touchingAfter.duration) - minDuration(touchingAfter));
        low = Math.max(
          low,
          -headroom(touchingAfter, findAsset(project, touchingAfter.assetId)).head,
        );
      } else if (after) {
        high = Math.min(high, number(after.start) - end);
      }
      const applied = clamp(number(delta), low, high);
      if (Math.abs(applied) < EPSILON) return fail('The clip cannot slide further.');
      if (touchingBefore)
        setClipWindow(touchingBefore, touchingBefore.start, clipEnd(touchingBefore) + applied);
      if (touchingAfter)
        setClipWindow(touchingAfter, number(touchingAfter.start) + applied, clipEnd(touchingAfter));
      clip.start = round(start + applied);
      return ok({ delta: round(applied) });
    }

    // ------------------------------------------------ speed, reverse, holds

    function setSpeed(project, clipId, speed, options = {}) {
      const clip = findClip(project, clipId);
      if (!clip || !isTimedMedia(clip))
        return fail('Select an audio or video clip to change its speed.');
      if (isLocked(project, clip.track)) return fail(`${clip.track} is locked.`);
      const next = round(clamp(speed, LIMITS.minSpeed, LIMITS.maxSpeed), 4);
      const asset = findAsset(project, clip.assetId);
      const total = number(asset && asset.duration, 0);
      const sourceLength = sourceSpan(clip, 0, number(clip.duration));
      let duration = sourceLength / next;
      if (total > 0) duration = Math.min(duration, Math.max(0, total - number(clip.in)) / next);
      const { after } = neighbors(project, clip);
      const end = clipEnd(clip);
      if (options.ripple) {
        const tracks = unlockedTracks(project);
        const change = duration - number(clip.duration);
        const limited =
          change < 0
            ? Math.max(change, -maxLeftShift(project, tracks, end, new Set([clip.id])))
            : change;
        shiftFrom(project, tracks, end, limited, new Set([clip.id]));
        duration = number(clip.duration) + limited;
      } else if (after) {
        duration = Math.min(duration, number(after.start) - number(clip.start));
      }
      duration = Math.max(minDuration(clip), duration);
      const ratio = duration / Math.max(EPSILON, number(clip.duration));
      const scaleFrames = (frames) =>
        Array.isArray(frames)
          ? frames.map((frame) =>
              Object.assign({}, frame, { time: round(number(frame.time) * ratio) }),
            )
          : frames;
      clip.transformKeyframes = scaleFrames(clip.transformKeyframes);
      clip.volumeKeyframes = scaleFrames(clip.volumeKeyframes);
      if (effectsCore && Array.isArray(clip.effects))
        clip.effects = effectsCore.scaleEffectKeyframes(clip.effects, ratio);
      // A constant speed replaces any speed ramp.
      delete clip.timeRemap;
      clip.speed = next;
      clip.duration = round(duration);
      clip.fadeIn = round(Math.min(clip.duration, number(clip.fadeIn)));
      clip.fadeOut = round(Math.min(clip.duration, number(clip.fadeOut)));
      return ok({ speed: next, duration: clip.duration });
    }

    function setReverse(project, clipId, reverse) {
      const clip = findClip(project, clipId);
      if (!clip || !isTimedMedia(clip)) return fail('Select an audio or video clip to reverse.');
      if (isLocked(project, clip.track)) return fail(`${clip.track} is locked.`);
      if (Boolean(clip.reverse) === Boolean(reverse))
        return fail(
          reverse ? 'The clip already plays in reverse.' : 'The clip already plays forward.',
        );
      if (reverse && remapOf(clip))
        return fail('Remove the speed ramp (time remapping) before reversing this clip.');
      clip.reverse = Boolean(reverse);
      return ok({ reverse: clip.reverse });
    }

    // Add Frame Hold: the part of a video clip after `time` becomes a still of the
    // frame at `time`. Linked audio keeps playing, as in Premiere.
    function addFrameHold(project, clipId, time, makeId) {
      const clip = findClip(project, clipId);
      if (!clip || clip.kind !== 'video') return fail('Select a video clip for a frame hold.');
      if (isLocked(project, clip.track)) return fail(`${clip.track} is locked.`);
      if (clip.hold != null) return fail('This clip is already a frame hold.');
      const at = round(time);
      if (at < number(clip.start) - EPSILON || at >= clipEnd(clip) - EPSILON)
        return fail('Move the playhead over the clip first.');
      const frame = round(sourceTimeAt(clip, at), 4);
      let target = clip;
      if (at > number(clip.start) + minDuration(clip)) {
        target = splitClipAt(project, clip, at, makeId);
        if (!target) return fail('Move the playhead farther from the clip edge.');
      }
      target.hold = frame;
      target.reverse = false;
      delete target.timeRemap;
      delete target.linkId;
      return ok({ clipId: target.id, hold: frame });
    }

    // Insert Frame Hold Segment: split at `time` and insert a still of that frame,
    // pushing the rest of the sequence later on unlocked tracks.
    function insertFrameHold(project, clipId, time, holdDuration, makeId) {
      const clip = findClip(project, clipId);
      if (!clip || clip.kind !== 'video') return fail('Select a video clip for a frame hold.');
      if (isLocked(project, clip.track)) return fail(`${clip.track} is locked.`);
      const at = round(time);
      if (at < number(clip.start) - EPSILON || at >= clipEnd(clip) - EPSILON)
        return fail('Move the playhead over the clip first.');
      const frame = round(sourceTimeAt(clip, at), 4);
      const hold = cloneClip(clip);
      hold.id = makeId('clip');
      hold.hold = frame;
      hold.reverse = false;
      delete hold.timeRemap;
      hold.start = at;
      hold.duration = round(clamp(holdDuration, MIN_DURATION, 60));
      hold.fadeIn = 0;
      hold.fadeOut = 0;
      hold.transformKeyframes = [];
      hold.volumeKeyframes = [];
      hold.crossDissolve = null;
      delete hold.linkId;
      return insertEdit(project, [hold], at, { makeId });
    }

    // Time remapping: speed keyframes with linear ramps between them (Premiere's
    // Time Remapping > Speed). The clip keeps its length; it ends early, at the last
    // source frame, if the ramp would read past the end of the media.
    function setTimeRemap(project, clipId, points) {
      const clip = findClip(project, clipId);
      if (!clip || !isTimedMedia(clip))
        return fail('Select an audio or video clip to ramp its speed.');
      if (isLocked(project, clip.track)) return fail(`${clip.track} is locked.`);
      if (clip.hold != null) return fail('A frame hold has no speed to ramp.');
      if (!effectsCore) return fail('Time remapping is unavailable.');
      if (!points) {
        const had = Boolean(clip.timeRemap);
        delete clip.timeRemap;
        return had ? ok({ cleared: true }) : fail('The clip has no speed ramp.');
      }
      const remap = effectsCore.normalizeTimeRemap(points, clip.duration);
      if (!remap) return fail('A speed ramp needs at least two speed keyframes.');
      if (clip.reverse) return fail('Turn off reverse before adding a speed ramp.');
      const asset = findAsset(project, clip.assetId);
      const total = number(asset && asset.duration, 0);
      clip.timeRemap = remap;
      let duration = number(clip.duration);
      if (
        total > 0 &&
        number(clip.in) + effectsCore.remapOffset(remap, duration) > total + EPSILON
      ) {
        duration = effectsCore.remapLocalForOffset(
          remap,
          Math.max(0, total - number(clip.in)),
          duration,
        );
        setClipWindow(
          clip,
          number(clip.start),
          number(clip.start) + Math.max(minDuration(clip), duration),
        );
      }
      return ok({ points: clip.timeRemap ? clip.timeRemap.length : 0, duration: clip.duration });
    }

    // -------------------------------------------------- markers, in/out

    function normalizeMarkers(values, maxTime = Infinity) {
      const seen = new Set();
      const result = [];
      for (const value of Array.isArray(values) ? values.slice(0, LIMITS.maxMarkers * 2) : []) {
        if (!value || typeof value !== 'object') continue;
        const id = String(value.id || '').slice(0, 100);
        if (!/^[a-z0-9][a-z0-9._:-]{0,99}$/i.test(id) || seen.has(id)) continue;
        seen.add(id);
        result.push({
          id,
          time: round(clamp(value.time, 0, maxTime)),
          name: String(value.name || '').slice(0, 80),
          color: MARKER_COLORS.includes(value.color) ? value.color : 'green',
        });
        if (result.length >= LIMITS.maxMarkers) break;
      }
      return result.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    }

    function addMarker(project, time, makeId, fields = {}) {
      project.markers = normalizeMarkers(project.markers);
      if (project.markers.length >= LIMITS.maxMarkers)
        return fail(`Sequences are limited to ${LIMITS.maxMarkers} markers.`);
      const at = round(Math.max(0, time));
      if (project.markers.some((marker) => Math.abs(marker.time - at) < EPSILON))
        return fail('A marker is already at this time.');
      const marker = {
        id: makeId('marker'),
        time: at,
        name: String(fields.name || '').slice(0, 80),
        color: MARKER_COLORS.includes(fields.color) ? fields.color : 'green',
      };
      project.markers.push(marker);
      project.markers.sort((a, b) => a.time - b.time);
      return ok({ marker });
    }

    function removeMarker(project, markerId) {
      const before = (project.markers || []).length;
      project.markers = (project.markers || []).filter((marker) => marker.id !== markerId);
      return project.markers.length < before ? ok() : fail('That marker no longer exists.');
    }

    function adjacentMarker(project, time, direction) {
      const markers = normalizeMarkers(project.markers);
      const at = number(time);
      if (direction > 0) return markers.find((marker) => marker.time > at + EPSILON) || null;
      return markers.filter((marker) => marker.time < at - EPSILON).pop() || null;
    }

    function normalizeInOut(inPoint, outPoint, maxTime = Infinity) {
      const inValue =
        inPoint == null || inPoint === '' || !Number.isFinite(Number(inPoint))
          ? null
          : round(clamp(inPoint, 0, maxTime));
      const outValue =
        outPoint == null || outPoint === '' || !Number.isFinite(Number(outPoint))
          ? null
          : round(clamp(outPoint, 0, maxTime));
      if (inValue != null && outValue != null && outValue <= inValue + EPSILON)
        return { inPoint: inValue, outPoint: null };
      return { inPoint: inValue, outPoint: outValue };
    }

    // Lift (;): remove material between in and out on target tracks, leaving a gap.
    function liftRange(project, start, end, options = {}) {
      if (!(number(end) > number(start)))
        return fail('Set an in point before the out point first.');
      const tracks = (options.trackIds || unlockedTracks(project)).filter(
        (id) => !isLocked(project, id),
      );
      let changed = 0;
      for (const trackId of tracks) {
        const result = clearRange(project, trackId, start, end, { makeId: options.makeId });
        changed += result.removed.length + result.trimmed.length;
      }
      return changed ? ok({ changed }) : fail('There is nothing between the in and out points.');
    }

    // Extract ('): lift, then close the gap on the same tracks.
    function extractRange(project, start, end, options = {}) {
      const lifted = liftRange(project, start, end, options);
      if (!lifted.ok) return lifted;
      const tracks = (options.trackIds || unlockedTracks(project)).filter(
        (id) => !isLocked(project, id),
      );
      const length = number(end) - number(start);
      const shift = Math.min(length, maxLeftShift(project, tracks, number(end)));
      shiftFrom(project, tracks, number(end), -shift);
      return ok({ changed: lifted.changed, closed: round(shift) });
    }

    // --------------------------------------------------------------- snap

    function snapTargets(project, options = {}) {
      const except = options.except || new Set();
      const points = new Set([0]);
      if (Number.isFinite(options.playhead)) points.add(round(options.playhead));
      for (const clip of project.clips) {
        if (except.has(clip.id)) continue;
        points.add(round(clip.start));
        points.add(clipEnd(clip));
      }
      for (const marker of project.markers || []) points.add(round(marker.time));
      if (project.inPoint != null) points.add(round(project.inPoint));
      if (project.outPoint != null) points.add(round(project.outPoint));
      return [...points].sort((a, b) => a - b);
    }

    function snap(time, targets, tolerance) {
      const value = number(time);
      let best = null;
      let distance = Math.max(0, number(tolerance));
      for (const target of targets) {
        const next = Math.abs(target - value);
        if (next <= distance) {
          best = target;
          distance = next;
        }
      }
      return best == null ? { time: round(value), snapped: false } : { time: best, snapped: true };
    }

    // Snap a moving clip so either its start or its end lands on a target.
    function snapClipDelta(clipStart, clipDuration, delta, targets, tolerance) {
      const start = number(clipStart) + number(delta);
      const byStart = snap(start, targets, tolerance);
      const byEnd = snap(start + number(clipDuration), targets, tolerance);
      const startDistance = byStart.snapped ? Math.abs(byStart.time - start) : Infinity;
      const endDistance = byEnd.snapped
        ? Math.abs(byEnd.time - (start + number(clipDuration)))
        : Infinity;
      if (startDistance === Infinity && endDistance === Infinity)
        return { delta: number(delta), snapped: false };
      if (startDistance <= endDistance)
        return {
          delta: round(byStart.time - number(clipStart)),
          snapped: true,
          target: byStart.time,
        };
      return {
        delta: round(byEnd.time - number(clipDuration) - number(clipStart)),
        snapped: true,
        target: byEnd.time,
      };
    }

    // Edit points (clip starts/ends) for Up/Down navigation.
    function adjacentEditPoint(project, time, direction, trackIds = null) {
      const tracks = trackIds ? new Set(trackIds) : null;
      const points = new Set([0]);
      for (const clip of project.clips) {
        if (tracks && !tracks.has(clip.track)) continue;
        points.add(round(clip.start));
        points.add(clipEnd(clip));
      }
      const sorted = [...points].sort((a, b) => a - b);
      const at = number(time);
      if (direction > 0) return sorted.find((point) => point > at + EPSILON) ?? null;
      return sorted.filter((point) => point < at - EPSILON).pop() ?? null;
    }

    function sequenceDuration(project) {
      return round(project.clips.reduce((max, clip) => Math.max(max, clipEnd(clip)), 0));
    }

    // Overlap check used by tests and by the runtime to prove the overwrite model holds.
    function findOverlaps(project) {
      const overlaps = [];
      for (const track of project.tracks || []) {
        const clips = clipsOnTrack(project, track.id);
        for (let index = 1; index < clips.length; index += 1) {
          if (number(clips[index].start) < clipEnd(clips[index - 1]) - 0.0015)
            overlaps.push([clips[index - 1].id, clips[index].id]);
        }
      }
      return overlaps;
    }

    // Resolve pre-existing overlaps in legacy projects (which allowed stacking on
    // one track) by moving the later clip to a free track of the same kind, or
    // adding one, so opening an old project never silently drops material.
    function resolveLegacyOverlaps(project) {
      let moved = 0;
      for (let guard = 0; guard < 500; guard += 1) {
        const overlaps = findOverlaps(project);
        if (!overlaps.length) break;
        const clip = findClip(project, overlaps[0][1]);
        const kind = trackKind(clip.track);
        const free = project.tracks
          .filter((track) => track.kind === kind && track.id !== clip.track)
          .find(
            (track) =>
              !clipsOnTrack(project, track.id).some(
                (other) =>
                  number(other.start) < clipEnd(clip) - 0.0015 &&
                  clipEnd(other) > number(clip.start) + 0.0015,
              ),
          );
        if (free) {
          clip.track = free.id;
        } else {
          const added = addTrack(project, kind);
          if (!added.ok) break;
          clip.track = added.trackId;
        }
        moved += 1;
      }
      return moved;
    }

    // ------------------------------------------------------------- history

    // Snapshot history with a byte budget instead of a step cap. Each entry keeps
    // the serialized state before an edit and the edit's label for the History panel.
    function createHistory(options = {}) {
      const maxBytes = Math.max(1024, number(options.maxBytes, LIMITS.maxHistoryBytes));
      const past = [];
      const future = [];
      let bytes = 0;
      const size = (entry) => entry.snapshot.length * 2 + entry.label.length * 2 + 64;
      function trim() {
        while (bytes > maxBytes && past.length > 1) bytes -= size(past.shift());
        while (bytes > maxBytes && future.length) bytes -= size(future.shift());
      }
      return {
        push(label, before) {
          const entry = { label: String(label || 'Edit').slice(0, 80), snapshot: String(before) };
          if (past.length && past[past.length - 1].snapshot === entry.snapshot) return false;
          for (const item of future.splice(0)) bytes -= size(item);
          past.push(entry);
          bytes += size(entry);
          trim();
          return true;
        },
        undo(current) {
          const entry = past.pop();
          if (!entry) return null;
          bytes -= size(entry);
          const redoEntry = { label: entry.label, snapshot: String(current) };
          future.push(redoEntry);
          bytes += size(redoEntry);
          trim();
          return entry;
        },
        redo(current) {
          const entry = future.pop();
          if (!entry) return null;
          bytes -= size(entry);
          const undoEntry = { label: entry.label, snapshot: String(current) };
          past.push(undoEntry);
          bytes += size(undoEntry);
          trim();
          return entry;
        },
        clear() {
          past.length = 0;
          future.length = 0;
          bytes = 0;
        },
        canUndo() {
          return past.length > 0;
        },
        canRedo() {
          return future.length > 0;
        },
        labels() {
          return {
            past: past.map((entry) => entry.label),
            future: future.map((entry) => entry.label).reverse(),
          };
        },
        get bytes() {
          return bytes;
        },
        get length() {
          return past.length;
        },
        get maxBytes() {
          return maxBytes;
        },
      };
    }

    // ----------------------------------------------------------- shortcut hint
    // The editor ignores its keyboard shortcuts while a field has focus (typing must win).
    // Say so in the status line instead of failing silently. Browser only; edits nothing.

    const IGNORED_SHORTCUTS = Object.freeze({
      k: 'split',
      s: 'save project',
      m: 'export',
      d: 'default transition',
      l: 'link',
      r: 'speed',
    });

    function ignoredShortcutHint(event) {
      if (!event || !(event.ctrlKey || event.metaKey) || event.altKey) return '';
      const target = event.target;
      const tag = target && target.tagName ? String(target.tagName).toLowerCase() : '';
      if (
        !(
          tag === 'input' ||
          tag === 'textarea' ||
          tag === 'select' ||
          (target && target.isContentEditable)
        )
      )
        return '';
      const key = String(event.key || '').toLowerCase();
      const name = IGNORED_SHORTCUTS[key];
      if (!name || (event.shiftKey && key !== 'k')) return '';
      return `${event.metaKey ? 'Cmd' : 'Ctrl'}+${key.toUpperCase()} (${name}) is ignored while a field has focus. Click outside the field or press Tab, then try again.`;
    }

    if (
      typeof window === 'object' &&
      window &&
      typeof window.addEventListener === 'function' &&
      typeof document === 'object' &&
      document
    ) {
      let hintTimer = 0;
      window.addEventListener('keydown', (event) => {
        const hint = ignoredShortcutHint(event);
        const status = hint ? document.getElementById('av-status') : null;
        if (!status) return;
        status.textContent = hint;
        window.clearTimeout(hintTimer);
        hintTimer = window.setTimeout(() => {
          if (status.textContent === hint) status.textContent = 'Ready';
        }, 6000);
      });
    }

    return Object.freeze({
      LIMITS,
      MARKER_COLORS,
      MIN_DURATION,
      addFrameHold,
      addMarker,
      addTrack,
      adjacentEditPoint,
      adjacentMarker,
      audibleTrackIds,
      clearRange,
      clipEnd,
      clipsOnTrack,
      createHistory,
      deleteGap,
      displayOrder,
      extractRange,
      findOverlaps,
      gapAt,
      getTrack,
      headroom,
      ignoredShortcutHint,
      audioMixPlan,
      insertEdit,
      insertFrameHold,
      liftRange,
      linkClips,
      linkedIds,
      makeTrack,
      moveClips,
      normalizeInOut,
      normalizeMarkers,
      normalizeTracks,
      overwriteEdit,
      placeClip,
      razor,
      removeMarker,
      removeTrack,
      resolveLegacyOverlaps,
      rippleDelete,
      rippleTrim,
      rollEdit,
      round,
      sequenceDuration,
      setClipWindow,
      setReverse,
      setSpeed,
      setTimeRemap,
      slideClip,
      slipClip,
      snap,
      snapClipDelta,
      snapTargets,
      sourceSpan,
      sourceTimeAt,
      splitClipAt,
      trackAccepts,
      trackKind,
      trackNumber,
      trimEdge,
      unlinkClips,
      visibleTrackIds,
    });
  },
);

/* alcor-video-media-core */
(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AlcorVideoMedia = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Container probing without decoding: reads only box/element headers of local
  // MP4/MOV and WebM/Matroska files to learn which tracks exist (so a video with
  // no sound does not get an empty linked audio clip), the frame rate and the
  // rotation flag. Unknown formats return nulls; callers treat null as unknown.

  const LIMITS = Object.freeze({
    maxMoovBytes: 48 * 1024 * 1024,
    webmHeadBytes: 4 * 1024 * 1024,
    maxBoxes: 20000,
  });

  function readU32(view, offset) {
    return view.getUint32(offset, false);
  }

  function fourcc(bytes, offset) {
    return String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3],
    );
  }

  // Iterate ISO-BMFF boxes inside bytes[start, end).
  function* boxes(bytes, start = 0, end = bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = start;
    let guard = 0;
    while (offset + 8 <= end && guard < LIMITS.maxBoxes) {
      guard += 1;
      let size = readU32(view, offset);
      const type = fourcc(bytes, offset + 4);
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end) return;
        size = readU32(view, offset + 8) * 4294967296 + readU32(view, offset + 12);
        header = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < header || offset + size > end) return;
      yield { type, start: offset, end: offset + size, body: offset + header };
      offset += size;
    }
  }

  function child(bytes, parent, type) {
    for (const item of boxes(bytes, parent.body, parent.end)) if (item.type === type) return item;
    return null;
  }

  function children(bytes, parent, type) {
    const out = [];
    for (const item of boxes(bytes, parent.body, parent.end))
      if (item.type === type) out.push(item);
    return out;
  }

  // Phone cameras write variable or millisecond-rounded frame times (33, 34, 33 ms...).
  // Report the standard rate the clip was shot at (23.976, 29.97, 59.94...) instead.
  const STANDARD_RATES = Object.freeze([
    23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60, 100, 119.88, 120,
  ]);
  function standardFrameRate(fps) {
    const value = Number(fps);
    if (!(value > 0)) return null;
    let best = null;
    for (const rate of STANDARD_RATES)
      if (!best || Math.abs(rate - value) < Math.abs(best - value)) best = rate;
    return Math.abs(best - value) / best <= 0.025 ? best : Math.round(value * 1000) / 1000;
  }

  // Export picks the source frame nearest to the wanted time: half a source frame of
  // lookahead (less a margin) absorbs rounded timestamps without skipping a frame.
  function frameLookupTolerance(sourceFps, sequenceFps) {
    const rate = Number(sourceFps) > 0 ? Number(sourceFps) : Number(sequenceFps);
    return rate > 0 ? 0.45 / rate : 0;
  }

  // Index of the frame shown at `time` among sorted timestamps (seconds).
  function pickFrameIndex(timestamps, time, sourceFps) {
    const target = Number(time) + frameLookupTolerance(sourceFps) + 1e-6;
    let lo = 0;
    let hi = timestamps.length - 1;
    if (hi < 0 || timestamps[0] > target) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (timestamps[mid] <= target) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  // Channel count from an MPEG-4 AudioSpecificConfig inside an 'esds' box.
  function readDescriptor(bytes, at, end) {
    const tag = bytes[at];
    let length = 0;
    let index = at + 1;
    for (let count = 0; count < 4 && index < end; count += 1) {
      const value = bytes[index++];
      length = (length << 7) | (value & 0x7f);
      if (!(value & 0x80)) break;
    }
    return { tag, body: index, end: Math.min(end, index + length) };
  }

  function aacChannels(bytes, esds) {
    let descriptor = readDescriptor(bytes, esds.body + 4, esds.end);
    if (descriptor.tag !== 3) return 0;
    let at = descriptor.body + 2;
    const flags = bytes[at++];
    if (flags & 0x80) at += 2;
    if (flags & 0x40) at += 1 + bytes[at];
    if (flags & 0x20) at += 2;
    descriptor = readDescriptor(bytes, at, descriptor.end);
    if (descriptor.tag !== 4) return 0;
    descriptor = readDescriptor(bytes, descriptor.body + 13, descriptor.end);
    if (descriptor.tag !== 5 || descriptor.body + 2 > descriptor.end) return 0;
    let bit = descriptor.body * 8;
    const read = (count) => {
      let value = 0;
      for (let i = 0; i < count; i += 1, bit += 1)
        value = (value << 1) | ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1);
      return value;
    };
    let objectType = read(5);
    if (objectType === 31) objectType = 32 + read(6);
    if (read(4) === 15) read(24);
    const config = read(4);
    return [0, 1, 2, 3, 4, 5, 6, 8][config] || 0;
  }

  function parseTrak(bytes, trak) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const mdia = child(bytes, trak, 'mdia');
    if (!mdia) return null;
    const hdlr = child(bytes, mdia, 'hdlr');
    const mdhd = child(bytes, mdia, 'mdhd');
    const handler = hdlr ? fourcc(bytes, hdlr.body + 8) : '';
    const track = {
      handler,
      kind: handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : 'other',
      codec: '',
      timescale: 0,
      duration: 0,
      fps: null,
      rotation: 0,
      width: 0,
      height: 0,
      sampleCount: 0,
    };
    if (mdhd) {
      const version = bytes[mdhd.body];
      if (version === 1) {
        track.timescale = readU32(view, mdhd.body + 20);
        track.duration = readU32(view, mdhd.body + 24) * 4294967296 + readU32(view, mdhd.body + 28);
      } else {
        track.timescale = readU32(view, mdhd.body + 12);
        track.duration = readU32(view, mdhd.body + 16);
      }
    }
    const tkhd = child(bytes, trak, 'tkhd');
    if (tkhd) {
      const version = bytes[tkhd.body];
      const matrix = tkhd.body + (version === 1 ? 52 : 40);
      if (matrix + 44 <= tkhd.end) {
        const a = view.getInt32(matrix, false) / 65536;
        const b = view.getInt32(matrix + 4, false) / 65536;
        const degrees = Math.round((Math.atan2(b, a) * 180) / Math.PI);
        track.rotation = ((degrees % 360) + 360) % 360;
        track.width = readU32(view, matrix + 36) / 65536;
        track.height = readU32(view, matrix + 40) / 65536;
      }
    }
    const minf = child(bytes, mdia, 'minf');
    const stbl = minf && child(bytes, minf, 'stbl');
    if (stbl) {
      const stsd = child(bytes, stbl, 'stsd');
      if (stsd && stsd.body + 16 <= stsd.end) track.codec = fourcc(bytes, stsd.body + 12);
      if (track.kind === 'audio' && stsd && stsd.body + 44 <= stsd.end) {
        const entryEnd = Math.min(stsd.end, stsd.body + 8 + readU32(view, stsd.body + 8));
        track.channels = view.getUint16(stsd.body + 32, false) || 0;
        for (const box of boxes(bytes, stsd.body + 44, entryEnd)) {
          if (box.type === 'esds') {
            const channels = aacChannels(bytes, box);
            if (channels) track.channels = channels;
          }
        }
      }
      const stts = child(bytes, stbl, 'stts');
      if (stts && track.timescale) {
        const count = readU32(view, stts.body + 4);
        let samples = 0;
        let ticks = 0;
        let dominant = { count: 0, delta: 0 };
        for (let index = 0; index < Math.min(count, 100000); index += 1) {
          const at = stts.body + 8 + index * 8;
          if (at + 8 > stts.end) break;
          const runCount = readU32(view, at);
          const delta = readU32(view, at + 4);
          samples += runCount;
          ticks += runCount * delta;
          if (runCount > dominant.count) dominant = { count: runCount, delta };
        }
        track.sampleCount = samples;
        // Constant frame rate: the one delta. Variable or rounded times: the average.
        const constant = dominant.delta > 0 && dominant.count >= samples * 0.9;
        if (track.kind === 'video' && constant)
          track.fps = Math.round((track.timescale / dominant.delta) * 1000) / 1000;
        else if (track.kind === 'video' && ticks > 0)
          track.fps = Math.round(((samples * track.timescale) / ticks) * 1000) / 1000;
        if (track.kind === 'video' && track.fps) {
          track.measuredFps = track.fps;
          track.fps = standardFrameRate(track.fps);
          track.variableRate = !constant;
        }
      }
    }
    return track;
  }

  // Full sample table of the first video track, for frame-exact WebCodecs decoding
  // during export: byte offset/size, decode and presentation times, sync flags,
  // the codec string and its decoder description (avcC/hvcC/vpcC/av1C).
  function videoSampleTable(moovBytes) {
    const bytes = moovBytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const moov = boxes(bytes).next().value;
    if (!moov || moov.type !== 'moov') return null;
    for (const trak of children(bytes, moov, 'trak')) {
      const mdia = child(bytes, trak, 'mdia');
      const hdlr = mdia && child(bytes, mdia, 'hdlr');
      if (!hdlr || fourcc(bytes, hdlr.body + 8) !== 'vide') continue;
      const info = parseTrak(bytes, trak);
      const stbl = child(bytes, child(bytes, mdia, 'minf'), 'stbl');
      const stsd = stbl && child(bytes, stbl, 'stsd');
      if (!stsd) return null;
      const entryStart = stsd.body + 8;
      const entrySize = readU32(view, entryStart);
      const format = fourcc(bytes, entryStart + 4);
      const width = view.getUint16(entryStart + 32, false);
      const height = view.getUint16(entryStart + 34, false);
      const entry = {
        type: format,
        start: entryStart,
        end: entryStart + entrySize,
        body: entryStart + 86,
      };
      let description = null;
      let codec = '';
      for (const item of boxes(bytes, entry.body, entry.end)) {
        const payload = bytes.slice(item.body, item.end);
        if (item.type === 'avcC') {
          description = payload;
          const hex = (value) => value.toString(16).padStart(2, '0').toUpperCase();
          codec = `${format === 'avc3' ? 'avc3' : 'avc1'}.${hex(payload[1])}${hex(payload[2])}${hex(payload[3])}`;
        } else if (item.type === 'hvcC') {
          description = payload;
          const profile = payload[1] & 31;
          const tier = (payload[1] >> 5) & 1 ? 'H' : 'L';
          const level = payload[12];
          let compat = 0;
          for (let bit = 0; bit < 32; bit += 1)
            if (view.getUint32(item.body + 2, false) & (1 << bit)) compat |= 1 << (31 - bit);
          codec = `${format === 'hev1' ? 'hev1' : 'hvc1'}.${profile}.${(compat >>> 0).toString(16).toUpperCase()}.${tier}${level}.B0`;
        } else if (item.type === 'vpcC') {
          const profile = payload[4];
          const level = payload[5];
          const depth = payload[6] >> 4;
          codec = `vp09.${String(profile).padStart(2, '0')}.${String(level).padStart(2, '0')}.${String(depth).padStart(2, '0')}`;
        } else if (item.type === 'av1C') {
          description = payload;
          const profile = payload[1] >> 5;
          const level = payload[1] & 31;
          const tier = payload[2] >> 7 ? 'H' : 'M';
          const depth = (payload[2] >> 6) & 1 ? ((payload[2] >> 5) & 1 ? 12 : 10) : 8;
          codec = `av01.${profile}.${String(level).padStart(2, '0')}${tier}.${String(depth).padStart(2, '0')}`;
        }
      }
      if (!codec) return null;
      const read = (type) => child(bytes, stbl, type);
      const stsz = read('stsz');
      const stco = read('stco') || read('co64');
      const stsc = read('stsc');
      const stts = read('stts');
      if (!stsz || !stco || !stsc || !stts) return null;
      const count = readU32(view, stsz.body + 8);
      const fixedSize = readU32(view, stsz.body + 4);
      if (count > 2000000) return null;
      const sizes = new Array(count);
      for (let index = 0; index < count; index += 1)
        sizes[index] = fixedSize || readU32(view, stsz.body + 12 + index * 4);
      const chunkCount = readU32(view, stco.body + 4);
      const large = stco.type === 'co64';
      const chunkOffsets = new Array(chunkCount);
      for (let index = 0; index < chunkCount; index += 1) {
        chunkOffsets[index] = large
          ? readU32(view, stco.body + 8 + index * 8) * 4294967296 +
            readU32(view, stco.body + 12 + index * 8)
          : readU32(view, stco.body + 8 + index * 4);
      }
      const stscCount = readU32(view, stsc.body + 4);
      const runs = [];
      for (let index = 0; index < stscCount; index += 1)
        runs.push({
          first: readU32(view, stsc.body + 8 + index * 12) - 1,
          perChunk: readU32(view, stsc.body + 12 + index * 12),
        });
      const offsets = new Array(count);
      let sample = 0;
      for (let chunk = 0; chunk < chunkCount && sample < count; chunk += 1) {
        let run = runs[0];
        for (const candidate of runs) if (candidate.first <= chunk) run = candidate;
        let offset = chunkOffsets[chunk];
        for (let index = 0; index < run.perChunk && sample < count; index += 1) {
          offsets[sample] = offset;
          offset += sizes[sample];
          sample += 1;
        }
      }
      const dts = new Array(count);
      let time = 0;
      sample = 0;
      const sttsCount = readU32(view, stts.body + 4);
      for (let index = 0; index < sttsCount; index += 1) {
        const runCount = readU32(view, stts.body + 8 + index * 8);
        const delta = readU32(view, stts.body + 12 + index * 8);
        for (let step = 0; step < runCount && sample < count; step += 1) {
          dts[sample] = time;
          time += delta;
          sample += 1;
        }
      }
      const cts = dts.slice();
      const ctts = read('ctts');
      if (ctts) {
        const version = bytes[ctts.body];
        const cttsCount = readU32(view, ctts.body + 4);
        sample = 0;
        for (let index = 0; index < cttsCount; index += 1) {
          const runCount = readU32(view, ctts.body + 8 + index * 8);
          const offset =
            version === 1
              ? view.getInt32(ctts.body + 12 + index * 8, false)
              : readU32(view, ctts.body + 12 + index * 8);
          for (let step = 0; step < runCount && sample < count; step += 1) {
            cts[sample] = dts[sample] + offset;
            sample += 1;
          }
        }
      }
      const stss = read('stss');
      const keys = new Set();
      if (stss) {
        const keyCount = readU32(view, stss.body + 4);
        for (let index = 0; index < keyCount; index += 1)
          keys.add(readU32(view, stss.body + 8 + index * 4) - 1);
      }
      // Presentation starts at the edit list's media time, else at the earliest composition time.
      let start = cts.length ? Math.min(...cts.slice(0, Math.min(cts.length, 64))) : 0;
      const edts = child(bytes, trak, 'edts');
      const elst = edts && child(bytes, edts, 'elst');
      if (elst) {
        const version = bytes[elst.body];
        const entries = readU32(view, elst.body + 4);
        for (let index = 0; index < entries; index += 1) {
          const base = elst.body + 8 + index * (version === 1 ? 20 : 12);
          const mediaTime =
            version === 1
              ? view.getInt32(base + 8, false) * 4294967296 + readU32(view, base + 12)
              : view.getInt32(base + 4, false);
          if (mediaTime >= 0) {
            start = mediaTime;
            break;
          }
        }
      }
      const timescale = info.timescale || 1;
      const samples = new Array(count);
      for (let index = 0; index < count; index += 1) {
        samples[index] = {
          offset: offsets[index],
          size: sizes[index],
          dts: dts[index],
          time: (cts[index] - start) / timescale,
          key: stss ? keys.has(index) : true,
        };
      }
      return {
        codec,
        description,
        width,
        height,
        timescale,
        rotation: info.rotation || 0,
        samples,
      };
    }
    return null;
  }

  // Read the movie box of a local MP4/MOV (bounded) and return its video sample table.
  async function readVideoSampleTable(file) {
    try {
      if (!file || typeof file.slice !== 'function' || !(file.size > 16)) return null;
      let offset = 0;
      for (let guard = 0; guard < 4096 && offset + 8 <= file.size; guard += 1) {
        const header = await sliceBytes(file, offset, Math.min(file.size, offset + 16));
        const headerView = new DataView(header.buffer);
        let size = headerView.getUint32(0, false);
        const type = fourcc(header, 4);
        if (guard === 0 && !['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip'].includes(type))
          return null;
        if (size === 1 && header.length >= 16)
          size = headerView.getUint32(8, false) * 4294967296 + headerView.getUint32(12, false);
        else if (size === 0) size = file.size - offset;
        if (size < 8) return null;
        if (type === 'moov') {
          if (size > LIMITS.maxMoovBytes) return null;
          return videoSampleTable(await sliceBytes(file, offset, offset + size));
        }
        offset += size;
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  // Parse an MP4/MOV 'moov' box (bytes must start at the moov header).
  function parseMoov(bytes) {
    const moov = boxes(bytes).next().value;
    if (!moov || moov.type !== 'moov') throw new Error('Not an MP4 movie box.');
    return children(bytes, moov, 'trak')
      .map((trak) => parseTrak(bytes, trak))
      .filter(Boolean);
  }

  // Parse a whole in-memory MP4 (used by tests and by small files).
  function parseMp4(bytes) {
    const top = [...boxes(bytes)];
    const moov = top.find((item) => item.type === 'moov');
    if (!moov) throw new Error('MP4 has no movie box.');
    return {
      boxes: top.map((item) => ({
        type: item.type,
        start: item.start,
        size: item.end - item.start,
      })),
      tracks: parseMoov(bytes.subarray(moov.start, moov.end)),
    };
  }

  // ---------------------------------------------------------------- EBML

  function readVint(bytes, offset, keepMarker) {
    const first = bytes[offset];
    if (first === undefined) return null;
    let length = 1;
    let mask = 0x80;
    while (length <= 8 && !(first & mask)) {
      length += 1;
      mask >>= 1;
    }
    if (length > 8 || offset + length > bytes.length) return null;
    let value = keepMarker ? first : first & (mask - 1);
    let allOnes = (first & (mask - 1)) === mask - 1;
    for (let index = 1; index < length; index += 1) {
      value = value * 256 + bytes[offset + index];
      if (bytes[offset + index] !== 255) allOnes = false;
    }
    return { value, length, unknown: !keepMarker && allOnes };
  }

  function readUint(bytes, start, end) {
    let value = 0;
    for (let index = start; index < end; index += 1) value = value * 256 + bytes[index];
    return value;
  }

  function readString(bytes, start, end) {
    let out = '';
    for (let index = start; index < end && bytes[index]; index += 1)
      out += String.fromCharCode(bytes[index]);
    return out;
  }

  const EBML = Object.freeze({
    header: 0x1a45dfa3,
    docType: 0x4282,
    segment: 0x18538067,
    tracks: 0x1654ae6b,
    trackEntry: 0xae,
    trackType: 0x83,
    codecId: 0x86,
    defaultDuration: 0x23e383,
    cluster: 0x1f43b675,
    video: 0xe0,
    pixelWidth: 0xb0,
    pixelHeight: 0xba,
    audio: 0xe1,
    channels: 0x9f,
  });

  function* elements(bytes, start, end) {
    let offset = start;
    let guard = 0;
    while (offset < end && guard < LIMITS.maxBoxes) {
      guard += 1;
      const id = readVint(bytes, offset, true);
      if (!id) return;
      const size = readVint(bytes, offset + id.length, false);
      if (!size) return;
      const body = offset + id.length + size.length;
      const stop = size.unknown ? end : Math.min(end, body + size.value);
      yield {
        id: id.value,
        body,
        end: stop,
        unknown: size.unknown,
        truncated: !size.unknown && body + size.value > end,
      };
      if (size.unknown) return;
      offset = body + size.value;
    }
  }

  function parseWebm(bytes) {
    const result = { docType: '', tracks: [] };
    for (const top of elements(bytes, 0, bytes.length)) {
      if (top.id === EBML.header) {
        for (const item of elements(bytes, top.body, top.end))
          if (item.id === EBML.docType) result.docType = readString(bytes, item.body, item.end);
      } else if (top.id === EBML.segment) {
        for (const item of elements(bytes, top.body, top.end)) {
          if (item.id === EBML.cluster) break;
          if (item.id !== EBML.tracks) continue;
          for (const entry of elements(bytes, item.body, item.end)) {
            if (entry.id !== EBML.trackEntry) continue;
            const track = { kind: 'other', codec: '', fps: null, width: 0, height: 0 };
            for (const field of elements(bytes, entry.body, entry.end)) {
              if (field.id === EBML.trackType) {
                const type = readUint(bytes, field.body, field.end);
                track.kind = type === 1 ? 'video' : type === 2 ? 'audio' : 'other';
              } else if (field.id === EBML.codecId) {
                track.codec = readString(bytes, field.body, field.end);
              } else if (field.id === EBML.defaultDuration) {
                const nanoseconds = readUint(bytes, field.body, field.end);
                if (nanoseconds > 0) track.fps = standardFrameRate(1e9 / nanoseconds);
              } else if (field.id === EBML.audio) {
                for (const item2 of elements(bytes, field.body, field.end))
                  if (item2.id === EBML.channels)
                    track.channels = readUint(bytes, item2.body, item2.end);
              } else if (field.id === EBML.video) {
                for (const dimension of elements(bytes, field.body, field.end)) {
                  if (dimension.id === EBML.pixelWidth)
                    track.width = readUint(bytes, dimension.body, dimension.end);
                  if (dimension.id === EBML.pixelHeight)
                    track.height = readUint(bytes, dimension.body, dimension.end);
                }
              }
            }
            result.tracks.push(track);
          }
          return result;
        }
      }
    }
    return result;
  }

  function summarize(container, tracks) {
    const videoTrack = tracks.find((track) => track.kind === 'video') || null;
    const audioTrack = tracks.find((track) => track.kind === 'audio') || null;
    return {
      container,
      hasVideo: Boolean(videoTrack),
      hasAudio: Boolean(audioTrack),
      videoCodec: videoTrack ? videoTrack.codec : '',
      audioCodec: audioTrack ? audioTrack.codec : '',
      fps: videoTrack && videoTrack.fps ? videoTrack.fps : null,
      variableRate: Boolean(videoTrack && videoTrack.variableRate),
      audioChannels: audioTrack && audioTrack.channels ? audioTrack.channels : null,
      rotation: videoTrack ? videoTrack.rotation || 0 : 0,
      // Length of the picture stream alone (MP4 only); audio priming can make the file longer.
      videoDuration:
        videoTrack && videoTrack.timescale && videoTrack.duration
          ? Math.round((videoTrack.duration / videoTrack.timescale) * 1000) / 1000
          : null,
    };
  }

  const UNKNOWN = Object.freeze({
    container: 'unknown',
    hasVideo: null,
    hasAudio: null,
    videoCodec: '',
    audioCodec: '',
    fps: null,
    rotation: 0,
    videoDuration: null,
  });

  async function sliceBytes(file, start, end) {
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  }

  // Probe a local File/Blob. Reads at most the movie box (MP4) or the first few
  // megabytes (WebM). Never throws for unknown input; returns UNKNOWN instead.
  async function probe(file) {
    try {
      if (!file || typeof file.slice !== 'function' || !(file.size > 16)) return UNKNOWN;
      const head = await sliceBytes(file, 0, Math.min(file.size, 64 * 1024));
      if (fourcc(head, 0) === 'RIFF' && fourcc(head, 8) === 'WAVE') {
        const view = new DataView(head.buffer);
        for (let at = 12; at + 8 <= head.length; ) {
          const size = view.getUint32(at + 4, true);
          if (fourcc(head, at) === 'fmt ' && at + 12 <= head.length)
            return Object.assign({}, UNKNOWN, {
              container: 'wav',
              hasVideo: false,
              hasAudio: true,
              audioCodec: 'pcm',
              audioChannels: view.getUint16(at + 10, true),
            });
          at += 8 + size + (size % 2);
        }
        return Object.assign({}, UNKNOWN, { container: 'wav', hasVideo: false, hasAudio: true });
      }
      if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
        const bytes =
          head.length >= Math.min(file.size, LIMITS.webmHeadBytes)
            ? head
            : await sliceBytes(file, 0, Math.min(file.size, LIMITS.webmHeadBytes));
        const parsed = parseWebm(bytes);
        if (!parsed.tracks.length)
          return Object.assign({}, UNKNOWN, { container: parsed.docType || 'webm' });
        return summarize(parsed.docType || 'webm', parsed.tracks);
      }
      if (
        fourcc(head, 4) !== 'ftyp' &&
        !['moov', 'mdat', 'free', 'wide', 'skip'].includes(fourcc(head, 4))
      )
        return UNKNOWN;
      // Walk top-level box headers through the file to find the movie box.
      let offset = 0;
      for (let guard = 0; guard < 4096 && offset + 8 <= file.size; guard += 1) {
        const header = await sliceBytes(file, offset, Math.min(file.size, offset + 16));
        const view = new DataView(header.buffer);
        let size = view.getUint32(0, false);
        const type = fourcc(header, 4);
        if (size === 1 && header.length >= 16)
          size = view.getUint32(8, false) * 4294967296 + view.getUint32(12, false);
        else if (size === 0) size = file.size - offset;
        if (size < 8) break;
        if (type === 'moov') {
          if (size > LIMITS.maxMoovBytes) return Object.assign({}, UNKNOWN, { container: 'mp4' });
          const moov = await sliceBytes(file, offset, offset + size);
          return summarize('mp4', parseMoov(moov));
        }
        offset += size;
      }
      return Object.assign({}, UNKNOWN, { container: 'mp4' });
    } catch (_) {
      return UNKNOWN;
    }
  }

  return Object.freeze({
    LIMITS,
    STANDARD_RATES,
    UNKNOWN,
    boxes,
    frameLookupTolerance,
    parseMoov,
    parseMp4,
    parseWebm,
    pickFrameIndex,
    probe,
    readVideoSampleTable,
    readVint,
    standardFrameRate,
    videoSampleTable,
  });
});

/* alcor-video-grade-core */
(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AlcorVideoGrade = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Lumetri-style extras on top of Basic Color: RGB curves, .cube 3D LUTs parsed
  // locally, vibrance, and scope data (waveform, vectorscope, histogram). The pure
  // functions here are the reference; the WebGL renderer below runs the same math
  // on the GPU for real-time preview and export.

  const LIMITS = Object.freeze({
    maxLutSize: 33,
    minLutSize: 2,
    maxLutFileBytes: 8 * 1024 * 1024,
    maxLuts: 8,
    maxCurvePoints: 16,
  });
  const CHANNELS = Object.freeze(['master', 'red', 'green', 'blue']);

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, number(value, min)));
  }

  function round(value, precision = 4) {
    const power = 10 ** precision;
    return Math.round(number(value) * power) / power;
  }

  // ------------------------------------------------------------------ curves

  function normalizeCurve(points) {
    if (!Array.isArray(points)) return null;
    const cleaned = points
      .filter((point) => point && typeof point === 'object')
      .map((point) => ({ x: round(clamp(point.x, 0, 1)), y: round(clamp(point.y, 0, 1)) }))
      .sort((a, b) => a.x - b.x);
    const unique = [];
    for (const point of cleaned) {
      if (unique.length && Math.abs(unique[unique.length - 1].x - point.x) < 0.001)
        unique[unique.length - 1] = point;
      else unique.push(point);
    }
    if (unique.length < 2) return null;
    const limited = unique.slice(0, LIMITS.maxCurvePoints);
    const identity =
      limited.length === 2 &&
      limited[0].x === 0 &&
      limited[0].y === 0 &&
      limited[1].x === 1 &&
      limited[1].y === 1;
    return identity ? null : limited;
  }

  function normalizeCurves(value) {
    if (!value || typeof value !== 'object') return null;
    const out = {};
    for (const channel of CHANNELS) {
      const curve = normalizeCurve(value[channel]);
      if (curve) out[channel] = curve;
    }
    return Object.keys(out).length ? out : null;
  }

  // Monotone cubic (Fritsch-Carlson) through the points, sampled to a table: a
  // curve never overshoots between its control points, so it cannot invert tones.
  function curveTable(points, size = 256) {
    const table = new Float32Array(size);
    const curve = normalizeCurve(points);
    if (!curve) {
      for (let index = 0; index < size; index += 1) table[index] = index / (size - 1);
      return table;
    }
    const pts = curve[0].x > 0 ? [{ x: 0, y: curve[0].y }, ...curve] : curve.slice();
    if (pts[pts.length - 1].x < 1) pts.push({ x: 1, y: pts[pts.length - 1].y });
    const n = pts.length;
    const slopes = [];
    const tangents = new Array(n).fill(0);
    for (let index = 0; index < n - 1; index += 1)
      slopes.push(
        (pts[index + 1].y - pts[index].y) / Math.max(1e-6, pts[index + 1].x - pts[index].x),
      );
    tangents[0] = slopes[0];
    tangents[n - 1] = slopes[n - 2];
    for (let index = 1; index < n - 1; index += 1)
      tangents[index] =
        slopes[index - 1] * slopes[index] <= 0 ? 0 : (slopes[index - 1] + slopes[index]) / 2;
    for (let index = 0; index < n - 1; index += 1) {
      if (slopes[index] === 0) {
        tangents[index] = 0;
        tangents[index + 1] = 0;
        continue;
      }
      const a = tangents[index] / slopes[index];
      const b = tangents[index + 1] / slopes[index];
      const h = Math.hypot(a, b);
      if (h > 3) {
        tangents[index] = ((3 * a) / h) * slopes[index];
        tangents[index + 1] = ((3 * b) / h) * slopes[index];
      }
    }
    let segment = 0;
    for (let index = 0; index < size; index += 1) {
      const x = index / (size - 1);
      while (segment < n - 2 && x > pts[segment + 1].x) segment += 1;
      const p0 = pts[segment];
      const p1 = pts[segment + 1];
      const h = Math.max(1e-6, p1.x - p0.x);
      const t = clamp((x - p0.x) / h, 0, 1);
      const t2 = t * t;
      const t3 = t2 * t;
      const value =
        (2 * t3 - 3 * t2 + 1) * p0.y +
        (t3 - 2 * t2 + t) * h * tangents[segment] +
        (-2 * t3 + 3 * t2) * p1.y +
        (t3 - t2) * h * tangents[segment + 1];
      table[index] = clamp(value, 0, 1);
    }
    return table;
  }

  // Four 256-entry tables (master applied after each channel curve).
  function curveTables(curves) {
    const normalized = normalizeCurves(curves) || {};
    return Object.fromEntries(
      CHANNELS.map((channel) => [channel, curveTable(normalized[channel])]),
    );
  }

  // --------------------------------------------------------------------- LUTs

  // Parse an Adobe/Resolve .cube 3D LUT. Red varies fastest. Rejects 1D LUTs,
  // wrong sample counts, non-finite values and oversize tables with a clear error.
  function parseCube(text) {
    const source = String(text || '');
    if (source.length > LIMITS.maxLutFileBytes)
      throw new Error('The LUT file is too large (8 MB limit).');
    let size = 0;
    let title = '';
    let domainMin = [0, 0, 0];
    let domainMax = [1, 1, 1];
    const values = [];
    for (const rawLine of source.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const upper = line.toUpperCase();
      if (upper.startsWith('TITLE')) {
        title = line.slice(5).trim().replace(/^"|"$/g, '').slice(0, 80);
        continue;
      }
      if (upper.startsWith('LUT_1D_SIZE'))
        throw new Error('1D LUTs are not supported; export a 3D .cube LUT.');
      if (upper.startsWith('LUT_3D_SIZE')) {
        size = Number(line.split(/\s+/)[1]);
        if (!Number.isInteger(size) || size < LIMITS.minLutSize || size > LIMITS.maxLutSize)
          throw new Error(
            `LUT size must be between ${LIMITS.minLutSize} and ${LIMITS.maxLutSize} (this file says ${line.split(/\s+/)[1]}).`,
          );
        continue;
      }
      if (upper.startsWith('DOMAIN_MIN')) {
        domainMin = line.split(/\s+/).slice(1, 4).map(Number);
        continue;
      }
      if (upper.startsWith('DOMAIN_MAX')) {
        domainMax = line.split(/\s+/).slice(1, 4).map(Number);
        continue;
      }
      if (/^LUT_|^[A-Z_]+\s/.test(upper) && !/^[-+.\d]/.test(line)) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 3) throw new Error(`Unreadable LUT line: ${line.slice(0, 40)}`);
      for (let index = 0; index < 3; index += 1) {
        const value = Number(parts[index]);
        if (!Number.isFinite(value))
          throw new Error(`LUT value is not a number: ${parts[index].slice(0, 20)}`);
        values.push(value);
      }
    }
    if (!size) throw new Error('This file has no LUT_3D_SIZE line; it is not a 3D .cube LUT.');
    const expected = size * size * size * 3;
    if (values.length !== expected)
      throw new Error(
        `The LUT has ${values.length / 3} entries; LUT_3D_SIZE ${size} needs ${expected / 3}.`,
      );
    if (
      [...domainMin, ...domainMax].some((value) => !Number.isFinite(value)) ||
      domainMax.some((value, index) => value <= domainMin[index])
    )
      throw new Error('The LUT domain is invalid.');
    const data = new Float32Array(expected);
    for (let index = 0; index < expected; index += 1) data[index] = clamp(values[index], 0, 1);
    return { title, size, domainMin, domainMax, data };
  }

  // Compact storage for projects: 16-bit samples, base64.
  function encodeLut(lut) {
    const bytes = new Uint8Array(lut.data.length * 2);
    for (let index = 0; index < lut.data.length; index += 1) {
      const value = Math.round(clamp(lut.data[index], 0, 1) * 65535);
      bytes[index * 2] = value & 255;
      bytes[index * 2 + 1] = value >>> 8;
    }
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000)
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
    return typeof btoa === 'function'
      ? btoa(binary)
      : Buffer.from(binary, 'binary').toString('base64');
  }

  function decodeLut(record) {
    if (!record || typeof record !== 'object') return null;
    const size = Number(record.size);
    if (
      !Number.isInteger(size) ||
      size < LIMITS.minLutSize ||
      size > LIMITS.maxLutSize ||
      typeof record.data !== 'string'
    )
      return null;
    let binary;
    try {
      binary =
        typeof atob === 'function'
          ? atob(record.data)
          : Buffer.from(record.data, 'base64').toString('binary');
    } catch (_) {
      return null;
    }
    const expected = size * size * size * 3;
    if (binary.length !== expected * 2) return null;
    const data = new Float32Array(expected);
    for (let index = 0; index < expected; index += 1)
      data[index] =
        (binary.charCodeAt(index * 2) | (binary.charCodeAt(index * 2 + 1) << 8)) / 65535;
    return { size, data };
  }

  function normalizeLutRecord(record) {
    if (!record || typeof record !== 'object') return null;
    const id = String(record.id || '').slice(0, 100);
    if (!/^[a-z0-9][a-z0-9._:-]{0,99}$/i.test(id)) return null;
    const decoded = decodeLut(record);
    if (!decoded) return null;
    return {
      id,
      name: String(record.name || 'LUT').slice(0, 80),
      size: decoded.size,
      data: record.data,
    };
  }

  function lutSample(lut, r, g, b) {
    const size = lut.size;
    const scale = size - 1;
    const fr = clamp(r, 0, 1) * scale;
    const fg = clamp(g, 0, 1) * scale;
    const fb = clamp(b, 0, 1) * scale;
    const r0 = Math.floor(fr);
    const g0 = Math.floor(fg);
    const b0 = Math.floor(fb);
    const r1 = Math.min(scale, r0 + 1);
    const g1 = Math.min(scale, g0 + 1);
    const b1 = Math.min(scale, b0 + 1);
    const dr = fr - r0;
    const dg = fg - g0;
    const db = fb - b0;
    const out = [0, 0, 0];
    const at = (ri, gi, bi, channel) => lut.data[((bi * size + gi) * size + ri) * 3 + channel];
    for (let channel = 0; channel < 3; channel += 1) {
      const c00 = at(r0, g0, b0, channel) * (1 - dr) + at(r1, g0, b0, channel) * dr;
      const c10 = at(r0, g1, b0, channel) * (1 - dr) + at(r1, g1, b0, channel) * dr;
      const c01 = at(r0, g0, b1, channel) * (1 - dr) + at(r1, g0, b1, channel) * dr;
      const c11 = at(r0, g1, b1, channel) * (1 - dr) + at(r1, g1, b1, channel) * dr;
      const c0 = c00 * (1 - dg) + c10 * dg;
      const c1 = c01 * (1 - dg) + c11 * dg;
      out[channel] = c0 * (1 - db) + c1 * db;
    }
    return out;
  }

  // ------------------------------------------------- color wheels (lift/gamma/gain)
  // Each wheel is a disc position (x, y in -1..1, the color push) plus a level (l).
  // Shadows lift the black point, midtones bend gamma, highlights scale the white point.

  const WHEELS = Object.freeze(['lift', 'gamma', 'gain']);
  const PHASES = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3];

  function normalizeWheels(value) {
    if (!value || typeof value !== 'object') return null;
    const out = {};
    for (const name of WHEELS) {
      const wheel = value[name];
      if (!wheel || typeof wheel !== 'object') continue;
      let x = clamp(wheel.x || 0, -1, 1);
      let y = clamp(wheel.y || 0, -1, 1);
      const length = Math.hypot(x, y);
      if (length > 1) {
        x /= length;
        y /= length;
      }
      const normalized = {
        x: round(x, 4),
        y: round(y, 4),
        l: round(clamp(wheel.l || 0, -1, 1), 4),
      };
      if (normalized.x || normalized.y || normalized.l) out[name] = normalized;
    }
    return Object.keys(out).length ? out : null;
  }

  // Per-channel coefficients: lift (additive black, -0.5..0.5), gamma exponent, gain multiplier.
  function wheelCoefficients(wheels) {
    const value = normalizeWheels(wheels) || {};
    const channel = (wheel, index) => {
      if (!wheel) return 0;
      const push = wheel.x * Math.cos(PHASES[index]) + wheel.y * Math.sin(PHASES[index]);
      return clamp(wheel.l + 0.5 * push, -1, 1);
    };
    const lift = [0, 1, 2].map((index) => 0.5 * channel(value.lift, index));
    const gamma = [0, 1, 2].map((index) => Math.pow(2, -channel(value.gamma, index)));
    const gain = [0, 1, 2].map((index) => 1 + channel(value.gain, index));
    return { lift, gamma, gain };
  }

  function applyWheelsPixel(rgb, coefficients) {
    return rgb.map((n, index) => {
      const v = clamp(coefficients.gain[index] * (n + coefficients.lift[index] * (1 - n)), 0, 1);
      return Math.pow(v, coefficients.gamma[index]);
    });
  }

  // ------------------------------------------------------- HSL secondary
  // Qualify a hue/saturation/luminance range (soft edges), then shift its hue,
  // scale its saturation and lift or lower its luminance.

  const HSL_DEFAULTS = Object.freeze({
    hue: 120,
    hueRange: 30,
    satMin: 10,
    satMax: 100,
    lumMin: 5,
    lumMax: 95,
    softness: 30,
    hueShift: 0,
    saturation: 0,
    luma: 0,
  });
  const HSL_LIMITS = Object.freeze({
    hue: [0, 360],
    hueRange: [0, 180],
    satMin: [0, 100],
    satMax: [0, 100],
    lumMin: [0, 100],
    lumMax: [0, 100],
    softness: [0, 100],
    hueShift: [-180, 180],
    saturation: [-100, 100],
    luma: [-100, 100],
  });

  function normalizeHsl(value) {
    if (!value || typeof value !== 'object') return null;
    const out = {};
    for (const [name, [min, max]] of Object.entries(HSL_LIMITS))
      out[name] = round(clamp(value[name] == null ? HSL_DEFAULTS[name] : value[name], min, max), 3);
    if (out.satMax < out.satMin) out.satMax = out.satMin;
    if (out.lumMax < out.lumMin) out.lumMax = out.lumMin;
    return out;
  }

  // A qualifier with no correction changes nothing; the renderer skips it.
  function activeHsl(value) {
    const q = normalizeHsl(value);
    return q && (q.hueShift || q.saturation || q.luma) ? q : null;
  }

  function rgbToHsl(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (d < 1e-6) return [0, 0, l];
    const s = Math.min(1, d / (1 - Math.abs(2 * l - 1) + 1e-6));
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
    return [h, s, l];
  }

  function hslToRgb(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = (((h % 360) + 360) % 360) / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let rgb;
    if (hp < 1) rgb = [c, x, 0];
    else if (hp < 2) rgb = [x, c, 0];
    else if (hp < 3) rgb = [0, c, x];
    else if (hp < 4) rgb = [0, x, c];
    else if (hp < 5) rgb = [x, 0, c];
    else rgb = [c, 0, x];
    const m = l - c / 2;
    return [rgb[0] + m, rgb[1] + m, rgb[2] + m];
  }

  function ramp(a, b, x) {
    return clamp((x - a) / Math.max(1e-4, b - a), 0, 1);
  }

  // How strongly a color is selected by the HSL qualifier (0..1).
  function hslMask(h, s, l, q) {
    const softHue = (q.softness / 100) * 60;
    const softRange = (q.softness / 100) * 0.25;
    const distance = Math.min(Math.abs(h - q.hue), 360 - Math.abs(h - q.hue));
    const hueWeight = q.hueRange >= 180 ? 1 : 1 - ramp(q.hueRange, q.hueRange + softHue, distance);
    const satWeight =
      ramp(q.satMin / 100 - softRange, q.satMin / 100, s) *
      (1 - ramp(q.satMax / 100, q.satMax / 100 + softRange, s));
    const lumWeight =
      ramp(q.lumMin / 100 - softRange, q.lumMin / 100, l) *
      (1 - ramp(q.lumMax / 100, q.lumMax / 100 + softRange, l));
    return hueWeight * satWeight * lumWeight;
  }

  function applyHslPixel(rgb, q) {
    const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
    const mask = hslMask(h, s, l, q);
    if (mask <= 0) return rgb;
    return hslToRgb(
      h + q.hueShift * mask,
      clamp(s * (1 + (q.saturation / 100) * mask), 0, 1),
      clamp(l + (q.luma / 100) * 0.5 * mask, 0, 1),
    );
  }

  // ------------------------------------------------------- CPU reference path

  // Vibrance lifts saturation more for muted colors than for already saturated ones.
  function vibranceMix(red, green, blue, vibrance) {
    if (!vibrance) return [red, green, blue];
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const saturation = max > 0 ? (max - min) / max : 0;
    const amount = (vibrance / 100) * (1 - saturation);
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    const factor = 1 + amount;
    return [
      luminance + (red - luminance) * factor,
      luminance + (green - luminance) * factor,
      luminance + (blue - luminance) * factor,
    ];
  }

  // Apply vibrance, color wheels, HSL secondary, curves and LUT (in that order,
  // after Basic Color) to RGBA bytes.
  function applyExtrasToRgba(data, grade = {}) {
    const vibrance = clamp(grade.vibrance || 0, -100, 100);
    const tables = grade.curves ? curveTables(grade.curves) : null;
    const lut = grade.lut || null;
    const intensity = clamp(grade.lutIntensity == null ? 1 : grade.lutIntensity, 0, 1);
    const wheels = normalizeWheels(grade.wheels) ? wheelCoefficients(grade.wheels) : null;
    const hsl = activeHsl(grade.hsl);
    if (!vibrance && !tables && !lut && !wheels && !hsl) return data;
    for (let index = 0; index + 3 < data.length; index += 4) {
      let r = data[index] / 255;
      let g = data[index + 1] / 255;
      let b = data[index + 2] / 255;
      if (vibrance) [r, g, b] = vibranceMix(r, g, b, vibrance);
      if (wheels)
        [r, g, b] = applyWheelsPixel([clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1)], wheels);
      if (hsl) [r, g, b] = applyHslPixel([clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1)], hsl);
      if (tables) {
        const lookup = (table, value) => table[Math.round(clamp(value, 0, 1) * 255)];
        r = lookup(tables.master, lookup(tables.red, r));
        g = lookup(tables.master, lookup(tables.green, g));
        b = lookup(tables.master, lookup(tables.blue, b));
      }
      if (lut) {
        const mapped = lutSample(lut, r, g, b);
        r += (mapped[0] - r) * intensity;
        g += (mapped[1] - g) * intensity;
        b += (mapped[2] - b) * intensity;
      }
      data[index] = clamp(r, 0, 1) * 255;
      data[index + 1] = clamp(g, 0, 1) * 255;
      data[index + 2] = clamp(b, 0, 1) * 255;
    }
    return data;
  }

  // ------------------------------------------------------------------ scopes

  // Scope data from RGBA pixels: luma waveform (columns x 256 levels),
  // vectorscope (Cb/Cr 2D histogram) and RGB histograms.
  function computeScopes(data, width, height, options = {}) {
    const columns = Math.max(1, Math.min(width, options.columns || 256));
    const waveform = new Uint32Array(columns * 256);
    const vectorSize = options.vectorSize || 128;
    const vector = new Uint32Array(vectorSize * vectorSize);
    const histogram = {
      red: new Uint32Array(256),
      green: new Uint32Array(256),
      blue: new Uint32Array(256),
      luma: new Uint32Array(256),
    };
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        const r = data[index];
        const g = data[index + 1];
        const b = data[index + 2];
        const luma = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
        histogram.red[r] += 1;
        histogram.green[g] += 1;
        histogram.blue[b] += 1;
        histogram.luma[luma] += 1;
        const column = Math.min(columns - 1, Math.floor((x * columns) / width));
        waveform[column * 256 + luma] += 1;
        const cb = -0.1146 * r - 0.3854 * g + 0.5 * b;
        const cr = 0.5 * r - 0.4542 * g - 0.0458 * b;
        const vx = Math.min(
          vectorSize - 1,
          Math.max(0, Math.round((cb / 255 + 0.5) * (vectorSize - 1))),
        );
        const vy = Math.min(
          vectorSize - 1,
          Math.max(0, Math.round((0.5 - cr / 255) * (vectorSize - 1))),
        );
        vector[vy * vectorSize + vx] += 1;
      }
    }
    return { columns, waveform, vectorSize, vector, histogram };
  }

  // ----------------------------------------------------------- WebGL renderer

  const VERTEX = `#version 300 es
in vec2 position; out vec2 uv;
void main() { uv = vec2(position.x * 0.5 + 0.5, 0.5 - position.y * 0.5); gl_Position = vec4(position, 0.0, 1.0); }`;

  const FRAGMENT = `#version 300 es
precision highp float; precision highp sampler3D;
in vec2 uv; out vec4 color;
uniform sampler2D source; uniform sampler2D curves; uniform sampler3D lut;
uniform float exposure; uniform float brightness; uniform float contrast; uniform float saturation;
uniform float temperature; uniform float tint; uniform vec4 tones; uniform float vibrance;
uniform float useCurves; uniform float useLut; uniform float lutIntensity; uniform float lutScale; uniform float lutOffset;
uniform float useWheels; uniform vec3 wLift; uniform vec3 wGamma; uniform vec3 wGain;
uniform float useHsl; uniform vec4 hslKey; uniform vec4 hslRange; uniform vec4 hslAdjust;
float sstep(float a, float b, float v) { return smoothstep(a, b, v); }
float ramp(float a, float b, float x) { return clamp((x - a) / max(1e-4, b - a), 0.0, 1.0); }
vec3 rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b)); float mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5; float d = mx - mn;
  if (d < 1e-6) return vec3(0.0, 0.0, l);
  float s = min(1.0, d / (1.0 - abs(2.0 * l - 1.0) + 1e-6));
  float h;
  if (mx == c.r) h = mod((c.g - c.b) / d, 6.0); else if (mx == c.g) h = (c.b - c.r) / d + 2.0; else h = (c.r - c.g) / d + 4.0;
  h *= 60.0; if (h < 0.0) h += 360.0;
  return vec3(h, s, l);
}
vec3 hsl2rgb(vec3 hsl) {
  float c = (1.0 - abs(2.0 * hsl.z - 1.0)) * hsl.y;
  float hp = mod(mod(hsl.x, 360.0) + 360.0, 360.0) / 60.0;
  float x = c * (1.0 - abs(mod(hp, 2.0) - 1.0));
  vec3 rgb;
  if (hp < 1.0) rgb = vec3(c, x, 0.0); else if (hp < 2.0) rgb = vec3(x, c, 0.0); else if (hp < 3.0) rgb = vec3(0.0, c, x);
  else if (hp < 4.0) rgb = vec3(0.0, x, c); else if (hp < 5.0) rgb = vec3(x, 0.0, c); else rgb = vec3(c, 0.0, x);
  return rgb + (hsl.z - c * 0.5);
}
void main() {
  vec4 src = texture(source, uv);
  vec3 c = src.rgb * 255.0;
  c *= brightness * exposure;
  float level = clamp(max(c.r, max(c.g, c.b)) / 255.0, 0.0, 1.0);
  c += vec3(32.0 * temperature + 16.0 * tint, -32.0 * tint, -32.0 * temperature + 16.0 * tint) * level;
  c = (c - 127.5) * contrast + 127.5;
  if (tones != vec4(0.0)) {
    float l = clamp((0.213 * c.r + 0.715 * c.g + 0.072 * c.b) / 255.0, 0.0, 1.0);
    float d = 64.0 * tones.x * (1.0 - sstep(0.0, 0.55, l)) + 64.0 * tones.y * sstep(0.45, 1.0, l)
      + 48.0 * tones.z * (1.0 - sstep(0.0, 0.25, l)) + 48.0 * tones.w * sstep(0.75, 1.0, l);
    c += d;
  }
  float lum = 0.213 * c.r + 0.715 * c.g + 0.072 * c.b;
  c = lum + (c - lum) * saturation;
  vec3 n = clamp(c / 255.0, 0.0, 1.0);
  if (vibrance != 0.0) {
    float mx = max(n.r, max(n.g, n.b)); float mn = min(n.r, min(n.g, n.b));
    float sat = mx > 0.0 ? (mx - mn) / mx : 0.0;
    float amount = vibrance * (1.0 - sat);
    float l2 = dot(n, vec3(0.2126, 0.7152, 0.0722));
    n = clamp(l2 + (n - l2) * (1.0 + amount), 0.0, 1.0);
  }
  if (useWheels > 0.5) {
    n = pow(clamp(wGain * (n + wLift * (1.0 - n)), 0.0, 1.0), wGamma);
  }
  if (useHsl > 0.5) {
    vec3 q = rgb2hsl(n);
    float softHue = hslKey.z * 60.0; float softRange = hslKey.z * 0.25;
    float dist = min(abs(q.x - hslKey.x), 360.0 - abs(q.x - hslKey.x));
    float hw = hslKey.y >= 180.0 ? 1.0 : 1.0 - ramp(hslKey.y, hslKey.y + softHue, dist);
    float sw = ramp(hslRange.x - softRange, hslRange.x, q.y) * (1.0 - ramp(hslRange.y, hslRange.y + softRange, q.y));
    float lw = ramp(hslRange.z - softRange, hslRange.z, q.z) * (1.0 - ramp(hslRange.w, hslRange.w + softRange, q.z));
    float mask = hw * sw * lw;
    if (mask > 0.0) n = hsl2rgb(vec3(q.x + hslAdjust.x * mask, clamp(q.y * (1.0 + hslAdjust.y * mask), 0.0, 1.0), clamp(q.z + hslAdjust.z * 0.5 * mask, 0.0, 1.0)));
  }
  if (useCurves > 0.5) {
    n = vec3(texture(curves, vec2(n.r, 0.375)).r, texture(curves, vec2(n.g, 0.625)).r, texture(curves, vec2(n.b, 0.875)).r);
    n = vec3(texture(curves, vec2(n.r, 0.125)).r, texture(curves, vec2(n.g, 0.125)).r, texture(curves, vec2(n.b, 0.125)).r);
  }
  if (useLut > 0.5) {
    vec3 mapped = texture(lut, n * lutScale + lutOffset).rgb;
    n = mix(n, mapped, lutIntensity);
  }
  color = vec4(n, src.a);
}`;

  function createRenderer(documentRef = typeof document !== 'undefined' ? document : null) {
    if (!documentRef) return null;
    const canvas = documentRef.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    let gl = null;
    try {
      gl = canvas.getContext('webgl2', {
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
        antialias: false,
      });
    } catch (_) {
      gl = null;
    }
    if (!gl) return null;
    const compile = (type, text) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, text);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(shader) || 'shader');
      return shader;
    };
    let program;
    try {
      program = gl.createProgram();
      gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    } catch (_) {
      return null;
    }
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const uniforms = {};
    for (const name of [
      'source',
      'curves',
      'lut',
      'exposure',
      'brightness',
      'contrast',
      'saturation',
      'temperature',
      'tint',
      'tones',
      'vibrance',
      'useCurves',
      'useLut',
      'lutIntensity',
      'lutScale',
      'lutOffset',
      'useWheels',
      'wLift',
      'wGamma',
      'wGain',
      'useHsl',
      'hslKey',
      'hslRange',
      'hslAdjust',
    ])
      uniforms[name] = gl.getUniformLocation(program, name);
    const texture = (unit) => {
      const handle = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      return handle;
    };
    const sourceTexture = texture(0);
    gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
    for (const [key, value] of [
      [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
      [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
    ])
      gl.texParameteri(gl.TEXTURE_2D, key, value);
    const curvesTexture = texture(1);
    gl.bindTexture(gl.TEXTURE_2D, curvesTexture);
    for (const [key, value] of [
      [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
      [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
    ])
      gl.texParameteri(gl.TEXTURE_2D, key, value);
    const lutTexture = texture(2);
    gl.bindTexture(gl.TEXTURE_3D, lutTexture);
    for (const [key, value] of [
      [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
      [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE],
    ])
      gl.texParameteri(gl.TEXTURE_3D, key, value);
    gl.uniform1i(uniforms.source, 0);
    gl.uniform1i(uniforms.curves, 1);
    gl.uniform1i(uniforms.lut, 2);
    let curvesKey = '';
    let lutKey = '';
    let lost = false;
    canvas.addEventListener?.('webglcontextlost', (event) => {
      event.preventDefault?.();
      lost = true;
    });

    function uploadCurves(curves) {
      const key = JSON.stringify(curves || null);
      if (key === curvesKey) return;
      curvesKey = key;
      const tables = curveTables(curves);
      const pixels = new Uint8Array(256 * 4 * 4);
      CHANNELS.forEach((channel, row) => {
        for (let index = 0; index < 256; index += 1) {
          const value = Math.round(tables[channel][index] * 255);
          const offset = (row * 256 + index) * 4;
          pixels[offset] = value;
          pixels[offset + 1] = value;
          pixels[offset + 2] = value;
          pixels[offset + 3] = 255;
        }
      });
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, curvesTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    }

    function uploadLut(id, lut) {
      if (!lut || id === lutKey) return;
      lutKey = id;
      const size = lut.size;
      const pixels = new Uint8Array(size * size * size * 4);
      for (let index = 0; index < size * size * size; index += 1) {
        pixels[index * 4] = Math.round(lut.data[index * 3] * 255);
        pixels[index * 4 + 1] = Math.round(lut.data[index * 3 + 1] * 255);
        pixels[index * 4 + 2] = Math.round(lut.data[index * 3 + 2] * 255);
        pixels[index * 4 + 3] = 255;
      }
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_3D, lutTexture);
      gl.texImage3D(
        gl.TEXTURE_3D,
        0,
        gl.RGBA8,
        size,
        size,
        size,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      );
      gl.uniform1f(uniforms.lutScale, (size - 1) / size);
      gl.uniform1f(uniforms.lutOffset, 0.5 / size);
    }

    return {
      canvas,
      get lost() {
        return lost || gl.isContextLost();
      },
      // Grade one source frame into the renderer canvas at the given size.
      render(source, width, height, color, extras = {}) {
        if (lost || gl.isContextLost()) return null;
        const w = Math.max(1, Math.round(width));
        const h = Math.max(1, Math.round(height));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        gl.viewport(0, 0, w, h);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        } catch (_) {
          return null;
        }
        const c = color || {};
        gl.uniform1f(uniforms.exposure, Math.pow(2, number(c.exposure)));
        gl.uniform1f(uniforms.brightness, (100 + number(c.brightness)) / 100);
        gl.uniform1f(uniforms.contrast, (100 + number(c.contrast)) / 100);
        gl.uniform1f(uniforms.saturation, number(c.saturation, 100) / 100);
        gl.uniform1f(uniforms.temperature, number(c.temperature) / 100);
        gl.uniform1f(uniforms.tint, number(c.tint) / 100);
        gl.uniform4f(
          uniforms.tones,
          number(c.shadows) / 100,
          number(c.highlights) / 100,
          number(c.blacks) / 100,
          number(c.whites) / 100,
        );
        gl.uniform1f(uniforms.vibrance, clamp(extras.vibrance || 0, -100, 100) / 100);
        const curves = normalizeCurves(extras.curves);
        gl.uniform1f(uniforms.useCurves, curves ? 1 : 0);
        if (curves) uploadCurves(curves);
        const wheels = normalizeWheels(extras.wheels);
        gl.uniform1f(uniforms.useWheels, wheels ? 1 : 0);
        if (wheels) {
          const k = wheelCoefficients(wheels);
          gl.uniform3f(uniforms.wLift, k.lift[0], k.lift[1], k.lift[2]);
          gl.uniform3f(uniforms.wGamma, k.gamma[0], k.gamma[1], k.gamma[2]);
          gl.uniform3f(uniforms.wGain, k.gain[0], k.gain[1], k.gain[2]);
        }
        const hsl = activeHsl(extras.hsl);
        gl.uniform1f(uniforms.useHsl, hsl ? 1 : 0);
        if (hsl) {
          gl.uniform4f(uniforms.hslKey, hsl.hue, hsl.hueRange, hsl.softness / 100, 0);
          gl.uniform4f(
            uniforms.hslRange,
            hsl.satMin / 100,
            hsl.satMax / 100,
            hsl.lumMin / 100,
            hsl.lumMax / 100,
          );
          gl.uniform4f(uniforms.hslAdjust, hsl.hueShift, hsl.saturation / 100, hsl.luma / 100, 0);
        }
        const lut = extras.lut || null;
        gl.uniform1f(uniforms.useLut, lut ? 1 : 0);
        if (lut) {
          uploadLut(extras.lutId || 'lut', lut);
          gl.uniform1f(
            uniforms.lutIntensity,
            clamp(extras.lutIntensity == null ? 1 : extras.lutIntensity, 0, 1),
          );
        }
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        return canvas;
      },
    };
  }

  return Object.freeze({
    CHANNELS,
    HSL_DEFAULTS,
    LIMITS,
    WHEELS,
    activeHsl,
    applyExtrasToRgba,
    applyHslPixel,
    applyWheelsPixel,
    hslMask,
    hslToRgb,
    computeScopes,
    createRenderer,
    curveTable,
    curveTables,
    decodeLut,
    encodeLut,
    lutSample,
    normalizeCurve,
    normalizeCurves,
    normalizeHsl,
    normalizeLutRecord,
    normalizeWheels,
    parseCube,
    rgbToHsl,
    vibranceMix,
    wheelCoefficients,
  });
});

/* alcor-video-ui */
(() => {
  'use strict';

  const root = document.querySelector('[data-alcor-video-editor]');
  if (!root) return;

  const local = root.hasAttribute('data-alcor-local-distribution');
  root.dataset.alcorVideoEnhancements = local
    ? 'transitions-captions-local'
    : 'transitions-captions-offline';

  const clipInspector = root.querySelector('#av-clip-inspector');
  const inspectorActions = clipInspector?.querySelector('.av-inspector-actions');
  if (clipInspector && inspectorActions && !clipInspector.elements.namedItem('fadeIn')) {
    const makeFadeField = (name, labelText) => {
      const label = document.createElement('label');
      label.className = 'av-enhancement-field';
      label.textContent = labelText;
      const input = document.createElement('input');
      input.name = name;
      input.type = 'number';
      input.min = '0';
      input.max = '60';
      input.step = '0.05';
      input.value = '0';
      label.append(input);
      return label;
    };

    clipInspector.insertBefore(makeFadeField('fadeIn', 'Fade in'), inspectorActions);
    clipInspector.insertBefore(makeFadeField('fadeOut', 'Fade out'), inspectorActions);

    const presetRow = document.createElement('div');
    presetRow.className = 'av-inspector-actions av-field-wide av-fade-presets';
    presetRow.setAttribute('aria-label', 'Fade presets');
    for (const [label, seconds] of [
      ['Clear fades', 0],
      ['0.5s fades', 0.5],
      ['1s fades', 1],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.dataset.avFadePreset = String(seconds);
      presetRow.append(button);
    }
    clipInspector.insertBefore(presetRow, inspectorActions);
  }

  const timelineTools = root.querySelector('.av-timeline-tools');
  if (timelineTools && !root.querySelector('#av-caption-input')) {
    const captionLabel = document.createElement('label');
    captionLabel.className = 'av-file-button av-caption-button';
    captionLabel.textContent = 'Import SRT';
    captionLabel.title = 'Convert an SRT subtitle file into editable V2 title clips';
    const captionInput = document.createElement('input');
    captionInput.id = 'av-caption-input';
    captionInput.type = 'file';
    captionInput.accept = '.srt,application/x-subrip,text/plain';
    captionLabel.append(captionInput);

    const exportButton = document.createElement('button');
    exportButton.id = 'av-caption-export';
    exportButton.type = 'button';
    exportButton.textContent = 'Export SRT';
    exportButton.title = 'Export every title clip as an SRT subtitle cue';

    // With a File menu, captions and install live there and the timeline toolbar stays for editing.
    const fileMenu = root.querySelector('#av-file-menu');
    const intoMenu = (...items) => {
      const rule = document.createElement('span');
      rule.className = 'av-menu-rule';
      rule.setAttribute('role', 'separator');
      for (const item of items) item.setAttribute('role', 'menuitem');
      const before = fileMenu.querySelector('.av-recovery-toggle')?.previousElementSibling || null;
      fileMenu.insertBefore(rule, before);
      for (const item of items) fileMenu.insertBefore(item, before);
    };
    if (local)
      fileMenu
        ? intoMenu(captionLabel, exportButton)
        : timelineTools.prepend(captionLabel, exportButton);
    if (!local) {
      const installButton = document.createElement('button');
      installButton.id = 'av-install-app';
      installButton.type = 'button';
      installButton.textContent = 'Install app';
      installButton.hidden = false;
      installButton.title = 'Install AlcorVideo or show the steps for this browser';
      installButton.setAttribute('aria-describedby', 'av-offline-state');

      const offlineState = document.createElement('span');
      offlineState.id = 'av-offline-state';
      offlineState.className = 'av-offline-state';
      offlineState.setAttribute('role', 'status');
      offlineState.textContent = navigator.onLine
        ? 'Online · media stays local'
        : 'Offline editor shell';

      if (fileMenu) {
        intoMenu(captionLabel, exportButton, installButton);
        const statusbar = root.querySelector('.av-statusbar');
        statusbar ? statusbar.prepend(offlineState) : timelineTools.prepend(offlineState);
      } else {
        timelineTools.prepend(captionLabel, exportButton, installButton, offlineState);
      }
    }
  }

  function applyPreset(seconds) {
    const form = root.querySelector('#av-clip-inspector');
    if (!form || form.hidden) return;
    for (const name of ['fadeIn', 'fadeOut']) {
      const field = form.elements.namedItem(name);
      if (!field) continue;
      field.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      field.value = String(seconds);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    }
  }

  root.addEventListener('click', (event) => {
    const preset = event.target.closest('[data-av-fade-preset]');
    if (!preset) return;
    event.preventDefault();
    event.stopPropagation();
    applyPreset(Number(preset.dataset.avFadePreset) || 0);
  });
})();

/* alcor-video-transforms-ui */
(() => {
  'use strict';

  const root = document.querySelector('[data-alcor-video-editor]');
  if (!root) return;

  root.dataset.alcorVideoTransforms = 'position-scale-rotation-opacity-fit-keyframes';

  const clipInspector = root.querySelector('#av-clip-inspector');
  const inspectorActions = clipInspector?.querySelector('.av-inspector-actions');

  function makeNumberField(name, labelText, min, max, step, value) {
    const label = document.createElement('label');
    label.className = 'av-transform-field';
    label.textContent = labelText;
    const input = document.createElement('input');
    input.name = name;
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    label.append(input);
    return label;
  }

  function makeFitField() {
    const label = document.createElement('label');
    label.className = 'av-transform-field av-transform-fit';
    label.textContent = 'Frame fit';
    const select = document.createElement('select');
    select.name = 'fit';
    for (const [value, text] of [
      ['contain', 'Fit'],
      ['cover', 'Fill'],
      ['stretch', 'Stretch'],
    ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      select.append(option);
    }
    label.append(select);
    return label;
  }

  if (clipInspector && inspectorActions && !clipInspector.elements.namedItem('positionX')) {
    const section = document.createElement('fieldset');
    section.className = 'av-transform-section av-field-wide';
    const legend = document.createElement('legend');
    legend.textContent = 'Transform & motion';
    const grid = document.createElement('div');
    grid.className = 'av-transform-grid';
    grid.append(
      makeNumberField('positionX', 'Position X %', -100, 200, 0.1, 50),
      makeNumberField('positionY', 'Position Y %', -100, 200, 0.1, 50),
      makeNumberField('scale', 'Scale %', 10, 800, 0.1, 100),
      makeNumberField('rotation', 'Rotation °', -180, 180, 0.1, 0),
      makeFitField(),
    );

    const presets = document.createElement('div');
    presets.className = 'av-inspector-actions av-transform-presets';
    presets.setAttribute('aria-label', 'Transform presets');
    for (const [name, text] of [
      ['reset', 'Reset'],
      ['fit', 'Fit frame'],
      ['fill', 'Fill frame'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.avTransformPreset = name;
      button.textContent = text;
      presets.append(button);
    }

    const motion = document.createElement('div');
    motion.className = 'av-inspector-actions av-transform-keyframes';
    motion.setAttribute('aria-label', 'Motion keyframes');
    for (const [action, text] of [
      ['upsert', 'Add / update keyframe'],
      ['remove', 'Remove keyframe'],
      ['clear', 'Clear motion'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.avTransformKeyframe = action;
      button.textContent = text;
      if (action !== 'upsert') button.disabled = true;
      motion.append(button);
    }
    const easeLabel = document.createElement('label');
    easeLabel.className = 'av-transform-field av-transform-ease';
    easeLabel.textContent = 'Easing';
    const ease = document.createElement('select');
    ease.dataset.avTransformEase = '';
    ease.disabled = true;
    for (const [value, text] of [
      ['linear', 'Linear'],
      ['ease-in', 'Ease in'],
      ['ease-out', 'Ease out'],
      ['ease-in-out', 'Ease in and out'],
      ['hold', 'Hold'],
    ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      ease.append(option);
    }
    easeLabel.append(ease);
    motion.append(easeLabel);
    const state = document.createElement('span');
    state.dataset.avTransformKeyframeState = '';
    state.setAttribute('role', 'status');
    state.setAttribute('aria-live', 'polite');
    state.textContent = 'Static transform';
    motion.append(state);

    section.append(legend, grid, presets, motion);
    clipInspector.insertBefore(section, inspectorActions);
  }

  function setField(form, name, value) {
    const field = form.elements.namedItem(name);
    if (!field) return;
    field.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    field.value = String(value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  }

  function setDisplayedTransform(transform) {
    const form = root.querySelector('#av-clip-inspector');
    if (!form || !transform) return;
    for (const name of ['positionX', 'positionY', 'scale', 'rotation', 'opacity']) {
      const field = form.elements.namedItem(name);
      if (field) field.value = String(transform[name]);
    }
    const fit = form.elements.namedItem('fit');
    if (fit) fit.value = String(transform.fit || 'contain');
  }

  function applyPreset(name) {
    const form = root.querySelector('#av-clip-inspector');
    if (!form || form.hidden) return;
    if (name === 'reset') {
      setField(form, 'positionX', 50);
      setField(form, 'positionY', 50);
      setField(form, 'scale', 100);
      setField(form, 'rotation', 0);
      setField(form, 'fit', 'contain');
      return;
    }
    setField(form, 'fit', name === 'fill' ? 'cover' : 'contain');
  }

  root.addEventListener('click', (event) => {
    const preset = event.target.closest('[data-av-transform-preset]');
    if (preset) {
      event.preventDefault();
      event.stopPropagation();
      applyPreset(preset.dataset.avTransformPreset);
      return;
    }

    const keyframe = event.target.closest('[data-av-transform-keyframe]');
    if (!keyframe || keyframe.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    root.dispatchEvent(
      new CustomEvent('alcorvideo:transform-keyframe-command', {
        detail: { action: keyframe.dataset.avTransformKeyframe },
      }),
    );
  });

  root.addEventListener(
    'change',
    (event) => {
      const ease = event.target.closest?.('[data-av-transform-ease]');
      if (!ease) return;
      event.stopPropagation();
      root.dispatchEvent(
        new CustomEvent('alcorvideo:transform-keyframe-command', {
          detail: { action: 'ease', ease: ease.value },
        }),
      );
    },
    true,
  );

  root.addEventListener('alcorvideo:transform-keyframe-state', (event) => {
    const detail = event.detail || {};
    const section = root.querySelector('.av-transform-section');
    const isVisual = detail.kind === 'video' || detail.kind === 'image';
    if (section) section.hidden = Boolean(detail.kind) && !isVisual;
    if (!isVisual) return;

    setDisplayedTransform(detail.transform);
    const count = Number(detail.count) || 0;
    const status = root.querySelector('[data-av-transform-keyframe-state]');
    const remove = root.querySelector('[data-av-transform-keyframe="remove"]');
    const clear = root.querySelector('[data-av-transform-keyframe="clear"]');
    const ease = root.querySelector('[data-av-transform-ease]');
    if (ease) {
      ease.disabled = count === 0;
      if (document.activeElement !== ease) ease.value = detail.ease || 'linear';
    }
    if (remove) remove.disabled = !detail.atKeyframe;
    if (clear) clear.disabled = count === 0;
    if (status) {
      status.textContent = count
        ? `${count} keyframe${count === 1 ? '' : 's'} · ${Number(detail.localTime || 0).toFixed(2)}s${detail.atKeyframe ? ' · on keyframe' : ''}`
        : 'Static transform · add a keyframe at the playhead to animate';
    }
  });
})();

/* alcor-video-transitions-ui */
(() => {
  'use strict';

  const root = document.querySelector('[data-alcor-video-editor]');
  const transitionCore = window.AlcorVideoTransitions;
  if (!root || !transitionCore) return;

  root.dataset.alcorVideoTransitions = 'fade-through-background,cross-dissolve';

  const clipInspector = root.querySelector('#av-clip-inspector');
  const inspectorActions = clipInspector
    ? Array.from(clipInspector.children).find((child) =>
        child.classList?.contains('av-inspector-actions'),
      )
    : null;
  if (
    clipInspector &&
    inspectorActions &&
    !clipInspector.querySelector('[data-av-transition-section]')
  ) {
    const section = document.createElement('fieldset');
    section.className = 'av-transform-section av-field-wide';
    section.dataset.avTransitionSection = '';

    const legend = document.createElement('legend');
    legend.textContent = 'Transition at cut';

    const copy = document.createElement('p');
    copy.className = 'av-transform-keyframe-state';
    copy.textContent =
      'Select the incoming video or image directly after another visual clip. Cross Dissolve uses real source handles around the cut; Fade through background uses clip fades. Each change is one undoable edit.';

    const controls = document.createElement('div');
    controls.className = 'av-inspector-actions';
    controls.setAttribute('aria-label', 'Cut transition controls');

    const durationLabel = document.createElement('label');
    durationLabel.className = 'av-transform-field';
    durationLabel.textContent = 'Duration (s)';
    const duration = document.createElement('input');
    duration.type = 'number';
    duration.min = '0.05';
    duration.max = '2';
    duration.step = '0.05';
    duration.value = '0.5';
    duration.dataset.avTransitionDuration = '';
    durationLabel.append(duration);

    const cross = document.createElement('button');
    cross.type = 'button';
    cross.dataset.avTransitionAction = 'cross-dissolve';
    cross.textContent = 'Cross Dissolve';

    const clearCross = document.createElement('button');
    clearCross.type = 'button';
    clearCross.dataset.avTransitionAction = 'clear-cross-dissolve';
    clearCross.textContent = 'Clear Cross Dissolve';

    const fade = document.createElement('button');
    fade.type = 'button';
    fade.dataset.avTransitionAction = 'fade-through-background';
    fade.textContent = 'Fade through background';

    const clearFade = document.createElement('button');
    clearFade.type = 'button';
    clearFade.dataset.avTransitionAction = 'clear-fade-through-background';
    clearFade.textContent = 'Clear cut fades';

    const status = document.createElement('span');
    status.dataset.avTransitionStatus = '';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = 'No cut transition changed yet.';

    controls.append(durationLabel, cross, clearCross, fade, clearFade, status);
    section.append(legend, copy, controls);
    clipInspector.insertBefore(section, inspectorActions);
  }

  let timelineRenderQueued = false;
  let pendingInspectorSync = false;

  function projectSnapshot() {
    const detail = {};
    root.dispatchEvent(new CustomEvent('alcorvideo:request-project', { detail }));
    return detail.project && typeof detail.project === 'object' ? detail.project : null;
  }

  function clipElementMap() {
    return new Map(
      Array.from(root.querySelectorAll('.av-timeline-clip[data-clip-id]')).map((item) => [
        String(item.dataset.clipId || ''),
        item,
      ]),
    );
  }

  function rememberAccessibleBase(item) {
    if (!Object.prototype.hasOwnProperty.call(item.dataset, 'transitionBaseAria')) {
      item.dataset.transitionBaseAria = item.getAttribute('aria-label') || '';
    }
    if (!Object.prototype.hasOwnProperty.call(item.dataset, 'transitionBaseTitle')) {
      item.dataset.transitionBaseTitle = item.getAttribute('title') || '';
    }
  }

  function clearTimelineDecoration(item) {
    item.classList.remove(
      'has-cross-dissolve',
      'is-cross-dissolve-outgoing',
      'is-cross-dissolve-incoming',
    );
    delete item.dataset.crossDissolve;
    item
      .querySelectorAll('.av-cross-dissolve-handle, .av-cross-dissolve-label')
      .forEach((node) => node.remove());
    if (Object.prototype.hasOwnProperty.call(item.dataset, 'transitionBaseAria')) {
      const baseAria = item.dataset.transitionBaseAria;
      if (baseAria) item.setAttribute('aria-label', baseAria);
      else item.removeAttribute('aria-label');
    }
    if (Object.prototype.hasOwnProperty.call(item.dataset, 'transitionBaseTitle')) {
      const baseTitle = item.dataset.transitionBaseTitle;
      if (baseTitle) item.setAttribute('title', baseTitle);
      else item.removeAttribute('title');
    }
  }

  function addHandle(item, role, widthPx) {
    const handle = document.createElement('span');
    handle.className = 'av-cross-dissolve-handle';
    handle.dataset.role = role;
    handle.setAttribute('aria-hidden', 'true');
    handle.style.width = `${Math.max(4, Math.round(widthPx))}px`;
    item.append(handle);
  }

  function decorateTimeline(forceInspectorSync = false) {
    timelineRenderQueued = false;
    const project = projectSnapshot();
    if (!project || !Array.isArray(project.clips)) return;
    // Nothing to draw and nothing drawn: skip the per-clip pass (it measures every decorated clip).
    if (
      !project.clips.some((clip) => clip && clip.crossDissolve) &&
      !root.querySelector('.has-cross-dissolve')
    )
      return;

    const items = clipElementMap();
    for (const item of items.values()) {
      rememberAccessibleBase(item);
      clearTimelineDecoration(item);
    }

    const clips = new Map(project.clips.map((clip) => [String(clip.id || ''), clip]));
    for (const incoming of project.clips) {
      const transition = transitionCore.resolveCrossDissolveForClip(
        incoming,
        project.clips,
        project.assets,
      );
      if (!transition || transition.role !== 'incoming') continue;

      const outgoing = clips.get(String(transition.outgoingId || ''));
      const incomingItem = items.get(String(incoming.id || ''));
      const outgoingItem = outgoing ? items.get(String(outgoing.id || '')) : null;
      if (!incomingItem || !outgoingItem) continue;

      const halfDuration = Math.max(0, Number(transition.duration) || 0) / 2;
      const incomingWidth = incomingItem.getBoundingClientRect().width || 0;
      const outgoingWidth = outgoingItem.getBoundingClientRect().width || 0;
      const incomingHandleWidth =
        incomingWidth *
        Math.min(1, halfDuration / Math.max(0.000001, Number(incoming.duration) || 0));
      const outgoingHandleWidth =
        outgoingWidth *
        Math.min(1, halfDuration / Math.max(0.000001, Number(outgoing.duration) || 0));
      const seconds = Number(transition.duration).toFixed(2);

      incomingItem.classList.add('has-cross-dissolve', 'is-cross-dissolve-incoming');
      outgoingItem.classList.add('has-cross-dissolve', 'is-cross-dissolve-outgoing');
      incomingItem.dataset.crossDissolve = seconds;
      outgoingItem.dataset.crossDissolve = seconds;
      addHandle(outgoingItem, 'outgoing', outgoingHandleWidth);
      addHandle(incomingItem, 'incoming', incomingHandleWidth);

      const body = incomingItem.querySelector('.av-clip-body');
      if (body) {
        const label = document.createElement('span');
        label.className = 'av-cross-dissolve-label';
        label.setAttribute('aria-hidden', 'true');
        label.textContent = `Dissolve · ${seconds}s`;
        body.append(label);
      }

      const baseAria = incomingItem.dataset.transitionBaseAria || incoming.name || 'Incoming clip';
      const baseTitle =
        incomingItem.dataset.transitionBaseTitle || incoming.name || 'Incoming clip';
      incomingItem.setAttribute('aria-label', `${baseAria}, Cross Dissolve ${seconds} seconds`);
      incomingItem.title = `${baseTitle}\nCross Dissolve · ${seconds}s`;

      if (incomingItem.classList.contains('is-selected')) {
        const durationInput = root.querySelector('[data-av-transition-duration]');
        if (durationInput && (forceInspectorSync || document.activeElement !== durationInput)) {
          durationInput.value = String(Number(transition.duration));
        }
        const status = root.querySelector('[data-av-transition-status]');
        if (status) status.textContent = `Applied Cross Dissolve · ${seconds}s at this cut.`;
      }
    }
  }

  function scheduleTimelineDecoration(forceInspectorSync = false) {
    if (forceInspectorSync) pendingInspectorSync = true;
    if (timelineRenderQueued) return;
    timelineRenderQueued = true;
    window.requestAnimationFrame(() => {
      const force = pendingInspectorSync;
      pendingInspectorSync = false;
      decorateTimeline(force);
    });
  }

  const timeline = root.querySelector('#av-timeline');
  if (timeline) {
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches?.('.av-timeline-clip') || node.querySelector?.('.av-timeline-clip')) {
            scheduleTimelineDecoration();
            return;
          }
        }
      }
    });
    observer.observe(timeline, { childList: true, subtree: true });
  }

  // A pointerdown on a timeline clip is the canonical selection gesture: the editor's own
  // pointerdown handler immediately selects the clip and rebuilds the timeline before the later
  // click can target that same DOM node. Capture pointerdown first, then derive transition UI on
  // the next frame after the canonical rebuild. Keyboard selection keeps the same post-rebuild
  // synchronization. Background mutations never force the input while the user is typing.
  root.addEventListener(
    'pointerdown',
    (event) => {
      if (event.target.closest?.('.av-timeline-clip[data-clip-id]'))
        scheduleTimelineDecoration(true);
    },
    true,
  );
  root.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.target.closest?.('.av-timeline-clip[data-clip-id]'))
        scheduleTimelineDecoration(true);
    },
    true,
  );

  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-av-transition-action]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const duration = Number(root.querySelector('[data-av-transition-duration]')?.value || 0.5);
    root.dispatchEvent(
      new CustomEvent('alcorvideo:transition-command', {
        detail: { action: String(button.dataset.avTransitionAction || ''), duration },
      }),
    );
  });

  root.addEventListener('alcorvideo:transition-result', (event) => {
    const status = root.querySelector('[data-av-transition-status]');
    if (status)
      status.textContent = String(
        event.detail?.message ||
          (event.detail?.ok ? 'Transition updated.' : 'Transition was not changed.'),
      );
    scheduleTimelineDecoration();
  });

  scheduleTimelineDecoration();
})();

/* alcor-video-audio-automation-ui */
(() => {
  'use strict';

  const root = document.querySelector('[data-alcor-video-editor]');
  if (!root) return;

  root.dataset.alcorVideoAudioAutomation = 'linear-gain-keyframes';

  const clipInspector = root.querySelector('#av-clip-inspector');
  const inspectorActions = clipInspector
    ? Array.from(clipInspector.children).find((child) =>
        child.classList?.contains('av-inspector-actions'),
      ) || null
    : null;

  if (clipInspector && !clipInspector.querySelector('.av-audio-automation-section')) {
    const section = document.createElement('fieldset');
    section.className = 'av-transform-section av-audio-automation-section av-field-wide';
    const legend = document.createElement('legend');
    legend.textContent = 'Audio gain automation';
    const hint = document.createElement('p');
    hint.className = 'av-transform-help';
    hint.textContent = 'Animate the existing Volume control with linear clip-local keyframes.';

    const actions = document.createElement('div');
    actions.className = 'av-inspector-actions av-audio-keyframes';
    actions.setAttribute('aria-label', 'Audio gain keyframes');
    for (const [action, text] of [
      ['upsert', 'Add / update gain keyframe'],
      ['remove', 'Remove gain keyframe'],
      ['clear', 'Clear gain automation'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.avAudioKeyframe = action;
      button.textContent = text;
      if (action !== 'upsert') button.disabled = true;
      actions.append(button);
    }

    const state = document.createElement('span');
    state.dataset.avAudioKeyframeState = '';
    state.setAttribute('role', 'status');
    state.setAttribute('aria-live', 'polite');
    state.textContent = 'Static gain';
    actions.append(state);

    section.append(legend, hint, actions);
    if (inspectorActions && inspectorActions.parentElement === clipInspector)
      clipInspector.insertBefore(section, inspectorActions);
    else clipInspector.append(section);
  }

  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-av-audio-keyframe]');
    if (!button || button.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    root.dispatchEvent(
      new CustomEvent('alcorvideo:volume-keyframe-command', {
        detail: { action: button.dataset.avAudioKeyframe },
      }),
    );
  });

  root.addEventListener('alcorvideo:volume-keyframe-state', (event) => {
    const detail = event.detail || {};
    const section = root.querySelector('.av-audio-automation-section');
    const supportsAudio = detail.kind === 'audio' || detail.kind === 'video';
    if (section) section.hidden = Boolean(detail.kind) && !supportsAudio;
    if (!supportsAudio) return;

    const volume = clipInspector?.elements.namedItem('volume');
    if (volume && Number.isFinite(Number(detail.volume))) volume.value = String(detail.volume);

    const count = Number(detail.count) || 0;
    const remove = root.querySelector('[data-av-audio-keyframe="remove"]');
    const clear = root.querySelector('[data-av-audio-keyframe="clear"]');
    const status = root.querySelector('[data-av-audio-keyframe-state]');
    if (remove) remove.disabled = !detail.atKeyframe;
    if (clear) clear.disabled = count === 0;
    if (status) {
      status.textContent = count
        ? `${count} gain keyframe${count === 1 ? '' : 's'} · ${Number(detail.localTime || 0).toFixed(2)}s${detail.atKeyframe ? ' · on keyframe' : ''}`
        : 'Static gain · add a keyframe at the playhead to automate volume';
    }
  });
})();

/* alcor-video-color-ui */
(() => {
  'use strict';

  const root = document.querySelector('[data-alcor-video-editor]');
  if (!root) return;

  root.dataset.alcorVideoColor = 'exposure-white-balance-tone-saturation';
  const form = root.querySelector('#av-clip-inspector');
  const actionsAnchor = form?.querySelector('.av-inspector-actions');
  if (!form || !actionsAnchor) return;

  const fields = [
    ['exposure', 'Exposure EV', -5, 5, 0, '0.1'],
    ['temperature', 'Temperature', -100, 100, 0, '1'],
    ['tint', 'Tint', -100, 100, 0, '1'],
    ['brightness', 'Brightness', -100, 100, 0, '1'],
    ['contrast', 'Contrast', -100, 100, 0, '1'],
    ['highlights', 'Highlights', -100, 100, 0, '1'],
    ['shadows', 'Shadows', -100, 100, 0, '1'],
    ['whites', 'Whites', -100, 100, 0, '1'],
    ['blacks', 'Blacks', -100, 100, 0, '1'],
    ['saturation', 'Saturation %', 0, 200, 100, '1'],
  ];

  function field(name, labelText, min, max, value, step) {
    const label = document.createElement('label');
    label.className = 'av-color-field';
    const text = document.createElement('span');
    text.textContent = labelText;
    const input = document.createElement('input');
    input.name = name;
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    label.append(text, input);
    return label;
  }

  if (!form.querySelector('[name="brightness"]')) {
    const section = document.createElement('fieldset');
    section.className = 'av-color-section av-field-wide';
    section.dataset.avColorSection = '';
    section.hidden = true;
    const legend = document.createElement('legend');
    legend.textContent = 'Basic color';
    const grid = document.createElement('div');
    grid.className = 'av-color-grid';
    for (const definition of fields) grid.append(field(...definition));
    const actions = document.createElement('div');
    actions.className = 'av-inspector-actions av-color-actions';
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.dataset.avColorReset = '';
    reset.textContent = 'Reset color';
    const status = document.createElement('span');
    status.dataset.avColorStatus = '';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = 'Neutral';
    actions.append(reset, status);
    section.append(legend, grid, actions);
    actionsAnchor.before(section);
  }

  const neutral = Object.fromEntries(fields.map(([name, , , , value]) => [name, value]));
  let latestColor = { ...neutral };
  let compatibility = {
    mode: '',
    blocked: false,
    frameBudgetMs: 50,
    slowFrameLimit: 3,
    cacheHit: false,
  };

  function signed(value) {
    const n = Number(value) || 0;
    return n > 0 ? `+${n}` : String(n);
  }

  function colorSummary() {
    const parts = [];
    for (const [name, label, , , neutralValue] of fields) {
      const raw = Number(latestColor[name]);
      const value = Number.isFinite(raw) ? raw : neutralValue;
      if (value === neutralValue) continue;
      if (name === 'exposure') parts.push(`${label.replace(' EV', '')} ${signed(value)} EV`);
      else if (name === 'saturation') parts.push(`Saturation ${value}%`);
      else parts.push(`${label} ${signed(value)}`);
    }
    return parts.length ? parts.join(' · ') : 'Neutral';
  }

  function renderStatus() {
    const status = root.querySelector('[data-av-color-status]');
    if (!status) return;
    const base = colorSummary();
    if (compatibility.blocked) {
      const budget = Math.max(1, Number(compatibility.frameBudgetMs) || 50);
      const limit = Math.max(1, Number(compatibility.slowFrameLimit) || 3);
      status.textContent = `Color paused · software correction exceeded ${budget} ms for ${limit} consecutive frames. Reset color or try another browser.`;
      status.dataset.state = 'blocked';
      return;
    }
    delete status.dataset.state;
    if (compatibility.mode === 'software-cache') {
      status.textContent = `${base} · Software compatibility${compatibility.cacheHit ? ' · cached still' : ''}`;
      return;
    }
    if (compatibility.mode === 'software') {
      status.textContent = `${base} · Software compatibility`;
      return;
    }
    status.textContent = base;
  }

  root.addEventListener('alcorvideo:color-state', (event) => {
    const detail = event.detail || {};
    const section = root.querySelector('[data-av-color-section]');
    const visual = detail.kind === 'video' || detail.kind === 'image';
    if (section) section.hidden = !visual;
    if (!visual) return;
    latestColor = detail.color || latestColor;
    for (const [name] of fields) {
      const input = form.querySelector(`[name="${name}"]`);
      if (input && Number.isFinite(Number(latestColor[name])))
        input.value = String(latestColor[name]);
    }
    renderStatus();
  });

  root.addEventListener('alcorvideo:color-compatibility', (event) => {
    const detail = event.detail || {};
    compatibility = {
      mode: String(detail.mode || ''),
      blocked: detail.blocked === true,
      frameBudgetMs: Math.max(1, Number(detail.frameBudgetMs) || 50),
      slowFrameLimit: Math.max(1, Number(detail.slowFrameLimit) || 3),
      cacheHit: detail.cacheHit === true,
    };
    root.dataset.alcorVideoColorCompatibility = compatibility.blocked
      ? 'blocked'
      : compatibility.mode || 'unknown';
    renderStatus();
  });

  root.addEventListener('click', (event) => {
    const reset = event.target.closest('[data-av-color-reset]');
    if (!reset) return;
    event.preventDefault();
    event.stopPropagation();
    root.dispatchEvent(new CustomEvent('alcorvideo:color-reset'));
  });
})();
/* alcor-video */
(() => {
  'use strict';

  const root = document.querySelector('[data-alcor-video-editor]');
  if (!root) return;

  const config = window.AlcorVideoConfig || {};
  const PROJECT_SCHEMA = 'alcorvideo.project';
  // schemaVersion stays 1 (the container contract); revision counts additive feature levels.
  const PROJECT_REVISION = 3;
  const TRACKS = ['V2', 'V1', 'A1'];
  const MIN_CLIP_DURATION = 0.04;
  const timelineCore = window.AlcorVideoCore;
  if (!timelineCore) {
    console.error('AlcorVideo timeline core unavailable');
    return;
  }
  const transformCore = window.AlcorVideoTransforms;
  if (!transformCore) {
    console.error('AlcorVideo transform core unavailable');
    return;
  }
  const transitionCore = window.AlcorVideoTransitions;
  if (!transitionCore) {
    console.error('AlcorVideo transition core unavailable');
    return;
  }
  const audioAutomationCore = window.AlcorVideoAudioAutomation;
  if (!audioAutomationCore) {
    console.error('AlcorVideo audio automation core unavailable');
    return;
  }
  const colorCore = window.AlcorVideoColor;
  if (!colorCore) {
    console.error('AlcorVideo color core unavailable');
    return;
  }
  const Edit = window.AlcorVideoEdit;
  if (!Edit) {
    console.error('AlcorVideo edit core unavailable');
    return;
  }
  const editorCore = window.AlcorVideoCore;
  if (!editorCore) {
    console.error('AlcorVideo core unavailable');
    return;
  }
  const mediaCore = window.AlcorVideoMedia || null;
  const gradeCore = window.AlcorVideoGrade || null;
  // Clip effect data (stack, blend, anchor, keyframes, time remap, audio effects).
  // The pixel renderer, audio effect graph and their panels load with the 'effects' group.
  const effectsCore = window.AlcorVideoEffects || null;
  // The MP4 writer loads with the export group on first use.
  const mp4 = () => window.AlcorVideoMp4 || null;

  // Load a lazy group of editor scripts (export encoder, curves/LUT/scopes panel,
  // waveforms, sample project) once, from the URL the page was given.
  const lazyGroups = new Map();
  function loadGroup(name) {
    if (lazyGroups.has(name)) return lazyGroups.get(name);
    const url = config.lazy && config.lazy[name];
    const promise = !url
      ? Promise.resolve(false)
      : new Promise((resolve) => {
          const script = document.createElement('script');
          script.src = url;
          script.async = true;
          script.onload = () => resolve(true);
          script.onerror = () => {
            lazyGroups.delete(name);
            resolve(false);
          };
          (document.head || document.body).append(script);
        });
    lazyGroups.set(name, promise);
    return promise;
  }
  const LIMITS = editorCore.LIMITS;
  const $ = (selector, context = root) => context.querySelector(selector);
  const $$ = (selector, context = root) => Array.from(context.querySelectorAll(selector));

  // NTSC rates are stored as their usual labels and run at the exact 1000/1001 rate.
  const FPS_OPTIONS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
  const NTSC_RATES = Object.freeze({
    23.976: 24000 / 1001,
    29.97: 30000 / 1001,
    59.94: 60000 / 1001,
  });
  const SEQUENCE_PRESETS = Object.freeze([
    { id: '1280x720', label: 'HD 720p · 1280×720', width: 1280, height: 720 },
    { id: '1920x1080', label: 'Full HD · 1920×1080', width: 1920, height: 1080 },
    { id: '3840x2160', label: '4K UHD · 3840×2160', width: 3840, height: 2160 },
    { id: '1080x1920', label: 'Vertical 9:16 · 1080×1920', width: 1080, height: 1920 },
    { id: '1080x1080', label: 'Square 1:1 · 1080×1080', width: 1080, height: 1080 },
    { id: '1080x1350', label: 'Portrait 4:5 · 1080×1350', width: 1080, height: 1350 },
  ]);
  const TITLE_FONTS = Object.freeze({
    sans: 'Inter, system-ui, "Segoe UI", Roboto, sans-serif',
    arial: 'Arial, Helvetica, sans-serif',
    heavy: '"Arial Black", Impact, sans-serif',
    trebuchet: '"Trebuchet MS", Arial, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    times: '"Times New Roman", Times, serif',
    palatino: '"Palatino Linotype", Palatino, Georgia, serif',
    mono: '"SFMono-Regular", Consolas, "Courier New", monospace',
    courier: '"Courier New", Courier, monospace',
    display: 'Impact, "Arial Black", system-ui, sans-serif',
    rounded: '"Trebuchet MS", "Segoe UI", system-ui, sans-serif',
    script: '"Brush Script MT", cursive',
    cursive: 'cursive',
  });
  const TITLE_PRESETS = Object.freeze({
    title: {
      name: 'Title',
      text: 'Your title',
      size: 72,
      x: 50,
      y: 50,
      align: 'center',
      font: 'sans',
      bold: true,
      italic: false,
      color: '#ffffff',
      background: '#000000',
      backgroundOpacity: 0,
      stroke: '#000000',
      strokeWidth: 0,
      shadow: true,
    },
    'lower-third': {
      name: 'Lower third',
      text: 'Name Surname\nTitle or place',
      size: 44,
      x: 7,
      y: 80,
      align: 'left',
      font: 'sans',
      bold: true,
      italic: false,
      color: '#ffffff',
      background: '#0b1220',
      backgroundOpacity: 0.78,
      stroke: '#000000',
      strokeWidth: 0,
      shadow: false,
    },
    subtitle: {
      name: 'Subtitle',
      text: 'Subtitle text',
      size: 40,
      x: 50,
      y: 88,
      align: 'center',
      font: 'sans',
      bold: false,
      italic: false,
      color: '#ffffff',
      background: '#000000',
      backgroundOpacity: 0.55,
      stroke: '#000000',
      strokeWidth: 0,
      shadow: false,
    },
    'end-card': {
      name: 'End card',
      text: 'Thanks for watching',
      size: 84,
      x: 50,
      y: 45,
      align: 'center',
      font: 'display',
      bold: true,
      italic: false,
      color: '#ffffff',
      background: '#000000',
      backgroundOpacity: 0,
      stroke: '#101010',
      strokeWidth: 4,
      shadow: true,
    },
    caption: {
      name: 'Caption',
      text: 'Your title',
      size: 64,
      x: 50,
      y: 82,
      align: 'center',
      font: 'sans',
      bold: true,
      italic: false,
      color: '#ffffff',
      background: '#000000',
      backgroundOpacity: 0.5,
      stroke: '#000000',
      strokeWidth: 0,
      shadow: true,
    },
  });
  const VISUAL_TRANSITIONS = Object.freeze([
    ['cross-dissolve', 'Cross Dissolve'],
    ['dip-to-black', 'Dip to Black'],
    ['dip-to-white', 'Dip to White'],
    ['wipe-left', 'Wipe Left'],
    ['wipe-right', 'Wipe Right'],
    ['wipe-up', 'Wipe Up'],
    ['wipe-down', 'Wipe Down'],
  ]);
  const AUDIO_TRANSITIONS = Object.freeze([
    ['constant-power', 'Constant Power'],
    ['constant-gain', 'Constant Gain'],
  ]);
  const TOOLS = Object.freeze({
    select: 'V',
    razor: 'C',
    ripple: 'B',
    roll: 'N',
    slip: 'Y',
    slide: 'U',
  });
  const TOOL_LABELS = Object.freeze({
    select: 'Selection',
    razor: 'Razor',
    ripple: 'Ripple Edit',
    roll: 'Rolling Edit',
    slip: 'Slip',
    slide: 'Slide',
  });
  const SHUTTLE_RATES = [1, 2, 4, 8];

  const elements = {
    projectName: $('#av-project-name'),
    saveState: $('#av-save-state'),
    mediaInput: $('#av-media-input'),
    mediaBin: $('#av-media-bin'),
    projectFile: $('#av-project-file'),
    canvas: $('#av-preview'),
    monitorMessage: $('#av-monitor-message'),
    shortcuts: $('#av-shortcuts'),
    monitorWrap: $('.av-monitor-wrap'),
    timecode: $('#av-timecode'),
    timeInput: $('#av-time-input'),
    fps: $('#av-fps'),
    clipInspector: $('#av-clip-inspector'),
    titleInspector: $('#av-title-inspector'),
    inspectorEmpty: $('#av-inspector-empty'),
    deleteButton: $('[data-action="delete-selection"]'),
    timeline: $('#av-timeline'),
    timelineScroll: $('#av-timeline-scroll'),
    ruler: $('#av-ruler'),
    tracks: $('#av-tracks'),
    playhead: $('#av-playhead'),
    zoom: $('#av-zoom'),
    snap: $('#av-snap'),
    linked: $('#av-linked'),
    projectStats: $('#av-project-stats'),
    status: $('#av-status'),
    renderDialog: $('#av-render-dialog'),
    renderMessage: $('#av-render-message'),
    renderProgress: $('#av-render-progress'),
    exportForm: $('#av-export-form'),
    exportSupport: $('#av-export-support'),
    historyList: $('#av-history-list'),
    markerList: $('#av-marker-list'),
    mixer: $('#av-mixer'),
    sequencePreset: $('#av-sequence-preset'),
    previewQuality: $('#av-preview-quality'),
    safeToggle: $('#av-safe-margins'),
    loopToggle: $('#av-loop'),
    meterL: $('#av-meter-l'),
    meterR: $('#av-meter-r'),
    sourceVideo: $('#av-source-video'),
    sourceInfo: $('#av-source-info'),
    recoveryToggle: $('#av-recovery-toggle'),
    safeGuides: $('.av-safe-guides'),
    scopes: $('#av-scopes'),
  };

  const ctx = elements.canvas.getContext('2d', { alpha: false });
  for (const label of $$('.av-file-button, .av-import-button')) {
    label.tabIndex = 0;
    label.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      label.querySelector('input[type="file"]')?.click();
    });
  }

  const state = {
    project: createProject(),
    runtimeAssets: new Map(),
    clipElements: new Map(),
    thumbnails: new Map(),
    selectedId: null,
    selection: new Set(),
    currentTime: 0,
    playing: false,
    playRate: 1,
    playbackStartedAt: 0,
    playbackStartedFrom: 0,
    raf: 0,
    pxPerSecond: Number(elements.zoom?.value) || 72,
    snap: true,
    linkedSelection: true,
    tool: 'select',
    history: Edit.createHistory({
      maxBytes:
        LIMITS.maxHistoryBytes > 0
          ? Math.max(LIMITS.maxHistoryBytes, Edit.LIMITS.maxHistoryBytes)
          : Edit.LIMITS.maxHistoryBytes,
    }),
    dirty: false,
    drag: null,
    rendering: false,
    cancelRender: false,
    projectIO: false,
    importing: false,
    pendingRenderUrl: '',
    returnFocus: null,
    clipboard: null,
    previewScale: 1,
    safeMargins: false,
    loop: false,
    monitor: 'program',
    source: null,
    audio: null,
    renderQueued: false,
    exportSupport: null,
    recovery: { enabled: false, timer: 0, busy: false },
    gap: null,
  };

  function setRenderDialogOpen(open) {
    for (const child of root.children) {
      if (child === elements.renderDialog) continue;
      if (open) {
        child.setAttribute('inert', '');
        child.setAttribute('aria-hidden', 'true');
      } else {
        child.removeAttribute('inert');
        child.removeAttribute('aria-hidden');
      }
    }
    elements.renderDialog.hidden = !open;
    root.classList?.toggle?.('is-exporting', Boolean(open));
  }

  elements.renderDialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (state.rendering) cancelRender();
      else closeExportDialog();
      return;
    }
    if (event.key === 'Tab' && state.rendering) {
      event.preventDefault();
      elements.renderDialog.querySelector('[data-action="cancel-render"]')?.focus();
    }
  });

  function createProject() {
    return {
      schema: PROJECT_SCHEMA,
      schemaVersion: 1,
      revision: PROJECT_REVISION,
      appVersion: String(config.version || root.dataset.version || '0.1.0'),
      name: 'Untitled project',
      width: 1280,
      height: 720,
      fps: 30,
      background: '#090b10',
      tracks: Edit.normalizeTracks(undefined, []),
      markers: [],
      luts: [],
      inPoint: null,
      outPoint: null,
      assets: [],
      clips: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  function uid(prefix = 'item') {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return `${prefix}-${window.crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function clamp(value, min, max) {
    return editorCore.clamp(value, min, max);
  }

  function round(value, precision = 3) {
    return editorCore.round(value, precision);
  }

  function safeFileName(name, fallback = 'alcorvideo-project') {
    const clean = String(name || fallback)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return clean || fallback;
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
    return `${(value / 1024 ** 3).toFixed(1)} GB`;
  }

  function fps() {
    const value = Number(state.project.fps) || 30;
    return NTSC_RATES[value] || value;
  }

  // Timecode counts whole frames per second (non-drop-frame for NTSC rates).
  function nominalFps() {
    return Math.round(fps());
  }

  // Times are stored to the millisecond; a small tolerance keeps frame math stable.
  function frameOf(seconds) {
    return Math.floor(Math.max(0, Number(seconds) || 0) * fps() + 0.05);
  }

  function snapToFrame(seconds) {
    return round(Math.round(Math.max(0, Number(seconds) || 0) * fps()) / fps());
  }

  function formatClock(seconds, includeFrames = false) {
    const rate = nominalFps();
    const value = Math.max(0, Number(seconds) || 0);
    if (!includeFrames) {
      const whole = Math.floor(value);
      const hours = Math.floor(whole / 3600);
      const minutes = Math.floor((whole % 3600) / 60);
      const secs = whole % 60;
      const base = [hours, minutes, secs].map((part) => String(part).padStart(2, '0')).join(':');
      return hours ? base : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    const totalFrames = frameOf(value);
    const frame = totalFrames % rate;
    const whole = Math.floor(totalFrames / rate);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const secs = whole % 60;
    return `${[hours, minutes, secs].map((part) => String(part).padStart(2, '0')).join(':')}:${String(frame).padStart(2, '0')}`;
  }

  // Accepts seconds ("12.5") or timecode ("00:00:12:15", "12:15" = seconds:frames).
  function parseTimeInput(text) {
    const value = String(text || '').trim();
    if (!value) return null;
    if (/^\d+(\.\d+)?$/.test(value)) return Number(value);
    const parts = value.split(/[:;]/).map((part) => Number(part));
    if (parts.some((part) => !Number.isFinite(part) || part < 0)) return null;
    let hours = 0;
    let minutes = 0;
    let secs = 0;
    let frames = 0;
    if (parts.length === 4) [hours, minutes, secs, frames] = parts;
    else if (parts.length === 3) [minutes, secs, frames] = parts;
    else if (parts.length === 2) [secs, frames] = parts;
    else return null;
    return ((hours * 3600 + minutes * 60 + secs) * nominalFps() + frames) / fps();
  }

  function projectDuration() {
    return Edit.sequenceDuration(state.project);
  }

  function timelineDuration() {
    return Math.max(30, Math.ceil(projectDuration() + 5));
  }

  function getClip(id = state.selectedId) {
    return state.project.clips.find((clip) => clip.id === id) || null;
  }

  function getAsset(id) {
    return state.project.assets.find((asset) => asset.id === id) || null;
  }

  function getTrack(id) {
    return Edit.getTrack(state.project, id);
  }

  function isVisualClip(clip) {
    return clip && (clip.kind === 'video' || clip.kind === 'image' || clip.kind === 'title');
  }

  function isMediaClip(clip) {
    return clip && clip.kind !== 'title';
  }

  function firstTrack(kind) {
    return state.project.tracks.find((track) => track.kind === kind) || null;
  }

  function defaultTrackFor(kind) {
    if (kind === 'audio') return firstTrack('audio')?.id || 'A1';
    if (kind === 'title') return getTrack('V2') ? 'V2' : firstTrack('video')?.id || 'V1';
    return getTrack('V1') ? 'V1' : firstTrack('video')?.id || 'V1';
  }

  function selectedClips() {
    return state.project.clips.filter((clip) => state.selection.has(clip.id));
  }

  // ------------------------------------------------------------------ history

  function snapshot() {
    return JSON.stringify({
      project: state.project,
      selectedId: state.selectedId,
      selection: [...state.selection],
      currentTime: state.currentTime,
    });
  }

  function pushHistory(serialized = snapshot(), label = 'Edit') {
    state.history.push(label, serialized);
    updateHistoryButtons();
  }

  function restoreSnapshot(serialized, options = {}) {
    const parsed = JSON.parse(serialized);
    state.project = normalizeProject(parsed.project, { restoring: true });
    const ids = new Set(state.project.clips.map((clip) => clip.id));
    state.selection = new Set((parsed.selection || []).filter((id) => ids.has(id)));
    state.selectedId = parsed.selectedId && ids.has(parsed.selectedId) ? parsed.selectedId : null;
    if (state.selectedId) state.selection.add(state.selectedId);
    state.currentTime = clamp(parsed.currentTime, 0, Math.max(projectDuration(), 0));
    if (elements.projectName) elements.projectName.value = state.project.name;
    if (elements.fps) elements.fps.value = String(state.project.fps);
    pruneClipElements();
    if (!options.quiet) markDirty('Changed');
    renderAll();
  }

  // Commit an unfinished live panel edit as its own step (no stale "before").
  // Effects, Color and Mixer panels all keep a pending live "before".
  function settleLive() {
    for (const [key, label] of [
      ['effectsBefore', 'Effect'],
      ['gradeBefore', 'Color changed'],
      ['mixerBefore', 'Mixer changed'],
    ]) {
      const before = state[key];
      state[key] = null;
      if (before && JSON.stringify(JSON.parse(before).project) !== JSON.stringify(state.project)) {
        pushHistory(before, label);
        markDirty(label);
      }
    }
  }

  function mutate(label, fn) {
    settleLive();
    const before = snapshot();
    const result = fn();
    if (result === false) {
      // A command that bails out part-way must not leave half its edits behind.
      if (snapshot() !== before) restoreSnapshot(before, { quiet: true });
      return false;
    }
    const after = snapshot();
    if (before === after) return false;
    pushHistory(before, label || 'Changed');
    markDirty(label || 'Changed');
    renderAll();
    return true;
  }

  function undo() {
    settleLive();
    if (!state.history.canUndo() || state.rendering) return;
    pause(false);
    const entry = state.history.undo(snapshot());
    if (!entry) return;
    restoreSnapshot(entry.snapshot);
    setStatus(`Undo ${entry.label}`);
    updateHistoryButtons();
  }

  function redo() {
    settleLive();
    if (!state.history.canRedo() || state.rendering) return;
    pause(false);
    const entry = state.history.redo(snapshot());
    if (!entry) return;
    restoreSnapshot(entry.snapshot);
    setStatus(`Redo ${entry.label}`);
    updateHistoryButtons();
  }

  function updateHistoryButtons() {
    $$('[data-action="undo"]').forEach((button) => {
      button.disabled = !state.history.canUndo() || state.rendering;
    });
    $$('[data-action="redo"]').forEach((button) => {
      button.disabled = !state.history.canRedo() || state.rendering;
    });
    renderHistoryPanel();
  }

  function renderHistoryPanel() {
    const list = elements.historyList;
    if (!list) return;
    const { past, future } = state.history.labels();
    list.replaceChildren();
    const make = (label, offset, current = false) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.dataset.historyOffset = String(offset);
      if (current) button.setAttribute('aria-current', 'step');
      if (offset > 0) button.classList.add('is-future');
      item.append(button);
      return item;
    };
    list.append(make('Open / new project', -past.length, past.length === 0));
    past.forEach((label, index) =>
      list.append(make(label, index + 1 - past.length, index === past.length - 1)),
    );
    future.forEach((label, index) => list.append(make(label, index + 1)));
  }

  function jumpHistory(offset) {
    const steps = Math.trunc(Number(offset) || 0);
    if (!steps || state.rendering) return;
    for (let index = 0; index < Math.abs(steps); index += 1) (steps < 0 ? undo : redo)();
  }

  function markDirty(message = 'Unsaved changes') {
    state.dirty = true;
    state.project.updatedAt = new Date().toISOString();
    if (elements.saveState) elements.saveState.textContent = message;
    scheduleRecovery();
  }

  function setStatus(message) {
    if (elements.status) elements.status.textContent = message;
  }

  // ------------------------------------------------------------ project data

  const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,99}$/i;

  function serializeProject(pretty = false) {
    const clean = JSON.parse(JSON.stringify(state.project));
    clean.assets = clean.assets.map((asset) => {
      const out = {
        id: asset.id,
        name: asset.name,
        type: asset.type,
        kind: asset.kind,
        size: asset.size,
        duration: asset.duration,
        width: asset.width,
        height: asset.height,
      };
      if (typeof asset.hasAudio === 'boolean') out.hasAudio = asset.hasAudio;
      if (asset.fps) out.fps = asset.fps;
      if (asset.channels) out.channels = asset.channels;
      return out;
    });
    clean.clips = clean.clips.map((clip) => {
      const normalized = { ...clip };
      delete normalized.src;
      return normalized;
    });
    clean.updatedAt = new Date().toISOString();
    return JSON.stringify(clean, null, pretty ? 2 : 0);
  }

  // Caption export reads a detached snapshot without saving private metadata.
  root.addEventListener('alcorvideo:request-project', (event) => {
    if (event.detail && typeof event.detail === 'object')
      event.detail.project = JSON.parse(serializeProject(false));
  });

  function evenDimension(value, min, max, fallback) {
    const number = Math.round(clamp(value || fallback, min, max));
    return number % 2 ? number - 1 : number;
  }

  function hex(value, fallback) {
    return /^#[0-9a-f]{6}$/i.test(value || '') ? value : fallback;
  }

  function normalizeTitle(clip, normalized) {
    const legacy = clip.x == null && clip.align == null;
    Object.assign(normalized, {
      text: String(clip.text || 'Title').slice(0, 240),
      size: clamp(clip.size || 64, 12, 200),
      x: clamp(clip.x == null ? 50 : clip.x, 0, 100),
      y: clamp(clip.y == null ? 82 : clip.y, 0, 100),
      align: ['left', 'center', 'right'].includes(clip.align) ? clip.align : 'center',
      font: Object.prototype.hasOwnProperty.call(TITLE_FONTS, clip.font) ? clip.font : 'sans',
      color: hex(clip.color, '#ffffff'),
      background: hex(clip.background, '#000000'),
      backgroundOpacity: clamp(clip.backgroundOpacity == null ? 0.5 : clip.backgroundOpacity, 0, 1),
      bold: clip.bold !== false,
      italic: Boolean(clip.italic),
      stroke: hex(clip.stroke, '#000000'),
      strokeWidth: clamp(clip.strokeWidth || 0, 0, 20),
      shadow: legacy ? true : clip.shadow !== false,
      fadeIn: Math.min(normalized.duration, Math.max(0, round(clip.fadeIn))),
      fadeOut: Math.min(normalized.duration, Math.max(0, round(clip.fadeOut))),
    });
  }

  function normalizeProject(input, options = {}) {
    if (!input || typeof input !== 'object') throw new Error('Project file is not an object.');
    if (input.schema !== PROJECT_SCHEMA) throw new Error('This is not an AlcorVideo project file.');
    if (Number(input.schemaVersion) !== 1)
      throw new Error('Unsupported AlcorVideo project schema.');
    // Bound every imported collection and clip window before walking it.
    editorCore.validateProjectEnvelope(input);
    const revision = Math.max(1, Math.trunc(Number(input.revision) || 1));

    const project = createProject();
    project.name = String(input.name || 'Untitled project').slice(0, 80);
    project.width = evenDimension(input.width, 320, 7680, 1280);
    project.height = evenDimension(input.height, 180, 4320, 720);
    project.fps = FPS_OPTIONS.includes(Number(input.fps)) ? Number(input.fps) : 30;
    project.background = hex(input.background, '#090b10');
    project.createdAt = input.createdAt || project.createdAt;
    project.updatedAt = input.updatedAt || project.updatedAt;

    const seenAssets = new Set();
    project.assets = Array.isArray(input.assets)
      ? input.assets.map((asset) => {
          const id = String(asset.id || uid('asset')).slice(0, 100);
          if (!ID_PATTERN.test(id)) throw new Error('Asset ids contain unsupported characters.');
          if (seenAssets.has(id)) throw new Error(`Duplicate asset id: ${id}`);
          seenAssets.add(id);
          const kind = ['video', 'audio', 'image'].includes(asset.kind)
            ? asset.kind
            : kindFromType(asset.type || '', asset.name || '');
          if (!kind) throw new Error(`Unsupported asset type: ${asset.name || id}`);
          const normalized = {
            id,
            name: String(asset.name || 'Untitled media').slice(0, 255),
            type: String(asset.type || ''),
            kind,
            size: clamp(asset.size, 0, Number(config.maxImportBytes || 2147483648)),
            duration: clamp(
              asset.duration == null ? (kind === 'image' ? 5 : 0) : asset.duration,
              0,
              LIMITS.maxProjectSeconds,
            ),
            width: clamp(asset.width, 0, 7680),
            height: clamp(asset.height, 0, 4320),
          };
          if (typeof asset.hasAudio === 'boolean') normalized.hasAudio = asset.hasAudio;
          if (Number(asset.fps) > 0) normalized.fps = round(clamp(asset.fps, 1, 240), 3);
          if (Number(asset.channels) > 0)
            normalized.channels = Math.round(clamp(asset.channels, 1, 8));
          return normalized;
        })
      : [];
    if (project.assets.reduce((sum, asset) => sum + asset.size, 0) > LIMITS.maxAggregateImportBytes)
      throw new Error('Project media metadata exceeds the aggregate local-media budget.');

    project.tracks = Edit.normalizeTracks(
      input.tracks,
      Array.isArray(input.clips) ? input.clips : [],
    );
    const trackIds = new Set(project.tracks.map((track) => track.id));
    const assetIds = new Set(project.assets.map((asset) => asset.id));
    const seenClips = new Set();
    project.clips = Array.isArray(input.clips)
      ? input.clips.map((clip) => {
          const id = String(clip.id || uid('clip')).slice(0, 100);
          if (!ID_PATTERN.test(id)) throw new Error('Clip ids contain unsupported characters.');
          if (seenClips.has(id)) throw new Error(`Duplicate clip id: ${id}`);
          seenClips.add(id);
          const kind =
            clip.kind === 'title'
              ? 'title'
              : ['video', 'audio', 'image'].includes(clip.kind)
                ? clip.kind
                : 'video';
          const requestedTrack = String(clip.track || '');
          const track =
            trackIds.has(requestedTrack) && Edit.trackAccepts(requestedTrack, { kind })
              ? requestedTrack
              : kind === 'audio'
                ? (project.tracks.find((item) => item.kind === 'audio') || {}).id
                : kind === 'title' && trackIds.has('V2')
                  ? 'V2'
                  : (project.tracks.find((item) => item.kind === 'video') || {}).id;
          const clipWindow = editorCore.normalizeClipWindow(
            clip.start,
            clip.duration == null ? (kind === 'image' ? 5 : 1) : clip.duration,
            kind === 'title' ? 0.1 : MIN_CLIP_DURATION,
          );
          const normalized = {
            id,
            kind,
            name: String(clip.name || (kind === 'title' ? 'Title' : 'Clip')).slice(0, 100),
            track,
            ...clipWindow,
          };
          if (clip.linkId && ID_PATTERN.test(String(clip.linkId)))
            normalized.linkId = String(clip.linkId).slice(0, 100);
          if (kind === 'title') {
            normalizeTitle(clip, normalized);
            normalized.transformKeyframes = [];
            normalized.crossDissolve = null;
          } else {
            normalized.assetId = assetIds.has(String(clip.assetId || ''))
              ? String(clip.assetId)
              : String(clip.assetId || 'missing');
            const asset = project.assets.find((item) => item.id === normalized.assetId);
            Object.assign(normalized, {
              in: Math.max(0, round(clip.in)),
              speed: round(clamp(clip.speed || 1, Edit.LIMITS.minSpeed, Edit.LIMITS.maxSpeed), 4),
              opacity: clamp(clip.opacity == null ? 1 : clip.opacity, 0, 1),
              volume: clamp(clip.volume == null ? 1 : clip.volume, 0, 1),
              muted: Boolean(clip.muted),
              gain: round(clamp(clip.gain || 0, -60, 12), 1),
              pan: round(clamp(clip.pan || 0, -1, 1), 2),
              fadeIn: Math.min(normalized.duration, Math.max(0, round(clip.fadeIn))),
              fadeOut: Math.min(normalized.duration, Math.max(0, round(clip.fadeOut))),
              ...transformCore.normalizeTransform(clip),
              transformKeyframes: transformCore.normalizeKeyframes(
                (Array.isArray(clip.transformKeyframes) ? clip.transformKeyframes : []).map(
                  (frame) => ({ opacity: clip.opacity == null ? 1 : clip.opacity, ...frame }),
                ),
                normalized.duration,
              ),
              volumeKeyframes: audioAutomationCore.normalizeKeyframes(
                (Array.isArray(clip.volumeKeyframes) ? clip.volumeKeyframes : []).map((frame) => ({
                  volume: clip.volume == null ? 1 : clip.volume,
                  ...frame,
                })),
                normalized.duration,
                clip.volume == null ? 1 : clip.volume,
              ),
              crossDissolve: transitionCore.normalizeCrossDissolve(clip.crossDissolve),
              ...colorCore.normalizeColor(clip),
            });
            if (clip.reverse && (kind === 'video' || kind === 'audio')) normalized.reverse = true;
            if (kind === 'video' && clip.hold != null && Number.isFinite(Number(clip.hold))) {
              normalized.hold = round(
                clamp(
                  clip.hold,
                  0,
                  asset && asset.duration ? asset.duration : LIMITS.maxProjectSeconds,
                ),
                4,
              );
              delete normalized.reverse;
            }
          }
          return normalized;
        })
      : [];

    project.markers = Edit.normalizeMarkers(input.markers, LIMITS.maxProjectSeconds);
    project.luts = gradeCore
      ? (Array.isArray(input.luts) ? input.luts : [])
          .map((record) => gradeCore.normalizeLutRecord(record))
          .filter(Boolean)
          .slice(0, gradeCore.LIMITS.maxLuts)
      : [];
    const lutIds = new Set(project.luts.map((record) => record.id));
    for (const clip of project.clips) {
      if (clip.kind === 'title') continue;
      const source =
        (Array.isArray(input.clips) ? input.clips : []).find(
          (item) => item && String(item.id) === clip.id,
        ) || {};
      if (clip.kind === 'video' || clip.kind === 'image')
        normalizeGradeExtras(clip, source, lutIds);
      // Effects, blend, anchor, speed ramps and audio effects (absent fields stay absent).
      if (effectsCore) effectsCore.normalizeClipEffects(clip, source, clip.duration);
    }
    Object.assign(
      project,
      Edit.normalizeInOut(input.inPoint, input.outPoint, LIMITS.maxProjectSeconds),
    );
    project.revision = PROJECT_REVISION;
    const notes = [];
    if (!options.restoring && revision < 2) {
      const upgraded = migrateEmbeddedAudio(project);
      if (upgraded)
        notes.push(
          `${upgraded} video clip${upgraded === 1 ? '' : 's'} now carry their sound as a linked audio clip`,
        );
    }
    const moved = Edit.resolveLegacyOverlaps(project);
    if (moved)
      notes.push(`${moved} overlapping clip${moved === 1 ? '' : 's'} moved to another track`);
    if (options.notes) options.notes.push(...notes);
    return project;
  }

  // Revision 1 played a video clip's sound from the video itself. Revision 2 keeps
  // sound on audio tracks, linked to its picture, like Premiere. Move each legacy
  // video clip's sound (with its volume, keyframes and fades) to a linked clip.
  function migrateEmbeddedAudio(project) {
    let count = 0;
    for (const clip of project.clips.slice()) {
      if (clip.kind !== 'video' || clip.muted || clip.hold != null || clip.linkId) continue;
      const asset = project.assets.find((item) => item.id === clip.assetId);
      if (asset && asset.hasAudio === false) continue;
      let audioId = `${clip.id}-a`.slice(0, 100);
      while (project.clips.some((item) => item.id === audioId)) audioId = uid('clip');
      const linkId = `link-${clip.id}`.slice(0, 100);
      const audio = {
        id: audioId,
        kind: 'audio',
        name: clip.name,
        track: '',
        start: clip.start,
        duration: clip.duration,
        linkId,
        assetId: clip.assetId,
        in: clip.in,
        speed: clip.speed,
        opacity: 1,
        volume: clip.volume,
        muted: false,
        gain: 0,
        pan: 0,
        fadeIn: clip.fadeIn,
        fadeOut: clip.fadeOut,
        ...transformCore.normalizeTransform({}),
        transformKeyframes: [],
        volumeKeyframes: clip.volumeKeyframes,
        crossDissolve: null,
        ...colorCore.neutralColor(),
      };
      const free = project.tracks
        .filter((track) => track.kind === 'audio')
        .find(
          (track) =>
            !project.clips.some(
              (other) =>
                other.track === track.id &&
                other.start < audio.start + audio.duration - 0.0015 &&
                other.start + other.duration > audio.start + 0.0015,
            ),
        );
      if (free) audio.track = free.id;
      else {
        const added = Edit.addTrack(project, 'audio');
        if (!added.ok) continue;
        audio.track = added.trackId;
      }
      clip.linkId = linkId;
      clip.volumeKeyframes = [];
      project.clips.push(audio);
      count += 1;
    }
    return count;
  }

  // Vibrance, curves and a LUT reference live on visual clips; LUT data lives once in project.luts.
  function normalizeGradeExtras(clip, source, lutIds) {
    delete clip.vibrance;
    delete clip.curves;
    delete clip.lut;
    delete clip.wheels;
    delete clip.hsl;
    const vibrance = round(clamp(source.vibrance || 0, -100, 100), 1);
    if (vibrance) clip.vibrance = vibrance;
    const curves = gradeCore ? gradeCore.normalizeCurves(source.curves) : null;
    if (curves) clip.curves = curves;
    const wheels =
      gradeCore && gradeCore.normalizeWheels ? gradeCore.normalizeWheels(source.wheels) : null;
    if (wheels) clip.wheels = wheels;
    const hsl = gradeCore && gradeCore.normalizeHsl ? gradeCore.normalizeHsl(source.hsl) : null;
    if (hsl) clip.hsl = hsl;
    if (source.lut && typeof source.lut === 'object' && lutIds.has(String(source.lut.id))) {
      clip.lut = {
        id: String(source.lut.id),
        intensity: Math.round(
          clamp(source.lut.intensity == null ? 100 : source.lut.intensity, 0, 100),
        ),
      };
    }
  }

  const decodedLuts = new Map();
  function decodedLut(id) {
    if (!gradeCore || !id) return null;
    const record = (state.project.luts || []).find((item) => item.id === id);
    if (!record) return null;
    const cached = decodedLuts.get(id);
    if (cached && cached.data === record.data) return cached.lut;
    const lut = gradeCore.decodeLut(record);
    decodedLuts.set(id, { data: record.data, lut });
    return lut;
  }

  function gradeExtras(clip) {
    const hsl =
      clip && clip.hsl && gradeCore && gradeCore.activeHsl ? gradeCore.activeHsl(clip.hsl) : null;
    if (!clip || (!clip.vibrance && !clip.curves && !clip.lut && !clip.wheels && !hsl)) return null;
    const lut = clip.lut ? decodedLut(clip.lut.id) : null;
    const record = clip.lut ? state.project.luts.find((item) => item.id === clip.lut.id) : null;
    return {
      vibrance: clip.vibrance || 0,
      curves: clip.curves || null,
      wheels: clip.wheels || null,
      hsl,
      lut,
      lutId: record ? `${record.id}:${record.data.length}` : '',
      lutIntensity: clip.lut ? clip.lut.intensity / 100 : 1,
    };
  }

  let gradeRenderer;
  let gradeWarning = '';
  function getGradeRenderer() {
    if (gradeRenderer === undefined)
      gradeRenderer = gradeCore ? gradeCore.createRenderer(document) : null;
    if (gradeRenderer && gradeRenderer.lost) gradeRenderer = gradeCore.createRenderer(document);
    return gradeRenderer;
  }

  function emitGradeState(message = '') {
    const clip = getClip();
    const lutRecord =
      clip && clip.lut ? state.project.luts.find((item) => item.id === clip.lut.id) : null;
    root.dispatchEvent(
      new CustomEvent('alcorvideo:grade-state', {
        detail: {
          kind: clip ? clip.kind : '',
          vibrance: clip && clip.vibrance ? clip.vibrance : 0,
          curves: clip && clip.curves ? clip.curves : null,
          wheels: clip && clip.wheels ? clip.wheels : null,
          hsl: clip && clip.hsl ? clip.hsl : null,
          lut: lutRecord
            ? {
                id: lutRecord.id,
                name: lutRecord.name,
                size: lutRecord.size,
                intensity: clip.lut.intensity,
              }
            : null,
          message: message || gradeWarning,
        },
      }),
    );
  }

  root.addEventListener('alcorvideo:grade-patch', (event) => {
    const clip = getClip();
    const patch = event.detail && event.detail.patch;
    if (
      !gradeCore ||
      !clip ||
      (clip.kind !== 'video' && clip.kind !== 'image') ||
      !patch ||
      typeof patch !== 'object'
    )
      return;
    const apply = () => {
      const lutIds = new Set((state.project.luts || []).map((record) => record.id));
      const source = {
        vibrance: clip.vibrance,
        curves: clip.curves,
        lut: clip.lut,
        wheels: clip.wheels,
        hsl: clip.hsl,
      };
      for (const key of ['vibrance', 'curves', 'lut', 'wheels', 'hsl'])
        if (key in patch) source[key] = patch[key];
      normalizeGradeExtras(clip, source, lutIds);
    };
    if (event.detail.live) {
      state.gradeBefore = state.gradeBefore || snapshot();
      apply();
      renderPreview();
      return;
    }
    const before = state.gradeBefore || snapshot();
    state.gradeBefore = null;
    apply();
    if (!clip.lut) pruneLuts();
    if (snapshot() !== before) {
      pushHistory(before, String(event.detail.label || 'Color changed'));
      markDirty(String(event.detail.label || 'Color changed'));
    }
    renderPreview();
    emitGradeState();
  });

  root.addEventListener('alcorvideo:lut-import', (event) => {
    const clip = getClip();
    const detail = event.detail || {};
    if (!gradeCore || !clip || (clip.kind !== 'video' && clip.kind !== 'image')) {
      setStatus('Select a video or image clip before loading a LUT');
      return;
    }
    const existing = state.project.luts.find(
      (record) => record.data === detail.data && record.size === detail.size,
    );
    if (!existing && state.project.luts.length >= gradeCore.LIMITS.maxLuts) {
      setStatus(
        `A project can hold ${gradeCore.LIMITS.maxLuts} LUTs; remove one from a clip first.`,
      );
      return;
    }
    const record =
      existing ||
      gradeCore.normalizeLutRecord({
        id: uid('lut'),
        name: detail.name,
        size: detail.size,
        data: detail.data,
      });
    if (!record) {
      setStatus('That LUT could not be stored');
      return;
    }
    mutate(`LUT ${record.name}`, () => {
      if (!existing) state.project.luts.push(record);
      clip.lut = { id: record.id, intensity: 100 };
    });
    setStatus(`LUT ${record.name} (${record.size}³) applied locally`);
    emitGradeState();
  });

  // Drop LUT tables no clip uses any more (keeps saved projects small).
  function pruneLuts() {
    if (!state.project.luts || !state.project.luts.length) return;
    const used = new Set(
      state.project.clips.map((clip) => clip.lut && clip.lut.id).filter(Boolean),
    );
    state.project.luts = state.project.luts.filter((record) => used.has(record.id));
  }

  function exportProjectFile() {
    pruneLuts();
    const blob = new Blob([serializeProject(true)], { type: 'application/json' });
    downloadBlob(blob, `${safeFileName(state.project.name)}.alcorvideo.json`);
    state.dirty = false;
    if (elements.saveState) elements.saveState.textContent = 'Project file downloaded';
    setStatus('Project manifest downloaded; media bytes were not embedded');
  }

  function validatePortableProject(project, records = null) {
    if (
      !Array.isArray(project.assets) ||
      !Array.isArray(project.clips) ||
      project.assets.length > editorCore.LIMITS.maxAssets ||
      project.clips.length > editorCore.LIMITS.maxClips
    ) {
      throw new Error('Portable project exceeds the supported asset or clip limits.');
    }
    const assets = new Map();
    for (const asset of project.assets) {
      if (
        !asset ||
        typeof asset.id !== 'string' ||
        !asset.id ||
        assets.has(asset.id) ||
        !['video', 'audio', 'image'].includes(asset.kind) ||
        !Number.isSafeInteger(asset.size) ||
        asset.size < 0
      )
        throw new Error('Invalid portable media identity.');
      assets.set(asset.id, asset);
    }
    if (records)
      for (const record of records) {
        const asset = assets.get(record.id);
        if (!asset || ['name', 'type', 'kind', 'size'].some((key) => asset[key] !== record[key])) {
          throw new Error('Portable media table does not match project metadata.');
        }
      }
    for (const clip of project.clips) {
      const assetKind = assets.get(clip && clip.assetId)?.kind;
      // Linked sound may come from a video file.
      const kindMatches =
        clip &&
        (clip.kind === 'title' ||
          assetKind === clip.kind ||
          (clip.kind === 'audio' && assetKind === 'video'));
      if (
        !clip ||
        !['title', 'video', 'audio', 'image'].includes(clip.kind) ||
        !Number.isFinite(clip.start) ||
        clip.start < 0 ||
        !Number.isFinite(clip.duration) ||
        clip.duration <= 0 ||
        clip.start + clip.duration > editorCore.LIMITS.maxProjectSeconds ||
        !kindMatches
      ) {
        throw new Error('Portable project contains an invalid clip or missing media reference.');
      }
    }
  }

  async function savePortableProject() {
    if (state.projectIO || state.importing || state.rendering) {
      setStatus('Wait for the current file operation or render to finish.');
      return;
    }
    state.projectIO = true;
    const currentProject = state.project;
    const before = snapshot();
    try {
      pruneLuts();
      const project = JSON.parse(serializeProject());
      const files = new Map();
      for (const asset of project.assets) {
        const file = state.runtimeAssets.get(asset.id)?.file;
        if (file) {
          // Older JSON manifests can omit these fields; the linked bytes are authoritative on Save.
          asset.size = file.size;
          asset.type = asset.type || file.type || '';
          files.set(asset.id, file);
        }
      }
      validatePortableProject(project);
      const { blob } = await editorCore.createPortableProjectBundle(project, files);
      downloadBlob(blob, `${safeFileName(project.name)}.alcorvideo`);
      if (state.project === currentProject && snapshot() === before) {
        state.dirty = false;
        if (elements.saveState) elements.saveState.textContent = 'Project file downloaded';
        setStatus('Portable project downloaded with linked media');
      } else {
        setStatus('Portable snapshot downloaded; newer edits still need saving');
      }
    } catch (error) {
      setStatus(`Could not save portable project: ${error.message}`);
    } finally {
      state.projectIO = false;
    }
  }

  function confirmNewerRevision(input) {
    const revision = Number(input && input.revision) || 1;
    if (revision <= PROJECT_REVISION) return true;
    return window.confirm(
      'This project was saved by a newer AlcorVideo. It will open, but settings this version does not know about will be dropped when you save. Continue?',
    );
  }

  async function openProjectFile(file) {
    if (!file) return;
    if (state.projectIO || state.importing || state.rendering || state.drag)
      throw new Error('Wait for the current operation to finish.');
    if (
      state.dirty &&
      !window.confirm(
        'Open another project? Unsaved changes in the current project will be discarded.',
      )
    )
      return;
    state.projectIO = true;
    const currentProject = state.project;
    const before = JSON.stringify(currentProject);
    const staged = new Map();
    const notes = [];
    let committed = false;
    let portable = false;
    try {
      portable = await editorCore.hasPortableProjectMagic(file);
      let project;
      if (portable) {
        const bundle = await editorCore.parsePortableProjectBundle(file);
        validatePortableProject(bundle.project, bundle.assets);
        if (!confirmNewerRevision(bundle.project)) return;
        project = normalizeProject(bundle.project, { notes });
        const records = new Map(bundle.assets.map((asset) => [asset.id, asset]));
        for (const asset of project.assets) {
          const embedded = records.get(asset.id);
          const media = new File([embedded.blob], asset.name, { type: asset.type });
          staged.set(asset.id, await buildRuntimeAsset(asset, media));
        }
      } else {
        if (file.size > 5 * 1024 * 1024) throw new Error('Project file is unexpectedly large.');
        const parsed = JSON.parse(await file.text());
        if (!confirmNewerRevision(parsed)) return;
        project = normalizeProject(parsed, { notes });
        // Metadata cannot choose between same-named sources with different bytes.
        const identityKey = (asset) =>
          JSON.stringify([asset.name, asset.kind, asset.type, asset.size]);
        const incomingIdentities = new Map();
        for (const asset of project.assets) {
          const key = identityKey(asset);
          incomingIdentities.set(key, (incomingIdentities.get(key) || 0) + 1);
        }
        for (const asset of project.assets) {
          // Even one active source cannot resolve two distinct incoming items.
          // Leave every repeated identity offline for explicit per-item Relink.
          if (incomingIdentities.get(identityKey(asset)) !== 1) continue;
          const matches =
            asset.type && asset.size > 0
              ? currentProject.assets.filter(
                  (item) =>
                    item.name === asset.name &&
                    item.kind === asset.kind &&
                    item.type === asset.type &&
                    item.size === asset.size &&
                    state.runtimeAssets.has(item.id),
                )
              : [];
          if (matches.length === 1) staged.set(asset.id, state.runtimeAssets.get(matches[0].id));
        }
      }
      if (
        state.project !== currentProject ||
        JSON.stringify(currentProject) !== before ||
        state.drag
      ) {
        throw new Error(
          'The active project changed while opening; open the file again when ready.',
        );
      }
      pause(false);
      cleanupRuntime(new Set([...staged.values()].map((runtime) => runtime.objectUrl)));
      state.project = project;
      state.runtimeAssets = staged;
      state.selectedId = null;
      state.selection = new Set();
      state.currentTime = 0;
      // Undo cannot cross a document boundary after its media URLs are released.
      state.history.clear();
      committed = true;
      if (elements.projectName) elements.projectName.value = project.name;
      if (elements.fps) elements.fps.value = String(project.fps);
      markDirty('Opened project');
      for (const [assetId, runtime] of staged.entries()) announceMedia(getAsset(assetId), runtime);
      renderAll();
      const base = portable
        ? 'Portable project opened with local media'
        : 'Project opened; import matching files to relink missing media';
      setStatus(notes.length ? `${base} · ${notes.join(' · ')}` : base);
    } finally {
      if (!committed && portable)
        for (const runtime of staged.values()) URL.revokeObjectURL(runtime.objectUrl);
      state.projectIO = false;
    }
  }

  // ------------------------------------------------------------------ media

  function kindFromType(type, name = '') {
    const mime = String(type || '').toLowerCase();
    const lower = String(name || '').toLowerCase();
    if (mime.startsWith('video/') || /\.(mp4|mov|m4v|webm|ogv|mkv)$/i.test(lower)) return 'video';
    if (mime.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(lower)) return 'audio';
    if (mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(lower))
      return 'image';
    return '';
  }

  function waitFor(element, successEvent, errorEvent = 'error', timeout = 15000) {
    return new Promise((resolve, reject) => {
      let timer = 0;
      const cleanup = () => {
        window.clearTimeout(timer);
        element.removeEventListener(successEvent, onSuccess);
        element.removeEventListener(errorEvent, onError);
      };
      const onSuccess = () => {
        cleanup();
        resolve(element);
      };
      const onError = () => {
        cleanup();
        reject(new Error('The browser could not decode this media file.'));
      };
      element.addEventListener(successEvent, onSuccess, { once: true });
      element.addEventListener(errorEvent, onError, { once: true });
      timer = window.setTimeout(() => {
        cleanup();
        reject(new Error('Timed out while reading media metadata.'));
      }, timeout);
    });
  }

  async function buildRuntimeAsset(asset, file) {
    const objectUrl = URL.createObjectURL(file);
    const runtime = { objectUrl, file, kind: asset.kind, image: null };
    let probe = null;
    try {
      if (asset.kind === 'image') {
        const image = new Image();
        image.decoding = 'async';
        image.src = objectUrl;
        if (!image.complete) await waitFor(image, 'load');
        if (typeof image.decode === 'function') await image.decode();
        if (!image.naturalWidth || !image.naturalHeight)
          throw new Error('The browser could not decode this image.');
        runtime.image = image;
        asset.width = image.naturalWidth || 0;
        asset.height = image.naturalHeight || 0;
        asset.duration = asset.duration || 5;
      } else {
        probe = document.createElement(asset.kind === 'video' ? 'video' : 'audio');
        probe.preload = 'auto';
        probe.playsInline = true;
        probe.src = objectUrl;
        if (probe.readyState < 2) await waitFor(probe, 'loadeddata');
        if (
          !Number.isFinite(probe.duration) ||
          probe.duration <= 0 ||
          (asset.kind === 'video' && (!probe.videoWidth || !probe.videoHeight))
        ) {
          throw new Error('The browser could not decode playable media.');
        }
        asset.duration = Number.isFinite(probe.duration) ? probe.duration : 0;
        if (asset.kind === 'audio' && mediaCore) {
          const info = await mediaCore.probe(file);
          if (info.audioChannels) asset.channels = info.audioChannels;
        }
        if (asset.kind === 'video') {
          asset.width = probe.videoWidth || 0;
          asset.height = probe.videoHeight || 0;
          if (mediaCore) {
            const info = await mediaCore.probe(file);
            if (typeof info.hasAudio === 'boolean') asset.hasAudio = info.hasAudio;
            if (info.fps) asset.fps = round(info.fps, 3);
            if (info.audioChannels) asset.channels = info.audioChannels;
            // Premiere sizes a video clip by its picture stream; AAC priming can pad the file a few ms.
            if (info.videoDuration && Math.abs(info.videoDuration - asset.duration) < 0.25)
              asset.duration = info.videoDuration;
            runtime.probe = info;
          }
        }
      }
      return runtime;
    } catch (error) {
      URL.revokeObjectURL(objectUrl);
      throw error;
    } finally {
      if (probe) {
        probe.removeAttribute('src');
        probe.load();
      }
    }
  }

  // Tell helper panels (waveforms) which local file backs an asset.
  function announceMedia(asset, runtime) {
    if (!asset || !runtime || !runtime.file) return;
    root.dispatchEvent(
      new CustomEvent('alcorvideo:media-linked', {
        detail: { assetId: asset.id, file: runtime.file },
      }),
    );
    queueThumbnails(asset, runtime);
  }

  function findRelinkTargets(file, kind) {
    return state.project.assets.filter(
      (asset) =>
        asset.name === file.name &&
        asset.kind === kind &&
        (!asset.type || asset.type === file.type) &&
        (!asset.size || asset.size === file.size) &&
        !state.runtimeAssets.has(asset.id),
    );
  }

  // Same name, type and size, and identical sampled bytes (start, middle, end).
  async function sameLocalFile(a, b) {
    if (!a || !b || a.name !== b.name || a.type !== b.type || a.size !== b.size) return false;
    if (a === b) return true;
    if (typeof a.slice !== 'function' || typeof b.slice !== 'function') return false;
    const span = 256 * 1024;
    const offsets = [0, Math.max(0, Math.floor(a.size / 2) - span / 2), Math.max(0, a.size - span)];
    try {
      for (const offset of offsets) {
        const [left, right] = await Promise.all([
          a.slice(offset, offset + span).arrayBuffer(),
          b.slice(offset, offset + span).arrayBuffer(),
        ]);
        const x = new Uint8Array(left);
        const y = new Uint8Array(right);
        if (x.length !== y.length) return false;
        for (let index = 0; index < x.length; index += 1) if (x[index] !== y[index]) return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  // `placed`: the caller places the media itself (Basic must not append it).
  async function importMedia(files, targetAssetId = null, placed = false) {
    const list = Array.from(files || []);
    if (!list.length) return;
    if (state.projectIO || state.importing || state.rendering) {
      setStatus('Wait for the current operation to finish.');
      return;
    }
    if (targetAssetId && list.length !== 1) {
      setStatus('Choose one local file for this offline item.');
      return;
    }
    if (!targetAssetId && list.length + state.project.assets.length > LIMITS.maxAssets) {
      setStatus(`This project supports at most ${LIMITS.maxAssets} local media assets`);
      if (elements.mediaInput) elements.mediaInput.value = '';
      return;
    }
    const mobile = isSmallDevice();
    const aggregateLimit = mobile ? 1024 * 1024 * 1024 : LIMITS.maxAggregateImportBytes;
    const currentBytes = state.project.assets.reduce(
      (sum, asset) => sum + (state.runtimeAssets.has(asset.id) ? asset.size : 0),
      0,
    );
    const incomingBytes = list.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    if (currentBytes + incomingBytes > aggregateLimit) {
      setStatus(`Local media is limited to ${mobile ? '1 GB' : '4 GB'} per project on this device`);
      if (elements.mediaInput) elements.mediaInput.value = '';
      return;
    }
    state.importing = true;
    let imported = 0;
    let failed = 0;
    const added = [];
    let relinkNotice = '';
    const reasons = [];
    setStatus(`Reading ${list.length} local file${list.length === 1 ? '' : 's'}…`);

    try {
      for (const file of list) {
        const kind = kindFromType(file.type, file.name);
        if (!kind) {
          failed += 1;
          reasons.push(`${file.name}: not a video, audio or image file`);
          continue;
        }
        if (!(file.size > 0)) {
          failed += 1;
          reasons.push(`${file.name}: the file is empty`);
          continue;
        }
        if (file.size > Number(config.maxImportBytes || 2147483648)) {
          failed += 1;
          setStatus(`${file.name} exceeds the 2 GB browser-import guard`);
          reasons.push(`${file.name}: over the 2 GB import guard`);
          continue;
        }

        const candidates = findRelinkTargets(file, kind).filter(
          (asset) => !targetAssetId || asset.id === targetAssetId,
        );
        if (!targetAssetId && !candidates.length) {
          // The same local file is already linked: do not duplicate it in the bin.
          let linked = null;
          for (const asset of state.project.assets) {
            const source = state.runtimeAssets.get(asset.id)?.file;
            if (source && (await sameLocalFile(source, file))) {
              linked = asset;
              break;
            }
          }
          if (linked) {
            imported += 1;
            relinkNotice = `${file.name} is already in the bin`;
            continue;
          }
        }
        if (targetAssetId && !candidates.length) {
          failed += 1;
          relinkNotice =
            'The selected file does not match this offline item; its source was preserved.';
          continue;
        }
        if (candidates.length > 1) {
          failed += 1;
          relinkNotice =
            'Several offline items match this file. Choose Relink on the intended item to select its source.';
          continue;
        }
        let asset = candidates[0] || null;
        const isRelink = Boolean(asset);
        if (
          asset &&
          (!asset.type || !asset.size) &&
          !window.confirm(
            `This older project has incomplete media details for "${asset.name}". Relink it to the file you selected?`,
          )
        ) {
          failed += 1;
          relinkNotice = 'Relink cancelled; the offline item was preserved.';
          continue;
        }
        if (!asset) {
          asset = {
            id: uid('asset'),
            name: file.name,
            type: file.type,
            kind,
            size: file.size,
            duration: kind === 'image' ? 5 : 0,
            width: 0,
            height: 0,
          };
        }

        try {
          // Commit refreshed legacy metadata only after the selected file decodes.
          const decodedAsset = isRelink
            ? { ...asset, type: asset.type || file.type || '', size: file.size }
            : asset;
          const runtime = await buildRuntimeAsset(decodedAsset, file);
          if (isRelink) Object.assign(asset, decodedAsset);
          if (!isRelink) {
            state.project.assets.push(asset);
            added.push(asset.id);
          }
          state.runtimeAssets.set(asset.id, runtime);
          clearClipElementsForAsset(asset.id);
          announceMedia(asset, runtime);
          imported += 1;
        } catch (error) {
          console.warn(`AlcorVideo import failed for ${file.name}:`, error);
          failed += 1;
          reasons.push(`${file.name}: ${error.message}`);
        }
      }

      if (imported) {
        markDirty(imported === 1 ? 'Media linked' : `${imported} media files linked`);
        renderAll();
      }
      const detail = !relinkNotice && reasons.length ? ` · ${reasons.slice(0, 2).join(' · ')}` : '';
      setStatus(
        `${imported} file${imported === 1 ? '' : 's'} ready${failed ? ` · ${failed} skipped` : ''}${relinkNotice ? ` · ${relinkNotice}` : ''}${detail}`,
      );
    } finally {
      if (elements.mediaInput) elements.mediaInput.value = '';
      state.importing = false;
    }
    if (added.length)
      root.dispatchEvent(
        new CustomEvent('alcorvideo:media-imported', { detail: { assetIds: added, placed } }),
      );
  }

  function releaseElement(entry) {
    if (!entry || entry.kind === 'image') return;
    entry.element?.pause?.();
    try {
      entry.audioNode?.source?.disconnect?.();
      entry.audioNode?.gain?.disconnect?.();
      entry.audioNode?.panner?.disconnect?.();
    } catch (_) {}
    entry.element?.removeAttribute?.('src');
    entry.element?.load?.();
  }

  function clearClipElementsForAsset(assetId) {
    for (const [clipId, entry] of state.clipElements.entries()) {
      const clip = getClip(clipId);
      if (!clip || clip.assetId === assetId) {
        releaseElement(entry);
        state.clipElements.delete(clipId);
      }
    }
  }

  // Drop media elements for clips that no longer exist or changed kind/asset.
  function pruneClipElements() {
    for (const [clipId, entry] of state.clipElements.entries()) {
      const clip = getClip(clipId);
      if (!clip || clip.assetId !== entry.assetId || clip.kind !== entry.clipKind) {
        releaseElement(entry);
        state.clipElements.delete(clipId);
      }
    }
  }

  // Filmstrip thumbnails for video assets, generated in the background from a
  // private element, bounded in count and size, stored as small local JPEG blobs.
  const thumbnailQueue = [];
  let thumbnailBusy = false;

  function queueThumbnails(asset, runtime) {
    if (!asset || asset.kind !== 'video' || !runtime?.objectUrl || state.thumbnails.has(asset.id))
      return;
    if (typeof document.createElement('canvas').toBlob !== 'function') return;
    state.thumbnails.set(asset.id, { status: 'queued', frames: [] });
    thumbnailQueue.push({ asset, runtime });
    pumpThumbnails();
  }

  async function pumpThumbnails() {
    if (thumbnailBusy) return;
    const job = thumbnailQueue.shift();
    if (!job) return;
    thumbnailBusy = true;
    const record = state.thumbnails.get(job.asset.id);
    const video = document.createElement('video');
    try {
      video.muted = true;
      video.preload = 'auto';
      video.playsInline = true;
      video.src = job.runtime.objectUrl;
      await waitFor(video, 'loadeddata', 'error', 10000);
      const duration = Number(video.duration) || job.asset.duration || 0;
      const count = Math.max(1, Math.min(24, Math.ceil(duration / 2)));
      const height = 54;
      const width = Math.max(
        32,
        Math.round((height * (video.videoWidth || 16)) / (video.videoHeight || 9)),
      );
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      record.status = 'working';
      for (let index = 0; index < count; index += 1) {
        if (!state.thumbnails.has(job.asset.id) || state.rendering) break;
        const time = Math.min(Math.max(0, duration - 0.05), ((index + 0.5) * duration) / count);
        if (Math.abs(video.currentTime - time) > 0.01) {
          video.currentTime = time;
          await waitFor(video, 'seeked', 'error', 8000);
        }
        context.drawImage(video, 0, 0, width, height);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.72));
        if (!blob) break;
        record.frames.push({ time, url: URL.createObjectURL(blob) });
        if (index === 0 || index === count - 1) scheduleTimelineRender();
      }
      record.status = 'ready';
      renderMediaBin();
      scheduleTimelineRender();
    } catch (_) {
      if (record) record.status = 'failed';
    } finally {
      video.removeAttribute('src');
      video.load?.();
      thumbnailBusy = false;
      if (thumbnailQueue.length) window.setTimeout(pumpThumbnails, 0);
    }
  }

  function thumbnailAt(assetId, sourceTime) {
    const record = state.thumbnails.get(assetId);
    if (!record || !record.frames.length) return '';
    let best = record.frames[0];
    for (const frame of record.frames)
      if (Math.abs(frame.time - sourceTime) < Math.abs(best.time - sourceTime)) best = frame;
    return best.url;
  }

  function releaseThumbnails() {
    for (const record of state.thumbnails.values())
      for (const frame of record.frames) URL.revokeObjectURL(frame.url);
    state.thumbnails.clear();
    thumbnailQueue.length = 0;
  }

  // ------------------------------------------------------- preview elements

  function runtimeForClip(clip, customMap = null) {
    if (!clip || clip.kind === 'title') return null;
    if (customMap) return customMap.get(clip.id) || null;
    const existing = state.clipElements.get(clip.id);
    if (existing && existing.assetId === clip.assetId && existing.clipKind === clip.kind)
      return existing;
    if (existing) {
      releaseElement(existing);
      state.clipElements.delete(clip.id);
    }
    const assetRuntime = state.runtimeAssets.get(clip.assetId);
    if (!assetRuntime) return null;
    if (clip.kind === 'image') {
      const entry = {
        element: assetRuntime.image,
        kind: 'image',
        clipKind: clip.kind,
        assetId: clip.assetId,
      };
      state.clipElements.set(clip.id, entry);
      return entry;
    }
    // Pictures come from muted video elements; sound comes only from audio clips
    // (an audio element can play the sound of a video file).
    const element = document.createElement(clip.kind === 'video' ? 'video' : 'audio');
    element.src = assetRuntime.objectUrl;
    element.preload = 'auto';
    element.playsInline = true;
    element.muted = clip.kind === 'video';
    // Premiere's default for speed changes is that pitch follows speed; match it here and in export.
    try {
      element.preservesPitch = false;
    } catch (_) {}
    const entry = {
      element,
      kind: clip.kind,
      clipKind: clip.kind,
      assetId: clip.assetId,
      audioNode: null,
    };
    const refreshPreviewAfterDecode = () => {
      if (state.playing || state.rendering || state.clipElements.get(clip.id) !== entry) return;
      requestAnimationFrame(() => {
        if (state.playing || state.rendering || state.clipElements.get(clip.id) !== entry) return;
        renderPreview();
      });
    };
    element.addEventListener('loadeddata', refreshPreviewAfterDecode);
    element.addEventListener('seeked', refreshPreviewAfterDecode);
    state.clipElements.set(clip.id, entry);
    return entry;
  }

  // ------------------------------------------------------------ audio graph

  function dbToGain(db) {
    return Math.pow(10, (Number(db) || 0) / 20);
  }

  // Sound level of an audio clip at a timeline time: clip volume keyframes, fades,
  // clip gain, crossfades, and track mute/solo. (Track volume/pan apply per track.)
  function clipAudioGain(clip, time, audible = Edit.audibleTrackIds(state.project)) {
    if (!clip || clip.kind !== 'audio' || clip.muted || !audible.has(clip.track)) return 0;
    const nominal = time >= clip.start && time < clip.start + clip.duration;
    const fades = nominal ? timelineCore.fadeEnvelope(clip, time) : 1;
    const automation = audioAutomationCore.resolveAtTime(
      clip,
      clamp(time, clip.start, clip.start + clip.duration),
    );
    const crossfade = transitionCore.audioTransitionGain(
      clip,
      time,
      state.project.clips,
      state.project.assets,
    );
    return Math.max(0, automation * fades * dbToGain(clip.gain) * crossfade);
  }

  function ensureAudioGraph() {
    if (state.audio) return state.audio;
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return null;
    try {
      const context = new Context({ latencyHint: 'playback' });
      const master = context.createGain();
      const splitter = context.createChannelSplitter(2);
      const meters = [context.createAnalyser(), context.createAnalyser()];
      for (const analyser of meters) analyser.fftSize = 1024;
      master.connect(context.destination);
      master.connect(splitter);
      splitter.connect(meters[0], 0);
      splitter.connect(meters[1], 1);
      state.audio = {
        context,
        master,
        meters,
        tracks: new Map(),
        buffer: new Float32Array(1024),
        peaks: [0, 0],
        holds: [0, 0],
      };
    } catch (error) {
      console.warn('AlcorVideo preview audio graph unavailable:', error);
      state.audio = null;
    }
    return state.audio;
  }

  function trackAudioNode(trackId) {
    const graph = state.audio;
    if (!graph) return null;
    let node = graph.tracks.get(trackId);
    if (!node) {
      const gain = graph.context.createGain();
      const panner =
        typeof graph.context.createStereoPanner === 'function'
          ? graph.context.createStereoPanner()
          : null;
      if (panner) {
        gain.connect(panner);
        panner.connect(graph.master);
      } else gain.connect(graph.master);
      node = { gain, panner };
      graph.tracks.set(trackId, node);
    }
    const track = getTrack(trackId);
    node.gain.gain.value = track ? dbToGain(track.volume) : 1;
    if (node.panner) node.panner.pan.value = track ? clamp(track.pan, -1, 1) : 0;
    return node;
  }

  function connectClipAudio(clip, entry) {
    const graph = state.audio;
    if (!graph || !entry || entry.kind !== 'audio') return null;
    if (!entry.audioNode) {
      try {
        const source = graph.context.createMediaElementSource(entry.element);
        const gain = graph.context.createGain();
        const panner =
          typeof graph.context.createStereoPanner === 'function'
            ? graph.context.createStereoPanner()
            : null;
        if (panner) gain.connect(panner);
        entry.audioNode = { source, gain, panner, trackId: '', fxKey: null, fxNodes: [] };
        entry.element.volume = 1;
        entry.element.muted = false;
      } catch (error) {
        entry.audioNode = { failed: true };
      }
    }
    const node = entry.audioNode;
    if (node.failed) return null;
    wireClipEffects(node, clip, graph);
    if (node.trackId !== clip.track) {
      const out = node.panner || node.gain;
      try {
        out.disconnect();
      } catch (_) {}
      out.connect(trackAudioNode(clip.track).gain);
      node.trackId = clip.track;
    }
    if (node.panner) node.panner.pan.value = clamp(clip.pan, -1, 1);
    return node;
  }

  // Source -> (5.1 downmix) -> clip audio effects -> clip gain. Rewired when the effects change.
  function wireClipEffects(node, clip, graph) {
    const fx = window.AlcorVideoAudioFx || null;
    const channels = Number(getAsset(clip.assetId)?.channels) || 2;
    const key = JSON.stringify([clip.audioFx || null, Boolean(fx), channels]);
    if (node.fxKey === key) return;
    if ((clip.audioFx || channels > 2) && !fx) loadGroup('effects');
    try {
      node.source.disconnect();
    } catch (_) {}
    for (const item of node.fxNodes) {
      try {
        item.disconnect();
      } catch (_) {}
    }
    node.fxNodes = [];
    let head = node.source;
    try {
      const downmix = fx && channels > 2 ? fx.buildDownmix(graph.context, channels) : null;
      if (downmix) {
        head.connect(downmix.input);
        head = downmix.output;
        node.fxNodes.push(downmix.input, downmix.output);
      }
      if (fx && clip.audioFx) {
        const chain = fx.buildChain(graph.context, clip.audioFx);
        head.connect(chain.input);
        head = chain.output;
        node.fxNodes.push(chain.input, ...chain.nodes);
      }
    } catch (error) {
      console.warn('AlcorVideo audio effects unavailable in preview:', error);
    }
    head.connect(node.gain);
    node.fxKey = key;
  }

  function refreshTrackAudio() {
    if (!state.audio) return;
    for (const track of state.project.tracks) if (track.kind === 'audio') trackAudioNode(track.id);
  }

  function updateMeters() {
    const graph = state.audio;
    if (!graph || !elements.meterL || !elements.meterR) return;
    [elements.meterL, elements.meterR].forEach((meter, channel) => {
      graph.meters[channel].getFloatTimeDomainData(graph.buffer);
      let peak = 0;
      for (const sample of graph.buffer) peak = Math.max(peak, Math.abs(sample));
      graph.peaks[channel] = Math.max(peak, graph.peaks[channel] * 0.9);
      const db = graph.peaks[channel] > 0 ? 20 * Math.log10(graph.peaks[channel]) : -Infinity;
      const level = Number.isFinite(db) ? clamp((db + 60) / 60, 0, 1) : 0;
      meter.style.setProperty('--av-meter-level', level.toFixed(3));
      meter.classList.toggle('is-clipping', peak >= 0.999);
      meter.setAttribute('aria-valuenow', Number.isFinite(db) ? db.toFixed(1) : '-60');
    });
  }

  function resetMeters() {
    for (const meter of [elements.meterL, elements.meterR]) {
      meter?.style?.setProperty('--av-meter-level', '0');
      meter?.classList?.remove('is-clipping');
    }
    if (state.audio) state.audio.peaks = [0, 0];
  }

  // ------------------------------------------------------------- clip edits

  function baseClip(asset, track, start, extra = {}) {
    return {
      id: uid('clip'),
      kind: asset.kind,
      assetId: asset.id,
      name: asset.name.replace(/\.[^.]+$/, ''),
      track,
      start: round(start),
      duration: 1,
      in: 0,
      speed: 1,
      opacity: 1,
      volume: 1,
      muted: false,
      gain: 0,
      pan: 0,
      fadeIn: 0,
      fadeOut: 0,
      ...transformCore.normalizeTransform({}),
      transformKeyframes: [],
      volumeKeyframes: [],
      crossDissolve: null,
      ...colorCore.neutralColor(),
      ...extra,
    };
  }

  // Build the clips a bin item puts on the timeline: a picture, and for video with
  // sound a linked audio clip, like Premiere. sourceIn/sourceOut select a range.
  function clipsFromAsset(asset, options = {}) {
    const duration =
      asset.kind === 'image'
        ? 5
        : Math.max(
            MIN_CLIP_DURATION,
            (Number(options.sourceOut) || asset.duration || 5) - (Number(options.sourceIn) || 0),
          );
    const start = round(options.start || 0);
    const sourceIn = asset.kind === 'image' ? 0 : round(Number(options.sourceIn) || 0);
    const clipWindow = editorCore.normalizeClipWindow(start, duration, MIN_CLIP_DURATION);
    const primaryTrack = options.track || defaultTrackFor(asset.kind);
    const primary = baseClip(asset, primaryTrack, clipWindow.start, {
      duration: clipWindow.duration,
      in: sourceIn,
    });
    const clips = [primary];
    if (asset.kind === 'video' && asset.hasAudio !== false && options.withAudio !== false) {
      const audioTrack = options.audioTrack || defaultTrackFor('audio');
      const linkId = uid('link');
      primary.linkId = linkId;
      clips.push(
        baseClip({ ...asset, kind: 'audio' }, audioTrack, clipWindow.start, {
          duration: clipWindow.duration,
          in: sourceIn,
          linkId,
        }),
      );
    }
    return clips;
  }

  function addAssetToTrack(assetId, track) {
    const asset = getAsset(assetId);
    if (!asset) return;
    if (state.project.clips.length >= LIMITS.maxClips - 1) {
      setStatus(`This project supports at most ${LIMITS.maxClips} clips`);
      return;
    }
    const kind = asset.kind === 'audio' ? 'audio' : 'video';
    if (!getTrack(track) || Edit.trackKind(track) !== kind) track = defaultTrackFor(asset.kind);
    if (getTrack(track)?.locked) {
      setStatus(`${track} is locked`);
      return;
    }
    const endOnTrack = state.project.clips
      .filter((clip) => clip.track === track)
      .reduce((max, clip) => Math.max(max, clip.start + clip.duration), 0);
    const audioTrack = defaultTrackFor('audio');
    const endOnAudio = state.project.clips
      .filter((clip) => clip.track === audioTrack)
      .reduce((max, clip) => Math.max(max, clip.start + clip.duration), 0);
    const start =
      asset.kind === 'video' && asset.hasAudio !== false && kind === 'video'
        ? Math.max(endOnTrack, endOnAudio)
        : endOnTrack;
    const clips = clipsFromAsset(asset, { track, start });
    if (clips.some((clip) => getTrack(clip.track)?.locked)) {
      setStatus('Unlock the target tracks first');
      return;
    }
    mutate('Clip added', () => {
      for (const clip of clips) Edit.placeClip(state.project, clip, { makeId: uid });
      selectIds([clips[0].id], clips[0].id);
      state.currentTime = clips[0].start;
    });
    setStatus(
      `${asset.name} added to ${track}${clips.length > 1 ? ` with linked audio on ${clips[1].track}` : ''}`,
    );
  }

  function addTitle(presetName = 'caption', overrides = null) {
    if (state.project.clips.length >= LIMITS.maxClips) {
      setStatus(`This project supports at most ${LIMITS.maxClips} clips`);
      return;
    }
    const preset = TITLE_PRESETS[presetName] || TITLE_PRESETS.caption;
    const start = round(state.currentTime);
    const end = start + 3;
    const occupied = (trackId) =>
      state.project.clips.some(
        (clip) =>
          clip.track === trackId &&
          clip.start < end - 0.0015 &&
          clip.start + clip.duration > start + 0.0015,
      );
    // Like Premiere, a new title goes on the first free video track from V2 up, so it never covers existing work.
    const videoTracks = state.project.tracks
      .filter((item) => item.kind === 'video' && !item.locked)
      .sort((a, b) => Edit.trackNumber(a.id) - Edit.trackNumber(b.id));
    const preferred = defaultTrackFor('title');
    let track =
      videoTracks
        .filter((item) => Edit.trackNumber(item.id) >= Edit.trackNumber(preferred))
        .find((item) => !occupied(item.id))?.id || '';
    let addedTrack = null;
    if (!track) {
      const added = Edit.addTrack(JSON.parse(JSON.stringify(state.project)), 'video');
      if (added.ok) addedTrack = added.trackId;
      track = addedTrack || preferred;
    }
    if (getTrack(track)?.locked) {
      setStatus(`${track} is locked`);
      return;
    }
    const title = {
      id: uid('title'),
      kind: 'title',
      name: preset.name === 'Caption' ? 'Title' : preset.name,
      track,
      start,
      duration: 3,
      text: preset.text,
      size: preset.size,
      x: preset.x,
      y: preset.y,
      align: preset.align,
      font: preset.font,
      color: preset.color,
      background: preset.background,
      backgroundOpacity: preset.backgroundOpacity,
      bold: preset.bold,
      italic: preset.italic,
      stroke: preset.stroke,
      strokeWidth: preset.strokeWidth,
      shadow: preset.shadow,
      fadeIn: 0,
      fadeOut: 0,
      transformKeyframes: [],
      crossDissolve: null,
      ...(overrides || {}),
    };
    mutate('Title added', () => {
      if (addedTrack) Edit.addTrack(state.project, 'video');
      Edit.placeClip(state.project, title, { makeId: uid });
      selectIds([title.id], title.id);
    });
    setStatus(`${title.name} added on ${track}`);
  }

  // The sample project: a short clip made in-house from this site's own art, shipped as a
  // same-origin script (the editor makes no network requests) and imported like any file.
  async function loadSampleProject() {
    if (state.projectIO || state.importing || state.rendering) {
      setStatus('Wait for the current operation to finish.');
      return;
    }
    setStatus('Loading the sample project…');
    // H.264 where the browser plays it, else the VP9/Opus copy (open-source Chromium has no H.264).
    const playsMp4 = Boolean(
      document.createElement('video').canPlayType?.('video/mp4; codecs="avc1.64001F, mp4a.40.2"'),
    );
    const loadSample = async (webm) => {
      const key = webm ? 'AlcorVideoSampleWebm' : 'AlcorVideoSample';
      if (!window[key]) await loadGroup(webm ? 'sample-webm' : 'sample');
      return window[key];
    };
    const importSample = async (sample) => {
      const binary = atob(sample.base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1)
        bytes[index] = binary.charCodeAt(index);
      await importMedia(
        [new File([bytes], sample.name, { type: sample.type, lastModified: 0 })],
        null,
        true,
      );
      return (
        state.project.assets.find(
          (item) => item.name === sample.name && state.runtimeAssets.has(item.id),
        ) || null
      );
    };
    let sample = await loadSample(!playsMp4);
    if (!sample || !sample.base64) sample = await loadSample(playsMp4); // whichever copy this install has
    if (!sample || !sample.base64) {
      setStatus('The sample project is not available in this copy of the editor.');
      return;
    }
    let asset = await importSample(sample);
    if (!asset && sample.type === 'video/mp4') {
      // The MP4 imported but could not be decoded here: try the WebM copy once.
      const webm = await loadSample(true);
      if (webm && webm.base64) {
        sample = webm;
        asset = await importSample(webm);
      }
    }
    if (!asset) return;
    if (!state.project.clips.some((clip) => clip.assetId === asset.id)) {
      addAssetToTrack(asset.id, defaultTrackFor(asset.kind));
      seek(0);
      // A lower third on its own backing box, clear of the cover art's headline.
      addTitle('lower-third', {
        name: 'Title',
        y: 86,
        text: `${sample.title || 'Made in AlcorVideo'}\nYour footage never leaves this device`,
        duration: 3,
        fadeIn: 0,
        fadeOut: 0.5,
      });
      if (state.project.name === 'Untitled project') {
        if (elements.projectName) {
          elements.projectName.value = 'Sample project';
          elements.projectName.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      renderAll();
    }
    setStatus('Sample project ready · press Space to play, or drop your own media');
  }

  function targetIds(ids = [...state.selection]) {
    return state.linkedSelection ? [...Edit.linkedIds(state.project, ids)] : ids;
  }

  function deleteGapSelection() {
    const gap = state.gap;
    state.gap = null;
    let result = null;
    mutate('Ripple delete gap', () => {
      result = Edit.deleteGap(state.project, gap.track, gap.time);
      return result.ok;
    });
    setStatus(
      result && result.ok
        ? `Closed ${formatClock(result.closed, true)} on ${gap.track}`
        : result?.reason || 'The gap could not close',
    );
    renderTimeline();
  }

  // Delete leaves a gap (Premiere "Clear"); Shift+Delete ripples.
  function deleteSelection() {
    const ids = targetIds();
    if (!ids.length && state.gap) {
      deleteGapSelection();
      return;
    }
    if (!ids.length) return;
    const clips = state.project.clips.filter((clip) => ids.includes(clip.id));
    if (clips.some((clip) => getTrack(clip.track)?.locked)) {
      setStatus('Unlock the track before deleting from it');
      return;
    }
    mutate(clips.length === 1 ? 'Selection deleted' : `${clips.length} clips deleted`, () => {
      const set = new Set(ids);
      state.project.clips = state.project.clips.filter((item) => !set.has(item.id));
      for (const clip of state.project.clips)
        if (clip.crossDissolve && set.has(clip.crossDissolve.outgoingId)) clip.crossDissolve = null;
      selectIds([]);
      pruneClipElements();
    });
    setStatus(clips.length === 1 ? `${clips[0].name} removed` : `${clips.length} clips removed`);
  }

  function rippleDeleteSelection() {
    const ids = [...state.selection];
    if (!ids.length && state.gap) {
      deleteGapSelection();
      return;
    }
    if (!ids.length) {
      setStatus('Select a clip to ripple delete');
      return;
    }
    let result = null;
    mutate('Ripple delete', () => {
      result = Edit.rippleDelete(state.project, ids, { ignoreLinks: !state.linkedSelection });
      if (!result.ok) return false;
      selectIds([]);
      pruneClipElements();
      return true;
    });
    setStatus(
      result && result.ok
        ? `Ripple delete closed ${formatClock(result.closed, true)}`
        : result?.reason || 'Nothing to ripple delete',
    );
  }

  function duplicateSelection() {
    const clip = getClip();
    if (!clip) return;
    if (state.project.clips.length >= LIMITS.maxClips) {
      setStatus(`This project supports at most ${LIMITS.maxClips} clips`);
      return;
    }
    const copy = JSON.parse(JSON.stringify(clip));
    copy.id = uid(clip.kind === 'title' ? 'title' : 'clip');
    copy.name = `${clip.name} copy`;
    delete copy.linkId;
    copy.crossDissolve = null;
    Object.assign(
      copy,
      editorCore.normalizeClipWindow(
        clip.start + clip.duration,
        clip.duration,
        clip.kind === 'title' ? 0.1 : MIN_CLIP_DURATION,
      ),
    );
    mutate('Clip duplicated', () => {
      Edit.placeClip(state.project, copy, { makeId: uid });
      selectIds([copy.id], copy.id);
      state.currentTime = copy.start;
    });
    setStatus(`${clip.name} duplicated`);
  }

  // Split / Add Edit (Ctrl+K): cut the selected clips at the playhead, or every
  // unlocked track when nothing is selected.
  function splitSelection(options = {}) {
    const splitAt = round(state.currentTime);
    const clip = getClip();
    if (!clip && !options.allTracks && !state.selection.size) {
      const anyUnder = state.project.clips.some(
        (item) =>
          item.start + MIN_CLIP_DURATION < splitAt &&
          item.start + item.duration - MIN_CLIP_DURATION > splitAt,
      );
      if (!anyUnder) {
        setStatus('Select a clip before splitting');
        return;
      }
    }
    if (
      clip &&
      !options.allTracks &&
      (splitAt <= clip.start + MIN_CLIP_DURATION ||
        splitAt >= clip.start + clip.duration - MIN_CLIP_DURATION)
    ) {
      setStatus('Move the playhead inside the selected clip');
      return;
    }
    if (state.project.clips.length >= LIMITS.maxClips) {
      setStatus(`This project supports at most ${LIMITS.maxClips} clips`);
      return;
    }
    let result = null;
    mutate('Clip split', () => {
      const scoped = !options.allTracks && state.selection.size;
      result = Edit.razor(state.project, splitAt, {
        makeId: uid,
        clipIds: scoped ? [...state.selection] : null,
        ignoreLinks: !state.linkedSelection,
      });
      if (!result.ok) return false;
      const right = getClip(result.created[0]);
      if (right && scoped) selectIds([right.id], right.id);
      return true;
    });
    if (!result || !result.ok) {
      setStatus(result?.reason || 'Move the playhead farther from the clip edge');
      return;
    }
    setStatus(
      `${clip ? clip.name : `${result.created.length} clip${result.created.length === 1 ? '' : 's'}`} split at ${formatClock(splitAt, true)}`,
    );
  }

  function razorAt(clipId, time, allTracks = false) {
    const at = state.snap ? snapTimeTo(time) : snapToFrame(time);
    let result = null;
    mutate('Razor cut', () => {
      result = Edit.razor(state.project, at, {
        makeId: uid,
        clipIds: allTracks ? null : [clipId],
        ignoreLinks: !state.linkedSelection,
      });
      return result.ok;
    });
    setStatus(
      result && result.ok
        ? `Cut at ${formatClock(at, true)}`
        : result?.reason || 'Cannot cut there',
    );
  }

  function edgeClipAtPlayhead(direction) {
    // Clip under the playhead on the first targeted (selected or topmost unlocked) track.
    const time = state.currentTime;
    const pool = state.selection.size ? selectedClips() : state.project.clips;
    return (
      pool
        .filter(
          (clip) =>
            !getTrack(clip.track)?.locked &&
            clip.start < time - 0.0005 &&
            clip.start + clip.duration > time + 0.0005,
        )
        .sort((a, b) => Edit.trackNumber(b.track) - Edit.trackNumber(a.track))[0] || null
    );
  }

  // Q / W: ripple trim the previous or next edit to the playhead.
  function rippleTrimToPlayhead(edge) {
    const clip = edgeClipAtPlayhead();
    if (!clip) {
      setStatus('Put the playhead over a clip first');
      return;
    }
    const time = round(state.currentTime);
    const delta = edge === 'start' ? time - clip.start : time - (clip.start + clip.duration);
    let result = null;
    mutate(edge === 'start' ? 'Ripple trim previous edit' : 'Ripple trim next edit', () => {
      const partners = state.linkedSelection
        ? [...Edit.linkedIds(state.project, [clip.id])].filter((id) => id !== clip.id)
        : [];
      result = Edit.rippleTrim(state.project, clip.id, edge, delta, { alsoTrim: partners });
      return Boolean(result && result.ok);
    });
    if (edge === 'start' && result && result.ok) state.currentTime = clip.start;
    renderPreview();
    setStatus(
      result && result.ok ? 'Ripple trimmed to the playhead' : result?.reason || 'Nothing to trim',
    );
  }

  function nudgeSelection(frames) {
    const ids = [...state.selection];
    if (!ids.length) return;
    let result = null;
    mutate('Nudge', () => {
      result = Edit.moveClips(state.project, ids, frames / fps(), {
        makeId: uid,
        ignoreLinks: !state.linkedSelection,
      });
      return result.ok;
    });
    if (result && !result.ok) setStatus(result.reason);
  }

  function copySelection() {
    const ids = targetIds();
    if (!ids.length) {
      setStatus('Select clips to copy');
      return;
    }
    const clips = state.project.clips
      .filter((clip) => ids.includes(clip.id))
      .map((clip) => JSON.parse(JSON.stringify(clip)));
    const origin = Math.min(...clips.map((clip) => clip.start));
    state.clipboard = { origin, clips };
    setStatus(`${clips.length} clip${clips.length === 1 ? '' : 's'} copied`);
  }

  function pasteClipboard(insert = false) {
    if (!state.clipboard) {
      setStatus('Copy clips first');
      return;
    }
    if (state.project.clips.length + state.clipboard.clips.length > LIMITS.maxClips) {
      setStatus(`This project supports at most ${LIMITS.maxClips} clips`);
      return;
    }
    const at = round(state.currentTime);
    const links = new Map();
    const clips = state.clipboard.clips.map((source) => {
      const clip = JSON.parse(JSON.stringify(source));
      clip.id = uid(clip.kind === 'title' ? 'title' : 'clip');
      clip.start = round(at + source.start - state.clipboard.origin);
      clip.crossDissolve = null;
      if (clip.linkId) {
        if (!links.has(clip.linkId)) links.set(clip.linkId, uid('link'));
        clip.linkId = links.get(clip.linkId);
      }
      if (!getTrack(clip.track)) clip.track = defaultTrackFor(clip.kind);
      return clip;
    });
    let result = null;
    mutate(insert ? 'Paste insert' : 'Paste', () => {
      result = insert
        ? Edit.insertEdit(state.project, clips, at, { makeId: uid })
        : Edit.overwriteEdit(state.project, clips, at, { makeId: uid });
      if (!result.ok) return false;
      selectIds(
        clips.map((clip) => clip.id),
        clips[0].id,
      );
      return true;
    });
    setStatus(
      result && result.ok
        ? `${clips.length} clip${clips.length === 1 ? '' : 's'} pasted`
        : result?.reason || 'Paste failed',
    );
  }

  function toggleLink() {
    const ids = [...state.selection];
    if (!ids.length) return;
    const linked = selectedClips().some((clip) => clip.linkId);
    let result = null;
    mutate(linked ? 'Unlink' : 'Link', () => {
      result = linked
        ? Edit.unlinkClips(state.project, ids)
        : Edit.linkClips(state.project, ids, uid);
      return result.ok;
    });
    setStatus(
      result && result.ok
        ? linked
          ? 'Clips unlinked'
          : 'Clips linked'
        : result?.reason || 'Select clips to link',
    );
  }

  function setClipSpeed(value, ripple) {
    const clip = getClip();
    if (!clip) return;
    let result = null;
    mutate('Speed/Duration', () => {
      const ids = state.linkedSelection ? [...Edit.linkedIds(state.project, [clip.id])] : [clip.id];
      for (const id of ids) {
        const outcome = Edit.setSpeed(state.project, id, value, { ripple });
        if (id === clip.id) result = outcome;
      }
      return Boolean(result && result.ok);
    });
    setStatus(
      result && result.ok
        ? `Speed ${Math.round(result.speed * 100)}% · ${formatClock(result.duration, true)}`
        : result?.reason || 'Speed unchanged',
    );
  }

  function setClipReverse(reverse) {
    const clip = getClip();
    if (!clip) return;
    let result = null;
    mutate(reverse ? 'Reverse speed' : 'Forward speed', () => {
      const ids = state.linkedSelection ? [...Edit.linkedIds(state.project, [clip.id])] : [clip.id];
      for (const id of ids) {
        const outcome = Edit.setReverse(state.project, id, reverse);
        if (id === clip.id) result = outcome;
      }
      return Boolean(result && result.ok);
    });
    if (result && !result.ok) setStatus(result.reason);
    else if (result)
      setStatus(
        reverse
          ? 'Clip plays in reverse (preview steps frames; export is frame-accurate)'
          : 'Clip plays forward',
      );
  }

  function frameHold(insert = false) {
    const clip = getClip();
    if (!clip || clip.kind !== 'video') {
      setStatus('Select a video clip for a frame hold');
      return;
    }
    let result = null;
    mutate(insert ? 'Insert frame hold segment' : 'Add frame hold', () => {
      result = insert
        ? Edit.insertFrameHold(state.project, clip.id, state.currentTime, 2, uid)
        : Edit.addFrameHold(state.project, clip.id, state.currentTime, uid);
      return result.ok;
    });
    setStatus(
      result && result.ok
        ? insert
          ? 'Two-second frame hold inserted'
          : `Frame hold from ${formatClock(state.currentTime, true)}`
        : result?.reason || 'Frame hold failed',
    );
  }

  // ------------------------------------------------------------ transitions

  function emitTransitionResult(ok, message, plan = null) {
    root.dispatchEvent(
      new CustomEvent('alcorvideo:transition-result', {
        detail: { ok: Boolean(ok), message: String(message || ''), plan },
      }),
    );
  }

  function transitionLabel(type) {
    return (VISUAL_TRANSITIONS.concat(AUDIO_TRANSITIONS).find(([id]) => id === type) || [
      type,
      'Cross Dissolve',
    ])[1];
  }

  root.addEventListener('alcorvideo:transition-command', (event) => {
    const action = String(event.detail?.action || '');
    const supported = [
      'fade-through-background',
      'clear-fade-through-background',
      'cross-dissolve',
      'clear-cross-dissolve',
    ];
    if (!supported.includes(action)) return;
    const selected = getClip();
    if (action === 'clear-cross-dissolve') {
      if (!selected || !selected.crossDissolve) {
        const message = 'Select the incoming clip with a Cross Dissolve first.';
        setStatus(message);
        emitTransitionResult(false, message);
        return;
      }
      const changed = mutate('Transition cleared', () => {
        selected.crossDissolve = null;
      });
      const message = changed ? 'Cross Dissolve cleared' : 'Cross Dissolve was already clear';
      setStatus(message);
      emitTransitionResult(changed, message);
      return;
    }
    const isCrossDissolve = action === 'cross-dissolve';
    const requestedType = String(event.detail?.type || '');
    const plan = isCrossDissolve
      ? transitionCore.planCrossDissolve(
          state.project.clips,
          state.project.assets,
          state.selectedId,
          event.detail?.duration,
          state.project.fps,
          requestedType,
        )
      : transitionCore.planFadeThroughBackground(
          state.project.clips,
          state.selectedId,
          event.detail?.duration,
          state.project.fps,
        );
    if (!plan.ok) {
      setStatus(plan.reason);
      emitTransitionResult(false, plan.reason, plan);
      return;
    }
    const outgoing = getClip(plan.outgoingId);
    const incoming = getClip(plan.incomingId);
    if (!outgoing || !incoming) {
      const message = 'The cut changed before the transition could be applied.';
      setStatus(message);
      emitTransitionResult(false, message, plan);
      return;
    }
    const clearingFade = action === 'clear-fade-through-background';
    const type = plan.transitionType || 'cross-dissolve';
    const label = isCrossDissolve
      ? `${transitionLabel(type)} transition`
      : clearingFade
        ? 'Cut transition cleared'
        : 'Fade-through-background transition';
    const changed = mutate(label, () => {
      if (isCrossDissolve) {
        outgoing.fadeOut = 0;
        incoming.fadeIn = 0;
        incoming.crossDissolve =
          type === 'cross-dissolve'
            ? { outgoingId: plan.outgoingId, duration: plan.duration }
            : { outgoingId: plan.outgoingId, duration: plan.duration, type };
      } else {
        outgoing.fadeOut = clearingFade ? 0 : plan.duration;
        incoming.fadeIn = clearingFade ? 0 : plan.duration;
        if (!clearingFade) incoming.crossDissolve = null;
      }
    });
    const message = isCrossDissolve
      ? `${type === 'cross-dissolve' ? 'Cross Dissolve' : transitionLabel(type)} · ${plan.duration.toFixed(2)}s centered at ${formatClock(plan.cutTime, true)}`
      : clearingFade
        ? changed
          ? 'Cut fades cleared'
          : 'Cut fades were already clear'
        : `Fade through background · ${plan.duration.toFixed(2)}s at ${formatClock(plan.cutTime, true)}`;
    setStatus(message);
    emitTransitionResult(changed || clearingFade, message, plan);
  });

  // Apply a transition to the cut at the playhead (Ctrl+D video, Ctrl+Shift+D audio),
  // or to the selected incoming clip.
  function applyDefaultTransition(kind, type = '') {
    let incoming = getClip();
    const wanted = kind === 'audio' ? 'audio' : 'visual';
    const matches = (clip) =>
      clip &&
      (wanted === 'audio' ? clip.kind === 'audio' : clip.kind === 'video' || clip.kind === 'image');
    if (!matches(incoming)) {
      const time = state.currentTime;
      const tolerance = Math.max(0.5 / fps(), 0.02);
      incoming =
        state.project.clips
          .filter((clip) => matches(clip) && Math.abs(clip.start - time) <= tolerance)
          .sort((a, b) => Edit.trackNumber(a.track) - Edit.trackNumber(b.track))[0] || null;
    }
    if (!incoming) {
      setStatus(
        kind === 'audio'
          ? 'Select the incoming audio clip or park the playhead on an audio cut'
          : 'Select the incoming clip or park the playhead on a cut',
      );
      return;
    }
    state.selectedId = incoming.id;
    const transitionType = type || (kind === 'audio' ? 'constant-power' : 'cross-dissolve');
    // Default length is one second, shortened to the source handles the cut actually has.
    const probe = transitionCore.planCrossDissolve(
      state.project.clips,
      state.project.assets,
      incoming.id,
      1,
      state.project.fps,
      transitionType,
    );
    const duration =
      !probe.ok && probe.maxDuration >= transitionCore.MIN_TRANSITION_SECONDS
        ? probe.maxDuration
        : 1;
    root.dispatchEvent(
      new CustomEvent('alcorvideo:transition-command', {
        detail: { action: 'cross-dissolve', duration, type: transitionType },
      }),
    );
  }

  // -------------------------------------------------------------- selection

  function selectIds(ids, primary = ids[ids.length - 1] || null) {
    settleLive();
    const set = new Set(ids.filter((id) => getClip(id)));
    if (state.linkedSelection && set.size)
      for (const id of Edit.linkedIds(state.project, [...set])) set.add(id);
    state.selection = set;
    state.selectedId = primary && set.has(primary) ? primary : null;
  }

  function selectClip(id, options = {}) {
    settleLive();
    if (id) state.gap = null;
    if (options.additive && id && getClip(id)) {
      const next = new Set(state.selection);
      const group = state.linkedSelection ? [...Edit.linkedIds(state.project, [id])] : [id];
      const removing = next.has(id);
      for (const item of group) removing ? next.delete(item) : next.add(item);
      state.selection = next;
      state.selectedId = removing ? [...next].pop() || null : id;
    } else {
      selectIds(id && getClip(id) ? [id] : [], id);
    }
    renderTimeline();
    renderInspector();
    emitTransformKeyframeState();
    emitVolumeKeyframeState();
  }

  function mediaAvailableDuration(clip) {
    if (!isMediaClip(clip) || clip.kind === 'image' || clip.hold != null) return Infinity;
    const asset = getAsset(clip.assetId);
    if (!asset || !asset.duration) return Infinity;
    return Math.max(MIN_CLIP_DURATION, (asset.duration - clip.in) / clip.speed);
  }

  function snapTolerance() {
    return Math.max(0.03, 9 / state.pxPerSecond);
  }

  function snapTimeTo(time, except = new Set()) {
    const value = clamp(time, 0, LIMITS.maxProjectSeconds);
    if (!state.snap) return snapToFrame(value);
    const targets = Edit.snapTargets(state.project, { playhead: state.currentTime, except });
    const snapped = Edit.snap(value, targets, snapTolerance());
    return snapped.snapped ? snapped.time : snapToFrame(value);
  }

  // ------------------------------------------------------------- keyframes

  function localClipTime(clip, timelineTime = state.currentTime) {
    return clamp(timelineTime - clip.start, 0, clip.duration);
  }

  function emitTransformKeyframeState(clip = getClip()) {
    if (!clip || (clip.kind !== 'video' && clip.kind !== 'image')) {
      root.dispatchEvent(
        new CustomEvent('alcorvideo:transform-keyframe-state', {
          detail: { kind: clip?.kind || '' },
        }),
      );
      return;
    }
    const localTime = localClipTime(clip);
    const frames = transformCore.normalizeKeyframes(clip.transformKeyframes, clip.duration);
    const tolerance = Math.max(0.02, 1 / Math.max(1, state.project.fps));
    root.dispatchEvent(
      new CustomEvent('alcorvideo:transform-keyframe-state', {
        detail: {
          kind: clip.kind,
          localTime,
          count: frames.length,
          atKeyframe: Boolean(
            transformCore.findKeyframeAtTime(frames, localTime, clip.duration, tolerance),
          ),
          transform: transformCore.resolveTransformAtTime(clip, state.currentTime),
          ease: transformCore.easeAt
            ? transformCore.easeAt(frames, localTime, clip.duration)
            : 'linear',
        },
      }),
    );
  }

  function setMotionValue(clip, name, value) {
    const frames = transformCore.normalizeKeyframes(clip.transformKeyframes, clip.duration);
    if (!frames.length) {
      clip[name] = value;
      return;
    }
    const transform = transformCore.resolveTransformAtTime(clip, state.currentTime);
    transform[name] = value;
    clip.transformKeyframes = transformCore.upsertKeyframe(
      frames,
      {
        time: localClipTime(clip),
        ...transform,
      },
      clip.duration,
    );
  }

  root.addEventListener('alcorvideo:transform-keyframe-command', (event) => {
    const clip = getClip();
    const action = String(event.detail?.action || '');
    if (!clip || (clip.kind !== 'video' && clip.kind !== 'image')) return;
    const localTime = localClipTime(clip);
    const frames = transformCore.normalizeKeyframes(clip.transformKeyframes, clip.duration);
    const tolerance = Math.max(0.02, 1 / Math.max(1, state.project.fps));
    if (action === 'upsert') {
      const transform = transformCore.resolveTransformAtTime(clip, state.currentTime);
      mutate('Motion keyframe updated', () => {
        clip.transformKeyframes = transformCore.upsertKeyframe(
          frames,
          { time: localTime, ...transform },
          clip.duration,
        );
      });
      setStatus(`Motion keyframe saved at ${formatClock(state.currentTime, true)}`);
    } else if (action === 'remove') {
      const next = transformCore.removeKeyframe(frames, localTime, clip.duration, tolerance);
      if (next.length === frames.length) {
        setStatus('Move the playhead onto a motion keyframe first');
        return;
      }
      mutate('Motion keyframe removed', () => {
        clip.transformKeyframes = next;
      });
      setStatus('Motion keyframe removed');
    } else if (action === 'ease' && frames.length && transformCore.setKeyframeEase) {
      const ease = String(event.detail?.ease || 'linear');
      mutate('Keyframe easing', () => {
        clip.transformKeyframes = transformCore.setKeyframeEase(
          frames,
          localTime,
          clip.duration,
          ease,
          tolerance,
        );
      });
      setStatus(`Keyframe easing: ${ease.replace(/-/g, ' ')}`);
    } else if (action === 'clear' && frames.length) {
      const resolved = transformCore.resolveTransformAtTime(clip, state.currentTime);
      mutate('Motion cleared', () => {
        clip.transformKeyframes = [];
        Object.assign(clip, resolved);
      });
      setStatus('Motion keyframes cleared; current transform preserved');
    }
    emitTransformKeyframeState(clip);
  });

  function emitVolumeKeyframeState(clip = getClip()) {
    if (!clip || (clip.kind !== 'audio' && clip.kind !== 'video')) {
      root.dispatchEvent(
        new CustomEvent('alcorvideo:volume-keyframe-state', { detail: { kind: clip?.kind || '' } }),
      );
      return;
    }
    const localTime = localClipTime(clip);
    const frames = audioAutomationCore.normalizeKeyframes(
      clip.volumeKeyframes,
      clip.duration,
      clip.volume,
    );
    const tolerance = Math.max(0.02, 1 / Math.max(1, state.project.fps));
    root.dispatchEvent(
      new CustomEvent('alcorvideo:volume-keyframe-state', {
        detail: {
          kind: clip.kind,
          localTime,
          count: frames.length,
          atKeyframe: Boolean(
            audioAutomationCore.findKeyframeAtTime(
              frames,
              localTime,
              clip.duration,
              tolerance,
              clip.volume,
            ),
          ),
          volume: audioAutomationCore.resolveAtTime(clip, state.currentTime),
        },
      }),
    );
  }

  function setVolumeValue(clip, value) {
    const nextVolume = clamp(value, 0, 1);
    const frames = audioAutomationCore.normalizeKeyframes(
      clip.volumeKeyframes,
      clip.duration,
      clip.volume,
    );
    if (!frames.length) {
      clip.volume = nextVolume;
      return;
    }
    clip.volumeKeyframes = audioAutomationCore.upsertKeyframe(
      frames,
      {
        time: localClipTime(clip),
        volume: nextVolume,
      },
      clip.duration,
      clip.volume,
    );
  }

  root.addEventListener('alcorvideo:volume-keyframe-command', (event) => {
    const clip = getClip();
    const action = String(event.detail?.action || '');
    if (!clip || (clip.kind !== 'audio' && clip.kind !== 'video')) return;
    const localTime = localClipTime(clip);
    const frames = audioAutomationCore.normalizeKeyframes(
      clip.volumeKeyframes,
      clip.duration,
      clip.volume,
    );
    const tolerance = Math.max(0.02, 1 / Math.max(1, state.project.fps));
    if (action === 'upsert') {
      const volume = audioAutomationCore.resolveAtTime(clip, state.currentTime);
      mutate('Audio gain keyframe updated', () => {
        clip.volumeKeyframes = audioAutomationCore.upsertKeyframe(
          frames,
          { time: localTime, volume },
          clip.duration,
          clip.volume,
        );
      });
      setStatus(`Audio gain keyframe saved at ${formatClock(state.currentTime, true)}`);
    } else if (action === 'remove') {
      const currentVolume = audioAutomationCore.resolveAtTime(clip, state.currentTime);
      const next = audioAutomationCore.removeKeyframe(
        frames,
        localTime,
        clip.duration,
        tolerance,
        clip.volume,
      );
      if (next.length === frames.length) {
        setStatus('Move the playhead onto an audio gain keyframe first');
        return;
      }
      mutate('Audio gain keyframe removed', () => {
        clip.volumeKeyframes = next;
        if (!next.length) clip.volume = currentVolume;
      });
      setStatus('Audio gain keyframe removed');
    } else if (action === 'clear' && frames.length) {
      const currentVolume = audioAutomationCore.resolveAtTime(clip, state.currentTime);
      mutate('Audio gain automation cleared', () => {
        clip.volumeKeyframes = [];
        clip.volume = currentVolume;
      });
      setStatus('Audio gain automation cleared; current level preserved');
    }
    emitVolumeKeyframeState(clip);
  });

  root.addEventListener('alcorvideo:color-reset', () => {
    const clip = getClip();
    if (!clip || (clip.kind !== 'video' && clip.kind !== 'image')) return;
    const neutral = colorCore.neutralColor();
    const current = colorCore.normalizeColor(clip);
    if (
      Object.keys(neutral).every((name) => current[name] === neutral[name]) &&
      !clip.vibrance &&
      !clip.curves &&
      !clip.lut &&
      !clip.wheels &&
      !clip.hsl
    ) {
      setStatus('Basic color is already neutral');
      return;
    }
    mutate('Basic color reset', () => {
      Object.assign(clip, neutral);
      delete clip.vibrance;
      delete clip.curves;
      delete clip.lut;
      delete clip.wheels;
      delete clip.hsl;
      pruneLuts();
    });
    setStatus('Basic color reset');
    emitGradeState();
  });

  // Color panels (curves, LUT) send whole color patches through this one undoable path.
  root.addEventListener('alcorvideo:color-patch', (event) => {
    const clip = getClip();
    const patch = event.detail?.patch;
    if (
      !clip ||
      (clip.kind !== 'video' && clip.kind !== 'image') ||
      !patch ||
      typeof patch !== 'object'
    )
      return;
    mutate(String(event.detail?.label || 'Color changed'), () => {
      Object.assign(
        clip,
        colorCore.normalizeColor({ ...colorCore.normalizeColor(clip), ...patch }),
      );
    });
  });

  // ------------------------------------------- lazy panels (effects, speed ramps)

  function linkedAudioTargets(clip) {
    if (!clip) return [];
    if (clip.kind === 'audio') return [clip];
    if (clip.kind !== 'video') return [];
    return [...Edit.linkedIds(state.project, [clip.id])]
      .map((id) => getClip(id))
      .filter((item) => item && item.kind === 'audio');
  }

  // One undoable path for panel edits; `live` edits preview now and commit later.
  function effectsEdit(label, live, apply) {
    if (live) {
      state.effectsBefore = state.effectsBefore || snapshot();
      if (apply() === false) return;
      renderPreview();
      return;
    }
    const before = state.effectsBefore || snapshot();
    state.effectsBefore = null;
    if (apply() === false) {
      renderAll();
      return;
    }
    if (snapshot() !== before) {
      pushHistory(before, label);
      markDirty(label);
    }
    renderAll();
  }

  function emitEffectsState() {
    window.AlcorVideoEffectsUI?.refresh?.();
  }

  // The lazy effects panel edits the selected clip through this narrow bridge; every
  // change runs inside `edit`, which owns undo, dirty state and redraw.
  const panelBridge = Object.freeze({
    clip: () => getClip(),
    project: () => state.project,
    localTime: (clip) => localClipTime(clip),
    currentTime: () => state.currentTime,
    fps,
    uid,
    edit: effectsEdit,
    setStatus,
    formatClock,
    linkedIds: (id) => (state.linkedSelection ? [...Edit.linkedIds(state.project, [id])] : [id]),
    linkedAudio: linkedAudioTargets,
    speedAt: clipSpeedAt,
    setTimeRemap: (id, points, project = state.project) => Edit.setTimeRemap(project, id, points),
    loadEffects: () => loadGroup('effects'),
  });
  root.addEventListener('alcorvideo:panel-bridge', (event) => {
    if (event.detail && typeof event.detail === 'object') event.detail.bridge = panelBridge;
  });
  // Commands sent before the effects group has loaded are replayed once it has.
  root.addEventListener('alcorvideo:effects-command', (event) => {
    if (window.AlcorVideoEffectsUI || !event.detail) return;
    const detail = { ...event.detail };
    loadGroup('effects').then((loaded) => {
      if (loaded && window.AlcorVideoEffectsUI)
        root.dispatchEvent(new CustomEvent('alcorvideo:effects-command', { detail }));
    });
  });

  // Eyedropper (EyeDropper API or a click on the Program monitor) picks from the picture
  // without the effect being edited, so a key color can be picked again after keying.
  root.addEventListener('alcorvideo:eyedropper', (event) => {
    const detail = event.detail || {};
    if (detail.phase === 'start')
      state.eyedropper = {
        clipId: String(detail.clipId || ''),
        effectId: String(detail.effectId || ''),
      };
    else state.eyedropper = null;
    showProgram();
    renderPreview();
  });

  // -------------------------------------------------------------- inspector

  function fillForm(form, values) {
    for (const [name, value] of Object.entries(values)) {
      const field = form.elements.namedItem(name);
      if (!field) continue;
      if (field.type === 'checkbox') field.checked = Boolean(value);
      else field.value = value;
    }
  }

  function syncTrackOptions(field, clip) {
    if (!field || field.tagName !== 'SELECT') return;
    const kind = clip.kind === 'audio' ? 'audio' : 'video';
    const wanted = Edit.displayOrder(state.project.tracks)
      .filter((track) => track.kind === kind)
      .map((track) => track.id);
    const existing = Array.from(field.options || []).map((option) => option.value);
    if (existing.join() !== wanted.join()) {
      field.replaceChildren?.();
      for (const id of wanted) {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = id;
        field.append(option);
      }
    }
  }

  function syncSpeedOptions(field, clip) {
    if (!field || field.tagName !== 'SELECT') return;
    const value = String(clip.speed);
    if (!Array.from(field.options || []).some((option) => option.value === value)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = `${Math.round(clip.speed * 100) / 100}×`;
      field.append(option);
    }
  }

  function renderInspector() {
    const clip = getClip();
    root.dispatchEvent(
      new CustomEvent('alcorvideo:color-state', {
        detail: { kind: clip?.kind || '', color: colorCore.normalizeColor(clip) },
      }),
    );
    emitGradeState();
    // The curves/LUT/scopes panel loads the first time a picture clip is selected.
    if (
      clip &&
      (clip.kind === 'video' || clip.kind === 'image') &&
      !root.querySelector('[data-av-grade-section]')
    ) {
      loadGroup('grade').then((loaded) => {
        if (loaded) emitGradeState();
      });
    }
    // Effects, audio effects, speed ramps and eyedroppers load the first time a clip is selected.
    if (clip && !window.AlcorVideoEffectsUI)
      loadGroup('effects').then((loaded) => {
        if (loaded) emitEffectsState();
      });
    else emitEffectsState(clip);
    const hasClip = Boolean(clip);
    elements.inspectorEmpty.hidden = hasClip;
    elements.deleteButton.disabled = !state.selection.size || state.rendering;
    elements.clipInspector.hidden = !hasClip || clip.kind === 'title';
    elements.titleInspector.hidden = !hasClip || clip.kind !== 'title';
    root.dataset.selectionKind = clip?.kind || '';

    if (!clip) return;
    if (clip.kind === 'title') {
      fillForm(elements.titleInspector, {
        text: clip.text,
        start: clip.start,
        duration: clip.duration,
        size: clip.size,
        x: clip.x,
        y: clip.y,
        align: clip.align,
        font: clip.font,
        color: clip.color,
        background: clip.background,
        backgroundOpacity: clip.backgroundOpacity,
        bold: clip.bold,
        italic: clip.italic,
        stroke: clip.stroke,
        strokeWidth: clip.strokeWidth,
        shadow: clip.shadow,
        fadeIn: clip.fadeIn || 0,
        fadeOut: clip.fadeOut || 0,
      });
      return;
    }

    const trackField = elements.clipInspector.elements.namedItem('track');
    syncTrackOptions(trackField, clip);
    for (const option of Array.from(trackField?.options || [])) {
      option.disabled =
        clip.kind === 'audio' ? !option.value.startsWith('A') : option.value.startsWith('A');
    }
    syncSpeedOptions(elements.clipInspector.elements.namedItem('speed'), clip);
    fillForm(elements.clipInspector, {
      name: clip.name,
      track: clip.track,
      start: clip.start,
      duration: clip.duration,
      in: clip.in,
      speed: clip.speed,
      reverse: Boolean(clip.reverse),
      opacity: clip.opacity,
      volume: audioAutomationCore.resolveAtTime(clip, state.currentTime),
      muted: clip.muted,
      gain: clip.gain || 0,
      pan: Math.round((clip.pan || 0) * 100),
      ...colorCore.normalizeColor(clip),
      fadeIn: clip.fadeIn || 0,
      fadeOut: clip.fadeOut || 0,
      ...transformCore.resolveTransformAtTime(clip, state.currentTime),
    });
  }

  function applyInspectorField(field) {
    const clip = getClip();
    if (!clip || !field.name) return;
    const value = field.type === 'checkbox' ? field.checked : field.value;

    if (clip.kind === 'title') {
      switch (field.name) {
        case 'text':
          clip.text = String(value).slice(0, 240);
          clip.name = clip.text.split('\n')[0].slice(0, 40) || 'Title';
          break;
        case 'start':
          clip.start = editorCore.normalizeClipWindow(value, clip.duration, 0.1).start;
          break;
        case 'duration':
          clip.duration = editorCore.normalizeClipWindow(clip.start, value, 0.1).duration;
          break;
        case 'size':
          clip.size = clamp(value, 12, 200);
          break;
        case 'x':
          clip.x = clamp(value, 0, 100);
          break;
        case 'y':
          clip.y = clamp(value, 0, 100);
          break;
        case 'align':
          clip.align = ['left', 'center', 'right'].includes(value) ? value : 'center';
          break;
        case 'font':
          clip.font = Object.prototype.hasOwnProperty.call(TITLE_FONTS, value) ? value : 'sans';
          break;
        case 'color':
          clip.color = hex(value, clip.color);
          break;
        case 'background':
          clip.background = hex(value, clip.background);
          break;
        case 'backgroundOpacity':
          clip.backgroundOpacity = clamp(value, 0, 1);
          break;
        case 'bold':
          clip.bold = Boolean(value);
          break;
        case 'italic':
          clip.italic = Boolean(value);
          break;
        case 'stroke':
          clip.stroke = hex(value, clip.stroke);
          break;
        case 'strokeWidth':
          clip.strokeWidth = clamp(value, 0, 20);
          break;
        case 'shadow':
          clip.shadow = Boolean(value);
          break;
        case 'fadeIn':
          clip.fadeIn = clamp(value, 0, clip.duration);
          break;
        case 'fadeOut':
          clip.fadeOut = clamp(value, 0, clip.duration);
          break;
        default:
          break;
      }
    } else {
      switch (field.name) {
        case 'name':
          clip.name = String(value).slice(0, 100);
          break;
        case 'track':
          if (
            getTrack(value) &&
            Edit.trackAccepts(value, clip) &&
            !getTrack(value).locked &&
            value !== clip.track
          ) {
            Edit.moveClips(state.project, [clip.id], 0, {
              makeId: uid,
              ignoreLinks: true,
              trackShift: {
                [Edit.trackKind(value)]: Edit.trackNumber(value) - Edit.trackNumber(clip.track),
              },
            });
          }
          break;
        case 'start':
          clip.start = editorCore.normalizeClipWindow(
            value,
            clip.duration,
            MIN_CLIP_DURATION,
          ).start;
          break;
        case 'duration':
          clip.duration = Math.min(
            editorCore.normalizeClipWindow(clip.start, value, MIN_CLIP_DURATION).duration,
            mediaAvailableDuration(clip),
          );
          break;
        case 'in': {
          const asset = getAsset(clip.assetId);
          const maxIn = asset?.duration
            ? Math.max(0, asset.duration - MIN_CLIP_DURATION)
            : Infinity;
          clip.in = clamp(value, 0, maxIn);
          clip.duration = Math.min(clip.duration, mediaAvailableDuration(clip));
          break;
        }
        case 'speed': {
          // Premiere Speed/Duration: the source range stays, so duration follows speed.
          const ripple = Boolean(elements.clipInspector.elements.namedItem('rippleSpeed')?.checked);
          const ids = state.linkedSelection
            ? [...Edit.linkedIds(state.project, [clip.id])]
            : [clip.id];
          for (const id of ids) Edit.setSpeed(state.project, id, value, { ripple });
          break;
        }
        case 'reverse': {
          const ids = state.linkedSelection
            ? [...Edit.linkedIds(state.project, [clip.id])]
            : [clip.id];
          for (const id of ids) Edit.setReverse(state.project, id, Boolean(value));
          break;
        }
        case 'opacity':
          setMotionValue(clip, 'opacity', clamp(value, 0, 1));
          break;
        case 'volume':
          setVolumeValue(clip, value);
          break;
        case 'gain':
          clip.gain = round(clamp(value, -60, 12), 1);
          break;
        case 'pan':
          clip.pan = round(clamp(Number(value) / 100, -1, 1), 2);
          break;
        case 'exposure':
          clip.exposure = colorCore.normalizeColor({ exposure: value }).exposure;
          break;
        case 'temperature':
          clip.temperature = colorCore.normalizeColor({ temperature: value }).temperature;
          break;
        case 'tint':
          clip.tint = colorCore.normalizeColor({ tint: value }).tint;
          break;
        case 'brightness':
          clip.brightness = colorCore.normalizeColor({ brightness: value }).brightness;
          break;
        case 'contrast':
          clip.contrast = colorCore.normalizeColor({ contrast: value }).contrast;
          break;
        case 'highlights':
          clip.highlights = colorCore.normalizeColor({ highlights: value }).highlights;
          break;
        case 'shadows':
          clip.shadows = colorCore.normalizeColor({ shadows: value }).shadows;
          break;
        case 'whites':
          clip.whites = colorCore.normalizeColor({ whites: value }).whites;
          break;
        case 'blacks':
          clip.blacks = colorCore.normalizeColor({ blacks: value }).blacks;
          break;
        case 'saturation':
          clip.saturation = colorCore.normalizeColor({ saturation: value }).saturation;
          break;
        case 'vibrance': {
          const next = round(clamp(value, -100, 100), 1);
          if (next) clip.vibrance = next;
          else delete clip.vibrance;
          break;
        }
        case 'muted':
          clip.muted = Boolean(value);
          break;
        case 'fadeIn':
          clip.fadeIn = clamp(value, 0, clip.duration);
          break;
        case 'fadeOut':
          clip.fadeOut = clamp(value, 0, clip.duration);
          break;
        case 'positionX':
          setMotionValue(clip, 'positionX', clamp(value, -100, 200));
          break;
        case 'positionY':
          setMotionValue(clip, 'positionY', clamp(value, -100, 200));
          break;
        case 'scale':
          setMotionValue(clip, 'scale', clamp(value, 10, 800));
          break;
        case 'rotation':
          setMotionValue(clip, 'rotation', clamp(value, -180, 180));
          break;
        case 'fit':
          clip.fit = transformCore.normalizeFit(value);
          break;
        default:
          break;
      }
    }
    state.currentTime = clamp(state.currentTime, 0, Math.max(projectDuration(), 0));
    scheduleTimelineRender();
    updatePlayhead();
    renderPreview();
  }

  function bindInspector(form) {
    form.addEventListener('focusin', (event) => {
      const field = event.target;
      if (!field.name || field.dataset.history) return;
      field.dataset.history = snapshot();
    });
    form.addEventListener('input', (event) => {
      if (!event.target.dataset.history && event.target.name)
        event.target.dataset.history = snapshot();
      applyInspectorField(event.target);
    });
    form.addEventListener('change', (event) => {
      const field = event.target;
      const before = field.dataset.history || snapshot();
      applyInspectorField(field);
      if (before && before !== snapshot()) {
        pushHistory(before, 'Inspector changed');
        markDirty('Inspector changed');
      }
      delete field.dataset.history;
      renderInspector();
    });
    form.addEventListener('focusout', (event) => {
      const field = event.target;
      if (!field.dataset.history) return;
      if (field.dataset.history !== snapshot()) {
        pushHistory(field.dataset.history, 'Inspector changed');
        markDirty('Inspector changed');
      }
      delete field.dataset.history;
    });
  }

  // ---------------------------------------------------------------- timeline

  const HEADER_WIDTH = 88;

  function ensureTracksContainer() {
    if (elements.tracks && elements.tracks.isConnected !== false) return elements.tracks;
    const container = document.createElement('div');
    container.id = 'av-tracks';
    container.className = 'av-tracks';
    // Replace any static V2/V1/A1 rows from older markup with generated rows.
    for (const legacy of $$('.av-track-row, [data-track-lane]', elements.timeline)) legacy.remove();
    const rulerRow = elements.ruler?.closest?.('.av-ruler-row');
    if (rulerRow && typeof rulerRow.after === 'function') rulerRow.after(container);
    else if (typeof elements.timeline.insertBefore === 'function' && elements.playhead)
      elements.timeline.insertBefore(container, elements.playhead);
    else elements.timeline.append(container);
    elements.tracks = container;
    return container;
  }

  // Icons are inline SVG: symbol and emoji glyphs make the browser search system fallback fonts,
  // which cost a phone about 100 ms of layout on first paint.
  const ICONS = Object.freeze({
    play: '<svg class="av-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 2.5v11l9-5.5z"/></svg>',
    pause:
      '<svg class="av-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 2.5h3v11H4zM9 2.5h3v11H9z"/></svg>',
    locked:
      '<svg class="av-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M5 7V5a3 3 0 0 1 6 0v2h1v7H4V7zm1.5 0h3V5a1.5 1.5 0 0 0-3 0z"/></svg>',
    unlocked:
      '<svg class="av-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 7h6.5V5a1.5 1.5 0 0 0-3 0H6a3 3 0 0 1 6 0v2h0v7H4z"/></svg>',
    shown:
      '<svg class="av-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2.5"/></svg>',
    hidden:
      '<svg class="av-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2 2"/></svg>',
  });

  function trackButton(action, label, pressed, text) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'av-track-toggle';
    button.dataset.trackAction = action;
    button.setAttribute('aria-label', label);
    button.title = label;
    if (pressed !== null) button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    if (ICONS[text]) button.innerHTML = ICONS[text];
    else button.textContent = text;
    return button;
  }

  // Keyed timeline rendering: track rows and clip elements are reused while what they show is
  // unchanged, so a drag, trim or playhead move rebuilds only the clips it touches.
  const clipElements = new Map();
  let tracksSignature = '';

  function renderTracks() {
    const container = ensureTracksContainer();
    const order = Edit.displayOrder(state.project.tracks);
    const counts = {
      video: order.filter((track) => track.kind === 'video').length,
      audio: order.filter((track) => track.kind === 'audio').length,
    };
    const signature = JSON.stringify([
      order.map((track) => [
        track.id,
        track.kind,
        track.name,
        Boolean(track.locked),
        Boolean(track.hidden),
        Boolean(track.muted),
        Boolean(track.solo),
      ]),
      counts,
    ]);
    if (
      signature === tracksSignature &&
      elements.lanes &&
      elements.lanes.size &&
      [...elements.lanes.values()].every(
        (lane) => lane.isConnected === true && lane.parentNode?.parentNode === container,
      )
    ) {
      return elements.lanes;
    }
    tracksSignature = signature;
    clipElements.clear();
    container.replaceChildren?.();
    if (!container.replaceChildren) container.children = [];
    const lanes = new Map();
    for (const track of order) {
      const row = document.createElement('div');
      row.className = `av-track-row av-track-${track.kind}`;
      row.dataset.track = track.id;
      row.dataset.kind = track.kind;
      if (track.locked) row.classList.add('is-locked');
      if (track.hidden || track.muted) row.classList.add('is-off');
      const header = document.createElement('div');
      header.className = 'av-track-label av-track-header';
      const name = document.createElement('strong');
      name.textContent = track.id;
      name.title = track.name;
      const tools = document.createElement('div');
      tools.className = 'av-track-tools';
      tools.append(
        trackButton(
          'lock',
          `${track.locked ? 'Unlock' : 'Lock'} ${track.id}`,
          track.locked,
          track.locked ? 'locked' : 'unlocked',
        ),
      );
      if (track.kind === 'video') {
        tools.append(
          trackButton(
            'hide',
            `${track.hidden ? 'Show' : 'Hide'} ${track.id} output`,
            track.hidden,
            track.hidden ? 'hidden' : 'shown',
          ),
        );
      } else {
        tools.append(
          trackButton('mute', `${track.muted ? 'Unmute' : 'Mute'} ${track.id}`, track.muted, 'M'),
        );
        tools.append(
          trackButton('solo', `${track.solo ? 'Unsolo' : 'Solo'} ${track.id}`, track.solo, 'S'),
        );
      }
      if (counts[track.kind] > 1)
        tools.append(trackButton('remove', `Remove track ${track.id}`, null, '×'));
      header.append(name, tools);
      const lane = document.createElement('div');
      lane.className = 'av-track-lane';
      lane.dataset.trackLane = track.id;
      lane.dataset.kind = track.kind;
      row.append(header, lane);
      container.append(row);
      lanes.set(track.id, lane);
    }
    // Empty space below the tracks: dropping media here creates new tracks, as in Premiere.
    const dropRow = document.createElement('div');
    dropRow.className = 'av-track-row av-track-dropzone';
    dropRow.dataset.newTrackDrop = '';
    const dropLabel = document.createElement('div');
    dropLabel.className = 'av-track-label av-track-header';
    dropLabel.textContent = 'New';
    const dropLane = document.createElement('div');
    dropLane.className = 'av-dropzone-lane';
    dropLane.dataset.newTrackLane = '';
    dropLane.textContent = 'Drop media here to add it on a new track';
    dropRow.append(dropLabel, dropLane);
    container.append(dropRow);
    elements.lanes = lanes;
    return lanes;
  }

  function renderRuler(duration) {
    elements.ruler.replaceChildren?.();
    if (!elements.ruler.replaceChildren) elements.ruler.innerHTML = '';
    const baseStep =
      state.pxPerSecond < 12 ? 30 : state.pxPerSecond < 35 ? 5 : state.pxPerSecond < 70 ? 2 : 1;
    const step = Math.max(baseStep, Math.ceil(duration / 600));
    for (let second = 0; second <= duration; second += step) {
      const mark = document.createElement('span');
      mark.className = 'av-ruler-mark';
      mark.style.left = `${second * state.pxPerSecond}px`;
      mark.textContent = formatClock(second);
      elements.ruler.append(mark);
    }
    const { inPoint, outPoint } = state.project;
    if (inPoint != null || outPoint != null) {
      const start = inPoint ?? 0;
      const end = outPoint ?? Math.max(projectDuration(), start);
      const range = document.createElement('span');
      range.className = 'av-inout-range';
      range.style.left = `${start * state.pxPerSecond}px`;
      range.style.width = `${Math.max(2, (end - start) * state.pxPerSecond)}px`;
      range.title = `In ${formatClock(start, true)} · Out ${outPoint == null ? 'end' : formatClock(end, true)}`;
      elements.ruler.append(range);
    }
    for (const marker of state.project.markers || []) {
      const flag = document.createElement('button');
      flag.type = 'button';
      flag.className = `av-marker av-marker-${marker.color}`;
      flag.dataset.markerId = marker.id;
      flag.style.left = `${marker.time * state.pxPerSecond}px`;
      flag.title = `${marker.name || 'Marker'} · ${formatClock(marker.time, true)}`;
      flag.setAttribute(
        'aria-label',
        `Marker ${marker.name || ''} at ${formatClock(marker.time, true)}`,
      );
      elements.ruler.append(flag);
    }
  }

  function scheduleTimelineRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(() => {
      state.renderQueued = false;
      renderTimeline();
    });
  }

  function clipLabel(clip) {
    if (clip.kind === 'title') return clip.text.split('\n')[0];
    return clip.name;
  }

  function clipAriaLabel(clip) {
    return `${clip.name}, ${formatClock(clip.start, true)}, duration ${formatClock(clip.duration, true)}`;
  }

  function clipTitle(clip) {
    return `${clip.name}\n${formatClock(clip.start, true)} · ${formatClock(clip.duration, true)}${clip.speed && clip.speed !== 1 ? ` · ${Math.round(clip.speed * 100)}%` : ''}${clip.reverse ? ' · reverse' : ''}${clip.hold != null ? ' · frame hold' : ''}`;
  }

  function renderTimeline() {
    const duration = timelineDuration();
    const laneWidth = Math.ceil(duration * state.pxPerSecond);
    // Inherited custom properties restyle the whole timeline subtree, so write them only when they change.
    const setVar = (name, value) => {
      if (elements.timeline.style.getPropertyValue?.(name) !== value)
        elements.timeline.style.setProperty(name, value);
    };
    setVar('--av-px-per-second', `${state.pxPerSecond}px`);
    setVar('--av-duration', String(duration));
    elements.timeline.style.width = `${laneWidth + HEADER_WIDTH}px`;
    elements.ruler.style.minWidth = `${laneWidth}px`;
    renderRuler(duration);
    const lanes = renderTracks();
    for (const lane of lanes.values()) {
      lane.style.minWidth = `${laneWidth}px`;
      for (const mark of lane.querySelectorAll?.('.av-gap-selection') || []) mark.remove();
    }
    const audible = Edit.audibleTrackIds(state.project);
    const visible = Edit.visibleTrackIds(state.project);

    if (state.gap && lanes.get(state.gap.track)) {
      const current = Edit.gapAt(state.project, state.gap.track, state.gap.time);
      if (current) {
        const mark = document.createElement('span');
        mark.className = 'av-gap-selection';
        mark.setAttribute('aria-hidden', 'true');
        mark.style.left = `${current.start * state.pxPerSecond}px`;
        mark.style.width = `${(current.end - current.start) * state.pxPerSecond}px`;
        lanes.get(state.gap.track).append(mark);
      } else {
        state.gap = null;
      }
    }
    const clips = [...state.project.clips].sort(
      (a, b) => a.start - b.start || a.id.localeCompare(b.id),
    );
    const shown = new Set();
    const laneOrder = new Map();
    for (const clip of clips) {
      const lane = lanes.get(clip.track);
      if (!lane) continue;
      if (!laneOrder.has(lane)) laneOrder.set(lane, []);
      laneOrder.get(lane).push(clip.id);
      const thumbCount =
        clip.kind === 'video' ? state.thumbnails.get(clip.assetId)?.frames?.length || 0 : 0;
      // A clip that only moved keeps its element and is repositioned in place (no rebuild, no thumbnail
      // re-decode). Clips carrying a transition are rebuilt so their decoration is redrawn.
      const cached = clipElements.get(clip.id);
      const decorated =
        Boolean(clip.crossDissolve) ||
        Boolean(cached?.item?.classList?.contains?.('has-cross-dissolve'));
      const signature = JSON.stringify([
        decorated ? clip : { ...clip, start: 0 },
        state.pxPerSecond,
        state.selection.has(clip.id),
        clip.id === state.selectedId,
        audible.has(clip.track),
        visible.has(clip.track),
        state.runtimeAssets.has(clip.assetId),
        thumbCount,
      ]);
      shown.add(clip.id);
      if (
        cached &&
        cached.signature === signature &&
        cached.item.parentNode === lane &&
        cached.item.isConnected === true
      ) {
        if (cached.start !== clip.start) {
          cached.start = clip.start;
          cached.item.style.left = `${clip.start * state.pxPerSecond}px`;
          cached.item.setAttribute('aria-label', clipAriaLabel(clip));
          cached.item.title = clipTitle(clip);
        }
        continue;
      }
      cached?.item?.remove?.();
      const item = document.createElement('div');
      item.className = 'av-timeline-clip';
      if (state.selection.has(clip.id)) item.classList.add('is-selected');
      if (clip.id === state.selectedId) item.classList.add('is-primary');
      if (clip.linkId) item.classList.add('is-linked');
      if (clip.reverse) item.classList.add('is-reverse');
      if (clip.hold != null) item.classList.add('is-hold');
      if (
        clip.muted ||
        (clip.kind === 'audio' && !audible.has(clip.track)) ||
        (clip.kind !== 'audio' && !visible.has(clip.track))
      )
        item.classList.add('is-disabled');
      if (isMediaClip(clip) && !state.runtimeAssets.has(clip.assetId))
        item.classList.add('is-missing');
      item.dataset.clipId = clip.id;
      item.dataset.kind = clip.kind;
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.setAttribute('aria-pressed', state.selection.has(clip.id) ? 'true' : 'false');
      item.setAttribute('aria-label', clipAriaLabel(clip));
      item.style.left = `${clip.start * state.pxPerSecond}px`;
      item.style.width = `${Math.max(10, clip.duration * state.pxPerSecond)}px`;
      if (isMediaClip(clip)) {
        item.style.setProperty(
          '--av-fade-in',
          `${Math.max(0, clip.fadeIn || 0) * state.pxPerSecond}px`,
        );
        item.style.setProperty(
          '--av-fade-out',
          `${Math.max(0, clip.fadeOut || 0) * state.pxPerSecond}px`,
        );
      }
      item.title = clipTitle(clip);

      const left = document.createElement('button');
      left.type = 'button';
      left.className = 'av-trim-handle';
      left.dataset.trim = 'left';
      left.tabIndex = -1;
      left.setAttribute('aria-label', `Trim start of ${clip.name}`);

      const body = document.createElement('div');
      body.className = 'av-clip-body';
      if (clip.kind === 'video' && state.pxPerSecond * clip.duration > 40) {
        const record = state.thumbnails.get(clip.assetId);
        if (record && record.frames.length) {
          const strip = document.createElement('div');
          strip.className = 'av-clip-thumbs';
          strip.setAttribute('aria-hidden', 'true');
          const widthPx = clip.duration * state.pxPerSecond;
          const slots = Math.max(1, Math.min(40, Math.ceil(widthPx / 96)));
          for (let slot = 0; slot < slots; slot += 1) {
            const at = clip.start + ((slot + 0.5) * clip.duration) / slots;
            const image = document.createElement('img');
            image.alt = '';
            image.src = thumbnailAt(clip.assetId, Edit.sourceTimeAt(clip, at));
            image.style.width = `${100 / slots}%`;
            strip.append(image);
          }
          body.append(strip);
        }
      }
      const name = document.createElement('strong');
      name.textContent = clipLabel(clip);
      const detail = document.createElement('span');
      detail.textContent = `${formatClock(clip.duration)}${isMediaClip(clip) && clip.speed !== 1 && !clip.timeRemap ? ` · ${Math.round(clip.speed * 100)}%` : ''}${clip.timeRemap ? ' · ramp' : ''}${clip.reverse ? ' · reverse' : ''}${clip.hold != null ? ' · hold' : ''}${clip.effects && clip.effects.length ? ' · fx' : ''}${clip.audioFx ? ' · fx' : ''}`;
      body.append(name, detail);
      const frames = clip.kind === 'audio' ? clip.volumeKeyframes : clip.transformKeyframes;
      if (Array.isArray(frames) && frames.length && clip.duration * state.pxPerSecond > 24) {
        for (const frame of frames.slice(0, 60)) {
          const dot = document.createElement('span');
          dot.className = 'av-keyframe-dot';
          dot.setAttribute('aria-hidden', 'true');
          dot.style.left = `${(frame.time / Math.max(0.001, clip.duration)) * 100}%`;
          body.append(dot);
        }
      }

      const right = document.createElement('button');
      right.type = 'button';
      right.className = 'av-trim-handle';
      right.dataset.trim = 'right';
      right.tabIndex = -1;
      right.setAttribute('aria-label', `Trim end of ${clip.name}`);

      item.append(left, body, right);
      item.addEventListener('pointerdown', (event) => startClipDrag(event, item));
      item.addEventListener('click', (event) => {
        event.stopPropagation();
        if (state.drag?.suppressClick || state.suppressClick) {
          state.suppressClick = false;
          return;
        }
        if (state.tool !== 'select' && state.tool !== 'ripple' && state.tool !== 'roll') return;
        if (!event.shiftKey && !event.ctrlKey && !event.metaKey)
          selectClip(clip.id, { alt: event.altKey });
      });
      item.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        selectClip(clip.id, { additive: event.shiftKey });
      });
      lane.append(item);
      clipElements.set(clip.id, { item, signature, start: clip.start });
    }
    for (const [id, cached] of clipElements) {
      if (shown.has(id)) continue;
      cached.item.remove?.();
      clipElements.delete(id);
    }
    // Keep document order = time order in each lane (tab order and stacking), moving only what is out of place.
    for (const [lane, ids] of laneOrder) {
      if (typeof lane.insertBefore !== 'function' || !('firstChild' in lane)) continue;
      let previous = null;
      for (const id of ids) {
        const item = clipElements.get(id)?.item;
        if (!item) continue;
        const expected = previous ? previous.nextSibling : lane.firstChild;
        if (item !== expected) lane.insertBefore(item, expected);
        previous = item;
      }
    }

    updatePlayhead();
    // Waveforms load once the sequence has sound; then they learn every linked file.
    if (!window.AlcorVideoWaveforms && state.project.clips.some((clip) => clip.kind === 'audio')) {
      loadGroup('waveform').then((loaded) => {
        if (!loaded) return;
        for (const [assetId, runtime] of state.runtimeAssets.entries()) {
          if (runtime.file)
            root.dispatchEvent(
              new CustomEvent('alcorvideo:media-linked', {
                detail: { assetId, file: runtime.file },
              }),
            );
        }
      });
    }
    const mediaCount = state.project.clips.filter((clip) => clip.kind !== 'title').length;
    const titleCount = state.project.clips.filter((clip) => clip.kind === 'title').length;
    if (elements.projectStats)
      elements.projectStats.textContent = `${mediaCount} clip${mediaCount === 1 ? '' : 's'} · ${titleCount} title${titleCount === 1 ? '' : 's'} · ${formatClock(projectDuration())}`;
    root.dataset.activeTool = state.tool;
  }

  function updatePlayhead() {
    // The playhead moves by transform (compositor only), so scrubbing and playback never relayout the timeline.
    if (elements.playhead) {
      if (elements.playhead.style.left !== `${HEADER_WIDTH}px`)
        elements.playhead.style.left = `${HEADER_WIDTH}px`;
      elements.playhead.style.transform = `translateX(${state.currentTime * state.pxPerSecond}px)`;
    }
    if (elements.timeInput && document.activeElement !== elements.timeInput)
      elements.timeInput.value = round(state.currentTime, 2);
    if (elements.timecode) elements.timecode.textContent = formatClock(state.currentTime, true);
    emitTransformKeyframeState();
    emitVolumeKeyframeState();
    if (!state.playing) emitEffectsState();
  }

  function keepPlayheadVisible() {
    const scroll = elements.timelineScroll;
    if (!scroll || typeof scroll.scrollLeft !== 'number') return;
    const x = HEADER_WIDTH + state.currentTime * state.pxPerSecond;
    const viewStart = scroll.scrollLeft + HEADER_WIDTH;
    const viewEnd = scroll.scrollLeft + (scroll.clientWidth || 0);
    if (!scroll.clientWidth) return;
    if (x > viewEnd - 24) scroll.scrollLeft = x - HEADER_WIDTH - 40;
    else if (x < viewStart) scroll.scrollLeft = Math.max(0, x - HEADER_WIDTH - 40);
  }

  function setZoom(value) {
    state.pxPerSecond = clamp(value, 4, 480);
    if (elements.zoom) elements.zoom.value = String(Math.round(state.pxPerSecond));
    renderTimeline();
    keepPlayheadVisible();
  }

  function zoomToFit() {
    const width = (elements.timelineScroll?.clientWidth || 900) - HEADER_WIDTH - 24;
    setZoom(width / Math.max(1, projectDuration() || 10));
  }

  // --------------------------------------------------------- drag editing

  function laneUnderPointer(event) {
    const target =
      typeof document.elementFromPoint === 'function'
        ? document.elementFromPoint(event.clientX, event.clientY)
        : event.target;
    return target?.closest?.('[data-track-lane]') || null;
  }

  function cloneProject(project) {
    return JSON.parse(JSON.stringify(project));
  }

  function startClipDrag(event, clipElement) {
    if (event.button !== 0 || state.rendering) return;
    const clip = getClip(clipElement.dataset.clipId);
    if (!clip) return;
    event.preventDefault();
    pause();
    const handle = event.target.closest('[data-trim]');
    const edge = handle ? (handle.dataset.trim === 'left' ? 'start' : 'end') : '';
    const tool = state.tool;

    if (tool === 'razor') {
      const lane = clipElement.parentElement;
      const rect = lane.getBoundingClientRect();
      razorAt(clip.id, (event.clientX - rect.left) / state.pxPerSecond, event.shiftKey);
      state.suppressClick = true;
      return;
    }

    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      if (!edge) {
        selectClip(clip.id, { additive: true });
        state.suppressClick = true;
        return;
      }
    }
    if (!state.selection.has(clip.id) || edge) {
      if (event.altKey) {
        state.selection = new Set([clip.id]);
        state.selectedId = clip.id;
      } else selectIds([clip.id], clip.id);
    } else {
      state.selectedId = clip.id;
    }
    renderInspector();

    let op = 'move';
    if (edge) {
      if (tool === 'ripple' || (tool === 'select' && (event.ctrlKey || event.metaKey)))
        op = 'ripple';
      else if (tool === 'roll') op = 'roll';
      else op = 'trim';
    } else if (tool === 'slip') op = 'slip';
    else if (tool === 'slide') op = 'slide';

    const ids = op === 'move' ? (event.altKey ? [clip.id] : [...state.selection]) : [clip.id];
    state.drag = {
      type: 'clip',
      op,
      edge,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      clipId: clip.id,
      ids,
      ignoreLinks: event.altKey || !state.linkedSelection,
      originTrack: clip.track,
      base: cloneProject(state.project),
      before: snapshot(),
      moved: false,
      result: null,
      frame: 0,
      lastEvent: null,
    };
    // Timeline DOM is rebuilt during the drag; window listeners own pointer continuity.
  }

  function linkedPartners(project, clipId, edge) {
    const clip = project.clips.find((item) => item.id === clipId);
    if (!clip || !clip.linkId) return [];
    const at = edge === 'start' ? clip.start : clip.start + clip.duration;
    return project.clips.filter(
      (item) =>
        item.id !== clip.id &&
        item.linkId === clip.linkId &&
        Math.abs((edge === 'start' ? item.start : item.start + item.duration) - at) < 0.002,
    );
  }

  function applyDrag(drag, delta, event) {
    const project = cloneProject(drag.base);
    const clip = project.clips.find((item) => item.id === drag.clipId);
    if (!clip) return { ok: false, reason: 'The clip is gone.' };
    const rate = fps();
    const quantize = (value) => Math.round(value * rate) / rate;
    let result;
    if (drag.op === 'move') {
      const ids = drag.ignoreLinks ? drag.ids : [...Edit.linkedIds(project, drag.ids)];
      let moveDelta = quantize(delta);
      if (state.snap) {
        const targets = Edit.snapTargets(project, {
          playhead: state.currentTime,
          except: new Set(ids),
        });
        const snapped = Edit.snapClipDelta(
          clip.start,
          clip.duration,
          delta,
          targets,
          snapTolerance(),
        );
        if (snapped.snapped) {
          moveDelta = snapped.delta;
          drag.snapAt = snapped.target;
        } else drag.snapAt = null;
      }
      const lane = event ? laneUnderPointer(event) : null;
      const kind = Edit.trackKind(drag.originTrack);
      let shift = 0;
      if (lane && lane.dataset.kind === kind)
        shift = Edit.trackNumber(lane.dataset.trackLane) - Edit.trackNumber(drag.originTrack);
      result = Edit.moveClips(project, ids, moveDelta, {
        makeId: uid,
        ignoreLinks: true,
        trackShift: shift ? { [kind]: shift } : {},
      });
      if (!result.ok && shift)
        result = Edit.moveClips(project, ids, moveDelta, { makeId: uid, ignoreLinks: true });
    } else if (drag.op === 'slip') {
      const partners = drag.ignoreLinks
        ? [clip]
        : project.clips.filter(
            (item) => item.id === clip.id || (clip.linkId && item.linkId === clip.linkId),
          );
      for (const item of partners) {
        const outcome = Edit.slipClip(project, item.id, -quantize(delta));
        if (item.id === clip.id) result = outcome;
      }
    } else if (drag.op === 'slide') {
      result = Edit.slideClip(project, clip.id, quantize(delta));
    } else {
      const edgeTime = drag.edge === 'start' ? clip.start : clip.start + clip.duration;
      let edgeDelta = quantize(delta);
      if (state.snap) {
        const targets = Edit.snapTargets(project, {
          playhead: state.currentTime,
          except: new Set([clip.id]),
        });
        const snapped = Edit.snap(edgeTime + delta, targets, snapTolerance());
        if (snapped.snapped) {
          edgeDelta = snapped.time - edgeTime;
          drag.snapAt = snapped.time;
        } else drag.snapAt = null;
      }
      const partners = drag.ignoreLinks ? [] : linkedPartners(project, clip.id, drag.edge);
      if (drag.op === 'roll') {
        const rollPair = (item) => {
          const neighbor = project.clips.find(
            (other) =>
              other.track === item.track &&
              other.id !== item.id &&
              (drag.edge === 'end'
                ? Math.abs(other.start - (item.start + item.duration)) < 0.002
                : Math.abs(other.start + other.duration - item.start) < 0.002),
          );
          if (!neighbor) return Edit.trimEdge(project, item.id, drag.edge, edgeDelta);
          return drag.edge === 'end'
            ? Edit.rollEdit(project, item.id, neighbor.id, edgeDelta)
            : Edit.rollEdit(project, neighbor.id, item.id, edgeDelta);
        };
        result = rollPair(clip);
        for (const partner of partners) rollPair(partner);
      } else if (drag.op === 'ripple') {
        result = Edit.rippleTrim(project, clip.id, drag.edge, edgeDelta, {
          alsoTrim: partners.map((item) => item.id),
        });
      } else {
        result = Edit.trimEdge(project, clip.id, drag.edge, edgeDelta);
        if (result.ok)
          for (const partner of partners)
            Edit.trimEdge(project, partner.id, drag.edge, result.delta);
      }
    }
    if (result && result.ok) state.project = project;
    else state.project = cloneProject(drag.base);
    return result || { ok: false, reason: 'Nothing changed.' };
  }

  function moveClipDrag(event) {
    const drag = state.drag;
    if (!drag || drag.type !== 'clip') return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) < 3 && (drag.op !== 'move' || Math.abs(dy) < 6)) return;
    drag.moved = true;
    drag.lastEvent = { clientX: event.clientX, clientY: event.clientY };
    if (drag.frame) return;
    drag.frame = requestAnimationFrame(() => {
      drag.frame = 0;
      if (state.drag !== drag || !drag.lastEvent) return;
      const delta = (drag.lastEvent.clientX - drag.startX) / state.pxPerSecond;
      drag.result = applyDrag(drag, delta, drag.lastEvent);
      state.currentTime = clamp(state.currentTime, 0, Math.max(projectDuration(), 0));
      renderTimeline();
      showSnapLine(drag.snapAt);
      renderInspector();
      // Redraw the Program monitor only when the clips around the playhead changed.
      const around = previewSignature();
      if (around !== drag.previewSignature) {
        drag.previewSignature = around;
        renderPreview();
      }
      setStatus(drag.result.ok ? dragStatus(drag) : drag.result.reason);
    });
  }

  function previewSignature() {
    const time = state.currentTime;
    const margin = Number(transitionCore?.MAX_TRANSITION_SECONDS) || 2;
    return JSON.stringify(
      state.project.clips
        .filter((clip) => clip.start - margin <= time && clip.start + clip.duration + margin > time)
        .map((clip) => [
          clip.id,
          clip.track,
          clip.start,
          clip.duration,
          clip.in,
          clip.speed,
          clip.reverse,
          clip.hold,
        ]),
    );
  }

  function dragStatus(drag) {
    const names = {
      move: 'Move',
      trim: 'Trim',
      ripple: 'Ripple edit',
      roll: 'Rolling edit',
      slip: 'Slip',
      slide: 'Slide',
    };
    const result = drag.result || {};
    const amount = result.delta ?? result.change ?? null;
    return `${names[drag.op] || 'Edit'}${amount != null ? ` ${amount >= 0 ? '+' : ''}${formatClock(Math.abs(amount), true)}` : ''}`;
  }

  function showSnapLine(time) {
    let line = elements.timeline.querySelector?.('.av-snap-line');
    if (time == null) {
      line?.remove?.();
      return;
    }
    if (!line) {
      line = document.createElement('span');
      line.className = 'av-snap-line';
      line.setAttribute('aria-hidden', 'true');
      elements.timeline.append(line);
    }
    line.style.left = `${HEADER_WIDTH + time * state.pxPerSecond}px`;
    // A short flash each time the edit locks onto a new point.
    if (line.dataset.time !== String(time)) {
      line.dataset.time = String(time);
      if (!reducedMotion() && typeof line.animate === 'function') {
        line.animate(
          [
            { opacity: 1, transform: 'scaleX(3)', filter: 'brightness(1.8)' },
            { opacity: 1, transform: 'scaleX(1)', filter: 'none' },
          ],
          { duration: 160, easing: 'ease-out' },
        );
      }
    }
  }

  function endClipDrag(cancelled = false) {
    const drag = state.drag;
    if (!drag || drag.type !== 'clip') return;
    if (drag.frame) cancelAnimationFrame(drag.frame);
    // Apply the last pointer position synchronously so a fast release is not lost.
    if (!cancelled && drag.moved && drag.lastEvent) {
      drag.result = applyDrag(
        drag,
        (drag.lastEvent.clientX - drag.startX) / state.pxPerSecond,
        drag.lastEvent,
      );
    }
    state.drag = null;
    showSnapLine(null);
    if (cancelled || !drag.moved || !drag.result || !drag.result.ok) {
      state.project = drag.base;
      if (drag.moved) {
        state.suppressClick = true;
        setStatus(cancelled ? 'Edit cancelled' : drag.result?.reason || 'Nothing changed');
      }
      renderAll();
      return;
    }
    state.suppressClick = true;
    const labels = {
      move: 'Clip moved',
      trim: 'Clip trimmed',
      ripple: 'Ripple edit',
      roll: 'Rolling edit',
      slip: 'Slip edit',
      slide: 'Slide edit',
    };
    if (snapshot() !== drag.before) {
      pushHistory(drag.before, labels[drag.op] || 'Edit');
      markDirty(labels[drag.op] || 'Edit');
      setStatus(drag.op === 'move' ? 'Clip position updated' : `${labels[drag.op]} updated`);
    }
    pruneClipElements();
    renderAll();
  }

  function timelineTimeFromPointer(event, target) {
    const rect = target.getBoundingClientRect();
    return clamp(
      (event.clientX - rect.left) / state.pxPerSecond,
      0,
      Math.min(timelineDuration(), LIMITS.maxProjectSeconds),
    );
  }

  function startPlayheadDrag(event) {
    if (event.button !== 0 || state.rendering) return;
    event.preventDefault();
    pause();
    state.drag = { type: 'playhead', pointerId: event.pointerId, startTime: state.currentTime };
    elements.playhead.setPointerCapture?.(event.pointerId);
    movePlayheadDrag(event);
  }

  // Scrubbing moves the playhead at once but draws at most one preview frame per display frame.
  function movePlayheadDrag(event) {
    const drag = state.drag;
    if (!drag || drag.type !== 'playhead') return;
    state.currentTime = snapToFrame(timelineTimeFromPointer(event, elements.ruler));
    updatePlayhead();
    if (drag.frame) return;
    drag.frame = requestAnimationFrame(() => {
      drag.frame = 0;
      renderPreview();
      syncPreviewMedia(false);
    });
  }

  function endPlayheadDrag(cancelled = false) {
    const drag = state.drag;
    if (!drag || drag.type !== 'playhead') return;
    if (drag.frame) cancelAnimationFrame(drag.frame);
    state.drag = null;
    if (cancelled && drag.startTime != null) {
      state.currentTime = drag.startTime;
      updatePlayhead();
      renderPreview();
      syncPreviewMedia(false);
      setStatus('Scrub cancelled');
      return;
    }
    if (drag.frame || drag.previewFactor) {
      renderPreview();
      syncPreviewMedia(false);
    }
  }

  function trackAction(trackId, action) {
    const track = getTrack(trackId);
    if (!track) return;
    if (action === 'remove') {
      const count = state.project.clips.filter((clip) => clip.track === trackId).length;
      if (
        count &&
        !window.confirm(`Remove ${trackId} and its ${count} clip${count === 1 ? '' : 's'}?`)
      )
        return;
      let result = null;
      mutate(`Track ${trackId} removed`, () => {
        result = Edit.removeTrack(state.project, trackId);
        return result.ok;
      });
      pruneClipElements();
      setStatus(result && result.ok ? `${trackId} removed` : result?.reason || 'Track kept');
      return;
    }
    const field = { lock: 'locked', hide: 'hidden', mute: 'muted', solo: 'solo' }[action];
    if (!field) return;
    mutate(`${trackId} ${action}`, () => {
      track[field] = !track[field];
    });
    refreshTrackAudio();
    syncPreviewMedia(state.playing);
    renderPreview();
    setStatus(
      `${trackId} ${track[field] ? { locked: 'locked', hidden: 'hidden', muted: 'muted', solo: 'soloed' }[field] : { locked: 'unlocked', hidden: 'shown', muted: 'unmuted', solo: 'unsoloed' }[field]}`,
    );
  }

  function addTrack(kind) {
    let result = null;
    mutate(`${kind === 'video' ? 'Video' : 'Audio'} track added`, () => {
      result = Edit.addTrack(state.project, kind);
      return result.ok;
    });
    setStatus(
      result && result.ok ? `${result.trackId} added` : result?.reason || 'Track not added',
    );
  }

  const TOOL_CURSORS = Object.freeze({
    razor: 'crosshair',
    slip: 'col-resize',
    slide: 'col-resize',
  });
  let hoveredClip = null;
  function applyToolCursor(item) {
    if (item?.style) item.style.cursor = TOOL_CURSORS[state.tool] || '';
  }
  root.addEventListener?.('pointerover', (event) => {
    const item = event.target.closest?.('.av-timeline-clip');
    if (!item || item === hoveredClip) return;
    hoveredClip = item;
    applyToolCursor(item);
  });

  function setTool(tool) {
    if (!TOOLS[tool]) return;
    state.tool = tool;
    root.dataset.activeTool = tool;
    for (const button of $$('button[data-tool]'))
      button.setAttribute('aria-pressed', button.dataset.tool === tool ? 'true' : 'false');
    applyToolCursor(hoveredClip);
    setStatus(`${TOOL_LABELS[tool]} tool (${TOOLS[tool]})`);
  }

  // ------------------------------------------------------- markers, in/out

  function addMarkerAtPlayhead() {
    let result = null;
    mutate('Marker added', () => {
      result = Edit.addMarker(state.project, snapToFrame(state.currentTime), uid);
      return result.ok;
    });
    setStatus(
      result && result.ok
        ? `Marker at ${formatClock(result.marker.time, true)}`
        : result?.reason || 'Marker not added',
    );
    renderMarkerList();
  }

  function goToMarker(direction) {
    const marker = Edit.adjacentMarker(state.project, state.currentTime, direction);
    if (!marker) {
      setStatus(direction > 0 ? 'No later marker' : 'No earlier marker');
      return;
    }
    seek(marker.time);
    setStatus(`${marker.name || 'Marker'} · ${formatClock(marker.time, true)}`);
  }

  function goToEditPoint(direction) {
    const point = Edit.adjacentEditPoint(state.project, state.currentTime, direction);
    if (point == null) return;
    seek(point);
  }

  function setInOut(which, value) {
    mutate(
      which === 'in'
        ? value == null
          ? 'In point cleared'
          : 'In point set'
        : value == null
          ? 'Out point cleared'
          : 'Out point set',
      () => {
        const next =
          which === 'in'
            ? Edit.normalizeInOut(value, state.project.outPoint)
            : Edit.normalizeInOut(state.project.inPoint, value);
        if (which === 'out' && value != null && next.outPoint == null) return false;
        Object.assign(state.project, next);
        return true;
      },
    );
    const { inPoint, outPoint } = state.project;
    setStatus(
      `In ${inPoint == null ? '—' : formatClock(inPoint, true)} · Out ${outPoint == null ? '—' : formatClock(outPoint, true)}`,
    );
  }

  function markIn() {
    if (state.monitor === 'source' && state.source) {
      markSource('in');
      return;
    }
    setInOut('in', snapToFrame(state.currentTime));
  }

  function markOut() {
    if (state.monitor === 'source' && state.source) {
      markSource('out');
      return;
    }
    setInOut('out', snapToFrame(state.currentTime + 1 / fps()));
  }

  function liftOrExtract(extract) {
    const { inPoint, outPoint } = state.project;
    const start = inPoint ?? 0;
    const end = outPoint ?? null;
    if (end == null) {
      setStatus('Set an out point (O) first');
      return;
    }
    let result = null;
    mutate(extract ? 'Extract' : 'Lift', () => {
      result = extract
        ? Edit.extractRange(state.project, start, end, { makeId: uid })
        : Edit.liftRange(state.project, start, end, { makeId: uid });
      return result.ok;
    });
    pruneClipElements();
    setStatus(
      result && result.ok
        ? extract
          ? `Extracted ${formatClock(end - start, true)}`
          : `Lifted ${formatClock(end - start, true)}`
        : result?.reason || 'Nothing between in and out',
    );
  }

  function renderMarkerList() {
    const list = elements.markerList;
    if (!list) return;
    list.replaceChildren();
    if (!state.project.markers.length) {
      const empty = document.createElement('li');
      empty.className = 'av-list-empty';
      empty.textContent = 'No markers. Press M at the playhead.';
      list.append(empty);
      return;
    }
    for (const marker of state.project.markers) {
      const item = document.createElement('li');
      item.className = `av-marker-item av-marker-${marker.color}`;
      const go = document.createElement('button');
      go.type = 'button';
      go.dataset.markerGo = marker.id;
      go.textContent = formatClock(marker.time, true);
      const name = document.createElement('input');
      name.type = 'text';
      name.maxLength = 80;
      name.value = marker.name;
      name.placeholder = 'Marker name';
      name.dataset.markerName = marker.id;
      name.setAttribute('aria-label', `Name for marker at ${formatClock(marker.time, true)}`);
      const color = document.createElement('select');
      color.dataset.markerColor = marker.id;
      color.setAttribute('aria-label', 'Marker color');
      for (const value of Edit.MARKER_COLORS) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        if (value === marker.color) option.selected = true;
        color.append(option);
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.dataset.markerRemove = marker.id;
      remove.textContent = '×';
      remove.setAttribute('aria-label', 'Delete marker');
      item.append(go, name, color, remove);
      list.append(item);
    }
  }

  // --------------------------------------------------------------- media bin

  function renderMediaBin() {
    if (!elements.mediaBin) return;
    elements.mediaBin.innerHTML = '';
    // A list only while it holds media items; the empty state (text and a button) is not a list.
    if (state.project.assets.length) elements.mediaBin.setAttribute('role', 'list');
    else elements.mediaBin.removeAttribute('role');
    if (!state.project.assets.length) {
      elements.mediaBin.innerHTML =
        '<div class="av-empty-state"><strong>No media yet</strong><span>Import or drop a video, audio file, or still image.</span><button type="button" class="av-link-button" data-action="load-sample">Try the sample project</button></div>';
      return;
    }

    for (const asset of state.project.assets) {
      const runtime = state.runtimeAssets.get(asset.id);
      const item = document.createElement('div');
      item.className = 'av-media-item';
      item.dataset.assetId = asset.id;
      item.setAttribute('role', 'listitem');
      item.draggable = Boolean(runtime);
      if (state.source && state.source.assetId === asset.id) item.classList.add('is-source');

      const thumb = document.createElement('div');
      thumb.className = 'av-media-thumb';
      if (asset.kind === 'image' && runtime?.image) {
        const image = runtime.image.cloneNode();
        image.alt = '';
        thumb.append(image);
      } else if (asset.kind === 'video' && runtime) {
        const video = document.createElement('video');
        video.src = runtime.objectUrl;
        video.muted = true;
        video.preload = 'metadata';
        const poster = thumbnailAt(asset.id, 0);
        if (poster) video.poster = poster;
        thumb.append(video);
      } else {
        thumb.textContent = asset.kind === 'audio' ? 'AUDIO' : runtime ? 'VIDEO' : 'OFFLINE';
      }

      const info = document.createElement('div');
      info.className = 'av-media-info';
      const title = document.createElement('strong');
      title.textContent = asset.name;
      title.title = asset.name;
      const meta = document.createElement('span');
      const sound =
        asset.kind === 'video'
          ? asset.hasAudio === false
            ? ' · no sound'
            : asset.hasAudio
              ? ' · sound'
              : ''
          : '';
      const rate = asset.fps ? ` · ${Math.round(asset.fps * 100) / 100} fps` : '';
      meta.textContent = `${asset.kind.toUpperCase()} · ${asset.duration ? formatClock(asset.duration) : 'unknown'} · ${formatBytes(asset.size)}${asset.width ? ` · ${asset.width}×${asset.height}` : ''}${rate}${sound}${runtime ? '' : ' · relink needed'}`;
      const actions = document.createElement('div');
      actions.className = 'av-media-actions';

      const trackOptions = asset.kind === 'audio' ? ['A1'] : ['V1', 'V2'];
      for (const track of trackOptions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = `Add ${track}`;
        button.disabled = !runtime;
        button.addEventListener('click', () => addAssetToTrack(asset.id, track));
        actions.append(button);
      }
      if (runtime) {
        const source = document.createElement('button');
        source.type = 'button';
        source.textContent = 'Source';
        source.title = 'Open in the Source monitor to mark in/out and insert or overwrite';
        source.addEventListener('click', () => loadSource(asset.id));
        actions.append(source);
      }
      if (!runtime) {
        const hint = document.createElement('button');
        hint.type = 'button';
        hint.textContent = 'Relink';
        hint.addEventListener('click', () => {
          if (state.projectIO || state.importing || state.rendering) {
            setStatus('Wait for the current operation to finish.');
            return;
          }
          const project = state.project;
          const chooser = document.createElement('input');
          chooser.type = 'file';
          chooser.accept = `${asset.kind}/*`;
          chooser.addEventListener('change', () => {
            if (state.project !== project) {
              setStatus('The active project changed; choose its media again.');
              return;
            }
            return importMedia(chooser.files, asset.id);
          });
          chooser.click();
        });
        actions.append(hint);
      }

      info.append(title, meta, actions);
      item.append(thumb, info);
      item.addEventListener('dragstart', (event) => {
        if (!runtime || !event.dataTransfer) return;
        event.dataTransfer.setData('application/x-alcorvideo-asset', asset.id);
        event.dataTransfer.effectAllowed = 'copy';
      });
      item.addEventListener('dblclick', () => {
        if (runtime) loadSource(asset.id);
      });
      elements.mediaBin.append(item);
    }
  }

  // Drop a bin item on a lane: overwrite at the drop point (Ctrl/Cmd inserts).
  function dropAsset(event, lane) {
    const assetId = event.dataTransfer?.getData('application/x-alcorvideo-asset');
    const asset = assetId && getAsset(assetId);
    if (!asset) return false;
    const time = state.snap
      ? snapTimeTo(timelineTimeFromPointer(event, lane))
      : snapToFrame(timelineTimeFromPointer(event, lane));
    const laneKind = lane.dataset.kind;
    const kind = asset.kind === 'audio' ? 'audio' : 'video';
    const clips = clipsFromAsset(asset, {
      start: time,
      track: laneKind === kind ? lane.dataset.trackLane : defaultTrackFor(asset.kind),
      audioTrack:
        laneKind === 'audio' && kind === 'video'
          ? lane.dataset.trackLane
          : defaultTrackFor('audio'),
    });
    const insert = event.ctrlKey || event.metaKey;
    let result = null;
    mutate(insert ? 'Insert edit' : 'Overwrite edit', () => {
      result = insert
        ? Edit.insertEdit(state.project, clips, time, { makeId: uid })
        : Edit.overwriteEdit(state.project, clips, time, { makeId: uid });
      if (!result.ok) return false;
      selectIds([clips[0].id], clips[0].id);
      return true;
    });
    setStatus(
      result && result.ok
        ? `${asset.name} ${insert ? 'inserted' : 'placed'} at ${formatClock(time, true)}`
        : result?.reason || 'Drop failed',
    );
    return true;
  }

  // Media dropped below the last track goes onto new tracks (a video track, plus an
  // audio track for its sound), at the drop time, like Premiere.
  async function dropOnNewTrack(event, lane) {
    const time = snapToFrame(timelineTimeFromPointer(event, lane));
    const assetId = event.dataTransfer?.getData('application/x-alcorvideo-asset');
    let assets = [];
    if (assetId && getAsset(assetId)) assets = [getAsset(assetId)];
    else if (event.dataTransfer?.files?.length) {
      const before = new Set(state.project.assets.map((asset) => asset.id));
      await importMedia(event.dataTransfer.files, null, true);
      assets = state.project.assets.filter(
        (asset) => !before.has(asset.id) && state.runtimeAssets.has(asset.id),
      );
    }
    let at = time;
    for (const asset of assets) {
      let placed = null;
      let reason = '';
      mutate('Clip on new track', () => {
        const added = Edit.addTrack(state.project, asset.kind === 'audio' ? 'audio' : 'video');
        if (!added.ok) {
          reason = added.reason;
          return false;
        }
        let audioTrack = null;
        if (asset.kind === 'video' && asset.hasAudio !== false) {
          const audio = Edit.addTrack(state.project, 'audio');
          // Never fall back to overwriting sound on an existing track.
          if (!audio.ok) {
            reason = `${audio.reason || 'No room for another audio track'}. Drop onto an existing track instead.`;
            return false;
          }
          audioTrack = audio.trackId;
        }
        const clips = clipsFromAsset(asset, {
          start: at,
          track: added.trackId,
          audioTrack: audioTrack || undefined,
        });
        const result = Edit.overwriteEdit(state.project, clips, at, { makeId: uid });
        if (!result.ok) {
          reason = result.reason;
          return false;
        }
        selectIds([clips[0].id], clips[0].id);
        placed = clips;
        return true;
      });
      if (!placed) {
        setStatus(reason || 'The media could not be placed on a new track');
        return;
      }
      setStatus(
        `${asset.name} placed on new track ${placed[0].track}${placed[1] ? ` with sound on ${placed[1].track}` : ''}`,
      );
      at = round(at + placed[0].duration);
    }
  }

  // ---------------------------------------------------------- source monitor

  function sourceElement(asset) {
    let element = elements.sourceVideo;
    const wanted = asset.kind === 'image' ? 'IMG' : asset.kind === 'audio' ? 'AUDIO' : 'VIDEO';
    if (!element || element.tagName !== wanted) {
      element?.remove?.();
      element = document.createElement(
        asset.kind === 'image' ? 'img' : asset.kind === 'audio' ? 'audio' : 'video',
      );
      element.id = 'av-source-video';
      element.className = 'av-source-media';
      if (asset.kind !== 'image') {
        element.controls = true;
        element.preload = 'auto';
        element.playsInline = true;
      }
      elements.monitorWrap?.append(element);
      elements.sourceVideo = element;
    }
    return element;
  }

  function loadSource(assetId) {
    const asset = getAsset(assetId);
    const runtime = state.runtimeAssets.get(assetId);
    if (!asset || !runtime) return;
    pause(false);
    state.source = { assetId, in: null, out: null };
    const element = sourceElement(asset);
    element.src = runtime.objectUrl;
    element.hidden = false;
    state.monitor = 'source';
    root.dataset.monitor = 'source';
    elements.canvas.hidden = true;
    if (elements.monitorMessage) elements.monitorMessage.style.display = 'none';
    updateSourceInfo();
    renderMediaBin();
    setStatus(
      `Source: ${asset.name}. Mark In (I) and Out (O), then Insert (,) or Overwrite (.) at the playhead.`,
    );
  }

  function showProgram() {
    if (state.monitor === 'program') return;
    elements.sourceVideo?.pause?.();
    if (elements.sourceVideo) elements.sourceVideo.hidden = true;
    state.monitor = 'program';
    root.dataset.monitor = 'program';
    elements.canvas.hidden = false;
    updateSourceInfo();
    renderPreview();
  }

  function updateSourceInfo() {
    const info = elements.sourceInfo;
    const asset = state.source && getAsset(state.source.assetId);
    for (const button of $$('[data-action="monitor-source"], [data-action="monitor-program"]')) {
      const active = (button.dataset.action === 'monitor-source') === (state.monitor === 'source');
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      if (button.dataset.action === 'monitor-source') button.disabled = !asset;
    }
    if (!info) return;
    if (state.monitor !== 'source' || !asset) {
      info.textContent = '';
      info.hidden = true;
      return;
    }
    info.hidden = false;
    const inText = state.source.in == null ? 'start' : formatClock(state.source.in, true);
    const outText = state.source.out == null ? 'end' : formatClock(state.source.out, true);
    info.textContent = `${asset.name} · In ${inText} · Out ${outText}`;
  }

  function markSource(which) {
    const element = elements.sourceVideo;
    const asset = state.source && getAsset(state.source.assetId);
    if (!asset || !element) return;
    const time =
      asset.kind === 'image' ? (which === 'in' ? 0 : 5) : Number(element.currentTime) || 0;
    if (which === 'in') state.source.in = round(time);
    else state.source.out = round(time);
    if (state.source.in != null && state.source.out != null && state.source.out <= state.source.in)
      state.source.out = null;
    updateSourceInfo();
  }

  function editFromSource(overwrite) {
    const asset = state.source && getAsset(state.source.assetId);
    if (!asset) {
      setStatus('Open a bin item in the Source monitor first (Source button or double-click)');
      return;
    }
    const sourceIn = state.source.in ?? 0;
    const sourceOut = state.source.out ?? (asset.kind === 'image' ? sourceIn + 5 : asset.duration);
    if (!(sourceOut - sourceIn >= MIN_CLIP_DURATION)) {
      setStatus('The source range is too short');
      return;
    }
    const at = round(state.currentTime);
    const clips = clipsFromAsset(asset, {
      start: at,
      sourceIn,
      sourceOut: asset.kind === 'image' ? null : sourceOut,
    });
    if (asset.kind === 'image') clips[0].duration = round(sourceOut - sourceIn);
    let result = null;
    mutate(overwrite ? 'Overwrite edit' : 'Insert edit', () => {
      result = overwrite
        ? Edit.overwriteEdit(state.project, clips, at, { makeId: uid })
        : Edit.insertEdit(state.project, clips, at, { makeId: uid });
      if (!result.ok) return false;
      selectIds([clips[0].id], clips[0].id);
      state.currentTime = round(at + clips[0].duration);
      return true;
    });
    setStatus(
      result && result.ok
        ? `${overwrite ? 'Overwrote' : 'Inserted'} ${formatClock(clips[0].duration, true)} of ${asset.name} at ${formatClock(at, true)}`
        : result?.reason || 'Edit failed',
    );
  }

  // --------------------------------------------------------------- compositor

  function sourceTimeForPicture(clip, time) {
    if (clip.hold != null) return Math.max(0, clip.hold);
    // Outside the clip window (transition handles) keep reading source beyond in/out.
    const local = time - clip.start;
    if (clip.timeRemap && effectsCore)
      return Math.max(0, clip.in + effectsCore.remapOffset(clip.timeRemap, local));
    const offset = clip.reverse ? clip.duration - local : local;
    return Math.max(0, clip.in + offset * clip.speed);
  }

  function hexToRgba(hexValue, alpha) {
    const clean = String(hexValue || '#000000').replace('#', '');
    const value = parseInt(clean, 16);
    const r = (value >> 16) & 255;
    const g = (value >> 8) & 255;
    const b = value & 255;
    return `rgba(${r},${g},${b},${clamp(alpha, 0, 1)})`;
  }

  // Playback speed of a clip at a timeline time (speed ramps change it over time).
  function clipSpeedAt(clip, time) {
    return clip.timeRemap && effectsCore
      ? effectsCore.remapSpeedAt(clip.timeRemap, time - clip.start)
      : clip.speed;
  }

  let effectsRenderer;
  let effectsWarning = '';
  function getEffectsRenderer() {
    const module = window.AlcorVideoEffectsRender;
    if (!module) return null;
    if (effectsRenderer === undefined || (effectsRenderer && effectsRenderer.lost))
      effectsRenderer = module.createRenderer(document);
    return effectsRenderer;
  }

  // Resolved effects of a clip at a timeline time: pixel passes and an optional drop shadow.
  function clipEffectsAt(clip, time) {
    if (!effectsCore || !Array.isArray(clip.effects) || !clip.effects.length) return null;
    const bypass =
      state.eyedropper && state.eyedropper.clipId === clip.id ? state.eyedropper.effectId : '';
    const active = effectsCore
      .activeEffects(clip, clamp(time - clip.start, 0, clip.duration))
      .filter((effect) => effect.id !== bypass && effectsCore.isEffective(effect));
    const pixel = active.filter((effect) => effectsCore.PIXEL_EFFECTS.includes(effect.type));
    const shadow = active.filter((effect) => effect.type === 'drop-shadow').pop() || null;
    return pixel.length || shadow ? { pixel, shadow } : null;
  }

  // Reused 2D layers: 0 = pre-graded, 1 = veiled.
  const scratchLayers = [];
  function scratchLayer(index, width, height) {
    const canvas =
      scratchLayers[index] || (scratchLayers[index] = document.createElement('canvas'));
    if (canvas.width !== width || canvas.height !== height)
      Object.assign(canvas, { width, height });
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, width, height);
    return [canvas, context];
  }

  function drawTransformedMedia(context, media, width, height, clip, time, veil = null) {
    const sourceWidth =
      media.videoWidth || media.naturalWidth || media.displayWidth || media.width || 0;
    const sourceHeight =
      media.videoHeight || media.naturalHeight || media.displayHeight || media.height || 0;
    const transform = transformCore.resolveMediaTransformAtTime(
      clip,
      clamp(time, clip.start, clip.start + clip.duration),
      sourceWidth,
      sourceHeight,
      width,
      height,
    );
    if (!transform) return false;
    // White balance, tonal zones, vibrance, wheels, HSL, curves and LUTs grade on the GPU
    // at full resolution when WebGL2 exists; plain brightness/contrast/saturation keep the
    // cheaper canvas filter. Without WebGL2 the bounded software path is used.
    const extras = gradeExtras(clip);
    const color = colorCore.normalizeColor(clip);
    const renderWidth = Math.min(
      sourceWidth,
      Math.max(2, Math.round(Math.abs(transform.drawWidth))),
    );
    const renderHeight = Math.min(
      sourceHeight,
      Math.max(2, Math.round(Math.abs(transform.drawHeight))),
    );
    let graded = null;
    if (extras || colorCore.requiresSoftware(color)) {
      const renderer = getGradeRenderer();
      if (renderer) {
        graded = renderer.render(media, renderWidth, renderHeight, color, extras || {});
      } else if (extras && !gradeWarning) {
        gradeWarning =
          'This browser has no WebGL2, so curves, LUTs, wheels and vibrance are not shown or exported.';
        setStatus(gradeWarning);
      }
    }
    // Effect stack (blur, key, crop...) on the graded layer, at the drawn size; Basic
    // colour goes first so a key sees what the monitor shows.
    const effects = clipEffectsAt(clip, time);
    if (effects && effects.pixel.length && !graded && colorCore.toCanvasFilter(clip) !== 'none') {
      const [canvas, scratch] = scratchLayer(0, renderWidth, renderHeight);
      if (colorCore.drawImageWithColor(scratch, media, 0, 0, renderWidth, renderHeight, clip))
        graded = canvas;
      scratch.filter = 'none';
    }
    let layer = graded || media;
    let effected = false;
    if (effects && effects.pixel.length) {
      if (!window.AlcorVideoEffectsRender) {
        loadGroup('effects').then((loaded) => {
          if (loaded && !state.rendering) renderPreview();
        });
      } else {
        const scale = renderWidth / Math.max(1, Math.abs(transform.drawWidth));
        const renderer = getEffectsRenderer();
        let output = renderer
          ? renderer.render(layer, renderWidth, renderHeight, effects.pixel, scale)
          : null;
        if (!renderer) {
          if (!effectsWarning) {
            effectsWarning =
              'This browser has no WebGL2: video effects render at reduced resolution.';
            setStatus(effectsWarning);
          }
          output = window.AlcorVideoEffectsRender.renderSoftware(
            document,
            layer,
            renderWidth,
            renderHeight,
            effects.pixel,
            scale,
          );
        }
        if (output) {
          layer = output;
          effected = true;
        }
      }
    }
    // A dip veil covers only the effected layer's pixels, not keyed/cropped areas.
    if (effected && veil && veil.alpha > 0) {
      const [canvas, scratch] = scratchLayer(1, renderWidth, renderHeight);
      scratch.drawImage(layer, 0, 0, renderWidth, renderHeight);
      Object.assign(scratch, {
        globalCompositeOperation: 'source-atop',
        globalAlpha: clamp(veil.alpha, 0, 1),
        fillStyle: veil.color,
      });
      scratch.fillRect(0, 0, renderWidth, renderHeight);
      Object.assign(scratch, { globalCompositeOperation: 'source-over', globalAlpha: 1 });
      layer = canvas;
      veil = null;
    }
    const anchor = effectsCore ? effectsCore.normalizeAnchor(clip) : { anchorX: 50, anchorY: 50 };
    const left = (-transform.drawWidth * anchor.anchorX) / 100;
    const top = (-transform.drawHeight * anchor.anchorY) / 100;
    context.save();
    context.filter = graded ? 'none' : colorCore.toCanvasFilter(clip);
    if (effectsCore && clip.blendMode)
      context.globalCompositeOperation = effectsCore.compositeOperation(clip.blendMode);
    if (effects && effects.shadow) {
      // Canvas shadows ignore the transform, so scale them to device pixels here.
      const matrix =
        typeof context.getTransform === 'function' ? context.getTransform() : { a: 1, b: 0 };
      const device = Math.hypot(matrix.a, matrix.b) || 1;
      const params = effects.shadow.params;
      const offset = effectsCore.shadowOffset(params);
      context.shadowColor = hexToRgba(params.color, params.opacity / 100);
      context.shadowOffsetX = offset.x * device;
      context.shadowOffsetY = offset.y * device;
      context.shadowBlur = (params.softness * device) / 2;
    }
    context.translate(transform.centerX, transform.centerY);
    context.rotate(transform.rotationRadians);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    try {
      if (graded) context.drawImage(layer, left, top, transform.drawWidth, transform.drawHeight);
      else if (
        !colorCore.drawImageWithColor(
          context,
          layer,
          left,
          top,
          transform.drawWidth,
          transform.drawHeight,
          clip,
        )
      )
        return false;
      if (veil && veil.alpha > 0) {
        context.filter = 'none';
        context.shadowColor = 'transparent';
        context.globalCompositeOperation = 'source-over';
        context.globalAlpha *= clamp(veil.alpha, 0, 1);
        context.fillStyle = veil.color;
        context.fillRect(left, top, transform.drawWidth, transform.drawHeight);
      }
      return true;
    } catch (_) {
      return false;
    } finally {
      context.restore();
    }
  }

  function wrapLines(context, text, maxWidth) {
    const lines = [];
    for (const paragraph of String(text || '').split('\n')) {
      const words = paragraph.split(/\s+/).filter(Boolean);
      let line = '';
      for (const word of words) {
        const next = line ? `${line} ${word}` : word;
        if (line && context.measureText(next).width > maxWidth) {
          lines.push(line);
          line = word;
        } else {
          line = next;
        }
      }
      lines.push(line);
    }
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return lines.slice(0, 8);
  }

  function drawTitle(context, clip, width, height, alpha = 1) {
    const fontSize = Math.max(12, Number(clip.size) || 64) * (height / 720);
    context.save();
    context.globalAlpha = clamp(alpha, 0, 1);
    context.font = `${clip.italic ? 'italic ' : ''}${clip.bold ? 800 : 500} ${fontSize}px ${TITLE_FONTS[clip.font] || TITLE_FONTS.sans}`;
    const align = clip.align || 'center';
    context.textAlign = align;
    context.textBaseline = 'middle';
    const lines = wrapLines(context, clip.text, width * 0.86);
    if (!lines.length) {
      context.restore();
      return;
    }
    const lineHeight = fontSize * 1.16;
    const totalHeight = lines.length * lineHeight;
    const anchorX = width * (clamp(clip.x == null ? 50 : clip.x, 0, 100) / 100);
    const centerY = height * (clamp(clip.y, 0, 100) / 100);
    const widest = Math.max(...lines.map((line) => context.measureText(line).width));
    const left =
      align === 'left' ? anchorX : align === 'right' ? anchorX - widest : anchorX - widest / 2;
    if (clip.backgroundOpacity > 0) {
      context.fillStyle = hexToRgba(clip.background, clip.backgroundOpacity);
      const padX = fontSize * 0.48;
      const padY = fontSize * 0.3;
      context.fillRect(
        left - padX,
        centerY - totalHeight / 2 - padY,
        widest + padX * 2,
        totalHeight + padY * 2,
      );
    }
    if (clip.shadow !== false) {
      context.shadowColor = 'rgba(0,0,0,.45)';
      context.shadowBlur = fontSize * 0.12;
    }
    lines.forEach((line, index) => {
      const y = centerY - totalHeight / 2 + lineHeight * (index + 0.5);
      if (clip.strokeWidth > 0) {
        context.lineJoin = 'round';
        context.lineWidth = clip.strokeWidth * 2 * (height / 720);
        context.strokeStyle = clip.stroke || '#000000';
        context.strokeText(line, anchorX, y);
      }
      context.fillStyle = clip.color;
      context.fillText(line, anchorX, y);
    });
    context.restore();
  }

  function visualActive(clip, time, visible) {
    if (!visible.has(clip.track)) return false;
    if (clip.kind === 'title') return time >= clip.start && time < clip.start + clip.duration;
    return transitionCore.visualActiveAt(clip, time, state.project.clips, state.project.assets);
  }

  // Draw the sequence at `time` into a 2D context of any size. Preview and export
  // share this function so what you see is what you export.
  function drawComposite(context, time, options = {}) {
    const project = state.project;
    const outWidth = options.width || project.width;
    const outHeight = options.height || project.height;
    const fit = Math.min(outWidth / project.width, outHeight / project.height);
    const offsetX = (outWidth - project.width * fit) / 2;
    const offsetY = (outHeight - project.height * fit) / 2;
    context.save();
    context.globalAlpha = 1;
    context.fillStyle = '#000000';
    context.fillRect(0, 0, outWidth, outHeight);
    context.translate(offsetX, offsetY);
    context.scale(fit, fit);
    const width = project.width;
    const height = project.height;
    context.fillStyle = project.background;
    context.fillRect(0, 0, width, height);

    const visible = Edit.visibleTrackIds(project);
    const visuals = project.clips
      .filter((clip) => clip.kind !== 'audio' && visualActive(clip, time, visible))
      .sort((a, b) => Edit.trackNumber(a.track) - Edit.trackNumber(b.track) || a.start - b.start);

    let drawnCount = 0;
    for (const clip of visuals) {
      if (clip.kind === 'title') {
        drawTitle(context, clip, width, height, timelineCore.fadeEnvelope(clip, time));
        drawnCount += 1;
        continue;
      }
      const entry = runtimeForClip(clip, options.entries || null);
      if (!entry) continue;
      const media = entry.frame || entry.element;
      if (!media) continue;
      if (!entry.frame && clip.kind === 'video' && media.readyState < 2) continue;
      if (clip.kind === 'image' && !media.complete) continue;
      const transition = transitionCore.visualTransitionState(
        clip,
        time,
        project.clips,
        project.assets,
      );
      const nominal = time >= clip.start && time < clip.start + clip.duration;
      const fades = nominal ? timelineCore.fadeEnvelope(clip, time) : 1;
      const opacity = transformCore.resolveTransformAtTime(
        clip,
        clamp(time, clip.start, clip.start + clip.duration),
      ).opacity;
      const alpha = clamp(opacity * fades * (transition ? transition.alpha : 1), 0, 1);
      if (alpha <= 0.001) continue;
      context.save();
      context.globalAlpha = alpha;
      if (transition && transition.reveal) {
        const r = transition.reveal;
        context.beginPath();
        context.rect(r.x * width, r.y * height, r.width * width, r.height * height);
        context.clip();
      }
      if (
        drawTransformedMedia(
          context,
          media,
          width,
          height,
          clip,
          time,
          transition ? transition.veil : null,
        )
      )
        drawnCount += 1;
      context.restore();
    }
    context.restore();
    return drawnCount;
  }

  function renderFrame(time, customEntries = null) {
    // While a clip or the playhead is being dragged, a slow device previews at half resolution so the
    // gesture keeps up; the frame is redrawn at full resolution when the drag ends.
    const drag =
      !customEntries && (state.drag?.type === 'clip' || state.drag?.type === 'playhead')
        ? state.drag
        : null;
    const scale = customEntries ? 1 : state.previewScale * (drag?.previewFactor || 1);
    const startedAt = drag ? performance.now() : 0;
    const width = Math.max(2, Math.round((state.project.width * scale) / 2) * 2);
    const height = Math.max(2, Math.round((state.project.height * scale) / 2) * 2);
    if (elements.canvas.width !== width || elements.canvas.height !== height) {
      elements.canvas.width = width;
      elements.canvas.height = height;
    }
    const drawn = drawComposite(ctx, time, { width, height, entries: customEntries });
    if (drag && !drag.previewFactor && performance.now() - startedAt > 12) drag.previewFactor = 0.5;
    if (elements.monitorMessage && state.monitor === 'program')
      elements.monitorMessage.style.display = drawn ? 'none' : 'grid';
    updatePlayhead();
    if (!customEntries)
      root.dispatchEvent(
        new CustomEvent('alcorvideo:frame-rendered', { detail: { canvas: elements.canvas, time } }),
      );
  }

  function renderPreview() {
    if (state.rendering) return;
    renderFrame(state.currentTime);
  }

  // ------------------------------------------------------- preview playback

  function syncElementForClip(clip, entry, time, shouldPlay, audible, visible) {
    if (!entry || clip.kind === 'image') return;
    const element = entry.element;
    const active =
      clip.kind === 'video'
        ? visible.has(clip.track) &&
          transitionCore.visualActiveAt(clip, time, state.project.clips, state.project.assets)
        : transitionCore.audioActiveAt(clip, time, state.project.clips, state.project.assets);
    if (!active) {
      if (!element.paused) element.pause();
      return;
    }
    const desired = sourceTimeForPicture(clip, time);
    const rate = state.playRate;
    const frameSeconds = 1 / fps();
    // Frame holds, reverse clips and reverse shuttle cannot use native playback: step by seeking.
    const stepped = clip.hold != null || clip.reverse || (shouldPlay && rate < 0);
    try {
      const drift = Math.abs((element.currentTime || 0) - desired);
      const tolerance = stepped ? frameSeconds * 0.75 : shouldPlay ? 0.22 : 0.035;
      if (Number.isFinite(desired) && drift > tolerance && !(stepped && element.seeking))
        element.currentTime = desired;
    } catch (_) {}
    if (clip.kind === 'audio') {
      const gain = shouldPlay && rate < 0 ? 0 : clipAudioGain(clip, time, audible);
      const node = state.audio ? connectClipAudio(clip, entry) : null;
      if (node) {
        node.gain.gain.value = gain;
      } else {
        element.volume = clamp(gain, 0, 1);
        element.muted = gain <= 0;
      }
    }
    if (stepped) {
      if (!element.paused) element.pause();
      return;
    }
    if (clip.kind === 'audio') {
      try {
        element.preservesPitch = Boolean(clip.preservePitch);
      } catch (_) {}
    }
    element.playbackRate = clamp(clipSpeedAt(clip, time) * Math.max(1, rate), 0.0625, 16);
    if (shouldPlay && element.paused) element.play().catch(() => {});
    if (!shouldPlay && !element.paused) element.pause();
  }

  function syncPreviewMedia(shouldPlay = state.playing) {
    const used = new Set();
    const audible = Edit.audibleTrackIds(state.project);
    const visible = Edit.visibleTrackIds(state.project);
    for (const clip of state.project.clips) {
      if (!isMediaClip(clip) || clip.kind === 'image') continue;
      const entry = runtimeForClip(clip);
      if (!entry) continue;
      used.add(clip.id);
      syncElementForClip(clip, entry, state.currentTime, shouldPlay, audible, visible);
    }
    for (const [clipId, entry] of state.clipElements.entries()) {
      if (!used.has(clipId) && entry.kind !== 'image') entry.element.pause?.();
    }
  }

  function playRange() {
    const end = projectDuration();
    const { inPoint, outPoint } = state.project;
    if (state.loop && (inPoint != null || outPoint != null))
      return { start: inPoint ?? 0, end: Math.min(outPoint ?? end, end) };
    return { start: 0, end };
  }

  function play(rate = 1) {
    if (state.rendering) return;
    if (state.monitor === 'source') {
      const element = elements.sourceVideo;
      if (element && typeof element.play === 'function') {
        if (element.paused) element.play().catch(() => {});
        else element.pause();
      }
      return;
    }
    const end = projectDuration();
    if (end <= 0) {
      setStatus('Add a clip before playing');
      return;
    }
    if (state.playing && rate === state.playRate) {
      pause();
      return;
    }
    const range = playRange();
    if (rate > 0 && state.currentTime >= range.end - 0.001) state.currentTime = range.start;
    if (rate < 0 && state.currentTime <= 0.001) state.currentTime = range.end;
    const graph = ensureAudioGraph();
    if (graph && graph.context.state === 'suspended') graph.context.resume().catch(() => {});
    refreshTrackAudio();
    state.playing = true;
    state.playRate = rate;
    state.playbackStartedAt = performance.now();
    state.playbackStartedFrom = state.currentTime;
    const playButton = $('[data-action="play"]');
    if (playButton) playButton.innerHTML = ICONS.pause;
    syncPreviewMedia(true);
    cancelAnimationFrame(state.raf);
    state.raf = requestAnimationFrame(playbackFrame);
    setStatus(
      rate === 1 ? 'Playing' : `Shuttle ${rate > 0 ? 'forward' : 'reverse'} ${Math.abs(rate)}×`,
    );
  }

  let playbackTick = 0;
  function playbackFrame(now) {
    if (!state.playing) return;
    const range = playRange();
    state.currentTime =
      state.playbackStartedFrom + ((now - state.playbackStartedAt) / 1000) * state.playRate;
    if (state.playRate > 0 && state.currentTime >= range.end) {
      if (state.loop && range.end > range.start) {
        state.currentTime = range.start;
        state.playbackStartedAt = now;
        state.playbackStartedFrom = range.start;
      } else {
        state.currentTime = range.end;
        pause(false);
        renderPreview();
        setStatus('End of sequence');
        return;
      }
    }
    if (state.playRate < 0 && state.currentTime <= 0) {
      state.currentTime = 0;
      pause(false);
      renderPreview();
      setStatus('Start of sequence');
      return;
    }
    syncPreviewMedia(true);
    renderPreview();
    updateMeters();
    playbackTick = (playbackTick + 1) % 12;
    if (!playbackTick) keepPlayheadVisible();
    state.raf = requestAnimationFrame(playbackFrame);
  }

  function pause(update = true) {
    if (!state.playing && update) syncPreviewMedia(false);
    state.playing = false;
    state.playRate = 1;
    cancelAnimationFrame(state.raf);
    const playButton = $('[data-action="play"]');
    if (playButton) playButton.innerHTML = ICONS.play;
    elements.sourceVideo?.pause?.();
    syncPreviewMedia(false);
    resetMeters();
    if (update) {
      renderPreview();
      setStatus('Paused');
    }
  }

  // J / K / L shuttle: repeated J or L doubles the speed up to 8×.
  function shuttle(direction) {
    if (direction === 0) {
      if (state.playing) pause();
      return;
    }
    let rate = direction;
    if (state.playing && Math.sign(state.playRate) === direction) {
      const index = SHUTTLE_RATES.indexOf(Math.abs(state.playRate));
      rate = direction * SHUTTLE_RATES[Math.min(SHUTTLE_RATES.length - 1, index + 1)];
    }
    if (state.playing) {
      state.playing = false;
      cancelAnimationFrame(state.raf);
    }
    play(rate);
  }

  function seek(time) {
    pause(false);
    state.currentTime = clamp(time, 0, Math.max(projectDuration(), 0));
    syncPreviewMedia(false);
    renderPreview();
    keepPlayheadVisible();
  }

  function stepFrames(direction) {
    if (
      state.monitor === 'source' &&
      elements.sourceVideo &&
      typeof elements.sourceVideo.currentTime === 'number'
    ) {
      elements.sourceVideo.pause?.();
      elements.sourceVideo.currentTime = Math.max(
        0,
        elements.sourceVideo.currentTime + direction / fps(),
      );
      return;
    }
    seek(snapToFrame(state.currentTime) + direction / fps());
  }

  function setSequencePreset(id) {
    const preset = SEQUENCE_PRESETS.find((item) => item.id === id);
    if (!preset) return;
    if (preset.width === state.project.width && preset.height === state.project.height) return;
    mutate('Sequence settings', () => {
      state.project.width = preset.width;
      state.project.height = preset.height;
    });
    setStatus(`Sequence: ${preset.label}`);
  }

  function syncSequenceControls() {
    const select = elements.sequencePreset;
    if (select) {
      const id = `${state.project.width}x${state.project.height}`;
      if (!Array.from(select.options || []).some((option) => option.value === id)) {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = `Custom · ${state.project.width}×${state.project.height}`;
        select.append(option);
      }
      select.value = id;
    }
    if (elements.fps) elements.fps.value = String(state.project.fps);
    if (elements.monitorWrap)
      elements.monitorWrap.style.setProperty(
        '--av-aspect',
        `${state.project.width} / ${state.project.height}`,
      );
  }

  // ------------------------------------------------------------------ project

  function newProject() {
    if (
      state.dirty &&
      !window.confirm(
        'Start a new project? The current project metadata has not been explicitly saved.',
      )
    )
      return;
    pause();
    showProgram();
    cleanupRuntime();
    state.project = createProject();
    state.selectedId = null;
    state.selection = new Set();
    state.currentTime = 0;
    state.source = null;
    state.history.clear();
    state.dirty = false;
    if (elements.projectName) elements.projectName.value = state.project.name;
    if (elements.fps) elements.fps.value = String(state.project.fps);
    if (elements.saveState) elements.saveState.textContent = 'New local project';
    renderAll();
    setStatus('New project created');
  }

  function cleanupRuntime(retainedUrls = new Set()) {
    for (const entry of state.clipElements.values()) releaseElement(entry);
    state.clipElements.clear();
    for (const runtime of state.runtimeAssets.values()) {
      if (runtime.objectUrl && !retainedUrls.has(runtime.objectUrl))
        URL.revokeObjectURL(runtime.objectUrl);
    }
    state.runtimeAssets.clear();
    releaseThumbnails();
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.style.display = 'none';
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  function offerRenderedBlob(blob, fileName, videoSeconds = 0) {
    if (state.pendingRenderUrl) URL.revokeObjectURL(state.pendingRenderUrl);
    state.pendingRenderUrl = URL.createObjectURL(blob);
    let result = root.querySelector('.av-render-result');
    if (!result) {
      result = document.createElement('div');
      result.className = 'av-render-result';
      result.setAttribute('role', 'status');
      result.setAttribute('aria-live', 'polite');
      // The result is a fixed toast; it sits after the timeline (or any older notice strip), else at the end of root.
      const anchor =
        root.querySelector('.av-timeline-panel') || root.querySelector('.av-editor-notice');
      if (anchor?.after) anchor.after(result);
      else root.append?.(result);
    }
    result.replaceChildren?.();
    result.classList.remove('is-dismissed');
    const message = document.createElement('span');
    const took = state.renderStartedAt ? (performance.now() - state.renderStartedAt) / 1000 : 0;
    message.innerHTML = '<strong>Exported</strong> ';
    message.append(
      `${formatBytes(blob.size)}${videoSeconds > 0 ? ` · ${formatClock(videoSeconds)} of video` : ''}${took > 0 ? ` · done in ${took < 10 ? took.toFixed(1) : Math.round(took)} s` : ''}`,
    );
    const link = document.createElement('a');
    link.href = state.pendingRenderUrl;
    link.download = fileName;
    link.textContent = 'Save rendered video';
    const close = document.createElement('button');
    close.type = 'button';
    close.dataset.action = 'dismiss-render-result';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    result.append(message, link, close);
  }

  // ---------------------------------------------------------------- export

  const EXPORT_PRESETS = Object.freeze([
    { id: 'match', label: 'Match sequence' },
    { id: '1080p', label: '1080p · 1920×1080', width: 1920, height: 1080 },
    { id: '720p', label: '720p · 1280×720', width: 1280, height: 720 },
    { id: '2160p', label: '4K UHD · 3840×2160', width: 3840, height: 2160 },
    { id: 'vertical', label: 'Vertical 9:16 · 1080×1920', width: 1080, height: 1920 },
    { id: 'square', label: 'Square 1:1 · 1080×1080', width: 1080, height: 1080 },
  ]);
  const QUALITY_BPP = Object.freeze({ high: 0.2, medium: 0.12, low: 0.06 });
  // Phones, small tablets and low-memory devices get the tighter export budgets.
  function isSmallDevice() {
    return Boolean(
      window.matchMedia?.('(max-width: 1024px)').matches ||
        (navigator.deviceMemory && navigator.deviceMemory <= 4),
    );
  }

  function avcCodecFor(width, height) {
    const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
    if (macroblocks <= 3600) return 'avc1.64001F';
    if (macroblocks <= 8192) return 'avc1.640028';
    if (macroblocks <= 22080) return 'avc1.640033';
    return 'avc1.640034';
  }

  // Ask this browser, honestly, what it can encode. Cached per output size.
  async function detectExportSupport(width, height, frameRate) {
    const key = `${width}x${height}@${frameRate}`;
    if (state.exportSupport && state.exportSupport.key === key) return state.exportSupport;
    const support = {
      key,
      mp4: null,
      mp4Audio: null,
      webm: null,
      webmFast: null,
      webmAudio: null,
      wav: false,
      reasons: [],
    };
    const secure = window.isSecureContext !== false;
    if (typeof window.VideoEncoder === 'function' && !mp4()) await loadGroup('export');
    if (
      typeof window.VideoEncoder === 'function' &&
      typeof window.VideoFrame === 'function' &&
      mp4() &&
      secure
    ) {
      const bitrate = Math.round(QUALITY_BPP.high * width * height * frameRate);
      const candidates = [
        { codec: avcCodecFor(width, height), label: 'H.264' },
        { codec: 'avc1.4D4028', label: 'H.264' },
        { codec: 'avc1.42E028', label: 'H.264' },
        { codec: 'vp09.00.40.08', label: 'VP9' },
      ];
      for (const candidate of candidates) {
        try {
          const config = { codec: candidate.codec, width, height, bitrate, framerate: frameRate };
          if (candidate.codec.startsWith('avc1')) config.avc = { format: 'avc' };
          const result = await window.VideoEncoder.isConfigSupported(config);
          if (result && result.supported) {
            support.mp4 = candidate;
            break;
          }
        } catch (_) {}
      }
      if (!support.mp4)
        support.reasons.push('This browser has no WebCodecs video encoder for MP4 at this size.');
      if (typeof window.AudioEncoder === 'function' && typeof window.AudioData === 'function') {
        for (const candidate of [
          { codec: 'mp4a.40.2', label: 'AAC' },
          { codec: 'opus', label: 'Opus' },
        ]) {
          try {
            const result = await window.AudioEncoder.isConfigSupported({
              codec: candidate.codec,
              sampleRate: 48000,
              numberOfChannels: 2,
              bitrate: 192000,
            });
            if (result && result.supported) {
              support.mp4Audio = candidate;
              break;
            }
          } catch (_) {}
        }
      }
      if (support.mp4 && !support.mp4Audio)
        support.reasons.push(
          'No WebCodecs audio encoder: MP4 export would be silent, so it is offered only for projects without sound.',
        );
      // Faster-than-real-time WebM: WebCodecs VP9 or VP8 plus Opus, written by our own muxer.
      for (const candidate of [
        { codec: 'vp09.00.40.08', label: 'VP9' },
        { codec: 'vp8', label: 'VP8' },
      ]) {
        try {
          const result = await window.VideoEncoder.isConfigSupported({
            codec: candidate.codec,
            width,
            height,
            bitrate: Math.round(QUALITY_BPP.high * width * height * frameRate),
            framerate: frameRate,
          });
          if (result && result.supported) {
            support.webmFast = candidate;
            break;
          }
        } catch (_) {}
      }
      if (typeof window.AudioEncoder === 'function') {
        try {
          if (
            (
              await window.AudioEncoder.isConfigSupported({
                codec: 'opus',
                sampleRate: 48000,
                numberOfChannels: 2,
                bitrate: 128000,
              })
            )?.supported
          )
            support.webmAudio = { codec: 'opus', label: 'Opus' };
        } catch (_) {}
      }
    } else {
      support.reasons.push(
        secure
          ? 'WebCodecs is not available in this browser, so fast MP4 export is off.'
          : 'WebCodecs needs a secure (https) page.',
      );
    }
    if (elements.canvas.captureStream && window.MediaRecorder) {
      const type = supportedRecorderType(true);
      if (type)
        support.webm = {
          mimeType: type,
          label: type.includes('mp4') ? 'MP4 (real time)' : 'WebM (real time)',
        };
    }
    if (!support.webm) support.reasons.push('This browser cannot record the canvas in real time.');
    support.wav = Boolean(window.OfflineAudioContext || window.webkitOfflineAudioContext);
    state.exportSupport = support;
    return support;
  }

  function exportSettings() {
    const form = elements.exportForm;
    const read = (name, fallback) => {
      const field = form?.elements?.namedItem?.(name);
      return field && field.value ? field.value : fallback;
    };
    const presetId = read('preset', 'match');
    const preset = EXPORT_PRESETS.find((item) => item.id === presetId) || EXPORT_PRESETS[0];
    const width = preset.width || state.project.width;
    const height = preset.height || state.project.height;
    return {
      preset,
      width: width % 2 ? width - 1 : width,
      height: height % 2 ? height - 1 : height,
      format: read('format', 'auto'),
      quality: QUALITY_BPP[read('quality', 'high')] ? read('quality', 'high') : 'high',
      range: read('range', 'all'),
    };
  }

  function exportRange(settings) {
    const duration = projectDuration();
    if (settings.range === 'inout') {
      const start = clamp(state.project.inPoint ?? 0, 0, duration);
      const end = clamp(state.project.outPoint ?? duration, 0, duration);
      if (end - start >= 1 / fps()) return { start, end };
    }
    return { start: 0, end: duration };
  }

  async function openExportDialog() {
    if (state.rendering) return;
    pause();
    state.returnFocus =
      typeof HTMLElement === 'function' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    elements.renderDialog.dataset.stage = 'settings';
    setRenderDialogOpen(true);
    elements.renderMessage.textContent =
      'Choose a preset and format. Everything renders on this device.';
    elements.renderProgress.value = 0;
    await refreshExportSupport();
    elements.exportForm?.querySelector?.('select, button')?.focus?.();
  }

  function closeExportDialog() {
    if (state.rendering) return;
    setRenderDialogOpen(false);
    state.returnFocus?.focus?.();
    state.returnFocus = null;
  }

  async function refreshExportSupport() {
    const settings = exportSettings();
    const support = await detectExportSupport(settings.width, settings.height, fps());
    const box = elements.exportSupport;
    const formatField = elements.exportForm?.elements?.namedItem?.('format');
    const range = exportRange(settings);
    const sound = projectHasSound(range);
    const titles = state.project.clips.some(
      (clip) => clip.kind === 'title' && String(clip.text || '').trim(),
    );
    const unavailable = {
      mp4: !support.mp4,
      webm: !support.webm,
      'webm-fast': !support.webmFast || (sound && !support.webmAudio),
      wav: !support.wav || !sound,
      srt: !titles,
      vtt: !titles,
    };
    if (formatField && formatField.options) {
      for (const option of Array.from(formatField.options))
        option.disabled = Boolean(unavailable[option.value]);
      if (formatField.selectedOptions?.[0]?.disabled) formatField.value = 'auto';
    }
    if (box) {
      const lines = [];
      if (support.mp4)
        lines.push(
          `MP4 · ${support.mp4.label}${support.mp4Audio ? ` + ${support.mp4Audio.label}` : ' (no audio encoder)'} · renders faster or slower than real time, frame by frame; the tab can stay in the background.`,
        );
      if (support.webmFast)
        lines.push(
          `WebM · ${support.webmFast.label}${support.webmAudio ? ' + Opus' : ' (silent projects only: no Opus encoder)'} · offline, frame by frame.`,
        );
      if (support.webm)
        lines.push(
          `${support.webm.label} · plays the sequence once in real time; keep this tab visible.`,
        );
      lines.push(
        'GIF (up to 15 s, 640 px wide, 15 fps), PNG stills and PNG/JPEG sequences in a ZIP are written on this device.',
      );
      if (!sound) lines.push('WAV needs sound in the export range.');
      else if (!support.wav) lines.push('This browser cannot mix audio offline, so WAV is off.');
      if (!titles) lines.push('SRT/VTT need at least one title or caption.');
      lines.push(...support.reasons);
      box.textContent = lines.join(' ');
    }
    return support;
  }

  function projectHasSound(range) {
    const audible = Edit.audibleTrackIds(state.project);
    return state.project.clips.some(
      (clip) =>
        clip.kind === 'audio' &&
        !clip.muted &&
        audible.has(clip.track) &&
        clip.start < range.end &&
        clip.start + clip.duration > range.start,
    );
  }

  async function renderVideo() {
    state.renderStartedAt = performance.now();
    if (state.rendering) return;
    const settings = exportSettings();
    const range = exportRange(settings);
    const duration = range.end - range.start;
    if (projectDuration() <= 0 || duration <= 0) {
      setStatus('Add clips before rendering');
      return;
    }
    if (duration > LIMITS.maxRenderSeconds) {
      setStatus(`Local rendering is limited to ${formatClock(LIMITS.maxRenderSeconds)} per export`);
      return;
    }
    const missing = state.project.clips.filter(
      (clip) => isMediaClip(clip) && !state.runtimeAssets.has(clip.assetId),
    );
    if (missing.length) {
      setStatus(
        `Relink ${missing.length} offline clip${missing.length === 1 ? '' : 's'} before rendering`,
      );
      return;
    }
    const support = await detectExportSupport(settings.width, settings.height, fps());
    await ensureEffectsModules();
    if (EXTRA_FORMATS.includes(settings.format)) return renderExtraFormat(settings, range, support);
    const sound = projectHasSound(range);
    const mp4Usable = support.mp4 && (support.mp4Audio || !sound);
    const wantMp4 = settings.format === 'mp4' || (settings.format === 'auto' && mp4Usable);
    if (wantMp4 && mp4Usable) return renderMp4(settings, range, support);
    if (settings.format === 'mp4' && !mp4Usable) {
      setStatus(
        support.mp4
          ? 'MP4 export needs an audio encoder for this project; choose WebM (real time).'
          : `MP4 export is unavailable: ${support.reasons[0] || 'no encoder'}`,
      );
      return;
    }
    return renderRealtime(range);
  }

  // Offline audio mix of the export range: decode each source once, schedule
  // every audible clip with its speed, reverse, gain envelope and pan, and render
  // faster than real time. Bounded by a decoded-PCM memory budget.
  async function renderAudioMix(range, isCancelled) {
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) throw new Error('This browser cannot mix audio offline.');
    const audible = Edit.audibleTrackIds(state.project);
    const clips = state.project.clips.filter(
      (clip) => clip.kind === 'audio' && !clip.muted && audible.has(clip.track),
    );
    const relevant = clips.filter(
      (clip) =>
        clip.start - transitionCore.MAX_TRANSITION_SECONDS < range.end &&
        clip.start + clip.duration + transitionCore.MAX_TRANSITION_SECONDS > range.start,
    );
    if (!relevant.length) return null;
    const sampleRate = 48000;
    const mobile = isSmallDevice();
    const budget = mobile ? 320 * 1024 * 1024 : 1536 * 1024 * 1024;
    const assetIds = [...new Set(relevant.map((clip) => clip.assetId))];
    const plan = Edit.audioMixPlan(state.project, relevant, range, sampleRate);
    if (plan.reason) throw new Error(plan.reason);
    if (plan.bytes > budget)
      throw new Error(
        `The sources' audio is too long to mix offline on this device (about ${formatBytes(plan.bytes)} of decoded sound). Shorten the sources or use WebM (real time).`,
      );
    // Audio effects, the 5.1 downmix and pitch-preserving stretch live in the effects group.
    // Load it only when the project uses it; a surround source found while decoding loads it then.
    await ensureEffectsModules();
    let fx = window.AlcorVideoAudioFx || null;
    const decoder = new Offline(2, 1, sampleRate);
    const buffers = new Map();
    for (const id of assetIds) {
      if (isCancelled()) return null;
      const runtime = state.runtimeAssets.get(id);
      if (!runtime) continue;
      try {
        const data = await runtime.file.arrayBuffer();
        let buffer = await new Promise((resolve, reject) => {
          const pending = decoder.decodeAudioData(data, resolve, reject);
          if (pending && typeof pending.then === 'function') pending.then(resolve, reject);
        });
        // Surround sources: our downmix keeps center, LFE and surrounds (the browser's drops the LFE).
        if (!fx && buffer.numberOfChannels > 2) {
          await loadGroup('effects');
          fx = window.AlcorVideoAudioFx || null;
        }
        if (fx && buffer.numberOfChannels > 2) {
          const planes = Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
            buffer.getChannelData(channel),
          );
          const [left, right] = fx.downmixToStereo(planes);
          const stereo = decoder.createBuffer(2, buffer.length, buffer.sampleRate);
          stereo.copyToChannel(left, 0);
          stereo.copyToChannel(right, 1);
          buffer = stereo;
        }
        buffers.set(id, buffer);
      } catch (error) {
        // A video without an audio track decodes to an error: it simply contributes silence.
        buffers.set(id, null);
      }
    }
    const length = Math.max(1, Math.ceil((range.end - range.start) * sampleRate));
    const mix = new Offline(2, length, sampleRate);
    const master = mix.createGain();
    master.connect(mix.destination);
    const trackNodes = new Map();
    const trackNode = (trackId) => {
      if (trackNodes.has(trackId)) return trackNodes.get(trackId);
      const track = getTrack(trackId);
      const gain = mix.createGain();
      gain.gain.value = track ? dbToGain(track.volume) : 1;
      let out = gain;
      if (typeof mix.createStereoPanner === 'function') {
        const panner = mix.createStereoPanner();
        panner.pan.value = track ? clamp(track.pan, -1, 1) : 0;
        gain.connect(panner);
        out = panner;
      }
      out.connect(master);
      trackNodes.set(trackId, gain);
      return gain;
    };
    const reversedCache = new Map();
    for (const clip of relevant) {
      const buffer = buffers.get(clip.assetId);
      if (!buffer) continue;
      // Timeline window this clip sounds in, including crossfade handles.
      let windowStart = clip.start;
      let windowEnd = clip.start + clip.duration;
      const transition = transitionCore.resolveCrossDissolveForClip(
        clip,
        state.project.clips,
        state.project.assets,
      );
      if (transition) {
        windowStart = Math.min(windowStart, transition.startTime);
        windowEnd = Math.max(windowEnd, transition.endTime);
      }
      const begin = Math.max(windowStart, range.start);
      const end = Math.min(windowEnd, range.end);
      if (end - begin < 1 / sampleRate) continue;
      const source = mix.createBufferSource();
      let sourceBuffer = buffer;
      let offset = sourceTimeForPicture(clip, begin);
      if (clip.reverse) {
        if (!reversedCache.has(clip.assetId)) {
          const reversed = mix.createBuffer(
            buffer.numberOfChannels,
            buffer.length,
            buffer.sampleRate,
          );
          for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
            const input = buffer.getChannelData(channel);
            const output = reversed.getChannelData(channel);
            for (let index = 0, last = input.length - 1; index <= last; index += 1)
              output[index] = input[last - index];
          }
          reversedCache.set(clip.assetId, reversed);
        }
        sourceBuffer = reversedCache.get(clip.assetId);
        offset = buffer.duration - offset;
      }
      const remap = clip.timeRemap && effectsCore ? clip.timeRemap : null;
      let sourceLength = remap
        ? Edit.sourceSpan(clip, begin - clip.start, end - clip.start)
        : (end - begin) * clip.speed;
      let playbackRate = clip.speed;
      if (fx && clip.preservePitch && !remap && Math.abs(clip.speed - 1) > 0.001) {
        // Maintain pitch: time-stretch this clip's source window (WSOLA), then play it at 1x.
        const first = Math.max(0, Math.floor(offset * sourceBuffer.sampleRate));
        const last = Math.min(
          sourceBuffer.length,
          Math.ceil((offset + sourceLength) * sourceBuffer.sampleRate),
        );
        if (last - first > 16) {
          const planes = Array.from({ length: sourceBuffer.numberOfChannels }, (_, channel) =>
            sourceBuffer.getChannelData(channel).subarray(first, last),
          );
          const stretched = fx.timeStretch(planes, clip.speed);
          const out = mix.createBuffer(
            stretched.length,
            Math.max(1, stretched[0].length),
            sourceBuffer.sampleRate,
          );
          stretched.forEach((plane, channel) => out.copyToChannel(plane, channel));
          sourceBuffer = out;
          offset = 0;
          sourceLength = out.duration;
          playbackRate = 1;
        }
      }
      source.buffer = sourceBuffer;
      if (remap) {
        const rateSteps = Math.max(2, Math.min(20000, Math.ceil((end - begin) * 200)));
        const rates = new Float32Array(rateSteps);
        for (let index = 0; index < rateSteps; index += 1)
          rates[index] = clipSpeedAt(clip, begin + ((end - begin) * index) / (rateSteps - 1));
        source.playbackRate.setValueCurveAtTime(rates, begin - range.start, end - begin);
      } else {
        source.playbackRate.value = playbackRate;
      }
      const gain = mix.createGain();
      const steps = Math.max(2, Math.min(20000, Math.ceil((end - begin) * 200)));
      const curve = new Float32Array(steps);
      for (let index = 0; index < steps; index += 1) {
        const time = begin + ((end - begin) * index) / (steps - 1);
        curve[index] = clipAudioGain(clip, time, audible);
      }
      gain.gain.setValueCurveAtTime(curve, begin - range.start, end - begin);
      // The same effect chain as the preview graph.
      if (fx && clip.audioFx) {
        const chain = fx.buildChain(mix, clip.audioFx);
        source.connect(chain.input);
        chain.output.connect(gain);
      } else {
        source.connect(gain);
      }
      let out = gain;
      if (typeof mix.createStereoPanner === 'function' && clip.pan) {
        const panner = mix.createStereoPanner();
        panner.pan.value = clamp(clip.pan, -1, 1);
        gain.connect(panner);
        out = panner;
      }
      out.connect(trackNode(clip.track));
      if (offset < sourceBuffer.duration)
        source.start(
          begin - range.start,
          Math.max(0, offset),
          Math.max(0, Math.min(sourceLength, sourceBuffer.duration - offset)),
        );
    }
    if (isCancelled()) return null;
    return mix.startRendering();
  }

  function waitForEvent(target, name, timeout, message) {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error(message));
      }, timeout);
      const onEvent = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('The browser could not decode a source video while exporting.'));
      };
      const cleanup = () => {
        window.clearTimeout(timer);
        target.removeEventListener(name, onEvent);
        target.removeEventListener('error', onError);
      };
      target.addEventListener(name, onEvent, { once: true });
      target.addEventListener('error', onError, { once: true });
    });
  }

  // Sequential WebCodecs decoding of an MP4/MOV source for export. Frames come out
  // in presentation order at hardware speed instead of one media-element seek per
  // frame. frameAt(t) returns the frame shown at source time t (the latest frame
  // whose timestamp is <= t); jumping backwards or far ahead restarts at a keyframe.
  // Export stops waiting on any browser media step that makes no progress for this long.
  const EXPORT_STALL_MS = 10000;

  class ExportStall extends Error {}

  // Sequential WebCodecs decoding of an MP4/MOV source for export. Frames come out
  // in presentation order at hardware speed instead of one media-element seek per
  // frame. frameAt(t) returns the frame shown at source time t (the latest frame
  // whose timestamp is <= t); jumping backwards or far ahead restarts at a keyframe.
  //
  // Hardware decoders lend out a small pool of frames and produce nothing more until
  // some are closed, and they hold a few frames back for reordering. So: feed one
  // chunk at a time, keep at most one frame past the target, close everything else
  // at once, and treat "no output for EXPORT_STALL_MS" as a stall instead of waiting.
  class DecodedFrames {
    constructor(file, table, config) {
      this.file = file;
      this.table = table;
      this.config = config;
      this.frames = [];
      this.current = null;
      this.decoder = null;
      this.next = 0;
      this.flushPromise = null;
      this.flushDone = false;
      this.error = null;
      this.cache = null;
      this.wake = null;
      this.lastProgress = 0;
    }

    keyIndexAtOrBefore(time) {
      let found = 0;
      const samples = this.table.samples;
      for (let index = 0; index < samples.length; index += 1) {
        if (samples[index].time > time + 1e-4) break;
        if (samples[index].key) found = index;
      }
      return found;
    }

    restart(index) {
      try {
        if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
      } catch (_) {}
      for (const frame of this.frames) frame.close();
      this.frames = [];
      if (this.current) {
        this.current.close();
        this.current = null;
      }
      this.error = null;
      this.flushPromise = null;
      this.flushDone = false;
      this.next = index;
      this.decoder = new window.VideoDecoder({
        output: (frame) => {
          const list = this.frames;
          let at = list.length;
          while (at > 0 && list[at - 1].timestamp > frame.timestamp) at -= 1;
          list.splice(at, 0, frame);
          this.lastProgress = performance.now();
          this.wake?.();
        },
        error: (error) => {
          this.error = error;
          this.wake?.();
        },
      });
      this.decoder.configure(this.config);
      this.lastProgress = performance.now();
    }

    // Wait until a frame arrives, or a short tick passes.
    pause(ms) {
      return new Promise((resolve) => {
        const timer = window.setTimeout(() => {
          this.wake = null;
          resolve();
        }, ms);
        this.wake = () => {
          window.clearTimeout(timer);
          this.wake = null;
          resolve();
        };
      });
    }

    async chunk(index) {
      const samples = this.table.samples;
      const sample = samples[index];
      if (
        !this.cache ||
        sample.offset < this.cache.start ||
        sample.offset + sample.size > this.cache.end
      ) {
        const batch = samples.slice(index, index + 24);
        const start = Math.min(...batch.map((item) => item.offset));
        const end = Math.max(...batch.map((item) => item.offset + item.size));
        this.cache = {
          start,
          end,
          bytes: new Uint8Array(await this.file.slice(start, end).arrayBuffer()),
        };
      }
      return new window.EncodedVideoChunk({
        type: sample.key ? 'key' : 'delta',
        timestamp: Math.round(sample.time * 1e6),
        data: this.cache.bytes.subarray(
          sample.offset - this.cache.start,
          sample.offset - this.cache.start + sample.size,
        ),
      });
    }

    // Keep the latest frame at or before the target as current; close the rest behind it.
    advance(target) {
      while (this.frames.length && this.frames[0].timestamp <= target) {
        if (this.current) this.current.close();
        this.current = this.frames.shift();
        this.lastProgress = performance.now();
      }
    }

    async frameAt(time) {
      const target = Math.round((time + 1e-4) * 1e6);
      const samples = this.table.samples;
      const oldest = this.current
        ? this.current.timestamp
        : this.frames[0]
          ? this.frames[0].timestamp
          : Infinity;
      const fedUntil =
        this.next > 0
          ? Math.round(samples[Math.min(this.next, samples.length) - 1].time * 1e6)
          : -Infinity;
      const key = this.keyIndexAtOrBefore(time);
      if (!this.decoder || target < oldest - 1000 || (key > this.next && target - fedUntil > 2e6))
        this.restart(key);
      this.lastProgress = performance.now();
      for (;;) {
        if (this.error) throw this.error;
        this.advance(target);
        // A decoded frame later than the target proves the current one is final.
        if (this.frames.length) break;
        if (this.next < samples.length) {
          // Feed while the decoder is not backed up; one chunk at a time.
          if (this.decoder.decodeQueueSize < 3) {
            this.decoder.decode(await this.chunk(this.next));
            this.next += 1;
            this.lastProgress = performance.now();
            continue;
          }
        } else if (!this.flushPromise) {
          // Everything is fed: flushing releases the frames held back for reordering.
          this.flushPromise = this.decoder.flush().then(
            () => {
              this.flushDone = true;
              this.wake?.();
            },
            (error) => {
              this.error = error;
              this.wake?.();
            },
          );
        } else if (this.flushDone) {
          this.advance(target);
          break;
        }
        if (performance.now() - this.lastProgress > EXPORT_STALL_MS) {
          throw new ExportStall('The browser video decoder stopped producing frames.');
        }
        await this.pause(4);
      }
      return this.current;
    }

    close() {
      try {
        if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
      } catch (_) {}
      for (const frame of this.frames) frame.close();
      this.frames = [];
      if (this.current) {
        this.current.close();
        this.current = null;
      }
    }
  }

  async function createDecodedSource(runtime, clip) {
    if (
      !mediaCore ||
      typeof window.VideoDecoder !== 'function' ||
      typeof window.EncodedVideoChunk !== 'function' ||
      clip.reverse ||
      clip.hold != null
    )
      return null;
    if (runtime.sampleTable === undefined)
      runtime.sampleTable = await mediaCore.readVideoSampleTable(runtime.file);
    const table = runtime.sampleTable;
    if (!table || table.rotation || !table.samples.length) return null;
    const config = { codec: table.codec, codedWidth: table.width, codedHeight: table.height };
    if (table.description) config.description = table.description;
    try {
      const support = await window.VideoDecoder.isConfigSupported(config);
      if (!support || !support.supported) return null;
    } catch (_) {
      return null;
    }
    return new DecodedFrames(runtime.file, table, config);
  }

  function withStallTimeout(promise, message) {
    let timer = 0;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = window.setTimeout(() => reject(new ExportStall(message)), EXPORT_STALL_MS * 2);
      }),
    ]).finally(() => window.clearTimeout(timer));
  }

  // After a stalled MP4 export, reopen the export dialog with WebM selected and the reason shown.
  function offerWebmAfterStall(message) {
    const format = elements.exportForm?.elements?.namedItem?.('format');
    if (format && support_webm_available()) format.value = 'webm';
    elements.renderDialog.dataset.stage = 'settings';
    setRenderDialogOpen(true);
    elements.renderMessage.textContent = message;
    elements.renderProgress.value = 0;
    elements.renderDialog.querySelector?.('.av-export-start')?.focus?.();
  }

  function support_webm_available() {
    return Boolean(state.exportSupport && state.exportSupport.webm);
  }

  // Private source elements for an offline export (the preview elements keep their own
  // state), with sequential WebCodecs decoding for MP4/MOV sources where possible.
  async function prepareExportSources(entries = new Map()) {
    entries.fallbacks = 0;
    const waits = [];
    for (const clip of state.project.clips) {
      if (clip.kind !== 'video' && clip.kind !== 'image') continue;
      const runtime = state.runtimeAssets.get(clip.assetId);
      if (!runtime) continue;
      if (clip.kind === 'image') {
        entries.set(clip.id, { element: runtime.image, kind: 'image' });
        continue;
      }
      const element = document.createElement('video');
      element.muted = true;
      element.preload = 'auto';
      element.playsInline = true;
      element.src = runtime.objectUrl;
      entries.set(clip.id, {
        element,
        kind: 'video',
        ready: false,
        sourceFps: Number(getAsset(clip.assetId)?.fps) || 0,
      });
      waits.push(waitFor(element, 'loadeddata', 'error', 20000));
    }
    await Promise.all(waits);
    entries.decoded = 0;
    for (const clip of state.project.clips) {
      const entry = entries.get(clip.id);
      if (!entry || entry.kind !== 'video') continue;
      entry.decoded = await createDecodedSource(state.runtimeAssets.get(clip.assetId), clip);
      if (entry.decoded) entries.decoded += 1;
    }
    return entries;
  }

  function exportDecodePath(entries) {
    const videos = [...entries.values()].filter((entry) => entry.kind === 'video').length;
    return entries.decoded
      ? `WebCodecs decode for ${entries.decoded} of ${videos} video clip${entries.size === 1 ? '' : 's'}`
      : 'media-element seeking';
  }

  // Bring every visible source to the frame shown at sequence time `time`. Phone footage
  // with variable or millisecond-rounded frame times maps to the nearest source frame
  // (half a source frame of tolerance), so no frame is skipped or doubled.
  async function seekExportSources(entries, time, frameRate) {
    const visible = Edit.visibleTrackIds(state.project);
    const seeks = [];
    for (const clip of state.project.clips) {
      if (clip.kind !== 'video') continue;
      const entry = entries.get(clip.id);
      if (
        !entry ||
        !visible.has(clip.track) ||
        !transitionCore.visualActiveAt(clip, time, state.project.clips, state.project.assets)
      )
        continue;
      const media = entry.element;
      const tolerance =
        mediaCore && mediaCore.frameLookupTolerance
          ? mediaCore.frameLookupTolerance(entry.sourceFps, frameRate)
          : 0;
      const target = clamp(
        sourceTimeForPicture(clip, time) + tolerance,
        0,
        Math.max(0, (media.duration || 0) - 0.001),
      );
      if (entry.decoded) {
        try {
          entry.frame = await entry.decoded.frameAt(target);
          if (entry.frame) continue;
        } catch (error) {
          // A decoder error or stall on one clip falls back to seeking that clip for the rest of the export.
          console.warn('AlcorVideo export: WebCodecs decode stopped, seeking instead:', error);
          entry.decoded.close();
          entry.decoded = null;
          entries.fallbacks = (entries.fallbacks || 0) + 1;
        }
        entry.frame = null;
      }
      if (!entry.ready || Math.abs(media.currentTime - target) > 0.25 / frameRate) {
        const done = waitForEvent(
          media,
          'seeked',
          EXPORT_STALL_MS,
          'A source video stopped responding during export (the browser may have paused it). Keep the tab open and try again.',
        );
        media.currentTime = target;
        seeks.push(
          done.then(() => {
            entry.ready = true;
          }),
        );
      }
    }
    if (seeks.length) await Promise.all(seeks);
  }

  function releaseExportSources(entries) {
    for (const entry of entries.values()) {
      if (entry.kind !== 'video') continue;
      entry.decoded?.close();
      entry.frame = null;
      entry.element.removeAttribute('src');
      entry.element.load?.();
    }
  }

  // Effects, audio effects and surround downmix are needed before any render starts.
  function projectUsesEffects() {
    return (
      state.project.clips.some(
        (clip) => (clip.effects && clip.effects.length) || clip.audioFx || clip.preservePitch,
      ) || state.project.assets.some((asset) => Number(asset.channels) > 2)
    );
  }

  async function ensureEffectsModules() {
    if (projectUsesEffects() && (!window.AlcorVideoEffectsRender || !window.AlcorVideoAudioFx))
      await loadGroup('effects');
  }

  function beginRender(message) {
    pause();
    showProgram();
    state.rendering = true;
    state.cancelRender = false;
    state.renderStartedAt = performance.now();
    updateHistoryButtons();
    if (elements.renderDialog.hidden)
      state.returnFocus =
        typeof HTMLElement === 'function' && document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    elements.renderDialog.dataset.stage = 'rendering';
    setRenderDialogOpen(true);
    elements.renderProgress.value = 0;
    elements.renderMessage.textContent = message;
    elements.renderDialog.querySelector?.('[data-action="cancel-render"]')?.focus?.();
  }

  function endRender() {
    state.rendering = false;
    state.cancelRender = false;
    setRenderDialogOpen(false);
    state.returnFocus?.focus?.();
    state.returnFocus = null;
    updateHistoryButtons();
    syncPreviewMedia(false);
    renderAll();
  }

  // What the lazy export-format module may use; it never touches editor state directly.
  function exportBridge() {
    return Object.freeze({
      project: () => state.project,
      fps,
      currentTime: () => state.currentTime,
      projectDuration,
      formatBytes,
      formatClock,
      fileName: (suffix) => `${safeFileName(state.project.name)}${suffix}`,
      setStatus,
      cancelled: () => state.cancelRender,
      begin: beginRender,
      end: endRender,
      progress(value, message) {
        elements.renderProgress.value = clamp(value, 0, 1);
        if (message) elements.renderMessage.textContent = message;
      },
      prepareSources: () => prepareExportSources(new Map()),
      seekSources: seekExportSources,
      releaseSources: releaseExportSources,
      decodePath: exportDecodePath,
      draw: (context, time, width, height, entries) =>
        drawComposite(context, time, { width, height, entries }),
      hasSound: projectHasSound,
      mixAudio: (range) => renderAudioMix(range, () => state.cancelRender),
      deliver(blob, fileName, seconds = 0) {
        downloadBlob(blob, fileName);
        offerRenderedBlob(blob, fileName, seconds);
      },
      captionCues: () =>
        state.project.clips
          .filter((clip) => clip.kind === 'title' && String(clip.text || '').trim())
          .map((clip) => ({
            start: clip.start,
            end: clip.start + clip.duration,
            text: String(clip.text).trim(),
          })),
      timelineCore,
      stallMs: EXPORT_STALL_MS,
      ExportStall,
      qualityBpp: QUALITY_BPP,
      isSmallDevice,
    });
  }

  const EXTRA_FORMATS = Object.freeze([
    'webm-fast',
    'gif',
    'png',
    'png-seq',
    'jpeg-seq',
    'wav',
    'srt',
    'vtt',
  ]);

  async function renderExtraFormat(settings, range, support) {
    if (!window.AlcorVideoExportFormats) await loadGroup('export');
    const formats = window.AlcorVideoExportFormats;
    if (!formats) {
      setStatus('This export format is not available in this copy of the editor.');
      return;
    }
    return formats.run(settings.format, exportBridge(), settings, range, support);
  }

  // Frame-accurate offline export: every output frame seeks each visible source to
  // the exact source time, composites with the same code as the preview, and feeds
  // WebCodecs; audio is mixed offline; a self-built muxer writes the MP4.
  async function renderMp4(settings, range, support) {
    const frameRate = fps();
    const width = settings.width;
    const height = settings.height;
    const duration = range.end - range.start;
    const frameCount = Math.max(1, Math.round(duration * frameRate));
    const videoBitrate = Math.round(QUALITY_BPP[settings.quality] * width * height * frameRate);
    const audioBitrate = 192000;
    const mobile = isSmallDevice();
    const renderByteBudget = mobile ? 256 * 1024 * 1024 : 1024 * 1024 * 1024;
    const estimatedBytes = (duration * (videoBitrate + audioBitrate)) / 8;
    if (estimatedBytes > renderByteBudget) {
      setStatus(
        `This render may exceed the ${mobile ? '256 MB' : '1 GB'} local memory budget. Lower the quality, the size, or export a shorter range.`,
      );
      return;
    }

    pause();
    showProgram();
    state.rendering = true;
    state.cancelRender = false;
    updateHistoryButtons();
    if (!elements.renderDialog.hidden) elements.renderDialog.dataset.stage = 'rendering';
    else {
      state.returnFocus =
        typeof HTMLElement === 'function' && document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      elements.renderDialog.dataset.stage = 'rendering';
      setRenderDialogOpen(true);
    }
    elements.renderProgress.value = 0;
    elements.renderMessage.textContent = 'Preparing local media and the MP4 encoder…';
    elements.renderDialog.querySelector?.('[data-action="cancel-render"]')?.focus?.();

    const entries = new Map();
    const videoChunks = [];
    const audioChunks = [];
    let videoConfig = null;
    let audioConfig = null;
    let encoder = null;
    let audioEncoder = null;
    let encoderError = null;
    let encodedBytes = 0;
    let decodePath = 'media-element seeking';
    let decodeFallbacks = 0;
    const startedAt = performance.now();
    const isCancelled = () => state.cancelRender || Boolean(encoderError);
    let stalledExport = '';
    try {
      await prepareExportSources(entries);
      decodePath = exportDecodePath(entries);

      elements.renderMessage.textContent = 'Mixing audio on this device…';
      const sound =
        projectHasSound(range) && support.mp4Audio
          ? await renderAudioMix(range, isCancelled)
          : null;
      if (isCancelled()) throw new Error('cancelled');

      encoder = new window.VideoEncoder({
        output(chunk, meta) {
          if (meta?.decoderConfig) videoConfig = meta.decoderConfig;
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          encodedBytes += data.length;
          if (encodedBytes > renderByteBudget) {
            encoderError = new Error(
              'The encoded output exceeded this device’s local render-memory budget.',
            );
            return;
          }
          videoChunks.push({
            data,
            timestamp: chunk.timestamp,
            duration: chunk.duration,
            key: chunk.type === 'key',
          });
        },
        error(error) {
          encoderError = error;
        },
      });
      const videoCodec = support.mp4.codec;
      const encoderConfig = {
        codec: videoCodec,
        width,
        height,
        bitrate: videoBitrate,
        framerate: frameRate,
        latencyMode: 'quality',
      };
      if (videoCodec.startsWith('avc1')) encoderConfig.avc = { format: 'avc' };
      encoder.configure(encoderConfig);

      const canvas =
        typeof OffscreenCanvas === 'function'
          ? new OffscreenCanvas(width, height)
          : Object.assign(document.createElement('canvas'), { width, height });
      const context = canvas.getContext('2d', { alpha: false });
      const frameMicros = 1e6 / frameRate;
      const keyInterval = Math.max(1, Math.round(frameRate * 2));
      for (let index = 0; index < frameCount; index += 1) {
        if (isCancelled()) break;
        const time = range.start + index / frameRate;
        // Seek every visible video source to its exact frame for this output frame.
        await seekExportSources(entries, time, frameRate);
        if (entries.fallbacks && entries.fallbacks !== decodeFallbacks) {
          decodeFallbacks = entries.fallbacks;
          decodePath = 'media-element seeking after the WebCodecs decoder stalled';
        }
        drawComposite(context, time, { width, height, entries });
        const frame = new window.VideoFrame(canvas, {
          timestamp: Math.round(index * frameMicros),
          duration: Math.round(frameMicros),
        });
        encoder.encode(frame, { keyFrame: index % keyInterval === 0 });
        frame.close();
        const queueWait = performance.now();
        while (encoder.encodeQueueSize > 6 && !isCancelled()) {
          if (performance.now() - queueWait > EXPORT_STALL_MS)
            throw new ExportStall('The browser video encoder stopped accepting frames.');
          await new Promise((resolve) => window.setTimeout(resolve, 2));
        }
        if (index % 3 === 0 || index === frameCount - 1) {
          const progress = (index + 1) / frameCount;
          elements.renderProgress.value = progress * (sound ? 0.9 : 1);
          const elapsed = (performance.now() - startedAt) / 1000;
          const speed = elapsed > 0 ? (index + 1) / frameRate / elapsed : 0;
          elements.renderMessage.textContent = `Frame ${index + 1} of ${frameCount} · ${speed.toFixed(2)}× real time · the tab can stay in the background.`;
        }
      }
      if (encoderError) throw encoderError;
      if (state.cancelRender) throw new Error('cancelled');
      await withStallTimeout(encoder.flush(), 'The browser video encoder did not finish.');
      if (encoderError) throw encoderError;

      if (sound) {
        elements.renderMessage.textContent = 'Encoding audio…';
        audioEncoder = new window.AudioEncoder({
          output(chunk, meta) {
            if (meta?.decoderConfig) audioConfig = meta.decoderConfig;
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            audioChunks.push({ data, timestamp: chunk.timestamp, duration: chunk.duration });
          },
          error(error) {
            encoderError = error;
          },
        });
        audioEncoder.configure({
          codec: support.mp4Audio.codec,
          sampleRate: 48000,
          numberOfChannels: 2,
          bitrate: audioBitrate,
        });
        const left = sound.getChannelData(0);
        const right = sound.numberOfChannels > 1 ? sound.getChannelData(1) : left;
        const block = 4800;
        for (let start = 0; start < sound.length; start += block) {
          if (isCancelled()) break;
          const count = Math.min(block, sound.length - start);
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
            await new Promise((resolve) => window.setTimeout(resolve, 0));
        }
        if (encoderError) throw encoderError;
        if (state.cancelRender) throw new Error('cancelled');
        await withStallTimeout(audioEncoder.flush(), 'The browser audio encoder did not finish.');
        elements.renderProgress.value = 0.97;
      }

      if (!videoConfig || (!videoConfig.description && videoCodec.startsWith('avc1')))
        throw new Error('The video encoder returned no decoder configuration.');
      const muxer = mp4().createMuxer({
        video: {
          codec: videoCodec,
          width,
          height,
          description: videoConfig.description,
          timescale: 90000,
        },
        audio:
          sound && audioChunks.length
            ? {
                codec: support.mp4Audio.codec,
                sampleRate: 48000,
                channels: 2,
                description: audioConfig?.description,
                bitrate: audioBitrate,
              }
            : null,
      });
      const ordered = videoChunks
        .map((chunk) => ['video', chunk])
        .concat(audioChunks.map((chunk) => ['audio', chunk]));
      ordered.sort((a, b) => a[1].timestamp - b[1].timestamp);
      for (const [kind, chunk] of ordered)
        kind === 'video' ? muxer.addVideoChunk(chunk) : muxer.addAudioChunk(chunk);
      videoChunks.length = 0;
      audioChunks.length = 0;
      const output = muxer.finalize();
      const blob = new Blob(output.parts, { type: 'video/mp4' });
      if (!blob.size) throw new Error('The browser returned an empty render.');
      const fileName = `${safeFileName(state.project.name)}.mp4`;
      downloadBlob(blob, fileName);
      offerRenderedBlob(blob, fileName, duration);
      const seconds = (performance.now() - startedAt) / 1000;
      setStatus(
        `Render complete · ${formatBytes(blob.size)} · MP4 ${support.mp4.label}${sound ? ` + ${support.mp4Audio.label}` : ''} · ${width}×${height} · ${(duration / Math.max(0.001, seconds)).toFixed(2)}× real time · ${decodePath}`,
      );
    } catch (error) {
      if (state.cancelRender && (!encoderError || error.message === 'cancelled'))
        setStatus('Render cancelled');
      else if (
        error instanceof ExportStall ||
        /stopped responding|did not finish|stopped accepting/.test(String(error && error.message))
      ) {
        // Never a silent hang: say what happened and point at the path that does not depend on it.
        console.error('AlcorVideo MP4 export stalled:', error);
        stalledExport = `MP4 export stopped: ${error.message} Nothing was saved. Try Format: WebM (real time), which records the sequence while it plays.`;
        setStatus(`Render failed: ${stalledExport}`);
      } else {
        console.error('AlcorVideo MP4 export failed:', error);
        setStatus(`Render failed: ${error.message}`);
      }
    } finally {
      try {
        if (encoder && encoder.state !== 'closed') encoder.close();
      } catch (_) {}
      try {
        if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close();
      } catch (_) {}
      releaseExportSources(entries);
      videoChunks.length = 0;
      audioChunks.length = 0;
      state.rendering = false;
      state.cancelRender = false;
      setRenderDialogOpen(false);
      state.returnFocus?.focus?.();
      state.returnFocus = null;
      updateHistoryButtons();
      syncPreviewMedia(false);
      renderAll();
      if (stalledExport) offerWebmAfterStall(stalledExport);
    }
  }

  function supportedRecorderType(needsAudio = true) {
    if (!window.MediaRecorder) return '';
    const candidates = needsAudio
      ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
      : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
    return (
      candidates.find(
        (type) => !MediaRecorder.isTypeSupported || MediaRecorder.isTypeSupported(type),
      ) || ''
    );
  }

  function waitForMetadata(element, timeout = 12000) {
    if (element.readyState >= 1) return Promise.resolve(element);
    return waitFor(element, 'loadedmetadata', 'error', timeout);
  }

  // Real-time fallback: private media elements play the sequence once while the
  // canvas and a Web Audio mix are recorded.
  async function makeRenderEntries(audioContext, destination) {
    const entries = new Map();
    const waits = [];
    for (const clip of state.project.clips) {
      if (!isMediaClip(clip)) continue;
      const assetRuntime = state.runtimeAssets.get(clip.assetId);
      if (!assetRuntime) continue;
      if (clip.kind === 'image') {
        entries.set(clip.id, { element: assetRuntime.image, kind: 'image', gain: null });
        continue;
      }
      const media = document.createElement(clip.kind === 'video' ? 'video' : 'audio');
      media.src = assetRuntime.objectUrl;
      media.preload = 'auto';
      media.playsInline = true;
      media.muted = clip.kind === 'video';
      try {
        media.preservesPitch = false;
      } catch (_) {}
      waits.push(waitForMetadata(media));
      if (clip.kind === 'audio' && audioContext) {
        const source = audioContext.createMediaElementSource(media);
        const gain = audioContext.createGain();
        gain.gain.value = 0;
        // Same effect chain and downmix as the preview graph and the offline mix.
        const fx = window.AlcorVideoAudioFx || null;
        const channels = Number(getAsset(clip.assetId)?.channels) || 2;
        let head = source;
        const downmix = fx && channels > 2 ? fx.buildDownmix(audioContext, channels) : null;
        if (downmix) {
          head.connect(downmix.input);
          head = downmix.output;
        }
        if (fx && clip.audioFx) {
          const chain = fx.buildChain(audioContext, clip.audioFx);
          head.connect(chain.input);
          head = chain.output;
        }
        head.connect(gain);
        gain.connect(destination);
        entries.set(clip.id, { element: media, kind: clip.kind, source, gain });
      } else {
        entries.set(clip.id, { element: media, kind: clip.kind, gain: null });
      }
    }
    await Promise.all(waits);
    return entries;
  }

  function syncRenderEntries(entries, time, playing) {
    const audible = Edit.audibleTrackIds(state.project);
    const visible = Edit.visibleTrackIds(state.project);
    for (const clip of state.project.clips) {
      if (!isMediaClip(clip) || clip.kind === 'image') continue;
      const entry = entries.get(clip.id);
      if (!entry) continue;
      const media = entry.element;
      const active =
        clip.kind === 'video'
          ? visible.has(clip.track) &&
            transitionCore.visualActiveAt(clip, time, state.project.clips, state.project.assets)
          : transitionCore.audioActiveAt(clip, time, state.project.clips, state.project.assets);
      if (entry.gain) {
        const track = getTrack(clip.track);
        entry.gain.gain.value = active
          ? clipAudioGain(clip, time, audible) * (track ? dbToGain(track.volume) : 1)
          : 0;
      }
      if (!active) {
        if (!media.paused) media.pause();
        continue;
      }
      const desired = sourceTimeForPicture(clip, time);
      const stepped = clip.hold != null || clip.reverse;
      if (Math.abs((media.currentTime || 0) - desired) > (stepped ? 0.5 / fps() : 0.22)) {
        try {
          media.currentTime = desired;
        } catch (_) {}
      }
      if (stepped) {
        if (!media.paused) media.pause();
        continue;
      }
      if (clip.kind === 'audio') {
        try {
          media.preservesPitch = Boolean(clip.preservePitch);
        } catch (_) {}
      }
      media.playbackRate = clamp(clipSpeedAt(clip, time), 0.0625, 16);
      if (playing && media.paused) media.play().catch(() => {});
      if (!playing && !media.paused) media.pause();
    }
  }

  async function renderRealtime(range = { start: 0, end: projectDuration() }) {
    if (state.rendering) return;
    const duration = range.end - range.start;
    if (duration <= 0) {
      setStatus('Add clips before rendering');
      return;
    }
    if (!elements.canvas.captureStream || !window.MediaRecorder) {
      setStatus('This browser does not expose canvas MediaRecorder rendering');
      return;
    }
    const audibleTracks = Edit.audibleTrackIds(state.project);
    const needsRenderAudio = state.project.clips.some(
      (clip) =>
        isMediaClip(clip) &&
        clip.kind !== 'image' &&
        clip.kind !== 'video' &&
        !clip.muted &&
        audibleTracks.has(clip.track),
    );
    const mimeType = supportedRecorderType(needsRenderAudio);
    if (!mimeType) {
      setStatus('No supported browser video encoder was found');
      return;
    }
    const videoBitsPerSecond = state.project.width >= 1920 ? 12_000_000 : 7_000_000;
    const mobile = isSmallDevice();
    const renderByteBudget = mobile ? 256 * 1024 * 1024 : 1024 * 1024 * 1024;
    const estimatedBytes = (duration * (videoBitsPerSecond + (needsRenderAudio ? 192_000 : 0))) / 8;
    if (estimatedBytes > renderByteBudget) {
      setStatus(
        `This render may exceed the ${mobile ? '256 MB' : '1 GB'} local memory budget. Shorten the sequence or lower its dimensions.`,
      );
      return;
    }

    pause();
    showProgram();
    state.rendering = true;
    state.cancelRender = false;
    updateHistoryButtons();
    if (elements.renderDialog.hidden)
      state.returnFocus =
        typeof HTMLElement === 'function' && document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    elements.renderDialog.dataset.stage = 'rendering';
    setRenderDialogOpen(true);
    elements.renderProgress.value = 0;
    elements.renderMessage.textContent = 'Preparing local media and browser encoder…';
    elements.renderDialog.querySelector?.('[data-action="cancel-render"]')?.focus?.();

    const oldTime = state.currentTime;
    const oldScale = state.previewScale;
    state.previewScale = 1;
    let audioContext = null;
    let renderEntries = null;
    let renderTracks = [];
    let recorder = null;
    let renderFailure = null;
    let finishFrames = null;
    let renderFrameId = 0;
    const chunks = [];
    const stopCapture = () => {
      try {
        if (recorder && recorder.state !== 'inactive') recorder.stop();
      } catch (_) {}
      for (const track of renderTracks.splice(0)) {
        try {
          track.stop();
        } catch (_) {}
      }
    };
    const failRender = (error) => {
      renderFailure = renderFailure || error;
      state.cancelRender = true;
      chunks.length = 0;
      finishFrames?.();
      stopCapture();
    };
    // A hidden tab stops animation frames, which would freeze a real-time render. Fail closed.
    const onHidden = () => {
      if (document.visibilityState === 'hidden' && state.rendering)
        failRender(
          new Error(
            'The tab was hidden, which pauses real-time rendering. Keep the tab visible, or use MP4 export.',
          ),
        );
    };
    document.addEventListener?.('visibilitychange', onHidden);
    try {
      let destination = null;
      if (needsRenderAudio) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        // Call resume while renderVideo is still on the initiating click stack.
        // Safari may reject a resume first attempted after asynchronous media setup.
        const resumeAudio = audioContext.resume();
        destination = audioContext.createMediaStreamDestination();
        renderEntries = await makeRenderEntries(audioContext, destination);
        await resumeAudio;
      } else {
        // Image/title-only timelines have no audio to mix. Avoid creating a
        // Web Audio context just to manufacture silence; record video-only.
        renderEntries = await makeRenderEntries(null, null);
      }

      state.currentTime = range.start;
      syncRenderEntries(renderEntries, range.start, false);
      renderFrame(range.start, renderEntries);

      const canvasStream = elements.canvas.captureStream(Number(state.project.fps) || 30);
      renderTracks = [
        ...canvasStream.getVideoTracks(),
        ...(destination ? destination.stream.getAudioTracks() : []),
      ];
      const stream = new MediaStream(renderTracks);
      const recorderOptions = {
        mimeType,
        videoBitsPerSecond,
      };
      if (destination) recorderOptions.audioBitsPerSecond = 192_000;
      recorder = new MediaRecorder(stream, recorderOptions);
      let recordedBytes = 0;
      recorder.addEventListener('dataavailable', (event) => {
        if (renderFailure || state.cancelRender || !event.data || !event.data.size) return;
        recordedBytes += event.data.size;
        if (!Number.isSafeInteger(recordedBytes) || recordedBytes > renderByteBudget) {
          failRender(
            new Error('The encoded output exceeded this device’s local render-memory budget.'),
          );
          return;
        }
        chunks.push(event.data);
      });
      const stopped = new Promise((resolve, reject) => {
        recorder.addEventListener('stop', resolve, { once: true });
        recorder.addEventListener(
          'error',
          () => {
            const error = recorder.error || new Error('MediaRecorder failed.');
            failRender(error);
            reject(error);
          },
          { once: true },
        );
      });

      // The start call queues encoder work. Do not spend a short sequence's
      // whole duration waiting for that work to begin. Readiness has a bound.
      // Keep the later stop/error promise observed during startup as well.
      stopped.catch(() => {});
      await new Promise((resolve, reject) => {
        let timer = 0;
        let primeFrame = 0;
        let waiting = true;
        const cleanup = () => {
          waiting = false;
          clearTimeout(timer);
          cancelAnimationFrame(primeFrame);
          recorder.removeEventListener('start', ready);
          recorder.removeEventListener('error', failed);
          recorder.removeEventListener('stop', stoppedEarly);
        };
        const ready = () => {
          cleanup();
          resolve();
        };
        const failed = () => {
          cleanup();
          reject(recorder.error || new Error('The browser encoder could not start.'));
        };
        const stoppedEarly = () => {
          cleanup();
          reject(new Error('The browser encoder stopped before it was ready.'));
        };
        recorder.addEventListener('start', ready, { once: true });
        recorder.addEventListener('error', failed, { once: true });
        recorder.addEventListener('stop', stoppedEarly, { once: true });
        timer = setTimeout(() => {
          cleanup();
          reject(new Error('The browser encoder did not become ready within 10 seconds.'));
        }, 10000);
        try {
          recorder.start(1000);
          // Some engines wait for the first captured frame before start.
          const prime = () => {
            if (!waiting) return;
            try {
              renderFrame(0, renderEntries);
              for (const track of canvasStream.getVideoTracks()) track.requestFrame?.();
              primeFrame = requestAnimationFrame(prime);
            } catch (error) {
              cleanup();
              reject(error);
            }
          };
          prime();
        } catch (error) {
          cleanup();
          reject(error);
        }
      });
      const startedAt = performance.now();
      elements.renderMessage.textContent = `Rendering ${formatClock(duration)} in real time. Keep this tab visible.`;

      await new Promise((resolve, reject) => {
        finishFrames = resolve;
        const frame = (now) => {
          try {
            const elapsed = Math.min(duration, (now - startedAt) / 1000);
            const time = range.start + elapsed;
            state.currentTime = time;
            syncRenderEntries(renderEntries, time, !state.cancelRender);
            renderFrame(time, renderEntries);
            elements.renderProgress.value = duration ? elapsed / duration : 1;
            if (state.cancelRender || elapsed >= duration) {
              syncRenderEntries(renderEntries, time, false);
              resolve();
              return;
            }
            renderFrameId = requestAnimationFrame(frame);
          } catch (error) {
            reject(error);
          }
        };
        if (renderFailure) resolve();
        else renderFrameId = requestAnimationFrame(frame);
      });

      if (renderFailure) throw renderFailure;
      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
      if (renderFailure) throw renderFailure;

      if (!state.cancelRender) {
        const blob = new Blob(chunks, { type: mimeType });
        if (!blob.size) throw new Error('The browser returned an empty render.');
        const extension = mimeType.includes('mp4') ? 'mp4' : 'webm';
        const fileName = `${safeFileName(state.project.name)}.${extension}`;
        downloadBlob(blob, fileName);
        offerRenderedBlob(blob, fileName, duration);
        setStatus(`Render complete · ${formatBytes(blob.size)} · ${extension.toUpperCase()}`);
      } else {
        setStatus('Render cancelled');
      }
    } catch (error) {
      renderFailure = renderFailure || error;
      console.error('AlcorVideo render failed:', renderFailure);
      setStatus(`Render failed: ${renderFailure.message}`);
    } finally {
      document.removeEventListener?.('visibilitychange', onHidden);
      finishFrames = null;
      cancelAnimationFrame(renderFrameId);
      stopCapture();
      chunks.length = 0;
      if (renderEntries) {
        for (const entry of renderEntries.values()) {
          entry.element?.pause?.();
          if (entry.kind !== 'image') {
            entry.element?.removeAttribute?.('src');
            entry.element?.load?.();
          }
        }
      }
      if (audioContext && audioContext.state !== 'closed')
        await audioContext.close().catch(() => {});
      state.rendering = false;
      state.cancelRender = false;
      state.previewScale = oldScale;
      state.currentTime = clamp(oldTime, 0, projectDuration());
      setRenderDialogOpen(false);
      state.returnFocus?.focus?.();
      state.returnFocus = null;
      updateHistoryButtons();
      syncPreviewMedia(false);
      renderAll();
    }
  }

  function cancelRender() {
    if (!state.rendering) return;
    state.cancelRender = true;
    elements.renderMessage.textContent = 'Stopping the local render…';
  }

  // ------------------------------------------------------ recovery (opt-in)

  // Off by default: the editor keeps projects in memory unless you save a file.
  // When you switch it on, a copy of the project and its media is kept in this
  // browser's IndexedDB on this device (never uploaded) so a crash or closed tab
  // can be recovered. Nothing is read from storage unless you press Recover.
  const RECOVERY_DB = 'alcorvideo-recovery';
  const RECOVERY_STORE = 'session';

  function openRecoveryDb() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined' || !indexedDB) {
        reject(new Error('This browser has no IndexedDB storage.'));
        return;
      }
      const request = indexedDB.open(RECOVERY_DB, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(RECOVERY_STORE))
          request.result.createObjectStore(RECOVERY_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error || new Error('Recovery storage could not open.'));
    });
  }

  function recoveryTransaction(db, mode, run) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(RECOVERY_STORE, mode);
      const store = transaction.objectStore(RECOVERY_STORE);
      let result;
      Promise.resolve(run(store)).then((value) => {
        result = value;
      }, reject);
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () =>
        reject(transaction.error || new Error('Recovery storage write failed.'));
      transaction.onabort = () =>
        reject(transaction.error || new Error('Recovery storage was full or blocked.'));
    });
  }

  function scheduleRecovery() {
    if (!state.recovery.enabled) return;
    window.clearTimeout(state.recovery.timer);
    state.recovery.timer = window.setTimeout(() => {
      writeRecovery().catch(() => {});
    }, 1500);
  }

  async function writeRecovery() {
    if (!state.recovery.enabled || state.recovery.busy) return;
    state.recovery.busy = true;
    try {
      const db = await openRecoveryDb();
      const project = JSON.parse(serializeProject());
      const saved = state.recovery.savedMedia || (state.recovery.savedMedia = new Set());
      let pending = project.assets.filter(
        (asset) => state.runtimeAssets.get(asset.id)?.file && !saved.has(asset.id),
      );
      let mediaIncluded = true;
      if (pending.length && navigator.storage?.estimate) {
        const estimate = await navigator.storage.estimate();
        const bytes = pending.reduce(
          (sum, asset) => sum + (state.runtimeAssets.get(asset.id).file.size || 0),
          0,
        );
        if (
          estimate.quota &&
          estimate.usage != null &&
          bytes > (estimate.quota - estimate.usage) * 0.8
        ) {
          pending = [];
          mediaIncluded = false;
        }
      }
      await recoveryTransaction(db, 'readwrite', (store) => {
        for (const asset of pending)
          store.put(state.runtimeAssets.get(asset.id).file, `media:${asset.id}`);
        store.put({ savedAt: new Date().toISOString(), project, mediaIncluded }, 'latest');
      });
      for (const asset of pending) saved.add(asset.id);
      db.close();
      if (elements.recoveryToggle)
        elements.recoveryToggle.title = `Recovery copy saved ${new Date().toLocaleTimeString()}${mediaIncluded ? '' : ' (media too large for browser storage; relink after recovery)'}`;
    } catch (error) {
      setStatus(`Recovery copy not saved: ${error.message}`);
    } finally {
      state.recovery.busy = false;
    }
  }

  async function setRecoveryEnabled(enabled) {
    state.recovery.enabled = Boolean(enabled);
    if (elements.recoveryToggle) elements.recoveryToggle.checked = state.recovery.enabled;
    if (state.recovery.enabled) {
      state.recovery.savedMedia = new Set();
      await writeRecovery();
      setStatus(
        'Recovery copy on: this project and its media are kept in this browser on this device until you turn it off',
      );
    } else {
      window.clearTimeout(state.recovery.timer);
      if (window.confirm('Delete the recovery copy stored in this browser?')) {
        try {
          await new Promise((resolve, reject) => {
            const request = indexedDB.deleteDatabase(RECOVERY_DB);
            request.onsuccess = resolve;
            request.onerror = () => reject(request.error);
            request.onblocked = resolve;
          });
          setStatus('Recovery copy off and deleted from this browser');
        } catch (error) {
          setStatus(`Recovery copy off; deleting it failed: ${error.message}`);
        }
      } else {
        setStatus('Recovery copy off; the last stored copy was kept');
      }
    }
  }

  async function recoverProject() {
    if (state.projectIO || state.importing || state.rendering) {
      setStatus('Wait for the current operation to finish.');
      return;
    }
    let db;
    try {
      db = await openRecoveryDb();
      const record = await recoveryTransaction(
        db,
        'readonly',
        (store) =>
          new Promise((resolve, reject) => {
            const request = store.get('latest');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          }),
      );
      if (!record || !record.project) {
        setStatus('No recovery copy is stored in this browser');
        return;
      }
      if (
        state.dirty &&
        !window.confirm(
          `Replace the current project with the recovery copy from ${new Date(record.savedAt).toLocaleString()}?`,
        )
      )
        return;
      state.projectIO = true;
      const notes = [];
      const project = normalizeProject(record.project, { notes });
      const staged = new Map();
      for (const asset of project.assets) {
        const file = await recoveryTransaction(
          db,
          'readonly',
          (store) =>
            new Promise((resolve) => {
              const request = store.get(`media:${asset.id}`);
              request.onsuccess = () => resolve(request.result || null);
              request.onerror = () => resolve(null);
            }),
        );
        if (file) {
          try {
            staged.set(asset.id, await buildRuntimeAsset(asset, file));
          } catch (_) {}
        }
      }
      pause(false);
      cleanupRuntime(new Set([...staged.values()].map((runtime) => runtime.objectUrl)));
      state.project = project;
      state.runtimeAssets = staged;
      state.selection = new Set();
      state.selectedId = null;
      state.currentTime = 0;
      state.history.clear();
      if (elements.projectName) elements.projectName.value = project.name;
      markDirty('Recovered project');
      for (const [assetId, runtime] of staged.entries()) announceMedia(getAsset(assetId), runtime);
      renderAll();
      const offline = project.assets.length - staged.size;
      setStatus(
        `Recovered project from ${new Date(record.savedAt).toLocaleString()}${offline ? ` · ${offline} media file${offline === 1 ? '' : 's'} need relinking` : ''}`,
      );
    } catch (error) {
      setStatus(`Could not recover: ${error.message}`);
    } finally {
      state.projectIO = false;
      db?.close?.();
    }
  }

  // ------------------------------------------------------------------ wiring

  function renderMixer() {
    const mixer = elements.mixer;
    if (!mixer) return;
    const tracks = state.project.tracks.filter((track) => track.kind === 'audio');
    mixer.replaceChildren();
    for (const track of tracks) {
      const strip = document.createElement('div');
      strip.className = 'av-mixer-strip';
      strip.dataset.mixerTrack = track.id;
      const name = document.createElement('strong');
      name.textContent = track.id;
      const volumeLabel = document.createElement('label');
      volumeLabel.textContent = 'Level ';
      const volume = document.createElement('input');
      volume.type = 'range';
      volume.min = '-60';
      volume.max = '12';
      volume.step = '0.5';
      volume.value = String(track.volume || 0);
      volume.dataset.mixerField = 'volume';
      volume.setAttribute('aria-label', `${track.id} level in dB`);
      const readout = document.createElement('output');
      readout.textContent = `${(track.volume || 0) > 0 ? '+' : ''}${(track.volume || 0).toFixed(1)} dB`;
      volumeLabel.append(volume, readout);
      const panLabel = document.createElement('label');
      panLabel.textContent = 'Pan ';
      const pan = document.createElement('input');
      pan.type = 'range';
      pan.min = '-100';
      pan.max = '100';
      pan.step = '1';
      pan.value = String(Math.round((track.pan || 0) * 100));
      pan.dataset.mixerField = 'pan';
      pan.setAttribute('aria-label', `${track.id} pan`);
      panLabel.append(pan);
      const buttons = document.createElement('div');
      buttons.className = 'av-mixer-buttons';
      buttons.append(
        trackButton('mute', `${track.muted ? 'Unmute' : 'Mute'} ${track.id}`, track.muted, 'M'),
        trackButton('solo', `${track.solo ? 'Unsolo' : 'Solo'} ${track.id}`, track.solo, 'S'),
      );
      strip.append(name, volumeLabel, panLabel, buttons);
      strip.dataset.track = track.id;
      mixer.append(strip);
    }
  }

  function applyMixerField(field, commit) {
    const strip = field.closest('[data-mixer-track]');
    const track = strip && getTrack(strip.dataset.mixerTrack);
    if (!track) return;
    const apply = () => {
      if (field.dataset.mixerField === 'volume')
        track.volume = round(clamp(field.value, -60, 12), 1);
      else track.pan = round(clamp(Number(field.value) / 100, -1, 1), 2);
    };
    if (!commit) {
      state.mixerBefore = state.mixerBefore || snapshot();
      apply();
      const readout = strip.querySelector('output');
      if (readout && field.dataset.mixerField === 'volume')
        readout.textContent = `${track.volume > 0 ? '+' : ''}${track.volume.toFixed(1)} dB`;
      refreshTrackAudio();
      return;
    }
    const before = state.mixerBefore || snapshot();
    state.mixerBefore = null;
    apply();
    if (snapshot() !== before) {
      pushHistory(before, `${track.id} ${field.dataset.mixerField === 'volume' ? 'level' : 'pan'}`);
      markDirty('Mixer changed');
    }
    refreshTrackAudio();
  }

  root.addEventListener('input', (event) => {
    if (event.target.dataset?.mixerField) applyMixerField(event.target, false);
  });

  function renderAll() {
    root.classList.toggle(
      'av-is-empty',
      !state.project.assets.length && !state.project.clips.length,
    );
    renderMixer();
    renderMediaBin();
    renderTimeline();
    renderInspector();
    renderPreview();
    updateHistoryButtons();
    renderMarkerList();
    syncSequenceControls();
    updateSourceInfo();
  }

  function action(name, button = null) {
    if (
      (state.projectIO || state.importing) &&
      ['new-project', 'render', 'export', 'export-project'].includes(name)
    ) {
      setStatus('Wait for the current file operation to finish.');
      return;
    }
    switch (name) {
      case 'new-project':
        newProject();
        break;
      case 'save-browser':
        return savePortableProject();
      case 'export-project':
        exportProjectFile();
        break;
      case 'render':
        return renderVideo();
      case 'export':
        return openExportDialog();
      case 'export-close':
        closeExportDialog();
        break;
      case 'cancel-render':
        state.rendering ? cancelRender() : closeExportDialog();
        break;
      case 'undo':
        undo();
        break;
      case 'redo':
        redo();
        break;
      case 'split':
        splitSelection();
        break;
      case 'split-all':
        splitSelection({ allTracks: true });
        break;
      case 'ripple-trim-start':
        rippleTrimToPlayhead('start');
        break;
      case 'ripple-trim-end':
        rippleTrimToPlayhead('end');
        break;
      case 'duplicate':
        duplicateSelection();
        break;
      case 'delete-selection':
        deleteSelection();
        break;
      case 'ripple-delete':
        rippleDeleteSelection();
        break;
      case 'add-title':
        addTitle(button?.dataset?.preset || 'caption');
        break;
      case 'title-preset':
        addTitle(button?.dataset?.preset || 'title');
        break;
      case 'add-marker':
        addMarkerAtPlayhead();
        break;
      case 'mark-in':
        markIn();
        break;
      case 'mark-out':
        markOut();
        break;
      case 'clear-inout':
        mutate('In and out cleared', () => {
          state.project.inPoint = null;
          state.project.outPoint = null;
        });
        break;
      case 'lift':
        liftOrExtract(false);
        break;
      case 'extract':
        liftOrExtract(true);
        break;
      case 'play':
        play();
        break;
      case 'jump-start':
        seek(0);
        break;
      case 'jump-end':
        seek(projectDuration());
        break;
      case 'step-back':
        stepFrames(-1);
        break;
      case 'step-forward':
        stepFrames(1);
        break;
      case 'add-video-track':
        addTrack('video');
        break;
      case 'add-audio-track':
        addTrack('audio');
        break;
      case 'monitor-program':
        showProgram();
        break;
      case 'monitor-source':
        if (state.source) loadSource(state.source.assetId);
        break;
      case 'insert-edit':
        editFromSource(false);
        break;
      case 'overwrite-edit':
        editFromSource(true);
        break;
      case 'frame-hold':
        frameHold(false);
        break;
      case 'frame-hold-insert':
        frameHold(true);
        break;
      case 'link':
        toggleLink();
        break;
      case 'recover':
        return recoverProject();
      case 'zoom-fit':
        zoomToFit();
        break;
      case 'zoom-in':
        setZoom(state.pxPerSecond * 1.25);
        break;
      case 'zoom-out':
        setZoom(state.pxPerSecond / 1.25);
        break;
      case 'apply-transition':
        applyDefaultTransition(
          button?.dataset?.kind === 'audio' ? 'audio' : 'video',
          button?.dataset?.transition || '',
        );
        break;
      case 'copy':
        copySelection();
        break;
      case 'paste':
        pasteClipboard(false);
        break;
      case 'load-sample':
        return loadSampleProject();
      case 'append-asset': {
        const asset = getAsset(button?.dataset?.asset);
        if (asset && state.runtimeAssets.has(asset.id))
          addAssetToTrack(asset.id, defaultTrackFor(asset.kind));
        break;
      }
      case 'show-shortcuts':
        showShortcuts(true);
        break;
      case 'close-shortcuts':
        showShortcuts(false);
        break;
      case 'dismiss-render-result':
        root.querySelector('.av-render-result')?.classList.add('is-dismissed');
        break;
      default:
        break;
    }
  }

  function selectPanelTab(name) {
    for (const tab of $$('[data-panel-tab]')) {
      const active = tab.dataset.panelTab === name;
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.tabIndex = active ? 0 : -1;
      const pane = $(`#${tab.getAttribute('aria-controls')}`);
      if (pane) pane.hidden = !active;
    }
    if (name === 'history') renderHistoryPanel();
    if (name === 'markers') renderMarkerList();
    if (name === 'mixer') renderMixer();
    if (name === 'scopes') loadGroup('grade').then(() => renderPreview());
  }

  root.addEventListener('keydown', (event) => {
    const tab = event.target.closest?.('[data-panel-tab]');
    if (!tab || (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft')) return;
    const tabs = $$('[data-panel-tab]');
    const next =
      tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    event.preventDefault();
    event.stopPropagation();
    selectPanelTab(next.dataset.panelTab);
    next.focus();
  });

  root.addEventListener('click', (event) => {
    const panelTab = event.target.closest('[data-panel-tab]');
    if (panelTab) {
      selectPanelTab(panelTab.dataset.panelTab);
      return;
    }
    const tool = event.target.closest('button[data-tool]');
    if (tool && !tool.disabled) {
      setTool(tool.dataset.tool);
      return;
    }
    const trackToggle = event.target.closest('[data-track-action]');
    if (trackToggle) {
      const row = trackToggle.closest('[data-track]');
      if (row) trackAction(row.dataset.track, trackToggle.dataset.trackAction);
      return;
    }
    const historyItem = event.target.closest('[data-history-offset]');
    if (historyItem) {
      jumpHistory(Number(historyItem.dataset.historyOffset));
      return;
    }
    const markerGo = event.target.closest('[data-marker-go]');
    if (markerGo) {
      const marker = state.project.markers.find((item) => item.id === markerGo.dataset.markerGo);
      if (marker) seek(marker.time);
      return;
    }
    const markerRemove = event.target.closest('[data-marker-remove]');
    if (markerRemove) {
      mutate(
        'Marker removed',
        () => Edit.removeMarker(state.project, markerRemove.dataset.markerRemove).ok,
      );
      return;
    }
    const flag = event.target.closest('.av-marker[data-marker-id]');
    if (flag) {
      const marker = state.project.markers.find((item) => item.id === flag.dataset.markerId);
      if (marker) seek(marker.time);
      return;
    }
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled) return;
    return action(button.dataset.action, button);
  });

  root.addEventListener('change', (event) => {
    const target = event.target;
    if (target.dataset?.markerName) {
      mutate('Marker renamed', () => {
        const marker = state.project.markers.find((item) => item.id === target.dataset.markerName);
        if (!marker) return false;
        marker.name = String(target.value).slice(0, 80);
        return true;
      });
    } else if (target.dataset?.markerColor) {
      mutate('Marker color', () => {
        const marker = state.project.markers.find((item) => item.id === target.dataset.markerColor);
        if (!marker || !Edit.MARKER_COLORS.includes(target.value)) return false;
        marker.color = target.value;
        return true;
      });
    } else if (target === elements.recoveryToggle) {
      setRecoveryEnabled(target.checked);
    } else if (target === elements.sequencePreset) {
      setSequencePreset(target.value);
    } else if (target === elements.previewQuality) {
      state.previewScale = clamp(Number(target.value) || 1, 0.25, 1);
      renderPreview();
      setStatus(
        `Preview at ${Math.round(state.previewScale * 100)}% resolution (export is always full size)`,
      );
    } else if (target === elements.safeToggle) {
      state.safeMargins = target.checked;
      root.classList?.toggle?.('show-safe-margins', state.safeMargins);
    } else if (target === elements.loopToggle) {
      state.loop = target.checked;
    } else if (target === elements.linked) {
      state.linkedSelection = target.checked;
      setStatus(
        state.linkedSelection
          ? 'Linked selection on'
          : 'Linked selection off: linked clips edit independently',
      );
    } else if (target.dataset?.mixerField) {
      applyMixerField(target, true);
    } else if (target.closest?.('#av-export-form')) {
      refreshExportSupport();
    } else if (target.name === 'rippleSpeed') {
      // read when speed changes
    }
  });

  elements.mediaInput?.addEventListener('change', () => importMedia(elements.mediaInput.files));
  elements.projectFile?.addEventListener('change', async () => {
    try {
      await openProjectFile(elements.projectFile.files?.[0]);
    } catch (error) {
      setStatus(`Could not open project: ${error.message}`);
    } finally {
      elements.projectFile.value = '';
    }
  });

  elements.projectName?.addEventListener('focus', () => {
    elements.projectName.dataset.history = snapshot();
  });
  elements.projectName?.addEventListener('input', () => {
    state.project.name = elements.projectName.value.slice(0, 80) || 'Untitled project';
    markDirty('Project renamed');
  });
  elements.projectName?.addEventListener('change', () => {
    const before = elements.projectName.dataset.history;
    if (before && before !== snapshot()) pushHistory(before, 'Project renamed');
    delete elements.projectName.dataset.history;
  });

  elements.fps?.addEventListener('change', () => {
    mutate('Frame rate changed', () => {
      state.project.fps = FPS_OPTIONS.includes(Number(elements.fps.value))
        ? Number(elements.fps.value)
        : 30;
    });
  });
  elements.timeInput?.addEventListener('change', () => {
    const value = parseTimeInput(elements.timeInput.value);
    if (value == null) {
      setStatus('Type seconds (12.5) or timecode (00:00:12:15)');
      updatePlayhead();
      return;
    }
    seek(value);
  });
  elements.zoom?.addEventListener('input', () => {
    state.pxPerSecond = Number(elements.zoom.value) || 72;
    renderTimeline();
  });
  elements.snap?.addEventListener('change', () => {
    state.snap = elements.snap.checked;
    setStatus(state.snap ? 'Timeline snapping on' : 'Timeline snapping off');
  });

  elements.timeline.addEventListener('pointerdown', (event) => {
    const lane = event.target.closest?.('[data-track-lane]');
    if (
      !lane &&
      event.button === 0 &&
      !event.target.closest?.(
        '.av-timeline-clip, button, input, .av-ruler-row, .av-track-header, .av-playhead',
      )
    ) {
      // Empty timeline space clears the selection (and any gap selection).
      state.gap = null;
      if (state.selection.size) {
        selectClip(null);
        setStatus('Selection cleared');
      } else renderTimeline();
      return;
    }
    if (!lane || event.target !== lane || event.button !== 0) return;
    const time = timelineTimeFromPointer(event, lane);
    // Clicking empty space between clips selects that gap (Delete closes it), as in Premiere.
    const gap = Edit.gapAt(state.project, lane.dataset.trackLane, time);
    state.gap = gap
      ? { track: lane.dataset.trackLane, start: gap.start, end: gap.end, time }
      : null;
    selectClip(null);
    seek(snapToFrame(time));
    if (state.gap)
      setStatus(
        `Gap selected on ${state.gap.track} · ${formatClock(gap.end - gap.start, true)} · Delete closes it`,
      );
  });
  elements.timeline.addEventListener('dragover', (event) => {
    const types = Array.from(event.dataTransfer?.types || []);
    const zone = event.target.closest?.('[data-new-track-drop]');
    if (zone && (types.includes('application/x-alcorvideo-asset') || types.includes('Files'))) {
      event.preventDefault();
      zone.classList.add('is-drop-target');
      return;
    }
    if (
      event.target.closest?.('[data-track-lane]') &&
      types.includes('application/x-alcorvideo-asset')
    )
      event.preventDefault();
  });
  elements.timeline.addEventListener('dragleave', (event) => {
    event.target.closest?.('[data-new-track-drop]')?.classList.remove('is-drop-target');
  });
  elements.timeline.addEventListener('drop', (event) => {
    const zone = event.target.closest?.('[data-new-track-drop]');
    if (zone) {
      event.preventDefault();
      event.stopPropagation();
      zone.classList.remove('is-drop-target');
      dropOnNewTrack(event, zone.querySelector('[data-new-track-lane]') || zone);
      return;
    }
    const lane = event.target.closest?.('[data-track-lane]');
    if (!lane) return;
    if (dropAsset(event, lane)) event.preventDefault();
  });
  // Files dropped anywhere on the editor import into the bin.
  root.addEventListener('dragover', (event) => {
    if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault();
  });
  root.addEventListener('drop', (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    importMedia(event.dataTransfer.files);
  });
  elements.ruler.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest?.('.av-marker')) return;
    const startTime = state.currentTime;
    seek(snapToFrame(timelineTimeFromPointer(event, elements.ruler)));
    state.drag = { type: 'playhead', pointerId: event.pointerId, startTime };
  });
  elements.ruler.addEventListener('dblclick', (event) => {
    const flag = event.target.closest?.('.av-marker[data-marker-id]');
    if (!flag) return;
    const marker = state.project.markers.find((item) => item.id === flag.dataset.markerId);
    const name = marker ? window.prompt('Marker name', marker.name) : null;
    if (marker && name != null)
      mutate('Marker renamed', () => {
        marker.name = String(name).slice(0, 80);
      });
  });
  elements.playhead?.addEventListener('pointerdown', startPlayheadDrag);
  window.addEventListener('pointermove', (event) => {
    if (state.drag?.type === 'clip') moveClipDrag(event);
    else if (state.drag?.type === 'playhead') movePlayheadDrag(event);
  });
  window.addEventListener('pointerup', () => {
    if (state.drag?.type === 'clip') endClipDrag();
    else if (state.drag?.type === 'playhead') endPlayheadDrag();
  });
  window.addEventListener('pointercancel', () => {
    if (state.drag?.type === 'clip') endClipDrag(true);
    else if (state.drag?.type === 'playhead') endPlayheadDrag();
  });

  bindInspector(elements.clipInspector);
  bindInspector(elements.titleInspector);

  // Premiere Pro default shortcuts where they make sense in a browser.
  window.addEventListener('keydown', (event) => {
    if (state.rendering && event.key === 'Escape') {
      event.preventDefault();
      cancelRender();
      return;
    }
    const tag = event.target?.tagName?.toLowerCase();
    const editing =
      tag === 'input' || tag === 'textarea' || tag === 'select' || event.target?.isContentEditable;
    const focusedWorkspace = event.target?.classList?.contains('av-editor-scroll')
      ? event.target
      : null;
    if (
      editorCore.preserveWorkspaceArrowKey(
        event,
        focusedWorkspace,
        window.requestAnimationFrame.bind(window),
      )
    )
      return;
    const command = event.metaKey || event.ctrlKey;
    const key = String(event.key || '').toLowerCase();
    if (command && key === 'z') {
      event.preventDefault();
      event.shiftKey ? redo() : undo();
      return;
    }
    if (command && key === 'y') {
      event.preventDefault();
      redo();
      return;
    }
    if (editing || state.rendering) return;
    if (command && key === 's') {
      event.preventDefault();
      savePortableProject();
      return;
    }
    if (command && key === 'm') {
      event.preventDefault();
      openExportDialog();
      return;
    }
    if (command && key === 'k') {
      event.preventDefault();
      splitSelection({ allTracks: event.shiftKey });
      return;
    }
    if (command && key === 'c') {
      event.preventDefault();
      copySelection();
      return;
    }
    if (command && key === 'v') {
      event.preventDefault();
      pasteClipboard(event.shiftKey);
      return;
    }
    if (command && key === 'd') {
      event.preventDefault();
      applyDefaultTransition(event.shiftKey ? 'audio' : 'video');
      return;
    }
    if (command && key === 'l') {
      event.preventDefault();
      toggleLink();
      return;
    }
    if (command && key === 'r') {
      event.preventDefault();
      elements.clipInspector.elements.namedItem('speed')?.focus?.();
      return;
    }
    if (command && event.shiftKey && key === 'x') {
      event.preventDefault();
      action('clear-inout');
      return;
    }
    if (command && event.shiftKey && key === 'm') {
      event.preventDefault();
      goToMarker(-1);
      return;
    }
    if (command) return;

    if (event.key === '?') {
      event.preventDefault();
      showShortcuts(elements.shortcuts?.hidden !== false);
      return;
    }
    if (event.key === 'Escape') {
      if (elements.shortcuts && !elements.shortcuts.hidden) {
        showShortcuts(false);
        return;
      }
      if (state.drag?.type === 'clip') {
        endClipDrag(true);
        return;
      }
      if (state.drag?.type === 'playhead') {
        endPlayheadDrag(true);
        return;
      }
      if (state.monitor === 'source') {
        showProgram();
        return;
      }
      if (state.selection.size) selectClip(null);
      return;
    }
    if (event.code === 'Space') {
      event.preventDefault();
      play();
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      if (event.shiftKey) rippleDeleteSelection();
      else deleteSelection();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const direction = event.key === 'ArrowLeft' ? -1 : 1;
      if (event.altKey) nudgeSelection(direction * (event.shiftKey ? 5 : 1));
      else stepFrames(direction * (event.shiftKey ? 5 : 1));
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      goToEditPoint(event.key === 'ArrowUp' ? -1 : 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      seek(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      seek(projectDuration());
    } else if (key === 'j' || key === 'k' || key === 'l') {
      event.preventDefault();
      shuttle(key === 'j' ? -1 : key === 'l' ? 1 : 0);
    } else if (key === 'i') {
      event.preventDefault();
      if (event.altKey) setInOut('in', null);
      else if (event.shiftKey) {
        if (state.project.inPoint != null) seek(state.project.inPoint);
      } else markIn();
    } else if (key === 'o') {
      event.preventDefault();
      if (event.altKey) setInOut('out', null);
      else if (event.shiftKey) {
        if (state.project.outPoint != null) seek(state.project.outPoint);
      } else markOut();
    } else if (key === 'm') {
      event.preventDefault();
      if (event.shiftKey) goToMarker(1);
      else addMarkerAtPlayhead();
    } else if (key === 'q') {
      event.preventDefault();
      rippleTrimToPlayhead('start');
    } else if (key === 'w') {
      event.preventDefault();
      rippleTrimToPlayhead('end');
    } else if (key === 's') {
      event.preventDefault();
      state.snap = !state.snap;
      if (elements.snap) elements.snap.checked = state.snap;
      setStatus(state.snap ? 'Timeline snapping on' : 'Timeline snapping off');
    } else if (key === '=' || key === '+') {
      event.preventDefault();
      setZoom(state.pxPerSecond * 1.25);
    } else if (key === '-' || key === '_') {
      event.preventDefault();
      setZoom(state.pxPerSecond / 1.25);
    } else if (key === '\\') {
      event.preventDefault();
      zoomToFit();
    } else if (key === ',') {
      event.preventDefault();
      editFromSource(false);
    } else if (key === '.') {
      event.preventDefault();
      editFromSource(true);
    } else if (key === ';') {
      event.preventDefault();
      liftOrExtract(false);
    } else if (key === "'") {
      event.preventDefault();
      liftOrExtract(true);
    } else {
      const tool = Object.keys(TOOLS).find((name) => TOOLS[name].toLowerCase() === key);
      if (tool && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        setTool(tool);
      }
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (!state.dirty || state.rendering) return;
    event.preventDefault();
    event.returnValue = '';
  });
  window.addEventListener('pagehide', () => {
    pause(false);
    if (state.pendingRenderUrl) URL.revokeObjectURL(state.pendingRenderUrl);
  });
  document.addEventListener?.('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && state.playing) pause();
  });

  // ------------------------------------------------------------ chrome

  function reducedMotion() {
    return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  }

  // File menu: one button opens it; a command, Escape or a click elsewhere closes it.
  const fileMenu = $('.av-menu');
  const fileMenuButton = fileMenu?.querySelector('.av-menu-button');
  const menuItems = () => [
    ...(fileMenu?.querySelectorAll('[role="menuitem"], .av-recovery-toggle input') || []),
  ];
  function setFileMenu(open) {
    if (!fileMenu) return;
    fileMenu.classList.toggle('is-open', open);
    fileMenuButton?.setAttribute('aria-expanded', String(open));
    if (open) menuItems()[0]?.focus?.();
  }
  fileMenuButton?.addEventListener('click', () =>
    setFileMenu(!fileMenu.classList.contains('is-open')),
  );
  document.addEventListener?.('pointerdown', (event) => {
    if (fileMenu?.classList.contains('is-open') && !fileMenu.contains(event.target))
      setFileMenu(false);
  });
  fileMenu?.addEventListener('click', (event) => {
    // Close after the command's own click (and the file picker) has run.
    if (event.target.closest?.('[role="menuitem"]')) window.setTimeout(() => setFileMenu(false), 0);
  });
  fileMenu?.addEventListener('keydown', (event) => {
    if (!fileMenu.classList.contains('is-open')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setFileMenu(false);
      fileMenuButton?.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = menuItems();
    const at = items.indexOf(document.activeElement);
    items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  });

  // Keyboard shortcut sheet ("?").
  let shortcutsReturn = null;
  function showShortcuts(open) {
    if (!elements.shortcuts) return;
    if (open) {
      shortcutsReturn = document.activeElement;
      setFileMenu(false);
    }
    elements.shortcuts.hidden = !open;
    if (open) elements.shortcuts.querySelector('button')?.focus();
    else shortcutsReturn?.focus?.();
  }
  elements.shortcuts?.addEventListener('click', (event) => {
    if (event.target === elements.shortcuts) showShortcuts(false);
  });

  // Instant tooltips with keycaps on toolbar, transport and project buttons (a native title waits a second).
  const tip = document.createElement('div');
  tip.className = 'av-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  root.append?.(tip);
  const TIP_TARGETS =
    '.av-tools button, .av-timeline-tools button, .av-transport button, .av-app-actions > button';
  function showTip(target) {
    const title = target.getAttribute('title');
    if (title) {
      target.dataset.tip = title;
      target.removeAttribute('title');
    }
    const text =
      target.dataset.tip ||
      (/\([^)]+\)\s*$/.test(target.getAttribute('aria-label') || '')
        ? target.getAttribute('aria-label')
        : '');
    if (!text) return;
    const match = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(text);
    tip.replaceChildren(document.createTextNode(match ? match[1] : text));
    if (match)
      for (const key of match[2].split(/\s*\+\s*/)) {
        const kbd = document.createElement('kbd');
        kbd.textContent = key;
        tip.append(kbd);
      }
    tip.hidden = false;
    const box = target.getBoundingClientRect();
    const size = tip.getBoundingClientRect();
    tip.style.left = `${clamp(box.left + box.width / 2 - size.width / 2, 6, window.innerWidth - size.width - 6)}px`;
    tip.style.top = `${box.top - size.height - 8 < 6 ? box.bottom + 8 : box.top - size.height - 8}px`;
  }
  const hideTip = () => {
    tip.hidden = true;
  };
  root.addEventListener('pointerover', (event) => {
    const target = event.pointerType === 'mouse' && event.target.closest?.(TIP_TARGETS);
    if (target) showTip(target);
    else hideTip();
  });
  root.addEventListener('pointerleave', hideTip);
  root.addEventListener('pointerdown', hideTip, true);
  root.addEventListener('focusin', (event) => {
    const target = event.target.closest?.(TIP_TARGETS);
    if (target && target.matches(':focus-visible')) showTip(target);
    else hideTip();
  });
  root.addEventListener('focusout', hideTip);
  window.addEventListener('scroll', hideTip, { passive: true, capture: true });

  // Dragging files anywhere over the window lights up the whole editor as a drop target.
  let dragDepth = 0;
  const carriesFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
  window.addEventListener('dragenter', (event) => {
    if (!carriesFiles(event)) return;
    dragDepth += 1;
    root.classList.add('av-drag-over');
  });
  window.addEventListener('dragleave', (event) => {
    if (!carriesFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) root.classList.remove('av-drag-over');
  });
  window.addEventListener('dragover', (event) => {
    if (carriesFiles(event)) event.preventDefault();
  });
  window.addEventListener('drop', (event) => {
    dragDepth = 0;
    root.classList.remove('av-drag-over');
    // Drops inside the editor are imported by its own handler; a drop beside it must not open the file in the tab.
    if (carriesFiles(event) && !root.contains(event.target)) {
      event.preventDefault();
      if (event.dataTransfer.files.length) importMedia(event.dataTransfer.files);
    }
  });

  // Ctrl/Cmd+wheel (and trackpad pinch) zooms the timeline around the pointer, one render per frame.
  let zoomFrame = 0;
  let zoomTarget = 0;
  let zoomAnchor = null;
  elements.timelineScroll?.addEventListener(
    'wheel',
    (event) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const scroller = elements.timelineScroll;
      const x = event.clientX - scroller.getBoundingClientRect().left;
      if (!zoomFrame) {
        zoomTarget = state.pxPerSecond;
        zoomAnchor = {
          x,
          time: Math.max(0, (scroller.scrollLeft + x - HEADER_WIDTH) / state.pxPerSecond),
        };
      }
      zoomTarget = clamp(
        zoomTarget * Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0025)),
        4,
        480,
      );
      if (zoomFrame) return;
      zoomFrame = window.requestAnimationFrame(() => {
        zoomFrame = 0;
        setZoom(zoomTarget);
        scroller.scrollLeft = Math.max(
          0,
          zoomAnchor.time * state.pxPerSecond + HEADER_WIDTH - zoomAnchor.x,
        );
      });
    },
    { passive: false },
  );

  // Two-finger pinch on the timeline zooms it around the fingers (touch screens).
  let pinch = null;
  const touchDistance = (touches) =>
    Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
  elements.timelineScroll?.addEventListener(
    'touchstart',
    (event) => {
      if (event.touches.length !== 2) return;
      const scroller = elements.timelineScroll;
      const x =
        (event.touches[0].clientX + event.touches[1].clientX) / 2 -
        scroller.getBoundingClientRect().left;
      if (state.drag?.type === 'clip') endClipDrag(true);
      pinch = {
        distance: Math.max(1, touchDistance(event.touches)),
        zoom: state.pxPerSecond,
        x,
        time: Math.max(0, (scroller.scrollLeft + x - HEADER_WIDTH) / state.pxPerSecond),
      };
      event.preventDefault();
    },
    { passive: false },
  );
  elements.timelineScroll?.addEventListener(
    'touchmove',
    (event) => {
      if (!pinch || event.touches.length !== 2) return;
      event.preventDefault();
      const scroller = elements.timelineScroll;
      setZoom((pinch.zoom * touchDistance(event.touches)) / pinch.distance);
      scroller.scrollLeft = Math.max(0, pinch.time * state.pxPerSecond + HEADER_WIDTH - pinch.x);
    },
    { passive: false },
  );
  const endPinch = (event) => {
    if (pinch && event.touches.length < 2) {
      pinch = null;
      setStatus(`Timeline zoom ${Math.round(state.pxPerSecond)} px/s`);
    }
  };
  elements.timelineScroll?.addEventListener('touchend', endPinch);
  elements.timelineScroll?.addEventListener('touchcancel', endPinch);

  if (elements.projectName) elements.projectName.value = state.project.name;
  if (elements.fps) elements.fps.value = String(state.project.fps);
  if (elements.snap) elements.snap.checked = state.snap;
  if (elements.linked) elements.linked.checked = state.linkedSelection;
  if (elements.recoveryToggle) elements.recoveryToggle.checked = false;
  root.dataset.activeTool = state.tool;
  root.dataset.monitor = state.monitor;
  window.AlcorVideoEditor = Object.freeze({
    version: String(config.version || '0'),
    // Read-only views for tests and helper panels; edits go through the editor.
    project: () => JSON.parse(serializeProject()),
    selection: () => [...state.selection],
    focusedClip: () => state.selectedId,
    // Within the current selection only: the linked picture and sound of one clip.
    focusClip: (id) => {
      if (state.selection.has(id)) {
        state.selectedId = id;
        renderInspector();
      }
    },
    currentTime: () => state.currentTime,
    historyLabels: () => state.history.labels(),
    exportSupport: () => state.exportSupport,
    action: (name, options = {}) => action(String(name || ''), { dataset: { ...options } }),
    setTool: (name) => setTool(String(name || 'select')),
    selectPanel: (name) => selectPanelTab(String(name || 'media')),
    status: (message) => setStatus(String(message || '')),
  });
  renderAll();
})();

/* alcor-video-captions */
(() => {
  'use strict';

  const root = document.querySelector('[data-alcor-video-editor]');
  if (!root) return;

  const core = window.AlcorVideoCore;
  const config = window.AlcorVideoConfig || {};
  const captionInput = root.querySelector('#av-caption-input');
  const exportButton = root.querySelector('#av-caption-export');
  const installButton = root.querySelector('#av-install-app');
  const offlineState = root.querySelector('#av-offline-state');
  const status = root.querySelector('#av-status');
  const addTitleButton = root.querySelector('[data-action="add-title"]');
  const timeInput = root.querySelector('#av-time-input');
  const titleInspector = root.querySelector('#av-title-inspector');
  const standaloneQuery = window.matchMedia?.('(display-mode: standalone)') || null;
  let deferredInstall = null;

  function setStatus(message) {
    if (status) status.textContent = message;
  }

  function setField(name, value) {
    const field = titleInspector?.elements.namedItem(name);
    if (!field) return;
    field.value = String(value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function nextPaint() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  async function importCaptions(file) {
    if (!core) throw new Error('The AlcorVideo timeline core did not load.');
    if (!file) return;
    if (file.size > 1024 * 1024) throw new Error('Caption files are limited to 1 MB.');
    if (!addTitleButton || !timeInput || !titleInspector)
      throw new Error('Caption controls are unavailable in this editor build.');

    const cues = core.parseSrt(await file.text(), { maxCues: 300 });
    if (!cues.length) throw new Error('No valid subtitle cues were found.');

    setStatus(`Importing ${cues.length} caption cue${cues.length === 1 ? '' : 's'}…`);
    for (let index = 0; index < cues.length; index += 1) {
      const cue = cues[index];
      timeInput.value = String(cue.start);
      timeInput.dispatchEvent(new Event('change', { bubbles: true }));
      addTitleButton.click();
      setField('text', cue.text);
      setField('start', cue.start);
      setField('duration', cue.duration);
      setField('size', 48);
      setField('y', 88);
      setField('backgroundOpacity', 0.68);
      if ((index + 1) % 10 === 0) {
        setStatus(`Imported ${index + 1} of ${cues.length} caption cues…`);
        await nextPaint();
      }
    }
    timeInput.value = '0';
    timeInput.dispatchEvent(new Event('change', { bubbles: true }));
    setStatus(`${cues.length} editable caption title${cues.length === 1 ? '' : 's'} added to V2`);
  }

  function safeFileName(name) {
    const cleaned = String(name || 'alcorvideo-captions')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return cleaned || 'alcorvideo-captions';
  }

  function downloadText(text, fileName) {
    const blob = new Blob([text], { type: 'application/x-subrip;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function exportCaptions() {
    if (!core) throw new Error('The AlcorVideo timeline core did not load.');
    const detail = {};
    root.dispatchEvent(new CustomEvent('alcorvideo:request-project', { detail }));
    const project = detail.project;
    if (!project) throw new Error('The current project could not be read from the editor.');
    const cues = (Array.isArray(project.clips) ? project.clips : [])
      .filter((clip) => clip && clip.kind === 'title' && String(clip.text || '').trim())
      .map((clip) => ({
        start: Number(clip.start) || 0,
        end: (Number(clip.start) || 0) + (Number(clip.duration) || 0),
        text: String(clip.text || '').trim(),
      }));
    if (!cues.length) throw new Error('Add at least one title before exporting subtitles.');
    const srt = core.serializeSrt(cues);
    downloadText(`${srt}\n`, `${safeFileName(project.name)}.srt`);
    setStatus(`${cues.length} title${cues.length === 1 ? '' : 's'} exported as SRT`);
  }

  captionInput?.addEventListener('change', async () => {
    try {
      await importCaptions(captionInput.files?.[0]);
    } catch (error) {
      setStatus(`Caption import failed: ${error.message}`);
    } finally {
      captionInput.value = '';
    }
  });

  exportButton?.addEventListener('click', () => {
    try {
      exportCaptions();
    } catch (error) {
      setStatus(`Caption export failed: ${error.message}`);
    }
  });

  // The explicit local distribution uses its foreground launcher, never PWA controls.
  if (root.hasAttribute('data-alcor-local-distribution')) return;

  function isStandalone() {
    return standaloneQuery?.matches === true || window.navigator.standalone === true;
  }

  function installInstructions() {
    const userAgent = String(window.navigator.userAgent || '');
    const appleMobile =
      /iPhone|iPad|iPod/i.test(userAgent) ||
      (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);
    const safari =
      /Safari/i.test(userAgent) &&
      !/Chrome|Chromium|CriOS|Edg|EdgiOS|FxiOS|OPR|Android/i.test(userAgent);
    if (appleMobile)
      return 'Tap Share, choose Add to Home Screen, and keep Open as Web App enabled';
    if (safari) return 'In Safari, choose File > Add to Dock';
    return 'Use your browser menu to install AlcorVideo as an app';
  }

  function updateInstallControl() {
    if (!installButton) return;
    const installed = isStandalone();
    installButton.hidden = installed;
    installButton.disabled = installed;
    installButton.textContent = deferredInstall ? 'Install app' : 'How to install';
    installButton.dataset.installMode = deferredInstall ? 'prompt' : 'instructions';
  }

  function updateConnectivity() {
    if (offlineState) {
      if (isStandalone())
        offlineState.textContent = navigator.onLine ? 'Installed · online' : 'Installed · offline';
      else
        offlineState.textContent = navigator.onLine
          ? 'Online · media stays local'
          : 'Offline editor shell';
    }
    updateInstallControl();
  }

  window.addEventListener('online', updateConnectivity);
  window.addEventListener('offline', updateConnectivity);
  standaloneQuery?.addEventListener?.('change', updateConnectivity);
  updateConnectivity();

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstall = event;
    updateInstallControl();
  });

  installButton?.addEventListener('click', async () => {
    if (!deferredInstall) {
      setStatus(installInstructions());
      return;
    }

    const prompt = deferredInstall;
    deferredInstall = null;
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice.catch(() => ({ outcome: 'dismissed' }));
      if (choice.outcome === 'accepted') {
        setStatus('AlcorVideo installation accepted');
      } else {
        setStatus(`Installation dismissed · ${installInstructions()}`);
      }
    } catch (error) {
      setStatus(`Install prompt unavailable · ${installInstructions()}`);
    } finally {
      updateInstallControl();
    }
  });

  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
    setStatus('AlcorVideo installed for app-style launch');
    updateConnectivity();
  });

  if ('serviceWorker' in navigator && config.enhancementServiceWorkerUrl) {
    navigator.serviceWorker
      .register(config.enhancementServiceWorkerUrl, {
        scope: config.enhancementScope || '/video/',
      })
      .then(() => {
        root.dataset.offlineShell = 'registered';
      })
      .catch((error) => {
        root.dataset.offlineShell = 'unavailable';
        console.warn('AlcorVideo offline shell registration failed:', error);
      });
  }
})();

/* alcor-video-recovery */
(() => {
  'use strict';

  const root = document.querySelector('[data-alcor-video-editor]');
  const saveState = document.querySelector('#av-save-state');
  if (!root || !saveState || typeof MutationObserver !== 'function') return;

  const CLEAN_STATES = new Set(['New local project', 'Project file downloaded']);
  const initialState = String(saveState.textContent || '').trim();
  let dirty = false;

  function publishState() {
    root.dataset.unsavedChanges = dirty ? 'true' : 'false';
  }

  function readSaveState() {
    const value = String(saveState.textContent || '').trim();
    if (CLEAN_STATES.has(value)) {
      dirty = false;
    } else if (value && value !== initialState) {
      dirty = true;
    }
    publishState();
  }

  const observer = new MutationObserver(readSaveState);
  observer.observe(saveState, { childList: true, characterData: true, subtree: true });
  publishState();

  window.addEventListener('beforeunload', (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
})();

/* alcor-video-creator */
(() => {
  'use strict';

  const root = document.querySelector('[data-alcor-video-editor]');
  if (!root) return;

  const editor = () => window.AlcorVideoEditor || null;
  root.dataset.alcorVideoCreator = 'mobile-v1';

  const ICONS = Object.freeze({
    media:
      '<path d="M3 4h18v16H3z"/><circle cx="9" cy="10" r="2"/><path d="m3 18 5-5 4 4 3-3 6 6"/>',
    text: '<path d="M5 5V3h14v2M12 3v18M8 21h8"/>',
    split: '<path d="M5 3v18M19 3v18M8 8h8M8 16h8"/><path d="m10 6-2 2 2 2m4 4 2 2-2 2"/>',
    trim: '<path d="M7 3v18M17 3v18M10 8h4M10 16h4"/>',
    speed: '<circle cx="12" cy="12" r="8"/><path d="M12 12 16 8M8 17h8"/>',
    transform: '<path d="M4 9V4h5M20 15v5h-5M9 20H4v-5M15 4h5v5"/><path d="M8 8h8v8H8z"/>',
    transitions: '<path d="M3 5h8v14H3zM13 5h8v14h-8z"/><path d="m9 9 6 6m0-6-6 6"/>',
    adjust:
      '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
    audio: '<path d="M5 10h4l5-4v12l-5-4H5z"/><path d="M17 9c1 1 1 5 0 6M19 7c2 2 2 8 0 10"/>',
    captions:
      '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10h4M13 10h4M7 14h3M12 14h5"/>',
    format: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 17h8"/>',
    volume: '<path d="M4 10h4l5-4v12l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6"/>',
    filters:
      '<circle cx="9" cy="10" r="5"/><circle cx="15" cy="10" r="5"/><circle cx="12" cy="15" r="5"/>',
    crop: '<path d="M7 3v14h14M3 7h14v14"/>',
    export: '<path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 14v6h14v-6"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
  });

  function svg(name, size) {
    return (
      '<svg viewBox="0 0 24 24" width="' +
      (size || 24) +
      '" height="' +
      (size || 24) +
      '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (ICONS[name] || ICONS.adjust) +
      '</svg>'
    );
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  const creator = el('section', 'av-creator');
  creator.setAttribute('aria-label', 'Mobile creator tools');
  const rail = el('nav', 'av-creator-rail');
  rail.setAttribute('aria-label', 'Video creator tools');
  const sheet = el('section', 'av-creator-sheet');
  sheet.hidden = true;
  creator.append(rail, sheet);

  const workspace = root.querySelector('.av-workspace');
  const timeline = root.querySelector('.av-timeline-panel');
  if (timeline) timeline.before(creator);
  else if (workspace) workspace.after(creator);
  else root.querySelector('.av-app')?.append(creator);

  function project() {
    try {
      return editor()?.project?.() || null;
    } catch (_) {
      return null;
    }
  }

  // The clip the inspector shows. A clip with sound selects its linked audio too, so a tool that
  // needs the picture moves the editor's focus to the picture half before it acts.
  function selectedClip(kinds) {
    const api = editor();
    const p = project();
    if (!api || !p) return null;
    const clips = (api.selection?.() || [])
      .map((id) => (p.clips || []).find((clip) => clip.id === id))
      .filter(Boolean);
    const primary =
      clips.find((clip) => clip.id === api.focusedClip?.()) || clips[clips.length - 1] || null;
    if (primary && kinds && !kinds.includes(primary.kind)) {
      const other = clips.find((clip) => kinds.includes(clip.kind));
      if (other) {
        api.focusClip?.(other.id);
        return other;
      }
    }
    return primary;
  }

  function setStatus(message) {
    if (editor()?.status) editor().status(message);
    else {
      const node = root.querySelector('#av-status');
      if (node) node.textContent = message;
    }
  }

  function setField(form, name, value, checked) {
    const field = form?.elements?.namedItem?.(name);
    if (!field) return false;
    field.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    if (checked !== undefined && field.type === 'checkbox') field.checked = Boolean(checked);
    else field.value = String(value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    return true;
  }

  function click(selector) {
    const node = root.querySelector(selector);
    if (!node || node.disabled) return false;
    node.click();
    return true;
  }

  function closeSheet() {
    sheet.hidden = true;
    sheet.replaceChildren();
    delete creator.dataset.sheet;
    for (const button of rail.querySelectorAll('[aria-pressed]'))
      button.setAttribute('aria-pressed', 'false');
  }

  function head(title, note) {
    const header = el('div', 'av-creator-sheet-head');
    const copy = el('div');
    copy.append(el('strong', '', title));
    if (note) copy.append(el('span', '', note));
    const close = el('button', 'av-creator-close');
    close.type = 'button';
    close.innerHTML = svg('close', 20);
    close.setAttribute('aria-label', 'Close creator options');
    close.addEventListener('click', closeSheet);
    header.append(copy, close);
    sheet.append(header);
  }

  function note(text) {
    sheet.append(el('p', 'av-creator-note', text));
  }

  function chips() {
    const row = el('div', 'av-creator-chips');
    sheet.append(row);
    return row;
  }

  function chip(row, label, run, className) {
    const button = el('button', 'av-creator-chip ' + (className || ''), label);
    button.type = 'button';
    button.addEventListener('click', () => {
      try {
        const result = run();
        if (result && typeof result.catch === 'function')
          result.catch((error) => setStatus(error.message));
      } catch (error) {
        setStatus(error.message);
      }
    });
    row.append(button);
    return button;
  }

  function range(labelText, min, max, step, value, run) {
    const label = el('label', 'av-creator-range');
    const top = el('span');
    top.append(el('span', '', labelText));
    const out = el('output', '', String(value));
    top.append(out);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.addEventListener('input', () => {
      out.textContent = input.value;
      run(Number(input.value), false);
    });
    input.addEventListener('change', () => run(Number(input.value), true));
    label.append(top, input);
    sheet.append(label);
    return input;
  }

  function color(labelText, value, run) {
    const label = el('label', 'av-creator-color');
    label.append(el('span', '', labelText));
    const input = document.createElement('input');
    input.type = 'color';
    input.value = value || '#ffffff';
    input.addEventListener('input', () => run(input.value));
    label.append(input);
    sheet.append(label);
    return input;
  }

  function requireClip(kinds) {
    const clip = selectedClip(kinds);
    if (!clip) {
      note('Select a timeline clip first.');
      return null;
    }
    if (kinds && !kinds.includes(clip.kind)) {
      note('This tool needs a ' + kinds.join(' or ') + ' clip.');
      return null;
    }
    return clip;
  }

  function openText() {
    head('Text & titles', 'Editable title clips, all local.');
    const presets = chips();
    for (const item of [
      ['Title', 'title'],
      ['Lower third', 'lower-third'],
      ['Subtitle', 'subtitle'],
      ['End card', 'end-card'],
      ['Caption', 'caption'],
    ]) {
      chip(
        presets,
        item[0],
        () => {
          editor()?.action?.(item[1] === 'caption' ? 'add-title' : 'title-preset', {
            preset: item[1],
          });
          setTimeout(refreshSheet, 0);
        },
        'is-primary',
      );
    }

    const clip = selectedClip();
    if (!clip || clip.kind !== 'title') {
      note('Add or select a title to style fonts, color, outline and shadow.');
      return;
    }

    const form = root.querySelector('#av-title-inspector');
    const fonts = el('div', 'av-creator-fonts');
    const fontOptions = [
      ['Modern', 'sans'],
      ['Arial', 'arial'],
      ['Heavy', 'heavy'],
      ['Trebuchet', 'trebuchet'],
      ['Georgia', 'serif'],
      ['Times', 'times'],
      ['Palatino', 'palatino'],
      ['Mono', 'mono'],
      ['Courier', 'courier'],
      ['Impact', 'display'],
      ['Rounded', 'rounded'],
      ['Script', 'script'],
      ['Cursive', 'cursive'],
    ];
    for (const item of fontOptions) {
      const b = el('button', 'av-font-chip', item[0]);
      b.type = 'button';
      b.dataset.font = item[1];
      b.style.fontFamily = {
        sans: 'system-ui, sans-serif',
        arial: 'Arial, sans-serif',
        heavy: '"Arial Black", Impact, sans-serif',
        trebuchet: '"Trebuchet MS", sans-serif',
        serif: 'Georgia, serif',
        times: '"Times New Roman", serif',
        palatino: 'Palatino, Georgia, serif',
        mono: 'Consolas, monospace',
        courier: '"Courier New", monospace',
        display: 'Impact, sans-serif',
        rounded: '"Trebuchet MS", sans-serif',
        script: '"Brush Script MT", cursive',
        cursive: 'cursive',
      }[item[1]];
      if (clip.font === item[1]) b.classList.add('is-selected');
      b.addEventListener('click', () => {
        setField(form, 'font', item[1]);
        setTimeout(refreshSheet, 0);
      });
      fonts.append(b);
    }
    sheet.append(fonts);
    range('Size', 12, 200, 1, Number(clip.size || 64), (value) => setField(form, 'size', value));
    color('Text color', clip.color || '#ffffff', (value) => setField(form, 'color', value));
    range('Outline', 0, 20, 1, Number(clip.strokeWidth || 0), (value) =>
      setField(form, 'strokeWidth', value),
    );
    range('Backdrop', 0, 1, 0.05, Number(clip.backgroundOpacity || 0), (value) =>
      setField(form, 'backgroundOpacity', value),
    );
    const styles = chips();
    chip(styles, clip.bold ? 'Bold on' : 'Bold', () => {
      setField(form, 'bold', '', !clip.bold);
      setTimeout(refreshSheet, 0);
    });
    chip(styles, clip.italic ? 'Italic on' : 'Italic', () => {
      setField(form, 'italic', '', !clip.italic);
      setTimeout(refreshSheet, 0);
    });
    chip(styles, clip.shadow ? 'Shadow on' : 'Shadow', () => {
      setField(form, 'shadow', '', !clip.shadow);
      setTimeout(refreshSheet, 0);
    });
  }

  function openTrim() {
    head('Trim & cut', 'Playhead-aware editing without tiny timeline targets.');
    const clip = requireClip();
    if (!clip) return;
    note(
      'Playhead: ' +
        Number(editor()?.currentTime?.() || 0).toFixed(2) +
        's · ' +
        (clip.name || clip.kind),
    );
    const row = chips();
    chip(row, 'Split here', () => editor()?.action?.('split'), 'is-primary');
    chip(row, 'Trim start here', () => editor()?.action?.('ripple-trim-start'));
    chip(row, 'Trim end here', () => editor()?.action?.('ripple-trim-end'));
    chip(row, 'Ripple delete', () => editor()?.action?.('ripple-delete'));
    note('Start/end trim is ripple trim: later synced clips shift to close or create space.');
  }

  function openSpeed() {
    head('Speed', 'Clip speed and reverse.');
    const clip = requireClip(['video', 'audio']);
    if (!clip) return;
    const form = root.querySelector('#av-clip-inspector');
    const row = chips();
    for (const speed of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4, 8]) {
      chip(
        row,
        speed * 100 + '%',
        () => {
          setField(form, 'speed', speed);
          setTimeout(refreshSheet, 0);
        },
        Number(clip.speed || 1) === speed ? 'is-selected' : '',
      );
    }
    const reverse = chips();
    chip(reverse, clip.reverse ? 'Reverse on' : 'Reverse', () => {
      setField(form, 'reverse', '', !clip.reverse);
      setTimeout(refreshSheet, 0);
    });
    chip(reverse, 'Frame hold', () => editor()?.action?.('frame-hold'));
  }

  function openTransform() {
    head('Transform', 'Position, scale, rotation and frame fit.');
    const clip = requireClip(['video', 'image']);
    if (!clip) return;
    const form = root.querySelector('#av-clip-inspector');
    if (!form?.elements?.namedItem?.('scale')) {
      note('Transform controls are unavailable in this build.');
      return;
    }
    const row = chips();
    chip(row, 'Fit', () => click('[data-av-transform-preset="fit"]'));
    chip(row, 'Fill', () => click('[data-av-transform-preset="fill"]'));
    chip(row, 'Reset', () => click('[data-av-transform-preset="reset"]'));
    const scale = Number(form.elements.namedItem('scale').value || 100);
    const rotation = Number(form.elements.namedItem('rotation').value || 0);
    const x = Number(form.elements.namedItem('positionX').value || 50);
    const y = Number(form.elements.namedItem('positionY').value || 50);
    range('Scale %', 10, 400, 1, scale, (value) => setField(form, 'scale', value));
    range('Rotation', -180, 180, 1, rotation, (value) => setField(form, 'rotation', value));
    range('Horizontal %', -50, 150, 1, x, (value) => setField(form, 'positionX', value));
    range('Vertical %', -50, 150, 1, y, (value) => setField(form, 'positionY', value));
  }

  function openTransitions() {
    head('Transitions', 'Apply at the selected incoming clip or playhead cut.');
    const visual = chips();
    const transitions = [
      ['Dissolve', 'cross-dissolve'],
      ['Dip black', 'dip-to-black'],
      ['Dip white', 'dip-to-white'],
      ['Wipe left', 'wipe-left'],
      ['Wipe right', 'wipe-right'],
      ['Wipe up', 'wipe-up'],
      ['Wipe down', 'wipe-down'],
    ];
    for (const item of transitions) {
      chip(
        visual,
        item[0],
        () => editor()?.action?.('apply-transition', { transition: item[1], kind: 'video' }),
        item[1] === 'cross-dissolve' ? 'is-primary' : '',
      );
    }
    const audio = chips();
    chip(audio, 'Audio power', () =>
      editor()?.action?.('apply-transition', { transition: 'constant-power', kind: 'audio' }),
    );
    chip(audio, 'Audio gain', () =>
      editor()?.action?.('apply-transition', { transition: 'constant-gain', kind: 'audio' }),
    );
  }

  const LOOKS = Object.freeze({
    neutral: {
      exposure: 0,
      temperature: 0,
      tint: 0,
      brightness: 0,
      contrast: 0,
      highlights: 0,
      shadows: 0,
      whites: 0,
      blacks: 0,
      saturation: 100,
    },
    punchy: {
      exposure: 0,
      temperature: 0,
      tint: 0,
      brightness: 0,
      contrast: 18,
      highlights: -10,
      shadows: 8,
      whites: 8,
      blacks: -8,
      saturation: 118,
    },
    warm: {
      exposure: 0,
      temperature: 20,
      tint: 4,
      brightness: 2,
      contrast: 8,
      highlights: -6,
      shadows: 6,
      whites: 4,
      blacks: -4,
      saturation: 108,
    },
    cool: {
      exposure: 0,
      temperature: -20,
      tint: -4,
      brightness: 0,
      contrast: 8,
      highlights: -4,
      shadows: 4,
      whites: 2,
      blacks: -5,
      saturation: 105,
    },
    bw: {
      exposure: 0,
      temperature: 0,
      tint: 0,
      brightness: 0,
      contrast: 14,
      highlights: -8,
      shadows: 6,
      whites: 5,
      blacks: -8,
      saturation: 0,
    },
    fade: {
      exposure: 0.1,
      temperature: 4,
      tint: 2,
      brightness: 4,
      contrast: -12,
      highlights: -12,
      shadows: 18,
      whites: -5,
      blacks: 16,
      saturation: 88,
    },
  });

  function applyLook(values) {
    const form = root.querySelector('#av-clip-inspector');
    for (const entry of Object.entries(values)) setField(form, entry[0], entry[1]);
  }

  function openAdjust() {
    head('Adjust & looks', 'Local color controls applied to the selected visual clip.');
    const clip = requireClip(['video', 'image']);
    if (!clip) return;
    const form = root.querySelector('#av-clip-inspector');
    const row = chips();
    chip(row, 'Neutral', () => {
      applyLook(LOOKS.neutral);
      setTimeout(refreshSheet, 0);
    });
    chip(row, 'Punchy', () => applyLook(LOOKS.punchy));
    chip(row, 'Warm', () => applyLook(LOOKS.warm));
    chip(row, 'Cool', () => applyLook(LOOKS.cool));
    chip(row, 'B&W', () => applyLook(LOOKS.bw));
    chip(row, 'Fade', () => applyLook(LOOKS.fade));
    const value = (name, fallback) => Number(form?.elements?.namedItem?.(name)?.value ?? fallback);
    range('Exposure', -5, 5, 0.1, value('exposure', 0), (v) => setField(form, 'exposure', v));
    range('Temperature', -100, 100, 1, value('temperature', 0), (v) =>
      setField(form, 'temperature', v),
    );
    range('Contrast', -100, 100, 1, value('contrast', 0), (v) => setField(form, 'contrast', v));
    range('Saturation %', 0, 200, 1, value('saturation', 100), (v) =>
      setField(form, 'saturation', v),
    );
  }

  function openAudio() {
    head('Audio', 'Clip level, gain, pan, mute and fades.');
    const clip = requireClip();
    if (!clip) return;
    const form = root.querySelector('#av-clip-inspector');
    const row = chips();
    chip(row, '25%', () => setField(form, 'volume', 0.25));
    chip(row, '50%', () => setField(form, 'volume', 0.5));
    chip(row, '100%', () => setField(form, 'volume', 1), 'is-primary');
    chip(row, '-6 dB', () => setField(form, 'gain', -6));
    chip(row, '0 dB', () => setField(form, 'gain', 0));
    chip(row, '+3 dB', () => setField(form, 'gain', 3));
    chip(row, 'Center pan', () => setField(form, 'pan', 0));
    chip(row, clip.muted ? 'Unmute' : 'Mute', () => {
      setField(form, 'muted', '', !clip.muted);
      setTimeout(refreshSheet, 0);
    });
    const fades = chips();
    chip(fades, 'No fades', () => click('[data-av-fade-preset="0"]'));
    chip(fades, '0.5s fades', () => click('[data-av-fade-preset="0.5"]'));
    chip(fades, '1s fades', () => click('[data-av-fade-preset="1"]'));
  }

  function openCaptions() {
    head('Captions', 'Editable title captions and SRT import/export.');
    const row = chips();
    chip(
      row,
      'Add caption',
      () => {
        editor()?.action?.('add-title', { preset: 'caption' });
        setTimeout(() => showSheet('text', null), 0);
      },
      'is-primary',
    );
    chip(row, 'Import SRT', () => root.querySelector('#av-caption-input')?.click());
    chip(row, 'Export SRT', () => root.querySelector('#av-caption-export')?.click());
    note('Imported SRT cues become normal editable title clips on V2.');
  }

  function openFormat() {
    head('Format', 'Sequence aspect ratio and delivery shape.');
    const select = root.querySelector('#av-sequence-preset');
    const row = chips();
    for (const item of [
      ['16:9', '1920x1080'],
      ['9:16', '1080x1920'],
      ['1:1', '1080x1080'],
      ['4:5', '1080x1350'],
      ['4K', '3840x2160'],
    ]) {
      chip(
        row,
        item[0],
        () => {
          if (!select) return;
          select.value = item[1];
          select.dispatchEvent(new Event('change', { bubbles: true }));
          setTimeout(refreshSheet, 0);
        },
        select?.value === item[1] ? 'is-selected' : '',
      );
    }
    note('Format changes the sequence canvas; export presets stay selectable in Export.');
  }

  // ------------------------------------------------------------ Basic mode sheets

  const effects = (detail) =>
    root.dispatchEvent(new CustomEvent('alcorvideo:effects-command', { detail }));
  const grade = (patch, label) =>
    root.dispatchEvent(new CustomEvent('alcorvideo:grade-patch', { detail: { patch, label } }));

  function openVolume() {
    head('Volume', 'Clip level, mute, fades and one-tap audio cleanup.');
    const clip = requireClip(['video', 'audio']);
    if (!clip) return;
    const form = root.querySelector('#av-clip-inspector');
    const level = Math.round(Number(form?.elements?.namedItem?.('volume')?.value ?? 1) * 100);
    range('Volume %', 0, 100, 1, level, (value, commit) => {
      if (commit) setField(form, 'volume', value / 100);
    });
    const row = chips();
    chip(
      row,
      clip.muted ? 'Unmute' : 'Mute',
      () => {
        setField(form, 'muted', '', !clip.muted);
        setTimeout(refreshSheet, 0);
      },
      clip.muted ? 'is-selected' : '',
    );
    chip(row, '-6 dB', () => setField(form, 'gain', -6));
    chip(row, '0 dB', () => setField(form, 'gain', 0));
    chip(row, '+6 dB', () => setField(form, 'gain', 6));
    const fades = chips();
    chip(fades, 'No fades', () => click('[data-av-fade-preset="0"]'));
    chip(fades, '0.5s fades', () => click('[data-av-fade-preset="0.5"]'));
    chip(fades, '1s fades', () => click('[data-av-fade-preset="1"]'));
    const cleanup = chips();
    chip(
      cleanup,
      'Clean up voice',
      () => {
        effects({ action: 'audio', section: 'highpass', params: { freq: 90 } });
        effects({
          action: 'audio',
          section: 'compressor',
          params: { threshold: -20, ratio: 3, attack: 5, release: 150, knee: 6, makeup: 4 },
        });
        setStatus('Voice cleanup: high-pass and compressor applied');
      },
      'is-primary',
    );
    chip(cleanup, 'Reduce noise', () => {
      effects({ action: 'audio', section: 'gate', params: { threshold: -45 } });
      setStatus('Noise gate applied');
    });
    chip(cleanup, 'Keep pitch', () => {
      effects({ action: 'audio', section: 'pitch', value: true });
      setStatus('Pitch is kept when the speed changes');
    });
    chip(cleanup, 'Reset audio effects', () => {
      for (const section of ['highpass', 'lowpass', 'eq', 'gate', 'compressor'])
        effects({ action: 'audio', section, enabled: false });
      effects({ action: 'audio', section: 'pitch', value: false });
    });
  }

  // One-tap looks built on the existing grade (Basic Color plus Lumetri wheels).
  const BASIC_LOOKS = Object.freeze([
    ['Original', LOOKS.neutral, null],
    [
      'Vivid',
      { ...LOOKS.neutral, contrast: 14, saturation: 135, highlights: -8, shadows: 6 },
      null,
    ],
    ['Warm', LOOKS.warm, null],
    ['Cool', LOOKS.cool, null],
    [
      'Cinematic',
      { ...LOOKS.neutral, contrast: 12, saturation: 92, highlights: -10, blacks: -6 },
      { lift: { x: -0.35, y: -0.45, l: 0 }, gain: { x: 0.4, y: 0.3, l: 0.04 } },
    ],
    ['Vintage', LOOKS.fade, { lift: { x: 0.2, y: 0.25, l: 0.12 } }],
    ['B&W', LOOKS.bw, null],
    ['Punchy', LOOKS.punchy, null],
  ]);

  function openFilters() {
    head('Filters', 'One tap applies a look to the selected clip. Fine-tune in Advanced.');
    const clip = requireClip(['video', 'image']);
    if (!clip) return;
    const row = chips();
    for (const [label, look, wheels] of BASIC_LOOKS) {
      chip(
        row,
        label,
        () => {
          // One undo step for the color, one for the wheels.
          root.dispatchEvent(
            new CustomEvent('alcorvideo:color-patch', {
              detail: { patch: look, label: `${label} look` },
            }),
          );
          grade({ wheels: wheels || null }, `${label} look`);
          setStatus(`${label} look applied`);
        },
        label === 'Original' ? '' : 'is-primary',
      );
    }
    note('Looks only change color settings, so preview and export match exactly.');
  }

  function cropEffect(clip) {
    return (clip.effects || []).find((effect) => effect.type === 'crop') || null;
  }

  function openCrop() {
    head('Crop & aspect', 'Frame shape, fit or fill, and crop edges.');
    const select = root.querySelector('#av-sequence-preset');
    const shapes = chips();
    for (const [label, value] of [
      ['9:16', '1080x1920'],
      ['1:1', '1080x1080'],
      ['16:9', '1920x1080'],
      ['4:5', '1080x1350'],
    ]) {
      chip(
        shapes,
        label,
        () => {
          if (!select) return;
          select.value = value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          setTimeout(refreshSheet, 0);
        },
        select?.value === value ? 'is-selected' : '',
      );
    }
    const clip = selectedClip(['video', 'image']);
    if (!clip || (clip.kind !== 'video' && clip.kind !== 'image')) {
      note('Select a video or image clip to fit, fill or crop it.');
      return;
    }
    const framing = chips();
    chip(framing, 'Fit', () => click('[data-av-transform-preset="fit"]'));
    chip(framing, 'Fill', () => click('[data-av-transform-preset="fill"]'), 'is-primary');
    const crop = cropEffect(clip);
    for (const [label, name] of [
      ['Crop left %', 'left'],
      ['Crop right %', 'right'],
      ['Crop top %', 'top'],
      ['Crop bottom %', 'bottom'],
    ]) {
      range(label, 0, 50, 1, crop ? Number(crop.params[name]) || 0 : 0, (value, commit) => {
        const current = cropEffect(selectedClip() || clip);
        if (!current) {
          if (commit) {
            effects({ action: 'add', type: 'crop', params: { [name]: value } });
            setTimeout(refreshSheet, 0);
          }
          return;
        }
        effects({ action: 'param', effectId: current.id, name, value, live: !commit });
      });
    }
  }

  function openExportSimple() {
    head('Export', 'Saved to this device. Nothing is uploaded.');
    const form = root.querySelector('#av-export-form');
    const set = (name, value) => {
      const field = form?.elements?.namedItem?.(name);
      if (field) field.value = value;
    };
    let format = 'auto';
    let quality = 'high';
    const formatsRow = chips();
    const formatButtons = [];
    for (const [label, value] of [
      ['Video', 'auto'],
      ['WebM', 'webm-fast'],
      ['GIF', 'gif'],
      ['Still image', 'png'],
      ['Audio', 'wav'],
    ]) {
      formatButtons.push(
        chip(
          formatsRow,
          label,
          () => {
            format = value;
            formatButtons.forEach((b) =>
              b.classList.toggle('is-selected', b.textContent === label),
            );
          },
          value === 'auto' ? 'is-selected' : '',
        ),
      );
    }
    const qualityRow = chips();
    const qualityButtons = [];
    for (const [label, value] of [
      ['High quality', 'high'],
      ['Smaller file', 'low'],
    ]) {
      qualityButtons.push(
        chip(
          qualityRow,
          label,
          () => {
            quality = value;
            qualityButtons.forEach((b) =>
              b.classList.toggle('is-selected', b.textContent === label),
            );
          },
          value === 'high' ? 'is-selected' : '',
        ),
      );
    }
    const go = chips();
    chip(
      go,
      'Export now',
      () => {
        set('preset', 'match');
        set('range', 'all');
        set('quality', quality);
        set('format', format);
        closeSheet();
        return editor()?.action?.('render');
      },
      'is-primary',
    );
    chip(go, 'More options', () => {
      closeSheet();
      editor()?.action?.('export');
    });
    note('Video picks the best format this browser can encode. GIF is limited to 15 seconds.');
  }

  const sheets = {
    volume: openVolume,
    filters: openFilters,
    crop: openCrop,
    'export-simple': openExportSimple,
    text: openText,
    trim: openTrim,
    speed: openSpeed,
    transform: openTransform,
    transitions: openTransitions,
    adjust: openAdjust,
    audio: openAudio,
    captions: openCaptions,
    format: openFormat,
  };

  function showSheet(name, button) {
    sheet.replaceChildren();
    sheet.hidden = false;
    creator.dataset.sheet = name;
    for (const item of rail.querySelectorAll('[aria-pressed]'))
      item.setAttribute('aria-pressed', String(item === button));
    sheets[name]?.();
  }

  // modes: '' (both), 'basic' or 'advanced'; order: position in the Basic toolbar.
  function railButton(label, iconName, behavior, sheetName, modes, order) {
    const button = el('button', 'av-creator-button');
    button.type = 'button';
    button.innerHTML = svg(iconName, 25) + '<span>' + label + '</span>';
    if (modes) button.dataset.modes = modes;
    if (order) button.style.setProperty('--basic-order', String(order));
    if (sheetName) button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => {
      try {
        const sheetFor = typeof sheetName === 'function' ? sheetName() : sheetName;
        if (sheetFor && !sheet.hidden && creator.dataset.sheet === sheetFor) {
          closeSheet();
          return;
        }
        if (sheetFor) showSheet(sheetFor, button);
        else behavior?.();
      } catch (error) {
        setStatus(error.message);
      }
    });
    rail.append(button);
    return button;
  }

  // Basic toolbar order: Add, Split, Speed, Volume, Text, Filters, Transitions, Crop/Aspect, Export.
  railButton(
    'Add Media',
    'media',
    () => root.querySelector('#av-media-input')?.click(),
    null,
    '',
    1,
  );
  railButton('Text', 'text', null, 'text', '', 5);
  railButton('Split', 'split', () => editor()?.action?.('split'), null, '', 2);
  railButton('Trim', 'trim', null, 'trim', 'advanced');
  railButton('Speed', 'speed', null, 'speed', '', 3);
  railButton('Volume', 'volume', null, 'volume', 'basic', 4);
  railButton('Transform', 'transform', null, 'transform', 'advanced');
  railButton('Filters', 'filters', null, 'filters', 'basic', 6);
  railButton('Transitions', 'transitions', null, 'transitions', '', 7);
  railButton('Crop/Aspect', 'crop', null, 'crop', 'basic', 8);
  railButton('Adjust', 'adjust', null, 'adjust', 'advanced');
  railButton('Audio', 'audio', null, 'audio', 'advanced');
  railButton('Captions', 'captions', null, 'captions', 'advanced');
  railButton('Format', 'format', null, 'format', 'advanced');
  const exportButton = railButton(
    'Export',
    'export',
    () => editor()?.action?.('export'),
    () => (mode() === 'basic' ? 'export-simple' : null),
    '',
    9,
  );
  exportButton.removeAttribute('aria-pressed');

  // ------------------------------------------------------------ Basic / Advanced
  // Basic: monitor, a simple timeline and the big toolbar (the default on phones).
  // Advanced: the Premiere-style panels. Not stored: nothing is read from storage at startup.
  function mode() {
    return root.dataset.uiMode === 'basic' ? 'basic' : 'advanced';
  }
  const switcher = el('div', 'av-mode-switch');
  switcher.setAttribute('role', 'group');
  switcher.setAttribute('aria-label', 'Editing mode');
  const modeButtons = ['basic', 'advanced'].map((name) => {
    const button = el('button', '', name === 'basic' ? 'Basic' : 'Advanced');
    button.type = 'button';
    button.dataset.uiModeSet = name;
    button.addEventListener('click', () => setMode(name));
    switcher.append(button);
    return button;
  });
  function setMode(name) {
    root.dataset.uiMode = name === 'basic' ? 'basic' : 'advanced';
    for (const button of modeButtons)
      button.setAttribute('aria-pressed', String(button.dataset.uiModeSet === root.dataset.uiMode));
    closeSheet();
    root.dispatchEvent(
      new CustomEvent('alcorvideo:ui-mode', { detail: { mode: root.dataset.uiMode } }),
    );
  }
  root.querySelector('.av-app-actions')?.prepend(switcher);
  setMode(window.matchMedia?.('(max-width: 760px)').matches ? 'basic' : 'advanced');

  // Basic mode puts newly imported media straight onto the timeline, one after another.
  root.addEventListener('alcorvideo:media-imported', (event) => {
    if (mode() !== 'basic' || event.detail?.placed) return;
    for (const id of event.detail?.assetIds || [])
      editor()?.action?.('append-asset', { asset: id });
  });

  function refreshSheet() {
    const name = creator.dataset.sheet;
    if (!name || sheet.hidden) return;
    sheet.replaceChildren();
    sheets[name]?.();
  }

  root.addEventListener(
    'pointerdown',
    (event) => {
      if (!event.target.closest?.('.av-timeline-clip')) return;
      if (!sheet.hidden) setTimeout(refreshSheet, 0);
    },
    true,
  );

  window.AlcorVideoCreator = Object.freeze({
    setMode,
    mode,
    close: closeSheet,
    open: (name) => {
      const button = Array.from(rail.children).find((item) => item.textContent.trim() === name);
      if (button) button.click();
    },
    selectedClip,
  });
})();
