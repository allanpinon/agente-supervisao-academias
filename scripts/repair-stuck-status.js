// Ferramenta de reparo — execucao UNICA e MANUAL. NAO faz parte do
// funcionamento normal do agente.
//
// CONTEXTO (28/09/2026): entre 08/09 e a correcao do codigo em 28/09, a
// chamada a Claude em processSessionComplete rodava SEM try/catch, ANTES
// da atualizacao de Status e do registro de conversao. Toda vez que essa
// chamada falhava, a funcao parava ali — a linha em Atendimentos nunca
// saia de "Em andamento", mesmo quando a sessao tinha sido de fato
// concluida no GymBot. Resultado: 1057 linhas travadas (confirmado com
// dado real em 28/09/2026).
//
// DIAGNOSTICO JA FEITO (scripts/inspect-stuck-sessions.js, 28/09/2026,
// 5 amostras reais): GET /v2/session/{id} preserva o campo `status`
// ("IN_PROGRESS" | "COMPLETED") mesmo apagando `classification` (que
// SEMPRE volta null — achado ja confirmado em 26/08, ver
// claude/arquitetura-agente-supervisao.md). Ou seja: da pra saber com
// certeza se a sessao foi concluida ou nao, mas NAO da pra recuperar se
// foi Ganho ou Perdido.
//
// O QUE ESTE SCRIPT FAZ:
//   - status === "IN_PROGRESS": sessao genuinamente ainda em aberto (nao e
//     vitima do bug) — NAO mexe. Vai ser fechada normalmente quando o
//     atendente concluir de verdade (codigo ja corrigido) ou pela
//     varredura de reconciliacao, quando expirar a janela.
//   - status === "COMPLETED": sessao FOI concluida no GymBot mas ficou
//     presa aqui por causa do bug. Atualiza Status para "Atendido" (nao
//     "Fechado"/"Nao convertido" — a classificacao Ganho/Perdido dessas
//     sessoes especificas NAO e recuperavel por API, entao nao inventamos
//     um resultado; a sessao segue elegivel pra fechar quando reclassificada
//     manualmente no GymBot, ou expira via varredura de reconciliacao como
//     qualquer atendimento sem classificacao). De brinde, aproveita a
//     mesma chamada pra preencher Marca/Unidade/Atendente/Lead/Contact ID
//     que ainda estiverem vazios (mesmo padrao de repair-atendimentos.js)
//     — essas linhas tambem nunca passaram pelo enriquecimento normal por
//     causa do mesmo bug.
//
// O QUE ESTE SCRIPT *NAO* FAZ (limitacao real, nao contornavel por API):
//   - NAO grava nada em Conversões. A classificacao Ganho/Perdido dessas
//     sessoes especificas (completadas entre 08/09 e a correcao) so existia
//     no payload cru do webhook SESSION_COMPLETE que falhou — esse payload
//     nao foi salvo em lugar nenhum e o GymBot nao reentrega webhook so
//     porque pedimos (so reentrega em caso de erro HTTP do lado dele, e
//     nosso servico sempre respondeu 200 antes de processar). Recuperar o
//     resultado real dessas conversas exige conferencia manual contra o
//     proprio painel/export do GymBot, sessao por sessao — mesma limitacao
//     ja documentada para o caso William Quaresma.
//
// Mesmas protecoes de sempre: --dry-run, so mexe em campo vazio (exceto
// Status, que e o proprio objetivo do reparo), nunca sobrescreve Status
// que ja saiu de "Em andamento" por outro caminho, relê a linha antes de
// gravar (protecao contra corrida com trafego real).
//
// Uso (Railway Console):
//   node scripts/repair-stuck-status.js --dry-run
//   node scripts/repair-stuck-status.js
//   node scripts/repair-stuck-status.js 2026-09-08   (corte customizado)
require('dotenv').config();
const flwchat = require('../src/clients/flwchat');
const sheets = require('../src/clients/sheets');
const { resolveMarcaUnidade, extractTagsId, resolveMarcaPorAtendente } = require('../src/utils/tags');
const logger = require('../src/utils/logger');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const cutoffArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const CUTOFF = cutoffArg ? new Date(`${cutoffArg}T00:00:00`) : new Date('2026-09-08T00:00:00');
const DELAY_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  logger.info(`[repair-stuck-status] ${dryRun ? 'DRY-RUN — ' : ''}Lendo planilha de Atendimentos...`);
  const rows = await sheets.readAll('atendimentos');

  const travadas = rows.filter((r) => {
    if (r['Status (Atendido/Fechado)'] !== 'Em andamento') return false;
    if (!r['Session ID (GymBot)']) return false;
    const data = r['Data/Hora'] ? new Date(r['Data/Hora']) : null;
    if (!data || Number.isNaN(data.getTime())) return true;
    return data >= CUTOFF;
  });

  logger.info(
    `[repair-stuck-status] ${rows.length} linha(s) na planilha, ${travadas.length} em "Em andamento" ` +
    `a partir de ${CUTOFF.toISOString().slice(0, 10)} — verificando status real de cada uma no GymBot.`
  );

  if (dryRun) {
    let completed = 0;
    let inProgress = 0;
    let semStatus = 0;
    for (const row of travadas) {
      const sessionId = row['Session ID (GymBot)'];
      try {
        // eslint-disable-next-line no-await-in-loop
        const session = await flwchat.getSession(sessionId);
        if (session?.status === 'COMPLETED') {
          completed += 1;
          logger.info(`[repair-stuck-status] (dry-run) linha ${row._rowNumber}, sessao ${sessionId} — COMPLETED no GymBot, seria marcada "Atendido".`);
        } else if (session?.status === 'IN_PROGRESS') {
          inProgress += 1;
        } else {
          semStatus += 1;
          logger.warn(`[repair-stuck-status] (dry-run) linha ${row._rowNumber}, sessao ${sessionId} — status inesperado: "${session?.status}".`);
        }
      } catch (err) {
        semStatus += 1;
        logger.error(`[repair-stuck-status] (dry-run) Falha ao consultar sessao ${sessionId}: ${err.message}`);
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(DELAY_MS);
    }
    logger.info(
      `[repair-stuck-status] Dry-run concluido — ${completed} seriam marcadas "Atendido", ` +
      `${inProgress} genuinamente ainda em aberto (nao mexeria), ${semStatus} com erro/status inesperado. Nenhuma linha foi alterada.`
    );
    process.exit(0);
    return;
  }

  let atendido = 0;
  let aindaEmAndamento = 0;
  let jaOk = 0;
  let erros = 0;

  for (const row of travadas) {
    const sessionId = row['Session ID (GymBot)'];
    try {
      // eslint-disable-next-line no-await-in-loop
      const session = await flwchat.getSession(sessionId);

      if (session?.status !== 'COMPLETED') {
        // Genuinamente ainda em aberto (ou status inesperado/erro) — nao
        // mexe, sai do jeito que estava.
        aindaEmAndamento += 1;
        // eslint-disable-next-line no-await-in-loop
        await sleep(DELAY_MS);
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const contactDetails = await flwchat.ensureContactDetails(session, logger);
      // eslint-disable-next-line no-await-in-loop
      const atendenteApi = await flwchat.resolveAgentName(session, logger);
      const { marca: marcaTag, unidade } = resolveMarcaUnidade(extractTagsId(contactDetails));

      // Re-le a linha AGORA — se um webhook novo (ja com o codigo
      // corrigido) ja fechou essa sessao enquanto o script rodava, essa
      // versao mais nova precisa ser preservada, nao sobrescrita.
      // eslint-disable-next-line no-await-in-loop
      const atual = await sheets.findRowByColumn('atendimentos', 'Session ID (GymBot)', sessionId);
      if (!atual) {
        logger.warn(`[repair-stuck-status] Sessao ${sessionId} nao encontrada mais na planilha — pulando.`);
        erros += 1;
        // eslint-disable-next-line no-await-in-loop
        await sleep(DELAY_MS);
        continue;
      }
      if (atual['Status (Atendido/Fechado)'] !== 'Em andamento') {
        jaOk += 1;
        // eslint-disable-next-line no-await-in-loop
        await sleep(DELAY_MS);
        continue;
      }

      const atendenteConhecido = atual.Atendente || atendenteApi;
      const marcaPadronizada = resolveMarcaPorAtendente(atendenteConhecido);
      const atualizado = {
        ...atual,
        'Status (Atendido/Fechado)': 'Atendido',
        Marca: atual.Marca || marcaPadronizada || marcaTag || '',
        Unidade: atual.Unidade || unidade || '',
        Atendente: atual.Atendente || atendenteApi || '',
        Lead: atual.Lead || contactDetails?.name || '',
        'Contact ID (GymBot)': atual['Contact ID (GymBot)'] || contactDetails?.id || '',
      };

      // eslint-disable-next-line no-await-in-loop
      await sheets.updateRow('atendimentos', atual._rowNumber, atualizado);
      atendido += 1;
      logger.info(`[repair-stuck-status] Linha ${atual._rowNumber} (sessao ${sessionId}) marcada "Atendido".`);
    } catch (err) {
      erros += 1;
      logger.error(`[repair-stuck-status] Falha ao reparar sessao ${sessionId}: ${err.message}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(DELAY_MS);
  }

  logger.info(
    `[repair-stuck-status] Concluido: ${atendido} marcada(s) "Atendido", ${aindaEmAndamento} genuinamente ` +
    `ainda em aberto (sem mudanca), ${jaOk} ja tinham saido de "Em andamento" por outro caminho, ${erros} erro(s). ` +
    'LEMBRETE: nenhuma classificacao Ganho/Perdido foi recuperada — isso nao e possivel via API para sessoes ja concluidas antes da correcao.'
  );
  process.exit(0);
}

run().catch((err) => {
  logger.error('[repair-stuck-status] Erro fatal:', err);
  process.exit(1);
});
