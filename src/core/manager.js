'use strict';
const { EventEmitter } = require('node:events');
const { STATUS, UserError, parseAccountImport, parseProxies, publicAccount, publicProxy } = require('./model');
class Manager extends EventEmitter {
  constructor(storage, browser) {
    super(); this.storage = storage; this.browser = browser; this.accounts = []; this.proxies = []; this.mode = 'IDLE'; this.message = 'Importá tus cuentas y proxies para comenzar.'; this.currentId = null; this.cursor = 0; this.operation = null; this.abort = null; this.remaining = [];
  }
  async init() { const state = await this.storage.load(); this.accounts = state.accounts; this.proxies = state.proxies; await this.save(); }
  snapshot() {
    return { accounts: this.accounts.map(a => publicAccount(a, this.proxies)), proxies: this.proxies.map(publicProxy), mode: this.mode, message: this.message, currentId: this.currentId, canResume: this.remaining.length > 0 || this.accounts.some(a => a.status === STATUS.PENDING), dataPath: this.storage.root };
  }
  changed(message) { if (message) this.message = message; this.emit('state', this.snapshot()); }
  async save(activity) { await this.storage.save(this, activity); this.changed(); }
  editable() { if (this.operation || ['RUNNING', 'CHECKING', 'STOPPING', 'PAUSING'].includes(this.mode)) throw new UserError('Pausá o detené el procesamiento antes de cambiar los archivos.'); }
  account(id) { const a = this.accounts.find(a => a.id === id); if (!a) throw new UserError('Cuenta no encontrada.'); return a; }
  async importAccounts(text) {
    this.editable(); const { accounts: parsed, report } = parseAccountImport(text); let added = 0;
    let sequence = Math.max(0, ...this.accounts.map(a => +a.id.split('_')[1]));
    for (const entry of parsed) {
      const existing = this.accounts.find(a => a.key === entry.key);
      if (existing) {
        existing.password = entry.password; existing.sourceLine = entry.sourceLine; existing.sourceFormat = entry.sourceFormat; existing.credentialConflict = entry.credentialConflict;
        if (!existing.securityLocked && existing.status === STATUS.DATA && !entry.credentialConflict) { existing.status = STATUS.PENDING; existing.reason = ''; }
        if (entry.credentialConflict && !existing.securityLocked) { existing.status = STATUS.DATA; existing.reason = 'El archivo contiene contraseñas distintas para esta cuenta. Corregí los duplicados y reimportá.'; }
      }
      else { this.accounts.push({ ...entry, id: `account_${String(++sequence).padStart(3, '0')}`, status: entry.credentialConflict ? STATUS.DATA : STATUS.PENDING, reason: entry.credentialConflict ? 'El archivo contiene contraseñas distintas para esta cuenta. Corregí los duplicados y reimportá.' : '', proxyId: null, ip: '', timestamp: '', securityLocked: false }); added++; }
    }
    await this.save(); await this.storage.saveImportReport?.(report); this.changed(`${added} cuentas nuevas · ${report.duplicates} duplicados · ${report.invalidRecords} filas inválidas · ${report.conflicts} cuentas con contraseñas en conflicto.`);
    return { ...report, added };
  }
  async importProxies(text) {
    this.editable(); let added = 0;
    for (const p of parseProxies(text)) if (!this.proxies.some(old => old.id === p.id)) { this.proxies.push(p); added++; }
    await this.save(); this.changed(`${added} proxies nuevas. Comprobá su conectividad antes de iniciar.`);
  }
  startOperation(fn) {
    this.abort = new AbortController();
    this.operation = fn(this.abort.signal).catch(() => { this.mode = 'PAUSED'; this.changed('Se produjo un error interno o al guardar datos. El procesamiento quedó pausado.'); }).finally(() => { this.operation = null; this.currentId = null; if (this.mode === 'STOPPING') this.mode = 'IDLE'; this.changed(); });
  }
  checkProxies() {
    this.editable(); if (!this.proxies.length) throw new UserError('Importá proxies primero.');
    this.mode = 'CHECKING';
    this.startOperation(async signal => {
      for (let i = 0; i < this.proxies.length; i++) {
        if (signal.aborted) break;
        const p = this.proxies[i]; this.changed(`Comprobando proxy ${i + 1} de ${this.proxies.length}…`);
        Object.assign(p, await this.browser.probe(p, signal)); await this.save();
      }
      this.mode = 'IDLE'; this.changed(signal.aborted ? 'Comprobación detenida.' : 'Comprobación de proxies terminada.');
    });
  }
  chooseProxy(account, excluded = []) {
    if (account.proxyId && !excluded.includes(account.proxyId)) {
      const pinned = this.proxies.find(p => p.id === account.proxyId);
      if (pinned?.status === 'DISPONIBLE') return pinned;
      return null; // Changing an existing assignment always requires a proved connectivity failure.
    }
    const available = this.proxies.filter(p => p.status === 'DISPONIBLE' && !excluded.includes(p.id));
    if (!available.length || account.securityLocked) return null;
    return available[this.cursor++ % available.length];
  }
  async result(account, result) {
    if (!account.store_url && result.status === STATUS.VALID && result.store_url) account.store_url = result.store_url;
    account.status = result.status; account.reason = result.reason; account.timestamp = new Date().toISOString();
    if (result.status === STATUS.MANUAL) account.securityLocked = true;
    await this.save(account);
  }
  start(ids) {
    this.editable();
    const selected = ids ? ids.map(id => this.account(id)) : this.accounts.filter(a => a.status === STATUS.PENDING);
    if (!selected.length) throw new UserError('No hay cuentas pendientes para procesar.');
    if (selected.some(a => a.securityLocked || ![STATUS.PENDING, STATUS.TEMP, STATUS.INVALID].includes(a.status))) throw new UserError('Las cuentas validadas o con controles de seguridad se gestionan con Abrir sesión.');
    if (!this.proxies.some(p => p.status === 'DISPONIBLE')) throw new UserError('Comprobá las proxies: necesitás al menos una disponible.');
    this.mode = 'RUNNING'; this.remaining = selected.map(a => a.id);
    this.startOperation(async signal => {
      for (let i = 0; i < selected.length; i++) {
        if (signal.aborted || this.mode !== 'RUNNING') break;
        this.remaining.shift();
        const account = selected[i]; this.currentId = account.id;
        let proxy = this.chooseProxy(account);
        if (!proxy) { await this.result(account, { status: STATUS.TEMP, reason: 'La proxy asignada no está disponible. Comprobala o usá Cambiar proxy si falló por conectividad.' }); continue; }
        account.proxyId = proxy.id; account.ip = proxy.ip; account.status = STATUS.RUNNING;
        account.reason = 'Iniciando sesión…'; await this.save();
        const progress = stage => this.changed(`Procesando cuenta ${i + 1} de ${selected.length} · ${stage}`);
        let result = await this.browser.login(account, proxy, signal, progress);
        // One failover, only before submission, only after a separate connectivity
        // test fails. Never retry a submitted password or a security challenge.
        if (result.proxyFailure && result.beforeSubmit && !account.securityLocked && !signal.aborted && this.mode === 'RUNNING') {
          const check = await this.browser.probe(proxy, signal); Object.assign(proxy, check);
          if (check.status === 'NO_FUNCIONA' && check.connectivityFailed && !signal.aborted) {
            const replacement = this.chooseProxy(account, [proxy.id]);
            if (replacement) {
              await this.browser.close(account.id); proxy = replacement; account.proxyId = proxy.id; account.ip = proxy.ip; await this.save();
              result = await this.browser.login(account, proxy, signal, progress);
            }
          }
        }
        await this.result(account, result);
        if (result.status === STATUS.MANUAL) { this.mode = 'PAUSED'; this.changed('Cuenta pausada: requiere intervención. Abrí su sesión para continuar manualmente.'); break; }
        await this.browser.close(account.id);
      }
      if (this.mode === 'PAUSING') { this.mode = 'PAUSED'; this.changed('Procesamiento pausado.'); }
      else if (this.mode === 'RUNNING' || this.mode === 'STOPPING') { this.mode = 'IDLE'; this.changed(signal.aborted ? 'Procesamiento detenido.' : 'Procesamiento terminado.'); }
    });
    this.changed();
  }
  pause() { if (this.mode === 'RUNNING') { this.mode = 'PAUSING'; this.changed('Pausa solicitada. Finalizando la cuenta actual…'); } }
  resume() {
    const remaining = this.remaining.filter(id => { const a = this.account(id); return !a.securityLocked && [STATUS.PENDING, STATUS.TEMP, STATUS.INVALID].includes(a.status); });
    return this.start(remaining.length ? remaining : undefined);
  }
  async stop() { if (this.operation) { this.mode = 'STOPPING'; this.abort.abort(); this.changed('Deteniendo…'); await this.operation; } else { this.mode = 'IDLE'; this.changed('Procesamiento detenido.'); } }
  async changeProxy(id) {
    this.editable(); const a = this.account(id);
    if (a.securityLocked || a.status !== STATUS.TEMP) throw new UserError('Solo se puede cambiar la proxy de un error temporal sin controles de seguridad.');
    const previous = this.proxies.find(p => p.id === a.proxyId);
    if (!previous || previous.status !== 'NO_FUNCIONA' || !previous.connectivityFailed) throw new UserError('El cambio requiere un fallo de conectividad comprobado hacia la proxy original. Comprobá las proxies primero.');
    const next = this.chooseProxy(a, [previous.id]); if (!next) throw new UserError('No hay otra proxy disponible.');
    await this.browser.close(a.id); a.proxyId = next.id; a.ip = next.ip; a.reason = 'Proxy reasignada tras fallo de conectividad comprobado. Podés reintentar manualmente.'; await this.save(a);
  }
  async openSession(id) {
    this.editable(); const a = this.account(id); const p = this.proxies.find(p => p.id === a.proxyId);
    if (!p?.type) throw new UserError('Esta cuenta todavía no tiene una proxy comprobada asignada.');
    await this.browser.openManual(a, p); this.changed('Sesión abierta con su perfil y proxy originales.');
  }
  async checkSession(id) {
    this.editable(); const a = this.account(id); const result = await this.browser.checkManual(a); await this.result(a, result);
    this.changed(result.status === STATUS.VALID ? 'Validación completada. Sesión autenticada conservada.' : result.reason);
  }
  async shutdown() { await this.stop(); await this.browser.closeAll(); await this.save(); }
}
module.exports = { Manager };
