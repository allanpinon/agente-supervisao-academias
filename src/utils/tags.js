// Resolve marca/unidade a partir das tags de um contato, usando o
// mapeamento confirmado em src/config.js (tagMap).
const { config } = require('../config');

// BUG REAL ENCONTRADO E CORRIGIDO (22/08/2026): o payload do WEBHOOK
// (contato/sessao) traz a lista de tags no campo `tagsId` — mas a resposta
// da API REST `GET /core/v1/contact/{id}` (usada por
// flwchat.ensureContactDetails sempre que o dado do webhook nao basta) usa
// um nome DIFERENTE pro MESMO dado: `tagIds` (sem "s" antes de "Id").
// Confirmado com dado real via scripts/inspect-session-by-id.js: a
// resposta de getContact tinha `tagIds: [...]` populado corretamente, mas
// todo o codigo (aqui e em cada chamador) sempre lia `contactDetails.tagsId`
// — que para uma resposta vinda dessa API e SEMPRE undefined. Resultado:
// toda vez que o enriquecimento via API REST era necessario (a maioria dos
// casos, especialmente depois da correcao de hasUsableContactDetails em
// src/clients/flwchat.js), Marca/Unidade nunca resolviam, mesmo com a tag
// certa disponivel na resposta da API. Esta funcao agora aceita os dois
// nomes possiveis, entao funciona tanto com dado vindo do webhook quanto
// da API REST.
function extractTagsId(contactLike) {
  return contactLike?.tagsId || contactLike?.tagIds || [];
}

// `tagsId` deve ser o array de tags (ja normalizado — ver extractTagsId
// acima) vindo da sessao ou do contato. Retorna { marca, unidade } —
// unidade pode ficar undefined se so a tag de marca estiver presente (sem
// tag de unidade).
function resolveMarcaUnidade(tagsId = []) {
  let marca;
  let unidade;
  for (const tagId of tagsId) {
    const info = config.tagMap[tagId];
    if (!info) continue;
    if (info.tipo === 'unidade') {
      marca = info.marca;
      unidade = info.unidade;
    } else if (info.tipo === 'marca' && !marca) {
      marca = info.marca;
    }
  }
  return { marca, unidade };
}

module.exports = { resolveMarcaUnidade, extractTagsId };
