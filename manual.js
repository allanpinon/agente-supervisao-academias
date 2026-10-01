// Mantem o "Manual de Boas Praticas" — um documento vivo por marca que
// consolida os padroes reais observados nos atendimentos que converteram.
// Roda uma vez por mes (junto do relatorio mensal, ver src/reports/send.js)
// e fecha o ciclo de aprendizado: o manual mais recente tambem e injetado
// como contexto extra em toda nova avaliacao de conversa (ver
// src/pipeline/evaluate.js), fazendo o padrao de avaliacao se calibrar
// com base em dado real de cada marca ao longo do tempo.
const sheets = require('../clients/sheets');
const claude = require('../clients/claude');
const { nowLocal } = require('../utils/dates');
const logger = require('../utils/logger');

// Cache em memoria por marca — o manual so muda uma vez por mes
// (updateManualDeBoasPraticas), entao nao faz sentido reler a planilha
// inteira a cada atendimento avaliado (isso estourava a cota de leitura
// do Google Sheets em avaliacoes em lote/importacao historica).
const cache = new Map();

// Devolve a linha mais recente do manual para uma marca, ou null se ainda
// nao existir nenhuma versao. So le a planilha na primeira vez que a
// marca e consultada nesta execucao — as chamadas seguintes usam o cache.
async function getLatestManual(marca) {
  if (cache.has(marca)) return cache.get(marca);

  const rows = await sheets.readAll('manual');
  const daMarca = rows.filter((r) => r.Marca === marca);
  const ultimo = daMarca.length ? daMarca[daMarca.length - 1] : null;

  // Preenche o cache para TODAS as marcas encontradas na planilha, ja que
  // fizemos a leitura completa mesmo assim — evita reler de novo para a
  // proxima marca dentro da mesma execucao.
  const marcas = [...new Set(rows.map((r) => r.Marca))];
  marcas.forEach((m) => {
    const rowsDaMarca = rows.filter((r) => r.Marca === m);
    cache.set(m, rowsDaMarca.length ? rowsDaMarca[rowsDaMarca.length - 1] : null);
  });
  if (!cache.has(marca)) cache.set(marca, ultimo);

  return cache.get(marca);
}

async function updateManualDeBoasPraticas(marca) {
  const avaliacoes = await sheets.readAll('avaliacoes');
  const convertidas = avaliacoes.filter((a) => a.Marca === marca && a.Resultado === 'Convertido');

  const anterior = await getLatestManual(marca);

  const resumoConversoes = convertidas
    .map((a, i) => `Atendimento ${i + 1} (${a.Atendente || 'atendente nao identificada'}): ` +
      `pontos fortes: ${a['Pontos Fortes']}, objecoes superadas: ${a['Objeções Identificadas']}`)
    .join('\n');

  const periodo = nowLocal().toFormat('MMMM yyyy');

  const resultado = await claude.updateManual({
    marca,
    manualAnterior: anterior ? anterior['Versão do Manual'] : null,
    resumoConversoes,
    periodo,
  });

  const novaLinha = {
    Data: nowLocal().toFormat('yyyy-MM-dd'),
    Marca: marca,
    'Versão do Manual': resultado.versaoManual,
    'Principais Mudanças': resultado.principaisMudancas,
    'Baseado em (N atendimentos convertidos)': convertidas.length,
    'Período Analisado': periodo,
  };
  await sheets.appendRow('manual', novaLinha);

  // Atualiza o cache imediatamente, para que a proxima avaliacao ja use a
  // versao nova sem precisar reler a planilha.
  cache.set(marca, novaLinha);

  logger.info(`[manual] Manual de boas praticas atualizado para ${marca} (baseado em ${convertidas.length} conversao(oes)).`);
  return resultado;
}

module.exports = { getLatestManual, updateManualDeBoasPraticas };
