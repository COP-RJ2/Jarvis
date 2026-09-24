/**
 * Ingest direto — dimensão ON TIME (pedido do Roberto em 2026-09-14):
 * em vez de um script Python escrever na planilha e o JARVIS ler a
 * planilha, o script passa a chamar esse endpoint direto, gravando no
 * Postgres. Corta a planilha do meio do processo pras fontes PYTHON
 * (ASM ao vivo, Conveyor, Monitor Fila, Monitor Outbound Live, Sorting
 * Exception, etc. — ver FLAG=PYTHON na aba `readme` de governança).
 *
 * Genérico de propósito: não sabe nada sobre o formato de cada fonte —
 * quem decide o que é 1 registro e qual sua chave única é quem está
 * mandando o dado (o script de origem). Isso evita ter que codar um
 * endpoint por fonte (são 12 fontes PYTHON hoje) só pra receber dado.
 *
 * Upsert por (fonte, chave) — ao contrário do sync histórico (que faz
 * TRUNCATE + INSERT toda vez, porque lá o Data Suite já manda a foto
 * inteira), aqui o dado chega aos poucos e continuamente, então cada
 * chamada só atualiza/insere as linhas que vieram, sem apagar o resto.
 *
 * Autenticação: header `Authorization: Bearer <INGEST_API_KEY>` — só
 * quem tem a chave (os scripts de origem) consegue gravar. Sem isso
 * qualquer um na internet conseguiria injetar dado falso no JARVIS.
 *
 * POST /api/ingest?fonte=asm&soc=RJ6
 *   body: { rows: [ { chave: "...", data: {...} }, ... ] }
 *   ou, pra 1 linha só: { chave: "...", data: {...} }
 *
 * GET /api/ingest?fonte=asm&soc=RJ6&desde=2026-09-14T00:00:00Z (soc/desde opcionais)
 *   -> lista o que está gravado pra essa fonte (uso de conferência/debug)
 *
 * `soc` (pedido do Roberto em 2026-09-24): cada job Pulse já é dedicado a
 * 1 SoC ("Pulse RJ6", "Pulse SC1" etc.) — aceita tanto o código curto
 * (RJ6) quanto o formato usado pelo pipeline externo (SOC-RJ6), normaliza
 * pro curto (mesmo padrão do resto do JARVIS: socs/de_para_ruas/
 * de_para_esteiras/de_para_arvore_kpis). Omitido = 'RJ2' (scripts antigos
 * que ainda não mandam soc continuam gravando como sempre, sem quebrar).
 */
const { pool } = require('../db');
const { normalizarSoc } = require('./_users');

async function garantirTabela() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ontime_dados (
      fonte text NOT NULL,
      soc text NOT NULL DEFAULT 'RJ2',
      chave text NOT NULL,
      data jsonb NOT NULL,
      atualizado_em timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (fonte, soc, chave)
    );
  `);
}

function autenticado(req) {
  const esperado = process.env.INGEST_API_KEY;
  if (!esperado) return false; // sem chave configurada = ingest desligado, por segurança
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return token === esperado;
}

async function handlePost(req, res, fonte, soc) {
  if (!autenticado(req)) {
    res.status(401).json({ ok: false, erro: 'Token inválido ou INGEST_API_KEY não configurada no servidor.' });
    return;
  }

  const body = req.body || {};
  const rows = Array.isArray(body.rows) ? body.rows : [body];
  const validas = rows.filter(r => r && r.chave && r.data);
  if (!validas.length) {
    res.status(400).json({ ok: false, erro: 'Manda { chave, data } ou { rows: [{chave, data}, ...] }.' });
    return;
  }

  await garantirTabela();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of validas) {
      await client.query(
        `INSERT INTO ontime_dados (fonte, soc, chave, data, atualizado_em)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (fonte, soc, chave) DO UPDATE SET data = $4, atualizado_em = now()`,
        [fonte, soc, String(r.chave), JSON.stringify(r.data)]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  res.status(200).json({ ok: true, fonte, soc, gravados: validas.length });
}

async function handleGet(req, res, fonte, soc) {
  // GET fica fora do gate de sessão do server.js (ver comentário lá) —
  // então precisa do MESMO token do POST, senão vira leitura pública.
  if (!autenticado(req)) {
    res.status(401).json({ ok: false, erro: 'Token inválido ou INGEST_API_KEY não configurada no servidor.' });
    return;
  }
  await garantirTabela();
  const desde = req.query.desde;
  const params = [fonte, soc];
  let sql = 'SELECT chave, data, atualizado_em FROM ontime_dados WHERE fonte = $1 AND soc = $2';
  if (desde) { sql += ' AND atualizado_em >= $3'; params.push(desde); }
  sql += ' ORDER BY atualizado_em DESC LIMIT 5000';
  const { rows } = await pool.query(sql, params);
  res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
  res.status(200).json({ ok: true, fonte, soc, total: rows.length, rows });
}

module.exports = async (req, res) => {
  try {
    const fonte = String(req.query.fonte || '').trim();
    if (!fonte) { res.status(400).json({ ok: false, erro: 'Informe ?fonte=nome-da-origem' }); return; }
    // Omitido = 'RJ2' (scripts antigos que ainda não mandam soc) — esse
    // default é uma decisão específica do ingest, não da normalização em si
    // (normalizarSoc, em api/_users.js, não assume default nenhum).
    const soc = normalizarSoc(req.query.soc || 'RJ2');
    if (!soc) { res.status(400).json({ ok: false, erro: 'SoC inválido em ?soc=' }); return; }

    if (req.method === 'POST') { await handlePost(req, res, fonte, soc); return; }
    if (req.method === 'GET') { await handleGet(req, res, fonte, soc); return; }
    res.status(405).json({ ok: false, erro: 'Use GET ou POST' });
  } catch (err) {
    console.error('[ingest]', err);
    res.status(502).json({ ok: false, erro: err.message });
  }
};
