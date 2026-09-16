-- Packed on Time — schema multi-SoC (pedido do Roberto em 2026-09-16).
-- Baseado no de-para em docs/ (deparaintegracao_packed ontime.md) — colunas
-- da planilha fonte (seção 2 do de-para), não o formato interno reduzido
-- (RECORDS/HOUR_RECORDS) que a tela estática usa só pra economizar tamanho
-- de arquivo. Rodar na tela Data/Query do Postgres (Railway).
--
-- ESTADO: só estrutura. A página hoje (indicadores/packed-on-time.html) é
-- estática, com os dados embutidos no próprio arquivo — não lê esta tabela
-- ainda. Migrar pra fonte viva é decisão separada (Opção B do de-para).
CREATE TABLE IF NOT EXISTS packed_on_time_dados (
  id              bigserial PRIMARY KEY,
  soc             text NOT NULL REFERENCES socs(soc),
  cutoff_day      date,               -- pode vir vazio (linha "órfã", ver de-para seção 2)
  outbound_week   integer,
  cutoff_hour     smallint,           -- 0-23
  turno           text,               -- T1 | T2 | T3
  oot             text NOT NULL,      -- On time | Out time | CPT not available
  station_name    text,
  origem_pacote   text,               -- First Mile | Line Haul
  unitizador      text,               -- Scuttle | Saca | Pallet | Saca Sorter | Volumoso | null
  total_orders    numeric NOT NULL,   -- sempre somado, nunca contado por linha
  criado_em       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_packed_on_time_soc_data ON packed_on_time_dados (soc, cutoff_day, cutoff_hour);

SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;
