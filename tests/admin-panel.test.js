"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const ADMIN_HTML = fs.readFileSync(path.join(__dirname, "..", "admin.html"), "utf-8");
const INLINE_SCRIPT = (() => {
  const m = ADMIN_HTML.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(m, "admin.html must contain an inline <script> block for these tests to load");
  return m[1];
})();

const SAMPLE_CONTENT = {
  contact: {
    restaurantAddress: "Mártires de Tacubaya 308‑C",
    restaurantMapUrl: "https://share.google/abc",
    bakeryAddress: "Morelos 1201",
    bakeryMapUrl: "https://share.google/def",
    city: "Oaxaca de Juárez, Oaxaca, México",
    hoursBakery: "Lunes: 8-2",
    hoursRestaurant: "Lunes: 8-4"
  },
  social: { instagramUrl: "https://www.instagram.com/onnno.mx/", instagramHandle: "@onnno.mx" },
  heroTagline: "Restaurante / Panadería / 2018—2026",
  banner: { enabled: false, image: "assets/img/x.jpg", imageAlt: "alt", title: "T", subtitle: "S" }
};

const VERIFY_URL = "/.netlify/functions/verify-password";
const CONTENT_URL = "/content.json";
const SAVE_URL = "/.netlify/functions/save-content";

// Routes fetch() calls by URL to a handler that returns {ok, data}. Any
// URL not in `routes` throws, so a test only has to describe the
// endpoints it actually cares about.
function routedFetch(routes) {
  return async (url, opts) => {
    const route = routes[url];
    if (!route) throw new Error("unexpected fetch to " + url);
    const { ok = true, data = {} } = await route(opts);
    return { ok, status: ok ? 200 : 401, json: async () => data };
  };
}

function okVerify() {
  return async () => ({ ok: true, data: { ok: true } });
}

function okContent(content = SAMPLE_CONTENT) {
  return async () => ({ ok: true, data: content });
}

// Loads the real admin.html markup + its real inline script into jsdom.
function loadAdminPage(routes, { confirmReturns = true } = {}) {
  const dom = new JSDOM(ADMIN_HTML, { runScripts: "outside-only", url: "https://onnno.mx/admin.html" });
  const { window } = dom;
  window.fetch = routedFetch(routes);
  window.confirm = () => confirmReturns;
  window.eval(INLINE_SCRIPT);
  return window;
}

function fill(window, id, value) {
  window.document.getElementById(id).value = value;
}

async function flushMicrotasks() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

async function unlockAs(window, password) {
  fill(window, "password", password);
  window.document.getElementById("unlock").click();
  await flushMicrotasks();
}

test("shows a gate error and makes no request when the password field is empty", async () => {
  const window = loadAdminPage({}); // any fetch call would throw ("unexpected fetch")
  window.document.getElementById("unlock").click();
  await flushMicrotasks();
  assert.equal(window.document.getElementById("gate-error").hidden, false);
  assert.equal(window.document.getElementById("form").hidden, true);
});

test("a wrong password is rejected by the server BEFORE the form is ever shown or content.json is fetched", async () => {
  let contentJsonRequested = false;
  const window = loadAdminPage({
    [VERIFY_URL]: async () => ({ ok: false, data: { error: "Contraseña incorrecta." } }),
    [CONTENT_URL]: async () => { contentJsonRequested = true; return { ok: true, data: SAMPLE_CONTENT }; }
  });

  await unlockAs(window, "wrong-guess");

  assert.equal(window.document.getElementById("gate").hidden, false, "gate must stay up on a wrong password");
  assert.equal(window.document.getElementById("form").hidden, true, "form must never be revealed");
  assert.equal(contentJsonRequested, false, "content.json must not even be fetched until the password checks out");
  assert.match(window.document.getElementById("gate-error").textContent, /Contraseña incorrecta/);
  assert.equal(window.sessionStorage.getItem("onnno_admin_pw"), null);
});

test("a correct password verifies, then loads content.json and reveals the populated form", async () => {
  let verifyCalledWith = null;
  const window = loadAdminPage({
    [VERIFY_URL]: async (opts) => { verifyCalledWith = JSON.parse(opts.body).password; return { ok: true, data: { ok: true } }; },
    [CONTENT_URL]: okContent()
  });

  await unlockAs(window, "the-real-password");

  assert.equal(verifyCalledWith, "the-real-password");
  assert.equal(window.document.getElementById("gate").hidden, true);
  assert.equal(window.document.getElementById("form").hidden, false);
  assert.equal(window.document.getElementById("restaurantAddress").value, "Mártires de Tacubaya 308‑C");
  assert.equal(window.document.getElementById("bannerEnabled").checked, false);
  assert.equal(window.sessionStorage.getItem("onnno_admin_pw"), "the-real-password");
});

test("if the password is right but content.json fails to load, stays on the gate with an error", async () => {
  const window = loadAdminPage({
    [VERIFY_URL]: okVerify(),
    [CONTENT_URL]: async () => ({ ok: false, data: {} })
  });
  await unlockAs(window, "the-real-password");
  assert.equal(window.document.getElementById("gate-error").hidden, false);
  assert.equal(window.document.getElementById("form").hidden, true);
});

test("if the verify-password function itself errors (e.g. not configured), shows that error on the gate", async () => {
  const window = loadAdminPage({
    [VERIFY_URL]: async () => ({ ok: false, data: { error: "El panel no está configurado (falta ADMIN_PASSWORD)." } })
  });
  await unlockAs(window, "anything");
  assert.match(window.document.getElementById("gate-error").textContent, /no está configurado/);
  assert.equal(window.document.getElementById("form").hidden, true);
});

test("canceling the confirm dialog on save sends no save request", async () => {
  let saveCalled = false;
  const window = loadAdminPage({
    [VERIFY_URL]: okVerify(),
    [CONTENT_URL]: okContent(),
    [SAVE_URL]: async () => { saveCalled = true; return { ok: true, data: { ok: true, content: SAMPLE_CONTENT } }; }
  }, { confirmReturns: false });

  await unlockAs(window, "pw");
  window.document.getElementById("form").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
  await flushMicrotasks();

  assert.equal(saveCalled, false, "declining the confirm() dialog must abort the save");
  assert.equal(window.document.getElementById("save-status").textContent, "");
});

test("confirming save posts the edited, remembered-password content and shows success", async () => {
  let savedBody = null;
  const window = loadAdminPage({
    [VERIFY_URL]: okVerify(),
    [CONTENT_URL]: okContent(),
    [SAVE_URL]: async (opts) => {
      savedBody = JSON.parse(opts.body);
      return { ok: true, data: { ok: true, content: { ...SAMPLE_CONTENT, heroTagline: "Nuevo" } } };
    }
  }, { confirmReturns: true });

  await unlockAs(window, "the-real-password");

  window.document.getElementById("heroTagline").value = "Nuevo";
  window.document.getElementById("bannerEnabled").checked = true;

  window.document.getElementById("form").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
  await flushMicrotasks();

  assert.ok(savedBody, "expected a request to save-content");
  assert.equal(savedBody.password, "the-real-password", "must send the password remembered from unlock");
  assert.equal(savedBody.content.heroTagline, "Nuevo");
  assert.equal(savedBody.content.banner.enabled, true);

  const status = window.document.getElementById("save-status");
  assert.match(status.textContent, /Guardado/);
  assert.equal(status.className, "ok");
});

test("if the password is later rejected on save (e.g. rotated mid-session), clears the remembered password and shows the error", async () => {
  const window = loadAdminPage({
    [VERIFY_URL]: okVerify(),
    [CONTENT_URL]: okContent(),
    [SAVE_URL]: async () => ({ ok: false, data: { error: "Contraseña incorrecta." } })
  }, { confirmReturns: true });

  await unlockAs(window, "was-valid-at-unlock-time");
  window.document.getElementById("form").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
  await flushMicrotasks();

  const status = window.document.getElementById("save-status");
  assert.match(status.textContent, /Contraseña incorrecta/);
  assert.equal(status.className, "error");
  assert.equal(window.sessionStorage.getItem("onnno_admin_pw"), null);
});

test("admin.html declares noindex so it doesn't end up in search results", () => {
  assert.match(ADMIN_HTML, /<meta name="robots" content="noindex, nofollow">/);
});
