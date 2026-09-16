-- ============================================================================
-- JARVIS — Schema Postgres Multi-SoC
-- ============================================================================
-- Gerado em 2026-09-16 a partir do prompt em
-- docs/prompt-schema-multi-soc-postgres.md, com o inventário real de campos
-- de cada api/*.js. Ajustado em 2026-09-16 (2ª rodada, pedido do Roberto):
--   - Tabelas "de-para" ganharam prefixo de_para_ (antes config_), pra
--     identificar de cara no nome que são cadastro editável, não fato.
--   - Removidas as tabelas de fontes "ontime" (alimentadas ao vivo pelos
--     projetos Pulse — serviços Python separados por SoC: Pulse RJ2, Pulse
--     RJ1/RJ6, Pulse SC2). Essas continuam fora do Postgres por enquanto —
--     o front vai combinar esse schema com chamadas ao vivo pros Pulse.
--
-- ESTADO: schema criado, MAS AINDA NÃO CONSUMIDO pelo app (as APIs
-- continuam lendo do Google Sheets normalmente). A migração de fato
-- ("Dia D": trocar a fonte de leitura pra Postgres) é uma etapa futura,
-- separada desta.
--
-- Convenções:
--   - snake_case em português, mesmo padrão das colunas de planilha já
--     usadas no projeto (ex.: qtd_pacotes, aging_medio_min).
--   - Toda tabela de fato/de-para carrega soc (FK pra socs.soc) — SEMPRE o
--     primeiro campo de filtro nas queries multi-tenant.
--   - Tabelas de-para/cadastro (editáveis no front) usam o prefixo
--     de_para_<nome>.
--   - Tabelas com chave natural limpa (viagem, to_number, trip_number) usam
--     PK composta (soc, chave). Tabelas de agregação sem chave 100% única
--     usam "id bigserial" + índice em (soc, data/hora, ...).
--   - "atualizado_em"/"criado_em" em toda tabela — mesmo padrão já usado em
--     work_locations/auth_codes.
-- ============================================================================


-- ============================================================================
-- 1. DIMENSÃO: SoC e de-para de acesso por work location
-- ============================================================================

CREATE TABLE IF NOT EXISTS socs (
  soc         text PRIMARY KEY,              -- código curto, ex: 'SOC-RJ2'
  nome        text NOT NULL,                 -- nome de exibição
  ativo       boolean NOT NULL DEFAULT true,
  criado_em   timestamptz NOT NULL DEFAULT now()
);

-- De-para work_location -> soc(s). N:N de propósito: uma work location pode,
-- em tese, enxergar mais de 1 SoC, e vice-versa. A tabela work_locations
-- (já existente, e-mail -> work location) não muda; essa aqui só resolve
-- work_location -> quais soc(s) aquela pessoa pode ver.
CREATE TABLE IF NOT EXISTS work_location_soc (
  work_location   text NOT NULL,
  soc             text NOT NULL REFERENCES socs(soc),
  criado_em       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (work_location, soc)
);


-- ============================================================================
-- 2. DE-PARA — cadastro editável direto no front-end (não vêm mais de
--    planilha depois de migrados; hoje ainda é a aba `config`/`bat`)
-- ============================================================================

-- Substitui a aba `config` (colunas A-J: staging area id/staging area
-- name/capacity/cluster), hoje única e implicitamente RJ2 — usada por
-- Clusterização (api/cluster.js) e Outbound (api/outbound.js).
CREATE TABLE IF NOT EXISTS de_para_ruas (
  soc               text NOT NULL REFERENCES socs(soc),
  staging_area_id   text NOT NULL,           -- código tipo "OBS-03CW"
  rua               text NOT NULL,           -- "RUA 005" / "RESERVA 37A"
  capacidade        numeric NOT NULL DEFAULT 0,
  cluster_esperado  text,                    -- destino esperado (fanout correto)
  atualizado_em     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (soc, staging_area_id)
);

-- Substitui a aba `bat` (BAT_SHEET) usada pelo Labor Plan — premissas de
-- mão de obra por processo/macro (o "workstation" mencionado pelo Roberto:
-- por_ws = quantidade por posto de trabalho). CONFIRMADO no código: NÃO é
-- a mesma aba `config` de ruas — são fontes diferentes hoje.
CREATE TABLE IF NOT EXISTS de_para_labor_processos (
  soc            text NOT NULL REFERENCES socs(soc),
  macro          text NOT NULL,              -- ex: 'ASM', 'INBOUND LH'
  processo       text NOT NULL,              -- ex: 'TRIADOR LH'
  por_ws         numeric,                    -- quantidade por posto de trabalho
  phd            numeric,                    -- pacotes por hora/dia (capacidade)
  nominal        numeric,
  priorizacao    numeric,
  indireto       boolean NOT NULL DEFAULT false,
  atualizado_em  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (soc, macro, processo)
);

-- Definição dos KPIs da Árvore de Indicadores (bloco/pic/subbloco/meta/
-- polaridade) — a PARTE "de-para" (cadastro), separada dos valores diários
-- (fato, arvore_valores mais abaixo). Editável no front — hoje vem da aba
-- própria via api/_arvore.js.
CREATE TABLE IF NOT EXISTS de_para_arvore_kpis (
  soc               text NOT NULL REFERENCES socs(soc),
  kpi_id            text NOT NULL,           -- ex: "k0"
  bloco             text,
  pic               text,
  sub_bloco         text,
  kpi               text NOT NULL,
  fonte             text,
  unidade           text,                    -- 'number' | 'percent'
  polaridade        text,                    -- 'higher_better' | 'lower_better' | 'near_zero' | 'band100'
  target            numeric,
  target_raw        text,
  memoria_calculo   text,                    -- 'soma' | 'media' | 'maximo' | 'media_sem_domingo' | 'formula_diff_pct'
  agg_ref_numerador text,
  agg_ref_denominador text,
  atualizado_em     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (soc, kpi_id)
);


-- Auditoria genérica de mudanças nos de-para (pedido do Roberto em
-- 2026-09-16) — 1 tabela só pra todos os de_para_*, em vez de duplicar
-- auditoria tabela por tabela. Preenchida pela aplicação (não trigger
-- automático) no momento em que o CRUD do front gravar uma mudança.
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

-- Controle de execução do job de ingest (pedido do Roberto em 2026-09-16,
-- brainstorm de escalabilidade) — idempotência sem precisar de mecanismo de
-- lock separado: o job faz um INSERT normal (não upsert) antes de começar a
-- processar um (job, soc, periodo); se já existir linha pra essa combinação
-- (UNIQUE abaixo), o INSERT falha e o job sabe que aquele horário já rodou
-- (ou está rodando), evitando processar duas vezes. Job em si ainda não
-- existe — essa tabela é só a base pronta pra quando for construído.
CREATE TABLE IF NOT EXISTS ingest_runs (
  id             bigserial PRIMARY KEY,
  job            text NOT NULL,       -- nome do job/fonte, ex: 'sheets_horario'
  soc            text NOT NULL REFERENCES socs(soc),
  periodo        text NOT NULL,       -- horário processado, ex: '2026-09-16T14:00'
  status         text NOT NULL DEFAULT 'em_andamento',  -- 'em_andamento' | 'sucesso' | 'erro'
  linhas         integer,
  erro           text,
  iniciado_em    timestamptz NOT NULL DEFAULT now(),
  finalizado_em  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ingest_runs_job_soc_periodo ON ingest_runs (job, soc, periodo);


-- ============================================================================
-- 3. FATO / SNAPSHOTS — dados SQL (planilha em lote), retroalimentação do
--    front (justificativas) e input manual (Árvore). NÃO inclui fontes
--    "ontime" (Pulse/Python) — essas ficam fora deste schema por enquanto:
--    ASM ao vivo, Sorting Exception, Sorter (mesas/carrinhos/chutes),
--    Conveyor, Monitor Fila (LH), Monitor Outbound Live.
-- ============================================================================

-- --- Backlog / Forecast (api/backlog.js, api/forecast.js) ------------------

CREATE TABLE IF NOT EXISTS backlog_snapshots (
  id                bigserial PRIMARY KEY,
  soc               text NOT NULL REFERENCES socs(soc),
  data              date NOT NULL,
  hora              smallint,
  faixa_aging       text NOT NULL,
  perfil            text,
  status_desc       text,
  origem            text,
  qtd_pacotes       numeric,
  aging_medio_min   numeric,
  snapshot_hora     timestamptz NOT NULL,
  criado_em         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_backlog_soc_data ON backlog_snapshots (soc, data, snapshot_hora);

-- Forecast é diário/agregado (não linha a linha) — 1 registro por dia por
-- canal, já resolvido no nível certo.
CREATE TABLE IF NOT EXISTS forecast_diario (
  soc            text NOT NULL REFERENCES socs(soc),
  data           date NOT NULL,
  total          numeric,
  lh             numeric,
  fm             numeric,
  cb             numeric,
  full_canal     numeric,                    -- "full" é palavra reservada em alguns contextos, evita
  transhipment   numeric,
  atualizado_em  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (soc, data)
);

-- --- Inbound Line Haul (api/inbound-lh.js) — plano/execução da viagem ----
-- (inbound_lh_fila, que é o Monitor Fila ao vivo, ficou de fora — Pulse.)

CREATE TABLE IF NOT EXISTS inbound_lh_dados (
  soc                       text NOT NULL REFERENCES socs(soc),
  viagem                    text NOT NULL,
  cutoff_eta_planejado      date,
  cutoff_descarga           date,
  origem                    text,
  veiculo                   text,
  turno                     text,
  status                    text,
  hora_planejada            numeric,
  hora_realizada            numeric,
  planejado                 timestamptz,
  realizado                 timestamptz,
  realizada                 boolean,
  descarregada              boolean,
  atraso_min                numeric,
  on_time                   boolean,
  checkin_destino           timestamptz,
  abertura_bau              timestamptz,
  inicio_descarga           timestamptz,
  fim_descarga              timestamptz,
  hora_checkin              numeric,
  tempo_fila_min            numeric,
  tempo_descarga_min        numeric,
  pacotes                   numeric,
  tos                       numeric,
  pacotes_saca              numeric,
  tos_saca                  numeric,
  pacotes_scuttle           numeric,
  tos_scuttle               numeric,
  pacotes_g_bulk            numeric,
  pacotes_pm                numeric,
  solicitacao               text,
  hora_descarga             numeric,
  doca_descarga             text,
  atualizado_em             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (soc, viagem)
);

-- --- Inbound First Mile (api/inbound-fm.js) -----------------------------

CREATE TABLE IF NOT EXISTS inbound_fm_dados (
  id                    bigserial PRIMARY KEY,
  soc                   text NOT NULL REFERENCES socs(soc),
  data                  date NOT NULL,
  driver                text,
  estacao               text,
  agencia               text,
  turno                 text,
  hora                  smallint,
  checkin_driver        timestamptz,
  atribuicao_doca       text,
  ocupacao_doca         text,
  finalizacao_jornada   timestamptz,
  tempo_fila_min        numeric,
  tempo_descarga_min    numeric,
  tempo_total_min       numeric,
  performance_doca      text,
  desvio_meta_min       numeric,
  pacotes               numeric,
  criado_em             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_inbound_fm_soc_data ON inbound_fm_dados (soc, data, hora);
-- dedupe natural (driver + checkin), usado hoje no api pra evitar linha
-- repetida — vira índice único em vez de regra em memória.
CREATE UNIQUE INDEX IF NOT EXISTS ux_inbound_fm_driver_checkin ON inbound_fm_dados (soc, driver, checkin_driver);

CREATE TABLE IF NOT EXISTS inbound_fm_docas (
  id            bigserial PRIMARY KEY,
  soc           text NOT NULL REFERENCES socs(soc),
  data          date NOT NULL,
  workstation   text,
  hora          smallint,
  criado_em     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_inbound_fm_docas_soc_data ON inbound_fm_docas (soc, data, hora);

-- --- Clusterização (api/cluster.js) -------------------------------------

CREATE TABLE IF NOT EXISTS clusterizacao_tos (
  soc                text NOT NULL REFERENCES socs(soc),
  to_number          text NOT NULL,
  destino            text,
  current_station    text,
  to_pack            text,
  origem             text,
  classificacao      text,
  quantity           numeric,
  aging              numeric,
  stage              text,               -- ENDEREÇADO | PENDENTE
  rua                text,
  complete_time      timestamptz,
  atualizado_em      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (soc, to_number)
);
CREATE INDEX IF NOT EXISTS ix_clusterizacao_tos_soc_rua ON clusterizacao_tos (soc, rua);

-- --- Outbound (api/outbound.js) — dados base da viagem -------------------
-- (outbound_monitor/outbound_monitor_tags, que são o Monitor Outbound Live,
-- ficaram de fora — Pulse.)

CREATE TABLE IF NOT EXISTS outbound_dados (
  soc                     text NOT NULL REFERENCES socs(soc),
  lh_trips                text NOT NULL,
  cutoff                  date,
  status_agrupado         text,
  solicitation_by         text,
  turno_shipped           text,
  compartilhado           boolean,
  origin                  text,
  destino                 text,
  used_vehicle            text,
  used_agency_name        text,
  cpt_planejado           timestamptz,
  cpt_realizado           timestamptz,
  orders_saca             numeric,
  orders_scuttle          numeric,
  to_saca                 numeric,
  to_scuttle              numeric,
  eta_planejado           timestamptz,
  eta_realizado           timestamptz,
  status_eta              text,
  fim_descarga            timestamptz,
  atualizado_em           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (soc, lh_trips)
);

-- --- Leftover / SPR (api/leftover.js, api/spr.js) -----------------------

CREATE TABLE IF NOT EXISTS leftover_dados (
  id                          bigserial PRIMARY KEY,
  soc                         text NOT NULL REFERENCES socs(soc),
  data                        date NOT NULL,
  hub                         text,
  transportadora              text,
  type_cpt                    text,
  turno                       text,
  hora                        smallint,
  cpt_planejado               timestamptz,
  leftover_until_cap          numeric,
  leftover_causa_l1           text,
  leftover_causa_l2           text,
  expedido                    numeric,
  backlog_2hrs_cpt            numeric,
  observacao                  text,
  criado_em                   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_leftover_soc_data ON leftover_dados (soc, data, hora);

CREATE TABLE IF NOT EXISTS spr_dados (
  soc                        text NOT NULL REFERENCES socs(soc),
  trip_number                text NOT NULL,
  status_agrupado            text,
  solicitation_by            text,
  origin_station_code        text,
  destination_station_code   text,
  total_orders               numeric,
  used_vehicle                text,
  used_agency_name            text,
  turno                       text,
  cpt_scheduled_origin_edited timestamptz,
  to_scuttle                  numeric,
  to_saca                     numeric,
  atualizado_em                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (soc, trip_number)
);

-- --- Labor / Justificativas (api/overview.js, mapLaborRow) --------------

CREATE TABLE IF NOT EXISTS labor_dados (
  soc                     text NOT NULL REFERENCES socs(soc),
  data                    date NOT NULL,
  hora                    smallint NOT NULL,
  asm_target              numeric,
  asm_zonas               numeric,
  esteira_termo           numeric,
  esteira_a               numeric,
  esteira_b               numeric,
  nv1                     numeric,
  nv2                     numeric,
  nv3                     numeric,
  packing_esteira         numeric,
  packing_volumoso        numeric,
  target_esteira_a        numeric,
  target_esteira_b        numeric,
  target_termo            numeric,
  just_reason_asm         text,
  just_gap_asm            numeric,
  just_reason_esteira_a   text,
  just_gap_esteira_a      numeric,
  just_reason_esteira_b   text,
  just_gap_esteira_b      numeric,
  just_reason_termo       text,
  just_gap_termo          numeric,
  atualizado_em           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (soc, data, hora)
);

-- Justificativas por hora/área (retroalimentação do front — motivo/status
-- registrado manualmente).
CREATE TABLE IF NOT EXISTS justificativas_horas (
  soc         text NOT NULL REFERENCES socs(soc),
  data        date NOT NULL,
  hora        smallint NOT NULL,
  area        text NOT NULL,          -- ASM | Conveyor A | Conveyor B | Termo
  meta        numeric,
  realizado   numeric,
  perda       numeric,
  motivo      text,                   -- Falta de HC | Equipamento | Falta de Material | Processo | Outros
  status      text,                   -- OK | Justificada | Pendente
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (soc, data, hora, area)
);

-- --- Árvore de Indicadores — valores diários/semanais (fato/input) ------
-- Separado do cadastro (de_para_arvore_kpis acima). PK por (soc, kpi,
-- período) porque "valores" hoje é um dict {data_ou_semana: valor} por KPI.
CREATE TABLE IF NOT EXISTS arvore_valores (
  soc              text NOT NULL REFERENCES socs(soc),
  kpi_id           text NOT NULL,
  periodo          text NOT NULL,     -- data ISO ou label de semana, conforme granularidade do KPI
  valor            numeric,
  observacao       text,
  atualizado_em    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (soc, kpi_id, periodo),
  FOREIGN KEY (soc, kpi_id) REFERENCES de_para_arvore_kpis (soc, kpi_id)
);


-- ============================================================================
-- 4. CONTEÚDO/CRUD — Kanban de Demandas, Mapa de Dados, Jornal (pedido do
--    Roberto em 2026-09-16). Diferente das seções acima: não é de-para nem
--    fato/snapshot — é conteúdo direto, 1 linha = 1 item. Ver
--    db/migracao_kanban_mapadados_jornal.sql para o DDL completo (Kanban
--    normalizado em 3 tabelas, Mapa de Dados 1 tabela, Jornal em 4 —
--    edições com PDF em bytea, aniversariantes/avisos/campanhas). Todas
--    com soc.
-- ============================================================================
