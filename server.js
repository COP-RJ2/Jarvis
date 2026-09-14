/**
 * JARVIS — servidor Express pra Railway (migrado da Vercel em 2026-09-10,
 * pedido do Roberto: o plano Hobby da Vercel pausou o site por estourar o
 * limite de Fluid Active CPU).
 *
 * A Vercel roda cada arquivo em api/*.js como uma serverless function
 * isolada (1 arquivo = 1 rota, descoberta automática por nome de arquivo).
 * O Railway não tem esse modelo — ele espera um processo Node contínuo.
 * Como todo handler em api/*.js já é zero-dependency e usa a assinatura
 * padrão `(req, res) => {...}` com só req.query/req.body/req.method e
 * res.status()/res.setHeader() (100% compatível com Express, que só
 * estende o req/res nativo do Node), a migração é montar cada arquivo
 * como uma rota Express — sem reescrever nenhuma linha de lógica de
 * negócio dentro de api/*.js.
 *
 * Arquivos com "_" no início (api/_google.js, api/_period.js, ...) são
 * módulos auxiliares, não rotas — mesma convenção que já existia na
 * Vercel (ver comentário em api/overview.js).
 */
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

const app = express();
app.use(express.json());

// --- Sessão (pedido do Roberto em 2026-09-14, verificação em 2 etapas via
//     SeaTalk): guardada no Postgres em vez de memória — o Railway
//     reimplanta a cada push, e com MemoryStore isso deslogaria todo mundo
//     a cada deploy (nesse projeto, deploy é praticamente todo dia). ---
app.use(session({
  store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'jarvis-dev-secret-troque-em-producao',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' }, // 30 dias
}));

// --- Rotas da API: cada api/<nome>.js (exceto os que começam com "_")
//     vira /api/<nome>, montado pro método HTTP que o handler já trata
//     internamente (a maioria despacha por req.method/req.query dentro
//     do próprio arquivo, igual já fazia na Vercel). ---
const API_DIR = path.join(__dirname, 'api');
fs.readdirSync(API_DIR)
  .filter(f => f.endsWith('.js') && !f.startsWith('_'))
  .forEach(f => {
    const nome = f.replace(/\.js$/, '');
    const handler = require(path.join(API_DIR, f));
    // /api/auth é quem CRIA a sessão (não pode exigir uma antes de existir).
    // /api/ingest é chamado por script externo (Data Suite/Python), não por
    // navegador — tem autenticação própria por token (INGEST_API_KEY), não
    // por sessão de login (ver api/ingest.js).
    const SEM_GATE_DE_SESSAO = new Set(['auth', 'ingest']);
    app.all(`/api/${nome}`, (req, res, next) => {
      if (!SEM_GATE_DE_SESSAO.has(nome) && !req.session.user) {
        res.status(401).json({ ok: false, erro: 'Não autenticado.' });
        return;
      }
      Promise.resolve(handler(req, res)).catch(err => {
        console.error(`[api/${nome}]`, err);
        if (!res.headersSent) res.status(500).json({ ok: false, erro: err.message });
      });
    });
  });

// --- Front estático: index.html, arvore.html, checkpoints/, olho-de-deus/,
//     jornais/, informativos/, assets/ — tudo que já vivia na raiz do repo
//     e a Vercel servia como estático por padrão. O HTML em si continua
//     público (é só a casca da SPA, sem dado nenhum embutido) — quem
//     protege de verdade são as rotas /api/* acima. ---
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`JARVIS no ar em http://localhost:${PORT}`);
});
