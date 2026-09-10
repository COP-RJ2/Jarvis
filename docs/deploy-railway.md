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
