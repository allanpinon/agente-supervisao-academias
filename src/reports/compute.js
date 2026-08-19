// Calcula todas as metricas quantitativas de um relatorio, direto das
// planilhas — nenhum numero aproximado/estimado (exigencia confirmada
// pelo usuario). "Leads/atendidos/fechados" sao sempre deduplicados por
// lead unico (Contact ID do GymBot), nao por sessao, conforme decidido na
// revisao de gaps.
const { DateTime } = require('luxon');
const sheets = require('../clients/sheets');
const { config } = require('../config');

function inRange(isoString, start, end) {
  if (!isoString) return false;
  const dt = DateTime.fromISO(isoString);
  if (!dt.isValid) return false;
  return dt >= start && dt <= end;
}

function uniqueBy(list, key) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const k = item[key];
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

async function computeReportData(marca, { start, end }) {
  const [leads, atendimentos, conversoes, avaliacoes] = await Promise.all([
    sheets.readAll('leads'),
    sheets.readAll('atendimentos'),
    sheets.readAll('conversoes'),
    sheets.readAll('avaliacoes'),
  ]);

  const leadsMarca = leads.filter((l) => l.Marca === marca && inRange(l['Data/Hora'], start, end));
  const leadsUnicos = uniqueBy(leadsMarca, 'Contact ID (GymBot)');

  const atendimentosMarca = atendimentos.filter(
    (a) => a.Marca === marca && inRange(a['Data/Hora'], start, end)
  );
  const conversoesMarca = conversoes.filter(
    (c) => c.Marca === marca && inRange(c['Data/Hora'], start, end)
  );
  const avaliacoesMarca = avaliacoes.filter(
    (v) => v.Marca === marca && inRange(v['Data/Hora'], start, end)
  );

  const pagos = leadsUnicos.filter((l) => l['Origem (Paga/Orgânica)'] === 'Paga').length;
  const organicos = leadsUnicos.length - pagos;

  const canalCounts = {};
  leadsUnicos.forEach((l) => {
    const canal = l.Canal || 'Outro';
    canalCounts[canal] = (canalCounts[canal] || 0) + 1;
  });

  const unidades = [...new Set(
    Object.values(config.tagMap)
      .filter((t) => t.tipo === 'unidade' && t.marca === marca)
      .map((t) => t.unidade)
  )];

  const porUnidade = unidades.map((unidade) => {
    const leadsU = uniqueBy(leadsMarca.filter((l) => l.Unidade === unidade), 'Contact ID (GymBot)');
    const atendidosU = uniqueBy(
      atendimentosMarca.filter((a) => a.Unidade === unidade),
      'Contact ID (GymBot)'
    );
    const fechadosU = uniqueBy(
      conversoesMarca.filter((c) => c.Unidade === unidade),
      'Contact ID (GymBot)'
    );
    const conversao = leadsU.length ? (fechadosU.length / leadsU.length) * 100 : 0;
    return {
      unidade,
      leads: leadsU.length,
      atendidos: atendidosU.length,
      fechados: fechadosU.length,
      conversaoPercent: conversao,
    };
  });

  const atendentes = [...new Set(atendimentosMarca.map((a) => a.Atendente).filter(Boolean))];

  const porAtendente = atendentes.map((atendente) => {
    const atendidosA = uniqueBy(
      atendimentosMarca.filter((a) => a.Atendente === atendente),
      'Contact ID (GymBot)'
    );
    const fechadosA = uniqueBy(
      conversoesMarca.filter((c) => c.Atendente === atendente),
      'Contact ID (GymBot)'
    );
    const conversao = atendidosA.length ? (fechadosA.length / atendidosA.length) * 100 : 0;
    const avaliacoesA = avaliacoesMarca.filter((v) => v.Atendente === atendente);
    return {
      atendente,
      atendidos: atendidosA.length,
      fechados: fechadosA.length,
      conversaoPercent: conversao,
      avaliacoes: avaliacoesA,
    };
  });

  const fechadosGeralUnicos = uniqueBy(conversoesMarca, 'Contact ID (GymBot)').length;
  const conversaoGeral = leadsUnicos.length ? (fechadosGeralUnicos / leadsUnicos.length) * 100 : 0;

  const diasConversao = conversoesMarca
    .map((c) => Number(c['Dias até Conversão']))
    .filter((n) => Number.isFinite(n));
  const tempoMedioConversao = diasConversao.length
    ? diasConversao.reduce((a, b) => a + b, 0) / diasConversao.length
    : null;

  return {
    marca,
    periodo: { start, end },
    leadsTotal: leadsUnicos.length,
    pagos,
    organicos,
    canalCounts,
    porUnidade,
    porAtendente,
    conversaoGeralPercent: conversaoGeral,
    tempoMedioConversaoDias: tempoMedioConversao,
    fechadosGeral: fechadosGeralUnicos,
  };
}

module.exports = { computeReportData };
