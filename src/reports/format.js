// Monta o texto final do relatorio (formato WhatsApp: texto corrido,
// *negrito*, sem tabelas), seguindo o Modelo B aprovado.
function pct(n) {
  return `${n.toFixed(1)}%`;
}

function formatReport({ marca, tipoLabel, dataLabel, data, sinteses }) {
  const linhasUnidade = data.porUnidade
    .map((u) => `• ${u.unidade}: ${u.leads} leads, ${u.atendidos} atendidos, ${u.fechados} fechados (${pct(u.conversaoPercent)})`)
    .join('\n');

  const linhasAtendenteQuant = data.porAtendente
    .map((a) => `• ${a.atendente}: ${a.atendidos} atendidos, ${a.fechados} fechados (${pct(a.conversaoPercent)})`)
    .join('\n');

  const canalTexto = Object.entries(data.canalCounts)
    .map(([canal, n]) => `${canal} ${n}`)
    .join(' | ');

  const tempoConversaoTexto = data.tempoMedioConversaoDias !== null
    ? `${data.tempoMedioConversaoDias.toFixed(1)} dias`
    : 'sem conversões no período';

  const blocosQualitativos = sinteses
    .map(({ atendente, sintese }) => {
      const fortes = sintese.pontosFortesConsolidados?.length
        ? sintese.pontosFortesConsolidados.join(', ')
        : '—';
      const fracos = sintese.pontosFracosConsolidados?.length
        ? sintese.pontosFracosConsolidados.join(', ')
        : '—';
      return (
        `*${atendente}* — ${sintese.avaliacaoGeral}\n` +
        `Objeções: ${sintese.volumeObjecoes}\n` +
        `Pontos fortes: ${fortes}\n` +
        `Pontos fracos: ${fracos}\n` +
        `Sugestão: ${sintese.sugestaoMelhoria}`
      );
    })
    .join('\n\n');

  return (
    `📋 *${marca} — Relatório ${tipoLabel}* — ${dataLabel}\n\n` +
    `*QUANTITATIVO*\n` +
    `Leads novos: ${data.leadsTotal} (${data.pagos} pagos / ${data.organicos} orgânicos)\n` +
    `Canal: ${canalTexto || '—'}\n\n` +
    `Por unidade:\n${linhasUnidade || '—'}\n\n` +
    `Por atendente:\n${linhasAtendenteQuant || '—'}\n\n` +
    `Conversão geral: ${pct(data.conversaoGeralPercent)} | Tempo médio até conversão: ${tempoConversaoTexto}\n\n` +
    `*QUALITATIVO*\n${blocosQualitativos || '—'}`
  );
}

module.exports = { formatReport };
