/**
 * Cliente do SeaTalk Open Platform — o JARVIS usa dois métodos de login
 * (pedido do Roberto em 2026-09-14), os dois via esse mesmo App:
 *
 *   1) E-mail + código por DM: 1º fator é o e-mail do domínio corporativo,
 *      2º fator é um código de 6 dígitos mandado por DM do bot. Depende de
 *      permissão de Bot/Employee na Open Platform, pendente de aprovação de
 *      admin — enquanto não aprova, resolverEmployeeCodePorEmail/
 *      enviarMensagemDireta devolvem erro "permission denied".
 *   2) "Login with SeaTalk" (QR Code): já habilitado por padrão, não
 *      depende de aprovação — troca um `code` de redirect pela identidade.
 *
 * Confirmado via documentação oficial da Open Platform em 2026-09-14:
 *   - POST /auth/app_access_token   { app_id, app_secret } -> { app_access_token }
 *   - POST /contacts/v2/get_employee_code_with_email { emails: string[] }
 *     -> { code, employees: [{ code, email, employee_code, employee_status }] }
 *     employee_status: 1 pending, 2 in position, 3 leaving, 4 terminated —
 *     um e-mail pode ter vários registros (histórico de status), por isso
 *     filtra por status=2.
 *   - POST /messaging/v2/single_chat { employee_code, message } (Bearer app_access_token)
 *     message = { tag: "text", text: { content } }
 *   - GET  /open_login/code2employee?code=...  (Bearer app_access_token)
 *     -> { code, employee: { employee_code, avatar, name, email, mobile } }
 *   - GET  /contacts/v2/profile?employee_code=...  (Bearer app_access_token,
 *     1+ employee_code repetido na query, até 500) -> { code, employees:
 *     [{ employee_code, name, email, departments, custom_fields: [{name,
 *     type, value}], ... }] } — confirmado com o Roberto em 2026-09-15 via
 *     doc oficial ("Get Employee Profile"). Requer a permissão "Get Contact
 *     Profile" (+ Data Scope) aprovada no console — ainda não confirmado se
 *     já está liberada; ver buscarWorkLocationSeaTalk.
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

async function resolverEmployeeCodePorEmail(email) {
  const token = await getAppAccessToken();
  const r = await fetch(`${HOST}/contacts/v2/get_employee_code_with_email`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ emails: [email] }),
  });
  const body = await r.json();
  if (!r.ok || body.code) throw new Error('SeaTalk get_employee_code_with_email: ' + (body.message || r.status));

  const achado = (body.employees || []).find(e => e.email === email && e.code === 0 && e.employee_status === 2);
  if (!achado) console.warn('[seatalk] employee não encontrado (ou não "in position"), resposta crua:', JSON.stringify(body));
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

// Work location vem como um custom_field do perfil (não um campo fixo) —
// procura pelo nome exato "Work Location" (confirmado no exemplo oficial da
// doc) e devolve o `value`. null se o employee não tiver esse custom field
// preenchido, ou se a permissão "Get Contact Profile" ainda não tiver sido
// aprovada (deixa o chamador cair pro fallback da tabela work_locations).
async function buscarWorkLocationSeaTalk(employeeCode) {
  const token = await getAppAccessToken();
  const r = await fetch(`${HOST}/contacts/v2/profile?employee_code=${encodeURIComponent(employeeCode)}`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  const body = await r.json();
  if (!r.ok || body.code) throw new Error('SeaTalk profile: ' + (body.message || r.status));

  const employee = (body.employees || [])[0];
  const campo = employee && (employee.custom_fields || []).find(f => f.name === 'Work Location');
  return (campo && campo.value) || null;
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

module.exports = { getAppAccessToken, resolverEmployeeCodePorEmail, enviarMensagemDireta, trocarCodePorEmployee, buscarWorkLocationSeaTalk };
