'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Manager } = require('../src/core/manager');
const { STATUS } = require('../src/core/model');
async function fixture(results) {
  const attempts = [], closed = [], opened = [];
  const browser = { login: async (a, p, signal, progress) => { assert.equal(p.status, 'DISPONIBLE'); assert.equal(typeof signal.aborted, 'boolean'); assert.equal(typeof progress, 'function'); attempts.push([a.id, p.id]); return results.shift(); }, probe: async () => ({ status: 'NO_FUNCIONA', connectivityFailed: true }), openManual: async (a, p) => opened.push([a.id, p.id]), close: async id => closed.push(id), closeAll: async () => {} };
  const manager = new Manager({ save: async () => {}, root: 'test' }, browser);
  await manager.importAccounts('a@b.com|secret|a.test\nc@d.com|secret|b.test');
  await manager.importProxies('http://user:secret@127.0.0.1:8001\nhttp://user:secret@127.0.0.1:8002');
  manager.proxies.forEach(p => { p.status = 'DISPONIBLE'; });
  return { manager, attempts, closed, opened, browser };
}
test('requires available proxies and assigns them sequentially before login', async () => {
  const { manager, attempts } = await fixture([{ status: STATUS.VALID, reason: 'ok' }, { status: STATUS.VALID, reason: 'ok' }]);
  manager.proxies.forEach(p => { p.status = 'SIN_COMPROBAR'; }); assert.throws(() => manager.start());
  manager.proxies.forEach(p => { p.status = 'DISPONIBLE'; }); manager.start(); await manager.operation;
  assert.equal(attempts.length, 2); assert.equal(manager.mode, 'IDLE'); assert.notEqual(attempts[0][1], attempts[1][1]);
});
test('security challenge pauses the queue and blocks automated retries', async () => {
  const { manager, attempts } = await fixture([{ status: STATUS.MANUAL, reason: 'HTTP 429' }]);
  manager.start(); await manager.operation;
  assert.equal(manager.mode, 'PAUSED'); assert.equal(attempts.length, 1); assert.equal(manager.accounts[1].status, STATUS.PENDING); assert.equal(manager.accounts[0].securityLocked, true);
  assert.throws(() => manager.start([manager.accounts[0].id]));
  await assert.rejects(manager.changeProxy(manager.accounts[0].id));
});
test('connection errors never trigger automatic resubmission', async () => {
  const { manager, attempts } = await fixture([{ status: STATUS.TEMP, reason: 'timeout' }]);
  manager.start([manager.accounts[0].id]); await manager.operation; assert.equal(attempts.length, 1);
});
test('pause and resume retains the remaining manual retry queue', async () => {
  const { manager, attempts, browser } = await fixture([]);
  manager.accounts.forEach(a => { a.status = STATUS.TEMP; });
  browser.login = async a => { attempts.push(a.id); if (attempts.length === 1) manager.pause(); return { status: STATUS.VALID, reason: 'ok' }; };
  manager.start(manager.accounts.map(a => a.id)); await manager.operation;
  assert.equal(manager.mode, 'PAUSED'); assert.equal(attempts.length, 1);
  manager.resume(); await manager.operation; assert.equal(attempts.length, 2);
});
test('reimports preserve account/profile identity and security state', async () => {
  const { manager } = await fixture([]); const first = manager.accounts[0]; first.status = STATUS.MANUAL; first.securityLocked = true;
  await manager.importAccounts('c@d.com|new|b.test\na@b.com|changed|a.test');
  assert.equal(first.id, 'account_001'); assert.equal(first.password, 'changed'); assert.equal(first.status, STATUS.MANUAL); assert.equal(first.securityLocked, true); assert.equal(manager.accounts.length, 2);
});
test('manual sessions retain the original proxy, even after availability changes', async () => {
  const { manager, opened } = await fixture([]); await assert.rejects(manager.openSession('account_001'));
  manager.accounts[0].proxyId = manager.proxies[0].id; manager.accounts[0].securityLocked = true; manager.proxies[0].status = 'NO_FUNCIONA';
  await manager.openSession('account_001'); assert.deepEqual(opened, [['account_001', manager.proxies[0].id]]);
});
test('only confirmed pre-submit connectivity failure allows one replacement', async () => {
  const { manager, attempts } = await fixture([{ status: STATUS.TEMP, reason: 'proxy', proxyFailure: true, beforeSubmit: true }, { status: STATUS.VALID, reason: 'ok' }]);
  manager.start(['account_001']); await manager.operation; assert.equal(attempts.length, 2); assert.notEqual(attempts[0][1], attempts[1][1]);
});
test('a reachable proxy with a failed IP-provider response is not replaced', async () => {
  const { manager, attempts, browser } = await fixture([{ status: STATUS.TEMP, reason: 'proxy', proxyFailure: true, beforeSubmit: true }]);
  browser.probe = async () => ({ status: 'NO_FUNCIONA', connectivityFailed: false });
  manager.start(['account_001']); await manager.operation; assert.equal(attempts.length, 1); await assert.rejects(manager.changeProxy('account_001'));
});
test('conflicting passwords are held for correction; clean reimport preserves profile and restores pending status', async () => {
  const { manager, attempts } = await fixture([]);
  await manager.importAccounts('https://www.tiendanube.com/login:conflict@example.test:first\nhttps://www.tiendanube.com/login:conflict@example.test:second');
  const a = manager.accounts.find(a => a.email === 'conflict@example.test');
  assert.equal(a.status, STATUS.DATA); assert.throws(() => manager.start([a.id])); assert.equal(attempts.length, 0);
  const id = a.id; await manager.importAccounts('https://www.tiendanube.com/login:conflict@example.test:corrected');
  assert.equal(a.id, id); assert.equal(a.status, STATUS.PENDING); assert.equal(a.credentialConflict, false);
});
test('general login imports learn their store only from an authenticated observation', async () => {
  const { manager } = await fixture([]);
  await manager.importAccounts('https://www.tiendanube.com/login:generic@example.test:secret');
  const a = manager.accounts.find(a => a.email === 'generic@example.test'); const key = a.key;
  assert.equal(a.store_url, '');
  await manager.result(a, { status: STATUS.VALID, reason: 'ok', store_url: 'store.mitiendanube.com' });
  assert.equal(a.store_url, 'store.mitiendanube.com');
  await manager.importAccounts('https://www.tiendanube.com/login:generic@example.test:secret');
  assert.equal(manager.accounts.filter(a => a.key === key).length, 1); assert.equal(a.store_url, 'store.mitiendanube.com');
});
