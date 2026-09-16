# Prompt — Design do Schema Postgres Multi-SoC do JARVIS

> Cole este documento inteiro como prompt para um cientista de dados / arquiteto de banco de dados (humano ou IA) especializado em modelagem de dados operacionais e Postgres. Ele contém todo o contexto necessário para propor o schema sem precisar de mais perguntas de esclarecimento sobre o que já existe.

---

## Seu papel

Você é um **cientista de dados especialista em banco de dados**, com foco em modelagem de dados operacionais/logísticos multi-tenant em Postgres. Sua entrega é um **desenho de schema completo** (não é pra escrever código de aplicação, só o modelo de dados: DDL, convenções, índices, plano de migração). Você tem carta branca para propor a estrutura tecnicamente mais correta, mas precisa justificar decisões que fujam do padrão já estabelecido no projeto (descrito abaixo).

## Contexto do projeto

**JARVIS** é o dashboard operacional interno do COP (Centro de Operações) da Shopee, hoje operando o **SoC RJ2** (um centro de distribuição). Está em Node.js + Express, hospedado no Railway, com Postgres já anexado (`db.js` expõe um `pool` do pacote `pg`). O frontend é um único `index.html` (~12 mil linhas) que consome APIs internas (`/api/*`).

### Como os dados funcionam hoje (antes desta mudança)

A quase totalidade dos dados operacionais vem de **uma única planilha Google Sheets** (`spreadsheetId` fixo), com **uma aba por domínio de dado**, lida por `gid` via `api/_google.js` (`fetchTabByGid`). Cada página do JARVIS tem um `api/<pagina>.js` que:
1. Busca 1+ abas da planilha (a aba principal +, às vezes, abas auxiliares).
2. Agrega/filtra em memória a cada request (sem cache de banco).
3. Devolve JSON pro front.

**Domínios de dado existentes hoje** (cada um = 1 aba/gid na planilha, todos hoje implicitamente só RJ2):

| Página/domínio | Arquivo | Aba(s) principal(is) |
|---|---|---|
| Backlog | `api/backlog.js` | `forecast_backlog_pulso` (colunas A-G) |
| Forecast | `api/forecast.js` | mesma aba do Backlog (colunas H-M — tabela irmã, não relacionada linha a linha) |
| ASM | `api/asm.js` | `asm_pulso` + `asm_pulso` (rejeito) + `asm_extra` + `chutes` |
| Conveyor | `api/conveyor.js` | aba própria + `labor_pulso` + `cluster_pulso` |
| Inbound Line Haul | `api/inbound-lh.js` | aba própria + fila |
| Inbound First Mile | `api/inbound-fm.js` | aba própria + fmbeep |
| Clusterização | `api/cluster.js` | `cluster_pulso` (TOs) + `config` (de-para de rua) + `balanceamento_pulso` |
| Outbound | `api/outbound.js` | aba própria + monitor + `cluster_pulso` + `config` |
| Leftover / SPR | `api/leftover.js`, `api/spr.js` | abas próprias |
| Labor Plan | `api/overview.js?laborplan=1` | `config` (colunas Q-AC, premissas PHD/POR_WS/ATRELAMENTO) + `labor_pulso` + `asm_pulso` + inbound LH/FM |
| Justificativas | `api/overview.js?justificativas=1` | aba própria |
| Árvore de Indicadores | `api/_arvore.js` | aba própria |
| Kanban de Demandas | `api/overview.js?kanban=1` | abas `kanban_donos_input` / `kanban_demandas_input` (já CRUD, não é fonte externa) |
| Mapa de Dados | `api/overview.js?datamap=1` | aba `mapa_dados_input` (catálogo de queries/scripts do time de dados — **não é operacional, não precisa ser multi-SoC**) |

**Aba `config` (de-para compartilhado)**: uma aba central (colunas A-J e Q-AC usadas por finalidades diferentes) com:
- De-para `staging area id → staging area name (rua)` + `capacity` por rua (usado por Clusterização/Outbound).
- Coluna `cluster` (destino esperado por rua, pra validar clusterização correta).
- Colunas Q-AC: premissas de mão de obra por processo (`processo, macro, phd, por_ws, posição_fixa, atrelamento, descrição`), usadas pelo Labor Plan.

Essa aba é **hoje única e implicitamente RJ2** — não tem coluna de origem/SoC nenhuma.

### O que já existe em Postgres (não confundir com o trabalho novo)

- `user_sessions` (via `connect-pg-simple`) — sessão de login, não mexer.
- `auth_codes` — código de 2FA por e-mail, TTL curto, não mexer.
- `work_locations` (`email text PK, nome text, work_location text, atualizado_em timestamptz`) — de-para manual e-mail → work location, criado como fallback enquanto a permissão de API da SeaTalk não é aprovada. **Esse é o dado que vai decidir quem vê qual SoC** — ver seção de controle de acesso abaixo.
- `ontime_dados` (`fonte text, chave text, data jsonb, atualizado_em timestamptz`, PK `(fonte, chave)`) — tabela genérica já usada pra receber dados de scripts Python via `api/ingest.js` (upsert por fonte+chave, payload solto em JSONB). **Isso é o padrão antigo/genérico que queremos EVITAR pro trabalho novo** — o pedido explícito é "uma tabela para cada página", com colunas tipadas, não um blob JSONB por domínio.

## O pedido (o que você precisa desenhar)

1. **Vamos incluir mais 2 SoCs no JARVIS** (além do RJ2 atual) — o app precisa deixar de ser implicitamente single-tenant.
2. **Toda página que hoje lê da planilha via SQL/Postgres** (migração deste desenho) passa a ter **uma tabela própria no Postgres**, tipada (colunas reais, não JSONB genérico), uma tabela por domínio/página (mesma lista da tabela acima).
3. **Uma única tabela por domínio cobre todos os SoCs** — não é "uma tabela por SoC por domínio". Em vez disso, toda tabela de fato (fact table) ganha uma **coluna de origem** (`soc` ou `soc_id`) que identifica de qual SoC aquela linha veio. Isso deve ser parte da chave/índice principal (junto com o identificador natural do domínio — ex. `to_number` na Clusterização, `chave` de backlog etc.).
4. **As tabelas de-para (config/dimensão) também precisam ser multi-SoC.** Hoje a aba `config` é única e implicitamente RJ2 (de-para de rua/capacidade, premissas de labor plan). Cada novo SoC vai ter o **próprio de-para** (ruas diferentes, capacidades diferentes, processos/PHD diferentes) — ou seja, essas também precisam da coluna de origem/SoC, não é um valor fixo global.
5. **Controle de acesso por work location (fase futura, mas o schema precisa já suportar)**: quando a API de "Get Contact Profile" da SeaTalk for aprovada (ou via o fallback manual da tabela `work_locations`), o usuário logado vai ter um `work_location`. Isso precisa mapear pra um ou mais `soc` — ou seja, é necessário uma **tabela dimensão de SoC** e possivelmente um de-para `work_location → soc` (pode não ser 1:1; uma work location pode, em teoria, servir múltiplos SoCs ou vice-versa — desenhe pensando nessa flexibilidade). O objetivo final (fora do escopo desta entrega, mas o schema tem que viabilizar sem redesenho): um usuário só vê, nas consultas, os dados cujo `soc` bate com o(s) SoC(s) da work location dele.

## O que você precisa entregar (formato)

Devolva **um único arquivo Markdown**, estruturado assim:

1. **Modelo de dados (visão geral)** — um diagrama (pode ser Mermaid ER diagram em bloco de código, ou uma lista hierárquica clara) mostrando: tabela dimensão `soc`, tabela `work_locations` (já existe — como ela se conecta), as fact tables por domínio, e as tabelas de-para/config por SoC.
2. **Convenções de nomenclatura** — proponha um padrão consistente (nomes de tabela, nomes de coluna, tudo em português como o resto do projeto já usa nas colunas das planilhas, ex. `qtd_pacotes`, `aging_medio_min`) e aplique o MESMO padrão em toda tabela nova. Justifique se decidir usar algo diferente do que já existe (`work_locations`, `auth_codes`, `ontime_dados`).
3. **DDL completo** (`CREATE TABLE ...`) para:
   - A tabela dimensão de SoC (`socs`, ou nome que você propuser) — código curto, nome, ativo/inativo, etc.
   - Cada fact table por domínio da lista acima (pode agrupar domínios muito parecidos numa única tabela se fizer sentido tecnicamente — mas justifique cada agrupamento).
   - As tabelas de-para/config multi-SoC (o equivalente da aba `config` de hoje, agora com coluna de origem).
   - Qualquer tabela de relacionamento necessária pra `work_location → soc`.
4. **Estratégia de índices** — a maioria das queries hoje filtra por período/data + dimensões (rua, destino, hora, perfil, etc.) *dentro* de um SoC. Proponha os índices (compostos, parciais, etc.) pensando nesse padrão de acesso, com `soc` como primeiro critério de filtro na maioria dos casos.
5. **Estratégia de migração/carga** — os dados hoje chegam de duas formas: (a) planilha Google Sheets lida ao vivo a cada request (maioria das páginas), (b) ingest direto via `POST /api/ingest` por scripts Python (dimensão ON TIME, tabela genérica `ontime_dados`). Proponha como cada uma dessas fontes passa a alimentar as tabelas tipadas novas — não precisa escrever o código de ingest, só o plano (ex.: upsert por chave natural + soc, truncate+insert vs upsert incremental por domínio, etc.).
6. **Plano de rollout faseado** — sugira uma ordem de migração (ex.: começar pelas páginas mais lidas ou mais simples, manter fallback pra planilha durante a transição, como não quebrar o RJ2 atual enquanto os outros 2 SoCs são adicionados).
7. **Riscos/pontos em aberto** — qualquer decisão que dependa de informação que você não tem (ex.: os 2 novos SoCs vão ter exatamente as mesmas colunas/processos que o RJ2, ou estruturas diferentes? isso muda bastante o desenho das tabelas de-para) — liste como perguntas explícitas em vez de assumir.

## Restrições e coisas para não esquecer

- **Não escreva código de aplicação** (nada de `api/*.js`, nada de front-end) — só o schema, DDL, e os planos descritos acima, em Markdown.
- **Mantenha compatibilidade com o que já existe em Postgres** (`user_sessions`, `auth_codes`, `work_locations`) — não redesenhe essas três, só integre o novo schema com elas onde fizer sentido (principalmente `work_locations`).
- **Não decida sozinho a lista final de SoCs nem os nomes deles** — trate como parâmetro (`RJ2`, `SOC_2`, `SOC_3` como placeholders) até serem informados.
- Points that ainda não têm resposta definitiva (ex. regra de acesso por work location, se um de-para pode ser compartilhado entre SoCs) devem virar perguntas explícitas na seção de riscos, não suposições silenciosas.

---

## Atualização (2026-09-16, pós-entrega inicial)

O schema desta seção já foi implementado (ver `db/schema_multi_soc.sql`) e aplicado no Postgres de produção. Decisões adicionais fechadas depois da 1ª rodada, registradas aqui pra não se perder:

- **Fonte dos dados SQL**: **1 única planilha Google Sheets pra todos os SoCs** (não uma planilha por SoC). Cada linha, em cada aba que alimenta o ingest, carrega a chave do SoC de origem numa coluna própria — o job de ingest lê essa coluna e grava direto no campo `soc` da tabela correspondente.
- **Fontes "ontime"** (ASM ao vivo, Sorting Exception, Sorter, Conveyor, Monitor Fila, Monitor Outbound Live) ficam de fora deste schema — são alimentadas ao vivo pelos projetos **Pulse** (serviços Python separados por SoC: Pulse RJ2, Pulse RJ1/RJ6, Pulse SC2), consumidos direto pelo front, não via este Postgres.
- **Tabelas de-para** usam o prefixo `de_para_<nome>` (não `config_`) pra ficarem identificáveis: `de_para_ruas`, `de_para_labor_processos`, `de_para_arvore_kpis`, `de_para_work_locations` (essa última é o rename da tabela `work_locations` que já existia, usada pelo login).
- **Auditoria genérica**: `de_para_auditoria` (1 tabela só pra toda mudança em qualquer de_para_*, campos: tabela/soc/chave/campo/valor_antigo/valor_novo/usuario_email/alterado_em).
- **SoCs cadastrados**: `SOC-RJ2`, `SOC-RJ6`, `SOC-SC1` (tabela `socs`).
- **UI de "sem dado" por SoC**: quando um SoC não tiver dado pra um schema/página (ex.: um SoC que não roda Esteira Termo), reaproveitar o padrão já existente no front — classe `.nav-item-locked` + badge "Em Construção" (mesmo usado hoje em Performance/Score Card/Live SoC) — não criar componente novo. Só será ligado de fato quando o front passar a consumir o Postgres por SoC (Dia D).
