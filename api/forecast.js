/**
 * PULSO — Forecast por canal (aba forecast_backlog_pulso, colunas H-M).
 *
 * Colunas H-M (date, destination, origin_type, direct, transhipment, total)
 * são uma tabela independente do bloco de Backlog (colunas A-E, ver
 * api/backlog.js) — não têm relação linha a linha, só coexistem na mesma aba.
 *
 * Clusterização de origin_type (confirmado com o Roberto em 2026-07-31;
 * SOC corrigido de LH pra FM em 2026-08-03 — a soma de FM batia errado com
 * a base por causa disso). Os 7 valores reais na aba hoje são
 * FMH/INTER-SOC/CB/BIG SELLER/PUDO SVP/SOC/FULL — FM ainda não apareceu
 * como origin_type próprio, mas o mapeamento já cobre se/quando aparecer:
 *   FMH, INTER-SOC             -> LH
 *   FM, PUDO SVP, BIG SELLER, SOC -> FM
 *   CB                         -> CB
 *   FULL                       -> critério próprio (card/linha separada), mas soma no Total
 * `total` (= direct + transhipment) é o valor usado no forecast — cada canal
 * já vem com o transhipment embutido nesse campo. A linha "Transhipment" é só
 * informativa (quanto do total já é transhipment) e NUNCA é somada de novo.
 *
 * View semanal/mensal (confirmado com o Roberto em 2026-07-31):
 *   - Tabela agrupada por semana (segunda a domingo), cobrindo o mês de
 *     `date`. Cada semana tem os 7 dias, o total da semana ("Week") e o
 *     terceiro quartil (Q3, interpolação linear = QUARTILE.INC) dos 7 dias,
 *     por canal — no mesmo formato de linhas dos dias (Total/LH/FM/CB/FULL/
 *     Transhipment). Cada semana carrega `numero` (semana ISO-8601, pro
 *     rótulo "Semana (N) - dd/mm/aaaa à dd/mm/aaaa" pedido em 2026-08-03).
 *   - "Quartil" (mensal) = Q3 dos Q3 semanais, sempre sobre as 4 semanas de
 *     MAIOR volume (Forecast Total) do mês — em meses com 5 semanas (parcial
 *     sobrando no início/fim) a de menor volume é descartada (confirmado
 *     com o Roberto em 2026-08-03).
 *   - "ADO Quartil" = Quartil mensal / (nº de semanas usadas no Quartil,
 *     sempre 4), por canal.
 *   - Total do mês = soma só dos dias cujo `date` cai dentro do mês (não
 *     conta os dias de semanas vizinhas que "vazam" pro mês anterior/seguinte).
 *
 * Query params:
 *   date            YYYY-MM-DD — data de referência pros cards do topo E mês
 *                   exibido na tabela; default = hoje (ou a menor data
 *                   disponível, se hoje for anterior ao início do forecast)
 *   compDe, compAte YYYY-MM-DD — intervalo a comparar no card "Mês" (data vs
 *                   data, pedido do Roberto em 2026-08-05, não trava em mês-
 *                   calendário); default = mês anterior ao de `date` inteiro
 */
const { fetchTabByGid } = require('./_google');
const { toNum, hojeOperacionalIso } = require('./_period');
const { socDaSessaoOuErro } = require('./_users');

const SHEET = { spreadsheetId: '1BqZElDRwVaGpDYZzHTq9UQvVLy2guRVfTdvwGHL1qC4', gid: '202012183' };

const CLUSTER = {
  FMH: 'LH', 'INTER-SOC': 'LH',
  FM: 'FM', 'PUDO SVP': 'FM', 'BIG SELLER': 'FM', SOC: 'FM',
  CB: 'CB',
  FULL: 'FULL',
};

const CANAIS = ['total', 'lh', 'fm', 'cb', 'full', 'transhipment'];
const ZERO_AGG = { total: 0, lh: 0, fm: 0, cb: 0, full: 0, transhipment: 0 };

function brToIso(v) {
  const m = String(v || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function aggregate(rows) {
  const soma = { ...ZERO_AGG };
  rows.forEach(r => {
    const cluster = CLUSTER[r.origin_type];
    if (!cluster) return;
    const v = toNum(r.total);
    soma.total += v;
    soma.transhipment += toNum(r.transhipment);
    if (cluster === 'LH') soma.lh += v;
    else if (cluster === 'FM') soma.fm += v;
    else if (cluster === 'CB') soma.cb += v;
    else if (cluster === 'FULL') soma.full += v;
  });
  return soma;
}

function somaAgg(lista) {
  const soma = { ...ZERO_AGG };
  lista.forEach(a => CANAIS.forEach(c => { soma[c] += a[c] || 0; }));
  return soma;
}

// QUARTILE.INC (interpolação linear) — mesmo método padrão do Excel/Sheets.
function quartil3(valores) {
  const arr = [...valores].sort((a, b) => a - b);
  const n = arr.length;
  if (!n) return 0;
  if (n === 1) return arr[0];
  const pos = (n - 1) * 0.75;
  const base = Math.floor(pos);
  const resto = pos - base;
  const proximo = arr[base + 1] !== undefined ? arr[base + 1] : arr[base];
  return arr[base] + resto * (proximo - arr[base]);
}

function quartilAgg(lista) {
  const q = { ...ZERO_AGG };
  CANAIS.forEach(c => { q[c] = quartil3(lista.map(a => a[c] || 0)); });
  return q;
}

function segundaDaSemana(d) {
  const dia = (d.getUTCDay() + 6) % 7; // segunda = 0
  const seg = new Date(d);
  seg.setUTCDate(seg.getUTCDate() - dia);
  return seg;
}

// Número da semana no padrão ISO-8601 (semana 1 = a que contém a 1ª
// quinta-feira do ano; semanas começam na segunda).
function semanaISO(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const diaSemana = (date.getUTCDay() + 6) % 7; // segunda = 0
  date.setUTCDate(date.getUTCDate() - diaSemana + 3); // quinta-feira dessa semana
  const primeiraQuinta = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const diaSemanaPrimeira = (primeiraQuinta.getUTCDay() + 6) % 7;
  primeiraQuinta.setUTCDate(primeiraQuinta.getUTCDate() - diaSemanaPrimeira + 3);
  return 1 + Math.round((date - primeiraQuinta) / (7 * 24 * 3600 * 1000));
}

function addMonths(mesRefStr, delta) {
  const [y, m] = mesRefStr.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Total do mês (só dias dentro do mês) + nº de semanas (segunda-domingo) que tocam o mês —
// usado como divisor "dias produtivos" (6 por semana) do Ado Médio mensal.
function totalDoMes(mesRefStr, aggDia) {
  const [ano, mesNum] = mesRefStr.split('-').map(Number);
  const primeiroDiaMes = new Date(Date.UTC(ano, mesNum - 1, 1));
  const ultimoDiaMes = new Date(Date.UTC(ano, mesNum, 0));
  const dias = [];
  for (let d = new Date(primeiroDiaMes); d <= ultimoDiaMes; d.setUTCDate(d.getUTCDate() + 1)) {
    dias.push(aggDia(d.toISOString().slice(0, 10)));
  }
  const inicioSemanas = segundaDaSemana(primeiroDiaMes);
  const fimSemanas = segundaDaSemana(ultimoDiaMes);
  fimSemanas.setUTCDate(fimSemanas.getUTCDate() + 6);
  let numSemanas = 0;
  for (let seg = new Date(inicioSemanas); seg <= fimSemanas; seg.setUTCDate(seg.getUTCDate() + 7)) numSemanas++;
  return { total: somaAgg(dias), numSemanas };
}

// Total de um intervalo arbitrário de dias (pedido do Roberto em
// 2026-08-05: a comparação do card "Mês" tem que ser data vs data, não
// travada em mês-calendário — mesma soma de totalDoMes, só que sobre um
// range livre). numSemanas aqui é fracionário (dias ÷ 7), pra manter a
// mesma fórmula de "6 dias produtivos por semana" do Ado Médio proporcional
// a qualquer tamanho de range, não só um mês inteiro.
function totalDoRange(deIso, ateIso, aggDia) {
  const dias = [];
  for (let d = new Date(deIso + 'T00:00:00Z'); d <= new Date(ateIso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    dias.push(aggDia(d.toISOString().slice(0, 10)));
  }
  return { total: somaAgg(dias), numSemanas: dias.length / 7 };
}

function totalDaSemana(mondayIso, aggDia) {
  const start = new Date(mondayIso + 'T00:00:00Z');
  const dias = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    return aggDia(d.toISOString().slice(0, 10));
  });
  return somaAgg(dias);
}

// Variação % vs período anterior; null quando o período anterior é 0 (evita Infinity).
function pctDelta(atualV, anteriorV) {
  if (!anteriorV) return null;
  return ((atualV - anteriorV) / anteriorV) * 100;
}

module.exports = async (req, res) => {
  const soc = socDaSessaoOuErro(req, res);
  if (!soc) return;

  // forecast_backlog_pulso (colunas H-M) é implicitamente RJ2 (sem coluna
  // de SoC) — pra qualquer outro SoC, nem busca (melhor nada do que
  // misturar dado de RJ2 — pedido do Roberto em 2026-09-24). Mesma forma
  // "sem dado" já usada abaixo quando a aba vem vazia.
  if (soc !== 'RJ2') {
    const zeroCard = { forecast: 0, forecastVar: null, adoMedio: 0, adoMedioVar: null, transhipment: 0, transhipmentVar: null, adoTranshipment: 0, adoTranshipmentVar: null };
    res.status(200).json({
      ok: true, data: null, mes: null, compDe: null, compAte: null, atual: { ...ZERO_AGG },
      semanas: [], mesTotal: { ...ZERO_AGG }, quartilMensal: { ...ZERO_AGG }, adoQuartil: { ...ZERO_AGG },
      cardsPeriodo: { mes: zeroCard, week: { ...zeroCard }, dia: { ...zeroCard } },
      cobertura: { inicio: null, fim: null },
    });
    return;
  }

  let rows;
  try {
    ({ rows } = await fetchTabByGid(SHEET.spreadsheetId, SHEET.gid));
  } catch (err) {
    res.status(502).json({ ok: false, erro: err.message });
    return;
  }

  const forecast = rows
    .filter(r => r.date)
    .map(r => ({ ...r, dataIso: brToIso(r.date) }))
    .filter(r => r.dataIso !== null);

  if (!forecast.length) {
    const zeroCard = { forecast: 0, forecastVar: null, adoMedio: 0, adoMedioVar: null, transhipment: 0, transhipmentVar: null, adoTranshipment: 0, adoTranshipmentVar: null };
    res.status(200).json({
      ok: true, data: null, mes: null, compDe: null, compAte: null, atual: { ...ZERO_AGG },
      semanas: [], mesTotal: { ...ZERO_AGG }, quartilMensal: { ...ZERO_AGG }, adoQuartil: { ...ZERO_AGG },
      cardsPeriodo: { mes: zeroCard, week: { ...zeroCard }, dia: { ...zeroCard } },
      cobertura: { inicio: null, fim: null },
    });
    return;
  }

  const datasDisponiveis = [...new Set(forecast.map(r => r.dataIso))].sort();
  const dataMinima = datasDisponiveis[0], dataMaxima = datasDisponiveis[datasDisponiveis.length - 1];

  const hojeIso = hojeOperacionalIso();
  const dataQuery = req.query.date;
  const dataRef = (dataQuery && dataQuery >= dataMinima && dataQuery <= dataMaxima)
    ? dataQuery
    : (hojeIso >= dataMinima && hojeIso <= dataMaxima ? hojeIso : dataMinima);

  const porData = new Map();
  forecast.forEach(r => {
    if (!porData.has(r.dataIso)) porData.set(r.dataIso, []);
    porData.get(r.dataIso).push(r);
  });
  const aggDia = iso => aggregate(porData.get(iso) || []);

  const atual = aggDia(dataRef);
  const mesRef = dataRef.slice(0, 7); // YYYY-MM
  const [anoRef, mesNum] = mesRef.split('-').map(Number);
  const primeiroDiaMes = new Date(Date.UTC(anoRef, mesNum - 1, 1));
  const ultimoDiaMes = new Date(Date.UTC(anoRef, mesNum, 0));

  const DIAS = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'];

  const inicioSemanas = segundaDaSemana(primeiroDiaMes);
  const fimSemanas = segundaDaSemana(ultimoDiaMes);
  fimSemanas.setUTCDate(fimSemanas.getUTCDate() + 6);

  const semanas = [];
  for (let seg = new Date(inicioSemanas); seg <= fimSemanas; seg.setUTCDate(seg.getUTCDate() + 7)) {
    const dias = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(seg);
      d.setUTCDate(d.getUTCDate() + i);
      const iso = d.toISOString().slice(0, 10);
      return { data: iso, diaSemana: DIAS[i], ...aggDia(iso) };
    });
    const inicioIso = dias[0].data, fimIso = dias[6].data;
    semanas.push({
      numero: semanaISO(seg),
      inicio: inicioIso,
      fim: fimIso,
      isCurrent: hojeIso >= inicioIso && hojeIso <= fimIso,
      dias,
      semana: somaAgg(dias),
      quartil: quartilAgg(dias),
    });
  }

  const diasDoMes = [];
  for (let d = new Date(primeiroDiaMes); d <= ultimoDiaMes; d.setUTCDate(d.getUTCDate() + 1)) {
    diasDoMes.push(aggDia(d.toISOString().slice(0, 10)));
  }
  const mesTotal = somaAgg(diasDoMes);

  // Quartil mensal sempre sobre as 4 semanas de maior volume do mês (Forecast
  // Total da semana) — meses com 5 semanas (parcial no início/fim) descartam
  // a de menor volume, confirmado com o Roberto em 2026-08-03.
  const semanasPico = [...semanas].sort((a, b) => b.semana.total - a.semana.total).slice(0, 4);
  const quartilMensal = quartilAgg(semanasPico.map(s => s.quartil));
  const adoQuartil = {};
  // Divisor = quantidade de semanas usadas no Quartil (semanasPico.length,
  // sempre 4 — confirmado com o Roberto em 2026-08-03), não um número fixo.
  const divisorAdoQuartil = Math.max(semanasPico.length, 1);
  CANAIS.forEach(c => { adoQuartil[c] = quartilMensal[c] / divisorAdoQuartil; });

  // ── Cards por período (Mês/Week/Dia) + variação vs período anterior ──
  const semanaRef = semanas.find(s => dataRef >= s.inicio && dataRef <= s.fim) || semanas[semanas.length - 1];

  // Comparação do card "Mês" — data vs data (pedido do Roberto em
  // 2026-08-05), não mês-calendário vs mês-calendário. Default = mês
  // anterior inteiro (primeiro ao último dia), mas o usuário pode escolher
  // qualquer intervalo via compDe/compAte.
  const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;
  const compDeQuery = req.query.compDe, compAteQuery = req.query.compAte;
  let compDe, compAte;
  if (compDeQuery && compAteQuery && DATA_RE.test(compDeQuery) && DATA_RE.test(compAteQuery) && compDeQuery <= compAteQuery) {
    compDe = compDeQuery;
    compAte = compAteQuery;
  } else {
    const mesAnteriorRef = addMonths(mesRef, -1);
    const [anoAnt, mesNumAnt] = mesAnteriorRef.split('-').map(Number);
    compDe = new Date(Date.UTC(anoAnt, mesNumAnt - 1, 1)).toISOString().slice(0, 10);
    compAte = new Date(Date.UTC(anoAnt, mesNumAnt, 0)).toISOString().slice(0, 10);
  }
  const mesAnteriorCalc = totalDoRange(compDe, compAte, aggDia);
  const numSemanasMesAtual = semanas.length;

  const semanaAnteriorSeg = new Date(semanaRef.inicio + 'T00:00:00Z');
  semanaAnteriorSeg.setUTCDate(semanaAnteriorSeg.getUTCDate() - 7);
  const semanaAnterior = totalDaSemana(semanaAnteriorSeg.toISOString().slice(0, 10), aggDia);

  const diaAnteriorDate = new Date(dataRef + 'T00:00:00Z');
  diaAnteriorDate.setUTCDate(diaAnteriorDate.getUTCDate() - 1);
  const diaAnterior = aggDia(diaAnteriorDate.toISOString().slice(0, 10));

  const adoMedioMes = mesTotal.total / (6 * Math.max(numSemanasMesAtual, 1));
  const adoMedioMesAnterior = mesAnteriorCalc.total.total / (6 * Math.max(mesAnteriorCalc.numSemanas, 1));
  const adoMedioWeek = semanaRef.semana.total / 6;
  const adoMedioWeekAnterior = semanaAnterior.total / 6;

  // Ado Transhipment = mesma lógica do Ado Médio (÷ 6 dias produtivos), aplicada ao Transhipment.
  const adoTranshipmentMes = mesTotal.transhipment / (6 * Math.max(numSemanasMesAtual, 1));
  const adoTranshipmentMesAnterior = mesAnteriorCalc.total.transhipment / (6 * Math.max(mesAnteriorCalc.numSemanas, 1));
  const adoTranshipmentWeek = semanaRef.semana.transhipment / 6;
  const adoTranshipmentWeekAnterior = semanaAnterior.transhipment / 6;

  const cardsPeriodo = {
    mes: {
      forecast: mesTotal.total, forecastVar: pctDelta(mesTotal.total, mesAnteriorCalc.total.total),
      adoMedio: adoMedioMes, adoMedioVar: pctDelta(adoMedioMes, adoMedioMesAnterior),
      transhipment: mesTotal.transhipment, transhipmentVar: pctDelta(mesTotal.transhipment, mesAnteriorCalc.total.transhipment),
      adoTranshipment: adoTranshipmentMes, adoTranshipmentVar: pctDelta(adoTranshipmentMes, adoTranshipmentMesAnterior),
    },
    week: {
      forecast: semanaRef.semana.total, forecastVar: pctDelta(semanaRef.semana.total, semanaAnterior.total),
      adoMedio: adoMedioWeek, adoMedioVar: pctDelta(adoMedioWeek, adoMedioWeekAnterior),
      transhipment: semanaRef.semana.transhipment, transhipmentVar: pctDelta(semanaRef.semana.transhipment, semanaAnterior.transhipment),
      adoTranshipment: adoTranshipmentWeek, adoTranshipmentVar: pctDelta(adoTranshipmentWeek, adoTranshipmentWeekAnterior),
    },
    dia: {
      forecast: atual.total, forecastVar: pctDelta(atual.total, diaAnterior.total),
      adoMedio: atual.total, adoMedioVar: pctDelta(atual.total, diaAnterior.total),
      transhipment: atual.transhipment, transhipmentVar: pctDelta(atual.transhipment, diaAnterior.transhipment),
      adoTranshipment: atual.transhipment, adoTranshipmentVar: pctDelta(atual.transhipment, diaAnterior.transhipment),
    },
  };

  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=1500');
  res.status(200).json({
    ok: true,
    data: dataRef,
    mes: mesRef,
    compDe, compAte,
    atual,
    semanas,
    mesTotal,
    quartilMensal,
    adoQuartil,
    cardsPeriodo,
    cobertura: { inicio: dataMinima, fim: dataMaxima },
  });
};
