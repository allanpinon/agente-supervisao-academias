// Handler HTTP para o webhook do GymBot/flw.chat. Espera um corpo no
// formato { eventType, date, content } (conforme a documentacao de
// webhooks) e despacha para o pipeline certo.
const { processContactNew, processContactTagUpdate } = require('../pipeline/processContact');
const { processSessionNew, processSessionComplete } = require('../pipeline/processSession');
const { processPaymentNew } = require('../pipeline/processPayment');
const logger = require('../utils/logger');

// DIAGNOSTICO EM ANDAMENTO (26/08/2026): investigando por que nenhuma
// conversao esta sendo gravada, mesmo com negocios reais marcados "Ganho"
// no GymBot (ex: sessao b0d42dd2-7e4f-47a5-877f-87a7b664a83d, William
// Quaresma). Confirmado com a API real que `session.classification` vem
// SEMPRE `null` em GET /v2/session/{id} — a comparacao que
// src/reconciliation/sweep.js faz contra CLASSIFICATION_SUCCESS_CATEGORY
// nunca pode bater, entao nenhuma conversao jamais foi gravada por esse
// caminho. O "Ganho" que aparece na interface do GymBot provavelmente vem
// de um recurso separado (painel/funil de vendas — ver o evento de
// webhook PANEL_CARD_STEP_CHANGE, que existe no catalogo da API mas nunca
// foi assinado nem tem handler). Este handler NAO faz nada com o evento
// ainda — so loga o payload cru, pra confirmarmos o formato real assim
// que um cartao mudar de etapa, ANTES de escrever qualquer logica em cima
// de um formato assumido (mesmo cuidado de sempre: nao inventar dado).
function logPanelCardStepChange(content) {
  logger.info(`[webhook] PANEL_CARD_STEP_CHANGE recebido (diagnostico, nao processado ainda): ${JSON.stringify(content)}`);
}

const HANDLERS = {
  CONTACT_NEW: (content) => processContactNew(content),
  CONTACT_TAG_UPDATE: (content) => processContactTagUpdate(content),
  SESSION_NEW: (content) => processSessionNew(content),
  SESSION_COMPLETE: (content) => processSessionComplete(content),
  PAYMENT_NEW: (content) => processPaymentNew(content),
  PANEL_CARD_STEP_CHANGE: (content) => logPanelCardStepChange(content),
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

  // DIAGNOSTICO TEMPORARIO (26/08/2026): investigando onde mora o dado de
  // classificacao (Objetivo atingido/perdido + motivo especifico, ver a
  // tela "Classificar atendimento" documentada no projeto). Ja confirmado
  // que GET /v2/session/{id} sempre devolve `classification: null` — mas
  // processSessionComplete NUNCA olhou pro `content` cru do proprio
  // webhook, so usa `content.id` pra rebuscar a sessao via GET (que
  // descarta silenciosamente qualquer coisa que o payload do webhook
  // tivesse a mais). Testamos assinar PANEL_CARD_STEP_CHANGE (evento
  // "Painel - Card movido") como hipotese de onde a classificacao mora,
  // mas nenhum evento de Painel chegou nem uma vez apos uma classificacao
  // real de teste — entao ou o card do Painel nao e criado/movido por
  // esse fluxo de classificacao no chat, ou tem algum delay/config que
  // ainda nao identificamos. Enquanto isso, logando o corpo CRU de TODO
  // evento recebido (nao so os sem handler) pra comparar com o que GET
  // devolve — remover este log depois que o campo certo for encontrado.
  logger.info(`[webhook] RAW ${eventType || '(sem eventType)'}: ${JSON.stringify(req.body)}`);

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
