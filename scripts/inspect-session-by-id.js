// Ferramenta de diagnostico — execucao UNICA e MANUAL. NAO faz parte do
// funcionamento normal do agente.
//
// Diferente de scripts/inspect-session.js (que sempre pega a sessao mais
// RECENTE da lista), este pega uma sessao ESPECIFICA pelo ID — necessario
// pra investigar por que scripts/repair-atendimentos.js nao esta
// conseguindo reparar nada: a hipotese e que GET /v2/session/{id} devolve
// um payload mais "enxuto" (sem userId/contactId flat, ou sem tagsId) pra
// sessoes ja antigas/fechadas, diferente do payload rico que a sessao tem
// logo quando o evento (SESSION_NEW/SESSION_COMPLETE) acabou de acontecer.
// Este script imprime a resposta CRUA da API pra uma sessao antiga real,
// pra confirmar ou descartar essa hipotese com dado de verdade.
//
// Uso (Railway Console):
//   node scripts/inspect-session-by-id.js <sessionId>
require('dotenv').config();
const flwchat = require('../src/clients/flwchat');
const logger = require('../src/utils/logger');

const sessionId = process.argv[2];

if (!sessionId) {
  logger.error('[inspect-by-id] Uso: node scripts/inspect-session-by-id.js <sessionId>');
  process.exit(1);
}

async function run() {
  logger.info(`[inspect-by-id] Buscando sessao ${sessionId}...`);
  const session = await flwchat.getSession(sessionId);

  console.log('\n========== RESPOSTA CRUA DE getSession ==========');
  console.log(JSON.stringify(session, null, 2));
  console.log('========== FIM ==========\n');

  console.log('Campos-chave que o codigo depende:');
  console.log(`  session.contactDetails: ${JSON.stringify(session?.contactDetails)}`);
  console.log(`  session.agentDetails: ${JSON.stringify(session?.agentDetails)}`);
  console.log(`  session.contactId (flat): ${session?.contactId}`);
  console.log(`  session.userId (flat): ${session?.userId}`);
  console.log(`  session.agentId (flat): ${session?.agentId}`);

  // Chama EXATAMENTE o mesmo caminho que scripts/repair-atendimentos.js e
  // o pipeline em tempo real usam — pra ver, com certeza, se e aqui que a
  // resolucao esta falhando (em vez de so olhar o payload cru da sessao).
  logger.info('[inspect-by-id] Chamando ensureContactDetails(session)...');
  const contactDetails = await flwchat.ensureContactDetails(session, logger);
  console.log('\n========== RESULTADO DE ensureContactDetails ==========');
  console.log(JSON.stringify(contactDetails, null, 2));
  console.log('========== FIM ==========\n');

  logger.info('[inspect-by-id] Chamando resolveAgentName(session)...');
  const atendente = await flwchat.resolveAgentName(session, logger);
  console.log(`\nresolveAgentName -> "${atendente}"\n`);

  const { resolveMarcaUnidade, extractTagsId } = require('../src/utils/tags');
  const tags = extractTagsId(contactDetails);
  const { marca, unidade } = resolveMarcaUnidade(tags);
  console.log(`extractTagsId(contactDetails) -> ${JSON.stringify(tags)}`);
  console.log(`resolveMarcaUnidade(...) -> marca="${marca}", unidade="${unidade}"\n`);

  process.exit(0);
}

run().catch((err) => {
  logger.error('[inspect-by-id] Erro:', err.message);
  if (err.response) {
    console.log(JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});
