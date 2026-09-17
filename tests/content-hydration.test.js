"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const CONTENT_JS = fs.readFileSync(path.join(__dirname, "..", "js", "content.js"), "utf-8");

const BASE_HTML = `
<p class="hero__descriptor reveal" data-hero-tagline>Restaurante <span class="slash">/</span> Panadería <span class="slash">/</span> 2018—2026</p>
<span data-field="contact.restaurantAddress">Old address</span>
<span data-field-html="contact.hoursBakery">Old hours</span>
<a id="ig" data-field-href="social.instagramUrl" href="https://old.example">old</a>
<img id="banner-img" data-field-src="banner.image" data-field-alt="banner.imageAlt" src="assets/img/default.jpg" alt="default">
<div data-birthday-modal data-banner-enabled="0" aria-hidden="true"></div>
`;

// Loads content.js into a fresh jsdom document, stubbing window.fetch to
// resolve with the given content.json payload (or reject, to exercise the
// fallback path). Returns the window once "onnno:content-ready" has fired.
function loadWithContent(contentJsonOrError) {
  const dom = new JSDOM(`<!doctype html><body>${BASE_HTML}</body>`, { runScripts: "outside-only" });
  const { window } = dom;

  window.fetch = async (url, opts) => {
    assert.equal(url, "/content.json");
    assert.equal(opts.cache, "no-store");
    if (contentJsonOrError instanceof Error) throw contentJsonOrError;
    return { ok: true, status: 200, json: async () => contentJsonOrError };
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("onnno:content-ready never fired")), 2000);
    window.document.addEventListener("onnno:content-ready", () => {
      clearTimeout(timer);
      resolve(window);
    });
    window.eval(CONTENT_JS);
  });
}

test("patches text, innerHTML(hours), href, src/alt, and rebuilds the hero tagline", async () => {
  const window = await loadWithContent({
    contact: { restaurantAddress: "Nueva Dirección 123", hoursBakery: "Lunes: 8-2\nMartes: 8-2" },
    social: { instagramUrl: "https://www.instagram.com/nuevo/" },
    heroTagline: "Uno / Dos / Tres",
    banner: { enabled: true, image: "assets/img/new.jpg", imageAlt: "Nuevo anuncio" }
  });
  const doc = window.document;

  assert.equal(doc.querySelector("[data-field='contact.restaurantAddress']").textContent, "Nueva Dirección 123");
  assert.equal(doc.querySelector("[data-field-html='contact.hoursBakery']").innerHTML, "Lunes: 8-2<br>Martes: 8-2");
  assert.equal(doc.getElementById("ig").getAttribute("href"), "https://www.instagram.com/nuevo/");
  assert.equal(doc.getElementById("banner-img").getAttribute("src"), "assets/img/new.jpg");
  assert.equal(doc.getElementById("banner-img").getAttribute("alt"), "Nuevo anuncio");

  const tagline = doc.querySelector("[data-hero-tagline]");
  assert.equal(tagline.textContent.replace(/\s+/g, " ").trim(), "Uno / Dos / Tres");
  assert.equal(tagline.querySelectorAll(".slash").length, 2, "should rebuild the styled slash separators");

  assert.equal(doc.querySelector("[data-birthday-modal]").dataset.bannerEnabled, "1");
});

test("leaves the baked-in HTML untouched when content.json fails to load", async () => {
  const window = await loadWithContent(new Error("network down"));
  const doc = window.document;
  assert.equal(doc.querySelector("[data-field='contact.restaurantAddress']").textContent, "Old address");
  assert.equal(doc.getElementById("ig").getAttribute("href"), "https://old.example");
  // No content.json => no signal to enable the banner; default stays "0" from the markup.
  assert.equal(doc.querySelector("[data-birthday-modal]").dataset.bannerEnabled, "0");
});

test("banner defaults to disabled when banner.enabled is absent or false", async () => {
  const window = await loadWithContent({ heroTagline: "A / B" });
  assert.equal(window.document.querySelector("[data-birthday-modal]").dataset.bannerEnabled, "0");
});

test("refuses to write an unsafe href (e.g. javascript:) even if it's in content.json", async () => {
  const window = await loadWithContent({
    social: { instagramUrl: "javascript:alert(1)" }
  });
  assert.equal(window.document.getElementById("ig").getAttribute("href"), "https://old.example",
    "unsafe scheme must be rejected, original href kept");
});

test("refuses to write an unsafe image src (arbitrary scheme) but allows assets/ and https", async () => {
  const window = await loadWithContent({
    banner: { image: "javascript:alert(1)" }
  });
  assert.equal(window.document.getElementById("banner-img").getAttribute("src"), "assets/img/default.jpg");
});

test("escapes HTML in a data-field-html value before turning newlines into <br>", async () => {
  const window = await loadWithContent({
    contact: { hoursBakery: "<img src=x onerror=alert(1)>\nLine 2" }
  });
  const el = window.document.querySelector("[data-field-html='contact.hoursBakery']");
  assert.equal(el.querySelector("img"), null, "must not create a live <img> from untrusted markup");
  assert.equal(el.innerHTML, "&lt;img src=x onerror=alert(1)&gt;<br>Line 2");
});
