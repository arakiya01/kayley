# ローカルファイル永続化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Google Drive連携を丸ごと廃止し、SQLiteデータベースと添付ファイル（領収書・請求書）の両方を、Electronアプリのユーザーデータフォルダ内の実ファイルに保存するように変更する。

**Architecture:** アプリ本体（js/db.js の80以上の関数、全ビュー）は今まで通りsql.jsでインメモリのSQLiteを操作する同期API。実際にストレージI/Oが発生するのは `js/storage.js` の `Storage.save()/load()`（DB全体のバイト列の書き込み/読み込み）だけなので、ここにElectronのpreload経由のIPCバックエンドを追加し、OPFS/IndexedDBは「Electron外（ブラウザ単体での開発・検証時）のフォールバック」として残す。添付ファイルは、今までGoogle Drive APIを呼んでいた箇所を、同じ形のローカル保存モジュール（`js/localfiles.js`）に差し替える。ファイルの実体はElectronのメインプロセスがNodeの`fs`で保存し、プレビュー表示は既存のローカルHTTPサーバー（`electron/server.js`）に新しいルートを追加して配信する。

**Tech Stack:** Electron 32（既存）、Node.jsの`fs/promises`、`contextBridge`/`ipcMain`/`ipcRenderer`（Electron標準IPC）。新しいnpm依存は追加しない。

**Spec:** このファイル自体が設計を兼ねる（別途spec文書は無い。ユーザーとのすり合わせ内容は下記Global Constraintsに集約）。

## Global Constraints

- Google Drive連携は丸ごと廃止する（OAuth設定・接続UI・自動バックアップ機能すべて削除）。非エンジニアが設定不要で使えることを最優先する。
- 添付ファイルのプレビューは「ブラウザ内で表示」を維持する（OSの既定アプリで開く方式にはしない）。既存の「blobを取得してimg/PDF.jsのcanvasで描画する」プレビュー処理（`js/pdfpreview.js`の`renderPdfInto`、report.jsの`loadPreviews()`）はそのまま使う。
- 移行は自動化しない。実装完了後、既存の「バックアップをダウンロード」「バックアップから復元」機能（`js/views/settings.js`、変更不要）を使って手動で移行する（旧バージョンでダウンロード→新バージョンで復元）。この手順は最後にユーザーへ案内するだけでよく、コードは不要。
- `js/db.js`の同期API（80以上の関数）・全ビューファイルの`render()`関数は変更しない。ストレージI/Oの差し替えは`js/storage.js`の`Storage.save()/load()`インターフェース（シグネチャ不変）の内部実装だけで完結させる。
- Electronは`contextIsolation: true`, `nodeIntegration: false`（`electron/main.js`の既存設定、変更しない）。レンダラーからNode/Electron APIへは必ず`preload.js`の`contextBridge`経由でアクセスする。
- `electron-builder`の`asar: true`設定により、アプリ本体は読み取り専用パッケージになる。DB・添付ファイルは必ず`app.getPath('userData')`配下（asarの外、書き込み可能な実ディレクトリ）に保存する。
- 検証用スクリプト（`verify_*.mjs`等）はリポジトリにコミットしないこと。
- Electronの実IPCが絡む部分（preload・main.jsのIPCハンドラ）は、`python3 -m http.server`や`electron/server.js`単体起動によるPlaywright検証では実行できない（`window.kayleyBridge`が存在しないブラウザ単体の環境になるため）。この部分は「ブラウザ単体でのフォールバック動作」をPlaywrightで検証し、実Electron環境でのIPC自体の動作確認は別途行う（このプランでは各タスクの検証手順にその区別を明記する）。

---

### Task 1: Electron基盤 — preload・IPCハンドラ・添付ファイル配信ルートの追加

**Files:**
- Create: `electron/preload.js`
- Modify: `electron/main.js`
- Modify: `electron/server.js`

**Interfaces:**
- Produces: レンダラーから使える `window.kayleyBridge` オブジェクト（`saveDb(bytes): Promise<void>`, `loadDb(): Promise<Uint8Array|null>`, `saveAttachment(fileName, bytes): Promise<string>`（保存後のファイルID文字列を返す）, `deleteAttachment(fileId): Promise<void>`）。Task 2・Task 3がこれを消費する。
- Produces: ローカルHTTPサーバーの新しいルート `GET /attachments/:fileId`（添付ファイルの実体を配信）。Task 3の`js/localfiles.js`がこのURLパスを組み立てて使う。

現状の `electron/main.js`（71〜76行目、`webPreferences`）:
```js
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      devTools: true,
    },
```

現状の `electron/server.js`（1〜52行目、全体）:
```js
const http = require('http');
const fs = require('fs');
const path = require('path');

// Kayleyはブラウザ完結型アプリ（ESモジュール＋WASM）で、fetch()がfile://を扱えないため
// file://で直接開くとsql.jsのWASM読み込み等が失敗する。そのためElectron内で
// 127.0.0.1宛のごく単純な静的ファイルサーバーを立て、http://経由で読み込む。
// 外部からの接続は受け付けない（127.0.0.1固定・ポートは起動毎にOSへ割り当てさせる）。

const APP_ROOT = path.join(__dirname, '..');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pf': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let reqPath = decodeURIComponent(req.url.split('?')[0]);
      if (reqPath === '/') reqPath = '/index.html';
      const filePath = path.normalize(path.join(APP_ROOT, reqPath));
      // ディレクトリ脱出防止
      if (!filePath.startsWith(APP_ROOT)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { startServer, APP_ROOT };
```

現状の `electron/main.js`（60〜90行目、`createWindow`）:
```js
async function createWindow() {
  const server = await startServer();
  const { port } = server.address();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#FBF8F1',
    title: 'Kayley',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      devTools: true,
    },
  });

  // 印刷（PDF出力）ダイアログ用に、外部リンクは既定のブラウザで開く
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/index.html`);

  mainWindow.on('closed', () => {
    mainWindow = null;
    server.close();
  });
}
```

- [ ] **Step 1: `electron/server.js` に添付ファイル配信ルートを追加し、`startServer` に保存先ディレクトリを渡せるようにする**

`electron/server.js` を以下のように書き換える（既存の静的配信ロジックはそのまま、`attachmentsDir`引数の追加とルート分岐、MIME_TYPESへのPDF/画像形式追加が差分）:

```js
const http = require('http');
const fs = require('fs');
const path = require('path');

// Kayleyはブラウザ完結型アプリ（ESモジュール＋WASM）で、fetch()がfile://を扱えないため
// file://で直接開くとsql.jsのWASM読み込み等が失敗する。そのためElectron内で
// 127.0.0.1宛のごく単純な静的ファイルサーバーを立て、http://経由で読み込む。
// 外部からの接続は受け付けない（127.0.0.1固定・ポートは起動毎にOSへ割り当てさせる）。
//
// /attachments/:fileId は、アプリ本体（APP_ROOT、読み取り専用のasar内）とは別に、
// ユーザーデータフォルダ内に保存された添付ファイル（領収書・請求書の実体）を配信する。

const APP_ROOT = path.join(__dirname, '..');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pf': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function serveFile(filePath, rootDir, res) {
  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(rootDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(normalized, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(normalized).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function startServer(attachmentsDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqPath = decodeURIComponent(req.url.split('?')[0]);
      if (attachmentsDir && reqPath.startsWith('/attachments/')) {
        const fileId = reqPath.slice('/attachments/'.length);
        serveFile(path.join(attachmentsDir, fileId), path.normalize(attachmentsDir), res);
        return;
      }
      const normalizedPath = reqPath === '/' ? '/index.html' : reqPath;
      serveFile(path.join(APP_ROOT, normalizedPath), APP_ROOT, res);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { startServer, APP_ROOT };
```

- [ ] **Step 2: `electron/preload.js` を新規作成する**

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kayleyBridge', {
  saveDb: (bytes) => ipcRenderer.invoke('db:save', bytes),
  loadDb: () => ipcRenderer.invoke('db:load'),
  saveAttachment: (fileName, bytes) => ipcRenderer.invoke('attachment:save', fileName, bytes),
  deleteAttachment: (fileId) => ipcRenderer.invoke('attachment:delete', fileId),
});
```

- [ ] **Step 3: `electron/main.js` にIPCハンドラを追加し、preloadとattachmentsDirを配線する**

`electron/main.js` の先頭のrequire文を変更する:

```js
const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { startServer } = require('./server');
```

`createWindow` の直前（`buildMenu` 関数の後）に、保存先ディレクトリの定義とIPCハンドラ登録を追加する:

```js
const DATA_DIR = app.getPath('userData');
const DB_PATH = path.join(DATA_DIR, 'kayley.sqlite');
const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');

ipcMain.handle('db:save', async (event, bytes) => {
  await fs.writeFile(DB_PATH, Buffer.from(bytes));
});

ipcMain.handle('db:load', async () => {
  try {
    const buf = await fs.readFile(DB_PATH);
    return new Uint8Array(buf);
  } catch {
    return null;
  }
});

ipcMain.handle('attachment:save', async (event, fileName, bytes) => {
  await fs.mkdir(ATTACHMENTS_DIR, { recursive: true });
  const safeName = String(fileName).replace(/[/\\]/g, '_');
  const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
  await fs.writeFile(path.join(ATTACHMENTS_DIR, fileId), Buffer.from(bytes));
  return fileId;
});

ipcMain.handle('attachment:delete', async (event, fileId) => {
  try {
    await fs.unlink(path.join(ATTACHMENTS_DIR, String(fileId)));
  } catch {
    // 既に無い場合は成功扱い（削除したい状態と一致しているため）
  }
});
```

`createWindow` 内を以下のように変更する（`startServer()`への引数追加、`webPreferences.preload`の追加）:

```js
async function createWindow() {
  const server = await startServer(ATTACHMENTS_DIR);
  const { port } = server.address();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#FBF8F1',
    title: 'Kayley',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      devTools: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // 印刷（PDF出力）ダイアログ用に、外部リンクは既定のブラウザで開く
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/index.html`);

  mainWindow.on('closed', () => {
    mainWindow = null;
    server.close();
  });
}
```

- [ ] **Step 4: 構文チェック**

```bash
node --check electron/main.js
node --check electron/preload.js
node --check electron/server.js
```
Expected: 3つとも出力無し（構文エラー無し）。

- [ ] **Step 5: ローカルHTTPサーバー単体での動作確認（attachmentsDir配信ルートのみ、実Electronなしで検証可能な範囲）**

以下のスクリプトを一時的に作成して実行する（コミットしない）:

```js
// /tmp などスクラッチ領域に置く。リポジトリにはコミットしない。
const { startServer } = require('/home/lima.guest/projects/kayley/electron/server.js');
const fs = require('fs');
const path = require('path');
const os = require('os');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kayley-attach-'));
  fs.writeFileSync(path.join(dir, 'test-file.txt'), 'hello');
  const server = await startServer(dir);
  const { port } = server.address();

  const okRes = await fetch(`http://127.0.0.1:${port}/attachments/test-file.txt`);
  console.log('attachment 200:', okRes.status, await okRes.text());

  const escapeRes = await fetch(`http://127.0.0.1:${port}/attachments/../main.js`);
  console.log('traversal blocked (expect 403 or 404):', escapeRes.status);

  const appRes = await fetch(`http://127.0.0.1:${port}/index.html`);
  console.log('app root still works:', appRes.status);

  server.close();
})();
```

Run: `node /tmp/.../verify_server_attachments.mjs`（実際のパスに置き換え）
Expected: `attachment 200: 200 hello`、traversalは403か404、`app root still works: 200`。

- [ ] **Step 6: コミット**

```bash
git add electron/main.js electron/preload.js electron/server.js
git commit -m "Electron: 添付ファイル配信ルートとDB/添付ファイル用IPCハンドラを追加"
```

---

### Task 2: `js/storage.js` にElectronバックエンドを追加

**Files:**
- Modify: `js/storage.js`

**Interfaces:**
- Consumes: Task 1で追加された `window.kayleyBridge.saveDb(bytes)` / `window.kayleyBridge.loadDb()`。
- Produces: `Storage.save(bytes): Promise<void>` / `Storage.load(): Promise<Uint8Array|null>` / `Storage.backend: 'electron'|'opfs'|'indexeddb'`（シグネチャは変更なし、`js/db.js`側は無改修で動く）。

現状の `js/storage.js`（全体、70〜105行目の`Storage`定義部分以外は変更なし）:
```js
export const Storage = {
  backend: supportsOPFS() ? 'opfs' : 'indexeddb',

  async save(bytes) {
    if (this.backend === 'opfs') {
      await opfsSave(bytes);
    } else {
      await idbSave(bytes);
    }
  },

  async load() {
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
```

- [ ] **Step 1: `hasElectronBridge()` 判定を追加し、`Storage.backend`/`save`/`load`を書き換える**

`js/storage.js` の `supportsOPFS()` 関数の直後に追加:

```js
function hasElectronBridge() {
  return typeof window !== 'undefined' && !!window.kayleyBridge;
}
```

`export const Storage = { ... }` を以下のように書き換える（`downloadBackup`/`readFile`は無変更）:

```js
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
```

- [ ] **Step 2: 構文チェック**

```bash
node --check js/storage.js
```
Expected: 出力無し。

- [ ] **Step 3: Playwrightで2パターン検証（コミットしないスクリプト）**

パターンA（`window.kayleyBridge`が無い＝今まで通りのブラウザ単体環境。既存の`electron/server.js`の`startServer()`をNode側で`node -e`起動するか、`python3 -m http.server`で配信して検証）:

```js
import { chromium } from '/path/to/playwright-core/index.mjs';
const BASE = process.env.APP_URL;
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const backend = await page.evaluate(async () => {
  const { Storage } = await import('/js/storage.js');
  return Storage.backend;
});
console.log('backend without bridge (expect opfs or indexeddb):', backend);
await browser.close();
```

パターンB（`window.kayleyBridge`をPlaywrightの`page.addInitScript`でスタブし、`save`/`load`が正しくブリッジ経由で呼ばれることを確認）:

```js
import { chromium } from '/path/to/playwright-core/index.mjs';
const BASE = process.env.APP_URL;
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.addInitScript(() => {
  window.__savedBytes = null;
  window.kayleyBridge = {
    saveDb: async (bytes) => { window.__savedBytes = bytes; },
    loadDb: async () => window.__savedBytes,
  };
});
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const result = await page.evaluate(async () => {
  const { Storage } = await import('/js/storage.js');
  await Storage.save(new Uint8Array([1, 2, 3]));
  const loaded = await Storage.load();
  return { backend: Storage.backend, saved: Array.from(window.__savedBytes), loaded: Array.from(loaded) };
});
console.log(JSON.stringify(result));
await browser.close();
```

Run both scripts.
Expected: パターンA → `backend without bridge: opfs`（このアプリを動かす環境がOPFS対応ブラウザの場合）。パターンB → `{"backend":"electron","saved":[1,2,3],"loaded":[1,2,3]}`。

- [ ] **Step 4: コミット**

```bash
git add js/storage.js
git commit -m "storage: DB永続化にElectronのIPCバックエンドを追加（OPFS/IndexedDBはフォールバックとして維持）"
```

---

### Task 3: `js/localfiles.js` の新規作成（添付ファイルのローカル保存モジュール）

**Files:**
- Create: `js/localfiles.js`
- Modify: `js/db.js:89-100`（コメント追加のみ、スキーマ・関数は変更しない）

**Interfaces:**
- Consumes: Task 1の `window.kayleyBridge.saveAttachment(fileName, bytes)` / `deleteAttachment(fileId)`、Task 1の `GET /attachments/:fileId` ルート。
- Produces: `uploadFile(file, { namePrefix }): Promise<{ id: string, mimeType: string }>`、`deleteFile(fileId): Promise<void>`、`previewUrl(fileId): string`、`downloadFile(fileId): Promise<Blob>`、`isAvailable(): boolean`。Task 4・Task 5がこれらを消費し、`js/gdrive.js`の`uploadFile`/`deleteFile`/`downloadFile`/`isConnected`相当を置き換える。

現状の `js/db.js`（89〜100行目、`attachments`テーブル定義。列名・関数は変更しない）:
```sql
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  drive_file_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT,
  web_view_link TEXT,
  uploaded_at TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'receipt',
  client_id INTEGER REFERENCES clients(id)
);
```

- [ ] **Step 1: `js/db.js` にコメントを1行追加する**（列名は変更しない。移行不要にするため既存列をローカル保存キーとして転用する旨だけ明記する）

`CREATE TABLE IF NOT EXISTS attachments (` の直前に1行追加:

```sql
-- drive_file_id にはローカル保存後のファイルID、web_view_link にはローカルHTTPサーバーの
-- プレビューURL（/attachments/:fileId）を入れる（列名は移行を避けるため据え置き）。
CREATE TABLE IF NOT EXISTS attachments (
```

- [ ] **Step 2: `js/localfiles.js` を新規作成する**

```js
// 添付ファイル（領収書・請求書）のローカル保存。
// Electronのpreload（electron/preload.js）が公開する window.kayleyBridge 経由で、
// メインプロセスのファイルシステムに保存する。ブラウザ単体（Electron外）では使えない。
export function isAvailable() {
  return typeof window !== 'undefined' && !!window.kayleyBridge;
}

export async function uploadFile(file, { namePrefix = '' } = {}) {
  if (!isAvailable()) throw new Error('この機能はデスクトップアプリでのみ使えます。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const safeName = `${namePrefix ? `${namePrefix}_` : ''}${file.name}`;
  const id = await window.kayleyBridge.saveAttachment(safeName, bytes);
  return { id, mimeType: file.type || 'application/octet-stream' };
}

export async function deleteFile(fileId) {
  if (!isAvailable()) return;
  await window.kayleyBridge.deleteAttachment(fileId);
}

export function previewUrl(fileId) {
  return `/attachments/${encodeURIComponent(fileId)}`;
}

export async function downloadFile(fileId) {
  const res = await fetch(previewUrl(fileId));
  if (!res.ok) throw new Error('ファイルの読み込みに失敗しました');
  return await res.blob();
}
```

- [ ] **Step 3: 構文チェック**

```bash
node --check js/db.js
node --check js/localfiles.js
```
Expected: 出力無し。

- [ ] **Step 4: Playwrightで検証（`window.kayleyBridge`をスタブ、コミットしないスクリプト）**

```js
import { chromium } from '/path/to/playwright-core/index.mjs';
const BASE = process.env.APP_URL;
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.addInitScript(() => {
  window.__savedFiles = {};
  window.kayleyBridge = {
    saveAttachment: async (name, bytes) => {
      const id = `fake-${name}`;
      window.__savedFiles[id] = bytes;
      return id;
    },
    deleteAttachment: async (id) => { delete window.__savedFiles[id]; },
  };
});
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const result = await page.evaluate(async () => {
  const localfiles = await import('/js/localfiles.js');
  const file = new File([new Uint8Array([9, 9, 9])], 'test.pdf', { type: 'application/pdf' });
  const uploaded = await localfiles.uploadFile(file, { namePrefix: 'sample' });
  const urlBefore = localfiles.previewUrl(uploaded.id);
  await localfiles.deleteFile(uploaded.id);
  return {
    isAvailable: localfiles.isAvailable(),
    uploadedId: uploaded.id,
    mimeType: uploaded.mimeType,
    urlBefore,
    stillSavedAfterDelete: Object.prototype.hasOwnProperty.call(window.__savedFiles, uploaded.id),
  };
});
console.log(JSON.stringify(result, null, 1));
await browser.close();
```
Run: 上記スクリプトを実行。
Expected: `isAvailable: true`、`uploadedId`が`"fake-sample_test.pdf"`、`mimeType: "application/pdf"`、`urlBefore: "/attachments/fake-sample_test.pdf"`、`stillSavedAfterDelete: false`。

- [ ] **Step 5: コミット**

```bash
git add js/db.js js/localfiles.js
git commit -m "添付ファイルのローカル保存モジュール（js/localfiles.js）を追加"
```

---

### Task 4: `js/views/expenses.js` と `js/views/ar.js` をGoogle Driveからローカル保存に置き換える

**Files:**
- Modify: `js/views/expenses.js`
- Modify: `js/views/ar.js`

**Interfaces:**
- Consumes: Task 3の `js/localfiles.js`（`uploadFile`, `deleteFile`, `previewUrl`）。
- Produces: （無し。ビューの内部実装のみ）

現状（`js/views/expenses.js`）は `import * as gdrive from '../gdrive.js';`（14行目）を使い、`getMeta('gdrive_client_id')` で機能の出し分けをしている箇所が3箇所（`gdriveConfigured`＝25行目、`gdriveConfigured2`＝291行目、`handleStatementUpload`内の268行目）ある。ローカル保存は常に使えるので、この出し分け自体を削除し、常時アップロードUIを表示する。

- [ ] **Step 1: `js/views/expenses.js` のimportを変更する**

`getMeta`はこのファイルではGoogle Drive関連の判定にしか使われていない（Step 2〜4ですべて削除する）ので、importからも外す:

```js
import {
  listAttachments, addAttachment, removeAttachment,
  listPaymentSources, upsertPaymentSource, archivePaymentSource,
  listStatementTransactions, addStatementTransaction, removeStatementTransaction, clearStatementTransactions,
  ACCOUNT_TITLES, setTransactionAccountTitle, learnAccountRule, applyAccountRulesToMonth,
  listAllStatementTransactions, computeExpenseCardBackingStatus,
} from '../db.js';
import { yen, escapeHtml, monthLabel } from '../format.js';
import * as localfiles from '../localfiles.js';
import { extractPdfTextRows, detectAndParse } from '../statementparsers.js';
import { fileChipHtml } from '../fileicon.js';
import { parseCurrencyInput, enableCurrencyInput } from '../currencyinput.js';
import { bankBadgeHtml } from '../bankbadge.js';
```
（`import * as gdrive from '../gdrive.js';` を `import * as localfiles from '../localfiles.js';` に置き換え。他は変更なし。）

- [ ] **Step 2: `render()` 冒頭の `gdriveConfigured` 変数を削除する**

`const gdriveConfigured = !!getMeta('gdrive_client_id');`（25行目）の行を削除する。

- [ ] **Step 3: `handleStatementUpload` のDriveアップロード部分を置き換える**

現状:
```js
    if (getMeta('gdrive_client_id')) {
      statusEl.textContent = `${note} 元のPDFを保存中…`;
      try {
        const uploaded = await gdrive.uploadFile(file, { year, month, category: 'receipt', namePrefix: `${source.name}_明細` });
        addAttachment({
          year, month, drive_file_id: uploaded.id, name: file.name, mime_type: uploaded.mimeType,
          web_view_link: uploaded.webViewLink, category: 'statement', source_id: source.id,
        });
      } catch (err) {
        note += `（元のPDFの保存には失敗しました: ${err.message}）`;
      }
    }
```
置き換え後:
```js
    statusEl.textContent = `${note} 元のPDFを保存中…`;
    try {
      const uploaded = await localfiles.uploadFile(file, { namePrefix: `${source.name}_明細` });
      addAttachment({
        year, month, drive_file_id: uploaded.id, name: file.name, mime_type: uploaded.mimeType,
        web_view_link: localfiles.previewUrl(uploaded.id), category: 'statement', source_id: source.id,
      });
    } catch (err) {
      note += `（元のPDFの保存には失敗しました: ${err.message}）`;
    }
```

- [ ] **Step 4: `renderTransactionTable` 内の `gdriveConfigured2`・領収書アップロード・削除を置き換える**

現状の `const gdriveConfigured2 = !!getMeta('gdrive_client_id');` と、それに続く `showReceiptColumn` の行:
```js
    const gdriveConfigured2 = !!getMeta('gdrive_client_id');
    // Drive未連携なら領収書列そのものを出さない（未連携の案内はヘッダの通知で1回だけ伝えている）。
    // ただし過去に上げた領収書が残っている月では、見えなくならないように列を残す。
    const showReceiptColumn = gdriveConfigured2 || txns.some((t) => receiptsFor(t.id).length > 0);
```
置き換え後（ローカル保存は常に使えるので列を隠す必要がなくなる）:
```js
    const showReceiptColumn = true;
```

テンプレート内の `${gdriveConfigured2 ? ... : ''}`（323〜326行目付近）:
```js
                    ${gdriveConfigured2 ? `<label class="btn ghost" style="cursor:pointer;font-size:11px;padding:4px 8px;white-space:nowrap;display:inline-block">
                      ＋領収書
                      <input type="file" class="txn-receipt-input" data-txn-id="${t.id}" style="display:none">
                    </label>` : ''}
```
置き換え後（常に表示）:
```js
                    <label class="btn ghost" style="cursor:pointer;font-size:11px;padding:4px 8px;white-space:nowrap;display:inline-block">
                      ＋領収書
                      <input type="file" class="txn-receipt-input" data-txn-id="${t.id}" style="display:none">
                    </label>
```

領収書アップロードのイベントハンドラ（371〜389行目）:
```js
    slot.querySelectorAll('.txn-receipt-input').forEach((input) => {
      input.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const txnId = Number(input.dataset.txnId);
        const statusEl = slot.querySelector(`.txn-receipt-status[data-txn-id="${txnId}"]`);
        statusEl.textContent = 'アップロード中…';
        try {
          const uploaded = await gdrive.uploadFile(file, { year, month, category: 'receipt', namePrefix: source.name });
          addAttachment({
            year, month, drive_file_id: uploaded.id, name: file.name, mime_type: uploaded.mimeType,
            web_view_link: uploaded.webViewLink, category: 'receipt', statement_transaction_id: txnId,
          });
          renderTransactionTable(source);
        } catch (err) {
          statusEl.textContent = err.message;
        }
      });
    });
```
置き換え後:
```js
    slot.querySelectorAll('.txn-receipt-input').forEach((input) => {
      input.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const txnId = Number(input.dataset.txnId);
        const statusEl = slot.querySelector(`.txn-receipt-status[data-txn-id="${txnId}"]`);
        statusEl.textContent = 'アップロード中…';
        try {
          const uploaded = await localfiles.uploadFile(file, { namePrefix: source.name });
          addAttachment({
            year, month, drive_file_id: uploaded.id, name: file.name, mime_type: uploaded.mimeType,
            web_view_link: localfiles.previewUrl(uploaded.id), category: 'receipt', statement_transaction_id: txnId,
          });
          renderTransactionTable(source);
        } catch (err) {
          statusEl.textContent = err.message;
        }
      });
    });
```

削除ハンドラ（391〜405行目）:
```js
    slot.querySelectorAll('.delete-txn-receipt-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('この領収書を削除します。よろしいですか？（Googleドライブ上のファイルも削除されます）')) return;
        btn.disabled = true;
        try {
          if (gdrive.isConnected()) await gdrive.deleteFile(btn.dataset.driveId);
          removeAttachment(Number(btn.dataset.id));
          renderTransactionTable(source);
        } catch (err) {
          const statusEl = btn.closest('.receipt-cell').querySelector('.txn-receipt-status');
          statusEl.textContent = `削除できませんでした: ${err.message}`;
          btn.disabled = false;
        }
      });
    });
```
置き換え後:
```js
    slot.querySelectorAll('.delete-txn-receipt-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('この領収書を削除します。よろしいですか？')) return;
        btn.disabled = true;
        let fileError = null;
        try { await localfiles.deleteFile(btn.dataset.driveId); } catch (err) { fileError = err; }
        removeAttachment(Number(btn.dataset.id));
        renderTransactionTable(source);
        if (fileError) alert(`Kayley側の記録からは削除しましたが、ファイルの削除に失敗しました: ${fileError.message}`);
      });
    });
```

- [ ] **Step 5: 経費タブ下部「取引に紐づかない領収書」のアップロードUI・ハンドラを置き換える**

`render()` のテンプレート内、`${gdriveConfigured ? ... : ''}`（66〜69行目付近、`＋ 領収書を追加`ボタン）:
```js
          ${gdriveConfigured ? `<label class="btn primary" style="cursor:pointer">
            ＋ 領収書を追加
            <input type="file" id="expense-receipt-input" multiple style="display:none">
          </label>` : ''}
```
置き換え後（常に表示）:
```js
          <label class="btn primary" style="cursor:pointer">
            ＋ 領収書を追加
            <input type="file" id="expense-receipt-input" multiple style="display:none">
          </label>
```

`renderGeneralReceiptList` 内の削除ハンドラ（431〜445行目、Task「請求書・領収書の削除がGoogleドライブ側の失敗で永久に詰む不具合を修正」で直近に直した箇所）:
```js
    listEl.querySelectorAll('.delete-expense-receipt-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('この領収書を削除します。よろしいですか？（Googleドライブ上のファイルも削除されます）')) return;
        btn.disabled = true;
        // Driveの削除が失敗しても、Kayley側の記録は消せないと永久に詰むので分けて処理する。
        let driveError = null;
        if (gdrive.isConnected()) {
          try { await gdrive.deleteFile(btn.dataset.driveId); } catch (err) { driveError = err; }
        }
        removeAttachment(Number(btn.dataset.id));
        renderGeneralReceiptList();
        if (driveError) alert(`Kayley側の記録からは削除しましたが、Googleドライブ上のファイルは削除できませんでした: ${driveError.message}\nDrive側は手動で削除してください。`);
      });
    });
```
置き換え後:
```js
    listEl.querySelectorAll('.delete-expense-receipt-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('この領収書を削除します。よろしいですか？')) return;
        btn.disabled = true;
        let fileError = null;
        try { await localfiles.deleteFile(btn.dataset.driveId); } catch (err) { fileError = err; }
        removeAttachment(Number(btn.dataset.id));
        renderGeneralReceiptList();
        if (fileError) alert(`Kayley側の記録からは削除しましたが、ファイルの削除に失敗しました: ${fileError.message}`);
      });
    });
```

ファイル末尾のアップロードハンドラ（447〜474行目）:
```js
  const fileInput = container.querySelector('#expense-receipt-input');
  if (fileInput) {
    fileInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length === 0) return;
      const statusEl = container.querySelector('#expense-upload-status');
      for (const file of files) {
        statusEl.textContent = `アップロード中… ${file.name}`;
        try {
          const uploaded = await gdrive.uploadFile(file, { year, month, category: 'receipt' });
          addAttachment({
            year, month,
            drive_file_id: uploaded.id,
            name: file.name,
            mime_type: uploaded.mimeType,
            web_view_link: uploaded.webViewLink,
            category: 'receipt',
          });
        } catch (err) {
          statusEl.textContent = `失敗: ${file.name}（${err.message}）`;
          return;
        }
      }
      statusEl.textContent = '';
      fileInput.value = '';
      renderGeneralReceiptList();
    });
  }
}
```
置き換え後:
```js
  const fileInput = container.querySelector('#expense-receipt-input');
  if (fileInput) {
    fileInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length === 0) return;
      const statusEl = container.querySelector('#expense-upload-status');
      for (const file of files) {
        statusEl.textContent = `アップロード中… ${file.name}`;
        try {
          const uploaded = await localfiles.uploadFile(file);
          addAttachment({
            year, month,
            drive_file_id: uploaded.id,
            name: file.name,
            mime_type: uploaded.mimeType,
            web_view_link: localfiles.previewUrl(uploaded.id),
            category: 'receipt',
          });
        } catch (err) {
          statusEl.textContent = `失敗: ${file.name}（${err.message}）`;
          return;
        }
      }
      statusEl.textContent = '';
      fileInput.value = '';
      renderGeneralReceiptList();
    });
  }
}
```

- [ ] **Step 6: `js/views/ar.js` のimportを変更する**

`import * as gdrive from '../gdrive.js';`（15行目）を `import * as localfiles from '../localfiles.js';` に置き換える。

- [ ] **Step 7: `js/views/ar.js` の `gdriveConfigured`・請求書アップロード・削除を置き換える**

`renderTable()` 冒頭の以下の行:
```js
    const gdriveConfigured = !!getMeta('gdrive_client_id');
```
を削除する。

`showInvoiceColumn` の行:
```js
    // Drive未連携なら請求書列そのものを出さない（未連携の案内はヘッダの通知で1回だけ伝えている）。
    // ただし過去に上げた請求書が残っている月では、見えなくならないように列を残す。
    const showInvoiceColumn = gdriveConfigured || monthAttachments.some((a) => a.category === 'invoice');
```
を以下に置き換える:
```js
    const showInvoiceColumn = true;
```

テンプレート内の `${gdriveConfigured ? ... : ''}`（＋請求書ボタン）:
```js
                  ${gdriveConfigured ? `<label class="btn ghost" style="cursor:pointer;font-size:11px;padding:4px 8px;white-space:nowrap;display:inline-block">
                    ＋請求書
                    <input type="file" class="invoice-file-input" data-client="${client.id}" style="display:none">
                  </label>` : ''}
```
置き換え後（常に表示）:
```js
                  <label class="btn ghost" style="cursor:pointer;font-size:11px;padding:4px 8px;white-space:nowrap;display:inline-block">
                    ＋請求書
                    <input type="file" class="invoice-file-input" data-client="${client.id}" style="display:none">
                  </label>
```

アップロードハンドラ（267〜291行目）:
```js
    slot.querySelectorAll('.invoice-file-input').forEach((input) => {
      input.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const clientId = Number(input.dataset.client);
        const client = activeClients.find((c) => c.id === clientId);
        const statusEl = slot.querySelector(`.invoice-status[data-client="${clientId}"]`);
        statusEl.textContent = 'アップロード中…';
        try {
          const uploaded = await gdrive.uploadFile(file, { year, month, category: 'invoice', namePrefix: client.name });
          addAttachment({
            year, month,
            drive_file_id: uploaded.id,
            name: file.name,
            mime_type: uploaded.mimeType,
            web_view_link: uploaded.webViewLink,
            category: 'invoice',
            client_id: clientId,
          });
          renderTable();
        } catch (err) {
          statusEl.textContent = err.message;
        }
      });
    });
```
置き換え後:
```js
    slot.querySelectorAll('.invoice-file-input').forEach((input) => {
      input.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const clientId = Number(input.dataset.client);
        const client = activeClients.find((c) => c.id === clientId);
        const statusEl = slot.querySelector(`.invoice-status[data-client="${clientId}"]`);
        statusEl.textContent = 'アップロード中…';
        try {
          const uploaded = await localfiles.uploadFile(file, { namePrefix: client.name });
          addAttachment({
            year, month,
            drive_file_id: uploaded.id,
            name: file.name,
            mime_type: uploaded.mimeType,
            web_view_link: localfiles.previewUrl(uploaded.id),
            category: 'invoice',
            client_id: clientId,
          });
          renderTable();
        } catch (err) {
          statusEl.textContent = err.message;
        }
      });
    });
```

削除ハンドラ（293〜306行目）:
```js
    slot.querySelectorAll('.delete-invoice-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('この請求書を削除します。よろしいですか？（Googleドライブ上のファイルも削除されます）')) return;
        btn.disabled = true;
        // Driveの削除が失敗しても、Kayley側の記録は消せないと永久に詰むので分けて処理する。
        let driveError = null;
        if (gdrive.isConnected()) {
          try { await gdrive.deleteFile(btn.dataset.driveId); } catch (err) { driveError = err; }
        }
        removeAttachment(Number(btn.dataset.id));
        renderTable();
        if (driveError) alert(`Kayley側の記録からは削除しましたが、Googleドライブ上のファイルは削除できませんでした: ${driveError.message}\nDrive側は手動で削除してください。`);
      });
    });
```
置き換え後:
```js
    slot.querySelectorAll('.delete-invoice-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('この請求書を削除します。よろしいですか？')) return;
        btn.disabled = true;
        let fileError = null;
        try { await localfiles.deleteFile(btn.dataset.driveId); } catch (err) { fileError = err; }
        removeAttachment(Number(btn.dataset.id));
        renderTable();
        if (fileError) alert(`Kayley側の記録からは削除しましたが、ファイルの削除に失敗しました: ${fileError.message}`);
      });
    });
```

- [ ] **Step 8: 構文チェック**

```bash
node --check js/views/expenses.js
node --check js/views/ar.js
```
Expected: 出力無し。`grep -n "gdrive" js/views/expenses.js js/views/ar.js` が0件になっていることも確認する。

- [ ] **Step 9: Playwrightで検証（`window.kayleyBridge`をスタブ、コミットしないスクリプト）**

経費タブ・売掛金タブそれぞれで、①アップロードボタンが常に表示されている（`getMeta('gdrive_client_id')`を設定しなくても出る）、②ファイルをアップロードすると一覧に追加される、③削除すると一覧から消える、をPlaywrightの`page.setInputFiles`で実際のファイル選択を模してテストする。`window.kayleyBridge`のスタブはTask3のStep4と同じ形（`saveAttachment`/`deleteAttachment`をメモリ上のオブジェクトで模す）を使う。

Run: 上記の内容のスクリプトを作成して実行する。
Expected: 3項目とも期待通りであることをJSON出力で確認する。

- [ ] **Step 10: コミット**

```bash
git add js/views/expenses.js js/views/ar.js
git commit -m "経費・売掛金タブの領収書/請求書保存をGoogle Driveからローカル保存に置き換え"
```

---

### Task 5: `js/views/report.js` / `js/views/settings.js` / `js/app.js` の置き換えと `js/gdrive.js` の削除

**Files:**
- Modify: `js/views/report.js`
- Modify: `js/views/settings.js`
- Modify: `js/app.js`
- Delete: `js/gdrive.js`

**Interfaces:**
- Consumes: Task 3の `js/localfiles.js`（`deleteFile`, `downloadFile`）。

- [ ] **Step 1: `js/views/report.js` のimportを変更する**

`import * as gdrive from '../gdrive.js';`（10行目）を `import * as localfiles from '../localfiles.js';` に置き換える。

- [ ] **Step 2: `loadPreviews()` の取得元をローカルに変更する**

現状（`loadPreviews()`内、346行目）:
```js
        const blob = await gdrive.downloadFile(slot.dataset.driveId);
```
置き換え後:
```js
        const blob = await localfiles.downloadFile(slot.dataset.driveId);
```

- [ ] **Step 3: マウント時の自動プレビュー読み込みから `gdrive.isConnected()` のガードを外す**

現状（319〜325行目）:
```js
  renderAttachmentList();

  // 画面を開いた時点で、すでに接続済みならバックグラウンドで先読みしておく
  // （未接続の場合は何もしない＝印刷ボタンを押すまで接続を試みない、という既存の方針を維持）。
  if (gdrive.isConnected() && listAttachments(year, month).length > 0) {
    startLoadingPreviews();
  }
```
置き換え後（ローカル読み込みはコスト・認証が無いため、常に先読みしてよい）:
```js
  renderAttachmentList();

  // ローカル保存になり読み込みコストが無くなったので、証憑があれば常に先読みする。
  if (listAttachments(year, month).length > 0) {
    startLoadingPreviews();
  }
```

- [ ] **Step 4: 削除ハンドラを置き換える**

現状（303〜316行目）:
```js
    listEl.querySelectorAll('.delete-attachment-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('このファイルを削除します。よろしいですか？（Googleドライブ上のファイルも削除されます）')) return;
        btn.disabled = true;
        // Driveの削除が失敗しても、Kayley側の記録は消せないと永久に詰むので分けて処理する。
        let driveError = null;
        if (gdrive.isConnected()) {
          try { await gdrive.deleteFile(btn.dataset.driveId); } catch (err) { driveError = err; }
        }
        removeAttachment(Number(btn.dataset.id));
        renderAttachmentList();
        if (driveError) alert(`Kayley側の記録からは削除しましたが、Googleドライブ上のファイルは削除できませんでした: ${driveError.message}\nDrive側は手動で削除してください。`);
      });
    });
```
置き換え後:
```js
    listEl.querySelectorAll('.delete-attachment-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('このファイルを削除します。よろしいですか？')) return;
        btn.disabled = true;
        let fileError = null;
        try { await localfiles.deleteFile(btn.dataset.driveId); } catch (err) { fileError = err; }
        removeAttachment(Number(btn.dataset.id));
        renderAttachmentList();
        if (fileError) alert(`Kayley側の記録からは削除しましたが、ファイルの削除に失敗しました: ${fileError.message}`);
      });
    });
```

- [ ] **Step 5: 証憑カードの案内文を更新する**

現状（223〜226行目）:
```js
      <div class="card-note no-print">
        請求書は売掛金タブの各得意先から、領収書は「経費」タブからアップロードできます。
        「読み込んで表示」を押すと、Googleドライブから中身を取得してこのレポートに埋め込みます（PDF出力にもそのまま含まれます）。
      </div>
```
置き換え後:
```js
      <div class="card-note no-print">
        請求書は売掛金タブの各得意先から、領収書は「経費」タブからアップロードできます。
        画面を開くと自動で中身を読み込んでこのレポートに埋め込みます（PDF出力にもそのまま含まれます）。
      </div>
```

- [ ] **Step 6: `js/views/settings.js` から Google Drive セクションを削除する**

importを以下に変更する（`import * as gdrive from '../gdrive.js';` の行を削除するだけ、他は変更なし）:
```js
import {
  getMeta, setMeta, exportBytes, importBytes,
  listThemePresets, addThemePreset, removeThemePreset,
} from '../db.js';
import { Storage } from '../storage.js';
import { escapeHtml } from '../format.js';
import { applyTheme, fileToResizedDataUrl, contrastRatio, deriveInkVariants } from '../theme.js';
```

`render()` 冒頭の以下の行を削除する:
```js
  const gdriveClientId = getMeta('gdrive_client_id') || '';
  const gdriveConnected = gdrive.isConnected();
  const showClientIdField = showClientIdOverride || !gdriveClientId;
  const gdriveAutoBackup = getMeta('gdrive_auto_backup') === '1';
  const gdriveLastBackupAt = getMeta('gdrive_last_backup_at') || '';
```
（`showClientIdOverride` を使うのはこのブロックだけなので、ファイル冒頭の `let showClientIdOverride = false;` も削除してよい。）

テンプレート内の「バックアップ」カードの直後にある「Google Drive連携（証憑の保存）」カード全体（96〜137行目、下記の`<div class="card">`から対応する`</div>`まで）を削除する。削除対象の正確な原文は以下の通り:
```js
    <div class="card">
      <div class="card-header">
        <h2>Google Drive連携（証憑の保存）</h2>
      </div>
      <div class="card-note">
        領収書・請求書などのファイルを、あなた自身のGoogleドライブ内の専用フォルダ（「Kayley」）に保存できるようにします。
        このアプリにサーバーは無く、ブラウザから直接Googleへ送信します。使用する権限は <strong>drive.file</strong>（このアプリが作成したファイルにしか触れない、最も限定的な権限）のみで、ドライブ内の他のファイルは一切見えません。
      </div>
      ${showClientIdField ? `
        <div class="field-row">
          <div class="field-label">OAuthクライアントID<span class="hint">Google Cloud ConsoleでOAuthクライアント（種類: ウェブアプリケーション）を作成し、承認済みのJavaScript生成元にこのアプリのURLを登録してから、クライアントIDを貼り付けてください</span></div>
          <div class="field-value"><input type="text" id="gdrive_client_id" placeholder="xxxxxxxxxx.apps.googleusercontent.com" value="${escapeHtml(gdriveClientId)}"></div>
        </div>
      ` : `
        <div class="field-row">
          <div class="field-label">OAuthクライアントID</div>
          <div class="field-value">
            <span class="card-note" style="margin:0">設定済み</span>
            <button class="btn ghost" id="gdrive-edit-client-id-btn">変更する</button>
          </div>
        </div>
      `}
      <div class="toolbar">
        <span class="badge ${gdriveConnected ? 'good' : 'warning'}">${gdriveConnected ? '接続済み' : (gdriveClientId ? '未接続（アップロード時に自動で繋ぎ直します）' : '未接続')}</span>
        <button class="btn primary" id="gdrive-connect-btn">接続する</button>
        <button class="btn ghost" id="gdrive-disconnect-btn" ${gdriveConnected ? '' : 'disabled'}>切断する</button>
      </div>
      <div id="gdrive-status-note" class="card-note"></div>

      <div class="card-note" style="margin-top:18px;padding-top:16px;border-top:1px solid var(--hairline)">
        DBファイルのバックアップ（Kayley / バックアップ フォルダに保存）
      </div>
      <div class="field-row">
        <div class="field-label">自動バックアップ<span class="hint">接続済みの状態でアプリを使うたびに確認し、前回から12時間以上経っていたら自動で保存します</span></div>
        <div class="field-value"><input type="checkbox" id="gdrive_auto_backup" style="width:auto" ${gdriveAutoBackup ? 'checked' : ''}></div>
      </div>
      <div class="toolbar">
        <span class="card-note" style="margin:0">${gdriveLastBackupAt ? `最終バックアップ: ${new Date(gdriveLastBackupAt).toLocaleString('ja-JP')}` : 'まだバックアップされていません'}</span>
        <span class="spacer"></span>
        <button class="btn ghost" id="gdrive-backup-now-btn">今すぐバックアップ</button>
      </div>
    </div>
```
（この`<div class="card">`〜`</div>`のブロックを丸ごと削除し、「バックアップ」カードの次は`<details class="card settings-fold">`（外観設定）に直接続くようにする。）

`export-btn`/`import-file`のイベントハンドラの直後にある、Google Drive関連のイベントハンドラ（268〜322行目）を丸ごと削除する。削除対象の正確な原文は以下の通り:
```js
  const clientIdInput = container.querySelector('#gdrive_client_id');
  if (clientIdInput) {
    clientIdInput.addEventListener('change', (e) => {
      setMeta('gdrive_client_id', e.target.value.trim());
    });
  }

  const editClientIdBtn = container.querySelector('#gdrive-edit-client-id-btn');
  if (editClientIdBtn) {
    editClientIdBtn.addEventListener('click', () => {
      showClientIdOverride = true;
      render(container);
    });
  }

  const statusNote = container.querySelector('#gdrive-status-note');
  container.querySelector('#gdrive-connect-btn').addEventListener('click', async () => {
    const clientId = (clientIdInput ? clientIdInput.value.trim() : getMeta('gdrive_client_id') || '');
    if (!clientId) {
      statusNote.textContent = 'まずOAuthクライアントIDを入力してください。';
      return;
    }
    setMeta('gdrive_client_id', clientId);
    statusNote.textContent = 'Googleの認証画面を確認してください…';
    try {
      await gdrive.connect(clientId);
      showClientIdOverride = false;
      render(container);
      gdrive.maybeAutoBackup(exportBytes);
    } catch (err) {
      statusNote.textContent = `接続に失敗しました: ${err.message}`;
    }
  });

  container.querySelector('#gdrive-disconnect-btn').addEventListener('click', () => {
    gdrive.disconnect();
    render(container);
  });

  container.querySelector('#gdrive_auto_backup').addEventListener('change', (e) => {
    setMeta('gdrive_auto_backup', e.target.checked ? '1' : '0');
  });

  container.querySelector('#gdrive-backup-now-btn').addEventListener('click', async () => {
    const btn = container.querySelector('#gdrive-backup-now-btn');
    btn.disabled = true;
    statusNote.textContent = 'バックアップ中…';
    try {
      await gdrive.backupDatabase(exportBytes());
      render(container);
    } catch (err) {
      statusNote.textContent = `バックアップに失敗しました: ${err.message}`;
      btn.disabled = false;
    }
  });
```
（このブロックを削除する。直前の `#import-file` の `change` ハンドラの `});` の直後から、直後の `function updateContrastDisplay() {` の直前までが対象。）

- [ ] **Step 7: `js/app.js` から Google Drive 関連を削除する**

importから `import * as gdrive from './gdrive.js';`（6行目）を削除する。

`renderNotices()` 内の以下のブロック（122〜129行目）を削除する:
```js
  if (!getMeta('gdrive_client_id') && state.tab !== 'settings') {
    notices.push(`
      <div class="notice-row info">
        <span class="notice-dot"></span>
        <span class="notice-text">Google Drive未連携のため、請求書・領収書を保存できません</span>
        <a class="notice-action" href="#/settings">設定を開く</a>
      </div>
    `);
  }
```

`main()` 内の以下の行（197〜199行目、コメント含む）を削除する:
```js
  // すでにGoogle Driveに接続済み（同じタブ内で維持されているセッション）で、自動バックアップが
  // オンなら、前回から12時間以上経っていた場合だけ静かにバックアップする。新規にログイン画面は開かない。
  gdrive.maybeAutoBackup(exportBytes);
```
`exportBytes`は`js/app.js`ではこの`maybeAutoBackup`呼び出し以外に使われていないので、importからも外す。`js/app.js`冒頭のimportを以下のように変更する:
```js
import {
  openDatabase, getMeta, getFoundingDate, getSectionCompletion, isMonthAllowed, onDataChange,
} from './db.js';
```

- [ ] **Step 8: `js/gdrive.js` を削除する**

```bash
git rm js/gdrive.js
```

- [ ] **Step 9: 構文チェックと参照の残存確認**

```bash
node --check js/views/report.js
node --check js/views/settings.js
node --check js/app.js
grep -rn "gdrive" js/ --include="*.js" || echo "no remaining references"
```
Expected: 構文エラー無し。`grep`は`js/localfiles.js`のコメントや変数名に`gdrive`という文字列が入っていなければ`no remaining references`。

- [ ] **Step 10: Playwrightで検証（`window.kayleyBridge`をスタブ、コミットしないスクリプト）**

①設定タブに「Google Drive連携」カードが存在しないこと、②レポートタブで、証憑がある月を開くと自動でプレビューが読み込まれる（ボタンを押さなくても`.attachment-preview`に内容が入る）こと、③レポートタブでの添付ファイル削除が一覧から消えること、をテストする。

Run: 上記内容のスクリプトを作成して実行する。
Expected: 3項目ともJSON出力で期待通りであることを確認する。

- [ ] **Step 11: コミット**

```bash
git add js/views/report.js js/views/settings.js js/app.js
git commit -m "Google Drive連携を廃止し、証憑プレビューと設定画面をローカル保存に一本化"
```

---

## 完了後の作業（コード不要、私からユーザーへ案内する）

実装完了後、以下の手順をユーザーに案内する（新しいコードは不要。既存の「バックアップをダウンロード」「バックアップから復元」機能をそのまま使う）:

1. 現在のバージョンのKayleyで、設定タブ →「バックアップ」カード →「.sqliteをエクスポート」を押し、`.sqlite`ファイルを保存する。
2. このプランを適用した新しいバージョンのKayleyを起動する（初回は空のDBで立ち上がる）。
3. 新しいバージョンの設定タブ →「バックアップ」カード →「.sqliteをインポート」で①のファイルを選択する。

添付ファイル（過去にGoogle Driveへ保存した領収書・請求書）は、この移行では引き継がれない（Drive上には残り続けるが、Kayleyからはリンクが切れる）。必要なものはGoogle Drive側から個別にダウンロードしておくよう案内する。
