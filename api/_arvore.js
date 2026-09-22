/**
 * PULSO — Árvore de KPI's (aba árvore_pulso, gid 25033403).
 *
 * Substitui a antiga "Árvore (daily)", que era um espelho ESTÁTICO colado
 * dentro do index.html. Agora os dados vêm ao vivo da planilha (pedido do
 * Roberto em 2026-08-13, junto com o mockup React "arvore-kpis").
 *
 * A aba é longa (1 linha por Data × KPI, ~70 mil linhas) com as colunas:
 *   Data | Bloco | PIC | Sub Bloco | KPI | Target | Semana | Valor | Observação | Link
 * "Data" guarda tanto data ISO (2026-01-07) quanto rótulo de semana (W2) —
 * as duas coisas viram colunas na tabela final, por isso ficam no mesmo
 * dicionário `valores` (chave = a própria Data).
 *
 * Helper (prefixo _) de propósito: o plano Hobby da Vercel limita em 12
 * funções serverless e o projeto já está no teto, então isso entra como
 * módulo de api/overview.js (modo ?arvore=1), não como endpoint próprio —
 * mesmo padrão de ?esteira=1 (cluster) e ?monitor=1 (outbound).
 */
const { fetchTabByGid, fetchTabRawValues, batchUpdateValues, updateRangeRaw } = require('./_google');

const ARVORE_SHEET = { spreadsheetId: '1BqZElDRwVaGpDYZzHTq9UQvVLy2guRVfTdvwGHL1qC4', gid: '25033403' };

// Unidade e direção (maior-melhor / menor-melhor) NÃO existem na planilha —
// a coluna Target é só um número. Essa tabela reproduz a classificação do
// convert_data.py do mockup que o Roberto aprovou, pra página nova mostrar
// os mesmos status/cores que ele viu. Chave = Bloco|PIC|Sub Bloco|KPI.
// Valor = 2 letras: [n]umber/[p]ercent + higher/[l]ower/near_[z]ero better.
// KPI que aparecer na planilha e não estiver aqui cai no heurístico abaixo.
const ARVORE_META = {
  "Pessoas|Ingryd (HSE)|ACA|Total":"nh",
  "Pessoas|Ingryd (HSE)|ACA|Inbound":"nh",
  "Pessoas|Ingryd (HSE)|ACA|ASM":"nh",
  "Pessoas|Ingryd (HSE)|ACA|Outbound":"nh",
  "Pessoas|Ingryd (HSE)|ACA|Esteira":"nh",
  "Pessoas|Ingryd (HSE)|ACA|Outros (RTS, Almox, Meio Ambiente, Automação e etc)":"nh",
  "Pessoas|Ingryd (HSE)|PS|Total":"nh",
  "Pessoas|Ingryd (HSE)|PS|Inbound":"nh",
  "Pessoas|Ingryd (HSE)|PS|ASM":"nh",
  "Pessoas|Ingryd (HSE)|PS|Outbound":"nh",
  "Pessoas|Ingryd (HSE)|PS|Esteira":"nh",
  "Pessoas|Ingryd (HSE)|PS|Outros (RTS, Almox, Meio Ambiente, Automação e etc)":"nh",
  "Pessoas|Ingryd (HSE)|HSE|SPI":"ph",
  "Pessoas|COP|ABS|Total":"pl",
  "Pessoas|COP|ABS|T1":"pl",
  "Pessoas|COP|ABS|T2":"pl",
  "Pessoas|COP|ABS|T3":"pl",
  "Pessoas|COP|ABS|T4":"pl",
  "Pessoas|Enfermagem|Atendimentos Ambulatorios|Total":"nh",
  "Pessoas|Enfermagem|Atendimentos Ambulatorios|T1":"nh",
  "Pessoas|Enfermagem|Atendimentos Ambulatorios|T2":"nh",
  "Pessoas|Enfermagem|Atendimentos Ambulatorios|T3":"nh",
  "Inventário|COP|Stuck Received (Inbound)|% Orders Packed within 6h":"pl",
  "Inventário|Diogo (INV)|Stuck Received (Inbound)|%> 24 horas":"pl",
  "Inventário|Diogo (INV)|Stuck Received (Inbound)|>24 horas":"nl",
  "Inventário|Diogo (INV)|Stuck Received (Inbound)|>48 horas":"nl",
  "Inventário|Diogo (INV)|Stuck Received (Inbound)|>72 horas":"nl",
  "Inventário|Diogo (INV)|Stuck Received (Inbound)|>10 dias":"nl",
  "Inventário|Diogo (INV)|Stuck Packed/Packing (Outbound)|>24 horas":"nl",
  "Inventário|Diogo (INV)|Stuck Packed/Packing (Outbound)|>48 horas":"nl",
  "Inventário|Diogo (INV)|Stuck Packed/Packing (Outbound)|>72 horas":"nl",
  "Inventário|Diogo (INV)|Stuck Packed/Packing (Outbound)|>10 dias":"nl",
  "Inventário|Diogo (INV)|COP|Salvados - Quant.TOs Geradas":"nh",
  "Inventário|Diogo (INV)|Inventário|Losses":"nl",
  "Inventário|Diogo (INV)|Inventário|Damage":"nl",
  "Inventário|Diogo (INV)|Inventário|Pacotes Coletados":"nh",
  "Inventário|Diogo (INV)|Inventário|Pacotes Coletados cancelados":"nh",
  "Inventário|Diogo (INV)|Inventário|Pacotes Coletados com Losses":"nl",
  "Planejamento|Rodrigo (PCP)|Forecast|Inbound Forecast S&OP":"nh",
  "Planejamento|Rodrigo (PCP)|Forecast|Received Inbound Total":"nh",
  // "pc" = faixa de tolerância ±target em torno de 100% (não em torno de
  // zero) — valor da planilha já vem como razão (ex.: 1,0677 = 106,77%),
  // não como desvio. Pedido do Roberto em 2026-08-28: target 5% deve
  // significar "entre 95% e 105%", não "abaixo de 5%" (ver polarity
  // "band100" em arvore.html isWithinTarget).
  "Planejamento|Rodrigo (PCP)||(%) Desvio de Forecast":"pc",
  "Planejamento|Rodrigo (PCP)|Planejamento|Packed Planejado D-1":"nh",
  "Planejamento|Rodrigo (PCP)|Planejamento|Packed Real D-1":"nh",
  "Planejamento|Rodrigo (PCP)|Planejamento|(%) Aderência ao Plano All":"ph",
  "Planejamento|Rodrigo (PCP)|Planejamento|(%) Aderência ao Plano T1":"ph",
  "Planejamento|Rodrigo (PCP)|Planejamento|(%) Aderência ao Plano T2":"ph",
  "Planejamento|Rodrigo (PCP)|Planejamento|(%) Aderência ao Plano T3":"ph",
  "Planejamento|Rodrigo (PCP)|Planejamento|Handover":"nh",
  "Planejamento|Rodrigo (PCP)|Planejamento|Backlog Piso D0 (Retrato das 6)":"nl",
  "Planejamento|Rodrigo (PCP)|Planejamento|Backlog Piso + Patio D0 (Retrato das 6)":"nl",
  "Planejamento|Rodrigo (PCP)|Planejamento|Produtividade Planejada":"nh",
  "Planejamento|Rodrigo (PCP)|Planejamento|Produtividade Real":"nh",
  "Planejamento|Rodrigo (PCP)||Produtividade Real T1":"nh",
  "Planejamento|Rodrigo (PCP)||Produtividade Real T2":"nh",
  "Planejamento|Rodrigo (PCP)||Produtividade Real T3":"nh",
  "Planejamento|Rodrigo (PCP)|Aderência|Aderência DW":"ph",
  "Planejamento|Rodrigo (PCP)|Aderência|Sizing Total":"ph",
  "Planejamento|Rodrigo (PCP)|Aderência|T1":"ph",
  "Planejamento|Rodrigo (PCP)|Aderência|T2":"ph",
  "Planejamento|Rodrigo (PCP)|Aderência|T3":"ph",
  "Inbound|COP|LH|Forecast Received":"nh",
  "Inbound|COP|LH|Received":"nh",
  // "pz" (near_zero), não "ph" (pedido do Roberto em 2026-08-28): valor já
  // vem como desvio (ex.: -0,053 = -5,3%), não como razão — target 5% já
  // significa "|desvio| <= 5%", que é exatamente a fórmula de near_zero.
  "Inbound|COP|LH|(%) Forecast x Received":"pz",
  "Inbound|COP|LH|LH Qtd de carros planejados":"nh",
  "Inbound|COP|LH|LH | Qtd de carros descarregados":"nh",
  "Inbound|COP|LH|Qtd de carros em Fila D0 (retrato das 06:00)":"nl",
  "Inbound|COP|LH|Qtd de carros atrasados em fila D0 (retrato das 06:00)":"nl",
  "Inbound|COP|LH|Qtd de carros atrasados em fila + 6h D0 (retrato das 06:00)":"nl",
  "Inbound|COP|LH|Qtd de carros descarregados atrasados":"nl",
  "Inbound|COP|LH|Qtd de carros descarregados atrasados + 6h":"nl",
  "Inbound|COP|LH|% de carros descarregados atrasados":"pl",
  "Inbound|COP|LH|Tempo de Fila LH":"nl",
  "Inbound|COP|LH|% Aderência Stage In":"ph",
  "Inbound|COP|LH|% Wrong Crossdocking":"pl",
  "Inbound|COP|LH|% Share de Sacas":"ph",
  "Inbound|COP|FM|Forecast Received":"nh",
  "Inbound|COP|FM|Received":"nh",
  "Inbound|COP|FM|(%) Forecast x Received":"pz", // ver comentário no LH acima
  "Inbound|COP|FM|Tempo de Fila FM":"nl",
  "Inbound|COP|QB|Packed QB":"nh",
  "Inbound|COP|QB|Share QB":"ph",
  "Inbound|COP|Triagem|Postos hora Planejados":"nh",
  "Inbound|COP|Triagem|Postos hora Realizados":"nh",
  "Inbound|COP|Triagem|% Aderência Postos":"ph",
  "Inbound|COP|Triagem|Pacotes Planejados":"nh",
  "Inbound|COP|Triagem|Pacotes Realizados":"nh",
  "Inbound|COP|Triagem|% Aderência Pacotes":"ph",
  "Inbound|COP|ABS|% ABS":"pl",
  "Inbound|COP|ABS|% Aderência preenchimento ABS":"pl",
  "Inbound|COP|ABS|Aderência Medidas Disciplinares":"pl",
  "Inbound|COP|ABS|Aderência Entrevista de ABS":"pl",
  "Máquina|COP|Rejeito|Matriz (Total)":"pl",
  "Máquina|COP|Rejeito|IBA":"pl",
  "Máquina|COP|Rejeito|IBB":"pl",
  "Máquina|COP|Rejeito|IBC":"pl",
  "Máquina|COP|Rejeito|IBD":"pl",
  "Máquina|COP|Rejeito|IBE":"pl",
  "Máquina|COP|Rejeito|IBF":"pl",
  "Máquina|COP|Rejeito|OB (Total)":"pl",
  "Máquina|COP|Rejeito|OBA":"pl",
  "Máquina|COP|Rejeito|OBB":"pl",
  "Máquina|COP|Rejeito|OBC":"pl",
  "Máquina|COP|Rejeito|OBD":"pl",
  "Máquina|COP|Rejeito|CBS (Total)":"pl",
  "Máquina|COP|Rejeito|CBS N3":"pl",
  "Máquina|COP|Rejeito|CBS N2":"pl",
  "Máquina|COP|Rejeito|NC":"pl",
  "Máquina|PCM|Automação|Qtd de OM Corretivas":"nl",
  "Máquina|PCM|Automação|Qtd de horas gastas em Corretivas":"nl",
  "Sorter|COP|Sorter|Packed Planejado":"nh",
  "Sorter|COP|Sorter|Packed Real":"nh",
  "Sorter|COP|Sorter|(%) Planejado x Real":"ph",
  "Sorter|COP|Sorter|Produção Pico Total":"nh",
  "Sorter|COP|Sorter|Produção Pico Zona":"nh",
  "Sorter|COP|Sorter|Produção Média":"nh",
  "Sorter|COP|Sorter|Tempo de Chute Fechado":"pl",
  "Sorter|COP|Sorter|\"Parcel Loop\"":"nl",
  "Sorter|COP|Sorter|\"Over Loop\"":"nl",
  "Sorter|COP|Sorter|% Share NC Processado":"pl",
  "Sorter|COP|Sorter|Backlog NC (Retrato das 6 horas)":"pl",
  "Sorter|COP|ABS|ABS":"pl",
  "Sorter|COP|ABS|% Aderência preenchimento ABS":"pl",
  "Sorter|COP|ABS|Aderência Medidas Disciplinares":"pl",
  "Sorter|COP|ABS|Aderência Entrevista de ABS":"pl",
  "Esteira|COP|Esteira|Packed Planejado":"nh",
  "Esteira|COP|Esteira|Packed Real":"nh",
  "Esteira|COP|Esteira|(%) Planejado x Real":"ph",
  "Esteira|COP|Esteira|% Share Packed Esteira":"ph",
  "Esteira|COP|Esteira|Backlog Tinta >24horas":"nl",
  "Esteira|COP|ABS|ABS":"pl",
  "Esteira|COP|ABS|% Aderência preenchimento ABS":"pl",
  "Esteira|COP|ABS|Aderência Medidas Disciplinares":"pl",
  "Esteira|COP|ABS|Aderência Entrevista de ABS":"pl",
  "Outbound|COP|Outbound|% Leftover Total":"pl",
  "Outbound|COP|Outbound|Leftover Total":"nl",
  "Outbound|COP|Outbound|% Leftover Ops":"pl",
  "Outbound|COP|Outbound|% Leftover Field":"pl",
  "Outbound|COP|Outbound|% Orders Outbounded within 24h":"ph",
  "Outbound|COP|Outbound|% FIFO Broken":"pl",
  "Outbound|COP|Outbound|Aderência Atrelamento de Sacas (LMH)":"ph",
  "Outbound|COP|Outbound|Aderência Atrelamento de Sacas (XPT)":"ph",
  "Outbound|COP|Outbound|Aderência ETA":"ph",
  "Outbound|COP|Outbound|Aderência CPT":"ph",
  "Outbound|COP|Outbound|% Clusterização Stage Out (Retrato das 6 horas)":"ph",
  "Outbound|COP|ABS|ABS":"pl",
  "Outbound|COP|ABS|% Aderência preenchimento ABS":"pl",
  "Outbound|COP|ABS|Aderência Medidas Disciplinares":"pl",
  "Outbound|COP|ABS|Aderência Entrevista de ABS":"pl",
  "Auditoria|COP|Mis|% Mis-scanning (SoC>LMH)":"pl",
  "Auditoria|COP|Mis|% Mis-routing":"pl",
  "Auditoria|COP|Auditoria de TO|Auditoria de TO (Qty)":"nh",
  "Auditoria|COP|Auditoria de TO|Meta":"nh",
  "Auditoria|COP|Auditoria de TO|% Auditado no ASM":"ph",
  "Auditoria|COP|Auditoria de TO|% wrong ASM":"pl",
  "Auditoria|COP|Auditoria de TO|% Auditado na Esteira":"ph",
  "Auditoria|COP|Auditoria de TO|% wrong Esteira":"pl",
  "Auditoria|COP|Auditoria de TO|% Auditado QB":"ph",
  "Auditoria|COP|Auditoria de TO|% wrong QB":"pl",
  "Auditoria|COP|Auditoria IN|Auditoria de FM":"nh",
  "Auditoria|COP|Auditoria IN|Auditoria de LH":"nh",
  "Auditoria|COP|Auditoria IN|Auditoria de NC":"pl",
  "Auditoria|COP|Auditoria IN|Auditoria de Outbound":"nh",
  "RETURNS|COP|EHA | RETURNS|Orfãos":"nl",
  "RETURNS|COP|EHA | RETURNS|Salvados - STN":"nh",
  "RETURNS|COP|EHA | RETURNS|Salvados - CTN":"nh",
  "RETURNS|COP|EHA | RETURNS|Descarte sem identificação":"nl",
  "RETURNS|COP|EHA | RETURNS|Descarte com identificação":"nl",
  "RETURNS|COP|EHA | RETURNS|Backlog de Salvados - Scuttles":"nl",
  "RETURNS|COP|EHA | RETURNS|Recevied EHA inbound":"nh",
  "RETURNS|COP|EHA | RETURNS|Registro de Avarias":"nl",
  "RETURNS|COP|EHA | RETURNS|% EHA X Recevied":"ph"
};

// "Memória de Cálculo" (pedido do Roberto em 2026-08-24) — como consolidar
// os dias de uma semana/mês, por KPI. Não existe planilha de referência
// pronta com essa coluna — classificação feita por julgamento (mesmo
// espírito do ARVORE_META acima): contagem/volume que se acumula ao longo
// da semana (pacotes, carros, ocorrências) -> soma; taxa/percentual e
// "retrato"/snapshot de um momento (backlog, fila às 6h) -> média (somar
// não faz sentido pra uma foto do momento); pico -> máximo; produtividade
// -> média sem domingo (turno reduzido de fim de semana distorceria a
// média). Tipos válidos: 'soma' | 'media' | 'maximo' | 'media_sem_domingo'.
// KPI que não aparecer aqui não tem consolidado calculado (semana mostra o
// valor cru do backend, mês mantém a média simples de sempre) — nunca
// quebra, nunca inventa número.
const ARVORE_AGREGACAO = {
  // Pessoas — acidentes/afastamentos: contagem que se acumula na semana.
  "Pessoas|Ingryd (HSE)|ACA|Total": "soma",
  "Pessoas|Ingryd (HSE)|ACA|Inbound": "soma",
  "Pessoas|Ingryd (HSE)|ACA|ASM": "soma",
  "Pessoas|Ingryd (HSE)|ACA|Outbound": "soma",
  "Pessoas|Ingryd (HSE)|ACA|Esteira": "soma",
  "Pessoas|Ingryd (HSE)|ACA|Outros (RTS, Almox, Meio Ambiente, Automação e etc)": "soma",
  "Pessoas|Ingryd (HSE)|PS|Total": "soma",
  "Pessoas|Ingryd (HSE)|PS|Inbound": "soma",
  "Pessoas|Ingryd (HSE)|PS|ASM": "soma",
  "Pessoas|Ingryd (HSE)|PS|Outbound": "soma",
  "Pessoas|Ingryd (HSE)|PS|Esteira": "soma",
  "Pessoas|Ingryd (HSE)|PS|Outros (RTS, Almox, Meio Ambiente, Automação e etc)": "soma",
  "Pessoas|Ingryd (HSE)|HSE|SPI": "media",
  "Pessoas|COP|ABS|Total": "media",
  "Pessoas|COP|ABS|T1": "media",
  "Pessoas|COP|ABS|T2": "media",
  "Pessoas|COP|ABS|T3": "media",
  "Pessoas|COP|ABS|T4": "media",

  // Inventário — Stuck é quantidade parada AGORA (snapshot), não flow.
  "Inventário|COP|Stuck Received (Inbound)|% Orders Packed within 6h": "media",
  "Inventário|Diogo (INV)|Stuck Received (Inbound)|%> 24 horas": "media",
  "Inventário|Diogo (INV)|Stuck Received (Inbound)|>24 horas": "media",
  "Inventário|Diogo (INV)|Stuck Received (Inbound)|>48 horas": "media",
  "Inventário|Diogo (INV)|Stuck Received (Inbound)|>72 horas": "media",
  "Inventário|Diogo (INV)|Stuck Received (Inbound)|>10 dias": "media",
  "Inventário|Diogo (INV)|Stuck Packed/Packing (Outbound)|>24 horas": "media",
  "Inventário|Diogo (INV)|Stuck Packed/Packing (Outbound)|>48 horas": "media",
  "Inventário|Diogo (INV)|Stuck Packed/Packing (Outbound)|>72 horas": "media",
  "Inventário|Diogo (INV)|Stuck Packed/Packing (Outbound)|>10 dias": "media",
  "Inventário|Diogo (INV)|Inventário|Losses": "soma",
  "Inventário|Diogo (INV)|Inventário|Damage": "soma",
  "Inventário|Diogo (INV)|Inventário|Pacotes Coletados": "soma",
  "Inventário|Diogo (INV)|Inventário|Pacotes Coletados cancelados": "soma",
  "Inventário|Diogo (INV)|Inventário|Pacotes Coletados com Losses": "soma",

  // Planejamento
  "Planejamento|Rodrigo (PCP)|Forecast|Inbound Forecast S&OP": "soma",
  "Planejamento|Rodrigo (PCP)|Forecast|Received Inbound Total": "soma",
  "Planejamento|Rodrigo (PCP)||(%) Desvio de Forecast": "media",
  "Planejamento|Rodrigo (PCP)|Planejamento|Packed Planejado D-1": "soma",
  "Planejamento|Rodrigo (PCP)|Planejamento|Packed Real D-1": "soma",
  "Planejamento|Rodrigo (PCP)|Planejamento|(%) Aderência ao Plano All": "media",
  "Planejamento|Rodrigo (PCP)|Planejamento|(%) Aderência ao Plano T1": "media",
  "Planejamento|Rodrigo (PCP)|Planejamento|(%) Aderência ao Plano T2": "media",
  "Planejamento|Rodrigo (PCP)|Planejamento|(%) Aderência ao Plano T3": "media",
  "Planejamento|Rodrigo (PCP)|Planejamento|Handover": "soma",
  "Planejamento|Rodrigo (PCP)|Planejamento|Backlog Piso D0 (Retrato das 6)": "media",
  "Planejamento|Rodrigo (PCP)|Planejamento|Backlog Piso + Patio D0 (Retrato das 6)": "media",
  // Produtividade: domingo roda com turno reduzido e distorce a média.
  "Planejamento|Rodrigo (PCP)|Planejamento|Produtividade Planejada": "media_sem_domingo",
  "Planejamento|Rodrigo (PCP)|Planejamento|Produtividade Real": "media_sem_domingo",
  "Planejamento|Rodrigo (PCP)||Produtividade Real T1": "media_sem_domingo",
  "Planejamento|Rodrigo (PCP)||Produtividade Real T2": "media_sem_domingo",
  "Planejamento|Rodrigo (PCP)||Produtividade Real T3": "media_sem_domingo",
  "Planejamento|Rodrigo (PCP)|Aderência|Aderência DW": "media",
  "Planejamento|Rodrigo (PCP)|Aderência|Sizing Total": "media",
  "Planejamento|Rodrigo (PCP)|Aderência|T1": "media",
  "Planejamento|Rodrigo (PCP)|Aderência|T2": "media",
  "Planejamento|Rodrigo (PCP)|Aderência|T3": "media",

  // Inbound — LH
  "Inbound|COP|LH|Forecast Received": "soma",
  "Inbound|COP|LH|Received": "soma",
  "Inbound|COP|LH|LH Qtd de carros planejados": "soma",
  "Inbound|COP|LH|LH | Qtd de carros descarregados": "soma",
  "Inbound|COP|LH|Qtd de carros em Fila D0 (retrato das 06:00)": "media",
  "Inbound|COP|LH|Qtd de carros atrasados em fila D0 (retrato das 06:00)": "media",
  "Inbound|COP|LH|Qtd de carros atrasados em fila + 6h D0 (retrato das 06:00)": "media",
  "Inbound|COP|LH|Qtd de carros descarregados atrasados": "soma",
  "Inbound|COP|LH|Qtd de carros descarregados atrasados + 6h": "soma",
  "Inbound|COP|LH|% de carros descarregados atrasados": "media",
  "Inbound|COP|LH|Tempo de Fila LH": "media",
  "Inbound|COP|LH|% Aderência Stage In": "media",
  "Inbound|COP|LH|% Wrong Crossdocking": "media",
  "Inbound|COP|LH|% Share de Sacas": "media",
  // Inbound — FM
  "Inbound|COP|FM|Forecast Received": "soma",
  "Inbound|COP|FM|Received": "soma",
  "Inbound|COP|FM|Tempo de Fila FM": "media",
  // Inbound — QB / Triagem / ABS
  "Inbound|COP|QB|Packed QB": "soma",
  "Inbound|COP|QB|Share QB": "media",
  "Inbound|COP|Triagem|Postos hora Planejados": "soma",
  "Inbound|COP|Triagem|Postos hora Realizados": "soma",
  "Inbound|COP|Triagem|% Aderência Postos": "media",
  "Inbound|COP|Triagem|Pacotes Planejados": "soma",
  "Inbound|COP|Triagem|Pacotes Realizados": "soma",
  "Inbound|COP|Triagem|% Aderência Pacotes": "media",
  "Inbound|COP|ABS|% ABS": "media",
  "Inbound|COP|ABS|% Aderência preenchimento ABS": "media",
  "Inbound|COP|ABS|Aderência Medidas Disciplinares": "media",
  "Inbound|COP|ABS|Aderência Entrevista de ABS": "media",

  // Máquina — Rejeito (tudo taxa %) e Automação (contagem/horas gastas)
  "Máquina|COP|Rejeito|Matriz (Total)": "media",
  "Máquina|COP|Rejeito|IBA": "media",
  "Máquina|COP|Rejeito|IBB": "media",
  "Máquina|COP|Rejeito|IBC": "media",
  "Máquina|COP|Rejeito|IBD": "media",
  "Máquina|COP|Rejeito|IBE": "media",
  "Máquina|COP|Rejeito|IBF": "media",
  "Máquina|COP|Rejeito|OB (Total)": "media",
  "Máquina|COP|Rejeito|OBA": "media",
  "Máquina|COP|Rejeito|OBB": "media",
  "Máquina|COP|Rejeito|OBC": "media",
  "Máquina|COP|Rejeito|OBD": "media",
  "Máquina|COP|Rejeito|CBS (Total)": "media",
  "Máquina|COP|Rejeito|CBS N3": "media",
  "Máquina|COP|Rejeito|CBS N2": "media",
  "Máquina|COP|Rejeito|NC": "media",
  "Máquina|PCM|Automação|Qtd de OM Corretivas": "soma",
  "Máquina|PCM|Automação|Qtd de horas gastas em Corretivas": "soma",

  // Sorter
  "Sorter|COP|Sorter|Packed Planejado": "soma",
  "Sorter|COP|Sorter|Packed Real": "soma",
  "Sorter|COP|Sorter|Produção Pico Total": "maximo",
  "Sorter|COP|Sorter|Produção Pico Zona": "maximo",
  "Sorter|COP|Sorter|Produção Média": "media",
  "Sorter|COP|Sorter|Tempo de Chute Fechado": "media",
  "Sorter|COP|Sorter|\"Parcel Loop\"": "soma",
  "Sorter|COP|Sorter|\"Over Loop\"": "soma",
  "Sorter|COP|Sorter|% Share NC Processado": "media",
  "Sorter|COP|Sorter|Backlog NC (Retrato das 6 horas)": "media",
  "Sorter|COP|ABS|ABS": "media",
  "Sorter|COP|ABS|% Aderência preenchimento ABS": "media",
  "Sorter|COP|ABS|Aderência Medidas Disciplinares": "media",
  "Sorter|COP|ABS|Aderência Entrevista de ABS": "media",

  // Esteira
  "Esteira|COP|Esteira|Packed Planejado": "soma",
  "Esteira|COP|Esteira|Packed Real": "soma",
  "Esteira|COP|Esteira|% Share Packed Esteira": "media",
  "Esteira|COP|Esteira|Backlog Tinta >24horas": "media",
  "Esteira|COP|ABS|ABS": "media",
  "Esteira|COP|ABS|% Aderência preenchimento ABS": "media",
  "Esteira|COP|ABS|Aderência Medidas Disciplinares": "media",
  "Esteira|COP|ABS|Aderência Entrevista de ABS": "media",

  // Outbound
  "Outbound|COP|Outbound|% Leftover Total": "media",
  "Outbound|COP|Outbound|Leftover Total": "media",
  "Outbound|COP|Outbound|% Leftover Ops": "media",
  "Outbound|COP|Outbound|% Leftover Field": "media",
  "Outbound|COP|Outbound|% Orders Outbounded within 24h": "media",
  "Outbound|COP|Outbound|% FIFO Broken": "media",
  "Outbound|COP|Outbound|Aderência Atrelamento de Sacas (LMH)": "media",
  "Outbound|COP|Outbound|Aderência Atrelamento de Sacas (XPT)": "media",
  "Outbound|COP|Outbound|Aderência ETA": "media",
  "Outbound|COP|Outbound|Aderência CPT": "media",
  "Outbound|COP|Outbound|% Clusterização Stage Out (Retrato das 6 horas)": "media",
  "Outbound|COP|ABS|ABS": "media",
  "Outbound|COP|ABS|% Aderência preenchimento ABS": "media",
  "Outbound|COP|ABS|Aderência Medidas Disciplinares": "media",
  "Outbound|COP|ABS|Aderência Entrevista de ABS": "media",

  // Auditoria
  "Auditoria|COP|Mis|% Mis-scanning (SoC>LMH)": "media",
  "Auditoria|COP|Mis|% Mis-routing": "media",
  "Auditoria|COP|Auditoria de TO|Auditoria de TO (Qty)": "soma",
  "Auditoria|COP|Auditoria de TO|% Auditado no ASM": "media",
  "Auditoria|COP|Auditoria de TO|% wrong ASM": "media",
  "Auditoria|COP|Auditoria de TO|% Auditado na Esteira": "media",
  "Auditoria|COP|Auditoria de TO|% wrong Esteira": "media",
  "Auditoria|COP|Auditoria de TO|% Auditado QB": "media",
  "Auditoria|COP|Auditoria de TO|% wrong QB": "media",
  "Auditoria|COP|Auditoria IN|Auditoria de FM": "soma",
  "Auditoria|COP|Auditoria IN|Auditoria de LH": "soma",
  "Auditoria|COP|Auditoria IN|Auditoria de NC": "media",
  "Auditoria|COP|Auditoria IN|Auditoria de Outbound": "soma",

  // RETURNS
  "RETURNS|COP|EHA | RETURNS|Orfãos": "media",
  "RETURNS|COP|EHA | RETURNS|Salvados - STN": "soma",
  "RETURNS|COP|EHA | RETURNS|Salvados - CTN": "soma",
  "RETURNS|COP|EHA | RETURNS|Descarte sem identificação": "soma",
  "RETURNS|COP|EHA | RETURNS|Descarte com identificação": "soma",
  "RETURNS|COP|EHA | RETURNS|Backlog de Salvados - Scuttles": "media",
  "RETURNS|COP|EHA | RETURNS|Recevied EHA inbound": "soma",
  "RETURNS|COP|EHA | RETURNS|Registro de Avarias": "soma",
  "RETURNS|COP|EHA | RETURNS|% EHA X Recevied": "media",
};

// Memória de Cálculo em fórmula (não é soma/média/máximo simples — usa o
// valor de 2 KPIs IRMÃOS do mesmo Sub Bloco). Mesmo shape de
// KPI_CALCULADOS mais abaixo, mas resolvido só pro CONSOLIDADO de
// semana/mês (o valor diário desses KPIs continua sendo o que a planilha
// manda, não é recalculado dia a dia). Fórmula sempre
// (soma(numerador) - soma(denominador)) / soma(denominador) no período —
// cobre tanto "(RECEIVED-FORECAST)/FORECAST" (LH e FM) quanto a variante
// SEERRO "(PACKED REAL-PACKED PLANEJADO)/PACKED PLANEJADO" (Sorter e
// Esteira) — denominador somando 0 (ou sem nenhum dia com dado) -> null,
// nunca divide por zero.
const ARVORE_AGREGACAO_FORMULA = {
  "Inbound|COP|LH|(%) Forecast x Received": { numerador: "Inbound|COP|LH|Received", denominador: "Inbound|COP|LH|Forecast Received" },
  "Inbound|COP|FM|(%) Forecast x Received": { numerador: "Inbound|COP|FM|Received", denominador: "Inbound|COP|FM|Forecast Received" },
  "Sorter|COP|Sorter|(%) Planejado x Real": { numerador: "Sorter|COP|Sorter|Packed Real", denominador: "Sorter|COP|Sorter|Packed Planejado" },
  "Esteira|COP|Esteira|(%) Planejado x Real": { numerador: "Esteira|COP|Esteira|Packed Real", denominador: "Esteira|COP|Esteira|Packed Planejado" },
};

// Heurístico só pra KPI novo que ainda não está no ARVORE_META (a planilha
// pode ganhar linhas sem que essa tabela seja atualizada). Deliberadamente
// simples: nome com % ou target fracionário => percentual; nome com palavra
// de ocorrência/atraso => menor é melhor.
const PALAVRAS_MENOR_MELHOR = /atras|fila|backlog|perda|loss|damage|avaria|abs\b|absente|acidente|erro|falha|reclama|devolu|pendente|sinistro|excede|> ?\d|acima/i;
function metaHeuristica(kpi, targetNum, targetRaw) {
  const nome = String(kpi || '');
  const unit = /%/.test(nome) || /%/.test(String(targetRaw || '')) || (targetNum !== null && targetNum > 0 && targetNum <= 1)
    ? 'percent' : 'number';
  const polarity = PALAVRAS_MENOR_MELHOR.test(nome) || (unit === 'number' && targetNum === 0)
    ? 'lower_better' : 'higher_better';
  return { unit, polarity };
}
function metaDoKpi(bloco, pic, sub, kpi, targetNum, targetRaw) {
  const cfg = ARVORE_META[[bloco, pic, sub, kpi].join('|')];
  const m = cfg
    ? {
      unit: cfg[0] === 'p' ? 'percent' : 'number',
      polarity: cfg[1] === 'l' ? 'lower_better' : cfg[1] === 'z' ? 'near_zero' : cfg[1] === 'c' ? 'band100' : 'higher_better',
    }
    : metaHeuristica(kpi, targetNum, targetRaw);

  // Correção sobre a tabela do mockup: contagem (number) com meta ZERO é
  // sempre "quanto menos melhor" — meta 0 só existe pra coisa que não devia
  // acontecer. O convert_data.py marcava os 12 KPIs de ACA/PS (acidentes,
  // bloco Pessoas/HSE) como higher_better, o que deixava indicador de
  // segurança SEMPRE verde, inclusive com acidente registrado. Achado em
  // 2026-08-13 ao portar a página; reportado ao Roberto.
  if (m.unit === 'number' && targetNum === 0 && m.polarity === 'higher_better') {
    m.polarity = 'lower_better';
  }
  return m;
}

// Texto que a planilha usa pra "não tem número aqui" — some do gráfico e
// conta como "sem dado", não como zero (zerar inflaria média e status).
const VAZIOS = new Set(['', '-', '-%', '#REF!', '#N/A', '#DIV/0!', '#VALUE!', 'EM CRIAÇÃO', 'PENDENTE', 'N/A', 'NA']);

// Parser próprio em vez do toNum de _period.js: aquele devolve 0 pra
// qualquer lixo ("pendente" viraria 0 = "bateu o target de 0"), aqui
// precisamos distinguir zero de vazio.
function num(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s || VAZIOS.has(s.toUpperCase())) return null;
  const pct = s.endsWith('%');
  const corpo = pct ? s.slice(0, -1).trim() : s;
  const t = corpo.replace(/\./g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = parseFloat(t);
  if (isNaN(n)) return null;
  // Arredonda a divisão por 100 (1,35% viraria 0.013500000000000002 em
  // ponto flutuante) — mantém o JSON limpo e não muda a precisão útil.
  return pct ? Math.round(n * 1e8) / 1e10 : n;
}

const DIA_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
function diaDaSemana(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  return isNaN(d.getTime()) ? '' : DIA_SEMANA[d.getUTCDay()];
}

const ehData = v => /^\d{4}-\d{2}-\d{2}$/.test(v);
const ehSemana = v => /^W\d+$/.test(v);

// Quebra por turno (pedido do Roberto em 2026-08-13, mockup "arvore-kpis"
// bundle): dentro do mesmo Bloco/PIC/Sub Bloco, se existir KPI nomeado
// exatamente T1/T2/T3/T4, o KPI "Total" desse mesmo grupo ganha turnoRefs
// apontando pros ids — usado no drawer pra montar a tabela "Por turno". Só o
// "Total" recebe (não qualquer KPI não-T1-4 do grupo). Extraída (pedido do
// Roberto em 2026-09-22) pra ser reaproveitada por buildArvoreDoBanco
// (Postgres) — mesma regra pura, não depende de vir do Sheets ou do banco.
function aplicarTurnoRefs(kpis) {
  const grupos = new Map(); // bloco|pic|sub -> kpis do grupo
  kpis.forEach(k => {
    const chaveGrupo = [k.bloco, k.pic, k.subBloco].join('|');
    if (!grupos.has(chaveGrupo)) grupos.set(chaveGrupo, []);
    grupos.get(chaveGrupo).push(k);
  });
  grupos.forEach(grupo => {
    const turnos = {};
    grupo.forEach(k => { if (/^T[1-4]$/.test(k.kpi)) turnos[k.kpi] = k.id; });
    if (!Object.keys(turnos).length) return;
    const total = grupo.find(k => k.kpi === 'Total');
    if (total) total.turnoRefs = turnos;
  });
}

async function buildArvore() {
  const { rows } = await fetchTabByGid(ARVORE_SHEET.spreadsheetId, ARVORE_SHEET.gid);

  const kpiPorChave = new Map(); // chave -> objeto do KPI (ordem = ordem da planilha)
  const semanaDeDia = new Map(); // iso -> rótulo de semana
  const diasComDado = new Set();
  const semanasComDado = new Set();
  const todasDatas = new Set();
  const todasSemanas = new Set();
  const blocos = [];

  rows.forEach(r => {
    const data = String(r.data || '').trim();
    const bloco = String(r.bloco || '').trim();
    const kpiNome = String(r.kpi || '').trim();
    if (!data || !bloco || !kpiNome) return;

    const pic = String(r.pic || '').trim();
    const sub = String(r['sub bloco'] || '').trim();
    const chave = [bloco, pic, sub, kpiNome].join('|');

    if (ehData(data)) {
      todasDatas.add(data);
      const sem = String(r.semana || '').trim();
      if (ehSemana(sem)) semanaDeDia.set(data, sem);
    } else if (ehSemana(data)) {
      todasSemanas.add(data);
    } else {
      return; // Data que não é nem dia nem semana — ignora
    }

    if (!kpiPorChave.has(chave)) {
      if (!blocos.includes(bloco)) blocos.push(bloco);
      const targetRaw = String(r.target || '').trim();
      const target = num(targetRaw);
      const m = metaDoKpi(bloco, pic, sub, kpiNome, target, targetRaw);
      kpiPorChave.set(chave, {
        id: 'k' + kpiPorChave.size,
        bloco, pic, subBloco: sub, kpi: kpiNome,
        fonte: String(r.link || '').trim(),
        unit: m.unit, polarity: m.polarity,
        target, targetRaw,
        memoriaCalculo: ARVORE_AGREGACAO[chave] || (ARVORE_AGREGACAO_FORMULA[chave] ? 'formula_diff_pct' : null),
        valores: {}, obs: {},
      });
    }
    const k = kpiPorChave.get(chave);
    if (!k.fonte && r.link) k.fonte = String(r.link).trim();

    const v = num(r.valor);
    if (v !== null) {
      k.valores[data] = v;
      if (ehData(data)) diasComDado.add(data);
      else semanasComDado.add(data);
    }
    const obs = String(r['observação'] || r.observacao || '').trim();
    if (obs && !VAZIOS.has(obs.toUpperCase())) k.obs[data] = obs;
  });

  // Último dia com número de verdade — vira o "hoje" da tela e o limite da
  // timeline (a planilha tem o ano inteiro pré-criado, sem dado à frente).
  const diasOrdenados = [...diasComDado].sort();
  const lastRealDate = diasOrdenados[diasOrdenados.length - 1] || null;

  const days = [...todasDatas].sort()
    .filter(iso => !lastRealDate || iso <= lastRealDate)
    .map(iso => ({ iso, wk: semanaDeDia.get(iso) || '', wd: diaDaSemana(iso) }));

  const ordemSemana = s => parseInt(s.slice(1), 10);
  const weeks = [...todasSemanas].sort((a, b) => ordemSemana(a) - ordemSemana(b))
    .map(label => {
      const dias = days.filter(d => d.wk === label).map(d => d.iso).sort();
      return {
        label,
        startIso: dias[0] || null,
        endIso: dias[dias.length - 1] || null,
        hasRealData: semanasComDado.has(label) || dias.some(iso => diasComDado.has(iso)),
      };
    })
    .filter(w => w.startIso);

  const comDado = weeks.filter(w => w.hasRealData);
  const refWeeks = comDado.slice(-2).map(w => w.label);

  // KPIs calculados automaticamente (pedido do Roberto em 2026-08-18) — a
  // célula "Valor" dessas linhas na planilha deixa de valer: o valor vira
  // sempre numerador/denominador de outros 2 KPIs da própria árvore, pra
  // cada data/semana em que os dois tiverem número (sem os dois, sem
  // ponto — não inventa dado). Fração 0–1 (mesma convenção de todo KPI
  // "percent" aqui, ver num() acima — o front multiplica por 100 na hora
  // de exibir).
  const KPI_CALCULADOS = [
    { alvo: 'RETURNS|COP|EHA | RETURNS|% EHA X Recevied',
      numerador: 'RETURNS|COP|EHA | RETURNS|Recevied EHA inbound',
      denominador: 'Inbound|COP|LH|Received' },
    { alvo: 'Planejamento|Rodrigo (PCP)||(%) Desvio de Forecast',
      numerador: 'Planejamento|Rodrigo (PCP)|Forecast|Received Inbound Total',
      denominador: 'Planejamento|Rodrigo (PCP)|Forecast|Inbound Forecast S&OP' },
    { alvo: 'Planejamento|Rodrigo (PCP)|Planejamento|(%) Aderência ao Plano All',
      numerador: 'Planejamento|Rodrigo (PCP)|Planejamento|Packed Real D-1',
      denominador: 'Planejamento|Rodrigo (PCP)|Planejamento|Packed Planejado D-1' },
  ];
  KPI_CALCULADOS.forEach(({ alvo, numerador, denominador }) => {
    const kAlvo = kpiPorChave.get(alvo), kNum = kpiPorChave.get(numerador), kDen = kpiPorChave.get(denominador);
    if (!kAlvo || !kNum || !kDen) return;
    kAlvo.calculado = true;
    kAlvo.valores = {};
    new Set([...Object.keys(kNum.valores), ...Object.keys(kDen.valores)]).forEach(data => {
      const n = kNum.valores[data], d = kDen.valores[data];
      if (n == null || !d) return;
      kAlvo.valores[data] = Math.round((n / d) * 1e6) / 1e6;
    });
  });

  // "Produtividade Real" não tem Target próprio na planilha (célula "-")
  // — o número que existe (714) está na linha de "Produtividade Planejada",
  // mas comparar o PLANO contra ele mesmo não diz nada; quem precisa ser
  // avaliado contra esse target é o REALIZADO (pedido do Roberto em
  // 2026-08-24). Empresta só o TARGET (não o valor) do KPI irmão, mesmo
  // Bloco/PIC/Sub Bloco, e tira o target de quem emprestou — a formatação
  // condicional sai da Planejada e passa a valer pra Real.
  const ARVORE_TARGET_HERDADO = [
    { alvo: 'Planejamento|Rodrigo (PCP)|Planejamento|Produtividade Real',
      fonte: 'Planejamento|Rodrigo (PCP)|Planejamento|Produtividade Planejada' },
  ];
  ARVORE_TARGET_HERDADO.forEach(({ alvo, fonte }) => {
    const kAlvo = kpiPorChave.get(alvo), kFonte = kpiPorChave.get(fonte);
    if (!kAlvo || !kFonte || kFonte.target === null) return;
    kAlvo.target = kFonte.target;
    kAlvo.targetRaw = kFonte.targetRaw;
    kFonte.target = null;
    kFonte.targetRaw = '-';
  });

  // Resolve os KPIs irmãos das fórmulas de agregação (ARVORE_AGREGACAO_FORMULA
  // acima) pra id — o front (aggregatePeriod) soma os valores diários deles
  // no período direto pelo id, sem precisar adivinhar o KPI irmão pelo nome.
  Object.keys(ARVORE_AGREGACAO_FORMULA).forEach(chave => {
    const kAlvo = kpiPorChave.get(chave);
    const { numerador, denominador } = ARVORE_AGREGACAO_FORMULA[chave];
    const kNum = kpiPorChave.get(numerador), kDen = kpiPorChave.get(denominador);
    if (!kAlvo || !kNum || !kDen) return;
    kAlvo.aggRefs = { numeradorId: kNum.id, denominadorId: kDen.id };
  });

  const kpis = [...kpiPorChave.values()];

  // "Packed on time" / "% Packed on time" (bloco Inbound, sub bloco
  // "Packed") foram adicionados no fim da planilha — como a ordem da tela
  // segue a ordem das linhas da planilha, eles apareciam como um grupo
  // "Inbound" órfão na última linha, separado do resto do Inbound. Pedido
  // do Roberto em 2026-08-26: reposicionar só essas 2 linhas pra ficar
  // entre Triagem e ABS, sem mexer na ordem de mais nada.
  {
    const packed = [];
    for (let i = kpis.length - 1; i >= 0; i--) {
      if (kpis[i].bloco === 'Inbound' && kpis[i].subBloco === 'Packed') packed.unshift(kpis.splice(i, 1)[0]);
    }
    if (packed.length) {
      let insertAt = kpis.length;
      for (let i = kpis.length - 1; i >= 0; i--) {
        if (kpis[i].bloco === 'Inbound' && kpis[i].subBloco === 'Triagem') { insertAt = i + 1; break; }
      }
      kpis.splice(insertAt, 0, ...packed);
    }
  }

  aplicarTurnoRefs(kpis);

  return {
    meta: {
      fonte: 'ÁRVORE_INPUT',
      lastRealDate,
      refWeeks,
      atualizadoEm: new Date().toISOString(),
    },
    blocks: blocos,
    weeks,
    days,
    kpis,
  };
}

// Preenchimento manual (pedido do Roberto em 2026-08-17) — a aba já vem com
// o ano inteiro pré-criado (1 linha por Data × Bloco/PIC/Sub Bloco/KPI,
// Valor default "-"), então escrever é achar a linha existente e trocar só
// as células Valor (coluna H) e Observação (coluna I) — nunca insere linha
// nova.
//
// Regra por célula (entries[i] = { bloco, pic, subBloco, kpi, data, valor, observacao }):
//   Valor digitado (não vazio)      -> sobrescreve, seja lá o que tinha antes
//   Valor vazio + célula já tinha dado real -> mantém (não escreve nada)
//   Valor vazio + célula já estava vazia/"-" -> escreve "-" (mesmo texto
//                                                que a planilha já usa)
//   Observação: sem o mesmo problema de ambíguidade do Valor (comentário
//   vazio não precisa de placeholder pra não virar "zero") — digitada
//   sobrescreve, vazia sempre mantém o que já tinha, nunca força "-".
async function writeArvoreValores(entries) {
  const { title, values } = await fetchTabRawValues(ARVORE_SHEET.spreadsheetId, ARVORE_SHEET.gid);

  const idx = new Map(); // "bloco|pic|sub|kpi|data" -> { rowNum, valorAtual, obsAtual }
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const chave = [row[1] || '', row[2] || '', row[3] || '', row[4] || '', row[0] || ''].join('|');
    idx.set(chave, { rowNum: i + 1, valorAtual: row[7] || '', obsAtual: row[8] || '' });
  }

  const updates = [];
  const naoEncontrados = [];
  entries.forEach(e => {
    const chave = [e.bloco || '', e.pic || '', e.subBloco || '', e.kpi || '', e.data || ''].join('|');
    const alvo = idx.get(chave);
    if (!alvo) { naoEncontrados.push(chave); return; }

    const digitado = String(e.valor == null ? '' : e.valor).trim();
    let novoValor;
    if (digitado !== '') {
      novoValor = digitado;
    } else {
      const atual = String(alvo.valorAtual || '').trim();
      novoValor = (atual === '' || VAZIOS.has(atual.toUpperCase())) ? '-' : null; // null = mantém, não escreve
    }
    if (novoValor !== null && novoValor !== alvo.valorAtual) {
      updates.push({ range: `'${title}'!H${alvo.rowNum}`, values: [[novoValor]] });
    }

    const comentario = String(e.observacao == null ? '' : e.observacao).trim();
    if (comentario !== '' && comentario !== alvo.obsAtual) {
      updates.push({ range: `'${title}'!I${alvo.rowNum}`, values: [[comentario]] });
    }
  });

  if (updates.length) await batchUpdateValues(ARVORE_SHEET.spreadsheetId, updates);
  return { escritos: updates.length, naoEncontrados };
}

// "Copiar e colar como valor" no lugar (pedido do Roberto em 2026-08-17)
// — congela o resultado ATUAL do IMPORTRANGE/ARRAYFORMULA em texto/número
// fixo, célula por célula, sem mudar formatação nem posição. A partir daí
// a aba para de depender da planilha de origem e passa a ser editada só
// pelo preenchimento manual (writeArvoreValores acima).
//
// UMA LEITURA + UMA ESCRITA cobrindo a aba inteira, de propósito — versão
// anterior tentava em chunks (uma chamada por pedaço) achando que a
// fórmula continuaria servindo o restante ainda não tocado. Errado: é
// UM ARRAYFORMULA só cobrindo a aba inteira, então o primeiro chunk já
// quebra a fórmula de ponta a ponta — as linhas "ainda não processadas"
// não ficam esperando, ficam órfãs (viraram ~53 mil linhas em branco,
// incidente real em 2026-08-17). Ler tudo de uma vez ANTES de escrever
// qualquer coisa garante que a leitura pega o dado saudável inteiro
// antes da fórmula quebrar.
async function freezeArvoreAll() {
  const { title, values } = await fetchTabRawValues(ARVORE_SHEET.spreadsheetId, ARVORE_SHEET.gid);
  const NUM_COLS = 10; // A..J (Data..Link)
  const total = values.length;
  const padded = values.map(row => {
    const r = row.slice(0, NUM_COLS);
    while (r.length < NUM_COLS) r.push('');
    return r;
  });
  const range = `'${title}'!A1:J${total}`;
  await updateRangeRaw(ARVORE_SHEET.spreadsheetId, range, padded);
  return { totalRows: total };
}

// ============================================================================
// Postgres multi-SoC (pedido do Roberto em 2026-09-22) — mesmo shape de
// buildArvore() acima, mas lendo de_para_arvore_kpis + arvore_valores
// (db/schema_multi_soc.sql) em vez da planilha árvore_pulso. RJ2 já foi
// migrado (139 KPIs / 25.275 valores, ordem/target/unidade/polaridade/
// memoria_calculo/agg_ref_* já resolvidos linha a linha no backfill — não
// precisa mais de ARVORE_META/metaHeuristica/ARVORE_AGREGACAO aqui). RJ6/
// SC1/SC2 começam vazios (0 KPIs) até alguém cadastrar via "+ Adicionar KPI"
// (adicionarArvoreKpi abaixo) — front já trata `kpis: []` sem quebrar
// (mesmo caminho de "nenhum KPI encontrado" usado pelos filtros).
//
// O que NÃO precisa ser recalculado aqui (já veio resolvido do backfill,
// que rodou buildArvore() uma vez e gravou o resultado):
//   - KPI_CALCULADOS (série diária dos 3 KPIs de fórmula): os valores
//     calculados já estão gravados em arvore_valores linha a linha.
//   - ARVORE_TARGET_HERDADO (Produtividade Real herdando target da
//     Planejada): target/targetRaw já vieram corretos por KPI no backfill.
//   - Reposicionamento do "Packed" entre Triagem e ABS: `ordem` já reflete
//     a posição corrigida (backfill numerou pela ordem final do array).
//   - aggRefs (ARVORE_AGREGACAO_FORMULA): agora são colunas de verdade
//     (agg_ref_numerador/agg_ref_denominador), não precisa resolver por nome.
//
// O que CONTINUA sendo pós-processamento puro, recalculado a cada leitura
// (não dá pra "baking" isso num backfill — depende do conjunto de KPIs
// atual, que muda toda vez que alguém cadastra um novo):
//   - turnoRefs (aplicarTurnoRefs acima).
//   - weeks/days: a coluna "Semana" da planilha (calendário dia->semana)
//     NÃO foi migrada — arvore_valores só guarda periodo (data OU rótulo de
//     semana) + valor, sem essa metade do de-para. Sem ela não dá pra saber
//     que dia caía em qual "W7" histórica. Solução: calcula a semana do ano
//     (Dom-Sáb, mesma convenção de DIA_SEMANA) a partir da própria data —
//     autoconsistente, sempre agrupa os dias certos, só não reproduz
//     necessariamente o MESMO rótulo "W7" que a planilha usava pra aquela
//     semana (achado ao portar; sinalizado no relatório final).
function semanaDoAno(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  const ano = d.getUTCFullYear();
  const jan1 = new Date(Date.UTC(ano, 0, 1));
  const inicioSemana1 = new Date(jan1);
  inicioSemana1.setUTCDate(jan1.getUTCDate() - jan1.getUTCDay());
  const diffDias = Math.floor((d - inicioSemana1) / 86400000);
  return 'W' + (Math.floor(diffDias / 7) + 1);
}

async function buildArvoreDoBanco(soc) {
  const { pool } = require('../db');
  const [{ rows: kpiRows }, { rows: valorRows }] = await Promise.all([
    pool.query('SELECT * FROM de_para_arvore_kpis WHERE soc = $1 ORDER BY ordem NULLS LAST, kpi_id', [soc]),
    pool.query('SELECT * FROM arvore_valores WHERE soc = $1', [soc]),
  ]);

  const kpiPorId = new Map();
  const blocos = [];
  kpiRows.forEach(r => {
    if (r.bloco && !blocos.includes(r.bloco)) blocos.push(r.bloco);
    const k = {
      id: r.kpi_id,
      bloco: r.bloco, pic: r.pic, subBloco: r.sub_bloco, kpi: r.kpi,
      fonte: r.fonte || '',
      unit: r.unidade, polarity: r.polaridade,
      target: r.target === null ? null : Number(r.target),
      targetRaw: r.target_raw || '',
      memoriaCalculo: r.memoria_calculo || null,
      valores: {}, obs: {},
    };
    if (r.agg_ref_numerador && r.agg_ref_denominador) {
      k.aggRefs = { numeradorId: r.agg_ref_numerador, denominadorId: r.agg_ref_denominador };
    }
    kpiPorId.set(r.kpi_id, k);
  });

  const diasComDado = new Set();
  const todasDatas = new Set();
  valorRows.forEach(r => {
    const k = kpiPorId.get(r.kpi_id);
    if (!k) return; // linha órfã (kpi_id sem de-para) — não deveria acontecer, FK garante
    const periodo = String(r.periodo || '').trim();
    if (!periodo) return;
    if (ehData(periodo)) todasDatas.add(periodo);
    if (r.valor !== null && r.valor !== undefined) {
      k.valores[periodo] = Number(r.valor);
      if (ehData(periodo)) diasComDado.add(periodo);
    }
    if (r.observacao) k.obs[periodo] = r.observacao;
  });

  const diasOrdenados = [...diasComDado].sort();
  const lastRealDate = diasOrdenados[diasOrdenados.length - 1] || null;

  const days = [...todasDatas].sort()
    .filter(iso => !lastRealDate || iso <= lastRealDate)
    .map(iso => ({ iso, wk: semanaDoAno(iso), wd: diaDaSemana(iso) }));

  const ordemSemana = s => parseInt(s.slice(1), 10);
  const labelsSemana = [...new Set(days.map(d => d.wk))].sort((a, b) => ordemSemana(a) - ordemSemana(b));
  const weeks = labelsSemana.map(label => {
    const dias = days.filter(d => d.wk === label).map(d => d.iso).sort();
    return {
      label,
      startIso: dias[0] || null,
      endIso: dias[dias.length - 1] || null,
      hasRealData: dias.some(iso => diasComDado.has(iso)),
    };
  }).filter(w => w.startIso);

  const comDado = weeks.filter(w => w.hasRealData);
  const refWeeks = comDado.slice(-2).map(w => w.label);

  const kpis = [...kpiPorId.values()];
  aplicarTurnoRefs(kpis);

  return {
    meta: {
      fonte: 'POSTGRES',
      lastRealDate,
      refWeeks,
      atualizadoEm: new Date().toISOString(),
    },
    blocks: blocos,
    weeks,
    days,
    kpis,
  };
}

// "+ Adicionar KPI" (pedido do Roberto em 2026-09-22) — cadastra 1 linha em
// de_para_arvore_kpis pro soc da sessão. NÃO cria linhas em arvore_valores
// pro KPI novo — diferente do modelo antigo da planilha (ano inteiro
// pré-criado com "-"), arvore_valores é esparsa por design: só existe linha
// quando alguém realmente digita um valor (writeArvoreValores/preenchimento
// manual, fora do escopo desta função). Pular esse passo é o comportamento
// CORRETO da nova arquitetura, não uma omissão.
const MEMORIA_CALCULO_VALIDAS = new Set(['soma', 'media', 'maximo', 'media_sem_domingo', 'formula_diff_pct']);

function gerarKpiId() {
  return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Fractional indexing: calcula a posição (ordem) do KPI novo a partir dos
// nomes digitados em "Abaixo do KPI"/"Acima do KPI" (seção 4 do pedido).
// `todos` = KPIs já cadastrados no soc, ordenados por ordem (qualquer
// ordem serve, a função não assume nada sobre a entrada). Casamento por
// nome é case-insensitive/trim contra o campo `kpi` — não bloqueia o
// cadastro se não achar, só cai no padrão (fim da lista) e avisa.
function calcularOrdem(todos, abaixoNome, acimaNome) {
  const norm = s => String(s || '').trim().toLowerCase();
  const acharPor = nome => {
    if (!norm(nome)) return null;
    return todos.find(k => norm(k.kpi) === norm(nome)) || null;
  };
  const kAbaixo = acharPor(abaixoNome); // novo entra logo ABAIXO deste
  const kAcima = acharPor(acimaNome);   // novo entra logo ACIMA deste
  const avisos = [];
  if (abaixoNome && norm(abaixoNome) && !kAbaixo) avisos.push(`KPI de referência "${abaixoNome}" (Abaixo do KPI) não encontrado`);
  if (acimaNome && norm(acimaNome) && !kAcima) avisos.push(`KPI de referência "${acimaNome}" (Acima do KPI) não encontrado`);

  const ordemDe = k => Number(k.ordem);
  const ordenados = [...todos].filter(k => k.ordem !== null && k.ordem !== undefined).sort((a, b) => ordemDe(a) - ordemDe(b));

  if (kAbaixo && kAcima) {
    return { ordem: (ordemDe(kAbaixo) + ordemDe(kAcima)) / 2, avisos };
  }
  if (kAbaixo) {
    const idx = ordenados.findIndex(k => k.kpi_id === kAbaixo.kpi_id);
    const proximo = idx >= 0 ? ordenados[idx + 1] : null;
    return { ordem: proximo ? (ordemDe(kAbaixo) + ordemDe(proximo)) / 2 : ordemDe(kAbaixo) + 1, avisos };
  }
  if (kAcima) {
    const idx = ordenados.findIndex(k => k.kpi_id === kAcima.kpi_id);
    const anterior = idx > 0 ? ordenados[idx - 1] : null;
    return { ordem: anterior ? (ordemDe(anterior) + ordemDe(kAcima)) / 2 : ordemDe(kAcima) - 1, avisos };
  }
  // Nenhuma referência (ou nenhuma encontrada) -> fim da lista.
  const maiorOrdem = ordenados.length ? ordemDe(ordenados[ordenados.length - 1]) : -1;
  return { ordem: maiorOrdem + 1, avisos };
}

async function adicionarArvoreKpi(soc, payload) {
  const { pool } = require('../db');

  const bloco = String(payload.bloco || '').trim();
  const pic = String(payload.pic || '').trim();
  const subBloco = String(payload.subBloco || '').trim();
  const kpiNome = String(payload.kpi || '').trim();
  const targetRaw = String(payload.target || '').trim();
  const formulaDescricao = String(payload.formulaDescricao || payload.memoriaCalculoTexto || '').trim();
  const memoriaCalculo = String(payload.memoriaCalculo || '').trim();
  const corVerde = String(payload.corVerde || '').trim();
  const corVermelho = String(payload.corVermelho || '').trim();

  const faltando = [];
  if (!bloco) faltando.push('Bloco');
  if (!pic) faltando.push('PIC');
  if (!subBloco) faltando.push('Sub Bloco');
  if (!kpiNome) faltando.push('KPI');
  if (!targetRaw) faltando.push('Target');
  if (!formulaDescricao) faltando.push('Memória de Cálculo');
  if (!corVerde) faltando.push('Formatação Condicional (verde)');
  if (!corVermelho) faltando.push('Formatação Condicional (vermelho)');
  if (faltando.length) {
    return { ok: false, erro: `Campo(s) obrigatório(s) não preenchido(s): ${faltando.join(', ')}.` };
  }
  if (!MEMORIA_CALCULO_VALIDAS.has(memoriaCalculo)) {
    return { ok: false, erro: 'Selecione como consolidar na semana (Memória de Cálculo).' };
  }

  // corVerde/corVermelho: 'acima' | 'abaixo' (do target) — define a
  // polaridade. Só o verde decide (pedido do Roberto, seção 3.2): verde
  // "Acima do target" -> higher_better, verde "Abaixo do target" -> lower_better.
  const polaridade = corVerde === 'abaixo' ? 'lower_better' : 'higher_better';

  const target = num(targetRaw);
  // Unidade não é um campo pedido no formulário (seção 2 do pedido não tem
  // "Unidade") — inferida do texto do Target, mesmo heurístico usado pro
  // KPI vindo da planilha (metaHeuristica acima): tem "%" -> percent.
  const unidade = /%/.test(targetRaw) ? 'percent' : 'number';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Duplicado: mesmo soc+bloco+pic+sub_bloco+kpi, case-insensitive/trim.
    const dup = await client.query(
      `SELECT 1 FROM de_para_arvore_kpis
        WHERE soc = $1 AND lower(trim(bloco)) = lower($2) AND lower(trim(pic)) = lower($3)
          AND lower(trim(sub_bloco)) = lower($4) AND lower(trim(kpi)) = lower($5)
        LIMIT 1`,
      [soc, bloco, pic, subBloco, kpiNome]
    );
    if (dup.rows.length) {
      await client.query('ROLLBACK');
      return { ok: false, erro: 'Este KPI já está cadastrado.' };
    }

    const todos = (await client.query(
      'SELECT kpi_id, kpi, ordem FROM de_para_arvore_kpis WHERE soc = $1',
      [soc]
    )).rows;
    const { ordem, avisos } = calcularOrdem(todos, payload.abaixoDoKpi, payload.acimaDoKpi);

    const kpiId = gerarKpiId();
    try {
      await client.query(
        `INSERT INTO de_para_arvore_kpis
           (soc, kpi_id, bloco, pic, sub_bloco, kpi, unidade, polaridade, target, target_raw,
            memoria_calculo, ordem, formula_descricao, atualizado_em)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())`,
        [soc, kpiId, bloco, pic, subBloco, kpiNome, unidade, polaridade, target, targetRaw,
          memoriaCalculo, ordem, formulaDescricao]
      );
    } catch (err) {
      // Corrida entre 2 requests simultâneos (checagem acima não é atômica
      // sozinha) — índice único auxiliar (db/migracao_dedup_arvore_kpis.sql)
      // cobre isso: violação vira o mesmo erro amigável, não um 502 cru.
      if (err.code === '23505') {
        await client.query('ROLLBACK');
        return { ok: false, erro: 'Este KPI já está cadastrado.' };
      }
      throw err;
    }

    await client.query('COMMIT');
    return { ok: true, kpiId, ordem, avisos };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Preenchimento manual, versão Postgres (pedido do Roberto em 2026-09-22,
// fechando o mesmo dia da migração pra multi-SoC) — o botão "Preencher
// dados" (FillDataModal, arvore.html) manda exatamente o mesmo formato de
// entries de sempre; só troca o destino da gravação, já que a árvore lida
// (buildArvoreDoBanco acima) não vem mais do Sheets. Sem isso o botão
// continuaria gravando na planilha enquanto a tela lê do Postgres — os dois
// mundos parando de se falar silenciosamente, quebrando o preenchimento
// manual sem avisar ninguém.
//
// Diferente de writeArvoreValores (Sheets, ano inteiro pré-criado, precisa
// do placeholder "-" pra distinguir "vazio de propósito" de "nunca
// preenchido"): arvore_valores é esparsa, célula sem valor simplesmente não
// tem linha — não existe "-" aqui, célula vazia só significa "não mexe".
async function writeArvoreValoresDoBanco(soc, entries) {
  const { pool } = require('../db');
  const { rows: kpiRows } = await pool.query(
    'SELECT kpi_id, bloco, pic, sub_bloco, kpi FROM de_para_arvore_kpis WHERE soc = $1',
    [soc]
  );
  const idPorChave = new Map();
  kpiRows.forEach(r => {
    const chave = [r.bloco || '', r.pic || '', r.sub_bloco || '', r.kpi || ''].join('|');
    idPorChave.set(chave, r.kpi_id);
  });

  let escritos = 0;
  const naoEncontrados = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const e of entries) {
      const chave = [e.bloco || '', e.pic || '', e.subBloco || '', e.kpi || ''].join('|');
      const kpiId = idPorChave.get(chave);
      const periodo = String(e.data || '').trim();
      if (!kpiId || !periodo) { naoEncontrados.push(chave + '|' + periodo); continue; }

      const digitado = String(e.valor == null ? '' : e.valor).trim();
      const comentario = String(e.observacao == null ? '' : e.observacao).trim();
      // Valor precisa virar número de verdade (a coluna é numeric, diferente
      // da célula-texto do Sheets) — texto não parseável equivale a "vazio",
      // não escreve (mesmo espírito do num() usado no resto do arquivo).
      const valorNum = digitado !== '' ? num(digitado) : null;

      if (valorNum === null && comentario === '') continue; // nada pra gravar nessa célula

      if (valorNum !== null) {
        await client.query(
          `INSERT INTO arvore_valores (soc, kpi_id, periodo, valor, observacao, atualizado_em)
           VALUES ($1,$2,$3,$4, NULLIF($5,''), now())
           ON CONFLICT (soc, kpi_id, periodo) DO UPDATE SET
             valor = EXCLUDED.valor,
             observacao = COALESCE(NULLIF($5,''), arvore_valores.observacao),
             atualizado_em = now()`,
          [soc, kpiId, periodo, valorNum, comentario]
        );
      } else {
        await client.query(
          `INSERT INTO arvore_valores (soc, kpi_id, periodo, valor, observacao, atualizado_em)
           VALUES ($1,$2,$3, NULL, $4, now())
           ON CONFLICT (soc, kpi_id, periodo) DO UPDATE SET
             observacao = EXCLUDED.observacao,
             atualizado_em = now()`,
          [soc, kpiId, periodo, comentario]
        );
      }
      escritos++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { escritos, naoEncontrados };
}

module.exports = { buildArvore, writeArvoreValores, freezeArvoreAll, buildArvoreDoBanco, adicionarArvoreKpi, writeArvoreValoresDoBanco };
