// Ponto de entrada do servico: sobe o servidor Express (recebe o webhook
// do GymBot) e liga os agendamentos dos relatorios.
const express = require('express');
const { config, assertConfigured } = require('./config');
const { webhookHandler } = require('./webhook/handler');
const { startScheduler } = require('./jobs/scheduler');
const logger = require('./utils/logger');

assertConfigured();

const app = express();
app.use(express.json({ limit: '5mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'agente-supervisao-academias' });
});

app.post('/webhook/gymbot', webhookHandler);

app.listen(config.port, () => {
  logger.info(`[index] Servico rodando na porta ${config.port}.`);
  startScheduler();
});
