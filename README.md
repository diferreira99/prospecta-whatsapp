# Prospecta+ WhatsApp Server (Baileys, grátis)

Substitui o UAZAPI por uma conexão direta e gratuita com o WhatsApp.

## Deploy no Railway

1. Crie um repositório novo no GitHub com esses arquivos (ou use `railway up` via CLI a partir desta pasta).
2. No Railway: **New Project → Deploy from GitHub repo** (ou Empty Project + `railway up`).
3. Em **Variables**, adicione:
   - `API_TOKEN` = uma senha qualquer, ex: `prospecta-2024-xyz` (protege suas rotas)
4. Deploy automático (Railway detecta o Node pelo `package.json`).
5. Acesse `https://SEU-APP.up.railway.app/qr?token=SEU_TOKEN` e escaneie com o WhatsApp
   (celular → WhatsApp → Dispositivos Vinculados → Vincular dispositivo).
6. Pronto — quando aparecer "✅ Já está conectado", o servidor está pronto pra uso.

## ⚠️ Persistência da sessão

A pasta `auth_info/` guarda a sessão do WhatsApp. Se o Railway limpar o filesystem a cada deploy,
você precisa reconectar o QR toda vez. Para evitar isso:
- No Railway, adicione um **Volume** (Settings → Volumes) apontando para `/app/auth_info`.

## Endpoints

### Enviar mensagem
```
POST /send-message
Headers: x-api-token: SEU_TOKEN
Body: { "phone": "11999999999", "message": "Olá! Tudo bem?" }
```

### Verificar número
```
POST /check-number
Headers: x-api-token: SEU_TOKEN
Body: { "phone": "11999999999" }
```

### Status da conexão
```
GET /status?token=SEU_TOKEN
```

## Substituindo o UAZAPI no seu app / n8n

No seu `index.html` e no fluxo do n8n, troque:
- URL do UAZAPI (`https://testewhats.uazapi.com/...`) → `https://SEU-APP.up.railway.app/send-message`
- Token do UAZAPI → header `x-api-token: SEU_TOKEN`
- O corpo da requisição muda: UAZAPI usava `{ number, text }` (ou similar); este servidor usa `{ phone, message }`.

## Limites e avisos

- Isso usa o protocolo não-oficial do WhatsApp (mesma base do UAZAPI). Mantenha delays generosos
  entre mensagens (60–120s) para reduzir risco de bloqueio de número.
- Railway free tier dá créditos limitados por mês — acompanhe o consumo no painel.
