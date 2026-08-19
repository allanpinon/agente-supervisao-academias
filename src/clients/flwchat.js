// Cliente da API do GymBot / flw.chat.
//
// IMPORTANTE: a API tem duas "areas" com prefixos de URL diferentes:
// - /core  -> contatos, tags, campos, equipes, etc.
// - /chat  -> conversas/sessoes (v2/session), mensagens, canais, etc.
// FLWCHAT_API_BASE_URL deve conter so o dominio (ex: https://api.wts.chat
// ou o dominio proprio do GymBot), sem sufixo — o prefixo certo e
// adicionado aqui, por chamada.
const axios = require('axios');
const { config } = require('../config');

function client(prefix) {
  return axios.create({
    baseURL: `${config.flwchat.baseUrl}${prefix}`,
    headers: {
      Authorization: `Bearer ${config.flwchat.apiToken}`,
      'Content-Type': 'application/json',
    },
    timeout: 20000,
  });
}

function coreClient() {
  return client('/core');
}

function chatClient() {
  return client('/chat');
}

async function getSession(sessionId) {
  const { data } = await chatClient().get(`/v2/session/${sessionId}`);
  return data;
}

async function getSessionMessages(sessionId, page = 1, pageSize = 100) {
  const { data } = await chatClient().get(`/v1/session/${sessionId}/message`, {
    params: { page, pageSize },
  });
  return data;
}

// Busca todas as mensagens de uma sessao, paginando ate acabar.
async function getFullConversation(sessionId) {
  let page = 1;
  const all = [];
  // Trava de seguranca para nunca entrar em loop infinito por engano.
  const MAX_PAGES = 50;
  while (page <= MAX_PAGES) {
    const result = await getSessionMessages(sessionId, page, 100);
    const items = result.items || result.data || result.results || [];
    all.push(...items);
    const hasMore = items.length === 100;
    if (!hasMore) break;
    page += 1;
  }
  return all;
}

async function getTags() {
  const { data } = await coreClient().get('/v1/tag');
  return data;
}

async function getContact(contactId) {
  const { data } = await coreClient().get(`/v1/contact/${contactId}`);
  return data;
}

// A sessao (tanto no payload do webhook SESSION_NEW/SESSION_COMPLETE
// quanto na resposta de GET /v2/session/{id}) nem sempre traz
// "contactDetails" preenchido — em boa parte dos casos observados vem
// null, mesmo com as mensagens da conversa vindo normalmente. Isso
// deixava Marca/Unidade/Lead em branco nas planilhas.
//
// Esta funcao tenta reforcar esse dado: se contactDetails ja veio
// utilizavel (com tagsId ou nome), usa direto — sem gastar chamada extra
// de API. Senao, tenta achar um ID de contato em varios nomes de campo
// possiveis (nao temos confirmacao de qual a API realmente usa) e busca
// o contato completo via GET /core/v1/contact/{id}, que sabemos
// responder com o registro completo (nome, tags, canal, utm).
function extractContactId(session) {
  return (
    session?.contactDetails?.id
    || session?.contactId
    || session?.contact_id
    || session?.contact?.id
    || session?.leadId
    || session?.lead?.id
    || null
  );
}

function hasUsableContactDetails(contactDetails) {
  return Boolean(contactDetails && ((contactDetails.tagsId && contactDetails.tagsId.length) || contactDetails.name));
}

async function ensureContactDetails(session, logger) {
  if (hasUsableContactDetails(session?.contactDetails)) {
    return session.contactDetails;
  }

  const contactId = extractContactId(session);
  if (!contactId) {
    if (logger) {
      logger.warn(
        `[flwchat] Sessao ${session?.id || '?'} sem contactDetails utilizavel e sem ID de ` +
        `contato reconhecivel nos campos esperados. Campos disponiveis na sessao: ` +
        `${Object.keys(session || {}).join(', ') || '(nenhum)'}`
      );
    }
    return session?.contactDetails || null;
  }

  try {
    const contact = await getContact(contactId);
    return contact;
  } catch (err) {
    if (logger) {
      logger.warn(`[flwchat] Falha ao buscar contato ${contactId} como reforco: ${err.message}`);
    }
    return session?.contactDetails || null;
  }
}

// Lista sessoes num periodo — usado pelo importador historico e pela
// varredura de reconciliacao (quando precisamos redescobrir sessoes que
// nao vieram por webhook).
async function listSessions({ page = 1, pageSize = 100, startDate, endDate } = {}) {
  const { data } = await chatClient().get('/v2/session', {
    params: { page, pageSize, startDate, endDate },
  });
  return data;
}

async function listWebhookEvents() {
  const { data } = await coreClient().get('/v1/webhook/event');
  return data;
}

async function createWebhookSubscription(url, events) {
  const { data } = await coreClient().post('/v1/webhook-subscription', {
    url,
    events,
  });
  return data;
}

module.exports = {
  getSession,
  getSessionMessages,
  getFullConversation,
  getTags,
  getContact,
  ensureContactDetails,
  listSessions,
  listWebhookEvents,
  createWebhookSubscription,
};
