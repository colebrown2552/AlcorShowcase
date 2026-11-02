/*
 * AlcorFrame: turns an editor that carries the data-af-* contract into the phone layout in
 * alcor-frame.css. It adds its own chrome (top bar, panel tabs, sheet bar, drawer scrim) and only
 * toggles classes on the editor's elements. It never moves, clones or rewires them: the top-bar
 * buttons forward clicks to the editor's own controls, so every existing listener keeps working.
 */
(function () {
  var d = document,
    html = d.documentElement;
  var app = d.querySelector('[data-af-app]');
  if (!app || !app.querySelector('[data-af-stage]')) return;

  var phone = window.matchMedia('(max-width: 760px)');
  var panels = [].slice.call(app.querySelectorAll('[data-af-panel]'));
  var menu = app.querySelector('[data-af-menu]');
  var dock = app.querySelector('[data-af-dock]');
  var primary = app.querySelector('[data-af-primary]');
  var built = false,
    open = null,
    lastFocus = null;

  var ICON = {
    menu: '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    undo: '<svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
    redo: '<svg viewBox="0 0 24 24"><path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    expand: '<svg viewBox="0 0 24 24"><path d="m6 15 6-6 6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
  };
  var el = function (tag, cls, htmlText) {
    var n = d.createElement(tag);
    if (cls) n.className = cls;
    if (htmlText != null) n.innerHTML = htmlText;
    return n;
  };
  var btn = function (cls, label, icon) {
    var b = el('button', 'af-btn ' + (cls || ''), icon || '');
    b.type = 'button';
    b.setAttribute('aria-label', label);
    if (!icon) b.textContent = label;
    return b;
  };
  var refit = function () {
    window.dispatchEvent(new Event('resize'));
  };
  var afterMove = function () {
    setTimeout(refit, 340);
  };

  /* Forward a tap to the editor's own control and mirror its disabled state. The control is looked up
     again whenever the editor changes its markup, since editors add parts of the contract late. */
  function proxy(button, find) {
    var target = null,
      watcher = null;
    var sync = function () {
      button.disabled = !!(
        target &&
        (target.disabled || target.getAttribute('aria-disabled') === 'true')
      );
    };
    button.addEventListener('click', function () {
      if (target && !target.disabled) target.click();
    });
    button._bind = function () {
      var next = find();
      button.hidden = !next;
      if (next === target) return;
      if (watcher) watcher.disconnect();
      target = next;
      if (target) {
        watcher = new MutationObserver(sync);
        watcher.observe(target, {
          attributes: true,
          attributeFilter: ['disabled', 'aria-disabled'],
        });
      }
      sync();
    };
    button._bind();
  }

  /* Editors hide inactive dock panels (display:none or [hidden]); a sheet shows its panel while open
     and hands the editor's own state back when it closes. */
  function reveal(p, on) {
    if (on) {
      if (p.hidden) {
        p.hidden = false;
        p.dataset.afWasHidden = '1';
      }
      p.classList.toggle('af-force-show', getComputedStyle(p).display === 'none');
      /* A hidden container (AlcorPhoto hides its whole dock on phones) would hide the sheet too:
         render it, still invisible, while this panel is open. */
      for (var n = p.parentElement; n && n !== app; n = n.parentElement) {
        if (getComputedStyle(n).display === 'none') n.classList.add('af-force-anc');
      }
    } else {
      p.classList.remove('af-force-show');
      if (p.dataset.afWasHidden) {
        p.hidden = true;
        delete p.dataset.afWasHidden;
      }
    }
  }

  function setSheet(panel, size) {
    if (panel && unclipQueued) unclip();
    html.classList.remove('af-sheet-half', 'af-sheet-full');
    app.querySelectorAll('.af-force-anc').forEach(function (n) {
      n.classList.remove('af-force-anc');
    });
    panels.forEach(function (p) {
      p.classList.toggle('af-open', p === panel);
      reveal(p, p === panel);
    });
    tabs.querySelectorAll('.af-tab').forEach(function (t) {
      t.setAttribute('aria-expanded', String(t._panel === panel));
    });
    open = panel;
    if (panel) {
      html.classList.add(size === 'full' ? 'af-sheet-full' : 'af-sheet-half');
      sheetTitle.textContent = panel.getAttribute('data-af-label') || '';
      sheetSize.innerHTML = size === 'full' ? ICON.down : ICON.expand;
      sheetSize.setAttribute(
        'aria-label',
        size === 'full' ? 'Make panel smaller' : 'Make panel larger',
      );
    }
    afterMove();
  }

  function setDrawer(on) {
    if (!menu) return;
    if (on && unclipQueued) unclip();
    html.classList.toggle('af-drawer-open', on);
    menuBtn.setAttribute('aria-expanded', String(on));
    if (on) {
      lastFocus = d.activeElement;
      var f = menu.querySelector('button, a, [tabindex]');
      if (f) f.focus();
    } else if (lastFocus) lastFocus.focus();
  }

  /* ---------- chrome ---------- */
  var top = el('div', 'af-chrome af-top');
  var menuBtn = btn('', 'Menu', ICON.menu);
  menuBtn.setAttribute('aria-expanded', 'false');
  var title = el('div', 'af-title');
  var appName = app.getAttribute('data-af-app') || '';
  title.innerHTML =
    '<small>Alcor' + appName.charAt(0).toUpperCase() + appName.slice(1) + '</small><span></span>';
  var nameInput = app.querySelector('[data-af-title]');
  var syncTitle = function () {
    title.lastChild.textContent = nameInput
      ? (nameInput.value || nameInput.textContent || '').trim()
      : '';
  };
  if (nameInput) {
    syncTitle();
    nameInput.addEventListener('input', syncTitle);
    new MutationObserver(syncTitle).observe(nameInput, {
      characterData: true,
      childList: true,
      subtree: true,
    });
  }
  top.appendChild(menuBtn);
  top.appendChild(title);
  var proxies = [];
  /* Optional secondary control (AlcorPhoto's "Basic" switch), forwarded like Export. */
  var secondaryBtn = btn('af-secondary', 'Switch');
  proxy(secondaryBtn, function () {
    return app.querySelector('[data-af-secondary]');
  });
  top.appendChild(secondaryBtn);
  proxies.push(secondaryBtn);
  function labelSecondary() {
    var s = app.querySelector('[data-af-secondary]');
    if (!s) return;
    secondaryBtn.setAttribute(
      'aria-label',
      (
        s.getAttribute('data-af-label-long') ||
        s.getAttribute('aria-label') ||
        s.textContent ||
        ''
      ).trim(),
    );
    secondaryBtn.textContent = (s.getAttribute('data-af-short') || s.textContent || '').trim();
  }
  ['undo', 'redo'].forEach(function (a) {
    var b = btn('', a === 'undo' ? 'Undo' : 'Redo', ICON[a]);
    proxy(b, function () {
      return app.querySelector('[data-af-action="' + a + '"]');
    });
    top.appendChild(b);
    proxies.push(b);
  });
  var primaryBtn = btn('af-primary', 'Export');
  proxy(primaryBtn, function () {
    return app.querySelector('[data-af-primary]');
  });
  top.appendChild(primaryBtn);
  proxies.push(primaryBtn);
  function labelPrimary() {
    primary = app.querySelector('[data-af-primary]');
    if (!primary) return;
    primaryBtn.setAttribute(
      'aria-label',
      (primary.getAttribute('aria-label') || primary.textContent || 'Export').trim(),
    );
    primaryBtn.textContent = (
      primary.getAttribute('data-af-short') ||
      primary.textContent ||
      'Export'
    ).trim();
  }

  var tabs = el('nav', 'af-chrome af-tabs');
  tabs.setAttribute('aria-label', 'Panels');
  function addTab(panel, i) {
    /* Dialogs are opened by the editor's own actions (Export in the top bar), not from a tab. */
    if (panel._afTab || isModal(panel)) return;
    if (!panel.id) panel.id = 'af-panel-' + (panel.getAttribute('data-af-panel') || i);
    panel.setAttribute('role', panel.getAttribute('role') || 'region');
    panel.setAttribute(
      'aria-label',
      panel.getAttribute('data-af-label') || panel.getAttribute('data-af-panel'),
    );
    var t = el('button', 'af-tab', '<i aria-hidden="true"></i><span></span>');
    t.type = 'button';
    t._panel = panel;
    t.lastChild.textContent =
      panel.getAttribute('data-af-label') || panel.getAttribute('data-af-panel');
    t.setAttribute('aria-controls', panel.id);
    t.setAttribute('aria-expanded', 'false');
    t.addEventListener('click', function () {
      setSheet(open === panel ? null : panel, 'half');
    });
    tabs.appendChild(t);
    panel._afTab = t;
  }

  /* A panel that is also the editor's dialog (AlcorVideo's export dialog is data-af-panel="export")
     opens as a full sheet when the editor shows it, and closes when the editor hides it. */
  function isModal(p) {
    return (
      p.getAttribute('role') === 'dialog' ||
      p.getAttribute('aria-modal') === 'true' ||
      p.tagName === 'DIALOG'
    );
  }
  function watchModal(p) {
    if (p._afModal || !isModal(p)) return;
    p._afModal = true;
    new MutationObserver(function () {
      if (!html.classList.contains('af-on') || p.dataset.afWasHidden) return;
      var shown = !p.hidden && (p.tagName !== 'DIALOG' || p.open);
      if (shown && open !== p) {
        p._afByEditor = true;
        setSheet(p, 'full');
      } else if (!shown && open === p) {
        p._afByEditor = false;
        setSheet(null);
      }
    }).observe(p, { attributes: true, attributeFilter: ['hidden', 'open'] });
  }
  /* Closing our sheet over an editor-opened dialog uses the dialog's own close control. */
  function closeModal(p) {
    var own = p.querySelector(
      '[data-action$="close"], [data-action="cancel"], [aria-label="Close"], .av-export-close',
    );
    if (own) own.click();
    else p.hidden = true;
  }

  /* Pick up the contract as it is now: editors add their menu, panels and tools after first paint. */
  function scan() {
    panels = [].slice.call(app.querySelectorAll('[data-af-panel]'));
    panels.forEach(addTab);
    panels.forEach(watchModal);
    tabs.querySelectorAll('.af-tab').forEach(function (t) {
      if (!app.contains(t._panel)) t.remove();
    });
    menu = app.querySelector('[data-af-menu]');
    menuBtn.hidden = !menu;
    if (menu) {
      if (!menu.id) menu.id = 'af-menu';
      menuBtn.setAttribute('aria-controls', menu.id);
    }
    dock = app.querySelector('[data-af-dock]');
    labelPrimary();
    labelSecondary();
    proxies.forEach(function (b) {
      b._bind();
    });
    if (built) nameTools();
    if (built && html.classList.contains('af-on')) {
      html.classList.toggle('af-has-dock', !!dock);
      unclipSoon();
    }
  }

  var sheetBar = el('div', 'af-chrome af-sheet-bar');
  var sheetTitle = el('strong');
  var sheetSize = btn('', 'Make panel larger', ICON.expand);
  var sheetClose = btn('', 'Close panel', ICON.close);
  sheetBar.appendChild(sheetTitle);
  sheetBar.appendChild(sheetSize);
  sheetBar.appendChild(sheetClose);
  sheetSize.addEventListener('click', function () {
    setSheet(open, html.classList.contains('af-sheet-full') ? 'half' : 'full');
  });
  function closeSheet() {
    if (open && open._afByEditor) closeModal(open);
    else setSheet(null);
  }
  sheetClose.addEventListener('click', closeSheet);
  /* Drag the bar: up past 60px goes full, down past 60px closes (or drops full to half). */
  var y0 = null;
  sheetBar.addEventListener('pointerdown', function (e) {
    if (e.target.closest('button')) return;
    y0 = e.clientY;
    sheetBar.setPointerCapture(e.pointerId);
  });
  sheetBar.addEventListener('pointerup', function (e) {
    if (y0 == null) return;
    var dy = e.clientY - y0;
    y0 = null;
    var full = html.classList.contains('af-sheet-full');
    if (dy < -60) setSheet(open, 'full');
    else if (dy > 60) setSheet(full ? open : null, 'half');
  });

  var dockBar = el('div', 'af-chrome af-dock-bar', '<span>Timeline</span>');
  var dockToggle = btn('', 'Collapse timeline', ICON.down);
  dockBar.appendChild(dockToggle);
  dockToggle.addEventListener('click', function () {
    var c = html.classList.toggle('af-dock-collapsed');
    dockToggle.innerHTML = c ? ICON.expand : ICON.down;
    dockToggle.setAttribute('aria-label', c ? 'Expand timeline' : 'Collapse timeline');
    afterMove();
  });

  var drawerHead = el('div', 'af-chrome af-drawer-head', '<span>MENU</span>');
  var drawerClose = btn('', 'Close menu', ICON.close);
  drawerHead.appendChild(drawerClose);
  var scrim = el('div', 'af-chrome af-scrim');
  menuBtn.addEventListener('click', function () {
    setDrawer(!html.classList.contains('af-drawer-open'));
  });
  drawerClose.addEventListener('click', function () {
    setDrawer(false);
  });
  scrim.addEventListener('click', function () {
    setDrawer(false);
  });
  /* A menu command that opens a dialog or runs an action should also close the drawer. */
  if (menu)
    menu.addEventListener('click', function (e) {
      if (e.target.closest('[role="menuitem"], a[href], [data-af-closes]')) setDrawer(false);
    });

  d.addEventListener('keydown', function (e) {
    if (!html.classList.contains('af-on') || e.key !== 'Escape') return;
    if (html.classList.contains('af-drawer-open')) setDrawer(false);
    else if (open) closeSheet();
  });

  /* An ancestor with transform, filter or backdrop-filter becomes the containing block for fixed
     children (AlcorPhoto's sticky blurred shell squeezed the menu drawer into it). Mark those
     ancestors so the frame can neutralise them in phone mode only. */
  /* Speed: computed-style reads force layout (the AlcorPhoto agent measured 300-400 ms under 4x CPU
     when this ran on every rescan). Each ancestor is read at most once, parts already handled are
     skipped, the first pass waits for an idle moment, and opening the drawer or a sheet runs any
     pending pass first so nothing can be squeezed. */
  var checked = typeof WeakSet === 'function' ? new WeakSet() : null,
    unclipQueued = false;
  function unclip() {
    unclipQueued = false;
    app
      .querySelectorAll(
        '[data-af-stage], [data-af-menu], [data-af-toolbar], [data-af-panel], [data-af-dock]',
      )
      .forEach(function (part) {
        if (part._afUnclipped) return;
        part._afUnclipped = true;
        for (var n = part.parentElement; n && n !== d.body; n = n.parentElement) {
          if (checked) {
            if (checked.has(n)) break;
            checked.add(n);
          }
          var cs = getComputedStyle(n);
          if (
            cs.transform !== 'none' ||
            cs.filter !== 'none' ||
            (cs.backdropFilter && cs.backdropFilter !== 'none') ||
            (cs.webkitBackdropFilter && cs.webkitBackdropFilter !== 'none') ||
            cs.perspective !== 'none' ||
            /paint|layout|strict|content/.test(cs.contain || '') ||
            /transform|filter/.test(cs.willChange || '') ||
            /* content-visibility:auto adds paint containment: a fixed sheet inside it is clipped to it (or skipped). */
            (cs.contentVisibility && cs.contentVisibility !== 'visible') ||
            (cs.containerType && cs.containerType !== 'normal')
          )
            n.classList.add('af-unclip');
        }
      });
  }
  function unclipSoon() {
    if (unclipQueued) return;
    unclipQueued = true;
    (
      window.requestIdleCallback ||
      function (f) {
        return setTimeout(f, 60);
      }
    )(
      function () {
        if (unclipQueued) unclip();
      },
      { timeout: 400 },
    );
  }

  /* Tool buttons that show only a shortcut letter ("V") get their name under it, from their own title. */
  function nameTools() {
    app.querySelectorAll('[data-af-toolbar] button').forEach(function (b) {
      var text = (b.textContent || '').trim();
      var label = b.getAttribute('title') || b.getAttribute('aria-label') || '';
      /* Letter-only tools, or an icon plus a one-letter key cap (AlcorVideo), get their name. */
      if (text.length >= 1 && text.length <= 2 && label) {
        b.setAttribute(
          'data-af-name',
          label.replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+tool$/i, ''),
        );
      }
    });
  }

  /* An editor can hand the phone screen to its own simpler UI (AlcorPhoto Basic) with data-af-off. */
  function apply() {
    var on = phone.matches && !app.hasAttribute('data-af-off');
    if (on && !built) {
      [top, tabs, sheetBar, dockBar, drawerHead, scrim].forEach(function (n) {
        app.appendChild(n);
      });
      nameTools();
      built = true;
    }
    if (on) unclipSoon();
    html.classList.toggle('af-on', on);
    html.classList.toggle('af-has-dock', on && !!dock);
    if (!on) {
      setDrawer(false);
      setSheet(null);
      html.classList.remove('af-sheet-half', 'af-sheet-full');
    }
    [top, tabs, sheetBar, dockBar, drawerHead, scrim].forEach(function (n) {
      n.hidden = !on;
    });
    afterMove();
  }
  scan();
  /* Rescan (debounced) when the editor adds or retags parts of the contract; our own chrome is ignored. */
  var scanTimer = 0;
  new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var t = records[i].target;
      if (t.nodeType === 1 && t.closest('.af-chrome')) continue;
      clearTimeout(scanTimer);
      scanTimer = setTimeout(scan, 120);
      return;
    }
  }).observe(app, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      'data-af-menu',
      'data-af-panel',
      'data-af-toolbar',
      'data-af-dock',
      'data-af-primary',
      'data-af-secondary',
      'data-af-action',
      'data-af-label',
    ],
  });

  new MutationObserver(apply).observe(app, { attributes: true, attributeFilter: ['data-af-off'] });
  if (phone.addEventListener) phone.addEventListener('change', apply);
  else phone.addListener(apply);
  apply();
})();
