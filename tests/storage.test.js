'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Storage } = require('../src/core/storage');
const { parseAccounts, parseProxies } = require('../src/core/model');
test('exports and audit logs contain no secrets; records move between categories; encrypted recovery preserves identity', async () => {
  const root = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'tm-storage-'));
  const key = crypto.randomBytes(32);
  const encryption = { isEncryptionAvailable: () => true, encryptString: s => { const iv = crypto.randomBytes(16); const cipher = crypto.createCipheriv('aes-256-cbc', key, iv); return Buffer.concat([iv, cipher.update(s), cipher.final()]); }, decryptString: b => { const d = crypto.createDecipheriv('aes-256-cbc', key, b.subarray(0, 16)); return Buffer.concat([d.update(b.subarray(16)), d.final()]).toString(); } };
  try {
    const storage = new Storage(root, encryption); await storage.init();
    const proxy = parseProxies('http://proxy-user:proxy-secret@localhost:8080')[0]; proxy.status = 'NO_FUNCIONA';
    const account = { ...parseAccounts('person@example.com|account-secret|store.test')[0], id: 'account_001', status: 'REQUIERE_VALIDACION', securityLocked: true, reason: 'Validación manual', timestamp: new Date().toISOString() };
    account.proxyId = proxy.id;
    const state = { accounts: [account], proxies: [proxy] }; await storage.save(state, account);
    account.status = 'VALIDA'; await storage.save(state, account);
    const restored = await storage.load(); assert.equal(restored.accounts[0].password, 'account-secret'); assert.equal(restored.accounts[0].securityLocked, true);
    assert.equal(restored.proxies[0].status, 'SIN_COMPROBAR');
    assert.ok(!(await fs.readFile(path.join(root, 'resultados/pendientes_validacion/accounts.txt'), 'utf8')).includes('person@example.com'));
    for (const file of ['state.bin', 'logs/activity.csv', 'resultados/validas/accounts.txt', 'resultados/proxies_no_funcionan/proxies.txt']) {
      const data = await fs.readFile(path.join(root, file), 'utf8');
      for (const secret of ['account-secret', 'proxy-user', 'proxy-secret']) assert.ok(!data.includes(secret), file);
    }
    assert.throws(() => storage.profile('../escape'));
    await fs.writeFile(path.join(root, 'state.bin'), encryption.encryptString(JSON.stringify({ version: 2, accounts: [account] })));
    const migrated = await storage.load(); assert.equal(migrated.accounts[0].id, account.id); assert.equal(migrated.accounts[0].securityLocked, true); assert.deepEqual(migrated.proxies, []);
    await fs.writeFile(path.join(root, 'logs/activity.csv'), 'timestamp,account_id,email,store_url,status,reason\r\nlegacy-record\r\n');
    await storage.init();
    const legacy = (await fs.readdir(path.join(root, 'logs'))).find(name => name.startsWith('activity-legacy-'));
    assert.ok((await fs.readFile(path.join(root, 'logs', legacy), 'utf8')).includes('legacy-record'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
