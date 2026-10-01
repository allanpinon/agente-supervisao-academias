// Extracao/normalizacao de dados de identificacao do contato (telefone,
// Instagram, e-mail, origem de UTM) a partir do objeto `contactDetails`
// devolvido por flwchat.ensureContactDetails/getContact.
//
// CONFIRMADO COM DADO REAL (01/10/2026), via node scripts/inspect-session-by-id.js
// contra 3 sessoes reais — ver claude/arquitetura-agente-supervisao.md,
// secao "CONFIRMADO COM DADO REAL — schema completo de contato":
//   {
//     phoneNumber: "+55|11933393344",   // SEMPRE presente nos 3 casos
//     phoneNumberFormatted: "(11) 93339-3344",
//     email: "" | null,                 // NUNCA preenchido nos 3 casos testados
//     instagram: null,                  // campo existe, nenhum caso testado veio de DM do Instagram
//     messengerId: null,                // campo existe, nao usado por estas marcas (sem Messenger)
//     utm: null | {
//       sourceId, source, clid, medium, campaign, content, headline, term, referralUrl
//     }
//   }
// `utm` so vem preenchido quando o contato chegou via um clique de anuncio
// rastreado (confirmado: 1 dos 3 casos testados, origin "CREATED_FROM_HUB" +
// anuncio real no Instagram) — os outros 2 vieram null, inclusive um outro
// caso que tambem era "CREATED_FROM_HUB" mas sem UTM (mensagem direta, sem
// anuncio por tras). `utm.clid` e, com alta probabilidade, o `ctwa_clid` da
// Meta (identificador de clique de anuncio Click-to-WhatsApp/Instagram) —
// ainda nao validado contra o endpoint real da Conversions API.

// O telefone real observado vem no formato "+55|11933393344" (codigo do
// pais e numero separados por "|", nao um E.164 padrao). Pra normalizar,
// basta manter so os digitos — remove o "+" e o "|" de uma vez, sem
// precisar tratar os dois separadamente.
function normalizePhoneE164(phoneNumber) {
  if (!phoneNumber) return '';
  const digits = String(phoneNumber).replace(/\D/g, '');
  return digits;
}

// Considera "pago" quando existe qualquer sinal de campanha no UTM do
// contato. Compartilhado entre processContact.js (Leads) e conversion.js
// (Conversões) — antes so existia uma copia local em processContact.js.
function isPago(utm) {
  if (!utm) return false;
  return Boolean(utm.source || utm.sourceId || utm.campaign || utm.medium);
}

// Extrai, de um `contactDetails` (pode vir null/undefined), todos os
// campos de identificacao/origem usados nas planilhas Leads e Conversões.
// Sempre devolve strings (nunca null/undefined), prontas pra gravar direto
// num rowObject do sheets.js.
function extractContactInfo(contactDetails) {
  const utm = contactDetails?.utm || null;
  return {
    telefone: normalizePhoneE164(contactDetails?.phoneNumber),
    instagram: contactDetails?.instagram || '',
    email: contactDetails?.email || '',
    origemPagaOrganica: isPago(utm) ? 'Paga' : 'Orgânica',
    utmSource: utm?.source || '',
    utmMedium: utm?.medium || '',
    utmCampaign: utm?.campaign || '',
    utmClid: utm?.clid || '',
  };
}

module.exports = {
  normalizePhoneE164, isPago, extractContactInfo,
};
