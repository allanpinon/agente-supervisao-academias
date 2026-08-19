// Cliente do Google Sheets — le/escreve nas 5 planilhas que servem de
// banco de dados do agente. Usa a conta de servico do Google Cloud
// (GOOGLE_SERVICE_ACCOUNT_JSON) para autenticar, sem depender de login
// pessoal de ninguem.
const { google } = require('googleapis');
const { config } = require('../config');

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
    ],
  },
  sinteses: {
    id: config.google.sheets.sinteses,
    tab: 'Sheet1',
    headers: [
      'Data do Período', 'Tipo (Diário/Semanal/Mensal)', 'Marca', 'Atendente',
      'Avaliação Geral', 'Volume de Objeções', 'Pontos Fortes Consolidados',
      'Pontos Fracos Consolidados', 'Sugestão de Melhoria',
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

// Adiciona uma linha nova no fim da planilha. `rowObject` deve ter chaves
// iguais (ou um subconjunto) dos headers definidos acima.
async function appendRow(sheetKey, rowObject) {
  const def = sheetDef(sheetKey);
  const api = await sheetsApi();
  const row = def.headers.map((h) => rowObject[h] ?? '');
  await api.spreadsheets.values.append({
    spreadsheetId: def.id,
    range: `${def.tab}!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}

// Le todas as linhas da planilha como uma lista de objetos {header: valor}.
async function readAll(sheetKey) {
  const def = sheetDef(sheetKey);
  const api = await sheetsApi();
  const { data } = await api.spreadsheets.values.get({
    spreadsheetId: def.id,
    range: `${def.tab}!A2:${String.fromCharCode(64 + def.headers.length)}100000`,
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
  const api = await sheetsApi();
  const row = def.headers.map((h) => rowObject[h] ?? '');
  const lastCol = String.fromCharCode(64 + def.headers.length);
  await api.spreadsheets.values.update({
    spreadsheetId: def.id,
    range: `${def.tab}!A${rowNumber}:${lastCol}${rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
}

// Encontra a primeira linha cujo valor da coluna `header` bate com `value`.
// Util para achar um atendimento existente pelo Session ID antes de decidir
// entre gravar linha nova ou atualizar a existente.
async function findRowByColumn(sheetKey, header, value) {
  const rows = await readAll(sheetKey);
  return rows.find((r) => r[header] === value) || null;
}

module.exports = { SHEETS, appendRow, readAll, updateRow, findRowByColumn };
