/**
 * Login do JARVIS — 3 métodos, todos abrindo a mesma sessão de servidor
 * (express-session + Postgres, ver server.js):
 *
 *   1) "Login with SeaTalk" (pedido do Roberto em 2026-09-14) — ver
 *      api/_seatalk.js. Front-end redireciona pro SeaTalk, volta em
 *      GET /api/auth?seatalk_callback=1&code=...
 *
 *   2) E-mail + senha (pedido do Roberto em 2026-09-14, modelo portado do
 *      Sentinela CCO — ver docs/login-logic.md daquele projeto): senha
 *      validada no servidor contra a tabela `usuarios` do Postgres (hash
 *      scrypt, ver api/_auth.js). Diferença do original: aqui a sessão é
 *      real (cookie httpOnly no servidor), não localStorage — o JARVIS já
 *      tinha essa infra pronta da etapa do SeaTalk, então reaproveita.
 *      POST /api/auth?register=1  { nome, email, senha }
 *      POST /api/auth?login=1     { email, senha }
 *
 *   3) Verificação em duas etapas (código por DM) — CONSTRUÍDA mas pausada:
 *      as permissões de Bot/Employee da Open Platform do SeaTalk ficaram
 *      pendentes de aprovação de admin. Botão já existe no front, só avisa
 *      "em breve" por enquanto (ver index.html authTwoStepsEmBreve()).
 *
 *   POST /api/auth?logout=1  -> encerra sessão
 *   GET  /api/auth?me=1      -> sessão atual (ou null)
 */
const { pool } = require('../db');
const { emailPermitido, usuarioDoEmail } = require('./_users');
const { trocarCodePorEmployee } = require('./_seatalk');
const { hashPassword, verifyPassword } = require('./_auth');

async function garantirTabelaUsuarios() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id serial PRIMARY KEY,
      nome text NOT NULL,
      email text UNIQUE NOT NULL,
      senha_hash text NOT NULL,
      senha_salt text NOT NULL,
      papel text NOT NULL DEFAULT 'Demo',
      criado_em timestamptz NOT NULL DEFAULT now()
    );
  `);
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

async function handleRegister(req, res) {
  const nome = String((req.body || {}).nome || '').trim();
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const senha = String((req.body || {}).senha || '');

  if (!nome || !email || !senha) { res.status(400).json({ ok: false, erro: 'Nome, e-mail e senha são obrigatórios.' }); return; }
  if (senha.length < 6) { res.status(400).json({ ok: false, erro: 'A senha precisa ter pelo menos 6 caracteres.' }); return; }
  if (!emailPermitido(email)) { res.status(400).json({ ok: false, erro: 'Use um e-mail @shopee.com ou @shopeemobile-external.com.' }); return; }

  await garantirTabelaUsuarios();
  const existe = await pool.query('SELECT 1 FROM usuarios WHERE email = $1', [email]);
  if (existe.rows.length) { res.status(409).json({ ok: false, erro: 'Já existe uma conta com esse e-mail.' }); return; }

  const { hash, salt } = hashPassword(senha);
  const papel = usuarioDoEmail(email).role;
  await pool.query(
    'INSERT INTO usuarios (nome, email, senha_hash, senha_salt, papel) VALUES ($1,$2,$3,$4,$5)',
    [nome, email, hash, salt, papel]
  );

  const usuario = usuarioDoEmail(email);
  usuario.name = nome;
  req.session.user = usuario;
  res.status(200).json({ ok: true, user: usuario });
}

async function handleLogin(req, res) {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const senha = String((req.body || {}).senha || '');
  if (!email || !senha) { res.status(400).json({ ok: false, erro: 'E-mail e senha são obrigatórios.' }); return; }

  await garantirTabelaUsuarios();
  const { rows } = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
  const registro = rows[0];
  // Mensagem genérica de propósito (não revela se o e-mail existe ou não).
  if (!registro || !verifyPassword(senha, registro.senha_hash, registro.senha_salt)) {
    res.status(401).json({ ok: false, erro: 'E-mail ou senha incorretos.' });
    return;
  }

  const usuario = usuarioDoEmail(email);
  usuario.name = registro.nome;
  usuario.role = registro.papel || usuario.role;
  req.session.user = usuario;
  res.status(200).json({ ok: true, user: usuario });
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
    if (req.query.register !== undefined) {
      if (req.method !== 'POST') { res.status(405).json({ ok: false, erro: 'Use POST' }); return; }
      await handleRegister(req, res);
      return;
    }
    if (req.query.login !== undefined) {
      if (req.method !== 'POST') { res.status(405).json({ ok: false, erro: 'Use POST' }); return; }
      await handleLogin(req, res);
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
    res.status(400).json({ ok: false, erro: 'Use ?seatalk_callback=1, ?login=1, ?register=1, ?logout=1 ou ?me=1' });
  } catch (err) {
    console.error('[auth]', err);
    res.status(502).json({ ok: false, erro: err.message });
  }
};
