// Trata os eventos CONTACT_NEW e CONTACT_TAG_UPDATE do webhook do GymBot.
// Ambos atualizam a aba "Leads" — CONTACT_NEW cria a linha, CONTACT_TAG_UPDATE
// atualiza marca/unidade/atendente se a tag mudou depois da criacao.
const sheets = require('../clients/sheets');
const { resolveMarcaUnidade, extractTagsId } = require('../utils/tags');
const { nowLocal } = require('../utils/dates');
const logger = require('../utils/logger');

function isPago(utm) {
  // Considera "pago" quando existe qualquer sinal de campanha no UTM.
  if (!utm) return false;
  return Boolean(utm.source || utm.sourceId || utm.campaign || utm.medium);
}

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
  const row = {
    'Data/Hora': nowLocal().toISO(),
    Marca: marca || '',
    Unidade: unidade || '',
    'Nome do Lead': contact.name || '',
    Canal: contact.instagram ? 'Instagram' : 'WhatsApp',
    'Origem (Paga/Orgânica)': isPago(contact.utm) ? 'Paga' : 'Orgânica',
    'UTM Source': contact.utm?.source || '',
    Atendente: '',
    'Contact ID (GymBot)': contact.id,
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

  const updated = {
    ...existing,
    Marca: marca || existing.Marca,
    Unidade: unidade || existing.Unidade,
  };
  await sheets.updateRow('leads', existing._rowNumber, updated);
  logger.info(`[processContact] Lead atualizado (tag): ${contact.id} -> ${marca || '?'} / ${unidade || '?'}`);
}

module.exports = { processContactNew, processContactTagUpdate };
