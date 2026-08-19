// Varredura de reconciliacao — SEMPRE roda antes de gerar qualquer
// relatorio (diario/semanal/mensal).
//
// Por que existe: a classificacao do GymBot ("Objetivo atingido" etc.) e
// feita manualmente pelas atendentes, com atraso relevante — na amostra
// real fornecida, 630 atendimentos ainda estavam sem classificacao contra
// apenas 75 marcados "Objetivo atingido". Se o servico confiasse so no
// SESSION_COMPLETE em tempo real, ele subcontaria conversoes de forma
// sistematica. Por isso, antes de cada relatorio, revisitamos todo
// atendimento ainda nao marcado "Fechado" dentro da janela de
// reconciliacao e reconferimos o status oficial direto na API.
const flwchat = require('../clients/flwchat');
const sheets = require('../clients/sheets');
const { config } = require('../config');
const { resolveMarcaUnidade } = require('../utils/tags');
const { nowLocal, diffInDays } = require('../utils/dates');
const logger = require('../utils/logger');

async function runReconciliationSweep() {
  const rows = await sheets.readAll('atendimentos');
  const cutoff = nowLocal().minus({ days: config.reconciliation.lookbackDays });

  const pending = rows.filter((r) => {
    if (r['Status (Atendido/Fechado)'] === 'Fechado') return false;
    if (!r['Data/Hora']) return true;
    const rowDate = new Date(r['Data/Hora']);
    if (Number.isNaN(rowDate.getTime())) return true;
    return rowDate >= cutoff.toJSDate();
  });

  logger.info(`[sweep] Varredura de reconciliacao: ${pending.length} atendimento(s) pendente(s) a reconferir.`);

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
      const { marca, unidade } = resolveMarcaUnidade(session.contactDetails?.tagsId || []);
      const dataClassificacao = session.updatedAt || nowLocal().toISO();
      const dataOrigemLead = session.contactDetails?.createdAt || row['Data/Hora'];

      await sheets.appendRow('conversoes', {
        'Data/Hora': dataClassificacao,
        Marca: marca || row.Marca || '',
        Unidade: unidade || row.Unidade || '',
        Atendente: session.agentDetails?.name || row.Atendente || '',
        Lead: session.contactDetails?.name || row.Lead || '',
        Valor: session.classification?.amount ?? '',
        'Session ID (GymBot)': sessionId,
        Motivo: category,
        'Dias até Conversão': dataOrigemLead
          ? Math.max(0, Math.round(diffInDays(dataOrigemLead, dataClassificacao)))
          : '',
        'Contact ID (GymBot)': session.contactDetails?.id || row['Contact ID (GymBot)'] || '',
      });
      novasConversoes += 1;
    }

    await sheets.updateRow('atendimentos', row._rowNumber, {
      ...row,
      'Status (Atendido/Fechado)': 'Fechado',
    });
  }

  logger.info(`[sweep] Varredura concluida: ${novasConversoes} nova(s) conversao(oes) registrada(s).`);
  return { verificados: pending.length, novasConversoes };
}

module.exports = { runReconciliationSweep };
