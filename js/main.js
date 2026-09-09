(function(){
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- autoplay videos (hero + decorative background clips) ---------- */
  var autoplayVideos = document.querySelectorAll("video[autoplay]");
  autoplayVideos.forEach(function (v) {
    if (reduceMotion) {
      v.pause();
    } else {
      var playPromise = v.play();
      if (playPromise && playPromise.catch) playPromise.catch(function () {});
    }
  });

  /* ---------- nav height sync ----------
     keeps the fullscreen index panel's top clearance in step with the
     nav bar's real height (e.g. logo size changes) instead of a hardcoded
     guess that silently goes stale and overlaps. */
  var navBar = document.querySelector(".site-nav");
  if (navBar) {
    var syncNavHeight = function () {
      document.documentElement.style.setProperty("--nav-h", navBar.offsetHeight + "px");
    };
    syncNavHeight();
    window.addEventListener("resize", syncNavHeight);
  }

  /* ---------- nav overlay ---------- */
  var toggle = document.querySelector("[data-nav-toggle]");
  var panel = document.querySelector("[data-nav-panel]");

  if (toggle && panel) {
    toggle.addEventListener("click", function () {
      var open = panel.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      document.body.style.overflow = open ? "hidden" : "";
    });

    panel.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () {
        panel.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
        document.body.style.overflow = "";
      });
    });
  }

  /* ---------- smooth scroll for in-page anchors ---------- */
  document.querySelectorAll('a[href^="#"]').forEach(function (link) {
    link.addEventListener("click", function (e) {
      var id = link.getAttribute("href");
      if (id.length < 2) return;
      var target = document.querySelector(id);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    });
  });

  /* stagger a little inside grouped rows — read as a pixel offset below */
  document.querySelectorAll(".intro__grid, .growth__row, .visit__grid").forEach(function (group) {
    Array.prototype.forEach.call(group.children, function (child, i) {
      child.style.setProperty("--d", (i * 0.08) + "s");
    });
  });

  /* ==========================================================================
     Scroll-scrubbed motion engine
     Every .reveal element gets a 0→1 progress driven straight from its
     position in the viewport (not a one-shot threshold trigger), smoothed
     with a light lerp so quick scrolls still feel fluid rather than snapping.
     Parallax images share the same rAF loop.
     ========================================================================== */
  // The hero sits in the first viewport with nothing to scroll "from" above
  // it, so it gets a quick one-time load-in instead of a scroll-tied scrub.
  var heroReveals = Array.prototype.slice.call(document.querySelectorAll("#hero .reveal"));
  var revealEls = Array.prototype.slice.call(document.querySelectorAll(".reveal")).filter(function (el) {
    return heroReveals.indexOf(el) === -1;
  });
  var parallaxEls = Array.prototype.slice.call(document.querySelectorAll("[data-parallax]"));

  // kinetic headlines settle at their own authored weight; opsz always
  // finishes at 144 (Fraunces' full display cut) regardless of font-size.
  function kineticEndWeight(el) {
    return parseFloat(getComputedStyle(el).fontWeight) || 500;
  }

  if (reduceMotion) {
    heroReveals.forEach(function (el) {
      el.classList.add("is-visible");
      el.style.opacity = 1;
      el.style.transform = "none";
      var line = el.querySelector(".reveal-line");
      if (line) line.style.transform = "none";
    });
    revealEls.forEach(function (el) {
      el.style.opacity = 1;
      el.style.transform = "none";
      var line = el.querySelector(".reveal-line");
      if (line) line.style.transform = "none";
      if (el.hasAttribute("data-kinetic")) {
        el.style.fontVariationSettings = "'opsz' 144, 'wght' " + kineticEndWeight(el);
      }
    });
  } else {
    heroReveals.forEach(function (el, i) {
      el.style.setProperty("--d", (i * 0.12) + "s");
    });
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        heroReveals.forEach(function (el) { el.classList.add("is-visible"); });
      });
    });

    var revealData = revealEls.map(function (el) {
      var kinetic = el.hasAttribute("data-kinetic");
      var endWeight = kinetic ? kineticEndWeight(el) : 0;
      return {
        el: el,
        line: el.querySelector(".reveal-line"),
        offset: (parseFloat(el.style.getPropertyValue("--d")) || 0) * 260, // seconds → px of extra scroll needed
        current: 0,
        target: 0,
        kinetic: kinetic,
        startWeight: Math.max(100, endWeight - 100),
        endWeight: endWeight
      };
    });
    // reused every frame instead of allocating a fresh array each tick
    var revealRects = new Array(revealData.length);
    var parallaxRects = new Array(parallaxEls.length);

    /* ---------- growth: pinned card stack ----------
       The wrapper is given extra scroll height once, up front, so the
       section can stay pinned (position:sticky in CSS) while that runway
       scrolls past; each frame turns how far into that runway we are into
       a deck position for every card — the active one centered and sharp,
       waiting ones stacked small behind it, passed ones spinning away. */
    var growthPin = document.querySelector("[data-growth-pin]");
    var growthTrack = document.querySelector("[data-growth-track]");
    var growthCount = document.querySelector("[data-growth-count]");
    var growthCards = growthTrack ? Array.prototype.slice.call(growthTrack.children) : [];
    var growthShownIndex = -1;
    var GROWTH_SCROLL_PER_CARD = 0.55; // viewport-heights of scroll per card change
    if (growthPin && growthCards.length) {
      growthPin.style.height = (window.innerHeight * (1 + (growthCards.length - 1) * GROWTH_SCROLL_PER_CARD)) + "px";
    }

    function frame() {
      var vh = window.innerHeight;
      var scrollY = window.scrollY || window.pageYOffset;
      // clamp the "fully revealed" scroll position to what's actually reachable,
      // so content near the very bottom of the page (no scroll runway left
      // below it) still resolves to fully visible instead of stalling.
      var maxScroll = Math.max(0, document.documentElement.scrollHeight - vh);
      var i, j;

      // -- read phase (all layout reads before any writes, to avoid thrashing) --
      for (i = 0; i < revealData.length; i++) revealRects[i] = revealData[i].el.getBoundingClientRect();
      for (j = 0; j < parallaxEls.length; j++) parallaxRects[j] = parallaxEls[j].getBoundingClientRect();

      // -- compute + write phase --
      for (i = 0; i < revealData.length; i++) {
        var d = revealData[i];
        var absoluteTop = revealRects[i].top + scrollY;
        var rawEnd = absoluteTop - vh * 0.45 + d.offset;
        var end = Math.min(rawEnd, maxScroll);
        var start = Math.min(absoluteTop - vh + d.offset, end - 1);

        d.target = (scrollY - start) / (end - start);
        if (d.target < 0) d.target = 0;
        else if (d.target > 1) d.target = 1;

        d.current += (d.target - d.current) * 0.16;
        if (Math.abs(d.target - d.current) < 0.001) d.current = d.target;

        var p = d.current;
        d.el.style.opacity = p;
        d.el.style.transform = "translateY(" + ((1 - p) * 28).toFixed(2) + "px)";
        if (d.line) d.line.style.transform = "translateY(" + ((1 - p) * 115).toFixed(2) + "%)";
        if (d.kinetic) {
          var opsz = (40 + p * (144 - 40)).toFixed(1);
          var wght = (d.startWeight + p * (d.endWeight - d.startWeight)).toFixed(1);
          d.el.style.fontVariationSettings = "'opsz' " + opsz + ", 'wght' " + wght;
        }
      }

      for (j = 0; j < parallaxEls.length; j++) {
        var rect = parallaxRects[j];
        if (rect.bottom < -200 || rect.top > vh + 200) continue;
        var strength = parseFloat(parallaxEls[j].getAttribute("data-parallax")) || 0.1;
        var progress = (rect.top + rect.height / 2 - vh / 2) / vh;
        var offset = progress * strength * 100;
        parallaxEls[j].style.transform = "translate3d(0," + offset.toFixed(2) + "px,0) scale(1.12)";
      }

      if (growthPin && growthCards.length) {
        var pinRect = growthPin.getBoundingClientRect();
        var runway = growthPin.offsetHeight - vh;
        var pinProgress = runway > 0 ? -pinRect.top / runway : 0;
        if (pinProgress < 0) pinProgress = 0;
        else if (pinProgress > 1) pinProgress = 1;

        var n = growthCards.length;
        var currentFloat = pinProgress * (n - 1);

        for (i = 0; i < n; i++) {
          var card = growthCards[i];
          var d = currentFloat - i;
          var baseRot = ((i * 47) % 13) - 6; // deterministic per-card tilt, -6..6deg
          var ty, rot, scale, op, sat, z;

          if (d <= 0) {
            // only a few layers deep, each clearly separated — a clean
            // stack, not a blur of overlapping fully-opaque photos
            var back = Math.min(3, -d);
            scale = 1 - back * 0.09;
            ty = back * 24;
            rot = baseRot * Math.min(1, back / 1.1);
            sat = 1 - back * 0.12;
            op = Math.max(0, 1 - back * 0.24);
            z = 100 - i;
          } else {
            // exit fast (fully gone well before the next card is due) so
            // the outgoing card never lingers on top of the one behind it
            var t = Math.min(d / 0.35, 1);
            ty = -t * 230;
            rot = baseRot + t * (i % 2 === 0 ? -22 : 22);
            scale = 1 - t * 0.22;
            sat = Math.max(0.5, 1 - t * 0.35);
            op = 1 - t;
            z = 200 + i;
          }

          card.style.transform = "translate(-50%,-50%) translateY(" + ty.toFixed(2) + "px) rotate(" + rot.toFixed(2) + "deg) scale(" + scale.toFixed(3) + ")";
          card.style.filter = "saturate(" + sat.toFixed(2) + ")";
          card.style.opacity = op.toFixed(3);
          card.style.zIndex = z;
        }

        if (growthCount) {
          var shownIndex = Math.min(n - 1, Math.max(0, Math.round(currentFloat)));
          if (shownIndex !== growthShownIndex) {
            growthShownIndex = shownIndex;
            growthCount.textContent = String(shownIndex + 1).padStart(2, "0") + " / " + n;
          }
        }
      }

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }

  /* ---------- nav switches to light text whenever a dark section sits behind it ---------- */
  var nav = document.querySelector("[data-nav]");
  var darkSections = document.querySelectorAll("[data-nav-dark]");
  if (nav && darkSections.length && "IntersectionObserver" in window) {
    var overlapping = new Set();
    var navIo = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) overlapping.add(entry.target);
          else overlapping.delete(entry.target);
        });
        nav.classList.toggle("site-nav--overlay", overlapping.size > 0);
      },
      { threshold: 0, rootMargin: "0px 0px -94% 0px" }
    );
    darkSections.forEach(function (el) { navIo.observe(el); });
  }

  /* ---------- nav gains a solid background from Introducción onward ---------- */
  var heroSection = document.querySelector("#hero");
  if (nav && heroSection && "IntersectionObserver" in window) {
    var solidIo = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          nav.classList.toggle("site-nav--solid", !entry.isIntersecting);
        });
        // the solid state animates to a different (shorter) nav height over
        // .4s, so wait for that transition to land before re-measuring —
        // reading offsetHeight right away would just capture the mid-animation value.
        if (typeof syncNavHeight === "function") setTimeout(syncNavHeight, 450);
      },
      { threshold: 0, rootMargin: "0px 0px -94% 0px" }
    );
    solidIo.observe(heroSection);
  }
})();
