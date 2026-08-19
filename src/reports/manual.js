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

// Devolve a linha mais recente do manual para uma marca, ou null se ainda
// nao existir nenhuma versao. Sempre acrescentamos uma linha nova a cada
// atualizacao (nunca sobrescrevemos), entao a mais recente e a ultima da
// lista filtrada.
async function getLatestManual(marca) {
  const rows = await sheets.readAll('manual');
  const daMarca = rows.filter((r) => r.Marca === marca);
  if (!daMarca.length) return null;
  return daMarca[daMarca.length - 1];
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

  await sheets.appendRow('manual', {
    Data: nowLocal().toFormat('yyyy-MM-dd'),
    Marca: marca,
    'Versão do Manual': resultado.versaoManual,
    'Principais Mudanças': resultado.principaisMudancas,
    'Baseado em (N atendimentos convertidos)': convertidas.length,
    'Período Analisado': periodo,
  });

  logger.info(`[manual] Manual de boas praticas atualizado para ${marca} (baseado em ${convertidas.length} conversao(oes)).`);
  return resultado;
}

module.exports = { getLatestManual, updateManualDeBoasPraticas };
