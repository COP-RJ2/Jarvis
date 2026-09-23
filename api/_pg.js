/**
 * Leitura multi-SoC do Postgres do JARVIS (db.js) — espelha api/_google.js
 * (fetchTabByGid) só que pra Postgres, pra cada api/*.js migrar pelo MESMO
 * padrão em vez de reinventar como trata req.session.user.soc (pedido do
 * Roberto em 2026-09-21).
 *
 * Toda tabela de fato/de-para multi-SoC (ver db/schema_multi_soc.sql) tem
 * uma coluna `soc` — lerPorSoc sempre filtra por ela primeiro.
 */
const { pool } = require('../db');

// Allow-list explícita (mesmo padrão de segurança já usado em
// api/_google.js — renameTab/deleteTab "nunca aceita spreadsheetId
// arbitrário") — `tabela` nunca é interpolada sem passar por aqui, então
// não hà como uma chamada errada virar SQL injection.
const TABELAS_PERMITIDAS = new Set([
  'final_raw_data_lh',
  'inbound_lh_dados',
  'inbound_fm_dados',
  'inbound_fm_docas',
  'backlog_snapshots',
  'forecast_diario',
  'de_para_ruas',
  'de_para_esteiras',
  'de_para_labor_processos',
  'de_para_arvore_kpis',
  'socs',
]);
// Mesma ideia pros nomes de coluna usados em `filtros` — identificador
// simples, sem espaço/aspas/ponto e vírgula.
const IDENTIFICADOR_RE = /^[a-z_][a-z0-9_]*$/;

function validarTabela(tabela) {
  if (!TABELAS_PERMITIDAS.has(tabela)) {
    throw new Error(`lerPorSoc: tabela "${tabela}" não está na allow-list (TABELAS_PERMITIDAS em api/_pg.js)`);
  }
}
function validarIdentificador(nome) {
  if (!IDENTIFICADOR_RE.test(nome)) {
    throw new Error(`lerPorSoc: nome de coluna inválido "${nome}"`);
  }
}

// Lê todas as linhas de `tabela` pro `soc` dado, com filtros extras opcionais
// (igualdade simples, AND entre eles) — cobre o caso comum de cada api/*.js
// (ex: lerPorSoc('inbound_lh_dados', 'RJ2', { status: 'ABERTA' })).
// Devolve as linhas cruas do pg (mesmo shape de fetchTabByGid: array de
// objetos, chave = nome da coluna).
async function lerPorSoc(tabela, soc, filtros = {}) {
  validarTabela(tabela);
  const condicoes = ['soc = $1'];
  const valores = [soc];
  Object.entries(filtros).forEach(([campo, valor]) => {
    validarIdentificador(campo);
    valores.push(valor);
    condicoes.push(`${campo} = $${valores.length}`);
  });
  const { rows } = await pool.query(
    `SELECT * FROM ${tabela} WHERE ${condicoes.join(' AND ')}`,
    valores
  );
  return rows;
}

module.exports = { lerPorSoc, TABELAS_PERMITIDAS };
