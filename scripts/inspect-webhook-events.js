// Ferramenta de diagnostico — execucao UNICA e MANUAL, SO LEITURA (nao
// grava nem altera nenhuma inscricao de webhook).
//
// Investigando por que nenhuma conversao esta sendo gravada mesmo com
// negocios reais marcados "Ganho" no GymBot (ver comentario em
// src/webhook/handler.js): confirmado que `session.classification` vem
// sempre `null` via GET /v2/session/{id}, entao a logica atual de
// deteccao de conversao (src/reconciliation/sweep.js, comparando contra
// CLASSIFICATION_SUCCESS_CATEGORY) nunca pode funcionar. A hipotese e que
// o "Ganho"/"Perdido" que aparece na interface do GymBot vem de um painel/
// funil de vendas separado, e que o evento de webhook PANEL_CARD_STEP_CHANGE
// (citado na revisao de gaps original, nunca assinado) e o jeito de
// capturar essa mudanca em tempo real.
//
// Este script so LISTA o catalogo de eventos disponiveis na API do GymBot
// (GET /core/v1/webhook/event) — serve pra confirmar o nome exato do
// evento e ler a descricao que a propria API da pra ele, ANTES de decidir
// se/como assinar. Nao cria nem altera nenhuma inscricao.
//
// Uso (Railway Console):
//   node scripts/inspect-webhook-events.js
require('dotenv').config();
const flwchat = require('../src/clients/flwchat');
const logger = require('../src/utils/logger');

async function run() {
  logger.info('[inspect-webhook-events] Buscando catalogo de eventos disponiveis (GET /core/v1/webhook/event)...');
  const eventos = await flwchat.listWebhookEvents();
  console.log('\n========== CATALOGO DE EVENTOS DISPONIVEIS ==========');
  console.log(JSON.stringify(eventos, null, 2));
  console.log('========== FIM ==========\n');

  const lista = Array.isArray(eventos) ? eventos : (eventos?.data || eventos?.items || []);
  const candidatos = lista.filter((e) => {
    const nome = (typeof e === 'string' ? e : e?.name || e?.type || e?.eventType || '').toUpperCase();
    return nome.includes('PANEL') || nome.includes('CARD') || nome.includes('FUNIL') || nome.includes('FUNNEL')
      || nome.includes('DEAL') || nome.includes('CLASSIFIC') || nome.includes('STAGE') || nome.includes('STEP');
  });
  if (candidatos.length) {
    console.log('Eventos que parecem relacionados a painel/funil/classificacao de negocio:');
    console.log(JSON.stringify(candidatos, null, 2));
  } else {
    console.log('Nenhum evento no catalogo bateu com os termos esperados (PANEL/CARD/FUNIL/FUNNEL/DEAL/CLASSIFIC/STAGE/STEP) — confira a lista completa acima manualmente.');
  }

  process.exit(0);
}

run().catch((err) => {
  logger.error('[inspect-webhook-events] Erro:', err.message);
  if (err.response) {
    console.log(JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});
