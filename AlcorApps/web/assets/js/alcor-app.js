/**
 * alcor-app.js: AlcorApps shared runtime.
 *
 * The desktop-style shell shared by AlcorPhoto, AlcorVideo and AlcorMusic: title bar,
 * app tabs, menus, keyboard command routing and local project storage.
 * It has no network authority; each app owns its own engine.
 */
(() => {
  'use strict';
  const VERSION = '1.2.0';
  const clone = (v) =>
    typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, Number.isFinite(Number(v)) ? Number(v) : a));
  const uid = (p = 'item') =>
    `${p}-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
  const safeName = (v, f = 'alcor-project') =>
    String(v || f)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100) || f;
  const storage = () => {
    try {
      return globalThis.localStorage || null;
    } catch {
      return null;
    }
  };
  const download = (blob, name) => {
    if (!globalThis.document || !globalThis.URL?.createObjectURL)
      throw new Error('Browser download capability is unavailable.');
    const u = URL.createObjectURL(blob),
      a = document.createElement('a');
    a.href = u;
    a.download = String(name || 'alcor-project').replace(/[^a-z0-9._-]+/gi, '-');
    a.hidden = true;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 1000);
  };
  class Emitter {
    constructor() {
      this.m = new Map();
    }
    on(t, f) {
      if (typeof f !== 'function') throw new TypeError('listener must be a function');
      if (!this.m.has(t)) this.m.set(t, new Set());
      this.m.get(t).add(f);
      return () => this.m.get(t)?.delete(f);
    }
    emit(t, d) {
      for (const f of this.m.get(t) || [])
        try {
          f(d);
        } catch (e) {
          console.error('AlcorApp listener failed', e);
        }
    }
  }
  class ProjectStore {
    constructor(o = {}) {
      if (
        !o.schema ||
        !Number.isInteger(o.schemaVersion) ||
        typeof o.createProject !== 'function' ||
        typeof o.normalizeProject !== 'function'
      )
        throw new Error('Invalid ProjectStore contract.');
      this.o = o;
      this.h = [];
      this.f = [];
      this.e = new Emitter();
      this.s = o.storage === undefined ? storage() : o.storage;
      this.limit = clamp(o.historyLimit || 100, 1, 500);
      this.delay = clamp(o.autosaveDelay ?? 650, 0, 10000);
      this.timer = 0;
      this.project = this.norm(o.createProject());
    }
    norm(v) {
      const p = this.o.normalizeProject(clone(v));
      if (!p || p.schema !== this.o.schema || Number(p.schemaVersion) !== this.o.schemaVersion)
        throw new Error(`Unsupported ${this.o.schema} project.`);
      return p;
    }
    clean(v = this.project) {
      return this.o.sanitizeProject ? this.o.sanitizeProject(clone(v)) : clone(v);
    }
    snap() {
      return JSON.stringify(this.clean());
    }
    on(t, f) {
      return this.e.on(t, f);
    }
    state() {
      return Object.freeze({ canUndo: !!this.h.length, canRedo: !!this.f.length });
    }
    touch(label) {
      if ('updatedAt' in this.project) this.project.updatedAt = new Date().toISOString();
      this.e.emit('change', { label, project: this.project });
      this.e.emit('history', this.state());
      clearTimeout(this.timer);
      if (this.s) this.timer = setTimeout(() => this.save(true), this.delay);
    }
    mutate(label, fn) {
      const before = this.snap(),
        d = clone(this.project);
      fn(d);
      const next = this.norm(d),
        after = JSON.stringify(this.clean(next));
      if (before === after) return false;
      this.h.push(before);
      if (this.h.length > this.limit) this.h.shift();
      this.f = [];
      this.project = next;
      this.touch(label || 'Changed');
      return true;
    }
    replace(v, label = 'Opened project', history = true) {
      const before = this.snap(),
        next = this.norm(v);
      if (before === JSON.stringify(this.clean(next))) return false;
      if (history) this.h.push(before);
      else this.h = [];
      this.f = [];
      this.project = next;
      this.touch(label);
      return true;
    }
    replaceTransient(v, label = 'Changed selection') {
      const before = this.snap(),
        next = this.norm(v);
      if (before === JSON.stringify(this.clean(next))) return false;
      this.project = next;
      this.e.emit('change', { label, project: this.project });
      this.e.emit('history', this.state());
      return true;
    }
    undo() {
      if (!this.h.length) return false;
      this.f.push(this.snap());
      this.project = this.norm(JSON.parse(this.h.pop()));
      this.touch('Undo');
      return true;
    }
    redo() {
      if (!this.f.length) return false;
      this.h.push(this.snap());
      this.project = this.norm(JSON.parse(this.f.pop()));
      this.touch('Redo');
      return true;
    }
    save(auto = false) {
      if (!this.s) return false;
      try {
        this.s.setItem(
          this.o.storageKey || `${this.o.schema}.v${this.o.schemaVersion}`,
          JSON.stringify(this.clean()),
        );
        this.e.emit('saved', { automatic: auto });
        return true;
      } catch (e) {
        this.e.emit('status', { level: 'error', message: e.message });
        return false;
      }
    }
    load() {
      if (!this.s) return false;
      try {
        const x = this.s.getItem(this.o.storageKey || `${this.o.schema}.v${this.o.schemaVersion}`);
        if (!x) return false;
        this.project = this.norm(JSON.parse(x));
        this.h = [];
        this.f = [];
        this.e.emit('change', { label: 'Restored local project', project: this.project });
        return true;
      } catch {
        return false;
      }
    }
    openText(t) {
      if (typeof t !== 'string' || t.length > 10 * 1024 * 1024)
        throw new Error('Project file is invalid or unexpectedly large.');
      return this.replace(JSON.parse(t));
    }
    exportFile(name) {
      const ext = this.o.extension || '.json',
        fn = `${safeName(name || this.project.name)}${ext}`;
      download(
        new Blob([JSON.stringify(this.clean(), null, 2)], {
          type: this.o.mimeType || 'application/json',
        }),
        fn,
      );
      return fn;
    }
  }
  const PROFILES = Object.freeze({
    video: Object.freeze({
      key: 'video',
      name: 'AlcorVideo',
      route: '/alcor-video/',
      editor: '/video/',
      root: '[data-alcor-video-editor]',
      project: '#av-project-name',
      save: '#av-save-state',
      files: { open: '#av-project-file', import: '#av-media-input' },
      commands: {
        new: '[data-action="new-project"]',
        save: '[data-action="save-browser"]',
        project: '[data-action="export-project"]',
        undo: '[data-action="undo"]',
        redo: '[data-action="redo"]',
        delete: '[data-action="delete-selection"]',
        play: '[data-action="play"]',
        stop: '[data-action="jump-start"]',
        render: '[data-action="render"]',
      },
      exports: [['Render video', 'render']],
    }),
    music: Object.freeze({
      key: 'music',
      name: 'AlcorMusic',
      route: '/alcor-music/',
      editor: '/music/',
      root: '[data-alcor-music-editor]',
      project: '#am-project-name',
      save: '#am-save-state',
      files: { open: '#am-project-file', midi: '#am-midi-file' },
      commands: {
        new: '[data-action="new-project"]',
        save: '[data-action="save-browser"]',
        project: '[data-action="export-project"]',
        undo: '[data-action="undo"]',
        redo: '[data-action="redo"]',
        delete: '[data-action="delete-note"]',
        play: '[data-action="play"]',
        stop: '[data-action="stop"]',
        midi: '[data-action="export-midi"]',
        xml: '[data-action="export-musicxml"]',
        wav: '[data-action="export-wav"]',
        print: '[data-action="print-score"]',
      },
      exports: [
        ['Export MIDI', 'midi'],
        ['Export MusicXML', 'xml'],
        ['Render WAV', 'wav'],
        ['Print score', 'print'],
      ],
    }),
    photo: Object.freeze({
      key: 'photo',
      name: 'AlcorPhoto',
      route: '/photo/',
      editor: '/photo/',
      root: '[data-alcor-photo-editor]',
      project: '#ap-project-name',
      save: '#ap-save-state',
      files: { open: '#ap-project-file', import: '#ap-image-file' },
      commands: {
        new: '[data-action="new-project"]',
        save: '[data-action="save-browser"]',
        project: '[data-action="export-project"]',
        undo: '[data-action="undo"]',
        redo: '[data-action="redo"]',
        delete: '[data-action="delete-layer"]',
        export: '[data-action="export-image"]',
      },
      exports: [['Export image', 'export']],
    }),
  });
  const resolveProfile = (d = document) =>
    Object.values(PROFILES).find((p) => d.querySelector(p.root)) || null;
  // Shared commands delegate to the existing editor. Project/media state stays there.
  const isEditing = (n) =>
    Boolean(n?.isContentEditable || n?.closest?.('input,textarea,select,[role="textbox"]'));
  function mountShell(opts = {}) {
    const d = opts.document || globalThis.document;
    if (!d || d.querySelector('[data-alcor-app-shell]')) return null;
    const p = opts.profile || resolveProfile(d),
      root = p && d.querySelector(p.root);
    if (!p || !root) return null;
    const win = d.defaultView || globalThis,
      mac = /Mac|iPhone|iPad|iPod/i.test(win.navigator?.platform || ''),
      mod = mac ? '⌘' : 'Ctrl+';
    const local = root.hasAttribute('data-alcor-local-distribution');
    const free = p.key === 'photo' || p.key === 'video',
      el = (tag, cls = '', text = '') => {
        const n = d.createElement(tag);
        n.className = cls;
        n.textContent = text;
        return n;
      };
    const shell = el('div', 'aa-shell');
    shell.dataset.alcorAppShell = p.key;
    shell.innerHTML =
      '<div class="aa-shell-menubar" role="group" aria-label="Editor commands"></div>';
    const bar = shell.querySelector('.aa-shell-menubar'),
      actions = [],
      menus = [];
    const command = (label, command, key = '') => ({ label, command, key }),
      file = (label, file, key = '') => ({ label, file, key });
    const target = (a) => {
      const selector = a.file ? p.files?.[a.file] : p.commands?.[a.command];
      return selector ? root.querySelector(selector) : null;
    };
    const button = (a) => {
      const b = el('button', 'aa-menu-item');
      b.type = 'button';
      b.dataset.aaAction = String(a.index);
      b.append(el('span', 'aa-action-label', a.label));
      if (a.key) b.append(el('kbd', '', a.key));
      return b;
    };
    const addMenu = (label, entries) => {
      const q = el('details', 'aa-menu'),
        s = el('summary', '', label),
        panel = el('div', 'aa-menu-panel');
      panel.id = `aa-menu-${p.key}-${menus.length}`;
      s.setAttribute('aria-controls', panel.id);
      for (const entry of entries) {
        const a = { ...entry, group: label, index: actions.length };
        actions.push(a);
        panel.append(button(a));
      }
      q.append(s, panel);
      bar.append(q);
      menus.push(q);
    };
    addMenu('File', [
      command('New project', 'new', `${mod}N`),
      file('Open project…', 'open', `${mod}O`),
      ...(p.files.import
        ? [file(p.key === 'video' ? 'Import media…' : 'Import image…', 'import')]
        : []),
      ...(p.files.midi ? [file('Import MIDI…', 'midi')] : []),
      command('Download project', 'save', `${mod}S`),
    ]);
    addMenu('Edit', [
      command('Undo', 'undo', `${mod}Z`),
      command('Redo', 'redo', mac ? '⇧⌘Z' : 'Ctrl+Shift+Z'),
      command('Delete selection', 'delete'),
    ]);
    addMenu('View', [command('Compact interface', 'compact'), command('Fullscreen', 'fullscreen')]);
    if (p.commands.play || p.commands.stop)
      addMenu('Playback', [
        command('Play / Pause', 'play', 'Space'),
        command('Stop / Return', 'stop'),
      ]);
    addMenu(
      'Export',
      p.exports.map(([label, key]) => command(label, key)),
    );
    addMenu('Help', [
      command('Getting started', 'guide'),
      {
        label: local ? 'Local package information' : `${p.name} product page`,
        href: local ? '/' : p.route,
      },
      { label: local ? 'Local applications' : 'Alcor Industries', href: '/' },
    ]);
    const docBox = el('div', 'aa-shell-document'),
      docName = el('span', '', 'Untitled project'),
      saveState = el('span', 'aa-shell-state', 'Ready');
    docName.dataset.document = '';
    saveState.dataset.save = '';
    docBox.append(docName, saveState);
    bar.append(docBox);
    const find = el('button', 'aa-find-button', 'Find a command');
    find.type = 'button';
    find.setAttribute('aria-keyshortcuts', mac ? 'Meta+k' : 'Control+k');
    find.append(el('kbd', '', `${mod}K`));
    bar.append(find);
    if (free) {
      const badge = el('span', 'aa-free-badge', local ? 'DEVELOPMENT' : 'FREE');
      badge.title = local
        ? 'Local development package. Distribution terms are unresolved.'
        : 'Free editor and exports. No account required.';
      bar.append(badge);
    }
    const notice = el('span', 'aa-shell-notice');
    notice.setAttribute('role', 'status');
    bar.append(notice);
    d.documentElement.classList.add('alcor-app-mounted');
    root.classList.add('aa-product-root');
    root
      .querySelector(':scope > .av-site-header, :scope > .am-site-header, :scope > .ap-site-header')
      ?.setAttribute('data-alcor-legacy-header', 'true');
    root.prepend(shell);
    const currentMenus = () => Array.from(bar.querySelectorAll(':scope > details.aa-menu'));
    const closeMenus = (except = null) =>
      currentMenus().forEach((q) => {
        if (q !== except) q.open = false;
      });
    const allowed = (a) => {
      if (a.href || a.command === 'compact') return true;
      if (a.command === 'guide') return typeof d.createElement('dialog').showModal === 'function';
      if (a.command === 'fullscreen')
        return Boolean(d.fullscreenEnabled && d.documentElement.requestFullscreen);
      const n = target(a);
      return Boolean(
        n && !n.disabled && !n.matches(':disabled') && n.getAttribute('aria-disabled') !== 'true',
      );
    };
    const syncActions = () =>
      shell.querySelectorAll('[data-aa-action]').forEach((b) => {
        const a = actions[Number(b.dataset.aaAction)],
          disabled = !a || !allowed(a);
        if (b.disabled !== disabled) b.disabled = disabled;
        const t = disabled ? 'Not available for the current selection or browser.' : '';
        if (b.title !== t) b.title = t;
      });
    // Native modal: no page or editor shortcuts run while someone searches.
    let returnFocus = null;
    const dialog = el('dialog', 'aa-command-dialog');
    dialog.setAttribute('aria-labelledby', 'aa-command-title');
    const header = el('div', 'aa-dialog-heading'),
      title = el('h2', '', 'Find a command');
    title.id = 'aa-command-title';
    const dismiss = el('button', 'aa-dialog-close', 'Close');
    dismiss.type = 'button';
    header.append(title, dismiss);
    const label = el('label', 'aa-search-label', 'Search editor commands');
    label.htmlFor = 'aa-command-search';
    const search = el('input', 'aa-command-search');
    search.id = 'aa-command-search';
    search.type = 'search';
    search.maxLength = 80;
    search.autocomplete = 'off';
    search.spellcheck = false;
    search.placeholder = 'Try “export”, “undo”, or “import”';
    const results = el('div', 'aa-command-results');
    results.setAttribute('role', 'group');
    results.setAttribute('aria-label', 'Matching commands');
    const status = el('p', 'aa-result-status');
    status.setAttribute('role', 'status');
    const guide = el('div', 'aa-start-guide');
    guide.append(
      el(
        'p',
        'aa-guide-promise',
        local
          ? 'Local development editor. Download your work before closing.'
          : free
            ? 'Free editor. Free exports. No account required.'
            : 'Your project, using the existing editor controls.',
      ),
    );
    const steps =
      p.key === 'photo'
        ? [
            [
              'Start with a file',
              'Use File → Import image, or add text and shapes on the canvas. Your source file is not overwritten.',
            ],
            [
              'Make the edit',
              'Pick a tool from the strip beside the canvas (B brush, M marquee, W magic wand, ? lists every shortcut). Each edit is a History step you can undo.',
            ],
            [
              'Keep your work',
              'Download project makes a portable editable project with its referenced local image bytes when they fit the project limits. Export image makes the finished picture. Older metadata-only projects can still open but may need relinking.',
            ],
            [
              'Before you close',
              'Unsaved work is kept as a recovery copy in this browser only and offered back after a crash. It is not a cloud backup: download your project to keep it.',
            ],
          ]
        : p.key === 'video'
          ? [
              [
                'Start with your media',
                'Use File → Import media, then add a clip from the local bin to the timeline.',
              ],
              [
                'Build a short sequence',
                'Trim, split and arrange clips, add a title, and play the result before rendering. Undo is available for edits.',
              ],
              [
                'Project or finished video?',
                'Download project makes a portable editable project with the local media used by the edit. Render video makes the finished movie; when it finishes, choose Save rendered video. Older metadata-only projects can still open but may need relinking.',
              ],
              [
                'Before you close',
                'There is no autosave or cloud backup in this editor. Download the project first. Supported input and render formats depend on this browser.',
              ],
            ]
          : [
              ['Keep a project', 'Use the existing project controls to save your editable work.'],
              [
                'Make an export',
                'Choose a format from Export; available formats depend on this product.',
              ],
            ];
    const list = el('ol', 'aa-guide-steps');
    for (const [name, text] of steps) {
      const li = el('li');
      li.append(el('strong', '', name), el('p', '', text));
      list.append(li);
    }
    guide.append(list);
    if (free)
      guide.append(
        el(
          'p',
          'aa-guide-note',
          'Your media stays in this browser session. This guide does not upload, autosave, or collect it.',
        ),
      );
    guide.append(
      el(
        'p',
        'aa-guide-note',
        `${mod}K finds a command. ${mod}S downloads the project outside text fields. Escape closes this panel.`,
      ),
    );
    dialog.append(header, label, search, status, results, guide);
    shell.append(dialog);
    const paint = () => {
      const query = search.value.trim().toLowerCase().slice(0, 80),
        matches = actions.filter((a) => `${a.group} ${a.label}`.toLowerCase().includes(query));
      results.replaceChildren();
      for (const a of matches) {
        const b = button(a);
        b.prepend(el('small', 'aa-action-group', a.group));
        results.append(b);
      }
      status.textContent = matches.length
        ? `${matches.length} ${matches.length === 1 ? 'command' : 'commands'}. Unavailable actions are dimmed.`
        : 'No matching commands. Try “import”, “project”, or “export”.';
      syncActions();
    };
    const restoreFocus = () => {
      if (!returnFocus) return;
      const n = returnFocus;
      returnFocus = null;
      search.value = '';
      results.replaceChildren();
      if (n.isConnected) n.focus();
      else find.focus();
    };
    const openDialog = (mode, invoker) => {
      if (typeof dialog.showModal !== 'function') {
        notice.textContent =
          'This browser cannot open in-editor help. The File and Export menus still work.';
        return false;
      }
      if (!dialog.open)
        returnFocus = invoker?.closest?.('details')?.querySelector('summary') || invoker || find;
      closeMenus();
      guide.hidden = mode !== 'guide';
      search.hidden = label.hidden = results.hidden = status.hidden = mode === 'guide';
      title.textContent = mode === 'guide' ? `${p.name}: getting started` : 'Find a command';
      search.value = '';
      paint();
      if (!dialog.open) dialog.showModal();
      (mode === 'guide' ? dismiss : search).focus();
      return true;
    };
    dialog.addEventListener('close', () => {
      if (!dialog.open) restoreFocus();
    });
    dismiss.addEventListener('click', () => {
      dialog.close();
      restoreFocus();
    });
    find.addEventListener('click', () => openDialog('search', find));
    search.addEventListener('input', paint);
    const execute = (a, invoker) => {
      if (!a || !allowed(a)) return false;
      if (a.command === 'guide') return openDialog('guide', invoker);
      // Close before the file input click, synchronously, retaining user activation.
      if (dialog.open) {
        dialog.close();
        restoreFocus();
      }
      closeMenus();
      notice.textContent = '';
      let ok = false;
      try {
        if (a.href) {
          win.location.href = a.href;
          ok = true;
        } else if (a.command === 'compact') {
          root.classList.toggle('aa-compact');
          ok = true;
        } else if (a.command === 'fullscreen') {
          const pending = d.fullscreenElement
            ? d.exitFullscreen()
            : d.documentElement.requestFullscreen();
          Promise.resolve(pending).catch(
            () =>
              (notice.textContent =
                'Fullscreen was not allowed. You can keep editing in this window.'),
          );
          ok = true;
        } else {
          const n = target(a);
          if (n) {
            n.click();
            ok = true;
          }
        }
      } catch {
        notice.textContent = 'That action could not start. Try the editor control directly.';
      }
      // Handled means dispatched, never a claim that an export/save succeeded.
      root.dispatchEvent(
        new win.CustomEvent('alcorapp:command', {
          bubbles: true,
          detail: { app: p.key, command: a.command || a.file || '', handled: ok },
        }),
      );
      return ok;
    };
    shell.addEventListener('click', (e) => {
      const s = e.target.closest?.('.aa-menu > summary');
      if (s) {
        closeMenus(s.parentElement);
        syncActions();
        return;
      }
      const b = e.target.closest?.('[data-aa-action]');
      if (!b || b.disabled) return;
      const focus = b.closest('details')?.querySelector('summary');
      if (execute(actions[Number(b.dataset.aaAction)], b) && !dialog.open && focus) focus.focus();
    });
    const buttons = (parent) =>
      Array.from(parent.querySelectorAll('.aa-menu-item')).filter((b) => !b.disabled && !b.hidden);
    const focusAt = (nodes, i) => nodes.length && nodes[(i + nodes.length) % nodes.length].focus();
    d.addEventListener(
      'keydown',
      (e) => {
        if (dialog.open) {
          e.stopImmediatePropagation();
          if ((e.metaKey || e.ctrlKey) && ['s', 'n', 'o', 'k'].includes(e.key.toLowerCase()))
            e.preventDefault();
          if (e.key === 'Escape') {
            e.preventDefault();
            dialog.close();
            restoreFocus();
            return;
          }
          if (e.key === 'Tab') {
            const nodes = Array.from(dialog.querySelectorAll('button,input,a[href]')).filter(
                (n) => !n.disabled && !n.hidden && n.getClientRects().length,
              ),
              i = nodes.indexOf(d.activeElement);
            if (
              nodes.length &&
              ((e.shiftKey && i <= 0) || (!e.shiftKey && i === nodes.length - 1))
            ) {
              e.preventDefault();
              focusAt(nodes, e.shiftKey ? nodes.length - 1 : 0);
            }
          }
          if (!guide.hidden) return;
          const nodes = buttons(results);
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const i = nodes.indexOf(d.activeElement);
            focusAt(nodes, e.key === 'ArrowUp' ? (i < 0 ? nodes.length - 1 : i - 1) : i + 1);
          } else if (e.key === 'Enter' && e.target === search && !e.isComposing) {
            e.preventDefault();
            nodes[0]?.click();
          }
          return;
        }
        const q = e.target.closest?.('.aa-menu');
        if (q && shell.contains(q)) {
          const summary = q.querySelector('summary');
          if (['Enter', ' ', 'Delete', 'Backspace'].includes(e.key)) e.stopImmediatePropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopImmediatePropagation();
            closeMenus();
            summary.focus();
            return;
          }
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
            e.preventDefault();
            e.stopImmediatePropagation();
            closeMenus(q);
            q.open = true;
            syncActions();
            const nodes = buttons(q),
              i = nodes.indexOf(d.activeElement);
            focusAt(
              nodes,
              e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? nodes.length - 1
                  : e.key === 'ArrowUp'
                    ? i < 0
                      ? nodes.length - 1
                      : i - 1
                    : i + 1,
            );
            return;
          }
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            e.stopImmediatePropagation();
            const available = currentMenus(),
              next =
                available[
                  (available.indexOf(q) + (e.key === 'ArrowRight' ? 1 : -1) + available.length) %
                    available.length
                ],
              opened = q.open;
            closeMenus();
            next.open = opened;
            next.querySelector('summary').focus();
            return;
          }
        }
        if (
          shell.closest('[inert]') ||
          e.defaultPrevented ||
          e.isComposing ||
          e.repeat ||
          e.altKey ||
          isEditing(e.target) ||
          d.querySelector('dialog[open]') ||
          !(e.metaKey || e.ctrlKey)
        )
          return;
        const k = e.key.toLowerCase();
        if (k === 'k') {
          e.preventDefault();
          e.stopImmediatePropagation();
          openDialog('search', d.activeElement);
          return;
        }
        if (e.shiftKey) return;
        const a = actions.find((x) =>
          k === 's'
            ? x.command === 'save'
            : k === 'n'
              ? x.command === 'new'
              : k === 'o'
                ? x.file === 'open'
                : false,
        );
        if (a) {
          e.preventDefault();
          e.stopImmediatePropagation();
          execute(a, d.activeElement);
        }
      },
      true,
    );
    d.addEventListener('pointerdown', (e) => {
      if (!bar.contains(e.target)) closeMenus();
    });
    // Close on a real new outside focus, not a delayed blur that can close a newly opened menu.
    d.addEventListener('focusin', (e) => {
      if (!bar.contains(e.target)) closeMenus();
    });
    // Observe original controls, not mirror attributes, avoiding mutation loops.
    if (win.MutationObserver) {
      const observer = new win.MutationObserver(syncActions);
      for (const n of new Set(actions.map(target).filter(Boolean)))
        observer.observe(n, { attributes: true, attributeFilter: ['disabled', 'aria-disabled'] });
    }
    const input = root.querySelector(p.project),
      doc = shell.querySelector('[data-document]'),
      save = root.querySelector(p.save),
      out = shell.querySelector('[data-save]');
    const sync = () => (doc.textContent = (input?.value || 'Untitled project').slice(0, 80));
    sync();
    input?.addEventListener('input', sync);
    if (save && win.MutationObserver) {
      const observer = new win.MutationObserver(() => {
        out.textContent = (save.textContent || 'Ready').slice(0, 60);
        syncActions();
      });
      observer.observe(save, { subtree: true, childList: true, characterData: true });
      out.textContent = (save.textContent || 'Ready').slice(0, 60);
    }
    syncActions();
    root.dispatchEvent(
      new win.CustomEvent('alcorapp:mounted', {
        bubbles: true,
        detail: { app: p.key, version: VERSION },
      }),
    );
    return Object.freeze({ profile: p, shell });
  }
  function capabilities() {
    return Object.freeze({
      localStorage: !!storage(),
      webAudio: !!(globalThis.AudioContext || globalThis.webkitAudioContext),
      offlineAudio: !!(globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext),
      webMidi: !!globalThis.navigator?.requestMIDIAccess,
      canvas: !!globalThis.HTMLCanvasElement,
      printing: typeof globalThis.print === 'function',
    });
  }
  globalThis.AlcorApp = Object.freeze({
    version: VERSION,
    ProjectStore,
    createProjectStore: (o) => new ProjectStore(o),
    mountShell,
    resolveProfile,
    profiles: PROFILES,
    detectCapabilities: capabilities,
    utils: Object.freeze({ clone, clamp, uid, safeName, download }),
  });
  if (globalThis.document) {
    const boot = () => mountShell();
    if (document.readyState === 'loading')
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
  }
})();
