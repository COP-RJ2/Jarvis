/**
 * PULSO — agregação da base Clusterização (endereçamento de TOs em ruas do CD).
 *
 * Diferente do SPR/Leftover, essa página é "ao vivo": não tem filtro de
 * dia/semana/mês nem comparação vs período anterior (decidido com o Roberto
 * em 2026-07-30). Os filtros (To Pack, Destino, Rua) afetam TUDO — cards,
 * grade de ruas e a tabela de TOs (decidido com o Roberto em 2026-07-30,
 * revertendo o design anterior onde só a tabela era filtrada).
 *
 * IMPORTANTE (corrigido em 2026-08-04): a aba cluster_pulso NÃO tem mais as
 * colunas `rua`/`destino`/`stage`/`aging` que essa página assumia antes — o
 * export do sistema de origem mudou. As colunas reais hoje são `receiver`
 * (= destino) e `staging area` (código tipo "OBS-03CW", ou "-" quando o TO
 * ainda não tem posição física). O Roberto adicionou uma aba `config` com o
 * de-para código→rua (`staging area id`→`staging area name`) e a capacidade
 * real de cada rua (`capacity`) nas colunas H-J. Cada linha do cluster_pulso
 * é reconciliada nesse de-para pra reconstruir `destino`/`rua`/`stage`
 * (ENDEREÇADO = código bate com uma rua do de-para; PENDENTE = "-" ou código
 * não encontrado) antes de rodar a agregação de sempre. O roster de ruas
 * (antes fixo em 142+reservas hardcoded) agora vem inteiro da aba `config`,
 * na ordem em que aparece lá — inclui a RESERVA 37A automaticamente, sem
 * precisar hardcodar onde ela fica. Capacidade por rua também vem de lá
 * (antes era fixa em 20 pra todas).
 * `aging` não existe mais como coluna — recalculado aqui como horas desde
 * `create time` até agora (assunção; ajustar se o Roberto quiser outra base).
 * Roster limitado à RUA 142 (mapa físico, confirmado em 2026-08-04) — ruas
 * além disso existem na config mas ficam fora do roster/de-para.
 *
 * Correção de clusterização (`cluster`, coluna nova na config = destino
 * esperado por rua, confirmado em 2026-08-04): rua vazia OU cujo destino
 * dominante (fanout) bate o esperado = correta; rua ocupada com fanout
 * diferente = incorreta. `atual.ruasCorretas`/`ruasIncorretas`/
 * `pctClusterizacao` resumem isso; cada item de `grade` carrega
 * `clusterEsperado`/`clusterCorreto`.
 *
 * Colunas derivadas na tabela de TOs (confirmado com o Roberto em
 * 2026-08-04, `to pack`/`operator` originais nunca são alterados):
 *   origem:        Saca Sorter -> Sorter · Scuttle -> Esteira · resto vazio
 *   classificacao: operator=spx@shopee.com + to pack=Saca    -> ASM
 *                  operator=spx@shopee.com + to pack=Scuttle -> Transbordo
 *                  resto vazio
 *
 * Resíduo operacional: TO com quantity < 15 E aging > 15 dias (360h) some
 * de TUDO (cards/grade/tabela) — filtrado logo depois do de-para, antes de
 * qualquer agregação.
 *
 * `stage`=ENDEREÇADO = TO já ocupa 1 posição física na `rua` indicada;
 * `stage`=PENDENTE (`rua`="Pendente") = TO ainda sem rua física.
 *
 * `atual.att`: data/hora máxima de `complete time` no conjunto filtrado —
 * "última atualização" real do piso (a tabela de TOs também ordena por essa
 * coluna, não mais por create time).
 *
 * "to pack": para fins de filtro, "Saca Sorter" e "Saca" são tratados como
 * um único unitizador ("Saca") — ver `toPackGrupo()`. Nos cards, a mesma
 * junção vale pro card "Total de Sacas"; "Scuttle" tem card próprio;
 * "Volumoso"/"Pallet"/"-" entram só no total geral de pacotes.
 *
 * Classificação por transportadora (`destinoCategoria`, a partir do prefixo
 * de `destino`): SoC_ / XPT_ / "LM Hub_" / o resto = 3PL. Confirmado com o
 * Roberto em 2026-07-30: só SoC/XPT/LM Hub são efetivamente endereçados
 * (recebem rua); 3PL vai pra uma área própria que não é endereçada — por
 * isso o card "Pendentes" (pacotes de Saca/Scuttle ainda sem rua) EXCLUI
 * 3PL, senão infla o indicador com volume que nunca ia ganhar endereço.
 * Cada categoria (SoC/XPT/LM Hub/3PL) tem 2 cards: "<Categoria> Sacas" e
 * "<Categoria> Scuttle", cada um com a contagem de TOs entre parênteses
 * (não existe card separado de "TOs" — consolidado dentro do card de
 * pacotes, ver countKey/countSuffix em index.html).
 * Todo card de pacotes (Total de Pacotes/Sacas/Scuttles, Pendentes, os por
 * categoria) segue o mesmo padrão: quantidade de pacotes + (N TOs).
 *
 * `grade`: 1 item por rua do roster (config). Campos que o modelo visual
 * antigo tinha mas não existem em cluster_pulso (SPP posição, doca, próx.
 * CPT, timer CPT, cluster ideal) ficam de fora — decidido com o Roberto em
 * 2026-07-30, adicionar depois se a coluna surgir.
 *
 * Query params (afetam cards, grade e tabela):
 *   to_pack              lista separada por vírgula, valores agrupados (Saca/Scuttle/Volumoso/Pallet/-)
 *   destino, rua          listas separadas por vírgula
 *   q                     busca livre em "to number" + destino
 */
const { fetchTabByGid, listTabs } = require('./_google');
const { toNum, parseCSV } = require('./_period');

const CLUSTER_SHEET = { spreadsheetId: '1BqZElDRwVaGpDYZzHTq9UQvVLy2guRVfTdvwGHL1qC4', gid: '646168208' };
const CONFIG_SHEET = { spreadsheetId: '1BqZElDRwVaGpDYZzHTq9UQvVLy2guRVfTdvwGHL1qC4', gid: '1408724077' };
// Fonte dedicada da Esteira On-time (confirmado com o Roberto em 2026-08-10)
// — colunas: pack_name, dest_station_name, total_quantity, turno,
// data_ajustada, dest_corrigido. Usa dest_corrigido (não dest_station_name)
// pro fanout — é a coluna que já vem tratada/corrigida da origem.
const BALANCEAMENTO_SHEET = { spreadsheetId: '1BqZElDRwVaGpDYZzHTq9UQvVLy2guRVfTdvwGHL1qC4', gid: '960444672' };

const SACA_TIPOS = new Set(['Saca Sorter', 'Saca']);
const SCUTTLE_TIPOS = new Set(['Scuttle']);

// Agrupa "Saca Sorter"+"Saca" num único unitizador pra filtro/exibição.
function toPackGrupo(tp) {
  if (SACA_TIPOS.has(tp)) return 'Saca';
  if (SCUTTLE_TIPOS.has(tp)) return 'Scuttle';
  return tp || '-';
}

// SoC_ / XPT_ / "LM Hub_" identificam quem efetivamente recebe endereço de
// rua; qualquer outro prefixo (3PL, ex: "J&TNewLM") vai pra uma área que não
// é endereçada. Usado pra Clusterização (cluster_pulso, coluna `destino`).
function destinoCategoria(destino) {
  const d = String(destino || '');
  if (/^SoC_/i.test(d)) return 'SoC';
  if (/^XPT_/i.test(d)) return 'XPT';
  if (/^LM Hub_/i.test(d)) return 'LM Hub';
  return '3PL';
}

// Classificação da Esteira On-time (dest_corrigido, balanceamento_pulso) —
// espec fechada com o Roberto em 2026-08-10: HUB = começa com "LM", XPT =
// começa com "XPT", SOC = começa com "SoC", resto = 3PL. Prefixo mais solto
// que destinoCategoria (que exige "LM Hub_"/"SoC_" com underscore) — usar
// função própria em vez de reaproveitar destinoCategoria pra não acoplar as
// duas páginas por engano caso uma mude de regra sem a outra.
function esteiraDestinoCategoria(destino) {
  const d = String(destino || '');
  if (/^LM/i.test(d)) return 'LM Hub';
  if (/^XPT/i.test(d)) return 'XPT';
  if (/^SoC/i.test(d)) return 'SoC';
  return '3PL';
}

// Aging médio ignorando outliers (pedido do Roberto em 2026-08-04): o
// resíduo operacional já é filtrado antes de chegar aqui (ver comData mais
// abaixo), mas ainda sobram TOs com aging muito acima do normal (parado
// há muito tempo sem bater o critério de resíduo) que puxam a média pra
// cima e escondem a "oportunidade" real. Cerca IQR (Q3 + 1.5×IQR) — método
// estatístico padrão pra outlier, não um corte arbitrário.
// `aging` NÃO passa por toNum aqui (nem nos outros pontos deste arquivo):
// ele já é um Number calculado logo acima (+(...).toFixed(1)), e toNum é
// feito pra string em formato BR ("1.234,56") — ele remove o ponto, então
// toNum(88.9) devolvia 889, inflando o aging em 10x sempre que havia casa
// decimal. Bug encontrado em 2026-08-13 comparando o painel de ruas do
// Monitor - Live (que calcula certo) com esta página.
function agingMedioSemOutliers(rows) {
  const valores = rows.map(r => r.aging).sort((a, b) => a - b);
  if (!valores.length) return 0;
  const q1 = valores[Math.floor(valores.length * 0.25)];
  const q3 = valores[Math.floor(valores.length * 0.75)];
  const cerca = q3 + (q3 - q1) * 1.5;
  const semOutliers = valores.filter(v => v <= cerca);
  const usar = semOutliers.length ? semOutliers : valores;
  return +(usar.reduce((s, v) => s + v, 0) / usar.length).toFixed(1);
}

// ── Esteira On-time (balanceamento de bancadas) ─────────────────────────
// Fonte: aba balanceamento_pulso (ver BALANCEAMENTO_SHEET), já pré-agregada
// por destino/dia — não a base de TOs do cluster_pulso. Alimenta a visão de
// esteiras SOC/HUB/Termo (mockup do Roberto, "esteira.html" — estrutura
// preservada 1:1, só a fonte dos dados mudou de um blob estático pra esse
// endpoint). Só pack_name "Scuttle"/"Pallet"/"Volumoso" entram no
// balanceamento (Saca/vazio ficam de fora). Espec fechada com o Roberto em
// 2026-08-11 ("Lógica de balanceamento das esteiras (SOC e HUB)"):
//   Esteira SOC = destinos SOC + 3PL · Esteira HUB = destinos HUB + XPT.
//   Esteira Termo reaproveita os mesmos bins do HUB até existir base própria.
//
// share (usado em TODO o resultado — destino, bancada e lado) é sempre
// sobre o total GERAL das duas esteiras juntas, não o total só da esteira
// — ver grandTotal abaixo.
//
// Balanceamento em 2 etapas, aplicado dentro de cada esteira:
//   1. Partição gulosa entre Lado Esquerda/Direita — cada destino (do maior
//      pro menor volume) vai inteiro pro lado com menor soma acumulada.
//   2. Dentro do lado, aloca às 5 bancadas contra um perfil de peso-alvo
//      decrescente [1.15, 1.06, 1.00, 0.94, 0.85]: pra cada destino (do
//      maior pro menor), escolhe a bancada cujo (total atual da bancada ÷
//      total do lado) ÷ peso-alvo da posição for o menor — a mais "carente"
//      em relação à sua meta proporcional.
const ESTEIRA_PESO_ALVO_BANCADA = [1.15, 1.06, 1.00, 0.94, 0.85];
function esteiraAlocarBancadas(destinosLado, totalLado) {
  const bancadas = Array.from({ length: 5 }, () => ({ total: 0, destinos: [] }));
  destinosLado.forEach(d => {
    let melhor = 0, melhorScore = Infinity;
    for (let i = 0; i < 5; i++) {
      const score = (totalLado ? bancadas[i].total / totalLado : 0) / ESTEIRA_PESO_ALVO_BANCADA[i];
      if (score < melhorScore) { melhorScore = score; melhor = i; }
    }
    bancadas[melhor].total += d.qty;
    bancadas[melhor].destinos.push(d);
  });
  return bancadas;
}
// "Break Share" (só Esteira SOC, confirmado com o Roberto em 2026-08-11):
// quando o lado tem MENOS destinos do que bancadas (5), o algoritmo normal
// deixa bancadas ociosas (cada destino é indivisível, então sobra vaga sem
// volume nenhum). Nesse caso cada destino do lado é dividido igualmente
// pelas 5 bancadas — a mesma "oferta" aparece em várias bancadas, share
// dividido por 5. Com 5+ destinos no lado, comporta-se igual ao algoritmo
// normal (item suficiente pra não precisar quebrar).
function esteiraAlocarBancadasComBreakShare(destinosLado, totalLado) {
  if (destinosLado.length === 0 || destinosLado.length >= 5) {
    return esteiraAlocarBancadas(destinosLado, totalLado);
  }
  const bancadas = Array.from({ length: 5 }, () => ({ total: 0, destinos: [] }));
  destinosLado.forEach(d => {
    const parte = d.qty / 5;
    for (let i = 0; i < 5; i++) {
      bancadas[i].total += parte;
      bancadas[i].destinos.push({ dest: d.dest, qty: parte });
    }
  });
  return bancadas;
}
function esteiraBuildBins(rows, categoriasIncluidas, breakShare) {
  const porDestino = new Map();
  rows.forEach(r => {
    if (!r.destino || !categoriasIncluidas.includes(esteiraDestinoCategoria(r.destino))) return;
    porDestino.set(r.destino, (porDestino.get(r.destino) || 0) + toNum(r.quantity));
  });
  const destinos = [...porDestino.entries()].map(([dest, qty]) => ({ dest, qty })).sort((a, b) => b.qty - a.qty);
  // share sempre contra o total DESSA esteira (SoC contra o total de SoC,
  // Hub contra o total de Hub) — confirmado com o Roberto em 2026-08-12,
  // não mais contra o total geral das duas esteiras somadas.
  const totalGrupo = destinos.reduce((s, d) => s + d.qty, 0);

  // Break Share no nível da esteira inteira (10 bancadas, os 2 lados): com
  // poucos destinos, a partição gulosa Lado A/B (passo seguinte) jogaria
  // tudo pra um lado só, deixando o outro inteiro vazio — mesmo problema do
  // "só uma bancada balanceada" só que um nível acima. Quando tem menos de
  // 10 destinos no total, pula a partição e divide cada destino igualmente
  // pelas 10 bancadas (5 de cada lado) — bug reportado pelo Roberto em
  // 2026-08-11 ("SOC ainda divergente" mesmo após o Break Share por lado).
  if (breakShare && destinos.length > 0 && destinos.length < 10) {
    const bins = [];
    ['Lado A', 'Lado B'].forEach(lado => {
      for (let i = 0; i < 5; i++) {
        let total = 0;
        const binDestinos = destinos.map(d => {
          const parte = d.qty / 10;
          total += parte;
          return { dest: d.dest, qty: parte, share: totalGrupo ? parte / totalGrupo : 0 };
        });
        bins.push({ lado, posicao: i + 1, total, share: totalGrupo ? total / totalGrupo : 0, destinos: binDestinos });
      }
    });
    return bins;
  }

  let totalA = 0, totalB = 0;
  const ladoA = [], ladoB = [];
  destinos.forEach(d => {
    if (totalA <= totalB) { ladoA.push(d); totalA += d.qty; }
    else { ladoB.push(d); totalB += d.qty; }
  });

  const alocar = breakShare ? esteiraAlocarBancadasComBreakShare : esteiraAlocarBancadas;
  const bins = [];
  [['Lado A', ladoA, totalA], ['Lado B', ladoB, totalB]].forEach(([lado, destinosLado, totalLado]) => {
    alocar(destinosLado, totalLado).forEach((b, i) => {
      bins.push({
        lado, posicao: i + 1, total: b.total,
        share: totalGrupo ? b.total / totalGrupo : 0,
        destinos: b.destinos.map(d => ({ dest: d.dest, qty: d.qty, share: totalGrupo ? d.qty / totalGrupo : 0 })),
      });
    });
  });
  return bins;
}
function buildEsteira(rows) {
  const porDestino = new Map();
  rows.forEach(r => {
    if (!r.destino) return;
    porDestino.set(r.destino, (porDestino.get(r.destino) || 0) + toNum(r.quantity));
  });
  const grandTotal = [...porDestino.values()].reduce((s, q) => s + q, 0);
  const part1 = [...porDestino.entries()]
    .map(([dest, qty]) => ({ dest, qty, share: grandTotal ? qty / grandTotal : 0 }))
    .sort((a, b) => b.qty - a.qty);

  const classifiedTotals = { SOC: 0, HUB: 0, XPT: 0, '3PL': 0 };
  rows.forEach(r => {
    if (!r.destino) return;
    const cat = esteiraDestinoCategoria(r.destino);
    const key = cat === 'SoC' ? 'SOC' : cat === 'LM Hub' ? 'HUB' : cat === 'XPT' ? 'XPT' : '3PL';
    classifiedTotals[key] += toNum(r.quantity);
  });

  // Grupos (espec fechada com o Roberto em 2026-08-11): Esteira SOC = SOC +
  // 3PL · Esteira HUB = HUB + XPT (Termo reaproveita os bins do HUB). Share
  // de bancada/destino sempre contra o total DAQUELE canal (SoC contra o
  // total de SoC, Hub contra o total de Hub — confirmado com o Roberto em
  // 2026-08-12), não mais contra o grandTotal — esse só é usado no part1
  // (ranking geral, que compara as duas esteiras lado a lado de propósito).
  // Break Share (só SOC — confirmado com o Roberto): SOC costuma ter poucos
  // destinos com volume, então sem quebra a maioria das bancadas fica
  // ociosa; ver esteiraAlocarBancadasComBreakShare.
  const socBins = esteiraBuildBins(rows, ['SoC', '3PL'], true);
  const hubBins = esteiraBuildBins(rows, ['LM Hub', 'XPT']);
  return { part1, classified_totals: classifiedTotals, soc_bins: socBins, hub_bins: hubBins };
}

function aggregate(rows) {
  const totalRegistros = rows.length;
  const pacotesTotal = rows.reduce((s, r) => s + toNum(r.quantity), 0);

  let pacotesSaca = 0, pacotesSacaTOs = 0, pacotesScuttle = 0, pacotesScuttleTOs = 0;
  const catVazia = () => ({ saca: 0, sacaTOs: 0, scuttle: 0, scuttleTOs: 0 });
  const porCategoria = { SoC: catVazia(), XPT: catVazia(), 'LM Hub': catVazia(), '3PL': catVazia() };
  let pendentesPacotes = 0, pendentesTOs = 0;

  rows.forEach(r => {
    const tp = r['to pack'];
    const q = toNum(r.quantity);
    const isSaca = SACA_TIPOS.has(tp);
    const isScuttle = SCUTTLE_TIPOS.has(tp);
    if (isSaca) { pacotesSaca += q; pacotesSacaTOs++; }
    else if (isScuttle) { pacotesScuttle += q; pacotesScuttleTOs++; }

    const cat = destinoCategoria(r.destino);
    if (isSaca) { porCategoria[cat].saca += q; porCategoria[cat].sacaTOs++; }
    else if (isScuttle) { porCategoria[cat].scuttle += q; porCategoria[cat].scuttleTOs++; }

    // Pendentes = Saca/Scuttle ainda sem rua, EXCETO 3PL (3PL nunca recebe
    // endereço — não faz sentido contar como "pendente de endereçar").
    if (r.stage === 'PENDENTE' && (isSaca || isScuttle) && cat !== '3PL') {
      pendentesPacotes += q;
      pendentesTOs++;
    }
  });

  const enderecados = rows.filter(r => r.stage === 'ENDEREÇADO').length;
  const agingMedio = agingMedioSemOutliers(rows);
  const pctAtendimento = totalRegistros ? +(enderecados / totalRegistros * 100).toFixed(1) : 0;

  // ocupacaoTotalPct/posicoesOcupadas são preenchidos depois de montar `grade`
  // (dependem da regra de 10 sacos = 1 posição, calculada por rua).
  return {
    totalRegistros,
    pacotesTotal,
    pacotesSaca,
    pacotesSacaTOs,
    pacotesScuttle,
    pacotesScuttleTOs,
    enderecados,
    agingMedio,
    pctAtendimento,
    pendentesPacotes,
    pendentesTOs,
    socSacas: porCategoria.SoC.saca,
    socSacaTOs: porCategoria.SoC.sacaTOs,
    socScuttle: porCategoria.SoC.scuttle,
    socScuttleTOs: porCategoria.SoC.scuttleTOs,
    xptSacas: porCategoria.XPT.saca,
    xptSacaTOs: porCategoria.XPT.sacaTOs,
    xptScuttle: porCategoria.XPT.scuttle,
    xptScuttleTOs: porCategoria.XPT.scuttleTOs,
    lmHubSacas: porCategoria['LM Hub'].saca,
    lmHubSacaTOs: porCategoria['LM Hub'].sacaTOs,
    lmHubScuttle: porCategoria['LM Hub'].scuttle,
    lmHubScuttleTOs: porCategoria['LM Hub'].scuttleTOs,
    pl3Sacas: porCategoria['3PL'].saca,
    pl3SacaTOs: porCategoria['3PL'].sacaTOs,
    pl3Scuttle: porCategoria['3PL'].scuttle,
    pl3ScuttleTOs: porCategoria['3PL'].scuttleTOs,
  };
}

module.exports = async (req, res) => {
  let rows, configRows;
  try {
    ({ rows } = await fetchTabByGid(CLUSTER_SHEET.spreadsheetId, CLUSTER_SHEET.gid));
    ({ rows: configRows } = await fetchTabByGid(CONFIG_SHEET.spreadsheetId, CONFIG_SHEET.gid));
  } catch (err) {
    res.status(502).json({ ok: false, erro: err.message });
    return;
  }
  // Debug temporário (Roberto reportou "Nenhuma rua no roster" em 2026-09-16)
  // — a amostra de configRows mostrou dado de OUTRA aba (IBS-.../ATP-...) em
  // vez das ruas reais (OBS-.../RUA 001...) — suspeita de que o gid fixo não
  // aponta mais pra aba certa. Lista todas as abas da planilha pra achar o
  // gid real da aba "config". Remover depois de corrigido.
  try {
    const tabs = await listTabs(CONFIG_SHEET.spreadsheetId);
    console.log('[cluster][debug] abas da planilha:', JSON.stringify(tabs));
  } catch (e) { console.log('[cluster][debug] listTabs falhou:', e.message); }

  // De-para código→rua + capacidade real por rua, direto da aba `config`
  // (colunas H-J: staging area id / staging area name / capacity). O roster
  // de ruas segue a ORDEM DA PLANILHA — preserva onde a RESERVA 37A fica
  // fisicamente sem precisar hardcodar. O mapa físico vai só até a RUA 142
  // (confirmado com o Roberto em 2026-08-04) — a config já tem ruas além
  // disso (até 169), mas ficam fora do roster/de-para: TOs endereçados nelas
  // caem como PENDENTE, já que essas posições não fazem parte do mapa hoje.
  const STAGING_DEPARA = new Map(); // staging area id -> { rua, capacidade }
  const RUA_ROSTER = [];
  const CAPACIDADE_POR_RUA = new Map(); // rua -> capacidade
  const CLUSTER_ESPERADO = new Map(); // rua -> destino esperado (coluna "Cluster" da config)
  configRows.forEach(r => {
    const id = r['staging area id'];
    const rua = r['staging area name'];
    if (!id || !rua) return;
    const numRua = (rua.match(/^RUA (\d+)$/) || [])[1];
    const dentroDoMapa = numRua ? Number(numRua) <= 142 : /^RESERVA/i.test(rua);
    if (!dentroDoMapa) return;
    const capacidade = toNum(r.capacity);
    STAGING_DEPARA.set(id, { rua, capacidade });
    RUA_ROSTER.push(rua);
    CAPACIDADE_POR_RUA.set(rua, capacidade);
    if (r.cluster) CLUSTER_ESPERADO.set(rua, r.cluster);
  });
  const CAPACIDADE_TOTAL_CD = RUA_ROSTER.reduce((s, rua) => s + (CAPACIDADE_POR_RUA.get(rua) || 0), 0);
  // Debug temporário (roster vazio, 2026-09-16) — amostra bruta de 5 linhas
  // de configRows pra ver o valor exato de staging_area_id/name que estão
  // chegando (espaço extra, formatação diferente etc.), e o resultado final.
  console.log('[cluster][debug] roster final:', RUA_ROSTER.length, 'ruas | amostra configRows:',
    JSON.stringify(configRows.slice(0, 5).map(r => ({ id: r['staging area id'], rua: r['staging area name'], cap: r.capacity }))));

  // Reconstrói destino/rua/stage/aging a partir das colunas reais de hoje
  // (receiver, staging area, create time) + o de-para acima. Ordenação/"Att."
  // usam complete time (quando o TO foi de fato concluído), não create time.
  //
  // origem/classificacao (colunas derivadas, confirmado com o Roberto em
  // 2026-08-04) — não alteram `to pack`/`operator` originais, só preenchem
  // campos novos:
  //   origem:         Saca Sorter -> Sorter · Scuttle -> Esteira · resto vazio
  //   classificacao:  operator=spx@shopee.com + Saca    -> ASM
  //                   operator=spx@shopee.com + Scuttle -> Transbordo
  //                   resto vazio
  const agoraMs = Date.now();
  // `create time`/`complete time` vêm em horário de Brasília (mesma
  // convenção de todo o PULSO pros timestamps crus da planilha — ver
  // dataOperacionalDe em api/_period.js), não UTC. Interpretar a string
  // direto como UTC (só anexando 'Z') deixa o instante 3h "no passado" do
  // que realmente é, inflando o aging em +3h sistematicamente pra TODO TO —
  // bug real, confirmado ao vivo em 2026-08-05 (TO criado há 7min aparecia
  // com 3,1h de aging) e reportado pelo Roberto como "aging divergente".
  // Corrige somando de volta o offset de Brasília (+3h) depois do parse.
  const BR_PARA_UTC_MS = 3 * 60 * 60 * 1000;
  const parseLocalBr = v => {
    if (!v) return null;
    const ms = new Date(String(v).replace(' ', 'T') + 'Z').getTime();
    return isNaN(ms) ? null : ms + BR_PARA_UTC_MS;
  };
  const origemDe = toPack => {
    if (toPack === 'Saca Sorter') return 'Sorter';
    if (toPack === 'Scuttle') return 'Esteira';
    return '';
  };
  const classificacaoDe = (operator, toPack) => {
    if (operator !== 'spx@shopee.com') return '';
    if (toPack === 'Saca') return 'ASM';
    if (toPack === 'Scuttle') return 'Transbordo';
    return '';
  };
  const comDataBruta = rows.map(r => {
    const codigo = r['staging area'];
    const depara = (codigo && codigo !== '-') ? STAGING_DEPARA.get(codigo) : null;
    // Só o aging faz aritmética contra Date.now() (precisa do epoch UTC
    // real, por isso passa por parseLocalBr) — __date só é usado pra
    // ordenar/formatar (maxCompleteTime.getUTCHours() em "atual.att" conta
    // com o truque padrão do PULSO de ler os dígitos crus via getters UTC),
    // então continua com o parse "ingênuo" (dígitos crus = wall-clock BR).
    const createMs = parseLocalBr(r['create time']);
    return {
      ...r,
      destino: r.receiver,
      rua: depara ? depara.rua : 'Pendente',
      stage: depara ? 'ENDEREÇADO' : 'PENDENTE',
      aging: (createMs !== null) ? +((agoraMs - createMs) / 3600000).toFixed(1) : 0,
      origem: origemDe(r['to pack']),
      classificacao: classificacaoDe(r.operator, r['to pack']),
      __date: r['complete time'] ? new Date(String(r['complete time']).replace(' ', 'T') + 'Z') : null,
    };
  });

  // Resíduo operacional (confirmado com o Roberto em 2026-08-04): quantidade
  // < 15 E aging > 15 dias (360h) somadas — não aparece em NADA da página
  // (cards, grade, tabela), por isso o filtro roda antes de qualquer
  // agregação, não só na tabela final.
  const RESIDUO_QTD_MAX = 15;
  const RESIDUO_AGING_HORAS_MIN = 15 * 24;
  const comData = comDataBruta.filter(r => !(toNum(r.quantity) < RESIDUO_QTD_MAX && r.aging > RESIDUO_AGING_HORAS_MIN));

  // Opções de filtro sempre vêm da base inteira (não da já filtrada), senão
  // as opções somem conforme o usuário seleciona — padrão igual SPR/Leftover.
  const uniqDe = (base, key) => [...new Set(base.map(r => r[key]).filter(Boolean))].sort();

  // Filtros — agora afetam cards, grade e tabela (não só a tabela).
  const toPacks = parseCSV(req.query.to_pack);
  const destinos = parseCSV(req.query.destino);
  const ruas = parseCSV(req.query.rua);
  const busca = (req.query.q || '').trim().toLowerCase();

  const passaFiltros = r =>
    (!toPacks.length || toPacks.includes(toPackGrupo(r['to pack']))) &&
    (!destinos.length || destinos.includes(r.destino)) &&
    (!ruas.length || ruas.includes(r.rua)) &&
    (!busca || String(r['to number'] || '').toLowerCase().includes(busca) || String(r.destino || '').toLowerCase().includes(busca));

  const filtradas = comData.filter(passaFiltros);

  const atual = aggregate(filtradas);

  // Cada posição do quadrado representa 1 slot físico. Sacos (Saca Sorter +
  // Saca) são pequenos e cabem vários por posição — 10 sacos = 1 posição
  // (confirmado com o Roberto em 2026-07-30). Os demais unitizadores
  // (Scuttle/Volumoso/Pallet/-) ocupam 1 posição cada.
  const SACOS_POR_POSICAO = 10;
  const porRua = new Map();
  filtradas.forEach(r => {
    if (r.stage !== 'ENDEREÇADO' || !r.rua || r.rua === 'Pendente') return;
    if (!porRua.has(r.rua)) porRua.set(r.rua, { sacaTOs: 0, outrosTOs: 0, saca: 0, scuttle: 0, pacotes: 0, agingSoma: 0, agingCount: 0, destinos: new Map() });
    const acc = porRua.get(r.rua);
    const q = toNum(r.quantity);
    const isSaca = SACA_TIPOS.has(r['to pack']);
    if (isSaca) acc.sacaTOs++; else acc.outrosTOs++;
    acc.pacotes += q;
    if (isSaca) acc.saca += q;
    else if (SCUTTLE_TIPOS.has(r['to pack'])) acc.scuttle += q;
    acc.agingSoma += r.aging; // já é Number — ver agingMedioSemOutliers
    acc.agingCount++;
    if (r.destino) acc.destinos.set(r.destino, (acc.destinos.get(r.destino) || 0) + 1);
  });

  // Correção de clusterização (confirmado com o Roberto em 2026-08-04): rua
  // vazia OU com o destino dominante (fanout) batendo o cluster esperado
  // (coluna "Cluster" da config) = correta. Rua ocupada com fanout diferente
  // do esperado = incorreta. Rua ocupada sem cluster esperado definido na
  // config (ainda não configurado) não tem regra pra violar — conta como
  // correta, mesmo tratamento de "vazia" (assunção, ajustar se necessário).
  const grade = RUA_ROSTER.map(rua => {
    const capacidade = CAPACIDADE_POR_RUA.get(rua) || 0;
    const clusterEsperado = CLUSTER_ESPERADO.get(rua) || null;
    const acc = porRua.get(rua);
    if (!acc || (!acc.sacaTOs && !acc.outrosTOs)) {
      return { rua, ocupadas: 0, capacidade, pct: 0, saca: 0, scuttle: 0, pacotes: 0, agingMedio: null, fanout: null, clusterEsperado, clusterCorreto: true };
    }
    const posicoes = acc.outrosTOs + Math.ceil(acc.sacaTOs / SACOS_POR_POSICAO);
    let fanout = null, fanoutMax = 0;
    acc.destinos.forEach((n, destino) => { if (n > fanoutMax) { fanoutMax = n; fanout = destino; } });
    // Comparação case-insensitive (+ trim) — o mesmo destino aparece com
    // capitalização diferente entre cluster_pulso (receiver) e a coluna
    // Cluster da config (ex: "..._PqCidade" vs "..._pqCidade"), o que fazia
    // ruas com fanout certo caírem como incorretas na comparação exata.
    // Bug reportado pelo Roberto em 2026-08-11 (RUA 005).
    const normaliza = s => String(s || '').trim().toLowerCase();
    const clusterCorreto = !clusterEsperado || normaliza(fanout) === normaliza(clusterEsperado);
    return {
      rua,
      ocupadas: posicoes,
      capacidade,
      pct: capacidade ? +(posicoes / capacidade * 100).toFixed(1) : 0,
      saca: acc.saca,
      scuttle: acc.scuttle,
      pacotes: acc.pacotes,
      agingMedio: +(acc.agingSoma / acc.agingCount).toFixed(1),
      fanout,
      clusterEsperado,
      clusterCorreto,
    };
  });
  const posicoesOcupadasTotal = grade.reduce((s, g) => s + g.ocupadas, 0);
  atual.posicoesOcupadas = posicoesOcupadasTotal;
  atual.ocupacaoTotalPct = CAPACIDADE_TOTAL_CD ? +(posicoesOcupadasTotal / CAPACIDADE_TOTAL_CD * 100).toFixed(1) : 0;

  atual.ruasCorretas = grade.filter(g => g.clusterCorreto).length;
  atual.ruasIncorretas = grade.filter(g => !g.clusterCorreto).length;
  atual.pctClusterizacao = grade.length ? +(atual.ruasCorretas / grade.length * 100).toFixed(1) : 0;

  const pendentesAtual = filtradas.filter(r => r.stage === 'PENDENTE').length;

  const maxCompleteTime = filtradas.reduce((max, r) => (r.__date && (!max || r.__date > max)) ? r.__date : max, null);
  atual.att = maxCompleteTime
    ? `${String(maxCompleteTime.getUTCDate()).padStart(2,'0')}/${String(maxCompleteTime.getUTCMonth()+1).padStart(2,'0')} ${String(maxCompleteTime.getUTCHours()).padStart(2,'0')}:${String(maxCompleteTime.getUTCMinutes()).padStart(2,'0')}`
    : '—';

  // Top destinos por volume no conjunto filtrado — pro Pipboy ("destino com
  // maior quantidade de volumes").
  const porDestino = new Map();
  filtradas.forEach(r => {
    if (!r.destino) return;
    porDestino.set(r.destino, (porDestino.get(r.destino) || 0) + toNum(r.quantity));
  });
  const topDestinos = [...porDestino.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([destino, pacotes]) => ({ destino, pacotes }));

  // Do mais antigo pro mais novo (pedido do Roberto em 2026-07-30) — a
  // paginação no front (100/página) faz a 1ª página ser o backlog mais velho.
  // Limite alto: manda o piso inteiro (a aba tem ~7-10 mil TOs, ~1-2MB de
  // JSON que a CDN comprime bem); o limite é só um teto de segurança.
  const ordenadas = [...filtradas].sort((a, b) => (a.__date || 0) - (b.__date || 0));
  const LIMITE = 20000;
  const tos = ordenadas.slice(0, LIMITE).map(r => ({
    to_number: r['to number'],
    destino: r.destino,
    current_station: r['current station'],
    to_pack: r['to pack'],
    origem: r.origem,
    classificacao: r.classificacao,
    quantity: toNum(r.quantity),
    aging: r.aging, // já é Number — ver agingMedioSemOutliers
    stage: r.stage,
    rua: r.rua,
    complete_time: r['complete time'],
  }));

  // esteira: só busca/computa quando pedido explicitamente (?esteira=1) — a
  // página de Clusterização normal não usa esse bloco, não faz sentido pagar
  // o custo (fetch extra + payload) em todo load dela. Fonte própria
  // (balanceamento_pulso), não cluster_pulso — ver BALANCEAMENTO_SHEET.
  let esteira = null;
  if (req.query.esteira !== undefined) {
    try {
      const { rows: balRows } = await fetchTabByGid(BALANCEAMENTO_SHEET.spreadsheetId, BALANCEAMENTO_SHEET.gid);
      // Usa TODO o dado disponível na aba, não só o dia mais recente — a
      // aba tem atualização diária e o dia corrente costuma vir com poucas
      // linhas (só o que já foi extraído até o momento), o que deixava
      // esteiras com menos volume (SOC) com pouquíssimos destinos pra
      // balancear. Confirmado com o Roberto em 2026-08-11: o correto é
      // agregar todo o histórico disponível, não filtrar por dia.
      // Só Scuttle/Pallet/Volumoso entram no balanceamento das esteiras —
      // Saca fica de fora (confirmado com o Roberto em 2026-08-10). Turno
      // NÃO entra em nenhum filtro/métrica da Esteira On-time (pedido do
      // Roberto em 2026-08-11 — a coluna `turno` do balanceamento_pulso não
      // deve influenciar o balanceamento nem nada mais nessa página).
      const datasDisponiveis = [...new Set(balRows.map(r => r.data_ajustada).filter(Boolean))].sort();
      const doDiaBalanceaveis = balRows.filter(r => r.pack_name === 'Scuttle' || r.pack_name === 'Pallet' || r.pack_name === 'Volumoso');
      const esteiraRows = doDiaBalanceaveis.map(r => ({ destino: r.dest_corrigido, quantity: toNum(r.total_quantity) }));
      esteira = buildEsteira(esteiraRows);
      esteira.dataRef = datasDisponiveis[datasDisponiveis.length - 1] || null;
      esteira.periodo = datasDisponiveis.length ? { inicio: datasDisponiveis[0], fim: datasDisponiveis[datasDisponiveis.length - 1] } : null;
    } catch (err) {
      esteira = { erro: err.message };
    }
  }

  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
  res.status(200).json({
    ok: true,
    atualizadoEm: new Date().toISOString(),
    atual,
    grade, capacidadeTotal: CAPACIDADE_TOTAL_CD, totalRuas: RUA_ROSTER.length, pendentesAtual, topDestinos,
    tos, tosTotal: filtradas.length,
    opcoesFiltro: {
      to_pack: [...new Set(comData.map(r => toPackGrupo(r['to pack'])).filter(Boolean))].sort(),
      destino: uniqDe(comData, 'destino'),
      rua: uniqDe(comData, 'rua').filter(r => r !== 'Pendente'),
    },
    esteira,
  });
};
