// Para cada atendente com atendimentos no periodo, pede pra Claude ate tres
// analises separadas: uma olhando so para os atendimentos que CONVERTERAM
// ("o que funcionou, para replicar"), outra olhando so para os que NAO
// CONVERTERAM ("o que travou, para corrigir"), e outra olhando para os que
// ainda estao EM ABERTO (sem desfecho definido ainda — avalia a qualidade
// do atendimento em si, nao o resultado). Isso da um retrato mais acionavel
// do que uma sintese unica e generica, e garante que o relatorio diario
// (onde quase tudo ainda esta "Em aberto") sempre tenha alguma leitura
// qualitativa, nao so nos dias em que algo ja converteu ou foi descartado.
// `manualContext` (opcional) e o Manual de Boas Praticas atual da marca —
// passado pelo relatorio semanal/mensal (ver src/reports/send.js), para
// que a analise do periodo dialogue com o que ja esta consolidado.
const claude = require('../clients/claude');

async function synthesizeAttendants(porAtendente, periodoLabel, manualContext) {
  const resultados = [];
  for (const entry of porAtendente) {
    // Percentuais objetivos ja calculados (src/reports/compute.js) — cada
    // segmento leva o seu para o prompt da Claude (contexto, nao para ela
    // recalcular) e para o texto final do relatorio (impresso direto,
    // sem depender do texto gerado — pedido explicito do usuario).
    const item = { atendente: entry.atendente, metricas: entry.metricas };

    if (entry.avaliacoesConvertidas.length) {
      // eslint-disable-next-line no-await-in-loop
      item.convertidos = await claude.synthesizeSegment(
        entry.atendente, periodoLabel, 'convertido', entry.avaliacoesConvertidas,
        manualContext, entry.metricas.convertidos
      );
    } else {
      item.convertidos = null;
    }

    if (entry.avaliacoesNaoConvertidas.length) {
      // eslint-disable-next-line no-await-in-loop
      item.naoConvertidos = await claude.synthesizeSegment(
        entry.atendente, periodoLabel, 'nao_convertido', entry.avaliacoesNaoConvertidas,
        manualContext, entry.metricas.naoConvertidos
      );
    } else {
      item.naoConvertidos = null;
    }

    // "Em aberto": atendimento feito, lead ainda sem decisao (a grande
    // maioria no relatorio diario). Avalia a qualidade do atendimento em
    // si, independente do desfecho ainda nao existir — ver comentario em
    // src/reports/compute.js.
    if (entry.avaliacoesEmAberto.length) {
      // eslint-disable-next-line no-await-in-loop
      item.emAberto = await claude.synthesizeSegment(
        entry.atendente, periodoLabel, 'em_aberto', entry.avaliacoesEmAberto,
        manualContext, entry.metricas.emAberto
      );
    } else {
      item.emAberto = null;
    }

    resultados.push(item);
  }
  return resultados;
}

module.exports = { synthesizeAttendants };
