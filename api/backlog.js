/**
 * PULSO — Backlog (aba forecast_backlog_pulso, colunas A-G).
 *
 * Modelo novo (2026-08-04): a base deixou de ser uma série horária por
 * cutoff/hour_cutoff e virou um snapshot granular por
 * faixa_aging/perfil/origem. As colunas A-G (backlog) e H-M (forecast,
 * ver api/forecast.js) continuam sendo DUAS TABELAS INDEPENDENTES
 * coladas lado a lado — sem relação linha a linha (nomes de coluna, não
 * posição — a ordem das colunas mudou em 2026-08-21 e ninguém quebrou
 * por causa disso, ver abaixo).
 *
 * Estrutura mudou de novo em 2026-08-21 (confirmado ao vivo via
 * debug-meta): a coluna de tempo virou `ultima_atualizacao_tabela`
 * (formato "YYYY-MM-DD HH:MM:SS.000 America/Sao_Paulo", substitui
 * `snapshot_hora`) e passou a ser o MESMO valor pra praticamente todas as
 * linhas — a aba deixou de guardar ~24h de snapshots rolantes e virou só
 * o snapshot ATUAL. Confirmado com o Roberto: o filtro de hora do
 * Backlog não perde função, só que agora sempre vai ter 1 hora só na
 * lista (a vigente) em vez de várias — não precisou mexer no front.
 * `faixa_aging`/`perfil`/`status_desc`/`origem`/`qtd_pacotes`/
 * `aging_medio_min` continuam com os mesmos nomes de coluna, lidos pelo
 * nome (fetchTabByGid usa o header, não a posição), então a reordenação
 * de colunas sozinha não quebra nada aqui.
 *
 * 2 colunas novas apareceram, `grade_hrs` e `qtd_grade`. Achado ao vivo
 * (debug-meta) que inverteu a leitura inicial: a MAIORIA das ~17.6k linhas
 * (grade_hrs vazio) são linhas de padding em branco (faixa_aging também
 * vazio) — o backlog de aging real de hoje é só o bloco de 129 linhas com
 * `grade_hrs = 'grade_hrs_atual'`. Existem outros 24 blocos de 129 linhas
 * cada (`grade_hrs_00'..'grade_hrs_23'`, um conceito de grid por hora
 * ainda sem uso definido no front) que ficam de fora por ora. `qtd_grade`
 * não é usado aqui (tem inconsistência de formatação de data na planilha
 * nele — fora do escopo desta leitura).
 *
 * Data operacional (padrão pra todos os reports/gráficos, confirmado com
 * o Roberto em 2026-08-04): cutoff de 6h — o timestamp entre 00:00 e
 * 05:59 pertence ao dia operacional ANTERIOR, não ao dia-calendário do
 * timestamp (ver dataOperacionalDe em api/_period.js). É o único ponto do
 * PULSO que deriva uma data a partir de um timestamp cru; as demais
 * páginas já recebem a data pronta da planilha (cutoff/data_operacional).
 *
 * `date` (período, igual ao padrão de from/to do Inbound) é resolvido no
 * servidor; hora/perfil são filtros de dimensão e ficam a cargo do
 * front (mesmo padrão do turno/status/origem no Inbound LH) — por isso a
 * API devolve todas as linhas do dia e deixa o front recortar.
 *
 * Query params:
 *   date   YYYY-MM-DD (default = hoje operacional, ou o dia mais recente disponível)
 */
const { fetchTabByGid } = require('./_google');
const { toNum, dataOperacionalDe, hojeOperacionalIso, ordemHoraCutoff } = require('./_period');
const { socDaSessaoOuErro } = require('./_users');

const SHEET = { spreadsheetId: '1BqZElDRwVaGpDYZzHTq9UQvVLy2guRVfTdvwGHL1qC4', gid: '202012183' };

// "2026-08-24 08:21:36.000 America/Sao_Paulo" -> { data:"2026-08-24"
// (operacional, cutoff 6h), hora:8 (relógio real, pro filtro de hora) }.
// Sem "$" no fim do regex de propósito — só casa o prefixo YYYY-MM-DD
// HH:MM:SS e ignora o que vier depois (milissegundos + fuso), tolerando
// tanto o formato novo quanto o antigo (sem sufixo).
function dataHoraDe(v) {
  const m = String(v || '').match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):\d{2}:\d{2}/);
  return m ? { data: dataOperacionalDe(`${m[1]} ${m[2]}:00:00`), hora: Number(m[2]) } : { data: null, hora: null };
}

module.exports = async (req, res) => {
  const soc = socDaSessaoOuErro(req, res);
  if (!soc) return;

  // Aba forecast_backlog_pulso é implicitamente RJ2 (sem coluna de SoC) —
  // pra qualquer outro SoC, nem busca (melhor nada do que misturar dado de
  // RJ2 — pedido do Roberto em 2026-09-24, mesmo gate de cluster.js/
  // conveyor.js). Mesma forma da resposta "sem dado" já usada abaixo quando
  // a aba vem vazia.
  if (soc !== 'RJ2') {
    res.status(200).json({
      ok: true, date: null, rows: [],
      opcoes: { perfis: [], faixas: [], horas: [] },
      ultimaAtualizacao: null,
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

  const backlog = rows
    .filter(r => r.faixa_aging && r.grade_hrs === 'grade_hrs_atual')
    .map(r => {
      const { data, hora } = dataHoraDe(r.ultima_atualizacao_tabela);
      return {
        data, hora,
        faixaAging: r.faixa_aging || '',
        perfil: r.perfil || '',
        statusDesc: r.status_desc || '',
        origem: r.origem || '',
        qtdPacotes: toNum(r.qtd_pacotes),
        agingMedioMin: toNum(r.aging_medio_min),
        snapshotHora: r.ultima_atualizacao_tabela || '',
      };
    })
    .filter(r => r.data !== null);

  if (!backlog.length) {
    res.status(200).json({
      ok: true, date: null, rows: [],
      opcoes: { perfis: [], faixas: [], horas: [] },
      ultimaAtualizacao: null,
      cobertura: { inicio: null, fim: null },
    });
    return;
  }

  const datasDisponiveis = [...new Set(backlog.map(r => r.data))].sort();
  const dataMinima = datasDisponiveis[0], dataMaxima = datasDisponiveis[datasDisponiveis.length - 1];
  const hojeIso = hojeOperacionalIso();
  const padrao = datasDisponiveis.includes(hojeIso) ? hojeIso : dataMaxima;
  const date = (req.query.date && datasDisponiveis.includes(req.query.date)) ? req.query.date : padrao;

  const doDia = backlog.filter(r => r.data === date);

  const opcoes = {
    perfis: [...new Set(doDia.map(r => r.perfil).filter(Boolean))].sort(),
    faixas: [...new Set(doDia.map(r => r.faixaAging).filter(Boolean))],
    // Ordem de cutoff (6h...23h,0h...5h), não numérica crua — senão
    // "última hora" no front pegava 23h em vez da real (ex.: 2h da manhã,
    // que é cronologicamente depois de 23h dentro do dia operacional).
    horas: [...new Set(doDia.map(r => r.hora))].sort((a, b) => ordemHoraCutoff(a) - ordemHoraCutoff(b)),
  };

  const ultimaAtualizacao = doDia.reduce((max, r) => (!max || r.snapshotHora > max) ? r.snapshotHora : max, null);

  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
  res.status(200).json({
    ok: true,
    date,
    rows: doDia.map(({ data, ...resto }) => resto),
    opcoes,
    ultimaAtualizacao,
    cobertura: { inicio: dataMinima, fim: dataMaxima },
  });
};
