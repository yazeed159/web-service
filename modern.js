/* modern.js — additive interactivity layer.
 * Safe by design: only ever *adds* classes/listeners to elements
 * that already exist. Never touches app.js/trade.js/etc. state. */
(function () {
  'use strict';
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- 1. Scroll-reveal for panels/cards ---------- */
  function initReveal() {
    if (reduced || !('IntersectionObserver' in window)) return;
    var targets = document.querySelectorAll(
      '.panel-box, .card, .chart-panel, .equity-panel, .day-group, .playbook-card, .highlight-card'
    );
    if (!targets.length) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry, i) {
        if (entry.isIntersecting) {
          var el = entry.target;
          setTimeout(function () { el.classList.add('reveal-in'); }, Math.min(i * 40, 240));
          io.unobserve(el);
        }
      });
    }, { threshold: 0, rootMargin: '0px 0px -40px 0px' });
    targets.forEach(function (el) {
      if (el.dataset.revealBound) return; // boot() can run more than once
      el.dataset.revealBound = '1';
      // Elements that start (or are later toggled) display:none -- like
      // #bt-progress-box, hidden until a backtest starts -- report a 0x0
      // box here and can never satisfy the IntersectionObserver once
      // they're shown, since they aren't "scrolled into view" so much as
      // switched on by other JS. Binding them anyway meant they sat at
      // opacity:0 (from .reveal-init) until the 1800ms safety net caught
      // up -- so clicking "Run Backtest" soon after page load unhid an
      // invisible box, looking like the page had emptied out. Skip
      // reveal-on-scroll for anything not actually laid out right now;
      // it'll just render normally (opacity:1) whenever it's shown.
      if (getComputedStyle(el).display === 'none') return;
      // Tall content (e.g. a 300+ row table inside a panel) can be so much
      // taller than the viewport that it never satisfies an area-based
      // threshold. Only defer elements short enough to plausibly start
      // off-screen; anything else just reveals immediately.
      if (el.getBoundingClientRect().height > window.innerHeight * 1.2) return;
      el.classList.add('reveal-init');
      io.observe(el);
    });
    // Safety net: never leave anything stuck invisible (e.g. content that
    // grows taller than the viewport only after app.js populates it async).
    setTimeout(function () {
      document.querySelectorAll('.reveal-init:not(.reveal-in)').forEach(function (el) {
        el.classList.add('reveal-in');
      });
    }, 1800);
  }

  /* ---------- 2. Ripple on click for buttons ---------- */
  function initRipple() {
    if (reduced) return;
    var selector = '.filter-btn, .icon-btn, .cal-nav-btn, .sidebar-toggle, .nav-item, .btn-advanced, .btn-confirm, .btn-danger, .btn-icon, .sr-run-btn, .toptab-btn, .pp-order-btn, .quiz-answer-btn, .quiz-mode-btn, .quiz-preset-btn, .qz-speed-btn, .quiz-speed-btn, .pr-candidate-row';
    document.addEventListener('click', function (e) {
      var el = e.target.closest(selector);
      if (!el) return;
      var rect = el.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var y = e.clientY - rect.top;
      // Radius reaches the button's farthest corner from the click point.
      // Using rect.width/height directly (the old approach) blew the
      // ripple way past the button on wide, short controls like the
      // report tab bar -- the circle ballooned way beyond the button.
      var radius = Math.sqrt(Math.pow(Math.max(x, rect.width - x), 2) + Math.pow(Math.max(y, rect.height - y), 2));
      var size = radius * 2;
      var span = document.createElement('span');
      span.className = 'ripple';
      span.style.width = span.style.height = size + 'px';
      span.style.left = (x - radius) + 'px';
      span.style.top = (y - radius) + 'px';
      var prevPos = getComputedStyle(el).position;
      if (prevPos === 'static') el.style.position = 'relative';
      if (getComputedStyle(el).overflow === 'visible') el.style.overflow = 'hidden';
      el.appendChild(span);
      span.addEventListener('animationend', function () { span.remove(); });
    }, true);
  }

  /* ---------- 3. Flash numeric values when app.js updates them ---------- */
  function initValueFlash() {
    if (reduced || !('MutationObserver' in window)) return;
    var selector = '.stat .value, .pnl-breakdown .cell .value, .streak-strip .cell .value, ' +
      '.cal-summary-strip .cell .value, .equity-head .value, .score-gauge .num, .pb-value';
    var seen = new WeakMap();
    var mo = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        var el = m.target.nodeType === 3 ? m.target.parentElement : m.target;
        if (!el || !el.matches || !el.matches(selector)) return;
        var text = el.textContent;
        if (seen.get(el) === text) return;
        seen.set(el, text);
        el.classList.remove('value-settled');
        void el.offsetWidth;
        el.classList.add('value-settled');
      });
    });
    document.querySelectorAll(selector).forEach(function (el) {
      seen.set(el, el.textContent);
      mo.observe(el, { childList: true, characterData: true, subtree: true });
    });
  }

  /* ---------- 4. Subtle magnetic tilt on stat cards (desktop only) ---------- */
  function initTilt() {
    if (reduced || window.matchMedia('(pointer: coarse)').matches) return;
    document.querySelectorAll('.stat, .highlight-card').forEach(function (card) {
      card.addEventListener('mousemove', function (e) {
        var r = card.getBoundingClientRect();
        var x = (e.clientX - r.left) / r.width - 0.5;
        var y = (e.clientY - r.top) / r.height - 0.5;
        card.style.transform = 'perspective(600px) rotateX(' + (-y * 3) + 'deg) rotateY(' + (x * 3) + 'deg)';
      });
      card.addEventListener('mouseleave', function () { card.style.transform = ''; });
    });
  }

  function boot() {
    initReveal();
    initRipple();
    initValueFlash();
    initTilt();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* Re-run reveal/tilt hookup after tab switches or late DOM insertions
     (app.js renders dashboard content async on load). */
  window.addEventListener('load', function () {
    setTimeout(boot, 250);
  });
})();
