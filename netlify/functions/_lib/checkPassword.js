/* Shared by verify-password.js and save-content.js. Constant-time string
   compare so a wrong guess can't be narrowed down by measuring response
   time — cheap to do, no reason not to. */
"use strict";

const crypto = require("node:crypto");

function passwordsMatch(input, expected) {
  if (typeof input !== "string" || typeof expected !== "string" || !expected) return false;
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still do a same-cost comparison on a mismatch so the timing of an
    // early return doesn't leak the expected password's length either.
    crypto.timingSafeEqual(Buffer.alloc(b.length), Buffer.alloc(b.length));
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

module.exports = { passwordsMatch };
