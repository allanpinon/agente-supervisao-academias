// Cliente da API da Claude (Anthropic) — motor de avaliacao qualitativa,
// de sintese periodica segmentada (convertido x nao convertido) e do
// Manual de Boas Praticas consolidado. Usa "tool use" forcado para
// garantir que a resposta sempre venha em formato estruturado (JSON),
// sem depender de parsing de texto livre.
const Anthropic = require('@anthropic-ai/sdk');
const { config } = require('../config');
const { EXCELLENCE_STANDARD } = require('../rubric');
const { withRetry } = require('../utils/retry');

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
// `manualContext` (opcional) e o texto atual do Manual de Boas Praticas
// da marca — quando presente, e usado como contexto adicional, calibrado
// com base em conversoes reais dessa marca especificamente.
async function evaluateConversation(transcript, manualContext) {
  const contextoManual = manualContext
    ? `\n\nAlem do padrao de excelencia acima, este e o Manual de Boas Praticas ` +
      `consolidado a partir de atendimentos reais que converteram nesta marca — ` +
      `leve esses aprendizados especificos em conta na avaliacao:\n${manualContext}`
    : '';

  // Sem retry aqui, um 429 da API da Claude (comum em rajadas — varios
  // atendimentos concluidos ao mesmo tempo, ou a importacao historica
  // avaliando centenas em sequencia) derrubava a avaliacao inteira: o erro
  // subia, era so logado por quem chamou, e essa sessao nunca mais era
  // reavaliada automaticamente (diferente de conversao, que a varredura de
  // reconciliacao reconfere; uma avaliacao perdida fica perdida).
  const message = await withRetry(
    () => client().messages.create({
      model: config.anthropic.model,
      max_tokens: 1024,
      system: `${EXCELLENCE_STANDARD}${contextoManual}\n\nAvalie a conversa abaixo com base nesses padroes. Seja criterioso e justo — nao invente informacao que nao esta na conversa. Sempre chame a ferramenta "registrar_avaliacao" com o resultado.`,
      tools: [EVALUATION_TOOL],
      tool_choice: { type: 'tool', name: 'registrar_avaliacao' },
      messages: [
        { role: 'user', content: `Conversa a avaliar:\n\n${transcript}` },
      ],
    }),
    { label: 'evaluateConversation' }
  );

  const toolUse = message.content.find((c) => c.type === 'tool_use');
  if (!toolUse) throw new Error('Claude nao retornou avaliacao estruturada.');
  return toolUse.input;
}

const SEGMENT_TOOL = {
  name: 'registrar_analise_segmento',
  description: 'Registra a analise de um grupo de atendimentos (convertidos ou nao convertidos) de um atendente num periodo.',
  input_schema: {
    type: 'object',
    properties: {
      resumo: { type: 'string', description: 'Resumo curto (1-2 frases) do padrao observado neste grupo' },
      padroes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Padroes de comportamento especificos identificados nesses atendimentos',
      },
      recomendacao: {
        type: 'string',
        description: 'Uma recomendacao pratica: reforcar (se convertido), corrigir (se nao convertido), ou ajustar (se em aberto)',
      },
    },
    required: ['resumo', 'padroes', 'recomendacao'],
  },
};

// Analisa um grupo de atendimentos de um atendente, separado por
// resultado ('convertido' ou 'nao_convertido'), num periodo. Isso permite
// que o relatorio destaque separadamente "o que funcionou, para replicar"
// e "o que travou, para corrigir" — em vez de uma sintese unica e generica.
// `manualContext` (opcional) e o Manual de Boas Praticas atual da marca —
// quando presente, pedimos pra Claude confirmar/contrastar os padroes da
// semana/mes com o que ja esta consolidado.
async function synthesizeSegment(atendente, periodo, resultado, avaliacoes, manualContext) {
  const resumoAvaliacoes = avaliacoes
    .map((a, i) => `Atendimento ${i + 1}: nota geral ${a['Nota Geral (1-5)']}, ` +
      `objecoes: ${a['Objeções Identificadas']}, ` +
      `pontos fortes: ${a['Pontos Fortes']}, pontos fracos: ${a['Pontos Fracos']}`)
    .join('\n');

  let foco;
  if (resultado === 'convertido') {
    foco = 'Estes atendimentos RESULTARAM EM CONVERSAO (o lead virou cliente). Identifique os ' +
      'padroes de comportamento da atendente que contribuiram para esse sucesso, para que ' +
      'sejam reforcados e replicados nos proximos atendimentos.';
  } else if (resultado === 'nao_convertido') {
    foco = 'Estes atendimentos NAO resultaram em conversao (dentro da janela analisada). ' +
      'Identifique os principais pontos de travamento ou oportunidades perdidas, para correcao.';
  } else {
    // 'em_aberto': atendimento feito, lead ainda sem decisao (comum no
    // relatorio diario, antes da varredura de reconciliacao classificar).
    // Sem desfecho pra julgar, a analise foca na QUALIDADE do atendimento
    // em si — nao invente um resultado que ainda nao existe.
    foco = 'Estes atendimentos AINDA NAO TEM RESULTADO DEFINIDO (o lead nem converteu nem foi ' +
      'descartado ate agora — pode fechar mais adiante). Sem um desfecho pra julgar, avalie a ' +
      'QUALIDADE do atendimento em si (cordialidade, personalizacao, clareza da oferta, ' +
      'tratamento de objecoes, tentativa de fechamento/CTA, follow-up) — o que ja esta bom pra ' +
      'manter, e o que pode ser ajustado enquanto a conversa ainda esta em curso. Nao presuma se ' +
      'vai converter ou nao.';
  }

  const contextoManual = manualContext
    ? `\n\nManual de Boas Praticas atual desta marca (use como referencia: aponte se os ` +
      `padroes observados nesta semana/mes confirmam, contradizem ou adicionam algo novo a ` +
      `ele):\n${manualContext}`
    : '';

  const message = await withRetry(
    () => client().messages.create({
      model: config.anthropic.model,
      max_tokens: 1024,
      system: `${EXCELLENCE_STANDARD}${contextoManual}\n\n${foco}\nSeja especifico e pratico. Sempre chame a ferramenta "registrar_analise_segmento".`,
      tools: [SEGMENT_TOOL],
      tool_choice: { type: 'tool', name: 'registrar_analise_segmento' },
      messages: [
        {
          role: 'user',
          content: `Atendente: ${atendente}\nPeriodo: ${periodo}\nGrupo: ${resultado}\n\nAvaliacoes individuais do grupo:\n${resumoAvaliacoes || '(nenhum atendimento neste grupo)'}`,
        },
      ],
    }),
    { label: `synthesizeSegment ${atendente}/${resultado}` }
  );

  const toolUse = message.content.find((c) => c.type === 'tool_use');
  if (!toolUse) throw new Error('Claude nao retornou analise de segmento estruturada.');
  return toolUse.input;
}

const MANUAL_TOOL = {
  name: 'registrar_manual',
  description: 'Registra a versao atualizada do Manual de Boas Praticas de uma marca.',
  input_schema: {
    type: 'object',
    properties: {
      versaoManual: {
        type: 'string',
        description: 'Texto completo e atualizado do manual, consolidando o que ja existia com os novos aprendizados do periodo.',
      },
      principaisMudancas: {
        type: 'string',
        description: 'Resumo curto do que mudou nesta versao em relacao a anterior (ou "primeira versao", se for o caso).',
      },
    },
    required: ['versaoManual', 'principaisMudancas'],
  },
};

// Atualiza o Manual de Boas Praticas de uma marca, revisando a versao
// anterior (se existir) a luz dos atendimentos que converteram no periodo
// mais recente. E o mecanismo que faz o agente "aprender" com o tempo:
// o manual resultante e usado (a) como contexto extra na avaliacao de
// cada nova conversa (ver evaluateConversation) e (b) como registro
// consultavel de boas praticas especificas de cada marca.
async function updateManual({ marca, manualAnterior, resumoConversoes, periodo }) {
  const message = await withRetry(
    () => client().messages.create({
      model: config.anthropic.model,
      max_tokens: 2048,
      system: `${EXCELLENCE_STANDARD}\n\nVoce mantem um "Manual de Boas Praticas" vivo para a marca ${marca}, ` +
        'que consolida os padroes reais de sucesso observados nos atendimentos que converteram. ' +
        'A cada atualizacao, revise o manual anterior (se existir) e atualize-o com os novos ' +
        'aprendizados do periodo — mantendo o que ainda e valido, refinando ou removendo o que ' +
        'nao se confirma mais, e adicionando padroes novos. O manual deve ser pratico e ' +
        `especifico para este negocio (${marca}), nao generico. Sempre chame a ferramenta "registrar_manual".`,
      tools: [MANUAL_TOOL],
      tool_choice: { type: 'tool', name: 'registrar_manual' },
      messages: [
        {
          role: 'user',
          content: `Periodo analisado: ${periodo}\n\nManual anterior:\n${manualAnterior || '(nenhum manual anterior — esta e a primeira versao)'}\n\n` +
            `Resumo dos atendimentos que converteram neste periodo:\n${resumoConversoes || '(nenhuma conversao no periodo)'}`,
        },
      ],
    }),
    { label: `updateManual ${marca}` }
  );

  const toolUse = message.content.find((c) => c.type === 'tool_use');
  if (!toolUse) throw new Error('Claude nao retornou manual estruturado.');
  return toolUse.input;
}

module.exports = { evaluateConversation, synthesizeSegment, updateManual };
