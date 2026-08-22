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

async function gravarSinteses(marca, tipo, sinteses, periodo) {
  // "Data do Período" precisa refletir o periodo que o relatorio esta
  // cobrindo, nao o instante em que o processamento rodou — pro diario
  // isso da no mesmo (o periodo comeca hoje), mas pra um relatorio gerado
  // manualmente pra uma data passada (ver scripts/run-report.js) usar
  // nowLocal() gravaria a data de HOJE (quando o script rodou) numa
  // sintese que na verdade e sobre outro dia, o que confundiria qualquer
  // consulta futura nessa planilha.
  const dataPeriodo = periodo.start.toFormat('yyyy-MM-dd');
  for (const {
    atendente, convertidos, naoConvertidos, emAberto,
  } of sinteses) {
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
    if (emAberto) {
      // eslint-disable-next-line no-await-in-loop
      await sheets.appendRow('sinteses', {
        'Data do Período': dataPeriodo,
        'Tipo (Diário/Semanal/Mensal)': TIPO_LABELS[tipo],
        Marca: marca,
        Atendente: atendente,
        'Avaliação Geral': emAberto.resumo,
        'Volume de Objeções': '',
        'Pontos Fortes Consolidados': '',
        'Pontos Fracos Consolidados': (emAberto.padroes || []).join('; '),
        'Sugestão de Melhoria': emAberto.recomendacao,
        Resultado: 'Em aberto',
      });
    }
  }
}

// `options.periodo` e `options.dataLabel` permitem gerar um relatorio pra
// uma data que NAO seja hoje (ver scripts/run-report.js) — usado pra testar
// o pipeline inteiro (varredura + calculo + sintese + envio) contra dado
// real de um dia especifico, sem esperar o agendamento do node-cron.
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
      await gravarSinteses(marca, tipo, sinteses, periodo);
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
      // Log generico so dizia "Request failed with status code 401" sem
      // dizer QUAL chamada (Sheets, Claude ou Evolution) falhou — dentro
      // deste try tem tres clientes de API diferentes (computeReportData /
      // synthesizeAttendants / gravarSinteses / evolution.sendGroupMessage),
      // cada um com o proprio formato de erro (axios usa err.response.status
      // + err.config.url; o SDK da Anthropic usa err.status direto, sem
      // err.response — ver mesmo problema documentado em src/utils/retry.js).
      // Sem isso, um 401 fica ambiguo entre "ANTHROPIC_API_KEY invalida" e
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
