/*
 * AlcorERP core: the data model, browser storage and business rules.
 * Everything runs in this browser. Nothing here makes a network request.
 * Money is stored as integer minor units (cents) to avoid floating-point drift.
 */
(function (global) {
  'use strict';

  const SCHEMA_VERSION = 1;
  const BACKUP_FORMAT = 'alcor-erp-backup';
  const TABLES = ['customers', 'items', 'quotes', 'orders', 'projects', 'invoices', 'movements'];
  const DB_NAME = 'alcor-erp';
  const DB_STORE = 'workspace';
  const DB_KEY = 'current';
  const QUOTE_STATUS = ['draft', 'sent', 'accepted', 'declined', 'converted'];
  const ORDER_STATUS = ['open', 'fulfilled', 'cancelled'];
  const PROJECT_STATUS = ['planned', 'active', 'on-hold', 'done'];
  const INVOICE_STATUS = ['draft', 'sent'];
  const MOVEMENT_KINDS = ['receive', 'ship', 'issue', 'adjust'];
  const MAX_TEXT = 4000;

  /* ---------- small helpers ---------- */
  function uid() {
    const c = global.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    const b = new Uint8Array(16);
    if (c && c.getRandomValues) c.getRandomValues(b);
    else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  const pad = (n, w) => String(n).padStart(w || 2, '0');
  function today(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function isDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const t = new Date(y, m - 1, d);
    return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d;
  }
  function addDays(iso, n) {
    const [y, m, d] = (isDate(iso) ? iso : today()).split('-').map(Number);
    return today(new Date(y, m - 1, d + n));
  }
  const round3 = (x) => Math.round(x * 1000) / 1000;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const str = (v, max) => (v == null ? '' : String(v)).slice(0, max || MAX_TEXT);
  const int = (v, d) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d || 0);
  const num = (v, d) => (Number.isFinite(Number(v)) ? round3(Number(v)) : d || 0);
  const oneOf = (v, list, d) => (list.includes(v) ? v : d);

  /* ---------- money and quantities ---------- */
  // Parse "1,234.50", "$12", "12.5" into minor units. Returns NaN when unreadable.
  function parseMoney(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : NaN;
    let s = String(v == null ? '' : v)
      .trim()
      .replace(/[\s,$€£¥]/g, '');
    if (s === '') return NaN;
    const neg = s.startsWith('-');
    if (neg) s = s.slice(1);
    if (!/^\d+(\.\d{0,2})?$/.test(s) && !/^\.\d{1,2}$/.test(s)) return NaN;
    const parts = s.split('.');
    const cents = Number(parts[0] || '0') * 100 + Number(((parts[1] || '') + '00').slice(0, 2));
    if (!Number.isSafeInteger(cents)) return NaN;
    return neg ? -cents : cents;
  }
  function moneyInput(c) {
    c = int(c);
    const neg = c < 0;
    c = Math.abs(c);
    return (neg ? '-' : '') + Math.floor(c / 100) + '.' + pad(c % 100);
  }
  function parseQty(v) {
    const s = String(v == null ? '' : v)
      .trim()
      .replace(/,/g, '');
    if (!/^-?\d+(\.\d{1,3})?$/.test(s) && !/^-?\.\d{1,3}$/.test(s)) return NaN;
    return round3(Number(s));
  }
  const formatters = new Map();
  function formatter(currency) {
    const code = validCurrency(currency) ? currency : 'USD';
    if (!formatters.has(code))
      formatters.set(code, new Intl.NumberFormat(undefined, { style: 'currency', currency: code }));
    return formatters.get(code);
  }
  function formatMoney(cents, currency) {
    return formatter(currency).format(int(cents) / 100);
  }
  function validCurrency(code) {
    if (typeof code !== 'string' || !/^[A-Z]{3}$/.test(code)) return false;
    try {
      new Intl.NumberFormat('en', { style: 'currency', currency: code });
      return true;
    } catch (e) {
      return false;
    }
  }
  function formatQty(q) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(num(q));
  }

  /* ---------- schema ---------- */
  function defaultSettings() {
    return {
      companyName: '',
      companyEmail: '',
      companyAddress: '',
      currency: 'USD',
      taxRate: 0,
      invoicePrefix: 'INV-',
      paymentTerms: 30,
    };
  }
  function emptyData(settings) {
    const data = {
      schemaVersion: SCHEMA_VERSION,
      rev: 0,
      settings: Object.assign(defaultSettings(), settings || {}),
      counters: { quote: 1, order: 1, invoice: 1, project: 1 },
    };
    TABLES.forEach((t) => {
      data[t] = [];
    });
    return data;
  }
  function normLine(l) {
    l = l && typeof l === 'object' ? l : {};
    return {
      itemId: l.itemId ? str(l.itemId, 80) : '',
      description: str(l.description, 300),
      qty: num(l.qty, 0),
      unitPrice: int(l.unitPrice, 0),
    };
  }
  const NORMALIZE = {
    customers: (r) => ({
      name: str(r.name, 200),
      contact: str(r.contact, 200),
      email: str(r.email, 200),
      phone: str(r.phone, 80),
      address: str(r.address, 600),
      notes: str(r.notes),
    }),
    items: (r) => ({
      sku: str(r.sku, 80),
      name: str(r.name, 200),
      unit: str(r.unit, 40) || 'each',
      price: int(r.price),
      cost: int(r.cost),
      reorderPoint: num(r.reorderPoint, 0),
    }),
    quotes: (r) => ({
      number: str(r.number, 40),
      customerId: str(r.customerId, 80),
      date: isDate(r.date) ? r.date : today(),
      validUntil: isDate(r.validUntil) ? r.validUntil : '',
      status: oneOf(r.status, QUOTE_STATUS, 'draft'),
      taxRate: num(r.taxRate, 0),
      lines: Array.isArray(r.lines) ? r.lines.slice(0, 200).map(normLine) : [],
      orderId: str(r.orderId, 80),
      notes: str(r.notes),
    }),
    orders: (r) => ({
      number: str(r.number, 40),
      customerId: str(r.customerId, 80),
      quoteId: str(r.quoteId, 80),
      projectId: str(r.projectId, 80),
      date: isDate(r.date) ? r.date : today(),
      status: oneOf(r.status, ORDER_STATUS, 'open'),
      taxRate: num(r.taxRate, 0),
      lines: Array.isArray(r.lines) ? r.lines.slice(0, 200).map(normLine) : [],
      notes: str(r.notes),
    }),
    projects: (r) => ({
      number: str(r.number, 40),
      name: str(r.name, 200),
      customerId: str(r.customerId, 80),
      orderId: str(r.orderId, 80),
      status: oneOf(r.status, PROJECT_STATUS, 'planned'),
      start: isDate(r.start) ? r.start : '',
      due: isDate(r.due) ? r.due : '',
      notes: str(r.notes),
      tasks: Array.isArray(r.tasks)
        ? r.tasks.slice(0, 500).map((t) => ({
            id: str(t && t.id, 80) || uid(),
            title: str(t && t.title, 300),
            done: !!(t && t.done),
          }))
        : [],
    }),
    invoices: (r) => ({
      number: str(r.number, 40),
      customerId: str(r.customerId, 80),
      orderId: str(r.orderId, 80),
      projectId: str(r.projectId, 80),
      issueDate: isDate(r.issueDate) ? r.issueDate : today(),
      dueDate: isDate(r.dueDate) ? r.dueDate : '',
      status: oneOf(r.status, INVOICE_STATUS, 'draft'),
      taxRate: num(r.taxRate, 0),
      lines: Array.isArray(r.lines) ? r.lines.slice(0, 200).map(normLine) : [],
      notes: str(r.notes),
      payments: Array.isArray(r.payments)
        ? r.payments.slice(0, 500).map((p) => ({
            id: str(p && p.id, 80) || uid(),
            date: p && isDate(p.date) ? p.date : today(),
            amount: int(p && p.amount),
            method: str(p && p.method, 60),
            note: str(p && p.note, 300),
          }))
        : [],
    }),
    movements: (r) => ({
      itemId: str(r.itemId, 80),
      date: isDate(r.date) ? r.date : today(),
      qty: num(r.qty, 0),
      kind: oneOf(r.kind, MOVEMENT_KINDS, 'adjust'),
      refType: oneOf(r.refType, ['order', 'project', ''], ''),
      refId: str(r.refId, 80),
      note: str(r.note, 300),
    }),
  };
  function normalizeRecord(table, r) {
    const base = NORMALIZE[table](r || {});
    base.id = str(r && r.id, 80) || uid();
    base.createdAt = str(r && r.createdAt, 40) || new Date().toISOString();
    return base;
  }
  function normalizeSettings(s) {
    s = s && typeof s === 'object' ? s : {};
    const d = defaultSettings();
    return {
      companyName: str(s.companyName, 200),
      companyEmail: str(s.companyEmail, 200),
      companyAddress: str(s.companyAddress, 600),
      currency: validCurrency(s.currency) ? s.currency : d.currency,
      taxRate: Math.min(100, Math.max(0, num(s.taxRate, 0))),
      invoicePrefix: str(s.invoicePrefix == null ? d.invoicePrefix : s.invoicePrefix, 12),
      paymentTerms: Math.min(365, Math.max(0, int(s.paymentTerms, 30))),
    };
  }
  // Bring any stored or imported document up to the current schema. Throws on data it cannot read.
  function migrate(doc) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc))
      throw new Error('This is not an AlcorERP workspace.');
    const v = Number(doc.schemaVersion);
    if (!Number.isInteger(v) || v < 1) throw new Error('The workspace has no schema version.');
    if (v > SCHEMA_VERSION)
      throw new Error('This backup was made by a newer version of AlcorERP (schema ' + v + ').');
    const out = emptyData();
    out.rev = int(doc.rev, 0);
    out.settings = normalizeSettings(doc.settings);
    const c = doc.counters && typeof doc.counters === 'object' ? doc.counters : {};
    ['quote', 'order', 'invoice', 'project'].forEach((k) => {
      out.counters[k] = Math.max(1, int(c[k], 1));
    });
    TABLES.forEach((t) => {
      const rows = doc[t];
      if (rows != null && !Array.isArray(rows))
        throw new Error('The "' + t + '" table is not a list.');
      const seen = new Set();
      (rows || []).forEach((r) => {
        if (!r || typeof r !== 'object')
          throw new Error('A record in "' + t + '" is not an object.');
        const n = normalizeRecord(t, r);
        if (seen.has(n.id))
          throw new Error('Two records in "' + t + '" share the id ' + n.id + '.');
        seen.add(n.id);
        out[t].push(n);
      });
    });
    return out;
  }
  function backup(data) {
    const d = clone(data);
    delete d.rev;
    return {
      format: BACKUP_FORMAT,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      app: 'AlcorERP',
      data: d,
    };
  }
  function parseBackup(obj) {
    if (!obj || typeof obj !== 'object' || obj.format !== BACKUP_FORMAT || !obj.data)
      throw new Error('This file is not an AlcorERP backup.');
    const data = Object.assign({}, obj.data, {
      schemaVersion: obj.data.schemaVersion || obj.schemaVersion,
    });
    return migrate(data);
  }
  function counts(data) {
    const out = {};
    TABLES.forEach((t) => {
      out[t] = data ? data[t].length : 0;
    });
    return out;
  }

  /* ---------- storage: IndexedDB, with an in-memory fallback ---------- */
  function createStore() {
    let dbPromise = null;
    let memory = null;
    let mode = global.indexedDB ? 'indexeddb' : 'memory';
    function open() {
      if (!dbPromise)
        dbPromise = new Promise((resolve, reject) => {
          let req;
          try {
            req = global.indexedDB.open(DB_NAME, 1);
          } catch (e) {
            reject(e);
            return;
          }
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error || new Error('IndexedDB failed to open.'));
          req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab.'));
        });
      return dbPromise;
    }
    async function run(kind, fn) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, kind);
        const req = fn(tx.objectStore(DB_STORE));
        let out;
        if (req)
          req.onsuccess = () => {
            out = req.result;
          };
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => reject(tx.error || new Error('Storage failed.'));
        tx.onabort = () => reject(tx.error || new Error('Storage was aborted.'));
      });
    }
    return {
      get mode() {
        return mode;
      },
      async load() {
        if (mode === 'memory') return memory ? clone(memory) : null;
        try {
          const v = await run('readonly', (s) => s.get(DB_KEY));
          return v || null;
        } catch (e) {
          mode = 'memory';
          return memory ? clone(memory) : null;
        }
      },
      async save(doc) {
        if (mode === 'memory') {
          memory = clone(doc);
          return;
        }
        try {
          await run('readwrite', (s) => s.put(doc, DB_KEY));
        } catch (e) {
          mode = 'memory';
          memory = clone(doc);
          throw e;
        }
      },
      async clear() {
        memory = null;
        if (mode === 'memory') return;
        await run('readwrite', (s) => s.delete(DB_KEY));
      },
    };
  }

  /* ---------- derived values ---------- */
  function lineAmount(l) {
    return Math.round(num(l.qty) * int(l.unitPrice));
  }
  function totals(doc) {
    const subtotal = (doc.lines || []).reduce((s, l) => s + lineAmount(l), 0);
    const tax = Math.round((subtotal * num(doc.taxRate)) / 100);
    return { subtotal, tax, total: subtotal + tax };
  }
  function paidAmount(inv) {
    return (inv.payments || []).reduce((s, p) => s + int(p.amount), 0);
  }
  function balance(inv) {
    return totals(inv).total - paidAmount(inv);
  }
  function invoiceStatus(inv, now) {
    if (inv.status === 'draft') return 'draft';
    if (balance(inv) <= 0) return 'paid';
    if (inv.dueDate && inv.dueDate < (now || today())) return 'overdue';
    return 'sent';
  }
  function buildIndex(data) {
    const byId = {};
    TABLES.forEach((t) => {
      const m = new Map();
      data[t].forEach((r) => m.set(r.id, r));
      byId[t] = m;
    });
    const onHand = new Map();
    const reserved = new Map();
    data.movements.forEach((m) => onHand.set(m.itemId, (onHand.get(m.itemId) || 0) + num(m.qty)));
    data.orders.forEach((o) => {
      if (o.status !== 'open') return;
      o.lines.forEach((l) => {
        if (l.itemId) reserved.set(l.itemId, (reserved.get(l.itemId) || 0) + num(l.qty));
      });
    });
    const stock = (id) => {
      const have = round3(onHand.get(id) || 0);
      const held = round3(reserved.get(id) || 0);
      const item = byId.items.get(id);
      const available = round3(have - held);
      const reorder = item ? num(item.reorderPoint) : 0;
      return {
        onHand: have,
        reserved: held,
        available,
        low: reorder > 0 ? available <= reorder : available < 0,
      };
    };
    const get = (table, id) => (id ? byId[table].get(id) || null : null);
    return { byId, stock, get };
  }
  function metrics(data, idx, now) {
    now = now || today();
    const month = now.slice(0, 7);
    const open = data.orders.filter((o) => o.status === 'open');
    let overdueCount = 0,
      overdueValue = 0,
      receivable = 0,
      revenue = 0;
    data.invoices.forEach((inv) => {
      const st = invoiceStatus(inv, now);
      const bal = balance(inv);
      if (st === 'overdue') {
        overdueCount++;
        overdueValue += bal;
      }
      if (st === 'sent' || st === 'overdue') receivable += bal;
      (inv.payments || []).forEach((p) => {
        if (p.date.slice(0, 7) === month) revenue += int(p.amount);
      });
    });
    const low = data.items.filter((i) => idx.stock(i.id).low);
    return {
      openOrders: open.length,
      openOrdersValue: open.reduce((s, o) => s + totals(o).total, 0),
      overdueInvoices: overdueCount,
      overdueValue,
      receivable,
      lowStock: low.length,
      revenueMonth: revenue,
      activeProjects: data.projects.filter(
        (p) => p.status === 'active' || p.status === 'planned' || p.status === 'on-hold',
      ).length,
    };
  }

  /* ---------- business operations (mutate a draft copy; the app commits it) ---------- */
  function nextNumber(data, kind) {
    const n = data.counters[kind] || 1;
    data.counters[kind] = n + 1;
    const prefix =
      kind === 'invoice'
        ? data.settings.invoicePrefix
        : { quote: 'Q-', order: 'SO-', project: 'PRJ-' }[kind];
    return prefix + pad(n, 4);
  }
  function upsert(data, table, fields) {
    if (fields.id) {
      const i = data[table].findIndex((r) => r.id === fields.id);
      if (i < 0) throw new Error('That record no longer exists.');
      data[table][i] = normalizeRecord(table, Object.assign({}, data[table][i], fields));
      return data[table][i];
    }
    const rec = normalizeRecord(
      table,
      Object.assign({}, fields, { id: uid(), createdAt: new Date().toISOString() }),
    );
    data[table].push(rec);
    return rec;
  }
  function addMovement(data, m) {
    return upsert(data, 'movements', {
      itemId: m.itemId,
      date: m.date || today(),
      qty: m.qty,
      kind: m.kind,
      refType: m.refType || '',
      refId: m.refId || '',
      note: m.note || '',
    });
  }
  function saveItem(data, fields, openingStock) {
    const isNew = !fields.id;
    const item = upsert(data, 'items', fields);
    if (isNew && openingStock > 0)
      addMovement(data, {
        itemId: item.id,
        qty: openingStock,
        kind: 'receive',
        note: 'Opening stock',
      });
    return item;
  }
  function adjustStock(data, itemId, counted, note) {
    const idx = buildIndex(data);
    const diff = round3(counted - idx.stock(itemId).onHand);
    if (diff === 0) return null;
    return addMovement(data, { itemId, qty: diff, kind: 'adjust', note: note || 'Stock count' });
  }
  function saveDoc(data, table, kind, fields) {
    if (!fields.id && !fields.number) fields.number = nextNumber(data, kind);
    return upsert(data, table, fields);
  }
  function convertQuote(data, quoteId) {
    const q = data.quotes.find((r) => r.id === quoteId);
    if (!q) throw new Error('That quote no longer exists.');
    if (q.status === 'converted' && q.orderId) throw new Error('This quote is already an order.');
    if (!q.lines.length) throw new Error('Add at least one line before converting.');
    const order = saveDoc(data, 'orders', 'order', {
      customerId: q.customerId,
      quoteId: q.id,
      date: today(),
      status: 'open',
      taxRate: q.taxRate,
      lines: clone(q.lines),
      notes: q.notes,
    });
    q.status = 'converted';
    q.orderId = order.id;
    return order;
  }
  function shortages(data, lines) {
    const idx = buildIndex(data);
    const need = new Map();
    lines.forEach((l) => {
      if (l.itemId) need.set(l.itemId, (need.get(l.itemId) || 0) + num(l.qty));
    });
    const out = [];
    need.forEach((qty, id) => {
      const have = idx.stock(id).onHand;
      if (have < qty) {
        const item = idx.get('items', id);
        out.push(
          (item ? item.sku : 'Deleted item') +
            ' needs ' +
            formatQty(qty) +
            ', ' +
            formatQty(have) +
            ' on hand',
        );
      }
    });
    return out;
  }
  function fulfilOrder(data, orderId) {
    const o = data.orders.find((r) => r.id === orderId);
    if (!o) throw new Error('That order no longer exists.');
    if (o.status !== 'open') throw new Error('Only open orders can be fulfilled.');
    const short = shortages(data, o.lines);
    if (short.length) throw new Error('Not enough stock: ' + short.join('; ') + '.');
    o.lines.forEach((l) => {
      if (l.itemId && num(l.qty) > 0)
        addMovement(data, {
          itemId: l.itemId,
          qty: -num(l.qty),
          kind: 'ship',
          refType: 'order',
          refId: o.id,
          note: 'Shipped on ' + o.number,
        });
    });
    o.status = 'fulfilled';
    return o;
  }
  function startProject(data, orderId, fields) {
    const o = data.orders.find((r) => r.id === orderId);
    if (!o) throw new Error('That order no longer exists.');
    const p = saveDoc(
      data,
      'projects',
      'project',
      Object.assign(
        { customerId: o.customerId, orderId: o.id, status: 'planned', start: today(), tasks: [] },
        fields,
      ),
    );
    o.projectId = p.id;
    return p;
  }
  function issueStock(data, projectId, itemId, qty) {
    const p = data.projects.find((r) => r.id === projectId);
    if (!p) throw new Error('That project no longer exists.');
    const short = shortages(data, [{ itemId, qty }]);
    if (short.length) throw new Error('Not enough stock: ' + short.join('; ') + '.');
    return addMovement(data, {
      itemId,
      qty: -qty,
      kind: 'issue',
      refType: 'project',
      refId: p.id,
      note: 'Used on ' + p.number,
    });
  }
  function invoiceFromOrder(data, orderId) {
    const o = data.orders.find((r) => r.id === orderId);
    if (!o) throw new Error('That order no longer exists.');
    const issue = today();
    return saveDoc(data, 'invoices', 'invoice', {
      customerId: o.customerId,
      orderId: o.id,
      projectId: o.projectId,
      issueDate: issue,
      dueDate: addDays(issue, data.settings.paymentTerms),
      status: 'draft',
      taxRate: o.taxRate,
      lines: clone(o.lines),
      notes: '',
      payments: [],
    });
  }
  function invoiceFromProject(data, projectId) {
    const p = data.projects.find((r) => r.id === projectId);
    if (!p) throw new Error('That project no longer exists.');
    const order = p.orderId ? data.orders.find((r) => r.id === p.orderId) : null;
    const invoiced = order && data.invoices.some((i) => i.orderId === order.id);
    let lines;
    if (order && !invoiced) lines = clone(order.lines);
    else {
      const idx = buildIndex(data);
      lines = data.movements
        .filter((m) => m.refType === 'project' && m.refId === p.id && m.qty < 0)
        .map((m) => {
          const item = idx.get('items', m.itemId);
          return {
            itemId: '',
            description: (item ? item.name : 'Materials') + ' (used on ' + p.number + ')',
            qty: -m.qty,
            unitPrice: item ? item.price : 0,
          };
        });
      if (!lines.length) lines = [{ itemId: '', description: p.name, qty: 1, unitPrice: 0 }];
    }
    const issue = today();
    return saveDoc(data, 'invoices', 'invoice', {
      customerId: p.customerId,
      orderId: order && !invoiced ? order.id : '',
      projectId: p.id,
      issueDate: issue,
      dueDate: addDays(issue, data.settings.paymentTerms),
      status: 'draft',
      taxRate: order ? order.taxRate : data.settings.taxRate,
      lines,
      notes: '',
      payments: [],
    });
  }
  function recordPayment(data, invoiceId, p) {
    const inv = data.invoices.find((r) => r.id === invoiceId);
    if (!inv) throw new Error('That invoice no longer exists.');
    inv.payments.push({
      id: uid(),
      date: p.date || today(),
      amount: int(p.amount),
      method: str(p.method, 60),
      note: str(p.note, 300),
    });
    if (inv.status === 'draft') inv.status = 'sent';
    return inv;
  }
  // What stops a delete. An empty list means the record can go.
  function deleteBlockers(data, table, id) {
    const n = (list) => list.length;
    if (table === 'customers') {
      const parts = [];
      const q = n(data.quotes.filter((r) => r.customerId === id)),
        o = n(data.orders.filter((r) => r.customerId === id)),
        p = n(data.projects.filter((r) => r.customerId === id)),
        i = n(data.invoices.filter((r) => r.customerId === id));
      if (q) parts.push(q + (q === 1 ? ' quote' : ' quotes'));
      if (o) parts.push(o + (o === 1 ? ' order' : ' orders'));
      if (p) parts.push(p + (p === 1 ? ' project' : ' projects'));
      if (i) parts.push(i + (i === 1 ? ' invoice' : ' invoices'));
      return parts.length
        ? ['This customer has ' + parts.join(', ') + '. Delete those first.']
        : [];
    }
    if (table === 'items') {
      const used = data.orders.some(
        (o) => o.status === 'open' && o.lines.some((l) => l.itemId === id),
      );
      return used ? ['An open order reserves this item. Fulfil or cancel the order first.'] : [];
    }
    if (table === 'orders') {
      const o = data.orders.find((r) => r.id === id);
      const out = [];
      if (o && o.status === 'fulfilled')
        out.push('This order has shipped stock. Keep it for the stock history.');
      if (data.invoices.some((r) => r.orderId === id))
        out.push('This order has an invoice. Delete the invoice first.');
      return out;
    }
    if (table === 'projects') {
      return data.movements.some((m) => m.refType === 'project' && m.refId === id)
        ? ['Stock was used on this project. Keep it for the stock history.']
        : [];
    }
    return [];
  }
  function removeRecord(data, table, id) {
    const blockers = deleteBlockers(data, table, id);
    if (blockers.length) throw new Error(blockers.join(' '));
    data[table] = data[table].filter((r) => r.id !== id);
    if (table === 'items') data.movements = data.movements.filter((m) => m.itemId !== id);
    if (table === 'orders') {
      data.quotes.forEach((q) => {
        if (q.orderId === id) {
          q.orderId = '';
          q.status = 'accepted';
        }
      });
      data.projects.forEach((p) => {
        if (p.orderId === id) p.orderId = '';
      });
    }
    if (table === 'projects') {
      data.orders.forEach((o) => {
        if (o.projectId === id) o.projectId = '';
      });
      data.invoices.forEach((i) => {
        if (i.projectId === id) i.projectId = '';
      });
    }
  }

  /* ---------- CSV ---------- */
  function csvCell(v) {
    let s = v == null ? '' : String(v);
    // A text cell that a spreadsheet would run as a formula is kept as text.
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCSV(header, rows) {
    return (
      [header]
        .concat(rows)
        .map((r) => r.map(csvCell).join(','))
        .join('\r\n') + '\r\n'
    );
  }

  /* ---------- sample company (fictional) ---------- */
  function sampleData(now) {
    now = now || today();
    const d = (n) => addDays(now, n);
    const data = emptyData({
      companyName: 'Cedar & Pine Workshop',
      companyEmail: 'office@cedarpine.example',
      companyAddress: '12 Mill Lane\nRiverton',
      currency: 'USD',
      taxRate: 8.25,
      invoicePrefix: 'INV-',
      paymentTerms: 30,
    });
    const C = (f) => upsert(data, 'customers', f);
    const harbor = C({
      name: 'Harbor Street Cafe',
      contact: 'Dana Ruiz',
      email: 'dana@harborstreet.example',
      phone: '555-0142',
      address: '88 Harbor Street\nRiverton',
    });
    const northfield = C({
      name: 'Northfield Dental',
      contact: 'Sam Okafor',
      email: 'sam@northfield.example',
      phone: '555-0178',
      address: '4 Clinic Row\nNorthfield',
    });
    const larkspur = C({
      name: 'Larkspur Hotel',
      contact: 'Priya Nair',
      email: 'priya@larkspur.example',
      phone: '555-0110',
      address: '1 Lakeshore Drive\nLarkspur',
    });
    const bluebird = C({
      name: 'Bluebird Montessori',
      contact: 'Alex Chen',
      email: 'alex@bluebird.example',
      phone: '555-0193',
      address: '23 School Road\nRiverton',
    });
    const I = (f, stock) => {
      const it = upsert(data, 'items', f);
      addMovement(data, {
        itemId: it.id,
        date: d(-40),
        qty: stock,
        kind: 'receive',
        note: 'Opening stock',
      });
      return it;
    };
    const table = I(
      {
        sku: 'TBL-OAK-72',
        name: 'Oak table top, 72 in',
        unit: 'each',
        price: 64000,
        cost: 31000,
        reorderPoint: 2,
      },
      6,
    );
    const chair = I(
      {
        sku: 'CHR-ASH',
        name: 'Ash dining chair',
        unit: 'each',
        price: 18500,
        cost: 8200,
        reorderPoint: 12,
      },
      18,
    );
    const shelf = I(
      {
        sku: 'SHF-WAL',
        name: 'Walnut wall shelf',
        unit: 'each',
        price: 12000,
        cost: 5100,
        reorderPoint: 4,
      },
      9,
    );
    const bracket = I(
      {
        sku: 'HW-BRK',
        name: 'Steel bracket set',
        unit: 'set',
        price: 1800,
        cost: 600,
        reorderPoint: 20,
      },
      40,
    );
    const oil = I(
      {
        sku: 'FIN-OIL',
        name: 'Hardwax oil, 1 L',
        unit: 'can',
        price: 3200,
        cost: 1900,
        reorderPoint: 4,
      },
      5,
    );
    addMovement(data, {
      itemId: chair.id,
      date: d(-10),
      qty: 6,
      kind: 'receive',
      note: 'Delivery from the chair shop',
    });
    const L = (it, qty) => ({ itemId: it.id, description: it.name, qty, unitPrice: it.price });
    const tax = data.settings.taxRate;
    saveDoc(data, 'quotes', 'quote', {
      customerId: larkspur.id,
      date: d(-6),
      validUntil: d(24),
      status: 'sent',
      taxRate: tax,
      lines: [
        L(chair, 12),
        L(table, 2),
        { itemId: '', description: 'Delivery and setup', qty: 1, unitPrice: 25000 },
      ],
    });
    const q2 = saveDoc(data, 'quotes', 'quote', {
      customerId: harbor.id,
      date: d(-12),
      validUntil: d(18),
      status: 'accepted',
      taxRate: tax,
      lines: [L(table, 1), L(chair, 6), L(bracket, 6)],
    });
    const o1 = convertQuote(data, q2.id);
    o1.date = d(-9);
    const o2 = saveDoc(data, 'orders', 'order', {
      customerId: northfield.id,
      date: d(-30),
      status: 'open',
      taxRate: tax,
      lines: [
        L(shelf, 4),
        L(bracket, 8),
        { itemId: '', description: 'Installation, 3 hours', qty: 3, unitPrice: 6500 },
      ],
    });
    const p1 = startProject(data, o2.id, {
      name: 'Northfield reception shelving',
      status: 'done',
      start: d(-28),
      due: d(-20),
      tasks: [
        { title: 'Measure the wall', done: true },
        { title: 'Cut and finish shelves', done: true },
        { title: 'Install on site', done: true },
      ],
    });
    issueStock(data, p1.id, oil.id, 1);
    fulfilOrder(data, o2.id);
    const inv1 = invoiceFromOrder(data, o2.id);
    inv1.issueDate = d(-20);
    inv1.dueDate = d(10);
    inv1.status = 'sent';
    // Paid this month, so the sample dashboard shows revenue for the current month.
    recordPayment(data, inv1.id, {
      date: d(-2) >= now.slice(0, 8) + '01' ? d(-2) : now,
      amount: totals(inv1).total,
      method: 'Bank transfer',
    });
    const o3 = saveDoc(data, 'orders', 'order', {
      customerId: bluebird.id,
      date: d(-15),
      status: 'open',
      taxRate: tax,
      lines: [L(table, 3), L(oil, 2)],
    });
    startProject(data, o3.id, {
      name: 'Bluebird classroom tables',
      status: 'active',
      start: d(-14),
      due: d(6),
      tasks: [
        { title: 'Confirm table heights', done: true },
        { title: 'Mill and glue up tops', done: true },
        { title: 'Oil finish, two coats', done: false },
        { title: 'Deliver and level', done: false },
      ],
    });
    const dep = saveDoc(data, 'invoices', 'invoice', {
      customerId: bluebird.id,
      projectId: o3.projectId,
      issueDate: d(-15),
      dueDate: d(-5),
      status: 'sent',
      taxRate: tax,
      lines: [
        {
          itemId: '',
          description: 'Deposit, 30% of ' + o3.number,
          qty: 1,
          unitPrice: Math.round(totals(o3).subtotal * 0.3),
        },
      ],
    });
    dep.notes = 'Deposit before materials are ordered.';
    saveDoc(data, 'invoices', 'invoice', {
      customerId: harbor.id,
      orderId: o1.id,
      issueDate: now,
      dueDate: d(30),
      status: 'draft',
      taxRate: tax,
      lines: clone(o1.lines),
    });
    return data;
  }

  global.AlcorERPCore = {
    SCHEMA_VERSION,
    BACKUP_FORMAT,
    TABLES,
    QUOTE_STATUS,
    ORDER_STATUS,
    PROJECT_STATUS,
    uid,
    today,
    isDate,
    addDays,
    clone,
    parseMoney,
    moneyInput,
    parseQty,
    formatMoney,
    formatQty,
    validCurrency,
    defaultSettings,
    emptyData,
    migrate,
    backup,
    parseBackup,
    counts,
    createStore,
    lineAmount,
    totals,
    paidAmount,
    balance,
    invoiceStatus,
    buildIndex,
    metrics,
    nextNumber,
    upsert,
    saveItem,
    addMovement,
    adjustStock,
    saveDoc,
    convertQuote,
    fulfilOrder,
    startProject,
    issueStock,
    invoiceFromOrder,
    invoiceFromProject,
    recordPayment,
    deleteBlockers,
    removeRecord,
    toCSV,
    sampleData,
    normalizeSettings,
  };
})(typeof window !== 'undefined' ? window : globalThis);
