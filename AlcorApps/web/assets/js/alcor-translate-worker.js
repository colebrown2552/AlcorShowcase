/* This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * AlcorTranslate in-browser translation engine (Web Worker).
 *
 * Used when the browser has no built-in Translator API. It runs Mozilla's
 * Bergamot translator (WebAssembly, ../lib/bergamot-translator/) with the
 * Firefox Translations models. The way the engine is loaded and called follows
 * bergamot-translator's worker/translator-worker.js (MPL-2.0).
 *
 * The only network requests this worker makes are for files, all from this
 * site: the engine, and the model files listed in models.json (served from
 * models.json's same-origin `base`). Every model file is checked against the
 * SHA-256 in models.json before use, and kept in Cache Storage so a language
 * pair downloads once. A pair is offered only if it is already cached or the
 * site's READY.json (written last by deploy/sync_translate_models.py) lists
 * it. Text to translate never leaves the worker.
 */
'use strict';

const CACHE_NAME = 'alcortranslate-models-v1';
const LIB = new URL('../lib/bergamot-translator/', self.location.href);
const VERSION = self.location.search;
const MAX_LOADED_MODELS = 4;
const GEMM = {
  int8_prepare_a: 'int8PrepareAFallback',
  int8_prepare_b: 'int8PrepareBFallback',
  int8_prepare_b_from_transposed: 'int8PrepareBFromTransposedFallback',
  int8_prepare_b_from_quantized_transposed: 'int8PrepareBFromQuantizedTransposedFallback',
  int8_prepare_bias: 'int8PrepareBiasFallback',
  int8_multiply_and_add_bias: 'int8MultiplyAndAddBiasFallback',
  int8_select_columns_of_b: 'int8SelectColumnsOfBFallback',
};
// Marian settings bergamot-translator uses for these models in the browser.
const MODEL_CONFIG =
  [
    'beam-size: 1',
    'normalize: 1.0',
    'word-penalty: 0',
    'cpu-threads: 0',
    'gemm-precision: int8shiftAlphaAll',
    'skip-cost: true',
    'alignment: soft',
    'quiet: true',
    'quiet-translation: true',
    'max-length-break: 128',
    'mini-batch-words: 1024',
    'workspace: 128',
    'max-length-factor: 2.0',
  ].join('\n') + '\n';

let manifestPromise = null;
let enginePromise = null;
let service = null;
const loaded = new Map(); // pair key -> Promise<TranslationModel>, oldest first

class EngineError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

/** Pairs whose files this site has in place, from READY.json; empty if it is missing or for another version. */
async function hostedPairs(base, version) {
  try {
    const response = await fetch(new URL('READY.json', base).href, {
      credentials: 'same-origin',
      cache: 'no-cache',
    });
    if (!response.ok) return new Set();
    const ready = await response.json();
    return ready && ready.version === version && Array.isArray(ready.pairs)
      ? new Set(ready.pairs)
      : new Set();
  } catch (error) {
    return new Set();
  }
}

function manifest() {
  if (!manifestPromise) {
    const pending = fetch(new URL('models.json' + VERSION, LIB).href, {
      credentials: 'same-origin',
    })
      .then((response) => {
        if (!response.ok) throw new EngineError('engine', 'models.json ' + response.status);
        return response.json();
      })
      .then(async (list) => {
        const base = new URL(list.base, self.location.href);
        if (base.origin !== self.location.origin)
          throw new EngineError('engine', 'language files must come from this site');
        list.base = base.href;
        list.hosted = await hostedPairs(base, list.version);
        // Ask again next time while the site has none in place.
        if (!list.hosted.size && manifestPromise === pending) manifestPromise = null;
        return list;
      });
    manifestPromise = pending;
    pending.catch(() => {
      if (manifestPromise === pending) manifestPromise = null;
    });
  }
  return manifestPromise;
}

/** Model keys for a pair: direct, through English, or null. */
function route(list, from, to) {
  const pairs = list.pairs || {};
  if (pairs[`${from}-${to}`]) return [`${from}-${to}`];
  if (from !== 'en' && to !== 'en' && pairs[`${from}-en`] && pairs[`en-${to}`])
    return [`${from}-en`, `en-${to}`];
  return null;
}

async function openCache() {
  try {
    return self.caches ? await self.caches.open(CACHE_NAME) : null;
  } catch (error) {
    // Private windows can refuse storage; files are then downloaded each visit.
    console.warn('AlcorTranslate: Cache Storage is not available:', error && error.name);
    return null;
  }
}

function hex(buffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(buffer) {
  return hex(await self.crypto.subtle.digest('SHA-256', buffer));
}

async function cachedFile(cache, url, hash) {
  if (!cache) return null;
  try {
    const hit = await cache.match(url);
    if (!hit) return null;
    const buffer = await hit.arrayBuffer();
    if ((await sha256(buffer)) === hash) return buffer;
    await cache.delete(url);
  } catch (error) {
    /* treat as not cached */
  }
  return null;
}

async function download(url, size, hash, onBytes) {
  let response;
  try {
    response = await fetch(url, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      mode: 'cors',
    });
  } catch (error) {
    throw new EngineError('download', String(error && error.message));
  }
  if (!response.ok) throw new EngineError('download', 'HTTP ' + response.status);
  let buffer;
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const out = new Uint8Array(size);
    let offset = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > size)
        throw new EngineError('integrity', 'file is larger than expected');
      out.set(value, offset);
      offset += value.byteLength;
      onBytes(value.byteLength);
    }
    if (offset !== size) throw new EngineError('integrity', 'file is smaller than expected');
    buffer = out.buffer;
  } else {
    buffer = await response.arrayBuffer();
    onBytes(buffer.byteLength);
  }
  if ((await sha256(buffer)) !== hash) throw new EngineError('integrity', 'checksum mismatch');
  return buffer;
}

async function gunzip(buffer) {
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/** Which of a route's files are already in Cache Storage, and how many bytes the rest would download. */
async function plan(from, to) {
  const list = await manifest();
  const keys = route(list, from, to);
  if (!keys) return { route: null, bytes: 0, cached: false, hosted: true };
  const cache = await openCache();
  let bytes = 0;
  let hosted = true;
  for (const key of keys) {
    for (const [, path, size] of list.pairs[key].files) {
      const hit = cache ? await cache.match(list.base + path).catch(() => null) : null;
      if (!hit) {
        bytes += size;
        if (!list.hosted.has(key)) hosted = false;
      }
    }
  }
  // Files the site doesn't have in place can't be downloaded: fail closed instead of offering the pair.
  if (!hosted) return { route: null, bytes: 0, cached: false, hosted: false };
  return { route: keys, bytes, cached: bytes === 0, hosted: true };
}

function engine() {
  if (!enginePromise) {
    enginePromise = new Promise((resolve, reject) => {
      (async () => {
        const response = await fetch(
          new URL('bergamot-translator-worker.wasm' + VERSION, LIB).href,
          { credentials: 'same-origin' },
        );
        if (!response.ok) throw new EngineError('engine', 'wasm ' + response.status);
        const bytes = await response.arrayBuffer();
        const Module = {
          print() {},
          printErr() {},
          onAbort(what) {
            reject(new EngineError('engine', 'abort: ' + what));
          },
          instantiateWasm(info, accept) {
            const gemm = {};
            for (const [name, fallback] of Object.entries(GEMM))
              gemm[name] = (...args) => Module.asm[fallback](...args);
            WebAssembly.instantiate(bytes, Object.assign({}, info, { wasm_gemm: gemm }))
              .then(({ instance }) => accept(instance))
              .catch((error) => reject(new EngineError('engine', String(error && error.message))));
            return {};
          },
          onRuntimeInitialized() {
            service = new Module.BlockingService({ cacheSize: 0 });
            resolve(Module);
          },
        };
        self.Module = Module;
        self.importScripts(new URL('bergamot-translator-worker.js' + VERSION, LIB).href);
      })().catch((error) =>
        reject(
          error instanceof EngineError
            ? error
            : new EngineError('engine', String(error && error.message)),
        ),
      );
    });
    enginePromise.catch(() => {
      enginePromise = null;
    });
  }
  return enginePromise;
}

function aligned(Module, buffer, alignment) {
  const bytes = new Int8Array(buffer);
  const memory = new Module.AlignedMemory(bytes.byteLength, alignment);
  memory.getByteArrayView().set(bytes);
  return memory;
}

async function loadModel(Module, list, key, fetchFile) {
  if (loaded.has(key)) {
    const pending = loaded.get(key);
    loaded.delete(key);
    loaded.set(key, pending); // most recently used goes last
    return pending;
  }
  const pending = (async () => {
    const parts = {};
    for (const [role, path, size, hash] of list.pairs[key].files)
      parts[role] = await gunzip(await fetchFile(path, size, hash));
    const vocabs = new Module.AlignedMemoryList();
    for (const vocab of parts.vocab ? [parts.vocab] : [parts.srcvocab, parts.trgvocab])
      vocabs.push_back(aligned(Module, vocab, 64));
    return new Module.TranslationModel(
      MODEL_CONFIG,
      aligned(Module, parts.model, 256),
      aligned(Module, parts.lex, 64),
      vocabs,
      null,
    );
  })();
  loaded.set(key, pending);
  pending.catch(() => {
    if (loaded.get(key) === pending) loaded.delete(key);
  });
  while (loaded.size > MAX_LOADED_MODELS) {
    const [oldest, model] = loaded.entries().next().value;
    loaded.delete(oldest);
    model.then(
      (m) => m.delete(),
      () => {},
    );
  }
  return pending;
}

async function translate(id, from, to, text) {
  const list = await manifest();
  const keys = route(list, from, to);
  if (!keys) throw new EngineError('unavailable');
  const cache = await openCache();
  // Work out the download first so progress has a real total.
  const todo = [];
  let total = 0;
  for (const key of keys) {
    if (loaded.has(key)) continue;
    for (const [, path, size, hash] of list.pairs[key].files) {
      const url = list.base + path;
      const hit = await cachedFile(cache, url, hash);
      if (!hit) {
        if (!list.hosted.has(key))
          throw new EngineError('unavailable', 'language files are not on this site');
        total += size;
      }
      todo.push({ url, hit });
    }
  }
  let done = 0;
  let last = 0;
  const report = (force) => {
    const now = Date.now();
    if (!total || (!force && now - last < 120)) return;
    last = now;
    self.postMessage({ id, progress: { loaded: done, total } });
  };
  const fetchFile = async (path, size, hash) => {
    const url = list.base + path;
    const known = todo.find((item) => item.url === url);
    if (known && known.hit) return known.hit;
    const buffer = await download(url, size, hash, (count) => {
      done += count;
      report(false);
    });
    if (cache) {
      try {
        await cache.put(
          url,
          new Response(buffer.slice(0), {
            headers: { 'Content-Type': 'application/octet-stream' },
          }),
        );
      } catch (error) {
        // Storage full or refused: the files still work for this visit.
        console.warn(
          'AlcorTranslate: language files could not be cached:',
          error && error.name,
          error && error.message,
        );
      }
    }
    return buffer;
  };
  if (total) report(true);
  const Module = await engine();
  const models = [];
  for (const key of keys) models.push(await loadModel(Module, list, key, fetchFile));
  if (total) {
    done = total;
    report(true);
  }
  const input = new Module.VectorString();
  const options = new Module.VectorResponseOptions();
  input.push_back(text);
  options.push_back({ qualityScores: false, alignment: false, html: false });
  let responses;
  try {
    responses =
      models.length > 1
        ? service.translateViaPivoting(models[0], models[1], input, options)
        : service.translate(models[0], input, options);
    return responses.get(0).getTranslatedText();
  } catch (error) {
    throw new EngineError('translate', String(error && error.message));
  } finally {
    input.delete();
    options.delete();
    if (responses) responses.delete();
  }
}

// One translation at a time: the engine is synchronous inside this worker anyway.
let queue = Promise.resolve();

self.addEventListener('message', (event) => {
  const data = event.data || {};
  const { id, op } = data;
  const job = async () => {
    if (op === 'plan') return plan(data.from, data.to);
    if (op === 'translate') return translate(id, data.from, data.to, String(data.text || ''));
    throw new EngineError('engine', 'unknown op');
  };
  const run = op === 'translate' ? (queue = queue.then(job, job)) : job();
  run.then(
    (result) => self.postMessage({ id, result }),
    (error) =>
      self.postMessage({
        id,
        error: {
          code: (error && error.code) || 'engine',
          message: String((error && error.message) || error),
        },
      }),
  );
});
