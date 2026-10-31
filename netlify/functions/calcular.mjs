import { google } from "googleapis";

const SPREADSHEET_ID = "1Bdg2g1XQo5tDpzqbn4cMP1NqYCnEvimMNnp4VA-YlM0";
const SHEET_NAME = "presur";

export default async (request) => {
  if (request.method !== "POST") {
    return respuesta(405, { error: "Método no permitido." });
  }

  try {
    const { local, visitante } = await request.json();

    if (!local || !visitante || !local.trim() || !visitante.trim()) {
      return respuesta(400, { error: "Escribe los nombres de los dos equipos." });
    }

    const estadisticas = await buscarEstadisticas(local.trim(), visitante.trim());
    const valores = validarEstadisticas(estadisticas);

    const credentials = leerCredenciales(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

    const auth = new google.auth.GoogleAuth({
      credentials: credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
    const sheets = google.sheets({ version: "v4", auth: auth });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: "'" + SHEET_NAME + "'!J6:K13",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: valores.map((fila) => [fila.local, fila.visitante]) }
    });

    const lectura = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "'" + SHEET_NAME + "'!E10",
      valueRenderOption: "FORMATTED_VALUE"
    });

    const filas = lectura.data.values;
    const veredicto = filas && filas[0] ? filas[0][0] : null;
    if (!veredicto) {
      throw new Error("La celda E10 está vacía o no se pudo leer.");
    }

    return respuesta(200, { veredicto: veredicto, estadisticas: valores });
  } catch (error) {
    console.error("Error detallado:", error);
    return respuesta(500, { error: error.message || "Ocurrió un error desconocido." });
  }
};

// Lee las credenciales de Google aunque la variable esté pegada con comillas,
// con comillas escapadas, con comillas "curvas" o codificada en base64.
function leerCredenciales(rawEnv) {
  if (!rawEnv) {
    throw new Error("Falta configurar la variable GOOGLE_SERVICE_ACCOUNT_JSON en Netlify.");
  }

  let texto = String(rawEnv).replace(/^\uFEFF/, "").trim();

  // Comillas curvas -> comillas normales
  texto = texto.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");

  const intentos = [];

  // 1) Tal cual
  intentos.push(texto);

  // 2) Envuelto en comillas por fuera
  if (
    (texto.startsWith('"') && texto.endsWith('"')) ||
    (texto.startsWith("'") && texto.endsWith("'"))
  ) {
    intentos.push(texto.slice(1, -1));
  }

  // 3) Con comillas escapadas: {\"type\": ...}
  intentos.push(texto.replace(/\\"/g, '"'));
  if (texto.startsWith('"') && texto.endsWith('"')) {
    intentos.push(texto.slice(1, -1).replace(/\\"/g, '"'));
  }

  // 4) Codificado en base64
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
        // Si los saltos de línea de la llave quedaron como texto "\n", se arreglan
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

async function buscarEstadisticas(local, visitante) {
  const prompt = [
    "Busca estadísticas verificables de los últimos 10 partidos de liga:",
    "- " + local + ": sus 10 partidos más recientes como equipo local.",
    "- " + visitante + ": sus 10 partidos más recientes como equipo visitante.",
    "",
    "Devuelve únicamente JSON con este formato. Cada valor debe ser el promedio por partido:",
    "{",
    '  "local": {',
    '    "tiros_favor": 0, "corners_favor": 0, "tiros_arco_favor": 0, "goles_favor": 0,',
    '    "tiros_contra": 0, "corners_contra": 0, "tiros_arco_contra": 0, "goles_contra": 0',
    "  },",
    '  "visitante": {',
    '    "tiros_favor": 0, "corners_favor": 0, "tiros_arco_favor": 0, "goles_favor": 0,',
    '    "tiros_contra": 0, "corners_contra": 0, "tiros_arco_contra": 0, "goles_contra": 0',
    "  }",
    "}",
    'No inventes datos. Si no puedes confirmar una estadística, responde únicamente {"error": "indica cuál falta"}.'
  ].join("\n");

  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
    encodeURIComponent(process.env.GEMINI_API_KEY);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0 }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error((data.error && data.error.message) || "Gemini no pudo buscar los datos.");
  }

  const partes =
    data.candidates && data.candidates[0] && data.candidates[0].content
      ? data.candidates[0].content.parts
      : null;
  const texto = partes ? partes.map((parte) => parte.text || "").join("") : "";

  if (!texto) throw new Error("Gemini no devolvió estadísticas.");

  const json = texto.match(/\{[\s\S]*\}/);
  if (!json) throw new Error("La respuesta de Gemini no tenía el formato esperado.");

  const resultado = JSON.parse(json[0]);
  if (resultado.error) {
    throw new Error("Gemini no pudo confirmar los datos: " + resultado.error);
  }

  return resultado;
}

function validarEstadisticas(data) {
  const campos = [
    "tiros_favor", "corners_favor", "tiros_arco_favor", "goles_favor",
    "tiros_contra", "corners_contra", "tiros_arco_contra", "goles_contra"
  ];

  for (const equipo of ["local", "visitante"]) {
    if (!data[equipo]) throw new Error("Faltan datos del equipo " + equipo + ".");
    for (const campo of campos) {
      const crudo = data[equipo][campo];
      const valor = Number(crudo);
      if (crudo === null || crudo === undefined || crudo === "" || !Number.isFinite(valor) || valor < 0) {
        throw new Error("Falta un dato verificable: " + equipo + "." + campo);
      }
      data[equipo][campo] = valor;
    }
  }

  return campos.map((campo) => ({
    local: data.local[campo],
    visitante: data.visitante[campo]
  }));
}

function respuesta(status, body) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { "Content-Type": "application/json" }
  });
}
