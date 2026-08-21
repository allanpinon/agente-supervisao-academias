// Espera crescente (backoff exponencial) para reexecutar chamadas de API
// que falharam por limite de requisicoes por minuto (HTTP 429, ou
// mensagens tipo "quota exceeded"/"rate limit"/"limite excedido").
//
// Usado tanto pelo Google Sheets quanto pela API do GymBot — os dois tem
// limites por minuto que estouram facilmente durante a importacao
// historica (milhares de sessoes processadas em sequencia). Sem isso, uma
// chamada que esbarra no limite falha na hora e a sessao inteira e
// perdida (foi o que aconteceu antes desta correcao: sessoes que
// receberam 429 ficavam de fora das planilhas, sem aviso claro).
const logger = require('./logger');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err) {
  // O SDK da Anthropic poe o status HTTP direto em err.status (nao em
  // err.response.status, que e o formato do axios usado pelo GymBot/Sheets)
  // — sem checar esse campo tambem, um 429 da API da Claude nunca seria
  // reconhecido como erro de limite e cairia direto no catch de quem
  // chamou, sem nenhuma tentativa de repetir.
  const status = err?.status || err?.response?.status || err?.code;
  if (status === 429) return true;
  const msg = err?.message || '';
  const details = JSON.stringify(err?.response?.data || err?.errors || '');
  return (
    /quota exceeded/i.test(msg)
    || /quota exceeded/i.test(details)
    || /rate limit/i.test(msg)
    || /limite excedido/i.test(details)
  );
}

async function withRetry(fn, { retries = 6, baseDelayMs = 3000, label = '' } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fn();
    } catch (err) {
      if (!isRateLimitError(err) || attempt >= retries) throw err;
      const delay = baseDelayMs * 2 ** attempt;
      logger.warn(
        `[retry]${label ? ` ${label}:` : ''} limite de requisicoes atingido — tentando de novo ` +
        `em ${Math.round(delay / 1000)}s (tentativa ${attempt + 1}/${retries}).`
      );
      // eslint-disable-next-line no-await-in-loop
      await sleep(delay);
    }
  }
}

module.exports = { withRetry, isRateLimitError, sleep };
