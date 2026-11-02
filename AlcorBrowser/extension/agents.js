/**
 * AlcorBrowser extension worker: runs one agent command on one tab and answers.
 *
 * The broker (runtime/broker.py) owns names and trust: it authenticates agents and maps short tab
 * handles to Chrome tab ids. This worker owns action: it receives `{type: 'command', id, op, args}`
 * over a native-messaging port, runs `OPS[op]` on the tab id it was given, and replies
 * `{type: 'result', id, result}`. It never sees an agent token or a tab handle.
 *
 * Design rules:
 * - Agents act on any tab of the profile. There are no grants, leases or agent windows.
 * - Two safety floors remain: no typing into password fields and no clicks into CAPTCHA frames.
 *   They are guard rails for a cooperative agent, not a sandbox: `eval` is outside them.
 * - Channel: `chrome.runtime.connectNative(HOST)` reaches only the native host whose manifest lists
 *   this extension's id, and that host relays to the broker. A connected native port also keeps this
 *   MV3 service worker alive.
 * - Real input: clicks, keys and text go through `chrome.debugger` (`Input.*`), so pages see trusted
 *   events. If that fails, a DOM fallback still acts and the result says `via: 'dom'`.
 *
 * Loaded by background.js after config.js (per-install settings) and page.js (the in-page helper).
 */
(() => {
  'use strict';
  // config.js is written per install. Every field has a default, so a partial file still works.
  const cfg = globalThis.ALCOR_BROWSER_CONFIG || {};
  const HOST = String(cfg.host || 'com.alcor.browser');
  const PROFILE = String(cfg.profile_label || 'default');
  const BUILD = String(cfg.build || '');
  const VERSION = chrome.runtime.getManifest().version;
  const SESSION_KEY = 'alcorBrowserSession';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let port = null;
  let backoff = 1000;
  /** Pending popup requests to the broker, keyed by request id. */
  const hubWaiters = new Map();

  /**
   * Append a row to a 30-row lifecycle diary in `chrome.storage.local`.
   *
   * Chrome hides a worker's errors from everything but chrome://extensions, so this diary is what an
   * operator can read when the worker cannot reach the broker.
   * @param {string} what - Short event name.
   * @param {unknown} [detail] - Optional detail, truncated to 300 characters.
   */
  function diag(what, detail) {
    const row = {
      t: new Date().toISOString(),
      what,
      ...(detail ? { detail: String(detail).slice(0, 300) } : {}),
    };
    chrome.storage.local
      .get('alcorDiag')
      .then((v) =>
        chrome.storage.local.set({ alcorDiag: [...(v.alcorDiag || []), row].slice(-30) }),
      )
      .catch(() => {});
  }
  self.addEventListener('error', (e) => diag('error', e.message + ' @' + e.lineno));
  self.addEventListener('unhandledrejection', (e) =>
    diag('rejection', e.reason && (e.reason.stack || e.reason.message || e.reason)),
  );
  diag('worker-start', VERSION + ' ' + BUILD.slice(0, 12));

  // A browser restart renumbers tabs, so the broker scopes tab handles to a session id. The id survives
  // extension reloads (storage.local) and is replaced on browser start.
  chrome.runtime.onStartup.addListener(() => {
    chrome.storage.local.remove(SESSION_KEY).catch(() => {});
  });
  /** @returns {Promise<string>} The current browser session id, created on first use. */
  async function browserSession() {
    let id = (await chrome.storage.local.get(SESSION_KEY))[SESSION_KEY];
    if (!id) {
      id = crypto.randomUUID();
      await chrome.storage.local.set({ [SESSION_KEY]: id });
    }
    return id;
  }

  // ---------------------------------------------------------------------------------------------
  // Tabs and loading.
  // ---------------------------------------------------------------------------------------------
  /**
   * Look up a tab, turning Chrome's "No tab with id" into the stable error `tab-gone`.
   * @param {number} id - Chrome tab id.
   * @returns {Promise<chrome.tabs.Tab>} The tab.
   */
  async function tabOf(id) {
    try {
      return await chrome.tabs.get(id);
    } catch {
      throw new Error('tab-gone');
    }
  }
  /**
   * Read `[readyState, href]` from the top frame, giving up after 1.5 s so a frozen page cannot stall us.
   * @param {number} tabId - Chrome tab id.
   * @returns {Promise<[string, string] | null | undefined>} The pair, or null when unavailable.
   */
  async function docState(tabId) {
    try {
      const run = chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        injectImmediately: true,
        func: () => [document.readyState, location.href],
      });
      const rows = await Promise.race([run, sleep(1500).then(() => null)]);
      return rows && rows[0] && rows[0].result;
    } catch (_) {
      return null;
    }
  }
  /**
   * Wait until a tab has navigated and its document is past `loading`.
   *
   * Heavy web apps stay 'loading' long after they are usable, so readiness is "DOM interactive",
   * not 'complete'.
   * @param {number} tabId - Chrome tab id.
   * @param {number} [ms] - Give up after this many milliseconds.
   * @returns {Promise<boolean>} True if the tab became ready in time.
   */
  async function waitReady(tabId, ms = 15000) {
    const end = Date.now() + ms;
    await sleep(80);
    while (Date.now() < end) {
      let t;
      try {
        t = await chrome.tabs.get(tabId);
      } catch (_) {
        return false;
      }
      if (!t.pendingUrl && t.url && t.url !== 'about:blank') {
        const st = await docState(tabId);
        if (st && st[1] === t.url && st[0] !== 'loading') return true;
      }
      await sleep(120);
    }
    return false;
  }
  /**
   * After an action, give a navigation it caused time to finish before the result is read.
   * @param {number} tabId - Chrome tab id.
   * @param {string} [before] - The tab's URL before the action; a change means a navigation began.
   */
  async function settle(tabId, before) {
    await sleep(120);
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.pendingUrl || (before && t.url !== before)) await waitReady(tabId, 10000);
    } catch (_) {}
  }
  /** @returns {Promise<number | null>} The window new tabs should open in, or null if none is open. */
  async function targetWindow() {
    const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
    if (!wins.length) return null;
    try {
      const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      if (w && w.id != null) return w.id;
    } catch (_) {}
    return wins[0].id;
  }
  /**
   * Reduce a Chrome tab to the fields the broker uses to name and list it.
   * @param {chrome.tabs.Tab} t - The tab.
   * @returns {{tab_id: number, window_id: number, active: boolean, url: string, title: string}} Row.
   */
  function tabRow(t) {
    return {
      tab_id: t.id,
      window_id: t.windowId,
      active: t.active,
      url: t.url || t.pendingUrl || '',
      title: t.title || '',
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Trusted input through chrome.debugger. Every call is bounded; a session left by a dead worker is retaken.
  // ---------------------------------------------------------------------------------------------
  /** Tabs we hold a debugger session on, mapped to the timer that detaches them when idle. */
  const attached = new Map();
  /**
   * Reject if a promise has not settled within `ms`, so no debugger call can hang a command forever.
   * @param {Promise<any>} p - The operation.
   * @param {number} ms - Time limit in milliseconds.
   * @param {string} what - Label; the rejection reads `<what>-timeout`.
   * @returns {Promise<any>} The operation's result.
   */
  function bounded(p, ms, what) {
    let timer;
    return Promise.race([
      p,
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(what + '-timeout')), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  }
  /**
   * Send one Chrome DevTools Protocol command to a tab, attaching the debugger first if needed.
   *
   * The session is dropped after 20 s of silence so Chrome's "is debugging this browser" bar does not
   * stay up, and after any timeout so a wedged session is not reused. If a dead worker left a session
   * behind ("already attached"), it is taken over.
   * @param {number} tabId - Chrome tab id.
   * @param {string} method - CDP method, e.g. `Input.dispatchMouseEvent`.
   * @param {object} [params] - Method parameters.
   * @param {number} [ms] - Time limit for the command.
   * @returns {Promise<any>} The CDP result.
   */
  async function cdp(tabId, method, params = {}, ms = 8000) {
    if (!attached.has(tabId)) {
      try {
        await bounded(chrome.debugger.attach({ tabId }, '1.3'), 5000, 'debugger-attach');
      } catch (e) {
        if (!/already attached/i.test(String(e && e.message))) throw e;
        await bounded(chrome.debugger.detach({ tabId }), 3000, 'debugger-detach').catch(() => {});
        await bounded(chrome.debugger.attach({ tabId }, '1.3'), 5000, 'debugger-attach');
      }
      attached.set(tabId, null);
    }
    clearTimeout(attached.get(tabId));
    attached.set(
      tabId,
      setTimeout(() => detach(tabId), 20000),
    );
    try {
      return await bounded(
        chrome.debugger.sendCommand({ tabId }, method, params),
        ms,
        'cdp-' + method,
      );
    } catch (e) {
      if (/-timeout$/.test(String(e && e.message))) detach(tabId);
      throw e;
    }
  }
  /** Release the debugger session on a tab, if we hold one. */
  function detach(tabId) {
    if (!attached.has(tabId)) return;
    clearTimeout(attached.get(tabId));
    attached.delete(tabId);
    chrome.debugger.detach({ tabId }).catch(() => {});
  }
  chrome.debugger.onDetach.addListener((src) => {
    if (src.tabId != null) {
      clearTimeout(attached.get(src.tabId));
      attached.delete(src.tabId);
    }
  });
  // A "Leave site?" dialog would hold a close or navigation forever, so it is accepted automatically.
  chrome.debugger.onEvent.addListener((src, method) => {
    if (method === 'Page.javascriptDialogOpening')
      chrome.debugger
        .sendCommand({ tabId: src.tabId }, 'Page.handleJavaScriptDialog', { accept: true })
        .catch(() => {});
  });
  /**
   * Click at viewport coordinates with real mouse events (move, press, release; twice for a double click).
   * @param {number} tabId - Chrome tab id.
   * @param {number} x - Viewport x in CSS pixels.
   * @param {number} y - Viewport y in CSS pixels.
   * @param {boolean} [double] - Send a double click.
   */
  async function cdpClick(tabId, x, y, double) {
    const at = { x, y, button: 'left', pointerType: 'mouse' };
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    for (const n of double ? [1, 2] : [1]) {
      await cdp(tabId, 'Input.dispatchMouseEvent', {
        ...at,
        type: 'mousePressed',
        clickCount: n,
        buttons: 1,
      });
      await cdp(tabId, 'Input.dispatchMouseEvent', {
        ...at,
        type: 'mouseReleased',
        clickCount: n,
        buttons: 0,
      });
    }
  }
  const SELECT_ALL_MOD = /Mac/i.test(navigator.platform || '') ? 'meta' : 'ctrl';
  /** Named keys: [Windows virtual key code, `code`, text typed by the key (if any)]. */
  const KEYS = {
    Enter: [13, 'Enter', '\r'],
    Tab: [9, 'Tab'],
    Escape: [27, 'Escape'],
    Backspace: [8, 'Backspace'],
    Delete: [46, 'Delete'],
    ArrowUp: [38, 'ArrowUp'],
    ArrowDown: [40, 'ArrowDown'],
    ArrowLeft: [37, 'ArrowLeft'],
    ArrowRight: [39, 'ArrowRight'],
    Home: [36, 'Home'],
    End: [35, 'End'],
    PageUp: [33, 'PageUp'],
    PageDown: [34, 'PageDown'],
    Space: [32, 'Space', ' '],
  };
  /**
   * Press and release one key with real keyboard events.
   * @param {number} tabId - Chrome tab id.
   * @param {string} key - A name from `KEYS`, or a single character.
   * @param {string[]} [mods] - Any of `alt`, `ctrl`, `meta`, `shift`.
   * @throws {Error} `unknown-key` when `key` is neither named nor a single character.
   */
  async function cdpKey(tabId, key, mods = []) {
    const m =
      (mods.includes('alt') ? 1 : 0) |
      (mods.includes('ctrl') ? 2 : 0) |
      (mods.includes('meta') ? 4 : 0) |
      (mods.includes('shift') ? 8 : 0);
    let vk,
      code,
      text,
      name = key;
    if (KEYS[key]) {
      [vk, code, text] = KEYS[key];
      if (key === 'Space') name = ' ';
    } else if ([...key].length === 1) {
      const up = key.toUpperCase();
      vk = up.charCodeAt(0);
      text = key;
      code = /[A-Z]/.test(up) ? 'Key' + up : /[0-9]/.test(key) ? 'Digit' + key : '';
    } else throw new Error('unknown-key ' + key);
    if (m & 7) text = undefined; // with ctrl/alt/meta a key is a shortcut, not text
    const base = {
      key: name,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      modifiers: m,
    };
    await cdp(tabId, 'Input.dispatchKeyEvent', {
      ...base,
      type: text ? 'keyDown' : 'rawKeyDown',
      text,
      unmodifiedText: text,
    });
    await cdp(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  }

  /**
   * Run `alcorPage(cmd)` (page.js) in a tab's top frame and return its result.
   *
   * Injected without waiting for document_idle and bounded, so a frozen page answers with an error
   * the agent can act on instead of hanging the command.
   * @param {number} tabId - Chrome tab id.
   * @param {object} cmd - The page-side command (`op` plus fields).
   * @param {number} [ms] - Time limit in milliseconds.
   * @returns {Promise<object>} The page-side result.
   */
  async function inPage(tabId, cmd, ms = 20000) {
    let timer;
    const run = chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: alcorPage,
      args: [cmd],
      injectImmediately: true,
    });
    const late = new Promise((_, rej) => {
      timer = setTimeout(
        () => rej(new Error('page-busy: no answer in ' + Math.round(ms / 1000) + ' s; retry')),
        ms,
      );
    });
    try {
      const rows = await Promise.race([run, late]);
      return (rows && rows[0] && rows[0].result) || { ok: false, error: 'no-page-result' };
    } finally {
      clearTimeout(timer);
    }
  }
  /** Pick the element-addressing fields (ref + snapshot id, or selector) out of a command's args. */
  const target = (a) => ({ ref: a.ref, snapshot_id: a.snapshot_id, selector: a.selector });

  /**
   * Try trusted input first; if it fails, run the DOM fallback. Either way the result says which
   * path acted (`via`), so an agent can tell a trusted event from a synthetic one.
   * @param {() => Promise<void>} fn - The trusted (CDP) action.
   * @param {() => Promise<{ok: boolean}>} fallback - The DOM action, used if `fn` throws.
   * @returns {Promise<{via: 'cdp'} | {via: 'dom', cdp_error: string}>} Which path acted.
   * @throws {Error} When the fallback also fails; the message is its `refused` or `error`.
   */
  async function trustedOr(fn, fallback) {
    try {
      await fn();
      return { via: 'cdp' };
    } catch (e) {
      const r = await fallback();
      if (!r || !r.ok) throw new Error((r && (r.refused || r.error)) || 'dom-fallback-failed');
      return { via: 'dom', cdp_error: String((e && e.message) || e).slice(0, 160) };
    }
  }
  /**
   * Decides when a ChatGPT reply is finished.
   *
   * It is finished when ChatGPT says so (no Stop button and the text steady over two polls), or when
   * the text has not changed for 8 s. The second rule exists because Chrome throttles a hidden
   * background tab, and ChatGPT's "Stop" to "complete" switch can then stall for minutes while the
   * full text is already on the page.
   */
  class ReplyWatch {
    /**
     * @param {object} s - A `cg_state` result taken when waiting starts.
     * @param {number} [after] - Reply count that must be exceeded; defaults to "a reply that is not
     *   the one already on screen".
     */
    constructor(s, after = s.replies - (s.reply ? 1 : 0)) {
      this.after = after;
      this.text = s.reply;
      this.since = Date.now();
      this.steady = 0;
      this.by = '';
    }
    /**
     * Feed one fresh `cg_state` poll.
     * @param {object} s - The poll result.
     * @returns {boolean} True once the reply is complete; `this.by` then says which rule fired.
     */
    done(s) {
      if (s.reply !== this.text) {
        this.text = s.reply;
        this.since = Date.now();
        this.steady = 0;
        return false;
      }
      if (!s.reply || s.replies <= this.after) return false;
      this.steady++;
      if (!s.busy && this.steady >= 2) {
        this.by = 'chatgpt-complete';
        return true;
      }
      // Not while the thread is still ChatGPT's local placeholder (/c/local-chatgpt:...): nothing has streamed yet.
      if (Date.now() - this.since >= 8000 && !/local-chatgpt/.test(s.url)) {
        this.by = 'text-steady-8s';
        return true;
      }
      return false;
    }
  }
  /**
   * Base64-encode bytes in slices, because `String.fromCharCode.apply` overflows the stack on big arrays.
   * @param {Uint8Array} bytes - The data.
   * @returns {string} Base64 text.
   */
  function toBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // ---------------------------------------------------------------------------------------------
  // Operations. Every op but open, tabs and reload takes `a.tab_id`, already resolved by the broker.
  // Each returns a result object; `execute` turns a thrown error into `{ok: false, error}`.
  // ---------------------------------------------------------------------------------------------
  /** The command table: one async function per `op` the broker can send. */
  const OPS = {
    async open(a) {
      const wid = await targetWindow();
      const tab =
        wid == null
          ? (await chrome.windows.create({ url: a.url, focused: !!a.focus })).tabs[0]
          : await chrome.tabs.create({ windowId: wid, url: a.url, active: !!a.focus });
      if (a.focus && wid != null) chrome.windows.update(wid, { focused: true }).catch(() => {});
      // Chrome discards background tabs under memory pressure, which silently loses an agent's page
      // state, so agent tabs opt out.
      chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
      await waitReady(tab.id, 15000);
      return { ok: true, ...tabRow(await tabOf(tab.id)) };
    },
    async tabs() {
      return {
        ok: true,
        tabs: (await chrome.tabs.query({})).filter((t) => !t.incognito).map(tabRow),
      };
    },
    async reload() {
      setTimeout(() => chrome.runtime.reload(), 200);
      return { ok: true, reloading: true, version: VERSION };
    },
    async focus(a) {
      const t = await tabOf(a.tab_id);
      await chrome.tabs.update(t.id, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
      return { ok: true };
    },
    async navigate(a) {
      const from = (await tabOf(a.tab_id)).url;
      if (a.url) {
        await chrome.tabs.update(a.tab_id, { url: a.url });
        await waitReady(a.tab_id, 15000);
      } else if (a.direction === 'back') {
        await chrome.tabs.goBack(a.tab_id);
        await settle(a.tab_id, from);
      } else if (a.direction === 'forward') {
        await chrome.tabs.goForward(a.tab_id);
        await settle(a.tab_id, from);
      } else {
        await chrome.tabs.reload(a.tab_id);
        await sleep(300);
        await waitReady(a.tab_id, 15000);
      }
      const t = await tabOf(a.tab_id);
      return { ok: true, url: t.url, title: t.title };
    },
    async snapshot(a) {
      await tabOf(a.tab_id);
      return inPage(a.tab_id, {
        op: 'snapshot',
        max_elements: a.max_elements,
        text_limit: a.text_limit,
        all: !!a.all,
      });
    },
    async screenshot(a) {
      const maxW = Math.min(Math.max(Number(a.max_width) || 1024, 320), 1920);
      const m = await cdp(a.tab_id, 'Page.getLayoutMetrics');
      const vv = m.cssVisualViewport || m.visualViewport,
        full = !!a.full_page;
      const w = vv.clientWidth,
        h = full ? Math.min((m.cssContentSize || m.contentSize).height, 10000) : vv.clientHeight;
      const scale = Math.min(1, maxW / w);
      const r = await cdp(
        a.tab_id,
        'Page.captureScreenshot',
        {
          format: 'jpeg',
          quality: 60,
          captureBeyondViewport: full,
          clip: { x: full ? 0 : vv.pageX, y: full ? 0 : vv.pageY, width: w, height: h, scale },
        },
        15000,
      );
      return {
        ok: true,
        data: r.data,
        mime: 'image/jpeg',
        width: Math.round(w * scale),
        height: Math.round(h * scale),
      };
    },
    async click(a) {
      const before = (await tabOf(a.tab_id)).url;
      const loc = await inPage(a.tab_id, { op: 'locate', ...target(a), x: a.x, y: a.y });
      if (!loc.ok) return loc;
      const r = await trustedOr(
        () => cdpClick(a.tab_id, loc.x, loc.y, a.double),
        () => inPage(a.tab_id, { op: 'domclick', ...target(a), x: a.x, y: a.y }),
      );
      await settle(a.tab_id, before);
      const t = await tabOf(a.tab_id);
      return { ok: true, clicked: loc.label, ...r, url: t.url, title: t.title };
    },
    async type(a) {
      const before = (await tabOf(a.tab_id)).url;
      const loc = await inPage(a.tab_id, { op: 'locate', ...target(a) });
      if (!loc.ok) return loc;
      // Safety floor: refuse before any input is sent, and again inside the page (`focus`, `domtype`).
      if (loc.password)
        return { ok: false, refused: 'password-field', hint: 'the operator types passwords' };
      if (!loc.editable) return { ok: false, error: 'not-editable' };
      const clear = a.clear !== false,
        text = String(a.text);
      const r = await trustedOr(
        async () => {
          if (!loc.focused) await cdpClick(a.tab_id, loc.x, loc.y);
          const f = await inPage(a.tab_id, { op: 'focus', ...target(a), clear });
          if (!f.ok) throw new Error(f.refused || f.error);
          // A real select-all: rich editors (Draft.js, ProseMirror) track their own selection and ignore a DOM range.
          if (clear && f.had_text) {
            await cdpKey(a.tab_id, 'a', [SELECT_ALL_MOD]);
            await cdpKey(a.tab_id, 'Backspace');
          }
          if (text) await cdp(a.tab_id, 'Input.insertText', { text });
        },
        () => inPage(a.tab_id, { op: 'domtype', ...target(a), text, clear }),
      );
      const out = { ok: true, ...r };
      if (a.submit) {
        await cdpKey(a.tab_id, 'Enter');
        await settle(a.tab_id, before);
        const t = await tabOf(a.tab_id);
        Object.assign(out, { submitted: true, url: t.url, title: t.title });
      } else out.value = (await inPage(a.tab_id, { op: 'value', ...target(a) })).value;
      return out;
    },
    async press(a) {
      const before = (await tabOf(a.tab_id)).url;
      const key = String(a.key);
      // A key that types a character must not reach a password field, or the floor in `type` could be
      // bypassed one key at a time. Enter, Tab, arrows and Backspace stay allowed. If the page cannot
      // be probed (a frozen page, a page that blocks scripts) the press goes ahead: this floor is a
      // guard rail for a cooperative agent, not a sandbox.
      if ([...key].length === 1 || key === 'Space') {
        const focus = await inPage(a.tab_id, { op: 'active' }, 3000).catch(() => null);
        if (focus && focus.password)
          return { ok: false, refused: 'password-field', hint: 'the operator types passwords' };
      }
      await cdpKey(a.tab_id, key, Array.isArray(a.modifiers) ? a.modifiers : []);
      await settle(a.tab_id, before);
      const t = await tabOf(a.tab_id);
      return { ok: true, key: a.key, url: t.url, title: t.title };
    },
    async select(a) {
      return inPage(a.tab_id, { op: 'select', ...target(a), value: a.value });
    },
    async scroll(a) {
      return inPage(a.tab_id, { op: 'scroll', ...target(a), dy: a.dy });
    },
    async wait(a) {
      const start = Date.now(),
        end = start + Math.min(Number(a.timeout_ms ?? 10000), 120000);
      for (;;) {
        const t = await tabOf(a.tab_id);
        const r = await inPage(a.tab_id, {
          op: 'wait',
          text: a.text,
          gone_text: a.gone_text,
        }).catch(() => ({ ok: false }));
        const met = a.text
          ? r.has_text === true
          : a.gone_text
            ? r.has_gone === false
            : t.status === 'complete' && r.ready === 'complete';
        if (met || Date.now() >= end)
          return { ok: true, met, url: t.url, title: t.title, waited_ms: Date.now() - start };
        await sleep(250);
      }
    },
    async eval(a) {
      // CDP Runtime.evaluate runs in the page's main world and is not subject to the page's CSP.
      const r = await cdp(
        a.tab_id,
        'Runtime.evaluate',
        {
          expression: String(a.expression),
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
          timeout: Math.min(Number(a.timeout_ms) || 10000, 60000),
        },
        Math.min(Number(a.timeout_ms) || 10000, 60000) + 2000,
      );
      if (r.exceptionDetails)
        return {
          ok: false,
          error: 'exception',
          detail: String(
            (r.exceptionDetails.exception && r.exceptionDetails.exception.description) ||
              r.exceptionDetails.text,
          ).slice(0, 2000),
        };
      const v = r.result
        ? r.result.value !== undefined
          ? r.result.value
          : r.result.description
        : undefined;
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      if (s && s.length > 100000) return { ok: true, value: s.slice(0, 100000), truncated: true };
      return { ok: true, value: v === undefined ? null : v };
    },
    async close(a) {
      const t = await tabOf(a.tab_id);
      // Closing a profile's last tab closes its last window, and Chrome then shuts the whole profile
      // down, which disconnects this extension. Leave a blank tab behind instead.
      const wins = await chrome.windows.getAll({ windowTypes: ['normal'], populate: true });
      if (wins.length === 1 && wins[0].tabs.length === 1)
        await chrome.tabs.create({ windowId: t.windowId, url: 'about:blank', active: false });
      try {
        await cdp(a.tab_id, 'Page.enable');
      } catch (_) {}
      await Promise.race([
        chrome.tabs.remove(a.tab_id),
        sleep(8000).then(() => {
          throw new Error('close-timeout: the page would not unload');
        }),
      ]);
      detach(a.tab_id);
      return { ok: true };
    },
    async chatgpt(a) {
      // One call sends a message and waits for the reply, but returns within wait_ms (default 45 s) so no MCP client
      // times out: a long reply comes back as pending, and browser_chatgpt {tab} without text keeps waiting for it.
      const id = a.tab_id,
        end = Date.now() + Math.min(Number(a.wait_ms) || 45000, 300000);
      await waitReady(id, 15000);
      let s;
      for (;;) {
        s = await inPage(id, { op: 'cg_state' });
        if (s.composer || Date.now() > end - 1000) break;
        await sleep(300);
      }
      if (!s.composer)
        return {
          ok: false,
          error: 'no-chatgpt-composer',
          url: s.url,
          hint: 'signed out, or not a chat page',
        };
      const text = String(a.text || '');
      if (!text) {
        // read: wait for a running reply to finish, then return it
        const w = new ReplyWatch(s);
        while (!w.done(s)) {
          if (Date.now() > end)
            return {
              ok: true,
              pending: true,
              busy: s.busy,
              partial: s.reply,
              url: s.url,
              title: s.title,
            };
          await sleep(700);
          s = await inPage(id, { op: 'cg_state' }).catch(() => s);
        }
        return {
          ok: true,
          reply: s.reply,
          replies: s.replies,
          settled_by: w.by,
          url: s.url,
          title: s.title,
        };
      }
      const before = s;
      const f = await inPage(id, { op: 'cg_focus' });
      if (!f.ok) return f;
      if (f.had_text) {
        await cdpKey(id, 'a', [SELECT_ALL_MOD]);
        await cdpKey(id, 'Backspace');
      }
      await cdp(id, 'Input.insertText', { text });
      await sleep(150);
      await cdpKey(id, 'Enter');
      for (let i = 0; i < 20; i++) {
        // confirm the send landed; fall back to the send button once
        await sleep(250);
        s = await inPage(id, { op: 'cg_state' });
        if (s.users > before.users || s.busy || s.url !== before.url) break;
        if (i === 8) await inPage(id, { op: 'cg_send' });
      }
      if (!(s.users > before.users || s.busy || s.url !== before.url))
        return { ok: false, error: 'send-not-confirmed', url: s.url };
      if (a.wait === false) return { ok: true, sent: true, url: s.url, title: s.title };
      const w = new ReplyWatch(s, before.replies);
      while (Date.now() < end) {
        await sleep(700);
        s = await inPage(id, { op: 'cg_state' }).catch(() => s);
        if (w.done(s))
          return {
            ok: true,
            sent: true,
            url: s.url,
            title: s.title,
            reply: s.reply,
            settled_by: w.by,
          };
      }
      return {
        ok: true,
        sent: true,
        pending: true,
        busy: s.busy,
        partial: s.reply,
        url: s.url,
        hint: 'still answering: call browser_chatgpt with this tab and no text to wait for the reply',
      };
    },
    async upload(a) {
      const before = (await tabOf(a.tab_id)).url;
      const nonce = crypto.randomUUID();
      const loc = await inPage(a.tab_id, {
        op: 'fileinput',
        ref: a.ref,
        snapshot_id: a.snapshot_id,
        nonce,
        mime: a.mime,
        name: a.name,
        method: a.method === 'drop' ? 'drop' : 'input',
      });
      if (!loc.ok) return loc;
      const resp = await fetch(a.ticket_url, { cache: 'no-store', credentials: 'omit' });
      if (!resp.ok) return { ok: false, error: 'upload-ticket-' + resp.status };
      const bytes = new Uint8Array(await resp.arrayBuffer());
      if (bytes.length !== a.size) return { ok: false, error: 'upload-bytes-mismatch' };
      const CHUNK = 6 * 1024 * 1024;
      for (let i = 0, off = 0; off < bytes.length; i++, off += CHUNK) {
        const r = await inPage(a.tab_id, {
          op: 'filechunk',
          nonce,
          i,
          b64: toBase64(bytes.subarray(off, off + CHUNK)),
        });
        if (!r.ok) return r;
      }
      const done = await inPage(
        a.tab_id,
        { op: 'fileset', nonce, name: a.name, mime: a.mime, size: a.size },
        60000,
      );
      await settle(a.tab_id, before);
      return done;
    },
  };
  /**
   * Run one broker command. Never throws: a failure becomes `{ok: false, error}` so the broker always
   * gets exactly one result per command.
   * @param {{op: string, args?: object}} cmd - The command from the broker.
   * @returns {Promise<object>} The op's result.
   */
  async function execute(cmd) {
    const fn = OPS[cmd.op];
    if (!fn) return { ok: false, error: 'unknown-op ' + cmd.op };
    try {
      return await fn(cmd.args || {});
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 300) };
    }
  }

  // ---------------------------------------------------------------------------------------------
  // The native channel. Wire messages, all JSON objects with a `type`:
  //   worker -> broker: hello, result, event (tab-closed), hub, ping
  //   broker -> worker: welcome, command, hub_reply, error (from the native host)
  // ---------------------------------------------------------------------------------------------
  /** Post a message to the broker; silently dropped when the port is down (the broker never replays). */
  function send(msg) {
    try {
      if (port) port.postMessage(msg);
    } catch (_) {}
  }
  /** Show "A" on the toolbar icon while the broker link is up. */
  function badge() {
    chrome.action.setBadgeText({ text: port ? 'A' : '' }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: '#2e7d32' }).catch(() => {});
  }
  let connecting = null;
  /**
   * Open the native port if it is not open. Concurrent callers share one attempt, so alarm, startup
   * and popup wake-ups cannot open two ports.
   * @returns {Promise<void>} Resolves when the attempt is over (connected or scheduled to retry).
   */
  function connect() {
    if (port) return Promise.resolve();
    return (
      connecting ||
      (connecting = connectOnce().finally(() => {
        connecting = null;
      }))
    );
  }
  /**
   * Start the native host and say hello. A disconnect retries with exponential backoff (1 s to 30 s);
   * a `welcome` from the broker resets the backoff.
   */
  async function connectOnce() {
    const session = await browserSession();
    if (port) return;
    let p;
    try {
      p = chrome.runtime.connectNative(HOST);
    } catch (_) {
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
      return;
    }
    port = p;
    p.onMessage.addListener((msg) => {
      void onMessage(msg, p);
    });
    p.onDisconnect.addListener(() => {
      const why = chrome.runtime.lastError;
      diag('disconnect', why && why.message);
      if (port !== p) return;
      port = null;
      badge();
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
    });
    // The native host forwards this verbatim as the body of POST /v1/ext/attach. The broker keys the
    // connection on profile_label, scopes tab handles to browser_session, and compares `build` with
    // the build on disk at install_dir to decide whether to ask us to reload.
    p.postMessage({
      type: 'hello',
      profile_label: PROFILE,
      browser_session: session,
      version: VERSION,
      build: BUILD,
      install_dir: String(cfg.install_dir || ''),
      roles: ['agents'],
      browser: navigator.userAgent.slice(0, 120),
    });
  }
  /**
   * Handle one message from the broker. Messages from a port we have already replaced are ignored.
   * @param {{type: string}} msg - The message.
   * @param {chrome.runtime.Port} src - The port it arrived on.
   */
  async function onMessage(msg, src) {
    if (!msg || typeof msg !== 'object' || src !== port) return;
    if (msg.type === 'welcome') {
      backoff = 1000;
      badge();
      diag('welcome', 'reload=' + !!msg.reload);
      if (msg.reload) {
        // The on-disk build is newer than this one: reload into it, but at most every 20 s so a
        // build that never matches cannot cause a reload loop.
        const { alcorReloadAt = 0 } = await chrome.storage.local.get('alcorReloadAt');
        if (Date.now() - alcorReloadAt > 20000) {
          await chrome.storage.local.set({ alcorReloadAt: Date.now() });
          chrome.runtime.reload();
        }
      }
    } else if (msg.type === 'command') {
      send({ type: 'result', id: msg.id, result: await execute(msg) });
    } else if (msg.type === 'hub_reply') {
      const w = hubWaiters.get(msg.id);
      hubWaiters.delete(msg.id);
      if (w) w(msg.value && typeof msg.value === 'object' ? msg.value : {});
    } else if (msg.type === 'error') {
      diag('host-error', msg.error);
    }
  }
  chrome.tabs.onRemoved.addListener((tabId) => {
    detach(tabId);
    send({ type: 'event', name: 'tab-closed', tab_id: tabId });
  });

  // The hub (popup.html) asks the broker through this worker: status, update, restart. Reload is local.
  /**
   * Send a popup request to the broker and wait up to 5 s for its `hub_reply`.
   * @param {string} req - `status`, `update`, `update-check` or `restart`.
   * @returns {Promise<object>} `{connected: false}` when the port is down, `{connected: true,
   *   timeout: true}` when the broker did not answer, else `{connected: true, ...reply}`.
   */
  function askBroker(req) {
    if (!port) return Promise.resolve({ connected: false });
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        hubWaiters.delete(id);
        resolve({ connected: true, timeout: true });
      }, 5000);
      hubWaiters.set(id, (v) => {
        clearTimeout(timer);
        resolve({ connected: true, ...v });
      });
      send({ type: 'hub', id, req });
    });
  }
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (!msg || msg.kind !== 'hub' || sender.id !== chrome.runtime.id) return false;
    const local = { version: VERSION, build: BUILD.slice(0, 12), profile: PROFILE };
    if (msg.req === 'reload') {
      respond({ ok: true, ...local });
      setTimeout(() => chrome.runtime.reload(), 150);
      return false;
    }
    if (msg.req === 'connect') {
      void connect()
        .then(() => sleep(800))
        .then(() => askBroker('status'))
        .then((v) => respond({ ...v, ext: local }));
      return true;
    }
    void askBroker(String(msg.req || 'status')).then((v) => respond({ ...v, ext: local }));
    return true;
  });
  // Keep-alive: traffic on the port keeps the MV3 worker alive, and the broker uses the silence to notice a dead link.
  setInterval(() => send({ type: 'ping' }), 20000);
  // Chrome's minimum alarm period is 30 s, so a dropped port is retried at least that often.
  chrome.alarms.create('alcor-agents-wake', { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((al) => {
    if (al.name === 'alcor-agents-wake') void connect();
  });
  // Wake-up events. An extension update clears alarms, and Chrome starts the new worker only for an
  // event it has a listener for, so without onInstalled the updated worker could sit unstarted until
  // the next tab event.
  chrome.runtime.onStartup.addListener(() => {
    void connect();
  });
  chrome.runtime.onInstalled.addListener(() => {
    void connect();
  });
  void connect();
})();
