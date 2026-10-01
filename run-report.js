// Ferramenta de teste — execucao UNICA e MANUAL. NAO faz parte do
// agendamento normal do servico (isso continua em src/jobs/scheduler.js,
// 22:00 todos os dias). Serve pra gerar o relatorio de um dia especifico
// sob demanda — util pra testar o pipeline inteiro (varredura de
// reconciliacao -> calculo -> formatacao -> envio no WhatsApp) contra
// dado real, sem esperar o horario do cron ou o dia seguinte.
// CORTE DO QUALITATIVO (28/09/2026): nao chama mais Claude em nenhum
// ponto — nem aqui, nem no relatorio real.
//
// ATENCAO: por padrao ESTE SCRIPT ENVIA DE VERDADE pros dois grupos do
// WhatsApp (Greco Forma e Fit.com) — mesmo comportamento do relatorio real,
// so que pra uma data escolhida por voce em vez de "hoje". Use --dry-run se
// quiser só ver o texto do relatório no console, sem mandar nada.
//
// A varredura de reconciliacao roda ANTES (mesmo comportamento do
// relatorio real) — ela pode gravar conversoes novas e atualizar o status
// de atendimentos/avaliacoes reais nas planilhas, independente da flag
// --dry-run (a varredura nao é sobre "qual dia estamos reportando", é
// sobre manter as planilhas em dia). Use --skip-sweep se quiser pular essa
// etapa (mais rapido, sem chamadas a API do GymBot, mas os numeros podem
// estar desatualizados).
//
// Uso (Railway Console):
//   node scripts/run-report.js 2026-08-20
//   node scripts/run-report.js 2026-08-20 --dry-run
//   node scripts/run-report.js 2026-08-20 --skip-sweep
//   node scripts/run-report.js 2026-08-20 diario --dry-run --skip-sweep
//
// Por enquanto só suporta o tipo "diario" (um dia inteiro, 00:00-23:59 no
// fuso configurado) — semanal/mensal usam uma janela diferente e não foram
// o pedido original; da pra estender depois se precisar.
require('dotenv').config();
const { DateTime } = require('luxon');
const { config } = require('../src/config');
const { nowLocal } = require('../src/utils/dates');
const logger = require('../src/utils/logger');

const args = process.argv.slice(2);
const dataArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const tipo = args.find((a) => ['diario', 'semanal', 'mensal'].includes(a)) || 'diario';
const dryRun = args.includes('--dry-run');
const skipSweep = args.includes('--skip-sweep');

if (!dataArg) {
  logger.error('[run-report] Uso: node scripts/run-report.js YYYY-MM-DD [diario|semanal|mensal] [--dry-run] [--skip-sweep]');
  process.exit(1);
}

if (tipo !== 'diario') {
  logger.error('[run-report] Por enquanto so o tipo "diario" e suportado por este script.');
  process.exit(1);
}

async function run() {
  const dia = DateTime.fromISO(dataArg, { zone: config.timezone });
  if (!dia.isValid) {
    logger.error(`[run-report] Data invalida: ${dataArg}`);
    process.exit(1);
  }

  const periodo = { start: dia.startOf('day'), end: dia.endOf('day') };
  const dataLabel = dia.toFormat('dd/MM/yyyy');

  logger.info(
    `[run-report] Gerando relatorio ${tipo} de ${dataLabel} ` +
    `(${dryRun ? 'DRY-RUN — nada sera enviado ao WhatsApp' : 'ENVIO REAL para o WhatsApp'}, ` +
    `varredura de reconciliacao ${skipSweep ? 'DESATIVADA' : 'ativa'}). ` +
    `Rodando as ${nowLocal().toFormat('dd/MM/yyyy HH:mm:ss')}.`
  );

  if (dryRun) {
    // Modo dry-run: reproduz o mesmo pipeline de src/reports/send.js, mas
    // so imprime o texto no console — nao grava sintese, nao envia
    // WhatsApp. Reaproveita as mesmas funcoes que o relatorio real usa,
    // pra garantir que o que voce ve aqui e exatamente o que seria
    // enviado.
    const { runReconciliationSweep } = require('../src/reconciliation/sweep');
    const { computeReportData } = require('../src/reports/compute');
    const { formatReport } = require('../src/reports/format');

    if (!skipSweep) {
      logger.info('[run-report] Rodando varredura de reconciliacao...');
      try {
        await runReconciliationSweep();
      } catch (err) {
        logger.error(`[run-report] Varredura falhou, seguindo mesmo assim: ${err.message}`);
      }
    }

    for (const marca of config.marcas) {
      // eslint-disable-next-line no-await-in-loop
      const data = await computeReportData(marca, periodo);
      const texto = formatReport({
        marca, tipoLabel: 'Diário', dataLabel, data,
      });
      console.log(`\n========== DRY-RUN — ${marca} — ${dataLabel} (nada foi enviado) ==========`);
      console.log(texto);
      console.log('========== FIM ==========\n');
    }

    logger.info('[run-report] Dry-run concluido — nenhuma sintese gravada, nada enviado ao WhatsApp.');
    process.exit(0);
    return;
  }

  // Envio real: reaproveita a MESMA funcao que o cron usa em producao
  // (src/jobs/scheduler.js), so passando periodo/dataLabel/skipSweep
  // explicitos em vez de deixar ela calcular "hoje" sozinha.
  const { generateAndSendReports } = require('../src/reports/send');
  await generateAndSendReports(tipo, { periodo, dataLabel, skipSweep });
  logger.info('[run-report] Concluido — verifique os dois grupos do WhatsApp.');
  process.exit(0);
}

run().catch((err) => {
  logger.error('[run-report] Erro fatal:', err);
  process.exit(1);
});
