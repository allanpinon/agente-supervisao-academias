// Trata os eventos SESSION_NEW e SESSION_COMPLETE do webhook do GymBot.
// SESSION_NEW cria a linha em "Atendimentos" (status "Em andamento").
// SESSION_COMPLETE busca a sessao completa, dispara a avaliacao
// qualitativa (Claude) e marca a linha como "Atendido".
//
// Importante: SESSION_COMPLETE NAO marca a linha como "Fechado". Fechado
// so acontece via varredura de reconciliacao (src/reconciliation/sweep.js),
// que confirma a classificacao oficial do GymBot — decisao explicita do
// usuario para evitar duplicidade/complexidade com a tag de matriculado.
const flwchat = require('../clients/flwchat');
const sheets = require('../clients/sheets');
const { resolveMarcaUnidade, extractTagsId } = require('../utils/tags');
const { nowLocal } = require('../utils/dates');
const { evaluateAndRecordSession } = require('./evaluate');
const logger = require('../utils/logger');

async function processSessionNew(session) {
  // Uma leitura so da planilha cobre as duas checagens abaixo (duplicidade
  // de SESSION_NEW e classificacao Novo/Recorrente) — evita 2 leituras
  // separadas da API do Sheets pro mesmo evento.
  const atendimentosAtuais = await sheets.readAll('atendimentos');

  // SESSION_NEW pode chegar duplicado (reenvio de webhook do GymBot, ou
  // via o fallback de processSessionComplete quando a linha original nao
  // e encontrada) — confirmado em dado real da planilha (mesma Session ID
  // aparecendo duas vezes em "Atendimentos"). Sem essa checagem, cada
  // entrega duplicada virava uma linha nova.
  const existente = atendimentosAtuais.find((r) => r['Session ID (GymBot)'] === session.id);
  if (existente) {
    logger.info(`[processSession] Atendimento da sessao ${session.id} ja registrado (linha ${existente._rowNumber}) — SESSION_NEW duplicado, ignorando.`);
    return;
  }

  // Reforca contactDetails quando a sessao vem sem esse dado (visto em
  // boa parte dos eventos reais) — ver flwchat.ensureContactDetails.
  const contactDetails = await flwchat.ensureContactDetails(session, logger);
  const atendente = await flwchat.resolveAgentName(session, logger);
  const { marca, unidade } = resolveMarcaUnidade(extractTagsId(contactDetails));

  // Novo x Recorrente: o GymBot reaproveita o mesmo Contact ID pro mesmo
  // numero de WhatsApp mesmo que a pessoa reapareca meses depois (via um
  // anuncio diferente, por exemplo) — confirmado pelo usuario. Em tempo
  // real os eventos chegam em ordem cronologica, entao "ja existe algum
  // atendimento anterior com este Contact ID" e um jeito confiavel de saber
  // se esta e a primeira vez que esta pessoa fala com a gente ou se e uma
  // reativacao. Isso ainda nao muda o relatorio — e a base de dado que vai
  // se acumulando pra, mais pra frente, dar pra medir esse padrao (lead que
  // nao fecha na hora mas volta e fecha depois).
  let classificacaoLead = '';
  if (contactDetails?.id) {
    const atendimentoAnterior = atendimentosAtuais.find((r) => r['Contact ID (GymBot)'] === contactDetails.id);
    classificacaoLead = atendimentoAnterior ? 'Recorrente' : 'Novo';
  }

  const row = {
    'Data/Hora': session.createdAt || nowLocal().toISO(),
    Marca: marca || '',
    Unidade: unidade || '',
    Atendente: atendente,
    Lead: contactDetails?.name || '',
    Canal: contactDetails?.instagram ? 'Instagram' : 'WhatsApp',
    'Status (Atendido/Fechado)': 'Em andamento',
    'Horário 1ª Resposta': '',
    'Session ID (GymBot)': session.id,
    'Contact ID (GymBot)': contactDetails?.id || '',
    'Classificação do Lead': classificacaoLead,
  };
  await sheets.appendRow('atendimentos', row);
  logger.info(`[processSession] Novo atendimento registrado: sessao ${session.id}`);
}

async function processSessionComplete(session) {
  // O payload do webhook pode vir resumido — busca a sessao completa
  // antes de avaliar, pra ter certeza que temos contactDetails/agentDetails.
  const fullSession = await flwchat.getSession(session.id);
  fullSession.contactDetails = await flwchat.ensureContactDetails(fullSession, logger);
  const atendenteResolvido = await flwchat.resolveAgentName(fullSession, logger);
  fullSession.agentDetails = { ...(fullSession.agentDetails || {}), name: atendenteResolvido };

  await evaluateAndRecordSession(fullSession);

  const existing = await sheets.findRowByColumn('atendimentos', 'Session ID (GymBot)', session.id);
  if (!existing) {
    logger.warn(
      `[processSession] SESSION_COMPLETE para sessao ${session.id} sem linha correspondente ` +
      'em Atendimentos (provavelmente o SESSION_NEW nao chegou) — criando agora.'
    );
    await processSessionNew(fullSession);
    return;
  }

  // BUG CORRIGIDO: ate aqui, este UPDATE so tocava em "Status", jogando fora
  // o contactDetails/atendente que acabaram de ser resolvidos (linhas acima)
  // com dado fresco da API. Na pratica isso fazia a linha de Atendimentos
  // ficar com Marca/Unidade/Atendente/Lead/Contact ID em branco pra sempre
  // sempre que esses dados nao estavam disponiveis ja no SESSION_NEW (ex:
  // atendente so e atribuida depois que alguem realmente assume a conversa)
  // — mesmo a avaliacao (Avaliações) saindo correta, porque evaluateAndRecordSession
  // usa esse mesmo dado fresco pra gravar a propria linha dela. So preenche
  // campo que ainda estiver vazio; nunca sobrescreve valor ja gravado.
  const { marca, unidade } = resolveMarcaUnidade(extractTagsId(fullSession.contactDetails));
  await sheets.updateRow('atendimentos', existing._rowNumber, {
    ...existing,
    'Status (Atendido/Fechado)': 'Atendido',
    Marca: existing.Marca || marca || '',
    Unidade: existing.Unidade || unidade || '',
    Atendente: existing.Atendente || atendenteResolvido || '',
    Lead: existing.Lead || fullSession.contactDetails?.name || '',
    'Contact ID (GymBot)': existing['Contact ID (GymBot)'] || fullSession.contactDetails?.id || '',
  });
  logger.info(`[processSession] Atendimento concluido: sessao ${session.id}`);
}

module.exports = { processSessionNew, processSessionComplete };
