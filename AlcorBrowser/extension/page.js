/**
 * AlcorBrowser page side: the one function the worker injects into a tab.
 *
 * `alcorPage` is passed to `chrome.scripting.executeScript({func})`. Chrome serialises the function's
 * source text and runs it in the page's isolated world, so it must stay self-contained: no imports
 * and no worker globals. Element refs from a snapshot (`e12`, `f1`) live in that isolated world in
 * `globalThis.__alcorSnap`, out of reach of the page's own scripts. Refs are valid only for the
 * snapshot that issued them, so a stale ref fails loudly instead of hitting a different element.
 *
 * Two safety floors are enforced here, where the DOM is visible:
 * - a password field is never focused or typed into (`refused: 'password-field'`);
 * - a CAPTCHA frame is never clicked (`refused: 'captcha'`).
 * The floors guard a cooperative agent. They are not a sandbox: `browser_eval` runs arbitrary page
 * script and is outside them.
 *
 * Commands (`cmd.op`):
 * - `snapshot`, `locate`, `focus`, `value`, `active`, `domclick`, `domtype`, `select`, `scroll`,
 *   `wait`: read or act on page elements.
 * - `cg_state`, `cg_focus`, `cg_send`: read and drive the ChatGPT composer and reply.
 * - `fileinput`, `filechunk`, `fileset`: receive a file's bytes in chunks and set them on an input.
 *
 * @param {{op: string, [key: string]: any}} cmd - The command; other fields depend on `op`.
 * @returns {object} `{ok: true, ...}` on success, `{ok: false, error}` on failure, or
 *   `{ok: false, refused}` when a safety floor applied.
 */
function alcorPage(cmd) {
  const CAPTCHA =
    /recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha|captcha/i;
  const INTERACTIVE =
    'a[href],button,input:not([type=hidden]),textarea,select,summary,[role],[contenteditable=""],[contenteditable="true"],[tabindex]';
  const ROLES = new Set([
    'button',
    'link',
    'checkbox',
    'radio',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'switch',
    'textbox',
    'combobox',
    'searchbox',
    'slider',
    'spinbutton',
    'treeitem',
    'listbox',
  ]);
  const clean = (s) =>
    String(s || '')
      .replace(/\s+/g, ' ')
      .trim();
  const rect = (el) => el.getBoundingClientRect();
  const visible = (el) => {
    const r = rect(el);
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.02;
  };
  const byId = (el, id) => {
    const root = el.getRootNode();
    return (root.getElementById && root.getElementById(id)) || document.getElementById(id);
  };
  const password = (el) =>
    el && el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'password';
  function nameOf(el) {
    const tag = el.tagName;
    let n =
      el.getAttribute('aria-label') ||
      (el.getAttribute('aria-labelledby') || '')
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => byId(el, id)?.innerText || '')
        .join(' ');
    if (!n && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')) {
      if (el.labels && el.labels.length) n = [...el.labels].map((l) => l.innerText).join(' ');
      if (!n && ['submit', 'button', 'reset'].includes((el.type || '').toLowerCase())) n = el.value;
      if (!n) n = el.getAttribute('placeholder') || el.getAttribute('title') || el.name || '';
    }
    if (!n && tag === 'IMG') n = el.alt;
    if (!n && !el.isContentEditable) n = el.innerText || el.textContent;
    if (!n)
      n =
        el.getAttribute('title') ||
        el.getAttribute('placeholder') ||
        el.getAttribute('data-placeholder') ||
        (el.querySelector && el.querySelector('img[alt]')?.alt) ||
        '';
    return clean(n).slice(0, 80);
  }
  function roleOf(el) {
    const r = el.getAttribute('role');
    if (r) return r;
    const t = el.tagName;
    if (t === 'A') return 'link';
    if (t === 'BUTTON' || t === 'SUMMARY') return 'button';
    if (t === 'SELECT') return 'combobox';
    if (t === 'TEXTAREA' || el.isContentEditable) return 'textbox';
    if (t === 'INPUT') {
      const ty = (el.type || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(ty)) return 'button';
      if (ty === 'checkbox' || ty === 'radio') return ty;
      return ty === 'search' ? 'searchbox' : ty === 'range' ? 'slider' : 'textbox';
    }
    return t.toLowerCase();
  }
  const editable = (el) =>
    el.isContentEditable ||
    (!el.disabled &&
      !el.readOnly &&
      (el.tagName === 'TEXTAREA' ||
        (el.tagName === 'INPUT' &&
          ![
            'button',
            'submit',
            'reset',
            'image',
            'checkbox',
            'radio',
            'file',
            'range',
            'color',
            'hidden',
          ].includes((el.type || 'text').toLowerCase()))));
  const actionable = (el) =>
    el.closest(
      'button,a[href],[role=button],[role=link],[role=menuitem],[role=tab],[role=option],input[type=submit],input[type=button],summary,label',
    ) || el;
  const deepActive = () => {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  };
  const within = (outer, node) => {
    for (let n = node; n; n = n.parentNode || n.host) if (n === outer) return true;
    return false;
  };
  function deepAt(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }
  // A target is a CSS selector, or a ref from the latest snapshot. The snapshot id must match so an old
  // ref cannot silently land on whatever element now sits at the same position in a new snapshot.
  function resolve() {
    const snap = globalThis.__alcorSnap;
    if (cmd.selector) {
      const el = document.querySelector(cmd.selector);
      return el ? { el } : { error: 'no-match-for-selector' };
    }
    if (!snap || snap.id !== cmd.snapshot_id)
      return { error: 'stale-snapshot: take a new browser_snapshot' };
    const el = snap.refs.get(String(cmd.ref));
    return el && el.isConnected ? { el } : { error: 'stale-element: take a new browser_snapshot' };
  }
  const describe = (el) => (el ? roleOf(el) + ' "' + nameOf(el).slice(0, 60) + '"' : 'nothing');
  function allOf(sel) {
    const out = [];
    const walk = (root) => {
      out.push(...root.querySelectorAll(sel));
      const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      for (let n = w.nextNode(); n; n = w.nextNode()) if (n.shadowRoot) walk(n.shadowRoot);
    };
    walk(document);
    return out;
  }
  const accepts = (input, mime, name) => {
    const acc = String(input.accept || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (!acc.length) return true;
    const ext =
      '.' +
      String(name || '')
        .split('.')
        .pop()
        .toLowerCase();
    return acc.some(
      (a) =>
        a === ext || a === mime || (a.endsWith('/*') && String(mime).startsWith(a.slice(0, -1))),
    );
  };

  if (cmd.op === 'snapshot') {
    // One line per element, viewport only unless cmd.all: a ChatGPT page reads in ~40 lines, not 600 objects.
    const limit = Math.min(Math.max(Number(cmd.max_elements) || 150, 10), 1000);
    const textLimit = Math.min(Math.max(Number(cmd.text_limit ?? 3000), 0), 200000);
    const vw = innerWidth,
      vh = innerHeight,
      found = [],
      seen = new Set();
    let off = 0;
    const walk = (root) => {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      for (let n = w.nextNode(); n && found.length < limit; n = w.nextNode()) {
        if (n.shadowRoot) walk(n.shadowRoot);
        let take = false;
        if (n.matches(INTERACTIVE)) {
          const r = n.getAttribute('role');
          take =
            !r ||
            ROLES.has(r) ||
            /^(A|BUTTON|INPUT|TEXTAREA|SELECT)$/.test(n.tagName) ||
            n.isContentEditable;
          if (
            take &&
            n.hasAttribute('tabindex') &&
            !r &&
            !/^(A|BUTTON|INPUT|TEXTAREA|SELECT|SUMMARY)$/.test(n.tagName) &&
            !n.isContentEditable
          )
            take =
              Number(n.getAttribute('tabindex')) >= 0 && getComputedStyle(n).cursor === 'pointer';
        } else if (/^(DIV|SPAN|LI|IMG|P|H[1-6]|svg|LABEL)$/.test(n.tagName)) {
          take =
            getComputedStyle(n).cursor === 'pointer' &&
            !(n.parentElement && getComputedStyle(n.parentElement).cursor === 'pointer');
        }
        if (!take || seen.has(n) || !visible(n)) continue;
        const r = rect(n);
        if (!cmd.all && (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw)) {
          off++;
          continue;
        }
        seen.add(n);
        found.push(n);
      }
    };
    walk(document.documentElement);
    const refs = new Map(),
      lines = [],
      id = Math.random().toString(36).slice(2, 10);
    found.forEach((el, i) => {
      const ref = 'e' + (i + 1);
      refs.set(ref, el);
      let line = ref + ' ' + roleOf(el) + ' "' + nameOf(el) + '"';
      if (password(el)) line += ' password';
      else if (
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') &&
        el.value
      )
        line += ' =' + JSON.stringify(String(el.value).slice(0, 120));
      else if (el.isContentEditable && clean(el.innerText))
        line += ' =' + JSON.stringify(clean(el.innerText).slice(0, 120));
      if (el.checked || el.getAttribute('aria-checked') === 'true') line += ' [x]';
      if (el.getAttribute('aria-expanded'))
        line += el.getAttribute('aria-expanded') === 'true' ? ' open' : ' closed';
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') line += ' disabled';
      if (editable(el)) line += ' editable';
      if (el.tagName === 'A' && el.href) {
        const u = new URL(el.href, location.href);
        line +=
          ' -> ' + (u.origin === location.origin ? u.pathname + u.search : u.href).slice(0, 100);
      }
      if (cmd.all) {
        const r = rect(el);
        if (r.bottom < 0 || r.top > vh) line += ' offscreen';
      }
      lines.push(line);
    });
    const files = allOf('input[type=file]').slice(0, 10);
    files.forEach((el, i) => {
      refs.set('f' + (i + 1), el);
      lines.push('f' + (i + 1) + ' file-input accept=' + JSON.stringify(el.accept || '*'));
    });
    allOf('iframe')
      .filter((f) => visible(f) && CAPTCHA.test((f.src || '') + ' ' + (f.title || '')))
      .slice(0, 3)
      .forEach(() => lines.push('!! captcha frame present: hand it to the operator'));
    globalThis.__alcorSnap = { id, refs };
    const modal = [
      ...document.querySelectorAll(
        'dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]',
      ),
    ].find(visible);
    const text = textLimit ? clean(document.body ? document.body.innerText : '') : '';
    return {
      ok: true,
      snapshot_id: id,
      url: location.href,
      title: document.title,
      modal: modal ? nameOf(modal) || 'dialog' : undefined,
      elements: lines.join('\n'),
      offscreen: off || undefined,
      text: text ? text.slice(0, textLimit) : undefined,
      text_more: text.length > textLimit ? text.length - textLimit : undefined,
    };
  }

  if (cmd.op === 'locate') {
    let el;
    if (cmd.ref != null || cmd.selector) {
      const got = resolve();
      if (got.error) return { ok: false, error: got.error };
      el = got.el;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = rect(el);
      // Probe three points and accept the first where the element, or something inside, around or
      // labelling it, is what the browser would really hit. A click then lands where a person's would,
      // and a covering dialog or overlay is reported as "obscured" instead of clicking the overlay.
      for (const [x, y] of [
        [r.left + r.width / 2, r.top + r.height / 2],
        [r.left + Math.min(6, r.width / 2), r.top + r.height / 2],
        [r.left + r.width / 2, r.top + Math.min(5, r.height / 2)],
      ]) {
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        const h = deepAt(x, y);
        if (h && (within(el, h) || within(h, el) || (h.tagName === 'LABEL' && h.control === el))) {
          if (h.tagName === 'IFRAME' && CAPTCHA.test((h.src || '') + ' ' + (h.title || '')))
            return { ok: false, refused: 'captcha' };
          const a = deepActive();
          return {
            ok: true,
            x,
            y,
            label: nameOf(el),
            editable: editable(el),
            password: password(el),
            focused: !!a && (a === el || within(el, a)),
          };
        }
      }
      return {
        ok: false,
        error: 'obscured',
        covered_by: describe(deepAt(r.left + r.width / 2, r.top + r.height / 2)),
        hint: 'close the covering dialog or scroll, then snapshot again',
      };
    }
    if (typeof cmd.x !== 'number' || typeof cmd.y !== 'number')
      return { ok: false, error: 'need ref+snapshot_id, selector, or x,y' };
    el = deepAt(cmd.x, cmd.y);
    if (el && el.tagName === 'IFRAME' && CAPTCHA.test((el.src || '') + ' ' + (el.title || '')))
      return { ok: false, refused: 'captcha' };
    return { ok: true, x: cmd.x, y: cmd.y, label: el ? describe(actionable(el)) : '' };
  }

  if (cmd.op === 'focus') {
    const got = resolve();
    if (got.error) return { ok: false, error: got.error };
    const el = got.el;
    if (password(el)) return { ok: false, refused: 'password-field' };
    el.focus();
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const n = el.value.length;
      if (cmd.clear) el.select();
      else el.setSelectionRange && el.setSelectionRange(n, n);
    } else if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      if (!cmd.clear) range.collapse(false);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    // Check again after focusing: a page script can redirect focus to a password field.
    const a = deepActive();
    if (password(a)) return { ok: false, refused: 'password-field' };
    const ok = !!a && (a === el || within(el, a));
    return ok
      ? { ok, had_text: !!clean(el.value ?? el.innerText) }
      : { ok, error: 'focus-redirected' };
  }

  if (cmd.op === 'value') {
    const got = resolve();
    if (got.error) return { ok: false, error: got.error };
    return {
      ok: true,
      value: String(
        got.el.isContentEditable ? got.el.innerText : (got.el.value ?? got.el.innerText),
      ).slice(0, 1000),
    };
  }

  // Asked before a key press, so a character cannot be typed into a password field one key at a time.
  if (cmd.op === 'active') return { ok: true, password: password(deepActive()) };

  if (cmd.op === 'domclick') {
    let el;
    if (cmd.ref != null || cmd.selector) {
      const got = resolve();
      if (got.error) return { ok: false, error: got.error };
      el = got.el;
    } else el = deepAt(cmd.x, cmd.y);
    if (!el) return { ok: false, error: 'nothing-to-click' };
    actionable(el).click();
    return { ok: true };
  }

  if (cmd.op === 'domtype') {
    const got = resolve();
    if (got.error) return { ok: false, error: got.error };
    const el = got.el;
    if (password(el)) return { ok: false, refused: 'password-field' };
    el.focus();
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      // The prototype's setter bypasses the value tracker that React-style frameworks install on the
      // element, so the following input event is seen as a real change.
      const proto =
        el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(
        el,
        (cmd.clear ? '' : el.value) + cmd.text,
      );
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      if (cmd.clear) el.textContent = '';
      el.textContent += cmd.text;
      el.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: cmd.text }),
      );
    }
    return { ok: true };
  }

  if (cmd.op === 'select') {
    const got = resolve();
    if (got.error) return { ok: false, error: got.error };
    const el = got.el;
    if (el.tagName !== 'SELECT')
      return { ok: false, error: 'not-a-select', hint: 'click the control, then click the option' };
    const want = clean(cmd.value);
    const opt =
      [...el.options].find((o) => o.value === cmd.value) ||
      [...el.options].find((o) => clean(o.text) === want) ||
      [...el.options].find((o) => clean(o.text).toLowerCase().includes(want.toLowerCase()));
    if (!opt)
      return {
        ok: false,
        error: 'no-such-option',
        options: [...el.options].slice(0, 30).map((o) => clean(o.text).slice(0, 60)),
      };
    el.focus();
    el.value = opt.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, selected: clean(opt.text).slice(0, 80) };
  }

  if (cmd.op === 'scroll') {
    if (cmd.ref != null || cmd.selector) {
      const got = resolve();
      if (got.error) return { ok: false, error: got.error };
      got.el.scrollIntoView({ block: 'center', behavior: 'instant' });
    } else {
      const dy = Math.max(-20000, Math.min(20000, Number(cmd.dy) || 0)),
        before = scrollY;
      scrollBy(0, dy);
      if (scrollY === before && dy) {
        // the page does not scroll: scroll its largest scrollable region
        const box = [...document.querySelectorAll('main,[role=main],div,section')]
          .filter(
            (n) =>
              n.scrollHeight > n.clientHeight + 20 &&
              /auto|scroll/.test(getComputedStyle(n).overflowY),
          )
          .sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth)[0];
        if (box) box.scrollBy(0, dy);
      }
    }
    return {
      ok: true,
      scroll_y: Math.round(scrollY),
      page_h: document.documentElement.scrollHeight,
    };
  }

  if (cmd.op === 'wait') {
    const body = document.body ? document.body.innerText : '';
    return {
      ok: true,
      ready: document.readyState,
      has_text: cmd.text ? body.includes(cmd.text) : undefined,
      has_gone: cmd.gone_text ? body.includes(cmd.gone_text) : undefined,
    };
  }

  // ChatGPT: composer, streaming state and the last assistant reply, read from the live DOM. Every selector
  // is a list because ChatGPT's markup changes without notice: the composer once lost its #prompt-textarea
  // id and became a contenteditable DIV labelled "Ask ChatGPT".
  const COMPOSER =
    '#prompt-textarea,div[contenteditable="true"][aria-label*="ChatGPT" i],.ProseMirror[contenteditable="true"],form textarea';
  const STOP = '[data-testid="stop-button"],button[aria-label*="Stop" i]';
  if (cmd.op === 'cg_state') {
    // Turns: the older data-message-author-role bubbles, or a newer h4 data-conversation-role heading
    // ("ChatGPT said:") whose parent holds the message.
    const turns = (role) => [
      ...document.querySelectorAll(
        `[data-message-author-role="${role}"],[data-conversation-role="${role}"]`,
      ),
    ];
    const textOf = (el) =>
      (el.hasAttribute('data-conversation-role') ? el.parentElement.innerText : el.innerText)
        .replace(/^\s*(ChatGPT|You)( said:)?(\s|$)/, '')
        .trim(); // a turn not yet streaming reads just "ChatGPT"
    const comp = document.querySelector(COMPOSER),
      replies = turns('assistant'),
      users = turns('user');
    const last = replies[replies.length - 1];
    const streaming =
      !!document.querySelector(STOP) ||
      !!document.querySelector('[data-talvt-turn-state]:not([data-talvt-turn-state="complete"])');
    return {
      ok: true,
      composer: !!comp,
      busy: streaming,
      replies: replies.length,
      users: users.length,
      reply: last ? textOf(last) : '',
      url: location.href,
      title: document.title,
    };
  }
  if (cmd.op === 'cg_focus') {
    const comp = document.querySelector(COMPOSER);
    if (!comp) return { ok: false, error: 'no-composer' };
    comp.focus();
    const range = document.createRange();
    range.selectNodeContents(comp);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return { ok: true, had_text: !!clean(comp.innerText || comp.value) };
  }
  if (cmd.op === 'cg_send') {
    const btn = document.querySelector(
      '[data-testid="send-button"],#composer-submit-button,button[aria-label*="Send" i]',
    );
    if (!btn || btn.disabled) return { ok: false, error: 'no-send-button' };
    btn.click();
    return { ok: true };
  }

  // Upload: pick the input, receive the bytes in chunks, set them as the input's file.
  if (cmd.op === 'fileinput') {
    let cands;
    if (cmd.ref != null) {
      const got = resolve();
      if (got.error) return { ok: false, error: got.error };
      const el = got.el;
      if (el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'file') cands = [el];
      else {
        cands = [];
        for (let n = el, i = 0; n && i < 7 && !cands.length; n = n.parentElement, i++)
          cands = [...n.querySelectorAll('input[type=file]')];
      }
    } else cands = allOf('input[type=file]');
    let fits = cands.filter((i) => !i.disabled && accepts(i, cmd.mime, cmd.name));
    if (fits.length > 1 && cmd.ref == null) {
      const ex = fits.filter((i) => String(i.accept || '').trim());
      if (ex.length === 1) fits = ex;
    }
    if (!fits.length)
      return {
        ok: false,
        error: 'no-file-input',
        hint: 'open the upload page, or pass the upload button ref',
      };
    if (fits.length > 1 && cmd.ref == null)
      return {
        ok: false,
        error: 'ambiguous-file-inputs',
        hint: 'pass one of the snapshot fN refs',
      };
    let zone = null;
    if (cmd.method === 'drop') {
      if (cmd.ref != null) {
        const got = resolve();
        if (!got.error && got.el !== fits[0]) zone = got.el;
      }
      for (let n = fits[0].parentElement; !zone && n; n = n.parentElement) if (visible(n)) zone = n;
      if (!zone) return { ok: false, error: 'no-drop-zone' };
    }
    globalThis.__alcorUpload = { nonce: cmd.nonce, input: fits[0], zone, parts: [] };
    return { ok: true, accept: fits[0].accept || '' };
  }
  if (cmd.op === 'filechunk') {
    const up = globalThis.__alcorUpload;
    if (!up || up.nonce !== cmd.nonce) return { ok: false, error: 'upload-state-lost' };
    const bin = atob(cmd.b64),
      arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    up.parts[cmd.i] = arr;
    return { ok: true };
  }
  if (cmd.op === 'fileset') {
    const up = globalThis.__alcorUpload;
    globalThis.__alcorUpload = null;
    if (!up || up.nonce !== cmd.nonce || !up.input.isConnected)
      return { ok: false, error: 'upload-state-lost' };
    const file = new File(up.parts, cmd.name, { type: cmd.mime, lastModified: Date.now() });
    if (file.size !== cmd.size) return { ok: false, error: 'upload-size-mismatch' };
    const dt = new DataTransfer();
    dt.items.add(file);
    if (up.zone) {
      // uploaders that ignore a change event on their hidden input take only a drop
      let handled = false;
      for (const type of ['dragenter', 'dragover', 'drop']) {
        const ev = new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          dataTransfer: dt,
        });
        up.zone.dispatchEvent(ev);
        if (type === 'drop') handled = ev.defaultPrevented;
      }
      return { ok: true, method: 'drop', drop_handled: handled };
    }
    up.input.files = dt.files;
    up.input.dispatchEvent(new Event('input', { bubbles: true }));
    up.input.dispatchEvent(new Event('change', { bubbles: true }));
    const got = up.input.files && up.input.files[0];
    return { ok: !!got && got.size === cmd.size, method: 'input' };
  }
  return { ok: false, error: 'unknown page op' };
}
