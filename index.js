/**
 * Servidor WhatsApp gratuito (Baileys) — substitui o UAZAPI no Prospecta+
 *
 * Rotas:
 *   GET  /qr              -> mostra o QR code para conectar o WhatsApp (escanear 1x)
 *   GET  /status          -> { connected, qrPendente, desde, motivo }
 *   POST /send-message    -> { phone: "5511999999999", message: "texto", digitandoMs?: 6000 }
 *   POST /send-document   -> { phone: "5511999999999", base64: "...", filename: "relatorio.pdf", caption: "texto opcional" }
 *   POST /check-number    -> { phone: "5511999999999" } -> { exists: true/false }
 *   GET  /groups          -> grupos em que este número participa (nome, tamanho, quantos números visíveis)
 *   GET  /groups/:id/participants -> participantes com número visível (o WhatsApp esconde o resto)
 *   POST /send-group      -> { grupoId: "1203...@g.us", message: "texto" }
 *
 * Variáveis de ambiente:
 *   API_TOKEN            -> token simples para proteger as rotas (defina no Railway)
 *   PORT                 -> porta (Railway define automaticamente)
 *   N8N_WEBHOOK_RESPOSTA -> URL do webhook n8n que recebe respostas dos leads (captura, não responde nada)
 *   PROSPECTA_USER_ID    -> UUID do usuário no Supabase Auth, pra casar a resposta com o lead certo
 *   SUPABASE_SERVICE_KEY -> grava LID, status da conexão, entregas/leituras e o que você digita no celular
 *   LIMITE_DIARIO_SERVIDOR -> teto de mensagens por dia neste número (padrão 150; trava de segurança)
 *   INTERVALO_MINIMO_MS  -> intervalo mínimo entre duas mensagens (padrão 3000)
 */

// Polyfill: versões recentes do Baileys usam a API global `crypto` (WebCrypto),
// que só existe nativamente a partir do Node 20. Isso garante que funcione mesmo
// em Node mais antigo (ex: Node 18 no Railway).
if (!globalThis.crypto) {
  globalThis.crypto = require('crypto').webcrypto;
}

// ---------- Logs: uma linha por evento importante, sem o ruído da criptografia ----------
// A biblioteca de criptografia escreve stack traces enormes ("Bad MAC", "Session error") direto no
// console. Isso já passou do limite de logs do Railway (que então descarta linhas). Aqui eles viram
// um contador, e um resumo sai a cada 10 minutos.
const RUIDO = /Bad MAC|Session error|MessageCounterError|Failed to decrypt|decryptWithSessions|doDecryptWhisperMessage|verifyMAC|session_cipher|queue_job|Closing (open )?session|Closing stale|Removing old closed session|Migrating session/i;
let ruidoSuprimido = 0;
for (const nivel of ['log', 'info', 'warn', 'error']) {
  const original = console[nivel].bind(console);
  console[nivel] = (...args) => {
    const texto = args.map(a => (a && a.stack) ? a.stack : (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');
    if (RUIDO.test(texto)) { ruidoSuprimido++; return; }
    original(...args);
  };
}
setInterval(() => {
  if (ruidoSuprimido) { console.log(`[cripto] ${ruidoSuprimido} avisos de sessão/descriptografia nos últimos 10 min (normal após reconectar)`); ruidoSuprimido = 0; }
}, 10 * 60 * 1000).unref();

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
  normalizeMessageContent,
  getContentType,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' })); // PDFs/mídias em base64 passam fácil do limite padrão (100kb)

const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN || ''; // se vazio, roda sem checagem (defina em produção!)
// Pasta da sessão do WhatsApp. No Railway, monte um Volume (ex.: em /data) e defina AUTH_DIR=/data/auth_info,
// senão a sessão se perde a cada novo deploy e é preciso ler o QR de novo. Sem AUTH_DIR, funciona como antes.
const AUTH_FOLDER = process.env.AUTH_DIR || path.join(__dirname, 'auth_info');

// Captura de resposta (só escuta e registra — NUNCA responde nada automaticamente)
const N8N_WEBHOOK_RESPOSTA = process.env.N8N_WEBHOOK_RESPOSTA || 'https://primary-production-c1c7c.up.railway.app/webhook/receber-resposta';
const PROSPECTA_USER_ID = process.env.PROSPECTA_USER_ID || ''; // UUID do usuário no Supabase Auth (defina no Railway!)

// Trava de segurança do próprio servidor (além do limite diário do n8n)
const LIMITE_DIARIO_SERVIDOR = parseInt(process.env.LIMITE_DIARIO_SERVIDOR, 10) || 150;
const INTERVALO_MINIMO_MS = parseInt(process.env.INTERVALO_MINIMO_MS, 10) || 3000;

// Mapeamento LID ↔ telefone: essa versão do Baileys nem sempre traduz @lid sozinha quando a
// resposta chega, então guardamos essa tradução ANTES, no momento do envio (quando já
// sabemos o telefone), consultando sock.onWhatsApp() — que retorna o LID do contato.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wktvwbmjubiqtbrvnapj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || ''; // defina no Railway (mesma service_role key usada no n8n)

function supaHeaders(extra) {
  return { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', ...(extra || {}) };
}
async function supa(metodo, caminho, corpo, prefer) {
  if (!SUPABASE_KEY) return null;
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${caminho}`, {
    method: metodo,
    headers: supaHeaders(prefer ? { 'Prefer': prefer } : {}),
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  if (!resp.ok) throw new Error(`Supabase ${resp.status}: ${(await resp.text()).slice(0, 160)}`);
  const txt = await resp.text();
  return txt ? JSON.parse(txt) : null;
}

async function salvarMapeamentoLid(lid, phone) {
  if (!lid || !phone || !SUPABASE_KEY) return;
  try {
    await supa('POST', 'lid_mapping', { lid, phone, updated_at: new Date().toISOString() }, 'resolution=merge-duplicates');
  } catch (e) {
    console.warn('[LID MAPPING] erro ao salvar:', e.message);
  }
}

async function buscarTelefonePorLid(lid) {
  if (!SUPABASE_KEY) return null;
  try {
    const data = await supa('GET', `lid_mapping?lid=eq.${encodeURIComponent(lid)}&select=phone&limit=1`);
    return Array.isArray(data) && data[0] ? data[0].phone : null;
  } catch (e) {
    console.warn('[LID MAPPING] erro ao buscar:', e.message);
    return null;
  }
}

// Telefone real de uma conversa individual (resolve @lid). Devolve só dígitos, ou null.
async function telefoneDaConversa(key) {
  let jid = key.remoteJidAlt || key.remoteJid || '';
  if (jid.endsWith('@lid')) {
    if (key.senderPn) jid = key.senderPn;                     // o próprio WhatsApp às vezes já manda o número
    else {
      const lid = jid.split('@')[0];
      const phone = await buscarTelefonePorLid(lid);
      if (!phone) return null;
      jid = `${phone}@s.whatsapp.net`;
    }
  }
  if (!jid.endsWith('@s.whatsapp.net')) return null;
  const phone = jid.replace('@s.whatsapp.net', '').split(':')[0].replace(/\D/g, '');
  return (phone.length >= 10 && phone.length <= 13) ? phone : null;
}

// ---------- Texto de qualquer tipo de mensagem ----------
// Antes só texto e legenda eram lidos; áudio, figurinha, documento, mensagens temporárias, de "ver uma vez"
// e editadas chegavam vazias. Agora cada tipo vira um texto que o app e a IA entendem.
const IGNORAR_TIPOS = new Set(['reactionMessage', 'protocolMessage', 'senderKeyDistributionMessage', 'pollUpdateMessage', 'keepInChatMessage', 'messageContextInfo']);
function lerMensagem(msg) {
  const conteudo = normalizeMessageContent(msg.message);       // abre temporária, "ver uma vez", documento com legenda…
  if (!conteudo) return null;
  // mensagem editada: vem como protocolMessage com o texto novo dentro
  const editada = conteudo.protocolMessage?.editedMessage || conteudo.editedMessage?.message?.protocolMessage?.editedMessage;
  if (editada) {
    const t = editada.conversation || editada.extendedTextMessage?.text || '';
    return t ? { texto: t, tipo: 'texto' } : null;
  }
  const tipo = getContentType(conteudo);
  if (!tipo || IGNORAR_TIPOS.has(tipo)) return null;
  const c = conteudo[tipo] || {};
  switch (tipo) {
    case 'conversation': return { texto: conteudo.conversation || '', tipo: 'texto' };
    case 'extendedTextMessage': {
      // Link com prévia (imagem pequena + título + descrição), como o WhatsApp mostra
      const link = (c.title || c.description || c.jpegThumbnail) && (c.matchedText || c.canonicalUrl)
        ? { titulo: c.title || null, descricao: c.description || null, url: c.canonicalUrl || c.matchedText || null, thumb: c.jpegThumbnail && c.jpegThumbnail.length ? Buffer.from(c.jpegThumbnail) : null }
        : null;
      return { texto: c.text || '', tipo: 'texto', link };
    }
    case 'imageMessage': return { texto: c.caption ? `📷 Foto: ${c.caption}` : '📷 Foto', tipo: 'imagem', midia: { mime: c.mimetype, tam: Number(c.fileLength) || 0 } };
    case 'videoMessage': return { texto: c.caption ? `🎥 Vídeo: ${c.caption}` : '🎥 Vídeo', tipo: 'video', midia: { mime: c.mimetype, tam: Number(c.fileLength) || 0 } };
    case 'audioMessage': return { texto: '🎤 Áudio', tipo: 'audio', midia: { mime: c.mimetype, tam: Number(c.fileLength) || 0 } };
    case 'stickerMessage': return { texto: '🌟 Figurinha', tipo: 'figurinha' };
    case 'documentMessage': return { texto: `📄 Documento: ${c.fileName || c.title || 'arquivo'}${c.caption ? ' — ' + c.caption : ''}`, tipo: 'documento', midia: { mime: c.mimetype, tam: Number(c.fileLength) || 0, nome: c.fileName || c.title || 'arquivo' } };
    case 'contactMessage': return { texto: `👤 Contato: ${c.displayName || ''}`.trim(), tipo: 'contato' };
    case 'contactsArrayMessage': return { texto: `👤 Contatos: ${(c.contacts || []).map(x => x.displayName).filter(Boolean).join(', ')}`, tipo: 'contato' };
    case 'locationMessage': case 'liveLocationMessage': return { texto: `📍 Localização${c.name ? ': ' + c.name : ''}${c.address ? ' — ' + c.address : ''}`, tipo: 'localizacao' };
    case 'buttonsResponseMessage': return { texto: c.selectedDisplayText || c.selectedButtonId || '', tipo: 'texto' };
    case 'listResponseMessage': return { texto: c.title || c.singleSelectReply?.selectedRowId || '', tipo: 'texto' };
    case 'templateButtonReplyMessage': return { texto: c.selectedDisplayText || '', tipo: 'texto' };
    case 'pollCreationMessage': case 'pollCreationMessageV3': return { texto: `📊 Enquete: ${c.name || ''}`, tipo: 'enquete' };
    default: return { texto: '', tipo };
  }
}

// Transcreve o áudio com a chave da OpenAI do usuário (a mesma do app). Se não der, fica "🎤 Áudio".
let _chaveOpenAI = { valor: '', em: 0 };
async function chaveOpenAI() {
  if (Date.now() - _chaveOpenAI.em < 10 * 60 * 1000) return _chaveOpenAI.valor;
  try {
    const r = await supa('GET', `user_config?user_id=eq.${encodeURIComponent(PROSPECTA_USER_ID)}&select=openai_key&limit=1`);
    _chaveOpenAI = { valor: (Array.isArray(r) && r[0] && r[0].openai_key) || '', em: Date.now() };
  } catch (e) { _chaveOpenAI = { valor: '', em: Date.now() }; }
  return _chaveOpenAI.valor;
}
async function transcreverAudio(msg, bufferPronto) {
  try {
    const chave = await chaveOpenAI();
    if (!chave) return '';
    const buffer = bufferPronto || await downloadMediaMessage(msg, 'buffer', {});
    if (!buffer || buffer.length > 20 * 1024 * 1024) return '';
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'audio/ogg' }), 'audio.ogg');
    form.append('model', 'whisper-1');
    form.append('language', 'pt');
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { 'Authorization': `Bearer ${chave}` }, body: form, signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) { console.warn('[áudio] transcrição falhou:', r.status); return ''; }
    const d = await r.json();
    return String(d.text || '').trim();
  } catch (e) {
    console.warn('[áudio] não deu para transcrever:', e.message);
    return '';
  }
}

// ---------- Mídias recebidas: o arquivo vai para o Storage (bucket privado "midias") para o Inbox mostrar ----------
const LIMITE_MIDIA = 16 * 1024 * 1024;
async function baixarMidia(msg, lida) {
  if (!lida || !lida.midia || (lida.midia.tam && lida.midia.tam > LIMITE_MIDIA)) return null;
  try {
    const b = await downloadMediaMessage(msg, 'buffer', {});
    return b && b.length <= LIMITE_MIDIA ? b : null;
  } catch (e) { console.warn('[mídia] não baixou:', e.message); return null; }
}
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'application/pdf': 'pdf', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a' };
async function guardarMidia(msg, lida, buffer, onde) {
  if (!buffer || !SUPABASE_KEY || !PROSPECTA_USER_ID) return;
  const mime = String(lida.midia.mime || 'application/octet-stream').split(';')[0];
  const ext = EXT[mime] || (mime.includes('ogg') ? 'ogg' : (lida.midia.nome || '').split('.').pop().slice(0, 5) || 'bin');
  const path = `${PROSPECTA_USER_ID}/${msg.key.id}.${ext}`;
  try {
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/midias/${path}`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY, 'Content-Type': mime, 'x-upsert': 'true' }, body: buffer,
    });
    if (!r.ok) throw new Error('storage ' + r.status);
    await supa('POST', 'midias', {
      msg_id: msg.key.id, user_id: PROSPECTA_USER_ID, phone: onde.phone || null, grupo_id: onde.grupoId || null, tipo: lida.tipo, mime, path,
      nome_arquivo: lida.midia.nome || null, criado_em: new Date(((Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000)).toISOString(),
    }, 'resolution=ignore-duplicates,return=minimal');
  } catch (e) { console.warn('[mídia] não guardou:', e.message); }
}

// Cartão do link: guarda a imagem pequena da prévia (se veio) e título/descrição/url
async function guardarLink(msg, lida, onde) {
  const l = lida && lida.link;
  if (!l || !SUPABASE_KEY || !PROSPECTA_USER_ID) return;
  let path = null;
  try {
    if (l.thumb && l.thumb.length < 512 * 1024) {
      path = `${PROSPECTA_USER_ID}/${msg.key.id}.jpg`;
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/midias/${path}`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' }, body: l.thumb,
      });
      if (!r.ok) path = null;
    }
    await supa('POST', 'midias', {
      msg_id: msg.key.id, user_id: PROSPECTA_USER_ID, phone: onde.phone || null, grupo_id: onde.grupoId || null, tipo: 'link', mime: path ? 'image/jpeg' : null, path,
      titulo: (l.titulo || '').slice(0, 300) || null, descricao: (l.descricao || '').slice(0, 600) || null, url: (l.url || '').slice(0, 1000) || null,
      criado_em: new Date(((Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000)).toISOString(),
    }, 'resolution=ignore-duplicates,return=minimal');
  } catch (e) { console.warn('[link] não guardou:', e.message); }
}

// ---------- Fotos de perfil (contatos e grupos), com cache de 12h ----------
const _fotos = new Map();                       // jid -> { url, em }
const FOTO_TTL = 12 * 60 * 60 * 1000;
async function fotoDePerfil(jid) {
  const c = _fotos.get(jid);
  if (c && Date.now() - c.em < FOTO_TTL) return c.url;
  let url = null;
  try { url = await Promise.race([sock.profilePictureUrl(jid, 'preview'), new Promise(r => setTimeout(() => r(undefined), 5000))]); } catch (e) { url = null; }
  if (url === undefined) return null;          // demorou: não guarda no cache, tenta de novo depois
  if (_fotos.size > 20000) _fotos.delete(_fotos.keys().next().value);
  _fotos.set(jid, { url: url || null, em: Date.now() });
  return url || null;
}

// ---------- Áudio gravado no navegador vira mensagem de voz do WhatsApp (ogg/opus) ----------
// O navegador grava em webm/mp4; o WhatsApp do iPhone muitas vezes não toca e o áudio chega como arquivo.
let ffmpegPath = null;
try { ffmpegPath = require('ffmpeg-static'); } catch (e) { console.warn('[áudio] ffmpeg-static indisponível: áudio vai sem conversão'); }
function paraOggOpus(buffer) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('sem ffmpeg'));
    const { spawn } = require('child_process');
    const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', 'pipe:1']);
    const saida = [], erros = [];
    const tempo = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('conversão demorou demais')); }, 30000);
    p.stdout.on('data', d => saida.push(d));
    p.stderr.on('data', d => erros.push(d));
    p.on('error', e => { clearTimeout(tempo); reject(e); });
    p.on('close', c => { clearTimeout(tempo); c === 0 && saida.length ? resolve(Buffer.concat(saida)) : reject(new Error('ffmpeg ' + c + ' ' + Buffer.concat(erros).toString().slice(0, 120))); });
    p.stdin.on('error', () => {});
    p.stdin.end(buffer);
  });
}

// ---------- Reenvio de mensagens que o celular não conseguiu abrir ----------
// Quando um aparelho não consegue abrir uma mensagem, o WhatsApp pede para reenviá-la ("Aguardando mensagem...").
// Sem a função getMessage o servidor não sabe o conteúdo original e a mensagem fica pendente para sempre.
// Guardamos as últimas mensagens enviadas em memória (limite de 3000) para atender esse pedido.
// Esse mapa também diz quais mensagens "minhas" saíram por este servidor (campanha, app, n8n) e quais
// você digitou no celular.
const mensagensEnviadas = new Map();
const MAX_MENSAGENS = 3000;
function guardarMensagem(enviada) {
  try {
    if (!enviada || !enviada.key || !enviada.key.id || !enviada.message) return;
    mensagensEnviadas.set(enviada.key.id, enviada.message);
    if (mensagensEnviadas.size > MAX_MENSAGENS) mensagensEnviadas.delete(mensagensEnviadas.keys().next().value);
  } catch (e) { /* nunca atrapalha o envio */ }
}
const msgRetryCounterCache = {
  _m: new Map(),
  get(k) { return this._m.get(k); },
  set(k, v) { this._m.set(k, v); return true; },
  del(k) { this._m.delete(k); },
  flushAll() { this._m.clear(); },
};

// ---------- Entrega e leitura ----------
async function registrarEnvio(enviada, phone) {
  if (!PROSPECTA_USER_ID || !enviada?.key?.id) return;
  try {
    await supa('POST', 'entregas', { msg_id: enviada.key.id, user_id: PROSPECTA_USER_ID, phone, status: 1, enviado_em: new Date().toISOString() }, 'resolution=ignore-duplicates,return=minimal');
  } catch (e) { console.warn('[entregas] não gravou o envio:', e.message); }
}
async function registrarRecibo(id, status) {
  // status do WhatsApp: 2 servidor, 3 entregue, 4 lida, 5 tocada (áudio)
  const agora = new Date().toISOString();
  const corpo = status >= 4 ? { status: 4, lido_em: agora } : { status: 3, entregue_em: agora };
  try {
    // só sobe de status (nunca volta de "lida" para "entregue")
    await supa('PATCH', `entregas?msg_id=eq.${encodeURIComponent(id)}&status=lt.${corpo.status}`, corpo, 'return=minimal');
    if (corpo.status === 4) await supa('PATCH', `entregas?msg_id=eq.${encodeURIComponent(id)}&entregue_em=is.null`, { entregue_em: agora }, 'return=minimal');
  } catch (e) { console.warn('[entregas] recibo não gravado:', e.message); }
}

// ---------- Estado da conexão (o app mostra um aviso quando cai) ----------
let sock = null;
let latestQR = null;
let isConnected = false;
let estado = { conectado: false, qrPendente: false, motivo: 'iniciando', desde: new Date().toISOString() };
async function publicarEstado(conectado, qrPendente, motivo) {
  const mudou = estado.conectado !== conectado || estado.qrPendente !== qrPendente;
  estado = { conectado, qrPendente, motivo: motivo || '', desde: mudou ? new Date().toISOString() : estado.desde };
  if (!mudou || !PROSPECTA_USER_ID) return;
  console.log(`[conexão] ${conectado ? 'CONECTADO' : qrPendente ? 'DESCONECTADO — esperando ler o QR' : 'DESCONECTADO'}${motivo ? ' · ' + motivo : ''}`);
  try {
    await supa('POST', 'whatsapp_status', {
      user_id: PROSPECTA_USER_ID, conectado, qr_pendente: qrPendente, motivo: motivo || null,
      desde: estado.desde, atualizado_em: new Date().toISOString(),
    }, 'resolution=merge-duplicates,return=minimal');
  } catch (e) { console.warn('[conexão] não gravou o estado:', e.message); }
}

// ---------- Você respondeu pelo celular ----------
// Antes, toda mensagem "minha" era ignorada. Agora o que você digita no celular (ou no WhatsApp Web) vai para
// o histórico, e a conversa sai da fila de Respostas como "respondida no WhatsApp". As mensagens que saíram por
// este servidor (campanha, follow-up, app) não entram aqui: elas já são registradas por quem enviou.
async function registrarRespostaManual(msg, phone, lida) {
  if (!SUPABASE_KEY || !PROSPECTA_USER_ID) return;
  const agora = new Date(((Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000)).toISOString();
  const variantes = [phone, phone.startsWith('55') ? phone.slice(2) : '55' + phone].join(',');
  try {
    await supa('POST', 'respostas_historico', { user_id: PROSPECTA_USER_ID, phone, lead_nome: '', direcao: 'enviada', mensagem: lida.texto, criado_em: agora }, 'return=minimal');
    await supa('PATCH', `fila_sugestoes?user_id=eq.${PROSPECTA_USER_ID}&phone=in.(${variantes})&status=eq.pendente`, { status: 'respondido_fora', respondido_em: agora }, 'return=minimal');
    console.log('[você respondeu pelo celular]', phone.slice(0, 4) + '…' + phone.slice(-2));
  } catch (e) { console.warn('[você respondeu pelo celular] não gravou:', e.message); }
}

// ---------- Grupos ----------
// Só os grupos que você marcou para acompanhar no Inbox têm mensagens gravadas (tabela grupos_config).
let _gruposAcompanhados = { ids: new Set(), em: 0 };
async function gruposAcompanhados() {
  if (Date.now() - _gruposAcompanhados.em < 60 * 1000) return _gruposAcompanhados.ids;
  try {
    const r = await supa('GET', `grupos_config?user_id=eq.${encodeURIComponent(PROSPECTA_USER_ID)}&acompanhar=eq.true&select=grupo_id`);
    _gruposAcompanhados = { ids: new Set((r || []).map(x => x.grupo_id)), em: Date.now() };
  } catch (e) { _gruposAcompanhados.em = Date.now(); }
  return _gruposAcompanhados.ids;
}
const _nomesGrupos = new Map();
// Nome que cada pessoa usa no WhatsApp (pushName), aprendido das mensagens e da agenda: aparece na lista de integrantes
const _nomesContatos = new Map();
function lembrarNome(phone, nome) {
  if (!phone || !nome || typeof nome !== 'string') return;
  if (_nomesContatos.size > 20000) _nomesContatos.delete(_nomesContatos.keys().next().value);
  _nomesContatos.set(String(phone), nome.slice(0, 80));
}
function telefoneDoJid(jid) {
  jid = String(jid || '');
  if (!jid.endsWith('@s.whatsapp.net')) return null;
  const d = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
  return d.length >= 10 && d.length <= 13 ? d : null;
}
async function nomeDoGrupo(id) {
  if (_nomesGrupos.has(id)) return _nomesGrupos.get(id);
  try { const m = await sock.groupMetadata(id); _nomesGrupos.set(id, m.subject || ''); return m.subject || ''; } catch (e) { return ''; }
}
function telefoneDoParticipante(p) {
  const jid = (p && (p.jid || (String(p.id || '').endsWith('@s.whatsapp.net') ? p.id : ''))) || '';
  if (!jid.endsWith('@s.whatsapp.net')) return null;
  const d = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
  return d.length >= 10 && d.length <= 13 ? d : null;
}
// "Alguém indica um contador?", "preciso de alguém que faça site": quem pede indicação num grupo é oportunidade
const PEDIDO_INDICACAO = /(algu[eé]m|quem)\s+(aqui\s+)?(me\s+|pode\s+me\s+)?(indica|indicar|recomenda|recomendar|conhece|tem\s+(uma?\s+)?indica[çc][ãa]o|sabe\s+de)|indica[çc](ão|ões|ao)\s+de|(preciso|procuro|estou\s+procurando|t[ôo]\s+procurando)\s+(de\s+)?(um|uma|algu[eé]m)\b|algu[eé]m\s+que\s+(fa[çz]a|trabalh|conserte|instale|venda)/i;
async function registrarOportunidadeGrupo(msg, lida, grupoId, autorPhone) {
  if (msg.key.fromMe || !lida || lida.tipo !== 'texto' || !PEDIDO_INDICACAO.test(lida.texto) || lida.texto.length > 600) return;
  try {
    await supa('POST', 'oportunidades_grupo', {
      msg_id: msg.key.id, user_id: PROSPECTA_USER_ID, grupo_id: grupoId, grupo_nome: await nomeDoGrupo(grupoId),
      autor_phone: autorPhone, autor_nome: msg.pushName || null, mensagem: lida.texto,
      criado_em: new Date(((Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000)).toISOString(),
    }, 'resolution=ignore-duplicates,return=minimal');
    console.log('[grupo] pedido de indicação detectado');
  } catch (e) { console.warn('[grupo] oportunidade não gravada:', e.message); }
}
// Diagnóstico: a cada 10 min, se chegou algo de grupo, um resumo no log (sem conteúdo das mensagens)
const _diagGrupos = { chegaram: 0, semConteudo: 0, gravadas: 0 };
setInterval(() => {
  if (!_diagGrupos.chegaram) return;
  console.log(`[grupo] últimos 10 min: ${_diagGrupos.chegaram} mensagens de grupo, ${_diagGrupos.gravadas} gravadas (grupos acompanhados), ${_diagGrupos.semConteudo} não abriram`);
  _diagGrupos.chegaram = _diagGrupos.semConteudo = _diagGrupos.gravadas = 0;
}, 10 * 60 * 1000).unref();
async function registrarMensagemGrupo(msg) {
  if (!SUPABASE_KEY || !PROSPECTA_USER_ID) return;
  const grupoId = msg.key.remoteJid;
  const lida = lerMensagem(msg);
  if (!lida || !lida.texto) return;
  const autorJid = msg.key.participantPn || msg.key.participantAlt || msg.key.participant || '';
  const autorPhone = autorJid.endsWith('@s.whatsapp.net') ? autorJid.split('@')[0].split(':')[0] : null;
  registrarOportunidadeGrupo(msg, lida, grupoId, autorPhone);              // vale para qualquer grupo
  if (!(await gruposAcompanhados()).has(grupoId)) return;                 // guardar a conversa: só os acompanhados
  if (lida.midia) baixarMidia(msg, lida).then(b => guardarMidia(msg, lida, b, { grupoId })).catch(() => {});
  if (lida.link) guardarLink(msg, lida, { grupoId });
  try {
    await supa('POST', 'grupo_mensagens', {
      msg_id: msg.key.id, user_id: PROSPECTA_USER_ID, grupo_id: grupoId, grupo_nome: await nomeDoGrupo(grupoId),
      autor_phone: msg.key.fromMe ? null : autorPhone, autor_nome: msg.key.fromMe ? 'Você' : (msg.pushName || null),
      mensagem: lida.texto, tipo: lida.tipo, de_mim: !!msg.key.fromMe,
      criado_em: new Date(((Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000)).toISOString(),
    }, 'resolution=ignore-duplicates,return=minimal');
    _diagGrupos.gravadas++;
  } catch (e) { console.warn('[grupo] não gravou a mensagem:', e.message); }
}
// Limpeza: mensagens de grupo com mais de 30 dias saem do banco (uma vez por dia)
setInterval(() => {
  if (!SUPABASE_KEY || !PROSPECTA_USER_ID) return;
  const limite = new Date(Date.now() - 30 * 86400000).toISOString();
  supa('DELETE', `grupo_mensagens?user_id=eq.${PROSPECTA_USER_ID}&criado_em=lt.${encodeURIComponent(limite)}`, undefined, 'return=minimal').catch(() => {});
}, 24 * 60 * 60 * 1000).unref();

// ---------- Middleware de autenticação ----------
// Dois jeitos de entrar:
//  1) x-api-token (a automação n8n e o painel do administrador);
//  2) Authorization: Bearer <login do Supabase> — o app do cliente. Só passa o login do dono deste
//     servidor (PROSPECTA_USER_ID), então o cliente nunca precisa ver o token do servidor.
const _loginsOk = new Map();   // token -> expira em (ms); evita perguntar ao Supabase a cada chamada
async function loginDoDono(jwt) {
  if (!jwt || !PROSPECTA_USER_ID || !SUPABASE_KEY) return false;
  const agora = Date.now();
  const em = _loginsOk.get(jwt);
  if (em && em > agora) return true;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${jwt}` } });
    if (!r.ok) return false;
    const u = await r.json();
    if (!u || u.id !== PROSPECTA_USER_ID) return false;
    if (_loginsOk.size > 200) for (const [k, v] of _loginsOk) if (v <= agora) _loginsOk.delete(k);
    _loginsOk.set(jwt, agora + 5 * 60 * 1000);
    return true;
  } catch (e) { return false; }
}
async function checkAuth(req, res, next) {
  // Sem API_TOKEN o servidor não atende nada (antes ficava aberto para qualquer um)
  if (!API_TOKEN) return res.status(503).json({ error: 'Servidor sem API_TOKEN configurado.' });
  // O token vai no cabeçalho; pela URL (fica em logs) só na página do QR aberta no navegador
  const token = req.headers['x-api-token'] || (req.path === '/qr' ? req.query.token : undefined);
  if (token && token === API_TOKEN) return next();
  const jwt = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (jwt && await loginDoDono(jwt)) return next();
  return res.status(401).json({ error: jwt ? 'Login sem acesso a este servidor. Entre de novo no Prospecta+.' : 'Token inválido. Envie o header x-api-token.' });
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
    getMessage: async (key) => mensagensEnviadas.get(key.id) || undefined, // atende o pedido de reenvio
    msgRetryCounterCache,
    markOnlineOnConnect: false, // deixa o celular continuar recebendo as notificações normalmente
  });

  sock.ev.on('creds.update', saveCreds);
  const _aprenderContatos = lista => { for (const c of lista || []) lembrarNome(telefoneDoJid(c.phoneNumber || c.jid || c.id), c.name || c.notify || c.verifiedName); };
  sock.ev.on('contacts.upsert', _aprenderContatos);
  sock.ev.on('contacts.update', _aprenderContatos);

  // ---------- Mensagens novas (só escuta e registra, NUNCA responde nada automaticamente) ----------
  // Encaminha pro n8n: telefone + texto + horário. O n8n decide se parece auto-resposta
  // (URA/robô do WhatsApp Business do próprio lead) e grava tudo no Supabase.
  // Este listener NUNCA chama sock.sendMessage — não existe resposta automática aqui.
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      try {
        if (msg.key?.remoteJid?.endsWith('@g.us')) { _diagGrupos.chegaram++; if (!msg.message) _diagGrupos.semConteudo++; }
        if (!msg.key?.fromMe && msg.pushName) lembrarNome(telefoneDoJid(msg.key.participantPn || msg.key.participantAlt || msg.key.participant || msg.key.remoteJid), msg.pushName);
        if (!msg.message) continue;
        if (msg.key.remoteJid === 'status@broadcast') continue;   // status (stories) não interessa
        // Grupos: nunca viram lead nem vão para a IA; só ficam gravados se você acompanha o grupo no Inbox
        if (msg.key.remoteJid?.endsWith('@g.us')) {
          const idadeSeg = Date.now() / 1000 - (Number(msg.messageTimestamp) || 0);
          if (type === 'notify' || idadeSeg < 120) {
            if (msg.key.fromMe && mensagensEnviadas.has(msg.key.id)) continue;   // já gravada pelo app
            registrarMensagemGrupo(msg);
          }
          continue;
        }

        // Mensagem sua: só interessa a que você digitou no celular, em tempo real
        if (msg.key.fromMe) {
          if (mensagensEnviadas.has(msg.key.id)) continue;          // saiu por este servidor
          const idadeSeg = Date.now() / 1000 - (Number(msg.messageTimestamp) || 0);
          if (type !== 'notify' && idadeSeg > 120) continue;        // histórico antigo sincronizado
          const lida = lerMensagem(msg);
          if (!lida || !lida.texto) continue;
          const phone = await telefoneDaConversa(msg.key);
          const meu = String(sock?.user?.id || '').split(':')[0].split('@')[0];
          if (phone && phone !== meu) registrarRespostaManual(msg, phone, lida);   // recado para si mesmo não conta
          continue;
        }

        if (type !== 'notify') continue; // ignora histórico/sincronização, só mensagens novas em tempo real

        const phone = await telefoneDaConversa(msg.key);
        if (!phone) {
          console.warn('[mensagem recebida] sem telefone reconhecível (provável @lid sem mapeamento) — ignorada');
          continue;
        }

        const lida = lerMensagem(msg);
        if (!lida) continue;                                        // reação, aviso do sistema etc.
        let texto = lida.texto;
        const bufferMidia = lida.midia ? await baixarMidia(msg, lida) : null;
        if (bufferMidia) guardarMidia(msg, lida, bufferMidia, { phone });
        if (lida.link) guardarLink(msg, lida, { phone });
        if (lida.tipo === 'audio') {
          const transcrito = await transcreverAudio(msg, bufferMidia);
          if (transcrito) texto = `🎤 Áudio: "${transcrito}"`;
        }

        const timestampMs = (msg.messageTimestamp ? Number(msg.messageTimestamp) : Math.floor(Date.now() / 1000)) * 1000;

        if (!N8N_WEBHOOK_RESPOSTA || !PROSPECTA_USER_ID) {
          console.warn('[mensagem recebida] N8N_WEBHOOK_RESPOSTA ou PROSPECTA_USER_ID não configurados — não encaminhada.');
          continue;
        }

        fetch(N8N_WEBHOOK_RESPOSTA, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-webhook-secret': process.env.N8N_WEBHOOK_SECRET || '' },   // a automação só aceita com este segredo
          body: JSON.stringify({
            phone,
            mensagem: texto,
            tipo: lida.tipo,
            recebidoEm: new Date(timestampMs).toISOString(),
            userId: PROSPECTA_USER_ID
          })
        }).then(() => {
          console.log(`[mensagem recebida] ${lida.tipo} encaminhada pro n8n`);
        }).catch(err => console.error('[mensagem recebida] erro ao encaminhar pro n8n:', err.message));

      } catch (err) {
        console.error('[messages.upsert] erro processando mensagem:', err && err.message);
      }
    }
  });

  // ---------- Entregue / lida ----------
  sock.ev.on('messages.update', (updates) => {
    for (const { key, update } of updates) {
      try {
        if (!key?.fromMe || !key.id || !update || update.status === undefined) continue;
        if (Number(update.status) >= 3) registrarRecibo(key.id, Number(update.status));
      } catch (e) { /* nunca derruba o servidor */ }
    }
  });

  sock.ev.on('groups.update', (lista) => { for (const g of lista || []) if (g.id && g.subject) _nomesGrupos.set(g.id, g.subject); });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      publicarEstado(false, true, 'Leia o QR code para conectar');
    }

    if (connection === 'open') {
      const foraDesde = !estado.conectado && estado.motivo !== 'iniciando' ? estado.desde : null;
      isConnected = true;
      latestQR = null;
      publicarEstado(true, false, '');
      if (foraDesde) avisarVolta(foraDesde);
    }

    if (connection === 'close') {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      const motivo = lastDisconnect?.error?.message || 'desconhecido';
      // 408 "QR refs attempts ended" = ninguém leu o QR a tempo; o servidor gera outro e continua esperando
      if (statusCode !== 408) console.log('[Baileys] Conexão fechada. Código:', statusCode, '| Motivo:', motivo, '| Reconectar?', shouldReconnect);
      if (shouldReconnect) {
        publicarEstado(false, statusCode === 408 || !!latestQR, statusCode === 408 ? 'Leia o QR code para conectar' : `Reconectando (${statusCode || '?'})`);
        setTimeout(() => startSock(), 2000); // pequena espera antes de tentar de novo
      } else {
        publicarEstado(false, true, 'O WhatsApp desconectou este aparelho. Leia o QR code de novo.');
        console.log('[Baileys] Sessão deslogada: apagando a sessão antiga e gerando QR novo.');
        if (Date.now() - _saidaPedidaEm > 60000) protegerAposQueda().catch(e => console.warn('[proteção]', e.message));
        limparSessao();
        setTimeout(() => startSock().catch(e => console.error('[Baileys] Erro ao reiniciar:', e && e.message)), 2000);
      }
    }
  });
}


// ---------- Avisos no WhatsApp de alerta (número de "lead quente" em Integrações) ----------
// Campanha terminou / pausou no limite / foi cancelada / errou seguido, WhatsApp voltou depois de cair,
// teto do servidor e resumo do dia às 18h. Sai deste mesmo WhatsApp para o número de alerta.
// (Quando o WhatsApp cai, ele mesmo não consegue avisar: o aviso sai quando ele volta, com quanto tempo ficou fora.)
const ALERTAS_ARQ = path.join(path.dirname(AUTH_FOLDER), 'alertas_estado.json');
let alertasEstado = null;            // { campanhas: { id: 'fim'|'limite'|'cancelado'|'erros' }, resumo: 'dd/mm/aaaa', teto: 'dd/mm/aaaa' }
let alertasPendentes = [];           // avisos que esperam o WhatsApp voltar
function lerAlertasEstado() {
  if (alertasEstado) return alertasEstado;
  try { alertasEstado = JSON.parse(fs.readFileSync(ALERTAS_ARQ, 'utf8')); alertasEstado._novo = false; }
  catch (e) { alertasEstado = { campanhas: {}, resumo: '', teto: '', _novo: true }; }
  alertasEstado.campanhas = alertasEstado.campanhas || {};
  return alertasEstado;
}
function salvarAlertasEstado() {
  try { const { _novo, ...s } = alertasEstado; fs.writeFileSync(ALERTAS_ARQ, JSON.stringify(s)); } catch (e) { console.warn('[alertas] não salvou o estado:', e.message); }
}
let _numAlerta = { v: '', em: 0 }, _emailDono = { v: '', em: 0 };
async function numeroAlerta() {
  if (Date.now() - _numAlerta.em < 10 * 60 * 1000) return _numAlerta.v;
  try {
    const r = await supa('GET', `user_config?user_id=eq.${encodeURIComponent(PROSPECTA_USER_ID)}&select=numero_alerta&limit=1`);
    _numAlerta = { v: String((r && r[0] && r[0].numero_alerta) || '').replace(/\D/g, ''), em: Date.now() };
  } catch (e) { _numAlerta.em = Date.now(); }
  return _numAlerta.v;
}
async function emailDono() {
  if (_emailDono.v || Date.now() - _emailDono.em < 10 * 60 * 1000) return _emailDono.v;
  _emailDono.em = Date.now();
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(PROSPECTA_USER_ID)}`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
    if (r.ok) _emailDono.v = ((await r.json()) || {}).email || '';
  } catch (e) {}
  return _emailDono.v;
}
async function enviarAlerta(texto) {
  if (!SUPABASE_KEY || !PROSPECTA_USER_ID) return false;
  const num = await numeroAlerta();
  if (!num || num.length < 10) return false;
  if (!isConnected || !sock) { if (alertasPendentes.length < 5) alertasPendentes.push(texto); return false; }
  try {
    guardarMensagem(await sock.sendMessage(toWhatsAppJid(num), { text: String(texto).slice(0, 1500) }));   // não vira "resposta manual"
    console.log('[alertas] aviso enviado');
    return true;
  } catch (e) { console.warn('[alertas] não enviou:', e.message); return false; }
}
function horaSP(iso) { return new Date(iso).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }); }
function duracaoTxt(ms) { const m = Math.round(ms / 60000); return m < 60 ? m + ' min' : Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0'); }

// WhatsApp voltou depois de ficar fora mais de 3 minutos
function avisarVolta(foraDesdeIso) {
  const fora = Date.now() - new Date(foraDesdeIso).getTime();
  const pend = alertasPendentes.splice(0);
  if (fora < 3 * 60 * 1000 && !pend.length) return;
  setTimeout(() => {
    const txt = fora >= 3 * 60 * 1000 ? `✅ *WhatsApp voltou* às ${horaSP(new Date().toISOString())}\nFicou fora ${duracaoTxt(fora)} (desde ${horaSP(foraDesdeIso)}). As campanhas continuam sozinhas.` : '';
    enviarAlerta([txt, ...pend].filter(Boolean).join('\n\n'));
  }, 8000);
}

// Acompanha as campanhas pelo status que a automação grava
async function verificarCampanhas() {
  if (!SUPABASE_KEY || !PROSPECTA_USER_ID || !isConnected) return;
  const email = await emailDono(); if (!email) return;
  const est = lerAlertasEstado();
  let linhas;
  try {
    const desde = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
    linhas = await supa('GET', `status_campanha?user_email=eq.${encodeURIComponent(email)}&created_at=gte.${encodeURIComponent(desde)}&select=campanhaId,idx,total,status,phone,log,created_at&order=id.asc&limit=5000`);
  } catch (e) { return; }
  const camps = {};
  (linhas || []).forEach(l => {
    const c = camps[l.campanhaId] = camps[l.campanhaId] || { id: l.campanhaId, total: 0, idx: new Set(), st: {}, phones: [], ini: l.created_at, fim: l.created_at, nome: '', ultimos: [] };
    c.total = Math.max(c.total, parseInt(l.total, 10) || 0);
    if (l.idx !== null && l.idx !== undefined && l.status !== 'cancelado') c.idx.add(String(l.idx));
    c.st[l.status] = (c.st[l.status] || 0) + 1;
    if (l.status === 'enviado' && l.phone) c.phones.push(String(l.phone).replace(/\D/g, ''));
    c.fim = l.created_at;
    c.ultimos.push(l.status); if (c.ultimos.length > 3) c.ultimos.shift();
    const m = String(l.log || '').match(/\|\s*([^|]+)$/); if (m && !c.nome) c.nome = m[1].trim();
  });
  const primeira = est._novo; est._novo = false;
  for (const c of Object.values(camps)) {
    const antes = est.campanhas[c.id];
    let agora = null;
    if (c.st.cancelado) agora = 'cancelado';
    else if (c.total && c.idx.size >= c.total) agora = 'fim';
    else if (c.ultimos[c.ultimos.length - 1] === 'limite_diario') agora = 'limite';
    else if (c.ultimos.length === 3 && c.ultimos.every(s => s === 'erro')) agora = 'erros';
    if (!agora || antes === agora || antes === 'fim' || antes === 'cancelado') continue;
    est.campanhas[c.id] = agora;
    if (primeira || Date.now() - new Date(c.fim).getTime() > 6 * 3600 * 1000) continue;   // primeira leitura / coisa antiga: só registra
    const nome = c.nome ? `"${c.nome}"` : 'sua campanha';
    const env = c.st.enviado || 0, pul = c.st.pulado || 0, err = c.st.erro || 0, semWa = c.st.sem_whatsapp || 0;
    const partes = [`${env} enviada${env === 1 ? '' : 's'}`, pul ? `${pul} pulada${pul === 1 ? '' : 's'} (já tinha recebido)` : '', semWa ? `${semWa} sem WhatsApp` : '', err ? `${err} com erro` : ''].filter(Boolean).join(' · ');
    let txt = '';
    if (agora === 'fim') {
      let resp = '';
      try {
        if (c.phones.length) {
          const lista = c.phones.slice(0, 150).map(p => `"${p}"`).join(',');
          const r = await supa('GET', `leads?user_id=eq.${encodeURIComponent(PROSPECTA_USER_ID)}&phone=in.(${encodeURIComponent(lista)})&respondeu=eq.true&select=resposta_suspeita_bot`);
          const hum = (r || []).filter(x => !x.resposta_suspeita_bot).length, bot = (r || []).length - hum;
          resp = `\nRespostas até agora: ${hum} pessoa${hum === 1 ? '' : 's'}` + (bot ? ` (+${bot} automática${bot === 1 ? '' : 's'})` : '');
        }
      } catch (e) {}
      txt = `🏁 *Campanha finalizada* ${nome}\n${partes}\n${horaSP(c.ini)} → ${horaSP(c.fim)} (${duracaoTxt(new Date(c.fim) - new Date(c.ini))})${resp}`;
    } else if (agora === 'limite') txt = `⛔ *Limite diário atingido* em ${nome}\nAté agora: ${partes} (de ${c.total}). O resto continua sozinho no próximo dia, dentro do seu horário.`;
    else if (agora === 'cancelado') txt = `⏹ *Campanha cancelada* ${nome}\n${partes} de ${c.total}.`;
    else if (agora === 'erros') txt = `❌ *3 erros seguidos* em ${nome} (${c.idx.size} de ${c.total}).\nVale abrir o Prospecta+ e conferir a conexão do WhatsApp.`;
    await enviarAlerta(txt);
  }
  salvarAlertasEstado();
}

// Resumo do dia às 18h (horário de Brasília), só se teve movimento
async function resumoDoDia() {
  if (!SUPABASE_KEY || !PROSPECTA_USER_ID || !isConnected) return;
  const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const est = lerAlertasEstado();
  if (agora.getHours() !== 18 || est.resumo === diaSP()) return;
  est.resumo = diaSP(); salvarAlertasEstado();
  try {
    const iniDia = new Date(Date.now() - (agora.getHours() * 3600 + agora.getMinutes() * 60 + agora.getSeconds()) * 1000).toISOString();
    const uid = encodeURIComponent(PROSPECTA_USER_ID), q = encodeURIComponent(iniDia);
    const email = await emailDono();
    const [env, resp, sug, fu] = await Promise.all([
      email ? supa('GET', `status_campanha?user_email=eq.${encodeURIComponent(email)}&status=eq.enviado&created_at=gte.${q}&select=id`) : [],
      supa('GET', `leads?user_id=eq.${uid}&respondeu=eq.true&respondido_em=gte.${q}&select=resposta_suspeita_bot`),
      supa('GET', `fila_sugestoes?user_id=eq.${uid}&status=eq.pendente&select=id`),
      supa('GET', `fila_followups?user_id=eq.${uid}&status=eq.pendente&select=id`),
    ]);
    const nEnv = (env || []).length, hum = (resp || []).filter(x => !x.resposta_suspeita_bot).length, bot = (resp || []).length - hum;
    const nSug = (sug || []).length, nFu = (fu || []).length;
    if (!nEnv && !hum && !nSug && !nFu) return;
    const linhas = [`📊 *Resumo de hoje* (${diaSP().slice(0, 5)})`, `📨 ${nEnv} empresa${nEnv === 1 ? '' : 's'} contatada${nEnv === 1 ? '' : 's'}`, `💬 ${hum} pessoa${hum === 1 ? '' : 's'} respondeu${hum === 1 ? '' : 'ram'}` + (bot ? ` (+${bot} resposta${bot === 1 ? '' : 's'} automática${bot === 1 ? '' : 's'})` : '')];
    if (nSug) linhas.push(`📝 ${nSug} resposta${nSug === 1 ? '' : 's'} esperando você na aba Respostas`);
    if (nFu) linhas.push(`🔁 ${nFu} follow-up${nFu === 1 ? '' : 's'} para aprovar`);
    if (enviosHoje.dia === diaSP() && enviosHoje.n >= LIMITE_DIARIO_SERVIDOR * 0.8) linhas.push(`⚠️ O servidor usou ${enviosHoje.n} de ${LIMITE_DIARIO_SERVIDOR} mensagens do teto diário`);
    await enviarAlerta(linhas.join('\n'));
  } catch (e) { console.warn('[alertas] resumo do dia falhou:', e.message); }
}
const ALERTAS_INTERVALO_MS = parseInt(process.env.ALERTAS_INTERVALO_MS, 10) || 2 * 60 * 1000;
setInterval(() => { verificarCampanhas().catch(() => {}); resumoDoDia().catch(() => {}); }, ALERTAS_INTERVALO_MS).unref();
setTimeout(() => verificarCampanhas().catch(() => {}), Math.min(20000, ALERTAS_INTERVALO_MS)).unref();

// ---------- Proteção da conta (configurada em Integrações → 🛡️ Proteção da conta) ----------
const PROTECAO_PADRAO = { autoCancelar: true, umBalao: true, rampa: { ativo: false, auto: true, inicio: 10, passo: 5, desde: null }, freio: { ativo: true, naoEntregues: 4, janela: 10 } };
let _protecao = { v: null, em: 0 };
async function protecaoCfg(forcar) {
  if (!forcar && _protecao.v && Date.now() - _protecao.em < 2 * 60 * 1000) return _protecao.v;
  let p = null;
  try { const r = await supa('GET', `user_config?user_id=eq.${encodeURIComponent(PROSPECTA_USER_ID)}&select=protecao&limit=1`); p = r && r[0] && r[0].protecao; } catch (e) {}
  const v = Object.assign({}, PROTECAO_PADRAO, p || {});
  v.rampa = Object.assign({}, PROTECAO_PADRAO.rampa, (p && p.rampa) || {});
  v.freio = Object.assign({}, PROTECAO_PADRAO.freio, (p && p.freio) || {});
  _protecao = { v, em: Date.now() };
  return v;
}
async function salvarProtecao(mudar) {
  const v = JSON.parse(JSON.stringify(await protecaoCfg(true)));
  mudar(v);
  try { await supa('PATCH', `user_config?user_id=eq.${encodeURIComponent(PROSPECTA_USER_ID)}`, { protecao: v }, 'return=minimal'); _protecao = { v, em: Date.now() }; }
  catch (e) { console.warn('[proteção] não salvou:', e.message); }
}
const fim8 = t => String(t || '').replace(/\D/g, '').slice(-8);
// Campanhas em andamento (últimas 8h, sem cancelamento e sem terminar)
async function campanhasAtivas() {
  const email = await emailDono(); if (!email) return [];
  const desde = new Date(Date.now() - 8 * 3600 * 1000).toISOString();
  const linhas = await supa('GET', `status_campanha?user_email=eq.${encodeURIComponent(email)}&created_at=gte.${encodeURIComponent(desde)}&select=campanhaId,idx,total,status,phone,log,created_at&order=id.asc&limit=5000`);
  const c = {};
  (linhas || []).forEach(l => {
    const x = c[l.campanhaId] = c[l.campanhaId] || { id: l.campanhaId, total: 0, idx: new Set(), cancel: false, nome: '', ini: l.created_at, enviados: [] };
    x.total = Math.max(x.total, parseInt(l.total, 10) || 0);
    if (l.status === 'cancelado') x.cancel = true; else if (l.idx !== null && l.idx !== undefined) x.idx.add(String(l.idx));
    if (l.status === 'enviado' && l.phone) x.enviados.push({ phone: l.phone, em: l.created_at });
    const m = String(l.log || '').match(/\|\s*([^|]+)$/); if (m && !x.nome) x.nome = m[1].trim();
  });
  return Object.values(c).filter(x => !x.cancel && (!x.total || x.idx.size < x.total)).map(x => Object.assign(x, { email }));
}
async function cancelarCampanha(c, motivo) {
  await supa('POST', 'status_campanha', {
    campanhaId: c.id, status: 'cancelado', lead: 'CANCELAMENTO', user_email: c.email,
    log: `[CANCELADO] Campanha ${c.id} cancelada automaticamente: ${motivo}`,
    data: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
  }, 'return=minimal');
  const est = lerAlertasEstado(); est.campanhas[c.id] = 'cancelado'; salvarAlertasEstado();   // o aviso genérico de "cancelada" não repete
  console.log('[proteção] campanha cancelada automaticamente:', motivo);
}
// O WhatsApp derrubou o aparelho (restrição ou outro login): cancela o que estava rodando e liga o modo pós-restrição
async function protegerAposQueda() {
  if (!SUPABASE_KEY || !PROSPECTA_USER_ID) return;
  const p = await protecaoCfg(true);
  const partes = [];
  if (p.autoCancelar) {
    try {
      for (const c of await campanhasAtivas()) { await cancelarCampanha(c, 'o WhatsApp derrubou o aparelho'); partes.push(`⏹ Cancelei a campanha ${c.nome ? '"' + c.nome + '"' : ''} (${c.idx.size} de ${c.total} feitas) para ela não continuar quando você reconectar.`); }
    } catch (e) { console.warn('[proteção] não cancelou:', e.message); }
  }
  if (p.rampa.auto) {
    await salvarProtecao(v => { v.rampa.ativo = true; v.rampa.desde = new Date().toISOString(); });
    partes.push(`🐢 Modo pós-restrição ligado: as próximas campanhas começam com ${p.rampa.inicio} por dia e sobem ${p.rampa.passo} por dia até o seu limite.`);
  }
  if (partes.length) enviarAlerta(`⚠️ *O WhatsApp desconectou o servidor* (${horaSP(new Date().toISOString())}). Pode ser uma restrição da conta.\n` + partes.join('\n') + `\nDá para mudar isso em Integrações → 🛡️ Proteção da conta.`);
}
// Freio: muitas das últimas mensagens não chegaram (sinal de bloqueio/denúncia) → cancela a campanha
async function freioDeBloqueio() {
  if (!SUPABASE_KEY || !PROSPECTA_USER_ID || !isConnected) return;
  const p = await protecaoCfg();
  if (!p.freio.ativo) return;
  const limiteMs = Date.now() - 15 * 60 * 1000;
  for (const c of await campanhasAtivas().catch(() => [])) {
    const velhos = c.enviados.filter(e => new Date(e.em).getTime() < limiteMs).slice(-Math.max(3, p.freio.janela || 10));
    if (velhos.length < Math.max(3, p.freio.janela || 10)) continue;
    let ent = [];
    try { ent = await supa('GET', `entregas?user_id=eq.${encodeURIComponent(PROSPECTA_USER_ID)}&enviado_em=gte.${encodeURIComponent(c.ini)}&select=phone,status`) || []; } catch (e) { continue; }
    const chegou = new Set(ent.filter(x => Number(x.status) >= 3).map(x => fim8(x.phone)));
    const nao = velhos.filter(v => !chegou.has(fim8(v.phone))).length;
    if (nao >= (p.freio.naoEntregues || 4)) {
      await cancelarCampanha(c, `${nao} das últimas ${velhos.length} mensagens não chegaram`);
      await enviarAlerta(`🛑 *Freio de proteção acionado*${c.nome ? ' em "' + c.nome + '"' : ''}\n${nao} das últimas ${velhos.length} empresas não receberam a mensagem depois de 15 min (sinal de bloqueio ou de denúncia). Cancelei a campanha para proteger o número.\nVale esperar umas horas antes de mandar de novo.`);
    }
  }
}
setInterval(() => { freioDeBloqueio().catch(() => {}); }, ALERTAS_INTERVALO_MS).unref();

// Apaga a sessão salva (para conectar outro número ou depois de o WhatsApp deslogar este aparelho)
function limparSessao() {
  try {
    if (!fs.existsSync(AUTH_FOLDER)) return;
    for (const f of fs.readdirSync(AUTH_FOLDER)) fs.rmSync(path.join(AUTH_FOLDER, f), { recursive: true, force: true });
  } catch (e) { console.warn('[Baileys] não apagou a sessão:', e.message); }
}
function numeroConectado() {
  const id = String(sock?.user?.id || '');
  const d = id.split(':')[0].split('@')[0].replace(/\D/g, '');
  return d || null;
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

// Espera alguns segundos por uma reconexão rápida (quedas de 2–3s acontecem) antes de recusar o envio
async function aguardarConexao(ms) {
  const fim = Date.now() + ms;
  while (!isConnected && Date.now() < fim) await new Promise(r => setTimeout(r, 1000));
  return isConnected && !!sock;
}

// ---------- Trava de segurança: teto diário e intervalo mínimo ----------
let enviosHoje = { dia: '', n: 0 };
let ultimoEnvio = 0;
let filaEnvio = Promise.resolve();
function diaSP() { return new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }); }
function dentroDoTeto() {
  if (enviosHoje.dia !== diaSP()) enviosHoje = { dia: diaSP(), n: 0 };
  return enviosHoje.n < LIMITE_DIARIO_SERVIDOR;
}
// Um envio por vez, com intervalo mínimo entre eles (evita rajada se algo disparar em dobro)
function emFila(tarefa) {
  const proxima = filaEnvio.then(async () => {
    const espera = ultimoEnvio + INTERVALO_MINIMO_MS - Date.now();
    if (espera > 0) await new Promise(r => setTimeout(r, espera));
    try { return await tarefa(); } finally { ultimoEnvio = Date.now(); }
  });
  filaEnvio = proxima.catch(() => {});
  return proxima;
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
  if (enviosHoje.dia !== diaSP()) enviosHoje = { dia: diaSP(), n: 0 };
  res.json({
    connected: isConnected, qrPendente: !isConnected && !!latestQR, desde: estado.desde, motivo: estado.motivo,
    enviosHoje: enviosHoje.n, limiteDiarioServidor: LIMITE_DIARIO_SERVIDOR,
    numero: isConnected ? numeroConectado() : null, nome: isConnected ? (sock?.user?.name || sock?.user?.notify || null) : null,
  });
});

// Desconecta o WhatsApp deste servidor (para trocar de número). Em seguida aparece um QR novo.
let _saidaPedidaEm = 0;   // desconectar pelo app não é "queda": não cancela campanha nem liga a rampa
app.post('/logout', checkAuth, async (req, res) => {
  try {
    _saidaPedidaEm = Date.now();
    const era = numeroConectado();
    if (sock && isConnected) {
      try { await sock.logout(); } catch (e) { console.warn('[logout]', e.message); }
    } else {
      limparSessao();
      try { sock?.end?.(new Error('logout')); } catch (e) {}
      setTimeout(() => startSock().catch(() => {}), 1500);
    }
    console.log('[logout] WhatsApp desconectado pelo app' + (era ? ' (final ' + era.slice(-4) + ')' : ''));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Não consegui desconectar.' });
  }
});

// Aviso livre para o número de alerta (ex.: automações). Corpo: { texto }
// ---------- IA pelo servidor ----------
// O app do cliente não tem mais a chave da IA: pede o texto aqui e o servidor chama a OpenAI/Gemini
// com a chave que o administrador gravou no banco (user_config).
let _iaCfg = null, _iaCfgEm = 0;
async function iaConfig() {
  if (_iaCfg && Date.now() - _iaCfgEm < 60 * 1000) return _iaCfg;
  const rows = await supa('GET', `user_config?user_id=eq.${PROSPECTA_USER_ID}&select=ia_provider,openai_key,gemini_key`);
  _iaCfg = (Array.isArray(rows) && rows[0]) || {};
  _iaCfgEm = Date.now();
  return _iaCfg;
}
const _iaUso = [];   // horários das últimas chamadas (limite por minuto)
app.post('/ia', checkAuth, async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'Envie "prompt".' });
    if (prompt.length > 20000) return res.status(400).json({ error: 'Texto grande demais para a IA.' });
    const agora = Date.now();
    while (_iaUso.length && _iaUso[0] < agora - 60000) _iaUso.shift();
    if (_iaUso.length >= 60) return res.status(429).json({ error: 'Muitas chamadas de IA em um minuto. Espere um pouco.' });
    _iaUso.push(agora);
    if (!SUPABASE_KEY || !PROSPECTA_USER_ID) return res.status(503).json({ error: 'Servidor sem acesso ao banco.' });
    const cfg = await iaConfig();
    const pedido = req.body?.provider === 'gemini' || req.body?.provider === 'openai' ? req.body.provider : null;
    let provider = pedido || cfg.ia_provider || 'openai';
    if (provider === 'gemini' && !cfg.gemini_key && cfg.openai_key && !pedido) provider = 'openai';
    if (provider === 'openai' && !cfg.openai_key && cfg.gemini_key && !pedido) provider = 'gemini';
    const maxTokens = Math.min(2000, Math.max(50, parseInt(req.body?.max_tokens, 10) || 800));
    let texto = '';
    if (provider === 'gemini') {
      if (!cfg.gemini_key) return res.status(400).json({ error: 'IA (Gemini) não configurada. Fale com o administrador.' });
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(cfg.gemini_key)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
      });
      if (!r.ok) return res.status(502).json({ error: `Gemini ${r.status}`, detalhe: (await r.text().catch(() => '')).slice(0, 150) });
      const d = await r.json();
      texto = (d.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    } else {
      if (!cfg.openai_key) return res.status(400).json({ error: 'IA (OpenAI) não configurada. Fale com o administrador.' });
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.openai_key}` },
        body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!r.ok) return res.status(502).json({ error: `OpenAI ${r.status}`, detalhe: (await r.text().catch(() => '')).slice(0, 150) });
      const d = await r.json();
      texto = (d.choices?.[0]?.message?.content || '').trim();
    }
    res.json({ texto, provider });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Falha na IA.' });
  }
});

app.post('/alerta', checkAuth, async (req, res) => {
  const t = String(req.body?.texto || '').trim();
  if (!t) return res.status(400).json({ error: 'Envie "texto".' });
  const ok = await enviarAlerta(t.slice(0, 1500));
  res.json({ ok, guardado: !ok && !isConnected });
});

// Teste do alerta de lead quente: manda uma mensagem curta para o número de alerta (não conta como lead nem campanha)
app.post('/alerta-teste', checkAuth, async (req, res) => {
  try {
    const d = String(req.body?.numero || '').replace(/\D/g, '');
    if (d.length < 10 || d.length > 13) return res.status(400).json({ error: 'Número de alerta inválido.' });
    if (!(await aguardarConexao(10000))) return res.status(503).json({ error: 'WhatsApp não conectado.', codigo: 'desconectado' });
    const jid = toWhatsAppJid(d);
    guardarMensagem(await sock.sendMessage(jid, { text: '🔔 Teste do Prospecta+: é assim que você vai receber o aviso quando um lead responder com interesse.' }));   // não vira "resposta manual"
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Não consegui enviar o teste.' });
  }
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
// digitandoMs (opcional): mostra "digitando…" para o lead por esse tempo antes de enviar (máx. 20s)
app.post('/send-message', checkAuth, async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) {
      return res.status(400).json({ error: 'Envie "phone" e "message" no corpo da requisição.' });
    }
    const jid = toWhatsAppJid(phone);
    if (!jid) {
      return res.status(400).json({ error: 'Número de telefone inválido.' });
    }
    if (!(await aguardarConexao(15000))) {
      return res.status(503).json({ error: 'WhatsApp não conectado ainda. Acesse /qr para conectar.', codigo: 'desconectado' });
    }
    if (!dentroDoTeto()) {
      console.warn(`[trava] teto diário do servidor atingido (${LIMITE_DIARIO_SERVIDOR}) — envio recusado`);
      try { const e = lerAlertasEstado(); if (e.teto !== diaSP()) { e.teto = diaSP(); salvarAlertasEstado(); enviarAlerta(`🛑 *Teto de segurança do servidor atingido* (${LIMITE_DIARIO_SERVIDOR} mensagens hoje).\nNovos envios ficam travados até amanhã.`); } } catch (er) {}
      return res.status(429).json({ error: `Limite de segurança do servidor atingido (${LIMITE_DIARIO_SERVIDOR} mensagens hoje).`, codigo: 'teto_diario' });
    }

    // O número tem WhatsApp? E qual o LID dele (para reconhecer a resposta depois)?
    let contato;
    try {
      const r = await sock.onWhatsApp(jid);
      if (Array.isArray(r) && r.length === 0) {
        return res.status(404).json({ error: 'Este número não tem WhatsApp.', codigo: 'sem_whatsapp' });
      }
      contato = Array.isArray(r) ? r[0] : undefined;
      if (contato?.lid) {
        const lidDigits = String(contato.lid).split('@')[0].replace(/\D/g, '');
        const phoneDigits = String(phone).replace(/\D/g, '');
        salvarMapeamentoLid(lidDigits, phoneDigits); // fire-and-forget, não trava o envio
      }
    } catch (e) {
      console.warn('[send-message] não deu para conferir o número (envio segue normal):', e.message);
    }
    const destino = jid;

    const digitando = Math.max(0, Math.min(20000, parseInt(req.body.digitandoMs, 10) || 0));
    const enviada = await emFila(async () => {
      if (digitando) {
        try {
          await sock.presenceSubscribe(destino).catch(() => {});
          await sock.sendPresenceUpdate('composing', destino);
          await new Promise(r => setTimeout(r, digitando));
          await sock.sendPresenceUpdate('paused', destino);
        } catch (e) { /* "digitando" é enfeite: se falhar, envia assim mesmo */ }
      }
      const m = await sock.sendMessage(destino, { text: message });
      enviosHoje.n++;
      return m;
    });
    guardarMensagem(enviada);
    registrarEnvio(enviada, String(phone).replace(/\D/g, ''));
    res.json({ success: true, phone, jid: destino, id: enviada?.key?.id || null });
  } catch (err) {
    console.error('[send-message] erro:', err && err.message);
    res.status(500).json({ error: err.message || 'Erro ao enviar mensagem.' });
  }
});

// Envia qualquer tipo de mídia (documento, imagem, áudio, vídeo) — recebe o arquivo em base64
app.post('/send-document', checkAuth, async (req, res) => {
  try {
    const { phone, grupoId, base64, filename, caption, tipo, mimetype } = req.body;
    if ((!phone && !grupoId) || !base64) {
      return res.status(400).json({ error: 'Envie "phone" (ou "grupoId") e "base64" no corpo da requisição.' });
    }
    if (grupoId && !String(grupoId).endsWith('@g.us')) return res.status(400).json({ error: 'Grupo inválido.' });
    const jid = grupoId || toWhatsAppJid(phone);
    if (!jid) {
      return res.status(400).json({ error: 'Número de telefone inválido.' });
    }
    if (!(await aguardarConexao(15000))) {
      return res.status(503).json({ error: 'WhatsApp não conectado ainda. Acesse /qr para conectar.', codigo: 'desconectado' });
    }
    if (!dentroDoTeto()) {
      return res.status(429).json({ error: `Limite de segurança do servidor atingido (${LIMITE_DIARIO_SERVIDOR} mensagens hoje).`, codigo: 'teto_diario' });
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
      let ehOggOpus = (mimetype || '').includes('ogg');
      let audio = buffer, mime = mimetype || 'audio/mpeg';
      if (!ehOggOpus) {
        // Converte para ogg/opus: vira mensagem de voz de verdade e toca no iPhone
        try { audio = await paraOggOpus(buffer); mime = 'audio/ogg; codecs=opus'; ehOggOpus = true; }
        catch (e) { console.warn('[áudio] sem conversão, vai como arquivo:', e.message); }
      }
      payload = { audio, mimetype: mime, ptt: ehOggOpus };
    } else {
      payload = { document: buffer, fileName: filename || 'arquivo', mimetype: mimetype || 'application/octet-stream', caption: caption || '' };
    }

    const enviada = await emFila(async () => { const m = await sock.sendMessage(jid, payload); enviosHoje.n++; return m; });
    guardarMensagem(enviada);
    if (!grupoId) registrarEnvio(enviada, String(phone).replace(/\D/g, ''));
    res.json({ success: true, phone, jid });
  } catch (err) {
    console.error('[send-document] erro:', err && err.message);
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
    console.error('[check-number] erro:', err && err.message);
    res.status(500).json({ error: err.message || 'Erro ao verificar número.' });
  }
});

// Grupos em que este número participa. Não manda nada para ninguém: só lê.
app.get('/groups', checkAuth, async (req, res) => {
  try {
    if (!(await aguardarConexao(10000))) return res.status(503).json({ error: 'WhatsApp não conectado.', codigo: 'desconectado' });
    const todos = await sock.groupFetchAllParticipating();
    const meu = String(sock?.user?.id || '').split(':')[0].split('@')[0];
    const grupos = Object.values(todos || {}).map(g => {
      _nomesGrupos.set(g.id, g.subject || '');
      const parts = g.participants || [];
      const comNumero = parts.filter(p => { const t = telefoneDoParticipante(p); return t && t !== meu; }).length;
      const eu = parts.find(p => telefoneDoParticipante(p) === meu);
      return {
        id: g.id, nome: g.subject || '(sem nome)', participantes: g.size || parts.length, comNumero,
        souAdmin: !!(eu && eu.admin), soAdminsFalam: !!g.announce, comunidade: !!g.isCommunity,
      };
    }).sort((a, b) => b.comNumero - a.comNumero);
    res.json({ grupos });
  } catch (err) {
    console.error('[groups] erro:', err && err.message);
    res.status(500).json({ error: err.message || 'Erro ao listar grupos.' });
  }
});

app.get('/groups/:id/participants', checkAuth, async (req, res) => {
  try {
    if (!(await aguardarConexao(10000))) return res.status(503).json({ error: 'WhatsApp não conectado.', codigo: 'desconectado' });
    const id = String(req.params.id || '');
    if (!id.endsWith('@g.us')) return res.status(400).json({ error: 'Grupo inválido.' });
    const m = await sock.groupMetadata(id);
    _nomesGrupos.set(id, m.subject || '');
    const meu = String(sock?.user?.id || '').split(':')[0].split('@')[0];
    const vistos = new Set();
    const participantes = [];
    let escondidos = 0, admins = 0, souAdmin = false;
    for (const p of m.participants || []) {
      if (p.admin) admins++;
      const t = telefoneDoParticipante(p);
      if (t && t === meu) { souAdmin = !!p.admin; continue; }
      if (!t) { escondidos++; continue; }
      if (vistos.has(t)) continue;
      vistos.add(t);
      participantes.push({ phone: t, admin: !!p.admin, dono: p.admin === 'superadmin', nome: _nomesContatos.get(t) || null });
    }
    // Foto do grupo: opcional (grupo sem foto ou privacidade devolvem erro)
    let fotoUrl = null;
    if (req.query.foto !== '0') {
      try { fotoUrl = await Promise.race([sock.profilePictureUrl(id, 'image'), new Promise(r => setTimeout(() => r(null), 4000))]); } catch (e) { fotoUrl = null; }
    }
    res.json({
      id, nome: m.subject || '', participantes, escondidos,
      descricao: m.desc || '', criadoEm: m.creation ? Number(m.creation) * 1000 : null,
      dono: telefoneDoJid(m.ownerPn || m.owner || ''), total: m.size || (m.participants || []).length,
      admins, souAdmin, soAdminsFalam: !!m.announce, soAdminsEditam: !!m.restrict, fotoUrl,
    });
  } catch (err) {
    console.error('[groups/participants] erro:', err && err.message);
    res.status(500).json({ error: err.message || 'Erro ao ler o grupo.' });
  }
});

// Fotos de perfil: { ids: ["5511999998888", "1203...@g.us"] } -> { fotos: { id: url|null } } (até 60 por vez)
app.post('/fotos', checkAuth, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))].slice(0, 60) : [];
    if (!ids.length) return res.json({ fotos: {} });
    if (!(await aguardarConexao(5000))) return res.status(503).json({ error: 'WhatsApp não conectado.', codigo: 'desconectado' });
    const fotos = {};
    const fila = ids.slice();
    const trabalhar = async () => {
      while (fila.length) {
        const id = fila.shift();
        let jid = id;
        if (!id.endsWith('@g.us')) { const d = id.replace(/\D/g, ''); if (d.length < 10 || d.length > 13) { fotos[id] = null; continue; } jid = d + '@s.whatsapp.net'; }
        fotos[id] = await fotoDePerfil(jid);
      }
    };
    await Promise.all([trabalhar(), trabalhar(), trabalhar(), trabalhar()]);   // 4 de cada vez
    res.json({ fotos });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erro ao buscar fotos.' });
  }
});

// Envia texto para um grupo (respostas pelo Inbox)
app.post('/send-group', checkAuth, async (req, res) => {
  try {
    const { grupoId, message } = req.body || {};
    if (!grupoId || !String(grupoId).endsWith('@g.us') || !message) return res.status(400).json({ error: 'Envie "grupoId" (…@g.us) e "message".' });
    if (!(await aguardarConexao(15000))) return res.status(503).json({ error: 'WhatsApp não conectado.', codigo: 'desconectado' });
    if (!dentroDoTeto()) return res.status(429).json({ error: `Limite de segurança do servidor atingido (${LIMITE_DIARIO_SERVIDOR} mensagens hoje).`, codigo: 'teto_diario' });
    const enviada = await emFila(async () => { const m = await sock.sendMessage(grupoId, { text: message }); enviosHoje.n++; return m; });
    guardarMensagem(enviada);
    res.json({ success: true, id: enviada?.key?.id || null });
  } catch (err) {
    console.error('[send-group] erro:', err && err.message);
    res.status(500).json({ error: err.message || 'Erro ao enviar para o grupo.' });
  }
});

// ---------- Backup diário do banco (só no servidor com BACKUP_ATIVO=1) ----------
// Toda madrugada copia todas as tabelas + a lista de logins para o volume do Railway
// (fora do Supabase) e guarda os últimos 30 dias. O painel admin lista e baixa as cópias.
// Senhas dos logins não entram (o Supabase não entrega); fotos/áudios do Storage também não (só a lista).
const BACKUP_ATIVO = process.env.BACKUP_ATIVO === '1';
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || path.dirname(AUTH_FOLDER), 'backups');
const BACKUP_DIAS = parseInt(process.env.BACKUP_DIAS, 10) || 30;
const BACKUP_HORA = parseInt(process.env.BACKUP_HORA, 10) || 3;    // hora de Brasília
const zlib = require('zlib');
let _backupRodando = false, _backupUltimoErro = null;
function diaSP(d) { return new Date(d || Date.now()).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }); }   // 2026-10-16
async function tabelasDoBanco() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Accept: 'application/openapi+json' } });
  if (!r.ok) throw new Error('lista de tabelas ' + r.status);
  const api = await r.json();
  return Object.keys(api.definitions || {}).filter((t) => !/^v_/.test(t)).sort();   // v_… são visões (montadas a partir das tabelas)
}
async function lerTabelaToda(t) {
  const linhas = [];
  for (let de = 0; de < 2000000; de += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${encodeURIComponent(t)}?select=*`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Range-Unit': 'items', Range: `${de}-${de + 999}` } });
    if (!r.ok && r.status !== 206) throw new Error(`${t}: ${r.status}`);
    const lote = await r.json();
    linhas.push(...lote);
    if (lote.length < 1000) break;
  }
  return linhas;
}
async function fazerBackup(motivo) {
  if (_backupRodando) throw new Error('Já tem um backup rodando.');
  if (!SUPABASE_KEY) throw new Error('Servidor sem acesso ao banco.');
  _backupRodando = true;
  const inicio = Date.now();
  try {
    const tabelas = {}, contagem = {}, falhas = [];
    for (const t of await tabelasDoBanco()) {
      try { tabelas[t] = await lerTabelaToda(t); contagem[t] = tabelas[t].length; }
      catch (e) { falhas.push(t + ' (' + e.message + ')'); }
    }
    const usuarios = [];
    for (let pg = 1; pg <= 50; pg++) {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${pg}&per_page=200`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
      if (!r.ok) { falhas.push('logins (' + r.status + ')'); break; }
      const lote = ((await r.json()) || {}).users || [];
      usuarios.push(...lote.map((u) => ({ id: u.id, email: u.email, criado: u.created_at, ultimo_acesso: u.last_sign_in_at, metadados: u.user_metadata, bloqueado_ate: u.banned_until || null })));
      if (lote.length < 200) break;
    }
    let arquivos = [];
    try {
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/list/midias`, { method: 'POST', headers: supaHeaders(), body: JSON.stringify({ prefix: '', limit: 10000 }) });
      if (r.ok) arquivos = (await r.json()).map((x) => x.name);
    } catch (e) {}
    const dados = { versao: 1, projeto: SUPABASE_URL, criadoEm: new Date().toISOString(), motivo: motivo || 'diario', contagem, falhas, usuarios, pastasStorage: arquivos, tabelas };
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const nome = `backup-${diaSP()}.json.gz`;
    const tmp = path.join(BACKUP_DIR, nome + '.tmp');
    fs.writeFileSync(tmp, zlib.gzipSync(Buffer.from(JSON.stringify(dados))));
    fs.renameSync(tmp, path.join(BACKUP_DIR, nome));   // só aparece quando está completo
    // guarda só os últimos BACKUP_DIAS dias
    const todos = fs.readdirSync(BACKUP_DIR).filter((f) => /^backup-\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f)).sort();
    for (const velho of todos.slice(0, Math.max(0, todos.length - BACKUP_DIAS))) { try { fs.unlinkSync(path.join(BACKUP_DIR, velho)); } catch (e) {} }
    _backupUltimoErro = falhas.length ? falhas.join(', ') : null;
    console.log(`[backup] ${nome}: ${Object.keys(contagem).length} tabelas, ${usuarios.length} logins, ${Math.round((Date.now() - inicio) / 1000)}s` + (falhas.length ? ' · falhas: ' + falhas.join(', ') : ''));
    return { nome, tabelas: Object.keys(contagem).length, linhas: Object.values(contagem).reduce((a, b) => a + b, 0), logins: usuarios.length, falhas };
  } catch (e) {
    _backupUltimoErro = e.message;
    throw e;
  } finally { _backupRodando = false; }
}
function listarBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR).filter((f) => /^backup-\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f)).sort().reverse()
      .map((f) => { const st = fs.statSync(path.join(BACKUP_DIR, f)); return { nome: f, dia: f.slice(7, 17), bytes: st.size, criadoEm: st.mtime.toISOString() }; });
  } catch (e) { return []; }
}
// Confere a cada 10 min: passou da hora e ainda não tem o de hoje → faz. Falhou → avisa no número de alerta (1x por dia).
let _backupAvisoFalha = '';
async function verificarBackup() {
  if (!BACKUP_ATIVO || _backupRodando) return;
  const hora = parseInt(new Date().toLocaleTimeString('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }), 10);
  if (hora < BACKUP_HORA) return;
  if (listarBackups().some((b) => b.dia === diaSP())) return;
  try { await fazerBackup('diario'); }
  catch (e) {
    console.warn('[backup] falhou:', e.message);
    if (_backupAvisoFalha !== diaSP()) { _backupAvisoFalha = diaSP(); enviarAlerta(`⚠️ *Backup do banco falhou* hoje (${e.message}). Vou tentar de novo em 10 minutos.`); }
  }
}
if (BACKUP_ATIVO) { setTimeout(verificarBackup, 60 * 1000).unref(); setInterval(verificarBackup, 10 * 60 * 1000).unref(); }

function exigirBackup(req, res, next) { if (!BACKUP_ATIVO) return res.status(404).json({ error: 'Backup não está ligado neste servidor.' }); next(); }
app.get('/backups', checkAuth, exigirBackup, (req, res) => {
  res.json({ backups: listarBackups(), rodando: _backupRodando, ultimoErro: _backupUltimoErro, guardaDias: BACKUP_DIAS, hora: BACKUP_HORA });
});
app.post('/backups/agora', checkAuth, exigirBackup, async (req, res) => {
  try { res.json({ ok: true, ...(await fazerBackup('manual')) }); }
  catch (e) { res.status(e.message.startsWith('Já tem') ? 409 : 500).json({ error: e.message }); }
});
app.get('/backups/:nome', checkAuth, exigirBackup, (req, res) => {
  const nome = String(req.params.nome || '');
  if (!/^backup-\d{4}-\d{2}-\d{2}\.json\.gz$/.test(nome)) return res.status(400).json({ error: 'Nome inválido.' });
  const arq = path.join(BACKUP_DIR, nome);
  if (!fs.existsSync(arq)) return res.status(404).json({ error: 'Backup não encontrado.' });
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(arq).pipe(res);
});

app.get('/', (req, res) => {
  res.send('Servidor WhatsApp (Baileys) rodando. Acesse /qr para conectar.');
});

app.listen(PORT, () => {
  console.log(`[Baileys] Servidor rodando na porta ${PORT}`);
});
