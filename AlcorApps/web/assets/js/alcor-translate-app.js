/*
 * AlcorTranslate: two-person conversation translator.
 *
 * Translation runs on the device. Where the browser has the built-in
 * Translator API (Chrome, Edge), that is used. Everywhere else a Web Worker
 * (alcor-translate-worker.js) runs Mozilla's Bergamot engine with the Firefox
 * Translations models; the worker downloads model files once per language pair
 * and never sends text anywhere. This file has no network primitives, no
 * analytics, and stores nothing except the two language choices.
 *
 * The first half is a pure core (exported for node tests); the second half
 * wires it to the page when the app markup is present.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AlcorTranslateCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Languages Chrome's built-in translator lists; availability() has the final say per pair.
  const LANGUAGES = Object.freeze(
    [
      ['ar', 'Arabic'],
      ['bg', 'Bulgarian'],
      ['bn', 'Bengali'],
      ['cs', 'Czech'],
      ['da', 'Danish'],
      ['de', 'German'],
      ['el', 'Greek'],
      ['en', 'English'],
      ['es', 'Spanish'],
      ['fi', 'Finnish'],
      ['fr', 'French'],
      ['he', 'Hebrew'],
      ['hi', 'Hindi'],
      ['hr', 'Croatian'],
      ['hu', 'Hungarian'],
      ['id', 'Indonesian'],
      ['it', 'Italian'],
      ['ja', 'Japanese'],
      ['kn', 'Kannada'],
      ['ko', 'Korean'],
      ['lt', 'Lithuanian'],
      ['mr', 'Marathi'],
      ['nl', 'Dutch'],
      ['no', 'Norwegian'],
      ['pl', 'Polish'],
      ['pt', 'Portuguese'],
      ['ro', 'Romanian'],
      ['ru', 'Russian'],
      ['sk', 'Slovak'],
      ['sl', 'Slovenian'],
      ['sv', 'Swedish'],
      ['ta', 'Tamil'],
      ['te', 'Telugu'],
      ['th', 'Thai'],
      ['tr', 'Turkish'],
      ['uk', 'Ukrainian'],
      ['vi', 'Vietnamese'],
      ['zh', 'Chinese (Simplified)'],
      ['zh-Hant', 'Chinese (Traditional)'],
    ].map((pair) => Object.freeze(pair)),
  );
  const LABELS = new Map(LANGUAGES);
  const AUTO = 'auto';
  const SIDES = Object.freeze(['a', 'b']);
  const SIDE_NAMES = Object.freeze({ a: 'Person A', b: 'Person B' });
  const DETECT_THRESHOLD = 0.5;
  const MAX_CHARS = 2000;
  // Some builds (headless Chromium among them) expose Translator but never answer availability().
  const ANSWER_TIMEOUT_MS = 8000;

  const MESSAGES = Object.freeze({
    unsupported:
      "This browser can't run AlcorTranslate. Use a current version of Chrome, Edge, Firefox or Safari.",
    'pair-unavailable': "AlcorTranslate can't translate {source} to {target} in this browser yet.",
    'no-answer':
      "This browser's translator didn't respond. Reload the page. If it still doesn't answer, update the browser and try again.",
    'setup-failed':
      "The browser couldn't get the {source} to {target} translator ready. Check your connection and try again, or reload the page.",
    'download-failed':
      "Couldn't download the {source} to {target} language files. Check your connection and try again.",
    integrity:
      "The {source} to {target} language files that arrived weren't the expected files, so they weren't used. Try again later.",
    'files-unavailable':
      "The {source} to {target} language files aren't available from this site right now, so this browser can't translate that pair. Chrome and Edge can, with their built-in translator.",
    'engine-failed':
      "The translator couldn't start in this browser. Reload the page and try again.",
    'translate-failed': "The translation didn't work. Try again, or try a shorter message.",
    'too-long': 'That message is too long to translate in one go. Split it up.',
    'detect-failed': "Couldn't tell which language that is. Pick a language for {side}.",
    'no-target':
      "{side} hasn't picked a language yet, and hasn't typed anything to detect it from.",
    cancelled: 'The conversation changed before this translation finished.',
    empty: 'Type something first.',
  });

  class TranslateError extends Error {
    constructor(code, message, cause) {
      super(message || MESSAGES[code] || code);
      this.name = 'TranslateError';
      this.code = code;
      if (cause !== undefined) this.cause = cause;
    }
  }

  function fill(template, values) {
    return String(template).replace(/\{(\w+)\}/g, (match, key) =>
      values && values[key] !== undefined ? String(values[key]) : match,
    );
  }

  function errorFor(code, values, cause) {
    return new TranslateError(code, fill(MESSAGES[code] || code, values), cause);
  }

  /** 'EN-us' -> 'en-US', 'zh-hant' -> 'zh-Hant'; null for anything that is not a language tag. */
  function normalizeLanguage(tag) {
    if (typeof tag !== 'string') return null;
    const parts = tag.trim().replace(/_/g, '-').split('-').filter(Boolean);
    if (!parts.length || !/^[a-zA-Z]{2,3}$/.test(parts[0])) return null;
    const out = [parts[0].toLowerCase()];
    for (const part of parts.slice(1)) {
      if (!/^[a-zA-Z0-9]{1,8}$/.test(part)) return null;
      if (part.length === 4) out.push(part[0].toUpperCase() + part.slice(1).toLowerCase());
      else if (part.length === 2) out.push(part.toUpperCase());
      else out.push(part.toLowerCase());
    }
    return out.join('-');
  }

  /** The code AlcorTranslate lists for a browser tag ('pt-BR' -> 'pt', 'zh-TW' -> 'zh-Hant'); null if unlisted. */
  function listedLanguage(tag) {
    const normal = normalizeLanguage(tag);
    if (!normal) return null;
    if (LABELS.has(normal)) return normal;
    const base = normal.split('-')[0];
    if (base === 'zh') return /-(Hant|TW|HK|MO)\b/.test(normal) ? 'zh-Hant' : 'zh';
    if (base === 'iw') return 'he';
    if (base === 'nb' || base === 'nn') return 'no';
    return LABELS.has(base) ? base : null;
  }

  function languageLabel(tag) {
    const listed = listedLanguage(tag);
    if (listed) return LABELS.get(listed);
    return normalizeLanguage(tag) || String(tag);
  }

  function sameLanguage(first, second) {
    const a = listedLanguage(first) || normalizeLanguage(first);
    const b = listedLanguage(second) || normalizeLanguage(second);
    return Boolean(a) && a === b;
  }

  function otherSide(side) {
    if (side === 'a') return 'b';
    if (side === 'b') return 'a';
    throw new TypeError(`Unknown side: ${side}`);
  }

  /** Download progress events report a 0..1 fraction; older builds sent bytes with a total. */
  function progressFraction(event) {
    if (!event) return 0;
    const loaded = Number(event.loaded);
    const total = Number(event.total);
    if (!Number.isFinite(loaded) || loaded <= 0) return 0;
    if (Number.isFinite(total) && total > 1) return Math.min(1, loaded / total);
    return Math.min(1, loaded);
  }

  /** Pick a speech voice for a language, on-device voices first. */
  function pickVoice(voices, tag) {
    const want = listedLanguage(tag);
    if (!want || !voices) return null;
    const matches = Array.from(voices).filter(
      (voice) => voice && listedLanguage(voice.lang) === want,
    );
    if (!matches.length) return null;
    const exact = normalizeLanguage(tag);
    const score = (voice) =>
      (voice.localService ? 2 : 0) +
      (normalizeLanguage(voice.lang) === exact ? 1 : 0) +
      (voice.default ? 0.5 : 0);
    return matches.slice().sort((x, y) => score(y) - score(x))[0];
  }

  const USABLE = Object.freeze(['available', 'downloadable', 'downloading']);
  const FALLBACK_ERRORS = Object.freeze({
    download: 'download-failed',
    integrity: 'integrity',
    engine: 'engine-failed',
    unavailable: 'pair-unavailable',
  });

  /**
   * Wrap the browser's Translator / LanguageDetector (or test doubles with
   * the same shape), plus an optional on-device Fallback engine
   * ({ availability(source, target), plan(source, target), translate(source, target, text, onProgress) })
   * for pairs or browsers the built-in translator doesn't cover.
   * Translators are created once per language pair.
   */
  function createAdapter(api, options) {
    const env = api || {};
    const timeoutMs = options && options.timeoutMs > 0 ? options.timeoutMs : ANSWER_TIMEOUT_MS;
    const Translator = env.Translator;
    const LanguageDetector = env.LanguageDetector;
    const Fallback = env.Fallback || null;
    const translators = new Map();
    const engines = new Map();
    let detector = null;
    // A built-in translator that never answers (headless builds) is skipped once a fallback exists.
    let nativeSilent = false;

    function hasNative() {
      return (
        !nativeSilent &&
        Boolean(
          Translator &&
            typeof Translator.availability === 'function' &&
            typeof Translator.create === 'function',
        )
      );
    }

    function hasTranslator() {
      return hasNative() || Boolean(Fallback);
    }

    function hasDetector() {
      return Boolean(
        LanguageDetector &&
          typeof LanguageDetector.availability === 'function' &&
          typeof LanguageDetector.create === 'function',
      );
    }

    /** The browser's answer, or 'no-answer' if it stays silent. */
    function answerOrTimeout(promise) {
      let timer;
      const silence = new Promise((resolve) => {
        timer = setTimeout(() => resolve('no-answer'), timeoutMs);
      });
      return Promise.race([promise, silence]).finally(() => clearTimeout(timer));
    }

    async function nativeAvailability(source, target) {
      if (!hasNative()) return 'unsupported';
      try {
        const state = await answerOrTimeout(
          Translator.availability({ sourceLanguage: source, targetLanguage: target }),
        );
        if (state === 'no-answer' && Fallback) nativeSilent = true;
        return state;
      } catch (error) {
        return 'unavailable';
      }
    }

    /** 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported' | 'no-answer' */
    async function availability(source, target) {
      if (!hasTranslator()) return 'unsupported';
      const native = await nativeAvailability(source, target);
      if (USABLE.includes(native) || !Fallback) {
        engines.set(`${source}>${target}`, 'native');
        return native;
      }
      engines.set(`${source}>${target}`, 'fallback');
      return Fallback.availability(source, target);
    }

    /** How a pair checked by availability() will be translated, and what the fallback would download. */
    function details(source, target) {
      const engine = engines.get(`${source}>${target}`) || null;
      const plan =
        engine === 'fallback' && typeof Fallback.plan === 'function'
          ? Fallback.plan(source, target)
          : null;
      return {
        engine,
        bytes: plan && plan.route ? plan.bytes : 0,
        hosted: !(plan && plan.hosted === false),
      };
    }

    async function detectorAvailability() {
      if (!hasDetector()) return 'unsupported';
      try {
        return await answerOrTimeout(LanguageDetector.availability());
      } catch (error) {
        return 'unavailable';
      }
    }

    function monitorFor(onProgress, details) {
      return function monitor(target) {
        if (
          !target ||
          typeof target.addEventListener !== 'function' ||
          typeof onProgress !== 'function'
        )
          return;
        target.addEventListener('downloadprogress', (event) =>
          onProgress(Object.assign({ fraction: progressFraction(event) }, details)),
        );
      };
    }

    async function translatorFor(source, target, onProgress) {
      const key = `${source}>${target}`;
      if (!translators.has(key)) {
        const pending = (async () => {
          const labels = { source: languageLabel(source), target: languageLabel(target) };
          const native = await nativeAvailability(source, target);
          if (USABLE.includes(native)) {
            try {
              return await Translator.create({
                sourceLanguage: source,
                targetLanguage: target,
                monitor: monitorFor(onProgress, { kind: 'translator', source, target }),
              });
            } catch (error) {
              if (!Fallback) throw errorFor('setup-failed', labels, error);
            }
          }
          if (Fallback) {
            const state = await Fallback.availability(source, target);
            if (!USABLE.includes(state)) {
              const plan =
                typeof Fallback.plan === 'function' ? Fallback.plan(source, target) : null;
              throw errorFor(
                plan && plan.hosted === false ? 'files-unavailable' : 'pair-unavailable',
                labels,
              );
            }
            return {
              fallback: true,
              translate: (text, report) =>
                Fallback.translate(source, target, text, (event) => {
                  if (typeof report === 'function' && event && event.total > 0) {
                    report({
                      kind: 'fallback',
                      source,
                      target,
                      loaded: event.loaded,
                      total: event.total,
                      fraction: Math.min(1, event.loaded / event.total),
                    });
                  }
                }),
            };
          }
          if (native === 'unsupported') throw errorFor('unsupported');
          if (native === 'no-answer') throw errorFor('no-answer');
          throw errorFor('pair-unavailable', labels);
        })();
        translators.set(key, pending);
        // A failed create must not poison the pair for the next attempt.
        pending.catch(() => {
          if (translators.get(key) === pending) translators.delete(key);
        });
      }
      return translators.get(key);
    }

    async function translate(source, target, text, options) {
      if (!hasTranslator()) throw errorFor('unsupported');
      const onProgress = options && options.onProgress;
      const translator = await translatorFor(source, target, onProgress);
      try {
        const result = translator.fallback
          ? await translator.translate(text, onProgress)
          : await translator.translate(text);
        if (typeof result !== 'string') throw new TypeError('Translator returned no text');
        return result;
      } catch (error) {
        if (error && error.name === 'QuotaExceededError') throw errorFor('too-long', null, error);
        const code = translator.fallback && error && FALLBACK_ERRORS[error.engineCode];
        if (code)
          throw errorFor(
            code,
            { source: languageLabel(source), target: languageLabel(target) },
            error,
          );
        throw errorFor('translate-failed', null, error);
      }
    }

    /** Best guess for the text's language, or null when there is no confident answer. */
    async function detect(text, options) {
      if (!hasDetector()) return null;
      try {
        if (!detector) {
          detector = LanguageDetector.create({
            monitor: monitorFor(options && options.onProgress, { kind: 'detector' }),
          });
          detector.catch(() => {
            detector = null;
          });
        }
        const results = await (await detector).detect(text);
        const top = Array.isArray(results) && results.length ? results[0] : null;
        if (!top || !top.detectedLanguage || top.detectedLanguage === 'und') return null;
        return { language: top.detectedLanguage, confidence: Number(top.confidence) || 0 };
      } catch (error) {
        return null;
      }
    }

    async function destroy() {
      const all = Array.from(translators.values());
      translators.clear();
      for (const pending of all) {
        try {
          const translator = await pending;
          if (translator && typeof translator.destroy === 'function') translator.destroy();
        } catch (error) {
          /* already failed */
        }
      }
    }

    return Object.freeze({
      hasTranslator,
      hasDetector,
      availability,
      details,
      detectorAvailability,
      translate,
      detect,
      destroy,
    });
  }

  /**
   * Conversation state: two sides, each with a language ('auto' = detect from
   * what that person types), and a transcript of translated entries.
   */
  function createConversation(options) {
    const settings = options || {};
    const adapter = settings.adapter;
    const now = typeof settings.now === 'function' ? settings.now : () => new Date();
    const threshold =
      typeof settings.detectThreshold === 'number' ? settings.detectThreshold : DETECT_THRESHOLD;
    const sides = {
      a: { lang: settings.a || 'en', detected: null },
      b: { lang: settings.b || 'es', detected: null },
    };
    const entries = [];
    let counter = 0;
    let revision = 0;

    function requireCurrent(operation) {
      if (operation !== revision) throw errorFor('cancelled');
    }

    function setLanguage(side, lang) {
      otherSide(side);
      const value = lang === AUTO ? AUTO : listedLanguage(lang);
      if (!value) throw new TypeError(`Unknown language: ${lang}`);
      revision += 1;
      sides[side].lang = value;
      if (value !== AUTO) sides[side].detected = null;
      return value;
    }

    /** The language a side is using right now: its pick, or what was last detected. */
    function languageOf(side) {
      const state = sides[side];
      return state.lang === AUTO ? state.detected : state.lang;
    }

    async function sourceFor(side, text, onProgress, operation) {
      const state = sides[side];
      if (state.lang !== AUTO) return state.lang;
      const guess = adapter ? await adapter.detect(text, { onProgress }) : null;
      requireCurrent(operation);
      const detected =
        guess && guess.confidence >= threshold ? listedLanguage(guess.language) : null;
      if (detected) {
        state.detected = detected;
        return detected;
      }
      if (state.detected) return state.detected;
      throw errorFor('detect-failed', { side: SIDE_NAMES[side] });
    }

    async function send(side, rawText, sendOptions) {
      const to = otherSide(side);
      const text = String(rawText == null ? '' : rawText).trim();
      if (!text) throw errorFor('empty');
      if (!adapter || !adapter.hasTranslator()) throw errorFor('unsupported');
      const operation = revision;
      const reportProgress = sendOptions && sendOptions.onProgress;
      const onProgress = (details) => {
        if (operation === revision && typeof reportProgress === 'function') reportProgress(details);
      };
      const at = now();
      try {
        const source = await sourceFor(side, text.slice(0, MAX_CHARS), onProgress, operation);
        requireCurrent(operation);
        const target = languageOf(to);
        if (!target) throw errorFor('no-target', { side: SIDE_NAMES[to] });
        const same = sameLanguage(source, target);
        const translated = same
          ? text
          : await adapter.translate(source, target, text, { onProgress });
        requireCurrent(operation);
        counter += 1;
        const entry = Object.freeze({
          id: counter,
          side,
          source,
          target,
          original: text,
          translated,
          same,
          at,
        });
        entries.push(entry);
        return entry;
      } catch (error) {
        requireCurrent(operation);
        throw error;
      }
    }

    function swap() {
      revision += 1;
      const a = sides.a;
      sides.a = sides.b;
      sides.b = a;
      for (let index = 0; index < entries.length; index += 1) {
        entries[index] = Object.freeze(
          Object.assign({}, entries[index], { side: otherSide(entries[index].side) }),
        );
      }
    }

    function clear() {
      revision += 1;
      entries.length = 0;
      for (const side of SIDES) sides[side].detected = null;
    }

    /** Latest message the other person sent to this side, if any. */
    function latestFor(side) {
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (entries[index].side !== side) return entries[index];
      }
      return null;
    }

    return Object.freeze({
      sides,
      entries,
      setLanguage,
      languageOf,
      send,
      swap,
      clear,
      latestFor,
    });
  }

  function pad(number) {
    return String(number).padStart(2, '0');
  }

  function clock(date) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function stamp(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  /** Plain-text transcript with both languages for every message. */
  function formatTranscript(entries, savedAt) {
    const when = savedAt instanceof Date ? savedAt : new Date();
    const lines = [
      `AlcorTranslate conversation, saved ${stamp(when)} ${clock(when)}`,
      'Machine translation made in the browser. Check anything important with someone who speaks both languages.',
      '',
    ];
    if (!entries || !entries.length) {
      lines.push('(No messages.)');
      return `${lines.join('\n')}\n`;
    }
    for (const entry of entries) {
      lines.push(`${clock(entry.at)}  ${SIDE_NAMES[entry.side]} (${languageLabel(entry.source)})`);
      lines.push(`       ${entry.original.replace(/\r?\n/g, '\n       ')}`);
      if (entry.same)
        lines.push(`       ${languageLabel(entry.target)}: same language, not translated`);
      else
        lines.push(
          `       ${languageLabel(entry.target)}: ${entry.translated.replace(/\r?\n/g, '\n       ')}`,
        );
      lines.push('');
    }
    return lines.join('\n');
  }

  function transcriptFilename(savedAt) {
    const when = savedAt instanceof Date ? savedAt : new Date();
    return `alcortranslate-${stamp(when)}-${pad(when.getHours())}${pad(when.getMinutes())}.txt`;
  }

  /** Pick two starting languages from the browser's preferences. */
  function defaultLanguages(preferred) {
    const first = (preferred || []).map(listedLanguage).find(Boolean) || 'en';
    return { a: first, b: first === 'en' ? 'es' : 'en' };
  }

  return Object.freeze({
    LANGUAGES,
    AUTO,
    SIDES,
    SIDE_NAMES,
    MAX_CHARS,
    MESSAGES,
    TranslateError,
    normalizeLanguage,
    listedLanguage,
    languageLabel,
    sameLanguage,
    otherSide,
    progressFraction,
    pickVoice,
    createAdapter,
    createConversation,
    formatTranscript,
    transcriptFilename,
    defaultLanguages,
  });
});

(function () {
  'use strict';
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const app = document.querySelector('[data-alcor-translate-app]');
  const Core = window.AlcorTranslateCore;
  if (!app || !Core) return;

  const STORAGE_KEY = 'alcortranslate:languages';
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  const synth =
    'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function'
      ? window.speechSynthesis
      : null;

  const scriptSrc = document.currentScript && document.currentScript.src;
  const FALLBACK_HOST = 'this site';

  /**
   * The in-browser engine for browsers without a built-in translator: a Web Worker started on first
   * use. Only language-file downloads leave the device; text goes to the worker and back.
   */
  function createFallbackEngine(src) {
    const capable =
      src &&
      typeof window.Worker === 'function' &&
      typeof window.WebAssembly === 'object' &&
      typeof window.DecompressionStream === 'function' &&
      window.isSecureContext &&
      window.crypto &&
      window.crypto.subtle;
    if (!capable) return null;
    const workerUrl = new URL('alcor-translate-worker.js', src);
    workerUrl.search = new URL(src).search;
    const calls = new Map();
    const plans = new Map();
    let worker = null;
    let sequence = 0;

    function failAll(code) {
      for (const [id, call] of calls) {
        calls.delete(id);
        const error = new Error('The translation engine stopped.');
        error.engineCode = code;
        call.reject(error);
      }
    }

    function start() {
      if (worker) return worker;
      worker = new Worker(workerUrl.href);
      worker.addEventListener('message', (event) => {
        const data = event.data || {};
        const call = calls.get(data.id);
        if (!call) return;
        if (data.progress) {
          if (call.onProgress) call.onProgress(data.progress);
          return;
        }
        calls.delete(data.id);
        if (data.error) {
          const error = new Error(data.error.message);
          error.engineCode = data.error.code;
          call.reject(error);
        } else call.resolve(data.result);
      });
      worker.addEventListener('error', (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        worker.terminate();
        worker = null;
        failAll('engine');
      });
      return worker;
    }

    function call(op, payload, onProgress) {
      return new Promise((resolve, reject) => {
        sequence += 1;
        calls.set(sequence, { resolve, reject, onProgress });
        start().postMessage(Object.assign({ id: sequence, op }, payload));
      });
    }

    return Object.freeze({
      async availability(source, target) {
        try {
          const plan = await call('plan', { from: source, to: target });
          plans.set(`${source}>${target}`, plan);
          if (!plan || !plan.route) return 'unavailable';
          return plan.cached ? 'available' : 'downloadable';
        } catch (error) {
          return 'unavailable';
        }
      },
      plan(source, target) {
        return plans.get(`${source}>${target}`) || null;
      },
      async translate(source, target, text, onProgress) {
        const result = await call('translate', { from: source, to: target, text }, onProgress);
        const plan = plans.get(`${source}>${target}`);
        if (plan)
          plans.set(`${source}>${target}`, Object.assign({}, plan, { cached: true, bytes: 0 }));
        return result;
      },
    });
  }

  const adapter = Core.createAdapter({
    Translator: window.Translator,
    LanguageDetector: window.LanguageDetector,
    Fallback: createFallbackEngine(scriptSrc),
  });
  const starting = Object.assign(
    Core.defaultLanguages(navigator.languages || [navigator.language]),
    readStoredLanguages(),
  );
  const conversation = Core.createConversation({ adapter, a: starting.a, b: starting.b });
  // A remembered "detect" choice comes back once the browser confirms it can detect.
  let lastSentSide = null;
  const restoreAuto = { a: starting.a === Core.AUTO, b: starting.b === Core.AUTO };

  const $ = (selector, scope) => (scope || app).querySelector(selector);
  const panes = {};
  for (const side of Core.SIDES) {
    const pane = $(`[data-side="${side}"]`);
    panes[side] = {
      root: pane,
      select: $('[data-role="lang"]', pane),
      incoming: $('[data-role="incoming"]', pane),
      form: $('[data-role="composer"]', pane),
      input: $('[data-role="input"]', pane),
      send: $('[data-role="send"]', pane),
      mic: $('[data-action="mic"]', pane),
      speak: $('[data-role="speak"]', pane),
      note: $('[data-role="note"]', pane),
      recognition: null,
      micOperation: null,
      operation: null,
      inputRevision: 0,
    };
  }
  const support = $('#at-support');
  const pairStatus = $('#at-pair-status');
  const progress = $('#at-progress');
  const progressLabel = $('#at-progress-label');
  const progressBar = $('#at-progress-bar');
  const transcriptList = $('#at-transcript-list');
  const transcriptEmpty = $('#at-transcript-empty');
  const transcriptStatus = $('#at-transcript-status');
  const micNote = $('#at-mic-note');
  let detectorUsable = false;
  // Languages this browser said it can't translate for this page view. They stay listed, with a note.
  const unavailableLanguages = new Set();
  const NOT_HERE = ' (not in this browser)';
  const PROBE_PARALLEL = 4;
  let probe = { key: '', token: 0 };
  // Checks started for an old pair can't be cancelled, so they keep their slot until the browser answers.
  let probesRunning = 0;
  const probeWaiting = [];

  async function probeAvailability(source, target, live) {
    while (probesRunning >= PROBE_PARALLEL)
      await new Promise((resolve) => probeWaiting.push(resolve));
    if (!live()) {
      const next = probeWaiting.shift();
      if (next) next();
      return null;
    }
    probesRunning += 1;
    try {
      return await adapter.availability(source, target);
    } finally {
      probesRunning -= 1;
      const next = probeWaiting.shift();
      if (next) next();
    }
  }

  function readStoredLanguages() {
    try {
      const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
      const out = {};
      if (stored && typeof stored === 'object') {
        for (const side of ['a', 'b']) {
          const value = stored[side] === Core.AUTO ? Core.AUTO : Core.listedLanguage(stored[side]);
          if (value) out[side] = value;
        }
      }
      return out;
    } catch (error) {
      return {};
    }
  }

  function storeLanguages() {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ a: conversation.sides.a.lang, b: conversation.sides.b.lang }),
      );
    } catch (error) {
      /* private mode: choices just aren't remembered */
    }
  }

  function nativeName(code) {
    try {
      const name = new Intl.DisplayNames([code], { type: 'language' }).of(code);
      return name ? name.charAt(0).toLocaleUpperCase(code) + name.slice(1) : '';
    } catch (error) {
      return '';
    }
  }

  function optionLabel(code, english) {
    const native = nativeName(code);
    const label =
      native && native.toLowerCase() !== english.toLowerCase() ? `${english} (${native})` : english;
    return unavailableLanguages.has(code) ? label + NOT_HERE : label;
  }

  function markUnavailable(code) {
    if (!code || code === Core.AUTO || unavailableLanguages.has(code)) return;
    unavailableLanguages.add(code);
    for (const side of Core.SIDES) {
      for (const option of panes[side].select.options) {
        if (option.value === code) option.textContent = optionLabel(code, Core.languageLabel(code));
      }
    }
  }

  function stopProbes() {
    probe = { key: '', token: probe.token + 1 };
  }

  /**
   * Find out which listed languages this browser lacks, against the first side's language, at most
   * PROBE_PARALLEL checks at a time. Stops when the browser goes quiet or the pair changes.
   * A pair that can't be translated doesn't say which language is missing, so each side is first
   * checked against a third language.
   */
  function startProbes(a, b, pairUnavailable) {
    const key = `${a}|${b}`;
    if (probe.key === key) return;
    const token = probe.token + 1;
    probe = { key, token };
    const live = () => probe.token === token;
    const queue = Core.LANGUAGES.map(([code]) => code).filter(
      (code) =>
        !Core.sameLanguage(code, a) &&
        !Core.sameLanguage(code, b) &&
        !unavailableLanguages.has(code),
    );
    async function worker() {
      while (live() && queue.length) {
        const code = queue.shift();
        if (!live()) return;
        const state = await probeAvailability(a, code, live);
        if (!live()) return;
        if (state === 'no-answer') {
          stopProbes();
          return;
        }
        if (state === 'unavailable') markUnavailable(code);
      }
    }
    (async () => {
      if (pairUnavailable) {
        const reference = [a, b].some((code) => Core.sameLanguage(code, 'en')) ? 'es' : 'en';
        for (const code of [a, b]) {
          if (Core.sameLanguage(code, reference) || unavailableLanguages.has(code)) continue;
          const state = await probeAvailability(reference, code, live);
          if (!live()) return;
          if (state === 'unavailable') markUnavailable(code);
        }
      }
      for (let count = 0; count < PROBE_PARALLEL; count += 1) worker();
    })();
  }

  function fillSelect(select, side) {
    select.replaceChildren();
    if (detectorUsable) {
      const auto = document.createElement('option');
      auto.value = Core.AUTO;
      auto.textContent = 'Detect from what they type';
      select.append(auto);
    }
    const sorted = Core.LANGUAGES.slice().sort((x, y) => x[1].localeCompare(y[1]));
    for (const [code, english] of sorted) {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = optionLabel(code, english);
      select.append(option);
    }
    let value = conversation.sides[side].lang;
    if (value === Core.AUTO && !detectorUsable) {
      value = conversation.setLanguage(
        side,
        conversation.languageOf(Core.otherSide(side)) === 'en' ? 'es' : 'en',
      );
    }
    select.value = value;
  }

  function setNote(side, message, tone) {
    const note = panes[side].note;
    note.textContent = message || '';
    note.dataset.tone = tone || 'info';
  }

  function sideName(side) {
    return Core.SIDE_NAMES[side];
  }

  function placeholderFor(side) {
    const lang = conversation.languageOf(side);
    return lang
      ? `${sideName(side)}: type in ${Core.languageLabel(lang)}, then press Enter`
      : `${sideName(side)}: type here, then press Enter`;
  }

  function renderIncoming(side) {
    const box = panes[side].incoming;
    const current = conversation.languageOf(side);
    let entry = conversation.latestFor(side);
    // After a language change, an older message in another language doesn't belong here.
    if (entry && current && !Core.sameLanguage(entry.target, current)) entry = null;
    box.replaceChildren();
    if (!entry) {
      const empty = document.createElement('p');
      empty.className = 'at-incoming-empty';
      empty.textContent = `What ${sideName(Core.otherSide(side))} says will show up here in ${sideName(side)}'s language.`;
      box.append(empty);
      return;
    }
    const label = document.createElement('p');
    label.className = 'at-incoming-label';
    label.textContent = entry.same
      ? `${sideName(entry.side)} wrote in ${Core.languageLabel(entry.source)}`
      : `${sideName(entry.side)} said, translated from ${Core.languageLabel(entry.source)}`;
    const text = document.createElement('p');
    text.className = 'at-incoming-text';
    text.lang = entry.target;
    text.dir = 'auto';
    text.textContent = entry.translated;
    box.append(label, text);
    if (!entry.same) {
      const original = document.createElement('p');
      original.className = 'at-incoming-original';
      original.lang = entry.source;
      original.dir = 'auto';
      original.textContent = entry.original;
      box.append(original);
    }
  }

  function renderTranscript() {
    transcriptList.replaceChildren();
    for (const entry of conversation.entries) {
      const item = document.createElement('li');
      item.className = `at-entry at-entry-${entry.side}`;
      const meta = document.createElement('p');
      meta.className = 'at-entry-meta';
      const who = document.createElement('strong');
      who.textContent = sideName(entry.side);
      const time = document.createElement('time');
      time.dateTime = entry.at.toISOString();
      time.textContent = entry.at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      meta.append(who, ` ${Core.languageLabel(entry.source)}`, time);
      const original = document.createElement('p');
      original.className = 'at-entry-original';
      original.lang = entry.source;
      original.dir = 'auto';
      original.textContent = entry.original;
      const translated = document.createElement('p');
      translated.className = 'at-entry-translation';
      translated.lang = entry.target;
      translated.dir = 'auto';
      const tag = document.createElement('span');
      // A fixed direction keeps the language chip out of dir="auto", so the reply's own text decides it.
      tag.dir = 'ltr';
      tag.textContent = Core.languageLabel(entry.target);
      translated.append(tag, entry.same ? 'Same language, not translated' : entry.translated);
      item.append(meta, original, translated);
      transcriptList.append(item);
    }
    const hasEntries = conversation.entries.length > 0;
    transcriptEmpty.hidden = hasEntries;
    updateTranscriptActions();
    const last = transcriptList.lastElementChild;
    if (
      last &&
      typeof last.scrollIntoView === 'function' &&
      transcriptList.scrollHeight > transcriptList.clientHeight
    ) {
      transcriptList.scrollTop = transcriptList.scrollHeight;
    }
  }

  function hasConversationWork() {
    return (
      conversation.entries.length > 0 ||
      Core.SIDES.some((side) => {
        const pane = panes[side];
        return pane.operation || pane.micOperation || pane.input.value.trim();
      })
    );
  }

  function updateTranscriptActions() {
    for (const button of app.querySelectorAll('[data-needs-entries]')) {
      button.disabled =
        button.dataset.action === 'clear' ? !hasConversationWork() : !conversation.entries.length;
    }
  }

  function invalidatePending() {
    stopProbes();
    if (!clearConfirm.hidden) clearConfirm.hidden = true;
    for (const side of Core.SIDES) {
      const pane = panes[side];
      pane.operation = null;
      pane.send.disabled = !adapter.hasTranslator();
      pane.root.removeAttribute('aria-busy');
      stopMic(side);
      setNote(side, '');
    }
    if (synth) synth.cancel();
    progress.hidden = true;
    updateTranscriptActions();
  }

  function renderAll() {
    for (const side of Core.SIDES) {
      panes[side].select.value = conversation.sides[side].lang;
      panes[side].input.placeholder = placeholderFor(side);
      renderIncoming(side);
    }
    renderTranscript();
  }

  function megabytes(bytes) {
    return String(Math.max(0, Math.round((Number(bytes) || 0) / 1e6)));
  }

  function showProgress(details) {
    if (!details) {
      progress.hidden = true;
      return;
    }
    const percent = Math.round(details.fraction * 100);
    progress.hidden = false;
    progressBar.value = details.fraction;
    if (details.kind === 'detector') {
      progressLabel.textContent = `Your browser is downloading its language detector (${percent}%). This happens once.`;
    } else if (details.kind === 'fallback') {
      progressLabel.textContent = `Downloading the ${Core.languageLabel(details.source)} to ${Core.languageLabel(details.target)} language files from ${FALLBACK_HOST}: ${megabytes(details.loaded)} of ${megabytes(details.total)} MB. This happens once per language pair. What you type stays on this device.`;
    } else {
      progressLabel.textContent = `Your browser is downloading the ${Core.languageLabel(details.source)} to ${Core.languageLabel(details.target)} language pack (${percent}%). This happens once per language pair.`;
    }
    if (details.fraction >= 1)
      window.setTimeout(() => {
        if (!Core.SIDES.some((side) => panes[side].operation)) progress.hidden = true;
      }, 1200);
  }

  async function refreshPairStatus() {
    const a = conversation.languageOf('a');
    const b = conversation.languageOf('b');
    if (!adapter.hasTranslator()) {
      pairStatus.textContent = "Translation isn't available in this browser.";
      pairStatus.dataset.tone = 'error';
      return;
    }
    if (!a || !b) {
      const waiting = !a ? 'a' : 'b';
      pairStatus.textContent = `${sideName(waiting)}'s language will be detected from the first thing they type.`;
      pairStatus.dataset.tone = 'info';
      return;
    }
    if (Core.sameLanguage(a, b)) {
      pairStatus.textContent =
        'Both sides are set to the same language, so nothing needs translating.';
      pairStatus.dataset.tone = 'info';
      return;
    }
    const pair = `${Core.languageLabel(a)} and ${Core.languageLabel(b)}`;
    pairStatus.textContent = `Checking ${pair}…`;
    const [forward, back] = await Promise.all([
      adapter.availability(a, b),
      adapter.availability(b, a),
    ]);
    if (conversation.languageOf('a') !== a || conversation.languageOf('b') !== b) return;
    const states = [forward, back];
    if (states.includes('no-answer')) stopProbes();
    else startProbes(a, b, states.includes('unavailable'));
    if (states.includes('no-answer')) {
      pairStatus.textContent = Core.MESSAGES['no-answer'];
      pairStatus.dataset.tone = 'error';
    } else if (states.includes('unavailable')) {
      const missing = [adapter.details(a, b), adapter.details(b, a)].some(
        (info) => info.engine === 'fallback' && info.hosted === false,
      );
      pairStatus.textContent = missing
        ? `${pair}: this browser needs language files from this site, and they aren't available right now. Chrome and Edge can translate this pair with their built-in translator.`
        : `This browser can't translate between ${pair}. Try another pair.`;
      pairStatus.dataset.tone = 'error';
    } else if (states.every((state) => state === 'available')) {
      pairStatus.textContent = `${pair} are ready on this device.`;
      pairStatus.dataset.tone = 'ready';
    } else if (
      [adapter.details(a, b), adapter.details(b, a)].some((info) => info.engine === 'fallback')
    ) {
      const bytes = adapter.details(a, b).bytes + adapter.details(b, a).bytes;
      pairStatus.textContent = `${pair}: the first time each direction is used, your browser downloads its language files from ${FALLBACK_HOST} (about ${megabytes(bytes)} MB in all). What you type stays on this device.`;
      pairStatus.dataset.tone = 'info';
    } else {
      pairStatus.textContent = `${pair}: your browser downloads the language pack the first time you translate.`;
      pairStatus.dataset.tone = 'info';
    }
  }

  function speakInto(side, entry) {
    const toggle = panes[side].speak;
    if (!synth || !toggle || !toggle.checked) return;
    const voice = Core.pickVoice(synth.getVoices(), entry.target);
    if (!voice) {
      setNote(
        side,
        `There's no ${Core.languageLabel(entry.target)} voice on this device, so it can't be read aloud.`,
        'info',
      );
      return;
    }
    const utterance = new window.SpeechSynthesisUtterance(entry.translated);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    synth.cancel();
    synth.speak(utterance);
  }

  async function send(side, text) {
    const pane = panes[side];
    if (pane.operation) return;
    const to = Core.otherSide(side);
    const operation = {};
    pane.operation = operation;
    setNote(side, '');
    pane.send.disabled = true;
    pane.root.setAttribute('aria-busy', 'true');
    updateTranscriptActions();
    try {
      const entry = await conversation.send(side, text, {
        onProgress: (details) => {
          if (pane.operation === operation) showProgress(details);
        },
      });
      if (pane.operation !== operation) return;
      // The typed text stays so a language change can translate it again without retyping.
      lastSentSide = side;
      renderAll();
      speakInto(to, entry);
      // A first translation downloads the pack, and a detection can settle a side's language.
      if (pairStatus.dataset.tone !== 'ready') refreshPairStatus();
    } catch (error) {
      if (pane.operation !== operation || (error && error.code === 'cancelled')) return;
      setNote(
        side,
        error && error.code ? error.message : 'Something went wrong. Nothing was translated.',
        'error',
      );
      if (!error || !error.code || error.cause)
        console.warn('AlcorTranslate:', error && error.cause ? error.cause : error);
    } finally {
      if (pane.operation === operation) {
        pane.operation = null;
        pane.send.disabled = !adapter.hasTranslator();
        pane.root.removeAttribute('aria-busy');
        if (!Core.SIDES.some((candidate) => panes[candidate].operation)) progress.hidden = true;
        updateTranscriptActions();
      }
    }
  }

  function micErrorMessage(code) {
    if (code === 'not-allowed' || code === 'service-not-allowed')
      return 'The microphone is blocked for this page. Allow it in the address bar, or type instead.';
    if (code === 'no-speech') return "Didn't hear anything. Try again a little closer to the mic.";
    if (code === 'audio-capture') return 'No microphone was found.';
    if (code === 'network')
      return 'Speech input needs an internet connection in this browser. You can still type.';
    if (code === 'language-not-supported')
      return "Speech input doesn't support this language here. Type instead.";
    if (code === 'aborted') return '';
    return 'Speech input stopped. Try again, or type instead.';
  }

  function setMicState(side, listening, local) {
    const button = panes[side].mic;
    button.setAttribute('aria-pressed', listening ? 'true' : 'false');
    button.querySelector('span').textContent = listening ? 'Stop' : 'Speak';
    if (listening)
      setNote(
        side,
        local
          ? 'Listening (on this device)…'
          : "Listening… your browser's speech service is turning this into text.",
        'info',
      );
  }

  async function toggleMic(side) {
    const pane = panes[side];
    if (pane.micOperation) {
      if (pane.recognition) pane.recognition.stop();
      else stopMic(side);
      return;
    }
    const lang = conversation.languageOf(side);
    if (!lang) {
      setNote(side, `Pick a language for ${sideName(side)} before using the mic.`, 'error');
      return;
    }
    const recognition = new SpeechRecognition();
    const operation = {};
    pane.micOperation = operation;
    updateTranscriptActions();
    recognition.lang = lang;
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    let local = false;
    if ('processLocally' in recognition && typeof SpeechRecognition.available === 'function') {
      try {
        const state = await SpeechRecognition.available({ langs: [lang], processLocally: true });
        if (state === 'available') {
          recognition.processLocally = true;
          local = true;
        }
      } catch (error) {
        /* fall back to the browser default */
      }
    }
    if (pane.micOperation !== operation) return;
    let finalText = '';
    let failed = false;
    recognition.onresult = (event) => {
      if (pane.micOperation !== operation) return;
      let text = '';
      for (let index = 0; index < event.results.length; index += 1)
        text += event.results[index][0].transcript;
      pane.input.value = text;
      pane.inputRevision += 1;
      updateTranscriptActions();
      if (event.results.length && event.results[event.results.length - 1].isFinal) finalText = text;
    };
    recognition.onerror = (event) => {
      if (pane.micOperation !== operation) return;
      failed = true;
      setNote(side, micErrorMessage(event.error), 'error');
    };
    recognition.onend = () => {
      if (pane.micOperation !== operation) return;
      pane.recognition = null;
      pane.micOperation = null;
      setMicState(side, false);
      if (!failed) setNote(side, '');
      if (!failed && finalText.trim()) send(side, finalText);
      updateTranscriptActions();
    };
    pane.recognition = recognition;
    setMicState(side, true, local);
    try {
      recognition.start();
    } catch (error) {
      pane.recognition = null;
      pane.micOperation = null;
      setMicState(side, false);
      setNote(side, "Speech input couldn't start. Type instead.", 'error');
      updateTranscriptActions();
    }
  }

  /** Stop listening without sending: the side's language or position is changing under it. */
  function stopMic(side) {
    const pane = panes[side];
    const recognition = pane.recognition;
    pane.micOperation = null;
    pane.recognition = null;
    setMicState(side, false);
    if (recognition) {
      try {
        recognition.abort();
      } catch (error) {
        /* callbacks are already invalidated */
      }
    }
    updateTranscriptActions();
  }

  function flash(message) {
    transcriptStatus.textContent = message;
    window.clearTimeout(flash.timer);
    flash.timer = window.setTimeout(() => {
      transcriptStatus.textContent = '';
    }, 4000);
  }

  async function copyTranscript() {
    const text = Core.formatTranscript(conversation.entries, new Date());
    try {
      await navigator.clipboard.writeText(text);
      flash('Copied the transcript.');
    } catch (error) {
      flash('This browser blocked copying. Use Download instead.');
    }
  }

  function downloadTranscript() {
    const now = new Date();
    const blob = new Blob([Core.formatTranscript(conversation.entries, now)], {
      type: 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = Core.transcriptFilename(now);
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    flash(`Saved ${link.download}.`);
  }

  const clearButton = $('[data-action="clear"]');
  const clearConfirm = document.createElement('div');
  const clearYes = document.createElement('button');
  const clearKeep = document.createElement('button');

  function buildClearConfirm() {
    const text = document.createElement('p');
    text.id = 'at-clear-confirm-text';
    text.textContent = "Clear this conversation? It isn't saved anywhere else.";
    clearYes.type = 'button';
    clearYes.className = 'at-button';
    clearYes.textContent = 'Clear';
    clearKeep.type = 'button';
    clearKeep.className = 'at-button at-button-primary';
    clearKeep.textContent = 'Keep';
    clearConfirm.className = 'at-confirm';
    clearConfirm.setAttribute('role', 'group');
    clearConfirm.setAttribute('aria-labelledby', text.id);
    clearConfirm.hidden = true;
    clearConfirm.append(text, clearYes, clearKeep);
    clearButton.parentNode.append(clearConfirm);
    clearYes.addEventListener('click', () => {
      closeClearConfirm();
      clearConversation(true);
    });
    clearKeep.addEventListener('click', closeClearConfirm);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !clearConfirm.hidden) {
        event.preventDefault();
        closeClearConfirm();
      }
    });
  }

  function closeClearConfirm() {
    if (clearConfirm.hidden) return;
    clearConfirm.hidden = true;
    // A disabled button can't hold focus (nothing left to clear), so the next control takes it.
    clearButton.focus();
    if (document.activeElement !== clearButton) {
      const swap = $('[data-action="swap"]');
      if (swap) swap.focus();
    }
  }

  function clearConversation(confirmed) {
    if (!confirmed && hasConversationWork()) {
      clearConfirm.hidden = false;
      clearKeep.focus();
      return;
    }
    invalidatePending();
    conversation.clear();
    lastSentSide = null;
    for (const side of Core.SIDES) {
      setNote(side, '');
      panes[side].input.value = '';
    }
    renderAll();
    refreshPairStatus();
    flash('Cleared.');
  }

  function swapSides() {
    invalidatePending();
    conversation.swap();
    const a = panes.a.input.value;
    panes.a.input.value = panes.b.input.value;
    panes.b.input.value = a;
    if (lastSentSide) lastSentSide = Core.otherSide(lastSentSide);
    storeLanguages();
    renderAll();
    refreshPairStatus();
  }

  // The banner's "copy link" button: Clipboard API first; if the browser refuses, show the link selected.
  function wireCopyLink() {
    const button = $('[data-action="copy-link"]', support);
    const field = $('[data-role="page-link"]', support);
    const status = $('[data-role="link-status"]', support);
    if (!button || !field || !status) return;
    const link = window.location.origin + window.location.pathname;
    field.value = link;
    button.hidden = false;
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(link);
        field.hidden = true;
        status.textContent =
          'Link copied. Paste it into a current version of Chrome, Edge, Firefox or Safari.';
      } catch (error) {
        field.hidden = false;
        field.focus();
        field.select();
        status.textContent = 'This browser blocked copying. Copy the selected link by hand.';
      }
    });
  }

  function wire() {
    for (const side of Core.SIDES) {
      const pane = panes[side];
      pane.select.addEventListener('change', () => {
        invalidatePending();
        restoreAuto[side] = false;
        conversation.setLanguage(side, pane.select.value);
        storeLanguages();
        pane.input.placeholder = placeholderFor(side);
        setNote(side, '');
        renderIncoming(side);
        refreshPairStatus();
        // Keep the source text and translate it again into the new language.
        if (lastSentSide && panes[lastSentSide].input.value.trim() && adapter.hasTranslator()) {
          send(lastSentSide, panes[lastSentSide].input.value);
        }
      });
      pane.input.addEventListener('input', () => {
        pane.inputRevision += 1;
        updateTranscriptActions();
      });
      pane.form.addEventListener('submit', (event) => {
        event.preventDefault();
        send(side, pane.input.value);
      });
      pane.input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          if (!adapter.hasTranslator()) {
            if (pane.input.value.trim()) setNote(side, Core.MESSAGES.unsupported, 'error');
          } else if (!pane.send.disabled) send(side, pane.input.value);
        }
      });
      if (SpeechRecognition) pane.mic.addEventListener('click', () => toggleMic(side));
      else pane.mic.hidden = true;
      if (!synth) pane.speak.closest('label').hidden = true;
      // The privacy line under the composer only talks about the controls this browser shows.
      const privacy = pane.form.querySelector('.at-speech-privacy');
      if (privacy && !SpeechRecognition) {
        if (synth)
          privacy.textContent = 'Read aloud may send translated text to an online voice provider.';
        else privacy.hidden = true;
      } else if (privacy && !synth)
        privacy.textContent = "Speak may send audio to your browser's speech service.";
    }
    app.addEventListener('click', (event) => {
      const button = event.target.closest('[data-action]');
      if (!button || button.disabled) return;
      const action = button.dataset.action;
      if (action === 'swap') swapSides();
      else if (action === 'clear') clearConversation();
      else if (action === 'copy') copyTranscript();
      else if (action === 'download') downloadTranscript();
    });
    if (synth && typeof synth.addEventListener === 'function')
      synth.addEventListener('voiceschanged', () => synth.getVoices());
  }

  function init() {
    buildClearConfirm();
    const supported = adapter.hasTranslator();
    for (const side of Core.SIDES) fillSelect(panes[side].select, side);
    wire();
    if (!supported) {
      support.hidden = false;
      wireCopyLink();
      for (const side of Core.SIDES) {
        panes[side].send.disabled = true;
        panes[side].mic.disabled = true;
      }
    }
    micNote.hidden = !SpeechRecognition;
    app.dataset.state = supported ? 'ready' : 'unsupported';
    renderAll();
    refreshPairStatus();
    if (!supported) return;
    // "Detect from what they type" is offered once the browser says it can detect.
    adapter.detectorAvailability().then((state) => {
      if (!['available', 'downloadable', 'downloading'].includes(state)) return;
      detectorUsable = true;
      const restored = Core.SIDES.filter((side) => restoreAuto[side]);
      if (restored.length) invalidatePending();
      for (const side of restored) conversation.setLanguage(side, Core.AUTO);
      for (const side of Core.SIDES) fillSelect(panes[side].select, side);
      if (restored.length) {
        renderAll();
        refreshPairStatus();
      }
    });
  }

  init();
})();
