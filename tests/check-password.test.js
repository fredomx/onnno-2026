"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { passwordsMatch } = require("../netlify/functions/_lib/checkPassword");

test("matches identical strings", () => {
  assert.equal(passwordsMatch("LosPanesMasChidos41", "LosPanesMasChidos41"), true);
});

test("rejects a different string of the same length", () => {
  assert.equal(passwordsMatch("LosPanesMasChidoX41", "LosPanesMasChidos41"), false);
});

test("rejects strings of different lengths without throwing", () => {
  assert.equal(passwordsMatch("short", "a-much-longer-password"), false);
});

test("rejects when either side is missing or not a string", () => {
  assert.equal(passwordsMatch(undefined, "expected"), false);
  assert.equal(passwordsMatch(null, "expected"), false);
  assert.equal(passwordsMatch("", "expected"), false);
  assert.equal(passwordsMatch("guess", ""), false);
  assert.equal(passwordsMatch("guess", undefined), false);
});

test("is case-sensitive", () => {
  assert.equal(passwordsMatch("vallechilemonte76", "ValleChileMonte76"), false);
});
