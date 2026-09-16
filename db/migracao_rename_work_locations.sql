-- Renomeia work_locations -> de_para_work_locations (pedido do Roberto em
-- 2026-09-16). Rodar ANTES do deploy do código que já espera esse nome novo
-- (api/_users.js) — senão o app cria uma tabela nova vazia em vez de achar
-- a existente.
ALTER TABLE work_locations RENAME TO de_para_work_locations;

SELECT * FROM de_para_work_locations;
