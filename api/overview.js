/**
 * PULSO — Overview: retrato acumulado da operação, juntando os números já
 * calculados pelas outras páginas. Blocos, nessa ordem (confirmado com o
 * Roberto em 2026-08-04):
 *   1. Backlog: atual (média/hora) + grupos de perfil + clusters de aging
 *      (mesmos grupos da página Backlog — ver PERFIL_GRUPOS/
 *      AGING_CLUSTER_OF abaixo, têm que ficar em sincronia com o mesmo
 *      mapeamento em index.html)
 *   2. Inbound Line Haul: previstos/descarregados/andamento + quebra por
 *      canal (origem, classificada por prefixo — ver canalDeOrigemLh)
 *   3. Inbound First Mile: descarregados/andamento + quebra por canal
 *      (agência, já é um campo pequeno e direto na base)
 *   4. ASM: realizado (scans) vs planejado até agora (labor_pulso asm
 *      target) + quebra por zona real, média de zonas/mesas ativas por
 *      hora, pico e média de indução por hora
 *   5. Conveyor: realizado (pedidos) vs planejado até agora (labor_pulso
 *      packing esteira+volumoso) + quebra por grupo de estação (OBC/OBD já
 *      soma os dois códigos — ver classificarEsteira em api/conveyor.js),
 *      pico e média por hora
 *   6. Outbound: carros carregados vs planejados, saca/scuttle separados
 *      (com TOs de cada), quebra por canal (destino, por prefixo), % de
 *      Clusterização e pacotes no piso (= pacotesTotal da Clusterização,
 *      o staging onde os TOs ficam endereçados aguardando expedição — por
 *      isso entra no bloco Outbound, como primeiro card do bloco)
 *
 * Cada bloco com dado por hora real (todos exceto Backlog/Outbound, que
 * usam campos derivados — ver porHora/horaDeTs) também devolve uma
 * `serieHoraria` (24 posições, 0-23) pro gráfico planejado x realizado do
 * front, escondido por padrão num accordion abaixo do bloco.
 *
 * Em vez de duplicar a lógica de negócio de cada página (residuo, correção
 * de clusterização, etc.), esse endpoint chama as próprias APIs irmãs via
 * HTTP interno (mesmo deployment) e só agrega os números que elas já
 * calculam — Outbound/Clusterização/ASM/Conveyor/Inbound LH/FM/Backlog já
 * resolvem sozinhos "hoje operacional" (cutoff 6h, ver api/_period.js),
 * então aqui não passamos nenhum filtro de data, só lemos o default de cada
 * uma. Cada chamada é isolada em try/catch — a queda de uma fonte não
 * derruba o Overview inteiro, só zera aquele bloco (`erros` sinaliza qual).
 */
const { fetchTabByGid, fetchTabRawValues, updateRangeRaw, readRange, writeRange, ensureSheetExists } = require('./_google');
const { toNum, dataOperacionalDe, hojeOperacionalIso } = require('./_period');
const { buildArvore, writeArvoreValores, freezeArvoreAll, buildArvoreDoBanco, adicionarArvoreKpi, writeArvoreValoresDoBanco } = require('./_arvore');
const { socDaSessaoOuErro } = require('./_users');

// Planejamento de capacidade (labor_pulso) — inline em vez de um endpoint
// próprio (api/labor.js): Overview é o único consumidor hoje, e o limite de
// 12 funções serverless do plano Hobby da Vercel não sobra pra um endpoint
// dedicado só pra isso (confirmado com o Roberto em 2026-08-04, erro real
// de deploy). Se um dia existir uma página Labor Plan de verdade, separar
// de novo faz sentido — até lá, menos um function slot gasto.
const LABOR_SHEET = { spreadsheetId: '1BqZElDRwVaGpDYZzHTq9UQvVLy2guRVfTdvwGHL1qC4', gid: '1065816747' };
function brToIso(v) {
  const m = String(v || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
function mapLaborRow(r) {
  const dataIso = brToIso(r.data);
  if (dataIso === null) return null;
  const hora = toNum(r.hora);
  const data = dataOperacionalDe(`${dataIso} ${String(hora).padStart(2, '0')}:00:00`);
  if (data === null) return null;
  return {
    data, dataBr: r.data, hora,
    asmTarget: toNum(r['asm target']),
    asmZonas: toNum(r['asm (zonas)']),
    esteiraTermo: toNum(r['esteira termo']),
    nv1: toNum(r['nv.1']), nv2: toNum(r['nv.2']), nv3: toNum(r['nv.3']),
    packingEsteira: toNum(r['packing esteira']),
    packingVolumoso: toNum(r['packing volumoso']),
    // Metas por hora de Esteira A/B/Termo (pedido do Roberto em
    // 2026-08-19, feature de Justificativas — item 8.1) — colunas já
    // existem em labor_pulso, só não eram lidas até então.
    targetEsteiraA: toNum(r['target esteira a']),
    targetEsteiraB: toNum(r['target esteira b']),
    targetTermo: toNum(r['target termo']),
    // Justificativa gravada direto em labor_pulso, colunas T:AA
    // (pedido do Roberto em 2026-08-19 — a aba própria JUSTIFICATIVAS_
    // INPUT da 1ª versão foi descartada, tudo mora aqui agora, reason +
    // gap lado a lado por área). Reason vazio = ainda não justificado.
    justReasonAsm: r['reason asm'] || '', justGapAsm: r['gap asm'] || '',
    justReasonEsteiraA: r['reason esteira a'] || '', justGapEsteiraA: r['gap esteira a'] || '',
    justReasonEsteiraB: r['reason esteira b'] || '', justGapEsteiraB: r['gap esteira b'] || '',
    justReasonTermo: r['reason termo'] || '', justGapTermo: r['gap termo'] || '',
  };
}
async function getLaborTodos() {
  const { rows } = await fetchTabByGid(LABOR_SHEET.spreadsheetId, LABOR_SHEET.gid);
  return rows.filter(r => r.data && r.hora !== '').map(mapLaborRow).filter(Boolean);
}
async function getLabor() {
  const labor = await getLaborTodos();
  if (!labor.length) return { rows: [] };
  const datasDisponiveis = [...new Set(labor.map(r => r.data))].sort();
  const hojeIso = hojeOperacionalIso();
  const dataRef = datasDisponiveis.includes(hojeIso) ? hojeIso : datasDisponiveis[datasDisponiveis.length - 1];
  return { rows: labor.filter(r => r.data === dataRef).sort((a, b) => a.hora - b.hora) };
}

const PERFIL_GRUPOS = [
  { label: 'P', match: p => p === 'P' },
  { label: 'M', match: p => p === 'M' },
  { label: 'G', match: p => p === 'G' },
  { label: 'Bulky + Ração + S/Class', match: p => p === 'BULKY' || p === 'RAÇÃO' || p === 'S/CLASS' },
  { label: 'Tinta + Líquido', match: p => p === 'TINTA' || p === 'LIQUIDO' },
];
const AGING_CLUSTER_OF = { '0-1h': '0-4h', '1-2h': '0-4h', '2-4h': '0-4h', '4-8h': '4-24h', '8-24h': '4-24h', '>24h': '>24h' };
const AGING_CLUSTERS = ['0-4h', '4-24h', '>24h'];

// Canais por prefixo (mesmo padrão de destinoCategoria em api/cluster.js,
// aplicado às bases que ainda não tinham essa quebra) — confirmado ao vivo
// via debug-meta em 2026-08-04.
function canalDeDestinoOutbound(destino) {
  const d = String(destino || '').toUpperCase();
  if (d.startsWith('SOC-')) return 'SOC';
  if (d.startsWith('HUB-')) return 'LM Hub';
  if (d.startsWith('XPT-')) return 'XPT';
  if (d.startsWith('FMH-')) return 'FMH';
  return 'Outros';
}
const OUTBOUND_CANAIS = ['SOC', 'LM Hub', 'XPT', 'FMH', 'Outros'];

function canalDeOrigemLh(origem) {
  const o = String(origem || '');
  if (/^SoC_/i.test(o)) return 'SOC';
  if (/^FM Hub_/i.test(o)) return 'FM Hub';
  if (/^FBS_/i.test(o)) return 'FBS';
  return 'Outros';
}
const LH_CANAIS = ['SOC', 'FM Hub', 'FBS', 'Outros'];

const ASM_ZONAS_REAIS = ['ZONA A', 'ZONA B', 'ZONA C'];
const ASM_NIVEIS = ['Nível 1', 'Nível 2', 'Nível 3'];
const CNV_GRUPOS = ['OBA/OBB', 'OBC/OBD', 'Termoplástica', 'Esteira A', 'Esteira B', 'Tintas', 'TO-Audit', 'Non-TO'];

// Extrai a hora de um timestamp cru "YYYY-MM-DD HH:MM:SS" (usado nos
// cpt_planejado/cpt_realizado crus do Outbound) — mesmo padrão de horaDe()
// em api/inbound-lh.js, evita ambiguidade de fuso do parse via Date.
function horaDeTs(v) {
  const m = String(v || '').match(/(\d{2}):\d{2}:\d{2}/);
  return m ? Number(m[1]) : null;
}

// Soma valorFn(linha) em 24 posições (0-23) pela hora de cada linha
// (horaField pode ser o nome do campo ou uma função extratora).
function porHora(rows, horaField, valorFn) {
  const arr = Array.from({ length: 24 }, () => 0);
  rows.forEach(r => {
    const h = typeof horaField === 'function' ? horaField(r) : r[horaField];
    if (h === null || h === undefined || h < 0 || h > 23) return;
    arr[h] += valorFn ? valorFn(r) : 1;
  });
  return arr;
}

// `cookie` repassa a sessão de quem chamou — desde que o server.js passou a
// exigir login (pedido do Roberto em 2026-09-14, verificação via SeaTalk),
// essas sub-chamadas HTTP internas viraram requisições novas sem sessão
// nenhuma, e caíam todas em 401 "Não autenticado" mesmo com o usuário
// logado no navegador (bug achado pelo Roberto em 2026-09-15: Overview
// inteiro parava de trazer dado). O header 'x-overview-internal' já existia
// mas nunca foi de fato checado no gate — não dava pra confiar nele mesmo
// (um header é fácil de forjar por qualquer chamador externo); a sessão
// real é o jeito certo de autorizar essas chamadas.
async function getJson(base, path, cookie) {
  const r = await fetch(base + path, { headers: { 'x-overview-internal': '1', cookie: cookie || '' } });
  const j = await r.json();
  if (!j.ok) throw new Error(j.erro || (path + ' respondeu erro'));
  return j;
}

/* ================================================================
   JUSTIFICATIVAS (?justificativas=1) — pedido do Roberto em 2026-08-19,
   itens 8-12. Quando ASM ou uma das 3 áreas do Conveyor (Esteira A,
   Esteira B, Termo) fecham uma hora abaixo da meta de labor_pulso, essa
   hora×área vira uma PENDÊNCIA de justificativa.

   Gravado DIRETO em labor_pulso (pedido do Roberto em 2026-08-19,
   revisando a decisão inicial de usar uma aba própria) — colunas novas
   T em diante, reason+gap lado a lado por área:
     T=REASON ASM, U=GAP ASM, V=REASON ESTEIRA A, W=GAP ESTEIRA A,
     X=REASON ESTEIRA B, Y=GAP ESTEIRA B, Z=REASON TERMO, AA=GAP TERMO
   Sempre no fim da aba (nunca inserida no meio — colunas existentes são
   lidas por nome via cabeçalho, mas outras integrações podem depender da
   posição; inserir no meio deslocaria tudo depois). Escreve na LINHA já
   existente da planilha (Data+Hora já vêm pré-criados por quem mantém
   labor_pulso) via updateRangeRaw — só as 2 células daquele par
   reason/gap, nunca um clear+rewrite da aba inteira.

   Reason vazio = ainda não justificado (é a própria fonte de verdade do
   status, não precisa de coluna "Status" separada). Resubmissão
   sobrescreve reason/gap (mesma célula, não tem histórico de versão —
   ver CHANGELOG se algum dia precisar de append-only de verdade).
================================================================ */
const JUST_AREAS = ['ASM', 'Conveyor A', 'Conveyor B', 'Termo'];
// Ordem tem que bater com JUST_AREAS — cada entrada é [colunaReason, colunaGap], 1-based (T=20).
const JUST_COLS = { 'ASM': [20, 21], 'Conveyor A': [22, 23], 'Conveyor B': [24, 25], 'Termo': [26, 27] };
const JUST_HEADER_ROW = { 'ASM': ['REASON ASM', 'GAP ASM'], 'Conveyor A': ['REASON ESTEIRA A', 'GAP ESTEIRA A'], 'Conveyor B': ['REASON ESTEIRA B', 'GAP ESTEIRA B'], 'Termo': ['REASON TERMO', 'GAP TERMO'] };
function colLetter(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Taxonomia fixa de motivos (pedido do Roberto em 2026-08-19, "Justificativas
// de Perda de Capacidade") — Reason deixa de ser texto livre e vira um destes
// 5 valores, gravados na mesma célula REASON <área> de sempre (sem mudança de
// coluna/estrutura). "(Pendente)" não é um motivo de verdade, é o rótulo
// sintético usado nos agregados (porJustificativa/porMes) pra representar a
// perda que ainda não tem motivo registrado — sem ele o total perdido nas
// tabelas de "por justificativa" não bateria com o total real.
const JUST_MOTIVOS = ['Falta de HC', 'Equipamento', 'Falta de Material', 'Processo', 'Outros'];
const JUST_PENDENTE_LABEL = '(Pendente)';

// Semana ISO (segunda a domingo, mesma convenção usada em toda a
// planilha/telas do PULSO) e mês "YYYY-MM" a partir de uma data operacional
// (iso, "YYYY-MM-DD").
function isoWeekLabel(dataIso) {
  const d = new Date(dataIso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 4 - ((d.getUTCDay() + 6) % 7 + 1));
  const anoInicio = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const semana = Math.ceil((((d - anoInicio) / 86400000) + 1) / 7);
  return `W${String(semana).padStart(2, '0')}`;
}
function mesLabel(dataIso) { return dataIso.slice(0, 7); }

// Mesma classificação de grupo de esteira do Conveyor (api/conveyor.js
// classificarEsteira) — duplicada aqui (não exportada de lá) porque essa
// tela lê conveyor_pulso direto, sem passar pelo endpoint /api/conveyor
// (evita 1 fetch da aba inteira por dia do período, ver buildJustificativasHistorico).
// Se aquele mapeamento mudar, mudar aqui também.
function classificarEsteiraJust(esteira) {
  const e = String(esteira || '').toUpperCase();
  if (e === 'POBA' || e === 'POBB') return 'OBA/OBB';
  if (e === 'POBC' || e === 'POBD') return 'OBC/OBD';
  if (e === 'P4') return 'Termoplástica';
  if (e === 'P1') return 'Esteira A';
  if (e === 'P2') return 'Esteira B';
  if (e === 'PTIN') return 'Tintas';
  if (e === 'P_TO-AUDIT') return 'TO-Audit';
  return 'Non-TO';
}
const CONVEYOR_GRUPO_DA_AREA = { 'Conveyor A': 'Esteira A', 'Conveyor B': 'Esteira B', 'Termo': 'Termoplástica' };
const ASM_SHEET = { spreadsheetId: '1BqZElDRwVaGpDYZzHTq9UQvVLy2guRVfTdvwGHL1qC4', gid: '1776828985' };
const CONVEYOR_SHEET = { spreadsheetId: '1BqZElDRwVaGpDYZzHTq9UQvVLy2guRVfTdvwGHL1qC4', gid: '1013894222' };

// Linha por (data, hora, área) pro histórico inteiro disponível em
// labor_pulso — meta de lá, realizado buscado direto em asm_pulso/
// conveyor_pulso (1 fetch de cada aba inteira, não 1 por dia — ver
// comentário de classificarEsteiraJust acima). "Perda" só existe quando
// Realizado < Meta (bateu ou superou a meta não é perda, mesmo que o gap
// apareça negativo/positivo pra referência). Hora futura (ainda não
// rodou) nunca entra — nem pro dia de hoje nem, por construção, pra
// datas futuras pré-criadas na planilha.
function justLinhasHistorico(laborRows, asmRawRows, conveyorRawRows) {
  const porHoraAsm = new Map(); // "cutoff|hora" -> scan_numbers
  (asmRawRows || []).forEach(r => {
    if (!r.cutoff) return;
    const chave = `${r.cutoff}|${toNum(r.actual_sort_time_hour)}`;
    porHoraAsm.set(chave, (porHoraAsm.get(chave) || 0) + toNum(r.scan_numbers));
  });

  const porHoraGrupo = new Map(); // "data|hora|grupo" -> pacotes
  (conveyorRawRows || []).forEach(r => {
    if (!r['data extração'] || r.hora === '') return;
    const hora = toNum(r.hora);
    const dataIso = dataOperacionalDe(`${String(r['data extração']).slice(0, 10)} ${String(hora).padStart(2, '0')}:00:00`);
    if (!dataIso) return;
    const grupo = classificarEsteiraJust(r.esteira);
    const chave = `${dataIso}|${hora}|${grupo}`;
    porHoraGrupo.set(chave, (porHoraGrupo.get(chave) || 0) + toNum(r.pacotes));
  });

  const hojeIso = hojeOperacionalIso();
  const horaAgora = new Date(Date.now() - 3 * 60 * 60 * 1000).getUTCHours();
  const ordemHora = h => h >= 6 ? h - 6 : h + 18;
  const ordemAgora = ordemHora(horaAgora);

  const linhas = [];
  (laborRows || []).forEach(l => {
    if (l.data > hojeIso) return; // dia futuro, pré-criado na planilha — não rodou ainda
    if (l.data === hojeIso && ordemHora(l.hora) > ordemAgora) return; // hoje, hora futura
    const entradas = [
      { area: 'ASM', meta: l.asmTarget, realizado: porHoraAsm.get(`${l.data}|${l.hora}`) || 0, reason: l.justReasonAsm },
      { area: 'Conveyor A', meta: l.targetEsteiraA, realizado: porHoraGrupo.get(`${l.data}|${l.hora}|${CONVEYOR_GRUPO_DA_AREA['Conveyor A']}`) || 0, reason: l.justReasonEsteiraA },
      { area: 'Conveyor B', meta: l.targetEsteiraB, realizado: porHoraGrupo.get(`${l.data}|${l.hora}|${CONVEYOR_GRUPO_DA_AREA['Conveyor B']}`) || 0, reason: l.justReasonEsteiraB },
      { area: 'Termo', meta: l.targetTermo, realizado: porHoraGrupo.get(`${l.data}|${l.hora}|${CONVEYOR_GRUPO_DA_AREA['Termo']}`) || 0, reason: l.justReasonTermo },
    ];
    entradas.forEach(e => {
      if (!e.meta) return; // sem meta cadastrada pra essa hora/área — não dá pra avaliar
      const perda = Math.max(0, e.meta - e.realizado);
      linhas.push({
        data: l.data, dataBr: l.dataBr, semana: isoWeekLabel(l.data), mes: mesLabel(l.data),
        hora: l.hora, area: e.area,
        meta: e.meta, realizado: e.realizado, gap: e.realizado - e.meta, perda,
        pctAtendimento: e.meta ? Math.round(e.realizado / e.meta * 100) : null,
        reason: e.reason || '',
        status: perda > 0 ? (e.reason ? 'Justificada' : 'Pendente') : 'OK',
      });
    });
  });
  return linhas;
}

// Agrega uma lista de linhas (já filtrada) num resumo {perda, justificada,
// pendente, pctJustificada} — reutilizado pro resumo geral e por
// semana/mês (todas as tabelas do pedido usam a mesma conta).
function justResumo(linhas) {
  const perdidas = linhas.filter(l => l.perda > 0);
  const perdaTotal = perdidas.reduce((s, l) => s + l.perda, 0);
  const justificada = perdidas.filter(l => l.reason).reduce((s, l) => s + l.perda, 0);
  const pendente = perdaTotal - justificada;
  return {
    perdaTotal, justificada, pendente,
    pctJustificada: perdaTotal ? +(justificada / perdaTotal * 100).toFixed(1) : null,
  };
}
// Mesma janela T1 06-13h/T2 14-21h/T3 22-05h usada em todo o PULSO (ver
// turnoDeHora em api/asm.js) — duplicada aqui pelo mesmo motivo de lá.
function turnoDeHoraJust(hora) {
  if (hora === null || isNaN(hora)) return null;
  if (hora >= 6 && hora <= 13) return 'T1';
  if (hora >= 14 && hora <= 21) return 'T2';
  return 'T3';
}

// % Aderência ao Preenchimento por área × turno (pedido do Roberto em
// 2026-09-16): dentre as horas que perderam capacidade (precisavam de
// justificativa), quantas já foram preenchidas vs quantas ainda estão
// pendentes — quebrado por área e turno pra identificar quem está devendo.
// Ordenado do pior aderência pro melhor (prioriza o que precisa de atenção).
function justAderenciaPorAreaTurno(linhas) {
  const porChave = new Map();
  linhas.filter(l => l.perda > 0).forEach(l => {
    const turno = turnoDeHoraJust(l.hora);
    const chave = `${l.area}|${turno}`;
    if (!porChave.has(chave)) porChave.set(chave, { area: l.area, turno, pendencias: 0, justificadas: 0 });
    const acc = porChave.get(chave);
    if (l.reason) acc.justificadas++; else acc.pendencias++;
  });
  return [...porChave.values()].map(a => {
    const total = a.pendencias + a.justificadas;
    return { ...a, total, pctAderencia: total ? +(a.justificadas / total * 100).toFixed(1) : null };
  }).sort((a, b) => (a.pctAderencia ?? -1) - (b.pctAderencia ?? -1));
}

// Motivo (ou "(Pendente)") com maior perda dentro de uma lista de linhas.
function justPrincipal(linhas) {
  const porMotivo = new Map();
  linhas.filter(l => l.perda > 0).forEach(l => {
    const chave = l.reason || JUST_PENDENTE_LABEL;
    porMotivo.set(chave, (porMotivo.get(chave) || 0) + l.perda);
  });
  const top = [...porMotivo.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null;
}

// Acha a linha física de labor_pulso (Data BR + Hora) e escreve reason+gap
// só nas 2 células daquele par de colunas (T:AA) — nunca mexe em mais
// nada da linha/aba. Escreve o cabeçalho da coluna na 1ª vez que aquele
// par é usado (idempotente — só escreve se ainda estiver vazio).
async function writeLaborJustificativa({ dataBr, hora, area, reason, gap }) {
  const [colReason, colGap] = JUST_COLS[area];
  const { title, values } = await fetchTabRawValues(LABOR_SHEET.spreadsheetId, LABOR_SHEET.gid);
  const header = values[0] || [];
  const idxData = header.indexOf('DATA'), idxHora = header.indexOf('HORA');
  if (idxData === -1 || idxHora === -1) throw new Error('Colunas DATA/HORA não encontradas em labor_pulso');

  const rowIndex = values.findIndex((row, i) => i > 0 && row[idxData] === dataBr && Number(row[idxHora]) === Number(hora));
  if (rowIndex === -1) throw new Error(`Linha não encontrada em labor_pulso pra ${dataBr} ${hora}h`);
  const sheetRow = rowIndex + 1; // values é 0-based, planilha é 1-based (values[0] = linha 1 = cabeçalho)

  // Cabeçalho das colunas novas (T1:AA1) — só escreve o par que falta,
  // não mexe nos outros 3 pares nem em nada anterior a T.
  if (String(header[colReason - 1] || '').trim() === '') {
    await updateRangeRaw(LABOR_SHEET.spreadsheetId, `'${title}'!${colLetter(colReason)}1:${colLetter(colGap)}1`, [JUST_HEADER_ROW[area]]);
  }

  await updateRangeRaw(LABOR_SHEET.spreadsheetId, `'${title}'!${colLetter(colReason)}${sheetRow}:${colLetter(colGap)}${sheetRow}`, [[reason, gap]]);
}

async function buildJustificativas(req, res) {
  if (req.method === 'POST' && req.query.write !== undefined) {
    const body = req.body || {};
    const { dataBr, hora, area, reason, gap } = body;
    if (!dataBr || hora === undefined || hora === null || !area || !JUST_COLS[area]) {
      res.status(400).json({ ok: false, erro: 'dataBr, hora e area (válida) são obrigatórios' });
      return;
    }
    try {
      await writeLaborJustificativa({ dataBr, hora, area, reason: reason || '', gap: gap ?? '' });
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(502).json({ ok: false, erro: err.message });
    }
    return;
  }

  try {
    const [laborTodos, { rows: asmRaw }, { rows: conveyorRaw }] = await Promise.all([
      getLaborTodos(),
      fetchTabByGid(ASM_SHEET.spreadsheetId, ASM_SHEET.gid),
      fetchTabByGid(CONVEYOR_SHEET.spreadsheetId, CONVEYOR_SHEET.gid),
    ]);

    const todasLinhas = justLinhasHistorico(laborTodos, asmRaw, conveyorRaw);
    const datasDisponiveis = [...new Set(laborTodos.map(l => l.data))].sort();
    const hojeIso = hojeOperacionalIso();

    // Sem de/ate: mês corrente até hoje (aba tem o ano inteiro pré-criado,
    // não dá pra "mostrar tudo" por padrão sem carregar meses futuros vazios).
    const inicioMesIso = hojeIso.slice(0, 8) + '01';
    const de = (req.query.de && /^\d{4}-\d{2}-\d{2}$/.test(req.query.de)) ? req.query.de : inicioMesIso;
    const ate = (req.query.ate && /^\d{4}-\d{2}-\d{2}$/.test(req.query.ate)) ? req.query.ate : hojeIso;

    const canal = req.query.canal || '';
    const justificativa = req.query.justificativa || '';
    const semanaFiltro = req.query.semana || '';
    const mesFiltro = req.query.mes || '';
    const statusFiltro = req.query.status || '';

    const linhas = todasLinhas.filter(l =>
      l.data >= de && l.data <= ate &&
      (!canal || l.area === canal) &&
      (!semanaFiltro || l.semana === semanaFiltro) &&
      (!mesFiltro || l.mes === mesFiltro) &&
      (!statusFiltro || l.status === statusFiltro) &&
      (!justificativa || (justificativa === JUST_PENDENTE_LABEL ? !l.reason : l.reason === justificativa))
    );
    const perdidas = linhas.filter(l => l.perda > 0);

    // Por semana (item 2) — sempre no range filtrado, ordenado cronológico.
    const semanasNoRange = [...new Set(linhas.map(l => l.semana))].sort();
    const porSemana = semanasNoRange.map(semana => {
      const doGrupo = linhas.filter(l => l.semana === semana);
      const r = justResumo(doGrupo);
      return { semana, capacidadePerdida: r.perdaTotal, justificada: r.justificada, pendente: r.pendente, pctJustificada: r.pctJustificada, principalJustificativa: justPrincipal(doGrupo) };
    });

    // Por grupo de canal (pedido do Roberto em 2026-08-19, card novo do
    // Overview): ASM sozinho vs Conveyor (Esteira A+B+Termo somadas) — só
    // 2 grupos, não as 4 áreas soltas. "Perda" aqui já é em pacotes (mesma
    // unidade de scanNumbers/pacotes que alimenta meta/realizado), então
    // serve tanto pra "perda por canal" quanto "pacotes perdidos por canal".
    const GRUPO_DA_AREA = { 'ASM': 'ASM', 'Conveyor A': 'Conveyor', 'Conveyor B': 'Conveyor', 'Termo': 'Conveyor' };
    const porCanalGrupo = ['ASM', 'Conveyor'].map(grupo => {
      const doGrupo = linhas.filter(l => GRUPO_DA_AREA[l.area] === grupo);
      const r = justResumo(doGrupo);
      return { grupo, perda: r.perdaTotal, justificada: r.justificada, pendente: r.pendente, pctJustificada: r.pctJustificada };
    });

    // Por mês (item 3) — perda quebrada por motivo (colunas dinâmicas =
    // JUST_MOTIVOS + "(Pendente)"), pra montar a tabela mês x motivo.
    const mesesNoRange = [...new Set(linhas.map(l => l.mes))].sort();
    const porMes = mesesNoRange.map(mes => {
      const doGrupo = linhas.filter(l => l.mes === mes);
      const porMotivo = {};
      [...JUST_MOTIVOS, JUST_PENDENTE_LABEL].forEach(m => { porMotivo[m] = 0; });
      doGrupo.filter(l => l.perda > 0).forEach(l => { porMotivo[l.reason || JUST_PENDENTE_LABEL] += l.perda; });
      const total = Object.values(porMotivo).reduce((s, v) => s + v, 0);
      return { mes, porMotivo, total };
    });

    // Por justificativa (item 6) — volume, ocorrências, % do total, canal e
    // semana de maior impacto por motivo (incluindo "(Pendente)").
    const motivosNoRange = [...new Set(perdidas.map(l => l.reason || JUST_PENDENTE_LABEL))];
    const perdaTotalRange = perdidas.reduce((s, l) => s + l.perda, 0);
    const porJustificativa = motivosNoRange.map(motivo => {
      const doGrupo = perdidas.filter(l => (l.reason || JUST_PENDENTE_LABEL) === motivo);
      const perda = doGrupo.reduce((s, l) => s + l.perda, 0);
      const porCanal = new Map();
      doGrupo.forEach(l => porCanal.set(l.area, (porCanal.get(l.area) || 0) + l.perda));
      const canalTop = [...porCanal.entries()].sort((a, b) => b[1] - a[1])[0];
      const porSemanaMotivo = new Map();
      doGrupo.forEach(l => porSemanaMotivo.set(l.semana, (porSemanaMotivo.get(l.semana) || 0) + l.perda));
      const semanaTop = [...porSemanaMotivo.entries()].sort((a, b) => b[1] - a[1])[0];
      return {
        motivo, perda, ocorrencias: doGrupo.length,
        pctTotal: perdaTotalRange ? +(perda / perdaTotalRange * 100).toFixed(1) : 0,
        canalMaisImpactado: canalTop ? canalTop[0] : null,
        periodoMaiorImpacto: semanaTop ? semanaTop[0] : null,
      };
    }).sort((a, b) => b.perda - a.perda);

    // Tabela na granularidade selecionada (item 5: Hora/Dia/Semana).
    const granularidade = ['hora', 'dia', 'semana'].includes(req.query.granularidade) ? req.query.granularidade : 'dia';
    let tabela;
    if (granularidade === 'hora') {
      tabela = linhas.map(l => ({
        data: l.data, dataBr: l.dataBr, hora: l.hora, area: l.area, meta: l.meta, realizado: l.realizado,
        perda: l.perda, reason: l.reason, status: l.status,
      })).sort((a, b) => a.data === b.data ? a.hora - b.hora : a.data.localeCompare(b.data));
    } else if (granularidade === 'semana') {
      tabela = porSemana.map(s => ({
        chave: s.semana, planejado: null, realizado: null,
        perda: s.capacidadePerdida, pctPerda: null, justificativaPrincipal: s.principalJustificativa,
      }));
    } else {
      const diasNoRange = [...new Set(linhas.map(l => l.data))].sort();
      tabela = diasNoRange.map(data => {
        const doDia = linhas.filter(l => l.data === data);
        const planejado = doDia.reduce((s, l) => s + l.meta, 0);
        const realizado = doDia.reduce((s, l) => s + l.realizado, 0);
        const perda = doDia.reduce((s, l) => s + l.perda, 0);
        return {
          chave: data, planejado, realizado, perda,
          pctPerda: planejado ? +(perda / planejado * 100).toFixed(1) : 0,
          justificativaPrincipal: justPrincipal(doDia),
        };
      });
    }

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=180');
    res.status(200).json({
      ok: true,
      atualizadoEm: new Date().toISOString(),
      intervalo: { inicio: de, fim: ate },
      cobertura: { inicio: datasDisponiveis[0] || null, fim: datasDisponiveis[datasDisponiveis.length - 1] || null },
      filtros: { canal, justificativa, semana: semanaFiltro, mes: mesFiltro, status: statusFiltro, granularidade },
      motivos: JUST_MOTIVOS,
      motivoPendenteLabel: JUST_PENDENTE_LABEL,
      areas: JUST_AREAS,
      resumo: justResumo(linhas),
      porSemana, porMes, porJustificativa, porCanalGrupo, tabela,
      aderenciaAreaTurno: justAderenciaPorAreaTurno(linhas),
      // Compat com a versão anterior da tela (pendências "de hoje" + KPIs
      // simples) — Overview usa só `resumo`/`porJustificativa` agora, mas o
      // botão antigo ainda pode apontar aqui até o front terminar de migrar.
      pendencias: linhas.filter(l => l.data === hojeIso && l.status === 'Pendente').sort((a, b) => a.hora - b.hora),
    });
  } catch (err) {
    res.status(502).json({ ok: false, erro: err.message });
  }
}

/* ================================================================
   KANBAN DE DEMANDAS (?kanban=1) — pedido do Roberto em 2026-08-27: quadro
   Kanban (post-its) por responsável × status, com área de "Demandas sem
   Dono".

   Tudo numa aba SÓ (pedido do Roberto em 2026-08-28: "tínhamos mais de
   uma página pra atender a mesma página, organize numa só" — 2ª rodada de
   consolidação, a 1ª já tinha juntado donos+colunas; agora entra demandas
   também). `tipo` distingue a linha: 'demanda' (usa titulo/descricao/dono/
   prioridade/status/datas/tag/url), 'dono' (chave=nome, usa criado_em/
   ordem/cor) ou 'coluna' (chave=status, só usa cor). Read-modify-write da
   aba inteira a cada escrita (kanbanWriteTab reescreve tudo).

   Dono sem nenhuma demanda ainda vira uma linha tipo='dono' (pra aparecer
   como linha vazia no quadro) — dono que já tem demanda não precisa dessa
   linha; a lista de linhas do quadro no front é a união dos nomes das 2
   fontes (demandas.dono + donos tipo='dono').

   "Atrasado" NÃO é um status gravado — é calculado no front a partir de
   data_entrega vs hoje (ver item 11 do pedido), pra não precisar desfazer
   manualmente toda vez que deixar de estar atrasado. status guardado é só
   fila/andamento/hold/finalizado.
================================================================ */
const KANBAN_TITLE = 'kanban_input';
// Superset de todo campo usado por qualquer um dos 3 tipos de linha —
// campos que não se aplicam a um tipo ficam em branco nessa linha.
// titulo..url = campos de 'demanda' (mesma ordem/nomes de antes, pra não
// precisar migrar o shape que o front já consome); chave/ordem/cor =
// campos de 'dono'/'coluna'.
// `soc` no fim (pedido do Roberto em 2026-09-21: cada SoC vê só o próprio
// quadro) — coluna nova acrescentada ao header, não quebra leitura de linha
// antiga (kanbanLinhaParaObjeto já trata campo ausente como ''); linha sem
// soc gravado (dado de antes dessa mudança) é tratada como 'RJ2', o único
// SoC que já tinha dado de verdade até aqui.
const KANBAN_HEADER = [
  'tipo', 'id', 'titulo', 'descricao', 'dono', 'prioridade', 'status',
  'data_solicitacao', 'data_entrega', 'data_conclusao', 'criado_em',
  'atualizado_em', 'tag', 'url', 'chave', 'ordem', 'cor', 'soc',
];
const KANBAN_COLUNA_IDS = new Set(['fila', 'atrasado', 'andamento', 'hold', 'finalizado']);
const KANBAN_COR_RE = /^#[0-9a-fA-F]{6}$/;
const KANBAN_PRIORIDADES = new Set(['alta', 'media', 'baixa']);
const KANBAN_STATUS = new Set(['fila', 'andamento', 'hold', 'finalizado']);
const KANBAN_TAGS = new Set(['analise', 'sql', 'python', 'html', 'outros']);

function kanbanRange(title, header) {
  return `'${title}'!A:${String.fromCharCode(64 + header.length)}`;
}
function kanbanLinhaParaObjeto(header, r) {
  const o = {};
  header.forEach((campo, i) => { o[campo] = r[i] || ''; });
  return o;
}
function kanbanObjetoParaLinha(header, o) {
  return header.map(campo => o[campo] != null ? o[campo] : '');
}
async function kanbanReadTab(title, header) {
  let values;
  try {
    values = await readRange(LABOR_SHEET.spreadsheetId, kanbanRange(title, header));
  } catch (err) {
    await ensureSheetExists(LABOR_SHEET.spreadsheetId, title);
    await writeRange(LABOR_SHEET.spreadsheetId, kanbanRange(title, header), [header]);
    return [];
  }
  if (!values.length) return [];
  return values.slice(1).map(r => kanbanLinhaParaObjeto(header, r)).filter(o => o.id);
}
async function kanbanWriteTab(title, header, objetos) {
  await writeRange(LABOR_SHEET.spreadsheetId, kanbanRange(title, header), [header, ...objetos.map(o => kanbanObjetoParaLinha(header, o))]);
}
function novoKanbanId(prefixo) {
  return prefixo + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function kanbanSocDaLinha(r) { return r.soc || 'RJ2'; }

// Lê a aba única e já separa em {donos, colunas, demandas} no formato que
// o front espera (mesmo shape de sempre), filtrado pro SoC da sessão —
// mutações sempre leem só o próprio SoC, mexem no subconjunto que
// interessa, e escrevem de volta (kanbanWriteAll preserva os outros SoCs).
async function kanbanReadAll(soc) {
  const rows = await kanbanReadTab(KANBAN_TITLE, KANBAN_HEADER);
  const doSoc = rows.filter(r => kanbanSocDaLinha(r) === soc);
  return {
    donos: doSoc.filter(r => r.tipo === 'dono').map(r => ({ id: r.id, nome: r.chave, criado_em: r.criado_em, ordem: r.ordem, cor: r.cor })),
    colunas: doSoc.filter(r => r.tipo === 'coluna').map(r => ({ id: r.id, status: r.chave, cor: r.cor })),
    demandas: doSoc.filter(r => r.tipo === 'demanda').map(r => ({
      id: r.id, titulo: r.titulo, descricao: r.descricao, dono: r.dono, prioridade: r.prioridade, status: r.status,
      data_solicitacao: r.data_solicitacao, data_entrega: r.data_entrega, data_conclusao: r.data_conclusao,
      criado_em: r.criado_em, atualizado_em: r.atualizado_em, tag: r.tag, url: r.url,
    })),
  };
}
// Reescreve só as linhas do SoC atual, preservando intactas as de todos os
// outros SoCs (a aba é única — kanbanWriteTab sempre reescreve ela inteira).
async function kanbanWriteAll(soc, donos, colunas, demandas) {
  const todasAsLinhas = await kanbanReadTab(KANBAN_TITLE, KANBAN_HEADER);
  const deOutrosSocs = todasAsLinhas.filter(r => kanbanSocDaLinha(r) !== soc);
  const linhasDesteSoc = [
    ...donos.map(d => ({ tipo: 'dono', id: d.id, chave: d.nome, criado_em: d.criado_em || '', ordem: d.ordem != null ? d.ordem : '', cor: d.cor || '', soc })),
    ...colunas.map(c => ({ tipo: 'coluna', id: c.id, chave: c.status, cor: c.cor || '', soc })),
    ...demandas.map(d => ({ tipo: 'demanda', ...d, soc })),
  ];
  await kanbanWriteTab(KANBAN_TITLE, KANBAN_HEADER, [...deOutrosSocs, ...linhasDesteSoc]);
}

async function buildKanban(req, res) {
  // Cada SoC vê só o próprio quadro (pedido do Roberto em 2026-09-21) — soc
  // vem da sessão (já escolhido no login). Sem fallback silencioso pra RJ2
  // (pedido do Roberto em 2026-09-22): sessão sem SoC válido é erro
  // explícito, não mistura dado de ninguém com o de RJ2 por engano.
  const soc = socDaSessaoOuErro(req, res);
  if (!soc) return;

  if (req.method === 'POST') {
    const action = (req.body || {}).action;
    const entry = (req.body || {}).entry || {};
    try {
      const agora = new Date().toISOString();

      if (action === 'create_dono') {
        const nome = String(entry.nome || '').trim();
        if (!nome) { res.status(400).json({ ok: false, erro: 'nome é obrigatório' }); return; }
        const { donos, colunas, demandas } = await kanbanReadAll(soc);
        donos.push({ id: novoKanbanId('do'), nome, criado_em: agora });
        await kanbanWriteAll(soc, donos, colunas, demandas);
        res.status(200).json({ ok: true, donos });
        return;
      }
      if (action === 'delete_dono') {
        const { donos, colunas, demandas } = await kanbanReadAll(soc);
        const restantes = donos.filter(d => d.id !== entry.id);
        await kanbanWriteAll(soc, restantes, colunas, demandas);
        res.status(200).json({ ok: true, donos: restantes });
        return;
      }
      // Upsert por nome — o dono pode ainda não ter linha própria (só
      // existe via nome usado em demanda.dono).
      if (action === 'update_dono_ordens') {
        const ordens = Array.isArray(entry.ordens) ? entry.ordens : [];
        const { donos, colunas, demandas } = await kanbanReadAll(soc);
        ordens.forEach(({ nome, ordem }) => {
          if (!nome) return;
          const atual = donos.find(d => d.nome === nome);
          if (atual) atual.ordem = ordem;
          else donos.push({ id: novoKanbanId('do'), nome, criado_em: agora, ordem, cor: '' });
        });
        await kanbanWriteAll(soc, donos, colunas, demandas);
        res.status(200).json({ ok: true, donos });
        return;
      }
      if (action === 'update_dono_cor') {
        const nome = String(entry.nome || '').trim();
        const cor = entry.cor && KANBAN_COR_RE.test(entry.cor) ? entry.cor : '';
        if (!nome) { res.status(400).json({ ok: false, erro: 'nome é obrigatório' }); return; }
        const { donos, colunas, demandas } = await kanbanReadAll(soc);
        const atual = donos.find(d => d.nome === nome);
        if (atual) atual.cor = cor;
        else donos.push({ id: novoKanbanId('do'), nome, criado_em: agora, ordem: '', cor });
        await kanbanWriteAll(soc, donos, colunas, demandas);
        res.status(200).json({ ok: true, donos });
        return;
      }
      if (action === 'update_coluna_cor') {
        const status = String(entry.status || '');
        if (!KANBAN_COLUNA_IDS.has(status)) { res.status(400).json({ ok: false, erro: 'coluna inválida' }); return; }
        const cor = entry.cor && KANBAN_COR_RE.test(entry.cor) ? entry.cor : '';
        const { donos, colunas, demandas } = await kanbanReadAll(soc);
        const atual = colunas.find(c => c.status === status);
        if (atual) atual.cor = cor;
        else colunas.push({ id: status, status, cor });
        await kanbanWriteAll(soc, donos, colunas, demandas);
        res.status(200).json({ ok: true, colunas });
        return;
      }

      if (action === 'create_demanda' || action === 'update_demanda') {
        const { donos, colunas, demandas } = await kanbanReadAll(soc);
        if (entry.prioridade && !KANBAN_PRIORIDADES.has(entry.prioridade)) { res.status(400).json({ ok: false, erro: 'prioridade inválida' }); return; }
        if (entry.status && !KANBAN_STATUS.has(entry.status)) { res.status(400).json({ ok: false, erro: 'status inválido' }); return; }
        if (entry.tag && !KANBAN_TAGS.has(entry.tag)) { res.status(400).json({ ok: false, erro: 'tag inválida' }); return; }
        if (entry.url && !/^https?:\/\//i.test(entry.url)) { res.status(400).json({ ok: false, erro: 'link precisa começar com http:// ou https://' }); return; }

        if (action === 'create_demanda') {
          if (!String(entry.titulo || '').trim()) { res.status(400).json({ ok: false, erro: 'titulo é obrigatório' }); return; }
          const status = KANBAN_STATUS.has(entry.status) ? entry.status : 'fila';
          const nova = {
            id: novoKanbanId('dm'), titulo: entry.titulo, descricao: entry.descricao || '',
            dono: entry.dono || '', prioridade: KANBAN_PRIORIDADES.has(entry.prioridade) ? entry.prioridade : 'media',
            status, tag: KANBAN_TAGS.has(entry.tag) ? entry.tag : '', url: entry.url || '',
            data_solicitacao: entry.data_solicitacao || agora.slice(0, 10),
            data_entrega: entry.data_entrega || '', data_conclusao: status === 'finalizado' ? agora.slice(0, 10) : '',
            criado_em: agora, atualizado_em: agora,
          };
          demandas.push(nova);
          await kanbanWriteAll(soc, donos, colunas, demandas);
          res.status(200).json({ ok: true, demandas });
          return;
        }

        // update_demanda
        const idx = demandas.findIndex(d => d.id === entry.id);
        if (idx === -1) { res.status(404).json({ ok: false, erro: 'demanda não encontrada' }); return; }
        const atual = demandas[idx];
        const statusMudouParaFinalizado = entry.status === 'finalizado' && atual.status !== 'finalizado';
        const statusSaiuDeFinalizado = entry.status && entry.status !== 'finalizado' && atual.status === 'finalizado';
        demandas[idx] = {
          ...atual,
          titulo: entry.titulo != null ? entry.titulo : atual.titulo,
          descricao: entry.descricao != null ? entry.descricao : atual.descricao,
          dono: entry.dono != null ? entry.dono : atual.dono,
          prioridade: entry.prioridade || atual.prioridade,
          status: entry.status || atual.status,
          tag: entry.tag != null ? entry.tag : atual.tag,
          url: entry.url != null ? entry.url : atual.url,
          data_solicitacao: entry.data_solicitacao || atual.data_solicitacao,
          data_entrega: entry.data_entrega != null ? entry.data_entrega : atual.data_entrega,
          // data_conclusao é regra de servidor — setada/limpa automaticamente
          // pela transição de status, não aceita valor arbitrário do cliente.
          data_conclusao: statusMudouParaFinalizado ? agora.slice(0, 10) : (statusSaiuDeFinalizado ? '' : atual.data_conclusao),
          atualizado_em: agora,
        };
        await kanbanWriteAll(soc, donos, colunas, demandas);
        res.status(200).json({ ok: true, demandas });
        return;
      }

      if (action === 'delete_demanda') {
        const { donos, colunas, demandas } = await kanbanReadAll(soc);
        const restantes = demandas.filter(d => d.id !== entry.id);
        await kanbanWriteAll(soc, donos, colunas, restantes);
        res.status(200).json({ ok: true, demandas: restantes });
        return;
      }

      res.status(400).json({ ok: false, erro: 'action inválida' });
    } catch (err) {
      res.status(502).json({ ok: false, erro: err.message });
    }
    return;
  }

  try {
    const { donos, colunas, demandas } = await kanbanReadAll(soc);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, donos, demandas, colunas, soc });
  } catch (err) {
    res.status(502).json({ ok: false, erro: err.message });
  }
}

/* ================================================================
   MAPA DE DADOS (?datamap=1) — pedido do Roberto em 2026-08-27: catálogo
   de verdade pro time de dados (queries/scripts/docs por card, com quem é
   o responsável), substituindo o mock em memória que existia antes
   (perdia tudo no F5). Guarda numa aba própria (mapa_dados_input, criada
   sozinha no primeiro uso via ensureSheetExists — mesmo padrão de
   monitor_tags_pulso em api/outbound.js), sem gid fixo pra resolver (aba
   nova, sem risco de rename por terceiros) — lê/escreve sempre pelo nome
   literal. Read-modify-write da aba inteira a cada escrita (clear+rewrite
   via writeRange) — volume esperado é baixo (catálogo, não telemetria),
   mesmo raciocínio de custo já usado pra Monitor Tags.
================================================================ */
const DATAMAP_SHEET_TITLE = 'mapa_dados_input';
const DATAMAP_HEADER = ['id', 'tipo', 'titulo', 'descricao_md', 'codigo', 'link', 'responsavel_email', 'criado_em', 'atualizado_em'];
const DATAMAP_TIPOS = new Set(['sql', 'py', 'html', 'link', 'sheet']);
function datamapRange() {
  return `'${DATAMAP_SHEET_TITLE}'!A:${String.fromCharCode(64 + DATAMAP_HEADER.length)}`;
}
function linhaParaEntradaDatamap(r) {
  const o = {};
  DATAMAP_HEADER.forEach((campo, i) => { o[campo] = r[i] || ''; });
  return o;
}
function entradaParaLinhaDatamap(o) {
  return DATAMAP_HEADER.map(campo => o[campo] != null ? o[campo] : '');
}
async function readDatamapEntradas() {
  let values;
  try {
    values = await readRange(LABOR_SHEET.spreadsheetId, datamapRange());
  } catch (err) {
    // Aba ainda não existe (1º uso da feature) — cria com o cabeçalho certo.
    await ensureSheetExists(LABOR_SHEET.spreadsheetId, DATAMAP_SHEET_TITLE);
    await writeRange(LABOR_SHEET.spreadsheetId, datamapRange(), [DATAMAP_HEADER]);
    return [];
  }
  if (!values.length) return [];
  return values.slice(1).map(linhaParaEntradaDatamap).filter(e => e.id);
}
async function writeDatamapEntradas(entradas) {
  await writeRange(LABOR_SHEET.spreadsheetId, datamapRange(), [DATAMAP_HEADER, ...entradas.map(entradaParaLinhaDatamap)]);
}
function novoDatamapId() {
  return 'dm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function buildDataMap(req, res) {
  if (req.method === 'POST') {
    const action = (req.body || {}).action;
    const entrada = (req.body || {}).entry || {};
    try {
      const atuais = await readDatamapEntradas();
      const agora = new Date().toISOString();

      if (action === 'create') {
        if (!String(entrada.titulo || '').trim() || !DATAMAP_TIPOS.has(entrada.tipo)) {
          res.status(400).json({ ok: false, erro: 'titulo e tipo válido (sql/py/html/link/sheet) são obrigatórios' });
          return;
        }
        const nova = {
          id: novoDatamapId(), tipo: entrada.tipo, titulo: entrada.titulo,
          descricao_md: entrada.descricao_md || '', codigo: entrada.codigo || '', link: entrada.link || '',
          responsavel_email: entrada.responsavel_email || '',
          criado_em: agora, atualizado_em: agora,
        };
        atuais.push(nova);
        await writeDatamapEntradas(atuais);
        res.status(200).json({ ok: true, entries: atuais });
        return;
      }

      if (action === 'update') {
        const idx = atuais.findIndex(e => e.id === entrada.id);
        if (idx === -1) { res.status(404).json({ ok: false, erro: 'entrada não encontrada' }); return; }
        if (entrada.tipo && !DATAMAP_TIPOS.has(entrada.tipo)) { res.status(400).json({ ok: false, erro: 'tipo inválido' }); return; }
        atuais[idx] = {
          ...atuais[idx],
          tipo: entrada.tipo || atuais[idx].tipo,
          titulo: entrada.titulo || atuais[idx].titulo,
          descricao_md: entrada.descricao_md ?? atuais[idx].descricao_md,
          codigo: entrada.codigo ?? atuais[idx].codigo,
          link: entrada.link ?? atuais[idx].link,
          responsavel_email: entrada.responsavel_email ?? atuais[idx].responsavel_email,
          atualizado_em: agora,
        };
        await writeDatamapEntradas(atuais);
        res.status(200).json({ ok: true, entries: atuais });
        return;
      }

      if (action === 'delete') {
        const restantes = atuais.filter(e => e.id !== entrada.id);
        await writeDatamapEntradas(restantes);
        res.status(200).json({ ok: true, entries: restantes });
        return;
      }

      res.status(400).json({ ok: false, erro: 'action inválida (create/update/delete)' });
    } catch (err) {
      res.status(502).json({ ok: false, erro: err.message });
    }
    return;
  }

  try {
    const entries = await readDatamapEntradas();
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, entries });
  } catch (err) {
    res.status(502).json({ ok: false, erro: err.message });
  }
}

/* ================================================================
   LABOR PLAN (?laborplan=1) — modelo de planejamento de mão de obra,
   lido direto da aba `bat` (planilha construída pelo Roberto, 2026-09).
   Ver docs/prompt-modelo-labor-plan.md pro modelo completo — resumo:
     RECURSOS (escala)  →  DEMANDA (forecast × curva)  →  CAPACIDADE (HC × PHD)
   Mora aqui (não em api/labor-plan.js) pelo mesmo motivo do bloco Labor
   Plan do Overview logo acima: teto de 12 functions do plano Hobby.

   A aba `bat` é UMA planilha larga com 5 blocos de colunas lado a lado,
   cada um com sua própria altura de linhas (não são abas separadas):
     A–F   premissas (subprocessos, cada um vinculado a um MACRO)
     G–P   forecast (data × origem, ano inteiro)
     Q–V   curva Line Haul (24h × 7 dias, fluxo "HUB")
     W–AB  curva First Mile (24h × 7 dias, fluxo "FM")
     AC–AO quadro (escala hora a hora, 1 semana)

   IMPORTANTE: essa aba usa formatação de número em INGLÊS (vírgula =
   milhar, ponto = decimal — ex. "4,355" = 4355), o OPOSTO do padrão
   pt-BR (vírgula=decimal) que o resto do PULSO usa via toNum() de
   _period.js. Por isso um parser próprio aqui (numBat), NUNCA toNum.
================================================================ */
const BAT_SHEET = { spreadsheetId: '1BqZElDRwVaGpDYZzHTq9UQvVLy2guRVfTdvwGHL1qC4', gid: '176897844' };

// Índices de coluna (0-based) confirmados ao vivo em 2026-09-03 via
// debug-meta — a aba não tem cabeçalho único, então acesso é posicional.
const BAT_COL = {
  processo: 0, porWs: 1, phd: 2, nominal: 3, priorizacao: 4, macro: 5,
  fctData: 7, fctDestino: 8, fctOrigem: 9, fctDireto: 10, fctTransp: 11, fctTotal: 12, fctApoio: 15,
  lhHora: 17, lhPct: 19, lhDia: 21,
  fmHora: 23, fmPct: 25, fmDia: 27,
  qData: 29, qDiaEn: 30, qHora: 32, qTurno: 33, qT1A: 34, qT1B: 35, qT2: 36, qT4: 37, qT3: 38, qFixo: 39, qFolgas: 40,
};

// Formato inglês (vírgula=milhar, ponto=decimal) — ver comentário acima.
// "-" e vazio viram null (célula sem dado, não zero).
function numBat(v) {
  const s = String(v ?? '').trim().replace(/%$/, '');
  if (!s || s === '-') return null;
  const n = Number(s.replace(/,/g, ''));
  return isNaN(n) ? null : n;
}
function batDataIso(v) {
  const m = String(v || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
const DIAS_PT = ['DOMINGO', 'SEGUNDA', 'TERÇA', 'QUARTA', 'QUINTA', 'SEXTA', 'SÁBADO'];
function diaSemanaPtDe(dataIso) {
  const [y, m, d] = dataIso.split('-').map(Number);
  return DIAS_PT[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

// Macros "especiais" das premissas — não são subprocesso operacional (ver
// docs/prompt-modelo-labor-plan.md §2.1b/c): ATIVO = recurso instalado,
// os demais = parâmetro solto (roteamento, OEE, SPR...).
const BAT_MACROS_ESPECIAIS = new Set(['ATIVO', 'PERFIL', 'OEE', 'SPR', 'INDICADOR', 'MINUTOS']);

// Único mapeamento direto e confirmado hoje entre um macro operacional e
// sua contagem de recurso instalado (bloco ATIVO) — os demais macros não
// têm uma linha ATIVO equivalente ainda, então N_instalado fica null e a
// tela deixa o planejador escolher N livremente (ver §3.1 do modelo).
const BAT_MACRO_ATIVO = { ESTEIRA: 'ESTEIRAS' };

async function buildLaborplan(req, res) {
  let values;
  try {
    ({ values } = await fetchTabRawValues(BAT_SHEET.spreadsheetId, BAT_SHEET.gid));
  } catch (err) {
    res.status(502).json({ ok: false, erro: err.message });
    return;
  }
  const rows = values.slice(1);
  const avisos = [];

  // --- Premissas (A–F): subprocessos vinculados a um macro -----------
  const subprocessos = rows
    .filter(r => String(r[BAT_COL.processo] || '').trim())
    .map(r => ({
      processo: String(r[BAT_COL.processo]).trim(),
      porWs: numBat(r[BAT_COL.porWs]),
      phd: numBat(r[BAT_COL.phd]),
      nominal: numBat(r[BAT_COL.nominal]),
      priorizacao: numBat(r[BAT_COL.priorizacao]),
      macro: String(r[BAT_COL.macro] || '').trim(),
    }));
  const semPriorizacao = subprocessos.filter(s => !BAT_MACROS_ESPECIAIS.has(s.macro) && s.priorizacao === null).length;
  if (semPriorizacao) avisos.push(`${semPriorizacao} subprocesso(s) sem PRIORIZAÇÃO definida — não entram na ordem de corte quando o HC não fecha.`);

  const ativos = subprocessos.filter(s => s.macro === 'ATIVO');
  const perfil = subprocessos.filter(s => s.macro === 'PERFIL');
  const oee = subprocessos.filter(s => s.macro === 'OEE');

  const operacionais = subprocessos.filter(s => !BAT_MACROS_ESPECIAIS.has(s.macro));
  const nomesMacro = [...new Set(operacionais.map(s => s.macro))];
  const macros = nomesMacro.map(macro => {
    const subs = operacionais.filter(s => s.macro === macro).map(s => ({ ...s, indireto: s.phd === null }));
    const somaPorWs = subs.reduce((acc, s) => acc + (s.porWs || 0), 0);
    const somaPhd = subs.reduce((acc, s) => acc + (s.phd || 0), 0); // indiretos (phd null) somam 0
    const ativoRef = BAT_MACRO_ATIVO[macro] ? ativos.find(a => a.processo === BAT_MACRO_ATIVO[macro]) : null;
    const nInstalado = ativoRef ? (ativoRef.nominal ?? ativoRef.phd ?? ativoRef.porWs) : null;
    return {
      macro,
      subprocessos: subs,
      hcPorInstancia: somaPorWs,   // HC(macro, N=1) — múltiplo linear em N
      capacidadePorInstancia: somaPhd, // capacidade(macro, N=1)
      nInstalado,
      qtdIndiretos: subs.filter(s => s.indireto).length,
    };
  });

  // --- Forecast (G–P): volume por data × origem, classificado HUB/FM -
  const forecastRows = rows
    .filter(r => batDataIso(r[BAT_COL.fctData]))
    .map(r => ({
      data: batDataIso(r[BAT_COL.fctData]),
      origem: String(r[BAT_COL.fctOrigem] || '').trim(),
      total: numBat(r[BAT_COL.fctTotal]) || 0,
      apoio: String(r[BAT_COL.fctApoio] || '').trim().toUpperCase(),
    }));
  const datasForecast = [...new Set(forecastRows.map(f => f.data))].sort();

  // --- Curvas (Q–V, W–AB): % por dia da semana × hora, por fluxo -----
  function lerCurva(colHora, colPct, colDia) {
    const porDiaHora = {};
    rows.forEach(r => {
      const dia = String(r[colDia] || '').trim().toUpperCase();
      if (!dia) return;
      const hora = numBat(r[colHora]);
      const pct = numBat(r[colPct]);
      if (hora === null) return;
      if (!porDiaHora[dia]) porDiaHora[dia] = Array(24).fill(null);
      porDiaHora[dia][hora] = pct === null ? null : pct / 100;
    });
    return porDiaHora;
  }
  const curvaHub = lerCurva(BAT_COL.lhHora, BAT_COL.lhPct, BAT_COL.lhDia);
  const curvaFm = lerCurva(BAT_COL.fmHora, BAT_COL.fmPct, BAT_COL.fmDia);
  if (curvaFm.DOMINGO && curvaFm.DOMINGO.some(v => v === null)) {
    avisos.push('Curva First Mile de domingo está sem % preenchido.');
  }

  // --- Quadro (AC–AO): escala hora a hora, efetivo = fixo − folgas ---
  const quadroPorData = {};
  rows.forEach(r => {
    const data = batDataIso(r[BAT_COL.qData]);
    if (!data) return;
    const hora = numBat(r[BAT_COL.qHora]);
    if (hora === null) return;
    const fixo = numBat(r[BAT_COL.qFixo]) || 0;
    const folgas = numBat(r[BAT_COL.qFolgas]) || 0;
    if (!quadroPorData[data]) quadroPorData[data] = Array(24).fill(null);
    quadroPorData[data][hora] = { fixo, folgas, efetivo: fixo - folgas };
  });
  const datasQuadro = Object.keys(quadroPorData).sort();
  if (datasQuadro.length && datasForecast.length) {
    avisos.push(`Quadro cobre ${datasQuadro.length} dia(s) (${datasQuadro[0]} a ${datasQuadro[datasQuadro.length - 1]}); forecast cobre ${datasForecast.length} dia(s) (${datasForecast[0]} a ${datasForecast[datasForecast.length - 1]}) — fora da janela do quadro não há escala pra comparar.`);
  }

  // --- Dia selecionado -------------------------------------------------
  const hojeIso = hojeOperacionalIso();
  const dataSel = (req.query.data && datasQuadro.includes(req.query.data)) ? req.query.data
    : (datasQuadro.includes(hojeIso) ? hojeIso : (datasQuadro[0] || null));

  let demanda = null, efetivoPorHora = null, diaSemana = null;
  if (dataSel) {
    diaSemana = diaSemanaPtDe(dataSel);
    const doDia = forecastRows.filter(f => f.data === dataSel);
    const totalHub = doDia.filter(f => f.apoio === 'HUB').reduce((s, f) => s + f.total, 0);
    const totalFm = doDia.filter(f => f.apoio === 'FM').reduce((s, f) => s + f.total, 0);
    const curvaHubDia = curvaHub[diaSemana] || Array(24).fill(null);
    const curvaFmDia = curvaFm[diaSemana] || Array(24).fill(null);
    const hub = curvaHubDia.map(pct => pct === null ? null : totalHub * pct);
    const fm = curvaFmDia.map(pct => pct === null ? null : totalFm * pct);

    const pctAsm = perfil.find(p => p.processo === 'DEMANDA ASM')?.porWs ?? 0.85;
    const pctEsteira = perfil.find(p => p.processo === 'DEMANDA ESTEIRA')?.porWs ?? 0.15;
    demanda = {
      hub, fm,
      asm: hub.map(v => v === null ? null : v * pctAsm),
      esteira: hub.map(v => v === null ? null : v * pctEsteira),
    };
    efetivoPorHora = quadroPorData[dataSel].map(h => h ? h.efetivo : null);
  } else {
    avisos.push('Nenhuma data com escala (quadro) disponível.');
  }

  // Roteamento por demanda só está confirmado pra ASM/ESTEIRA (PERFIL);
  // os demais macros entram sem demanda calculada — sinaliza em vez de
  // inventar uma % de roteamento não confirmada (ver §4 do modelo).
  const macrosComRoteamento = new Set(['ASM', 'ESTEIRA']);
  macros.forEach(m => {
    m.demandaPorHora = macrosComRoteamento.has(m.macro) && demanda
      ? (m.macro === 'ASM' ? demanda.asm : demanda.esteira)
      : null;
    if (!macrosComRoteamento.has(m.macro)) m.semRoteamento = true;
  });

  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=1500');
  res.status(200).json({
    ok: true,
    data: dataSel,
    diaSemana,
    coberturaForecast: datasForecast.length ? { inicio: datasForecast[0], fim: datasForecast[datasForecast.length - 1] } : null,
    coberturaQuadro: datasQuadro.length ? { inicio: datasQuadro[0], fim: datasQuadro[datasQuadro.length - 1] } : null,
    datasQuadroDisponiveis: datasQuadro,
    efetivoPorHora,
    demanda,
    macros,
    ativos,
    perfil,
    oee,
    avisos,
  });
}

module.exports = async (req, res) => {
  if (req.query.laborplan !== undefined) {
    await buildLaborplan(req, res);
    return;
  }
  if (req.query.kanban !== undefined) {
    await buildKanban(req, res);
    return;
  }
  if (req.query.datamap !== undefined) {
    await buildDataMap(req, res);
    return;
  }
  if (req.query.justificativas !== undefined) {
    await buildJustificativas(req, res);
    return;
  }
  // Árvore de KPI's (?arvore=1) — fonte própria (árvore_pulso), nada a ver
  // com o fan-out do Overview abaixo, então curto-circuita antes dele. Mora
  // aqui e não num endpoint próprio por causa do teto de 12 funções do plano
  // Hobby da Vercel (ver api/_arvore.js).
  // Preenchimento manual (?arvore=1&write=1, POST) — usado pelo botão
  // "Preencher dados" da Árvore de KPI's (arvore.html). Curto-circuita
  // antes do GET normal; ver writeArvoreValores em api/_arvore.js pra
  // regra de sobrescrever/manter/"-" por célula.
  // "Copiar e colar como valor" no lugar (?arvore=1&freeze=1, POST) —
  // congela o resultado atual do IMPORTRANGE em valor fixo, leitura +
  // escrita únicas cobrindo a aba inteira (não em chunks — ver o porquê
  // em freezeArvoreAll, api/_arvore.js). Uso único/administrativo, pedido
  // do Roberto em 2026-08-17.
  if (req.query.arvore !== undefined && req.query.freeze !== undefined) {
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, erro: 'Use POST' });
      return;
    }
    try {
      const resultado = await freezeArvoreAll();
      res.status(200).json({ ok: true, ...resultado });
    } catch (err) {
      res.status(502).json({ ok: false, erro: err.message });
    }
    return;
  }
  if (req.query.arvore !== undefined && req.query.write !== undefined) {
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, erro: 'Use POST' });
      return;
    }
    try {
      const entries = (req.body || {}).entries;
      if (!Array.isArray(entries) || !entries.length) {
        res.status(400).json({ ok: false, erro: 'entries obrigatório' });
        return;
      }
      // Postgres, não mais Sheets (pedido do Roberto em 2026-09-22) — a
      // árvore lida (?arvore=1 abaixo) já vem só de buildArvoreDoBanco, o
      // preenchimento manual precisa gravar no mesmo lugar que ela lê,
      // senão o botão "Preencher dados" parece funcionar mas o valor nunca
      // aparece na tela.
      const soc = socDaSessaoOuErro(req, res);
      if (!soc) return;
      const resultado = await writeArvoreValoresDoBanco(soc, entries);
      res.status(200).json({ ok: true, ...resultado });
    } catch (err) {
      res.status(502).json({ ok: false, erro: err.message });
    }
    return;
  }
  // "+ Adicionar KPI" (?arvore=1&addkpi=1, POST) — cadastra 1 KPI novo em
  // de_para_arvore_kpis pro SoC da sessão (ver adicionarArvoreKpi,
  // api/_arvore.js). Curto-circuita antes do GET normal, mesmo padrão de
  // write/freeze acima.
  if (req.query.arvore !== undefined && req.query.addkpi !== undefined) {
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, erro: 'Use POST' });
      return;
    }
    try {
      const soc = socDaSessaoOuErro(req, res);
      if (!soc) return;
      const resultado = await adicionarArvoreKpi(soc, req.body || {});
      res.status(resultado.ok ? 200 : 400).json(resultado);
    } catch (err) {
      res.status(502).json({ ok: false, erro: err.message });
    }
    return;
  }
  if (req.query.arvore !== undefined) {
    try {
      // Leitura ao vivo do Postgres, multi-SoC (pedido do Roberto em
      // 2026-09-22) — substitui buildArvore() (Sheets, só RJ2) pra todo
      // mundo. RJ6/SC1/SC2 legitimamente voltam com kpis: [] até alguém
      // cadastrar via "+ Adicionar KPI". buildArvore()/writeArvoreValores()/
      // freezeArvoreAll() continuam existindo (branches acima) mas nada os
      // chama mais a partir daqui — não removidos, fora do escopo.
      const soc = socDaSessaoOuErro(req, res);
      if (!soc) return;
      const dados = await buildArvoreDoBanco(soc);
      // ?_fresh=... (arvore.html manda isso logo após "Preencher dados" ou
      // "Salvar KPI" recarregar a página) pula o cache do CDN — sem isso o
      // reload caía dentro da janela de 5min e mostrava o valor antigo,
      // parecendo que a gravação não tinha funcionado (achado pelo Roberto
      // em 2026-08-17).
      if (req.query._fresh !== undefined) {
        res.setHeader('Cache-Control', 'no-store');
      } else {
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
      }
      res.status(200).json({ ok: true, ...dados });
    } catch (err) {
      res.status(502).json({ ok: false, erro: err.message });
    }
    return;
  }

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const base = `${proto}://${req.headers.host}`;
  const cookie = req.headers.cookie;
  const erros = {};
  const safe = async (nome, fn) => {
    try { return await fn(); } catch (err) { erros[nome] = err.message; return null; }
  };

  const [outbound, cluster, lh, fm, backlog, asm, conveyor, labor] = await Promise.all([
    safe('outbound', () => getJson(base, '/api/outbound', cookie)),
    safe('cluster', () => getJson(base, '/api/cluster', cookie)),
    safe('inboundLh', () => getJson(base, '/api/inbound-lh', cookie)),
    safe('inboundFm', () => getJson(base, '/api/inbound-fm', cookie)),
    safe('backlog', () => getJson(base, '/api/backlog', cookie)),
    safe('asm', () => getJson(base, '/api/asm', cookie)),
    safe('conveyor', () => getJson(base, '/api/conveyor', cookie)),
    safe('labor', () => getLabor()),
  ]);

  // 1. Backlog — média por hora (mesma lógica de bklQtdMedia em index.html:
  // soma ÷ horas do dia, nunca soma crua, senão infla contando a mesma
  // fila várias vezes), quebrado por grupo de perfil e por cluster de aging.
  let backlogResumo = null;
  if (backlog) {
    const horasBkl = backlog.opcoes.horas.length || 1;
    const media = rows => Math.round(rows.reduce((s, r) => s + r.qtdPacotes, 0) / horasBkl);
    backlogResumo = {
      total: media(backlog.rows),
      perfis: PERFIL_GRUPOS.map(pg => ({ label: pg.label, qtd: media(backlog.rows.filter(r => pg.match(r.perfil))) })),
      clusters: AGING_CLUSTERS.map(c => ({ label: c, qtd: media(backlog.rows.filter(r => AGING_CLUSTER_OF[r.faixaAging] === c)) })),
      serieHoraria: { realizado: porHora(backlog.rows, 'hora', r => r.qtdPacotes) },
    };
  }

  // 2. Inbound Line Haul — previstos vs descarregados (fim_descarga
  // preenchido) + em andamento + quebra por canal (origem).
  const lhRows = lh ? lh.rows : [];
  // Avg. Waiting Time LH (pedido do Roberto em 2026-08-19, KPI novo do
  // Overview) — média geral de tempoFilaMin (mesmo campo que já alimenta
  // tempoFilaMedioMin por canal logo abaixo, só sem quebrar por canal).
  const lhComFila = lhRows.filter(r => r.tempoFilaMin !== null);
  const lineHaul = lh ? {
    previstos: lhRows.length,
    descarregados: lhRows.filter(r => r.fimDescarga).length,
    andamento: lhRows.filter(r => r.checkinDestino && !r.fimDescarga).length,
    tempoFilaMedioMin: lhComFila.length ? Math.round(lhComFila.reduce((s, r) => s + r.tempoFilaMin, 0) / lhComFila.length) : null,
    porCanal: LH_CANAIS.map(canal => {
      const rows = lhRows.filter(r => canalDeOrigemLh(r.origem) === canal);
      const comFila = rows.filter(r => r.tempoFilaMin !== null);
      return {
        label: canal,
        carros: rows.length,
        pacotes: rows.reduce((s, r) => s + r.pacotes, 0),
        tempoFilaMedioMin: comFila.length ? Math.round(comFila.reduce((s, r) => s + r.tempoFilaMin, 0) / comFila.length) : null,
      };
    }).filter(c => c.carros > 0),
    serieHoraria: {
      previstos: porHora(lhRows, 'horaPlanejada', () => 1),
      realizado: porHora(lhRows.filter(r => r.fimDescarga), 'horaCheckin', () => 1),
    },
  } : null;

  // 3. Inbound First Mile — descarregados (finalização de jornada
  // preenchida) + em andamento + quebra por canal (agência).
  const fmRows = fm ? fm.rows : [];
  const fmAgencias = [...new Set(fmRows.map(r => r.agencia).filter(Boolean))].sort();
  // Avg. Waiting Time FM (pedido do Roberto em 2026-08-19) — mesma ideia do LH acima.
  const fmComFila = fmRows.filter(r => r.tempoFilaMin !== null);
  const firstMile = fm ? {
    descarregados: fmRows.filter(r => r.finalizacaoJornada).length,
    andamento: fmRows.filter(r => r.checkinDriver && !r.finalizacaoJornada).length,
    tempoFilaMedioMin: fmComFila.length ? Math.round(fmComFila.reduce((s, r) => s + r.tempoFilaMin, 0) / fmComFila.length) : null,
    porCanal: fmAgencias.map(canal => {
      const rows = fmRows.filter(r => r.agencia === canal);
      const comFila = rows.filter(r => r.tempoFilaMin !== null);
      return {
        label: canal,
        carros: rows.length,
        pacotes: rows.reduce((s, r) => s + r.pacotes, 0),
        tempoFilaMedioMin: comFila.length ? Math.round(comFila.reduce((s, r) => s + r.tempoFilaMin, 0) / comFila.length) : null,
      };
    }),
    serieHoraria: { realizado: porHora(fmRows, 'hora', () => 1) },
  } : null;

  // ASM e Conveyor — realizado no dia (soma bruta, são contadores de volume,
  // não uma leitura pontual) vs planejado ATÉ AGORA (soma do labor_pulso só
  // das horas que já passaram — comparar contra o planejado do dia inteiro
  // sempre pareceria "atrasado" de manhã, mesmo no ritmo certo). Horário de
  // Brasília fixo (UTC-3, mesma conta de hojeOperacionalIso em _period.js).
  //
  // "Já passou" tem que respeitar a ordem do dia operacional (corte às 6h,
  // vira a meia-noite) — não a ordem do relógio de 0-23h. Bug corrigido em
  // 2026-08-14: comparando `r.hora <= horaAgora` cru, de madrugada (ex.
  // horaAgora=0, ainda dentro do dia operacional que começou às 6h do dia
  // anterior) `laborAteAgora` só pegava a hora 0 (18h de planejado "perdidas"
  // do meio pro fim do dia), enquanto o realizado somava o dia inteiro —
  // pctAtingimento inflava pra milhares de %. Mesma ordenação de
  // asmHourOrder() em index.html (hora>=6 ? hora-6 : hora+18).
  const horaAgora = new Date(Date.now() - 3 * 60 * 60 * 1000).getUTCHours();
  const ordemHora = h => h >= 6 ? h - 6 : h + 18;
  const ordemAgora = ordemHora(horaAgora);
  const laborAteAgora = labor ? labor.rows.filter(r => ordemHora(r.hora) <= ordemAgora) : [];
  const laborAgora = labor && labor.rows.length
    ? (labor.rows.find(r => r.hora === horaAgora) || [...labor.rows].sort((a, b) => Math.abs(a.hora - horaAgora) - Math.abs(b.hora - horaAgora))[0])
    : null;

  // 4. ASM — realizado por zona real (exclui System Default), média de
  // zonas/mesas-por-nível ativas por hora (só conta quem teve indução>0
  // naquela hora), pico e média de indução por hora.
  const asmRowsReais = asm ? asm.rows.filter(r => !r.isSystemDefault) : [];
  const asmHoras = asm ? [...new Set(asm.rows.map(r => r.hora))].sort((a, b) => a - b) : [];
  const asmRealizado = asm ? asm.rows.reduce((s, r) => s + r.scanNumbers, 0) : null;
  const asmPlanejado = labor ? Math.round(laborAteAgora.reduce((s, r) => s + r.asmTarget, 0)) : null;
  let asmResumo = null;
  if (asm || labor) {
    const porHoraTotal = asmHoras.map(h => ({ hora: h, total: asm.rows.filter(r => r.hora === h).reduce((s, r) => s + r.scanNumbers, 0) }));
    const pico = porHoraTotal.length ? porHoraTotal.reduce((best, c) => c.total > best.total ? c : best) : null;
    asmResumo = {
      realizado: asmRealizado,
      planejado: asmPlanejado,
      pctAtingimento: asmPlanejado ? Math.round((asmRealizado ?? 0) / asmPlanejado * 100) : null,
      porZona: ASM_ZONAS_REAIS.map(zona => ({ label: zona, realizado: asmRowsReais.filter(r => r.zona === zona).reduce((s, r) => s + r.scanNumbers, 0) })),
      mediaZonasAtivas: asmHoras.length ? +(asmHoras.reduce((s, h) => s + new Set(asmRowsReais.filter(r => r.hora === h && r.scanNumbers > 0).map(r => r.zona)).size, 0) / asmHoras.length).toFixed(1) : null,
      mediaMesasPorNivel: ASM_NIVEIS.map(nivel => {
        const porHoraMesas = asmHoras.map(h => new Set(asmRowsReais.filter(r => r.hora === h && r.nivel === nivel && r.scanNumbers > 0).map(r => r.mesa)).size);
        return { label: nivel, mediaMesas: porHoraMesas.length ? +(porHoraMesas.reduce((s, v) => s + v, 0) / porHoraMesas.length).toFixed(1) : 0 };
      }),
      picoInducao: pico,
      mediaInducaoPorHora: asmHoras.length ? Math.round((asmRealizado ?? 0) / asmHoras.length) : null,
      capacidadeAgora: laborAgora ? { hora: laborAgora.hora, nv1: laborAgora.nv1, nv2: laborAgora.nv2, nv3: laborAgora.nv3, zonas: laborAgora.asmZonas } : null,
      serieHoraria: { planejado: labor ? porHora(labor.rows, 'hora', r => r.asmTarget) : null, realizado: asm ? porHora(asm.rows, 'hora', r => r.scanNumbers) : null },
    };
  }

  // 5. Conveyor — realizado por grupo de estação (OBC/OBD já vem somado da
  // própria classificação em api/conveyor.js), pico e média por hora.
  const cnvRows = conveyor ? conveyor.rows : [];
  const cnvHoras = conveyor ? [...new Set(cnvRows.map(r => r.hora))].sort((a, b) => a - b) : [];
  const conveyorRealizado = conveyor ? cnvRows.reduce((s, r) => s + r.totalProcessamento, 0) : null;
  const conveyorPlanejado = labor ? Math.round(laborAteAgora.reduce((s, r) => s + r.packingEsteira + r.packingVolumoso, 0)) : null;
  let conveyorResumo = null;
  if (conveyor || labor) {
    const porHoraTotal = cnvHoras.map(h => ({ hora: h, total: cnvRows.filter(r => r.hora === h).reduce((s, r) => s + r.totalProcessamento, 0) }));
    const pico = porHoraTotal.length ? porHoraTotal.reduce((best, c) => c.total > best.total ? c : best) : null;
    conveyorResumo = {
      realizado: conveyorRealizado,
      planejado: conveyorPlanejado,
      pctAtingimento: conveyorPlanejado ? Math.round((conveyorRealizado ?? 0) / conveyorPlanejado * 100) : null,
      porGrupo: CNV_GRUPOS.map(g => ({ label: g, realizado: cnvRows.filter(r => r.grupo === g).reduce((s, r) => s + r.totalProcessamento, 0) })).filter(g => g.realizado > 0),
      picoProcessamento: pico,
      mediaProcessamentoPorHora: cnvHoras.length ? Math.round((conveyorRealizado ?? 0) / cnvHoras.length) : null,
      // Esteira A/B/Termo (colunas TARGET ESTEIRA A/B/TERMO de labor_pulso —
      // pedido do Roberto em 2026-08-25: a linha de "Capacidade planejada"
      // do Conveyor não trazia nada porque lia `esteiras`, um campo que não
      // existe na planilha (a coluna real é ESTEIRA A/ESTEIRA B separadas,
      // e essas são REALIZADO, não target). Mesmo padrão do capacidadeAgora
      // do ASM acima (nv1/nv2/nv3), agora com os 3 targets reais.
      capacidadeAgora: laborAgora ? { hora: laborAgora.hora, esteiraA: laborAgora.targetEsteiraA, esteiraB: laborAgora.targetEsteiraB, termo: laborAgora.targetTermo } : null,
      serieHoraria: { planejado: labor ? porHora(labor.rows, 'hora', r => r.packingEsteira + r.packingVolumoso) : null, realizado: conveyor ? porHora(cnvRows, 'hora', r => r.totalProcessamento) : null },
    };
  }

  // 6. Outbound — carros carregados vs planejados, saca/scuttle separados
  // (com TOs de cada), quebra por canal (destino), % de Clusterização e
  // pacotes no piso (piso = staging outbound, onde os TOs endereçados
  // aguardam expedição — por isso entram aqui em vez de um bloco à parte,
  // como primeiro card do bloco).
  const outboundCarros = outbound ? outbound.carros : [];
  const outboundResumo = (outbound || cluster) ? {
    pctClusterizacao: cluster ? cluster.atual.pctClusterizacao : null,
    pacotesNoPiso: cluster ? cluster.atual.pacotesTotal : null,
    // CPT On Time (pedido do Roberto em 2026-08-19, KPI novo do Overview) —
    // reaproveita o cálculo já pronto em api/_outbound.js aggregate()
    // (cpt_realizado <= cpt_scheduled_origin_edited, sem margem), não
    // reinventa a regra.
    pctCptOnTime: outbound ? outbound.atual.pctCptOnTime : null,
    carrosPrevistos: outbound ? outbound.atual.carrosPrevistos : null,
    carrosRealizados: outbound ? outbound.atual.carrosRealizados : null,
    saca: outbound ? { pacotes: outbound.atual.pacotesSaca, tos: outbound.atual.qtySaca } : null,
    scuttle: outbound ? { pacotes: outbound.atual.pacotesScuttle, tos: outbound.atual.qtyScuttle } : null,
    porCanal: OUTBOUND_CANAIS.map(canal => {
      const rows = outboundCarros.filter(r => canalDeDestinoOutbound(r.destino) === canal);
      return {
        label: canal,
        pacotes: rows.reduce((s, r) => s + r.orders_saca + r.orders_scuttle, 0),
        tos: rows.reduce((s, r) => s + r.to_saca + r.to_scuttle, 0),
      };
    }).filter(c => c.pacotes > 0 || c.tos > 0),
    serieHoraria: outbound ? {
      previstos: porHora(outboundCarros, r => horaDeTs(r.cpt_planejado), () => 1),
      realizado: porHora(outboundCarros.filter(r => r.cpt_realizado), r => horaDeTs(r.cpt_realizado), () => 1),
    } : null,
  } : null;

  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
  res.status(200).json({
    ok: true,
    atualizadoEm: new Date().toISOString(),
    backlog: backlogResumo,
    lineHaul, firstMile,
    asm: asmResumo, conveyor: conveyorResumo,
    outbound: outboundResumo,
    erros: Object.keys(erros).length ? erros : null,
  });
};
