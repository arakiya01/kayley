const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kayleyBridge', {
  saveDb: (bytes) => ipcRenderer.invoke('db:save', bytes),
  loadDb: () => ipcRenderer.invoke('db:load'),
  saveAttachment: (fileName, bytes) => ipcRenderer.invoke('attachment:save', fileName, bytes),
  deleteAttachment: (fileId) => ipcRenderer.invoke('attachment:delete', fileId),
});
