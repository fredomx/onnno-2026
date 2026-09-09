(function(){
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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

  /* ---------- mosaic reveal (its own small choreography, unchanged) ---------- */
  var mosaicEls = document.querySelectorAll("[data-mosaic]");
  if (mosaicEls.length) {
    if ("IntersectionObserver" in window) {
      var mosaicIo = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              entry.target.classList.add("is-visible");
              mosaicIo.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.16, rootMargin: "0px 0px -8% 0px" }
      );
      mosaicEls.forEach(function (el) { mosaicIo.observe(el); });
    } else {
      mosaicEls.forEach(function (el) { el.classList.add("is-visible"); });
    }
  }

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

  if (reduceMotion) {
    heroReveals.concat(revealEls).forEach(function (el) {
      el.style.opacity = 1;
      el.style.transform = "none";
      var line = el.querySelector(".reveal-line");
      if (line) line.style.transform = "none";
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
      return {
        el: el,
        line: el.querySelector(".reveal-line"),
        offset: (parseFloat(el.style.getPropertyValue("--d")) || 0) * 260, // seconds → px of extra scroll needed
        current: 0,
        target: 0
      };
    });
    // reused every frame instead of allocating a fresh array each tick
    var revealRects = new Array(revealData.length);
    var parallaxRects = new Array(parallaxEls.length);

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
      }

      for (j = 0; j < parallaxEls.length; j++) {
        var rect = parallaxRects[j];
        if (rect.bottom < -200 || rect.top > vh + 200) continue;
        var strength = parseFloat(parallaxEls[j].getAttribute("data-parallax")) || 0.1;
        var progress = (rect.top + rect.height / 2 - vh / 2) / vh;
        var offset = progress * strength * 100;
        parallaxEls[j].style.transform = "translate3d(0," + offset.toFixed(2) + "px,0) scale(1.12)";
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
})();
