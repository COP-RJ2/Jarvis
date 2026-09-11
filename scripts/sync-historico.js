/**
 * Sync Sheets -> Postgres das abas de dimensão HISTÓRICA (FLAG=SQL na aba
 * `readme` de governança — pedido do Roberto em 2026-09-11: só o que é
 * alimentado em lote pelo Data Suite, não as abas PYTHON/on-time nem as
 * INPUT/manuais).
 *
 * Estratégia: full refresh por tabela, dentro de uma transação (TRUNCATE +
 * INSERT tudo de novo). Nada de upsert por chave natural — essas 10 abas
 * têm formatos diferentes entre si e o Data Suite já reescreve a origem em
 * lote, então "trocar a foto inteira" a cada ciclo é mais simples e mais
 * robusto do que rastrear chave/diff por aba. Cada linha vira 1 registro
 * JSONB (`data`) — sem schema fixo por coluna, então uma coluna nova na
 * planilha não quebra o sync; quem lê depois decide o que tipar.
 *
 * Rodar sob demanda: `node scripts/sync-historico.js`
 * Rodar agendado: Railway Cron Job apontando pra esse comando (ver
 * docs/deploy-railway.md).
 */
const { fetchTabByGid } = require('../api/_google');
const { pool } = require('../db');

const SPREADSHEET_ID = '1BqZElDRwVaGpDYZzHTq9UQvVLy2guRVfTdvwGHL1qC4';

// gid + tabela de destino — extraído da aba `readme`, FLAG=SQL, em
// 2026-09-11. Se uma aba nova virar SQL/histórico no readme, adiciona aqui.
const FONTES = [
  { gid: '1276487267', tabela: 'hist_spr' },
  { gid: '352174025', tabela: 'hist_leftover_hub' },
  { gid: '0', tabela: 'hist_rawdata_out' },
  { gid: '960444672', tabela: 'hist_balanceamento' },
  { gid: '202012183', tabela: 'hist_forecast_backlog' },
  { gid: '1485919739', tabela: 'hist_inbound_lh' },
  { gid: '1711953035', tabela: 'hist_triagem' },
  { gid: '743265268', tabela: 'hist_performance' },
  { gid: '1776828985', tabela: 'hist_asm' },
  { gid: '1026737209', tabela: 'hist_inbound_fm' },
];

async function garantirTabelas(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS sync_log (
      id serial PRIMARY KEY,
      tabela text NOT NULL,
      linhas int NOT NULL,
      ok boolean NOT NULL,
      erro text,
      iniciado_em timestamptz NOT NULL,
      concluido_em timestamptz NOT NULL DEFAULT now()
    );
  `);
  for (const { tabela } of FONTES) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${tabela} (
        id serial PRIMARY KEY,
        row_num int NOT NULL,
        data jsonb NOT NULL,
        synced_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }
}

async function sincronizarFonte({ gid, tabela }) {
  const iniciadoEm = new Date();
  const client = await pool.connect();
  try {
    const { rows } = await fetchTabByGid(SPREADSHEET_ID, gid);

    await client.query('BEGIN');
    await client.query(`TRUNCATE ${tabela}`);
    if (rows.length) {
      // insert em lote (multi-row VALUES) — mais rápido que 1 INSERT por
      // linha; nada de risco de SQL injection aqui, os únicos valores
      // interpolados são parâmetros ($1, $2...), nunca texto vindo da
      // planilha direto na query.
      const valores = [];
      const placeholders = rows.map((row, i) => {
        const p = i * 3;
        valores.push(i + 1, JSON.stringify(row), iniciadoEm);
        return `($${p + 1}, $${p + 2}, $${p + 3})`;
      }).join(',');
      await client.query(`INSERT INTO ${tabela} (row_num, data, synced_at) VALUES ${placeholders}`, valores);
    }
    await client.query('COMMIT');

    await client.query(
      'INSERT INTO sync_log (tabela, linhas, ok, iniciado_em) VALUES ($1,$2,$3,$4)',
      [tabela, rows.length, true, iniciadoEm]
    );
    console.log(`  ✓ ${tabela}: ${rows.length} linha(s)`);
    return { tabela, ok: true, linhas: rows.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    await client.query(
      'INSERT INTO sync_log (tabela, linhas, ok, erro, iniciado_em) VALUES ($1,$2,$3,$4,$5)',
      [tabela, 0, false, err.message, iniciadoEm]
    ).catch(() => {}); // se a inserção do próprio log falhar, não derruba o sync
    console.error(`  ✗ ${tabela}: ${err.message}`);
    return { tabela, ok: false, erro: err.message };
  } finally {
    client.release();
  }
}

async function main() {
  console.log(`[sync-historico] iniciando — ${FONTES.length} fonte(s)`);
  const setupClient = await pool.connect();
  try {
    await garantirTabelas(setupClient);
  } finally {
    setupClient.release();
  }

  // sequencial, não paralelo — evita estourar a cota de escrita/leitura do
  // Sheets API (já vimos isso acontecer nesta planilha antes).
  const resultados = [];
  for (const fonte of FONTES) {
    resultados.push(await sincronizarFonte(fonte));
  }

  const falhas = resultados.filter(r => !r.ok);
  console.log(`[sync-historico] concluído — ${resultados.length - falhas.length}/${resultados.length} ok`);
  if (falhas.length) {
    console.error('[sync-historico] falharam:', falhas.map(f => f.tabela).join(', '));
    process.exitCode = 1;
  }
  await pool.end();
}

main().catch(err => {
  console.error('[sync-historico] erro fatal:', err);
  process.exit(1);
});
