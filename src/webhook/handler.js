// Handler HTTP para o webhook do GymBot/flw.chat. Espera um corpo no
// formato { eventType, date, content } (conforme a documentacao de
// webhooks) e despacha para o pipeline certo.
const { processContactNew, processContactTagUpdate } = require('../pipeline/processContact');
const { processSessionNew, processSessionComplete } = require('../pipeline/processSession');
const { processPaymentNew } = require('../pipeline/processPayment');
const logger = require('../utils/logger');

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
  // fica so no log — nao ha reentrega automatica neste MVP.
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
    logger.error(`[webhook] Erro processando evento ${eventType}:`, err.message);
  }
}

module.exports = { webhookHandler };
