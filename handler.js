// Handler HTTP para o webhook do GymBot/flw.chat. Espera um corpo no
// formato { eventType, date, content } (conforme a documentacao de
// webhooks) e despacha para o pipeline certo.
const { processContactNew, processContactTagUpdate } = require('../pipeline/processContact');
const { processSessionNew, processSessionComplete } = require('../pipeline/processSession');
const { processPaymentNew } = require('../pipeline/processPayment');
const logger = require('../utils/logger');

// INVESTIGACAO RESOLVIDA (26/08/2026): por que nenhuma conversao jamais
// foi gravada, mesmo com negocios reais marcados "Ganho"/"Perdido" no
// GymBot. Causa raiz confirmada com dado real: GET /v2/session/{id}
// SEMPRE devolve classification: null — mas o payload CRU do proprio
// webhook SESSION_COMPLETE TRAZ o dado real (testado com a sessao
// 6d7f3599-1c8b-47eb-9f86-9e493f56e6c9: classification.category = "LOST").
// A hipotese anterior (evento PANEL_CARD_STEP_CHANGE) foi testada com um
// gatilho real e NAO recebeu nenhum evento — descartada. Ver
// src/pipeline/conversion.js pro relato completo e pra onde a logica de
// conversao mora agora.
const HANDLERS = {
  CONTACT_NEW: (content) => processContactNew(content),
  CONTACT_TAG_UPDATE: (content) => processContactTagUpdate(content),
  SESSION_NEW: (content) => processSessionNew(content),
  SESSION_COMPLETE: (content) => processSessionComplete(content),
  PAYMENT_NEW: (content) => processPaymentNew(content),
};

async function webhookHandler(req, res) {
  // Responde 200 imediatamente (evita retentativa por timeout do lado do
  // GymBot) e processa o evento depois. Se o processamento falhar, o erro
  // fica so no log — MAS confirmado com dado real em 26/08/2026 que o
  // GymBot REENTREGA sozinho pelo menos SESSION_COMPLETE apos uma falha
  // (uma sessao que deu 403 na 1a tentativa foi processada com sucesso
  // ~9 minutos depois, sem nenhuma acao nossa) — o comentario antigo
  // dizendo "nao ha reentrega automatica" estava errado, mantido aqui so
  // pra registrar a correcao.
  res.status(200).json({ received: true });

  const { eventType, content } = req.body || {};

  if (!eventType) {
    logger.warn('[webhook] Evento recebido sem eventType — ignorado.');
    return;
  }

  const handler = HANDLERS[eventType];
  if (!handler) {
    logger.info(`[webhook] Evento ${eventType} recebido, sem handler configurado — ignorado.`);
    return;
  }

  try {
    await handler(content);
  } catch (err) {
    // Log detalhado: axios (flwchat/evolution) guarda a resposta em
    // err.response; o SDK da Anthropic guarda status/erro direto no objeto.
    let detalhes = '';
    if (err.response) {
      detalhes = ` [HTTP ${err.response.status} em ${err.config?.method?.toUpperCase() || '?'} ${err.config?.url || '?'}] ${JSON.stringify(err.response.data)}`;
    } else if (err.status) {
      detalhes = ` [Anthropic HTTP ${err.status}] ${JSON.stringify(err.error || {})}`;
    }
    logger.error(`[webhook] Erro processando evento ${eventType}: ${err.message}${detalhes}`);
  }
}

module.exports = { webhookHandler };
