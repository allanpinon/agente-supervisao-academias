// Importador historico — execucao UNICA e MANUAL (npm run import-history,
// ou "node scripts/import-history.js N" pelo Console do Railway).
// Traz para as planilhas os atendimentos dos ultimos N dias (padrao: 30),
// reaproveitando as mesmas funcoes/formatos usados em tempo real, para
// garantir que o dado historico fique identico ao que o webhook vai gerar
// dali pra frente.
//
// IMPORTANTE sobre performance/cota: com centenas ou milhares de
// atendimentos, checar duplicidade com 1 leitura da planilha POR item
// estoura a cota de leitura por minuto do Google Sheets. Por isso aqui a
// gente le cada planilha relevante UMA vez no inicio (buildIndex) e usa
// esses indices em memoria para as checagens — so voltamos a consultar a
// API pontualmente quando precisamos atualizar uma linha existente (o que
// so acontece na fracao de sessoes que converteram).
require('dotenv').config();
const flwchat = require('../src/clients/flwchat');
const sheets = require('../src/clients/sheets');
const { resolveMarcaUnidade } = require('../src/utils/tags');
const { evaluateAndRecordSession } = require('../src/pipeline/evaluate');
const { nowLocal, diffInDays } = require('../src/utils/dates');
const { config } = require('../src/config');
const logger = require('../src/utils/logger');

const DIAS = parseInt(process.argv[2] || '30', 10);
// Pequena pausa entre sessoes, para suavizar o ritmo de chamadas de API
// (GymBot, Claude e Planilhas) ao longo da importacao.
const DELAY_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function importarLead(session, leadsIndex) {
  const contact = session.contactDetails;
  if (!contact?.id || leadsIndex.has(contact.id)) return;
  const { marca, unidade } = resolveMarcaUnidade(contact.tagsId || []);
  const row = {
    'Data/Hora': contact.createdAt || session.createdAt || '',
    Marca: marca || '',
    Unidade: unidade || '',
    'Nome do Lead': contact.name || '',
    Canal: contact.instagram ? 'Instagram' : 'WhatsApp',
    'Origem (Paga/Orgânica)': (contact.utm?.source || contact.utm?.campaign) ? 'Paga' : 'Orgânica',
    'UTM Source': contact.utm?.source || '',
    Atendente: session.agentDetails?.name || '',
    'Contact ID (GymBot)': contact.id,
  };
  await sheets.appendRow('leads', row);
  leadsIndex.set(contact.id, row);
}

async function importarAtendimento(session, atendimentosIndex) {
  const existente = atendimentosIndex.get(session.id);
  if (existente) return existente;
  const { marca, unidade } = resolveMarcaUnidade(session.contactDetails?.tagsId || []);
  const row = {
    'Data/Hora': session.createdAt || '',
    Marca: marca || '',
    Unidade: unidade || '',
    Atendente: session.agentDetails?.name || '',
    Lead: session.contactDetails?.name || '',
    Canal: session.contactDetails?.instagram ? 'Instagram' : 'WhatsApp',
    'Status (Atendido/Fechado)': 'Atendido',
    'Horário 1ª Resposta': '',
    'Session ID (GymBot)': session.id,
    'Contact ID (GymBot)': session.contactDetails?.id || '',
  };
  await sheets.appendRow('atendimentos', row);
  atendimentosIndex.set(session.id, row);
  return row;
}

// So chamado para a fracao de sessoes que de fato converteram — por isso
// pode dar 1-2 leituras pontuais na API sem risco de estourar a cota.
async function importarConversao(session, avaliacoesIndex, conversoesIndex) {
  const category = session.classification?.category;
  if (category !== config.classificationSuccessCategory) return;
  if (conversoesIndex.has(session.id)) return;

  const { marca, unidade } = resolveMarcaUnidade(session.contactDetails?.tagsId || []);
  const dataClassificacao = session.updatedAt || session.createdAt || nowLocal().toISO();
  const dataOrigemLead = session.contactDetails?.createdAt;

  await sheets.appendRow('conversoes', {
    'Data/Hora': dataClassificacao,
    Marca: marca || '',
    Unidade: unidade || '',
    Atendente: session.agentDetails?.name || '',
    Lead: session.contactDetails?.name || '',
    Valor: session.classification?.amount ?? '',
    'Session ID (GymBot)': session.id,
    Motivo: category,
    'Dias até Conversão': dataOrigemLead
      ? Math.max(0, Math.round(diffInDays(dataOrigemLead, dataClassificacao)))
      : '',
    'Contact ID (GymBot)': session.contactDetails?.id || '',
  });
  conversoesIndex.set(session.id, true);

  const atendimentoAtual = await sheets.findRowByColumn('atendimentos', 'Session ID (GymBot)', session.id);
  if (atendimentoAtual) {
    await sheets.updateRow('atendimentos', atendimentoAtual._rowNumber, {
      ...atendimentoAtual,
      'Status (Atendido/Fechado)': 'Fechado',
    });
  }

  if (avaliacoesIndex.has(session.id)) {
    const avaliacaoAtual = await sheets.findRowByColumn('avaliacoes', 'Session ID (GymBot)', session.id);
    if (avaliacaoAtual) {
      await sheets.updateRow('avaliacoes', avaliacaoAtual._rowNumber, {
        ...avaliacaoAtual,
        Resultado: 'Convertido',
      });
    }
  }
}

async function run() {
  const end = nowLocal();
  const start = end.minus({ days: DIAS });
  logger.info(`[import-history] Importando sessoes de ${start.toISODate()} ate ${end.toISODate()}...`);

  logger.info('[import-history] Carregando planilhas existentes (1 leitura por planilha)...');
  const leadsIndex = await sheets.buildIndex('leads', 'Contact ID (GymBot)');
  const atendimentosIndex = await sheets.buildIndex('atendimentos', 'Session ID (GymBot)');
  const avaliacoesIndex = await sheets.buildIndex('avaliacoes', 'Session ID (GymBot)');
  const conversoesIndex = await sheets.buildIndex('conversoes', 'Session ID (GymBot)');
  logger.info(
    `[import-history] Indices carregados: ${leadsIndex.size} lead(s), ` +
    `${atendimentosIndex.size} atendimento(s), ${avaliacoesIndex.size} avaliacao(oes), ` +
    `${conversoesIndex.size} conversao(oes) ja existentes.`
  );

  let page = 1;
  let totalProcessadas = 0;
  const PAGE_SIZE = 50;

  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const result = await flwchat.listSessions({
      page,
      pageSize: PAGE_SIZE,
      startDate: start.toISO(),
      endDate: end.toISO(),
    });
    const items = result.items || result.data || result.results || [];
    if (!items.length) break;

    for (const sessionSummary of items) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const session = await flwchat.getSession(sessionSummary.id);
        // eslint-disable-next-line no-await-in-loop
        await importarLead(session, leadsIndex);
        // eslint-disable-next-line no-await-in-loop
        await importarAtendimento(session, atendimentosIndex);

        if (!avaliacoesIndex.has(session.id)) {
          // eslint-disable-next-line no-await-in-loop
          await evaluateAndRecordSession(session);
          avaliacoesIndex.set(session.id, true);
        }

        // eslint-disable-next-line no-await-in-loop
        await importarConversao(session, avaliacoesIndex, conversoesIndex);

        totalProcessadas += 1;
        logger.info(`[import-history] Sessao ${session.id} processada (${totalProcessadas} no total).`);
      } catch (err) {
        logger.error(`[import-history] Erro processando sessao ${sessionSummary.id}:`, err.message);
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(DELAY_MS);
    }

    if (items.length < PAGE_SIZE) break;
    page += 1;
  }

  logger.info(`[import-history] Concluido. ${totalProcessadas} sessao(oes) processada(s).`);
  process.exit(0);
}

run().catch((err) => {
  logger.error('[import-history] Erro fatal:', err);
  process.exit(1);
});
