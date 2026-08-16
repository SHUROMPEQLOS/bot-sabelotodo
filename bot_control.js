const http = require('http');
http.createServer((req, res) => res.end('Bot activo')).listen(process.env.PORT || 3000);

const TelegramBot = require('node-telegram-bot-api').default || require('node-telegram-bot-api');
const { spawn } = require('child_process');

const token = '8883797197:AAH_gd1Dg1WIGAzpG_VDc6cUJRll5W8t84w';
const bot = new TelegramBot(token, { polling: true });

const ADMIN_ID = 5012552916;
const usuariosAutorizados = new Set([ADMIN_ID]);

let scriptProcess = null;
let currentRC = null;
let restartTimer = null;
let isRestarting = false;
let modoResumen = true;  // true = solo resultados, false = todo
let ultimoResultado = ''; // Evita spam de resultados repetidos

// Limpia códigos ANSI
function cleanAnsi(text) {
  return text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-n glassware-~]/g, '')
             .replace(/\[\d+m/g, '')
             .replace(/\[2J/g, '')
             .replace(/\[H/g, '');
}

function killAllProcesses() {
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  isRestarting = false;
  if (scriptProcess) { try { scriptProcess.kill('SIGTERM'); } catch (e) {} scriptProcess = null; }
  currentRC = null;
  ultimoResultado = '';
}

// Extrae los puntos de una línea con formato "Yo:123 Rival:456"
function extraerPuntos(line) {
  const yoMatch = line.match(/Yo:\s*(\d+)/i);
  const rivalMatch = line.match(/Rival:\s*(\d+)/i);
  if (yoMatch && rivalMatch) {
    return { yo: parseInt(yoMatch[1]), rival: parseInt(rivalMatch[1]) };
  }
  return null;
}

// Determina si una línea es la última pregunta
function esUltimaPregunta(line) {
  return /última pregunta/i.test(line);
}

// Función que determina si un mensaje debe mostrarse en modo resumen
function esResultadoFinal(line) {
  const lower = line.toLowerCase();
  return /victoria|derrota|empate|sin energía|reanudará/.test(lower);
}

// Middleware de autorización
function estaAutorizado(msg) {
  const userId = msg.from.id;
  if (usuariosAutorizados.has(userId)) return true;

  bot.sendMessage(
    msg.chat.id,
    '👋 ¡Hola! Has solicitado acceso al bot.\n\n' +
    '⏳ El dueño debe autorizarte. Te avisaré cuando lo haga.\n\n' +
    'Mientras esperas, no puedes usar el bot.'
  );
  bot.sendMessage(
    ADMIN_ID,
    `<b>⚠️ Nueva solicitud de acceso</b>\n\n` +
    `👤 Usuario: ${msg.from.first_name} (@${msg.from.username || 'sin_username'})\n` +
    `🆔 ID: <code>${userId}</code>\n\n` +
    `Para autorizarlo escribe:\n<code>/autorizar ${userId}</code>`,
    { parse_mode: 'HTML' }
  );
  return false;
}

console.log('🤖 Bot de Telegram listo y corriendo...');

// --- Comandos de administrador ---
bot.onText(/\/autorizar (\d+)/, (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const id = parseInt(match[1]);
  usuariosAutorizados.add(id);
  bot.sendMessage(msg.chat.id, `✅ Usuario <code>${id}</code> autorizado.`, { parse_mode: 'HTML' });
  bot.sendMessage(id, '🎉 Acceso aprobado. Envía /start para comenzar.');
});

bot.onText(/\/desautorizar (\d+)/, (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const id = parseInt(match[1]);
  usuariosAutorizados.delete(id);
  bot.sendMessage(msg.chat.id, `🚫 Usuario <code>${id}</code> revocado.`, { parse_mode: 'HTML' });
});

// --- Comandos del bot ---
bot.onText(/\/start/, (msg) => {
  if (!estaAutorizado(msg)) return;
  bot.sendMessage(
    msg.chat.id,
    '👋 <b>Control de Sabelotodo</b>\n\n' +
    '🔹 <code>/iniciar &lt;RC&gt;</code> - Arranca el bot.\n' +
    '🔹 <code>/detener</code> - Apaga todo.\n' +
    '🔹 <code>/estado</code> - Estado actual.\n' +
    '🔹 <code>/modo</code> - Alterna entre resumen (solo resultados) y detallado (todo).',
    { parse_mode: 'HTML' }
  );
});

bot.onText(/\/modo/, (msg) => {
  if (!estaAutorizado(msg)) return;
  modoResumen = !modoResumen;
  ultimoResultado = ''; // Reinicia para evitar mensajes repetidos al cambiar de modo
  bot.sendMessage(msg.chat.id, `📊 Modo: ${modoResumen ? 'RESUMEN (solo resultados finales)' : 'DETALLADO (todo el output)'}`);
});

// Función para iniciar el script
function iniciarScript(chatId, recoveryCode) {
  if (scriptProcess) killAllProcesses();

  currentRC = recoveryCode;
  isRestarting = false;
  ultimoResultado = '';

  bot.sendMessage(chatId, `🚀 Iniciando con RC: <code>${recoveryCode}</code>...`, { parse_mode: 'HTML' });

  const args = [
    'sabelotodo_termux.js',
    '--rc', recoveryCode,
    '--server', 'es',
    '--device', '352',
    '--hora', '-1'
  ];

  scriptProcess = spawn('node', args, {
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // Manejador de stdout con lógica de puntos
  scriptProcess.stdout.on('data', (data) => {
    const output = data.toString();
    const lines = output.split('\n').filter(line => line.trim() !== '');
    for (const line of lines) {
      const cleanLine = cleanAnsi(line).trim();
      if (!cleanLine) continue;

      if (modoResumen) {
        // Primero, si es un mensaje de resultado conocido (victoria/derrota/empate en texto), lo enviamos
        if (esResultadoFinal(cleanLine)) {
          if (cleanLine !== ultimoResultado) {
            ultimoResultado = cleanLine;
            bot.sendMessage(chatId, cleanLine);
          }
          continue;
        }

        // Si es "última pregunta", extraemos los puntos y determinamos el resultado
        if (esUltimaPregunta(cleanLine)) {
          const puntos = extraerPuntos(cleanLine);
          if (puntos) {
            let resultado = '';
            if (puntos.yo > puntos.rival) {
              resultado = `🏆 ¡VICTORIA! Yo: ${puntos.yo} - Rival: ${puntos.rival}`;
            } else if (puntos.yo < puntos.rival) {
              resultado = `😞 DERROTA. Yo: ${puntos.yo} - Rival: ${puntos.rival}`;
            } else {
              resultado = `🤝 EMPATE. Yo: ${puntos.yo} - Rival: ${puntos.rival}`;
            }
            if (resultado !== ultimoResultado) {
              ultimoResultado = resultado;
              bot.sendMessage(chatId, resultado);
            }
          }
          continue;
        }

        // Si es "Partida terminada" o "Buscando otra..." podemos ignorarlo
        // pero si quieres verlo, descomenta:
        // if (/partida terminada|buscando otra/i.test(cleanLine)) {
        //   bot.sendMessage(chatId, cleanLine);
        // }

        // Ignoramos cualquier otra línea en modo resumen
      } else {
        // Modo detallado: enviamos todo
        bot.sendMessage(chatId, cleanLine);
      }
    }
  });

  // stderr siempre se muestra (errores)
  scriptProcess.stderr.on('data', (data) => {
    const error = cleanAnsi(data.toString()).trim();
    if (error) bot.sendMessage(chatId, `⚠️ ${error}`);
  });

  // Reinicio automático si se cae
  scriptProcess.on('close', (code) => {
    scriptProcess = null;
    if (isRestarting || !currentRC) return;

    bot.sendMessage(chatId, `🔄 Script detenido (${code}). Reiniciando en 10s...`);
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!currentRC) return;
      bot.sendMessage(chatId, `♻️ Reiniciando...`);
      isRestarting = true;
      iniciarScript(chatId, currentRC);
    }, 10000);
  });
}

bot.onText(/\/iniciar (.+)/, (msg, match) => {
  if (!estaAutorizado(msg)) return;
  const chatId = msg.chat.id;
  const rc = match[1].trim();
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  isRestarting = false;
  iniciarScript(chatId, rc);
});

bot.onText(/\/detener/, (msg) => {
  if (!estaAutorizado(msg)) return;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  isRestarting = false;
  killAllProcesses();
  bot.sendMessage(msg.chat.id, '🛑 Bot detenido.');
});

bot.onText(/\/estado/, (msg) => {
  if (!estaAutorizado(msg)) return;
  const estado = scriptProcess ? '🟢 EN EJECUCIÓN' : '🔴 APAGADO';
  bot.sendMessage(msg.chat.id, `${estado} | Modo: ${modoResumen ? 'RESUMEN' : 'DETALLADO'}`);
});

// Mensajes libres
bot.on('message', (msg) => {
  if (msg.text && !msg.text.startsWith('/')) {
    if (!usuariosAutorizados.has(msg.from.id)) return;
    if (scriptProcess && scriptProcess.stdin) {
      scriptProcess.stdin.write(`${msg.text.trim()}\n`);
    }
  }
});