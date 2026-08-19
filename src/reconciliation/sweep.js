// Varredura de reconciliacao — SEMPRE roda antes de gerar qualquer
// relatorio (diario/semanal/mensal).
//
// Por que existe: a classificacao do GymBot ("Objetivo atingido" etc.) e
// feita manualmente pelas atendentes, com atraso relevante — na amostra
// real fornecida, 630 atendimentos ainda estavam sem classificacao contra
// apenas 75 marcados "Objetivo atingido". Se o servico confiasse so no
// SESSION_COMPLETE em tempo real, ele subcontaria conversoes de forma
// sistematica. Por isso, antes de cada relatorio, revisitamos todo
// atendimento ainda nao finalizado dentro da janela de reconciliacao e
// reconferimos o status oficial direto na API.
//
// Alem de gravar a conversao, a varredura tambem atualiza a coluna
// "Resultado" da avaliacao qualitativa correspondente (Convertido / Nao
// convertido) — isso alimenta a analise segmentada dos relatorios e o
// Manual de Boas Praticas.
const flwchat = require('../clients/flwchat');
const sheets = require('../clients/sheets');
const { config } = require('../config');
const { resolveMarcaUnidade } = require('../utils/tags');
const { nowLocal, diffInDays } = require('../utils/dates');
const logger = require('../utils/logger');

async function marcarResultadoAvaliacao(sessionId, resultado) {
  if (!sessionId) return;
  const avaliacao = await sheets.findRowByColumn('avaliacoes', 'Session ID (GymBot)', sessionId);
  if (!avaliacao) return;
  if (avaliacao.Resultado === resultado) return; // ja esta certo, evita escrita desnecessaria
  await sheets.updateRow('avaliacoes', avaliacao._rowNumber, { ...avaliacao, Resultado: resultado });
}

async function runReconciliationSweep() {
  const rows = await sheets.readAll('atendimentos');
  const cutoff = nowLocal().minus({ days: config.reconciliation.lookbackDays });

  // "pending": ainda dentro da janela — vale a pena reconferir na API.
  // "expirados": ja passou da janela sem fechar — damos como "Nao
  // convertido" definitivo, sem gastar mais chamadas de API com eles.
  const pending = [];
  const expirados = [];

  rows.forEach((r) => {
    const status = r['Status (Atendido/Fechado)'];
    if (status === 'Fechado' || status === 'Não convertido') return;

    const rowDate = r['Data/Hora'] ? new Date(r['Data/Hora']) : null;
    const dataValida = rowDate && !Number.isNaN(rowDate.getTime());

    if (!dataValida || rowDate >= cutoff.toJSDate()) {
      pending.push(r);
    } else {
      expirados.push(r);
    }
  });

  logger.info(
    `[sweep] Varredura de reconciliacao: ${pending.length} pendente(s) a reconferir, ` +
    `${expirados.length} expirado(s) a finalizar como "Nao convertido".`
  );

  let novasConversoes = 0;

  for (const row of pending) {
    const sessionId = row['Session ID (GymBot)'];
    if (!sessionId) continue;

    let session;
    try {
      session = await flwchat.getSession(sessionId);
    } catch (err) {
      logger.warn(`[sweep] Falha ao rebuscar sessao ${sessionId}: ${err.message}`);
      continue;
    }

    const category = session.classification?.category;
    if (category !== config.classificationSuccessCategory) continue;

    const jaExiste = await sheets.findRowByColumn('conversoes', 'Session ID (GymBot)', sessionId);
    if (!jaExiste) {
      // Reforca contactDetails quando a sessao vem sem esse dado — ver
      // flwchat.ensureContactDetails. Mesmo assim mantemos o fallback pro
      // valor ja gravado em Atendimentos, caso nem o reforco encontre nada.
      const contactDetails = await flwchat.ensureContactDetails(session, logger);
      const { marca, unidade } = resolveMarcaUnidade(contactDetails?.tagsId || []);
      const dataClassificacao = session.updatedAt || nowLocal().toISO();
      const dataOrigemLead = contactDetails?.createdAt || row['Data/Hora'];

      await sheets.appendRow('conversoes', {
        'Data/Hora': dataClassificacao,
        Marca: marca || row.Marca || '',
        Unidade: unidade || row.Unidade || '',
        Atendente: session.agentDetails?.name || row.Atendente || '',
        Lead: contactDetails?.name || row.Lead || '',
        Valor: session.classification?.amount ?? '',
        'Session ID (GymBot)': sessionId,
        Motivo: category,
        'Dias até Conversão': dataOrigemLead
          ? Math.max(0, Math.round(diffInDays(dataOrigemLead, dataClassificacao)))
          : '',
        'Contact ID (GymBot)': contactDetails?.id || row['Contact ID (GymBot)'] || '',
      });
      novasConversoes += 1;
    }

    await sheets.updateRow('atendimentos', row._rowNumber, {
      ...row,
      'Status (Atendido/Fechado)': 'Fechado',
    });
    await marcarResultadoAvaliacao(sessionId, 'Convertido');
  }

  for (const row of expirados) {
    const sessionId = row['Session ID (GymBot)'];
    await sheets.updateRow('atendimentos', row._rowNumber, {
      ...row,
      'Status (Atendido/Fechado)': 'Não convertido',
    });
    await marcarResultadoAvaliacao(sessionId, 'Não convertido');
  }

  logger.info(
    `[sweep] Varredura concluida: ${novasConversoes} nova(s) conversao(oes), ` +
    `${expirados.length} finalizada(s) como "Nao convertido".`
  );
  return { verificados: pending.length, novasConversoes, expirados: expirados.length };
}

module.exports = { runReconciliationSweep, marcarResultadoAvaliacao };
