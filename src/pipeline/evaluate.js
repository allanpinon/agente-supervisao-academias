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
  // SESSION_COMPLETE pode chegar duplicado (reenvio de webhook do GymBot)
  // — sem essa checagem, uma sessao ja avaliada rodava a conversa inteira
  // de novo pela Claude (custo real e desnecessario de API) e gravava uma
  // segunda linha em "Avaliações" pro mesmo atendimento. Checa ANTES de
  // buscar a conversa/chamar a Claude, exatamente para evitar esse gasto.
  // import-history.js ja faz essa checagem via indice em memoria antes de
  // chamar esta funcao (mais barato em lote); esta checagem aqui cobre o
  // caminho de tempo real (processSessionComplete), que nao tinha nenhuma.
  const existente = await sheets.findRowByColumn('avaliacoes', 'Session ID (GymBot)', session.id);
  if (existente) {
    logger.info(`[evaluate] Sessao ${session.id} ja avaliada (linha ${existente._rowNumber}) — SESSION_COMPLETE duplicado, ignorando (nenhuma chamada extra a Claude).`);
    return null;
  }

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
  // Mesma logica para o nome da atendente — ver flwchat.resolveAgentName.
  const atendente = await flwchat.resolveAgentName(session, logger);
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
    // Usa a data real da sessao (mesmo campo que sweep.js e
    // import-history.js usam para esta mesma planilha), em vez do
    // instante em que o processamento rodou — evita que uma avaliacao de
    // uma sessao concluida perto da virada do dia caia no dia errado do
    // relatorio so por causa de um atraso no processamento (fila,
    // novo tentativa apos 429, etc.).
    'Data/Hora': session.updatedAt || session.createdAt || nowLocal().toISO(),
    Marca: marca || '',
    Unidade: unidade || '',
    Atendente: atendente,
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
