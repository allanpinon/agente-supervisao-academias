// Resolve marca/unidade a partir das tags de um contato, usando o
// mapeamento confirmado em src/config.js (tagMap).
const { config } = require('../config');

// `tagsId` deve ser o array `contactDetails.tagsId` vindo da sessao
// (ou do contato). Retorna { marca, unidade } — unidade pode ficar
// undefined se so a tag de marca estiver presente (sem tag de unidade).
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

module.exports = { resolveMarcaUnidade };
