-- Kanban de Demandas, Mapa de Dados e Jornal — schema multi-SoC (pedido do
-- Roberto em 2026-09-16). Rodar na tela Data/Query do Postgres (Railway).
--
-- ESTADO: só a estrutura. As APIs (api/overview.js) e o front continuam
-- usando Google Sheets / memória por enquanto — a troca de fonte é um passo
-- separado (mesmo padrão do resto do schema multi-SoC).

-- ============================================================================
-- KANBAN DE DEMANDAS — normalizado em 3 tabelas (hoje é 1 aba só no Sheets
-- com um campo "tipo" distinguindo dono/coluna/demanda; no Postgres cada
-- tipo vira tabela própria, mais simples de consultar).
-- ============================================================================

CREATE TABLE IF NOT EXISTS kanban_donos (
  soc          text NOT NULL REFERENCES socs(soc),
  id           text NOT NULL,
  nome         text NOT NULL,
  ordem        integer,
  cor          text,
  criado_em    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (soc, id)
);

CREATE TABLE IF NOT EXISTS kanban_colunas (
  soc     text NOT NULL REFERENCES socs(soc),
  status  text NOT NULL,   -- fila | atrasado | andamento | hold | finalizado
  cor     text,
  PRIMARY KEY (soc, status)
);

CREATE TABLE IF NOT EXISTS kanban_demandas (
  soc                text NOT NULL REFERENCES socs(soc),
  id                 text NOT NULL,
  titulo             text NOT NULL,
  descricao          text,
  dono               text,
  prioridade         text,          -- alta | media | baixa
  status             text NOT NULL, -- fila | andamento | hold | finalizado ("atrasado" é calculado no front, não gravado)
  data_solicitacao   date,
  data_entrega       date,
  data_conclusao     date,
  tag                text,          -- analise | sql | python | html | outros
  url                text,
  criado_em          timestamptz NOT NULL DEFAULT now(),
  atualizado_em      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (soc, id)
);


-- ============================================================================
-- MAPA DE DADOS — catálogo do time de dados (já é CRUD real hoje, só
-- migrando de aba pra tabela).
-- ============================================================================

CREATE TABLE IF NOT EXISTS mapa_dados_entradas (
  soc                text NOT NULL REFERENCES socs(soc),
  id                 text NOT NULL,
  tipo               text NOT NULL,   -- sql | py | html | link | sheet
  titulo             text NOT NULL,
  descricao_md       text,
  codigo             text,
  link               text,
  responsavel_email  text,
  criado_em          timestamptz NOT NULL DEFAULT now(),
  atualizado_em      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (soc, id)
);


-- ============================================================================
-- JORNAL — hoje é o mais frágil dos três: edições (PDF) vêm de um
-- manifest.json estático + arquivo no repositório (publicar = deploy);
-- Aniversariantes/Avisos/Campanhas são só JS em memória, perdem tudo no F5.
--
-- PDF guardado como bytea direto no Postgres (não em planilha — Sheets não
-- segura arquivo binário bem — nem em storage externo novo, pra não somar
-- mais uma peça de infra só pra isso). Proporcional ao volume real: jornal
-- semanal interno, não uma biblioteca de mídia pesada. Se um dia crescer
-- muito, revisitar com storage de objeto de verdade.
-- ============================================================================

CREATE TABLE IF NOT EXISTS jornal_edicoes (
  soc             text NOT NULL REFERENCES socs(soc),
  ano             integer NOT NULL,
  semana          text NOT NULL,        -- ex: 'W37'
  titulo          text,
  arquivo_pdf     bytea NOT NULL,
  arquivo_nome    text,                 -- nome original, pra download
  publicado_por   text,                 -- e-mail de quem publicou
  publicado_em    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (soc, ano, semana)
);

CREATE TABLE IF NOT EXISTS jornal_aniversariantes (
  id          bigserial PRIMARY KEY,
  soc         text NOT NULL REFERENCES socs(soc),
  nome        text NOT NULL,
  setor       text,
  data        date,
  foto_url    text,
  criado_em   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_jornal_aniversariantes_soc ON jornal_aniversariantes (soc);

CREATE TABLE IF NOT EXISTS jornal_avisos (
  id          bigserial PRIMARY KEY,
  soc         text NOT NULL REFERENCES socs(soc),
  icone       text,
  tipo        text,      -- info | success | warning | danger
  titulo      text NOT NULL,
  conteudo    text,
  criado_em   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_jornal_avisos_soc ON jornal_avisos (soc);

CREATE TABLE IF NOT EXISTS jornal_campanhas (
  id            bigserial PRIMARY KEY,
  soc           text NOT NULL REFERENCES socs(soc),
  titulo        text NOT NULL,
  descricao     text,
  imagem        bytea,
  imagem_tipo   text,      -- mime type, ex: image/png
  criado_em     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_jornal_campanhas_soc ON jornal_campanhas (soc);

-- Informativos — acervo AVULSO de pôsteres/avisos em imagem (não é edição
-- periódica, cada um é publicado quando surge a necessidade). Hoje também
-- é arquivo estático + informativos/manifest.json — mesmo problema do
-- Jornal Semanal (publicar = deploy). Campos conforme o texto de ajuda já
-- existente na tela: título, categoria, data e arquivo.
CREATE TABLE IF NOT EXISTS jornal_informativos (
  id            bigserial PRIMARY KEY,
  soc           text NOT NULL REFERENCES socs(soc),
  titulo        text NOT NULL,
  categoria     text,
  data          date,
  imagem        bytea NOT NULL,
  imagem_tipo   text,      -- mime type, ex: image/png
  imagem_nome   text,      -- nome original, pra download
  publicado_por text,
  criado_em     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_jornal_informativos_soc ON jornal_informativos (soc);

SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;
