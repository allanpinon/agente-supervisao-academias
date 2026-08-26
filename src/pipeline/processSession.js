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
const { resolveMarcaUnidade, extractTagsId, resolveMarcaPorAtendente } = require('../utils/tags');
const { nowLocal } = require('../utils/dates');
const { evaluateAndRecordSession } = require('./evaluate');
const { registerConversionOutcome } = require('./conversion');
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
  const { marca: marcaTag, unidade } = resolveMarcaUnidade(extractTagsId(contactDetails));
  // Marca padronizada pela atendente quando ja conhecida (mais confiavel
  // que a tag — ver config.atendenteMarca); atendente muitas vezes so e
  // atribuida depois do SESSION_NEW, entao aqui ainda pode cair na tag
  // mesmo — processSessionComplete corrige quando a atendente ja estiver
  // definida.
  const marca = resolveMarcaPorAtendente(atendente) || marcaTag;

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

  // ACHADO CRITICO CONFIRMADO (26/08/2026): GET /v2/session/{id} SEMPRE
  // devolve classification: null, mesmo pra sessoes de verdade
  // classificadas no GymBot — ver src/pipeline/conversion.js pro relato
  // completo. O payload CRU do proprio webhook (o parametro `session`
  // recebido aqui) TRAZ o dado real, entao usamos ele em vez do que veio
  // (ou melhor, nao veio) no GET.
  fullSession.classification = session.classification || fullSession.classification;

  fullSession.contactDetails = await flwchat.ensureContactDetails(fullSession, logger);
  const atendenteResolvido = await flwchat.resolveAgentName(fullSession, logger);
  fullSession.agentDetails = { ...(fullSession.agentDetails || {}), name: atendenteResolvido };

  await evaluateAndRecordSession(fullSession);

  let existing = await sheets.findRowByColumn('atendimentos', 'Session ID (GymBot)', session.id);
  if (!existing) {
    logger.warn(
      `[processSession] SESSION_COMPLETE para sessao ${session.id} sem linha correspondente ` +
      'em Atendimentos (provavelmente o SESSION_NEW nao chegou) — criando agora.'
    );
    await processSessionNew(fullSession);
    existing = await sheets.findRowByColumn('atendimentos', 'Session ID (GymBot)', session.id);
    if (!existing) {
      logger.error(
        `[processSession] Nao foi possivel localizar/criar a linha de Atendimentos da sessao ` +
        `${session.id} mesmo apos o fallback — abortando o registro de status/conversao desta sessao.`
      );
      return;
    }
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
  const { marca: marcaTag, unidade } = resolveMarcaUnidade(extractTagsId(fullSession.contactDetails));
  // Padronizacao pela atendente (config.atendenteMarca) tem prioridade
  // sobre o que ja estiver gravado — diferente dos outros campos deste
  // UPDATE (que so preenchem se estiver vazio), porque a atendente
  // costuma so ficar definida DEPOIS do SESSION_NEW, exatamente quando
  // este UPDATE roda — e porque a tag do contato provou ser a fonte menos
  // confiavel (grafia inconsistente, tag atrasada) na analise do gap de
  // 20/08/2026.
  const marcaPadronizada = resolveMarcaPorAtendente(atendenteResolvido);
  const marca = marcaPadronizada || marcaTag;
  const atendimentoAtualizado = {
    ...existing,
    'Status (Atendido/Fechado)': 'Atendido',
    Marca: marcaPadronizada || existing.Marca || marca || '',
    Unidade: existing.Unidade || unidade || '',
    Atendente: existing.Atendente || atendenteResolvido || '',
    Lead: existing.Lead || fullSession.contactDetails?.name || '',
    'Contact ID (GymBot)': existing['Contact ID (GymBot)'] || fullSession.contactDetails?.id || '',
  };
  await sheets.updateRow('atendimentos', existing._rowNumber, atendimentoAtualizado);
  logger.info(`[processSession] Atendimento concluido: sessao ${session.id}`);

  // So agora que a linha de Atendimentos esta atualizada: se o webhook ja
  // trouxe uma classificacao (o caso comum — "Concluir" no GymBot abre
  // direto o modal de classificacao), registra o resultado real
  // (conversao/nao convertido) na hora, em vez de depender da varredura
  // de reconciliacao (que, pelo achado acima, nunca vai encontrar essa
  // classificacao via GET).
  try {
    await registerConversionOutcome(fullSession, { ...atendimentoAtualizado, _rowNumber: existing._rowNumber });
  } catch (err) {
    logger.warn(`[processSession] Falha ao registrar resultado (conversao/nao convertido) da sessao ${session.id}: ${err.message}`);
  }
}

module.exports = { processSessionNew, processSessionComplete };
