/**
 * PULSO — Inbound Line Haul: pontualidade planejado x realizado (aba inbound_lh_pulso).
 *
 * Cada linha = 1 viagem (`viagem` é única na aba). "Realizada" = tem
 * eta_destino_realizado preenchido (mesmo padrão do Outbound: usa a
 * presença do timestamp real, não o texto de status). Atraso = diferença em
 * minutos entre eta_destino_realizado e eta_destino_planejado — sem
 * margem/tolerância (confirmado com o Roberto em 2026-08-04): atraso > 0
 * já conta como atrasada.
 *
 * Data de referência da página = cutoff_eta_planejado (dia operacional do
 * ETA planejado, cutoff 6h já aplicado na planilha). NÃO usa a coluna
 * data_eta_ajustado — apesar do nome, ela é só a data-calendário crua do
 * timestamp (sem o shift de 6h), então uma viagem planejada pra 02:00
 * (que operacionalmente é "hoje", turno T3) ficava de fora do "hoje" da
 * página até o dia virar no calendário — bug real de dado faltando,
 * confirmado ao vivo em 2026-08-14 comparando as duas colunas
 * (data_eta_ajustado="2026-08-15" vs cutoff_eta_planejado="2026-08-14"
 * pra uma linha com eta 2026-08-15 02:00). Corrigido pedido do Roberto.
 * Suporta intervalo (from/to) pra análise histórica — confirmado com o
 * Roberto em 2026-08-04; sem params, default é from=to=hoje (1 dia, mesmo
 * comportamento de antes).
 *
 * Query params:
 *   from, to   YYYY-MM-DD (default = hoje, ou o dia mais recente disponível
 *              se hoje não tiver dado ainda)
 */
const { fetchTabByGid, readRange, writeRange, resolveTitle, ensureSheetExists } = require('./_google');
const { toNum, hojeOperacionalIso, dataOperacionalDe } = require('./_period');
const { socDaSessaoOuErro } = require('./_users');
const { lerPorStationId } = require('./_pg_ontime');

const SHEET = { spreadsheetId: '1BqZElDRwVaGpDYZzHTq9UQvVLy2guRVfTdvwGHL1qC4', gid: '1485919739' };

function parseDT(v) {
  if (!v) return null;
  const d = new Date(String(v).replace(' ', 'T'));
  return isNaN(d) ? null : d;
}

// Hora extraída direto da string ("YYYY-MM-DD HH:MM:SS") — evita qualquer
// ambiguidade de fuso horário do parse via Date (usado só pro diff em ms).
function horaDe(v) {
  const m = String(v || '').match(/(\d{2}):\d{2}:\d{2}/);
  return m ? Number(m[1]) : null;
}

// Monitor - Fila (subaba nova dentro de Inbound, pedido do Roberto em
// 2026-08-15) — timeline ao vivo da fila de descarga. Base = viagens
// PLANEJADAS de inbound_lh_pulso do dia (fila_pulso sozinha só registra
// quem já chegou fisicamente no portão — com ~80 viagens/dia planejadas e
// só um punhado passando pela catraca a qualquer momento, usar fila_pulso
// como base fazia a tela mostrar "4 carros" em vez das 80 viagens do dia,
// bug relatado pelo Roberto em 2026-08-18). Join por LT (fila."lh trip
// number" = lh.viagem); quando a viagem já está em fila_pulso, os campos
// operacionais (status, motorista, doca, etc.) vêm de lá com prioridade —
// fila_pulso é sempre o dado mais atual porque é alimentada ao vivo pelo
// sistema de portaria, enquanto inbound_lh_pulso é o plano. Pedido do
// Roberto em 2026-08-18. Cabeçalhos de fila_pulso vêm com espaço/
// parênteses (ex.: "waiting time (s)") — só essa aba no PULSO usa esse
// formato, por isso o acesso é sempre via colchete.
const FILA_SHEET = { spreadsheetId: '1BqZElDRwVaGpDYZzHTq9UQvVLy2guRVfTdvwGHL1qC4', gid: '1682611336' };

function filaRowFromMonitor(r) {
  return {
    queueNumber: r.queue_number || '',
    status: r.status || '',
    driver: r.driver || '',
    agency: r.agency || '',
    veiculo: r.vehicle_number || '',
    arrivalType: r.arrival_type || '',
    addToQueueTime: r.add_to_queue_time || '',
    waitingTimeS: toNum(r.waiting_time_s),
    outOfThreshold: String(r.out_of_threshold || '').trim().toLowerCase() === 'sim',
    assignedDock: r.assigned_dock || '',
    occupiedDock: r.occupied_dock || '',
    onHoldDock: r.on_hold_dock || '',
    orderQuantity: toNum(r.order_quantity),
    lhTripName: r.lh_trip_name || '',
  };
}

function filaLhDetalhe(lh) {
  if (!lh) return null;
  return {
    viagem: lh.viagem || '',
    numeroVeiculo: lh.numero_veiculo || '',
    lacre: lh.lacre || '',
    etaDestinoPlanejado: lh.eta_destino_planejado || '',
    checkinDestino: lh.checkin_destino || '',
    aberturaBau: lh.abertura_bau || '',
    inicioDescarga: lh.inicio_descarga || '',
    fimDescarga: lh.fim_descarga || '',
    totalPacotes: toNum(lh.total_pacotes),
    totalTos: toNum(lh.total_tos),
    pacotesSaca: toNum(lh.pacotes_saca),
    pacotesScuttle: toNum(lh.pacotes_scuttle),
    pacotesPallet: toNum(lh.pacotes_pallet),
    tosSaca: toNum(lh.tos_saca),
    tosScuttle: toNum(lh.tos_scuttle),
    tosPallet: toNum(lh.tos_pallet),
    tosOutros: toNum(lh.tos_outros),
    pacotesBulk: toNum(lh.pacotes_bulk),
    pacotesG: toNum(lh.pacotes_g),
    pacotesM: toNum(lh.pacotes_m),
    pacotesP: toNum(lh.pacotes_p),
    pacotesPP: toNum(lh.pacotes_pp),
    pacotesNaoClassificados: toNum(lh.pacotes_nao_classificados),
    solicitacaoAgrupado: lh.solicitation_agrupado || '',
    docaDescarga: lh.doca_descarga || '',
  };
}

// Status "Em Fila" (pedido do Roberto em 2026-09-04) — bucket novo entre
// Planejado e Docado: caminhão já passou pela catraca (emFila=true, tem
// registro no fila_pulso) mas ainda sem doca nenhuma atribuída. A aba
// fila_pulso só grava 3 status hoje (Pending/Occupied/Ended) — "Pending"
// cobre tanto "ainda não chegou" (sem registro, emFila=false) quanto
// "chegou, aguardando doca" (com registro), então a distinção real está
// em emFila + assignedDock/occupiedDock, não no texto do status. Se já
// tem assignedDock mas ainda não ocupou, cai no bucket "Assigned" (label
// "Em andamento") que já existia na lista mas nunca era alcançado.
function filaStatusEfetivo(row) {
  if (row.status === 'Occupied' || row.status === 'Ended') return row.status;
  if (!row.emFila) return row.status || 'Pending'; // sem registro no monitor = Planejado
  if (row.occupiedDock) return 'Occupied';
  if (row.assignedDock) return 'Assigned';
  return 'EmFila';
}

// Fila (checkin físico na catraca): migrada do Sheets (fila_pulso) pro
// Postgres-ontime (tabela `dock_queue`, particionada por station_id —
// pedido do Roberto em 2026-09-25). lhRows (o PLANO, inbound_lh_pulso) fica
// no Sheets — fora do escopo desta migração, só a fila física mudou de fonte.
async function buildFila(req, res) {
  const soc = socDaSessaoOuErro(req, res);
  if (!soc) return;

  let filaRows, lhRows;
  try {
    ([filaRows, { rows: lhRows }] = await Promise.all([
      lerPorStationId('dock_queue', soc),
      fetchTabByGid(SHEET.spreadsheetId, SHEET.gid),
    ]));
  } catch (err) {
    res.status(502).json({ ok: false, erro: err.message });
    return;
  }

  const lhDoDia = lhRows.filter(r => r.cutoff_eta_planejado);
  const diasDisponiveis = [...new Set(lhDoDia.map(r => r.cutoff_eta_planejado))].sort();
  const hojeIso = hojeOperacionalIso();
  const dia = diasDisponiveis.includes(hojeIso) ? hojeIso : (diasDisponiveis[diasDisponiveis.length - 1] || hojeIso);
  const planoDoDia = lhDoDia.filter(r => r.cutoff_eta_planejado === dia);

  // fila_pulso por LT — última linha da aba vence em caso de duplicidade
  // (mesma LT registrada mais de uma vez, ex. reprocesso da catraca).
  const filaPorLT = new Map();
  filaRows.forEach(r => { const lt = r.lh_trip_number || ''; if (lt) filaPorLT.set(lt, r); });

  const usadas = new Set();
  const doPlano = planoDoDia.map(lh => {
    const lt = lh.viagem || '';
    const monitor = lt ? filaPorLT.get(lt) : null;
    if (monitor) usadas.add(lt);
    const fimDescarga = !!lh.fim_descarga;
    const base = {
      lhTripNumber: lt,
      emFila: !!monitor,
      // Sem registro no monitor: status inferido do próprio plano (Ended
      // se a descarga já terminou — cobre viagem antiga/histórica sem
      // passagem pela catraca; Pending = ainda não chegou fisicamente).
      status: monitor ? (monitor.status || '') : (fimDescarga ? 'Ended' : 'Pending'),
      queueNumber: '', driver: '', agency: '', veiculo: lh.veiculo_utilizado || '',
      arrivalType: '', addToQueueTime: '', waitingTimeS: null, outOfThreshold: false,
      assignedDock: '', occupiedDock: '', onHoldDock: '',
      orderQuantity: toNum(lh.total_pacotes),
      lhTripName: '',
      ...(monitor ? filaRowFromMonitor(monitor) : {}),
      lh: filaLhDetalhe(lh),
    };
    base.status = filaStatusEfetivo(base);
    return base;
  });

  // Sobras de fila_pulso não vinculadas a uma viagem do plano de hoje —
  // sem LT (ainda não vinculada no sistema de origem) ou LT de outro dia.
  // Mesma regra de sempre (pedido do Roberto em 2026-08-15): quem ainda
  // está ATIVO (Pending/Assigned/Occupied) aparece independente do dia;
  // quem já FINALIZOU só entra se o dia bater, senão a tela acumularia
  // histórico morto.
  const orfas = filaRows
    .filter(r => { const lt = r.lh_trip_number || ''; return !lt || !usadas.has(lt); })
    .filter(r => r.status !== 'Ended' || dataOperacionalDe(r.add_to_queue_time) === dia)
    .map(r => {
      const base = {
        lhTripNumber: r.lh_trip_number || '',
        emFila: true,
        ...filaRowFromMonitor(r),
        lh: null,
      };
      base.status = filaStatusEfetivo(base);
      return base;
    });

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=180');
  res.status(200).json({
    ok: true,
    dia,
    cobertura: { inicio: diasDisponiveis[0] || null, fim: diasDisponiveis[diasDisponiveis.length - 1] || null },
    rows: [...doPlano, ...orfas],
  });
}

// Tags de andamento por LT no Monitor - Fila (pedido do Roberto em
// 2026-08-28) — mesma aba MONITOR_TAGS_INPUT que o Monitor Live do
// Outbound já usa (gid 1506357496, ver TAGS_HEADER em api/outbound.js,
// colunas A:R), mas em colunas separadas a partir de T (S fica de
// intervalo, sem uso) — evita qualquer colisão com o bloco do Outbound.
// Ao contrário do Outbound (1 linha por trip, sobrescrita a cada tag
// nova), aqui cada marcação vira uma linha NOVA — "guarde histórico na
// mesma base": nada é apagado/sobrescrito, só acrescentado.
const LH_TAGS_SHEET_ID = '1BqZElDRwVaGpDYZzHTq9UQvVLy2guRVfTdvwGHL1qC4';
const LH_TAGS_TAB_GID = '1506357496';
const LH_TAGS_HEADER = ['lt_trip_number', 'lt_tag', 'lt_usuario', 'lt_atualizado_em'];
const LH_TAGS = new Set(['Em Fila', 'Docado', 'Descarregando', 'Finalizado']);

async function lhTagsTitle() {
  try {
    return await resolveTitle(LH_TAGS_SHEET_ID, LH_TAGS_TAB_GID);
  } catch (err) {
    await ensureSheetExists(LH_TAGS_SHEET_ID, 'MONITOR_TAGS_INPUT');
    return 'MONITOR_TAGS_INPUT';
  }
}
async function lhTagsRange() {
  const title = await lhTagsTitle();
  return `'${title}'!T:W`;
}
function lhTagLinhaParaObjeto(r) {
  const o = {};
  LH_TAGS_HEADER.forEach((campo, i) => { o[campo] = r[i] || ''; });
  return o;
}
async function readLhTags() {
  let values;
  try {
    values = await readRange(LH_TAGS_SHEET_ID, await lhTagsRange());
  } catch (err) {
    return [];
  }
  if (!values.length) return [];
  return values.slice(1).map(lhTagLinhaParaObjeto).filter(o => o.lt_trip_number);
}

async function buildLhTags(req, res) {
  if (req.method === 'POST') {
    const { trip_number, tag, usuario } = req.body || {};
    if (!trip_number) { res.status(400).json({ ok: false, erro: 'trip_number obrigatório' }); return; }
    if (tag && !LH_TAGS.has(tag)) { res.status(400).json({ ok: false, erro: 'tag inválida' }); return; }
    try {
      const historico = await readLhTags();
      historico.push({ lt_trip_number: trip_number, lt_tag: tag || '', lt_usuario: usuario || '', lt_atualizado_em: new Date().toISOString() });
      const values = [LH_TAGS_HEADER, ...historico.map(o => LH_TAGS_HEADER.map(c => o[c] != null ? o[c] : ''))];
      await writeRange(LH_TAGS_SHEET_ID, await lhTagsRange(), values);
      res.status(200).json({ ok: true, historico });
    } catch (err) {
      res.status(502).json({ ok: false, erro: err.message });
    }
    return;
  }
  try {
    const historico = await readLhTags();
    res.status(200).json({ ok: true, historico });
  } catch (err) {
    res.status(502).json({ ok: false, erro: err.message });
  }
}

module.exports = async (req, res) => {
  if (req.query.tags !== undefined) {
    await buildLhTags(req, res);
    return;
  }
  if (req.query.fila !== undefined) {
    await buildFila(req, res);
    return;
  }

  const soc = socDaSessaoOuErro(req, res);
  if (!soc) return;

  // inbound_lh_pulso é implicitamente RJ2 (sem coluna de SoC) — pra
  // qualquer outro SoC, nem busca (melhor nada do que misturar dado de RJ2
  // — pedido do Roberto em 2026-09-24). Mesma forma "sem dado" já usada
  // abaixo quando a aba vem vazia. (?tags/?fila ficam fora deste gate, fora
  // do escopo desta varredura.)
  if (soc !== 'RJ2') {
    res.status(200).json({ ok: true, de: null, ate: null, rows: [], opcoes: { turnos: [], status: [], origens: [], veiculos: [], solicitacoes: [] }, cobertura: { inicio: null, fim: null } });
    return;
  }

  let rows;
  try {
    ({ rows } = await fetchTabByGid(SHEET.spreadsheetId, SHEET.gid));
  } catch (err) {
    res.status(502).json({ ok: false, erro: err.message });
    return;
  }

  const lh = rows.filter(r => r.cutoff_eta_planejado);
  if (!lh.length) {
    res.status(200).json({ ok: true, de: null, ate: null, rows: [], opcoes: { turnos: [], status: [], origens: [], veiculos: [], solicitacoes: [] }, cobertura: { inicio: null, fim: null } });
    return;
  }

  const datasDisponiveis = [...new Set(lh.map(r => r.cutoff_eta_planejado))].sort();
  const dataMinima = datasDisponiveis[0], dataMaxima = datasDisponiveis[datasDisponiveis.length - 1];
  // dataMaxima pode ser um ETA planejado futuro (viagem pré-agendada) — o
  // default tem que ser o dia real de hoje, não a data mais distante da
  // planilha (mesmo bug já corrigido no Outbound/Backlog).
  const hojeIso = hojeOperacionalIso();
  const padrao = datasDisponiveis.includes(hojeIso) ? hojeIso : dataMaxima;
  const de = (req.query.from && datasDisponiveis.includes(req.query.from)) ? req.query.from : padrao;
  const ate = (req.query.to && datasDisponiveis.includes(req.query.to) && req.query.to >= de) ? req.query.to : de;

  // Uma viagem tem 3 eventos com cutoff PRÓPRIO na planilha (podem cair em
  // dias operacionais diferentes entre si): cutoff_eta_planejado (chegada
  // planejada), cutoff_eta_realizado (chegada real) e cutoff_descarga (fim
  // do descarregamento — quando saca/scuttle fica disponível pra
  // processamento). Ex. real: ETA planejado 04:00 do dia 14 -> cutoff_eta
  // = dia 13, mas o descarregamento só terminou 07:52 do dia 14 -> cutoff_
  // descarga = dia 14. Retornar só quem bate por cutoff_eta_planejado
  // (como era antes) fazia o card "Sacas/Scuttles disponíveis por hora"
  // perder viagens cujo descarregamento terminou no dia certo mas cuja
  // chegada tinha sido planejada/contada no dia anterior — bug relatado
  // pelo Roberto em 2026-08-15 ("carros descarregados depois de meia-
  // noite do dia 14 devem contar pro dia 14"). Por isso a união: manda
  // pro front toda viagem que bate em QUALQUER um dos dois cutoffs, com
  // os dois campos expostos — cada view do front filtra pelo cutoff que
  // faz sentido pra ela (cutoffEtaPlanejado pra pontualidade/tabela,
  // cutoffDescarga pro card de sacas/scuttles).
  const doIntervalo = lh.filter(r =>
    (r.cutoff_eta_planejado >= de && r.cutoff_eta_planejado <= ate) ||
    (r.cutoff_descarga && r.cutoff_descarga >= de && r.cutoff_descarga <= ate)
  );

  const linhas = doIntervalo.map(r => {
    const planejado = parseDT(r.eta_destino_planejado);
    const realizado = parseDT(r.eta_destino_realizado);
    const atrasoMin = (planejado && realizado) ? Math.round((realizado - planejado) / 60000) : null;
    // Tempo de fila/descarga (confirmado com o Roberto em 2026-08-04):
    //   checkin_destino = chegada por telemetria
    //   abertura_bau    = momento em que o carro foi docado
    //   inicio_descarga / fim_descarga = início/fim do descarregamento
    // "Tempo de Fila" = checkin_destino -> fim_descarga (não é só a espera
    // pra iniciar a descarga, é o dwell time total até terminar — assim que
    // o Roberto definiu o card).
    const checkinDestino = parseDT(r.checkin_destino);
    const aberturaBau = parseDT(r.abertura_bau);
    const fimDescarga = parseDT(r.fim_descarga);
    const tempoFilaMin = (checkinDestino && fimDescarga) ? Math.round((fimDescarga - checkinDestino) / 60000) : null;
    // "Tempo de Descarga" usa abertura_bau -> fim_descarga, não
    // inicio_descarga -> fim_descarga (pedido do Roberto em 2026-08-28,
    // card "Tempo de Descarga" na LineHaul aparecendo zerado): na prática
    // inicio_descarga e fim_descarga vêm gravados quase simultâneos na
    // planilha (0-45s de diferença em toda amostra verificada, mesmo com
    // fila de horas), então não refletem a duração real da descarga.
    // abertura_bau (docagem) tem gap real contra fim_descarga.
    const tempoDescargaMin = (aberturaBau && fimDescarga) ? Math.round((fimDescarga - aberturaBau) / 60000) : null;
    return {
      viagem: r.viagem,
      // Cutoff de cada evento, expostos separados pro front escolher o
      // certo por view (ver comentário acima de doIntervalo).
      cutoffEtaPlanejado: r.cutoff_eta_planejado || '',
      cutoffDescarga: r.cutoff_descarga || '',
      origem: r.origem || '',
      veiculo: r.veiculo_utilizado || '',
      // Turno = turno_chegada (coluna já calculada na planilha pelo horário
      // real de chegada) quando a LT já chegou; turno_planejado enquanto
      // ainda não chegou. Antes usava um recálculo próprio por hora — trocado
      // em 2026-08-14 porque turno_chegada já é a fonte oficial (evita
      // divergência entre o cálculo daqui e o que o resto da operação usa).
      turno: (r.eta_destino_realizado ? r.turno_chegada : r.turno_planejado) || r.turno_planejado || '',
      status: r.status_agrupado || '',
      horaPlanejada: toNum(r.hora_eta_ajustado),
      horaRealizada: r.hora_eta_destino_realizado !== '' ? toNum(r.hora_eta_destino_realizado) : null,
      planejado: r.eta_destino_planejado || '',
      realizado: r.eta_destino_realizado || '',
      realizada: !!r.eta_destino_realizado,
      // "Fechada" = descarga realizada (pedido do Roberto em 2026-08-14,
      // substitui o proxy antigo de "realizada" por eta_destino_realizado
      // pra decidir se a LT já foi atendida) — presença de fim_descarga.
      descarregada: !!fimDescarga,
      atrasoMin,
      onTime: atrasoMin !== null ? atrasoMin <= 0 : null,
      checkinDestino: r.checkin_destino || '',
      aberturaBau: r.abertura_bau || '',
      inicioDescarga: r.inicio_descarga || '',
      fimDescarga: r.fim_descarga || '',
      horaCheckin: horaDe(r.checkin_destino),
      tempoFilaMin,
      tempoDescargaMin,
      pacotes: toNum(r.total_pacotes),
      tos: toNum(r.total_tos),
      pacotesSaca: toNum(r.pacotes_saca),
      tosSaca: toNum(r.tos_saca),
      pacotesScuttle: toNum(r.pacotes_scuttle),
      tosScuttle: toNum(r.tos_scuttle),
      // G+Bulky e P+M somados (pedido do Roberto em 2026-08-04) — a aba não
      // tem contagem de TOs por tamanho (só existe tos_saca/scuttle/pallet/
      // outros/volumoso), por isso esses dois cards não têm TOs entre parênteses.
      pacotesGBulk: toNum(r.pacotes_g) + toNum(r.pacotes_bulk),
      pacotesPM: toNum(r.pacotes_p) + toNum(r.pacotes_m),
      solicitacao: r.solicitation_agrupado || '',
      // Hora em que a saca/scuttle fica disponível pra processamento = hora
      // do fim da descarga (não a chegada — só depois de descarregado o
      // conteúdo sai do caminhão) — pedido do Roberto em 2026-08-05.
      horaDescarga: r.hora_descarga !== '' ? toNum(r.hora_descarga) : null,
      docaDescarga: r.doca_descarga || '',
    };
  });

  const opcoes = {
    turnos: [...new Set(linhas.map(l => l.turno).filter(Boolean))].sort(),
    status: [...new Set(linhas.map(l => l.status).filter(Boolean))].sort(),
    origens: [...new Set(linhas.map(l => l.origem).filter(Boolean))].sort(),
    veiculos: [...new Set(linhas.map(l => l.veiculo).filter(Boolean))].sort(),
    solicitacoes: [...new Set(linhas.map(l => l.solicitacao).filter(Boolean))].sort(),
  };

  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
  res.status(200).json({
    ok: true,
    de, ate,
    rows: linhas,
    opcoes,
    cobertura: { inicio: dataMinima, fim: dataMaxima },
  });
};
