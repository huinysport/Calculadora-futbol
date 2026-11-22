// Función para Cloudflare Pages: valida el código de acceso y entrega los promedios de la hoja "Datos".
// Ruta pública: /api/ligas16

const SPREADSHEET_ID = "1atnKmdlGH0prq5U2k2p7ecRo55u7yqc_-THoMRyLF8E";
const RANGO = "Datos!A2:R20000";
// Hoja donde están los códigos de acceso (pestaña "Codigos": A código, B cliente, C activo SI/NO, D dispositivo, E último uso)
const CODIGOS_ID = "1TyYYxX6rFJt8Dvyr21LyajOIuJrK3aQ7LHi_hBEEoXs";
const MINUTOS_REGISTRO = 10; // cada cuántos minutos se actualiza "Último uso"
const SEGUNDOS_CACHE = 60; // guarda los datos 60 s para no consultar a Google en cada visita

let cacheDatos = null;
let cacheHasta = 0;
let tokenGuardado = null;
let tokenHasta = 0;

export async function onRequestGet(context) {
  try {
    const cred = leerCredenciales(context.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const token = await obtenerToken(cred);

    // ---- Control de acceso por código (un dispositivo a la vez) ----
    const h = context.request.headers;
    const codigo = String(h.get("x-codigo") || "").trim().toUpperCase();
    const dispositivo = String(h.get("x-dispositivo") || "").trim().slice(0, 64);
    if (!codigo || !dispositivo) return respuesta(401, { error: "Escribe tu código de acceso.", motivo: "falta" });

    const rc = await leerRango(token, CODIGOS_ID, "Codigos!A2:E1000");
    const filasC = rc.values || [];
    let fila = -1;
    for (let i = 0; i < filasC.length; i++) {
      if (String(filasC[i][0] || "").trim().toUpperCase() === codigo) { fila = i; break; }
    }
    if (fila < 0) return respuesta(401, { error: "Ese código no existe.", motivo: "invalido" });
    const activo = String(filasC[fila][2] || "").trim().toUpperCase();
    if (activo !== "SI" && activo !== "SÍ") return respuesta(401, { error: "Ese código está desactivado.", motivo: "inactivo" });

    const dispActual = String(filasC[fila][3] || "").trim();
    const ultimo = Date.parse(String(filasC[fila][4] || "")) || 0;
    const ahora = Date.now();
    if (dispActual && dispActual !== dispositivo && h.get("x-tomar") !== "1") {
      return respuesta(401, { error: "Este código se está usando en otro dispositivo.", motivo: "otro_dispositivo" });
    }
    if (dispActual !== dispositivo || ahora - ultimo > MINUTOS_REGISTRO * 60 * 1000) {
      const urlW = "https://sheets.googleapis.com/v4/spreadsheets/" + CODIGOS_ID + "/values/" +
        encodeURIComponent("Codigos!D" + (fila + 2) + ":E" + (fila + 2)) + "?valueInputOption=RAW";
      const w = await fetch(urlW, {
        method: "PUT",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [[dispositivo, new Date(ahora).toISOString()]] })
      });
      if (!w.ok) throw new Error("No pude registrar el uso del código (" + w.status + "). La cuenta de servicio debe ser Editor de la hoja de códigos.");
    }

    // ---- Datos (con copia de 60 s) ----
    if (cacheDatos && ahora < cacheHasta) return respuesta(200, cacheDatos);
    const j = await leerRango(token, SPREADSHEET_ID, RANGO);
    const filas = j.values || [];

    // A competición, B equipo, C-J datos en casa (L), K-R datos fuera (V)
    const competiciones = {};
    for (const f of filas) {
      const comp = String(f[0] || "").trim();
      const equipo = String(f[1] || "").trim();
      if (!comp || !equipo) continue;
      const v = [];
      for (let k = 2; k <= 17; k++) v.push(numero(f[k]));
      if (!competiciones[comp]) competiciones[comp] = [];
      competiciones[comp].push({ e: equipo, v: v });
    }
    cacheDatos = { competiciones: competiciones };
    cacheHasta = ahora + SEGUNDOS_CACHE * 1000;
    return respuesta(200, cacheDatos);
  } catch (error) {
    return respuesta(500, { error: error.message || "Ocurrió un error desconocido." });
  }
}

async function leerRango(token, id, rango) {
  const url = "https://sheets.googleapis.com/v4/spreadsheets/" + id +
    "/values/" + encodeURIComponent(rango) + "?valueRenderOption=UNFORMATTED_VALUE";
  const r = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error("Google Sheets respondió " + r.status + ": " + txt.slice(0, 200));
  }
  return r.json();
}

function numero(x) {
  if (typeof x === "number") return x;
  if (x === undefined || x === null || x === "") return null;
  const n = parseFloat(String(x).replace(",", "."));
  return isNaN(n) ? null : n;
}

function b64url(bytes) {
  let s = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function textoB64url(t) { return b64url(new TextEncoder().encode(t)); }

async function obtenerToken(cred) {
  const ahora = Date.now();
  if (tokenGuardado && ahora < tokenHasta) return tokenGuardado;

  const seg = Math.floor(ahora / 1000);
  const cab = textoB64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const cuerpo = textoB64url(JSON.stringify({
    iss: cred.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: seg,
    exp: seg + 3600
  }));
  const pem = String(cred.private_key)
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const clave = await crypto.subtle.importKey(
    "pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const firma = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", clave, new TextEncoder().encode(cab + "." + cuerpo));
  const jwt = cab + "." + cuerpo + "." + b64url(firma);

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + jwt
  });
  if (!r.ok) throw new Error("No pude entrar a Google: " + r.status + " " + (await r.text()).slice(0, 200));
  const j = await r.json();
  tokenGuardado = j.access_token;
  tokenHasta = ahora + (j.expires_in - 120) * 1000;
  return tokenGuardado;
}

function leerCredenciales(rawEnv) {
  if (!rawEnv) throw new Error("Falta configurar la variable GOOGLE_SERVICE_ACCOUNT_JSON.");
  let texto = String(rawEnv).replace(/^﻿/, "").trim();
  texto = texto.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const intentos = [texto];
  if ((texto.startsWith('"') && texto.endsWith('"')) || (texto.startsWith("'") && texto.endsWith("'"))) {
    intentos.push(texto.slice(1, -1));
  }
  intentos.push(texto.replace(/\\"/g, '"'));
  try {
    const dec = atob(texto);
    if (dec.trim().startsWith("{")) intentos.push(dec.trim());
  } catch (e) { /* no era base64 */ }
  for (const intento of intentos) {
    try {
      const obj = JSON.parse(intento);
      if (obj && obj.client_email && obj.private_key) {
        obj.private_key = String(obj.private_key).replace(/\\n/g, "\n");
        return obj;
      }
    } catch (e) { /* sigue con el siguiente */ }
  }
  throw new Error("No pude leer GOOGLE_SERVICE_ACCOUNT_JSON. Debe contener el archivo .json completo, empezando con { y terminando con }.");
}

function respuesta(status, body) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
