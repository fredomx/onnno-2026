/* ==========================================================================
   Netlify Function: verify-password
   Called by /admin.html before it shows the edit form, so a wrong password
   is rejected right away instead of silently letting anyone in (reading
   content.json needs no auth, so that alone can't gate access). Checks
   only — never touches GitHub or content.json.
   ========================================================================== */
"use strict";

const { passwordsMatch } = require("./_lib/checkPassword");

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

  if (!process.env.ADMIN_PASSWORD) {
    return { statusCode: 500, body: JSON.stringify({ error: "El panel no está configurado (falta ADMIN_PASSWORD)." }) };
  }
  if (!passwordsMatch(body.password, process.env.ADMIN_PASSWORD)) {
    return { statusCode: 401, body: JSON.stringify({ error: "Contraseña incorrecta." }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
