const { contextBridge, ipcRenderer } = require('electron');
const { version } = require('../package.json');

contextBridge.exposeInMainWorld('kayleyBridge', {
  appVersion: version,
  saveDb: (bytes) => ipcRenderer.invoke('db:save', bytes),
  loadDb: () => ipcRenderer.invoke('db:load'),
  saveAttachment: (fileName, bytes) => ipcRenderer.invoke('attachment:save', fileName, bytes),
  deleteAttachment: (fileId) => ipcRenderer.invoke('attachment:delete', fileId),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
});
