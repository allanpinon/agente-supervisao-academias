// Cliente da API do GymBot / flw.chat.
const axios = require('axios');
const { config } = require('../config');

function client() {
  return axios.create({
    baseURL: config.flwchat.baseUrl,
    headers: {
      Authorization: `Bearer ${config.flwchat.apiToken}`,
      'Content-Type': 'application/json',
    },
    timeout: 20000,
  });
}

async function getSession(sessionId) {
  const { data } = await client().get(`/v2/session/${sessionId}`);
  return data;
}

async function getSessionMessages(sessionId, page = 1, pageSize = 100) {
  const { data } = await client().get(`/v1/session/${sessionId}/message`, {
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
  const { data } = await client().get('/v1/tag');
  return data;
}

async function getContact(contactId) {
  const { data } = await client().get(`/v1/contact/${contactId}`);
  return data;
}

// Lista sessoes num periodo — usado pelo importador historico e pela
// varredura de reconciliacao (quando precisamos redescobrir sessoes que
// nao vieram por webhook).
async function listSessions({ page = 1, pageSize = 100, startDate, endDate } = {}) {
  const { data } = await client().get('/v2/session', {
    params: { page, pageSize, startDate, endDate },
  });
  return data;
}

async function listWebhookEvents() {
  const { data } = await client().get('/v1/webhook/event');
  return data;
}

async function createWebhookSubscription(url, events) {
  const { data } = await client().post('/v1/webhook-subscription', {
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
  listSessions,
  listWebhookEvents,
  createWebhookSubscription,
};
