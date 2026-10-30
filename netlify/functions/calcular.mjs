[11:06 p.m., 29/10/2026] slec gar: <!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Calculadora de fútbol</title>
  <style>
    body { font: 16px Arial, sans-serif; max-width: 620px; margin: 40px auto; padding: 0 18px; }
    input, button { box-sizing: border-box; width: 100%; padding: 12px; margin: 8px 0; }
    button { cursor: pointer; }
    #resultado { white-space: pre-wrap; margin-top: 20px; }
  </style>
</head>
<body>
  <h1>Calculadora de fútbol</h1>
  <p>Escribe los equipos y consultaré sus estadísticas para calcular el veredicto.</p>
  <form id="formulario">
    <label>Equipo local</label>
    <input name="local" required>
    <label>Equipo visitante</label>
    <input name="visitante" required>
    <button id="boton">Calcular</button>
  </form>
[12:12 a.m., 30/10/2026] slec gar: github.com/huinysport/Calculadora-futbol/edit/main/netlify/functions/calcular.mjs
[12:14 a.m., 30/10/2026] slec gar: import { google } from "googleapis";

const SPREADSHEET_ID = "1Bdg2g1XQo5tDpzqbn4cMP1NqYCnEvimMNnp4VA-YlM0";
const SHEET_NAME = "presur";

export default async (request) => {
  if (request.method !== "POST") {
    return respuesta(405, { error: "Método no permitido." });
  }

  try {
    const { local, visitante } = await request.json();

    if (!local?.trim() || !visitante?.trim()) {
      return respuesta(400, { error: "Escribe los nombres de los dos equipos." });
    }

    const estadisticas = await buscarEstadisticas(local.trim(), visitante.trim());
    const valores = validarEstadisticas(estadisticas);

    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials,
      sc…
[12:20 a.m., 30/10/2026] slec gar: app.netlify.com/projects/calculadora-futbol-huinysport/deploys
[12:27 a.m., 30/10/2026] slec gar: import { google } from "googleapis";

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

    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
     …
