// Configuracao central do servico.
// Le tudo de variaveis de ambiente (definidas no Railway em producao,
// ou em um arquivo .env local durante testes).
require('dotenv').config();

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  return value;
}

// Protecao contra um erro facil de cometer ao colar uma URL nas
// variaveis do Railway: esquecer o "https://" na frente. Sem o esquema, a
// chamada falha com "Invalid URL" sem nenhuma pista de qual variavel foi
// a causa — ja aconteceu com FLWCHAT_API_BASE_URL antes, e aconteceu de
// novo com EVOLUTION_API_URL (bloqueou o envio dos relatorios no
// WhatsApp). Em vez de so validar, corrige sozinho quando possivel.
function normalizeUrl(value) {
  if (!value) return value;
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  timezone: process.env.TIMEZONE || 'America/Sao_Paulo',

  flwchat: {
    apiToken: process.env.FLWCHAT_API_TOKEN,
    // So o dominio, SEM /core ou /chat no final — o prefixo certo e
    // adicionado por chamada em src/clients/flwchat.js.
    baseUrl: normalizeUrl(process.env.FLWCHAT_API_BASE_URL) || 'https://api.wts.chat',
    webhookSecret: process.env.FLWCHAT_WEBHOOK_SECRET || '',
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-5',
  },

  google: {
    serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    sheets: {
      leads: required('SHEET_LEADS_ID', '1zpDKedEppvLOtYrUuQbYVCKtmnVJbc5CQpDlev6RXUQ'),
      atendimentos: required('SHEET_ATENDIMENTOS_ID', '1i1Qj2CHV_NxZtconzuKqeZFvxNxlgnreksKlUzkuQ0A'),
      conversoes: required('SHEET_CONVERSOES_ID', '1FHjPUryN0v4FsgPGjgGP9kQ7Zxhlb0Nl4AJVUbP5d-k'),
      avaliacoes: required('SHEET_AVALIACOES_ID', '1SuD3YISI1kR06dipR18mngQ-oaZU1jF070ahaHLTYlc'),
      sinteses: required('SHEET_SINTESES_ID', '1TCj0DaSpkopKSPI4NB6cqvhBR7BWxeyaZ3QF7bPIxpY'),
      manual: required('SHEET_MANUAL_ID', '1NG-vi2MRw2N_UXEw5mE8enaGBWX6VTeOZY5t0lbmbNo'),
    },
  },

  evolution: {
    apiUrl: normalizeUrl(process.env.EVOLUTION_API_URL),
    instance: process.env.EVOLUTION_INSTANCE,
    apiKey: process.env.EVOLUTION_API_KEY,
    groups: {
      'Greco Forma': process.env.EVOLUTION_GROUP_GRECO_FORMA,
      'Fit.com': process.env.EVOLUTION_GROUP_FITCOM,
    },
  },

  reconciliation: {
    lookbackDays: parseInt(process.env.RECONCILIATION_LOOKBACK_DAYS || '60', 10),
  },

  // ACHADO CRITICO CONFIRMADO COM DADO REAL (26/08/2026): o antigo valor
  // placeholder abaixo ('OBJECTIVE_ACHIEVED') nunca foi confirmado e nunca
  // bateu com nada — porque a causa raiz era outra: GET /v2/session/{id}
  // sempre devolve classification: null (testado com 2 sessoes reais
  // classificadas de verdade no GymBot), entao a comparacao nunca podia
  // funcionar por ESSE caminho, seja qual fosse o valor aqui. O dado real
  // vem do payload CRU do webhook SESSION_COMPLETE (ver
  // src/pipeline/conversion.js pro relato completo e pra onde a
  // comparacao de verdade agora acontece).
  //
  // LOST: confirmado com dado real em 26/08/2026 — sessao
  // 6d7f3599-1c8b-47eb-9f86-9e493f56e6c9, classificada no GymBot como
  // "Objetivo perdido" / "Lead mora longe", chegou no webhook com
  // classification.category = "LOST".
  //
  // WON: confirmado com dado real em 26/08/2026 — sessao
  // 6d7f3599-1c8b-47eb-9f86-9e493f56e6c9, classificada no GymBot como
  // "Objetivo atingido" / "Renovação pelo link", chegou no webhook com
  // classification.category = "WON" (categoryName: "Ganho").
  classificationCategories: {
    LOST: process.env.CLASSIFICATION_CATEGORY_LOST || 'LOST',
    WON: process.env.CLASSIFICATION_CATEGORY_WON || 'WON',
  },

  // Mapeamento de tags do GymBot -> marca / unidade.
  // IDs confirmados via GET /v1/tag em 19/08/2026.
  tagMap: {
    '0a34b5f2-9ae5-46d9-bf6d-bc1278c2aebf': { tipo: 'unidade', marca: 'Greco Forma', unidade: 'Humaitá' },
    'ca44a57e-a425-4e2b-872d-22e707c1ac84': { tipo: 'unidade', marca: 'Greco Forma', unidade: 'Castelo' },
    'edee4334-196e-4986-b473-406b6b5b0f7a': { tipo: 'unidade', marca: 'Greco Forma', unidade: 'Wandenkolk' },
    'c4980902-fb08-4dd2-a50c-39690876b6f8': { tipo: 'unidade', marca: 'Fit.com', unidade: 'Augusto Montenegro' },
    '4c07a9c0-651d-407f-ac27-70201d3078e3': { tipo: 'unidade', marca: 'Fit.com', unidade: 'Br-316' },
    '68cfa06b-3eef-43cd-b6be-2808864f5018': { tipo: 'marca', marca: 'Greco Forma' },
    'bba61126-40d5-41df-bb1e-ef92854ca286': { tipo: 'marca', marca: 'Fit.com' },
  },

  marcas: ['Greco Forma', 'Fit.com'],

  // Marca padronizada por atendente — cada atendente atende SOMENTE uma
  // marca (2 por marca), então este mapeamento é uma fonte mais confiável
  // pra decidir a Marca de um atendimento/avaliação do que a tag do
  // contato: a tag pode faltar (ainda não aplicada), chegar só depois do
  // primeiro atendimento, ou vir com grafia inconsistente — os três
  // problemas reais encontrados na análise do gap de contagem de
  // 20/08/2026 (ver `claude/arquitetura-agente-supervisao.md`). Usado em
  // `src/utils/tags.js` (`resolveMarcaPorAtendente`), no pipeline de
  // gravação (`src/pipeline/processSession.js`, `src/pipeline/evaluate.js`)
  // e na leitura do relatório (`src/reports/compute.js`).
  // IMPORTANTE: pedido explícito do usuário (22/08/2026) — atualizar este
  // mapa manualmente sempre que uma atendente mudar de marca ou uma nova
  // atendente começar a atender.
  atendenteMarca: {
    Maryelle: 'Greco Forma',
    'Amanda Caroline': 'Greco Forma',
    'Sâmia Borges': 'Fit.com',
    'Maria Eduarda': 'Fit.com',
  },
};

function assertConfigured() {
  const missing = [];
  if (!config.flwchat.apiToken) missing.push('FLWCHAT_API_TOKEN');
  if (!config.anthropic.apiKey) missing.push('ANTHROPIC_API_KEY');
  if (!config.google.serviceAccountJson) missing.push('GOOGLE_SERVICE_ACCOUNT_JSON');
  if (!config.evolution.apiUrl) missing.push('EVOLUTION_API_URL');
  if (!config.evolution.instance) missing.push('EVOLUTION_INSTANCE');
  if (!config.evolution.apiKey) missing.push('EVOLUTION_API_KEY');
  if (missing.length) {
    // eslint-disable-next-line no-console
    console.warn(
      `[config] Atencao: variaveis de ambiente ausentes: ${missing.join(', ')}. ` +
      'O servico pode nao funcionar corretamente ate elas serem configuradas no Railway.'
    );
  }
}

module.exports = { config, assertConfigured };
