// Ferramenta de diagnostico — execucao UNICA e MANUAL. NAO faz parte do
// funcionamento normal do agente. Serve so para descobrir, com dado real,
// os nomes exatos dos campos que a API do GymBot devolve numa sessao —
// em especial os campos de data e de ID do lead/atendente, que ate agora
// so tinhamos tentado adivinhar (createdAt/startAt/date, contactId/etc).
//
// Faz apenas 2 chamadas (bem leve, nao gasta quase nada do limite da
// API): 1 para listar a primeira sessao encontrada, outra para buscar
// essa mesma sessao completa. Imprime os dois JSONs inteiros no console.
//
// Uso (Railway Console):
//   node scripts/inspect-session.js
require('dotenv').config();
const flwchat = require('../src/clients/flwchat');
const logger = require('../src/utils/logger');

async function run() {
  logger.info('[inspect] Buscando a primeira pagina de sessoes (1 item)...');
  const result = await flwchat.listSessions({ page: 1, pageSize: 1 });
  const items = result.items || result.data || result.results || [];

  console.log('\n========== RESPOSTA CRUA DE listSessions (pagina 1, 1 item) ==========');
  console.log(JSON.stringify(result, null, 2));
  console.log('========== FIM ==========\n');

  if (!items.length) {
    logger.warn('[inspect] Nenhuma sessao encontrada na lista — nao da pra buscar os detalhes.');
    process.exit(0);
  }

  const id = items[0].id;
  logger.info(`[inspect] Buscando sessao completa (id: ${id})...`);
  const session = await flwchat.getSession(id);

  console.log('\n========== RESPOSTA CRUA DE getSession (sessao completa) ==========');
  console.log(JSON.stringify(session, null, 2));
  console.log('========== FIM ==========\n');

  process.exit(0);
}

run().catch((err) => {
  logger.error('[inspect] Erro:', err.message);
  if (err.response) {
    console.log(JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});
