-- Ingest runs (idempotência do job de ingest) + brainstorm de escalabilidade
-- (pedido do Roberto em 2026-09-16). Rodar na tela Data/Query do Postgres.
CREATE TABLE IF NOT EXISTS ingest_runs (
  id             bigserial PRIMARY KEY,
  job            text NOT NULL,
  soc            text NOT NULL REFERENCES socs(soc),
  periodo        text NOT NULL,
  status         text NOT NULL DEFAULT 'em_andamento',
  linhas         integer,
  erro           text,
  iniciado_em    timestamptz NOT NULL DEFAULT now(),
  finalizado_em  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ingest_runs_job_soc_periodo ON ingest_runs (job, soc, periodo);

SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;
