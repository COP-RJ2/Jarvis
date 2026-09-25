/**
 * Segundo Postgres do JARVIS (Railway) — "Postgres-ontime" (pedido do
 * Roberto em 2026-09-24/25). Diferente do db.js (DATABASE_URL, dado
 * histórico/de-para do próprio JARVIS), esse banco é alimentado por um
 * processo externo (colaborador de outra frente), com 6 tabelas ao vivo
 * particionadas por `station_id` (não por `soc` — ver api/_pg_ontime.js).
 *
 * DATABASE_ONTIME_URL referencia o serviço Postgres-ontime via rede
 * privada do Railway (configurado direto no dashboard/CLI do projeto,
 * não em código).
 */
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_ONTIME_URL,
  ssl: { rejectUnauthorized: false },
  max: 5, // só leitura, tráfego bem mais baixo que o Postgres principal
});

module.exports = { pool };
