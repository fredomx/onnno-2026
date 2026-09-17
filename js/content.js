/* ============================== SITE CONTENT ==============================
   Loads /content.json (edited from /admin.html) and patches the few details
   marked in index.html with data-field / data-field-html / data-field-href /
   data-field-src / data-field-alt / data-hero-tagline. Everything else on
   the page is untouched. If content.json is missing or fails to load, the
   baked-in HTML values stay as-is — this script only overrides, never
   removes. Fires "onnno:content-ready" on `document` when done (or when it
   gives up), which js/main.js listens for to decide whether to show the
   announcement banner. */
(function () {
  "use strict";

  function get(obj, path) {
    return path.split(".").reduce(function (acc, key) {
      return acc && typeof acc === "object" ? acc[key] : undefined;
    }, obj);
  }

  function isSafeUrl(url) {
    return typeof url === "string" && /^(https:\/\/|http:\/\/|tel:|mailto:)/i.test(url.trim());
  }

  function isSafeSrc(url) {
    if (typeof url !== "string") return false;
    return /^(https:\/\/|\/|assets\/)/i.test(url.trim());
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function applyHeroTagline(content) {
    var el = document.querySelector("[data-hero-tagline]");
    var value = get(content, "heroTagline");
    if (!el || typeof value !== "string" || !value.trim()) return;
    var parts = value.split("/").map(function (s) { return s.trim(); }).filter(Boolean);
    if (!parts.length) return;
    el.textContent = "";
    parts.forEach(function (part, i) {
      if (i > 0) {
        el.appendChild(document.createTextNode(" "));
        var slash = document.createElement("span");
        slash.className = "slash";
        slash.textContent = "/";
        el.appendChild(slash);
        el.appendChild(document.createTextNode(" "));
      }
      el.appendChild(document.createTextNode(part));
    });
  }

  function applyContent(content) {
    document.querySelectorAll("[data-field]").forEach(function (el) {
      var val = get(content, el.getAttribute("data-field"));
      if (typeof val === "string") el.textContent = val;
    });

    document.querySelectorAll("[data-field-html]").forEach(function (el) {
      var val = get(content, el.getAttribute("data-field-html"));
      if (typeof val === "string") el.innerHTML = escapeHtml(val).replace(/\n/g, "<br>");
    });

    document.querySelectorAll("[data-field-href]").forEach(function (el) {
      var val = get(content, el.getAttribute("data-field-href"));
      if (isSafeUrl(val)) el.setAttribute("href", val.trim());
    });

    document.querySelectorAll("[data-field-src]").forEach(function (el) {
      var val = get(content, el.getAttribute("data-field-src"));
      if (isSafeSrc(val)) el.setAttribute("src", val.trim());
    });

    document.querySelectorAll("[data-field-alt]").forEach(function (el) {
      var val = get(content, el.getAttribute("data-field-alt"));
      if (typeof val === "string") el.setAttribute("alt", val);
    });

    applyHeroTagline(content);

    var modal = document.querySelector("[data-birthday-modal]");
    if (modal) {
      var banner = content && content.banner;
      modal.dataset.bannerEnabled = banner && banner.enabled ? "1" : "0";
    }
  }

  function ready(content) {
    document.dispatchEvent(new CustomEvent("onnno:content-ready", { detail: content || null }));
  }

  fetch("/content.json", { cache: "no-store" })
    .then(function (res) {
      if (!res.ok) throw new Error("content.json " + res.status);
      return res.json();
    })
    .then(function (content) {
      applyContent(content);
      ready(content);
    })
    .catch(function (err) {
      console.warn("[onnno] No se pudo cargar content.json, se conserva el contenido por defecto.", err);
      ready(null);
    });
})();
