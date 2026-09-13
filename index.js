/**
 * Servidor WhatsApp gratuito (Baileys) — substitui o UAZAPI no Prospecta+
 *
 * Rotas:
 *   GET  /qr              -> mostra o QR code para conectar o WhatsApp (escanear 1x)
 *   GET  /status          -> { connected: true/false }
 *   POST /send-message    -> { phone: "5511999999999", message: "texto" }
 *   POST /check-number    -> { phone: "5511999999999" } -> { exists: true/false }
 *
 * Variáveis de ambiente:
 *   API_TOKEN  -> token simples para proteger as rotas (defina no Railway)
 *   PORT       -> porta (Railway define automaticamente)
 */

const express = require('express');
const qrcode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require('@whiskeysockets/baileys');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN || ''; // se vazio, roda sem checagem (defina em produção!)
const AUTH_FOLDER = path.join(__dirname, 'auth_info');

let sock = null;
let latestQR = null;
let isConnected = false;

// ---------- Middleware simples de autenticação por token ----------
function checkAuth(req, res, next) {
  if (!API_TOKEN) return next(); // sem token configurado = sem checagem (defina API_TOKEN!)
  const token = req.headers['x-api-token'] || req.query.token;
  if (token !== API_TOKEN) {
    return res.status(401).json({ error: 'Token inválido. Envie o header x-api-token.' });
  }
  next();
}

// ---------- Conexão com o WhatsApp ----------
async function startSock() {
  if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
    }

    if (connection === 'open') {
      isConnected = true;
      latestQR = null;
      console.log('[Baileys] Conectado ao WhatsApp com sucesso.');
    }

    if (connection === 'close') {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('[Baileys] Conexão fechada. Código:', statusCode, '| Motivo:', lastDisconnect?.error?.message || 'desconhecido', '| Reconectar?', shouldReconnect);
      if (shouldReconnect) {
        setTimeout(() => startSock(), 2000); // pequena espera antes de tentar de novo
      } else {
        console.log('[Baileys] Sessão deslogada. Apague a pasta auth_info e escaneie o QR novamente.');
      }
    }
  });
}

startSock().catch((err) => {
  console.error('[Baileys] Erro ao iniciar:', err);
});

// ---------- Utilitário: normaliza telefone BR para o formato do WhatsApp ----------
function toWhatsAppJid(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (!digits) return null;
  // Garante código do país 55 (Brasil) se vier sem
  const withCountry = digits.startsWith('55') ? digits : `55${digits}`;
  return `${withCountry}@s.whatsapp.net`;
}

// ---------- Rotas ----------

// Mostra o QR code como imagem no navegador (acesse a URL pública + /qr)
app.get('/qr', checkAuth, async (req, res) => {
  if (isConnected) {
    return res.send('<h2>✅ Já está conectado ao WhatsApp.</h2>');
  }
  if (!latestQR) {
    return res.send('<h2>Aguardando QR code... recarregue em alguns segundos.</h2>');
  }
  const qrImage = await qrcode.toDataURL(latestQR);
  res.send(`
    <html>
      <body style="display:flex;flex-direction:column;align-items:center;font-family:sans-serif;">
        <h2>Escaneie com o WhatsApp (Dispositivos Vinculados)</h2>
        <img src="${qrImage}" style="width:300px;height:300px;" />
        <p>Esta página atualiza sozinha a cada 5s.</p>
        <script>setTimeout(()=>location.reload(), 5000)</script>
      </body>
    </html>
  `);
});

app.get('/status', checkAuth, (req, res) => {
  res.json({ connected: isConnected });
});

// Versão em JSON do QR (para embutir direto no seu app, sem abrir outra página)
app.get('/qr-image', checkAuth, async (req, res) => {
  if (isConnected) {
    return res.json({ connected: true });
  }
  if (!latestQR) {
    return res.json({ connected: false, qr: null });
  }
  const qrImage = await qrcode.toDataURL(latestQR);
  res.json({ connected: false, qr: qrImage });
});

// Envia uma mensagem de texto
app.post('/send-message', checkAuth, async (req, res) => {
  try {
    if (!isConnected || !sock) {
      return res.status(503).json({ error: 'WhatsApp não conectado ainda. Acesse /qr para conectar.' });
    }
    const { phone, message } = req.body;
    if (!phone || !message) {
      return res.status(400).json({ error: 'Envie "phone" e "message" no corpo da requisição.' });
    }
    const jid = toWhatsAppJid(phone);
    if (!jid) {
      return res.status(400).json({ error: 'Número de telefone inválido.' });
    }

    await sock.sendMessage(jid, { text: message });
    res.json({ success: true, phone, jid });
  } catch (err) {
    console.error('[send-message] erro:', err);
    res.status(500).json({ error: err.message || 'Erro ao enviar mensagem.' });
  }
});

// Verifica se um número existe no WhatsApp
app.post('/check-number', checkAuth, async (req, res) => {
  try {
    if (!isConnected || !sock) {
      return res.status(503).json({ error: 'WhatsApp não conectado ainda.' });
    }
    const { phone } = req.body;
    const jid = toWhatsAppJid(phone);
    if (!jid) {
      return res.status(400).json({ error: 'Número de telefone inválido.' });
    }
    const [result] = await sock.onWhatsApp(jid);
    res.json({ phone, exists: !!(result && result.exists) });
  } catch (err) {
    console.error('[check-number] erro:', err);
    res.status(500).json({ error: err.message || 'Erro ao verificar número.' });
  }
});

app.get('/', (req, res) => {
  res.send('Servidor WhatsApp (Baileys) rodando. Acesse /qr para conectar.');
});

app.listen(PORT, () => {
  console.log(`[Baileys] Servidor rodando na porta ${PORT}`);
});
