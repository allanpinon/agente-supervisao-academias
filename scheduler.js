// Agendamentos (node-cron): diario 22:00, semanal segunda-feira 08:00, e
// mensal no ultimo dia do mes (disparado junto com o job diario das 22:00).
const cron = require('node-cron');
const { generateAndSendReports } = require('../reports/send');
const { isLastDayOfMonth } = require('../utils/dates');
const { config } = require('../config');
const logger = require('../utils/logger');

function startScheduler() {
  // Diario — todos os dias as 22:00. Se hoje for o ultimo dia do mes,
  // dispara tambem o relatorio mensal logo em seguida.
  //
  // IMPORTANTE: o callback do node-cron precisa de try/catch proprio.
  // Sem isso, um erro nao tratado dentro dele vira uma promise rejeitada
  // sem ninguem escutando — o que, dependendo da versao do Node, pode
  // derrubar o processo inteiro do servico (inclusive o webhook, que nao
  // tem nada a ver com relatorio). Foi isso que aconteceu antes desta
  // correcao: um erro na geracao do relatorio podia tirar o servico do ar
  // ate o Railway reiniciar, e o relatorio nunca chegava a ser reenviado.
  cron.schedule(
    '0 22 * * *',
    async () => {
      try {
        await generateAndSendReports('diario');
        if (isLastDayOfMonth()) {
          await generateAndSendReports('mensal');
        }
      } catch (err) {
        logger.error('[scheduler] Falha no job diario/mensal:', err.message);
      }
    },
    { timezone: config.timezone }
  );

  // Semanal — toda segunda-feira as 08:00.
  cron.schedule(
    '0 8 * * 1',
    async () => {
      try {
        await generateAndSendReports('semanal');
      } catch (err) {
        logger.error('[scheduler] Falha no job semanal:', err.message);
      }
    },
    { timezone: config.timezone }
  );

  logger.info(
    '[scheduler] Agendamentos ativos: diario 22:00, semanal segunda-feira 08:00, ' +
    'mensal no ultimo dia do mes (junto com o diario).'
  );
}

module.exports = { startScheduler };
