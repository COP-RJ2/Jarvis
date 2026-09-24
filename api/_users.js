/**
 * Identidade de quem loga no JARVIS (pedido do Roberto em 2026-09-14, parte
 * da verificação em 2 etapas via SeaTalk): 1º fator deixou de ser uma lista
 * fixa de e-mails com senha — agora é "qualquer e-mail do domínio
 * corporativo", então não faz sentido manter ~70 linhas hardcoded só pra
 * nome/perfil. Nome vem do próprio e-mail (mesmo padrão "nome.sobrenome" já
 * usado em toda a base).
 *
 * Papel (pedido do Roberto em 2026-09-15): não existe mais distinção de
 * papel por login — todo mundo que entra (já filtrado por domínio
 * corporativo acima) recebe o mesmo acesso completo. O controle de verdade
 * passou a ser só quem tem acesso ao repositório no GitHub (quem pode
 * mudar o código), não mais um "Demo" restrito dentro do próprio app.
 *
 * Work location (pedido do Roberto em 2026-09-15): a API da SeaTalk não
 * devolve isso em nenhum endpoint disponível no app (confirmado ao vivo —
 * o code2employee só traz employee_code/email/mobile/name/avatar, e não
 * existe doc de leitura pro custom field "Work Location"). Em vez de
 * depender da SeaTalk, guarda o de-para e-mail→work location numa tabela
 * própria no Postgres (de_para_work_locations, nome ajustado em 2026-09-16
 * pra ficar no mesmo padrão de identificação dos outros de-para), mantida
 * à mão — sem regra de acesso associada ainda (só captura o dado por
 * enquanto, pra usar depois).
 */
const { pool } = require('../db');

const DOMINIOS_PERMITIDOS = ['@shopee.com', '@shopeemobile-external.com'];

// SoC que a pessoa escolhe depois do login (pedido do Roberto em
// 2026-09-21) — lista fixa por enquanto, sem regra de acesso por work
// location ainda (nenhum de-para work_location->soc existe hoje). Hoje só
// o SoC RJ2 tem dado de verdade por trás (todo o resto do backend ainda lê
// a planilha/Postgres fixos em RJ2) — os outros aparecem como opção mas
// caem no mesmo "Em Construção" que outras páginas já usam.
const SOCS = [
  { soc: 'RJ2', nome: 'RJ2' },
  { soc: 'RJ6', nome: 'RJ6' },
  { soc: 'SC1', nome: 'SC1' },
  { soc: 'SC2', nome: 'SC2' },
];
const SOCS_VALIDOS = new Set(SOCS.map(s => s.soc));

// Normaliza um código de SoC vindo de QUALQUER lugar que não seja a própria
// sessão do JARVIS (pedido do Roberto em 2026-09-24: "SOC-SC1" e "SC1" são
// a mesma coisa, o prefixo "SOC-" é só a convenção usada por algumas
// integrações externas — ex. as tabelas export_* do pipeline Presto/Spark
// e os jobs Pulse por SoC). Única função canônica pra isso — antes cada
// arquivo resolvia essa dualidade do seu próprio jeito (ver SOCS_VALIDOS
// short->long em api/controle.js, criado antes desta função existir, e o
// normalizarSoc que tinha virado uma cópia local em api/ingest.js), o que é
// exatamente o tipo de duplicação que já causou bug real nesta base (linhas
// espúrias "SOC-RJ6"/"SOC-SC1" na tabela `socs`, limpas em 2026-09-22).
// Aceita minúsculo/maiúsculo e com ou sem o prefixo; devolve null se não
// bater com nenhum SoC conhecido.
function normalizarSoc(v) {
  const s = String(v || '').trim().toUpperCase().replace(/^SOC-/, '');
  return SOCS_VALIDOS.has(s) ? s : null;
}

// Resolve o SoC da sessão de forma explícita (pedido do Roberto em
// 2026-09-22, achado na varredura multi-SoC) — até aqui, todo endpoint que
// precisava do SoC usava `(req.session.user && req.session.user.soc) ||
// 'RJ2'`, um fallback silencioso pensado só pra sessão antiga (de antes da
// escolha de SoC existir, 2026-09-21). Isso era intencional então, mas vira
// perigoso assim que RJ6/SC1/SC2 tiverem dado de verdade: uma sessão
// quebrada (soc nulo/inválido por qualquer motivo) passaria a misturar
// silenciosamente dado de outro usuário com o de RJ2, sem nenhum sinal de
// erro. Esta função escreve a resposta de erro ela mesma e devolve null —
// o chamador só precisa `if (!soc) return;`.
function socDaSessaoOuErro(req, res) {
  const soc = req.session.user && req.session.user.soc;
  if (soc && SOCS_VALIDOS.has(soc)) return soc;
  res.status(401).json({
    ok: false,
    erro: 'Sessão sem SoC válido — faça login novamente e escolha o SoC.',
    socInvalido: true,
  });
  return null;
}

async function garantirTabelaWorkLocations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS de_para_work_locations (
      email text PRIMARY KEY,
      nome text,
      work_location text NOT NULL,
      atualizado_em timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function buscarWorkLocation(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  await garantirTabelaWorkLocations();
  const { rows } = await pool.query('SELECT work_location FROM de_para_work_locations WHERE email = $1', [e]);
  return rows[0] ? rows[0].work_location : null;
}

function emailPermitido(email) {
  const e = String(email || '').trim().toLowerCase();
  return DOMINIOS_PERMITIDOS.some(d => e.endsWith(d));
}

// "roberto.barboza@shopee.com" -> "Roberto Barboza" (mesmo padrão nome.sobrenome
// de todo o resto da base de usuários).
function nomeDoEmail(email) {
  const local = String(email).split('@')[0];
  return local.split('.').filter(Boolean)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(' ') || local;
}

function usuarioDoEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  const nome = nomeDoEmail(e);
  const iniciais = nome.split(' ').filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join('');
  return {
    email: e,
    name: nome,
    initials: iniciais,
    role: 'Administrador',
  };
}

module.exports = { emailPermitido, nomeDoEmail, usuarioDoEmail, buscarWorkLocation, DOMINIOS_PERMITIDOS, SOCS, SOCS_VALIDOS, socDaSessaoOuErro, normalizarSoc };
