/* ==========================================================================
   Netlify Function: save-content
   Called by /admin.html on "Guardar cambios". Checks the shared admin
   password (env var ADMIN_PASSWORD) and, if it matches, commits an updated
   content.json straight to GitHub via the Contents API using a repo-scoped
   token (env var GITHUB_TOKEN). Netlify's existing GitHub integration then
   redeploys the site automatically, same as any other push to main.

   Only the fields listed in FIELDS below are ever written — anything else
   in the request body is ignored, and any field missing from the request
   keeps its current value from the live content.json (fetched fresh right
   before the commit, so this can't clobber a concurrent edit).

   Required Netlify env vars (Site settings -> Environment variables):
     ADMIN_PASSWORD  - the password admin.html asks for
     GITHUB_TOKEN    - a GitHub personal access token with `contents: write`
                       (fine-grained) or `repo` (classic) on this one repo
   ========================================================================== */
"use strict";

const { passwordsMatch } = require("./_lib/checkPassword");

const REPO = "fredomx/onnno-2026";
const BRANCH = "main";
const PATH = "content.json";

// path -> "string" | "bool". Anything not listed here is dropped.
const FIELDS = {
  "contact.restaurantAddress": "string",
  "contact.restaurantMapUrl": "string",
  "contact.bakeryAddress": "string",
  "contact.bakeryMapUrl": "string",
  "contact.city": "string",
  "contact.hoursBakery": "string",
  "contact.hoursRestaurant": "string",
  "social.instagramUrl": "string",
  "social.instagramHandle": "string",
  "heroTagline": "string",
  "banner.enabled": "bool",
  "banner.image": "string",
  "banner.imageAlt": "string",
  "banner.title": "string",
  "banner.subtitle": "string"
};

function getPath(obj, path) {
  return path.split(".").reduce((acc, key) => (acc && typeof acc === "object" ? acc[key] : undefined), obj);
}

function setPath(obj, path, value) {
  const keys = path.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== "object" || cur[keys[i]] === null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

// Merge only known, well-typed fields from `incoming` on top of `base`.
function sanitizeMerge(base, incoming) {
  const out = JSON.parse(JSON.stringify(base || {}));
  for (const path of Object.keys(FIELDS)) {
    const type = FIELDS[path];
    const val = getPath(incoming, path);
    if (val === undefined) continue;
    if (type === "string" && typeof val === "string") {
      setPath(out, path, val.slice(0, 2000).trim());
    } else if (type === "bool") {
      setPath(out, path, !!val);
    }
  }
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Método no permitido" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "JSON inválido" }) };
  }

  const { password, content } = body;

  if (!process.env.ADMIN_PASSWORD) {
    return { statusCode: 500, body: JSON.stringify({ error: "El panel no está configurado (falta ADMIN_PASSWORD)." }) };
  }
  if (!passwordsMatch(password, process.env.ADMIN_PASSWORD)) {
    return { statusCode: 401, body: JSON.stringify({ error: "Contraseña incorrecta." }) };
  }
  if (!content || typeof content !== "object") {
    return { statusCode: 400, body: JSON.stringify({ error: "Contenido inválido." }) };
  }
  if (!process.env.GITHUB_TOKEN) {
    return { statusCode: 500, body: JSON.stringify({ error: "El panel no está configurado (falta GITHUB_TOKEN)." }) };
  }

  const apiUrl = `https://api.github.com/repos/${REPO}/contents/${PATH}`;
  const ghHeaders = {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    "User-Agent": "onnno-admin-panel",
    Accept: "application/vnd.github+json"
  };

  try {
    const getRes = await fetch(`${apiUrl}?ref=${BRANCH}`, { headers: ghHeaders });
    if (!getRes.ok) {
      throw new Error(`No se pudo leer el contenido actual en GitHub (${getRes.status}).`);
    }
    const current = await getRes.json();
    const currentContent = JSON.parse(Buffer.from(current.content, "base64").toString("utf-8"));

    const merged = sanitizeMerge(currentContent, content);
    const newBase64 = Buffer.from(JSON.stringify(merged, null, 2) + "\n", "utf-8").toString("base64");

    const putRes = await fetch(apiUrl, {
      method: "PUT",
      headers: { ...ghHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Actualización desde el panel de administración",
        content: newBase64,
        sha: current.sha,
        branch: BRANCH
      })
    });

    if (!putRes.ok) {
      const errText = await putRes.text();
      throw new Error(`GitHub rechazó el cambio (${putRes.status}): ${errText.slice(0, 300)}`);
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, content: merged }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message || String(err) }) };
  }
};
