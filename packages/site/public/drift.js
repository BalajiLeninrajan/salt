// The background swears, moving like the DVD screensaver.
//
// Constant speed, perfect reflections off the viewport edges, elastic
// collisions with each other, and a colour change on every bounce. The words
// are axis-aligned rectangles, so AABB is not an approximation here — it is
// exactly their shape, and collisions land where they look like they should.
//
// No build step and no framework: the page is one panel, so a script tag is the
// whole client.

(function () {
  "use strict";

  var field = document.querySelector(".drift");
  if (!field) return;

  var els = Array.prototype.slice.call(field.querySelectorAll("span"));
  if (!els.length) return;

  // Cool-tone accents only. The colour change is the DVD tell; drifting through
  // the warm half of the palette would read as a different design instead.
  var HUES = ["--mauve", "--lavender", "--blue", "--sky"];
  var SPEED = 26; // px/s — ambient, not busy
  var MAX_STEP = 1 / 20; // s; clamps the delta after a backgrounded tab

  // The impact reads on the words themselves: the new colour arrives as a
  // surge of saturation that then sinks back to ambient. A separate burst
  // element behind them was tried first and read as a stock glow effect — the
  // light had no source, because nothing on screen was emitting it.
  var SPLASH_MS = 3200;
  var SPLASH_HIT = 0.62; // word against word
  var SPLASH_CORNER = 0.82; // a dead-on corner, the rare one

  // The panel is a solid body, not a backdrop. `.drift` is fixed to the
  // viewport, so the panel's client rect is already in the same coordinates.
  //
  // Its hitbox is half the panel, centred: words still cross the panel's outer
  // region and vanish behind it, and only bounce off the core. A full-size
  // hitbox also narrows the corridors either side to less than a word's width,
  // which leaves nowhere legal to push a word that ends up inside.
  var card = document.querySelector(".panel");
  var CARD_HITBOX = 0.5;
  var cardBox = null;

  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  var bounds = { w: 0, h: 0 };
  var running = false;
  var last = 0;

  var items = els.map(function (el, i) {
    return {
      el: el,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      w: 0,
      h: 0,
      hue: i % HUES.length,
      /** The in-flight splash, cancelled if a second hit lands on top of it. */
      anim: null,
    };
  });

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function paint(it) {
    it.el.style.color = "var(" + HUES[it.hue] + ")";
  }

  function bounced(it) {
    it.hue = (it.hue + 1) % HUES.length;
    paint(it);
  }

  // The splash. Only `opacity` is animated: `transform` is written every frame
  // by render(), and handing the same property to the Web Animations API would
  // put the two in a fight the physics would lose.
  //
  // A fast attack and a very long release: the word arrives at full colour on
  // the frame it is struck, then bleeds back to ambient over several seconds.
  // The slowness is the point — a quick flash reads as a blinking light, while
  // a long fade reads as colour spreading through the word and settling.
  function splash(it, strength) {
    if (reduce.matches) return;
    if (it.anim) it.anim.cancel();
    it.anim = it.el.animate(
      [
        { opacity: strength, offset: 0 },
        { opacity: strength * 0.72, offset: 0.12 },
        { opacity: "" },
      ],
      { duration: SPLASH_MS, easing: "cubic-bezier(.33,.6,.2,1)" },
    );
  }

  function measure() {
    bounds.w = field.clientWidth;
    bounds.h = field.clientHeight;
    items.forEach(function (it) {
      // Only translate is applied, so the box stays the untransformed size.
      var r = it.el.getBoundingClientRect();
      it.w = r.width;
      it.h = r.height;
    });
    measureCard();
  }

  function measureCard() {
    if (!card) return;
    var r = card.getBoundingClientRect();
    var w = r.width * CARD_HITBOX;
    var h = r.height * CARD_HITBOX;
    cardBox = {
      l: r.left + (r.width - w) / 2,
      t: r.top + (r.height - h) / 2,
      r: r.left + (r.width + w) / 2,
      b: r.top + (r.height + h) / 2,
    };
  }

  /**
   * Pushes a word out of the card and, when `reflect` is set, bounces it.
   *
   * Of the four ways out, only those that leave the word fully inside the
   * viewport are candidates, and the cheapest of those wins. Picking the axis
   * of least penetration outright — the rule used for word-on-word — would
   * happily shove a word through a wall when the gap on that side is narrower
   * than the word.
   *
   * Returns false when no exit fits, which lets the word pass through rather
   * than judder against two impossible constraints.
   */
  function ejectFromCard(it, reflect) {
    if (!cardBox) return false;
    if (it.x + it.w <= cardBox.l || it.x >= cardBox.r) return false;
    if (it.y + it.h <= cardBox.t || it.y >= cardBox.b) return false;

    var best = null;
    function consider(axis, value, lo, hi, cost) {
      if (value < lo || value > hi || (best && cost >= best.cost)) return;
      best = { axis: axis, value: value, cost: cost };
    }
    consider("x", cardBox.l - it.w, 0, bounds.w - it.w, it.x - (cardBox.l - it.w));
    consider("x", cardBox.r, 0, bounds.w - it.w, cardBox.r - it.x);
    consider("y", cardBox.t - it.h, 0, bounds.h - it.h, it.y - (cardBox.t - it.h));
    consider("y", cardBox.b, 0, bounds.h - it.h, cardBox.b - it.y);
    if (!best) return false;

    if (best.axis === "x") {
      var awayX = best.value < it.x ? -1 : 1;
      it.x = best.value;
      if (reflect) it.vx = Math.abs(it.vx) * awayX;
    } else {
      var awayY = best.value < it.y ? -1 : 1;
      it.y = best.value;
      if (reflect) it.vy = Math.abs(it.vy) * awayY;
    }
    return true;
  }

  // A word wider than the viewport can never satisfy both walls. Centre it on
  // that axis and let it travel on the other one rather than juddering between
  // two impossible constraints — this is the 390px case.
  function pinned(span, extent) {
    return extent - span <= 0;
  }

  function scatter() {
    var n = items.length;
    items.forEach(function (it, i) {
      var maxX = bounds.w - it.w;
      var maxY = bounds.h - it.h;

      // Golden-ratio stride across x against an even sweep down y: covers the
      // field without the clumps that uniform random placement produces.
      it.x = clamp(((i * 0.6180339887) % 1) * maxX, 0, Math.max(0, maxX));
      it.y = clamp(((i + 0.5) / n) * maxY, 0, Math.max(0, maxY));

      // Headings are held well off both axes so nothing slides along an edge.
      var a = (((i * 47) % 360) * Math.PI) / 180;
      var dx = Math.cos(a);
      var dy = Math.sin(a);
      if (Math.abs(dx) < 0.35) dx = dx < 0 ? -0.35 : 0.35;
      if (Math.abs(dy) < 0.35) dy = dy < 0 ? -0.35 : 0.35;
      var m = Math.sqrt(dx * dx + dy * dy);
      it.vx = (dx / m) * SPEED;
      it.vy = (dy / m) * SPEED;

      if (pinned(it.w, bounds.w)) {
        it.x = maxX / 2;
        it.vx = 0;
      }
      if (pinned(it.h, bounds.h)) {
        it.y = maxY / 2;
        it.vy = 0;
      }
      paint(it);
    });
    settle(8);
  }

  function overlap(a, b) {
    var ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    var oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return ox > 0 && oy > 0 ? { x: ox, y: oy } : null;
  }

  // Positional separation only — used to unpick the initial layout before
  // anything is moving, where swapping velocities would mean nothing.
  function settle(passes) {
    for (var p = 0; p < passes; p++) {
      var moved = false;
      for (var i = 0; i < items.length; i++) {
        for (var j = i + 1; j < items.length; j++) {
          var a = items[i];
          var b = items[j];
          var o = overlap(a, b);
          if (!o) continue;
          moved = true;
          if (o.x < o.y) {
            var sx = (a.x < b.x ? -1 : 1) * (o.x / 2 + 0.5);
            a.x = clamp(a.x + sx, 0, Math.max(0, bounds.w - a.w));
            b.x = clamp(b.x - sx, 0, Math.max(0, bounds.w - b.w));
          } else {
            var sy = (a.y < b.y ? -1 : 1) * (o.y / 2 + 0.5);
            a.y = clamp(a.y + sy, 0, Math.max(0, bounds.h - a.h));
            b.y = clamp(b.y - sy, 0, Math.max(0, bounds.h - b.h));
          }
        }
      }
      // Separating two words can push one into the card, so the card is
      // cleared after them, and the loop runs again to catch what that moved.
      for (var k = 0; k < items.length; k++) {
        if (ejectFromCard(items[k], false)) moved = true;
      }
      if (!moved) return;
    }
  }

  // Equal masses, so an elastic collision is just a swap of the velocity
  // component along the collision normal. Resolving on the axis of least
  // penetration picks the normal the shapes actually met on.
  function collide(a, b) {
    var o = overlap(a, b);
    if (!o) return;

    if (o.x < o.y) {
      var sx = (a.x < b.x ? -1 : 1) * (o.x / 2);
      a.x += sx;
      b.x -= sx;
      var vx = a.vx;
      a.vx = b.vx;
      b.vx = vx;
    } else {
      var sy = (a.y < b.y ? -1 : 1) * (o.y / 2);
      a.y += sy;
      b.y -= sy;
      var vy = a.vy;
      a.vy = b.vy;
      b.vy = vy;
    }
    // Both words take the splash: they hit each other, so both should show it.
    bounced(a);
    bounced(b);
    splash(a, SPLASH_HIT);
    splash(b, SPLASH_HIT);
  }

  function step(dt) {
    var i, j;

    for (i = 0; i < items.length; i++) {
      var it = items[i];
      it.x += it.vx * dt;
      it.y += it.vy * dt;

      var maxX = bounds.w - it.w;
      var maxY = bounds.h - it.h;
      var hitX = false;
      var hitY = false;

      if (pinned(it.w, bounds.w)) {
        it.x = maxX / 2;
        it.vx = 0;
      } else if (it.x <= 0) {
        it.x = 0;
        it.vx = Math.abs(it.vx);
        hitX = true;
      } else if (it.x >= maxX) {
        it.x = maxX;
        it.vx = -Math.abs(it.vx);
        hitX = true;
      }

      if (pinned(it.h, bounds.h)) {
        it.y = maxY / 2;
        it.vy = 0;
      } else if (it.y <= 0) {
        it.y = 0;
        it.vy = Math.abs(it.vy);
        hitY = true;
      } else if (it.y >= maxY) {
        it.y = maxY;
        it.vy = -Math.abs(it.vy);
        hitY = true;
      }

      // The card counts as a hit: it is a body, so striking it should read the
      // same as striking a word.
      if (ejectFromCard(it, true)) {
        bounced(it);
        splash(it, SPLASH_HIT);
      }

      // Three tiers of impact: a wall only recolours, a word-on-word hit
      // splashes, and a dead-on corner — the rare one worth waiting for —
      // splashes harder.
      if (hitX || hitY) bounced(it);
      if (hitX && hitY) splash(it, SPLASH_CORNER);
    }

    for (i = 0; i < items.length; i++) {
      for (j = i + 1; j < items.length; j++) collide(items[i], items[j]);
    }

    render();
  }

  function render() {
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      it.el.style.transform =
        "translate3d(" + it.x.toFixed(2) + "px," + it.y.toFixed(2) + "px,0)";
    }
  }

  function frame(now) {
    if (!running) return;
    var dt = Math.min((now - last) / 1000, MAX_STEP);
    last = now;
    if (dt > 0) step(dt);
    requestAnimationFrame(frame);
  }

  function start() {
    if (running || reduce.matches) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
  }

  // The panel scrolls with the page while the field is pinned to the viewport,
  // so its hitbox has to be re-read as the page moves or nothing would line up.
  var scrollQueued = false;
  function onScroll() {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(function () {
      scrollQueued = false;
      measureCard();
    });
  }

  var resizeTimer = null;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      measure();
      items.forEach(function (it) {
        it.x = clamp(it.x, 0, Math.max(0, bounds.w - it.w));
        it.y = clamp(it.y, 0, Math.max(0, bounds.h - it.h));
      });
      settle(4);
      render();
    }, 120);
  }

  function boot() {
    measure();
    scatter();
    render();
    field.classList.add("ready");
    start();
  }

  // The words are JetBrains Mono from a webfont; measuring before it lands
  // would size every box against the fallback and misplace every collision.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(boot);
  } else {
    window.addEventListener("load", boot);
  }

  window.addEventListener("resize", onResize);
  window.addEventListener("scroll", onScroll, { passive: true });
  // A hidden tab stops firing frames; restarting from a stale timestamp would
  // teleport everything on the first frame back.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stop();
    else if (!reduce.matches) start();
  });
  reduce.addEventListener("change", function () {
    if (reduce.matches) stop();
    else start();
  });
})();
