/**
 * Login do JARVIS — 2 métodos (pedido do Roberto em 2026-09-14), os dois
 * abrindo a mesma sessão de servidor (express-session + Postgres, ver
 * server.js):
 *
 *   1) E-mail + código por DM — 1º fator é o e-mail do domínio corporativo,
 *      2º fator é um código de 6 dígitos mandado por DM do bot do SeaTalk.
 *      Depende de permissão de Bot/Employee na Open Platform, pendente de
 *      aprovação de admin — enquanto não aprova, devolve erro 502.
 *        POST /api/auth?request=1  { email }        -> gera e envia o código
 *        POST /api/auth?verify=1   { email, code }  -> confere e abre sessão
 *
 *   2) "Login with SeaTalk" (QR Code) — já habilitado por padrão, não
 *      depende de aprovação nenhuma. Front-end redireciona pro SeaTalk,
 *      volta em:
 *        GET /api/auth?seatalk_callback=1&code=...&state=...
 *
 *   POST /api/auth?logout=1  -> encerra sessão
 *   GET  /api/auth?me=1      -> sessão atual (ou null)
 */
const { pool } = require('../db');
const { emailPermitido, usuarioDoEmail } = require('./_users');
const { resolverEmployeeCodePorEmail, enviarMensagemDireta, trocarCodePorEmployee } = require('./_seatalk');

const CODIGO_TTL_MIN = 5;
const MAX_TENTATIVAS = 5;

async function garantirTabelaCodigos() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_codes (
      email text PRIMARY KEY,
      code text NOT NULL,
      tentativas int NOT NULL DEFAULT 0,
      expira_em timestamptz NOT NULL,
      criado_em timestamptz NOT NULL DEFAULT now()
    );
  `);
}

function gerarCodigo() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 dígitos
}

async function handleRequest(req, res) {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!email || !emailPermitido(email)) {
    res.status(400).json({ ok: false, erro: 'Use um e-mail @shopee.com ou @shopeemobile-external.com.' });
    return;
  }

  await garantirTabelaCodigos();
  const code = gerarCodigo();
  const expiraEm = new Date(Date.now() + CODIGO_TTL_MIN * 60 * 1000);
  await pool.query(
    `INSERT INTO auth_codes (email, code, tentativas, expira_em) VALUES ($1,$2,0,$3)
     ON CONFLICT (email) DO UPDATE SET code=$2, tentativas=0, expira_em=$3, criado_em=now()`,
    [email, code, expiraEm]
  );

  try {
    const employeeCode = await resolverEmployeeCodePorEmail(email);
    if (!employeeCode) {
      res.status(404).json({ ok: false, erro: 'E-mail não encontrado no SeaTalk da organização.' });
      return;
    }
    await enviarMensagemDireta(employeeCode, `JARVIS — seu código de acesso é ${code}. Válido por ${CODIGO_TTL_MIN} minutos.`);
  } catch (err) {
    console.error('[auth] falha ao enviar via SeaTalk:', err.message);
    // Em desenvolvimento (sem credencial do SeaTalk configurada ainda),
    // devolve o código na própria resposta pra dar pra testar o fluxo
    // sem depender do bot já estar registrado — nunca em produção.
    if (process.env.NODE_ENV !== 'production') {
      res.status(200).json({ ok: true, aviso: 'SeaTalk indisponível — modo dev, código: ' + code });
      return;
    }
    res.status(502).json({ ok: false, erro: 'Não foi possível enviar o código pelo SeaTalk agora (permissão pendente de aprovação) — usa o QR Code por enquanto.' });
    return;
  }

  res.status(200).json({ ok: true });
}

async function handleVerify(req, res) {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const code = String((req.body || {}).code || '').trim();
  if (!email || !code) {
    res.status(400).json({ ok: false, erro: 'E-mail e código são obrigatórios.' });
    return;
  }

  await garantirTabelaCodigos();
  const { rows } = await pool.query('SELECT * FROM auth_codes WHERE email = $1', [email]);
  const registro = rows[0];
  if (!registro) {
    res.status(400).json({ ok: false, erro: 'Solicite um código novo.' });
    return;
  }
  if (new Date(registro.expira_em) < new Date()) {
    await pool.query('DELETE FROM auth_codes WHERE email = $1', [email]);
    res.status(400).json({ ok: false, erro: 'Código expirado — solicite um novo.' });
    return;
  }
  if (registro.tentativas >= MAX_TENTATIVAS) {
    await pool.query('DELETE FROM auth_codes WHERE email = $1', [email]);
    res.status(429).json({ ok: false, erro: 'Muitas tentativas — solicite um código novo.' });
    return;
  }
  if (registro.code !== code) {
    await pool.query('UPDATE auth_codes SET tentativas = tentativas + 1 WHERE email = $1', [email]);
    res.status(400).json({ ok: false, erro: 'Código incorreto.' });
    return;
  }

  await pool.query('DELETE FROM auth_codes WHERE email = $1', [email]);
  const user = usuarioDoEmail(email);
  req.session.user = user;
  res.status(200).json({ ok: true, user });
}

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
    if (req.query.request !== undefined) {
      if (req.method !== 'POST') { res.status(405).json({ ok: false, erro: 'Use POST' }); return; }
      await handleRequest(req, res);
      return;
    }
    if (req.query.verify !== undefined) {
      if (req.method !== 'POST') { res.status(405).json({ ok: false, erro: 'Use POST' }); return; }
      await handleVerify(req, res);
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
    res.status(400).json({ ok: false, erro: 'Use ?request=1, ?verify=1, ?seatalk_callback=1, ?logout=1 ou ?me=1' });
  } catch (err) {
    console.error('[auth]', err);
    res.status(502).json({ ok: false, erro: err.message });
  }
};
