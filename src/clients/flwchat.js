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

async function listAgents() {
  const { data } = await coreClient().get('/v1/agent');
  return data;
}

// contactDetails/agentDetails vem sempre null na sessao — mas descobrimos
// (via GET /core/v1/agent, categoria "Usuarios" na documentacao) que da
// pra buscar a lista INTEIRA de atendentes de uma vez so (userId + nome),
// ja que sao poucos (4 no total). Por isso, ao contrario do contato (que
// e buscado individualmente por ID, pois sao muitos leads), aqui cacheamos
// a lista inteira em memoria na primeira vez que for precisa.
let agentsCache = null; // Map: userId -> nome

async function getAgentNameMap(logger) {
  if (agentsCache) return agentsCache;
  try {
    const agents = await listAgents();
    agentsCache = new Map();
    (agents || []).forEach((a) => {
      if (a.userId) agentsCache.set(a.userId, a.name || a.shortName || '');
    });
  } catch (err) {
    if (logger) {
      logger.warn(`[flwchat] Falha ao buscar lista de usuarios/atendentes: ${err.message}`);
    }
    // NAO grava em agentsCache aqui — deixa null, para que a proxima
    // chamada tente buscar de novo (evita que uma falha passageira no
    // inicio da execucao trave a resolucao do nome da atendente pro
    // resto do processo, ja que agentsCache normalmente vive por toda a
    // vida do processo).
    return new Map();
  }
  return agentsCache;
}

function extractUserId(session) {
  return (
    session?.userId
    || session?.agentDetails?.id
    || session?.agentId
    || session?.agent?.id
    || null
  );
}

// Resolve o nome da atendente responsavel pela sessao. Se agentDetails ja
// vier com nome (nao observado ate agora, mas por seguranca), usa direto.
// Senao, usa o userId da sessao (campo confirmado com dado real) contra a
// lista de usuarios buscada por getAgentNameMap.
async function resolveAgentName(session, logger) {
  if (session?.agentDetails?.name) return session.agentDetails.name;

  const userId = extractUserId(session);
  if (!userId) return '';

  const map = await getAgentNameMap(logger);
  const nome = map.get(userId);
  if (!nome && logger) {
    logger.warn(`[flwchat] userId ${userId} (sessao ${session?.id || '?'}) nao encontrado na lista de usuarios/atendentes.`);
  }
  return nome || '';
}

// Lista sessoes num periodo — usado pelo importador historico e pela
// varredura de reconciliacao (quando precisamos redescobrir sessoes que
// nao vieram por webhook).
//
// IMPORTANTE (descoberto testando com dado real): esta API NAO filtra por
// startDate/endDate — esses parametros sao ignorados silenciosamente (nem
// aparecem ecoados na resposta, diferente de orderBy/orderDirection, que
// ela reconhece). A conta tem dezenas de milhares de sessoes desde 2024, e
// por padrao elas vem da MAIS ANTIGA pra mais nova. Se pedissemos um
// periodo recente (como agosto/2026) sem inverter a ordem, teriamos que
// paginar por quase TODO o historico antes de chegar no periodo desejado
// — foi exatamente isso que estourou o limite de requisicoes da API numa
// tentativa anterior (chegou na pagina 950 sem nunca sair de 2024).
// Por isso pedimos explicitamente ordem DESCENDING (mais nova primeiro):
// assim o periodo recente aparece logo nas primeiras paginas, e o filtro
// por data feito no nosso lado (import-history.js) consegue parar de
// paginar cedo com seguranca, assim que passar do inicio do periodo.
async function listSessions({
  page = 1, pageSize = 100, orderBy = 'createdAt', orderDirection = 'DESCENDING',
} = {}) {
  const { data } = await chatClient().get('/v2/session', {
    params: {
      page, pageSize, orderBy, orderDirection,
    },
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
  listAgents,
  resolveAgentName,
  listSessions,
  listWebhookEvents,
  createWebhookSubscription,
};
