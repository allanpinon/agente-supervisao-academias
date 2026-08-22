// Monta o texto final do relatorio (formato WhatsApp: texto corrido,
// *negrito*, sem tabelas), seguindo o Modelo B aprovado.
function pct(n) {
  return `${n.toFixed(1)}%`;
}

// Linha de percentuais objetivos por dimensao da rubrica — calculada em
// src/reports/compute.js direto das notas 1-5 gravadas, nunca narrada por
// Claude (pedido explicito do usuario: qualitativo objetivo, com
// percentuais reais, sem risco de numero inventado no texto gerado).
function formatMetricas(m) {
  if (!m) return null;
  const linhas = m.dimensoes
    .map((d) => `${d.label} ${d.percentOk !== null ? `${d.percentOk.toFixed(0)}%` : '—'}`)
    .join(' | ');
  const mediaGeral = m.mediaGeral !== null ? m.mediaGeral.toFixed(1) : '—';
  return `📊 ${linhas} (nota média ${mediaGeral}, n=${m.n})`;
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

  // Status real dos atendimentos no momento em que o relatório fecha —
  // pedido explícito do usuário (22/08/2026). "Concluídos" agrega
  // Atendido/Fechado/Não convertido (a conversa já terminou); "Em
  // andamento" é o único status que significa que a conversa ainda está
  // rolando — ver src/reports/compute.js.
  const statusTexto = data.statusAtendimentos
    ? `${data.statusAtendimentos.concluidos} concluído(s) | ${data.statusAtendimentos.emAndamento} em andamento`
    : '—';

  const blocosQualitativos = sinteses
    .map(({
      atendente, convertidos, naoConvertidos, emAberto, metricas,
    }) => {
      const partes = [`*${atendente}*`];

      if (convertidos) {
        const padroes = convertidos.padroes?.length ? convertidos.padroes.join(' • ') : '—';
        const metricasLinha = formatMetricas(metricas?.convertidos);
        partes.push(
          `✅ O que funcionou (atendimentos convertidos)${metricasLinha ? `\n${metricasLinha}` : ''}\n` +
          `${convertidos.resumo}\n` +
          `Padrões: ${padroes}\n` +
          `Reforçar: ${convertidos.recomendacao}`
        );
      }

      if (naoConvertidos) {
        const padroes = naoConvertidos.padroes?.length ? naoConvertidos.padroes.join(' • ') : '—';
        const metricasLinha = formatMetricas(metricas?.naoConvertidos);
        partes.push(
          `⚠️ O que travou (atendimentos não convertidos)${metricasLinha ? `\n${metricasLinha}` : ''}\n` +
          `${naoConvertidos.resumo}\n` +
          `Padrões: ${padroes}\n` +
          `Corrigir: ${naoConvertidos.recomendacao}`
        );
      }

      // "Em aberto": lead ainda sem decisao — a maioria no relatorio
      // diario. Sem isso, o relatorio diario quase sempre ficava sem
      // nenhuma leitura qualitativa (ver src/reports/compute.js).
      if (emAberto) {
        const padroes = emAberto.padroes?.length ? emAberto.padroes.join(' • ') : '—';
        const metricasLinha = formatMetricas(metricas?.emAberto);
        partes.push(
          `🔎 Atendimentos em aberto (ainda sem resultado)${metricasLinha ? `\n${metricasLinha}` : ''}\n` +
          `${emAberto.resumo}\n` +
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
    `Conversão geral: ${pct(data.conversaoGeralPercent)} | Tempo médio até conversão: ${tempoConversaoTexto}\n` +
    `Status dos atendimentos: ${statusTexto}\n\n` +
    `*QUALITATIVO*\n${blocosQualitativos || '—'}`
  );
}

module.exports = { formatReport };
