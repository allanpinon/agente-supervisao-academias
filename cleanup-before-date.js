// Script de limpeza — execucao UNICA e MANUAL. Remove das planilhas
// qualquer linha cujo "Data/Hora" seja ANTERIOR a uma data de corte.
// Criado para desfazer o efeito de uma importacao historica que trouxe
// dados de fora do periodo pedido (o filtro de data da API do GymBot nao
// estava sendo respeitado).
//
// Linhas SEM uma data reconhecivel na coluna "Data/Hora" sao sempre
// mantidas (por seguranca — nao apaga o que nao consegue classificar).
//
// Uso:
//   node scripts/cleanup-before-date.js 2026-08-01
//   node scripts/cleanup-before-date.js 2026-08-01 leads,atendimentos
//   node scripts/cleanup-before-date.js 2026-08-01 leads,atendimentos --dry-run
//
// Por padrao roda em leads, atendimentos, avaliacoes e conversoes.
// SEMPRE rode primeiro com --dry-run pra conferir o que seria removido
// antes de rodar de verdade.
require('dotenv').config();
const { DateTime } = require('luxon');
const sheets = require('../src/clients/sheets');
const logger = require('../src/utils/logger');

const CUTOFF = process.argv[2];
if (!CUTOFF) {
  // eslint-disable-next-line no-console
  console.error('Uso: node scripts/cleanup-before-date.js AAAA-MM-DD [planilha1,planilha2,...] [--dry-run]');
  process.exit(1);
}

const args = process.argv.slice(3);
const dryRun = args.includes('--dry-run');
const sheetArg = args.find((a) => !a.startsWith('--'));
const SHEET_KEYS = (sheetArg || 'leads,atendimentos,avaliacoes,conversoes')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const cutoffDate = DateTime.fromISO(CUTOFF).toJSDate();
if (Number.isNaN(cutoffDate.getTime())) {
  // eslint-disable-next-line no-console
  console.error(`Data de corte invalida: "${CUTOFF}". Use o formato AAAA-MM-DD.`);
  process.exit(1);
}

async function limparPlanilha(sheetKey) {
  const rows = await sheets.readAll(sheetKey);
  const mantidas = [];
  const removidas = [];

  rows.forEach((r) => {
    const d = r['Data/Hora'] ? new Date(r['Data/Hora']) : null;
    const dataValida = d && !Number.isNaN(d.getTime());
    if (!dataValida || d >= cutoffDate) {
      mantidas.push(r);
    } else {
      removidas.push(r);
    }
  });

  if (dryRun) {
    logger.info(
      `[cleanup] (SIMULACAO) ${sheetKey}: ${removidas.length} linha(s) SERIAM removidas ` +
      `(antes de ${CUTOFF}), ${mantidas.length} seriam mantidas.`
    );
    if (removidas.length) {
      const exemplos = removidas.slice(0, 5).map((r) => r['Data/Hora']).join(', ');
      logger.info(`[cleanup] (SIMULACAO) ${sheetKey}: exemplos de datas que seriam removidas: ${exemplos}`);
    }
    return;
  }

  await sheets.replaceAll(sheetKey, mantidas);
  logger.info(`[cleanup] ${sheetKey}: ${removidas.length} linha(s) removida(s), ${mantidas.length} mantida(s).`);
}

async function run() {
  logger.info(
    `[cleanup] ${dryRun ? 'SIMULACAO (nada sera alterado)' : 'EXECUCAO REAL'} — ` +
    `removendo linhas anteriores a ${CUTOFF} de: ${SHEET_KEYS.join(', ')}`
  );
  for (const key of SHEET_KEYS) {
    // eslint-disable-next-line no-await-in-loop
    await limparPlanilha(key);
  }
  logger.info('[cleanup] Concluido.');
  process.exit(0);
}

run().catch((err) => {
  logger.error('[cleanup] Erro fatal:', err);
  process.exit(1);
});
