-- Auditoria genérica de mudanças nos de-para (pedido do Roberto em
-- 2026-09-16) — 1 tabela só pra todos os de_para_*, em vez de duplicar
-- auditoria tabela por tabela. Preenchida pela aplicação (não automática
-- via trigger) no momento em que o CRUD do front gravar uma mudança.
CREATE TABLE IF NOT EXISTS de_para_auditoria (
  id            bigserial PRIMARY KEY,
  tabela        text NOT NULL,      -- ex: 'de_para_ruas'
  soc           text NOT NULL,
  chave         text NOT NULL,      -- identifica a linha alterada (ex: staging_area_id, ou "macro|processo")
  campo         text NOT NULL,      -- coluna alterada, ex: 'capacidade'
  valor_antigo  text,
  valor_novo    text,
  usuario_email text NOT NULL,
  alterado_em   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_de_para_auditoria_tabela ON de_para_auditoria (tabela, soc, chave);

SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;
