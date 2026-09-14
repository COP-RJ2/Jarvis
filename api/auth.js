/**
 * Login do JARVIS via "Login with SeaTalk" (pedido do Roberto em
 * 2026-09-14; trocado do modelo original de código por DM — ver
 * api/_seatalk.js — porque as permissões de Bot/Employee ficaram pendentes
 * de aprovação de admin no SeaTalk, e essa capability já vem habilitada).
 *
 * Fluxo:
 *   Front-end renderiza o botão oficial do SeaTalk (JS deles), que manda o
 *   usuário pro SeaTalk pra autorizar e depois redireciona de volta pra:
 *
 *   GET /api/auth?seatalk_callback=1&code=...&state=...  -> troca o code
 *     pela identidade do funcionário, confere domínio, abre sessão e
 *     redireciona pra "/".
 *
 *   POST /api/auth?logout=1  -> encerra sessão
 *   GET  /api/auth?me=1      -> sessão atual (ou null)
 */
const { emailPermitido, usuarioDoEmail } = require('./_users');
const { trocarCodePorEmployee } = require('./_seatalk');

async function handleCallback(req, res) {
  const code = String(req.query.code || '').trim();
  if (!code) { res.redirect('/?erro=seatalk_sem_code'); return; }

  let employee;
  try {
    employee = await trocarCodePorEmployee(code);
  } catch (err) {
    console.error('[auth] falha ao trocar code por employee:', err.message);
    res.redirect('/?erro=seatalk_falhou');
    return;
  }

  const email = String((employee && employee.email) || '').trim().toLowerCase();
  if (!email || !emailPermitido(email)) {
    res.redirect('/?erro=dominio_nao_permitido');
    return;
  }

  const usuario = usuarioDoEmail(email);
  if (employee.name) usuario.name = employee.name;
  if (employee.avatar) usuario.avatar = employee.avatar;

  req.session.user = usuario;
  res.redirect('/');
}

module.exports = async (req, res) => {
  try {
    if (req.query.config !== undefined) {
      // App ID não é segredo (equivalente a um OAuth client_id) — só o App
      // Secret é sensível, e esse nunca sai do servidor.
      res.status(200).json({ ok: true, appId: process.env.SEATALK_APP_ID || null });
      return;
    }
    if (req.query.seatalk_callback !== undefined) {
      await handleCallback(req, res);
      return;
    }
    if (req.query.logout !== undefined) {
      req.session.destroy(() => {});
      res.status(200).json({ ok: true });
      return;
    }
    if (req.query.me !== undefined) {
      res.status(200).json({ ok: true, user: req.session.user || null });
      return;
    }
    res.status(400).json({ ok: false, erro: 'Use ?seatalk_callback=1, ?logout=1 ou ?me=1' });
  } catch (err) {
    console.error('[auth]', err);
    res.status(502).json({ ok: false, erro: err.message });
  }
};
