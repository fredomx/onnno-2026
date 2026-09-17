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

   If the request also carries `bannerImageUpload` ({dataUrl, filename}),
   that image is committed first (as assets/img/banner-custom.<ext>,
   overwriting whatever was there before — this is a single-image slot,
   not a gallery) and its path is what banner.image ends up set to,
   overriding anything sent in `content.banner.image`.

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
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB raw; keeps the base64 request comfortably under the 6MB function payload limit
const IMAGE_MIME_TO_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

// path -> {type: "string"|"bool"|"enum", values?}. Anything not listed here is dropped.
const FIELDS = {
  "contact.restaurantAddress": { type: "string" },
  "contact.restaurantMapUrl": { type: "string" },
  "contact.bakeryAddress": { type: "string" },
  "contact.bakeryMapUrl": { type: "string" },
  "contact.city": { type: "string" },
  "contact.hoursBakery": { type: "string" },
  "contact.hoursRestaurant": { type: "string" },
  "social.instagramUrl": { type: "string" },
  "social.instagramHandle": { type: "string" },
  "heroTagline": { type: "string" },
  "banner.enabled": { type: "bool" },
  "banner.image": { type: "string" },
  "banner.imageAlt": { type: "string" },
  "banner.title": { type: "string" },
  "banner.subtitle": { type: "string" },
  "banner.confettiStyle": { type: "enum", values: ["clasico", "fuegos", "espiral"] }
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
    const spec = FIELDS[path];
    const val = getPath(incoming, path);
    if (val === undefined) continue;
    if (spec.type === "string" && typeof val === "string") {
      setPath(out, path, val.slice(0, 2000).trim());
    } else if (spec.type === "bool") {
      setPath(out, path, !!val);
    } else if (spec.type === "enum" && typeof val === "string" && spec.values.includes(val)) {
      setPath(out, path, val);
    }
  }
  return out;
}

// Commits a data-URL image as the site's one banner image slot, overwriting
// any previous upload regardless of its extension. Returns the committed
// path (e.g. "assets/img/banner-custom.jpg").
async function commitBannerImage(upload, ghHeaders) {
  const dataUrl = upload && upload.dataUrl;
  const match = typeof dataUrl === "string" && /^data:([^;]+);base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!match) throw new Error("Imagen inválida.");

  const mime = match[1].toLowerCase();
  const ext = IMAGE_MIME_TO_EXT[mime];
  if (!ext) throw new Error("Formato de imagen no permitido. Usa JPG, PNG o WEBP.");

  const base64Data = match[2].replace(/\s/g, "");
  const byteLength = Math.floor((base64Data.length * 3) / 4);
  if (byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`La imagen pesa demasiado (máximo ${(MAX_IMAGE_BYTES / (1024 * 1024)).toFixed(0)} MB).`);
  }

  const imagePath = `assets/img/banner-custom.${ext}`;
  const imageApiUrl = `https://api.github.com/repos/${REPO}/contents/${imagePath}`;

  let sha;
  const existingRes = await fetch(`${imageApiUrl}?ref=${BRANCH}`, { headers: ghHeaders });
  if (existingRes.ok) {
    sha = (await existingRes.json()).sha;
  } else if (existingRes.status !== 404) {
    throw new Error(`No se pudo verificar la imagen actual en GitHub (${existingRes.status}).`);
  }

  const putRes = await fetch(imageApiUrl, {
    method: "PUT",
    headers: { ...ghHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "Actualiza la imagen del banner desde el panel de administración",
      content: base64Data,
      branch: BRANCH,
      ...(sha ? { sha } : {})
    })
  });
  if (!putRes.ok) {
    const errText = await putRes.text();
    throw new Error(`GitHub rechazó la imagen (${putRes.status}): ${errText.slice(0, 300)}`);
  }

  return imagePath;
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

  const { password, content, bannerImageUpload } = body;

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

  const ghHeaders = {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    "User-Agent": "onnno-admin-panel",
    Accept: "application/vnd.github+json"
  };

  let workingContent = content;
  if (bannerImageUpload) {
    try {
      const imagePath = await commitBannerImage(bannerImageUpload, ghHeaders);
      workingContent = { ...content, banner: { ...(content.banner || {}), image: imagePath } };
    } catch (err) {
      return { statusCode: 400, body: JSON.stringify({ error: err.message || String(err) }) };
    }
  }

  const apiUrl = `https://api.github.com/repos/${REPO}/contents/${PATH}`;

  try {
    const getRes = await fetch(`${apiUrl}?ref=${BRANCH}`, { headers: ghHeaders });
    if (!getRes.ok) {
      throw new Error(`No se pudo leer el contenido actual en GitHub (${getRes.status}).`);
    }
    const current = await getRes.json();
    const currentContent = JSON.parse(Buffer.from(current.content, "base64").toString("utf-8"));

    const merged = sanitizeMerge(currentContent, workingContent);
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
