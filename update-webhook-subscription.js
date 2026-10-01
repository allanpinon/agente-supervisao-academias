// Ferramenta de setup — execucao UNICA e MANUAL. Atualiza a inscricao de
// webhook do GymBot pra incluir PANEL_CARD_STEP_CHANGE ("Painel - Card
// movido"), confirmado no catalogo real da API (node
// scripts/inspect-webhook-events.js, 26/08/2026) como o evento mais
// provavel de carregar a mudanca "Ganho"/"Perdido" que aparece na
// interface do GymBot — ver comentario em src/webhook/handler.js e a
// secao "ACHADO CRITICO" na documentacao do projeto pro relato completo
// de por que isso e necessario (nenhuma conversao esta sendo gravada
// hoje, porque session.classification vem sempre null).
//
// ATENCAO — efeito colateral real: este script faz um POST de verdade em
// /core/v1/webhook-subscription (nao e so leitura). NAO sabemos com
// certeza se essa chamada FAZ UPSERT da inscricao existente (mesma URL) ou
// se CRIA uma segunda inscricao em paralelo (o que faria todo evento ser
// entregue duas vezes). Os handlers do webhook (src/webhook/handler.js e
// os handlers de processContact/processSession/evaluateAndRecordSession)
// ja sao tolerantes a entrega duplicada — o GymBot ja reentrega eventos
// hoje, e isso ja foi tratado (ver "Registro de incidentes e correcoes",
// item 7, na doc do projeto). Ou seja: o pior cenario aqui e volume de log
// e chamada de API em dobro, NAO dado incorreto gravado — mas mesmo assim
// exige rodar com atencao, por isso o script pede confirmacao explicita
// antes de executar a chamada de verdade.
//
// Uso (Railway Console):
//   node scripts/update-webhook-subscription.js            # so mostra o que SERIA enviado, nao faz a chamada
//   node scripts/update-webhook-subscription.js --confirm  # faz a chamada de verdade
require('dotenv').config();
const flwchat = require('../src/clients/flwchat');
const logger = require('../src/utils/logger');

// URL publica confirmada do servico (ver doc do projeto — "Infraestrutura
// de deploy"). Pode ser sobrescrita via env var se precisar.
const WEBHOOK_URL = process.env.GYMBOT_WEBHOOK_URL
  || 'https://agente-supervisao-academias-production.up.railway.app/webhook/gymbot';

// Os 5 eventos ja confirmados como inscritos e ativos hoje (ver doc do
// projeto — "Eventos de webhook assinados") + o novo, PANEL_CARD_STEP_CHANGE.
// Mantidos aqui explicitamente (nao buscados de volta da API) porque nao
// existe endpoint de LEITURA da inscricao atual neste cliente — so criacao
// (createWebhookSubscription) e catalogo de eventos disponiveis
// (listWebhookEvents). Se a lista de eventos ja inscritos mudou desde a
// ultima atualizacao da doc do projeto, ajuste este array antes de rodar.
const EVENTS = [
  'SESSION_NEW',
  'SESSION_COMPLETE',
  'CONTACT_NEW',
  'CONTACT_TAG_UPDATE',
  'PAYMENT_NEW',
  'PANEL_CARD_STEP_CHANGE',
];

const confirmado = process.argv.includes('--confirm');

async function run() {
  console.log('\n========== INSCRICAO QUE SERIA ENVIADA ==========');
  console.log(JSON.stringify({ url: WEBHOOK_URL, events: EVENTS }, null, 2));
  console.log('========== FIM ==========\n');

  if (!confirmado) {
    logger.info(
      '[update-webhook-subscription] Modo consulta (sem --confirm) — nada foi enviado. ' +
      'Revise a lista de eventos acima e rode de novo com --confirm pra aplicar de verdade.'
    );
    process.exit(0);
    return;
  }

  logger.info('[update-webhook-subscription] --confirm recebido — enviando POST /core/v1/webhook-subscription...');
  const resultado = await flwchat.createWebhookSubscription(WEBHOOK_URL, EVENTS);
  console.log('\n========== RESPOSTA DA API ==========');
  console.log(JSON.stringify(resultado, null, 2));
  console.log('========== FIM ==========\n');
  logger.info(
    '[update-webhook-subscription] Concluido. Acompanhe os logs do servico — se PANEL_CARD_STEP_CHANGE ' +
    'comecar a chegar duplicado ou os 5 eventos antigos pararem de chegar, avise pra investigarmos.'
  );
  process.exit(0);
}

run().catch((err) => {
  logger.error('[update-webhook-subscription] Erro:', err.message);
  if (err.response) {
    console.log(JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});
