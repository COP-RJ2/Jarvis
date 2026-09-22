-- "+ Adicionar KPI" pela interface da Árvore (pedido do Roberto em
-- 2026-09-22) — índice único auxiliar que garante, no próprio banco, que
-- não existam 2 KPIs com o mesmo soc+bloco+pic+sub_bloco+kpi (case-
-- insensitive/trim). O backend (adicionarArvoreKpi, api/_arvore.js) já
-- checa isso com um SELECT antes do INSERT, mas isso sozinho não é à prova
-- de 2 requests simultâneos (race condition clássica de "check-then-act")
-- — este índice é quem garante de verdade, e o backend traduz a violação
-- (Postgres error 23505) na mesma mensagem amigável "Este KPI já está
-- cadastrado.".
CREATE UNIQUE INDEX IF NOT EXISTS ux_de_para_arvore_kpis_dedup
  ON de_para_arvore_kpis (soc, lower(trim(bloco)), lower(trim(pic)), lower(trim(sub_bloco)), lower(trim(kpi)));
