'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseAccounts, parseAccountImport, parseProxies, publicAccount, publicProxy, proxyUrl, csvRow } = require('../src/core/model');
test('imports BOM, CRLF and duplicates without losing password whitespace', () => {
  const rows = parseAccounts('\uFEFFa@b.com| secret |store.mitiendanube.com\r\na@b.com|other|https://store.mitiendanube.com/');
  assert.equal(rows.length, 1); assert.equal(rows[0].password, ' secret ');
});
test('invalid imports never echo credentials or guess a store for URL credential lists', () => {
  assert.throws(() => parseAccounts('x|supersecret|bad|url'), error => !error.message.includes('supersecret'));
  assert.throws(() => parseAccounts('a@b.com|secret|https://user:password@example.com'));
  const generic = parseAccounts('https://www.tiendanube.com/login:a@b.com:supersecret');
  assert.equal(generic[0].store_url, '');
  assert.throws(() => parseAccounts('https://evil.test/login:a@b.com:supersecret'), error => !error.message.includes('supersecret'));
});
test('renderer DTOs expose endpoint and IP without account or proxy credentials', () => {
  const p = parseProxies('http://secret-user:proxy-secret@localhost:8000')[0];
  const a = { ...parseAccounts('a@b.com|account-secret|store.test')[0], id: 'account_001', proxyId: p.id, ip: '192.0.2.1' };
  const json = JSON.stringify([publicAccount(a, [p]), publicProxy(p)]);
  for (const secret of ['account-secret', 'password', 'secret-user', 'proxy-secret']) assert.ok(!json.includes(secret));
  assert.equal(publicAccount(a, [p]).ip, '192.0.2.1');
});
test('TXT supports automatic type detection, explicit protocols, IPv6 and authentication', () => {
  const p = parseProxies('host.test:3128:user:pa:ss\nhttps://user:p%40ss@host.test:8443\nsocks5://host.test:1080\n[::1]:8000');
  assert.equal(p[0].type, null); assert.equal(p[0].password, 'pa:ss'); assert.equal(p[1].type, 'https'); assert.equal(p[2].type, 'socks5'); assert.equal(p[3].host, '[::1]');
  assert.equal(proxyUrl(p[1]), 'https://user:p%40ss@host.test:8443');
});
test('provider CSV preserves quoted credentials, uses Network_Protocol and ignores source availability', () => {
  const csv = '\uFEFFIP,Address:Port:Username:Password,Country-State(Province)-City,Network_Protocol,Status\r\n,"host.test:8080:user:pa,ss""word",Anywhere,HTTP,Active\r\n';
  const p = parseProxies(csv); assert.equal(p.length, 1); assert.equal(p[0].password, 'pa,ss"word'); assert.equal(p[0].protocol, 'http'); assert.equal(p[0].status, 'SIN_COMPROBAR');
  assert.equal(p[0].id, parseProxies('http://user:pa%2Css%22word@host.test:8080')[0].id);
});
test('generic CSV columns, semicolons, duplicates and unsupported protocol validation', () => {
  const p = parseProxies('host;port;username;password;protocol\nhost.test;1080;user;secret;socks5\nhost.test;1080;user;secret;socks5');
  assert.equal(p.length, 1); assert.equal(p[0].type, 'socks5');
  assert.throws(() => parseProxies('host,port,username,password,protocol\nhost.test,99,user,TOP-SECRET,ftp'), e => !e.message.includes('TOP-SECRET'));
  assert.throws(() => parseProxies('IP,Address:Port:Username:Password,Network_Protocol\n,"host.test:80:user:TOP-SECRET,http'), e => !e.message.includes('TOP-SECRET'));
});
test('CSV escaping blocks spreadsheet formulas and embedded new lines', () => { assert.equal(csvRow(['=1+1', 'a"b', 'x\ny']), '"\'=1+1","a""b","x y"\r\n'); });
test('URL account input preserves password separators and infers only an actual store host', () => {
  const result = parseAccountImport('https://www.tiendanube.com/login:person@example.test:secret:with|separators\nURL: https://store.mitiendanube.com/admin/:other@example.test:pass\nhttps://www.tiendanube.com/login|third@example.test|password');
  assert.equal(result.accounts[0].password, 'secret:with|separators'); assert.equal(result.accounts[0].store_url, '');
  assert.equal(result.accounts[1].store_url, 'store.mitiendanube.com'); assert.equal(result.accounts[2].email, 'third@example.test');
});
test('mixed input accounts for every record, deduplicates and flags password conflicts without exposing values', () => {
  const result = parseAccountImport('https://www.tiendanube.com/login:a@example.test:TOP-SECRET\nhttps://www.tiendanube.com/login:a@example.test:TOP-SECRET\nhttps://www.tiendanube.com/login:a@example.test:ALTERNATIVE-SECRET\nhttps://www.tiendanube.com/login:username:OTHER-SECRET\nbroken-record');
  assert.equal(result.report.totalRecords, 5); assert.equal(result.report.importedRecords, 1); assert.equal(result.report.duplicates, 2); assert.equal(result.report.invalidRecords, 2); assert.equal(result.report.conflicts, 1);
  assert.equal(result.accounts[0].credentialConflict, true);
  for (const secret of ['TOP-SECRET', 'ALTERNATIVE-SECRET', 'OTHER-SECRET', 'username', 'broken-record']) assert.ok(!JSON.stringify(result.report).includes(secret));
});
