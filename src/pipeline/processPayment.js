// Trata o evento PAYMENT_NEW do webhook do GymBot.
//
// Decisao de design: este evento e apenas logado, NAO grava nada na
// planilha de Conversoes. A fonte da verdade para conversao e a varredura
// de reconciliacao (src/reconciliation/sweep.js), que le
// classification.category diretamente da sessao. Ter dois caminhos
// diferentes escrevendo "Conversoes" (um via PAYMENT_NEW em tempo real,
// outro via varredura) criaria risco de duplicidade ou de conflito de
// datas/valores. Se no futuro fizer sentido usar PAYMENT_NEW para acelerar
// a deteccao de uma venda, ligar isso aqui exige cuidado extra de dedup.
const logger = require('../utils/logger');

async function processPaymentNew(payment) {
  logger.info(`[processPayment] Evento PAYMENT_NEW recebido (somente log): ${JSON.stringify(payment)}`);
}

module.exports = { processPaymentNew };
