// Ferramenta de reparo — execucao UNICA e MANUAL. NAO faz parte do
// funcionamento normal do agente.
//
// Por que existe: `src/clients/flwchat.js` tinha um bug real em
// `hasUsableContactDetails` — tratava o contactDetails da sessao como "ja
// utilizavel" (e por isso NUNCA buscava o contato completo via API) sempre
// que ele tivesse um nome, mesmo sem nenhuma tag. Como o nome quase sempre
// ja vem preenchido no momento em que uma sessao e concluida (SESSION_COMPLETE),
// mas a tag de marca/unidade costuma ser aplicada so depois, esse bug fazia
// `evaluateAndRecordSession` NUNCA buscar as tags atualizadas — resultado
// confirmado com dado real: Marca ficou em branco em 100% das linhas da
// planilha de Avaliações (todas as ja gravadas ate 21/08/2026). Isso, por
// sua vez, fazia o filtro por marca em `src/reports/compute.js`
// (avaliacoesMarca = avaliacoes.filter(v => v.Marca === marca)) nunca
// encontrar NENHUMA avaliacao — e por isso a sintese qualitativa do
// relatorio sempre saia vazia ("Sem atendimentos com resultado definido"),
// mesmo com avaliacoes reais e completas gravadas.
//
// O bug em si ja foi corrigido em `src/clients/flwchat.js`. Este script
// conserta as avaliacoes que ja foram gravadas antes da correcao: rebusca
// cada sessao na API do GymBot (agora com a busca de contato funcionando de
// verdade) e preenche Marca/Unidade/Atendente/Lead — SO os campos que ainda
// estiverem vazios; nunca sobrescreve um valor ja preenchido. Atendente e
// Lead raramente estao vazios (o bug era especifico de Marca/Unidade, que
// dependem de tagsId), mas sao verificados por seguranca/consistencia com
// o mesmo padrao usado em scripts/repair-atendimentos.js.
//
// Uso (Railway Console):
//   node scripts/repair-avaliacoes.js --dry-run              # so lista o que seria reparado
//   node scripts/repair-avaliacoes.js                        # repara de verdade (a partir de 2026-08-01)
//   node scripts/repair-avaliacoes.js 2026-08-18              # repara a partir de uma data especifica
require('dotenv').config();
const flwchat = require('../src/clients/flwchat');
const sheets = require('../src/clients/sheets');
const { resolveMarcaUnidade, extractTagsId, resolveMarcaPorAtendente } = require('../src/utils/tags');
const logger = require('../src/utils/logger');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const cutoffArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const CUTOFF = cutoffArg ? new Date(`${cutoffArg}T00:00:00`) : new Date('2026-08-01T00:00:00');
const DELAY_MS = 250;
const CAMPOS_REPARAVEIS = ['Marca', 'Unidade', 'Atendente', 'Lead'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function precisaReparo(row) {
  return CAMPOS_REPARAVEIS.some((campo) => !row[campo]);
}

async function run() {
  logger.info(`[repair-avaliacoes] ${dryRun ? 'DRY-RUN — ' : ''}Lendo planilha de Avaliações...`);
  const rows = await sheets.readAll('avaliacoes');

  const candidatas = rows.filter((r) => {
    if (!r['Session ID (GymBot)']) return false;
    if (!precisaReparo(r)) return false;
    const data = r['Data/Hora'] ? new Date(r['Data/Hora']) : null;
    if (!data || Number.isNaN(data.getTime())) return true;
    return data >= CUTOFF;
  });

  logger.info(
    `[repair-avaliacoes] ${rows.length} linha(s) na planilha, ${candidatas.length} precisam de reparo ` +
    `(faltando Marca/Unidade/Atendente/Lead, a partir de ${CUTOFF.toISOString().slice(0, 10)}).`
  );

  if (dryRun) {
    candidatas.forEach((r) => {
      const faltando = CAMPOS_REPARAVEIS.filter((c) => !r[c]);
      logger.info(`[repair-avaliacoes] (dry-run) linha ${r._rowNumber}, sessao ${r['Session ID (GymBot)']} — faltando: ${faltando.join(', ')}`);
    });
    logger.info('[repair-avaliacoes] Dry-run concluido — nenhuma linha foi alterada.');
    process.exit(0);
    return;
  }

  let reparadas = 0;
  let semMudanca = 0;
  let jaOk = 0;
  let erros = 0;

  for (const candidata of candidatas) {
    const sessionId = candidata['Session ID (GymBot)'];
    try {
      // eslint-disable-next-line no-await-in-loop
      const session = await flwchat.getSession(sessionId);
      // eslint-disable-next-line no-await-in-loop
      const contactDetails = await flwchat.ensureContactDetails(session, logger);
      // eslint-disable-next-line no-await-in-loop
      const atendente = await flwchat.resolveAgentName(session, logger);
      const { marca: marcaTag, unidade } = resolveMarcaUnidade(extractTagsId(contactDetails));

      // Re-le a linha AGORA (nao o snapshot do inicio) — protege contra
      // corrida com uma avaliacao real acontecendo em paralelo.
      // eslint-disable-next-line no-await-in-loop
      const atual = await sheets.findRowByColumn('avaliacoes', 'Session ID (GymBot)', sessionId);
      if (!atual) {
        logger.warn(`[repair-avaliacoes] Sessao ${sessionId} nao encontrada mais na planilha — pulando.`);
        erros += 1;
        // eslint-disable-next-line no-await-in-loop
        await sleep(DELAY_MS);
        continue;
      }
      if (!precisaReparo(atual)) {
        jaOk += 1;
        // eslint-disable-next-line no-await-in-loop
        await sleep(DELAY_MS);
        continue;
      }

      // Marca padronizada pela atendente (config.atendenteMarca) tem
      // prioridade sobre a tag — ver comentario equivalente em
      // src/pipeline/processSession.js.
      const marca = resolveMarcaPorAtendente(atual.Atendente || atendente) || marcaTag;

      const atualizado = {
        ...atual,
        Marca: atual.Marca || marca || '',
        Unidade: atual.Unidade || unidade || '',
        Atendente: atual.Atendente || atendente || '',
        Lead: atual.Lead || contactDetails?.name || '',
      };

      const mudou = CAMPOS_REPARAVEIS.some((campo) => atualizado[campo] !== atual[campo]);
      if (mudou) {
        // eslint-disable-next-line no-await-in-loop
        await sheets.updateRow('avaliacoes', atual._rowNumber, atualizado);
        reparadas += 1;
        logger.info(`[repair-avaliacoes] Linha ${atual._rowNumber} (sessao ${sessionId}) atualizada.`);
      } else {
        semMudanca += 1;
      }
    } catch (err) {
      erros += 1;
      logger.error(`[repair-avaliacoes] Falha ao reparar sessao ${sessionId}: ${err.message}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(DELAY_MS);
  }

  logger.info(
    `[repair-avaliacoes] Concluido: ${reparadas} reparada(s), ${semMudanca} sem dado disponivel na API, ` +
    `${jaOk} ja estavam ok (corrigidas por outro caminho enquanto o script rodava), ${erros} erro(s).`
  );
  process.exit(0);
}

run().catch((err) => {
  logger.error('[repair-avaliacoes] Erro fatal:', err);
  process.exit(1);
});
