/**
 * Leitura das 6 tabelas "ao vivo" do Postgres-ontime (pedido do Roberto em
 * 2026-09-24/25) — espelha api/_pg.js (lerPorSoc), mas essas tabelas usam
 * `station_id` (numérico, texto) em vez de uma coluna `soc` — não são
 * multi-SoC no mesmo desenho do resto da base, são particionadas por
 * estação física. STATION_ID_POR_SOC faz a ponte.
 *
 * station_id -> soc não está documentado em nenhum lugar da base (nem do
 * outro pipeline) — mapeamento confirmado manualmente em 2026-09 (mesmo
 * usado nas tabelas export_* do pipeline Presto/Spark).
 */
const { pool } = require('../db-ontime');

const STATION_ID_POR_SOC = { RJ2: '8300', RJ6: '15660', SC1: '12158', SC2: '15308' };

// Allow-list explícita (mesmo padrão de segurança de api/_pg.js) — `tabela`
// nunca é interpolada sem passar por aqui.
const TABELAS_PERMITIDAS = new Set([
  'conveyor',
  'outbound_monitor',
  'fmbeep',
  'dock',
  'dock_queue',
  'to_outbound',
]);

// SoC sem station_id mapeado (não deveria acontecer, os 4 SoCs válidos têm
// station_id) ou sem linha ainda na tabela -> array vazio, nunca erro (SoC
// sem dado ainda é um estado válido, não uma falha).
async function lerPorStationId(tabela, soc) {
  if (!TABELAS_PERMITIDAS.has(tabela)) {
    throw new Error(`lerPorStationId: tabela "${tabela}" não está na allow-list (TABELAS_PERMITIDAS em api/_pg_ontime.js)`);
  }
  const stationId = STATION_ID_POR_SOC[soc];
  if (!stationId) return [];
  const { rows } = await pool.query(
    `SELECT * FROM public.${tabela} WHERE station_id = $1`,
    [stationId]
  );
  return rows;
}

module.exports = { lerPorStationId, STATION_ID_POR_SOC, TABELAS_PERMITIDAS };
