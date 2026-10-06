'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const commands = new Set(['snapshot', 'import-accounts', 'import-proxies', 'check-proxies', 'start', 'pause', 'stop', 'resume', 'retry', 'open-session', 'check-session', 'change-proxy', 'open-folder', 'export']);
contextBridge.exposeInMainWorld('manager', {
  invoke: (command, arg) => { if (!commands.has(command)) return Promise.reject(new Error('Comando inválido.')); return ipcRenderer.invoke(`manager:${command}`, arg); },
  subscribe: callback => { const listener = (_event, state) => callback(state); ipcRenderer.on('manager:state', listener); return () => ipcRenderer.removeListener('manager:state', listener); }
});
