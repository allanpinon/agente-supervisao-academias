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
const { nowLocal } = require('../utils/dates');
const { evaluateAndRecordSession } = require('../pipeline/evaluate');
const { registerConversionOutcome, marcarResultadoAvaliacao } = require('../pipeline/conversion');
const logger = require('../utils/logger');

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

    // Fecha a leitura QUALITATIVA de todo atendimento pendente, independente
    // do status atual (Em andamento/Atendido) — pedido explicito do usuario
    // (22/08/2026): "o qualitativo precisa ser fechado independente do
    // status atual". Antes desta correcao, um atendimento so ganhava uma
    // linha em Avaliações quando o SESSION_COMPLETE do GymBot chegava (ver
    // src/pipeline/processSession.js) — se isso ainda nao tivesse
    // acontecido no momento do relatorio (sessao ainda "Em andamento", ex:
    // atendente ainda nao assumiu a conversa, ou o evento simplesmente
    // ainda nao chegou), o atendimento ficava com dado quantitativo
    // (aparecia em "Por atendente"/totais) mas NENHUM dado qualitativo —
    // nem "Convertido"/"Nao convertido" nem "Em aberto", pois nao existia
    // linha nenhuma em Avaliações pra ele (achado real ao investigar por
    // que a Samia Borges aparecia sem secao qualitativa em 20/08/2026).
    // evaluateAndRecordSession ja e idempotente (verifica se ja existe
    // avaliacao pra esta Session ID antes de gastar qualquer chamada —
    // Claude incluida — e ja tolera sessao sem mensagem alguma, retornando
    // sem gravar nada), entao chamar aqui pra toda sessao pendente e seguro
    // e so gera uma avaliacao nova de fato na primeira vez que a sessao e
    // vista sem uma. Ressalva: se a sessao ainda estiver "Em andamento" e a
    // conversa continuar depois deste ponto, a avaliacao gravada agora fica
    // baseada no transcript parcial ate aqui — nao e re-executada
    // automaticamente depois (mesma limitacao, documentada, do desenho
    // atual de "uma avaliacao por sessao").
    try {
      await evaluateAndRecordSession(session);
    } catch (err) {
      logger.warn(`[sweep] Falha ao gerar avaliacao qualitativa da sessao ${sessionId}: ${err.message}`);
    }

    // ACHADO CRITICO (26/08/2026): esta releitura via GET NUNCA traz
    // classification preenchido (confirmado com dado real — ver
    // src/pipeline/conversion.js pro relato completo), entao este trecho
    // na pratica nunca encontra nada hoje. Mantido mesmo assim (via o
    // helper compartilhado registerConversionOutcome, tambem usado em
    // tempo real por processSessionComplete) como rede de seguranca
    // barata, caso a API do GymBot passe a preencher esse campo no GET no
    // futuro — e pra nao duplicar a logica de gravar Conversao/marcar
    // Resultado em dois lugares.
    try {
      const resultado = await registerConversionOutcome(session, row);
      if (resultado.outcome === 'convertido') novasConversoes += 1;
    } catch (err) {
      logger.warn(`[sweep] Falha ao registrar resultado (conversao/nao convertido) da sessao ${sessionId}: ${err.message}`);
    }
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
