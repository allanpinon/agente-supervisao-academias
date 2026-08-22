// Calcula todas as metricas quantitativas de um relatorio, direto das
// planilhas — nenhum numero aproximado/estimado (exigencia confirmada
// pelo usuario). "Leads/atendidos/fechados" sao sempre deduplicados por
// lead unico (Contact ID do GymBot), nao por sessao, conforme decidido na
// revisao de gaps.
const { DateTime } = require('luxon');
const sheets = require('../clients/sheets');
const { config } = require('../config');
const { resolveMarcaPorAtendente } = require('../utils/tags');

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

// Normaliza string pra comparacao (trim + minusculo) — usado SO pra
// comparar, nunca pra exibir. Corrige um gap real encontrado em analise
// profunda dos dados de 20/08/2026: 7 linhas de Atendimentos gravadas como
// 'greco Forma'/'greco forma' em vez de 'Greco Forma' (origem nao
// identificada — o codigo atual so grava a partir de config.tagMap, que
// esta corretamente capitalizado em todo lugar; possivelmente uma
// revisao anterior do codigo, ou uma transformacao do proprio Sheets por
// causa do valueInputOption: 'USER_ENTERED' em src/clients/sheets.js).
// Com comparacao EXATA (===), essas linhas eram silenciosamente
// descartadas de TODAS as metricas do relatorio — nao apareciam em
// nenhuma marca, mesmo tendo Marca valida (so com a grafia diferente).
// Isso por si so ja explicava parte da diferenca entre a contagem do
// relatorio e a contagem do proprio GymBot (56 atendimentos em
// 20/08/2026, contra um numero menor no relatorio).
function normalize(s) {
  return (s || '').toString().trim().toLowerCase();
}

// Marca "efetiva" de uma linha (Leads/Atendimentos/Conversões/Avaliações):
// quando a Atendente da linha já está no mapa fixo `config.atendenteMarca`
// (cada atendente atende uma única marca — pedido explícito do usuário,
// 22/08/2026: "vamos padronizar a marca pelas atendentes"), esse mapeamento
// é usado como fonte da verdade, prevalecendo sobre o campo `Marca` gravado
// na própria linha — mais confiável do que a tag do contato, que provou dar
// grafia inconsistente e ficar em branco em algumas linhas mesmo com a
// atendente já identificada (ver "Gap de contagem de 20/08/2026" na doc do
// projeto). Cai para o campo `Marca` da própria linha quando a atendente
// está vazia ou não está no mapa (atendente nova ainda não cadastrada aqui
// — nesse caso é preciso atualizar `config.atendenteMarca`).
function marcaEfetiva(row) {
  return resolveMarcaPorAtendente(row.Atendente) || row.Marca;
}

const UNIDADE_NAO_IDENTIFICADA = 'Unidade não identificada';

// Dimensoes da rubrica de excelencia (ver src/rubric.js), na mesma ordem
// em que sao gravadas em Avaliações (ver src/pipeline/evaluate.js).
const DIMENSOES = [
  { campo: 'Nota Cordialidade', label: 'Cordialidade' },
  { campo: 'Nota Personalização', label: 'Personalização' },
  { campo: 'Nota Clareza da Oferta', label: 'Clareza da Oferta' },
  { campo: 'Nota Tratamento Objeções', label: 'Tratamento de Objeções' },
  { campo: 'Nota Fechamento/CTA', label: 'Fechamento/CTA' },
  { campo: 'Nota Follow-up', label: 'Follow-up' },
];

// Nota >= 4 (de 1 a 5) e considerado "dentro do padrao de excelencia".
const NOTA_MINIMA_OK = 4;

function media(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

// Metricas OBJETIVAS de um grupo de avaliacoes (convertidos, nao
// convertidos ou em aberto), calculadas direto das notas 1-5 ja gravadas
// em cada linha de Avaliações — nunca estimadas/narradas pela Claude.
// Pedido explicito do usuario (22/08/2026): "o qualitativo precisa ser
// mais objetivo, com levantamento em percentuais" — e a mesma preocupacao
// de nao criar informacao inveridica ja levantada antes sobre o relatorio.
// Este calculo e passado (a) pra Claude, como contexto pra alinhar a
// narrativa da sintese com o numero real (sem inventar um novo), e (b)
// direto pro texto final do relatorio (src/reports/format.js), que
// imprime esses percentuais sem depender do texto gerado por Claude.
function computeMetricas(avaliacoesGrupo) {
  if (!avaliacoesGrupo.length) return null;
  const n = avaliacoesGrupo.length;
  const notasGerais = avaliacoesGrupo
    .map((a) => Number(a['Nota Geral (1-5)']))
    .filter(Number.isFinite);
  const dimensoes = DIMENSOES.map(({ campo, label }) => {
    const notas = avaliacoesGrupo.map((a) => Number(a[campo])).filter(Number.isFinite);
    const percentOk = notas.length
      ? (notas.filter((v) => v >= NOTA_MINIMA_OK).length / notas.length) * 100
      : null;
    return {
      campo, label, media: media(notas), percentOk, n: notas.length,
    };
  });
  return { n, mediaGeral: media(notasGerais), dimensoes };
}

async function computeReportData(marca, { start, end }) {
  const [leads, atendimentos, conversoes, avaliacoes] = await Promise.all([
    sheets.readAll('leads'),
    sheets.readAll('atendimentos'),
    sheets.readAll('conversoes'),
    sheets.readAll('avaliacoes'),
  ]);

  const marcaAlvo = normalize(marca);
  // Todos os quatro filtros comparam a Marca "efetiva" (marcaEfetiva) —
  // padronizada pela atendente quando conhecida, com o campo Marca da
  // própria linha (normalizado) como fallback — em vez do campo Marca cru.
  // Ver comentário de marcaEfetiva() acima.
  const leadsMarca = leads.filter(
    (l) => normalize(marcaEfetiva(l)) === marcaAlvo && inRange(l['Data/Hora'], start, end)
  );
  const leadsUnicos = uniqueBy(leadsMarca, 'Contact ID (GymBot)');

  const atendimentosMarca = atendimentos.filter(
    (a) => normalize(marcaEfetiva(a)) === marcaAlvo && inRange(a['Data/Hora'], start, end)
  );
  const conversoesMarca = conversoes.filter(
    (c) => normalize(marcaEfetiva(c)) === marcaAlvo && inRange(c['Data/Hora'], start, end)
  );
  const avaliacoesMarca = avaliacoes.filter(
    (v) => normalize(marcaEfetiva(v)) === marcaAlvo && inRange(v['Data/Hora'], start, end)
  );

  // Quantitativo do status REAL de cada atendimento no momento em que o
  // relatorio fecha — pedido explicito do usuario (22/08/2026): "é bom
  // fazer um quantitativo sobre o status real no fechamento, quantos
  // concluídos, quantos em andamento". Conta por LINHA de atendimento
  // (sessao), nao deduplicado por lead — um mesmo lead pode ter uma sessao
  // concluida e outra ainda em andamento no mesmo periodo, e isso deve
  // aparecer. "Concluído" agrega os tres status que significam que a
  // conversa em si já terminou (Atendido/Fechado/Não convertido); só
  // "Em andamento" fica de fora — é o único status que significa que a
  // conversa ainda está rolando.
  let statusEmAndamento = 0;
  let statusConcluidos = 0;
  atendimentosMarca.forEach((a) => {
    if (a['Status (Atendido/Fechado)'] === 'Em andamento') statusEmAndamento += 1;
    else statusConcluidos += 1;
  });
  const statusAtendimentos = {
    concluidos: statusConcluidos,
    emAndamento: statusEmAndamento,
    total: atendimentosMarca.length,
  };

  // Calculado mas, por decisao explicita do usuario, NAO aparece mais no
  // texto do relatorio (ver src/reports/format.js) — o numero de "pago vs
  // organico" daqui nao bate com o gerenciador de anuncios (a origem que a
  // tag do GymBot registra nao e confiavel o suficiente pra essa comparacao)
  // e mostrar isso no relatorio gerava duvida sobre o desempenho real do
  // trafego pago. Mantido aqui (nao removido da planilha/calculo) caso
  // sirva de referencia interna futura, so nao e mais exibido.
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

  // "Unidade não identificada": leads/atendimentos/conversões com Marca
  // valida (ja normalizada acima) mas Unidade em branco ou que nao bate com
  // nenhuma unidade conhecida de config.tagMap (contato com tag de marca
  // mas ainda sem tag de unidade). Analise profunda de 20/08/2026 encontrou
  // 15 linhas nessa condicao — antes desta correcao, elas contavam
  // normalmente em "Por atendente"/nos totais gerais, mas desapareciam sem
  // deixar rastro em "Por unidade", o que fazia a soma de "Por unidade" no
  // relatorio nao bater com a soma de "Por atendente" (o proprio sintoma
  // que o usuario reportou).
  const unidadesConhecidas = new Set(unidades);
  const leadsSemUnidade = uniqueBy(
    leadsMarca.filter((l) => !unidadesConhecidas.has(l.Unidade)),
    'Contact ID (GymBot)'
  );
  const atendidosSemUnidade = uniqueBy(
    atendimentosMarca.filter((a) => !unidadesConhecidas.has(a.Unidade)),
    'Contact ID (GymBot)'
  );
  const fechadosSemUnidade = uniqueBy(
    conversoesMarca.filter((c) => !unidadesConhecidas.has(c.Unidade)),
    'Contact ID (GymBot)'
  );
  if (leadsSemUnidade.length || atendidosSemUnidade.length || fechadosSemUnidade.length) {
    const conversaoSemUnidade = leadsSemUnidade.length
      ? (fechadosSemUnidade.length / leadsSemUnidade.length) * 100
      : 0;
    porUnidade.push({
      unidade: UNIDADE_NAO_IDENTIFICADA,
      leads: leadsSemUnidade.length,
      atendidos: atendidosSemUnidade.length,
      fechados: fechadosSemUnidade.length,
      conversaoPercent: conversaoSemUnidade,
    });
  }

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
    // Separadas por resultado. "Em aberto" (atendimento feito, lead ainda
    // sem decisao) ENTRA na sintese qualitativa tambem — decisao explicita
    // do usuario (21/08/2026): a avaliacao da qualidade do atendimento em
    // si (cordialidade, personalizacao, clareza, tratamento de objecoes,
    // tentativa de fechamento) nao deveria esperar o lead converter ou nao
    // pra existir, principalmente no relatorio diario, onde a imensa
    // maioria dos atendimentos do proprio dia ainda esta "Em aberto" (a
    // varredura de reconciliacao so classifica depois). Antes disso, o
    // relatorio diario praticamente nunca tinha nada pra mostrar na parte
    // qualitativa, mesmo com avaliacoes reais gravadas.
    const avaliacoesConvertidas = avaliacoesA.filter((v) => v.Resultado === 'Convertido');
    const avaliacoesNaoConvertidas = avaliacoesA.filter((v) => v.Resultado === 'Não convertido');
    const avaliacoesEmAberto = avaliacoesA.filter((v) => v.Resultado === 'Em aberto' || !v.Resultado);
    return {
      atendente,
      atendidos: atendidosA.length,
      fechados: fechadosA.length,
      conversaoPercent: conversao,
      avaliacoesConvertidas,
      avaliacoesNaoConvertidas,
      avaliacoesEmAberto,
      // Percentuais objetivos por dimensao da rubrica, um grupo para cada
      // segmento (null quando o grupo esta vazio) — ver computeMetricas.
      metricas: {
        convertidos: computeMetricas(avaliacoesConvertidas),
        naoConvertidos: computeMetricas(avaliacoesNaoConvertidas),
        emAberto: computeMetricas(avaliacoesEmAberto),
      },
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
    statusAtendimentos,
  };
}

module.exports = { computeReportData };
