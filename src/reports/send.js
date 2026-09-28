// Orquestra a geracao e o envio de um relatorio (diario/semanal/mensal)
// para as duas marcas: varredura de reconciliacao -> calculo -> formatacao
// -> envio no WhatsApp.
//
// CORTE DO QUALITATIVO (28/09/2026): decisao explicita do usuario apos 2
// semanas em producao. Removidos deste arquivo: sintese por atendente via
// Claude (synthesizeAttendants), gravacao da aba Sínteses (gravarSinteses)
// e a atualizacao mensal do Manual de Boas Praticas (tambem via Claude,
// dependia de Avaliações). O relatorio mensal agora e identico ao diario/
// semanal, so muda o periodo — nao chama Claude em nenhum ponto.
const { runReconciliationSweep } = require('../reconciliation/sweep');
const { computeReportData } = require('./compute');
const { formatReport } = require('./format');
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

// `options.periodo` e `options.dataLabel` permitem gerar um relatorio pra
// uma data que NAO seja hoje (ver scripts/run-report.js) — usado pra testar
// o pipeline inteiro (varredura + calculo + envio) contra dado real de um
// dia especifico, sem esperar o agendamento do node-cron.
// Sem overrides (uso normal, via src/jobs/scheduler.js), o comportamento
// e identico ao de antes.
async function generateAndSendReports(tipo, options = {}) {
  logger.info(`[reports] Iniciando geracao do relatorio ${tipo}...`);

  // A varredura de reconciliacao NAO pode travar o relatorio inteiro se
  // falhar (por exemplo, se bater no limite de requisicoes da API do
  // GymBot ao reconferir muitos atendimentos em aberto de uma vez). Antes
  // desta correcao, um erro aqui abortava a funcao inteira antes mesmo de
  // tentar enviar qualquer coisa pras duas marcas — e por estar fora de
  // qualquer try/catch, o erro tambem podia derrubar o processo inteiro
  // do servico (o agendamento do node-cron nao trata erro sozinho).
  if (options.skipSweep) {
    logger.info(`[reports] skipSweep ativo — pulando varredura de reconciliacao para o relatorio ${tipo}.`);
  } else {
    try {
      await runReconciliationSweep();
    } catch (err) {
      logger.error(
        `[reports] Varredura de reconciliacao falhou — seguindo para gerar o relatorio ${tipo} ` +
        `mesmo assim (os numeros de conversao podem estar desatualizados ate a proxima varredura ` +
        `bem-sucedida): ${err.message}`
      );
    }
  }

  const periodo = options.periodo || periodoDeTipo(tipo);
  const dataLabel = options.dataLabel || nowLocal().toFormat('dd/MM/yyyy');

  for (const marca of config.marcas) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const data = await computeReportData(marca, periodo);
      const texto = formatReport({
        marca, tipoLabel: TIPO_LABELS[tipo], dataLabel, data,
      });
      // eslint-disable-next-line no-await-in-loop
      await evolution.sendGroupMessage(marca, texto);
      logger.info(`[reports] Relatorio ${tipo} de ${marca} enviado com sucesso.`);
    } catch (err) {
      // Log generico so dizia "Request failed with status code 401" sem
      // dizer QUAL chamada (Sheets ou Evolution) falhou — dentro deste try
      // tem dois clientes de API diferentes (computeReportData /
      // evolution.sendGroupMessage), cada um com o proprio formato de erro
      // (axios usa err.response.status + err.config.url). Sem isso, um 401
      // fica ambiguo entre "credencial do Sheets invalida" e
      // "EVOLUTION_API_KEY/EVOLUTION_INSTANCE invalida", que sao problemas
      // completamente diferentes de resolver.
      const status = err.response?.status || err.status || '';
      const url = err.config?.url
        ? `${err.config.baseURL || ''}${err.config.url}`
        : (err.request?.path || '');
      const detalhes = [
        err.message,
        status ? `status ${status}` : null,
        url ? `url ${url}` : null,
      ].filter(Boolean).join(' | ');
      logger.error(`[reports] Erro ao gerar/enviar relatorio ${tipo} de ${marca}: ${detalhes}`);
    }
  }
}

module.exports = { generateAndSendReports };
