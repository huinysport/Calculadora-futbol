import { google } from "googleapis";

// Hoja de Google "Calculadora de futbol por ligas" (hoja Datos)
const SPREADSHEET_ID = "1TyYYxX6rFJt8Dvyr21LyajOIuJrK3aQ7LHi_hBEEoXs";

export default async (request) => {
  try {
    const credentials = leerCredenciales(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials: credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
    });
    const sheets = google.sheets({ version: "v4", auth: auth });

    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "Datos!A2:J50000",
      valueRenderOption: "UNFORMATTED_VALUE"
    });
    const filas = r.data.values || [];

    // Columnas: A país, B equipo, C-F tiros (a favor/contra local, a favor/contra visitante),
    // G-J córners (en el mismo orden)
    const paises = {};
    for (const f of filas) {
      const pais = String(f[0] || "").trim();
      const equipo = String(f[1] || "").trim();
      if (!pais || !equipo) continue;
      const v = [];
      for (let k = 2; k <= 9; k++) v.push(numero(f[k]));
      if (!paises[pais]) paises[pais] = [];
      paises[pais].push({ equipo: equipo, v: v });
    }
    return respuesta(200, { paises: paises });
  } catch (error) {
    return respuesta(500, { error: error.message || "Ocurrió un error desconocido." });
  }
};

function numero(x) {
  if (typeof x === "number") return x;
  if (x === undefined || x === null || x === "") return null;
  const n = parseFloat(String(x).replace(",", "."));
  return isNaN(n) ? null : n;
}

function leerCredenciales(rawEnv) {
  if (!rawEnv) {
    throw new Error("Falta configurar la variable GOOGLE_SERVICE_ACCOUNT_JSON en Netlify.");
  }

  let texto = String(rawEnv).replace(/^﻿/, "").trim();
  texto = texto.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

  const intentos = [];
  intentos.push(texto);

  if (
    (texto.startsWith('"') && texto.endsWith('"')) ||
    (texto.startsWith("'") && texto.endsWith("'"))
  ) {
    intentos.push(texto.slice(1, -1));
  }

  intentos.push(texto.replace(/\\"/g, '"'));
  if (texto.startsWith('"') && texto.endsWith('"')) {
    intentos.push(texto.slice(1, -1).replace(/\\"/g, '"'));
  }

  try {
    const decodificado = Buffer.from(texto, "base64").toString("utf8").trim();
    if (decodificado.startsWith("{")) intentos.push(decodificado);
  } catch (e) {
    // se ignora
  }

  for (const intento of intentos) {
    try {
      const obj = JSON.parse(intento);
      if (obj && typeof obj === "object" && obj.client_email && obj.private_key) {
        obj.private_key = String(obj.private_key).replace(/\\n/g, "\n");
        return obj;
      }
    } catch (e) {
      // sigue con el siguiente intento
    }
  }

  throw new Error(
    "No pude leer GOOGLE_SERVICE_ACCOUNT_JSON. Debe contener el archivo .json completo, " +
    'empezando con { y terminando con }. Lo que recibí empieza así: "' +
    texto.slice(0, 12) + '"'
  );
}

function respuesta(status, body) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
