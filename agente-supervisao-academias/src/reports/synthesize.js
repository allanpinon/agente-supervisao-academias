// Para cada atendente com atendimentos no periodo, pede pra Claude duas
// analises separadas: uma olhando so para os atendimentos que
// CONVERTERAM ("o que funcionou, para replicar") e outra olhando so para
// os que NAO CONVERTERAM ("o que travou, para corrigir"). Isso da um
// retrato mais acionavel do que uma sintese unica e generica.
// `manualContext` (opcional) e o Manual de Boas Praticas atual da marca —
// passado pelo relatorio semanal/mensal (ver src/reports/send.js), para
// que a analise do periodo dialogue com o que ja esta consolidado.
const claude = require('../clients/claude');

async function synthesizeAttendants(porAtendente, periodoLabel, manualContext) {
  const resultados = [];
  for (const entry of porAtendente) {
    const item = { atendente: entry.atendente };

    if (entry.avaliacoesConvertidas.length) {
      // eslint-disable-next-line no-await-in-loop
      item.convertidos = await claude.synthesizeSegment(
        entry.atendente, periodoLabel, 'convertido', entry.avaliacoesConvertidas, manualContext
      );
    } else {
      item.convertidos = null;
    }

    if (entry.avaliacoesNaoConvertidas.length) {
      // eslint-disable-next-line no-await-in-loop
      item.naoConvertidos = await claude.synthesizeSegment(
        entry.atendente, periodoLabel, 'nao_convertido', entry.avaliacoesNaoConvertidas, manualContext
      );
    } else {
      item.naoConvertidos = null;
    }

    resultados.push(item);
  }
  return resultados;
}

module.exports = { synthesizeAttendants };
