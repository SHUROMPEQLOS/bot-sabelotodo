#!/usr/bin/env node
// === SABELOTODO GALAXY — Bot de Quiz headless para TERMUX (Node.js) ===
// Port de sabelotodoyos.js a linea de comandos SIN navegador (sin puppeteer)
// y SIN machine-id. Usa el login por RC del bot de boliche (HAAAPSI/RECOVER)
// y luego la API HTTP de Galaxy para jugar el quiz "Sabelotodo".
//
// Uso:
//   ./sabelotodo_termux.js --rc TU_RC --server es --hora 12
//   node sabelotodo_termux.js --rc TU_RC
//
// El archivo de respuestas (car_db.json) se extrae de tu sabelotodoyos.js.
// Cuando el bot aprende una respuesta nueva del rival, la guarda en car_db.json.

"use strict";

// ws solo se carga si se activa el WS online (perezoso). Así el bot arranca
// aunque no tengas el módulo instalado, mientras uses HTTP-only (lo normal).
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const https = require("https");
let WebSocket = null;            // se hace require("ws") dentro de openOnlineWS()
// galaxy_login se carga de forma perezosa dentro de loginFull() para el login
// con RC. Las creds obtenidas viven SOLO en memoria (nunca se escriben a disco).
let galaxyLogin = null;

// ----------------------- CONFIG -----------------------
const WSS = "wss://cs.mobstudio.ru:6672";
const API = "https://galaxy.mobstudio.ru/services/";
const UA = "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.5993.70 Mobile Safari/537.36";
const ANCHO = 1366, ALTURA = 768;

// Mapa de servidor: idioma -> topic_id (de la tabla "tienda" del original)
const TIENDA = [
  { idioma: "es", server: 56, compras: 1 },
  { idioma: "pt", server: 57, compras: 1 },
  { idioma: "en", server: 46, compras: 1 },
  { idioma: "ru", server: 12, compras: 1 }
];
const SERVERS = TIENDA.map(t => t.idioma); // ["es","pt","en","ru"]

// ----------------------- ESTADO -----------------------
let useridg = null, passwordg = null, username = null;
let ws = null, logged_in = false, botRunning = false;
let selectedServer = "es";       // idioma
let servr = 56;                    // topic_id
let Lang = "es";
let autoCompraHora = -1;            // hora (0-23) para auto-compra de energía; -1 = no
let tk = true;                      // flag de tick de auto-compra
let dinero = 0;
let jugar = true;
let next = null;
let nn = 0;
let paipai = false;
let reconnectTimeout = null;
let DEBUG = false;
let gamePolling = false;
let useWS = false;                  // WS online opcional. Default: OFF (juega solo por HTTP)
let credsLoaded = false;            // ¿hay creds válidas en memoria?
let noRivalCount = 0;               // ciclos de poll consecutivos sin rival (para re-solicitar)
let pendingAnswerTOs = [];          // timeouts de respuestas pendientes (para cancelar al terminar)
let gameEnded = false;              // ¿la partida actual ya terminó? (evita reprocesar)
let gameStarting = false;           // ¿está arrancando una partida? (evita PlayGame paralelos)
let lastQuestionLog = "";           // último texto de pregunta logueado (evita spam de log)
// RC y device de ESTA sesión (solo en memoria, nunca se guardan a disco).
// Al cerrar Termux desaparecen → nadie puede obtenerlos.
let memRC = null, memDevice = "352";

// Base de datos de respuestas (car_db.json)
let Car = [];                       // {imgID, carro, answer}
const CAR_DB_FILE = path.join(__dirname, "car_db.json");

// --- Credenciales SOLO EN MEMORIA (nunca se escriben a disco) ---
// El RC, userID y password viven en variables RAM. Al cerrar Termux (exit
// o matar el proceso) TODO se pierde: no queda ningún archivo con tus datos.
// Por seguridad, si un archivo de creds viejo quedó de versiones anteriores,
// lo borramos al arrancar.
const CREDS_FILE = path.join(__dirname, "sabelotodo_creds.json");
function wipeCredsFile() {
  try { fs.unlinkSync(CREDS_FILE); } catch (e) {}
}
function saveCreds(rc, device, creds) {
  // No guarda nada a disco: todo queda en memoria.
  memRC = rc; memDevice = device;
  useridg = creds.useridg; passwordg = creds.passwordg; username = creds.username || "";
}
function loadCreds() {
  // No lee de disco: devuelve lo que haya en memoria (o null si aún no hay login).
  if (useridg && passwordg) return { rc: memRC, device: memDevice, useridg, passwordg, username };
  return null;
}
function clearCreds() {
  wipeCredsFile();   // por si quedó un archivo viejo
  memRC = null;
  useridg = null; passwordg = null; username = null;
}
function loadCarDB() {
  try {
    const obj = JSON.parse(fs.readFileSync(CAR_DB_FILE, "utf8"));
    Car = obj.cars || obj.Car || [];
  } catch (e) { Car = []; }
  log(`📚 Base de respuestas: ${Car.length} entradas`, "log-gold");
}
function saveCarDB() {
  try {
    fs.writeFileSync(CAR_DB_FILE, JSON.stringify({ count: Car.length, cars: Car }));
  } catch (e) { /* ignorar */ }
}
function verificador(imgID) {
  for (const c of Car) if (c.imgID === imgID) return c.answer;
  return false;
}
function findCar(imgID) {
  for (const c of Car) if (c.imgID === imgID) return c;
  return null;
}

// ----------------------- LOG (compacto para Termux) -----------------------
const MAX_LOG_LINES = 150;
let rawLogLines = [];
function log(m, c) {
  c = c || "log-info";
  const t = new Date().toLocaleTimeString();
  const colors = {
    "log-go": "\x1b[32m", "log-fire": "\x1b[33m", "log-prize": "\x1b[34m",
    "log-err": "\x1b[31m", "log-info": "\x1b[37m", "log-raw": "\x1b[90m",
    "log-gold": "\x1b[93m", "log-time": "\x1b[35m"
  };
  const col = colors[c] || colors["log-info"];
  const line = `[${t}] ${m}`;
  console.log(col + line + "\x1b[0m");
  rawLogLines.push(line);
  if (rawLogLines.length > MAX_LOG_LINES) rawLogLines = rawLogLines.slice(-MAX_LOG_LINES);
}

// ----------------------- HTTP (axios minimalista nativo) -----------------------
// Headers alineados con la APK Galaxy 10.0.6 (ru.mobstudio.andgalaxy) tras
// analizar su classes.dex. La APK envía estos X-Galaxy-* y deja
// X-Galaxy-Http-Sign vacío (la firma está stub/deshabilitada en esta build:
// la clase del sign retorna "" y activado=false). Por eso el bot no necesita
// calcular ninguna firma para que el servidor acepte las peticiones.
const CLIENT_VER = "10.0.6";          // versión real de la APK analizada
const APP_SOURCE_ID = "4";            // X-Galaxy-App-Source-Id de la APK (android)
function buildHeaders() {
  return {
    "Accept": "application/json, text/plain, */*",
    "User-Agent": UA,
    "X-Galaxy-Kbv": "352",
    "X-Galaxy-Platform": "web",
    "X-Galaxy-Lng": Lang,
    "X-Galaxy-Client-Ver": CLIENT_VER,
    "X-Galaxy-App-Source-Id": APP_SOURCE_ID,
    "X-Galaxy-Http-Sign": "",          // vacío = igual que la APK 10.0.6 (firma deshabilitada)
    "X-Galaxy-Model": "chrome 118.0.5993.70",
    "X-Galaxy-User-Agent": UA,
    "X-Galaxy-Scr-Dpi": "1",
    "X-Galaxy-Os-Ver": "1",
    "X-Galaxy-Orientation": "portrait",
    "x-galaxy-scr-h": String(ALTURA),
    "x-galaxy-scr-w": String(ANCHO)
  };
}
function httpGet(url, params) {
  return new Promise((resolve, reject) => {
    let full = url;
    if (params) {
      const qs = new URLSearchParams();
      for (const k in params) qs.append(k, params[k]);
      full += (full.includes("?") ? "&" : "?") + qs.toString();
    }
    const headers = buildHeaders();
    const u = new URL(full);
    const reqOpts = { hostname: u.hostname, path: u.pathname + u.search, method: "GET", headers, rejectUnauthorized: false };
    const req = https.request(reqOpts, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(new Error("timeout")); });
    req.end();
  });
}

// Construye la URL base de servicios con credenciales
function svcUrl(extra) {
  let u = `${API}?userID=${useridg}&password=${passwordg}&usercur=${useridg}&random=${Math.random()}`;
  if (extra) u += "&" + extra;
  return u;
}
function svcUrlNoUser(extra) {
  let u = `${API}?&userID=${useridg}&password=${passwordg}&query_rand=${Math.random()}`;
  if (extra) u += "&" + extra;
  return u;
}

// ----------------------- API DEL QUIZ -----------------------
async function balance() {
  try {
    const res = await httpGet(`${API}?a=pay_get_balance&userID=${useridg}&password=${passwordg}&usercur=${useridg}&random=${Math.random()}&ajax=1`);
    const d = (res.data || "").toString().split(" ");
    const s = (d[0] || "").split('"').join("");
    dinero = s;
    log(`💰 Balance: ${s}`, "log-gold");
    return s;
  } catch (e) { log("❌ balance: " + e.message, "log-err"); }
}

async function compras() {
  await httpGet(`${API}?userID=${useridg}&password=${passwordg}&a=quiz_energy_shop_index&usercur=${useridg}&random=${Math.random()}`);
  await httpGet(`${API}?userID=${useridg}&password=${passwordg}&a=quiz_energy_shop_buy&item_id=2&usercur=${useridg}&random=${Math.random()}`);
  log("🛒 Energía comprada", "log-gold");
  await balance();
  await PlayGame();
}

async function PlayGame() {
  if (!logged_in || !botRunning) return;
  if (gameStarting) { if (DEBUG) log("PlayGame: ya hay una partida arrancando, ignoro", "log-raw"); return; }
  gameStarting = true;
  gameEnded = false;
  try {
    const res = await httpGet(`${API}?userID=${useridg}&password=${passwordg}&a=quiz_index&usercur=${useridg}&profile=1&random=${Math.random()}`);
    const html = (res.data || "").toString();
    // ¿hay partida pendiente del usuario?
    let userAnswered = false;
    if (html.includes('s__user_answer')) userAnswered = true;
    // energía
    let energy = -1;
    const m = html.match(/s__card_energy_count">\s*(\d+)/);
    if (m) energy = parseInt(m[1]);
    const disponible = html.match(/por|is|disponible|1\s*HORA\s*FREE/i);

    if (DEBUG) log(`🎮 quiz_index → HTTP ${res.status} | ${html.length}b | energy=${energy} | disp=${!!disponible} | userAns=${userAnswered}`, "log-raw");

    if (userAnswered) { log("⏳ Partida pendiente (ya respondiste). Reintentando en 5s...", "log-time"); gameStarting = false; setTimeout(() => PlayGame(), 5000); return; }
    if (energy === 0 && !disponible) {
      log("😴 Sin energía (0). Esperando 30 min...", "log-time");
      gameStarting = false;
      setTimeout(() => PlayGame(), 1800000);
      return;
    }
    alla();
  } catch (e) {
    log("❌ PlayGame: " + e.message, "log-err");
    gameStarting = false;
    setTimeout(() => PlayGame(), 3000);
  }
}

async function alla() {
  try {
    await httpGet(`${API}?userID=${useridg}&password=${passwordg}&a=quiz_choose_topic&usercur=${useridg}&random=${Math.random()}`);
    alla2();
  } catch (e) {
    log("❌ alla: " + e.message, "log-err");
    gameStarting = false;
    setTimeout(() => PlayGame(), 3000);
  }
}

async function alla2() {
  try {
    // quiz_quick_game con el topic del servidor
    const r1 = await httpGet(`${API}?userID=${useridg}&password=${passwordg}&a=quiz_quick_game&topic_id=${servr}&usercur=${useridg}&random=${Math.random()}`);
    if (r1.status !== 200) log("⚠️ quiz_quick_game → HTTP " + r1.status, "log-err");
    // quiz_ajax_ready_to_play (el original usa topic_id 56)
    const r2 = await httpGet(svcUrlNoUser(), { a: "quiz_ajax_ready_to_play", topic_id: "56", ajax: "1" });
    if (r2.status !== 200) log("⚠️ quiz_ajax_ready_to_play → HTTP " + r2.status, "log-err");
    log("🔎 Partida solicitada. Esperando rival...", "log-gold");
    startGamePolling();
  } catch (e) {
    log("❌ alla2: " + e.message, "log-err");
    gameStarting = false;
    setTimeout(() => PlayGame(), 3000);
  }
}

// Consulta el estado actual de la partida y lo pasa a visual() (igual que el original).
async function updateGame() {
  if (!logged_in || !botRunning) return;
  try {
    const res = await httpGet(svcUrlNoUser(), { a: "quiz_ajax_refresh_current_game", ajax: "1" });
    if (res.status === 200 && res.data) {
      let data;
      try { data = JSON.parse(res.data); } catch (e) { data = null; }
      if (data) await visual(data);
    } else if (res.status === 401 || res.status === 404) {
      if (DEBUG) log("updateGame: error " + res.status, "log-err");
    }
  } catch (e) {
    if (DEBUG) log("updateGame err: " + e.message, "log-err");
  }
}

// Polling de quiz_ajax_refresh_current_game (respaldo del WS push)
let pollWarned = false;
const NO_RIVAL_RETRY = 5;   // tras 5 ciclos sin rival (~20s), volver a pedir partida
function startGamePolling() {
  if (gamePolling) return;
  gamePolling = true;
  const poll = async () => {
    if (!logged_in || !botRunning) { gamePolling = false; return; }
    try {
      const res = await httpGet(svcUrlNoUser(), { a: "quiz_ajax_refresh_current_game", ajax: "1" });
      let data = null;
      if (res.status === 200 && res.data) { try { data = JSON.parse(res.data); } catch (e) { data = null; } }
      if (data) {
        if (data.status === 1) {
          pollWarned = false; noRivalCount = 0; gameStarting = false;
          await visual(data);
        }
        else {
          noRivalCount++;
          if (!pollWarned && !gameStarting) { log("⏳ Esperando rival / pregunta (status=" + data.status + ")...", "log-time"); pollWarned = true; }
          // Tras varios ciclos sin rival y sin partida arrancando, re-solicitar
          if (noRivalCount >= NO_RIVAL_RETRY && !gameStarting && !gameEnded) {
            log("🔄 Sin rival tras " + (NO_RIVAL_RETRY * 4) + "s → re-solicitando partida...", "log-gold");
            noRivalCount = 0;
            try { await httpGet(svcUrlNoUser(), { a: "quiz_ajax_ready_to_play", topic_id: "56", ajax: "1" }); }
            catch (e) { if (DEBUG) log("re-ask err: " + e.message, "log-err"); }
          }
          else if (DEBUG) log("poll: sin partida (status=" + data.status + ") resp=" + (res.data || "").toString().substring(0, 100), "log-raw");
        }
      } else {
        if (!pollWarned && !gameStarting) { log("⏳ Sin respuesta de partida aún (HTTP " + res.status + ")...", "log-time"); pollWarned = true; }
        else if (DEBUG) log("poll: HTTP " + res.status, "log-raw");
      }
    } catch (e) {
      if (DEBUG) log("poll err: " + e.message, "log-err");
    }
    setTimeout(poll, 4000);
  };
  poll();
}

// Procesa el estado del juego (visual)
async function visual(data) {
  if (data.status !== 1) return;
  // Si la partida ya terminó, no reprocesar (evita bucle de "partida terminada")
  if (gameEnded) return;

  let Image = "";
  try {
    Image = (data.questionImg || "").split("https://galaxy.mobstudio.ru/services/public/img/quiz/").join("");
    Image = Image.split(".png").join("").split(",").join("").split('"').join("");
  } catch (e) { Image = ""; }

  // Solo loguear la pregunta cuando cambia (evita spam del mismo estado cada 4s)
  const qText = data.numberOfQuestionText !== undefined ? data.numberOfQuestionText : "";
  const qLog = qText + " | Yo:" + data.userPoints + " Rival:" + data.enemyPoints;
  if (qLog !== lastQuestionLog) {
    lastQuestionLog = qLog;
    log(`❓ ${qLog}`, "log-info");
  }
  const answers = data.answers || [];

  const known = verificador(Image);
  if (!known) {
    // Aprender del rival si respondió
    if (data.currentGameEnemyAnswer !== null && data.enemyPoints !== nn) {
      nn = data.enemyPoints;
      log("🧠 No conozco esta imagen → aprendiendo del rival...", "log-time");
      checker(data.currentGameEnemyAnswer, answers, Image);
    }
    return; // el poll seguirá consultando; cuando el rival responda, se aprenderá
  }

  // Si la imagen cambió y la conocemos → responder
  if (Image !== next) {
    next = Image;
    repuesta(Image, answers);
  }

  // Actualizar DB si hay respuesta correcta y difiere
  if (data.correctAnswer !== null) {
    const c = findCar(Image);
    if (c) {
      for (const b of answers) {
        if (b.id === data.correctAnswer) {
          if (b.text !== c.carro) {
            log(`📝 Actualizo "${Image}": "${c.carro}" → "${b.text}"`, "log-time");
            c.carro = b.text; c.answer = b.id;
            saveCarDB();
          }
          break;
        }
      }
    }
  }

  // Si es la última pregunta y ya respondieron ambos → la partida terminó, buscar otra
  if (data.isLastQuestion && (data.isUserAnswered || data.correctAnswer !== null)) {
    gameEnded = true;   // bloquea reprocesar esta partida terminada
    log("🏁 Partida terminada. Buscando otra...", "log-gold");
    // Cancelar respuestas tardías pendientes
    for (const t of pendingAnswerTOs) clearTimeout(t);
    pendingAnswerTOs = [];
    nn = 0; next = null; jugar = true; lastQuestionLog = "";
    setTimeout(() => PlayGame(), 6000);
  }
}

// Responde usando la DB
function repuesta(id, answers) {
  const c = findCar(id);
  if (!c) return;
  const schedule = (ansId, label) => {
    const d = 1000 + Math.floor(Math.random() * 1500);
    log(`✅ Conozco${label}: ${c.carro} → respondiendo en ${d}ms`, "log-go");
    const to = setTimeout(() => answerID(ansId), d);
    pendingAnswerTOs.push(to);
  };
  for (const b of answers) {
    if (c.carro === b.text) { schedule(b.id, ""); return; }
  }
  // si el texto exacto no está, responder por answer id guardado
  if (c.answer) { schedule(c.answer, " (id)"); }
}

async function answerID(idanswer) {
  try {
    const res = await httpGet(svcUrlNoUser(), { a: "quiz_ajax_answer", answerId: String(idanswer), ajax: "1" });
    if (res.status === 200) log(`📤 Respuesta enviada (${idanswer})`, "log-fire");
    else log(`❌ answerID status ${res.status}`, "log-err");
  } catch (e) { log("❌ answerID: " + e.message, "log-err"); }
}

// Aprende del rival: guarda imgID -> respuesta correcta
function checker(resp, answers, id) {
  for (const a of answers) {
    if (parseInt(resp) === a.id) {
      // no duplicar
      if (!findCar(id)) {
        Car.push({ imgID: id, carro: a.text, answer: a.id });
        saveCarDB();
        log(`🆕 Aprendido: ${id} = ${a.text} (guardado en car_db.json)`, "log-prize");
      }
      return;
    }
  }
}

// ----------------------- AUTO-COMPRA POR HORA -----------------------
function GetClock() {
  if (!botRunning || autoCompraHora < 0) return;
  const d = new Date();
  const nhour = d.getHours();
  if (nhour !== autoCompraHora) tk = true;
  if (nhour === autoCompraHora && tk === true) {
    tk = false;
    if (parseFloat(dinero) >= 1.49) {
      log("⏰ Hora de auto-compra", "log-gold");
      compras();
    } else {
      log(`⏰ Hora de auto-compra pero saldo insuficiente (${dinero})`, "log-time");
    }
  }
}

// ----------------------- WS (sesión online) -----------------------
// WS para sesión online + disparo del juego (igual que el original).
// El servidor empuja "BROWSER 1 ..." cuando hay partida → dispara updateGame().
// "900" → balance + PlayGame. "850" → (cartel, ignorado en headless).
let wsToken = "";
let wsOnline = false;

// Login headless: primero intenta cargar creds guardadas en disco; si no, usa el RC
// (sin navegador, sin machine-id). Las creds se guardan para no necesitar el RC de nuevo.
async function loginFull(rc, device) {
  // Creds SOLO en memoria: si ya hay un login previo en esta sesión, reusarlo.
  if (useridg && passwordg) {
    log(`👤 ${username} | ID ${useridg} (creds en memoria)`, "log-gold");
    log("✅ Sesión por HTTP con creds en memoria (sin RC, sin marcarte online)", "log-go");
    return;
  }
  // Sin creds en memoria → login con RC (obligatorio cada vez que abres Termux)
  if (!rc || rc.length < 8) throw new Error("Falta RC válido para el login");
  log("🔑 Login headless con RC (NO se guarda a disco, solo en memoria)...", "log-info");
  if (!galaxyLogin) {
    try { galaxyLogin = require("./galaxy_login"); }
    catch (e) { throw new Error("No se pudo cargar ./galaxy_login.js (necesario para el login con RC). " + e.message); }
  }
  const creds = await galaxyLogin(rc, device);
  saveCreds(rc, device, creds);
  credsLoaded = true;
  log(`👤 ${username} | ID ${useridg}`, "log-gold");
  log("✅ Credenciales obtenidas (solo en memoria — se borran al cerrar Termux)", "log-go");
}

function openOnlineWS(rc, device) {
  if (!WebSocket) {
    try { WebSocket = require("ws"); }
    catch (e) { log("⚠️ Módulo 'ws' no instalado. WS desactivado (juega por HTTP). Instala con: npm i ws", "log-err"); useWS = false; return; }
  }
  try {
    ws = new WebSocket(WSS, { rejectUnauthorized: false });
  } catch (e) { if (DEBUG) log("WS open err: " + e.message, "log-err"); return; }
  ws.on("open", () => ws.send(`:pt IDENT ${device} -2 4030 1 2 :GALA\r\n`));
  ws.on("message", (data) => {
    const text = data.toString();
    for (const raw of text.split("\r\n")) {
      const line = raw.trim(); if (!line) continue;
      let rest = line;
      if (line.startsWith(":")) { const sp = line.indexOf(" "); if (sp > 0) rest = line.substring(sp + 1); }
      const parts = rest.split(" ");
      const cmd = parts[0];
      if (DEBUG) log("<< " + line.substring(0, 120), "log-raw");

      if (cmd === "HAAAPSI") { wsToken = parts[1] || ""; ws.send(`RECOVER ${rc}\r\n`); }
      else if (cmd === "REGISTER") {
        const t = require("crypto").createHash("md5").update(wsToken, "utf8").digest("hex").split("").reverse().join("0").substr(5, 10);
        // username trailing después de " :"
        let uname = parts[3] || "";
        const ci = rest.indexOf(" :");
        if (ci >= 0) uname = rest.substring(ci + 2) || uname;
        try { ws.send(`USER ${parts[1]} ${parts[2]} ${uname} ${t}\r\n`); } catch (e) {}
      }
      else if (cmd === "999") {
        if (!logged_in) { log("🟢 Sesión WS activa (999) — online", "log-go"); }
        wsOnline = true;
      }
      else if (cmd === "451") { log("❌ WS: RC incorrecto", "log-err"); }
      else if (cmd === "452") {
        // "Puedes volver a Galaxy 10s después de salir" → la cuenta quedó online. Reintentar.
        if (DEBUG) log("<< 452 (esperar 10s y reintentar WS)", "log-raw");
        setTimeout(() => { if (botRunning && useWS) openOnlineWS(rc, device); }, 12000);
      }
      else if (cmd === "PING" || cmd === "PONG") { try { ws.send("PONG\r\n"); } catch (e) {} }
      else if (cmd === "BROWSER") {
        // BROWSER <estado> <info>  → el servidor avisa del estado del quiz
        const estado = parts[1];
        if (DEBUG) log("📩 BROWSER estado=" + estado, "log-raw");
        if (estado === "1") { jugar = false; updateGame(); }      // hay partida → leer pregunta
        else if (estado === "4") { jugar = true; setTimeout(() => PlayGame(), 500 + Math.floor(Math.random() * 3000)); }
      }
      else if (cmd === "USER") { /* creds ya las tenemos */ }
      else if (cmd === "PHONE") { /* pantalla, no hace falta */ }
      else if (cmd === "900") { balance(); if (jugar) PlayGame(); if (DEBUG) log("📩 900 (play/balance)", "log-raw"); }
      else if (cmd === "850") { /* cartel/popup — en headless no hay UI que cerrar */ }
    }
  });
  ws.on("error", (e) => { if (DEBUG) log("WS err: " + e.message, "log-err"); });
  ws.on("close", () => { wsOnline = false; if (botRunning && useWS) setTimeout(() => { if (botRunning && useWS) openOnlineWS(rc, device); }, 3000); });
}

// Se llama cuando el WS queda online (999). Arranca el flujo del quiz.
async function onOnline() {
  try { await balance(); } catch (e) {}
  setTimeout(() => PlayGame(), 1500);
}

function scheduleReconnect(rc, device) {
  if (!botRunning) return;
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  reconnectTimeout = setTimeout(() => { if (botRunning) openOnlineWS(rc, device); }, 3000);
}

// Keepalive (solo si el WS está activo e instalado)
const ka = setInterval(() => {
  if (useWS && WebSocket && ws && ws.readyState === WebSocket.OPEN && logged_in) { try { ws.send("PONG\r\n"); } catch (e) {} }
}, 25000);
ka.unref();

// Watchdog 24/7: si el bot está corriendo y logueado pero NO está polleando
// (por un fallo de red o excepción), reinicia el flujo del quiz automáticamente.
// Así el bot nunca se queda "colgado" sin responder.
const watchdog = setInterval(() => {
  if (botRunning && logged_in && !gamePolling) {
    log("🔄 Watchdog: el polling se detuvo → reiniciando quiz...", "log-time");
    PlayGame();
  }
}, 60000);
watchdog.unref();

// ----------------------- ARRANQUE / STOP -----------------------
async function startBot(rc, device) {
  // El RC es obligatorio cada vez que abres Termux (las creds NO se guardan).
  // Si ya hay un login en memoria (misma sesión), se reutiliza sin RC.
  wipeCredsFile();   // borra archivo viejo si quedó de versiones anteriores
  if ((!rc || rc.length < 8) && !useridg) { log("❌ Falta RC. Uso: node sabelotodo_termux.js --rc TU_RC  (o escribe 'start TU_RC')", "log-err"); return; }
  if (botRunning) { log("⚠️ El bot ya está corriendo", "log-time"); return; }
  botRunning = true;
  if (Car.length === 0) loadCarDB();
  const t = TIENDA.find(x => x.idioma === selectedServer);
  servr = t ? t.server : 56; Lang = t ? t.idioma : "es";
  log(`🚀 Iniciando Sabelotodo | server=${Lang} (topic ${servr}) | auto-compra=${autoCompraHora < 0 ? "OFF" : autoCompraHora + "h"} | WS=${useWS ? "ON (marcas online)" : "OFF (HTTP only, puedes loguear normal)"}`, "log-info");
  try {
    await loginFull(rc, device);
    if (useWS) openOnlineWS(rc || memRC, device || memDevice);   // WS opcional: marca la cuenta online (conflicto con login manual)
    // auto-compra timer
    setInterval(GetClock, 1000);
    // Quiz por HTTP directo. Sin WS = no marcas online → puedes iniciar sesión
    // normal en la app/web y el bot sigue corriendo sin reconectarse.
    logged_in = true;
    log("🎮 Arrancando quiz por HTTP (puedes iniciar sesión normal sin conflicto)...", "log-info");
    setTimeout(() => onOnline(), 1500);
  } catch (e) {
    log("❌ " + e.message, "log-err");
    botRunning = false;
  }
}

function stopBot() {
  botRunning = false;
  gamePolling = false;
  wsOnline = false;
  gameEnded = false;
  gameStarting = false;
  lastQuestionLog = "";
  for (const t of pendingAnswerTOs) clearTimeout(t);
  pendingAnswerTOs = [];
  noRivalCount = 0;
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  if (ws) { try { ws.close(); } catch (e) {} ws = null; }
  logged_in = false;
  log("🛑 BOT APAGADO", "log-err");
}

// Limpieza de seguridad: borrar archivo de creds viejo y limpiar memoria RAM.
// Se ejecuta al cerrar Termux (exit, Ctrl+C, SIGTERM). Así nadie obtiene tu RC/ID/key.
function secureWipe() {
  wipeCredsFile();
  memRC = null; memDevice = "352";
  useridg = null; passwordg = null; username = null;
  credsLoaded = false;
}
// Protege contra cualquier cierre (Ctrl+C, kill, cerrar Termux).
process.on("SIGINT", () => { secureWipe(); process.exit(0); });
process.on("SIGTERM", () => { secureWipe(); process.exit(0); });
process.on("exit", () => { wipeCredsFile(); });

// ----------------------- CLI -----------------------
function printHelp() {
  console.log(`
\x1b[95m🧠 SABELOTODO GALAXY — Bot de Quiz headless (Termux)\x1b[0m

USO:
  node sabelotodo_termux.js --rc TU_RC [opciones]

OPCIONES:
  --rc <code>        Recovery Code. Necesario cada vez que abres Termux
                     (las creds NO se guardan en disco → se borran al cerrar).
  --server <es|pt|en|ru>  Idioma/servidor del quiz. Default: es
  --hora <0-23>     Hora de auto-compra de energía. Default: -1 (off)
  --device <352|350>  352=Web, 350=Android. Default: 352
  --ws              Activar WebSocket (te marca "online" en Galaxy → bloquea tu
                     login manual). Default: OFF (recomendado, juega solo por HTTP)
  --debug           Mostrar todo el tráfico (debug)
  --help, -h        Esta ayuda

COMANDOS EN VIVO:
  start [rc]        Conectar y jugar (usa creds en memoria si ya hay login)
  stop              Apagar
  balance           Ver saldo
  jugar             Buscar/lanzar partida
  comprar           Comprar energía (item 2)
  stats             Ver estado
  credenciales      Mostrar userID/password (en memoria, no se guarda)
  ws on|off         Activar/desactivar WebSocket online
  relogin <rc>      Forzar login de nuevo con RC (reemplaza creds en memoria)
  logout            Borrar creds de memoria (NO hay archivo en disco)
  debug on|off      Modo debug
  log               Descargar log
  exit              Salir (borra creds de memoria al cerrar)

BASE DE RESPUESTAS:
  car_db.json — ${Car.length} entradas (carga al iniciar). Aprende del rival y guarda nuevas.
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { rc: "", server: "", hora: "", device: "352", debug: false, ws: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--rc": out.rc = args[++i]; break;
      case "--server": out.server = args[++i]; break;
      case "--hora": out.hora = args[++i]; break;
      case "--device": out.device = args[++i]; break;
      case "--ws": out.ws = true; break;
      case "--debug": out.debug = true; break;
      case "--help": case "-h": out.help = true; break;
      default: if (a.startsWith("--")) console.log("⚠️ Opción desconocida: " + a);
    }
  }
  return out;
}

async function main() {
  const cliArgs = parseArgs(process.argv);
  if (cliArgs.help) { printHelp(); return; }
  if (cliArgs.server) { if (!SERVERS.includes(cliArgs.server)) { log("❌ server inválido: " + cliArgs.server + " (" + SERVERS.join("/") + ")", "log-err"); } else selectedServer = cliArgs.server; }
  if (cliArgs.hora !== "") { const h = parseInt(cliArgs.hora); if (!isNaN(h)) autoCompraHora = h; }
  if (cliArgs.device === "350" || cliArgs.device === "352") {} else cliArgs.device = "352";
  if (cliArgs.debug) DEBUG = true;
  if (cliArgs.ws) useWS = true;

  loadCarDB();
  // Limpieza de seguridad: borrar archivo de creds viejo si quedó de versiones anteriores.
  wipeCredsFile();

  // Las creds NO se guardan en disco: hace falta --rc cada vez que abres Termux.
  if (cliArgs.rc) { startBot(cliArgs.rc, cliArgs.device); }
  else log("⚠️ Falta --rc (obligatorio cada vez). Escribe 'start TU_RC' o arranca con --rc TU_RC", "log-err");

  // REPL
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "" });
  log("💬 Escribe 'help' para comandos en vivo.", "log-info");
  rl.on("line", (raw) => {
    const input = raw.trim(); if (!input) return;
    const sp = input.indexOf(" ");
    const cmd = (sp >= 0 ? input.substring(0, sp) : input).toLowerCase();
    const rest = sp >= 0 ? input.substring(sp + 1).trim() : "";
    switch (cmd) {
      case "start": { const rc = rest || cliArgs.rc; startBot(rc, cliArgs.device); break; }
      case "stop": stopBot(); break;
      case "balance": balance(); break;
      case "jugar":
      case "play": PlayGame(); break;
      case "comprar":
      case "compra": compras(); break;
      case "stats": log(`📊 Estado → online:${logged_in} | jugando:${gamePolling} | respuestas:${Car.length} | saldo:${dinero} | server:${Lang}(${servr}) | auto:${autoCompraHora<0?"off":autoCompraHora+"h"} | ws:${useWS?"ON":"OFF"} | creds:${credsLoaded?"en memoria":"falta RC"}`, "log-gold"); break;
      case "credenciales":
      case "cred": if (useridg) { log("userID: " + useridg + " | password: " + passwordg + " | user: " + (username || "-") + " (solo en memoria)", "log-gold"); } else log("Sin sesión", "log-err"); break;
      case "ws": {
        useWS = rest === "on" ? true : rest === "off" ? false : !useWS;
        log("🌐 WS: " + (useWS ? "ON (te marca online → bloquea login manual)" : "OFF (HTTP only, puedes loguear normal)"), "log-info");
        if (useWS && botRunning && !ws) openOnlineWS(memRC || cliArgs.rc, cliArgs.device);
        else if (!useWS && ws) { try { ws.close(); } catch (e) {} ws = null; wsOnline = false; }
        break;
      }
      case "relogin": {
        // Forzar login de nuevo con RC (reemplaza creds en memoria)
        const rc = rest || cliArgs.rc;
        if (!rc || rc.length < 8) { log("Uso: relogin <RC>", "log-err"); break; }
        clearCreds(); credsLoaded = false;
        stopBot();
        log("🔑 Re-login forzado con RC...", "log-time");
        startBot(rc, cliArgs.device);
        break;
      }
      case "logout":
      case "desconectar": clearCreds(); credsLoaded = false; log("🗑️ Creds borradas de memoria (NO hay archivo en disco). Pedirá RC la próxima vez.", "log-time"); break;
      case "debug": DEBUG = rest === "on" ? true : rest === "off" ? false : !DEBUG; log("debug: " + (DEBUG ? "ON" : "OFF"), "log-info"); break;
      case "log": { const fn = `sabelotodo_log_${Date.now()}.txt`; try { fs.writeFileSync(fn, rawLogLines.join("\n")); log("💾 Log: " + fn, "log-gold"); } catch (e) {} break; }
      case "help": log("Comandos: start stop balance jugar comprar stats credenciales ws relogin logout debug log exit", "log-info"); break;
      case "exit": case "quit": case "salir": stopBot(); secureWipe(); log("👋 Saliendo (creds borradas de memoria)...", "log-info"); setTimeout(() => process.exit(0), 500); break;
      default:
        if (/^[A-Za-z0-9]{8,}$/.test(input) && !cliArgs.rc && !useridg) { cliArgs.rc = input; log("🔑 RC: " + input, "log-gold"); startBot(input, cliArgs.device); }
        else log("❓ Comando desconocido: " + input + " (help)", "log-err");
    }
  });
  rl.on("close", () => { secureWipe(); stopBot(); process.exit(0); });
}

main().catch(e => { console.error("Error: " + e.message); process.exit(1); });
