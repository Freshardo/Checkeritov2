'use strict';
// Parse only CSV structure. Cells remain local and are never included in errors.
function readCsv(text, delimiter, fail) {
  const rows = []; let row = [], cell = '', quoted = false, endedQuote = false;
  const endCell = () => { row.push(cell); cell = ''; endedQuote = false; };
  const endRow = () => { endCell(); if (row.some(value => value.trim())) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') { quoted = false; endedQuote = true; }
      else cell += char;
    } else if (char === delimiter) endCell();
    else if (char === '\r' || char === '\n') { endRow(); if (char === '\r' && text[i + 1] === '\n') i++; }
    else if (char === '"' && !cell && !endedQuote) quoted = true;
    else if (char === '"' || endedQuote) throw fail(rows.length + 1);
    else cell += char;
  }
  if (quoted) throw fail(rows.length + 1);
  if (cell || row.length || endedQuote) endRow();
  return rows;
}
module.exports = { readCsv };
