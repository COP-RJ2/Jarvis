/**
 * Identidade de quem loga no JARVIS (pedido do Roberto em 2026-09-14, parte
 * da verificação em 2 etapas via SeaTalk): 1º fator deixou de ser uma lista
 * fixa de e-mails com senha — agora é "qualquer e-mail do domínio
 * corporativo", então não faz sentido manter ~70 linhas hardcoded só pra
 * nome/perfil. Nome vem do próprio e-mail (mesmo padrão "nome.sobrenome" já
 * usado em toda a base), e perfil é Administrador só pra quem está na lista
 * abaixo — todo o resto entra como Demo, igual já era o padrão de fato
 * antes (a lista antiga tinha 1 "admin" e todo o resto era Demo).
 */
const DOMINIOS_PERMITIDOS = ['@shopee.com', '@shopeemobile-external.com'];

const ADMIN_EMAILS = new Set([
  'roberto.barboza@shopee.com',
]);

function emailPermitido(email) {
  const e = String(email || '').trim().toLowerCase();
  return DOMINIOS_PERMITIDOS.some(d => e.endsWith(d));
}

// "roberto.barboza@shopee.com" -> "Roberto Barboza" (mesmo padrão nome.sobrenome
// de todo o resto da base de usuários).
function nomeDoEmail(email) {
  const local = String(email).split('@')[0];
  return local.split('.').filter(Boolean)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(' ') || local;
}

function usuarioDoEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  const nome = nomeDoEmail(e);
  const iniciais = nome.split(' ').filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join('');
  return {
    email: e,
    name: nome,
    initials: iniciais,
    role: ADMIN_EMAILS.has(e) ? 'Administrador' : 'Demo',
  };
}

module.exports = { emailPermitido, nomeDoEmail, usuarioDoEmail, DOMINIOS_PERMITIDOS };
