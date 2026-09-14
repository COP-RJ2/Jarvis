/**
 * Cliente do SeaTalk Open Platform — usado pro login do JARVIS via "Login
 * with SeaTalk" (pedido do Roberto em 2026-09-14; trocado do modelo
 * original de código por DM porque as permissões de Bot/Employee ficaram
 * pendentes de aprovação de admin, enquanto "Login with SeaTalk" já vem
 * habilitado por padrão no app).
 *
 * Confirmado via documentação oficial (Open Platform, "Implement Login
 * With SeaTalk") em 2026-09-14:
 *   - POST /auth/app_access_token  { app_id, app_secret } -> { app_access_token }
 *   - GET  /open_login/code2employee?code=...  (Bearer app_access_token)
 *     -> { code, employee: { employee_code, avatar, name, email, mobile } }
 *     `code` vem do redirect do botão "Login with SeaTalk" no front-end,
 *     expira em 10 minutos.
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

async function trocarCodePorEmployee(code) {
  const token = await getAppAccessToken();
  const r = await fetch(`${HOST}/open_login/code2employee?code=${encodeURIComponent(code)}`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  const body = await r.json();
  if (!r.ok || body.code) throw new Error('SeaTalk code2employee: ' + (body.message || r.status));
  return body.employee; // { employee_code, avatar, name, email, mobile }
}

module.exports = { getAppAccessToken, trocarCodePorEmployee };
