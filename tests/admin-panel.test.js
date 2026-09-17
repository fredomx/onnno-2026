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

// Loads the real admin.html markup + its real inline script into jsdom.
// `fetchImpl` lets each test control what /content.json and
// /.netlify/functions/save-content return.
function loadAdminPage(fetchImpl, { confirmReturns = true } = {}) {
  const dom = new JSDOM(ADMIN_HTML, { runScripts: "outside-only", url: "https://onnno.mx/admin.html" });
  const { window } = dom;
  window.fetch = fetchImpl;
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
}

test("shows a gate error and makes no request when the password field is empty", async () => {
  let fetchCalled = false;
  const window = loadAdminPage(async () => { fetchCalled = true; });
  window.document.getElementById("unlock").click();
  await flushMicrotasks();
  assert.equal(window.document.getElementById("gate-error").hidden, false);
  assert.equal(fetchCalled, false);
  assert.equal(window.document.getElementById("form").hidden, true);
});

test("unlock loads content.json and reveals the populated form", async () => {
  const window = loadAdminPage(async (url) => {
    assert.equal(url, "/content.json");
    return { ok: true, json: async () => SAMPLE_CONTENT };
  });
  fill(window, "password", "some-password");
  window.document.getElementById("unlock").click();
  await flushMicrotasks();

  assert.equal(window.document.getElementById("gate").hidden, true);
  assert.equal(window.document.getElementById("form").hidden, false);
  assert.equal(window.document.getElementById("restaurantAddress").value, "Mártires de Tacubaya 308‑C");
  assert.equal(window.document.getElementById("bannerEnabled").checked, false);
  assert.equal(window.sessionStorage.getItem("onnno_admin_pw"), "some-password");
});

test("shows a gate error (and stays on the gate) if content.json can't be loaded", async () => {
  const window = loadAdminPage(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  fill(window, "password", "whatever");
  window.document.getElementById("unlock").click();
  await flushMicrotasks();
  assert.equal(window.document.getElementById("gate-error").hidden, false);
  assert.equal(window.document.getElementById("form").hidden, true);
});

test("canceling the confirm dialog on save sends no request", async () => {
  let saveCalled = false;
  const window = loadAdminPage(async (url) => {
    if (url === "/content.json") return { ok: true, json: async () => SAMPLE_CONTENT };
    saveCalled = true;
    return { ok: true, json: async () => ({ ok: true, content: SAMPLE_CONTENT }) };
  }, { confirmReturns: false });

  fill(window, "password", "pw");
  window.document.getElementById("unlock").click();
  await flushMicrotasks();

  window.document.getElementById("form").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
  await flushMicrotasks();

  assert.equal(saveCalled, false, "declining the confirm() dialog must abort the save");
  assert.equal(window.document.getElementById("save-status").textContent, "");
});

test("confirming save posts the edited, remembered-password content and shows success", async () => {
  let savedBody = null;
  const window = loadAdminPage(async (url, opts) => {
    if (url === "/content.json") return { ok: true, json: async () => SAMPLE_CONTENT };
    savedBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ ok: true, content: { ...SAMPLE_CONTENT, heroTagline: "Nuevo" } }) };
  }, { confirmReturns: true });

  fill(window, "password", "the-real-password");
  window.document.getElementById("unlock").click();
  await flushMicrotasks();

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

test("a wrong-password response from the function clears the remembered password and shows the error", async () => {
  const window = loadAdminPage(async (url) => {
    if (url === "/content.json") return { ok: true, json: async () => SAMPLE_CONTENT };
    return { ok: false, json: async () => ({ error: "Contraseña incorrecta." }) };
  }, { confirmReturns: true });

  fill(window, "password", "wrong-one");
  window.document.getElementById("unlock").click();
  await flushMicrotasks();

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
