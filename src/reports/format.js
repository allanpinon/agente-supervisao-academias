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
    .map(({
      atendente, convertidos, naoConvertidos, emAberto,
    }) => {
      const partes = [`*${atendente}*`];

      if (convertidos) {
        const padroes = convertidos.padroes?.length ? convertidos.padroes.join(', ') : '—';
        partes.push(
          `✅ O que funcionou (atendimentos convertidos): ${convertidos.resumo}\n` +
          `Padrões: ${padroes}\n` +
          `Reforçar: ${convertidos.recomendacao}`
        );
      }

      if (naoConvertidos) {
        const padroes = naoConvertidos.padroes?.length ? naoConvertidos.padroes.join(', ') : '—';
        partes.push(
          `⚠️ O que travou (atendimentos não convertidos): ${naoConvertidos.resumo}\n` +
          `Padrões: ${padroes}\n` +
          `Corrigir: ${naoConvertidos.recomendacao}`
        );
      }

      // "Em aberto": lead ainda sem decisao — a maioria no relatorio
      // diario. Sem isso, o relatorio diario quase sempre ficava sem
      // nenhuma leitura qualitativa (ver src/reports/compute.js).
      if (emAberto) {
        const padroes = emAberto.padroes?.length ? emAberto.padroes.join(', ') : '—';
        partes.push(
          `🔎 Atendimentos em aberto (ainda sem resultado): ${emAberto.resumo}\n` +
          `Padrões: ${padroes}\n` +
          `Ajustar: ${emAberto.recomendacao}`
        );
      }

      if (!convertidos && !naoConvertidos && !emAberto) {
        partes.push('Sem atendimentos com resultado definido neste período.');
      }

      return partes.join('\n');
    })
    .join('\n\n');

  return (
    `📋 *${marca} — Relatório ${tipoLabel}* — ${dataLabel}\n\n` +
    `*QUANTITATIVO*\n` +
    `Leads novos: ${data.leadsTotal}\n` +
    `Canal: ${canalTexto || '—'}\n\n` +
    `Por unidade:\n${linhasUnidade || '—'}\n\n` +
    `Por atendente:\n${linhasAtendenteQuant || '—'}\n\n` +
    `Conversão geral: ${pct(data.conversaoGeralPercent)} | Tempo médio até conversão: ${tempoConversaoTexto}\n\n` +
    `*QUALITATIVO*\n${blocosQualitativos || '—'}`
  );
}

module.exports = { formatReport };
