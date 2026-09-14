/**
 * Hash de senha — crypto.scrypt (stdlib do Node, sem bcrypt/argon2). Portado
 * do Sentinela CCO (pedido do Roberto em 2026-09-14: mesmo padrão de login
 * por e-mail/senha real, validado no servidor contra o Postgres).
 */
"use strict";
const crypto = require("crypto");

function hashPassword(senha) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(senha, salt, 64).toString("hex");
  return { hash, salt };
}

function verifyPassword(senha, hash, salt) {
  if (!hash || !salt) return false;
  const tentativa = crypto.scryptSync(senha, salt, 64);
  const esperado = Buffer.from(hash, "hex");
  if (tentativa.length !== esperado.length) return false;
  return crypto.timingSafeEqual(tentativa, esperado);
}

module.exports = { hashPassword, verifyPassword };
