const { contextBridge, ipcRenderer } = require('electron');

// サンドボックス化されたpreloadではrequire()できるのはelectron等の組み込みに限られ、
// ../package.json のような任意のローカルファイルはrequireできない（例外で落ちて、
// この後のcontextBridge.exposeInMainWorldごと実行されなくなり、window.kayleyBridgeが
// 一切公開されない＝保存がOPFSへ静かにフォールバックする不具合の原因だった）。
// バージョンはメインプロセスから同期IPCで取得する。
const appVersion = ipcRenderer.sendSync('app:version-sync');

contextBridge.exposeInMainWorld('kayleyBridge', {
  appVersion,
  saveDb: (bytes) => ipcRenderer.invoke('db:save', bytes),
  loadDb: () => ipcRenderer.invoke('db:load'),
  saveAttachment: (fileName, bytes) => ipcRenderer.invoke('attachment:save', fileName, bytes),
  deleteAttachment: (fileId) => ipcRenderer.invoke('attachment:delete', fileId),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  applyUpdate: (assetUrl) => ipcRenderer.invoke('update:apply', assetUrl),
});
