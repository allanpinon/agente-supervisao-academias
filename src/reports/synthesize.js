// Para cada atendente com atendimentos no periodo, pede pra Claude
// sintetizar as avaliacoes individuais (ja gravadas em "Avaliações") num
// resumo qualitativo: avaliacao geral, volume/tipos de objecao, pontos
// fortes e fracos consolidados, e uma sugestao pratica pro proximo periodo.
const claude = require('../clients/claude');

async function synthesizeAttendants(porAtendente, periodoLabel) {
  const resultados = [];
  for (const entry of porAtendente) {
    if (!entry.avaliacoes.length) {
      resultados.push({
        atendente: entry.atendente,
        sintese: {
          avaliacaoGeral: 'Sem atendimentos avaliados neste período.',
          volumeObjecoes: '—',
          pontosFortesConsolidados: [],
          pontosFracosConsolidados: [],
          sugestaoMelhoria: '—',
        },
      });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const sintese = await claude.synthesizePeriod(entry.atendente, periodoLabel, entry.avaliacoes);
    resultados.push({ atendente: entry.atendente, sintese });
  }
  return resultados;
}

module.exports = { synthesizeAttendants };
