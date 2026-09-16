-- Ajuste pedido pelo Roberto em 2026-09-16 (2ª rodada), em cima do schema já
-- aplicado. Roda isso na tela Data/Query do Postgres (Railway).

-- 1) Renomeia as tabelas de de-para pra ficarem identificáveis no nome.
ALTER TABLE config_ruas RENAME TO de_para_ruas;
ALTER TABLE config_labor_processos RENAME TO de_para_labor_processos;
ALTER TABLE config_arvore_kpis RENAME TO de_para_arvore_kpis;

-- 2) Remove as tabelas "ontime" (alimentadas ao vivo pelos projetos Pulse,
--    Python — ficam fora do Postgres por enquanto). Todas vazias, sem risco.
DROP TABLE IF EXISTS asm_dados;
DROP TABLE IF EXISTS asm_rejeito;
DROP TABLE IF EXISTS asm_sorter_mesas;
DROP TABLE IF EXISTS asm_sorter_carrinhos;
DROP TABLE IF EXISTS asm_sorter_chutes;
DROP TABLE IF EXISTS conveyor_dados;
DROP TABLE IF EXISTS inbound_lh_fila;
DROP TABLE IF EXISTS outbound_monitor;
DROP TABLE IF EXISTS outbound_monitor_tags;

-- Confirma o resultado.
SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;
