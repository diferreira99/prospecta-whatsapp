/**
 * Servidor WhatsApp gratuito (Baileys) — substitui o UAZAPI no Prospecta+
 *
 * Rotas:
 *   GET  /qr              -> mostra o QR code para conectar o WhatsApp (escanear 1x)
 *   GET  /status          -> { connected: true/false }
 *   POST /send-message    -> { phone: "5511999999999", message: "texto" }
 *   POST /send-document   -> { phone: "5511999999999", base64: "...", filename: "relatorio.pdf", caption: "texto opcional" }
 *   POST /check-number    -> { phone: "5511999999999" } -> { exists: true/false }
 *
 * Variáveis de ambiente:
 *   API_TOKEN            -> token simples para proteger as rotas (defina no Railway)
 *   PORT                 -> porta (Railway define automaticamente)
 *   N8N_WEBHOOK_RESPOSTA -> URL do webhook n8n que recebe respostas dos leads (captura, não responde nada)
 *   PROSPECTA_USER_ID    -> UUID do usuário no Supabase Auth, pra casar a resposta com o lead certo
 */

// Polyfill: versões recentes do Baileys usam a API global `crypto` (WebCrypto),
// que só existe nativamente a partir do Node 20. Isso garante que funcione mesmo
// em Node mais antigo (ex: Node 18 no Railway).
if (!globalThis.crypto) {
  globalThis.crypto = require('crypto').webcrypto;
}

const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' })); // PDFs/mídias em base64 passam fácil do limite padrão (100kb)

const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN || ''; // se vazio, roda sem checagem (defina em produção!)
const AUTH_FOLDER = path.join(__dirname, 'auth_info');

// Captura de resposta (só escuta e registra — NUNCA responde nada automaticamente)
const N8N_WEBHOOK_RESPOSTA = process.env.N8N_WEBHOOK_RESPOSTA || 'https://primary-production-c1c7c.up.railway.app/webhook/receber-resposta';
const PROSPECTA_USER_ID = process.env.PROSPECTA_USER_ID || ''; // UUID do usuário no Supabase Auth (defina no Railway!)

// Mapeamento LID ↔ telefone: essa versão do Baileys não traduz @lid sozinha quando a
// resposta chega, então guardamos essa tradução ANTES, no momento do envio (quando já
// sabemos o telefone), consultando sock.onWhatsApp() — que retorna o LID do contato.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wktvwbmjubiqtbrvnapj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || ''; // defina no Railway (mesma service_role key usada no n8n)

async function salvarMapeamentoLid(lid, phone) {
  if (!lid || !phone || !SUPABASE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/lid_mapping`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({ lid, phone, updated_at: new Date().toISOString() })
    });
    console.log('[LID MAPPING] salvo:', lid, '->', phone);
  } catch (e) {
    console.warn('[LID MAPPING] erro ao salvar:', e.message);
  }
}

async function buscarTelefonePorLid(lid) {
  if (!SUPABASE_KEY) return null;
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/lid_mapping?lid=eq.${encodeURIComponent(lid)}&select=phone&limit=1`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const data = await resp.json();
    return Array.isArray(data) && data[0] ? data[0].phone : null;
  } catch (e) {
    console.warn('[LID MAPPING] erro ao buscar:', e.message);
    return null;
  }
}

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
  const { version } = await fetchLatestBaileysVersion();
  console.log('[Baileys] Usando versão do protocolo WA:', version);

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // ---------- Captura de RESPOSTAS recebidas (só escuta, NUNCA responde nada automaticamente) ----------
  // Encaminha pro n8n: telefone + texto + horário. O n8n decide se parece auto-resposta
  // (URA/robô do WhatsApp Business do próprio lead) e grava tudo no Supabase.
  // Este listener NUNCA chama sock.sendMessage — não existe resposta automática aqui.
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return; // ignora histórico/sincronização, só mensagens novas em tempo real
    for (const msg of messages) {
      try {
        if (!msg.message) continue;
        if (msg.key.fromMe) continue; // ignora mensagens que O PRÓPRIO NÚMERO enviou (nossos disparos)
        if (msg.key.remoteJid?.endsWith('@g.us')) continue; // ignora mensagens de grupo

        // O WhatsApp às vezes manda o remetente como @lid (Linked ID, privacidade) em vez
        // do número de telefone direto (@s.whatsapp.net). Essa versão do Baileys não traduz
        // isso sozinha, então consultamos a tabela lid_mapping (preenchida no momento do
        // ENVIO, na rota /send-message, via sock.onWhatsApp) pra achar o telefone real.
        let jidResolvido = msg.key.remoteJidAlt || msg.key.remoteJid || '';

        if ((msg.key.remoteJid || '').endsWith('@lid') && !msg.key.remoteJidAlt) {
          const lid = (msg.key.remoteJid || '').split('@')[0];
          const phoneEncontrado = await buscarTelefonePorLid(lid);
          if (phoneEncontrado) {
            jidResolvido = `${phoneEncontrado}@s.whatsapp.net`;
            console.log('[messages.upsert] LID resolvido via tabela lid_mapping:', lid, '->', phoneEncontrado);
          } else {
            console.warn('[messages.upsert] LID sem mapeamento conhecido ainda (talvez essa pessoa nunca tenha recebido mensagem sua) — ignorando:', msg.key.remoteJid);
            continue;
          }
        }

        const aindaEhLid = jidResolvido.endsWith('@lid');
        if (aindaEhLid) {
          console.warn('[messages.upsert] Não foi possível resolver o telefone real (veio como @lid) — ignorando esta mensagem:', msg.key.remoteJid);
          continue;
        }

        const phone = jidResolvido.replace('@s.whatsapp.net', '').replace(/\D/g, '');

        // Sanidade: telefone BR (com DDI) tem entre 10 e 13 dígitos.
        if (!phone || phone.length < 10 || phone.length > 13) {
          console.warn('[messages.upsert] Telefone extraído parece inválido, ignorando:', phone, '| jid original:', msg.key.remoteJid);
          continue;
        }

        const texto = msg.message.conversation
          || msg.message.extendedTextMessage?.text
          || msg.message.imageMessage?.caption
          || msg.message.videoMessage?.caption
          || '';

        const timestampMs = (msg.messageTimestamp ? Number(msg.messageTimestamp) : Math.floor(Date.now() / 1000)) * 1000;

        if (!N8N_WEBHOOK_RESPOSTA || !PROSPECTA_USER_ID) {
          console.warn('[messages.upsert] N8N_WEBHOOK_RESPOSTA ou PROSPECTA_USER_ID não configurados — resposta recebida mas não encaminhada.');
          continue;
        }

        // Node 18+ tem fetch nativo. Se der erro "fetch is not defined", rode:
        //   npm install node-fetch
        // e adicione no topo do arquivo: const fetch = require('node-fetch');
        fetch(N8N_WEBHOOK_RESPOSTA, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phone,
            mensagem: texto,
            recebidoEm: new Date(timestampMs).toISOString(),
            userId: PROSPECTA_USER_ID
          })
        }).then(() => {
          console.log('[messages.upsert] Resposta encaminhada pro n8n:', phone);
        }).catch(err => console.error('[messages.upsert] erro ao encaminhar resposta pro n8n:', err.message));

      } catch (err) {
        console.error('[messages.upsert] erro processando mensagem recebida:', err);
      }
    }
  });

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
// Gera um código de pareamento de 8 dígitos — alternativa ao QR code.
// Use quando não tiver como escanear (ex: só tem o próprio celular em mãos).
// No WhatsApp: Dispositivos Vinculados → Vincular com número de telefone → digite o código.
app.post('/pairing-code', checkAuth, async (req, res) => {
    if (isConnected) {
        return res.json({ connected: true });
    }
    if (!sock) {
        return res.status(503).json({ error: 'Servidor ainda inicializando, tente novamente em alguns segundos.' });
    }
    const { phone } = req.body;
    if (!phone) {
        return res.status(400).json({ error: 'Envie "phone" (com DDI, ex: 5511999999999) no corpo da requisição.' });
    }
    try {
        const digits = String(phone).replace(/\D/g, '');
        const code = await sock.requestPairingCode(digits);
        res.json({ code });
    } catch (err) {
        console.error('[Baileys] Erro ao gerar código de pareamento:', err);
        res.status(500).json({ error: err.message || 'Erro ao gerar código de pareamento.' });
    }
});

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

    // Antes de enviar, consulta o LID desse contato (se ele tiver um) e guarda o
    // mapeamento LID -> telefone. É isso que permite reconhecer a resposta dele
    // depois, mesmo que ela chegue como @lid em vez do telefone puro.
    try {
      const [contato] = await sock.onWhatsApp(jid);
      if (contato?.lid) {
        const lidDigits = String(contato.lid).split('@')[0].replace(/\D/g, '');
        const phoneDigits = String(phone).replace(/\D/g, '');
        salvarMapeamentoLid(lidDigits, phoneDigits); // fire-and-forget, não trava o envio
      }
    } catch (e) {
      console.warn('[send-message] Não deu pra checar/salvar LID desse contato (envio segue normal):', e.message);
    }

    await sock.sendMessage(jid, { text: message });
    res.json({ success: true, phone, jid });
  } catch (err) {
    console.error('[send-message] erro:', err);
    res.status(500).json({ error: err.message || 'Erro ao enviar mensagem.' });
  }
});

// Envia qualquer tipo de mídia (documento, imagem, áudio, vídeo) — recebe o arquivo em base64
app.post('/send-document', checkAuth, async (req, res) => {
  try {
    if (!isConnected || !sock) {
      return res.status(503).json({ error: 'WhatsApp não conectado ainda. Acesse /qr para conectar.' });
    }
    const { phone, base64, filename, caption, tipo, mimetype } = req.body;
    if (!phone || !base64) {
      return res.status(400).json({ error: 'Envie "phone" e "base64" no corpo da requisição.' });
    }
    const jid = toWhatsAppJid(phone);
    if (!jid) {
      return res.status(400).json({ error: 'Número de telefone inválido.' });
    }

    const buffer = Buffer.from(base64, 'base64');
    let payload;
    if (tipo === 'image') {
      payload = { image: buffer, mimetype: mimetype || 'image/jpeg', caption: caption || '' };
    } else if (tipo === 'video') {
      payload = { video: buffer, mimetype: mimetype || 'video/mp4', caption: caption || '' };
    } else if (tipo === 'audio') {
      // ptt:true (nota de voz, bolinha redonda) só funciona de verdade com áudio em
      // ogg/opus — forçar isso com outro formato (mp3, wav, etc.) fazia o envio falhar
      // silenciosamente. Se não for ogg/opus, manda como arquivo de áudio normal (ainda
      // toca certinho no WhatsApp, só não vira a bolinha redonda).
      const ehOggOpus = (mimetype || '').includes('ogg');
      payload = { audio: buffer, mimetype: mimetype || 'audio/mpeg', ptt: ehOggOpus };
    } else {
      payload = { document: buffer, fileName: filename || 'arquivo', mimetype: mimetype || 'application/octet-stream', caption: caption || '' };
    }

    await sock.sendMessage(jid, payload);
    res.json({ success: true, phone, jid });
  } catch (err) {
    console.error('[send-document] erro:', err);
    res.status(500).json({ error: err.message || 'Erro ao enviar documento.' });
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
