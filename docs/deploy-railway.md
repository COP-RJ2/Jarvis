# Deploy no Railway

Migração da Vercel pro Railway (2026-09-10) — a Vercel pausou o projeto no
plano Hobby por estourar o limite de Fluid Active CPU. O Railway roda o site
como um processo Node contínuo (`server.js`) em vez de functions avulsas por
arquivo, então não tem esse teto de CPU por invocação.

Nada na lógica de negócio mudou — `api/*.js` continua exatamente igual. O que
foi adicionado: `server.js` (monta cada `api/<nome>.js` como rota Express e
serve o resto do repositório como estático) e `package.json` (só dependência:
`express`). Testado localmente antes de subir — servidor sobe, rotas
estáticas (`index.html`, `arvore.html`, `olho-de-deus/`) e de API respondem.

## Passo a passo (dashboard do Railway — só você tem login)

1. **railway.app → New Project → Deploy from GitHub repo** → escolher o repo
   `robertobarboza-sudo/EZRA`, branch `main`. O Railway detecta Node
   automaticamente (via `package.json`) e roda `npm start`.
2. **Variables** (aba do serviço) — adicionar as 2 variáveis que o backend
   precisa pra falar com a planilha:
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `GOOGLE_PRIVATE_KEY` (o PEM inteiro, com `-----BEGIN PRIVATE KEY-----`)

   Estão hoje em **Vercel → Settings → Environment Variables** do projeto —
   copia os mesmos valores de lá, não precisa gerar credencial nova.
3. **Settings → Networking → Generate Domain** — gera uma URL pública
   `*.up.railway.app` (ou aponta um domínio próprio, se preferir).
4. Deploy automático já dispara nesse primeiro setup. Depois disso, todo
   `git push` na `main` reimplanta sozinho — mesmo fluxo que já existia com a
   Vercel.

## Diferenças que valem saber

- **Sem `maxDuration`**: a Vercel limitava `api/overview.js` a 60s
  (`vercel.json`). Servidor contínuo não tem esse teto — pode remover essa
  preocupação, mas o arquivo `vercel.json` foi deixado no repo (inofensivo,
  o Railway ignora).
- **Cold start**: Vercel functions "dormem" entre chamadas; um servidor
  Railway fica sempre de pé — primeira resposta depois de inatividade tende a
  ser mais rápida, não mais lenta.
- **Cache de resposta**: os headers `Cache-Control: s-maxage=...` que o
  backend já manda continuam funcionando do jeito que o navegador/qualquer
  CDN na frente entender — não dependem da Vercel especificamente.

## Rodar localmente (checagem antes de cada deploy, se quiser)

```bash
npm install
GOOGLE_SERVICE_ACCOUNT_EMAIL=... GOOGLE_PRIVATE_KEY=... npm start
```

Abre em `http://localhost:3000`.

## Postgres + sync da dimensão histórica (2026-09-11)

As 10 abas marcadas `FLAG=SQL` na aba `readme` (dimensão histórica — SPR,
Leftover Hub, Rawdata Out, Balanceamento, Forecast/Backlog, Inbound LH,
Triagem, Performance, ASM, Inbound FM) passam a alimentar um Postgres, em vez
de serem lidas direto da planilha a cada request. As abas `PYTHON` (on time)
e `INPUT` (manuais) continuam lendo a planilha direto, sem mudança.

### 1. Criar o Postgres no Railway

No mesmo projeto: **New → Database → Add PostgreSQL**. O Railway injeta
`DATABASE_URL` automaticamente em todos os serviços do projeto — não precisa
copiar/colar a string de conexão em lugar nenhum.

### 2. Rodar o sync uma vez, manual, pra validar

Com `DATABASE_URL` já disponível (se estiver rodando local, copia o valor de
**Postgres → Variables → DATABASE_URL** no Railway pra sua env local):

```bash
npm run sync:historico
```

Cria sozinho as 10 tabelas (`hist_spr`, `hist_leftover_hub`, `hist_rawdata_out`,
`hist_balanceamento`, `hist_forecast_backlog`, `hist_inbound_lh`,
`hist_triagem`, `hist_performance`, `hist_asm`, `hist_inbound_fm`) mais uma
`sync_log` com o histórico de execuções — e popula tudo na primeira rodada.

Cada linha da planilha vira 1 registro `jsonb` (coluna `data`) — sem schema
fixo por coluna de propósito, já que as 10 abas têm formatos diferentes entre
si e mudam com frequência. Pra consultar: `SELECT data->>'total' FROM
hist_forecast_backlog WHERE data->>'origin_type' = 'CB';` (Postgres já sabe
indexar/filtrar JSONB nativamente).

Cada sync faz **full refresh** (apaga e reinsere tudo) dentro de uma
transação — não é incremental. Certo pra esse caso porque o Data Suite já
reescreve a origem em lote; errado seria tentar fazer upsert por chave numa
aba que às vezes muda de estrutura.

### 3. Agendar a sincronização recorrente

**New → Empty Service** (ou duplica o serviço web) → aponta pro mesmo repo →
em **Settings → Deploy**, troca o **Start Command** pra:

```
npm run sync:historico
```

E em **Settings → Cron Schedule**, define a frequência (ex.: `*/30 * * * *`
pra cada 30 minutos — ajusta conforme a cadência real que o Data Suite
atualiza a planilha, não faz sentido sincronizar mais rápido que a fonte
muda). O Railway então roda esse comando, deixa terminar, e desliga até a
próxima janela — não fica um processo vivo consumindo recurso à toa.
