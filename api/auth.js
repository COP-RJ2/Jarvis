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
 *      A mesma DM também traz um LINK mágico (pedido do Roberto em
 *      2026-09-22 — no mobile, dentro do Workspace da SeaTalk, digitar o
 *      código exige sair e voltar pra copiar; tocar um link numa DM é uma
 *      ação normal de chat, sem esse vai-e-volta). Token de uso único,
 *      mesmo TTL do código:
 *        GET /api/auth?magic=1&token=...  -> confere e abre sessão, redireciona pra "/"
 *
 *   2) "Login with SeaTalk" (QR Code) — já habilitado por padrão, não
 *      depende de aprovação nenhuma. Front-end redireciona pro SeaTalk,
 *      volta em:
 *        GET /api/auth?seatalk_callback=1&code=...&state=...
 *
 *   POST /api/auth?logout=1  -> encerra sessão
 *   GET  /api/auth?me=1      -> sessão atual (ou null)
 *
 *   GET  /api/auth?socs=1        -> lista de SoCs disponíveis
 *   POST /api/auth?soc=1 {soc}   -> escolhe o SoC da sessão atual (pedido do
 *      Roberto em 2026-09-21) — roda DEPOIS da sessão já aberta pelos 2
 *      métodos acima; o front mostra essa escolha antes de entrar no portal
 *      quando `user.soc` vem nulo.
 *
 * Nos dois métodos, depois da sessão aberta o bot manda uma DM de
 * confirmação "Login bem-sucedido às HH:MM" (pedido do Roberto em
 * 2026-09-15) — sem bloquear a resposta, ver notificarLoginSucesso().
 */
const crypto = require('crypto');
const { pool } = require('../db');
const { emailPermitido, usuarioDoEmail, nomeDoEmail, buscarWorkLocation, SOCS } = require('./_users');
const { resolverEmployeeCodePorEmail, enviarMensagemDireta, trocarCodePorEmployee, buscarWorkLocationSeaTalk } = require('./_seatalk');

// Work location: tenta primeiro o perfil oficial da SeaTalk (custom field
// "Work Location" — precisa da permissão "Get Contact Profile" aprovada no
// console, ainda não confirmado); se falhar por qualquer motivo (permissão
// pendente, employee_code ausente, etc.), cai pro de-para manual da tabela
// de_para_work_locations. Nunca deixa o login quebrar por causa disso.
async function resolverWorkLocation(employeeCode, email) {
  if (employeeCode) {
    try {
      const wl = await buscarWorkLocationSeaTalk(employeeCode);
      if (wl) return wl;
    } catch (err) {
      console.warn('[auth] work location via SeaTalk falhou, caindo pro fallback:', err.message);
    }
  }
  return buscarWorkLocation(email).catch(() => null);
}

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

// Link mágico (ver comentário no topo do arquivo) — token separado da
// tabela de código porque é de uso único por token (não por e-mail: nada
// impede pedir 2 códigos seguidos e cada DM ter seu próprio link válido).
async function garantirTabelaMagicLinks() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_magic_links (
      token text PRIMARY KEY,
      email text NOT NULL,
      expira_em timestamptz NOT NULL,
      criado_em timestamptz NOT NULL DEFAULT now()
    );
  `);
}

function gerarCodigo() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 dígitos
}

function gerarMagicToken() {
  return crypto.randomBytes(24).toString('hex'); // 48 chars hex, não-adivinhável
}

function horaAgora() {
  return new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
}

// Confirmação de login por DM (pedido do Roberto em 2026-09-15, mensagem
// personalizada pedida em 2026-09-16) — dispara depois da sessão já aberta,
// sem bloquear a resposta/redirect: se o SeaTalk falhar aqui, o login em si
// já aconteceu, só não chega o aviso.
function notificarLoginSucesso(employeeCode, nome, workLocation) {
  if (!employeeCode) return;
  const destino = 'Jarvis' + (workLocation ? ' - ' + workLocation : '');
  enviarMensagemDireta(employeeCode, `Olá ${nome}, login bem-sucedido ao ${destino} às ${horaAgora()}.`)
    .catch(err => console.error('[auth] falha ao notificar login via SeaTalk:', err.message));
}

async function handleRequest(req, res) {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!email || !emailPermitido(email)) {
    res.status(400).json({ ok: false, erro: 'Use um e-mail @shopee.com ou @shopeemobile-external.com.' });
    return;
  }

  await garantirTabelaCodigos();
  await garantirTabelaMagicLinks();
  const code = gerarCodigo();
  const expiraEm = new Date(Date.now() + CODIGO_TTL_MIN * 60 * 1000);
  await pool.query(
    `INSERT INTO auth_codes (email, code, tentativas, expira_em) VALUES ($1,$2,0,$3)
     ON CONFLICT (email) DO UPDATE SET code=$2, tentativas=0, expira_em=$3, criado_em=now()`,
    [email, code, expiraEm]
  );
  const magicToken = gerarMagicToken();
  await pool.query(
    `INSERT INTO auth_magic_links (token, email, expira_em) VALUES ($1,$2,$3)`,
    [magicToken, email, expiraEm]
  );
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const magicUrl = `${proto}://${req.headers.host}/api/auth?magic=1&token=${magicToken}`;

  try {
    const employeeCode = await resolverEmployeeCodePorEmail(email);
    if (!employeeCode) {
      res.status(404).json({ ok: false, erro: 'E-mail não encontrado no SeaTalk da organização.' });
      return;
    }
    // Mensagem personalizada (pedido do Roberto em 2026-09-16) — mesmo
    // padrão de saudação + work location da confirmação de login, ver
    // notificarLoginSucesso. Link mágico (pedido do Roberto em 2026-09-22)
    // junto do código — no mobile, tocar o link evita digitar/trocar de tela.
    const nome = nomeDoEmail(email);
    const workLocation = await resolverWorkLocation(employeeCode, email);
    const destino = 'Jarvis' + (workLocation ? ' - ' + workLocation : '');
    await enviarMensagemDireta(employeeCode,
      `Olá ${nome}, aqui está seu acesso ao ${destino} (válido por ${CODIGO_TTL_MIN} minutos):\n\n` +
      `Toque pra entrar direto: ${magicUrl}\n\n` +
      `Ou digite o código na tela: ${code}`);
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

// Abre a sessão de servidor a partir de um e-mail já confirmado (código OU
// link mágico já validados por quem chama) — extraído pra não duplicar entre
// handleVerify e handleMagic. Não envia a resposta nem a notificação de
// sucesso: quem chama decide (JSON pro código, redirect pro link mágico).
async function abrirSessaoPorEmail(req, email) {
  const employeeCode = await resolverEmployeeCodePorEmail(email).catch(() => null);
  const user = usuarioDoEmail(email);
  user.workLocation = await resolverWorkLocation(employeeCode, email);
  // SoC ainda não escolhido (pedido do Roberto em 2026-09-21) — o front
  // mostra a tela de seleção antes de entrar no portal quando isso vem nulo.
  user.soc = null;
  req.session.user = user;
  return { user, employeeCode };
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
  const { user, employeeCode } = await abrirSessaoPorEmail(req, email);
  res.status(200).json({ ok: true, user });

  notificarLoginSucesso(employeeCode, user.name, user.workLocation);
}

// Link mágico (ver comentário no topo do arquivo) — token de uso único,
// mesma validação de expiração do código. GET (não POST) porque é aberto
// direto de um link tocado na DM, não de um form submetido pelo front.
async function handleMagic(req, res) {
  const token = String(req.query.token || '').trim();
  if (!token) { res.redirect('/?erro=magic_sem_token'); return; }

  await garantirTabelaMagicLinks();
  const { rows } = await pool.query('SELECT * FROM auth_magic_links WHERE token = $1', [token]);
  const registro = rows[0];
  if (!registro) { res.redirect('/?erro=magic_invalido'); return; }
  // Apaga já na conferência (uso único, mesmo se expirado) — evita reuso do
  // mesmo link mesmo que alguém tente de novo com o link expirado.
  await pool.query('DELETE FROM auth_magic_links WHERE token = $1', [token]);
  if (new Date(registro.expira_em) < new Date()) { res.redirect('/?erro=magic_expirado'); return; }

  const { user, employeeCode } = await abrirSessaoPorEmail(req, registro.email);
  res.redirect('/');

  notificarLoginSucesso(employeeCode, user.name, user.workLocation);
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
  // Work location (pedido do Roberto em 2026-09-15): o code2employee em si
  // não traz isso, mas dá pra buscar via GET /contacts/v2/profile usando o
  // employee_code que acabamos de receber — ver resolverWorkLocation.
  usuario.workLocation = await resolverWorkLocation(employee.employee_code, email);
  usuario.soc = null;

  req.session.user = usuario;
  res.redirect('/');

  notificarLoginSucesso(employee.employee_code, usuario.name, usuario.workLocation);
}

// Escolha de SoC pós-login (pedido do Roberto em 2026-09-21): a pessoa
// autentica normal (DM ou QR) e só depois escolhe qual SoC quer ver, dentro
// do próprio JARVIS — sem depender de mensagem interativa da SeaTalk (exigiria
// permissão nova + webhook de callback que o app não tem hoje).
function handleSocs(req, res) {
  res.status(200).json({ ok: true, socs: SOCS });
}

function handleEscolherSoc(req, res) {
  if (!req.session.user) { res.status(401).json({ ok: false, erro: 'Não autenticado.' }); return; }
  const soc = String((req.body || {}).soc || '').trim().toUpperCase();
  if (!SOCS.some(s => s.soc === soc)) {
    res.status(400).json({ ok: false, erro: 'SoC inválido.' });
    return;
  }
  req.session.user.soc = soc;
  res.status(200).json({ ok: true, user: req.session.user });
}

module.exports = async (req, res) => {
  try {
    if (req.query.socs !== undefined) {
      if (req.method !== 'GET') { res.status(405).json({ ok: false, erro: 'Use GET' }); return; }
      handleSocs(req, res);
      return;
    }
    if (req.query.soc !== undefined) {
      if (req.method !== 'POST') { res.status(405).json({ ok: false, erro: 'Use POST' }); return; }
      handleEscolherSoc(req, res);
      return;
    }
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
    if (req.query.magic !== undefined) {
      await handleMagic(req, res);
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
