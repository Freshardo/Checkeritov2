'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } = require('electron');
const smokeRoot = process.env.TM_SMOKE_DATA;
if (smokeRoot) app.setPath('userData', path.resolve(smokeRoot));
process.env.PLAYWRIGHT_BROWSERS_PATH = app.isPackaged ? path.join(process.resourcesPath, 'browsers') : path.resolve(__dirname, '../browsers');
const { chromium } = require('playwright');
const { Storage } = require('./core/storage');
const { BrowserService } = require('./core/browser');
const { Manager } = require('./core/manager');
const { UserError } = require('./core/model');
let window, manager, closing = false;
const uiPath = path.join(__dirname, 'ui/index.html');
const uiUrl = pathToFileURL(uiPath).href;

async function readInput(kind) {
  const { canceled, filePaths } = await dialog.showOpenDialog(window, { title: kind === 'accounts' ? 'Importar cuentas' : 'Importar proxies', properties: ['openFile'], filters: [{ name: kind === 'accounts' ? 'Cuentas TXT' : 'Proxies TXT o CSV', extensions: kind === 'accounts' ? ['txt'] : ['txt', 'csv'] }] });
  if (canceled) return null;
  const stat = await fs.stat(filePaths[0]);
  if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new UserError('Seleccioná un archivo de texto de hasta 10 MB.');
  return fs.readFile(filePaths[0], 'utf8');
}
function registerHandlers() {
  let actionActive = false;
  const handlers = {
    snapshot: () => manager.snapshot(),
    'import-accounts': async () => { manager.editable(); const text = await readInput('accounts'); if (text !== null) return manager.importAccounts(text); },
    'import-proxies': async () => { manager.editable(); const text = await readInput('proxies'); if (text !== null) await manager.importProxies(text); },
    'check-proxies': () => manager.checkProxies(), start: () => manager.start(), pause: () => manager.pause(), stop: () => manager.stop(), resume: () => manager.resume(),
    retry: ids => { if (!Array.isArray(ids) || ids.length > 10000 || ids.some(id => typeof id !== 'string')) throw new UserError('Selección inválida.'); manager.start([...new Set(ids)]); },
    'open-session': id => manager.openSession(id), 'check-session': id => manager.checkSession(id), 'change-proxy': id => manager.changeProxy(id),
    'open-folder': () => shell.openPath(manager.storage.root),
    export: async () => {
      const selection = await dialog.showOpenDialog(window, { title: 'Elegí dónde exportar los resultados', properties: ['openDirectory', 'createDirectory'] });
      if (selection.canceled) return;
      const target = path.join(selection.filePaths[0], `Tiendanube-resultados-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      await fs.mkdir(target, { recursive: true }); await manager.storage.exportTo(target); return target;
    }
  };
  for (const [command, handler] of Object.entries(handlers)) ipcMain.handle(`manager:${command}`, async (event, arg) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== uiUrl) return { ok: false, error: 'Origen no autorizado.' };
    const exclusive = !['snapshot', 'pause', 'stop', 'open-folder', 'export'].includes(command);
    if (exclusive && actionActive) return { ok: false, error: 'Esperá a que termine la operación anterior.' };
    if (exclusive) actionActive = true;
    try { return { ok: true, value: await handler(arg) }; }
    catch (error) { return { ok: false, error: error instanceof UserError ? error.message : 'No se pudo completar la operación. Revisá el navegador, los archivos y los permisos de la carpeta de datos.' }; }
    finally { if (exclusive) actionActive = false; }
  });
}

async function init() {
  if (!safeStorage.isEncryptionAvailable()) throw new UserError('El cifrado de Windows no está disponible.');
  const root = smokeRoot ? path.join(app.getPath('userData'), 'TiendanubeManager') : path.join(app.getPath('appData'), 'TiendanubeManager');
  const storage = new Storage(root, safeStorage); await storage.init();
  const browser = new BrowserService({ executablePath: chromium.executablePath(), profilePath: id => storage.profile(id) });
  manager = new Manager(storage, browser); await manager.init();
  window = new BrowserWindow({ width: 1440, height: 940, minWidth: 1080, minHeight: 720, backgroundColor: '#f5f7fb', title: 'Tiendanube Account Manager', icon: path.join(__dirname, 'ui/icon.png'), show: false, autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  registerHandlers(); manager.on('state', state => { if (!window.isDestroyed()) window.webContents.send('manager:state', state); });
  window.once('ready-to-show', () => window.show());
  window.on('close', event => { if (!closing) { event.preventDefault(); closing = true; manager.shutdown().finally(() => app.quit()); } });
  await window.loadFile(uiPath);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(init).catch(error => { dialog.showErrorBox('No se pudo iniciar Tiendanube Manager', error instanceof UserError ? error.message : 'No se pudo acceder a los datos locales o al navegador. Revisá los permisos de la instalación.'); app.quit(); });
  app.on('window-all-closed', () => app.quit());
}
