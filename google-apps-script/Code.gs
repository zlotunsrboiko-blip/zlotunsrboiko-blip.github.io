const SPREADSHEET_ID = '1nn9pfHUjlV10aZOXlaFfwoVdeJvZAG4H_bhMqYlJ9_A';
const SYNC_SECRET = '__SET_DURING_DEPLOYMENT__';

function doPost(e) {
  try {
    const input = JSON.parse(e.postData.contents || '{}');
    if (!constantTimeEqual_(String(input.secret || ''), SYNC_SECRET)) return json_({ok:false}, 403);
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return json_({ok:false}, 409);
    try {
      writeMirror_('Заказы — авто', input.orders || []);
      writeMirror_('Пул — авто', input.pool || []);
      return json_({ok:true});
    } finally { lock.releaseLock(); }
  } catch (error) { return json_({ok:false}, 400); }
}

function writeMirror_(title, rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 50000) throw new Error('Invalid rows');
  const width = rows[0].length;
  if (!width || rows.some(row => !Array.isArray(row) || row.length !== width)) throw new Error('Invalid shape');
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(title);
  if (!sheet) throw new Error('Missing mirror sheet');
  const safe = rows.map((row, rowIndex) => row.map((value, colIndex) => {
    if (typeof value !== 'string' || rowIndex === 0) return value;
    return /^[=+\-@]/.test(value) ? "'" + value : value;
  }));
  const clearRows = Math.max(sheet.getLastRow(), rows.length);
  sheet.getRange(1, 1, clearRows, width).clearContent();
  sheet.getRange(1, 1, rows.length, width).setValues(safe);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#eeeeee').setWrap(true);
  if (title === 'Заказы — авто' && rows.length > 1) {
    sheet.getRange(2, 2, rows.length - 1, 1).setNumberFormat('dd.mm.yyyy hh:mm');
    sheet.getRange(2, 10, rows.length - 1, 2).setNumberFormat('#,##0.00');
    sheet.getRange(2, 12, rows.length - 1, 1).setNumberFormat('dd.mm.yyyy hh:mm');
  }
  if (title === 'Пул — авто' && rows.length > 1) sheet.getRange(2, 10, rows.length - 1, 2).setNumberFormat('dd.mm.yyyy hh:mm');
}

function constantTimeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
