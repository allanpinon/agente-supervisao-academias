// Envia eventos de conversao (matricula confirmada) pro Meta via
// Conversions API (CAPI) — server-to-server, sem depender de Pixel no
// navegador nem do teste ainda pendente de `ctwa_clid`. Ver
// claude/arquitetura-agente-supervisao.md, secoes "Estrutura de
// configuracao para os dois Pixels" e "Como enviar a conversao real de
// volta pra Meta" (08/09/2026), e "Decisao revista: sem n8n, custo zero"
// (01/10/2026), para o raciocinio completo por tras desta implementacao.
//
// Decisoes importantes, ja tomadas e documentadas no projeto:
// - Casa por TELEFONE (hash SHA-256) — chave sempre disponivel (confirmado
//   com 3 casos reais, ver src/utils/contact.js). Casa tambem por E-MAIL
//   quando vier preenchido (hoje raro — depende da atendente preencher na
//   tela de contato do GymBot ao enviar o link de pagamento).
// - Quando `utm.clid` existir (ctwa_clid, ainda nao validado contra o
//   endpoint real), pode ser adicionado depois como chave extra sem mudar
//   o resto do fluxo — nao implementado ainda, fica para quando for
//   validado.
// - Nome de evento CUSTOMIZADO (nao "Purchase") para nao se confundir com
//   o Purchase que o Pixel do Pacto ja dispara para vendas online feitas
//   pelo link de checkout — o agente cobre TODAS as vendas (online +
//   balcao), entao usar o mesmo nome inflaria/duplicaria o numero do
//   Pacto. Configuravel via META_CAPI_EVENT_NAME (padrao
//   "Matricula_Confirmada").
// - So dispara para transicoes DE/PARA "Convertido" (WON) — nunca para
//   "Nao convertido" (LOST nao e evento de conversao pro Meta). Quem
//   decide a transicao e o chamador (src/pipeline/conversion.js), que so
//   invoca este modulo quando o Resultado realmente passou a ser
//   "Convertido" agora (nao reenvia se a sessao ja estava "Convertido" e
//   so um campo novo foi preenchido, ou se o GymBot reentregou o mesmo
//   webhook SESSION_COMPLETE — comportamento ja confirmado real neste
//   projeto, ver "Registro de incidentes e correcoes", item 7).
// - So e usado pelo caminho EM TEMPO REAL (webhook SESSION_COMPLETE) —
//   deliberadamente NAO ligado aos scripts historicos
//   (scripts/import-history.js, scripts/sync-periodo.js), para nao
//   disparar uma enxurrada de eventos de conversao "antigos" pro Meta toda
//   vez que um desses scripts roda ou e re-executado.
// - Desligado por padrao: META_CAPI_ENABLED precisa ser literalmente
//   "true" para qualquer chamada sair de fato. Isso evita que o envio
//   comece sozinho so porque Pixel ID + token foram configurados, antes do
//   usuario validar os eventos na aba "Testar Eventos" do Gerenciador de
//   Eventos do Meta.
const crypto = require('crypto');
const axios = require('axios');
const { config } = require('../config');
const logger = require('../utils/logger');

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

// Normaliza (trim + minusculo) e hasheia, seguindo a exigencia do Meta.
// Devolve undefined para valor vazio — o Meta espera o campo AUSENTE do
// objeto user_data, nao uma string vazia hasheada.
function hashField(value) {
  if (!value) return undefined;
  const normalizado = String(value).trim().toLowerCase();
  if (!normalizado) return undefined;
  return sha256(normalizado);
}

function pixelIdPara(marca) {
  return config.metaCapi.pixelIds[marca];
}

// dados: { marca, telefone (ja normalizado, so digitos + DDI — ver
// src/utils/contact.js normalizePhoneE164), email, valor, dataHora (ISO
// ou Date), sessionId (usado como event_id) }.
// Nunca lanca excecao — qualquer falha (config ausente, erro de rede,
// erro da API do Meta) e logada e devolvida no retorno, para nunca
// derrubar o fluxo principal de gravacao em Conversões.
async function enviarConversao(dados) {
  const { marca, telefone, email, valor, dataHora, sessionId } = dados || {};

  if (!config.metaCapi.enabled) {
    logger.info(`[metaCapi] Integracao desligada (META_CAPI_ENABLED != "true") — evento de "${marca}" nao enviado.`);
    return { enviado: false, motivo: 'desligado' };
  }

  const pixelId = pixelIdPara(marca);
  if (!pixelId) {
    logger.warn(`[metaCapi] Nenhum Pixel ID configurado para a marca "${marca}" — evento nao enviado.`);
    return { enviado: false, motivo: 'sem-pixel-id' };
  }
  if (!config.metaCapi.accessToken) {
    logger.warn('[metaCapi] META_CAPI_ACCESS_TOKEN ausente — evento nao enviado.');
    return { enviado: false, motivo: 'sem-token' };
  }

  const ph = hashField(telefone);
  const em = hashField(email);
  if (!ph && !em) {
    logger.warn(`[metaCapi] Sessao ${sessionId || '?'} sem telefone nem e-mail utilizavel — nenhuma chave de correspondencia, evento nao enviado.`);
    return { enviado: false, motivo: 'sem-chave-correspondencia' };
  }

  const eventTime = Math.floor(new Date(dataHora || Date.now()).getTime() / 1000);

  const payload = {
    data: [
      {
        event_name: config.metaCapi.eventName,
        event_time: eventTime,
        event_id: sessionId || undefined,
        action_source: 'system_generated',
        user_data: {
          ...(ph ? { ph: [ph] } : {}),
          ...(em ? { em: [em] } : {}),
        },
        custom_data: {
          currency: 'BRL',
          value: Number(valor) || 0,
        },
      },
    ],
  };
  if (config.metaCapi.testEventCode) {
    payload.test_event_code = config.metaCapi.testEventCode;
  }

  const url = `https://graph.facebook.com/${config.metaCapi.apiVersion}/${pixelId}/events`;

  try {
    const { data } = await axios.post(url, payload, {
      params: { access_token: config.metaCapi.accessToken },
      timeout: 15000,
    });
    logger.info(
      `[metaCapi] Evento "${config.metaCapi.eventName}" enviado para o Pixel de "${marca}" ` +
      `(sessao ${sessionId || '?'}) — resposta: ${JSON.stringify(data)}`
    );
    return { enviado: true, resposta: data };
  } catch (err) {
    const detalhes = err.response
      ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
      : err.message;
    logger.error(`[metaCapi] Falha ao enviar evento pro Pixel de "${marca}" (sessao ${sessionId || '?'}): ${detalhes}`);
    return { enviado: false, motivo: 'erro-api', detalhes };
  }
}

module.exports = { enviarConversao, hashField, sha256 };
