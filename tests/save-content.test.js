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

// Same as mockFetchSequence, but also records {url, opts} for each call so
// tests can assert on request order/shape (used by the image-upload tests,
// where a save can make up to four GitHub calls: GET/PUT image, GET/PUT
// content.json).
function mockFetchSequenceRecording(responses) {
  const calls = [];
  let i = 0;
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    const r = responses[i++];
    if (!r) throw new Error("mockFetchSequenceRecording: ran out of queued responses for " + url);
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.json,
      text: async () => r.text || ""
    };
  };
  return calls;
}

function pngDataUrl() {
  // Contents don't need to be a real image for this function's logic — it
  // only checks the mime prefix and decodes/size-checks the base64 body.
  return "data:image/png;base64," + Buffer.from("hello").toString("base64");
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

test("accepts a valid banner.confettiStyle and drops an invalid one instead of writing it through", async () => {
  const current = { banner: { confettiStyle: "clasico" } };

  mockFetchSequence([
    { ok: true, status: 200, json: { sha: "s", content: b64(current) } },
    { ok: true, status: 200, json: {} }
  ]);
  let res = await handler({
    httpMethod: "POST",
    body: JSON.stringify({ password: "test-pw", content: { banner: { confettiStyle: "fuegos" } } })
  });
  assert.equal(JSON.parse(res.body).content.banner.confettiStyle, "fuegos");

  mockFetchSequence([
    { ok: true, status: 200, json: { sha: "s", content: b64(current) } },
    { ok: true, status: 200, json: {} }
  ]);
  res = await handler({
    httpMethod: "POST",
    body: JSON.stringify({ password: "test-pw", content: { banner: { confettiStyle: "not-a-real-style" } } })
  });
  assert.equal(JSON.parse(res.body).content.banner.confettiStyle, "clasico", "invalid enum value must be dropped, keeping the prior one");
});

test("bannerImageUpload: commits a new image (no prior upload) then points banner.image at it", async () => {
  const currentJsonContent = { banner: { image: "assets/img/birthday-announcement.jpg", enabled: false } };
  const calls = mockFetchSequenceRecording([
    { ok: false, status: 404, text: "Not Found" }, // GET assets/img/banner-custom.png -> doesn't exist yet
    { ok: true, status: 200, json: { content: { sha: "img-sha-1" } } }, // PUT image
    { ok: true, status: 200, json: { sha: "content-sha-1", content: b64(currentJsonContent) } }, // GET content.json
    { ok: true, status: 200, json: {} } // PUT content.json
  ]);

  const res = await handler({
    httpMethod: "POST",
    body: JSON.stringify({
      password: "test-pw",
      content: { banner: { title: "Nuevo anuncio" } },
      bannerImageUpload: { dataUrl: pngDataUrl(), filename: "foto.png" }
    })
  });

  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.content.banner.image, "assets/img/banner-custom.png");
  assert.equal(data.content.banner.title, "Nuevo anuncio");

  assert.equal(calls.length, 4);
  assert.match(calls[0].url, /banner-custom\.png\?ref=main/);
  assert.equal(calls[1].opts.method, "PUT");
  const imagePutBody = JSON.parse(calls[1].opts.body);
  assert.equal(imagePutBody.sha, undefined, "must not send a sha when creating a new file");
  assert.equal(imagePutBody.content, Buffer.from("hello").toString("base64"));
});

test("bannerImageUpload: reuses the previous upload's sha when overwriting it", async () => {
  const currentJsonContent = { banner: {} };
  const calls = mockFetchSequenceRecording([
    { ok: true, status: 200, json: { sha: "existing-image-sha" } }, // GET existing image -> found
    { ok: true, status: 200, json: {} }, // PUT image
    { ok: true, status: 200, json: { sha: "content-sha", content: b64(currentJsonContent) } },
    { ok: true, status: 200, json: {} }
  ]);

  await handler({
    httpMethod: "POST",
    body: JSON.stringify({
      password: "test-pw",
      content: {},
      bannerImageUpload: { dataUrl: pngDataUrl(), filename: "foto.png" }
    })
  });

  const imagePutBody = JSON.parse(calls[1].opts.body);
  assert.equal(imagePutBody.sha, "existing-image-sha");
});

test("bannerImageUpload: rejects a disallowed mime type without ever touching content.json", async () => {
  let contentJsonTouched = false;
  global.fetch = async (url) => { contentJsonTouched = contentJsonTouched || /content\.json/.test(url); return { ok: false, status: 404, text: async () => "" }; };

  const res = await handler({
    httpMethod: "POST",
    body: JSON.stringify({
      password: "test-pw",
      content: {},
      bannerImageUpload: { dataUrl: "data:image/gif;base64,aGVsbG8=", filename: "foto.gif" }
    })
  });

  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /formato/i);
  assert.equal(contentJsonTouched, false);
});

test("bannerImageUpload: rejects an oversized image without ever touching content.json", async () => {
  let contentJsonTouched = false;
  global.fetch = async (url) => { contentJsonTouched = contentJsonTouched || /content\.json/.test(url); return { ok: false, status: 404, text: async () => "" }; };

  const hugeBase64 = "A".repeat(6 * 1024 * 1024); // decodes to ~4.5MB, over the 4MB cap
  const res = await handler({
    httpMethod: "POST",
    body: JSON.stringify({
      password: "test-pw",
      content: {},
      bannerImageUpload: { dataUrl: "data:image/png;base64," + hugeBase64, filename: "foto.png" }
    })
  });

  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /pesa demasiado/i);
  assert.equal(contentJsonTouched, false);
});

test("bannerImageUpload: rejects a malformed data URL", async () => {
  const res = await handler({
    httpMethod: "POST",
    body: JSON.stringify({
      password: "test-pw",
      content: {},
      bannerImageUpload: { dataUrl: "not-a-data-url", filename: "foto.png" }
    })
  });
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /inválida/i);
});
