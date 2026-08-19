// Roda a avaliacao qualitativa (Claude) de uma conversa completa e grava
// o resultado na aba "Avaliações".
const flwchat = require('../clients/flwchat');
const claude = require('../clients/claude');
const sheets = require('../clients/sheets');
const { formatTranscript } = require('../utils/transcript');
const { resolveMarcaUnidade } = require('../utils/tags');
const { nowLocal } = require('../utils/dates');
const logger = require('../utils/logger');

async function evaluateAndRecordSession(session) {
  const messages = await flwchat.getFullConversation(session.id);
  if (!messages.length) {
    logger.warn(`[evaluate] Sessao ${session.id} sem mensagens — pulando avaliacao.`);
    return null;
  }

  const transcript = formatTranscript(messages);
  const avaliacao = await claude.evaluateConversation(transcript);

  const { marca, unidade } = resolveMarcaUnidade(session.contactDetails?.tagsId || []);

  const row = {
    'Data/Hora': nowLocal().toISO(),
    Marca: marca || '',
    Unidade: unidade || '',
    Atendente: session.agentDetails?.name || '',
    Lead: session.contactDetails?.name || '',
    'Nota Geral (1-5)': avaliacao.notaGeral,
    'Nota Cordialidade': avaliacao.notaCordialidade,
    'Nota Personalização': avaliacao.notaPersonalizacao,
    'Nota Clareza da Oferta': avaliacao.notaClarezaOferta,
    'Nota Tratamento Objeções': avaliacao.notaTratamentoObjecoes,
    'Nota Fechamento/CTA': avaliacao.notaFechamentoCta,
    'Nota Follow-up': avaliacao.notaFollowUp,
    'Objeções Identificadas': (avaliacao.objecoesIdentificadas || []).join('; '),
    'Pontos Fortes': (avaliacao.pontosFortes || []).join('; '),
    'Pontos Fracos': (avaliacao.pontosFracos || []).join('; '),
    'Session ID (GymBot)': session.id,
  };
  await sheets.appendRow('avaliacoes', row);
  logger.info(`[evaluate] Avaliacao gravada para sessao ${session.id} (nota geral: ${avaliacao.notaGeral})`);
  return avaliacao;
}

module.exports = { evaluateAndRecordSession };
