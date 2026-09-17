# Admin panel tests

Dev-only test suite for the admin panel: `js/content.js` (content
hydration on the live site), `admin.html` (the panel itself), and the
Netlify Functions that back it — `verify-password.js` (checks the
password before the form is shown), `save-content.js` (commits edits to
GitHub), and the `_lib/checkPassword.js` comparator they share.
Deliberately isolated in this folder — its `package.json` and
`node_modules` never reach the Netlify deploy (publish root has no
`package.json`, so Netlify never runs `npm install` for the site).

## Run

```sh
cd tests
npm install   # first time only
npm test
```

Uses Node's built-in test runner (`node --test`, Node 18+) plus `jsdom`
as the only dependency, to run the real `js/content.js` and `admin.html`
`<script>` source against a simulated DOM — not reimplementations of
their logic.

## What's covered

- **`check-password.test.js`** — the shared constant-time comparator:
  matches, mismatches (same and different length), missing/empty
  inputs, case sensitivity.
- **`verify-password.test.js`** — the function `admin.html` calls before
  ever showing the form: rejects non-POST/bad JSON, a wrong or missing
  password, and an unconfigured `ADMIN_PASSWORD`; accepts the correct
  one.
- **`save-content.test.js`** — the Netlify function: rejects non-POST/
  bad JSON, rejects a wrong or unconfigured password *before* ever
  calling GitHub, only merges the whitelisted `content.json` fields
  (unknown/injected keys are dropped), preserves fields the request
  omitted, sends back the `sha` it just read (avoids clobbering a
  concurrent edit), and surfaces GitHub GET/PUT failures clearly.
- **`content-hydration.test.js`** — `js/content.js`: patches text/HTML/
  href/src/alt fields and rebuilds the hero tagline's styled slashes
  from real `content.json` data; falls back to the baked-in HTML
  untouched if the fetch fails; only auto-shows the banner when
  `banner.enabled` is explicitly `true`; and — the security-sensitive
  part — refuses an unsafe `href`/`src` (e.g. `javascript:`) and
  HTML-escapes text before turning `\n` into `<br>`, so `content.json`
  can never inject a live element into the page.
- **`admin-panel.test.js`** — the panel UI: a wrong password is rejected
  by `verify-password` *before* the form is shown or `content.json` is
  even fetched; a correct one reveals the real, populated form; the
  confirm-before-save dialog actually blocks the request when
  cancelled; a successful save posts the remembered password and
  edited fields; and a password rejected later at save time (e.g.
  rotated mid-session) clears the remembered password and shows the
  error.

## Not covered (by design, for a "super minimal" panel)

No end-to-end run against a live Netlify Function or real GitHub commit
— that needs `ADMIN_PASSWORD`/`GITHUB_TOKEN` configured on Netlify and
isn't something to exercise against the real repo from a test suite.
If you want that layer too, the natural next step is a staging site
pointed at a throwaway repo/branch.
