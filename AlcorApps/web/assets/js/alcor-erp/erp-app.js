/*
 * AlcorERP browser app. One connected record graph: customers, quotes, orders,
 * projects, stock and invoices. Data lives in this browser's IndexedDB only.
 * No network requests, no account, no server.
 */
(function () {
  'use strict';
  const C = window.AlcorERPCore;
  const root = document.querySelector('[data-alcor-erp-app]');
  if (!root || !C) return;

  const store = C.createStore();
  const S = {
    data: null,
    idx: null,
    loadError: '',
    saveError: '',
    undoToken: null,
    tables: {},
    dialogReturn: '',
  };

  /* ---------- DOM helpers ---------- */
  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs)
      Object.keys(attrs).forEach((k) => {
        const v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function')
          el.addEventListener(k.slice(2), v);
        else if (k === 'value' && (tag === 'textarea' || tag === 'select')) el.dataset.initial = v;
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
      });
    append(el, Array.prototype.slice.call(arguments, 2));
    if (tag === 'textarea' && el.dataset.initial != null) {
      el.value = el.dataset.initial;
      delete el.dataset.initial;
    }
    if (tag === 'select' && el.dataset.initial != null) {
      el.value = el.dataset.initial;
      delete el.dataset.initial;
    }
    return el;
  }
  function append(el, kids) {
    kids.forEach((k) => {
      if (k == null || k === false) return;
      if (Array.isArray(k)) append(el, k);
      else el.append(k.nodeType ? k : document.createTextNode(String(k)));
    });
  }
  const vh = (text) => h('span', { class: 'aerp-vh' }, text);
  let seq = 0;
  const nextId = (p) => 'aerp-' + p + '-' + ++seq;

  /* ---------- formatting ---------- */
  const money = (c) => C.formatMoney(c, S.data ? S.data.settings.currency : 'USD');
  const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
  function fmtDate(iso) {
    if (!C.isDate(iso)) return '\u2014';
    const [y, m, d] = iso.split('-').map(Number);
    return dateFmt.format(new Date(y, m - 1, d));
  }
  const monthName = () => new Intl.DateTimeFormat(undefined, { month: 'long' }).format(new Date());
  const qtyInput = (q) => String(Math.round((Number(q) || 0) * 1000) / 1000);
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');
  const STATUS_LABEL = {
    draft: 'Draft',
    sent: 'Sent',
    accepted: 'Accepted',
    declined: 'Declined',
    converted: 'Ordered',
    open: 'Open',
    fulfilled: 'Fulfilled',
    cancelled: 'Cancelled',
    planned: 'Planned',
    active: 'Active',
    'on-hold': 'On hold',
    done: 'Done',
    paid: 'Paid',
    overdue: 'Overdue',
    low: 'Low stock',
  };
  const badge = (status) =>
    h(
      'span',
      { class: 'aerp-badge aerp-badge--' + status, 'data-status': status },
      STATUS_LABEL[status] || status,
    );

  /* ---------- lookups ---------- */
  const get = (table, id) => (S.idx ? S.idx.get(table, id) : null);
  const customerName = (id) => {
    const c = get('customers', id);
    return c ? c.name : 'Deleted customer';
  };
  const invStatus = (inv) => C.invoiceStatus(inv);
  const docTitle = { quotes: 'Quote', orders: 'Order', invoices: 'Invoice', projects: 'Project' };
  function recordLabel(table, r) {
    if (!r) return 'Deleted record';
    if (table === 'customers') return r.name;
    if (table === 'items') return r.sku + ' \u00b7 ' + r.name;
    if (table === 'projects') return r.number + ' \u00b7 ' + r.name;
    return docTitle[table] + ' ' + r.number;
  }
  const MOD_OF = {
    customers: 'customers',
    items: 'inventory',
    quotes: 'quotes',
    orders: 'orders',
    projects: 'projects',
    invoices: 'invoices',
  };
  const href = (table, id) => '#/' + MOD_OF[table] + '/' + encodeURIComponent(id);
  const recLink = (table, r, text) =>
    r
      ? h(
          'a',
          { href: href(table, r.id), 'data-fk': 'link:' + r.id },
          text || recordLabel(table, r),
        )
      : h('span', { class: 'aerp-muted' }, 'Deleted record');
  function invoicesForOrder(o) {
    return S.data.invoices.filter(
      (i) => i.orderId === o.id || (o.projectId && i.projectId === o.projectId),
    );
  }

  /* ---------- chrome ---------- */
  const MODULES = [
    ['dashboard', 'Dashboard'],
    ['customers', 'Customers'],
    ['quotes', 'Quotes'],
    ['orders', 'Orders'],
    ['projects', 'Projects'],
    ['inventory', 'Inventory'],
    ['invoices', 'Invoices'],
    ['settings', 'Settings & data'],
  ];
  root.textContent = '';
  const companyEl = h('span', { class: 'aerp-company' });
  const saveEl = h('span', { class: 'aerp-save', 'data-save-state': '' });
  // The shared product header above (apx-bar) is the page's one banner and carries the AlcorERP wordmark,
  // so this is a slim status strip: the open company and the save state, no second logo, no second landmark.
  const bar = h(
    'div',
    { class: 'aerp-bar' },
    h('h1', { class: 'aerp-vh' }, 'AlcorERP'),
    companyEl,
    saveEl,
  );
  const navList = h('ul', { class: 'aerp-nav-list' });
  MODULES.forEach(([key, label]) =>
    navList.append(h('li', null, h('a', { href: '#/' + key, 'data-nav': key }, label))),
  );
  const nav = h(
    'nav',
    { class: 'aerp-nav', 'aria-label': 'AlcorERP modules' },
    navList,
    h(
      'p',
      { class: 'aerp-nav-hint' },
      'Keys: ',
      h('kbd', null, '/'),
      ' search, ',
      h('kbd', null, 'N'),
      ' new record',
    ),
  );
  const viewEl = h('main', { class: 'aerp-view', id: 'aerp-view', tabindex: '-1' });
  const toastsEl = h('div', { class: 'aerp-toasts', role: 'status', 'aria-live': 'polite' });
  const dlg = h('dialog', { class: 'aerp-dialog', 'aria-labelledby': 'aerp-dialog-title' });
  root.append(bar, h('div', { class: 'aerp-layout' }, nav, viewEl), toastsEl, dlg);

  function updateChrome(route) {
    const has = !!S.data;
    root.classList.toggle('is-welcome', !has);
    root.classList.toggle('is-print', has && route.mod === 'invoices' && route.sub === 'print');
    nav.hidden = !has;
    companyEl.textContent = has ? S.data.settings.companyName || 'Your company' : '';
    let state = 'none',
      text = '';
    if (has && S.saveError) {
      state = 'error';
      text = 'Not saved';
    } else if (has && store.mode === 'memory') {
      state = 'memory';
      text = 'Not saved: storage blocked';
    } else if (has) {
      state = 'saved';
      text = 'Saved in this browser';
    }
    saveEl.dataset.saveState = state;
    saveEl.textContent = text;
    saveEl.title =
      state === 'saved'
        ? 'Stored on this device only. Export a backup from Settings & data.'
        : S.saveError ||
          'This browser is not letting AlcorERP store data. Export a backup before you close the tab.';
    navList.querySelectorAll('a').forEach((a) => {
      if (a.dataset.nav === route.mod) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  /* ---------- toasts, dialogs ---------- */
  function toast(message, action, kind) {
    const t = h(
      'div',
      { class: 'aerp-toast' + (kind ? ' aerp-toast--' + kind : '') },
      h('span', null, message),
    );
    if (action)
      t.append(
        h(
          'button',
          {
            type: 'button',
            class: 'aerp-toast-btn',
            'data-action': 'undo',
            onclick: () => {
              t.remove();
              action.fn();
            },
          },
          action.label,
        ),
      );
    t.append(
      h(
        'button',
        {
          type: 'button',
          class: 'aerp-toast-x',
          'aria-label': 'Dismiss message',
          onclick: () => t.remove(),
        },
        '\u00d7',
      ),
    );
    toastsEl.append(t);
    while (toastsEl.children.length > 3) toastsEl.firstChild.remove();
    setTimeout(() => t.remove(), action ? 12000 : 6000);
  }
  function openDialog(title, content, wide) {
    const active = document.activeElement;
    if (!dlg.open)
      S.dialogReturn =
        active && active !== document.body ? active.getAttribute('data-fk') || active.id || '' : '';
    dlg.classList.toggle('aerp-dialog--wide', !!wide);
    dlg.replaceChildren(
      h(
        'div',
        { class: 'aerp-dialog-head' },
        h('h2', { id: 'aerp-dialog-title' }, title),
        h(
          'button',
          { type: 'button', class: 'aerp-icon-btn', 'aria-label': 'Close', onclick: closeDialog },
          '\u00d7',
        ),
      ),
      content,
    );
    if (!dlg.open) {
      if (typeof dlg.showModal === 'function') dlg.showModal();
      else dlg.setAttribute('open', '');
    }
    const first =
      dlg.querySelector('input:not([type=hidden]):not([type=file]),select,textarea') ||
      dlg.querySelector('.aerp-dialog-body button, .aerp-form-actions button');
    if (first) first.focus();
  }
  function closeDialog() {
    if (dlg.open) {
      if (typeof dlg.close === 'function') dlg.close();
      else {
        dlg.removeAttribute('open');
        dlg.dispatchEvent(new Event('close'));
      }
    }
  }
  dlg.addEventListener('close', () => {
    const fk = S.dialogReturn;
    S.dialogReturn = '';
    setTimeout(() => {
      if (dlg.open) return;
      const el =
        fk &&
        (root.querySelector('[data-fk="' + cssEscape(fk) + '"]') || document.getElementById(fk));
      if (el && document.activeElement === document.body) el.focus();
    }, 0);
  });
  function cssEscape(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
  }
  function confirmDialog(o) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        closeDialog();
        resolve(v);
      };
      const body = h(
        'div',
        { class: 'aerp-dialog-body' },
        h('p', null, o.message),
        h(
          'div',
          { class: 'aerp-form-actions' },
          h(
            'button',
            {
              type: 'button',
              class: 'aerp-btn',
              'data-action': 'cancel',
              onclick: () => finish(false),
            },
            'Cancel',
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'aerp-btn ' + (o.danger ? 'aerp-btn--danger' : 'aerp-btn--primary'),
              'data-action': 'confirm',
              onclick: () => finish(true),
            },
            o.confirm,
          ),
        ),
      );
      openDialog(o.title, body);
      dlg.addEventListener('close', () => finish(false), { once: true });
    });
  }
  function btn(label, action, onclick, opts) {
    opts = opts || {};
    return h(
      'button',
      {
        type: 'button',
        class: 'aerp-btn' + (opts.kind ? ' aerp-btn--' + opts.kind : ''),
        'data-action': action,
        'data-fk': action + (opts.id ? ':' + opts.id : ''),
        onclick,
        disabled: opts.disabled,
        title: opts.title,
      },
      label,
    );
  }

  /* ---------- state changes ---------- */
  async function persist(doc) {
    S.data = doc;
    S.idx = C.buildIndex(doc);
    try {
      await store.save(doc);
      S.saveError = '';
    } catch (e) {
      S.saveError = 'This browser did not save the last change. Export a backup to keep your work.';
    }
  }
  async function commit(fn, opts) {
    const draft = C.clone(S.data);
    let result;
    try {
      result = fn(draft);
    } catch (e) {
      if (!(opts && opts.quiet)) toast(e.message, null, 'error');
      return { error: e.message };
    }
    draft.rev = (S.data.rev || 0) + 1;
    await persist(draft);
    S.undoToken = null;
    if (!(opts && opts.noRender)) render(false);
    return { result };
  }
  async function act(fn, message, undoable) {
    const before = C.clone(S.data);
    const r = await commit(fn);
    if (r.error || !message) return r;
    if (!undoable) {
      toast(message);
      return r;
    }
    const token = {};
    S.undoToken = token;
    toast(message, {
      label: 'Undo',
      fn: async () => {
        if (S.undoToken !== token) {
          toast('Undo is no longer available: something changed after that.');
          return;
        }
        before.rev = (S.data.rev || 0) + 1;
        await persist(before);
        S.undoToken = null;
        render(false);
        toast('Undone.');
      },
    });
    return r;
  }
  async function deleteRecord(table, rec, back) {
    const blockers = C.deleteBlockers(S.data, table, rec.id);
    if (blockers.length) {
      toast(blockers.join(' '), null, 'error');
      return;
    }
    const label = recordLabel(table, rec);
    const r = await act((d) => C.removeRecord(d, table, rec.id), label + ' deleted.', true);
    if (!r.error) go(back);
  }

  /* ---------- routing ---------- */
  function parseRoute() {
    const parts = location.hash
      .replace(/^#\/?/, '')
      .split('/')
      .filter(Boolean)
      .map((p) => {
        try {
          return decodeURIComponent(p);
        } catch (e) {
          return p;
        }
      });
    const mod = MODULES.some((m) => m[0] === parts[0]) ? parts[0] : 'dashboard';
    return { mod, id: parts[1] || '', sub: parts[2] || '' };
  }
  function go(path) {
    const target = '#/' + path;
    if (location.hash === target) render(true);
    else location.hash = target;
  }
  function render(moveFocus) {
    const route = parseRoute();
    const active = document.activeElement;
    const fk =
      !moveFocus && active && active !== document.body && root.contains(active)
        ? active.getAttribute('data-fk') || active.id || ''
        : '';
    updateChrome(route);
    let view,
      title = 'AlcorERP';
    try {
      if (S.loadError) {
        view = recoveryView();
        title = 'Stored data needs attention';
      } else if (!S.data) {
        view = welcomeView();
        title = 'Set up AlcorERP';
      } else {
        const out = VIEWS[route.mod](route);
        view = out.view;
        title = out.title;
      }
    } catch (e) {
      console.error(e);
      view = h(
        'section',
        { class: 'aerp-panel' },
        h('h2', null, 'This view could not be shown'),
        h('p', null, e.message),
        h('p', null, h('a', { href: '#/dashboard' }, 'Back to the dashboard')),
      );
    }
    document.title = /AlcorERP/.test(title)
      ? 'AlcorERP App | Alcor Industries'
      : title + ' \u00b7 AlcorERP | Alcor Industries';
    viewEl.replaceChildren(view);
    if (moveFocus) {
      const head = viewEl.querySelector('h2');
      if (head) {
        head.tabIndex = -1;
        head.focus({ preventScroll: true });
      }
      window.scrollTo(0, 0);
    } else if (fk) {
      const el =
        root.querySelector('[data-fk="' + cssEscape(fk) + '"]') || document.getElementById(fk);
      if (el) el.focus({ preventScroll: true });
    }
  }

  /* ---------- tables: search, sort, collapse to cards ---------- */
  function norm(s) {
    return String(s == null ? '' : s).toLowerCase();
  }
  function dataTable(cfg) {
    const st =
      S.tables[cfg.key] ||
      (S.tables[cfg.key] = { q: '', sort: cfg.sort || cfg.columns[0].key, dir: cfg.dir || 1 });
    const searchId = nextId('search');
    const countEl = h('p', { class: 'aerp-count', 'aria-live': 'polite' });
    const tbody = h('tbody');
    const head = h('tr');
    const table = h(
      'table',
      { class: 'aerp-table' },
      h('caption', { class: 'aerp-vh' }, cfg.caption),
      h('thead', null, head),
      tbody,
    );
    function paintHead() {
      head.replaceChildren();
      cfg.columns.forEach((col) => {
        const sorted = st.sort === col.key;
        const th = h(
          'th',
          {
            scope: 'col',
            class: col.num ? 'is-num' : '',
            'aria-sort': sorted ? (st.dir > 0 ? 'ascending' : 'descending') : null,
          },
          h(
            'button',
            {
              type: 'button',
              class: 'aerp-sort',
              'data-fk': cfg.key + ':sort:' + col.key,
              onclick: () => {
                if (st.sort === col.key) st.dir = -st.dir;
                else {
                  st.sort = col.key;
                  st.dir = col.num ? -1 : 1;
                }
                paintHead();
                paintBody();
              },
            },
            col.label,
            h(
              'span',
              { class: 'aerp-sort-icon', 'aria-hidden': 'true' },
              sorted ? (st.dir > 0 ? '\u2191' : '\u2193') : '\u2195',
            ),
          ),
        );
        head.append(th);
      });
    }
    function paintBody() {
      const terms = norm(st.q).split(/\s+/).filter(Boolean);
      let rows = cfg.rows.filter((r) => {
        const text = norm(cfg.search(r));
        return terms.every((t) => text.includes(t));
      });
      const col = cfg.columns.find((c) => c.key === st.sort) || cfg.columns[0];
      rows = rows.slice().sort((a, b) => {
        const x = col.value(a),
          y = col.value(b);
        const r =
          typeof x === 'number' && typeof y === 'number'
            ? x - y
            : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' });
        return r * st.dir;
      });
      tbody.replaceChildren();
      rows.forEach((r) => {
        const tr = h('tr', { 'data-id': r.id });
        cfg.columns.forEach((c, i) => {
          let content = c.render ? c.render(r) : c.value(r);
          if (i === 0 && cfg.link)
            content = h(
              'a',
              { href: cfg.link(r), class: 'aerp-row-link', 'data-fk': 'row:' + r.id },
              content,
            );
          tr.append(h('td', { 'data-label': c.label, class: c.num ? 'is-num' : '' }, content));
        });
        if (cfg.link)
          tr.addEventListener('click', (ev) => {
            if (ev.target.closest('a,button,input,select,label')) return;
            location.hash = cfg.link(r);
          });
        tbody.append(tr);
      });
      countEl.textContent = terms.length
        ? plural(rows.length, 'match', 'matches') + ' of ' + cfg.rows.length
        : plural(cfg.rows.length, cfg.noun, cfg.nouns);
      if (!rows.length)
        tbody.append(
          h(
            'tr',
            { class: 'aerp-nomatch' },
            h(
              'td',
              { colspan: cfg.columns.length },
              'Nothing matches \u201c' + st.q + '\u201d. Try fewer words.',
            ),
          ),
        );
    }
    tbody.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
      const links = Array.from(tbody.querySelectorAll('.aerp-row-link'));
      const i = links.indexOf(document.activeElement);
      if (i < 0) return;
      ev.preventDefault();
      const n =
        links[Math.max(0, Math.min(links.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)))];
      if (n) n.focus();
    });
    const search = h('input', {
      type: 'search',
      id: searchId,
      class: 'aerp-search',
      value: st.q,
      autocomplete: 'off',
      placeholder: cfg.placeholder || 'Search',
      'data-fk': cfg.key + ':search',
      oninput: (ev) => {
        st.q = ev.target.value;
        paintBody();
      },
    });
    paintHead();
    paintBody();
    return h(
      'div',
      { class: 'aerp-tablebox' },
      h(
        'div',
        { class: 'aerp-tabletools' },
        h(
          'label',
          { class: 'aerp-search-label', for: searchId },
          'Search ' + cfg.caption.toLowerCase(),
        ),
        search,
        countEl,
      ),
      h('div', { class: 'aerp-tablewrap' }, table),
    );
  }

  /* ---------- forms ---------- */
  function field(f, value) {
    const id = nextId('f');
    const errId = id + '-err';
    const helpId = f.help ? id + '-help' : null;
    let control;
    const common = {
      id,
      name: f.name,
      'aria-describedby': [helpId, errId].filter(Boolean).join(' '),
      required: f.required,
      'aria-required': f.required ? 'true' : null,
    };
    if (f.type === 'textarea')
      control = h(
        'textarea',
        Object.assign(common, { rows: f.rows || 3, value: value == null ? '' : value }),
      );
    else if (f.type === 'select') {
      control = h(
        'select',
        Object.assign(common, { value: value == null ? '' : value }),
        (f.options || []).map((o) => h('option', { value: o[0] }, o[1])),
      );
    } else {
      const t =
        f.type === 'email'
          ? 'email'
          : f.type === 'tel'
            ? 'tel'
            : f.type === 'date'
              ? 'date'
              : 'text';
      const decimal = ['money', 'qty', 'percent', 'number'].includes(f.type);
      control = h(
        'input',
        Object.assign(common, {
          type: t,
          value: value == null ? '' : value,
          inputmode: decimal ? 'decimal' : null,
          autocomplete: f.autocomplete || 'off',
          maxlength: f.max && !decimal ? f.max : null,
          placeholder: f.placeholder,
        }),
      );
    }
    return h(
      'div',
      { class: 'aerp-field' + (f.wide ? ' aerp-field--wide' : '') },
      h(
        'label',
        { for: id },
        f.label,
        f.required ? null : h('span', { class: 'aerp-optional' }, ' (optional)'),
      ),
      control,
      f.help ? h('p', { class: 'aerp-help', id: helpId }, f.help) : null,
      h('p', { class: 'aerp-error', id: errId, hidden: true }),
    );
  }
  function setError(el, msg) {
    const err = document.getElementById(el.id + '-err');
    if (msg) el.setAttribute('aria-invalid', 'true');
    else el.removeAttribute('aria-invalid');
    if (err) {
      err.textContent = msg || '';
      err.hidden = !msg;
    }
  }
  function readForm(form, specs) {
    const out = {};
    let first = null;
    specs.forEach((f) => {
      const el = form.elements[f.name];
      if (!el) return;
      const raw = String(el.value || '').trim();
      let v = raw,
        err = '';
      const numeric = ['money', 'qty', 'percent', 'number'].includes(f.type);
      if (raw === '') {
        if (f.required) err = f.label + ' is required.';
        v = numeric ? (f.empty != null ? f.empty : 0) : '';
      } else if (f.type === 'email') {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw))
          err = 'Enter an email address like name@example.com.';
      } else if (f.type === 'money') {
        v = C.parseMoney(raw);
        if (Number.isNaN(v)) err = 'Enter an amount like 125.00.';
        else if (f.min != null && v < f.min) err = 'Enter ' + C.moneyInput(f.min) + ' or more.';
        else if (f.maxMoney != null && v > f.maxMoney)
          err = 'Enter ' + C.moneyInput(f.maxMoney) + ' or less.';
      } else if (numeric) {
        v = C.parseQty(raw);
        if (Number.isNaN(v)) err = 'Enter a number.';
        else if (f.integer && !Number.isInteger(v)) err = 'Enter a whole number.';
        else if (f.min != null && v < f.min) err = 'Enter ' + f.min + ' or more.';
        else if (f.gt != null && v <= f.gt) err = 'Enter more than ' + f.gt + '.';
        else if (f.maxNum != null && v > f.maxNum) err = 'Enter ' + f.maxNum + ' or less.';
      } else if (f.type === 'date') {
        if (!C.isDate(raw)) err = 'Enter a date.';
      }
      if (!err && f.check) err = f.check(v, out) || '';
      setError(el, err);
      if (err && !first) first = el;
      out[f.name] = v;
    });
    if (first) {
      first.focus();
      return null;
    }
    return out;
  }
  function formShell(specs, values, submitLabel, onSubmit, extra) {
    const errBox = h('p', { class: 'aerp-form-error', role: 'alert', hidden: true });
    const form = h(
      'form',
      { class: 'aerp-form', novalidate: true },
      h(
        'div',
        { class: 'aerp-grid-form' },
        specs.map((f) => field(f, values[f.name])),
      ),
      extra || null,
      errBox,
      h(
        'div',
        { class: 'aerp-form-actions' },
        h('button', { type: 'button', class: 'aerp-btn', onclick: closeDialog }, 'Cancel'),
        h(
          'button',
          { type: 'submit', class: 'aerp-btn aerp-btn--primary', 'data-action': 'save' },
          submitLabel,
        ),
      ),
    );
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      errBox.hidden = true;
      const v = readForm(form, specs);
      if (!v) return;
      const msg = await onSubmit(v, form);
      if (msg) {
        errBox.textContent = msg;
        errBox.hidden = false;
      }
    });
    return form;
  }
  const customerOptions = () =>
    [['', 'Choose a customer']].concat(
      S.data.customers
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => [c.id, c.name]),
    );
  const itemOptions = (blank) =>
    [['', blank]].concat(
      S.data.items
        .slice()
        .sort((a, b) => a.sku.localeCompare(b.sku))
        .map((i) => [i.id, i.sku + ' \u00b7 ' + i.name]),
    );

  // Line items editor with live totals.
  function lineEditor(lines, taxInput) {
    const list = h('div', { class: 'aerp-lines-body' });
    const totalsEl = h('dl', { class: 'aerp-totals', 'aria-live': 'polite' });
    const errEl = h('p', { class: 'aerp-error', hidden: true });
    function readRow(row) {
      const q = row.querySelector('[data-line=qty]').value.trim(),
        p = row.querySelector('[data-line=price]').value.trim();
      return {
        itemId: row.querySelector('[data-line=item]').value,
        description: row.querySelector('[data-line=desc]').value.trim(),
        qtyRaw: q,
        priceRaw: p,
        qty: C.parseQty(q),
        unitPrice: C.parseMoney(p),
      };
    }
    function refresh() {
      let sub = 0;
      list.querySelectorAll('.aerp-line').forEach((row, i) => {
        const r = readRow(row);
        const amt = Number.isNaN(r.qty) || Number.isNaN(r.unitPrice) ? 0 : C.lineAmount(r);
        sub += amt;
        row.querySelector('[data-line=amount]').textContent = money(amt);
        row.querySelectorAll('[data-n]').forEach((el) => {
          el.setAttribute('aria-label', el.dataset.n + ', line ' + (i + 1));
        });
      });
      const rate = taxInput ? C.parseQty(taxInput.value) : 0;
      const tax = Math.round((sub * (Number.isNaN(rate) ? 0 : rate)) / 100);
      totalsEl.replaceChildren(
        h('dt', null, 'Subtotal'),
        h('dd', null, money(sub)),
        h('dt', null, 'Tax' + (Number.isNaN(rate) ? '' : ' (' + rate + '%)')),
        h('dd', null, money(tax)),
        h('dt', { class: 'is-total' }, 'Total'),
        h('dd', { class: 'is-total', 'data-total': sub + tax }, money(sub + tax)),
      );
    }
    function addRow(l) {
      l = l || { itemId: '', description: '', qty: 1, unitPrice: '' };
      const itemSel = h(
        'select',
        { 'data-line': 'item', 'data-n': 'Stock item', value: l.itemId || '' },
        itemOptions('Custom line').map((o) => h('option', { value: o[0] }, o[1])),
      );
      const desc = h('input', {
        type: 'text',
        'data-line': 'desc',
        'data-n': 'Description',
        value: l.description || '',
        maxlength: 300,
      });
      const qty = h('input', {
        type: 'text',
        inputmode: 'decimal',
        'data-line': 'qty',
        'data-n': 'Quantity',
        value: l.qty === '' ? '' : qtyInput(l.qty),
      });
      const price = h('input', {
        type: 'text',
        inputmode: 'decimal',
        'data-line': 'price',
        'data-n': 'Unit price',
        value: l.unitPrice === '' ? '' : C.moneyInput(l.unitPrice),
      });
      const row = h(
        'div',
        { class: 'aerp-line' },
        h('div', { class: 'aerp-line-item' }, itemSel),
        h('div', { class: 'aerp-line-desc' }, desc),
        h('div', { class: 'aerp-line-qty' }, qty),
        h('div', { class: 'aerp-line-price' }, price),
        h('output', { class: 'aerp-line-amount', 'data-line': 'amount' }),
        h(
          'button',
          {
            type: 'button',
            class: 'aerp-icon-btn',
            'data-n': 'Remove',
            'data-action': 'remove-line',
            onclick: () => {
              row.remove();
              if (!list.children.length) addRow();
              refresh();
            },
          },
          '\u00d7',
        ),
      );
      itemSel.addEventListener('change', () => {
        const it = get('items', itemSel.value);
        if (it) {
          desc.value = it.name;
          price.value = C.moneyInput(it.price);
        }
        refresh();
      });
      list.append(row);
      refresh();
      return row;
    }
    (lines && lines.length ? lines : [null]).forEach((l) => addRow(l));
    list.addEventListener('input', refresh);
    if (taxInput) taxInput.addEventListener('input', refresh);
    const el = h(
      'fieldset',
      { class: 'aerp-lines' },
      h('legend', null, 'Line items'),
      h(
        'div',
        { class: 'aerp-lines-head', 'aria-hidden': 'true' },
        h('span', null, 'Stock item'),
        h('span', null, 'Description'),
        h('span', null, 'Qty'),
        h('span', null, 'Unit price'),
        h('span', null, 'Amount'),
        h('span'),
      ),
      list,
      h(
        'div',
        { class: 'aerp-lines-foot' },
        h(
          'button',
          {
            type: 'button',
            class: 'aerp-btn aerp-btn--small',
            'data-action': 'add-line',
            onclick: () => {
              const r = addRow();
              r.querySelector('select').focus();
            },
          },
          'Add line',
        ),
        totalsEl,
      ),
      errEl,
    );
    return {
      el,
      refresh,
      bindTax(input) {
        taxInput = input;
        input.addEventListener('input', refresh);
        refresh();
      },
      read() {
        const out = [];
        let err = '';
        list.querySelectorAll('.aerp-line').forEach((row, i) => {
          const r = readRow(row);
          if (!r.itemId && !r.description && !r.priceRaw) return;
          const n = i + 1;
          if (!err && !r.description) err = 'Line ' + n + ' needs a description.';
          else if (!err && (Number.isNaN(r.qty) || r.qty <= 0))
            err = 'Line ' + n + ' needs a quantity above 0.';
          else if (!err && (Number.isNaN(r.unitPrice) || r.unitPrice < 0))
            err = 'Line ' + n + ' needs a unit price like 25.00.';
          out.push({
            itemId: r.itemId,
            description: r.description,
            qty: r.qty,
            unitPrice: r.unitPrice,
          });
        });
        if (!err && !out.length) err = 'Add at least one line.';
        errEl.textContent = err;
        errEl.hidden = !err;
        if (err) {
          const bad = list.querySelector('input');
          if (bad) bad.focus();
        }
        return err ? null : out;
      },
    };
  }

  /* ---------- record forms ---------- */
  function needCustomer(next) {
    openDialog(
      'Add a customer first',
      h(
        'div',
        { class: 'aerp-dialog-body' },
        h(
          'p',
          null,
          'Quotes, orders, projects and invoices belong to a customer. Add one, then continue.',
        ),
        h(
          'div',
          { class: 'aerp-form-actions' },
          h('button', { type: 'button', class: 'aerp-btn', onclick: closeDialog }, 'Cancel'),
          h(
            'button',
            {
              type: 'button',
              class: 'aerp-btn aerp-btn--primary',
              'data-action': 'new-customer',
              onclick: () => customerForm(null, next),
            },
            'New customer',
          ),
        ),
      ),
    );
  }
  function customerForm(rec, after) {
    const specs = [
      {
        name: 'name',
        label: 'Customer name',
        required: true,
        max: 200,
        autocomplete: 'organization',
      },
      { name: 'contact', label: 'Contact person', max: 200, autocomplete: 'name' },
      { name: 'email', label: 'Email', type: 'email', max: 200, autocomplete: 'email' },
      { name: 'phone', label: 'Phone', type: 'tel', max: 80, autocomplete: 'tel' },
      { name: 'address', label: 'Address', type: 'textarea', wide: true, rows: 3 },
      { name: 'notes', label: 'Notes', type: 'textarea', wide: true, rows: 3 },
    ];
    openDialog(
      rec ? 'Edit customer' : 'New customer',
      formShell(specs, rec || {}, rec ? 'Save changes' : 'Add customer', async (v) => {
        const r = await commit(
          (d) => C.upsert(d, 'customers', Object.assign({}, v, { id: rec ? rec.id : undefined })),
          { quiet: true, noRender: true },
        );
        if (r.error) return r.error;
        closeDialog();
        toast(rec ? 'Customer saved.' : 'Customer added.');
        if (after) {
          render(false);
          after(r.result);
        } else go('customers/' + r.result.id);
        return '';
      }),
    );
  }
  function itemForm(rec) {
    const specs = [
      {
        name: 'sku',
        label: 'SKU',
        required: true,
        max: 80,
        help: 'A short unique code, like CHR-ASH.',
        check: (v) =>
          S.data.items.some(
            (i) => i.sku.toLowerCase() === v.toLowerCase() && (!rec || i.id !== rec.id),
          )
            ? 'Another item already uses this SKU.'
            : '',
      },
      { name: 'name', label: 'Item name', required: true, max: 200 },
      { name: 'unit', label: 'Unit', max: 40, placeholder: 'each' },
      { name: 'price', label: 'Sale price', type: 'money', required: true, min: 0 },
      { name: 'cost', label: 'Unit cost', type: 'money', min: 0 },
      {
        name: 'reorderPoint',
        label: 'Reorder point',
        type: 'qty',
        min: 0,
        help: 'Flag as low stock when the available quantity falls to this number.',
      },
    ];
    if (!rec)
      specs.push({
        name: 'opening',
        label: 'Opening stock',
        type: 'qty',
        min: 0,
        help: 'How many you have on hand now.',
      });
    const values = rec
      ? {
          sku: rec.sku,
          name: rec.name,
          unit: rec.unit,
          price: C.moneyInput(rec.price),
          cost: rec.cost ? C.moneyInput(rec.cost) : '',
          reorderPoint: rec.reorderPoint ? qtyInput(rec.reorderPoint) : '',
        }
      : { unit: 'each' };
    openDialog(
      rec ? 'Edit stock item' : 'New stock item',
      formShell(specs, values, rec ? 'Save changes' : 'Add item', async (v) => {
        const opening = v.opening || 0;
        delete v.opening;
        const r = await commit(
          (d) => C.saveItem(d, Object.assign({}, v, { id: rec ? rec.id : undefined }), opening),
          { quiet: true, noRender: true },
        );
        if (r.error) return r.error;
        closeDialog();
        toast(rec ? 'Item saved.' : 'Item added.');
        go('inventory/' + r.result.id);
        return '';
      }),
    );
  }
  const DOC = {
    quotes: { kind: 'quote', title: 'quote', dateField: 'date' },
    orders: { kind: 'order', title: 'order', dateField: 'date' },
    invoices: { kind: 'invoice', title: 'invoice', dateField: 'issueDate' },
  };
  function docForm(table, rec, preset) {
    if (!S.data.customers.length) {
      needCustomer((c) => docForm(table, rec, Object.assign({}, preset, { customerId: c.id })));
      return;
    }
    const cfg = DOC[table];
    const t = C.today();
    const base =
      rec ||
      Object.assign({ customerId: '', taxRate: S.data.settings.taxRate, lines: [] }, preset || {});
    const specs = [
      {
        name: 'customerId',
        label: 'Customer',
        type: 'select',
        required: true,
        options: customerOptions(),
      },
    ];
    if (table === 'invoices') {
      specs.push({ name: 'issueDate', label: 'Issue date', type: 'date', required: true });
      specs.push({
        name: 'dueDate',
        label: 'Due date',
        type: 'date',
        required: true,
        check: (v, o) =>
          o.issueDate && v < o.issueDate ? 'The due date cannot be before the issue date.' : '',
      });
    } else {
      specs.push({
        name: 'date',
        label: table === 'quotes' ? 'Quote date' : 'Order date',
        type: 'date',
        required: true,
      });
    }
    if (table === 'quotes') {
      specs.push({
        name: 'validUntil',
        label: 'Valid until',
        type: 'date',
        check: (v, o) =>
          v && o.date && v < o.date ? 'Valid until cannot be before the quote date.' : '',
      });
      if (!rec || rec.status !== 'converted')
        specs.push({
          name: 'status',
          label: 'Status',
          type: 'select',
          options: [
            ['draft', 'Draft'],
            ['sent', 'Sent'],
            ['accepted', 'Accepted'],
            ['declined', 'Declined'],
          ],
        });
    }
    specs.push({ name: 'taxRate', label: 'Tax rate (%)', type: 'percent', min: 0, maxNum: 100 });
    const values = {
      customerId: base.customerId,
      taxRate: String(base.taxRate == null ? 0 : base.taxRate),
      date: base.date || t,
      validUntil: base.validUntil || (rec ? '' : C.addDays(t, 30)),
      status: base.status || 'draft',
      issueDate: base.issueDate || t,
      dueDate: base.dueDate || C.addDays(base.issueDate || t, S.data.settings.paymentTerms),
    };
    const notesSpec = {
      name: 'notes',
      label: table === 'invoices' ? 'Notes on the invoice' : 'Notes',
      type: 'textarea',
      wide: true,
      rows: 2,
    };
    const editor = lineEditor(base.lines, null);
    const form = formShell(
      specs.concat([notesSpec]),
      Object.assign(values, { notes: base.notes || '' }),
      rec ? 'Save changes' : 'Create ' + cfg.title,
      async (v) => {
        const lines = editor.read();
        if (!lines) return 'Check the line items.';
        const fields = Object.assign({}, v, { lines, id: rec ? rec.id : undefined });
        if (!rec) {
          if (table === 'orders') fields.status = 'open';
          if (table === 'invoices') {
            fields.status = 'draft';
            fields.payments = [];
            fields.orderId = base.orderId || '';
            fields.projectId = base.projectId || '';
          }
        }
        const r = await commit((d) => C.saveDoc(d, table, cfg.kind, fields), {
          quiet: true,
          noRender: true,
        });
        if (r.error) return r.error;
        closeDialog();
        toast(
          (rec ? 'Saved ' : 'Created ') +
            docTitle[table].toLowerCase() +
            ' ' +
            r.result.number +
            '.',
        );
        go(table + '/' + r.result.id);
        return '';
      },
      editor.el,
    );
    editor.bindTax(form.elements.taxRate);
    openDialog(
      rec ? 'Edit ' + docTitle[table].toLowerCase() + ' ' + rec.number : 'New ' + cfg.title,
      form,
      true,
    );
  }
  function projectForm(rec, preset) {
    if (!S.data.customers.length) {
      needCustomer((c) => projectForm(rec, Object.assign({}, preset, { customerId: c.id })));
      return;
    }
    const base = rec || Object.assign({ status: 'planned', start: C.today() }, preset || {});
    const orderOpts = [['', 'No order']].concat(
      S.data.orders
        .slice()
        .sort((a, b) => b.number.localeCompare(a.number))
        .map((o) => [o.id, o.number + ' \u00b7 ' + customerName(o.customerId)]),
    );
    const specs = [
      { name: 'name', label: 'Project name', required: true, max: 200, wide: true },
      {
        name: 'customerId',
        label: 'Customer',
        type: 'select',
        required: true,
        options: customerOptions(),
      },
      {
        name: 'orderId',
        label: 'Order',
        type: 'select',
        options: orderOpts,
        check: (v, o) => {
          const ord = get('orders', v);
          return ord && ord.customerId !== o.customerId
            ? 'That order belongs to another customer.'
            : '';
        },
      },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        options: [
          ['planned', 'Planned'],
          ['active', 'Active'],
          ['on-hold', 'On hold'],
          ['done', 'Done'],
        ],
      },
      { name: 'start', label: 'Start date', type: 'date' },
      {
        name: 'due',
        label: 'Due date',
        type: 'date',
        check: (v, o) =>
          v && o.start && v < o.start ? 'The due date cannot be before the start date.' : '',
      },
      { name: 'notes', label: 'Notes', type: 'textarea', wide: true, rows: 3 },
    ];
    openDialog(
      rec ? 'Edit project' : 'New project',
      formShell(specs, base, rec ? 'Save changes' : 'Create project', async (v) => {
        const r = await commit(
          (d) => {
            const p = C.saveDoc(
              d,
              'projects',
              'project',
              Object.assign({}, v, { id: rec ? rec.id : undefined }),
            );
            d.orders.forEach((o) => {
              if (o.projectId === p.id && o.id !== p.orderId) o.projectId = '';
            });
            const o = d.orders.find((x) => x.id === p.orderId);
            if (o && !o.projectId) o.projectId = p.id;
            return p;
          },
          { quiet: true, noRender: true },
        );
        if (r.error) return r.error;
        closeDialog();
        toast((rec ? 'Saved project ' : 'Created project ') + r.result.number + '.');
        go('projects/' + r.result.id);
        return '';
      }),
    );
  }
  function paymentForm(inv) {
    const bal = C.balance(inv);
    const specs = [
      {
        name: 'amount',
        label: 'Amount received',
        type: 'money',
        required: true,
        min: 1,
        maxMoney: bal,
        help: 'Balance due: ' + money(bal) + '.',
      },
      { name: 'date', label: 'Date received', type: 'date', required: true },
      {
        name: 'method',
        label: 'Method',
        type: 'select',
        options: [
          ['Bank transfer', 'Bank transfer'],
          ['Card', 'Card'],
          ['Cash', 'Cash'],
          ['Check', 'Check'],
          ['Other', 'Other'],
        ],
      },
      { name: 'note', label: 'Note', max: 300 },
    ];
    openDialog(
      'Record a payment on ' + inv.number,
      formShell(
        specs,
        { amount: C.moneyInput(bal), date: C.today(), method: 'Bank transfer' },
        'Record payment',
        async (v) => {
          const r = await commit((d) => C.recordPayment(d, inv.id, v), {
            quiet: true,
            noRender: true,
          });
          if (r.error) return r.error;
          closeDialog();
          render(false);
          toast(
            'Payment of ' +
              money(v.amount) +
              ' recorded' +
              (C.balance(r.result) <= 0 ? '. ' + inv.number + ' is paid.' : '.'),
          );
          return '';
        },
      ),
    );
  }
  function stockForm(item, mode) {
    const s = S.idx.stock(item.id);
    const receive = mode === 'receive';
    const specs = receive
      ? [
          { name: 'qty', label: 'Quantity received', type: 'qty', required: true, gt: 0 },
          { name: 'note', label: 'Note', max: 300, placeholder: 'Supplier delivery' },
        ]
      : [
          {
            name: 'qty',
            label: 'Counted on hand',
            type: 'qty',
            required: true,
            min: 0,
            help: 'Currently recorded: ' + C.formatQty(s.onHand) + '.',
          },
          { name: 'note', label: 'Reason', max: 300, placeholder: 'Stock count' },
        ];
    openDialog(
      (receive ? 'Receive ' : 'Count ') + item.sku,
      formShell(
        specs,
        { qty: receive ? '' : qtyInput(s.onHand) },
        receive ? 'Add to stock' : 'Save count',
        async (v) => {
          const r = await commit(
            (d) =>
              receive
                ? C.addMovement(d, {
                    itemId: item.id,
                    qty: v.qty,
                    kind: 'receive',
                    note: v.note || 'Received',
                  })
                : C.adjustStock(d, item.id, v.qty, v.note),
            { quiet: true, noRender: true },
          );
          if (r.error) return r.error;
          closeDialog();
          render(false);
          toast(
            receive
              ? 'Received ' + C.formatQty(v.qty) + ' ' + item.unit + '.'
              : r.result
                ? 'Stock count saved.'
                : 'Count matches. Nothing changed.',
          );
          return '';
        },
      ),
    );
  }
  function issueForm(project) {
    if (!S.data.items.length) {
      toast('Add a stock item in Inventory first.', null, 'error');
      return;
    }
    const specs = [
      {
        name: 'itemId',
        label: 'Stock item',
        type: 'select',
        required: true,
        options: itemOptions('Choose an item'),
      },
      { name: 'qty', label: 'Quantity used', type: 'qty', required: true, gt: 0 },
    ];
    openDialog(
      'Use stock on ' + project.number,
      formShell(specs, {}, 'Use stock', async (v) => {
        const r = await commit((d) => C.issueStock(d, project.id, v.itemId, v.qty), {
          quiet: true,
          noRender: true,
        });
        if (r.error) return r.error;
        closeDialog();
        render(false);
        toast('Stock used on ' + project.number + '.');
        return '';
      }),
    );
  }

  /* ---------- shared view parts ---------- */
  function pageHead(title, intro, actions) {
    return h(
      'div',
      { class: 'aerp-head' },
      h('div', null, h('h2', null, title), intro ? h('p', { class: 'aerp-intro' }, intro) : null),
      actions && actions.length ? h('div', { class: 'aerp-actions' }, actions) : null,
    );
  }
  function emptyState(title, text, action) {
    return h(
      'div',
      { class: 'aerp-empty' },
      h('h3', null, title),
      h('p', null, text),
      action || null,
    );
  }
  function detailHead(o) {
    return h(
      'div',
      { class: 'aerp-detail-head' },
      h(
        'a',
        { class: 'aerp-back', href: '#/' + o.back[0] },
        h('span', { 'aria-hidden': 'true' }, '\u2190 '),
        o.back[1],
      ),
      h('div', { class: 'aerp-detail-title' }, h('h2', null, o.title), o.badge || null),
      o.meta ? h('p', { class: 'aerp-intro' }, o.meta) : null,
      o.actions && o.actions.length ? h('div', { class: 'aerp-actions' }, o.actions) : null,
    );
  }
  function facts(pairs) {
    const dl = h('dl', { class: 'aerp-facts' });
    pairs.forEach(([k, v]) => {
      if (v == null || v === '') return;
      dl.append(h('div', null, h('dt', null, k), h('dd', null, v)));
    });
    return dl;
  }
  function linesTable(doc) {
    const t = C.totals(doc);
    return h(
      'div',
      { class: 'aerp-tablewrap' },
      h(
        'table',
        { class: 'aerp-table aerp-table--lines' },
        h('caption', { class: 'aerp-vh' }, 'Line items'),
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', { scope: 'col' }, 'Description'),
            h('th', { scope: 'col', class: 'is-num' }, 'Qty'),
            h('th', { scope: 'col', class: 'is-num' }, 'Unit price'),
            h('th', { scope: 'col', class: 'is-num' }, 'Amount'),
          ),
        ),
        h(
          'tbody',
          null,
          doc.lines.map((l) =>
            h(
              'tr',
              null,
              h(
                'td',
                { 'data-label': 'Description' },
                l.description,
                l.itemId && get('items', l.itemId)
                  ? h(
                      'span',
                      { class: 'aerp-sub' },
                      ' ',
                      recLink('items', get('items', l.itemId), get('items', l.itemId).sku),
                    )
                  : null,
              ),
              h('td', { 'data-label': 'Qty', class: 'is-num' }, C.formatQty(l.qty)),
              h('td', { 'data-label': 'Unit price', class: 'is-num' }, money(l.unitPrice)),
              h('td', { 'data-label': 'Amount', class: 'is-num' }, money(C.lineAmount(l))),
            ),
          ),
        ),
        h(
          'tfoot',
          null,
          h(
            'tr',
            null,
            h('th', { scope: 'row', colspan: 3 }, 'Subtotal'),
            h('td', { class: 'is-num', 'data-label': 'Subtotal' }, money(t.subtotal)),
          ),
          h(
            'tr',
            null,
            h('th', { scope: 'row', colspan: 3 }, 'Tax (' + doc.taxRate + '%)'),
            h('td', { class: 'is-num', 'data-label': 'Tax' }, money(t.tax)),
          ),
          h(
            'tr',
            { class: 'is-total' },
            h('th', { scope: 'row', colspan: 3 }, 'Total'),
            h(
              'td',
              { class: 'is-num', 'data-label': 'Total', 'data-doc-total': t.total },
              money(t.total),
            ),
          ),
        ),
      ),
    );
  }
  // The record chain: customer, quote, order, project, invoices.
  function chainFor(table, rec) {
    let customer = get('customers', rec.customerId),
      quote = null,
      order = null,
      project = null,
      invoices = [];
    if (table === 'quotes') {
      quote = rec;
      order = get('orders', rec.orderId);
    }
    if (table === 'orders') {
      order = rec;
    }
    if (table === 'projects') {
      project = rec;
      order = get('orders', rec.orderId);
    }
    if (table === 'invoices') {
      order = get('orders', rec.orderId);
      project = get('projects', rec.projectId);
    }
    if (order) {
      quote = quote || get('quotes', order.quoteId);
      project = project || get('projects', order.projectId);
    }
    if (table === 'invoices') invoices = [rec];
    else if (order) invoices = invoicesForOrder(order);
    else if (project) invoices = S.data.invoices.filter((i) => i.projectId === project.id);
    const steps = [
      ['customers', customer, 'Customer'],
      ['quotes', quote, 'Quote'],
      ['orders', order, 'Order'],
      ['projects', project, 'Project'],
    ];
    const ol = h('ol', { class: 'aerp-chain-list' });
    steps.forEach(([t, r, label]) => {
      const current = t === table && r && r.id === rec.id;
      ol.append(
        h(
          'li',
          { class: r ? '' : 'is-missing' },
          h('span', { class: 'aerp-chain-kind' }, label),
          r
            ? current
              ? h(
                  'span',
                  { 'aria-current': 'true', class: 'aerp-chain-current' },
                  t === 'customers' ? r.name : r.number,
                )
              : recLink(t, r, t === 'customers' ? r.name : r.number)
            : h('span', { class: 'aerp-muted' }, 'None'),
        ),
      );
    });
    ol.append(
      h(
        'li',
        { class: invoices.length ? '' : 'is-missing' },
        h('span', { class: 'aerp-chain-kind' }, 'Invoice'),
        invoices.length
          ? invoices.map((i, n) => [
              n ? ', ' : '',
              i.id === rec.id && table === 'invoices'
                ? h('span', { 'aria-current': 'true', class: 'aerp-chain-current' }, i.number)
                : recLink('invoices', i, i.number),
            ])
          : h('span', { class: 'aerp-muted' }, 'None'),
      ),
    );
    return h('nav', { class: 'aerp-chain', 'aria-label': 'Record chain' }, ol);
  }
  function stockFor(refs) {
    const moves = S.data.movements.filter((m) =>
      refs.some(([t, id]) => m.refType === t && m.refId === id),
    );
    return moves;
  }
  function movementTable(moves, caption) {
    if (!moves.length) return null;
    return h(
      'div',
      { class: 'aerp-tablewrap' },
      h(
        'table',
        { class: 'aerp-table aerp-table--compact' },
        h('caption', { class: 'aerp-vh' }, caption),
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', { scope: 'col' }, 'Date'),
            h('th', { scope: 'col' }, 'Item'),
            h('th', { scope: 'col', class: 'is-num' }, 'Change'),
            h('th', { scope: 'col' }, 'Reason'),
          ),
        ),
        h(
          'tbody',
          null,
          moves
            .slice()
            .sort((a, b) => b.date.localeCompare(a.date))
            .map((m) =>
              h(
                'tr',
                null,
                h('td', { 'data-label': 'Date' }, fmtDate(m.date)),
                h(
                  'td',
                  { 'data-label': 'Item' },
                  recLink('items', get('items', m.itemId), (get('items', m.itemId) || {}).sku),
                ),
                h(
                  'td',
                  { 'data-label': 'Change', class: 'is-num' },
                  (m.qty > 0 ? '+' : '') + C.formatQty(m.qty),
                ),
                h('td', { 'data-label': 'Reason' }, m.note || m.kind),
              ),
            ),
        ),
      ),
    );
  }
  function section(title, content, cls) {
    return h(
      'section',
      { class: 'aerp-section' + (cls ? ' ' + cls : '') },
      h('h3', null, title),
      content,
    );
  }
  function linkList(table, rows, meta) {
    if (!rows.length) return h('p', { class: 'aerp-muted' }, 'None yet.');
    return h(
      'ul',
      { class: 'aerp-links' },
      rows.map((r) =>
        h('li', null, recLink(table, r), meta ? h('span', { class: 'aerp-sub' }, meta(r)) : null),
      ),
    );
  }
  function csvButton(table) {
    return btn('Export CSV', 'csv-' + table, () => exportCSV(table));
  }

  /* ---------- views ---------- */
  const VIEWS = {};
  VIEWS.dashboard = () => {
    const m = C.metrics(S.data, S.idx);
    const card = (key, label, value, display, sub, link) =>
      h(
        'a',
        { class: 'aerp-metric', href: link, 'data-metric': key, 'data-value': value },
        h('span', { class: 'aerp-metric-label' }, label),
        h('strong', null, display),
        h('span', { class: 'aerp-metric-sub' }, sub),
      );
    const t = C.today();
    const overdue = S.data.invoices.filter((i) => invStatus(i) === 'overdue');
    const low = S.data.items.filter((i) => S.idx.stock(i.id).low);
    const open = S.data.orders.filter((o) => o.status === 'open');
    const soon = S.data.projects.filter(
      (p) => p.status !== 'done' && p.due && p.due <= C.addDays(t, 14),
    );
    const steps = [
      ['Add your company details', !!S.data.settings.companyName, '#/settings'],
      ['Add a customer', S.data.customers.length > 0, '#/customers'],
      ['Add a stock item', S.data.items.length > 0, '#/inventory'],
      ['Create a quote', S.data.quotes.length > 0, '#/quotes'],
      ['Convert a quote to an order', S.data.orders.length > 0, '#/quotes'],
      ['Invoice an order', S.data.invoices.length > 0, '#/orders'],
      ['Record a payment', S.data.invoices.some((i) => i.payments.length), '#/invoices'],
    ];
    const allDone = steps.every((s) => s[1]);
    const list = (title, rows, cell, emptyText) =>
      section(
        title,
        rows.length
          ? h('ul', { class: 'aerp-links' }, rows.slice(0, 6).map(cell))
          : h('p', { class: 'aerp-muted' }, emptyText),
        'aerp-attn',
      );
    return {
      title: 'Dashboard',
      view: h(
        'div',
        null,
        pageHead(
          'Dashboard',
          (S.data.settings.companyName ? S.data.settings.companyName + ': ' : '') +
            'what needs doing, worked out from your records.',
        ),
        allDone
          ? null
          : section(
              'Get started',
              h(
                'ol',
                { class: 'aerp-steps' },
                steps.map(([label, done, link]) =>
                  h(
                    'li',
                    { class: done ? 'is-done' : '' },
                    h(
                      'span',
                      { class: 'aerp-step-mark', 'aria-hidden': 'true' },
                      done ? '\u2713' : '',
                    ),
                    done ? h('span', null, label, vh(' (done)')) : h('a', { href: link }, label),
                  ),
                ),
              ),
              'aerp-start',
            ),
        h(
          'div',
          { class: 'aerp-metrics' },
          card(
            'open-orders',
            'Open orders',
            m.openOrders,
            String(m.openOrders),
            money(m.openOrdersValue) + ' to deliver',
            '#/orders',
          ),
          card(
            'overdue-invoices',
            'Overdue invoices',
            m.overdueInvoices,
            String(m.overdueInvoices),
            money(m.overdueValue) + ' past due',
            '#/invoices',
          ),
          card(
            'low-stock',
            'Low stock',
            m.lowStock,
            String(m.lowStock),
            m.lowStock ? 'at or below reorder point' : 'nothing below reorder point',
            '#/inventory',
          ),
          card(
            'revenue-month',
            'Revenue this month',
            m.revenueMonth,
            money(m.revenueMonth),
            'payments received in ' + monthName(),
            '#/invoices',
          ),
          card(
            'receivable',
            'Owed to you',
            m.receivable,
            money(m.receivable),
            'on sent invoices',
            '#/invoices',
          ),
          card(
            'active-projects',
            'Projects in progress',
            m.activeProjects,
            String(m.activeProjects),
            'planned, active or on hold',
            '#/projects',
          ),
        ),
        h(
          'div',
          { class: 'aerp-attn-grid' },
          list(
            'Overdue invoices',
            overdue,
            (i) =>
              h(
                'li',
                null,
                recLink('invoices', i),
                h(
                  'span',
                  { class: 'aerp-sub' },
                  customerName(i.customerId) +
                    ' \u00b7 ' +
                    money(C.balance(i)) +
                    ' due ' +
                    fmtDate(i.dueDate),
                ),
              ),
            'No overdue invoices.',
          ),
          list(
            'Low stock',
            low,
            (i) => {
              const s = S.idx.stock(i.id);
              return h(
                'li',
                null,
                recLink('items', i),
                h(
                  'span',
                  { class: 'aerp-sub' },
                  C.formatQty(s.available) +
                    ' available, reorder at ' +
                    C.formatQty(i.reorderPoint),
                ),
              );
            },
            'Stock is above every reorder point.',
          ),
          list(
            'Open orders',
            open,
            (o) =>
              h(
                'li',
                null,
                recLink('orders', o),
                h(
                  'span',
                  { class: 'aerp-sub' },
                  customerName(o.customerId) + ' \u00b7 ' + money(C.totals(o).total),
                ),
              ),
            'No open orders.',
          ),
          list(
            'Projects due in the next two weeks',
            soon,
            (p) =>
              h(
                'li',
                null,
                recLink('projects', p),
                h('span', { class: 'aerp-sub' }, 'Due ' + fmtDate(p.due)),
              ),
            'Nothing due soon.',
          ),
        ),
      ),
    };
  };

  function listView(o) {
    const rows = S.data[o.table];
    const actions = [
      btn(o.newLabel, 'new', o.onNew, { kind: 'primary' }),
      rows.length ? csvButton(o.table) : null,
    ];
    const body = rows.length
      ? dataTable({
          key: o.table,
          caption: o.title,
          rows,
          columns: o.columns,
          search: o.search,
          link: (r) => href(o.table, r.id),
          sort: o.sort,
          dir: o.dir,
          noun: o.noun,
          nouns: o.nouns,
          placeholder: o.placeholder,
        })
      : emptyState(
          o.empty[0],
          o.empty[1],
          btn(o.empty[2], 'new-empty', o.onNew, { kind: 'primary' }),
        );
    return h('div', null, pageHead(o.title, o.intro, actions), body, o.after || null);
  }
  VIEWS.customers = (r) => {
    if (r.id) return customerDetail(r.id);
    const owed = (id) =>
      S.data.invoices
        .filter((i) => i.customerId === id && invStatus(i) !== 'draft')
        .reduce((s, i) => s + Math.max(0, C.balance(i)), 0);
    const openVal = (id) =>
      S.data.orders
        .filter((o) => o.customerId === id && o.status === 'open')
        .reduce((s, o) => s + C.totals(o).total, 0);
    return {
      title: 'Customers',
      view: listView({
        table: 'customers',
        title: 'Customers',
        noun: 'customer',
        newLabel: 'New customer',
        onNew: () => customerForm(null),
        intro:
          'The people and companies you work for. Every quote, order, project and invoice links back to one of them.',
        empty: [
          'No customers yet',
          'Add the first company or person you work for. Quotes, orders and invoices all start from a customer.',
          'Add your first customer',
        ],
        columns: [
          { key: 'name', label: 'Customer', value: (c) => c.name },
          { key: 'contact', label: 'Contact', value: (c) => c.contact || '' },
          { key: 'email', label: 'Email', value: (c) => c.email || '' },
          {
            key: 'open',
            label: 'Open orders',
            num: true,
            value: (c) => openVal(c.id),
            render: (c) => money(openVal(c.id)),
          },
          {
            key: 'owed',
            label: 'Owed',
            num: true,
            value: (c) => owed(c.id),
            render: (c) => money(owed(c.id)),
          },
        ],
        search: (c) => [c.name, c.contact, c.email, c.phone, c.address].join(' '),
      }),
    };
  };
  function customerDetail(id) {
    const c = get('customers', id);
    if (!c) return missing('customers', 'Customers');
    const quotes = S.data.quotes.filter((r) => r.customerId === id),
      orders = S.data.orders.filter((r) => r.customerId === id);
    const projects = S.data.projects.filter((r) => r.customerId === id),
      invoices = S.data.invoices.filter((r) => r.customerId === id);
    const owed = invoices
      .filter((i) => invStatus(i) !== 'draft')
      .reduce((s, i) => s + Math.max(0, C.balance(i)), 0);
    return {
      title: c.name,
      view: h(
        'div',
        null,
        detailHead({
          back: ['customers', 'Customers'],
          title: c.name,
          actions: [
            btn('New quote', 'new-quote', () => docForm('quotes', null, { customerId: c.id }), {
              kind: 'primary',
            }),
            btn('New order', 'new-order', () => docForm('orders', null, { customerId: c.id })),
            btn('Edit', 'edit', () => customerForm(c)),
            btn('Delete', 'delete', () => deleteRecord('customers', c, 'customers'), {
              kind: 'quiet',
            }),
          ],
        }),
        facts([
          ['Contact', c.contact],
          ['Email', c.email ? h('a', { href: 'mailto:' + c.email }, c.email) : ''],
          ['Phone', c.phone],
          ['Address', c.address],
          ['Owed', money(owed)],
          ['Notes', c.notes],
        ]),
        h(
          'div',
          { class: 'aerp-linked' },
          h('h3', { class: 'aerp-linked-title' }, 'Connected records'),
          h(
            'div',
            { class: 'aerp-linked-grid' },
            section(
              'Quotes',
              linkList(
                'quotes',
                quotes,
                (q) => ' \u00b7 ' + STATUS_LABEL[q.status] + ' \u00b7 ' + money(C.totals(q).total),
              ),
            ),
            section(
              'Orders',
              linkList(
                'orders',
                orders,
                (o) => ' \u00b7 ' + STATUS_LABEL[o.status] + ' \u00b7 ' + money(C.totals(o).total),
              ),
            ),
            section(
              'Projects',
              linkList('projects', projects, (p) => ' \u00b7 ' + STATUS_LABEL[p.status]),
            ),
            section(
              'Invoices',
              linkList(
                'invoices',
                invoices,
                (i) =>
                  ' \u00b7 ' + STATUS_LABEL[invStatus(i)] + ' \u00b7 ' + money(C.totals(i).total),
              ),
            ),
          ),
        ),
      ),
    };
  }
  function missing(mod, label) {
    return {
      title: 'Not found',
      view: h(
        'div',
        { class: 'aerp-empty' },
        h('h2', null, 'That record is not here'),
        h(
          'p',
          null,
          'It may have been deleted, or the link came from another browser. Records live only in the browser that created them.',
        ),
        h('a', { href: '#/' + mod }, 'Back to ' + label),
      ),
    };
  }

  const docColumns = (table) => {
    const cols = [
      { key: 'number', label: docTitle[table], value: (d) => d.number },
      { key: 'customer', label: 'Customer', value: (d) => customerName(d.customerId) },
      {
        key: 'date',
        label: table === 'invoices' ? 'Issued' : 'Date',
        value: (d) => d.date || d.issueDate,
        render: (d) => fmtDate(d.date || d.issueDate),
      },
    ];
    if (table === 'invoices')
      cols.push({
        key: 'due',
        label: 'Due',
        value: (d) => d.dueDate,
        render: (d) => fmtDate(d.dueDate),
      });
    cols.push({
      key: 'status',
      label: 'Status',
      value: (d) => (table === 'invoices' ? invStatus(d) : d.status),
      render: (d) => badge(table === 'invoices' ? invStatus(d) : d.status),
    });
    cols.push({
      key: 'total',
      label: 'Total',
      num: true,
      value: (d) => C.totals(d).total,
      render: (d) => money(C.totals(d).total),
    });
    if (table === 'invoices')
      cols.push({
        key: 'balance',
        label: 'Balance',
        num: true,
        value: (d) => C.balance(d),
        render: (d) => money(C.balance(d)),
      });
    return cols;
  };
  const docSearch = (d) =>
    [d.number, customerName(d.customerId), d.status, d.notes]
      .concat(d.lines.map((l) => l.description))
      .join(' ');
  VIEWS.quotes = (r) => {
    if (r.id) return quoteDetail(r.id);
    return {
      title: 'Quotes',
      view: listView({
        table: 'quotes',
        title: 'Quotes',
        noun: 'quote',
        newLabel: 'New quote',
        onNew: () => docForm('quotes', null),
        sort: 'number',
        dir: -1,
        intro:
          'Prices you have offered. Convert an accepted quote into an order and the stock is reserved for it.',
        empty: [
          'No quotes yet',
          'A quote lists what you will supply and at what price. When the customer says yes, convert it to an order in one step.',
          'Create your first quote',
        ],
        columns: docColumns('quotes'),
        search: docSearch,
      }),
    };
  };
  function quoteDetail(id) {
    const q = get('quotes', id);
    if (!q) return missing('quotes', 'Quotes');
    const converted = q.status === 'converted' && get('orders', q.orderId);
    const actions = converted
      ? [
          h(
            'a',
            { class: 'aerp-btn aerp-btn--primary', href: href('orders', q.orderId) },
            'Open order ' + get('orders', q.orderId).number,
          ),
        ]
      : [
          q.status !== 'declined'
            ? btn(
                'Convert to order',
                'convert',
                async () => {
                  const res = await act((d) => C.convertQuote(d, q.id));
                  if (!res.error) {
                    toast('Order ' + res.result.number + ' created. Its stock is reserved.');
                    go('orders/' + res.result.id);
                  }
                },
                { kind: 'primary' },
              )
            : null,
          q.status === 'draft'
            ? btn('Mark as sent', 'mark-sent', () =>
                act(
                  (d) => {
                    d.quotes.find((x) => x.id === q.id).status = 'sent';
                  },
                  'Quote marked as sent.',
                  true,
                ),
              )
            : null,
          btn('Edit', 'edit', () => docForm('quotes', q)),
          q.status !== 'declined'
            ? btn('Mark declined', 'decline', () =>
                act(
                  (d) => {
                    d.quotes.find((x) => x.id === q.id).status = 'declined';
                  },
                  'Quote marked as declined.',
                  true,
                ),
              )
            : null,
          btn('Delete', 'delete', () => deleteRecord('quotes', q, 'quotes'), { kind: 'quiet' }),
        ];
    return {
      title: 'Quote ' + q.number,
      view: h(
        'div',
        null,
        detailHead({
          back: ['quotes', 'Quotes'],
          title: 'Quote ' + q.number,
          badge: badge(q.status),
          meta:
            customerName(q.customerId) +
            ' \u00b7 ' +
            fmtDate(q.date) +
            (q.validUntil ? ' \u00b7 valid until ' + fmtDate(q.validUntil) : ''),
          actions,
        }),
        chainFor('quotes', q),
        linesTable(q),
        q.notes ? section('Notes', h('p', { class: 'aerp-pre' }, q.notes)) : null,
      ),
    };
  }
  VIEWS.orders = (r) => {
    if (r.id) return orderDetail(r.id);
    return {
      title: 'Orders',
      view: listView({
        table: 'orders',
        title: 'Orders',
        noun: 'order',
        newLabel: 'New order',
        onNew: () => docForm('orders', null),
        sort: 'number',
        dir: -1,
        intro:
          'Work the customer has confirmed. Open orders reserve their stock; fulfilling an order ships it.',
        empty: [
          'No orders yet',
          'Orders usually come from an accepted quote. You can also enter one directly. Open orders hold stock so you do not sell it twice.',
          'Create your first order',
        ],
        columns: docColumns('orders'),
        search: docSearch,
      }),
    };
  };
  function orderDetail(id) {
    const o = get('orders', id);
    if (!o) return missing('orders', 'Orders');
    const invs = invoicesForOrder(o);
    const isOpen = o.status === 'open';
    const project = get('projects', o.projectId);
    const actions = [
      btn(
        invs.length ? 'Create another invoice' : 'Create invoice',
        'invoice',
        async () => {
          const res = await act((d) => C.invoiceFromOrder(d, o.id));
          if (!res.error) {
            toast('Draft invoice ' + res.result.number + ' created from ' + o.number + '.');
            go('invoices/' + res.result.id);
          }
        },
        { kind: invs.length ? '' : 'primary' },
      ),
      !project && o.status !== 'cancelled'
        ? btn('Start project', 'start-project', () =>
            projectForm(null, {
              customerId: o.customerId,
              orderId: o.id,
              name: customerName(o.customerId) + ' \u2013 ' + o.number,
              status: 'planned',
              start: C.today(),
            }),
          )
        : null,
      isOpen
        ? btn('Fulfil order', 'fulfil', () =>
            act((d) => C.fulfilOrder(d, o.id), o.number + ' fulfilled. Stock shipped.', true),
          )
        : null,
      isOpen ? btn('Edit', 'edit', () => docForm('orders', o)) : null,
      isOpen
        ? btn('Cancel order', 'cancel-order', () =>
            act(
              (d) => {
                d.orders.find((x) => x.id === o.id).status = 'cancelled';
              },
              o.number + ' cancelled. Its reserved stock is released.',
              true,
            ),
          )
        : null,
      o.status === 'cancelled'
        ? btn('Reopen order', 'reopen', () =>
            act(
              (d) => {
                d.orders.find((x) => x.id === o.id).status = 'open';
              },
              o.number + ' reopened.',
              true,
            ),
          )
        : null,
      btn('Delete', 'delete', () => deleteRecord('orders', o, 'orders'), { kind: 'quiet' }),
    ];
    const stockRows = o.lines
      .filter((l) => l.itemId)
      .map((l) => {
        const it = get('items', l.itemId);
        const s = it ? S.idx.stock(it.id) : null;
        return { l, it, s };
      });
    const stock = stockRows.length
      ? h(
          'div',
          { class: 'aerp-tablewrap' },
          h(
            'table',
            { class: 'aerp-table aerp-table--compact' },
            h('caption', { class: 'aerp-vh' }, 'Stock for this order'),
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', { scope: 'col' }, 'Item'),
                h('th', { scope: 'col', class: 'is-num' }, 'This order'),
                h('th', { scope: 'col', class: 'is-num' }, 'On hand'),
                h('th', { scope: 'col', class: 'is-num' }, 'Reserved'),
                h('th', { scope: 'col', class: 'is-num' }, 'Available'),
              ),
            ),
            h(
              'tbody',
              null,
              stockRows.map(({ l, it, s }) =>
                h(
                  'tr',
                  { 'data-item': it ? it.sku : '' },
                  h('td', { 'data-label': 'Item' }, recLink('items', it, it ? it.sku : '')),
                  h(
                    'td',
                    { 'data-label': 'This order', class: 'is-num' },
                    C.formatQty(l.qty) +
                      (isOpen ? ' reserved' : o.status === 'fulfilled' ? ' shipped' : ''),
                  ),
                  h(
                    'td',
                    { 'data-label': 'On hand', class: 'is-num' },
                    s ? C.formatQty(s.onHand) : '\u2014',
                  ),
                  h(
                    'td',
                    { 'data-label': 'Reserved', class: 'is-num' },
                    s ? C.formatQty(s.reserved) : '\u2014',
                  ),
                  h(
                    'td',
                    { 'data-label': 'Available', class: 'is-num' },
                    s ? [C.formatQty(s.available), s.low ? [' ', badge('low')] : null] : '\u2014',
                  ),
                ),
              ),
            ),
          ),
        )
      : h('p', { class: 'aerp-muted' }, 'No stock items on this order.');
    return {
      title: 'Order ' + o.number,
      view: h(
        'div',
        null,
        detailHead({
          back: ['orders', 'Orders'],
          title: 'Order ' + o.number,
          badge: badge(o.status),
          meta: customerName(o.customerId) + ' \u00b7 ' + fmtDate(o.date),
          actions,
        }),
        chainFor('orders', o),
        linesTable(o),
        section(isOpen ? 'Stock reserved' : 'Stock', stock),
        section(
          'Stock movements',
          movementTable(stockFor([['order', o.id]]), 'Stock movements for this order') ||
            h(
              'p',
              { class: 'aerp-muted' },
              isOpen
                ? 'Nothing has shipped yet. Fulfil the order to ship its stock.'
                : 'No stock moved for this order.',
            ),
        ),
        o.notes ? section('Notes', h('p', { class: 'aerp-pre' }, o.notes)) : null,
      ),
    };
  }
  VIEWS.projects = (r) => {
    if (r.id) return projectDetail(r.id);
    const progress = (p) =>
      p.tasks.length ? p.tasks.filter((t) => t.done).length / p.tasks.length : 0;
    return {
      title: 'Projects',
      view: listView({
        table: 'projects',
        title: 'Projects',
        noun: 'project',
        newLabel: 'New project',
        onNew: () => projectForm(null),
        sort: 'number',
        dir: -1,
        intro: 'The jobs that deliver your orders: tasks, due dates and the stock each one uses.',
        empty: [
          'No projects yet',
          'Start a project from an order to plan the work, tick off tasks and record the stock it uses. Or create one on its own.',
          'Create your first project',
        ],
        columns: [
          { key: 'number', label: 'Project', value: (p) => p.number },
          { key: 'name', label: 'Name', value: (p) => p.name },
          { key: 'customer', label: 'Customer', value: (p) => customerName(p.customerId) },
          {
            key: 'status',
            label: 'Status',
            value: (p) => p.status,
            render: (p) => badge(p.status),
          },
          {
            key: 'due',
            label: 'Due',
            value: (p) => p.due || '9999',
            render: (p) => fmtDate(p.due),
          },
          {
            key: 'progress',
            label: 'Tasks',
            num: true,
            value: progress,
            render: (p) => p.tasks.filter((t) => t.done).length + ' of ' + p.tasks.length,
          },
        ],
        search: (p) =>
          [p.number, p.name, customerName(p.customerId), p.status, p.notes]
            .concat(p.tasks.map((t) => t.title))
            .join(' '),
      }),
    };
  };
  function projectDetail(id) {
    const p = get('projects', id);
    if (!p) return missing('projects', 'Projects');
    const done = p.tasks.filter((t) => t.done).length;
    const taskInputId = nextId('task');
    const taskForm = h(
      'form',
      { class: 'aerp-inline-form', novalidate: true },
      h('label', { for: taskInputId }, 'New task'),
      h('input', {
        id: taskInputId,
        name: 'task',
        type: 'text',
        maxlength: 300,
        autocomplete: 'off',
        'data-fk': 'task-input',
      }),
      h(
        'button',
        { type: 'submit', class: 'aerp-btn aerp-btn--small', 'data-action': 'add-task' },
        'Add task',
      ),
    );
    taskForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const title = taskForm.elements.task.value.trim();
      if (!title) {
        taskForm.elements.task.focus();
        return;
      }
      await commit((d) => {
        d.projects.find((x) => x.id === p.id).tasks.push({ id: C.uid(), title, done: false });
      });
      const again = root.querySelector('[data-fk="task-input"]');
      if (again) again.focus();
    });
    const tasks = h(
      'ul',
      { class: 'aerp-tasks' },
      p.tasks.map((t) => {
        const cid = nextId('t');
        return h(
          'li',
          { class: t.done ? 'is-done' : '' },
          h('input', {
            type: 'checkbox',
            id: cid,
            checked: t.done,
            'data-fk': 'task:' + t.id,
            onchange: (ev) =>
              commit((d) => {
                d.projects.find((x) => x.id === p.id).tasks.find((x) => x.id === t.id).done =
                  ev.target.checked;
              }),
          }),
          h('label', { for: cid }, t.title),
          h(
            'button',
            {
              type: 'button',
              class: 'aerp-icon-btn',
              'aria-label': 'Delete task: ' + t.title,
              onclick: () =>
                act(
                  (d) => {
                    const pr = d.projects.find((x) => x.id === p.id);
                    pr.tasks = pr.tasks.filter((x) => x.id !== t.id);
                  },
                  'Task deleted.',
                  true,
                ),
            },
            '\u00d7',
          ),
        );
      }),
    );
    const order = get('orders', p.orderId);
    const used = stockFor([['project', p.id]].concat(order ? [['order', order.id]] : []));
    return {
      title: p.name,
      view: h(
        'div',
        null,
        detailHead({
          back: ['projects', 'Projects'],
          title: p.number + ' \u00b7 ' + p.name,
          badge: badge(p.status),
          meta: customerName(p.customerId) + (p.due ? ' \u00b7 due ' + fmtDate(p.due) : ''),
          actions: [
            btn(
              'Create invoice',
              'invoice',
              async () => {
                const res = await act((d) => C.invoiceFromProject(d, p.id));
                if (!res.error) {
                  toast('Draft invoice ' + res.result.number + ' created.');
                  go('invoices/' + res.result.id);
                }
              },
              { kind: 'primary' },
            ),
            btn('Use stock', 'use-stock', () => issueForm(p)),
            btn('Edit', 'edit', () => projectForm(p)),
            btn('Delete', 'delete', () => deleteRecord('projects', p, 'projects'), {
              kind: 'quiet',
            }),
          ],
        }),
        chainFor('projects', p),
        facts([
          ['Start', fmtDate(p.start)],
          ['Due', fmtDate(p.due)],
          ['Progress', done + ' of ' + p.tasks.length + ' tasks done'],
          ['Notes', p.notes],
        ]),
        section(
          'Tasks',
          h(
            'div',
            null,
            p.tasks.length
              ? h('progress', { max: p.tasks.length, value: done, 'aria-label': 'Tasks done' })
              : null,
            p.tasks.length
              ? tasks
              : h(
                  'p',
                  { class: 'aerp-muted' },
                  'Break the job into steps. Tick them off as the work gets done.',
                ),
            taskForm,
          ),
        ),
        section(
          'Stock used',
          movementTable(used, 'Stock used on this project') ||
            h(
              'p',
              { class: 'aerp-muted' },
              'Nothing used yet. Use stock records materials taken for this job.',
            ),
        ),
      ),
    };
  }
  VIEWS.inventory = (r) => {
    if (r.id) return itemDetail(r.id);
    const st = (i) => S.idx.stock(i.id);
    const moves = S.data.movements;
    const after = moves.length
      ? h(
          'section',
          { class: 'aerp-section' },
          h(
            'div',
            { class: 'aerp-head aerp-head--sub' },
            h('h3', null, 'Stock movements'),
            csvButton('movements'),
          ),
          dataTable({
            key: 'movements',
            caption: 'Stock movements',
            rows: moves,
            noun: 'movement',
            sort: 'date',
            dir: -1,
            link: null,
            columns: [
              { key: 'date', label: 'Date', value: (m) => m.date, render: (m) => fmtDate(m.date) },
              {
                key: 'item',
                label: 'Item',
                value: (m) => (get('items', m.itemId) || {}).sku || '',
                render: (m) =>
                  recLink('items', get('items', m.itemId), (get('items', m.itemId) || {}).sku),
              },
              {
                key: 'qty',
                label: 'Change',
                num: true,
                value: (m) => m.qty,
                render: (m) => (m.qty > 0 ? '+' : '') + C.formatQty(m.qty),
              },
              {
                key: 'kind',
                label: 'Type',
                value: (m) => m.kind,
                render: (m) =>
                  ({
                    receive: 'Received',
                    ship: 'Shipped',
                    issue: 'Used on project',
                    adjust: 'Count',
                  })[m.kind],
              },
              {
                key: 'ref',
                label: 'Record',
                value: (m) => m.refId,
                render: (m) =>
                  m.refType
                    ? recLink(
                        m.refType === 'order' ? 'orders' : 'projects',
                        get(m.refType === 'order' ? 'orders' : 'projects', m.refId),
                      )
                    : m.note,
              },
            ],
            search: (m) => {
              const it = get('items', m.itemId) || {};
              return [it.sku, it.name, m.kind, m.note].join(' ');
            },
          }),
        )
      : null;
    return {
      title: 'Inventory',
      view: listView({
        table: 'items',
        title: 'Inventory',
        noun: 'item',
        newLabel: 'New item',
        onNew: () => itemForm(null),
        sort: 'sku',
        placeholder: 'Search SKU or name',
        intro:
          'What you stock and sell. Available is on hand minus what open orders reserve; low stock is flagged at the reorder point.',
        empty: [
          'No stock items yet',
          'Add the products or materials you keep on hand. Orders reserve them, projects use them, and every change is logged.',
          'Add your first item',
        ],
        columns: [
          { key: 'sku', label: 'SKU', value: (i) => i.sku },
          { key: 'name', label: 'Item', value: (i) => i.name },
          {
            key: 'onHand',
            label: 'On hand',
            num: true,
            value: (i) => st(i).onHand,
            render: (i) => C.formatQty(st(i).onHand),
          },
          {
            key: 'reserved',
            label: 'Reserved',
            num: true,
            value: (i) => st(i).reserved,
            render: (i) => C.formatQty(st(i).reserved),
          },
          {
            key: 'available',
            label: 'Available',
            num: true,
            value: (i) => st(i).available,
            render: (i) => [C.formatQty(st(i).available), st(i).low ? [' ', badge('low')] : null],
          },
          {
            key: 'price',
            label: 'Price',
            num: true,
            value: (i) => i.price,
            render: (i) => money(i.price),
          },
        ],
        search: (i) => [i.sku, i.name, st(i).low ? 'low' : ''].join(' '),
        after,
      }),
    };
  };
  function itemDetail(id) {
    const it = get('items', id);
    if (!it) return missing('inventory', 'Inventory');
    const s = S.idx.stock(it.id);
    const holding = S.data.orders.filter(
      (o) => o.status === 'open' && o.lines.some((l) => l.itemId === it.id),
    );
    const moves = S.data.movements.filter((m) => m.itemId === it.id);
    return {
      title: it.sku,
      view: h(
        'div',
        null,
        detailHead({
          back: ['inventory', 'Inventory'],
          title: it.sku + ' \u00b7 ' + it.name,
          badge: s.low ? badge('low') : null,
          actions: [
            btn('Receive stock', 'receive', () => stockForm(it, 'receive'), { kind: 'primary' }),
            btn('Count stock', 'count', () => stockForm(it, 'count')),
            btn('Edit', 'edit', () => itemForm(it)),
            btn('Delete', 'delete', () => deleteRecord('items', it, 'inventory'), {
              kind: 'quiet',
            }),
          ],
        }),
        h(
          'div',
          { class: 'aerp-metrics aerp-metrics--small' },
          [
            ['On hand', s.onHand, 'on-hand'],
            ['Reserved', s.reserved, 'reserved'],
            ['Available', s.available, 'available'],
            ['Reorder point', it.reorderPoint, 'reorder'],
          ].map(([k, v, key]) =>
            h(
              'div',
              { class: 'aerp-metric', 'data-stock': key, 'data-value': v },
              h('span', { class: 'aerp-metric-label' }, k),
              h('strong', null, C.formatQty(v)),
              h('span', { class: 'aerp-metric-sub' }, it.unit),
            ),
          ),
        ),
        facts([
          ['Sale price', money(it.price)],
          ['Unit cost', it.cost ? money(it.cost) : ''],
          ['Unit', it.unit],
        ]),
        section(
          'Reserved by open orders',
          linkList(
            'orders',
            holding,
            (o) =>
              ' \u00b7 ' +
              customerName(o.customerId) +
              ' \u00b7 ' +
              C.formatQty(
                o.lines.filter((l) => l.itemId === it.id).reduce((a, l) => a + l.qty, 0),
              ) +
              ' ' +
              it.unit,
          ),
        ),
        section(
          'Stock movements',
          movementTable(moves, 'Stock movements for ' + it.sku) ||
            h('p', { class: 'aerp-muted' }, 'No movements yet.'),
        ),
      ),
    };
  }
  VIEWS.invoices = (r) => {
    if (r.id && r.sub === 'print') return printView(r.id);
    if (r.id) return invoiceDetail(r.id);
    return {
      title: 'Invoices',
      view: listView({
        table: 'invoices',
        title: 'Invoices',
        noun: 'invoice',
        newLabel: 'New invoice',
        onNew: () => docForm('invoices', null),
        sort: 'number',
        dir: -1,
        intro:
          'Bills sent to customers, with payments against them. A sent invoice past its due date shows as overdue.',
        empty: [
          'No invoices yet',
          'Create an invoice from an order or project so the lines carry over, or start one here. Print it or save it as a PDF from the print view.',
          'Create your first invoice',
        ],
        columns: docColumns('invoices'),
        search: (d) => docSearch(d) + ' ' + invStatus(d),
      }),
    };
  };
  function invoiceDetail(id) {
    const inv = get('invoices', id);
    if (!inv) return missing('invoices', 'Invoices');
    const st = invStatus(inv);
    const bal = C.balance(inv);
    const actions = [
      bal > 0
        ? btn('Record payment', 'record-payment', () => paymentForm(inv), { kind: 'primary' })
        : null,
      inv.status === 'draft'
        ? btn('Mark as sent', 'mark-sent', () =>
            act(
              (d) => {
                d.invoices.find((x) => x.id === inv.id).status = 'sent';
              },
              inv.number + ' marked as sent.',
              true,
            ),
          )
        : null,
      h(
        'a',
        {
          class: 'aerp-btn',
          href: '#/invoices/' + encodeURIComponent(inv.id) + '/print',
          'data-action': 'print-view',
        },
        'Print view',
      ),
      inv.status === 'draft' ? btn('Edit', 'edit', () => docForm('invoices', inv)) : null,
      inv.status === 'sent' && !inv.payments.length
        ? btn('Back to draft', 'to-draft', () =>
            act(
              (d) => {
                d.invoices.find((x) => x.id === inv.id).status = 'draft';
              },
              inv.number + ' is a draft again.',
              true,
            ),
          )
        : null,
      btn('Delete', 'delete', () => deleteRecord('invoices', inv, 'invoices'), { kind: 'quiet' }),
    ];
    const pays = inv.payments.length
      ? h(
          'div',
          { class: 'aerp-tablewrap' },
          h(
            'table',
            { class: 'aerp-table aerp-table--compact' },
            h('caption', { class: 'aerp-vh' }, 'Payments'),
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', { scope: 'col' }, 'Date'),
                h('th', { scope: 'col' }, 'Method'),
                h('th', { scope: 'col', class: 'is-num' }, 'Amount'),
                h('th', { scope: 'col' }, h('span', { class: 'aerp-vh' }, 'Actions')),
              ),
            ),
            h(
              'tbody',
              null,
              inv.payments.map((p) =>
                h(
                  'tr',
                  null,
                  h('td', { 'data-label': 'Date' }, fmtDate(p.date)),
                  h(
                    'td',
                    { 'data-label': 'Method' },
                    p.method + (p.note ? ' \u00b7 ' + p.note : ''),
                  ),
                  h('td', { 'data-label': 'Amount', class: 'is-num' }, money(p.amount)),
                  h(
                    'td',
                    { 'data-label': 'Actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        class: 'aerp-btn aerp-btn--small aerp-btn--quiet',
                        'aria-label': 'Delete payment of ' + money(p.amount),
                        onclick: () =>
                          act(
                            (d) => {
                              const x = d.invoices.find((y) => y.id === inv.id);
                              x.payments = x.payments.filter((y) => y.id !== p.id);
                            },
                            'Payment deleted.',
                            true,
                          ),
                      },
                      'Delete',
                    ),
                  ),
                ),
              ),
            ),
          ),
        )
      : h('p', { class: 'aerp-muted' }, 'No payments yet.');
    return {
      title: 'Invoice ' + inv.number,
      view: h(
        'div',
        null,
        detailHead({
          back: ['invoices', 'Invoices'],
          title: 'Invoice ' + inv.number,
          badge: badge(st),
          meta:
            customerName(inv.customerId) +
            ' \u00b7 issued ' +
            fmtDate(inv.issueDate) +
            ' \u00b7 due ' +
            fmtDate(inv.dueDate),
          actions,
        }),
        chainFor('invoices', inv),
        linesTable(inv),
        h(
          'div',
          { class: 'aerp-metrics aerp-metrics--small' },
          h(
            'div',
            { class: 'aerp-metric', 'data-inv': 'paid', 'data-value': C.paidAmount(inv) },
            h('span', { class: 'aerp-metric-label' }, 'Paid'),
            h('strong', null, money(C.paidAmount(inv))),
          ),
          h(
            'div',
            { class: 'aerp-metric', 'data-inv': 'balance', 'data-value': bal },
            h('span', { class: 'aerp-metric-label' }, 'Balance due'),
            h('strong', null, money(bal)),
          ),
        ),
        section('Payments', pays),
        inv.notes ? section('Notes', h('p', { class: 'aerp-pre' }, inv.notes)) : null,
      ),
    };
  }
  function printView(id) {
    const inv = get('invoices', id);
    if (!inv) return missing('invoices', 'Invoices');
    const set = S.data.settings;
    const cust = get('customers', inv.customerId);
    const t = C.totals(inv);
    const st = invStatus(inv);
    return {
      title: 'Print ' + inv.number,
      view: h(
        'div',
        null,
        h(
          'div',
          { class: 'aerp-print-tools' },
          h(
            'a',
            { class: 'aerp-back', href: href('invoices', inv.id) },
            h('span', { 'aria-hidden': 'true' }, '\u2190 '),
            'Back to invoice ' + inv.number,
          ),
          h('h2', { class: 'aerp-vh' }, 'Print invoice ' + inv.number),
          h(
            'p',
            { class: 'aerp-intro' },
            'Use Print, then choose \u201cSave as PDF\u201d as the printer to make a PDF.',
          ),
          btn('Print or save as PDF', 'print', () => window.print(), { kind: 'primary' }),
        ),
        h(
          'article',
          { class: 'aerp-print-sheet', 'aria-label': 'Invoice ' + inv.number },
          h(
            'header',
            { class: 'aerp-ps-head' },
            h(
              'div',
              null,
              h('p', { class: 'aerp-ps-company' }, set.companyName || 'Your company'),
              set.companyAddress ? h('p', { class: 'aerp-pre' }, set.companyAddress) : null,
              set.companyEmail ? h('p', null, set.companyEmail) : null,
            ),
            h(
              'div',
              { class: 'aerp-ps-meta' },
              h('p', { class: 'aerp-ps-title' }, 'Invoice'),
              h('p', { 'data-print': 'number' }, inv.number),
              h(
                'dl',
                null,
                h('dt', null, 'Issued'),
                h('dd', null, fmtDate(inv.issueDate)),
                h('dt', null, 'Due'),
                h('dd', null, fmtDate(inv.dueDate)),
                h('dt', null, 'Status'),
                h('dd', null, STATUS_LABEL[st]),
              ),
            ),
          ),
          h(
            'div',
            { class: 'aerp-ps-to' },
            h('p', { class: 'aerp-ps-label' }, 'Bill to'),
            h('p', null, cust ? cust.name : 'Deleted customer'),
            cust && cust.contact ? h('p', null, cust.contact) : null,
            cust && cust.address ? h('p', { class: 'aerp-pre' }, cust.address) : null,
            cust && cust.email ? h('p', null, cust.email) : null,
          ),
          h(
            'table',
            { class: 'aerp-ps-lines' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', { scope: 'col' }, 'Description'),
                h('th', { scope: 'col' }, 'Qty'),
                h('th', { scope: 'col' }, 'Unit price'),
                h('th', { scope: 'col' }, 'Amount'),
              ),
            ),
            h(
              'tbody',
              null,
              inv.lines.map((l) =>
                h(
                  'tr',
                  null,
                  h('td', null, l.description),
                  h('td', null, C.formatQty(l.qty)),
                  h('td', null, money(l.unitPrice)),
                  h('td', null, money(C.lineAmount(l))),
                ),
              ),
            ),
          ),
          h(
            'dl',
            { class: 'aerp-ps-totals' },
            h('dt', null, 'Subtotal'),
            h('dd', null, money(t.subtotal)),
            h('dt', null, 'Tax (' + inv.taxRate + '%)'),
            h('dd', null, money(t.tax)),
            h('dt', null, 'Total'),
            h('dd', { 'data-print': 'total' }, money(t.total)),
            h('dt', null, 'Paid'),
            h('dd', null, money(C.paidAmount(inv))),
            h('dt', { class: 'is-total' }, 'Balance due'),
            h('dd', { class: 'is-total', 'data-print': 'balance' }, money(C.balance(inv))),
          ),
          inv.notes ? h('p', { class: 'aerp-pre aerp-ps-notes' }, inv.notes) : null,
        ),
      ),
    };
  }

  /* ---------- settings and data ---------- */
  const CURRENCIES = [
    'USD',
    'EUR',
    'GBP',
    'CAD',
    'AUD',
    'NZD',
    'CHF',
    'JPY',
    'SEK',
    'NOK',
    'DKK',
    'PLN',
    'CZK',
    'INR',
    'SGD',
    'HKD',
    'MXN',
    'BRL',
    'ZAR',
    'AED',
  ];
  VIEWS.settings = () => {
    const s = S.data.settings;
    const cur = CURRENCIES.includes(s.currency) ? CURRENCIES : CURRENCIES.concat([s.currency]);
    const specs = [
      {
        name: 'companyName',
        label: 'Company name',
        max: 200,
        autocomplete: 'organization',
        required: true,
      },
      { name: 'companyEmail', label: 'Company email', type: 'email', max: 200 },
      {
        name: 'companyAddress',
        label: 'Company address',
        type: 'textarea',
        rows: 3,
        wide: true,
        help: 'Printed at the top of your invoices.',
      },
      {
        name: 'currency',
        label: 'Currency',
        type: 'select',
        options: cur.map((c) => [c, c + ' \u00b7 ' + C.formatMoney(123456, c)]),
      },
      {
        name: 'taxRate',
        label: 'Default tax rate (%)',
        type: 'percent',
        min: 0,
        maxNum: 100,
        help: 'Used for new quotes, orders and invoices. Each document keeps its own rate.',
      },
      {
        name: 'invoicePrefix',
        label: 'Invoice number prefix',
        max: 12,
        help:
          'The next invoice will be ' +
          (s.invoicePrefix || '') +
          String(S.data.counters.invoice).padStart(4, '0') +
          '.',
        check: (v) =>
          /^[A-Za-z0-9\-_/.]*$/.test(v) ? '' : 'Use letters, numbers, - _ / or . only.',
      },
      {
        name: 'paymentTerms',
        label: 'Payment terms (days)',
        type: 'number',
        integer: true,
        min: 0,
        maxNum: 365,
      },
    ];
    const values = Object.assign({}, s, {
      taxRate: String(s.taxRate),
      paymentTerms: String(s.paymentTerms),
    });
    const errBox = h('p', { class: 'aerp-form-error', role: 'alert', hidden: true });
    const form = h(
      'form',
      { class: 'aerp-form aerp-panel', novalidate: true, 'aria-labelledby': 'aerp-settings-title' },
      h('h3', { id: 'aerp-settings-title' }, 'Company'),
      h(
        'div',
        { class: 'aerp-grid-form' },
        specs.map((f) => field(f, values[f.name])),
      ),
      errBox,
      h(
        'div',
        { class: 'aerp-form-actions aerp-form-actions--start' },
        h(
          'button',
          {
            type: 'submit',
            class: 'aerp-btn aerp-btn--primary',
            'data-action': 'save-settings',
            'data-fk': 'save-settings',
          },
          'Save settings',
        ),
      ),
    );
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const v = readForm(form, specs);
      if (!v) return;
      const r = await commit((d) => {
        d.settings = C.normalizeSettings(Object.assign({}, d.settings, v));
      });
      if (!r.error) toast('Settings saved.');
    });
    const n = C.counts(S.data);
    const LABELS = {
      customers: 'Customers',
      items: 'Stock items',
      quotes: 'Quotes',
      orders: 'Orders',
      projects: 'Projects',
      invoices: 'Invoices',
      movements: 'Stock movements',
    };
    const fileId = nextId('import');
    const data = h(
      'section',
      { class: 'aerp-panel', 'aria-labelledby': 'aerp-data-title' },
      h('h3', { id: 'aerp-data-title' }, 'Your data'),
      h(
        'p',
        null,
        store.mode === 'indexeddb'
          ? 'Everything is stored in this browser on this device. Nothing is uploaded, and there is no account. Clearing this site\u2019s data in your browser deletes it, and other browsers or devices cannot see it, so export a backup regularly.'
          : 'This browser is not letting AlcorERP store data, so your records last only until this tab closes. Export a backup before you leave.',
      ),
      h(
        'dl',
        { class: 'aerp-counts' },
        C.TABLES.map((t) =>
          h('div', null, h('dt', null, LABELS[t]), h('dd', { 'data-count': t }, String(n[t]))),
        ),
      ),
      h(
        'div',
        { class: 'aerp-actions aerp-actions--start' },
        btn('Export backup (.json)', 'export-json', exportJSON, { kind: 'primary' }),
        h(
          'label',
          { class: 'aerp-btn aerp-file', for: fileId },
          'Import a backup',
          h('input', {
            id: fileId,
            type: 'file',
            name: 'import',
            accept: 'application/json,.json',
            class: 'aerp-vh',
            onchange: (ev) => {
              const f = ev.target.files[0];
              ev.target.value = '';
              importFile(f);
            },
          }),
        ),
      ),
      h('h4', null, 'Export a table as CSV'),
      h(
        'div',
        { class: 'aerp-actions aerp-actions--start' },
        C.TABLES.map((t) => btn(LABELS[t], 'csv-' + t, () => exportCSV(t), { kind: 'small' })),
      ),
      h('h4', null, 'Start over'),
      h(
        'p',
        null,
        'Loading the sample company replaces your records with a fictional workshop\u2019s. Erasing deletes everything AlcorERP stored in this browser.',
      ),
      h(
        'div',
        { class: 'aerp-actions aerp-actions--start' },
        btn('Load sample company', 'load-sample', async () => {
          if (
            await confirmDialog({
              title: 'Replace your data with the sample?',
              message:
                'The sample company replaces every record in this browser. Export a backup first if you want to keep yours.',
              confirm: 'Load sample company',
              danger: true,
            })
          )
            loadSample();
        }),
        btn('Erase all data', 'erase', eraseAll, { kind: 'danger' }),
      ),
    );
    return {
      title: 'Settings & data',
      view: h(
        'div',
        null,
        pageHead(
          'Settings & data',
          'Company details for your documents, and everything about where your data lives.',
        ),
        h('div', { class: 'aerp-settings' }, form, data),
      ),
    };
  };

  function stamp() {
    return C.today();
  }
  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  function exportJSON() {
    download(
      'alcor-erp-backup-' + stamp() + '.json',
      JSON.stringify(C.backup(S.data), null, 2),
      'application/json',
    );
    toast('Backup downloaded. Keep it somewhere safe; it holds all your records.');
  }
  function exportCSV(table) {
    const d = S.data,
      dec = (c) => C.moneyInput(c),
      q = (n) => qtyInput(n);
    const map = {
      customers: [
        ['Name', 'Contact', 'Email', 'Phone', 'Address', 'Notes'],
        d.customers.map((c) => [c.name, c.contact, c.email, c.phone, c.address, c.notes]),
      ],
      items: [
        [
          'SKU',
          'Name',
          'Unit',
          'Price',
          'Cost',
          'On hand',
          'Reserved',
          'Available',
          'Reorder point',
          'Low stock',
        ],
        d.items.map((i) => {
          const s = S.idx.stock(i.id);
          return [
            i.sku,
            i.name,
            i.unit,
            dec(i.price),
            dec(i.cost),
            q(s.onHand),
            q(s.reserved),
            q(s.available),
            q(i.reorderPoint),
            s.low ? 'yes' : 'no',
          ];
        }),
      ],
      quotes: [
        [
          'Number',
          'Customer',
          'Date',
          'Valid until',
          'Status',
          'Subtotal',
          'Tax',
          'Total',
          'Order',
        ],
        d.quotes.map((x) => {
          const t = C.totals(x);
          return [
            x.number,
            customerName(x.customerId),
            x.date,
            x.validUntil,
            x.status,
            dec(t.subtotal),
            dec(t.tax),
            dec(t.total),
            (get('orders', x.orderId) || {}).number || '',
          ];
        }),
      ],
      orders: [
        ['Number', 'Customer', 'Date', 'Status', 'Quote', 'Project', 'Subtotal', 'Tax', 'Total'],
        d.orders.map((x) => {
          const t = C.totals(x);
          return [
            x.number,
            customerName(x.customerId),
            x.date,
            x.status,
            (get('quotes', x.quoteId) || {}).number || '',
            (get('projects', x.projectId) || {}).number || '',
            dec(t.subtotal),
            dec(t.tax),
            dec(t.total),
          ];
        }),
      ],
      projects: [
        ['Number', 'Name', 'Customer', 'Order', 'Status', 'Start', 'Due', 'Tasks done', 'Tasks'],
        d.projects.map((p) => [
          p.number,
          p.name,
          customerName(p.customerId),
          (get('orders', p.orderId) || {}).number || '',
          p.status,
          p.start,
          p.due,
          p.tasks.filter((t) => t.done).length,
          p.tasks.length,
        ]),
      ],
      invoices: [
        [
          'Number',
          'Customer',
          'Issued',
          'Due',
          'Status',
          'Subtotal',
          'Tax',
          'Total',
          'Paid',
          'Balance',
          'Order',
          'Project',
        ],
        d.invoices.map((x) => {
          const t = C.totals(x);
          return [
            x.number,
            customerName(x.customerId),
            x.issueDate,
            x.dueDate,
            invStatus(x),
            dec(t.subtotal),
            dec(t.tax),
            dec(t.total),
            dec(C.paidAmount(x)),
            dec(C.balance(x)),
            (get('orders', x.orderId) || {}).number || '',
            (get('projects', x.projectId) || {}).number || '',
          ];
        }),
      ],
      movements: [
        ['Date', 'SKU', 'Item', 'Change', 'Type', 'Record', 'Note'],
        d.movements.map((m) => {
          const it = get('items', m.itemId) || {};
          const ref = m.refType
            ? get(m.refType === 'order' ? 'orders' : 'projects', m.refId)
            : null;
          return [
            m.date,
            it.sku || '',
            it.name || '',
            q(m.qty),
            m.kind,
            ref ? ref.number : '',
            m.note,
          ];
        }),
      ],
    };
    const [head, rows] = map[table];
    download(
      'alcor-erp-' + table + '-' + stamp() + '.csv',
      '\ufeff' + C.toCSV(head, rows),
      'text/csv',
    );
    toast(plural(rows.length, 'row') + ' exported to CSV.');
  }
  async function importFile(file) {
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) {
      toast('That file is larger than 25 MB, so it is not an AlcorERP backup.', null, 'error');
      return;
    }
    let data;
    try {
      data = C.parseBackup(JSON.parse(await file.text()));
    } catch (e) {
      toast(
        'Import failed: ' + (e instanceof SyntaxError ? 'the file is not valid JSON.' : e.message),
        null,
        'error',
      );
      return;
    }
    const n = C.counts(data);
    const summary =
      plural(n.customers, 'customer') +
      ', ' +
      plural(n.items, 'stock item') +
      ', ' +
      plural(n.quotes, 'quote') +
      ', ' +
      plural(n.orders, 'order') +
      ', ' +
      plural(n.projects, 'project') +
      ' and ' +
      plural(n.invoices, 'invoice');
    if (
      S.data &&
      !(await confirmDialog({
        title: 'Replace your data with this backup?',
        message:
          'The backup has ' +
          summary +
          '. Importing replaces everything AlcorERP has stored in this browser.',
        confirm: 'Replace with backup',
        danger: true,
      }))
    )
      return;
    data.rev = (S.data ? S.data.rev || 0 : 0) + 1;
    S.loadError = '';
    await persist(data);
    S.undoToken = null;
    S.tables = {};
    go('dashboard');
    toast('Imported ' + summary + '.');
  }
  async function startEmpty() {
    const d = C.emptyData();
    d.rev = 1;
    await persist(d);
    go('dashboard');
    toast('Your workspace is ready. Start with your company details.');
  }
  async function loadSample() {
    const d = C.sampleData();
    d.rev = (S.data ? S.data.rev || 0 : 0) + 1;
    await persist(d);
    S.undoToken = null;
    S.tables = {};
    go('dashboard');
    toast('Sample company loaded. Everything in it is fictional.');
  }
  async function eraseAll() {
    const ok = await confirmDialog({
      title: 'Erase all data?',
      message:
        'This deletes every customer, quote, order, project, stock record, invoice and setting AlcorERP stored in this browser. It cannot be undone. Export a backup first if you might need it.',
      confirm: 'Erase everything',
      danger: true,
    });
    if (!ok) return;
    try {
      await store.clear();
    } catch (e) {
      toast('Could not erase: ' + e.message, null, 'error');
      return;
    }
    S.data = null;
    S.idx = null;
    S.undoToken = null;
    S.tables = {};
    S.loadError = '';
    history.replaceState(null, '', location.pathname + location.search);
    render(true);
    toast('All AlcorERP data in this browser was erased.');
  }

  function welcomeView() {
    const fileId = nextId('import');
    return h(
      'section',
      { class: 'aerp-welcome', 'aria-labelledby': 'aerp-welcome-title' },
      h('p', { class: 'aerp-eyebrow' }, 'Free in your browser'),
      h('h2', { id: 'aerp-welcome-title' }, 'Set up AlcorERP'),
      h(
        'p',
        { class: 'aerp-intro' },
        'Customers, quotes, orders, projects, stock and invoices, connected as one record. AlcorERP saves to this browser on this device. Nothing is uploaded, and there is no account.',
      ),
      h(
        'div',
        { class: 'aerp-choices' },
        h(
          'div',
          { class: 'aerp-choice' },
          h('h3', null, 'Start empty'),
          h(
            'p',
            null,
            'Begin with your own records. The dashboard walks you through the first steps.',
          ),
          btn('Start empty', 'start-empty', startEmpty, { kind: 'primary' }),
        ),
        h(
          'div',
          { class: 'aerp-choice' },
          h('h3', null, 'Load sample company'),
          h(
            'p',
            null,
            'Explore with a fictional workshop\u2019s customers, orders and invoices. Erase it whenever you like.',
          ),
          btn('Load sample company', 'load-sample', loadSample),
        ),
        h(
          'div',
          { class: 'aerp-choice' },
          h('h3', null, 'Import a backup'),
          h(
            'p',
            null,
            'Open a .json backup you exported from AlcorERP, in this or another browser.',
          ),
          h(
            'label',
            { class: 'aerp-btn aerp-file', for: fileId },
            'Choose backup file',
            h('input', {
              id: fileId,
              type: 'file',
              name: 'import',
              accept: 'application/json,.json',
              class: 'aerp-vh',
              onchange: (ev) => {
                const f = ev.target.files[0];
                ev.target.value = '';
                importFile(f);
              },
            }),
          ),
        ),
      ),
    );
  }
  function recoveryView() {
    return h(
      'section',
      { class: 'aerp-welcome' },
      h('h2', null, 'Your stored data could not be read'),
      h('p', { class: 'aerp-intro' }, S.loadError),
      h(
        'p',
        null,
        'Download the stored data to keep a copy, then erase it to start again or import a backup.',
      ),
      h(
        'div',
        { class: 'aerp-actions aerp-actions--start' },
        btn(
          'Download stored data',
          'download-raw',
          async () => {
            const raw = await store.load();
            download(
              'alcor-erp-stored-' + stamp() + '.json',
              JSON.stringify(raw, null, 2),
              'application/json',
            );
          },
          { kind: 'primary' },
        ),
        btn('Erase and start again', 'erase', eraseAll, { kind: 'danger' }),
      ),
    );
  }

  /* ---------- keyboard ---------- */
  document.addEventListener('keydown', (ev) => {
    if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey || dlg.open || !S.data) return;
    const t = ev.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (ev.key === '/') {
      const s = viewEl.querySelector('.aerp-search');
      if (s) {
        ev.preventDefault();
        s.focus();
        s.select();
      }
    } else if (ev.key === 'n' || ev.key === 'N') {
      const b = viewEl.querySelector('[data-action="new"],[data-action="new-empty"]');
      if (b) {
        ev.preventDefault();
        b.click();
      }
    }
  });

  /* ---------- other tabs ---------- */
  async function syncFromStore() {
    if (dlg.open) return;
    const seen = S.data;
    let doc;
    try {
      doc = await store.load();
    } catch (e) {
      return;
    }
    // The first tap into a frame also fires focus; a change made while the read was pending is newer than it.
    if (S.data !== seen) return;
    if (!doc) {
      if (S.data && store.mode === 'indexeddb') {
        S.data = null;
        S.idx = null;
        render(true);
      }
      return;
    }
    if (!S.data || (doc.rev || 0) > (S.data.rev || 0)) {
      try {
        S.data = C.migrate(doc);
        S.data.rev = doc.rev || 0;
        S.idx = C.buildIndex(S.data);
        S.loadError = '';
        render(false);
        toast('Updated with changes from another tab.');
      } catch (e) {
        /* keep the current view */
      }
    }
  }
  window.addEventListener('focus', syncFromStore);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncFromStore();
  });
  window.addEventListener('hashchange', () => {
    closeDialog();
    render(true);
  });

  (async function init() {
    let doc = null;
    try {
      doc = await store.load();
    } catch (e) {
      doc = null;
    }
    if (doc) {
      try {
        S.data = C.migrate(doc);
        S.data.rev = doc.rev || 0;
        S.idx = C.buildIndex(S.data);
      } catch (e) {
        S.loadError = e.message;
      }
    }
    render(false);
    root.setAttribute('data-ready', 'true');
  })();
})();
