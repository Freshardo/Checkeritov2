'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { RESULT_DIRS, STATUS, publicAccount, proxyLabel, csvRow, UserError } = require('./model');
const HEADER = ['timestamp', 'account_id', 'email', 'store_url', 'proxy', 'ip', 'status', 'reason'];
const row = a => [a.timestamp, a.id, a.email, a.store_url, a.proxy, a.ip, a.status, a.reason];
class Storage {
  constructor(root, encryption) { this.root = root; this.encryption = encryption; this.chain = Promise.resolve(); }
  async init() {
    for (const dir of ['profiles', 'logs', ...Object.values(RESULT_DIRS).map(d => `resultados/${d}`), 'resultados/proxies_no_funcionan']) await fs.mkdir(path.join(this.root, dir), { recursive: true });
    const logPath = path.join(this.root, 'logs/activity.csv');
    try {
      const oldLog = await fs.readFile(logPath, 'utf8');
      if (oldLog.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] !== csvRow(HEADER).trimEnd()) await fs.rename(logPath, path.join(this.root, `logs/activity-legacy-${Date.now()}.csv`));
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    try { await fs.writeFile(path.join(this.root, 'logs/activity.csv'), '\uFEFF' + csvRow(HEADER), { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  async load() {
    let bytes;
    try { bytes = await fs.readFile(path.join(this.root, 'state.bin')); } catch (e) { if (e.code === 'ENOENT') return { accounts: [], proxies: [] }; throw e; }
    try {
      const data = JSON.parse(this.encryption.decryptString(bytes));
      if (![1, 2, 3].includes(data.version) || !Array.isArray(data.accounts)) throw new Error();
      if (data.version === 2) data.proxies = [];
      if (!Array.isArray(data.proxies)) throw new Error();
      for (const a of data.accounts) {
        if (!/^account_\d+$/.test(a.id)) throw new Error();
        if (a.status === STATUS.RUNNING) { a.status = a.securityLocked ? STATUS.MANUAL : STATUS.TEMP; a.reason = 'Procesamiento interrumpido. Revisá la sesión antes de reintentar.'; }
      }
      for (const p of data.proxies) { p.status = 'SIN_COMPROBAR'; p.ip = ''; p.latency = null; }
      return data;
    } catch { throw new UserError('No se pudo descifrar el estado local. Abrí la aplicación con el mismo usuario de Windows. No se sobrescribieron tus datos.'); }
  }
  save(state, activity) {
    const data = JSON.stringify({ version: 3, accounts: state.accounts, proxies: state.proxies });
    const accounts = state.accounts.map(a => publicAccount(a, state.proxies));
    const failed = state.proxies.filter(p => p.status === 'NO_FUNCIONA').map(proxyLabel);
    const log = activity ? row(publicAccount(activity, state.proxies)) : null;
    const operation = async () => {
      if (!this.encryption.isEncryptionAvailable()) throw new UserError('El cifrado de Windows no está disponible. No se guardaron credenciales.');
      await this.atomic(path.join(this.root, 'state.bin'), this.encryption.encryptString(data));
      for (const [status, dir] of Object.entries(RESULT_DIRS)) await this.atomic(path.join(this.root, `resultados/${dir}/accounts.txt`), '\uFEFF' + csvRow(HEADER) + accounts.filter(a => a.status === status).map(a => csvRow(row(a))).join(''));
      await this.atomic(path.join(this.root, 'resultados/proxies_no_funcionan/proxies.txt'), failed.join('\r\n') + (failed.length ? '\r\n' : ''));
      if (log) await fs.appendFile(path.join(this.root, 'logs/activity.csv'), csvRow(log));
    };
    const pending = this.chain.then(operation);
    this.chain = pending.catch(() => {});
    return pending;
  }
  async atomic(target, content) { await fs.writeFile(target + '.tmp', content); await fs.rename(target + '.tmp', target); }
  saveImportReport(report) {
    const content = JSON.stringify({ timestamp: new Date().toISOString(), ...report }, null, 2);
    const pending = this.chain.then(() => this.atomic(path.join(this.root, 'logs/import-last.json'), content));
    this.chain = pending.catch(() => {});
    return pending;
  }
  async exportTo(target) {
    await this.chain;
    await fs.cp(path.join(this.root, 'resultados'), path.join(target, 'resultados'), { recursive: true });
    await fs.copyFile(path.join(this.root, 'logs/activity.csv'), path.join(target, 'activity.csv'));
    try { await fs.copyFile(path.join(this.root, 'logs/import-last.json'), path.join(target, 'import-report.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  profile(id) { if (!/^account_\d+$/.test(id)) throw new UserError('Perfil inválido.'); return path.join(this.root, 'profiles', id); }
}
module.exports = { Storage, HEADER };
