// sheets.js — versão com telefone corrigido + dropdown de status + WA_JID interno

import { google } from "googleapis";

const SPREADSHEET_ID = "1UFDBNu5Y4hQE375BqPUbIMUNrp2vvLsn2oKutaP5Ac4";
const STATUS_SHEET_NAME = "STATUS DO PEDIDO";

const auth = new google.auth.GoogleAuth({
  keyFile: "google-credentials.json",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

async function getSheetsClient() {
  const authClient = await auth.getClient();
  return google.sheets({ version: "v4", auth: authClient });
}

// cache do sheetId da aba STATUS DO PEDIDO
let cachedStatusSheetId = null;

async function getStatusSheetId(sheets) {
  if (cachedStatusSheetId !== null) return cachedStatusSheetId;

  const res = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
  });

  const sheet = res.data.sheets.find(
    (s) => s.properties?.title === STATUS_SHEET_NAME
  );

  if (!sheet) {
    throw new Error(
      `Aba "${STATUS_SHEET_NAME}" não encontrada na planilha ${SPREADSHEET_ID}`
    );
  }

  cachedStatusSheetId = sheet.properties.sheetId;
  return cachedStatusSheetId;
}

/* ----------------------- APPEND ORDER ------------------------- */

export async function appendOrder(order) {
  const sheets = await getSheetsClient();

  // TELEFONE — agora vai exatamente como veio (sem aspas extras)
  const telefoneSheet = order.telefone || "";

  // DATA/HORA — sempre formatada corretamente
  const dataHora = new Date().toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
  });

  // Linha exata enviada ao Google Sheets
  const linha = [
    order.id || "",                // A - ID
    dataHora,                      // B - Data/Hora
    order.nome || "cliente",       // C - Nome
    telefoneSheet,                 // D - Telefone (interno)
    order.itens || "",             // E - Itens
    order.total || "",             // F - Total
    "PENDENTE CONFIRMACAO",        // G - Status
    order.regiao || "",            // H - Região
    order.endereco || "",          // I - Endereço
    "",                            // J - Notificado Saída p/ Entrega
    order.formaPagamento || "",    // K - Forma de pagamento
    order.observacoes || "",       // L - Observações
    order.origem || "WhatsApp",    // M - Origem
    order.waJid || "",             // N - WA_JID (interno p/ notificações)
  ];

  // agora adiciona a linha NO FINAL da aba (continuidade após o último registro)
  const appendRes = await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${STATUS_SHEET_NAME}!A:N`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [linha] },
  });

  // pega a linha que o Google realmente usou (ex: 'STATUS DO PEDIDO'!A23:N23)
  const updatedRange = appendRes.data.updates?.updatedRange || "";
  let newRowNumber = null;

  const match = updatedRange.match(/![A-Z]+(\d+):/);
  if (match) {
    newRowNumber = parseInt(match[1], 10);
  }

  // aplica data validation + FORMATO (cores) na coluna G dessa linha
  if (newRowNumber) {
    const sheetId = await getStatusSheetId(sheets);

    const requests = [
      // copia FORMATO da célula G2 para a nova célula de status
      {
        copyPaste: {
          source: {
            sheetId,
            startRowIndex: 1,     // linha 2 (zero-based)
            endRowIndex: 2,
            startColumnIndex: 6,  // coluna G (A=0)
            endColumnIndex: 7,
          },
          destination: {
            sheetId,
            startRowIndex: newRowNumber - 1,
            endRowIndex: newRowNumber,
            startColumnIndex: 6,
            endColumnIndex: 7,
          },
          pasteType: "PASTE_FORMAT",
          pasteOrientation: "NORMAL",
        },
      },
      // garante o dropdown com os três status
      {
        setDataValidation: {
          range: {
            sheetId,
            startRowIndex: newRowNumber - 1, // zero-based
            endRowIndex: newRowNumber,
            startColumnIndex: 6, // G (A=0)
            endColumnIndex: 7,
          },
          rule: {
            condition: {
              type: "ONE_OF_LIST",
              values: [
                { userEnteredValue: "PENDENTE CONFIRMACAO" },
                { userEnteredValue: "ACEITO" },
                { userEnteredValue: "SAIU PRA ENTREGA" },
              ],
            },
            strict: true,
            showCustomUi: true,
          },
        },
      },
    ];

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests },
    });
  }

  return { ok: true };
}

/* ------------------------- GET LAST ORDER ------------------------- */

export async function getLastOrderByPhone(telefone) {
  const sheets = await getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${STATUS_SHEET_NAME}!A2:N10000`,
  });

  const rows = res.data.values || [];
  const telefoneNormalizado = (telefone || "").replace(/\D/g, "");

  let foundRow = null;
  let foundIndex = -1;

  rows.forEach((row, index) => {
    const cellPhone = (row[3] || "").replace(/\D/g, "");
    if (!cellPhone) return;

    if (
      telefoneNormalizado.endsWith(cellPhone) ||
      cellPhone.endsWith(telefoneNormalizado)
    ) {
      foundIndex = index;
      foundRow = row;
    }
  });

  if (!foundRow) return null;

  const rowNumber = foundIndex + 2;

  return {
    rowNumber,
    id: foundRow[0] || "",
    dataHora: foundRow[1] || "",
    nome: foundRow[2] || "",
    telefone: foundRow[3] || "",
    itens: foundRow[4] || "",
    total: foundRow[5] || "",
    status: foundRow[6] || "",
    regiao: foundRow[7] || "",
    endereco: foundRow[8] || "",
    notificadoStatus: foundRow[9] || "",
    origem: foundRow[12] || "",
    waJid: foundRow[13] || "",
  };
}

/* ------------------------- GET STATUS ------------------------- */

export async function getStatusForPhone(telefone) {
  const pedido = await getLastOrderByPhone(telefone);
  return pedido ? pedido.status : null;
}

/* ------------------- UPDATE NOTIFICATION ------------------- */

export async function updateNotifiedStatus(rowNumber, newStatus) {
  const sheets = await getSheetsClient();

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${STATUS_SHEET_NAME}!J${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[newStatus]] },
  });

  return { ok: true };
}

/* ---------------------- FIND PENDING NOTIFICATIONS ---------------------- */

export async function findOrdersNeedingNotification() {
  const sheets = await getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${STATUS_SHEET_NAME}!A2:N10000`,
  });

  const rows = res.data.values || [];
  const pendentes = [];

  rows.forEach((row, index) => {
    const status = ((row[6] || "").trim()).toUpperCase();
    const notif  = ((row[9] || "").trim()).toUpperCase();
    const telefone = (row[3] || "").replace(/\D/g, "");
    const nome = row[2] || "";
    const waJid = row[13] || "";
    const rowNumber = index + 2;

    if (!telefone && !waJid) return;

    if (status === "ACEITO" && notif !== "ACEITO") {
      pendentes.push({ rowNumber, telefone, nome, status: "ACEITO", waJid });
    }

    if (status === "SAIU PRA ENTREGA" && notif !== "SAIU PRA ENTREGA") {
      pendentes.push({
        rowNumber,
        telefone,
        nome,
        status: "SAIU PRA ENTREGA",
        waJid,
      });
    }
  });

  return pendentes;
}
