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
  cron.schedule(
    '0 22 * * *',
    async () => {
      await generateAndSendReports('diario');
      if (isLastDayOfMonth()) {
        await generateAndSendReports('mensal');
      }
    },
    { timezone: config.timezone }
  );

  // Semanal — toda segunda-feira as 08:00.
  cron.schedule(
    '0 8 * * 1',
    async () => {
      await generateAndSendReports('semanal');
    },
    { timezone: config.timezone }
  );

  logger.info(
    '[scheduler] Agendamentos ativos: diario 22:00, semanal segunda-feira 08:00, ' +
    'mensal no ultimo dia do mes (junto com o diario).'
  );
}

module.exports = { startScheduler };
