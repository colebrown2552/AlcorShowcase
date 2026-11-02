/* alcor-video-waveform-core */
(() => {
  'use strict';

  const LIMITS = Object.freeze({
    maxFileBytes: 64 * 1024 * 1024,
    maxAssetSeconds: 600,
    maxChannels: 8,
    maxEnvelopeBuckets: 1024,
    maxRenderBuckets: 512,
    maxSamplesPerBucket: 512,
    maxCachedAssets: 24,
  });

  function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, finite(value, min)));
  }

  function boundedInt(value, min, max) {
    return Math.round(clamp(value, min, max));
  }

  function buildPeakEnvelope(audioBuffer, options = {}) {
    if (!audioBuffer || typeof audioBuffer.getChannelData !== 'function') {
      throw new Error('A decoded AudioBuffer is required.');
    }
    const frameCount = boundedInt(audioBuffer.length, 0, Number.MAX_SAFE_INTEGER);
    const channelCount = boundedInt(audioBuffer.numberOfChannels, 0, LIMITS.maxChannels);
    const duration = Math.max(0, finite(audioBuffer.duration));
    if (!frameCount || !channelCount || !duration) {
      throw new Error('Decoded audio has no analyzable samples.');
    }

    const requested = boundedInt(
      options.bucketCount || LIMITS.maxEnvelopeBuckets,
      16,
      LIMITS.maxEnvelopeBuckets,
    );
    const bucketCount = Math.min(requested, frameCount);
    const peaks = new Float32Array(bucketCount);
    const channels = [];
    for (let channel = 0; channel < channelCount; channel += 1) {
      const samples = audioBuffer.getChannelData(channel);
      if (samples && samples.length) channels.push(samples);
    }
    if (!channels.length) throw new Error('Decoded audio channels are unavailable.');

    for (let bucket = 0; bucket < bucketCount; bucket += 1) {
      const start = Math.floor((bucket * frameCount) / bucketCount);
      const end = Math.max(start + 1, Math.floor(((bucket + 1) * frameCount) / bucketCount));
      const stride = Math.max(1, Math.ceil((end - start) / LIMITS.maxSamplesPerBucket));
      let peak = 0;
      for (const samples of channels) {
        const channelEnd = Math.min(end, samples.length);
        for (let index = start; index < channelEnd; index += stride) {
          const sample = Math.abs(finite(samples[index]));
          if (sample > peak) peak = sample;
        }
      }
      peaks[bucket] = clamp(peak, 0, 1);
    }

    return Object.freeze({
      duration,
      sampleRate: Math.max(1, finite(audioBuffer.sampleRate, 1)),
      channelCount: channels.length,
      frameCount,
      peaks,
    });
  }

  function windowPeaks(envelope, clip, requestedBuckets = LIMITS.maxRenderBuckets) {
    if (!envelope || !envelope.peaks || !envelope.peaks.length || !envelope.duration)
      return new Float32Array(0);
    const peaks = envelope.peaks;
    const assetDuration = Math.max(0.001, finite(envelope.duration));
    const inPoint = clamp(clip?.in, 0, assetDuration);
    const timelineDuration = Math.max(0, finite(clip?.duration));
    const speed = clamp(clip?.speed || 1, 0.01, 16);
    const sourceDuration = Math.max(0, Math.min(assetDuration - inPoint, timelineDuration * speed));
    if (!sourceDuration) return new Float32Array(0);

    const outputCount = boundedInt(requestedBuckets, 8, LIMITS.maxRenderBuckets);
    const output = new Float32Array(outputCount);
    const sourceStartRatio = inPoint / assetDuration;
    const sourceEndRatio = (inPoint + sourceDuration) / assetDuration;

    for (let bucket = 0; bucket < outputCount; bucket += 1) {
      const rangeStart =
        sourceStartRatio + (sourceEndRatio - sourceStartRatio) * (bucket / outputCount);
      const rangeEnd =
        sourceStartRatio + (sourceEndRatio - sourceStartRatio) * ((bucket + 1) / outputCount);
      const startIndex = Math.max(
        0,
        Math.min(peaks.length - 1, Math.floor(rangeStart * peaks.length)),
      );
      const endIndex = Math.max(
        startIndex + 1,
        Math.min(peaks.length, Math.ceil(rangeEnd * peaks.length)),
      );
      let peak = 0;
      for (let index = startIndex; index < endIndex; index += 1)
        peak = Math.max(peak, finite(peaks[index]));
      output[bucket] = clamp(peak, 0, 1);
    }
    return output;
  }

  function describeClipWindow(envelope, clip) {
    const assetDuration = Math.max(0, finite(envelope?.duration));
    const sourceStart = clamp(clip?.in, 0, assetDuration);
    const speed = clamp(clip?.speed || 1, 0.01, 16);
    const sourceDuration = Math.max(
      0,
      Math.min(assetDuration - sourceStart, Math.max(0, finite(clip?.duration)) * speed),
    );
    return Object.freeze({
      sourceStart,
      sourceDuration,
      sourceEnd: sourceStart + sourceDuration,
      speed,
    });
  }

  window.AlcorVideoWaveformCore = Object.freeze({
    LIMITS,
    buildPeakEnvelope,
    windowPeaks,
    describeClipWindow,
  });
})();

/* alcor-video-waveform */
(() => {
  'use strict';

  const root = document.querySelector('[data-alcor-video-editor]');
  const core = window.AlcorVideoWaveformCore;
  if (!root || !core) return;

  const VERSION = '0.1.0';
  const LIMITS = core.LIMITS;
  const fileRegistry = new Map();
  const analysisCache = new Map();
  let analysisQueue = Promise.resolve();
  let renderQueued = false;

  function signatureFromFile(file) {
    return `${String(file?.name || '')}\u0000${Number(file?.size) || 0}\u0000${String(file?.type || '')}`;
  }

  function signatureFromAsset(asset) {
    return `${String(asset?.name || '')}\u0000${Number(asset?.size) || 0}\u0000${String(asset?.type || '')}`;
  }

  function rememberFiles(files) {
    for (const file of Array.from(files || [])) {
      if (!(file instanceof File)) continue;
      const key = signatureFromFile(file);
      if (!key) continue;
      fileRegistry.set(key, file);
    }
  }

  function clearLocalWaveforms() {
    fileRegistry.clear();
    analysisCache.clear();
    analysisQueue = Promise.resolve();
    scheduleRender();
  }

  function projectSnapshot() {
    const detail = {};
    root.dispatchEvent(new CustomEvent('alcorvideo:request-project', { detail }));
    return detail.project && typeof detail.project === 'object' ? detail.project : null;
  }

  function findLocalFile(asset) {
    return fileRegistry.get(signatureFromAsset(asset)) || null;
  }

  async function decodeAudio(file) {
    const data = await file.arrayBuffer();
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (Offline) {
      const context = new Offline(1, 1, 44100);
      return await new Promise((resolve, reject) => {
        let settled = false;
        const done = (value) => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        };
        const fail = (error) => {
          if (!settled) {
            settled = true;
            reject(error instanceof Error ? error : new Error('Audio decode failed.'));
          }
        };
        try {
          const pending = context.decodeAudioData(data, done, fail);
          if (pending && typeof pending.then === 'function') pending.then(done, fail);
        } catch (error) {
          fail(error);
        }
      });
    }

    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) throw new Error('This browser does not expose local audio decoding.');
    const context = new Audio();
    try {
      return await new Promise((resolve, reject) => {
        let settled = false;
        const done = (value) => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        };
        const fail = (error) => {
          if (!settled) {
            settled = true;
            reject(error instanceof Error ? error : new Error('Audio decode failed.'));
          }
        };
        try {
          const pending = context.decodeAudioData(data, done, fail);
          if (pending && typeof pending.then === 'function') pending.then(done, fail);
        } catch (error) {
          fail(error);
        }
      });
    } finally {
      try {
        await context.close();
      } catch (_) {}
    }
  }

  async function analyzeAsset(asset, file) {
    if (!file)
      return { status: 'unavailable', reason: 'Relink the local audio file to draw its waveform.' };
    if (file.size > LIMITS.maxFileBytes) {
      return {
        status: 'unavailable',
        reason: `Waveform preview is bounded to local files up to ${Math.round(LIMITS.maxFileBytes / 1024 / 1024)} MB.`,
      };
    }
    if ((Number(asset?.duration) || 0) > LIMITS.maxAssetSeconds) {
      return {
        status: 'unavailable',
        reason: `Waveform preview is bounded to audio up to ${Math.round(LIMITS.maxAssetSeconds / 60)} minutes.`,
      };
    }
    try {
      const buffer = await decodeAudio(file);
      if ((Number(buffer.duration) || 0) > LIMITS.maxAssetSeconds) {
        return {
          status: 'unavailable',
          reason: `Decoded audio exceeds the ${Math.round(LIMITS.maxAssetSeconds / 60)} minute waveform guard.`,
        };
      }
      const envelope = core.buildPeakEnvelope(buffer, { bucketCount: LIMITS.maxEnvelopeBuckets });
      return { status: 'ready', envelope };
    } catch (error) {
      return {
        status: 'unavailable',
        reason: `Waveform unavailable: ${String(error?.message || 'the browser could not decode this audio')}`,
      };
    }
  }

  function analysisFor(asset) {
    const key = signatureFromAsset(asset);
    const cached = analysisCache.get(key);
    if (cached) return cached;
    if (analysisCache.size >= LIMITS.maxCachedAssets) {
      return {
        status: 'unavailable',
        reason: `Waveform preview is limited to ${LIMITS.maxCachedAssets} local audio assets per open project.`,
      };
    }

    const holder = { status: 'loading', reason: 'Analyzing local audio…', promise: null };
    const file = findLocalFile(asset);
    holder.promise = analysisQueue
      .then(() => analyzeAsset(asset, file))
      .catch((error) => ({
        status: 'unavailable',
        reason: `Waveform unavailable: ${String(error?.message || error)}`,
      }))
      .then((result) => {
        analysisCache.set(key, result);
        scheduleRender();
        return result;
      });
    analysisQueue = holder.promise.then(
      () => undefined,
      () => undefined,
    );
    analysisCache.set(key, holder);
    return holder;
  }

  function statusNode(item) {
    let status = item.querySelector('.av-waveform-status');
    if (!status) {
      status = document.createElement('span');
      status.className = 'av-waveform-status';
      status.setAttribute('aria-hidden', 'true');
      item.querySelector('.av-clip-body')?.append(status);
    }
    return status;
  }

  function setItemState(item, state, reason = '') {
    item.dataset.waveformState = state;
    item.dataset.waveformReason = reason;
    const baseLabel =
      item.dataset.waveformBaseLabel || item.getAttribute('aria-label') || 'Audio clip';
    item.dataset.waveformBaseLabel = baseLabel;
    const spoken =
      state === 'ready'
        ? 'waveform ready'
        : state === 'loading'
          ? 'waveform analyzing'
          : 'waveform unavailable';
    item.setAttribute('aria-label', `${baseLabel}, ${spoken}`);
    const status = statusNode(item);
    if (state === 'ready') {
      status.remove();
      item.classList.add('has-waveform');
      item.classList.remove('is-waveform-unavailable', 'is-waveform-loading');
    } else {
      status.textContent = state === 'loading' ? 'Analyzing…' : 'Waveform unavailable';
      status.title = reason;
      item.classList.toggle('is-waveform-loading', state === 'loading');
      item.classList.toggle('is-waveform-unavailable', state === 'unavailable');
      item.classList.remove('has-waveform');
    }
  }

  function drawWaveform(item, envelope, clip) {
    const body = item.querySelector('.av-clip-body');
    if (!body) return;
    let canvas = body.querySelector('.av-waveform-canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'av-waveform-canvas';
      canvas.setAttribute('aria-hidden', 'true');
      body.prepend(canvas);
    }

    // The editor sets each clip's width inline; reading it avoids a forced layout per clip during drags.
    const styledWidth = parseFloat(item.style.width);
    const cssWidth = Math.max(
      16,
      Math.floor(
        styledWidth > 0
          ? styledWidth - 16
          : body.getBoundingClientRect().width || item.getBoundingClientRect().width || 16,
      ),
    );
    const cssHeight = Math.max(
      16,
      Math.floor(
        styledWidth > 0
          ? 40
          : body.getBoundingClientRect().height || item.getBoundingClientRect().height || 32,
      ),
    );
    const dpr = Math.max(1, Math.min(2, Number(window.devicePixelRatio) || 1));
    const bitmapWidth = Math.min(2048, Math.max(16, Math.round(cssWidth * dpr)));
    const bitmapHeight = Math.min(160, Math.max(16, Math.round(cssHeight * dpr)));
    if (canvas.width !== bitmapWidth) canvas.width = bitmapWidth;
    if (canvas.height !== bitmapHeight) canvas.height = bitmapHeight;

    const targetBuckets = Math.min(LIMITS.maxRenderBuckets, Math.max(16, Math.floor(cssWidth)));
    const peaks = core.windowPeaks(envelope, clip, targetBuckets);
    const windowInfo = core.describeClipWindow(envelope, clip);
    canvas.dataset.sourceStart = windowInfo.sourceStart.toFixed(6);
    canvas.dataset.sourceDuration = windowInfo.sourceDuration.toFixed(6);
    canvas.dataset.speed = windowInfo.speed.toFixed(6);
    canvas.dataset.bucketCount = String(peaks.length);

    const context = canvas.getContext('2d', { alpha: true });
    if (!context) return;
    context.clearRect(0, 0, bitmapWidth, bitmapHeight);
    if (!peaks.length) return;
    const center = bitmapHeight / 2;
    const xScale = bitmapWidth / peaks.length;
    context.beginPath();
    for (let index = 0; index < peaks.length; index += 1) {
      const peak = Math.max(0.025, Math.min(1, Number(peaks[index]) || 0));
      const amplitude = Math.max(1, peak * (bitmapHeight * 0.43));
      const x = Math.min(bitmapWidth - 0.5, (index + 0.5) * xScale);
      context.moveTo(x, center - amplitude);
      context.lineTo(x, center + amplitude);
    }
    context.lineWidth = Math.max(1, Math.min(2, xScale * 0.72));
    context.strokeStyle = clip.muted ? 'rgba(202, 216, 226, .32)' : 'rgba(133, 244, 217, .68)';
    context.stroke();
  }

  const envelopeIds = new WeakMap();
  let nextEnvelopeId = 1;
  function envelopeId(envelope) {
    if (!envelope || typeof envelope !== 'object') return 0;
    if (!envelopeIds.has(envelope)) envelopeIds.set(envelope, nextEnvelopeId++);
    return envelopeIds.get(envelope);
  }

  function decorateTimeline() {
    renderQueued = false;
    const project = projectSnapshot();
    if (!project || !Array.isArray(project.clips) || !Array.isArray(project.assets)) return;
    const clips = new Map(project.clips.map((clip) => [String(clip.id), clip]));
    const assets = new Map(project.assets.map((asset) => [String(asset.id), asset]));

    for (const item of root.querySelectorAll('.av-timeline-clip[data-kind="audio"]')) {
      const clip = clips.get(String(item.dataset.clipId || ''));
      const asset = clip ? assets.get(String(clip.assetId || '')) : null;
      if (!clip || !asset) {
        setItemState(item, 'unavailable', 'Audio metadata is unavailable for this clip.');
        continue;
      }
      const analysis = analysisFor(asset);
      if (analysis.status === 'ready') {
        // Redraw only clips whose waveform would change: a drag re-renders one clip, not every lane.
        const key = [
          envelopeId(analysis.envelope),
          clip.in,
          clip.duration,
          clip.speed,
          clip.reverse,
          clip.muted,
          item.style.width,
          window.devicePixelRatio,
        ].join('|');
        if (
          item.dataset.waveformKey === key &&
          item.dataset.waveformState === 'ready' &&
          item.querySelector('.av-waveform-canvas')
        )
          continue;
        setItemState(item, 'ready');
        drawWaveform(item, analysis.envelope, clip);
        item.dataset.waveformKey = key;
      } else {
        setItemState(
          item,
          analysis.status === 'loading' ? 'loading' : 'unavailable',
          analysis.reason || 'Waveform unavailable.',
        );
      }
    }
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    window.requestAnimationFrame(decorateTimeline);
  }

  root.addEventListener(
    'change',
    (event) => {
      if (event.target?.id === 'av-media-input') {
        rememberFiles(event.target.files);
        scheduleRender();
      } else if (event.target?.id === 'av-project-file') {
        clearLocalWaveforms();
      } else if (event.target?.id === 'av-zoom') {
        scheduleRender();
      }
    },
    true,
  );

  root.addEventListener(
    'input',
    (event) => {
      if (event.target?.id === 'av-zoom') scheduleRender();
    },
    true,
  );

  // The editor announces every linked local file (imports, portable projects, recovery).
  root.addEventListener('alcorvideo:media-linked', (event) => {
    const file = event.detail?.file;
    if (file) {
      rememberFiles([file]);
      scheduleRender();
    }
  });

  root.addEventListener(
    'drop',
    (event) => {
      if (event.dataTransfer?.files?.length) rememberFiles(event.dataTransfer.files);
    },
    true,
  );

  root.addEventListener(
    'click',
    (event) => {
      if (event.target?.closest?.('[data-action="new-project"]')) clearLocalWaveforms();
    },
    true,
  );

  const timeline = root.querySelector('#av-timeline');
  if (timeline) {
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches?.('.av-timeline-clip') || node.querySelector?.('.av-timeline-clip')) {
            scheduleRender();
            return;
          }
        }
      }
    });
    observer.observe(timeline, { childList: true, subtree: true });
  }

  window.AlcorVideoWaveforms = Object.freeze({
    version: VERSION,
    limits: LIMITS,
    refresh: scheduleRender,
    clear: clearLocalWaveforms,
  });

  scheduleRender();
})();
