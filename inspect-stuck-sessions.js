// DIAGNÓSTICO — só leitura, não grava nada em planilha nenhuma.
//
// Contexto (28/09/2026): ~1052 linhas em Atendimentos ficaram travadas em
// "Em andamento" desde 08/09/2026 — causa confirmada: a chamada à Claude
// em processSessionComplete rodava SEM try/catch, ANTES da atualização de
// Status e do registro de conversão. Se a Claude falhasse (cota, chave,
// etc.), a função inteira parava ali, e a linha nunca saía de "Em
// andamento" — mesmo a sessão tendo sido de fato concluída no GymBot.
//
// O que ainda não sabemos: se GET /v2/session/{id} — que SEMPRE apaga o
// campo `classification` (achado confirmado em 26/08, ver
// claude/arquitetura-agente-supervisao.md) — também apaga o status geral
// da sessão (Em andamento/Concluída), ou se só a classificação é afetada.
// Isso decide se dá pra reparar essas 1052 linhas automaticamente (pelo
// menos o Status, ainda que não a classificação Ganho/Perdido) ou não.
//
// Uso (Railway Console):
//   node scripts/inspect-stuck-sessions.js
//   node scripts/inspect-stuck-sessions.js 20   (busca 20 amostras em vez de 5)
require('dotenv').config();
const sheets = require('../src/clients/sheets');
const flwchat = require('../src/clients/flwchat');
const logger = require('../src/utils/logger');

const N = parseInt(process.argv[2] || '5', 10);

async function run() {
  const atendimentos = await sheets.readAll('atendimentos');
  const travadas = atendimentos.filter(
    (r) => r['Status (Atendido/Fechado)'] === 'Em andamento' && r['Data/Hora'] >= '2026-09-08'
  );
  logger.info(`[inspect-stuck] ${travadas.length} linha(s) travadas em "Em andamento" desde 08/09/2026 — inspecionando ${Math.min(N, travadas.length)} amostra(s) via GET.`);

  // Amostra espalhada (início, meio, fim) em vez de só as primeiras — cobre
  // mais chance de achar tanto sessão realmente concluída quanto uma
  // genuinamente ainda em aberto.
  const passo = Math.max(1, Math.floor(travadas.length / N));
  const amostra = [];
  for (let i = 0; i < travadas.length && amostra.length < N; i += passo) {
    amostra.push(travadas[i]);
  }

  for (const row of amostra) {
    const sessionId = row['Session ID (GymBot)'];
    if (!sessionId) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const session = await flwchat.getSession(sessionId);
      // Log do objeto CRU inteiro (menos as mensagens, se vierem, pra não
      // poluir o log) — objetivo é ver TODOS os campos de nível superior
      // que a API devolve, sem suposição de nome nenhuma.
      const { messages, ...semMensagens } = session || {};
      logger.info(
        `[inspect-stuck] Sessao ${sessionId} (linha da planilha: ${row['Data/Hora']}, ` +
        `lead: ${row.Lead || '?'}) — GET /v2/session/${sessionId} retornou:\n` +
        JSON.stringify(semMensagens, null, 2)
      );
    } catch (err) {
      logger.error(`[inspect-stuck] Falha ao buscar sessao ${sessionId}: ${err.message}`);
    }
  }

  logger.info('[inspect-stuck] Concluído. Nada foi gravado em nenhuma planilha — isso é só diagnóstico.');
}

run().catch((err) => {
  logger.error('[inspect-stuck] Erro fatal:', err);
  process.exit(1);
});
