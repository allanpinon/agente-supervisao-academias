// Cliente da Evolution API — envia os relatorios para os grupos de
// WhatsApp. Instancia dedicada da agencia (independente do GymBot).
const axios = require('axios');
const { config } = require('../config');

function client() {
  return axios.create({
    baseURL: config.evolution.apiUrl,
    headers: {
      apikey: config.evolution.apiKey,
      'Content-Type': 'application/json',
    },
    timeout: 20000,
  });
}

// Envia uma mensagem de texto para um grupo (ou contato) pelo JID.
// Endpoint padrao da Evolution API (v1/v2): POST /message/sendText/{instance}
// Se a versao da instancia usar um formato de payload diferente, ajuste
// aqui — o restante do codigo so chama sendGroupMessage().
async function sendText(jid, text) {
  const { data } = await client().post(
    `/message/sendText/${config.evolution.instance}`,
    {
      number: jid,
      text,
    }
  );
  return data;
}

async function sendGroupMessage(marca, text) {
  const jid = config.evolution.groups[marca];
  if (!jid) {
    throw new Error(`Nenhum JID de grupo configurado para a marca "${marca}"`);
  }
  return sendText(jid, text);
}

module.exports = { sendText, sendGroupMessage };
