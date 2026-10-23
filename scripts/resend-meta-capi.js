// Ferramenta de teste/correcao pontual — execucao UNICA e MANUAL, via
// Railway Console. NAO faz parte do funcionamento normal do servico.
//
// Para que serve: reenviar manualmente o evento de conversao pro Meta
// CAPI de UMA sessao especifica cujo "Meta CAPI" ficou em branco (nao
// "Pendente (...)") — caso que `resendPendingMetaCapiEvents()` (chamado
// pela varredura de reconciliacao antes de todo relatorio, ver
// src/reconciliation/sweep.js) NUNCA pega sozinho, porque esse mecanismo
// so age sobre linhas que o proprio codigo marcou como "Pendente (" — nunca
// sobre linha antiga/em branco, de proposito, pra nao inundar o Meta com
// conversoes velhas (ver src/integrations/metaCapi.js e
// claude/arquitetura-agente-supervisao.md, secao do achado da "marca
// vazia", 22/10/2026).
//
// O caso real que motivou este script: sessao 457ac25e-60a6-4900-b451-
// -7a9121a2dad5 (Fit.com) — SESSION_COMPLETE chegou 36s depois da sessao
// ser criada, antes da tag de marca ser aplicada; a conversao foi gravada
// normalmente como "Convertido", mas o envio pro Meta foi descartado em
// silencio (marca vazia) e a coluna "Meta CAPI" ficou em branco.
//
// O que o script faz, em 2 passos sempre seguros:
//   1. Acha a linha em Conversoes pelo Session ID (GymBot). Se a linha nao
//      existir, ou nao estiver "Convertido", ou ja tiver "Meta CAPI"
//      preenchido (Enviado OU Pendente), para sem mudar nada — nunca
//      sobrescreve um envio ou uma tentativa que ja aconteceu.
//   2. Marca essa UNICA linha como "Pendente (reenvio manual)" na coluna
//      Meta CAPI (via sheets.updateMetaCapiStatus, nunca toca a coluna U
//      "Data Real") e entao chama resendPendingMetaCapiEvents() — que vai
//      tentar o reenvio de verdade, pela mesma logica ja testada (resolve
//      marca pelo nome da atendente, chama metaCapi.enviarConversao). Se a
//      marca ainda nao resolver agora, a linha simplesmente continua
//      "Pendente (...)" e volta a ser tentada automaticamente nas proximas
//      varreduras, sem precisar rodar este script de novo.
//
// Uso (Railway Console):
//   node scripts/resend-meta-capi.js 457ac25e-60a6-4900-b451-7a9121a2dad5
require('dotenv').config();
const sheets = require('../src/clients/sheets');
const { resendPendingMetaCapiEvents } = require('../src/pipeline/conversion');
const logger = require('../src/utils/logger');

async function main() {
  const sessionId = process.argv[2];
  if (!sessionId) {
    console.error('Uso: node scripts/resend-meta-capi.js <Session ID (GymBot)>');
    process.exitCode = 1;
    return;
  }

  const rows = await sheets.readConversoesComMetaCapi();
  const row = rows.find((r) => r['Session ID (GymBot)'] === sessionId);

  if (!row) {
    console.error(`Sessao ${sessionId} nao encontrada na planilha Conversoes.`);
    process.exitCode = 1;
    return;
  }

  if (row.Resultado !== 'Convertido') {
    console.error(`Sessao ${sessionId} tem Resultado = "${row.Resultado || '(vazio)'}" — este script so age sobre linhas "Convertido". Nada foi alterado.`);
    process.exitCode = 1;
    return;
  }

  const metaCapiAtual = String(row['Meta CAPI'] || '').trim();
  if (metaCapiAtual) {
    console.error(`Sessao ${sessionId} ja tem "Meta CAPI" = "${metaCapiAtual}" — nao e um caso de coluna em branco. Nada foi alterado (evita reenviar/sobrescrever um envio ou tentativa que ja aconteceu).`);
    process.exitCode = 1;
    return;
  }

  console.log(`Sessao ${sessionId} confirmada: Resultado "Convertido", Meta CAPI em branco. Marcando como "Pendente (reenvio manual)" e tentando reenviar agora...`);
  await sheets.updateMetaCapiStatus(row._rowNumber, 'Pendente (reenvio manual)');

  const resultado = await resendPendingMetaCapiEvents();
  console.log(
    `Varredura de reenvio concluida: ${resultado.verificadas} pendente(s) verificada(s), ` +
    `${resultado.reenviadas} reenviada(s) com sucesso, ${resultado.aindaPendentes} ainda pendente(s).`
  );
  console.log('Confira a coluna "Meta CAPI" da linha dessa sessao na planilha Conversoes para o resultado final (pode ter mudado outras linhas pendentes tambem, se existirem).');
}

main().catch((err) => {
  logger.error(`[resend-meta-capi] Erro inesperado: ${err.message}`);
  process.exitCode = 1;
});
