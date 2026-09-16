-- Seed inicial da dimensão socs (pedido do Roberto em 2026-09-16).
-- Rodar DEPOIS de db/schema_multi_soc.sql.
INSERT INTO socs (soc, nome, ativo) VALUES
  ('SOC-RJ2', 'SOC-RJ2', true),
  ('SOC-RJ6', 'SOC-RJ6', true),
  ('SOC-SC1', 'SOC-SC1', true)
ON CONFLICT (soc) DO NOTHING;
