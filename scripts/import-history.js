// Importador historico — execucao UNICA e MANUAL (npm run import-history).
// Traz para as planilhas os atendimentos dos ultimos N dias (padrao: 30),
// reaproveitando as mesmas funcoes/formatos usados em tempo real, para
// garantir que o dado historico fique identico ao que o webhook vai gerar
// dali pra frente.
require('dotenv').config();
const flwchat = require('../src/clients/flwchat');
const sheets = require('../src/clients/sheets');
const { resolveMarcaUnidade } = require('../src/utils/tags');
const { evaluateAndRecordSession } = require('../src/pipeline/evaluate');
const { nowLocal, diffInDays } = require('../src/utils/dates');
const { config } = require('../src/config');
const logger = require('../src/utils/logger');

const DIAS = parseInt(process.argv[2] || '30', 10);

async function jaExisteAvaliacao(sessionId) {
  const existente = await sheets.findRowByColumn('avaliacoes', 'Session ID (GymBot)', sessionId);
  return Boolean(existente);
}

async function importarLead(session) {
  const contact = session.contactDetails;
  if (!contact?.id) return;
  const existente = await sheets.findRowByColumn('leads', 'Contact ID (GymBot)', contact.id);
  if (existente) return;
  const { marca, unidade } = resolveMarcaUnidade(contact.tagsId || []);
  await sheets.appendRow('leads', {
    'Data/Hora': contact.createdAt || session.createdAt || '',
    Marca: marca || '',
    Unidade: unidade || '',
    'Nome do Lead': contact.name || '',
    Canal: contact.instagram ? 'Instagram' : 'WhatsApp',
    'Origem (Paga/Orgânica)': (contact.utm?.source || contact.utm?.campaign) ? 'Paga' : 'Orgânica',
    'UTM Source': contact.utm?.source || '',
    Atendente: session.agentDetails?.name || '',
    'Contact ID (GymBot)': contact.id,
  });
}

async function importarAtendimento(session) {
  const existente = await sheets.findRowByColumn('atendimentos', 'Session ID (GymBot)', session.id);
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
  return row;
}

async function importarConversao(session, atendimentoRow) {
  const category = session.classification?.category;
  if (category !== config.classificationSuccessCategory) return;
  const existente = await sheets.findRowByColumn('conversoes', 'Session ID (GymBot)', session.id);
  if (existente) return;

  const { marca, unidade } = resolveMarcaUnidade(session.contactDetails?.tagsId || []);
  const dataClassificacao = session.updatedAt || session.createdAt || nowLocal().toISO();
  const dataOrigemLead = session.contactDetails?.createdAt || atendimentoRow?.['Data/Hora'];

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

  if (atendimentoRow?._rowNumber) {
    await sheets.updateRow('atendimentos', atendimentoRow._rowNumber, {
      ...atendimentoRow,
      'Status (Atendido/Fechado)': 'Fechado',
    });
  }
}

async function run() {
  const end = nowLocal();
  const start = end.minus({ days: DIAS });
  logger.info(`[import-history] Importando sessoes de ${start.toISODate()} ate ${end.toISODate()}...`);

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
        await importarLead(session);
        // eslint-disable-next-line no-await-in-loop
        const atendimentoRow = await importarAtendimento(session);
        // eslint-disable-next-line no-await-in-loop
        const jaAvaliado = await jaExisteAvaliacao(session.id);
        if (!jaAvaliado) {
          // eslint-disable-next-line no-await-in-loop
          await evaluateAndRecordSession(session);
        }
        // eslint-disable-next-line no-await-in-loop
        await importarConversao(session, atendimentoRow);
        totalProcessadas += 1;
        logger.info(`[import-history] Sessao ${session.id} processada (${totalProcessadas} no total).`);
      } catch (err) {
        logger.error(`[import-history] Erro processando sessao ${sessionSummary.id}:`, err.message);
      }
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
