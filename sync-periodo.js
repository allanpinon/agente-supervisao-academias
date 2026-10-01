// Sincroniza (CRIA sessoes que faltam E ATUALIZA linhas ja existentes) as
// planilhas Leads e Conversões para um periodo de datas especifico.
//
// Diferenca em relacao a scripts/import-history.js: aquele e so ADITIVO
// (nunca mexe numa linha que ja existe). Este script, a pedido explicito
// do usuario em 01/10/2026 ("preciso que ele traga todos os dados, atualize
// os ja existentes, a partir de 01/09/2026 ate hoje"), tambem retrocede em
// cima de linhas ja gravadas e preenche Telefone/Instagram/E-mail/Origem/
// UTM onde estiverem vazias — sem nunca sobrescrever um valor ja presente
// (mesma regra de seguranca ja usada em scripts/repair-atendimentos.js e
// scripts/repair-avaliacoes.js). Ver claude/arquitetura-agente-supervisao.md,
// secao "Atualizacao do importador historico..." (01/10/2026), para o
// contexto completo da decisao.
//
// Uso (Railway Console):
//   node scripts/sync-periodo.js                       # 2026-09-01 ate hoje (padrao)
//   node scripts/sync-periodo.js 2026-09-01             # outra data de inicio, ate hoje
//   node scripts/sync-periodo.js 2026-09-01 2026-09-30  # periodo fechado especifico
//
// LIMITACAO IMPORTANTE, HERDADA DO MESMO CAMINHO DE API JA DOCUMENTADO (ver
// src/pipeline/conversion.js, "ACHADO CRITICO" — 26/08/2026): GET
// /v2/session/{id} SEMPRE devolve classification: null, mesmo pra sessoes
// reais ja classificadas no GymBot. Por isso:
//   - Este script CONSEGUE atualizar Telefone/Instagram/E-mail/Origem/UTM
//     em linhas de Conversões que JA EXISTEM na planilha, seja o Resultado
//     "Convertido" ou "Não convertido" (so precisa do Session ID bater —
//     nao depende da classification vir de novo).
//   - Mas NAO CONSEGUE criar uma linha NOVA em Conversões para uma sessao
//     que nunca foi gravada (nem Ganho nem Perda) — isso exigiria a
//     classification vir no payload, o que o GET nunca traz. Na pratica,
//     nenhuma conversao nova sera criada por este script; so as que ja
//     existem ganham os campos novos preenchidos. Recuperar uma conversao
//     que nunca foi capturada em tempo real exige conferencia manual
//     contra o proprio GymBot — nao ha caminho de API.
require('dotenv').config();
const flwchat = require('../src/clients/flwchat');
const sheets = require('../src/clients/sheets');
const { resolveMarcaUnidade, extractTagsId, resolveMarcaPorAtendente } = require('../src/utils/tags');
const { extractContactInfo } = require('../src/utils/contact');
const { nowLocal, diffInDays } = require('../src/utils/dates');
const { config } = require('../src/config');
const logger = require('../src/utils/logger');

const DATA_INICIO = process.argv[2] || '2026-09-01';
const DATA_FIM = process.argv[3] || nowLocal().toISODate();
const DELAY_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseItemDate(item) {
  const raw = item?.createdAt || item?.startAt || item?.date || item?.created_at;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

// So preenche campos que estao vazios na linha existente — nunca
// sobrescreve um valor ja presente. Mesma regra de seguranca ja usada em
// scripts/repair-atendimentos.js e scripts/repair-avaliacoes.js.
function preencherSoVazios(existente, novosValores) {
  const atualizado = { ...existente };
  let mudou = false;
  Object.entries(novosValores).forEach(([campo, valor]) => {
    if (!existente[campo] && valor) {
      atualizado[campo] = valor;
      mudou = true;
    }
  });
  return { atualizado, mudou };
}

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

async function syncLead(session, leadsIndex, stats) {
  const contact = session.contactDetails;
  if (!contact?.id) return;
  const info = extractContactInfo(contact);
  const existente = leadsIndex.get(contact.id);

  const camposContato = {
    Telefone: info.telefone,
    Instagram: info.instagram,
    'E-mail': info.email,
    'Origem (Paga/Orgânica)': info.origemPagaOrganica,
    'UTM Source': info.utmSource,
    'UTM Medium': info.utmMedium,
    'UTM Campaign': info.utmCampaign,
    'UTM Clid': info.utmClid,
  };

  if (existente) {
    const { atualizado, mudou } = preencherSoVazios(existente, camposContato);
    if (mudou) {
      await sheets.updateRow('leads', existente._rowNumber, atualizado);
      leadsIndex.set(contact.id, atualizado);
      stats.leadsAtualizados += 1;
    }
    return;
  }

  const { marca: marcaTag, unidade } = resolveMarcaUnidade(extractTagsId(contact));
  const marca = resolveMarcaPorAtendente(session.agentDetails?.name) || marcaTag;
  const row = {
    'Data/Hora': contact.createdAt || session.createdAt || '',
    Marca: marca || '',
    Unidade: unidade || '',
    'Nome do Lead': contact.name || '',
    Canal: contact.instagram ? 'Instagram' : 'WhatsApp',
    Atendente: session.agentDetails?.name || '',
    'Contact ID (GymBot)': contact.id,
    ...camposContato,
  };
  await sheets.appendRow('leads', row);
  leadsIndex.set(contact.id, row);
  stats.leadsCriados += 1;
}

async function syncAtendimento(session, atendimentosIndex, stats) {
  const existente = atendimentosIndex.get(session.id);
  if (existente) return existente;
  const { marca: marcaTag, unidade } = resolveMarcaUnidade(extractTagsId(session.contactDetails));
  const marca = resolveMarcaPorAtendente(session.agentDetails?.name) || marcaTag;
  const contactId = session.contactDetails?.id || '';
  const jaTinhaAntesDestaExecucao = contactId
    ? primeiroAtendimentoDoContato(contactId, atendimentosIndex) !== null
    : false;
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
    'Classificação do Lead': jaTinhaAntesDestaExecucao ? 'Recorrente' : '',
  };
  await sheets.appendRow('atendimentos', row);
  atendimentosIndex.set(session.id, row);
  stats.atendimentosCriados += 1;
  return row;
}

async function syncConversao(session, atendimentosIndex, conversoesIndex, stats) {
  const info = extractContactInfo(session.contactDetails);
  const existente = conversoesIndex.get(session.id);
  const camposContato = {
    Telefone: info.telefone,
    Instagram: info.instagram,
    'E-mail': info.email,
    'Origem (Paga/Orgânica)': info.origemPagaOrganica,
    'UTM Source': info.utmSource,
    'UTM Medium': info.utmMedium,
    'UTM Campaign': info.utmCampaign,
    'UTM Clid': info.utmClid,
  };

  if (existente) {
    // Atualiza independente do Resultado (Convertido OU Nao convertido) —
    // so precisa do Session ID bater com uma linha ja gravada, nao depende
    // de classification vir de novo no GET (que sempre vem null).
    const { atualizado, mudou } = preencherSoVazios(existente, camposContato);
    if (mudou) {
      await sheets.updateRow('conversoes', existente._rowNumber, atualizado);
      conversoesIndex.set(session.id, atualizado);
      stats.conversoesAtualizadas += 1;
    }
    return;
  }

  // So cria linha NOVA quando vier WON explicitamente confirmado — ver
  // limitacao no topo do arquivo (GET nunca traz classification, entao na
  // pratica este bloco quase nunca executa para dado historico).
  const category = session.classification?.category;
  if (!category || !config.classificationCategories.WON || category !== config.classificationCategories.WON) return;

  const { marca: marcaTag, unidade } = resolveMarcaUnidade(extractTagsId(session.contactDetails));
  const marca = resolveMarcaPorAtendente(session.agentDetails?.name) || marcaTag;
  const dataClassificacao = session.updatedAt || session.createdAt || nowLocal().toISO();
  const primeiroAtendimento = primeiroAtendimentoDoContato(session.contactDetails?.id, atendimentosIndex);
  const dataOrigemLead = primeiroAtendimento?.['Data/Hora'] || session.contactDetails?.createdAt;

  await sheets.appendRow('conversoes', {
    'Data/Hora': dataClassificacao,
    Marca: marca || '',
    Unidade: unidade || '',
    Atendente: session.agentDetails?.name || '',
    Lead: session.contactDetails?.name || '',
    Resultado: 'Convertido',
    Valor: session.classification?.amount ?? '',
    'Session ID (GymBot)': session.id,
    Motivo: session.classification?.categoryDescription?.trim() || session.classification?.categoryName || category,
    'Dias até Classificação': dataOrigemLead
      ? Math.max(0, Math.round(diffInDays(dataOrigemLead, dataClassificacao)))
      : '',
    'Contact ID (GymBot)': session.contactDetails?.id || '',
    ...camposContato,
  });
  conversoesIndex.set(session.id, true);
  stats.conversoesCriadas += 1;
}

async function run() {
  const startJS = new Date(`${DATA_INICIO}T00:00:00`);
  const endJS = new Date(`${DATA_FIM}T23:59:59`);
  logger.info(`[sync-periodo] Sincronizando sessoes de ${DATA_INICIO} ate ${DATA_FIM}...`);

  logger.info('[sync-periodo] Carregando planilhas existentes (1 leitura por planilha)...');
  const leadsIndex = await sheets.buildIndex('leads', 'Contact ID (GymBot)');
  const atendimentosIndex = await sheets.buildIndex('atendimentos', 'Session ID (GymBot)');
  const conversoesIndex = await sheets.buildIndex('conversoes', 'Session ID (GymBot)');
  logger.info(
    `[sync-periodo] Indices carregados: ${leadsIndex.size} lead(s), ` +
    `${atendimentosIndex.size} atendimento(s), ${conversoesIndex.size} conversao(oes) ja existentes.`
  );

  const stats = {
    leadsCriados: 0,
    leadsAtualizados: 0,
    atendimentosCriados: 0,
    conversoesCriadas: 0,
    conversoesAtualizadas: 0,
  };

  let page = 1;
  let totalProcessadas = 0;
  let encontrouNoIntervalo = false;
  let paginasForaDoIntervaloSeguidas = 0;
  const PAGE_SIZE = 50;

  for (;;) {
    logger.info(`[sync-periodo] Buscando pagina ${page} de sessoes (ate ${PAGE_SIZE} por pagina)...`);

    let result;
    try {
      // eslint-disable-next-line no-await-in-loop
      result = await flwchat.listSessions({ page, pageSize: PAGE_SIZE });
    } catch (err) {
      const detalhes = err.response
        ? ` [HTTP ${err.response.status} em ${err.config?.url || '?'}] ${JSON.stringify(err.response.data)}`
        : ` [${err.code || 'erro sem codigo'}] ${err.message}`;
      logger.error(`[sync-periodo] Falha ao buscar pagina ${page} de sessoes:${detalhes}`);
      throw err;
    }

    const items = result.items || result.data || result.results || [];
    logger.info(`[sync-periodo] Pagina ${page}: ${items.length} sessao(oes) recebida(s).`);
    if (!items.length) break;

    let algumNestaPagina = false;

    for (const sessionSummary of items) {
      const dataResumo = parseItemDate(sessionSummary);
      if (dataResumo && (dataResumo < startJS || dataResumo > endJS)) continue;

      try {
        // eslint-disable-next-line no-await-in-loop
        const session = await flwchat.getSession(sessionSummary.id);

        const dataSessao = parseItemDate(session);
        if (dataSessao && (dataSessao < startJS || dataSessao > endJS)) continue;

        algumNestaPagina = true;
        encontrouNoIntervalo = true;

        // eslint-disable-next-line no-await-in-loop
        session.contactDetails = await flwchat.ensureContactDetails(session, logger);
        // eslint-disable-next-line no-await-in-loop
        session.agentDetails = { ...(session.agentDetails || {}), name: await flwchat.resolveAgentName(session, logger) };

        // eslint-disable-next-line no-await-in-loop
        await syncLead(session, leadsIndex, stats);
        // eslint-disable-next-line no-await-in-loop
        await syncAtendimento(session, atendimentosIndex, stats);
        // eslint-disable-next-line no-await-in-loop
        await syncConversao(session, atendimentosIndex, conversoesIndex, stats);

        totalProcessadas += 1;
        if (totalProcessadas % 25 === 0) {
          logger.info(`[sync-periodo] ${totalProcessadas} sessao(oes) processada(s) ate agora...`);
        }
      } catch (err) {
        logger.error(`[sync-periodo] Erro processando sessao ${sessionSummary.id}: ${err.message}`);
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(DELAY_MS);
    }

    if (!algumNestaPagina && encontrouNoIntervalo) {
      paginasForaDoIntervaloSeguidas += 1;
      if (paginasForaDoIntervaloSeguidas >= 2) {
        logger.info('[sync-periodo] 2 paginas seguidas fora do periodo apos encontrar dados no intervalo — encerrando paginacao.');
        break;
      }
    } else {
      paginasForaDoIntervaloSeguidas = 0;
    }

    if (items.length < PAGE_SIZE) break;
    page += 1;
  }

  logger.info(
    `[sync-periodo] Concluido. ${totalProcessadas} sessao(oes) processada(s) no periodo. ` +
    `Leads: ${stats.leadsCriados} criado(s), ${stats.leadsAtualizados} atualizado(s) com campos novos. ` +
    `Atendimentos: ${stats.atendimentosCriados} criado(s). ` +
    `Conversões: ${stats.conversoesCriadas} criada(s), ${stats.conversoesAtualizadas} atualizada(s) com campos novos.`
  );
  process.exit(0);
}

run().catch((err) => {
  logger.error('[sync-periodo] Erro fatal:', err);
  process.exit(1);
});
