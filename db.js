/**
 * Postgres do JARVIS (Railway) — pedido do Roberto em 2026-09-11: as abas
 * marcadas FLAG=SQL na aba `readme` (dimensão histórica, alimentada em lote
 * pelo Data Suite) passam a alimentar um banco de verdade, em vez de serem
 * lidas direto da planilha a cada request do dashboard.
 *
 * `DATABASE_URL` é injetada automaticamente pelo Railway quando um serviço
 * Postgres é anexado ao projeto — não precisa configurar nada manualmente
 * além de anexar o plugin (ver docs/deploy-railway.md).
 */
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

module.exports = { pool };
