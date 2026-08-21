// Cliente do Google Sheets — le/escreve nas 6 planilhas que servem de
// banco de dados do agente. Usa a conta de servico do Google Cloud
// (GOOGLE_SERVICE_ACCOUNT_JSON) para autenticar, sem depender de login
// pessoal de ninguem.
const { google } = require('googleapis');
const { config } = require('../config');
const logger = require('../utils/logger');

// Cabecalhos das planilhas — precisam bater com a ordem das colunas
// criadas no Google Drive. Se alguma coluna for adicionada/removida na
// planilha, atualize aqui tambem.
const SHEETS = {
  leads: {
    id: config.google.sheets.leads,
    tab: 'Sheet1',
    headers: [
      'Data/Hora', 'Marca', 'Unidade', 'Nome do Lead', 'Canal',
      'Origem (Paga/Orgânica)', 'UTM Source', 'Atendente', 'Contact ID (GymBot)',
    ],
  },
  atendimentos: {
    id: config.google.sheets.atendimentos,
    tab: 'Sheet1',
    headers: [
      'Data/Hora', 'Marca', 'Unidade', 'Atendente', 'Lead', 'Canal',
      'Status (Atendido/Fechado)', 'Horário 1ª Resposta', 'Session ID (GymBot)',
      'Contact ID (GymBot)',
      // Novo / Recorrente — se já existia algum atendimento anterior pra este
      // mesmo Contact ID quando este foi registrado. Base para entender, ao
      // longo do tempo, quanto de conversao vem de lead reativado (impactado
      // de novo por um anuncio meses depois, por exemplo) versus lead que
      // fechou no primeiro contato. So calculado com confianca em tempo real
      // (webhook chega em ordem cronologica); na importacao historica fica em
      // branco quando a ordem de processamento nao garante a classificacao
      // correta (ver comentario em scripts/import-history.js).
      'Classificação do Lead',
    ],
  },
  conversoes: {
    id: config.google.sheets.conversoes,
    tab: 'Sheet1',
    headers: [
      'Data/Hora', 'Marca', 'Unidade', 'Atendente', 'Lead', 'Valor',
      'Session ID (GymBot)', 'Motivo', 'Dias até Conversão', 'Contact ID (GymBot)',
    ],
  },
  avaliacoes: {
    id: config.google.sheets.avaliacoes,
    tab: 'Sheet1',
    headers: [
      'Data/Hora', 'Marca', 'Unidade', 'Atendente', 'Lead',
      'Nota Geral (1-5)', 'Nota Cordialidade', 'Nota Personalização',
      'Nota Clareza da Oferta', 'Nota Tratamento Objeções',
      'Nota Fechamento/CTA', 'Nota Follow-up', 'Objeções Identificadas',
      'Pontos Fortes', 'Pontos Fracos', 'Session ID (GymBot)',
      // Convertido / Não convertido / Em aberto — preenchido/atualizado
      // pela varredura de reconciliacao conforme o resultado real do lead.
      'Resultado',
    ],
  },
  sinteses: {
    id: config.google.sheets.sinteses,
    tab: 'Sheet1',
    headers: [
      'Data do Período', 'Tipo (Diário/Semanal/Mensal)', 'Marca', 'Atendente',
      'Avaliação Geral', 'Volume de Objeções', 'Pontos Fortes Consolidados',
      'Pontos Fracos Consolidados', 'Sugestão de Melhoria',
      // Indica se essa linha de sintese e sobre o grupo "Convertido" ou
      // "Não convertido" do atendente no periodo.
      'Resultado',
    ],
  },
  manual: {
    id: config.google.sheets.manual,
    tab: 'Sheet1',
    headers: [
      'Data', 'Marca', 'Versão do Manual', 'Principais Mudanças',
      'Baseado em (N atendimentos convertidos)', 'Período Analisado',
    ],
  },
};

let authClientPromise = null;

function getAuthClient() {
  if (!authClientPromise) {
    const credentials = JSON.parse(config.google.serviceAccountJson);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    authClientPromise = auth.getClient();
  }
  return authClientPromise;
}

async function sheetsApi() {
  const auth = await getAuthClient();
  return google.sheets({ version: 'v4', auth });
}

function sheetDef(key) {
  const def = SHEETS[key];
  if (!def) throw new Error(`Planilha desconhecida: ${key}`);
  return def;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isQuotaError(err) {
  const status = err?.response?.status || err?.code;
  if (status === 429) return true;
  const msg = err?.message || '';
  const details = JSON.stringify(err?.response?.data || err?.errors || '');
  return /quota exceeded/i.test(msg) || /quota exceeded/i.test(details) || /rate limit/i.test(msg);
}

// Reexecuta `fn` com espera crescente (backoff exponencial) quando o
// Google Sheets responde "cota excedida" — em vez de desistir e perder o
// dado (o que acontecia antes em importacoes com muitas linhas).
async function withRetry(fn, { retries = 6, baseDelayMs = 3000 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fn();
    } catch (err) {
      if (!isQuotaError(err) || attempt >= retries) throw err;
      const delay = baseDelayMs * 2 ** attempt;
      logger.warn(`[sheets] Cota da API excedida — tentando de novo em ${Math.round(delay / 1000)}s (tentativa ${attempt + 1}/${retries}).`);
      // eslint-disable-next-line no-await-in-loop
      await sleep(delay);
    }
  }
}

// Adiciona uma linha nova no fim da planilha. `rowObject` deve ter chaves
// iguais (ou um subconjunto) dos headers definidos acima.
async function appendRow(sheetKey, rowObject) {
  const def = sheetDef(sheetKey);
  const row = def.headers.map((h) => rowObject[h] ?? '');
  await withRetry(async () => {
    const api = await sheetsApi();
    await api.spreadsheets.values.append({
      spreadsheetId: def.id,
      range: `${def.tab}!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });
  });
}

// Le todas as linhas da planilha como uma lista de objetos {header: valor}.
async function readAll(sheetKey) {
  const def = sheetDef(sheetKey);
  const data = await withRetry(async () => {
    const api = await sheetsApi();
    const resp = await api.spreadsheets.values.get({
      spreadsheetId: def.id,
      range: `${def.tab}!A2:${String.fromCharCode(64 + def.headers.length)}100000`,
    });
    return resp.data;
  });
  const rows = data.values || [];
  return rows.map((row, idx) => {
    const obj = { _rowNumber: idx + 2 }; // +2: cabecalho ocupa a linha 1
    def.headers.forEach((h, i) => { obj[h] = row[i] ?? ''; });
    return obj;
  });
}

// Atualiza uma linha inteira, por numero de linha (1-based, incluindo o
// cabecalho — use o _rowNumber devolvido por readAll()).
async function updateRow(sheetKey, rowNumber, rowObject) {
  const def = sheetDef(sheetKey);
  const row = def.headers.map((h) => rowObject[h] ?? '');
  const lastCol = String.fromCharCode(64 + def.headers.length);
  await withRetry(async () => {
    const api = await sheetsApi();
    await api.spreadsheets.values.update({
      spreadsheetId: def.id,
      range: `${def.tab}!A${rowNumber}:${lastCol}${rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });
  });
}

// Encontra a primeira linha cujo valor da coluna `header` bate com `value`.
// Util para achar um atendimento existente pelo Session ID antes de decidir
// entre gravar linha nova ou atualizar a existente. So faz sentido usar
// isso quando a checagem e ocasional — para checar MUITOS itens numa
// mesma execucao (ex: importador historico), use buildIndex() em vez
// disso, para nao estourar a cota de leitura por minuto.
async function findRowByColumn(sheetKey, header, value) {
  const rows = await readAll(sheetKey);
  return rows.find((r) => r[header] === value) || null;
}

// Le a planilha inteira UMA unica vez e devolve um Map indexado por uma
// coluna (valor da coluna -> linha). Pensado para importacoes em lote:
// em vez de 1 leitura da API por item (o que estoura a cota do Google
// Sheets quando ha centenas/milhares de itens), fazemos 1 leitura no
// inicio e consultamos o Map em memoria dali pra frente.
async function buildIndex(sheetKey, header) {
  const rows = await readAll(sheetKey);
  const map = new Map();
  rows.forEach((r) => {
    if (r[header]) map.set(r[header], r);
  });
  return map;
}

// Substitui TODO o conteudo de dados da planilha (mantendo o cabecalho)
// pela lista de linhas fornecida. Usado pelo script de limpeza para
// remover, de uma vez so, linhas fora de um periodo — muito mais barato
// em chamadas de API do que apagar linha por linha.
async function replaceAll(sheetKey, rowsObjects) {
  const def = sheetDef(sheetKey);
  const lastCol = String.fromCharCode(64 + def.headers.length);

  await withRetry(async () => {
    const api = await sheetsApi();
    await api.spreadsheets.values.clear({
      spreadsheetId: def.id,
      range: `${def.tab}!A2:${lastCol}100000`,
    });
  });

  if (!rowsObjects.length) return;

  const values = rowsObjects.map((obj) => def.headers.map((h) => obj[h] ?? ''));
  await withRetry(async () => {
    const api = await sheetsApi();
    await api.spreadsheets.values.update({
      spreadsheetId: def.id,
      range: `${def.tab}!A2`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });
  });
}

// Como findRowByColumn, mas quando pode haver MAIS DE UMA linha com o
// mesmo valor na coluna (ex: varios atendimentos do mesmo Contact ID) e o
// que importa e a mais ANTIGA por data — nao a primeira em ordem de
// insercao na planilha (que so coincide com ordem cronologica quando os
// dados sempre chegam em tempo real; a importacao historica pagina do mais
// novo pro mais antigo, entao a ordem de insercao pode nao ser a ordem
// cronologica real). Usado para achar a data do PRIMEIRO atendimento de um
// lead, base do calculo de "Dias ate Conversao" — precisa ser a data real
// mais antiga, nao "a que apareceu primeiro na planilha".
async function findEarliestRowByColumn(sheetKey, matchHeader, matchValue, dateHeader) {
  if (!matchValue) return null;
  const rows = await readAll(sheetKey);
  const candidatas = rows.filter((r) => r[matchHeader] === matchValue);
  if (!candidatas.length) return null;

  let earliest = null;
  let earliestTime = Infinity;
  candidatas.forEach((r) => {
    const t = r[dateHeader] ? new Date(r[dateHeader]).getTime() : NaN;
    if (!Number.isNaN(t) && t < earliestTime) {
      earliestTime = t;
      earliest = r;
    }
  });
  // Se nenhuma candidata tinha data valida (nao deveria acontecer, mas por
  // seguranca), devolve a primeira encontrada em vez de nada.
  return earliest || candidatas[0];
}

module.exports = {
  SHEETS, appendRow, readAll, updateRow, findRowByColumn, findEarliestRowByColumn, buildIndex, replaceAll,
};
