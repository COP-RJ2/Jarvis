/**
 * PULSO — Outbound: acompanhamento de CPT/SLA (aba rawdata_out_pulso).
 *
 * Uma página só, dois modos (decidido com o Roberto em 2026-07-30):
 *   - "hoje" (padrão, sem `de`/`ate` na query): filtro fixo no dia
 *     operacional atual de verdade — cutoff de 6h (hojeOperacionalIso, ver
 *     api/_period.js), não o cutoff mais recente da planilha (corrigido em
 *     2026-07-30: a planilha pode ter cutoffs futuros pré-planejados,
 *     então "o cutoff mais recente" não é "hoje").
 *   - "historico" (quando `de` e/ou `ate` vêm preenchidos): filtra cutoff
 *     dentro do intervalo informado (lado que faltar usa o limite da base).
 * Sem comparação vs período anterior — é um retrato do intervalo escolhido,
 * não um dashboard tipo SPR.
 *
 * Query params:
 *   de, ate                  YYYY-MM-DD (opcionais — presença de qualquer um ativa o modo histórico)
 *   turno                    lista separada por vírgula (T1,T2,T3) — filtro direto em turno_shipped
 *                            (turno do CPT planejado, mesma dimensão do gráfico; trocado do antigo
 *                            pertenceAoTurno/compartilhado — que misturava o turno do ETA de origem —
 *                            pedido do Roberto em 2026-08-18: "CPT planejado como dimensão")
 *   status, solicitante      listas separadas por vírgula (status_agrupado, solicitation_by)
 *   destino, agencia, veiculo   listas separadas por vírgula
 *   q                        busca livre em lh_trips
 */
const { fetchTabByGid, readRange, writeRange, ensureSheetExists, resolveTitle } = require('./_google');
const { parseCSV, hojeOperacionalIso, dataOperacionalDe, toNum } = require('./_period');
const { enrich, aggregate, toCarroRow, tipoCarregamento } = require('./_outbound');
const { socDaSessaoOuErro } = require('./_users');
const { lerPorStationId } = require('./_pg_ontime');

const OUTBOUND_SHEET = { spreadsheetId: '1BqZElDRwVaGpDYZzHTq9UQvVLy2guRVfTdvwGHL1qC4', gid: '0' };
// Monitor - Live (subaba nova dentro de Outbound, pedido do Roberto em
// 2026-08-13) — timeline ao vivo de viagens (STA/STD/ATD por trip), fonte
// própria (outbound_monitor_pulso), não a rawdata_out_pulso de cima.
const MONITOR_SHEET = { spreadsheetId: '1BqZElDRwVaGpDYZzHTq9UQvVLy2guRVfTdvwGHL1qC4', gid: '1386791246' };
// Local de endereçamento dos unitizadores por destino (pedido do Roberto em
// 2026-08-13, "Intersoc/HUB"): mesma base da Clusterização (cluster_pulso +
// config, ver api/cluster.js), só o de-para código→rua + contagem por
// destino — não duplica a reconciliação inteira (roster/capacidade/etc,
// que essa página não usa).
const CLUSTER_SHEET = { spreadsheetId: '1BqZElDRwVaGpDYZzHTq9UQvVLy2guRVfTdvwGHL1qC4', gid: '646168208' };
const CLUSTER_CONFIG_SHEET = { spreadsheetId: '1BqZElDRwVaGpDYZzHTq9UQvVLy2guRVfTdvwGHL1qC4', gid: '1408724077' };

// Mesmas convenções da Clusterização (api/cluster.js) — replicadas aqui pra
// os números do Monitor baterem 1:1 com os daquela página: 10 sacos = 1
// posição física, resíduo operacional (qtd<15 E aging>15d) fora de tudo,
// aging em horas desde `create time` corrigindo o fuso BR (+3h), roster
// físico só até a RUA 142 (+ RESERVAs).
const SACA_TIPOS = new Set(['Saca Sorter', 'Saca']);
const SACOS_POR_POSICAO = 10;
const RESIDUO_QTD_MAX = 15;
const RESIDUO_AGING_HORAS_MIN = 15 * 24;
const BR_PARA_UTC_MS = 3 * 60 * 60 * 1000;
// "YYYY-MM-DD HH:MM:SS" (horário de Brasília, mesma convenção de toda a
// planilha) -> epoch UTC real, pra comparar contra Date.now() no snapshot
// de STA. Mesmo truque de agingHoras() logo abaixo.
function parseBrParaUtcMs(raw) {
  if (!raw) return null;
  const ms = new Date(String(raw).replace(' ', 'T') + 'Z').getTime();
  return isNaN(ms) ? null : ms + BR_PARA_UTC_MS;
}

async function buildEnderecamentoPorDestino() {
  const [{ rows: clusterRows }, { rows: configRows }] = await Promise.all([
    fetchTabByGid(CLUSTER_SHEET.spreadsheetId, CLUSTER_SHEET.gid),
    fetchTabByGid(CLUSTER_CONFIG_SHEET.spreadsheetId, CLUSTER_CONFIG_SHEET.gid),
  ]);

  // OBS: a aba `config` também tem colunas de credenciais (e-mail/senha) nas
  // primeiras colunas — nada dela é devolvido ao cliente aqui, só o de-para
  // de rua/capacidade/cluster das colunas H-K, igual api/cluster.js.
  const staginDepara = new Map();      // staging area id -> rua
  const capacidadePorRua = new Map();  // rua -> capacidade
  const clusterEsperado = new Map();   // rua -> destino configurado pra ela
  configRows.forEach(r => {
    const id = r['staging area id'];
    const rua = r['staging area name'];
    if (!id || !rua) return;
    const numRua = (rua.match(/^RUA (\d+)$/) || [])[1];
    const dentroDoMapa = numRua ? Number(numRua) <= 142 : /^RESERVA/i.test(rua);
    if (!dentroDoMapa) return;
    staginDepara.set(id, rua);
    capacidadePorRua.set(rua, toNum(r.capacity));
    if (r.cluster) clusterEsperado.set(rua, r.cluster);
  });

  const agoraMs = Date.now();
  const agingHoras = v => {
    if (!v) return null;
    const ms = new Date(String(v).replace(' ', 'T') + 'Z').getTime();
    return isNaN(ms) ? null : (agoraMs - (ms + BR_PARA_UTC_MS)) / 3600000;
  };

  // 1ª passada: ocupação total de cada rua (todos os destinos juntos) — é o
  // que a Clusterização mostra como "% de ocupação da rua", propriedade da
  // rua e não do destino.
  const posicoesPorRua = new Map(); // rua -> { sacaTOs, outrosTOs }
  // 2ª: quebra por destino+rua (sacas/scuttle/pacotes/aging DAQUELE destino).
  const porDestino = new Map();
  // "Pacotes Packed" (pedido do Roberto em 2026-08-13, card novo no Monitor -
  // Live): total de pacotes já embalados (packed) pro destino no
  // cluster_pulso, INDEPENDENTE de já estar endereçado numa rua ou ainda
  // PENDENTE — por isso soma direto de `receiver`, sem passar pelo filtro
  // de `rua` que o resto desta função usa (aquele é só sobre o que já tem
  // posição física).
  const packedPorDestino = new Map();
  clusterRows.forEach(r => {
    const qtd = toNum(r.quantity);
    const aging = agingHoras(r['create time']);
    if (qtd < RESIDUO_QTD_MAX && aging !== null && aging > RESIDUO_AGING_HORAS_MIN) return; // resíduo
    if (r.receiver) packedPorDestino.set(r.receiver, (packedPorDestino.get(r.receiver) || 0) + qtd);

    const codigo = r['staging area'];
    const rua = (codigo && codigo !== '-') ? staginDepara.get(codigo) : null;
    if (!rua) return;
    const isSaca = SACA_TIPOS.has(r['to pack']);
    const isScuttle = r['to pack'] === 'Scuttle';

    if (!posicoesPorRua.has(rua)) posicoesPorRua.set(rua, { sacaTOs: 0, outrosTOs: 0 });
    const pos = posicoesPorRua.get(rua);
    if (isSaca) pos.sacaTOs++; else pos.outrosTOs++;

    if (!r.receiver) return;
    if (!porDestino.has(r.receiver)) porDestino.set(r.receiver, new Map());
    const ruasDoDestino = porDestino.get(r.receiver);
    if (!ruasDoDestino.has(rua)) ruasDoDestino.set(rua, { qtd: 0, sacas: 0, sacaTOs: 0, scuttle: 0, scuttleTOs: 0, pacotes: 0, agingSoma: 0, agingCount: 0 });
    const acc = ruasDoDestino.get(rua);
    acc.qtd++;
    acc.pacotes += qtd;
    if (isSaca) { acc.sacas += qtd; acc.sacaTOs++; }
    else if (isScuttle) { acc.scuttle += qtd; acc.scuttleTOs++; }
    if (aging !== null) { acc.agingSoma += aging; acc.agingCount++; }
  });

  const ocupacaoDaRua = rua => {
    const pos = posicoesPorRua.get(rua);
    const capacidade = capacidadePorRua.get(rua) || 0;
    const ocupadas = pos ? pos.outrosTOs + Math.ceil(pos.sacaTOs / SACOS_POR_POSICAO) : 0;
    return { ocupadas, capacidade, pct: capacidade ? +(ocupadas / capacidade * 100).toFixed(1) : 0 };
  };

  // Ruas configuradas pra cada destino na aba config (coluna Cluster), mesmo
  // que estejam vazias agora — o Roberto quer ver pra onde o destino DEVE ir,
  // não só onde já tem volume. Comparação normalizada (trim+lowercase): o
  // mesmo destino aparece com capitalização diferente entre as duas abas.
  const normaliza = s => String(s || '').trim().toLowerCase();
  const ruasConfiguradasPorDestino = new Map();
  clusterEsperado.forEach((destino, rua) => {
    const chave = normaliza(destino);
    if (!ruasConfiguradasPorDestino.has(chave)) ruasConfiguradasPorDestino.set(chave, []);
    ruasConfiguradasPorDestino.get(chave).push(rua);
  });

  const out = {};
  const destinos = new Set([...porDestino.keys()]);
  // Destino que só existe na config (configurado mas ainda sem volume) também
  // precisa aparecer — por isso o merge pelas duas pontas.
  clusterEsperado.forEach(destino => destinos.add(destino));

  destinos.forEach(destino => {
    const comVolume = porDestino.get(destino) || new Map();
    const configuradas = ruasConfiguradasPorDestino.get(normaliza(destino)) || [];
    const todasAsRuas = new Set([...comVolume.keys(), ...configuradas]);
    const configuradasSet = new Set(configuradas);

    const lista = [...todasAsRuas].map(rua => {
      const acc = comVolume.get(rua) || { qtd: 0, sacas: 0, sacaTOs: 0, scuttle: 0, scuttleTOs: 0, pacotes: 0, agingSoma: 0, agingCount: 0 };
      const ocup = ocupacaoDaRua(rua);
      return {
        rua,
        qtd: acc.qtd,                 // TOs desse destino nessa rua
        sacas: acc.sacas, sacaTOs: acc.sacaTOs,
        scuttle: acc.scuttle, scuttleTOs: acc.scuttleTOs,
        pacotes: acc.pacotes,
        agingMedio: acc.agingCount ? +(acc.agingSoma / acc.agingCount).toFixed(1) : null,
        ocupadas: ocup.ocupadas, capacidade: ocup.capacidade, ocupacaoPct: ocup.pct,
        configurada: configuradasSet.has(rua),
      };
    }).sort((a, b) => b.qtd - a.qtd || a.rua.localeCompare(b.rua));

    if (lista.length) out[destino] = lista;
  });
  return { enderecamento: out, packedPorDestino };
}

// Registros do Monitor - Live (pedido do Roberto em 2026-08-13): tag de
// andamento por LT (visível pra todo mundo) + snapshot automático de
// TO/Pacotes Endereçados/Pacotes Packed no instante do STA e no instante do
// ATD — primeira feature de ESCRITA do projeto (resto do PULSO é só
// leitura, ver escopo em api/_google.js). Aba própria (monitor_tags_pulso,
// criada sob demanda), não a outbound_monitor_pulso de cima. 1 linha por
// trip_number; expira sozinha 10 dias sem nenhuma atividade (tag OU
// snapshot) — TTL ancorado em `atualizado_em`, não mais em `criado_em`
// (provisório até a feature de login definir o "perfil" de quem marcou).
//
// Título resolvido pelo GID (não fixo em string) — a planilha está sendo
// reorganizada (pedido do Roberto em 2026-08-17: monitor_tags_pulso vai
// virar MONITOR_TAGS_INPUT) e esse é o único lugar do projeto que
// dependia do nome da aba em vez do gid pra montar range. Resolver por
// gid sobrevive ao rename sem precisar tocar no código de novo.
const TAGS_TAB_GID = '1506357496';
// `transportadora` no fim de propósito (pedido do Roberto em 2026-08-14,
// depois da aba já ter registros reais gravados): inserir no meio
// deslocaria a posição de todas as colunas seguintes, corrompendo a
// leitura das linhas já existentes (mapeamento é por posição — ver
// linhaParaRegistro) até o próximo write reescrever cada uma. No fim,
// linhas antigas simplesmente leem "" pro campo novo até o próximo
// snapshot/tag preencher.
const TAGS_HEADER = [
  'trip_number', 'tag', 'usuario',
  'sort_code', 'destino', 'placa', 'veiculo_tipo', 'sta', 'std',
  'to_sta', 'pacotes_sta', 'packed_sta',
  'atd', 'to_atd', 'pacotes_atd', 'packed_atd',
  'atualizado_em', 'transportadora',
];
const TAGS_TTL_MS = 10 * 24 * 60 * 60 * 1000;

// Resolve o título atual da aba pelo gid; se ela ainda não existir (feature
// nunca usada nessa planilha), cria com o nome padrão e passa a resolver
// por gid dali em diante — cobre tanto o primeiro uso quanto um rename
// futuro sem precisar mexer no código de novo.
async function tagsTitle() {
  try {
    return await resolveTitle(MONITOR_SHEET.spreadsheetId, TAGS_TAB_GID);
  } catch (err) {
    await ensureSheetExists(MONITOR_SHEET.spreadsheetId, 'monitor_tags_pulso');
    return 'monitor_tags_pulso';
  }
}
async function tagsRange() {
  const title = await tagsTitle();
  return `'${title}'!A:${String.fromCharCode(64 + TAGS_HEADER.length)}`;
}

function linhaParaRegistro(r) {
  const o = {};
  TAGS_HEADER.forEach((campo, i) => { o[campo] = r[i] || ''; });
  return o;
}
function registroParaLinha(o) {
  return TAGS_HEADER.map(campo => o[campo] != null ? o[campo] : '');
}

// Lê e já filtra registros expirados (>10 dias sem nenhuma atividade) — se
// a aba ainda não existe (feature nunca usada), Sheets retorna erro de
// range e isso vira [].
async function readMonitorRegistros() {
  let values;
  try {
    values = await readRange(MONITOR_SHEET.spreadsheetId, await tagsRange());
  } catch (err) {
    return [];
  }
  const agora = Date.now();
  return values.slice(1)
    .map(linhaParaRegistro)
    .filter(r => r.trip_number && (agora - new Date(r.atualizado_em).getTime()) < TAGS_TTL_MS);
}
async function writeMonitorRegistros(registros) {
  const values = [TAGS_HEADER, ...registros.map(registroParaLinha)];
  await writeRange(MONITOR_SHEET.spreadsheetId, await tagsRange(), values);
}

// POST /api/outbound?monitor=1&tag=1  body: { trip_number, tag, usuario }
// tag vazia = remove a tag (mas preserva o snapshot da linha, se existir —
// só apaga a tag). Read-modify-write da aba inteira (clear + rewrite) —
// mais simples que rastrear índice de linha; volume é pequeno (registros
// ativos num raio de 10 dias). ponytail: sem lock, dois writes concorrentes
// podem se sobrepor (last write wins) — upgrade se o uso crescer muito.
async function handleTagWrite(req, res) {
  const { trip_number, tag, usuario } = req.body || {};
  if (!trip_number) {
    res.status(400).json({ ok: false, erro: 'trip_number obrigatório' });
    return;
  }
  try {
    const atuais = await readMonitorRegistros();
    const existente = atuais.find(r => r.trip_number === trip_number);
    const atualizado = {
      ...(existente || TAGS_HEADER.reduce((o, c) => ({ ...o, [c]: '' }), {})),
      trip_number, tag: tag || '', usuario: usuario || '',
      atualizado_em: new Date().toISOString(),
    };
    const semEssaLt = atuais.filter(r => r.trip_number !== trip_number);
    const semTagVazia = atualizado.tag || Object.keys(atualizado).some(c => c !== 'trip_number' && c !== 'tag' && c !== 'usuario' && c !== 'atualizado_em' && atualizado[c]);
    const registros = semTagVazia ? [...semEssaLt, atualizado] : semEssaLt;
    await writeMonitorRegistros(registros);
    res.status(200).json({ ok: true, registros });
  } catch (err) {
    res.status(502).json({ ok: false, erro: err.message });
  }
}

// Snapshot automático (pedido do Roberto em 2026-08-13): quando uma viagem
// chega no horário do STA, grava TO/Pacotes Endereçados/Pacotes Packed
// daquele instante nas colunas *_sta; quando o ATD é registrado na
// planilha de origem, grava o mesmo trio nas colunas *_atd — colunas
// diferentes na MESMA linha, não uma linha nova. Roda dentro do
// buildMonitor() (chamado a cada refresh de qualquer usuário, agora de 3
// em 3 min) em vez de um cron dedicado — a Vercel Hobby não tem esse
// recurso sobrando (ver teto de funções em api/_arvore.js). Só grava de
// volta na planilha quando alguma viagem realmente precisa de snapshot
// novo, pra não gastar a cota de escrita a cada refresh à toa.
async function syncMonitorSnapshots(viagens, packedPorDestino) {
  const atuais = await readMonitorRegistros();
  const porTrip = new Map(atuais.map(r => [r.trip_number, r]));
  let mudou = false;
  const agoraMs = Date.now();

  viagens.forEach(v => {
    if (!v.trip_number) return;
    let r = porTrip.get(v.trip_number);
    const staMs = parseBrParaUtcMs(v.sta);
    const chegouSta = staMs !== null && agoraMs >= staMs;
    const temAtd = !!v.atd;
    if (!chegouSta && !temAtd) return; // nada a fazer ainda pra essa viagem

    const precisaStaSnap = chegouSta && !(r && r.to_sta !== '');
    const precisaAtdSnap = temAtd && !(r && r.to_atd !== '');
    if (!precisaStaSnap && !precisaAtdSnap) return;

    if (!r) {
      r = TAGS_HEADER.reduce((o, c) => ({ ...o, [c]: '' }), {});
      r.trip_number = v.trip_number;
      porTrip.set(v.trip_number, r);
    }
    // Campos "de identificação" ficam sempre atualizados com o valor mais
    // recente da planilha de origem, independente de qual snapshot disparou.
    r.sort_code = v.destino_codigo || '';
    r.destino = v.destino || '';
    r.placa = v.veiculo_placa || '';
    r.veiculo_tipo = v.veiculo_tipo || '';
    r.transportadora = v.transportadora || '';
    r.sta = v.sta || '';
    r.std = v.std || '';
    if (temAtd) r.atd = v.atd || '';

    const packed = packedPorDestino.get(v.destino) || 0;
    if (precisaStaSnap) {
      r.to_sta = String(v.staged_to || 0);
      r.pacotes_sta = String(v.staged_pacotes || 0);
      r.packed_sta = String(packed);
      mudou = true;
    }
    if (precisaAtdSnap) {
      r.to_atd = String(v.staged_to || 0);
      r.pacotes_atd = String(v.staged_pacotes || 0);
      r.packed_atd = String(packed);
      mudou = true;
    }
    if (precisaStaSnap || precisaAtdSnap) r.atualizado_em = new Date().toISOString();
  });

  if (!mudou) return atuais;
  const registros = [...porTrip.values()];
  await writeMonitorRegistros(registros);
  return registros;
}

// Monitor - Live: só busca/computa quando pedido explicitamente (?monitor=1)
// — a página normal de Outbound não usa esse bloco. Curto-circuita antes do
// fetch de OUTBOUND_SHEET (planilha diferente, não precisa das duas).
//
// Dado de FATO migrado do Sheets (outbound_monitor_pulso) pro Postgres-ontime
// (tabela `outbound_monitor`, particionada por station_id — pedido do
// Roberto em 2026-09-25). Ficou fora da varredura multi-SoC de 2026-09-24
// (só tinha socDaSessaoOuErro no handler principal do arquivo, não aqui) —
// adicionado agora junto da migração.
async function buildMonitor(req, res) {
  const soc = socDaSessaoOuErro(req, res);
  if (!soc) return;

  let monRows;
  try {
    monRows = await lerPorStationId('outbound_monitor', soc);
  } catch (err) {
    res.status(502).json({ ok: false, erro: err.message });
    return;
  }

  const comDia = monRows.filter(r => r.sta).map(r => ({ ...r, __dia: dataOperacionalDe(r.sta) })).filter(r => r.__dia);
  const diasDisponiveis = [...new Set(comDia.map(r => r.__dia))].sort();
  const hojeIso = hojeOperacionalIso();
  // "Hoje" se tiver viagem hoje, senão o dia mais recente disponível (mesmo
  // padrão de api/inbound-lh.js — a fonte pode estar um pouco atrasada).
  const dia = diasDisponiveis.includes(hojeIso) ? hojeIso : (diasDisponiveis[diasDisponiveis.length - 1] || hojeIso);
  const doDia = comDia.filter(r => r.__dia === dia);

  const viagens = doDia.map(r => ({
    destino: r.destino || '',
    destino_codigo: r.destino_codigo || '',
    staged_pacotes: toNum(r.staged_pacotes),
    staged_to: toNum(r.staged_to),
    staged_peso_kg: r.staged_peso_kg || '',
    embalagens: r.embalagens || '',
    alerta_destino: r.alerta_destino || '',
    trip_number: r.trip_number || '',
    trip_name: r.trip_name || '',
    transportadora: r.transportadora || '',
    veiculo_tipo: r.veiculo_tipo || '',
    veiculo_placa: r.veiculo_placa || '',
    trip_status: r.trip_status || '',
    trip_station_status: r.trip_station_status || '',
    trip_operate_type: r.trip_operate_type || '',
    sta: r.sta || '',
    std: r.std || '',
    ata: r.ata || '',
    atd: r.atd || '',
    capacidade_pct: toNum(r.capacidade_pct),
    carga_qtd: toNum(r.carga_qtd),
    carga_pct: toNum(r.carga_pct),
    doca: r.doca || '',
    alerta_trip: r.alerta_trip || '',
  }));

  // Endereçamento/Pacotes Packed e registros (tags + snapshots) são
  // enriquecimentos opcionais (vêm de outras abas) — se falharem, o
  // Monitor - Live continua funcionando sem eles.
  let enderecamento = {}, packedPorDestino = new Map();
  try {
    ({ enderecamento, packedPorDestino } = await buildEnderecamentoPorDestino());
  } catch (err) { /* ignora — enriquecimento opcional */ }
  let registros = [];
  try {
    registros = await syncMonitorSnapshots(viagens, packedPorDestino);
  } catch (err) { /* ignora — snapshot é enriquecimento, não pode derrubar o Monitor */ }

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=180');
  res.status(200).json({
    ok: true,
    dia,
    cobertura: { inicio: diasDisponiveis[0] || null, fim: diasDisponiveis[diasDisponiveis.length - 1] || null },
    viagens,
    enderecamento,
    packed: Object.fromEntries(packedPorDestino),
    registros,
  });
}

module.exports = async (req, res) => {
  if (req.query.monitor !== undefined) {
    if (req.method === 'POST' && req.query.tag !== undefined) {
      await handleTagWrite(req, res);
      return;
    }
    await buildMonitor(req, res);
    return;
  }

  const soc = socDaSessaoOuErro(req, res);
  if (!soc) return;

  // rawdata_out_pulso é implicitamente RJ2 (sem coluna de SoC) — pra
  // qualquer outro SoC, nem busca (melhor nada do que misturar dado de RJ2
  // — pedido do Roberto em 2026-09-24). Mesma forma da resposta de sucesso,
  // só com os campos de dado vazios/zerados. (?monitor fica fora deste
  // gate, fora do escopo desta varredura.)
  if (soc !== 'RJ2') {
    res.status(200).json({
      ok: true,
      atualizadoEm: new Date().toISOString(),
      modo: 'hoje',
      intervalo: { inicio: null, fim: null },
      cobertura: { inicio: null, fim: null },
      atual: aggregate([]),
      porHoraCpt: { planejado: Array(24).fill(0), realizado: Array(24).fill(0), cancelado: Array(24).fill(0) },
      diasNoPeriodo: 0,
      carros: [], carrosTotal: 0,
      opcoesFiltro: { turno: ['T1', 'T2', 'T3'], status: [], solicitante: [], destino: [], agencia: [], veiculo: [] },
    });
    return;
  }

  let rows;
  try {
    ({ rows } = await fetchTabByGid(OUTBOUND_SHEET.spreadsheetId, OUTBOUND_SHEET.gid));
  } catch (err) {
    res.status(502).json({ ok: false, erro: err.message });
    return;
  }

  const enriquecidas = rows.filter(r => r.cutoff).map(enrich);

  const cutoffs = enriquecidas.map(r => r.cutoff).sort();
  const dataMinima = cutoffs[0];
  const dataMaxima = cutoffs[cutoffs.length - 1];

  const deQuery = req.query.de || '';
  const ateQuery = req.query.ate || '';
  const modo = (deQuery || ateQuery) ? 'historico' : 'hoje';

  let inicio, fim;
  if (modo === 'hoje') {
    inicio = fim = hojeOperacionalIso();
  } else {
    inicio = deQuery || dataMinima;
    fim = ateQuery || dataMaxima;
  }

  const doIntervalo = enriquecidas.filter(r => r.cutoff >= inicio && r.cutoff <= fim);

  const turnos = parseCSV(req.query.turno);
  const status = parseCSV(req.query.status);
  const solicitantes = parseCSV(req.query.solicitante);
  const destinos = parseCSV(req.query.destino);
  const agencias = parseCSV(req.query.agencia);
  const veiculos = parseCSV(req.query.veiculo);
  const tipos = parseCSV(req.query.tipo);
  const busca = (req.query.q || '').trim().toLowerCase();

  // FECHADA no filtro de Status = tem cpt_realizado preenchido (confirmado
  // com o Roberto em 2026-07-30) — mesma definição de "realizado" dos cards,
  // não o texto de status_agrupado, que pode ainda estar como ABERTA na
  // planilha mesmo com o carro já expedido. Os demais status seguem
  // batendo direto com status_agrupado.
  const bateStatus = (r, s) => s === 'FECHADA' ? !!r.cpt_realizado : r.status_agrupado === s;

  const passaFiltros = r =>
    (!turnos.length || turnos.includes(r.turno_shipped)) &&
    (!status.length || status.some(s => bateStatus(r, s))) &&
    (!solicitantes.length || solicitantes.includes(r.solicitation_by)) &&
    (!destinos.length || destinos.includes(r.destination_station_code)) &&
    (!agencias.length || agencias.includes(r.used_agency_name)) &&
    (!veiculos.length || veiculos.includes(r.used_vehicle)) &&
    (!tipos.length || tipos.includes(tipoCarregamento(r.destination_station_code))) &&
    (!busca || String(r.lh_trips || '').toLowerCase().includes(busca));

  const filtradas = doIntervalo.filter(passaFiltros);
  const atual = aggregate(filtradas);

  // Limite alto: com a paginação no front (100/página), dá pra mandar a base
  // filtrada inteira (~3,5 mil linhas hoje) sem estourar o navegador.
  const LIMITE = 20000;
  const ordenadas = modo === 'hoje'
    ? [...filtradas].sort((a, b) => String(a.hora_cpt_planejado || '99').localeCompare(String(b.hora_cpt_planejado || '99')))
    : [...filtradas].sort((a, b) => (b.cutoff || '').localeCompare(a.cutoff || ''));
  const carros = ordenadas.slice(0, LIMITE).map(toCarroRow);

  const uniq = key => [...new Set(doIntervalo.map(r => r[key]).filter(Boolean))].sort();

  // Carros por hora do CPT PLANEJADO (pedido do Roberto em 2026-08-18,
  // substitui a curva antiga por hora do ETA destino): 3 linhas — Planejado
  // (todo carro daquela hora, qualquer status), Realizado (tem cpt_realizado)
  // e Cancelado (status_agrupado CANCELADO) — pra enxergar volume de carros
  // por horário de CPT e melhorar a adequação do planejamento. diasNoPeriodo
  // = dias operacionais distintos entre as `filtradas` (cutoff), usado pelo
  // front pro toggle Média/Total (Total = soma bruta, Média = soma/dias).
  const cptPlanejadoPorHora = Array(24).fill(0);
  const cptRealizadoPorHora = Array(24).fill(0);
  const cptCanceladoPorHora = Array(24).fill(0);
  filtradas.forEach(r => {
    if (r.hora_cpt_planejado === '' || r.hora_cpt_planejado == null) return;
    const h = Number(r.hora_cpt_planejado);
    if (!Number.isInteger(h) || h < 0 || h > 23) return;
    cptPlanejadoPorHora[h]++;
    if (r.cpt_realizado) cptRealizadoPorHora[h]++;
    if (r.status_agrupado === 'CANCELADO') cptCanceladoPorHora[h]++;
  });
  const diasNoPeriodo = new Set(filtradas.map(r => r.cutoff).filter(Boolean)).size || 1;

  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
  res.status(200).json({
    ok: true,
    atualizadoEm: new Date().toISOString(),
    modo,
    intervalo: { inicio, fim },
    cobertura: { inicio: dataMinima, fim: dataMaxima },
    atual,
    porHoraCpt: { planejado: cptPlanejadoPorHora, realizado: cptRealizadoPorHora, cancelado: cptCanceladoPorHora },
    diasNoPeriodo,
    carros, carrosTotal: filtradas.length,
    opcoesFiltro: {
      turno: ['T1', 'T2', 'T3'],
      status: uniq('status_agrupado'),
      solicitante: uniq('solicitation_by'),
      destino: uniq('destination_station_code'),
      agencia: uniq('used_agency_name'),
      veiculo: uniq('used_vehicle'),
    },
  });
};
