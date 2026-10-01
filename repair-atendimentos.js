// Ferramenta de reparo — execucao UNICA e MANUAL. NAO faz parte do
// funcionamento normal do agente.
//
// Por que existe (causa raiz real, nao "dado antigo corrompido"): o bug
// estava em processSessionComplete (src/pipeline/processSession.js) — ao
// concluir uma sessao, o codigo buscava contactDetails/atendente frescos
// da API e usava esse dado pra gravar a avaliacao (por isso a planilha de
// Avaliações sempre saiu com Atendente correto), mas o UPDATE da linha em
// Atendimentos so tocava no campo "Status", jogando fora esse mesmo dado
// fresco. Resultado: toda linha de Atendimentos cujo atendente so foi
// atribuido DEPOIS do SESSION_NEW (comum — a atendente muitas vezes so
// assume a conversa depois do primeiro contato) ficou com Atendente (e as
// vezes Marca/Unidade/Lead/Contact ID) em branco pra sempre, mesmo a sessao
// tendo sido concluida e avaliada normalmente. Esse bug ja foi corrigido no
// codigo (processSessionComplete agora tambem atualiza esses campos, sem
// nunca sobrescrever um valor ja preenchido) — este script so conserta as
// linhas que ficaram para tras ANTES da correcao.
//
// Fonte de verdade, em ordem de preferencia:
//   1. A planilha de Avaliações, casada pelo mesmo Session ID. Esse dado
//      (Marca/Unidade/Atendente/Lead) foi gravado no momento em que a sessao
//      foi concluida — e o MESMO dado que teria sido gravado em Atendimentos
//      se o bug acima nao existisse, e o usuario confirmou que esta correto
//      (dia 20/08 conferido manualmente). Preferimos isso a rebuscar a API
//      de novo porque "quem esta atribuido a sessao AGORA" pode nao ser mais
//      quem realmente atendeu na epoca (reatribuicao, por exemplo) — usar
//      Avaliações evita esse risco de gravar um Atendente desatualizado/errado.
//   2. Quando nao ha avaliacao correspondente (sessao ainda "Em andamento",
//      nunca concluida, ou concluida antes de existir avaliacao automatica),
//      rebusca a sessao na API do GymBot e roda o mesmo enriquecimento usado
//      em tempo real (ensureContactDetails/resolveAgentName). Contact ID
//      (GymBot) sempre vem por aqui, mesmo quando ha avaliacao — a planilha
//      de Avaliações nao tem essa coluna.
//
// Este script ATUALIZA a linha existente no lugar (nunca cria linha nova —
// usa Session ID como chave). So mexe nos campos que estao vazios; nunca
// sobrescreve um valor ja preenchido.
//
// Seguranca contra corrida com trafego real: a lista de linhas a reparar e
// montada uma vez no inicio, mas o valor gravado em cada UPDATE e sempre
// relido na hora (nao o snapshot do inicio) — assim, se uma sessao de HOJE
// mudar de status (ex: Em andamento -> Atendido, ja com o codigo corrigido)
// enquanto este script roda, o reparo nao sobrescreve esse status mais novo
// com o valor antigo.
//
// Uso (Railway Console):
//   node scripts/repair-atendimentos.js --dry-run              # so lista o que seria reparado
//   node scripts/repair-atendimentos.js                        # repara de verdade (a partir de 2026-08-01)
//   node scripts/repair-atendimentos.js 2026-08-18              # repara a partir de uma data especifica
require('dotenv').config();
const flwchat = require('../src/clients/flwchat');
const sheets = require('../src/clients/sheets');
const { resolveMarcaUnidade, extractTagsId, resolveMarcaPorAtendente } = require('../src/utils/tags');
const logger = require('../src/utils/logger');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const cutoffArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
// Por padrao so mexe em dado a partir de 2026-08-01 — o mesmo corte ja
// combinado para a limpeza do historico. Sessoes de 2024 (poluicao a ser
// apagada) nao valem a pena reparar: seria gastar chamadas de API em dado
// que vai ser removido de qualquer forma.
const CUTOFF = cutoffArg ? new Date(`${cutoffArg}T00:00:00`) : new Date('2026-08-01T00:00:00');
const DELAY_MS = 250;
const CAMPOS_REPARAVEIS = ['Marca', 'Unidade', 'Atendente', 'Lead', 'Contact ID (GymBot)'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function precisaReparo(row) {
  return CAMPOS_REPARAVEIS.some((campo) => !row[campo]);
}

async function run() {
  logger.info(`[repair-atendimentos] ${dryRun ? 'DRY-RUN — ' : ''}Lendo planilhas de Atendimentos e Avaliações...`);
  const [rows, avaliacoes] = await Promise.all([
    sheets.readAll('atendimentos'),
    sheets.readAll('avaliacoes'),
  ]);

  // Indice por Session ID -> linha de avaliacao (fonte de verdade para
  // Marca/Unidade/Atendente/Lead — ver comentario no topo do arquivo).
  const avaliacaoPorSessao = new Map();
  avaliacoes.forEach((a) => {
    if (a['Session ID (GymBot)']) avaliacaoPorSessao.set(a['Session ID (GymBot)'], a);
  });

  const candidatas = rows.filter((r) => {
    if (!r['Session ID (GymBot)']) return false; // sem ID, nao da pra rebuscar na API
    if (!precisaReparo(r)) return false;
    const data = r['Data/Hora'] ? new Date(r['Data/Hora']) : null;
    // Sem data valida, tenta reparar mesmo assim (melhor tentar do que
    // ignorar por causa de um campo de data quebrado).
    if (!data || Number.isNaN(data.getTime())) return true;
    return data >= CUTOFF;
  });

  const comAvaliacao = candidatas.filter((r) => avaliacaoPorSessao.has(r['Session ID (GymBot)'])).length;
  logger.info(
    `[repair-atendimentos] ${rows.length} linha(s) na planilha, ${candidatas.length} precisam de reparo ` +
    `(faltando Marca/Unidade/Atendente/Lead/Contact ID, a partir de ${CUTOFF.toISOString().slice(0, 10)}); ` +
    `${comAvaliacao} tem avaliacao correspondente (fonte preferida), ${candidatas.length - comAvaliacao} vao precisar de consulta a API do GymBot.`
  );

  if (dryRun) {
    candidatas.forEach((r) => {
      const faltando = CAMPOS_REPARAVEIS.filter((c) => !r[c]);
      const avaliacao = avaliacaoPorSessao.get(r['Session ID (GymBot)']) || null;
      // Mesma logica campo-a-campo usada no reparo de verdade (ver acima) —
      // so diz "Avaliações" se ela realmente cobre tudo que falta.
      const precisaApiPreview = !avaliacao
        || !r['Contact ID (GymBot)']
        || CAMPOS_REPARAVEIS.some((campo) => campo !== 'Contact ID (GymBot)' && !r[campo] && !avaliacao[campo]);
      const fonte = precisaApiPreview ? 'API GymBot' : 'Avaliações';
      logger.info(`[repair-atendimentos] (dry-run) linha ${r._rowNumber}, sessao ${r['Session ID (GymBot)']} — faltando: ${faltando.join(', ')} — fonte: ${fonte}`);
    });
    logger.info('[repair-atendimentos] Dry-run concluido — nenhuma linha foi alterada.');
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
      const avaliacao = avaliacaoPorSessao.get(sessionId) || null;

      // So consulta a API do GymBot quando precisar de verdade: campo por
      // campo, nao "existe avaliacao? entao chega". BUG JA CORRIGIDO NESTE
      // SCRIPT (21/08/2026): a versao anterior pulava a API sempre que
      // havia QUALQUER avaliacao correspondente — mas Marca/Unidade em
      // Avaliações estavam 100% em branco ate agora (ver correcao em
      // src/clients/flwchat.js), entao pra essas linhas o reparo nao
      // reparava nada. Agora so pula a API se avaliacao+linha atual juntas
      // ja cobrem TODOS os campos reparaveis (exceto Contact ID, que
      // Avaliações nunca tem e por isso sempre exige a API quando faltar).
      const precisaApi = !avaliacao
        || !candidata['Contact ID (GymBot)']
        || CAMPOS_REPARAVEIS.some((campo) => campo !== 'Contact ID (GymBot)' && !candidata[campo] && !avaliacao[campo]);
      let contactDetails = null;
      let atendenteApi = '';
      let marcaApi = '';
      let unidadeApi = '';
      if (precisaApi) {
        // eslint-disable-next-line no-await-in-loop
        const session = await flwchat.getSession(sessionId);
        // eslint-disable-next-line no-await-in-loop
        contactDetails = await flwchat.ensureContactDetails(session, logger);
        // eslint-disable-next-line no-await-in-loop
        atendenteApi = await flwchat.resolveAgentName(session, logger);
        const resolvido = resolveMarcaUnidade(extractTagsId(contactDetails));
        marcaApi = resolvido.marca;
        unidadeApi = resolvido.unidade;
      }

      // Re-le a linha AGORA (nao o snapshot do inicio) — se algo real (um
      // webhook ja com o codigo corrigido, a varredura) ja mudou essa linha
      // enquanto este script rodava, e essa versao mais nova que precisa
      // ser preservada.
      // eslint-disable-next-line no-await-in-loop
      const atual = await sheets.findRowByColumn('atendimentos', 'Session ID (GymBot)', sessionId);
      if (!atual) {
        logger.warn(`[repair-atendimentos] Sessao ${sessionId} nao encontrada mais na planilha — pulando.`);
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

      // Avaliações primeiro (fonte confirmada pelo usuario); API do GymBot
      // so como complemento (principalmente Contact ID, que Avaliações nao
      // tem, e qualquer outro campo que a avaliacao tambem nao tenha).
      // Marca padronizada pela atendente (config.atendenteMarca) e a fonte
      // preferida quando o nome ja e conhecido em algum dos lugares (linha
      // atual, avaliacao correspondente ou API) — mais confiavel que a tag
      // do contato (ver comentario equivalente em
      // src/pipeline/processSession.js). So preenche campo vazio, nunca
      // sobrescreve (mesma regra de sempre deste script).
      const atendenteConhecido = atual.Atendente || avaliacao?.Atendente || atendenteApi;
      const marcaPadronizada = resolveMarcaPorAtendente(atendenteConhecido);
      const atualizado = {
        ...atual,
        Marca: atual.Marca || marcaPadronizada || avaliacao?.Marca || marcaApi || '',
        Unidade: atual.Unidade || avaliacao?.Unidade || unidadeApi || '',
        Atendente: atual.Atendente || avaliacao?.Atendente || atendenteApi || '',
        Lead: atual.Lead || avaliacao?.Lead || contactDetails?.name || '',
        'Contact ID (GymBot)': atual['Contact ID (GymBot)'] || contactDetails?.id || '',
      };

      const mudou = CAMPOS_REPARAVEIS.some((campo) => atualizado[campo] !== atual[campo]);
      if (mudou) {
        // eslint-disable-next-line no-await-in-loop
        await sheets.updateRow('atendimentos', atual._rowNumber, atualizado);
        reparadas += 1;
        logger.info(`[repair-atendimentos] Linha ${atual._rowNumber} (sessao ${sessionId}) atualizada.`);
      } else {
        // Nem a avaliacao nem a API tinham esse dado (ex: sessao sem tag de
        // unidade, ou contato sem nome, ou sessao que nunca chegou a ser
        // concluida/avaliada e a API tambem nao resolveu) — nao ha o que
        // reparar aqui.
        semMudanca += 1;
      }
    } catch (err) {
      erros += 1;
      logger.error(`[repair-atendimentos] Falha ao reparar sessao ${sessionId}: ${err.message}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(DELAY_MS);
  }

  logger.info(
    `[repair-atendimentos] Concluido: ${reparadas} reparada(s), ${semMudanca} sem dado disponivel (nem Avaliações nem API), ` +
    `${jaOk} ja estavam ok (corrigidas por outro caminho enquanto o script rodava), ${erros} erro(s).`
  );
  process.exit(0);
}

run().catch((err) => {
  logger.error('[repair-atendimentos] Erro fatal:', err);
  process.exit(1);
});
