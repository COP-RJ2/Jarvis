/**
 * PULSO — agregação da base SPR (viagens/trips).
 *
 * A aba spr_pulso tem ~20 mil linhas / ~15MB em JSON — grande demais pra
 * mandar pro navegador a cada mudança de filtro. Esta function busca a
 * planilha, filtra e agrega no servidor, devolvendo só os números prontos
 * pros cards (+ as opções disponíveis pra popular os filtros).
 *
 * Query params:
 *   de, ate     YYYY-MM-DD (opcionais). Sem os dois: mostra só o dia mais
 *               recente disponível na base ("recente"). Com de/ate: intervalo
 *               livre ("histórico") — lado que faltar usa o limite da base.
 *               Trocado do antigo dim (dia/semana/mês) + data única pro
 *               mesmo modelo De/Até do Outbound, pedido do Roberto em
 *               2026-08-18 ("fica melhor").
 *   turno       lista separada por vírgula (ex: T1,T2)
 *   solicitation_by, destination, vehicle, agency  idem, listas separadas por vírgula
 *   canal       lista separada por vírgula (ex: HUB,SOC) — prefixo de destination_station_code
 *               antes do primeiro "-"; não existe coluna própria pra isso na planilha
 *   q           texto livre pra busca em destination_station_code (contains)
 */
const { fetchTabByGid } = require('./_google');
const { fmtDate, toNum, parseCSV, pctDelta } = require('./_period');
const { socDaSessaoOuErro } = require('./_users');

const SPR_SHEET = { spreadsheetId: '1BqZElDRwVaGpDYZzHTq9UQvVLy2guRVfTdvwGHL1qC4', gid: '1276487267' };

// Não existe coluna de "canal" na planilha — deriva do prefixo do código da
// estação de destino (ex: "HUB-LMG-15" -> "HUB", "SOC-RJ2" -> "SOC").
function canalDe(destino) {
  const m = String(destino || '').match(/^([A-Za-z]+)-/);
  return m ? m[1].toUpperCase() : null;
}

function aggregate(rows) {
  const tripCount = rows.length;
  const totalOrders = rows.reduce((s, r) => s + toNum(r.total_orders), 0);
  const totalToScuttle = rows.reduce((s, r) => s + toNum(r.to_scuttle), 0);
  const totalToSaca = rows.reduce((s, r) => s + toNum(r.to_saca), 0);
  return {
    viagens: tripCount,
    pedidosPorViagem: tripCount ? +(totalOrders / tripCount).toFixed(1) : 0,
    ordersScuttle: rows.reduce((s, r) => s + toNum(r.orders_scuttle), 0),
    ordersSaca: rows.reduce((s, r) => s + toNum(r.orders_saca), 0),
    toScuttle: totalToScuttle,
    toSaca: totalToSaca,
    // "Ocupação média" = quantos scuttles/sacas em média por viagem (mesmo
    // cálculo do pedidosPorViagem, aplicado a to_scuttle/to_saca).
    ocupacaoMediaScuttle: tripCount ? +(totalToScuttle / tripCount).toFixed(1) : 0,
    ocupacaoMediaSaca: tripCount ? +(totalToSaca / tripCount).toFixed(1) : 0,
    // SPP médio por unitizador (pedido do Roberto em 2026-08-14, confirmado:
    // "Orders Scuttle / TO Scuttle e a mesma coisa pra saca") = pedidos por
    // unitizador usado, em média — não é por viagem, é por scuttle/saca.
    sppScuttle: totalToScuttle ? +(rows.reduce((s, r) => s + toNum(r.orders_scuttle), 0) / totalToScuttle).toFixed(1) : 0,
    sppSaca: totalToSaca ? +(rows.reduce((s, r) => s + toNum(r.orders_saca), 0) / totalToSaca).toFixed(1) : 0,
  };
}

module.exports = async (req, res) => {
  const soc = socDaSessaoOuErro(req, res);
  if (!soc) return;

  // spr_pulso é implicitamente RJ2 (sem coluna de SoC) — pra qualquer outro
  // SoC, nem busca (melhor nada do que misturar dado de RJ2 — pedido do
  // Roberto em 2026-09-24). Mesma forma da resposta de sucesso, só com os
  // campos de dado vazios/zerados.
  if (soc !== 'RJ2') {
    const atualVazio = aggregate([]);
    res.status(200).json({
      ok: true,
      atualizadoEm: new Date().toISOString(),
      modo: 'recente',
      intervalo: { inicio: null, fim: null },
      cobertura: { inicio: null, fim: null },
      atual: atualVazio, anterior: atualVazio, delta: Object.fromEntries(Object.keys(atualVazio).map(k => [k, null])),
      viagens: [], viagensTotal: 0,
      opcoesFiltro: { turno: [], solicitation_by: [], destination_station_code: [], used_vehicle: [], used_agency_name: [], canal: [] },
    });
    return;
  }

  let rows;
  try {
    ({ rows } = await fetchTabByGid(SPR_SHEET.spreadsheetId, SPR_SHEET.gid));
  } catch (err) {
    res.status(502).json({ ok: false, erro: err.message });
    return;
  }

  const withDate = rows
    .map(r => ({ ...r, __date: r.cutoff_date ? new Date(r.cutoff_date + 'T00:00:00Z') : null }))
    .filter(r => r.__date && !isNaN(r.__date));

  const maisRecente = withDate.reduce((max, r) => (r.__date > max ? r.__date : max), withDate[0]?.__date || new Date());
  const maisAntiga = withDate.reduce((min, r) => (r.__date < min ? r.__date : min), withDate[0]?.__date || maisRecente);

  const turnos = parseCSV(req.query.turno);
  const solicitantes = parseCSV(req.query.solicitation_by);
  const destinos = parseCSV(req.query.destination);
  const veiculos = parseCSV(req.query.vehicle);
  const agencias = parseCSV(req.query.agency);
  const canais = parseCSV(req.query.canal);
  const busca = (req.query.q || '').trim().toLowerCase();

  const passaFiltros = r =>
    (!turnos.length || turnos.includes(r.turno)) &&
    (!solicitantes.length || solicitantes.includes(r.solicitation_by)) &&
    (!destinos.length || destinos.includes(r.destination_station_code)) &&
    (!veiculos.length || veiculos.includes(r.used_vehicle)) &&
    (!agencias.length || agencias.includes(r.used_agency_name)) &&
    (!canais.length || canais.includes(canalDe(r.destination_station_code))) &&
    (!busca || String(r.destination_station_code || '').toLowerCase().includes(busca));

  const filtradas = withDate.filter(passaFiltros);

  // Sem de/ate: só o dia mais recente disponível ("recente"). Com de e/ou
  // ate: intervalo livre ("historico"), lado que faltar usa o limite da
  // base — mesmo modelo do Outbound (api/outbound.js).
  const deQuery = req.query.de ? new Date(req.query.de + 'T00:00:00Z') : null;
  const ateQuery = req.query.ate ? new Date(req.query.ate + 'T00:00:00Z') : null;
  const semFiltro = !deQuery && !ateQuery;
  const modo = semFiltro ? 'recente' : 'historico';
  const inicio = semFiltro ? maisRecente : (deQuery || maisAntiga);
  const fimBase = semFiltro ? maisRecente : (ateQuery || maisRecente);
  const fim = new Date(fimBase.getTime() + 86400000); // exclusivo, mesma convenção do periodEnd antigo

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

  const uniq = key => [...new Set(withDate.map(r => r[key]).filter(Boolean))].sort();

  // Cobertura real da base (não o período filtrado) — pra avisar até quando os dados vão.
  const dataMinima = maisAntiga;
  const dataMaxima = maisRecente;

  // Limite alto: com a paginação no front (100/página), dá pra mandar o
  // período filtrado inteiro; o teto protege contra períodos gigantes.
  const LIMITE_VIAGENS = 5000;
  const ordenadas = [...doPeriodo].sort((a, b) => b.__date - a.__date);
  const viagens = ordenadas.slice(0, LIMITE_VIAGENS).map(r => ({
    trip_number: r.trip_number,
    status_agrupado: r.status_agrupado,
    solicitation_by: r.solicitation_by,
    origin_station_code: r.origin_station_code,
    destination_station_code: r.destination_station_code,
    total_orders: toNum(r.total_orders),
    used_vehicle: r.used_vehicle,
    used_agency_name: r.used_agency_name,
    turno: r.turno,
    cpt_scheduled_origin_edited: r.cpt_scheduled_origin_edited,
    // Sacas/scuttles por viagem (pedido do Roberto em 2026-08-24, view "SPR
    // por Destino") — mesmos campos já usados pra "Ocupação Média" nos KPIs
    // agregados acima, agora expostos por linha pra dar pra agregar por
    // destino no front.
    to_scuttle: toNum(r.to_scuttle),
    to_saca: toNum(r.to_saca),
  }));

  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=1500');
  res.status(200).json({
    ok: true,
    atualizadoEm: new Date().toISOString(),
    modo,
    intervalo: { inicio: fmtDate(inicio), fim: fmtDate(new Date(fim - 86400000)) },
    cobertura: { inicio: fmtDate(dataMinima), fim: fmtDate(dataMaxima) },
    atual, anterior, delta,
    viagens, viagensTotal: doPeriodo.length,
    opcoesFiltro: {
      turno: uniq('turno'),
      solicitation_by: uniq('solicitation_by'),
      destination_station_code: uniq('destination_station_code'),
      used_vehicle: uniq('used_vehicle'),
      used_agency_name: uniq('used_agency_name'),
      canal: [...new Set(withDate.map(r => canalDe(r.destination_station_code)).filter(Boolean))].sort(),
    },
  });
};
