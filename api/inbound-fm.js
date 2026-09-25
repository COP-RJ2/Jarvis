/**
 * PULSO — Inbound First Mile: monitor histórico de chegada/descarga (aba inbound_fm_pulso).
 *
 * Sem ETA planejado nessa base (confirmado com o Roberto em 2026-08-04) — só
 * execução real: checkin_driver (geo) -> atribuicao_doca -> ocupacao_doca ->
 * finalizacao_jornada (fim descarga). "Planejado" aqui é a META operacional
 * já calculada na planilha (meta_descarga_minutos/performance_doca/
 * desvio_meta_minutos), não um horário agendado — por isso a página não tem
 * card de pontualidade planejado x realizado, só monitor histórico + meta.
 *
 * Suporta intervalo (from/to) pra análise histórica — confirmado com o
 * Roberto em 2026-08-04; sem params, default é from=to=hoje.
 *
 * Query params:
 *   from, to   YYYY-MM-DD (data_operacional; default = hoje, ou o dia mais
 *              recente disponível se hoje não tiver dado ainda)
 */
const { fetchTabByGid } = require('./_google');
const { toNum, hojeOperacionalIso, dataOperacionalDe } = require('./_period');
const { socDaSessaoOuErro } = require('./_users');
const { lerPorStationId } = require('./_pg_ontime');
const { lerPorSoc } = require('./_pg');
const { pool } = require('../db');

// Categorias fixas do de-para de docas (pedido do Roberto em 2026-09-25): a
// tabela `dock` do Postgres-ontime não tem campo confiável pra classificar
// automaticamente, então vira cadastro manual, igual de_para_ruas/esteiras.
const CATEGORIAS_DOCA = ['Interna', 'Externa', 'Inbound LH', 'Inbound FM', 'Outbound LH', 'Outbound SoC'];

// "HH:MM" -> minutos (occupation_time_hh_mm da tabela `dock`, Postgres-ontime).
function hhmmParaMin(v) {
  const m = String(v || '').match(/^(\d+):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const SHEET = { spreadsheetId: '1BqZElDRwVaGpDYZzHTq9UQvVLy2guRVfTdvwGHL1qC4', gid: '1026737209' };
// Docas abertas (workstations do FM) — pedido do Roberto em 2026-08-26,
// visão "Docas abertas" do gráfico + KPI "Quantidade de docas usadas" do
// Overall por Turno. Sem coluna de data própria (só check_in_time, que já
// carrega a data) — dia operacional calculado a partir dele, mesma
// convenção do resto do PULSO.
const FMBEEP_SHEET = { spreadsheetId: '1BqZElDRwVaGpDYZzHTq9UQvVLy2guRVfTdvwGHL1qC4', gid: '360571552' };

// Hora extraída direto da string (evita ambiguidade de fuso horário do
// parse via Date) + turno pela mesma janela do Outbound (T1 06h-13h59,
// T2 14h-21h59, T3 22h-05h59) — pedido do Roberto em 2026-08-14:
// turno_operacional é estático da planilha, não reflete a hora real do
// checkin; sem "planejado" nessa base (ver comentário do topo do arquivo),
// então recalcula sempre em cima do checkin_driver.
function horaDe(v) {
  const m = String(v || '').match(/(\d{2}):\d{2}:\d{2}/);
  return m ? Number(m[1]) : null;
}
function turnoDeHora(hora) {
  if (hora === null) return null;
  if (hora >= 6 && hora <= 13) return 'T1';
  if (hora >= 14 && hora <= 21) return 'T2';
  return 'T3';
}

// ── "Configurar Docas" (?docas=1) — mesmo padrão de handleEsteiras em
// api/conveyor.js (que por sua vez segue handleRuas/handleRuasBatch/
// validarLinhaRua em api/cluster.js), só que com 2 campos (dock_no/
// categoria) em vez de 4. PK (soc, dock_no). `categoria` é lista fixa
// (CATEGORIAS_DOCA), não texto livre — validada tanto no create/update
// individual quanto no batch, mesmo espírito da validação de coluna
// desconhecida que Ruas/Esteiras já fazem.
function validarLinhaDoca(payload) {
  const dock_no = String((payload || {}).dock_no || '').trim();
  const categoria = String((payload || {}).categoria || '').trim();
  const faltando = [];
  if (!dock_no) faltando.push('Doca');
  if (!categoria) faltando.push('Categoria');
  else if (!CATEGORIAS_DOCA.includes(categoria)) {
    return { ok: false, erro: `Categoria "${categoria}" inválida — use uma de: ${CATEGORIAS_DOCA.join(', ')}.` };
  }
  if (faltando.length) {
    return { ok: false, erro: `Campo(s) obrigatório(s) inválido(s): ${faltando.join(', ')}.` };
  }
  return { ok: true, valores: { dock_no, categoria } };
}

const DOCAS_BATCH_MAX = 500; // sanity bound — teto genérico, número real de docas é bem menor

async function handleDocasBatch(req, res, soc, listar) {
  const linhas = (req.body || {}).docas;
  if (!Array.isArray(linhas) || !linhas.length) {
    res.status(400).json({ ok: false, erro: 'Nenhuma linha pra importar.' });
    return;
  }
  if (linhas.length > DOCAS_BATCH_MAX) {
    res.status(400).json({ ok: false, erro: `Máximo de ${DOCAS_BATCH_MAX} linhas por importação (mandou ${linhas.length}).` });
    return;
  }

  const erros = [];
  const vistos = new Map();
  const validas = [];
  linhas.forEach((linha, i) => {
    const n = i + 1;
    const v = validarLinhaDoca(linha);
    if (!v.ok) { erros.push(`Linha ${n}: ${v.erro}`); return; }
    const chave = v.valores.dock_no.toLowerCase();
    if (vistos.has(chave)) { erros.push(`Linha ${n}: Doca "${v.valores.dock_no}" duplicada (já aparece na linha ${vistos.get(chave)}).`); return; }
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
        `INSERT INTO de_para_docas (soc, dock_no, categoria, atualizado_em)
         VALUES ($1,$2,$3, now())
         ON CONFLICT (soc, dock_no) DO UPDATE
           SET categoria = EXCLUDED.categoria, atualizado_em = now()`,
        [soc, v.dock_no, v.categoria]
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

  res.status(200).json({ ok: true, importadas: validas.length, docas: await listar() });
}

async function handleDocas(req, res) {
  const soc = socDaSessaoOuErro(req, res);
  if (!soc) return;

  const listar = async () => {
    const linhas = await lerPorSoc('de_para_docas', soc);
    linhas.sort((a, b) => a.dock_no.localeCompare(b.dock_no));
    return linhas;
  };

  if (req.method === 'GET') {
    try {
      res.status(200).json({ ok: true, docas: await listar(), categorias: CATEGORIAS_DOCA });
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
    await handleDocasBatch(req, res, soc, listar);
    return;
  }

  const payload = (req.body || {}).doca || {};
  const dock_no = String(payload.dock_no || '').trim();

  if (action === 'delete') {
    if (!dock_no) {
      res.status(400).json({ ok: false, erro: 'Doca obrigatória.' });
      return;
    }
    try {
      await pool.query('DELETE FROM de_para_docas WHERE soc = $1 AND dock_no = $2', [soc, dock_no]);
      res.status(200).json({ ok: true, docas: await listar() });
    } catch (err) {
      res.status(502).json({ ok: false, erro: err.message });
    }
    return;
  }

  if (action !== 'create' && action !== 'update') {
    res.status(400).json({ ok: false, erro: 'action inválida (use create, update, delete ou batch).' });
    return;
  }

  const validacao = validarLinhaDoca(payload);
  if (!validacao.ok) {
    res.status(400).json({ ok: false, erro: validacao.erro });
    return;
  }
  const { categoria } = validacao.valores;

  try {
    if (action === 'create') {
      await pool.query(
        `INSERT INTO de_para_docas (soc, dock_no, categoria, atualizado_em)
         VALUES ($1, $2, $3, now())`,
        [soc, dock_no, categoria]
      );
    } else {
      const { rowCount } = await pool.query(
        `UPDATE de_para_docas SET categoria = $3, atualizado_em = now()
          WHERE soc = $1 AND dock_no = $2`,
        [soc, dock_no, categoria]
      );
      if (!rowCount) {
        res.status(404).json({ ok: false, erro: `Doca "${dock_no}" não encontrada pra esse SoC.` });
        return;
      }
    }
  } catch (err) {
    // 23505 = unique_violation (soc, dock_no)
    if (err.code === '23505') {
      res.status(400).json({ ok: false, erro: `Já existe uma doca cadastrada com número "${dock_no}" pra esse SoC.` });
      return;
    }
    res.status(502).json({ ok: false, erro: err.message });
    return;
  }

  try {
    res.status(200).json({ ok: true, docas: await listar() });
  } catch (err) {
    res.status(502).json({ ok: false, erro: err.message });
  }
}

module.exports = async (req, res) => {
  if (req.query.docas !== undefined) {
    await handleDocas(req, res);
    return;
  }

  const soc = socDaSessaoOuErro(req, res);
  if (!soc) return;

  // Histórico de chegada/descarga (Sheets, inbound_fm_pulso) continua
  // implicitamente RJ2 (pedido do Roberto em 2026-09-25: não existe fonte
  // histórica melhor ainda pros demais SoCs — melhor nada do que misturar
  // dado de RJ2). Docas abertas (fmbeep) e docas ocupadas AGORA (dock) já
  // migraram pro Postgres-ontime (particionado por station_id) e funcionam
  // pra qualquer SoC, mesmo sem histórico — por isso não tem mais um gate
  // único no topo: RJ6/SC1/SC2 ficam com `rows` vazio (sem histórico) mas
  // ainda recebem `docas`/`docasOcupadasAgora` normalmente.
  let sheetRows = [];
  if (soc === 'RJ2') {
    try {
      ({ rows: sheetRows } = await fetchTabByGid(SHEET.spreadsheetId, SHEET.gid));
    } catch (err) {
      res.status(502).json({ ok: false, erro: err.message });
      return;
    }
  }

  let docaRowsPg, dockRows, deParaDocas;
  try {
    [docaRowsPg, dockRows, deParaDocas] = await Promise.all([
      lerPorStationId('fmbeep', soc),
      lerPorStationId('dock', soc),
      lerPorSoc('de_para_docas', soc),
    ]);
  } catch (err) {
    res.status(502).json({ ok: false, erro: err.message });
    return;
  }

  const fm = sheetRows.filter(r => r.data_operacional);

  let de = null, ate = null, dataMinima = null, dataMaxima = null, linhas = [], opcoes = { turnos: [], agencias: [] };
  if (fm.length) {
    const datasDisponiveis = [...new Set(fm.map(r => r.data_operacional))].sort();
    dataMinima = datasDisponiveis[0]; dataMaxima = datasDisponiveis[datasDisponiveis.length - 1];
    const hojeIso = hojeOperacionalIso();
    const padrao = datasDisponiveis.includes(hojeIso) ? hojeIso : dataMaxima;
    de = (req.query.from && datasDisponiveis.includes(req.query.from)) ? req.query.from : padrao;
    ate = (req.query.to && datasDisponiveis.includes(req.query.to) && req.query.to >= de) ? req.query.to : de;

    const doIntervalo = fm.filter(r => r.data_operacional >= de && r.data_operacional <= ate);

    // A aba tem linhas duplicadas pro mesmo motorista+checkin (confirmado com
    // amostra real em 2026-08-14: driver 2524020, checkin 2026-08-13 15:58:18,
    // linhas idênticas exceto um arredondamento diferente de
    // tempo_descarga_minutos) — sem trip_id_spx (sempre "0" nessa base) pra
    // distinguir. "Chegadas" e as somas de pacotes/tempo estavam contando a
    // mesma chegada 2x. Deduplica por motorista+checkin, mantendo a 1ª
    // ocorrência (pedido do Roberto em 2026-08-14).
    const vistos = new Set();
    const semDuplicata = doIntervalo.filter(r => {
      const chave = `${r.driver_id_spx}|${r.checkin_driver}`;
      if (vistos.has(chave)) return false;
      vistos.add(chave);
      return true;
    });

    linhas = semDuplicata.map(r => ({
      driver: r.driver_id_spx || '',
      estacao: r.station_name || '',
      agencia: r.agency_name || '',
      turno: turnoDeHora(horaDe(r.checkin_driver)) || r.turno_operacional || '',
      hora: toNum(r.slot_chegada),
      checkinDriver: r.checkin_driver || '',
      atribuicaoDoca: r.atribuicao_doca || '',
      // Existia na aba mas não era exposta (pedido do Roberto em 2026-08-28,
      // card "Carros Docados") — é o único timestamp que marca a doca
      // FISICAMENTE ocupada; atribuicao_doca só marca que uma doca foi
      // reservada, o caminhão pode ainda estar chegando até ela.
      ocupacaoDoca: r.ocupacao_doca || '',
      finalizacaoJornada: r.finalizacao_jornada || '',
      tempoFilaMin: toNum(r.tempo_fila_minutos),
      tempoDescargaMin: toNum(r.tempo_descarga_minutos),
      tempoTotalMin: toNum(r.tempo_total_minutos),
      performanceDoca: r.performance_doca || '',
      desvioMetaMin: toNum(r.desvio_meta_minutos),
      pacotes: toNum(r.pickup_quantity),
    }));

    opcoes = {
      turnos: [...new Set(linhas.map(l => l.turno).filter(Boolean))].sort(),
      agencias: [...new Set(linhas.map(l => l.agencia).filter(Boolean))].sort(),
    };
  }

  // Docas abertas (pedido do Roberto em 2026-08-26, migrado pro
  // Postgres-ontime em 2026-09-25): 1 linha por workstation×hora do fmbeep,
  // filtrado pelo intervalo de/ate calculado acima (quando tem histórico —
  // sem histórico, `de`/`ate` são null e o filtro de data não teria sentido,
  // então mostra todas as docas abertas disponíveis nesse caso).
  const docas = docaRowsPg
    .map(r => ({ workstation: r.workstation || '', hora: toNum(r.hora_range_spx), data: dataOperacionalDe(r.check_in_time) }))
    .filter(r => r.workstation && r.data && (!de || (r.data >= de && r.data <= ate)))
    .map(r => ({ workstation: r.workstation, hora: r.hora }));

  // Docas ocupadas AGORA (pedido do Roberto em 2026-09-25): snapshot ao
  // vivo da tabela `dock` — sempre "agora", não filtra por data escolhida
  // (é um indicador complementar ao histórico, não um substituto dele).
  // Funciona pra qualquer SoC que já tenha dado no Postgres-ontime.
  // Categoria de cada doca (Interna/Externa/Inbound LH/Inbound FM/Outbound
  // LH/Outbound SoC) vem do cadastro manual de_para_docas — a tabela `dock`
  // do Postgres-ontime não tem campo confiável pra classificar isso sozinha
  // (pedido do Roberto em 2026-09-25).
  const mapaCategoriaPorDoca = new Map(deParaDocas.map(d => [d.dock_no, d.categoria]));
  const docasOcupadasAgora = dockRows
    .filter(r => r.occupied_driver)
    .map(r => ({
      docaNumero: r.dock_no || '',
      docaNome: r.dock_name || '',
      motorista: r.occupied_driver || '',
      tempoOcupacaoMin: hhmmParaMin(r.occupation_time_hh_mm),
      categoria: mapaCategoriaPorDoca.get(r.dock_no) || 'Não classificada',
    }));

  // Resumo agrupado por categoria (o motivo de tudo isso existir, pedido do
  // Roberto em 2026-09-25) — inclui "Não classificada" de propósito: é
  // sinal de que falta cadastrar a doca em "Configurar Docas", não algo pra
  // esconder.
  const docasOcupadasPorCategoria = {};
  CATEGORIAS_DOCA.forEach(cat => { docasOcupadasPorCategoria[cat] = 0; });
  docasOcupadasPorCategoria['Não classificada'] = 0;
  docasOcupadasAgora.forEach(d => {
    docasOcupadasPorCategoria[d.categoria] = (docasOcupadasPorCategoria[d.categoria] || 0) + 1;
  });

  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
  res.status(200).json({
    ok: true,
    de, ate,
    rows: linhas,
    docas,
    docasOcupadasAgora,
    docasOcupadasPorCategoria,
    opcoes,
    cobertura: { inicio: dataMinima, fim: dataMaxima },
  });
};
