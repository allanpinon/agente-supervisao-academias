// Ferramenta de diagnostico — execucao UNICA e MANUAL. NAO faz parte do
// funcionamento normal do agente. Mesmo espirito do inspect-session.js,
// mas para o payload de MENSAGENS de uma sessao.
//
// Por que isso importa: src/utils/transcript.js monta o texto que a Claude
// recebe para avaliar cada atendimento (nota geral, pontos fortes/fracos
// etc.) adivinhando os nomes de campo (fromMe/direction, text/body/
// content/caption, createdAt/timestamp) — o proprio arquivo tem um
// comentario "CALIBRACAO PENDENTE" avisando isso, porque nunca vimos um
// payload real de GET /v1/session/{id}/message. Se os nomes reais forem
// diferentes, a Claude acaba avaliando um transcript errado (quem falou
// trocado, ou so "[mensagem sem texto]" repetido) SEM DAR ERRO NENHUM —
// a nota sai, so que sem sentido, silenciosamente. Como ja existem
// avaliacoes reais gravadas na planilha a partir de producao, vale rodar
// isto agora para confirmar (ou corrigir) os nomes de campo usados em
// transcript.js antes de confiar nas notas ja geradas.
//
// Uso (Railway Console):
//   node scripts/inspect-messages.js
require('dotenv').config();
const flwchat = require('../src/clients/flwchat');
const { formatTranscript } = require('../src/utils/transcript');
const logger = require('../src/utils/logger');

async function run() {
  logger.info('[inspect] Buscando a primeira pagina de sessoes (1 item)...');
  const result = await flwchat.listSessions({ page: 1, pageSize: 1 });
  const items = result.items || result.data || result.results || [];

  if (!items.length) {
    logger.warn('[inspect] Nenhuma sessao encontrada na lista — nao da pra buscar mensagens.');
    process.exit(0);
  }

  const id = items[0].id;
  logger.info(`[inspect] Buscando mensagens da sessao (id: ${id})...`);
  const raw = await flwchat.getSessionMessages(id, 1, 20);

  console.log('\n========== RESPOSTA CRUA DE getSessionMessages (pagina 1, ate 20 itens) ==========');
  console.log(JSON.stringify(raw, null, 2));
  console.log('========== FIM ==========\n');

  const items2 = raw.items || raw.data || raw.results || [];
  if (!items2.length) {
    logger.warn('[inspect] A sessao encontrada nao tem mensagens — tente rodar de novo (pega outra sessao a cada execucao).');
    process.exit(0);
  }

  console.log('========== COMO transcript.js INTERPRETA ESSAS MENSAGENS HOJE ==========');
  console.log(formatTranscript(items2));
  console.log('========== FIM ==========\n');

  console.log(
    'Compare as duas saidas acima: se "Atendente:"/"Lead:" ou o texto das mensagens\n' +
    'parecerem errados/trocados/vazios, os nomes de campo em\n' +
    'src/utils/transcript.js (fromMe, direction, text, body, content, caption,\n' +
    'createdAt, timestamp) precisam ser ajustados para os nomes reais vistos\n' +
    'no JSON cru acima.'
  );

  process.exit(0);
}

run().catch((err) => {
  logger.error('[inspect] Erro:', err.message);
  if (err.response) {
    console.log(JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});
