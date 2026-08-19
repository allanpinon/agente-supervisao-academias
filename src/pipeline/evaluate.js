// Roda a avaliacao qualitativa (Claude) de uma conversa completa e grava
// o resultado na aba "Avaliações". Tambem injeta o Manual de Boas
// Praticas mais recente da marca (se existir) como contexto extra, para
// que a avaliacao va se calibrando com base em conversoes reais dessa
// marca ao longo do tempo.
const flwchat = require('../clients/flwchat');
const claude = require('../clients/claude');
const sheets = require('../clients/sheets');
const { formatTranscript } = require('../utils/transcript');
const { resolveMarcaUnidade } = require('../utils/tags');
const { nowLocal } = require('../utils/dates');
const { getLatestManual } = require('../reports/manual');
const logger = require('../utils/logger');

async function evaluateAndRecordSession(session) {
  const messages = await flwchat.getFullConversation(session.id);
  if (!messages.length) {
    logger.warn(`[evaluate] Sessao ${session.id} sem mensagens — pulando avaliacao.`);
    return null;
  }

  const transcript = formatTranscript(messages);
  // Reforca contactDetails quando a sessao vem sem esse dado — ver
  // flwchat.ensureContactDetails. Se ja foi enriquecida por quem chamou
  // (processSession.js, import-history.js), isso nao gasta chamada extra.
  const contactDetails = await flwchat.ensureContactDetails(session, logger);
  const { marca, unidade } = resolveMarcaUnidade(contactDetails?.tagsId || []);

  let manualAtual = null;
  if (marca) {
    try {
      manualAtual = await getLatestManual(marca);
    } catch (err) {
      logger.warn(`[evaluate] Falha ao buscar Manual de Boas Praticas de ${marca}: ${err.message}`);
    }
  }

  const avaliacao = await claude.evaluateConversation(
    transcript,
    manualAtual ? manualAtual['Versão do Manual'] : null
  );

  const row = {
    'Data/Hora': nowLocal().toISO(),
    Marca: marca || '',
    Unidade: unidade || '',
    Atendente: session.agentDetails?.name || '',
    Lead: contactDetails?.name || '',
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
    // Preenchido depois pela varredura de reconciliacao, quando o
    // resultado real (conversao ou nao) for confirmado.
    Resultado: 'Em aberto',
  };
  await sheets.appendRow('avaliacoes', row);
  logger.info(`[evaluate] Avaliacao gravada para sessao ${session.id} (nota geral: ${avaliacao.notaGeral})`);
  return avaliacao;
}

module.exports = { evaluateAndRecordSession };
