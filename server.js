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
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

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
    app.all(`/api/${nome}`, (req, res) => {
      Promise.resolve(handler(req, res)).catch(err => {
        console.error(`[api/${nome}]`, err);
        if (!res.headersSent) res.status(500).json({ ok: false, erro: err.message });
      });
    });
  });

// --- Front estático: index.html, arvore.html, checkpoints/, olho-de-deus/,
//     jornais/, informativos/, assets/ — tudo que já vivia na raiz do repo
//     e a Vercel servia como estático por padrão. ---
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`JARVIS no ar em http://localhost:${PORT}`);
});
