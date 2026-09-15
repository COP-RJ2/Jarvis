/**
 * Identidade de quem loga no JARVIS (pedido do Roberto em 2026-09-14, parte
 * da verificação em 2 etapas via SeaTalk): 1º fator deixou de ser uma lista
 * fixa de e-mails com senha — agora é "qualquer e-mail do domínio
 * corporativo", então não faz sentido manter ~70 linhas hardcoded só pra
 * nome/perfil. Nome vem do próprio e-mail (mesmo padrão "nome.sobrenome" já
 * usado em toda a base).
 *
 * Papel (pedido do Roberto em 2026-09-15): não existe mais distinção de
 * papel por login — todo mundo que entra (já filtrado por domínio
 * corporativo acima) recebe o mesmo acesso completo. O controle de verdade
 * passou a ser só quem tem acesso ao repositório no GitHub (quem pode
 * mudar o código), não mais um "Demo" restrito dentro do próprio app.
 */
const DOMINIOS_PERMITIDOS = ['@shopee.com', '@shopeemobile-external.com'];

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
    role: 'Administrador',
  };
}

module.exports = { emailPermitido, nomeDoEmail, usuarioDoEmail, DOMINIOS_PERMITIDOS };
