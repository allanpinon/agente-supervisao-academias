// Orquestra a geracao e o envio de um relatorio (diario/semanal/mensal)
// para as duas marcas: varredura de reconciliacao -> calculo -> sintese
// qualitativa segmentada -> gravacao das sinteses -> formatacao -> envio
// no WhatsApp. No relatorio mensal, tambem atualiza o Manual de Boas
// Praticas de cada marca, depois de enviar o relatorio.
const { runReconciliationSweep } = require('../reconciliation/sweep');
const { computeReportData } = require('./compute');
const { synthesizeAttendants } = require('./synthesize');
const { formatReport } = require('./format');
const { getLatestManual, updateManualDeBoasPraticas } = require('./manual');
const sheets = require('../clients/sheets');
const evolution = require('../clients/evolution');
const { config } = require('../config');
const { nowLocal, todayRange, lastWeekRange, currentMonthRange } = require('../utils/dates');
const logger = require('../utils/logger');

const TIPO_LABELS = { diario: 'Diário', semanal: 'Semanal', mensal: 'Mensal' };

function periodoDeTipo(tipo) {
  if (tipo === 'semanal') return lastWeekRange();
  if (tipo === 'mensal') return currentMonthRange();
  return todayRange();
}

async function gravarSinteses(marca, tipo, sinteses) {
  const dataPeriodo = nowLocal().toFormat('yyyy-MM-dd');
  for (const { atendente, convertidos, naoConvertidos } of sinteses) {
    if (convertidos) {
      // eslint-disable-next-line no-await-in-loop
      await sheets.appendRow('sinteses', {
        'Data do Período': dataPeriodo,
        'Tipo (Diário/Semanal/Mensal)': TIPO_LABELS[tipo],
        Marca: marca,
        Atendente: atendente,
        'Avaliação Geral': convertidos.resumo,
        'Volume de Objeções': '—',
        'Pontos Fortes Consolidados': (convertidos.padroes || []).join('; '),
        'Pontos Fracos Consolidados': '',
        'Sugestão de Melhoria': convertidos.recomendacao,
        Resultado: 'Convertido',
      });
    }
    if (naoConvertidos) {
      // eslint-disable-next-line no-await-in-loop
      await sheets.appendRow('sinteses', {
        'Data do Período': dataPeriodo,
        'Tipo (Diário/Semanal/Mensal)': TIPO_LABELS[tipo],
        Marca: marca,
        Atendente: atendente,
        'Avaliação Geral': naoConvertidos.resumo,
        'Volume de Objeções': '',
        'Pontos Fortes Consolidados': '',
        'Pontos Fracos Consolidados': (naoConvertidos.padroes || []).join('; '),
        'Sugestão de Melhoria': naoConvertidos.recomendacao,
        Resultado: 'Não convertido',
      });
    }
  }
}

async function generateAndSendReports(tipo) {
  logger.info(`[reports] Iniciando geracao do relatorio ${tipo}...`);
  await runReconciliationSweep();

  const periodo = periodoDeTipo(tipo);
  const dataLabel = nowLocal().toFormat('dd/MM/yyyy');

  for (const marca of config.marcas) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const data = await computeReportData(marca, periodo);

      // O relatorio semanal e o mensal usam o Manual de Boas Praticas
      // atual como referencia na analise qualitativa — o diario fica mais
      // enxuto/operacional, sem essa camada extra.
      let manualContext = null;
      if (tipo === 'semanal' || tipo === 'mensal') {
        // eslint-disable-next-line no-await-in-loop
        const manual = await getLatestManual(marca);
        manualContext = manual ? manual['Versão do Manual'] : null;
      }

      // eslint-disable-next-line no-await-in-loop
      const sinteses = await synthesizeAttendants(data.porAtendente, TIPO_LABELS[tipo], manualContext);
      // eslint-disable-next-line no-await-in-loop
      await gravarSinteses(marca, tipo, sinteses);
      const texto = formatReport({ marca, tipoLabel: TIPO_LABELS[tipo], dataLabel, data, sinteses });
      // eslint-disable-next-line no-await-in-loop
      await evolution.sendGroupMessage(marca, texto);
      logger.info(`[reports] Relatorio ${tipo} de ${marca} enviado com sucesso.`);

      if (tipo === 'mensal') {
        try {
          // eslint-disable-next-line no-await-in-loop
          await updateManualDeBoasPraticas(marca);
        } catch (err) {
          logger.error(`[reports] Erro ao atualizar Manual de Boas Praticas de ${marca}:`, err.message);
        }
      }
    } catch (err) {
      logger.error(`[reports] Erro ao gerar/enviar relatorio ${tipo} de ${marca}:`, err.message);
    }
  }
}

module.exports = { generateAndSendReports };
