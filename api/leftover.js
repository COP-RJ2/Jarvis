/**
 * PULSO — agregação da base Leftover (pacotes remanescentes por hub/CPT).
 *
 * Mesma lógica de agregação server-side do SPR (ver api/spr.js): filtra e
 * agrega no servidor, devolve só os números prontos pros cards.
 *
 * Métrica principal: leftover_until_cap (packages que sobraram dentro da
 * capacidade do hub). leftover_over_cap é quase sempre "[INFO] Sem Volumes
 * a Justificar" (>97% das linhas) — não é usado nos totais.
 *
 * Classificação de causa (leftover_until_cap_causa_l1), decidida com o time:
 *   [SOC]  -> Operacional
 *   [GOV]  -> Inconsistência de Dados (fora dos 2 cards, aparece só no Pipboy)
 *   demais ([LH], [3PL], [XPT], [EXT], [INFO], outros) -> Externo
 *
 * Query params:
 *   de, ate                            iguais ao /api/spr (De/Até, mesmo modelo do Outbound)
 *   turno, type_cpt                    listas separadas por vírgula
 *   hub, causa1 (causa_l1), causa2 (causa_l2)  idem
 *   q                                  busca livre em hub + observacao
 *
 * Transportadora/Destino: a aba não tem essas colunas — cruza com
 * rawdata_out_pulso (api/outbound.js) pela chave hub+cpt_planejado ==
 * destination_station_code+cpt_scheduled_origin_edited (confirmado com
 * amostra real: HUB-LMG-56 + 2026-08-03 19:00:00 -> DHL). Só cobre o
 * período em que as duas bases se sobrepõem (rawdata_out_pulso só tem
 * ~3 semanas de histórico); fora disso os campos ficam vazios.
 */
const { fetchTabByGid } = require('./_google');
const { fmtDate, toNum, parseCSV, pctDelta } = require('./_period');
const { socDaSessaoOuErro } = require('./_users');

const LEFTOVER_SHEET = { spreadsheetId: '1BqZElDRwVaGpDYZzHTq9UQvVLy2guRVfTdvwGHL1qC4', gid: '352174025' };
const OUTBOUND_SHEET = { spreadsheetId: '1BqZElDRwVaGpDYZzHTq9UQvVLy2guRVfTdvwGHL1qC4', gid: '0' };

function classificarCausa(causa) {
  const c = String(causa || '');
  if (c.startsWith('[SOC]')) return 'operacional';
  if (c.startsWith('[GOV]')) return 'inconsistencia';
  return 'externo';
}

// Canal do hub, mesmo padrão de prefixo já usado em tipoCarregamento
// (api/_outbound.js) — confirmado ao vivo: as 82 estações distintas de
// `hub` nessa aba batem 100% com HUB-/XPT-/SOC- (nenhuma sobra). Usado só
// pro % de Leftover (numerador = leftover, denominador = expedido do
// canal HUB) — pedido do Roberto em 2026-08-19.
function canalDoHub(hub) {
  const h = String(hub || '');
  if (/^HUB/i.test(h)) return 'HUB';
  if (/^XPT/i.test(h)) return 'XPT';
  if (/^SOC/i.test(h)) return 'SOC';
  return '3PL';
}

function aggregate(rows) {
  const registros = rows.length;
  const destinos = new Set(rows.map(r => r.hub).filter(Boolean)).size;
  const pacotesLeftover = rows.reduce((s, r) => s + toNum(r.leftover_until_cap), 0);

  let pacotesOperacional = 0, pacotesExterno = 0, pacotesInconsistencia = 0;
  let registrosOperacional = 0, registrosExterno = 0, registrosInconsistencia = 0;
  rows.forEach(r => {
    const qtd = toNum(r.leftover_until_cap);
    const cls = classificarCausa(r.leftover_until_cap_causa_l1);
    if (cls === 'operacional') { pacotesOperacional += qtd; registrosOperacional++; }
    else if (cls === 'inconsistencia') { pacotesInconsistencia += qtd; registrosInconsistencia++; }
    else { pacotesExterno += qtd; registrosExterno++; }
  });

  // Transportadoras ofensoras = transportadoras identificadas (join com
  // rawdata_out_pulso, ver __transportadora) com pelo menos 1 registro de
  // leftover no período (pedido do Roberto em 2026-08-14).
  const transportadorasOfensoras = new Set(rows.map(r => r.__transportadora).filter(Boolean)).size;

  // % de Leftover (pedido do Roberto em 2026-08-19, 1º card da página):
  // leftover ÷ expedido, só do canal HUB (numerador já filtrado junto,
  // não é o pacotesLeftover geral acima — esse pega todos os canais).
  const rowsHub = rows.filter(r => canalDoHub(r.hub) === 'HUB');
  const leftoverHub = rowsHub.reduce((s, r) => s + toNum(r.leftover_until_cap), 0);
  const expedidoHub = rowsHub.reduce((s, r) => s + toNum(r.expedido), 0);
  const pctLeftover = expedidoHub ? +(leftoverHub / expedidoHub * 100).toFixed(1) : 0;

  return {
    registros,
    destinos,
    pacotesLeftover,
    pctLeftover,
    leftoverHub,
    expedidoHub,
    registrosOperacional,
    registrosExterno,
    registrosInconsistencia,
    pctOperacional: pacotesLeftover ? +(pacotesOperacional / pacotesLeftover * 100).toFixed(1) : 0,
    pacotesOperacional,
    pctExterno: pacotesLeftover ? +(pacotesExterno / pacotesLeftover * 100).toFixed(1) : 0,
    pacotesExterno,
    pacotesInconsistencia,
    transportadorasOfensoras,
  };
}

module.exports = async (req, res) => {
  const soc = socDaSessaoOuErro(req, res);
  if (!soc) return;

  // leftover_pulso/rawdata_out_pulso são implicitamente RJ2 (sem coluna de
  // SoC) — pra qualquer outro SoC, nem busca (melhor nada do que misturar
  // dado de RJ2 — pedido do Roberto em 2026-09-24). Mesma forma da resposta
  // de sucesso, só com os campos de dado vazios/zerados.
  if (soc !== 'RJ2') {
    const atualVazio = aggregate([]);
    res.status(200).json({
      ok: true,
      atualizadoEm: new Date().toISOString(),
      modo: 'recente',
      intervalo: { inicio: null, fim: null },
      cobertura: { inicio: null, fim: null },
      atual: atualVazio, anterior: atualVazio, delta: Object.fromEntries(Object.keys(atualVazio).map(k => [k, null])),
      leftovers: [], leftoversTotal: 0,
      porTransportadora: [],
      opcoesFiltro: { turno: [], type_cpt: [], hub: [], causa1: [], causa2: [], transportadora: [] },
    });
    return;
  }

  let rows, outRows;
  try {
    [{ rows }, { rows: outRows }] = await Promise.all([
      fetchTabByGid(LEFTOVER_SHEET.spreadsheetId, LEFTOVER_SHEET.gid),
      fetchTabByGid(OUTBOUND_SHEET.spreadsheetId, OUTBOUND_SHEET.gid),
    ]);
  } catch (err) {
    res.status(502).json({ ok: false, erro: err.message });
    return;
  }

  const transportadoraPorChave = new Map();
  outRows.forEach(r => {
    const chave = `${r.destination_station_code}|${r.cpt_scheduled_origin_edited}`;
    if (r.used_agency_name) transportadoraPorChave.set(chave, r.used_agency_name);
  });
  const transportadoraDe = r => transportadoraPorChave.get(`${r.hub}|${r.cpt_planejado}`) || null;

  const withDate = rows
    .map(r => ({ ...r, __date: r.data ? new Date(r.data + 'T00:00:00Z') : null, __transportadora: transportadoraDe(r) }))
    .filter(r => r.__date && !isNaN(r.__date));

  const maisRecente = withDate.reduce((max, r) => (r.__date > max ? r.__date : max), withDate[0]?.__date || new Date());
  const maisAntiga = withDate.reduce((min, r) => (r.__date < min ? r.__date : min), withDate[0]?.__date || maisRecente);

  const turnos = parseCSV(req.query.turno);
  const tiposCpt = parseCSV(req.query.type_cpt);
  const hubs = parseCSV(req.query.hub);
  const causas1 = parseCSV(req.query.causa1);
  const causas2 = parseCSV(req.query.causa2);
  const transportadoras = parseCSV(req.query.transportadora);
  const busca = (req.query.q || '').trim().toLowerCase();

  const passaFiltros = r =>
    (!turnos.length || turnos.includes(r.turno)) &&
    (!tiposCpt.length || tiposCpt.includes(r.type_cpt)) &&
    (!hubs.length || hubs.includes(r.hub)) &&
    (!causas1.length || causas1.includes(r.leftover_until_cap_causa_l1)) &&
    (!causas2.length || causas2.includes(r.leftover_until_cap_causa_l2)) &&
    (!transportadoras.length || transportadoras.includes(transportadoraDe(r))) &&
    (!busca || String(r.hub || '').toLowerCase().includes(busca) || String(r.observacao || '').toLowerCase().includes(busca));

  const filtradas = withDate.filter(passaFiltros);

  // Sem de/ate: só o dia mais recente disponível ("recente"). Com de e/ou
  // ate: intervalo livre ("historico"), lado que faltar usa o limite da
  // base — mesmo modelo do Outbound (api/outbound.js), trocado do antigo
  // dim (dia/semana/mês) pedido do Roberto em 2026-08-18.
  const deQuery = req.query.de ? new Date(req.query.de + 'T00:00:00Z') : null;
  const ateQuery = req.query.ate ? new Date(req.query.ate + 'T00:00:00Z') : null;
  const semFiltro = !deQuery && !ateQuery;
  const modo = semFiltro ? 'recente' : 'historico';
  const inicio = semFiltro ? maisRecente : (deQuery || maisAntiga);
  const fimBase = semFiltro ? maisRecente : (ateQuery || maisRecente);
  const fim = new Date(fimBase.getTime() + 86400000); // exclusivo

  // Período anterior = janela de mesma duração imediatamente antes de
  // `inicio` — generalização do antigo periodBefore(dim) pra um intervalo
  // de tamanho livre.
  const diasNoPeriodo = Math.round((fim - inicio) / 86400000);
  const fimAnt = inicio;
  const inicioAnt = new Date(inicio.getTime() - diasNoPeriodo * 86400000);

  const doPeriodo = filtradas.filter(r => r.__date >= inicio && r.__date < fim);
  const doPeriodoAnterior = filtradas.filter(r => r.__date >= inicioAnt && r.__date < fimAnt);

  const atual = aggregate(doPeriodo);
  const anterior = aggregate(doPeriodoAnterior);
  const delta = {};
  Object.keys(atual).forEach(k => { delta[k] = pctDelta(atual[k], anterior[k]); });

  // Transportadoras Ofensoras (pedido do Roberto em 2026-08-14): quebra por
  // transportadora do leftover do período, com % de impacto e quantas
  // viagens realizadas ela teve no mesmo período (conta via
  // rawdata_out_pulso, cpt_realizado preenchido + mesma janela de data pelo
  // cpt_scheduled_origin_edited) — pra dar noção de proporção, não só
  // volume absoluto de leftover.
  const viagensRealizadasPorTransportadora = new Map();
  outRows.forEach(r => {
    if (!r.used_agency_name || !r.cpt_realizado || !r.cpt_scheduled_origin_edited) return;
    const d = new Date(String(r.cpt_scheduled_origin_edited).replace(' ', 'T') + 'Z');
    if (isNaN(d) || d < inicio || d >= fim) return;
    viagensRealizadasPorTransportadora.set(r.used_agency_name, (viagensRealizadasPorTransportadora.get(r.used_agency_name) || 0) + 1);
  });
  const totalPacotesComTransportadora = doPeriodo.reduce((s, r) => s + (r.__transportadora ? toNum(r.leftover_until_cap) : 0), 0);
  const porTransportadoraMap = new Map();
  doPeriodo.forEach(r => {
    if (!r.__transportadora) return;
    const acc = porTransportadoraMap.get(r.__transportadora) || { pacotes: 0, registros: 0 };
    acc.pacotes += toNum(r.leftover_until_cap);
    acc.registros++;
    porTransportadoraMap.set(r.__transportadora, acc);
  });
  const porTransportadora = [...porTransportadoraMap.entries()]
    .map(([transportadora, acc]) => ({
      transportadora,
      pacotes: acc.pacotes,
      registros: acc.registros,
      pct: totalPacotesComTransportadora ? +(acc.pacotes / totalPacotesComTransportadora * 100).toFixed(1) : 0,
      viagensRealizadas: viagensRealizadasPorTransportadora.get(transportadora) || 0,
    }))
    .sort((a, b) => b.pacotes - a.pacotes);

  const uniq = key => [...new Set(withDate.map(r => r[key]).filter(Boolean))].sort();

  // Cobertura real da base (não o período filtrado) — pra avisar até quando os dados vão.
  const dataMinima = maisAntiga;
  const dataMaxima = maisRecente;

  // Limite alto: com a paginação no front (100/página), dá pra mandar o
  // período filtrado inteiro; o teto protege contra períodos gigantes.
  const LIMITE = 5000;
  const ordenadas = [...doPeriodo].sort((a, b) => b.__date - a.__date);
  const leftovers = ordenadas.slice(0, LIMITE).map(r => ({
    hub: r.hub,
    destino: r.hub,
    transportadora: transportadoraDe(r),
    type_cpt: r.type_cpt,
    turno: r.turno,
    hora: toNum(r.hora),
    cpt_planejado: r.cpt_planejado,
    leftover_until_cap: toNum(r.leftover_until_cap),
    leftover_until_cap_causa_l1: r.leftover_until_cap_causa_l1,
    leftover_until_cap_causa_l2: r.leftover_until_cap_causa_l2,
    expedido: toNum(r.expedido),
    backlog_2hrs_cpt: toNum(r.backlog_2hrs_cpt),
    observacao: r.observacao,
  }));

  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=1500');
  res.status(200).json({
    ok: true,
    atualizadoEm: new Date().toISOString(),
    modo,
    intervalo: { inicio: fmtDate(inicio), fim: fmtDate(new Date(fim - 86400000)) },
    cobertura: { inicio: fmtDate(dataMinima), fim: fmtDate(dataMaxima) },
    atual, anterior, delta,
    leftovers, leftoversTotal: doPeriodo.length,
    porTransportadora,
    opcoesFiltro: {
      turno: uniq('turno'),
      type_cpt: uniq('type_cpt'),
      hub: uniq('hub'),
      causa1: uniq('leftover_until_cap_causa_l1'),
      causa2: uniq('leftover_until_cap_causa_l2'),
      transportadora: [...new Set(withDate.map(transportadoraDe).filter(Boolean))].sort(),
    },
  });
};
