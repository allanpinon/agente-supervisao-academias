// Trata os eventos CONTACT_NEW e CONTACT_TAG_UPDATE do webhook do GymBot.
// Ambos atualizam a aba "Leads" — CONTACT_NEW cria a linha, CONTACT_TAG_UPDATE
// atualiza marca/unidade/atendente se a tag mudou depois da criacao.
const sheets = require('../clients/sheets');
const { resolveMarcaUnidade, extractTagsId } = require('../utils/tags');
const { extractContactInfo } = require('../utils/contact');
const { nowLocal } = require('../utils/dates');
const logger = require('../utils/logger');

async function processContactNew(contact) {
  // CONTACT_NEW pode chegar duplicado (reenvio de webhook do GymBot, ou a
  // mesma chamada acontecendo via processContactTagUpdate quando o lead
  // ainda nao existe) — sem checar antes, cada entrega duplicada virava
  // uma linha nova em "Leads" para o mesmo Contact ID. Mesmo padrao de bug
  // identificado e corrigido em processSessionNew/evaluateAndRecordSession.
  const existente = await sheets.findRowByColumn('leads', 'Contact ID (GymBot)', contact.id);
  if (existente) {
    logger.info(`[processContact] Lead ${contact.id} ja registrado (linha ${existente._rowNumber}) — CONTACT_NEW duplicado, ignorando.`);
    return;
  }

  const { marca, unidade } = resolveMarcaUnidade(extractTagsId(contact));
  const info = extractContactInfo(contact);
  const row = {
    'Data/Hora': nowLocal().toISO(),
    Marca: marca || '',
    Unidade: unidade || '',
    'Nome do Lead': contact.name || '',
    Canal: contact.instagram ? 'Instagram' : 'WhatsApp',
    'Origem (Paga/Orgânica)': info.origemPagaOrganica,
    'UTM Source': info.utmSource,
    Atendente: '',
    'Contact ID (GymBot)': contact.id,
    Telefone: info.telefone,
    Instagram: info.instagram,
    'E-mail': info.email,
    'UTM Medium': info.utmMedium,
    'UTM Campaign': info.utmCampaign,
    'UTM Clid': info.utmClid,
    // Comeca em 1 (o proprio contato acabou de entrar em contato pela
    // primeira vez). processSessionNew mantem este numero atualizado a
    // cada nova sessao deste mesmo Contact ID.
    'Qtd. de Contatos': 1,
  };
  await sheets.appendRow('leads', row);
  logger.info(`[processContact] Novo lead registrado: ${contact.id} (${marca || 'marca desconhecida'})`);
}

async function processContactTagUpdate(contact) {
  const existing = await sheets.findRowByColumn('leads', 'Contact ID (GymBot)', contact.id);
  const { marca, unidade } = resolveMarcaUnidade(extractTagsId(contact));

  if (!existing) {
    // Nao vimos o CONTACT_NEW (pode ter acontecido antes do webhook estar
    // ativo) — cria a linha agora mesmo assim, e melhor do que perder o lead.
    await processContactNew(contact);
    return;
  }

  // Reforca telefone/instagram/e-mail/origem tambem na atualizacao por tag
  // — mesmo padrao "so sobrescreve se vier valor novo" ja usado pra
  // Marca/Unidade, pra nunca apagar um dado ja gravado com um valor vazio
  // vindo deste evento especifico.
  const info = extractContactInfo(contact);
  const updated = {
    ...existing,
    Marca: marca || existing.Marca,
    Unidade: unidade || existing.Unidade,
    Telefone: info.telefone || existing.Telefone,
    Instagram: info.instagram || existing.Instagram,
    'E-mail': info.email || existing['E-mail'],
    'Origem (Paga/Orgânica)': info.utmSource ? info.origemPagaOrganica : existing['Origem (Paga/Orgânica)'],
    'UTM Source': info.utmSource || existing['UTM Source'],
    'UTM Medium': info.utmMedium || existing['UTM Medium'],
    'UTM Campaign': info.utmCampaign || existing['UTM Campaign'],
    'UTM Clid': info.utmClid || existing['UTM Clid'],
  };
  await sheets.updateRow('leads', existing._rowNumber, updated);
  logger.info(`[processContact] Lead atualizado (tag): ${contact.id} -> ${marca || '?'} / ${unidade || '?'}`);
}

module.exports = { processContactNew, processContactTagUpdate };
