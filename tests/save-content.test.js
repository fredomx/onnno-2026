"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { handler } = require(path.join("..", "netlify", "functions", "save-content.js"));

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

function resetEnv() {
  process.env = { ...ORIGINAL_ENV, ADMIN_PASSWORD: "test-pw", GITHUB_TOKEN: "test-token" };
}

function b64(obj) {
  return Buffer.from(JSON.stringify(obj), "utf-8").toString("base64");
}

// Queue of {ok, status, json?, text?} responses consumed in order by
// successive fetch() calls, so each test controls exactly what the
// GitHub GET and PUT calls return.
function mockFetchSequence(responses) {
  let i = 0;
  global.fetch = async () => {
    const r = responses[i++];
    if (!r) throw new Error("mockFetchSequence: ran out of queued responses");
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.json,
      text: async () => r.text || ""
    };
  };
}

test.beforeEach(() => {
  resetEnv();
});

test.after(() => {
  process.env = ORIGINAL_ENV;
  global.fetch = ORIGINAL_FETCH;
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
  const res = await handler({ httpMethod: "POST", body: JSON.stringify({ password: "x", content: {} }) });
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /ADMIN_PASSWORD/);
});

test("rejects a wrong password without touching GitHub", async () => {
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; };
  const res = await handler({
    httpMethod: "POST",
    body: JSON.stringify({ password: "wrong", content: { heroTagline: "x" } })
  });
  assert.equal(res.statusCode, 401);
  assert.match(JSON.parse(res.body).error, /[Cc]ontraseña incorrecta/);
  assert.equal(fetchCalled, false, "should reject before ever calling GitHub");
});

test("rejects missing/invalid content", async () => {
  const res = await handler({ httpMethod: "POST", body: JSON.stringify({ password: "test-pw" }) });
  assert.equal(res.statusCode, 400);
});

test("500s with a clear message when GITHUB_TOKEN is not configured", async () => {
  delete process.env.GITHUB_TOKEN;
  const res = await handler({
    httpMethod: "POST",
    body: JSON.stringify({ password: "test-pw", content: { heroTagline: "x" } })
  });
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /GITHUB_TOKEN/);
});

test("surfaces a clear error when the GitHub GET fails", async () => {
  mockFetchSequence([{ ok: false, status: 404, text: "Not Found" }]);
  const res = await handler({
    httpMethod: "POST",
    body: JSON.stringify({ password: "test-pw", content: { heroTagline: "x" } })
  });
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /404/);
});

test("surfaces a clear error when the GitHub PUT fails", async () => {
  const current = { heroTagline: "Old" };
  mockFetchSequence([
    { ok: true, status: 200, json: { sha: "abc123", content: b64(current) } },
    { ok: false, status: 409, text: "sha mismatch" }
  ]);
  const res = await handler({
    httpMethod: "POST",
    body: JSON.stringify({ password: "test-pw", content: { heroTagline: "New" } })
  });
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /409/);
});

test("happy path: merges only whitelisted fields and commits via the GitHub Contents API", async () => {
  const current = {
    contact: { restaurantAddress: "Old address", hoursBakery: "Old hours" },
    social: { instagramUrl: "https://www.instagram.com/old/" },
    heroTagline: "Old tagline",
    banner: { enabled: false, title: "Old title" }
  };

  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (calls.length === 1) {
      // GET current file
      return { ok: true, status: 200, json: async () => ({ sha: "sha-1", content: b64(current) }) };
    }
    // PUT updated file
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const incoming = {
    contact: { restaurantAddress: "New address" }, // hoursBakery omitted on purpose
    heroTagline: "New tagline",
    banner: { enabled: true, title: "New title" },
    // Fields not in the whitelist must be dropped, not written through.
    notARealField: "should be ignored",
    contact_injected: { evil: true }
  };

  const res = await handler({
    httpMethod: "POST",
    body: JSON.stringify({ password: "test-pw", content: incoming })
  });

  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.ok, true);

  // Updated fields took the new value.
  assert.equal(data.content.contact.restaurantAddress, "New address");
  assert.equal(data.content.heroTagline, "New tagline");
  assert.equal(data.content.banner.enabled, true);
  assert.equal(data.content.banner.title, "New title");

  // Fields omitted from the request keep their prior value.
  assert.equal(data.content.contact.hoursBakery, "Old hours");
  assert.equal(data.content.social.instagramUrl, "https://www.instagram.com/old/");

  // Unknown fields never make it into the merged object.
  assert.equal(data.content.notARealField, undefined);
  assert.equal(data.content.contact.evil, undefined);
  assert.equal(data.content.contact_injected, undefined);

  // GET was called before PUT (read-modify-write, avoids clobbering concurrent edits).
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/contents\/content\.json\?ref=main/);
  assert.equal(calls[1].opts.method, "PUT");
  const putBody = JSON.parse(calls[1].opts.body);
  assert.equal(putBody.sha, "sha-1", "must send back the sha it just read, not a stale one");
  assert.equal(putBody.branch, "main");
  const committedContent = JSON.parse(Buffer.from(putBody.content, "base64").toString("utf-8"));
  assert.equal(committedContent.contact.restaurantAddress, "New address");
});

test("coerces banner.enabled to a real boolean regardless of input type", async () => {
  const current = { banner: { enabled: false } };
  mockFetchSequence([
    { ok: true, status: 200, json: { sha: "s", content: b64(current) } },
    { ok: true, status: 200, json: {} }
  ]);
  const res = await handler({
    httpMethod: "POST",
    body: JSON.stringify({ password: "test-pw", content: { banner: { enabled: "yes" } } })
  });
  const data = JSON.parse(res.body);
  assert.equal(data.content.banner.enabled, true);
  assert.equal(typeof data.content.banner.enabled, "boolean");
});

test("trims and caps oversized string fields instead of failing", async () => {
  const current = { heroTagline: "Old" };
  mockFetchSequence([
    { ok: true, status: 200, json: { sha: "s", content: b64(current) } },
    { ok: true, status: 200, json: {} }
  ]);
  const huge = "  " + "a".repeat(5000) + "  ";
  const res = await handler({
    httpMethod: "POST",
    body: JSON.stringify({ password: "test-pw", content: { heroTagline: huge } })
  });
  const data = JSON.parse(res.body);
  // Cap is applied before trim, so 2 leading spaces inside the 2000-char
  // window get trimmed away too — result is "at most 2000", here 1998.
  assert.ok(data.content.heroTagline.length <= 2000);
  assert.equal(data.content.heroTagline, "a".repeat(1998));
});
