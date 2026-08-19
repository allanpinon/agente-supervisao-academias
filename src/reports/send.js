// Orquestra a geracao e o envio de um relatorio (diario/semanal/mensal)
// para as duas marcas: varredura de reconciliacao -> calculo -> sintese
// qualitativa -> gravacao das sinteses -> formatacao -> envio no WhatsApp.
const { runReconciliationSweep } = require('../reconciliation/sweep');
const { computeReportData } = require('./compute');
const { synthesizeAttendants } = require('./synthesize');
const { formatReport } = require('./format');
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
  for (const { atendente, sintese } of sinteses) {
    // eslint-disable-next-line no-await-in-loop
    await sheets.appendRow('sinteses', {
      'Data do Período': dataPeriodo,
      'Tipo (Diário/Semanal/Mensal)': TIPO_LABELS[tipo],
      Marca: marca,
      Atendente: atendente,
      'Avaliação Geral': sintese.avaliacaoGeral,
      'Volume de Objeções': sintese.volumeObjecoes,
      'Pontos Fortes Consolidados': (sintese.pontosFortesConsolidados || []).join('; '),
      'Pontos Fracos Consolidados': (sintese.pontosFracosConsolidados || []).join('; '),
      'Sugestão de Melhoria': sintese.sugestaoMelhoria,
    });
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
      // eslint-disable-next-line no-await-in-loop
      const sinteses = await synthesizeAttendants(data.porAtendente, TIPO_LABELS[tipo]);
      // eslint-disable-next-line no-await-in-loop
      await gravarSinteses(marca, tipo, sinteses);
      const texto = formatReport({ marca, tipoLabel: TIPO_LABELS[tipo], dataLabel, data, sinteses });
      // eslint-disable-next-line no-await-in-loop
      await evolution.sendGroupMessage(marca, texto);
      logger.info(`[reports] Relatorio ${tipo} de ${marca} enviado com sucesso.`);
    } catch (err) {
      logger.error(`[reports] Erro ao gerar/enviar relatorio ${tipo} de ${marca}:`, err.message);
    }
  }
}

module.exports = { generateAndSendReports };
