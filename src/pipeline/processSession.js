// Trata os eventos SESSION_NEW e SESSION_COMPLETE do webhook do GymBot.
// SESSION_NEW cria a linha em "Atendimentos" (status "Em andamento").
// SESSION_COMPLETE busca a sessao completa, dispara a avaliacao
// qualitativa (Claude) e marca a linha como "Atendido".
//
// Importante: SESSION_COMPLETE NAO marca a linha como "Fechado". Fechado
// so acontece via varredura de reconciliacao (src/reconciliation/sweep.js),
// que confirma a classificacao oficial do GymBot — decisao explicita do
// usuario para evitar duplicidade/complexidade com a tag de matriculado.
const flwchat = require('../clients/flwchat');
const sheets = require('../clients/sheets');
const { resolveMarcaUnidade } = require('../utils/tags');
const { nowLocal } = require('../utils/dates');
const { evaluateAndRecordSession } = require('./evaluate');
const logger = require('../utils/logger');

async function processSessionNew(session) {
  // Reforca contactDetails quando a sessao vem sem esse dado (visto em
  // boa parte dos eventos reais) — ver flwchat.ensureContactDetails.
  const contactDetails = await flwchat.ensureContactDetails(session, logger);
  const { marca, unidade } = resolveMarcaUnidade(contactDetails?.tagsId || []);
  const row = {
    'Data/Hora': session.createdAt || nowLocal().toISO(),
    Marca: marca || '',
    Unidade: unidade || '',
    Atendente: session.agentDetails?.name || '',
    Lead: contactDetails?.name || '',
    Canal: contactDetails?.instagram ? 'Instagram' : 'WhatsApp',
    'Status (Atendido/Fechado)': 'Em andamento',
    'Horário 1ª Resposta': '',
    'Session ID (GymBot)': session.id,
    'Contact ID (GymBot)': contactDetails?.id || '',
  };
  await sheets.appendRow('atendimentos', row);
  logger.info(`[processSession] Novo atendimento registrado: sessao ${session.id}`);
}

async function processSessionComplete(session) {
  // O payload do webhook pode vir resumido — busca a sessao completa
  // antes de avaliar, pra ter certeza que temos contactDetails/agentDetails.
  const fullSession = await flwchat.getSession(session.id);
  fullSession.contactDetails = await flwchat.ensureContactDetails(fullSession, logger);

  await evaluateAndRecordSession(fullSession);

  const existing = await sheets.findRowByColumn('atendimentos', 'Session ID (GymBot)', session.id);
  if (!existing) {
    logger.warn(
      `[processSession] SESSION_COMPLETE para sessao ${session.id} sem linha correspondente ` +
      'em Atendimentos (provavelmente o SESSION_NEW nao chegou) — criando agora.'
    );
    await processSessionNew(fullSession);
    return;
  }

  await sheets.updateRow('atendimentos', existing._rowNumber, {
    ...existing,
    'Status (Atendido/Fechado)': 'Atendido',
  });
  logger.info(`[processSession] Atendimento concluido: sessao ${session.id}`);
}

module.exports = { processSessionNew, processSessionComplete };
