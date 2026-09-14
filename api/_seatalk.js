/**
 * Cliente do SeaTalk Open Platform — usado pro 2º fator de acesso do JARVIS
 * (pedido do Roberto em 2026-09-14: código de 6 dígitos mandado por DM do
 * bot, em vez de senha).
 *
 * Confirmado via documentação/SDKs públicos do SeaTalk Open API
 * (openapi.seatalk.io) em 2026-09-14:
 *   - POST /auth/app_access_token   { app_id, app_secret } -> { app_access_token }
 *   - POST /messaging/v2/single_chat { employee_code, message } (Bearer app_access_token)
 *     message = { tag: "text", text: { content } }
 *
 * ATENÇÃO — 1 ponto NÃO confirmado com certeza: o endpoint de resolver
 * employee_code a partir do e-mail. A Open Platform tem essa capacidade
 * (confirmado que existe), mas o path exato eu não consegui validar via
 * busca pública — só fica visível na documentação autenticada, depois que
 * o App for criado em open.seatalk.io. `resolverEmployeeCodePorEmail`
 * abaixo está com o path mais provável dado o padrão dos outros endpoints
 * (`/contacts/v1/...`); se não bater, é 1 linha pra ajustar assim que você
 * tiver acesso à doc de verdade — o resto do fluxo (token, envio de
 * mensagem, código de 6 dígitos) não depende disso mudar.
 */

const HOST = 'https://openapi.seatalk.io';

let _tokenCache = { token: null, expiraEm: 0 };

async function getAppAccessToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.expiraEm) return _tokenCache.token;

  const appId = process.env.SEATALK_APP_ID;
  const appSecret = process.env.SEATALK_APP_SECRET;
  if (!appId || !appSecret) throw new Error('SEATALK_APP_ID / SEATALK_APP_SECRET não configurados');

  const r = await fetch(`${HOST}/auth/app_access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const body = await r.json();
  if (!r.ok || body.code) throw new Error('SeaTalk auth: ' + (body.message || r.status));

  // token expira em 7200s — renova com folga (6900s) pra nunca usar vencido.
  _tokenCache = { token: body.app_access_token, expiraEm: Date.now() + 6900 * 1000 };
  return _tokenCache.token;
}

// Ver aviso no topo do arquivo — path a confirmar quando o App existir.
async function resolverEmployeeCodePorEmail(email) {
  const token = await getAppAccessToken();
  const r = await fetch(`${HOST}/contacts/v1/find_employee_by_email`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ emails: [email] }),
  });
  const body = await r.json();
  if (!r.ok || body.code) throw new Error('SeaTalk find_employee_by_email: ' + (body.message || r.status));
  const achado = (body.employees || body.results || []).find(e => e.email === email && e.exists !== false);
  return achado ? achado.employee_code : null;
}

async function enviarMensagemDireta(employeeCode, texto) {
  const token = await getAppAccessToken();
  const r = await fetch(`${HOST}/messaging/v2/single_chat`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      employee_code: employeeCode,
      message: { tag: 'text', text: { content: texto } },
    }),
  });
  const body = await r.json();
  if (!r.ok || body.code) throw new Error('SeaTalk single_chat: ' + (body.message || r.status));
  return body;
}

module.exports = { getAppAccessToken, resolverEmployeeCodePorEmail, enviarMensagemDireta };
