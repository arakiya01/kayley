// ブラウザ内永続化: OPFS があれば OPFS、なければ IndexedDB にフォールバック。
// sqlite ファイルの生バイト列(Uint8Array)をまるごと保存/読込する。

// 既存ユーザーの実データが紐づいているキーのため、アプリ名を変更しても意図的に変えない
// （変えると、アプリからは前のデータが見えなくなってしまう）。
const DB_FILENAME = 'geppyo.sqlite';
const IDB_NAME = 'geppyo-store';
const IDB_STORE = 'files';

function supportsOPFS() {
  return typeof navigator !== 'undefined'
    && navigator.storage
    && typeof navigator.storage.getDirectory === 'function';
}

function hasElectronBridge() {
  return typeof window !== 'undefined' && !!window.kayleyBridge;
}

async function opfsSave(bytes) {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(DB_FILENAME, { create: true });
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

async function opfsLoad() {
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(DB_FILENAME, { create: false });
    const file = await handle.getFile();
    const buf = await file.arrayBuffer();
    return new Uint8Array(buf);
  } catch (e) {
    return null;
  }
}

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSave(bytes) {
  const db = await idbOpen();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(bytes, DB_FILENAME);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function idbLoad() {
  const db = await idbOpen();
  const result = await new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(DB_FILENAME);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

export const Storage = {
  backend: hasElectronBridge() ? 'electron' : (supportsOPFS() ? 'opfs' : 'indexeddb'),

  async save(bytes) {
    if (this.backend === 'electron') {
      await window.kayleyBridge.saveDb(bytes);
    } else if (this.backend === 'opfs') {
      await opfsSave(bytes);
    } else {
      await idbSave(bytes);
    }
  },

  async load() {
    if (this.backend === 'electron') {
      return await window.kayleyBridge.loadDb();
    }
    if (this.backend === 'opfs') {
      return await opfsLoad();
    }
    return await idbLoad();
  },

  downloadBackup(bytes) {
    const blob = new Blob([bytes], { type: 'application/x-sqlite3' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `kayley-backup-${stamp}.sqlite`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },

  async readFile(file) {
    const buf = await file.arrayBuffer();
    return new Uint8Array(buf);
  },
};
