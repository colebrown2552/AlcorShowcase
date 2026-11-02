/*
 * Alcor motion. Reveals (the subbrands' data-reveal pattern), header glass, card spotlight.
 * Nothing is hidden until this script has already marked what is on screen, so a failed or
 * blocked script leaves the page fully visible.
 */
(function () {
  var d = document,
    root = d.documentElement;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var SKIP = '[class*="abr-"], [class*="ahub-"], [class*="amd-"]';
  var TEXT = [
    '.section-inner > .section-kicker',
    '.section-inner > h2',
    '.section-inner > .section-lede',
    '.about-grid .what-copy > *',
    '.closing-inner > .section-kicker',
    '.closing-inner > h2',
    '.price-group__title',
    '.client-work__copy > *',
    '.b2b-proof-copy > *',
    '.b2b-faq-layout > div > h2',
  ].join(',');
  var CARDS = [
    '.package',
    '.upgrade',
    '.product',
    '.audience-card',
    '.how-steps li',
    '.faq details',
    '.about-facts > *',
    '.b2b-card',
    '.b2b-example-panel',
    '.b2b-proof-stack article',
    '.b2b-process li',
    '.b2b-faq details',
    '.b2b-trust-band > div',
    '.client-work__shot',
  ].join(',');

  /* Header glass once the page leaves the top. */
  var header = d.querySelector('.site-header');
  if (header) {
    var ticking = false;
    var glass = function () {
      ticking = false;
      header.classList.toggle('is-scrolled', window.scrollY > 24);
    };
    window.addEventListener(
      'scroll',
      function () {
        if (!ticking) {
          ticking = true;
          requestAnimationFrame(glass);
        }
      },
      { passive: true },
    );
    glass();
  }

  /* Continuous decorative paint belongs only to a visible card. Pausing,
     rather than recreating animations, preserves phase on scroll and tab return.
     No JS/IntersectionObserver means the existing CSS remains the fallback. */
  var animatedCards = d.querySelectorAll('.package.is-featured');
  if (animatedCards.length && 'IntersectionObserver' in window) {
    var seenCards = new Set();
    var applyCardMotion = function () {
      animatedCards.forEach(function (el) {
        el.classList.toggle('ai-motion-paused', d.hidden || !seenCards.has(el));
      });
    };
    animatedCards.forEach(function (el) {
      el.classList.add('ai-motion-paused');
    });
    var cardMotionObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) seenCards.add(entry.target);
        else seenCards.delete(entry.target);
      });
      applyCardMotion();
    });
    animatedCards.forEach(function (el) {
      cardMotionObserver.observe(el);
    });
    d.addEventListener('visibilitychange', applyCardMotion);
    window.addEventListener('pageshow', applyCardMotion);
  }

  /* The floating quote button steps aside while an interactive demo is on screen. */
  var cta = d.querySelector('.mobile-cta');
  var demos = d.querySelectorAll('.alcor-demo-section .amd-monitor, .amd-showcase__stage');
  if (cta && demos.length && 'IntersectionObserver' in window) {
    var showing = new Set();
    var demoIo = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) showing.add(e.target);
          else showing.delete(e.target);
        });
        cta.classList.toggle('ai-cta-aside', showing.size > 0);
      },
      { threshold: 0.2 },
    );
    demos.forEach(function (el) {
      demoIo.observe(el);
    });
  }

  if (!reduced && 'IntersectionObserver' in window) {
    var targets = [];
    var tag = function (list, kind) {
      d.querySelectorAll(list).forEach(function (el) {
        if (el.closest(SKIP) || el.hasAttribute('data-ai-reveal')) return;
        el.setAttribute('data-ai-reveal', kind);
        /* Stagger siblings in a row: the second card arrives a beat after the first. */
        var i = 0,
          n = el;
        while ((n = n.previousElementSibling) && i < 5) if (n.matches(list)) i++;
        el.style.setProperty('--ai-i', i);
        targets.push(el);
      });
    };
    tag(TEXT, 'text');
    tag(CARDS, 'card');
    tag('.client-work__shot > img.client-work__phone', 'phone');

    var settle = function (el) {
      /* Once arrived, hand the element back to its own styles (hover transitions and all). */
      setTimeout(function () {
        el.removeAttribute('data-ai-reveal');
        el.style.removeProperty('--ai-i');
      }, 1400);
    };
    var inView = function (el) {
      var r = el.getBoundingClientRect();
      return r.top < window.innerHeight && r.bottom > 0;
    };
    targets.forEach(function (el) {
      if (inView(el)) {
        el.classList.add('is-in');
        settle(el);
      }
    });

    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-in');
          settle(entry.target);
          io.unobserve(entry.target);
        });
      },
      { rootMargin: '0px', threshold: 0 },
    );
    targets.forEach(function (el) {
      if (!el.classList.contains('is-in')) io.observe(el);
    });
    root.classList.add('ai-reveal');
  }

  /* Card spotlight follows the pointer (mouse only). */
  if (reduced || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  var SPOT = '.package, .upgrade, .product, .how-steps li';
  var frame = 0,
    card = null,
    x = 0,
    y = 0;
  d.addEventListener(
    'pointermove',
    function (event) {
      var target = event.target.closest && event.target.closest(SPOT);
      if (!target) return;
      card = target;
      x = event.clientX;
      y = event.clientY;
      if (frame) return;
      frame = requestAnimationFrame(function () {
        frame = 0;
        var box = card.getBoundingClientRect();
        card.style.setProperty('--mx', x - box.left + 'px');
        card.style.setProperty('--my', y - box.top + 'px');
      });
    },
    { passive: true },
  );
})();
