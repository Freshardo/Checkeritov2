'use strict';
const crypto = require('node:crypto');
const { UserError } = require('./model');
const emailPattern = /^[^\s@|:]+@[^\s@|:]+\.[^\s@|:]+$/;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const sourceHostAllowed = host => host === 'tiendanube.com' || host.endsWith('.tiendanube.com') || host.endsWith('.mitiendanube.com');

function parseAccountFile(text) {
  const byKey = new Map();
  const issues = [];
  let totalRecords = 0, duplicates = 0, invalidRecords = 0;
  const formats = new Set();
  for (const [index, raw] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    totalRecords++;
    let email, password, store_url = '', format;
    try {
      if (/^[^\s@|:]+@[^\s@|:]+\|/.test(raw.trimStart())) {
        const parts = raw.trimStart().split('|');
        if (parts.length !== 3) throw new Error('FORMAT');
        [email, password] = parts; format = 'EMAIL_PASSWORD_STORE';
        const value = parts[2].trim();
        const url = new URL(value.includes('://') ? value : `https://${value}`);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname.includes('.') || url.port || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('STORE');
        store_url = url.hostname.toLowerCase();
      } else {
        const value = raw.trimStart().replace(/^URL\s*:\s*/i, '');
        // An email delimiter determines the URL boundary, including its scheme
        // colon. Everything after the password delimiter remains the password.
        const match = value.match(/^(.*?)\s*:\s*([^:\s]+@[^:\s]+)\s*:(.*)$/) || value.match(/^(.*?)\|\s*([^|\s]+@[^|\s]+)\s*\|(.*)$/);
        if (!match) throw new Error('FORMAT');
        const source = match[1].trim();
        email = match[2]; password = match[3]; format = 'URL_EMAIL_PASSWORD';
        const url = new URL(source.includes('://') ? source : `https://${source}`);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || !sourceHostAllowed(url.hostname.toLowerCase())) throw new Error('SOURCE');
        if (url.hostname.toLowerCase().endsWith('.mitiendanube.com')) store_url = url.hostname.toLowerCase();
        // The login URL identifies the provider, never the user's store. No
        // arbitrary URL from this file is navigated to or given credentials.
      }
      email = email.trim().toLowerCase();
      if (!emailPattern.test(email)) throw new Error('EMAIL');
      if (!password || /[\x00-\x1F]/.test(password)) throw new Error('PASSWORD');
      const key = hash(`${email}|${store_url}`);
      const existing = byKey.get(key);
      if (existing) {
        duplicates++;
        if (existing.password !== password) {
          existing.credentialConflict = true;
          issues.push({ line: index + 1, reason: 'Contraseña distinta para la misma cuenta. Requiere elegir un registro antes de procesar.' });
        }
      } else byKey.set(key, { key, email, password, store_url, sourceLine: index + 1, sourceFormat: format, credentialConflict: false });
      formats.add(format);
    } catch (error) {
      invalidRecords++;
      const reasons = { STORE: 'Dominio de tienda inválido.', SOURCE: 'La URL de origen no corresponde a Tiendanube.', EMAIL: 'El usuario debe ser un email.', PASSWORD: 'Contraseña vacía o con caracteres de control.', FORMAT: 'Formato no reconocido o usuario sin email.' };
      issues.push({ line: index + 1, reason: reasons[error.message] || 'Registro inválido.' });
    }
  }
  const accounts = [...byKey.values()];
  if (!accounts.length) throw new UserError(totalRecords ? `No se encontraron cuentas importables. Revisá la línea ${issues[0]?.line || 1}: ${issues[0]?.reason || 'formato inválido'}` : 'El archivo no contiene cuentas.');
  return { accounts, report: { totalRecords, importedRecords: accounts.length, duplicates, invalidRecords, conflicts: accounts.filter(a => a.credentialConflict).length, unboundStores: accounts.filter(a => !a.store_url).length, formats: [...formats], issues } };
}
module.exports = { parseAccountFile };
