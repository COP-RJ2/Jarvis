/**
 * PULSO — Conveyor: performance por grupo de estação, hora a hora (aba conveyor_pulso).
 *
 * Estrutura da aba mudou (confirmado com o Roberto em 2026-08-04): antes
 * cada linha vinha com `data` (BR) + `hora_extracao` + a estação crua (de
 * onde o grupo era inferido via regex no prefixo) + horas de trabalho +
 * produtividade. Agora (verificado ao vivo via debug-meta):
 *   - `data extração`  timestamp completo "YYYY-MM-DD HH:MM:SS" — é o
 *     horário em que o LOTE inteiro foi extraído (todas as linhas da aba
 *     têm o mesmo valor), não o horário de cada linha — só usamos a parte
 *     de DATA daqui; a hora de cada linha é a própria coluna `hora`.
 *   - `hora`            hora real a que a linha se refere (0-23)
 *   - `ops`/`nome ops`  id + nome do colaborador (nome é novo, não existia)
 *   - `workstation`/`nome ws`  código + nome do posto de trabalho
 *   - `esteira`         código do grupo JÁ vem pronto da planilha (ex.
 *     "P2", "POBC", "PTIN") — não precisa mais inferir via regex do nome
 *     da estação. Dois grupos novos apareceram: PTIN (Tintas) e
 *     P_TO-Audit (TO-Audit).
 *   - `pacotes`         substitui o antigo "total de processamento
 *     (pedidos)"; não existe mais "horas de trabalho"/"produtividade" —
 *     esses campos somem da página (não são mais calculáveis).
 *   - `turno`           novo, vem pronto por linha.
 *
 * Data operacional (cutoff 6h, ver api/_period.js): a data do lote não é
 * pré-bucketizada pro dia operacional, então combinamos data+hora aqui
 * (mesmo padrão de api/backlog.js e api/labor.js).
 *
 * Classificação esteira -> grupo de exibição: antes hardcoded aqui
 * (POBA/POBB -> OBA/OBB · POBC/POBD -> OBC/OBD · P4 -> Termoplástica ·
 * P1 -> Esteira A · P2 -> Esteira B · PTIN -> Tintas · P_TO-Audit -> TO-Audit
 * · resto -> Non-TO). Migrado pro Postgres (de_para_esteiras, mesmo padrão
 * multi-SoC de de_para_ruas em api/cluster.js — pedido do Roberto em
 * 2026-09-23: RJ6/SC1/SC2 têm workstations/esteiras diferentes de RJ2, não
 * dá pra manter fixo no código). Ver classificarEsteira/buildMapaEsteiras
 * mais abaixo e "Configurar Esteiras" (?esteiras=1).
 *
 * Query params:
 *   date   YYYY-MM-DD (dia operacional a visualizar; default = hoje operacional)
 */
const { fetchTabByGid } = require('./_google');
const { toNum, dataOperacionalDe, hojeOperacionalIso } = require('./_period');
const { lerPorSoc } = require('./_pg');
const { socDaSessaoOuErro } = require('./_users');
const { pool } = require('../db');

const SHEET = { spreadsheetId: '1BqZElDRwVaGpDYZzHTq9UQvVLy2guRVfTdvwGHL1qC4', gid: '1013894222' };
// Capacidade por hora (pedido do Roberto em 2026-08-21): soma de TARGET
// TERMO + TARGET ESTEIRA A + TARGET ESTEIRA B de labor_pulso — mesma aba
// já lida em api/overview.js pra Justificativas, aqui só agregada por hora
// (não por área) pra virar a linha "Capacidade" do gráfico do Conveyor.
const LABOR_SHEET = { spreadsheetId: '1BqZElDRwVaGpDYZzHTq9UQvVLy2guRVfTdvwGHL1qC4', gid: '1065816747' };
function brToIso(v) {
  const m = String(v || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
async function getMetaPorHora(dataRef) {
  const { rows } = await fetchTabByGid(LABOR_SHEET.spreadsheetId, LABOR_SHEET.gid);
  const metaPorHora = Array(24).fill(0);
  rows.forEach(r => {
    if (r.hora === '' || r.hora === undefined) return;
    const dataIso = brToIso(r.data);
    if (dataIso === null) return;
    const hora = toNum(r.hora);
    const data = dataOperacionalDe(`${dataIso} ${String(hora).padStart(2, '0')}:00:00`);
    if (data !== dataRef) return;
    metaPorHora[hora] = toNum(r['target termo']) + toNum(r['target esteira a']) + toNum(r['target esteira b']);
  });
  return metaPorHora;
}
// SPP Scuttle (pedido do Roberto em 2026-08-19): lê cluster_pulso (mesma
// aba que api/outbound.js já cruza pra endereçamento) só pra essa média —
// aba "ao vivo", sem coluna de data/turno (aging calculado contra
// Date.now()), então o card não filtra por data/turno da tela Conveyor
// como os demais, é sempre o TO piso agora. Sem endpoint próprio (teto de
// 12 functions da Vercel).
const CLUSTER_SHEET = { spreadsheetId: '1BqZElDRwVaGpDYZzHTq9UQvVLy2guRVfTdvwGHL1qC4', gid: '646168208' };
async function sppScuttleAoVivo() {
  const { rows } = await fetchTabByGid(CLUSTER_SHEET.spreadsheetId, CLUSTER_SHEET.gid);
  const scuttles = rows.filter(r => r['to pack'] === 'Scuttle');
  if (!scuttles.length) return null;
  const soma = scuttles.reduce((s, r) => s + toNum(r.quantity), 0);
  return +(soma / scuttles.length).toFixed(1);
}

// Mapa fixo original (fallback só pra RJ2 se de_para_esteiras vier vazio/com
// erro — mesmo papel do fallback pra Sheets em buildDeParaDoBanco/cluster.js,
// só que aqui não existe aba própria de esteiras: a "fonte alternativa" é o
// mapa que já existia hardcoded antes da migração multi-SoC).
const CLASSIFICACAO_ESTEIRA_RJ2_FALLBACK = new Map([
  ['POBA', 'OBA/OBB'], ['POBB', 'OBA/OBB'],
  ['POBC', 'OBC/OBD'], ['POBD', 'OBC/OBD'],
  ['P4', 'Termoplástica'],
  ['P1', 'Esteira A'],
  ['P2', 'Esteira B'],
  ['PTIN', 'Tintas'],
  ['P_TO-AUDIT', 'TO-Audit'],
]);

// Código não encontrado no Map cai em 'Non-TO' — mesmo catch-all de sempre,
// não é erro (SoC sem cadastro ainda, ou esteira nova tipo "P_NON-TO").
function buildMapaEsteiras(pgRows) {
  const mapa = new Map();
  pgRows.forEach(r => {
    const codigo = String(r.esteira_codigo || '').trim().toUpperCase();
    if (codigo) mapa.set(codigo, r.grupo_exibicao);
  });
  return mapa;
}
function classificarEsteira(esteira, mapa) {
  return mapa.get(String(esteira || '').toUpperCase()) || 'Non-TO';
}

// ── "Configurar Esteiras" (?esteiras=1) — mesmo padrão de "Configurar Ruas"
// em api/cluster.js (handleRuas/handleRuasBatch/validarLinhaRua), só que com
// 2 campos (esteira_codigo/grupo_exibicao) em vez de 4. PK (soc,
// esteira_codigo). Código normalizado pra maiúsculas ao salvar — mesma
// convenção usada na leitura (classificarEsteira/buildMapaEsteiras), pra um
// cadastro "poba" e "POBA" não virarem 2 linhas que colidem na classificação.
function validarLinhaEsteira(payload) {
  const esteira_codigo = String((payload || {}).esteira_codigo || '').trim().toUpperCase();
  const grupo_exibicao = String((payload || {}).grupo_exibicao || '').trim();
  const faltando = [];
  if (!esteira_codigo) faltando.push('Código da Esteira');
  if (!grupo_exibicao) faltando.push('Grupo de Exibição');
  if (faltando.length) {
    return { ok: false, erro: `Campo(s) obrigatório(s) inválido(s): ${faltando.join(', ')}.` };
  }
  return { ok: true, valores: { esteira_codigo, grupo_exibicao } };
}

const ESTEIRAS_BATCH_MAX = 500; // sanity bound — teto genérico, número real de esteiras é bem menor

async function handleEsteirasBatch(req, res, soc, listar) {
  const linhas = (req.body || {}).esteiras;
  if (!Array.isArray(linhas) || !linhas.length) {
    res.status(400).json({ ok: false, erro: 'Nenhuma linha pra importar.' });
    return;
  }
  if (linhas.length > ESTEIRAS_BATCH_MAX) {
    res.status(400).json({ ok: false, erro: `Máximo de ${ESTEIRAS_BATCH_MAX} linhas por importação (mandou ${linhas.length}).` });
    return;
  }

  const erros = [];
  const vistos = new Map();
  const validas = [];
  linhas.forEach((linha, i) => {
    const n = i + 1;
    const v = validarLinhaEsteira(linha);
    if (!v.ok) { erros.push(`Linha ${n}: ${v.erro}`); return; }
    const chave = v.valores.esteira_codigo;
    if (vistos.has(chave)) { erros.push(`Linha ${n}: Código "${v.valores.esteira_codigo}" duplicado (já aparece na linha ${vistos.get(chave)}).`); return; }
    vistos.set(chave, n);
    validas.push(v.valores);
  });
  if (erros.length) {
    res.status(400).json({ ok: false, erro: 'Arquivo fora do modelo esperado.', erros });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const v of validas) {
      await client.query(
        `INSERT INTO de_para_esteiras (soc, esteira_codigo, grupo_exibicao, atualizado_em)
         VALUES ($1,$2,$3, now())
         ON CONFLICT (soc, esteira_codigo) DO UPDATE
           SET grupo_exibicao = EXCLUDED.grupo_exibicao, atualizado_em = now()`,
        [soc, v.esteira_codigo, v.grupo_exibicao]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(502).json({ ok: false, erro: err.message });
    return;
  } finally {
    client.release();
  }

  res.status(200).json({ ok: true, importadas: validas.length, esteiras: await listar() });
}

async function handleEsteiras(req, res) {
  const soc = socDaSessaoOuErro(req, res);
  if (!soc) return;

  const listar = async () => {
    const linhas = await lerPorSoc('de_para_esteiras', soc);
    linhas.sort((a, b) => a.esteira_codigo.localeCompare(b.esteira_codigo));
    return linhas;
  };

  if (req.method === 'GET') {
    try {
      res.status(200).json({ ok: true, esteiras: await listar() });
    } catch (err) {
      res.status(502).json({ ok: false, erro: err.message });
    }
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, erro: 'Use GET ou POST' });
    return;
  }

  const action = (req.body || {}).action;

  if (action === 'batch') {
    await handleEsteirasBatch(req, res, soc, listar);
    return;
  }

  const payload = (req.body || {}).esteira || {};
  const esteira_codigo = String(payload.esteira_codigo || '').trim().toUpperCase();

  if (action === 'delete') {
    if (!esteira_codigo) {
      res.status(400).json({ ok: false, erro: 'Código da Esteira obrigatório.' });
      return;
    }
    try {
      await pool.query('DELETE FROM de_para_esteiras WHERE soc = $1 AND esteira_codigo = $2', [soc, esteira_codigo]);
      res.status(200).json({ ok: true, esteiras: await listar() });
    } catch (err) {
      res.status(502).json({ ok: false, erro: err.message });
    }
    return;
  }

  if (action !== 'create' && action !== 'update') {
    res.status(400).json({ ok: false, erro: 'action inválida (use create, update, delete ou batch).' });
    return;
  }

  const validacao = validarLinhaEsteira(payload);
  if (!validacao.ok) {
    res.status(400).json({ ok: false, erro: validacao.erro });
    return;
  }
  const { grupo_exibicao } = validacao.valores;

  try {
    if (action === 'create') {
      await pool.query(
        `INSERT INTO de_para_esteiras (soc, esteira_codigo, grupo_exibicao, atualizado_em)
         VALUES ($1, $2, $3, now())`,
        [soc, esteira_codigo, grupo_exibicao]
      );
    } else {
      const { rowCount } = await pool.query(
        `UPDATE de_para_esteiras SET grupo_exibicao = $3, atualizado_em = now()
          WHERE soc = $1 AND esteira_codigo = $2`,
        [soc, esteira_codigo, grupo_exibicao]
      );
      if (!rowCount) {
        res.status(404).json({ ok: false, erro: `Esteira com código "${esteira_codigo}" não encontrada pra esse SoC.` });
        return;
      }
    }
  } catch (err) {
    // 23505 = unique_violation (soc, esteira_codigo)
    if (err.code === '23505') {
      res.status(400).json({ ok: false, erro: `Já existe uma esteira cadastrada com código "${esteira_codigo}" pra esse SoC.` });
      return;
    }
    res.status(502).json({ ok: false, erro: err.message });
    return;
  }

  try {
    res.status(200).json({ ok: true, esteiras: await listar() });
  } catch (err) {
    res.status(502).json({ ok: false, erro: err.message });
  }
}

module.exports = async (req, res) => {
  if (req.query.esteiras !== undefined) {
    await handleEsteiras(req, res);
    return;
  }

  const soc = socDaSessaoOuErro(req, res);
  if (!soc) return;

  let rows;
  try {
    ({ rows } = await fetchTabByGid(SHEET.spreadsheetId, SHEET.gid));
  } catch (err) {
    res.status(502).json({ ok: false, erro: err.message });
    return;
  }

  // Fonte da classificação esteira->grupo: de_para_esteiras no Postgres,
  // filtrado pelo SoC da sessão — com FALLBACK pro mapa fixo (comportamento
  // de antes da migração) só quando vazio/erro E o SoC é RJ2. RJ6/SC1/SC2
  // sem cadastro classificam tudo como 'Non-TO' (mapa vazio, mesmo
  // tratamento de "SoC sem dado" usado em Ruas/Árvore de KPIs/Kanban).
  let deParaEsteirasPg = [];
  try {
    deParaEsteirasPg = await lerPorSoc('de_para_esteiras', soc);
  } catch (err) {
    console.error('[api/conveyor] lerPorSoc(de_para_esteiras) falhou, ' +
      (soc === 'RJ2' ? 'caindo pro mapa fixo (RJ2)' : 'seguindo com mapa vazio') + ':', err.message);
  }
  const MAPA_ESTEIRAS = deParaEsteirasPg.length
    ? buildMapaEsteiras(deParaEsteirasPg)
    : (soc === 'RJ2' ? CLASSIFICACAO_ESTEIRA_RJ2_FALLBACK : new Map());

  const conveyor = rows
    .filter(r => r['data extração'] && r.hora !== '')
    .map(r => {
      const dataExtracao = String(r['data extração'] || '');
      const dataExtracaoIso = dataExtracao.slice(0, 10);
      const hora = toNum(r.hora);
      const dataIso = dataOperacionalDe(`${dataExtracaoIso} ${String(hora).padStart(2, '0')}:00:00`);
      return { ...r, dataIso, hora };
    })
    .filter(r => r.dataIso !== null);

  if (!conveyor.length) {
    res.status(200).json({
      ok: true, data: null, rows: [], grupos: [], sppScuttle: null,
      cobertura: { inicio: null, fim: null },
    });
    return;
  }

  const datasDisponiveis = [...new Set(conveyor.map(r => r.dataIso))].sort();
  const dataMinima = datasDisponiveis[0], dataMaxima = datasDisponiveis[datasDisponiveis.length - 1];
  const hojeIso = hojeOperacionalIso();
  const padrao = datasDisponiveis.includes(hojeIso) ? hojeIso : dataMaxima;
  const dataQuery = req.query.date;
  const dataRef = (dataQuery && datasDisponiveis.includes(dataQuery)) ? dataQuery : padrao;

  const doDia = conveyor.filter(r => r.dataIso === dataRef);

  // OPS em vez de nome (pedido do Roberto em 2026-08-19): identificação
  // padronizada pelo id da coluna `ops`, não expõe mais o nome do
  // colaborador (`nome ops`) em nenhuma tela do Conveyor.
  const linhas = doDia.map(r => ({
    hora: r.hora,
    opsId: r.ops || '',
    estacao: r.workstation || '',
    nomeEstacao: r['nome ws'] || '',
    grupo: classificarEsteira(r.esteira, MAPA_ESTEIRAS),
    turno: r.turno || '',
    totalProcessamento: toNum(r.pacotes),
  }));

  const grupos = ['OBA/OBB', 'OBC/OBD', 'Termoplástica', 'Esteira A', 'Esteira B', 'Tintas', 'TO-Audit', 'Non-TO'];

  let sppScuttle = null;
  try { sppScuttle = await sppScuttleAoVivo(); } catch (err) { /* card opcional, não derruba o Conveyor */ }

  let metaPorHora = null;
  try { metaPorHora = await getMetaPorHora(dataRef); } catch (err) { /* linha de capacidade é opcional, não derruba o Conveyor */ }

  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=1500');
  res.status(200).json({
    ok: true,
    data: dataRef,
    rows: linhas,
    grupos,
    sppScuttle,
    metaPorHora,
    cobertura: { inicio: dataMinima, fim: dataMaxima },
  });
};
