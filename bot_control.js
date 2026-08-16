const http = require('http');
// Importación correcta para compatibilidad con ESM y CommonJS
const TelegramBot = require('node-telegram-bot-api').default || require('node-telegram-bot-api');
const { spawn } = require('child_process');

// ========== CONFIGURACIÓN ==========
const token = process.env.TELEGRAM_TOKEN || '8749993343:AAF3deTKoBEPvrXaOd0gvT7pK3d8G8dpp_w';
const WEBHOOK_URL = process.env.RENDER_URL || 'https://bot-sabelotodo.onrender.com';
const ADMIN_ID = 5012552916;  // Reemplaza con tu ID real

const bot = new TelegramBot(token);
const usuariosAutorizados = new Set([ADMIN_ID]);

let scriptProcess = null;
let currentRC = null;
let modoResumen = true;  // true = solo resultados, false = todo
let chatIdActivo = null;
let restartTimer = null;

// ========== FUNCIONES AUXILIARES ==========
function cleanAnsi(text) {
  return text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-n glassware-~]/g, '')
             .replace(/\[\d+m/g, '').replace(/\[2J/g, '').replace(/\[H/g, '');
}

function killAllProcesses() {
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (scriptProcess) { try { scriptProcess.kill('SIGTERM'); } catch (e) {} scriptProcess = null; }
  currentRC = null;
  chatIdActivo = null;
}

function esResultadoFinal(line) {
  const lower = line.toLowerCase();
  return /victoria|derrota|empate|sin energía|reanudará/.test(lower);
}

function estaAutorizado(msg) {
  const userId = msg.from.id;
  if (usuariosAutorizados.has(userId)) return true;
  bot.sendMessage(msg.chat.id, '⏳ Solicita acceso al dueño.');
  bot.sendMessage(ADMIN_ID,
    `<b>⚠️ Nueva solicitud</b>\n👤 ${msg.from.first_name} (@${msg.from.username || 'sin_username'})\n🆔 <code>${userId}</code>\nPara autorizar: /autorizar ${userId}`,
    { parse_mode: 'HTML' }
  );
  return false;
}

// ========== CONFIGURACIÓN DEL WEBHOOK ==========
bot.setWebHook(`${WEBHOOK_URL}/webhook`)
  .then(() => console.log('✅ Webhook configurado correctamente'))
  .catch(err => console.error('❌ Error al configurar webhook:', err.message));

// ========== SERVIDOR HTTP PARA EL WEBHOOK ==========
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const update = JSON.parse(body);
        bot.processUpdate(update);
        res.writeHead(200);
        res.end('OK');
      } catch (e) {
        res.writeHead(400);
        res.end('Bad Request');
      }
    });
  } else {
    res.writeHead(200);
    res.end('Bot activo');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Bot escuchando en puerto ${PORT}`));

// ========== COMANDOS ==========
bot.onText(/\/autorizar (\d+)/, (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const id = parseInt(match[1]);
  usuariosAutorizados.add(id);
  bot.sendMessage(msg.chat.id, `✅ Usuario <code>${id}</code> autorizado.`, { parse_mode: 'HTML' });
  bot.sendMessage(id, '🎉 Acceso aprobado. Envía /start.');
});

bot.onText(/\/desautorizar (\d+)/, (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const id = parseInt(match[1]);
  usuariosAutorizados.delete(id);
  bot.sendMessage(msg.chat.id, `🚫 Usuario <code>${id}</code> revocado.`, { parse_mode: 'HTML' });
});

bot.onText(/\/start/, (msg) => {
  if (!estaAutorizado(msg)) return;
  bot.sendMessage(msg.chat.id,
    '👋 <b>Control de Sabelotodo</b>\n\n' +
    '🔹 <code>/iniciar &lt;RC&gt;</code> - Arranca el bot.\n' +
    '🔹 <code>/detener</code> - Apaga todo.\n' +
    '🔹 <code>/estado</code> - Estado actual.\n' +
    '🔹 <code>/modo</code> - Alterna resumen/detallado.',
    { parse_mode: 'HTML' }
  );
});

bot.onText(/\/modo/, (msg) => {
  if (!estaAutorizado(msg)) return;
  modoResumen = !modoResumen;
  bot.sendMessage(msg.chat.id, `📊 Modo: ${modoResumen ? 'RESUMEN (solo resultados)' : 'DETALLADO (todo)'}`);
});

// ========== INICIAR SCRIPT ==========
function iniciarScript(chatId, recoveryCode) {
  if (scriptProcess) {
    bot.sendMessage(chatId, '⛔ Ya hay una partida activa. Usa /detener primero.');
    return;
  }

  chatIdActivo = chatId;
  currentRC = recoveryCode;
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

  scriptProcess.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter(l => l.trim());
    for (const line of lines) {
      const cleanLine = cleanAnsi(line).trim();
      if (!cleanLine) continue;
      if (modoResumen && !esResultadoFinal(cleanLine)) continue;
      bot.sendMessage(chatId, cleanLine);
    }
  });

  scriptProcess.stderr.on('data', (data) => {
    const error = cleanAnsi(data.toString()).trim();
    if (error) bot.sendMessage(chatId, `⚠️ ${error}`);
  });

  scriptProcess.on('close', (code) => {
    scriptProcess = null;
    bot.sendMessage(chatId, `🛑 Script finalizado (código ${code}).`);
    if (currentRC && chatIdActivo) {
      // Reinicio automático tras 10 segundos
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        restartTimer = null;
        bot.sendMessage(chatIdActivo, `♻️ Reiniciando automáticamente...`);
        iniciarScript(chatIdActivo, currentRC);
      }, 10000);
    }
  });
}

bot.onText(/\/iniciar (.+)/, (msg, match) => {
  if (!estaAutorizado(msg)) return;
  const rc = match[1].trim();
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  iniciarScript(msg.chat.id, rc);
});

bot.onText(/\/detener/, (msg) => {
  if (!estaAutorizado(msg)) return;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  killAllProcesses();
  bot.sendMessage(msg.chat.id, '🛑 Bot detenido.');
});

bot.onText(/\/estado/, (msg) => {
  if (!estaAutorizado(msg)) return;
  const estado = scriptProcess ? '🟢 EN EJECUCIÓN' : '🔴 APAGADO';
  bot.sendMessage(msg.chat.id, `${estado} | Modo: ${modoResumen ? 'RESUMEN' : 'DETALLADO'}`);
});

// Mensajes libres (para comandos internos como 'balance', 'stats', etc.)
bot.on('message', (msg) => {
  if (msg.text && !msg.text.startsWith('/')) {
    if (!usuariosAutorizados.has(msg.from.id)) return;
    if (scriptProcess && scriptProcess.stdin) {
      scriptProcess.stdin.write(`${msg.text.trim()}\n`);
    }
  }
});
