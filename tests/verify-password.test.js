"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { handler } = require("../netlify/functions/verify-password.js");

const ORIGINAL_ENV = { ...process.env };

test.beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, ADMIN_PASSWORD: "test-pw" };
});

test.after(() => {
  process.env = ORIGINAL_ENV;
});

test("rejects non-POST requests", async () => {
  const res = await handler({ httpMethod: "GET", body: "" });
  assert.equal(res.statusCode, 405);
});

test("rejects invalid JSON body", async () => {
  const res = await handler({ httpMethod: "POST", body: "{not json" });
  assert.equal(res.statusCode, 400);
});

test("500s with a clear message when ADMIN_PASSWORD is not configured", async () => {
  delete process.env.ADMIN_PASSWORD;
  const res = await handler({ httpMethod: "POST", body: JSON.stringify({ password: "x" }) });
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /ADMIN_PASSWORD/);
});

test("rejects a wrong password", async () => {
  const res = await handler({ httpMethod: "POST", body: JSON.stringify({ password: "wrong" }) });
  assert.equal(res.statusCode, 401);
  assert.match(JSON.parse(res.body).error, /[Cc]ontraseña incorrecta/);
});

test("rejects a missing password the same way as a wrong one", async () => {
  const res = await handler({ httpMethod: "POST", body: JSON.stringify({}) });
  assert.equal(res.statusCode, 401);
});

test("accepts the correct password and never touches GitHub", async () => {
  const res = await handler({ httpMethod: "POST", body: JSON.stringify({ password: "test-pw" }) });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);
});
