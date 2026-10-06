'use strict';
const crypto = require('node:crypto');
const net = require('node:net');

const STATUS = Object.freeze({ PENDING: 'PENDIENTE', RUNNING: 'PROCESANDO', VALID: 'VALIDA', MANUAL: 'REQUIERE_VALIDACION', INVALID: 'NO_FUNCIONA', TEMP: 'ERROR_TEMPORAL', DATA: 'REQUIERE_DATOS' });
const RESULT_DIRS = { VALIDA: 'validas', REQUIERE_VALIDACION: 'pendientes_validacion', NO_FUNCIONA: 'no_funcionan', ERROR_TEMPORAL: 'errores_temporales' };
class UserError extends Error {}
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const lines = text => text.replace(/^\uFEFF/, '').split(/\r?\n/).map((text, i) => ({ text: text.trim(), number: i + 1 })).filter(x => x.text && !x.text.startsWith('#'));

function parseAccountImport(text) { return require('./account-import').parseAccountFile(text); }
function parseAccounts(text) { return parseAccountImport(text).accounts; }

function parseProxies(text) {
  const clean = text.replace(/^\uFEFF/, '');
  const header = clean.split(/\r?\n/, 1)[0];
  if (/^(?:"?(?:ip|host|hostname|address|proxy|protocol|type)"?[,;\t])|address:port:username:password|network_protocol/i.test(header)) return parseProxyCsv(clean);
  return parseProxyLines(clean);
}
function parseProxyCsv(text) {
  const { readCsv } = require('./proxy-csv');
  const first = text.split(/\r?\n/, 1)[0];
  const delimiter = first.includes(',') ? ',' : first.includes(';') ? ';' : '\t';
  const fail = row => new UserError(`CSV de proxies inválido en fila ${row}. Revisá columnas y comillas.`);
  const rows = readCsv(text, delimiter, fail);
  const headers = rows.shift()?.map(value => value.trim().toLowerCase()) || [];
  const index = names => headers.findIndex(h => names.includes(h));
  const combined = index(['address:port:username:password', 'proxy', 'proxy_url']);
  const hostIndex = index(['host', 'hostname', 'ip', 'address']);
  const portIndex = index(['port', 'puerto']);
  const userIndex = index(['username', 'user', 'usuario']);
  const passIndex = index(['password', 'pass', 'contraseña']);
  const protocolIndex = index(['network_protocol', 'protocol', 'type', 'protocolo']);
  if (combined < 0 && (hostIndex < 0 || portIndex < 0)) throw new UserError('El CSV necesita Address:Port:Username:Password o columnas host y port.');
  const result = []; const seen = new Set();
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i];
    if (cells.length !== headers.length) throw fail(i + 2);
    const protocol = protocolIndex < 0 ? '' : cells[protocolIndex].trim().toLowerCase();
    if (protocol && !['http', 'https', 'socks5'].includes(protocol)) throw new UserError(`Protocolo no compatible en fila ${i + 2}. Usá HTTP, HTTPS o SOCKS5.`);
    let entry;
    try {
      if (combined >= 0) entry = parseProxyLines(cells[combined].trim())[0];
      else {
        const host = cells[hostIndex].trim(); const port = cells[portIndex].trim();
        const username = userIndex < 0 ? '' : cells[userIndex]; const password = passIndex < 0 ? '' : cells[passIndex];
        if (password && !username) throw new Error();
        const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
        entry = parseProxyLines(`${protocol || 'http'}://${auth}${host}:${port}`)[0];
        if (!protocol) { entry.protocol = 'auto'; entry.type = null; }
      }
      if (protocol && entry.protocol !== 'auto' && entry.protocol !== protocol) throw new Error();
      if (protocol) { entry.protocol = protocol; entry.type = protocol; }
      entry.id = hash(`${entry.protocol}|${entry.host}|${entry.port}|${entry.username}|${entry.password}`);
    } catch { throw new UserError(`Proxy inválida en fila ${i + 2} del CSV. Revisá dirección, puerto y autenticación.`); }
    if (!seen.has(entry.id)) { result.push(entry); seen.add(entry.id); }
  }
  if (!result.length) throw new UserError('El CSV no contiene proxies.');
  return result;
}
function parseProxyLines(text) {
  const result = [];
  const seen = new Set();
  for (const line of lines(text)) {
    let protocol = 'auto', host, port, username = '', password = '';
    try {
      if (line.text.includes('://')) {
        const url = new URL(line.text);
        protocol = url.protocol.slice(0, -1);
        if (!['http', 'https', 'socks5'].includes(protocol) || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error();
        host = url.hostname; port = url.port || (protocol === 'https' ? '443' : protocol === 'http' ? '80' : '1080');
        username = decodeURIComponent(url.username); password = decodeURIComponent(url.password);
      } else {
        const match = line.text.match(/^(\[[\da-fA-F:]+\]|[^:\s]+):(\d+)(?::([^:]+):(.+))?$/);
        if (!match) throw new Error();
        [, host, port, username = '', password = ''] = match;
      }
      if (!host || !/^\d+$/.test(port) || +port < 1 || +port > 65535 || /[\s\/@?#]/.test(host) || /[\x00-\x1F]/.test(username + password)) throw new Error();
    } catch { throw new UserError(`Proxy inválida en línea ${line.number}. Usá host:puerto[:usuario:contraseña] o una URL HTTP, HTTPS o SOCKS5.`); }
    const key = hash(`${protocol}|${host.toLowerCase()}|${port}|${username}|${password}`);
    if (!seen.has(key)) { result.push({ id: key, host: host.toLowerCase(), port: +port, username, password, protocol, type: protocol === 'auto' ? null : protocol, status: 'SIN_COMPROBAR', ip: '', latency: null, checkedAt: null }); seen.add(key); }
  }
  if (!result.length) throw new UserError('El archivo no contiene proxies.');
  return result;
}
function proxyLabel(proxy) { return proxy ? `${proxy.type || proxy.protocol}://${proxy.host}:${proxy.port}` : ''; }
function proxyUrl(proxy, type = proxy.type) {
  if (!['http', 'https', 'socks5'].includes(type)) throw new UserError('Primero comprobá la proxy.');
  return `${type}://${proxy.username ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@` : ''}${proxy.host}:${proxy.port}`;
}
function publicProxy(p) { return { id: p.id, label: proxyLabel(p), type: p.type || 'AUTO', ip: p.ip, latency: p.latency, status: p.status, checkedAt: p.checkedAt }; }
function publicAccount(a, proxies) {
  const proxy = proxies.find(p => p.id === a.proxyId);
  return { id: a.id, email: a.email, store_url: a.store_url, status: a.status, reason: a.reason || '', timestamp: a.timestamp || '', proxy: proxyLabel(proxy), ip: a.ip || '', securityLocked: !!a.securityLocked, sourceLine: a.sourceLine || null, credentialConflict: !!a.credentialConflict };
}
function csvCell(value) {
  let text = String(value ?? '').replace(/[\r\n]+/g, ' ');
  if (/^[=+\-@\t]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
const csvRow = values => values.map(csvCell).join(',') + '\r\n';
const validIp = value => typeof value === 'string' && !!net.isIP(value);
module.exports = { STATUS, RESULT_DIRS, UserError, parseAccounts, parseAccountImport, parseProxies, proxyLabel, proxyUrl, publicProxy, publicAccount, csvRow, validIp };
