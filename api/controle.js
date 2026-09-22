/**
 * Painel de Controle (pedido do Roberto em 2026-09-22) — visibilidade
 * restrita a UM e-mail (não é papel/role, é uma pessoa específica). Mostra
 * a saúde dos 2 pipelines que alimentam o JARVIS por fora do Google Sheets:
 *
 *   1. "pipeline": as 4 tabelas export_* (Postgres do Railway, alimentadas
 *      pelo workflow hourly_append do Data Studio — Presto → Spark →
 *      pg_merge_exports). Histórico (LH/FM/ASM/Backlog), ver
 *      docs/checklist-final-pipeline-postgres.md.
 *   2. "ontime": a tabela ontime_dados (api/ingest.js) — dado ao vivo que
 *      os scripts Python (ASM ao vivo, Conveyor, Monitor Fila, etc.)
 *      empurram direto pro Postgres, por fonte.
 *
 * Gate de acesso é reforçado aqui dentro, não só escondido no front — sem
 * isso, qualquer outro usuário logado no JARVIS conseguiria bater direto
 * no endpoint e ver o mesmo painel.
 */
const { pool } = require('../db');

const EMAIL_PERMITIDO = 'roberto.barboza@shopee.com';

const TABELAS_PIPELINE = [
  'export_inbound_lh',
  'export_inbound_fm',
  'export_asm',
  'export_backlog',
];

// Filtro de SoC dentro do próprio painel (pedido do Roberto em 2026-09-22)
// — independente do SoC da sessão de login, já que quem acessa Controle
// quer poder inspecionar qualquer um dos 4. As tabelas export_* usam o
// formato "SOC-RJ2" (ver soc_config nas queries do pipeline); SOCS_VALIDOS
// mapeia o código curto usado no resto do JARVIS pro formato da coluna.
const SOCS_VALIDOS = { RJ2: 'SOC-RJ2', RJ6: 'SOC-RJ6', SC1: 'SOC-SC1', SC2: 'SOC-SC2' };

async function statusPipeline(socCurto) {
  const socId = socCurto && SOCS_VALIDOS[socCurto];
  const resultados = [];
  for (const tabela of TABELAS_PIPELINE) {
    try {
      const sql = socId
        ? `SELECT max(exported_at) AS ultima_atualizacao, count(*) AS linhas FROM public.${tabela} WHERE soc_id = $1`
        : `SELECT max(exported_at) AS ultima_atualizacao, count(*) AS linhas FROM public.${tabela}`;
      const { rows } = await pool.query(sql, socId ? [socId] : []);
      resultados.push({ tabela, ultima_atualizacao: rows[0].ultima_atualizacao, linhas: Number(rows[0].linhas) });
    } catch (err) {
      resultados.push({ tabela, erro: err.message });
    }
  }
  return resultados;
}

// ontime_dados (api/ingest.js) não tem coluna de SoC — é fonte/chave/data
// genérico, quem decide o formato da chave é o script Python de origem.
// Sem inspecionar dado real não dá pra filtrar por SoC com segurança aqui,
// então essa parte do painel continua sempre agregada (sinalizado no front).
async function statusOntime() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ontime_dados (
        fonte text NOT NULL,
        chave text NOT NULL,
        data jsonb NOT NULL,
        atualizado_em timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (fonte, chave)
      );
    `);
    const { rows } = await pool.query(`
      SELECT fonte, max(atualizado_em) AS ultima_atualizacao, count(*) AS linhas
      FROM ontime_dados GROUP BY fonte ORDER BY fonte;
    `);
    return rows.map(r => ({ fonte: r.fonte, ultima_atualizacao: r.ultima_atualizacao, linhas: Number(r.linhas) }));
  } catch (err) {
    return [{ erro: err.message }];
  }
}

module.exports = async (req, res) => {
  const email = req.session.user && req.session.user.email;
  if (email !== EMAIL_PERMITIDO) {
    res.status(403).json({ ok: false, erro: 'Acesso restrito.' });
    return;
  }
  const socCurto = String(req.query.soc || '').toUpperCase();
  if (socCurto && !SOCS_VALIDOS[socCurto]) {
    res.status(400).json({ ok: false, erro: 'SoC inválido.' });
    return;
  }
  try {
    const [pipeline, ontime] = await Promise.all([statusPipeline(socCurto), statusOntime()]);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      ok: true, pipeline, ontime,
      socFiltrado: socCurto || null,
      socsDisponiveis: Object.keys(SOCS_VALIDOS),
      consultado_em: new Date().toISOString(),
    });
  } catch (err) {
    res.status(502).json({ ok: false, erro: err.message });
  }
};
