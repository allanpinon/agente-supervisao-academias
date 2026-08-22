// Importador historico — execucao UNICA e MANUAL (npm run import-history,
// ou "node scripts/import-history.js N" pelo Console do Railway).
// Traz para as planilhas os atendimentos dos ultimos N dias (padrao: 30),
// reaproveitando as mesmas funcoes/formatos usados em tempo real, para
// garantir que o dado historico fique identico ao que o webhook vai gerar
// dali pra frente.
//
// IMPORTANTE sobre performance/cota: com centenas ou milhares de
// atendimentos, checar duplicidade com 1 leitura da planilha POR item
// estoura a cota de leitura por minuto do Google Sheets. Por isso aqui a
// gente le cada planilha relevante UMA vez no inicio (buildIndex) e usa
// esses indices em memoria para as checagens — so voltamos a consultar a
// API pontualmente quando precisamos atualizar uma linha existente (o que
// so acontece na fracao de sessoes que converteram).
require('dotenv').config();
const flwchat = require('../src/clients/flwchat');
const sheets = require('../src/clients/sheets');
const { resolveMarcaUnidade, extractTagsId } = require('../src/utils/tags');
const { evaluateAndRecordSession } = require('../src/pipeline/evaluate');
const { nowLocal, diffInDays } = require('../src/utils/dates');
const { config } = require('../src/config');
const logger = require('../src/utils/logger');

const DIAS = parseInt(process.argv[2] || '30', 10);
// Pequena pausa entre sessoes, para suavizar o ritmo de chamadas de API
// (GymBot, Claude e Planilhas) ao longo da importacao.
const DELAY_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Tenta extrair uma data de criacao de um item de sessao (resumido ou
// completo), testando os nomes de campo mais comuns. Devolve null se nao
// encontrar nada reconhecivel — nesse caso o item nao e filtrado por
// data neste ponto (fica por conta do filtro seguinte, ou passa).
function parseItemDate(item) {
  const raw = item?.createdAt || item?.startAt || item?.date || item?.created_at;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function importarLead(session, leadsIndex) {
  const contact = session.contactDetails;
  if (!contact?.id || leadsIndex.has(contact.id)) return;
  const { marca, unidade } = resolveMarcaUnidade(extractTagsId(contact));
  const row = {
    'Data/Hora': contact.createdAt || session.createdAt || '',
    Marca: marca || '',
    Unidade: unidade || '',
    'Nome do Lead': contact.name || '',
    Canal: contact.instagram ? 'Instagram' : 'WhatsApp',
    'Origem (Paga/Orgânica)': (contact.utm?.source || contact.utm?.campaign) ? 'Paga' : 'Orgânica',
    'UTM Source': contact.utm?.source || '',
    Atendente: session.agentDetails?.name || '',
    'Contact ID (GymBot)': contact.id,
  };
  await sheets.appendRow('leads', row);
  leadsIndex.set(contact.id, row);
}

// Devolve, dentre as linhas de atendimento ja conhecidas em memoria (index
// carregado no inicio + o que ja foi importado nesta execucao), a de data
// mais antiga para um Contact ID — usado tanto pra classificar Novo x
// Recorrente quanto pra achar a data do primeiro atendimento (origem do
// calculo de "Dias ate Conversao"). Le do Map em memoria em vez da planilha
// pra nao gastar leitura extra da API por sessao.
function primeiroAtendimentoDoContato(contactId, atendimentosIndex) {
  if (!contactId) return null;
  let earliest = null;
  let earliestTime = Infinity;
  atendimentosIndex.forEach((row) => {
    if (row['Contact ID (GymBot)'] !== contactId) return;
    const t = row['Data/Hora'] ? new Date(row['Data/Hora']).getTime() : NaN;
    if (!Number.isNaN(t) && t < earliestTime) {
      earliestTime = t;
      earliest = row;
    }
  });
  return earliest;
}

async function importarAtendimento(session, atendimentosIndex) {
  const existente = atendimentosIndex.get(session.id);
  if (existente) return existente;
  const { marca, unidade } = resolveMarcaUnidade(extractTagsId(session.contactDetails));

  // Novo x Recorrente — mesma logica de processSessionNew (tempo real),
  // mas com uma ressalva importante aqui: a importacao pagina do mais novo
  // pro mais antigo (ver comentario no topo do arquivo), entao a ordem em
  // que as sessoes de um mesmo Contact ID sao processadas NESTA execucao
  // nao e necessariamente a ordem cronologica real. Classificar com base
  // em "ja vi este contato antes nesta importacao" classificaria a sessao
  // mais recente como "Novo" e a mais antiga (processada depois) como
  // "Recorrente" — o contrario do correto. Por isso, na importacao
  // historica, so classificamos quando o contato JA tinha atendimento
  // registrado ANTES desta execucao comecar (indice carregado no inicio,
  // que reflete dado real de tempo real/execucoes anteriores, sempre
  // cronologico) — nesse caso e seguramente "Recorrente". Fora isso, fica
  // em branco em vez de arriscar uma classificacao errada.
  const contactId = session.contactDetails?.id || '';
  const jaTinhaAntesDestaExecucao = contactId
    ? primeiroAtendimentoDoContato(contactId, atendimentosIndex) !== null
    : false;
  const classificacaoLead = jaTinhaAntesDestaExecucao ? 'Recorrente' : '';

  const row = {
    'Data/Hora': session.createdAt || '',
    Marca: marca || '',
    Unidade: unidade || '',
    Atendente: session.agentDetails?.name || '',
    Lead: session.contactDetails?.name || '',
    Canal: session.contactDetails?.instagram ? 'Instagram' : 'WhatsApp',
    'Status (Atendido/Fechado)': 'Atendido',
    'Horário 1ª Resposta': '',
    'Session ID (GymBot)': session.id,
    'Contact ID (GymBot)': contactId,
    'Classificação do Lead': classificacaoLead,
  };
  await sheets.appendRow('atendimentos', row);
  atendimentosIndex.set(session.id, row);
  return row;
}

// So chamado para a fracao de sessoes que de fato converteram — por isso
// pode dar 1-2 leituras pontuais na API sem risco de estourar a cota.
async function importarConversao(session, avaliacoesIndex, conversoesIndex, atendimentosIndex) {
  const category = session.classification?.category;
  if (category !== config.classificationSuccessCategory) return;
  if (conversoesIndex.has(session.id)) return;

  const { marca, unidade } = resolveMarcaUnidade(extractTagsId(session.contactDetails));
  const dataClassificacao = session.updatedAt || session.createdAt || nowLocal().toISO();
  // Origem do calculo de "Dias ate Conversao": data do PRIMEIRO atendimento
  // deste lead (nao a data de criacao do contato no GymBot, e nao
  // necessariamente esta sessao) — e o que de fato mede "quanto tempo o
  // lead levou pra virar cliente", incluindo o caso de reativacao (primeiro
  // atendimento sem fechar, lead volta meses depois e fecha). Cai pra
  // contactDetails.createdAt so se nao acharmos nenhum atendimento anterior
  // em memoria (ex: primeira sessao deste lead, ainda sendo processada
  // agora — importarAtendimento roda antes desta funcao, entao a propria
  // sessao atual ja esta no indice quando chegamos aqui).
  const primeiroAtendimento = primeiroAtendimentoDoContato(session.contactDetails?.id, atendimentosIndex);
  const dataOrigemLead = primeiroAtendimento?.['Data/Hora'] || session.contactDetails?.createdAt;

  await sheets.appendRow('conversoes', {
    'Data/Hora': dataClassificacao,
    Marca: marca || '',
    Unidade: unidade || '',
    Atendente: session.agentDetails?.name || '',
    Lead: session.contactDetails?.name || '',
    Valor: session.classification?.amount ?? '',
    'Session ID (GymBot)': session.id,
    Motivo: category,
    'Dias até Conversão': dataOrigemLead
      ? Math.max(0, Math.round(diffInDays(dataOrigemLead, dataClassificacao)))
      : '',
    'Contact ID (GymBot)': session.contactDetails?.id || '',
  });
  conversoesIndex.set(session.id, true);

  const atendimentoAtual = await sheets.findRowByColumn('atendimentos', 'Session ID (GymBot)', session.id);
  if (atendimentoAtual) {
    await sheets.updateRow('atendimentos', atendimentoAtual._rowNumber, {
      ...atendimentoAtual,
      'Status (Atendido/Fechado)': 'Fechado',
    });
  }

  if (avaliacoesIndex.has(session.id)) {
    const avaliacaoAtual = await sheets.findRowByColumn('avaliacoes', 'Session ID (GymBot)', session.id);
    if (avaliacaoAtual) {
      await sheets.updateRow('avaliacoes', avaliacaoAtual._rowNumber, {
        ...avaliacaoAtual,
        Resultado: 'Convertido',
      });
    }
  }
}

async function run() {
  const end = nowLocal();
  const start = end.minus({ days: DIAS });
  logger.info(`[import-history] Importando sessoes de ${start.toISODate()} ate ${end.toISODate()}...`);

  logger.info('[import-history] Carregando planilhas existentes (1 leitura por planilha)...');
  const leadsIndex = await sheets.buildIndex('leads', 'Contact ID (GymBot)');
  const atendimentosIndex = await sheets.buildIndex('atendimentos', 'Session ID (GymBot)');
  const avaliacoesIndex = await sheets.buildIndex('avaliacoes', 'Session ID (GymBot)');
  const conversoesIndex = await sheets.buildIndex('conversoes', 'Session ID (GymBot)');
  logger.info(
    `[import-history] Indices carregados: ${leadsIndex.size} lead(s), ` +
    `${atendimentosIndex.size} atendimento(s), ${avaliacoesIndex.size} avaliacao(oes), ` +
    `${conversoesIndex.size} conversao(oes) ja existentes.`
  );

  let page = 1;
  let totalProcessadas = 0;
  let totalFiltradasForaDoPeriodo = 0;
  let encontrouNoIntervalo = false;
  let paginasForaDoIntervaloSeguidas = 0;
  const PAGE_SIZE = 50;
  const startJS = start.toJSDate();
  const endJS = end.toJSDate();

  for (;;) {
    // Log ANTES da chamada — sem isso, se a API demorar ou travar, o
    // console fica em silencio total sem dar pista de onde parou (foi o
    // que aconteceu numa tentativa anterior: nada aparecia depois dos
    // indices carregados, e nao dava pra saber se estava so lento ou
    // travado de verdade).
    logger.info(`[import-history] Buscando pagina ${page} de sessoes (ate ${PAGE_SIZE} por pagina)...`);

    let result;
    try {
      // Nao adianta mandar startDate/endDate — confirmamos com dado real
      // que a API ignora esses parametros. O que faz a paginacao ser
      // eficiente aqui e pedir ordem DESCENDING (mais nova primeiro, ver
      // flwchat.listSessions) combinado com o filtro por data feito
      // abaixo e o corte antecipado de paginacao.
      // eslint-disable-next-line no-await-in-loop
      result = await flwchat.listSessions({ page, pageSize: PAGE_SIZE });
    } catch (err) {
      const detalhes = err.response
        ? ` [HTTP ${err.response.status} em ${err.config?.url || '?'}] ${JSON.stringify(err.response.data)}`
        : ` [${err.code || 'erro sem codigo'}] ${err.message}`;
      logger.error(`[import-history] Falha ao buscar pagina ${page} de sessoes:${detalhes}`);
      throw err;
    }

    const items = result.items || result.data || result.results || [];
    logger.info(`[import-history] Pagina ${page}: ${items.length} sessao(oes) recebida(s).`);
    if (!items.length) break;

    let algumNestaPagina = false;

    for (const sessionSummary of items) {
      // Filtro de seguranca no nosso lado: o filtro por data da API nem
      // sempre e respeitado (ja vimos ela devolver sessoes de anos atras
      // mesmo com startDate/endDate preenchidos). Se o item resumido ja
      // trouxer uma data, filtramos ANTES de gastar chamadas de API.
      const dataResumo = parseItemDate(sessionSummary);
      if (dataResumo && (dataResumo < startJS || dataResumo > endJS)) {
        totalFiltradasForaDoPeriodo += 1;
        continue;
      }

      try {
        // eslint-disable-next-line no-await-in-loop
        const session = await flwchat.getSession(sessionSummary.id);

        // Segundo filtro, agora com a data real da sessao completa (caso
        // o resumo nao trouxesse data nenhuma antes).
        const dataSessao = parseItemDate(session);
        if (dataSessao && (dataSessao < startJS || dataSessao > endJS)) {
          totalFiltradasForaDoPeriodo += 1;
          continue;
        }

        algumNestaPagina = true;
        encontrouNoIntervalo = true;

        // Reforca contactDetails UMA vez por sessao aqui (import-history,
        // sweep e processSession usam o mesmo helper) — assim
        // importarLead/importarAtendimento/evaluateAndRecordSession/
        // importarConversao reaproveitam o mesmo dado sem chamadas
        // repetidas. Ver flwchat.ensureContactDetails: boa parte das
        // sessoes vem sem contactDetails preenchido, mesmo com as
        // mensagens normais — por isso Marca/Unidade/Lead ficavam em
        // branco nas planilhas antes desta correcao.
        // eslint-disable-next-line no-await-in-loop
        session.contactDetails = await flwchat.ensureContactDetails(session, logger);
        // Mesma ideia para o nome da atendente — ver flwchat.resolveAgentName
        // (usa a lista de usuarios, buscada uma unica vez e cacheada).
        // eslint-disable-next-line no-await-in-loop
        session.agentDetails = { ...(session.agentDetails || {}), name: await flwchat.resolveAgentName(session, logger) };

        // eslint-disable-next-line no-await-in-loop
        await importarLead(session, leadsIndex);
        // eslint-disable-next-line no-await-in-loop
        await importarAtendimento(session, atendimentosIndex);

        if (!avaliacoesIndex.has(session.id)) {
          // eslint-disable-next-line no-await-in-loop
          await evaluateAndRecordSession(session);
          avaliacoesIndex.set(session.id, true);
        }

        // eslint-disable-next-line no-await-in-loop
        await importarConversao(session, avaliacoesIndex, conversoesIndex, atendimentosIndex);

        totalProcessadas += 1;
        logger.info(`[import-history] Sessao ${session.id} processada (${totalProcessadas} no total).`);
      } catch (err) {
        logger.error(`[import-history] Erro processando sessao ${sessionSummary.id}:`, err.message);
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(DELAY_MS);
    }

    // Se a API devolve em ordem cronologica (e o que observamos), depois
    // de ja termos encontrado sessoes dentro do periodo, 2 paginas
    // seguidas totalmente fora do periodo e sinal de que passamos da
    // janela — para de paginar, em vez de varrer o historico inteiro.
    if (!algumNestaPagina && encontrouNoIntervalo) {
      paginasForaDoIntervaloSeguidas += 1;
      if (paginasForaDoIntervaloSeguidas >= 2) {
        logger.info('[import-history] 2 paginas seguidas fora do periodo apos encontrar dados no intervalo — encerrando paginacao.');
        break;
      }
    } else {
      paginasForaDoIntervaloSeguidas = 0;
    }

    if (items.length < PAGE_SIZE) break;
    page += 1;
  }

  if (totalFiltradasForaDoPeriodo) {
    logger.info(`[import-history] ${totalFiltradasForaDoPeriodo} sessao(oes) ignorada(s) por estarem fora do periodo pedido.`);
  }

  logger.info(`[import-history] Concluido. ${totalProcessadas} sessao(oes) processada(s).`);
  process.exit(0);
}

run().catch((err) => {
  logger.error('[import-history] Erro fatal:', err);
  process.exit(1);
});
