{ google } from "googleapis";

const SPREADSHEET_ID = "1Bdg2g1XQo5tDpzqbn4cMP1NqYCnEvimMNnp4VA-YlM0";
const HOJA_CACHE = "cache";
const API_BASE = "https://v3.football.api-sports.io";
const PARTIDOS = 10;       // cuántos partidos se promedian
const MINIMO_VALIDOS = 5;  // mínimo de partidos con estadísticas completas

// Umbrales del veredicto (cámbialos aquí si quieres)
const UMBRAL_PRESION = 4.3;         // tiros y córners: gana
const UMBRAL_GOLES = 1.5;           // tiros al arco + goles: gana
const UMBRAL_LOCAL_PRESION = 1;     // local: gana o empata
const UMBRAL_LOCAL_GOLES = 0.5;
const UMBRAL_VISITA_PRESION = 2;    // visitante: gana o empata
const UMBRAL_VISITA_GOLES = 1;

const CAMPOS = [
  "tiros_favor", "corners_favor", "tiros_arco_favor", "goles_favor",
  "tiros_contra", "corners_contra", "tiros_arco_contra", "goles_contra"
];

export default async (request) => {
  if (request.method !== "POST") {
    return respuesta(405, { error: "Método no permitido." });
  }

  try {
    const { local, visitante } = await request.json();

    if (!local || !visitante || !local.trim() || !visitante.trim()) {
      return respuesta(400, { error: "Escribe los nombres de los dos equipos." });
    }

    const credentials = leerCredenciales(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials: credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
    const sheets = google.sheets({ version: "v4", auth: auth });

    await asegurarHojaCache(sheets);
    const filas = await leerCache(sheets);

    const [datosLocal, datosVisitante] = await Promise.all([
      promediosEquipo(sheets, filas, local.trim(), "casa"),
      promediosEquipo(sheets, filas, visitante.trim(), "fuera")
    ]);

    const estadisticas = CAMPOS.map((campo, i) => ({
      local: datosLocal.valores[i],
      visitante: datosVisitante.valores[i]
    }));

    const resultado = calcularVeredicto(datosLocal.valores, datosVisitante.valores);

    return respuesta(200, {
      veredicto: resultado.veredicto,
      diferencias: resultado.diferencias,
      equipos: { local: datosLocal.nombre, visitante: datosVisitante.nombre },
      estadisticas: estadisticas
    });
  } catch (error) {
    console.error("Error detallado:", error);
    return respuesta(500, { error: error.message || "Ocurrió un error desconocido." });
  }
};

// ---------- Veredicto (misma regla que la calculadora) ----------

export function calcularVeredicto(L, V) {
  // Orden de CAMPOS: 0 tiros, 1 córners, 2 arco, 3 goles (a favor); 4..7 lo mismo en contra
  const dif = (a, b, ca, cb) => {
    const atkL = L[a] + L[b], defL = L[ca] + L[cb];
    const atkV = V[a] + V[b], defV = V[ca] + V[cb];
    return (atkL + defV) / 2 - (atkV + defL) / 2;
  };
  const dPres = dif(0, 1, 4, 5);
  const dGol = dif(2, 3, 6, 7);

  const positivo = (dPres !== 0 ? dPres : dGol) >= 0;
  let veredicto;
  if (positivo) {
    if (dGol > UMBRAL_GOLES && dPres > UMBRAL_PRESION) veredicto = "Gana local";
    else if (dGol > UMBRAL_LOCAL_GOLES && dPres > UMBRAL_LOCAL_PRESION) veredicto = "Gana o empata local";
    else veredicto = "Dudoso";
  } else {
    if (dGol < -UMBRAL_GOLES && dPres < -UMBRAL_PRESION) veredicto = "Gana visitante";
    else if (dGol < -UMBRAL_VISITA_GOLES && dPres < -UMBRAL_VISITA_PRESION) veredicto = "Gana o empata visitante";
    else veredicto = "Dudoso";
  }
  return {
    veredicto: veredicto,
    diferencias: { tiros_corners: redondear(dPres), goles: redondear(dGol) }
  };
}

// ---------- Promedios de un equipo (con caché en la hoja) ----------

async function promediosEquipo(sheets, filas, nombre, lugar) {
  const clave = normalizar(nombre) + "|" + lugar;
  const hoy = fechaHoy();
  const idx = filas.findIndex((f) => f[0] === clave);

  // Si ya se calculó hoy, se lee de la hoja y no se gasta la API
  if (idx >= 0 && filas[idx][3] === hoy) {
    return {
      nombre: filas[idx][2],
      valores: CAMPOS.map((_, i) => Number(filas[idx][4 + i]))
    };
  }

  const equipo = await buscarEquipo(nombre);
  const calculado = await calcularPromedios(equipo.id, lugar);
  const valores = CAMPOS.map((campo) => calculado[campo]);

  const fila = [clave, equipo.id, equipo.nombre, hoy].concat(valores, [calculado.partidos]);
  if (idx >= 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: "'" + HOJA_CACHE + "'!A" + (idx + 2) + ":M" + (idx + 2),
      valueInputOption: "RAW",
      requestBody: { values: [fila] }
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "'" + HOJA_CACHE + "'!A:M",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [fila] }
    });
  }

  return { nombre: equipo.nombre, valores: valores };
}

async function buscarEquipo(nombre) {
  const q = normalizar(nombre).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (q.length < 3) throw new Error("Escribe al menos 3 letras del equipo: " + nombre);
  const data = await api("/teams?search=" + encodeURIComponent(q));
  const lista = (data.response || []).filter((r) => r.team);
  if (!lista.length) throw new Error("No encontré el equipo \"" + nombre + "\". Prueba con otro nombre.");
  const club = lista.find((r) => !r.team.national) || lista[0];
  return { id: club.team.id, nombre: club.team.name };
}

async function calcularPromedios(id, lugar) {
  const data = await api("/fixtures?team=" + id + "&last=40");
  const terminados = (data.response || [])
    .filter((p) => p.fixture && p.fixture.status && p.fixture.status.short === "FT")
    .filter((p) => (lugar === "casa" ? p.teams.home.id === id : p.teams.away.id === id))
    .sort((a, b) => b.fixture.timestamp - a.fixture.timestamp)
    .slice(0, PARTIDOS);

  if (!terminados.length) throw new Error("No encontré partidos recientes de ese equipo.");

  const estadisticas = await Promise.all(
    terminados.map((p) => api("/fixtures/statistics?fixture=" + p.fixture.id))
  );

  const suma = {};
  CAMPOS.forEach((c) => { suma[c] = 0; });
  let validos = 0;

  terminados.forEach((p, i) => {
    const equipos = estadisticas[i].response || [];
    const propio = equipos.find((e) => e.team && e.team.id === id);
    const rival = equipos.find((e) => e.team && e.team.id !== id);
    if (!propio || !rival) return;

    const t1 = dato(propio, "Total Shots"), c1 = dato(propio, "Corner Kicks"), a1 = dato(propio, "Shots on Goal");
    const t2 = dato(rival, "Total Shots"), c2 = dato(rival, "Corner Kicks"), a2 = dato(rival, "Shots on Goal");
    if ([t1, c1, a1, t2, c2, a2].some((x) => x === null)) return;

    const golesPropios = lugar === "casa" ? p.goals.home : p.goals.away;
    const golesRival = lugar === "casa" ? p.goals.away : p.goals.home;
    if (golesPropios === null || golesRival === null) return;

    suma.tiros_favor += t1; suma.corners_favor += c1; suma.tiros_arco_favor += a1; suma.goles_favor += golesPropios;
    suma.tiros_contra += t2; suma.corners_contra += c2; suma.tiros_arco_contra += a2; suma.goles_contra += golesRival;
    validos++;
  });

  if (validos < MINIMO_VALIDOS) {
    throw new Error("Este equipo no tiene estadísticas completas en la API (solo " + validos + " partidos).");
  }

  const promedios = { partidos: validos };
  CAMPOS.forEach((c) => { promedios[c] = redondear(suma[c] / validos); });
  return promedios;
}

function dato(equipo, tipo) {
  const item = (equipo.statistics || []).find((s) => s.type === tipo);
  if (!item || item.value === null || item.value === undefined) return null;
  const n = Number(item.value);
  return Number.isFinite(n) ? n : null;
}

// ---------- API-Football ----------

async function api(ruta) {
  if (!process.env.API_FOOTBALL_KEY) {
    throw new Error("Falta configurar la variable API_FOOTBALL_KEY en Netlify.");
  }
  const response = await fetch(API_BASE + ruta, {
    headers: { "x-apisports-key": process.env.API_FOOTBALL_KEY }
  });
  const data = await response.json();

  const errores = data.errors;
  const hayErrores = Array.isArray(errores) ? errores.length > 0 : errores && Object.keys(errores).length > 0;
  if (hayErrores) {
    const texto = Array.isArray(errores) ? errores.join(" ") : Object.values(errores).join(" ");
    throw new Error("API-Football: " + texto);
  }
  if (!response.ok) throw new Error("API-Football respondió con error " + response.status + ".");
  return data;
}

// ---------- Hoja de caché ----------

async function asegurarHojaCache(sheets) {
  const info = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: "sheets.properties.title"
  });
  const existe = info.data.sheets.some((s) => s.properties.title === HOJA_CACHE);
  if (existe) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: HOJA_CACHE } } }] }
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: "'" + HOJA_CACHE + "'!A1:M1",
    valueInputOption: "RAW",
    requestBody: {
      values: [["clave", "id_equipo", "equipo", "fecha"].concat(CAMPOS, ["partidos"])]
    }
  });
}

async function leerCache(sheets) {
  const lectura = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "'" + HOJA_CACHE + "'!A2:M",
    valueRenderOption: "FORMATTED_VALUE"
  });
  return lectura.data.values || [];
}

// ---------- Utilidades ----------

function normalizar(texto) {
  return String(texto).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

function fechaHoy() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
}

function redondear(n) {
  return Math.round(n * 100) / 100;
}

// Lee las credenciales de Google aunque la variable esté pegada con comillas,
// con comillas escapadas, con comillas "curvas" o codificada en base64.
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
    headers: { "Content-Type": "application/json" }
  });
}

