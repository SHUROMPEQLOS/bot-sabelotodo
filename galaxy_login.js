#!/usr/bin/env node
// === GALAXY LOGIN (headless, sin navegador) ===
// Convierte un Recovery Code (RC) en {useridg, passwordg, username} usando
// SOLAMENTE el WebSocket oficial de Galaxy. No usa puppeteer, no abre web,
// no usa machine-id. Reutiliza el mismo flujo de login del bot de boliche.
//
// Uso como módulo:
//   const login = require("./galaxy_login");
//   const creds = await login("TU_RC", "352");  // -> { useridg, passwordg, username }
//
// Uso desde CLI:
//   node galaxy_login.js TU_RC            -> imprime useridg / passwordg
//   node galaxy_login.js TU_RC 350        -> dispositivo Android
//
// El flujo (idéntico al bot de boliche):
//   1) WS conecta a wss://cs.mobstudio.ru:6672
//   2) envía  :pt IDENT <dev> -2 4030 1 2 :GALA
//   3) servidor envía  HAAAPSI <code>
//   4) envía  RECOVER <RC>
//   5) servidor envía  REGISTER <useridg> <passwordg> <username>
//   6) resolvemos la promesa con las credenciales y cerramos el socket.

"use strict";

const { WebSocket } = require("ws");
const crypto = require("crypto");

const WSS = "wss://cs.mobstudio.ru:6672";

function md5(str) {
  return crypto.createHash("md5").update(str, "utf8").digest("hex");
}
// parseHAAAPSI: md5(e).split("").reverse().join("0").substr(5,10)
function parseHAAAPSI(e) {
  return md5(e).split("").reverse().join("0").substr(5, 10);
}

/**
 * Inicia sesión en Galaxy con un RC y devuelve las credenciales.
 * @param {string} rc Recovery Code
 * @param {string} device "352" (Web) o "350" (Android)
 * @returns {Promise<{useridg:string,passwordg:string,username:string}>}
 */
function galaxyLogin(rc, device = "352") {
  return new Promise((resolve, reject) => {
    if (!rc || rc.length < 8) {
      return reject(new Error("RC inválido o muy corto (mínimo 8 caracteres)"));
    }
    let haaapsi = null;
    let ws;
    let settled = false;
    let timer;

    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { if (ws && ws.readyState === WebSocket.OPEN) ws.close(); } catch (e) {}
      fn(val);
    };

    // Timeout de seguridad: 20s
    timer = setTimeout(() => {
      finish(reject, new Error("Timeout: el servidor no respondió al login (¿RC incorrecto?)"));
    }, 20000);

    try {
      ws = new WebSocket(WSS, { rejectUnauthorized: false });
    } catch (e) {
      return finish(reject, e);
    }

    ws.on("open", () => {
      ws.send(`:pt IDENT ${device} -2 4030 1 2 :GALA\r\n`);
    });

    ws.on("message", (data) => {
      const text = data.toString();
      for (const raw of text.split("\r\n")) {
        const line = raw.trim();
        if (!line) continue;
        // parse IRC simple
        let rest = line;
        if (line.startsWith(":")) {
          const sp = line.indexOf(" ");
          if (sp > 0) rest = line.substring(sp + 1);
        }
        const parts = rest.split(" ");
        const cmd = parts[0];
        const params = parts.slice(1);

        if (cmd === "HAAAPSI") {
          haaapsi = params[0] || "";
          ws.send(`RECOVER ${rc}\r\n`);
        }
        else if (cmd === "REGISTER") {
          // REGISTER <useridg> <passwordg> <username...>
          const useridg = params[0];
          const passwordg = params[1];
          // username puede venir en params[2] o en el trailing
          let username = params[2] || "";
          const ci = rest.indexOf(" :");
          if (ci >= 0) username = rest.substring(ci + 2) || username;
          // Validar RC con un USER (opcional). No es necesario para obtener creds,
          // pero lo enviamos para confirmar que el RC es válido (servidor responde 999).
          const t = parseHAAAPSI(haaapsi);
          try { ws.send(`USER ${useridg} ${passwordg} ${username} ${t}\r\n`); } catch (e) {}
          // Ya tenemos las credenciales. Resolvemos.
          finish(resolve, { useridg, passwordg, username });
        }
        // 451 = RC incorrecto
        else if (cmd === "451") {
          finish(reject, new Error("RC incorrecto: " + line.substring(0, 80)));
        }
      }
    });

    ws.on("error", (err) => finish(reject, err));
    ws.on("close", () => {
      if (!settled) finish(reject, new Error("Conexión cerrada antes de recibir credenciales"));
    });
  });
}

module.exports = galaxyLogin;
module.exports.galaxyLogin = galaxyLogin;

// ---------- CLI ----------
if (require.main === module) {
  const rc = process.argv[2];
  const device = process.argv[3] || "352";
  if (!rc) {
    console.log("Uso: node galaxy_login.js <RC> [352|350]");
    console.log("Ej:  node galaxy_login.js ABC12345 352");
    process.exit(1);
  }
  console.log("🔑 Iniciando sesión en Galaxy con RC (headless, sin web)...");
  galaxyLogin(rc, device)
    .then((c) => {
      console.log("\n✅ LOGIN OK");
      console.log("   userID   : " + c.useridg);
      console.log("   password : " + c.passwordg);
      console.log("   username : " + (c.username || "-"));
      console.log("\nUsa estos valores para las llamadas a la API HTTP de Galaxy:");
      console.log("   https://galaxy.mobstudio.ru/services/?userID=" + c.useridg + "&password=" + c.passwordg + "&...");
    })
    .catch((e) => {
      console.error("\n❌ " + e.message);
      process.exit(1);
    });
}
