// Monta o texto final do relatorio (formato WhatsApp: texto corrido,
// *negrito*, sem tabelas).
//
// CORTE DO QUALITATIVO (28/09/2026): decisao explicita do usuario apos 2
// semanas em producao (3 motivos: numeros nao batiam com o GymBot,
// conflito com a central de vendas, e o qualitativo gerado pela Claude
// nao fazia sentido). Este arquivo agora so imprime QUANTITATIVO — leads
// recebidos e leads atendidos, sempre ramificados por atendente, unidade
// e marca, mais Ganho/Perdido (que ja vinham gravados em tempo real via
// webhook, sem custo de API) — tudo contagem direta da planilha, sem
// nenhuma chamada a Claude.
function pct(n) {
  return `${n.toFixed(1)}%`;
}

function formatReport({
  marca, tipoLabel, dataLabel, data,
}) {
  const linhasUnidade = data.porUnidade
    .map((u) => `• ${u.unidade}: ${u.leads} leads, ${u.atendidos} atendidos, ${u.fechados} ganhos, ${u.perdidos} perdidos (${pct(u.conversaoPercent)})`)
    .join('\n');

  const linhasAtendente = data.porAtendente
    .map((a) => `• ${a.atendente}: ${a.atendidos} atendidos, ${a.fechados} ganhos, ${a.perdidos} perdidos (${pct(a.conversaoPercent)})`)
    .join('\n');

  const canalTexto = Object.entries(data.canalCounts)
    .map(([canal, n]) => `${canal} ${n}`)
    .join(' | ');

  const tempoConversaoTexto = data.tempoMedioConversaoDias !== null
    ? `${data.tempoMedioConversaoDias.toFixed(1)} dias`
    : 'sem conversões no período';

  // Status real dos atendimentos no momento em que o relatório fecha.
  // "Concluídos" agrega Atendido/Fechado/Não convertido (a conversa já
  // terminou); "Em andamento" é o único status que significa que a
  // conversa ainda está rolando — ver src/reports/compute.js.
  const statusTexto = data.statusAtendimentos
    ? `${data.statusAtendimentos.concluidos} concluído(s) | ${data.statusAtendimentos.emAndamento} em andamento`
    : '—';

  return (
    `📋 *${marca} — Relatório ${tipoLabel}* — ${dataLabel}\n\n` +
    `Leads novos: ${data.leadsTotal}\n` +
    `Canal: ${canalTexto || '—'}\n\n` +
    `Por unidade:\n${linhasUnidade || '—'}\n\n` +
    `Por atendente:\n${linhasAtendente || '—'}\n\n` +
    `Ganhos: ${data.fechadosGeral} | Perdidos: ${data.perdidosGeral} | Conversão geral: ${pct(data.conversaoGeralPercent)}\n` +
    `Tempo médio até conversão: ${tempoConversaoTexto}\n` +
    `Status dos atendimentos: ${statusTexto}`
  );
}

module.exports = { formatReport };
