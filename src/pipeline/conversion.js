// Registra o RESULTADO real (conversao ou nao) de um atendimento, a
// partir de um `session.classification` de verdade.
//
// ACHADO CRITICO CONFIRMADO COM DADO REAL (26/08/2026): GET
// /v2/session/{id} SEMPRE devolve classification: null, mesmo pra
// sessoes de verdade classificadas no GymBot — confirmado com 2 sessoes
// reais:
//   - William Quaresma (b0d42dd2-...): "Ganho" na interface do GymBot,
//     classification veio null via GET.
//   - 6d7f3599-1c8b-47eb-9f86-9e493f56e6c9: "Objetivo perdido" / "Lead
//     mora longe" na interface, classification tambem veio null via GET.
// Isso explica por que NENHUMA conversao jamais foi gravada desde o
// lancamento do servico (Conversões sempre vazia, so cabecalho).
//
// O payload CRU do proprio webhook SESSION_COMPLETE, por outro lado, TRAZ
// o dado real — confirmado com a sessao 6d7f3599 acima:
//   content.classification = {
//     category: "LOST", categoryName: "Perdido",
//     categoryDescription: "Lead mora longe ", amount: 0
//   }
// src/pipeline/processSession.js agora usa essa classification que veio
// no proprio corpo do webhook (em vez de descartar ela e confiar so no
// GET, que sempre apaga o dado).
//
// Consequencia importante pro desenho original da varredura de
// reconciliacao (src/reconciliation/sweep.js): ela foi feita pra
// reconferir sessoes pendentes via GET, pra pegar classificacoes que
// acontecessem DEPOIS do SESSION_COMPLETE — mas como GET nunca traz esse
// dado, esse caminho especifico nunca vai encontrar nada (fica um no-op
// seguro, nao um erro). Pelo fluxo real do GymBot, "Concluir" abre direto
// o modal "Classificar atendimento" — completar e classificar acontecem
// juntos, no mesmo evento SESSION_COMPLETE — entao o caminho em tempo
// real (este arquivo, chamado por processSessionComplete) e hoje o UNICO
// jeito confirmado de capturar essa classificacao. Sessoes concluidas
// ANTES desta correcao (ex: William Quaresma) nao tem como ser
// recuperadas retroativamente por API — o GET continua apagando o dado
// pra elas tambem. Recuperar esses casos historicos exigiria conferencia
// manual contra o GymBot (exportacao/relatorio proprio deles), nao API.
//
// Valor de category CONFIRMADO ate agora: so "LOST". O valor de "Ganho"
// (Objetivo atingido) ainda nao foi confirmado com dado real — ver
// config.classificationCategories.WON. Uma categoria desconhecida NUNCA e
// tratada como conversao (evitar gravar "Convertido" com base em um
// chute) — so gera um log de aviso com o valor exato recebido.
const sheets = require('../clients/sheets');
const flwchat = require('../clients/flwchat');
const { config } = require('../config');
const { resolveMarcaUnidade, extractTagsId, resolveMarcaPorAtendente } = require('../utils/tags');
const { nowLocal, diffInDays } = require('../utils/dates');
const logger = require('../utils/logger');

async function marcarResultadoAvaliacao(sessionId, resultado) {
  if (!sessionId) return;
  const avaliacao = await sheets.findRowByColumn('avaliacoes', 'Session ID (GymBot)', sessionId);
  if (!avaliacao) return;
  if (avaliacao.Resultado === resultado) return; // ja esta certo, evita escrita desnecessaria
  await sheets.updateRow('avaliacoes', avaliacao._rowNumber, { ...avaliacao, Resultado: resultado });
}

// `session` precisa ter `.classification` (do webhook cru ou, no futuro,
// de outro caminho que venha a funcionar) e `.id`. `atendimentoRow` e a
// linha atual de "Atendimentos" (precisa de `_rowNumber`) — usada como
// fonte de verdade pra Marca/Unidade/Atendente/Lead ja resolvidos pelo
// chamador, com `session` servindo de reforco/fallback.
async function registerConversionOutcome(session, atendimentoRow) {
  const classification = session?.classification;
  const category = classification?.category;
  const sessionId = session?.id || atendimentoRow?.['Session ID (GymBot)'];

  if (!category) return { outcome: 'sem-classificacao' };
  if (!sessionId || !atendimentoRow?._rowNumber) return { outcome: 'sem-linha-atendimento' };

  if (category === config.classificationCategories.LOST) {
    await sheets.updateRow('atendimentos', atendimentoRow._rowNumber, {
      ...atendimentoRow,
      'Status (Atendido/Fechado)': 'Não convertido',
    });
    await marcarResultadoAvaliacao(sessionId, 'Não convertido');
    logger.info(
      `[conversion] Sessao ${sessionId} classificada como "${classification.categoryName || category}"` +
      `${classification.categoryDescription ? ` (${classification.categoryDescription.trim()})` : ''} — marcada Nao convertido.`
    );
    return { outcome: 'perdido', category };
  }

  if (config.classificationCategories.WON && category === config.classificationCategories.WON) {
    const jaExiste = await sheets.findRowByColumn('conversoes', 'Session ID (GymBot)', sessionId);
    if (!jaExiste) {
      // Reforca contactDetails quando a sessao vem sem esse dado — ver
      // flwchat.ensureContactDetails. Mantem fallback pro valor ja
      // gravado em Atendimentos, caso nem o reforco encontre nada.
      const contactDetails = await flwchat.ensureContactDetails(session, logger);
      const atendente = await flwchat.resolveAgentName(session, logger);
      const { marca: marcaTag, unidade } = resolveMarcaUnidade(extractTagsId(contactDetails));
      const marcaResolvida = resolveMarcaPorAtendente(atendente) || resolveMarcaPorAtendente(atendimentoRow.Atendente);
      const marca = marcaResolvida || marcaTag || atendimentoRow.Marca || '';
      const dataClassificacao = session.updatedAt || nowLocal().toISO();
      const contactIdAtual = contactDetails?.id || atendimentoRow['Contact ID (GymBot)'];

      // Origem do calculo de "Dias ate Conversao": data do PRIMEIRO
      // atendimento deste lead (mede "quanto tempo o lead levou pra virar
      // cliente", incluindo reativacao) — mesma logica ja usada antes na
      // varredura de reconciliacao.
      const primeiroAtendimento = await sheets.findEarliestRowByColumn(
        'atendimentos', 'Contact ID (GymBot)', contactIdAtual, 'Data/Hora'
      );
      const dataOrigemLead = primeiroAtendimento?.['Data/Hora'] || atendimentoRow['Data/Hora'];

      await sheets.appendRow('conversoes', {
        'Data/Hora': dataClassificacao,
        Marca: marca,
        Unidade: unidade || atendimentoRow.Unidade || '',
        Atendente: atendente || atendimentoRow.Atendente || '',
        Lead: contactDetails?.name || atendimentoRow.Lead || '',
        Valor: classification.amount ?? '',
        'Session ID (GymBot)': sessionId,
        // Motivo especifico (ex: "Renovação pelo link"), nao so a
        // categoria generica — mais util pro Manual de Boas Praticas.
        Motivo: classification.categoryDescription?.trim() || classification.categoryName || category,
        'Dias até Conversão': dataOrigemLead
          ? Math.max(0, Math.round(diffInDays(dataOrigemLead, dataClassificacao)))
          : '',
        'Contact ID (GymBot)': contactIdAtual || '',
      });
    }

    await sheets.updateRow('atendimentos', atendimentoRow._rowNumber, {
      ...atendimentoRow,
      'Status (Atendido/Fechado)': 'Fechado',
    });
    await marcarResultadoAvaliacao(sessionId, 'Convertido');
    logger.info(`[conversion] Sessao ${sessionId} classificada como "${classification.categoryName || category}" — CONVERSAO registrada.`);
    return { outcome: 'convertido', category };
  }

  // Categoria recebida mas nao reconhecida (nem LOST nem o WON
  // configurado) — provavelmente "Objetivo atingido" (ainda nao
  // confirmado) ou "Duvidas". NAO tratamos como conversao por chute.
  logger.warn(
    `[conversion] Sessao ${sessionId} veio com classification.category = "${category}" ` +
    `(categoryName: "${classification.categoryName || '?'}", categoryDescription: "${classification.categoryDescription || '?'}") ` +
    '— valor ainda NAO mapeado em config.classificationCategories (so "LOST" esta confirmado ate agora). ' +
    'Nenhuma acao automatica foi tomada, pra nao gravar um resultado errado com base em um valor nao confirmado. ' +
    `Se este for o caso "Objetivo atingido" (Ganho), defina a variavel de ambiente ` +
    `CLASSIFICATION_CATEGORY_WON=${category} (Railway) pra passar a reconhecer esta categoria — nao precisa nem de novo deploy.`
  );
  return { outcome: 'categoria-desconhecida', category, categoryName: classification.categoryName };
}

module.exports = { registerConversionOutcome, marcarResultadoAvaliacao };
