/**
 * site.js: Alcor Industries site behaviour.
 *
 * Page-level scripts shared by every page: quote-form prefill and the front-page
 * starfield. Each feature runs independently so one missing element never breaks another.
 */
(() => {
  // Quote prefill runs on every page; the starfield only where its
  // canvas exists (front page). Keep them independent so an interior
  // page never loses the form prefill to a missing canvas.
  // Cancel a pending handoff when the visitor has already moved on.
  // Anchor scrolling is preserved; only later focus is conditional.
  let quoteFocusTimer = null;
  const cancelQuoteFocus = () => {
    clearTimeout(quoteFocusTimer);
    quoteFocusTimer = null;
  };
  for (const type of ['pointerdown', 'keydown', 'focusin', 'input', 'wheel']) {
    document.addEventListener(type, cancelQuoteFocus, { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', cancelQuoteFocus);
  window.addEventListener('blur', cancelQuoteFocus);
  window.addEventListener('pagehide', cancelQuoteFocus);
  document.addEventListener('click', (event) => {
    const cta = event.target.closest('[data-build]');
    if (!cta) return;
    const form = document.querySelector('.alcor-contact');
    if (!form) return;
    const msg = form.querySelector('textarea[name="message"]');
    if (msg && !msg.value) msg.value = cta.getAttribute('data-build');
    cancelQuoteFocus();
    quoteFocusTimer = setTimeout(() => {
      quoteFocusTimer = null;
      if (!form.isConnected || document.hidden) return;
      const n = form.querySelector('input[name="name"]');
      if (n) n.focus({ preventScroll: true });
    }, 700);
  });

  // Small screens hide the header nav (site.css / landing.css); a
  // disclosure button opens it as a panel under the fixed header.
  document.querySelectorAll('.site-header').forEach((header, index) => {
    const nav = header.querySelector('.nav-links');
    if (!nav || header.querySelector('.nav-toggle')) return;
    if (!nav.id) nav.id = `site-nav-${index + 1}`;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'nav-toggle';
    toggle.setAttribute('aria-controls', nav.id);
    toggle.setAttribute('aria-expanded', 'false');
    const bars = document.createElement('span');
    bars.className = 'nav-toggle-bars';
    bars.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = 'Menu';
    toggle.append(bars, label);
    nav.before(toggle);

    // While the panel is open the page behind it is inert (main, footer and every other branch
    // outside the header), so Tab and screen readers stay in the menu. Only what we set is undone.
    let inerted = [];
    const setPageInert = (on) => {
      for (const el of inerted) el.inert = false;
      inerted = [];
      if (!on) return;
      for (let node = header; node && node !== document.body; node = node.parentElement) {
        for (const sibling of node.parentElement ? node.parentElement.children : []) {
          if (
            sibling === node ||
            sibling.inert ||
            /^(SCRIPT|STYLE|LINK|TEMPLATE)$/.test(sibling.tagName)
          )
            continue;
          sibling.inert = true;
          inerted.push(sibling);
        }
      }
    };
    const setOpen = (open, returnFocus) => {
      header.classList.toggle('nav-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      setPageInert(open);
      if (!open && returnFocus) toggle.focus();
    };
    const isOpen = () => header.classList.contains('nav-open');
    toggle.addEventListener('click', () =>
      setOpen(toggle.getAttribute('aria-expanded') !== 'true'),
    );
    nav.addEventListener('click', (event) => {
      if (event.target.closest('a')) setOpen(false);
    });
    // Escape closes from anywhere (focus may sit on the page after a click) and returns focus to the button.
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && isOpen()) {
        event.preventDefault();
        setOpen(false, true);
      }
    });
    // Focus trap: Tab cycles through the header's visible controls while the menu is open.
    header.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab' || !isOpen()) return;
      const items = [...header.querySelectorAll('a[href], button:not([disabled])')].filter(
        (el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden',
      );
      if (!items.length) return;
      const first = items[0],
        last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    document.addEventListener('click', (event) => {
      if (header.classList.contains('nav-open') && !header.contains(event.target)) setOpen(false);
    });
    // Widening the window past the breakpoint hides the button; drop the open state with it.
    window.addEventListener('resize', () => {
      if (header.classList.contains('nav-open') && !toggle.offsetParent) setOpen(false);
    });
    // Hide the inline links only after the menu has been initialized.
    // With scripts blocked or unavailable, the links remain accessible.
    header.classList.add('nav-ready');
  });

  // Product landings: the product switcher strip fades at its trailing edge while more products
  // sit off-screen, and the compact site menu (a <details>) closes on Escape or an outside click.
  document.querySelectorAll('.alcor-parent-bar__switcher').forEach((strip) => {
    const update = () =>
      strip.toggleAttribute(
        'data-scroll-end',
        strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 2,
      );
    update();
    strip.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update, { passive: true });
  });
  document.querySelectorAll('[data-alcor-site-menu]').forEach((menu) => {
    const summary = menu.querySelector('summary');
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !menu.open) return;
      menu.open = false;
      if (summary) summary.focus();
    });
    document.addEventListener('click', (event) => {
      if (menu.open && !menu.contains(event.target)) menu.open = false;
    });
  });

  // Keep native anchor navigation (including direct URL fragments) clear
  // of the header at mobile widths, enlarged text and after fonts load.
  // Measure after the menu button is inserted; its panel is absolute and
  // does not contribute to the closed header's height.
  const siteHeader = document.querySelector('.site-header');
  if (siteHeader) {
    const updateHeaderSpace = () => {
      document.documentElement.style.setProperty(
        '--site-header-height',
        `${Math.ceil(siteHeader.getBoundingClientRect().bottom)}px`,
      );
    };
    updateHeaderSpace();
    if ('ResizeObserver' in window) new ResizeObserver(updateHeaderSpace).observe(siteHeader);
    else window.addEventListener('resize', updateHeaderSpace, { passive: true });
  }

  const canvas = document.getElementById('starfieldCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return;
  let backdrop = null;
  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = motionPreference.matches;
  const state = {
    width: 1,
    height: 1,
    dpr: 1,
    stars: [],
    last: performance.now() - 34,
    rotation: 0,
    pointer: 0,
  };

  function random(min, max) {
    return min + Math.random() * (max - min);
  }

  function palette(index, alpha) {
    const colors = [
      [179, 140, 255],
      [255, 94, 196],
      [215, 181, 109],
      [83, 217, 212],
      [246, 240, 228],
    ];
    const color = colors[index % colors.length];
    return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    state.width = Math.max(1, Math.floor(rect.width));
    state.height = Math.max(1, Math.floor(rect.height));
    const mobile = state.width < 780;
    state.dpr = Math.min(mobile ? 1.5 : 2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(state.width * state.dpr);
    canvas.height = Math.floor(state.height * state.dpr);
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);

    const count = Math.min(
      900,
      Math.max(
        mobile ? 170 : 360,
        Math.round((state.width * state.height) / (mobile ? 4200 : 2400)),
      ),
    );
    const maxRadius = Math.max(state.width, state.height) * 0.72;
    state.stars = Array.from({ length: count }, (_, index) => ({
      angle: random(0, Math.PI * 2),
      radius: Math.pow(Math.random(), 0.7) * maxRadius + 20,
      size: random(0.45, 2.1),
      depth: random(0.3, 1),
      phase: random(0, Math.PI * 2),
      color: index,
    }));
    for (const star of state.stars) star.ink = palette(star.color, 0.18 + star.depth * 0.66);
    cacheBackdrop();
  }

  // The sky/glow depend only on canvas geometry, not time. Composite them
  // once per real resize rather than rasterizing two full-size gradients
  // on every animation frame. Keep alpha so the existing trails persist.
  function paintBackdrop(target) {
    const cx = state.width * (state.width > 780 ? 0.62 : 0.54);
    const cy = state.height * 0.46;
    target.fillStyle = 'rgba(3, 4, 7, 0.24)';
    target.fillRect(0, 0, state.width, state.height);

    const sky = target.createLinearGradient(0, 0, 0, state.height);
    sky.addColorStop(0, 'rgba(4, 5, 8, 0.9)');
    sky.addColorStop(0.38, 'rgba(43, 31, 64, 0.28)');
    sky.addColorStop(0.64, 'rgba(246, 240, 228, 0.18)');
    sky.addColorStop(1, 'rgba(5, 6, 8, 0.92)');
    target.fillStyle = sky;
    target.fillRect(0, 0, state.width, state.height);

    const glow = target.createRadialGradient(
      cx,
      cy,
      0,
      cx,
      cy,
      Math.max(state.width, state.height) * 0.58,
    );
    glow.addColorStop(0, 'rgba(246, 240, 228, 0.22)');
    glow.addColorStop(0.22, 'rgba(179, 140, 255, 0.18)');
    glow.addColorStop(0.46, 'rgba(255, 94, 196, 0.08)');
    glow.addColorStop(1, 'rgba(5, 6, 8, 0)');
    target.fillStyle = glow;
    target.fillRect(0, 0, state.width, state.height);
  }

  function cacheBackdrop() {
    if (typeof document.createElement !== 'function') return;
    const layer = document.createElement('canvas');
    layer.width = canvas.width;
    layer.height = canvas.height;
    const layerContext = layer.getContext('2d');
    if (!layerContext) {
      backdrop = null;
      return;
    }
    layerContext.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    paintBackdrop(layerContext);
    backdrop = layer;
  }

  function drawRuins(cx, horizon) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(5, 6, 8, 0.58)';
    const leftBase = state.width * 0.13;
    const rightBase = state.width * 0.86;
    ctx.beginPath();
    ctx.moveTo(leftBase, state.height);
    ctx.lineTo(leftBase + 50, horizon + 80);
    ctx.lineTo(leftBase + 118, state.height);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(rightBase, state.height);
    ctx.lineTo(rightBase - 70, horizon + 38);
    ctx.lineTo(rightBase - 34, state.height);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(179, 140, 255, 0.16)';
    ctx.fillRect(leftBase + 45, horizon + 110, 3, 190);
    ctx.fillRect(rightBase - 72, horizon + 86, 3, 220);
    ctx.restore();
  }

  function drawGeometry(cx, cy, time) {
    const size = Math.min(state.width, state.height) * 0.38;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-state.rotation * 0.34);
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 5; i += 1) {
      const r = size * (0.38 + i * 0.16);
      ctx.strokeStyle = `rgba(246, 240, 228, ${0.08 + i * 0.018})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.rotate(time * 0.00008);
    ctx.strokeStyle = 'rgba(255, 94, 196, 0.32)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i <= 3; i += 1) {
      const a = (Math.PI * 2 * i) / 3 - Math.PI / 2;
      const x = Math.cos(a) * size * 0.88;
      const y = Math.sin(a) * size * 0.58;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function draw(time) {
    raf = null;
    if (!visible || document.hidden) return;
    // The background moves slowly; 30 updates per second retain the effect
    // without repainting the full canvas at the display refresh rate.
    if (!reduced && time - state.last < 1000 / 30) {
      schedule();
      return;
    }
    const delta = Math.min(42, time - state.last);
    state.last = time;
    const speed = reduced ? 0.00004 : 0.00038 + state.pointer * 0.00018;
    state.rotation += delta * speed;
    state.pointer *= 0.94;

    const cx = state.width * (state.width > 780 ? 0.62 : 0.54);
    const cy = state.height * 0.46;
    const horizon = state.height * 0.63;

    ctx.globalCompositeOperation = 'source-over';
    if (backdrop) ctx.drawImage(backdrop, 0, 0, state.width, state.height);
    else paintBackdrop(ctx);

    drawGeometry(cx, cy, time);

    ctx.globalCompositeOperation = 'lighter';
    for (const star of state.stars) {
      const angle = star.angle + state.rotation * (0.72 + star.depth * 1.45);
      const trailAngle = angle - (0.05 + star.depth * 0.14) - state.pointer * 0.08;
      const wobble = Math.sin(time * 0.00018 + star.phase) * 12 * star.depth;
      const radius = star.radius + wobble;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius * 0.56;
      const px = cx + Math.cos(trailAngle) * radius;
      const py = cy + Math.sin(trailAngle) * radius * 0.56;
      ctx.strokeStyle = star.ink;
      ctx.lineWidth = star.size * (0.65 + star.depth);
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(x, y);
      ctx.stroke();
      if (star.size > 1.55) {
        ctx.fillStyle = star.ink;
        ctx.beginPath();
        ctx.arc(x, y, star.size * 0.72, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    drawRuins(cx, horizon);
    ctx.globalCompositeOperation = 'source-over';
    if (!reduced) schedule();
  }

  // iOS Safari fires resize when the URL bar collapses mid-scroll;
  // rebuilding the starfield then causes a visible stutter. Only
  // rebuild on real size changes, debounced.
  let lastW = 0,
    lastH = 0,
    resizeTimer = null;
  function guardedResize() {
    const w = window.innerWidth,
      h = window.innerHeight;
    if (w === lastW && Math.abs(h - lastH) < 160) return;
    lastW = w;
    lastH = h;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resize();
      if (reduced) schedule();
    }, 150);
  }

  // Stop burning frames when the hero is scrolled out of view.
  let visible = true,
    raf = null;
  function schedule() {
    if (visible && !document.hidden && raf === null) raf = requestAnimationFrame(draw);
  }
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      visible = entries[0].isIntersecting;
      if (!visible && raf !== null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
      if (visible) {
        state.last = performance.now() - 34;
        schedule();
      }
    }).observe(canvas);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && raf !== null) {
      cancelAnimationFrame(raf);
      raf = null;
    }
    if (!document.hidden) {
      state.last = performance.now() - 34;
      schedule();
    }
  });
  const onMotionChange = (event) => {
    reduced = event.matches;
    if (raf !== null) {
      cancelAnimationFrame(raf);
      raf = null;
    }
    state.last = performance.now() - 34;
    schedule();
  };
  if (motionPreference.addEventListener)
    motionPreference.addEventListener('change', onMotionChange);
  else if (motionPreference.addListener) motionPreference.addListener(onMotionChange);

  // Mobile sticky CTA: appears after the hero, hides at the form.
  const mobileCta = document.getElementById('mobileCta');
  const contactSection = document.getElementById('contact');
  if (mobileCta && 'IntersectionObserver' in window) {
    let heroGone = false,
      formVisible = false;
    const apply = () => mobileCta.classList.toggle('show', heroGone && !formVisible);
    new IntersectionObserver((e) => {
      heroGone = !e[0].isIntersecting;
      apply();
    }).observe(canvas);
    if (contactSection) {
      new IntersectionObserver((e) => {
        formVisible = e[0].isIntersecting;
        apply();
      }).observe(contactSection);
    }
  }

  window.addEventListener('resize', guardedResize);
  window.addEventListener(
    'pointermove',
    (event) => {
      state.pointer = reduced ? 0 : event.clientX / Math.max(1, window.innerWidth);
    },
    { passive: true },
  );
  lastW = window.innerWidth;
  lastH = window.innerHeight;
  resize();
  schedule();
})();
// Signature spotlight: project cards glow where the pointer is. Pure decoration;
// no effect on touch devices or when motion is reduced.
(() => {
  if (typeof document === 'undefined') return;
  const FLAIR =
    '.product, .package, .upgrade, .case-card, .audience-card, .b2b-card, .agx-cards > article, .agx-sites > li, .ahub-steps__list > li, .ap-lp-feature, .ap-lp-grid > article, .av-lp-card, .aq-feature, .am-feature, [data-flair-card]';
  const mark = () => {
    for (const card of document.querySelectorAll(FLAIR))
      if (!card.closest('[data-alcor-photo-editor], [data-alcor-video-editor], .aa-app'))
        card.classList.add('flair-card');
  };
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', mark, { once: true });
  else mark();
  if (
    !window.matchMedia?.('(hover: hover) and (pointer: fine)').matches ||
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  )
    return;
  let frame = 0,
    last = null;
  document.addEventListener(
    'pointermove',
    (event) => {
      last = event;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const card = last.target.closest?.('.flair-card');
        if (!card) return;
        const r = card.getBoundingClientRect();
        card.style.setProperty('--spot-x', `${last.clientX - r.left}px`);
        card.style.setProperty('--spot-y', `${last.clientY - r.top}px`);
      });
    },
    { passive: true },
  );
})();
// Homepage quote section (#contact): stars that twinkle on scroll and pointer movement (owner 10-29: "have the stars
// in the contact form twinkle on scroll or mouse move"). One canvas behind the section, pointer-events none (CSS in
// alcor-arcana.css section 20). Nothing runs on a timer: a scroll or pointer move over the section wakes a short
// requestAnimationFrame run (about 1.2 s) and the loop stops when it settles. Scroll drifts the stars with a little
// parallax and sets a few twinkling; stars near the pointer brighten. Listeners exist only while the section is
// within 200px of the viewport. Stars behind the text column are capped faint (form and body text keep >= 4.5:1);
// the gutters are brighter. Reduced motion: one still frame of faint stars. The sprite recipe is the /arcana/
// starfield's (creative-arcana.js section 2); its time-driven loop stays there.
(() => {
  const section = document.querySelector('body.home #contact.closing');
  if (!section || typeof IntersectionObserver === 'undefined') return;
  const canvas = document.createElement('canvas');
  canvas.className = 'quote-stars';
  canvas.setAttribute('aria-hidden', 'true');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  section.insertBefore(canvas, section.firstChild);
  const reduced = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const sprite = document.createElement('canvas');
  sprite.width = sprite.height = 32;
  const sc = sprite.getContext('2d');
  const glow = sc.createRadialGradient(16, 16, 0, 16, 16, 16);
  glow.addColorStop(0, 'rgba(255,252,242,1)');
  glow.addColorStop(0.14, 'rgba(255,247,226,.9)');
  glow.addColorStop(0.38, 'rgba(236,216,168,.2)');
  glow.addColorStop(1, 'rgba(215,181,109,0)');
  sc.fillStyle = glow;
  sc.fillRect(0, 0, 32, 32);
  // Seeded, so every visit (and every test run) draws the same sky.
  let seed = 0x2f6e2b1;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const COLUMN_ALPHA = 0.16; // brightest a star may be behind the text column (worst case still >= 4.5:1)
  const POINTER_R = 140;
  let stars = [],
    w = 0,
    h = 0,
    col = null,
    raf = 0,
    near = false,
    until = 0,
    last = 0;
  let pointer = null,
    glowK = 0,
    progress = 0,
    lastProgress = 0;
  const frames = { n: 0 };
  canvas.quoteStarFrames = frames; // read by tests/e2e/feedback-20261029/fb-quoteform.mjs (paused offscreen = no frames)
  function size() {
    const r = section.getBoundingClientRect();
    const nw = Math.max(1, Math.round(r.width)),
      nh = Math.max(1, Math.round(r.height));
    const inner = section.querySelector('.closing-inner');
    if (inner) {
      const c = inner.getBoundingClientRect();
      col = { l: c.left - r.left, r: c.right - r.left };
    }
    if (stars.length && nw === w && nh === h) {
      paint(performance.now());
      return;
    }
    w = nw;
    h = nh;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed = 0x2f6e2b1;
    const n = Math.min(160, Math.round((w * h) / 7000));
    stars = [];
    for (let i = 0; i < n; i++)
      stars.push({
        x: rnd() * w,
        y: rnd() * h,
        z: 0.3 + rnd() * 0.7,
        s: 2.2 + Math.pow(rnd(), 6) * 6,
        a: 0.35 + rnd() * 0.55,
        p: rnd() * 6.283,
        tw: 0,
        t0: 0,
      });
    paint(performance.now());
  }
  // 0 inside the text column, rising to 1 over 48px outside it.
  const edge = (x) => {
    if (!col) return 1;
    const d = Math.max(col.l - x, x - col.r);
    return d <= 0 ? 0 : Math.min(1, d / 48);
  };
  function paint(t) {
    frames.n++;
    ctx.clearRect(0, 0, w, h);
    const drift = reduced ? 0 : (progress - 0.5) * 36;
    for (const s of stars) {
      const x = s.x,
        y = s.y - drift * s.z;
      let k = 0.75 + 0.25 * Math.sin(s.p + progress * 9); // scroll turns each star's phase
      if (s.tw) {
        const e = (t - s.t0) / 900;
        if (e >= 1) s.tw = 0;
        else k += 0.9 * Math.sin(e * Math.PI);
      }
      let scale = 1;
      if (pointer && glowK > 0) {
        const d = Math.hypot(x - pointer.x, y - pointer.y);
        if (d < POINTER_R) {
          const q = (1 - d / POINTER_R) ** 2 * glowK;
          k += 1.1 * q;
          scale += 0.6 * q;
        }
      }
      const e = edge(x);
      const a = Math.min(s.a * k, COLUMN_ALPHA + (1 - COLUMN_ALPHA) * e);
      if (a <= 0.01) continue;
      const size = s.s * scale;
      ctx.globalAlpha = Math.min(1, a);
      ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
  }
  function frame(t) {
    raf = 0;
    if (!near) return;
    glowK += ((pointer ? 1 : 0) - glowK) * 0.12;
    paint(t);
    if (t < until || stars.some((s) => s.tw)) raf = requestAnimationFrame(frame);
  }
  function wake(ms) {
    if (reduced || !near) return;
    until = Math.max(until, performance.now() + ms);
    if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
  }
  function readProgress() {
    const r = section.getBoundingClientRect();
    progress = Math.min(
      1,
      Math.max(0, (window.innerHeight - r.top) / (window.innerHeight + r.height)),
    );
  }
  function onScroll() {
    readProgress();
    const dp = Math.abs(progress - lastProgress);
    if (dp > 0.01 && stars.length) {
      lastProgress = progress;
      const t = performance.now();
      for (let i = 0; i < 4; i++) {
        const s = stars[Math.floor(rnd() * stars.length)];
        if (!s.tw) {
          s.tw = 1;
          s.t0 = t;
        }
      }
    }
    wake(1200);
  }
  function onPointer(e) {
    const r = section.getBoundingClientRect();
    pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (rnd() < 0.08 && stars.length) {
      const s = stars[Math.floor(rnd() * stars.length)];
      if (!s.tw) {
        s.tw = 1;
        s.t0 = performance.now();
      }
    }
    wake(1200);
  }
  function onLeave() {
    pointer = null;
    wake(800);
  }
  function attach() {
    window.addEventListener('scroll', onScroll, { passive: true });
    section.addEventListener('pointermove', onPointer, { passive: true });
    section.addEventListener('pointerleave', onLeave, { passive: true });
  }
  function detach() {
    window.removeEventListener('scroll', onScroll);
    section.removeEventListener('pointermove', onPointer);
    section.removeEventListener('pointerleave', onLeave);
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    pointer = null;
    glowK = 0;
  }
  new IntersectionObserver(
    (entries) => {
      const on = entries[entries.length - 1].isIntersecting;
      if (on === near) return;
      near = on;
      if (near) {
        readProgress();
        lastProgress = progress;
        size();
        if (!reduced) attach();
      } else detach();
    },
    { rootMargin: '200px 0px' },
  ).observe(section);
  let timer = 0;
  const resized = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (near) size();
      else stars = [];
    }, 140);
  };
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resized).observe(section);
  else window.addEventListener('resize', resized, { passive: true });
})();

// A failed image stays broken until reload, and a deploy or a network blip can fail one for an instant. Retry on our own
// origin: twice, a little later each time. Lazy images inside closed sections fail late, so this listens for the whole visit.
(() => {
  const WAIT = [1000, 4000];
  const retry = (img) => {
    const n = Number(img.dataset.alcorRetry || 0),
      src = img.getAttribute('src');
    if (n >= WAIT.length || !src) return;
    try {
      if (new URL(src, location.href).origin !== location.origin) return;
    } catch (e) {
      return;
    }
    img.dataset.alcorRetry = String(n + 1);
    setTimeout(() => {
      const srcset = img.getAttribute('srcset');
      img.removeAttribute('srcset');
      img.setAttribute('src', src);
      if (srcset) img.setAttribute('srcset', srcset);
    }, WAIT[n]);
  };
  document.addEventListener(
    'error',
    (e) => {
      if (e.target && e.target.tagName === 'IMG') retry(e.target);
    },
    true,
  );
  // Images that failed before this script ran.
  document.querySelectorAll('img').forEach((img) => {
    if (img.complete && !img.naturalWidth && img.loading !== 'lazy') retry(img);
  });
})();
