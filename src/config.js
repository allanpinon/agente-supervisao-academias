// Configuracao central do servico.
// Le tudo de variaveis de ambiente (definidas no Railway em producao,
// ou em um arquivo .env local durante testes).
require('dotenv').config();

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  return value;
}

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  timezone: process.env.TIMEZONE || 'America/Sao_Paulo',

    flwchat: {
    apiToken: process.env.FLWCHAT_API_TOKEN,
    baseUrl: process.env.FLWCHAT_API_BASE_URL || 'https://api.wts.chat/core',
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
    },
  },

  evolution: {
    apiUrl: process.env.EVOLUTION_API_URL,
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

  // Valor real do enum a confirmar em producao (ver README - "Calibracao pendente").
  classificationSuccessCategory: process.env.CLASSIFICATION_SUCCESS_CATEGORY || 'OBJECTIVE_ACHIEVED',

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
