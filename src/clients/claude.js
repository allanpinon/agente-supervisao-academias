// Cliente da API da Claude (Anthropic) — motor de avaliacao qualitativa
// e de sintese periodica. Usa "tool use" forcado para garantir que a
// resposta sempre venha em formato estruturado (JSON), sem depender de
// parsing de texto livre.
const Anthropic = require('@anthropic-ai/sdk');
const { config } = require('../config');
const { EXCELLENCE_STANDARD } = require('../rubric');

let anthropicClient = null;
function client() {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  return anthropicClient;
}

const EVALUATION_TOOL = {
  name: 'registrar_avaliacao',
  description: 'Registra a avaliacao estruturada de um atendimento.',
  input_schema: {
    type: 'object',
    properties: {
      notaGeral: { type: 'integer', minimum: 1, maximum: 5 },
      notaCordialidade: { type: 'integer', minimum: 1, maximum: 5 },
      notaPersonalizacao: { type: 'integer', minimum: 1, maximum: 5 },
      notaClarezaOferta: { type: 'integer', minimum: 1, maximum: 5 },
      notaTratamentoObjecoes: { type: 'integer', minimum: 1, maximum: 5 },
      notaFechamentoCta: { type: 'integer', minimum: 1, maximum: 5 },
      notaFollowUp: { type: 'integer', minimum: 1, maximum: 5 },
      objecoesIdentificadas: {
        type: 'array',
        items: { type: 'string' },
        description: 'Lista curta de objecoes do lead (ex: "preco", "horario", "localizacao")',
      },
      pontosFortes: { type: 'array', items: { type: 'string' } },
      pontosFracos: { type: 'array', items: { type: 'string' } },
    },
    required: [
      'notaGeral', 'notaCordialidade', 'notaPersonalizacao', 'notaClarezaOferta',
      'notaTratamentoObjecoes', 'notaFechamentoCta', 'notaFollowUp',
      'objecoesIdentificadas', 'pontosFortes', 'pontosFracos',
    ],
  },
};

// Avalia uma conversa completa (atendente x lead) segundo o padrao de
// excelencia definido em src/rubric.js. `transcript` e uma string com a
// conversa formatada linha a linha (quem falou + o que falou).
async function evaluateConversation(transcript) {
  const message = await client().messages.create({
    model: config.anthropic.model,
    max_tokens: 1024,
    system: `${EXCELLENCE_STANDARD}\n\nAvalie a conversa abaixo com base nesses padroes. Seja criterioso e justo — nao invente informacao que nao esta na conversa. Sempre chame a ferramenta "registrar_avaliacao" com o resultado.`,
    tools: [EVALUATION_TOOL],
    tool_choice: { type: 'tool', name: 'registrar_avaliacao' },
    messages: [
      { role: 'user', content: `Conversa a avaliar:\n\n${transcript}` },
    ],
  });

  const toolUse = message.content.find((c) => c.type === 'tool_use');
  if (!toolUse) throw new Error('Claude nao retornou avaliacao estruturada.');
  return toolUse.input;
}

const SYNTHESIS_TOOL = {
  name: 'registrar_sintese',
  description: 'Registra a sintese periodica de desempenho de um atendente.',
  input_schema: {
    type: 'object',
    properties: {
      avaliacaoGeral: { type: 'string', description: 'Resumo curto (1-2 frases) do desempenho no periodo' },
      volumeObjecoes: { type: 'string', description: 'Resumo do volume e tipos de objecao mais comuns' },
      pontosFortesConsolidados: { type: 'array', items: { type: 'string' } },
      pontosFracosConsolidados: { type: 'array', items: { type: 'string' } },
      sugestaoMelhoria: { type: 'string', description: 'Uma sugestao pratica e acionavel para o proximo periodo' },
    },
    required: [
      'avaliacaoGeral', 'volumeObjecoes', 'pontosFortesConsolidados',
      'pontosFracosConsolidados', 'sugestaoMelhoria',
    ],
  },
};

// Gera a sintese de um atendente para um periodo (dia/semana/mes), a
// partir da lista de avaliacoes individuais daquele periodo.
async function synthesizePeriod(atendente, periodo, avaliacoes) {
  const resumoAvaliacoes = avaliacoes
    .map((a, i) => `Atendimento ${i + 1}: nota geral ${a['Nota Geral (1-5)']}, ` +
      `objecoes: ${a['Objeções Identificadas']}, ` +
      `pontos fortes: ${a['Pontos Fortes']}, pontos fracos: ${a['Pontos Fracos']}`)
    .join('\n');

  const message = await client().messages.create({
    model: config.anthropic.model,
    max_tokens: 1024,
    system: `${EXCELLENCE_STANDARD}\n\nVoce esta sintetizando o desempenho de um(a) atendente num periodo, a partir das avaliacoes individuais de cada atendimento. Seja especifico e pratico. Sempre chame a ferramenta "registrar_sintese".`,
    tools: [SYNTHESIS_TOOL],
    tool_choice: { type: 'tool', name: 'registrar_sintese' },
    messages: [
      {
        role: 'user',
        content: `Atendente: ${atendente}\nPeriodo: ${periodo}\n\nAvaliacoes individuais do periodo:\n${resumoAvaliacoes || '(nenhum atendimento avaliado no periodo)'}`,
      },
    ],
  });

  const toolUse = message.content.find((c) => c.type === 'tool_use');
  if (!toolUse) throw new Error('Claude nao retornou sintese estruturada.');
  return toolUse.input;
}

module.exports = { evaluateConversation, synthesizePeriod };
